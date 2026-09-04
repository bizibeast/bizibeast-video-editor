import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, mkdir, readFile, readdir, rename, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import test from "node:test";

import {createArtifactEnvelope} from "../src/artifacts.mjs";
import {writeArtifactCaptionBundle} from "../src/captions.mjs";
import {createProject} from "../src/project.mjs";
import {hashFileNoFollow, readFileNoFollow} from "../src/release-fs.mjs";
import {createWorkItem, transitionProject, transitionWorkItem} from "../src/workflow.mjs";

const coordinator = {actorId: "content-hub-coordinator", actorRole: "coordinator"};
const versions = {tool: "content-hub@0.2.0", template: "hyperframes@0.8.25", model: null, policy: "bizibeast-v1"};
const producer = {actorId: "caption-1", role: "caption-executor"};
const technician = {actorId: "media-1", role: "local-media-technician"};
const storyEditor = {actorId: "story-1", role: "story-editor"};
const analyst = {actorId: "subject-1", role: "subject-analyst"};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pad = (value) => String(value).padStart(3, "0");

async function storeArtifact(projectDir, path, input) {
  const artifact = createArtifactEnvelope(input);
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  await mkdir(dirname(join(projectDir, path)), {recursive: true});
  await writeFile(join(projectDir, path), bytes, {flag: "wx"});
  return {artifact, artifactRef: {artifactId: artifact.artifactId, sha256: sha256(bytes)}};
}

function words(sourceId) {
  return sourceId === "source-a" ? [
    {id: `${sourceId}:w000001`, text: "Alpha", startMs: 700, endMs: 900, confidence: 0.99},
    {id: `${sourceId}:w000002`, text: "returns.", startMs: 1500, endMs: 1700, confidence: 0.99},
  ] : [
    {id: `${sourceId}:w000001`, text: "Beta", startMs: 1100, endMs: 1300, confidence: 0.99},
    {id: `${sourceId}:w000002`, text: "opens.", startMs: 1800, endMs: 2000, confidence: 0.99},
  ];
}

function subjectPayload(sourceId, sourceSha256, {required = true, empty = false} = {}) {
  const low = sourceId === "source-b";
  const box = low
    ? {x: 90, y: 100, width: 900, height: 1000}
    : {x: 90, y: 700, width: 900, height: 800};
  const times = sourceId === "source-b" ? [1100, 1900] : [800, 1600];
  const frames = empty ? [] : times.map((timeMs, index) => ({
    index, timeMs, faces: [{box, confidence: 0.99}], faceAnalysisAvailable: true, faceAnalysisError: null,
    subjectBox: box, subjectConfidence: 0.99, personAnalysisAvailable: true, personAnalysisError: null,
    segmentationAttempted: required, segmentationAvailable: required, segmentationError: null,
    confidence: 0.99, discontinuity: false, jitterPx: 0,
    avoidRegions: [{kind: "subject", box, confidence: 0.99}],
    mattePath: required ? `Renders/Subject-Mattes/raw/v001/${sourceId}/${String(index).padStart(6, "0")}.png` : null,
    matte: required ? {path: `Renders/Subject-Mattes/raw/v001/${sourceId}/${String(index).padStart(6, "0")}.png`, coverage: 0.5, chatterRatio: 0, edgeHaloPx: 0, sha256: "f".repeat(64), bytes: 64} : null,
  }));
  return {
    kind: "subject-map", schemaVersion: 1, sourceId, sourceSha256,
    sourceSnapshot: {sha256: sourceSha256, bytes: 100}, timeRangeMs: {startMs: 0, endMs: 3000},
    sampleFps: 1, expectedFrameCount: frames.length, coordinateSpace: "top-left-pixels",
    frameSize: {width: 1080, height: 1920}, frames,
    avoidRegions: frames.flatMap((frame) => frame.avoidRegions.map((region) => ({timeMs: frame.timeMs, ...region}))),
    tracking: {status: empty ? "empty" : "tracked", faceAnalysisAvailable: true, personAnalysisAvailable: true,
      faceConfidence: empty ? null : 0.99, subjectConfidence: empty ? null : 0.99, confidence: empty ? null : 0.99,
      discontinuities: [], jitterPx: 0, maxJitterPx: 0},
    mattes: {requested: required, required, coverage: required && frames.length ? 1 : 0, complete: required && frames.length > 0,
      maxChatterRatio: 0, maxEdgeHaloPx: 0}, deviations: [],
  };
}

