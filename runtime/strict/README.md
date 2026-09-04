# Optional strict runtime

Strict mode ships with a compact portable runtime at `core.mjs`. It provides immutable artifacts, role-separated approvals, workflow transitions, candidate freezing, bounded retry, independent technical and creative QC, and release evidence.

Check it with:

```bash
node runtime/strict/adapter.mjs doctor --json
```

All state-changing commands accept a project plus `--input input.json`; run `node runtime/strict/cli.mjs` without arguments for usage. Records are content-hashed and stored under the project's `.bizibeast-strict/` directory.

Advanced users may set `BIZIBEAST_STRICT_RUNTIME` to a compatible larger runtime checkout. The bundled runtime remains the default, and Quick/Crew never load either strict path.
