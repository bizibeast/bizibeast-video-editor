import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import path from "node:path";
import test from "node:test";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("strict adapter uses the bundled completed engine", async () => {
  let stdout;
  try {
    stdout = (await exec(process.execPath, ["runtime/strict/adapter.mjs", "doctor", "--json"], {cwd: root})).stdout;
  } catch (error) {
    stdout = error.stdout;
  }
  const report = JSON.parse(stdout);
  assert.equal(report.policy.localOnly, true);
  assert.equal(report.root, path.join(root, "runtime/strict/engine"));
  assert.equal(report.ready, false);
});
