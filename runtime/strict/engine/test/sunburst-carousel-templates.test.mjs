import assert from "node:assert/strict";
import test from "node:test";

import {
  SUNBURST_ARCHETYPES,
  SUNBURST_CAROUSEL_FORMATS,
  renderSunburstSlideMarkup,
} from "../Templates/Carousels/sunburst-pack/archetypes.mjs";

const slide = {
  id: "sunburst-01",
  label: "Editorial system",
  copy: [
    {text: "Make", fontRole: "display"},
    {text: "the work unmistakable.", fontRole: "body"},
  ],
  support: "A paired type message that stays readable at target size.",
  order: 1,
  total: 6,
};

function relativeLuminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/giu).map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(a, b) {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

test("renders every Sunburst archetype in both fixed formats", () => {
  for (const archetype of SUNBURST_ARCHETYPES) {
    for (const [format, {width, height}] of Object.entries(SUNBURST_CAROUSEL_FORMATS)) {
      const html = renderSunburstSlideMarkup({...slide, archetype}, format, {fontRoot: "file:///project/Assets/Fonts"});
      assert.match(html, new RegExp(`width:${width}px`, "u"));
      assert.match(html, new RegExp(`height:${height}px`, "u"));
      assert.match(html, new RegExp(`class="slide ${archetype}"`, "u"));
      assert.match(html, /data-page-label="01 \/ 06"/u);
      assert.match(html, /font-family:"Fraunces"/u);
      assert.match(html, /font-family:"Archivo"/u);
      assert.match(html, /class="copy-display">Make<\/span> <span class="copy-body">the work unmistakable\.<\/span>/u);
      assert.match(html, /\.copy-display \{ font-family: "Fraunces", serif; font-weight: 800; \}/u);
      assert.match(html, /\.copy-body \{ font-family: "Archivo", sans-serif; font-weight: 900; \}/u);
      assert.doesNotMatch(html, /\.sans-statement \.copy-display/u);
      assert.match(html, /\.split-proof \.message \{ max-width: calc\(50% - 192px\); \}/u);
      assert.match(html, /\.serif-hook \.message, \.serif-hook footer \{ color: var\(--paper\); background: var\(--ink\); \}/u);
      assert.match(html, /\.cta-closer \.message \{ color: var\(--ink\);/u);
      assert.match(html, /\.cta-closer footer \{ color: var\(--paper\);/u);
    }
  }
});

test("escapes untrusted slide copy and attributes", () => {
  const html = renderSunburstSlideMarkup({
    ...slide,
    id: 'slide"><script>bad()</script>',
    label: "<b>label</b>",
    copy: [{text: "<img src=x onerror=bad()>", fontRole: "display"}, {text: "& body", fontRole: "body"}],
    support: '"support" & <tag>',
    archetype: "serif-hook",
  }, "4:5", {fontRoot: "file:///project/Assets/Fonts"});

  assert.doesNotMatch(html, /<script>bad\(\)<\/script>|<img src=x|<b>label<\/b>|<tag>/u);
  assert.match(html, /slide&quot;&gt;&lt;script&gt;bad\(\)&lt;\/script&gt;/u);
  assert.match(html, /&lt;img src=x onerror=bad\(\)&gt;/u);
  assert.match(html, /&quot;support&quot; &amp; &lt;tag&gt;/u);
});

test("serif-hook copy passes AA against every Sunburst gradient stop", () => {
  const html = renderSunburstSlideMarkup({...slide, archetype: "serif-hook"}, "4:5", {fontRoot: "file:///project/Assets/Fonts"});
  const variables = Object.fromEntries([...html.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/giu)].map((match) => [match[1], match[2]]));
  const rule = /\.serif-hook \.message, \.serif-hook footer \{ color: var\(--([a-z-]+)\); background: var\(--([a-z-]+)\); \}/u.exec(html);
  const foregroundName = rule?.[1];
  const surfaceName = rule?.[2];
  const gradientStops = /--sunburst-linear:\s*linear-gradient\([^)]+\)/u.exec(html)?.[0].match(/#[0-9a-f]{6}/giu) ?? [];

  assert.ok(foregroundName, "serif-hook foreground token is declared");
  assert.equal(gradientStops.length, 3);
  assert.ok(gradientStops.some((stop) => contrastRatio(variables[foregroundName], stop) < 4.5), "the light copy needs a contrast surface");
  assert.ok(contrastRatio(variables[foregroundName], variables[surfaceName]) >= 4.5, "copy and its declared surface must pass AA");
});

test("rejects invalid renderer contracts", () => {
  assert.throws(() => renderSunburstSlideMarkup({...slide, archetype: "unknown"}, "4:5", {fontRoot: "file:///project/Assets/Fonts"}), /Unsupported archetype/u);
  assert.throws(() => renderSunburstSlideMarkup({...slide, archetype: "serif-hook"}, "16:9", {fontRoot: "file:///project/Assets/Fonts"}), /Unsupported carousel format/u);
  assert.throws(() => renderSunburstSlideMarkup({...slide, archetype: "serif-hook", order: 0}, "4:5", {fontRoot: "file:///project/Assets/Fonts"}), /order/u);
  assert.throws(() => renderSunburstSlideMarkup({...slide, archetype: "serif-hook", copy: [{text: "Only display", fontRole: "display"}]}, "4:5", {fontRoot: "file:///project/Assets/Fonts"}), /display and body/u);
  assert.throws(() => renderSunburstSlideMarkup({...slide, archetype: "serif-hook"}, "4:5", {fontRoot: "https://fonts.example"}), /local file URL/u);
  assert.throws(() => renderSunburstSlideMarkup({...slide, archetype: "serif-hook"}, "4:5", {fontRoot: "file://fonts.example/share"}), /local file URL/u);
});
