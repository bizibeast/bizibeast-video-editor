import {createHash} from "node:crypto";
import {realpath} from "node:fs/promises";

import {recordApproval} from "./approvals.mjs";
import {createArtifactEnvelope, validateArtifactEnvelope} from "./artifacts.mjs";
import {canonicalJson, sha256Value} from "./checksum.mjs";
import {readManifest} from "./manifest.mjs";
import {hashFileNoFollow, makeDirectories, readFileNoFollow, removeOwnedFile, writeExclusiveFile} from "./release-fs.mjs";
import {assertIndependentReviewer} from "./roles.mjs";
import {getWorkItem, readWorkflowState} from "./workflow.mjs";
import {readFrozenBrand} from "./sunburst.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SHOT_KEYS = ["acceptance", "assets", "audio", "captions", "depth", "editorOwner", "grading", "id", "onScreenCopy", "source", "stylePresetId", "subject", "timeline", "transitions"];
const CAPTION_IDENTITIES = new Set(["clean", "editorial-pair", "punch", "karaoke-pair"]);
const STYLE_PRESETS = new Set(["sunburst-standard-v1", "cinematic-layered-explainer-v1"]);
const FPS = 30;
const NO_AE = /(?:after[ -]?effects|\bae\b)/iu;

const pad = (value) => String(value).padStart(3, "0");

