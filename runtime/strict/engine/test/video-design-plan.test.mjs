import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, mkdtemp, readFile, unlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {createArtifactEnvelope, writeImmutableArtifact} from "../src/artifacts.mjs";
import {sha256File, sha256Value} from "../src/checksum.mjs";
import {createProject} from "../src/project.mjs";
import {createVideoDesignPlan, approveVideoDesignPlan} from "../src/video-design-plan.mjs";
import {createWorkItem, transitionProject, transitionWorkItem} from "../src/workflow.mjs";

const coordinator = {actorId: "content-hub-coordinator", actorRole: "coordinator"};
const hashes = (value) => "a".repeat(63) + value;
const versions = {tool: "content-hub@0.2.0", template: "sunburst-v1", model: null, policy: "bizibeast-v1"};
const digest = (value) => createHash("sha256").update(value).digest("hex");

async function store(projectDir, path, {artifactId, workItemId, modality, producer, parents = [], payload}) {
  const artifact = createArtifactEnvelope({artifactId, workItemId, revision: 1, modality, producer, parents, versions, status: "frozen", payload});
  const stored = await writeImmutableArtifact(projectDir, path, artifact);
  return {artifact, artifactRef: {artifactId, sha256: stored.sha256}};
}

function subjectPayload(sourceId, sourceSha256, durationMs, matteSha256) {
  const subjectBox = {x: 260, y: 240, width: 560, height: 1200};
  const face = {box: {x: 390, y: 280, width: 300, height: 300}, confidence: 0.98};
  const avoidRegions = [{kind: "face", box: face.box, confidence: face.confidence}, {kind: "subject", box: subjectBox, confidence: 0.97}];
  const frames = [{index: 0, timeMs: 0, faces: [face], subjectBox, subjectConfidence: 0.97, confidence: 0.97,
    discontinuity: false, jitterPx: 0, avoidRegions, matte: {path: `Renders/Subject-Mattes/${sourceId}/000000.png`, sha256: matteSha256, bytes: 64}}];
  return {kind: "subject-map", schemaVersion: 1, sourceId, sourceSha256, sourceSnapshot: {sha256: sourceSha256, bytes: 1024},
    timeRangeMs: {startMs: 0, endMs: durationMs}, sampleFps: 1, expectedFrameCount: 1, coordinateSpace: "top-left-pixels",
    frameSize: {width: 1080, height: 1920}, frames, avoidRegions: avoidRegions.map((region) => ({timeMs: 0, ...region})),
    tracking: {status: "tracked", faceAnalysisAvailable: true, personAnalysisAvailable: true, faceConfidence: 0.98,
      subjectConfidence: 0.97, confidence: 0.97, discontinuities: [], medianJitterPx: 0, maxJitterPx: 0},
    mattes: {requested: true, required: true, coverage: 1, complete: true, maxChatterRatio: 0, maxEdgeHaloPx: 0}, deviations: []};
}

function subjectContract(artifactId, map, sourceOutMs) {
  const frames = map.frames.map(({index, timeMs, avoidRegions}) => ({index, timeMs, avoidRegions}));
  const safeZoneData = {coordinateSpace: map.coordinateSpace, frameSize: map.frameSize, sourceRangeMs: {inMs: 0, outMs: sourceOutMs}, frames};
  return {subjectMapArtifactId: artifactId, safeZones: {...safeZoneData, sha256: sha256Value(safeZoneData)},
    tracking: {required: true, status: map.tracking.status, faceAnalysisAvailable: map.tracking.faceAnalysisAvailable,
      personAnalysisAvailable: map.tracking.personAnalysisAvailable, confidence: map.tracking.confidence,
      faceConfidence: map.tracking.faceConfidence, subjectConfidence: map.tracking.subjectConfidence,
      maxJitterPx: map.tracking.maxJitterPx, discontinuities: map.tracking.discontinuities,
      frames: map.frames.map(({index, timeMs, confidence, jitterPx, discontinuity}) => ({index, timeMs, confidence, jitterPx, discontinuity}))}};
}

function depthContract(workItemId, sourceId, foreground, map) {
  return {mode: "text-behind-subject", foregroundArtifactId: foreground.artifactRef.artifactId,
    mattePath: `Renders/Foreground/${workItemId}/${sourceId}/v001/foreground.mov`, matteSha256: foreground.artifact.payload.output.sha256,
    subjectMatteSha256: digest(map.frames.map(({matte}) => matte.sha256).join("")), fallback: "premiere-native"};
}

