import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdir, mkdtemp, readdir, readFile, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import test from "node:test";

import {readApprovals} from "../src/approvals.mjs";
import {createProject} from "../src/project.mjs";
import {createWorkItem, transitionProject, transitionWorkItem} from "../src/workflow.mjs";
import {
  approveScriptRevision,
  requireApprovedScript,
  writeScriptRevision,
} from "../src/video-script.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repositoryRoot, "bin/content-hub.mjs");
const coordinator = {actorId: "content-hub-coordinator", actorRole: "coordinator"};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "content-hub-video-script-"));
  const project = await createProject(root, {name: "Video Script", editors: ["premiere"]});
  await transitionProject(project.projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief approved"});
  await transitionProject(project.projectDir, coordinator, {to: "READY", reason: "inputs ready"});
  await createWorkItem(project.projectDir, coordinator, {id: "launch-reel", title: "Launch reel", modality: "voice-over"});
  await transitionWorkItem(project.projectDir, coordinator, {workItemId: "launch-reel", to: "SCRIPT_DRAFT", reason: "drafting"});
  return project;
}

async function toAwaitingApproval(projectDir, workItemId = "launch-reel") {
  await transitionWorkItem(projectDir, coordinator, {workItemId, to: "AWAITING_SCRIPT_APPROVAL", reason: "ready for approval"});
}

async function toApproved(projectDir, workItemId, artifact) {
  await transitionWorkItem(projectDir, coordinator, {
    workItemId, to: "SCRIPT_APPROVED", reason: "script approved",
    artifactRef: {id: artifact.artifact.artifactId, sha256: artifact.artifactRef.sha256},
  });
}

test("binds human approval to the exact script bytes", async () => {
  const {projectDir} = await fixture();
  const first = await writeScriptRevision(projectDir, {
    workItemId: "launch-reel",
    revision: 1,
    text: "Build once. Ship clearly.\n",
    producer: {actorId: "script-01", role: "script-editorial"},
  });
  await toAwaitingApproval(projectDir);
  const approval = await approveScriptRevision(projectDir, coordinator, {
    workItemId: "launch-reel",
    artifact: first.artifact,
    expectedSha256: first.scriptSha256,
    approver: {actorId: "human:yash", role: "human"},
  });
  await toApproved(projectDir, "launch-reel", first);

  assert.equal(approval.subject.sha256, first.scriptSha256);
  const approved = await requireApprovedScript(projectDir, {
    workItemId: "launch-reel",
    scriptArtifactId: first.artifact.artifactId,
    scriptSha256: first.scriptSha256,
  });
  assert.equal(await readFile(approved.absolutePath, "utf8"), "Build once. Ship clearly.\n");
  await assert.rejects(
    requireApprovedScript(projectDir, {
      workItemId: "launch-reel",
      scriptArtifactId: first.artifact.artifactId,
      scriptSha256: "0".repeat(64),
    }),
    /exact approved script hash/u,
  );
});

test("rejects duplicate script revisions and changed script bytes", async () => {
  const {projectDir} = await fixture();
  const first = await writeScriptRevision(projectDir, {
    workItemId: "launch-reel", revision: 1, text: "One\n",
    producer: {actorId: "script-01", role: "script-editorial"},
  });
  await assert.rejects(writeScriptRevision(projectDir, {
    workItemId: "launch-reel", revision: 1, text: "Two\n",
    producer: {actorId: "script-01", role: "script-editorial"},
  }), /exist|duplicate|revision/u);
  await toAwaitingApproval(projectDir);
  await approveScriptRevision(projectDir, coordinator, {
    workItemId: "launch-reel", artifact: first.artifact,
    expectedSha256: first.scriptSha256,
    approver: {actorId: "human:yash", role: "human"},
  });
  await toApproved(projectDir, "launch-reel", first);
  await writeFile(first.path, "Tampered\n");
  await assert.rejects(requireApprovedScript(projectDir, {
    workItemId: "launch-reel", scriptArtifactId: first.artifact.artifactId,
    scriptSha256: first.scriptSha256,
  }), /bytes changed/u);
});

test("keeps v001 revisions separate for separate work items", async () => {
  const {projectDir} = await fixture();
  await createWorkItem(projectDir, coordinator, {id: "second-reel", title: "Second reel", modality: "voice-over"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "second-reel", to: "SCRIPT_DRAFT", reason: "drafting"});
  const first = await writeScriptRevision(projectDir, {
    workItemId: "launch-reel", revision: 1, text: "One\n",
    producer: {actorId: "script-01", role: "script-editorial"},
  });
  const second = await writeScriptRevision(projectDir, {
    workItemId: "second-reel", revision: 1, text: "Two\n",
    producer: {actorId: "script-02", role: "script-editorial"},
  });
  assert.notEqual(first.path, second.path);
  assert.notEqual(first.artifact.artifactId, second.artifact.artifactId);
});

