import {createHash, randomUUID} from "node:crypto";
import {realpath} from "node:fs/promises";
import {join} from "node:path";

import {findCurrentApproval, readApprovals, recordApproval} from "./approvals.mjs";
import {createArtifactEnvelope, validateArtifactEnvelope} from "./artifacts.mjs";
import {sha256Value} from "./checksum.mjs";
import {
  hashFileNoFollow,
  makeDirectories,
  makeExclusiveDirectory,
  readFileNoFollow,
  removeOwnedStage,
  renameExclusive,
  writeExclusiveFile,
} from "./release-fs.mjs";
import {getWorkItem, readWorkflowState} from "./workflow.mjs";

const POLICY_VERSION = "bizibeast-v1";
const SCRIPT_ID = /^script:([A-Za-z0-9][A-Za-z0-9._-]*):v(\d{3}):([a-f0-9]{64})$/u;
const SAFE_WORK_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const APPROVED_STATES = new Set([
  "SCRIPT_APPROVED", "AUDIO_READY", "TRANSCRIPT_READY", "STORY_PLANNED", "DESIGN_PLANNED",
  "DESIGN_APPROVED", "EXECUTING", "CANDIDATE_FROZEN", "TECH_PASSED", "CREATIVE_PASSED",
  "APPROVED", "RELEASED", "DELIVERED",
]);

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function identity(artifact) {
  const {artifactId, ...withoutId} = artifact;
  return sha256Value(withoutId);
}

function revisionSuffix(value) {
  if (!Number.isInteger(value) || value < 1 || value > 999) throw new Error("Script revision must be an integer from 1 to 999");
  return String(value).padStart(3, "0");
}

