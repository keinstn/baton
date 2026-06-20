---
"baton": minor
---

## New Features

- **baton-dashboard CLI**: new `baton-dashboard` command providing a client-side multi-instance view of running Baton daemons (#105)
- **baton-log section**: WORKFLOW files now support an append-only `baton-log` section in progress comments for persistent agent notes across turns (#104)
- **[Baton Implementer] prefix**: WORKFLOW.md now requires the `[Baton Implementer]` visible prefix on agent-generated comments to distinguish them from human comments (#102)

## Bug Fixes

- Add CORS headers to all daemon HTTP responses and handle OPTIONS preflight requests (#109)
- Use Copilot-compatible `allow_tools` in WORKFLOW.copilot.md reviewer example (#98)
- Replace hardcoded `origin/main` with `origin/HEAD` in examples/WORKFLOW.md (#100)
- Add single-branch clone and `origin/main` fallback in WORKFLOW.copilot.md (#97)
- Replace `git ls-remote` with `git show-ref` in WORKFLOW.copilot.md `before_run` hook (#96)

## Documentation

- Document `baton-dashboard` CLI usage in README.md (#107)
- Rewrite example existing-PR feedback loop handling in WORKFLOW examples (#87)
- Add base-branch conflict handling guidance to example feedback loop
- Design dual-workflow agent coordination with shared-account markers (#89)

## Internal

- Extract shared `createSession` helper for agent adapters (#83)
- Consolidate workspace hook execution into private helper (#84)
- Extract shared `parseJsonLine` helper for agent adapters (#85)
- Replace `isMap` with `isRecord` in schema.ts (#86)
