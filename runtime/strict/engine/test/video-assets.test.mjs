import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdir, mkdtemp, readdir, readFile, realpath, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, extname, join} from "node:path";
import test from "node:test";
import {promisify} from "node:util";

import {ingestFiles} from "../src/ingest.mjs";
import {readManifest} from "../src/manifest.mjs";
import {createProject} from "../src/project.mjs";
import {resolveVideoAssets} from "../src/video-assets.mjs";

const coordinator = {actorId: "content-hub-coordinator", actorRole: "coordinator"};
const producer = {actorId: "asset-resolver", role: "local-media-technician"};
const audio = () => ({durationSeconds: 2, formatName: "mp3", audio: [{codec_name: "mp3"}], video: []});
const video = () => ({durationSeconds: 2, formatName: "mov", audio: [], video: [{codec_name: "h264"}]});
const noMedia = () => ({durationSeconds: 0, formatName: "data", audio: [], video: []});
const execFileAsync = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "content-hub-video-assets-"));
  const {projectDir} = await createProject(root, {name: "Asset Plan", editors: ["premiere"]});
  const paths = {
    projectMusic: join(root, "project.mp3"),
    frozenTemplate: join(root, "frozen.mov"),
    sharedMusic: join(root, "shared.mp3"),
    publicMusic: join(root, "public.mp3"),
    generatedSfx: join(root, "generated.wav"),
    fakeMp3: join(root, "fake.mp3"),
  };
  await Promise.all(Object.entries(paths).map(async ([name, path]) => writeFile(path, `${name}-bytes`)));
  return {root, projectDir, paths};
}

async function truncatedMp3(root) {
  const complete = join(root, "complete.mp3");
  const truncated = join(root, "truncated-600.mp3");
  await execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libmp3lame", complete]);
  const bytes = await readFile(complete);
  assert.ok(bytes.length > 600);
  await writeFile(truncated, bytes.subarray(0, 600));
  return truncated;
}

function input(needs, extra = {}) {
  return {
    workItemId: "reel",
    revision: 1,
    needs,
    producer,
    coordinatorContext: coordinator,
    versions: {tool: "content-hub@0.1.0", template: null, model: null, policy: "bizibeast-v1"},
    ...extra,
  };
}

function adapters(entries, extra = {}) {
  const media = new Map(entries);
  return {
    probe: async (path) => media.get(path) ?? media.get(await realpath(path))
      ?? [...media.entries()].find(([candidate]) => basename(candidate) === basename(path))?.[1]
      ?? [...media.entries()].find(([candidate]) => extname(candidate) === extname(path))?.[1] ?? noMedia(),
    acquirePublic: async () => [],
    generateLocal: async () => [],
    decode: async () => {},
    ...extra,
  };
}

test("prefers a real project audio asset over shared and generated candidates", async () => {
  const {projectDir, paths} = await fixture();
  const [project] = await ingestFiles(projectDir, [paths.projectMusic], "music", {}, coordinator);
  const result = await resolveVideoAssets(projectDir, input([
    {id: "bgm-01", kind: "music", required: true, usageIds: ["shot-01"]},
  ]), adapters([
    [project.absolutePath, audio()], [paths.sharedMusic, audio()], [paths.generatedSfx, audio()],
  ], {
    sharedCandidates: async () => [{id: "shared-music", kind: "music", absolutePath: paths.sharedMusic, licence: "CC0", attribution: "Public domain", usageScope: "commercial"}],
    generateLocal: async () => [{id: "generated-music", kind: "music", absolutePath: paths.generatedSfx, model: "local-music", providerRevision: "local-music@1", prompt: "calm"}],
  }));

  assert.equal(result.assetPlan.selections[0].resolutionTier, 1);
  assert.equal(result.assetPlan.selections[0].id, project.id);
  assert.equal(result.assetPlan.selections[0].media.audioStreams, 1);
  assert.deepEqual(result.assetPlan.selections[0].usageIds, ["shot-01"]);
  assert.equal(result.artifactRef.sha256.length, 64);
  assert.deepEqual(JSON.parse(await readFile(join(projectDir, "Plans", "Assets", "reel", "asset-plan-v001.json"), "utf8")), result.artifact);
});

