import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdir, mkdtemp, readFile, unlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import test from "node:test";

import {recordApproval} from "../src/approvals.mjs";
import {createArtifactEnvelope, writeImmutableArtifact} from "../src/artifacts.mjs";
import {freezeCandidateBundle} from "../src/candidates.mjs";
import {resolveTechnicalProfile} from "../src/qc-profiles.mjs";
import {runCandidateTechnicalQc} from "../src/qc.mjs";
import {createProject} from "../src/project.mjs";

const coordinator = {actorId: "content-hub-coordinator", actorRole: "coordinator"};
const hash = (character) => character.repeat(64);
const versions = {tool: "fixture", template: "fixture", model: "none", policy: "bizibeast-v1"};

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ["ignore", "pipe", "pipe"]});
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed: ${stderr}`)));
  });
}

async function storeArtifact(projectDir, path, input) {
  const artifact = createArtifactEnvelope({...input, versions, status: "frozen"});
  const stored = await writeImmutableArtifact(projectDir, path, artifact);
  return {artifact, ref: {artifactId: artifact.artifactId, sha256: stored.sha256}, path: join(projectDir, stored.path)};
}

async function makeCandidate({audio = true, profileHash, timeline = true, dimensions = "1080x1920", asset = false, profileId = "vertical-short-v1", profileContext, rate = "30", durationSeconds = 1, modality = "raw-video", subjectSourceSha256, includeMediaIndex = true} = {}) {
  const root = await mkdtemp(join(tmpdir(), "content-hub-candidate-qc-"));
  const {projectDir} = await createProject(root, {name: "Candidate QC", editors: ["premiere"]});
  const sourceId = modality === "voice-over" ? "narration-001" : "source-001";
  const wordIds = [`${sourceId}:w000001`, `${sourceId}:w000002`];
  const script = await storeArtifact(projectDir, "Plans/script-v001.json", {
    artifactId: "script-001", revision: 1, workItemId: "raw-001", modality, parents: [],
    producer: {actorId: "script-1", role: "script-editorial"},
    payload: {kind: "script", words: [{id: wordIds[0], text: "Open"}, {id: wordIds[1], text: "strong"}]},
  });
  const story = await storeArtifact(projectDir, "Plans/story-plan-v001.json", {
    artifactId: "story-001", revision: 1, workItemId: "raw-001", modality, parents: [script.ref],
    producer: {actorId: "story-1", role: "story-editor"},
    payload: {kind: "story-plan", segments: [{sourceId, sourceInMs: 0, sourceOutMs: 1000, firstWordId: wordIds[0], lastWordId: wordIds[1]}]},
  });
  const approval = await recordApproval(projectDir, coordinator, {
    kind: "script", workItemId: "raw-001", subject: {artifactId: script.artifact.artifactId, sha256: script.ref.sha256},
    decision: "approved", approver: {actorId: "human-yash", role: "human"}, origin: "user", policyVersion: "bizibeast-v1",
  });
  const sourceSha256 = hash("a");
  const mediaIndex = await storeArtifact(projectDir, "Plans/media-index-v001.json", {
    artifactId: "media-index-001", revision: 1, workItemId: "raw-001", modality, parents: [],
    producer: {actorId: "media-1", role: "media-indexer"},
    payload: {kind: "media-index", sources: [{id: sourceId, sha256: sourceSha256, video: [{width: 1080, height: 1920}]}]},
  });
  const pacing = await storeArtifact(projectDir, "Plans/pacing-v001.json", {
    artifactId: "pacing-001", revision: 1, workItemId: "raw-001", modality, parents: [script.ref, story.ref],
    producer: {actorId: "story-1", role: "story-editor"},
    payload: {kind: "short-form-pacing", words: [{id: wordIds[0], startMs: 0, endMs: 400}, {id: wordIds[1], startMs: 450, endMs: 900}], vadSegments: [{startMs: 0, endMs: 1000}], edits: [], intentionalPauses: [], hookAtMs: 250},
  });
  const captions = await storeArtifact(projectDir, "Plans/caption-placement-v001.json", {
    artifactId: "captions-001", revision: 1, workItemId: "raw-001", modality, parents: [story.ref],
    producer: {actorId: "subject-1", role: "subject-analyst"},
    payload: {kind: "caption-placement", frame: {width: 1080, height: 1920}, captions: [{id: "caption-001", shotId: "shot-001", anchorId: "top-center", box: {x: 380, y: 300, width: 320, height: 160}}]},
  });
  const subjectMap = await storeArtifact(projectDir, "Plans/subject-map-v001.json", {
    artifactId: "subject-map-001", revision: 1, workItemId: "raw-001", modality, parents: [story.ref],
    producer: {actorId: "subject-1", role: "subject-analyst"},
    payload: {kind: "subject-map", sourceId, sourceSha256: subjectSourceSha256 ?? sourceSha256, coordinateSpace: "top-left-pixels", frameSize: {width: 1080, height: 1920}, samples: [{shotId: "shot-001", timeMs: 0, confidence: 0.95}]},
  });
  const blueprint = await storeArtifact(projectDir, "Plans/design-plan-v001.json", {
    artifactId: "blueprint-001", revision: 1, workItemId: "raw-001", modality, parents: [story.ref, subjectMap.ref],
    producer: {actorId: "design-1", role: "design-director"},
    payload: {kind: "video-design-plan", shots: [{id: "shot-001", startMs: 0, endMs: 1000}], blueprintRequirements: {tracking: "optional", matte: "optional", trackingDeviation: "fixed-safe-anchor"}},
  });
  const shortFormRefs = [...(includeMediaIndex ? [mediaIndex.ref] : []), pacing.ref, captions.ref, subjectMap.ref, blueprint.ref];
  const profile = resolveTechnicalProfile(profileId, profileContext);
  const candidateDir = join(projectDir, "Renders", "Candidates", "raw-001", "v001");
  const output = join(candidateDir, "master.mp4");
  await mkdir(candidateDir, {recursive: true});
  const args = ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=${dimensions}:rate=${rate}`];
  if (audio) args.push("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000");
  args.push("-t", "1", "-vf", "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+write_colr");
  if (audio) args.push("-af", "volume=2.5", "-c:a", "aac", "-shortest");
  args.push("-y", output);
  await run("ffmpeg", args);
  const bundle = await freezeCandidateBundle(projectDir, coordinator, {
    workItemId: "raw-001", modality, revision: 1,
    outputs: [{path: "Renders/Candidates/raw-001/v001/master.mp4", kind: "master", order: 1}],
    inputLock: {artifacts: [script.ref, story.ref, ...shortFormRefs].map(({artifactId: id, sha256}) => ({id, sha256})), approvals: [{id: approval.id, subjectSha256: script.ref.sha256}], assets: asset ? [{id: "asset-001", sha256: hash("b")}] : []},
    lineage: {sourceIds: [sourceId], assetIds: []},
    settings: {profileId: profile.id, profileHash: profileHash ?? profile.profileHash, codec: "h264", durationSeconds},
    producer: {actorId: "premiere-1", role: "premiere-executor"},
    versions, requestedDerivatives: ["mp4"],
  });
  const candidateRef = {artifactId: "candidate:raw-001:v001", sha256: bundle.bundleHash};
  const transcript = await storeArtifact(projectDir, "Plans/final-transcript-v001.json", {
    artifactId: "final-transcript-001", revision: 1, workItemId: "raw-001", modality, parents: [script.ref, story.ref, ...shortFormRefs, candidateRef],
    producer: {actorId: "story-1", role: "story-editor"},
    payload: {kind: "final-transcript", candidateBundleHash: bundle.bundleHash, words: [
      {id: wordIds[0], sourceId, startMs: 0, endMs: 400},
      {id: wordIds[1], sourceId, startMs: 450, endMs: 900},
    ], selectedSourceRanges: [{sourceId, startMs: 0, endMs: 1000}]},
  });
  let timelineEvidencePath;
  if (timeline) {
    const timelineArtifact = await storeArtifact(projectDir, "Plans/premiere-readback-v001.json", {
      artifactId: "premiere-readback-001", revision: 1, workItemId: "raw-001", modality, parents: [script.ref, story.ref, ...shortFormRefs, candidateRef],
      producer: bundle.producer,
      payload: {kind: "premiere-readback", candidateBundleHash: bundle.bundleHash, nativeCaptionTrack: {retained: true}, dependencies: [], warnings: [], gaps: [], networkDenied: true},
    });
    timelineEvidencePath = timelineArtifact.path;
  }
  return {
    projectDir, bundle, output, transcriptEvidencePath: transcript.path, timelineEvidencePath,
    parentHashes: new Map([[script.ref.artifactId, script.ref.sha256], [story.ref.artifactId, story.ref.sha256], ...shortFormRefs.map(({artifactId, sha256}) => [artifactId, sha256]), ...(asset ? [["asset-001", hash("b")]] : [])]), approvals: [approval], script, story, transcript, profileContext,
  };
}

