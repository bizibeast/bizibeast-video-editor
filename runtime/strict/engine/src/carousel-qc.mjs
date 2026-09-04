import {link, lstat, mkdir, readFile, rm, unlink, writeFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {isAbsolute, join, relative} from "node:path";

import {createArtifactEnvelope, validateArtifactEnvelope, writeImmutableArtifact} from "./artifacts.mjs";
import {verifyCandidateBundle} from "./candidates.mjs";
import {sha256File} from "./checksum.mjs";
import {confinedProjectPath} from "./paths.mjs";
import {probeMedia} from "./media-probe.mjs";
import {runProcess} from "./process.mjs";
import {observed, qcCheck} from "./qc-check.mjs";
import {resolveTechnicalProfile} from "./qc-profiles.mjs";
import {validateCandidateProjectState} from "./qc.mjs";
import {assertIndependentReviewer} from "./roles.mjs";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = Uint32Array.from({length: 256}, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ value >>> 8;
  return (value ^ 0xffffffff) >>> 0;
}

function pngStructure(bytes) {
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error("PNG signature is invalid");
  let offset = PNG_SIGNATURE.length;
  let header = null;
  let colorProfile = null;
  let embeddedProfile = false;
  let idat = false;
  let ended = false;
  let plte = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error("PNG chunk is truncated");
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) throw new Error("PNG chunk data is truncated");
    if (bytes.readUInt32BE(end) !== crc32(bytes.subarray(offset + 4, end))) throw new Error("PNG chunk CRC is invalid");
    if (!header && type !== "IHDR") throw new Error("PNG IHDR must be first");
    if (type === "IHDR") {
      if (header || length !== 13 || offset !== PNG_SIGNATURE.length) throw new Error("PNG IHDR is invalid");
      header = {width: bytes.readUInt32BE(start), height: bytes.readUInt32BE(start + 4)};
    }
    if (type === "PLTE") plte = true;
    if (type === "IDAT") idat = true;
    if (type === "sRGB") {
      if (colorProfile || embeddedProfile || length !== 1 || idat || plte || bytes[start] > 3) throw new Error("PNG sRGB color profile is invalid or conflicting");
      colorProfile = "sRGB";
    }
    if (type === "iCCP") {
      const separator = bytes.indexOf(0, start);
      if (embeddedProfile || colorProfile || idat || plte || separator <= start || separator - start > 79
        || separator + 2 >= end || bytes[separator + 1] !== 0) throw new Error("PNG iCCP color profile is invalid or conflicting");
      embeddedProfile = true;
      colorProfile = "iCCP";
    }
    if (type === "IEND") {
      if (length !== 0 || end + 4 !== bytes.length) throw new Error("PNG IEND is invalid");
      ended = true;
      break;
    }
    if (ended) throw new Error("PNG has chunks after IEND");
    offset = end + 4;
  }
  if (!header || !idat || !ended || header.width < 1 || header.height < 1) throw new Error("PNG dimensions are unavailable");
  return {...header, colorProfile};
}

export async function inspectPng(path) {
  const structure = pngStructure(await readFile(path));
  const probe = await runProcess("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", path]);
  let stream;
  try {
    stream = JSON.parse(probe.stdout).streams?.find(({codec_type}) => codec_type === "video");
  } catch {
    stream = null;
  }
  if (probe.code !== 0 || stream?.codec_name !== "png" || stream.width !== structure.width || stream.height !== structure.height) throw new Error("PNG probe measurements are unavailable");
  const decode = await runProcess("ffmpeg", ["-v", "error", "-i", path, "-f", "null", "-"]);
  return {...structure, decodes: decode.code === 0};
}

function rel(projectDir, path) {
  return relative(projectDir, path).split("\\").join("/");
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : null;
}

function exactKeys(value, keys) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

async function readProjectJson(projectDir, requested, label) {
  if (typeof requested !== "string" || !requested) throw new Error(`${label} path is required`);
  const localPath = isAbsolute(requested) ? relative(projectDir, requested) : requested;
  const path = await confinedProjectPath(projectDir, localPath, {type: "file"});
  try {
    return {path, value: JSON.parse(await readFile(path, "utf8"))};
  } catch {
    throw new Error(`${label} JSON is malformed`);
  }
}

