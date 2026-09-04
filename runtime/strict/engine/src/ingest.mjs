import {randomUUID} from "node:crypto";
import {constants} from "node:fs";
import {copyFile, mkdir, stat} from "node:fs/promises";
import {basename, extname, join, relative} from "node:path";

import {sha256File} from "./checksum.mjs";
import {mutateManifest} from "./manifest.mjs";

const KIND_PATHS = Object.freeze({
  source: "Source",
  image: "Assets/Images",
  music: "Assets/Music",
  sfx: "Assets/SFX",
  voice: "Assets/Voice",
  template: "Assets/Templates",
  font: "Assets/Fonts",
  lut: "Assets/LUTs",
});

function versionedName(name, revision) {
  if (revision === 1) return name;
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length);
  return `${stem}-v${String(revision).padStart(3, "0")}${extension}`;
}

async function exclusiveCopy(input, directory) {
  const name = basename(input);
  for (let revision = 1; revision < 10_000; revision += 1) {
    const destination = join(directory, versionedName(name, revision));
    try {
      await copyFile(input, destination, constants.COPYFILE_EXCL);
      return destination;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Too many versions already exist for ${name}`);
}

export async function ingestFiles(projectDir, inputs, kind, options = {}, coordinatorContext) {
  const destinationName = KIND_PATHS[kind];
  if (!destinationName) throw new Error(`Unknown asset kind: ${kind}`);
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("At least one input file is required");

  const destinationDir = join(projectDir, destinationName);
  await mkdir(destinationDir, {recursive: true});
  const records = [];

  for (const input of inputs) {
    const inputStat = await stat(input);
    if (!inputStat.isFile()) throw new Error(`Input is not a regular file: ${input}`);
    const copied = await exclusiveCopy(input, destinationDir);
    const copiedStat = await stat(copied);
    const sha256 = await sha256File(copied);
    const record = {
      id: `${kind}-${randomUUID()}`,
      kind,
      path: relative(projectDir, copied).split("\\").join("/"),
      sourcePath: input,
      sha256,
      bytes: copiedStat.size,
      createdAt: new Date().toISOString(),
      private: Boolean(options.private),
      client: Boolean(options.client),
      voiceClone: Boolean(options.voiceClone),
      licence: options.licence ?? null,
      sourceUrl: options.sourceUrl ?? null,
      model: options.model ?? null,
      originType: options.originType ?? (options.sourceUrl ? "public-url" : "local-file"),
      originalPath: options.originalPath ?? input,
      attribution: options.attribution ?? null,
      usageScope: options.usageScope ?? "project-only",
      privacyClass: options.privacyClass ?? (options.client ? "client" : options.private ? "private" : "public"),
      templateRevision: options.templateRevision ?? null,
      providerRevision: options.providerRevision ?? null,
      prompt: options.prompt ?? null,
      derivatives: options.derivatives ?? [],
      usageIds: options.usageIds ?? [],
    };
    records.push({...record, absolutePath: copied});
  }

  await mutateManifest(projectDir, coordinatorContext, (manifest) => {
    if (kind === "source") manifest.sources.push(...records.map(({absolutePath, ...record}) => record));
    else manifest.assets.push(...records.map(({absolutePath, ...record}) => record));
    return manifest;
  });
  return records;
}
