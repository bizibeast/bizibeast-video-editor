#!/usr/bin/env node
import {execFile} from "node:child_process";
import {mkdir} from "node:fs/promises";
import path from "node:path";
import {promisify} from "node:util";
import {parseArgs, print} from "./args.mjs";

const exec = promisify(execFile);
const {flags} = parseArgs(process.argv.slice(2));
const output = path.resolve(String(flags.output || "examples/sample-project/Source/generated-sample.mp4"));
const args = [
  "-y", "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30",
  "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000",
  "-t", "12", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "128k", "-shortest", output
];
try {
  await mkdir(path.dirname(output), {recursive: true});
  if (!flags["dry-run"]) await exec("ffmpeg", args, {maxBuffer: 4_000_000});
  print({output, durationSeconds: 12, command: ["ffmpeg", ...args], changed: !flags["dry-run"]}, flags.json);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
