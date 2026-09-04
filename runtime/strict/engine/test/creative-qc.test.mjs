import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {recordApproval} from "../src/approvals.mjs";
import {createArtifactEnvelope, writeImmutableArtifact} from "../src/artifacts.mjs";
import {freezeCandidateBundle} from "../src/candidates.mjs";
import {qcCheck} from "../src/qc-check.mjs";
import {resolveTechnicalProfile} from "../src/qc-profiles.mjs";
import {createProject} from "../src/project.mjs";
import {CREATIVE_DIMENSIONS, recordCreativeReview, scoreCreativeReview} from "../src/creative-qc.mjs";

const coordinator = {actorId: "content-hub-coordinator", actorRole: "coordinator"};
const versions = {tool: "fixture", template: "fixture", model: "none", policy: "bizibeast-v1"};
const passingScores = {
  brandFidelity: 5, hookClarity: 5, editorialComposition: 4,
  distinctiveness: 4, craftPolish: 5, narrativeProgression: 4, modalityFit: 5,
};

function locators() {
  return [{type: "timecode", value: "00:00:01.200"}];
}

function passingReview(contractRef, overrides = {}) {
  return {
    reviewer: {actorId: "creative-1", role: "creative-qc-reviewer"},
    policyVersion: "bizibeast-v1", scores: passingScores,
    evidence: Object.fromEntries(Object.keys(passingScores).map((id) => [id, {observation: `The frozen brief/style/blueprint supports ${id}.`, locators: locators(), contractRef}])),
    hardFailures: [], heroMoment: "The opening promise resolves in the proof shot.",
    strongestEvidence: "The proof shot makes the style contract concrete.",
    weakestUnresolvedChoice: "The final transition remains intentionally restrained.",
    ...overrides,
  };
}

async function storeArtifact(projectDir, path, input) {
  const artifact = createArtifactEnvelope({...input, versions, status: "frozen"});
  const stored = await writeImmutableArtifact(projectDir, path, artifact);
  return {artifact, ref: {id: artifact.artifactId, sha256: stored.sha256}};
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "content-hub-creative-qc-"));
  const {projectDir} = await createProject(root, {name: "Creative QC", editors: ["premiere"]});
  const script = await storeArtifact(projectDir, "Plans/script-v001.json", {
    artifactId: "script-001", revision: 1, workItemId: "raw-001", modality: "raw-video", parents: [],
    producer: {actorId: "script-1", role: "script-editorial"}, payload: {kind: "script"},
  });
  const brief = await storeArtifact(projectDir, "Plans/brief-v001.json", {
    artifactId: "brief-001", revision: 1, workItemId: "raw-001", modality: "raw-video", parents: [],
    producer: {actorId: "design-1", role: "design-director"}, payload: {kind: "brief"},
  });
  const approval = await recordApproval(projectDir, coordinator, {
    kind: "script", workItemId: "raw-001", subject: {artifactId: script.artifact.artifactId, sha256: script.ref.sha256},
    decision: "approved", approver: {actorId: "human-yash", role: "human"}, origin: "user", policyVersion: "bizibeast-v1",
  });
  const profile = resolveTechnicalProfile("vertical-short-v1");
  const candidateDir = join(projectDir, "Renders/Candidates/raw-001/v001");
  await mkdir(candidateDir, {recursive: true});
  await writeFile(join(candidateDir, "master.mp4"), "candidate bytes");
  const bundle = await freezeCandidateBundle(projectDir, coordinator, {
    workItemId: "raw-001", modality: "raw-video", revision: 1,
    outputs: [{path: "Renders/Candidates/raw-001/v001/master.mp4", kind: "master", order: 1}],
    inputLock: {artifacts: [script.ref, brief.ref], approvals: [{id: approval.id, subjectSha256: script.ref.sha256}], assets: []},
    lineage: {sourceIds: ["source-001"], assetIds: []},
    settings: {profileId: profile.id, profileHash: profile.profileHash, codec: "h264"},
    producer: {actorId: "premiere-1", role: "premiere-executor"}, versions, requestedDerivatives: ["mp4"],
  });
  const technical = createArtifactEnvelope({
    artifactId: `technical-qc-${bundle.workItemId}-v001`, revision: bundle.revision,
    workItemId: bundle.workItemId, modality: bundle.modality, parents: bundle.inputLock.artifacts.map(({id: artifactId, sha256}) => ({artifactId, sha256})),
    producer: {actorId: "technical-1", role: "technical-qc-validator"}, versions, status: "passed",
    payload: {
      kind: "technical-qc", candidateBundleHash: bundle.bundleHash, policyVersion: versions.policy,
      profileId: profile.id, profileHash: profile.profileHash, pass: true,
      checks: [qcCheck("bundle.profile", true, "hard", "premiere-executor", [{locator: "settings.profileHash", observed: profile.profileHash, expected: profile.profileHash}])],
      reportFiles: {json: `QC/${bundle.workItemId}/v001/technical-qc.json`, markdown: `QC/${bundle.workItemId}/v001/technical-qc.md`},
    },
  });
  const stored = await writeImmutableArtifact(projectDir, technical.payload.reportFiles.json, technical);
  await writeFile(join(projectDir, technical.payload.reportFiles.markdown), "# Technical QC PASS\n", {flag: "wx"});
  return {
    projectDir, bundle, profile, technical, technicalPath: join(projectDir, stored.path),
    contractRef: {artifactId: brief.artifact.artifactId, sha256: brief.ref.sha256},
    contractPath: join(projectDir, "Plans/brief-v001.json"), scriptRef: {artifactId: script.artifact.artifactId, sha256: script.ref.sha256},
  };
}

