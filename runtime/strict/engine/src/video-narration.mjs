import {createHash, randomUUID} from "node:crypto";
import {readdir, realpath} from "node:fs/promises";
import {dirname, join, relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";

import {createArtifactEnvelope} from "./artifacts.mjs";
import {buildCaptionBundle} from "./captions.mjs";
import {readManifest} from "./manifest.mjs";
import {probeMedia} from "./media-probe.mjs";
import {confinedProjectPath} from "./paths.mjs";
import {runProcess} from "./process.mjs";
import {
  copyExclusiveFile,
  hashFileNoFollow,
  makeDirectories,
  makeExclusiveDirectory,
  readFileNoFollow,
  removeOwnedFile,
  removeOwnedStage,
  writeExclusiveFile,
} from "./release-fs.mjs";
import {requireApprovedScript} from "./video-script.mjs";
import {canonicalizeSourceTranscript} from "./video-transcripts.mjs";
import {verifyVoiceAuthorization} from "./voice-authorization.mjs";

const narrationScript = fileURLToPath(new URL("../scripts/video/narrate-approved.sh", import.meta.url));
const transcribeScript = fileURLToPath(new URL("../scripts/models/transcribe.sh", import.meta.url));
const SHA256 = /^[a-f0-9]{64}$/u;
const pad = (value) => String(value).padStart(3, "0");

function required(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

function artifactRef(value, label) {
  if (!value || typeof value !== "object" || typeof value.artifactId !== "string" || !SHA256.test(value.sha256)) {
    throw new Error(`${label} must contain an artifact id and SHA-256`);
  }
  return value;
}

function sameFile(left, right) {
  return left.sha256 === right.sha256 && left.bytes === right.bytes
    && left.owner.dev === right.owner.dev && left.owner.ino === right.owner.ino;
}

async function publishArtifact(root, path, artifact) {
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
  await makeDirectories(root, dirname(path));
  const owner = await writeExclusiveFile(root, path, bytes);
  const stored = await hashFileNoFollow(root, path);
  if (stored.sha256 !== expectedSha256 || stored.bytes !== bytes.length
    || stored.owner.dev !== owner.dev || stored.owner.ino !== owner.ino) {
    throw new Error("Narration artifact bytes changed after publication");
  }
  return {sha256: stored.sha256, owner};
}

async function projectFile(projectDir, root, value, label) {
  const source = resolve(projectDir, required(value, label));
  const absolute = await confinedProjectPath(root, relative(projectDir, source), {type: "file"});
  return {absolute, relativePath: relative(root, absolute).split("\\").join("/")};
}

async function projectOutput(projectDir, root, value) {
  const source = resolve(projectDir, required(value, "Output path"));
  const absolute = await confinedProjectPath(root, relative(projectDir, source), {allowMissing: true});
  const relativePath = relative(root, absolute).split("\\").join("/");
  if (!relativePath.endsWith(".wav")) throw new Error("Narration output must be a WAV file");
  await makeDirectories(root, dirname(relativePath));
  await confinedProjectPath(root, relativePath, {allowMissing: true});
  return {absolute, relativePath};
}

async function findSingleTranscript(root, stagePath) {
  const directory = await confinedProjectPath(root, stagePath, {type: "directory"});
  const entries = await readdir(directory, {withFileTypes: true});
  const names = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name);
  if (names.length !== 1) throw new Error("Expected exactly one generated transcript JSON");
  return readFileNoFollow(root, `${stagePath}/${names[0]}`);
}

function isPcm48kMono(media) {
  const audio = media.audio;
  return !media.video.length && audio.length === 1
    && Number(audio[0].sample_rate) === 48_000
    && Number(audio[0].channels) === 1
    && audio[0].codec_name === "pcm_s24le";
}

export async function generateApprovedNarration(projectDir, input, adapters = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Narration input is required");
  if (!Number.isInteger(input.revision) || input.revision < 1 || input.revision > 999) throw new Error("Narration revision must be 1-999");
  const run = adapters.run ?? runProcess;
  const probe = adapters.probe ?? probeMedia;
  const root = await realpath(projectDir);
  const approved = await requireApprovedScript(root, {
    workItemId: required(input.workItemId, "Work item id"),
    scriptArtifactId: required(input.scriptArtifactId, "Script artifact id"),
    scriptSha256: required(input.scriptSha256, "Script SHA-256"),
  });
  if (approved.artifact.revision !== input.revision) throw new Error("Narration revision must match approved script revision");
  const scriptArtifactRef = artifactRef(input.scriptArtifactRef, "Script artifact ref");
  if (scriptArtifactRef.artifactId !== approved.artifact.artifactId) throw new Error("Script artifact ref must match approved script");
  const storedScript = await hashFileNoFollow(root, relative(root, join(dirname(approved.absolutePath), "artifact.json")));
  if (scriptArtifactRef.sha256 !== storedScript.sha256) throw new Error("Script artifact ref does not match approved script artifact");

  const referenceAudio = await projectFile(projectDir, root, input.referenceAudioPath, "Reference audio path");
  const referenceTranscript = await projectFile(projectDir, root, input.referenceTranscriptPath, "Reference transcript path");
  if (!referenceTranscript.relativePath.startsWith("Assets/Voice/")) throw new Error("Reference transcript must be a project voice asset file");
  const referenceTranscriptHash = await hashFileNoFollow(root, referenceTranscript.relativePath);
  const manifest = await readManifest(root);
  const voiceAsset = manifest.assets.find(({id}) => id === required(input.voiceAssetId, "Voice asset id") && id.startsWith("voice-"));
  if (!voiceAsset || voiceAsset.kind !== "voice" || voiceAsset.path !== referenceAudio.relativePath) {
    throw new Error("Reference audio checksum does not match authorized voice asset provenance");
  }
  const referenceAudioHash = await hashFileNoFollow(root, referenceAudio.relativePath);
  if (referenceAudioHash.sha256 !== voiceAsset.sha256) throw new Error("Reference audio checksum does not match authorized voice asset provenance");
  await verifyVoiceAuthorization(root, input.voiceAssetId, referenceAudio.absolute);
  const voiceAuthorizationRef = artifactRef(input.voiceAuthorizationRef, "Voice authorization ref");
  if (voiceAuthorizationRef.artifactId !== input.voiceAssetId || voiceAuthorizationRef.sha256 !== referenceAudioHash.sha256) {
    throw new Error("Voice authorization ref does not match authorized reference");
  }
  const output = await projectOutput(projectDir, root, input.outputPath);

  const revision = pad(input.revision);
  const transcriptParent = "Plans/Transcripts";
  await makeDirectories(root, transcriptParent);
  const stagePath = `${transcriptParent}/.narration-v${revision}-${randomUUID()}`;
  const stageOwner = await makeExclusiveDirectory(root, stagePath);
  const stageWavPath = `${stagePath}/narration.wav`;
  const stageWavAbsolute = join(root, stageWavPath);
  const stageScriptPath = `${stagePath}/script.md`;
  const stageReferenceAudioPath = `${stagePath}/reference.wav`;
  const stageReferenceTranscriptPath = `${stagePath}/reference.txt`;
  let outputOwner;
  let audioArtifactOwner;
  let transcriptArtifactOwner;
  try {
    const stagedScriptOwner = await copyExclusiveFile(root, relative(root, approved.absolutePath), stageScriptPath);
    const stagedScript = await hashFileNoFollow(root, stageScriptPath);
    if (stagedScript.sha256 !== input.scriptSha256 || stagedScript.owner.dev !== stagedScriptOwner.dev
      || stagedScript.owner.ino !== stagedScriptOwner.ino) {
      throw new Error("Approved script changed before narration");
    }
    const stagedReferenceAudioOwner = await copyExclusiveFile(root, referenceAudio.relativePath, stageReferenceAudioPath);
    const stagedReferenceAudio = await hashFileNoFollow(root, stageReferenceAudioPath);
    if (referenceAudioHash.sha256 !== stagedReferenceAudio.sha256 || referenceAudioHash.bytes !== stagedReferenceAudio.bytes || stagedReferenceAudio.owner.dev !== stagedReferenceAudioOwner.dev
      || stagedReferenceAudio.owner.ino !== stagedReferenceAudioOwner.ino) {
      throw new Error("Authorized reference audio changed before narration");
    }
    const stagedReferenceTranscriptOwner = await copyExclusiveFile(root, referenceTranscript.relativePath, stageReferenceTranscriptPath);
    const stagedReferenceTranscript = await hashFileNoFollow(root, stageReferenceTranscriptPath);
    if (referenceTranscriptHash.sha256 !== stagedReferenceTranscript.sha256 || referenceTranscriptHash.bytes !== stagedReferenceTranscript.bytes
      || stagedReferenceTranscript.owner.dev !== stagedReferenceTranscriptOwner.dev
      || stagedReferenceTranscript.owner.ino !== stagedReferenceTranscriptOwner.ino) {
      throw new Error("Authorized reference transcript changed before narration");
    }
    const narration = await run(narrationScript, [
      root, input.voiceAssetId, join(root, stageScriptPath), join(root, stageReferenceAudioPath), join(root, stageReferenceTranscriptPath), stageWavAbsolute,
    ], {timeoutMs: 1_800_000});
    if (narration.code !== 0) throw new Error(`Qwen narration failed: ${narration.stderr.trim()}`);

    const beforeTranscription = await hashFileNoFollow(root, stageWavPath);
    const media = await probe(stageWavAbsolute);
    if (!isPcm48kMono(media)) throw new Error("Narration must contain one 48kHz mono PCM audio stream");
    const transcription = await run(transcribeScript, [stageWavAbsolute, join(root, stagePath)], {timeoutMs: 1_800_000});
    if (transcription.code !== 0) throw new Error(`Generated audio transcription failed: ${transcription.stderr.trim()}`);
    const afterTranscription = await hashFileNoFollow(root, stageWavPath);
    if (!sameFile(beforeTranscription, afterTranscription)) throw new Error("Narration WAV changed during transcription");
    const rawTranscript = await findSingleTranscript(root, stagePath);
    const transcript = canonicalizeSourceTranscript(JSON.parse(rawTranscript.bytes.toString("utf8")), {
      id: `narration:${input.workItemId}:v${revision}`, sha256: beforeTranscription.sha256, durationSeconds: media.durationSeconds,
    });
    const captionBundle = buildCaptionBundle({words: transcript.words.map((word) => ({
      text: word.text, start: word.startMs / 1000, end: word.endMs / 1000,
    }))});

    outputOwner = await copyExclusiveFile(root, stageWavPath, output.relativePath);
    const publishedAudio = await hashFileNoFollow(root, output.relativePath);
    if (publishedAudio.sha256 !== beforeTranscription.sha256 || publishedAudio.bytes !== beforeTranscription.bytes
      || publishedAudio.owner.dev !== outputOwner.dev || publishedAudio.owner.ino !== outputOwner.ino) {
      throw new Error("Published narration WAV hash mismatch");
    }
    const producer = input.producer;
    const versions = {tool: "content-hub@0.2.0", template: null, model: required(input.qwenModelRevision, "Qwen model revision"), policy: "bizibeast-v1"};
    const audioArtifact = createArtifactEnvelope({
      artifactId: `narration:${input.workItemId}:v${revision}`, revision: input.revision, workItemId: input.workItemId,
      modality: "voice-over", parents: [scriptArtifactRef, voiceAuthorizationRef], producer, versions,
      status: "frozen", deviations: [], payload: {kind: "narration-audio", path: output.relativePath, sha256: publishedAudio.sha256, media},
    });
    const audioArtifactPath = `Plans/Narration/${input.workItemId}/v${revision}/narration-audio-v${revision}.json`;
    const audioWritten = await publishArtifact(root, audioArtifactPath, audioArtifact);
    audioArtifactOwner = audioWritten.owner;
    const audioArtifactRef = {artifactId: audioArtifact.artifactId, sha256: audioWritten.sha256};
    const transcriptArtifact = createArtifactEnvelope({
      artifactId: `narration-transcript:${input.workItemId}:v${revision}`, revision: input.revision, workItemId: input.workItemId,
      modality: "voice-over", parents: [audioArtifactRef], producer,
      versions: {...versions, model: required(input.parakeetModelRevision, "Parakeet model revision")},
      status: "frozen", deviations: [], payload: {kind: "narration-transcript", transcript, captionBundle, referenceTranscriptSha256: stagedReferenceTranscript.sha256},
    });
    const transcriptArtifactPath = `Plans/Transcripts/${input.workItemId}/v${revision}/narration-v${revision}.json`;
    const transcriptWritten = await publishArtifact(root, transcriptArtifactPath, transcriptArtifact);
    transcriptArtifactOwner = transcriptWritten.owner;
    return {
      audioArtifact, audioArtifactRef, transcriptArtifact,
      transcriptArtifactRef: {artifactId: transcriptArtifact.artifactId, sha256: transcriptWritten.sha256}, captionBundle,
    };
  } catch (error) {
    if (transcriptArtifactOwner) await removeOwnedFile(root, `Plans/Transcripts/${input.workItemId}/v${revision}/narration-v${revision}.json`, transcriptArtifactOwner);
    if (audioArtifactOwner) await removeOwnedFile(root, `Plans/Narration/${input.workItemId}/v${revision}/narration-audio-v${revision}.json`, audioArtifactOwner);
    if (outputOwner) await removeOwnedFile(root, output.relativePath, outputOwner);
    throw error;
  } finally {
    await removeOwnedStage(root, stagePath, stageOwner);
  }
}
