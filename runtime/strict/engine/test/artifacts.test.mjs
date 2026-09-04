import assert from "node:assert/strict";
import {mkdtemp, readFile, symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {canonicalJson, sha256File, sha256Value} from "../src/checksum.mjs";
import {
  createArtifactEnvelope,
  validateArtifactEnvelope,
  verifyArtifactParents,
  writeImmutableArtifact,
} from "../src/artifacts.mjs";

function artifactFixture(overrides = {}) {
  return createArtifactEnvelope({
    artifactId: "story-plan-001", revision: 1, workItemId: "raw-001", modality: "multi-clip",
    parents: [{artifactId: "transcript-001", sha256: "a".repeat(64)}],
    producer: {actorId: "story-editor-1", role: "story-editor"},
    versions: {tool: "content-hub@0.2.0", template: null, model: null, policy: "bizibeast-v1"},
    status: "frozen", deviations: [], payload: {selects: []},
    ...overrides,
  });
}

test("artifact hashes are stable across object key insertion order", () => {
  assert.equal(sha256Value({b: 2, a: {d: 4, c: 3}}), sha256Value({a: {c: 3, d: 4}, b: 2}));
});

test("canonical JSON rejects unsupported values at any depth", () => {
  const sparseWithExtra = [];
  sparseWithExtra.length = 1;
  sparseWithExtra.extra = "bypass";
  for (const value of [{value: undefined}, {value: () => {}}, {value: Symbol("x")}, {value: NaN}, {value: Infinity}, {value: 1n}, [undefined], [,], sparseWithExtra, {nested: [undefined]}]) {
    assert.throws(() => canonicalJson(value), /JSON/i);
    assert.throws(() => sha256Value(value), /JSON/i);
  }
});

test("canonical JSON rejects ignored own properties", () => {
  const denseWithHidden = ["value"];
  Object.defineProperty(denseWithHidden, "hidden", {value: "ignored"});
  const objectWithHidden = {value: "kept"};
  Object.defineProperty(objectWithHidden, "hidden", {value: "ignored"});
  assert.throws(() => canonicalJson(denseWithHidden), /JSON/i);
  assert.throws(() => canonicalJson(objectWithHidden), /JSON/i);
});

test("an envelope carries every required handoff field", () => {
  const artifact = artifactFixture();
  assert.equal(validateArtifactEnvelope(artifact), artifact);
});

test("an envelope rejects invalid revisions, parents, versions, deviations, and payloads", () => {
  assert.throws(() => artifactFixture({revision: 0}), /revision/i);
  assert.throws(() => artifactFixture({parents: [{artifactId: "transcript-001", sha256: "A".repeat(64)}]}), /parent/i);
  assert.throws(() => artifactFixture({versions: {tool: "x"}}), /versions/i);
  assert.throws(() => artifactFixture({versions: {tool: "x", template: null, model: undefined, policy: "v1"}}), /versions/i);
  assert.throws(() => artifactFixture({deviations: {}}), /deviations/i);
  assert.throws(() => artifactFixture({payload: undefined}), /payload/i);
  assert.throws(() => artifactFixture({payload: {nested: [undefined]}}), /payload/i);
  assert.throws(() => artifactFixture({payload: {score: NaN}}), /payload/i);
  assert.throws(() => artifactFixture({deviations: [undefined]}), /envelope/i);
  const cyclicDeviations = [];
  cyclicDeviations.push(cyclicDeviations);
  assert.throws(() => artifactFixture({deviations: cyclicDeviations}), /envelope/i);
  assert.throws(() => artifactFixture({versions: {tool: "x", template: new Date(), model: null, policy: "v1"}}), /envelope/i);
  assert.throws(() => artifactFixture({parents: [{artifactId: "transcript-001", sha256: "a".repeat(64), ignored: undefined}]}), /envelope/i);
  assert.throws(() => artifactFixture({producer: {actorId: "story-editor-1", role: "story-editor", ignored: undefined}}), /envelope/i);
});

test("immutable artifact writes bind the returned hash to exact file bytes", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "content-hub-artifact-"));
  const artifact = artifactFixture();
  const stored = await writeImmutableArtifact(projectDir, "Plans/story-plan-v001.json", artifact);

  assert.deepEqual(stored, {path: "Plans/story-plan-v001.json", sha256: await sha256File(join(projectDir, stored.path))});
  assert.equal(await readFile(join(projectDir, stored.path), "utf8"), `${JSON.stringify(artifact, null, 2)}\n`);
  await assert.rejects(writeImmutableArtifact(projectDir, stored.path, artifact), {code: "EEXIST"});
});

test("immutable artifact paths stay versioned and confined", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "content-hub-artifact-"));
  const artifact = artifactFixture();

  for (const path of ["../Plans/story-plan-v001.json", "Plans/story-plan-v002.json", "QC/raw-001/v002/report.json", "QC/raw-001/report.json"]) {
    await assert.rejects(writeImmutableArtifact(projectDir, path, artifact), /artifact path|revision/i);
  }
  await writeImmutableArtifact(projectDir, "QC/raw-001/v001/report.json", artifact);
});

test("immutable artifact writes reject symlinked path components", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "content-hub-artifact-"));
  const outsideDir = await mkdtemp(join(tmpdir(), "content-hub-outside-"));
  await symlink(outsideDir, join(projectDir, "Plans"));

  await assert.rejects(writeImmutableArtifact(projectDir, "Plans/story-plan-v001.json", artifactFixture()), /symlink|artifact path/i);
  await assert.rejects(readFile(join(outsideDir, "story-plan-v001.json")), {code: "ENOENT"});
});

test("changed or missing parent hashes supersede a dependent artifact", () => {
  const artifact = artifactFixture();
  assert.throws(
    () => verifyArtifactParents(artifact, new Map([["transcript-001", "b".repeat(64)]])),
    /parent hash changed: transcript-001/i,
  );
  assert.throws(() => verifyArtifactParents(artifact, new Map()), /parent hash changed: transcript-001/i);
  assert.equal(verifyArtifactParents(artifact, new Map([["transcript-001", "a".repeat(64)]])), true);
});
