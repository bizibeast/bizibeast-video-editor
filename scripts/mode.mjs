#!/usr/bin/env node
import {parseArgs, print} from "./args.mjs";

export const CREW_ROLES = Object.freeze([
  "coordinator",
  "media-technician",
  "story-editor",
  "design-director",
  "hyperframes-executor",
  "premiere-executor",
  "qc-reviewer"
]);

export function resolveRun({mode = "crew", canDelegate = true} = {}) {
  if (!new Set(["quick", "crew", "strict"]).has(mode)) throw new Error("Mode must be quick, crew, or strict");
  if (mode === "quick") return {mode, execution: "single-agent", roles: ["editor"]};
  if (mode === "strict") return {mode, execution: "optional-strict-runtime", roles: CREW_ROLES};
  return {mode, execution: canDelegate ? "delegated" : "sequential", roles: CREW_ROLES};
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const {flags} = parseArgs(process.argv.slice(2));
  try {
    print(resolveRun({mode: flags.mode, canDelegate: flags.delegation !== "unavailable"}), flags.json);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
