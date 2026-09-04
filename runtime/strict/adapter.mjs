#!/usr/bin/env node
import {spawn} from "node:child_process";
import {access} from "node:fs/promises";
import path from "node:path";

const runtime = process.env.BIZIBEAST_STRICT_RUNTIME;
if (!runtime) {
  process.stderr.write("Strict mode needs BIZIBEAST_STRICT_RUNTIME pointing to a compatible Content Hub runtime checkout.\n");
  process.exit(2);
}
const cli = path.join(path.resolve(runtime), "bin/content-hub.mjs");
try {
  await access(cli);
  const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {stdio: "inherit", env: process.env});
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
} catch (error) {
  process.stderr.write(`Strict runtime unavailable: ${error.message}\n`);
  process.exitCode = 2;
}
