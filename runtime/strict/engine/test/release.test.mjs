import assert from "node:assert/strict";
import {execFile, spawn} from "node:child_process";
import {access, lstat, mkdir, mkdtemp, readFile, readdir, rename, rmdir, symlink, unlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import test from "node:test";

import {recordApproval, readApprovals} from "../src/approvals.mjs";
import {createArtifactEnvelope, writeImmutableArtifact} from "../src/artifacts.mjs";
import {freezeCandidateBundle} from "../src/candidates.mjs";
import {sha256File, sha256Value} from "../src/checksum.mjs";
import {createProject} from "../src/project.mjs";
import {markDelivered, promotePassingBundle, recordRelease} from "../src/release.mjs";
import {getProjectStatus, listFinalDeliverables} from "../src/status.mjs";
import {createWorkItem, getWorkItem, readWorkflowState, transitionProject, transitionWorkItem} from "../src/workflow.mjs";

const coordinator = {actorId: "coord-1", actorRole: "coordinator"};
const policyVersion = "bizibeast-v1";
const profileHash = "a".repeat(64);
const execFileAsync = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repositoryRoot, "bin/content-hub.mjs");

function cli(args) {
  return execFileAsync(process.execPath, [cliPath, ...args], {cwd: repositoryRoot});
}

function watchPath(script, args) {
  const child = spawn("sh", ["-c", script, "release-watcher", ...args], {stdio: ["ignore", "ignore", "pipe"]});
  let stderr = "";
  const timeout = setTimeout(() => child.kill(), 10_000);
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`release watcher failed: ${stderr || `status ${code}`}`));
    });
  });
}

