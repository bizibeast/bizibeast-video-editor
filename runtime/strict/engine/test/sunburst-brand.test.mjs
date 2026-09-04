import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import test from "node:test";

import {sha256File} from "../src/checksum.mjs";

const brandRoot = join(process.cwd(), "Brand", "Sunburst");
const linearGradient = "linear-gradient(135deg, #F21C12 0%, #FF4A1F 48%, #FFAE1A 100%)";
const radialGradient = "radial-gradient(circle, #FFAE1A 0%, #FF4A1F 52%, #F21C12 100%)";

test("Sunburst freezes exact tokens, fonts, licences, and local assets", async () => {
  const manifest = JSON.parse(await readFile(join(brandRoot, "manifest.json"), "utf8"));
  const frame = await readFile(join(brandRoot, "frame.md"), "utf8");

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, "sunburst-editorial");
  assert.equal(manifest.version, "1.0.0");
  assert.equal(manifest.frame, "frame.md");
  assert.equal(manifest.sourceCommit, "45b0855d499c093e4d1bd08926fec4e1a582e225");
  assert.deepEqual(manifest.colors, {
    ink: "#11100E", paper: "#FFF7E8", white: "#FFFFFF", flame: "#FF4A1F",
    vermilion: "#F21C12", sun: "#FFAE1A", blush: "#F28B7C",
  });
  assert.deepEqual(manifest.fonts, [
    {
      family: "Fraunces",
      path: "Fonts/Fraunces[SOFT,WONK,opsz,wght].ttf",
      sha256: "177ff6c0f14e5550a3c624247cd1189611d4eb65d000b14944c63d967958abbb",
      weights: [700, 800, 900],
      licencePath: "Licences/Fraunces-OFL.txt",
      licenceSha256: "bdf4c22802eaf804f998195871c6b8938aac2ac14b2d78a8bd66a6f1eced833b",
    },
    {
      family: "Archivo",
      path: "Fonts/Archivo[wdth,wght].ttf",
      sha256: "0e094a7d3c7c4c25cf1310c4b30014f1dae9332220b1c2c88f4fa996f0b05053",
      weights: [400, 600, 800, 900],
      licencePath: "Licences/Archivo-OFL.txt",
      licenceSha256: "108b4e57c9c796d3d38d0428ca7ee39de47ad93187302718d9b2d8864b9b716b",
    },
  ]);
  assert.deepEqual(manifest.assets.map(({path}) => path), [
    "Assets/sunburst-motifs.svg",
    "Assets/sunburst-grain.svg",
  ]);

  for (const font of manifest.fonts) {
    assert.equal(await sha256File(join(brandRoot, font.path)), font.sha256);
    assert.equal(await sha256File(join(brandRoot, font.licencePath)), font.licenceSha256);
  }
  for (const asset of manifest.assets) {
    assert.equal(await sha256File(join(brandRoot, asset.path)), asset.sha256);
  }

  assert.match(frame, /Fraunces/);
  assert.match(frame, /Archivo/);
  assert.doesNotMatch(frame, /https?:\/\//u);

  const [, frontmatter, prose] = frame.split("---");
  assert.ok(frontmatter.includes(`  linear: "${linearGradient}"`));
  assert.ok(frontmatter.includes(`  radial: "${radialGradient}"`));
  assert.ok(prose.includes(linearGradient));
  assert.ok(prose.includes(radialGradient));
});
