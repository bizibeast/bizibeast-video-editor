import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, symlink, unlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import test from "node:test";

import {findCurrentApproval, readApprovals, recordApproval} from "../src/approvals.mjs";
import {freezeCandidateBundle} from "../src/candidates.mjs";
import {createProject} from "../src/project.mjs";
import {assertIndependentReviewer, ROLES} from "../src/roles.mjs";

const coordinator = {actorId: "content-hub-coordinator", actorRole: "coordinator"};
const executor = {actorId: "executor-1", actorRole: "premiere-executor"};
const hash = (character) => character.repeat(64);

async function createApprovalProject() {
  const root = await mkdtemp(join(tmpdir(), "content-hub-approvals-"));
  return createProject(root, {name: "Approval Records", editors: ["premiere"]});
}

function humanApproval(overrides = {}) {
  return {
    kind: "script",
    workItemId: "vo-001",
    subject: {artifactId: "script-001", sha256: hash("a")},
    decision: "approved",
    approver: {actorId: "human-yash", role: "human"},
    origin: "user",
    policyVersion: "bizibeast-v1",
    ...overrides,
  };
}

function reviewApproval(kind, overrides = {}) {
  const role = kind === "design" ? "design-approver" : "creative-qc-reviewer";
  return {
    kind,
    workItemId: "vo-001",
    subject: {artifactId: `${kind}-001`, sha256: hash(kind === "design" ? "d" : "c")},
    decision: "approved",
    approver: {actorId: `${role}-1`, role},
    origin: "bizibeast",
    policyVersion: "bizibeast-v1",
    producerActorId: "executor-1",
    ...overrides,
  };
}

async function freezeApprovalBundle(projectDir, revision = 1) {
  const scriptApproval = await recordApproval(projectDir, coordinator, humanApproval());
  const path = `Renders/Candidates/vo-001/v${String(revision).padStart(3, "0")}/master.mov`;
  await mkdir(dirname(join(projectDir, path)), {recursive: true});
  await writeFile(join(projectDir, path), `candidate-${revision}`, "utf8");
  return freezeCandidateBundle(projectDir, coordinator, {
    workItemId: "vo-001", modality: "raw-video", revision,
    outputs: [{path, kind: "master", order: 1}],
    inputLock: {
      artifacts: [{id: "script-001", sha256: hash("a")}],
      approvals: [{id: scriptApproval.id, subjectSha256: hash("a")}],
      assets: [],
    },
    lineage: {sourceIds: [], assetIds: []},
    settings: {profileId: "test-v1"},
    producer: {actorId: "executor-1", role: "premiere-executor"},
    versions: {premiere: "test", policy: "bizibeast-v1"},
    requestedDerivatives: [],
  });
}

test("role policy exposes only the production roles and rejects self-review", () => {
  assert.deepEqual([...ROLES].sort(), [
    "asset-resolver", "carousel-lead", "carousel-slide-executor", "coordinator", "creative-qc-reviewer",
    "design-approver", "design-director", "human", "hyperframes-executor", "local-media-technician",
    "premiere-executor", "release-promoter", "script-editorial", "story-editor", "subject-analyst", "technical-qc-validator",
  ]);
  assert.throws(() => assertIndependentReviewer({
    producerActorId: "actor-1", reviewerActorId: "actor-1", reviewerRole: "creative-qc-reviewer",
  }), /cannot review its own work/i);
  assert.throws(() => assertIndependentReviewer({
    producerActorId: "actor-1", reviewerActorId: "actor-2", reviewerRole: "release-promoter",
  }), /not a reviewer role/i);
});

test("script approval is current only for the exact script hash and policy", async () => {
  const {projectDir} = await createApprovalProject();
  const approval = await recordApproval(projectDir, coordinator, humanApproval());
  const approvals = await readApprovals(projectDir);

  assert.equal(findCurrentApproval(approvals, {
    kind: "script", workItemId: "vo-001", artifactId: "script-001", sha256: hash("a"), policyVersion: "bizibeast-v1",
  }).id, approval.id);
  assert.equal(findCurrentApproval(approvals, {
    kind: "script", workItemId: "vo-001", artifactId: "script-001", sha256: hash("b"), policyVersion: "bizibeast-v1",
  }), null);
  assert.equal(findCurrentApproval(approvals, {
    kind: "script", workItemId: "vo-001", artifactId: "script-001", sha256: hash("a"), policyVersion: "bizibeast-v2",
  }), null);
});

