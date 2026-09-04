#!/usr/bin/env node
import {execFile, spawn} from "node:child_process";
import {mkdir, readdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {parseArgs, print} from "./args.mjs";

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FONT_FILES = Object.freeze({
  "Archivo.ttf": "https://raw.githubusercontent.com/google/fonts/main/ofl/archivo/Archivo%5Bwdth%2Cwght%5D.ttf",
  "Fraunces.ttf": "https://raw.githubusercontent.com/google/fonts/main/ofl/fraunces/Fraunces%5BSOFT%2CWONK%2Copsz%2Cwght%5D.ttf",
  "OFL-Archivo.txt": "https://raw.githubusercontent.com/google/fonts/main/ofl/archivo/OFL.txt",
  "OFL-Fraunces.txt": "https://raw.githubusercontent.com/google/fonts/main/ofl/fraunces/OFL.txt"
});

async function commandPath(name) {
  try { return (await exec("which", [name])).stdout.trim() || null; } catch { return null; }
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {...options, stdio: "inherit"});
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

async function detectPremiere() {
  if (process.platform !== "darwin") return null;
  try {
    const apps = await readdir("/Applications");
    const name = apps.find((entry) => /^Adobe Premiere Pro(?: |$)/.test(entry));
    return name ? path.join("/Applications", name) : null;
  } catch { return null; }
}

async function downloadFonts() {
  const target = path.join(repo, "templates/hyperframes/assets/fonts");
  await mkdir(target, {recursive: true});
  for (const [name, url] of Object.entries(FONT_FILES)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Font download failed (${response.status}): ${url}`);
    await writeFile(path.join(target, name), Buffer.from(await response.arrayBuffer()));
  }
}

export async function setup({dryRun = false, install = false} = {}) {
  const mcpFor = (base) => ({
    mcpServers: {
      premiere: {
        command: path.join(base, "node_modules/.bin/premiere-pro-mcp"),
        env: {
          PREMIERE_MCP_CAPABILITIES: "inspect,edit,export,filesystem",
          PREMIERE_MCP_TRANSPORT: "stdio",
          DO_NOT_TRACK: "1"
        }
      }
    }
  });
  const result = {
    changed: false,
    versions: {hyperframes: "0.8.25", premiereMcp: "1.14.5"},
    commands: [["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"]],
    mcp: mcpFor(".")
  };
  if (dryRun) return result;
  if (install) {
    await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {cwd: repo});
    await downloadFonts();
    result.changed = true;
  }
  const configDirectory = path.join(repo, ".bizibeast");
  await mkdir(configDirectory, {recursive: true});
  const config = {
    schemaVersion: 1,
    localOnly: true,
    repo,
    premiereApplication: await detectPremiere(),
    ffmpeg: await commandPath("ffmpeg"),
    ffprobe: await commandPath("ffprobe"),
    hyperframes: path.join(repo, "node_modules/.bin/hyperframes"),
    premiereMcp: path.join(repo, "node_modules/.bin/premiere-pro-mcp")
  };
  await writeFile(path.join(configDirectory, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(path.join(configDirectory, "mcp.json"), `${JSON.stringify(mcpFor(repo), null, 2)}\n`);
  result.changed = true;
  result.config = config;
  return result;
}

const {flags} = parseArgs(process.argv.slice(2));
try {
  print(await setup({dryRun: Boolean(flags["dry-run"]), install: Boolean(flags.install)}), flags.json);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
