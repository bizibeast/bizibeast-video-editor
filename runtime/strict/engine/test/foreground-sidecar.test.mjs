import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {copyFile, mkdtemp, mkdir, readFile, realpath, rename, stat, symlink, unlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import test from "node:test";
import {promisify} from "node:util";
import {deflateSync} from "node:zlib";

import {createArtifactEnvelope} from "../src/artifacts.mjs";
import {sha256File} from "../src/checksum.mjs";
import {buildArtifactForegroundSidecar} from "../src/foreground-sidecar.mjs";
import {createProject} from "../src/project.mjs";
import {readFileNoFollow, writeExclusiveFile} from "../src/release-fs.mjs";
import {createWorkItem, readWorkflowState, transitionProject, transitionWorkItem} from "../src/workflow.mjs";

const execFileAsync = promisify(execFile);
const coordinator = {actorId: "content-hub-coordinator", actorRole: "coordinator"};
const versions = {tool: "content-hub@0.2.0", template: null, model: "apple-vision", policy: "bizibeast-v1"};
const parent = {artifactId: "brief-001", sha256: "b".repeat(64)};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pad = (value) => String(value).padStart(3, "0");

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

function realPng(width, height, value = 255) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const rows = Buffer.alloc((width + 1) * height, value);
  for (let row = 0; row < height; row += 1) rows[row * (width + 1)] = 0;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(rows)), pngChunk("IEND", Buffer.alloc(0))]);
}

async function storeArtifact(projectDir, path, input) {
  const artifact = createArtifactEnvelope(input);
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  await mkdir(dirname(join(projectDir, path)), {recursive: true});
  await writeFile(join(projectDir, path), bytes, {flag: "wx"});
  return {artifact, artifactRef: {artifactId: artifact.artifactId, sha256: sha256(bytes)}};
}

async function fixture({workItemId = "raw-001", sourceId = "source-a", realMedia = false, mapMutator, subjectParent} = {}) {
  const root = await mkdtemp(join(tmpdir(), "content-hub-foreground-"));
  const {projectDir} = await createProject(root, {name: "Foreground", editors: ["premiere"]});
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief frozen"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "ready"});
  await createWorkItem(projectDir, coordinator, {id: workItemId, title: workItemId, modality: "multi-clip"});
  for (const to of ["MEDIA_INDEXED", "TRANSCRIPTS_READY", "STORY_PLANNED"]) {
    await transitionWorkItem(projectDir, coordinator, {workItemId, to, reason: to.toLowerCase()});
  }

  const width = realMedia ? 64 : 4;
  const height = realMedia ? 96 : 4;
  const fps = realMedia ? 5 : 1;
  const frameCount = fps;
  const sourcePath = `Source/${sourceId}.mp4`;
  const sourceAbsolute = join(projectDir, sourcePath);
  if (realMedia) {
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=blue:s=${width}x${height}:r=${fps}:d=1`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", sourceAbsolute]);
  } else await writeFile(sourceAbsolute, "synthetic source bytes");
  const source = {id: sourceId, kind: "source", path: sourcePath, sha256: await sha256File(sourceAbsolute), bytes: (await stat(sourceAbsolute)).size,
    createdAt: "2026-09-01T00:00:00Z", durationSeconds: 1, formatName: "mov,mp4", video: [{codecName: "h264", width, height, avgFrameRate: `${fps}/1`}], audio: []};
  const revision = "001";
  const indexed = await storeArtifact(projectDir, `Plans/MediaIndex/${workItemId}/media-index-v${revision}.json`, {
    artifactId: `media-index:${workItemId}:v${revision}`, revision: 1, workItemId, modality: "multi-clip", parents: [parent],
    producer: {actorId: "media-1", role: "local-media-technician"}, versions, status: "frozen", deviations: [], payload: {kind: "media-index", sources: [source]},
  });
  const matteBase = `Renders/Subject-Mattes/${workItemId}/${sourceId}/v${revision}`;
  await mkdir(join(projectDir, matteBase), {recursive: true});
  if (realMedia) {
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=white:s=${width}x${height}:r=${fps}:d=1`,
      "-frames:v", String(frameCount), "-start_number", "0", "-y", join(projectDir, matteBase, "%06d.png")]);
  } else await writeFile(join(projectDir, matteBase, "000000.png"), realPng(width, height));
  const frames = [];
  for (let index = 0; index < frameCount; index += 1) {
    const path = `${matteBase}/${String(index).padStart(6, "0")}.png`;
    frames.push({index, timeMs: Math.round(index * 1000 / fps), faces: [], subjectBox: {x: 0, y: 0, width, height}, confidence: 0.99,
      discontinuity: false, jitterPx: 0, matte: {path, coverage: 1, chatterRatio: 0, edgeHaloPx: 0,
        sha256: await sha256File(join(projectDir, path)), bytes: (await stat(join(projectDir, path))).size}});
  }
  let map = {kind: "subject-map", schemaVersion: 1, sourceId, sourceSha256: source.sha256, sourceSnapshot: {sha256: source.sha256, bytes: source.bytes},
    timeRangeMs: {startMs: 0, endMs: 1000}, sampleFps: fps, expectedFrameCount: frameCount, coordinateSpace: "top-left-pixels",
    frameSize: {width, height}, frames, avoidRegions: [], tracking: {status: "tracked", confidence: 0.99, discontinuities: [], jitterPx: 0, maxJitterPx: 0},
    mattes: {requested: false, required: false, coverage: 1, complete: true, maxChatterRatio: 0, maxEdgeHaloPx: 0}, deviations: []};
  map = mapMutator?.(structuredClone(map)) ?? map;
  const subject = await storeArtifact(projectDir, `Plans/Subjects/${workItemId}/v${revision}/${sourceId}-v${revision}.json`, {
    artifactId: `subject-map:${workItemId}:${sourceId}:v${revision}`, revision: 1, workItemId, modality: "multi-clip",
    parents: [subjectParent ?? indexed.artifactRef], producer: {actorId: "subject-1", role: "subject-analyst"}, versions,
    status: "frozen", deviations: map.deviations, payload: map,
  });
  const input = {workItemId, sourceId: "caller-lie", revision: 1, modality: "multi-clip", mediaIndexArtifactRef: indexed.artifactRef,
    subjectMapArtifactRef: subject.artifactRef, currentParents: [parent], producer: {actorId: "foreground-1", role: "foreground-sidecar-executor"},
    versions, source: {path: "Source/caller-lie.mov", sha256: "f".repeat(64), bytes: 9}, fps: "999/1"};
  return {projectDir, source, indexed, subject, map, input, matteBase};
}

