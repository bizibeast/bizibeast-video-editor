import {createHash, randomUUID} from "node:crypto";
import {lstat, realpath} from "node:fs/promises";
import {basename, dirname, extname, isAbsolute, relative, resolve, sep} from "node:path";

import {findCurrentApproval, readApprovals} from "./approvals.mjs";
import {validateArtifactEnvelope} from "./artifacts.mjs";
import {verifyCandidateBundle} from "./candidates.mjs";
import {sha256Value} from "./checksum.mjs";
import {readManifest} from "./manifest.mjs";
import {confinedProjectPath} from "./paths.mjs";
import {findLockedArtifacts} from "./qc.mjs";
import {
  copyExclusiveFile,
  hashFileNoFollow,
  makeDirectories,
  makeExclusiveDirectory,
  readFileNoFollow,
  removeOwnedFile,
  removeOwnedStage,
  renameExclusive,
  writeExclusiveFile,
} from "./release-fs.mjs";
import {getWorkItem, readWorkflowState, transitionWorkItem} from "./workflow.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const DESIGN_KINDS = new Set(["design-plan", "video-design-plan", "carousel-plan"]);
const RECEIPT_KEYS = Object.freeze([
  "schemaVersion", "workItemId", "modality", "revision", "bundleHash", "candidateBundle", "technicalEvidence",
  "creativeEvidence", "approvalRefs", "workflowRefs", "policyVersion", "profileId", "profileHash",
  "requestedDerivatives", "promoter", "files", "createdAt", "receiptHash",
]);

function revisionText(revision) {
  return String(revision).padStart(3, "0");
}

function hasParent(artifact, artifactId, sha256) {
  return artifact.parents.some((parent) => parent.artifactId === artifactId && parent.sha256 === sha256);
}

async function evidenceRelativePath(root, value, expected) {
  if (typeof value !== "string") throw new Error("Release evidence path is required");
  const requested = isAbsolute(value) ? relative(root, await realpath(value)) : value.split(sep).join("/");
  if (requested !== expected) throw new Error("Release evidence must use the exact bundle QC path");
  return requested;
}

async function readEvidence(root, value, expected) {
  const path = await evidenceRelativePath(root, value, expected);
  await confinedProjectPath(root, path, {type: "file"});
  const stored = await readFileNoFollow(root, path);
  let evidence;
  try {
    evidence = JSON.parse(stored.bytes.toString("utf8"));
  } catch {
    throw new Error("Release evidence is malformed");
  }
  validateArtifactEnvelope(evidence);
  return {evidence, path, sha256: sha256Bytes(stored.bytes)};
}

function assertEvidence(bundle, technical, creative, input) {
  const envelopes = [technical.evidence, creative.evidence];
  if (envelopes.some((evidence) => evidence.workItemId !== bundle.workItemId
    || evidence.revision !== bundle.revision || evidence.modality !== bundle.modality)) {
    throw new Error("Release evidence work item, revision, or modality mismatch");
  }
  if (technical.evidence.producer?.role !== "technical-qc-validator" || technical.evidence.status !== "passed"
    || technical.evidence.payload?.kind !== "technical-qc" || technical.evidence.payload.pass !== true) {
    throw new Error("Technical evidence must be a passing validator envelope");
  }
  if (creative.evidence.producer?.role !== "creative-qc-reviewer" || creative.evidence.status !== "passed"
    || creative.evidence.payload?.kind !== "creative-qc" || creative.evidence.payload.pass !== true) {
    throw new Error("Creative evidence must be a passing reviewer envelope");
  }
  const hashes = new Set([
    bundle.bundleHash,
    technical.evidence.payload.candidateBundleHash,
    creative.evidence.payload.candidateBundleHash,
  ]);
  if (hashes.size !== 1) throw new Error("Candidate bundle hash mismatch across release gates");
  if (technical.evidence.payload.policyVersion !== input.policyVersion
    || creative.evidence.payload.policyVersion !== input.policyVersion
    || bundle.versions?.policy !== input.policyVersion
    || technical.evidence.versions.policy !== input.policyVersion
    || creative.evidence.versions.policy !== input.policyVersion
    || technical.evidence.payload.profileHash !== creative.evidence.payload.profileHash
    || technical.evidence.payload.profileHash !== bundle.settings?.profileHash
    || technical.evidence.payload.profileId !== creative.evidence.payload.profileId
    || technical.evidence.payload.profileId !== bundle.settings?.profileId) {
    throw new Error("Release policy or technical profile hash mismatch");
  }
  for (const lock of bundle.inputLock.artifacts) {
    if (!hasParent(technical.evidence, lock.id, lock.sha256)) throw new Error("Technical evidence parent hash mismatch");
  }
  const candidateId = `candidate:${bundle.workItemId}:v${revisionText(bundle.revision)}`;
  if (!hasParent(creative.evidence, candidateId, bundle.bundleHash)
    || !hasParent(creative.evidence, technical.evidence.artifactId, technical.sha256)
    || creative.evidence.payload.technicalEvidenceSha256 !== technical.sha256) {
    throw new Error("Creative evidence parent hash mismatch");
  }
}

