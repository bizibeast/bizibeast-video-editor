#!/usr/bin/env node
import {execFile} from "node:child_process";
import {access, readdir} from "node:fs/promises";
import path from "node:path";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {parseArgs, print} from "./args.mjs";

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function exists(target) {
  try { await access(target); return true; } catch { return false; }
}

async function command(name) {
  try { return {ok: true, path: (await exec("which", [name])).stdout.trim()}; }
  catch { return {ok: false, path: null}; }
}

async function premiereInstalled() {
  if (process.platform !== "darwin") return {ok: false, path: null};
  try {
    const app = (await readdir("/Applications")).find((name) => /^Adobe Premiere Pro(?: |$)/.test(name));
    return {ok: Boolean(app), path: app ? path.join("/Applications", app) : null};
  } catch { return {ok: false, path: null}; }
}

export async function doctor({allowMissingEditor = false} = {}) {
  const ffmpeg = await command("ffmpeg");
  const ffprobe = await command("ffprobe");
  const premiere = await premiereInstalled();
  const required = [
    {name: "node", ok: Number(process.versions.node.split(".")[0]) >= 20, value: process.version},
    {name: "ffmpeg", ...ffmpeg},
    {name: "ffprobe", ...ffprobe}
  ];
  if (!allowMissingEditor) required.push({name: "premiere", ...premiere});
  const optional = [
    {name: "hyperframes-0.8.25", ok: await exists(path.join(repo, "node_modules/.bin/hyperframes"))},
    {name: "premiere-pro-mcp-1.14.5", ok: await exists(path.join(repo, "node_modules/.bin/premiere-pro-mcp"))},
    {name: "sunburst-fonts", ok: await exists(path.join(repo, "templates/hyperframes/assets/fonts/Fraunces.ttf"))},
    {name: "strict-runtime", ok: Boolean(process.env.BIZIBEAST_STRICT_RUNTIME)}
  ];
  return {ok: required.every(({ok}) => ok), required, optional, premiere};
}

const {flags} = parseArgs(process.argv.slice(2));
const result = await doctor({allowMissingEditor: Boolean(flags["allow-missing-editor"])});
print(result, flags.json);
if (!result.ok) process.exitCode = 1;
