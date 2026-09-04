import {createHash, randomUUID} from "node:crypto";
import {lstat, mkdir, mkdtemp, readdir, readFile, realpath, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, extname, isAbsolute, join, relative, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";

import {findCurrentApproval, readApprovals} from "./approvals.mjs";
import {createArtifactEnvelope, validateArtifactEnvelope} from "./artifacts.mjs";
import {freezeCandidateBundle, getCandidateBundleOwner, verifyCandidateBundle} from "./candidates.mjs";
import {canonicalJson, sha256Value} from "./checksum.mjs";
import {readManifest} from "./manifest.mjs";
import {runProcess} from "./process.mjs";
import {resolveTechnicalProfile} from "./qc-profiles.mjs";
import {
  acquireProjectLock,
  copyExclusiveFile,
  hashFileNoFollow,
  makeDirectories,
  makeExclusiveDirectory,
  readFileNoFollow,
  removeOwnedFile,
  removeOwnedStage,
  writeExclusiveFile,
} from "./release-fs.mjs";
import {getWorkItem, readWorkflowState} from "./workflow.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const BIZIBEAST_ARTIFACT_PREFIXES = new Set([
  "asset-plan", "candidate", "caption-plan", "foreground-sidecar", "media-index", "narration", "narration-transcript",
  "premiere-readback", "script", "source-transcript", "story-plan", "subject-map", "video-design-plan", "video-execution-plan",
]);
const PACK_ROOT = fileURLToPath(new URL("../../../../templates/hyperframes/", import.meta.url));
const RUNNER = fileURLToPath(new URL("../scripts/video/render-hyperframes.sh", import.meta.url));
const LAYERED_COMPOSITION = "compositions/video-shot-layered-portrait.html";
const PACK_DEPENDENCY_PATHS = Object.freeze([
  LAYERED_COMPOSITION,
  "hyperframes.json",
  "assets/sunburst.css",
  "assets/fonts/Archivo.ttf",
  "assets/fonts/Fraunces.ttf",
]);
const VIDEO_TRACKS = Object.freeze([
  {index: 1, role: "background-plate"},
  {index: 2, role: "text-graphics"},
  {index: 3, role: "foreground-subject"},
  {index: 4, role: "designed-captions"},
]);
const AUDIO_TRACKS = Object.freeze([
  {index: 1, role: "dialogue-or-narration"},
  {index: 2, role: "bgm"},
  {index: 3, role: "sfx"},
]);
const PREMIERE_ACTIONS = Object.freeze([
  "create-or-duplicate-sequence",
  "import-frozen-media",
  "apply-source-ranges",
  "apply-story-silence-handles",
  "import-verified-hyperframes-sidecars",
  "assemble-v1-v4-and-a1-a3",
  "import-native-caption-track",
  "read-back-focused-mutations",
  "export-candidate-master",
]);

const pad = (value) => String(value).padStart(3, "0");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function id(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value) || value === "." || value === "..") throw new Error(`${label} must be a safe identifier`);
  return value;
}

function referenceId(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
    || value.includes("::") || (value.includes(":") && !BIZIBEAST_ARTIFACT_PREFIXES.has(value.split(":", 1)[0]))) {
    throw new Error(`${label} must use a documented BiziBeast artifact ID`);
  }
  return value;
}

