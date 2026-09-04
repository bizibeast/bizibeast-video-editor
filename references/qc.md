# QC and delivery

Run `node scripts/qc.mjs <export> --report QC/final-vNNN.json --json`. This verifies streams, duration, portrait dimensions and full decode. Use `--profile any` for non-portrait work.

Then perform visual QC at minimum on the hook, all transitions, caption-dense moments, layered shots and final frame. Check:

- story starts immediately and pacing stays intentional;
- no accidental black frames, freezes, silence or clipped dialogue;
- captions match speech, remain readable and avoid faces and UI safe zones;
- alpha sidecars composite cleanly;
- type, colour, spacing and animation follow the selected design;
- dialogue is intelligible and music/SFX do not overpower it;
- no watermarks, placeholder copy or missing assets remain.

Reject with timestamped fixes and create a new export version. Only copy a passing result into `Final/`. Return the video itself, not the internal project bureaucracy.
