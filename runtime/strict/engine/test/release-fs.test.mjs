import assert from "node:assert/strict";
import {access, mkdir, mkdtemp, readFile, readdir, rename, stat, symlink, unlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {
  acquireProjectLock,
  copyExclusiveFile,
  hashFileNoFollow,
  makeExclusiveDirectory,
  readFileNoFollow,
  removeOwnedFile,
  removeOwnedStage,
  renameExclusive,
  writeExclusiveFile,
} from "../src/release-fs.mjs";

test("project lock is no-follow, reusable, and releases when its control pipe closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-release-fs-"));
  const first = await acquireProjectLock(root, ".project-manifest.lock");
  await first.release();
  const second = await acquireProjectLock(root, ".project-manifest.lock");
  await second.release();

  await unlink(join(root, ".project-manifest.lock"));
  await symlink(join(root, "outside"), join(root, ".project-manifest.lock"));
  await assert.rejects(acquireProjectLock(root, ".project-manifest.lock"), /symlink|lock/i);
});

test("native helper refuses symlinked parents without writing outside root", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-release-fs-"));
  const outside = await mkdtemp(join(tmpdir(), "content-hub-release-outside-"));
  await mkdir(join(root, "QC"));
  await symlink(outside, join(root, "QC/swapped"), "dir");

  await assert.rejects(writeExclusiveFile(root, "QC/swapped/receipt.json", Buffer.from("receipt")), /symlink|not a directory/i);

  assert.deepEqual(await readdir(outside), []);
});

test("native rename-excl never replaces even an empty target directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-release-fs-"));
  await mkdir(join(root, "QC"));
  await mkdir(join(root, "Final"));
  const stage = await makeExclusiveDirectory(root, "QC/staging");
  await writeExclusiveFile(root, "QC/staging/master.mp4", Buffer.from("candidate"));
  await mkdir(join(root, "Final/v001"));

  await assert.rejects(renameExclusive(root, "QC/staging", "Final/v001", stage), /exists/i);

  await access(join(root, "QC/staging/master.mp4"));
  assert.deepEqual(await readdir(join(root, "Final/v001")), []);
});

test("inode-owned receipt cleanup preserves a replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-release-fs-"));
  await mkdir(join(root, "QC"));
  const original = await writeExclusiveFile(root, "QC/release-receipt.json", Buffer.from("original"));
  await rename(join(root, "QC/release-receipt.json"), join(root, "QC/original.json"));
  await writeFile(join(root, "QC/release-receipt.json"), "replacement", {flag: "wx"});

  assert.equal(await removeOwnedFile(root, "QC/release-receipt.json", original), false);
  assert.equal(await readFile(join(root, "QC/release-receipt.json"), "utf8"), "replacement");
});

test("inode-owned staging cleanup preserves a replacement directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-release-fs-"));
  await mkdir(join(root, "QC"));
  const original = await makeExclusiveDirectory(root, "QC/staging");
  await rename(join(root, "QC/staging"), join(root, "QC/original-stage"));
  await mkdir(join(root, "QC/staging"));
  await writeFile(join(root, "QC/staging/replacement.txt"), "replacement");

  assert.equal(await removeOwnedStage(root, "QC/staging", original), false);
  assert.equal(await readFile(join(root, "QC/staging/replacement.txt"), "utf8"), "replacement");
});

test("native exclusive copy and no-follow read preserve exact bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-release-fs-"));
  await mkdir(join(root, "Source"));
  await mkdir(join(root, "QC"));
  const bytes = Buffer.from([0, 1, 2, 3, 255]);
  await writeFile(join(root, "Source/master.mov"), bytes);
  await copyExclusiveFile(root, "Source/master.mov", "QC/master.mov");

  const read = await readFileNoFollow(root, "QC/master.mov");
  const hashed = await hashFileNoFollow(root, "QC/master.mov");
  const metadata = await stat(join(root, "QC/master.mov"));

  assert.deepEqual(read.bytes, bytes);
  assert.equal(hashed.sha256, "ff5d8507b6a72bee2debce2c0054798deaccdc5d8a1b945b6280ce8aa9cba52e");
  assert.equal(hashed.bytes, bytes.length);
  assert.equal(hashed.mtimeMs, metadata.mtimeMs);
  assert.deepEqual(hashed.owner, read.owner);
  assert.match(read.owner.dev, /^\d+$/u);
  assert.match(read.owner.ino, /^\d+$/u);
});

test("exclusive write reports an existing destination without an unhandled large-input EPIPE", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-release-fs-"));
  await mkdir(join(root, "QC"));
  await writeFile(join(root, "QC/release-receipt.json"), "existing", {flag: "wx"});

  await assert.rejects(
    writeExclusiveFile(root, "QC/release-receipt.json", Buffer.alloc(8 * 1024 * 1024, 1)),
    /exists/i,
  );

  assert.equal(await readFile(join(root, "QC/release-receipt.json"), "utf8"), "existing");
});

test("concurrent large exclusive writes have one winner and semantic losers", async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const root = await mkdtemp(join(tmpdir(), "content-hub-release-fs-"));
    await mkdir(join(root, "QC"));
    const target = "QC/release-receipt.json";
    const results = await Promise.allSettled([
      writeExclusiveFile(root, target, Buffer.alloc(8 * 1024 * 1024, 1)),
      writeExclusiveFile(root, target, Buffer.alloc(8 * 1024 * 1024, 2)),
    ]);

    assert.equal(results.filter(({status}) => status === "fulfilled").length, 1);
    const loser = results.find(({status}) => status === "rejected");
    assert.match(loser.reason.message, /exists/i);
    assert.equal((await readFile(join(root, target))).length, 8 * 1024 * 1024);
  }
});