async function readyProject() {
  const root = await mkdtemp(join(tmpdir(), "content-hub-artifact-captions-"));
  const {projectDir} = await createProject(root, {name: "Artifact Captions", editors: ["premiere"]});
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief frozen"});
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "ready"});
  return projectDir;
}

async function addWork(projectDir, workItemId = "raw-001", overrides = {}) {
  const revision = 1;
  const revisionName = pad(revision);
  const modality = "multi-clip";
  await createWorkItem(projectDir, coordinator, {id: workItemId, title: workItemId, modality});
  for (const to of ["MEDIA_INDEXED", "TRANSCRIPTS_READY", "STORY_PLANNED"]) {
    await transitionWorkItem(projectDir, coordinator, {workItemId, to, reason: to.toLowerCase()});
  }
  const mediaIndexRef = {artifactId: `media-index:${workItemId}:v${revisionName}`, sha256: sha256(`${workItemId}:index`)};
  const sourceHashes = {"source-a": sha256(`${workItemId}:source-a`), "source-b": sha256(`${workItemId}:source-b`)};
  const transcriptEntries = [];
  for (const sourceId of ["source-a", "source-b"]) {
    transcriptEntries.push(await storeArtifact(projectDir, `Plans/Transcripts/${workItemId}/v${revisionName}/${sourceId}-v${revisionName}.json`, {
      artifactId: `source-transcript:${workItemId}:${sourceId}:v${revisionName}`, revision, workItemId, modality,
      parents: [mediaIndexRef], producer: technician, versions, status: "frozen", deviations: [],
      payload: {kind: "source-transcript", sourceId, sourceSha256: sourceHashes[sourceId], transcript: {
        schemaVersion: 1, sourceId, sourceSha256: sourceHashes[sourceId], durationMs: 3000,
        timeBase: "source-relative-ms", language: "en", words: words(sourceId), text: words(sourceId).map(({text}) => text).join(" "),
      }},
    }));
  }
  const transcriptArtifactRefs = transcriptEntries.map(({artifactRef}) => artifactRef);
  const segments = [
    {id: "shot-b", sourceId: "source-b", sourceSha256: sourceHashes["source-b"], sourceInMs: 1000, sourceOutMs: 2200,
      firstWordId: "source-b:w000001", lastWordId: "source-b:w000002", wordIds: ["source-b:w000001", "source-b:w000002"],
      text: "Beta opens.", timelineInMs: 0, purpose: "Reordered hook"},
    {id: "shot-a", sourceId: "source-a", sourceSha256: sourceHashes["source-a"], sourceInMs: 500, sourceOutMs: 2000,
      firstWordId: "source-a:w000001", lastWordId: "source-a:w000002", wordIds: ["source-a:w000001", "source-a:w000002"],
      text: "Alpha returns.", timelineInMs: 1500, purpose: "Second shot"},
  ];
  const story = await storeArtifact(projectDir, `Plans/Stories/${workItemId}/story-plan-v${revisionName}.json`, {
    artifactId: `story-plan:${workItemId}:v${revisionName}`, revision, workItemId, modality,
    parents: [mediaIndexRef, ...transcriptArtifactRefs], producer: storyEditor, versions, status: "frozen", deviations: [],
    payload: {kind: "story-plan", segments, chronologicalAudit: [...segments].reverse(),
      silencePlan: [
        {sourceId: "source-a", sourceSha256: sourceHashes["source-a"], silencePlan: {operations: [{kind: "compress-gap", removeStartMs: 1000, removeEndMs: 1300, removedMs: 300}]}},
        {sourceId: "source-b", sourceSha256: sourceHashes["source-b"], silencePlan: {operations: [{kind: "compress-gap", removeStartMs: 1400, removeEndMs: 1700, removedMs: 300}]}},
      ], hook: {segmentId: "shot-b", firstWordId: "source-b:w000001", timelineInMs: 0, text: "Beta opens."}, retainedPauses: []},
  });
  const subjectEntries = [];
  for (const sourceId of ["source-a", "source-b"]) {
    const subject = await storeArtifact(projectDir, `Plans/Subjects/${workItemId}/v${revisionName}/${sourceId}-v${revisionName}.json`, {
      artifactId: `subject-map:${workItemId}:${sourceId}:v${revisionName}`, revision, workItemId, modality,
      parents: [mediaIndexRef], producer: analyst, versions, status: "frozen", deviations: [],
      payload: subjectPayload(sourceId, sourceHashes[sourceId], overrides.subject?.[sourceId]),
    });
    subjectEntries.push({sourceId, ...subject});
  }
  return {
    workItemId, revision, modality, producer, versions, storyArtifactRef: story.artifactRef, transcriptArtifactRefs,
    subjectMapArtifactRefs: subjectEntries.map(({artifactRef}) => artifactRef), requiredTracking: true, requiredMatte: true,
    style: "editorial-pair", anchorPlan: {segments: [{cueIndex: 0, wordIndices: [0]}, {cueIndex: 1, wordIndices: [1]}]},
  };
}

