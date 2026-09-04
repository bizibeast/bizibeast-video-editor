import assert from "node:assert/strict";
import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {ingestFiles} from "../src/ingest.mjs";
import {readManifest} from "../src/manifest.mjs";
import {createProject} from "../src/project.mjs";
import {authorizeVoice, verifyVoiceAuthorization} from "../src/voice-authorization.mjs";

const coordinator = {actorId: "content-hub-coordinator", actorRole: "coordinator"};

test("records authorization against the exact ingested voice asset", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-voice-"));
  const source = join(root, "synthetic-reference.wav");
  await writeFile(source, "synthetic voice fixture");
  const {projectDir} = await createProject(root, {name: "Voice Test", editors: ["premiere"]});
  const [voice] = await ingestFiles(projectDir, [source], "voice", {voiceClone: true}, coordinator);

  const authorization = await authorizeVoice(projectDir, {
    assetId: voice.id,
    subject: "macOS synthetic system voice",
    basis: "synthetic test asset",
  }, coordinator);
  const manifest = await readManifest(projectDir);

  assert.equal(authorization.assetId, voice.id);
  assert.equal(authorization.sha256, voice.sha256);
  assert.equal(manifest.voiceAuthorizations.length, 1);
  assert.equal(await verifyVoiceAuthorization(projectDir, voice.id, voice.absolutePath), true);
});

test("refuses authorization for a non-voice asset", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-voice-"));
  const source = join(root, "image.png");
  await writeFile(source, "image fixture");
  const {projectDir} = await createProject(root, {name: "Voice Refusal", editors: ["premiere"]});
  const [image] = await ingestFiles(projectDir, [source], "image", {}, coordinator);

  await assert.rejects(
    authorizeVoice(projectDir, {assetId: image.id, subject: "none", basis: "none"}, coordinator),
    /voice asset/i,
  );
});

test("verification rejects a reference whose bytes differ from the authorized asset", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-voice-"));
  const source = join(root, "reference.wav");
  const replacement = join(root, "replacement.wav");
  await writeFile(source, "authorized bytes");
  await writeFile(replacement, "different bytes");
  const {projectDir} = await createProject(root, {name: "Voice Hash", editors: ["premiere"]});
  const [voice] = await ingestFiles(projectDir, [source], "voice", {voiceClone: true}, coordinator);
  await authorizeVoice(projectDir, {assetId: voice.id, subject: "synthetic", basis: "test"}, coordinator);

  await assert.rejects(
    verifyVoiceAuthorization(projectDir, voice.id, replacement),
    /checksum/i,
  );
});
