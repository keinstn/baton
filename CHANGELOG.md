# Changelog

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
