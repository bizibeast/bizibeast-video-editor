#!/usr/bin/env node
import {constants as fsConstants} from "node:fs";
import {access} from "node:fs/promises";
import {spawn} from "node:child_process";
import path from "node:path";
import {parseArgs, print} from "./args.mjs";
import {prepareMediaJob, readJsonOutput} from "./media-adapter.mjs";

function configured(env) {
  if (!env.BIZIBEAST_SUBJECT_COMMAND) return null;
  let command;
  try { command = JSON.parse(env.BIZIBEAST_SUBJECT_COMMAND); } catch { throw new Error("BIZIBEAST_SUBJECT_COMMAND must be a JSON array"); }
  if (!Array.isArray(command) || !command.includes("{input}") || !command.includes("{output}")) throw new Error("BIZIBEAST_SUBJECT_COMMAND must contain {input} and {output}");
  return command;
}

export async function detectSubjectAnalyzer(env = process.env) {
  const command = configured(env);
  if (!command) return null;
  const candidates = command[0].includes(path.sep) ? [path.resolve(command[0])] : String(env.PATH || "").split(path.delimiter).map((dir) => path.join(dir, command[0]));
  for (const candidate of candidates) {
    try { await access(candidate, fsConstants.X_OK); return command; } catch {}
  }
  return null;
}

export async function analyzeSubject(input, output, env = process.env) {
  const command = await detectSubjectAnalyzer(env);
  if (!command) throw new Error("Subject analysis unavailable. Set BIZIBEAST_SUBJECT_COMMAND to a local JSON argv array with {input} and {output}; use face-safe foreground placement meanwhile.");
  const {source, target} = await prepareMediaJob(input, output);
  const args = command.slice(1).map((value) => value.replaceAll("{input}", source).replaceAll("{output}", target));
  await new Promise((resolve, reject) => {
    const child = spawn(command[0], args, {stdio: "inherit", env});
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Subject analyzer exited ${code}`)));
  });
  const subject = await readJsonOutput(target, (value) => {
    if (!Array.isArray(value.frames) || !value.frames.length) throw new Error("Subject map must contain frames");
    let previousTime = -1;
    for (const frame of value.frames) {
      if (!Number.isFinite(frame.timeMs) || frame.timeMs < previousTime || !Array.isArray(frame.boxes)) throw new Error("Subject-map frames must have ordered timeMs and boxes");
      previousTime = frame.timeMs;
      for (const box of frame.boxes) {
        if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0) throw new Error("Subject-map boxes must have positive finite geometry");
      }
    }
  }, "Subject analyzer");
  return {input: source, output: target, engine: command[0], frames: subject.frames.length};
}

const {flags, positional} = parseArgs(process.argv.slice(2));
if (process.argv[1]?.endsWith("subject-analysis.mjs")) {
  try {
    if (flags.detect) print({engine: await detectSubjectAnalyzer()}, flags.json);
    else {
      if (positional.length !== 2) throw new Error("Usage: subject-analysis.mjs <video> <subject-map.json> [--json] or --detect");
      print(await analyzeSubject(positional[0], positional[1]), flags.json);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
