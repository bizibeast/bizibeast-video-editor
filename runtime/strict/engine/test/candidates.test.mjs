import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import test from "node:test";

import {recordApproval} from "../src/approvals.mjs";
import {freezeCandidateBundle, verifyCandidateBundle} from "../src/candidates.mjs";
import {createProject} from "../src/project.mjs";

const coordinator = {actorId: "content-hub-coordinator", actorRole: "coordinator"};
const hash = (character) => character.repeat(64);

async function createCandidateProject() {
  const root = await mkdtemp(join(tmpdir(), "content-hub-candidates-"));
  const {projectDir} = await createProject(root, {name: "Candidate Bundles", aspect: "9:16"});
  const scriptApproval = await recordApproval(projectDir, coordinator, {
    kind: "script", workItemId: "raw-001", subject: {artifactId: "script-001", sha256: hash("a")},
    decision: "approved", approver: {actorId: "human-yash", role: "human"}, origin: "user", policyVersion: "bizibeast-v1",
  });
  const copyApproval = await recordApproval(projectDir, coordinator, {
    kind: "carousel-copy", workItemId: "carousel-001", subject: {artifactId: "carousel-copy-001", sha256: hash("c")},
    decision: "approved", approver: {actorId: "human-yash", role: "human"}, origin: "user", policyVersion: "bizibeast-v1",
  });
  return {projectDir, scriptApproval, copyApproval};
}

function videoInput(scriptApproval, overrides = {}) {
  return {
    workItemId: "raw-001", modality: "raw-video", revision: 1,
    outputs: [{path: "Renders/Candidates/raw-001/v001/master.mov", kind: "master", order: 1}],
    inputLock: {
      artifacts: [{id: "script-001", sha256: hash("a")}],
      approvals: [{id: scriptApproval.id, subjectSha256: hash("a")}],
      assets: [{id: "asset-001", sha256: hash("b")}],
    },
    lineage: {sourceIds: ["source-1"], assetIds: ["asset-001"]},
    settings: {profileId: "vertical-short-v1", width: 1080, height: 1920, fps: 30, audioSampleRate: 48000},
    producer: {actorId: "premiere-1", role: "premiere-executor"},
    versions: {premiere: "26.0", hyperframes: null, policy: "bizibeast-v1"},
    requestedDerivatives: ["mp4"],
    ...overrides,
  };
}

function carouselInput(copyApproval, overrides = {}) {
  const approvedCopySha256 = hash("c");
  return {
    workItemId: "carousel-001", modality: "carousel", revision: 1,
    outputs: [
      {path: "Renders/Carousels/carousel-001/v001/slide-01-4x5.png", kind: "carousel-slide", order: 1, slideId: "slide-01", format: "4:5", approvedCopySha256},
      {path: "Renders/Carousels/carousel-001/v001/slide-01-1x1.png", kind: "carousel-slide", order: 2, slideId: "slide-01", format: "1:1", approvedCopySha256},
      {path: "Renders/Carousels/carousel-001/v001/slide-02-4x5.png", kind: "carousel-slide", order: 3, slideId: "slide-02", format: "4:5", approvedCopySha256},
      {path: "Renders/Carousels/carousel-001/v001/slide-02-1x1.png", kind: "carousel-slide", order: 4, slideId: "slide-02", format: "1:1", approvedCopySha256},
    ],
    inputLock: {
      artifacts: [{id: "carousel-copy-001", sha256: approvedCopySha256}],
      approvals: [{id: copyApproval.id, subjectSha256: approvedCopySha256}],
      assets: [{id: "asset-001", sha256: hash("b")}],
    },
    lineage: {sourceIds: ["source-1"], assetIds: ["asset-001"]},
    settings: {profileId: "carousel-v1", width: 1080, height: 1350, fps: 30, audioSampleRate: 48000},
    producer: {actorId: "carousel-1", role: "carousel-lead"},
    versions: {premiere: null, hyperframes: "1.0", policy: "bizibeast-v1"},
    requestedDerivatives: ["pdf", "zip"],
    ...overrides,
  };
}

async function writeOutputs(projectDir, outputs) {
  for (const [index, output] of outputs.entries()) {
    const path = join(projectDir, output.path);
    await mkdir(dirname(path), {recursive: true});
    await writeFile(path, `output-${index}`, "utf8");
  }
}

