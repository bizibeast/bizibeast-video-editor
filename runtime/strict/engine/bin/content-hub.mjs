#!/usr/bin/env node

import {readFile} from "node:fs/promises";
import {isAbsolute, join, resolve} from "node:path";

import {recordApproval} from "../src/approvals.mjs";
import {writeCaptionBundle} from "../src/captions.mjs";
import {freezeCandidateBundle, verifyCandidateBundle} from "../src/candidates.mjs";
import {runCarouselTechnicalQc} from "../src/carousel-qc.mjs";
import {recordCreativeReview} from "../src/creative-qc.mjs";
import {runDoctor} from "../src/doctor.mjs";
import {ingestFiles} from "../src/ingest.mjs";
import {assertCoordinator, migrateProject, readManifest} from "../src/manifest.mjs";
import {recordOutput} from "../src/output-records.mjs";
import {promoteAsset} from "../src/promote.mjs";
import {createProject} from "../src/project.mjs";
import {runCandidateTechnicalQc, runQc} from "../src/qc.mjs";
import {markDelivered, promotePassingBundle, recordRelease} from "../src/release.mjs";
import {updateRoute} from "../src/routing.mjs";
import {getProjectStatus, listFinalDeliverables} from "../src/status.mjs";
import {freezeBrandForProject} from "../src/sunburst.mjs";
import {authorizeVoice} from "../src/voice-authorization.mjs";
import {runVideoStage} from "../src/video-pipeline.mjs";
import {
  approveScriptRevision,
  loadScriptArtifact,
  requireApprovedScript,
  writeScriptRevision,
} from "../src/video-script.mjs";
import {createWorkItem, readWorkflowState, transitionProject, transitionWorkItem} from "../src/workflow.mjs";

function parse(argv) {
  const [command, ...tokens] = argv;
  const positional = [];
  const flags = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    if (inlineValue !== undefined) flags[rawKey] = inlineValue;
    else if (tokens[index + 1] && !tokens[index + 1].startsWith("--")) flags[rawKey] = tokens[++index];
    else flags[rawKey] = true;
  }
  return {command, positional, flags};
}