function assertHash(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 hash`);
}

function assertWorkItemId(value) {
  if (typeof value !== "string" || !SAFE_WORK_ITEM_ID.test(value)) throw new Error("Work item id must use letters, numbers, dot, underscore, or hyphen");
}

function assertScriptProducer(producer) {
  if (producer?.role !== "script-editorial") throw new Error("Script producer must have role script-editorial");
  if (typeof producer.actorId !== "string" || !producer.actorId.trim()) throw new Error("Script producer actor id is required");
}

function scriptPaths(projectDir, artifactId) {
  const match = SCRIPT_ID.exec(artifactId);
  if (!match) throw new Error("Script artifact id must be script:<work-item-id>:vNNN:<identity-hash>");
  const workItemId = match[1];
  const revision = Number(match[2]);
  const directory = `Plans/Scripts/${workItemId}/v${match[2]}`;
  return {
    artifactId, workItemId, revision, identityHash: match[3], directory,
    relativeScriptPath: `${directory}/script.md`, relativeArtifactPath: `${directory}/artifact.json`,
    absoluteScriptPath: join(projectDir, directory, "script.md"), absoluteArtifactPath: join(projectDir, directory, "artifact.json"),
  };
}

function assertScriptArtifact(artifact, workItemId) {
  validateArtifactEnvelope(artifact);
  if (artifact.workItemId !== workItemId) throw new Error("Script artifact work item does not match");
  const paths = scriptPaths(".", artifact.artifactId);
  if (artifact.revision !== paths.revision) throw new Error("Script artifact revision does not match its id");
  if (artifact.modality !== "voice-over") throw new Error("Script artifact modality must be voice-over");
  assertScriptProducer(artifact.producer);
  if (artifact.payload?.kind !== "script" || artifact.payload.path !== paths.relativeScriptPath) throw new Error("Script artifact payload path does not match its id");
  assertHash(artifact.payload.scriptSha256, "Script SHA-256");
  if (identity(artifact) !== paths.identityHash) throw new Error("Script artifact identity hash mismatch");
  return paths;
}

async function readStoredScriptArtifact(projectDir, artifactId) {
  const root = await realpath(projectDir);
  const paths = scriptPaths(root, artifactId);
  const stored = await readFileNoFollow(root, paths.relativeArtifactPath);
  let artifact;
  try {
    artifact = JSON.parse(stored.bytes.toString("utf8"));
  } catch {
    throw new Error("Script artifact envelope is malformed");
  }
  validateArtifactEnvelope(artifact);
  if (artifact.artifactId !== artifactId) throw new Error("Script artifact id does not match its path");
  return {root, artifact, paths};
}

async function currentWorkItem(projectDir, workItemId) {
  const state = await readWorkflowState(projectDir);
  const item = getWorkItem(state, workItemId);
  if (item.modality !== "voice-over") throw new Error("Script revisions require a voice-over work item");
  return item;
}

export async function writeScriptRevision(projectDir, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Script input is required");
  assertWorkItemId(input.workItemId);
  if (typeof input.text !== "string" || !input.text.trim()) throw new Error("Script text is required");
  const item = await currentWorkItem(projectDir, input.workItemId);
  if (item.state !== "SCRIPT_DRAFT") throw new Error("Script draft requires SCRIPT_DRAFT workflow state");
  if (input.revision !== item.revision) throw new Error("Script revision must match the current work item revision");
  const suffix = revisionSuffix(input.revision);
  assertScriptProducer(input.producer);
  const root = await realpath(projectDir);
  const relativeDirectory = `Plans/Scripts/${input.workItemId}`;
  const relativeFinalDirectory = `${relativeDirectory}/v${suffix}`;
  const relativeScriptPath = `${relativeFinalDirectory}/script.md`;
  const bytes = Buffer.from(input.text, "utf8");
  if (bytes.toString("utf8") !== input.text) throw new Error("Script text must be representable as UTF-8");
  const scriptSha256 = digest(bytes);
  const unsigned = createArtifactEnvelope({
    artifactId: "script-pending", revision: input.revision, workItemId: input.workItemId, modality: "voice-over",
    parents: [], producer: input.producer,
    versions: {tool: "content-hub@0.2.0", template: null, model: null, policy: POLICY_VERSION},
    createdAt: input.createdAt ?? new Date().toISOString(), status: "frozen", deviations: [],
    payload: {kind: "script", path: relativeScriptPath, scriptSha256},
  });
  const artifactId = `script:${input.workItemId}:v${suffix}:${identity(unsigned)}`;
  const artifact = createArtifactEnvelope({...unsigned, artifactId});
  const artifactBytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  await makeDirectories(root, relativeDirectory);
  const stagingPath = `${relativeDirectory}/.v${suffix}-${randomUUID()}`;
  let stageOwner;
  let artifactSha256;
  try {
    stageOwner = await makeExclusiveDirectory(root, stagingPath);
    await writeExclusiveFile(root, `${stagingPath}/script.md`, bytes);
    await writeExclusiveFile(root, `${stagingPath}/artifact.json`, artifactBytes);
    artifactSha256 = (await hashFileNoFollow(root, `${stagingPath}/artifact.json`)).sha256;
    await renameExclusive(root, stagingPath, relativeFinalDirectory, stageOwner);
  } catch (error) {
    if (stageOwner) await removeOwnedStage(root, stagingPath, stageOwner);
    throw error;
  }
  return {artifact, artifactRef: {artifactId, sha256: artifactSha256}, path: join(root, relativeScriptPath), scriptSha256};
}

export async function approveScriptRevision(projectDir, coordinatorContext, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Script approval input is required");
  assertWorkItemId(input.workItemId);
  if (!input.artifact || typeof input.artifact.artifactId !== "string") throw new Error("Script artifact is required");
  const stored = await readStoredScriptArtifact(projectDir, input.artifact.artifactId);
  const paths = assertScriptArtifact(stored.artifact, input.workItemId);
  const item = await currentWorkItem(stored.root, input.workItemId);
  if (item.state !== "AWAITING_SCRIPT_APPROVAL") throw new Error("Script approval requires AWAITING_SCRIPT_APPROVAL workflow state");
  if (stored.artifact.revision !== item.revision) throw new Error("Script revision must match the current work item revision");
  assertHash(input.expectedSha256, "Expected script SHA-256");
  if (input.expectedSha256 !== stored.artifact.payload.scriptSha256) throw new Error("Script bytes do not match hash shown for approval");
  const script = await readFileNoFollow(stored.root, paths.relativeScriptPath);
  if (digest(script.bytes) !== input.expectedSha256) throw new Error("Script bytes do not match hash shown for approval");
  return recordApproval(stored.root, coordinatorContext, {
    kind: "script", workItemId: input.workItemId,
    subject: {artifactId: stored.artifact.artifactId, sha256: input.expectedSha256}, decision: "approved",
    approver: input.approver, origin: "user", policyVersion: POLICY_VERSION,
  });
}

export async function requireApprovedScript(projectDir, query) {
  if (!query || typeof query !== "object" || Array.isArray(query)) throw new Error("Script verification query is required");
  assertWorkItemId(query.workItemId);
  if (typeof query.scriptArtifactId !== "string" || !query.scriptArtifactId.trim()) throw new Error("Script artifact id is required");
  assertHash(query.scriptSha256, "Script SHA-256");
  const stored = await readStoredScriptArtifact(projectDir, query.scriptArtifactId);
  const paths = assertScriptArtifact(stored.artifact, query.workItemId);
  const item = await currentWorkItem(stored.root, query.workItemId);
  if (!APPROVED_STATES.has(item.state)) throw new Error("Script verification requires SCRIPT_APPROVED or a later valid voice-over state");
  if (stored.artifact.revision !== item.revision) throw new Error("Script revision must match the current work item revision");
  const approvals = await readApprovals(stored.root);
  const approval = findCurrentApproval(approvals, {
    kind: "script", workItemId: query.workItemId, artifactId: query.scriptArtifactId,
    sha256: query.scriptSha256, policyVersion: POLICY_VERSION,
  });
  if (!approval) throw new Error("Narration requires exact approved script hash");
  if (stored.artifact.payload.scriptSha256 !== query.scriptSha256) throw new Error("Approved script artifact is not current");
  const script = await readFileNoFollow(stored.root, paths.relativeScriptPath);
  if (digest(script.bytes) !== query.scriptSha256) throw new Error("Approved script bytes changed on disk");
  return {artifact: stored.artifact, approval, absolutePath: join(stored.root, paths.relativeScriptPath)};
}

export async function loadScriptArtifact(projectDir, artifactId) {
  return (await readStoredScriptArtifact(projectDir, artifactId)).artifact;
}
