import assert from "node:assert/strict";
import {mkdtemp, readFile, rename, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, join} from "node:path";
import test from "node:test";

import {sha256File} from "../src/checksum.mjs";
import {mutateManifest} from "../src/manifest.mjs";
import {createProject} from "../src/project.mjs";
import {hashFileNoFollow, removeOwnedFile} from "../src/release-fs.mjs";
import {canonicalizeSourceTranscript, transcribeIndexedSources} from "../src/video-transcripts.mjs";
import {createMediaIndex} from "../src/video-media-index.mjs";

const coordinator = {actorId: "content-hub-coordinator", actorRole: "coordinator"};
const parent = {artifactId: "brief-001", sha256: "b".repeat(64)};
const producer = {actorId: "media-01", role: "local-media-technician"};

function probe() {
  return {
    durationSeconds: 1.2,
    formatName: "mov,mp4,m4a,3gp,3g2,mj2",
    video: [{codec_name: "h264", width: 1080, height: 1920, avg_frame_rate: "30/1"}],
    audio: [{codec_name: "aac", sample_rate: "48000", channels: 2}],
    raw: {format: {tags: {}}, streams: []},
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "content-hub-video-transcripts-"));
  const {projectDir} = await createProject(root, {name: "Transcripts", editors: ["premiere"]});
  const paths = [join(projectDir, "Source", "clip-a.mov"), join(projectDir, "Source", "clip-b.mov")];
  await Promise.all(paths.map((path, index) => writeFile(path, `video-${index}`)));
  const sources = await Promise.all(paths.map(async (path, index) => ({
    id: `source-${index + 1}`,
    kind: "source",
    path: `Source/clip-${index ? "b" : "a"}.mov`,
    sha256: await sha256File(path),
    bytes: (await stat(path)).size,
    createdAt: "2026-09-01T00:00:00Z",
  })));
  await mutateManifest(projectDir, coordinator, (manifest) => ({...manifest, sources}));
  const indexed = await createMediaIndex(projectDir, {
    workItemId: "raw-001", revision: 1, modality: "multi-clip", producer,
    versions: {tool: "content-hub@0.2.0", template: null, model: null, policy: "bizibeast-v1"}, parents: [parent],
  }, {probe: async () => probe()});
  return {projectDir, indexed, paths};
}

function input(indexed, workItemId = "raw-001") {
  return {
    workItemId, revision: 1, modality: "multi-clip", producer, mediaIndexArtifactRef: indexed.artifactRef,
    currentParents: [parent], parakeetModelRevision: "parakeet-test",
    versions: {tool: "content-hub@0.2.0", template: null, model: null, policy: "bizibeast-v1"},
  };
}

test("keeps typed-table transcript words source-relative and bounded", () => {
  const tokens = `[3]{confidence:float,end:float,start:float,text:string}
0.9,0.42,0.12, Open
0.8,0.91,0.46, strong
0.7,1.15,0.91,.`;
  const source = {id: "source-camera-b", sha256: "a".repeat(64), durationSeconds: 1.2};
  const transcript = canonicalizeSourceTranscript({language: "en", sentences: [{tokens}]}, source);

  assert.deepEqual(transcript.words, [
    {id: "source-camera-b:w000001", text: "Open", startMs: 120, endMs: 420, confidence: 0.9},
    {id: "source-camera-b:w000002", text: "strong.", startMs: 460, endMs: 1150, confidence: 0.8},
  ]);
  assert.equal(transcript.timeBase, "source-relative-ms");
  assert.equal(transcript.text, "Open strong.");
  assert.throws(() => canonicalizeSourceTranscript({words: [{text: "late", start: 0, end: 1.251}]}, source), /duration/u);
});

test("transcribes every indexed clip separately with source-relative word IDs", async () => {
  const {projectDir, indexed} = await fixture();
  const calls = [];
  const result = await transcribeIndexedSources(projectDir, input(indexed), {run: async (command, args) => {
    calls.push([command, args]);
    await writeFile(join(args[1], "words.json"), JSON.stringify({words: [
      {word: "Open", start: 0.12, end: 0.42}, {word: "strong.", start: 0.46, end: 0.91},
    ]}));
    return {code: 0, stdout: "", stderr: ""};
  }});

  assert.deepEqual(calls.map(([command]) => basename(command)), ["transcribe.sh", "transcribe.sh"]);
  assert.notEqual(calls[0][1][0], calls[1][1][0]);
  for (const transcript of result.transcripts) {
    assert.deepEqual(transcript.words.map(({id, startMs, endMs}) => ({id, startMs, endMs})), [
      {id: `${transcript.sourceId}:w000001`, startMs: 120, endMs: 420},
      {id: `${transcript.sourceId}:w000002`, startMs: 460, endMs: 910},
    ]);
  }
  assert.ok(result.artifacts.every((artifact) => artifact.parents[0].sha256 === indexed.artifactRef.sha256));
});

test("rejects an invalidated media-index parent before invoking local transcription", async () => {
  const {projectDir, indexed} = await fixture();
  const calls = [];
  await assert.rejects(transcribeIndexedSources(projectDir, {...input(indexed), currentParents: [{...parent, sha256: "c".repeat(64)}]}, {
    run: async (...args) => calls.push(args),
  }), /parent hash changed/u);
  assert.deepEqual(calls, []);
});

