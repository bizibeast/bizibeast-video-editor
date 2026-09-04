#!/usr/bin/env node
import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {parseArgs, print} from "./args.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseToolData(result) {
  const block = result?.content?.find(({type}) => type === "text");
  if (!block) throw new Error("Premiere MCP returned no text result");
  let parsed;
  try { parsed = JSON.parse(block.text); } catch { throw new Error("Premiere MCP returned invalid JSON"); }
  if (parsed.success === false) throw new Error(parsed.error || "Premiere tool failed");
  return parsed.data ?? parsed;
}

export function assertLiveReport(report) {
  if (report?.overall !== "ready" || report?.safeCheck?.readOnly !== true) throw new Error("Premiere is not live-ready with an active project and sequence; no edit was attempted");
  return report;
}

class StdioMcpClient {
  constructor(bin) {
    this.bin = bin;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
  }

  async start() {
    this.child = spawn(this.bin, [], {
      cwd: repo,
      stdio: ["pipe", "pipe", "inherit"],
      env: {...process.env, PREMIERE_MCP_CAPABILITIES: "inspect,edit,export,filesystem", PREMIERE_MCP_TRANSPORT: "stdio", DO_NOT_TRACK: "1"}
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message || "MCP request failed"));
        else pending.resolve(message.result);
      }
    });
    this.child.on("exit", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("Premiere MCP process exited"));
      this.pending.clear();
    });
    await this.request("initialize", {protocolVersion: "2025-11-25", capabilities: {}, clientInfo: {name: "bizibeast-video-editor", version: "0.1.0"}});
    this.child.stdin.write(`${JSON.stringify({jsonrpc: "2.0", method: "notifications/initialized"})}\n`);
    return this;
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Premiere MCP ${method} timed out`));
      }, 15_000);
      this.pending.set(id, {resolve, reject, timer});
      this.child.stdin.write(`${JSON.stringify({jsonrpc: "2.0", id, method, params})}\n`);
    });
  }

  call(name, args = {}) {
    return this.request("tools/call", {name, arguments: args});
  }

  close() {
    this.child.stdin.end();
    this.child.kill();
  }
}

export async function withPremiere(operation) {
  const bin = path.join(repo, "node_modules/.bin/premiere-pro-mcp");
  const client = await new StdioMcpClient(bin).start();
  try { return await operation(client); }
  finally { client.close(); }
}

export async function verifyPremiere() {
  return withPremiere(async (client) => assertLiveReport(parseToolData(await client.call("verify_premiere_connection", {backend: "cep"}))));
}

export async function readbackPremiere() {
  return withPremiere(async (client) => {
    const connection = assertLiveReport(parseToolData(await client.call("verify_premiere_connection", {backend: "cep"})));
    const project = parseToolData(await client.call("get_project_info"));
    const sequence = parseToolData(await client.call("get_active_sequence"));
    return {schemaVersion: 1, capturedAt: new Date().toISOString(), connection, project, sequence};
  });
}

async function main() {
  const {flags, positional} = parseArgs(process.argv.slice(2));
  const command = positional[0];
  let result;
  if (command === "verify") result = await verifyPremiere();
  else if (command === "readback") result = await readbackPremiere();
  else if (command === "edit") {
    if (typeof flags.tool !== "string" || typeof flags.input !== "string") throw new Error("Edit requires --tool and --input");
    if (/script/i.test(flags.tool)) throw new Error("Arbitrary Premiere scripting is not allowed");
    const args = JSON.parse(await readFile(path.resolve(flags.input), "utf8"));
    result = await withPremiere(async (client) => {
      assertLiveReport(parseToolData(await client.call("verify_premiere_connection", {backend: "cep"})));
      const edit = parseToolData(await client.call(flags.tool, args));
      const sequence = parseToolData(await client.call("get_active_sequence"));
      return {edit, sequence};
    });
  } else throw new Error("Usage: premiere.mjs verify|readback|edit [--tool name --input args.json] [--output receipt.json] [--json]");
  if (flags.output) {
    const body = `${JSON.stringify(result, null, 2)}\n`;
    await writeFile(path.resolve(flags.output), body, {flag: "wx"});
    result = {receipt: path.resolve(flags.output), sha256: createHash("sha256").update(body).digest("hex"), result};
  }
  print(result, flags.json);
}

if (process.argv[1]?.endsWith("premiere.mjs")) main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
});
