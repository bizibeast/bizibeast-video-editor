import assert from "node:assert/strict";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import * as proof from "../scripts/sunburst/render-style-proof.mjs";

const {renderSunburstStyleProof} = proof;

const packDir = join(process.cwd(), "Templates", "HyperFrames", "content-hub-pack");

test("style proof checks, renders, decodes, and creates a contact sheet", async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), "sunburst-style-proof-"));
  t.after(() => rm(outputDir, {recursive: true, force: true}));
  const calls = [];

  const result = await renderSunburstStyleProof(packDir, outputDir, {
    run: async (command, args, options) => {
      calls.push([command, args, options]);
      return {code: 0, stdout: "", stderr: ""};
    },
    verifyFile: async () => true,
  });

  assert.deepEqual(calls.map(([command]) => command), ["npm", "npm", "ffmpeg", "ffmpeg"]);
  assert.deepEqual(calls[0][1], ["run", "check:sunburst"]);
  assert.equal(calls[0][2].cwd, packDir);
  assert.match(result.reel, /style-reel-v001\.mp4$/u);
  assert.match(result.contactSheet, /style-contact-sheet-v001\.jpg$/u);
  assert.match(result.report, /style-proof-v001\.json$/u);

  const report = JSON.parse(await readFile(result.report, "utf8"));
  assert.equal(report.visualApproval, "pending");
  assert.equal(report.reel, result.reel);
  assert.equal(report.contactSheet, result.contactSheet);
});

test("style reel keeps the frozen Sunburst sources and offline motion contract", async () => {
  const compositionPath = join(packDir, "compositions", "sunburst-style-reel.html");
  const motionPath = join(packDir, "compositions", "sunburst-style-reel.motion.json");
  const [html, motion, packageJson] = await Promise.all([
    readFile(compositionPath, "utf8"),
    readFile(motionPath, "utf8").then(JSON.parse),
    readFile(join(packDir, "package.json"), "utf8").then(JSON.parse),
  ]);

  assert.match(html, /data-composition-id="sunburst-style-reel-v1"/u);
  assert.match(html, /data-width="1920"[\s\S]*data-height="1080"[\s\S]*data-duration="6"/u);
  assert.equal((html.match(/class="scene beat-/gu) || []).length, 3);
  for (const sourceId of [
    "sunburst-title-card-v1",
    "sunburst-lower-third-portrait-v1",
    "sunburst-animated-captions-portrait-v1",
    "sunburst-carousel-archetypes-v1",
  ]) assert.match(html, new RegExp(sourceId, "u"));
  assert.equal((html.match(/gsap\.timeline\(\{\s*paused:\s*true\s*\}\)/gu) || []).length, 1);
  assert.match(html, /\},\s*\.2\)/u);
  assert.doesNotMatch(html, /https?:\/\//u);
  assert.equal(motion.duration, 6);
  assert.ok(motion.assertions.some(({kind}) => kind === "keepsMoving"));
  assert.match(packageJson.scripts["render:style-reel"], /hyperframes@0\.8\.25/u);
});

test("carousel proof renders, decodes, hashes, and orders all formats and contact sheets", async (t) => {
  assert.equal(typeof proof.renderSunburstCarouselProof, "function");
  const outputDir = await mkdtemp(join(tmpdir(), "sunburst-carousel-proof-"));
  t.after(() => rm(outputDir, {recursive: true, force: true}));
  const captures = [];
  const sheets = [];
  const inspections = [];

  const result = await proof.renderSunburstCarouselProof(process.cwd(), outputDir, {
    captureHtml: async (html, path, dimensions) => captures.push({html, path, dimensions}),
    createContactSheet: async (paths, path, spec) => sheets.push({paths, path, spec}),
    inspectPng: async (path, dimensions) => {
      inspections.push({path, dimensions});
      return {...dimensions, sha256: String(inspections.length).padStart(64, "0")};
    },
  });

  assert.equal(captures.length, 12);
  assert.deepEqual(captures.slice(0, 6).map(({dimensions}) => dimensions), Array(6).fill({width: 1080, height: 1350}));
  assert.deepEqual(captures.slice(6).map(({dimensions}) => dimensions), Array(6).fill({width: 1080, height: 1080}));
  assert.deepEqual(captures.map(({html}) => /class="slide ([a-z-]+)"/u.exec(html)?.[1]), [
    "serif-hook", "sans-statement", "split-proof", "quote-stat", "list-process", "cta-closer",
    "serif-hook", "sans-statement", "split-proof", "quote-stat", "list-process", "cta-closer",
  ]);
  assert.equal(sheets.length, 3);
  assert.deepEqual(sheets.map(({spec}) => spec.name), ["4:5", "1:1", "paired"]);
  assert.equal(inspections.length, 15);

  const manifest = JSON.parse(await readFile(result.manifest, "utf8"));
  assert.equal(manifest.visualApproval, "pending");
  assert.deepEqual(manifest.formats["4:5"].images.map(({archetype}) => archetype), [
    "serif-hook", "sans-statement", "split-proof", "quote-stat", "list-process", "cta-closer",
  ]);
  assert.deepEqual(manifest.formats["1:1"].images.map(({archetype}) => archetype), [
    "serif-hook", "sans-statement", "split-proof", "quote-stat", "list-process", "cta-closer",
  ]);
  assert.deepEqual(Object.keys(manifest.contactSheets), ["4:5", "1:1", "paired"]);
});

test("carousel proof keeps Chromium inside the outer offline sandbox", async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), "sunburst-carousel-browser-"));
  t.after(() => rm(outputDir, {recursive: true, force: true}));
  const browserCalls = [];
  await proof.renderSunburstCarouselProof(process.cwd(), outputDir, {
    run: async (command, args, options) => {
      browserCalls.push({command, args, options});
      return {code: 0, stdout: "", stderr: ""};
    },
    createContactSheet: async () => {},
    inspectPng: async (_path, dimensions) => ({...dimensions, sha256: "0".repeat(64)}),
  });

  assert.equal(browserCalls.length, 12);
  for (const {args, options} of browserCalls) {
    assert.ok(args.includes("--no-sandbox"), "the nested Chromium sandbox must be disabled under sandbox-exec");
    assert.ok(args.includes("--disable-background-networking"));
    assert.match(options.completeWhenFile, /carousel-(?:4x5|square)-\d{2}-[a-z-]+\.png$/u);
  }
});
