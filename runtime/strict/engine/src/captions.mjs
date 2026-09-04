import {createHash, randomUUID} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname, join, relative, resolve} from "node:path";

import {createArtifactEnvelope, validateArtifactEnvelope} from "./artifacts.mjs";
import {chooseShotCaptionAnchor} from "./caption-placement.mjs";
import {confinedProjectPath} from "./paths.mjs";
import {resolveTechnicalProfile} from "./qc-profiles.mjs";
import {hashFileNoFollow, makeDirectories, makeExclusiveDirectory, readFileNoFollow, removeOwnedFile, removeOwnedStage, renameExclusive, writeExclusiveFile} from "./release-fs.mjs";
import {validateRequiredMattes} from "./subject-map.mjs";
import {getWorkItem, readWorkflowState} from "./workflow.mjs";

const STYLES = new Set(["clean", "editorial-pair", "punch", "karaoke-pair"]);
const SUBJECT_GATES = resolveTechnicalProfile("vertical-short-v1").subject;

function seconds(value, fallbackMs) {
  if (value !== undefined) return Number(value);
  return fallbackMs === undefined ? Number.NaN : Number(fallbackMs) / 1000;
}

function normalizeWord(word) {
  const normalized = {
    text: String(word.text ?? word.word ?? "").trim(),
    start: seconds(word.start ?? word.start_seconds ?? word.start_time, word.start_ms),
    end: seconds(word.end ?? word.end_seconds ?? word.end_time, word.end_ms),
    confidence: Number.isFinite(Number(word.confidence)) ? Number(word.confidence) : null,
  };
  if (typeof word.id === "string") normalized.id = word.id;
  if (typeof word.sourceId === "string") normalized.sourceId = word.sourceId;
  if (word.fontRole === "body" || word.fontRole === "display") normalized.fontRole = word.fontRole;
  return normalized;
}

function parseTokenTable(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Parakeet MLX serializes token frames as a compact typed table, not JSON.
  }

  const [header, ...rows] = value.split(/\r?\n/u);
  const fields = header?.match(/^\[\d+\]\{(.+)\}$/u)?.[1]
    ?.split(",")
    .map((field) => field.split(":", 1)[0]);
  if (!fields?.includes("text") || !fields.includes("start") || !fields.includes("end")) return [];

  return rows.filter(Boolean).map((row) => {
    const cells = row.split(",");
    const values = [...cells.slice(0, fields.length - 1), cells.slice(fields.length - 1).join(",")];
    return Object.fromEntries(fields.map((field, index) => [field, values[index]]));
  });
}

function mergeTokenPieces(tokens) {
  const words = [];
  let current = null;
  const flush = () => {
    if (current?.text) words.push(current);
    current = null;
  };

  for (const token of tokens) {
    const raw = String(token.text ?? token.word ?? "");
    const piece = raw.trim();
    if (!piece) continue;
    if (/^\s/u.test(raw) && current) flush();
    const normalized = normalizeWord({...token, text: piece});
    if (!current) current = {...normalized};
    else {
      current.text += piece;
      current.end = normalized.end;
    }
  }
  flush();
  return words;
}