test("uses the frozen template tier before the shared lowercase library and freezes provenance", async () => {
  const {projectDir, paths} = await fixture();
  const result = await resolveVideoAssets(projectDir, input([
    {id: "transition-01", kind: "transition", required: true, usageIds: ["shot-02", "cue-01"]},
  ]), adapters([[paths.frozenTemplate, video()], [paths.sharedMusic, video()]], {
    frozenCandidates: async () => [{id: "template-transition", kind: "transition", absolutePath: paths.frozenTemplate, templateRevision: "template@7", licence: "licensed"}],
    sharedCandidates: async () => [{id: "shared-transition", kind: "transition", absolutePath: paths.sharedMusic, licence: "CC0", attribution: "Public domain", usageScope: "commercial"}],
  }));

  const [selection] = result.assetPlan.selections;
  assert.equal(selection.resolutionTier, 2);
  assert.equal(selection.templateRevision, "template@7");
  assert.equal(selection.path.startsWith("Assets/Templates/"), true);
  assert.equal(selection.sha256.length, 64);
  assert.deepEqual(selection.usageIds, ["shot-02", "cue-01"]);
});

test("copies rights-complete shared candidates into the project before publishing the plan", async () => {
  const {projectDir, paths} = await fixture();
  const result = await resolveVideoAssets(projectDir, input([
    {id: "sfx-01", kind: "sfx", required: true, usageIds: ["cue-02"]},
  ]), adapters([[paths.sharedMusic, audio()]], {
    sharedCandidates: async () => [{
      id: "shared-sfx", kind: "sfx", absolutePath: paths.sharedMusic, licence: "CC0-1.0",
      attribution: "Example artist", usageScope: "commercial", originalPath: "/assets/sfx/shared.mp3",
    }],
  }));

  const [selection] = result.assetPlan.selections;
  const manifest = await readManifest(projectDir);
  assert.equal(selection.resolutionTier, 3);
  assert.equal(selection.path.startsWith("Assets/SFX/"), true);
  assert.equal(manifest.assets.find(({id}) => id === selection.id).originType, "shared-library");
  assert.equal(manifest.assets.find(({id}) => id === selection.id).attribution, "Example artist");
  assert.equal(manifest.assets.find(({id}) => id === selection.id).usageIds[0], "cue-02");
});

test("requires complete public and local-generation provenance without contacting either provider in tests", async () => {
  const {projectDir, paths} = await fixture();
  let acquired = 0;
  let generated = 0;
  await assert.rejects(resolveVideoAssets(projectDir, input([
    {id: "public-01", kind: "music", required: true, usageIds: ["shot-03"]},
  ]), adapters([[paths.publicMusic, audio()]], {
    acquirePublic: async () => {
      acquired += 1;
      return [{id: "bad-public", kind: "music", absolutePath: paths.publicMusic, sourceUrl: "https://example.test/music.mp3", licence: "CC0", usageScope: "commercial"}];
    },
  })), /rights-complete|actual media stream/u);
  assert.equal(acquired, 1);

  const publicResult = await resolveVideoAssets(projectDir, input([
    {id: "public-02", kind: "music", required: true, usageIds: ["shot-04"]},
  ], {revision: 2}), adapters([[paths.publicMusic, audio()]], {
    acquirePublic: async () => [{id: "public-music", kind: "music", absolutePath: paths.publicMusic, sourceUrl: "https://example.test/music.mp3", licence: "CC0", attribution: "Example artist", usageScope: "commercial"}],
  }));
  assert.equal(publicResult.assetPlan.selections[0].resolutionTier, 4);
  assert.equal(publicResult.assetPlan.selections[0].sourceUrl, "https://example.test/music.mp3");

  const generatedResult = await resolveVideoAssets(projectDir, input([
    {id: "generated-01", kind: "sfx", required: true, usageIds: ["cue-03"]},
  ], {revision: 3}), adapters([[paths.generatedSfx, audio()]], {
    generateLocal: async () => {
      generated += 1;
      return [{id: "generated-sfx", kind: "sfx", absolutePath: paths.generatedSfx, model: "local-sfx", providerRevision: "local-sfx@1", prompt: "paper tear"}];
    },
  }));
  assert.equal(generated, 1);
  assert.equal(generatedResult.assetPlan.selections[0].resolutionTier, 5);
  assert.equal(generatedResult.assetPlan.selections[0].prompt, "paper tear");
});

