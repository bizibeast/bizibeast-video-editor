import {randomUUID} from "node:crypto";
import {stat} from "node:fs/promises";
import {basename, isAbsolute} from "node:path";

import {createArtifactEnvelope, writeImmutableArtifact} from "./artifacts.mjs";
import {sha256File} from "./checksum.mjs";
import {readManifest} from "./manifest.mjs";
import {probeMedia} from "./media-probe.mjs";
import {confinedProjectPath} from "./paths.mjs";
import {copyExclusiveFile, hashFileNoFollow, makeExclusiveDirectory, removeOwnedStage} from "./release-fs.mjs";

const EVIDENCE = Object.freeze([
  ["explicit", 1],
  ["filename-ordinal", 0.9],
  ["filename-timestamp", 0.85],
  ["embedded-timestamp", 0.75],
  ["mtime", 0.4],
  ["ingest-order", 0.2],
]);
const SHA256 = /^[a-f0-9]{64}$/u;

function validTime(value, label) {
  const match = typeof value === "string" && /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|[+-]\d\d:\d\d)$/u.exec(value);
  if (!match) throw new Error(`${label} must be a real ISO timestamp`);
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offset = match[7];
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59
    || (offset !== "Z" && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59))
    || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) {
    throw new Error(`${label} must be a real ISO timestamp`);
  }
  return Date.parse(value);
}

function filenameTime(path) {
  const match = basename(path).match(/(20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)(?:[-_ T]?([0-2]\d)([0-5]\d)([0-5]\d))?/u);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0));
  const value = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(value);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) {
    throw new Error(`Filename timestamp must be valid: ${basename(path)}`);
  }
  return value;
}

function filenameOrdinal(path) {
  if (filenameTime(path) !== null) return null;
  const match = basename(path).match(/(?:^|[^0-9])([0-9]{1,4})(?=[^0-9]|$)/u);
  return match ? Number(match[1]) : null;
}

function assertSourcePaths(sources) {
  if (!Array.isArray(sources) || sources.length === 0) throw new Error("At least one source is required");
  const ids = new Set();
  const paths = new Set();
  for (const source of sources) {
    if (!source || typeof source.id !== "string" || !source.id.trim() || ids.has(source.id)) {
      throw new Error("Source IDs must be unique non-empty strings");
    }
    if (typeof source.path !== "string" || !source.path || isAbsolute(source.path)
      || source.path.split(/[\\/]/u).some((part) => !part || part === "." || part === "..")
      || !source.path.split(/[\\/]/u).join("/").startsWith("Source/")) {
      throw new Error("Source path must be a confined Source/ file");
    }
    const path = source.path.split("\\").join("/");
    if (paths.has(path)) throw new Error("Source paths must be unique");
    if (!SHA256.test(source.sha256 ?? "")) throw new Error(`Source ${source.id} requires an ingest SHA-256`);
    if (!Number.isSafeInteger(source.bytes) || source.bytes < 0) throw new Error(`Source ${source.id} has invalid byte size`);
    if (source.embeddedCreatedAt !== undefined && source.embeddedCreatedAt !== null) validTime(source.embeddedCreatedAt, "Embedded timestamp");
    if (source.mtimeMs !== undefined && source.mtimeMs !== null && (typeof source.mtimeMs !== "number" || !Number.isFinite(source.mtimeMs) || source.mtimeMs < 0)) {
      throw new Error("Filesystem timestamp must be finite");
    }
    ids.add(source.id);
    paths.add(path);
  }
}

function candidates(source, index, explicitPositions) {
  return {
    explicit: explicitPositions?.get(source.id) ?? null,
    "filename-ordinal": filenameOrdinal(source.path),
    "filename-timestamp": filenameTime(source.path),
    "embedded-timestamp": source.embeddedCreatedAt == null ? null : validTime(source.embeddedCreatedAt, "Embedded timestamp"),
    mtime: source.mtimeMs ?? null,
    "ingest-order": Number.isInteger(source.ingestIndex) && source.ingestIndex >= 0 ? source.ingestIndex : index,
  };
}

function conflictsFor(source, enriched, method, selectedOrder) {
  return EVIDENCE.filter(([name]) => name !== method && source.candidates[name] !== null)
    .filter(([name]) => enriched.some((other) => other.id !== source.id && other.candidates[name] !== null
      && source.candidates[name] !== other.candidates[name]
      && selectedOrder.get(source.id) !== selectedOrder.get(other.id)
      && Math.sign(source.candidates[name] - other.candidates[name]) !== Math.sign(selectedOrder.get(source.id) - selectedOrder.get(other.id))))
    .map(([name]) => ({method: name, value: source.candidates[name]}));
}

