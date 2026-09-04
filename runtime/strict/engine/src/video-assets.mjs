import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {lstat, open, readdir, realpath} from "node:fs/promises";
import {basename, dirname, extname, join, relative} from "node:path";

import {createArtifactEnvelope} from "./artifacts.mjs";
import {assertCoordinator, mutateManifest, readManifest} from "./manifest.mjs";
import {probeMedia} from "./media-probe.mjs";
import {confinedProjectPath} from "./paths.mjs";
import {copyExclusiveFile, hashFileNoFollow, makeDirectories, makeExclusiveDirectory, removeOwnedFile, removeOwnedStage, writeExclusiveFile} from "./release-fs.mjs";
import {runProcess} from "./process.mjs";
import {readFrozenBrand} from "./sunburst.mjs";

export const TIERS = Object.freeze([
  {id: 1, origin: "project"},
  {id: 2, origin: "frozen-brand-or-template"},
  {id: 3, origin: "shared-library"},
  {id: 4, origin: "rights-clear-public"},
  {id: 5, origin: "local-generation"},
]);

const AUDIO_KINDS = new Set(["music", "sfx", "voice"]);
const VIDEO_KINDS = new Set(["transition", "green-screen", "image"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const DESTINATIONS = Object.freeze({image: "Assets/Images", music: "Assets/Music", sfx: "Assets/SFX", voice: "Assets/Voice", transition: "Assets/Templates", "green-screen": "Assets/Images", template: "Assets/Templates"});
const pad = (value) => String(value).padStart(3, "0");

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value) || value === "." || value === "..") throw new Error(`${label} must be a safe identifier`);
  return value;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim();
}

function expectedMediaKind(kind) {
  if (AUDIO_KINDS.has(kind)) return "audio";
  if (VIDEO_KINDS.has(kind)) return "video";
  return null;
}

function assertNeeds(needs) {
  if (!Array.isArray(needs) || needs.length === 0) throw new Error("Asset needs are required");
  const ids = new Set();
  for (const need of needs) {
    safeId(need?.id, "Asset need id");
    if (ids.has(need.id)) throw new Error(`Duplicate need id: ${need.id}`);
    if (!nonEmpty(need.kind)) throw new Error(`Asset need ${need.id} kind is required`);
    if (need.required !== undefined && typeof need.required !== "boolean") throw new Error(`Asset need ${need.id} required must be boolean`);
    if (need.usageIds !== undefined && (!Array.isArray(need.usageIds) || new Set(need.usageIds).size !== need.usageIds.length || need.usageIds.some((id) => !SAFE_ID.test(id)))) throw new Error(`Asset need ${need.id} usage IDs must be unique safe identifiers`);
    ids.add(need.id);
  }
}

function assertCandidateIds(candidates) {
  const ids = new Set();
  for (const candidate of candidates) {
    safeId(candidate?.id, "Asset candidate id");
    if (ids.has(candidate.id)) throw new Error(`Duplicate candidate id: ${candidate.id}`);
    ids.add(candidate.id);
  }
}

function actualMedia(probed) {
  const audio = Array.isArray(probed?.audio) ? probed.audio : [];
  const video = Array.isArray(probed?.video) ? probed.video : [];
  return {
    actualKind: video.length ? "video" : audio.length ? "audio" : "unknown",
    media: {audioStreams: audio.length, videoStreams: video.length, durationSeconds: Number(probed?.durationSeconds ?? 0)},
  };
}

function rightsComplete(candidate, tier) {
  const importedSafe = !candidate.private && !candidate.client && !["private", "client"].includes(candidate.privacyClass)
    && !candidate.voiceClone && !candidate.source && candidate.kind !== "source";
  if (tier === 2) return !candidate.voiceClone && !candidate.source && candidate.kind !== "source" && (candidate.projectLocal || importedSafe);
  if (tier === 4) return importedSafe && safePublicUrl(candidate.sourceUrl)
    && nonEmpty(candidate.licence) && nonEmpty(candidate.attribution) && nonEmpty(candidate.usageScope);
  if (tier === 5) return !candidate.voiceClone && !candidate.source && candidate.kind !== "source"
    && nonEmpty(candidate.model) && nonEmpty(candidate.providerRevision) && nonEmpty(candidate.prompt);
  if (tier === 3) return importedSafe && nonEmpty(candidate.usageScope)
    && (candidate.originType === "user-provided-local-library" || (nonEmpty(candidate.licence) && nonEmpty(candidate.attribution)));
  return true;
}

function safePublicUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    if (!host || !host.includes(".") || host === "localhost" || host === "::1" || host.endsWith(".local") || host.endsWith(".internal")) return false;
    const ipv4 = host.split(".").map(Number);
    if (ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
      if (ipv4[0] === 0 || ipv4[0] === 10 || ipv4[0] === 127 || ipv4[0] >= 224 || (ipv4[0] === 169 && ipv4[1] === 254)
        || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) || (ipv4[0] === 192 && ipv4[1] === 168)) return false;
    }
    return !host.startsWith("fe80:") && !host.startsWith("fc") && !host.startsWith("fd");
  } catch {
    return false;
  }
}

async function decodeMedia(path) {
  const result = await runProcess("ffmpeg", ["-v", "error", "-xerror", "-err_detect", "explode", "-i", path, "-map", "0", "-f", "null", "-"]);
  if (result.code !== 0 || result.truncated || (result.stderr ?? "").trim()) throw new Error(`ffmpeg decode failed: ${(result.stderr ?? "").trim()}`);
}

async function externalSnapshot(path) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Asset source must be a regular non-symlink file");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Asset source must be a regular file");
    const bytes = await handle.readFile();
    const after = await lstat(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) throw new Error("Asset source path changed while freezing");
    return {bytes, sha256: createHash("sha256").update(bytes).digest("hex"), dev: info.dev, ino: info.ino, size: info.size};
  } finally {
    await handle.close();
  }
}

function candidateFromAsset(asset) {
  return {...asset, id: asset.id, kind: asset.kind, relativePath: asset.path, projectLocal: true, originalPath: asset.originalPath ?? asset.sourcePath ?? asset.path};
}

async function projectCandidates(root, manifest) {
  return Promise.all((manifest.assets ?? []).map(async (asset) => ({...candidateFromAsset(asset), absolutePath: await confinedProjectPath(root, asset.path, {type: "file"})})));
}

async function frozenCandidates(root, manifest, adapters) {
  const supplied = adapters.frozenCandidates ? await adapters.frozenCandidates() : [];
  const candidates = supplied.map((candidate) => ({...candidate}));
  for (const asset of manifest.assets ?? []) if (asset.kind === "template") candidates.push({...candidateFromAsset(asset), absolutePath: await confinedProjectPath(root, asset.path, {type: "file"})});
  if (manifest.brand) {
    const brand = await adapters.readFrozenBrand(root);
    candidates.push(...await Promise.all(brand.motifs.map(async (motif, index) => ({
      id: `brand-${index + 1}`, kind: "image", relativePath: motif.path, projectLocal: true,
      absolutePath: await confinedProjectPath(root, motif.path, {type: "file"}), sha256: motif.sha256, bytes: motif.bytes,
      templateRevision: brand.version, originalPath: motif.path,
    }))));
  }
  return candidates;
}

function queryTokens(value) {
  return String(value ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/gu, " ").trim().split(/\s+/u).filter(Boolean);
}

