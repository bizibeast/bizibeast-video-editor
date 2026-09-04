import {randomUUID} from "node:crypto";
import {mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import {isAbsolute, join, relative} from "node:path";

import {findCurrentApproval, readApprovals} from "./approvals.mjs";
import {createArtifactEnvelope, validateArtifactEnvelope, writeImmutableArtifact} from "./artifacts.mjs";
import {verifyCandidateBundle} from "./candidates.mjs";
import {sha256File} from "./checksum.mjs";
import {readManifest} from "./manifest.mjs";
import {probeMedia} from "./media-probe.mjs";
import {runProcess} from "./process.mjs";
import {confinedProjectPath} from "./paths.mjs";
import {resolveTechnicalProfile} from "./qc-profiles.mjs";
import {observed, qcCheck} from "./qc-check.mjs";
import {validateShortFormPacing} from "./pacing-qc.mjs";
import {assertIndependentReviewer} from "./roles.mjs";
import {validateSubjectCaptionSafety} from "./subject-qc.mjs";

function rel(projectDir, path) {
  return relative(projectDir, path).split("\\").join("/");
}

function parseRanges(text, prefix) {
  const ranges = [];
  const expression = new RegExp(`${prefix}_start:([0-9.]+)(?:[^\\n]*?${prefix}_end:([0-9.]+))?`, "g");
  for (const match of text.matchAll(expression)) {
    ranges.push({start: Number(match[1]), end: match[2] ? Number(match[2]) : null});
  }
  return ranges;
}

function parseLoudness(stderr) {
  const match = stderr.match(/\{\s*"input_i"[\s\S]*?\}/u);
  if (!match) return null;
  try {
    const value = JSON.parse(match[0]);
    return {
      integratedLufs: Number(value.input_i),
      truePeakDb: Number(value.input_tp),
      loudnessRange: Number(value.input_lra),
    };
  } catch {
    return null;
  }
}

async function checkCaptions(projectDir, durationSeconds) {
  const path = join(projectDir, "Renders", "Captions", "captions.json");
  let captions;
  try {
    captions = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {path: null, count: 0, issues: [], warnings: []};
    return {path: rel(projectDir, path), count: 0, issues: [{code: "caption_parse", message: error.message}], warnings: []};
  }
  const segments = Array.isArray(captions) ? captions : captions.segments;
  if (!Array.isArray(segments)) {
    return {path: rel(projectDir, path), count: 0, issues: [{code: "caption_shape", message: "Caption JSON must be an array or contain segments"}], warnings: []};
  }

  const issues = [];
  const warnings = [];
  let previousEnd = 0;
  segments.forEach((segment, index) => {
    const start = Number(segment.start);
    const end = Number(segment.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      issues.push({code: "caption_timing", message: `Caption ${index + 1} has invalid timing`});
      return;
    }
    if (start < previousEnd - 0.01) issues.push({code: "caption_overlap", message: `Caption ${index + 1} overlaps the previous caption`});
    if (end > durationSeconds + 0.05) issues.push({code: "caption_out_of_bounds", message: `Caption ${index + 1} ends after the video`});
    if (String(segment.text ?? "").split(/\r?\n/u).some((line) => line.length > 42)) {
      warnings.push({code: "caption_line_length", message: `Caption ${index + 1} contains a line longer than 42 characters`});
    }
    previousEnd = Math.max(previousEnd, end);
  });
  return {path: rel(projectDir, path), count: segments.length, issues, warnings};
}

function markdown(report) {
  const issueLines = report.issues.length ? report.issues.map(({code, message}) => `- ${code}: ${message}`).join("\n") : "- None";
  const warningLines = report.warnings.length ? report.warnings.map(({code, message}) => `- ${code}: ${message}`).join("\n") : "- None";
  return `# QC ${report.pass ? "PASS" : "FAIL"}\n\n- Input: ${report.input}\n- SHA-256: ${report.sha256}\n- Duration: ${report.durationSeconds.toFixed(3)}s\n- Streams: ${report.streams.video} video, ${report.streams.audio} audio\n- Full decode: ${report.decode.pass ? "pass" : "fail"}\n\n## Issues\n\n${issueLines}\n\n## Warnings\n\n${warningLines}\n`;
}

export async function runQc(projectDir, inputPath) {
  const qcDir = join(projectDir, "QC");
  await mkdir(qcDir, {recursive: true});
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const jsonPath = join(qcDir, `qc-${stamp}.json`);
  const markdownPath = join(qcDir, `qc-${stamp}.md`);
  const contactSheetPath = join(qcDir, `contact-sheet-${stamp}.jpg`);
  const issues = [];
  const warnings = [];
  const sha256 = await sha256File(inputPath);

  let probe;
  try {
    probe = await probeMedia(inputPath);
  } catch (error) {
    probe = {durationSeconds: 0, video: [], audio: [], formatName: null, sizeBytes: 0};
    issues.push({code: "probe_failed", message: error.message});
  }

  if (probe.video.length === 0) issues.push({code: "missing_video", message: "No video stream found"});
  if (probe.audio.length === 0) issues.push({code: "missing_audio", message: "No audio stream found"});

  const decodeResult = await runProcess("ffmpeg", ["-v", "error", "-i", inputPath, "-f", "null", "-"]);
  const decode = {pass: decodeResult.code === 0, error: decodeResult.code === 0 ? null : decodeResult.stderr.trim()};
  if (!decode.pass) issues.push({code: "decode_failed", message: decode.error || "FFmpeg could not decode the complete file"});

  let contactSheet = null;
  let blackFrames = [];
  if (probe.video.length > 0) {
    const interval = Math.max(probe.durationSeconds / 6, 0.1);
    const sheetResult = await runProcess("ffmpeg", [
      "-v", "error", "-i", inputPath,
      "-vf", `fps=1/${interval},scale=320:-1,tile=3x2:padding=2:margin=2`,
      "-frames:v", "1", "-q:v", "3", "-y", contactSheetPath,
    ]);
    if (sheetResult.code === 0) contactSheet = rel(projectDir, contactSheetPath);
    else warnings.push({code: "contact_sheet_failed", message: sheetResult.stderr.trim()});

    const blackResult = await runProcess("ffmpeg", [
      "-hide_banner", "-nostats", "-i", inputPath,
      "-vf", "blackdetect=d=0.5:pix_th=0.10", "-an", "-f", "null", "-",
    ]);
    blackFrames = parseRanges(blackResult.stderr, "black");
    if (blackFrames.length > 0) warnings.push({code: "black_frames", message: `${blackFrames.length} black interval(s) detected`});
  }

  let silence = [];
  let loudness = null;
  if (probe.audio.length > 0) {
    const silenceResult = await runProcess("ffmpeg", [
      "-hide_banner", "-nostats", "-i", inputPath,
      "-af", "silencedetect=noise=-50dB:d=1", "-vn", "-f", "null", "-",
    ]);
    silence = parseRanges(silenceResult.stderr, "silence");
    if (silence.length > 0) warnings.push({code: "silence", message: `${silence.length} long silent interval(s) detected`});

    const loudnessResult = await runProcess("ffmpeg", [
      "-hide_banner", "-nostats", "-i", inputPath, "-vn",
      "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json",
      "-f", "null", "-",
    ]);
    loudness = parseLoudness(loudnessResult.stderr);
    if (!loudness) warnings.push({code: "loudness_unavailable", message: "Loudness measurement could not be parsed"});
    else if (loudness.truePeakDb > -1) issues.push({code: "true_peak", message: `True peak ${loudness.truePeakDb} dBTP exceeds -1 dBTP`});
  }

  const captions = await checkCaptions(projectDir, probe.durationSeconds);
  issues.push(...captions.issues);
  warnings.push(...captions.warnings);

  const report = {
    id: `qc-${randomUUID()}`,
    createdAt: new Date().toISOString(),
    input: rel(projectDir, inputPath),
    sha256,
    pass: issues.length === 0,
    durationSeconds: probe.durationSeconds,
    formatName: probe.formatName,
    sizeBytes: probe.sizeBytes,
    streams: {video: probe.video.length, audio: probe.audio.length},
    decode,
    blackFrames,
    silence,
    loudness,
    captions: {path: captions.path, count: captions.count},
    issues,
    warnings,
    files: {
      json: rel(projectDir, jsonPath),
      markdown: rel(projectDir, markdownPath),
      contactSheet,
    },
  };

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, {encoding: "utf8", flag: "wx"});
  await writeFile(markdownPath, markdown(report), {encoding: "utf8", flag: "wx"});
  return report;
}

