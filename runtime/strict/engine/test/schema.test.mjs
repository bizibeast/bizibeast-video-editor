import assert from "node:assert/strict";
import {mkdtemp, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import test from "node:test";

import {readManifest} from "../src/manifest.mjs";
import {migrateManifestV1ToV2, validateManifestV2} from "../src/schema.mjs";

const legacyManifest = {
  schemaVersion: 1,
  name: "Legacy",
  slug: "legacy",
  localOnly: true,
  mode: "autonomous",
  format: {width: 1080, height: 1920, aspect: "9:16", fps: 30, audioSampleRate: 48000},
  editors: [{id: "premiere", role: "primary"}],
  sources: [{id: "source-1", sha256: "a".repeat(64)}],
  assets: [],
  renders: [],
  voiceAuthorizations: [],
  qc: [],
  deliverables: [],
};

test("migrates schema v1 in memory without changing existing media ledgers", () => {
  const migrated = migrateManifestV1ToV2(legacyManifest);

  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.sources[0].id, "source-1");
  assert.deepEqual(migrated.orchestration, {
    policyVersion: "bizibeast-v1",
    coordinatorActorId: "content-hub-coordinator",
    workflowStatePath: "Plans/workflow-state.json",
    approvalsPath: "Plans/approvals.jsonl",
    workflowStateSha256: null,
  });
});

test("reads schema v1 as v2 without changing the stored manifest", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "content-hub-schema-"));
  const stored = `${JSON.stringify(legacyManifest, null, 2)}\n`;
  await writeFile(join(projectDir, "project.yaml"), stored, "utf8");

  const manifest = await readManifest(projectDir);

  assert.equal(manifest.schemaVersion, 2);
  assert.equal(await readFile(join(projectDir, "project.yaml"), "utf8"), stored);
});

test("rejects malformed schema v1 manifests after migration", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "content-hub-schema-"));
  await writeFile(join(projectDir, "project.yaml"), JSON.stringify({...legacyManifest, localOnly: false}), "utf8");

  await assert.rejects(readManifest(projectDir), /Project manifest must remain local-only/);
});

test("rejects unsupported project manifest versions", () => {
  assert.throws(() => validateManifestV2({schemaVersion: 3}), /Unsupported project schema version: 3/);
  assert.throws(() => validateManifestV2({schemaVersion: 1}), /Unsupported project schema version: 1/);
});

test("rejects schema-v2 manifests that redirect the fixed workflow state", () => {
  const manifest = migrateManifestV1ToV2(legacyManifest);
  manifest.orchestration.workflowStatePath = "../../victim-workflow.json";

  assert.throws(() => validateManifestV2(manifest), /workflow state path/i);
});