async function assertRejectedReview(fixtureInput, override, pattern) {
  await assert.rejects(recordCreativeReview(fixtureInput.projectDir, fixtureInput.bundle.bundlePath, fixtureInput.technicalPath, passingReview(fixtureInput.contractRef, override)), pattern);
}

test("computes the seven-dimension weighted 92-point passing verdict", () => {
  assert.deepEqual(CREATIVE_DIMENSIONS, {
    brandFidelity: 20, hookClarity: 15, editorialComposition: 15, distinctiveness: 15,
    craftPolish: 15, narrativeProgression: 10, modalityFit: 10,
  });
  assert.equal(scoreCreativeReview(passingScores), 92);
  assert.throws(() => scoreCreativeReview({...passingScores, hookClarity: 4.99}), /integer.*1.*5/i);
});

test("records one independent fully evidenced review against the exact passing technical envelope", async () => {
  const input = await fixture();
  const manifest = await readFile(join(input.projectDir, "project.yaml"), "utf8");
  const evidence = await recordCreativeReview(input.projectDir, input.bundle.bundlePath, input.technicalPath, passingReview(input.contractRef));
  assert.equal(evidence.payload.pass, true);
  assert.equal(evidence.payload.score, 92);
  assert.equal(evidence.payload.candidateBundleHash, input.bundle.bundleHash);
  assert.equal(evidence.payload.profileHash, input.profile.profileHash);
  assert.equal(evidence.payload.policyVersion, "bizibeast-v1");
  assert.deepEqual(JSON.parse(await readFile(join(input.projectDir, evidence.payload.reportFiles.json), "utf8")), evidence);
  assert.equal(await readFile(join(input.projectDir, "project.yaml"), "utf8"), manifest);
  await assert.rejects(recordCreativeReview(input.projectDir, input.bundle.bundlePath, input.technicalPath, passingReview(input.contractRef)), {code: "EEXIST"});
});

test("requires locator evidence and every reviewer synthesis field", async () => {
  const input = await fixture();
  await assertRejectedReview(input, {evidence: {}}, /evidence/i);
  for (const field of ["heroMoment", "strongestEvidence", "weakestUnresolvedChoice"]) {
    await assertRejectedReview(input, {[field]: ""}, new RegExp(field.replace(/[A-Z]/gu, (letter) => ` ${letter.toLowerCase()}`), "i"));
  }
  await assertRejectedReview(input, {evidence: {...passingReview(input.contractRef).evidence, hookClarity: {observation: "Clear hook.", locators: [], contractRef: input.contractRef}}}, /locator/i);
});

test("accepts frame and slide locators while keeping each dimension evidence-bound", async () => {
  const input = await fixture();
  const review = passingReview(input.contractRef);
  review.evidence.editorialComposition.locators = [{type: "frame", value: 36}];
  review.evidence.modalityFit.locators = [{type: "slide", value: "slide-03/1:1"}];
  const evidence = await recordCreativeReview(input.projectDir, input.bundle.bundlePath, input.technicalPath, review);
  assert.deepEqual(evidence.payload.evidence.editorialComposition.locators, [{type: "frame", value: 36}]);
  assert.deepEqual(evidence.payload.evidence.modalityFit.locators, [{type: "slide", value: "slide-03/1:1"}]);
});