async function storeArtifact(projectDir, path, input) {
  const artifact = createArtifactEnvelope({
    ...input,
    versions: {tool: "fixture", template: "fixture", model: "none", policy: policyVersion},
    status: input.status ?? "frozen",
  });
  const stored = await writeImmutableArtifact(projectDir, path, artifact);
  return {artifact, path: stored.path, ref: {id: artifact.artifactId, sha256: stored.sha256}};
}

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "content-hub-release-"));
  const {projectDir} = await createProject(root, {
    name: "Release Fixture",
    mode: "semi-autonomous",
    coordinatorActorId: coordinator.actorId,
  });
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "inputs frozen"});
  await createWorkItem(projectDir, coordinator, {id: "raw-001", title: "Release video", modality: "raw-video"});
  for (const to of ["MEDIA_INDEXED", "TRANSCRIPTS_READY", "STORY_PLANNED", "DESIGN_PLANNED"]) {
    await transitionWorkItem(projectDir, coordinator, {workItemId: "raw-001", to, reason: `enter ${to}`});
  }
  const script = await storeArtifact(projectDir, "Plans/script-v001.json", {
    artifactId: "script-001", revision: 1, workItemId: "raw-001", modality: "raw-video",
    parents: [], producer: {actorId: "script-1", role: "script-editorial"}, payload: {kind: "script"},
  });
  const design = await storeArtifact(projectDir, "Plans/design-plan-v001.json", {
    artifactId: "design-plan-001", revision: 1, workItemId: "raw-001", modality: "raw-video",
    parents: [script.ref].map(({id: artifactId, sha256}) => ({artifactId, sha256})),
    producer: {actorId: "design-1", role: "design-director"}, payload: {kind: "design-plan"},
  });
  const scriptApproval = await recordApproval(projectDir, coordinator, {
    kind: "script", workItemId: "raw-001", subject: {artifactId: script.ref.id, sha256: script.ref.sha256},
    decision: "approved", approver: {actorId: "human-1", role: "human"}, origin: "user", policyVersion,
  });
  await recordApproval(projectDir, coordinator, {
    kind: "design", workItemId: "raw-001", subject: {artifactId: design.ref.id, sha256: design.ref.sha256},
    decision: "approved", approver: {actorId: "design-approver-1", role: "design-approver"}, origin: "bizibeast",
    policyVersion, producerActorId: design.artifact.producer.actorId,
  });
  await transitionWorkItem(projectDir, coordinator, {
    workItemId: "raw-001", to: "DESIGN_APPROVED", reason: "design approved", artifactRef: design.ref,
  });
  await transitionWorkItem(projectDir, coordinator, {workItemId: "raw-001", to: "EXECUTING", reason: "execution started"});

  const candidatePath = "Renders/Candidates/raw-001/v001/master.mp4";
  await mkdir(join(projectDir, "Renders/Candidates/raw-001/v001"), {recursive: true});
  await writeFile(join(projectDir, candidatePath), "exact candidate bytes");
  const bundle = await freezeCandidateBundle(projectDir, coordinator, {
    workItemId: "raw-001", modality: "raw-video", revision: 1,
    outputs: [{path: candidatePath, kind: "master", order: 1}],
    inputLock: {
      artifacts: [script.ref, design.ref],
      approvals: [{id: scriptApproval.id, subjectSha256: script.ref.sha256}],
      assets: [],
    },
    lineage: {sourceIds: ["source-001"], assetIds: []},
    settings: {profileId: "fixture-v1", profileHash},
    producer: {actorId: "premiere-1", role: "premiere-executor"},
    versions: {tool: "fixture", template: "fixture", model: "none", policy: policyVersion},
    requestedDerivatives: ["mp4"],
  });
  const candidateRef = {id: "candidate:raw-001:v001", sha256: bundle.bundleHash};
  await transitionWorkItem(projectDir, coordinator, {
    workItemId: "raw-001", to: "CANDIDATE_FROZEN", reason: "candidate frozen", artifactRef: options.candidateArtifactRef ?? candidateRef,
  });

  const technical = await storeArtifact(projectDir, "QC/raw-001/v001/technical-qc.json", {
    artifactId: "technical-qc-raw-001-v001", revision: 1, workItemId: "raw-001", modality: "raw-video",
    parents: [script.ref, design.ref].map(({id: artifactId, sha256}) => ({artifactId, sha256})),
    producer: {actorId: "technical-1", role: "technical-qc-validator"}, status: "passed",
    payload: {
      kind: "technical-qc", candidateBundleHash: bundle.bundleHash, policyVersion,
      profileId: "fixture-v1", profileHash, pass: true, checks: [],
      reportFiles: {json: "QC/raw-001/v001/technical-qc.json", markdown: "QC/raw-001/v001/technical-qc.md"},
    },
  });
  await transitionWorkItem(projectDir, coordinator, {
    workItemId: "raw-001", to: "TECH_PASSED", reason: "technical pass", artifactRef: technical.ref,
  });
  const creative = await storeArtifact(projectDir, "QC/raw-001/v001/creative-qc.json", {
    artifactId: "creative-qc-raw-001-v001", revision: 1, workItemId: "raw-001", modality: "raw-video",
    parents: [
      {artifactId: candidateRef.id, sha256: candidateRef.sha256},
      {artifactId: technical.ref.id, sha256: technical.ref.sha256},
    ],
    producer: {actorId: "creative-1", role: "creative-qc-reviewer"}, status: "passed",
    payload: {
      kind: "creative-qc", candidateBundleHash: bundle.bundleHash, policyVersion,
      profileId: "fixture-v1", profileHash, technicalEvidenceSha256: technical.ref.sha256,
      score: 96, scores: {}, evidence: {}, hardFailures: [], heroMoment: "hero",
      strongestEvidence: "strong", weakestUnresolvedChoice: "none", pass: true,
      reportFiles: {json: "QC/raw-001/v001/creative-qc.json"},
    },
  });
  await transitionWorkItem(projectDir, coordinator, {
    workItemId: "raw-001", to: "CREATIVE_PASSED", reason: "creative pass", artifactRef: creative.ref,
  });
  await recordApproval(projectDir, coordinator, {
    kind: "creative", workItemId: "raw-001", subject: {artifactId: creative.ref.id, sha256: creative.ref.sha256},
    bundleHash: bundle.bundleHash, decision: "approved",
    approver: {actorId: creative.artifact.producer.actorId, role: "creative-qc-reviewer"}, origin: "bizibeast",
    policyVersion,
  });
  await recordApproval(projectDir, coordinator, {
    kind: "human-release", workItemId: "raw-001", subject: {artifactId: candidateRef.id, sha256: bundle.bundleHash},
    bundleHash: bundle.bundleHash, decision: "approved", approver: {actorId: "human-1", role: "human"},
    origin: "user", policyVersion,
  });
  await transitionWorkItem(projectDir, coordinator, {
    workItemId: "raw-001", to: "APPROVED", reason: "release approved", artifactRef: options.approvedArtifactRef ?? creative.ref,
  });
  return {
    projectDir, bundle, technical, creative,
    input: {
      promoter: {actorId: "release-1", role: "release-promoter"},
      technicalEvidencePath: technical.path,
      creativeEvidencePath: creative.path,
      approvals: await readApprovals(projectDir),
      policyVersion,
    },
  };
}