async function rewriteArtifact(projectDir, path, mutate) {
  const artifact = JSON.parse(await readFile(join(projectDir, path), "utf8"));
  mutate(artifact);
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  await writeFile(join(projectDir, path), bytes);
  return {artifact, artifactRef: {artifactId: artifact.artifactId, sha256: sha256(bytes)}};
}

async function selectSingleSourceStory(projectDir, input) {
  const path = "Plans/Stories/raw-001/story-plan-v001.json";
  const rewritten = await rewriteArtifact(projectDir, path, (story) => {
    story.payload.segments = [story.payload.segments[0]];
  });
  input.storyArtifactRef = rewritten.artifactRef;
  input.transcriptArtifactRefs = [input.transcriptArtifactRefs[1]];
  input.anchorPlan = {segments: [{cueIndex: 0, wordIndices: [0]}]};
}

test("consumes source-keyed upstream artifacts and retimes words plus avoids per reordered shot", async () => {
  const projectDir = await readyProject();
  const input = await addWork(projectDir);
  const result = await writeArtifactCaptionBundle(projectDir, input);

  assert.deepEqual(result.bundle.segments.map(({shotId}) => shotId), ["shot-b", "shot-a"]);
  assert.deepEqual(result.bundle.segments.map(({words: cueWords}) => cueWords.map(({id, start, end, fontRole}) => ({id, start, end, fontRole}))), [
    [{id: "source-b:w000001", start: 0.1, end: 0.3, fontRole: "display"}, {id: "source-b:w000002", start: 0.5, end: 0.7, fontRole: "body"}],
    [{id: "source-a:w000001", start: 1.7, end: 1.9, fontRole: "body"}, {id: "source-a:w000002", start: 2.2, end: 2.4, fontRole: "display"}],
  ]);
  assert.equal(result.bundle.segments[0].placement.anchorId, "lower-center");
  assert.equal(result.bundle.segments[1].placement.anchorId, "top-center");
  assert.match(await readFile(join(projectDir, result.files.srt), "utf8"), /00:00:00,100 --> 00:00:00,700[\s\S]*Beta opens\./u);
  assert.deepEqual(result.artifact.parents, [input.storyArtifactRef, ...input.transcriptArtifactRefs, ...input.subjectMapArtifactRefs]);
  assert.deepEqual(result.artifact.payload.cues.map(({cueId, shotId, storySegmentId, sourceIds, wordIds, startMs, endMs, identity, fontRoles, placement}) => ({cueId, shotId, storySegmentId, sourceIds, wordIds, startMs, endMs, identity, fontRoles, placement})), [
    {cueId: "cue-001", shotId: "shot-b", storySegmentId: "shot-b", sourceIds: ["source-b"], wordIds: ["source-b:w000001", "source-b:w000002"], startMs: 100, endMs: 700, identity: "editorial-pair", fontRoles: ["display", "body"], placement: result.bundle.segments[0].placement},
    {cueId: "cue-002", shotId: "shot-a", storySegmentId: "shot-a", sourceIds: ["source-a"], wordIds: ["source-a:w000001", "source-a:w000002"], startMs: 1700, endMs: 2400, identity: "editorial-pair", fontRoles: ["body", "display"], placement: result.bundle.segments[1].placement},
  ]);
  for (const file of Object.values(result.artifact.payload.files)) {
    const stored = await hashFileNoFollow(projectDir, file.path);
    assert.deepEqual({sha256: stored.sha256, bytes: stored.bytes}, {sha256: file.sha256, bytes: file.bytes});
  }
  const artifactBytes = await readFile(join(projectDir, "Plans", "Captions", "raw-001", "caption-plan-v001.json"));
  assert.equal(sha256(artifactBytes), result.artifactRef.sha256);
  assert.deepEqual(JSON.parse(artifactBytes), result.artifact);
});

