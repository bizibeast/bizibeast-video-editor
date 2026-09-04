import assert from "node:assert/strict";
import {mkdtemp, readFile, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import * as captions from "../src/captions.mjs";
import {createProject} from "../src/project.mjs";

const {buildCaptionBundle, writeCaptionBundle} = captions;

const tokens = `[8]{confidence:float,duration:float,end:float,start:float,text:string}
1,0.10,0.10,0.00, C
1,0.10,0.20,0.10,ont
1,0.10,0.30,0.20,ent
1,0.20,0.50,0.30, Hub
1,0.20,0.70,0.50, works
1,0.20,0.90,0.70, loc
1,0.20,1.10,0.90,ally
1,0.10,1.20,1.10,.`;

test("exports the canonical Parakeet word parser for transcript artifacts", () => {
  assert.equal(typeof captions.extractWords, "function");
  assert.deepEqual(captions.extractWords({sentences: [{tokens}]}).map(({text, start, end}) => ({text, start, end})), [
    {text: "Content", start: 0, end: 0.3},
    {text: "Hub", start: 0.3, end: 0.5},
    {text: "works", start: 0.5, end: 0.7},
    {text: "locally.", start: 0.7, end: 1.2},
  ]);
});

test("builds word-timed cues from Parakeet's typed token table", () => {
  const bundle = buildCaptionBundle({sentences: [{text: "Content Hub works locally.", start: 0, end: 1.2, tokens}]}, {maxWords: 3});

  assert.deepEqual(bundle.segments.map(({text}) => text), ["Content Hub works", "locally."]);
  assert.deepEqual(bundle.segments.flatMap(({words}) => words.map(({text}) => text)), ["Content", "Hub", "works", "locally."]);
  assert.equal(bundle.durationSeconds, 1.2);
});

test("defaults captions to 42 characters", () => {
  const transcript = {words: [
    {text: "One", start: 0, end: 0.1}, {text: "two", start: 0.1, end: 0.2}, {text: "three", start: 0.2, end: 0.3},
    {text: "four", start: 0.3, end: 0.4}, {text: "five", start: 0.4, end: 0.5}, {text: "six", start: 0.5, end: 0.6},
    {text: "seven", start: 0.6, end: 0.7}, {text: "eight", start: 0.7, end: 0.8},
  ]};

  assert.deepEqual(buildCaptionBundle(transcript, {maxWords: 8}).segments.map(({text}) => text), ["One two three four five six seven eight"]);
});

test("assigns stable display roles before paired-caption rendering", () => {
  assert.equal(typeof captions.applyCaptionAnchorPlan, "function");
  const base = buildCaptionBundle({sentences: [{text: "Content Hub works locally.", start: 0, end: 1.2, tokens}]}, {maxWords: 5, maxChars: 42});
  const paired = captions.applyCaptionAnchorPlan(base, {segments: [{cueIndex: 0, wordIndices: [1]}]});

  assert.deepEqual(paired.segments[0].words.map(({fontRole}) => fontRole), ["body", "display", "body", "body"]);
  assert.throws(
    () => captions.applyCaptionAnchorPlan(base, {segments: [{cueIndex: 0, wordIndices: [0, 1, 2]}]}),
    /at most two display words/u,
  );
  assert.throws(
    () => captions.applyCaptionAnchorPlan(base, {segments: [{cueIndex: 0, wordIndices: [4]}]}),
    /invalid anchor word index/u,
  );
});

test("rejects invalid and duplicate caption cue anchors", () => {
  const base = buildCaptionBundle({sentences: [{text: "Content Hub works locally.", start: 0, end: 1.2, tokens}]}, {maxWords: 5});

  assert.throws(
    () => captions.applyCaptionAnchorPlan(base, {segments: [{cueIndex: 1, wordIndices: [0]}]}),
    /invalid anchor cue index/u,
  );
  assert.throws(
    () => captions.applyCaptionAnchorPlan(base, {segments: [{cueIndex: 0.5, wordIndices: [0]}]}),
    /invalid anchor cue index/u,
  );
  assert.throws(
    () => captions.applyCaptionAnchorPlan(base, {segments: [
      {cueIndex: 0, wordIndices: [0]},
      {cueIndex: 0, wordIndices: [1]},
    ]}),
    /duplicate anchor cue index/u,
  );
});

test("punch requires an explicit 1-3 word display hook plus body support in every cue", () => {
  const base = buildCaptionBundle({sentences: [{text: "Content Hub works locally.", start: 0, end: 1.2, tokens}]}, {maxWords: 5});

  assert.throws(() => captions.applyCaptionAnchorPlan(base, undefined, {style: "punch"}), /Punch requires an explicit anchor plan/u);
  assert.throws(
    () => captions.applyCaptionAnchorPlan(base, {segments: [{cueIndex: 0, wordIndices: []}]}, {style: "punch"}),
    /1-3 display words/u,
  );
  assert.throws(
    () => captions.applyCaptionAnchorPlan(base, {segments: [{cueIndex: 0, wordIndices: [0, 1, 2, 3]}]}, {style: "punch"}),
    /1-3 display words/u,
  );
  assert.throws(
    () => captions.applyCaptionAnchorPlan(
      buildCaptionBundle({words: base.segments[0].words.slice(0, 3)}),
      {segments: [{cueIndex: 0, wordIndices: [0, 1, 2]}]},
      {style: "punch"},
    ),
    /body support word/u,
  );

  const punch = captions.applyCaptionAnchorPlan(base, {segments: [{cueIndex: 0, wordIndices: [0, 1, 2]}]}, {style: "punch"});
  assert.deepEqual(punch.segments[0].words.map(({fontRole}) => fontRole), ["display", "display", "display", "body"]);
});

test("writes one canonical JSON source plus Premiere and HyperFrames derivatives", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-captions-"));
  const {projectDir} = await createProject(root, {name: "Caption Test", editors: ["premiere"]});
  const transcript = join(projectDir, "Renders", "Captions", "parakeet.json");
  await writeFile(transcript, JSON.stringify({sentences: [{text: "Content Hub works locally.", start: 0, end: 1.2, tokens}]}));

  const result = await writeCaptionBundle(projectDir, transcript, {
    style: "punch",
    maxWords: 5,
    anchorPlan: {segments: [{cueIndex: 0, wordIndices: [0, 1, 2]}]},
  });
  const variables = JSON.parse(await readFile(join(projectDir, result.files.hyperframes), "utf8"));

  assert.equal(result.count, 1);
  assert.equal(variables.style, "punch");
  assert.equal(JSON.parse(variables.captions).segments.length, 1);
  assert.match(await readFile(join(projectDir, result.files.srt), "utf8"), /00:00:00,000 --> 00:00:01,200/u);
  assert.match(await readFile(join(projectDir, result.files.vtt), "utf8"), /^WEBVTT/u);
});