const check = qcCheck;

function parseRate(rate) {
  const match = /^(\d+)\/(\d+)$/u.exec(String(rate ?? ""));
  if (!match || Number(match[2]) === 0) return null;
  return {numerator: Number(match[1]), denominator: Number(match[2])};
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readEvidence(projectDir, path) {
  if (!path || typeof path !== "string") return null;
  try {
    const localPath = isAbsolute(path) ? relative(projectDir, path) : path;
    if (localPath === ".." || localPath.startsWith("../") || localPath.startsWith("..\\")) return null;
    return parseJson(await readFile(await confinedProjectPath(projectDir, localPath, {type: "file"}), "utf8"));
  } catch {
    return null;
  }
}

export async function findLockedArtifacts(projectDir, locks) {
  const artifacts = [];
  async function visit(directory) {
    const entries = await readdir(directory, {withFileTypes: true});
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        const artifact = parseJson(await readFile(path, "utf8"));
        if (!artifact) continue;
        try {
          validateArtifactEnvelope(artifact);
          artifacts.push({artifact, sha256: await sha256File(path)});
        } catch {
          // Non-artifact JSON is not a locked parent.
        }
      }
    }
  }
  await visit(await confinedProjectPath(projectDir, "Plans", {type: "directory"}));
  return locks.map((lock) => {
    const matches = artifacts.filter(({artifact, sha256}) => artifact.artifactId === lock.id && sha256 === lock.sha256);
    if (matches.length !== 1) throw new Error(`Locked artifact unavailable: ${lock.id}`);
    return matches[0].artifact;
  });
}