test("requires an existing voice-over item at its matching script state and revision", async () => {
  const {projectDir} = await fixture();
  await assert.rejects(writeScriptRevision(projectDir, {
    workItemId: "missing", revision: 1, text: "No\n",
    producer: {actorId: "script-01", role: "script-editorial"},
  }), /unknown work item/iu);
  await createWorkItem(projectDir, coordinator, {id: "raw-reel", title: "Raw reel", modality: "raw-video"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "raw-reel", to: "MEDIA_INDEXED", reason: "indexed"});
  await assert.rejects(writeScriptRevision(projectDir, {
    workItemId: "raw-reel", revision: 1, text: "Wrong modality\n",
    producer: {actorId: "script-01", role: "script-editorial"},
  }), /voice-over|modality/u);
  await transitionWorkItem(projectDir, coordinator, {workItemId: "launch-reel", to: "REVISION_REQUIRED", returnTo: "SCRIPT_DRAFT", reason: "revise"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "launch-reel", to: "SCRIPT_DRAFT", reason: "revision started"});
  await assert.rejects(writeScriptRevision(projectDir, {
    workItemId: "launch-reel", revision: 1, text: "Stale\n",
    producer: {actorId: "script-01", role: "script-editorial"},
  }), /revision/u);
});

test("approval and verification require their workflow gates", async () => {
  const {projectDir} = await fixture();
  const first = await writeScriptRevision(projectDir, {
    workItemId: "launch-reel", revision: 1, text: "One\n",
    producer: {actorId: "script-01", role: "script-editorial"},
  });
  await assert.rejects(approveScriptRevision(projectDir, coordinator, {
    workItemId: "launch-reel", artifact: first.artifact,
    expectedSha256: first.scriptSha256, approver: {actorId: "human:yash", role: "human"},
  }), /AWAITING_SCRIPT_APPROVAL|state/u);
  await toAwaitingApproval(projectDir);
  await approveScriptRevision(projectDir, coordinator, {
    workItemId: "launch-reel", artifact: first.artifact,
    expectedSha256: first.scriptSha256, approver: {actorId: "human:yash", role: "human"},
  });
  await assert.rejects(requireApprovedScript(projectDir, {
    workItemId: "launch-reel", scriptArtifactId: first.artifact.artifactId,
    scriptSha256: first.scriptSha256,
  }), /SCRIPT_APPROVED|state/u);
});

test("approval reopens the stored artifact and detects envelope identity tampering", async () => {
  const {projectDir} = await fixture();
  const first = await writeScriptRevision(projectDir, {
    workItemId: "launch-reel", revision: 1, text: "One\n",
    producer: {actorId: "script-01", role: "script-editorial"},
  });
  await toAwaitingApproval(projectDir);
  const forged = {...first.artifact, producer: {actorId: "attacker", role: "script-editorial"}};
  const approval = await approveScriptRevision(projectDir, coordinator, {
    workItemId: "launch-reel", artifact: forged,
    expectedSha256: first.scriptSha256, approver: {actorId: "human:yash", role: "human"},
  });
  assert.equal(approval.subject.artifactId, first.artifact.artifactId);
  await toApproved(projectDir, "launch-reel", first);
  const artifactPath = join(projectDir, first.artifact.payload.path.replace(/script\.md$/u, "artifact.json"));
  const stored = JSON.parse(await readFile(artifactPath, "utf8"));
  stored.producer.actorId = "tampered";
  await writeFile(artifactPath, `${JSON.stringify(stored, null, 2)}\n`);
  await assert.rejects(requireApprovedScript(projectDir, {
    workItemId: "launch-reel", scriptArtifactId: first.artifact.artifactId, scriptSha256: first.scriptSha256,
  }), /identity hash/u);
});

