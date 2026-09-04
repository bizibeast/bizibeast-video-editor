import {randomUUID} from "node:crypto";
import {open, readFile, realpath} from "node:fs/promises";
import {dirname} from "node:path";

import {sha256Value} from "./checksum.mjs";
import {assertCoordinator, readManifest} from "./manifest.mjs";
import {confinedProjectPath} from "./paths.mjs";
import {assertIndependentReviewer, ROLES} from "./roles.mjs";

const APPROVAL_KINDS = new Set(["script", "carousel-copy", "design", "creative", "human-release", "human-exception"]);
const DECISIONS = new Set(["approved", "rejected"]);
const ORIGINS = new Set(["user", "bizibeast"]);
const HUMAN_KINDS = new Set(["script", "carousel-copy", "human-release", "human-exception"]);
const BUNDLE_KINDS = new Set(["creative", "human-release"]);
const APPROVALS_PATH = "Plans/approvals.jsonl";
const SHA256 = /^[a-f0-9]{64}$/u;
const RECORD_KEYS = Object.freeze([
  "approver", "bundleHash", "createdAt", "decision", "id", "kind", "origin", "policyVersion",
  "previousRecordHash", "producerActorId", "recordHash", "schemaVersion", "subject", "workItemId",
]);
const approvalQueues = new Map();

function assertString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
}

