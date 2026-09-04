import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {createArtifactEnvelope, validateArtifactEnvelope, writeImmutableArtifact} from "./artifacts.mjs";
import {sha256Value} from "./checksum.mjs";
import {assertCoordinator, readManifest} from "./manifest.mjs";
import {getWorkItem, readWorkflowState, transitionWorkItem} from "./workflow.mjs";

const IMMEDIATE_BLOCK_REASONS = new Set([
  "missing-authority", "asset-rights", "privacy", "brand-conflict",
  "missing-required-capability", "source-destructive-operation",
]);
const RETURN_STATE = Object.freeze({
  "local-media-technician": {"voice-over": "AUDIO_READY", "raw-video": "TRANSCRIPTS_READY", "multi-clip": "TRANSCRIPTS_READY"},
  "story-editor": "STORY_PLANNED",
  "subject-analyst": "DESIGN_PLANNED",
  "asset-resolver": "DESIGN_PLANNED",
  "design-director": "DESIGN_PLANNED",
  "premiere-executor": "EXECUTING",
  "hyperframes-executor": "EXECUTING",
  "carousel-lead": "EXECUTING",
  "carousel-slide-executor": "EXECUTING",
});
const TERMINAL_STATES = new Set(["SUPERSEDED", "REJECTED", "DELIVERED"]);

function assertText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

function assertFailure(failure, {history = false} = {}) {
  if (!failure || typeof failure !== "object" || Array.isArray(failure)) throw new Error(`Invalid ${history ? "history entry" : "current failure"}`);
  assertText(failure.signature, "Finding signature");
  if (failure.kind !== undefined) assertText(failure.kind, "Failure kind");
  if (failure.score !== undefined && (!Number.isFinite(failure.score))) throw new Error("Failure score must be finite");
  if (failure.artifactHash !== undefined) assertText(failure.artifactHash, "Artifact hash");
  if (failure.candidateRevision !== undefined) assertPositiveInteger(failure.candidateRevision, "Candidate revision");
  if (history) return;
  assertText(failure.ownerStage, "Owner stage");
  assertPositiveInteger(failure.candidateRevision, "Candidate revision");
  if (failure.immediateBlockReason !== undefined && !IMMEDIATE_BLOCK_REASONS.has(failure.immediateBlockReason)) {
    throw new Error("Invalid immediate block reason");
  }
  returnStateFor(failure.ownerStage, failure.modality);
}

function returnStateFor(ownerStage, modality) {
  if (ownerStage === "script-editorial") {
    if (modality === "voice-over") return "SCRIPT_DRAFT";
    if (modality === "carousel") return "COPY_DRAFT";
    throw new Error("script-editorial requires a voice-over or carousel modality");
  }
  const returnState = RETURN_STATE[ownerStage];
  if (!returnState) throw new Error("Invalid owner stage");
  if (typeof returnState === "object") {
    if (!returnState[modality]) throw new Error("local-media-technician requires a supported modality");
    return returnState[modality];
  }
  return returnState;
}

function decision(currentFailure, action, reason, returnTo, consumeRevision) {
  return {
    action,
    ownerStage: currentFailure.ownerStage,
    candidateRevision: currentFailure.candidateRevision,
    reason,
    findingSignatures: [currentFailure.signature],
    returnTo,
    consumeRevision,
    ...(currentFailure.score === undefined ? {} : {score: currentFailure.score}),
    ...(currentFailure.artifactHash === undefined ? {} : {artifactHash: currentFailure.artifactHash}),
  };
}

export function decideRetry(history, currentFailure) {
  if (!Array.isArray(history)) throw new Error("Retry history must be an array");
  history.forEach((failure) => assertFailure(failure, {history: true}));
  assertFailure(currentFailure);

  const identicalCrashCount = history.filter(({kind, signature}) => kind === "tool-crash" && signature === currentFailure.signature).length;
  const sameSignatureCount = history.filter(({signature}) => signature === currentFailure.signature).length;
  const previousScore = history.findLast(({score}) => score !== undefined)?.score;
  const previousArtifactHash = history.findLast(({artifactHash}) => artifactHash !== undefined)?.artifactHash;
  const scoreDidNotImprove = currentFailure.score !== undefined && previousScore !== undefined && currentFailure.score <= previousScore;
  const artifactHashUnchanged = currentFailure.artifactHash !== undefined && currentFailure.artifactHash === previousArtifactHash;

  if (currentFailure.immediateBlockReason) return decision(currentFailure, "ESCALATE_HUMAN", currentFailure.immediateBlockReason, "BLOCKED", false);
  if (currentFailure.candidateRevision >= 3) return decision(currentFailure, "ESCALATE_HUMAN", "maximum three candidate revisions reached", "BLOCKED", false);
  if (currentFailure.kind === "tool-crash" && identicalCrashCount === 0) return decision(currentFailure, "RETRY_IDENTICAL", "first identical retry for objective tool crash", "EXECUTING", false);
  if (sameSignatureCount >= 1) return decision(currentFailure, "REPLAN_DESIGN", "repeated finding signature", "DESIGN_PLANNED", true);
  if (scoreDidNotImprove) return decision(currentFailure, "REPLAN_DESIGN", "non-improving score", "DESIGN_PLANNED", true);
  if (artifactHashUnchanged) return decision(currentFailure, "REPLAN_DESIGN", "unchanged artifact hash", "DESIGN_PLANNED", true);
  return decision(currentFailure, "REVISE_STAGE", "stage revision required", returnStateFor(currentFailure.ownerStage, currentFailure.modality), true);
}

