import assert from "node:assert/strict";
import {mkdtemp, readFile, readdir, rename, stat, symlink, utimes, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {sha256File} from "../src/checksum.mjs";
import {mutateManifest} from "../src/manifest.mjs";
import {createProject} from "../src/project.mjs";
import {createMediaIndex, orderVideoSources} from "../src/video-media-index.mjs";

const coordinator = {actorId: "content-hub-coordinator", actorRole: "coordinator"};
const hash = (value) => sha256File(value);

function source(name, values = {}) {
  return {
    id: values.id ?? `source-${name}`,
    path: `Source/${name}`,
    sha256: values.sha256 ?? "a".repeat(64),
    bytes: values.bytes ?? 1,
    ...values,
  };
}

const media = (overrides = {}) => ({
  durationSeconds: 1.25,
  formatName: "mov,mp4,m4a,3gp,3g2,mj2",
  video: [{codec_name: "h264", width: 1080, height: 1920, avg_frame_rate: "30/1"}],
  audio: [{codec_name: "aac", sample_rate: "48000", channels: 2}],
  raw: {format: {tags: {creation_time: "2026-09-01T10:00:00Z"}}, streams: []},
  ...overrides,
});

test("orders by the strongest available evidence and records disagreement", () => {
  const ordered = orderVideoSources([
    source("clip-02.mov", {embeddedCreatedAt: "2026-09-01T10:00:00Z", mtimeMs: 10}),
    source("clip-01.mov", {embeddedCreatedAt: "2026-09-01T11:00:00Z", mtimeMs: 20}),
  ]);
  assert.deepEqual(ordered.map(({path}) => path), ["Source/clip-01.mov", "Source/clip-02.mov"]);
  assert.equal(ordered[0].orderEvidence.method, "filename-ordinal");
  assert.equal(ordered[0].orderEvidence.confidence, 0.9);
  assert.ok(ordered[0].orderEvidence.conflicts.some(({method}) => method === "embedded-timestamp"));
});

test("explicit user order wins and must mention each source exactly once", () => {
  const sources = [source("clip-03.mov"), source("clip-02.mov"), source("clip-01.mov")];
  assert.deepEqual(
    orderVideoSources(sources, {explicitOrder: [sources[2].id, sources[0].id, sources[1].id]}).map(({id}) => id),
    [sources[2].id, sources[0].id, sources[1].id],
  );
  assert.throws(() => orderVideoSources(sources, {explicitOrder: [sources[0].id]}), /every source exactly once/u);
});

test("uses every evidence method in strict precedence order", () => {
  const cases = [
    ["explicit", [source("clip-02.mov"), source("clip-01.mov")], {explicitOrder: ["source-clip-02.mov", "source-clip-01.mov"]}, 1],
    ["filename-ordinal", [source("clip-02.mov"), source("clip-01.mov")], {}, 0.9],
    ["filename-timestamp", [source("clip-20260902.mov"), source("clip-20260901.mov")], {}, 0.85],
    ["embedded-timestamp", [source("left.mov", {embeddedCreatedAt: "2026-09-02T00:00:00Z"}), source("right.mov", {embeddedCreatedAt: "2026-09-01T00:00:00Z"})], {}, 0.75],
    ["mtime", [source("left.mov", {mtimeMs: 2}), source("right.mov", {mtimeMs: 1})], {}, 0.4],
    ["ingest-order", [source("left.mov"), source("right.mov")], {}, 0.2],
  ];
  for (const [method, sources, options, confidence] of cases) {
    const ordered = orderVideoSources(sources, options);
    assert.equal(ordered[0].orderEvidence.method, method);
    assert.equal(ordered[0].orderEvidence.confidence, confidence);
  }
});

test("breaks equal evidence ties by path and rejects invalid timestamps", () => {
  const ordered = orderVideoSources([source("z/clip-01.mov"), source("a/clip-01.mov")]);
  assert.deepEqual(ordered.map(({path}) => path), ["Source/a/clip-01.mov", "Source/z/clip-01.mov"]);
  assert.throws(() => orderVideoSources([source("clip.mov", {embeddedCreatedAt: "not-a-time"})]), /timestamp/u);
});

test("does not report equal lower-confidence evidence as a conflict", () => {
  const ordered = orderVideoSources([
    source("clip-01.mov", {embeddedCreatedAt: "2026-09-01T10:00:00Z"}),
    source("clip-02.mov", {embeddedCreatedAt: "2026-09-01T10:00:00Z"}),
  ]);
  assert.deepEqual(ordered[0].orderEvidence.conflicts, []);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "content-hub-media-index-"));
  const {projectDir} = await createProject(root, {name: "Media index", editors: ["premiere"]});
  const paths = [join(projectDir, "Source", "clip-02.mov"), join(projectDir, "Source", "clip-01.mov")];
  await Promise.all(paths.map((path, index) => writeFile(path, `fixture-${index}`)));
  const sources = await Promise.all(paths.map(async (path, index) => ({
    id: `source-${index + 1}`,
    kind: "source",
    path: `Source/clip-0${2 - index}.mov`,
    sha256: await hash(path),
    bytes: (await stat(path)).size,
    createdAt: "2026-09-01T00:00:00Z",
  })));
  await mutateManifest(projectDir, coordinator, (manifest) => {
    manifest.sources = sources;
    return manifest;
  });
  return {projectDir, sources, paths};
}