function fakeRender(context, {onBuild, onProbe, onAlpha, onDecode, probeMutator} = {}) {
  const matteSha256 = sha256(Buffer.from(context.map.frames.map(({matte}) => matte.sha256).join("")));
  let probeCount = 0;
  return async (command, args) => {
    if (command.endsWith("build-foreground-sidecar.sh")) {
      await onBuild?.();
      await writeFile(args[3], "synthetic foreground output");
      return {code: 0, stdout: "", stderr: "", truncated: false};
    }
    if (command === "ffprobe") {
      probeCount += 1;
      await onProbe?.(probeCount, args);
      let probe = {streams: [{codec_type: "video", codec_name: "prores", profile: "4444", pix_fmt: "yuva444p10le", width: 4, height: 4,
        avg_frame_rate: "1/1", nb_read_frames: "1", duration: "1.000000"}], format: {duration: "1.000000",
        tags: {content_hub_source_sha256: context.source.sha256, content_hub_matte_sha256: matteSha256}}};
      probe = probeMutator?.(probe) ?? probe;
      return {code: 0, stdout: JSON.stringify(probe), stderr: "", truncated: false};
    }
    if (command === "ffmpeg" && args.includes("alphaextract,signalstats,metadata=print:key=lavfi.signalstats.YMAX:file=-")) {
      await onAlpha?.();
      return {code: 0, stdout: "lavfi.signalstats.YMAX=1023\n", stderr: "", truncated: false};
    }
    if (command === "ffmpeg") await onDecode?.();
    return {code: 0, stdout: "", stderr: "", truncated: false};
  };
}

