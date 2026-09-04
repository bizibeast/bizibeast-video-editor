import assert from "node:assert/strict";
import {mkdtemp, readFile, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {sha256File} from "../src/checksum.mjs";
import {ingestFiles} from "../src/ingest.mjs";
import {mutateManifest} from "../src/manifest.mjs";
import {runVideoStage, VIDEO_STAGE_MATRIX} from "../src/video-pipeline.mjs";
import {createProject} from "../src/project.mjs";
import {authorizeVoice} from "../src/voice-authorization.mjs";
import {approveScriptRevision, writeScriptRevision} from "../src/video-script.mjs";
import {createWorkItem, getWorkItem, readWorkflowState, transitionProject, transitionWorkItem} from "../src/workflow.mjs";

const coordinator = {actorId: "coord-1", actorRole: "coordinator"};
const versions = {tool: "content-hub@0.2.0", template: null, model: null, policy: "bizibeast-v1"};
const media = {durationSeconds: 1.2, formatName: "mov", video: [{codec_name: "h264", width: 1080, height: 1920, avg_frame_rate: "30/1"}],
  audio: [{codec_name: "aac", sample_rate: "48000", channels: 2}], raw: {format: {tags: {}}, streams: []}};

async function readyProject(name = "Pipeline") {
  const root = await mkdtemp(join(tmpdir(), "content-hub-video-pipeline-"));
  const {projectDir} = await createProject(root, {name, editors: ["premiere"], coordinatorActorId: coordinator.actorId});
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "inputs ready"});
  return {root, projectDir};
}

test("raw stages fix role/state dispatch and freeze one exact transcript-set receipt", async () => {
  const {projectDir} = await readyProject("Raw relay");
  await createWorkItem(projectDir, coordinator, {id: "raw-01", title: "Raw reel", modality: "raw-video"});
  const sourcePath = join(projectDir, "Source", "clip.mov");
  await writeFile(sourcePath, "video bytes");
  await mutateManifest(projectDir, coordinator, async (manifest) => {
    manifest.sources = [{id: "source-1", kind: "source", path: "Source/clip.mov", sha256: await sha256File(sourcePath),
      bytes: (await stat(sourcePath)).size, createdAt: "2026-09-01T00:00:00Z"}];
    return manifest;
  });

  const indexed = await runVideoStage(projectDir, coordinator, {
    kind: "index-media", workItemId: "raw-01", actor: {actorId: "media-1", role: "local-media-technician"},
    reason: "sources indexed", input: {versions, parents: []},
  }, {mediaIndex: {probe: async () => media}});
  assert.equal(indexed.artifact.payload.kind, "media-index");
  assert.equal(getWorkItem(indexed.state, "raw-01").state, "MEDIA_INDEXED");
  const mediaRef = indexed.state.events.at(-1).artifactRef;

  const transcribed = await runVideoStage(projectDir, coordinator, {
    kind: "transcribe-sources", workItemId: "raw-01", actor: {actorId: "media-1", role: "local-media-technician"},
    reason: "every source transcribed", input: {versions, mediaIndexArtifactRef: {artifactId: mediaRef.id, sha256: mediaRef.sha256},
      currentParents: [], parakeetModelRevision: "parakeet-test"},
  }, {transcripts: {run: async (_command, args) => {
    await writeFile(join(args[1], "words.json"), JSON.stringify({words: [{text: "Open", start: 0.1, end: 0.7}]}));
    return {code: 0, stdout: "", stderr: ""};
  }}});

  assert.equal(getWorkItem(transcribed.state, "raw-01").state, "TRANSCRIPTS_READY");
  assert.equal(transcribed.artifact.payload.kind, "transcript-set");
  assert.deepEqual(transcribed.artifact.payload.transcripts.map(({sourceId}) => sourceId), ["source-1"]);
  assert.equal(transcribed.artifact.parents.length, 2);
  assert.equal(JSON.parse(await readFile(join(projectDir, "Plans/Transcripts/raw-01/Receipts/v001/transcript-set-v001.json"), "utf8")).artifactId,
    "transcript-set:raw-01:v001");
});

