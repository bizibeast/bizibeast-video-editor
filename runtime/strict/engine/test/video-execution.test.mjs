import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {access, mkdir, mkdtemp, readdir, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import test from "node:test";

import {recordApproval} from "../src/approvals.mjs";
import {createArtifactEnvelope, writeImmutableArtifact} from "../src/artifacts.mjs";
import {sha256File, sha256Value} from "../src/checksum.mjs";
import {mutateManifest} from "../src/manifest.mjs";
import {createProject} from "../src/project.mjs";
import {resolveTechnicalProfile} from "../src/qc-profiles.mjs";
import {removeOwnedStage, writeExclusiveFile} from "../src/release-fs.mjs";
import {createVideoExecutionContract, executeHyperFramesJobs, executePremiereAssembly, freezeVideoCandidate} from "../src/video-execution.mjs";
import {createWorkItem, readWorkflowState, transitionProject, transitionWorkItem} from "../src/workflow.mjs";

const coordinator = {actorId: "content-hub-coordinator", actorRole: "coordinator"};
const versions = {tool: "content-hub@0.2.0", template: "sunburst-v1", model: null, policy: "bizibeast-v1"};
const digest = (value) => createHash("sha256").update(value).digest("hex");

async function store(projectDir, path, input) {
  const artifact = createArtifactEnvelope({...input, revision: 1, versions, status: "frozen"});
  const stored = await writeImmutableArtifact(projectDir, path, artifact);
  return {artifact, ref: {artifactId: artifact.artifactId, sha256: stored.sha256}};
}

async function fixture({workItemId = "reel", singleHyperframesJob = false} = {}) {
  const root = await mkdtemp(join(tmpdir(), "content-hub-video-execution-"));
  const {projectDir} = await createProject(root, {name: `Execution ${workItemId}`, aspect: "9:16", editors: ["premiere"]});
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "inputs frozen"});
  await createWorkItem(projectDir, coordinator, {id: workItemId, title: workItemId, modality: "raw-video"});
  for (const state of ["MEDIA_INDEXED", "TRANSCRIPTS_READY", "STORY_PLANNED"]) await transitionWorkItem(projectDir, coordinator, {workItemId, to: state, reason: state});

  await mkdir(join(projectDir, "Plans", "Brand"), {recursive: true});
  await writeFile(join(projectDir, "Assets", "Fonts", "Archivo.ttf"), "font");
  const fontSha256 = await sha256File(join(projectDir, "Assets", "Fonts", "Archivo.ttf"));
  const brandPath = "Plans/Brand/brand-lock.json";
  await writeFile(join(projectDir, brandPath), JSON.stringify({artifactId: "project-brand-lock-v001", fonts: [{path: "Assets/Fonts/Archivo.ttf", sha256: fontSha256}]}));
  const brandSha256 = await sha256File(join(projectDir, brandPath));
  await mutateManifest(projectDir, coordinator, (manifest) => ({...manifest, brand: {artifactId: "project-brand-lock-v001", lockPath: brandPath,
    lockSha256: brandSha256, frameSha256: digest("frame"), fontHashes: [fontSha256]}}));

  await writeFile(join(projectDir, "Source", "source-a.mov"), "source bytes");
  await writeFile(join(projectDir, "Assets", "Images", "plate.png"), "plate bytes");
  await mkdir(join(projectDir, "Renders", "Captions", workItemId, "v001"), {recursive: true});
  await writeFile(join(projectDir, "Renders", "Captions", workItemId, "v001", "captions.srt"), "1\n00:00:00,100 --> 00:00:01,500\nHello\n");
  const hyperframesCaptions = `${JSON.stringify({captions: JSON.stringify({segments: [{shotId: "shot-01", start: 0.1, end: 1.5, text: "Hello",
    words: [{id: "source-a:w000001", text: "Hello", start: 0.1, end: 1.5, fontRole: "body"}], placement: {x: 80, y: 200}}], durationSeconds: 1.8}),
  style: "editorial-pair", durationSeconds: 1.8}, null, 2)}\n`;
  await writeFile(join(projectDir, "Renders", "Captions", workItemId, "v001", "captions.hyperframes.json"), hyperframesCaptions);
  const sourceSha256 = await sha256File(join(projectDir, "Source", "source-a.mov"));
  const plateSha256 = await sha256File(join(projectDir, "Assets", "Images", "plate.png"));
  const srtSha256 = await sha256File(join(projectDir, "Renders", "Captions", workItemId, "v001", "captions.srt"));
  const hyperframesSha256 = await sha256File(join(projectDir, "Renders", "Captions", workItemId, "v001", "captions.hyperframes.json"));

  const story = await store(projectDir, `Plans/Stories/${workItemId}/story-plan-v001.json`, {artifactId: `story-plan:${workItemId}:v001`, workItemId,
    modality: "raw-video", parents: [], producer: {actorId: "story-01", role: "story-editor"}, deviations: [], payload: {kind: "story-plan",
      silencePlan: [{sourceId: "source-a", silencePlan: {operations: [{kind: "compress-gap", removeStartMs: 400, removeEndMs: 520, removedMs: 120}]}}]}});
  const transcript = await store(projectDir, `Plans/Transcripts/${workItemId}/v001/source-a-v001.json`, {artifactId: `source-transcript:${workItemId}:source-a:v001`, workItemId,
    modality: "raw-video", parents: [], producer: {actorId: "media-01", role: "local-media-technician"}, deviations: [], payload: {kind: "source-transcript", sourceId: "source-a", sourceSha256}});
  const assets = await store(projectDir, `Plans/Assets/${workItemId}/asset-plan-v001.json`, {artifactId: `asset-plan:${workItemId}:v001`, workItemId,
    modality: "raw-video", parents: [], producer: {actorId: "asset-01", role: "asset-resolver"}, deviations: [], payload: {kind: "asset-plan",
      selections: [{id: "plate-01", path: "Assets/Images/plate.png", sha256: plateSha256, bytes: 11}]}});
  const subject = await store(projectDir, `Plans/Subjects/${workItemId}/v001/source-a-v001.json`, {artifactId: `subject-map:${workItemId}:source-a:v001`, workItemId,
    modality: "raw-video", parents: [], producer: {actorId: "subject-01", role: "subject-analyst"}, deviations: [], payload: {kind: "subject-map", sourceId: "source-a", frames: []}});
  const captions = await store(projectDir, `Plans/Captions/${workItemId}/caption-plan-v001.json`, {artifactId: `caption-plan:${workItemId}:v001`, workItemId,
    modality: "raw-video", parents: [], producer: {actorId: "caption-01", role: "caption-executor"}, deviations: [], payload: {kind: "caption-plan",
      files: {srt: {path: `Renders/Captions/${workItemId}/v001/captions.srt`, sha256: srtSha256, bytes: 38},
        hyperframes: {path: `Renders/Captions/${workItemId}/v001/captions.hyperframes.json`, sha256: hyperframesSha256, bytes: Buffer.byteLength(hyperframesCaptions)}},
      cues: [{cueId: "cue-001", shotId: "shot-01", startMs: 100, endMs: 1500, wordIds: ["source-a:w000001"], placement: {x: 80, y: 200}}]}});
  const parentRefs = [story.ref, transcript.ref, assets.ref, subject.ref, {artifactId: "project-brand-lock-v001", sha256: brandSha256}, captions.ref];
  const designPlan = {schemaVersion: 1, workItemId, revision: 1, format: "9:16", stylePresetId: "cinematic-layered-explainer-v1",
    parents: {scriptOrTranscript: transcript.ref, transcripts: [transcript.ref], storyPlan: story.ref, assetPlan: assets.ref, subjectMaps: [subject.ref],
      brand: {artifactId: "project-brand-lock-v001", sha256: brandSha256}, captionPlan: captions.ref, foregroundSidecars: []},
    silencePlanRef: story.ref, brand: {id: "sunburst", version: "1", frameSha256: digest("frame"), fontHashes: [fontSha256]},
    heroMoment: "Open", surpriseBeat: "Reveal", antiPatterns: [], deviations: [], shots: [{id: "shot-01", timeline: {inMs: 0, outMs: 1800},
      source: {sourceId: "source-a", sourceSha256, storySegmentId: "segment-01", inMs: 0, outMs: 1920, silenceOperationHashes: []},
      assets: [{assetId: "plate-01", kind: "image", sha256: plateSha256, usageId: "shot-01"}],
      captions: {enabled: true, identity: "editorial-pair", cueIds: ["cue-001"], fontRoles: ["body"], placement: {x: 80, y: 200}}, depth: {mode: "flat"},
      onScreenCopy: {mode: "upper-montage", layers: [
        {id: "back", role: "back", owner: {role: "hyperframes-executor", editor: "hyperframes"}, inMs: 0, outMs: 1800,
          entryFrames: 12, staggerFrames: 4, settleFrames: 15, holdFrames: null, exitFrames: 8, easing: "power4.out", fromScale: 0.88, toScale: 1, overshoot: 0},
        {id: "subject", role: "subject", owner: {role: "premiere-executor", editor: "premiere"}, inMs: 0, outMs: 1800,
          entryFrames: 12, staggerFrames: 4, settleFrames: 15, holdFrames: null, exitFrames: 8, easing: "power3.out", fromScale: 0.88, toScale: 1, overshoot: 0},
        {id: "foreground", role: "foreground", owner: {role: "hyperframes-executor", editor: "hyperframes"}, inMs: 100, outMs: 1700,
          entryFrames: 12, staggerFrames: 4, settleFrames: 15, holdFrames: null, exitFrames: 8, easing: "power3.out", fromScale: 0.88, toScale: 1, overshoot: 0.02},
        {id: "caption", role: "caption", owner: singleHyperframesJob ? {role: "premiere-executor", editor: "premiere"} : {role: "hyperframes-executor", editor: "hyperframes"}, inMs: 100, outMs: 1500,
          entryFrames: 12, staggerFrames: 4, settleFrames: 15, holdFrames: null, exitFrames: 8, easing: "power3.out", fromScale: 0.88, toScale: 1, overshoot: 0},
      ]}}]};
  const design = await store(projectDir, `Plans/Designs/${workItemId}/design-plan-v001.json`, {artifactId: `video-design-plan:${workItemId}:v001`, workItemId,
    modality: "raw-video", parents: parentRefs, producer: {actorId: "design-01", role: "design-director"}, deviations: [], payload: {kind: "video-design-plan", ...designPlan}});
  await transitionWorkItem(projectDir, coordinator, {workItemId, to: "DESIGN_PLANNED", reason: "design planned"});
  const designApproval = await recordApproval(projectDir, coordinator, {kind: "design", workItemId, subject: design.ref, decision: "approved",
    approver: {actorId: "design-review-01", role: "design-approver"}, producerActorId: "design-01", origin: "bizibeast", policyVersion: "bizibeast-v1"});
  await transitionWorkItem(projectDir, coordinator, {workItemId, to: "DESIGN_APPROVED", reason: "design approved", artifactRef: {id: design.ref.artifactId, sha256: design.ref.sha256}});
  const inputLock = {artifacts: [design.ref, story.ref, transcript.ref, assets.ref, subject.ref, captions.ref].map(({artifactId: id, sha256}) => ({id, sha256})),
    approvals: [{id: designApproval.id, subjectSha256: design.ref.sha256}], assets: [{id: "plate-01", sha256: plateSha256}, {id: "source-a", sha256: sourceSha256}]};
  const input = {workItemId, revision: 1, modality: "raw-video", designPlanRef: design.ref, designApprovalRef: {id: designApproval.id, subjectSha256: design.ref.sha256},
    designPlan, technicalProfile: resolveTechnicalProfile("vertical-short-v1"), inputLock,
    sourceImports: [{id: "source-a", path: "Source/source-a.mov", sha256: sourceSha256, bytes: 12}],
    premiereExecutor: {actorId: "premiere-01", role: "premiere-executor"}, versions};
  return {projectDir, input};
}