function currentApproval(approvals, query, message) {
  const approval = findCurrentApproval(approvals, query);
  if (!approval) throw new Error(message);
  return approval;
}

async function assertApprovals(projectDir, manifest, bundle, creative) {
  const approvals = await readApprovals(projectDir);
  const requiredKind = bundle.modality === "carousel" ? "carousel-copy" : "script";
  const locked = bundle.inputLock.approvals.filter((lock) => {
    const approval = approvals.find(({id}) => id === lock.id);
    return approval?.kind === requiredKind && approval.workItemId === bundle.workItemId;
  });
  if (locked.length !== 1) throw new Error(`Release requires one current ${requiredKind} approval`);
  const approval = approvals.find(({id}) => id === locked[0].id);
  const current = currentApproval(approvals, {
    kind: requiredKind, workItemId: bundle.workItemId, artifactId: approval.subject.artifactId,
    sha256: locked[0].subjectSha256, policyVersion: inputPolicy(manifest),
  }, `Release requires one current ${requiredKind} approval`);
  if (current.id !== locked[0].id || approval.subject.sha256 !== locked[0].subjectSha256
    || !bundle.inputLock.artifacts.some(({id, sha256}) => id === approval.subject.artifactId && sha256 === approval.subject.sha256)) {
    throw new Error(`Release requires one current exact-hash ${requiredKind} approval`);
  }

  const artifacts = await findLockedArtifacts(projectDir, bundle.inputLock.artifacts);
  const designs = artifacts.filter(({payload}) => DESIGN_KINDS.has(payload?.kind));
  if (designs.length !== 1) throw new Error("Release requires one locked design blueprint");
  if (designs[0].workItemId !== bundle.workItemId || designs[0].revision !== bundle.revision || designs[0].modality !== bundle.modality) {
    throw new Error("Release requires one exact-revision design blueprint");
  }
  const designLock = bundle.inputLock.artifacts.find(({id}) => id === designs[0].artifactId);
  const designApproval = currentApproval(approvals, {
    kind: "design", workItemId: bundle.workItemId, artifactId: designLock.id,
    sha256: designLock.sha256, policyVersion: inputPolicy(manifest),
  }, "Release requires a current exact-hash design approval");

  const creativeApproval = currentApproval(approvals, {
    kind: "creative", workItemId: bundle.workItemId, artifactId: creative.evidence.artifactId,
    sha256: creative.sha256, bundleHash: bundle.bundleHash, policyVersion: inputPolicy(manifest),
  }, "Release requires a current exact-hash creative approval");

  let human = null;
  if (manifest.mode === "semi-autonomous") {
    const humanCandidates = approvals.filter((entry) => entry.kind === "human-release"
      && entry.workItemId === bundle.workItemId && entry.subject?.sha256 === bundle.bundleHash
      && entry.bundleHash === bundle.bundleHash && entry.policyVersion === inputPolicy(manifest));
    human = humanCandidates.findLast((entry) => findCurrentApproval(approvals, {
      kind: "human-release", workItemId: bundle.workItemId, artifactId: entry.subject.artifactId,
      sha256: bundle.bundleHash, bundleHash: bundle.bundleHash, policyVersion: inputPolicy(manifest),
    })?.id === entry.id);
    if (!human) throw new Error("Semi-autonomous release requires a current human-release approval for the exact bundle");
  }
  return {approvals, artifacts, approvalRefs: [current, designApproval, creativeApproval, human].filter(Boolean).map(({id, kind, recordHash}) => ({id, kind, recordHash}))};
}