function candidateStateError(message, checkId, ownerStage, locator, expected) {
  return Object.assign(new Error(message), {checkId, ownerStage, locator, expected});
}

export async function validateCandidateProjectState(projectDir, bundle, approvalKind, policyVersion) {
  let artifacts;
  try {
    artifacts = await findLockedArtifacts(projectDir, bundle.inputLock.artifacts);
  } catch (error) {
    throw candidateStateError(error.message, "bundle.artifact-parents", bundle.modality === "carousel" ? "carousel-slide-executor" : "premiere-executor", "inputLock.artifacts", "available immutable locked artifacts");
  }

  const [manifest, approvals] = await Promise.all([readManifest(projectDir), readApprovals(projectDir)]);
  const locks = bundle.inputLock.approvals.filter((lock) => {
    const approval = approvals.find(({id}) => id === lock.id);
    return approval?.kind === approvalKind && approval.workItemId === bundle.workItemId;
  });
  const locked = locks.length === 1 ? locks[0] : null;
  const approval = locked && approvals.find(({id}) => id === locked.id);
  const current = approval && findCurrentApproval(approvals, {
    kind: approvalKind, workItemId: bundle.workItemId, artifactId: approval.subject.artifactId,
    sha256: locked.subjectSha256, policyVersion,
  });
  if (!locked || approval?.subject.sha256 !== locked.subjectSha256 || current?.id !== locked.id
    || !bundle.inputLock.artifacts.some(({id, sha256}) => id === approval.subject.artifactId && sha256 === approval.subject.sha256)) {
    throw candidateStateError(`Candidate requires one current ${approvalKind} approval`, "bundle.required-approval", "script-editorial", "inputLock.approvals", `one current approved ${approvalKind}`);
  }

  const records = [...manifest.sources, ...manifest.assets];
  const dependencies = [];
  for (const lock of bundle.inputLock.assets) {
    const matches = records.filter(({id}) => id === lock.id);
    const record = matches.length === 1 ? matches[0] : null;
    let actual = null;
    try {
      if (record?.sha256 === lock.sha256) actual = await sha256File(await confinedProjectPath(projectDir, record.path, {type: "file"}));
    } catch {
      actual = null;
    }
    if (actual !== lock.sha256) {
      throw candidateStateError(`Locked dependency unavailable or changed: ${lock.id}`, "bundle.local-dependencies", bundle.modality === "carousel" ? "carousel-slide-executor" : "premiere-executor", "inputLock.assets", "current local dependency hashes");
    }
    dependencies.push(record);
  }
  return {manifest, approvals, artifacts, approval, dependencies};
}

