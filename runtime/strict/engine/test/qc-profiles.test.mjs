import assert from "node:assert/strict";
import test from "node:test";

import {hashTechnicalProfile, resolveTechnicalProfile} from "../src/qc-profiles.mjs";

test("vertical short profile freezes the spec pacing and delivery facts", () => {
  const profile = resolveTechnicalProfile("vertical-short-v1");
  assert.deepEqual(profile.video, {
    width: 1080, height: 1920, fpsNumerator: 30, fpsDenominator: 1,
    allowedContainers: ["mp4", "mov"], fullDecodeRequired: true,
  });
  assert.deepEqual(profile.audio, {
    sampleRate: 48000, allowedChannels: [1, 2], integratedLufsTarget: -14,
    integratedLufsTolerance: 2, truePeakMaxDb: -1,
  });
  assert.deepEqual(profile.pacing, {
    candidateGapMs: 240, compressedGapMinMs: 120, compressedGapMaxMs: 140,
    speechHandleMs: 40, dramaticPauseMinMs: 450, dramaticPauseMaxMs: 900,
    firstHookMaxMs: 1000,
  });
  assert.equal(profile.captions.lowerReservePx, 420);
  assert.match(profile.profileHash, /^[a-f0-9]{64}$/u);
});

test("project video overrides are explicit and hash-changing", () => {
  const a = resolveTechnicalProfile("project-video-v1", {width: 1920, height: 1080, fps: 25, container: "mov"});
  const b = resolveTechnicalProfile("project-video-v1", {width: 1920, height: 1080, fps: 30, container: "mov"});
  assert.notEqual(a.profileHash, b.profileHash);
  assert.throws(() => resolveTechnicalProfile("project-video-v1", {width: 1920}), /width, height, fps, and container/i);
});

test("project video resolves a positive rational frame rate", () => {
  const profile = resolveTechnicalProfile("project-video-v1", {
    width: 1920, height: 1080, fps: "30000/1001", container: "mp4",
  });
  assert.deepEqual(profile.video, {
    width: 1920, height: 1080, fpsNumerator: 30000, fpsDenominator: 1001,
    container: "mp4", allowedContainers: ["mp4", "mov"], fullDecodeRequired: true,
  });
});

test("project video adds aggressive pacing only when requested", () => {
  assert.equal(resolveTechnicalProfile("project-video-v1", {
    width: 1920, height: 1080, fps: 25, container: "mov",
  }).pacing, undefined);
  assert.deepEqual(resolveTechnicalProfile("project-video-v1", {
    width: 1920, height: 1080, fps: 25, container: "mov", aggressiveShortForm: true,
  }).pacing, resolveTechnicalProfile("vertical-short-v1").pacing);
});

test("project video rejects invalid or partial overrides", () => {
  for (const context of [
    {width: 1920, height: 1080, fps: 0, container: "mp4"},
    {width: 1920, height: 1080, fps: -1, container: "mp4"},
    {width: 1920, height: 1080, fps: "30000/0", container: "mp4"},
    {width: 1920, height: 1080, fps: "0/1", container: "mp4"},
    {width: 1920, height: 1080, fps: "30000/1001/2", container: "mp4"},
    {width: 1920, height: 1080, fps: "29.97", container: "mp4"},
    {width: 1920, height: 1080, fps: 30},
    {width: 1920, height: 1080, container: "mp4"},
  ]) assert.throws(() => resolveTechnicalProfile("project-video-v1", context));
});

test("profiles are deeply frozen and hash excludes profileHash", () => {
  const profile = resolveTechnicalProfile("vertical-short-v1");
  assert.equal(Object.isFrozen(profile), true);
  assert.equal(Object.isFrozen(profile.video), true);
  assert.equal(Object.isFrozen(profile.video.allowedContainers), true);
  assert.equal(hashTechnicalProfile(profile), profile.profileHash);
  assert.throws(() => { profile.video.width = 1; }, TypeError);
});

test("paired carousel profile freezes both required formats", () => {
  const profile = resolveTechnicalProfile("carousel-paired-v1");
  assert.deepEqual(profile.carousel, {
    formats: {"4:5": {width: 1080, height: 1350}, "1:1": {width: 1080, height: 1080}},
    fileType: "png", colorProfile: "sRGB", minSlides: 6, maxSlides: 8,
    requirePairedFormats: true, requireCompleteContactSheet: true,
  });
  assert.equal(profile.profileHash, hashTechnicalProfile(profile));
});

test("rejects adversarial and non-string profile IDs with the documented error", () => {
  for (const profileId of ["__proto__", "constructor", "toString", "", 1, null, {}, Symbol("profile")]) {
    assert.throws(
      () => resolveTechnicalProfile(profileId),
      /unknown|invalid.*profile/i,
    );
  }
});

test("identical project contexts produce identical hashes", () => {
  const context = {width: 1920, height: 1080, fps: 25, container: "mov"};
  assert.equal(
    resolveTechnicalProfile("project-video-v1", context).profileHash,
    resolveTechnicalProfile("project-video-v1", {...context}).profileHash,
  );
});

test("project dimensions and container remain hash-bound", () => {
  const context = {width: 1920, height: 1080, fps: 25, container: "mov"};
  const baseline = resolveTechnicalProfile("project-video-v1", context).profileHash;
  for (const change of [
    {width: 1080, height: 1080, fps: 25, container: "mov"},
    {width: 1920, height: 1200, fps: 25, container: "mov"},
    {width: 1920, height: 1080, fps: 25, container: "mp4"},
  ]) assert.notEqual(resolveTechnicalProfile("project-video-v1", change).profileHash, baseline);
});

test("equivalent rational FPS values reduce to one stable profile", () => {
  const a = resolveTechnicalProfile("project-video-v1", {
    width: 1920, height: 1080, fps: "30/1", container: "mov",
  });
  const b = resolveTechnicalProfile("project-video-v1", {
    width: 1920, height: 1080, fps: "60/2", container: "mov",
  });
  assert.deepEqual(a.video, b.video);
  assert.equal(a.profileHash, b.profileHash);
});

test("nested profile thresholds are recursively frozen", () => {
  const video = resolveTechnicalProfile("vertical-short-v1");
  const carousel = resolveTechnicalProfile("carousel-paired-v1");
  for (const value of [
    video.audio,
    video.audio.allowedChannels,
    video.captions,
    carousel.carousel,
    carousel.carousel.formats,
    carousel.carousel.formats["4:5"],
  ]) assert.equal(Object.isFrozen(value), true);
});
