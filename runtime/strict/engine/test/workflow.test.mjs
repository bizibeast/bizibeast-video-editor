import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, mkdtemp, readFile, rename, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {sha256File} from "../src/checksum.mjs";
import {createArtifactEnvelope, verifyArtifactParentsOrSupersede, writeImmutableArtifact} from "../src/artifacts.mjs";
import {createProject} from "../src/project.mjs";
import {
  createWorkItem,
  getWorkItem,
  readWorkflowState,
  transitionProject,
  transitionWorkItem,
  transitionWorkItemSequence,
} from "../src/workflow.mjs";

const coordinator = {actorId: "content-hub-coordinator", actorRole: "coordinator"};
const artifactRef = {id: "evidence-001", sha256: "a".repeat(64)};

async function createWorkflowProject() {
  const root = await mkdtemp(join(tmpdir(), "content-hub-workflow-"));
  return createProject(root, {name: "Workflow States", editors: ["premiere"]});
}

function transitionOptions(to) {
  return {to, reason: `enter ${to}`, ...(evidenceStates.has(to) ? {artifactRef} : {})};
}

const evidenceStates = new Set([
  "SCRIPT_APPROVED", "COPY_APPROVED", "DESIGN_APPROVED", "CANDIDATE_FROZEN",
  "TECH_PASSED", "CREATIVE_PASSED", "APPROVED", "RELEASED", "SUPERSEDED",
]);

test("voice-over work follows its pre-production states and common tail", async () => {
  const {projectDir} = await createWorkflowProject();
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief hash approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "inputs frozen"});
  await createWorkItem(projectDir, coordinator, {id: "vo-001", title: "Launch short", modality: "voice-over"});

  for (const to of [
    "SCRIPT_DRAFT", "AWAITING_SCRIPT_APPROVAL", "SCRIPT_APPROVED", "AUDIO_READY",
    "TRANSCRIPT_READY", "STORY_PLANNED", "DESIGN_PLANNED", "DESIGN_APPROVED",
    "EXECUTING", "CANDIDATE_FROZEN",
  ]) {
    await transitionWorkItem(projectDir, coordinator, {workItemId: "vo-001", ...transitionOptions(to)});
  }

  assert.equal(getWorkItem(await readWorkflowState(projectDir), "vo-001").state, "CANDIDATE_FROZEN");
});

test("work-item transition sequences are atomic when a later transition fails", async () => {
  const {projectDir} = await createWorkflowProject();
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "inputs frozen"});
  await createWorkItem(projectDir, coordinator, {id: "vo-atomic", title: "Atomic narration", modality: "voice-over"});
  for (const to of ["SCRIPT_DRAFT", "AWAITING_SCRIPT_APPROVAL", "SCRIPT_APPROVED"]) {
    await transitionWorkItem(projectDir, coordinator, {workItemId: "vo-atomic", ...transitionOptions(to)});
  }
  const before = await readWorkflowState(projectDir);

  await assert.rejects(transitionWorkItemSequence(projectDir, coordinator, [
    {workItemId: "vo-atomic", to: "AUDIO_READY", reason: "audio verified"},
    {workItemId: "vo-atomic", to: "STORY_PLANNED", reason: "illegal skip"},
  ]), /Illegal transition from AUDIO_READY to STORY_PLANNED/u);

  assert.deepEqual(await readWorkflowState(projectDir), before);
});

test("rejects a carousel transition through a video-only state", async () => {
  const {projectDir} = await createWorkflowProject();
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "inputs frozen"});
  await createWorkItem(projectDir, coordinator, {id: "carousel-001", title: "Launch cards", modality: "carousel"});

  await assert.rejects(
    transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-001", to: "TRANSCRIPT_READY", reason: "invalid route"}),
    /illegal transition/i,
  );
});

test("events retain their bytes and hash chain after later transitions", async () => {
  const {projectDir} = await createWorkflowProject();
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "inputs frozen"});
  await createWorkItem(projectDir, coordinator, {id: "raw-001", title: "Raw interview", modality: "raw-video"});
  const before = await readWorkflowState(projectDir);

  await transitionWorkItem(projectDir, coordinator, {workItemId: "raw-001", to: "MEDIA_INDEXED", reason: "probe complete"});
  const after = await readWorkflowState(projectDir);

  assert.deepEqual(after.events.slice(0, before.events.length), before.events);
  assert.equal(after.events.at(-1).previousEventHash, before.events.at(-1).eventHash);
});

