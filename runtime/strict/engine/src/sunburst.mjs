import {randomUUID} from "node:crypto";
import {constants} from "node:fs";
import {copyFile, mkdir, readFile, readdir, realpath, stat, unlink, writeFile} from "node:fs/promises";
import {basename, extname, join, relative} from "node:path";

import {sha256File} from "./checksum.mjs";
import {assertCoordinator, mutateManifest, readManifest} from "./manifest.mjs";
import {confinedProjectPath} from "./paths.mjs";

function projectPath(projectDir, path) {
  return relative(projectDir, path).split("\\").join("/");
}

function frontmatterValue(frame, key) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(frame)?.[1];
  if (!frontmatter) return null;
  const value = new RegExp(`^${key}:\\s*(?:"([^"]*)"|'([^']*)'|([^\\s#]+))\\s*$`, "mu").exec(frontmatter);
  return value?.[1] ?? value?.[2] ?? value?.[3] ?? null;
}

async function checkedPackageFile(packageRoot, path, expectedSha256) {
  const source = await confinedProjectPath(packageRoot, path, {type: "file"});
  if (expectedSha256 && await sha256File(source) !== expectedSha256) {
    throw new Error(`Sunburst checksum mismatch: ${path}`);
  }
  return source;
}

async function exclusiveCopy(source, destination, createdFiles) {
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  createdFiles.push(destination);
}

