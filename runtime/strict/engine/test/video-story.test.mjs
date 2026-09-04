import assert from "node:assert/strict";
import {mkdtemp, readFile, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {sha256File} from "../src/checksum.mjs";
import {mutateManifest} from "../src/manifest.mjs";
import {createProject} from "../src/project.mjs";
import {hashFileNoFollow} from "../src/release-fs.mjs";
import {createMediaIndex} from "../src/video-media-index.mjs";
import {buildSilencePlan, createStoryPlan, detectWaveformSilence, validateStorySegments} from "../src/video-story.mjs";
import {transcribeIndexedSources} from "../src/video-transcripts.mjs";
import {createWorkItem, transitionProject, transitionWorkItem} from "../src/workflow.mjs";

const word = (id, startMs, endMs) => ({id, text: id, startMs, endMs});

test("compresses an unmarked 300ms gap to 130ms without touching speech", () => {
  const plan = buildSilencePlan({
    durationMs: 1300,
    words: [word("s:w000001", 100, 500), word("s:w000002", 800, 1100)],
    waveformSilence: [{startMs: 510, endMs: 790}], vadSpeech: [], markedPauses: [],
  });
  assert.deepEqual(plan.operations[0], {
    kind: "compress-gap", afterWordId: "s:w000001", beforeWordId: "s:w000002", originalGapMs: 300,
    targetGapMs: 130, removeStartMs: 565, removeEndMs: 735, leftSpeechHandleMs: 65,
    rightSpeechHandleMs: 65, removedMs: 170,
  });
});

test("preserves a marked 700ms dramatic pause with its reason", () => {
  const plan = buildSilencePlan({
    durationMs: 1800,
    words: [word("s:w000001", 100, 500), word("s:w000002", 1200, 1500)],
    waveformSilence: [{startMs: 510, endMs: 1190}], vadSpeech: [],
    markedPauses: [{afterWordId: "s:w000001", beforeWordId: "s:w000002", reason: "Let the price reveal land"}],
  });
  assert.equal(plan.operations[0].kind, "preserve-dramatic-pause");
  assert.equal(plan.operations[0].reason, "Let the price reveal land");
});

test("only cuts word gaps at 240ms with waveform evidence and no VAD speech", () => {
  const input = (gapMs, waveformSilence, vadSpeech = []) => ({durationMs: 1500,
    words: [word("s:w000001", 100, 500), word("s:w000002", 500 + gapMs, 1300)], waveformSilence, vadSpeech, markedPauses: []});
  assert.equal(buildSilencePlan(input(239, [{startMs: 500, endMs: 739}])).operations.length, 0);
  assert.equal(buildSilencePlan(input(240, [{startMs: 550, endMs: 690}])).operations[0].targetGapMs, 130);
  assert.equal(buildSilencePlan(input(300, [])).operations.length, 0);
  assert.equal(buildSilencePlan(input(300, [{startMs: 565, endMs: 735}], [{startMs: 600, endMs: 620}])).operations.length, 0);
  for (const targetGapMs of [120, 140]) {
    const plan = buildSilencePlan(input(300, [{startMs: 560, endMs: 740}]), {targetGapMs});
    assert.equal(plan.operations[0].targetGapMs, targetGapMs);
    assert.ok(plan.operations[0].leftSpeechHandleMs >= 40);
    assert.ok(plan.operations[0].rightSpeechHandleMs >= 40);
  }
});

test("rejects a one-millisecond waveform overlap that does not contain the proposed cut", () => {
  const plan = buildSilencePlan({durationMs: 1300, words: [word("s:w000001", 100, 500), word("s:w000002", 800, 1100)],
    waveformSilence: [{startMs: 564, endMs: 566}], vadSpeech: [], markedPauses: []});
  assert.equal(plan.operations.length, 0);
});

test("does not trim leading or trailing silence when waveform evidence disagrees", () => {
  const plan = buildSilencePlan({durationMs: 1300, words: [word("s:w000001", 300, 500), word("s:w000002", 650, 900)],
    waveformSilence: [{startMs: 259, endMs: 261}, {startMs: 939, endMs: 941}], vadSpeech: [], markedPauses: []});
  assert.deepEqual(plan.operations, []);
});

test("splits odd target gaps into deterministic integer speech handles", () => {
  const plan = buildSilencePlan({durationMs: 1300, words: [word("s:w000001", 100, 500), word("s:w000002", 800, 1100)],
    waveformSilence: [{startMs: 560, endMs: 740}], vadSpeech: [], markedPauses: []}, {targetGapMs: 121});
  assert.deepEqual(plan.operations[0], {kind: "compress-gap", afterWordId: "s:w000001", beforeWordId: "s:w000002", originalGapMs: 300,
    targetGapMs: 121, removeStartMs: 560, removeEndMs: 739, leftSpeechHandleMs: 60, rightSpeechHandleMs: 61, removedMs: 179});
  assert.ok(Object.values(plan.operations[0]).filter((value) => typeof value === "number").every(Number.isInteger));
});

test("trims waveform-confirmed leading and trailing silence but keeps handles", () => {
  const plan = buildSilencePlan({durationMs: 1400, words: [word("s:w000001", 300, 500), word("s:w000002", 850, 1000)],
    waveformSilence: [{startMs: 0, endMs: 270}, {startMs: 565, endMs: 785}, {startMs: 1030, endMs: 1400}], vadSpeech: [], markedPauses: []});
  assert.deepEqual(plan.operations.map(({kind}) => kind), ["trim-leading-silence", "compress-gap", "trim-trailing-silence"]);
  assert.equal(plan.operations[0].retainedMs, 40);
  assert.equal(plan.operations.at(-1).retainedMs, 40);
});

test("uses FFmpeg argument arrays and rejects unpaired waveform output", async () => {
  const calls = [];
  const intervals = await detectWaveformSilence("/safe/source.mov", async (command, args) => {
    calls.push([command, args]);
    return {code: 0, truncated: false, stdout: "", stderr: "silence_start: 0.12\nsilence_end: 0.38 | silence_duration: 0.26"};
  });
  assert.deepEqual(calls[0], ["ffmpeg", ["-hide_banner", "-nostats", "-i", "/safe/source.mov", "-af", "silencedetect=noise=-42dB:d=0.12", "-vn", "-f", "null", "-"]]);
  assert.deepEqual(intervals, [{startMs: 120, endMs: 380}]);
  await assert.rejects(detectWaveformSilence("/safe/source.mov", async () => ({code: 0, truncated: false, stderr: "silence_start: 0.2"})), /incomplete/u);
});

test("requires source hashes and an exact contiguous transcript-backed range", () => {
  const transcripts = [{sourceId: "s", sourceSha256: "a".repeat(64), durationMs: 700, timeBase: "source-relative-ms", words: [word("s:w000001", 0, 200), word("s:w000002", 250, 500), word("s:w000003", 550, 700)]}];
  const [segment] = validateStorySegments([{id: "hook", sourceId: "s", sourceSha256: "a".repeat(64), sourceInMs: 0, sourceOutMs: 700,
    firstWordId: "s:w000001", lastWordId: "s:w000003", timelineInMs: 0, purpose: "Hook"}], transcripts);
  assert.deepEqual(segment.wordIds, ["s:w000001", "s:w000002", "s:w000003"]);
  assert.throws(() => validateStorySegments([{...segment, wordIds: ["s:w000001", "s:w000003"]}], transcripts), /contiguous/u);
  assert.throws(() => validateStorySegments([{...segment, sourceSha256: "b".repeat(64)}], transcripts), /hash/u);
});

test("rejects malformed loaded transcript timing before selecting a segment", () => {
  const bad = [{sourceId: "s", sourceSha256: "a".repeat(64), durationMs: 700, timeBase: "source-relative-ms",
    words: [word("s:w000001", 0, 300), word("s:w000002", 250, 800)]}];
  assert.throws(() => validateStorySegments([{id: "hook", sourceId: "s", sourceSha256: "a".repeat(64), sourceInMs: 0, sourceOutMs: 700,
    firstWordId: "s:w000001", lastWordId: "s:w000002", timelineInMs: 0, purpose: "Hook"}], bad), /timing|duration|ordered|integer/u);
});

const coordinator = {actorId: "content-hub-coordinator", actorRole: "coordinator"};
const producer = {actorId: "story-1", role: "story-editor"};
const technician = {actorId: "media-1", role: "local-media-technician"};
const parent = {artifactId: "brief-001", sha256: "b".repeat(64)};
const versions = {tool: "content-hub@0.2.0", template: null, model: null, policy: "bizibeast-v1"};

function probe() {
  return {durationSeconds: 1.2, formatName: "mov,mp4,m4a,3gp,3g2,mj2", video: [{codec_name: "h264", width: 1080, height: 1920, avg_frame_rate: "30/1"}], audio: [{codec_name: "aac", sample_rate: "48000", channels: 2}], raw: {format: {tags: {}}, streams: []}};
}

async function storyFixture() {
  const root = await mkdtemp(join(tmpdir(), "content-hub-story-"));
  const {projectDir} = await createProject(root, {name: "Story", editors: ["premiere"]});
  const path = join(projectDir, "Source", "camera.mov");
  await writeFile(path, "source-video");
  await mutateManifest(projectDir, coordinator, async (manifest) => ({...manifest, sources: [{id: "source-camera", kind: "source", path: "Source/camera.mov", sha256: await sha256File(path), bytes: (await stat(path)).size, createdAt: "2026-09-01T00:00:00Z"}]}));
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief frozen"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "ready"});
  await createWorkItem(projectDir, coordinator, {id: "raw-001", title: "Raw", modality: "raw-video"});
  const indexed = await createMediaIndex(projectDir, {workItemId: "raw-001", revision: 1, modality: "raw-video", producer: technician, versions, parents: [parent]}, {probe: async () => probe()});
  const transcripted = await transcribeIndexedSources(projectDir, {workItemId: "raw-001", revision: 1, modality: "raw-video", producer: technician, mediaIndexArtifactRef: indexed.artifactRef, currentParents: [parent], parakeetModelRevision: "parakeet-test", versions}, {run: async (_command, args) => {
    await writeFile(join(args[1], "words.json"), JSON.stringify({words: [{word: "Open", start: 0.1, end: 0.4}, {word: "now", start: 0.7, end: 1}]}));
    return {code: 0, stdout: "", stderr: ""};
  }});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "raw-001", to: "MEDIA_INDEXED", reason: "indexed"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "raw-001", to: "TRANSCRIPTS_READY", reason: "transcribed"});
  return {projectDir, indexed, transcripted};
}