test("workflow reads reject tampered event bytes", async () => {
  const {projectDir} = await createWorkflowProject();
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief approved"});
  const path = join(projectDir, "Plans", "workflow-state.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  state.events[0].reason = "tampered reason";
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  await assert.rejects(readWorkflowState(projectDir), /event hash/i);
});

test("workflow reads reject a relinked event whose own hash was recomputed", async () => {
  const {projectDir} = await createWorkflowProject();
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "inputs frozen"});
  const path = join(projectDir, "Plans", "workflow-state.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  state.events[1].previousEventHash = null;
  const {eventHash, ...unsigned} = state.events[1];
  state.events[1].eventHash = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  await assert.rejects(readWorkflowState(projectDir), /event hash chain/i);
});

test("workflow reads reject malformed event shape even when later state is otherwise valid", async () => {
  const {projectDir} = await createWorkflowProject();
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief approved"});
  const path = join(projectDir, "Plans", "workflow-state.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  delete state.events[0].actorId;
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  await assert.rejects(readWorkflowState(projectDir), /event/i);
});

test("workflow mutation rejects a stale manifest pointer", async () => {
  const {projectDir} = await createWorkflowProject();
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief approved"});
  const path = join(projectDir, "Plans", "workflow-state.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, `${JSON.stringify(state)}\n`, "utf8");
  const staleBytes = await readFile(path, "utf8");

  await assert.rejects(
    transitionProject(projectDir, coordinator, {to: "READY", reason: "inputs frozen"}),
    /workflow state pointer/i,
  );
  assert.equal(await readFile(path, "utf8"), staleBytes);
});

test("pristine unversioned workflow state remains a narrow legacy initialization case", async () => {
  const {projectDir} = await createWorkflowProject();
  const path = join(projectDir, "Plans", "workflow-state.json");
  await writeFile(path, `${JSON.stringify({projectState: "DRAFT", workItems: [], events: []}, null, 2)}\n`, "utf8");

  assert.equal((await readWorkflowState(projectDir)).schemaVersion, 1);
  const state = await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "legacy initialized"});
  assert.equal(state.projectState, "BRIEF_APPROVED");
});

test("workflow path cannot be redirected outside the project", async () => {
  const {projectDir} = await createWorkflowProject();
  const manifestPath = join(projectDir, "project.yaml");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const victimPath = join(projectDir, "..", "..", "victim-workflow.json");
  const victim = `${JSON.stringify({schemaVersion: 1, projectState: "DRAFT", workItems: [], events: []}, null, 2)}\n`;
  await writeFile(victimPath, victim, "utf8");
  manifest.orchestration.workflowStatePath = "../../victim-workflow.json";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  await assert.rejects(
    transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "must stay confined"}),
    /workflow state path|project directory/i,
  );
  assert.equal(await readFile(victimPath, "utf8"), victim);
});

test("workflow writer rejects a fixed path whose resolved parent escapes the project", async () => {
  const {projectDir} = await createWorkflowProject();
  const outside = join(projectDir, "..", "outside-plans");
  const victimPath = join(outside, "workflow-state.json");
  const victim = `${JSON.stringify({schemaVersion: 1, projectState: "DRAFT", workItems: [], events: []}, null, 2)}\n`;
  await mkdir(outside);
  await writeFile(victimPath, victim, "utf8");
  await writeFile(join(outside, "approvals.jsonl"), "", "utf8");
  await rename(join(projectDir, "Plans"), join(projectDir, "Plans.original"));
  await symlink(outside, join(projectDir, "Plans"), "dir");

  await assert.rejects(
    transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "must stay confined"}),
    /workflow state path|project directory/i,
  );
  assert.equal(await readFile(victimPath, "utf8"), victim);
});