function inputPolicy(manifest) {
  return manifest.orchestration.policyVersion;
}

function assertRequestedDerivatives(bundle) {
  if (!Array.isArray(bundle.requestedDerivatives) || bundle.requestedDerivatives.some((value) => typeof value !== "string" || !value)) {
    throw new Error("Requested derivatives must be a string array");
  }
  for (const requested of bundle.requestedDerivatives) {
    const present = bundle.files.some((file) => file.format === requested || extname(file.path).slice(1).toLowerCase() === requested.toLowerCase());
    if (!present) throw new Error(`Requested derivative is not in the frozen bundle: ${requested}`);
  }
}

function validatePromoter(promoter, manifest, bundle, technical, creative, releaseContext) {
  if (typeof promoter?.actorId !== "string" || !promoter.actorId.trim() || promoter.role !== "release-promoter") {
    throw new Error("Release requires a release-promoter");
  }
  const actorId = promoter.actorId.trim();
  const disallowed = new Set([
    manifest.orchestration.coordinatorActorId,
    bundle.producer.actorId,
    technical.evidence.producer.actorId,
    creative.evidence.producer.actorId,
  ]);
  for (const artifact of releaseContext.artifacts) {
    if (["script", "carousel-copy"].includes(artifact.payload?.kind) || DESIGN_KINDS.has(artifact.payload?.kind)) {
      disallowed.add(artifact.producer.actorId);
    }
  }
  for (const approval of releaseContext.approvals) {
    if (["script", "carousel-copy", "design"].includes(approval.kind) && approval.workItemId === bundle.workItemId) {
      disallowed.add(approval.approver.actorId);
      if (approval.producerActorId) disallowed.add(approval.producerActorId);
    }
  }
  if (disallowed.has(actorId)) {
    throw new Error("Release promoter must be independent from production and QC");
  }
  return {actorId, role: promoter.role};
}

function finalDirectory(bundle) {
  const base = bundle.modality === "carousel" ? "Final/Deliverables/Carousels" : "Final/Masters";
  return `${base}/${bundle.workItemId}/v${revisionText(bundle.revision)}`;
}