test("carousel-copy approval is current only for the exact copy hash", async () => {
  const {projectDir} = await createApprovalProject();
  await recordApproval(projectDir, coordinator, humanApproval({
    kind: "carousel-copy",
    workItemId: "carousel-001",
    subject: {artifactId: "carousel-copy-001", sha256: hash("c")},
  }));
  const approvals = await readApprovals(projectDir);

  assert.ok(findCurrentApproval(approvals, {
    kind: "carousel-copy", workItemId: "carousel-001", artifactId: "carousel-copy-001", sha256: hash("c"), policyVersion: "bizibeast-v1",
  }));
  assert.equal(findCurrentApproval(approvals, {
    kind: "carousel-copy", workItemId: "carousel-001", artifactId: "carousel-copy-001", sha256: hash("d"), policyVersion: "bizibeast-v1",
  }), null);
});

test("human-required approval kinds reject non-human approvers and non-user origins", async () => {
  const {projectDir} = await createApprovalProject();

  await assert.rejects(
    recordApproval(projectDir, coordinator, humanApproval({origin: "bizibeast"})),
    /origin.*user/i,
  );
  await assert.rejects(
    recordApproval(projectDir, coordinator, humanApproval({approver: {actorId: "editor-1", role: "script-editorial"}})),
    /human/i,
  );
  await assert.rejects(
    recordApproval(projectDir, coordinator, humanApproval({origin: "unknown"})),
    /origin/i,
  );
});

test("design and creative approvals require their exact independent reviewers", async () => {
  const {projectDir} = await createApprovalProject();
  const bundle = await freezeApprovalBundle(projectDir);

  await assert.rejects(
    recordApproval(projectDir, coordinator, reviewApproval("design", {approver: {actorId: "creative-1", role: "creative-qc-reviewer"}})),
    /design-approver/i,
  );
  await assert.rejects(
    recordApproval(projectDir, coordinator, reviewApproval("creative", {
      bundleHash: bundle.bundleHash,
      approver: {actorId: "executor-1", role: "creative-qc-reviewer"},
    })),
    /cannot review its own work/i,
  );

  const [design, creative] = await Promise.all([
    recordApproval(projectDir, coordinator, reviewApproval("design")),
    recordApproval(projectDir, coordinator, reviewApproval("creative", {bundleHash: bundle.bundleHash})),
  ]);
  assert.equal(design.producerActorId, "executor-1");
  assert.equal(creative.approver.role, "creative-qc-reviewer");
});

test("only the coordinator may append an approval", async () => {
  const {projectDir} = await createApprovalProject();
  await assert.rejects(recordApproval(projectDir, executor, humanApproval()), /coordinator/i);
});

test("concurrent authorized appends preserve each approval and its hash chain", async () => {
  const {projectDir} = await createApprovalProject();
  await Promise.all([
    recordApproval(projectDir, coordinator, humanApproval({workItemId: "vo-001"})),
    recordApproval(projectDir, coordinator, humanApproval({workItemId: "vo-002", subject: {artifactId: "script-002", sha256: hash("b")}})),
  ]);

  const approvals = await readApprovals(projectDir);
  assert.equal(approvals.length, 2);
  assert.ok(approvals.every((record, index) => record.previousRecordHash === (index ? approvals[index - 1].recordHash : null)));
});

test("equivalent project paths serialize into one approval chain", async () => {
  const {projectDir} = await createApprovalProject();
  await Promise.all([
    recordApproval(projectDir, coordinator, humanApproval()),
    recordApproval(`${projectDir}/.`, coordinator, humanApproval({workItemId: "vo-002", subject: {artifactId: "script-002", sha256: hash("b")}})),
  ]);

  assert.equal((await readApprovals(projectDir)).length, 2);
});

test("approvals reject a manifest that redirects the fixed approval log", async () => {
  const {projectDir, manifest} = await createApprovalProject();
  manifest.orchestration.approvalsPath = "../outside.jsonl";
  await writeFile(join(projectDir, "project.yaml"), `${JSON.stringify(manifest)}\n`, "utf8");

  await assert.rejects(readApprovals(projectDir), /approvals path/i);
  await assert.rejects(recordApproval(projectDir, coordinator, humanApproval()), /approvals path/i);
});

