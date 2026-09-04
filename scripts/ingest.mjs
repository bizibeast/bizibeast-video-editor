#!/usr/bin/env node
import {constants as fsConstants} from "node:fs";
import {copyFile, mkdir, readFile, realpath, writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";
import {parseArgs, print} from "./args.mjs";

const DESTINATIONS = Object.freeze({source: "Source", image: "Assets/Images", music: "Assets/Music", sfx: "Assets/SFX", font: "Assets/Fonts", lut: "Assets/LUTs"});
const digest = (data) => createHash("sha256").update(data).digest("hex");

export async function ingest(project, source, {kind = "source", licence = null} = {}) {
  if (!DESTINATIONS[kind]) throw new Error(`Unknown ingest kind: ${kind}`);
  const projectRoot = await realpath(path.resolve(project));
  const sourcePath = await realpath(path.resolve(source));
  const sourceBytes = await readFile(sourcePath);
  const directory = path.join(projectRoot, DESTINATIONS[kind]);
  const target = path.join(directory, path.basename(sourcePath));
  await mkdir(directory, {recursive: true});
  await copyFile(sourcePath, target, fsConstants.COPYFILE_EXCL);
  const copiedBytes = await readFile(target);
  if (digest(sourceBytes) !== digest(copiedBytes)) throw new Error("Copied media hash mismatch");
  const record = {schemaVersion: 1, kind, sourceName: path.basename(sourcePath), path: path.relative(projectRoot, target), sha256: digest(copiedBytes), bytes: copiedBytes.length, licence};
  const records = path.join(projectRoot, "Plans", "ingest");
  await mkdir(records, {recursive: true});
  await writeFile(path.join(records, `${record.sha256}.json`), `${JSON.stringify(record, null, 2)}\n`, {flag: "wx"});
  return {...record, path: target};
}

const {flags, positional} = parseArgs(process.argv.slice(2));
if (process.argv[1]?.endsWith("ingest.mjs")) {
  try {
    if (positional.length !== 2) throw new Error("Usage: ingest.mjs <project> <file> --kind source|image|music|sfx|font|lut [--licence text] [--json]");
    print(await ingest(positional[0], positional[1], {kind: flags.kind, licence: flags.licence}), flags.json);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
