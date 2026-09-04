import assert from "node:assert/strict";
import {readdir, readFile, stat} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function filesAt(directory) {
  const files = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if ([".git", "node_modules", ".bizibeast"].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (target.endsWith(path.join("templates", "hyperframes", "assets", "fonts"))) continue;
    if (entry.isDirectory()) files.push(...await filesAt(target));
    else files.push(target);
  }
  return files;
}

test("skill repository contains no private paths or heavyweight media", async () => {
  const files = await filesAt(root);
  const forbidden = [
    new RegExp(`/${["Us", "ers"].join("")}/`),
    new RegExp(["yash", "gawde"].join(""), "i"),
    new RegExp(`\\.${["ser", "ena"].join("")}/`)
  ];
  const heavyweight = new Set([".mp4", ".mov", ".wav", ".mp3", ".safetensors", ".ckpt", ".bin", ".ttf", ".otf"]);
  for (const file of files) {
    const relative = path.relative(root, file);
    assert.ok((await stat(file)).size < 2_000_000, `${relative} is unexpectedly large`);
    assert.ok(!heavyweight.has(path.extname(file).toLowerCase()), `${relative} must be generated or downloaded, not committed`);
    if (!file.endsWith(".json") && !file.endsWith(".md") && !file.endsWith(".mjs") && !file.endsWith(".yaml") && !file.endsWith(".yml") && !file.endsWith(".html") && !file.endsWith(".css") && !file.endsWith("LICENSE") && !file.endsWith(".gitignore")) continue;
    const text = await readFile(file, "utf8");
    for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `${relative} contains private machine data`);
  }
});

test("skill declares portable pinned tool versions and explicit voice consent", async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(packageJson.dependencies.hyperframes, "0.8.25");
  assert.equal(packageJson.optionalDependencies["premiere-pro-mcp"], "1.14.5");
  const skill = await readFile(path.join(root, "SKILL.md"), "utf8");
  assert.match(skill, /explicit authorization/i);
  assert.match(skill, /local-only/i);
  assert.match(skill, /Crew mode/i);
  const ignore = await readFile(path.join(root, ".gitignore"), "utf8");
  assert.match(ignore, /templates\/hyperframes\/assets\/fonts\/\*\.ttf/);
});