test("failure states resume only their recorded state and terminals cannot resume", async () => {
  const {projectDir} = await createWorkflowProject();
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "inputs frozen"});
  await createWorkItem(projectDir, coordinator, {id: "carousel-002", title: "Cards", modality: "carousel"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-002", to: "COPY_DRAFT", reason: "copy started"});

  await assert.rejects(
    transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-002", to: "REVISION_REQUIRED", reason: "needs revisions"}),
    /returnTo/i,
  );
  await transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-002", to: "REVISION_REQUIRED", reason: "needs revisions", returnTo: "COPY_DRAFT"});
  await assert.rejects(
    transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-002", to: "COPY_APPROVED", ...transitionOptions("COPY_APPROVED")}),
    /illegal transition/i,
  );
  await transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-002", to: "COPY_DRAFT", reason: "revision complete"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-002", to: "BLOCKED", reason: "awaiting client input"});
  await assert.rejects(
    transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-002", to: "COPY_APPROVED", ...transitionOptions("COPY_APPROVED")}),
    /illegal transition/i,
  );
  await transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-002", to: "COPY_DRAFT", reason: "client responded"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-002", to: "REJECTED", reason: "campaign cancelled"});
  await assert.rejects(
    transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-002", to: "COPY_DRAFT", reason: "not allowed"}),
    /illegal transition/i,
  );
});

test("gated transitions require artifact evidence and workflow writes update its manifest pointer", async () => {
  const {projectDir} = await createWorkflowProject();
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "inputs frozen"});
  await createWorkItem(projectDir, coordinator, {id: "vo-002", title: "Narration", modality: "voice-over"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "vo-002", to: "SCRIPT_DRAFT", reason: "script started"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "vo-002", to: "AWAITING_SCRIPT_APPROVAL", reason: "script submitted"});

  await assert.rejects(
    transitionWorkItem(projectDir, coordinator, {workItemId: "vo-002", to: "SCRIPT_APPROVED", reason: "missing evidence"}),
    /artifact reference/i,
  );
  await assert.rejects(
    transitionWorkItem(projectDir, coordinator, {workItemId: "vo-002", to: "SCRIPT_APPROVED", reason: "invalid evidence", artifactRef: {id: 1, sha256: "a".repeat(64)}}),
    /artifact reference/i,
  );
  await transitionWorkItem(projectDir, coordinator, {workItemId: "vo-002", to: "SCRIPT_APPROVED", reason: "script signed", artifactRef});

  const manifest = JSON.parse(await readFile(join(projectDir, "project.yaml"), "utf8"));
  assert.equal(
    manifest.orchestration.workflowStateSha256,
    await sha256File(join(projectDir, manifest.orchestration.workflowStatePath)),
  );
});

test("raw-video and multi-clip items follow their media pre-production routes", async () => {
  const {projectDir} = await createWorkflowProject();
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "inputs frozen"});

  for (const modality of ["raw-video", "multi-clip"]) {
    const workItemId = `${modality}-001`;
    await createWorkItem(projectDir, coordinator, {id: workItemId, title: modality, modality});
    for (const to of ["MEDIA_INDEXED", "TRANSCRIPTS_READY", "STORY_PLANNED", "DESIGN_PLANNED"]) {
      await transitionWorkItem(projectDir, coordinator, {workItemId, to, reason: `enter ${to}`});
    }
    assert.equal(getWorkItem(await readWorkflowState(projectDir), workItemId).state, "DESIGN_PLANNED");
  }
});

test("carousel work follows its pre-production route and common tail", async () => {
  const {projectDir} = await createWorkflowProject();
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "inputs frozen"});
  await createWorkItem(projectDir, coordinator, {id: "carousel-003", title: "Launch cards", modality: "carousel"});

  for (const to of ["COPY_DRAFT", "AWAITING_COPY_APPROVAL", "COPY_APPROVED", "CAROUSEL_PLANNED", "DESIGN_PLANNED", "DESIGN_APPROVED", "EXECUTING", "CANDIDATE_FROZEN"]) {
    await transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-003", ...transitionOptions(to)});
  }
  assert.equal(getWorkItem(await readWorkflowState(projectDir), "carousel-003").state, "CANDIDATE_FROZEN");
});

