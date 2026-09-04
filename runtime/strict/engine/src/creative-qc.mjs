import {readFile, realpath} from "node:fs/promises";
import {isAbsolute, relative, resolve, sep} from "node:path";

import {createArtifactEnvelope, validateArtifactEnvelope, writeImmutableArtifact} from "./artifacts.mjs";
import {verifyCandidateBundle} from "./candidates.mjs";
import {sha256File, sha256Value} from "./checksum.mjs";
import {confinedProjectPath} from "./paths.mjs";
import {findLockedArtifacts} from "./qc.mjs";
import {assertIndependentReviewer} from "./roles.mjs";

export const CREATIVE_DIMENSIONS = Object.freeze({
  brandFidelity: 20,
  hookClarity: 15,
  editorialComposition: 15,
  distinctiveness: 15,
  craftPolish: 15,
  narrativeProgression: 10,
  modalityFit: 10,
});

const INPUT_KEYS = Object.freeze(["reviewer", "policyVersion", "scores", "evidence", "hardFailures", "heroMoment", "strongestEvidence", "weakestUnresolvedChoice"]);
const CAROUSEL_EVIDENCE_KEYS = Object.freeze(["coverHook", "hardestInteriorSlide", "narrativeContinuity", "oneIdeaPerSlide", "rhythm"]);
const TECHNICAL_PAYLOAD_KEYS = Object.freeze(["kind", "candidateBundleHash", "policyVersion", "profileId", "profileHash", "pass", "checks", "reportFiles"]);
const CAROUSEL_TECHNICAL_PAYLOAD_KEYS = Object.freeze([...TECHNICAL_PAYLOAD_KEYS, "slideCount", "formats"]);
const ARTIFACT_KEYS = Object.freeze(["schemaVersion", "artifactId", "revision", "workItemId", "modality", "parents", "producer", "versions", "createdAt", "status", "deviations", "payload"]);
const LOCATOR_TYPES = new Set(["timecode", "frame", "slide"]);
const CONTRACT_KINDS = new Set(["brief", "style", "style-guide", "design-plan", "video-design-plan", "carousel-plan"]);

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be an object`);
}

function assertExactKeys(value, keys, label) {
  assertPlainObject(value, label);
  if (Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) throw new Error(`${label} has unknown or missing fields`);
}

function assertText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function normalizeScores(scores) {
  assertExactKeys(scores, Object.keys(CREATIVE_DIMENSIONS), "Creative scores");
  for (const [id, score] of Object.entries(scores)) {
    if (!Number.isInteger(score) || score < 1 || score > 5) throw new Error(`Creative score ${id} must be an integer from 1 to 5`);
  }
  return structuredClone(scores);
}

export function scoreCreativeReview(scores) {
  const normalized = normalizeScores(scores);
  return Object.entries(CREATIVE_DIMENSIONS).reduce((total, [id, weight]) => total + normalized[id] / 5 * weight, 0);
}

function normalizeLocator(locator) {
  assertExactKeys(locator, ["type", "value"], "Evidence locator");
  if (!LOCATOR_TYPES.has(locator.type)) throw new Error("Evidence locator type must be timecode, frame, or slide");
  if (locator.type === "timecode") {
    if (typeof locator.value !== "string" || !/^\d{2}:\d{2}:\d{2}\.\d{3}$/u.test(locator.value)) throw new Error("Timecode locator must be HH:MM:SS.mmm");
  } else if (locator.type === "frame") {
    if (!Number.isInteger(locator.value) || locator.value < 0) throw new Error("Frame locator must be a non-negative integer");
  } else if (typeof locator.value !== "string" || !/^slide-[A-Za-z0-9_-]+\/(?:4:5|1:1)$/u.test(locator.value)) {
    throw new Error("Slide locator must identify a slide and format");
  }
  return structuredClone(locator);
}

function normalizeEvidenceItem(item, label) {
    if (!Object.hasOwn(item ?? {}, "contractRef")) throw new Error(`${label} requires a contract reference`);
    assertExactKeys(item, ["observation", "locators", "contractRef"], label);
    const observation = assertText(item.observation, `${label} observation`);
    if (!Array.isArray(item.locators) || item.locators.length === 0) throw new Error(`${label} requires a locator`);
    assertExactKeys(item.contractRef, ["artifactId", "sha256"], `${label} contract reference`);
    const artifactId = assertText(item.contractRef.artifactId, `${label} contract artifact id`);
    if (typeof item.contractRef.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(item.contractRef.sha256)) throw new Error(`${label} contract hash must be SHA-256`);
    return {observation, locators: item.locators.map(normalizeLocator), contractRef: {artifactId, sha256: item.contractRef.sha256}};
}

function normalizeEvidence(evidence) {
  assertExactKeys(evidence, Object.keys(CREATIVE_DIMENSIONS), "Creative evidence");
  return Object.fromEntries(Object.keys(CREATIVE_DIMENSIONS).map((id) => [id, normalizeEvidenceItem(evidence[id], `Creative evidence ${id}`)]));
}

function normalizeCarouselEvidence(evidence) {
  if (evidence === undefined) return null;
  assertExactKeys(evidence, CAROUSEL_EVIDENCE_KEYS, "Carousel creative evidence");
  return Object.fromEntries(CAROUSEL_EVIDENCE_KEYS.map((id) => [id, normalizeEvidenceItem(evidence[id], `Carousel creative evidence ${id}`)]));
}

async function bindCreativeContracts(projectDir, bundle, evidence) {
  const lockedArtifacts = await findLockedArtifacts(projectDir, bundle.inputLock.artifacts);
  const locks = new Map(bundle.inputLock.artifacts.map(({id, sha256}) => [id, sha256]));
  const artifacts = new Map(lockedArtifacts.map((artifact) => [artifact.artifactId, artifact]));
  for (const [dimension, item] of Object.entries(evidence)) {
    const lockedHash = locks.get(item.contractRef.artifactId);
    const artifact = artifacts.get(item.contractRef.artifactId);
    if (lockedHash !== item.contractRef.sha256 || !artifact) throw new Error(`Creative evidence ${dimension} must reference a locked contract artifact`);
    if (!CONTRACT_KINDS.has(artifact.payload?.kind)) throw new Error(`Creative evidence ${dimension} contract kind is not allowed`);
  }
  return evidence;
}

function normalizeHardFailures(hardFailures) {
  if (!Array.isArray(hardFailures)) throw new Error("Creative hard failures must be an array");
  return hardFailures.map((failure) => {
    assertExactKeys(failure, ["code", "observation", "locators"], "Creative hard failure");
    const code = assertText(failure.code, "Creative hard failure code");
    const observation = assertText(failure.observation, "Creative hard failure observation");
    if (!Array.isArray(failure.locators) || failure.locators.length === 0) throw new Error("Creative hard failure requires a locator");
    return {code, observation, locators: failure.locators.map(normalizeLocator)};
  });
}

function normalizeInput(input) {
  assertPlainObject(input, "Creative review input");
  if (INPUT_KEYS.some((key) => !Object.hasOwn(input, key)) || Object.keys(input).some((key) => ![...INPUT_KEYS, "carouselEvidence"].includes(key))) throw new Error("Creative review input has unknown or missing fields");
  assertExactKeys(input.reviewer, ["actorId", "role"], "Creative reviewer");
  const reviewer = {actorId: assertText(input.reviewer.actorId, "Creative reviewer actor id"), role: input.reviewer.role};
  if (reviewer.role !== "creative-qc-reviewer") throw new Error("Creative review requires a creative-qc-reviewer");
  return {
    reviewer,
    policyVersion: assertText(input.policyVersion, "Creative review policy version"),
    scores: normalizeScores(input.scores),
    evidence: normalizeEvidence(input.evidence),
    carouselEvidence: normalizeCarouselEvidence(input.carouselEvidence),
    hardFailures: normalizeHardFailures(input.hardFailures),
    heroMoment: assertText(input.heroMoment, "Hero moment"),
    strongestEvidence: assertText(input.strongestEvidence, "Strongest evidence"),
    weakestUnresolvedChoice: assertText(input.weakestUnresolvedChoice, "Weakest unresolved choice"),
  };
}

function samePath(left, right) {
  return resolve(left) === resolve(right);
}

function assertTechnicalChecks(checks) {
  if (!Array.isArray(checks) || checks.length === 0) throw new Error("Technical evidence requires passing checks");
  for (const check of checks) {
    assertExactKeys(check, ["id", "pass", "severity", "ownerStage", "findingSignature", "evidence"], "Technical check");
    assertText(check.id, "Technical check id");
    assertText(check.ownerStage, "Technical check owner stage");
    if (typeof check.pass !== "boolean" || !["hard", "warning"].includes(check.severity) || !Array.isArray(check.evidence) || check.evidence.length === 0) {
      throw new Error("Technical check is malformed");
    }
    for (const item of check.evidence) {
      assertExactKeys(item, ["locator", "observed", "expected"], "Technical check evidence");
      assertText(item.locator, "Technical check locator");
      sha256Value(item.observed);
      sha256Value(item.expected);
    }
    if (check.findingSignature !== sha256Value({id: check.id, ownerStage: check.ownerStage, locator: check.evidence.map(({locator}) => locator)})) {
      throw new Error("Technical check signature mismatch");
    }
  }
}

async function readTechnicalEvidence(projectDir, technicalEvidencePath, bundle, policyVersion) {
  const root = await realpath(projectDir);
  const expected = `QC/${bundle.workItemId}/v${String(bundle.revision).padStart(3, "0")}/technical-qc.json`;
  const requested = isAbsolute(technicalEvidencePath) ? relative(root, await realpath(technicalEvidencePath)) : technicalEvidencePath;
  if (typeof requested !== "string" || requested.split(sep).join("/") !== expected) throw new Error("Technical evidence must use the exact bundle QC path");
  const path = await confinedProjectPath(root, requested, {type: "file"});
  let evidence;
  try {
    evidence = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Technical evidence is malformed");
  }
  assertExactKeys(evidence, ARTIFACT_KEYS, "Technical evidence envelope");
  validateArtifactEnvelope(evidence);
  assertExactKeys(evidence.payload, bundle.modality === "carousel" ? CAROUSEL_TECHNICAL_PAYLOAD_KEYS : TECHNICAL_PAYLOAD_KEYS, "Technical evidence payload");
  const payload = evidence.payload;
  if (evidence.artifactId !== `technical-qc-${bundle.workItemId}-v${String(bundle.revision).padStart(3, "0")}`
    || evidence.workItemId !== bundle.workItemId || evidence.revision !== bundle.revision || evidence.modality !== bundle.modality
    || evidence.producer?.role !== "technical-qc-validator" || evidence.status !== "passed") throw new Error("Technical evidence does not match the exact candidate envelope");
  if (payload.kind !== "technical-qc" || payload.pass !== true || payload.candidateBundleHash !== bundle.bundleHash
    || payload.policyVersion !== policyVersion || payload.policyVersion !== bundle.versions?.policy
    || payload.profileId !== bundle.settings?.profileId || payload.profileHash !== bundle.settings?.profileHash
    || !samePath(joinPath(root, payload.reportFiles?.json), path)
    || payload.reportFiles?.markdown !== `QC/${bundle.workItemId}/v${String(bundle.revision).padStart(3, "0")}/technical-qc.md`) {
    throw new Error("Technical evidence must be a passing exact-bundle record");
  }
  assertTechnicalChecks(payload.checks);
  if (!payload.checks.every(({pass}) => pass)) throw new Error("Technical evidence must contain only passing checks");
  return {evidence, path, sha256: await sha256File(path)};
}

function joinPath(root, path) {
  return typeof path === "string" ? resolve(root, path) : "";
}

function assertCarouselEvidenceCoverage(bundle, evidence, carouselEvidence) {
  if (bundle.modality !== "carousel") return;
  if (!carouselEvidence) throw new Error("Carousel creative evidence is required");
  const expected = new Set(bundle.files.filter(({kind}) => kind === "carousel-slide").map(({slideId, format}) => `${slideId}/${format}`));
  const covered = new Set(Object.values(evidence).flatMap(({locators}) => locators.filter(({type}) => type === "slide").map(({value}) => value)));
  if (![...expected].every((locator) => covered.has(locator))) throw new Error("Creative evidence must cover every carousel slide format");
  if (Object.values(carouselEvidence).some(({locators}) => !locators.some(({type}) => type === "slide"))) throw new Error("Carousel creative evidence requires slide locators");
  if (!carouselEvidence.coverHook.locators.some(({value}) => value.startsWith("slide-01/"))) throw new Error("Carousel cover hook evidence must cite slide-01");
  const ids = [...new Set(bundle.files.filter(({kind}) => kind === "carousel-slide").map(({slideId}) => slideId))];
  if (!carouselEvidence.hardestInteriorSlide.locators.some(({type, value}) => type === "slide" && ids.includes(value.split("/")[0]) && value.split("/")[0] !== ids[0] && value.split("/")[0] !== ids.at(-1))) throw new Error("Carousel hardest interior slide evidence must cite an interior slide");
}

function verdict(scores, hardFailures) {
  const score = scoreCreativeReview(scores);
  const failures = [];
  if (hardFailures.length) failures.push("hard failure");
  if (score < 90) failures.push("score below 90");
  if (scores.brandFidelity < 4) failures.push("brand fidelity below 4");
  if (scores.hookClarity < 4) failures.push("hook clarity/readability below 4");
  if (scores.craftPolish < 4) failures.push("craft polish below 4");
  if (Object.values(scores).some((scoreValue) => scoreValue < 3)) failures.push("dimension below 3");
  return {score, pass: failures.length === 0, failures};
}

export async function recordCreativeReview(projectDir, bundlePath, technicalEvidencePath, input) {
  const bundle = await verifyCandidateBundle(projectDir, bundlePath);
  const review = normalizeInput(input);
  const technical = await readTechnicalEvidence(projectDir, technicalEvidencePath, bundle, review.policyVersion);
  review.evidence = await bindCreativeContracts(projectDir, bundle, review.evidence);
  if (review.carouselEvidence) review.carouselEvidence = await bindCreativeContracts(projectDir, bundle, review.carouselEvidence);
  assertCarouselEvidenceCoverage(bundle, review.evidence, review.carouselEvidence);
  assertIndependentReviewer({
    producerActorId: bundle.producer.actorId,
    reviewerActorId: review.reviewer.actorId,
    reviewerRole: review.reviewer.role,
  });
  const result = verdict(review.scores, review.hardFailures);
  const revision = String(bundle.revision).padStart(3, "0");
  const reportFiles = {json: `QC/${bundle.workItemId}/v${revision}/creative-qc.json`};
  const evidence = createArtifactEnvelope({
    artifactId: `creative-qc-${bundle.workItemId}-v${revision}`,
    revision: bundle.revision,
    workItemId: bundle.workItemId,
    modality: bundle.modality,
    parents: [
      {artifactId: `candidate:${bundle.workItemId}:v${revision}`, sha256: bundle.bundleHash},
      {artifactId: technical.evidence.artifactId, sha256: technical.sha256},
    ],
    producer: review.reviewer,
    versions: {tool: bundle.versions?.tool ?? "content-hub", template: bundle.versions?.template ?? null, model: bundle.versions?.model ?? null, policy: review.policyVersion},
    status: result.pass ? "passed" : "failed",
    payload: {
      kind: "creative-qc", candidateBundleHash: bundle.bundleHash, policyVersion: review.policyVersion,
      profileId: bundle.settings.profileId, profileHash: bundle.settings.profileHash, technicalEvidenceSha256: technical.sha256,
      score: Math.round(result.score * 100) / 100, scores: review.scores, evidence: review.evidence,
      ...(review.carouselEvidence ? {carouselEvidence: review.carouselEvidence} : {}),
      hardFailures: review.hardFailures, heroMoment: review.heroMoment, strongestEvidence: review.strongestEvidence,
      weakestUnresolvedChoice: review.weakestUnresolvedChoice, pass: result.pass, reportFiles,
    },
  });
  await writeImmutableArtifact(projectDir, reportFiles.json, evidence);
  return evidence;
}