function acceptance(inMs, outMs, depth = false) {
  const frame = (timeMs) => Math.floor(timeMs * 30 / 1000);
  const evidence = [
    {id: "transition-before", phase: "before", kind: "transition", frame: frame(inMs), timeMs: inMs, assertion: "Hard cut is clean"},
    {id: "hero-mid", phase: "mid", kind: "hero-frame", frame: frame(inMs + Math.floor((outMs - inMs) / 2)), timeMs: inMs + Math.floor((outMs - inMs) / 2), assertion: "Hero hierarchy is readable"},
    {id: "caption-after", phase: "after", kind: "caption-safe", frame: frame(outMs - 1), timeMs: outMs - 1, assertion: "Caption avoids subject"},
  ];
  if (depth) evidence.push(
    {id: "matte-mid", phase: "mid", kind: "matte-edge", frame: evidence[1].frame, timeMs: evidence[1].timeMs, assertion: "Matte edge is clean"},
    {id: "occlusion-mid", phase: "mid", kind: "layer-occlusion", frame: evidence[1].frame, timeMs: evidence[1].timeMs, assertion: "Layer occlusion is correct"},
  );
  return evidence;
}

function retimed(spec, timeMs) {
  return timeMs - (spec.operations ?? []).reduce((sum, operation) => {
    const startMs = operation.removeStartMs ?? operation.startMs;
    const endMs = operation.removeEndMs ?? operation.endMs;
    return sum + Math.max(0, Math.min(timeMs, endMs) - Math.max(0, startMs));
  }, 0);
}

async function projectFixture() {
  const root = await mkdtemp(join(tmpdir(), "content-hub-video-design-"));
  const {projectDir} = await createProject(root, {name: "Design plan", editors: ["premiere"]});
  await transitionProject(projectDir, coordinator, {to: "BRIEF_APPROVED", reason: "brief frozen"});
  await mkdir(join(projectDir, "Plans", "Brand"), {recursive: true});
  await writeFile(join(projectDir, "frame.md"), "brand frame");
  await mkdir(join(projectDir, "Assets", "Fonts"), {recursive: true});
  await writeFile(join(projectDir, "Assets", "Fonts", "Archivo.ttf"), "font");
  const frameSha256 = await sha256File(join(projectDir, "frame.md"));
  const fontSha256 = await sha256File(join(projectDir, "Assets", "Fonts", "Archivo.ttf"));
  const lockPath = join(projectDir, "Plans", "Brand", "brand-lock.json");
  await writeFile(lockPath, JSON.stringify({artifactId: "project-brand-lock-v001", id: "sunburst", version: "1", framePath: "frame.md", frameSha256,
    fonts: [{family: "Archivo", path: "Assets/Fonts/Archivo.ttf", sha256: fontSha256, weights: null, licencePath: null, licenceSha256: null}], motifs: []}));
  const lockSha256 = await sha256File(lockPath);
  const {mutateManifest} = await import("../src/manifest.mjs");
  await mutateManifest(projectDir, coordinator, (manifest) => ({...manifest, brand: {artifactId: "project-brand-lock-v001", lockPath: "Plans/Brand/brand-lock.json",
    lockSha256, frameSha256, fontHashes: [fontSha256]}}));
  await transitionProject(projectDir, coordinator, {to: "READY", reason: "inputs frozen"});
  return {projectDir, brandRef: {artifactId: "project-brand-lock-v001", sha256: lockSha256},
    brand: {id: "sunburst", version: "1", frameSha256, fontHashes: [fontSha256]}};
}