function input(workItemId = "raw-001", revision = 1) {
  return {
    workItemId,
    revision,
    modality: "multi-clip",
    producer: {actorId: "media-01", role: "local-media-technician"},
    versions: {tool: "content-hub@0.2.0", template: null, model: null, policy: "bizibeast-v1"},
    parents: [{artifactId: "brief-001", sha256: "b".repeat(64)}],
  };
}

test("indexes current video sources into one immutable provenance artifact", async () => {
  const {projectDir, sources} = await fixture();
  const result = await createMediaIndex(projectDir, input(), {probe: async () => media()});

  assert.equal(result.artifact.payload.kind, "media-index");
  assert.equal(result.artifact.parents[0].artifactId, "brief-001");
  assert.deepEqual(result.index.sources.map(({id}) => id), [sources[1].id, sources[0].id]);
  assert.deepEqual(result.index.sources[0].video[0], {codecName: "h264", width: 1080, height: 1920, avgFrameRate: "30/1"});
  assert.deepEqual(result.index.sources[0].audio[0], {codecName: "aac", sampleRate: 48000, channels: 2});
  assert.match(result.artifactRef.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.parse(await readFile(join(projectDir, "Plans", "MediaIndex", "raw-001", "media-index-v001.json"), "utf8")).artifactId, result.artifact.artifactId);
});

test("uses verified original mtimes rather than snapshot copy order", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-hub-media-index-mtime-"));
  const {projectDir} = await createProject(root, {name: "Media mtime", editors: ["premiere"]});
  const later = join(projectDir, "Source", "later.mov");
  const earlier = join(projectDir, "Source", "earlier.mov");
  await Promise.all([writeFile(later, "later"), writeFile(earlier, "earlier")]);
  await Promise.all([utimes(later, 2, 2), utimes(earlier, 1, 1)]);
  const sources = await Promise.all([later, earlier].map(async (path, index) => ({
    id: `mtime-${index + 1}`,
    kind: "source",
    path: `Source/${index === 0 ? "later" : "earlier"}.mov`,
    sha256: await hash(path),
    bytes: (await stat(path)).size,
    createdAt: "2026-09-01T00:00:00Z",
  })));
  await mutateManifest(projectDir, coordinator, (manifest) => {
    manifest.sources = sources;
    return manifest;
  });

  const result = await createMediaIndex(projectDir, input(), {probe: async () => media({raw: {format: {tags: {}}, streams: []}})});
  assert.deepEqual(result.index.sources.map(({id}) => id), ["mtime-2", "mtime-1"]);
  assert.equal(result.index.sources[0].orderEvidence.method, "mtime");
  assert.equal(result.index.sources[0].mtimeMs, 1000);
  assert.equal(result.index.sources[1].mtimeMs, 2000);
});

test("rejects malformed probe numbers, FPS, and impossible embedded dates", async () => {
  const cases = [
    [media({durationSeconds: "1.25"}), /duration/u],
    [media({video: [{codec_name: "h264", width: "1080", height: 1920, avg_frame_rate: "30/1"}]}), /video/ui],
    [media({video: [{codec_name: "h264", width: 1080, height: 1920, avg_frame_rate: "30/0"}]}), /video/ui],
    [media({audio: [{codec_name: "aac", sample_rate: "48000", channels: 0}]}), /audio/ui],
    [media({raw: {format: {tags: {creation_time: "2026-02-31T10:00:00Z"}}, streams: []}}), /timestamp/u],
  ];
  for (const [probed, error] of cases) {
    const {projectDir} = await fixture();
    await assert.rejects(createMediaIndex(projectDir, input(), {probe: async () => probed}), error);
  }
});

