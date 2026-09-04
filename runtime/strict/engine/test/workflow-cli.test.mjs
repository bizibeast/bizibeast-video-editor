import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import test from "node:test";

import {recordApproval} from "../src/approvals.mjs";
import {createProject} from "../src/project.mjs";
import {applyRetryDecision} from "../src/retry-policy.mjs";
import {getProjectStatus} from "../src/status.mjs";
import {createWorkItem, readWorkflowState, transitionProject, transitionWorkItem} from "../src/workflow.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repositoryRoot, "bin/content-hub.mjs");

function cli(args) {
  return execFileAsync(process.execPath, [cliPath, ...args], {cwd: repositoryRoot});
}

async function createCliProject() {
  const root = await mkdtemp(join(tmpdir(), "content-hub-cli-"));
  return createProject(root, {
    name: "CLI Workflow",
    editors: ["premiere"],
    coordinatorActorId: "coord-1",
  });
}

test("CLI creates and advances a work item only as the configured coordinator", async () => {
  const {projectDir} = await createCliProject();
  await cli(["project-state", projectDir, "--to", "BRIEF_APPROVED", "--reason", "approved", "--actor", "coord-1"]);
  await cli(["project-state", projectDir, "--to", "READY", "--reason", "frozen", "--actor", "coord-1"]);
  const result = JSON.parse((await cli([
    "work-create", projectDir, "--id", "carousel-001", "--title", "Launch deck",
    "--modality", "carousel", "--actor", "coord-1", "--json",
  ])).stdout);

  assert.equal(result.state, "READY");
  const status = JSON.parse((await cli(["status", projectDir, "--json"])).stdout);
  assert.equal(status.workItems[0].revision, 1);
  assert.equal(Number.isInteger(status.workItems[0].revision), true);
  await assert.rejects(
    cli(["work-transition", projectDir, "carousel-001", "--to", "COPY_DRAFT", "--reason", "drafted", "--actor", "executor-1"]),
    /only coordinator/i,
  );
});

test("CLI rejects artifact references with trailing data", async () => {
  const {projectDir} = await createCliProject();
  const coordinator = {actorId: "coord-1", actorRole: "coordinator"};
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "frozen"});
  await createWorkItem(projectDir, coordinator, {id: "voice-artifact", title: "Voice", modality: "voice-over"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "voice-artifact", to: "SCRIPT_DRAFT", reason: "drafted"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "voice-artifact", to: "AWAITING_SCRIPT_APPROVAL", reason: "submitted"});

  await assert.rejects(
    cli([
      "work-transition", projectDir, "voice-artifact", "--to", "SCRIPT_APPROVED", "--reason", "approved",
      "--actor", "coord-1", "--artifact", `script-001:${"a".repeat(64)}:garbage`,
    ]),
    /--artifact must be/i,
  );
});

test("status reports stale workflow pointers instead of claiming readiness", async () => {
  const {projectDir} = await createCliProject();
  const coordinator = {actorId: "coord-1", actorRole: "coordinator"};
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "frozen"});
  const changedState = await readWorkflowState(projectDir);
  await writeFile(join(projectDir, "Plans/workflow-state.json"), `${JSON.stringify(changedState)}\n`);

  const status = await getProjectStatus(projectDir);

  assert.equal(status.stale.workflowStatePointer, true);
  assert.equal(status.ready, false);
});

test("status ignores superseded artifact and approval history", async () => {
  const {projectDir} = await createCliProject();
  const coordinator = {actorId: "coord-1", actorRole: "coordinator"};
  const firstHash = "a".repeat(64);
  const secondHash = "b".repeat(64);
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "frozen"});
  await createWorkItem(projectDir, coordinator, {id: "carousel-revision", title: "Revised deck", modality: "carousel"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-revision", to: "COPY_DRAFT", reason: "drafted"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-revision", to: "AWAITING_COPY_APPROVAL", reason: "submitted"});
  await recordApproval(projectDir, coordinator, {
    kind: "carousel-copy", workItemId: "carousel-revision", subject: {artifactId: "copy-001", sha256: firstHash},
    decision: "approved", approver: {actorId: "human-yash", role: "human"}, origin: "user", policyVersion: "bizibeast-v1",
  });
  await transitionWorkItem(projectDir, coordinator, {
    workItemId: "carousel-revision", to: "COPY_APPROVED", reason: "approved", artifactRef: {id: "copy-001", sha256: firstHash},
  });
  await transitionWorkItem(projectDir, coordinator, {
    workItemId: "carousel-revision", to: "REVISION_REQUIRED", reason: "copy changed", returnTo: "COPY_DRAFT",
  });
  await transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-revision", to: "COPY_DRAFT", reason: "revision started"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-revision", to: "AWAITING_COPY_APPROVAL", reason: "resubmitted"});
  await recordApproval(projectDir, coordinator, {
    kind: "carousel-copy", workItemId: "carousel-revision", subject: {artifactId: "copy-001", sha256: secondHash},
    decision: "approved", approver: {actorId: "human-yash", role: "human"}, origin: "user", policyVersion: "bizibeast-v1",
  });
  await transitionWorkItem(projectDir, coordinator, {
    workItemId: "carousel-revision", to: "COPY_APPROVED", reason: "revision approved", artifactRef: {id: "copy-001", sha256: secondHash},
  });

  const status = await getProjectStatus(projectDir);

  assert.deepEqual(status.stale.artifactIds, []);
  assert.deepEqual(status.stale.approvalIds, []);
  assert.equal(status.ready, true);
});

