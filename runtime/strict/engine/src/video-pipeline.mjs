import {createHash} from "node:crypto";

import {createArtifactEnvelope, validateArtifactEnvelope, writeImmutableArtifact} from "./artifacts.mjs";
import {writeArtifactCaptionBundle} from "./captions.mjs";
import {buildArtifactForegroundSidecar} from "./foreground-sidecar.mjs";
import {readFileNoFollow, hashFileNoFollow} from "./release-fs.mjs";
import {runSubjectAnalysis} from "./subject-map.mjs";
import {resolveVideoAssets} from "./video-assets.mjs";
import {approveVideoDesignPlan, createVideoDesignPlan} from "./video-design-plan.mjs";
import {
  createVideoExecutionContract,
  executeHyperFramesJobs,
  executePremiereAssembly,
  freezeVideoCandidate,
} from "./video-execution.mjs";
import {createMediaIndex} from "./video-media-index.mjs";
import {generateApprovedNarration} from "./video-narration.mjs";
import {createStoryPlan} from "./video-story.mjs";
import {transcribeIndexedSources} from "./video-transcripts.mjs";
import {getWorkItem, readWorkflowState, transitionWorkItem, transitionWorkItemSequence} from "./workflow.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const pad = (value) => String(value).padStart(3, "0");
const modalities = (...values) => Object.freeze(values);

export const VIDEO_STAGE_MATRIX = Object.freeze({
  "generate-narration": Object.freeze({role: "local-media-technician", modalities: modalities("voice-over"), from: "SCRIPT_APPROVED", to: "TRANSCRIPT_READY"}),
  "index-media": Object.freeze({role: "local-media-technician", modalities: modalities("raw-video", "multi-clip"), from: "READY", to: "MEDIA_INDEXED"}),
  "transcribe-sources": Object.freeze({role: "local-media-technician", modalities: modalities("raw-video", "multi-clip"), from: "MEDIA_INDEXED", to: "TRANSCRIPTS_READY"}),
  "plan-story": Object.freeze({role: "story-editor", modalities: modalities("raw-video", "multi-clip"), from: "TRANSCRIPTS_READY", to: "STORY_PLANNED"}),
  "analyze-subject": Object.freeze({role: "subject-analyst", modalities: modalities("raw-video", "multi-clip"), from: "STORY_PLANNED", to: null}),
  "resolve-assets": Object.freeze({role: "asset-resolver", modalities: modalities("raw-video", "multi-clip"), from: "STORY_PLANNED", to: null, coordinator: true}),
  "build-captions": Object.freeze({role: "hyperframes-executor", producerRole: "caption-executor", modalities: modalities("raw-video", "multi-clip"), from: "STORY_PLANNED", to: null}),
  "build-foreground": Object.freeze({role: "hyperframes-executor", producerRole: "foreground-sidecar-executor", modalities: modalities("raw-video", "multi-clip"), from: "STORY_PLANNED", to: null}),
  "plan-design": Object.freeze({role: "design-director", modalities: modalities("raw-video", "multi-clip"), from: "STORY_PLANNED", to: "DESIGN_PLANNED"}),
  "approve-design": Object.freeze({role: "design-approver", modalities: modalities("raw-video", "multi-clip"), from: "DESIGN_PLANNED", to: "DESIGN_APPROVED"}),
  "plan-execution": Object.freeze({role: "premiere-executor", modalities: modalities("raw-video", "multi-clip"), from: "DESIGN_APPROVED", to: "EXECUTING"}),
  "execute-hyperframes": Object.freeze({role: "hyperframes-executor", modalities: modalities("raw-video", "multi-clip"), from: "EXECUTING", to: null}),
  "execute-premiere": Object.freeze({role: "premiere-executor", modalities: modalities("raw-video", "multi-clip"), from: "EXECUTING", to: null}),
  "freeze-candidate": Object.freeze({role: "coordinator", modalities: modalities("raw-video", "multi-clip"), from: "EXECUTING", to: "CANDIDATE_FROZEN"}),
});

