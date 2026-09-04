#!/usr/bin/env node
import {execFile} from "node:child_process";
import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {promisify} from "node:util";
import {parseArgs, print} from "./args.mjs";

const exec = promisify(execFile);

export async function qc(file, {dryRun = false, report, profile = "vertical", captions: captionFile} = {}) {
  if (!file) throw new Error("Usage: qc.mjs <video> [--profile vertical|any] [--report report.json] [--dry-run] [--json]");
  const target = path.resolve(file);
  const commands = [
    ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", target],
    ["ffmpeg", "-v", "error", "-i", target, "-f", "null", "-"],
    ["ffmpeg", "-v", "info", "-i", target, "-vf", "blackdetect=d=0.5:pix_th=0.10", "-af", "silencedetect=n=-50dB:d=1.5", "-f", "null", "-"],
    ["ffmpeg", "-v", "info", "-i", target, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"]
  ];
  if (dryRun) return {target, commands};
  const probe = JSON.parse((await exec(commands[0][0], commands[0].slice(1), {maxBuffer: 4_000_000})).stdout);
  await exec(commands[1][0], commands[1].slice(1), {maxBuffer: 4_000_000});
  const anomalyLog = (await exec(commands[2][0], commands[2].slice(1), {maxBuffer: 8_000_000})).stderr;
  const loudnessLog = (await exec(commands[3][0], commands[3].slice(1), {maxBuffer: 8_000_000})).stderr;
  const video = probe.streams.find(({codec_type: type}) => type === "video");
  const audio = probe.streams.find(({codec_type: type}) => type === "audio");
  const fpsParts = String(video?.avg_frame_rate || "0/1").split("/").map(Number);
  const fps = fpsParts[1] ? fpsParts[0] / fpsParts[1] : 0;
  const blackSeconds = [...anomalyLog.matchAll(/black_duration:([0-9.]+)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
  const silenceSeconds = [...anomalyLog.matchAll(/silence_duration: ([0-9.]+)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
  const loudnessMatch = loudnessLog.match(/\{\s*"input_i"[\s\S]*?\}/g)?.at(-1);
  let loudness = null;
  try { loudness = JSON.parse(loudnessMatch); } catch {}
  const checks = [
    {name: "video-stream", ok: Boolean(video)},
    {name: "positive-duration", ok: Number(probe.format?.duration) > 0},
    {name: "audio-stream", ok: Boolean(audio)},
    {name: "codec", ok: ["h264", "hevc", "prores", "vp9", "av1"].includes(video?.codec_name), value: video?.codec_name},
    {name: "frame-rate", ok: fps >= 23 && fps <= 61, value: fps},
    {name: "audio-sample-rate", ok: Number(audio?.sample_rate) >= 44_100, value: Number(audio?.sample_rate || 0)},
    {name: "vertical-1080x1920", ok: profile === "any" || (video?.width === 1080 && video?.height === 1920)},
    {name: "black-frames", ok: blackSeconds < 0.5, value: blackSeconds},
    {name: "long-silence", ok: silenceSeconds < 1.5, value: silenceSeconds},
    {name: "integrated-loudness", ok: loudness ? Number(loudness.input_i) >= -30 && Number(loudness.input_i) <= -8 : false, value: loudness?.input_i ?? null},
    {name: "true-peak", ok: loudness ? Number(loudness.input_tp) <= 0 : false, value: loudness?.input_tp ?? null}
  ];
  if (captionFile) {
    const captions = JSON.parse(await readFile(path.resolve(captionFile), "utf8"));
    let previousEnd = 0;
    const valid = Array.isArray(captions.segments) && captions.segments.every((segment) => {
      const ok = Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.start >= previousEnd && segment.end > segment.start && segment.end <= Number(probe.format.duration);
      previousEnd = segment.end;
      return ok;
    });
    checks.push({name: "caption-timing", ok: valid});
  }
  const result = {ok: checks.every(({ok}) => ok), target, checks, analysis: {blackSeconds, silenceSeconds, loudness}, probe};
  if (report) await writeFile(path.resolve(report), `${JSON.stringify(result, null, 2)}\n`, {flag: "wx"});
  return result;
}

const {flags, positional} = parseArgs(process.argv.slice(2));
try {
  const result = await qc(positional[0], {dryRun: Boolean(flags["dry-run"]), report: flags.report, profile: flags.profile, captions: flags.captions});
  print(result, flags.json);
  if (!flags["dry-run"] && !result.ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
