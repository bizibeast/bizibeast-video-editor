import assert from "node:assert/strict";
import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {readManifest} from "../src/manifest.mjs";
import {recordOutput} from "../src/output-records.mjs";
import {createProject} from "../src/project.mjs";

const coordinator = {actorId: "content-hub-coordinator", actorRole: "coordinator"};

test("records versioned renders and deliverables with checksums", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-output-"));
  const {projectDir} = await createProject(root, {name: "Output Test", editors: ["premiere"]});
  const render = join(projectDir, "Renders", "Shots", "title-v001.mp4");
  const deliverable = join(projectDir, "Final", "Deliverables", "final.mp4");
  await writeFile(render, "render bytes");
  await writeFile(deliverable, "delivery bytes");

  const renderRecord = await recordOutput(projectDir, {kind: "render", path: render, editor: "hyperframes"}, coordinator);
  const deliveryRecord = await recordOutput(projectDir, {kind: "deliverable", path: deliverable, sourceId: renderRecord.id}, coordinator);
  const manifest = await readManifest(projectDir);

  assert.equal(manifest.renders.length, 1);
  assert.equal(manifest.deliverables.length, 1);
  assert.match(renderRecord.path, /^Renders\/Shots\//u);
  assert.match(deliveryRecord.path, /^Final\/Deliverables\//u);
  assert.equal(renderRecord.sha256, "a3732d694c3b1d3133ce1f035f87d786e64abc46799027e37b353b55dd6ecae1");
});

test("refuses to record a file outside the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-output-"));
  const outside = join(root, "outside.mp4");
  await writeFile(outside, "outside");
  const {projectDir} = await createProject(root, {name: "Output Refusal", editors: ["premiere"]});

  await assert.rejects(recordOutput(projectDir, {kind: "render", path: outside}, coordinator), /inside the project/i);
});
