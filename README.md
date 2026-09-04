# BiziBeast Video Editor

A local-first Agent Skill for editing personal videos by chatting with an AI agent. It uses Premiere Pro for the final timeline and HyperFrames for animated captions and motion graphics.

It is a skill and a small toolbox—not a hosted app. Your footage, transcripts, voices and renders stay on your machine by default.

## What it can do

- Turn raw footage or an approved voice-over script into a finished short.
- Transcribe locally, remove silence, choose compelling cuts and order multiple clips.
- Add native captions, animated caption overlays, title cards, lower thirds, music, SFX and transitions.
- Render Sunburst motion graphics with HyperFrames 0.8.25.
- Assemble and export through Premiere Pro MCP 1.14.5.
- Run FFmpeg technical QC and an independent creative review.
- Work in Quick, Crew or optional Strict mode.

## Requirements

- Node.js 20.19 or newer
- FFmpeg and FFprobe
- Adobe Premiere Pro
- A supported agent client that can load Agent Skills and connect to MCP servers
- macOS for the current Premiere connector workflow

## Install

```bash
git clone https://github.com/bizibeast/bizibeast-video-editor.git
cd bizibeast-video-editor
node scripts/setup.mjs --install
node scripts/doctor.mjs
```

`setup.mjs` installs the exact npm dependencies with lifecycle scripts disabled, downloads Archivo and Fraunces directly from the Google Fonts repository together with their OFL files, detects local tools, and writes ignored machine-specific config under `.bizibeast/`.

Copy or symlink this repository into your agent's skills directory. In Codex, install it under the configured skills location and invoke `$bizibeast-video-editor`.

The generated `.bizibeast/mcp.json` contains the local command for Premiere MCP. Add that server entry to your agent client. The MCP server is limited to `inspect,edit,export,filesystem`; arbitrary scripting is intentionally excluded. The Adobe-side connector must be installed separately from the reviewed upstream `v1.14.5` release by following its official instructions.

## Use

```text
Use $bizibeast-video-editor in Crew mode. Edit the footage in this folder into a polished 45-second vertical short. Keep everything local.
```

Crew mode is the default and delegates media, story, design, HyperFrames, Premiere and QC roles when the host supports subagents. Without subagents, the same roles run sequentially. Quick mode uses one editor agent. Strict mode can connect to the optional audit-grade runtime described in `runtime/strict/README.md`.

Create a project manually if useful:

```bash
node scripts/new-project.mjs "Launch short"
node scripts/sample-fixture.mjs
node scripts/render-hyperframes.mjs --template title --output Projects/launch-short/Renders/title-v001.mp4
node scripts/qc.mjs Projects/launch-short/Final/launch-short-v001.mp4 --report Projects/launch-short/QC/final-v001.json
```

## Templates

The repository includes original dependency-free Sunburst HyperFrames templates for a title, animated captions, lower third and layered portrait graphics. Font binaries are downloaded during setup rather than committed.

## Privacy and permissions

Local-only is the default. The skill never authorizes publishing. Voice cloning requires explicit authorization from the voice subject immediately before cloning.

## Development

```bash
npm test
npm run check
```

Generate the 12-second test clip locally, then QC it:

```bash
node scripts/sample-fixture.mjs --output /tmp/bizibeast-sample.mp4
node scripts/qc.mjs /tmp/bizibeast-sample.mp4 --json
```

## Licence

MIT. See `THIRD_PARTY_NOTICES.md` for tool, font and trademark notices.