test("rejects multiple raw JSON outputs and leaves no transcript artifact", async () => {
  const {projectDir, indexed} = await fixture();
  await assert.rejects(transcribeIndexedSources(projectDir, input(indexed), {run: async (_command, args) => {
    await Promise.all(["first.json", "second.json"].map((name) => writeFile(join(args[1], name), JSON.stringify({words: [{text: "Open", start: 0, end: 0.5}]}))));
    return {code: 0, stdout: "", stderr: ""};
  }}), /exactly one generated transcript JSON/u);
  await assert.rejects(readFile(join(projectDir, "Plans", "Transcripts", "raw-001", "v001", "source-1-v001.json")), {code: "ENOENT"});
});

test("rehashes every source after transcription before publication", async () => {
  const {projectDir, indexed, paths} = await fixture();
  let runs = 0;
  await assert.rejects(transcribeIndexedSources(projectDir, input(indexed), {run: async (_command, args) => {
    runs += 1;
    await writeFile(join(args[1], "words.json"), JSON.stringify({words: [{text: "Open", start: 0, end: 0.5}]}));
    if (runs === 1) {
      const sourceNumber = Number(basename(args[0]).replace("input-source-", ""));
      await writeFile(paths[sourceNumber - 1], "source changed after its snapshot");
    }
    return {code: 0, stdout: "", stderr: ""};
  }}), /changed during transcription/u);
  assert.equal(runs, 2);
  await assert.rejects(readFile(join(projectDir, "Plans", "Transcripts", "raw-001", "v001", "source-1-v001.json")), {code: "ENOENT"});
});

test("publishes the same revision independently for concurrent work items", async () => {
  const {projectDir, indexed} = await fixture();
  const second = await createMediaIndex(projectDir, {
    workItemId: "raw-002", revision: 1, modality: "multi-clip", producer,
    versions: {tool: "content-hub@0.2.0", template: null, model: null, policy: "bizibeast-v1"}, parents: [parent],
  }, {probe: async () => probe()});
  const runner = {run: async (_command, args) => {
    await writeFile(join(args[1], "words.json"), JSON.stringify({words: [{text: "Open", start: 0, end: 0.5}]}));
    return {code: 0, stdout: "", stderr: ""};
  }};
  const [first, other] = await Promise.all([
    transcribeIndexedSources(projectDir, input(indexed), runner),
    transcribeIndexedSources(projectDir, input(second, "raw-002"), runner),
  ]);

  assert.notEqual(first.artifactRefs[0].sha256, other.artifactRefs[0].sha256);
  await Promise.all(["raw-001", "raw-002"].map((workItemId) => readFile(join(projectDir, "Plans", "Transcripts", workItemId, "v001", "source-1-v001.json"))));
});

test("cleans an owned transcript artifact after post-write verification fails and retries", async () => {
  const {projectDir, indexed} = await fixture();
  const run = async (_command, args) => {
    await writeFile(join(args[1], "words.json"), JSON.stringify({words: [{text: "Open", start: 0, end: 0.5}]}));
    return {code: 0, stdout: "", stderr: ""};
  };
  let failed = false;
  await assert.rejects(transcribeIndexedSources(projectDir, input(indexed), {
    run,
    hashNoFollow: async (root, path) => {
      const stored = await hashFileNoFollow(root, path);
      if (!failed && path.startsWith("Plans/Transcripts/raw-001/v001/")) {
        failed = true;
        throw new Error("deterministic post-write verification failure");
      }
      return stored;
    },
  }), /post-write verification failure/u);
  const artifact = join(projectDir, "Plans", "Transcripts", "raw-001", "v001", "source-1-v001.json");
  await assert.rejects(readFile(artifact), {code: "ENOENT"});
  const retry = await transcribeIndexedSources(projectDir, input(indexed), {run});
  assert.equal(retry.artifacts.length, 2);
});

test("preserves a replacement that wins before transcript verification cleanup", async () => {
  const {projectDir, indexed} = await fixture();
  let replaced = false;
  let replacementPath;
  const cleanups = [];
  await assert.rejects(transcribeIndexedSources(projectDir, input(indexed), {
    run: async (_command, args) => {
      await writeFile(join(args[1], "words.json"), JSON.stringify({words: [{text: "Open", start: 0, end: 0.5}]}));
      return {code: 0, stdout: "", stderr: ""};
    },
    hashNoFollow: async (root, path) => {
      const stored = await hashFileNoFollow(root, path);
      if (!replaced && path.startsWith("Plans/Transcripts/raw-001/v001/")) {
        replaced = true;
        replacementPath = path;
        const replacement = join(root, path);
        const stagedReplacement = `${replacement}.replacement`;
        await writeFile(stagedReplacement, "replacement", {flag: "wx"});
        await rename(stagedReplacement, replacement);
        throw new Error("replacement won before verification");
      }
      return stored;
    },
    removeOwnedFile: async (root, path, owner) => {
      const current = await hashFileNoFollow(root, path);
      const removed = await removeOwnedFile(root, path, owner);
      cleanups.push({path, owner, currentOwner: current.owner, removed});
      return removed;
    },
  }), /replacement won/u);
  assert.equal(await readFile(join(projectDir, replacementPath), "utf8"), "replacement");
  assert.equal(cleanups.length, 1);
  assert.notDeepEqual(cleanups[0].owner, cleanups[0].currentOwner);
  assert.equal(cleanups[0].removed, false);
});
