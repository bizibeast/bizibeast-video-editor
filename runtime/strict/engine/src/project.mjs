import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";

import {initializeManifest} from "./manifest.mjs";
import {projectsRoot, REQUIRED_PROJECT_PATHS} from "./paths.mjs";
import {CURRENT_PROJECT_SCHEMA_VERSION} from "./schema.mjs";

const EDITORS = new Set(["premiere", "diffusion-studio", "after-effects"]);
const MODES = new Set(["semi-autonomous", "autonomous"]);
const FORMATS = Object.freeze({
  "16:9": {width: 1920, height: 1080},
  "9:16": {width: 1080, height: 1920},
  "1:1": {width: 1080, height: 1080},
  "4:5": {width: 1080, height: 1350},
});

export {REQUIRED_PROJECT_PATHS};

export function slugifyProjectName(name) {
  if (typeof name !== "string" || !name.trim() || /[\\/\u0000-\u001f]/u.test(name)) {
    throw new Error("Project name must be non-empty and cannot contain paths or control characters");
  }
  const normalized = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error("Project name must contain letters or numbers");
  }
  return normalized;
}

export function normalizeEditorRoutes(editors = ["premiere"]) {
  const unique = [...new Set(editors)];
  if (unique.length === 0 || unique.some((editor) => !EDITORS.has(editor))) {
    throw new Error("Editors must contain premiere, diffusion-studio, or after-effects");
  }
  const primary = unique.includes("premiere") ? "premiere" : unique[0];
  return unique.map((id) => ({id, role: id === primary ? "primary" : "sidecar"}));
}

export async function createProject(workspaceRoot, options) {
  const name = options?.name?.trim();
  const slug = slugifyProjectName(name);
  const mode = options.mode ?? "semi-autonomous";
  const aspect = options.aspect ?? "16:9";
  if (!MODES.has(mode)) throw new Error("Mode must be semi-autonomous or autonomous");
  if (!FORMATS[aspect]) throw new Error("Aspect must be 16:9, 9:16, 1:1, or 4:5");

  const root = projectsRoot(workspaceRoot);
  await mkdir(root, {recursive: true});
  const projectDir = join(root, slug);
  await mkdir(projectDir, {recursive: false});
  await Promise.all(REQUIRED_PROJECT_PATHS.map((path) => mkdir(join(projectDir, path), {recursive: true})));

  const now = new Date().toISOString();
  const manifest = {
    schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
    name,
    slug,
    createdAt: now,
    updatedAt: now,
    localOnly: true,
    mode,
    format: {...FORMATS[aspect], aspect, fps: 30, audioSampleRate: 48000},
    editors: normalizeEditorRoutes(options.editors),
    sources: [],
    assets: [],
    renders: [],
    voiceAuthorizations: [],
    qc: [],
    deliverables: [],
    orchestration: {
      policyVersion: "bizibeast-v1",
      coordinatorActorId: options.coordinatorActorId ?? "content-hub-coordinator",
      workflowStatePath: "Plans/workflow-state.json",
      approvalsPath: "Plans/approvals.jsonl",
      workflowStateSha256: null,
    },
  };

  await initializeManifest(projectDir, manifest);
  await writeFile(
    join(projectDir, "Plans/workflow-state.json"),
    `${JSON.stringify({schemaVersion: 1, projectState: "DRAFT", workItems: [], events: []}, null, 2)}\n`,
    {encoding: "utf8", flag: "wx"},
  );
  await writeFile(join(projectDir, "Plans/approvals.jsonl"), "", {encoding: "utf8", flag: "wx"});
  await writeFile(
    join(projectDir, "BRIEF.md"),
    `# ${name}\n\n- Mode: ${mode}\n- Editors: ${manifest.editors.map(({id}) => id).join(", ")}\n- Aspect: ${aspect}\n- Inference: local only\n`,
    "utf8",
  );
  return {projectDir, manifest};
}