function candidateRef(bundle) {
  return {artifactId: `candidate:${bundle.workItemId}:v${String(bundle.revision).padStart(3, "0")}`, sha256: bundle.bundleHash};
}

function hasParent(artifact, parent) {
  return artifact.parents.some(({artifactId, sha256}) => artifactId === parent.artifactId && sha256 === parent.sha256);
}

async function readReceipt(projectDir, path, bundle, kind, producer) {
  const receipt = await readEvidence(projectDir, path);
  try {
    validateArtifactEnvelope(receipt);
  } catch {
    return null;
  }
  if (receipt.workItemId !== bundle.workItemId || receipt.revision !== bundle.revision || receipt.modality !== bundle.modality
    || receipt.payload?.kind !== kind || receipt.payload.candidateBundleHash !== bundle.bundleHash
    || (producer.actorId && receipt.producer.actorId !== producer.actorId) || receipt.producer.role !== producer.role) return null;
  const requiredParents = [...bundle.inputLock.artifacts.map(({id: artifactId, sha256}) => ({artifactId, sha256})), candidateRef(bundle)];
  return requiredParents.every((parent) => hasParent(receipt, parent)) ? receipt : null;
}

function profileContainer(formatName, extension) {
  const formats = String(formatName ?? "").split(",");
  return formats.includes(extension) || (extension === "mp4" && formats.includes("mov"));
}

function transcriptChecks(receipt, parents, bundle) {
  const transcript = receipt?.payload;
  const script = parents.filter(({payload}) => payload?.kind === "script");
  const story = parents.filter(({payload}) => payload?.kind === "story-plan");
  if (!transcript || script.length !== 1 || story.length !== 1
    || !Array.isArray(transcript.words) || !Array.isArray(transcript.selectedSourceRanges)) {
    return [check("content.approved-words", false, "hard", "story-editor", [observed("transcriptEvidencePath", null, "locked script and story transcript evidence")])];
  }
  const approved = new Set(script[0].payload.words?.map(({id}) => id) ?? []);
  const storyRanges = story[0]?.payload.segments ?? [];
  const findings = [];
  const included = new Set();
  for (const word of transcript.words) {
    const locator = `${word?.id ?? "unknown"}@${word?.startMs ?? "?"}-${word?.endMs ?? "?"}`;
    included.add(word?.id);
    const inStory = storyRanges.some((segment) => segment.sourceId === word?.sourceId
      && Number.isFinite(word?.startMs) && Number.isFinite(word?.endMs)
      && word.startMs >= segment.sourceInMs && word.endMs <= segment.sourceOutMs);
    if (!word?.sourceId || (approved.size && !approved.has(word.id)) || !inStory) {
      findings.push(observed(locator, {id: word?.id ?? null, sourceId: word?.sourceId ?? null}, "approved word inside locked story source range"));
    }
  }
  for (const id of approved) if (!included.has(id)) findings.push(observed(`${id}@missing`, "omitted", "approved word"));
  for (const range of transcript.selectedSourceRanges) {
    if (!storyRanges.some((segment) => segment.sourceId === range?.sourceId && range.startMs >= segment.sourceInMs && range.endMs <= segment.sourceOutMs)) {
      findings.push(observed(`${range?.sourceId ?? "unknown"}@${range?.startMs ?? "?"}-${range?.endMs ?? "?"}`, range ?? null, "locked story source range"));
    }
  }
  return [check("content.approved-words", findings.length === 0, "hard", "story-editor", findings.length ? findings : [observed("transcript.words", transcript.words.length, "approved words inside locked source ranges")])];
}

