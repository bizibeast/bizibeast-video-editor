import {createHash, randomUUID} from "node:crypto";
import {realpath} from "node:fs/promises";
import {basename, dirname, extname, join} from "node:path";
import {fileURLToPath} from "node:url";

import {createArtifactEnvelope, validateArtifactEnvelope, verifyArtifactParents} from "./artifacts.mjs";
import {confinedProjectPath} from "./paths.mjs";
import {runProcess} from "./process.mjs";
import {
  copyExclusiveFile,
  hashFileNoFollow,
  makeDirectories,
  makeExclusiveDirectory,
  readFileNoFollow,
  removeOwnedFile,
  removeOwnedStage,
  renameExclusive,
  writeExclusiveFile,
} from "./release-fs.mjs";
import {getWorkItem, readWorkflowState} from "./workflow.mjs";

const analyzerScript = fileURLToPath(new URL("../scripts/video/analyze-subject.sh", import.meta.url));
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const DEFAULT_THRESHOLDS = Object.freeze({minConfidence: 0.8, maxJitterPx: 6, maxChatterRatio: 0.02, maxEdgeHaloPx: 3});
const pad = (value) => String(value).padStart(3, "0");
const rounded = (value) => Math.round(value * 1_000_000) / 1_000_000;

function required(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

function safeId(value, label) {
  if (!SAFE_ID.test(value) || value === "." || value === "..") throw new Error(`${label} must be a safe identifier`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function finiteRange(value, label, {min = 0, max = Number.POSITIVE_INFINITY} = {}) {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}`);
  return value;
}

function strictBoolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function detectorError(available, value, label) {
  if (available) {
    if (value !== null) throw new Error(`${label} must be null when analysis is available`);
    return null;
  }
  return required(value, label);
}

function artifactRef(value, label) {
  const id = value?.id ?? value?.artifactId;
  if (typeof id !== "string" || !id.trim() || !SHA256.test(value?.sha256)) throw new Error(`${label} must contain an artifact id and SHA-256`);
  return {artifactId: id, sha256: value.sha256};
}

function parentMap(value) {
  const entries = value instanceof Map ? [...value.entries()] : value;
  if (!Array.isArray(entries)) throw new Error("Current media-index parents are required");
  const current = new Map();
  for (const entry of entries) {
    const id = Array.isArray(entry) ? entry[0] : entry?.artifactId;
    const sha256 = Array.isArray(entry) ? entry[1] : entry?.sha256;
    if (typeof id !== "string" || !id.trim() || !SHA256.test(sha256) || current.has(id)) throw new Error("Current media-index parents must have unique SHA-256 refs");
    current.set(id, sha256);
  }
  return current;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return rounded(sorted[Math.floor((sorted.length - 1) / 2)]);
}

function iou(left, right) {
  if (!left || !right) return 0;
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const intersection = width * height;
  return intersection / (left.width * left.height + right.width * right.height - intersection);
}

function pixelBox(value, width, height, label) {
  if (!value || typeof value !== "object" || [value.x, value.y, value.width, value.height].some((part) => !Number.isSafeInteger(part))
    || value.x < 0 || value.y < 0 || value.width < 1 || value.height < 1
    || value.x + value.width > width || value.y + value.height > height) throw new Error(`${label} must stay within frame bounds`);
  return {x: value.x, y: value.y, width: value.width, height: value.height};
}

function centerDistance(left, right) {
  if (!left || !right) return 0;
  return rounded(Math.hypot(left.x + left.width / 2 - right.x - right.width / 2, left.y + left.height / 2 - right.y - right.height / 2));
}

function thresholds(input) {
  const value = {...DEFAULT_THRESHOLDS, ...(input.qualityThresholds ?? {})};
  finiteRange(value.minConfidence, "Minimum confidence", {max: 1});
  for (const key of ["maxJitterPx", "maxChatterRatio", "maxEdgeHaloPx"]) finiteRange(value[key], key);
  return value;
}

export function validateRequiredMattes(subjectMap, quality = DEFAULT_THRESHOLDS) {
  for (const frame of subjectMap?.frames ?? []) {
    if (!frame?.subjectBox || !frame.matte || typeof frame.matte.path !== "string" || frame.matte.coverage <= 0
      || !Number.isFinite(frame.matte.chatterRatio) || !Number.isFinite(frame.matte.edgeHaloPx)) {
      throw new Error(`Missing or invalid required matte frame ${frame?.index ?? "unknown"}`);
    }
  }
  if (!subjectMap?.frames?.length || subjectMap.frames.length !== subjectMap.expectedFrameCount) throw new Error("Missing required matte frame samples");
  if (subjectMap.mattes.maxChatterRatio > quality.maxChatterRatio) throw new Error("Required matte chatter exceeds quality threshold");
  if (subjectMap.mattes.maxEdgeHaloPx > quality.maxEdgeHaloPx) throw new Error("Required matte halo exceeds quality threshold");
  return subjectMap;
}

export function normalizeVisionOutput(raw, input) {
  if (!raw || typeof raw !== "object" || raw.schemaVersion !== 1 || !Array.isArray(raw.frames)) throw new Error("Vision output is invalid");
  if (!SHA256.test(input.sourceSha256) || raw.sourceSha256 !== input.sourceSha256) throw new Error("Subject analysis source hash mismatch");
  if (raw.sourceBytes !== input.sourceBytes) throw new Error("Subject analysis source byte count mismatch");
  const width = positiveInteger(raw.width, "Vision width");
  const height = positiveInteger(raw.height, "Vision height");
  if (width !== input.frameSize?.width || height !== input.frameSize?.height) throw new Error("Subject analysis decoded dimensions mismatch");
  const expectedRange = input.timeRangeMs;
  if (!expectedRange || raw.durationMs !== expectedRange.endMs - expectedRange.startMs
    || raw.timeRangeMs?.startMs !== expectedRange.startMs || raw.timeRangeMs?.endMs !== expectedRange.endMs) {
    throw new Error("Subject analysis time range mismatch");
  }
  const sampleFps = finiteRange(raw.sampleFps, "Vision sample fps", {min: Number.EPSILON, max: 60});
  if (sampleFps !== input.sampleFps) throw new Error("Subject analysis sample fps mismatch");
  const expectedFrameCount = Math.max(1, Math.ceil((expectedRange.endMs - expectedRange.startMs) * sampleFps / 1000));
  if (raw.frames.length !== expectedFrameCount) throw new Error("Subject analysis sample frame count mismatch");
  const quality = thresholds(input);
  const frames = [];
  for (const [position, rawFrame] of raw.frames.entries()) {
    if (rawFrame?.index !== position) throw new Error(`Subject analysis frame index ${position} is invalid`);
    if (!Number.isSafeInteger(rawFrame.timeMs) || rawFrame.timeMs < expectedRange.startMs || rawFrame.timeMs >= expectedRange.endMs) {
      throw new Error(`Subject analysis frame time ${position} is outside the source range`);
    }
    if (position && rawFrame.timeMs <= raw.frames[position - 1].timeMs) throw new Error("Subject analysis sample times must be strictly monotonic");
    const expectedTime = expectedRange.startMs + position * 1000 / sampleFps;
    if (Math.abs(rawFrame.timeMs - expectedTime) > 500 / sampleFps) throw new Error(`Subject analysis frame ${position} falls outside sample cadence`);
    if (!Array.isArray(rawFrame.faces)) throw new Error(`Subject analysis faces ${position} must be an array`);
    const faceAnalysisAvailable = strictBoolean(rawFrame.faceAnalysisAvailable, `Face analysis availability ${position}`);
    const faceAnalysisError = detectorError(faceAnalysisAvailable, rawFrame.faceAnalysisError, `Face analysis error ${position}`);
    const faces = rawFrame.faces.map((face, faceIndex) => {
      const confidence = finiteRange(face?.confidence, `Face confidence ${position}:${faceIndex}`, {max: 1});
      return {box: pixelBox(face.box, width, height, `Face ${position}:${faceIndex}`), confidence};
    });
    const subjectBox = rawFrame.subjectBox === null ? null : pixelBox(rawFrame.subjectBox, width, height, `Subject ${position}`);
    const subjectConfidence = rawFrame.subjectConfidence === null ? null : finiteRange(rawFrame.subjectConfidence, `Subject confidence ${position}`, {max: 1});
    if (Boolean(subjectBox) !== Number.isFinite(subjectConfidence)) throw new Error(`Subject confidence ${position} must match its subject box`);
    const personAnalysisAvailable = strictBoolean(rawFrame.personAnalysisAvailable, `Person analysis availability ${position}`);
    const personAnalysisError = detectorError(personAnalysisAvailable, rawFrame.personAnalysisError, `Person analysis error ${position}`);
    const segmentationAttempted = strictBoolean(rawFrame.segmentationAttempted, `Segmentation attempted ${position}`);
    const segmentationAvailable = strictBoolean(rawFrame.segmentationAvailable, `Segmentation availability ${position}`);
    if (segmentationAttempted !== Boolean(input.matteRequested) || (!segmentationAttempted && segmentationAvailable)) {
      throw new Error(`Segmentation attempted ${position} does not match the requested matte mode`);
    }
    let segmentationError = null;
    if (segmentationAttempted) segmentationError = detectorError(segmentationAvailable, rawFrame.segmentationError, `Segmentation error ${position}`);
    else if (rawFrame.segmentationError !== null) throw new Error(`Segmentation error ${position} must be null when not attempted`);
    const previous = frames.at(-1);
    const discontinuity = Boolean(previous && ((!previous.subjectBox !== !subjectBox) || (previous.subjectBox && iou(previous.subjectBox, subjectBox) < 0.2)));
    const jitterPx = previous ? centerDistance(previous.subjectBox, subjectBox) : 0;
    const matteCoverage = finiteRange(rawFrame.matteCoverage, `Matte coverage ${position}`, {max: 1});
    const edgeHaloPx = finiteRange(rawFrame.edgeHaloPx, `Matte halo ${position}`);
    const previousCoverage = previous?.matte?.coverage ?? matteCoverage;
    if (rawFrame.mattePath !== null && (typeof rawFrame.mattePath !== "string" || basename(rawFrame.mattePath) !== rawFrame.mattePath)) {
      throw new Error(`Matte path ${position} must be a file name`);
    }
    if (rawFrame.mattePath !== null && (!segmentationAttempted || !segmentationAvailable)) throw new Error(`Matte path ${position} requires available segmentation`);
    const matte = rawFrame.mattePath === null ? null : {
      path: `${required(input.matteBasePath, "Matte base path")}/${String(rawFrame.mattePath)}`,
      coverage: matteCoverage,
      chatterRatio: rounded(Math.abs(matteCoverage - previousCoverage)),
      edgeHaloPx,
    };
    const avoidRegions = [
      ...faces.map((face) => ({kind: "face", box: face.box, confidence: face.confidence})),
      ...(subjectBox ? [{kind: "subject", box: subjectBox, confidence: subjectConfidence}] : []),
    ];
    frames.push({
      index: position,
      timeMs: rawFrame.timeMs,
      faces,
      faceAnalysisAvailable,
      faceAnalysisError,
      subjectBox,
      subjectConfidence,
      personAnalysisAvailable,
      personAnalysisError,
      segmentationAttempted,
      segmentationAvailable,
      segmentationError,
      confidence: subjectConfidence ?? median(faces.map(({confidence}) => confidence)),
      discontinuity,
      jitterPx,
      avoidRegions,
      mattePath: matte?.path ?? null,
      matte,
    });
  }
  const detected = frames.some((frame) => frame.subjectBox || frame.faces.length);
  const faceErrors = [...new Set(frames.flatMap(({faceAnalysisError}) => faceAnalysisError ? [faceAnalysisError] : []))];
  const personErrors = [...new Set(frames.flatMap(({personAnalysisError}) => personAnalysisError ? [personAnalysisError] : []))];
  const segmentationErrors = [...new Set(frames.flatMap(({segmentationError}) => segmentationError ? [segmentationError] : []))];
  const matteFrames = frames.filter(({matte}) => matte);
  const subjectMap = {
    schemaVersion: 1,
    sourceId: safeId(input.sourceId, "Source id"),
    sourceSha256: input.sourceSha256,
    sourceSnapshot: {sha256: input.sourceSha256, bytes: input.sourceBytes},
    timeRangeMs: {startMs: expectedRange.startMs, endMs: expectedRange.endMs},
    sampleFps,
    expectedFrameCount,
    coordinateSpace: "top-left-pixels",
    frameSize: {width, height},
    frames,
    avoidRegions: frames.flatMap((frame) => frame.avoidRegions.map((region) => ({timeMs: frame.timeMs, ...region}))),
    tracking: {
      status: detected ? "tracked" : "empty",
      faceAnalysisAvailable: faceErrors.length === 0,
      personAnalysisAvailable: personErrors.length === 0,
      faceConfidence: median(frames.flatMap(({faces}) => faces.map(({confidence}) => confidence))),
      subjectConfidence: median(frames.flatMap(({subjectConfidence}) => Number.isFinite(subjectConfidence) ? [subjectConfidence] : [])),
      confidence: median(frames.flatMap(({confidence}) => Number.isFinite(confidence) ? [confidence] : [])),
      discontinuities: frames.filter(({discontinuity}) => discontinuity).map(({timeMs}) => timeMs),
      jitterPx: median(frames.slice(1).map(({jitterPx}) => jitterPx)) ?? 0,
      maxJitterPx: Math.max(0, ...frames.map(({jitterPx}) => jitterPx)),
    },
    mattes: {
      requested: Boolean(input.matteRequested),
      required: Boolean(input.requiredMatte),
      coverage: frames.length ? matteFrames.length / frames.length : 0,
      complete: frames.length > 0 && matteFrames.length === frames.length && matteFrames.every(({matte}) => matte.coverage > 0),
      maxChatterRatio: Math.max(0, ...matteFrames.map(({matte}) => matte.chatterRatio)),
      maxEdgeHaloPx: Math.max(0, ...matteFrames.map(({matte}) => matte.edgeHaloPx)),
    },
    deviations: [
      ...(faceErrors.length ? [{code: "face-analysis-unavailable", reason: `Apple Vision face analysis was unavailable: ${faceErrors.join("; ")}`}] : []),
      ...(personErrors.length ? [{code: "person-analysis-unavailable", reason: `Apple Vision person analysis was unavailable: ${personErrors.join("; ")}`}] : []),
      ...(segmentationErrors.length ? [{code: "segmentation-unavailable", reason: `Apple Vision segmentation was unavailable: ${segmentationErrors.join("; ")}`}] : []),
      ...(!detected && !faceErrors.length && !personErrors.length && !segmentationErrors.length
        ? [{code: "no-subject-detected", reason: "Optional analysis found no face or person observations"}] : []),
    ],
  };
  if (input.requiredTracking || input.requiredMatte) {
    if (personErrors.length) throw new Error("Required person analysis unavailable");
    if (frames.some((frame) => !frame.subjectBox || frame.subjectConfidence < quality.minConfidence)) throw new Error("Required subject confidence is below quality threshold");
    if (subjectMap.tracking.maxJitterPx > quality.maxJitterPx || subjectMap.tracking.discontinuities.length) throw new Error("Required subject track exceeds jitter or continuity threshold");
  }
  if (input.requiredMatte) validateRequiredMattes(subjectMap, quality);
  return subjectMap;
}

function sameFile(left, right) {
  return left.sha256 === right.sha256 && left.bytes === right.bytes && left.owner.dev === right.owner.dev
    && left.owner.ino === right.owner.ino && left.mtimeMs === right.mtimeMs;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readBoundPath(root, path, dependencies, label) {
  const [contents, descriptor] = await Promise.all([
    dependencies.readFileNoFollow(root, path), dependencies.hashNoFollow(root, path),
  ]);
  const sha256 = sha256Bytes(contents.bytes);
  if (sha256 !== descriptor.sha256 || contents.bytes.length !== descriptor.bytes
    || contents.owner.dev !== descriptor.owner.dev || contents.owner.ino !== descriptor.owner.ino) {
    throw new Error(`${label} buffer does not match exact no-follow pathname bytes`);
  }
  return {bytes: contents.bytes, sha256, size: contents.bytes.length, owner: contents.owner, mtimeMs: descriptor.mtimeMs};
}

function sameBoundPath(left, right) {
  return left.sha256 === right.sha256 && left.size === right.size && left.owner.dev === right.owner.dev
    && left.owner.ino === right.owner.ino && left.mtimeMs === right.mtimeMs;
}

let pngCrcTable;
function crc32(bytes) {
  pngCrcTable ??= Array.from({length: 256}, (_, value) => {
    let result = value;
    for (let bit = 0; bit < 8; bit += 1) result = result & 1 ? 0xedb88320 ^ (result >>> 1) : result >>> 1;
    return result >>> 0;
  });
  let result = 0xffffffff;
  for (const byte of bytes) result = pngCrcTable[(result ^ byte) & 0xff] ^ (result >>> 8);
  return (result ^ 0xffffffff) >>> 0;
}

export function validatePngBytes(bytes, width, height) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    throw new Error("Matte PNG signature is invalid");
  }
  let offset = 8;
  let ihdr = false;
  let idat = false;
  let ended = false;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) throw new Error("Matte PNG is truncated");
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error("Matte PNG chunk is truncated");
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const body = bytes.subarray(offset + 4, offset + 8 + length);
    if (crc32(body) !== bytes.readUInt32BE(offset + 8 + length)) throw new Error(`Matte PNG ${type} CRC is invalid`);
    if (!ihdr) {
      if (type !== "IHDR" || length !== 13) throw new Error("Matte PNG must begin with one IHDR chunk");
      if (bytes.readUInt32BE(offset + 8) !== width || bytes.readUInt32BE(offset + 12) !== height) throw new Error("Matte PNG dimensions do not match the source");
      ihdr = true;
    } else if (type === "IHDR") throw new Error("Matte PNG contains duplicate IHDR chunks");
    if (type === "IDAT") idat = true;
    if (type === "IEND") {
      if (length !== 0 || !idat) throw new Error("Matte PNG IEND is invalid or missing image data");
      ended = true;
      offset = end;
      break;
    }
    offset = end;
  }
  if (!ended) throw new Error("Matte PNG is incomplete without IEND");
  if (offset !== bytes.length) throw new Error("Matte PNG has trailing bytes after IEND");
  return {width, height};
}

async function verifyMatteFiles(root, raw, stagePath, subjectMap, dependencies) {
  const snapshots = [];
  for (const [index, frame] of subjectMap.frames.entries()) {
    if (!frame.matte) {
      snapshots.push(null);
      continue;
    }
    if (raw.frames[index].mattePath !== `${String(index).padStart(6, "0")}.png`) throw new Error(`Invalid matte path for frame ${index}`);
    try {
      const path = `${stagePath}/${raw.frames[index].mattePath}`;
      const before = await readBoundPath(root, path, dependencies, `Matte frame ${index}`);
      validatePngBytes(before.bytes, subjectMap.frameSize.width, subjectMap.frameSize.height);
      const decoded = await dependencies.run("ffmpeg", [
        "-v", "error", "-xerror", "-err_detect", "explode", "-i", await confinedProjectPath(root, path, {type: "file"}), "-f", "null", "-",
      ], {timeoutMs: 120_000, maxBytes: 1024 * 1024});
      if (decoded.code !== 0 || decoded.truncated || (decoded.stderr ?? "").trim()) {
        throw new Error(`matte decode failed: ${(decoded.stderr ?? "").trim() || `status ${decoded.code}`}`);
      }
      const after = await readBoundPath(root, path, dependencies, `Matte frame ${index}`);
      if (!sameBoundPath(before, after)) throw new Error(`Matte frame ${index} changed during strict decode`);
      frame.matte.sha256 = before.sha256;
      frame.matte.bytes = before.size;
      snapshots.push(before);
    } catch (error) {
      if (subjectMap.mattes.required) throw new Error(`Missing or invalid required matte frame ${index}: ${error.message}`);
      throw error;
    }
  }
  return snapshots;
}

async function recheckFinalMattes(root, subjectMap, snapshots, dependencies, label) {
  for (const [index, frame] of subjectMap.frames.entries()) {
    if (!frame.matte) continue;
    const current = await readBoundPath(root, frame.matte.path, dependencies, `Final matte frame ${index}`);
    if (!sameBoundPath(snapshots[index], current) || current.sha256 !== frame.matte.sha256 || current.size !== frame.matte.bytes) {
      throw new Error(`Final matte frame ${index} changed ${label}`);
    }
  }
}

async function recheckWorkflow(root, workItemId, input, dependencies, label) {
  const item = getWorkItem(await dependencies.readWorkflowState(root), workItemId);
  if (item.revision !== input.revision || item.modality !== input.modality || item.state !== "STORY_PLANNED") {
    throw new Error(`Subject analysis workflow changed ${label}`);
  }
}

async function cleanupMattes(root, path, owner, subjectMap, snapshots, dependencies) {
  let intact = true;
  for (const [index, frame] of subjectMap?.frames?.entries?.() ?? []) {
    if (!frame.matte || !snapshots?.[index]) continue;
    const relative = `${path}/${String(index).padStart(6, "0")}.png`;
    const removed = await dependencies.removeOwnedFile(root, relative, snapshots[index].owner).catch(() => false);
    intact &&= removed;
  }
  if (intact) await dependencies.removeOwnedStage(root, path, owner).catch(() => false);
}

async function publishArtifact(root, path, artifact, dependencies, onWrite) {
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  const expected = createHash("sha256").update(bytes).digest("hex");
  await dependencies.makeDirectories(root, dirname(path));
  await confinedProjectPath(root, dirname(path), {type: "directory"});
  const owner = await dependencies.writeExclusiveFile(root, path, bytes);
  onWrite(owner);
  const stored = await dependencies.hashNoFollow(root, path);
  if (stored.sha256 !== expected || stored.bytes !== bytes.length || stored.owner.dev !== owner.dev || stored.owner.ino !== owner.ino) {
    throw new Error("Subject-map artifact bytes changed after publication");
  }
  return {owner, sha256: stored.sha256};
}

export async function runSubjectAnalysis(projectDir, input, adapters = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Subject analysis input is required");
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
  const root = await realpath(projectDir);
  const workItemId = safeId(required(input.workItemId, "Work item id"), "Work item id");
  if (!Number.isInteger(input.revision) || input.revision < 1 || input.revision > 999) throw new Error("Subject-map revision must be 1-999");
  if (!["raw-video", "multi-clip"].includes(input.modality)) throw new Error("Subject-map modality must be raw-video or multi-clip");
  if (input.producer?.role !== "subject-analyst") throw new Error("Subject-map producer role must be subject-analyst");
  required(input.producer?.actorId, "Subject-map producer actor id");
  if (!input.versions || typeof input.versions !== "object") throw new Error("Subject-map versions are required");
  const state = await dependencies.readWorkflowState(root);
  const item = getWorkItem(state, workItemId);
  if (item.revision !== input.revision || item.modality !== input.modality || item.state !== "STORY_PLANNED") {
    throw new Error("Subject analysis requires the exact STORY_PLANNED workflow item revision and modality");
  }
  const revision = pad(input.revision);
  const indexRef = artifactRef(input.mediaIndexArtifactRef, "Media-index artifact ref");
  const indexPath = `Plans/MediaIndex/${workItemId}/media-index-v${revision}.json`;
  const indexSnapshot = await readBoundPath(root, indexPath, dependencies, "Media-index");
  if (indexSnapshot.sha256 !== indexRef.sha256) {
    throw new Error("Media-index artifact ref does not match exact stored bytes");
  }
  let indexArtifact;
  try {
    indexArtifact = JSON.parse(indexSnapshot.bytes.toString("utf8"));
  } catch {
    throw new Error("Media-index artifact is not valid JSON");
  }
  validateArtifactEnvelope(indexArtifact);
  if (indexArtifact.artifactId !== indexRef.artifactId || indexArtifact.artifactId !== `media-index:${workItemId}:v${revision}`
    || indexArtifact.workItemId !== workItemId || indexArtifact.revision !== input.revision || indexArtifact.modality !== input.modality
    || indexArtifact.status !== "frozen" || indexArtifact.payload?.kind !== "media-index") {
    throw new Error("Media-index artifact does not match the subject-analysis workflow item");
  }
  verifyArtifactParents(indexArtifact, parentMap(input.currentParents));
  const sourceId = safeId(required(input.sourceId, "Source ID"), "Source ID");
  const indexedSource = indexArtifact.payload.sources?.find(({id}) => id === sourceId);
  const video = indexedSource?.video?.[0];
  if (!indexedSource || !SHA256.test(indexedSource.sha256) || !Number.isSafeInteger(indexedSource.bytes) || indexedSource.bytes < 1
    || typeof indexedSource.path !== "string" || !Number.isInteger(video?.width) || video.width < 1 || !Number.isInteger(video?.height) || video.height < 1
    || !Number.isFinite(indexedSource.durationSeconds) || indexedSource.durationSeconds <= 0) throw new Error("Source ID must select one valid media-index video source");
  const source = {
    id: sourceId, path: indexedSource.path, sha256: indexedSource.sha256, bytes: indexedSource.bytes,
    width: video.width, height: video.height, durationMs: Math.round(indexedSource.durationSeconds * 1000),
  };
  const singleSourceCompatibility = input.singleSourceCompatibility === true;
  if (input.singleSourceCompatibility !== undefined && typeof input.singleSourceCompatibility !== "boolean") {
    throw new Error("Single-source compatibility must be a boolean");
  }
  if (singleSourceCompatibility && (input.modality !== "raw-video" || indexArtifact.payload.sources.length !== 1)) {
    throw new Error("Single-source compatibility requires one raw-video source");
  }
  const currentIndex = await readBoundPath(root, indexPath, dependencies, "Media-index");
  if (!sameBoundPath(indexSnapshot, currentIndex)) throw new Error("Media-index changed during validation");
  const sampleFps = finiteRange(input.sampleFps, "Sample fps", {min: Number.EPSILON, max: 60});
  const requiredMatte = input.requiredMatte === true || input.backgroundRemoval === "required" || input.textBehindSubject === "required";
  const requiredTracking = input.requiredTracking === true || requiredMatte;
  const matteRequested = requiredMatte || input.generateMattes === true;
  await confinedProjectPath(root, source.path, {type: "file"});
  const before = await dependencies.hashNoFollow(root, source.path);
  if (before.sha256 !== source.sha256 || before.bytes !== source.bytes) throw new Error("Source does not match its frozen hash and byte count");
  const scratchPath = `Plans/.subject-${workItemId}-v${revision}-${randomUUID()}`;
  const matteParent = `Renders/Subject-Mattes/${workItemId}/${sourceId}`;
  const matteFinalPath = `${matteParent}/v${revision}`;
  const matteStagePath = `${matteParent}/.v${revision}-${randomUUID()}`;
  await dependencies.makeDirectories(root, "Plans");
  const scratchOwner = await dependencies.makeExclusiveDirectory(root, scratchPath);
  let matteOwner;
  let mattePublished = false;
  let matteSnapshots = [];
  let verifiedSubjectMap;
  let publication;
  try {
    const extension = extname(source.path).toLowerCase() || ".video";
    const snapshotPath = `${scratchPath}/${source.id}${extension}`;
    const snapshotOwner = await dependencies.copyExclusiveFile(root, source.path, snapshotPath);
    const snapshot = await dependencies.hashNoFollow(root, snapshotPath);
    if (snapshot.sha256 !== before.sha256 || snapshot.bytes !== before.bytes
      || snapshot.owner.dev !== snapshotOwner.dev || snapshot.owner.ino !== snapshotOwner.ino) throw new Error("Source changed while creating subject snapshot");
    if (matteRequested) {
      await dependencies.makeDirectories(root, matteParent);
      matteOwner = await dependencies.makeExclusiveDirectory(root, matteStagePath);
    }
    const rawPath = `${scratchPath}/vision-output.json`;
    const result = await dependencies.run(analyzerScript, [
      join(root, snapshotPath), source.sha256, join(root, rawPath), matteRequested ? join(root, matteStagePath) : "-", String(sampleFps),
    ], {timeoutMs: 1_800_000, maxBytes: 4 * 1024 * 1024});
    if (result.code !== 0 || result.truncated) throw new Error(`Apple Vision subject analysis failed: ${(result.stderr ?? "").trim()}`);
    const rawBytes = await dependencies.readFileNoFollow(root, rawPath);
    const rawHash = await dependencies.hashNoFollow(root, rawPath);
    if (rawBytes.owner.dev !== rawHash.owner.dev || rawBytes.owner.ino !== rawHash.owner.ino || rawBytes.bytes.length !== rawHash.bytes) {
      throw new Error("Vision output changed while reading");
    }
    let raw;
    try {
      raw = JSON.parse(rawBytes.bytes.toString("utf8"));
    } catch {
      throw new Error("Apple Vision output is not valid JSON");
    }
    const subjectMap = normalizeVisionOutput(raw, {
      sourceId: source.id,
      sourceSha256: source.sha256,
      sourceBytes: source.bytes,
      frameSize: {width: source.width, height: source.height},
      timeRangeMs: {startMs: 0, endMs: source.durationMs},
      sampleFps,
      requiredTracking,
      requiredMatte,
      matteRequested,
      matteBasePath: matteFinalPath,
      qualityThresholds: input.qualityThresholds,
    });
    verifiedSubjectMap = subjectMap;
    matteSnapshots = matteRequested ? await verifyMatteFiles(root, raw, matteStagePath, subjectMap, dependencies) : [];
    const afterSnapshot = await dependencies.hashNoFollow(root, snapshotPath);
    const afterSource = await dependencies.hashNoFollow(root, source.path);
    if (!sameFile(snapshot, afterSnapshot) || !sameFile(before, afterSource)) throw new Error("Source changed during analysis");
    const postAnalysisIndex = await readBoundPath(root, indexPath, dependencies, "Media-index");
    if (!sameBoundPath(indexSnapshot, postAnalysisIndex)) throw new Error("Media-index changed during subject analysis");
    if (matteRequested) {
      await dependencies.renameExclusive(root, matteStagePath, matteFinalPath, matteOwner);
      mattePublished = true;
      await recheckFinalMattes(root, subjectMap, matteSnapshots, dependencies, "after directory publication");
    }
    const artifact = createArtifactEnvelope({
      artifactId: singleSourceCompatibility
        ? `subject-map:${workItemId}:v${revision}`
        : `subject-map:${workItemId}:${sourceId}:v${revision}`,
      revision: input.revision,
      workItemId,
      modality: input.modality,
      parents: [indexRef],
      producer: input.producer,
      versions: input.versions,
      status: "frozen",
      deviations: subjectMap.deviations,
      payload: {kind: "subject-map", ...subjectMap},
    });
    const path = singleSourceCompatibility
      ? `Plans/Subjects/${workItemId}/subject-map-v${revision}.json`
      : `Plans/Subjects/${workItemId}/v${revision}/${sourceId}-v${revision}.json`;
    let publicationOwner;
    publication = {path, artifact};
    const publicationIndex = await readBoundPath(root, indexPath, dependencies, "Media-index");
    if (!sameBoundPath(indexSnapshot, publicationIndex)) throw new Error("Media-index changed before subject-map publication");
    await recheckWorkflow(root, workItemId, input, dependencies, "before subject-map publication");
    if (matteRequested) await recheckFinalMattes(root, subjectMap, matteSnapshots, dependencies, "before subject-map publication");
    const stored = await publishArtifact(root, path, artifact, dependencies, (owner) => {
      publicationOwner = owner;
      publication.owner = owner;
    });
    publication.owner = publicationOwner;
    const finalIndex = await readBoundPath(root, indexPath, dependencies, "Media-index");
    if (!sameBoundPath(indexSnapshot, finalIndex)) throw new Error("Media-index changed after subject-map publication");
    await recheckWorkflow(root, workItemId, input, dependencies, "after subject-map publication");
    if (matteRequested) await recheckFinalMattes(root, subjectMap, matteSnapshots, dependencies, "after subject-map publication");
    return {artifact, artifactRef: {artifactId: artifact.artifactId, sha256: stored.sha256}, subjectMap};
  } catch (error) {
    if (publication?.owner) await dependencies.removeOwnedFile(root, publication.path, publication.owner).catch(() => false);
    if (matteOwner) await cleanupMattes(root, mattePublished ? matteFinalPath : matteStagePath, matteOwner, verifiedSubjectMap,
      matteSnapshots, dependencies);
    throw error;
  } finally {
    await dependencies.removeOwnedStage(root, scratchPath, scratchOwner).catch(() => false);
  }
}
