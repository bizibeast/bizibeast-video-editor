# HyperFrames

Use HyperFrames 0.8.25 for deterministic captions, titles, lower thirds, full-frame explainers and layered portrait graphics. Keep Premiere as final assembler.

The original Sunburst templates live in `templates/hyperframes/compositions/`:

- `title.html` — opaque 16:9 editorial card;
- `animated-captions.html` — transparent 9:16 caption overlay;
- `lower-third.html` — transparent 9:16 identity card;
- `layered-portrait.html` — transparent back/front graphic passes.

Run `node scripts/render-hyperframes.mjs --template <name> --output <file> --variables '<json>'`. Use `--variables-file` when values contain substantial text.

For a true behind-subject composite, render `layered` twice: first with `showFront:false`, then with `showBack:false`. Premiere places the subject between those sidecars.

Templates use finite CSS animation and local font files, with no CDN or runtime network request. Run setup with `--install` to download Archivo, Fraunces and their OFL licences. Validate a changed template with HyperFrames strict checks and fully decode the render with FFmpeg.
