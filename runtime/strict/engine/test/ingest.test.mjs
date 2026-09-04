import assert from "node:assert/strict";
import {mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, join} from "node:path";
import test from "node:test";

import {ingestFiles} from "../src/ingest.mjs";
import {promoteAsset} from "../src/promote.mjs";
import {createProject} from "../src/project.mjs";
import {updateRoute} from "../src/routing.mjs";
import {getProjectStatus} from "../src/status.mjs";

const coordinator = {actorId: "content-hub-coordinator", actorRole: "coordinator"};

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "content-hub-ingest-"));
  const source = join(root, "camera clip.mov");
  await writeFile(source, "immutable fixture", "utf8");
  const {projectDir} = await createProject(root, {name: "Ingest Test", editors: ["premiere"]});
  return {root, source, projectDir};
}

test("ingest copies, hashes, and versions source files without overwriting", async () => {
  const {source, projectDir} = await setup();

  const first = await ingestFiles(projectDir, [source], "source", {}, coordinator);
  const second = await ingestFiles(projectDir, [source], "source", {}, coordinator);

  assert.equal(first[0].sha256, "0d6dd0388ab852aede6810da50f34ebf9a4831c5bc63a7dae0a36c985c87701a");
  assert.equal(basename(first[0].path), "camera clip.mov");
  assert.equal(basename(second[0].path), "camera clip-v002.mov");
  assert.equal(await readFile(first[0].absolutePath, "utf8"), "immutable fixture");
});

test("ingest records explicit asset provenance without changing defaults", async () => {
  const {source, projectDir} = await setup();
  const [asset] = await ingestFiles(projectDir, [source], "template", {
    originType: "frozen-template",
    originalPath: "/frozen/title.mov",
    attribution: "Studio",
    usageScope: "commercial",
    privacyClass: "project-only",
    templateRevision: "title@2",
    providerRevision: "provider@1",
    prompt: "warm title",
    derivatives: ["caption-safe"],
    usageIds: ["shot-01", "slide-01"],
  }, coordinator);

  assert.equal(asset.kind, "template");
  assert.equal(asset.path.startsWith("Assets/Templates/"), true);
  assert.deepEqual(Object.fromEntries(Object.entries(asset).filter(([key]) => [
    "originType", "originalPath", "attribution", "usageScope", "privacyClass", "templateRevision", "providerRevision", "prompt", "derivatives", "usageIds",
  ].includes(key))), {
    originType: "frozen-template", originalPath: "/frozen/title.mov", attribution: "Studio", usageScope: "commercial",
    privacyClass: "project-only", templateRevision: "title@2", providerRevision: "provider@1", prompt: "warm title",
    derivatives: ["caption-safe"], usageIds: ["shot-01", "slide-01"],
  });
});

test("routing and status reflect current project state", async () => {
  const {source, projectDir} = await setup();
  await ingestFiles(projectDir, [source], "source", {}, coordinator);
  const manifest = await updateRoute(projectDir, {
    editors: ["diffusion-studio", "after-effects"],
    mode: "autonomous",
  }, coordinator);
  const status = await getProjectStatus(projectDir);

  assert.equal(manifest.mode, "autonomous");
  assert.deepEqual(manifest.editors, [
    {id: "diffusion-studio", role: "primary"},
    {id: "after-effects", role: "sidecar"},
  ]);
  assert.deepEqual(status.counts, {sources: 1, assets: 0, renders: 0, qc: 0, deliverables: 0});
});

test("promotion refuses cloned voices", async () => {
  const {root, source, projectDir} = await setup();
  const [voice] = await ingestFiles(projectDir, [source], "voice", {voiceClone: true}, coordinator);

  await assert.rejects(
    promoteAsset(projectDir, voice.id, join(root, "Assets"), coordinator),
    /cannot be promoted/i,
  );
});

test("promotion refuses locally generated assets", async () => {
  const {root, source, projectDir} = await setup();
  const [asset] = await ingestFiles(projectDir, [source], "sfx", {
    originType: "local-generation",
    model: "local-sfx",
    providerRevision: "local-sfx@1",
    prompt: "paper tear",
  }, coordinator);

  await assert.rejects(
    promoteAsset(projectDir, asset.id, join(root, "assets"), coordinator),
    /cannot be promoted/i,
  );
});

test("promotion refuses client privacyClass even without legacy client boolean", async () => {
  const {root, source, projectDir} = await setup();
  const [asset] = await ingestFiles(projectDir, [source], "sfx", {privacyClass: "client"}, coordinator);

  await assert.rejects(
    promoteAsset(projectDir, asset.id, join(root, "assets"), coordinator),
    /cannot be promoted/i,
  );
});

test("promotion copies a confined verified generic asset exclusively", async () => {
  const {root, source, projectDir} = await setup();
  const [asset] = await ingestFiles(projectDir, [source], "sfx", {licence: "CC0", attribution: "Artist", usageScope: "commercial"}, coordinator);
  const promoted = await promoteAsset(projectDir, asset.id, join(root, "assets"), coordinator);

  assert.equal(await readFile(promoted.absolutePath, "utf8"), "immutable fixture");
  assert.equal(promoted.promotedPath, promoted.absolutePath);
});
