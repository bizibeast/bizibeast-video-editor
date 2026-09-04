import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, rename, symlink, unlink, writeFile} from "node:fs/promises";
import {execFile} from "node:child_process";
import {tmpdir} from "node:os";
import {basename, dirname, join} from "node:path";
import {promisify} from "node:util";
import test from "node:test";

import {ingestFiles} from "../src/ingest.mjs";
import {createProject} from "../src/project.mjs";
import {authorizeVoice} from "../src/voice-authorization.mjs";
import {approveScriptRevision, writeScriptRevision} from "../src/video-script.mjs";
import {createWorkItem, transitionProject, transitionWorkItem} from "../src/workflow.mjs";
import {generateApprovedNarration} from "../src/video-narration.mjs";
import {canonicalizeSourceTranscript} from "../src/video-transcripts.mjs";

const execFileAsync = promisify(execFile);

const coordinator = {actorId: "content-hub-coordinator", actorRole: "coordinator"};
const wavFixture = Buffer.from("generated local wav fixture");
const rawTranscript = {
  language: "en",
  words: [
    {text: "Generated", start: 0, end: 0.55, confidence: 0.98},
    {text: "audio.", start: 0.55, end: 1.2, confidence: 0.97},
  ],
};

async function fixture({approved = true, authorizedVoice = true, createReference} = {}) {
  const root = await mkdtemp(join(tmpdir(), "content-hub-video-narration-"));
  const {projectDir} = await createProject(root, {name: "Narration", editors: ["premiere"]});
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief approved"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "inputs ready"});
  await createWorkItem(projectDir, coordinator, {id: "launch-reel", title: "Launch reel", modality: "voice-over"});
  await transitionWorkItem(projectDir, coordinator, {workItemId: "launch-reel", to: "SCRIPT_DRAFT", reason: "drafting"});
  const script = await writeScriptRevision(projectDir, {
    workItemId: "launch-reel", revision: 1, text: "The generated recording is the source of caption timing.\n",
    producer: {actorId: "script-01", role: "script-editorial"},
  });
  await transitionWorkItem(projectDir, coordinator, {workItemId: "launch-reel", to: "AWAITING_SCRIPT_APPROVAL", reason: "ready"});
  if (approved) {
    await approveScriptRevision(projectDir, coordinator, {
      workItemId: "launch-reel", artifact: script.artifact, expectedSha256: script.scriptSha256,
      approver: {actorId: "human:yash", role: "human"},
    });
    await transitionWorkItem(projectDir, coordinator, {
      workItemId: "launch-reel", to: "SCRIPT_APPROVED", reason: "approved",
      artifactRef: {id: script.artifact.artifactId, sha256: script.artifactRef.sha256},
    });
  }
  const referenceSource = join(root, "reference.wav");
  const referenceTranscriptPath = join(projectDir, "Assets", "Voice", "reference.txt");
  if (createReference) await createReference(referenceSource);
  else await writeFile(referenceSource, "authorized synthetic reference");
  await writeFile(referenceTranscriptPath, "Synthetic reference transcript.");
  const [voice] = await ingestFiles(projectDir, [referenceSource], "voice", {voiceClone: true}, coordinator);
  if (authorizedVoice) {
    await authorizeVoice(projectDir, {assetId: voice.id, subject: "synthetic", basis: "test fixture"}, coordinator);
  }
  return {
    projectDir,
    script,
    voice,
    input: {
      workItemId: "launch-reel",
      revision: 1,
      scriptArtifactId: script.artifact.artifactId,
      scriptSha256: script.scriptSha256,
      scriptArtifactRef: script.artifactRef,
      voiceAssetId: voice.id,
      voiceAuthorizationRef: {artifactId: voice.id, sha256: voice.sha256},
      referenceAudioPath: voice.absolutePath,
      referenceTranscriptPath,
      outputPath: join(projectDir, "Renders", "Narration", "narration-v001.wav"),
      producer: {actorId: "qwen-local", role: "voice-generator"},
      qwenModelRevision: "qwen-local-test",
      parakeetModelRevision: "parakeet-local-test",
    },
  };
}

function runner(calls, {media = {audio: [{sample_rate: "48000", channels: 1, codec_name: "pcm_s24le"}], video: [], durationSeconds: 1.2}, transcript = rawTranscript, outcome, afterRun} = {}) {
  return {
    run: async (command, args) => {
      calls.push([command, args]);
      if (command.endsWith("narrate-approved.sh")) await writeFile(args.at(-1), wavFixture, {flag: "wx"});
      if (command.endsWith("transcribe.sh") && transcript) await writeFile(join(args[1], "narration.json"), JSON.stringify(transcript));
      await afterRun?.(command, args);
      return outcome?.(command, args) ?? {code: 0, stdout: "", stderr: ""};
    },
    probe: async () => media,
  };
}