async function carouselFixture() {
  const root = await mkdtemp(join(tmpdir(), "content-hub-carousel-release-"));
  const {projectDir} = await createProject(root, {
    name: "Carousel Release Fixture", mode: "semi-autonomous", aspect: "4:5", coordinatorActorId: coordinator.actorId,
  });
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "inputs frozen"});
  await createWorkItem(projectDir, coordinator, {id: "carousel-001", title: "Release carousel", modality: "carousel"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-001", to: "COPY_DRAFT", reason: "copy drafted"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-001", to: "AWAITING_COPY_APPROVAL", reason: "copy submitted"});
  const copy = await storeArtifact(projectDir, "Plans/carousel-copy-v001.json", {
    artifactId: "carousel-copy-001", revision: 1, workItemId: "carousel-001", modality: "carousel",
    parents: [], producer: {actorId: "script-1", role: "script-editorial"}, payload: {kind: "carousel-copy"},
  });
  const plan = await storeArtifact(projectDir, "Plans/carousel-plan-v001.json", {
    artifactId: "carousel-plan-001", revision: 1, workItemId: "carousel-001", modality: "carousel",
    parents: [{artifactId: copy.ref.id, sha256: copy.ref.sha256}],
    producer: {actorId: "design-1", role: "design-director"}, payload: {kind: "carousel-plan"},
  });
  const copyApproval = await recordApproval(projectDir, coordinator, {
    kind: "carousel-copy", workItemId: "carousel-001", subject: {artifactId: copy.ref.id, sha256: copy.ref.sha256},
    decision: "approved", approver: {actorId: "human-1", role: "human"}, origin: "user", policyVersion,
  });
  await transitionWorkItem(projectDir, coordinator, {
    workItemId: "carousel-001", to: "COPY_APPROVED", reason: "copy approved", artifactRef: copy.ref,
  });
  await transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-001", to: "CAROUSEL_PLANNED", reason: "carousel planned"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-001", to: "DESIGN_PLANNED", reason: "design planned"});
  await recordApproval(projectDir, coordinator, {
    kind: "design", workItemId: "carousel-001", subject: {artifactId: plan.ref.id, sha256: plan.ref.sha256},
    decision: "approved", approver: {actorId: "design-approver-1", role: "design-approver"}, origin: "bizibeast",
    policyVersion, producerActorId: plan.artifact.producer.actorId,
  });
  await transitionWorkItem(projectDir, coordinator, {
    workItemId: "carousel-001", to: "DESIGN_APPROVED", reason: "design approved", artifactRef: plan.ref,
  });
  await transitionWorkItem(projectDir, coordinator, {workItemId: "carousel-001", to: "EXECUTING", reason: "execution started"});
  const candidateDir = "Renders/Carousels/carousel-001/v001";
  await mkdir(join(projectDir, candidateDir), {recursive: true});
  const outputs = [];
  for (let slide = 1; slide <= 6; slide += 1) {
    const slideId = `slide-${String(slide).padStart(2, "0")}`;
    for (const [format, suffix] of [["4:5", "4x5"], ["1:1", "1x1"]]) {
      const path = `${candidateDir}/${slideId}-${suffix}.png`;
      await writeFile(join(projectDir, path), `${slideId}/${format}`);
      outputs.push({path, kind: "carousel-slide", order: outputs.length + 1, slideId, format, approvedCopySha256: copy.ref.sha256});
    }
  }
  const bundle = await freezeCandidateBundle(projectDir, coordinator, {
    workItemId: "carousel-001", modality: "carousel", revision: 1, outputs,
    inputLock: {
      artifacts: [copy.ref, plan.ref], approvals: [{id: copyApproval.id, subjectSha256: copy.ref.sha256}], assets: [],
    },
    lineage: {sourceIds: [], assetIds: []}, settings: {profileId: "carousel-paired-v1", profileHash},
    producer: {actorId: "carousel-1", role: "carousel-slide-executor"},
    versions: {tool: "fixture", template: "fixture", model: "none", policy: policyVersion},
    requestedDerivatives: ["png"],
  });
  const candidateRef = {id: "candidate:carousel-001:v001", sha256: bundle.bundleHash};
  await transitionWorkItem(projectDir, coordinator, {
    workItemId: "carousel-001", to: "CANDIDATE_FROZEN", reason: "candidate frozen", artifactRef: candidateRef,
  });
  const technical = await storeArtifact(projectDir, "QC/carousel-001/v001/technical-qc.json", {
    artifactId: "technical-qc-carousel-001-v001", revision: 1, workItemId: "carousel-001", modality: "carousel",
    parents: [copy.ref, plan.ref].map(({id: artifactId, sha256}) => ({artifactId, sha256})),
    producer: {actorId: "technical-1", role: "technical-qc-validator"}, status: "passed",
    payload: {
      kind: "technical-qc", candidateBundleHash: bundle.bundleHash, policyVersion,
      profileId: "carousel-paired-v1", profileHash, slideCount: 6, formats: ["4:5", "1:1"],
      pass: true, checks: [], reportFiles: {json: "QC/carousel-001/v001/technical-qc.json", markdown: "QC/carousel-001/v001/technical-qc.md", contactSheets: []},
    },
  });
  await transitionWorkItem(projectDir, coordinator, {
    workItemId: "carousel-001", to: "TECH_PASSED", reason: "technical pass", artifactRef: technical.ref,
  });
  const creative = await storeArtifact(projectDir, "QC/carousel-001/v001/creative-qc.json", {
    artifactId: "creative-qc-carousel-001-v001", revision: 1, workItemId: "carousel-001", modality: "carousel",
    parents: [
      {artifactId: candidateRef.id, sha256: candidateRef.sha256},
      {artifactId: technical.ref.id, sha256: technical.ref.sha256},
    ],
    producer: {actorId: "creative-1", role: "creative-qc-reviewer"}, status: "passed",
    payload: {
      kind: "creative-qc", candidateBundleHash: bundle.bundleHash, policyVersion,
      profileId: "carousel-paired-v1", profileHash, technicalEvidenceSha256: technical.ref.sha256,
      pass: true, reportFiles: {json: "QC/carousel-001/v001/creative-qc.json"},
    },
  });
  await transitionWorkItem(projectDir, coordinator, {
    workItemId: "carousel-001", to: "CREATIVE_PASSED", reason: "creative pass", artifactRef: creative.ref,
  });
  await recordApproval(projectDir, coordinator, {
    kind: "creative", workItemId: "carousel-001", subject: {artifactId: creative.ref.id, sha256: creative.ref.sha256},
    bundleHash: bundle.bundleHash, decision: "approved",
    approver: {actorId: "creative-1", role: "creative-qc-reviewer"}, origin: "bizibeast", policyVersion,
  });
  await recordApproval(projectDir, coordinator, {
    kind: "human-release", workItemId: "carousel-001", subject: {artifactId: candidateRef.id, sha256: bundle.bundleHash},
    bundleHash: bundle.bundleHash, decision: "approved", approver: {actorId: "human-1", role: "human"},
    origin: "user", policyVersion,
  });
  await transitionWorkItem(projectDir, coordinator, {
    workItemId: "carousel-001", to: "APPROVED", reason: "release approved", artifactRef: creative.ref,
  });
  return {
    projectDir, bundle,
    input: {
      promoter: {actorId: "release-1", role: "release-promoter"},
      technicalEvidencePath: technical.path, creativeEvidencePath: creative.path,
      approvals: await readApprovals(projectDir), policyVersion,
    },
  };
}