async function assertMissing(path, label) {
  try {
    await lstat(path);
    throw new Error(`${label} already exists`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameOwner(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

async function readPreparedReceipt(projectDir, receiptPath, expected) {
  let stored;
  try {
    stored = await readFileNoFollow(projectDir, receiptPath);
  } catch (error) {
    if (/No such file/u.test(error.message)) return null;
    throw error;
  }
  let receipt;
  try {
    receipt = validateReceipt(JSON.parse(stored.bytes.toString("utf8")));
  } catch {
    throw new Error("Prepared release receipt is invalid; preserving it");
  }
  const {createdAt, receiptHash, ...actual} = receipt;
  if (sha256Value(actual) !== sha256Value(expected)) throw new Error("Prepared release receipt does not match this candidate; preserving it");
  const exact = {...expected, createdAt, receiptHash};
  const bytes = Buffer.from(`${JSON.stringify(exact, null, 2)}\n`);
  if (receiptHash !== sha256Value({...expected, createdAt}) || !stored.bytes.equals(bytes)) {
    throw new Error("Prepared release receipt bytes do not match; preserving it");
  }
  return {receipt, bytes, owner: stored.owner, sha256: sha256Bytes(bytes)};
}

async function validateReleaseInputs(root, input, allowedStates) {
  const bundle = await verifyCandidateBundle(root, input.bundlePath);
  const manifest = await readManifest(root);
  if (input?.policyVersion !== inputPolicy(manifest)) throw new Error("Release policy or technical profile hash mismatch");
  const revision = revisionText(bundle.revision);
  const technical = await readEvidence(root, input?.technicalEvidencePath, `QC/${bundle.workItemId}/v${revision}/technical-qc.json`);
  const creative = await readEvidence(root, input?.creativeEvidencePath, `QC/${bundle.workItemId}/v${revision}/creative-qc.json`);
  assertEvidence(bundle, technical, creative, input);
  const releaseContext = await assertApprovals(root, manifest, bundle, creative);
  const promoter = validatePromoter(input?.promoter, manifest, bundle, technical, creative, releaseContext);
  assertRequestedDerivatives(bundle);
  const workflow = await readWorkflowState(root);
  const item = getWorkItem(workflow, bundle.workItemId);
  if (!allowedStates.includes(item.state) || item.revision !== bundle.revision || item.modality !== bundle.modality) {
    throw new Error(`Release requires the exact work item revision in ${allowedStates.join(" or ")} state`);
  }
  const workflowRefs = [
    ["CANDIDATE_FROZEN", `candidate:${bundle.workItemId}:v${revision}`, bundle.bundleHash],
    ["TECH_PASSED", technical.evidence.artifactId, technical.sha256],
    ["CREATIVE_PASSED", creative.evidence.artifactId, creative.sha256],
    ["APPROVED", creative.evidence.artifactId, creative.sha256],
  ].map(([state, id, sha256]) => ({state, artifactRef: {id, sha256}}));
  for (const {state, artifactRef} of workflowRefs) {
    const event = workflow.events.findLast(({workItemId, to}) => workItemId === bundle.workItemId && to === state);
    if (event?.artifactRef?.id !== artifactRef.id || event.artifactRef.sha256 !== artifactRef.sha256) {
      throw new Error(`Release workflow evidence mismatch at ${state}`);
    }
  }
  const bundlePath = relative(root, bundle.bundlePath).split(sep).join("/");
  const bundleFile = await hashFileNoFollow(root, bundlePath);
  return {bundle, bundlePath, bundleFile, manifest, technical, creative, releaseContext, promoter, workflow, item, workflowRefs};
}

export async function promotePassingBundle(projectDir, bundlePath, input) {
  const root = await realpath(projectDir);
  const {bundle, bundlePath: candidateBundlePath, bundleFile, technical, creative, releaseContext, promoter, workflowRefs} = await validateReleaseInputs(root, {...input, bundlePath}, ["APPROVED"]);
  const revision = revisionText(bundle.revision);

  const finalPath = finalDirectory(bundle);
  const receiptPath = `QC/${bundle.workItemId}/v${revision}/release-receipt.json`;
  const stagingPath = `QC/${bundle.workItemId}/v${revision}/.release-${randomUUID()}`;
  const finalDir = await confinedProjectPath(root, finalPath, {allowMissing: true, type: "directory"});
  await confinedProjectPath(root, dirname(finalPath), {allowMissing: true, type: "directory"});
  await confinedProjectPath(root, receiptPath, {allowMissing: true, type: "file"});
  await confinedProjectPath(root, stagingPath, {allowMissing: true, type: "directory"});
  await assertMissing(finalDir, "Final release path");
  const names = bundle.files.map(({path}) => basename(path));
  if (new Set(names).size !== names.length) throw new Error("Bundle outputs must have unique final filenames");
  const finalPrefix = finalPath;
  const expectedReceipt = {
    schemaVersion: 1,
    workItemId: bundle.workItemId,
    modality: bundle.modality,
    revision: bundle.revision,
    bundleHash: bundle.bundleHash,
    candidateBundle: {path: candidateBundlePath, sha256: bundleFile.sha256},
    technicalEvidence: {path: technical.path, sha256: technical.sha256},
    creativeEvidence: {path: creative.path, sha256: creative.sha256},
    approvalRefs: releaseContext.approvalRefs,
    workflowRefs,
    policyVersion: input.policyVersion,
    profileId: technical.evidence.payload.profileId,
    profileHash: technical.evidence.payload.profileHash,
    requestedDerivatives: structuredClone(bundle.requestedDerivatives),
    promoter,
    files: bundle.files.map((file) => ({
      sourcePath: file.path,
      finalPath: `${finalPrefix}/${basename(file.path)}`,
      bytes: file.bytes,
      sha256: file.sha256,
    })),
  };
  const prepared = await readPreparedReceipt(root, receiptPath, expectedReceipt);
  const unsigned = {...expectedReceipt, createdAt: prepared?.receipt.createdAt ?? new Date().toISOString()};
  const receipt = prepared?.receipt ?? {...unsigned, receiptHash: sha256Value(unsigned)};
  const receiptBytes = prepared?.bytes ?? Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  validateReceipt(receipt);
  let stageOwner;
  const stagedOwners = new Map();
  let receiptOwner = prepared?.owner;
  let receiptCreated = false;
  let finalPublished = false;
  let receiptSha256 = prepared?.sha256;
  try {
    stageOwner = await makeExclusiveDirectory(root, stagingPath);
    await confinedProjectPath(root, stagingPath, {type: "directory"});
    for (const file of bundle.files) {
      const stagedRelativePath = `${stagingPath}/${basename(file.path)}`;
      await confinedProjectPath(root, stagedRelativePath, {allowMissing: true, type: "file"});
      const copiedOwner = await copyExclusiveFile(root, file.path, stagedRelativePath);
      stagedOwners.set(`${finalPrefix}/${basename(file.path)}`, copiedOwner);
      await confinedProjectPath(root, stagedRelativePath, {type: "file"});
      const staged = await hashFileNoFollow(root, stagedRelativePath);
      if (!sameOwner(staged.owner, copiedOwner) || staged.bytes !== file.bytes || staged.sha256 !== file.sha256) {
        throw new Error(`Staged copy hash mismatch: ${file.path}`);
      }
    }
    await makeDirectories(root, dirname(finalPath));
    await confinedProjectPath(root, dirname(finalPath), {type: "directory"});
    if (!prepared) {
      receiptOwner = await writeExclusiveFile(root, receiptPath, receiptBytes);
      receiptCreated = true;
    }
    await confinedProjectPath(root, receiptPath, {type: "file"});
    const stored = await readFileNoFollow(root, receiptPath);
    if (!sameOwner(stored.owner, receiptOwner) || !stored.bytes.equals(receiptBytes)) throw new Error("Release receipt changed before Final promotion");
    receiptSha256 = sha256Bytes(stored.bytes);
    await renameExclusive(root, stagingPath, finalPath, stageOwner);
    finalPublished = true;
    await confinedProjectPath(root, finalPath, {type: "directory"});
    for (const file of receipt.files) {
      await confinedProjectPath(root, file.finalPath, {type: "file"});
      const published = await hashFileNoFollow(root, file.finalPath);
      if (!sameOwner(published.owner, stagedOwners.get(file.finalPath))
        || published.bytes !== file.bytes || published.sha256 !== file.sha256) {
        throw new Error(`Published Final hash mismatch: ${file.finalPath}`);
      }
    }
  } catch (error) {
    if (!finalPublished && stageOwner) await removeOwnedStage(root, stagingPath, stageOwner);
    if (!finalPublished && receiptCreated && receiptOwner) await removeOwnedFile(root, receiptPath, receiptOwner);
    throw error;
  }
  return {...receipt, receiptPath, receiptSha256};
}

function validateReceipt(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || Object.keys(receipt).length !== RECEIPT_KEYS.length || !RECEIPT_KEYS.every((key) => Object.hasOwn(receipt, key))
    || receipt.schemaVersion !== 1 || !Number.isInteger(receipt.revision) || receipt.revision < 1
    || typeof receipt.workItemId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(receipt.workItemId)
    || !["voice-over", "raw-video", "multi-clip", "carousel"].includes(receipt.modality)
    || !SHA256.test(receipt.bundleHash) || !SHA256.test(receipt.profileHash) || !SHA256.test(receipt.receiptHash)
    || typeof receipt.profileId !== "string" || !receipt.profileId
    || !Array.isArray(receipt.files) || receipt.files.length === 0 || !Array.isArray(receipt.requestedDerivatives)
    || !Array.isArray(receipt.approvalRefs) || receipt.approvalRefs.length < 3
    || !Array.isArray(receipt.workflowRefs) || receipt.workflowRefs.length !== 4
    || receipt.requestedDerivatives.some((value) => typeof value !== "string" || !value)
    || typeof receipt.policyVersion !== "string" || !receipt.policyVersion
    || typeof receipt.promoter?.actorId !== "string" || !receipt.promoter.actorId || receipt.promoter.role !== "release-promoter"
    || typeof receipt.createdAt !== "string" || Number.isNaN(Date.parse(receipt.createdAt))) {
    throw new Error("Release receipt is malformed");
  }
  const revision = revisionText(receipt.revision);
  const candidatePrefix = `${receipt.modality === "carousel" ? "Renders/Carousels" : "Renders/Candidates"}/${receipt.workItemId}/v${revision}`;
  if (receipt.candidateBundle?.path !== `${candidatePrefix}/bundle.json` || !SHA256.test(receipt.candidateBundle.sha256)) {
    throw new Error("Release receipt candidate bundle is malformed");
  }
  for (const [kind, evidence] of [["technical", receipt.technicalEvidence], ["creative", receipt.creativeEvidence]]) {
    if (!evidence || Object.keys(evidence).length !== 2 || evidence.path !== `QC/${receipt.workItemId}/v${revision}/${kind}-qc.json` || !SHA256.test(evidence.sha256)) {
      throw new Error("Release receipt evidence is malformed");
    }
  }
  const approvalIds = new Set();
  if (receipt.approvalRefs.some((ref) => !ref || Object.keys(ref).length !== 3 || typeof ref.id !== "string"
    || typeof ref.kind !== "string" || !SHA256.test(ref.recordHash) || approvalIds.has(ref.id) || !approvalIds.add(ref.id))) {
    throw new Error("Release receipt approvals are malformed");
  }
  const workflowStates = ["CANDIDATE_FROZEN", "TECH_PASSED", "CREATIVE_PASSED", "APPROVED"];
  if (receipt.workflowRefs.some((ref, index) => ref?.state !== workflowStates[index]
    || typeof ref.artifactRef?.id !== "string" || !SHA256.test(ref.artifactRef?.sha256))) {
    throw new Error("Release receipt workflow references are malformed");
  }
  const {receiptHash, ...unsigned} = receipt;
  if (sha256Value(unsigned) !== receiptHash) throw new Error("Release receipt hash mismatch");
  return receipt;
}

export async function readReleaseReceipt(projectDir, releaseReceiptPath) {
  const root = await realpath(projectDir);
  const requested = isAbsolute(releaseReceiptPath) ? relative(root, await realpath(releaseReceiptPath)) : releaseReceiptPath;
  const match = /^QC\/([^/]+)\/v(\d{3})\/release-receipt\.json$/u.exec(requested);
  if (!match) throw new Error("Release receipt must use its exact QC path");
  await confinedProjectPath(root, requested, {type: "file"});
  const stored = await readFileNoFollow(root, requested);
  let receipt;
  try {
    receipt = validateReceipt(JSON.parse(stored.bytes.toString("utf8")));
  } catch (error) {
    if (error?.message?.startsWith("Release receipt")) throw error;
    throw new Error("Release receipt is malformed");
  }
  if (receipt.workItemId !== match[1] || receipt.revision !== Number(match[2])) throw new Error("Release receipt path mismatch");
  const revision = revisionText(receipt.revision);
  const sourcePrefix = `${receipt.modality === "carousel" ? "Renders/Carousels" : "Renders/Candidates"}/${receipt.workItemId}/v${revision}/`;
  const finalPrefix = `${receipt.modality === "carousel" ? "Final/Deliverables/Carousels" : "Final/Masters"}/${receipt.workItemId}/v${revision}/`;
  const sourcePaths = new Set();
  const finalPaths = new Set();
  for (const file of receipt.files) {
    if (!file || typeof file !== "object" || Object.keys(file).length !== 4
      || typeof file.sourcePath !== "string" || typeof file.finalPath !== "string"
      || !file.sourcePath.startsWith(sourcePrefix) || file.finalPath !== `${finalPrefix}${basename(file.sourcePath)}`
      || sourcePaths.has(file.sourcePath) || finalPaths.has(file.finalPath)
      || !Number.isInteger(file.bytes) || file.bytes < 0 || !SHA256.test(file.sha256)) {
      throw new Error("Release receipt file is malformed");
    }
    sourcePaths.add(file.sourcePath);
    finalPaths.add(file.finalPath);
    await confinedProjectPath(root, file.finalPath, {type: "file"});
    const finalFile = await hashFileNoFollow(root, file.finalPath);
    if (finalFile.bytes !== file.bytes) throw new Error(`Final deliverable size mismatch: ${file.finalPath}`);
    if (finalFile.sha256 !== file.sha256) throw new Error(`Final deliverable hash mismatch: ${file.finalPath}`);
  }
  return {receipt, path: requested, sha256: sha256Bytes(stored.bytes)};
}

export async function validateReleaseProjectState(projectDir, releaseReceiptPath, allowedStates = ["APPROVED", "RELEASED", "DELIVERED"]) {
  const root = await realpath(projectDir);
  const stored = await readReleaseReceipt(root, releaseReceiptPath);
  const {receipt} = stored;
  const state = await validateReleaseInputs(root, {
    bundlePath: receipt.candidateBundle.path,
    technicalEvidencePath: receipt.technicalEvidence.path,
    creativeEvidencePath: receipt.creativeEvidence.path,
    promoter: receipt.promoter,
    policyVersion: receipt.policyVersion,
  }, allowedStates);
  const finalPrefix = finalDirectory(state.bundle);
  const expected = {
    candidateBundle: {path: state.bundlePath, sha256: state.bundleFile.sha256},
    technicalEvidence: {path: state.technical.path, sha256: state.technical.sha256},
    creativeEvidence: {path: state.creative.path, sha256: state.creative.sha256},
    approvalRefs: state.releaseContext.approvalRefs,
    workflowRefs: state.workflowRefs,
    bundleHash: state.bundle.bundleHash,
    workItemId: state.bundle.workItemId,
    modality: state.bundle.modality,
    revision: state.bundle.revision,
    policyVersion: inputPolicy(state.manifest),
    profileId: state.technical.evidence.payload.profileId,
    profileHash: state.technical.evidence.payload.profileHash,
    requestedDerivatives: state.bundle.requestedDerivatives,
    promoter: state.promoter,
    files: state.bundle.files.map((file) => ({
      sourcePath: file.path,
      finalPath: `${finalPrefix}/${basename(file.path)}`,
      bytes: file.bytes,
      sha256: file.sha256,
    })),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (sha256Value(receipt[key]) !== sha256Value(value)) throw new Error(`Release receipt ${key} does not match current project state`);
  }
  return {...stored, ...state};
}

function releaseArtifactRef(receipt, sha256) {
  return {id: `release-receipt:${receipt.workItemId}:v${revisionText(receipt.revision)}`, sha256};
}

export async function recordRelease(projectDir, coordinatorContext, releaseReceiptPath) {
  const {receipt, sha256} = await validateReleaseProjectState(projectDir, releaseReceiptPath, ["APPROVED"]);
  return transitionWorkItem(projectDir, coordinatorContext, {
    workItemId: receipt.workItemId,
    to: "RELEASED",
    reason: "exact passing bundle promoted to Final",
    artifactRef: releaseArtifactRef(receipt, sha256),
  });
}

export async function markDelivered(projectDir, coordinatorContext, workItemId, releaseReceiptPath) {
  const {receipt, sha256, workflow: state} = await validateReleaseProjectState(projectDir, releaseReceiptPath, ["RELEASED"]);
  if (receipt.workItemId !== workItemId) throw new Error("Release receipt work item mismatch");
  const item = getWorkItem(state, workItemId);
  const artifactRef = releaseArtifactRef(receipt, sha256);
  const released = state.events.findLast((event) => event.workItemId === workItemId && event.to === "RELEASED");
  if (item.state !== "RELEASED" || released?.artifactRef?.id !== artifactRef.id || released.artifactRef.sha256 !== artifactRef.sha256) {
    throw new Error("Delivery requires RELEASED state bound to the exact release receipt");
  }
  return transitionWorkItem(projectDir, coordinatorContext, {
    workItemId,
    to: "DELIVERED",
    reason: "verified Final deliverables presented",
    artifactRef,
  });
}