function mediaRun() {
  return async (command, args) => {
    if (command === "ffprobe") {
      const master = args.at(-1).endsWith("/master.mov");
      return {code: 0, signal: null, truncated: false, stderr: "", stdout: JSON.stringify({streams: [
        {codec_type: "video", codec_name: "prores", profile: master ? "HQ" : "4444", pix_fmt: master ? "yuv422p10le" : "yuva444p10le",
          width: 1080, height: 1920, r_frame_rate: "30/1", duration: "1.8"}, ...(master ? [{codec_type: "audio", sample_rate: "48000"}] : []),
      ], format: {duration: "1.8"}})};
    }
    if (command === "ffmpeg") return {code: 0, signal: null, truncated: false, stderr: "", stdout: args.includes("alphaextract,signalstats,metadata=print:file=-")
      ? "lavfi.signalstats.YMIN=0\nlavfi.signalstats.YMAX=255\n" : ""};
    if (command === "/usr/bin/env") {
      const output = args.find((value) => value.includes("/Renders/Shots/") && value.endsWith(".mov"));
      await writeFile(output, "sidecar bytes", {flag: "wx"});
      return {code: 0, signal: null, truncated: false, stderr: "", stdout: "ok"};
    }
    throw new Error(`Unexpected command ${command}`);
  };
}

