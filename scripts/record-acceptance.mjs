#!/usr/bin/env node
import {writeFile, readFile} from "node:fs/promises";
import path from "node:path";
import {parseArgs, print} from "./args.mjs";

function sha(value, label) {
  if (!/^[a-f0-9]{64}$/.test(value || "")) throw new Error(`${label} must be a SHA-256`);
}

export async function recordAcceptance({output, data}) {
  if (!output || !data || !new Set(["quick", "crew", "strict"]).has(data.mode)) throw new Error("Acceptance needs output and a valid mode");
  if (data.premiere?.liveVerified !== true || !data.premiere.sequenceId) throw new Error("Acceptance requires live Premiere sequence readback");
  if (data.premiere.premiereReadbackReceiptSha256 !== null) sha(data.premiere.premiereReadbackReceiptSha256, "Premiere readback");
  else if (data.premiere.captionStructuralReadbackSupported !== false || data.premiere.nativeCaptionVisualVerification !== true) throw new Error("Missing readback receipt must be disclosed and visually verified");
  sha(data.export?.sha256, "Export");
  if (!(data.export.durationSeconds > 0) || data.qc?.technical !== "pass" || data.qc?.creative !== "pass") throw new Error("Acceptance requires a positive export and passing QC");
  const record = {schemaVersion: 1, recordedAt: new Date().toISOString(), ...data};
  await writeFile(path.resolve(output), `${JSON.stringify(record, null, 2)}\n`, {flag: "wx"});
  return record;
}

const {flags} = parseArgs(process.argv.slice(2));
if (process.argv[1]?.endsWith("record-acceptance.mjs")) {
  try {
    if (typeof flags.input !== "string" || typeof flags.output !== "string") throw new Error("Usage: record-acceptance.mjs --input acceptance.json --output record.json [--json]");
    print(await recordAcceptance({output: flags.output, data: JSON.parse(await readFile(path.resolve(flags.input), "utf8"))}), flags.json);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