function storyInput(indexed, transcripted, overrides = {}) {
  const source = indexed.index.sources[0];
  return {workItemId: indexed.artifact.workItemId, revision: 1, modality: "raw-video", producer, versions, currentParents: [parent],
    mediaIndexArtifactRef: indexed.artifactRef, transcriptArtifactRefs: transcripted.artifactRefs,
    segments: [{id: "hook", sourceId: source.id, sourceSha256: source.sha256, sourceInMs: 100, sourceOutMs: 1000,
      firstWordId: `${source.id}:w000001`, lastWordId: `${source.id}:w000002`, timelineInMs: 0, purpose: "Open fast"}], ...overrides};
}

test("publishes a hash-bound editorial reorder with chronological audit and one-second hook", async () => {
  const {projectDir, indexed, transcripted} = await storyFixture();
  const source = indexed.index.sources[0];
  const result = await createStoryPlan(projectDir, storyInput(indexed, transcripted), {run: async () => ({code: 0, truncated: false, stderr: "silence_start: 0.42\nsilence_end: 0.68"})});
  assert.equal(result.storyPlan.hook.timelineInMs, 0);
  assert.deepEqual(result.storyPlan.chronologicalAudit.map(({id}) => id), ["hook"]);
  assert.equal(JSON.parse(await readFile(join(projectDir, "Plans", "Stories", "raw-001", "story-plan-v001.json"), "utf8")).artifactId, result.artifact.artifactId);
  await assert.rejects(createStoryPlan(projectDir, storyInput(indexed, transcripted, {segments: [{id: "late", sourceId: source.id, sourceSha256: source.sha256, sourceInMs: 100, sourceOutMs: 1000, firstWordId: `${source.id}:w000001`, lastWordId: `${source.id}:w000002`, timelineInMs: 1001, purpose: "Late"}]}), {run: async () => ({code: 0, truncated: false, stderr: ""})}), /TRANSCRIPTS_READY|hook/u);
});

