import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import path from "node:path";
import test from "node:test";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("setup and doctor expose safe machine-readable dry runs", async () => {
  const setup = JSON.parse((await exec(process.execPath, ["scripts/setup.mjs", "--dry-run", "--json"], {cwd: root})).stdout);
  assert.equal(setup.versions.hyperframes, "0.8.25");
  assert.equal(setup.versions.premiereMcp, "1.14.5");
  assert.equal(setup.changed, false);
  assert.equal(setup.mcp.mcpServers.premiere.env.PREMIERE_MCP_CAPABILITIES, "inspect,edit,export,filesystem");
  assert.doesNotMatch(setup.mcp.mcpServers.premiere.command, /\/Users\//);

  const doctor = JSON.parse((await exec(process.execPath, ["scripts/doctor.mjs", "--json", "--allow-missing-editor"], {cwd: root})).stdout);
  assert.equal(doctor.required.every(({ok}) => ok), true);
});

test("render and QC support non-mutating dry runs", async () => {
  const render = JSON.parse((await exec(process.execPath, ["scripts/render-hyperframes.mjs", "--template", "title", "--output", "out.mp4", "--dry-run", "--json"], {cwd: root})).stdout);
  assert.match(render.command.join(" "), /hyperframes/);
  assert.match(render.composition, /title\.html$/);
  assert.equal(render.command[render.command.indexOf("-c") + 1], "compositions/title.html");

  const qc = JSON.parse((await exec(process.execPath, ["scripts/qc.mjs", "missing.mp4", "--dry-run", "--json"], {cwd: root})).stdout);
  assert.equal(qc.commands.length, 2);
});