function readbackFor(execution, sidecars, {projectPath, sequenceName}) {
  const hashes = new Map(sidecars.map(({jobId, sha256}) => [jobId, sha256]));
  const clips = execution.executionContract.premiere.clipPlan.map((clip) => ({...clip, sha256: hashes.get(clip.mediaId) ?? clip.sha256}));
  const snapshot = (state) => ({state, sha256: sha256Value(state)});
  let current = snapshot({sequenceId: "sequence-001", applied: []});
  const mutationSnapshots = execution.executionContract.premiere.actions.map(({actionId}) => {
    const before = current;
    current = snapshot({sequenceId: "sequence-001", applied: [...before.state.applied, actionId]});
    return {actionId, before, after: current};
  });
  return {sequence: {projectPath, name: sequenceName, sequenceId: "sequence-001"}, clips,
    silenceOperations: execution.executionContract.premiere.silenceOperations,
    nativeCaptionTrack: {retained: true, trackId: "captions-001", sourcePath: execution.executionContract.premiere.nativeCaptionTrack.sourcePath,
      sourceSha256: execution.executionContract.premiere.nativeCaptionTrack.sourceSha256},
    dependencies: [...execution.executionContract.premiere.frozenDependencies, ...sidecars.map(({jobId, path, sha256}) => ({id: jobId, path, sha256}))]
      .map(({id, path, sha256}) => ({id, path, sha256})).toSorted((left, right) => left.path.localeCompare(right.path)),
    mutationSnapshots, warnings: [], gaps: [], networkDenied: true};
}

async function completedFixture(workItemId) {
  const {projectDir, input} = await fixture({workItemId});
  const execution = await createVideoExecutionContract(projectDir, input);
  await transitionWorkItem(projectDir, coordinator, {workItemId, to: "EXECUTING", reason: "execute",
    artifactRef: {id: execution.artifactRef.artifactId, sha256: execution.artifactRef.sha256}});
  const run = mediaRun();
  const sidecars = await executeHyperFramesJobs(projectDir, execution, {run});
  const premiere = await executePremiereAssembly(projectDir, execution, {
    execute: async ({outputPath}) => writeFile(outputPath, "master bytes", {flag: "wx"}),
    readback: async (query) => readbackFor(execution, sidecars, query),
  }, {run});
  const script = await store(projectDir, `Plans/Scripts/${workItemId}/script-v001.json`, {artifactId: `script-${workItemId}-v001`, workItemId,
    modality: "raw-video", parents: [], producer: {actorId: "script-01", role: "script-editorial"}, deviations: [], payload: {kind: "script"}});
  const scriptApproval = await recordApproval(projectDir, coordinator, {kind: "script", workItemId, subject: script.ref, decision: "approved",
    approver: {actorId: "human-yash", role: "human"}, origin: "user", policyVersion: "bizibeast-v1"});
  const inputLock = {artifacts: [...input.inputLock.artifacts, {id: execution.artifactRef.artifactId, sha256: execution.artifactRef.sha256},
    {id: premiere.artifactRef.artifactId, sha256: premiere.artifactRef.sha256}, {id: script.ref.artifactId, sha256: script.ref.sha256}],
  approvals: [...input.inputLock.approvals, {id: scriptApproval.id, subjectSha256: script.ref.sha256}], assets: input.inputLock.assets};
  const candidateInput = {workItemId, modality: "raw-video", revision: 1, executionArtifactRef: execution.artifactRef,
    outputs: [{path: execution.executionContract.premiere.masterPath, kind: "master", order: 1},
      {path: execution.executionContract.premiere.readbackPath, kind: "premiere-readback", order: 2}],
    inputLock, requestedDerivatives: ["mov"]};
  return {projectDir, execution, run, candidateInput};
}