async function timelineChecks(projectDir, timeline) {
  if (!timeline) {
    return [
      check("timeline.native-caption-track", false, "hard", "premiere-executor", [observed("timelineEvidencePath", null, "native Premiere caption-track receipt")]),
      check("timeline.dependencies", false, "hard", "premiere-executor", [observed("timelineEvidencePath", null, "dependency receipt")]),
      check("timeline.unresolved-warnings", false, "hard", "premiere-executor", [observed("timelineEvidencePath", null, "unresolved warnings receipt")]),
      check("timeline.sidecar-gaps", false, "hard", "premiere-executor", [observed("timelineEvidencePath", null, "sidecar gaps receipt")]),
      check("timeline.network-denied", false, "hard", "premiere-executor", [observed("timelineEvidencePath", null, "network-denied receipt")]),
    ];
  }
  const dependencies = Array.isArray(timeline.dependencies) ? timeline.dependencies : null;
  const dependencyPass = dependencies !== null && await Promise.all(dependencies.map(async (dependency) => {
    if (!dependency || typeof dependency.path !== "string" || !/^[a-f0-9]{64}$/u.test(dependency.sha256)) return false;
    try {
      return await sha256File(await confinedProjectPath(projectDir, dependency.path, {type: "file"})) === dependency.sha256;
    } catch {
      return false;
    }
  })).then((results) => results.every(Boolean));
  const warnings = Array.isArray(timeline.warnings) ? timeline.warnings : null;
  return [
    check("timeline.native-caption-track", timeline.nativeCaptionTrack?.retained === true, "hard", "premiere-executor", [observed("timeline.nativeCaptionTrack.retained", timeline.nativeCaptionTrack?.retained ?? null, true)]),
    check("timeline.dependencies", dependencyPass, "hard", "premiere-executor", [observed("timeline.dependencies", dependencies?.length ?? null, "all local dependency hashes")]),
    check("timeline.unresolved-warnings", warnings !== null && warnings.length === 0, "hard", "premiere-executor", [observed("timeline.warnings", warnings ?? null, [])]),
    check("timeline.sidecar-gaps", Array.isArray(timeline.gaps) && timeline.gaps.length === 0, "hard", "premiere-executor", [observed("timeline.gaps", timeline.gaps ?? null, [])]),
    check("timeline.network-denied", timeline.networkDenied === true, "hard", "premiere-executor", [observed("timeline.networkDenied", timeline.networkDenied ?? null, true)]),
  ];
}

function lockedPayload(artifacts, kinds) {
  return artifacts.find(({payload}) => kinds.includes(payload?.kind))?.payload ?? null;
}

function shortFormArtifactChecks(lockedArtifacts, profile) {
  const mediaIndex = lockedPayload(lockedArtifacts, ["media-index"]);
  const pacing = lockedPayload(lockedArtifacts, ["short-form-pacing", "pacing", "pacing-plan"]);
  const captions = lockedPayload(lockedArtifacts, ["caption-placement", "caption-plan", "captions"]);
  const subjectMap = lockedPayload(lockedArtifacts, ["subject-map"]);
  const blueprint = lockedPayload(lockedArtifacts, ["video-design-plan", "design-plan", "blueprint"]);
  if (![mediaIndex, pacing, captions, subjectMap, blueprint].some(Boolean)) return [];
  const missing = [
    ["media-index", mediaIndex], ["pacing", pacing], ["captions", captions], ["subject-map", subjectMap], ["blueprint", blueprint],
  ].filter(([, artifact]) => !artifact).map(([kind]) => observed(`inputLock.${kind}`, null, "locked short-form QC artifact"));
  if (missing.length) return [check("bundle.short-form-artifacts", false, "hard", "design-director", missing)];
  const source = Array.isArray(mediaIndex.sources) ? mediaIndex.sources.find(({id}) => id === subjectMap.sourceId) : null;
  const decodedFrame = source?.video?.[0];
  const sourceValid = typeof source?.sha256 === "string" && /^[a-f0-9]{64}$/u.test(source.sha256)
    && Number.isInteger(decodedFrame?.width) && decodedFrame.width > 0 && Number.isInteger(decodedFrame?.height) && decodedFrame.height > 0;
  if (!sourceValid) return [check("bundle.subject-source", false, "hard", "subject-analyst", [observed(`media-index:${subjectMap.sourceId ?? "unknown"}`, source ?? null, "locked source checksum and decoded frame size")])];
  const pacingInput = pacing.pacing ?? pacing;
  const captionList = captions.captions ?? captions.segments ?? [];
  const shots = blueprint.shots ?? captions.shots ?? [];
  const requirements = blueprint.blueprintRequirements ?? blueprint.requirements;
  const subjectInput = {
    sourceSha256: source.sha256,
    frame: {width: decodedFrame.width, height: decodedFrame.height},
    shots,
    captions: captionList.map((caption) => ({...caption, box: caption.box ?? caption.placement})),
    subjectMap: subjectMap.subjectMap ?? {
      ...subjectMap,
      samples: (subjectMap.samples ?? subjectMap.frames ?? []).map((sample) => ({
        ...sample,
        shotId: sample.shotId ?? shots.find((shot) => sample.timeMs >= shot.startMs && sample.timeMs <= shot.endMs)?.id ?? null,
      })),
    },
    blueprintRequirements: requirements,
  };
  return [
    check("bundle.subject-source", true, "hard", "subject-analyst", [observed(`media-index:${source.id}`, {sha256: source.sha256, frame: {width: decodedFrame.width, height: decodedFrame.height}}, "locked source checksum and decoded frame size")]),
    ...(profile.pacing ? validateShortFormPacing(pacingInput, profile) : []),
    ...validateSubjectCaptionSafety(subjectInput, profile),
  ];
}

