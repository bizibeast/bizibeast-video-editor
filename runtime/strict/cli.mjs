#!/usr/bin/env node
import {readFile} from "node:fs/promises";
import path from "node:path";
import {parseArgs, print} from "../../scripts/args.mjs";
import * as strict from "./core.mjs";

const actions = Object.freeze({
  init: strict.initStrict,
  artifact: strict.createArtifact,
  approve: strict.approveArtifact,
  transition: strict.transition,
  freeze: strict.freezeCandidate,
  "technical-qc": strict.technicalQc,
  "creative-qc": strict.creativeQc,
  release: strict.promoteCandidate
});
const {flags, positional} = parseArgs(process.argv.slice(2));
try {
  const [command, project] = positional;
  if (command === "doctor") {
    print({ok: true, runtime: "bundled", features: ["immutable-artifacts", "role-approvals", "workflow", "candidate-freeze", "retry", "technical-qc", "creative-qc", "release-evidence"]}, flags.json);
  } else {
    if (!actions[command] || !project || typeof flags.input !== "string") throw new Error("Usage: cli.mjs <command> <project> --input input.json [--json]");
    const input = JSON.parse(await readFile(path.resolve(flags.input), "utf8"));
    print(await actions[command](path.resolve(project), input), flags.json);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