async function addWork(projectDir, brandRef, brand, specs, {workItemId = "reel-001", modality = "raw-video", stylePresetId = "cinematic-layered-explainer-v1"} = {}) {
  await createWorkItem(projectDir, coordinator, {id: workItemId, title: workItemId, modality});
  for (const state of ["MEDIA_INDEXED", "TRANSCRIPTS_READY", "STORY_PLANNED"]) await transitionWorkItem(projectDir, coordinator, {workItemId, to: state, reason: state});
  let cursor = 0;
  const segments = specs.map((spec) => {
    const removedMs = (spec.operations ?? []).reduce((sum, operation) => sum + (operation.removedMs ?? 0), 0);
    const segment = {id: spec.shotId, sourceId: spec.sourceId, sourceSha256: spec.sourceSha256,
      sourceInMs: 0, sourceOutMs: spec.durationMs, timelineInMs: cursor, wordIds: [`${spec.sourceId}:w000001`]};
    cursor += spec.durationMs - removedMs;
    return segment;
  });
  const story = await store(projectDir, `Plans/Stories/${workItemId}/story-plan-v001.json`, {artifactId: `story-plan:${workItemId}:v001`, workItemId, modality,
    producer: {actorId: "story-1", role: "story-editor"}, payload: {kind: "story-plan", segments,
      silencePlan: specs.map(({sourceId, sourceSha256, operations = []}) => ({sourceId, sourceSha256, silencePlan: {operations}}))}});
  const transcripts = [], subjects = [], foregrounds = new Map();
  for (const [index, spec] of specs.entries()) {
    const transcript = await store(projectDir, `Plans/Transcripts/${workItemId}/v001/${spec.sourceId}-v001.json`,
      {artifactId: `source-transcript:${workItemId}:${spec.sourceId}:v001`, workItemId, modality,
        producer: {actorId: `media-${index + 1}`, role: "local-media-technician"}, parents: [story.artifactRef],
        payload: {kind: "source-transcript", sourceId: spec.sourceId, sourceSha256: spec.sourceSha256,
          transcript: {sourceId: spec.sourceId, sourceSha256: spec.sourceSha256, words: [{id: `${spec.sourceId}:w000001`, startMs: 100, endMs: spec.durationMs - 100, text: spec.shotId}]}}});
    const map = subjectPayload(spec.sourceId, spec.sourceSha256, spec.durationMs, hashes(String(index + 5)));
    const subject = await store(projectDir, `Plans/Subjects/${workItemId}/v001/${spec.sourceId}-v001.json`,
      {artifactId: `subject-map:${workItemId}:${spec.sourceId}:v001`, workItemId, modality,
        producer: {actorId: `subject-${index + 1}`, role: "subject-analyst"}, parents: [story.artifactRef], payload: map});
    if (spec.mode === "depth") {
      const matteHash = digest(map.frames.map(({matte}) => matte.sha256).join(""));
      const output = {path: `Renders/Foreground/${workItemId}/${spec.sourceId}/v001/foreground.mov`, sha256: digest(`foreground-${spec.sourceId}`), bytes: 4096};
      const foreground = await store(projectDir, `Plans/Foreground/${workItemId}/${spec.sourceId}/foreground-sidecar-v001.json`,
        {artifactId: `foreground-sidecar:${workItemId}:${spec.sourceId}:v001`, workItemId, modality,
          producer: {actorId: `foreground-${index + 1}`, role: "foreground-sidecar-executor"}, parents: [subject.artifactRef],
          payload: {kind: "foreground-sidecar", source: {id: spec.sourceId, path: `Source/${spec.sourceId}.mov`, sha256: spec.sourceSha256, bytes: 1024},
            mattes: {count: map.frames.length, sha256: matteHash}, output}});
      foregrounds.set(spec.sourceId, foreground);
    }
    transcripts.push(transcript); subjects.push(subject);
  }
  const selections = specs.flatMap(({shotId}, index) => [
    {id: `visual-${index + 1}`, kind: "image", sha256: digest(`visual-${index + 1}`), licence: "CC0", usageScope: "commercial", usageIds: [shotId]},
    {id: `sfx-${index + 1}`, kind: "sfx", sha256: digest(`sfx-${index + 1}`), licence: "CC0", usageScope: "commercial", usageIds: [shotId]},
    {id: `music-${index + 1}`, kind: "music", sha256: digest(`music-${index + 1}`), licence: "CC0", usageScope: "commercial", usageIds: [shotId]},
  ]);
  const assets = await store(projectDir, `Plans/Assets/${workItemId}/asset-plan-v001.json`, {artifactId: `asset-plan:${workItemId}:v001`, workItemId, modality,
    producer: {actorId: "assets-1", role: "asset-resolver"}, parents: [story.artifactRef], payload: {kind: "asset-plan", selections}});
  const placements = specs.map(({shotId}, index) => ({shotId, placement: {x: 80, y: 120 + 20 * index}}));
  const cues = specs.map((spec, index) => ({cueId: `cue-${index + 1}`, shotId: spec.shotId, storySegmentId: spec.shotId, sourceIds: [spec.sourceId],
    wordIds: [`${spec.sourceId}:w000001`], startMs: segments[index].timelineInMs + retimed(spec, 100),
    endMs: segments[index].timelineInMs + retimed(spec, spec.durationMs - 100), identity: "editorial-pair", fontRoles: ["body", "display"], placement: placements[index].placement}));
  const captions = await store(projectDir, `Plans/Captions/${workItemId}/caption-plan-v001.json`, {artifactId: `caption-plan:${workItemId}:v001`, workItemId, modality,
    producer: {actorId: "caption-1", role: "caption-executor"}, parents: [story.artifactRef, ...transcripts.map((item) => item.artifactRef), ...subjects.map((item) => item.artifactRef)],
    payload: {kind: "caption-plan", placements, cues}});
  const shots = specs.map((spec, index) => {
    const inMs = segments[index].timelineInMs, outMs = inMs + retimed(spec, spec.durationMs);
    const editorOwner = {role: "premiere-executor", editor: "premiere"};
    const hyperframesOwner = {role: "hyperframes-executor", editor: "hyperframes"};
    const layers = ["back", "subject", "foreground", "caption"].map((role) => {
      const fullBack = ["full-frame-explainer", "depth"].includes(spec.mode);
      const layerIn = role === "subject" || (role === "back" && fullBack) || (role === "foreground" && spec.mode === "depth") ? inMs
        : role === "caption" ? cues[index].startMs : inMs + 100;
      const layerOut = role === "subject" || (role === "back" && fullBack) || (role === "foreground" && spec.mode === "depth") ? outMs
        : role === "caption" ? cues[index].endMs : outMs - 100;
      const owner = role === "subject" || (spec.mode === "a-roll" && role !== "caption") ? editorOwner : hyperframesOwner;
      return {id: `${spec.shotId}-${role}`, role, owner, inMs: layerIn, outMs: layerOut,
        entryFrames: 12, staggerFrames: 4, settleFrames: 15, holdFrames: spec.mode === "upper-montage" ? 15 : null,
        exitFrames: 8, easing: "power3.out", fromScale: 0.88, toScale: 1, overshoot: role === "foreground" ? 0.02 : 0};
    });
    const visual = selections.find(({id}) => id === `visual-${index + 1}`);
    const sfx = selections.find(({id}) => id === `sfx-${index + 1}`);
    const music = selections.find(({id}) => id === `music-${index + 1}`);
    const depth = spec.mode === "depth" ? depthContract(workItemId, spec.sourceId, foregrounds.get(spec.sourceId), subjects[index].artifact.payload)
      : {mode: "flat", foregroundArtifactId: null, mattePath: null, matteSha256: null, subjectMatteSha256: null, fallback: "none"};
    return {id: spec.shotId, timeline: {inMs, outMs}, source: {storySegmentId: spec.shotId, sourceId: spec.sourceId, sourceSha256: spec.sourceSha256,
      inMs: 0, outMs: spec.durationMs, silenceOperationHashes: (spec.operations ?? []).map((operation) => sha256Value(operation))},
    captions: {enabled: true, identity: "editorial-pair", cueIds: [`cue-${index + 1}`], fontRoles: ["body", "display"], placement: placements[index].placement},
    subject: subjectContract(subjects[index].artifactRef.artifactId, subjects[index].artifact.payload, spec.durationMs),
    depth, onScreenCopy: {hierarchy: [{id: `${spec.shotId}-headline`, role: "headline",
      cueRefs: [{cueId: `cue-${index + 1}`, sourceId: spec.sourceId}], fontRoles: ["body", "display"]}],
      mode: spec.mode, layers, hardCutOffsetFrames: 0},
    assets: [{assetId: visual.id, kind: visual.kind, sha256: visual.sha256, usageId: spec.shotId}],
    audio: {sfx: [{assetId: sfx.id, kind: sfx.kind, sha256: sfx.sha256, usageId: spec.shotId}],
      bgm: {assetId: music.id, kind: music.kind, sha256: music.sha256, usageId: spec.shotId}},
    transitions: {in: "cut", out: "cut"}, grading: {tokens: {brandId: brand.id, brandVersion: brand.version, frameSha256: brand.frameSha256, fontHashes: brand.fontHashes}},
    editorOwner, acceptance: acceptance(inMs, outMs, spec.mode === "depth"),
    stylePresetId};
  });
  return {workItemId, revision: 1, modality, stylePresetId, producer: {actorId: `design-${workItemId}`, role: "design-director"}, versions, format: "9:16",
    scriptOrTranscriptRef: transcripts[0].artifactRef, transcriptArtifactRefs: transcripts.map((item) => item.artifactRef), storyPlanRef: story.artifactRef,
    assetPlanRef: assets.artifactRef, subjectMapRefs: subjects.map((item) => item.artifactRef), brandRef, brand, captionPlanRef: captions.artifactRef,
    foregroundSidecarRefs: [...foregrounds.values()].map((item) => item.artifactRef), silencePlanRef: story.artifactRef, heroMoment: "Open", surpriseBeat: "Hit",
    antiPatterns: ["no ae"], shots};
}

