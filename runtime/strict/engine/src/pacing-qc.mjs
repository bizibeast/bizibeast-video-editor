import {observed, qcCheck} from "./qc-check.mjs";

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isMilliseconds = (value) => Number.isFinite(value) && value >= 0;
const covers = (segments, startMs, endMs) => segments.some((segment) => segment.startMs <= startMs && segment.endMs >= endMs);

function profilePacing(profile) {
  const pacing = profile?.pacing;
  const keys = ["candidateGapMs", "compressedGapMinMs", "compressedGapMaxMs", "speechHandleMs", "dramaticPauseMinMs", "dramaticPauseMaxMs", "firstHookMaxMs"];
  return isPlainObject(pacing) && keys.every((key) => Number.isFinite(pacing[key]) && pacing[key] >= 0)
    && pacing.compressedGapMinMs <= pacing.compressedGapMaxMs && pacing.dramaticPauseMinMs <= pacing.dramaticPauseMaxMs ? pacing : null;
}

function validWords(words) {
  if (!Array.isArray(words)) return false;
  const ids = new Set();
  return words.every((word, index) => isPlainObject(word) && typeof word.id === "string" && word.id.length > 0 && !ids.has(word.id)
    && (ids.add(word.id), isMilliseconds(word.startMs) && Number.isFinite(word.endMs) && word.endMs > word.startMs
      && (index === 0 || word.startMs >= words[index - 1].endMs)));
}

function validSegments(segments) {
  return Array.isArray(segments) && segments.every((segment) => isPlainObject(segment) && isMilliseconds(segment.startMs)
    && Number.isFinite(segment.endMs) && segment.endMs > segment.startMs);
}

export function validateShortFormPacing(input, profile) {
  const pacing = profilePacing(profile);
  const shape = isPlainObject(input) && validWords(input.words) && validSegments(input.vadSegments)
    && Array.isArray(input.edits) && Array.isArray(input.intentionalPauses) && isMilliseconds(input.hookAtMs);
  const checks = [qcCheck("pacing.input", shape, "hard", "story-editor", [observed("pacing.input", shape ? "valid" : input, "valid words, VAD, edits, pauses, and hook")])];
  checks.push(qcCheck("pacing.profile", Boolean(pacing), "hard", "story-editor", [observed("profile.pacing", pacing ?? null, "frozen pacing thresholds")]));
  if (!shape || !pacing) return checks;

  checks.push(qcCheck("pacing.hook", input.hookAtMs <= pacing.firstHookMaxMs, "hard", "story-editor", [observed("hookAtMs", input.hookAtMs, `<=${pacing.firstHookMaxMs}`)]));
  const gaps = [];
  const handles = [];
  const vad = [];
  for (let index = 1; index < input.words.length; index += 1) {
    const previous = input.words[index - 1];
    const next = input.words[index];
    const gapMs = next.startMs - previous.endMs;
    if (gapMs < pacing.candidateGapMs) continue;
    const locator = `${previous.id}@${previous.endMs}-${next.startMs}ms`;
    const pause = input.intentionalPauses.find(({afterWordId}) => afterWordId === previous.id);
    const edit = input.edits.find(({afterWordId}) => afterWordId === previous.id);
    const pauseValid = isPlainObject(pause) && Number.isFinite(pause.durationMs) && pause.durationMs === gapMs
      && gapMs >= pacing.dramaticPauseMinMs && gapMs <= pacing.dramaticPauseMaxMs
      && pause.durationMs >= pacing.dramaticPauseMinMs && pause.durationMs <= pacing.dramaticPauseMaxMs
      && typeof pause.reason === "string" && pause.reason.trim().length > 0;
    const removedDurationMs = Number.isFinite(edit?.startMs) && Number.isFinite(edit?.endMs) ? edit.endMs - edit.startMs : NaN;
    const resultingGapMs = gapMs - removedDurationMs;
    const compressed = isPlainObject(edit) && Number.isFinite(edit.startMs) && Number.isFinite(edit.endMs)
      && edit.startMs >= previous.endMs && edit.endMs <= next.startMs && removedDurationMs > 0
      && resultingGapMs >= pacing.compressedGapMinMs && resultingGapMs <= pacing.compressedGapMaxMs;
    const handlesValid = pauseValid || (compressed && Number.isFinite(edit.leftHandleMs) && Number.isFinite(edit.rightHandleMs)
      && edit.leftHandleMs === edit.startMs - previous.endMs && edit.rightHandleMs === next.startMs - edit.endMs
      && edit.leftHandleMs >= pacing.speechHandleMs && edit.rightHandleMs >= pacing.speechHandleMs);
    const vadValid = pauseValid || (compressed && covers(input.vadSegments, previous.endMs - pacing.speechHandleMs, previous.endMs)
      && covers(input.vadSegments, next.startMs, next.startMs + pacing.speechHandleMs));
    gaps.push(observed(locator, {gapMs, resultingGapMs: Number.isFinite(resultingGapMs) ? resultingGapMs : null, edit: edit ?? null, pause: pause ?? null}, "120-140ms resulting gap or labelled 450-900ms pause"));
    if (!pauseValid && !compressed) gaps.push(observed(`${locator}:decision`, "unchanged", "labelled dramatic pause or compressed gap"));
    if (!handlesValid) handles.push(observed(locator, edit ? {leftHandleMs: edit.leftHandleMs, rightHandleMs: edit.rightHandleMs} : null, `>=${pacing.speechHandleMs}ms speech handles`));
    if (!vadValid) vad.push(observed(locator, input.vadSegments, "VAD coverage at both speech handles"));
  }
  checks.push(qcCheck("pacing.unmarked-gap", gaps.filter(({locator}) => locator.endsWith(":decision")).length === 0, "hard", "story-editor", gaps.length ? gaps : [observed("words", "no candidate gaps", `>=${pacing.candidateGapMs}ms`)]));
  checks.push(qcCheck("pacing.phoneme-handle", handles.length === 0, "hard", "story-editor", handles.length ? handles : [observed("edits", "all handles retained", `>=${pacing.speechHandleMs}ms`)]));
  checks.push(qcCheck("pacing.vad-boundary", vad.length === 0, "hard", "story-editor", vad.length ? vad : [observed("vadSegments", "all cut boundaries covered", "speech-handle VAD coverage")]));
  return checks;
}
