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

async function output(bin, args) {
  try { return {ok: true, value: (await exec(bin, args, {env: {...process.env, DO_NOT_TRACK: "1"}})).stdout.trim()}; }
  catch (error) { return {ok: false, value: null, error: error.message}; }
}

async function premiereInstalled() {
  if (process.platform !== "darwin") return {ok: false, path: null};
  try {
    const app = (await readdir("/Applications")).find((name) => /^Adobe Premiere Pro(?: |$)/.test(name));
    return {ok: Boolean(app), path: app ? path.join("/Applications", app) : null};
  } catch { return {ok: false, path: null}; }
}

export async function doctor({allowMissingEditor = false, allowMissingFonts = false} = {}) {
  const ffmpeg = await command("ffmpeg");
  const ffprobe = await command("ffprobe");
  const premiere = await premiereInstalled();
  const hyperframesBin = path.join(repo, "node_modules/.bin/hyperframes");
  const premiereBin = path.join(repo, "node_modules/.bin/premiere-pro-mcp");
  const hyperframesVersion = await output(hyperframesBin, ["--version"]);
  const premiereVersion = await output(premiereBin, ["--version"]);
  const premiereDoctorOutput = await output(premiereBin, ["--doctor", "--json"]);
  let premiereDoctor = null;
  try { premiereDoctor = JSON.parse(premiereDoctorOutput.value); } catch {}
  const fontChecks = [
    {name: "archivo-font", ok: await exists(path.join(repo, "templates/hyperframes/assets/fonts/Archivo.ttf"))},
    {name: "fraunces-font", ok: await exists(path.join(repo, "templates/hyperframes/assets/fonts/Fraunces.ttf"))}
  ];
  const required = [
    {name: "node-22", ok: Number(process.versions.node.split(".")[0]) >= 22, value: process.version},
    {name: "ffmpeg", ...ffmpeg},
    {name: "ffprobe", ...ffprobe},
    {name: "hyperframes-0.8.25", ok: hyperframesVersion.ok && hyperframesVersion.value === "0.8.25", value: hyperframesVersion.value},
    {name: "premiere-pro-mcp-1.14.5", ok: premiereVersion.ok && premiereVersion.value === "1.14.5", value: premiereVersion.value},
    {name: "premiere-mcp-doctor", ok: allowMissingEditor ? Boolean(premiereDoctor?.schemaVersion) : premiereDoctor?.overall === "ready", value: premiereDoctor},
    {name: "sunburst-css", ok: await exists(path.join(repo, "templates/hyperframes/assets/sunburst.css"))},
    {name: "archivo-ofl", ok: await exists(path.join(repo, "templates/hyperframes/assets/fonts/OFL-Archivo.txt"))},
    {name: "fraunces-ofl", ok: await exists(path.join(repo, "templates/hyperframes/assets/fonts/OFL-Fraunces.txt"))}
  ];
  if (!allowMissingFonts) required.push(...fontChecks);
  if (!allowMissingEditor) required.push({name: "premiere", ...premiere});
  const optional = [
    ...fontChecks,
    {name: "strict-runtime-override", ok: Boolean(process.env.BIZIBEAST_STRICT_RUNTIME)}
  ];
  const installReady = required.every(({ok}) => ok);
  return {ok: installReady, installReady, liveConnected: false, liveNote: "Install checks cannot prove a live Premiere project or sequence; run scripts/premiere.mjs verify.", versions: {hyperframes: hyperframesVersion.value, premiereMcp: premiereVersion.value}, required, optional, premiere};
}

const {flags} = parseArgs(process.argv.slice(2));
const result = await doctor({allowMissingEditor: Boolean(flags["allow-missing-editor"]), allowMissingFonts: Boolean(flags["allow-missing-fonts"])});
print(result, flags.json);
if (!result.ok) process.exitCode = 1;