const AUTHORITY_KEYS = new Set([
  "adapter", "adapters", "approver", "approveractorid", "approverrole", "coordinator", "coordinatorcontext", "coordinatorid",
  "executor", "executoractorid", "executorrole", "premiereadapter", "premiereexecutor", "producer", "produceractorid", "producerrole",
  "reviewer", "revieweractorid", "reviewerrole",
]);

function assertNoAuthority(value, path = "input") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (AUTHORITY_KEYS.has(key.toLowerCase())) throw new Error(`${path} must not include authority field ${key}`);
    assertNoAuthority(child, `${path}.${key}`);
  }
}

function artifactRef(value, label) {
  const artifactId = value?.artifactId ?? value?.id;
  if (typeof artifactId !== "string" || !artifactId.trim() || !SHA256.test(value?.sha256 ?? "")) {
    throw new Error(`${label} must contain an artifact id and SHA-256`);
  }
  return {artifactId, sha256: value.sha256};
}

function transitionRef(value, label) {
  const ref = artifactRef(value, label);
  return {id: ref.artifactId, sha256: ref.sha256};
}

function assertArtifact(result, {kind, item, producerRole}) {
  const artifact = validateArtifactEnvelope(result?.artifact);
  const ref = artifactRef(result?.artifactRef, `${kind} artifact ref`);
  if (artifact.payload?.kind !== kind || artifact.artifactId !== ref.artifactId || artifact.workItemId !== item.id
    || artifact.revision !== item.revision || artifact.modality !== item.modality
    || (producerRole && artifact.producer?.role !== producerRole)) {
    throw new Error(`${kind} stage returned the wrong artifact identity, role, revision, or modality`);
  }
  return {artifact, ref};
}

function stageInput(command, item, stage, extra = {}) {
  const input = command.input ?? {};
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Video stage input must be an object");
  assertNoAuthority(input);
  return {
    ...structuredClone(input),
    workItemId: item.id,
    revision: item.revision,
    modality: item.modality,
    producer: {actorId: command.actor.actorId, role: stage.producerRole ?? stage.role},
    ...extra,
  };
}

async function assertStoredArtifact(projectDir, path, artifact, ref, label) {
  const bytes = await readFileNoFollow(projectDir, path);
  const stored = await hashFileNoFollow(projectDir, path);
  const parsedHash = createHash("sha256").update(bytes.bytes).digest("hex");
  if (stored.sha256 !== ref.sha256 || parsedHash !== ref.sha256 || stored.owner.dev !== bytes.owner.dev || stored.owner.ino !== bytes.owner.ino) {
    throw new Error(`${label} changed after generation`);
  }
  validateArtifactEnvelope(artifact);
}

