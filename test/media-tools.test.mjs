import assert from "node:assert/strict";
import {mkdtemp, readFile, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {findAssets} from "../scripts/find-assets.mjs";
import {ingest} from "../scripts/ingest.mjs";
import {analyzeSubject, detectSubjectAnalyzer} from "../scripts/subject-analysis.mjs";
import {detectTranscriber, transcribe} from "../scripts/transcribe.mjs";
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

test("transcription and subject adapters reject exit-zero commands without valid output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bizibeast-adapter-"));
  const input = path.join(root, "input.mov");
  await writeFile(input, "source");
  const transcript = path.join(root, "transcript.json");
  const subject = path.join(root, "subject.json");
  const transcriptEnv = {PATH: "/usr/bin:/bin", BIZIBEAST_TRANSCRIBE_COMMAND: JSON.stringify(["/usr/bin/true", "{input}", "{output}"])};
  const subjectEnv = {PATH: "/usr/bin:/bin", BIZIBEAST_SUBJECT_COMMAND: JSON.stringify(["/usr/bin/true", "{input}", "{output}"])};
  await assert.rejects(() => transcribe(input, transcript, transcriptEnv), /did not create/);
  await assert.rejects(() => analyzeSubject(input, subject, subjectEnv), /did not create/);
  await assert.rejects(() => transcribe(path.join(root, "missing.mov"), transcript, transcriptEnv), /regular file/);
});

test("adapters accept newly created valid JSON with timed words and subject boxes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bizibeast-adapter-"));
  const input = path.join(root, "input.mov");
  await writeFile(input, "source");
  const writer = path.join(root, "writer.mjs");
  await writeFile(writer, "import{writeFileSync}from'node:fs';writeFileSync(process.argv[2],process.argv[3])");
  const transcript = path.join(root, "transcript.json");
  const transcriptJson = JSON.stringify({text: "Hello", words: [{text: "Hello", start: 0, end: 0.5}]});
  const transcriptEnv = {PATH: process.env.PATH, BIZIBEAST_TRANSCRIBE_COMMAND: JSON.stringify([process.execPath, writer, "{output}", transcriptJson, "{input}"])};
  assert.equal((await transcribe(input, transcript, transcriptEnv)).words, 1);
  const subject = path.join(root, "subject.json");
  const subjectJson = JSON.stringify({frames: [{timeMs: 0, boxes: [{x: 0.1, y: 0.1, width: 0.3, height: 0.5}]}]});
  const subjectEnv = {PATH: process.env.PATH, BIZIBEAST_SUBJECT_COMMAND: JSON.stringify([process.execPath, writer, "{output}", subjectJson, "{input}"])};
  assert.equal((await analyzeSubject(input, subject, subjectEnv)).frames, 1);
});
