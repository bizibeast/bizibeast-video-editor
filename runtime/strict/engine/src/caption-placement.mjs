const LOWER_RESERVE_PX = 420;

function box(value, label) {
  if (!value || ![value.x, value.y, value.width, value.height].every(Number.isFinite)
    || value.x < 0 || value.y < 0 || value.width <= 0 || value.height <= 0) throw new Error(`${label} must be a positive pixel box`);
  return value;
}

function overlapRatio(left, right) {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height / (left.width * left.height);
}

export function chooseShotCaptionAnchor({frameSize, shot, avoidRegions = [], captionSize}) {
  const frame = box({...frameSize, x: 0, y: 0}, "Frame size");
  const size = box({...captionSize, x: 0, y: 0}, "Caption size");
  if (!shot?.id || !Number.isSafeInteger(shot.startMs) || !Number.isSafeInteger(shot.endMs) || shot.endMs <= shot.startMs) {
    throw new Error("Shot must have an ID and positive millisecond range");
  }
  if (size.width > frame.width || size.height > frame.height - LOWER_RESERVE_PX) throw new Error("Caption does not fit above the lower reserve");
  const x = Math.round((frame.width - size.width) / 2);
  const candidates = [
    {anchorId: "top-center", x, y: 170},
    {anchorId: "upper-center", x, y: 500},
    {anchorId: "lower-center", x, y: frame.height - LOWER_RESERVE_PX - size.height - 40},
  ].map((candidate) => ({...candidate, width: size.width, height: size.height})).filter((candidate) => candidate.y >= 0 && candidate.y + candidate.height <= frame.height - LOWER_RESERVE_PX);
  const relevant = avoidRegions.filter(({timeMs, box: region}) => Number.isSafeInteger(timeMs) && timeMs >= shot.startMs && timeMs <= shot.endMs && region)
    .map(({box: region}) => box(region, "Avoid region"));
  const scored = candidates.map((candidate, priority) => ({
    ...candidate,
    priority,
    maximumAvoidOverlapRatio: Math.max(0, ...relevant.map((region) => overlapRatio(candidate, region))),
  })).sort((left, right) => left.maximumAvoidOverlapRatio - right.maximumAvoidOverlapRatio || left.priority - right.priority);
  const best = scored[0];
  if (!best) throw new Error("No caption anchor fits above the lower reserve");
  if (best.maximumAvoidOverlapRatio > 0.1 && shot.faceAwareRequired) throw new Error(`No face-safe caption anchor for ${shot.id}`);
  const {priority, ...placement} = best;
  return {
    ...placement,
    shotId: shot.id,
    fixedWithinShot: true,
    lowerReservePx: LOWER_RESERVE_PX,
    deviation: placement.maximumAvoidOverlapRatio > 0.1 ? "fixed-best-anchor" : null,
  };
}

function removedBefore(operations, timeMs) {
  return operations.reduce((total, operation) => {
    if (operation.kind !== "compress-gap" && !operation.kind.startsWith("trim-")) return total;
    const start = operation.removeStartMs ?? operation.startMs;
    const end = operation.removeEndMs ?? operation.endMs;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) throw new Error("Silence operation must have a positive removal range");
    return total + Math.max(0, Math.min(timeMs, end) - start);
  }, 0);
}

export function retimeStoryWords({segments, transcripts, silencePlan}) {
  if (!Array.isArray(segments) || !Array.isArray(transcripts) || !Array.isArray(silencePlan)) throw new Error("Story segments, transcripts, and silence plan are required");
  const wordsBySource = new Map(transcripts.map(({sourceId, words}) => [sourceId, words]));
  const operationsBySource = new Map(silencePlan.map(({sourceId, silencePlan: plan}) => [sourceId, plan?.operations ?? []]));
  return segments.flatMap((segment) => {
    const words = wordsBySource.get(segment.sourceId);
    if (!Array.isArray(words)) throw new Error(`Missing transcript for ${segment.sourceId}`);
    const first = words.findIndex(({id}) => id === segment.firstWordId);
    const last = words.findIndex(({id}) => id === segment.lastWordId);
    if (first < 0 || last < first) throw new Error(`Story segment ${segment.id} does not select an exact transcript range`);
    const operations = operationsBySource.get(segment.sourceId) ?? [];
    const segmentOffset = removedBefore(operations, segment.sourceInMs);
    return words.slice(first, last + 1).map((word) => {
      const startMs = segment.timelineInMs + word.startMs - removedBefore(operations, word.startMs) - (segment.sourceInMs - segmentOffset);
      const endMs = segment.timelineInMs + word.endMs - removedBefore(operations, word.endMs) - (segment.sourceInMs - segmentOffset);
      if (endMs <= startMs) throw new Error(`Silence removal crosses transcript word ${word.id}`);
      return {...word, startMs, endMs, shotId: segment.id};
    });
  });
}