test("writes all four Sunburst caption identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-captions-"));
  const {projectDir} = await createProject(root, {name: "Caption Identities", editors: ["premiere"]});
  const transcriptPath = join(projectDir, "Renders", "Captions", "parakeet.json");
  await writeFile(transcriptPath, JSON.stringify({sentences: [{text: "Content Hub works locally.", start: 0, end: 1.2, tokens}]}));
  const anchorPlan = {segments: [{cueIndex: 0, wordIndices: [1]}]};

  for (const style of ["clean", "editorial-pair", "punch", "karaoke-pair"]) {
    const result = await writeCaptionBundle(projectDir, transcriptPath, {style, anchorPlan});
    assert.equal(result.style, style);
  }
});

test("punch rejects missing semantic anchors before writing derivatives", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-captions-"));
  const {projectDir} = await createProject(root, {name: "Punch Requires Anchors", editors: ["premiere"]});
  const transcriptPath = join(projectDir, "parakeet.json");
  await writeFile(transcriptPath, JSON.stringify({sentences: [{text: "Content Hub works locally.", start: 0, end: 1.2, tokens}]}));

  await assert.rejects(writeCaptionBundle(projectDir, transcriptPath, {style: "punch"}), /Punch requires an explicit anchor plan/u);
  await Promise.all(["captions.json", "captions.srt", "captions.vtt", "captions.hyperframes.json"].map((file) =>
    assert.rejects(readFile(join(projectDir, "Renders", "Captions", file)), {code: "ENOENT"}),
  ));
});