test("status excludes stale approvals owned by a superseded work item", async () => {
  const {projectDir} = await createCliProject();
  const coordinator = {actorId: "coord-1", actorRole: "coordinator"};
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "frozen"});
  await createWorkItem(projectDir, coordinator, {id: "carousel-old", title: "Old deck", modality: "carousel"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-old", to: "COPY_DRAFT", reason: "drafted"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-old", to: "AWAITING_COPY_APPROVAL", reason: "submitted"});
  await recordApproval(projectDir, coordinator, {
    kind: "carousel-copy", workItemId: "carousel-old", subject: {artifactId: "copy-1", sha256: "b".repeat(64)},
    decision: "approved", approver: {actorId: "human-yash", role: "human"}, origin: "user", policyVersion: "bizibeast-v1",
  });
  await transitionWorkItem(projectDir, coordinator, {
    workItemId: "carousel-old", to: "COPY_APPROVED", reason: "approval recorded",
    artifactRef: {id: "copy-1", sha256: "a".repeat(64)},
  });
  await transitionWorkItem(projectDir, coordinator, {
    workItemId: "carousel-old", to: "SUPERSEDED", reason: "parent changed",
    artifactRef: {id: "copy-1", sha256: "a".repeat(64)},
  });

  const status = await getProjectStatus(projectDir);

  assert.equal(status.workItems[0].state, "SUPERSEDED");
  assert.deepEqual(status.stale.artifactIds, []);
  assert.deepEqual(status.stale.approvalIds, []);
  assert.equal(status.ready, true);
});

test("status reports an active approval without an active artifact pointer as stale", async () => {
  const {projectDir} = await createCliProject();
  const coordinator = {actorId: "coord-1", actorRole: "coordinator"};
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "frozen"});
  await createWorkItem(projectDir, coordinator, {id: "other-work", title: "Other script", modality: "voice-over"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "other-work", to: "SCRIPT_DRAFT", reason: "drafted"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "other-work", to: "AWAITING_SCRIPT_APPROVAL", reason: "submitted"});
  await transitionWorkItem(projectDir, coordinator, {
    workItemId: "other-work", to: "SCRIPT_APPROVED", reason: "approved",
    artifactRef: {id: "script-missing", sha256: "c".repeat(64)},
  });
  const approval = await recordApproval(projectDir, coordinator, {
    kind: "script", workItemId: "missing-work", subject: {artifactId: "script-missing", sha256: "c".repeat(64)},
    decision: "approved", approver: {actorId: "human-yash", role: "human"}, origin: "user", policyVersion: "bizibeast-v1",
  });

  const status = await getProjectStatus(projectDir);

  assert.deepEqual(status.stale.artifactIds, ["script-missing"]);
  assert.deepEqual(status.stale.approvalIds, [approval.id]);
  assert.equal(status.ready, false);
});

test("status exposes the current retry decision and action", async () => {
  const {projectDir} = await createCliProject();
  const coordinator = {actorId: "coord-1", actorRole: "coordinator"};
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "frozen"});
  await createWorkItem(projectDir, coordinator, {id: "retry-work", title: "Retry video", modality: "raw-video"});
  for (const to of ["MEDIA_INDEXED", "TRANSCRIPTS_READY", "STORY_PLANNED", "DESIGN_PLANNED", "DESIGN_APPROVED", "EXECUTING", "CANDIDATE_FROZEN"]) {
    await transitionWorkItem(projectDir, coordinator, {
      workItemId: "retry-work", to, reason: `enter ${to}`,
      artifactRef: ["DESIGN_APPROVED", "CANDIDATE_FROZEN"].includes(to) ? {id: `artifact-${to.toLowerCase()}`, sha256: "a".repeat(64)} : undefined,
    });
  }
  await applyRetryDecision(projectDir, coordinator, "retry-work", {
    action: "REVISE_STAGE", ownerStage: "premiere-executor", candidateRevision: 1,
    reason: "fix failed render", findingSignatures: ["render-failed"], returnTo: "EXECUTING", consumeRevision: true,
  });

  const item = (await getProjectStatus(projectDir)).workItems.find(({id}) => id === "retry-work");
  assert.equal(item.retry.state, "current");
  assert.equal(item.retry.action, "REVISE_STAGE");
  assert.equal(item.retry.decision.reason, "fix failed render");
});