async function sharedLibraryCandidates(sharedRoot, needs) {
  if (!needs.some((need) => queryTokens(need.query).length)) return [];
  let root;
  try {
    root = await realpath(sharedRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (basename(root) !== "assets") throw new Error("Shared asset library must use the lowercase assets directory");
  const files = [];
  async function visit(directory) {
    const entries = (await readdir(directory, {withFileTypes: true})).toSorted((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const status = await lstat(path);
      if (status.isSymbolicLink()) throw new Error("Shared asset library cannot contain symlinks");
      if (status.isDirectory()) await visit(path);
      else if (status.isFile()) {
        const real = await realpath(path);
        if (relative(root, real).startsWith("..")) throw new Error("Shared asset library path escaped its root");
        files.push(real);
      }
    }
  }
  await visit(root);
  const candidates = [];
  for (const need of needs) {
    const tokens = queryTokens(need.query);
    if (!tokens.length) continue;
    const matches = files.filter((path) => {
      const text = queryTokens(path);
      return tokens.every((token) => text.includes(token));
    });
    for (const [index, absolutePath] of matches.entries()) candidates.push({
      id: `shared-${need.id}-${String(index + 1).padStart(3, "0")}`,
      kind: need.kind,
      absolutePath,
      originalPath: relative(root, absolutePath).split("\\").join("/"),
      originType: "user-provided-local-library",
      usageScope: "project-only",
      licence: "user-provided-local-library-rights-assertion",
      attribution: "user-managed",
    });
  }
  return candidates;
}

function sameSnapshot(left, right) {
  return left.sha256 === right.sha256 && left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

export async function chooseCandidate(need, candidates, probe) {
  for (const tier of TIERS) {
    for (const candidate of candidates.filter((entry) => entry.resolutionTier === tier.id && entry.kind === need.kind).toSorted((left, right) => left.id.localeCompare(right.id))) {
      if (!rightsComplete(candidate, tier.id)) continue;
      const {actualKind, media} = actualMedia(await probe(candidate.absolutePath));
      if (expectedMediaKind(need.kind) === actualKind) return {...candidate, resolutionTier: tier.id, origin: tier.origin, media};
    }
  }
  if (need.required) throw new Error(`No rights-complete asset with actual media stream satisfies ${need.id}`);
  return null;
}

async function chooseCandidateSafely(root, need, candidates, dependencies) {
  for (const tier of TIERS) {
    const matching = candidates.filter((candidate) => candidate.resolutionTier === tier.id && candidate.kind === need.kind).toSorted((left, right) => left.id.localeCompare(right.id));
    for (const candidate of matching) {
      if (!rightsComplete(candidate, tier.id)) continue;
      const before = tier.id === 1 ? await dependencies.hashNoFollow(root, candidate.relativePath) : await externalSnapshot(candidate.absolutePath);
      const probed = await dependencies.probe(candidate.absolutePath);
      const after = tier.id === 1 ? await dependencies.hashNoFollow(root, candidate.relativePath) : await externalSnapshot(candidate.absolutePath);
      const unchanged = tier.id === 1
        ? before.sha256 === after.sha256 && before.bytes === after.bytes && before.owner.dev === after.owner.dev && before.owner.ino === after.owner.ino
        : sameSnapshot(before, after);
      if (!unchanged) throw new Error(`Asset ${candidate.id} changed while probing`);
      const {actualKind, media} = actualMedia(probed);
      if (expectedMediaKind(need.kind) !== actualKind) continue;
      return {...candidate, resolutionTier: tier.id, origin: tier.origin, media, snapshot: tier.id === 1 ? null : before};
    }
  }
  if (need.required) throw new Error(`No rights-complete asset with actual media stream satisfies ${need.id}`);
  return null;
}

async function freezeCandidate(root, stagePath, candidate, need, dependencies, created) {
  const usageIds = need.usageIds ?? [];
  const extension = extname(candidate.absolutePath) || ".bin";
  const snapshotPath = `${stagePath}/snapshot-${candidate.id}${extension}`;
  let snapshot;
  if (candidate.resolutionTier === 1) {
    const before = await dependencies.hashNoFollow(root, candidate.relativePath);
    if (before.sha256 !== candidate.sha256 || before.bytes !== candidate.bytes) throw new Error(`Project asset ${candidate.id} changed before selection`);
    const owner = await dependencies.copyExclusiveFile(root, candidate.relativePath, snapshotPath);
    snapshot = await dependencies.hashNoFollow(root, snapshotPath);
    if (snapshot.sha256 !== before.sha256 || snapshot.bytes !== before.bytes || snapshot.owner.dev !== owner.dev || snapshot.owner.ino !== owner.ino) throw new Error(`Project asset ${candidate.id} changed while freezing`);
    const after = await dependencies.hashNoFollow(root, candidate.relativePath);
    if (before.sha256 !== after.sha256 || before.bytes !== after.bytes || before.owner.dev !== after.owner.dev || before.owner.ino !== after.owner.ino) throw new Error(`Project asset ${candidate.id} changed during selection`);
  } else {
    const external = candidate.snapshot ?? await externalSnapshot(candidate.absolutePath);
    const owner = await dependencies.writeExclusiveFile(root, snapshotPath, external.bytes);
    snapshot = await dependencies.hashNoFollow(root, snapshotPath);
    if (snapshot.sha256 !== external.sha256 || snapshot.bytes !== external.bytes.length || snapshot.owner.dev !== owner.dev || snapshot.owner.ino !== owner.ino) throw new Error(`Frozen asset ${candidate.id} changed during staging`);
  }
  const snapshotAbsolutePath = await confinedProjectPath(root, snapshotPath, {type: "file"});
  const stagedMedia = actualMedia(await dependencies.probe(snapshotAbsolutePath));
  if (stagedMedia.actualKind !== expectedMediaKind(need.kind)) throw new Error(`Asset ${candidate.id} has no actual media stream after freezing`);
  const decoded = await dependencies.decode(snapshotAbsolutePath);
  if (decoded?.code !== undefined && (decoded.code !== 0 || decoded.truncated)) throw new Error(`ffmpeg decode failed: ${(decoded.stderr ?? "").trim()}`);
  if (candidate.resolutionTier === 1) return {...candidate, path: candidate.relativePath, sha256: snapshot.sha256, bytes: snapshot.bytes, usageIds, media: stagedMedia.media};
  const directory = DESTINATIONS[need.kind] ?? DESTINATIONS.template;
  await dependencies.makeDirectories(root, directory);
  const name = `${candidate.id}-${snapshot.sha256.slice(0, 12)}${extension}`;
  const path = `${directory}/${name}`;
  const owner = await dependencies.copyExclusiveFile(root, snapshotPath, path);
  created.push({path, owner});
  const stored = await dependencies.hashNoFollow(root, path);
  if (stored.sha256 !== snapshot.sha256 || stored.bytes !== snapshot.bytes || stored.owner.dev !== owner.dev || stored.owner.ino !== owner.ino) throw new Error(`Frozen asset ${candidate.id} changed during copy`);
  const record = {
    id: candidate.id, kind: need.kind, path, sha256: stored.sha256, bytes: stored.bytes, createdAt: new Date().toISOString(),
    sourcePath: candidate.absolutePath, sourceUrl: candidate.sourceUrl ?? null, licence: candidate.licence ?? null, model: candidate.model ?? null,
    private: Boolean(candidate.private), client: Boolean(candidate.client), voiceClone: Boolean(candidate.voiceClone),
    originType: candidate.originType ?? candidate.origin, originalPath: candidate.originalPath ?? candidate.sourceUrl ?? candidate.absolutePath,
    attribution: candidate.attribution ?? null, usageScope: candidate.usageScope ?? "project-only", privacyClass: candidate.privacyClass ?? "public",
    templateRevision: candidate.templateRevision ?? null, providerRevision: candidate.providerRevision ?? null, prompt: candidate.prompt ?? null,
    derivatives: candidate.derivatives ?? [], usageIds,
  };
  return {...candidate, ...record, usageIds, media: stagedMedia.media};
}

function selection(candidate, need) {
  if (!candidate) return {needId: need.id, required: Boolean(need.required), unresolved: true, usageIds: need.usageIds ?? []};
  return {
    id: candidate.id, needId: need.id, kind: need.kind, resolutionTier: candidate.resolutionTier, origin: candidate.origin,
    path: candidate.path, sha256: candidate.sha256, bytes: candidate.bytes, originalPath: candidate.originalPath,
    sourceUrl: candidate.sourceUrl ?? null, licence: candidate.licence ?? null, attribution: candidate.attribution ?? null,
    usageScope: candidate.usageScope ?? "project-only", privacyClass: candidate.privacyClass ?? "public", client: Boolean(candidate.client),
    model: candidate.model ?? null, templateRevision: candidate.templateRevision ?? null, providerRevision: candidate.providerRevision ?? null,
    prompt: candidate.prompt ?? null, derivatives: candidate.derivatives ?? [], usageIds: candidate.usageIds, media: candidate.media,
  };
}

export async function resolveVideoAssets(projectDir, input, adapters = {}) {
  const root = await realpath(projectDir);
  const workItemId = safeId(input?.workItemId, "Work item id");
  if (!Number.isInteger(input?.revision) || input.revision < 1 || input.revision > 999) throw new Error("Asset-plan revision must be 1-999");
  assertNeeds(input.needs);
  if (!nonEmpty(input.producer?.actorId) || !nonEmpty(input.producer?.role)) throw new Error("Asset-plan producer is required");
  if (!input.coordinatorContext) throw new Error("Asset-plan coordinator context is required");
  const dependencies = {
    readManifest: adapters.readManifest ?? readManifest, readFrozenBrand: adapters.readFrozenBrand ?? readFrozenBrand, frozenCandidates: adapters.frozenCandidates, probe: adapters.probe ?? probeMedia,
    sharedCandidates: adapters.sharedCandidates ?? ((needs) => sharedLibraryCandidates(adapters.sharedRoot ?? join(dirname(dirname(root)), "assets"), needs)), acquirePublic: adapters.acquirePublic ?? (async () => []), generateLocal: adapters.generateLocal ?? (async () => []),
    hashNoFollow: adapters.hashNoFollow ?? hashFileNoFollow, makeDirectories: adapters.makeDirectories ?? makeDirectories,
    makeExclusiveDirectory: adapters.makeExclusiveDirectory ?? makeExclusiveDirectory, removeOwnedFile: adapters.removeOwnedFile ?? removeOwnedFile,
    removeOwnedStage: adapters.removeOwnedStage ?? removeOwnedStage, writeExclusiveFile: adapters.writeExclusiveFile ?? writeExclusiveFile,
    copyExclusiveFile: adapters.copyExclusiveFile ?? copyExclusiveFile, decode: adapters.decode ?? decodeMedia,
  };
  const revision = pad(input.revision);
  const lockPath = `Plans/.asset-plan-${workItemId}-v${revision}.lock`;
  const lockOwner = await dependencies.makeExclusiveDirectory(root, lockPath);
  const created = [];
  let manifestAssetIds = [];
  try {
    const manifest = await dependencies.readManifest(root);
    assertCoordinator(manifest, input.coordinatorContext);
    const project = (await projectCandidates(root, manifest)).map((candidate) => ({...candidate, resolutionTier: 1}));
    const frozen = (await frozenCandidates(root, manifest, dependencies)).map((candidate) => ({...candidate, resolutionTier: 2}));
    const shared = (await dependencies.sharedCandidates(input.needs)).map((candidate) => ({...candidate, resolutionTier: 3}));
    const publicAssets = (await dependencies.acquirePublic(input.needs)).map((candidate) => ({...candidate, resolutionTier: 4}));
    const generated = (await dependencies.generateLocal(input.needs)).map((candidate) => ({...candidate, resolutionTier: 5}));
    const candidates = [...project, ...frozen, ...shared, ...publicAssets, ...generated];
    assertCandidateIds(candidates);
    const frozenSelections = [];
    for (const need of input.needs) {
      const candidate = await chooseCandidateSafely(root, need, candidates, dependencies);
      frozenSelections.push(candidate ? await freezeCandidate(root, lockPath, candidate, need, dependencies, created) : null);
    }
    const newRecords = frozenSelections.filter((candidate) => candidate?.resolutionTier !== 1).map(({absolutePath, media, resolutionTier, origin, snapshot, ...record}) => record);
    if (newRecords.length) {
      manifestAssetIds = newRecords.map(({id}) => id);
      await mutateManifest(root, input.coordinatorContext, (next) => {
        if (newRecords.some((record) => next.assets.some(({id}) => id === record.id))) throw new Error("Asset ledger already contains a selected id");
        next.assets.push(...newRecords);
        return next;
      });
    }
    const assetPlan = {schemaVersion: 1, workItemId, revision: input.revision, selections: frozenSelections.map((candidate, index) => selection(candidate, input.needs[index]))};
    const artifact = createArtifactEnvelope({
      artifactId: `asset-plan:${workItemId}:v${revision}`, revision: input.revision, workItemId, modality: input.modality ?? "multi-clip", parents: input.parents ?? [],
      producer: input.producer, versions: input.versions ?? {tool: "content-hub@0.1.0", template: null, model: null, policy: "bizibeast-v1"},
      status: "frozen", deviations: [], payload: {kind: "asset-plan", ...assetPlan},
    });
    const path = `Plans/Assets/${workItemId}/asset-plan-v${revision}.json`;
    await dependencies.makeDirectories(root, `Plans/Assets/${workItemId}`);
    const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    const owner = await dependencies.writeExclusiveFile(root, path, bytes);
    created.push({path, owner});
    const stored = await dependencies.hashNoFollow(root, path);
    if (stored.sha256 !== createHash("sha256").update(bytes).digest("hex") || stored.bytes !== bytes.length || stored.owner.dev !== owner.dev || stored.owner.ino !== owner.ino) throw new Error("Asset-plan publication changed during write");
    return {artifact, artifactRef: {id: artifact.artifactId, sha256: stored.sha256}, assetPlan};
  } catch (error) {
    if (manifestAssetIds.length) await mutateManifest(root, input.coordinatorContext, (next) => {
      next.assets = next.assets.filter(({id}) => !manifestAssetIds.includes(id));
      return next;
    });
    await Promise.all(created.reverse().map(({path, owner}) => dependencies.removeOwnedFile(root, path, owner)));
    throw error;
  } finally {
    await dependencies.removeOwnedStage(root, lockPath, lockOwner);
  }
}