async function readSlideContracts(projectDir, bundle, path) {
  const document = await readProjectJson(projectDir, path, "Slide contracts");
  validateArtifactEnvelope(document.value);
  const artifact = document.value;
  const locked = bundle.inputLock.artifacts.find(({id}) => id === artifact.artifactId);
  if (!locked || locked.sha256 !== await sha256File(document.path) || artifact.payload?.kind !== "carousel-plan"
    || artifact.workItemId !== bundle.workItemId || artifact.revision !== bundle.revision || artifact.modality !== bundle.modality
    || artifact.producer?.role !== "design-director") throw new Error("Slide contracts must be a locked frozen carousel plan");
  const slides = artifact.payload.slides;
  if (!Array.isArray(slides) || slides.length < 6 || slides.length > 8) throw new Error("Slide contracts require six through eight slides");
  return slides.map((slide, index) => {
    if (!exactKeys(slide, ["id", "order", "copySha256", "altText"]) || slide.id !== `slide-${String(index + 1).padStart(2, "0")}` || slide.order !== index + 1 || !sha256(slide.copySha256) || !text(slide.altText)) {
      throw new Error("Slide contracts require ordered numbered copy hashes and alt text");
    }
    return slide;
  });
}

async function readLayoutAudit(projectDir, bundle, path) {
  const document = await readProjectJson(projectDir, path, "Layout audit");
  validateArtifactEnvelope(document.value);
  const artifact = document.value;
  const locked = bundle.inputLock.artifacts.find(({id}) => id === artifact.artifactId);
  if (!locked || locked.sha256 !== await sha256File(document.path) || artifact.payload?.kind !== "carousel-layout-audit"
    || artifact.workItemId !== bundle.workItemId || artifact.revision !== bundle.revision || artifact.modality !== bundle.modality
    || artifact.producer?.role !== "carousel-slide-executor" || !Array.isArray(artifact.payload.entries)) throw new Error("Layout audit must be a locked frozen carousel artifact");
  const entries = new Map();
  for (const entry of artifact.payload.entries) {
    if (!exactKeys(entry, ["slideId", "format", "copySha256", "overflow", "clipping", "unsafeCrop", "accidentalReflow", "missingFonts", "unresolvedWarnings"])
      || !text(entry.slideId) || !["4:5", "1:1"].includes(entry.format) || !sha256(entry.copySha256)
      || ["overflow", "clipping", "unsafeCrop", "accidentalReflow"].some((key) => typeof entry[key] !== "boolean")
      || !Array.isArray(entry.missingFonts) || !Array.isArray(entry.unresolvedWarnings)) throw new Error("Layout audit measurements are incomplete");
    const key = `${entry.slideId}\0${entry.format}`;
    if (entries.has(key)) throw new Error("Layout audit has duplicate slide formats");
    entries.set(key, entry);
  }
  return entries;
}

function validAudit(audit, copySha256) {
  return Boolean(audit) && audit.copySha256 === copySha256 && !audit.overflow && !audit.clipping && !audit.unsafeCrop
    && !audit.accidentalReflow && audit.missingFonts.length === 0 && audit.unresolvedWarnings.length === 0;
}

function writeTechnicalMarkdown(evidence) {
  return `# Technical QC ${evidence.payload.pass ? "PASS" : "FAIL"}\n\n${evidence.payload.checks.map(({id, pass}) => `- ${pass ? "PASS" : "FAIL"} ${id}`).join("\n")}\n`;
}

async function writeEvidence(projectDir, bundle, validator, checks, contactSheets = []) {
  const revision = String(bundle.revision).padStart(3, "0");
  const reportFiles = {
    json: `QC/${bundle.workItemId}/v${revision}/technical-qc.json`,
    markdown: `QC/${bundle.workItemId}/v${revision}/technical-qc.md`,
    contactSheets,
  };
  const payload = {
    kind: "technical-qc", candidateBundleHash: bundle.bundleHash, policyVersion: bundle.versions?.policy ?? "unknown",
    profileId: bundle.settings?.profileId ?? null, profileHash: bundle.settings?.profileHash ?? null,
    slideCount: bundle.files.filter(({kind}) => kind === "carousel-slide").length / 2,
    formats: ["4:5", "1:1"], pass: checks.every(({pass}) => pass), checks, reportFiles,
  };
  const evidence = createArtifactEnvelope({
    artifactId: `technical-qc-${bundle.workItemId}-v${revision}`, revision: bundle.revision,
    workItemId: bundle.workItemId, modality: bundle.modality,
    parents: bundle.inputLock.artifacts.map(({id: artifactId, sha256}) => ({artifactId, sha256})),
    producer: validator,
    versions: {tool: bundle.versions?.tool ?? "content-hub", template: bundle.versions?.template ?? null, model: bundle.versions?.model ?? null, policy: payload.policyVersion},
    status: payload.pass ? "passed" : "failed", payload,
  });
  await writeImmutableArtifact(projectDir, reportFiles.json, evidence);
  await writeFile(join(projectDir, reportFiles.markdown), writeTechnicalMarkdown(evidence), {encoding: "utf8", flag: "wx"});
  return evidence;
}

function gridLayout(count, width, height, columns) {
  return Array.from({length: count}, (_, index) => `${index % columns * width}_${Math.floor(index / columns) * height}`).join("|");
}

