#!/usr/bin/env node
import {access, readdir, readFile, realpath} from "node:fs/promises";
import {constants as fsConstants} from "node:fs";
import {createHash} from "node:crypto";
import path from "node:path";
import {parseArgs, print} from "./args.mjs";

async function walk(directory) {
  const files = [];
  try { await access(directory, fsConstants.R_OK); } catch { return files; }
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

export async function findAssets(project, {query = "", shared = process.env.BIZIBEAST_ASSET_LIBRARY} = {}) {
  const projectRoot = await realpath(path.resolve(project));
  const roots = [path.join(projectRoot, "Source"), path.join(projectRoot, "Assets")];
  if (shared) roots.push(await realpath(path.resolve(shared)));
  const needle = query.toLowerCase();
  const matches = [];
  for (const root of roots) {
    for (const file of await walk(root)) {
      if (needle && !path.basename(file).toLowerCase().includes(needle)) continue;
      const data = await readFile(file);
      matches.push({path: file, name: path.basename(file), bytes: data.length, sha256: createHash("sha256").update(data).digest("hex")});
    }
  }
  return matches.sort((a, b) => a.name.localeCompare(b.name));
}

const {flags, positional} = parseArgs(process.argv.slice(2));
if (process.argv[1]?.endsWith("find-assets.mjs")) {
  try {
    if (positional.length !== 1) throw new Error("Usage: find-assets.mjs <project> [--query text] [--shared path] [--json]");
    print(await findAssets(positional[0], {query: flags.query, shared: flags.shared}), flags.json);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