test("rejects unsafe manifest bytes and revisions before indexing", async () => {
  assert.throws(() => orderVideoSources([source("clip.mov", {bytes: ""})]), /byte size/u);
  const {projectDir} = await fixture();
  await assert.rejects(createMediaIndex(projectDir, input("raw-001", 1000), {probe: async () => media()}), /1.*999/u);
});

test("fails closed for changed, non-video, symlinked, or escaped sources", async () => {
  const changed = await fixture();
  await writeFile(changed.paths[0], "changed");
  await assert.rejects(createMediaIndex(changed.projectDir, input(), {probe: async () => media()}), /checksum|changed/u);

  const noVideo = await fixture();
  await assert.rejects(createMediaIndex(noVideo.projectDir, input(), {probe: async () => media({video: []})}), /video stream/u);

  const linked = await fixture();
  const outside = join((await mkdtemp(join(tmpdir(), "content-hub-media-index-outside-"))), "clip.mov");
  await writeFile(outside, "outside");
  await rename(linked.paths[0], `${linked.paths[0]}.real`);
  await symlink(outside, linked.paths[0]);
  await assert.rejects(createMediaIndex(linked.projectDir, input(), {probe: async () => media()}), /symlink|project path/u);

  const escaped = await fixture();
  await mutateManifest(escaped.projectDir, coordinator, (manifest) => {
    manifest.sources[0].path = "../outside.mov";
    return manifest;
  });
  await assert.rejects(createMediaIndex(escaped.projectDir, input(), {probe: async () => media()}), /confined|project path/u);
});

test("probes an invocation-owned snapshot and rejects source mutation after probing", async () => {
  const {projectDir, paths} = await fixture();
  let observedPath;
  await assert.rejects(createMediaIndex(projectDir, input(), {
    probe: async (path) => {
      observedPath ??= path;
      if (path === observedPath) await writeFile(paths[0], "caller-replaced");
      return media();
    },
  }), /source.*changed|checksum/u);
  assert.notEqual(observedPath, paths[0]);
  assert.deepEqual((await readdir(join(projectDir, "Plans"))).filter((name) => name.startsWith(".media-index-")), []);
});

test("rechecks every source before publication when a later probe mutates an earlier source", async () => {
  const {projectDir, paths} = await fixture();
  let probeCount = 0;
  await assert.rejects(createMediaIndex(projectDir, input(), {
    probe: async () => {
      probeCount += 1;
      if (probeCount === 2) await writeFile(paths[0], "source-a-mutated-during-source-b-probe");
      return media();
    },
  }), /source.*changed|checksum/u);
  await assert.rejects(readFile(join(projectDir, "Plans", "MediaIndex", "raw-001", "media-index-v001.json")), {code: "ENOENT"});
  assert.deepEqual((await readdir(join(projectDir, "Plans"))).filter((name) => name.startsWith(".media-index-")), []);
});

test("rejects a symlink swap of its snapshot and cleans only its owned stage", async () => {
  const {projectDir} = await fixture();
  let swapped = false;
  await assert.rejects(createMediaIndex(projectDir, input(), {
    probe: async (path) => {
      if (!swapped) {
        swapped = true;
        await rename(path, `${path}.real`);
        await symlink(`${path}.real`, path);
      }
      return media();
    },
  }), /symlink|no-follow|hash/u);
  assert.deepEqual((await readdir(join(projectDir, "Plans"))).filter((name) => name.startsWith(".media-index-")), []);
});

test("publishes v001 independently for two work items", async () => {
  const {projectDir} = await fixture();
  const first = await createMediaIndex(projectDir, input("raw-001"), {probe: async () => media()});
  const second = await createMediaIndex(projectDir, input("multi-002"), {probe: async () => media()});
  assert.notEqual(first.artifactRef.sha256, second.artifactRef.sha256);
  assert.equal(first.artifact.workItemId, "raw-001");
  assert.equal(second.artifact.workItemId, "multi-002");
  assert.equal(JSON.parse(await readFile(join(projectDir, "Plans", "MediaIndex", "multi-002", "media-index-v001.json"), "utf8")).artifactId, second.artifact.artifactId);
});
