# Optional strict runtime

Strict mode ships with the completed audited engine under `engine/`. It provides immutable artifacts, role-separated approvals, filesystem locks, workflow transitions, candidate freezing, bounded retry, real technical and creative QC, video execution with Premiere readback, and release evidence.

Check it with:

```bash
node runtime/strict/adapter.mjs doctor --json
```

Run `node runtime/strict/engine/bin/content-hub.mjs --help` for the full command surface. Strict records are content-hashed and stored inside the selected project.

Advanced users may set `BIZIBEAST_STRICT_RUNTIME` to a compatible larger runtime checkout. The bundled runtime remains the default, and Quick/Crew never load either strict path.