test("builds from exact media-index and SubjectMap evidence, ignores caller source metadata, and reads back publication", async () => {
  const context = await fixture();
  const result = await buildArtifactForegroundSidecar(context.projectDir, context.input, {run: fakeRender(context)});
  assert.equal(result.artifactRef.artifactId, "foreground-sidecar:raw-001:source-a:v001");
  assert.deepEqual(result.artifact.parents, [context.subject.artifactRef, context.indexed.artifactRef]);
  assert.deepEqual(result.artifact.payload.source, {id: "source-a", path: context.source.path, sha256: context.source.sha256, bytes: context.source.bytes});
  assert.equal(result.path, "Renders/Foreground/raw-001/source-a/v001/foreground.mov");
  assert.equal((await readFile(join(context.projectDir, result.path), "utf8")), "synthetic foreground output");
  const receipt = JSON.parse(await readFile(join(context.projectDir, "Plans/Foreground/raw-001/source-a/foreground-sidecar-v001.json"), "utf8"));
  assert.equal(receipt.payload.output.sha256, await sha256File(join(context.projectDir, result.path)));
});

test("rejects wrong maps, changed and cross-source mattes, split reads, and stale parents", async () => {
  const wrong = await fixture();
  await assert.rejects(buildArtifactForegroundSidecar(wrong.projectDir, {...wrong.input, subjectMapArtifactRef: {...wrong.input.subjectMapArtifactRef,
    artifactId: "subject-map:raw-001:source-b:v001"}}, {run: fakeRender(wrong)}), /source ID|SubjectMap ref|stored bytes/iu);

  const changed = await fixture();
  await writeFile(join(changed.projectDir, changed.map.frames[0].matte.path), Buffer.concat([realPng(4, 4), Buffer.from("changed")]));
  await assert.rejects(buildArtifactForegroundSidecar(changed.projectDir, changed.input, {run: fakeRender(changed)}), /Matte frame 0 changed/iu);

  const cross = await fixture({mapMutator: (map) => {
    map.frames[0].matte.path = "Renders/Subject-Mattes/raw-001/source-b/v001/000000.png";
    return map;
  }});
  await assert.rejects(buildArtifactForegroundSidecar(cross.projectDir, cross.input, {run: fakeRender(cross)}), /source-bound path/iu);

  const split = await fixture();
  await assert.rejects(buildArtifactForegroundSidecar(split.projectDir, split.input, {
    run: fakeRender(split),
    readFileNoFollow: async (root, path) => {
      const stored = await readFileNoFollow(root, path);
      if (!path.endsWith("source-a-v001.json")) return stored;
      const bytes = Buffer.from(stored.bytes.toString("utf8").replace('"confidence": 0.99', '"confidence": 0.98'));
      assert.equal(bytes.length, stored.bytes.length);
      return {...stored, bytes};
    },
  }), /SubjectMap buffer.*exact/iu);

  const stale = await fixture();
  await assert.rejects(buildArtifactForegroundSidecar(stale.projectDir, {...stale.input, currentParents: [{...parent, sha256: "c".repeat(64)}]},
    {run: fakeRender(stale)}), /parent hash changed/iu);
});

test("requires strict tracking and matte quality even when upstream marked both optional", async () => {
  for (const [mutate, expected] of [
    [(map) => { map.frames[0].confidence = 0.79; map.tracking.confidence = 0.79; return map; }, /high-confidence/iu],
    [(map) => { map.tracking.discontinuities = [0]; return map; }, /continuous/iu],
    [(map) => { map.tracking.maxJitterPx = 7; return map; }, /continuous/iu],
    [(map) => { map.mattes.maxChatterRatio = 0.03; return map; }, /chatter/iu],
    [(map) => { map.mattes.maxEdgeHaloPx = 4; return map; }, /halo/iu],
  ]) {
    const context = await fixture({mapMutator: mutate});
    await assert.rejects(buildArtifactForegroundSidecar(context.projectDir, context.input, {run: fakeRender(context)}), expected);
  }
});

test("rejects short, long, and misaligned matte timelines before rendering", async () => {
  for (const [mutate, expected] of [
    [(map) => { map.frames = []; return map; }, /tracking|required matte/iu],
    [(map) => { map.frames.push(structuredClone(map.frames[0])); map.expectedFrameCount = 2; return map; }, /source frame/iu],
    [(map) => { map.frames[0].timeMs = 1; return map; }, /off cadence/iu],
  ]) {
    const context = await fixture({mapMutator: mutate});
    await assert.rejects(buildArtifactForegroundSidecar(context.projectDir, context.input, {run: fakeRender(context)}), expected);
  }
});