test("freezes ordered files and verifies the exact bundle bytes", async () => {
  const {projectDir, scriptApproval} = await createCandidateProject();
  const input = videoInput(scriptApproval);
  await writeOutputs(projectDir, input.outputs);

  const bundle = await freezeCandidateBundle(projectDir, coordinator, input);

  assert.equal(bundle.files.length, 1);
  assert.match(bundle.bundleHash, /^[a-f0-9]{64}$/u);
  assert.equal(Object.hasOwn(bundle, "outputs"), false);
  assert.equal((await verifyCandidateBundle(projectDir, bundle.bundlePath)).bundleHash, bundle.bundleHash);
  assert.deepEqual(JSON.parse(await readFile(bundle.bundlePath, "utf8")), (({bundlePath, ...saved}) => saved)(bundle));
  await assert.rejects(freezeCandidateBundle(projectDir, coordinator, input), {code: "EEXIST"});
});

test("carousel bundle order is explicit and format pairs share a slide", async () => {
  const {projectDir, copyApproval} = await createCandidateProject();
  const input = carouselInput(copyApproval);
  await writeOutputs(projectDir, input.outputs);

  const bundle = await freezeCandidateBundle(projectDir, coordinator, input);

  assert.deepEqual(bundle.files.map(({slideId, format}) => [slideId, format]), [
    ["slide-01", "4:5"], ["slide-01", "1:1"], ["slide-02", "4:5"], ["slide-02", "1:1"],
  ]);
});

test("carousel bundle accepts requested PDF and ZIP derivatives without weakening slide validation", async () => {
  const {projectDir, copyApproval} = await createCandidateProject();
  const base = carouselInput(copyApproval);
  const input = carouselInput(copyApproval, {
    revision: 2,
    outputs: base.outputs.map((output) => ({...output, path: output.path.replace("v001", "v002")})).concat([
      {path: "Renders/Carousels/carousel-001/v002/carousel-001.pdf", kind: "derivative", order: 10_000, slideId: null, format: "pdf", approvedCopySha256: hash("c")},
      {path: "Renders/Carousels/carousel-001/v002/carousel-001.zip", kind: "derivative", order: 10_001, slideId: null, format: "zip", approvedCopySha256: hash("c")},
    ]),
  });
  await writeOutputs(projectDir, input.outputs);
  const bundle = await freezeCandidateBundle(projectDir, coordinator, input);

  assert.deepEqual(bundle.files.filter(({kind}) => kind === "derivative").map(({slideId, format}) => [slideId, format]), [
    [null, "pdf"], [null, "zip"],
  ]);
  const invalid = carouselInput(copyApproval, {
    revision: 3,
    outputs: [{...base.outputs[0], path: "Renders/Carousels/carousel-001/v003/slide-01-4x5.png", slideId: null}],
  });
  await writeOutputs(projectDir, invalid.outputs);
  await assert.rejects(freezeCandidateBundle(projectDir, coordinator, invalid), /carousel slide.*slideId/i);
});

test("verification rejects changed output bytes", async () => {
  const {projectDir, scriptApproval} = await createCandidateProject();
  const input = videoInput(scriptApproval);
  await writeOutputs(projectDir, input.outputs);
  const bundle = await freezeCandidateBundle(projectDir, coordinator, input);

  await writeFile(join(projectDir, bundle.files[0].path), "tampered");
  await assert.rejects(verifyCandidateBundle(projectDir, bundle.bundlePath), /file hash mismatch/i);
});

test("candidate paths and locks fail closed", async () => {
  const {projectDir, scriptApproval} = await createCandidateProject();
  const malformed = videoInput(scriptApproval, {
    outputs: [{path: "Final/Masters/raw-001.mov", kind: "master", order: 1}],
  });
  await writeOutputs(projectDir, malformed.outputs);
  await assert.rejects(freezeCandidateBundle(projectDir, coordinator, malformed), /candidate directory/i);

  const changedParent = videoInput(scriptApproval, {
    revision: 2,
    outputs: [{path: "Renders/Candidates/raw-001/v002/master.mov", kind: "master", order: 1}],
    inputLock: {
      artifacts: [{id: "script-001", sha256: hash("d")}],
      approvals: [{id: scriptApproval.id, subjectSha256: hash("a")}],
      assets: [],
    },
  });
  await writeOutputs(projectDir, changedParent.outputs);
  await assert.rejects(freezeCandidateBundle(projectDir, coordinator, changedParent), /input lock.*artifact/i);
});

test("a superseding approval prevents a stale candidate freeze", async () => {
  const {projectDir, scriptApproval} = await createCandidateProject();
  const input = videoInput(scriptApproval);
  await writeOutputs(projectDir, input.outputs);
  await recordApproval(projectDir, coordinator, {
    kind: "script", workItemId: "raw-001", subject: {artifactId: "script-001", sha256: hash("a")},
    decision: "rejected", approver: {actorId: "human-yash", role: "human"}, origin: "user", policyVersion: "bizibeast-v1",
  });

  await assert.rejects(freezeCandidateBundle(projectDir, coordinator, input), /current.*approval|approval.*current/i);
});

