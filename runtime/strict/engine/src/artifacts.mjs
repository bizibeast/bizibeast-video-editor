import {lstat, mkdir, realpath, writeFile} from "node:fs/promises";
import {dirname, isAbsolute, relative, resolve, sep} from "node:path";
import {canonicalJson, sha256File} from "./checksum.mjs";
import {transitionWorkItem} from "./workflow.mjs";

const MODALITIES = new Set(["voice-over", "raw-video", "multi-clip", "carousel"]);
const SHA256 = /^[a-f0-9]{64}$/u;

function assertNonEmpty(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
}

function assertJson(value, label) {
  try {
    canonicalJson(value);
  } catch {
    throw new Error(`${label} must be JSON-serializable`);
  }
}

export function validateArtifactEnvelope(artifact) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) throw new Error("Artifact envelope is required");
  if (artifact.schemaVersion !== 1) throw new Error("Unsupported artifact schema version");
  assertNonEmpty(artifact.artifactId, "Artifact id");
  if (!Number.isInteger(artifact.revision) || artifact.revision < 1) throw new Error("Artifact revision must be a positive integer");
  assertNonEmpty(artifact.workItemId, "Work item id");
  if (!MODALITIES.has(artifact.modality)) throw new Error(`Unsupported artifact modality: ${artifact.modality}`);
  if (!Array.isArray(artifact.parents)) throw new Error("Artifact parents must be an array");
  const parentIds = new Set();
  for (const parent of artifact.parents) {
    assertNonEmpty(parent?.artifactId, "Artifact parent id");
    if (!SHA256.test(parent.sha256) || parentIds.has(parent.artifactId)) throw new Error("Artifact parents must have unique ids and lowercase SHA-256 hashes");
    parentIds.add(parent.artifactId);
  }
  assertNonEmpty(artifact.producer?.actorId, "Producer actor id");
  assertNonEmpty(artifact.producer?.role, "Producer role");
  if (!artifact.versions || typeof artifact.versions !== "object" || ["tool", "template", "model", "policy"].some((key) => !Object.hasOwn(artifact.versions, key) || artifact.versions[key] === undefined)) {
    throw new Error("Artifact versions must include tool, template, model, and policy");
  }
  assertNonEmpty(artifact.createdAt, "Artifact creation time");
  assertNonEmpty(artifact.status, "Artifact status");
  if (!Array.isArray(artifact.deviations)) throw new Error("Artifact deviations must be an array");
  if (!Object.hasOwn(artifact, "payload")) throw new Error("Artifact payload is required");
  assertJson(artifact.payload, "Artifact payload");
  assertJson(artifact, "Artifact envelope");
  return artifact;
}

export function createArtifactEnvelope(input) {
  return validateArtifactEnvelope({
    schemaVersion: 1,
    artifactId: input.artifactId,
    revision: input.revision,
    workItemId: input.workItemId,
    modality: input.modality,
    parents: input.parents,
    producer: input.producer,
    versions: input.versions,
    createdAt: input.createdAt ?? new Date().toISOString(),
    status: input.status,
    deviations: input.deviations ?? [],
    payload: input.payload,
  });
}

function validateArtifactPath(projectDir, relativePath, revision) {
  if (typeof relativePath !== "string" || isAbsolute(relativePath)) throw new Error("Artifact path must stay under Plans/ or QC/");
  const root = resolve(projectDir);
  const absolutePath = resolve(root, relativePath);
  const confined = relative(root, absolutePath).split(sep).join("/");
  if (confined.startsWith("../") || confined === ".." || (!confined.startsWith("Plans/") && !confined.startsWith("QC/"))) {
    throw new Error("Artifact path must stay under Plans/ or QC/");
  }
  const match = confined.startsWith("Plans/")
    ? /-v(\d{3})\.json$/u.exec(confined)
    : /^QC\/[^/]+\/v(\d{3})\/.+\.json$/u.exec(confined);
  if (!match || Number(match[1]) !== revision) throw new Error("Artifact path revision must match envelope revision");
  return {root, absolutePath, confined};
}

function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function assertNoSymlinkComponents(root, target) {
  let current = root;
  for (const component of relative(root, target).split(sep)) {
    current = resolve(current, component);
    let status;
    try {
      status = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (status.isSymbolicLink()) throw new Error("Artifact path cannot contain symlinks");
  }
}

async function assertSafeArtifactParent(root, absolutePath) {
  await assertNoSymlinkComponents(root, absolutePath);
  await mkdir(dirname(absolutePath), {recursive: true});
  await assertNoSymlinkComponents(root, absolutePath);
  const [realRoot, realParent] = await Promise.all([realpath(root), realpath(dirname(absolutePath))]);
  if (!isWithin(realRoot, realParent)) throw new Error("Artifact path must stay under project directory");
}

export async function writeImmutableArtifact(projectDir, relativePath, artifact) {
  validateArtifactEnvelope(artifact);
  const {root, absolutePath, confined} = validateArtifactPath(projectDir, relativePath, artifact.revision);
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  await assertSafeArtifactParent(root, absolutePath);
  await writeFile(absolutePath, serialized, {encoding: "utf8", flag: "wx"});
  return {path: confined, sha256: await sha256File(absolutePath)};
}

export function verifyArtifactParents(artifact, currentParents) {
  validateArtifactEnvelope(artifact);
  for (const parent of artifact.parents) {
    if (currentParents.get(parent.artifactId) !== parent.sha256) throw new Error(`Artifact parent hash changed: ${parent.artifactId}`);
  }
  return true;
}

export async function verifyArtifactParentsOrSupersede(projectDir, coordinatorContext, artifact, currentParents, storedArtifactRef) {
  if (typeof storedArtifactRef?.id !== "string" || !storedArtifactRef.id.trim() || storedArtifactRef.id !== artifact.artifactId) throw new Error("Stored artifact id must match artifact id");
  if (typeof storedArtifactRef.sha256 !== "string" || !SHA256.test(storedArtifactRef.sha256)) throw new Error("Stored artifact requires a lowercase SHA-256 hash");
  try {
    return verifyArtifactParents(artifact, currentParents);
  } catch (error) {
    if (!/^Artifact parent hash changed:/u.test(error?.message)) throw error;
    await transitionWorkItem(projectDir, coordinatorContext, {
      workItemId: artifact.workItemId,
      to: "SUPERSEDED",
      reason: error.message,
      artifactRef: {id: storedArtifactRef.id, sha256: storedArtifactRef.sha256},
    });
    throw error;
  }
}