test("rejects symlinked mattes, input mutation, invalid output, and rolls back only its publication", async () => {
  const linked = await fixture();
  const matte = join(linked.projectDir, linked.map.frames[0].matte.path);
  await rename(matte, `${matte}.real`);
  await symlink(`${matte}.real`, matte);
  await assert.rejects(buildArtifactForegroundSidecar(linked.projectDir, linked.input, {run: fakeRender(linked)}), /symlink/iu);

  const mutated = await fixture();
  await assert.rejects(buildArtifactForegroundSidecar(mutated.projectDir, mutated.input, {run: fakeRender(mutated, {
    onBuild: async () => writeFile(join(mutated.projectDir, mutated.map.frames[0].matte.path), realPng(4, 4, 1)),
  })}), /Matte frame 0 changed during render/iu);
  await assert.rejects(stat(join(mutated.projectDir, "Renders/Foreground/raw-001/source-a/v001")), {code: "ENOENT"});

  const invalid = await fixture();
  await assert.rejects(buildArtifactForegroundSidecar(invalid.projectDir, invalid.input, {run: fakeRender(invalid, {
    probeMutator: (probe) => ({...probe, streams: [{...probe.streams[0], nb_read_frames: "0"}]}),
  })}), /output metadata/iu);
  await assert.rejects(stat(join(invalid.projectDir, "Renders/Foreground/raw-001/source-a/v001")), {code: "ENOENT"});
});

test("rejects input drift during ffprobe and full decode", async () => {
  const duringProbe = await fixture();
  await assert.rejects(buildArtifactForegroundSidecar(duringProbe.projectDir, duringProbe.input, {run: fakeRender(duringProbe, {
    onProbe: async (count) => {
      if (count === 1) await writeFile(join(duringProbe.projectDir, duringProbe.map.frames[0].matte.path), realPng(4, 4, 1));
    },
  })}), /Matte frame 0 changed.*artifact publication/iu);

  const duringDecode = await fixture();
  await assert.rejects(buildArtifactForegroundSidecar(duringDecode.projectDir, duringDecode.input, {run: fakeRender(duringDecode, {
    onDecode: async () => writeFile(join(duringDecode.projectDir, duringDecode.source.path), "source drift during full decode"),
  })}), /Foreground inputs changed.*artifact publication/iu);
});

test("rejects workflow advance after receipt and long-running input drift before receipt publication", async () => {
  const workflow = await fixture();
  let workflowReads = 0;
  await assert.rejects(buildArtifactForegroundSidecar(workflow.projectDir, workflow.input, {
    run: fakeRender(workflow),
    readWorkflowState: async (root) => {
      const state = await readWorkflowState(root);
      workflowReads += 1;
      if (workflowReads > 2) state.workItems.find(({id}) => id === workflow.input.workItemId).state = "DESIGN_PLANNED";
      return state;
    },
  }), /workflow changed.*after artifact publication/iu);
  await assert.rejects(readFile(join(workflow.projectDir, "Plans/Foreground/raw-001/source-a/foreground-sidecar-v001.json")), {code: "ENOENT"});

  const longRun = await fixture();
  const indexPath = join(longRun.projectDir, "Plans/MediaIndex/raw-001/media-index-v001.json");
  await assert.rejects(buildArtifactForegroundSidecar(longRun.projectDir, longRun.input, {run: fakeRender(longRun, {
    onAlpha: async () => {
      const replacement = `${indexPath}.replacement`;
      await writeFile(replacement, `${await readFile(indexPath, "utf8")} `);
      await rename(replacement, indexPath);
    },
  })}), /Media-index ref|Foreground inputs changed/iu);
});

test("removes its receipt and owned snapshots but preserves an output replacement during receipt write", async () => {
  const context = await fixture();
  const replacement = Buffer.from("replacement output owned by another publisher");
  const outputPath = join(context.projectDir, "Renders/Foreground/raw-001/source-a/v001/foreground.mov");
  await assert.rejects(buildArtifactForegroundSidecar(context.projectDir, context.input, {
    run: fakeRender(context),
    writeExclusiveFile: async (root, path, bytes) => {
      const owner = await writeExclusiveFile(root, path, bytes);
      if (path.endsWith("foreground-sidecar-v001.json")) {
        const temporary = `${outputPath}.replacement`;
        await writeFile(temporary, replacement);
        await rename(temporary, outputPath);
      }
      return owner;
    },
  }), /Foreground output changed.*after artifact publication/iu);
  assert.deepEqual(await readFile(outputPath), replacement);
  await assert.rejects(readFile(join(context.projectDir, "Plans/Foreground/raw-001/source-a/foreground-sidecar-v001.json")), {code: "ENOENT"});
});

