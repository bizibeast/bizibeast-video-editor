# Project layout

Create one folder per video with `scripts/new-project.mjs`:

```text
project/
  project.json
  Source/             immutable copies of supplied footage and audio
  Assets/             Images, Music, SFX, Fonts, LUTs
  Premiere/           .prproj and Premiere-side metadata
  HyperFrames/        variables and composition work
  Plans/              transcript, story and design plans
  Renders/            intermediates and motion sidecars
  QC/                 reports and contact sheets
  Final/              passing delivery files only
```

Use filenames such as `short-v001.mp4`, incrementing the number for every revision. Never edit `Source/` in place or replace a passing file in `Final/`.

Reusable assets may stay in a user-selected shared library, but record their original path, licence and SHA-256 in `Plans/assets.json`, then copy the exact used bytes into the project before delivery.