test("requires every dimension to cite one exact frozen contract artifact", async () => {
  const input = await fixture();
  const missing = passingReview(input.contractRef);
  delete missing.evidence.hookClarity.contractRef;
  await assert.rejects(recordCreativeReview(input.projectDir, input.bundle.bundlePath, input.technicalPath, missing), /contract reference/i);
  await assertRejectedReview(input, {evidence: {...passingReview(input.contractRef).evidence, brandFidelity: {...passingReview(input.contractRef).evidence.brandFidelity, contractRef: {artifactId: "unlocked-001", sha256: "b".repeat(64)}}}}, /locked contract/i);
  await assertRejectedReview(input, {evidence: {...passingReview(input.contractRef).evidence, brandFidelity: {...passingReview(input.contractRef).evidence.brandFidelity, contractRef: input.scriptRef}}}, /kind.*allowed/i);
  await writeFile(input.contractPath, "tampered contract bytes");
  await assert.rejects(recordCreativeReview(input.projectDir, input.bundle.bundlePath, input.technicalPath, passingReview(input.contractRef)), /locked artifact unavailable/i);
});

test("rejects producer advocacy, unknown fields, malformed locators, and self-review before writing evidence", async () => {
  const input = await fixture();
  await assertRejectedReview(input, {producerJustification: "Please pass it."}, /producerJustification|unknown/i);
  await assertRejectedReview(input, {extra: true}, /unknown/i);
  await assertRejectedReview(input, {evidence: {...passingReview(input.contractRef).evidence, brandFidelity: {observation: "On brand.", locators: [{type: "timecode", value: "1.2"}], contractRef: input.contractRef}}}, /timecode/i);
  await assertRejectedReview(input, {reviewer: {actorId: input.bundle.producer.actorId, role: "creative-qc-reviewer"}}, /cannot review its own work/i);
  await assert.rejects(readFile(join(input.projectDir, "QC/raw-001/v001/creative-qc.json")), {code: "ENOENT"});
});

test("fails every creative pass threshold without weakening validation", async () => {
  const cases = [
    [{scores: {...passingScores, brandFidelity: 3}}, /brand/i],
    [{scores: {...passingScores, hookClarity: 3}}, /hook/i],
    [{scores: {...passingScores, craftPolish: 3}}, /craft/i],
    [{scores: {...passingScores, narrativeProgression: 2}}, /dimension/i],
    [{hardFailures: [{code: "brand-conflict", observation: "The frozen style contract is violated.", locators: locators()}]}, /hard failure/i],
  ];
  for (const [override] of cases) {
    const input = await fixture();
    const evidence = await recordCreativeReview(input.projectDir, input.bundle.bundlePath, input.technicalPath, passingReview(input.contractRef, override));
    assert.equal(evidence.payload.pass, false);
    assert.equal(evidence.status, "failed");
  }
});

test("treats hook clarity 4 as the exact highest reachable score below 90", async () => {
  const input = await fixture();
  const scores = {...passingScores, hookClarity: 4};
  assert.equal(scoreCreativeReview(scores), 89);
  const evidence = await recordCreativeReview(input.projectDir, input.bundle.bundlePath, input.technicalPath, passingReview(input.contractRef, {scores}));
  assert.equal(evidence.payload.score, 89);
  assert.equal(evidence.payload.pass, false);
});

test("rejects stale or non-passing technical evidence before writing creative evidence", async () => {
  const input = await fixture();
  const technical = JSON.parse(await readFile(input.technicalPath, "utf8"));
  technical.payload.pass = false;
  await writeFile(input.technicalPath, JSON.stringify(technical));
  await assert.rejects(recordCreativeReview(input.projectDir, input.bundle.bundlePath, input.technicalPath, passingReview(input.contractRef)), /technical.*pass/i);
});

test("rejects a technical record with mismatched policy, bundle, profile, work item, or revision", async () => {
  const changes = [
    (technical) => { technical.payload.policyVersion = "other-policy"; },
    (technical) => { technical.payload.candidateBundleHash = "b".repeat(64); },
    (technical) => { technical.payload.profileHash = "c".repeat(64); },
    (technical) => { technical.workItemId = "other-work-item"; },
    (technical) => { technical.revision = 2; },
  ];
  for (const change of changes) {
    const input = await fixture();
    const technical = JSON.parse(await readFile(input.technicalPath, "utf8"));
    change(technical);
    await writeFile(input.technicalPath, JSON.stringify(technical));
    await assert.rejects(recordCreativeReview(input.projectDir, input.bundle.bundlePath, input.technicalPath, passingReview(input.contractRef)), /technical evidence/i);
  }
});
