import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdtemp, mkdir, readFile, realpath, symlink, unlink} from "node:fs/promises";
import {promisify} from "node:util";
import {join} from "node:path";
import {tmpdir} from "node:os";
import test from "node:test";

import {chooseShotCaptionAnchor, retimeStoryWords} from "../src/caption-placement.mjs";

const run = promisify(execFile);

test("chooses one face-safe anchor for an entire shot above the 420px reserve", () => {
  const placement = chooseShotCaptionAnchor({
    frameSize: {width: 1080, height: 1920},
    shot: {id: "shot-01", startMs: 0, endMs: 2_000, faceAwareRequired: true},
    avoidRegions: [
      {timeMs: 0, box: {x: 380, y: 980, width: 320, height: 420}},
      {timeMs: 1_800, box: {x: 400, y: 960, width: 300, height: 440}},
    ],
    captionSize: {width: 900, height: 220},
  });

  assert.equal(placement.fixedWithinShot, true);
  assert.equal(placement.shotId, "shot-01");
  assert.ok(placement.y + placement.height <= 1_500);
  assert.ok(placement.maximumAvoidOverlapRatio <= 0.1);
});

test("blocks required face-aware placement but records the optional fixed-anchor deviation", () => {
  const input = {
    frameSize: {width: 1080, height: 1920},
    shot: {id: "shot-01", startMs: 0, endMs: 2_000, faceAwareRequired: true},
    avoidRegions: [{timeMs: 100, box: {x: 0, y: 0, width: 1080, height: 1500}}],
    captionSize: {width: 900, height: 220},
  };

  assert.throws(() => chooseShotCaptionAnchor(input), /No face-safe caption anchor/u);
  const optional = chooseShotCaptionAnchor({...input, shot: {...input.shot, faceAwareRequired: false}});
  assert.equal(optional.deviation, "fixed-best-anchor");
});

test("retimes only story-selected source words after approved silence removals", () => {
  const words = retimeStoryWords({
    segments: [{id: "shot-01", sourceId: "source-a", sourceInMs: 0, sourceOutMs: 2_000, timelineInMs: 100,
      firstWordId: "source-a:w000001", lastWordId: "source-a:w000002"}],
    transcripts: [{sourceId: "source-a", words: [
      {id: "source-a:w000001", text: "First", startMs: 100, endMs: 300},
      {id: "source-a:w000002", text: "second", startMs: 1_200, endMs: 1_500},
      {id: "source-a:w000003", text: "unused", startMs: 1_600, endMs: 1_800},
    ]}],
    silencePlan: [{sourceId: "source-a", silencePlan: {operations: [{kind: "compress-gap", removeStartMs: 500, removeEndMs: 1_000}]}}],
  });

  assert.deepEqual(words.map(({id, startMs, endMs, shotId}) => ({id, startMs, endMs, shotId})), [
    {id: "source-a:w000001", startMs: 200, endMs: 400, shotId: "shot-01"},
    {id: "source-a:w000002", startMs: 800, endMs: 1_100, shotId: "shot-01"},
  ]);
});

test("builds a decodable alpha ProRes sidecar and rejects a symlinked matte directory", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "content-hub-foreground-")));
  const source = join(root, "source.mp4");
  const mattes = join(root, "mattes");
  const output = join(root, "foreground.mov");
  await mkdir(mattes);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=blue:s=64x96:r=30:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", source]);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=white:s=64x96:r=30:d=1", "-frames:v", "30", "-start_number", "0", "-y", join(mattes, "%06d.png")]);

  await run("zsh", ["scripts/video/build-foreground-sidecar.sh", source, mattes, "30", output], {cwd: process.cwd()});
  const {stdout} = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,pix_fmt,width,height", "-of", "json", output]);
  assert.deepEqual(JSON.parse(stdout).streams[0], {codec_name: "prores", pix_fmt: "yuva444p12le", width: 64, height: 96});
  const {stdout: metadata} = await run("ffprobe", ["-v", "error", "-show_entries", "format_tags=content_hub_source_sha256,content_hub_matte_sha256", "-of", "json", output]);
  assert.match(JSON.parse(metadata).format.tags.content_hub_source_sha256, /^[a-f0-9]{64}$/u);
  assert.match(JSON.parse(metadata).format.tags.content_hub_matte_sha256, /^[a-f0-9]{64}$/u);

  const linked = join(root, "linked-mattes");
  await symlink(mattes, linked);
  await assert.rejects(run("zsh", ["scripts/video/build-foreground-sidecar.sh", source, linked, "30", join(root, "bad.mov")], {cwd: process.cwd()}), /symlink/u);
  await unlink(join(mattes, "000029.png"));
  await assert.rejects(run("zsh", ["scripts/video/build-foreground-sidecar.sh", source, mattes, "30", join(root, "short.mov")], {cwd: process.cwd()}), /frame count|contiguous/u);
  const blackMattes = join(root, "black-mattes");
  await mkdir(blackMattes);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=black:s=64x96:r=30:d=1", "-frames:v", "30", "-start_number", "0", "-y", join(blackMattes, "%06d.png")]);
  await assert.rejects(run("zsh", ["scripts/video/build-foreground-sidecar.sh", source, blackMattes, "30", join(root, "black.mov")], {cwd: process.cwd()}), /alpha/u);
});

test("keeps caption placements on a non-animated anchor layer", async () => {
  const template = await readFile("Templates/HyperFrames/content-hub-pack/compositions/animated-captions-portrait.html", "utf8");
  assert.match(template, /caption-anchor/u);
  assert.match(template, /anchor\.style\.left = `\$\{placement\.x\}px`/u);
  assert.match(template, /anchor\.style\.height = `\$\{placement\.height\}px`/u);
  assert.match(template, /anchor\.appendChild\(cue\)/u);
  assert.match(template, /"editorial-pair", "karaoke-pair"/u);
});

test("keeps legacy caption styles while advertising all frozen Sunburst identities", async () => {
  const catalog = JSON.parse(await readFile("Templates/catalog.json", "utf8"));
  const captions = catalog.templates.find(({id}) => id === "animated-captions-portrait");
  assert.deepEqual(captions.styles, ["clean", "karaoke", "punch", "editorial-pair", "karaoke-pair"]);
});