test("copies only a same-hash fully passing bundle into Final", async () => {
  const {projectDir, bundle, input} = await fixture();
  const receipt = await promotePassingBundle(projectDir, bundle.bundlePath, input);

  assert.equal(receipt.bundleHash, bundle.bundleHash);
  for (const file of receipt.files) {
    assert.equal(await sha256File(join(projectDir, file.finalPath)), file.sha256);
    assert.equal(file.sha256, bundle.files.find(({path}) => path === file.sourcePath).sha256);
  }
});

test("rejects gates that reference different candidate hashes", async () => {
  const {projectDir, bundle, creative, input} = await fixture();
  const changed = JSON.parse(await readFile(join(projectDir, creative.path), "utf8"));
  changed.payload.candidateBundleHash = "f".repeat(64);
  await writeFile(join(projectDir, creative.path), `${JSON.stringify(changed)}\n`);

  await assert.rejects(promotePassingBundle(projectDir, bundle.bundlePath, input), /candidate bundle hash mismatch/i);
});

test("release never overwrites an existing final path", async () => {
  const {projectDir, bundle, input} = await fixture();
  await promotePassingBundle(projectDir, bundle.bundlePath, input);

  await assert.rejects(promotePassingBundle(projectDir, bundle.bundlePath, input), /already exists|EEXIST/i);
});