test("narrates only an approved script and retranscribes the generated WAV", async () => {
  const {projectDir, input} = await fixture();
  const calls = [];
  const result = await generateApprovedNarration(projectDir, input, runner(calls));

  assert.deepEqual(calls.map(([command]) => basename(command)), ["narrate-approved.sh", "transcribe.sh"]);
  assert.equal(result.transcriptArtifact.parents[0].sha256, result.audioArtifactRef.sha256);
  assert.equal(result.captionBundle.durationSeconds, 1.2);
  assert.deepEqual(result.transcriptArtifact.payload.transcript.words.map(({text}) => text), ["Generated", "audio."]);
  assert.match(await readFile(join(projectDir, "Plans", "Transcripts", "launch-reel", "v001", "narration-v001.json"), "utf8"), /source-relative-ms/u);
});

test("copies authorized reference inputs into the owned narration staging directory", async () => {
  const {projectDir, input} = await fixture();
  const calls = [];
  await generateApprovedNarration(projectDir, input, runner(calls));
  const [, args] = calls[0];
  assert.match(args[2], /Plans\/Transcripts\/.narration-v001-.*\/script\.md/u);
  assert.notEqual(args[3], input.referenceAudioPath);
  assert.notEqual(args[4], input.referenceTranscriptPath);
  assert.match(args[3], /Plans\/Transcripts\/.narration-v001-/u);
});

test("fails before narration when the exact script approval is missing", async () => {
  const {projectDir, input} = await fixture({approved: false});
  const calls = [];
  await assert.rejects(generateApprovedNarration(projectDir, input, runner(calls)), /SCRIPT_APPROVED|state/u);
  assert.deepEqual(calls, []);
});

test("fails before narration when the voice reference checksum differs", async () => {
  const {projectDir, input} = await fixture();
  const calls = [];
  const replacement = join(projectDir, "replacement.wav");
  await writeFile(replacement, "not the authorized reference");
  await assert.rejects(generateApprovedNarration(projectDir, {...input, referenceAudioPath: replacement}, runner(calls)), /checksum/u);
  assert.deepEqual(calls, []);
});

test("fails closed before transcription unless generated audio is 48kHz mono PCM", async () => {
  const {projectDir, input} = await fixture();
  const calls = [];
  await assert.rejects(
    generateApprovedNarration(projectDir, input, runner(calls, {media: {audio: [{sample_rate: "44100", channels: 2, codec_name: "pcm_s16le"}], video: [], durationSeconds: 1.2}})),
    /48kHz mono PCM/u,
  );
  assert.deepEqual(calls.map(([command]) => basename(command)), ["narrate-approved.sh"]);
  await assert.rejects(readFile(input.outputPath), {code: "ENOENT"});
});

test("fails closed when generated audio has no post-transcription JSON", async () => {
  const {projectDir, input} = await fixture();
  const calls = [];
  await assert.rejects(generateApprovedNarration(projectDir, input, runner(calls, {transcript: null})), /generated transcript JSON/u);
  assert.deepEqual(calls.map(([command]) => basename(command)), ["narrate-approved.sh", "transcribe.sh"]);
});

test("canonical transcripts use only generated-audio word timings", () => {
  const source = {id: "narration:launch-reel:v001", sha256: "a".repeat(64), durationSeconds: 1.2};
  const transcript = canonicalizeSourceTranscript(rawTranscript, source);
  assert.deepEqual(transcript.words.map(({id, startMs, endMs}) => ({id, startMs, endMs})), [
    {id: "narration:launch-reel:v001:w000001", startMs: 0, endMs: 550},
    {id: "narration:launch-reel:v001:w000002", startMs: 550, endMs: 1200},
  ]);
  assert.equal(transcript.timeBase, "source-relative-ms");
  assert.throws(() => canonicalizeSourceTranscript({words: [{text: "draft", start: 0, end: 0}]}, source), /valid timed words/u);
  assert.throws(() => canonicalizeSourceTranscript({words: [{text: "late", start: 0, end: 1.251}]}, source), /duration/u);
  assert.throws(() => canonicalizeSourceTranscript({words: [
    {text: "first", start: 0, end: 0.7}, {text: "backward", start: 0.6, end: 0.9},
  ]}, source), /ordered|overlap/u);
});

test("fails closed and removes owned staging when Qwen returns an error after writing audio", async () => {
  const {projectDir, input} = await fixture();
  const calls = [];
  await assert.rejects(generateApprovedNarration(projectDir, input, runner(calls, {
    outcome: (command) => command.endsWith("narrate-approved.sh") ? {code: 2, stdout: "", stderr: "model failed"} : undefined,
  })), /Qwen narration failed/u);
  await assert.rejects(readFile(input.outputPath), {code: "ENOENT"});
});