test("rejects fake streams, private promotion, duplicate needs, and leaves no partial plan", async () => {
  const {projectDir, paths} = await fixture();
  await assert.rejects(resolveVideoAssets(projectDir, input([
    {id: "fake-01", kind: "music", required: true, usageIds: ["shot-05"]},
  ]), adapters([[paths.fakeMp3, noMedia()]], {
    sharedCandidates: async () => [{id: "fake-mp3", kind: "music", absolutePath: paths.fakeMp3, licence: "CC0", attribution: "Artist", usageScope: "commercial"}],
  })), /actual media stream/u);

  await assert.rejects(resolveVideoAssets(projectDir, input([
    {id: "private-01", kind: "music", required: true, usageIds: ["shot-06"]},
  ], {revision: 2}), adapters([[paths.sharedMusic, audio()]], {
    sharedCandidates: async () => [{id: "private-music", kind: "music", absolutePath: paths.sharedMusic, licence: "CC0", attribution: "Artist", usageScope: "commercial", private: true}],
  })), /rights-complete|actual media stream/u);

  await assert.rejects(resolveVideoAssets(projectDir, input([
    {id: "dup", kind: "music", required: false, usageIds: []},
    {id: "dup", kind: "music", required: false, usageIds: []},
  ], {revision: 3}), adapters([])), /duplicate need/i);
  assert.deepEqual((await readdir(join(projectDir, "Plans"))).filter((name) => name.startsWith("asset-plan-")), []);
});

test("rejects a candidate changed while probing and leaves no frozen asset", async () => {
  const {projectDir, paths} = await fixture();
  await assert.rejects(resolveVideoAssets(projectDir, input([
    {id: "race-01", kind: "music", required: true, usageIds: ["shot-07"]},
  ]), adapters([[paths.publicMusic, audio()]], {
    acquirePublic: async () => [{id: "race-public", kind: "music", absolutePath: paths.publicMusic, sourceUrl: "https://example.test/race.mp3", licence: "CC0", attribution: "Artist", usageScope: "commercial"}],
    probe: async () => {
      await writeFile(paths.publicMusic, "swapped-after-probe");
      return audio();
    },
  })), /changed while probing|changed while freezing/u);
  assert.deepEqual((await readdir(join(projectDir, "Assets", "Music"))).filter((name) => name.includes("race-public")), []);
  assert.deepEqual((await readdir(join(projectDir, "Plans"))).filter((name) => name.startsWith("asset-plan-")), []);
});

test("allows exactly one concurrent publication for a work-item revision", async () => {
  const {projectDir, paths} = await fixture();
  const request = input([{id: "race-02", kind: "sfx", required: true, usageIds: ["cue-04"]}]);
  const adapter = adapters([[paths.sharedMusic, audio()]], {
    sharedCandidates: async () => [{id: "single-winner", kind: "sfx", absolutePath: paths.sharedMusic, licence: "CC0", attribution: "Artist", usageScope: "commercial"}],
  });
  const results = await Promise.allSettled([resolveVideoAssets(projectDir, request, adapter), resolveVideoAssets(projectDir, request, adapter)]);
  assert.equal(results.filter(({status}) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({status}) => status === "rejected").length, 1);
  assert.equal((await readdir(join(projectDir, "Plans", "Assets", "reel"))).filter((name) => name === "asset-plan-v001.json").length, 1);
});

test("requires the configured coordinator context before resolving assets", async () => {
  const {projectDir, paths} = await fixture();
  await assert.rejects(resolveVideoAssets(projectDir, input([
    {id: "coordinator-01", kind: "music", required: true, usageIds: ["shot-08"]},
  ], {coordinatorContext: undefined}), adapters([[paths.sharedMusic, audio()]], {
    sharedCandidates: async () => [{id: "coordinator-sfx", kind: "music", absolutePath: paths.sharedMusic, licence: "CC0", attribution: "Artist", usageScope: "commercial"}],
  })), /coordinator/u);
  await assert.rejects(resolveVideoAssets(projectDir, input([
    {id: "coordinator-02", kind: "music", required: true, usageIds: ["shot-08"]},
  ], {coordinatorContext: {actorId: "asset-resolver", actorRole: "local-media-technician"}}), adapters([[paths.sharedMusic, audio()]], {
    sharedCandidates: async () => [{id: "wrong-coordinator", kind: "music", absolutePath: paths.sharedMusic, licence: "CC0", attribution: "Artist", usageScope: "commercial"}],
  })), /only coordinator/i);
});

