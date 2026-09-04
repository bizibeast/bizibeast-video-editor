#!/usr/bin/env node
import {spawn} from "node:child_process";
import {access} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {parseArgs, print} from "./args.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = path.join(repo, "templates/hyperframes");
const templates = Object.freeze({
  title: "compositions/title.html",
  captions: "compositions/animated-captions.html",
  "lower-third": "compositions/lower-third.html",
  layered: "compositions/layered-portrait.html",
  "strict-layered": "compositions/video-shot-layered-portrait.html"
});

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {...options, stdio: "inherit"});
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`HyperFrames exited ${code}`)));
  });
}

export async function render({template = "title", output, variables, variablesFile, dryRun = false} = {}) {
  if (!templates[template]) throw new Error(`Unknown template: ${template}`);
  if (!output) throw new Error("--output is required");
  const bin = path.join(repo, "node_modules/.bin/hyperframes");
  const compositionArg = templates[template];
  const composition = path.join(project, compositionArg);
  const resolvedOutput = path.resolve(output);
  const args = ["render", "-c", compositionArg, "-o", resolvedOutput, "--strict-all"];
  if (path.extname(resolvedOutput).toLowerCase() === ".mov") args.push("--format", "mov");
  if (variables) args.push("--variables", variables);
  if (variablesFile) args.push("--variables-file", path.resolve(variablesFile));
  const result = {command: [bin, ...args], composition, output: resolvedOutput};
  if (dryRun) return result;
  await access(bin);
  await run(bin, args, {cwd: project});
  return result;
}

const {flags} = parseArgs(process.argv.slice(2));
try {
  print(await render({
    template: flags.template,
    output: flags.output,
    variables: flags.variables,
    variablesFile: flags["variables-file"],
    dryRun: Boolean(flags["dry-run"])
  }), flags.json);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
