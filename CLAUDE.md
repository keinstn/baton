# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run build       # tsc → dist/
npm run typecheck   # tsc --noEmit
npm run lint        # biome check .
npm run format      # biome format --write .
npm run test        # vitest run (all tests)

npx vitest run test/worker.test.ts        # single test file
npx vitest run -t "test name substring"   # single test by name
```

CI (PRs to main) runs lint, typecheck, and test — all three must pass.

## What Baton is

Baton is a long-running daemon that polls a **GitHub Projects v2** board, claims eligible issues, and runs a coding agent (**Claude Code CLI** or **Copilot CLI**) in an isolated per-issue workspace. It is a port of OpenAI's Symphony service with two adapter layers swapped (tracker: Linear → GitHub Projects; agent: Codex app-server → Claude Code / Copilot).

**`docs/SPEC.md` is normative.** Code comments cite it (`SPEC §8.5` etc.) — preserve and add these citations when touching orchestration logic. `docs/DESIGN.md` (Japanese) covers implementation design decisions; where it disagrees with the code, the code wins (e.g. DESIGN sketches the Agent SDK, but the actual adapter spawns the CLI as a subprocess).

Key boundary: **the orchestrator only reads the tracker.** All tracker writes (status moves, comments, PR creation) are performed by the agent itself inside the workspace via the `gh` CLI, as instructed by the prompt in `WORKFLOW.md`.

## Architecture

The whole runtime is wired in `src/cli.ts`; data flows:

```
WORKFLOW.md → loader/reloader → Orchestrator tick loop → Worker (per issue)
                                      ↑ poll                  ├─ WorkspaceManager (clone + hooks)
                              GitHubProjectsClient            └─ AgentRunner (claude-code | copilot)
```

- **`WORKFLOW.md` contract** (`src/workflow/`, `src/config/schema.ts`): YAML front matter (tracker, polling, workspace, hooks, agent, claude_code/copilot settings) + LiquidJS prompt body rendered in strict mode (`src/prompt/builder.ts`). Hot-reloaded on file change: `WorkflowReloader` keeps the last-known-good config, and consumers read config/template through **getter closures** (`() => reloader.config()`) so a reload takes effect on the next tick without restart. `ClaudeCodeRunner`, `WorkspaceManager`, and the tracker accept new config via `applyConfig`.

- **Orchestrator** (`src/orchestrator/orchestrator.ts`): owns the single authoritative in-memory state (running entries, retry schedule — no database). Tick: validate config → fetch candidates in `active_states` with `required_labels` → sort → dispatch up to `max_concurrent_agents`. Reconciliation and stall detection cancel runs via each entry's `AbortController`, setting `stopReason` first so the worker-exit handler can distinguish intentional stops from failures. Failures retry with exponential backoff (`retry.ts`, `retry-manager.ts`); clean exits with the issue still active get a 1-second continuation retry.

- **Worker** (`src/orchestrator/worker.ts`): one attempt = one agent session. Flow: create workspace → render prompt (before hooks, so template errors fail without side effects) → `before_run` hook → start session → loop turns until the issue leaves the active states (re-fetched between turns), `agent.max_turns` is hit, or the run is aborted. Turn 1 uses the rendered task prompt; continuation turns resume the session with short guidance only.

- **Agent adapters** (`src/agent/`): implement the `AgentRunner` interface (`startSession`/`runTurn`/`stopSession`) and normalize output into `AgentEvent`s (`runner.ts`). `claude-code.ts` runs `claude -p --output-format stream-json` as a subprocess, prompt on stdin, `--resume <session_id>` for continuation turns. `copilot.ts` is the second adapter (JSONL output, fresh-session fallback when resume fails, reports 0 token usage per spec). Shared subprocess plumbing lives in `process.ts`.

- **Tracker** (`src/tracker/github-projects.ts`): raw `fetch`-based GraphQL client (no octokit). Project/field node IDs are resolved once and cached. The Projects API has no server-side Status filter, so all items are paged in and filtered client-side. Retries `gql()` on HTTP/2 GOAWAY.

- **Workspaces** (`src/workspace/`): deterministic per-issue dirs (`<repo>-<issue#>`) under `workspace.root`, sanitized and contained to the root. Hooks (`after_create`, `before_run`) run via `bash -lc` with `BATON_*` env vars. Terminal-state issue workspaces are cleaned at startup and on reconciliation.

- **Observability** (`src/observability/`): structured JSON logs to stderr (`LOG_LEVEL=debug|info|warn|error`); optional `node:http` dashboard (`--port` flag or `server.port`) exposing `/api/v1/state` and `POST /api/v1/refresh`.

## Conventions

- ESM throughout (`"type": "module"`, NodeNext): relative imports **must use `.js` extensions** even in `.ts` files.
- TypeScript strict mode with `noUncheckedIndexedAccess`; Biome for lint/format (double quotes, 2-space indent).
- Tests (`test/`, Vitest) mock the tracker and agent subprocesses — they map to the test matrix in SPEC §17. Shared fixtures in `test/helpers.ts`.
- The HTTP API and log fields use snake_case; internal TypeScript uses camelCase.