export function orderVideoSources(sources, {explicitOrder} = {}) {
  assertSourcePaths(sources);
  if (explicitOrder !== undefined && (!Array.isArray(explicitOrder) || explicitOrder.length !== sources.length
    || new Set(explicitOrder).size !== sources.length || explicitOrder.some((id) => !sources.some((source) => source.id === id)))) {
    throw new Error("Explicit order must contain every source exactly once");
  }
  const explicitPositions = explicitOrder ? new Map(explicitOrder.map((id, index) => [id, index])) : null;
  const enriched = sources.map((source, index) => ({...source, candidates: candidates(source, index, explicitPositions)}));
  const method = EVIDENCE.find(([name]) => enriched.every((source) => source.candidates[name] !== null))?.[0] ?? "ingest-order";
  const confidence = Object.fromEntries(EVIDENCE)[method];
  const ordered = enriched.toSorted((left, right) => left.candidates[method] - right.candidates[method] || left.path.localeCompare(right.path));
  const selectedOrder = new Map(ordered.map(({id}, index) => [id, index]));
  return ordered.map(({candidates: sourceCandidates, ...source}, index) => ({
    ...source,
    order: index + 1,
    orderEvidence: {
      method,
      confidence,
      value: sourceCandidates[method],
      conflicts: conflictsFor({id: source.id, candidates: sourceCandidates}, enriched, method, selectedOrder),
    },
  }));
}

function assertMedia(probe) {
  if (typeof probe?.durationSeconds !== "number" || !Number.isFinite(probe.durationSeconds) || probe.durationSeconds <= 0) {
    throw new Error("Video duration must be finite and positive");
  }
  if (typeof probe.formatName !== "string" || !probe.formatName.trim()) throw new Error("Video format metadata is required");
  if (!Array.isArray(probe.video) || probe.video.length === 0) throw new Error("Source must contain an actual video stream");
  const video = probe.video.map(({codec_name, width, height, avg_frame_rate}) => {
    const rate = typeof avg_frame_rate === "string" ? /^([1-9]\d*)\/([1-9]\d*)$/u.exec(avg_frame_rate) : null;
    if (typeof codec_name !== "string" || !codec_name || !Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0
      || !rate || !Number.isSafeInteger(Number(rate[1])) || !Number.isSafeInteger(Number(rate[2])) || !Number.isFinite(Number(rate[1]) / Number(rate[2]))) {
      throw new Error("Video stream metadata is invalid");
    }
    return {codecName: codec_name, width, height, avgFrameRate: avg_frame_rate};
  });
  const audio = (probe.audio ?? []).map(({codec_name, sample_rate, channels}) => {
    const sampleRate = typeof sample_rate === "string" && /^[1-9]\d*$/u.test(sample_rate) ? Number(sample_rate) : NaN;
    if (typeof codec_name !== "string" || !codec_name || !Number.isSafeInteger(sampleRate)
      || !Number.isSafeInteger(channels) || channels <= 0) throw new Error("Audio stream metadata is invalid");
    return {codecName: codec_name, sampleRate, channels};
  });
  const embeddedCreatedAt = probe.raw?.format?.tags?.creation_time
    ?? probe.raw?.streams?.find(({tags}) => tags?.creation_time)?.tags.creation_time
    ?? null;
  if (embeddedCreatedAt !== null) validTime(embeddedCreatedAt, "Embedded timestamp");
  return {durationSeconds: probe.durationSeconds, formatName: probe.formatName, video, audio, embeddedCreatedAt};
}

function sameFile(left, right) {
  return left.sha256 === right.sha256 && left.bytes === right.bytes && left.mtimeMs === right.mtimeMs
    && left.owner.dev === right.owner.dev && left.owner.ino === right.owner.ino;
}

