import {observed, qcCheck} from "./qc-check.mjs";

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const finite = (value) => Number.isFinite(value);
const rectangle = (value) => isPlainObject(value) && [value.x, value.y, value.width, value.height].every(finite) && value.width > 0 && value.height > 0;
const intersects = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

function samplesFrom(subjectMap) {
  const samples = Array.isArray(subjectMap?.samples) ? subjectMap.samples : Array.isArray(subjectMap?.frames) ? subjectMap.frames : [];
  return samples.flatMap((sample) => {
    if (!isPlainObject(sample)) return [];
    const avoid = sample.avoid ?? sample.subjectBox;
    const faces = Array.isArray(sample.faces) ? sample.faces.map((face) => face?.box ?? face).filter(rectangle) : [];
    return [{
      ...sample,
      confidence: sample.confidence ?? subjectMap.tracking?.confidence,
      jitterPx: sample.jitterPx ?? subjectMap.tracking?.jitterPx,
      discontinuity: sample.discontinuity ?? subjectMap.tracking?.discontinuities?.includes(sample.timeMs),
      avoid: rectangle(avoid) ? avoid : null,
      faces,
    }];
  });
}

function requirements(input) {
  const value = input.blueprintRequirements;
  if (!isPlainObject(value) || !["required", "optional"].includes(value.tracking) || !["required", "optional"].includes(value.matte)) return null;
  return value;
}

function subjectProfile(profile) {
  const subject = profile?.subject;
  const captions = profile?.captions;
  return isPlainObject(subject) && finite(subject.minTrackingConfidence) && finite(subject.maxJitterPx)
    && finite(subject.maxMatteChatterRatio) && finite(subject.maxEdgeHaloPx)
    && isPlainObject(captions) && captions.lowerReservePx === 420 ? {subject, lowerReservePx: captions.lowerReservePx} : null;
}