test("rejects stale parents and missing, duplicate, cross-source, or empty required SubjectMaps", async () => {
  for (const [mutate, pattern] of [
    [(input) => { input.storyArtifactRef.sha256 = "0".repeat(64); }, /Story plan.*exact immutable reference/iu],
    [(input) => { input.subjectMapArtifactRefs.pop(); }, /Subject-map refs.*selected source/iu],
    [(input) => { input.subjectMapArtifactRefs[1] = input.subjectMapArtifactRefs[0]; }, /duplicate.*Subject-map|Subject-map refs.*selected source/iu],
    [(input) => { input.subjectMapArtifactRefs[0] = {...input.subjectMapArtifactRefs[0], artifactId: "subject-map:raw-001:source-c:v001"}; }, /Subject-map.*source/iu],
  ]) {
    const projectDir = await readyProject();
    const input = await addWork(projectDir);
    mutate(input);
    await assert.rejects(writeArtifactCaptionBundle(projectDir, input), pattern);
  }

  const emptyProject = await readyProject();
  const empty = await addWork(emptyProject, "raw-001", {subject: {"source-a": {required: true, empty: true}}});
  await assert.rejects(writeArtifactCaptionBundle(emptyProject, empty), /required.*track|empty.*SubjectMap/iu);

  const matteProject = await readyProject();
  const matte = await addWork(matteProject, "raw-001", {subject: {"source-a": {required: false}}});
  await assert.rejects(writeArtifactCaptionBundle(matteProject, matte), /Required mattes.*SubjectMap/iu);

  const unknownProject = await readyProject();
  const unknown = await addWork(unknownProject);
  unknown.style = "invented";
  await assert.rejects(writeArtifactCaptionBundle(unknownProject, unknown), /Caption style must be one of/u);
});

test("enforces frozen vertical-short tracking confidence, jitter, and continuity thresholds", async () => {
  for (const [mutate, pattern] of [
    [(subject) => { subject.payload.tracking.confidence = 0.79; }, /confidence/iu],
    [(subject) => { subject.payload.tracking.maxJitterPx = 7; }, /jitter/iu],
    [(subject) => { subject.payload.tracking.discontinuities = [1600]; }, /continuity/iu],
  ]) {
    const projectDir = await readyProject();
    const input = await addWork(projectDir);
    input.qualityThresholds = {minConfidence: 0, maxJitterPx: 1000};
    const path = "Plans/Subjects/raw-001/v001/source-a-v001.json";
    const rewritten = await rewriteArtifact(projectDir, path, mutate);
    input.subjectMapArtifactRefs[0] = rewritten.artifactRef;
    await assert.rejects(writeArtifactCaptionBundle(projectDir, input), pattern);
  }
});

test("treats silence removals as half-open when retiming placement avoids", async () => {
  const projectDir = await readyProject();
  const input = await addWork(projectDir);
  const path = "Plans/Subjects/raw-001/v001/source-b-v001.json";
  const rewritten = await rewriteArtifact(projectDir, path, (subject) => {
    const [first, second] = subject.payload.frames;
    const atStart = {x: 90, y: 100, width: 900, height: 400};
    const atEnd = {x: 90, y: 1100, width: 900, height: 400};
    subject.payload.frames = [
      {...first, timeMs: 1400, subjectBox: atStart, faces: [{box: atStart, confidence: 0.99}],
        avoidRegions: [{kind: "subject", box: atStart, confidence: 0.99}]},
      {...second, timeMs: 1700, subjectBox: atEnd, faces: [{box: atEnd, confidence: 0.99}],
        avoidRegions: [{kind: "subject", box: atEnd, confidence: 0.99}]},
    ];
    subject.payload.avoidRegions = subject.payload.frames.flatMap((frame) => frame.avoidRegions.map((region) => ({timeMs: frame.timeMs, ...region})));
  });
  input.subjectMapArtifactRefs[1] = rewritten.artifactRef;

  const result = await writeArtifactCaptionBundle(projectDir, input);
  assert.equal(result.bundle.segments[0].placement.anchorId, "top-center");
});

