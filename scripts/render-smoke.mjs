#!/usr/bin/env node
import {execFile} from "node:child_process";
import {mkdtemp, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {parseArgs, print} from "./args.mjs";

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseAlphaStats(log) {
  const mins = [...log.matchAll(/lavfi\.signalstats\.YMIN=([0-9.]+)/g)].map((match) => Number(match[1]));
  const maxes = [...log.matchAll(/lavfi\.signalstats\.YMAX=([0-9.]+)/g)].map((match) => Number(match[1]));
  const min = mins.length ? Math.min(...mins) : null;
  const max = maxes.length ? Math.max(...maxes) : null;
  return {min, max, varied: min !== null && max !== null && max - min > 100};
}

export async function renderSmoke({keep = false} = {}) {
  const work = await mkdtemp(path.join(os.tmpdir(), "bizibeast-render-smoke-"));
  const output = path.join(work, "captions.mov");
  const bin = path.join(repo, "node_modules/.bin/hyperframes");
  try {
    await exec(bin, ["render", "-c", "compositions/video-shot-layered-portrait.html", "-o", output, "--format", "mov", "--fps", "5", "--workers", "1", "--quality", "draft", "--strict-all", "--quiet"], {cwd: path.join(repo, "templates/hyperframes"), maxBuffer: 12_000_000});
    const probe = JSON.parse((await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,pix_fmt,width,height,duration", "-of", "json", output])).stdout).streams[0];
    const alphaLog = await exec("ffmpeg", ["-v", "info", "-i", output, "-vf", "alphaextract,signalstats,metadata=print", "-f", "null", "-"], {maxBuffer: 12_000_000});
    const alpha = parseAlphaStats(`${alphaLog.stdout}\n${alphaLog.stderr}`);
    if (probe.codec_name !== "prores" || !String(probe.pix_fmt).includes("a") || probe.width !== 1080 || probe.height !== 1920 || !alpha.varied) throw new Error(`Transparent render smoke failed: ${JSON.stringify({probe, alpha})}`);
    return {ok: true, probe, alpha, output: keep ? output : null};
  } finally {
    if (!keep) await rm(work, {recursive: true, force: true});
  }
}

const {flags} = parseArgs(process.argv.slice(2));
if (process.argv[1]?.endsWith("render-smoke.mjs")) renderSmoke({keep: Boolean(flags.keep)})
  .then((result) => print(result, flags.json))
  .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