test("keeps v001 asset plans independently scoped to their work items", async () => {
  const {projectDir, paths} = await fixture();
  const adapter = adapters([[paths.sharedMusic, audio()]], {
    sharedCandidates: async () => [{id: "scoped-sfx", kind: "sfx", absolutePath: paths.sharedMusic, licence: "CC0", attribution: "Artist", usageScope: "commercial"}],
  });
  await resolveVideoAssets(projectDir, input([{id: "scoped-a", kind: "sfx", required: true, usageIds: ["cue-a"]}], {workItemId: "work-a"}), adapter);
  await resolveVideoAssets(projectDir, input([{id: "scoped-b", kind: "sfx", required: true, usageIds: ["cue-b"]}], {workItemId: "work-b"}), adapters([[paths.sharedMusic, audio()]], {
    sharedCandidates: async () => [{id: "scoped-b-sfx", kind: "sfx", absolutePath: paths.sharedMusic, licence: "CC0", attribution: "Artist", usageScope: "commercial"}],
  }));
  assert.equal((await readFile(join(projectDir, "Plans", "Assets", "work-a", "asset-plan-v001.json"), "utf8")).includes("work-a"), true);
  assert.equal((await readFile(join(projectDir, "Plans", "Assets", "work-b", "asset-plan-v001.json"), "utf8")).includes("work-b"), true);
});

test("requires a full decode after probing and rolls back a truncated candidate", async () => {
  const {root, projectDir} = await fixture();
  const truncated = await truncatedMp3(root);
  await assert.rejects(resolveVideoAssets(projectDir, input([
    {id: "truncated-01", kind: "music", required: true, usageIds: ["shot-09"]},
  ]), {sharedCandidates: async () => [{id: "truncated-sfx", kind: "music", absolutePath: truncated, licence: "CC0", attribution: "Artist", usageScope: "commercial"}]}), /ffmpeg decode failed/u);
  assert.deepEqual((await readdir(join(projectDir, "Assets", "Music"))).filter((name) => name.includes("truncated-sfx")), []);
});

test("rejects unsafe public URLs and resolves a descriptor-safe lowercase shared library", async () => {
  const {root, projectDir, paths} = await fixture();
  await assert.rejects(resolveVideoAssets(projectDir, input([
    {id: "public-url", kind: "music", required: true, usageIds: ["shot-10"]},
  ]), adapters([[paths.publicMusic, audio()]], {
    acquirePublic: async () => [{id: "unsafe-public", kind: "music", absolutePath: paths.publicMusic, sourceUrl: "javascript:alert(1)", licence: "CC0", attribution: "Artist", usageScope: "commercial"}],
  })), /rights-complete|actual media stream/u);

  const sharedRoot = join(root, "assets");
  await mkdir(sharedRoot);
  const sharedAsset = join(sharedRoot, "workspace-only-unique.mp3");
  await writeFile(sharedAsset, "shared-library-bytes");
  const result = await resolveVideoAssets(projectDir, input([
    {id: "library-01", kind: "sfx", query: "workspace only unique", required: true, usageIds: ["cue-05"]},
  ], {revision: 2}), adapters([[sharedAsset, audio()]]));
  assert.equal(result.assetPlan.selections[0].resolutionTier, 3);
  assert.equal(result.assetPlan.selections[0].origin, "shared-library");
  assert.equal(result.assetPlan.selections[0].licence, "user-provided-local-library-rights-assertion");
  assert.equal(result.assetPlan.selections[0].usageScope, "project-only");
  assert.equal((await readManifest(projectDir)).assets.find(({id}) => id === result.assetPlan.selections[0].id).originType, "user-provided-local-library");
});
