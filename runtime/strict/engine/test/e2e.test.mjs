import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {copyFile, mkdir, mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {readApprovals, recordApproval} from "../src/approvals.mjs";
import {createArtifactEnvelope, writeImmutableArtifact} from "../src/artifacts.mjs";
import {freezeCandidateBundle, verifyCandidateBundle} from "../src/candidates.mjs";
import {sha256File} from "../src/checksum.mjs";
import {ingestFiles} from "../src/ingest.mjs";
import {createProject} from "../src/project.mjs";
import {qcCheck, observed} from "../src/qc-check.mjs";
import {runQc} from "../src/qc.mjs";
import {markDelivered, promotePassingBundle, recordRelease} from "../src/release.mjs";
import {listFinalDeliverables} from "../src/status.mjs";
import {createWorkItem, getWorkItem, readWorkflowState, transitionProject, transitionWorkItem} from "../src/workflow.mjs";

const coordinator = {actorId: "content-hub-coordinator", actorRole: "coordinator"};
const policyVersion = "bizibeast-v1";

async function storeArtifact(projectDir, path, input) {
  const artifact = createArtifactEnvelope({
    ...input,
    versions: {tool: "fixture", template: "fixture", model: "none", policy: policyVersion},
    status: input.status ?? "frozen",
  });
  const stored = await writeImmutableArtifact(projectDir, path, artifact);
  return {artifact, path: stored.path, ref: {id: artifact.artifactId, sha256: stored.sha256}};
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ["ignore", "pipe", "pipe"]});
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed: ${stderr}`)));
  });
}

test("disposable video project releases and delivers one exact passing candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-e2e-"));
  const source = join(root, "source.mp4");
  await run("zsh", ["scripts/demo/create-fixture.sh", source]);
  const {projectDir} = await createProject(root, {
    name: "Content Hub Smoke",
    editors: ["premiere", "diffusion-studio"],
    mode: "semi-autonomous",
    aspect: "16:9",
  });
  const [ingested] = await ingestFiles(projectDir, [source], "source", {}, coordinator);
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "inputs frozen"});
  await createWorkItem(projectDir, coordinator, {id: "content-hub-smoke", title: "Smoke video", modality: "raw-video"});
  for (const to of ["MEDIA_INDEXED", "TRANSCRIPTS_READY", "STORY_PLANNED", "DESIGN_PLANNED"]) {
    await transitionWorkItem(projectDir, coordinator, {workItemId: "content-hub-smoke", to, reason: `enter ${to}`});
  }
  const script = await storeArtifact(projectDir, "Plans/script-v001.json", {
    artifactId: "script-001", revision: 1, workItemId: "content-hub-smoke", modality: "raw-video",
    parents: [], producer: {actorId: "script-1", role: "script-editorial"}, payload: {kind: "script"},
  });
  const design = await storeArtifact(projectDir, "Plans/design-plan-v001.json", {
    artifactId: "design-plan-001", revision: 1, workItemId: "content-hub-smoke", modality: "raw-video",
    parents: [{artifactId: script.ref.id, sha256: script.ref.sha256}],
    producer: {actorId: "design-1", role: "design-director"}, payload: {kind: "design-plan"},
  });
  await recordApproval(projectDir, coordinator, {
    kind: "design", workItemId: "content-hub-smoke", subject: {artifactId: design.ref.id, sha256: design.ref.sha256},
    decision: "approved", approver: {actorId: "design-approver-1", role: "design-approver"}, origin: "bizibeast",
    policyVersion, producerActorId: design.artifact.producer.actorId,
  });
  await transitionWorkItem(projectDir, coordinator, {
    workItemId: "content-hub-smoke", to: "DESIGN_APPROVED", reason: "design approved", artifactRef: design.ref,
  });
  await transitionWorkItem(projectDir, coordinator, {workItemId: "content-hub-smoke", to: "EXECUTING", reason: "execution started"});

  const candidateDir = join(projectDir, "Renders", "Candidates", "content-hub-smoke", "v001");
  const master = join(candidateDir, "content-hub-smoke-v001.mp4");
  await mkdir(candidateDir, {recursive: true});
  await copyFile(ingested.absolutePath, master);
  const report = await runQc(projectDir, master);
  const scriptApproval = await recordApproval(projectDir, coordinator, {
    kind: "script",
    workItemId: "content-hub-smoke",
    subject: {artifactId: script.ref.id, sha256: script.ref.sha256},
    decision: "approved",
    approver: {actorId: "human-yash", role: "human"},
    origin: "user",
    policyVersion: "bizibeast-v1",
  });
  const bundle = await freezeCandidateBundle(projectDir, coordinator, {
    workItemId: "content-hub-smoke",
    modality: "raw-video",
    revision: 1,
    outputs: [{path: "Renders/Candidates/content-hub-smoke/v001/content-hub-smoke-v001.mp4", kind: "master", order: 1}],
    inputLock: {
      artifacts: [script.ref, design.ref],
      approvals: [{id: scriptApproval.id, subjectSha256: script.ref.sha256}],
      assets: [],
    },
    lineage: {sourceIds: [ingested.id], assetIds: []},
    settings: {profileId: "smoke-v1", profileHash: "a".repeat(64), width: 1920, height: 1080, fps: 30, audioSampleRate: 48000},
    producer: {actorId: "premiere-1", role: "premiere-executor"},
    versions: {premiere: "fixture", hyperframes: null, policy: "bizibeast-v1"},
    requestedDerivatives: ["mp4"],
  });
  await transitionWorkItem(projectDir, coordinator, {
    workItemId: "content-hub-smoke",
    to: "CANDIDATE_FROZEN",
    reason: "candidate frozen",
    artifactRef: {id: "candidate:content-hub-smoke:v001", sha256: bundle.bundleHash},
  });
  const verified = await verifyCandidateBundle(projectDir, bundle.bundlePath);
  const candidateRef = {id: "candidate:content-hub-smoke:v001", sha256: bundle.bundleHash};
  const technical = await storeArtifact(projectDir, "QC/content-hub-smoke/v001/technical-qc.json", {
    artifactId: "technical-qc-content-hub-smoke-v001", revision: 1, workItemId: "content-hub-smoke", modality: "raw-video",
    parents: [script.ref, design.ref].map(({id: artifactId, sha256}) => ({artifactId, sha256})),
    producer: {actorId: "technical-1", role: "technical-qc-validator"}, status: "passed",
    payload: {
      kind: "technical-qc", candidateBundleHash: bundle.bundleHash, policyVersion, profileId: "smoke-v1",
      profileHash: "a".repeat(64), pass: true,
      checks: [qcCheck("media.decode", true, "hard", "premiere-executor", [observed("master", "decoded", "decoded")])],
      reportFiles: {json: "QC/content-hub-smoke/v001/technical-qc.json", markdown: "QC/content-hub-smoke/v001/technical-qc.md"},
    },
  });
  await transitionWorkItem(projectDir, coordinator, {
    workItemId: "content-hub-smoke", to: "TECH_PASSED", reason: "technical QC passed", artifactRef: technical.ref,
  });
  const creative = await storeArtifact(projectDir, "QC/content-hub-smoke/v001/creative-qc.json", {
    artifactId: "creative-qc-content-hub-smoke-v001", revision: 1, workItemId: "content-hub-smoke", modality: "raw-video",
    parents: [
      {artifactId: candidateRef.id, sha256: candidateRef.sha256},
      {artifactId: technical.ref.id, sha256: technical.ref.sha256},
    ],
    producer: {actorId: "creative-1", role: "creative-qc-reviewer"}, status: "passed",
    payload: {
      kind: "creative-qc", candidateBundleHash: bundle.bundleHash, policyVersion, profileId: "smoke-v1",
      profileHash: "a".repeat(64), technicalEvidenceSha256: technical.ref.sha256, pass: true,
      reportFiles: {json: "QC/content-hub-smoke/v001/creative-qc.json"},
    },
  });
  await transitionWorkItem(projectDir, coordinator, {
    workItemId: "content-hub-smoke", to: "CREATIVE_PASSED", reason: "creative QC passed", artifactRef: creative.ref,
  });
  await recordApproval(projectDir, coordinator, {
    kind: "creative", workItemId: "content-hub-smoke", subject: {artifactId: creative.ref.id, sha256: creative.ref.sha256},
    bundleHash: bundle.bundleHash, decision: "approved",
    approver: {actorId: "creative-1", role: "creative-qc-reviewer"}, origin: "bizibeast", policyVersion,
  });
  await recordApproval(projectDir, coordinator, {
    kind: "human-release", workItemId: "content-hub-smoke", subject: {artifactId: candidateRef.id, sha256: bundle.bundleHash},
    bundleHash: bundle.bundleHash, decision: "approved", approver: {actorId: "human-yash", role: "human"},
    origin: "user", policyVersion,
  });
  await transitionWorkItem(projectDir, coordinator, {
    workItemId: "content-hub-smoke", to: "APPROVED", reason: "release approved", artifactRef: creative.ref,
  });
  const receipt = await promotePassingBundle(projectDir, bundle.bundlePath, {
    promoter: {actorId: "release-1", role: "release-promoter"}, technicalEvidencePath: technical.path,
    creativeEvidencePath: creative.path, approvals: await readApprovals(projectDir), policyVersion,
  });
  await recordRelease(projectDir, coordinator, receipt.receiptPath);
  const delivered = await listFinalDeliverables(projectDir, bundle.workItemId);
  await markDelivered(projectDir, coordinator, bundle.workItemId, receipt.receiptPath);

  assert.equal(report.pass, true);
  assert.equal(report.streams.video, 1);
  assert.equal(report.streams.audio, 1);
  assert.match(report.input, /content-hub-smoke-v001\.mp4$/u);
  assert.equal(verified.bundleHash, bundle.bundleHash);
  assert.deepEqual(delivered.files.map(({path}) => path), ["Final/Masters/content-hub-smoke/v001/content-hub-smoke-v001.mp4"]);
  assert.equal(await sha256File(join(projectDir, delivered.files[0].path)), await sha256File(master));
  assert.equal(getWorkItem(await readWorkflowState(projectDir), bundle.workItemId).state, "DELIVERED");
});