async function transcriptSetReceipt(projectDir, item, producer, result, versions) {
  const sources = result?.indexArtifact?.payload?.sources;
  if (!Array.isArray(sources) || !sources.length || !Array.isArray(result.artifacts) || !Array.isArray(result.artifactRefs)
    || result.artifacts.length !== sources.length || result.artifactRefs.length !== sources.length) {
    throw new Error("Every indexed source requires one exact transcript before TRANSCRIPTS_READY");
  }
  const bySource = new Map();
  for (const [index, artifact] of result.artifacts.entries()) {
    const ref = artifactRef(result.artifactRefs[index], "Source transcript artifact ref");
    validateArtifactEnvelope(artifact);
    const sourceId = artifact.payload?.sourceId;
    if (artifact.payload?.kind !== "source-transcript" || artifact.artifactId !== ref.artifactId || artifact.workItemId !== item.id
      || artifact.revision !== item.revision || artifact.modality !== item.modality || artifact.producer?.role !== "local-media-technician"
      || typeof sourceId !== "string" || bySource.has(sourceId)) throw new Error("Transcript stage returned invalid or duplicate source evidence");
    bySource.set(sourceId, {artifact, ref});
  }
  const entries = [];
  for (const source of sources) {
    const transcript = bySource.get(source.id);
    if (!transcript || transcript.artifact.payload.sourceSha256 !== source.sha256) throw new Error(`Missing exact source transcript for ${source.id}`);
    const path = `Plans/Transcripts/${item.id}/v${pad(item.revision)}/${source.id}-v${pad(item.revision)}.json`;
    await assertStoredArtifact(projectDir, path, transcript.artifact, transcript.ref, `Source transcript ${source.id}`);
    entries.push({sourceId: source.id, sourceSha256: source.sha256, artifactRef: transcript.ref});
  }
  if (bySource.size !== entries.length) throw new Error("Transcript set contains an unindexed source");
  const indexRef = artifactRef(result.indexArtifactRef, "Media-index artifact ref");
  const artifact = createArtifactEnvelope({
    artifactId: `transcript-set:${item.id}:v${pad(item.revision)}`,
    revision: item.revision,
    workItemId: item.id,
    modality: item.modality,
    parents: [indexRef, ...entries.map(({artifactRef: ref}) => ref)],
    producer,
    versions,
    status: "frozen",
    deviations: [],
    payload: {kind: "transcript-set", mediaIndexArtifactRef: indexRef, transcripts: entries},
  });
  const path = `Plans/Transcripts/${item.id}/Receipts/v${pad(item.revision)}/transcript-set-v${pad(item.revision)}.json`;
  const stored = await writeImmutableArtifact(projectDir, path, artifact);
  const ref = {artifactId: artifact.artifactId, sha256: stored.sha256};
  for (const entry of entries) {
    const source = bySource.get(entry.sourceId);
    await assertStoredArtifact(projectDir, `Plans/Transcripts/${item.id}/v${pad(item.revision)}/${entry.sourceId}-v${pad(item.revision)}.json`, source.artifact, source.ref, `Source transcript ${entry.sourceId}`);
  }
  await assertStoredArtifact(projectDir, path, artifact, ref, "Transcript-set receipt");
  return {artifact, ref};
}

async function readExactEnvelope(projectDir, path, expectedRef, label) {
  const contents = await readFileNoFollow(projectDir, path);
  const ref = artifactRef(expectedRef, `${label} ref`);
  if (createHash("sha256").update(contents.bytes).digest("hex") !== ref.sha256) throw new Error(`${label} ref does not match exact stored bytes`);
  let artifact;
  try { artifact = JSON.parse(contents.bytes.toString("utf8")); } catch { throw new Error(`${label} is not valid JSON`); }
  validateArtifactEnvelope(artifact);
  if (artifact.artifactId !== ref.artifactId) throw new Error(`${label} ref does not match exact stored artifact`);
  return {artifact, ref};
}

function assertCommand(command) {
  if (!command || typeof command !== "object" || Array.isArray(command)) throw new Error("Video stage command is required");
  for (const key of Object.keys(command)) if (!new Set(["kind", "workItemId", "actor", "reason", "input"]).has(key)) throw new Error(`Unknown video stage command field: ${key}`);
  const stage = VIDEO_STAGE_MATRIX[command.kind];
  if (!stage) throw new Error(`Unknown video stage: ${command.kind}`);
  if (!SAFE_ID.test(command.workItemId ?? "")) throw new Error("Video stage work item id is invalid");
  if (!command.actor || typeof command.actor !== "object" || Array.isArray(command.actor)
    || JSON.stringify(Object.keys(command.actor).sort()) !== JSON.stringify(["actorId", "role"])
    || typeof command.actor.actorId !== "string" || !command.actor.actorId.trim() || command.actor.role !== stage.role) {
    throw new Error(`${command.kind} requires exactly one ${stage.role} actor`);
  }
  if (stage.to && (typeof command.reason !== "string" || !command.reason.trim())) throw new Error(`${command.kind} requires a transition reason`);
  return stage;
}

