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

## Installation

**Prerequisites**

- [Node.js](https://nodejs.org/) ≥ 20
- [`gh` CLI](https://cli.github.com/) — used by the agent inside each workspace
- The coding agent binary matching your `agent.kind`:
  - `claude_code` → [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
  - `copilot` → [GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli)

**Windows**

Baton runs natively on Windows — no Git Bash required for basic operation. Agent
processes are spawned directly (no shell wrapper), and the process tree is terminated
with `taskkill /F /T` on timeout or stop.

If you configure hooks (`after_create`, `before_run`, `after_run`, `before_remove`
in your `WORKFLOW.md`), hooks are still executed via `bash -lc`. Install
[Git for Windows](https://gitforwindows.org/) and ensure `bash` is on your `PATH`
before using hooks on Windows.

**Build from source**

```sh
git clone https://github.com/keinstn/baton.git
cd baton/copilot
npm install
npm run build
```

To use `baton` as a global command, link it after building:

```sh
npm link
```

## Board Setup

Before running Baton, create and configure a GitHub Projects v2 board.

**1. Create a project board**

Navigate to your organization or user profile → **Projects** → **New project**. Choose the
**Board** template so issues are arranged in columns.

**2. Configure Status columns**

A new board starts with `Todo`, `In Progress`, and `Done`. If your prompt instructs the agent
to move issues to a custom state when done (e.g. `In Review`), add that column by clicking
**+** at the right edge of the board and selecting **New option**.

The column names must exactly match the values you reference in `WORKFLOW.md`. Configure which
states Baton should pick up work from:

```yaml
tracker:
  active_states: [Todo, In Progress]   # Baton picks up issues in these states
  # terminal_states: [Done]            # (optional) default: [Done]
```

The state the agent moves issues to when done is **not** a config key — specify it in your
`WORKFLOW.md` prompt body:

> When done, move the issue's Status to "In Review" on the project board.

**3. Create a label**

Go to the target repository → **Issues** → **Labels** → **New label**. Create a label named
`ai-ready` (or whatever you list under `required_labels` in `WORKFLOW.md`). Baton only
dispatches issues that carry this label.

**4. Generate a Personal Access Token**

Go to **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens**
and create a token with:

- **Projects** — Read and write
- Repository access for the repos your issues live in

Export it before running Baton:

```sh
export GITHUB_TOKEN=ghp_...
```

The `project_number` for `WORKFLOW.md` is the trailing integer in the project URL
(e.g. `https://github.com/orgs/my-org/projects/5` → `project_number: 5`).

## Usage

**1. Create a `WORKFLOW.md`**

The `WORKFLOW.md` file is the single configuration + prompt contract for your project. Copy one of the examples as a starting point:

- [`examples/WORKFLOW.md`](examples/WORKFLOW.md) — Claude Code agent
- [`examples/WORKFLOW.copilot.md`](examples/WORKFLOW.copilot.md) — GitHub Copilot agent

Edit the YAML front matter to point at your GitHub Project:

```yaml
tracker:
  owner: my-org          # GitHub org or user
  project_number: 5      # Project board number
  token: $GITHUB_TOKEN   # Fine-grained PAT or GitHub App token
  active_states: [Todo, In Progress]
  required_labels: [ai-ready]
agent:
  kind: claude_code      # or: copilot
```

**2. Set environment variables**

```sh
export GITHUB_TOKEN=ghp_...   # GitHub PAT with Projects read scope
export LOG_LEVEL=info         # Log verbosity: debug | info | warn | error (default: info)
```

**3. Run Baton**

```sh
baton WORKFLOW.md
```

`WORKFLOW.md` defaults to `./WORKFLOW.md` when omitted.

| Flag | Description |
|---|---|
| `--port N` / `-p N` | Enable the HTTP dashboard on port N (overrides `server.port` in front matter) |

Baton polls the board on every `polling.interval_ms` tick, dispatches eligible issues to agent workers, and logs structured JSON to stderr. Send `SIGINT` or `SIGTERM` to shut down gracefully.

Set `LOG_LEVEL=debug` to enable verbose diagnostic output (subprocess PIDs, agent events, GitHub API timing, tick cycle details).

## How it works (one paragraph)

Every `polling.interval_ms`, Baton queries the configured Project board for issues whose Status is
in `active_states` (e.g. `Todo`, `In Progress`) and carries the `required_labels`. Eligible issues
are claimed and dispatched to a worker, which prepares a per-issue workspace (clone via hooks),
renders the issue into the `WORKFLOW.md` prompt template, and drives a Claude Code session in that
workspace. The agent does the work and performs all tracker writes itself with the `gh` CLI —
commenting progress, opening a PR, and moving the Status out of `active_states` (e.g. to `In Review` as instructed in the prompt).
Baton stops sessions whose issues leave the active states and cleans up workspaces for terminal
issues.

## Architecture

```mermaid
flowchart TD
    Board["📋 GitHub Projects Board\n(Status: Todo / In Progress)"]

    subgraph Baton["Baton (long-running service)"]
        Orchestrator["Orchestrator\npoll · claim · retry · reconcile"]
        TrackerAdapter["Tracker Adapter\nGitHub Projects v2 GraphQL"]
        Worker["Worker\n(per issue)"]
        WorkspaceManager["Workspace Manager\nclone · after_create · before_run"]
        AgentRunner["Agent Runner"]
        ClaudeCode["Claude Code\n(Agent SDK)"]
        CopilotCLI["Copilot CLI"]
    end

    Board -->|"poll every interval_ms"| TrackerAdapter
    TrackerAdapter -->|"eligible issues"| Orchestrator
    Orchestrator -->|"dispatch"| Worker
    Worker --> WorkspaceManager
    WorkspaceManager -->|"workspace ready"| Worker
    Worker --> AgentRunner
    AgentRunner --> ClaudeCode
    AgentRunner --> CopilotCLI
    ClaudeCode -->|"gh CLI: comment · PR · status update"| Board
    CopilotCLI -->|"gh CLI: comment · PR · status update"| Board
```

## License

Apache License 2.0 (same as Symphony).
