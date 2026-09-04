import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  approveArtifact,
  createArtifact,
  creativeQc,
  freezeCandidate,
  initStrict,
  promoteCandidate,
  runWithRetry,
  technicalQc,
  transition,
  verifyRef
} from "../runtime/strict/core.mjs";

test("bundled strict runtime completes an immutable role-separated release", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "bizibeast-strict-"));
  await mkdir(path.join(project, "Renders"));
  await mkdir(path.join(project, "Final"));
  await initStrict(project, {workItemId: "short-1"});
  const artifact = await createArtifact(project, {
    workItemId: "short-1",
    stage: "design",
    producer: {actorId: "designer", role: "design-director"},
    payload: {title: "A clear plan"}
  });
  await assert.rejects(() => approveArtifact(project, {artifactRef: artifact.ref, approver: {actorId: "designer", role: "design-approver"}}), /separate actor/);
  await assert.rejects(() => approveArtifact(project, {artifactRef: artifact.ref, approver: {actorId: "other", role: "design-director"}}), /approver role/);
  const approval = await approveArtifact(project, {artifactRef: artifact.ref, approver: {actorId: "reviewer", role: "design-approver"}});
  await transition(project, {workItemId: "short-1", from: "READY", to: "PLANNED", coordinator: {actorId: "coord", role: "coordinator"}, artifactRef: artifact.ref, approvalRef: approval.ref});
  await transition(project, {workItemId: "short-1", from: "PLANNED", to: "EXECUTING", coordinator: {actorId: "coord", role: "coordinator"}});
  const output = path.join(project, "Renders/candidate-v001.mp4");
  await writeFile(output, "candidate bytes");
  const candidate = await freezeCandidate(project, {workItemId: "short-1", coordinator: {actorId: "coord", role: "coordinator"}, output: "Renders/candidate-v001.mp4", artifacts: [artifact.ref]});
  const technical = await technicalQc(project, {candidateRef: candidate.ref, reviewer: {actorId: "tech", role: "technical-qc"}, passed: true, report: {decode: "pass"}});
  const creative = await creativeQc(project, {candidateRef: candidate.ref, reviewer: {actorId: "creative", role: "creative-qc"}, passed: true, report: {brand: "pass"}});
  const release = await promoteCandidate(project, {candidateRef: candidate.ref, technicalRef: technical.ref, creativeRef: creative.ref, promoter: {actorId: "release", role: "release-promoter"}});
  assert.equal((await readFile(path.join(project, release.output), "utf8")), "candidate bytes");
  assert.equal((await verifyRef(project, release.ref)).kind, "release-evidence");
});

test("strict retry is bounded and reports attempts", async () => {
  let calls = 0;
  const result = await runWithRetry(async () => {
    calls += 1;
    if (calls < 3) throw new Error("retry me");
    return "ok";
  }, {maxAttempts: 3});
  assert.deepEqual(result, {value: "ok", attempts: 3});
});