async function contactSheet(run, inputs, output, width, height, columns = 3) {
  const args = ["-v", "error"];
  for (const path of inputs) args.push("-i", path);
  const filters = inputs.map((_, index) => `[${index}:v]scale=${width}:${height}[s${index}]`);
  filters.push(`${inputs.map((_, index) => `[s${index}]`).join("")}xstack=inputs=${inputs.length}:layout=${gridLayout(inputs.length, width, height, columns)}:fill=white[out]`);
  args.push("-filter_complex", filters.join(";"), "-map", "[out]", "-frames:v", "1", "-q:v", "3", output);
  return run("ffmpeg", args);
}

async function pairedContactSheet(run, pairs, output) {
  const args = ["-v", "error"];
  for (const pair of pairs) args.push("-i", pair.fourByFive, "-i", pair.square);
  const filters = [];
  for (const [index] of pairs.entries()) {
    filters.push(`[${index * 2}:v]scale=216:270[a${index}]`, `[${index * 2 + 1}:v]scale=216:216,pad=216:270:0:27:white[b${index}]`, `[a${index}][b${index}]hstack[p${index}]`);
  }
  filters.push(`${pairs.map((_, index) => `[p${index}]`).join("")}xstack=inputs=${pairs.length}:layout=${gridLayout(pairs.length, 432, 270, 2)}:fill=white[out]`);
  args.push("-filter_complex", filters.join(";"), "-map", "[out]", "-frames:v", "1", "-q:v", "3", output);
  return run("ffmpeg", args);
}

