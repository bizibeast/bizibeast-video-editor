#!/usr/bin/env node
import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import {access, mkdir, mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, dirname, join, resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

import {
  SUNBURST_ARCHETYPES,
  SUNBURST_CAROUSEL_FORMATS,
  renderSunburstSlideMarkup,
} from "../../Templates/Carousels/sunburst-pack/archetypes.mjs";

function runProcess(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const {completeWhenFile, completeTimeoutMs = 30_000, ...spawnOptions} = options;
    const child = spawn(command, args, {...spawnOptions, stdio: ["ignore", "pipe", "pipe"]});
    let stdout = "";
    let stderr = "";
    let fileReady = false;
    let lastSize = -1;
    let stableChecks = 0;
    let poll;
    let timeout;
    let killTimer;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    if (completeWhenFile) {
      poll = setInterval(async () => {
        if (fileReady) return;
        try {
          const {size} = await stat(completeWhenFile);
          stableChecks = size > 0 && size === lastSize ? stableChecks + 1 : 0;
          lastSize = size;
          if (stableChecks >= 2) {
            fileReady = true;
            child.kill("SIGTERM");
            killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
          }
        } catch (error) {
          if (error?.code !== "ENOENT") stderr += `\n${error.message}`;
        }
      }, 100);
      timeout = setTimeout(() => {
        stderr += `\nTimed out waiting for ${completeWhenFile}`;
        child.kill("SIGKILL");
      }, completeTimeoutMs);
    }
    child.on("close", (code) => {
      clearInterval(poll);
      clearTimeout(timeout);
      clearTimeout(killTimer);
      resolveRun({code: fileReady ? 0 : code, stdout, stderr});
    });
  });
}

async function fileIsNonEmpty(path) {
  return (await stat(path)).size > 0;
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

const carouselSlides = [
  {label: "House style", copy: [{text: "Make", fontRole: "display"}, {text: "it unmistakable.", fontRole: "body"}], support: "A bold editorial system for every format."},
  {label: "The standard", copy: [{text: "Clarity", fontRole: "body"}, {text: "wins attention.", fontRole: "display"}], support: "One message, one focal treatment, zero clutter."},
  {label: "Proof", copy: [{text: "One system.", fontRole: "display"}, {text: "Two ratios.", fontRole: "body"}], support: "The same hierarchy holds in portrait and square."},
  {label: "Signal", copy: [{text: "6×", fontRole: "display"}, {text: "more recognizable", fontRole: "body"}], support: "Repeat the language, not the layout."},
  {label: "Process", copy: [{text: "Hook. Explain.", fontRole: "body"}, {text: "Resolve.", fontRole: "display"}], support: "A short sequence with a clear editorial rhythm."},
  {label: "Next move", copy: [{text: "Ship", fontRole: "display"}, {text: "the memorable version.", fontRole: "body"}], support: "Keep the source local, frozen, and editable."},
];

async function chromeExecutable() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean);
  for (const path of candidates) {
    try {
      await access(path);
      return path;
    } catch {
      // Try the next installed browser.
    }
  }
  throw new Error("No installed local Chromium browser was found");
}

function contactSheetFilter(spec) {
  if (spec.name === "4:5") {
    return `${Array.from({length: 6}, (_, index) => `[${index}:v]scale=324:405[s${index}]`).join(";")};[s0][s1][s2]hstack=inputs=3[r0];[s3][s4][s5]hstack=inputs=3[r1];[r0][r1]vstack=inputs=2[out]`;
  }
  if (spec.name === "1:1") {
    return `${Array.from({length: 6}, (_, index) => `[${index}:v]scale=324:324[s${index}]`).join(";")};[s0][s1][s2]hstack=inputs=3[r0];[s3][s4][s5]hstack=inputs=3[r1];[r0][r1]vstack=inputs=2[out]`;
  }
  const rows = Array.from({length: 6}, (_, index) => {
    const portrait = index * 2;
    const square = portrait + 1;
    return `[${portrait}:v]scale=256:320[p${index}];[${square}:v]scale=256:256,pad=256:320:0:32:color=0x11100E[q${index}];[p${index}][q${index}]hstack=inputs=2[r${index}]`;
  });
  return `${rows.join(";")};${Array.from({length: 6}, (_, index) => `[r${index}]`).join("")}vstack=inputs=6[out]`;
}