test("voice narration verifies audio and post transcript then advances both states atomically", async () => {
  const {root, projectDir} = await readyProject("Voice relay");
  await createWorkItem(projectDir, coordinator, {id: "voice-01", title: "Voice reel", modality: "voice-over"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "voice-01", to: "SCRIPT_DRAFT", reason: "drafting"});
  const script = await writeScriptRevision(projectDir, {workItemId: "voice-01", revision: 1, text: "Ship the verified narration.\n",
    producer: {actorId: "script-1", role: "script-editorial"}});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "voice-01", to: "AWAITING_SCRIPT_APPROVAL", reason: "review"});
  await approveScriptRevision(projectDir, coordinator, {workItemId: "voice-01", artifact: script.artifact, expectedSha256: script.scriptSha256,
    approver: {actorId: "human-yash", role: "human"}});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "voice-01", to: "SCRIPT_APPROVED", reason: "approved",
    artifactRef: {id: script.artifact.artifactId, sha256: script.artifactRef.sha256}});
  const reference = join(root, "reference.wav");
  const referenceTranscript = join(projectDir, "Assets/Voice/reference.txt");
  await writeFile(reference, "voice reference");
  await writeFile(referenceTranscript, "Voice reference transcript.");
  const [voice] = await ingestFiles(projectDir, [reference], "voice", {voiceClone: true}, coordinator);
  await authorizeVoice(projectDir, {assetId: voice.id, subject: "synthetic", basis: "test fixture"}, coordinator);
  const input = {scriptArtifactId: script.artifact.artifactId, scriptSha256: script.scriptSha256, scriptArtifactRef: script.artifactRef,
    voiceAssetId: voice.id, voiceAuthorizationRef: {artifactId: voice.id, sha256: voice.sha256}, referenceAudioPath: voice.absolutePath,
    referenceTranscriptPath: referenceTranscript, outputPath: join(projectDir, "Renders/Narration/voice-01-v001.wav"),
    qwenModelRevision: "qwen-test", parakeetModelRevision: "parakeet-test"};
  const command = {kind: "generate-narration", workItemId: "voice-01", actor: {actorId: "media-voice", role: "local-media-technician"},
    reason: "audio and timing verified", input};

  await assert.rejects(runVideoStage(projectDir, coordinator, {...command, input: {...input, scriptSha256: "0".repeat(64)}}), /exact approved script hash/u);
  const completed = await runVideoStage(projectDir, coordinator, command, {narration: {
    run: async (executable, args) => {
      if (executable.endsWith("narrate-approved.sh")) await writeFile(args.at(-1), "generated wav", {flag: "wx"});
      else await writeFile(join(args[1], "narration.json"), JSON.stringify({words: [{text: "Generated", start: 0, end: 0.9}]}));
      return {code: 0, stdout: "", stderr: ""};
    },
    probe: async () => ({durationSeconds: 0.9, video: [], audio: [{sample_rate: "48000", channels: 1, codec_name: "pcm_s24le"}]}),
  }});
  const item = getWorkItem(completed.state, "voice-01");
  assert.equal(item.state, "TRANSCRIPT_READY");
  assert.equal(completed.artifact.payload.kind, "narration-transcript");
  assert.deepEqual(completed.state.events.slice(-2).map(({from, to}) => [from, to]), [
    ["SCRIPT_APPROVED", "AUDIO_READY"], ["AUDIO_READY", "TRANSCRIPT_READY"],
  ]);
});

test("the coordinator fails closed on unknown stages, wrong roles, states, and smuggled authority", async () => {
  const {projectDir} = await readyProject("Closed relay");
  await createWorkItem(projectDir, coordinator, {id: "raw-closed", title: "Closed", modality: "raw-video"});
  await assert.rejects(runVideoStage(projectDir, coordinator, {kind: "invent-video", workItemId: "raw-closed", actor: {actorId: "x", role: "coordinator"}, input: {}}), /Unknown video stage/u);
  await assert.rejects(runVideoStage(projectDir, coordinator, {kind: "plan-story", workItemId: "raw-closed", actor: {actorId: "x", role: "story-editor"}, reason: "skip", input: {}}), /TRANSCRIPTS_READY/u);
  await assert.rejects(runVideoStage(projectDir, coordinator, {kind: "index-media", workItemId: "raw-closed", actor: {actorId: "x", role: "story-editor"}, reason: "wrong", input: {}}), /local-media-technician/u);
  for (const input of [{producer: {}}, {coordinatorContext: {}}, {premiereExecutor: {}}, {adapter: {execute() {}}}]) {
    await assert.rejects(runVideoStage(projectDir, coordinator, {kind: "index-media", workItemId: "raw-closed",
      actor: {actorId: "media", role: "local-media-technician"}, reason: "index", input}), /authority field/u);
  }
});