function sentenceFallback(sentence) {
  const parts = String(sentence.text ?? "").trim().split(/\s+/u).filter(Boolean);
  const start = Number(sentence.start);
  const end = Number(sentence.end);
  if (!parts.length || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const step = (end - start) / parts.length;
  return parts.map((text, index) => ({text, start: start + step * index, end: start + step * (index + 1)}));
}

export function extractWords(transcript) {
  if (Array.isArray(transcript?.words)) return transcript.words.map(normalizeWord);
  const segments = Array.isArray(transcript) ? transcript : transcript?.segments;
  if (Array.isArray(segments)) {
    return segments.flatMap((segment) => Array.isArray(segment.words)
      ? segment.words.map(normalizeWord)
      : sentenceFallback(segment));
  }
  if (Array.isArray(transcript?.sentences)) {
    return transcript.sentences.flatMap((sentence) => {
      const words = mergeTokenPieces(parseTokenTable(sentence.tokens));
      return words.length ? words : sentenceFallback(sentence);
    });
  }
  return [];
}

function cueText(words) {
  return words.map(({text}) => text).join(" ").replace(/\s+([,.;!?…])/gu, "$1");
}

function validateWords(words) {
  if (!words.length) throw new Error("Transcript contains no timed words");
  let previousStart = -1;
  for (const [index, word] of words.entries()) {
    if (!word.text || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.end <= word.start) {
      throw new Error(`Word ${index + 1} has invalid text or timing`);
    }
    if (word.start < previousStart) throw new Error(`Word ${index + 1} starts before the previous word`);
    previousStart = word.start;
  }
}

export function buildCaptionBundle(transcript, {maxWords = 5, maxChars = 42, maxDurationSeconds = 2.8} = {}) {
  if (!Number.isInteger(maxWords) || maxWords < 1 || !Number.isInteger(maxChars) || maxChars < 1) {
    throw new Error("Caption maxWords and maxChars must be positive integers");
  }
  const words = extractWords(transcript);
  validateWords(words);

  const segments = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    segments.push({
      start: current[0].start,
      end: current.at(-1).end,
      text: cueText(current),
      words: current,
    });
    current = [];
  };

  for (const word of words) {
    const projected = cueText([...current, word]);
    const gap = current.length ? word.start - current.at(-1).end : 0;
    if (current.length && (current.length >= maxWords || projected.length > maxChars || gap > 0.65
      || word.end - current[0].start > maxDurationSeconds)) flush();
    current.push(word);
    if (/[.!?…]["'”’)]?$/u.test(word.text)) flush();
  }
  flush();

  return {
    schemaVersion: 1,
    sourceFormat: "parakeet-word-timestamps",
    durationSeconds: words.at(-1).end,
    segments,
  };
}

export function applyCaptionAnchorPlan(bundle, anchorPlan, {style = "editorial-pair"} = {}) {
  if (style === "punch" && !Array.isArray(anchorPlan?.segments)) throw new Error("Punch requires an explicit anchor plan");
  if (anchorPlan !== undefined && !Array.isArray(anchorPlan?.segments)) throw new Error("Caption anchor plan segments must be an array");
  const requested = new Map();
  for (const entry of anchorPlan?.segments ?? []) {
    const cueIndex = entry?.cueIndex;
    if (!Number.isInteger(cueIndex) || cueIndex < 0 || cueIndex >= bundle.segments.length) {
      throw new Error("Caption anchor plan contains an invalid anchor cue index");
    }
    if (requested.has(cueIndex)) throw new Error("Caption anchor plan contains a duplicate anchor cue index");
    if (!Array.isArray(entry.wordIndices)) throw new Error(`Caption ${cueIndex + 1} anchor wordIndices must be an array`);
    requested.set(cueIndex, entry.wordIndices);
  }
  return {
    ...bundle,
    segments: bundle.segments.map((segment, cueIndex) => {
      const indices = requested.get(cueIndex) ?? [];
      if (style === "punch" && (indices.length < 1 || indices.length > 3)) throw new Error(`Punch caption ${cueIndex + 1} must use 1-3 display words`);
      if (style !== "punch" && indices.length > 2) throw new Error(`Caption ${cueIndex + 1} may use at most two display words`);
      if (indices.some((index) => !Number.isInteger(index) || index < 0 || index >= segment.words.length)) {
        throw new Error(`Caption ${cueIndex + 1} contains an invalid anchor word index`);
      }
      const selected = new Set(indices);
      if (style === "punch" && selected.size === segment.words.length) throw new Error(`Punch caption ${cueIndex + 1} requires at least one body support word`);
      return {
        ...segment,
        words: segment.words.map((word, index) => ({...word, fontRole: selected.has(index) ? "display" : "body"})),
      };
    }),
  };
}

function timestamp(value, separator) {
  const totalMs = Math.round(value * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secondsPart = Math.floor((totalMs % 60_000) / 1000);
  const milliseconds = totalMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secondsPart).padStart(2, "0")}${separator}${String(milliseconds).padStart(3, "0")}`;
}

function srt(segments) {
  return `${segments.map((segment, index) => `${index + 1}\n${timestamp(segment.start, ",")} --> ${timestamp(segment.end, ",")}\n${segment.text}`).join("\n\n")}\n`;
}

function vtt(segments) {
  return `WEBVTT\n\n${segments.map((segment) => `${timestamp(segment.start, ".")} --> ${timestamp(segment.end, ".")}\n${segment.text}`).join("\n\n")}\n`;
}

async function readProjectJson(projectDir, path, label) {
  const file = resolve(path);
  const relativePath = relative(resolve(projectDir), file);
  if (!relativePath || relativePath.startsWith("../")) throw new Error(`${label} must be a project-local file`);
  await confinedProjectPath(projectDir, relativePath, {type: "file"});
  return JSON.parse((await readFileNoFollow(projectDir, relativePath)).bytes.toString("utf8"));
}

async function applyShotPlacements(projectDir, bundle, {subjectMapPath, shots} = {}) {
  if (subjectMapPath === undefined && shots === undefined) return bundle;
  if (typeof subjectMapPath !== "string" || !Array.isArray(shots) || !shots.length) {
    throw new Error("Subject-aware captions require a subject map and story shots");
  }
  const subjectMap = await readProjectJson(projectDir, subjectMapPath, "Subject map");
  const frameSize = subjectMap?.frameSize;
  if (!Number.isInteger(frameSize?.width) || !Number.isInteger(frameSize?.height) || !Array.isArray(subjectMap.frames)) {
    throw new Error("Subject map must contain pixel frame dimensions and frames");
  }
  const avoidRegions = subjectMap.frames.flatMap((frame) => {
    const regions = [...(frame.faces ?? []).map((face) => face?.box), frame.subjectBox].filter(Boolean);
    return regions.map((box) => ({timeMs: frame.timeMs, box}));
  });
  const placements = new Map(shots.map((shot) => [shot.id, chooseShotCaptionAnchor({
    frameSize,
    shot,
    avoidRegions,
    captionSize: {width: 900, height: 220},
  })]));
  return {
    ...bundle,
    segments: bundle.segments.map((segment) => {
      const startMs = Math.round(segment.start * 1000);
      const endMs = Math.round(segment.end * 1000);
      const shot = shots.find((candidate) => startMs >= candidate.startMs && endMs <= candidate.endMs);
      if (!shot || !placements.has(shot.id)) throw new Error("Every caption cue must be contained by one story shot");
      return {...segment, shotId: shot.id, placement: placements.get(shot.id)};
    }),
  };
}

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const pad = (value) => String(value).padStart(3, "0");

function ref(value, label) {
  const artifactId = value?.artifactId ?? value?.id;
  if (typeof artifactId !== "string" || !SHA256.test(value?.sha256)) throw new Error(`${label} must contain an artifact ID and SHA-256`);
  return {artifactId, sha256: value.sha256};
}

async function readArtifact(root, path, expectedRef, label, dependencies) {
  const [contents, descriptor] = await Promise.all([
    dependencies.readFileNoFollow(root, path), dependencies.hashFileNoFollow(root, path),
  ]);
  const bufferHash = createHash("sha256").update(contents.bytes).digest("hex");
  if (bufferHash !== expectedRef.sha256 || descriptor.sha256 !== bufferHash || descriptor.bytes !== contents.bytes.length
    || descriptor.owner.dev !== contents.owner.dev || descriptor.owner.ino !== contents.owner.ino) {
    throw new Error(`${label} does not match its exact immutable reference`);
  }
  let artifact;
  try { artifact = JSON.parse(contents.bytes.toString("utf8")); } catch { throw new Error(`${label} is not JSON`); }
  validateArtifactEnvelope(artifact);
  if (artifact.artifactId !== expectedRef.artifactId) throw new Error(`${label} artifact ID does not match its reference`);
  return {artifact, snapshot: {sha256: bufferHash, bytes: contents.bytes.length, owner: contents.owner, mtimeMs: descriptor.mtimeMs}};
}

function artifactIdentity(artifact, input, kind, role) {
  if (artifact.workItemId !== input.workItemId || artifact.revision !== input.revision || artifact.modality !== input.modality
    || artifact.status !== "frozen" || artifact.payload?.kind !== kind || artifact.producer?.role !== role) {
    throw new Error(`${kind} is not current for this work item, revision, modality, and role`);
  }
}

function exactSourceRefs(values, {kind, workItemId, revision, sourceIds, label}) {
  if (!Array.isArray(values)) throw new Error(`${label} refs must select every selected source exactly once`);
  const escapedWorkItemId = workItemId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`^${kind}:${escapedWorkItemId}:([A-Za-z0-9][A-Za-z0-9._-]*):v${revision}$`, "u");
  const bySource = new Map();
  for (const value of values) {
    const artifactRef = ref(value, `${label} artifact ref`);
    const match = pattern.exec(artifactRef.artifactId);
    if (!match || !sourceIds.has(match[1])) throw new Error(`${label} artifact ref names a cross-source or non-current source`);
    if (bySource.has(match[1])) throw new Error(`Duplicate ${label} artifact ref for ${match[1]}`);
    bySource.set(match[1], artifactRef);
  }
  if (bySource.size !== sourceIds.size) throw new Error(`${label} refs must select every selected source exactly once`);
  return bySource;
}

function sameSnapshot(left, right) {
  return left.sha256 === right.sha256 && left.bytes === right.bytes && left.mtimeMs === right.mtimeMs
    && left.owner.dev === right.owner.dev && left.owner.ino === right.owner.ino;
}

function removalRanges(silencePlan, sourceId) {
  const matching = (silencePlan ?? []).filter((entry) => entry?.sourceId === sourceId);
  if (matching.length !== 1 || !Array.isArray(matching[0]?.silencePlan?.operations)) {
    throw new Error(`Story silence plan must contain one approved source plan for ${sourceId}`);
  }
  const ranges = matching[0].silencePlan.operations.flatMap((operation) => {
    if (!["compress-gap", "trim-leading-silence", "trim-trailing-silence", "preserve-dramatic-pause"].includes(operation?.kind)) {
      throw new Error(`Story silence plan contains an unapproved operation for ${sourceId}`);
    }
    if (operation.kind === "preserve-dramatic-pause") return [];
    const startMs = operation.removeStartMs ?? operation.startMs;
    const endMs = operation.removeEndMs ?? operation.endMs;
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs <= startMs) {
      throw new Error(`Story silence plan contains an invalid removal for ${sourceId}`);
    }
    return [{startMs, endMs}];
  }).toSorted((left, right) => left.startMs - right.startMs);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].startMs < ranges[index - 1].endMs) throw new Error(`Story silence removals overlap for ${sourceId}`);
  }
  return ranges;
}

function removedDuration(ranges, startMs, endMs) {
  return ranges.reduce((total, range) => total + Math.max(0, Math.min(endMs, range.endMs) - Math.max(startMs, range.startMs)), 0);
}

function retimedTime(ranges, shot, sourceTimeMs) {
  return shot.timelineInMs + sourceTimeMs - shot.sourceInMs - removedDuration(ranges, shot.sourceInMs, sourceTimeMs);
}

function selectedShotWords(shot, transcript, ranges) {
  if (!Array.isArray(shot.wordIds) || !shot.wordIds.length || shot.firstWordId !== shot.wordIds[0]
    || shot.lastWordId !== shot.wordIds.at(-1)) throw new Error(`Story shot ${shot.id} must preserve exact selected word IDs`);
  const positions = shot.wordIds.map((id) => transcript.words.findIndex((word) => word.id === id));
  if (positions.some((position, index) => position < 0 || (index && position !== positions[index - 1] + 1))) {
    throw new Error(`Story shot ${shot.id} does not select an exact contiguous transcript range`);
  }
  return positions.map((position) => transcript.words[position]).map((word) => {
    if (!word.id.startsWith(`${shot.sourceId}:`) || !Number.isSafeInteger(word.startMs) || !Number.isSafeInteger(word.endMs)
      || word.startMs < shot.sourceInMs || word.endMs > shot.sourceOutMs || word.endMs <= word.startMs
      || ranges.some((range) => word.startMs < range.endMs && range.startMs < word.endMs)) {
      throw new Error(`Story shot ${shot.id} contains an invalid or silence-crossing transcript word`);
    }
    return {...word, sourceId: shot.sourceId, start: retimedTime(ranges, shot, word.startMs) / 1000,
      end: retimedTime(ranges, shot, word.endMs) / 1000};
  });
}

function sourceAvoidRegions(subjectMap, shot, ranges) {
  return subjectMap.frames.flatMap((frame) => {
    if (!Number.isSafeInteger(frame?.timeMs) || frame.timeMs < shot.sourceInMs || frame.timeMs >= shot.sourceOutMs
      || ranges.some((range) => frame.timeMs >= range.startMs && frame.timeMs < range.endMs)) return [];
    const regions = Array.isArray(frame.avoidRegions) && frame.avoidRegions.length
      ? frame.avoidRegions
      : [...(frame.faces ?? []), ...(frame.subjectBox ? [{box: frame.subjectBox}] : [])];
    return regions.map(({box}) => ({timeMs: retimedTime(ranges, shot, frame.timeMs), box}));
  });
}

function assertSubjectRequirements(subjectMap, input, sourceId, shot, ranges) {
  if (!Number.isInteger(subjectMap.frameSize?.width) || !Number.isInteger(subjectMap.frameSize?.height) || !Array.isArray(subjectMap.frames)) {
    throw new Error(`SubjectMap for ${sourceId} has invalid frame geometry`);
  }
  if (subjectMap.coordinateSpace !== "top-left-pixels" || subjectMap.sourceSnapshot?.sha256 !== subjectMap.sourceSha256
    || !Number.isSafeInteger(subjectMap.sourceSnapshot?.bytes) || subjectMap.sourceSnapshot.bytes < 1
    || subjectMap.expectedFrameCount !== subjectMap.frames.length
    || subjectMap.frames.some((frame, index) => frame?.index !== index || !Number.isSafeInteger(frame.timeMs))) {
    throw new Error(`SubjectMap for ${sourceId} has invalid source-relative tracking data`);
  }
  const requestedMatte = input.requiredMatte === true || input.requiredDepth === true || input.depth === "required"
    || input.backgroundRemoval === "required" || input.textBehindSubject === "required";
  const matteRequired = requestedMatte || subjectMap.mattes?.required === true;
  const trackingRequired = input.requiredTracking === true || matteRequired;
  if (trackingRequired) {
    const tracking = subjectMap.tracking;
    const relevant = subjectMap.frames.filter((frame) => frame.timeMs >= shot.sourceInMs && frame.timeMs < shot.sourceOutMs
      && !ranges.some((range) => frame.timeMs >= range.startMs && frame.timeMs < range.endMs));
    const range = subjectMap.timeRangeMs;
    if (!subjectMap.frames.length || tracking?.status !== "tracked" || tracking.personAnalysisAvailable !== true
      || !Number.isFinite(tracking.confidence) || tracking.confidence < SUBJECT_GATES.minTrackingConfidence
      || !Number.isFinite(tracking.maxJitterPx) || tracking.maxJitterPx > SUBJECT_GATES.maxJitterPx
      || !Array.isArray(tracking.discontinuities) || tracking.discontinuities.length
      || !Number.isFinite(range?.startMs) || !Number.isFinite(range?.endMs) || range.startMs > shot.sourceInMs || range.endMs < shot.sourceOutMs
      || !relevant.length || relevant.some((frame) => !frame.subjectBox || !Number.isFinite(frame.confidence)
        || frame.confidence < SUBJECT_GATES.minTrackingConfidence || !Number.isFinite(frame.jitterPx)
        || frame.jitterPx > SUBJECT_GATES.maxJitterPx || frame.discontinuity !== false)) {
      throw new Error(`Required tracking for ${sourceId}/${shot.id} fails frozen confidence, jitter, continuity, or shot coverage thresholds`);
    }
  }
  if (requestedMatte && subjectMap.mattes?.required !== true) throw new Error(`Required mattes were not required by SubjectMap for ${sourceId}`);
  if (matteRequired) validateRequiredMattes(subjectMap);
  return trackingRequired;
}

function artifactCaptionSegments(story, transcriptsBySource, subjectMapsBySource, input) {
  const segments = [];
  const shotIds = new Set();
  for (const shot of story.segments) {
    if (!SAFE_ID.test(shot?.id ?? "") || shotIds.has(shot.id)) throw new Error("Story shot IDs must be unique safe identifiers");
    shotIds.add(shot.id);
    const transcript = transcriptsBySource.get(shot.sourceId);
    const subjectMap = subjectMapsBySource.get(shot.sourceId);
    const ranges = removalRanges(story.silencePlan, shot.sourceId);
    const words = selectedShotWords(shot, transcript, ranges);
    const shotEndMs = retimedTime(ranges, shot, shot.sourceOutMs);
    if (!Number.isSafeInteger(shot.timelineInMs) || !Number.isSafeInteger(shot.sourceInMs) || !Number.isSafeInteger(shot.sourceOutMs)
      || shot.sourceOutMs <= shot.sourceInMs || shotEndMs <= shot.timelineInMs) throw new Error(`Story shot ${shot.id} has invalid timing`);
    const placement = chooseShotCaptionAnchor({frameSize: subjectMap.frameSize,
      shot: {id: shot.id, startMs: shot.timelineInMs, endMs: shotEndMs,
        faceAwareRequired: assertSubjectRequirements(subjectMap, input, shot.sourceId, shot, ranges)},
      avoidRegions: sourceAvoidRegions(subjectMap, shot, ranges), captionSize: {width: 900, height: 220}});
    const shotBundle = buildCaptionBundle({words});
    segments.push(...shotBundle.segments.map((segment) => ({...segment, shotId: shot.id, placement})));
  }
  return {schemaVersion: 1, sourceFormat: "story-retimed-word-timestamps",
    durationSeconds: Math.max(...segments.map(({end}) => end)), segments};
}

export async function writeArtifactCaptionBundle(projectDir, input, adapters = {}) {
  const dependencies = {
    hashFileNoFollow: adapters.hashFileNoFollow ?? hashFileNoFollow,
    makeDirectories: adapters.makeDirectories ?? makeDirectories,
    makeExclusiveDirectory: adapters.makeExclusiveDirectory ?? makeExclusiveDirectory,
    readFileNoFollow: adapters.readFileNoFollow ?? readFileNoFollow,
    removeOwnedFile: adapters.removeOwnedFile ?? removeOwnedFile,
    removeOwnedStage: adapters.removeOwnedStage ?? removeOwnedStage,
    renameExclusive: adapters.renameExclusive ?? renameExclusive,
    writeExclusiveFile: adapters.writeExclusiveFile ?? writeExclusiveFile,
    readWorkflowState: adapters.readWorkflowState ?? readWorkflowState,
  };
  const workItemId = input?.workItemId;
  if (!SAFE_ID.test(workItemId ?? "") || !Number.isInteger(input?.revision) || input.revision < 1 || input.revision > 999) throw new Error("Caption work item and revision are required");
  if (!["raw-video", "multi-clip"].includes(input.modality) || input.producer?.role !== "caption-executor" || !input.producer.actorId || !input.versions) {
    throw new Error("Caption executor, modality, and versions are required");
  }
  const style = input.style === "karaoke" ? "karaoke-pair" : input.style ?? "editorial-pair";
  if (!STYLES.has(style)) throw new Error(`Caption style must be one of: ${[...STYLES].join(", ")}`);
  const state = await dependencies.readWorkflowState(projectDir);
  const item = getWorkItem(state, workItemId);
  if (item.revision !== input.revision || item.modality !== input.modality || item.state !== "STORY_PLANNED") throw new Error("Captions require the current STORY_PLANNED work item");
  const revision = pad(input.revision);
  const storyRef = ref(input.storyArtifactRef, "Story artifact ref");
  const storyPath = `Plans/Stories/${workItemId}/story-plan-v${revision}.json`;
  const storyRead = await readArtifact(projectDir, storyPath, storyRef, "Story plan", dependencies);
  const story = storyRead.artifact;
  artifactIdentity(story, input, "story-plan", "story-editor");
  if (story.artifactId !== `story-plan:${workItemId}:v${revision}` || !Array.isArray(story.payload.segments) || !story.payload.segments.length) {
    throw new Error("Story plan is not the current source selection");
  }
  const selectedSourceIds = new Set(story.payload.segments.map(({sourceId}) => sourceId));
  if (selectedSourceIds.has(undefined) || [...selectedSourceIds].some((sourceId) => !SAFE_ID.test(sourceId))) throw new Error("Story plan contains an invalid source ID");
  const transcriptRefs = exactSourceRefs(input.transcriptArtifactRefs, {kind: "source-transcript", workItemId, revision,
    sourceIds: selectedSourceIds, label: "Transcript"});
  let subjectValues = input.subjectMapArtifactRefs;
  let legacySubjectPath;
  if (subjectValues === undefined && input.subjectMapArtifactRef !== undefined) {
    if (selectedSourceIds.size !== 1) throw new Error("Subject-map refs must select every selected source exactly once");
    const legacyRef = ref(input.subjectMapArtifactRef, "Subject-map artifact ref");
    const sourceId = [...selectedSourceIds][0];
    const legacyId = `subject-map:${workItemId}:v${revision}`;
    if (legacyRef.artifactId === legacyId) {
      subjectValues = [{...legacyRef, artifactId: `subject-map:${workItemId}:${sourceId}:v${revision}`}];
      legacySubjectPath = {sourceId, ref: legacyRef, path: `Plans/Subjects/${workItemId}/subject-map-v${revision}.json`};
    } else subjectValues = [legacyRef];
  }
  const subjectRefs = exactSourceRefs(subjectValues, {kind: "subject-map", workItemId, revision,
    sourceIds: selectedSourceIds, label: "Subject-map"});
  const mediaParents = story.parents.filter(({artifactId}) => artifactId === `media-index:${workItemId}:v${revision}`);
  if (mediaParents.length !== 1) throw new Error("Story plan must bind exactly one current media-index parent");
  const mediaParent = mediaParents[0];
  const inputArtifacts = [{path: storyPath, ref: storyRef, label: "Story plan", snapshot: storyRead.snapshot}];
  const transcriptsBySource = new Map();
  for (const [sourceId, transcriptRef] of transcriptRefs) {
    const path = `Plans/Transcripts/${workItemId}/v${revision}/${sourceId}-v${revision}.json`;
    const read = await readArtifact(projectDir, path, transcriptRef, `Source transcript ${sourceId}`, dependencies);
    const artifact = read.artifact;
    artifactIdentity(artifact, input, "source-transcript", "local-media-technician");
    if (artifact.payload.sourceId !== sourceId || artifact.payload.sourceSha256 !== artifact.payload.transcript?.sourceSha256
      || artifact.payload.transcript?.sourceId !== sourceId || artifact.payload.transcript?.timeBase !== "source-relative-ms"
      || !Array.isArray(artifact.payload.transcript?.words) || !artifact.payload.transcript.words.length
      || artifact.parents.length !== 1 || artifact.parents[0].artifactId !== mediaParent.artifactId || artifact.parents[0].sha256 !== mediaParent.sha256
      || !story.parents.some((parent) => parent.artifactId === transcriptRef.artifactId && parent.sha256 === transcriptRef.sha256)) {
      throw new Error(`Source transcript ${sourceId} is not bound to the story and current media-index source`);
    }
    transcriptsBySource.set(sourceId, artifact.payload.transcript);
    inputArtifacts.push({path, ref: transcriptRef, label: `Source transcript ${sourceId}`, snapshot: read.snapshot});
  }
  const subjectMapsBySource = new Map();
  for (const [sourceId, canonicalRef] of subjectRefs) {
    const legacy = legacySubjectPath?.sourceId === sourceId ? legacySubjectPath : null;
    const path = legacy?.path ?? `Plans/Subjects/${workItemId}/v${revision}/${sourceId}-v${revision}.json`;
    const expectedRef = legacy?.ref ?? canonicalRef;
    const read = await readArtifact(projectDir, path, expectedRef, `SubjectMap ${sourceId}`, dependencies);
    const artifact = read.artifact;
    artifactIdentity(artifact, input, "subject-map", "subject-analyst");
    if ((!legacy && artifact.artifactId !== canonicalRef.artifactId) || artifact.payload.sourceId !== sourceId
      || artifact.payload.sourceSha256 !== transcriptsBySource.get(sourceId).sourceSha256
      || artifact.parents.length !== 1 || artifact.parents[0].artifactId !== mediaParent.artifactId || artifact.parents[0].sha256 !== mediaParent.sha256) {
      throw new Error(`SubjectMap ${sourceId} is cross-source or not bound to the current media-index source`);
    }
    subjectMapsBySource.set(sourceId, artifact.payload);
    inputArtifacts.push({path, ref: expectedRef, label: `SubjectMap ${sourceId}`, snapshot: read.snapshot});
  }
  for (const shot of story.payload.segments) {
    if (shot.sourceSha256 !== transcriptsBySource.get(shot.sourceId)?.sourceSha256) throw new Error(`Story shot ${shot.id} source hash does not match its transcript`);
  }
  const bundle = artifactCaptionSegments(story.payload, transcriptsBySource, subjectMapsBySource, input);
  const styled = applyCaptionAnchorPlan(bundle, input.anchorPlan, {style});
  const parentRefs = [storyRef, ...input.transcriptArtifactRefs.map((value) => ref(value, "Transcript artifact ref")),
    ...(input.subjectMapArtifactRefs ?? [input.subjectMapArtifactRef]).map((value) => ref(value, "Subject-map artifact ref"))];
  const stagePath = `Renders/Captions/${workItemId}/.v${revision}-${randomUUID()}`;
  const finalPath = `Renders/Captions/${workItemId}/v${revision}`;
  await dependencies.makeDirectories(projectDir, `Renders/Captions/${workItemId}`);
  const stageOwner = await dependencies.makeExclusiveDirectory(projectDir, stagePath);
  let published = false;
  let planOwner;
  const recheckInputs = async () => {
    for (const inputArtifact of inputArtifacts) {
      const current = await readArtifact(projectDir, inputArtifact.path, inputArtifact.ref, inputArtifact.label, dependencies);
      if (!sameSnapshot(inputArtifact.snapshot, current.snapshot)) throw new Error(`${inputArtifact.label} changed during caption publication`);
    }
  };
  try {
    const files = {
      json: `${stagePath}/captions.json`, srt: `${stagePath}/captions.srt`, vtt: `${stagePath}/captions.vtt`,
      hyperframes: `${stagePath}/captions.hyperframes.json`,
    };
    const contents = {
      json: `${JSON.stringify(styled, null, 2)}\n`, srt: srt(styled.segments), vtt: vtt(styled.segments),
      hyperframes: `${JSON.stringify({captions: JSON.stringify(styled), style, durationSeconds: styled.durationSeconds}, null, 2)}\n`,
    };
    const fileOwners = {};
    for (const [name, path] of Object.entries(files)) fileOwners[name] = await dependencies.writeExclusiveFile(projectDir, path, Buffer.from(contents[name], "utf8"));
    await recheckInputs();
    await dependencies.renameExclusive(projectDir, stagePath, finalPath, stageOwner);
    published = true;
    const hashes = {};
    for (const name of Object.keys(files)) {
      const fileName = name === "hyperframes" ? "captions.hyperframes.json" : `captions.${name}`;
      const path = `${finalPath}/${fileName}`;
      const stored = await dependencies.hashFileNoFollow(projectDir, path);
      const expectedBytes = Buffer.from(contents[name], "utf8");
      if (stored.sha256 !== createHash("sha256").update(expectedBytes).digest("hex") || stored.bytes !== expectedBytes.length
        || stored.owner.dev !== fileOwners[name].dev || stored.owner.ino !== fileOwners[name].ino) throw new Error(`Caption ${name} changed after directory publication`);
      hashes[name] = stored;
    }
    const artifact = createArtifactEnvelope({artifactId: `caption-plan:${workItemId}:v${revision}`, revision: input.revision, workItemId,
      modality: input.modality, parents: parentRefs, producer: input.producer, versions: input.versions, status: "frozen",
      deviations: styled.segments.flatMap(({placement}) => placement?.deviation ? [{code: placement.deviation}] : []),
      payload: {kind: "caption-plan", files: Object.fromEntries(Object.entries(hashes).map(([name, value]) => [name, {path: `${finalPath}/${name === "hyperframes" ? "captions.hyperframes.json" : `captions.${name}`}`, sha256: value.sha256, bytes: value.bytes}])),
        placements: [...new Map(styled.segments.map(({shotId, placement}) => [shotId, {shotId, placement}])).values()],
        cues: styled.segments.map((segment, index) => ({cueId: `cue-${String(index + 1).padStart(3, "0")}`, shotId: segment.shotId,
          storySegmentId: segment.shotId, sourceIds: [...new Set(segment.words.map(({sourceId}) => sourceId))], wordIds: segment.words.map(({id}) => id),
          startMs: Math.round(segment.start * 1000), endMs: Math.round(segment.end * 1000), identity: style,
          fontRoles: [...new Set(segment.words.map(({fontRole}) => fontRole))], placement: segment.placement})),
      },
    });
    const planPath = `Plans/Captions/${workItemId}/caption-plan-v${revision}.json`;
    await dependencies.makeDirectories(projectDir, dirname(planPath));
    const artifactBytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    planOwner = await dependencies.writeExclusiveFile(projectDir, planPath, artifactBytes);
    const stored = await readArtifact(projectDir, planPath, {artifactId: artifact.artifactId, sha256: createHash("sha256").update(artifactBytes).digest("hex")}, "Caption plan", dependencies);
    if (stored.snapshot.owner.dev !== planOwner.dev || stored.snapshot.owner.ino !== planOwner.ino) throw new Error("Caption plan changed after publication");
    await recheckInputs();
    for (const [name, before] of Object.entries(hashes)) {
      const path = artifact.payload.files[name].path;
      if (!sameSnapshot(before, await dependencies.hashFileNoFollow(projectDir, path))) throw new Error(`Caption ${name} changed before plan publication completed`);
    }
    return {artifact: stored.artifact, artifactRef: {artifactId: artifact.artifactId, sha256: stored.snapshot.sha256}, bundle: styled,
      files: Object.fromEntries(Object.keys(files).map((name) => [name, `${finalPath}/${name === "hyperframes" ? "captions.hyperframes.json" : `captions.${name}`}`]))};
  } catch (error) {
    if (planOwner) await dependencies.removeOwnedFile(projectDir, `Plans/Captions/${workItemId}/caption-plan-v${revision}.json`, planOwner).catch(() => false);
    if (published) await dependencies.removeOwnedStage(projectDir, finalPath, stageOwner).catch(() => false);
    throw error;
  } finally {
    if (!published) await dependencies.removeOwnedStage(projectDir, stagePath, stageOwner).catch(() => false);
  }
}

export async function writeCaptionBundle(projectDir, transcriptPath, options = {}) {
  const style = options.style === "karaoke" ? "karaoke-pair" : options.style ?? "karaoke-pair";
  if (!STYLES.has(style)) throw new Error(`Caption style must be one of: ${[...STYLES].join(", ")}`);
  const transcript = options.subjectMapPath === undefined
    ? JSON.parse(await readFile(transcriptPath, "utf8"))
    : await readProjectJson(projectDir, transcriptPath, "Transcript");
  const anchored = applyCaptionAnchorPlan(buildCaptionBundle(transcript, options), options.anchorPlan, {style});
  const bundle = await applyShotPlacements(projectDir, anchored, options);
  const outputDir = join(projectDir, "Renders", "Captions");
  await mkdir(outputDir, {recursive: true});
  const paths = {
    json: join(outputDir, "captions.json"),
    srt: join(outputDir, "captions.srt"),
    vtt: join(outputDir, "captions.vtt"),
    hyperframes: join(outputDir, "captions.hyperframes.json"),
  };
  await Promise.all([
    writeFile(paths.json, `${JSON.stringify(bundle, null, 2)}\n`, "utf8"),
    writeFile(paths.srt, srt(bundle.segments), "utf8"),
    writeFile(paths.vtt, vtt(bundle.segments), "utf8"),
    writeFile(paths.hyperframes, `${JSON.stringify({
      captions: JSON.stringify(bundle),
      style,
      durationSeconds: Math.ceil((bundle.durationSeconds + 0.25) * 1000) / 1000,
    }, null, 2)}\n`, "utf8"),
  ]);
  return {
    count: bundle.segments.length,
    durationSeconds: bundle.durationSeconds,
    style,
    files: Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, relative(projectDir, path)])),
  };
}