test("rejects tampered parent lineage, wrong-map payloads, and split-read story bytes", async () => {
  const parentProject = await readyProject();
  const parentInput = await addWork(parentProject);
  const storyPath = join(parentProject, "Plans", "Stories", "raw-001", "story-plan-v001.json");
  const story = JSON.parse(await readFile(storyPath, "utf8"));
  story.parents.find(({artifactId}) => artifactId.includes(":source-a:" )).sha256 = "0".repeat(64);
  const storyBytes = Buffer.from(`${JSON.stringify(story, null, 2)}\n`);
  await writeFile(storyPath, storyBytes);
  parentInput.storyArtifactRef.sha256 = sha256(storyBytes);
  await assert.rejects(writeArtifactCaptionBundle(parentProject, parentInput), /transcript.*not bound.*story/iu);

  const mapProject = await readyProject();
  const mapInput = await addWork(mapProject);
  const mapPath = join(mapProject, "Plans", "Subjects", "raw-001", "v001", "source-a-v001.json");
  const map = JSON.parse(await readFile(mapPath, "utf8"));
  map.payload.sourceId = "source-b";
  const mapBytes = Buffer.from(`${JSON.stringify(map, null, 2)}\n`);
  await writeFile(mapPath, mapBytes);
  mapInput.subjectMapArtifactRefs[0].sha256 = sha256(mapBytes);
  await assert.rejects(writeArtifactCaptionBundle(mapProject, mapInput), /SubjectMap source-a.*cross-source/iu);

  const splitProject = await readyProject();
  const splitInput = await addWork(splitProject);
  await assert.rejects(writeArtifactCaptionBundle(splitProject, splitInput, {
    readFileNoFollow: async (root, path) => {
      const stored = await readFileNoFollow(root, path);
      if (!path.endsWith("story-plan-v001.json")) return stored;
      const bytes = Buffer.from(stored.bytes.toString("utf8").replace("Reordered hook", "Reordered h00k"));
      assert.equal(bytes.length, stored.bytes.length);
      return {...stored, bytes};
    },
  }), /Story plan.*exact immutable reference/iu);
});

test("accepts a singular SubjectMap ref only for one selected source", async () => {
  const projectDir = await readyProject();
  const input = await addWork(projectDir);
  await selectSingleSourceStory(projectDir, input);
  input.subjectMapArtifactRef = input.subjectMapArtifactRefs[1];
  delete input.subjectMapArtifactRefs;

  const result = await writeArtifactCaptionBundle(projectDir, input);
  assert.equal(result.bundle.segments[0].words[0].sourceId, "source-b");

  const multiProject = await readyProject();
  const multi = await addWork(multiProject);
  multi.subjectMapArtifactRef = multi.subjectMapArtifactRefs[0];
  delete multi.subjectMapArtifactRefs;
  await assert.rejects(writeArtifactCaptionBundle(multiProject, multi), /Subject-map refs.*selected source/iu);
});

test("accepts the legacy single-source SubjectMap artifact ID and path", async () => {
  const projectDir = await readyProject();
  const input = await addWork(projectDir);
  await selectSingleSourceStory(projectDir, input);
  const canonical = JSON.parse(await readFile(join(projectDir, "Plans", "Subjects", "raw-001", "v001", "source-b-v001.json"), "utf8"));
  canonical.artifactId = "subject-map:raw-001:v001";
  const bytes = Buffer.from(`${JSON.stringify(canonical, null, 2)}\n`);
  const legacyPath = join(projectDir, "Plans", "Subjects", "raw-001", "subject-map-v001.json");
  await writeFile(legacyPath, bytes, {flag: "wx"});
  input.subjectMapArtifactRef = {artifactId: canonical.artifactId, sha256: sha256(bytes)};
  delete input.subjectMapArtifactRefs;

  const result = await writeArtifactCaptionBundle(projectDir, input);
  assert.equal(result.bundle.segments[0].words[0].sourceId, "source-b");
  assert.deepEqual(result.artifact.parents.at(-1), input.subjectMapArtifactRef);
});

