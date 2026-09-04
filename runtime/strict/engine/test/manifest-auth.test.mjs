import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdir, mkdtemp, readFile, readdir, stat, symlink, unlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import * as manifestModule from "../src/manifest.mjs";
import {migrateProject, mutateManifest} from "../src/manifest.mjs";
import {createProject} from "../src/project.mjs";
import {getProjectStatus} from "../src/status.mjs";

const coordinator = {actorId: "content-hub-coordinator", actorRole: "coordinator"};
const manifestModuleUrl = new URL("../src/manifest.mjs", import.meta.url).href;
const releaseFsModuleUrl = new URL("../src/release-fs.mjs", import.meta.url).href;
const schemaV1 = {
  schemaVersion: 1,
  name: "Legacy",
  slug: "legacy",
  localOnly: true,
  mode: "semi-autonomous",
  format: {width: 1920, height: 1080, aspect: "16:9", fps: 30, audioSampleRate: 48000},
  editors: [{id: "premiere", role: "primary"}],
  sources: [],
  assets: [],
  renders: [],
  voiceAuthorizations: [],
  qc: [],
  deliverables: [],
};

async function sourceFiles(directory = join(process.cwd(), "src")) {
  const files = await readdir(directory);
  const nested = await Promise.all(files.map(async (file) => {
    const path = join(directory, file);
    return (await stat(path)).isDirectory() ? sourceFiles(path) : [path];
  }));
  return nested.flat();
}

function child(code) {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", code], {stdio: ["ignore", "pipe", "pipe"]});
    const stderr = [];
    process.stderr.on("data", (chunk) => stderr.push(chunk));
    process.on("error", reject);
    process.on("close", (status) => status === 0 ? resolve(process) : reject(new Error(Buffer.concat(stderr).toString("utf8"))));
  });
}

function appendInChild(projectDir, id) {
  return child(`
    import {mutateManifest} from ${JSON.stringify(manifestModuleUrl)};
    await mutateManifest(${JSON.stringify(projectDir)}, ${JSON.stringify(coordinator)}, async (manifest) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      manifest.assets.push({id: ${JSON.stringify(id)}, kind: "sfx", path: "Assets/SFX/${id}.wav", sha256: "${"a".repeat(64)}", bytes: 1});
      return manifest;
    });
  `);
}

