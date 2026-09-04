#!/usr/bin/env node
import {constants as fsConstants} from "node:fs";
import {access} from "node:fs/promises";
import {spawn} from "node:child_process";
import path from "node:path";
import {parseArgs, print} from "./args.mjs";
import {prepareMediaJob, readJsonOutput} from "./media-adapter.mjs";

async function executable(name, env) {
  if (name.includes(path.sep)) {
    try { await access(path.resolve(name), fsConstants.X_OK); return path.resolve(name); } catch { return null; }
  }
  for (const directory of String(env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const target = path.join(directory, name);
    try { await access(target, fsConstants.X_OK); return target; } catch {}
  }
  return null;
}

function configured(env, key) {
  if (!env[key]) return null;
  let command;
  try { command = JSON.parse(env[key]); } catch { throw new Error(`${key} must be a JSON array`); }
  if (!Array.isArray(command) || !command.length || !command.includes("{input}") || !command.includes("{output}")) throw new Error(`${key} must be a JSON array containing {input} and {output}`);
  return command;
}

export async function detectTranscriber(env = process.env) {
  const explicit = configured(env, "BIZIBEAST_TRANSCRIBE_COMMAND");
  if (explicit) return await executable(explicit[0], env) ? explicit : null;
  for (const name of ["parakeet-mlx", "mlx_whisper", "whisper-cli"]) {
    const found = await executable(name, env);
    if (found) return {detected: found, requiresConfiguration: true};
  }
  return null;
}

export async function transcribe(input, output, env = process.env) {
  const command = configured(env, "BIZIBEAST_TRANSCRIBE_COMMAND");
  if (!command || !await executable(command[0], env)) throw new Error("No local transcriber configured. Set BIZIBEAST_TRANSCRIBE_COMMAND to a JSON argv array containing {input} and {output}.");
  const {source, target} = await prepareMediaJob(input, output);
  const args = command.slice(1).map((value) => value.replaceAll("{input}", source).replaceAll("{output}", target));
  await new Promise((resolve, reject) => {
    const child = spawn(command[0], args, {stdio: "inherit", env});
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Transcriber exited ${code}`)));
  });
  const transcript = await readJsonOutput(target, (value) => {
    const words = value.words || value.segments?.flatMap((segment) => segment.words || []) || [];
    if (!Array.isArray(words) || !words.length) throw new Error("Transcript output must contain timed words");
    let previousEnd = 0;
    for (const word of words) {
      const start = Number(word.start ?? word.start_time);
      const end = Number(word.end ?? word.end_time);
      if (!String(word.text ?? word.word ?? "").trim() || !Number.isFinite(start) || !Number.isFinite(end) || start < previousEnd || end <= start) throw new Error("Transcript words must have ordered timing and text");
      previousEnd = end;
    }
  }, "Transcriber");
  const words = transcript.words || transcript.segments.flatMap((segment) => segment.words || []);
  return {input: source, output: target, engine: command[0], words: words.length};
}

const {flags, positional} = parseArgs(process.argv.slice(2));
if (process.argv[1]?.endsWith("transcribe.mjs")) {
  try {
    if (flags.detect) print({engine: await detectTranscriber()}, flags.json);
    else {
      if (positional.length !== 2) throw new Error("Usage: transcribe.mjs <media> <transcript.json> [--json] or --detect");
      print(await transcribe(positional[0], positional[1]), flags.json);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