test("revision-required work may block and resumes with its return target", async () => {
  const {projectDir} = await createWorkflowProject();
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "inputs frozen"});
  await createWorkItem(projectDir, coordinator, {id: "carousel-004", title: "Revision", modality: "carousel"});
  assert.equal(getWorkItem(await readWorkflowState(projectDir), "carousel-004").revision, 1);
  await transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-004", to: "COPY_DRAFT", reason: "copy started"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-004", to: "REVISION_REQUIRED", reason: "finding opened", returnTo: "COPY_DRAFT"});

  await transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-004", to: "BLOCKED", reason: "missing approval authority"});
  let item = getWorkItem(await readWorkflowState(projectDir), "carousel-004");
  assert.equal(item.revision, 2);
  assert.equal(item.resumeState, "REVISION_REQUIRED");
  assert.equal(item.returnTo, "COPY_DRAFT");
  await transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-004", to: "REVISION_REQUIRED", reason: "authority restored"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-004", to: "COPY_DRAFT", reason: "revision resumed"});
  item = getWorkItem(await readWorkflowState(projectDir), "carousel-004");
  assert.equal(item.state, "COPY_DRAFT");
  assert.equal(item.revision, 2);
});

test("concurrent authorized work-item updates retain both events", async () => {
  const {projectDir} = await createWorkflowProject();
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "inputs frozen"});

  await Promise.all([
    createWorkItem(projectDir, coordinator, {id: "raw-concurrent", title: "Raw", modality: "raw-video"}),
    createWorkItem(projectDir, coordinator, {id: "multi-concurrent", title: "Multi", modality: "multi-clip"}),
  ]);

  const state = await readWorkflowState(projectDir);
  assert.deepEqual(state.workItems.map(({id}) => id).sort(), ["multi-concurrent", "raw-concurrent"]);
  assert.equal(state.events.length, 4);
  assert.ok(state.events.every((event, index) => event.previousEventHash === (index ? state.events[index - 1].eventHash : null)));
  const manifest = JSON.parse(await readFile(join(projectDir, "project.yaml"), "utf8"));
  assert.equal(manifest.orchestration.workflowStateSha256, await sha256File(join(projectDir, manifest.orchestration.workflowStatePath)));
});

test("equivalent project paths share one workflow update queue", async () => {
  const {projectDir} = await createWorkflowProject();
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "inputs frozen"});

  await Promise.all([
    createWorkItem(projectDir, coordinator, {id: "raw-alias", title: "Raw", modality: "raw-video"}),
    createWorkItem(`${projectDir}/.`, coordinator, {id: "multi-alias", title: "Multi", modality: "multi-clip"}),
  ]);

  const state = await readWorkflowState(projectDir);
  assert.deepEqual(state.workItems.map(({id}) => id).sort(), ["multi-alias", "raw-alias"]);
  assert.equal(state.events.length, 4);
});

test("conflicting concurrent project updates reject rather than overwrite evidence", async () => {
  const {projectDir} = await createWorkflowProject();
  const results = await Promise.allSettled([
    transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "first approval"}),
    transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "second approval"}),
  ]);

  assert.deepEqual(results.map(({status}) => status).sort(), ["fulfilled", "rejected"]);
  const state = await readWorkflowState(projectDir);
  assert.equal(state.projectState, "BRIEF_APPROVED");
  assert.equal(state.events.length, 1);
});

test("every gated state rejects transitions without artifact evidence", async () => {
  const {projectDir} = await createWorkflowProject();
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "inputs frozen"});
  await createWorkItem(projectDir, coordinator, {id: "vo-gates", title: "Voice gates", modality: "voice-over"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "vo-gates", to: "SCRIPT_DRAFT", reason: "script started"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "vo-gates", to: "AWAITING_SCRIPT_APPROVAL", reason: "script submitted"});

  for (const to of ["SCRIPT_APPROVED", "DESIGN_APPROVED", "CANDIDATE_FROZEN", "TECH_PASSED", "CREATIVE_PASSED", "APPROVED", "RELEASED"]) {
    await assert.rejects(
      transitionWorkItem(projectDir, coordinator, {workItemId: "vo-gates", to, reason: `missing ${to}`}),
      /artifact reference/i,
    );
    await transitionWorkItem(projectDir, coordinator, {workItemId: "vo-gates", ...transitionOptions(to)});
    if (to === "SCRIPT_APPROVED") {
      for (const state of ["AUDIO_READY", "TRANSCRIPT_READY", "STORY_PLANNED", "DESIGN_PLANNED"]) {
        await transitionWorkItem(projectDir, coordinator, {workItemId: "vo-gates", to: state, reason: `enter ${state}`});
      }
    } else if (to === "DESIGN_APPROVED") {
      await transitionWorkItem(projectDir, coordinator, {workItemId: "vo-gates", to: "EXECUTING", reason: "execution started"});
    }
  }

  await createWorkItem(projectDir, coordinator, {id: "carousel-gates", title: "Copy gate", modality: "carousel"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-gates", to: "COPY_DRAFT", reason: "copy started"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-gates", to: "AWAITING_COPY_APPROVAL", reason: "copy submitted"});
  await assert.rejects(
    transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-gates", to: "COPY_APPROVED", reason: "missing copy evidence"}),
    /artifact reference/i,
  );
});