test("rejects an invalid anchor plan before writing derivatives", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-captions-"));
  const {projectDir} = await createProject(root, {name: "Caption Invalid Anchor", editors: ["premiere"]});
  const transcriptPath = join(projectDir, "parakeet.json");
  await writeFile(transcriptPath, JSON.stringify({sentences: [{text: "Content Hub works locally.", start: 0, end: 1.2, tokens}]}));

  await assert.rejects(
    writeCaptionBundle(projectDir, transcriptPath, {anchorPlan: {segments: [{cueIndex: 1, wordIndices: [0]}]}}),
    /invalid anchor cue index/u,
  );
  await Promise.all(["captions.json", "captions.srt", "captions.vtt", "captions.hyperframes.json"].map((file) =>
    assert.rejects(readFile(join(projectDir, "Renders", "Captions", file)), {code: "ENOENT"}),
  ));
});

test("normalizes the legacy karaoke identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-captions-"));
  const {projectDir} = await createProject(root, {name: "Caption Legacy", editors: ["premiere"]});
  const transcriptPath = join(projectDir, "Renders", "Captions", "parakeet.json");
  await writeFile(transcriptPath, JSON.stringify({sentences: [{text: "Content Hub works locally.", start: 0, end: 1.2, tokens}]}));

  const result = await writeCaptionBundle(projectDir, transcriptPath, {style: "karaoke"});

  assert.equal(result.style, "karaoke-pair");
});

test("binds each canonical cue to one fixed, face-safe story shot anchor", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-captions-"));
  const {projectDir} = await createProject(root, {name: "Caption Placement", editors: ["premiere"]});
  const transcriptPath = join(projectDir, "parakeet.json");
  const subjectMapPath = join(projectDir, "subject-map.json");
  await writeFile(transcriptPath, JSON.stringify({words: [
    {text: "Keep", start: 0, end: 0.3}, {text: "the", start: 0.3, end: 0.5}, {text: "face", start: 0.5, end: 0.8},
  ]}));
  await writeFile(subjectMapPath, JSON.stringify({frameSize: {width: 1080, height: 1920}, frames: [
    {timeMs: 0, faces: [{box: {x: 90, y: 150, width: 900, height: 400}}]},
    {timeMs: 700, faces: [{box: {x: 90, y: 150, width: 900, height: 400}}]},
  ]}));

  const result = await writeCaptionBundle(projectDir, transcriptPath, {
    subjectMapPath,
    shots: [{id: "shot-01", startMs: 0, endMs: 1_000, faceAwareRequired: true}],
  });
  const bundle = JSON.parse(await readFile(join(projectDir, result.files.json), "utf8"));

  assert.equal(bundle.segments[0].shotId, "shot-01");
  assert.equal(bundle.segments[0].placement.fixedWithinShot, true);
  assert.equal(bundle.segments[0].placement.anchorId, "lower-center");
  assert.ok(bundle.segments[0].placement.y + bundle.segments[0].placement.height <= 1_500);
});

test("rejects a symlinked subject map before using its placement data", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-captions-"));
  const {projectDir} = await createProject(root, {name: "Caption Symlink", editors: ["premiere"]});
  const transcriptPath = join(projectDir, "parakeet.json");
  const subjectMapPath = join(projectDir, "subject-map.json");
  const linkPath = join(projectDir, "linked-subject-map.json");
  await writeFile(transcriptPath, JSON.stringify({words: [{text: "Safe", start: 0, end: 0.4}]}));
  await writeFile(subjectMapPath, JSON.stringify({frameSize: {width: 1080, height: 1920}, frames: []}));
  await symlink(subjectMapPath, linkPath);

  await assert.rejects(
    writeCaptionBundle(projectDir, transcriptPath, {subjectMapPath: linkPath, shots: [{id: "shot-01", startMs: 0, endMs: 1_000}]}),
    /symlink/u,
  );
});

test("rejects a symlinked transcript before creating caption derivatives", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-captions-"));
  const {projectDir} = await createProject(root, {name: "Caption Transcript Symlink", editors: ["premiere"]});
  const transcriptPath = join(projectDir, "parakeet.json");
  const linkPath = join(projectDir, "linked-parakeet.json");
  const subjectMapPath = join(projectDir, "subject-map.json");
  await writeFile(transcriptPath, JSON.stringify({words: [{text: "Safe", start: 0, end: 0.4}]}));
  await writeFile(subjectMapPath, JSON.stringify({frameSize: {width: 1080, height: 1920}, frames: []}));
  await symlink(transcriptPath, linkPath);

  await assert.rejects(
    writeCaptionBundle(projectDir, linkPath, {subjectMapPath, shots: [{id: "shot-01", startMs: 0, endMs: 1_000}]}),
    /symlink/u,
  );
});