test("exclusive publication leaves no partial revision on collision or symlinked parent", async () => {
  const {projectDir} = await fixture();
  const first = await writeScriptRevision(projectDir, {
    workItemId: "launch-reel", revision: 1, text: "One\n",
    producer: {actorId: "script-01", role: "script-editorial"},
  });
  await assert.rejects(writeScriptRevision(projectDir, {
    workItemId: "launch-reel", revision: 1, text: "Two\n",
    producer: {actorId: "script-01", role: "script-editorial"},
  }), /exist|rename|revision/u);
  const revisionEntries = await readdir(join(projectDir, "Plans/Scripts/launch-reel"));
  assert.deepEqual(revisionEntries, ["v001"]);
  await createWorkItem(projectDir, coordinator, {id: "link-reel", title: "Link reel", modality: "voice-over"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "link-reel", to: "SCRIPT_DRAFT", reason: "drafting"});
  const outside = await mkdtemp(join(tmpdir(), "content-hub-video-script-outside-"));
  await mkdir(join(projectDir, "Plans/Scripts"), {recursive: true});
  await symlink(outside, join(projectDir, "Plans/Scripts/link-reel"));
  await assert.rejects(writeScriptRevision(projectDir, {
    workItemId: "link-reel", revision: 1, text: "Outside\n",
    producer: {actorId: "script-02", role: "script-editorial"},
  }), /symlink|path|directory/u);
  assert.deepEqual(await readdir(outside), []);
});

test("rejects script strings that cannot be represented as UTF-8 exactly", async () => {
  const {projectDir} = await fixture();
  await assert.rejects(writeScriptRevision(projectDir, {
    workItemId: "launch-reel", revision: 1, text: "Bad\ud800\n",
    producer: {actorId: "script-01", role: "script-editorial"},
  }), /UTF-8/u);
});

test("requires an explicit human approval and current work item", async () => {
  const {projectDir} = await fixture();
  const first = await writeScriptRevision(projectDir, {
    workItemId: "launch-reel", revision: 1, text: "One\n",
    producer: {actorId: "script-01", role: "script-editorial"},
  });
  await toAwaitingApproval(projectDir);
  await assert.rejects(approveScriptRevision(projectDir, coordinator, {
    workItemId: "launch-reel", artifact: first.artifact,
    expectedSha256: "f".repeat(64),
    approver: {actorId: "human:yash", role: "human"},
  }), /do not match/u);
  await assert.rejects(approveScriptRevision(projectDir, coordinator, {
    workItemId: "launch-reel", artifact: first.artifact,
    expectedSha256: first.scriptSha256,
    approver: {actorId: "script-01", role: "script-editorial"},
  }), /human/u);
  assert.deepEqual(await readApprovals(projectDir), []);
});

test("CLI exposes draft, approve, and verify with explicit flags", async () => {
  const {projectDir} = await fixture();
  const inputPath = join(projectDir, "script.md");
  await writeFile(inputPath, "Build once.\n");
  const draft = JSON.parse((await execFileAsync(process.execPath, [
    cliPath, "video-script", "draft", projectDir, "launch-reel",
    "--input", inputPath, "--actor-id", "script-01", "--json",
  ], {cwd: repositoryRoot})).stdout);
  assert.equal(draft.artifact.payload.scriptSha256, draft.scriptSha256);
  await toAwaitingApproval(projectDir);

  const approved = JSON.parse((await execFileAsync(process.execPath, [
    cliPath, "video-script", "approve", projectDir, "launch-reel",
    "--artifact-id", draft.artifact.artifactId, "--sha256", draft.scriptSha256,
    "--approver", "human:yash", "--coordinator-id", coordinator.actorId, "--json",
  ], {cwd: repositoryRoot})).stdout);
  assert.equal(approved.approver.role, "human");
  await toApproved(projectDir, "launch-reel", draft);
  const verified = JSON.parse((await execFileAsync(process.execPath, [
    cliPath, "video-script", "verify", projectDir, "launch-reel",
    "--artifact-id", draft.artifact.artifactId, "--sha256", draft.scriptSha256, "--json",
  ], {cwd: repositoryRoot})).stdout);
  assert.equal(verified.approval.id, approved.id);
  await assert.rejects(
    execFileAsync(process.execPath, [
      cliPath, "video-script", "verify", projectDir, "launch-reel",
      "--artifact-id", draft.artifact.artifactId, "--sha256", draft.scriptSha256,
      "--unexpected", "x",
    ], {cwd: repositoryRoot}),
    (error) => /unknown flag/iu.test(`${error.stderr ?? ""} ${error.message}`),
  );
});

test("CLI draft rejects non-UTF-8 input instead of changing its bytes", async () => {
  const {projectDir} = await fixture();
  const inputPath = join(projectDir, "invalid.md");
  await writeFile(inputPath, Buffer.from([0xc3, 0x28]));
  await assert.rejects(
    execFileAsync(process.execPath, [
      cliPath, "video-script", "draft", projectDir, "launch-reel",
      "--input", inputPath, "--actor-id", "script-01",
    ], {cwd: repositoryRoot}),
    (error) => /UTF-8/u.test(`${error.stderr ?? ""} ${error.message}`),
  );
});