async function fixture() {
  const context = await projectFixture();
  return {...context, input: await addWork(context.projectDir, context.brandRef, context.brand,
    [{shotId: "shot-01", sourceId: "source-a", sourceSha256: hashes("3"), durationMs: 1800, mode: "a-roll",
      operations: [{kind: "compress-gap", removeStartMs: 200, removeEndMs: 250, removedMs: 50},
        {kind: "compress-gap", removeStartMs: 500, removeEndMs: 600, removedMs: 100}]}])};
}

async function cinematicFixture() {
  const context = await projectFixture();
  return {...context, input: await addWork(context.projectDir, context.brandRef, context.brand, [
    {shotId: "shot-a", sourceId: "source-a", sourceSha256: hashes("1"), durationMs: 1800, mode: "a-roll"},
    {shotId: "shot-b", sourceId: "source-b", sourceSha256: hashes("2"), durationMs: 3000, mode: "full-frame-explainer"},
    {shotId: "shot-c", sourceId: "source-c", sourceSha256: hashes("3"), durationMs: 2200, mode: "upper-montage"},
    {shotId: "shot-d", sourceId: "source-d", sourceSha256: hashes("4"), durationMs: 2400, mode: "depth"},
    {shotId: "shot-e", sourceId: "source-e", sourceSha256: hashes("5"), durationMs: 2000, mode: "foreground-emphasis"},
  ], {workItemId: "cinematic-001", modality: "multi-clip"})};
}