async function rollbackCreatedFiles(createdFiles) {
  for (const path of createdFiles.reverse()) {
    try {
      await unlink(path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

export async function loadSunburstPackage(workspaceRoot) {
  const packageRoot = join(workspaceRoot, "Brand", "Sunburst");
  const manifestPath = await confinedProjectPath(packageRoot, "manifest.json", {type: "file"});
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || !manifest.id || !manifest.version || !Array.isArray(manifest.fonts) || !Array.isArray(manifest.assets)) {
    throw new Error("Invalid Sunburst package manifest");
  }

  const framePath = await checkedPackageFile(packageRoot, manifest.frame);
  const fonts = await Promise.all(manifest.fonts.map(async (font) => ({
    ...font,
    sourcePath: await checkedPackageFile(packageRoot, font.path, font.sha256),
    sourceLicencePath: await checkedPackageFile(packageRoot, font.licencePath, font.licenceSha256),
  })));
  const assets = await Promise.all(manifest.assets.map(async (asset) => ({
    ...asset,
    sourcePath: await checkedPackageFile(packageRoot, asset.path, asset.sha256),
  })));

  return {...manifest, kind: "sunburst", packageRoot, framePath, fonts, assets};
}

export async function resolveBrandSource(projectDir, workspaceRoot) {
  projectDir = await realpath(projectDir);
  let framePath;
  try {
    framePath = await confinedProjectPath(projectDir, "frame.md", {type: "file"});
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return loadSunburstPackage(workspaceRoot);
  }

  const fontsDirectory = await confinedProjectPath(projectDir, "Assets/Fonts", {type: "directory"});
  const fontNames = (await readdir(fontsDirectory, {withFileTypes: true}))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  if (fontNames.length === 0) throw new Error("A project frame requires at least one local font");

  const frame = await readFile(framePath, "utf8");
  const fonts = await Promise.all(fontNames.map(async (name) => {
    const sourcePath = await confinedProjectPath(projectDir, join("Assets/Fonts", name), {type: "file"});
    return {family: basename(name, extname(name)), path: projectPath(projectDir, sourcePath), sourcePath};
  }));
  return {
    kind: "project",
    id: frontmatterValue(frame, "id") ?? "project-frame",
    version: frontmatterValue(frame, "version"),
    framePath,
    fonts,
    assets: [],
  };
}

async function freezeFonts(source, projectDir, createdFiles) {
  if (source.kind === "project") {
    const directory = await confinedProjectPath(projectDir, "Plans/Brand/Fonts", {allowMissing: true, type: "directory"});
    await mkdir(directory, {recursive: true});
    await confinedProjectPath(projectDir, "Plans/Brand/Fonts", {type: "directory"});
    const frozen = [];
    for (const font of source.fonts) {
      const destination = await confinedProjectPath(projectDir, join("Plans/Brand/Fonts", basename(font.path)), {allowMissing: true, type: "file"});
      await exclusiveCopy(font.sourcePath, destination, createdFiles);
      frozen.push({
        family: font.family,
        path: projectPath(projectDir, destination),
        sha256: await sha256File(destination),
        weights: null,
        licencePath: null,
        licenceSha256: null,
      });
    }
    return frozen;
  }

  const licenceDirectory = await confinedProjectPath(projectDir, "Plans/Brand/Licences", {allowMissing: true, type: "directory"});
  await mkdir(licenceDirectory, {recursive: true});
  await confinedProjectPath(projectDir, "Plans/Brand/Licences", {type: "directory"});

  const frozen = [];
  for (const font of source.fonts) {
    const destination = await confinedProjectPath(projectDir, join("Assets/Fonts", basename(font.path)), {allowMissing: true, type: "file"});
    const licenceDestination = await confinedProjectPath(projectDir, join("Plans/Brand/Licences", basename(font.licencePath)), {allowMissing: true, type: "file"});
    await exclusiveCopy(font.sourcePath, destination, createdFiles);
    await exclusiveCopy(font.sourceLicencePath, licenceDestination, createdFiles);
    await confinedProjectPath(projectDir, projectPath(projectDir, destination), {type: "file"});
    await confinedProjectPath(projectDir, projectPath(projectDir, licenceDestination), {type: "file"});
    if (await sha256File(destination) !== font.sha256 || await sha256File(licenceDestination) !== font.licenceSha256) {
      throw new Error(`Frozen Sunburst font checksum mismatch: ${font.family}`);
    }
    frozen.push({
      family: font.family,
      path: projectPath(projectDir, destination),
      sha256: font.sha256,
      weights: font.weights,
      licencePath: projectPath(projectDir, licenceDestination),
      licenceSha256: font.licenceSha256,
    });
  }
  return frozen;
}

async function freezeMotifs(source, projectDir, createdFiles) {
  if (source.kind === "project") return [];
  const directory = await confinedProjectPath(projectDir, "Assets/Images/Sunburst", {allowMissing: true, type: "directory"});
  await mkdir(directory, {recursive: true});
  await confinedProjectPath(projectDir, "Assets/Images/Sunburst", {type: "directory"});

  const frozen = [];
  for (const asset of source.assets) {
    const destination = await confinedProjectPath(projectDir, join("Assets/Images/Sunburst", basename(asset.path)), {allowMissing: true, type: "file"});
    await exclusiveCopy(asset.sourcePath, destination, createdFiles);
    await confinedProjectPath(projectDir, projectPath(projectDir, destination), {type: "file"});
    if (await sha256File(destination) !== asset.sha256) throw new Error(`Frozen Sunburst motif checksum mismatch: ${asset.path}`);
    frozen.push({path: projectPath(projectDir, destination), sha256: asset.sha256, sourcePath: asset.sourcePath, bytes: (await stat(destination)).size});
  }
  return frozen;
}

export async function freezeBrandForProject(projectDir, workspaceRoot, coordinatorContext) {
  projectDir = await realpath(projectDir);
  const manifest = await readManifest(projectDir);
  assertCoordinator(manifest, coordinatorContext);
  if (manifest.brand) throw new Error("Project brand is already frozen");

  const source = await resolveBrandSource(projectDir, workspaceRoot);
  const createdFiles = [];
  try {
    const destination = await confinedProjectPath(projectDir, "Plans/Brand", {allowMissing: true, type: "directory"});
    await mkdir(destination, {recursive: true});
    await confinedProjectPath(projectDir, "Plans/Brand", {type: "directory"});
    const framePath = await confinedProjectPath(projectDir, "Plans/Brand/frame.md", {allowMissing: true, type: "file"});
    await exclusiveCopy(source.framePath, framePath, createdFiles);
    await confinedProjectPath(projectDir, "Plans/Brand/frame.md", {type: "file"});

    const fonts = await freezeFonts(source, projectDir, createdFiles);
    const motifs = await freezeMotifs(source, projectDir, createdFiles);
    const frozenAt = new Date().toISOString();
    const record = {
      artifactId: "project-brand-lock-v001",
      id: source.id,
      version: source.version,
      framePath: projectPath(projectDir, framePath),
      frameSha256: await sha256File(framePath),
      fonts,
      motifs: motifs.map(({sourcePath, ...motif}) => motif),
      frozenAt,
    };
    const lockPath = await confinedProjectPath(projectDir, "Plans/Brand/brand-lock.json", {allowMissing: true, type: "file"});
    await writeFile(lockPath, `${JSON.stringify(record, null, 2)}\n`, {encoding: "utf8", flag: "wx"});
    createdFiles.push(lockPath);
    await confinedProjectPath(projectDir, "Plans/Brand/brand-lock.json", {type: "file"});
    const frozen = {...record, lockPath: projectPath(projectDir, lockPath), lockSha256: await sha256File(lockPath)};

    await mutateManifest(projectDir, coordinatorContext, (next) => {
      next.brand = frozen;
      next.assets.push(...motifs.map((motif) => ({
        id: `image-${randomUUID()}`,
        kind: "image",
        path: motif.path,
        sourcePath: motif.sourcePath,
        sha256: motif.sha256,
        bytes: motif.bytes,
        createdAt: frozenAt,
        private: false,
        client: false,
        voiceClone: false,
        licence: null,
        sourceUrl: null,
        model: null,
      })));
      return next;
    });
    return frozen;
  } catch (error) {
    await rollbackCreatedFiles(createdFiles);
    throw error;
  }
}

export async function readFrozenBrand(projectDir) {
  projectDir = await realpath(projectDir);
  const brand = (await readManifest(projectDir)).brand;
  if (!brand?.lockPath || !brand.lockSha256) throw new Error("Project brand is not frozen");
  const lockPath = await confinedProjectPath(projectDir, brand.lockPath, {type: "file"});
  if (await sha256File(lockPath) !== brand.lockSha256) throw new Error("Project brand lock checksum mismatch");
  const record = JSON.parse(await readFile(lockPath, "utf8"));
  const verify = async (path, expectedSha256, label) => {
    if (typeof path !== "string" || typeof expectedSha256 !== "string") throw new Error(`Frozen brand ${label} checksum metadata is missing`);
    const frozenPath = await confinedProjectPath(projectDir, path, {type: "file"});
    if (await sha256File(frozenPath) !== expectedSha256) throw new Error(`Frozen brand ${label} checksum mismatch`);
  };
  await verify(record.framePath, record.frameSha256, "frame");
  if (!Array.isArray(record.fonts) || !Array.isArray(record.motifs)) throw new Error("Frozen brand payload inventory is invalid");
  for (const font of record.fonts) {
    await verify(font.path, font.sha256, "font");
    if (font.licencePath !== null || font.licenceSha256 !== null) await verify(font.licencePath, font.licenceSha256, "font licence");
  }
  for (const motif of record.motifs) await verify(motif.path, motif.sha256, "motif");
  return {...record, lockPath: brand.lockPath, lockSha256: brand.lockSha256};
}
