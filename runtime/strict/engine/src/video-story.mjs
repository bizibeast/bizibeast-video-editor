import {createHash, randomUUID} from "node:crypto";
import {dirname} from "node:path";

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
  writeExclusiveFile,
} from "./release-fs.mjs";
import {getWorkItem, readWorkflowState} from "./workflow.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const pad = (value) => String(value).padStart(3, "0");
const overlaps = (left, right) => left.startMs < right.endMs && right.startMs < left.endMs;
const contains = (outer, inner) => outer.startMs <= inner.startMs && outer.endMs >= inner.endMs;

function required(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

function safeId(value, label) {
  if (!SAFE_ID.test(value) || value === "." || value === "..") throw new Error(`${label} must be a safe identifier`);
  return value;
}

function assertMilliseconds(value, label, {minimum = 0, maximum = Number.MAX_SAFE_INTEGER} = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be an integer millisecond value`);
  return value;
}

function assertInterval(interval, label, durationMs = Number.MAX_SAFE_INTEGER) {
  if (!interval || typeof interval !== "object" || Array.isArray(interval)) throw new Error(`${label} must be an interval`);
  const startMs = assertMilliseconds(interval.startMs, `${label} start`, {maximum: durationMs});
  const endMs = assertMilliseconds(interval.endMs, `${label} end`, {maximum: durationMs});
  if (endMs <= startMs) throw new Error(`${label} must have a positive duration`);
  return {startMs, endMs};
}

function artifactRef(value, label) {
  if (!value || typeof value !== "object" || typeof value.artifactId !== "string" || !SHA256.test(value.sha256)) {
    throw new Error(`${label} must contain an artifact id and SHA-256`);
  }
  return value;
}

function sourceIdFromTranscriptRef(ref, workItemId, revision) {
  if (ref.sourceId !== undefined) return safeId(ref.sourceId, "Transcript ref source id");
  const match = new RegExp(`^source-transcript:${workItemId}:([A-Za-z0-9][A-Za-z0-9._-]*):v${revision}$`, "u").exec(ref.artifactId);
  if (!match) throw new Error("Transcript artifact ref must identify its source");
  return match[1];
}

function parentMap(value) {
  const values = value instanceof Map ? [...value.entries()] : value;
  if (!Array.isArray(values)) throw new Error("Current parents are required");
  const parents = new Map();
  for (const entry of values) {
    const artifactId = Array.isArray(entry) ? entry[0] : entry?.artifactId;
    const sha256 = Array.isArray(entry) ? entry[1] : entry?.sha256;
    if (typeof artifactId !== "string" || !SHA256.test(sha256) || parents.has(artifactId)) {
      throw new Error("Current parents must have unique SHA-256 refs");
    }
    parents.set(artifactId, sha256);
  }
  return parents;
}

function sameStoredFile(left, right) {
  return left.sha256 === right.sha256 && left.bytes === right.bytes && left.mtimeMs === right.mtimeMs
    && left.owner.dev === right.owner.dev && left.owner.ino === right.owner.ino;
}

function parseSilencePairs(stderr) {
  const starts = [...String(stderr).matchAll(/silence_start:\s*([0-9.]+)/gu)].map((match) => Math.round(Number(match[1]) * 1000));
  const ends = [...String(stderr).matchAll(/silence_end:\s*([0-9.]+)/gu)].map((match) => Math.round(Number(match[1]) * 1000));
  if (starts.some((value) => !Number.isSafeInteger(value) || value < 0) || ends.some((value) => !Number.isSafeInteger(value) || value < 0) || starts.length !== ends.length) {
    throw new Error("FFmpeg returned incomplete silence intervals");
  }
  return starts.map((startMs, index) => {
    const endMs = ends[index];
    if (endMs <= startMs) throw new Error("FFmpeg returned invalid silence interval");
    return {startMs, endMs};
  });
}

export async function detectWaveformSilence(mediaPath, run = runProcess) {
  required(mediaPath, "Media path");
  const result = await run("ffmpeg", [
    "-hide_banner", "-nostats", "-i", mediaPath,
    "-af", "silencedetect=noise=-42dB:d=0.12", "-vn", "-f", "null", "-",
  ]);
  if (result?.code !== 0 || result?.truncated) throw new Error(`FFmpeg silence detection failed: ${String(result?.stderr ?? "").trim()}`);
  return parseSilencePairs(result.stderr);
}

function normalizedWords(words, durationMs) {
  if (!Array.isArray(words) || !words.length) throw new Error("Timed transcript words are required");
  const seen = new Set();
  return words.map((word, index) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(required(word?.id, "Word id"))) throw new Error("Word id must be a safe transcript identifier");
    if (seen.has(word.id)) throw new Error("Transcript word IDs must be unique");
    seen.add(word.id);
    required(word.text, "Word text");
    const startMs = assertMilliseconds(word.startMs, "Word start", {maximum: durationMs});
    const endMs = assertMilliseconds(word.endMs, "Word end", {maximum: durationMs});
    if (endMs <= startMs || (index && startMs < words[index - 1].endMs)) throw new Error("Transcript words must be ordered and non-overlapping");
    return {id: word.id, text: word.text, startMs, endMs};
  });
}

function silenceEvidence(interval, waveformSilence, vadSpeech) {
  return waveformSilence.some((waveform) => contains(waveform, interval)) && !vadSpeech.some((speech) => overlaps(speech, interval));
}

function assertMarkedPause(pause, wordsById, wordIndex, durationMs) {
  if (!pause || typeof pause !== "object" || Array.isArray(pause)) throw new Error("Marked pause must be an object");
  const after = wordsById.get(pause.afterWordId);
  const before = wordsById.get(pause.beforeWordId);
  if (!after || !before || wordIndex.get(before.id) !== wordIndex.get(after.id) + 1 || after.endMs >= before.startMs) throw new Error("Marked pause must name adjacent chronological words");
  const originalGapMs = before.startMs - after.endMs;
  if (originalGapMs < 450 || originalGapMs > 900) throw new Error("Marked dramatic pauses must be 450–900ms");
  required(pause.reason, "Marked dramatic pause reason");
  if (after.endMs > durationMs || before.startMs > durationMs) throw new Error("Marked pause exceeds duration");
  return {afterWordId: after.id, beforeWordId: before.id, originalGapMs, reason: pause.reason.trim()};
}

export function buildSilencePlan(input, {
  gapThresholdMs = 240,
  targetGapMs = 130,
  minimumSpeechHandleMs = 40,
} = {}) {
  if (!Number.isSafeInteger(gapThresholdMs) || gapThresholdMs < 1) throw new Error("Gap threshold must be a positive integer");
  if (!Number.isSafeInteger(targetGapMs) || targetGapMs < 120 || targetGapMs > 140) throw new Error("Target gap must stay within 120–140ms");
  if (!Number.isSafeInteger(minimumSpeechHandleMs) || minimumSpeechHandleMs < 40) throw new Error("Speech handles must be at least 40ms");
  if (targetGapMs < minimumSpeechHandleMs * 2) throw new Error("Target gap cannot preserve both speech handles");
  const durationMs = assertMilliseconds(input?.durationMs, "Source duration", {minimum: 1});
  const words = normalizedWords(input.words, durationMs);
  const waveformSilence = (input.waveformSilence ?? []).map((value) => assertInterval(value, "Waveform silence", durationMs));
  const vadSpeech = (input.vadSpeech ?? []).map((value) => assertInterval(value, "VAD speech", durationMs));
  const wordsById = new Map(words.map((word) => [word.id, word]));
  const wordIndex = new Map(words.map(({id}, index) => [id, index]));
  const marked = (input.markedPauses ?? []).map((pause) => assertMarkedPause(pause, wordsById, wordIndex, durationMs));
  if (new Set(marked.map(({afterWordId, beforeWordId}) => `${afterWordId}:${beforeWordId}`)).size !== marked.length) throw new Error("Marked pauses must be unique");
  const markedByGap = new Map(marked.map((pause) => [`${pause.afterWordId}:${pause.beforeWordId}`, pause]));
  const operations = [];
  const blocked = [];
  const leftSpeechHandleMs = Math.floor(targetGapMs / 2);
  const rightSpeechHandleMs = targetGapMs - leftSpeechHandleMs;

  const leading = {startMs: 0, endMs: words[0].startMs};
  if (leading.endMs >= gapThresholdMs && leading.endMs > minimumSpeechHandleMs) {
    const removal = {startMs: 0, endMs: leading.endMs - minimumSpeechHandleMs};
    if (silenceEvidence(removal, waveformSilence, vadSpeech)) operations.push({kind: "trim-leading-silence", ...removal, retainedMs: minimumSpeechHandleMs, removedMs: removal.endMs});
    else blocked.push({kind: "blocked-trim-leading-silence", reason: "waveform-or-vad-disagrees", ...removal});
  }
  for (let index = 1; index < words.length; index += 1) {
    const after = words[index - 1];
    const before = words[index];
    const originalGapMs = before.startMs - after.endMs;
    const markedPause = markedByGap.get(`${after.id}:${before.id}`);
    if (markedPause) {
      operations.push({kind: "preserve-dramatic-pause", ...markedPause});
      continue;
    }
    if (originalGapMs < gapThresholdMs || originalGapMs <= targetGapMs) continue;
    const removal = {startMs: after.endMs + leftSpeechHandleMs, endMs: before.startMs - rightSpeechHandleMs};
    if (removal.endMs <= removal.startMs || !silenceEvidence(removal, waveformSilence, vadSpeech)) continue;
    operations.push({
      kind: "compress-gap", afterWordId: after.id, beforeWordId: before.id, originalGapMs, targetGapMs,
      removeStartMs: removal.startMs, removeEndMs: removal.endMs, leftSpeechHandleMs,
      rightSpeechHandleMs, removedMs: removal.endMs - removal.startMs,
    });
  }
  const trailing = {startMs: words.at(-1).endMs, endMs: durationMs};
  if (trailing.endMs - trailing.startMs >= gapThresholdMs && trailing.endMs - trailing.startMs > minimumSpeechHandleMs) {
    const removal = {startMs: trailing.startMs + minimumSpeechHandleMs, endMs: durationMs};
    if (silenceEvidence(removal, waveformSilence, vadSpeech)) operations.push({kind: "trim-trailing-silence", ...removal, retainedMs: minimumSpeechHandleMs, removedMs: durationMs - removal.startMs});
    else blocked.push({kind: "blocked-trim-trailing-silence", reason: "waveform-or-vad-disagrees", ...removal});
  }
  return {durationMs, thresholdMs: gapThresholdMs, targetGapMs, minimumSpeechHandleMs, operations, blocked};
}

function textBetween(wordsById, sourceWords, firstWordId, lastWordId) {
  const first = wordsById.get(firstWordId);
  const last = wordsById.get(lastWordId);
  if (!first || !last || first.sourceId !== last.sourceId) throw new Error("Segment word range must reference one transcript source");
  const firstIndex = sourceWords.findIndex(({id}) => id === firstWordId);
  const lastIndex = sourceWords.findIndex(({id}) => id === lastWordId);
  if (firstIndex < 0 || lastIndex < firstIndex) throw new Error("Segment word range is not chronological");
  const selected = sourceWords.slice(firstIndex, lastIndex + 1);
  return {selected, text: selected.map(({text}) => text).join(" ").replace(/\s+([,.;!?…])/gu, "$1")};
}

export function validateStorySegments(segments, transcripts) {
  if (!Array.isArray(segments) || !segments.length) throw new Error("Story plan requires selected segments");
  if (!Array.isArray(transcripts) || !transcripts.length) throw new Error("Per-source transcripts are required");
  const wordsById = new Map();
  const sources = new Map();
  for (const transcript of transcripts) {
    safeId(required(transcript?.sourceId, "Transcript source id"), "Transcript source id");
    const durationMs = assertMilliseconds(transcript.durationMs, "Transcript source duration", {minimum: 1});
    if (transcript.timeBase !== "source-relative-ms" || !SHA256.test(transcript.sourceSha256 ?? "") || sources.has(transcript.sourceId) || !Array.isArray(transcript.words) || !transcript.words.length) throw new Error("Transcript source metadata is invalid");
    const words = transcript.words.map((word, index) => {
      if (!/^([A-Za-z0-9][A-Za-z0-9._-]*):w\d{6}$/u.test(word?.id ?? "") || !word.id.startsWith(`${transcript.sourceId}:`)
        || typeof word.text !== "string" || !word.text.trim()) throw new Error("Transcript word timing is invalid");
      const startMs = assertMilliseconds(word.startMs, "Transcript word start", {maximum: durationMs});
      const endMs = assertMilliseconds(word.endMs, "Transcript word end", {maximum: durationMs});
      if (endMs <= startMs || (index && startMs < transcript.words[index - 1].endMs)) throw new Error("Transcript word timings must be ordered and non-overlapping");
      return {...word, startMs, endMs, sourceId: transcript.sourceId};
    });
    sources.set(transcript.sourceId, {transcript, words});
    for (const word of words) {
      if (wordsById.has(word.id)) throw new Error("Transcript word IDs must be globally unique");
      wordsById.set(word.id, word);
    }
  }
  const ids = new Set();
  return segments.map((segment, index) => {
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) throw new Error("Story segment must be an object");
    const id = safeId(required(segment.id ?? `segment-${index + 1}`, "Segment id"), "Segment id");
    if (ids.has(id)) throw new Error("Story segment IDs must be unique");
    ids.add(id);
    const sourceId = safeId(required(segment.sourceId, "Segment source id"), "Segment source id");
    const source = sources.get(sourceId);
    if (!source || segment.sourceSha256 !== source.transcript.sourceSha256) throw new Error("Story segment source hash must match its transcript");
    const sourceInMs = assertMilliseconds(segment.sourceInMs, "Segment source in");
    const sourceOutMs = assertMilliseconds(segment.sourceOutMs, "Segment source out");
    if (sourceOutMs <= sourceInMs) throw new Error("Story segment source range must be positive");
    const range = textBetween(wordsById, source.words, required(segment.firstWordId, "First word id"), required(segment.lastWordId, "Last word id"));
    if (sourceInMs > range.selected[0].startMs || sourceOutMs < range.selected.at(-1).endMs) throw new Error("Story segment source range must contain every selected word");
    const expectedWordIds = range.selected.map(({id: wordId}) => wordId);
    if (segment.wordIds !== undefined && (!Array.isArray(segment.wordIds) || segment.wordIds.length !== expectedWordIds.length || segment.wordIds.some((wordId, wordIndex) => wordId !== expectedWordIds[wordIndex]))) {
      throw new Error("Story segment must select an exact contiguous transcript word range");
    }
    const timelineInMs = assertMilliseconds(segment.timelineInMs, "Segment timeline in");
    required(segment.purpose, "Segment purpose");
    return {id, sourceId, sourceSha256: source.transcript.sourceSha256, sourceInMs, sourceOutMs, firstWordId: expectedWordIds[0], lastWordId: expectedWordIds.at(-1), wordIds: expectedWordIds, text: range.text, timelineInMs, purpose: segment.purpose.trim()};
  });
}

function validateCurrentArtifact(artifact, ref, expected) {
  validateArtifactEnvelope(artifact);
  if (ref.artifactId !== artifact.artifactId || artifact.workItemId !== expected.workItemId || artifact.revision !== expected.revision
    || artifact.modality !== expected.modality || artifact.status !== "frozen") throw new Error("Stored artifact does not match current work item, revision, or modality");
  if (artifact.producer?.role !== "local-media-technician") throw new Error("Media artifacts must be produced by local-media-technician");
  return artifact;
}

async function readArtifact(root, path, ref, dependencies, expected) {
  const stored = await dependencies.readFileNoFollow(root, path);
  const current = await dependencies.hashNoFollow(root, path);
  if (current.sha256 !== ref.sha256 || current.owner.dev !== stored.owner.dev || current.owner.ino !== stored.owner.ino) throw new Error("Artifact reference does not match exact stored bytes");
  let artifact;
  try { artifact = JSON.parse(stored.bytes.toString("utf8")); } catch { throw new Error("Stored artifact is not valid JSON"); }
  return validateCurrentArtifact(artifact, ref, expected);
}

async function publish(root, path, artifact, dependencies, onWrite) {
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
  await dependencies.makeDirectories(root, dirname(path));
  await confinedProjectPath(root, dirname(path), {type: "directory"});
  const owner = await dependencies.writeExclusiveFile(root, path, bytes);
  onWrite(owner);
  const stored = await dependencies.hashNoFollow(root, path);
  if (stored.sha256 !== expectedSha256 || stored.bytes !== bytes.length || stored.owner.dev !== owner.dev || stored.owner.ino !== owner.ino) throw new Error("Story plan bytes changed after publication");
  return {owner, sha256: stored.sha256};
}

export async function createStoryPlan(projectDir, input, adapters = {}) {
  const dependencies = {
    run: adapters.run ?? runProcess, hashNoFollow: adapters.hashNoFollow ?? hashFileNoFollow,
    readFileNoFollow: adapters.readFileNoFollow ?? readFileNoFollow, copyExclusiveFile: adapters.copyExclusiveFile ?? copyExclusiveFile,
    makeDirectories: adapters.makeDirectories ?? makeDirectories, makeExclusiveDirectory: adapters.makeExclusiveDirectory ?? makeExclusiveDirectory,
    removeOwnedFile: adapters.removeOwnedFile ?? removeOwnedFile, removeOwnedStage: adapters.removeOwnedStage ?? removeOwnedStage,
    writeExclusiveFile: adapters.writeExclusiveFile ?? writeExclusiveFile, readWorkflowState: adapters.readWorkflowState ?? readWorkflowState,
  };
  const workItemId = safeId(required(input?.workItemId, "Work item id"), "Work item id");
  if (!Number.isInteger(input.revision) || input.revision < 1 || input.revision > 999) throw new Error("Story plan revision must be 1-999");
  if (!["raw-video", "multi-clip"].includes(input.modality)) throw new Error("Story plan modality must be raw-video or multi-clip");
  if (input.producer?.role !== "story-editor") throw new Error("Story plan producer role must be story-editor");
  required(input.producer?.actorId, "Story plan producer actor id");
  if (!input.versions || typeof input.versions !== "object") throw new Error("Story plan versions are required");
  const workflow = await dependencies.readWorkflowState(projectDir);
  const item = getWorkItem(workflow, workItemId);
  if (item.modality !== input.modality || item.revision !== input.revision || item.state !== "TRANSCRIPTS_READY") throw new Error("Story plan requires current TRANSCRIPTS_READY work item");
  const root = projectDir;
  const revision = pad(input.revision);
  const indexRef = artifactRef(input.mediaIndexArtifactRef, "Media-index artifact ref");
  const expected = {workItemId, revision: input.revision, modality: input.modality};
  const indexPath = `Plans/MediaIndex/${workItemId}/media-index-v${revision}.json`;
  const index = await readArtifact(root, indexPath, indexRef, dependencies, expected);
  if (index.artifactId !== `media-index:${workItemId}:v${revision}` || index.payload?.kind !== "media-index") throw new Error("Current media-index artifact is required");
  verifyArtifactParents(index, parentMap(input.currentParents));
  const refs = input.transcriptArtifactRefs;
  if (!Array.isArray(refs) || refs.length !== index.payload.sources.length) throw new Error("Every indexed source requires an exact transcript artifact ref");
  const refBySource = new Map();
  for (const ref of refs) {
    const valid = artifactRef(ref, "Transcript artifact ref");
    const sourceId = sourceIdFromTranscriptRef(ref, workItemId, revision);
    if (refBySource.has(sourceId)) throw new Error("Transcript refs must be unique per source");
    refBySource.set(sourceId, valid);
  }
  const transcriptArtifacts = [];
  for (const source of index.payload.sources) {
    const ref = refBySource.get(source.id);
    if (!ref) throw new Error(`Missing transcript artifact ref for ${source.id}`);
    const path = `Plans/Transcripts/${workItemId}/v${revision}/${source.id}-v${revision}.json`;
    const artifact = await readArtifact(root, path, ref, dependencies, expected);
    if (artifact.payload?.kind !== "source-transcript" || artifact.payload.sourceId !== source.id || artifact.payload.sourceSha256 !== source.sha256
      || artifact.parents.length !== 1 || artifact.parents[0].artifactId !== indexRef.artifactId || artifact.parents[0].sha256 !== indexRef.sha256) {
      throw new Error("Transcript artifact is not bound to the current media-index source");
    }
    transcriptArtifacts.push(artifact);
  }
  const transcripts = transcriptArtifacts.map(({payload}) => payload.transcript);
  const segments = validateStorySegments(input.segments, transcripts);
  const hook = segments.find(({text}) => text.trim().length > 0);
  if (!hook || hook.timelineInMs > 1000) throw new Error("Story plan requires a meaningful hook within the first second");
  const selectedSources = new Map(index.payload.sources.map((source) => [source.id, source]));
  for (const segment of segments) {
    const source = selectedSources.get(segment.sourceId);
    if (!source || segment.sourceSha256 !== source.sha256 || segment.sourceOutMs > Math.round(source.durationSeconds * 1000)) throw new Error("Story segment must select an indexed source by ID and hash");
  }
  const selectedSourceIds = new Set(segments.map(({sourceId}) => sourceId));
  const markedPausesBySource = input.markedPausesBySource ?? Object.groupBy(input.markedPauses ?? [], ({sourceId}) => sourceId);
  const vadSpeechBySource = input.vadSpeechBySource ?? Object.groupBy(input.vadSpeech ?? [], ({sourceId}) => sourceId);
  if (!markedPausesBySource || typeof markedPausesBySource !== "object" || Array.isArray(markedPausesBySource)
    || !vadSpeechBySource || typeof vadSpeechBySource !== "object" || Array.isArray(vadSpeechBySource)) throw new Error("Story silence inputs must be source maps");
  const stagePath = `Plans/.story-${workItemId}-v${revision}-${randomUUID()}`;
  await dependencies.makeDirectories(root, "Plans");
  const stageOwner = await dependencies.makeExclusiveDirectory(root, stagePath);
  let publication;
  try {
    const sourcePlans = [];
    for (const source of index.payload.sources.filter(({id}) => selectedSourceIds.has(id))) {
      const before = await dependencies.hashNoFollow(root, source.path);
      if (before.sha256 !== source.sha256 || before.bytes !== source.bytes) throw new Error(`Source ${source.id} checksum changed since media indexing`);
      await confinedProjectPath(root, source.path, {type: "file"});
      const snapshotPath = `${stagePath}/${source.id}`;
      const owner = await dependencies.copyExclusiveFile(root, source.path, snapshotPath);
      const snapshot = await dependencies.hashNoFollow(root, snapshotPath);
      if (snapshot.sha256 !== source.sha256 || snapshot.bytes !== source.bytes || snapshot.owner.dev !== owner.dev || snapshot.owner.ino !== owner.ino) throw new Error(`Source ${source.id} snapshot changed`);
      const waveformSilence = await detectWaveformSilence(await confinedProjectPath(root, snapshotPath, {type: "file"}), dependencies.run);
      const transcript = transcripts.find(({sourceId}) => sourceId === source.id);
      const silencePlan = buildSilencePlan({durationMs: Math.round(source.durationSeconds * 1000), words: transcript.words, waveformSilence,
        vadSpeech: vadSpeechBySource[source.id] ?? [], markedPauses: markedPausesBySource[source.id] ?? []}, input.silenceOptions);
      const after = await dependencies.hashNoFollow(root, source.path);
      if (!sameStoredFile(before, after)) throw new Error(`Source ${source.id} changed during story planning`);
      sourcePlans.push({sourceId: source.id, sourceSha256: source.sha256, silencePlan});
    }
    const chronologicalAudit = [...segments].toSorted((left, right) => selectedSources.get(left.sourceId).order - selectedSources.get(right.sourceId).order || left.sourceInMs - right.sourceInMs);
    const storyPlan = {kind: "story-plan", chronologicalAudit, segments, silencePlan: sourcePlans, hook: {segmentId: hook.id, firstWordId: hook.firstWordId, timelineInMs: hook.timelineInMs, text: hook.text}, retainedPauses: sourcePlans.flatMap(({sourceId, silencePlan}) => silencePlan.operations.filter(({kind}) => kind === "preserve-dramatic-pause").map((pause) => ({sourceId, ...pause})))};
    const parents = [indexRef, ...refs.map(({artifactId, sha256}) => ({artifactId, sha256}))];
    const artifact = createArtifactEnvelope({artifactId: `story-plan:${workItemId}:v${revision}`, revision: input.revision, workItemId, modality: input.modality,
      parents, producer: input.producer, versions: input.versions, status: "frozen", deviations: [], payload: storyPlan});
    for (const source of index.payload.sources.filter(({id}) => selectedSourceIds.has(id))) {
      const current = await dependencies.hashNoFollow(root, source.path);
      if (current.sha256 !== source.sha256 || current.bytes !== source.bytes) throw new Error(`Source ${source.id} changed before story-plan publication`);
    }
    const path = `Plans/Stories/${workItemId}/story-plan-v${revision}.json`;
    publication = {path};
    const stored = await publish(root, path, artifact, dependencies, (owner) => { publication.owner = owner; });
    return {artifact, artifactRef: {artifactId: artifact.artifactId, sha256: stored.sha256}, storyPlan};
  } catch (error) {
    if (publication?.owner) await dependencies.removeOwnedFile(root, publication.path, publication.owner);
    throw error;
  } finally {
    await dependencies.removeOwnedStage(root, stagePath, stageOwner);
  }
}
