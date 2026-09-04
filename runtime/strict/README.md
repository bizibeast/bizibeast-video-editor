# Optional strict runtime

The original audit-grade workflow engine is substantially larger than this personal-use skill and is coupled to a Content Hub runtime. Duplicating it here would make default editing slower and create two divergent copies.

Strict mode therefore uses a local adapter. Point `BIZIBEAST_STRICT_RUNTIME` at a compatible checkout containing `bin/content-hub.mjs`, then call:

```bash
export BIZIBEAST_STRICT_RUNTIME=/path/to/content-hub-runtime
node runtime/strict/adapter.mjs doctor --json
```

The strict runtime provides immutable artifacts, role-separated approvals, exact parent hashes, workflow transitions, candidate freezing, retry policy, independent technical and creative QC, and release evidence. Quick and Crew modes do not load it.

This adapter is intentionally local and does not download or execute a runtime automatically.