function assertHash(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 hash`);
}

function assertApprovalInput(input, {producerActorId = input?.producerActorId, skipIndependence = false} = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Approval input is required");
  if (!APPROVAL_KINDS.has(input.kind)) throw new Error(`Unknown approval kind: ${input.kind}`);
  if (!DECISIONS.has(input.decision)) throw new Error(`Unknown approval decision: ${input.decision}`);
  if (!ORIGINS.has(input.origin)) throw new Error(`Unknown approval origin: ${input.origin}`);
  assertString(input.workItemId, "Work item id");
  assertString(input.subject?.artifactId, "Subject artifact id");
  assertHash(input.subject?.sha256, "Subject SHA-256");
  if (BUNDLE_KINDS.has(input.kind) && (input.bundleHash === undefined || input.bundleHash === null)) {
    throw new Error(`${input.kind} approvals require a bundle SHA-256 hash`);
  }
  if (input.bundleHash !== undefined && input.bundleHash !== null) assertHash(input.bundleHash, "Bundle SHA-256");
  assertString(input.approver?.actorId, "Approver actor id");
  if (!ROLES.includes(input.approver?.role)) throw new Error(`Unknown approver role: ${input.approver?.role}`);
  assertString(input.policyVersion, "Policy version");

  if (HUMAN_KINDS.has(input.kind)) {
    if (input.approver.role !== "human") throw new Error(`${input.kind} approvals require a human approver`);
    if (input.origin !== "user") throw new Error(`${input.kind} approvals require origin user`);
  } else {
    const role = input.kind === "design" ? "design-approver" : "creative-qc-reviewer";
    if (input.approver.role !== role) throw new Error(`${input.kind} approvals require ${role}`);
    if (!skipIndependence) {
      assertString(producerActorId, "Producer actor id");
      assertIndependentReviewer({
        producerActorId,
        reviewerActorId: input.approver.actorId,
        reviewerRole: input.approver.role,
      });
    }
  }
}

function validateRecord(record, previousRecordHash) {
  if (!record || typeof record !== "object" || Array.isArray(record)
    || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(RECORD_KEYS)) {
    throw new Error("Malformed approval record");
  }
  if (record.schemaVersion !== 1 || typeof record.id !== "string" || !record.id.startsWith("approval-")) {
    throw new Error("Malformed approval record");
  }
  assertApprovalInput(record);
  if (record.producerActorId !== null && (typeof record.producerActorId !== "string" || !record.producerActorId.trim())) {
    throw new Error("Malformed approval record");
  }
  if (HUMAN_KINDS.has(record.kind) ? record.producerActorId !== null : typeof record.producerActorId !== "string") {
    throw new Error("Malformed approval record");
  }
  if (record.bundleHash !== null) assertHash(record.bundleHash, "Bundle SHA-256");
  if (record.previousRecordHash !== previousRecordHash) throw new Error("Broken approval hash chain");
  assertHash(record.recordHash, "Approval record hash");
  if (typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))) throw new Error("Malformed approval record");
  const {recordHash, ...withoutHash} = record;
  if (sha256Value(withoutHash) !== recordHash) throw new Error("Approval record hash mismatch");
  return record;
}

async function readApprovalLog(path) {
  const raw = await readFile(path, "utf8");
  if (raw === "") return [];
  if (raw.includes("\r") || !raw.endsWith("\n")) throw new Error("Malformed truncated approval log");
  const records = raw.slice(0, -1).split("\n").map((line) => {
    if (!line) throw new Error("Malformed approval record");
    try {
      return JSON.parse(line);
    } catch {
      throw new Error("Malformed approval record");
    }
  });
  return records.map((record, index) => validateRecord(record, index ? records[index - 1].recordHash : null));
}

function queueApproval(projectDir, operation) {
  const previous = approvalQueues.get(projectDir) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  const completion = next.then(() => undefined, () => undefined).finally(() => {
    if (approvalQueues.get(projectDir) === completion) approvalQueues.delete(projectDir);
  });
  approvalQueues.set(projectDir, completion);
  return next;
}

async function appendApproval(path, record) {
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function readApprovals(projectDir) {
  const root = await realpath(projectDir);
  await readManifest(root);
  return readApprovalLog(await confinedProjectPath(root, APPROVALS_PATH, {type: "file"}));
}

export async function recordApproval(projectDir, coordinatorContext, input) {
  const root = await realpath(projectDir);
  return queueApproval(root, async () => {
    const manifest = await readManifest(root);
    assertCoordinator(manifest, coordinatorContext);
    assertApprovalInput(input, {skipIndependence: input?.kind === "creative"});
    let producerActorId = input.producerActorId ?? null;
    if (input.kind === "creative") {
      const {findVerifiedCandidateBundle} = await import("./candidates.mjs");
      const bundle = await findVerifiedCandidateBundle(root, {bundleHash: input.bundleHash, workItemId: input.workItemId});
      producerActorId = bundle.producer.actorId;
      if (input.producerActorId !== undefined && input.producerActorId !== null && input.producerActorId !== producerActorId) {
        throw new Error("Claimed producer actor does not match the verified candidate bundle");
      }
      assertIndependentReviewer({
        producerActorId,
        reviewerActorId: input.approver.actorId,
        reviewerRole: input.approver.role,
      });
    }
    const path = await confinedProjectPath(root, APPROVALS_PATH, {type: "file"});
    const approvals = await readApprovalLog(path);
    const record = {
      schemaVersion: 1,
      id: `approval-${randomUUID()}`,
      kind: input.kind,
      workItemId: input.workItemId,
      subject: {artifactId: input.subject.artifactId, sha256: input.subject.sha256},
      bundleHash: input.bundleHash ?? null,
      decision: input.decision,
      approver: {actorId: input.approver.actorId, role: input.approver.role},
      origin: input.origin,
      policyVersion: input.policyVersion,
      producerActorId,
      createdAt: new Date().toISOString(),
      previousRecordHash: approvals.at(-1)?.recordHash ?? null,
    };
    record.recordHash = sha256Value(record);
    await appendApproval(await confinedProjectPath(root, APPROVALS_PATH, {type: "file"}), record);
    return record;
  });
}

export function findCurrentApproval(approvals, query) {
  if (!Array.isArray(approvals)) throw new Error("Approvals must be an array");
  if (BUNDLE_KINDS.has(query?.kind) && query.bundleHash === undefined) return null;
  const record = approvals.findLast((entry) => entry.kind === query?.kind
    && entry.workItemId === query.workItemId
    && entry.subject?.artifactId === query.artifactId
    && entry.subject?.sha256 === query.sha256
    && (query.bundleHash === undefined || entry.bundleHash === query.bundleHash)
    && (query.policyVersion === undefined || entry.policyVersion === query.policyVersion));
  return record?.decision === "approved" ? record : null;
}
