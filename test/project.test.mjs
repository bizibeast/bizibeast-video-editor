import assert from "node:assert/strict";
import {mkdtemp, readFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {createProject} from "../scripts/new-project.mjs";

test("new project is self-contained and defaults to crew", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bizibeast-project-"));
  const result = await createProject({name: "My First Short!", root});
  assert.equal(result.slug, "my-first-short");
  const manifest = JSON.parse(await readFile(path.join(result.path, "project.json"), "utf8"));
  assert.equal(manifest.mode, "crew");
  for (const directory of ["Source", "Assets/Music", "Premiere", "HyperFrames", "Plans", "Renders", "QC", "Final"]) {
    assert.ok(result.directories.includes(directory));
  }
});

test("new project never overwrites an existing folder", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bizibeast-project-"));
  await createProject({name: "Repeat", root});
  await assert.rejects(() => createProject({name: "Repeat", root}), /already exists/);
});