test("rejects multiple generated transcript JSON files before publishing output", async () => {
  const {projectDir, input} = await fixture();
  const calls = [];
  await assert.rejects(generateApprovedNarration(projectDir, input, runner(calls, {
    afterRun: async (command, args) => {
      if (command.endsWith("transcribe.sh")) await writeFile(join(args[1], "second.json"), JSON.stringify(rawTranscript));
    },
  })), /exactly one generated transcript JSON/u);
  await assert.rejects(readFile(input.outputPath), {code: "ENOENT"});
});

test("rejects symlinked output parents and reference inputs before running local models", async () => {
  const {projectDir, input, voice} = await fixture();
  const calls = [];
  const outside = await mkdtemp(join(tmpdir(), "content-hub-video-narration-outside-"));
  await rename(join(projectDir, "Renders"), join(projectDir, "Renders-real"));
  await symlink(outside, join(projectDir, "Renders"));
  await assert.rejects(generateApprovedNarration(projectDir, input, runner(calls)), /symlink|project path/u);
  assert.deepEqual(calls, []);
  await unlink(join(projectDir, "Renders"));
  await rename(join(projectDir, "Renders-real"), join(projectDir, "Renders"));

  await rename(voice.absolutePath, `${voice.absolutePath}.real`);
  await symlink(`${voice.absolutePath}.real`, voice.absolutePath);
  await assert.rejects(generateApprovedNarration(projectDir, input, runner(calls)), /symlink|reference/u);
  assert.deepEqual(calls, []);
});

test("rejects a symlinked reference transcript before running local models", async () => {
  const {projectDir, input} = await fixture();
  const outside = join(projectDir, "outside-reference.txt");
  await writeFile(outside, "outside");
  await unlink(input.referenceTranscriptPath);
  await symlink(outside, input.referenceTranscriptPath);
  const calls = [];
  await assert.rejects(generateApprovedNarration(projectDir, input, runner(calls)), /symlink|reference transcript/u);
  assert.deepEqual(calls, []);
});

test("detects a staged WAV replacement after transcription and publishes nothing", async () => {
  const {projectDir, input} = await fixture();
  const calls = [];
  await assert.rejects(generateApprovedNarration(projectDir, input, runner(calls, {
    afterRun: async (command, args) => {
      if (!command.endsWith("transcribe.sh")) return;
      await rename(args[0], `${args[0]}.original`);
      await writeFile(args[0], "replacement", {flag: "wx"});
    },
  })), /changed during transcription/u);
  await assert.rejects(readFile(input.outputPath), {code: "ENOENT"});
});

test("second artifact collision cleans owned first publication and output without touching the target", async () => {
  const {projectDir, input} = await fixture();
  const transcriptPath = join(projectDir, "Plans", "Transcripts", "launch-reel", "v001", "narration-v001.json");
  await mkdir(dirname(transcriptPath), {recursive: true});
  await writeFile(transcriptPath, "pre-existing transcript target", {flag: "wx"});
  await assert.rejects(generateApprovedNarration(projectDir, input, runner([])), /exist|exclusive|create/u);
  assert.equal(await readFile(transcriptPath, "utf8"), "pre-existing transcript target");
  await assert.rejects(readFile(input.outputPath), {code: "ENOENT"});
  await assert.rejects(readFile(join(projectDir, "Plans", "Narration", "launch-reel", "v001", "narration-audio-v001.json")), {code: "ENOENT"});
  await unlink(transcriptPath);
  const retried = await generateApprovedNarration(projectDir, input, runner([]));
  assert.match(retried.audioArtifact.payload.sha256, /^[a-f0-9]{64}$/u);
});

test("optional local model smoke retranscribes a generated authorized narration", {
  skip: process.env.CONTENT_HUB_MODEL_SMOKE === "1" ? false : "set CONTENT_HUB_MODEL_SMOKE=1 after installing local model weights",
  timeout: 1_800_000,
}, async () => {
  const {projectDir, input} = await fixture({
    createReference: async (path) => execFileAsync("/usr/bin/say", [
      "--file-format=WAVE", "--data-format=LEI16@48000", "-o", path,
      "This is an authorized local synthetic voice reference.",
    ]),
  });
  const result = await generateApprovedNarration(projectDir, input);
  assert.equal(result.audioArtifact.payload.media.audio[0].sample_rate, "48000");
  assert.ok(result.transcriptArtifact.payload.transcript.words.length > 0);
});
