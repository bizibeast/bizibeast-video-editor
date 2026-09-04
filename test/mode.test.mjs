import assert from "node:assert/strict";
import test from "node:test";

import {resolveRun} from "../scripts/mode.mjs";

test("crew is the default and delegates all editing roles", () => {
  const run = resolveRun({});
  assert.equal(run.mode, "crew");
  assert.equal(run.execution, "delegated");
  assert.deepEqual(run.roles, [
    "coordinator",
    "media-technician",
    "story-editor",
    "design-director",
    "hyperframes-executor",
    "premiere-executor",
    "qc-reviewer"
  ]);
});

test("crew falls back to the same roles sequentially", () => {
  const run = resolveRun({mode: "crew", canDelegate: false});
  assert.equal(run.execution, "sequential");
  assert.equal(run.roles.at(0), "coordinator");
  assert.equal(run.roles.at(-1), "qc-reviewer");
});

test("quick and strict route to their intended runtimes", () => {
  assert.deepEqual(resolveRun({mode: "quick"}), {
    mode: "quick",
    execution: "single-agent",
    roles: ["editor"]
  });
  assert.equal(resolveRun({mode: "strict"}).execution, "optional-strict-runtime");
  assert.throws(() => resolveRun({mode: "production"}), /quick, crew, or strict/);
});
