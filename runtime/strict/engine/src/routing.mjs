import {mutateManifest} from "./manifest.mjs";
import {normalizeEditorRoutes} from "./project.mjs";

const MODES = new Set(["semi-autonomous", "autonomous"]);

export async function updateRoute(projectDir, {editors, mode}, coordinatorContext) {
  if (!MODES.has(mode)) throw new Error("Mode must be semi-autonomous or autonomous");
  return mutateManifest(projectDir, coordinatorContext, (manifest) => {
    manifest.editors = normalizeEditorRoutes(editors);
    manifest.mode = mode;
    return manifest;
  });
}