test("creates one immutable writer and independent artifact-bound HyperFrames jobs", async () => {
  const {projectDir, input} = await fixture();
  for (const hostile of ["ssh:host", "git:repo", "urn:example:test", "https://example.test/plan", "unknown:reel:v001", "../plan"]) {
    await assert.rejects(createVideoExecutionContract(projectDir, {...input, designPlanRef: {artifactId: hostile, sha256: input.designPlanRef.sha256}}), /documented BiziBeast artifact ID/u);
  }
  await assert.rejects(createVideoExecutionContract(projectDir, {...input, designApprovalRef: {id: "approval-missing", subjectSha256: input.designPlanRef.sha256}}), /approved design/i);
  const result = await createVideoExecutionContract(projectDir, input);
  const contract = result.executionContract;
  assert.equal(contract.premiere.singleWriter.actorId, "premiere-01");
  assert.deepEqual(contract.premiere.videoTracks.map(({role}) => role), ["background-plate", "text-graphics", "foreground-subject", "designed-captions"]);
  assert.deepEqual(contract.premiere.audioTracks.map(({role}) => role), ["dialogue-or-narration", "bgm", "sfx"]);
  assert.equal(contract.premiere.nativeCaptionTrack.required, true);
  assert.equal(contract.premiere.shots[0].requiredHandleMs, 40);
  assert.equal(contract.premiere.deviationPolicy, "return-to-design-approval");
  assert.equal(contract.premiere.writerLockPath, ".premiere-writer.lock");
  assert.equal(contract.premiere.shots[0].foregroundMode, "v1-source-only");
  assert.equal(contract.premiere.clipPlan.some(({trackType, trackIndex}) => trackType === "video" && trackIndex === 3), false);
  assert.deepEqual(contract.hyperframesDependencyClosure.map(({path}) => path), [
    "compositions/video-shot-layered-portrait.html", "hyperframes.json", "assets/sunburst.css",
    "assets/fonts/Archivo.ttf", "assets/fonts/Fraunces.ttf",
  ]);
  assert.deepEqual(contract.hyperframes.map(({kind}) => kind), ["graphics", "captions"]);
  assert.ok(contract.hyperframes.every(({codec, composition}) => codec === "prores-4444" && composition === "compositions/video-shot-layered-portrait.html"));
  assert.deepEqual(contract.hyperframes[0].layers.map(({role}) => role), ["back", "foreground"]);
  assert.deepEqual(contract.hyperframes[1].layers.map(({role}) => role), ["caption"]);
  assert.ok(contract.hyperframes.every(({outputPath}) => outputPath.startsWith("Renders/Shots/")));
  const variables = JSON.parse(await readFile(join(projectDir, contract.hyperframes[0].variablesPath), "utf8"));
  assert.equal(variables.render.durationMs, 1800);
  assert.equal(variables.variables.style, "editorial-pair");
  const backLayer = JSON.parse(variables.variables.backLayer).layers[0];
  assert.equal(backLayer.content.text, "Hello");
  assert.equal(backLayer.content.asset.path, "Assets/Images/plate.png");
  assert.equal(digest(Buffer.from(backLayer.content.asset.dataUrl.split(",")[1], "base64")), backLayer.content.asset.sha256);
  assert.deepEqual(backLayer.geometry, {x: 68, y: 130, width: 944, height: 330});
  assert.deepEqual([backLayer.entryFrames, backLayer.staggerFrames, backLayer.settleFrames, backLayer.holdFrames, backLayer.exitFrames], [12, 4, 15, null, 8]);
  const captionVariables = JSON.parse(await readFile(join(projectDir, contract.hyperframes[1].variablesPath), "utf8"));
  assert.equal(JSON.parse(captionVariables.variables.captions).segments[0].text, "Hello");
  assert.deepEqual(JSON.parse(await readFile(join(projectDir, "Plans/Execution/reel/execution-plan-v001.json"), "utf8")), result.artifact);
});

