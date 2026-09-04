import {createHash, randomUUID} from "node:crypto";
import {realpath} from "node:fs/promises";
import {dirname, extname, join} from "node:path";
import {fileURLToPath} from "node:url";

import {createArtifactEnvelope, validateArtifactEnvelope, verifyArtifactParents} from "./artifacts.mjs";
import {runProcess} from "./process.mjs";
import {
  copyExclusiveFile, hashFileNoFollow, makeDirectories, makeExclusiveDirectory, readFileNoFollow,
  removeOwnedFile, removeOwnedStage, renameExclusive, writeExclusiveFile,
} from "./release-fs.mjs";
import {validatePngBytes, validateRequiredMattes} from "./subject-map.mjs";
import {getWorkItem, readWorkflowState} from "./workflow.mjs";

const shell = fileURLToPath(new URL("../scripts/video/build-foreground-sidecar.sh", import.meta.url));
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const QUALITY = Object.freeze({minConfidence: 0.8, maxJitterPx: 6, maxChatterRatio: 0.02, maxEdgeHaloPx: 3});
const pad = (value) => String(value).padStart(3, "0");
const frameName = (index) => `${String(index).padStart(6, "0")}.png`;

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value) || value === "." || value === "..") throw new Error(`${label} must be a safe identifier`);
  return value;
}

function ref(value, label) {
  const artifactId = value?.artifactId ?? value?.id;
  if (typeof artifactId !== "string" || !artifactId.trim() || !SHA256.test(value?.sha256)) throw new Error(`${label} requires an immutable artifact reference`);
  return {artifactId, sha256: value.sha256};
}

function parentMap(value) {
  const entries = value instanceof Map ? [...value.entries()] : value;
  if (!Array.isArray(entries)) throw new Error("Current media-index parents are required");
  const current = new Map();
  for (const entry of entries) {
    const artifactId = Array.isArray(entry) ? entry[0] : entry?.artifactId;
    const sha256 = Array.isArray(entry) ? entry[1] : entry?.sha256;
    if (typeof artifactId !== "string" || !artifactId.trim() || !SHA256.test(sha256) || current.has(artifactId)) {
      throw new Error("Current media-index parents must contain unique SHA-256 refs");
    }
    current.set(artifactId, sha256);
  }
  return current;
}

const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function readBoundPath(root, path, dependencies, label) {
  const [contents, descriptor] = await Promise.all([dependencies.readFileNoFollow(root, path), dependencies.hashNoFollow(root, path)]);
  const sha256 = sha256Bytes(contents.bytes);
  if (sha256 !== descriptor.sha256 || contents.bytes.length !== descriptor.bytes
    || contents.owner.dev !== descriptor.owner.dev || contents.owner.ino !== descriptor.owner.ino) {
    throw new Error(`${label} buffer does not match exact no-follow pathname bytes`);
  }
  return {bytes: contents.bytes, sha256, size: contents.bytes.length, owner: contents.owner, mtimeMs: descriptor.mtimeMs};
}

function sameSnapshot(left, right) {
  return left.sha256 === right.sha256 && left.size === right.size && left.owner.dev === right.owner.dev
    && left.owner.ino === right.owner.ino && left.mtimeMs === right.mtimeMs;
}

async function readArtifact(root, path, expected, label, dependencies) {
  const snapshot = await readBoundPath(root, path, dependencies, label);
  if (snapshot.sha256 !== expected.sha256) throw new Error(`${label} ref does not match exact stored bytes`);
  let artifact;
  try { artifact = JSON.parse(snapshot.bytes.toString("utf8")); } catch { throw new Error(`${label} is not valid JSON`); }
  validateArtifactEnvelope(artifact);
  if (artifact.artifactId !== expected.artifactId) throw new Error(`${label} ID does not match its ref`);
  return {artifact, snapshot};
}

function rate(value, label) {
  const match = typeof value === "string" ? /^([1-9]\d*)\/([1-9]\d*)$/u.exec(value) : null;
  if (!match) throw new Error(`${label} must be a positive rational frame rate`);
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) throw new Error(`${label} is outside the safe integer range`);
  return {text: `${numerator}/${denominator}`, value: numerator / denominator};
}

