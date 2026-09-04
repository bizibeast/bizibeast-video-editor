import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {promisify} from "node:util";
import test from "node:test";

const skillRoot = join(import.meta.dirname, "../plugins/content-hub-editor/skills/content-hub-editor");
const cliPath = join(import.meta.dirname, "../bin/content-hub.mjs");
const execFileAsync = promisify(execFile);

test("plugin separates production, approval, execution, QC, promotion, and final-only delivery", async () => {
  const [skill, reference, prompt] = await Promise.all([
    readFile(join(skillRoot, "SKILL.md"), "utf8"),
    readFile(join(skillRoot, "references/video-pipeline.md"), "utf8"),
    readFile(join(skillRoot, "agents/openai.yaml"), "utf8"),
  ]);
  for (const phrase of ["Script/Editorial Agent", "Subject Analyst", "Design Approver", "Premiere Executor", "Creative QC Reviewer", "producerActorId != creativeReviewerActorId"]) assert.match(skill, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  for (const phrase of ["local-only", "0.8.25", "Premiere Executor", "Technical QC", "Release Promoter", "listFinalDeliverables", "no external publish", "installed", "live verified"]) assert.match(reference, new RegExp(phrase, "iu"));
  assert.match(prompt, /BiziBeast Video Producer/u);
  assert.match(prompt, /passing final deliverables/u);
});

test("video CLI lists every relay and rejects unknown flags including Premiere adapter authority", async () => {
  const cli = await readFile(cliPath, "utf8");
  for (const command of ["video-index", "video-transcribe", "video-story", "video-subject", "video-assets", "video-caption",
    "video-foreground", "video-design", "video-design-approve", "video-execution", "video-candidate"]) assert.match(cli, new RegExp(`"${command}"`, "u"));
  await assert.rejects(execFileAsync(process.execPath, [cliPath, "video-index", "missing", "raw-1", "--input", "missing.json",
    "--actor-id", "media-1", "--coordinator-id", "coord-1", "--reason", "index", "--bogus"]), /Unknown flag --bogus/u);
  await assert.rejects(execFileAsync(process.execPath, [cliPath, "video-execution", "premiere", "missing", "raw-1", "--input", "missing.json",
    "--actor-id", "premiere-1", "--adapter", "forged.json"]), /Unknown flag --adapter/u);
});
