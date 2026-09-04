import assert from "node:assert/strict";
import {mkdtemp, readFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {recordAcceptance} from "../scripts/record-acceptance.mjs";

test("live acceptance record binds editor readback and QC without embedding media", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bizibeast-acceptance-"));
  const target = path.join(root, "acceptance.json");
  const record = await recordAcceptance({
    output: target,
    data: {
      project: "sample-short",
      mode: "crew",
      premiere: {liveVerified: true, sequenceId: "seq-1", premiereReadbackReceiptSha256: "a".repeat(64)},
      export: {sha256: "b".repeat(64), durationSeconds: 10.8},
      qc: {technical: "pass", creative: "pass"}
    }
  });
  assert.equal(record.schemaVersion, 1);
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), record);
});

test("published Premiere smoke discloses the unsupported caption readback", async () => {
  const evidence = JSON.parse(await readFile(new URL("../evidence/live-premiere-smoke-v0.1.0.json", import.meta.url), "utf8"));
  assert.equal(evidence.premiere.premiereReadbackReceiptSha256, null);
  assert.equal(evidence.premiere.captionStructuralReadbackSupported, false);
  assert.equal(evidence.premiere.nativeCaptionVisualVerification, true);
  assert.equal(evidence.export.sha256, "97f8bb3bc1d4f4ab2fcc6e8880600a615f4028d24980106925296da0b25b6133");
});
