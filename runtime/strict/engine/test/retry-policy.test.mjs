import assert from "node:assert/strict";
import {chmod, mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {sha256File, sha256Value} from "../src/checksum.mjs";
import {createProject} from "../src/project.mjs";
import {applyRetryDecision, decideRetry} from "../src/retry-policy.mjs";
import {createWorkItem, getWorkItem, readWorkflowState, transitionProject, transitionWorkItem} from "../src/workflow.mjs";

const coordinator = {actorId: "content-hub-coordinator", actorRole: "coordinator"};
const artifactRef = {id: "retry-evidence", sha256: "a".repeat(64)};

async function createExecutingProject() {
  const projectDir = (await createProject(await mkdtemp(join(tmpdir(), "content-hub-retry-")), {name: "Retry policy", editors: ["premiere"]})).projectDir;
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "inputs frozen"});
  await createWorkItem(projectDir, coordinator, {id: "retry-001", title: "Retry item", modality: "raw-video"});
  for (const to of ["MEDIA_INDEXED", "TRANSCRIPTS_READY", "STORY_PLANNED", "DESIGN_PLANNED"]) {
    await transitionWorkItem(projectDir, coordinator, {workItemId: "retry-001", to, reason: `enter ${to}`});
  }
  await transitionWorkItem(projectDir, coordinator, {workItemId: "retry-001", to: "DESIGN_APPROVED", reason: "design approved", artifactRef});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "retry-001", to: "EXECUTING", reason: "execution started"});
  return projectDir;
}

function decisionArtifactPath(decision, workItemId = "retry-001", modality = "raw-video") {
  const identity = {...decision, workItemId, modality};
  return `Plans/retry-decision-${sha256Value(identity)}-v${String(decision.candidateRevision).padStart(3, "0")}.json`;
}

async function assertDecisionArtifact(projectDir, decision, expected = {}, workItemId = "retry-001", modality = "raw-video") {
  const path = decisionArtifactPath(decision, workItemId, modality);
  const identity = {...decision, workItemId, modality};
  const artifact = JSON.parse(await readFile(join(projectDir, path), "utf8"));
  assert.equal(artifact.artifactId, `retry-decision-${sha256Value(identity)}`);
  assert.equal(artifact.revision, decision.candidateRevision);
  assert.equal(artifact.workItemId, workItemId);
  assert.equal(artifact.modality, modality);
  assert.deepEqual(artifact.producer, {actorId: coordinator.actorId, role: "coordinator"});
  assert.deepEqual(artifact.versions, {tool: "content-hub@0.1.0", template: null, model: null, policy: "bizibeast-v1"});
  assert.equal(artifact.status, expected.status ?? "recorded");
  assert.ok(!Number.isNaN(Date.parse(artifact.createdAt)));
  const {status, ...expectedPayload} = expected;
  assert.deepEqual(artifact.payload, {...decision, ...expectedPayload});
  return {artifact, ref: {id: artifact.artifactId, sha256: await sha256File(join(projectDir, path))}};
}

test("retries one objective crash without consuming a revision", () => {
  assert.deepEqual(decideRetry([], {kind: "tool-crash", signature: "crash-a", ownerStage: "premiere-executor", candidateRevision: 1}), {
    action: "RETRY_IDENTICAL", ownerStage: "premiere-executor", candidateRevision: 1,
    reason: "first identical retry for objective tool crash", findingSignatures: ["crash-a"],
    returnTo: "EXECUTING", consumeRevision: false,
  });
});

test("includes failure score and artifact hash only when supplied", () => {
  assert.deepEqual(decideRetry([], {
    kind: "tool-crash", signature: "crash-b", ownerStage: "premiere-executor", candidateRevision: 1,
    score: 91, artifactHash: "bundle-b",
  }), {
    action: "RETRY_IDENTICAL", ownerStage: "premiere-executor", candidateRevision: 1,
    reason: "first identical retry for objective tool crash", findingSignatures: ["crash-b"],
    returnTo: "EXECUTING", consumeRevision: false, score: 91, artifactHash: "bundle-b",
  });
});

