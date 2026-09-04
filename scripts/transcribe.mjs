#!/usr/bin/env node
import {constants as fsConstants} from "node:fs";
import {access} from "node:fs/promises";
import {spawn} from "node:child_process";
import path from "node:path";
import {parseArgs, print} from "./args.mjs";

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
  const args = command.slice(1).map((value) => value.replaceAll("{input}", path.resolve(input)).replaceAll("{output}", path.resolve(output)));
  await new Promise((resolve, reject) => {
    const child = spawn(command[0], args, {stdio: "inherit", env});
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Transcriber exited ${code}`)));
  });
  return {input: path.resolve(input), output: path.resolve(output), engine: command[0]};
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