test("requires every shot-level execution decision", async () => {
  const {projectDir, input} = await fixture();
  const result = await createVideoDesignPlan(projectDir, input);
  assert.deepEqual(Object.keys(result.designPlan.shots[0]).sort(), ["acceptance", "assets", "audio", "captions", "depth", "editorOwner", "grading", "id", "onScreenCopy", "source", "stylePresetId", "subject", "timeline", "transitions"]);
  assert.equal(result.designPlan.shots[0].source.silenceOperationHashes.length, 2);
  assert.deepEqual(result.designPlan.parents.foregroundSidecars, []);
  assert.deepEqual(JSON.parse(await readFile(join(projectDir, "Plans", "Designs", "reel-001", "design-plan-v001.json"), "utf8")), result.artifact);
});

test("freezes a production-shaped multi-source cinematic design", async () => {
  const {projectDir, input} = await cinematicFixture();
  const result = await createVideoDesignPlan(projectDir, input);
  assert.deepEqual(result.designPlan.shots.map(({source}) => source.sourceId), ["source-a", "source-b", "source-c", "source-d", "source-e"]);
  assert.deepEqual(result.designPlan.shots.map(({onScreenCopy}) => onScreenCopy.mode),
    ["a-roll", "full-frame-explainer", "upper-montage", "depth", "foreground-emphasis"]);
  assert.equal(result.designPlan.stylePresetId, "cinematic-layered-explainer-v1");
  assert.ok(result.designPlan.shots.every(({stylePresetId}) => stylePresetId === result.designPlan.stylePresetId));
  assert.ok(result.designPlan.shots.every(({onScreenCopy}) => onScreenCopy.layers.length === 4));
  assert.equal(result.designPlan.parents.foregroundSidecars.length, 1);
  assert.equal(result.designPlan.shots[2].onScreenCopy.layers[0].holdFrames, 15);
  assert.equal(result.designPlan.shots[2].timeline.outMs - result.designPlan.shots[2].timeline.inMs, 2200);
});