test("the explicit matrix includes every preparatory and execution stage and CLI cannot supply Premiere authority", async () => {
  assert.deepEqual(Object.fromEntries(Object.entries(VIDEO_STAGE_MATRIX).map(([kind, rule]) => [kind, {
    role: rule.role, modalities: [...rule.modalities], from: rule.from, to: rule.to,
  }])), {
    "generate-narration": {role: "local-media-technician", modalities: ["voice-over"], from: "SCRIPT_APPROVED", to: "TRANSCRIPT_READY"},
    "index-media": {role: "local-media-technician", modalities: ["raw-video", "multi-clip"], from: "READY", to: "MEDIA_INDEXED"},
    "transcribe-sources": {role: "local-media-technician", modalities: ["raw-video", "multi-clip"], from: "MEDIA_INDEXED", to: "TRANSCRIPTS_READY"},
    "plan-story": {role: "story-editor", modalities: ["raw-video", "multi-clip"], from: "TRANSCRIPTS_READY", to: "STORY_PLANNED"},
    "analyze-subject": {role: "subject-analyst", modalities: ["raw-video", "multi-clip"], from: "STORY_PLANNED", to: null},
    "resolve-assets": {role: "asset-resolver", modalities: ["raw-video", "multi-clip"], from: "STORY_PLANNED", to: null},
    "build-captions": {role: "hyperframes-executor", modalities: ["raw-video", "multi-clip"], from: "STORY_PLANNED", to: null},
    "build-foreground": {role: "hyperframes-executor", modalities: ["raw-video", "multi-clip"], from: "STORY_PLANNED", to: null},
    "plan-design": {role: "design-director", modalities: ["raw-video", "multi-clip"], from: "STORY_PLANNED", to: "DESIGN_PLANNED"},
    "approve-design": {role: "design-approver", modalities: ["raw-video", "multi-clip"], from: "DESIGN_PLANNED", to: "DESIGN_APPROVED"},
    "plan-execution": {role: "premiere-executor", modalities: ["raw-video", "multi-clip"], from: "DESIGN_APPROVED", to: "EXECUTING"},
    "execute-hyperframes": {role: "hyperframes-executor", modalities: ["raw-video", "multi-clip"], from: "EXECUTING", to: null},
    "execute-premiere": {role: "premiere-executor", modalities: ["raw-video", "multi-clip"], from: "EXECUTING", to: null},
    "freeze-candidate": {role: "coordinator", modalities: ["raw-video", "multi-clip"], from: "EXECUTING", to: "CANDIDATE_FROZEN"},
  });
  const {projectDir} = await readyProject("Premiere relay");
  await createWorkItem(projectDir, coordinator, {id: "premiere-closed", title: "Premiere", modality: "raw-video"});
  for (const to of ["MEDIA_INDEXED", "TRANSCRIPTS_READY", "STORY_PLANNED", "DESIGN_PLANNED", "DESIGN_APPROVED", "EXECUTING"]) {
    await transitionWorkItem(projectDir, coordinator, {workItemId: "premiere-closed", to, reason: to,
      artifactRef: to === "DESIGN_APPROVED" ? {id: "design", sha256: "a".repeat(64)} : undefined});
  }
  await assert.rejects(runVideoStage(projectDir, coordinator, {kind: "execute-premiere", workItemId: "premiere-closed",
    actor: {actorId: "premiere-1", role: "premiere-executor"}, input: {executionArtifactRef: {artifactId: "plan", sha256: "a".repeat(64)}}}),
  /reviewed registered local bridge or injected adapter/u);
});

test("same-state asset preparation publishes evidence without an illegal workflow transition", async () => {
  const {projectDir} = await readyProject("Preparation relay");
  await createWorkItem(projectDir, coordinator, {id: "raw-prep", title: "Prepare", modality: "raw-video"});
  for (const to of ["MEDIA_INDEXED", "TRANSCRIPTS_READY", "STORY_PLANNED"]) {
    await transitionWorkItem(projectDir, coordinator, {workItemId: "raw-prep", to, reason: to});
  }
  const assetPath = join(projectDir, "Assets/Images/prep.png");
  await writeFile(assetPath, "image bytes");
  await mutateManifest(projectDir, coordinator, async (manifest) => {
    manifest.assets.push({id: "prep-image", kind: "image", path: "Assets/Images/prep.png", sha256: await sha256File(assetPath),
      bytes: (await stat(assetPath)).size, createdAt: "2026-09-01T00:00:00Z", private: false, client: false, voiceClone: false});
    return manifest;
  });
  const beforeEvents = (await readWorkflowState(projectDir)).events.length;
  const completed = await runVideoStage(projectDir, coordinator, {kind: "resolve-assets", workItemId: "raw-prep",
    actor: {actorId: "assets-1", role: "asset-resolver"}, input: {needs: [{id: "optional-image", kind: "image", required: false}], parents: [], versions}},
  {assets: {frozenCandidates: async () => [], sharedCandidates: async () => [], acquirePublic: async () => [], generateLocal: async () => [],
    probe: async () => ({durationSeconds: 1, video: [{}], audio: []}), decode: async () => ({code: 0})}});
  assert.equal(getWorkItem(completed.state, "raw-prep").state, "STORY_PLANNED");
  assert.equal(completed.artifact.payload.kind, "asset-plan");
  assert.equal(completed.state.events.length, beforeEvents);
});