test("records RELEASED and DELIVERED against the exact immutable receipt", async () => {
  const {projectDir, bundle, input} = await fixture();
  const receipt = await promotePassingBundle(projectDir, bundle.bundlePath, input);

  await recordRelease(projectDir, coordinator, receipt.receiptPath);
  const deliverables = await listFinalDeliverables(projectDir, bundle.workItemId);
  await markDelivered(projectDir, coordinator, bundle.workItemId, receipt.receiptPath);

  assert.deepEqual(deliverables.files, receipt.files.map(({finalPath: path, sha256}) => ({path, sha256})));
  const workflow = await readWorkflowState(projectDir);
  assert.equal(getWorkItem(workflow, bundle.workItemId).state, "DELIVERED");
  const [released, delivered] = workflow.events.filter(({workItemId, to}) => workItemId === bundle.workItemId && ["RELEASED", "DELIVERED"].includes(to));
  assert.deepEqual(delivered.artifactRef, released.artifactRef);
  assert.equal(released.artifactRef.sha256, receipt.receiptSha256);
});

test("rejects a producer acting as release promoter before creating Final", async () => {
  const {projectDir, bundle, input} = await fixture();
  input.promoter.actorId = bundle.producer.actorId;

  await assert.rejects(promotePassingBundle(projectDir, bundle.bundlePath, input), /promoter.*independent/i);
  await assert.rejects(access(join(projectDir, "Final/Masters/raw-001/v001")), {code: "ENOENT"});
});

test("rejects evidence outside the exact QC path before creating Final", async () => {
  const {projectDir, bundle, input} = await fixture();
  input.creativeEvidencePath = "Plans/design-plan-v001.json";

  await assert.rejects(promotePassingBundle(projectDir, bundle.bundlePath, input), /exact bundle QC path/i);
  await assert.rejects(access(join(projectDir, "Final/Masters/raw-001/v001")), {code: "ENOENT"});
});

test("repeated concurrent promotion has one winner without changing candidate bytes", async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const {projectDir, bundle, input} = await fixture();
    const before = await sha256File(join(projectDir, bundle.files[0].path));

    const results = await Promise.allSettled([
      promotePassingBundle(projectDir, bundle.bundlePath, input),
      promotePassingBundle(projectDir, bundle.bundlePath, input),
    ]);

    assert.equal(results.filter(({status}) => status === "fulfilled").length, 1);
    assert.equal(results.filter(({status}) => status === "rejected").length, 1);
    assert.equal(await sha256File(join(projectDir, bundle.files[0].path)), before);
    const receipt = results.find(({status}) => status === "fulfilled").value;
    assert.equal(await sha256File(join(projectDir, receipt.files[0].finalPath)), before);
  }
});

