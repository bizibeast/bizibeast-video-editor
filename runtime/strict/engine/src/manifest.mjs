import {randomUUID} from "node:crypto";
import {mkdir, readFile, realpath, rename, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {confinedProjectPath, REQUIRED_PROJECT_PATHS} from "./paths.mjs";
import {acquireProjectLock} from "./release-fs.mjs";
import {migrateManifestV1ToV2, validateManifestV2} from "./schema.mjs";

const MANIFEST_NAME = "project.yaml";
const MANIFEST_LOCK_PATH = ".project-manifest.lock";
const manifestQueues = new Map();

export async function readManifest(projectDir) {
  const raw = JSON.parse(await readFile(join(projectDir, MANIFEST_NAME), "utf8"));
  return validateManifestV2(raw.schemaVersion === 1 ? migrateManifestV1ToV2(raw) : raw);
}

export async function initializeManifest(projectDir, manifest) {
  validateManifestV2(manifest);
  await writeFile(join(projectDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, {encoding: "utf8", flag: "wx"});
}

async function atomicWrite(target, contents) {
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, contents, {encoding: "utf8", mode: 0o600});
  await rename(temporary, target);
}

export function assertCoordinator(manifest, context) {
  if (context?.actorRole !== "coordinator" || context.actorId !== manifest.orchestration.coordinatorActorId) {
    throw new Error(`Only coordinator ${manifest.orchestration.coordinatorActorId} may mutate project state`);
  }
  return true;
}

export async function mutateManifest(projectDir, context, mutator) {
  return withManifestTransaction(projectDir, async (root) => {
    const raw = JSON.parse(await readFile(join(root, MANIFEST_NAME), "utf8"));
    const legacy = raw.schemaVersion === 1;
    const manifest = validateManifestV2(legacy ? migrateManifestV1ToV2(raw) : raw);
    assertCoordinator(manifest, context);
    const next = validateManifestV2(await mutator(structuredClone(manifest)) ?? manifest);
    if (next.orchestration.coordinatorActorId !== manifest.orchestration.coordinatorActorId) throw new Error("Coordinator actor cannot change after project creation");
    next.updatedAt = new Date().toISOString();
    if (legacy) await initializeMigrationPaths(root, next);
    await atomicWrite(join(root, MANIFEST_NAME), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

async function withManifestTransaction(projectDir, operation) {
  const root = await realpath(projectDir);
  return serializeManifest(root, async () => {
    const lock = await acquireProjectLock(root, MANIFEST_LOCK_PATH);
    try {
      return await operation(root);
    } finally {
      await lock.release();
    }
  });
}

function serializeManifest(projectDir, operation) {
  const previous = manifestQueues.get(projectDir) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  const completion = next.then(() => undefined, () => undefined).finally(() => {
    if (manifestQueues.get(projectDir) === completion) manifestQueues.delete(projectDir);
  });
  manifestQueues.set(projectDir, completion);
  return next;
}

async function initializeMigrationPaths(projectDir, manifest) {
  for (const relativePath of REQUIRED_PROJECT_PATHS) {
    const path = await confinedProjectPath(projectDir, relativePath, {allowMissing: true, type: "directory"});
    await mkdir(path, {recursive: true});
    await confinedProjectPath(projectDir, relativePath, {type: "directory"});
  }
  await Promise.all([
    initializeMigrationFile(
      projectDir,
      manifest.orchestration.workflowStatePath,
      `${JSON.stringify({schemaVersion: 1, projectState: "DRAFT", workItems: [], events: []}, null, 2)}\n`,
    ),
    initializeMigrationFile(projectDir, manifest.orchestration.approvalsPath, ""),
  ]);
}

async function initializeMigrationFile(projectDir, relativePath, contents) {
  const path = await confinedProjectPath(projectDir, relativePath, {allowMissing: true, type: "file"});
  try {
    await writeFile(path, contents, {encoding: "utf8", flag: "wx"});
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await confinedProjectPath(projectDir, relativePath, {type: "file"});
}

export async function migrateProject(projectDir, context) {
  return withManifestTransaction(projectDir, async (root) => {
    const target = join(root, MANIFEST_NAME);
    const raw = JSON.parse(await readFile(target, "utf8"));
    if (raw.schemaVersion !== 1) {
      const manifest = validateManifestV2(raw);
      assertCoordinator(manifest, context);
      return manifest;
    }

    const manifest = validateManifestV2(migrateManifestV1ToV2(raw, context?.actorId));
    assertCoordinator(manifest, context);
    await initializeMigrationPaths(root, manifest);
    await atomicWrite(target, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  });
}
