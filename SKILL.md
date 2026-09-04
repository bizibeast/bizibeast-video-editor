---
name: bizibeast-video-editor
description: Use when a user asks an agent to edit, caption, animate, assemble, or QC personal video footage locally with Premiere Pro, HyperFrames, or optional Diffusion Studio.
---

# BiziBeast Video Editor

Turn supplied footage or an approved script into a polished, self-contained local video project. Premiere Pro is the final assembler; HyperFrames 0.8.25 produces deterministic motion sidecars.

## Non-negotiables

- Default to local-only processing. Do not upload footage, transcripts, source images, voice samples, or renders.
- Never overwrite source media or a passing final export. Create a new version.
- Voice cloning requires the subject's explicit authorization immediately before cloning. Script approval alone is not voice authorization.
- Do not claim an edit, render, or QC pass succeeded without editor readback or a fully decodable output.

## Start

Run `node scripts/doctor.mjs --json`, then read [project layout](references/project.md). Create a project with `node scripts/new-project.mjs "Project name"` unless resuming one.

Choose the mode from the user's words:

- **Crew mode (default):** read [Crew mode](references/crew-mode.md) and [role prompts](references/roles.md). Delegate roles when the host supports subagents; otherwise run the same roles sequentially in one agent.
- **Quick mode:** read [Quick mode](references/quick-mode.md). Use for experiments and simple short edits.
- **Strict mode:** read [Strict mode](references/strict-mode.md). Use only when the user asks for audit-grade approvals and immutable evidence.

## Edit

Read only the references needed for the job:

- [local media](references/local-media.md) for probing, transcription, voice, images, music, and assets;
- [Premiere](references/premiere.md) for timeline assembly and export;
- [HyperFrames](references/hyperframes.md) for captions and motion sidecars;
- [Sunburst brand](references/brand.md) for visual direction;
- [QC and delivery](references/qc.md) before returning a final video.

Diffusion Studio is optional and experimental. Use it only when requested or when a clearly isolated scene benefits from it; return its render to Premiere for final assembly.

## Finish

Return only a passing file from `Final/`, plus a short note naming the editor path used, QC result, and any capability that remained unavailable. Do not publish externally without a separate request.