async function snapshotSource(projectDir, stagePath, source, index, adapters) {
  await confinedProjectPath(projectDir, source.path, {type: "file"});
  const before = await adapters.hashNoFollow(projectDir, source.path);
  if (before.sha256 !== source.sha256 || before.bytes !== source.bytes || !Number.isFinite(before.mtimeMs) || before.mtimeMs < 0) {
    throw new Error(`Source ${source.id} checksum changed since ingest`);
  }
  const snapshotPath = `${stagePath}/source-${String(index + 1).padStart(6, "0")}`;
  const copiedOwner = await adapters.copyExclusiveFile(projectDir, source.path, snapshotPath);
  const absolutePath = await confinedProjectPath(projectDir, snapshotPath, {type: "file"});
  const snapshot = await adapters.hashNoFollow(projectDir, snapshotPath);
  const checksum = await adapters.sha256(absolutePath);
  if (snapshot.owner.dev !== copiedOwner.dev || snapshot.owner.ino !== copiedOwner.ino
    || snapshot.sha256 !== source.sha256 || snapshot.bytes !== source.bytes || checksum !== snapshot.sha256) {
    throw new Error(`Source ${source.id} changed while creating index snapshot`);
  }
  return {absolutePath, snapshotPath, snapshot, sourceBefore: before};
}

export async function createMediaIndex(projectDir, input, adapters = {}) {
  const dependencies = {
    readManifest: adapters.readManifest ?? readManifest,
    probe: adapters.probe ?? probeMedia,
    sha256: adapters.sha256 ?? sha256File,
    hashNoFollow: adapters.hashNoFollow ?? hashFileNoFollow,
    copyExclusiveFile: adapters.copyExclusiveFile ?? copyExclusiveFile,
    makeExclusiveDirectory: adapters.makeExclusiveDirectory ?? makeExclusiveDirectory,
    removeOwnedStage: adapters.removeOwnedStage ?? removeOwnedStage,
    writeArtifact: adapters.writeArtifact ?? writeImmutableArtifact,
  };
  if (!Number.isInteger(input?.revision) || input.revision < 1 || input.revision > 999) throw new Error("Media index revision must be an integer from 1 to 999");
  const manifest = await dependencies.readManifest(projectDir);
  assertSourcePaths(manifest.sources);
  if (typeof input.workItemId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(input.workItemId) || input.workItemId === "." || input.workItemId === "..") {
    throw new Error("Media index work item ID must be safe identifier");
  }
  const stagePath = `Plans/.media-index-${input.workItemId}-v${String(input.revision).padStart(3, "0")}-${randomUUID()}`;
  const stageOwner = await dependencies.makeExclusiveDirectory(projectDir, stagePath);
  try {
    const indexed = [];
    const verifiedSources = [];
    for (const [ingestIndex, source] of manifest.sources.entries()) {
      const snapshot = await snapshotSource(projectDir, stagePath, source, ingestIndex, dependencies);
      const inspected = assertMedia(await dependencies.probe(snapshot.absolutePath));
      const mtime = await stat(snapshot.absolutePath);
      if (!mtime.isFile() || !Number.isFinite(mtime.mtimeMs) || mtime.mtimeMs < 0) throw new Error(`Source ${source.id} has invalid filesystem metadata`);
      const after = await dependencies.hashNoFollow(projectDir, snapshot.snapshotPath);
      if (!sameFile(snapshot.snapshot, after)) throw new Error(`Source ${source.id} snapshot changed during indexing`);
      const sourceAfter = await dependencies.hashNoFollow(projectDir, source.path);
      if (!sameFile(snapshot.sourceBefore, sourceAfter)) throw new Error(`Source ${source.id} changed during indexing`);
      indexed.push({...source, ingestIndex, ...inspected, mtimeMs: snapshot.sourceBefore.mtimeMs});
      verifiedSources.push({source, before: snapshot.sourceBefore});
    }
    const sources = orderVideoSources(indexed, {explicitOrder: input.explicitOrder});
    const payload = {kind: "media-index", sources};
    const artifact = createArtifactEnvelope({
      artifactId: `media-index:${input.workItemId}:v${String(input.revision).padStart(3, "0")}`,
      revision: input.revision,
      workItemId: input.workItemId,
      modality: input.modality ?? "multi-clip",
      parents: input.parents ?? [],
      producer: input.producer,
      versions: input.versions,
      status: "frozen",
      deviations: [],
      payload,
    });
    for (const {source, before} of verifiedSources) {
      if (!sameFile(before, await dependencies.hashNoFollow(projectDir, source.path))) {
        throw new Error(`Source ${source.id} changed before media-index publication`);
      }
    }
    const stored = await dependencies.writeArtifact(projectDir, `Plans/MediaIndex/${input.workItemId}/media-index-v${String(input.revision).padStart(3, "0")}.json`, artifact);
    return {artifact, artifactRef: {artifactId: artifact.artifactId, sha256: stored.sha256}, index: payload};
  } finally {
    await dependencies.removeOwnedStage(projectDir, stagePath, stageOwner);
  }
}
