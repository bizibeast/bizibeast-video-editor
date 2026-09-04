import {randomUUID} from "node:crypto";
import {stat} from "node:fs/promises";
import {isAbsolute, relative, resolve} from "node:path";

import {sha256File} from "./checksum.mjs";
import {readManifest, mutateManifest} from "./manifest.mjs";

const OUTPUTS = Object.freeze({
  render: {manifestKey: "renders", prefix: "Renders/"},
  deliverable: {manifestKey: "deliverables", prefix: "Final/"},
});

export async function recordOutput(projectDir, {kind, path, editor = null, sourceId = null}, coordinatorContext) {
  const config = OUTPUTS[kind];
  if (!config) throw new Error("Output kind must be render or deliverable");
  const project = resolve(projectDir);
  const absolutePath = resolve(path);
  const projectPath = relative(project, absolutePath).split("\\").join("/");
  if (!projectPath || projectPath.startsWith("../") || isAbsolute(projectPath)) {
    throw new Error("Output file must be inside the project");
  }
  if (!projectPath.startsWith(config.prefix)) {
    throw new Error(`${kind} output must live under ${config.prefix}`);
  }
  const info = await stat(absolutePath);
  if (!info.isFile()) throw new Error(`Output is not a regular file: ${absolutePath}`);
  const sha256 = await sha256File(absolutePath);
  const existing = (await readManifest(project))[config.manifestKey].find((record) => record.path === projectPath && record.sha256 === sha256);
  if (existing) return existing;
  const record = {
    id: `${kind}-${randomUUID()}`,
    kind,
    path: projectPath,
    sha256,
    bytes: info.size,
    editor,
    sourceId,
    createdAt: new Date().toISOString(),
  };
  let saved = record;
  await mutateManifest(project, coordinatorContext, (manifest) => {
    saved = manifest[config.manifestKey].find((entry) => entry.path === projectPath && entry.sha256 === sha256) ?? record;
    if (saved === record) manifest[config.manifestKey].push(record);
    return manifest;
  });
  return saved;
}