test("accepts the exact 30fps layer-token boundary and rejects one millisecond less", async () => {
  const exact = await projectFixture();
  const exactInput = await addWork(exact.projectDir, exact.brandRef, exact.brand,
    [{shotId: "shot-01", sourceId: "source-a", sourceSha256: hashes("3"), durationMs: 2200, mode: "upper-montage"}]);
  const exactLayer = exactInput.shots[0].onScreenCopy.layers.find(({role}) => role === "foreground");
  exactLayer.inMs = 100; exactLayer.outMs = 1900;
  await createVideoDesignPlan(exact.projectDir, exactInput);

  const short = await projectFixture();
  const shortInput = await addWork(short.projectDir, short.brandRef, short.brand,
    [{shotId: "shot-01", sourceId: "source-a", sourceSha256: hashes("3"), durationMs: 2200, mode: "upper-montage"}]);
  const shortLayer = shortInput.shots[0].onScreenCopy.layers.find(({role}) => role === "foreground");
  shortLayer.inMs = 100; shortLayer.outMs = 1899;
  await assert.rejects(createVideoDesignPlan(short.projectDir, shortInput), /frame-token budget/u);
});

test("rejects a caption cue owned by both headline and supporting hierarchy entries", async () => {
  const context = await projectFixture();
  const input = await addWork(context.projectDir, context.brandRef, context.brand,
    [{shotId: "shot-01", sourceId: "source-a", sourceSha256: hashes("3"), durationMs: 3000, mode: "full-frame-explainer"}]);
  const hierarchy = input.shots[0].onScreenCopy.hierarchy;
  hierarchy.push({...structuredClone(hierarchy[0]), id: "shot-01-support", role: "supporting"});
  await assert.rejects(createVideoDesignPlan(context.projectDir, input), /hierarchy.*cue|cue.*hierarchy/iu);
});

test("routes subject to Premiere and designed graphics and captions to HyperFrames", async () => {
  const context = await projectFixture();
  const input = await addWork(context.projectDir, context.brandRef, context.brand,
    [{shotId: "shot-01", sourceId: "source-a", sourceSha256: hashes("3"), durationMs: 3000, mode: "full-frame-explainer"}]);
  for (const layer of input.shots[0].onScreenCopy.layers) layer.owner = {role: "premiere-executor", editor: "premiere"};
  await assert.rejects(createVideoDesignPlan(context.projectDir, input), /layer routing/u);
});

test("keeps a-roll inside the cinematic plan preset and rejects mixed shot presets", async () => {
  const valid = await projectFixture();
  const validInput = await addWork(valid.projectDir, valid.brandRef, valid.brand,
    [{shotId: "shot-01", sourceId: "source-a", sourceSha256: hashes("3"), durationMs: 1800, mode: "a-roll"}]);
  const result = await createVideoDesignPlan(valid.projectDir, validInput);
  assert.equal(result.designPlan.shots[0].stylePresetId, "cinematic-layered-explainer-v1");

  const mixed = await projectFixture();
  const mixedInput = await addWork(mixed.projectDir, mixed.brandRef, mixed.brand,
    [{shotId: "shot-01", sourceId: "source-a", sourceSha256: hashes("3"), durationMs: 1800, mode: "a-roll"}]);
  mixedInput.shots[0].stylePresetId = "sunburst-standard-v1";
  await assert.rejects(createVideoDesignPlan(mixed.projectDir, mixedInput), /plan style preset/u);
});

test("uses absolute sequence frame numbers for later shots", async () => {
  const context = await projectFixture();
  const input = await addWork(context.projectDir, context.brandRef, context.brand, [
    {shotId: "shot-a", sourceId: "source-a", sourceSha256: hashes("1"), durationMs: 3000, mode: "full-frame-explainer"},
    {shotId: "shot-b", sourceId: "source-b", sourceSha256: hashes("2"), durationMs: 3000, mode: "full-frame-explainer"},
  ], {modality: "multi-clip"});
  const result = await createVideoDesignPlan(context.projectDir, input);
  assert.deepEqual(result.designPlan.shots[1].acceptance.map(({frame}) => frame), [90, 135, 179]);
});

test("rejects fabricated shot evidence and impossible timeline values", async () => {
  const {projectDir, input} = await fixture();
  const probes = [(shot) => { shot.subject.safeZones.frames[0].avoidRegions[0].box.x += 1; },
    (shot) => { shot.depth.subjectMatteSha256 = hashes("9"); }, (shot) => { shot.grading.tokens.brandId = "fabricated"; },
    (shot) => { shot.editorOwner.actorId = "unbound-actor"; }, (shot) => { shot.captions.cueIds = ["fabricated-cue"]; },
    (shot) => { shot.audio.sfx = ["fabricated-audio"]; }, (shot) => { shot.timeline.outMs = 999999; }];
  for (const mutate of probes) { const malformed = structuredClone(input); mutate(malformed.shots[0]); await assert.rejects(createVideoDesignPlan(projectDir, malformed)); }
});

