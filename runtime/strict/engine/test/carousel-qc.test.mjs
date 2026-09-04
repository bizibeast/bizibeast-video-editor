import assert from "node:assert/strict";
import {copyFile, link, lstat, mkdir, mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {spawn} from "node:child_process";
import test from "node:test";

import {recordApproval} from "../src/approvals.mjs";
import {createArtifactEnvelope, writeImmutableArtifact} from "../src/artifacts.mjs";
import {freezeCandidateBundle} from "../src/candidates.mjs";
import {inspectPng, runCarouselTechnicalQc} from "../src/carousel-qc.mjs";
import {recordCreativeReview} from "../src/creative-qc.mjs";
import {createProject} from "../src/project.mjs";
import {resolveTechnicalProfile} from "../src/qc-profiles.mjs";

const coordinator = {actorId: "content-hub-coordinator", actorRole: "coordinator"};
const versions = {tool: "fixture", template: "fixture", model: "none", policy: "bizibeast-v1"};

const crc32 = (bytes) => {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
};

function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

function insertPngChunk(bytes, chunk, beforeType) {
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString("ascii", offset + 4, offset + 8) === beforeType) return Buffer.concat([bytes.subarray(0, offset), chunk, bytes.subarray(offset)]);
    offset += length + 12;
  }
  throw new Error(`missing ${beforeType}`);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ["ignore", "pipe", "pipe"]});
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed: ${stderr}`)));
  });
}

async function makeTinyPng(path) {
  await mkdir(dirname(path), {recursive: true});
  await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=2x2", "-frames:v", "1", "-y", path]);
}

async function storeArtifact(projectDir, path, input) {
  const artifact = createArtifactEnvelope({...input, versions, status: "frozen"});
  const stored = await writeImmutableArtifact(projectDir, path, artifact);
  return {artifact, ref: {id: artifact.artifactId, sha256: stored.sha256}, path: join(projectDir, stored.path)};
}

function contracts(copySha256) {
  return Array.from({length: 6}, (_, index) => ({
    id: `slide-${String(index + 1).padStart(2, "0")}`,
    order: index + 1,
    copySha256,
    altText: `Accessible description for slide ${index + 1}.`,
  }));
}

async function fixture({profileHash, layoutWarning = false, slideTwoFirst = false, asset = false} = {}) {
  const root = await mkdtemp(join(tmpdir(), "content-hub-carousel-qc-"));
  const {projectDir} = await createProject(root, {name: "Carousel QC", aspect: "4:5"});
  const profile = resolveTechnicalProfile("carousel-paired-v1");
  const copy = await storeArtifact(projectDir, "Plans/carousel-copy-v001.json", {
    artifactId: "carousel-copy-001", revision: 1, workItemId: "carousel-001", modality: "carousel", parents: [],
    producer: {actorId: "script-1", role: "script-editorial"}, payload: {kind: "carousel-copy"},
  });
  const plan = await storeArtifact(projectDir, "Plans/carousel-plan-v001.json", {
    artifactId: "carousel-plan-001", revision: 1, workItemId: "carousel-001", modality: "carousel", parents: [{artifactId: copy.ref.id, sha256: copy.ref.sha256}],
    producer: {actorId: "design-1", role: "design-director"}, payload: {kind: "carousel-plan", slides: contracts(copy.ref.sha256)},
  });
  const approval = await recordApproval(projectDir, coordinator, {
    kind: "carousel-copy", workItemId: "carousel-001", subject: {artifactId: copy.artifact.artifactId, sha256: copy.ref.sha256},
    decision: "approved", approver: {actorId: "human-yash", role: "human"}, origin: "user", policyVersion: versions.policy,
  });
  const candidateDir = join(projectDir, "Renders/Carousels/carousel-001/v001");
  const source = join(candidateDir, "source.png");
  await makeTinyPng(source);
  const outputs = contracts(copy.ref.sha256).flatMap(({id}, index) => [
    {path: `Renders/Carousels/carousel-001/v001/${id}-4x5.png`, kind: "carousel-slide", order: index * 2 + 1, slideId: id, format: "4:5", approvedCopySha256: copy.ref.sha256},
    {path: `Renders/Carousels/carousel-001/v001/${id}-1x1.png`, kind: "carousel-slide", order: index * 2 + 2, slideId: id, format: "1:1", approvedCopySha256: copy.ref.sha256},
  ]);
  if (slideTwoFirst) [outputs[0].order, outputs[1].order, outputs[2].order, outputs[3].order] = [3, 4, 1, 2];
  await Promise.all(outputs.map((output) => copyFile(source, join(projectDir, output.path))));
  const audit = await storeArtifact(projectDir, "Plans/carousel-layout-audit-v001.json", {
    artifactId: "carousel-layout-audit-001", revision: 1, workItemId: "carousel-001", modality: "carousel", parents: [{artifactId: plan.ref.id, sha256: plan.ref.sha256}],
    producer: {actorId: "carousel-1", role: "carousel-slide-executor"},
    payload: {kind: "carousel-layout-audit", entries: outputs.map(({slideId, format, approvedCopySha256}) => ({
      slideId, format, copySha256: approvedCopySha256, overflow: false, clipping: false, unsafeCrop: false,
      accidentalReflow: false, missingFonts: [], unresolvedWarnings: layoutWarning && slideId === "slide-01" && format === "4:5" ? ["line break needs review"] : [],
    }))},
  });
  const bundle = await freezeCandidateBundle(projectDir, coordinator, {
    workItemId: "carousel-001", modality: "carousel", revision: 1, outputs,
    inputLock: {artifacts: [copy.ref, plan.ref, audit.ref], approvals: [{id: approval.id, subjectSha256: copy.ref.sha256}], assets: asset ? [{id: "asset-001", sha256: "b".repeat(64)}] : []},
    lineage: {sourceIds: ["source-001"], assetIds: []}, settings: {profileId: profile.id, profileHash: profileHash ?? profile.profileHash},
    producer: {actorId: "carousel-1", role: "carousel-slide-executor"}, versions, requestedDerivatives: ["pdf", "zip"],
  });
  const imageFacts = new Map(outputs.map(({path, format}) => [path, {
    width: 1080, height: format === "4:5" ? 1350 : 1080, colorProfile: "sRGB", decodes: true,
  }]));
  return {projectDir, bundle, approval, copy, plan, audit, auditPath: audit.path, imageFacts, profile, source};
}

async function createRevision(base, revision) {
  const revisionText = String(revision).padStart(3, "0");
  const plan = await storeArtifact(base.projectDir, `Plans/carousel-plan-v${revisionText}.json`, {
    artifactId: `carousel-plan-${revisionText}`, revision, workItemId: "carousel-001", modality: "carousel", parents: [{artifactId: base.copy.ref.id, sha256: base.copy.ref.sha256}],
    producer: {actorId: "design-1", role: "design-director"}, payload: {kind: "carousel-plan", slides: contracts(base.copy.ref.sha256)},
  });
  const outputs = contracts(base.copy.ref.sha256).flatMap(({id}, index) => [
    {path: `Renders/Carousels/carousel-001/v${revisionText}/${id}-4x5.png`, kind: "carousel-slide", order: index * 2 + 1, slideId: id, format: "4:5", approvedCopySha256: base.copy.ref.sha256},
    {path: `Renders/Carousels/carousel-001/v${revisionText}/${id}-1x1.png`, kind: "carousel-slide", order: index * 2 + 2, slideId: id, format: "1:1", approvedCopySha256: base.copy.ref.sha256},
  ]);
  await mkdir(join(base.projectDir, `Renders/Carousels/carousel-001/v${revisionText}`), {recursive: true});
  await Promise.all(outputs.map((output) => copyFile(base.source, join(base.projectDir, output.path))));
  const audit = await storeArtifact(base.projectDir, `Plans/carousel-layout-audit-v${revisionText}.json`, {
    artifactId: `carousel-layout-audit-${revisionText}`, revision, workItemId: "carousel-001", modality: "carousel", parents: [{artifactId: plan.ref.id, sha256: plan.ref.sha256}],
    producer: {actorId: "carousel-1", role: "carousel-slide-executor"},
    payload: {kind: "carousel-layout-audit", entries: outputs.map(({slideId, format, approvedCopySha256}) => ({slideId, format, copySha256: approvedCopySha256, overflow: false, clipping: false, unsafeCrop: false, accidentalReflow: false, missingFonts: [], unresolvedWarnings: []}))},
  });
  const bundle = await freezeCandidateBundle(base.projectDir, coordinator, {
    workItemId: "carousel-001", modality: "carousel", revision, outputs,
    inputLock: {artifacts: [base.copy.ref, plan.ref, audit.ref], approvals: [{id: base.approval.id, subjectSha256: base.copy.ref.sha256}], assets: []},
    lineage: {sourceIds: ["source-001"], assetIds: []}, settings: {profileId: base.profile.id, profileHash: base.profile.profileHash},
    producer: {actorId: "carousel-1", role: "carousel-slide-executor"}, versions, requestedDerivatives: ["pdf", "zip"],
  });
  for (const {path, format} of outputs) base.imageFacts.set(path, {width: 1080, height: format === "4:5" ? 1350 : 1080, colorProfile: "sRGB", decodes: true});
  return {...base, bundle, plan, audit, auditPath: audit.path};
}

function input(fixtureInput, overrides = {}) {
  return {
    validator: {actorId: "technical-1", role: "technical-qc-validator"},
    parentHashes: new Map([[fixtureInput.copy.ref.id, fixtureInput.copy.ref.sha256], [fixtureInput.plan.ref.id, fixtureInput.plan.ref.sha256], [fixtureInput.audit.ref.id, fixtureInput.audit.ref.sha256]]), approvals: [fixtureInput.approval],
    slideContractsPath: fixtureInput.plan.path, layoutAuditPath: fixtureInput.auditPath,
    inspectPng: async (path) => fixtureInput.imageFacts.get(path.slice(fixtureInput.projectDir.length + 1)),
    ...overrides,
  };
}

function creativeReview(fixtureInput, locators) {
  const contractRef = {artifactId: fixtureInput.plan.artifact.artifactId, sha256: fixtureInput.plan.ref.sha256};
  const dimensions = ["brandFidelity", "hookClarity", "editorialComposition", "distinctiveness", "craftPolish", "narrativeProgression", "modalityFit"];
  return {
    reviewer: {actorId: "creative-1", role: "creative-qc-reviewer"}, policyVersion: versions.policy,
    scores: {brandFidelity: 5, hookClarity: 5, editorialComposition: 4, distinctiveness: 4, craftPolish: 5, narrativeProgression: 4, modalityFit: 5},
    evidence: Object.fromEntries(dimensions.map((dimension, index) => [dimension, {observation: `${dimension} follows the frozen carousel plan.`, locators: locators.filter((_, locatorIndex) => locatorIndex % dimensions.length === index), contractRef}])),
    carouselEvidence: {
      coverHook: {observation: "The cover names the promise before the first swipe.", locators: [{type: "slide", value: "slide-01/4:5"}], contractRef},
      hardestInteriorSlide: {observation: "The proof slide carries the densest claim clearly.", locators: [{type: "slide", value: "slide-02/4:5"}], contractRef},
      narrativeContinuity: {observation: "Each claim resolves into the next slide.", locators: [{type: "slide", value: "slide-03/4:5"}], contractRef},
      oneIdeaPerSlide: {observation: "Each slide isolates one decision.", locators: [{type: "slide", value: "slide-04/4:5"}], contractRef},
      rhythm: {observation: "The paired adaptations preserve a readable cadence.", locators: [{type: "slide", value: "slide-05/4:5"}], contractRef},
    },
    hardFailures: [], heroMoment: "The cover hook earns the first swipe.", strongestEvidence: "The proof slide makes the claim concrete.", weakestUnresolvedChoice: "The final CTA remains intentionally restrained.",
  };
}

test("inspectPng reports a real decodable PNG without an sRGB chunk as unprofiled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "content-hub-carousel-png-"));
  const path = join(directory, "tiny.png");
  await makeTinyPng(path);

  assert.deepEqual(await inspectPng(path), {width: 2, height: 2, colorProfile: null, decodes: true});
});

test("inspectPng rejects corrupt PNG chunk structure before decode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "content-hub-carousel-png-"));
  const base = join(directory, "base.png");
  await makeTinyPng(base);
  const bytes = await readFile(base);
  const cases = [
    ["invalid-intent.png", insertPngChunk(bytes, pngChunk("sRGB", Buffer.from([4])), "IDAT"), /sRGB/i],
    ["duplicate-srgb.png", insertPngChunk(insertPngChunk(bytes, pngChunk("sRGB", Buffer.from([0])), "IDAT"), pngChunk("sRGB", Buffer.from([0])), "IDAT"), /sRGB/i],
    ["late-srgb.png", insertPngChunk(bytes, pngChunk("sRGB", Buffer.from([0])), "IEND"), /sRGB/i],
    ["missing-iend.png", bytes.subarray(0, -12), /dimensions|truncated/i],
    ["bad-crc.png", Buffer.from(bytes)],
  ];
  cases.at(-1)[1][cases.at(-1)[1].length - 1] ^= 1;
  for (const [name, payload, pattern] of cases) {
    const path = join(directory, name);
    await writeFile(path, payload);
    await assert.rejects(inspectPng(path), pattern);
  }
});

test("inspectPng rejects conflicting valid sRGB and iCCP profiles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "content-hub-carousel-png-"));
  const base = join(directory, "base.png");
  await makeTinyPng(base);
  const bytes = await readFile(base);
  const profile = Buffer.concat([Buffer.from("profile\0", "latin1"), Buffer.from([0]), Buffer.from([120, 156, 3, 0, 0, 0, 0, 1])]);
  const conflicting = insertPngChunk(
    insertPngChunk(bytes, pngChunk("sRGB", Buffer.from([0])), "IDAT"),
    pngChunk("iCCP", profile),
    "IDAT",
  );
  const path = join(directory, "conflicting-profiles.png");
  await writeFile(path, conflicting);

  await assert.rejects(inspectPng(path), /conflicting|profile|iCCP/i);
});

test("passes six ordered slide pairs with exact PNG dimensions", async () => {
  const fixtureInput = await fixture();
  const evidence = await runCarouselTechnicalQc(fixtureInput.projectDir, fixtureInput.bundle.bundlePath, input(fixtureInput));

  assert.equal(evidence.payload.pass, true);
  assert.equal(evidence.payload.slideCount, 6);
  assert.deepEqual(evidence.payload.formats, ["4:5", "1:1"]);
  assert.equal(evidence.payload.reportFiles.contactSheets.length, 3);
  assert.deepEqual(JSON.parse(await readFile(join(fixtureInput.projectDir, evidence.payload.reportFiles.json), "utf8")), evidence);
});

test("carousel QC ignores forged approvals and parent maps when the approval log is empty", async () => {
  const fixtureInput = await fixture();
  await writeFile(join(fixtureInput.projectDir, "Plans/approvals.jsonl"), "");

  const evidence = await runCarouselTechnicalQc(fixtureInput.projectDir, fixtureInput.bundle.bundlePath, input(fixtureInput));

  assert.equal(evidence.payload.checks.find(({id}) => id === "bundle.required-approval").pass, false);
});

test("carousel QC rejects a stale supplied approval after a current rejection", async () => {
  const fixtureInput = await fixture();
  await recordApproval(fixtureInput.projectDir, coordinator, {
    kind: "carousel-copy", workItemId: "carousel-001",
    subject: {artifactId: fixtureInput.copy.artifact.artifactId, sha256: fixtureInput.copy.ref.sha256},
    decision: "rejected", approver: {actorId: "human-yash", role: "human"}, origin: "user", policyVersion: versions.policy,
  });

  const evidence = await runCarouselTechnicalQc(fixtureInput.projectDir, fixtureInput.bundle.bundlePath, input(fixtureInput));

  assert.equal(evidence.payload.checks.find(({id}) => id === "bundle.required-approval").pass, false);
});

test("carousel QC rejects a locked asset absent from project ledgers", async () => {
  const fixtureInput = await fixture({asset: true});

  const evidence = await runCarouselTechnicalQc(fixtureInput.projectDir, fixtureInput.bundle.bundlePath, input(fixtureInput));

  assert.equal(evidence.payload.checks.find(({id}) => id === "bundle.local-dependencies").pass, false);
});

test("one bad square render fails its whole slide pair", async () => {
  const fixtureInput = await fixture();
  const path = fixtureInput.bundle.files.find(({slideId, format}) => slideId === "slide-03" && format === "1:1").path;
  fixtureInput.imageFacts.set(path, {width: 1079, height: 1080, colorProfile: "sRGB", decodes: true});

  const evidence = await runCarouselTechnicalQc(fixtureInput.projectDir, fixtureInput.bundle.bundlePath, input(fixtureInput));

  assert.equal(evidence.payload.pass, false);
  assert.ok(evidence.payload.checks.some(({id, pass}) => id === "carousel.slide-pair.slide-03" && !pass));
});

test("a layout warning fails the matching pair and bundle", async () => {
  const fixtureInput = await fixture({layoutWarning: true});

  const evidence = await runCarouselTechnicalQc(fixtureInput.projectDir, fixtureInput.bundle.bundlePath, input(fixtureInput));

  assert.equal(evidence.payload.pass, false);
  assert.ok(evidence.payload.checks.some(({id, pass}) => id === "carousel.slide-pair.slide-01" && !pass));
});

test("slide order must exactly match frozen contracts before contact sheets", async () => {
  const fixtureInput = await fixture({slideTwoFirst: true});
  const evidence = await runCarouselTechnicalQc(fixtureInput.projectDir, fixtureInput.bundle.bundlePath, input(fixtureInput));

  assert.equal(evidence.payload.pass, false);
  assert.ok(evidence.payload.checks.some(({id, pass}) => id === "carousel.structure" && !pass));
  assert.deepEqual(evidence.payload.reportFiles.contactSheets, []);
});

test("a reported-but-missing contact sheet fails the bundle", async () => {
  const fixtureInput = await fixture();
  const evidence = await runCarouselTechnicalQc(fixtureInput.projectDir, fixtureInput.bundle.bundlePath, input(fixtureInput, {
    run: async () => ({code: 0, stdout: "", stderr: ""}),
  }));

  assert.equal(evidence.payload.pass, false);
  assert.ok(evidence.payload.checks.some(({id, pass}) => id === "carousel.contact-sheets" && !pass));
});

test("atomic contact promotion rolls back partial finals and permits a new revision", async () => {
  const fixtureInput = await fixture();
  let promotions = 0;
  const failed = await runCarouselTechnicalQc(fixtureInput.projectDir, fixtureInput.bundle.bundlePath, input(fixtureInput, {
    link: async (source, target) => {
      promotions += 1;
      if (promotions === 2) throw new Error("forced promotion failure");
      return link(source, target);
    },
  }));
  const qcDir = join(fixtureInput.projectDir, "QC/carousel-001/v001");

  assert.equal(failed.payload.pass, false);
  assert.ok(failed.payload.checks.some(({id, pass}) => id === "carousel.contact-sheets" && !pass));
  for (const name of ["contact-sheet-4x5.jpg", "contact-sheet-square.jpg", "contact-sheet-paired.jpg"]) {
    await assert.rejects(lstat(join(qcDir, name)), {code: "ENOENT"});
  }
  assert.equal(JSON.parse(await readFile(join(qcDir, "technical-qc.json"), "utf8")).payload.pass, false);
  const revisionTwo = await createRevision(fixtureInput, 2);
  const retried = await runCarouselTechnicalQc(revisionTwo.projectDir, revisionTwo.bundle.bundlePath, input(revisionTwo));
  assert.equal(retried.payload.pass, true);
  assert.equal(retried.payload.reportFiles.contactSheets.length, 3);
  assert.ok(retried.payload.reportFiles.contactSheets.every(({sha256}) => /^[a-f0-9]{64}$/u.test(sha256)));
});

test("atomic contact promotion preserves an existing target", async () => {
  const fixtureInput = await fixture();
  const existing = join(fixtureInput.projectDir, "QC/carousel-001/v001/contact-sheet-square.jpg");
  await mkdir(dirname(existing), {recursive: true});
  await writeFile(existing, "preserve-me");

  const evidence = await runCarouselTechnicalQc(fixtureInput.projectDir, fixtureInput.bundle.bundlePath, input(fixtureInput));

  assert.equal(evidence.payload.pass, false);
  assert.equal(await readFile(existing, "utf8"), "preserve-me");
});

test("a mismatched paired-carousel profile hash fails before render inspection", async () => {
  const fixtureInput = await fixture({profileHash: "f".repeat(64)});
  let inspected = false;
  const evidence = await runCarouselTechnicalQc(fixtureInput.projectDir, fixtureInput.bundle.bundlePath, input(fixtureInput, {
    inspectPng: async () => { inspected = true; return null; },
  }));

  assert.equal(inspected, false);
  assert.equal(evidence.payload.pass, false);
  assert.ok(evidence.payload.checks.some(({id, pass}) => id === "bundle.profile" && !pass));
});

test("creative review must evidence every frozen full-resolution slide format", async () => {
  const fixtureInput = await fixture();
  const technical = await runCarouselTechnicalQc(fixtureInput.projectDir, fixtureInput.bundle.bundlePath, input(fixtureInput));
  const locators = fixtureInput.bundle.files.map(({slideId, format}) => ({type: "slide", value: `${slideId}/${format}`}));
  const creative = await recordCreativeReview(fixtureInput.projectDir, fixtureInput.bundle.bundlePath, join(fixtureInput.projectDir, technical.payload.reportFiles.json), creativeReview(fixtureInput, locators));
  assert.equal(creative.payload.pass, true);

  const withoutStructured = creativeReview(fixtureInput, locators);
  delete withoutStructured.carouselEvidence;
  await assert.rejects(recordCreativeReview(fixtureInput.projectDir, fixtureInput.bundle.bundlePath, join(fixtureInput.projectDir, technical.payload.reportFiles.json), withoutStructured), /creative evidence/i);

  const incomplete = await fixture();
  const incompleteTechnical = await runCarouselTechnicalQc(incomplete.projectDir, incomplete.bundle.bundlePath, input(incomplete));
  const partialLocators = incomplete.bundle.files.slice(0, 7).map(({slideId, format}) => ({type: "slide", value: `${slideId}/${format}`}));
  await assert.rejects(recordCreativeReview(incomplete.projectDir, incomplete.bundle.bundlePath, join(incomplete.projectDir, incompleteTechnical.payload.reportFiles.json), creativeReview(incomplete, partialLocators)), /every carousel slide format/i);
});