test("the same finding twice forces a design replan", () => {
  const decision = decideRetry([{signature: "finding-a", score: 82}], {signature: "finding-a", score: 84, ownerStage: "premiere-executor", candidateRevision: 2});
  assert.equal(decision.action, "REPLAN_DESIGN");
  assert.equal(decision.returnTo, "DESIGN_PLANNED");
});

test("revision three escalates instead of weakening the gate", () => {
  assert.equal(decideRetry([
    {signature: "finding-a", score: 82, candidateRevision: 1},
    {signature: "finding-b", score: 85, candidateRevision: 2},
  ], {
    kind: "gate-failure", signature: "finding-c", score: 88,
    ownerStage: "premiere-executor", candidateRevision: 3,
  }).action, "ESCALATE_HUMAN");
});

test("immediate blocks take priority over candidate revision exhaustion", () => {
  for (const immediateBlockReason of ["missing-authority", "asset-rights", "privacy", "brand-conflict", "missing-required-capability", "source-destructive-operation"]) {
    const decision = decideRetry([], {signature: "blocked", ownerStage: "premiere-executor", candidateRevision: 3, immediateBlockReason});
    assert.equal(decision.action, "ESCALATE_HUMAN");
    assert.equal(decision.reason, immediateBlockReason);
  }
});

test("non-improving scores and unchanged artifact hashes force a design replan", () => {
  assert.equal(decideRetry([{signature: "finding-a", score: 92}], {signature: "finding-b", score: 92, ownerStage: "premiere-executor", candidateRevision: 2}).action, "REPLAN_DESIGN");
  assert.equal(decideRetry([{signature: "finding-a", artifactHash: "bundle-a"}], {signature: "finding-b", artifactHash: "bundle-a", ownerStage: "premiere-executor", candidateRevision: 2}).action, "REPLAN_DESIGN");
});

test("stage revisions return to their modality-specific owner state", () => {
  assert.equal(decideRetry([], {signature: "copy", ownerStage: "script-editorial", modality: "carousel", candidateRevision: 1}).returnTo, "COPY_DRAFT");
  assert.equal(decideRetry([], {signature: "script", ownerStage: "script-editorial", modality: "voice-over", candidateRevision: 1}).returnTo, "SCRIPT_DRAFT");
  assert.equal(decideRetry([], {signature: "audio", ownerStage: "local-media-technician", modality: "voice-over", candidateRevision: 1}).returnTo, "AUDIO_READY");
  assert.equal(decideRetry([], {signature: "media", ownerStage: "local-media-technician", modality: "raw-video", candidateRevision: 1}).returnTo, "TRANSCRIPTS_READY");
  for (const ownerStage of ["story-editor", "subject-analyst", "asset-resolver", "design-director", "premiere-executor", "hyperframes-executor", "carousel-lead", "carousel-slide-executor"]) {
    const expected = ownerStage === "story-editor" ? "STORY_PLANNED" : ownerStage.endsWith("executor") || ownerStage === "carousel-lead" ? "EXECUTING" : "DESIGN_PLANNED";
    assert.equal(decideRetry([], {signature: ownerStage, ownerStage, candidateRevision: 1}).returnTo, expected);
  }
});

test("retry policy rejects malformed history and current failures at its boundary", () => {
  assert.throws(() => decideRetry({}, {signature: "finding", ownerStage: "premiere-executor", candidateRevision: 1}), /history/i);
  assert.throws(() => decideRetry([], {signature: "finding", ownerStage: "premiere-executor", candidateRevision: 0}), /candidate revision/i);
  assert.throws(() => decideRetry([], {signature: "finding", ownerStage: "unknown-stage", candidateRevision: 1}), /owner stage/i);
  assert.throws(() => decideRetry([], {signature: "finding", ownerStage: "script-editorial", candidateRevision: 1}), /modality/i);
});

