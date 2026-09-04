import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {cp, mkdtemp, mkdir, readFile, rm, unlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import test from "node:test";
import {tmpdir} from "node:os";
import {promisify} from "node:util";

import {sha256File} from "../src/checksum.mjs";
import {readManifest} from "../src/manifest.mjs";
import {createProject} from "../src/project.mjs";
import {freezeBrandForProject, readFrozenBrand} from "../src/sunburst.mjs";

const coordinator = {actorId: "content-hub-coordinator", actorRole: "coordinator"};
const canonicalBrand = join(process.cwd(), "Brand", "Sunburst");
const contentHubCli = join(process.cwd(), "bin", "content-hub.mjs");
const execFileAsync = promisify(execFile);

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "content-hub-sunburst-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  await cp(canonicalBrand, join(root, "Brand", "Sunburst"), {recursive: true});
  return root;
}

test("freezes Sunburst files and hashes without following later global changes", async (t) => {
  const root = await workspace(t);
  const {projectDir} = await createProject(root, {name: "Sunburst Freeze", editors: ["premiere"]});
  const frozen = await freezeBrandForProject(projectDir, root, coordinator);
  const frameBefore = await readFile(join(projectDir, frozen.framePath), "utf8");

  assert.equal(frozen.artifactId, "project-brand-lock-v001");
  assert.equal(frozen.id, "sunburst-editorial");
  assert.equal(frozen.version, "1.0.0");
  assert.equal(await sha256File(join(projectDir, frozen.framePath)), frozen.frameSha256);
  assert.equal(await sha256File(join(projectDir, frozen.lockPath)), frozen.lockSha256);
  assert.equal(frozen.fonts.length, 2);
  assert.equal(frozen.motifs.length, 2);
  for (const font of frozen.fonts) {
    assert.equal(await sha256File(join(projectDir, font.path)), font.sha256);
    assert.equal(await sha256File(join(projectDir, font.licencePath)), font.licenceSha256);
  }
  for (const motif of frozen.motifs) assert.equal(await sha256File(join(projectDir, motif.path)), motif.sha256);
  const projectManifest = await readManifest(projectDir);
  assert.equal(projectManifest.brand.frameSha256, frozen.frameSha256);
  assert.deepEqual(
    projectManifest.assets.map(({path, sha256}) => ({path, sha256})),
    frozen.motifs.map(({path, sha256}) => ({path, sha256})),
  );

  await writeFile(join(root, "Brand", "Sunburst", "frame.md"), "changed globally\n");
  assert.equal(await readFile(join(projectDir, frozen.framePath), "utf8"), frameBefore);
  assert.deepEqual(await readFrozenBrand(projectDir), frozen);
});

test("a project frame wins and fails closed without local fonts", async (t) => {
  const root = await workspace(t);
  const {projectDir} = await createProject(root, {name: "Client Frame", editors: ["premiere"]});
  await writeFile(join(projectDir, "frame.md"), "---\nid: client-frame\n---\n# Client\n");

  await assert.rejects(
    freezeBrandForProject(projectDir, root, coordinator),
    /project frame requires at least one local font/u,
  );
});

test("freezes a project frame with its existing local fonts and no Sunburst motifs", async (t) => {
  const root = await workspace(t);
  const {projectDir} = await createProject(root, {name: "Client Brand", editors: ["premiere"]});
  const frame = "---\nid: client-frame\nversion: 2.1\n---\n# Client\n";
  await writeFile(join(projectDir, "frame.md"), frame);
  await writeFile(join(projectDir, "Assets", "Fonts", "Client.ttf"), "local-font-bytes");

  const frozen = await freezeBrandForProject(projectDir, root, coordinator);

  assert.equal(frozen.id, "client-frame");
  assert.equal(frozen.version, "2.1");
  assert.equal(await readFile(join(projectDir, frozen.framePath), "utf8"), frame);
  assert.equal(frozen.fonts.length, 1);
  assert.equal(frozen.fonts[0].path, "Plans/Brand/Fonts/Client.ttf");
  await writeFile(join(projectDir, "Assets", "Fonts", "Client.ttf"), "changed-original-font");
  assert.deepEqual(await readFrozenBrand(projectDir), frozen);
  assert.deepEqual(frozen.motifs, []);
  assert.deepEqual((await readManifest(projectDir)).assets, []);
});