function delayedMigrationInChild(projectDir, gatePath) {
  const process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", `
    import {existsSync} from "node:fs";
    import {migrateProject} from ${JSON.stringify(manifestModuleUrl)};
    let firstRead = true;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    await migrateProject(${JSON.stringify(projectDir)}, {
      actorRole: "coordinator",
      get actorId() {
        if (firstRead) {
          firstRead = false;
          process.stdout.write("read\\n");
          const deadline = Date.now() + 2_000;
          while (!existsSync(${JSON.stringify(gatePath)}) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 25);
        }
        return "content-hub-coordinator";
      },
    });
  `], {stdio: ["ignore", "pipe", "pipe"]});
  const stderr = [];
  process.stderr.on("data", (chunk) => stderr.push(chunk));
  const ready = new Promise((resolve, reject) => {
    process.stdout.once("data", resolve);
    process.once("error", reject);
  });
  const completion = new Promise((resolve, reject) => {
    process.on("error", reject);
    process.on("close", (status) => status === 0 ? resolve() : reject(new Error(Buffer.concat(stderr).toString("utf8"))));
  });
  return {ready, completion};
}

test("rejects manifest writes from a specialist", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-manifest-auth-"));
  const {projectDir} = await createProject(root, {name: "Manifest Auth", editors: ["premiere"]});

  await assert.rejects(
    mutateManifest(projectDir, {actorId: "executor-1", actorRole: "premiere-executor"}, (manifest) => manifest),
    /coordinator/i,
  );
});

test("serializes concurrent distinct asset appends at one canonical project root", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-manifest-auth-"));
  const {projectDir} = await createProject(root, {name: "Manifest Queue", editors: ["premiere"]});
  const ids = Array.from({length: 12}, (_, index) => `asset-${index + 1}`);

  await Promise.all(ids.map((id, index) => mutateManifest(index % 2 ? `${projectDir}/.` : projectDir, coordinator, (manifest) => {
    manifest.assets.push({id, kind: "sfx", path: `Assets/SFX/${id}.wav`, sha256: "a".repeat(64), bytes: 1});
    return manifest;
  })));

  const manifest = JSON.parse(await readFile(join(projectDir, "project.yaml"), "utf8"));
  assert.deepEqual(manifest.assets.map(({id}) => id).toSorted(), ids.toSorted());
});

test("OS-held manifest lock retains both delayed cross-process appends", async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const root = await mkdtemp(join(tmpdir(), "content-hub-manifest-process-"));
    const {projectDir} = await createProject(root, {name: `Manifest Process ${attempt}`, editors: ["premiere"]});
    await Promise.all([appendInChild(projectDir, "left"), appendInChild(projectDir, "right")]);
    assert.deepEqual(JSON.parse(await readFile(join(projectDir, "project.yaml"), "utf8")).assets.map(({id}) => id).toSorted(), ["left", "right"]);
  }
});

test("delayed migration and cross-process mutation retain the mutation", {timeout: 10_000}, async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "content-hub-manifest-migrate-race-"));
  const gatePath = join(projectDir, "migration-gate");
  await writeFile(join(projectDir, "project.yaml"), `${JSON.stringify(schemaV1)}\n`);
  const migration = delayedMigrationInChild(projectDir, gatePath);
  await migration.ready;
  const mutation = appendInChild(projectDir, "during-migration").then(() => writeFile(gatePath, "done\n"));

  await Promise.all([migration.completion, mutation]);

  const manifest = JSON.parse(await readFile(join(projectDir, "project.yaml"), "utf8"));
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.assets.map(({id}) => id), ["during-migration"]);
});

test("project-lock holder crash releases the manifest lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-manifest-lock-crash-"));
  const {projectDir} = await createProject(root, {name: "Manifest Lock Crash", editors: ["premiere"]});
  const holder = spawn(globalThis.process.execPath, ["--input-type=module", "-e", `
    import {acquireProjectLock} from ${JSON.stringify(releaseFsModuleUrl)};
    await acquireProjectLock(${JSON.stringify(projectDir)}, ".project-manifest.lock");
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1_000);
  `], {stdio: ["ignore", "pipe", "pipe"]});
  await new Promise((resolve) => holder.stdout.once("data", resolve));
  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.once("close", resolve));
  await mutateManifest(projectDir, coordinator, (manifest) => {
    manifest.assets.push({id: "after-crash", kind: "sfx", path: "Assets/SFX/after-crash.wav", sha256: "a".repeat(64), bytes: 1});
    return manifest;
  });
  assert.equal(JSON.parse(await readFile(join(projectDir, "project.yaml"), "utf8")).assets[0].id, "after-crash");
});

test("thrown migration releases the manifest lock", {timeout: 5_000}, async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "content-hub-manifest-lock-throw-"));
  const outside = await mkdtemp(join(tmpdir(), "content-hub-manifest-outside-"));
  await writeFile(join(projectDir, "project.yaml"), `${JSON.stringify(schemaV1)}\n`);
  await symlink(outside, join(projectDir, "Plans"), "dir");

  await assert.rejects(migrateProject(projectDir, coordinator), /symlink|project path/i);
  await unlink(join(projectDir, "Plans"));
  const saved = await migrateProject(projectDir, coordinator);

  assert.equal(saved.schemaVersion, 2);
});

test("rejects coordinator transfer and preserves the persisted manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-manifest-auth-"));
  const {projectDir} = await createProject(root, {name: "Coordinator Transfer", editors: ["premiere"]});
  const persisted = await readFile(join(projectDir, "project.yaml"), "utf8");

  await assert.rejects(
    mutateManifest(projectDir, coordinator, (manifest) => {
      manifest.orchestration.coordinatorActorId = "executor-1";
      return manifest;
    }),
    /coordinator/i,
  );

  const unchanged = await readFile(join(projectDir, "project.yaml"), "utf8");
  assert.equal(unchanged, persisted);
  assert.equal(JSON.parse(unchanged).orchestration.coordinatorActorId, "content-hub-coordinator");
});

test("the first authorized mutation persists a schema-v1 manifest as schema v2", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "content-hub-manifest-auth-"));
  await writeFile(join(projectDir, "project.yaml"), `${JSON.stringify(schemaV1)}\n`);

  const saved = await mutateManifest(projectDir, coordinator, (manifest) => {
    manifest.mode = "autonomous";
    return manifest;
  });

  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.mode, "autonomous");
  assert.equal(JSON.parse(await readFile(join(projectDir, "project.yaml"), "utf8")).schemaVersion, 2);
  assert.equal((await stat(join(projectDir, "Plans", "workflow-state.json"))).isFile(), true);
  assert.equal(await readFile(join(projectDir, "Plans", "approvals.jsonl"), "utf8"), "");
  assert.equal((await getProjectStatus(projectDir)).projectState, "DRAFT");
});

test("migrates a legacy project with the authorizing coordinator and required state", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "content-hub-manifest-auth-"));
  await writeFile(join(projectDir, "project.yaml"), `${JSON.stringify(schemaV1)}\n`);
  const context = {actorId: "coord-7", actorRole: "coordinator"};

  const saved = await migrateProject(projectDir, context);

  assert.equal(saved.orchestration.coordinatorActorId, "coord-7");
  assert.equal((await stat(join(projectDir, "Plans", "workflow-state.json"))).isFile(), true);
  assert.equal((await stat(join(projectDir, "Renders", "Candidates"))).isDirectory(), true);
  assert.equal((await stat(join(projectDir, "Renders", "Carousels"))).isDirectory(), true);
  assert.equal((await stat(join(projectDir, "Final", "Deliverables", "Carousels"))).isDirectory(), true);
});

test("does not reassign a schema-v2 coordinator during migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-manifest-auth-"));
  const {projectDir} = await createProject(root, {name: "Existing Coordinator", editors: ["premiere"]});

  await assert.rejects(
    migrateProject(projectDir, {actorId: "coord-7", actorRole: "coordinator"}),
    /Only coordinator content-hub-coordinator/i,
  );
});

test("schema-v1 migration rejects a symlinked Plans directory before creating outside state", async (t) => {
  const migrations = [
    ["implicit mutation", (projectDir) => mutateManifest(projectDir, coordinator, (manifest) => manifest)],
    ["explicit migration", (projectDir) => migrateProject(projectDir, coordinator)],
  ];

  for (const [name, migrate] of migrations) {
    await t.test(name, async () => {
      const projectDir = await mkdtemp(join(tmpdir(), "content-hub-manifest-auth-"));
      const outside = await mkdtemp(join(tmpdir(), "content-hub-manifest-outside-"));
      await writeFile(join(projectDir, "project.yaml"), `${JSON.stringify(schemaV1)}\n`);
      await symlink(outside, join(projectDir, "Plans"), "dir");

      await assert.rejects(migrate(projectDir), /symlink|project path/i);
      await assert.rejects(stat(join(outside, "workflow-state.json")), {code: "ENOENT"});
      await assert.rejects(stat(join(outside, "approvals.jsonl")), {code: "ENOENT"});
      assert.equal(JSON.parse(await readFile(join(projectDir, "project.yaml"), "utf8")).schemaVersion, 1);
    });
  }
});

test("schema-v1 migration rejects a symlinked required parent before creating outside descendants", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "content-hub-manifest-auth-"));
  const outside = await mkdtemp(join(tmpdir(), "content-hub-manifest-outside-"));
  await writeFile(join(projectDir, "project.yaml"), `${JSON.stringify(schemaV1)}\n`);
  await symlink(outside, join(projectDir, "Renders"), "dir");

  await assert.rejects(migrateProject(projectDir, coordinator), /symlink|project path/i);
  await assert.rejects(stat(join(outside, "Shots")), {code: "ENOENT"});
  await assert.rejects(stat(join(outside, "Candidates")), {code: "ENOENT"});
  assert.equal(JSON.parse(await readFile(join(projectDir, "project.yaml"), "utf8")).schemaVersion, 1);
});

test("schema-v1 migration rejects final state symlinks instead of accepting EEXIST", async (t) => {
  for (const file of ["workflow-state.json", "approvals.jsonl"]) {
    await t.test(file, async () => {
      const projectDir = await mkdtemp(join(tmpdir(), "content-hub-manifest-auth-"));
      const outside = join(await mkdtemp(join(tmpdir(), "content-hub-manifest-outside-")), file);
      const sentinel = `outside-${file}\n`;
      await writeFile(join(projectDir, "project.yaml"), `${JSON.stringify(schemaV1)}\n`);
      await mkdir(join(projectDir, "Plans"));
      await writeFile(outside, sentinel);
      await symlink(outside, join(projectDir, "Plans", file));

      await assert.rejects(migrateProject(projectDir, coordinator), /symlink|project path/i);
      assert.equal(await readFile(outside, "utf8"), sentinel);
      assert.equal(JSON.parse(await readFile(join(projectDir, "project.yaml"), "utf8")).schemaVersion, 1);
    });
  }
});

test("schema-v1 migration rejects non-regular final state objects", async (t) => {
  for (const file of ["workflow-state.json", "approvals.jsonl"]) {
    await t.test(file, async () => {
      const projectDir = await mkdtemp(join(tmpdir(), "content-hub-manifest-auth-"));
      await writeFile(join(projectDir, "project.yaml"), `${JSON.stringify(schemaV1)}\n`);
      await mkdir(join(projectDir, "Plans"), {recursive: true});
      await mkdir(join(projectDir, "Plans", file));

      await assert.rejects(migrateProject(projectDir, coordinator), /regular file|project path/i);
      assert.equal(JSON.parse(await readFile(join(projectDir, "project.yaml"), "utf8")).schemaVersion, 1);
    });
  }
});

test("schema-v1 migration preserves existing regular initialized state files", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "content-hub-manifest-auth-"));
  const workflow = `${JSON.stringify({schemaVersion: 1, projectState: "DRAFT", workItems: [], events: []}, null, 2)}\n`;
  await writeFile(join(projectDir, "project.yaml"), `${JSON.stringify(schemaV1)}\n`);
  await mkdir(join(projectDir, "Plans"));
  await writeFile(join(projectDir, "Plans", "workflow-state.json"), workflow);
  await writeFile(join(projectDir, "Plans", "approvals.jsonl"), "");

  const saved = await migrateProject(projectDir, coordinator);

  assert.equal(saved.schemaVersion, 2);
  assert.equal(await readFile(join(projectDir, "Plans", "workflow-state.json"), "utf8"), workflow);
  assert.equal(await readFile(join(projectDir, "Plans", "approvals.jsonl"), "utf8"), "");
});

test("only manifest.mjs initializes or replaces project.yaml", async () => {
  for (const path of await sourceFiles()) {
    if (path.endsWith("manifest.mjs")) continue;
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source, /writeFile\([^\n]*project\.yaml|rename\([^\n]*project\.yaml/u);
    assert.doesNotMatch(source, /\bwriteManifest\b/u);
  }
  assert.equal("writeManifest" in manifestModule, false);
});