test("layered composition consumes approved content geometry and runner uses only trusted 0.8.25 roots", async () => {
  const composition = await readFile(join(import.meta.dirname, "../../../../templates/hyperframes/compositions/video-shot-layered-portrait.html"), "utf8");
  const runner = await readFile(join(import.meta.dirname, "../scripts/video/render-hyperframes.sh"), "utf8");
  assert.match(composition, /data-width="1080" data-height="1920"/u);
  assert.match(composition, /#back-clip \{ z-index: 10; \}/u);
  assert.match(composition, /#foreground-clip \{ z-index: 30; \}/u);
  assert.match(composition, /#caption-clip \{ z-index: 40; \}/u);
  assert.match(composition, /layer\.content\?\.text/u);
  assert.match(composition, /layer\.geometry/u);
  for (const token of ["entryFrames", "staggerFrames", "settleFrames", "holdFrames", "exitFrames", "layer.easing"]) assert.match(composition, new RegExp(token, "u"));
  assert.match(composition, /dataset\.assetSha256/u);
  assert.doesNotMatch(composition, /<(?:video|audio)\b/iu);
  assert.doesNotMatch(runner, /HYPERFRAMES_BIN/u);
  assert.doesNotMatch(runner, /--strict-variables/u);
  assert.match(runner, /variables envelope does not match invocation or declared schema/u);
  assert.match(runner, /hyperframes\/package\.json/u);
});

test("execution publication rolls back only files owned by a failed attempt", async () => {
  const {projectDir, input} = await fixture({workItemId: "rollback"});
  await assert.rejects(createVideoExecutionContract(projectDir, input, {writeExclusiveFile: async (root, path, bytes) => {
    if (path.includes("Plans/Execution/")) throw new Error("publish failed");
    return writeExclusiveFile(root, path, bytes);
  }}), /publish failed/u);
  await assert.rejects(access(join(projectDir, "Editors/HyperFrames/rollback/v001/shot-01-graphics.variables.json")));
});

test("jobs require exact artifact refs and roll back a successful sibling", async () => {
  const {projectDir, input} = await fixture({workItemId: "jobs"});
  const result = await createVideoExecutionContract(projectDir, input);
  await transitionWorkItem(projectDir, coordinator, {workItemId: "jobs", to: "EXECUTING", reason: "execute",
    artifactRef: {id: result.artifactRef.artifactId, sha256: result.artifactRef.sha256}});
  await assert.rejects(executeHyperFramesJobs(projectDir, result.executionContract, {run: mediaRun()}), /immutable.*artifact reference/i);
  const run = mediaRun();
  let calls = 0;
  await assert.rejects(executeHyperFramesJobs(projectDir, result, {run: async (command, args, options) => {
    if (command === "/usr/bin/env" && ++calls === 2) return {code: 1, signal: null, truncated: false, stderr: "failed", stdout: ""};
    return run(command, args, options);
  }}), /HyperFrames job failed/u);
  await assert.rejects(access(join(projectDir, result.executionContract.hyperframes[0].outputPath)));
});

test("HyperFrames failure preserves a pre-existing sidecar it did not publish", async () => {
  const {projectDir, input} = await fixture({workItemId: "preexisting"});
  const execution = await createVideoExecutionContract(projectDir, input);
  await transitionWorkItem(projectDir, coordinator, {workItemId: "preexisting", to: "EXECUTING", reason: "execute",
    artifactRef: {id: execution.artifactRef.artifactId, sha256: execution.artifactRef.sha256}});
  const existingPath = join(projectDir, execution.executionContract.hyperframes[0].outputPath);
  await writeFile(existingPath, "existing sidecar", {flag: "wx"});
  await assert.rejects(executeHyperFramesJobs(projectDir, execution, {run: mediaRun()}));
  assert.equal(await readFile(existingPath, "utf8"), "existing sidecar");
});

test("HyperFrames execution rejects dependency-closure drift before rendering", async () => {
  const {projectDir, input} = await fixture({workItemId: "closure-drift"});
  const execution = await createVideoExecutionContract(projectDir, input);
  await transitionWorkItem(projectDir, coordinator, {workItemId: "closure-drift", to: "EXECUTING", reason: "execute",
    artifactRef: {id: execution.artifactRef.artifactId, sha256: execution.artifactRef.sha256}});
  await assert.rejects(executeHyperFramesJobs(projectDir, execution, {run: mediaRun(), readPackFile: async (path) => {
    const bytes = await readFile(path);
    return path.endsWith("sunburst.css") ? Buffer.concat([bytes, Buffer.from("changed")]) : bytes;
  }}), /dependency closure changed/u);
  for (const job of execution.executionContract.hyperframes) await assert.rejects(access(join(projectDir, job.outputPath)));
});

test("alpha evidence rejects an effectively opaque 254-to-255 channel", async () => {
  const {projectDir, input} = await fixture({workItemId: "opaque"});
  const execution = await createVideoExecutionContract(projectDir, input);
  await transitionWorkItem(projectDir, coordinator, {workItemId: "opaque", to: "EXECUTING", reason: "execute",
    artifactRef: {id: execution.artifactRef.artifactId, sha256: execution.artifactRef.sha256}});
  const base = mediaRun();
  await assert.rejects(executeHyperFramesJobs(projectDir, execution, {run: async (command, args, options) => {
    if (command === "ffmpeg" && args.includes("alphaextract,signalstats,metadata=print:file=-")) {
      return {code: 0, signal: null, truncated: false, stderr: "", stdout: "lavfi.signalstats.YMIN=254\nlavfi.signalstats.YMAX=255\n"};
    }
    return base(command, args, options);
  }}), /usable alpha/u);
  for (const job of execution.executionContract.hyperframes) await assert.rejects(access(join(projectDir, job.outputPath)));
});

test("long HyperFrames execution rechecks frozen parents and cleans its output on drift", async () => {
  const {projectDir, input} = await fixture({workItemId: "drift"});
  const execution = await createVideoExecutionContract(projectDir, input);
  await transitionWorkItem(projectDir, coordinator, {workItemId: "drift", to: "EXECUTING", reason: "execute",
    artifactRef: {id: execution.artifactRef.artifactId, sha256: execution.artifactRef.sha256}});
  const base = mediaRun();
  let changed = false;
  await assert.rejects(executeHyperFramesJobs(projectDir, execution, {run: async (command, args, options) => {
    const result = await base(command, args, options);
    if (command === "/usr/bin/env" && !changed) {
      changed = true;
      await writeFile(join(projectDir, "Source/source-a.mov"), "changed source bytes");
    }
    return result;
  }}), /dependency.*changed|frozen bytes changed/iu);
  for (const job of execution.executionContract.hyperframes) await assert.rejects(access(join(projectDir, job.outputPath)));
});

test("final execution recheck rolls back every newly published sidecar and preserves foreign output", async () => {
  const {projectDir, input} = await fixture({workItemId: "final-drift"});
  const execution = await createVideoExecutionContract(projectDir, input);
  await transitionWorkItem(projectDir, coordinator, {workItemId: "final-drift", to: "EXECUTING", reason: "execute",
    artifactRef: {id: execution.artifactRef.artifactId, sha256: execution.artifactRef.sha256}});
  const foreignPath = join(projectDir, "Renders/Shots/foreign.mov");
  await writeFile(foreignPath, "foreign bytes", {flag: "wx"});
  let reads = 0;
  await assert.rejects(executeHyperFramesJobs(projectDir, execution, {run: mediaRun(), readWorkflowState: async (root) => {
    const state = await readWorkflowState(root);
    reads += 1;
    if (reads === 4) state.workItems.find(({id}) => id === "final-drift").state = "DESIGN_APPROVED";
    return state;
  }}), /workflow must be EXECUTING/u);
  for (const job of execution.executionContract.hyperframes) await assert.rejects(access(join(projectDir, job.outputPath)));
  assert.equal(await readFile(foreignPath, "utf8"), "foreign bytes");
});

test("render preserves its frozen public pack snapshot while live pack mutates and restores", async () => {
  const {projectDir, input} = await fixture({workItemId: "pack-race", singleHyperframesJob: true});
  const execution = await createVideoExecutionContract(projectDir, input);
  await transitionWorkItem(projectDir, coordinator, {workItemId: "pack-race", to: "EXECUTING", reason: "execute",
    artifactRef: {id: execution.artifactRef.artifactId, sha256: execution.artifactRef.sha256}});
  const livePack = await mkdtemp(join(tmpdir(), "content-hub-live-pack-"));
  const sourcePack = join(import.meta.dirname, "../../../../templates/hyperframes");
  for (const dependency of execution.executionContract.hyperframesDependencyClosure) {
    const target = join(livePack, dependency.path);
    await mkdir(dirname(target), {recursive: true});
    await writeFile(target, await readFile(join(sourcePack, dependency.path)), {flag: "wx"});
  }
  const liveComposition = join(livePack, "compositions/video-shot-layered-portrait.html");
  const original = await readFile(liveComposition);
  let snapshotRoot;
  const base = mediaRun();
  const outputs = await executeHyperFramesJobs(projectDir, execution, {packRoot: livePack, run: async (command, args, options) => {
    if (command === "/usr/bin/env") {
      const composition = args.find((value) => value.endsWith("/compositions/video-shot-layered-portrait.html"));
      snapshotRoot = composition.slice(0, -"/compositions/video-shot-layered-portrait.html".length);
      assert.notEqual(snapshotRoot, livePack);
      assert.equal(digest(await readFile(composition)), execution.executionContract.hyperframes[0].compositionSha256);
      await writeFile(liveComposition, "mutated live pack");
      assert.equal(digest(await readFile(composition)), execution.executionContract.hyperframes[0].compositionSha256);
      await writeFile(liveComposition, original);
      await writeFile(join(snapshotRoot, "foreign.txt"), "foreign");
    }
    return base(command, args, options);
  }});
  assert.equal(outputs.length, 1);
  await access(snapshotRoot);
  assert.equal(await readFile(join(snapshotRoot, "foreign.txt"), "utf8"), "foreign");
  assert.equal(digest(await readFile(liveComposition)), execution.executionContract.hyperframes[0].compositionSha256);
});

test("successful render never asks cleanup to remove its frozen pack snapshot", async () => {
  const {projectDir, input} = await fixture({workItemId: "pack-no-cleanup", singleHyperframesJob: true});
  const execution = await createVideoExecutionContract(projectDir, input);
  await transitionWorkItem(projectDir, coordinator, {workItemId: "pack-no-cleanup", to: "EXECUTING", reason: "execute",
    artifactRef: {id: execution.artifactRef.artifactId, sha256: execution.artifactRef.sha256}});
  let snapshotRoot, cleanupPaths = [];
  await executeHyperFramesJobs(projectDir, execution, {run: async (command, args, options) => {
    if (command === "/usr/bin/env") {
      const composition = args.find((value) => value.endsWith("/compositions/video-shot-layered-portrait.html"));
      snapshotRoot = composition.slice(0, -"/compositions/video-shot-layered-portrait.html".length);
    }
    return mediaRun()(command, args, options);
  }, removeOwnedStage: async (root, path, owner) => {
    cleanupPaths.push(path);
    return removeOwnedStage(root, path, owner);
  }});
  assert.equal(cleanupPaths.some((path) => path.includes("hf-pack")), false);
  await access(snapshotRoot);
});

test("construction failure preserves its frozen pack snapshot without invoking cleanup", async () => {
  const {projectDir, input} = await fixture({workItemId: "pack-construction-preserved", singleHyperframesJob: true});
  const execution = await createVideoExecutionContract(projectDir, input);
  await transitionWorkItem(projectDir, coordinator, {workItemId: "pack-construction-preserved", to: "EXECUTING", reason: "execute",
    artifactRef: {id: execution.artifactRef.artifactId, sha256: execution.artifactRef.sha256}});
  const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("content-hub-hf-pack-")));
  let snapshotRoot, configReads = 0, cleanupCalls = 0;
  await assert.rejects(executeHyperFramesJobs(projectDir, execution, {
    run: mediaRun(),
    readPackFile: async (path) => {
      if (path.endsWith("/hyperframes.json") && ++configReads === 2) {
        const created = (await readdir(tmpdir())).find((name) => name.startsWith("content-hub-hf-pack-") && !before.has(name));
        snapshotRoot = join(tmpdir(), created);
        await writeFile(join(snapshotRoot, "foreign.txt"), "foreign");
        throw new Error("injected snapshot construction failure");
      }
      return readFile(path);
    },
    removeOwnedStage: async () => { cleanupCalls += 1; return false; },
  }), /injected snapshot construction failure/u);
  assert.equal(cleanupCalls, 0);
  assert.equal(await readFile(join(snapshotRoot, "foreign.txt"), "utf8"), "foreign");
});

test("Premiere ignores mutation return values and rejects incomplete independent readback", async () => {
  const {projectDir, input} = await fixture({workItemId: "forged-readback"});
  const execution = await createVideoExecutionContract(projectDir, input);
  await transitionWorkItem(projectDir, coordinator, {workItemId: "forged-readback", to: "EXECUTING", reason: "execute",
    artifactRef: {id: execution.artifactRef.artifactId, sha256: execution.artifactRef.sha256}});
  const run = mediaRun();
  await executeHyperFramesJobs(projectDir, execution, {run});
  await assert.rejects(executePremiereAssembly(projectDir, execution, {
    execute: async ({outputPath}) => {
      await writeFile(outputPath, "master bytes", {flag: "wx"});
      return {sequence: {sequenceId: "forged"}, clips: []};
    },
    readback: async () => ({sequence: {sequenceId: "incomplete"}, clips: []}),
  }, {run}), /does not prove the exact sequence/u);
  await assert.rejects(access(join(projectDir, execution.executionContract.premiere.masterPath)));
  await assert.rejects(access(join(projectDir, execution.executionContract.premiere.readbackPath)));
});

test("Premiere rechecks design approval after waiting for the global writer lock", async () => {
  const {projectDir, input} = await fixture({workItemId: "approval-wait"});
  const execution = await createVideoExecutionContract(projectDir, input);
  await transitionWorkItem(projectDir, coordinator, {workItemId: "approval-wait", to: "EXECUTING", reason: "execute",
    artifactRef: {id: execution.artifactRef.artifactId, sha256: execution.artifactRef.sha256}});
  const run = mediaRun();
  await executeHyperFramesJobs(projectDir, execution, {run});
  let mutated = false, released = false;
  await assert.rejects(executePremiereAssembly(projectDir, execution, {execute: async () => { mutated = true; }, readback: async () => ({})}, {
    run,
    acquireProjectLock: async (_root, path) => {
      assert.equal(path, ".premiere-writer.lock");
      await recordApproval(projectDir, coordinator, {kind: "design", workItemId: "approval-wait", subject: input.designPlanRef,
        decision: "rejected", approver: {actorId: "design-review-01", role: "design-approver"}, producerActorId: "design-01",
        origin: "bizibeast", policyVersion: "bizibeast-v1"});
      return {release: async () => { released = true; }};
    },
  }), /current exact-hash approved design plan/u);
  assert.equal(mutated, false);
  assert.equal(released, true);
});

test("Premiere rejects forged unchained and reordered focused mutation snapshots", async () => {
  const {projectDir, input} = await fixture({workItemId: "snapshot-chain"});
  const execution = await createVideoExecutionContract(projectDir, input);
  await transitionWorkItem(projectDir, coordinator, {workItemId: "snapshot-chain", to: "EXECUTING", reason: "execute",
    artifactRef: {id: execution.artifactRef.artifactId, sha256: execution.artifactRef.sha256}});
  const run = mediaRun();
  const sidecars = await executeHyperFramesJobs(projectDir, execution, {run});
  const variants = [
    (readback) => { readback.mutationSnapshots[0].after.sha256 = "f".repeat(64); },
    (readback) => {
      const state = {sequenceId: "sequence-001", applied: ["different"]};
      readback.mutationSnapshots[1].before = {state, sha256: sha256Value(state)};
    },
    (readback) => { [readback.mutationSnapshots[0].actionId, readback.mutationSnapshots[1].actionId]
      = [readback.mutationSnapshots[1].actionId, readback.mutationSnapshots[0].actionId]; },
  ];
  for (const mutate of variants) {
    await assert.rejects(executePremiereAssembly(projectDir, execution, {
      execute: async ({outputPath}) => writeFile(outputPath, "master bytes", {flag: "wx"}),
      readback: async (query) => {
        const readback = readbackFor(execution, sidecars, query);
        mutate(readback);
        return readback;
      },
    }, {run}), /does not prove the exact sequence/u);
    await assert.rejects(access(join(projectDir, execution.executionContract.premiere.masterPath)));
  }
});

test("candidate freeze rejects a decoded master without Premiere readback", async () => {
  const {projectDir, input} = await fixture({workItemId: "missing-readback"});
  const execution = await createVideoExecutionContract(projectDir, input);
  await transitionWorkItem(projectDir, coordinator, {workItemId: "missing-readback", to: "EXECUTING", reason: "execute",
    artifactRef: {id: execution.artifactRef.artifactId, sha256: execution.artifactRef.sha256}});
  const run = mediaRun();
  await executeHyperFramesJobs(projectDir, execution, {run});
  await mkdir(join(projectDir, "Renders/Candidates/missing-readback/v001"), {recursive: true});
  await writeFile(join(projectDir, execution.executionContract.premiere.masterPath), "master bytes");
  const inputLock = {...input.inputLock, artifacts: [...input.inputLock.artifacts,
    {id: execution.artifactRef.artifactId, sha256: execution.artifactRef.sha256}]};
  await assert.rejects(freezeVideoCandidate(projectDir, coordinator, {workItemId: "missing-readback", modality: "raw-video", revision: 1,
    executionArtifactRef: execution.artifactRef, inputLock, requestedDerivatives: []}, {run}), /exact immutable Premiere readback/u);
});

test("candidate post-check failure removes only its owned bundle and retry succeeds", async () => {
  const {projectDir, run, candidateInput} = await completedFixture("candidate-retry");
  await assert.rejects(freezeVideoCandidate(projectDir, coordinator, candidateInput, {
    run, verifyCandidateBundle: async () => { throw new Error("post-check failed"); },
  }), /post-check failed/u);
  const bundlePath = join(projectDir, "Renders/Candidates/candidate-retry/v001/bundle.json");
  await assert.rejects(access(bundlePath));
  const retried = await freezeVideoCandidate(projectDir, coordinator, candidateInput, {run});
  assert.equal(retried.bundle.bundleHash.length, 64);
  await access(bundlePath);
});

test("candidate freezer failure preserves an unowned exposed bundle path", async () => {
  const {projectDir, run, candidateInput} = await completedFixture("candidate-foreign");
  const bundlePath = join(projectDir, "Renders/Candidates/candidate-foreign/v001/bundle.json");
  await assert.rejects(freezeVideoCandidate(projectDir, coordinator, candidateInput, {run,
    freezeCandidateBundle: async () => {
      await writeFile(bundlePath, "foreign writer bytes", {flag: "wx"});
      throw new Error("foreign freezer failed");
    },
  }), /foreign freezer failed/u);
  assert.equal(await readFile(bundlePath, "utf8"), "foreign writer bytes");
});

test("one Premiere writer applies exact V1-V4 mutations and freezes the verified candidate", async () => {
  const {projectDir, input} = await fixture({workItemId: "candidate"});
  const execution = await createVideoExecutionContract(projectDir, input);
  await transitionWorkItem(projectDir, coordinator, {workItemId: "candidate", to: "EXECUTING", reason: "execute",
    artifactRef: {id: execution.artifactRef.artifactId, sha256: execution.artifactRef.sha256}});
  const run = mediaRun();
  await executeHyperFramesJobs(projectDir, execution, {run});
  let active = 0, maximum = 0;
  let observedSidecars;
  const adapter = {
    execute: async ({outputPath, sidecars}) => {
      active += 1; maximum = Math.max(maximum, active);
      try {
        assert.match(outputPath, /Renders\/Candidates\/candidate\/\.premiere-v001-[^/]+\/master\.mov$/u);
        observedSidecars = sidecars;
        await writeFile(outputPath, "master bytes", {flag: "wx"});
      } finally { active -= 1; }
    },
    readback: async (query) => {
      assert.equal(Object.hasOwn(query, "expectedClips"), false);
      return readbackFor(execution, observedSidecars, query);
    },
  };
  const [first, second] = await Promise.allSettled([executePremiereAssembly(projectDir, execution, adapter, {run}), executePremiereAssembly(projectDir, execution, adapter, {run})]);
  assert.equal([first, second].filter(({status}) => status === "fulfilled").length, 1);
  assert.equal([first, second].filter(({status}) => status === "rejected").length, 1);
  assert.equal(maximum, 1);
  const completed = [first, second].find(({status}) => status === "fulfilled").value;
  assert.deepEqual(completed.artifact.payload.clips.map(({trackIndex}) => trackIndex), [1, 2, 4, 1]);
  assert.ok(completed.artifact.payload.clips.every(({handles}) => handles.inMs >= 40 && handles.outMs >= 40));

  const script = await store(projectDir, "Plans/Scripts/candidate/script-v001.json", {artifactId: "script-candidate-v001", workItemId: "candidate",
    modality: "raw-video", parents: [], producer: {actorId: "script-01", role: "script-editorial"}, deviations: [], payload: {kind: "script"}});
  const scriptApproval = await recordApproval(projectDir, coordinator, {kind: "script", workItemId: "candidate", subject: script.ref, decision: "approved",
    approver: {actorId: "human-yash", role: "human"}, origin: "user", policyVersion: "bizibeast-v1"});
  const inputLock = {artifacts: [...input.inputLock.artifacts, {id: execution.artifactRef.artifactId, sha256: execution.artifactRef.sha256},
    {id: completed.artifactRef.artifactId, sha256: completed.artifactRef.sha256},
    {id: script.ref.artifactId, sha256: script.ref.sha256}], approvals: [...input.inputLock.approvals, {id: scriptApproval.id, subjectSha256: script.ref.sha256}], assets: input.inputLock.assets};
  const frozen = await freezeVideoCandidate(projectDir, coordinator, {workItemId: "candidate", modality: "raw-video", revision: 1,
    executionArtifactRef: execution.artifactRef,
    outputs: [{path: execution.executionContract.premiere.masterPath, kind: "master", order: 1},
      {path: execution.executionContract.premiere.readbackPath, kind: "premiere-readback", order: 2}],
    inputLock, lineage: {forged: true}, versions: {forged: true}, requestedDerivatives: ["mov"]}, {run});
  assert.match(frozen.bundle.bundlePath, /Renders\/Candidates\/candidate\/v001\/bundle\.json$/u);
  assert.equal(frozen.bundle.modality, "raw-video");
  assert.equal(frozen.bundle.producer.actorId, "premiere-01");
  assert.equal(frozen.bundle.files.length, 1);
  assert.equal(frozen.bundle.versions.tool, versions.tool);
  assert.equal(frozen.bundle.lineage.premiereReadback.sha256, completed.artifactRef.sha256);
  assert.equal(Object.hasOwn(frozen.bundle.lineage, "forged"), false);
  await assert.rejects(freezeVideoCandidate(projectDir, coordinator, {workItemId: "candidate", modality: "raw-video", revision: 1,
    executionArtifactRef: execution.artifactRef,
    inputLock: {...inputLock, artifacts: inputLock.artifacts.filter(({id}) => id !== completed.artifactRef.artifactId)}, requestedDerivatives: []}, {run}), /input lock is stale/u);
});
