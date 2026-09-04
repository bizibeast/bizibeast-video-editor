import {constants} from "node:fs";
import {lstat, mkdir, open, realpath} from "node:fs/promises";
import {basename, extname, isAbsolute, join, relative, sep} from "node:path";

import {readManifest, mutateManifest} from "./manifest.mjs";
import {sha256File} from "./checksum.mjs";
import {confinedProjectPath} from "./paths.mjs";
import {hashFileNoFollow, readFileNoFollow} from "./release-fs.mjs";

const SHARED_PATHS = Object.freeze({
  image: "Images",
  music: "Music",
  sfx: "SFX",
  font: "Fonts",
  lut: "LUTs",
});

export async function promoteAsset(projectDir, assetId, sharedRoot, coordinatorContext) {
  const root = await realpath(projectDir);
  const manifest = await readManifest(root);
  const asset = manifest.assets.find(({id}) => id === assetId);
  if (!asset) throw new Error(`Asset not found: ${assetId}`);
  if (!SHARED_PATHS[asset.kind] || asset.private || asset.client || ["private", "client"].includes(asset.privacyClass)
    || asset.voiceClone || asset.source || asset.kind === "source" || ["source", "source-footage", "source-provenance", "local-generation"].includes(asset.originType)) {
    throw new Error(`Asset ${assetId} cannot be promoted`);
  }

  await confinedProjectPath(root, asset.path, {type: "file"});
  const before = await hashFileNoFollow(root, asset.path);
  if (before.sha256 !== asset.sha256 || before.bytes !== asset.bytes) throw new Error(`Asset ${assetId} changed since ingest`);
  const source = await readFileNoFollow(root, asset.path);
  const after = await hashFileNoFollow(root, asset.path);
  if (after.sha256 !== before.sha256 || after.bytes !== before.bytes || after.owner.dev !== before.owner.dev || after.owner.ino !== before.owner.ino
    || source.owner.dev !== before.owner.dev || source.owner.ino !== before.owner.ino) throw new Error(`Asset ${assetId} changed during promotion`);

  await mkdir(sharedRoot, {recursive: true});
  const shared = await realpath(sharedRoot);
  const directory = join(shared, SHARED_PATHS[asset.kind]);
  await mkdir(directory, {recursive: true});
  const realDirectory = await realpath(directory);
  const confined = relative(shared, realDirectory);
  if (confined === ".." || confined.startsWith(`..${sep}`) || isAbsolute(confined)) throw new Error("Shared promotion path escaped its root");
  const extension = extname(asset.path);
  const stem = basename(asset.path, extension);
  const destination = join(realDirectory, `${stem}-${asset.sha256.slice(0, 12)}${extension}`);
  try {
    const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(source.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if ((await lstat(destination)).isSymbolicLink() || await sha256File(destination) !== asset.sha256) throw new Error(`Shared asset destination conflicts with ${assetId}`);
  }
  if (await sha256File(destination) !== asset.sha256) throw new Error(`Promoted asset ${assetId} hash mismatch`);

  const promotedAt = new Date().toISOString();
  let saved;
  await mutateManifest(root, coordinatorContext, (next) => {
    const current = next.assets.find(({id}) => id === assetId);
    if (!current) throw new Error(`Asset not found: ${assetId}`);
    current.promotedPath = destination;
    current.promotedAt = promotedAt;
    saved = current;
    return next;
  });
  return {...saved, absolutePath: destination};
}