test("approval reads and appends reject a symlinked fixed log without touching its target", async (t) => {
  for (const [name, operation] of [
    ["read", (projectDir) => readApprovals(projectDir)],
    ["append", (projectDir) => recordApproval(projectDir, coordinator, humanApproval())],
  ]) {
    await t.test(name, async () => {
      const {projectDir} = await createApprovalProject();
      const outside = join(await mkdtemp(join(tmpdir(), "content-hub-approvals-outside-")), "approvals.jsonl");
      const approvalsPath = join(projectDir, "Plans", "approvals.jsonl");
      await writeFile(outside, "");
      await unlink(approvalsPath);
      await symlink(outside, approvalsPath);

      await assert.rejects(operation(projectDir), /symlink|project path/i);
      assert.equal(await readFile(outside, "utf8"), "");
    });
  }
});

test("approval log corruption fails closed instead of skipping bad evidence", async (t) => {
  for (const [name, corrupt] of [
    ["tampered", (raw) => raw.replace('"decision":"approved"', '"decision":"rejected"')],
    ["reordered", (raw) => raw.split("\n").filter(Boolean).reverse().join("\n").concat("\n")],
    ["truncated", (raw) => raw.slice(0, -2)],
  ]) {
    await t.test(name, async () => {
      const {projectDir, manifest} = await createApprovalProject();
      await recordApproval(projectDir, coordinator, humanApproval());
      await recordApproval(projectDir, coordinator, humanApproval({workItemId: "vo-002", subject: {artifactId: "script-002", sha256: hash("b")}}));
      const path = join(projectDir, manifest.orchestration.approvalsPath);
      await writeFile(path, corrupt(await readFile(path, "utf8")), "utf8");
      await assert.rejects(readApprovals(projectDir));
    });
  }
});

test("a later rejection overrides only the exact subject bundle and policy", async () => {
  const {projectDir} = await createApprovalProject();
  const firstBundle = await freezeApprovalBundle(projectDir);
  const base = reviewApproval("creative", {bundleHash: firstBundle.bundleHash});
  await recordApproval(projectDir, coordinator, base);
  await recordApproval(projectDir, coordinator, {...base, decision: "rejected"});
  const secondBundle = await freezeApprovalBundle(projectDir, 2);
  await recordApproval(projectDir, coordinator, reviewApproval("creative", {bundleHash: secondBundle.bundleHash, policyVersion: "bizibeast-v2"}));
  const approvals = await readApprovals(projectDir);

  assert.equal(findCurrentApproval(approvals, {
    kind: "creative", workItemId: "vo-001", artifactId: "creative-001", sha256: hash("c"), bundleHash: firstBundle.bundleHash, policyVersion: "bizibeast-v1",
  }), null);
  assert.equal(findCurrentApproval(approvals, {
    kind: "creative", workItemId: "vo-001", artifactId: "creative-001", sha256: hash("c"), bundleHash: secondBundle.bundleHash, policyVersion: "bizibeast-v2",
  }).decision, "approved");
});

test("creative and human-release approvals require an exact bundle hash to record and query", async () => {
  const {projectDir} = await createApprovalProject();
  await assert.rejects(recordApproval(projectDir, coordinator, reviewApproval("creative")), /bundle/i);
  await assert.rejects(recordApproval(projectDir, coordinator, humanApproval({kind: "human-release"})), /bundle/i);

  const bundle = await freezeApprovalBundle(projectDir);
  const creative = await recordApproval(projectDir, coordinator, reviewApproval("creative", {bundleHash: bundle.bundleHash}));
  const release = await recordApproval(projectDir, coordinator, humanApproval({
    kind: "human-release", subject: {artifactId: "candidate-001", sha256: hash("e")}, bundleHash: bundle.bundleHash,
  }));
  const approvals = await readApprovals(projectDir);

  assert.equal(findCurrentApproval(approvals, {
    kind: "creative", workItemId: "vo-001", artifactId: "creative-001", sha256: hash("c"), policyVersion: "bizibeast-v1",
  }), null);
  assert.equal(findCurrentApproval(approvals, {
    kind: "human-release", workItemId: "vo-001", artifactId: "candidate-001", sha256: hash("e"), policyVersion: "bizibeast-v1",
  }), null);
  assert.equal(findCurrentApproval(approvals, {
    kind: "creative", workItemId: "vo-001", artifactId: "creative-001", sha256: hash("c"), bundleHash: bundle.bundleHash, policyVersion: "bizibeast-v1",
  }).id, creative.id);
  assert.equal(findCurrentApproval(approvals, {
    kind: "human-release", workItemId: "vo-001", artifactId: "candidate-001", sha256: hash("e"), bundleHash: bundle.bundleHash, policyVersion: "bizibeast-v1",
  }).id, release.id);
});