async function assertMissing(paths) {
  for (const path of paths) {
    try {
      await lstat(path);
      throw new Error(`Contact sheet already exists: ${path}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function inspectContactSheet(path, run) {
  const media = await probeMedia(path);
  const stream = media.video[0];
  const decode = await run("ffmpeg", ["-v", "error", "-i", path, "-f", "null", "-"]);
  if (!stream?.width || !stream?.height || decode.code !== 0) throw new Error("Contact sheet failed verification");
  return {sha256: await sha256File(path), width: stream.width, height: stream.height};
}

async function promoteContactSheets(staged, sheets, run, linkFile) {
  const created = [];
  try {
    for (const [index, source] of staged.entries()) {
      await linkFile(source, sheets[index]);
      created.push(sheets[index]);
    }
    return await Promise.all(sheets.map((path) => inspectContactSheet(path, run)));
  } catch (error) {
    await Promise.all(created.map(async (path) => {
      try {
        await unlink(path);
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") throw cleanupError;
      }
    }));
    throw error;
  }
}

export async function runCarouselTechnicalQc(projectDir, bundlePath, input) {
  const bundle = await verifyCandidateBundle(projectDir, bundlePath);
  if (bundle.modality !== "carousel") throw new Error("Carousel QC requires a carousel candidate");
  if (!input?.validator || input.validator.role !== "technical-qc-validator") throw new Error("Carousel QC requires a technical-qc-validator");
  assertIndependentReviewer({producerActorId: bundle.producer.actorId, reviewerActorId: input.validator.actorId, reviewerRole: input.validator.role});
  const checks = [];
  const check = (id, pass, ownerStage, locator, observedValue, expected) => checks.push(qcCheck(id, pass, "hard", ownerStage, [observed(locator, observedValue, expected)]));
  try {
    const projectState = await validateCandidateProjectState(projectDir, bundle, "carousel-copy", bundle.versions?.policy);
    check("bundle.artifact-parents", true, "carousel-slide-executor", "inputLock.artifacts", projectState.artifacts.length, "current parent hashes");
    check("bundle.required-approval", true, "script-editorial", "inputLock.approvals", projectState.approval.id, "one current approved carousel copy");
    check("bundle.local-dependencies", true, "carousel-slide-executor", "inputLock.assets", projectState.dependencies.length, "current local dependency hashes");
  } catch (error) {
    check(error.checkId ?? "bundle.artifact-parents", false, error.ownerStage ?? "carousel-slide-executor", error.locator ?? "inputLock.artifacts", error.message, error.expected ?? "current project state");
    return writeEvidence(projectDir, bundle, input.validator, checks);
  }
  let profile;
  try {
    profile = resolveTechnicalProfile(bundle.settings?.profileId, input.profileContext);
    if (profile.modality !== "carousel" || bundle.settings?.profileHash !== profile.profileHash) throw new Error("Candidate profile hash mismatch");
    check("bundle.profile", true, "carousel-slide-executor", "settings.profileHash", bundle.settings.profileHash, profile.profileHash);
  } catch (error) {
    check("bundle.profile", false, "carousel-slide-executor", "settings.profileHash", bundle.settings?.profileHash ?? null, error.message);
  }
  if (!checks.at(-1).pass) return writeEvidence(projectDir, bundle, input.validator, checks);

  let contracts;
  let audits;
  try {
    contracts = await readSlideContracts(projectDir, bundle, input.slideContractsPath);
    audits = await readLayoutAudit(projectDir, bundle, input.layoutAuditPath);
    check("carousel.contracts", true, "script-editorial", "slide-contracts", contracts.length, "six through eight ordered frozen slides");
  } catch (error) {
    check("carousel.contracts", false, "script-editorial", "slide-contracts", error.message, "frozen slide contracts and complete layout audit");
    return writeEvidence(projectDir, bundle, input.validator, checks);
  }
  const slides = bundle.files.filter(({kind}) => kind === "carousel-slide");
  const namesPass = bundle.files.length === slides.length && slides.every(({path, slideId, format}) => new RegExp(`^slide-(\\d{2})-${format === "4:5" ? "4x5" : "1x1"}\\.png$`, "u").test(path.split("/").at(-1)) && path.split("/").at(-1).startsWith(`${slideId}-`));
  const countPass = slides.length === contracts.length * 2 && contracts.length >= 6 && contracts.length <= 8;
  const orderPass = slides.every((file, index) => file.slideId === contracts[Math.floor(index / 2)]?.id && file.format === (index % 2 === 0 ? "4:5" : "1:1"));
  check("carousel.structure", namesPass && countPass && orderPass, "carousel-slide-executor", "bundle.files", slides.map(({slideId, format}) => `${slideId}/${format}`), `${contracts.length} ordered PNG pairs`);
  const inspect = input.inspectPng ?? inspectPng;
  const pairs = [];
  for (const contract of contracts) {
    const files = slides.filter(({slideId}) => slideId === contract.id);
    const expected = ["4:5", "1:1"];
    let pairPass = files.length === 2 && files.map(({format}) => format).join(",") === expected.join(",");
    const found = new Map(files.map((file) => [file.format, file]));
    const pair = {id: contract.id};
    for (const format of expected) {
      const file = found.get(format);
      let facts;
      try {
        facts = file && await inspect(join(projectDir, file.path));
      } catch {
        facts = null;
      }
      const dimensions = profile.carousel.formats[format];
      const imagePass = Boolean(file && facts && facts.width === dimensions.width && facts.height === dimensions.height && facts.colorProfile === profile.carousel.colorProfile && facts.decodes === true);
      const audit = audits.get(`${contract.id}\0${format}`);
      pairPass &&= imagePass && file.approvedCopySha256 === contract.copySha256 && validAudit(audit, contract.copySha256);
      if (format === "4:5") pair.fourByFive = file && join(projectDir, file.path);
      else pair.square = file && join(projectDir, file.path);
    }
    checks.push(qcCheck(`carousel.slide-pair.${contract.id}`, pairPass, "hard", pairPass ? "carousel-slide-executor" : "carousel-slide-executor", [observed(contract.id, pairPass, "PNG, copy, numbering, alt text, and warning-free layout pair")]));
    pairs.push(pair);
  }
  if (!checks.every(({pass}) => pass)) return writeEvidence(projectDir, bundle, input.validator, checks);

  const revision = String(bundle.revision).padStart(3, "0");
  const qcDir = join(projectDir, "QC", bundle.workItemId, `v${revision}`);
  await mkdir(qcDir, {recursive: true});
  const sheets = [join(qcDir, "contact-sheet-4x5.jpg"), join(qcDir, "contact-sheet-square.jpg"), join(qcDir, "contact-sheet-paired.jpg")];
  const run = input.run ?? runProcess;
  const linkFile = input.link ?? link;
  const stage = join(qcDir, `.carousel-staging-${randomUUID()}`);
  let contactSheets = [];
  try {
    await assertMissing(sheets);
    await mkdir(stage, {recursive: false});
    const staged = sheets.map((path) => join(stage, path.split("/").at(-1)));
    const results = await Promise.all([
      contactSheet(run, pairs.map(({fourByFive}) => fourByFive), staged[0], 216, 270),
      contactSheet(run, pairs.map(({square}) => square), staged[1], 270, 270),
      pairedContactSheet(run, pairs, staged[2]),
    ]);
    if (!results.every(({code}) => code === 0)) throw new Error("Contact sheet render failed");
    const proofs = await promoteContactSheets(staged, sheets, run, linkFile);
    contactSheets = sheets.map((path, index) => ({path: rel(projectDir, path), ...proofs[index]}));
    check("carousel.contact-sheets", true, "carousel-slide-executor", "contact-sheets", contactSheets, "three generated decoded contact sheets");
  } catch (error) {
    check("carousel.contact-sheets", false, "carousel-slide-executor", "contact-sheets", error.message, "three generated decoded contact sheets");
  } finally {
    await rm(stage, {recursive: true, force: true});
  }
  return writeEvidence(projectDir, bundle, input.validator, checks, contactSheets);
}
