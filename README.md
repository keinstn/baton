# Baton

Baton conducts coding agents against a GitHub Projects board — the thing you wave to make a
[symphony](https://github.com/openai/symphony) happen.

Baton is a long-running automation service that continuously reads work items from a
**GitHub Projects (v2)** board, creates an isolated workspace for each issue, and runs a coding
agent session — **Claude Code CLI** (via the Claude Agent SDK) or **GitHub Copilot CLI** — for that
issue inside the workspace. Engineers manage the work on the board; Baton manages the agents.

Baton is a port of the [Symphony service specification](../symphony/SPEC.md) with two adapter
layers swapped:

| Layer | Symphony | Baton |
|---|---|---|
| Issue tracker | Linear (GraphQL) | GitHub Projects v2 (GraphQL) |
| Coding agent | Codex app-server | Claude Code (Claude Agent SDK) / Copilot CLI |

Everything else — the polling orchestrator, claim/retry/reconciliation state machine, per-issue
workspaces, the repository-owned `WORKFLOW.md` contract, and the observability requirements —
follows the Symphony spec unchanged.

> [!WARNING]
> Baton runs coding agents with auto-approved permissions in trusted environments. Read the
> Security section of the spec before pointing it at a real board.

## Documents

- [`docs/SPEC.md`](docs/SPEC.md) — the Baton service specification (language-agnostic, normative,
  same chapter structure as Symphony's `SPEC.md`)
- [`docs/DESIGN.md`](docs/DESIGN.md) — implementation design: architecture, adapter mappings,
  module layout, and the phased implementation plan (TypeScript / Node.js)

## How it works (one paragraph)

Every `polling.interval_ms`, Baton queries the configured Project board for issues whose Status is
in `active_states` (e.g. `Todo`, `In Progress`) and carries the `required_labels`. Eligible issues
are claimed and dispatched to a worker, which prepares a per-issue workspace (clone via hooks),
renders the issue into the `WORKFLOW.md` prompt template, and drives a Claude Code session in that
workspace. The agent does the work and performs all tracker writes itself with the `gh` CLI —
commenting progress, opening a PR, and moving the Status to the handoff state (e.g. `In Review`).
Baton stops sessions whose issues leave the active states and cleans up workspaces for terminal
issues.

## License

Apache License 2.0 (same as Symphony).
