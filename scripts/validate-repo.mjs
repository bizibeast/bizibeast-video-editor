#!/usr/bin/env node
import {readdir, readFile, stat} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = ["SKILL.md", "agents/openai.yaml", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "templates/hyperframes/compositions/title.html"];

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if ([".git", "node_modules", ".bizibeast"].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (target.endsWith(path.join("templates", "hyperframes", "assets", "fonts"))) continue;
    if (entry.isDirectory()) result.push(...await walk(target));
    else result.push(target);
  }
  return result;
}

for (const relative of required) await stat(path.join(root, relative));
const badExtensions = new Set([".mp4", ".mov", ".wav", ".mp3", ".ttf", ".otf", ".safetensors", ".ckpt"]);
for (const file of await walk(root)) {
  const relative = path.relative(root, file);
  if (badExtensions.has(path.extname(relative).toLowerCase())) throw new Error(`Generated or heavyweight file committed: ${relative}`);
  if ((await stat(file)).size > 2_000_000) throw new Error(`File is unexpectedly large: ${relative}`);
  if (/\.(md|mjs|json|ya?ml|html|css)$/.test(file) || file.endsWith("LICENSE")) {
    const body = await readFile(file, "utf8");
    const privateHome = new RegExp(`/${["Us", "ers"].join("")}/`);
    if (privateHome.test(body)) throw new Error(`Private absolute path found: ${relative}`);
  }
}
process.stdout.write("Repository validation passed.\n");
