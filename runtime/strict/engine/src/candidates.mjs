import {lstat, readFile, readdir, realpath, stat} from "node:fs/promises";
import {basename, isAbsolute, join, relative, resolve, sep} from "node:path";

import {findCurrentApproval, readApprovals} from "./approvals.mjs";
import {sha256File, sha256Value} from "./checksum.mjs";
import {assertCoordinator, readManifest} from "./manifest.mjs";
import {removeOwnedFile, writeExclusiveFile} from "./release-fs.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const VIDEO_MODALITIES = new Set(["voice-over", "raw-video", "multi-clip"]);
const VIDEO_PRODUCER_ROLES = new Set(["premiere-executor", "hyperframes-executor"]);
const CAROUSEL_PRODUCER_ROLES = new Set(["carousel-lead", "carousel-slide-executor"]);
const BUNDLE_KEYS = new Set([
  "schemaVersion", "workItemId", "modality", "revision", "files", "inputLock", "inputLockHash", "lineage", "settings", "producer", "versions", "requestedDerivatives", "createdAt", "bundleHash",
]);
const BIZIBEAST_ARTIFACT_PREFIXES = new Set([
  "asset-plan", "candidate", "caption-plan", "foreground-sidecar", "media-index", "narration", "narration-transcript",
  "premiere-readback", "script", "source-transcript", "story-plan", "subject-map", "video-design-plan", "video-execution-plan",
]);
const candidateBundleOwners = new WeakMap();

export function getCandidateBundleOwner(bundle) {
  return candidateBundleOwners.get(bundle) ?? null;
}

function assertId(value, label, {artifact = false} = {}) {
  const pattern = artifact ? /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u : /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
  if (typeof value !== "string" || value.length > 255 || !pattern.test(value) || value === "." || value === ".." || value.includes("::")
    || (artifact && value.includes(":") && !BIZIBEAST_ARTIFACT_PREFIXES.has(value.split(":", 1)[0]))) {
    throw new Error(`${label} must be a safe identifier`);
  }
}

function assertHash(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 hash`);
}

function assertJson(value, label) {
  try {
    sha256Value(value);
  } catch {
    throw new Error(`${label} must contain only JSON values`);
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} required`);
}

function assertRevision(revision) {
  if (!Number.isInteger(revision) || revision < 1) throw new Error("Candidate revision must be a positive integer");
}

function assertModality(modality) {
  if (modality !== "carousel" && !VIDEO_MODALITIES.has(modality)) throw new Error(`Unsupported candidate modality: ${modality}`);
}

function assertRelativePath(path, label) {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`${label} must be a confined relative path`);
}