test("promotes six complete carousel slide pairs atomically in bundle order", async () => {
  const {projectDir, bundle, input} = await carouselFixture();

  const receipt = await promotePassingBundle(projectDir, bundle.bundlePath, input);
  await recordRelease(projectDir, coordinator, receipt.receiptPath);
  const deliverables = await listFinalDeliverables(projectDir, bundle.workItemId);
  await markDelivered(projectDir, coordinator, bundle.workItemId, receipt.receiptPath);

  assert.equal(receipt.files.length, 12);
  assert.deepEqual(receipt.files.map(({sourcePath}) => sourcePath), bundle.files.map(({path}) => path));
  assert.ok(receipt.files.every(({finalPath}) => finalPath.startsWith("Final/Deliverables/Carousels/carousel-001/v001/")));
  for (const file of receipt.files) assert.equal(await sha256File(join(projectDir, file.finalPath)), file.sha256);
  assert.deepEqual(deliverables.files, receipt.files.map(({finalPath: path, sha256}) => ({path, sha256})));
  assert.ok(deliverables.files.every(({path}) => path.startsWith("Final/")));
  assert.doesNotMatch(JSON.stringify(deliverables), /Plans\/|Renders\/|QC\//u);
  assert.equal(getWorkItem(await readWorkflowState(projectDir), bundle.workItemId).state, "DELIVERED");
});

test("rejects APPROVED state bound to a different creative artifact", async () => {
  const {projectDir, bundle, input} = await fixture({
    approvedArtifactRef: {id: "creative-qc-other-v001", sha256: "f".repeat(64)},
  });

  await assert.rejects(promotePassingBundle(projectDir, bundle.bundlePath, input), /workflow.*evidence/i);
  await assert.rejects(access(join(projectDir, "Final/Masters/raw-001/v001")), {code: "ENOENT"});
});

test("release CLI records RELEASED with separate promoter and coordinator actors", async () => {
  const {projectDir, bundle, technical, creative} = await fixture();

  const released = JSON.parse((await cli([
    "release", projectDir, "--bundle", bundle.bundlePath, "--technical", join(projectDir, technical.path),
    "--creative", join(projectDir, creative.path), "--actor", "release-1", "--coordinator", "coord-1", "--json",
  ])).stdout);

  assert.equal(released.bundleHash, bundle.bundleHash);
  assert.equal(getWorkItem(await readWorkflowState(projectDir), bundle.workItemId).state, "RELEASED");
});

test("release CLI rejects wrong coordinator before creating Final", async () => {
  const {projectDir, bundle, technical, creative} = await fixture();

  await assert.rejects(cli([
    "release", projectDir, "--bundle", bundle.bundlePath, "--technical", join(projectDir, technical.path),
    "--creative", join(projectDir, creative.path), "--actor", "release-1", "--coordinator", "wrong", "--json",
  ]), /only coordinator/i);
  await assert.rejects(access(join(projectDir, "Final/Masters/raw-001/v001")), {code: "ENOENT"});
});

test("release CLI rejects one actor as both promoter and coordinator before promotion", async () => {
  const {projectDir, bundle, technical, creative} = await fixture();

  await assert.rejects(cli([
    "release", projectDir, "--bundle", bundle.bundlePath, "--technical", join(projectDir, technical.path),
    "--creative", join(projectDir, creative.path), "--actor", "coord-1", "--coordinator", "coord-1", "--json",
  ]), /promoter.*independent.*coordinator/i);
  await assert.rejects(access(join(projectDir, "Final/Masters/raw-001/v001")), {code: "ENOENT"});
});

test("rejects symlinked Final parents for both modalities before any outside write", async (t) => {
  for (const [name, makeFixture, parent, final] of [
    ["video", fixture, "Final/Masters", "Final/Masters/raw-001/v001"],
    ["carousel", carouselFixture, "Final/Deliverables/Carousels", "Final/Deliverables/Carousels/carousel-001/v001"],
  ]) await t.test(name, async () => {
    const {projectDir, bundle, input} = await makeFixture();
    const outside = await mkdtemp(join(tmpdir(), `content-hub-release-outside-${name}-`));
    await rmdir(join(projectDir, parent));
    await symlink(outside, join(projectDir, parent), "dir");

    await assert.rejects(promotePassingBundle(projectDir, bundle.bundlePath, input), /symlink|project path/i);

    assert.deepEqual(await readdir(outside), []);
    await assert.rejects(access(join(projectDir, final)), {code: "ENOENT"});
    await assert.rejects(access(join(projectDir, `QC/${bundle.workItemId}/v001/release-receipt.json`)), {code: "ENOENT"});
  });
});

test("competing receipt creation leaves no Final and preserves replacement receipt", async () => {
  const {projectDir, bundle, technical, creative, input} = await fixture();
  const replacement = join(projectDir, "replacement-receipt.json");
  const receiptPath = join(projectDir, "QC/raw-001/v001/release-receipt.json");
  await writeFile(replacement, "replacement receipt bytes");
  const watcher = watchPath(
    "while ! ls \"$1\"/.release-* >/dev/null 2>&1; do :; done; ln -s \"$2\" \"$3\"",
    [join(projectDir, "QC/raw-001/v001"), replacement, receiptPath],
  );

  await assert.rejects(promotePassingBundle(projectDir, bundle.bundlePath, input), /exists|symlink/i);
  await watcher;

  await assert.rejects(access(join(projectDir, "Final/Masters/raw-001/v001")), {code: "ENOENT"});
  assert.equal((await lstat(receiptPath)).isSymbolicLink(), true);
  assert.equal(await readFile(replacement, "utf8"), "replacement receipt bytes");
  await access(join(projectDir, bundle.files[0].path));
  await access(join(projectDir, technical.path));
  await access(join(projectDir, creative.path));
  assert.equal((await readdir(join(projectDir, "QC/raw-001/v001"))).some((name) => name.startsWith(".release-")), false);
});

test("real exclusive final rename failure removes owned receipt and staging without clobber", async () => {
  const {projectDir, bundle, technical, creative, input} = await fixture();
  const receiptPath = join(projectDir, "QC/raw-001/v001/release-receipt.json");
  const finalDir = join(projectDir, "Final/Masters/raw-001/v001");
  const watcher = watchPath(
    "while [ ! -f \"$1\" ]; do :; done; mkdir \"$2\"",
    [receiptPath, finalDir],
  );

  await assert.rejects(promotePassingBundle(projectDir, bundle.bundlePath, input), /exists/i);
  await watcher;

  assert.deepEqual(await readdir(finalDir), []);
  await assert.rejects(access(receiptPath), {code: "ENOENT"});
  await access(join(projectDir, bundle.files[0].path));
  await access(join(projectDir, technical.path));
  await access(join(projectDir, creative.path));
  assert.equal((await readdir(join(projectDir, "QC/raw-001/v001"))).some((name) => name.startsWith(".release-")), false);
});

test("never clobbers or cleans an existing receipt", async () => {
  const {projectDir, bundle, input} = await fixture();
  const receiptPath = join(projectDir, "QC/raw-001/v001/release-receipt.json");
  await writeFile(receiptPath, "existing receipt bytes");

  await assert.rejects(promotePassingBundle(projectDir, bundle.bundlePath, input), /prepared release receipt.*preserving/i);

  assert.equal(await readFile(receiptPath, "utf8"), "existing receipt bytes");
  await assert.rejects(access(join(projectDir, "Final/Masters/raw-001/v001")), {code: "ENOENT"});
});

test("release promoter differs from coordinator and all production or approval actors", async () => {
  const {projectDir, bundle, input} = await fixture();
  for (const actorId of [
    "coord-1", "premiere-1", "technical-1", "creative-1", "script-1", "human-1", "design-1", "design-approver-1",
  ]) {
    input.promoter.actorId = actorId;
    await assert.rejects(promotePassingBundle(projectDir, bundle.bundlePath, input), /promoter.*independent/i);
  }
  await assert.rejects(access(join(projectDir, "Final/Masters/raw-001/v001")), {code: "ENOENT"});
});

test("rejects CANDIDATE_FROZEN state bound to another candidate reference", async () => {
  const {projectDir, bundle, input} = await fixture({
    candidateArtifactRef: {id: "candidate:raw-001:v999", sha256: "f".repeat(64)},
  });

  await assert.rejects(promotePassingBundle(projectDir, bundle.bundlePath, input), /workflow.*candidate_frozen/i);
  await assert.rejects(access(join(projectDir, "Final/Masters/raw-001/v001")), {code: "ENOENT"});
});

test("record and delivery require both receipt and exact Final bytes", async () => {
  const {projectDir, bundle, input} = await fixture();
  const receipt = await promotePassingBundle(projectDir, bundle.bundlePath, input);
  const finalDir = join(projectDir, "Final/Masters/raw-001/v001");
  const hidden = join(projectDir, "Final/Masters/raw-001/.hidden-v001");
  await rename(finalDir, hidden);

  await assert.rejects(recordRelease(projectDir, coordinator, receipt.receiptPath), /ENOENT|Final|project path/i);
  assert.equal(getWorkItem(await readWorkflowState(projectDir), bundle.workItemId).state, "APPROVED");

  await rename(hidden, finalDir);
  await recordRelease(projectDir, coordinator, receipt.receiptPath);
  await rename(finalDir, hidden);
  await assert.rejects(listFinalDeliverables(projectDir, bundle.workItemId), /ENOENT|Final|project path/i);
  await assert.rejects(markDelivered(projectDir, coordinator, bundle.workItemId, receipt.receiptPath), /ENOENT|Final|project path/i);
  assert.equal(getWorkItem(await readWorkflowState(projectDir), bundle.workItemId).state, "RELEASED");
});

test("recordRelease rejects a self-consistent forged receipt", async () => {
  const {projectDir, bundle, input} = await fixture();
  const receipt = await promotePassingBundle(projectDir, bundle.bundlePath, input);
  const path = join(projectDir, receipt.receiptPath);
  const forged = JSON.parse(await readFile(path, "utf8"));
  forged.bundleHash = "f".repeat(64);
  const {receiptHash: _oldHash, ...unsigned} = forged;
  forged.receiptHash = sha256Value(unsigned);
  await writeFile(path, `${JSON.stringify(forged, null, 2)}\n`);

  await assert.rejects(recordRelease(projectDir, coordinator, receipt.receiptPath), /candidate|bundle|receipt|project state/i);
  assert.equal(getWorkItem(await readWorkflowState(projectDir), bundle.workItemId).state, "APPROVED");
});

test("recordRelease reopens required evidence and candidate bytes", async (t) => {
  await t.test("missing technical evidence", async () => {
    const {projectDir, bundle, technical, input} = await fixture();
    const receipt = await promotePassingBundle(projectDir, bundle.bundlePath, input);
    await unlink(join(projectDir, technical.path));
    await assert.rejects(recordRelease(projectDir, coordinator, receipt.receiptPath), /technical|evidence|ENOENT/i);
  });
  await t.test("changed candidate", async () => {
    const {projectDir, bundle, input} = await fixture();
    const receipt = await promotePassingBundle(projectDir, bundle.bundlePath, input);
    await writeFile(join(projectDir, bundle.files[0].path), "changed after promotion");
    await assert.rejects(recordRelease(projectDir, coordinator, receipt.receiptPath), /candidate|bundle|hash|size/i);
  });
});

test("recordRelease rejects a current rejection appended after promotion", async () => {
  const {projectDir, bundle, creative, input} = await fixture();
  const receipt = await promotePassingBundle(projectDir, bundle.bundlePath, input);
  await recordApproval(projectDir, coordinator, {
    kind: "creative", workItemId: bundle.workItemId,
    subject: {artifactId: creative.ref.id, sha256: creative.ref.sha256}, bundleHash: bundle.bundleHash,
    decision: "rejected", approver: {actorId: creative.artifact.producer.actorId, role: "creative-qc-reviewer"},
    origin: "bizibeast", policyVersion,
  });

  await assert.rejects(recordRelease(projectDir, coordinator, receipt.receiptPath), /creative approval|current|rejected/i);
});

test("delivery and status revalidate release evidence and expose current hashes", async () => {
  const {projectDir, bundle, technical, input} = await fixture();
  const receipt = await promotePassingBundle(projectDir, bundle.bundlePath, input);
  await recordRelease(projectDir, coordinator, receipt.receiptPath);

  const status = await getProjectStatus(projectDir);
  const item = status.workItems.find(({id}) => id === bundle.workItemId);
  assert.equal(item.candidate.sha256, bundle.bundleHash);
  assert.equal(item.technical.sha256, technical.ref.sha256);
  assert.equal(item.profileHash, profileHash);
  assert.equal(item.policyVersion, policyVersion);
  assert.equal(item.release.state, "verified");
  assert.equal(item.release.receiptHash, receipt.receiptHash);
  assert.deepEqual(item.finalDeliverables.map(({path}) => path), receipt.files.map(({finalPath}) => finalPath));

  await unlink(join(projectDir, technical.path));
  await assert.rejects(listFinalDeliverables(projectDir, bundle.workItemId), /project-state|technical|evidence|ENOENT/i);
  await assert.rejects(markDelivered(projectDir, coordinator, bundle.workItemId, receipt.receiptPath), /technical|evidence|ENOENT/i);
  const stale = await getProjectStatus(projectDir);
  const staleItem = stale.workItems.find(({id}) => id === bundle.workItemId);
  assert.equal(staleItem.release.state, "stale");
  assert.deepEqual(staleItem.finalDeliverables, []);
});

test("reuses a valid exact prepared receipt when Final is absent", async () => {
  const {projectDir, bundle, input} = await fixture();
  const first = await promotePassingBundle(projectDir, bundle.bundlePath, input);
  const receiptPath = join(projectDir, first.receiptPath);
  const receiptBytes = await readFile(receiptPath);
  const finalDir = join(projectDir, "Final/Masters/raw-001/v001");
  await rename(finalDir, join(projectDir, "Final/Masters/raw-001/crash-artifact"));

  const recovered = await promotePassingBundle(projectDir, bundle.bundlePath, input);

  assert.equal(recovered.receiptHash, first.receiptHash);
  assert.equal(recovered.receiptSha256, first.receiptSha256);
  assert.deepEqual(await readFile(receiptPath), receiptBytes);
  assert.equal(await sha256File(join(finalDir, "master.mp4")), bundle.files[0].sha256);
});