function technicalMarkdown(evidence) {
  const checks = evidence.payload.checks.map(({id, pass, severity}) => `- ${pass ? "PASS" : "FAIL"} (${severity}) ${id}`).join("\n");
  return `# Technical QC ${evidence.payload.pass ? "PASS" : "FAIL"}\n\n- Bundle: ${evidence.payload.candidateBundleHash}\n- Profile: ${evidence.payload.profileId} (${evidence.payload.profileHash})\n\n## Checks\n\n${checks}\n`;
}

async function writeTechnicalEvidence(projectDir, bundle, prerequisite, profile, checks) {
  const revision = String(bundle.revision).padStart(3, "0");
  const payload = {
    kind: "technical-qc", candidateBundleHash: bundle.bundleHash,
    policyVersion: profile?.policyVersion ?? bundle.versions?.policy ?? "unknown",
    profileId: profile?.id ?? bundle.settings?.profileId ?? null,
    profileHash: profile?.profileHash ?? bundle.settings?.profileHash ?? null,
    pass: checks.every(({pass}) => pass), checks,
    reportFiles: {json: `QC/${bundle.workItemId}/v${revision}/technical-qc.json`, markdown: `QC/${bundle.workItemId}/v${revision}/technical-qc.md`},
  };
  const evidence = createArtifactEnvelope({
    ...prerequisite,
    versions: {...prerequisite.versions, policy: payload.policyVersion},
    payload,
    status: payload.pass ? "passed" : "failed",
  });
  await writeImmutableArtifact(projectDir, payload.reportFiles.json, evidence);
  await writeFile(join(projectDir, payload.reportFiles.markdown), technicalMarkdown(evidence), {encoding: "utf8", flag: "wx"});
  return evidence;
}