export async function renderSunburstCarouselProof(repositoryDir, outputDir, dependencies = {}) {
  const run = dependencies.run ?? runProcess;
  const tempDir = await mkdtemp(join(tmpdir(), "sunburst-carousel-proof-"));
  const execute = async (command, args, options) => {
    const result = await run(command, args, options);
    if (result?.code !== 0) throw new Error(`${command} failed (${result?.code ?? "unknown"}): ${result?.stderr || result?.stdout || "no output"}`);
    return result;
  };
  const captureHtml = dependencies.captureHtml ?? (async (html, outputPath, dimensions) => {
    const sourcePath = join(tempDir, `${basename(outputPath)}.html`);
    await rm(outputPath, {force: true});
    await writeFile(sourcePath, html, "utf8");
    await execute(await chromeExecutable(), [
      "--headless=new",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-gpu",
      "--disable-sync",
      "--force-device-scale-factor=1",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-sandbox",
      `--user-data-dir=${join(tempDir, `${basename(outputPath)}-profile`)}`,
      "--virtual-time-budget=1000",
      `--window-size=${dimensions.width},${dimensions.height}`,
      `--screenshot=${outputPath}`,
      pathToFileURL(sourcePath).href,
    ], {completeWhenFile: outputPath});
  });
  const inspectPng = dependencies.inspectPng ?? (async (path, expected) => {
    const probe = await execute("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", path]);
    const {width, height} = JSON.parse(probe.stdout).streams?.[0] ?? {};
    if (width !== expected.width || height !== expected.height) throw new Error(`Unexpected PNG dimensions for ${path}: ${width}x${height}`);
    await execute("ffmpeg", ["-v", "error", "-i", path, "-f", "null", "-"]);
    return {width, height, sha256: await sha256File(path)};
  });
  const createContactSheet = dependencies.createContactSheet ?? (async (paths, outputPath, spec) => {
    await execute("ffmpeg", [
      "-v", "error",
      ...paths.flatMap((path) => ["-i", path]),
      "-filter_complex", contactSheetFilter(spec),
      "-map", "[out]",
      "-frames:v", "1",
      "-update", "1",
      "-y",
      outputPath,
    ]);
  });

  await mkdir(outputDir, {recursive: true});
  try {
    const fontRoot = pathToFileURL(join(repositoryDir, "Brand", "Sunburst", "Fonts")).href;
    const formats = {};
    for (const [format, dimensions] of Object.entries(SUNBURST_CAROUSEL_FORMATS)) {
      const images = [];
      for (const [index, archetype] of SUNBURST_ARCHETYPES.entries()) {
        const order = index + 1;
        const outputPath = join(outputDir, `carousel-${format === "4:5" ? "4x5" : "square"}-${String(order).padStart(2, "0")}-${archetype}.png`);
        const html = renderSunburstSlideMarkup({...carouselSlides[index], id: `sunburst-${String(order).padStart(2, "0")}`, archetype, order, total: 6}, format, {fontRoot});
        await captureHtml(html, outputPath, dimensions);
        const inspected = await inspectPng(outputPath, dimensions);
        if (inspected.width !== dimensions.width || inspected.height !== dimensions.height) throw new Error(`Unexpected PNG dimensions for ${outputPath}`);
        images.push({order, archetype, path: basename(outputPath), ...inspected});
      }
      formats[format] = {...dimensions, images};
    }

    const sheetSpecs = [
      {name: "4:5", width: 972, height: 810, paths: formats["4:5"].images.map(({path}) => join(outputDir, path))},
      {name: "1:1", width: 972, height: 648, paths: formats["1:1"].images.map(({path}) => join(outputDir, path))},
      {name: "paired", width: 512, height: 1920, paths: formats["4:5"].images.flatMap(({path}, index) => [join(outputDir, path), join(outputDir, formats["1:1"].images[index].path)])},
    ];
    const contactSheets = {};
    for (const spec of sheetSpecs) {
      const outputPath = join(outputDir, `carousel-contact-sheet-${spec.name.replace(":", "x")}-v001.png`);
      await createContactSheet(spec.paths, outputPath, spec);
      contactSheets[spec.name] = {path: basename(outputPath), ...await inspectPng(outputPath, spec)};
    }

    const manifest = join(outputDir, "carousel-proof-v001.json");
    await writeFile(manifest, `${JSON.stringify({schemaVersion: 1, formats, contactSheets, visualApproval: "pending"}, null, 2)}\n`, "utf8");
    return {manifest, formats, contactSheets};
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
}

export async function renderSunburstStyleProof(packDir, outputDir, dependencies = {}) {
  const run = dependencies.run ?? runProcess;
  const verifyFile = dependencies.verifyFile ?? fileIsNonEmpty;
  await mkdir(outputDir, {recursive: true});
  const reel = join(outputDir, "style-reel-v001.mp4");
  const contactSheet = join(outputDir, "style-contact-sheet-v001.jpg");
  const report = join(outputDir, "style-proof-v001.json");

  const execute = async (command, args, options) => {
    const result = await run(command, args, options);
    if (result?.code !== 0) throw new Error(`${command} failed (${result?.code ?? "unknown"}): ${result?.stderr || result?.stdout || "no output"}`);
  };

  await execute("npm", ["run", "check:sunburst"], {cwd: packDir});
  await execute("npm", ["run", "render:style-reel", "--", "--output", reel], {cwd: packDir});
  if (!(await verifyFile(reel))) throw new Error(`Style reel was not created: ${reel}`);
  await execute("ffmpeg", ["-v", "error", "-i", reel, "-f", "null", "-"]);
  await execute("ffmpeg", ["-v", "error", "-i", reel, "-vf", "fps=1,scale=480:-1,tile=3x2:padding=8:margin=8", "-frames:v", "1", "-y", contactSheet]);
  if (!(await verifyFile(contactSheet))) throw new Error(`Contact sheet was not created: ${contactSheet}`);
  await writeFile(report, `${JSON.stringify({schemaVersion: 1, reel, contactSheet, visualApproval: "pending"}, null, 2)}\n`);
  return {reel, contactSheet, report};
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const repositoryDir = resolve(dirname(scriptPath), "..", "..");
  const outputDir = join(repositoryDir, "QC", "Sunburst");
  const style = await renderSunburstStyleProof(
    join(repositoryDir, "Templates", "HyperFrames", "content-hub-pack"),
    outputDir,
  );
  const carousel = await renderSunburstCarouselProof(repositoryDir, outputDir);
  process.stdout.write(`${JSON.stringify({style, carousel})}\n`);
}