test("rolls back only invocation-owned caption outputs on plan failure and rejects revision collisions", async () => {
  const projectDir = await readyProject();
  const input = await addWork(projectDir);
  const plan = join(projectDir, "Plans", "Captions", "raw-001", "caption-plan-v001.json");
  await mkdir(dirname(plan), {recursive: true});
  await writeFile(plan, "existing-plan", {flag: "wx"});
  await assert.rejects(writeArtifactCaptionBundle(projectDir, input), /exist|collision/iu);
  assert.equal(await readFile(plan, "utf8"), "existing-plan");
  await assert.rejects(stat(join(projectDir, "Renders", "Captions", "raw-001", "v001")), {code: "ENOENT"});
  assert.deepEqual((await readdir(join(projectDir, "Renders", "Captions", "raw-001"))).filter((name) => name.startsWith(".v001-")), []);

  const collisionProject = await readyProject();
  const collisionInput = await addWork(collisionProject);
  const output = join(collisionProject, "Renders", "Captions", "raw-001", "v001");
  await mkdir(output, {recursive: true});
  await writeFile(join(output, "winner"), "keep");
  await assert.rejects(writeArtifactCaptionBundle(collisionProject, collisionInput), /exist|collision/iu);
  assert.equal(await readFile(join(output, "winner"), "utf8"), "keep");
});

test("owner-safe rollback preserves a replacement caption plan", async () => {
  const projectDir = await readyProject();
  const input = await addWork(projectDir);
  let replaced = false;
  await assert.rejects(writeArtifactCaptionBundle(projectDir, input, {
    hashFileNoFollow: async (root, path) => {
      if (!replaced && path === "Plans/Captions/raw-001/caption-plan-v001.json") {
        replaced = true;
        const absolute = join(root, path);
        await rename(absolute, `${absolute}.owned`);
        await writeFile(absolute, "replacement-wins");
        throw new Error("replacement won before plan verification");
      }
      return hashFileNoFollow(root, path);
    },
  }), /replacement won/u);
  assert.equal(await readFile(join(projectDir, "Plans", "Captions", "raw-001", "caption-plan-v001.json"), "utf8"), "replacement-wins");
  await assert.rejects(stat(join(projectDir, "Renders", "Captions", "raw-001", "v001")), {code: "ENOENT"});
});

test("publishes the same caption revision independently for two work items", async () => {
  const projectDir = await readyProject();
  const first = await addWork(projectDir, "raw-001");
  const second = await addWork(projectDir, "raw-002");
  const [one, two] = await Promise.all([
    writeArtifactCaptionBundle(projectDir, first), writeArtifactCaptionBundle(projectDir, second),
  ]);
  assert.notEqual(one.artifactRef.sha256, two.artifactRef.sha256);
  assert.equal(JSON.parse(await readFile(join(projectDir, one.files.json), "utf8")).segments[0].shotId, "shot-b");
  assert.equal(JSON.parse(await readFile(join(projectDir, two.files.json), "utf8")).segments[0].shotId, "shot-b");
});

test("generic HyperFrames captions enforce anchor geometry and emitted paired font roles", async () => {
  const template = await readFile("Templates/HyperFrames/content-hub-pack/compositions/animated-captions-portrait.html", "utf8");
  assert.match(template, /requestedPlacement\.width > 0 && requestedPlacement\.height > 0/u);
  assert.match(template, /anchor\.style\.width = `\$\{placement\.width\}px`/u);
  assert.match(template, /anchor\.style\.height = `\$\{placement\.height\}px`/u);
  assert.match(template, /font-family: "Archivo"/u);
  assert.match(template, /font-family: "Fraunces"/u);
  assert.match(template, /span\.className = `caption-word font-\$\{fontRole\} sunburst-\$\{fontRole\}`/u);
  assert.match(template, /timeline\.fromTo\(cue,/u);
  assert.doesNotMatch(template, /timeline\.fromTo\(anchor,/u);
});
