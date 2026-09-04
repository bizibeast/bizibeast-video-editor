#!/usr/bin/env node
import {spawn} from "node:child_process";
import {access} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const runtime = process.env.BIZIBEAST_STRICT_RUNTIME;
const cli = runtime
  ? path.join(path.resolve(runtime), "bin/content-hub.mjs")
  : path.join(path.dirname(fileURLToPath(import.meta.url)), "engine/bin/content-hub.mjs");
try {
  await access(cli);
  const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {stdio: "inherit", env: process.env, cwd: path.dirname(path.dirname(cli))});
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
} catch (error) {
  process.stderr.write(`Strict runtime unavailable: ${error.message}\n`);
  process.exitCode = 2;
}