export async function runCandidateTechnicalQc(projectDir, bundlePath, input) {
  const bundle = await verifyCandidateBundle(projectDir, bundlePath);
  if (!input?.validator || input.validator.role !== "technical-qc-validator") throw new Error("Technical QC requires a technical-qc-validator");
  assertIndependentReviewer({
    producerActorId: bundle.producer.actorId,
    reviewerActorId: input.validator.actorId,
    reviewerRole: input.validator.role,
  });
  const parents = bundle.inputLock.artifacts.map(({id: artifactId, sha256}) => ({artifactId, sha256}));
  const prerequisite = createArtifactEnvelope({
    artifactId: `technical-qc-${bundle.workItemId}-v${String(bundle.revision).padStart(3, "0")}`,
    revision: bundle.revision, workItemId: bundle.workItemId, modality: bundle.modality, parents,
    producer: input.validator,
    versions: {tool: bundle.versions?.tool ?? "content-hub", template: bundle.versions?.template ?? null, model: bundle.versions?.model ?? null, policy: bundle.versions?.policy ?? "unknown"},
    status: "complete", payload: {kind: "technical-qc-prerequisite"},
  });
  const checks = [];
  let profile;
  try {
    if (!bundle.settings?.profileId || bundle.modality === "carousel") throw new Error("Technical QC requires a video candidate profile");
    profile = resolveTechnicalProfile(bundle.settings.profileId, input.profileContext);
    if (bundle.settings.profileHash !== profile.profileHash) throw new Error("Candidate profile hash mismatch");
    checks.push(check("bundle.profile", true, "hard", "premiere-executor", [observed("settings.profileHash", bundle.settings.profileHash, profile.profileHash)]));
  } catch (error) {
    checks.push(check("bundle.profile", false, "hard", "premiere-executor", [observed("settings.profileHash", bundle.settings?.profileHash ?? null, error.message)]));
    return writeTechnicalEvidence(projectDir, bundle, prerequisite, profile, checks);
  }
  let projectState;
  try {
    projectState = await validateCandidateProjectState(projectDir, bundle, "script", profile.policyVersion);
    checks.push(check("bundle.artifact-parents", true, "hard", "premiere-executor", [observed("inputLock.artifacts", projectState.artifacts.length, "current parent hashes")]));
    checks.push(check("bundle.required-approval", true, "hard", "script-editorial", [observed("inputLock.approvals", projectState.approval.id, "one current approved script")]));
    checks.push(check("bundle.local-dependencies", true, "hard", "premiere-executor", [observed("inputLock.assets", projectState.dependencies.length, "current local dependency hashes")]));
  } catch (error) {
    checks.push(check(error.checkId ?? "bundle.artifact-parents", false, "hard", error.ownerStage ?? "premiere-executor", [observed(error.locator ?? "inputLock.artifacts", error.message, error.expected ?? "current project state")]));
    return writeTechnicalEvidence(projectDir, bundle, prerequisite, profile, checks);
  }
  const lockedArtifacts = projectState.artifacts;
  const story = lockedArtifacts.filter(({payload}) => payload?.kind === "story-plan");
  const transcript = await readReceipt(projectDir, input.transcriptEvidencePath, bundle, "final-transcript", story.length === 1 ? story[0].producer : {role: "story-editor"});
  const timeline = await readReceipt(projectDir, input.timelineEvidencePath, bundle, "premiere-readback", bundle.producer);
  checks.push(
    check("transcript.receipt", Boolean(transcript), "hard", "story-editor", [observed("transcriptEvidencePath", Boolean(transcript), "bound final-transcript artifact")]),
    check("timeline.receipt", Boolean(timeline), "hard", "premiere-executor", [observed("timelineEvidencePath", Boolean(timeline), "bound Premiere readback artifact")]),
    ...transcriptChecks(transcript, lockedArtifacts, bundle),
    ...await timelineChecks(projectDir, timeline?.payload),
    ...shortFormArtifactChecks(lockedArtifacts, profile),
  );
  const run = input.run ?? runProcess;
  const probe = input.probe ?? probeMedia;

  for (const file of bundle.files) {
    const absolutePath = join(projectDir, file.path);
    let media;
    try {
      media = await probe(absolutePath);
    } catch (error) {
      checks.push(check("video.probe", false, "hard", "premiere-executor", [observed(file.path, error.message, "ffprobe media data")]));
      continue;
    }
    const stream = media.video[0];
    const audio = media.audio[0];
    const extension = file.path.split(".").pop().toLowerCase();
    const rate = parseRate(stream?.r_frame_rate);
    const expectedRate = `${profile.video.fpsNumerator}/${profile.video.fpsDenominator}`;
    const decode = await run("ffmpeg", ["-v", "error", "-i", absolutePath, "-f", "null", "-"]);
    checks.push(check("video.full-decode", decode.code === 0, "hard", "premiere-executor", [observed(file.path, decode.code, 0)]));
    checks.push(check("video.present", Boolean(stream), "hard", "premiere-executor", [observed(file.path, media.video.length, 1)]));
    checks.push(check("audio.present", Boolean(audio), "hard", "premiere-executor", [observed(file.path, media.audio.length, 1)]));
    checks.push(check("video.dimensions", stream?.width === profile.video.width && stream?.height === profile.video.height, "hard", "premiere-executor", [observed(file.path, stream ? `${stream.width}x${stream.height}` : null, `${profile.video.width}x${profile.video.height}`)]));
    checks.push(check("video.frame-rate", rate?.numerator === profile.video.fpsNumerator && rate?.denominator === profile.video.fpsDenominator, "hard", "premiere-executor", [observed(file.path, stream?.r_frame_rate ?? null, expectedRate)]));
    const allowedContainers = profile.id === "project-video-v1" ? [profile.video.container] : profile.video.allowedContainers;
    checks.push(check("video.container", allowedContainers.includes(extension) && profileContainer(media.formatName, extension), "hard", "premiere-executor", [observed(file.path, {extension, formatName: media.formatName}, allowedContainers)]));
    checks.push(check("video.codec", typeof bundle.settings.codec === "string" && stream?.codec_name === bundle.settings.codec, "hard", "premiere-executor", [observed(file.path, stream?.codec_name ?? null, bundle.settings.codec ?? "declared by encoder") ]));
    checks.push(check("video.color-metadata", Boolean(stream?.color_space && stream?.color_transfer && stream?.color_primaries), "hard", "premiere-executor", [observed(file.path, {space: stream?.color_space, transfer: stream?.color_transfer, primaries: stream?.color_primaries}, "color metadata") ]));
    checks.push(check("video.duration", Number.isFinite(media.durationSeconds) && media.durationSeconds > 0 && (!Number.isFinite(bundle.settings.durationSeconds) || Math.abs(media.durationSeconds - bundle.settings.durationSeconds) <= profile.video.fpsDenominator / profile.video.fpsNumerator), "hard", "premiere-executor", [observed(file.path, media.durationSeconds, bundle.settings.durationSeconds ?? "positive duration") ]));
    checks.push(check("audio.sample-rate", Number(audio?.sample_rate) === profile.audio.sampleRate, "hard", "premiere-executor", [observed(file.path, audio?.sample_rate ?? null, profile.audio.sampleRate)]));
    checks.push(check("audio.channels", profile.audio.allowedChannels.includes(audio?.channels), "hard", "premiere-executor", [observed(file.path, audio?.channels ?? null, profile.audio.allowedChannels)]));

    const loudnessResult = audio && await run("ffmpeg", ["-hide_banner", "-nostats", "-i", absolutePath, "-vn", "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"]);
    const loudness = loudnessResult && parseLoudness(loudnessResult.stderr);
    checks.push(check("audio.loudness", Boolean(loudness) && Math.abs(loudness.integratedLufs - profile.audio.integratedLufsTarget) <= profile.audio.integratedLufsTolerance, "hard", "premiere-executor", [observed(file.path, loudness?.integratedLufs ?? null, `${profile.audio.integratedLufsTarget}±${profile.audio.integratedLufsTolerance}`)]));
    checks.push(check("audio.true-peak", Boolean(loudness) && loudness.truePeakDb <= profile.audio.truePeakMaxDb, "hard", "premiere-executor", [observed(file.path, loudness?.truePeakDb ?? null, profile.audio.truePeakMaxDb)]));
    const black = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", absolutePath, "-vf", "blackdetect=d=0.5:pix_th=0.10", "-an", "-f", "null", "-"]);
    const frozen = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", absolutePath, "-vf", "freezedetect=n=0.003:d=0.5", "-an", "-f", "null", "-"]);
    checks.push(check("video.black-intervals", black.code === 0 && parseRanges(black.stderr, "black").length === 0, "hard", "premiere-executor", [observed(file.path, parseRanges(black.stderr, "black").length, 0)]));
    checks.push(check("video.frozen-intervals", frozen.code === 0 && parseRanges(frozen.stderr, "freeze").length === 0, "hard", "premiere-executor", [observed(file.path, parseRanges(frozen.stderr, "freeze").length, 0)]));
  }

  return writeTechnicalEvidence(projectDir, bundle, prerequisite, profile, checks);
}