function input(fixture, overrides = {}) {
  return {
    validator: {actorId: "tech-qc-1", role: "technical-qc-validator"},
    parentHashes: fixture.parentHashes, approvals: fixture.approvals,
    profileContext: fixture.profileContext, transcriptEvidencePath: fixture.transcriptEvidencePath, timelineEvidencePath: fixture.timelineEvidencePath,
    ...overrides,
  };
}

test("technical QC passes a matching frozen vertical candidate", async () => {
  const fixture = await makeCandidate();
  const manifestBefore = await readFile(join(fixture.projectDir, "project.yaml"), "utf8");

  const evidence = await runCandidateTechnicalQc(fixture.projectDir, fixture.bundle.bundlePath, input(fixture));

  assert.equal(evidence.payload.candidateBundleHash, fixture.bundle.bundleHash);
  assert.equal(evidence.payload.profileHash, fixture.bundle.settings.profileHash);
  assert.equal(evidence.payload.pass, true);
  assert.ok(evidence.payload.checks.every(({findingSignature}) => /^[a-f0-9]{64}$/u.test(findingSignature)));
  assert.deepEqual(JSON.parse(await readFile(join(fixture.projectDir, evidence.payload.reportFiles.json), "utf8")), evidence);
  assert.match(await readFile(join(fixture.projectDir, evidence.payload.reportFiles.markdown), "utf8"), /Technical QC PASS/);
  assert.equal(await readFile(join(fixture.projectDir, "project.yaml"), "utf8"), manifestBefore);
});

