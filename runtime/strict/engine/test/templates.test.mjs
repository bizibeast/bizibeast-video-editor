import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {access, readFile} from "node:fs/promises";
import {dirname, join, relative, resolve} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

test("template catalog has unique, workspace-local sources", async () => {
  const catalog = JSON.parse(await readFile(join(root, "Templates", "catalog.json"), "utf8"));
  const ids = catalog.templates.map(({id}) => id);
  assert.equal(new Set(ids).size, ids.length);

  for (const template of catalog.templates) {
    const source = resolve(root, "Templates", template.path);
    assert.equal(relative(join(root, "Templates"), source).startsWith(".."), false);
    await access(source);
  }
});

test("Sunburst templates use only pinned local fonts and exact palette tokens", async () => {
  const pack = join(root, "Templates", "HyperFrames", "content-hub-pack");
  const css = await readFile(join(pack, "assets", "sunburst.css"), "utf8");

  for (const value of ["#11100E", "#FFF7E8", "#FFFFFF", "#FF4A1F", "#F21C12", "#FFAE1A", "#F28B7C"]) {
    assert.match(css, new RegExp(value, "i"));
  }
  assert.match(css, /@font-face[\s\S]*Fraunces/u);
  assert.match(css, /@font-face[\s\S]*Archivo/u);
  assert.doesNotMatch(css, /https?:\/\//u);
  assert.equal(
    await sha256File(join(pack, "assets", "fonts", "Fraunces[SOFT,WONK,opsz,wght].ttf")),
    "177ff6c0f14e5550a3c624247cd1189611d4eb65d000b14944c63d967958abbb",
  );
  assert.equal(
    await sha256File(join(pack, "assets", "fonts", "Archivo[wdth,wght].ttf")),
    "0e094a7d3c7c4c25cf1310c4b30014f1dae9332220b1c2c88f4fa996f0b05053",
  );
});

test("Sunburst title and portrait lower-third keep the offline motion contract", async () => {
  const pack = join(root, "Templates", "HyperFrames", "content-hub-pack");
  const compositions = [
    ["sunburst-title-card", "sunburst-title-card-v1"],
    ["sunburst-lower-third-portrait", "sunburst-lower-third-portrait-v1"],
  ];

  for (const [basename, id] of compositions) {
    const html = await readFile(join(pack, "compositions", `${basename}.html`), "utf8");
    const motion = JSON.parse(await readFile(join(pack, "compositions", `${basename}.motion.json`), "utf8"));
    assert.match(html, new RegExp(`data-composition-id=["']${id}["']`, "u"));
    assert.match(html, /(?:href|src)=["']assets\/sunburst\.css["']/u);
    assert.match(html, /(?:href|src)=["']assets\/gsap\.min\.js["']/u);
    assert.match(html, /\.full-bleed\s*\{[\s\S]*inset:\s*0/u);
    assert.equal((html.match(/gsap\.timeline\(\{\s*paused:\s*true\s*\}\)/gu) || []).length, 1);
    assert.match(html, /window\.__timelines\[root\.dataset\.compositionId\]\s*=\s*tl/u);
    assert.doesNotMatch(html, /https?:\/\//u);
    assert.ok(motion.assertions.some(({kind}) => kind === "appearsBy"));
    assert.ok(motion.assertions.some(({kind}) => kind === "before"));
    assert.ok(motion.assertions.some(({kind}) => kind === "staysInFrame"));
    assert.ok(motion.assertions.some(({kind, maxStaticSec}) => kind === "keepsMoving" && maxStaticSec <= 2));
  }

  const lowerThird = await readFile(join(pack, "compositions", "sunburst-lower-third-portrait.html"), "utf8");
  assert.match(lowerThird, /bottom:\s*420px/u);
});

test("Sunburst caption source exposes four identities without runtime font swaps", async () => {
  const pack = join(root, "Templates", "HyperFrames", "content-hub-pack");
  const [source, css] = await Promise.all([
    readFile(join(pack, "compositions", "sunburst-animated-captions-portrait.html"), "utf8"),
    readFile(join(pack, "assets", "sunburst.css"), "utf8"),
  ]);
  for (const style of ["clean", "editorial-pair", "punch", "karaoke-pair"]) assert.match(source, new RegExp(style, "u"));
  assert.match(source, /bottom:\s*420px/u);
  assert.match(source, /word\.fontRole === "display"/u);
  assert.match(source, /Punch cue[\s\S]*display[\s\S]*body/u);
  assert.match(css, /\.sunburst-display\s*\{[\s\S]*font-family:\s*"Fraunces"/u);
  assert.match(css, /\.sunburst-body\s*\{[\s\S]*font-family:\s*"Archivo"/u);
  assert.doesNotMatch(source, /fontFamily\s*=/u);
});

test("Sunburst templates are registered with the current pack pin", async () => {
  const catalog = JSON.parse(await readFile(join(root, "Templates", "catalog.json"), "utf8"));
  const packageJson = JSON.parse(await readFile(join(root, "Templates", "HyperFrames", "content-hub-pack", "package.json"), "utf8"));
  const ids = new Set(catalog.templates.map(({id}) => id));
  assert.equal(ids.has("sunburst-title-card-v1"), true);
  assert.equal(ids.has("sunburst-lower-third-portrait-v1"), true);
  assert.equal(ids.has("sunburst-animated-captions-portrait-v1"), true);
  assert.match(packageJson.scripts["check:sunburst"], /hyperframes@0\.8\.25/u);
  assert.match(packageJson.scripts["render:sunburst-title"], /hyperframes@0\.8\.25/u);
  assert.match(packageJson.scripts["render:sunburst-lower-third"], /hyperframes@0\.8\.25/u);
  assert.match(packageJson.scripts["render:sunburst-captions"], /hyperframes@0\.8\.25/u);
});
