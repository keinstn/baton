---
"baton": minor
---

## New Features

- **baton-dashboard CLI**: new `baton-dashboard` command providing a client-side multi-instance view of running Baton daemons (#105)
- **baton-log section**: WORKFLOW files now support an append-only `baton-log` section in progress comments for persistent agent notes across turns (#104)
- **[Baton Implementer] / [Baton Reviewer] prefix**: WORKFLOW files now require a visible `[Baton Implementer]` or `[Baton Reviewer]` prefix on all agent-generated comments so human and agent activity are distinguishable even when they share the same GitHub account (#102)
- **Dual-workflow reviewer example**: `examples/WORKFLOW.copilot.md` is redesigned as a dedicated Copilot reviewer workflow that pairs with the Claude implementer workflow. The reviewer runs in an isolated workspace, inspects the pushed PR head, posts structured findings tagged with `<!-- baton-reviewer-summary -->` / `<!-- baton-reviewer-finding -->` markers (`[must]`/`[ask]`/`[imo]`), and routes the issue back to "In Progress" or forward to "In Review". Agent-only review loops are capped at 3 handoffs before escalating to human review (#89)

## Bug Fixes

- Add CORS headers to all daemon HTTP responses and handle OPTIONS preflight requests (#109)
- Use Copilot-compatible `allow_tools` in WORKFLOW.copilot.md reviewer example (#98)
- Replace hardcoded `origin/main` with `origin/HEAD` in examples/WORKFLOW.md (#100)
- Add single-branch clone and `origin/main` fallback in WORKFLOW.copilot.md (#97)
- Replace `git ls-remote` with `git show-ref` in WORKFLOW.copilot.md `before_run` hook (#96)

## Documentation

- Document `baton-dashboard` CLI usage in README.md (#107)
- Document running dual-workflow processes together in README.md (separate workspace roots, shared "Agent Review" status) (#89)
- Improve existing-PR feedback loop in WORKFLOW examples: structured three-source approach (PR comments, unresolved inline review threads, review summaries) with `<!-- baton-agent-reply -->` markers (#87)
- Add base-branch conflict handling guidance to example feedback loop

## Internal

- Extract shared `createSession` helper for agent adapters (#83)
- Consolidate workspace hook execution into private helper (#84)
- Extract shared `parseJsonLine` helper for agent adapters (#85)
- Replace `isMap` with `isRecord` in schema.ts (#86)
