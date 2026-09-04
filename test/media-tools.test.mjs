import assert from "node:assert/strict";
import {mkdtemp, readFile, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {findAssets} from "../scripts/find-assets.mjs";
import {ingest} from "../scripts/ingest.mjs";
import {detectSubjectAnalyzer} from "../scripts/subject-analysis.mjs";
import {detectTranscriber} from "../scripts/transcribe.mjs";
import {createProject} from "../scripts/new-project.mjs";

test("ingest copies source bytes without changing originals and asset lookup hashes them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bizibeast-media-"));
  const source = path.join(root, "camera clip.mov");
  await writeFile(source, "immutable camera bytes");
  const project = (await createProject({name: "Ingest", root: path.join(root, "Projects")})).path;
  const result = await ingest(project, source, {kind: "source"});
  assert.equal(await readFile(result.path, "utf8"), "immutable camera bytes");
  assert.equal(await readFile(source, "utf8"), "immutable camera bytes");
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  const assets = await findAssets(project, {query: "camera"});
  assert.equal(assets[0].sha256, result.sha256);
  await assert.rejects(() => ingest(project, source, {kind: "../../escape"}), /kind/);
});

test("host media adapters fail closed when no local command is configured", async () => {
  assert.equal(await detectTranscriber({PATH: ""}), null);
  assert.equal(await detectSubjectAnalyzer({PATH: ""}), null);
});
