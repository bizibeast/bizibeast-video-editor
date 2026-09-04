import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdir, mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import test from "node:test";

import {sha256File, sha256Value} from "../src/checksum.mjs";
import {createProject} from "../src/project.mjs";
import {createWorkItem, getWorkItem, readWorkflowState, transitionProject, transitionWorkItem} from "../src/workflow.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repositoryRoot, "bin/content-hub.mjs");
const coordinator = {actorId: "coord-1", actorRole: "coordinator"};
const hash = "a".repeat(64);

function cli(args) {
  return execFileAsync(process.execPath, [cliPath, ...args], {cwd: repositoryRoot});
}

async function releasedProject() {
  const root = await mkdtemp(join(tmpdir(), "content-hub-delivery-"));
  const {projectDir} = await createProject(root, {name: "Delivery Fixture", coordinatorActorId: coordinator.actorId});
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "frozen"});
  await createWorkItem(projectDir, coordinator, {id: "raw-001", title: "Final video", modality: "raw-video"});
  for (const to of [
    "MEDIA_INDEXED", "TRANSCRIPTS_READY", "STORY_PLANNED", "DESIGN_PLANNED", "DESIGN_APPROVED",
    "EXECUTING", "CANDIDATE_FROZEN", "TECH_PASSED", "CREATIVE_PASSED", "APPROVED",
  ]) {
    await transitionWorkItem(projectDir, coordinator, {
      workItemId: "raw-001", to, reason: `enter ${to}`,
      artifactRef: ["DESIGN_APPROVED", "CANDIDATE_FROZEN", "TECH_PASSED", "CREATIVE_PASSED", "APPROVED"].includes(to)
        ? {id: `artifact-${to.toLowerCase()}`, sha256: hash}
        : undefined,
    });
  }
  const finalPath = "Final/Masters/raw-001/v001/master.mp4";
  await mkdir(join(projectDir, dirname(finalPath)), {recursive: true});
  await writeFile(join(projectDir, finalPath), "released bytes");
  const fileHash = await sha256File(join(projectDir, finalPath));
  const unsigned = {
    schemaVersion: 1, workItemId: "raw-001", modality: "raw-video", revision: 1,
    bundleHash: "b".repeat(64),
    candidateBundle: {path: "Renders/Candidates/raw-001/v001/bundle.json", sha256: "f".repeat(64)},
    technicalEvidence: {path: "QC/raw-001/v001/technical-qc.json", sha256: "c".repeat(64)},
    creativeEvidence: {path: "QC/raw-001/v001/creative-qc.json", sha256: "d".repeat(64)},
    approvalRefs: ["script", "design", "creative"].map((kind, index) => ({id: `approval-${index}`, kind, recordHash: hash})),
    workflowRefs: ["CANDIDATE_FROZEN", "TECH_PASSED", "CREATIVE_PASSED", "APPROVED"].map((state) => ({state, artifactRef: {id: `artifact-${state.toLowerCase()}`, sha256: hash}})),
    policyVersion: "bizibeast-v1", profileId: "fixture-v1", profileHash: "e".repeat(64), requestedDerivatives: ["mp4"],
    promoter: {actorId: "release-1", role: "release-promoter"},
    files: [{sourcePath: "Renders/Candidates/raw-001/v001/master.mp4", finalPath, bytes: 14, sha256: fileHash}],
    createdAt: new Date().toISOString(),
  };
  const receipt = {...unsigned, receiptHash: sha256Value(unsigned)};
  const receiptPath = "QC/raw-001/v001/release-receipt.json";
  await mkdir(join(projectDir, dirname(receiptPath)), {recursive: true});
  await writeFile(join(projectDir, receiptPath), `${JSON.stringify(receipt, null, 2)}\n`);
  const receiptSha256 = await sha256File(join(projectDir, receiptPath));
  await transitionWorkItem(projectDir, coordinator, {
    workItemId: "raw-001", to: "RELEASED", reason: "released",
    artifactRef: {id: "release-receipt:raw-001:v001", sha256: receiptSha256},
  });
  return {projectDir, finalPath};
}

test("deliver rejects a forged receipt even when its Final bytes and hash agree", async () => {
  const {projectDir} = await releasedProject();

  await assert.rejects(cli(["deliver", projectDir, "raw-001", "--actor", "coord-1", "--json"]), /candidate|bundle|receipt|project-state/i);

  assert.equal(getWorkItem(await readWorkflowState(projectDir), "raw-001").state, "RELEASED");
});

test("deliver refuses a Final file changed after release", async () => {
  const {projectDir, finalPath} = await releasedProject();
  await writeFile(join(projectDir, finalPath), "tampered bytes");

  await assert.rejects(
    cli(["deliver", projectDir, "raw-001", "--actor", "coord-1", "--json"]),
    /final deliverable hash mismatch/i,
  );
  assert.equal(getWorkItem(await readWorkflowState(projectDir), "raw-001").state, "RELEASED");
});

test("QC CLI commands require actor flags outside strict JSON inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "content-hub-cli-input-"));
  const inputPath = join(directory, "input.json");
  await writeFile(inputPath, "{}\n");
  for (const args of [
    ["qc-candidate", directory, "--bundle", "missing.json", "--input", inputPath],
    ["qc-carousel", directory, "--bundle", "missing.json", "--input", inputPath],
  ]) await assert.rejects(cli(args), /--validator is required/i);
  await assert.rejects(cli([
    "creative-review", directory, "--bundle", "missing.json", "--technical", "missing.json", "--input", inputPath,
  ]), /--reviewer is required/i);

  await writeFile(inputPath, `${JSON.stringify({validator: {actorId: "spoof", role: "technical-qc-validator"}})}\n`);
  await assert.rejects(cli([
    "qc-candidate", directory, "--bundle", "missing.json", "--input", inputPath, "--validator", "technical-1",
  ]), /input must not include validator/i);
});
