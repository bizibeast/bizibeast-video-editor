import {constants} from "node:fs";
import {access, readdir, readFile, statfs} from "node:fs/promises";
import {delimiter, join} from "node:path";

async function defaultPathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function defaultResolveCommand(command) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const path = join(directory, command);
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Continue through PATH.
    }
  }
  return null;
}

async function defaultListApplications() {
  try {
    return await readdir("/Applications");
  } catch {
    return [];
  }
}

async function defaultFreeBytes(root) {
  const stats = await statfs(root);
  return Number(stats.bavail) * Number(stats.bsize);
}

async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function app(names, prefix) {
  const name = names.find((candidate) => candidate.toLowerCase().startsWith(prefix.toLowerCase()));
  return name ? {status: "installed", path: join("/Applications", name)} : {status: "missing", path: null};
}

export async function runDoctor(root, overrides = {}) {
  const resolveCommand = overrides.resolveCommand ?? defaultResolveCommand;
  const listApplications = overrides.listApplications ?? defaultListApplications;
  const pathExists = overrides.pathExists ?? defaultPathExists;
  const freeBytes = overrides.freeBytes ?? defaultFreeBytes;
  const commandNames = ["node", "npm", "ffmpeg", "ffprobe", "python3", "uv", "npx", "dapi"];
  const commandEntries = await Promise.all(commandNames.map(async (name) => {
    const path = await resolveCommand(name);
    return [name, {status: path ? "installed" : "missing", path}];
  }));
  const commands = Object.fromEntries(commandEntries);
  if (commands.dapi.status === "missing") {
    const localDapi = join(root, "scripts", "integrations", "dapi-local.sh");
    if (await pathExists(localDapi)) commands.dapi = {status: "installed", path: localDapi};
  }
  const applicationNames = await listApplications();
  const apps = {
    premiere: app(applicationNames, "Adobe Premiere Pro 2026"),
    afterEffects: app(applicationNames, "Adobe After Effects 2026"),
    mediaEncoder: app(applicationNames, "Adobe Media Encoder 2026"),
    diffusionStudio: app(applicationNames, "Diffusion Studio"),
  };

  const integrationConfig = await readJsonIfPresent(join(root, "config", "integrations.json"));
  const integrationPaths = {
    premiere: join(root, "Tools", "premiere-pro-mcp"),
    diffusionStudio: join(root, "Tools", "diffusion-studio"),
    afterEffects: join(root, "Tools", "after-effects-mcp"),
    hyperframes: join(root, "Tools", "hyperframes"),
  };
  const integrationEntries = await Promise.all(Object.entries(integrationPaths).map(async ([id, path]) => {
    const configured = integrationConfig?.integrations?.[id];
    return [id, {
      status: await pathExists(configured?.path ?? path) ? "installed" : "missing",
      path: configured?.path ?? path,
      version: configured?.version ?? null,
      revision: configured?.revision ?? null,
      verdict: configured?.verdict ?? null,
      runtimeInstalled: configured?.runtimeInstalled ?? null,
      connectorInstalled: configured?.connectorInstalled ?? null,
      liveVerified: Boolean(configured?.liveVerified),
      verifiedAt: configured?.verifiedAt ?? null,
      note: configured?.note ?? null,
    }];
  }));
  const integrations = Object.fromEntries(integrationEntries);

  const modelConfig = await readJsonIfPresent(join(root, "config", "local-models.json"));
  const models = [];
  for (const model of modelConfig?.models ?? []) {
    const marker = join(root, "Models", "installed", `${model.role}.json`);
    models.push({...model, status: await pathExists(marker) ? "installed" : "missing", marker});
  }

  const diskFreeBytes = await freeBytes(root);
  const coreReady = ["node", "ffmpeg", "ffprobe"].every((name) => commands[name].status === "installed");
  const premiereReady = apps.premiere.status === "installed" && integrations.premiere.status === "installed" && integrations.premiere.liveVerified;
  return {
    checkedAt: new Date().toISOString(),
    root,
    policy: {
      localOnly: true,
      cloudInference: false,
      hostedImageGenerationOptIn: true,
      paidServices: false,
      uploadsProjectMedia: false,
    },
    commands,
    apps,
    integrations,
    models,
    disk: {freeBytes: diskFreeBytes, freeGiB: Math.round((diskFreeBytes / 1024 ** 3) * 10) / 10},
    ready: coreReady && premiereReady,
  };
}