export function validateSubjectCaptionSafety(input, profile) {
  const gates = subjectProfile(profile);
  const validFrame = isPlainObject(input?.frame) && Number.isInteger(input.frame.width) && input.frame.width > 0 && Number.isInteger(input.frame.height) && input.frame.height > 0;
  const validShots = Array.isArray(input?.shots) && new Set(input.shots.map(({id}) => id)).size === input.shots.length && input.shots.every((shot) => isPlainObject(shot) && typeof shot.id === "string" && shot.id.length > 0 && finite(shot.startMs) && finite(shot.endMs) && shot.startMs <= shot.endMs);
  const validCaptions = Array.isArray(input?.captions) && input.captions.every((caption) => isPlainObject(caption) && typeof caption.id === "string" && typeof caption.shotId === "string" && rectangle(caption.box));
  const requirement = requirements(input ?? {});
  const shape = isPlainObject(input) && validFrame && validShots && validCaptions && requirement;
  const checks = [qcCheck("subject.input", Boolean(shape), "hard", "subject-analyst", [observed("subject.input", shape ? "valid" : input, "valid frame, shots, captions, and blueprint requirements")])];
  checks.push(qcCheck("subject.profile", Boolean(gates), "hard", "subject-analyst", [observed("profile.subject", gates ?? null, "frozen subject thresholds and 420px reserve")]));
  if (!shape || !gates) return checks;
  const subjectMap = input.subjectMap;
  const mapSamples = samplesFrom(subjectMap);
  const hasCompleteTracking = mapSamples.length > 0 && mapSamples.every((sample) => finite(sample.confidence) && finite(sample.jitterPx) && typeof sample.discontinuity === "boolean");
  const fallback = !hasCompleteTracking && requirement.tracking === "optional" && typeof requirement.trackingDeviation === "string" && requirement.trackingDeviation.trim().length > 0
    && input.captions.every((caption) => typeof (caption.anchorId ?? caption.placement?.anchorId) === "string");
  const noTrackFallback = fallback && !subjectMap;
  const sourceHashPass = noTrackFallback || (hash(input.sourceSha256) && subjectMap?.sourceSha256 === input.sourceSha256);
  const coordinatePass = noTrackFallback || subjectMap?.coordinateSpace === "top-left-pixels";
  const framePass = noTrackFallback || (subjectMap?.frameSize?.width === input.frame.width && subjectMap?.frameSize?.height === input.frame.height);
  checks.push(qcCheck("subject.tracking-fallback", hasCompleteTracking || fallback, "hard", "design-director", [observed("blueprintRequirements.trackingDeviation", requirement.trackingDeviation ?? null, hasCompleteTracking ? "complete subject track" : "declared fixed-anchor deviation")]));
  checks.push(qcCheck("subject.source-hash", sourceHashPass, "hard", "subject-analyst", [observed("subjectMap.sourceSha256", subjectMap?.sourceSha256 ?? null, input.sourceSha256)]));
  checks.push(qcCheck("subject.coordinate-space", coordinatePass, "hard", "subject-analyst", [observed("subjectMap.coordinateSpace", subjectMap?.coordinateSpace ?? null, "top-left-pixels")]));
  checks.push(qcCheck("subject.frame-size", framePass, "hard", "subject-analyst", [observed("subjectMap.frameSize", subjectMap?.frameSize ?? null, input.frame)]));

  const bounds = input.captions.filter(({box}) => box.x < 0 || box.y < 0 || box.x + box.width > input.frame.width || box.y + box.height > input.frame.height);
  const reserve = input.captions.filter(({box}) => box.y + box.height > input.frame.height - gates.lowerReservePx);
  const shotIds = new Set(input.shots.map(({id}) => id));
  const unknownShots = input.captions.filter(({shotId}) => !shotIds.has(shotId));
  const anchors = input.shots.flatMap((shot) => {
    const values = new Set(input.captions.filter(({shotId}) => shotId === shot.id).map((caption) => caption.anchorId ?? caption.placement?.anchorId ?? `${caption.box.x}:${caption.box.y}`));
    return values.size > 1 ? [observed(`${shot.id}@anchor`, [...values], "one stable anchor per shot")] : [];
  });
  const face = input.captions.flatMap((caption) => mapSamples.filter(({shotId}) => shotId === caption.shotId).flatMap((sample) => [sample.avoid, ...sample.faces].filter(rectangle).filter((avoid) => intersects(caption.box, avoid)).map((avoid) => observed(`${caption.id}@${sample.timeMs ?? "unknown"}ms`, caption.box, {avoid, rule: "no face or subject occlusion"}))));
  checks.push(qcCheck("caption.frame-bounds", bounds.length === 0, "hard", "subject-analyst", bounds.length ? bounds.map(({id, box}) => observed(`${id}@box`, box, "inside frame")) : [observed("captions", "inside frame", "inside frame")]));
  checks.push(qcCheck("caption.shot-reference", unknownShots.length === 0, "hard", "subject-analyst", unknownShots.length ? unknownShots.map(({id, shotId}) => observed(`${id}@shot`, shotId, "locked shot ID")) : [observed("captions", "resolved shot IDs", "locked shot IDs")]));
  checks.push(qcCheck("caption.lower-reserve", reserve.length === 0, "hard", "subject-analyst", reserve.length ? reserve.map(({id, box}) => observed(`${id}@box`, box.y + box.height, `<=${input.frame.height - gates.lowerReservePx}`)) : [observed("captions", "outside lower reserve", "420px portrait reserve")]));
  checks.push(qcCheck("caption.stable-anchor", anchors.length === 0, "hard", "subject-analyst", anchors.length ? anchors : [observed("shots", "one anchor per shot", "stable anchors")]));
  checks.push(qcCheck("caption.face-avoidance", face.length === 0, "hard", "subject-analyst", face.length ? face : [observed("captions", "no tracked overlap", "avoid faces and subjects")]));

  const tracked = requirement.tracking === "required";
  const matteRequired = requirement.matte === "required" || requirement.backgroundRemoval === "required" || requirement.textBehindSubject === "required";
  const coverageRequired = tracked || matteRequired;
  const coverageFor = (shot, samples) => {
    const relevant = samples.filter(({shotId, timeMs}) => shotId === shot.id && finite(timeMs) && timeMs >= shot.startMs && timeMs <= shot.endMs);
    const times = relevant.map(({timeMs}) => timeMs);
    const range = subjectMap?.timeRangeMs ?? subjectMap?.timeRange;
    const rangeCoversShot = isPlainObject(range) && finite(range.startMs) && finite(range.endMs) && range.startMs <= shot.startMs && range.endMs >= shot.endMs;
    const samplesCoverShot = times.length > 0 && Math.min(...times) <= shot.startMs && Math.max(...times) >= shot.endMs;
    return {relevant, times, range, covered: relevant.length > 0 && (rangeCoversShot || samplesCoverShot)};
  };
  const shotSamples = input.shots.flatMap((shot) => {
    const coverage = coverageFor(shot, mapSamples);
    return coverageRequired && !coverage.covered ? [observed(`${shot.id}@coverage`, {sampleTimes: coverage.times, range: coverage.range ?? null}, {startMs: shot.startMs, endMs: shot.endMs})] : [];
  });
  const trackingQuality = [
    ...(tracked && mapSamples.length === 0 ? [observed("subjectMap.samples", [], "required tracking samples")] : []),
    ...mapSamples.flatMap((sample) => {
    const confidence = finite(sample.confidence) ? sample.confidence : sample.faces?.length ? Math.min(...sample.faces.map(({confidence}) => confidence).filter(finite)) : null;
    return !tracked || (confidence !== null && confidence >= gates.subject.minTrackingConfidence && typeof sample.discontinuity === "boolean" && sample.discontinuity === false && finite(sample.jitterPx) && sample.jitterPx <= gates.subject.maxJitterPx) ? [] : [observed(`${sample.shotId ?? "unknown"}@${sample.timeMs ?? "unknown"}ms`, {confidence, jitterPx: sample.jitterPx ?? null, discontinuity: sample.discontinuity ?? null}, {minConfidence: gates.subject.minTrackingConfidence, maxJitterPx: gates.subject.maxJitterPx, discontinuity: false})];
    }),
  ];
  const matteComplete = (sample) => isPlainObject(sample.matte) && finite(sample.matte.chatterRatio) && sample.matte.chatterRatio <= gates.subject.maxMatteChatterRatio && finite(sample.matte.edgeHaloPx) && sample.matte.edgeHaloPx <= gates.subject.maxEdgeHaloPx;
  const matteCoverage = matteRequired ? input.shots.flatMap((shot) => {
    const coverage = coverageFor(shot, mapSamples.filter(matteComplete));
    return coverage.covered ? [] : [observed(`${shot.id}@matte-coverage`, {sampleTimes: coverage.times, range: coverage.range ?? null}, {startMs: shot.startMs, endMs: shot.endMs, matte: "local metrics"})];
  }) : [];
  const matteMissing = matteRequired ? (mapSamples.length ? mapSamples.filter((sample) => !matteComplete(sample)) : [{shotId: "unknown", timeMs: "missing"}]) : [];
  const matteQuality = [
    ...(matteRequired && mapSamples.length === 0 ? [observed("subjectMap.samples", [], "required matte samples")] : []),
    ...matteCoverage,
    ...mapSamples.flatMap((sample) => {
    const matte = isPlainObject(sample.matte) ? sample.matte : {};
    return !matteRequired || matteComplete(sample) ? [] : [observed(`${sample.shotId ?? "unknown"}@${sample.timeMs ?? "unknown"}ms`, matte, {maxChatterRatio: gates.subject.maxMatteChatterRatio, maxEdgeHaloPx: gates.subject.maxEdgeHaloPx})];
    }),
  ];
  checks.push(qcCheck("subject.time-coverage", shotSamples.length === 0, "hard", "subject-analyst", shotSamples.length ? shotSamples : [observed("shots", "covered", "tracking or matte samples where required")]));
  checks.push(qcCheck("subject.tracking-quality", trackingQuality.length === 0, "hard", "subject-analyst", trackingQuality.length ? trackingQuality : [observed("subjectMap.samples", "within thresholds", "confidence, continuity, jitter")]));
  checks.push(qcCheck("matte.required", matteMissing.length === 0 && matteCoverage.length === 0, "hard", "premiere-executor", matteMissing.length || matteCoverage.length ? [...matteMissing.map((sample) => observed(`${sample.shotId ?? "unknown"}@${sample.timeMs ?? "unknown"}ms`, null, "local matte")), ...matteCoverage] : [observed("subjectMap.samples", "required mattes present", "local matte per sample")]));
  checks.push(qcCheck("matte.quality", matteQuality.length === 0, "hard", "premiere-executor", matteQuality.length ? matteQuality : [observed("subjectMap.samples", "within thresholds", "matte chatter and edge halo limits")]));
  return checks;
}
