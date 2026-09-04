import {constants as fsConstants} from "node:fs";
import {copyFile, mkdir, readFile, rename, stat, writeFile} from "node:fs/promises";
import {createHash, randomUUID} from "node:crypto";
import path from "node:path";

const STATES = Object.freeze({READY: "PLANNED", PLANNED: "EXECUTING", EXECUTING: "CANDIDATE_FROZEN", CANDIDATE_FROZEN: "RELEASED"});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function bytes(value) {
  return Buffer.from(`${JSON.stringify(canonical(value))}\n`);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function inside(project, relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative)) throw new Error("Path must be relative to the project");
  const root = path.resolve(project);
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("Path escapes the project");
  return target;
}

function actor(value, role) {
  if (!value || typeof value.actorId !== "string" || !value.actorId.trim() || value.role !== role) throw new Error(`Requires ${role}`);
  return {actorId: value.actorId.trim(), role};
}

async function createRecord(project, kind, payload) {
  const body = {schemaVersion: 1, kind, createdAt: new Date().toISOString(), payload};
  const content = bytes(body);
  const sha256 = hash(content);
  const relative = path.join(".bizibeast-strict", "records", `${kind}-${sha256}.json`);
  const target = inside(project, relative);
  await mkdir(path.dirname(target), {recursive: true});
  await writeFile(target, content, {flag: "wx"});
  return {record: body, ref: {path: relative, sha256}};
}

async function workflow(project) {
  return JSON.parse(await readFile(inside(project, ".bizibeast-strict/workflow.json"), "utf8"));
}

async function writeWorkflow(project, value) {
  const target = inside(project, ".bizibeast-strict/workflow.json");
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes(value), {flag: "wx"});
  await rename(temporary, target);
}

export async function verifyRef(project, ref) {
  if (!ref || typeof ref.path !== "string" || !/^[a-f0-9]{64}$/.test(ref.sha256 || "")) throw new Error("Invalid immutable reference");
  const content = await readFile(inside(project, ref.path));
  if (hash(content) !== ref.sha256) throw new Error("Immutable record hash mismatch");
  return JSON.parse(content.toString("utf8"));
}

export async function initStrict(project, {workItemId}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(workItemId || "")) throw new Error("Invalid work item id");
  const directory = inside(project, ".bizibeast-strict");
  await mkdir(path.join(directory, "records"), {recursive: true});
  const value = {schemaVersion: 1, workItemId, state: "READY", history: []};
  await writeFile(path.join(directory, "workflow.json"), bytes(value), {flag: "wx"});
  return value;
}

export async function createArtifact(project, input) {
  if (!input?.stage || !input?.payload) throw new Error("Artifact needs stage and payload");
  const parents = input.parents || [];
  for (const ref of parents) await verifyRef(project, ref);
  return createRecord(project, "artifact", {
    workItemId: input.workItemId,
    stage: input.stage,
    producer: input.producer,
    parents,
    data: input.payload
  });
}

export async function approveArtifact(project, {artifactRef, approver}) {
  const artifact = await verifyRef(project, artifactRef);
  if (artifact.kind !== "artifact") throw new Error("Approval target must be an artifact");
  if (!/-approver$/.test(approver?.role || "")) throw new Error("Approval requires an approver role");
  actor(approver, approver?.role);
  if (artifact.payload.producer?.actorId === approver.actorId) throw new Error("Approval requires a separate actor");
  return createRecord(project, "approval", {artifactRef, approver, decision: "approved"});
}

export async function transition(project, input) {
  actor(input.coordinator, "coordinator");
  const current = await workflow(project);
  if (current.workItemId !== input.workItemId || current.state !== input.from || STATES[input.from] !== input.to) throw new Error(`Invalid transition ${input.from} to ${input.to}`);
  if (input.artifactRef) await verifyRef(project, input.artifactRef);
  if (input.approvalRef) {
    const approval = await verifyRef(project, input.approvalRef);
    if (approval.kind !== "approval" || approval.payload.artifactRef.sha256 !== input.artifactRef?.sha256) throw new Error("Approval is not bound to transition artifact");
  }
  const event = await createRecord(project, "transition", {workItemId: input.workItemId, from: input.from, to: input.to, coordinator: input.coordinator, artifactRef: input.artifactRef || null, approvalRef: input.approvalRef || null});
  current.state = input.to;
  current.history.push(event.ref);
  await writeWorkflow(project, current);
  return event;
}

export async function freezeCandidate(project, input) {
  actor(input.coordinator, "coordinator");
  const current = await workflow(project);
  if (current.workItemId !== input.workItemId || current.state !== "EXECUTING") throw new Error("Candidate freeze requires EXECUTING state");
  for (const ref of input.artifacts || []) await verifyRef(project, ref);
  const target = inside(project, input.output);
  await stat(target);
  const outputSha256 = hash(await readFile(target));
  const candidate = await createRecord(project, "candidate", {workItemId: input.workItemId, coordinator: input.coordinator, output: input.output, outputSha256, artifacts: input.artifacts || []});
  await transition(project, {workItemId: input.workItemId, from: "EXECUTING", to: "CANDIDATE_FROZEN", coordinator: input.coordinator});
  return candidate;
}

async function qcEvidence(project, kind, role, input) {
  actor(input.reviewer, role);
  const candidate = await verifyRef(project, input.candidateRef);
  if (candidate.kind !== "candidate") throw new Error("QC target must be a candidate");
  return createRecord(project, kind, {candidateRef: input.candidateRef, reviewer: input.reviewer, passed: input.passed === true, report: input.report || {}});
}

export const technicalQc = (project, input) => qcEvidence(project, "technical-qc", "technical-qc", input);
export const creativeQc = (project, input) => qcEvidence(project, "creative-qc", "creative-qc", input);

export async function promoteCandidate(project, input) {
  actor(input.promoter, "release-promoter");
  const candidate = await verifyRef(project, input.candidateRef);
  const technical = await verifyRef(project, input.technicalRef);
  const creative = await verifyRef(project, input.creativeRef);
  if (candidate.kind !== "candidate" || technical.kind !== "technical-qc" || creative.kind !== "creative-qc" || !technical.payload.passed || !creative.payload.passed) throw new Error("Release requires passing technical and creative QC");
  if (technical.payload.candidateRef.sha256 !== input.candidateRef.sha256 || creative.payload.candidateRef.sha256 !== input.candidateRef.sha256) throw new Error("QC evidence is for a different candidate");
  const source = inside(project, candidate.payload.output);
  if (hash(await readFile(source)) !== candidate.payload.outputSha256) throw new Error("Candidate output changed after freeze");
  const output = path.join("Final", path.basename(candidate.payload.output));
  await mkdir(inside(project, "Final"), {recursive: true});
  await copyFile(source, inside(project, output), fsConstants.COPYFILE_EXCL);
  const release = await createRecord(project, "release-evidence", {candidateRef: input.candidateRef, technicalRef: input.technicalRef, creativeRef: input.creativeRef, promoter: input.promoter, output, outputSha256: candidate.payload.outputSha256});
  const current = await workflow(project);
  if (current.state !== "CANDIDATE_FROZEN") throw new Error("Release requires CANDIDATE_FROZEN state");
  current.state = "RELEASED";
  current.history.push(release.ref);
  await writeWorkflow(project, current);
  return {...release, output};
}

export async function runWithRetry(operation, {maxAttempts = 2} = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new Error("maxAttempts must be between 1 and 5");
  for (let attempts = 1; attempts <= maxAttempts; attempts += 1) {
    try { return {value: await operation(), attempts}; }
    catch (error) { if (attempts === maxAttempts) throw error; }
  }
}