test("a newer identical approval cannot make an old locked approval current", async () => {
  const {projectDir, scriptApproval} = await createCandidateProject();
  const input = videoInput(scriptApproval);
  await writeOutputs(projectDir, input.outputs);
  await recordApproval(projectDir, coordinator, {
    kind: "script", workItemId: "raw-001", subject: {artifactId: "script-001", sha256: hash("a")},
    decision: "approved", approver: {actorId: "human-yash", role: "human"}, origin: "user", policyVersion: "bizibeast-v1",
  });

  await assert.rejects(freezeCandidateBundle(projectDir, coordinator, input), /current.*approval|approval.*current/i);
});

test("candidate bundles require an exact producing actor and executor role", async () => {
  const {projectDir, scriptApproval} = await createCandidateProject();
  const input = videoInput(scriptApproval, {producer: {actorId: "premiere-1", role: "creative-qc-reviewer"}});
  await writeOutputs(projectDir, input.outputs);

  await assert.rejects(freezeCandidateBundle(projectDir, coordinator, input), /candidate producer.*role/i);
  await assert.rejects(
    freezeCandidateBundle(projectDir, coordinator, videoInput(scriptApproval, {producer: {actorId: "premiere-1", role: "premiere-executor", extra: true}})),
    /candidate producer.*actorId and role/i,
  );
});

test("creative approval cannot hide candidate self-review behind a claimed producer", async () => {
  const {projectDir, scriptApproval} = await createCandidateProject();
  const input = videoInput(scriptApproval);
  await writeOutputs(projectDir, input.outputs);
  const bundle = await freezeCandidateBundle(projectDir, coordinator, input);

  await assert.rejects(recordApproval(projectDir, coordinator, {
    kind: "creative",
    workItemId: "raw-001",
    subject: {artifactId: "creative-qc-001", sha256: hash("c")},
    bundleHash: bundle.bundleHash,
    decision: "approved",
    approver: {actorId: "premiere-1", role: "creative-qc-reviewer"},
    origin: "bizibeast",
    policyVersion: "bizibeast-v1",
    producerActorId: "declared-other",
  }), /producer.*bundle|cannot review its own work/i);
});

test("creative approval records the verified bundle producer for an independent reviewer", async () => {
  const {projectDir, scriptApproval} = await createCandidateProject();
  const input = videoInput(scriptApproval);
  await writeOutputs(projectDir, input.outputs);
  const bundle = await freezeCandidateBundle(projectDir, coordinator, input);

  const approval = await recordApproval(projectDir, coordinator, {
    kind: "creative",
    workItemId: "raw-001",
    subject: {artifactId: "creative-qc-001", sha256: hash("c")},
    bundleHash: bundle.bundleHash,
    decision: "approved",
    approver: {actorId: "creative-1", role: "creative-qc-reviewer"},
    origin: "bizibeast",
    policyVersion: "bizibeast-v1",
  });

  assert.equal(approval.producerActorId, bundle.producer.actorId);
});

test("candidate artifact locks accept current colon-qualified ids", async () => {
  const {projectDir, scriptApproval} = await createCandidateProject();
  const input = videoInput(scriptApproval);
  input.inputLock.artifacts.push({id: "video-design-plan:raw-001:v001", sha256: hash("d")});
  await writeOutputs(projectDir, input.outputs);

  const bundle = await freezeCandidateBundle(projectDir, coordinator, input);

  assert.equal(bundle.inputLock.artifacts.at(-1).id, "video-design-plan:raw-001:v001");
});

test("candidate ids reject paths controls URLs undocumented schemes and colon assets", async () => {
  const invalidArtifactIds = ["../plan", "plan/file", "plan\\file", "plan id", "plan\nnext", "https://example.test/plan", "file:plan",
    "ssh:host", "git:repository", "urn:example:test", "unknown-prefix:raw-001:v001", "plan::v001", `${"a".repeat(256)}:v1`];
  for (const invalidId of invalidArtifactIds) {
    const {projectDir, scriptApproval} = await createCandidateProject();
    const input = videoInput(scriptApproval);
    input.inputLock.artifacts.push({id: invalidId, sha256: hash("d")});
    await writeOutputs(projectDir, input.outputs);
    await assert.rejects(freezeCandidateBundle(projectDir, coordinator, input), /safe identifier/u);
  }
  const {projectDir, scriptApproval} = await createCandidateProject();
  const input = videoInput(scriptApproval);
  input.inputLock.assets[0].id = "asset:001";
  await writeOutputs(projectDir, input.outputs);
  await assert.rejects(freezeCandidateBundle(projectDir, coordinator, input), /safe identifier/u);
});