test("technical QC binds subject-map source facts to the locked media index", async () => {
  const fixture = await makeCandidate({subjectSourceSha256: hash("f")});

  const evidence = await runCandidateTechnicalQc(fixture.projectDir, fixture.bundle.bundlePath, input(fixture));

  assert.equal(evidence.payload.checks.find(({id}) => id === "subject.source-hash").pass, false);
});

test("technical QC fails closed when the locked subject source index is absent", async () => {
  const fixture = await makeCandidate({includeMediaIndex: false});

  const evidence = await runCandidateTechnicalQc(fixture.projectDir, fixture.bundle.bundlePath, input(fixture));

  assert.equal(evidence.payload.checks.find(({id}) => id === "bundle.short-form-artifacts").pass, false);
});

test("the producing executor cannot validate its own bundle", async () => {
  const fixture = await makeCandidate();
  await assert.rejects(runCandidateTechnicalQc(fixture.projectDir, fixture.bundle.bundlePath, input(fixture, {
    validator: {actorId: fixture.bundle.producer.actorId, role: "technical-qc-validator"},
  })), /cannot review its own work/i);
});

test("a profile hash mismatch fails before media inspection", async () => {
  const fixture = await makeCandidate({profileHash: hash("f")});
  const evidence = await runCandidateTechnicalQc(fixture.projectDir, fixture.bundle.bundlePath, input(fixture));
  assert.equal(evidence.payload.checks.find(({id}) => id === "bundle.profile").pass, false);
});

test("technical QC records wrong dimensions and missing audio as hard failures", async () => {
  const dimensions = await makeCandidate({dimensions: "320x180"});
  const noAudio = await makeCandidate({audio: false});

  const dimensionEvidence = await runCandidateTechnicalQc(dimensions.projectDir, dimensions.bundle.bundlePath, input(dimensions));
  const audioEvidence = await runCandidateTechnicalQc(noAudio.projectDir, noAudio.bundle.bundlePath, input(noAudio));

  assert.equal(dimensionEvidence.payload.pass, false);
  assert.ok(dimensionEvidence.payload.checks.some(({id, pass, severity}) => id === "video.dimensions" && !pass && severity === "hard"));
  assert.equal(audioEvidence.payload.pass, false);
  assert.ok(audioEvidence.payload.checks.some(({id, pass}) => id === "audio.present" && !pass));
});

test("technical QC rejects changed bundle bytes before producing evidence", async () => {
  const fixture = await makeCandidate();
  await writeFile(fixture.output, "changed candidate bytes");
  await assert.rejects(runCandidateTechnicalQc(fixture.projectDir, fixture.bundle.bundlePath, input(fixture)), /file (size|hash) mismatch/i);
});

test("technical QC fails closed when the Premiere caption receipt is missing", async () => {
  const fixture = await makeCandidate({timeline: false});
  const evidence = await runCandidateTechnicalQc(fixture.projectDir, fixture.bundle.bundlePath, input(fixture));
  assert.equal(evidence.payload.pass, false);
  assert.ok(evidence.payload.checks.some(({id, pass}) => id === "timeline.native-caption-track" && !pass));
});

