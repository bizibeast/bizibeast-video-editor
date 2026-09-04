#!/usr/bin/env node
import {execFile} from "node:child_process";
import {writeFile} from "node:fs/promises";
import path from "node:path";
import {promisify} from "node:util";
import {parseArgs, print} from "./args.mjs";

const exec = promisify(execFile);

export async function qc(file, {dryRun = false, report, profile = "vertical"} = {}) {
  if (!file) throw new Error("Usage: qc.mjs <video> [--profile vertical|any] [--report report.json] [--dry-run] [--json]");
  const target = path.resolve(file);
  const commands = [
    ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", target],
    ["ffmpeg", "-v", "error", "-i", target, "-f", "null", "-"]
  ];
  if (dryRun) return {target, commands};
  const probe = JSON.parse((await exec(commands[0][0], commands[0].slice(1), {maxBuffer: 4_000_000})).stdout);
  await exec(commands[1][0], commands[1].slice(1), {maxBuffer: 4_000_000});
  const video = probe.streams.find(({codec_type: type}) => type === "video");
  const audio = probe.streams.find(({codec_type: type}) => type === "audio");
  const checks = [
    {name: "video-stream", ok: Boolean(video)},
    {name: "positive-duration", ok: Number(probe.format?.duration) > 0},
    {name: "audio-stream", ok: Boolean(audio)},
    {name: "vertical-1080x1920", ok: profile === "any" || (video?.width === 1080 && video?.height === 1920)}
  ];
  const result = {ok: checks.every(({ok}) => ok), target, checks, probe};
  if (report) await writeFile(path.resolve(report), `${JSON.stringify(result, null, 2)}\n`, {flag: "wx"});
  return result;
}

const {flags, positional} = parseArgs(process.argv.slice(2));
try {
  const result = await qc(positional[0], {dryRun: Boolean(flags["dry-run"]), report: flags.report, profile: flags.profile});
  print(result, flags.json);
  if (!flags["dry-run"] && !result.ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