test("does not clobber an existing source revision and isolates sources and work items", async () => {
  const first = await fixture();
  const published = await buildArtifactForegroundSidecar(first.projectDir, first.input, {run: fakeRender(first)});
  const before = await sha256File(join(first.projectDir, published.path));
  await assert.rejects(buildArtifactForegroundSidecar(first.projectDir, first.input, {run: fakeRender(first)}), /exists|collision/iu);
  assert.equal(await sha256File(join(first.projectDir, published.path)), before);

  const [sourceB, workB] = await Promise.all([fixture({sourceId: "source-b"}), fixture({workItemId: "raw-002"})]);
  const [sourceResult, workResult] = await Promise.all([
    buildArtifactForegroundSidecar(sourceB.projectDir, sourceB.input, {run: fakeRender(sourceB)}),
    buildArtifactForegroundSidecar(workB.projectDir, workB.input, {run: fakeRender(workB)}),
  ]);
  assert.match(sourceResult.path, /raw-001\/source-b\/v001/u);
  assert.match(workResult.path, /raw-002\/source-a\/v001/u);
});

test("real FFmpeg integration publishes a decodable source-bound alpha ProRes sidecar and rejects all-black alpha", {timeout: 120_000}, async () => {
  const valid = await fixture({realMedia: true});
  const result = await buildArtifactForegroundSidecar(valid.projectDir, valid.input);
  const receipt = JSON.parse(await readFile(join(valid.projectDir, "Plans/Foreground/raw-001/source-a/foreground-sidecar-v001.json"), "utf8"));
  assert.equal(receipt.payload.output.frameCount, 5);
  assert.equal(receipt.payload.output.codec, "prores");
  assert.match(receipt.payload.output.pixelFormat, /^yuva444p(?:10|12)le$/u);
  await execFileAsync("ffmpeg", ["-v", "error", "-xerror", "-i", join(valid.projectDir, result.path), "-f", "null", "-"]);

  const shell = join(process.cwd(), "scripts/video/build-foreground-sidecar.sh");
  const canonicalProject = await realpath(valid.projectDir);
  for (const [kind, mutate] of [
    ["short", async (directory) => unlink(join(directory, "000004.png"))],
    ["long", async (directory) => copyFile(join(directory, "000004.png"), join(directory, "000005.png"))],
    ["misaligned", async (directory) => rename(join(directory, "000004.png"), join(directory, "000006.png"))],
  ]) {
    const directory = join(valid.projectDir, `Renders/${kind}-mattes`);
    await mkdir(directory);
    for (let index = 0; index < 5; index += 1) await copyFile(join(valid.projectDir, valid.matteBase, `${String(index).padStart(6, "0")}.png`),
      join(directory, `${String(index).padStart(6, "0")}.png`));
    await mutate(directory);
    await assert.rejects(execFileAsync("zsh", [shell, join(canonicalProject, valid.source.path), await realpath(directory), "5/1", join(canonicalProject, `Renders/${kind}.mov`)]),
      /frame count|contiguous/iu);
  }

  const black = await fixture({realMedia: true});
  for (const frame of black.map.frames) await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=black:s=64x96",
    "-frames:v", "1", "-y", join(black.projectDir, frame.matte.path)]);
  // Update the immutable SubjectMap only in this test fixture so hashes still describe the black matte inputs.
  const subjectPath = join(black.projectDir, "Plans/Subjects/raw-001/v001/source-a-v001.json");
  await unlink(subjectPath);
  for (const frame of black.map.frames) {
    frame.matte.sha256 = await sha256File(join(black.projectDir, frame.matte.path));
    frame.matte.bytes = (await stat(join(black.projectDir, frame.matte.path))).size;
  }
  const replacement = await storeArtifact(black.projectDir, "Plans/Subjects/raw-001/v001/source-a-v001.json", {
    ...black.subject.artifact, payload: black.map,
  });
  await assert.rejects(buildArtifactForegroundSidecar(black.projectDir, {...black.input, subjectMapArtifactRef: replacement.artifactRef}), /alpha|shell failed/iu);
});