function help() {
  return [
    "Usage:",
    "  content-hub new <name> [--editors list] [--mode mode] [--aspect ratio] [--actor coordinator-id] [--json]",
    "  content-hub migrate <project> --actor coordinator-id [--json]",
    "  content-hub brand-freeze <project> --actor <actor-id> [--json]",
    "  content-hub project-state <project> --to state --reason text --actor coordinator-id [--json]",
    "  content-hub work-create <project> --id id --title text --modality modality --actor coordinator-id [--json]",
    "  content-hub work-transition <project> <work-item-id> --to state --reason text --actor coordinator-id [--artifact id:sha256] [--return-to state] [--json]",
    "  content-hub approve <project> --input approval.json --actor coordinator-id [--json]",
    "  content-hub candidate-freeze <project> --input candidate-input.json --actor coordinator-id [--json]",
    "  content-hub candidate-verify <project> --bundle bundle.json [--json]",
    "  content-hub qc-candidate <project> --bundle bundle.json --input qc-input.json --validator actor-id [--json]",
    "  content-hub qc-carousel <project> --bundle bundle.json --input qc-input.json --validator actor-id [--json]",
    "  content-hub creative-review <project> --bundle bundle.json --technical technical-qc.json --input review.json --reviewer actor-id [--json]",
    "  content-hub release <project> --bundle bundle.json --technical technical-qc.json --creative creative-qc.json --actor release-promoter-id --coordinator coordinator-id [--json]",
    "  content-hub deliver <project> <work-item-id> --actor coordinator-id [--json]",
    "  content-hub ingest <project> <files...> --kind source|image|music|sfx|voice|font|lut --actor coordinator-id [--voice-clone] [--private] [--client] [--licence text] [--json]",
    "  content-hub route <project> --editors list --mode mode --actor coordinator-id [--json]",
    "  content-hub status <project> [--json]",
    "  content-hub captions <project> --input transcript.json [--style clean|editorial-pair|punch|karaoke-pair] [--anchor-plan file.json] [--max-words count] [--max-chars count] [--json]",
    "  content-hub promote <project> <asset-id> --actor coordinator-id [--shared-root path] [--json]",
    "  content-hub qc <project> --input file [--json]",
    "  content-hub doctor [--json]",
    "  content-hub authorize-voice <project> <asset-id> --subject text --basis text --actor coordinator-id [--json]",
    "  content-hub record-output <project> <file> --kind render|deliverable --actor coordinator-id [--editor id] [--source-id id] [--json]",
    "  content-hub video-script draft <project> <work-item-id> --input script.md --actor-id script-actor [--revision n] [--json]",
    "  content-hub video-script approve <project> <work-item-id> --artifact-id script:<work-item-id>:vNNN:<identity-hash> --sha256 hash --approver human-id --coordinator-id coordinator-id [--json]",
    "  content-hub video-script verify <project> <work-item-id> --artifact-id script:<work-item-id>:vNNN:<identity-hash> --sha256 hash [--json]",
    "  content-hub video-narrate <project> <work-item-id> --input stage.json --actor-id actor --coordinator-id coordinator --reason text [--json]",
    "  content-hub video-index <project> <work-item-id> --input stage.json --actor-id actor --coordinator-id coordinator --reason text [--json]",
    "  content-hub video-transcribe <project> <work-item-id> --input stage.json --actor-id actor --coordinator-id coordinator --reason text [--json]",
    "  content-hub video-story <project> <work-item-id> --input stage.json --actor-id actor --coordinator-id coordinator --reason text [--json]",
    "  content-hub video-subject <project> <work-item-id> --input stage.json --actor-id actor [--json]",
    "  content-hub video-assets <project> <work-item-id> --input stage.json --actor-id actor --coordinator-id coordinator [--json]",
    "  content-hub video-caption <project> <work-item-id> --input stage.json --actor-id actor [--json]",
    "  content-hub video-foreground <project> <work-item-id> --input stage.json --actor-id actor [--json]",
    "  content-hub video-design <project> <work-item-id> --input stage.json --actor-id actor --coordinator-id coordinator --reason text [--json]",
    "  content-hub video-design-approve <project> <work-item-id> --input stage.json --actor-id actor --coordinator-id coordinator --reason text [--json]",
    "  content-hub video-execution plan|hyperframes|premiere <project> <work-item-id> --input stage.json --actor-id actor [--coordinator-id coordinator --reason text] [--json]",
    "  content-hub video-candidate <project> <work-item-id> --input stage.json --actor-id coordinator --coordinator-id coordinator --reason text [--json]",
  ].join("\n");
}

function coordinatorContext(flags) {
  if (typeof flags.actor !== "string" || !flags.actor.trim()) throw new Error("--actor is required for state changes");
  return {actorId: flags.actor.trim(), actorRole: "coordinator"};
}

function coordinatorIdContext(actorId) {
  if (typeof actorId !== "string" || !actorId.trim()) throw new Error("--coordinator is required for release");
  return {actorId: actorId.trim(), actorRole: "coordinator"};
}

function specialistInput(input, key, actorId, role) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("--input must contain a JSON object");
  if (Object.hasOwn(input, key)) throw new Error(`--input must not include ${key}; use the actor flag`);
  if (typeof actorId !== "string" || !actorId.trim()) throw new Error(`--${key} is required`);
  const normalized = {...input, [key]: {actorId: actorId.trim(), role}};
  if (normalized.parentHashes && !(normalized.parentHashes instanceof Map)) {
    if (typeof normalized.parentHashes !== "object" || Array.isArray(normalized.parentHashes)) throw new Error("parentHashes must be a JSON object");
    normalized.parentHashes = new Map(Object.entries(normalized.parentHashes));
  }
  return normalized;
}