test("applying an identical crash retry records its audit artifact while keeping execution and revision", async () => {
  const projectDir = await createExecutingProject();
  const before = await readWorkflowState(projectDir);
  const decision = decideRetry([], {
    kind: "tool-crash", signature: "crash-a", ownerStage: "premiere-executor", candidateRevision: 1,
  });
  const state = await applyRetryDecision(projectDir, coordinator, "retry-001", decision);
  const item = getWorkItem(state, "retry-001");
  assert.equal(item.state, "EXECUTING");
  assert.equal(item.revision, 1);
  assert.deepEqual(state.events, before.events);
  await assertDecisionArtifact(projectDir, decision);
});

test("identical decisions on two work items have distinct immutable identities", async () => {
  const projectDir = await createExecutingProject();
  await createWorkItem(projectDir, coordinator, {id: "retry-002", title: "Second retry item", modality: "raw-video"});
  for (const to of ["MEDIA_INDEXED", "TRANSCRIPTS_READY", "STORY_PLANNED", "DESIGN_PLANNED"]) {
    await transitionWorkItem(projectDir, coordinator, {workItemId: "retry-002", to, reason: `enter ${to}`});
  }
  await transitionWorkItem(projectDir, coordinator, {workItemId: "retry-002", to: "DESIGN_APPROVED", reason: "design approved", artifactRef});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "retry-002", to: "EXECUTING", reason: "execution started"});
  const decision = decideRetry([], {kind: "tool-crash", signature: "same-crash", ownerStage: "premiere-executor", candidateRevision: 1});
  await applyRetryDecision(projectDir, coordinator, "retry-001", decision);
  await applyRetryDecision(projectDir, coordinator, "retry-002", decision);
  assert.notEqual(decisionArtifactPath(decision, "retry-001"), decisionArtifactPath(decision, "retry-002"));
  await assertDecisionArtifact(projectDir, decision, {}, "retry-001");
  await assertDecisionArtifact(projectDir, decision, {}, "retry-002");
});

test("applying a stage revision preserves failed workflow evidence and increments once", async () => {
  const projectDir = await createExecutingProject();
  const before = await readWorkflowState(projectDir);
  const decision = decideRetry([], {kind: "gate-failure", signature: "timing-a", score: 82, artifactHash: "bundle-a", ownerStage: "premiere-executor", candidateRevision: 1});
  const state = await applyRetryDecision(projectDir, coordinator, "retry-001", decision);
  const item = getWorkItem(state, "retry-001");
  assert.equal(item.state, "REVISION_REQUIRED");
  assert.equal(item.returnTo, "EXECUTING");
  assert.equal(item.revision, 2);
  assert.deepEqual(state.events.slice(0, before.events.length), before.events);
  assert.deepEqual(state.events.at(-1).artifactRef, (await assertDecisionArtifact(projectDir, decision, {status: "proposed"})).ref);
});

test("applying a replan binds its stored decision artifact to the workflow event", async () => {
  const projectDir = await createExecutingProject();
  const decision = decideRetry([{signature: "timing-a", score: 80}], {
    kind: "gate-failure", signature: "timing-a", score: 82, ownerStage: "premiere-executor", candidateRevision: 1,
  });
  const state = await applyRetryDecision(projectDir, coordinator, "retry-001", decision);
  assert.equal(getWorkItem(state, "retry-001").returnTo, "DESIGN_PLANNED");
  assert.deepEqual(state.events.at(-1).artifactRef, (await assertDecisionArtifact(projectDir, decision, {status: "proposed"})).ref);
});

test("applying a human escalation binds its stored decision artifact to the workflow event", async () => {
  const projectDir = await createExecutingProject();
  const decision = decideRetry([], {
    signature: "rights-a", ownerStage: "premiere-executor", candidateRevision: 1, immediateBlockReason: "asset-rights",
  });
  const state = await applyRetryDecision(projectDir, coordinator, "retry-001", decision);
  assert.equal(getWorkItem(state, "retry-001").state, "BLOCKED");
  assert.equal(state.events.at(-1).reason, "asset-rights");
  assert.deepEqual(state.events.at(-1).artifactRef, (await assertDecisionArtifact(projectDir, decision, {status: "proposed"})).ref);
});

