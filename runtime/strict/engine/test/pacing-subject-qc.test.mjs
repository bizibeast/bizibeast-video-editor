import assert from "node:assert/strict";
import test from "node:test";

import {validateShortFormPacing} from "../src/pacing-qc.mjs";
import {validateSubjectCaptionSafety} from "../src/subject-qc.mjs";
import {resolveTechnicalProfile} from "../src/qc-profiles.mjs";

const profile = resolveTechnicalProfile("vertical-short-v1");
const words = [{id: "w1", startMs: 0, endMs: 400}, {id: "w2", startMs: 1000, endMs: 1400}];
const vadSegments = [{startMs: 0, endMs: 1400}];
const frame = {width: 1080, height: 1920};
const shots = [{id: "s1", startMs: 0, endMs: 1400}];

test("fails an unmarked 300ms gap that was left unchanged", () => {
  const checks = validateShortFormPacing({
    words: [{id: "w1", startMs: 0, endMs: 400}, {id: "w2", startMs: 700, endMs: 1000}],
    vadSegments: [{startMs: 0, endMs: 1000}], edits: [], intentionalPauses: [], hookAtMs: 300,
  }, profile);
  assert.ok(checks.some(({id, pass}) => id === "pacing.unmarked-gap" && !pass));
});

test("passes a labelled 600ms dramatic pause", () => {
  const checks = validateShortFormPacing({
    words, vadSegments, edits: [],
    intentionalPauses: [{afterWordId: "w1", durationMs: 600, reason: "hold the reveal"}], hookAtMs: 250,
  }, profile);
  assert.equal(checks.find(({id}) => id === "pacing.unmarked-gap").pass, true);
});

test("rejects a claimed dramatic pause when the adjacent gap is too short or too long", () => {
  for (const nextStartMs of [640, 2400]) {
    const checks = validateShortFormPacing({
      words: [{id: "w1", startMs: 0, endMs: 400}, {id: "w2", startMs: nextStartMs, endMs: nextStartMs + 400}], vadSegments,
      edits: [], intentionalPauses: [{afterWordId: "w1", durationMs: 600, reason: "claimed hold"}], hookAtMs: 250,
    }, profile);
    assert.equal(checks.find(({id}) => id === "pacing.unmarked-gap").pass, false, `${nextStartMs - 400}ms actual gap`);
  }
});

test("fails a silence cut with less than 40ms speech handles", () => {
  const checks = validateShortFormPacing({
    words: [{id: "w1", startMs: 0, endMs: 400}, {id: "w2", startMs: 700, endMs: 1000}],
    vadSegments: [{startMs: 0, endMs: 1000}],
    edits: [{afterWordId: "w1", startMs: 405, endMs: 690, leftHandleMs: 5, rightHandleMs: 10}],
    intentionalPauses: [], hookAtMs: 300,
  }, profile);
  assert.ok(checks.some(({id, pass}) => id === "pacing.phoneme-handle" && !pass));
});

test("fails a tiny removal from a very large adjacent-word gap", () => {
  const checks = validateShortFormPacing({
    words: [{id: "w1", startMs: 0, endMs: 400}, {id: "w2", startMs: 10400, endMs: 10800}],
    vadSegments: [{startMs: 0, endMs: 10800}],
    edits: [{afterWordId: "w1", startMs: 4440, endMs: 4560, leftHandleMs: 40, rightHandleMs: 40}],
    intentionalPauses: [], hookAtMs: 300,
  }, profile);

  assert.equal(checks.find(({id}) => id === "pacing.unmarked-gap").pass, false);
});

test("fails a late hook and a cut not covered by VAD", () => {
  const checks = validateShortFormPacing({
    words: [{id: "w1", startMs: 0, endMs: 400}, {id: "w2", startMs: 700, endMs: 1000}],
    vadSegments: [{startMs: 0, endMs: 399}, {startMs: 701, endMs: 1000}],
    edits: [{afterWordId: "w1", startMs: 460, endMs: 590, leftHandleMs: 40, rightHandleMs: 40}],
    intentionalPauses: [], hookAtMs: 1001,
  }, profile);
  assert.equal(checks.find(({id}) => id === "pacing.hook").pass, false);
  assert.equal(checks.find(({id}) => id === "pacing.vad-boundary").pass, false);
});

test("fails a caption intersecting the tracked face avoid region and missing required matte", () => {
  const checks = validateSubjectCaptionSafety({
    sourceSha256: "a".repeat(64), frame, shots,
    captions: [{id: "c1", shotId: "s1", box: {x: 380, y: 300, width: 320, height: 160}, anchorId: "top-center"}],
    subjectMap: {sourceSha256: "a".repeat(64), coordinateSpace: "top-left-pixels", frameSize: frame, samples: [{shotId: "s1", timeMs: 0, avoid: {x: 400, y: 280, width: 280, height: 300}, confidence: 0.95}]},
    blueprintRequirements: {tracking: "required", matte: "required"},
  }, profile);
  assert.ok(checks.some(({id, pass}) => id === "caption.face-avoidance" && !pass));
  assert.ok(checks.some(({id, pass}) => id === "matte.required" && !pass));
});