test("technical QC rejects timeline sidecar gaps", async () => {
  const fixture = await makeCandidate();
  await writeFile(fixture.timelineEvidencePath, JSON.stringify({
    nativeCaptionTrack: {retained: true}, dependencies: [], warnings: [], networkDenied: true,
    gaps: [{startMs: 400, endMs: 520}],
  }));

  const evidence = await runCandidateTechnicalQc(fixture.projectDir, fixture.bundle.bundlePath, input(fixture));

  assert.equal(evidence.payload.pass, false);
  assert.ok(evidence.payload.checks.some(({id, pass}) => id === "timeline.sidecar-gaps" && !pass));
});

test("technical QC binds transcript words and source spans to locked script and story artifacts", async () => {
  const fixture = await makeCandidate();
  const transcript = JSON.parse(await readFile(fixture.transcriptEvidencePath, "utf8"));
  transcript.payload.words[1] = {...transcript.payload.words[1], sourceId: undefined, endMs: 1100};
  await writeFile(fixture.transcriptEvidencePath, JSON.stringify(transcript));

  const evidence = await runCandidateTechnicalQc(fixture.projectDir, fixture.bundle.bundlePath, input(fixture));
  const content = evidence.payload.checks.find(({id}) => id === "content.approved-words");

  assert.equal(content.pass, false);
  assert.match(content.evidence[0].locator, /source-001:w000002@/u);
});

test("technical QC rejects arbitrary timeline JSON instead of treating it as a receipt", async () => {
  const fixture = await makeCandidate();
  await writeFile(fixture.timelineEvidencePath, JSON.stringify({nativeCaptionTrack: {retained: true}, dependencies: [], warnings: [], gaps: [], networkDenied: true}));

  const evidence = await runCandidateTechnicalQc(fixture.projectDir, fixture.bundle.bundlePath, input(fixture));

  assert.equal(evidence.payload.checks.find(({id}) => id === "timeline.receipt").pass, false);
});

test("technical QC rejects a transcript receipt bound to another candidate", async () => {
  const fixture = await makeCandidate();
  const transcript = JSON.parse(await readFile(fixture.transcriptEvidencePath, "utf8"));
  transcript.payload.candidateBundleHash = hash("f");
  await writeFile(fixture.transcriptEvidencePath, JSON.stringify(transcript));

  const evidence = await runCandidateTechnicalQc(fixture.projectDir, fixture.bundle.bundlePath, input(fixture));

  assert.equal(evidence.payload.checks.find(({id}) => id === "transcript.receipt").pass, false);
});

test("technical QC binds voice-over narration words to its locked story plan", async () => {
  const fixture = await makeCandidate({modality: "voice-over"});

  const passing = await runCandidateTechnicalQc(fixture.projectDir, fixture.bundle.bundlePath, input(fixture));
  assert.equal(passing.payload.pass, true);

  const failingFixture = await makeCandidate({modality: "voice-over"});
  const transcript = JSON.parse(await readFile(failingFixture.transcriptEvidencePath, "utf8"));
  transcript.payload.words[1] = {...transcript.payload.words[1], sourceId: "unbound-source", endMs: 1100};
  await writeFile(failingFixture.transcriptEvidencePath, JSON.stringify(transcript));
  const failing = await runCandidateTechnicalQc(failingFixture.projectDir, failingFixture.bundle.bundlePath, input(failingFixture));
  const content = failing.payload.checks.find(({id}) => id === "content.approved-words");

  assert.equal(content.pass, false);
  assert.match(content.evidence[0].locator, /narration-001:w000002@/u);
});

test("technical QC uses one frame of rational FPS as duration tolerance", async () => {
  const profileContext = {width: 1080, height: 1920, fps: "30000/1001", container: "mp4"};
  const fixture = await makeCandidate({profileId: "project-video-v1", profileContext, rate: "30000/1001", durationSeconds: 1.03});

  const evidence = await runCandidateTechnicalQc(fixture.projectDir, fixture.bundle.bundlePath, input(fixture));

  assert.equal(evidence.payload.pass, true);
  assert.equal(evidence.payload.checks.find(({id}) => id === "video.duration").pass, true);
});

test("project-video QC requires the frozen exact container", async () => {
  const fixture = await makeCandidate({
    profileId: "project-video-v1",
    profileContext: {width: 1080, height: 1920, fps: 30, container: "mov"},
  });

  const evidence = await runCandidateTechnicalQc(fixture.projectDir, fixture.bundle.bundlePath, input(fixture));

  assert.equal(evidence.payload.checks.find(({id}) => id === "video.container").pass, false);
});