function hash(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 hash`);
  return value;
}

function revision(value) {
  if (!Number.isInteger(value) || value < 1 || value > 999) throw new Error("Video execution revision must be 1-999");
  return value;
}

function relativePath(value, label, prefixes) {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\")
    || value.split("/").some((part) => !part || part === "." || part === "..")
    || (prefixes && !prefixes.some((prefix) => value.startsWith(prefix)))) {
    throw new Error(`${label} must be a confined project-relative path`);
  }
  return value;
}

function artifactRef(value, label) {
  const artifactId = referenceId(value?.artifactId ?? value?.id, `${label} id`);
  return {artifactId, sha256: hash(value?.sha256, `${label} hash`)};
}

function sameOwner(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function sameSnapshot(left, right) {
  const leftBytes = Buffer.isBuffer(left.bytes) ? left.bytes.length : left.bytes ?? left.size;
  const rightBytes = Buffer.isBuffer(right.bytes) ? right.bytes.length : right.bytes ?? right.size;
  return left.sha256 === right.sha256 && leftBytes === rightBytes && sameOwner(left.owner, right.owner);
}

async function readBound(root, path, dependencies, label) {
  relativePath(path, label);
  const [contents, descriptor] = await Promise.all([
    dependencies.readFileNoFollow(root, path),
    dependencies.hashFileNoFollow(root, path),
  ]);
  if (!sameOwner(contents.owner, descriptor.owner) || descriptor.bytes !== contents.bytes.length || descriptor.sha256 !== digest(contents.bytes)) {
    throw new Error(`${label} changed while reading`);
  }
  return {bytes: contents.bytes, owner: contents.owner, sha256: descriptor.sha256, size: descriptor.bytes};
}

function parseArtifact(snapshot, expected, label) {
  let artifact;
  try {
    artifact = JSON.parse(snapshot.bytes.toString("utf8"));
    validateArtifactEnvelope(artifact);
  } catch {
    throw new Error(`${label} is not a valid immutable artifact`);
  }
  if (artifact.artifactId !== expected.artifactId || snapshot.sha256 !== expected.sha256) throw new Error(`${label} exact hash does not match`);
  return artifact;
}

async function findArtifacts(root, refs, dependencies) {
  const wanted = new Map(refs.map((ref) => [ref.artifactId, ref]));
  const found = new Map();
  async function visit(path) {
    const entries = await readdir(`${root}/${path}`, {withFileTypes: true});
    for (const entry of entries) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        const snapshot = await readBound(root, child, dependencies, `Artifact ${child}`);
        let value;
        try {
          value = JSON.parse(snapshot.bytes.toString("utf8"));
        } catch {
          continue;
        }
        const expected = wanted.get(value?.artifactId);
        if (!expected) continue;
        validateArtifactEnvelope(value);
        if (snapshot.sha256 !== expected.sha256 || found.has(expected.artifactId)) throw new Error(`Locked artifact unavailable or duplicated: ${expected.artifactId}`);
        found.set(expected.artifactId, {artifact: value, snapshot, path: child});
      }
    }
  }
  await visit("Plans");
  for (const ref of refs) if (!found.has(ref.artifactId)) throw new Error(`Locked artifact unavailable: ${ref.artifactId}`);
  return found;
}

function normalizeInputLock(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson(["approvals", "artifacts", "assets"])) {
    throw new Error("Video execution input lock requires only artifacts, approvals, and assets");
  }
  const normalize = (entries, hashKey, label) => {
    if (!Array.isArray(entries)) throw new Error(`Video execution input lock ${label} must be an array`);
    const seen = new Set();
    return entries.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)
        || canonicalJson(Object.keys(entry).sort()) !== canonicalJson([hashKey, "id"].sort())) throw new Error(`${label} lock has an invalid shape`);
      const key = label === "Artifact" ? referenceId(entry.id, `${label} lock id`) : id(entry.id, `${label} lock id`);
      if (seen.has(key)) throw new Error(`${label} locks must have unique ids`);
      seen.add(key);
      return {id: key, [hashKey]: hash(entry[hashKey], `${label} lock hash`)};
    });
  };
  return {
    artifacts: normalize(value.artifacts, "sha256", "Artifact"),
    approvals: normalize(value.approvals, "subjectSha256", "Approval"),
    assets: normalize(value.assets, "sha256", "Asset"),
  };
}

function dependenciesFor(adapters = {}) {
  return {
    acquireProjectLock: adapters.acquireProjectLock ?? acquireProjectLock,
    copyExclusiveFile: adapters.copyExclusiveFile ?? copyExclusiveFile,
    freezeCandidateBundle: adapters.freezeCandidateBundle ?? freezeCandidateBundle,
    getCandidateBundleOwner: adapters.getCandidateBundleOwner ?? getCandidateBundleOwner,
    verifyCandidateBundle: adapters.verifyCandidateBundle ?? verifyCandidateBundle,
    hashFileNoFollow: adapters.hashFileNoFollow ?? hashFileNoFollow,
    makeDirectories: adapters.makeDirectories ?? makeDirectories,
    makeExclusiveDirectory: adapters.makeExclusiveDirectory ?? makeExclusiveDirectory,
    packRoot: adapters.packRoot ?? PACK_ROOT,
    readApprovals: adapters.readApprovals ?? readApprovals,
    readFileNoFollow: adapters.readFileNoFollow ?? readFileNoFollow,
    readManifest: adapters.readManifest ?? readManifest,
    readPackFile: adapters.readPackFile ?? readFile,
    readWorkflowState: adapters.readWorkflowState ?? readWorkflowState,
    removeOwnedFile: adapters.removeOwnedFile ?? removeOwnedFile,
    removeOwnedStage: adapters.removeOwnedStage ?? removeOwnedStage,
    run: adapters.run ?? runProcess,
    writeExclusiveFile: adapters.writeExclusiveFile ?? writeExclusiveFile,
  };
}

async function packDependencyClosure(dependencies) {
  const closure = [];
  for (const path of PACK_DEPENDENCY_PATHS) {
    const absolute = resolve(dependencies.packRoot, path);
    const confined = relative(dependencies.packRoot, absolute);
    if (confined === ".." || confined.startsWith(`..${sep}`) || isAbsolute(confined) || (await lstat(absolute)).isSymbolicLink()) {
      throw new Error("HyperFrames dependency closure escaped the trusted pack");
    }
    const bytes = await dependencies.readPackFile(absolute);
    closure.push({path, sha256: digest(bytes), bytes: bytes.length});
  }
  return closure;
}

async function recheckPackDependencyClosure(expected, dependencies) {
  const current = await packDependencyClosure(dependencies);
  if (canonicalJson(current) !== canonicalJson(expected)) throw new Error("HyperFrames dependency closure changed");
}

async function createPackSnapshot(expected, dependencies) {
  const root = await mkdtemp(join(tmpdir(), "content-hub-hf-pack-"));
  // ponytail: template-only snapshots contain no project/private media; let OS temp or a separately reviewed GC reclaim them only if measured disk growth warrants it.
  for (const dependency of expected) {
    const bytes = await dependencies.readPackFile(resolve(dependencies.packRoot, dependency.path));
    if (bytes.length !== dependency.bytes || digest(bytes) !== dependency.sha256) throw new Error(`HyperFrames dependency changed before snapshot: ${dependency.path}`);
    const target = resolve(root, dependency.path);
    await mkdir(dirname(target), {recursive: true});
    await writeFile(target, bytes, {flag: "wx", mode: 0o600});
    if (digest(await readFile(target)) !== dependency.sha256) throw new Error(`HyperFrames snapshot verification failed: ${dependency.path}`);
  }
  const composition = await readFile(resolve(root, LAYERED_COMPOSITION));
  await writeFile(resolve(root, "index.html"), composition, {flag: "wx", mode: 0o600});
  await writeFile(resolve(root, ".content-hub-pack-snapshot.json"), `${JSON.stringify({schemaVersion: 1, closure: expected}, null, 2)}\n`, {flag: "wx", mode: 0o600});
  return {root};
}

async function workflow(root, workItemId, expectedRevision, modality, states, dependencies, evidenceRef) {
  const state = await dependencies.readWorkflowState(root);
  const item = getWorkItem(state, workItemId);
  if (item.revision !== expectedRevision || item.modality !== modality || !states.includes(item.state)) throw new Error(`Video execution workflow must be ${states.join(" or ")}`);
  if (evidenceRef) {
    const event = state.events.findLast((candidate) => candidate.workItemId === workItemId && candidate.to === "DESIGN_APPROVED");
    if (event?.artifactRef?.id !== evidenceRef.artifactId || event.artifactRef.sha256 !== evidenceRef.sha256) throw new Error("DESIGN_APPROVED is not bound to the exact current design plan");
  }
  return item;
}

async function currentDesignApproval(root, manifest, workItemId, designRef, approvalRef, inputLock, dependencies) {
  id(approvalRef?.id, "Design approval id");
  hash(approvalRef?.subjectSha256, "Design approval subject hash");
  const approvals = await dependencies.readApprovals(root);
  const approval = approvals.find((entry) => entry.id === approvalRef.id);
  const current = findCurrentApproval(approvals, {
    kind: "design", workItemId, artifactId: designRef.artifactId, sha256: designRef.sha256,
    policyVersion: manifest.orchestration.policyVersion,
  });
  if (approval?.id !== current?.id || approval.subject.sha256 !== approvalRef.subjectSha256 || approvalRef.subjectSha256 !== designRef.sha256
    || approval.origin !== "bizibeast" || approval.approver?.role !== "design-approver"
    || !inputLock.approvals.some(({id: lockId, subjectSha256}) => lockId === approval.id && subjectSha256 === designRef.sha256)) {
    throw new Error("Video execution requires the current exact-hash approved design plan");
  }
  return approval;
}

function exactProfile(input, manifest) {
  const supplied = input.technicalProfile;
  if (!supplied?.id) throw new Error("Video execution requires an exact technical profile");
  const expected = resolveTechnicalProfile(supplied.id, input.profileContext);
  if (canonicalJson(supplied) !== canonicalJson(expected)) throw new Error("Video execution technical profile is stale or forged");
  const fps = expected.video?.fpsNumerator / expected.video?.fpsDenominator;
  if (!expected.video?.width || !expected.video?.height || manifest.format.width !== expected.video.width
    || manifest.format.height !== expected.video.height || manifest.format.fps !== fps) throw new Error("Video execution profile does not match frozen project format");
  if (expected.video.width !== 1080 || expected.video.height !== 1920) throw new Error("Layered HyperFrames execution requires 1080x1920 portrait profile");
  return expected;
}

async function verifyLocalFile(root, value, dependencies, label) {
  const file = {
    id: id(value.id, `${label} id`),
    path: relativePath(value.path, `${label} path`, ["Source/", "Assets/", "Renders/Captions/", "Renders/Foreground/", "Renders/Shots/"]),
    sha256: hash(value.sha256, `${label} hash`),
    ...(value.bytes === undefined ? {} : {bytes: value.bytes}),
  };
  if (file.bytes !== undefined && (!Number.isSafeInteger(file.bytes) || file.bytes < 1)) throw new Error(`${label} bytes must be positive`);
  const snapshot = await readBound(root, file.path, dependencies, label);
  if (snapshot.sha256 !== file.sha256 || (file.bytes !== undefined && snapshot.size !== file.bytes)) throw new Error(`${label} frozen bytes changed`);
  return {...file, bytes: snapshot.size};
}

function fileRecords(artifacts) {
  const records = [];
  const add = (value, fallbackId) => {
    if (value?.path && value?.sha256) records.push({id: value.id ?? fallbackId, path: value.path, sha256: value.sha256, bytes: value.bytes});
  };
  for (const {artifact} of artifacts.values()) {
    const payload = artifact.payload;
    if (payload?.kind === "asset-plan") for (const item of payload.selections ?? []) add(item, item.id);
    if (payload?.kind === "caption-plan") for (const [name, item] of Object.entries(payload.files ?? {})) add(item, `captions-${name}`);
    if (payload?.kind === "foreground-sidecar") add(payload.output, `foreground-${payload.source?.id}`);
    if (payload?.kind === "subject-map") {
      for (const frame of payload.frames ?? []) add(frame.matte, `matte-${payload.sourceId}-${frame.index}`);
    }
  }
  return records;
}

async function frozenFiles(root, input, artifacts, manifest, dependencies) {
  const requested = [...(input.sourceImports ?? []), ...fileRecords(artifacts)];
  if (manifest.brand) {
    const brand = await readBound(root, manifest.brand.lockPath, dependencies, "Frozen brand lock");
    if (brand.sha256 !== manifest.brand.lockSha256) throw new Error("Frozen brand lock changed");
    let lock;
    try { lock = JSON.parse(brand.bytes.toString("utf8")); } catch { throw new Error("Frozen brand lock is malformed"); }
    for (const [index, font] of (lock.fonts ?? []).entries()) requested.push({id: `brand-font-${index + 1}`, path: font.path, sha256: font.sha256});
  }
  const byPath = new Map();
  for (const value of requested) {
    if (!value?.path || !value?.sha256) continue;
    const normalized = await verifyLocalFile(root, value, dependencies, `Frozen import ${value.id ?? value.path}`);
    const previous = byPath.get(normalized.path);
    if (previous && previous.sha256 !== normalized.sha256) throw new Error(`Frozen import path has conflicting hashes: ${normalized.path}`);
    byPath.set(normalized.path, normalized);
  }
  const sourceIds = new Set(input.designPlan.shots.map(({source}) => source.sourceId));
  const suppliedSourceIds = new Set((input.sourceImports ?? []).map(({id: sourceId}) => sourceId));
  if (sourceIds.size !== suppliedSourceIds.size || [...sourceIds].some((sourceId) => !suppliedSourceIds.has(sourceId))) throw new Error("Source imports must exactly cover approved design shot sources");
  for (const shot of input.designPlan.shots) {
    const source = input.sourceImports.find(({id: sourceId}) => sourceId === shot.source.sourceId);
    if (source.sha256 !== shot.source.sourceSha256) throw new Error(`Source import hash changed from approved shot: ${shot.id}`);
  }
  return [...byPath.values()].toSorted((left, right) => left.path.localeCompare(right.path));
}

function captionVariables(artifacts, captionSource, shot) {
  const caption = [...artifacts.values()].find(({artifact}) => artifact.payload?.kind === "caption-plan")?.artifact.payload;
  if (!caption) throw new Error("Approved design requires a current caption-plan parent");
  const cueIds = new Set(shot.captions?.cueIds ?? []);
  const cues = (caption.cues ?? []).filter(({cueId}) => cueIds.has(cueId));
  if (cues.length !== cueIds.size) throw new Error(`Shot ${shot.id} caption cues changed from approved design`);
  const durationSeconds = (shot.timeline.outMs - shot.timeline.inMs) / 1000;
  const segments = (captionSource.bundle.segments ?? []).filter(({shotId}) => shotId === shot.id).map((segment) => ({
    ...structuredClone(segment),
    start: segment.start - shot.timeline.inMs / 1000,
    end: segment.end - shot.timeline.inMs / 1000,
    words: (segment.words ?? []).map((word) => ({...structuredClone(word), start: word.start - shot.timeline.inMs / 1000, end: word.end - shot.timeline.inMs / 1000})),
  }));
  if (segments.length !== cues.length || segments.some((segment, index) => segment.start !== (cues[index].startMs - shot.timeline.inMs) / 1000
    || segment.end !== (cues[index].endMs - shot.timeline.inMs) / 1000)) throw new Error(`Shot ${shot.id} canonical caption bytes changed from approved cue timings`);
  return {captions: JSON.stringify({...captionSource.bundle, segments, durationSeconds}), style: shot.captions.identity, durationSeconds};
}

async function readCaptionSource(root, artifacts, dependencies) {
  const caption = [...artifacts.values()].find(({artifact}) => artifact.payload?.kind === "caption-plan")?.artifact.payload;
  const file = caption?.files?.hyperframes;
  if (!file?.path || !file.sha256) throw new Error("Approved caption plan requires frozen HyperFrames variables");
  const saved = await readBound(root, file.path, dependencies, "Frozen HyperFrames captions");
  if (saved.sha256 !== file.sha256 || (file.bytes !== undefined && saved.size !== file.bytes)) throw new Error("Frozen HyperFrames captions changed");
  let variables;
  try { variables = JSON.parse(saved.bytes.toString("utf8")); } catch { throw new Error("Frozen HyperFrames captions are malformed"); }
  let bundle;
  try { bundle = JSON.parse(variables.captions); } catch { throw new Error("Frozen HyperFrames canonical captions are malformed"); }
  if (!Array.isArray(bundle.segments)) throw new Error("Frozen HyperFrames canonical captions require segments");
  return {bundle, variables};
}

async function renderAssetPayloads(root, designPlan, files, dependencies) {
  const byId = new Map(files.map((file) => [file.id, file]));
  const payloads = new Map();
  for (const asset of designPlan.shots.flatMap((shot) => shot.assets ?? [])) {
    if (payloads.has(asset.assetId)) continue;
    const file = byId.get(asset.assetId);
    if (!file || file.sha256 !== asset.sha256) throw new Error(`Approved render asset is not frozen locally: ${asset.assetId}`);
    const saved = await readBound(root, file.path, dependencies, `Approved render asset ${asset.assetId}`);
    const mime = new Map([[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".webp", "image/webp"], [".gif", "image/gif"]]).get(extname(file.path).toLowerCase());
    if (!mime) throw new Error(`Approved render asset must be a supported image: ${asset.assetId}`);
    payloads.set(asset.assetId, {...file, mime, dataUrl: `data:${mime};base64,${saved.bytes.toString("base64")}`});
  }
  return payloads;
}

function hyperFramesJobs(input, artifacts, captionSource, renderAssets, profile, compositionSha256) {
  const version = pad(input.revision);
  return input.designPlan.shots.flatMap((shot) => {
    const layers = (shot.onScreenCopy?.layers ?? []).filter(({owner}) => owner?.role === "hyperframes-executor" && owner.editor === "hyperframes");
    if (!layers.length) return [];
    const durationMs = shot.timeline.outMs - shot.timeline.inMs;
    const captions = captionVariables(artifacts, captionSource, shot);
    const graphics = layers.filter(({role}) => ["back", "foreground"].includes(role));
    const captionLayers = layers.filter(({role}) => role === "caption");
    return [["graphics", graphics, 2], ["captions", captionLayers, 4]].flatMap(([kind, assigned, trackIndex]) => {
      if (!assigned.length) return [];
      const captionBundle = JSON.parse(captions.captions);
      const text = captionBundle.segments.map((segment) => segment.text).filter(Boolean);
      const relativeLayers = assigned.map((layer) => {
        const roleIndex = layer.role === "back" ? 0 : 1;
        const approvedAsset = layer.role === "caption" ? null : shot.assets?.[roleIndex] ?? null;
        const asset = approvedAsset ? renderAssets.get(approvedAsset.assetId) : null;
        const geometry = layer.role === "back" ? {x: 68, y: 130, width: 944, height: 330}
          : layer.role === "caption" ? {x: 72, y: 1460, width: 936, height: 280}
            : {x: 582, y: 1228, width: 430, height: 172};
        return {...structuredClone(layer), inMs: layer.inMs - shot.timeline.inMs, outMs: layer.outMs - shot.timeline.inMs,
          content: {text: text[roleIndex] ?? text[0] ?? "", asset: asset ? {id: approvedAsset.assetId, kind: approvedAsset.kind,
            path: asset.path, sha256: asset.sha256, mime: asset.mime, dataUrl: asset.dataUrl} : null}, geometry};
      });
      const variables = {
        backLayer: JSON.stringify({layers: relativeLayers.filter(({role}) => role === "back")}),
        foregroundLayer: JSON.stringify({layers: relativeLayers.filter(({role}) => role === "foreground")}),
        captions: kind === "captions" ? captions.captions : JSON.stringify({...captionBundle, segments: []}),
        style: captions.style,
        durationSeconds: captions.durationSeconds,
        showBack: kind === "graphics" && relativeLayers.some(({role}) => role === "back"),
        showForeground: kind === "graphics" && relativeLayers.some(({role}) => role === "foreground"),
        showCaptions: kind === "captions",
        backAssetUrl: relativeLayers.find(({role}) => role === "back")?.content.asset?.dataUrl ?? "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=",
        foregroundAssetUrl: relativeLayers.find(({role}) => role === "foreground")?.content.asset?.dataUrl ?? "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=",
        fps: profile.video.fpsNumerator / profile.video.fpsDenominator,
        captionLayer: JSON.stringify({layers: relativeLayers.filter(({role}) => role === "caption")}),
      };
      return [{
        jobId: `hf:${shot.id}:${kind}`,
        shotId: shot.id,
        kind,
        targetTrackIndex: trackIndex,
        composition: LAYERED_COMPOSITION,
        compositionSha256,
        variablesPath: `Editors/HyperFrames/${input.workItemId}/v${version}/${shot.id}-${kind}.variables.json`,
        outputPath: `Renders/Shots/${input.workItemId}-${shot.id}-${kind}-v${version}.mov`,
        format: "mov",
        codec: "prores-4444",
        alpha: true,
        width: profile.video.width,
        height: profile.video.height,
        fps: profile.video.fpsDenominator === 1 ? profile.video.fpsNumerator : `${profile.video.fpsNumerator}/${profile.video.fpsDenominator}`,
        durationMs,
        layers: relativeLayers,
        variables,
      }];
    });
  });
}

function premiereClipPlan(input, files, jobs) {
  const byId = new Map(files.map((file) => [file.id, file]));
  const clips = [];
  const add = (clip) => clips.push({...clip, handles: {inMs: 40, outMs: 40}});
  for (const shot of input.designPlan.shots) {
    const source = (input.sourceImports ?? []).find(({id: sourceId}) => sourceId === shot.source.sourceId);
    const sourceRange = {inMs: shot.source.inMs, outMs: shot.source.outMs};
    const timelineRange = {inMs: shot.timeline.inMs, outMs: shot.timeline.outMs};
    add({clipId: `${shot.id}:v1`, shotId: shot.id, mediaId: source.id, path: source.path, sha256: source.sha256,
      trackType: "video", trackIndex: 1, trackRole: "background-plate", sourceRange, timelineRange, placement: {x: 0, y: 0, width: 1080, height: 1920}});
    for (const job of jobs.filter(({shotId}) => shotId === shot.id)) add({clipId: `${shot.id}:v${job.targetTrackIndex}`, shotId: shot.id,
      mediaId: job.jobId, path: job.outputPath, sha256: null, trackType: "video", trackIndex: job.targetTrackIndex,
      trackRole: job.targetTrackIndex === 2 ? "text-graphics" : "designed-captions", sourceRange: {inMs: 0, outMs: job.durationMs}, timelineRange,
      placement: {x: 0, y: 0, width: job.width, height: job.height}});
    const foreground = shot.depth?.mattePath && files.find((file) => file.path === shot.depth.mattePath && file.sha256 === shot.depth.matteSha256);
    if (shot.depth?.mattePath && !foreground) throw new Error(`Shot ${shot.id} V3 requires the exact verified foreground cutout`);
    if (foreground) add({clipId: `${shot.id}:v3`, shotId: shot.id, mediaId: foreground.id, path: foreground.path,
      sha256: foreground.sha256, trackType: "video", trackIndex: 3, trackRole: "foreground-subject",
      sourceRange: {inMs: 0, outMs: shot.source.outMs - shot.source.inMs}, timelineRange,
      placement: {x: 0, y: 0, width: 1080, height: 1920}, alphaRequired: true});
    add({clipId: `${shot.id}:a1`, shotId: shot.id, mediaId: source.id, path: source.path, sha256: source.sha256,
      trackType: "audio", trackIndex: 1, trackRole: "dialogue-or-narration", sourceRange, timelineRange, placement: null});
    const bgm = byId.get(shot.audio?.bgm?.assetId);
    if (bgm) add({clipId: `${shot.id}:a2`, shotId: shot.id, mediaId: bgm.id, path: bgm.path, sha256: bgm.sha256,
      trackType: "audio", trackIndex: 2, trackRole: "bgm", sourceRange: {inMs: 0, outMs: shot.timeline.outMs - shot.timeline.inMs}, timelineRange, placement: null});
    for (const [index, effect] of (shot.audio?.sfx ?? []).entries()) {
      const sfx = byId.get(effect.assetId);
      if (sfx) add({clipId: `${shot.id}:a3:${index + 1}`, shotId: shot.id, mediaId: sfx.id, path: sfx.path, sha256: sfx.sha256,
        trackType: "audio", trackIndex: 3, trackRole: "sfx", sourceRange: {inMs: 0, outMs: shot.timeline.outMs - shot.timeline.inMs}, timelineRange, placement: null});
    }
  }
  return clips;
}

function contractFor(input, profile, designRef, approval, files, jobs, dependencyClosure) {
  const version = pad(input.revision);
  const story = input.designPlan.parents.storyPlan;
  const storyArtifact = input.parentArtifacts.get(story.artifactId).artifact;
  const silenceOperations = (storyArtifact.payload.silencePlan ?? []).flatMap(({sourceId, silencePlan}) =>
    (silencePlan.operations ?? []).map((operation) => ({sourceId, ...structuredClone(operation)})));
  const caption = input.parentArtifacts.get(input.designPlan.parents.captionPlan.artifactId).artifact.payload;
  const srt = caption.files?.srt;
  if (!srt?.path || !srt.sha256) throw new Error("Approved caption plan requires a frozen SRT");
  const sourceImports = (input.sourceImports ?? []).map(({id: sourceId}) => files.find((file) => file.id === sourceId));
  return {
    schemaVersion: 1,
    workItemId: input.workItemId,
    revision: input.revision,
    modality: input.modality,
    designBinding: {
      artifactRef: designRef,
      approval: {id: approval.id, recordHash: approval.recordHash, subjectSha256: approval.subject.sha256},
      parents: input.designArtifact.parents,
    },
    inputLock: input.inputLock,
    inputLockHash: sha256Value(input.inputLock),
    hyperframesDependencyClosure: dependencyClosure,
    hyperframes: jobs.map(({variables, ...job}) => job),
    premiere: {
      sequenceName: `BB-${input.workItemId}-v${version}`,
      projectPath: `Editors/Premiere/${input.workItemId}.prproj`,
      writerLockPath: ".premiere-writer.lock",
      writerLockLifecycle: {acquireBeforeMutation: true, releaseAfterReadbackPublication: true},
      singleWriter: structuredClone(input.premiereExecutor),
      settings: {
        profileId: profile.id,
        profileHash: profile.profileHash,
        policyVersion: profile.policyVersion,
        width: profile.video.width,
        height: profile.video.height,
        fpsNumerator: profile.video.fpsNumerator,
        fpsDenominator: profile.video.fpsDenominator,
        audioSampleRate: profile.audio.sampleRate,
        codec: "prores-422-hq",
        durationMs: Math.max(...input.designPlan.shots.map(({timeline}) => timeline.outMs)),
      },
      sourceImports,
      frozenDependencies: files,
      shots: input.designPlan.shots.map((shot) => ({
        id: shot.id,
        source: structuredClone(shot.source),
        timeline: structuredClone(shot.timeline),
        layers: structuredClone(shot.onScreenCopy.layers),
        depth: structuredClone(shot.depth),
        foregroundMode: shot.depth?.mattePath ? "verified-alpha-cutout-v3" : "v1-source-only",
        requiredHandleMs: 40,
      })),
      clipPlan: premiereClipPlan(input, files, jobs),
      videoTracks: VIDEO_TRACKS,
      audioTracks: AUDIO_TRACKS,
      nativeCaptionTrack: {required: true, sourcePath: srt.path, sourceSha256: srt.sha256},
      silenceOperations,
      actions: PREMIERE_ACTIONS.map((actionId, order) => ({order: order + 1, actionId})),
      deviationPolicy: "return-to-design-approval",
      readbackPath: `Plans/Execution/${input.workItemId}/premiere-readback-v${version}.json`,
      masterPath: `Renders/Candidates/${input.workItemId}/v${version}/master.mov`,
    },
  };
}

async function recheckContractInputs(root, state, dependencies) {
  await workflow(root, state.workItemId, state.revision, state.modality, ["DESIGN_APPROVED"], dependencies, state.designRef);
  const manifest = await dependencies.readManifest(root);
  await currentDesignApproval(root, manifest, state.workItemId, state.designRef, state.designApprovalRef, state.inputLock, dependencies);
  const current = await findArtifacts(root, state.artifactRefs, dependencies);
  for (const ref of state.artifactRefs) if (!sameSnapshot(state.artifacts.get(ref.artifactId).snapshot, current.get(ref.artifactId).snapshot)) throw new Error(`Video execution parent changed: ${ref.artifactId}`);
  for (const file of state.files) {
    const next = await readBound(root, file.path, dependencies, `Frozen dependency ${file.id}`);
    if (next.sha256 !== file.sha256 || next.size !== file.bytes) throw new Error(`Frozen dependency changed: ${file.id}`);
  }
}

export async function createVideoExecutionContract(projectDir, input, adapters = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Video execution input is required");
  id(input.workItemId, "Video execution work item id");
  revision(input.revision);
  if (!(["raw-video", "multi-clip", "voice-over"].includes(input.modality))) throw new Error("Video execution modality is invalid");
  if (input.premiereExecutor?.role !== "premiere-executor") throw new Error("Video execution requires one Premiere executor");
  id(input.premiereExecutor?.actorId, "Premiere executor actor id");
  if (!input.versions) throw new Error("Video execution versions are required");
  const dependencies = dependenciesFor(adapters);
  const root = await realpath(projectDir);
  const designRef = artifactRef(input.designPlanRef, "Design plan");
  const inputLock = normalizeInputLock(input.inputLock);
  const designPath = `Plans/Designs/${input.workItemId}/design-plan-v${pad(input.revision)}.json`;
  const [manifest, designSnapshot] = await Promise.all([
    dependencies.readManifest(root),
    readBound(root, designPath, dependencies, "Video design plan"),
  ]);
  const designArtifact = parseArtifact(designSnapshot, designRef, "Video design plan");
  if (designArtifact.workItemId !== input.workItemId || designArtifact.revision !== input.revision || designArtifact.modality !== input.modality
    || designArtifact.payload?.kind !== "video-design-plan" || designArtifact.status !== "frozen") throw new Error("Video design plan does not match execution work item");
  const storedPlan = structuredClone(designArtifact.payload); delete storedPlan.kind;
  if (!input.designPlan || canonicalJson(input.designPlan) !== canonicalJson(storedPlan)) throw new Error("Video execution design plan must equal exact approved artifact bytes");
  await workflow(root, input.workItemId, input.revision, input.modality, ["DESIGN_APPROVED"], dependencies, designRef);
  const approval = await currentDesignApproval(root, manifest, input.workItemId, designRef, input.designApprovalRef, inputLock, dependencies);
  const profile = exactProfile(input, manifest);
  const brandParent = designArtifact.parents.find((ref) => ref.artifactId === manifest.brand?.artifactId);
  if (!brandParent || brandParent.sha256 !== manifest.brand.lockSha256) throw new Error("Video execution design plan is not bound to the current frozen brand");
  const brandLock = await readBound(root, manifest.brand.lockPath, dependencies, "Frozen brand lock");
  if (brandLock.sha256 !== brandParent.sha256) throw new Error("Video execution frozen brand changed");
  const envelopeRefs = designArtifact.parents.filter((ref) => ref.artifactId !== manifest.brand?.artifactId);
  const requiredLocks = [designRef, ...envelopeRefs];
  if (requiredLocks.length !== inputLock.artifacts.length || requiredLocks.some((ref) => !inputLock.artifacts.some(({id: lockId, sha256}) => lockId === ref.artifactId && sha256 === ref.sha256))) {
    throw new Error("Video execution input lock must exactly equal approved design-plan parent hashes");
  }
  if ((input.sourceImports ?? []).some((source) => !inputLock.assets.some(({id: lockId, sha256}) => lockId === source.id && sha256 === source.sha256))) {
    throw new Error("Video execution input lock omits frozen source imports");
  }
  const artifacts = await findArtifacts(root, requiredLocks, dependencies);
  const files = await frozenFiles(root, {...input, designPlan: storedPlan}, artifacts, manifest, dependencies);
  const requiredAssetLocks = [...(input.sourceImports ?? []).map(({id: assetId, sha256}) => ({id: assetId, sha256})),
    ...storedPlan.shots.flatMap((shot) => shot.assets ?? []).map(({assetId, sha256}) => ({id: assetId, sha256}))]
    .filter((lock, index, all) => all.findIndex(({id: assetId}) => assetId === lock.id) === index)
    .toSorted((left, right) => left.id.localeCompare(right.id));
  if (canonicalJson([...inputLock.assets].toSorted((left, right) => left.id.localeCompare(right.id))) !== canonicalJson(requiredAssetLocks)) {
    throw new Error("Video execution input lock must exactly equal approved source and asset hashes");
  }
  const [dependencyClosure, captionSource, renderAssets] = await Promise.all([
    packDependencyClosure(dependencies),
    readCaptionSource(root, artifacts, dependencies),
    renderAssetPayloads(root, storedPlan, files, dependencies),
  ]);
  const compositionSha256 = dependencyClosure.find(({path}) => path === LAYERED_COMPOSITION).sha256;
  const jobs = hyperFramesJobs({...input, designPlan: storedPlan}, artifacts, captionSource, renderAssets, profile, compositionSha256);
  const outputPaths = new Set();
  for (const job of jobs) {
    if (outputPaths.has(job.outputPath)) throw new Error("HyperFrames jobs must own independent output paths");
    outputPaths.add(job.outputPath);
  }
  const lock = await dependencies.acquireProjectLock(root, `.video-execution-${input.workItemId}-v${pad(input.revision)}.lock`);
  const owned = [];
  try {
    await dependencies.makeDirectories(root, `Editors/HyperFrames/${input.workItemId}/v${pad(input.revision)}`);
    for (const job of jobs) {
      const variables = Buffer.from(`${JSON.stringify({schemaVersion: 1, jobId: job.jobId, render: {codec: job.codec, alpha: job.alpha, width: job.width, height: job.height, fps: job.fps, durationMs: job.durationMs}, layers: job.layers, variables: job.variables}, null, 2)}\n`);
      const owner = await dependencies.writeExclusiveFile(root, job.variablesPath, variables);
      owned.push({path: job.variablesPath, owner});
      const saved = await readBound(root, job.variablesPath, dependencies, `HyperFrames variables ${job.jobId}`);
      if (saved.sha256 !== digest(variables) || saved.size !== variables.length || !sameOwner(saved.owner, owner)) throw new Error(`HyperFrames variables changed: ${job.jobId}`);
      job.variablesSha256 = saved.sha256;
      delete job.variables;
    }
    const contract = contractFor({...input, designPlan: storedPlan, designArtifact, parentArtifacts: artifacts, inputLock}, profile, designRef, approval, files, jobs, dependencyClosure);
    const artifact = createArtifactEnvelope({
      artifactId: `video-execution-plan:${input.workItemId}:v${pad(input.revision)}`,
      revision: input.revision,
      workItemId: input.workItemId,
      modality: input.modality,
      parents: [designRef, ...designArtifact.parents].filter((ref, index, all) => all.findIndex(({artifactId}) => artifactId === ref.artifactId) === index),
      producer: input.premiereExecutor,
      versions: input.versions,
      status: "frozen",
      deviations: [],
      payload: {kind: "video-execution-plan", ...contract},
    });
    const path = `Plans/Execution/${input.workItemId}/execution-plan-v${pad(input.revision)}.json`;
    await dependencies.makeDirectories(root, dirname(path));
    await recheckContractInputs(root, {workItemId: input.workItemId, revision: input.revision, modality: input.modality, designRef,
      designApprovalRef: input.designApprovalRef, inputLock, artifactRefs: requiredLocks, artifacts, files}, dependencies);
    const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
    const owner = await dependencies.writeExclusiveFile(root, path, bytes);
    owned.push({path, owner});
    const saved = await readBound(root, path, dependencies, "Video execution plan");
    if (saved.sha256 !== digest(bytes) || saved.size !== bytes.length || !sameOwner(saved.owner, owner)) throw new Error("Video execution plan changed after publication");
    await recheckContractInputs(root, {workItemId: input.workItemId, revision: input.revision, modality: input.modality, designRef,
      designApprovalRef: input.designApprovalRef, inputLock, artifactRefs: requiredLocks, artifacts, files}, dependencies);
    return {artifact, artifactRef: {artifactId: artifact.artifactId, sha256: saved.sha256}, executionContract: contract};
  } catch (error) {
    for (const file of owned.reverse()) await dependencies.removeOwnedFile(root, file.path, file.owner).catch(() => false);
    throw error;
  } finally {
    await lock.release();
  }
}

function rate(value) {
  const match = /^(\d+)(?:\/(\d+))?$/u.exec(String(value));
  return match && Number(match[2] ?? 1) > 0 ? Number(match[1]) / Number(match[2] ?? 1) : NaN;
}

async function verifyVideo(root, file, expected, dependencies, {alpha = false, audio = false} = {}) {
  const before = await readBound(root, file.path, dependencies, `Produced file ${file.path}`);
  if (file.sha256 && before.sha256 !== file.sha256) throw new Error(`Produced file hash mismatch: ${file.path}`);
  const absolute = `${root}/${file.path}`;
  const probe = await dependencies.run("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", absolute], {timeoutMs: 120_000, maxBytes: 4 * 1024 * 1024});
  if (probe.code !== 0 || probe.truncated || (probe.stderr ?? "").trim()) throw new Error(`Produced file probe failed: ${file.path}`);
  let media;
  try { media = JSON.parse(probe.stdout); } catch { throw new Error(`Produced file probe JSON malformed: ${file.path}`); }
  const video = media.streams?.find(({codec_type}) => codec_type === "video");
  const audioStream = media.streams?.find(({codec_type}) => codec_type === "audio");
  const expectedRate = expected.fpsNumerator ? expected.fpsNumerator / expected.fpsDenominator : rate(expected.fps);
  const actualDuration = Number(media.format?.duration ?? video?.duration);
  const frameTolerance = 1 / expectedRate + 0.001;
  const is4444 = video?.codec_name === "prores" && /^4444(?: XQ)?$/u.test(video.profile ?? "") && /^yuva444p(?:10|12)le$/u.test(video.pix_fmt ?? "");
  const is422 = video?.codec_name === "prores" && video.profile === "HQ" && video.pix_fmt === "yuv422p10le";
  if (!video || video.width !== expected.width || video.height !== expected.height || Math.abs(rate(video.r_frame_rate) - expectedRate) > 1e-9
    || !Number.isFinite(actualDuration) || Math.abs(actualDuration - expected.durationMs / 1000) > frameTolerance
    || (expected.codec === "prores-4444" ? !is4444 : expected.codec === "prores-422-hq" ? !is422 : true)) {
    throw new Error(`Produced file does not match codec, alpha, dimensions, fps, or duration contract: ${file.path}`);
  }
  if (audio && Number(audioStream?.sample_rate) !== expected.audioSampleRate) throw new Error(`Produced master audio sample rate mismatch: ${file.path}`);
  const decoded = await dependencies.run("ffmpeg", ["-v", "error", "-xerror", "-err_detect", "explode", "-i", absolute, "-map", "0", "-f", "null", "-"], {timeoutMs: 600_000, maxBytes: 4 * 1024 * 1024});
  if (decoded.code !== 0 || decoded.truncated || (decoded.stderr ?? "").trim()) throw new Error(`Produced file failed full decode: ${file.path}`);
  if (alpha) {
    const checked = await dependencies.run("ffmpeg", ["-v", "error", "-xerror", "-i", absolute, "-vf", "alphaextract,signalstats,metadata=print:file=-", "-f", "null", "-"], {timeoutMs: 300_000, maxBytes: 4 * 1024 * 1024});
    const minimums = [...String(checked.stdout).matchAll(/lavfi\.signalstats\.YMIN=(\d+(?:\.\d+)?)/gu)].map((match) => Number(match[1]));
    const maximums = [...String(checked.stdout).matchAll(/lavfi\.signalstats\.YMAX=(\d+(?:\.\d+)?)/gu)].map((match) => Number(match[1]));
    const minimum = Math.min(...minimums);
    const maximum = Math.max(...maximums);
    if (checked.code !== 0 || checked.truncated || (checked.stderr ?? "").trim() || !minimums.length || !maximums.length
      || maximum <= 0 || (maximum - minimum) / maximum < 0.02) {
      throw new Error(`Produced alpha sidecar has no usable alpha channel: ${file.path}`);
    }
  }
  const after = await readBound(root, file.path, dependencies, `Produced file ${file.path}`);
  if (!sameSnapshot(before, after)) throw new Error(`Produced file changed during verification: ${file.path}`);
  return {...file, owner: after.owner, bytes: after.size, sha256: after.sha256, probe: {codec: video.codec_name, profile: video.profile, pixFmt: video.pix_fmt,
    width: video.width, height: video.height, fps: video.r_frame_rate, durationSeconds: actualDuration}};
}

async function loadStoredExecution(root, execution, dependencies) {
  if (!execution?.artifactRef) throw new Error("Execution requires an immutable work-item-scoped execution artifact reference");
  const expected = artifactRef(execution.artifactRef, "Execution plan");
  const match = /^video-execution-plan:([A-Za-z0-9][A-Za-z0-9._-]*):v([0-9]{3})$/u.exec(expected.artifactId);
  if (!match) throw new Error("Execution plan reference has an invalid work-item-scoped ID");
  const path = `Plans/Execution/${match[1]}/execution-plan-v${match[2]}.json`;
  const artifact = parseArtifact(await readBound(root, path, dependencies, "Execution plan"), expected, "Execution plan");
  if (artifact.workItemId !== match[1] || pad(artifact.revision) !== match[2] || artifact.payload?.kind !== "video-execution-plan") {
    throw new Error("Execution plan artifact identity is invalid");
  }
  const contract = structuredClone(artifact.payload); delete contract.kind;
  if (execution.executionContract && canonicalJson(execution.executionContract) !== canonicalJson(contract)) {
    throw new Error("Execution contract does not equal exact immutable artifact bytes");
  }
  return {artifact, artifactRef: expected, contract, snapshot: await readBound(root, path, dependencies, "Execution plan")};
}

async function recheckExecutionState(root, stored, states, dependencies) {
  const current = await loadStoredExecution(root, {artifactRef: stored.artifactRef}, dependencies);
  if (!sameSnapshot(stored.snapshot, current.snapshot)) throw new Error("Execution plan changed during execution");
  const {contract} = current;
  await workflow(root, contract.workItemId, contract.revision, contract.modality, states, dependencies);
  const manifest = await dependencies.readManifest(root);
  await currentDesignApproval(root, manifest, contract.workItemId, contract.designBinding.artifactRef,
    {id: contract.designBinding.approval.id, subjectSha256: contract.designBinding.approval.subjectSha256}, contract.inputLock, dependencies);
  await findArtifacts(root, contract.inputLock.artifacts.map(({id: artifactId, sha256}) => ({artifactId, sha256})), dependencies);
  for (const file of contract.premiere.frozenDependencies) await verifyLocalFile(root, file, dependencies, `Execution dependency ${file.id}`);
  await recheckPackDependencyClosure(contract.hyperframesDependencyClosure, dependencies);
  return current;
}

export async function executeHyperFramesJobs(projectDir, execution, adapters = {}) {
  const dependencies = dependenciesFor(adapters);
  const root = await realpath(projectDir);
  const stored = await loadStoredExecution(root, execution, dependencies);
  const {contract} = stored;
  await recheckExecutionState(root, stored, ["EXECUTING"], dependencies);
  const completed = [];
  const results = await Promise.allSettled(contract.hyperframes.map(async (job) => {
    const stage = `Renders/Shots/.${job.jobId.replace(/[^A-Za-z0-9._-]/gu, "-")}-${randomUUID()}`;
    let stageOwner, publishedOwner;
    try {
      const variables = await readBound(root, job.variablesPath, dependencies, `HyperFrames variables ${job.jobId}`);
      if (variables.sha256 !== job.variablesSha256) throw new Error(`HyperFrames variables changed: ${job.jobId}`);
      const packSnapshot = await createPackSnapshot(contract.hyperframesDependencyClosure, dependencies);
      const composition = await readFile(resolve(packSnapshot.root, job.composition));
      if (digest(composition) !== job.compositionSha256) throw new Error(`HyperFrames snapshot composition changed: ${job.jobId}`);
      await dependencies.makeDirectories(root, "Renders/Shots");
      stageOwner = await dependencies.makeExclusiveDirectory(root, stage);
      const result = await dependencies.run("/usr/bin/env", [`CONTENT_HUB_HF_CODEC=${job.codec}`, `CONTENT_HUB_HF_WIDTH=${job.width}`,
        `CONTENT_HUB_HF_HEIGHT=${job.height}`, `CONTENT_HUB_HF_DURATION_MS=${job.durationMs}`,
        `CONTENT_HUB_HF_CLOSURE_SHA256=${sha256Value(contract.hyperframesDependencyClosure)}`, RUNNER, resolve(packSnapshot.root, job.composition),
        `${root}/${job.variablesPath}`, `${root}/${stage}/output.mov`, String(job.fps)], {timeoutMs: 1_800_000, maxBytes: 8 * 1024 * 1024});
      if (result.code !== 0 || result.truncated || (result.stderr ?? "").trim()) throw new Error(`HyperFrames job failed: ${job.jobId}: ${(result.stderr ?? "").trim() || `status ${result.code}`}`);
      await recheckExecutionState(root, stored, ["EXECUTING"], dependencies);
      await verifyVideo(root, {path: `${stage}/output.mov`, kind: "sidecar", order: 1}, job, dependencies, {alpha: job.alpha});
      publishedOwner = await dependencies.copyExclusiveFile(root, `${stage}/output.mov`, job.outputPath);
      const verified = await verifyVideo(root, {path: job.outputPath, kind: "sidecar", order: 1}, job, dependencies, {alpha: job.alpha});
      if (!sameOwner(verified.owner, publishedOwner)) throw new Error(`HyperFrames output ownership changed: ${job.jobId}`);
      const output = {...verified, jobId: job.jobId};
      completed.push(output);
      return output;
    } catch (error) {
      if (publishedOwner) await dependencies.removeOwnedFile(root, job.outputPath, publishedOwner).catch(() => false);
      throw error;
    } finally {
      if (stageOwner) await dependencies.removeOwnedStage(root, stage, stageOwner).catch(() => false);
    }
  }));
  const failure = results.find(({status}) => status === "rejected");
  if (failure) {
    for (const file of completed) await dependencies.removeOwnedFile(root, file.path, file.owner).catch(() => false);
    throw failure.reason;
  }
  try {
    await recheckExecutionState(root, stored, ["EXECUTING"], dependencies);
  } catch (error) {
    for (const file of completed) await dependencies.removeOwnedFile(root, file.path, file.owner).catch(() => false);
    throw error;
  }
  return results.map(({value}) => value);
}

function exactReadbackClips(contract, sidecars) {
  const hashes = new Map(sidecars.map((sidecar) => [sidecar.jobId, sidecar.sha256]));
  return contract.premiere.clipPlan.map((clip) => ({...structuredClone(clip), sha256: hashes.get(clip.mediaId) ?? clip.sha256}));
}

function validateReadback(artifact, stored, master, sidecars) {
  validateArtifactEnvelope(artifact);
  const {contract, artifactRef: executionRef} = stored;
  const payload = artifact.payload;
  const expectedDependencies = [...contract.premiere.frozenDependencies, ...sidecars.map((sidecar) => ({id: sidecar.jobId, path: sidecar.path, sha256: sidecar.sha256}))]
    .map(({id: dependencyId, path, sha256}) => ({id: dependencyId, path, sha256})).toSorted((left, right) => left.path.localeCompare(right.path));
  const snapshots = payload?.mutationSnapshots;
  const snapshotValid = (snapshot) => snapshot && Object.keys(snapshot).length === 2 && Object.hasOwn(snapshot, "state")
    && SHA256.test(snapshot.sha256 ?? "") && snapshot.sha256 === sha256Value(snapshot.state);
  const snapshotsValid = Array.isArray(snapshots) && snapshots.length === PREMIERE_ACTIONS.length
    && snapshots.every(({actionId, before, after}, index) => actionId === PREMIERE_ACTIONS[index] && snapshotValid(before) && snapshotValid(after)
      && before.sha256 !== after.sha256 && (index === 0 || before.sha256 === snapshots[index - 1].after.sha256)
      && before.state?.sequenceId === payload.sequence?.sequenceId && after.state?.sequenceId === payload.sequence?.sequenceId
      && Array.isArray(before.state.applied) && Array.isArray(after.state.applied)
      && canonicalJson(before.state.applied) === canonicalJson(PREMIERE_ACTIONS.slice(0, index))
      && canonicalJson(after.state.applied) === canonicalJson(PREMIERE_ACTIONS.slice(0, index + 1)));
  if (artifact.artifactId !== `premiere-readback:${contract.workItemId}:v${pad(contract.revision)}` || artifact.workItemId !== contract.workItemId
    || artifact.revision !== contract.revision || artifact.modality !== contract.modality || artifact.producer.actorId !== contract.premiere.singleWriter.actorId
    || artifact.producer.role !== "premiere-executor" || artifact.parents.length !== 1 || artifact.parents[0].artifactId !== executionRef.artifactId
    || artifact.parents[0].sha256 !== executionRef.sha256 || payload?.kind !== "premiere-readback"
    || payload.sequence?.projectPath !== contract.premiere.projectPath || payload.sequence?.name !== contract.premiere.sequenceName
    || !SAFE_ID.test(payload.sequence?.sequenceId ?? "") || canonicalJson(payload.clips) !== canonicalJson(exactReadbackClips(contract, sidecars))
    || canonicalJson(payload.silenceOperations) !== canonicalJson(contract.premiere.silenceOperations)
    || payload.nativeCaptionTrack?.retained !== true || !SAFE_ID.test(payload.nativeCaptionTrack.trackId ?? "")
    || payload.nativeCaptionTrack.sourcePath !== contract.premiere.nativeCaptionTrack.sourcePath
    || payload.nativeCaptionTrack.sourceSha256 !== contract.premiere.nativeCaptionTrack.sourceSha256 || !snapshotsValid
    || canonicalJson((payload.dependencies ?? []).toSorted((left, right) => left.path.localeCompare(right.path))) !== canonicalJson(expectedDependencies)
    || !Array.isArray(payload.warnings) || payload.warnings.length || !Array.isArray(payload.gaps) || payload.gaps.length || payload.networkDenied !== true
    || canonicalJson(payload.master) !== canonicalJson({path: master.path, sha256: master.sha256, bytes: master.bytes})) {
    throw new Error("Premiere readback does not prove the exact sequence clips ranges tracks handles sidecars captions and mutations");
  }
  return artifact;
}

export async function executePremiereAssembly(projectDir, execution, adapter, adapters = {}) {
  const dependencies = dependenciesFor(adapters);
  const root = await realpath(projectDir);
  const stored = await loadStoredExecution(root, execution, dependencies);
  const {contract} = stored;
  if (typeof adapter?.execute !== "function" || typeof adapter?.readback !== "function") throw new Error("Premiere execution requires separate mutation and readback adapters");
  await recheckExecutionState(root, stored, ["EXECUTING"], dependencies);
  const lock = await dependencies.acquireProjectLock(root, contract.premiere.writerLockPath);
  const parent = `Renders/Candidates/${contract.workItemId}`;
  const stage = `${parent}/.premiere-v${pad(contract.revision)}-${randomUUID()}`;
  let stageOwner, masterOwner, readbackOwner;
  try {
    await recheckExecutionState(root, stored, ["EXECUTING"], dependencies);
    await dependencies.makeDirectories(root, parent);
    stageOwner = await dependencies.makeExclusiveDirectory(root, stage);
    const sidecars = [];
    for (const job of contract.hyperframes) sidecars.push({...await verifyVideo(root, {path: job.outputPath}, job, dependencies, {alpha: job.alpha}), jobId: job.jobId});
    await recheckExecutionState(root, stored, ["EXECUTING"], dependencies);
    await adapter.execute({projectDir: root, executionContract: structuredClone(contract), sidecars: structuredClone(sidecars),
      outputPath: `${root}/${stage}/master.mov`});
    await recheckExecutionState(root, stored, ["EXECUTING"], dependencies);
    await verifyVideo(root, {path: `${stage}/master.mov`}, contract.premiere.settings, dependencies, {audio: true});
    await dependencies.makeDirectories(root, dirname(contract.premiere.masterPath));
    masterOwner = await dependencies.copyExclusiveFile(root, `${stage}/master.mov`, contract.premiere.masterPath);
    const master = await verifyVideo(root, {path: contract.premiere.masterPath}, contract.premiere.settings, dependencies, {audio: true});
    if (!sameOwner(master.owner, masterOwner)) throw new Error("Premiere master ownership changed during publication");
    const readback = await adapter.readback({projectDir: root, projectPath: contract.premiere.projectPath,
      sequenceName: contract.premiere.sequenceName});
    await recheckExecutionState(root, stored, ["EXECUTING"], dependencies);
    const artifact = createArtifactEnvelope({artifactId: `premiere-readback:${contract.workItemId}:v${pad(contract.revision)}`, revision: contract.revision,
      workItemId: contract.workItemId, modality: contract.modality, parents: [stored.artifactRef], producer: contract.premiere.singleWriter,
      versions: stored.artifact.versions, status: "frozen", deviations: [], payload: {...readback, kind: "premiere-readback",
        master: {path: master.path, sha256: master.sha256, bytes: master.bytes}}});
    validateReadback(artifact, stored, master, sidecars);
    const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
    await dependencies.makeDirectories(root, dirname(contract.premiere.readbackPath));
    readbackOwner = await dependencies.writeExclusiveFile(root, contract.premiere.readbackPath, bytes);
    const saved = await readBound(root, contract.premiere.readbackPath, dependencies, "Premiere readback");
    if (saved.sha256 !== digest(bytes) || !sameOwner(saved.owner, readbackOwner)) throw new Error("Premiere readback changed after publication");
    await recheckExecutionState(root, stored, ["EXECUTING"], dependencies);
    return {artifact, artifactRef: {artifactId: artifact.artifactId, sha256: saved.sha256}, master, path: contract.premiere.readbackPath};
  } catch (error) {
    if (readbackOwner) await dependencies.removeOwnedFile(root, contract.premiere.readbackPath, readbackOwner).catch(() => false);
    if (masterOwner) await dependencies.removeOwnedFile(root, contract.premiere.masterPath, masterOwner).catch(() => false);
    throw error;
  } finally {
    if (stageOwner) await dependencies.removeOwnedStage(root, stage, stageOwner).catch(() => false);
    await lock.release();
  }
}

export async function freezeVideoCandidate(projectDir, coordinatorContext, input, adapters = {}) {
  const dependencies = dependenciesFor(adapters);
  const root = await realpath(projectDir);
  if (input?.executionContract) throw new Error("Video candidate rejects raw execution contracts; provide only immutable executionArtifactRef");
  const stored = await loadStoredExecution(root, {artifactRef: input?.executionArtifactRef}, dependencies);
  const {contract} = stored;
  if (contract.workItemId !== input.workItemId || contract.revision !== input.revision || contract.modality !== input.modality) throw new Error("Video candidate execution artifact does not match work item");
  await recheckExecutionState(root, stored, ["EXECUTING"], dependencies);
  const inputLock = normalizeInputLock(input.inputLock);
  const sidecars = [];
  for (const job of contract.hyperframes) sidecars.push({...await verifyVideo(root, {path: job.outputPath}, job, dependencies, {alpha: job.alpha}), jobId: job.jobId});
  const master = await verifyVideo(root, {path: contract.premiere.masterPath}, contract.premiere.settings, dependencies, {audio: true});
  let readbackSnapshot;
  try { readbackSnapshot = await readBound(root, contract.premiere.readbackPath, dependencies, "Premiere readback"); }
  catch { throw new Error("Video candidate requires the exact immutable Premiere readback"); }
  let readback;
  try { readback = JSON.parse(readbackSnapshot.bytes.toString("utf8")); } catch { throw new Error("Premiere readback is malformed"); }
  const readbackRef = {artifactId: readback.artifactId, sha256: readbackSnapshot.sha256};
  validateReadback(readback, stored, master, sidecars);
  const requiredArtifacts = [...contract.inputLock.artifacts, {id: stored.artifactRef.artifactId, sha256: stored.artifactRef.sha256},
    {id: readbackRef.artifactId, sha256: readbackRef.sha256}];
  if (requiredArtifacts.some((lock) => !inputLock.artifacts.some(({id: lockId, sha256}) => lockId === lock.id && sha256 === lock.sha256))
    || canonicalJson(inputLock.assets) !== canonicalJson(contract.inputLock.assets)
    || contract.inputLock.approvals.some((lock) => !inputLock.approvals.some(({id: lockId, subjectSha256}) => lockId === lock.id && subjectSha256 === lock.subjectSha256))) {
    throw new Error("Video candidate input lock is stale or omits execution readback sidecar or asset provenance");
  }
  const lockedArtifacts = await findArtifacts(root, inputLock.artifacts.map(({id: artifactId, sha256}) => ({artifactId, sha256})), dependencies);
  const requested = input.outputs ?? [{path: master.path, kind: "master", order: 1}, {path: contract.premiere.readbackPath, kind: "premiere-readback", order: 2}];
  if (!requested.some(({kind, path}) => kind === "master" && path === master.path)
    || !requested.some(({kind, path}) => kind === "premiere-readback" && path === contract.premiere.readbackPath)
    || requested.some(({path}) => path.startsWith("Final/"))) throw new Error("Video candidate requires exact master and Premiere readback outside Final");
  const lineage = {
    executionPlan: stored.artifactRef,
    designPlan: contract.designBinding.artifactRef,
    premiereReadback: readbackRef,
    parents: [...lockedArtifacts.values()].map(({artifact}) => ({artifactId: artifact.artifactId, sha256: inputLock.artifacts.find(({id: lockId}) => lockId === artifact.artifactId).sha256}))
      .toSorted((left, right) => left.artifactId.localeCompare(right.artifactId)),
    sources: contract.premiere.sourceImports.map(({id: sourceId, sha256}) => ({id: sourceId, sha256})),
    assets: structuredClone(inputLock.assets),
    sidecars: sidecars.map(({jobId, path, sha256}) => ({jobId, path, sha256})),
  };
  const bundlePath = `Renders/Candidates/${input.workItemId}/v${pad(input.revision)}/bundle.json`;
  const lock = await dependencies.acquireProjectLock(root, `.candidate-${input.workItemId}-v${pad(input.revision)}.lock`);
  let bundle, bundleOwner, bundleExisted = false;
  try {
    try {
      await readBound(root, bundlePath, dependencies, "Candidate bundle");
      bundleExisted = true;
      throw new Error("Candidate bundle already exists");
    } catch (error) {
      if (error.message === "Candidate bundle already exists") throw error;
    }
    bundle = await dependencies.freezeCandidateBundle(root, coordinatorContext, {workItemId: input.workItemId, modality: input.modality,
      revision: input.revision, outputs: requested.filter(({kind}) => kind !== "premiere-readback"), inputLock, lineage,
      settings: contract.premiere.settings, producer: contract.premiere.singleWriter, versions: stored.artifact.versions,
      requestedDerivatives: input.requestedDerivatives ?? []});
    bundleOwner = dependencies.getCandidateBundleOwner(bundle);
    if (!bundleOwner) throw new Error("Candidate freezer did not return explicit bundle ownership");
    const created = await readBound(root, bundlePath, dependencies, "Candidate bundle");
    if (!sameOwner(created.owner, bundleOwner)) throw new Error("Candidate bundle ownership changed after publication");
    await recheckExecutionState(root, stored, ["EXECUTING"], dependencies);
    for (const sidecar of sidecars) {
      const current = await readBound(root, sidecar.path, dependencies, `Candidate sidecar ${sidecar.jobId}`);
      if (current.sha256 !== sidecar.sha256 || current.size !== sidecar.bytes) throw new Error(`Candidate sidecar changed after freeze: ${sidecar.jobId}`);
    }
    const currentMaster = await readBound(root, master.path, dependencies, "Candidate master");
    const currentReadback = await readBound(root, contract.premiere.readbackPath, dependencies, "Premiere readback");
    if (currentMaster.sha256 !== master.sha256 || currentMaster.size !== master.bytes || !sameSnapshot(readbackSnapshot, currentReadback)) {
      throw new Error("Candidate master or readback changed during freeze");
    }
    await dependencies.verifyCandidateBundle(root, bundle.bundlePath);
    return {bundle, candidateRef: {artifactId: `candidate:${input.workItemId}:v${pad(input.revision)}`, sha256: bundle.bundleHash}, readbackRef};
  } catch (error) {
    if (!bundleExisted && bundleOwner) await dependencies.removeOwnedFile(root, bundlePath, bundleOwner).catch(() => false);
    throw error;
  } finally {
    await lock.release();
  }
}
