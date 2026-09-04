#!/usr/bin/env node
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {parseArgs, print} from "./args.mjs";

const DIRECTORIES = Object.freeze([
  "Source",
  "Assets/Images",
  "Assets/Music",
  "Assets/SFX",
  "Assets/Fonts",
  "Assets/LUTs",
  "Premiere",
  "HyperFrames",
  "Plans",
  "Renders",
  "QC",
  "Final"
]);

function slugify(name) {
  const slug = name.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  if (!slug) throw new Error("Project name must contain a letter or number");
  return slug;
}

export async function createProject({name, root = path.resolve("Projects"), mode = "crew"}) {
  if (!new Set(["quick", "crew", "strict"]).has(mode)) throw new Error("Mode must be quick, crew, or strict");
  const slug = slugify(name);
  const projectPath = path.join(path.resolve(root), slug);
  try {
    await mkdir(projectPath, {recursive: false});
  } catch (error) {
    if (error.code === "ENOENT") {
      await mkdir(path.dirname(projectPath), {recursive: true});
      await mkdir(projectPath, {recursive: false});
    } else if (error.code === "EEXIST") {
      throw new Error(`Project already exists: ${projectPath}`);
    } else throw error;
  }
  for (const directory of DIRECTORIES) await mkdir(path.join(projectPath, directory), {recursive: true});
  const manifest = {
    schemaVersion: 1,
    name,
    slug,
    mode,
    localOnly: true,
    finalAssembler: "premiere",
    motionSystem: "hyperframes",
    createdAt: new Date().toISOString()
  };
  await writeFile(path.join(projectPath, "project.json"), `${JSON.stringify(manifest, null, 2)}\n`, {flag: "wx"});
  await writeFile(path.join(projectPath, "README.md"), `# ${name}\n\nSource media stays in Source/. Passing exports go in Final/.\n`, {flag: "wx"});
  return {path: projectPath, slug, mode, directories: DIRECTORIES};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const {flags, positional} = parseArgs(process.argv.slice(2));
  try {
    if (positional.length !== 1) throw new Error("Usage: new-project.mjs <name> [--root Projects] [--mode crew|quick|strict] [--json]");
    print(await createProject({name: positional[0], root: flags.root, mode: flags.mode}), flags.json);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
