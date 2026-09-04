import {lstat, realpath} from "node:fs/promises";
import {isAbsolute, join, relative, resolve, sep} from "node:path";

export const REQUIRED_PROJECT_PATHS = Object.freeze([
  "Plans",
  "Source",
  "Assets/Images",
  "Assets/Music",
  "Assets/SFX",
  "Assets/Voice",
  "Assets/Templates",
  "Assets/Fonts",
  "Assets/LUTs",
  "Editors/Premiere",
  "Editors/After-Effects",
  "Editors/Diffusion-Studio",
  "Editors/HyperFrames",
  "Editors/Remotion",
  "Renders/Shots",
  "Renders/Proxies",
  "Renders/Captions",
  "Renders/Candidates",
  "Renders/Carousels",
  "QC",
  "Final/Masters",
  "Final/Deliverables",
  "Final/Deliverables/Carousels",
]);

export function projectsRoot(workspaceRoot) {
  return join(workspaceRoot, "Projects");
}

export async function confinedProjectPath(projectDir, relativePath, {allowMissing = false, type} = {}) {
  const root = await realpath(projectDir);
  const target = resolve(root, relativePath);
  const confined = relative(root, target);
  if (confined === ".." || confined.startsWith(`..${sep}`) || isAbsolute(confined)) {
    throw new Error("Project path must stay under the real project directory");
  }

  let current = root;
  const components = confined.split(sep).filter(Boolean);
  for (const [index, component] of components.entries()) {
    current = resolve(current, component);
    let status;
    try {
      status = await lstat(current);
    } catch (error) {
      if (allowMissing && error?.code === "ENOENT") return target;
      throw error;
    }
    if (status.isSymbolicLink()) throw new Error("Project path cannot contain symlinks");
    if (index < components.length - 1 && !status.isDirectory()) throw new Error("Project path parent must be a directory");
    if (index === components.length - 1 && type === "file" && !status.isFile()) throw new Error("Project path must be a regular file");
    if (index === components.length - 1 && type === "directory" && !status.isDirectory()) throw new Error("Project path must be a directory");
  }
  return target;
}