function isWithin(root, target) {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function assertNoSymlinkComponents(root, target) {
  let current = root;
  for (const component of relative(root, target).split(sep)) {
    current = resolve(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("Candidate path cannot contain symlinks");
  }
}

function outputKeys(output, keys) {
  return Object.keys(output).length === keys.length && keys.every((key) => Object.hasOwn(output, key));
}

function normalizeOutput(modality, output) {
  assertPlainObject(output, "Candidate output");
  assertRelativePath(output.path, "Candidate output path");
  if (!Number.isInteger(output.order) || output.order < 1) throw new Error("Candidate output order must be a positive integer");
  if (modality !== "carousel") {
    if (!outputKeys(output, ["path", "kind", "order"]) || !["master", "deliverable"].includes(output.kind)) throw new Error("Video candidate output must be a master or deliverable");
    return {path: output.path, kind: output.kind, order: output.order};
  }
  if (output.kind === "carousel-slide") {
    if (!outputKeys(output, ["path", "kind", "order", "slideId", "format", "approvedCopySha256"])) throw new Error("Carousel slide has an invalid shape");
    assertId(output.slideId, "Carousel slide slideId");
    if (!["4:5", "1:1"].includes(output.format)) throw new Error("Carousel slide format must be 4:5 or 1:1");
    assertHash(output.approvedCopySha256, "Carousel slide approvedCopySha256");
    return {path: output.path, kind: output.kind, order: output.order, slideId: output.slideId, format: output.format, approvedCopySha256: output.approvedCopySha256};
  }
  if (output.kind === "derivative") {
    if (!outputKeys(output, ["path", "kind", "order", "slideId", "format", "approvedCopySha256"]) || output.slideId !== null) throw new Error("Carousel derivative has an invalid shape");
    if (!["pdf", "zip"].includes(output.format)) throw new Error("Carousel derivative format must be pdf or zip");
    assertHash(output.approvedCopySha256, "Carousel derivative approvedCopySha256");
    return {path: output.path, kind: output.kind, order: output.order, slideId: null, format: output.format, approvedCopySha256: output.approvedCopySha256};
  }
  throw new Error("Carousel candidate output must be a carousel slide or derivative");
}

function normalizeInputLock(inputLock) {
  assertPlainObject(inputLock, "Candidate input lock");
  if (!Object.keys(inputLock).every((key) => ["artifacts", "approvals", "assets"].includes(key)) || !["artifacts", "approvals", "assets"].every((key) => Array.isArray(inputLock[key]))) throw new Error("Candidate input lock requires artifacts, approvals, and assets");
  const normalizeReferences = (references, label, hashKey) => {
    const ids = new Set();
    return references.map((reference) => {
      assertPlainObject(reference, `${label} reference`);
      if (!outputKeys(reference, ["id", hashKey])) throw new Error(`${label} reference has an invalid shape`);
      assertId(reference.id, `${label} id`, {artifact: label === "Artifact"});
      assertHash(reference[hashKey], `${label} ${hashKey}`);
      if (ids.has(reference.id)) throw new Error(`${label} references must have unique ids`);
      ids.add(reference.id);
      return {id: reference.id, [hashKey]: reference[hashKey]};
    });
  };
  return {
    artifacts: normalizeReferences(inputLock.artifacts, "Artifact", "sha256"),
    approvals: normalizeReferences(inputLock.approvals, "Approval", "subjectSha256"),
    assets: normalizeReferences(inputLock.assets, "Asset", "sha256"),
  };
}

function normalizeProducer(modality, producer) {
  assertPlainObject(producer, "Candidate producer");
  if (!outputKeys(producer, ["actorId", "role"])) throw new Error("Candidate producer must contain actorId and role");
  assertId(producer.actorId, "Candidate producer actor id");
  const roles = modality === "carousel" ? CAROUSEL_PRODUCER_ROLES : VIDEO_PRODUCER_ROLES;
  if (!roles.has(producer.role)) throw new Error(`Candidate producer role is invalid for ${modality}`);
  return {actorId: producer.actorId, role: producer.role};
}

function normalizeMetadata(input) {
  assertPlainObject(input, "Candidate input");
  assertId(input.workItemId, "Candidate work item id");
  assertModality(input.modality);
  assertRevision(input.revision);
  if (!Array.isArray(input.outputs) || input.outputs.length === 0) throw new Error("Candidate outputs required");
  const files = input.outputs.map((output) => normalizeOutput(input.modality, output));
  const paths = new Set();
  const orders = new Set();
  for (const file of files) {
    if (paths.has(file.path) || orders.has(file.order)) throw new Error("Candidate output paths and orders must be unique");
    paths.add(file.path);
    orders.add(file.order);
  }
  for (const key of ["lineage", "settings", "versions", "requestedDerivatives"]) {
    if (!Object.hasOwn(input, key)) throw new Error(`Candidate ${key} required`);
    assertJson(input[key], `Candidate ${key}`);
  }
  return {
    workItemId: input.workItemId,
    modality: input.modality,
    revision: input.revision,
    outputs: files,
    inputLock: normalizeInputLock(input.inputLock),
    lineage: structuredClone(input.lineage),
    settings: structuredClone(input.settings),
    producer: normalizeProducer(input.modality, input.producer),
    versions: structuredClone(input.versions),
    requestedDerivatives: structuredClone(input.requestedDerivatives),
  };
}

async function assertRequiredApproval(projectDir, manifest, input) {
  const requiredKind = input.modality === "carousel" ? "carousel-copy" : "script";
  const approvals = await readApprovals(projectDir);
  const locked = input.inputLock.approvals.map((lock) => ({lock, record: approvals.find((record) => record.id === lock.id)})).filter(({record}) => record?.kind === requiredKind && record.workItemId === input.workItemId);
  if (locked.length !== 1) throw new Error(`Candidate requires one current ${requiredKind} approval`);
  const {lock, record} = locked[0];
  const current = findCurrentApproval(approvals, {
    kind: requiredKind,
    workItemId: input.workItemId,
    artifactId: record.subject.artifactId,
    sha256: lock.subjectSha256,
    policyVersion: manifest.orchestration.policyVersion,
  });
  if (record.subject.sha256 !== lock.subjectSha256 || current?.id !== lock.id) throw new Error(`Candidate requires a current ${requiredKind} approval`);
  if (!input.inputLock.artifacts.some((artifact) => artifact.id === record.subject.artifactId && artifact.sha256 === lock.subjectSha256)) throw new Error("Candidate input lock must include the approved artifact");
  if (input.modality === "carousel" && input.outputs.some((output) => output.approvedCopySha256 !== lock.subjectSha256)) throw new Error("Carousel output approvedCopySha256 must match the current carousel-copy approval");
}

async function assertCandidateFile(root, directory, output) {
  const absolutePath = resolve(root, output.path);
  if (!isWithin(directory, absolutePath) || absolutePath === directory || relative(root, absolutePath).split(sep).join("/") !== output.path) throw new Error("Candidate output must stay in its exact candidate directory");
  await assertNoSymlinkComponents(root, absolutePath);
  const info = await stat(absolutePath);
  if (!info.isFile()) throw new Error(`Candidate output is not a regular file: ${output.path}`);
  return {...output, bytes: info.size, sha256: await sha256File(absolutePath)};
}

function candidateDirectoryForRoot(root, modality, workItemId, revision) {
  return join(root, modality === "carousel" ? "Renders/Carousels" : "Renders/Candidates", workItemId, `v${String(revision).padStart(3, "0")}`);
}

export function candidateDirectory(projectDir, modality, workItemId, revision) {
  assertModality(modality);
  assertId(workItemId, "Candidate work item id");
  assertRevision(revision);
  return candidateDirectoryForRoot(projectDir, modality, workItemId, revision);
}

export async function freezeCandidateBundle(projectDir, coordinatorContext, input) {
  const manifest = await readManifest(projectDir);
  assertCoordinator(manifest, coordinatorContext);
  const normalized = normalizeMetadata(input);
  await assertRequiredApproval(projectDir, manifest, normalized);
  const root = await realpath(projectDir);
  const directory = candidateDirectoryForRoot(root, normalized.modality, normalized.workItemId, normalized.revision);
  const files = [];
  for (const output of [...normalized.outputs].sort((left, right) => left.order - right.order || left.path.localeCompare(right.path))) files.push(await assertCandidateFile(root, directory, output));
  const inputLockHash = sha256Value(normalized.inputLock);
  const unsigned = {
    schemaVersion: 1,
    workItemId: normalized.workItemId,
    modality: normalized.modality,
    revision: normalized.revision,
    files,
    inputLock: normalized.inputLock,
    inputLockHash,
    lineage: normalized.lineage,
    settings: normalized.settings,
    producer: normalized.producer,
    versions: normalized.versions,
    requestedDerivatives: normalized.requestedDerivatives,
    createdAt: new Date().toISOString(),
  };
  const bundle = {...unsigned, bundleHash: sha256Value(unsigned)};
  const bundlePath = join(directory, "bundle.json");
  const relativeBundlePath = relative(root, bundlePath).split(sep).join("/");
  let owner;
  try {
    owner = await writeExclusiveFile(root, relativeBundlePath, Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, "utf8"));
  } catch (error) {
    if (/create exclusive file: File exists/u.test(error?.message)) error.code = "EEXIST";
    throw error;
  }
  try {
    await verifyCandidateBundle(root, bundlePath);
    const result = {...bundle, bundlePath};
    candidateBundleOwners.set(result, owner);
    return result;
  } catch (error) {
    await removeOwnedFile(root, relativeBundlePath, owner).catch(() => false);
    throw error;
  }
}

function validateSavedBundle(bundle) {
  assertPlainObject(bundle, "Candidate bundle");
  if (!Object.keys(bundle).every((key) => BUNDLE_KEYS.has(key)) || Object.keys(bundle).length !== BUNDLE_KEYS.size || bundle.schemaVersion !== 1) throw new Error("Candidate bundle has an invalid shape");
  if (!Array.isArray(bundle.files) || bundle.files.length === 0) throw new Error("Candidate bundle files required");
  const normalized = normalizeMetadata({...bundle, outputs: bundle.files.map(({bytes, sha256, ...output}) => output)});
  const files = bundle.files.map((file) => {
    const {bytes, sha256, ...rawOutput} = file;
    const output = normalizeOutput(bundle.modality, rawOutput);
    if (!outputKeys(file, [...Object.keys(output), "bytes", "sha256"]) || !Number.isInteger(file.bytes) || file.bytes < 0) throw new Error("Candidate bundle file has an invalid shape");
    assertHash(file.sha256, "Candidate bundle file hash");
    return {...output, bytes: file.bytes, sha256: file.sha256};
  });
  if (files.some((file, index) => index > 0 && (files[index - 1].order > file.order || (files[index - 1].order === file.order && files[index - 1].path.localeCompare(file.path) > 0)))) throw new Error("Candidate bundle files must be ordered");
  if (sha256Value(normalized.inputLock) !== bundle.inputLockHash) throw new Error("Candidate input lock hash mismatch");
  assertHash(bundle.bundleHash, "Candidate bundle hash");
  if (typeof bundle.createdAt !== "string" || Number.isNaN(Date.parse(bundle.createdAt))) throw new Error("Candidate bundle createdAt required");
  return {...normalized, files, inputLockHash: bundle.inputLockHash, createdAt: bundle.createdAt, bundleHash: bundle.bundleHash};
}

export async function verifyCandidateBundle(projectDir, bundlePath) {
  const root = await realpath(projectDir);
  const absoluteBundlePath = isAbsolute(bundlePath) ? resolve(bundlePath) : resolve(root, bundlePath);
  if (!isWithin(root, absoluteBundlePath) || basename(absoluteBundlePath) !== "bundle.json") throw new Error("Candidate bundle path must stay under project directory");
  await assertNoSymlinkComponents(root, absoluteBundlePath);
  let saved;
  try {
    saved = JSON.parse(await readFile(absoluteBundlePath, "utf8"));
  } catch {
    throw new Error("Candidate bundle is malformed");
  }
  const bundle = validateSavedBundle(saved);
  const directory = candidateDirectoryForRoot(root, bundle.modality, bundle.workItemId, bundle.revision);
  if (absoluteBundlePath !== join(directory, "bundle.json")) throw new Error("Candidate bundle must use its exact candidate directory");
  const {bundleHash, ...unsigned} = saved;
  if (sha256Value(unsigned) !== bundleHash) throw new Error("Candidate bundle hash mismatch");
  for (const file of bundle.files) {
    const actual = await assertCandidateFile(root, directory, file);
    if (actual.bytes !== file.bytes) throw new Error(`Candidate file size mismatch: ${file.path}`);
    if (actual.sha256 !== file.sha256) throw new Error(`Candidate file hash mismatch: ${file.path}`);
  }
  return {...saved, bundlePath: absoluteBundlePath};
}

export async function findVerifiedCandidateBundle(projectDir, {bundleHash, workItemId}) {
  assertHash(bundleHash, "Candidate bundle hash");
  assertId(workItemId, "Candidate work item id");
  const root = await realpath(projectDir);
  let match = null;
  for (const base of ["Renders/Candidates", "Renders/Carousels"]) {
    let versions;
    try {
      versions = await readdir(join(root, base, workItemId), {withFileTypes: true});
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const version of versions.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!version.isDirectory() || !/^v[0-9]+$/u.test(version.name)) continue;
      const bundlePath = join(root, base, workItemId, version.name, "bundle.json");
      let saved;
      try {
        saved = JSON.parse(await readFile(bundlePath, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT" || error instanceof SyntaxError) continue;
        throw error;
      }
      if (saved?.bundleHash !== bundleHash) continue;
      if (match) throw new Error("Candidate bundle hash identifies more than one bundle");
      match = await verifyCandidateBundle(root, bundlePath);
    }
  }
  if (!match) throw new Error("Verified candidate bundle not found for approval");
  return match;
}
