# Crew mode

Crew is the default. The coordinator owns the project and delegates these bounded outputs:

1. Media Technician → probe report, source order, transcript and word timings.
2. Story Editor → compelling selects and silence-removal plan.
3. Design Director → shot-level graphics, captions, SFX and music plan.
4. HyperFrames Executor → versioned transparent or opaque sidecars.
5. Premiere Executor → assembled timeline, native captions, export and readback.
6. QC Reviewer → independent technical and visual verdict.

Read [roles.md](roles.md) and give each worker only the project paths and prior outputs it needs. The coordinator resolves conflicts and returns the final file.

If the host cannot delegate, the current agent performs the same roles sequentially, writing each role's output before moving to the next. Do not silently downgrade QC: run it after the editing pass, with fresh inspection of the export.

Crew mode uses normal files, version numbers, and SHA-256 hashes where useful. It does not require Strict mode's approval state machine.