export async function runVideoStage(projectDir, coordinatorContext, command, dependencies = {}) {
  const stage = assertCommand(command);
  assertNoAuthority(command.input ?? {});
  const before = await readWorkflowState(projectDir);
  const item = getWorkItem(before, command.workItemId);
  if (!stage.modalities.includes(item.modality) || item.state !== stage.from) {
    throw new Error(`${command.kind} requires ${stage.modalities.join(" or ")} in ${stage.from}`);
  }
  if ((stage.to || stage.coordinator) && (!coordinatorContext || coordinatorContext.actorRole !== "coordinator")) {
    throw new Error(`${command.kind} requires coordinator authority`);
  }
  if (stage.role === "coordinator" && coordinatorContext.actorId !== command.actor.actorId) {
    throw new Error("Candidate coordinator actor must match the configured coordinator");
  }

  let artifact;
  let ref;
  const input = stageInput(command, item, stage);
  switch (command.kind) {
    case "generate-narration": {
      const result = await generateApprovedNarration(projectDir, input, dependencies.narration);
      const audio = validateArtifactEnvelope(result.audioArtifact);
      artifact = validateArtifactEnvelope(result.transcriptArtifact);
      const audioRef = artifactRef(result.audioArtifactRef, "Narration audio artifact ref");
      ref = artifactRef(result.transcriptArtifactRef, "Narration transcript artifact ref");
      if (audio.payload?.kind !== "narration-audio" || artifact.payload?.kind !== "narration-transcript"
        || audio.workItemId !== item.id || artifact.workItemId !== item.id || audio.revision !== item.revision || artifact.revision !== item.revision
        || audio.modality !== item.modality || artifact.modality !== item.modality || audio.producer?.actorId !== command.actor.actorId
        || artifact.producer?.actorId !== command.actor.actorId || artifact.parents.length !== 1
        || artifact.parents[0].artifactId !== audioRef.artifactId || artifact.parents[0].sha256 !== audioRef.sha256) {
        throw new Error("Narration must return exact generated audio and its post-generation transcript");
      }
      await assertStoredArtifact(projectDir, `Plans/Narration/${item.id}/v${pad(item.revision)}/narration-audio-v${pad(item.revision)}.json`, audio, audioRef, "Narration audio artifact");
      await assertStoredArtifact(projectDir, `Plans/Transcripts/${item.id}/v${pad(item.revision)}/narration-v${pad(item.revision)}.json`, artifact, ref, "Narration transcript artifact");
      const output = await hashFileNoFollow(projectDir, audio.payload.path);
      if (output.sha256 !== audio.payload.sha256) throw new Error("Narration returned audio does not match exact published WAV bytes");
      const state = await transitionWorkItemSequence(projectDir, coordinatorContext, [
        {workItemId: item.id, to: "AUDIO_READY", reason: command.reason, artifactRef: transitionRef(audioRef, "Narration audio artifact ref")},
        {workItemId: item.id, to: "TRANSCRIPT_READY", reason: command.reason, artifactRef: transitionRef(ref, "Narration transcript artifact ref")},
      ]);
      return {state, artifact};
    }
    case "index-media": {
      ({artifact, ref} = assertArtifact(await createMediaIndex(projectDir, input, dependencies.mediaIndex), {kind: "media-index", item, producerRole: "local-media-technician"}));
      break;
    }
    case "transcribe-sources": {
      const result = await transcribeIndexedSources(projectDir, input, dependencies.transcripts);
      ({artifact, ref} = await transcriptSetReceipt(projectDir, item, input.producer, result, result.artifacts[0]?.versions ?? input.versions));
      break;
    }
    case "plan-story":
      ({artifact, ref} = assertArtifact(await createStoryPlan(projectDir, input, dependencies.story), {kind: "story-plan", item, producerRole: "story-editor"}));
      break;
    case "analyze-subject":
      ({artifact, ref} = assertArtifact(await runSubjectAnalysis(projectDir, input, dependencies.subject), {kind: "subject-map", item, producerRole: "subject-analyst"}));
      break;
    case "resolve-assets":
      ({artifact, ref} = assertArtifact(await resolveVideoAssets(projectDir, {...input, coordinatorContext}, dependencies.assets), {kind: "asset-plan", item, producerRole: "asset-resolver"}));
      break;
    case "build-captions":
      ({artifact, ref} = assertArtifact(await writeArtifactCaptionBundle(projectDir, input, dependencies.captions), {kind: "caption-plan", item, producerRole: "caption-executor"}));
      break;
    case "build-foreground":
      ({artifact, ref} = assertArtifact(await buildArtifactForegroundSidecar(projectDir, input, dependencies.foreground), {kind: "foreground-sidecar", item, producerRole: "foreground-sidecar-executor"}));
      break;
    case "plan-design":
      ({artifact, ref} = assertArtifact(await createVideoDesignPlan(projectDir, input, dependencies.design), {kind: "video-design-plan", item, producerRole: "design-director"}));
      break;
    case "approve-design": {
      const expectedRef = artifactRef(input.artifactRef, "Design-plan artifact ref");
      const loaded = await readExactEnvelope(projectDir, `Plans/Designs/${item.id}/design-plan-v${pad(item.revision)}.json`, expectedRef, "Video design plan");
      if (loaded.artifact.payload?.kind !== "video-design-plan" || loaded.artifact.producer?.role !== "design-director") throw new Error("Design approval requires the current design-director artifact");
      await approveVideoDesignPlan(projectDir, coordinatorContext, {
        workItemId: item.id,
        artifactRef: expectedRef,
        producerActorId: loaded.artifact.producer.actorId,
        reviewerActorId: command.actor.actorId,
      });
      artifact = loaded.artifact;
      ref = expectedRef;
      break;
    }
    case "plan-execution":
      ({artifact, ref} = assertArtifact(await createVideoExecutionContract(projectDir, {...input, premiereExecutor: {actorId: command.actor.actorId, role: "premiere-executor"}}, dependencies.execution), {kind: "video-execution-plan", item, producerRole: "premiere-executor"}));
      break;
    case "execute-hyperframes": {
      const execution = await readExactEnvelope(projectDir, `Plans/Execution/${item.id}/execution-plan-v${pad(item.revision)}.json`, input.executionArtifactRef, "Video execution plan");
      if (execution.artifact.payload?.kind !== "video-execution-plan") throw new Error("HyperFrames requires an exact video execution plan");
      const outputs = await executeHyperFramesJobs(projectDir, {artifactRef: execution.ref}, dependencies.execution);
      artifact = {kind: "hyperframes-output-set", executionArtifactRef: execution.ref, outputs};
      break;
    }
    case "execute-premiere": {
      if (!dependencies.premiereAdapter) throw new Error("Premiere mutation requires a reviewed registered local bridge or injected adapter");
      const execution = await readExactEnvelope(projectDir, `Plans/Execution/${item.id}/execution-plan-v${pad(item.revision)}.json`, input.executionArtifactRef, "Video execution plan");
      if (execution.artifact.payload?.kind !== "video-execution-plan" || execution.artifact.producer?.actorId !== command.actor.actorId) {
        throw new Error("Premiere executor must be the exact registered single writer");
      }
      const result = await executePremiereAssembly(projectDir, {artifactRef: execution.ref}, dependencies.premiereAdapter, dependencies.execution);
      ({artifact, ref} = assertArtifact(result, {kind: "premiere-readback", item, producerRole: "premiere-executor"}));
      break;
    }
    case "freeze-candidate": {
      const result = await freezeVideoCandidate(projectDir, coordinatorContext, input, dependencies.execution);
      artifact = result.bundle;
      ref = artifactRef(result.candidateRef, "Candidate bundle ref");
      if (artifact.workItemId !== item.id || artifact.revision !== item.revision || artifact.modality !== item.modality || artifact.bundleHash !== ref.sha256) {
        throw new Error("Candidate stage returned the wrong exact bundle");
      }
      break;
    }
    default:
      throw new Error(`Unknown video stage: ${command.kind}`);
  }

  if (stage.to) {
    const state = await transitionWorkItem(projectDir, coordinatorContext, {
      workItemId: item.id,
      to: stage.to,
      reason: command.reason,
      artifactRef: transitionRef(ref, `${command.kind} artifact ref`),
    });
    return {state, artifact};
  }
  const state = await readWorkflowState(projectDir);
  const current = getWorkItem(state, item.id);
  if (current.state !== stage.from || current.revision !== item.revision || current.modality !== item.modality) {
    throw new Error(`${command.kind} workflow changed during same-state preparation`);
  }
  return {state, artifact};
}