test("only the coordinator may create or transition workflow state", async () => {
  const {projectDir} = await createWorkflowProject();
  await assert.rejects(
    transitionProject(projectDir, {actorId: "editor-1", actorRole: "premiere-executor"}, {to: "BRIEF_APPROVED", reason: "unauthorized"}),
    /coordinator/i,
  );
});

test("SUPERSEDED transitions require artifact evidence", async () => {
  const {projectDir} = await createWorkflowProject();
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "inputs frozen"});
  await createWorkItem(projectDir, coordinator, {id: "raw-evidence", title: "Raw interview", modality: "raw-video"});

  await assert.rejects(
    transitionWorkItem(projectDir, coordinator, {workItemId: "raw-evidence", to: "SUPERSEDED", reason: "parent changed"}),
    /artifact reference/i,
  );
});

test("a changed artifact parent supersedes its dependent work item", async () => {
  const {projectDir} = await createWorkflowProject();
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "inputs frozen"});
  await createWorkItem(projectDir, coordinator, {id: "raw-superseded", title: "Raw interview", modality: "raw-video"});
  for (const to of ["MEDIA_INDEXED", "TRANSCRIPTS_READY", "STORY_PLANNED", "DESIGN_PLANNED"]) {
    await transitionWorkItem(projectDir, coordinator, {workItemId: "raw-superseded", to, reason: `enter ${to}`});
  }
  const designPlan = createArtifactEnvelope({
    artifactId: "design-plan-001", revision: 1, workItemId: "raw-superseded", modality: "raw-video",
    parents: [{artifactId: "transcript-001", sha256: "a".repeat(64)}],
    producer: {actorId: "design-director-1", role: "design-director"},
    versions: {tool: "content-hub@0.2.0", template: null, model: null, policy: "bizibeast-v1"},
    status: "frozen", deviations: [], payload: {},
  });
  const stored = await writeImmutableArtifact(projectDir, "Plans/design-plan-v001.json", designPlan);
  const storedArtifactRef = {id: designPlan.artifactId, sha256: stored.sha256};

  assert.equal(await verifyArtifactParentsOrSupersede(projectDir, coordinator, designPlan, new Map([["transcript-001", "a".repeat(64)]]), storedArtifactRef), true);
  assert.equal(getWorkItem(await readWorkflowState(projectDir), "raw-superseded").state, "DESIGN_PLANNED");
  await assert.rejects(
    verifyArtifactParentsOrSupersede(projectDir, coordinator, designPlan, new Map([["transcript-001", "a".repeat(64)]]), {id: designPlan.artifactId}),
    /stored artifact.*SHA-256/i,
  );
  await assert.rejects(
    verifyArtifactParentsOrSupersede(projectDir, coordinator, designPlan, new Map([["transcript-001", "a".repeat(64)]]), {...storedArtifactRef, id: "wrong-artifact"}),
    /stored artifact id/i,
  );
  assert.equal(getWorkItem(await readWorkflowState(projectDir), "raw-superseded").state, "DESIGN_PLANNED");
  await assert.rejects(
    verifyArtifactParentsOrSupersede(projectDir, coordinator, designPlan, new Map([["transcript-001", "b".repeat(64)]]), {...storedArtifactRef, id: "wrong-artifact"}),
    /stored artifact id/i,
  );
  assert.equal(getWorkItem(await readWorkflowState(projectDir), "raw-superseded").state, "DESIGN_PLANNED");
  await assert.rejects(
    verifyArtifactParentsOrSupersede(projectDir, coordinator, designPlan, new Map([["transcript-001", "b".repeat(64)]]), storedArtifactRef),
    /parent hash changed: transcript-001/i,
  );
  assert.equal(getWorkItem(await readWorkflowState(projectDir), "raw-superseded").state, "SUPERSEDED");
  assert.deepEqual((await readWorkflowState(projectDir)).events.at(-1).artifactRef, storedArtifactRef);
});
