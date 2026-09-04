# Strict mode

Strict mode is optional. It adds immutable artifacts, exact parent hashes, separate producers and approvers, workflow transitions, candidate freezing, retry records, technical QC, creative QC, and promotion evidence.

The portable runtime is bundled. Run:

```bash
node runtime/strict/adapter.mjs doctor --json
```

The adapter uses `runtime/strict/cli.mjs` by default. Advanced users may point `BIZIBEAST_STRICT_RUNTIME` at a compatible larger runtime checkout; the environment override is optional. Quick and Crew modes never depend on it.

Use Strict only when the user explicitly requests an audit trail or independent approvals. Do not fake receipts.