function artifactRef(value) {
  if (value === undefined) return undefined;
  const match = /^([^:]+):([a-f0-9]{64})$/u.exec(value);
  if (!match) throw new Error("--artifact must be <id>:<sha256>");
  return {id: match[1], sha256: match[2]};
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

function projectPath(value) {
  if (isAbsolute(value)) return value;
  if (value.includes("/") || value.startsWith(".")) return resolve(process.cwd(), value);
  return join(process.cwd(), "Projects", value);
}

function print(value, json, summary) {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${summary}\n`);
}

function assertKnownFlags(flags, allowed, action) {
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) throw new Error(`Unknown flag --${key} for ${action}`);
  }
}

function requiredFlag(flags, key) {
  if (typeof flags[key] !== "string" || !flags[key].trim()) throw new Error(`--${key} is required`);
  return flags[key].trim();
}

function scriptCoordinatorContext(flags) {
  return {actorId: requiredFlag(flags, "coordinator-id"), actorRole: "coordinator"};
}

const VIDEO_COMMANDS = Object.freeze({
  "video-narrate": {kind: "generate-narration", role: "local-media-technician", coordinator: true, transition: true},
  "video-index": {kind: "index-media", role: "local-media-technician", coordinator: true, transition: true},
  "video-transcribe": {kind: "transcribe-sources", role: "local-media-technician", coordinator: true, transition: true},
  "video-story": {kind: "plan-story", role: "story-editor", coordinator: true, transition: true},
  "video-subject": {kind: "analyze-subject", role: "subject-analyst"},
  "video-assets": {kind: "resolve-assets", role: "asset-resolver", coordinator: true},
  "video-caption": {kind: "build-captions", role: "hyperframes-executor"},
  "video-foreground": {kind: "build-foreground", role: "hyperframes-executor"},
  "video-design": {kind: "plan-design", role: "design-director", coordinator: true, transition: true},
  "video-design-approve": {kind: "approve-design", role: "design-approver", coordinator: true, transition: true},
  "video-candidate": {kind: "freeze-candidate", role: "coordinator", coordinator: true, transition: true},
});

const VIDEO_EXECUTION_ACTIONS = Object.freeze({
  plan: {kind: "plan-execution", role: "premiere-executor", coordinator: true, transition: true},
  hyperframes: {kind: "execute-hyperframes", role: "hyperframes-executor"},
  premiere: {kind: "execute-premiere", role: "premiere-executor"},
});

async function runVideoCli(command, positional, flags) {
  let spec = VIDEO_COMMANDS[command];
  let project;
  let workItemId;
  let label = command;
  if (command === "video-execution") {
    const [action, projectValue, workItemValue] = positional;
    spec = VIDEO_EXECUTION_ACTIONS[action];
    if (!spec || positional.length !== 3) throw new Error(help());
    [project, workItemId] = [projectValue, workItemValue];
    label = `${command} ${action}`;
  } else {
    if (!spec || positional.length !== 2) throw new Error(help());
    [project, workItemId] = positional;
  }
  const allowed = new Set(["input", "actor-id", "json"]);
  if (spec.coordinator) allowed.add("coordinator-id");
  if (spec.transition) allowed.add("reason");
  assertKnownFlags(flags, allowed, label);
  const actorId = requiredFlag(flags, "actor-id");
  const input = await readJson(requiredFlag(flags, "input"));
  const coordinator = spec.coordinator ? scriptCoordinatorContext(flags) : null;
  const result = await runVideoStage(projectPath(project), coordinator, {
    kind: spec.kind,
    workItemId,
    actor: {actorId, role: spec.role},
    reason: spec.transition ? requiredFlag(flags, "reason") : undefined,
    input,
  });
  print(result, flags.json, `Completed ${label} for ${workItemId}`);
}

async function main() {
  const {command, positional, flags} = parse(process.argv.slice(2));

  if (VIDEO_COMMANDS[command] || command === "video-execution") {
    await runVideoCli(command, positional, flags);
    return;
  }

  if (command === "video-script") {
    const [action, project, workItemId] = positional;
    if (!new Set(["draft", "approve", "verify"]).has(action) || positional.length !== 3) throw new Error(help());
    const projectDir = projectPath(project);
    if (action === "draft") {
      assertKnownFlags(flags, new Set(["input", "actor-id", "revision", "json"]), action);
      const inputPath = requiredFlag(flags, "input");
      const actorId = requiredFlag(flags, "actor-id");
      const inputBytes = await readFile(resolve(inputPath));
      const text = inputBytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(inputBytes)) throw new Error("--input must be valid UTF-8");
      const revision = flags.revision === undefined ? 1 : Number(flags.revision);
      const result = await writeScriptRevision(projectDir, {
        workItemId,
        revision,
        text,
        producer: {actorId, role: "script-editorial"},
      });
      print(result, flags.json, `Drafted script ${result.artifact.artifactId}`);
      return;
    }

    if (action === "approve") {
      assertKnownFlags(flags, new Set(["artifact-id", "sha256", "approver", "coordinator-id", "json"]), action);
      const artifactId = requiredFlag(flags, "artifact-id");
      const scriptSha256 = requiredFlag(flags, "sha256");
      const approver = requiredFlag(flags, "approver");
      const artifact = await loadScriptArtifact(projectDir, artifactId);
      const result = await approveScriptRevision(projectDir, scriptCoordinatorContext(flags), {
        workItemId: workItemId,
        artifact,
        expectedSha256: scriptSha256,
        approver: {actorId: approver, role: "human"},
      });
      print(result, flags.json, `Approved script ${artifact.artifactId}`);
      return;
    }

    assertKnownFlags(flags, new Set(["artifact-id", "sha256", "json"]), action);
    const result = await requireApprovedScript(projectDir, {
      workItemId,
      scriptArtifactId: requiredFlag(flags, "artifact-id"),
      scriptSha256: requiredFlag(flags, "sha256"),
    });
    print(result, flags.json, `Verified approved script ${result.artifact.artifactId}`);
    return;
  }

  if (command === "new" && positional.length === 1) {
    const result = await createProject(process.cwd(), {
      name: positional[0],
      editors: typeof flags.editors === "string" ? flags.editors.split(",").filter(Boolean) : undefined,
      mode: typeof flags.mode === "string" ? flags.mode : undefined,
      aspect: typeof flags.aspect === "string" ? flags.aspect : undefined,
      coordinatorActorId: typeof flags.actor === "string" ? flags.actor.trim() : undefined,
    });
    print(result, flags.json, `Created ${result.projectDir}`);
    return;
  }

  if (command === "migrate" && positional.length === 1) {
    const result = await migrateProject(projectPath(positional[0]), coordinatorContext(flags));
    print(result, flags.json, `Migrated ${result.slug}`);
    return;
  }

  if (command === "brand-freeze" && positional.length === 1) {
    const result = await freezeBrandForProject(projectPath(positional[0]), process.cwd(), coordinatorContext(flags));
    print(result, flags.json, `Frozen brand ${result.id}`);
    return;
  }

  if (command === "project-state" && positional.length === 1 && typeof flags.to === "string" && typeof flags.reason === "string") {
    const result = await transitionProject(projectPath(positional[0]), coordinatorContext(flags), {
      to: flags.to,
      reason: flags.reason,
    });
    print(result, flags.json, `Project state is ${result.projectState}`);
    return;
  }

  if (command === "work-create" && positional.length === 1 && typeof flags.id === "string" && typeof flags.title === "string" && typeof flags.modality === "string") {
    const result = await createWorkItem(projectPath(positional[0]), coordinatorContext(flags), {
      id: flags.id,
      title: flags.title,
      modality: flags.modality,
    });
    print(result, flags.json, `Created work item ${result.id}`);
    return;
  }

  if (command === "work-transition" && positional.length === 2 && typeof flags.to === "string" && typeof flags.reason === "string") {
    const result = await transitionWorkItem(projectPath(positional[0]), coordinatorContext(flags), {
      workItemId: positional[1],
      to: flags.to,
      reason: flags.reason,
      artifactRef: artifactRef(flags.artifact),
      returnTo: typeof flags["return-to"] === "string" ? flags["return-to"] : undefined,
    });
    print(result, flags.json, `Work item ${positional[1]} is ${flags.to}`);
    return;
  }

  if (command === "approve" && positional.length === 1 && typeof flags.input === "string") {
    const result = await recordApproval(projectPath(positional[0]), coordinatorContext(flags), await readJson(flags.input));
    print(result, flags.json, `Recorded approval ${result.id}`);
    return;
  }

  if (command === "candidate-freeze" && positional.length === 1 && typeof flags.input === "string") {
    const result = await freezeCandidateBundle(projectPath(positional[0]), coordinatorContext(flags), await readJson(flags.input));
    print(result, flags.json, `Frozen candidate ${result.bundleHash}`);
    return;
  }

  if (command === "candidate-verify" && positional.length === 1 && typeof flags.bundle === "string") {
    const result = await verifyCandidateBundle(projectPath(positional[0]), resolve(flags.bundle));
    print(result, flags.json, `Verified candidate ${result.bundleHash}`);
    return;
  }

  if (command === "qc-candidate" && positional.length === 1 && typeof flags.bundle === "string" && typeof flags.input === "string") {
    const input = specialistInput(await readJson(flags.input), "validator", flags.validator, "technical-qc-validator");
    const result = await runCandidateTechnicalQc(projectPath(positional[0]), resolve(flags.bundle), input);
    print(result, flags.json, `Technical QC ${result.payload.pass ? "PASS" : "FAIL"}: ${result.payload.candidateBundleHash}`);
    if (!result.payload.pass) process.exitCode = 2;
    return;
  }

  if (command === "qc-carousel" && positional.length === 1 && typeof flags.bundle === "string" && typeof flags.input === "string") {
    const input = specialistInput(await readJson(flags.input), "validator", flags.validator, "technical-qc-validator");
    const result = await runCarouselTechnicalQc(projectPath(positional[0]), resolve(flags.bundle), input);
    print(result, flags.json, `Carousel QC ${result.payload.pass ? "PASS" : "FAIL"}: ${result.payload.candidateBundleHash}`);
    if (!result.payload.pass) process.exitCode = 2;
    return;
  }

  if (command === "creative-review" && positional.length === 1 && typeof flags.bundle === "string"
    && typeof flags.technical === "string" && typeof flags.input === "string") {
    const input = specialistInput(await readJson(flags.input), "reviewer", flags.reviewer, "creative-qc-reviewer");
    const result = await recordCreativeReview(projectPath(positional[0]), resolve(flags.bundle), resolve(flags.technical), input);
    print(result, flags.json, `Creative QC ${result.payload.pass ? "PASS" : "FAIL"}: ${result.payload.candidateBundleHash}`);
    if (!result.payload.pass) process.exitCode = 2;
    return;
  }

  if (command === "release" && positional.length === 1 && typeof flags.bundle === "string"
    && typeof flags.technical === "string" && typeof flags.creative === "string") {
    const projectDir = projectPath(positional[0]);
    const manifest = await readManifest(projectDir);
    const coordinator = coordinatorIdContext(flags.coordinator);
    assertCoordinator(manifest, coordinator);
    const promoterActorId = typeof flags.actor === "string" ? flags.actor.trim() : "";
    if (promoterActorId === coordinator.actorId) throw new Error("Release promoter must be independent from coordinator");
    const result = await promotePassingBundle(projectDir, resolve(flags.bundle), {
      promoter: {actorId: promoterActorId, role: "release-promoter"},
      technicalEvidencePath: resolve(flags.technical),
      creativeEvidencePath: resolve(flags.creative),
      policyVersion: manifest.orchestration.policyVersion,
    });
    await recordRelease(projectDir, coordinator, result.receiptPath);
    print(result, flags.json, `Released ${result.bundleHash}`);
    return;
  }

  if (command === "deliver" && positional.length === 2) {
    const projectDir = projectPath(positional[0]);
    const result = await listFinalDeliverables(projectDir, positional[1]);
    await markDelivered(projectDir, coordinatorContext(flags), positional[1], `QC/${positional[1]}/v${String((await readWorkflowState(projectDir)).workItems.find(({id}) => id === positional[1])?.revision).padStart(3, "0")}/release-receipt.json`);
    print(result, flags.json, `Delivered ${result.files.length} Final file(s)`);
    return;
  }

  if (command === "ingest" && positional.length >= 2 && typeof flags.kind === "string") {
    const result = await ingestFiles(
      projectPath(positional[0]),
      positional.slice(1).map((path) => resolve(path)),
      flags.kind,
      {
        voiceClone: Boolean(flags["voice-clone"]),
        private: Boolean(flags.private),
        client: Boolean(flags.client),
        licence: typeof flags.licence === "string" ? flags.licence : undefined,
        model: typeof flags.model === "string" ? flags.model : undefined,
        sourceUrl: typeof flags["source-url"] === "string" ? flags["source-url"] : undefined,
      },
      coordinatorContext(flags),
    );
    print(result, flags.json, `Ingested ${result.length} file(s)`);
    return;
  }

  if (command === "route" && positional.length === 1 && typeof flags.editors === "string" && typeof flags.mode === "string") {
    const result = await updateRoute(projectPath(positional[0]), {
      editors: flags.editors.split(",").filter(Boolean),
      mode: flags.mode,
    }, coordinatorContext(flags));
    print(result, flags.json, `Updated ${result.slug} routing`);
    return;
  }

  if (command === "status" && positional.length === 1) {
    const result = await getProjectStatus(projectPath(positional[0]));
    print(result, flags.json, `${result.name}: ${result.counts.sources} source(s), ${result.counts.assets} asset(s)`);
    return;
  }

  if (command === "captions" && positional.length === 1 && typeof flags.input === "string") {
    const result = await writeCaptionBundle(projectPath(positional[0]), resolve(flags.input), {
      style: typeof flags.style === "string" ? flags.style : undefined,
      anchorPlan: typeof flags["anchor-plan"] === "string" ? await readJson(flags["anchor-plan"]) : undefined,
      maxWords: typeof flags["max-words"] === "string" ? Number(flags["max-words"]) : undefined,
      maxChars: typeof flags["max-chars"] === "string" ? Number(flags["max-chars"]) : undefined,
    });
    print(result, flags.json, `Created ${result.count} caption cue(s)`);
    return;
  }

  if (command === "promote" && positional.length === 2) {
    const sharedRoot = typeof flags["shared-root"] === "string" ? resolve(flags["shared-root"]) : join(process.cwd(), "Assets");
    const result = await promoteAsset(projectPath(positional[0]), positional[1], sharedRoot, coordinatorContext(flags));
    print(result, flags.json, `Promoted ${result.absolutePath}`);
    return;
  }

  if (command === "qc" && positional.length === 1 && typeof flags.input === "string") {
    const result = await runQc(projectPath(positional[0]), resolve(flags.input));
    print(result, flags.json, `QC ${result.pass ? "PASS" : "FAIL"}: ${result.input}`);
    if (!result.pass) process.exitCode = 2;
    return;
  }

  if (command === "doctor" && positional.length === 0) {
    const result = await runDoctor(process.cwd());
    print(result, flags.json, result.ready ? "Content Hub is ready" : "Content Hub has missing or unverified dependencies");
    if (!result.ready) process.exitCode = 2;
    return;
  }

  if (command === "authorize-voice" && positional.length === 2 && typeof flags.subject === "string" && typeof flags.basis === "string") {
    const result = await authorizeVoice(projectPath(positional[0]), {
      assetId: positional[1],
      subject: flags.subject,
      basis: flags.basis,
    }, coordinatorContext(flags));
    print(result, flags.json, `Authorized voice asset ${result.assetId}`);
    return;
  }

  if (command === "record-output" && positional.length === 2 && typeof flags.kind === "string") {
    const result = await recordOutput(projectPath(positional[0]), {
      kind: flags.kind,
      path: resolve(positional[1]),
      editor: typeof flags.editor === "string" ? flags.editor : null,
      sourceId: typeof flags["source-id"] === "string" ? flags["source-id"] : null,
    }, coordinatorContext(flags));
    print(result, flags.json, `Recorded ${result.kind} ${result.path}`);
    return;
  }

  throw new Error(help());
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
