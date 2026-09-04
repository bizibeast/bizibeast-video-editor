# Strict mode

Strict mode is optional. It adds immutable artifacts, exact parent hashes, separate producers and approvers, workflow transitions, candidate freezing, retry records, technical QC, creative QC, and promotion evidence.

The original strict runtime is coupled to the larger Content Hub repository and is intentionally not duplicated here. Point `BIZIBEAST_STRICT_RUNTIME` at a compatible local runtime checkout, then run:

```bash
node runtime/strict/adapter.mjs doctor --json
```

The adapter passes arguments directly to that runtime's `bin/content-hub.mjs`. Quick and Crew modes never depend on this environment variable.

Use Strict only when the user explicitly requests an audit trail or independent approvals. If the runtime is absent, report that Strict is unavailable and offer Crew mode; do not fake receipts.
