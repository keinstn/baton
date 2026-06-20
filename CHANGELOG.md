# Changelog

## 1.2.1

### Patch Changes

- d25c0fa: Fix `handoff_count` reset when re-entering agent review after human approval

  When an issue passed agent review (`status=pass`), was rejected by a human reviewer, and re-entered Agent Review, the old `handoff_count` carried over — exhausting the 3-loop limit on normal agent → human → agent round-trips instead of pure agent-only loops.

  The reviewer workflow now resets `handoff_count` to `0` when it detects a prior `status=pass` in the existing summary comment, scoping the loop limit to consecutive agent-only cycles as intended.

## 1.2.0

### Minor Changes

- 208ccbe: ## New Features

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
  - Harden `examples/WORKFLOW.md` before_run hook and feedback-loop path: detect in-progress git operations before branch switch; use `git show-ref` to distinguish known local branch from first-time checkout; fetch actual base branch name from PR metadata instead of hard-coding `main`; inspect and clean workspace state before merging; run `git merge --no-edit origin/$BASE_BRANCH` and resolve conflicts by intent; push once at the end so merge commit and feedback changes land together

  ## Internal

  - Extract shared `createSession` helper for agent adapters (#83)
  - Consolidate workspace hook execution into private helper (#84)
  - Extract shared `parseJsonLine` helper for agent adapters (#85)
  - Replace `isMap` with `isRecord` in schema.ts (#86)

## 1.1.0

### Minor Changes

- b596c73: Remove the aggregated dashboard (`baton-dashboard`) feature. A single baton instance can handle multiple repositories from one board (omit `tracker.repos` to target all repos; workspaces are namespaced as `<repo>-<issue#>`), so the separate aggregation process is no longer needed. This removes the `baton-dashboard` bin, `src/dashboard/`, the example config, and SPEC Appendix C. The per-instance HTTP server (§13.7 `/api/v1/state`, `/api/v1/refresh`) is unaffected.

### Patch Changes

- 8a61b68: Fix workspace directory identifier collisions when two repositories share the
  same name under different owners. Workspace keys are now built from
  `nameWithOwner` (`owner__repo-N`) instead of the bare repo name (`repo-N`),
  making them globally unique across organisations.
- 588af5b: Fix Windows bash spawn failures: prefer Git Bash over WSL's `System32\bash.exe`
  on PATH so hook and agent subprocesses can find `git`/`gh`, and pass
  `windowsHide: true` to all `spawn` calls so detached children don't pop up
  console windows.

## 1.0.0

### Major Changes

- feat: add changesets release automation — automate version PRs, tags, and GitHub Releases (`#69`)

### Minor Changes

- feat(dashboard): implement `baton-dashboard` CLI entry and bin wiring (`#61`)
- feat(dashboard): aggregated HTTP server — JSON API, multi-board HTML, refresh proxy (`#60`)
- feat(dashboard): board poller with up/down tracking and aggregated totals (`#59`)
- feat(dashboard): add YAML config loader and BoardState type (`#55`)

### Patch Changes

- fix: enable changesets changelog generation (`#70`)

## 0.1.0

### Minor Changes

- Initial MVP: orchestrator, worker, GitHub Projects v2 tracker, Claude Code adapter, WORKFLOW.md prompt engine (`3debfa5`)
- Phase 2: continuation turns, exponential backoff retry, reconciliation, stall detection (`#4`)
- Phase 2: WORKFLOW.md hot reload, startup workspace cleanup (`#5`)
- feat: add GitHub MCP remote server configuration (`#6`)
- feat: enable all project MCP servers in worktrees (`#7`)
- feat: hot-reload support for `claude_code.*` and `workspace.*` config sections (`#10`)
- feat: Copilot CLI adapter (`#11`)
- feat: HTTP dashboard and JSON state API — `/api/v1/state`, `POST /api/v1/refresh` (`#12`)
- feat: `LOG_LEVEL` filtering and enhanced debug logging (`#19`)
- feat(examples): add Rework status for post-review agent re-implementation (`#26`)
- feat: Windows support via Git Bash (`#36`)
- feat(dashboard): cyan dark terminal theme (`#47`)

### Patch Changes

- fix: correct `dist/` exclusion pattern in `biome.json` (`#3`)
- fix: graceful shutdown terminates running agent processes (`#27`)
- fix: retry `gql()` on HTTP/2 GOAWAY (`#25`)
- fix(tracker): extend `gql()` retry to ECONNRESET, timeouts, HTTP 502/503/429 (`#37`)
- fix(claude-code): emit best-effort usage when result line is killed (`#40`)