function text(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${label} has unknown or missing fields`);
  }
  return value;
}

function ref(value, label) {
  const artifactId = value?.artifactId ?? value?.id;
  if (typeof artifactId !== "string" || !artifactId.trim() || !SHA256.test(value?.sha256)) throw new Error(`${label} requires an artifact ID and SHA-256`);
  return {artifactId, sha256: value.sha256};
}

function sourceIdFromArtifact(refValue, kind, workItemId, revision) {
  const match = new RegExp(`^${kind}:${workItemId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}:([A-Za-z0-9][A-Za-z0-9._-]*):v${pad(revision)}$`, "u").exec(refValue.artifactId);
  if (!match) throw new Error(`${kind} reference is not current for this work item and revision`);
  return match[1];
}

function artifactPath(kind, workItemId, revision, sourceId) {
  const suffix = pad(revision);
  if (kind === "story") return `Plans/Stories/${workItemId}/story-plan-v${suffix}.json`;
  if (kind === "asset") return `Plans/Assets/${workItemId}/asset-plan-v${suffix}.json`;
  if (kind === "caption") return `Plans/Captions/${workItemId}/caption-plan-v${suffix}.json`;
  if (kind === "transcript") return `Plans/Transcripts/${workItemId}/v${suffix}/${sourceId}-v${suffix}.json`;
  if (kind === "subject") return `Plans/Subjects/${workItemId}/v${suffix}/${sourceId}-v${suffix}.json`;
  if (kind === "foreground") return `Plans/Foreground/${workItemId}/${sourceId}/foreground-sidecar-v${suffix}.json`;
  throw new Error("Unknown design artifact kind");
}

function designPlanPath(workItemId, revision) {
  return `Plans/Designs/${workItemId}/design-plan-v${pad(revision)}.json`;
}

async function readExactArtifact(root, path, expected, label) {
  const [contents, descriptor] = await Promise.all([readFileNoFollow(root, path), hashFileNoFollow(root, path)]);
  const hash = createHash("sha256").update(contents.bytes).digest("hex");
  if (hash !== expected.sha256 || descriptor.sha256 !== hash || descriptor.bytes !== contents.bytes.length
    || descriptor.owner.dev !== contents.owner.dev || descriptor.owner.ino !== contents.owner.ino) {
    throw new Error(`${label} does not match its current immutable bytes`);
  }
  let artifact;
  try { artifact = JSON.parse(contents.bytes.toString("utf8")); } catch { throw new Error(`${label} is not JSON`); }
  validateArtifactEnvelope(artifact);
  if (artifact.artifactId !== expected.artifactId) throw new Error(`${label} artifact ID does not match its reference`);
  return artifact;
}

function assertCurrentArtifact(artifact, expected, kind, role) {
  if (artifact.workItemId !== expected.workItemId || artifact.revision !== expected.revision || artifact.modality !== expected.modality
    || artifact.status !== "frozen" || artifact.payload?.kind !== kind || artifact.producer?.role !== role) {
    throw new Error(`${kind} is not current for this work item, revision, modality, and role`);
  }
  return artifact;
}

function uniqueRefs(values, label) {
  if (!Array.isArray(values) || !values.length) throw new Error(`${label} refs are required`);
  const result = values.map((value) => ref(value, `${label} artifact ref`));
  if (new Set(result.map(({artifactId}) => artifactId)).size !== result.length) throw new Error(`${label} refs must be unique`);
  return result;
}

function isPremiereOnly(value) {
  return !NO_AE.test(JSON.stringify(value));
}

function requireRange(value, label) {
  if (!value || !Number.isSafeInteger(value.inMs) || !Number.isSafeInteger(value.outMs) || value.inMs < 0 || value.outMs <= value.inMs) {
    throw new Error(`${label} must have a positive millisecond range`);
  }
  return value;
}

function removedBefore(operations, startMs, pointMs) {
  return operations.reduce((total, operation) => {
    if (!/^(compress-gap|trim-leading-silence|trim-trailing-silence)$/u.test(operation?.kind)) return total;
    const inMs = operation.removeStartMs ?? operation.startMs;
    const outMs = operation.removeEndMs ?? operation.endMs;
    if (!Number.isSafeInteger(inMs) || !Number.isSafeInteger(outMs) || outMs <= inMs) throw new Error("Story silence operation is invalid");
    return total + Math.max(0, Math.min(pointMs, outMs) - Math.max(startMs, inMs));
  }, 0);
}

function retimedSourceTime(story, operations, pointMs) {
  return story.timelineInMs + pointMs - story.sourceInMs - removedBefore(operations, story.sourceInMs, pointMs);
}

function silenceOperationHashes(story, operations, source) {
  const wordIds = new Set(story.wordIds ?? []);
  const hashes = operations.flatMap((operation) => {
    const range = operation.kind === "compress-gap"
      ? {startMs: operation.removeStartMs, endMs: operation.removeEndMs}
      : ["trim-leading-silence", "trim-trailing-silence"].includes(operation?.kind) ? {startMs: operation.startMs, endMs: operation.endMs} : null;
    const applies = range
      ? Number.isSafeInteger(range.startMs) && Number.isSafeInteger(range.endMs) && range.startMs < source.outMs && source.inMs < range.endMs
      : operation.kind === "preserve-dramatic-pause" && wordIds.has(operation.afterWordId) && wordIds.has(operation.beforeWordId);
    if (!range && operation.kind !== "preserve-dramatic-pause") throw new Error("Story silence plan contains an unknown operation");
    return applies ? [sha256Value(operation)] : [];
  });
  if (new Set(hashes).size !== hashes.length) throw new Error(`Story segment ${story.id} has duplicate silence operations`);
  return hashes;
}

function canonicalSubject(shot, subjectMap, operations) {
  const map = subjectMap.payload;
  exactKeys(map.frameSize, ["width", "height"], `Shot ${shot.id} SubjectMap frame size`);
  if (map.coordinateSpace !== "top-left-pixels" || !Number.isSafeInteger(map.frameSize.width) || !Number.isSafeInteger(map.frameSize.height)
    || map.frameSize.width < 1 || map.frameSize.height < 1 || map.sourceSnapshot?.sha256 !== shot.source.sourceSha256
    || !Number.isSafeInteger(map.sourceSnapshot?.bytes) || map.sourceSnapshot.bytes < 1
    || !Number.isSafeInteger(map.timeRangeMs?.startMs) || !Number.isSafeInteger(map.timeRangeMs?.endMs)
    || map.timeRangeMs.startMs > shot.source.inMs || map.timeRangeMs.endMs < shot.source.outMs
    || !Array.isArray(map.frames) || !map.frames.length || map.expectedFrameCount !== map.frames.length
    || map.frames.some((frame, index) => frame?.index !== index || !Number.isSafeInteger(frame.timeMs)
      || (index && frame.timeMs <= map.frames[index - 1].timeMs))) {
    throw new Error(`Shot ${shot.id} requires a valid source-relative SubjectMap`);
  }
  const relevant = map.frames.filter((frame) => Number.isSafeInteger(frame?.timeMs) && frame.timeMs >= shot.source.inMs && frame.timeMs < shot.source.outMs
    && !operations.some((operation) => /^(compress-gap|trim-leading-silence|trim-trailing-silence)$/u.test(operation?.kind)
      && frame.timeMs >= (operation.removeStartMs ?? operation.startMs)
      && frame.timeMs < (operation.removeEndMs ?? operation.endMs)));
  if (!relevant.length) throw new Error(`Shot ${shot.id} has no relevant SubjectMap frames`);
  const frames = relevant.map((frame) => {
    if (!Number.isSafeInteger(frame.index) || !Array.isArray(frame.faces) || frame.subjectBox === undefined
      || !Number.isFinite(frame.confidence) || !Number.isFinite(frame.jitterPx) || typeof frame.discontinuity !== "boolean") {
      throw new Error(`Shot ${shot.id} has invalid SubjectMap tracking facts`);
    }
    const avoidRegions = [
      ...frame.faces.map((face) => ({kind: "face", box: face.box, confidence: face.confidence})),
      ...(frame.subjectBox === null ? [] : [{kind: "subject", box: frame.subjectBox, confidence: frame.subjectConfidence}]),
    ];
    for (const region of avoidRegions) {
      exactKeys(region, ["kind", "box", "confidence"], `Shot ${shot.id} SubjectMap avoid region`);
      exactKeys(region.box, ["x", "y", "width", "height"], `Shot ${shot.id} SubjectMap avoid box`);
      if (!Number.isFinite(region.confidence) || region.confidence < 0 || region.confidence > 1
        || Object.values(region.box).some((value) => !Number.isSafeInteger(value)) || region.box.x < 0 || region.box.y < 0
        || region.box.width < 1 || region.box.height < 1 || region.box.x + region.box.width > map.frameSize.width
        || region.box.y + region.box.height > map.frameSize.height) {
        throw new Error(`Shot ${shot.id} has invalid SubjectMap avoid geometry`);
      }
    }
    if (canonicalJson(frame.avoidRegions) !== canonicalJson(avoidRegions)) throw new Error(`Shot ${shot.id} SubjectMap avoid regions are not canonical`);
    return {index: frame.index, timeMs: frame.timeMs, avoidRegions};
  });
  const safeZoneData = {coordinateSpace: map.coordinateSpace, frameSize: map.frameSize,
    sourceRangeMs: {inMs: shot.source.inMs, outMs: shot.source.outMs}, frames};
  const tracking = {required: shot.subject.tracking?.required, status: map.tracking?.status,
    faceAnalysisAvailable: map.tracking?.faceAnalysisAvailable, personAnalysisAvailable: map.tracking?.personAnalysisAvailable,
    confidence: map.tracking?.confidence, faceConfidence: map.tracking?.faceConfidence, subjectConfidence: map.tracking?.subjectConfidence,
    maxJitterPx: map.tracking?.maxJitterPx, discontinuities: map.tracking?.discontinuities,
    frames: relevant.map(({index, timeMs, confidence, jitterPx, discontinuity}) => ({index, timeMs, confidence, jitterPx, discontinuity}))};
  if (typeof tracking.required !== "boolean" || tracking.status !== "tracked" || !Number.isFinite(tracking.confidence)
    || !Number.isFinite(tracking.maxJitterPx) || !Array.isArray(tracking.discontinuities)
    || tracking.frames.some((frame) => !Number.isFinite(frame.confidence) || !Number.isFinite(frame.jitterPx) || typeof frame.discontinuity !== "boolean")
    || (tracking.required && (tracking.personAnalysisAvailable !== true || tracking.confidence < 0.8 || tracking.maxJitterPx > 6
      || tracking.discontinuities.length || tracking.frames.some((frame) => frame.confidence < 0.8 || frame.jitterPx > 6 || frame.discontinuity)))) {
    throw new Error(`Shot ${shot.id} does not meet its exact SubjectMap tracking requirement`);
  }
  return {safeZones: {...safeZoneData, sha256: sha256Value(safeZoneData)}, tracking, relevant};
}

function validateDepth(shot, parents, subjectMap, relevantFrames) {
  exactKeys(shot.depth, ["mode", "foregroundArtifactId", "mattePath", "matteSha256", "subjectMatteSha256", "fallback"], `Shot ${shot.id} depth`);
  if (shot.depth.mode === "flat") {
    if (shot.depth.foregroundArtifactId !== null || shot.depth.mattePath !== null || shot.depth.matteSha256 !== null
      || shot.depth.subjectMatteSha256 !== null || shot.depth.fallback !== "none") throw new Error(`Shot ${shot.id} flat depth cannot claim foreground evidence`);
    return;
  }
  if (shot.depth.mode !== "text-behind-subject" || shot.depth.fallback !== "premiere-native" || shot.subject.tracking.required !== true) {
    throw new Error(`Shot ${shot.id} requires an allowed depth mode and fallback`);
  }
  const foreground = parents.foregroundBySource.get(shot.source.sourceId);
  const map = subjectMap.payload;
  const allMattes = map.frames.map((frame) => frame.matte);
  if (!foreground || map.mattes?.required !== true || map.mattes.complete !== true || map.mattes.coverage !== 1
    || relevantFrames.some((frame) => !frame.matte) || allMattes.some((matte) => !matte || !SHA256.test(matte.sha256 ?? "")
      || !Number.isSafeInteger(matte.bytes) || matte.bytes < 1)) throw new Error(`Shot ${shot.id} requires valid SubjectMap matte and foreground evidence`);
  const aggregate = createHash("sha256").update(allMattes.map(({sha256}) => sha256).join("")).digest("hex");
  const expectedPath = `Renders/Foreground/${parents.workItemId}/${shot.source.sourceId}/v${pad(parents.revision)}/foreground.mov`;
  const payload = foreground.artifact.payload;
  const subjectSha256 = parents.subjectRefs.find(({artifactId}) => artifactId === subjectMap.artifactId)?.sha256;
  if (payload.source?.id !== shot.source.sourceId || payload.source.sha256 !== shot.source.sourceSha256
    || payload.mattes?.count !== allMattes.length || payload.mattes.sha256 !== aggregate || payload.output?.path !== expectedPath
    || !SHA256.test(payload.output.sha256 ?? "") || !Number.isSafeInteger(payload.output.bytes) || payload.output.bytes < 1
    || !foreground.artifact.parents.some((parent) => parent.artifactId === subjectMap.artifactId && parent.sha256 === subjectSha256)) {
    throw new Error(`Shot ${shot.id} foreground does not match its SubjectMap and source output`);
  }
  const expected = {mode: "text-behind-subject", foregroundArtifactId: foreground.artifact.artifactId,
    mattePath: payload.output.path, matteSha256: payload.output.sha256, subjectMatteSha256: aggregate, fallback: "premiere-native"};
  if (canonicalJson(shot.depth) !== canonicalJson(expected)) throw new Error(`Shot ${shot.id} depth is not exact foreground evidence`);
}

function validateCinematicLayers(copy, shot, cues) {
  exactKeys(copy, ["hierarchy", "mode", "layers", "hardCutOffsetFrames"], `Shot ${shot.id} cinematic copy`);
  const modes = new Set(["a-roll", "full-frame-explainer", "upper-montage", "depth", "foreground-emphasis"]);
  if (!modes.has(copy.mode) || !Number.isInteger(copy.hardCutOffsetFrames) || copy.hardCutOffsetFrames < 0 || copy.hardCutOffsetFrames > 2
    || !Array.isArray(copy.layers) || copy.layers.length !== 4) throw new Error(`Shot ${shot.id} requires an exact cinematic mode and four timed owned layers`);
  const duration = shot.timeline.outMs - shot.timeline.inMs;
  if (copy.mode === "full-frame-explainer" && (duration < 2_500 || duration > 4_800)) throw new Error(`Shot ${shot.id} full-frame explainer duration is outside its approved range`);
  if ((copy.mode === "depth") !== (shot.depth.mode === "text-behind-subject")) throw new Error(`Shot ${shot.id} depth mode and foreground contract disagree`);
  const roles = new Set();
  const ids = new Set();
  for (const layer of copy.layers) {
    exactKeys(layer, ["id", "role", "owner", "inMs", "outMs", "entryFrames", "staggerFrames", "settleFrames", "holdFrames", "exitFrames", "easing", "fromScale", "toScale", "overshoot"], `Shot ${shot.id} cinematic layer`);
    exactKeys(layer.owner, ["role", "editor"], `Shot ${shot.id} cinematic layer owner`);
    const premiere = layer.owner.role === "premiere-executor" && layer.owner.editor === "premiere";
    const hyperframes = layer.owner.role === "hyperframes-executor" && layer.owner.editor === "hyperframes";
    if (typeof layer.id !== "string" || !layer.id.trim() || ids.has(layer.id) || !["back", "subject", "foreground", "caption"].includes(layer.role) || roles.has(layer.role)
      || !premiere && !hyperframes
      || !Number.isSafeInteger(layer.inMs) || !Number.isSafeInteger(layer.outMs) || layer.inMs < shot.timeline.inMs || layer.outMs > shot.timeline.outMs || layer.outMs <= layer.inMs
      || !Number.isInteger(layer.entryFrames) || layer.entryFrames < 9 || layer.entryFrames > 15
      || !Number.isInteger(layer.staggerFrames) || layer.staggerFrames < 3 || layer.staggerFrames > 6 || !Number.isInteger(layer.settleFrames) || layer.settleFrames < 12 || layer.settleFrames > 18
      || (copy.mode === "upper-montage" ? !Number.isInteger(layer.holdFrames) || layer.holdFrames < 11 || layer.holdFrames > 20 : layer.holdFrames !== null)
      || !Number.isInteger(layer.exitFrames) || layer.exitFrames < 6 || layer.exitFrames > 10
      || !["power3.out", "power4.out", "expo.out"].includes(layer.easing) || layer.fromScale !== 0.88 || layer.toScale !== 1
      || typeof layer.overshoot !== "number" || layer.overshoot < 0 || layer.overshoot > 0.04) {
      throw new Error(`Shot ${shot.id} cinematic layer requires exact timing and easing`);
    }
    if ((layer.outMs - layer.inMs) * FPS < (layer.entryFrames + layer.staggerFrames + layer.settleFrames + (layer.holdFrames ?? 0) + layer.exitFrames) * 1000) {
      throw new Error(`Shot ${shot.id} cinematic layer is shorter than its frame-token budget`);
    }
    if ((layer.role === "subject" && !premiere) || (layer.role === "caption" && !hyperframes)
      || (copy.mode !== "a-roll" && ["back", "foreground"].includes(layer.role) && !hyperframes)) {
      throw new Error(`Shot ${shot.id} has invalid cinematic layer routing`);
    }
    ids.add(layer.id);
    roles.add(layer.role);
  }
  const byRole = new Map(copy.layers.map((layer) => [layer.role, layer]));
  const cueIn = Math.min(...cues.map(({startMs}) => startMs));
  const cueOut = Math.max(...cues.map(({endMs}) => endMs));
  if (byRole.get("subject").inMs !== shot.timeline.inMs || byRole.get("subject").outMs !== shot.timeline.outMs
    || byRole.get("caption").inMs > cueIn || byRole.get("caption").outMs < cueOut
    || (["full-frame-explainer", "depth"].includes(copy.mode)
      && (byRole.get("back").inMs !== shot.timeline.inMs || byRole.get("back").outMs !== shot.timeline.outMs))
    || (copy.mode === "depth" && (byRole.get("foreground").inMs !== shot.timeline.inMs || byRole.get("foreground").outMs !== shot.timeline.outMs))
    || (copy.mode === "foreground-emphasis" && !(byRole.get("foreground").inMs <= shot.timeline.inMs + duration / 2
      && byRole.get("foreground").outMs > shot.timeline.inMs + duration / 2))) {
    throw new Error(`Shot ${shot.id} layers do not cover the required source, cue, and mode intervals`);
  }
}

export function validateVideoShot(shot, parents) {
  exactKeys(shot, SHOT_KEYS, `Shot ${shot?.id ?? "unknown"}`);
  if (!SAFE_ID.test(shot.id ?? "")) throw new Error("Shot id must be safe");
  if (!STYLE_PRESETS.has(shot.stylePresetId) || shot.stylePresetId !== parents.stylePresetId) throw new Error(`Shot ${shot.id} does not match the plan style preset`);
  exactKeys(shot.timeline, ["inMs", "outMs"], `Shot ${shot.id} timeline`);
  requireRange(shot.timeline, `Shot ${shot.id} timeline`);
  exactKeys(shot.source, ["storySegmentId", "sourceId", "sourceSha256", "inMs", "outMs", "silenceOperationHashes"], `Shot ${shot.id} source`);
  if (!shot.source || typeof shot.source !== "object" || !SAFE_ID.test(shot.source.storySegmentId ?? "")) throw new Error(`Shot ${shot.id} requires its story segment`);
  const story = parents.storySegments.get(shot.source.storySegmentId);
  if (!story) throw new Error(`Shot ${shot.id} has no story-plan range`);
  requireRange(shot.source, `Shot ${shot.id} source`);
  if (shot.source.sourceId !== story.sourceId || shot.source.sourceSha256 !== story.sourceSha256
    || shot.source.inMs < story.sourceInMs || shot.source.outMs > story.sourceOutMs || !Array.isArray(shot.source.silenceOperationHashes)) {
    throw new Error(`Shot ${shot.id} source range and silence operations must match its story segment`);
  }
  const operations = parents.silenceBySource.get(shot.source.sourceId) ?? [];
  const expectedSilenceHashes = silenceOperationHashes(story, operations, shot.source);
  if (new Set(shot.source.silenceOperationHashes).size !== shot.source.silenceOperationHashes.length
    || canonicalJson(shot.source.silenceOperationHashes) !== canonicalJson(expectedSilenceHashes)) {
    throw new Error(`Shot ${shot.id} silence operation hashes are not exact and ordered`);
  }
  if (shot.timeline.inMs !== retimedSourceTime(story, operations, shot.source.inMs)
    || shot.timeline.outMs !== retimedSourceTime(story, operations, shot.source.outMs)) {
    throw new Error(`Shot ${shot.id} timeline does not equal its retimed story source range`);
  }
  exactKeys(shot.captions, ["enabled", "identity", "cueIds", "fontRoles", "placement"], `Shot ${shot.id} captions`);
  if (typeof shot.captions.enabled !== "boolean"
    || !CAPTION_IDENTITIES.has(shot.captions.identity) || !Array.isArray(shot.captions.cueIds) || !shot.captions.cueIds.length
    || !Array.isArray(shot.captions.fontRoles) || !shot.captions.fontRoles.length || !shot.captions.fontRoles.every((role) => ["body", "display"].includes(role))
    || !shot.captions.placement || typeof shot.captions.placement !== "object") {
    throw new Error(`Shot ${shot.id} requires valid caption cue, identity, font roles, and placement`);
  }
  const captionPlacement = parents.captions.payload?.placements?.find(({shotId}) => shotId === shot.id)?.placement;
  const requestedCues = parents.captions.payload?.cues?.filter((cue) => shot.captions.cueIds.includes(cue.cueId));
  if (!captionPlacement || JSON.stringify(captionPlacement) !== JSON.stringify(shot.captions.placement)
    || !Array.isArray(requestedCues) || requestedCues.length !== shot.captions.cueIds.length
    || requestedCues.some((cue) => cue.shotId !== shot.id || cue.storySegmentId !== shot.source.storySegmentId
      || cue.identity !== shot.captions.identity || JSON.stringify(cue.fontRoles) !== JSON.stringify(shot.captions.fontRoles)
      || JSON.stringify(cue.placement) !== JSON.stringify(shot.captions.placement) || !Array.isArray(cue.sourceIds)
      || cue.sourceIds.length !== 1 || cue.sourceIds[0] !== shot.source.sourceId || !Array.isArray(cue.wordIds)
      || cue.wordIds.some((wordId) => !story.wordIds?.includes(wordId)) || !Number.isSafeInteger(cue.startMs) || !Number.isSafeInteger(cue.endMs)
      || cue.startMs < shot.timeline.inMs || cue.endMs > shot.timeline.outMs || cue.endMs <= cue.startMs)) {
    throw new Error(`Shot ${shot.id} caption placement is not bound to the caption plan`);
  }
  exactKeys(shot.subject, ["subjectMapArtifactId", "safeZones", "tracking"], `Shot ${shot.id} subject`);
  const subjectMap = parents.subjects.get(shot.subject.subjectMapArtifactId);
  if (!subjectMap || subjectMap.payload.sourceId !== shot.source.sourceId || subjectMap.payload.sourceSha256 !== shot.source.sourceSha256) {
    throw new Error(`Shot ${shot.id} requires subject safe zones and a current subject map`);
  }
  exactKeys(shot.subject.safeZones, ["coordinateSpace", "frameSize", "sourceRangeMs", "frames", "sha256"], `Shot ${shot.id} safe zones`);
  exactKeys(shot.subject.tracking, ["required", "status", "faceAnalysisAvailable", "personAnalysisAvailable", "confidence", "faceConfidence", "subjectConfidence", "maxJitterPx", "discontinuities", "frames"], `Shot ${shot.id} tracking`);
  const canonical = canonicalSubject(shot, subjectMap, operations);
  if (canonicalJson(shot.subject.safeZones) !== canonicalJson(canonical.safeZones)
    || canonicalJson(shot.subject.tracking) !== canonicalJson(canonical.tracking)) throw new Error(`Shot ${shot.id} subject evidence is not canonical`);
  validateDepth(shot, parents, subjectMap, canonical.relevant);
  exactKeys(shot.onScreenCopy, ["hierarchy", "mode", "layers", "hardCutOffsetFrames"], `Shot ${shot.id} on-screen copy`);
  const hierarchyIds = new Set();
  const hierarchyCueIds = new Set();
  const hierarchyFontRoles = new Set();
  const cueById = new Map(requestedCues.map((cue) => [cue.cueId, cue]));
  if (!Array.isArray(shot.onScreenCopy.hierarchy) || !shot.onScreenCopy.hierarchy.length || shot.onScreenCopy.hierarchy.some((entry) => {
    exactKeys(entry, ["id", "role", "cueRefs", "fontRoles"], `Shot ${shot.id} hierarchy entry`);
    if (!SAFE_ID.test(entry.id ?? "") || hierarchyIds.has(entry.id) || !["headline", "supporting", "caption"].includes(entry.role)
      || !Array.isArray(entry.cueRefs) || !entry.cueRefs.length || new Set(entry.cueRefs.map((cueRef) => cueRef?.cueId)).size !== entry.cueRefs.length
      || entry.cueRefs.some((cueRef) => {
        exactKeys(cueRef, ["cueId", "sourceId"], `Shot ${shot.id} hierarchy cue ref`);
        const cue = cueById.get(cueRef.cueId);
        return hierarchyCueIds.has(cueRef.cueId) || !cue || cue.sourceIds.length !== 1 || cue.sourceIds[0] !== cueRef.sourceId;
      }) || !Array.isArray(entry.fontRoles) || !entry.fontRoles.length
      || new Set(entry.fontRoles).size !== entry.fontRoles.length || entry.fontRoles.some((role) => !shot.captions.fontRoles.includes(role))) return true;
    hierarchyIds.add(entry.id);
    entry.cueRefs.forEach(({cueId}) => hierarchyCueIds.add(cueId));
    entry.fontRoles.forEach((role) => hierarchyFontRoles.add(role));
    return false;
  }) || hierarchyCueIds.size !== shot.captions.cueIds.length || shot.captions.cueIds.some((cueId) => !hierarchyCueIds.has(cueId))
    || hierarchyFontRoles.size !== shot.captions.fontRoles.length || shot.captions.fontRoles.some((role) => !hierarchyFontRoles.has(role))
    || (shot.stylePresetId === "sunburst-standard-v1" && shot.onScreenCopy.mode !== "a-roll")
    || !isPremiereOnly(shot.onScreenCopy)) {
    throw new Error(`Shot ${shot.id} requires exact hierarchy cue ownership without an AE fallback`);
  }
  validateCinematicLayers(shot.onScreenCopy, shot, requestedCues);
  if (!Array.isArray(shot.assets) || !shot.assets.length || !shot.assets.every((asset) => exactKeys(asset, ["assetId", "kind", "sha256", "usageId"], `Shot ${shot.id} asset`)
    && parents.assets.has(asset.assetId) && ["image", "transition", "green-screen"].includes(asset.kind)
    && parents.assets.get(asset.assetId).kind === asset.kind && parents.assets.get(asset.assetId).sha256 === asset.sha256
    && asset.usageId === shot.id && parents.assets.get(asset.assetId).usageIds.includes(shot.id))) {
    throw new Error(`Shot ${shot.id} references an unfrozen asset`);
  }
  exactKeys(shot.audio, ["sfx", "bgm"], `Shot ${shot.id} audio`);
  const audio = [...(Array.isArray(shot.audio.sfx) ? shot.audio.sfx : []), ...(shot.audio.bgm === null ? [] : [shot.audio.bgm])];
  if (!Array.isArray(shot.audio.sfx) || audio.some((asset) => {
    exactKeys(asset, ["assetId", "kind", "sha256", "usageId"], `Shot ${shot.id} audio asset`);
    const expectedKind = shot.audio.sfx.includes(asset) ? "sfx" : "music";
    const frozen = parents.assets.get(asset.assetId);
    return asset.kind !== expectedKind || frozen?.kind !== expectedKind || frozen.sha256 !== asset.sha256
      || asset.usageId !== shot.id || !frozen.usageIds.includes(shot.id);
  })) throw new Error(`Shot ${shot.id} has invalid audio kind, hash, or usage ownership`);
  exactKeys(shot.transitions, ["in", "out"], `Shot ${shot.id} transitions`);
  exactKeys(shot.grading, ["tokens"], `Shot ${shot.id} grading`);
  exactKeys(shot.grading.tokens, ["brandId", "brandVersion", "frameSha256", "fontHashes"], `Shot ${shot.id} grading tokens`);
  if (!["cut", "dissolve", "dip-black"].includes(shot.transitions.in) || !["cut", "dissolve", "dip-black"].includes(shot.transitions.out)
    || canonicalJson(shot.grading.tokens) !== canonicalJson({brandId: parents.brand.id, brandVersion: parents.brand.version,
      frameSha256: parents.brand.frameSha256, fontHashes: parents.brand.fontHashes})
    || !isPremiereOnly({transitions: shot.transitions, grading: shot.grading})) {
    throw new Error(`Shot ${shot.id} requires transitions, grading tokens, and Premiere-only execution`);
  }
  exactKeys(shot.editorOwner, ["role", "editor"], `Shot ${shot.id} editor owner`);
  if (shot.editorOwner.role !== "premiere-executor" || shot.editorOwner.editor !== "premiere") throw new Error(`Shot ${shot.id} requires a Premiere executor`);
  const duration = shot.timeline.outMs - shot.timeline.inMs;
  const acceptanceIds = new Set();
  const acceptancePairs = new Set();
  const kindPhase = new Map([["transition", "before"], ["hero-frame", "mid"], ["caption-safe", "after"], ["matte-edge", "mid"], ["layer-occlusion", "mid"]]);
  if (!Array.isArray(shot.acceptance) || !shot.acceptance.length || !shot.acceptance.every((item) => {
    exactKeys(item, ["id", "phase", "kind", "frame", "timeMs", "assertion"], `Shot ${shot.id} acceptance`);
    const pair = `${item.phase}:${item.kind}`;
    const offset = item.timeMs - shot.timeline.inMs;
    const validThird = (item.phase === "before" && offset >= 0 && offset < duration / 3)
      || (item.phase === "mid" && offset >= duration / 3 && offset < 2 * duration / 3)
      || (item.phase === "after" && offset >= 2 * duration / 3 && offset < duration);
    const valid = SAFE_ID.test(item.id ?? "") && !acceptanceIds.has(item.id) && !acceptancePairs.has(pair)
      && kindPhase.get(item.kind) === item.phase && Number.isSafeInteger(item.frame) && item.frame === Math.floor(item.timeMs * parents.fps / 1000)
      && Number.isSafeInteger(item.timeMs) && validThird && typeof item.assertion === "string" && item.assertion.trim();
    acceptanceIds.add(item.id);
    acceptancePairs.add(pair);
    return valid;
  })) {
    throw new Error(`Shot ${shot.id} needs measurable acceptance checks`);
  }
  const requiredKinds = ["transition", "hero-frame", "caption-safe", ...(shot.depth.mode === "text-behind-subject" ? ["matte-edge", "layer-occlusion"] : [])];
  if (new Set(shot.acceptance.map(({phase}) => phase)).size !== 3
    || requiredKinds.some((kind) => !shot.acceptance.some((item) => item.kind === kind))
    || shot.acceptance.some(({kind}) => !requiredKinds.includes(kind)) || shot.transitions.in !== "cut" || shot.transitions.out !== "cut") {
    throw new Error(`Shot ${shot.id} requires hard cuts and exact before/mid/after evidence`);
  }
  return structuredClone(shot);
}

function validateCoverage(shots, storySegments) {
  const ordered = [...shots].toSorted((left, right) => left.timeline.inMs - right.timeline.inMs);
  if (ordered[0]?.timeline.inMs !== 0) throw new Error("Shot timelines must start at zero with complete coverage");
  for (const [index, shot] of ordered.entries()) {
    if (index && shot.timeline.inMs !== ordered[index - 1].timeline.outMs) throw new Error("Shot timelines must have no gaps or overlaps");
  }
  if (new Set(ordered.map(({id}) => id)).size !== ordered.length) throw new Error("Shot IDs must be unique");
  const bySegment = Map.groupBy(ordered, (shot) => shot.source.storySegmentId);
  if (bySegment.size !== storySegments.size) throw new Error("Every story segment requires shot coverage");
  for (const [segmentId, segment] of storySegments) {
    const parts = bySegment.get(segmentId)?.toSorted((left, right) => left.source.inMs - right.source.inMs);
    if (!parts?.length || parts[0].source.inMs !== segment.sourceInMs || parts.at(-1).source.outMs !== segment.sourceOutMs) {
      throw new Error(`Story segment ${segmentId} is omitted or not fully covered`);
    }
    for (const [index, part] of parts.entries()) {
      if (index && part.source.inMs !== parts[index - 1].source.outMs) throw new Error(`Story segment ${segmentId} has repeated, gapped, or overlapping source coverage`);
    }
  }
  return ordered;
}

async function readBrand(root, expected, brand) {
  const [manifest, frozen] = await Promise.all([readManifest(root), readFrozenBrand(root)]);
  if (manifest.brand?.lockPath !== frozen.lockPath || manifest.brand?.lockSha256 !== frozen.lockSha256
    || expected.artifactId !== frozen.artifactId || expected.sha256 !== frozen.lockSha256) {
    throw new Error("Brand ref must equal the manifest frozen brand lock");
  }
  const contents = await readFileNoFollow(root, frozen.lockPath);
  const hash = createHash("sha256").update(contents.bytes).digest("hex");
  if (hash !== frozen.lockSha256) throw new Error("Frozen brand lock does not match its current hash");
  let stored;
  try { stored = JSON.parse(contents.bytes.toString("utf8")); } catch { throw new Error("Frozen brand lock is not JSON"); }
  if (stored.artifactId !== expected.artifactId || stored.id !== brand?.id || stored.version !== brand?.version || stored.frameSha256 !== brand?.frameSha256
    || !Array.isArray(brand?.fontHashes) || !Array.isArray(stored.fonts) || stored.fonts.map(({sha256}) => sha256).sort().join(",") !== [...brand.fontHashes].sort().join(",")) {
    throw new Error("Frozen Sunburst/client brand tokens or font hashes do not match the brand lock");
  }
  return {artifactId: expected.artifactId, sha256: expected.sha256};
}

async function loadParents(root, input) {
  const expected = {workItemId: input.workItemId, revision: input.revision, modality: input.modality};
  const storyRef = ref(input.storyPlanRef, "Story-plan ref");
  const story = assertCurrentArtifact(await readExactArtifact(root, artifactPath("story", input.workItemId, input.revision), storyRef, "Story plan"), expected, "story-plan", "story-editor");
  if (story.artifactId !== `story-plan:${input.workItemId}:v${pad(input.revision)}` || !Array.isArray(story.payload.segments) || !story.payload.segments.length) throw new Error("Current story plan is required");
  const transcriptRefs = uniqueRefs(input.transcriptArtifactRefs ?? [input.scriptOrTranscriptRef], "Transcript");
  const transcripts = new Map();
  for (const transcriptRef of transcriptRefs) {
    const sourceId = sourceIdFromArtifact(transcriptRef, "source-transcript", input.workItemId, input.revision);
    const artifact = assertCurrentArtifact(await readExactArtifact(root, artifactPath("transcript", input.workItemId, input.revision, sourceId), transcriptRef, `Transcript ${sourceId}`), expected, "source-transcript", "local-media-technician");
    if (artifact.payload.sourceId !== sourceId || !SHA256.test(artifact.payload.sourceSha256 ?? "")) throw new Error(`Transcript ${sourceId} is malformed`);
    transcripts.set(sourceId, artifact);
  }
  const subjectRefs = uniqueRefs(input.subjectMapRefs, "SubjectMap");
  const subjects = new Map();
  for (const subjectRef of subjectRefs) {
    const sourceId = sourceIdFromArtifact(subjectRef, "subject-map", input.workItemId, input.revision);
    const artifact = assertCurrentArtifact(await readExactArtifact(root, artifactPath("subject", input.workItemId, input.revision, sourceId), subjectRef, `SubjectMap ${sourceId}`), expected, "subject-map", "subject-analyst");
    if (artifact.payload.sourceId !== sourceId) throw new Error(`SubjectMap ${sourceId} is cross-source`);
    subjects.set(subjectRef.artifactId, artifact);
  }
  const assetRef = ref(input.assetPlanRef, "Asset-plan ref");
  const assetPlan = assertCurrentArtifact(await readExactArtifact(root, artifactPath("asset", input.workItemId, input.revision), assetRef, "Asset plan"), expected, "asset-plan", "asset-resolver");
  const assets = new Map();
  for (const asset of assetPlan.payload.selections ?? []) {
    if (!asset?.id || !["image", "transition", "green-screen", "sfx", "music"].includes(asset.kind)
      || !SHA256.test(asset.sha256 ?? "") || !asset.licence || !asset.usageScope || asset.unresolved
      || !Array.isArray(asset.usageIds) || assets.has(asset.id)) throw new Error("Asset plan contains unresolved, wrong-kind, or rights-incomplete assets");
    assets.set(asset.id, asset);
  }
  const captionRef = ref(input.captionPlanRef, "Caption-plan ref");
  const captions = assertCurrentArtifact(await readExactArtifact(root, artifactPath("caption", input.workItemId, input.revision), captionRef, "Caption plan"), expected, "caption-plan", "caption-executor");
  if (!Array.isArray(input.foregroundSidecarRefs ?? [])) throw new Error("Foreground sidecar refs must be an array");
  const foregroundRefs = (input.foregroundSidecarRefs ?? []).map((value) => ref(value, "Foreground sidecar artifact ref"));
  if (new Set(foregroundRefs.map(({artifactId}) => artifactId)).size !== foregroundRefs.length) throw new Error("Foreground sidecar refs must be unique");
  const foregroundBySource = new Map();
  for (const foregroundRef of foregroundRefs) {
    const sourceId = sourceIdFromArtifact(foregroundRef, "foreground-sidecar", input.workItemId, input.revision);
    const artifact = assertCurrentArtifact(await readExactArtifact(root, artifactPath("foreground", input.workItemId, input.revision, sourceId), foregroundRef, `Foreground sidecar ${sourceId}`), expected, "foreground-sidecar", "foreground-sidecar-executor");
    if (artifact.payload?.source?.id !== sourceId) throw new Error(`Foreground sidecar ${sourceId} is cross-source`);
    foregroundBySource.set(sourceId, {artifact, artifactRef: foregroundRef});
  }
  const brandRef = await readBrand(root, ref(input.brandRef, "Brand ref"), input.brand);
  const storySegments = new Map(story.payload.segments.map((segment) => [segment.id, segment]));
  if (storySegments.size !== story.payload.segments.length || [...storySegments.values()].some((segment) => !transcripts.has(segment.sourceId)
    || transcripts.get(segment.sourceId).payload.sourceSha256 !== segment.sourceSha256)) throw new Error("Story plan and transcripts do not have complete current source coverage");
  const silenceEntries = story.payload.silencePlan;
  if (!Array.isArray(silenceEntries) || new Set(silenceEntries.map(({sourceId}) => sourceId)).size !== silenceEntries.length
    || silenceEntries.some(({sourceId, silencePlan}) => !transcripts.has(sourceId) || !Array.isArray(silencePlan?.operations))) {
    throw new Error("Story silence plan must contain unique source-bound operation arrays");
  }
  const silenceBySource = new Map(silenceEntries.map(({sourceId, silencePlan}) => [sourceId, silencePlan.operations]));
  return {workItemId: input.workItemId, revision: input.revision, storyRef, transcriptRefs, subjectRefs, assetRef, captionRef,
    foregroundRefs, brandRef, brand: structuredClone(input.brand), storySegments, silenceBySource, subjects, assets, foregroundBySource, captions};
}

function envelopeParents(parents) {
  const refs = [parents.storyRef, ...parents.transcriptRefs, parents.assetRef, ...parents.subjectRefs, parents.brandRef, parents.captionRef, ...parents.foregroundRefs];
  const unique = new Map();
  for (const entry of refs) unique.set(entry.artifactId, entry);
  return [...unique.values()];
}

async function assertWorkflowCurrent(root, workItemId, revision, modality, state) {
  const item = getWorkItem(await readWorkflowState(root), workItemId);
  if (item.revision !== revision || item.modality !== modality || item.state !== state) throw new Error(`Video design-plan workflow changed from ${state}`);
  return item;
}

export async function createVideoDesignPlan(projectDir, input, adapters = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Video design-plan input is required");
  if (!SAFE_ID.test(input.workItemId ?? "") || !Number.isInteger(input.revision) || input.revision < 1 || input.revision > 999) throw new Error("Video design-plan work item and revision are required");
  if (!["raw-video", "multi-clip"].includes(input.modality) || input.producer?.role !== "design-director" || !text(input.producer?.actorId, "Design producer actor id") || !input.versions) throw new Error("Video design-plan requires a design-director producer, video modality, and versions");
  const root = await realpath(projectDir);
  const [manifest, item] = await Promise.all([readManifest(root), assertWorkflowCurrent(root, input.workItemId, input.revision, input.modality, "STORY_PLANNED")]);
  if (!manifest.editors.some(({id}) => id === "premiere")) throw new Error("Video design-plan requires the Premiere editor capability");
  const parents = await loadParents(root, input);
  if (manifest.format?.fps !== FPS) throw new Error("Video design-plan requires the frozen 30fps frame rate");
  if (!STYLE_PRESETS.has(input.stylePresetId)) throw new Error("Video design-plan requires a frozen style preset");
  parents.fps = FPS;
  parents.stylePresetId = input.stylePresetId;
  const scriptOrTranscriptRef = ref(input.scriptOrTranscriptRef, "Script or transcript ref");
  if (!parents.transcriptRefs.some((candidate) => candidate.artifactId === scriptOrTranscriptRef.artifactId && candidate.sha256 === scriptOrTranscriptRef.sha256)) {
    throw new Error("Script or transcript ref must be one current transcript parent");
  }
  const shots = validateCoverage((input.shots ?? []).map((shot) => validateVideoShot(shot, parents)), parents.storySegments);
  const foregroundSources = new Set(shots.filter(({depth}) => depth.mode === "text-behind-subject").map(({source}) => source.sourceId));
  if (parents.foregroundBySource.size !== foregroundSources.size || [...parents.foregroundBySource.keys()].some((sourceId) => !foregroundSources.has(sourceId))) {
    throw new Error("Foreground sidecar refs must exactly match depth shot sources");
  }
  const designPlan = {
    schemaVersion: 1, workItemId: input.workItemId, revision: input.revision, format: text(input.format, "Design format"), stylePresetId: input.stylePresetId,
    parents: {scriptOrTranscript: scriptOrTranscriptRef, transcripts: parents.transcriptRefs, storyPlan: parents.storyRef, assetPlan: parents.assetRef,
      subjectMaps: parents.subjectRefs, brand: parents.brandRef, captionPlan: parents.captionRef, foregroundSidecars: parents.foregroundRefs},
    silencePlanRef: ref(input.silencePlanRef, "Silence-plan ref"), brand: {id: input.brand.id, version: input.brand.version, frameSha256: input.brand.frameSha256, fontHashes: input.brand.fontHashes},
    heroMoment: text(input.heroMoment, "Hero moment"), surpriseBeat: text(input.surpriseBeat, "Surprise beat"), antiPatterns: Array.isArray(input.antiPatterns) ? structuredClone(input.antiPatterns) : (() => { throw new Error("Anti-patterns are required"); })(),
    shots, deviations: input.deviations ?? [],
  };
  if (designPlan.silencePlanRef.artifactId !== parents.storyRef.artifactId || designPlan.silencePlanRef.sha256 !== parents.storyRef.sha256) throw new Error("Silence-plan ref must be the current story plan");
  const artifact = createArtifactEnvelope({artifactId: `video-design-plan:${input.workItemId}:v${pad(input.revision)}`, revision: input.revision, workItemId: input.workItemId,
    modality: input.modality, parents: envelopeParents(parents), producer: input.producer, versions: input.versions, status: "frozen", deviations: designPlan.deviations, payload: {kind: "video-design-plan", ...designPlan}});
  validateArtifactEnvelope(artifact);
  const path = designPlanPath(input.workItemId, input.revision);
  const dependencies = {hash: adapters.hashFileNoFollow ?? hashFileNoFollow, makeDirectories: adapters.makeDirectories ?? makeDirectories,
    removeOwnedFile: adapters.removeOwnedFile ?? removeOwnedFile, writeExclusiveFile: adapters.writeExclusiveFile ?? writeExclusiveFile};
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  let owner;
  try {
    await loadParents(root, input);
    await assertWorkflowCurrent(root, input.workItemId, input.revision, input.modality, "STORY_PLANNED");
    await dependencies.makeDirectories(root, `Plans/Designs/${input.workItemId}`);
    owner = await dependencies.writeExclusiveFile(root, path, bytes);
    const stored = await dependencies.hash(root, path);
    if (stored.sha256 !== createHash("sha256").update(bytes).digest("hex") || stored.bytes !== bytes.length
      || stored.owner.dev !== owner.dev || stored.owner.ino !== owner.ino) throw new Error("Video design-plan bytes changed after publication");
    await loadParents(root, input);
    await assertWorkflowCurrent(root, input.workItemId, input.revision, input.modality, "STORY_PLANNED");
    return {artifact, artifactRef: {artifactId: artifact.artifactId, sha256: stored.sha256}, designPlan};
  } catch (error) {
    if (owner) await dependencies.removeOwnedFile(root, path, owner);
    throw error;
  }
}

export async function approveVideoDesignPlan(projectDir, coordinatorContext, input) {
  assertIndependentReviewer({producerActorId: input?.producerActorId, reviewerActorId: input?.reviewerActorId, reviewerRole: "design-approver"});
  const root = await realpath(projectDir);
  const workItemId = text(input?.workItemId, "Work item id");
  const preliminary = getWorkItem(await readWorkflowState(root), workItemId);
  const item = await assertWorkflowCurrent(root, workItemId, preliminary.revision, preliminary.modality, "DESIGN_PLANNED");
  const expected = ref(input.artifactRef, "Design-plan ref");
  const artifact = await readExactArtifact(root, designPlanPath(workItemId, item.revision), expected, "Video design plan");
  if (artifact.artifactId !== `video-design-plan:${workItemId}:v${pad(item.revision)}` || artifact.workItemId !== workItemId || artifact.revision !== item.revision
    || artifact.payload?.kind !== "video-design-plan" || artifact.producer?.role !== "design-director" || artifact.producer.actorId !== input.producerActorId) {
    throw new Error("Design approval requires the current design-director plan and producer");
  }
  const parentInput = {
    workItemId, revision: item.revision, modality: item.modality, producer: artifact.producer, versions: artifact.versions, format: artifact.payload.format,
    stylePresetId: artifact.payload.stylePresetId,
    scriptOrTranscriptRef: artifact.payload.parents.scriptOrTranscript, transcriptArtifactRefs: artifact.payload.parents.transcripts,
    storyPlanRef: artifact.payload.parents.storyPlan, assetPlanRef: artifact.payload.parents.assetPlan, subjectMapRefs: artifact.payload.parents.subjectMaps,
    brandRef: artifact.payload.parents.brand, brand: artifact.payload.brand, captionPlanRef: artifact.payload.parents.captionPlan,
    foregroundSidecarRefs: artifact.payload.parents.foregroundSidecars, silencePlanRef: artifact.payload.silencePlanRef,
  };
  await loadParents(root, parentInput);
  await assertWorkflowCurrent(root, workItemId, item.revision, item.modality, "DESIGN_PLANNED");
  const approval = await recordApproval(root, coordinatorContext, {kind: "design", workItemId, subject: expected, decision: "approved",
    approver: {actorId: input.reviewerActorId, role: "design-approver"}, producerActorId: input.producerActorId, origin: "bizibeast", policyVersion: "bizibeast-v1"});
  try {
    await loadParents(root, parentInput);
    await assertWorkflowCurrent(root, workItemId, item.revision, item.modality, "DESIGN_PLANNED");
  } catch (error) {
    await recordApproval(root, coordinatorContext, {kind: "design", workItemId, subject: expected, decision: "rejected",
      approver: {actorId: input.reviewerActorId, role: "design-approver"}, producerActorId: input.producerActorId, origin: "bizibeast", policyVersion: "bizibeast-v1"});
    throw error;
  }
  return approval;
}