test("rejects free-text, reordered, duplicate, and fabricated silence-operation bindings", async () => {
  const {projectDir, input} = await fixture();
  const probes = [
    (shot) => { delete shot.source.silenceOperationHashes; shot.source.silenceIntent = "trim"; shot.source.pauseIntent = "keep"; },
    (shot) => { shot.source.silenceOperationHashes.reverse(); },
    (shot) => { shot.source.silenceOperationHashes[1] = shot.source.silenceOperationHashes[0]; },
    (shot) => { shot.source.silenceOperationHashes[0] = hashes("9"); },
  ];
  for (const mutate of probes) { const malformed = structuredClone(input); mutate(malformed.shots[0]); await assert.rejects(createVideoDesignPlan(projectDir, malformed)); }
});

test("rejects visual, SFX, and BGM kind substitutions", async () => {
  const {projectDir, input} = await fixture();
  const probes = [(shot) => { shot.assets[0].kind = "sfx"; }, (shot) => { shot.audio.sfx[0].kind = "music"; },
    (shot) => { shot.audio.bgm.kind = "sfx"; }];
  for (const mutate of probes) { const malformed = structuredClone(input); mutate(malformed.shots[0]); await assert.rejects(createVideoDesignPlan(projectDir, malformed)); }
});

test("rejects fabricated cinematic tokens, owners, depth fallback, and evidence", async () => {
  const {projectDir, input} = await cinematicFixture();
  const probes = [
    [0, (shot) => { shot.stylePresetId = "unknown"; }], [0, (shot) => { shot.onScreenCopy.mode = "montage"; }],
    [1, (shot) => { shot.onScreenCopy.mode = "explainer"; }], [0, (shot) => { shot.onScreenCopy.hardCutOffsetFrames = 3; }],
    [0, (shot) => { shot.onScreenCopy.layers[0].entryFrames = 8; }], [0, (shot) => { shot.onScreenCopy.layers[0].staggerFrames = 7; }],
    [0, (shot) => { shot.onScreenCopy.layers[0].settleFrames = 19; }], [2, (shot) => { shot.onScreenCopy.layers[0].holdFrames = 21; }],
    [0, (shot) => { shot.onScreenCopy.layers[0].holdFrames = 15; }], [0, (shot) => { shot.onScreenCopy.layers[0].exitFrames = 11; }],
    [0, (shot) => { shot.onScreenCopy.layers[0].fromScale = 0.9; }], [0, (shot) => { shot.onScreenCopy.layers[0].easing = "bounce.out"; }],
    [0, (shot) => { shot.onScreenCopy.layers[0].overshoot = 0.05; }], [0, (shot) => { shot.onScreenCopy.layers[1].owner = {role: "hyperframes-executor", editor: "hyperframes"}; }],
    [1, (shot) => { shot.onScreenCopy.layers[0].outMs -= 1; }], [0, (shot) => { shot.onScreenCopy.layers[3].inMs += 1; }],
    [3, (shot) => { shot.onScreenCopy.layers[2].outMs -= 1; }], [3, (shot) => { shot.depth.fallback = "after-effects"; }],
    [0, (shot) => { shot.transitions.in = "dissolve"; }], [0, (shot) => { shot.acceptance[0].frame = 1; }],
    [0, (shot) => { shot.acceptance[2].id = shot.acceptance[0].id; }], [0, (shot) => { shot.acceptance = shot.acceptance.slice(1); }],
    [3, (shot) => { shot.acceptance = shot.acceptance.filter(({kind}) => kind !== "matte-edge"); }],
    [0, (shot) => { shot.onScreenCopy.hierarchy[0].cueRefs[0].cueId = "wrong-cue"; }], [0, (shot) => { shot.onScreenCopy.hierarchy[0].fontRoles = ["display"]; }],
  ];
  for (const [index, mutate] of probes) { const malformed = structuredClone(input); mutate(malformed.shots[index]); await assert.rejects(createVideoDesignPlan(projectDir, malformed)); }
});

test("rejects a full-frame explainer outside 2500-4800ms without treating montage hold as milliseconds", async () => {
  const context = await projectFixture();
  const input = await addWork(context.projectDir, context.brandRef, context.brand,
    [{shotId: "short", sourceId: "source-a", sourceSha256: hashes("3"), durationMs: 2000, mode: "full-frame-explainer"}]);
  await assert.rejects(createVideoDesignPlan(context.projectDir, input), /full-frame explainer duration/u);
});

