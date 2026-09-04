import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {lstat, mkdtemp, mkdir, readFile, readdir, rename, stat, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {promisify} from "node:util";
import {deflateSync} from "node:zlib";

import {sha256File} from "../src/checksum.mjs";
import {mutateManifest} from "../src/manifest.mjs";
import {createProject} from "../src/project.mjs";
import {hashFileNoFollow, readFileNoFollow, renameExclusive, writeExclusiveFile} from "../src/release-fs.mjs";
import {runProcess} from "../src/process.mjs";
import {normalizeVisionOutput, runSubjectAnalysis, validatePngBytes, validateRequiredMattes} from "../src/subject-map.mjs";
import {createMediaIndex} from "../src/video-media-index.mjs";
import {createWorkItem, transitionProject, transitionWorkItem} from "../src/workflow.mjs";

const fixturePath = new URL("./fixtures/vision-output.json", import.meta.url);
const wrapperPath = new URL("../scripts/video/analyze-subject.sh", import.meta.url);
const execFileAsync = promisify(execFile);
const coordinator = {actorId: "content-hub-coordinator", actorRole: "coordinator"};
const producer = {actorId: "subject-1", role: "subject-analyst"};
const technician = {actorId: "media-1", role: "local-media-technician"};
const parent = {artifactId: "brief-001", sha256: "b".repeat(64)};
const versions = {tool: "content-hub@0.2.0", template: null, model: "Apple Vision", policy: "bizibeast-v1"};

async function rawFixture() {
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

function normalizeInput(overrides = {}) {
  return {
    sourceId: "source-a", sourceSha256: "a".repeat(64), sourceBytes: 12345,
    frameSize: {width: 1080, height: 1920}, timeRangeMs: {startMs: 0, endMs: 1500}, sampleFps: 2,
    requiredTracking: false, requiredMatte: false, matteRequested: true,
    matteBasePath: "Renders/Subject-Mattes/raw-001/v001", ...overrides,
  };
}

test("normalizes top-left pixel observations, avoid regions, and track breaks", async () => {
  const map = normalizeVisionOutput(await rawFixture(), normalizeInput());
  assert.deepEqual(map.frames[0].faces[0].box, {x: 108, y: 192, width: 216, height: 384});
  assert.equal(map.coordinateSpace, "top-left-pixels");
  assert.deepEqual(map.timeRangeMs, {startMs: 0, endMs: 1500});
  assert.deepEqual(map.tracking.discontinuities, [1000]);
  assert.equal(map.tracking.faceConfidence, 0.95);
  assert.equal(map.tracking.subjectConfidence, 0.93);
  assert.deepEqual(map.frames[0].avoidRegions.map(({kind}) => kind), ["face", "subject"]);
  assert.equal(map.frames[1].matte.path, "Renders/Subject-Mattes/raw-001/v001/000001.png");
  assert.equal(map.frames[1].matte.chatterRatio, 0.005);
  assert.equal(map.mattes.coverage, 1);
  assert.equal(Object.hasOwn(map, "depth"), false);
});

test("rejects mismatched snapshots, timing, observations, and detector flags", async () => {
  const raw = await rawFixture();
  const invalid = [
    [{...raw, sourceSha256: "b".repeat(64)}, /source hash mismatch/u],
    [{...raw, sourceBytes: raw.sourceBytes + 1}, /source byte count mismatch/u],
    [{...raw, width: 720}, /decoded dimensions mismatch/u],
    [{...raw, durationMs: 1600, timeRangeMs: {startMs: 0, endMs: 1600}}, /time range mismatch/u],
    [{...raw, sampleFps: 1}, /sample fps mismatch/u],
    [{...raw, frames: raw.frames.slice(0, 2)}, /sample frame count/u],
    [{...raw, frames: raw.frames.map((frame, index) => index === 1 ? {...frame, index: 0} : frame)}, /frame index/u],
    [{...raw, frames: raw.frames.map((frame, index) => index === 1 ? {...frame, timeMs: 0} : frame)}, /strictly monotonic/u],
    [{...raw, frames: raw.frames.map((frame, index) => ({...frame, timeMs: index}))}, /sample cadence/u],
    [{...raw, frames: raw.frames.map((frame, index) => index === 0 ? {...frame, faces: [{...frame.faces[0], box: {...frame.faces[0].box, x: 1000}}]} : frame)}, /frame bounds/u],
    [{...raw, frames: raw.frames.map((frame, index) => index === 0 ? {...frame, faceAnalysisAvailable: "yes"} : frame)}, /availability/iu],
    [{...raw, frames: raw.frames.map((frame, index) => index === 0 ? {...frame, faceAnalysisError: "unexpected"} : frame)}, /analysis error/iu],
    [{...raw, frames: raw.frames.map((frame, index) => index === 0 ? {...frame, personAnalysisAvailable: 1} : frame)}, /availability/iu],
    [{...raw, frames: raw.frames.map((frame, index) => index === 0 ? {...frame, segmentationAttempted: null} : frame)}, /segmentation attempted/iu],
    [{...raw, frames: raw.frames.map((frame, index) => index === 0 ? {...frame, segmentationAvailable: "true"} : frame)}, /segmentation availability/iu],
  ];
  for (const [value, message] of invalid) assert.throws(() => normalizeVisionOutput(value, normalizeInput()), message);
});

test("required mattes also require complete high-quality subject tracking", async () => {
  const raw = await rawFixture();
  const stable = raw.frames.map((frame, index) => ({...frame, subjectBox: {...raw.frames[0].subjectBox, x: 300 + index * 2}}));
  const missing = normalizeVisionOutput({...raw, frames: stable.map((frame, index) => index === 1 ? {...frame, mattePath: null} : frame)}, normalizeInput());
  assert.throws(() => validateRequiredMattes(missing), /required matte frame 1/u);
  assert.throws(() => normalizeVisionOutput({...raw, frames: stable.map((frame) => ({...frame, subjectConfidence: 0.7}))}, normalizeInput({requiredMatte: true})), /subject confidence/u);
  assert.throws(() => normalizeVisionOutput({...raw, frames: stable.map((frame, index) => index === 1 ? {...frame, matteCoverage: 0.24} : frame)}, normalizeInput({requiredMatte: true})), /matte chatter/u);
  assert.throws(() => normalizeVisionOutput({...raw, frames: stable.map((frame, index) => index === 1 ? {...frame, edgeHaloPx: 4} : frame)}, normalizeInput({requiredMatte: true})), /matte halo/u);
});

test("optional no-subject footage emits an explicit empty map and deviation", async () => {
  const raw = await rawFixture();
  const map = normalizeVisionOutput({...raw, frames: raw.frames.map((frame) => ({
    ...frame, faces: [], subjectBox: null, subjectConfidence: null, mattePath: null, matteCoverage: 0, edgeHaloPx: 0,
  }))}, normalizeInput());
  assert.equal(map.tracking.status, "empty");
  assert.deepEqual(map.avoidRegions, []);
  assert.deepEqual(map.deviations, [{code: "no-subject-detected", reason: "Optional analysis found no face or person observations"}]);
});

test("optional detector and segmentation failures are explicit while required modes fail", async () => {
  const raw = await rawFixture();
  const unavailable = {...raw, frames: raw.frames.map((frame) => ({
    ...frame, faces: [], faceAnalysisAvailable: false, faceAnalysisError: "face unavailable",
    subjectBox: null, subjectConfidence: null, personAnalysisAvailable: false, personAnalysisError: "person unavailable",
    segmentationAttempted: true, segmentationAvailable: false, segmentationError: "mask unavailable",
    mattePath: null, matteCoverage: 0, edgeHaloPx: 0,
  }))};
  const map = normalizeVisionOutput(unavailable, normalizeInput());
  assert.deepEqual(map.deviations.map(({code}) => code), ["face-analysis-unavailable", "person-analysis-unavailable", "segmentation-unavailable"]);
  assert.throws(() => normalizeVisionOutput(unavailable, normalizeInput({requiredTracking: true})), /person analysis unavailable/u);
  assert.throws(() => normalizeVisionOutput(unavailable, normalizeInput({requiredMatte: true})), /person analysis unavailable|segmentation unavailable/u);
});

let crcTable;
function crc32(bytes) {
  crcTable ??= Array.from({length: 256}, (_, value) => {
    let result = value;
    for (let bit = 0; bit < 8; bit += 1) result = result & 1 ? 0xedb88320 ^ (result >>> 1) : result >>> 1;
    return result >>> 0;
  });
  let result = 0xffffffff;
  for (const byte of bytes) result = crcTable[(result ^ byte) & 0xff] ^ (result >>> 8);
  return (result ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return chunk;
}

function realPng(width, height, note = "A") {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const rows = Buffer.alloc((width + 1) * height, 255);
  for (let row = 0; row < height; row += 1) rows[row * (width + 1)] = 0;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header), pngChunk("tEXt", Buffer.from(`note=${note}`)),
    pngChunk("IDAT", deflateSync(rows)), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

test("accepts a complete PNG and rejects truncated, trailing, and CRC-corrupt structures", () => {
  const png = realPng(4, 4);
  assert.deepEqual(validatePngBytes(png, 4, 4), {width: 4, height: 4});
  assert.throws(() => validatePngBytes(png.subarray(0, -3), 4, 4), /truncated|complete/u);
  assert.throws(() => validatePngBytes(Buffer.concat([png, Buffer.from("junk")]), 4, 4), /trailing|IEND/u);
  const corrupt = Buffer.from(png);
  corrupt[corrupt.indexOf(Buffer.from("IDAT")) + 4] ^= 1;
  assert.throws(() => validatePngBytes(corrupt, 4, 4), /CRC/u);
});

function probe() {
  return {durationSeconds: 1, formatName: "mov,mp4", video: [{codec_name: "h264", width: 4, height: 4, avg_frame_rate: "30/1"}], audio: [], raw: {format: {tags: {}}, streams: []}};
}

async function projectFixture({state = "STORY_PLANNED"} = {}) {
  const root = await mkdtemp(join(tmpdir(), "content-hub-subject-"));
  const {projectDir} = await createProject(root, {name: "Subject", editors: ["premiere"]});
  const sourcePath = join(projectDir, "Source", "clip.mov");
  await writeFile(sourcePath, "synthetic-source-snapshot");
  await mutateManifest(projectDir, coordinator, async (manifest) => ({...manifest, sources: [{
    id: "source-a", kind: "source", path: "Source/clip.mov", sha256: await sha256File(sourcePath),
    bytes: (await stat(sourcePath)).size, createdAt: "2026-09-01T00:00:00Z",
  }]}));
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief frozen"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "ready"});
  await createWorkItem(projectDir, coordinator, {id: "raw-001", title: "Raw", modality: "raw-video"});
  const indexed = await createMediaIndex(projectDir, {
    workItemId: "raw-001", revision: 1, modality: "raw-video", producer: technician, versions, parents: [parent],
  }, {probe: async () => probe()});
  if (state !== "READY") await transitionWorkItem(projectDir, coordinator, {workItemId: "raw-001", to: "MEDIA_INDEXED", reason: "indexed"});
  if (!["READY", "MEDIA_INDEXED"].includes(state)) await transitionWorkItem(projectDir, coordinator, {workItemId: "raw-001", to: "TRANSCRIPTS_READY", reason: "transcribed"});
  if (state === "STORY_PLANNED") await transitionWorkItem(projectDir, coordinator, {workItemId: "raw-001", to: "STORY_PLANNED", reason: "story planned"});
  return {projectDir, sourcePath, indexed};
}

function analysisInput(indexed, overrides = {}) {
  return {
    workItemId: "raw-001", revision: 1, modality: "raw-video", producer, versions,
    mediaIndexArtifactRef: indexed.artifactRef, currentParents: [parent], sourceId: "source-a",
    sampleFps: 1, requiredTracking: true, requiredMatte: true, ...overrides,
  };
}

function analysisRaw(source, overrides = {}) {
  return {
    schemaVersion: 1, sourceSha256: source.sha256, sourceBytes: source.bytes, width: 4, height: 4,
    durationMs: 1000, sampleFps: 1, timeRangeMs: {startMs: 0, endMs: 1000},
    frames: [{
      index: 0, timeMs: 0, faces: [{box: {x: 1, y: 0, width: 1, height: 1}, confidence: 0.95}],
      faceAnalysisAvailable: true, faceAnalysisError: null, subjectBox: {x: 1, y: 0, width: 2, height: 4}, subjectConfidence: 0.94,
      personAnalysisAvailable: true, personAnalysisError: null, segmentationAttempted: true, segmentationAvailable: true,
      segmentationError: null, mattePath: "000000.png", matteCoverage: 0.5, edgeHaloPx: 1,
    }], ...overrides,
  };
}

function fakeAnalyzer(raw, {matteBytes = realPng(4, 4), mutateSource, mutateDuringAnalysis, mutateMatteOnDecode, decodeResult} = {}) {
  return async (command, args, options) => {
    if (command === "ffmpeg") {
      await mutateMatteOnDecode?.(args[args.indexOf("-i") + 1]);
      return decodeResult ?? runProcess(command, args, options);
    }
    const [snapshot, sourceSha256, output, matteDirectory] = args;
    assert.match(snapshot, /Plans\/\.subject-raw-001-v001-[^/]+\/source-a\.mov$/u);
    await writeFile(output, JSON.stringify({...raw, sourceSha256, sourceBytes: (await stat(snapshot)).size}));
    if (matteDirectory !== "-") await writeFile(join(matteDirectory, "000000.png"), matteBytes);
    await mutateSource?.();
    await mutateDuringAnalysis?.();
    return {code: 0, signal: null, stdout: "", stderr: "", truncated: false};
  };
}

test("publishes a media-index-bound artifact and fully decoded matte", async () => {
  const {projectDir, indexed} = await projectFixture();
  const source = indexed.index.sources[0];
  const result = await runSubjectAnalysis(projectDir, analysisInput(indexed, {source: {path: "Source/wrong.mov", sha256: "f".repeat(64)}}), {run: fakeAnalyzer(analysisRaw(source))});
  assert.deepEqual(result.artifact.parents, [{artifactId: indexed.artifactRef.artifactId, sha256: indexed.artifactRef.sha256}]);
  assert.equal(result.artifactRef.artifactId, "subject-map:raw-001:source-a:v001");
  assert.equal(result.subjectMap.sourceSha256, source.sha256);
  assert.deepEqual(result.subjectMap.frameSize, {width: 4, height: 4});
  assert.equal(JSON.parse(await readFile(join(projectDir, "Plans", "Subjects", "raw-001", "v001", "source-a-v001.json"), "utf8")).artifactId, result.artifact.artifactId);
  assert.match(result.subjectMap.frames[0].matte.path, /Subject-Mattes\/raw-001\/source-a\/v001\/000000\.png$/u);
  assert.match(result.subjectMap.frames[0].matte.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.subjectMap.frames[0].matte.bytes, realPng(4, 4).length);
});

test("preserves the singular SubjectMap ID and path only for explicit one-source compatibility", async () => {
  const {projectDir, indexed} = await projectFixture();
  const result = await runSubjectAnalysis(projectDir, analysisInput(indexed, {singleSourceCompatibility: true}), {
    run: fakeAnalyzer(analysisRaw(indexed.index.sources[0])),
  });
  assert.equal(result.artifactRef.artifactId, "subject-map:raw-001:v001");
  assert.equal(JSON.parse(await readFile(join(projectDir, "Plans", "Subjects", "raw-001", "subject-map-v001.json"), "utf8")).artifactId, result.artifact.artifactId);
});

test("rejects ffmpeg decode stderr before publishing a claimed matte", async () => {
  const {projectDir, indexed} = await projectFixture();
  const raw = analysisRaw(indexed.index.sources[0]);
  await assert.rejects(runSubjectAnalysis(projectDir, analysisInput(indexed), {
    run: fakeAnalyzer(raw, {decodeResult: {code: 0, signal: null, stdout: "", stderr: "CRC error", truncated: false}}),
  }), /matte decode.*CRC error/iu);
  await assert.rejects(stat(join(projectDir, "Renders", "Subject-Mattes", "raw-001", "v001")), {code: "ENOENT"});
});

test("effective required tracking covers matte, background-removal, and text-behind requests", async () => {
  for (const requirement of [{requiredMatte: true}, {backgroundRemoval: "required"}, {textBehindSubject: "required"}]) {
    const {projectDir, indexed} = await projectFixture();
    const source = indexed.index.sources[0];
    const lowConfidence = analysisRaw(source, {frames: [{...analysisRaw(source).frames[0], subjectConfidence: 0.5}]});
    await assert.rejects(runSubjectAnalysis(projectDir, analysisInput(indexed, {requiredTracking: false, requiredMatte: false, ...requirement}), {
      run: fakeAnalyzer(lowConfidence),
    }), /subject confidence/u);
  }
});

test("rejects stale, tampered, wrong-source, and wrong-state media-index bindings before analysis", async () => {
  const stale = await projectFixture();
  const calls = [];
  await assert.rejects(runSubjectAnalysis(stale.projectDir, analysisInput(stale.indexed, {
    mediaIndexArtifactRef: {...stale.indexed.artifactRef, sha256: "c".repeat(64)},
  }), {run: async (...args) => calls.push(args)}), /media-index artifact ref/iu);
  await assert.rejects(runSubjectAnalysis(stale.projectDir, analysisInput(stale.indexed, {sourceId: "wrong-source"}), {
    run: async (...args) => calls.push(args),
  }), /source ID/iu);
  await assert.rejects(runSubjectAnalysis(stale.projectDir, analysisInput(stale.indexed, {revision: 2}), {
    run: async (...args) => calls.push(args),
  }), /workflow item revision/u);
  await assert.rejects(runSubjectAnalysis(stale.projectDir, analysisInput(stale.indexed, {modality: "multi-clip"}), {
    run: async (...args) => calls.push(args),
  }), /workflow item revision and modality/u);
  await writeFile(join(stale.projectDir, "Plans", "MediaIndex", "raw-001", "media-index-v001.json"), "{}\n");
  await assert.rejects(runSubjectAnalysis(stale.projectDir, analysisInput(stale.indexed), {run: async (...args) => calls.push(args)}), /media-index artifact ref/iu);
  const wrongState = await projectFixture({state: "TRANSCRIPTS_READY"});
  await assert.rejects(runSubjectAnalysis(wrongState.projectDir, analysisInput(wrongState.indexed), {run: async (...args) => calls.push(args)}), /STORY_PLANNED/u);
  assert.deepEqual(calls, []);
});

test("rejects media-index split reads whose parsed bytes differ from same-owner pathname metadata", async () => {
  const {projectDir, indexed} = await projectFixture();
  const raw = analysisRaw(indexed.index.sources[0]);
  const splitRead = async (root, path) => {
    const stored = await readFileNoFollow(root, path);
    if (!path.endsWith("media-index-v001.json")) return stored;
    const changed = Buffer.from(stored.bytes.toString("utf8").replace('"confidence": 0.4', '"confidence": 0.5'));
    assert.equal(changed.length, stored.bytes.length);
    assert.notDeepEqual(changed, stored.bytes);
    return {...stored, bytes: changed};
  };
  await assert.rejects(runSubjectAnalysis(projectDir, analysisInput(indexed), {
    readFileNoFollow: splitRead, run: fakeAnalyzer(raw),
  }), /media-index.*exact.*bytes|media-index.*buffer/iu);
  await assert.rejects(readFile(join(projectDir, "Plans", "Subjects", "raw-001", "subject-map-v001.json")), {code: "ENOENT"});
});

test("rejects media-index descriptor size drift and a changed post-validation recheck", async () => {
  const calls = [];
  const sizeDrift = await projectFixture();
  await assert.rejects(runSubjectAnalysis(sizeDrift.projectDir, analysisInput(sizeDrift.indexed), {
    run: async (...args) => calls.push(args),
    hashNoFollow: async (root, path) => {
      const stored = await hashFileNoFollow(root, path);
      return path.endsWith("media-index-v001.json") ? {...stored, bytes: stored.bytes + 1} : stored;
    },
  }), /media-index.*buffer/iu);

  const changed = await projectFixture();
  let indexHashes = 0;
  await assert.rejects(runSubjectAnalysis(changed.projectDir, analysisInput(changed.indexed), {
    run: async (...args) => calls.push(args),
    hashNoFollow: async (root, path) => {
      const stored = await hashFileNoFollow(root, path);
      if (path.endsWith("media-index-v001.json") && ++indexHashes === 2) return {...stored, sha256: "c".repeat(64)};
      return stored;
    },
  }), /media-index.*buffer|media-index.*changed/iu);
  assert.deepEqual(calls, []);
});

test("rejects matte split reads whose validated bytes differ from same-owner pathname metadata", async () => {
  const {projectDir, indexed} = await projectFixture();
  const raw = analysisRaw(indexed.index.sources[0]);
  const alternate = realPng(4, 4, "B");
  const splitRead = async (root, path) => {
    const stored = await readFileNoFollow(root, path);
    if (!path.endsWith("000000.png")) return stored;
    assert.equal(alternate.length, stored.bytes.length);
    return {...stored, bytes: alternate};
  };
  await assert.rejects(runSubjectAnalysis(projectDir, analysisInput(indexed), {
    readFileNoFollow: splitRead, run: fakeAnalyzer(raw),
  }), /matte.*exact.*bytes|matte.*buffer/iu);
  await assert.rejects(stat(join(projectDir, "Renders", "Subject-Mattes", "raw-001", "v001")), {code: "ENOENT"});
});

test("rejects an in-place matte mutation during strict decode", async () => {
  const {projectDir, indexed} = await projectFixture();
  const raw = analysisRaw(indexed.index.sources[0]);
  const replacement = realPng(4, 4, "B");
  assert.equal(replacement.length, realPng(4, 4).length);
  await assert.rejects(runSubjectAnalysis(projectDir, analysisInput(indexed), {
    run: fakeAnalyzer(raw, {mutateMatteOnDecode: async (path) => writeFile(path, replacement)}),
  }), /matte.*changed.*decode|matte.*unchanged/iu);
  await assert.rejects(stat(join(projectDir, "Renders", "Subject-Mattes", "raw-001", "v001")), {code: "ENOENT"});
});

test("source replacement and failed publication clean only invocation-owned results", async () => {
  const {projectDir, sourcePath, indexed} = await projectFixture();
  const raw = analysisRaw(indexed.index.sources[0]);
  await assert.rejects(runSubjectAnalysis(projectDir, analysisInput(indexed), {run: fakeAnalyzer(raw, {mutateSource: async () => {
    const replacement = `${sourcePath}.replacement`;
    await writeFile(replacement, "replacement source");
    await rename(replacement, sourcePath);
  }})}), /source changed during analysis/iu);
  await assert.rejects(readFile(join(projectDir, "Plans", "Subjects", "raw-001", "subject-map-v001.json")), {code: "ENOENT"});
});

test("media-index mutation during analysis prevents subject and matte publication", async () => {
  const {projectDir, indexed} = await projectFixture();
  const raw = analysisRaw(indexed.index.sources[0]);
  const indexPath = join(projectDir, "Plans", "MediaIndex", "raw-001", "media-index-v001.json");
  await assert.rejects(runSubjectAnalysis(projectDir, analysisInput(indexed), {run: fakeAnalyzer(raw, {mutateDuringAnalysis: async () => {
    const before = await readFile(indexPath, "utf8");
    const changed = before.replace('"confidence": 0.4', '"confidence": 0.5');
    assert.equal(changed.length, before.length);
    assert.notEqual(changed, before);
    await writeFile(indexPath, changed);
  }})}), /media-index.*changed|media-index.*buffer/iu);
  await assert.rejects(readFile(join(projectDir, "Plans", "Subjects", "raw-001", "subject-map-v001.json")), {code: "ENOENT"});
  await assert.rejects(stat(join(projectDir, "Renders", "Subject-Mattes", "raw-001", "v001")), {code: "ENOENT"});
});

test("rejects a final matte replacement after directory publication and preserves the replacement", async () => {
  const {projectDir, indexed} = await projectFixture();
  const replacement = realPng(4, 4, "post-rename-replacement");
  const finalPath = "Renders/Subject-Mattes/raw-001/source-a/v001/000000.png";
  await assert.rejects(runSubjectAnalysis(projectDir, analysisInput(indexed), {
    run: fakeAnalyzer(analysisRaw(indexed.index.sources[0])),
    renameExclusive: async (root, sourcePath, targetPath, owner) => {
      await renameExclusive(root, sourcePath, targetPath, owner);
      if (targetPath.endsWith("/source-a/v001")) {
        const temporary = join(root, `${targetPath}/replacement.png`);
        await writeFile(temporary, replacement);
        await rename(temporary, join(root, finalPath));
      }
    },
  }), /Final matte frame 0 changed.*directory publication/iu);
  assert.deepEqual(await readFile(join(projectDir, finalPath)), replacement);
  await assert.rejects(readFile(join(projectDir, "Plans/Subjects/raw-001/v001/source-a-v001.json")), {code: "ENOENT"});
});

test("rejects a final matte replacement during artifact publication, removes its artifact, and preserves the replacement", async () => {
  const {projectDir, indexed} = await projectFixture();
  const replacement = realPng(4, 4, "post-artifact-replacement");
  const finalPath = "Renders/Subject-Mattes/raw-001/source-a/v001/000000.png";
  await assert.rejects(runSubjectAnalysis(projectDir, analysisInput(indexed), {
    run: fakeAnalyzer(analysisRaw(indexed.index.sources[0])),
    writeExclusiveFile: async (root, path, bytes) => {
      const owner = await writeExclusiveFile(root, path, bytes);
      if (path.endsWith("source-a-v001.json")) {
        const temporary = join(root, "Renders/Subject-Mattes/raw-001/source-a/v001/replacement.png");
        await writeFile(temporary, replacement);
        await rename(temporary, join(root, finalPath));
      }
      return owner;
    },
  }), /Final matte frame 0 changed.*after subject-map publication/iu);
  assert.deepEqual(await readFile(join(projectDir, finalPath)), replacement);
  await assert.rejects(readFile(join(projectDir, "Plans/Subjects/raw-001/v001/source-a-v001.json")), {code: "ENOENT"});
});

test("private wrapper builds ignore shared cache symlinks and do not collide concurrently", async () => {
  const root = await mkdtemp(join(tmpdir(), "subject-wrapper-"));
  await Promise.all([
    mkdir(join(root, "scripts", "video"), {recursive: true}), mkdir(join(root, "scripts", "vision"), {recursive: true}),
    mkdir(join(root, "Tools", "apple-vision-subject"), {recursive: true}), mkdir(join(root, "tmp"), {recursive: true}),
  ]);
  await writeFile(join(root, "scripts", "video", "analyze-subject.sh"), await readFile(wrapperPath), {mode: 0o755});
  await writeFile(join(root, "scripts", "vision", "SubjectAnalyzer.swift"), [
    "import Foundation",
    "try Data(\"private-build\".utf8).write(to: URL(fileURLWithPath: CommandLine.arguments[3]), options: .atomic)",
  ].join("\n"));
  const marker = join(root, "shared-cache-executed");
  const malicious = join(root, "malicious.sh");
  await writeFile(malicious, `#!/bin/zsh\nprint owned > '${marker}'\n`, {mode: 0o755});
  await symlink(malicious, join(root, "Tools", "apple-vision-subject", "SubjectAnalyzer"));
  const source = join(root, "source.mov");
  await writeFile(source, "source");
  const wrapper = join(root, "scripts", "video", "analyze-subject.sh");
  const env = {...process.env, TMPDIR: `${join(root, "tmp")}/`};
  const outputs = [join(root, "one.json"), join(root, "two.json")];
  await Promise.all(outputs.map((output) => execFileAsync(wrapper, [source, "a".repeat(64), output, "-", "1"], {env})));
  assert.deepEqual(await Promise.all(outputs.map((output) => readFile(output, "utf8"))), ["private-build", "private-build"]);
  await assert.rejects(readFile(marker), {code: "ENOENT"});
  assert.equal((await lstat(join(root, "Tools", "apple-vision-subject", "SubjectAnalyzer"))).isSymbolicLink(), true);
  assert.deepEqual(await readdir(join(root, "tmp")), []);
});