test("publishes v001 independently under each work item story path", async () => {
  const {projectDir, indexed, transcripted} = await storyFixture();
  const first = await createStoryPlan(projectDir, storyInput(indexed, transcripted), {run: async () => ({code: 0, truncated: false, stderr: "silence_start: 0.42\nsilence_end: 0.68"})});
  await createWorkItem(projectDir, coordinator, {id: "raw-002", title: "Second raw", modality: "raw-video"});
  const secondIndex = await createMediaIndex(projectDir, {workItemId: "raw-002", revision: 1, modality: "raw-video", producer: technician, versions, parents: [parent]}, {probe: async () => probe()});
  const secondTranscripts = await transcribeIndexedSources(projectDir, {workItemId: "raw-002", revision: 1, modality: "raw-video", producer: technician,
    mediaIndexArtifactRef: secondIndex.artifactRef, currentParents: [parent], parakeetModelRevision: "parakeet-test", versions}, {run: async (_command, args) => {
    await writeFile(join(args[1], "words.json"), JSON.stringify({words: [{word: "Second", start: 0.1, end: 0.4}, {word: "hook", start: 0.7, end: 1}]}));
    return {code: 0, stdout: "", stderr: ""};
  }});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "raw-002", to: "MEDIA_INDEXED", reason: "indexed"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "raw-002", to: "TRANSCRIPTS_READY", reason: "transcribed"});
  const second = await createStoryPlan(projectDir, storyInput(secondIndex, secondTranscripts), {run: async () => ({code: 0, truncated: false, stderr: "silence_start: 0.42\nsilence_end: 0.68"})});
  assert.notEqual(first.artifactRef.sha256, second.artifactRef.sha256);
  await Promise.all(["raw-001", "raw-002"].map((workItemId) => readFile(join(projectDir, "Plans", "Stories", workItemId, "story-plan-v001.json"))));
});

test("rejects an invalidated parent before waveform work begins", async () => {
  const {projectDir, indexed, transcripted} = await storyFixture();
  const calls = [];
  await assert.rejects(createStoryPlan(projectDir, storyInput(indexed, transcripted, {currentParents: [{...parent, sha256: "c".repeat(64)}]}), {
    run: async (...args) => calls.push(args),
  }), /parent hash changed/u);
  assert.deepEqual(calls, []);
});

test("removes only its owned story artifact after post-write verification fails", async () => {
  const {projectDir, indexed, transcripted} = await storyFixture();
  let failed = false;
  await assert.rejects(createStoryPlan(projectDir, storyInput(indexed, transcripted), {
    run: async () => ({code: 0, truncated: false, stderr: "silence_start: 0.42\nsilence_end: 0.68"}),
    hashNoFollow: async (root, path) => {
      const stored = await hashFileNoFollow(root, path);
      if (!failed && path === "Plans/Stories/raw-001/story-plan-v001.json") {
        failed = true;
        throw new Error("deterministic story verification failure");
      }
      return stored;
    },
  }), /story verification failure/u);
  await assert.rejects(readFile(join(projectDir, "Plans", "Stories", "raw-001", "story-plan-v001.json")), {code: "ENOENT"});
});