test("fails captions outside bounds, inside the exact lower reserve, and changing anchors in one shot", () => {
  const checks = validateSubjectCaptionSafety({
    sourceSha256: "a".repeat(64), frame, shots,
    captions: [
      {id: "c1", shotId: "s1", box: {x: -1, y: 200, width: 320, height: 160}, anchorId: "top-center"},
      {id: "c2", shotId: "s1", box: {x: 380, y: 1341, width: 320, height: 160}, anchorId: "upper-center"},
    ],
    subjectMap: {sourceSha256: "a".repeat(64), coordinateSpace: "top-left-pixels", frameSize: frame, samples: []},
    blueprintRequirements: {tracking: "optional", matte: "optional", trackingDeviation: "fixed-safe-anchor"},
  }, profile);
  assert.equal(checks.find(({id}) => id === "caption.frame-bounds").pass, false);
  assert.equal(checks.find(({id}) => id === "caption.lower-reserve").pass, false);
  assert.equal(checks.find(({id}) => id === "caption.stable-anchor").pass, false);
});

test("fails malformed trust-boundary subject evidence", () => {
  const checks = validateSubjectCaptionSafety({
    sourceSha256: "not-a-hash", frame: {width: 0, height: 1920}, shots: [{id: "s1", startMs: 100, endMs: 0}], captions: [],
    subjectMap: {sourceSha256: "b".repeat(64), coordinateSpace: "normalized", frameSize: {width: 1, height: 1}, samples: [{shotId: "s1", timeMs: 0, confidence: 0.1, jitterPx: 7, discontinuity: true, matte: {chatterRatio: 0.03, edgeHaloPx: 4}}]},
    blueprintRequirements: {tracking: "required", matte: "required"},
  }, profile);
  assert.equal(checks.find((check) => check.id === "subject.input").pass, false);
});

test("fails required tracking and matte quality thresholds", () => {
  const checks = validateSubjectCaptionSafety({
    sourceSha256: "a".repeat(64), frame, shots, captions: [],
    subjectMap: {sourceSha256: "a".repeat(64), coordinateSpace: "top-left-pixels", frameSize: frame, samples: [{shotId: "s1", timeMs: 0, confidence: 0.1, jitterPx: 7, discontinuity: true, matte: {chatterRatio: 0.03, edgeHaloPx: 4}}]},
    blueprintRequirements: {tracking: "required", matte: "required"},
  }, profile);
  for (const id of ["subject.time-coverage", "subject.tracking-quality", "matte.required", "matte.quality"]) assert.equal(checks.find((check) => check.id === id).pass, false, id);
});

test("fails closed for required missing samples, metrics, and caption shot references", () => {
  const checks = validateSubjectCaptionSafety({
    sourceSha256: "a".repeat(64), frame, shots,
    captions: [{id: "unknown-caption", shotId: "missing-shot", anchorId: "top-center", box: {x: 380, y: 300, width: 320, height: 160}}],
    subjectMap: {sourceSha256: "a".repeat(64), coordinateSpace: "top-left-pixels", frameSize: frame, samples: [{shotId: "s1", timeMs: 0, mattePath: "mask.png"}]},
    blueprintRequirements: {tracking: "required", matte: "required"},
  }, profile);
  for (const id of ["caption.shot-reference", "subject.tracking-fallback", "subject.time-coverage", "subject.tracking-quality", "matte.required", "matte.quality"]) assert.equal(checks.find((check) => check.id === id).pass, false, id);
});

test("fails closed when a required subject map has no samples", () => {
  const checks = validateSubjectCaptionSafety({
    sourceSha256: "a".repeat(64), frame, shots, captions: [],
    subjectMap: {sourceSha256: "a".repeat(64), coordinateSpace: "top-left-pixels", frameSize: frame, samples: []},
    blueprintRequirements: {tracking: "required", matte: "required"},
  }, profile);
  for (const id of ["subject.tracking-fallback", "subject.time-coverage", "subject.tracking-quality", "matte.required", "matte.quality"]) assert.equal(checks.find((check) => check.id === id).pass, false, id);
});

test("requires matte coverage and metrics for every shot even with optional tracking", () => {
  const twoShots = [{id: "s1", startMs: 0, endMs: 100}, {id: "s2", startMs: 100, endMs: 200}];
  const checks = validateSubjectCaptionSafety({
    sourceSha256: "a".repeat(64), frame, shots: twoShots, captions: [],
    subjectMap: {
      sourceSha256: "a".repeat(64), coordinateSpace: "top-left-pixels", frameSize: frame, timeRangeMs: {startMs: 0, endMs: 100},
      samples: [{shotId: "s1", timeMs: 0, confidence: 0.95, jitterPx: 1, discontinuity: false, matte: {chatterRatio: 0.01, edgeHaloPx: 1}}],
    },
    blueprintRequirements: {tracking: "optional", matte: "required"},
  }, profile);
  assert.equal(checks.find(({id}) => id === "subject.time-coverage").pass, false);
  assert.equal(checks.find(({id}) => id === "matte.required").pass, false);
  assert.equal(checks.find(({id}) => id === "matte.quality").pass, false);
});

test("permits no optional track only with a declared fixed-anchor deviation", () => {
  const checks = validateSubjectCaptionSafety({
    sourceSha256: "a".repeat(64), frame, shots,
    captions: [{id: "c1", shotId: "s1", anchorId: "top-center", box: {x: 380, y: 300, width: 320, height: 160}}],
    subjectMap: null,
    blueprintRequirements: {tracking: "optional", matte: "optional", trackingDeviation: "fixed-safe-anchor"},
  }, profile);
  assert.equal(checks.find(({id}) => id === "subject.tracking-fallback").pass, true);
});
