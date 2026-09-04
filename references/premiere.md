# Premiere Pro

Use `premiere-pro-mcp@1.14.5` with local stdio transport and capabilities limited to `inspect,edit,export,filesystem`. Do not enable arbitrary-script capability.

Run `node scripts/premiere.mjs verify --json` before any edit. It performs the MCP safe connection check and blocks unless Premiere, a project and an active sequence are live. `readback` captures project and active-sequence structure; `edit --tool <name> --input <args.json>` verifies live state first, performs the allowed MCP call, then re-reads the active sequence.

Premiere owns source imports, timeline cuts, audio mix, editable native captions, sidecar placement, grading, project save and final export. Save the `.prproj` inside the project's `Premiere/` folder.

Portrait default: 1080×1920, 30 fps. Track convention: V1 picture, V2 background graphics, V3 subject/foreground, V4 captions; A1 dialogue, A2 SFX, A3 music. The design plan may change tracks when the edit requires it, but must document the change.

For text behind a person, render separate HyperFrames back and front passes and place the subject or a local matte between them. If reliable subject isolation is unavailable, use face-safe foreground placement instead of pretending the layer is behind the subject.

After every structural edit, inspect the active sequence and confirm clip paths, in/out ranges, tracks and duration. After export, confirm the file exists and run FFmpeg QC. A successful MCP response alone is not export proof.

The sample MCP configuration uses the exact reviewed package version. Installing Adobe's unsigned connector may require a separate, informed local security decision; this skill does not alter Adobe debug settings automatically.