function assertSubjectMap(subject, source, fps, durationMs, matteBasePath) {
  const map = subject.payload;
  if (map?.kind !== "subject-map" || map.sourceId !== source.id || map.sourceSha256 !== source.sha256
    || map.sourceSnapshot?.sha256 !== source.sha256 || map.sourceSnapshot?.bytes !== source.bytes) {
    throw new Error("SubjectMap is cross-source or does not match the locked media-index source");
  }
  if (map.frameSize?.width !== source.width || map.frameSize?.height !== source.height
    || map.timeRangeMs?.startMs !== 0 || map.timeRangeMs?.endMs !== durationMs || map.sampleFps !== fps.value) {
    throw new Error("SubjectMap geometry, duration, or frame rate does not match the locked media-index source");
  }
  if (map.tracking?.status !== "tracked" || map.tracking?.discontinuities?.length
    || !Number.isFinite(map.tracking?.maxJitterPx) || map.tracking.maxJitterPx > QUALITY.maxJitterPx
    || !Array.isArray(map.frames) || !map.frames.length || map.frames.length !== map.expectedFrameCount
    || map.frames.some((frame) => !frame?.subjectBox || !Number.isFinite(frame.confidence) || frame.confidence < QUALITY.minConfidence)) {
    throw new Error("Foreground sidecar requires strict continuous high-confidence subject tracking");
  }
  if (map.mattes?.complete !== true || map.mattes.coverage !== 1 || !Number.isFinite(map.mattes.maxChatterRatio)
    || !Number.isFinite(map.mattes.maxEdgeHaloPx)) throw new Error("Foreground sidecar requires complete measured matte quality");
  validateRequiredMattes(map, QUALITY);
  const expectedFrameCount = Math.max(1, Math.ceil(durationMs * fps.value / 1000));
  if (map.expectedFrameCount !== expectedFrameCount) throw new Error("SubjectMap matte count does not cover every source frame");
  for (const [index, frame] of map.frames.entries()) {
    if (frame.index !== index || frame.timeMs !== Math.round(index * 1000 / fps.value)) {
      throw new Error(`SubjectMap frame ${index} is out of order or off cadence`);
    }
    if (frame.matte.path !== `${matteBasePath}/${frameName(index)}` || !SHA256.test(frame.matte.sha256)
      || !Number.isSafeInteger(frame.matte.bytes) || frame.matte.bytes < 1) {
      throw new Error(`SubjectMap matte frame ${index} lacks exact source-bound path, hash, or bytes`);
    }
  }
  return map;
}

function parseProbe(result, source, fps, frameCount, sourceSha256, matteSha256) {
  if (result.code !== 0 || result.truncated || (result.stderr ?? "").trim()) throw new Error("Foreground sidecar ffprobe validation failed");
  let probe;
  try { probe = JSON.parse(result.stdout); } catch { throw new Error("Foreground sidecar ffprobe output is invalid JSON"); }
  const streams = probe.streams?.filter(({codec_type}) => codec_type === "video") ?? [];
  const stream = streams[0];
  const actualRate = rate(stream?.avg_frame_rate ?? stream?.r_frame_rate, "Foreground frame rate");
  const frames = Number(stream?.nb_read_frames);
  const duration = Number(stream?.duration ?? probe.format?.duration);
  const tags = probe.format?.tags ?? {};
  if (streams.length !== 1 || stream.codec_name !== "prores" || !/^4444(?: XQ)?$/u.test(stream.profile ?? "")
    || !/^yuva444p(?:10|12)le$/u.test(stream.pix_fmt ?? "") || stream.width !== source.width || stream.height !== source.height
    || Math.abs(actualRate.value - fps.value) > Number.EPSILON || frames !== frameCount
    || !Number.isFinite(duration) || Math.abs(duration - source.durationSeconds) > 0.5 / fps.value
    || tags.content_hub_source_sha256 !== sourceSha256 || tags.content_hub_matte_sha256 !== matteSha256) {
    throw new Error("Foreground sidecar output metadata does not match source, mattes, or ProRes 4444 contract");
  }
  return {codec: stream.codec_name, profile: stream.profile, pixelFormat: stream.pix_fmt, width: stream.width, height: stream.height,
    fps: fps.text, frameCount: frames, durationSeconds: duration};
}