test("design approver cannot be the design producer", async () => {
  const {projectDir, input} = await fixture(); const result = await createVideoDesignPlan(projectDir, input);
  await assert.rejects(approveVideoDesignPlan(projectDir, coordinator, {workItemId: input.workItemId, artifactRef: result.artifactRef,
    producerActorId: input.producer.actorId, reviewerActorId: input.producer.actorId}), /independent reviewer|own work/u);
});

test("records only an independent bizibeast design approval for the current plan", async () => {
  const {projectDir, input} = await fixture(); const result = await createVideoDesignPlan(projectDir, input);
  await transitionWorkItem(projectDir, coordinator, {workItemId: input.workItemId, to: "DESIGN_PLANNED", reason: "plan frozen",
    artifactRef: {id: result.artifactRef.artifactId, sha256: result.artifactRef.sha256}});
  const approval = await approveVideoDesignPlan(projectDir, coordinator, {workItemId: input.workItemId, artifactRef: result.artifactRef,
    producerActorId: input.producer.actorId, reviewerActorId: "design-reviewer"});
  assert.deepEqual(approval.subject, result.artifactRef); assert.equal(approval.origin, "bizibeast"); assert.equal(approval.approver.role, "design-approver");
});

test("rejects missing and fabricated nested shot fields", async () => {
  const {projectDir, input} = await fixture(); const missing = structuredClone(input); delete missing.shots[0].audio;
  await assert.rejects(createVideoDesignPlan(projectDir, missing), /missing fields/u);
  const fabricated = structuredClone(input); fabricated.shots[0].captions.fabricated = true;
  await assert.rejects(createVideoDesignPlan(projectDir, fabricated), /caption.*unknown|unknown.*caption/iu);
});

test("rejects a cross-source subject-map reference", async () => {
  const {projectDir, input} = await cinematicFixture(); const malformed = structuredClone(input);
  malformed.shots[0].subject.subjectMapArtifactId = input.subjectMapRefs[1].artifactId;
  await assert.rejects(createVideoDesignPlan(projectDir, malformed), /subject.*map|source/iu);
});

test("rejects a stale story parent before publishing a plan", async () => {
  const {projectDir, input} = await fixture(); await unlink(join(projectDir, "Plans", "Stories", input.workItemId, "story-plan-v001.json"));
  await assert.rejects(createVideoDesignPlan(projectDir, input));
  await assert.rejects(readFile(join(projectDir, "Plans", "Designs", input.workItemId, "design-plan-v001.json")), {code: "ENOENT"});
});

test("does not replace an immutable plan on another publication attempt", async () => {
  const {projectDir, input} = await fixture(); const first = await createVideoDesignPlan(projectDir, input); const second = structuredClone(input);
  second.producer.actorId = "design-other"; await assert.rejects(createVideoDesignPlan(projectDir, second), /File exists/u);
  assert.deepEqual(JSON.parse(await readFile(join(projectDir, "Plans", "Designs", input.workItemId, "design-plan-v001.json"), "utf8")), first.artifact);
});

test("publishes v001 independently for two work items", async () => {
  const {projectDir, brandRef, brand, input} = await fixture();
  const second = await addWork(projectDir, brandRef, brand, [{shotId: "shot-01", sourceId: "source-a", sourceSha256: hashes("3"), durationMs: 1800, mode: "a-roll"}], {workItemId: "reel-002"});
  const [firstResult, secondResult] = await Promise.all([createVideoDesignPlan(projectDir, input), createVideoDesignPlan(projectDir, second)]);
  assert.match(await readFile(join(projectDir, "Plans", "Designs", "reel-001", "design-plan-v001.json"), "utf8"), new RegExp(firstResult.artifact.artifactId, "u"));
  assert.match(await readFile(join(projectDir, "Plans", "Designs", "reel-002", "design-plan-v001.json"), "utf8"), new RegExp(secondResult.artifact.artifactId, "u"));
});

test("removes only its owned plan after post-write verification fails", async () => {
  const {projectDir, input} = await fixture();
  await assert.rejects(createVideoDesignPlan(projectDir, input, {hashFileNoFollow: async (root, path) => ({sha256: hashes("0"),
    bytes: (await readFile(join(root, path))).length, owner: {dev: 0, ino: 0}})}), /changed after publication/u);
  await assert.rejects(readFile(join(projectDir, "Plans", "Designs", input.workItemId, "design-plan-v001.json")), {code: "ENOENT"});
});
