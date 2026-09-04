import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp, readFile, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {createProject} from "../src/project.mjs";
import {runQc} from "../src/qc.mjs";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ["ignore", "pipe", "pipe"]});
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed: ${stderr}`)));
  });
}

async function setup(name = "QC Test") {
  const root = await mkdtemp(join(tmpdir(), "content-hub-qc-"));
  const {projectDir} = await createProject(root, {name, editors: ["premiere"]});
  return {root, projectDir};
}

async function makeFixture(path, {audio = true} = {}) {
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
  ];
  if (audio) args.push("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000");
  args.push("-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (audio) args.push("-c:a", "aac", "-shortest");
  args.push("-y", path);
  await run("ffmpeg", args);
}

test("QC accepts a decodable AV master and writes durable evidence", async () => {
  const {projectDir} = await setup();
  const fixture = join(projectDir, "Final", "Masters", "valid.mp4");
  await makeFixture(fixture);
  const manifestBefore = await readFile(join(projectDir, "project.yaml"), "utf8");

  const report = await runQc(projectDir, fixture);

  assert.equal(report.pass, true);
  assert.deepEqual(report.streams, {video: 1, audio: 1});
  assert.equal(report.decode.pass, true);
  assert.ok(report.durationSeconds >= 1.9 && report.durationSeconds <= 2.1);
  assert.equal((await stat(join(projectDir, report.files.json))).isFile(), true);
  assert.equal((await stat(join(projectDir, report.files.markdown))).isFile(), true);
  assert.equal((await stat(join(projectDir, report.files.contactSheet))).isFile(), true);
  assert.equal(await readFile(join(projectDir, "project.yaml"), "utf8"), manifestBefore);
});

test("QC rejects a master without audio", async () => {
  const {projectDir} = await setup("Video Only");
  const fixture = join(projectDir, "Final", "Masters", "video-only.mp4");
  await makeFixture(fixture, {audio: false});

  const report = await runQc(projectDir, fixture);

  assert.equal(report.pass, false);
  assert.ok(report.issues.some(({code}) => code === "missing_audio"));
});

test("QC rejects overlapping or out-of-bounds captions", async () => {
  const {projectDir} = await setup("Caption Failure");
  const fixture = join(projectDir, "Final", "Masters", "captions.mp4");
  await makeFixture(fixture);
  await writeFile(join(projectDir, "Renders", "Captions", "captions.json"), JSON.stringify([
    {start: 0.2, end: 1.2, text: "First"},
    {start: 1.0, end: 2.4, text: "Second"},
  ]));

  const report = await runQc(projectDir, fixture);

  assert.equal(report.pass, false);
  assert.ok(report.issues.some(({code}) => code === "caption_overlap"));
  assert.ok(report.issues.some(({code}) => code === "caption_out_of_bounds"));
  assert.match(await readFile(join(projectDir, report.files.markdown), "utf8"), /caption_overlap/);
});