function assertDecision(decision, item) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) throw new Error("Invalid retry decision");
  if (!["RETRY_IDENTICAL", "REVISE_STAGE", "REPLAN_DESIGN", "ESCALATE_HUMAN"].includes(decision.action)) throw new Error("Invalid retry decision action");
  assertText(decision.ownerStage, "Decision owner stage");
  assertPositiveInteger(decision.candidateRevision, "Decision candidate revision");
  assertText(decision.reason, "Decision reason");
  if (!Array.isArray(decision.findingSignatures) || decision.findingSignatures.length === 0) throw new Error("Decision finding signatures are required");
  decision.findingSignatures.forEach((signature) => assertText(signature, "Decision finding signature"));
  if (typeof decision.consumeRevision !== "boolean") throw new Error("Decision revision consumption must be boolean");
  if (decision.score !== undefined && !Number.isFinite(decision.score)) throw new Error("Decision score must be finite");
  if (decision.artifactHash !== undefined) assertText(decision.artifactHash, "Decision artifact hash");
  if (decision.candidateRevision !== item.revision) throw new Error("Retry decision candidate revision is stale");

  const ownerReturn = returnStateFor(decision.ownerStage, item.modality);
  if (decision.action === "RETRY_IDENTICAL") {
    if (decision.returnTo !== "EXECUTING" || ownerReturn !== "EXECUTING" || decision.consumeRevision) throw new Error("Invalid identical retry decision");
    return;
  }
  if (decision.action === "REVISE_STAGE") {
    if (decision.returnTo !== ownerReturn || !decision.consumeRevision) throw new Error("Invalid stage revision decision");
    return;
  }
  if (decision.action === "REPLAN_DESIGN") {
    if (decision.returnTo !== "DESIGN_PLANNED" || !decision.consumeRevision) throw new Error("Invalid design replan decision");
    return;
  }
  if (decision.returnTo !== "BLOCKED" || decision.consumeRevision) throw new Error("Invalid human escalation decision");
}

function assertDecisionState(retryDecision, item) {
  if (retryDecision.action === "RETRY_IDENTICAL" && item.state !== "EXECUTING") {
    throw new Error("Identical retries require an executing work item state");
  }
  if (TERMINAL_STATES.has(item.state)) throw new Error(`Retry decision cannot apply from terminal state ${item.state}`);
  if (retryDecision.action !== "RETRY_IDENTICAL" && item.state === "BLOCKED") {
    throw new Error("Retry decision cannot apply from blocked state");
  }
  if (["REVISE_STAGE", "REPLAN_DESIGN"].includes(retryDecision.action) && item.state === "REVISION_REQUIRED") {
    throw new Error("Retry decision cannot revise a work item already requiring revision");
  }
}

function decisionPayload(retryDecision) {
  return {
    action: retryDecision.action,
    ownerStage: retryDecision.ownerStage,
    candidateRevision: retryDecision.candidateRevision,
    returnTo: retryDecision.returnTo,
    consumeRevision: retryDecision.consumeRevision,
    reason: retryDecision.reason,
    findingSignatures: retryDecision.findingSignatures,
    ...(retryDecision.score === undefined ? {} : {score: retryDecision.score}),
    ...(retryDecision.artifactHash === undefined ? {} : {artifactHash: retryDecision.artifactHash}),
  };
}

async function writeRetryDecisionArtifact(projectDir, coordinatorContext, workItem, retryDecision) {
  const payload = decisionPayload(retryDecision);
  const identity = {...payload, workItemId: workItem.id, modality: workItem.modality};
  const artifactId = `retry-decision-${sha256Value(identity)}`;
  const suffix = String(retryDecision.candidateRevision).padStart(3, "0");
  const artifact = createArtifactEnvelope({
    artifactId,
    revision: retryDecision.candidateRevision,
    workItemId: workItem.id,
    modality: workItem.modality,
    parents: [],
    producer: {actorId: coordinatorContext.actorId, role: "coordinator"},
    versions: {tool: "content-hub@0.1.0", template: null, model: null, policy: "bizibeast-v1"},
    status: retryDecision.action === "RETRY_IDENTICAL" ? "recorded" : "proposed",
    deviations: [],
    payload,
  });
  const stored = await writeImmutableArtifact(projectDir, `Plans/${artifactId}-v${suffix}.json`, artifact);
  const recorded = validateArtifactEnvelope(JSON.parse(await readFile(join(projectDir, stored.path), "utf8")));
  if (recorded.artifactId !== artifactId || sha256Value(recorded.payload) !== sha256Value(payload)) {
    throw new Error("Retry decision artifact could not be verified");
  }
  return {id: artifactId, sha256: stored.sha256};
}

export async function applyRetryDecision(projectDir, coordinatorContext, workItemId, retryDecision) {
  assertCoordinator(await readManifest(projectDir), coordinatorContext);
  const state = await readWorkflowState(projectDir);
  const item = getWorkItem(state, workItemId);
  assertDecision(retryDecision, item);
  assertDecisionState(retryDecision, item);
  const artifactRef = await writeRetryDecisionArtifact(projectDir, coordinatorContext, item, retryDecision);
  if (retryDecision.action === "RETRY_IDENTICAL") {
    return state;
  }
  return transitionWorkItem(projectDir, coordinatorContext, {
    workItemId,
    to: retryDecision.action === "ESCALATE_HUMAN" ? "BLOCKED" : "REVISION_REQUIRED",
    reason: retryDecision.reason,
    artifactRef,
    ...(retryDecision.action === "ESCALATE_HUMAN" ? {} : {returnTo: retryDecision.returnTo}),
  });
}