test("only the coordinator may record a retry decision", async () => {
  const projectDir = await createExecutingProject();
  const decision = decideRetry([], {kind: "tool-crash", signature: "crash-a", ownerStage: "premiere-executor", candidateRevision: 1});
  await assert.rejects(applyRetryDecision(projectDir, {actorId: "editor-1", actorRole: "premiere-executor"}, "retry-001", decision), /coordinator/i);
  await assert.rejects(readFile(join(projectDir, decisionArtifactPath(decision))), {code: "ENOENT"});
});

test("retry decision collisions fail closed without changing workflow state", async () => {
  const projectDir = await createExecutingProject();
  const decision = decideRetry([], {kind: "tool-crash", signature: "crash-a", ownerStage: "premiere-executor", candidateRevision: 1});
  const before = await readWorkflowState(projectDir);
  await writeFile(join(projectDir, decisionArtifactPath(decision)), "occupied", "utf8");
  await assert.rejects(applyRetryDecision(projectDir, coordinator, "retry-001", decision), {code: "EEXIST"});
  assert.deepEqual(await readWorkflowState(projectDir), before);
});

test("replaying an identical retry decision cannot overwrite its immutable audit record", async () => {
  const projectDir = await createExecutingProject();
  const decision = decideRetry([], {kind: "tool-crash", signature: "crash-a", ownerStage: "premiere-executor", candidateRevision: 1});
  await applyRetryDecision(projectDir, coordinator, "retry-001", decision);
  const before = await readFile(join(projectDir, decisionArtifactPath(decision)), "utf8");
  await assert.rejects(applyRetryDecision(projectDir, coordinator, "retry-001", decision), {code: "EEXIST"});
  assert.equal(await readFile(join(projectDir, decisionArtifactPath(decision)), "utf8"), before);
});

test("invalid retry states create no decision artifact", async () => {
  const projectDir = await createExecutingProject();
  await transitionWorkItem(projectDir, coordinator, {workItemId: "retry-001", to: "REVISION_REQUIRED", reason: "revision opened", returnTo: "EXECUTING"});
  const decision = decideRetry([], {kind: "tool-crash", signature: "crash-invalid", ownerStage: "premiere-executor", candidateRevision: 2});
  await assert.rejects(applyRetryDecision(projectDir, coordinator, "retry-001", decision), /state/i);
  await assert.rejects(readFile(join(projectDir, decisionArtifactPath(decision))), {code: "ENOENT"});
});

test("identical retries reject non-executing work without creating an artifact", async () => {
  const projectDir = await createExecutingProject();
  const decision = decideRetry([], {kind: "tool-crash", signature: "crash-invalid-state", ownerStage: "premiere-executor", candidateRevision: 1});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "retry-001", to: "CANDIDATE_FROZEN", reason: "candidate frozen", artifactRef});
  await assert.rejects(applyRetryDecision(projectDir, coordinator, "retry-001", decision), /executing/i);
  await assert.rejects(readFile(join(projectDir, decisionArtifactPath(decision))), {code: "ENOENT"});
});

test("a post-write transition failure leaves only a proposed unlinked artifact", async () => {
  const projectDir = await createExecutingProject();
  const decision = decideRetry([], {kind: "gate-failure", signature: "forced-transition-failure", ownerStage: "premiere-executor", candidateRevision: 1});
  const path = join(projectDir, decisionArtifactPath(decision));
  const before = await readWorkflowState(projectDir);
  const pending = applyRetryDecision(projectDir, coordinator, "retry-001", decision);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await readFile(path);
      break;
    } catch (error) {
      if (attempt === 99) throw error;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  await chmod(join(projectDir, "Plans"), 0o555);
  try {
    await assert.rejects(pending);
  } finally {
    await chmod(join(projectDir, "Plans"), 0o755);
  }
  const artifact = JSON.parse(await readFile(path, "utf8"));
  assert.equal(artifact.status, "proposed");
  assert.deepEqual(await readWorkflowState(projectDir), before);
});