async function publishArtifact(root, path, artifact, dependencies, onWrite) {
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  await dependencies.makeDirectories(root, dirname(path));
  const owner = await dependencies.writeExclusiveFile(root, path, bytes);
  onWrite(owner);
  const stored = await readBoundPath(root, path, dependencies, "Foreground artifact");
  if (stored.sha256 !== sha256Bytes(bytes) || stored.size !== bytes.length
    || stored.owner.dev !== owner.dev || stored.owner.ino !== owner.ino) throw new Error("Foreground artifact changed after publication");
  return stored;
}

async function cleanupOwnedDirectory(root, path, owner, files, dependencies) {
  let intact = true;
  for (const file of files) {
    const removed = await dependencies.removeOwnedFile(root, `${path}/${file.name}`, file.owner).catch(() => false);
    intact &&= removed;
  }
  if (intact) await dependencies.removeOwnedStage(root, path, owner).catch(() => false);
}

export async function buildArtifactForegroundSidecar(projectDir, input, adapters = {}) {
  const dependencies = {
    run: adapters.run ?? runProcess,
    hashNoFollow: adapters.hashNoFollow ?? hashFileNoFollow,
    copyExclusiveFile: adapters.copyExclusiveFile ?? copyExclusiveFile,
    makeDirectories: adapters.makeDirectories ?? makeDirectories,
    makeExclusiveDirectory: adapters.makeExclusiveDirectory ?? makeExclusiveDirectory,
    readFileNoFollow: adapters.readFileNoFollow ?? readFileNoFollow,
    removeOwnedFile: adapters.removeOwnedFile ?? removeOwnedFile,
    removeOwnedStage: adapters.removeOwnedStage ?? removeOwnedStage,
    renameExclusive: adapters.renameExclusive ?? renameExclusive,
    writeExclusiveFile: adapters.writeExclusiveFile ?? writeExclusiveFile,
    readWorkflowState: adapters.readWorkflowState ?? readWorkflowState,
  };
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Foreground sidecar input is required");
  const root = await realpath(projectDir);
  const workItemId = safeId(input.workItemId, "Foreground work item ID");
  if (!Number.isInteger(input.revision) || input.revision < 1 || input.revision > 999) throw new Error("Foreground revision must be 1-999");
  if (!input.versions || typeof input.versions !== "object" || input.producer?.role !== "foreground-sidecar-executor"
    || typeof input.producer?.actorId !== "string" || !input.producer.actorId.trim() || !["raw-video", "multi-clip"].includes(input.modality)) {
    throw new Error("Foreground executor, modality, and versions are required");
  }
  const workflow = await dependencies.readWorkflowState(root);
  const item = getWorkItem(workflow, workItemId);
  if (item.revision !== input.revision || item.modality !== input.modality || item.state !== "STORY_PLANNED") {
    throw new Error("Foreground sidecar requires the current STORY_PLANNED work item");
  }

  const revision = pad(input.revision);
  const indexRef = ref(input.mediaIndexArtifactRef, "Media-index artifact ref");
  const indexPath = `Plans/MediaIndex/${workItemId}/media-index-v${revision}.json`;
  const indexRead = await readArtifact(root, indexPath, indexRef, "Media-index", dependencies);
  const index = indexRead.artifact;
  if (index.artifactId !== `media-index:${workItemId}:v${revision}` || index.workItemId !== workItemId || index.revision !== input.revision
    || index.modality !== input.modality || index.status !== "frozen" || index.payload?.kind !== "media-index") {
    throw new Error("Media-index is not current foreground source evidence");
  }
  verifyArtifactParents(index, parentMap(input.currentParents));
  const subjectRef = ref(input.subjectMapArtifactRef, "SubjectMap artifact ref");
  const legacySubjectId = `subject-map:${workItemId}:v${revision}`;
  const legacy = input.singleSourceCompatibility === true;
  let sourceId;
  if (legacy) {
    if (input.modality !== "raw-video" || index.payload.sources.length !== 1 || subjectRef.artifactId !== legacySubjectId) {
      throw new Error("Legacy SubjectMap compatibility requires the singular ref for one raw-video source");
    }
    sourceId = safeId(index.payload.sources[0]?.id, "Media-index source ID");
  } else {
    const prefix = `subject-map:${workItemId}:`;
    const suffix = `:v${revision}`;
    if (!subjectRef.artifactId.startsWith(prefix) || !subjectRef.artifactId.endsWith(suffix)) {
      throw new Error("SubjectMap ref must identify the exact foreground source");
    }
    sourceId = safeId(subjectRef.artifactId.slice(prefix.length, -suffix.length), "SubjectMap source ID");
  }
  const indexedSource = index.payload.sources?.find(({id}) => id === sourceId);
  const video = indexedSource?.video?.[0];
  if (!indexedSource || !SHA256.test(indexedSource.sha256) || !Number.isSafeInteger(indexedSource.bytes) || indexedSource.bytes < 1
    || typeof indexedSource.path !== "string" || !Number.isSafeInteger(video?.width) || video.width < 1
    || !Number.isSafeInteger(video?.height) || video.height < 1 || !Number.isFinite(indexedSource.durationSeconds) || indexedSource.durationSeconds <= 0) {
    throw new Error("Foreground source ID must select one valid media-index video source");
  }
  const fps = rate(video.avgFrameRate, "Media-index frame rate");
  const source = {id: sourceId, path: indexedSource.path, sha256: indexedSource.sha256, bytes: indexedSource.bytes,
    width: video.width, height: video.height, durationSeconds: indexedSource.durationSeconds};
  const subjectPath = legacy
    ? `Plans/Subjects/${workItemId}/subject-map-v${revision}.json`
    : `Plans/Subjects/${workItemId}/v${revision}/${sourceId}-v${revision}.json`;
  const subjectRead = await readArtifact(root, subjectPath, subjectRef, "SubjectMap", dependencies);
  const subject = subjectRead.artifact;
  if (subject.producer?.role !== "subject-analyst" || subject.workItemId !== workItemId || subject.revision !== input.revision
    || subject.modality !== input.modality || subject.status !== "frozen" || subject.parents.length !== 1
    || subject.parents[0].artifactId !== indexRef.artifactId || subject.parents[0].sha256 !== indexRef.sha256) {
    throw new Error("SubjectMap does not bind the locked media-index parent");
  }
  const durationMs = Math.round(source.durationSeconds * 1000);
  const matteBasePath = `Renders/Subject-Mattes/${workItemId}/${sourceId}/v${revision}`;
  const subjectMap = assertSubjectMap(subject, source, fps, durationMs, matteBasePath);

  const sourceBefore = await readBoundPath(root, source.path, dependencies, "Source");
  if (sourceBefore.sha256 !== source.sha256 || sourceBefore.size !== source.bytes) throw new Error("Source does not match its locked media-index bytes");
  const matteInputs = [];
  for (const [index, frame] of subjectMap.frames.entries()) {
    const snapshot = await readBoundPath(root, frame.matte.path, dependencies, `Matte frame ${index}`);
    if (snapshot.sha256 !== frame.matte.sha256 || snapshot.size !== frame.matte.bytes) throw new Error(`Matte frame ${index} changed from SubjectMap evidence`);
    validatePngBytes(snapshot.bytes, source.width, source.height);
    matteInputs.push({path: frame.matte.path, snapshot});
  }
  const matteSha256 = sha256Bytes(Buffer.from(matteInputs.map(({snapshot}) => snapshot.sha256).join(""), "utf8"));

  const parent = `Renders/Foreground/${workItemId}/${sourceId}`;
  const stage = `${parent}/.v${revision}-${randomUUID()}`;
  const final = `${parent}/v${revision}`;
  const outputRelative = `${final}/foreground.mov`;
  const planPath = `Plans/Foreground/${workItemId}/${sourceId}/foreground-sidecar-v${revision}.json`;
  await dependencies.makeDirectories(root, parent);
  const stageOwner = await dependencies.makeExclusiveDirectory(root, stage);
  let published = false;
  let planOwner;
  const ownedFiles = [];
  try {
    const sourceTarget = `${stage}/source${extname(source.path).toLowerCase() || ".video"}`;
    const sourceOwner = await dependencies.copyExclusiveFile(root, source.path, sourceTarget);
    const sourceCopy = await readBoundPath(root, sourceTarget, dependencies, "Source snapshot");
    if (sourceCopy.sha256 !== source.sha256 || sourceCopy.size !== source.bytes
      || sourceCopy.owner.dev !== sourceOwner.dev || sourceCopy.owner.ino !== sourceOwner.ino) throw new Error("Source snapshot changed");
    ownedFiles.push({name: sourceTarget.slice(stage.length + 1), owner: sourceCopy.owner});
    const matteCopies = [];
    for (const [index, matte] of matteInputs.entries()) {
      const target = `${stage}/${frameName(index)}`;
      const owner = await dependencies.copyExclusiveFile(root, matte.path, target);
      const copy = await readBoundPath(root, target, dependencies, `Matte snapshot ${index}`);
      if (copy.sha256 !== matte.snapshot.sha256 || copy.size !== matte.snapshot.size
        || copy.owner.dev !== owner.dev || copy.owner.ino !== owner.ino) throw new Error(`Matte snapshot ${index} changed`);
      matteCopies.push({path: target, snapshot: copy});
      ownedFiles.push({name: frameName(index), owner: copy.owner});
    }

    const built = await dependencies.run(shell, [join(root, sourceTarget), join(root, stage), fps.text,
      join(root, `${stage}/foreground.mov`)], {timeoutMs: 1_800_000, maxBytes: 4 * 1024 * 1024});
    if (built.code !== 0 || built.truncated || (built.stderr ?? "").trim()) {
      throw new Error(`Foreground sidecar shell failed: ${(built.stderr ?? "").trim() || `status ${built.code}`}`);
    }
    const rendered = await readBoundPath(root, `${stage}/foreground.mov`, dependencies, "Foreground output");
    if (rendered.size < 1) throw new Error("Foreground sidecar output is empty");
    ownedFiles.push({name: "foreground.mov", owner: rendered.owner});

    const currentIndex = await readArtifact(root, indexPath, indexRef, "Media-index", dependencies);
    const currentSubject = await readArtifact(root, subjectPath, subjectRef, "SubjectMap", dependencies);
    const currentSource = await readBoundPath(root, source.path, dependencies, "Source");
    if (!sameSnapshot(indexRead.snapshot, currentIndex.snapshot) || !sameSnapshot(subjectRead.snapshot, currentSubject.snapshot)
      || !sameSnapshot(sourceBefore, currentSource)) throw new Error("Foreground inputs changed during render");
    for (const [index, matte] of matteInputs.entries()) {
      if (!sameSnapshot(matte.snapshot, await readBoundPath(root, matte.path, dependencies, `Matte frame ${index}`))) {
        throw new Error(`Matte frame ${index} changed during render`);
      }
      if (!sameSnapshot(matteCopies[index].snapshot, await readBoundPath(root, matteCopies[index].path, dependencies, `Matte snapshot ${index}`))) {
        throw new Error(`Matte snapshot ${index} changed during render`);
      }
    }
    if (!sameSnapshot(sourceCopy, await readBoundPath(root, sourceTarget, dependencies, "Source snapshot"))) throw new Error("Source snapshot changed during render");

    const outputPath = join(root, `${stage}/foreground.mov`);
    const probe = await dependencies.run("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", outputPath],
      {timeoutMs: 120_000, maxBytes: 4 * 1024 * 1024});
    const media = parseProbe(probe, source, fps, matteInputs.length, source.sha256, matteSha256);
    const recheckPublication = async (label) => {
      const currentItem = getWorkItem(await dependencies.readWorkflowState(root), workItemId);
      if (currentItem.revision !== input.revision || currentItem.modality !== input.modality || currentItem.state !== "STORY_PLANNED") {
        throw new Error(`Foreground workflow changed ${label}`);
      }
      const currentIndex = await readArtifact(root, indexPath, indexRef, "Media-index", dependencies);
      const currentSubject = await readArtifact(root, subjectPath, subjectRef, "SubjectMap", dependencies);
      const currentSource = await readBoundPath(root, source.path, dependencies, "Source");
      if (!sameSnapshot(indexRead.snapshot, currentIndex.snapshot) || !sameSnapshot(subjectRead.snapshot, currentSubject.snapshot)
        || !sameSnapshot(sourceBefore, currentSource)) throw new Error(`Foreground inputs changed ${label}`);
      for (const [index, matte] of matteInputs.entries()) {
        if (!sameSnapshot(matte.snapshot, await readBoundPath(root, matte.path, dependencies, `Matte frame ${index}`))) {
          throw new Error(`Matte frame ${index} changed ${label}`);
        }
        if (!sameSnapshot(matteCopies[index].snapshot, await readBoundPath(root,
          `${published ? final : stage}/${frameName(index)}`, dependencies, `Matte snapshot ${index}`))) {
          throw new Error(`Matte snapshot ${index} changed ${label}`);
        }
      }
      if (!sameSnapshot(sourceCopy, await readBoundPath(root, `${published ? final : stage}/${sourceTarget.slice(stage.length + 1)}`,
        dependencies, "Source snapshot"))) throw new Error(`Source snapshot changed ${label}`);
      const output = await readBoundPath(root, `${published ? final : stage}/foreground.mov`, dependencies, "Foreground output");
      if (!sameSnapshot(rendered, output)) throw new Error(`Foreground output changed ${label}`);
      const currentProbe = await dependencies.run("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json",
        join(root, `${published ? final : stage}/foreground.mov`)], {timeoutMs: 120_000, maxBytes: 4 * 1024 * 1024});
      const currentMedia = parseProbe(currentProbe, source, fps, matteInputs.length, source.sha256, matteSha256);
      if (JSON.stringify(currentMedia) !== JSON.stringify(media)) throw new Error(`Foreground output probe facts changed ${label}`);
      return output;
    };
    const alpha = await dependencies.run("ffmpeg", ["-v", "error", "-xerror", "-i", outputPath,
      "-vf", "alphaextract,signalstats,metadata=print:key=lavfi.signalstats.YMAX:file=-", "-f", "null", "-"],
    {timeoutMs: 300_000, maxBytes: 4 * 1024 * 1024});
    const alphaValues = [...String(alpha.stdout ?? "").matchAll(/lavfi\.signalstats\.YMAX=(\d+(?:\.\d+)?)/gu)].map((match) => Number(match[1]));
    if (alpha.code !== 0 || alpha.truncated || (alpha.stderr ?? "").trim() || !alphaValues.some((value) => value > 0)) {
      throw new Error("Foreground sidecar alpha is missing, undecodable, or all black");
    }
    const decoded = await dependencies.run("ffmpeg", ["-v", "error", "-xerror", "-err_detect", "explode", "-i", outputPath,
      "-map", "0:v:0", "-f", "null", "-"], {timeoutMs: 300_000, maxBytes: 4 * 1024 * 1024});
    if (decoded.code !== 0 || decoded.truncated || (decoded.stderr ?? "").trim()) throw new Error("Foreground sidecar failed full decode");
    const outputBefore = await readBoundPath(root, `${stage}/foreground.mov`, dependencies, "Foreground output");
    if (!sameSnapshot(rendered, outputBefore)) throw new Error("Foreground output changed during validation");

    await dependencies.renameExclusive(root, stage, final, stageOwner);
    published = true;
    const outputAfter = await recheckPublication("before artifact publication");
    const artifact = createArtifactEnvelope({
      artifactId: `foreground-sidecar:${workItemId}:${sourceId}:v${revision}`,
      revision: input.revision, workItemId, modality: input.modality, parents: [subjectRef, indexRef], producer: input.producer,
      versions: input.versions, status: "frozen", deviations: [],
      payload: {
        kind: "foreground-sidecar",
        source: {id: source.id, path: source.path, sha256: source.sha256, bytes: source.bytes},
        mattes: {count: matteInputs.length, sha256: matteSha256},
        output: {path: outputRelative, sha256: outputAfter.sha256, bytes: outputAfter.size, ...media},
      },
    });
    const stored = await publishArtifact(root, planPath, artifact, dependencies, (owner) => { planOwner = owner; });
    await recheckPublication("after artifact publication");
    return {artifact, artifactRef: {artifactId: artifact.artifactId, sha256: stored.sha256}, path: outputRelative};
  } catch (error) {
    if (planOwner) await dependencies.removeOwnedFile(root, planPath, planOwner).catch(() => false);
    if (published) await cleanupOwnedDirectory(root, final, stageOwner, ownedFiles, dependencies);
    throw error;
  } finally {
    if (!published) await cleanupOwnedDirectory(root, stage, stageOwner, ownedFiles, dependencies);
  }
}
