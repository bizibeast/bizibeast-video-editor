import {createHash, randomUUID} from "node:crypto";
import {readdir, realpath} from "node:fs/promises";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

import {createArtifactEnvelope, validateArtifactEnvelope, verifyArtifactParents} from "./artifacts.mjs";
import {buildCaptionBundle, extractWords} from "./captions.mjs";
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
  writeExclusiveFile,
} from "./release-fs.mjs";

const transcribeScript = fileURLToPath(new URL("../scripts/models/transcribe.sh", import.meta.url));
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const pad = (value) => String(value).padStart(3, "0");

function required(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

function safeId(value, label) {
  if (!SAFE_ID.test(value) || value === "." || value === "..") throw new Error(`${label} must be a safe identifier`);
  return value;
}

function artifactRef(value, label) {
  if (!value || typeof value !== "object" || typeof value.artifactId !== "string" || !SHA256.test(value.sha256)) {
    throw new Error(`${label} must contain an artifact id and SHA-256`);
  }
  return value;
}

function sameFile(left, right) {
  return left.sha256 === right.sha256 && left.bytes === right.bytes
    && left.owner.dev === right.owner.dev && left.owner.ino === right.owner.ino;
}

function parentMap(value) {
  const entries = value instanceof Map ? [...value.entries()] : value;
  if (!Array.isArray(entries)) throw new Error("Current media-index parents are required");
  const current = new Map();
  for (const entry of entries) {
    const id = Array.isArray(entry) ? entry[0] : entry?.artifactId;
    const sha256 = Array.isArray(entry) ? entry[1] : entry?.sha256;
    if (typeof id !== "string" || !SHA256.test(sha256) || current.has(id)) throw new Error("Current media-index parents must have unique SHA-256 refs");
    current.set(id, sha256);
  }
  return current;
}

function assertSource(source) {
  safeId(source?.id, "Media-index source id");
  if (!SHA256.test(source.sha256) || !Number.isSafeInteger(source.bytes) || source.bytes < 1
    || typeof source.path !== "string" || !source.path || !Number.isFinite(source.durationSeconds) || source.durationSeconds <= 0) {
    throw new Error(`Media-index source ${source?.id ?? "unknown"} is invalid`);
  }
  return source;
}

function assertMediaIndex(artifact, input, ref) {
  validateArtifactEnvelope(artifact);
  const workItemId = safeId(required(input.workItemId, "Work item id"), "Work item id");
  if (!Number.isInteger(input.revision) || input.revision < 1 || input.revision > 999) throw new Error("Transcript revision must be 1-999");
  if (!["raw-video", "multi-clip"].includes(input.modality) || artifact.modality !== input.modality) throw new Error("Transcript modality must match a raw-video or multi-clip media index");
  if (artifact.artifactId !== `media-index:${workItemId}:v${pad(input.revision)}` || artifact.workItemId !== workItemId
    || artifact.revision !== input.revision || artifact.status !== "frozen" || artifact.payload?.kind !== "media-index") {
    throw new Error("Media-index artifact does not match transcript work item or revision");
  }
  if (artifact.producer.role !== "local-media-technician" || input.producer?.role !== "local-media-technician") {
    throw new Error("Media-index and transcript producer roles must be local-media-technician");
  }
  if (ref.artifactId !== artifact.artifactId) throw new Error("Media-index artifact ref does not match stored artifact");
  if (!Array.isArray(artifact.payload.sources) || !artifact.payload.sources.length) throw new Error("Media-index must contain sources");
  const ids = new Set();
  for (const source of artifact.payload.sources) {
    assertSource(source);
    if (ids.has(source.id)) throw new Error(`Media-index contains duplicate source id: ${source.id}`);
    ids.add(source.id);
  }
  return workItemId;
}

async function findSingleJson(root, rawDir, readNoFollow) {
  const directory = await confinedProjectPath(root, rawDir, {type: "directory"});
  const entries = await readdir(directory, {withFileTypes: true});
  if (entries.some((entry) => entry.isSymbolicLink() || entry.isDirectory() || !entry.isFile())) throw new Error("Transcription output must not contain links or directories");
  const json = entries.filter((entry) => entry.name.endsWith(".json"));
  if (json.length !== 1) throw new Error("Expected exactly one generated transcript JSON");
  return readNoFollow(root, `${rawDir}/${json[0].name}`);
}

async function publishArtifact(root, path, artifact, dependencies, onWrite) {
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
  await dependencies.makeDirectories(root, dirname(path));
  await confinedProjectPath(root, dirname(path), {type: "directory"});
  const owner = await dependencies.writeExclusiveFile(root, path, bytes);
  onWrite(owner);
  const stored = await dependencies.hashNoFollow(root, path);
  if (stored.sha256 !== expectedSha256 || stored.bytes !== bytes.length
    || stored.owner.dev !== owner.dev || stored.owner.ino !== owner.ino) throw new Error("Source transcript bytes changed after publication");
  return {sha256: stored.sha256, owner};
}

export function canonicalizeSourceTranscript(raw, source) {
  const durationMs = Math.round(Number(source?.durationSeconds) * 1000);
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("Transcript source duration must be finite and positive");
  const words = extractWords(raw).map((word, index) => ({
    id: `${source.id}:w${String(index + 1).padStart(6, "0")}`,
    text: String(word.text ?? word.word ?? "").trim(),
    startMs: Math.round(Number(word.start ?? word.start_time) * 1000),
    endMs: Math.round(Number(word.end ?? word.end_time) * 1000),
    confidence: Number.isFinite(Number(word.confidence)) ? Number(word.confidence) : null,
  }));
  if (!words.length || words.some((word) => !word.text || !Number.isFinite(word.startMs) || !Number.isFinite(word.endMs)
    || word.startMs < 0 || word.endMs <= word.startMs)) {
    throw new Error("Transcript contains no valid timed words");
  }
  if (words.some((word) => word.endMs > durationMs + 50)) throw new Error("Transcript word ends after source duration");
  for (const [index, word] of words.entries()) {
    const previous = words[index - 1];
    if (previous && (word.startMs < previous.startMs || word.startMs < previous.endMs - 20)) {
      throw new Error("Transcript words must be ordered and non-overlapping");
    }
  }
  return {
    schemaVersion: 1,
    sourceId: source.id,
    sourceSha256: source.sha256,
    durationMs,
    timeBase: "source-relative-ms",
    language: raw.language ?? null,
    words,
    text: words.map(({text}) => text).join(" ").replace(/\s+([,.;!?…])/gu, "$1"),
  };
}

export async function transcribeIndexedSources(projectDir, input, adapters = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Transcript input is required");
  const dependencies = {
    run: adapters.run ?? runProcess,
    hashNoFollow: adapters.hashNoFollow ?? hashFileNoFollow,
    copyExclusiveFile: adapters.copyExclusiveFile ?? copyExclusiveFile,
    makeDirectories: adapters.makeDirectories ?? makeDirectories,
    makeExclusiveDirectory: adapters.makeExclusiveDirectory ?? makeExclusiveDirectory,
    readFileNoFollow: adapters.readFileNoFollow ?? readFileNoFollow,
    removeOwnedFile: adapters.removeOwnedFile ?? removeOwnedFile,
    removeOwnedStage: adapters.removeOwnedStage ?? removeOwnedStage,
    writeExclusiveFile: adapters.writeExclusiveFile ?? writeExclusiveFile,
  };
  const root = await realpath(projectDir);
  const workItemId = safeId(required(input.workItemId, "Work item id"), "Work item id");
  if (!Number.isInteger(input.revision) || input.revision < 1 || input.revision > 999) throw new Error("Transcript revision must be 1-999");
  const revision = pad(input.revision);
  const indexPath = `Plans/MediaIndex/${workItemId}/media-index-v${revision}.json`;
  const indexBytes = await dependencies.readFileNoFollow(root, indexPath);
  let indexArtifact;
  try {
    indexArtifact = JSON.parse(indexBytes.bytes.toString("utf8"));
  } catch {
    throw new Error("Media-index artifact is not valid JSON");
  }
  const indexArtifactRef = artifactRef(input.mediaIndexArtifactRef, "Media-index artifact ref");
  const indexedHash = await dependencies.hashNoFollow(root, indexPath);
  if (indexedHash.sha256 !== indexArtifactRef.sha256 || indexedHash.owner.dev !== indexBytes.owner.dev || indexedHash.owner.ino !== indexBytes.owner.ino) {
    throw new Error("Media-index artifact ref does not match exact stored artifact");
  }
  assertMediaIndex(indexArtifact, input, indexArtifactRef);
  verifyArtifactParents(indexArtifact, parentMap(input.currentParents));
  required(input.producer?.actorId, "Transcript producer actor id");
  const modelRevision = required(input.parakeetModelRevision ?? input.versions?.model, "Parakeet model revision");
  if (!input.versions || typeof input.versions !== "object") throw new Error("Transcript versions are required");

  const transcriptParent = "Plans/Transcripts";
  await dependencies.makeDirectories(root, transcriptParent);
  await confinedProjectPath(root, transcriptParent, {type: "directory"});
  const stagePath = `${transcriptParent}/.transcribe-${workItemId}-v${revision}-${randomUUID()}`;
  const stageOwner = await dependencies.makeExclusiveDirectory(root, stagePath);
  const published = [];
  const rawStages = [];
  try {
    const captured = [];
    for (const source of indexArtifact.payload.sources) {
      const before = await dependencies.hashNoFollow(root, source.path);
      if (before.sha256 !== source.sha256 || before.bytes !== source.bytes) throw new Error(`Source ${source.id} checksum changed since media indexing`);
      await confinedProjectPath(root, source.path, {type: "file"});
      const snapshotPath = `${stagePath}/input-${source.id}`;
      const owner = await dependencies.copyExclusiveFile(root, source.path, snapshotPath);
      const snapshot = await dependencies.hashNoFollow(root, snapshotPath);
      if (!sameFile(snapshot, {...before, owner}) || snapshot.owner.dev !== owner.dev || snapshot.owner.ino !== owner.ino) {
        throw new Error(`Source ${source.id} changed while creating transcript snapshot`);
      }
      const rawDir = `${stagePath}/raw-${source.id}`;
      rawStages.push({path: rawDir, owner: await dependencies.makeExclusiveDirectory(root, rawDir)});
      const result = await dependencies.run(transcribeScript, [join(root, snapshotPath), join(root, rawDir)], {timeoutMs: 1_800_000});
      if (result.code !== 0 || result.truncated) throw new Error(`Transcription failed for ${source.id}: ${(result.stderr ?? "").trim()}`);
      if (!sameFile(snapshot, await dependencies.hashNoFollow(root, snapshotPath))) throw new Error(`Transcription snapshot changed for ${source.id}`);
      const raw = await findSingleJson(root, rawDir, dependencies.readFileNoFollow);
      let transcript;
      try {
        transcript = canonicalizeSourceTranscript(JSON.parse(raw.bytes.toString("utf8")), source);
      } catch (error) {
        throw new Error(`Invalid transcript for ${source.id}: ${error.message}`);
      }
      captured.push({source, before, transcript, captionBundle: buildCaptionBundle({words: transcript.words.map((word) => ({
        text: word.text, start: word.startMs / 1000, end: word.endMs / 1000, confidence: word.confidence,
      }))})});
    }
    for (const {source, before} of captured) {
      if (!sameFile(before, await dependencies.hashNoFollow(root, source.path))) throw new Error(`Source ${source.id} changed during transcription`);
    }
    const versions = {...input.versions, model: modelRevision};
    for (const {source, transcript, captionBundle} of captured) {
      const artifact = createArtifactEnvelope({
        artifactId: `source-transcript:${workItemId}:${source.id}:v${revision}`,
        revision: input.revision, workItemId, modality: input.modality, parents: [indexArtifactRef], producer: input.producer,
        versions, status: "frozen", deviations: [], payload: {kind: "source-transcript", sourceId: source.id, sourceSha256: source.sha256, transcript, captionBundle},
      });
      const path = `Plans/Transcripts/${workItemId}/v${revision}/${source.id}-v${revision}.json`;
      const publication = {path};
      const stored = await publishArtifact(root, path, artifact, dependencies, (owner) => {
        publication.owner = owner;
        published.push(publication);
      });
      Object.assign(publication, {artifact, artifactRef: {artifactId: artifact.artifactId, sha256: stored.sha256}, transcript});
    }
    return {
      artifacts: published.map(({artifact}) => artifact), artifactRefs: published.map(({artifactRef}) => artifactRef),
      transcripts: published.map(({transcript}) => transcript), indexArtifact, indexArtifactRef,
    };
  } catch (error) {
    await Promise.all(published.reverse().map(({path, owner}) => dependencies.removeOwnedFile(root, path, owner)));
    throw error;
  } finally {
    await Promise.all(rawStages.reverse().map(({path, owner}) => dependencies.removeOwnedStage(root, path, owner)));
    await dependencies.removeOwnedStage(root, stagePath, stageOwner);
  }
}
