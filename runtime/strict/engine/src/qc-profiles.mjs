import {sha256Value} from "./checksum.mjs";

const videoDelivery = {
  allowedContainers: ["mp4", "mov"],
  fullDecodeRequired: true,
};

const audio = {
  sampleRate: 48000,
  allowedChannels: [1, 2],
  integratedLufsTarget: -14,
  integratedLufsTolerance: 2,
  truePeakMaxDb: -1,
};

const captions = {
  maxWords: 5,
  maxCharsPerLine: 32,
  lowerReservePx: 420,
  overlapToleranceMs: 10,
};

const pacing = {
  candidateGapMs: 240,
  compressedGapMinMs: 120,
  compressedGapMaxMs: 140,
  speechHandleMs: 40,
  dramaticPauseMinMs: 450,
  dramaticPauseMaxMs: 900,
  firstHookMaxMs: 1000,
};

const subject = {
  minTrackingConfidence: 0.8,
  maxJitterPx: 6,
  maxMatteChatterRatio: 0.02,
  maxEdgeHaloPx: 3,
};

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

const profileDefinitions = {
  "vertical-short-v1": {
    id: "vertical-short-v1",
    version: 1,
    modality: "video",
    policyVersion: "bizibeast-v1",
    video: {width: 1080, height: 1920, fpsNumerator: 30, fpsDenominator: 1, ...videoDelivery},
    audio,
    captions,
    pacing,
    subject,
  },
  "project-video-v1": {
    id: "project-video-v1",
    version: 1,
    modality: "video",
    policyVersion: "bizibeast-v1",
    audio,
    captions,
    subject,
  },
  "carousel-paired-v1": {
    id: "carousel-paired-v1",
    version: 1,
    modality: "carousel",
    policyVersion: "bizibeast-v1",
    carousel: {
      formats: {
        "4:5": {width: 1080, height: 1350},
        "1:1": {width: 1080, height: 1080},
      },
      fileType: "png",
      colorProfile: "sRGB",
      minSlides: 6,
      maxSlides: 8,
      requirePairedFormats: true,
      requireCompleteContactSheet: true,
    },
  },
};

export const TECHNICAL_PROFILES = deepFreeze(profileDefinitions);

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

function rational(numerator, denominator) {
  const divisor = gcd(numerator, denominator);
  return {fpsNumerator: numerator / divisor, fpsDenominator: denominator / divisor};
}

function resolveFps(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) throw new Error("Project video fps must be positive");
    const text = String(value);
    if (/^\d+$/u.test(text)) return {fpsNumerator: value, fpsDenominator: 1};
    const [, whole, fraction] = text.match(/^(\d+)\.(\d+)$/u) ?? [];
    if (!fraction) throw new Error("Project video fps must be a positive integer or rational");
    return rational(Number(`${whole}${fraction}`), 10 ** fraction.length);
  }
  if (typeof value === "string") {
    const match = value.match(/^([1-9]\d*)\/([1-9]\d*)$/u);
    if (!match) throw new Error("Project video fps must be a positive integer or rational");
    return rational(Number(match[1]), Number(match[2]));
  }
  if (value && typeof value === "object"
    && Number.isInteger(value.numerator) && Number.isInteger(value.denominator)
    && value.numerator > 0 && value.denominator > 0) {
    return rational(value.numerator, value.denominator);
  }
  throw new Error("Project video fps must be a positive integer or rational");
}

function projectVideo(context) {
  const required = ["width", "height", "fps", "container"];
  if (!context || typeof context !== "object" || Array.isArray(context)
    || required.some((key) => !Object.hasOwn(context, key))) {
    throw new Error("Project video requires width, height, fps, and container overrides");
  }
  if (![context.width, context.height].every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error("Project video width and height must be positive integers");
  }
  if (!["mp4", "mov"].includes(context.container)) {
    throw new Error("Project video container must be mp4 or mov");
  }
  return {
    width: context.width,
    height: context.height,
    ...resolveFps(context.fps),
    container: context.container,
    ...videoDelivery,
  };
}

export function hashTechnicalProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new TypeError("Technical profile must be an object");
  }
  const {profileHash: ignored, ...profileWithoutHash} = profile;
  return sha256Value(profileWithoutHash);
}

export function resolveTechnicalProfile(profileId, context = {}) {
  if (typeof profileId !== "string" || !Object.hasOwn(TECHNICAL_PROFILES, profileId)) {
    throw new Error("Unknown or invalid technical profile ID");
  }
  const definition = TECHNICAL_PROFILES[profileId];

  const profile = structuredClone(definition);
  if (profileId === "project-video-v1") {
    profile.video = projectVideo(context);
    if (context.aggressiveShortForm === true) profile.pacing = structuredClone(pacing);
  }
  profile.profileHash = hashTechnicalProfile(profile);
  return deepFreeze(profile);
}
