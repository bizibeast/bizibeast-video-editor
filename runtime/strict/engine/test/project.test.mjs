import assert from "node:assert/strict";
import {mkdtemp, readFile, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {createProject, REQUIRED_PROJECT_PATHS} from "../src/project.mjs";

test("creates the complete local-only project contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-project-"));
  const {projectDir, manifest} = await createProject(root, {
    name: "Demo Reel",
    editors: ["premiere", "diffusion-studio"],
    mode: "autonomous",
    aspect: "16:9",
  });

  assert.equal(manifest.localOnly, true);
  assert.equal(manifest.slug, "demo-reel");
  assert.equal(manifest.mode, "autonomous");
  assert.deepEqual(manifest.editors, [
    {id: "premiere", role: "primary"},
    {id: "diffusion-studio", role: "sidecar"},
  ]);

  for (const relativePath of REQUIRED_PROJECT_PATHS) {
    assert.equal((await stat(join(projectDir, relativePath))).isDirectory(), true);
  }

  const saved = JSON.parse(await readFile(join(projectDir, "project.yaml"), "utf8"));
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.localOnly, true);
  assert.match(await readFile(join(projectDir, "BRIEF.md"), "utf8"), /Demo Reel/);
});

test("new projects contain every BiziBeast path and initialized state files", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-project-"));
  const {projectDir, manifest} = await createProject(root, {
    name: "BiziBeast Demo",
    editors: ["premiere"],
    coordinatorActorId: "coord-7",
  });

  for (const path of [
    "Plans", "Renders/Candidates", "Renders/Carousels",
    "Final/Deliverables/Carousels",
  ]) assert.equal((await stat(join(projectDir, path))).isDirectory(), true);
  assert.equal(manifest.orchestration.coordinatorActorId, "coord-7");
  assert.deepEqual(JSON.parse(await readFile(join(projectDir, "Plans/workflow-state.json"), "utf8")), {
    schemaVersion: 1,
    projectState: "DRAFT",
    workItems: [],
    events: [],
  });
  assert.equal(await readFile(join(projectDir, "Plans/approvals.jsonl"), "utf8"), "");
});

test("rejects names that could escape the projects root", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-project-"));
  await assert.rejects(
    createProject(root, {name: "../escape", editors: ["premiere"]}),
    /project name/i,
  );
});