test("technical QC ignores a forged approval array when the project log is empty", async () => {
  const fixture = await makeCandidate();
  await writeFile(join(fixture.projectDir, "Plans/approvals.jsonl"), "");

  const evidence = await runCandidateTechnicalQc(fixture.projectDir, fixture.bundle.bundlePath, input(fixture));

  assert.equal(evidence.payload.checks.find(({id}) => id === "bundle.required-approval").pass, false);
});

test("technical QC rejects a stale supplied approval after a current rejection", async () => {
  const fixture = await makeCandidate();
  await recordApproval(fixture.projectDir, coordinator, {
    kind: "script", workItemId: "raw-001", subject: {artifactId: fixture.script.artifact.artifactId, sha256: fixture.script.ref.sha256},
    decision: "rejected", approver: {actorId: "human-yash", role: "human"}, origin: "user", policyVersion: versions.policy,
  });

  const evidence = await runCandidateTechnicalQc(fixture.projectDir, fixture.bundle.bundlePath, input(fixture));

  assert.equal(evidence.payload.checks.find(({id}) => id === "bundle.required-approval").pass, false);
});

test("technical QC ignores caller parent maps when project artifacts are current", async () => {
  const fixture = await makeCandidate();

  const evidence = await runCandidateTechnicalQc(fixture.projectDir, fixture.bundle.bundlePath, input(fixture, {parentHashes: new Map()}));

  assert.equal(evidence.payload.pass, true);
});

test("technical QC rejects a locked asset absent from project ledgers", async () => {
  const fixture = await makeCandidate({asset: true});

  const evidence = await runCandidateTechnicalQc(fixture.projectDir, fixture.bundle.bundlePath, input(fixture));

  assert.equal(evidence.payload.checks.find(({id}) => id === "bundle.local-dependencies").pass, false);
});

test("technical QC rejects partial color metadata", async () => {
  const fixture = await makeCandidate();
  const probe = async () => ({durationSeconds: 1, formatName: "mov,mp4", video: [{width: 1080, height: 1920, r_frame_rate: "30/1", codec_name: "h264", color_space: "bt709"}], audio: [{sample_rate: "48000", channels: 1}]});
  const run = async (_command, args) => ({code: 0, stdout: "", stderr: args.includes("loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json") ? '{"input_i":"-14","input_tp":"-2","input_lra":"1"}' : ""});

  const evidence = await runCandidateTechnicalQc(fixture.projectDir, fixture.bundle.bundlePath, input(fixture, {probe, run}));

  assert.equal(evidence.payload.checks.find(({id}) => id === "video.color-metadata").pass, false);
});

test("technical QC writes failed evidence when a locked artifact is unavailable", async () => {
  const fixture = await makeCandidate();
  await unlink(fixture.story.path);
  let processes = 0;
  const run = async () => { processes += 1; throw new Error("media process must not run"); };
  const probe = async () => { processes += 1; throw new Error("media probe must not run"); };

  const evidence = await runCandidateTechnicalQc(fixture.projectDir, fixture.bundle.bundlePath, input(fixture, {run, probe}));

  assert.equal(processes, 0);
  assert.equal(evidence.payload.checks.find(({id}) => id === "bundle.artifact-parents").pass, false);
});

for (const [name, setup] of [
  ["profile mismatch", async (fixture, run) => input(fixture, {run, profileContext: {width: 1, height: 1, fps: 30, container: "mp4"}})],
  ["changed local dependency", async (fixture, run) => input(fixture, {run, parentHashes: new Map([[fixture.script.ref.artifactId, fixture.script.ref.sha256], [fixture.story.ref.artifactId, fixture.story.ref.sha256], ["asset-001", hash("c")]])})],
]) {
  test(`technical QC does not launch media processes after ${name}`, async () => {
    const fixture = await makeCandidate(name === "profile mismatch"
      ? {profileId: "project-video-v1", profileContext: {width: 1080, height: 1920, fps: 30, container: "mp4"}}
      : {asset: name === "changed local dependency"});
    let processes = 0;
    const run = async () => { processes += 1; throw new Error("media process must not run"); };
    const probe = async () => { processes += 1; throw new Error("media probe must not run"); };
    const request = await setup(fixture, run);
    request.probe = probe;

    const evidence = await runCandidateTechnicalQc(fixture.projectDir, fixture.bundle.bundlePath, request);

    assert.equal(processes, 0);
    assert.equal(evidence.payload.pass, false);
    assert.equal(evidence.payload.checks.some(({severity, pass}) => severity === "hard" && !pass), true);
  });
}