test("rejects tampering with every frozen Sunburst payload type", async (t) => {
  const targets = [
    ["frame", (frozen) => frozen.framePath, /frame checksum mismatch/u],
    ["font", (frozen) => frozen.fonts[0].path, /font checksum mismatch/u],
    ["font licence", (frozen) => frozen.fonts[0].licencePath, /font licence checksum mismatch/u],
    ["motif", (frozen) => frozen.motifs[0].path, /motif checksum mismatch/u],
  ];

  for (const [name, selectPath, expected] of targets) {
    await t.test(name, async (subtest) => {
      const root = await workspace(subtest);
      const {projectDir} = await createProject(root, {name: `Tampered ${name}`, editors: ["premiere"]});
      const frozen = await freezeBrandForProject(projectDir, root, coordinator);
      await writeFile(join(projectDir, selectPath(frozen)), "tampered\n");
      await assert.rejects(readFrozenBrand(projectDir), expected);
    });
  }
});

test("rejects tampering with the frozen client-font snapshot", async (t) => {
  const root = await workspace(t);
  const {projectDir} = await createProject(root, {name: "Tampered Client Font", editors: ["premiere"]});
  await writeFile(join(projectDir, "frame.md"), "---\nid: client-frame\n---\n# Client\n");
  await writeFile(join(projectDir, "Assets", "Fonts", "Client.ttf"), "local-font-bytes");
  const frozen = await freezeBrandForProject(projectDir, root, coordinator);

  await writeFile(join(projectDir, frozen.fonts[0].path), "tampered\n");

  await assert.rejects(readFrozenBrand(projectDir), /font checksum mismatch/u);
});

test("rejects a changed immutable brand lock", async (t) => {
  const root = await workspace(t);
  const {projectDir} = await createProject(root, {name: "Tampered Brand", editors: ["premiere"]});
  const frozen = await freezeBrandForProject(projectDir, root, coordinator);
  await writeFile(join(projectDir, frozen.lockPath), "{}\n");

  await assert.rejects(readFrozenBrand(projectDir), /brand lock checksum mismatch/u);
});

test("CLI freezes the resolved brand with the named coordinator", async (t) => {
  const root = await workspace(t);
  await createProject(root, {
    name: "CLI Brand",
    editors: ["premiere"],
    coordinatorActorId: "coordinator-smoke",
  });

  const {stdout} = await execFileAsync(process.execPath, [
    contentHubCli,
    "brand-freeze",
    "cli-brand",
    "--actor",
    "coordinator-smoke",
    "--json",
  ], {cwd: root});
  const frozen = JSON.parse(stdout);

  assert.equal(frozen.id, "sunburst-editorial");
  assert.equal(frozen.version, "1.0.0");
  assert.equal(frozen.fonts.length, 2);
  assert.equal(frozen.motifs.length, 2);
});

test("a late freeze failure cleans only invocation files and permits a corrected retry", async (t) => {
  const root = await workspace(t);
  const {projectDir} = await createProject(root, {name: "Retry Brand", editors: ["premiere"]});
  const existingFont = join(projectDir, "Assets", "Fonts", "keep.ttf");
  const collidingLock = join(projectDir, "Plans", "Brand", "brand-lock.json");
  await writeFile(existingFont, "pre-existing-font");
  await mkdir(join(projectDir, "Plans", "Brand"), {recursive: true});
  await writeFile(collidingLock, "pre-existing-lock\n");

  await assert.rejects(freezeBrandForProject(projectDir, root, coordinator), {code: "EEXIST"});

  assert.equal(await readFile(existingFont, "utf8"), "pre-existing-font");
  assert.equal(await readFile(collidingLock, "utf8"), "pre-existing-lock\n");
  const failedManifest = await readManifest(projectDir);
  assert.equal(failedManifest.brand, undefined);
  assert.deepEqual(failedManifest.assets, []);
  await assert.rejects(readFile(join(projectDir, "Plans", "Brand", "frame.md")), {code: "ENOENT"});
  await assert.rejects(readFile(join(projectDir, "Assets", "Fonts", "Archivo[wdth,wght].ttf")), {code: "ENOENT"});
  await assert.rejects(readFile(join(projectDir, "Assets", "Images", "Sunburst", "sunburst-grain.svg")), {code: "ENOENT"});

  await unlink(collidingLock);
  const frozen = await freezeBrandForProject(projectDir, root, coordinator);
  assert.equal(frozen.id, "sunburst-editorial");
  assert.equal(await readFile(existingFont, "utf8"), "pre-existing-font");
  assert.equal((await readManifest(projectDir)).brand.lockSha256, frozen.lockSha256);
});
