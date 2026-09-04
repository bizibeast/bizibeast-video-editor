import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {runDoctor} from "../src/doctor.mjs";

test("doctor reports local-only policy and missing integrations honestly", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-doctor-"));
  const report = await runDoctor(root, {
    resolveCommand: async () => null,
    listApplications: async () => [],
    freeBytes: async () => 80 * 1024 ** 3,
  });

  assert.deepEqual(report.policy, {
    localOnly: true,
      cloudInference: false,
      hostedImageGenerationOptIn: true,
      paidServices: false,
    uploadsProjectMedia: false,
  });
  assert.equal(report.commands.ffmpeg.status, "missing");
  assert.equal(report.apps.premiere.status, "missing");
  assert.equal(report.integrations.premiere.status, "missing");
  assert.equal(report.integrations.premiere.liveVerified, false);
  assert.equal(report.ready, false);
});

test("doctor does not equate an installed Premiere bridge with a live connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-doctor-"));
  const report = await runDoctor(root, {
    resolveCommand: async (command) => `/fake/${command}`,
    listApplications: async () => ["Adobe Premiere Pro 2026", "Adobe After Effects 2026"],
    freeBytes: async () => 80 * 1024 ** 3,
    pathExists: async (path) => path.includes("premiere-pro-mcp"),
  });

  assert.equal(report.integrations.premiere.status, "installed");
  assert.equal(report.integrations.premiere.liveVerified, false);
  assert.equal(report.ready, false);
});
