import assert from "node:assert/strict";
import {cp, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {writeCaptionBundle} from "../src/captions.mjs";
import {readManifest} from "../src/manifest.mjs";
import {createProject} from "../src/project.mjs";
import {freezeBrandForProject} from "../src/sunburst.mjs";

const root = process.cwd();
const coordinator = {actorId: "content-hub-coordinator", actorRole: "coordinator"};
const catalog = JSON.parse(await readFile(join(root, "Templates", "catalog.json"), "utf8"));

test("a new project freezes Sunburst and materializes all initial consumers", async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "content-hub-sunburst-e2e-"));
  t.after(() => rm(workspaceRoot, {recursive: true, force: true}));
  await cp(join(root, "Brand", "Sunburst"), join(workspaceRoot, "Brand", "Sunburst"), {recursive: true});
  const transcriptPath = join(workspaceRoot, "transcript.json");
  await writeFile(transcriptPath, `${JSON.stringify({words: [
    {text: "Sunburst", start: 0, end: 0.5},
    {text: "ships.", start: 0.5, end: 1},
  ]})}\n`);

  const {projectDir} = await createProject(workspaceRoot, {name: "Sunburst E2E", editors: ["premiere"], aspect: "9:16"});
  const brand = await freezeBrandForProject(projectDir, workspaceRoot, coordinator);
  const captions = await writeCaptionBundle(projectDir, transcriptPath, {
    style: "editorial-pair",
    anchorPlan: {segments: [{cueIndex: 0, wordIndices: [0]}]},
  });

  assert.equal(brand.id, "sunburst-editorial");
  assert.equal(captions.style, "editorial-pair");
  assert.equal((await readManifest(projectDir)).brand.frameSha256, brand.frameSha256);
  for (const id of ["sunburst-title-card-v1", "sunburst-animated-captions-portrait-v1", "sunburst-lower-third-portrait-v1", "sunburst-carousel-pack-v1"]) {
    assert.ok(catalog.templates.some((template) => template.id === id));
  }
});
