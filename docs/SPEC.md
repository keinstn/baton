# Baton Service Specification

Status: Draft v1 (language-agnostic)

Purpose: Define a service that orchestrates coding agents to get project work done, using
GitHub Projects (v2) as the issue tracker and Claude Code CLI or GitHub Copilot CLI as the
coding agent.

Lineage: This specification is a derivative of the Symphony Service Specification
(https://github.com/openai/symphony/blob/main/SPEC.md). Sections that Baton inherits unchanged are
marked `[= Symphony]` and restated in condensed form; sections that differ are written out in full.
Appendix B summarizes every difference for readers already familiar with Symphony.

## Normative Language

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`, `RECOMMENDED`, `MAY`, and
`OPTIONAL` in this document are to be interpreted as described in RFC 2119.

`Implementation-defined` means the behavior is part of the implementation contract, but this
specification does not prescribe one universal policy. Implementations MUST document the selected
behavior.

## 1. Problem Statement

Baton is a long-running automation service that continuously reads work from a GitHub Projects
(v2) board, creates an isolated workspace for each issue, and runs a coding agent session for that
issue inside the workspace.

The service solves the same four operational problems as Symphony:

- It turns issue execution into a repeatable daemon workflow instead of manual scripts.
- It isolates agent execution in per-issue workspaces so agent commands run only inside per-issue
  workspace directories.
- It keeps the workflow policy in-repo (`WORKFLOW.md`) so teams version the agent prompt and
  runtime settings with their code.
- It provides enough observability to operate and debug multiple concurrent agent runs.

Important boundary (inherited from Symphony):

- Baton is a scheduler/runner and tracker reader.
- Tracker writes (Status transitions, comments, PR links) are performed by the coding agent using
  the `gh` CLI (or a GitHub MCP server) available in the workflow/runtime environment.
- A successful run can end at a workflow-defined handoff state (for example `In Review`), not
  necessarily `Done`.

Implementations MUST document their trust and safety posture explicitly. Baton's reference posture
is high-trust (see Section 15).

## 2. Goals and Non-Goals

### 2.1 Goals `[= Symphony §2.1]`

- Poll GitHub Projects on a fixed cadence and dispatch work with bounded concurrency.
- Maintain a single authoritative orchestrator state for dispatch, retries, and reconciliation.
- Create deterministic per-issue workspaces and preserve them across runs.
- Stop active runs when issue state changes make them ineligible.
- Recover from transient failures with exponential backoff.
- Load runtime behavior from a repository-owned `WORKFLOW.md` contract.
- Expose operator-visible observability (at minimum structured logs).
- Support tracker/filesystem-driven restart recovery without requiring a persistent database.

### 2.2 Non-Goals `[= Symphony §2.2]`

- Rich web UI or multi-tenant control plane.
- General-purpose workflow engine or distributed job scheduler.
- Built-in business logic for how to edit issues, PRs, or comments (lives in the workflow prompt
  and agent tooling).
- Mandating a single approval/sandbox posture for all implementations.

## 3. System Overview

### 3.1 Main Components

1. `Workflow Loader` — reads `WORKFLOW.md`, parses YAML front matter and prompt body, returns
   `{config, prompt_template}`. `[= Symphony]`
2. `Config Layer` — typed getters, defaults, `$VAR` env indirection, validation. `[= Symphony]`
3. `Issue Tracker Client` — GitHub Projects v2 GraphQL adapter. Fetches candidate items in active
   states, refreshes states for running issues, fetches terminal-state issues for startup cleanup,
   and normalizes payloads into the stable issue model (Section 4).
4. `Orchestrator` — owns the poll tick, in-memory runtime state, dispatch/retry/stop/release
   decisions, session metrics. `[= Symphony]`
5. `Workspace Manager` — maps issue identifiers to workspace paths, lifecycle hooks, terminal
   cleanup. `[= Symphony]`
6. `Agent Runner` — creates workspace, builds prompt, launches a coding agent session via one of
   the agent adapters (`claude_code` or `copilot`), streams agent updates to the orchestrator.
7. `Status Surface` (OPTIONAL) and `Logging`. `[= Symphony]`

### 3.2 Abstraction Levels `[= Symphony §3.2]`

Policy (repo `WORKFLOW.md`) → Configuration (typed getters) → Coordination (orchestrator) →
Execution (workspace + agent subprocess/SDK session) → Integration (GitHub Projects adapter) →
Observability (logs + OPTIONAL status surface).

### 3.3 External Dependencies

- GitHub GraphQL API v4 (`https://api.github.com/graphql`) for Projects v2 reads.
- Local filesystem for workspaces and logs.
- OPTIONAL workspace population tooling (Git CLI / `gh` CLI, typically used by hooks).
- A coding agent executable:
  - `claude` (Claude Code CLI) supporting headless/print mode and the Claude Agent SDK protocol,
    or
  - `copilot` (GitHub Copilot CLI) supporting programmatic (`-p`) mode.
- Host environment authentication:
  - `GITHUB_TOKEN` (or `gh auth` login) with read access to the Project and read/write access to
    the target repositories for the agent's tracker writes.
  - Agent authentication (Claude subscription/API key, or Copilot subscription) as required by the
    selected agent CLI.

## 4. Core Domain Model

### 4.1 Entities

#### 4.1.1 Issue

Normalized issue record used by orchestration, prompt rendering, and observability output.

Fields:

- `id` (string)
  - Stable GraphQL node ID of the **Issue** (`I_...`). Used for tracker lookups and internal map
    keys.
- `item_id` (string)
  - GraphQL node ID of the **ProjectV2Item** (`PVTI_...`) linking the issue to the configured
    project. Retained so agents/operators can address project field updates; the orchestrator
    itself does not write fields.
- `identifier` (string)
  - Human-readable key composed as `<repository_name>-<issue_number>` (example: `myrepo-123`).
- `number` (integer) — issue number.
- `repository` (string) — `owner/name`.
- `title` (string)
- `description` (string or null) — issue body.
- `priority` (integer or null)
  - Derived from the OPTIONAL Project `priority_field` (single-select). The option's position
    (1-based, top option = 1) is the priority. Lower numbers are higher priority. Null when the
    field is absent or unset.
- `state` (string)
  - Current value of the Project Status field (single-select option name).
- `branch_name` (string or null)
  - Derived from linked branches when available; otherwise null. Implementations MAY leave this
    null and let the workflow prompt define branch naming.
- `url` (string or null)
- `labels` (list of strings) — normalized to lowercase.
- `blocked_by` (list of blocker refs)
  - Derived from GitHub issue dependencies ("blocked by" relationships). Each blocker ref
    contains `id`, `identifier`, and `state` (the blocker's Project Status when it is on the same
    project, otherwise its issue state `OPEN`/`CLOSED` mapped as non-terminal/terminal).
  - If the dependencies API is unavailable to the token, `blocked_by` MUST default to `[]`.
- `created_at` / `updated_at` (timestamps or null)

#### 4.1.2 Workflow Definition `[= Symphony §4.1.2]`

`{config, prompt_template}` parsed from `WORKFLOW.md`.

#### 4.1.3 Service Config (Typed View) `[= Symphony §4.1.3]`

Typed runtime values derived from front matter plus environment resolution.

#### 4.1.4 Workspace `[= Symphony §4.1.4]`

`{path, workspace_key, created_now}`.

#### 4.1.5 Run Attempt `[= Symphony §4.1.5]`

`{issue_id, issue_identifier, attempt, workspace_path, started_at, status, error?}`.

#### 4.1.6 Live Session (Agent Session Metadata)

State tracked while a coding-agent session is running.

Fields:

- `session_id` (string, `<agent_session_id>-<turn_number>`)
- `agent_session_id` (string)
  - Claude Code: the `session_id` reported by the CLI/SDK `init` message.
  - Copilot: the session identifier reported by the CLI (or a generated UUID when none is
    exposed).
- `turn_number` (integer, 1-based within the current worker lifetime)
- `agent_pid` (string or null)
- `last_agent_event` (string/enum or null)
- `last_agent_timestamp` (timestamp or null)
- `last_agent_message` (summarized payload)
- `input_tokens` / `output_tokens` / `total_tokens` (integers)
- `last_reported_*_tokens` (integers, for delta tracking)
- `turn_count` (integer)

#### 4.1.7 Retry Entry `[= Symphony §4.1.7]`

`{issue_id, identifier, attempt, due_at_ms, timer_handle, error}`.

#### 4.1.8 Orchestrator Runtime State `[= Symphony §4.1.8]`

`{poll_interval_ms, max_concurrent_agents, running, claimed, retry_attempts, completed,
agent_totals, agent_rate_limits}` — single authoritative in-memory state. `agent_totals`
replaces Symphony's `codex_totals` with the same shape (tokens + runtime seconds).

### 4.2 Stable Identifiers and Normalization Rules

- `Issue ID` — GraphQL Issue node ID; use for tracker lookups and internal map keys.
- `Issue Identifier` — `<repo>-<number>`; use for logs and workspace naming.
- `Workspace Key` — derive from `issue.identifier` by replacing any character not in
  `[A-Za-z0-9._-]` with `_`. `[= Symphony]`
- `Normalized Issue State` — compare Status option names after `lowercase` + trim.
- `Session ID` — `<agent_session_id>-<turn_number>`.

## 5. Workflow Specification (Repository Contract)

### 5.1 File Discovery and Path Resolution `[= Symphony §5.1]`

1. Explicit runtime setting (CLI positional argument). 2. Default `WORKFLOW.md` in cwd.
Unreadable file → `missing_workflow_file` error.

### 5.2 File Format `[= Symphony §5.2]`

Markdown with OPTIONAL YAML front matter delimited by `---`. Front matter MUST decode to a map.
Body (trimmed) is the prompt template. No front matter → whole file is prompt body, empty config.

### 5.3 Front Matter Schema

Top-level keys: `tracker`, `polling`, `workspace`, `hooks`, `agent`, `claude_code`, `copilot`.
Unknown keys SHOULD be ignored for forward compatibility. Extensions MAY define additional
top-level keys (for example `server`, Section 13.7).

#### 5.3.1 `tracker` (object)

- `kind` (string)
  - REQUIRED for dispatch. Current supported value: `github_projects`.
- `endpoint` (string)
  - Default: `https://api.github.com/graphql`. Override for GitHub Enterprise Server.
- `token` (string)
  - MAY be a literal token or `$VAR_NAME`. Canonical environment variable: `GITHUB_TOKEN`.
  - If `$VAR_NAME` resolves to an empty string, treat the token as missing.
  - REQUIRED scopes: read access to the Project (`read:project` classic scope or fine-grained
    `Projects: read`), plus whatever repository access the agent's own `gh` usage requires
    (typically `Contents`, `Issues`, `Pull requests`: read/write).
- `owner` (string)
  - REQUIRED. Organization login or user login that owns the project.
- `owner_type` (string)
  - `organization` (default) or `user`.
- `project_number` (integer)
  - REQUIRED. The project's number as shown in its URL.
- `status_field` (string)
  - Default: `Status`. Name of the single-select field whose options are the issue states.
- `priority_field` (string, OPTIONAL)
  - Name of a single-select field used to derive `issue.priority`. Absent → priority is null.
- `repos` (list of `owner/name` strings, OPTIONAL)
  - When present, only project items whose content is an Issue in one of these repositories are
    eligible. Default: no repository filter.
- `required_labels` (list of strings)
  - Default `[]`. An issue MUST contain every configured label to dispatch or continue. Matching
    ignores case and surrounding whitespace. A blank configured label matches no issue.
    `[= Symphony]`
- `active_states` (list of strings)
  - Default: `Todo`, `In Progress`.
- `terminal_states` (list of strings)
  - Default: `Done`.
  - Additionally, an issue whose underlying GitHub Issue is `CLOSED` MUST be treated as terminal
    regardless of its Status field value.

#### 5.3.2 `polling` (object) `[= Symphony §5.3.2]`

- `interval_ms` (integer), default `30000`. Changes SHOULD re-apply at runtime.

#### 5.3.3 `workspace` (object) `[= Symphony §5.3.3]`

- `root` (path or `$VAR`), default `<system-temp>/baton_workspaces`. `~` expanded; relative paths
  resolve against the `WORKFLOW.md` directory; normalized to absolute.

#### 5.3.4 `hooks` (object) `[= Symphony §5.3.4]`

- `after_create`, `before_run`, `after_run`, `before_remove` (multiline shell scripts, OPTIONAL)
  with identical failure semantics (after_create/before_run failures are fatal to the
  creation/attempt; after_run/before_remove failures are logged and ignored).
- `timeout_ms` (integer), default `60000`.
- Hooks run with the workspace directory as cwd and receive these environment variables:
  `BATON_ISSUE_ID`, `BATON_ISSUE_IDENTIFIER`, `BATON_ISSUE_NUMBER`, `BATON_ISSUE_REPO`,
  `BATON_ISSUE_URL`, `BATON_ISSUE_STATUS`, `BATON_WORKSPACE`. When hooks run under Git Bash on
  Windows, `BATON_WORKSPACE` uses Git Bash path syntax (`/c/...`) and `BATON_WORKSPACE_NATIVE`
  exposes the native Windows path (`C:\...`).

#### 5.3.5 `agent` (object)

Orchestration-level agent settings (agnostic of the selected runner):

- `kind` (string)
  - REQUIRED for dispatch. Supported values: `claude_code`, `copilot`.
- `max_concurrent_agents` (integer), default `10`. `[= Symphony]`
- `max_turns` (positive integer), default `20`. Limits coding-agent turns within one worker
  session. `[= Symphony]`
- `max_retry_backoff_ms` (integer), default `300000`. `[= Symphony]`
- `max_concurrent_agents_by_state` (map `state_name -> positive integer`), default `{}`.
  `[= Symphony]`

#### 5.3.6 `claude_code` (object)

Runner-specific config when `agent.kind == "claude_code"`. Values not listed here are
pass-through to the targeted Claude Code version; implementations SHOULD NOT hand-maintain enums
for pass-through values.

- `command` (string shell command)
  - Default: `claude`. Used when driving the CLI as a subprocess. Implementations using the
    Claude Agent SDK in-process MAY ignore `command` but MUST still validate that the runtime can
    start a session.
- `model` (string, OPTIONAL) — passed through to the session.
- `permission_mode` (string)
  - Default: `acceptEdits`. Pass-through Claude Code permission mode (for example `default`,
    `acceptEdits`, `bypassPermissions`, `plan`).
- `allowed_tools` (list of strings, OPTIONAL)
  - Pass-through tool allowlist (for example `Bash(gh:*)`, `Bash(git:*)`, `Edit`, `Write`).
- `disallowed_tools` (list of strings, OPTIONAL)
- `append_system_prompt` (string, OPTIONAL) — pass-through.
- `extra_args` (list of strings, OPTIONAL) — appended verbatim to CLI invocations.
- `turn_timeout_ms` (integer), default `3600000` (1 hour).
- `stall_timeout_ms` (integer), default `300000` (5 minutes). `<= 0` disables stall detection.

#### 5.3.7 `copilot` (object)

Runner-specific config when `agent.kind == "copilot"`.

- `command` (string shell command), default `copilot`.
- `model` (string, OPTIONAL).
- `allow_all_tools` (boolean), default `false`.
- `allow_tools` / `deny_tools` (lists of strings, OPTIONAL) — pass-through tool permissions.
- `extra_args` (list of strings, OPTIONAL).
- `turn_timeout_ms` (integer), default `3600000`.
- `stall_timeout_ms` (integer), default `300000`.

### 5.4 Prompt Template Contract `[= Symphony §5.4]`

- Strict template engine (Liquid-compatible semantics sufficient). Unknown variables and unknown
  filters MUST fail rendering.
- Template input variables: `issue` (all normalized fields from §4.1.1, including `number`,
  `repository`, `labels`, `blocked_by`) and `attempt` (integer or null).
- Empty prompt body → runtime MAY use a minimal default prompt
  (`You are working on a GitHub issue.`). Read/parse failures MUST NOT silently fall back.

### 5.5 Workflow Validation and Error Surface `[= Symphony §5.5]`

Error classes: `missing_workflow_file`, `workflow_parse_error`,
`workflow_front_matter_not_a_map`, `template_parse_error`, `template_render_error`.
Workflow file errors block new dispatches until fixed; template errors fail only the affected run
attempt.

## 6. Configuration Specification

### 6.1 Configuration Resolution Pipeline `[= Symphony §6.1]`

Path selection → YAML parse → defaults → `$VAR` resolution (only for values that explicitly
reference `$VAR_NAME`) → coercion and validation. `~`/`$VAR` expansion applies only to local
filesystem path values, never to URIs or shell command strings.

### 6.2 Dynamic Reload Semantics `[= Symphony §6.2]`

Dynamic reload is REQUIRED: detect `WORKFLOW.md` changes, re-read and re-apply config and prompt
without restart. Invalid reloads MUST NOT crash the service; keep the last known good
configuration and emit an operator-visible error. In-flight agent sessions need not be restarted.

### 6.3 Dispatch Preflight Validation

Startup validation failure → fail startup. Per-tick validation failure → skip dispatch that tick,
keep reconciliation active. `[= Symphony §6.3]`

Validation checks:

- Workflow file can be loaded and parsed.
- `tracker.kind` is present and supported (`github_projects`).
- `tracker.token` is present after `$` resolution.
- `tracker.owner` and `tracker.project_number` are present.
- The configured project resolves to a ProjectV2 node and the `status_field` exists with at least
  one option (resolved lazily and cached; failures surface as validation errors).
- `agent.kind` is present and supported.
- For `claude_code`/`copilot` subprocess mode: the runner `command` is present and non-empty.

### 6.4 Core Config Fields Summary (Cheat Sheet)

- `tracker.kind`: string, REQUIRED, currently `github_projects`
- `tracker.endpoint`: string, default `https://api.github.com/graphql`
- `tracker.token`: string or `$VAR`, canonical env `GITHUB_TOKEN`
- `tracker.owner`: string, REQUIRED
- `tracker.owner_type`: `organization` (default) | `user`
- `tracker.project_number`: integer, REQUIRED
- `tracker.status_field`: string, default `Status`
- `tracker.priority_field`: string, OPTIONAL
- `tracker.repos`: list of `owner/name`, OPTIONAL
- `tracker.required_labels`: list of strings, default `[]`
- `tracker.active_states`: list, default `["Todo", "In Progress"]`
- `tracker.terminal_states`: list, default `["Done"]` (+ closed issues are always terminal)
- `polling.interval_ms`: integer, default `30000`
- `workspace.root`: path, default `<system-temp>/baton_workspaces`
- `hooks.*`: shell scripts or null; `hooks.timeout_ms` default `60000`
- `agent.kind`: `claude_code` | `copilot`, REQUIRED
- `agent.max_concurrent_agents`: integer, default `10`
- `agent.max_turns`: integer, default `20`
- `agent.max_retry_backoff_ms`: integer, default `300000`
- `agent.max_concurrent_agents_by_state`: map, default `{}`
- `claude_code.command`: string, default `claude`
- `claude_code.permission_mode`: string, default `acceptEdits`
- `claude_code.allowed_tools` / `disallowed_tools`: lists, OPTIONAL
- `claude_code.turn_timeout_ms`: default `3600000`; `claude_code.stall_timeout_ms`: default
  `300000`
- `copilot.command`: string, default `copilot`; `copilot.allow_all_tools`: default `false`;
  timeouts as above

## 7. Orchestration State Machine `[= Symphony §7]`

Baton inherits Symphony's orchestration state machine unchanged.

### 7.1 Issue Orchestration States

`Unclaimed` → `Claimed` (= `Running` or `RetryQueued`) → `Released`. Claimed issues are tracked in
`claimed`; running issues in `running`; queued retries in `retry_attempts`.

Worker turn-loop nuance (inherited, restated for the new runners):

- After each normal turn completion, the worker re-checks the tracker issue state.
- If the issue is still in an active state (and still carries `required_labels`), the worker
  SHOULD start another turn **on the same agent session** (Claude Code: resume the same
  `agent_session_id`; Copilot: resume the same session), up to `agent.max_turns`.
- The first turn uses the full rendered task prompt. Continuation turns send only continuation
  guidance, not the original prompt.
- After a normal worker exit, the orchestrator schedules a short continuation retry (~1 second)
  to re-check whether the issue remains active.

### 7.2 Run Attempt Lifecycle

`PreparingWorkspace` → `BuildingPrompt` → `LaunchingAgentProcess` → `InitializingSession` →
`StreamingTurn` → `Finishing` → terminal (`Succeeded` | `Failed` | `TimedOut` | `Stalled` |
`CanceledByReconciliation`).

### 7.3 Transition Triggers

Poll tick, normal/abnormal worker exit, agent update event, retry timer fired, reconciliation
state refresh, stall timeout — identical semantics to Symphony §7.3.

### 7.4 Idempotency and Recovery Rules

Single-authority state mutation; `claimed`/`running` checks REQUIRED before launch;
reconciliation before dispatch every tick; restart recovery is tracker- and filesystem-driven;
startup terminal cleanup. `[= Symphony §7.4]`

## 8. Polling, Scheduling, and Reconciliation `[= Symphony §8]`

### 8.1 Poll Loop

Startup: validate config → startup cleanup → immediate tick → repeat every
`polling.interval_ms`. Tick sequence: reconcile running issues → preflight validation → fetch
candidates → sort → dispatch while slots remain → notify observers.

### 8.2 Candidate Selection Rules

An issue is dispatch-eligible only if all are true:

- It has `id`, `identifier`, `title`, and `state`.
- Its state is in `active_states` and not in `terminal_states`, and the underlying issue is not
  `CLOSED`.
- Its repository passes the `tracker.repos` filter (when configured).
- It contains every label in `tracker.required_labels`.
- It is not already in `running` or `claimed`.
- Global and per-state concurrency slots are available.
- Blocker rule for the first active state (`Todo` by default): do not dispatch when any
  `blocked_by` entry is non-terminal.
- Project items whose content is a DraftIssue or Pull Request are never eligible.

Sorting: `priority` ascending (null last) → `created_at` oldest first → `identifier`
lexicographic.

### 8.3 Concurrency Control `[= Symphony §8.3]`

`available_slots = max(max_concurrent_agents - running_count, 0)`; per-state override map with
normalized keys; fallback to global limit.

### 8.4 Retry and Backoff `[= Symphony §8.4]`

- Continuation retries after clean exit: fixed `1000` ms.
- Failure retries: `delay = min(10000 * 2^(attempt - 1), agent.max_retry_backoff_ms)`.
- Retry handling fetches active candidates, releases claims for issues that disappeared or went
  inactive, requeues on slot exhaustion with error `no available orchestrator slots`.

### 8.5 Active Run Reconciliation `[= Symphony §8.5]`

Part A — stall detection against the runner's `stall_timeout_ms` (elapsed since last agent event
or `started_at`). Part B — tracker state refresh for all running issue IDs: terminal (or closed
issue, or `required_labels` no longer satisfied → treat as non-active) ⇒ stop; terminal ⇒ also
clean workspace; still active ⇒ update snapshot; refresh failure ⇒ keep workers, retry next tick.

### 8.6 Startup Terminal Workspace Cleanup `[= Symphony §8.6]`

Query terminal-state issues, remove corresponding workspaces, log-and-continue on fetch failure.

## 9. Workspace Management and Safety `[= Symphony §9]`

- Per-issue path: `<workspace.root>/<sanitized_issue_identifier>`; workspaces are reused across
  runs and not auto-deleted on success.
- Creation algorithm, hook execution contract (`sh -lc`/`bash -lc`, cwd = workspace,
  `hooks.timeout_ms`), and failure semantics are inherited unchanged.
- OPTIONAL workspace population is implementation-defined and typically done in hooks (for
  example `gh repo clone` in `after_create`, `git fetch && git switch` in `before_run`).

### 9.5 Safety Invariants (MUST)

1. The coding agent runs only in the per-issue workspace path (`cwd == workspace_path`, validated
   before launch).
2. Workspace path MUST stay inside workspace root (absolute-path prefix check).
3. Workspace directory names use only `[A-Za-z0-9._-]`.

## 10. Agent Runner Protocol (Coding Agent Integration)

This section defines Baton's language-neutral responsibilities when integrating Claude Code or
GitHub Copilot CLI. The targeted agent CLI/SDK version is the source of truth for flags, message
schemas, and transport; if this specification appears to conflict with the targeted agent's
documentation, the agent's documentation controls protocol shape, while this section still
controls orchestration behavior, workspace selection, prompt construction, continuation handling,
and observability extraction.

### 10.0 Common Agent Runner Contract

An agent adapter MUST implement:

1. `start_session(workspace, config) -> session` — initialize an agent session whose working
   directory is the absolute per-issue workspace path.
2. `run_turn(session, prompt, on_event) -> turn_result` — run one turn, streaming normalized
   events to the orchestrator until the turn terminates.
3. `stop_session(session)` — terminate the session and the underlying process.

Completion conditions for a turn:

- agent-reported turn completion → success
- agent-reported error / nonzero exit → failure
- turn timeout (`turn_timeout_ms`) → failure
- subprocess exit before completion → failure

Normalized upstream events (each SHOULD include `event`, `timestamp`, `agent_pid` when available,
OPTIONAL `usage` map, payload fields as needed):

`session_started`, `startup_failed`, `turn_completed`, `turn_failed`, `turn_cancelled`,
`turn_input_required`, `permission_denied`, `tool_use`, `notification`, `other_message`,
`malformed`.

### 10.1 Claude Code Adapter

Two conforming transport modes:

- **SDK mode (RECOMMENDED):** drive sessions in-process with the Claude Agent SDK
  (`@anthropic-ai/claude-agent-sdk` or the Python equivalent), passing the workspace as the
  session working directory, `permission_mode`, `allowed_tools`/`disallowed_tools`, `model`, and
  a per-turn `max_turns` of the SDK's choosing while Baton enforces `agent.max_turns` at the
  worker-loop level.
- **CLI subprocess mode:** launch `bash -lc "<claude_code.command> -p <prompt> --output-format
  stream-json --verbose ..."` with cwd = workspace, parsing newline-delimited JSON from stdout
  and keeping stderr separate. RECOMMENDED max line buffer: 10 MB.

Session startup responsibilities:

- Validate `cwd == workspace_path` before launch (Invariant 1).
- Start the first turn with the rendered issue prompt.
- Extract `agent_session_id` from the targeted protocol's init/system message and emit
  `session_started` with `session_id = "<agent_session_id>-1"`.
- Start later in-worker continuation turns by **resuming the same session**
  (`--resume <agent_session_id>` / SDK resume option) with continuation guidance only; emit
  `session_started` is not repeated — increment `turn_number` instead.
- Supply the documented permission posture (`permission_mode`, tool allow/deny lists) on every
  turn.

Streaming and observability extraction:

- Forward assistant text and tool-use messages as `notification`/`tool_use` events with
  summarized payloads.
- Extract token usage from the targeted protocol's result/usage payloads. Where the payload
  reports per-turn usage, accumulate; where it reports session-cumulative totals, track deltas
  against `last_reported_*_tokens` to avoid double-counting (Symphony §13.5 rules apply).
- Extract rate-limit information when the targeted protocol exposes it; otherwise
  `agent_rate_limits` stays null.

Approval / user-input policy (documented posture, Section 15):

- Headless runs MUST NOT stall on permission prompts. With the default
  `permission_mode: acceptEdits` plus `allowed_tools`, unpermitted tool calls fail inside the
  session; the adapter emits `permission_denied` and the session continues or ends per the
  agent's own behavior.
- If the targeted protocol signals that user input is required, the adapter MUST fail the turn
  (`turn_input_required`) rather than wait indefinitely.

### 10.2 Copilot CLI Adapter

- Launch: `bash -lc "<copilot.command> -p <prompt> ..."` with cwd = workspace, plus
  `--allow-all-tools` or `--allow-tool`/`--deny-tool` flags per config.
- Continuation turns resume the prior session where the targeted CLI version supports it
  (`--resume`); where resume is unavailable, the adapter MUST treat each turn as a new session in
  the same workspace and document this limitation.
- Output parsing is implementation-defined against the targeted CLI version; the adapter MUST
  still emit the normalized event set from §10.0 (at minimum `session_started`,
  `turn_completed`/`turn_failed`, and `notification` heartbeats sufficient for stall detection).
- Token usage extraction is OPTIONAL when the targeted CLI does not expose usage; totals then
  remain zero and MUST be reported as such, not fabricated.

### 10.3 Timeouts and Error Mapping

Timeouts: `turn_timeout_ms` (total turn stream), `stall_timeout_ms` (orchestrator-enforced event
inactivity).

RECOMMENDED normalized error categories: `agent_not_found`, `invalid_workspace_cwd`,
`startup_failed`, `turn_timeout`, `process_exit`, `turn_failed`, `turn_cancelled`,
`turn_input_required`, `parse_error`.

### 10.4 Tracker Writes from the Agent (replaces Symphony's `linear_graphql` tool)

Baton does not implement a client-side tracker tool. Instead:

- The workflow prompt SHOULD instruct the agent to use the `gh` CLI for tracker writes
  (progress comments via `gh issue comment`, Status transitions via `gh project item-edit`,
  PR creation via `gh pr create`).
- The Claude Code adapter SHOULD include `Bash(gh:*)` in `allowed_tools` for this purpose.
- The orchestrator remains a tracker reader; it MUST NOT require write scopes for its own
  operation.
- Implementations MAY additionally expose a GitHub MCP server to the agent session; that is an
  agent-toolchain concern, not orchestrator business logic.

## 11. Issue Tracker Integration Contract (GitHub Projects v2)

### 11.1 REQUIRED Operations

1. `fetch_candidate_issues()` — return normalized issues on the configured project whose Status
   is in `active_states`.
2. `fetch_issues_by_states(state_names)` — used for startup terminal cleanup. Empty input returns
   empty without an API call.
3. `fetch_issue_states_by_ids(issue_ids)` — used for active-run reconciliation; returns minimal
   normalized issues (id, identifier, state, labels, closed flag).

### 11.2 Query Semantics (GitHub GraphQL)

- Endpoint: `tracker.endpoint`; auth via `Authorization: Bearer <token>` header.
- Project resolution: `organization(login:) { projectV2(number:) }` or
  `user(login:) { projectV2(number:) }` per `owner_type`. The ProjectV2 node ID, the Status
  field ID, and its option list SHOULD be resolved once and cached; the cache MUST be refreshed
  when validation fails or on workflow reload.
- Candidate query: `projectV2.items(first: 50, after: $cursor)` selecting
  `fieldValueByName(name: $status_field) { ... on ProjectV2ItemFieldSingleSelectValue { name } }`
  and `content { ... on Issue { id number title body url state createdAt updatedAt
  labels(first: 20) { nodes { name } } repository { name nameWithOwner } } }`.
  - Status filtering happens client-side after normalization (the items connection has no
    server-side status filter); `required_labels` filtering also happens after normalization so
    refresh can observe label removal. `[= Symphony §11.2 label rule]`
- Blockers: select the issue-dependencies connection (blocked-by relationships) when the schema
  exposes it to the token; degrade to `[]` otherwise.
- State refresh query: `nodes(ids: $issueIds) { ... on Issue { ... } }` with variable type
  `[ID!]!`, reading each issue's project item for the configured project to obtain its Status
  (`projectItems(first: 10)` filtered client-side by project ID).
- Pagination REQUIRED for candidate issues; page size default `50`; a page reporting
  `hasNextPage` without an `endCursor` is a pagination integrity error.
- Network timeout: `30000 ms`.
- Rate limits: GraphQL is point-based (5,000 points/hour/token). At the default 30 s interval the
  candidate + refresh queries cost a few points per tick; implementations SHOULD surface the
  `rateLimit { remaining resetAt }` field in debug logs and MUST treat secondary-rate-limit
  responses as transient `github_api_status` errors (skip the tick, retry next tick).

### 11.3 Normalization Rules

Per §4.1.1, plus:

- Status option names and labels are trimmed; labels lowercased; states compared lowercase.
- `priority` derives from `priority_field` option position; non-resolvable → null.
- `created_at`/`updated_at` parse ISO-8601.
- Items with non-Issue content are dropped during normalization.

### 11.4 Error Handling Contract

RECOMMENDED error categories: `unsupported_tracker_kind`, `missing_tracker_token`,
`missing_tracker_project`, `github_api_request` (transport), `github_api_status` (non-200 /
secondary rate limit), `github_graphql_errors`, `github_unknown_payload`,
`github_missing_end_cursor`.

Orchestrator behavior on tracker errors `[= Symphony §11.4]`: candidate fetch failure → skip
dispatch this tick; refresh failure → keep workers; startup cleanup failure → warn and continue.

### 11.5 Tracker Writes (Important Boundary) `[= Symphony §11.5]`

The orchestrator is a reader. All mutations (comments, Status transitions, PR metadata) are
performed by the coding agent via its toolchain (Section 10.4). Workflow-defined success
typically means "reached the handoff state" (for example `In Review`), not `Done`.

## 12. Prompt Construction and Context Assembly `[= Symphony §12]`

Inputs: `workflow.prompt_template`, normalized `issue`, OPTIONAL `attempt`. Strict
variable/filter checking; nested arrays/maps preserved for iteration; `attempt` lets the template
give different instructions for first run, continuation, and retry. Rendering failure fails the
attempt immediately.

## 13. Logging, Status, and Observability `[= Symphony §13]`

- REQUIRED context fields: `issue_id`, `issue_identifier` on issue logs; `session_id` on session
  lifecycle logs. Stable `key=value` phrasing; no large raw payloads; no secrets.
- Log sinks are implementation-defined; sink failure MUST NOT crash orchestration.
- Token accounting follows Symphony §13.5 with `agent_totals` in place of `codex_totals`:
  prefer absolute totals where the agent protocol defines them, track deltas to avoid
  double-counting, accumulate runtime seconds on session end plus live elapsed time at snapshot
  time.
- OPTIONAL runtime snapshot SHOULD return `running` rows (with `turn_count` and issue URLs),
  `retrying` rows, `agent_totals`, and `rate_limits`.

### 13.7 OPTIONAL HTTP Server Extension `[= Symphony §13.7]`

Same contract: `server.port` front-matter key / CLI `--port` (CLI wins), loopback bind by
default, dashboard at `/`, JSON API at `/api/v1/state`, `/api/v1/<issue_identifier>`,
`POST /api/v1/refresh` (202, coalescable), `405` for unsupported methods, JSON error envelope.
The dashboard/API MUST remain observability/control-only.

OPTIONAL webhook trigger extension: implementations MAY accept GitHub `projects_v2_item` webhook
deliveries and treat them exactly as a `POST /api/v1/refresh` (queue an immediate poll +
reconcile). Polling remains the source of truth; webhook loss MUST NOT affect correctness.

## 14. Failure Model and Recovery Strategy `[= Symphony §14]`

Failure classes (workflow/config, workspace, agent session, tracker, observability) and recovery
behavior are inherited unchanged: validation failures skip dispatch but keep the service alive;
worker failures become backoff retries; tracker fetch failures skip the tick; restart recovery is
in-memory-free (startup cleanup → fresh poll → re-dispatch). Operator intervention points:
edit `WORKFLOW.md` (hot-reloaded), move issues on the board (terminal → stop + clean; non-active
→ stop), restart the process.

## 15. Security and Operational Safety

### 15.1 Trust Boundary Assumption

Baton's reference posture is **high-trust**: it is intended for boards and repositories fully
controlled by the operating team. The documented default approval posture is:

- Claude Code: `permission_mode: acceptEdits` with an explicit `allowed_tools` allowlist
  (RECOMMENDED baseline: `Bash(gh:*)`, `Bash(git:*)`, plus the project's build/test commands,
  `Edit`, `Write`). `bypassPermissions` is supported but MUST be an explicit operator choice.
- Copilot: explicit `allow_tools` list; `allow_all_tools: true` MUST be an explicit operator
  choice.
- User-input-required turns fail the run (Section 10.1).

### 15.2 Filesystem Safety Requirements `[= Symphony §15.2]`

Workspace root containment, agent cwd = workspace, sanitized directory names. RECOMMENDED
hardening: dedicated OS user, restricted workspace root permissions, dedicated volume.

### 15.3 Secret Handling `[= Symphony §15.3]`

`$VAR` indirection; never log tokens; validate presence without printing values.

### 15.4 Hook Script Safety `[= Symphony §15.4]`

Hooks are fully trusted configuration; run inside the workspace; truncate output in logs;
timeouts REQUIRED.

### 15.5 Harness Hardening Guidance

Issue titles, bodies, and comments are **externally controlled content** on public repositories —
treat them as untrusted prompt input. Hardening measures Baton deployments SHOULD evaluate:

- Restrict dispatch eligibility with `required_labels` so only triaged, team-applied issues reach
  the agent (a label only maintainers can apply is the primary injection gate).
- Restrict `tracker.repos` to known repositories; prefer private repos/boards.
- Keep the tool allowlist minimal; do not grant network-capable tools beyond `gh`/`git` unless
  the workflow needs them.
- Scope `GITHUB_TOKEN` narrowly (fine-grained PAT or GitHub App limited to the target repos);
  use a separate token for the agent if its write scope must differ from the orchestrator's
  read scope.
- Consider OS/container sandboxing for the workspace root and branch protection + required
  review on target repositories so agent PRs cannot merge unreviewed.

## 16. Reference Algorithms (Language-Agnostic)

Service startup, poll-and-dispatch tick, reconciliation, dispatch bookkeeping, worker exit, and
retry-timer handling are identical to Symphony SPEC §16.1–§16.4 and §16.6 (with `codex_totals`
read as `agent_totals`). The worker attempt algorithm, restated for the new agent runners:

```text
function run_agent_attempt(issue, attempt, orchestrator_channel):
  workspace = workspace_manager.create_for_issue(issue.identifier)   # §9
  if workspace failed: fail_worker("workspace error")

  if run_hook("before_run", workspace.path) failed:
    fail_worker("before_run hook error")

  adapter = agent_adapter_for(config.agent.kind)                     # §10
  session = adapter.start_session(workspace.path, runner_config)
  if session failed:
    run_hook_best_effort("after_run", workspace.path)
    fail_worker("agent session startup error")

  turn_number = 1
  while true:
    prompt = if turn_number == 1
               then render(workflow_template, issue, attempt)        # §12
               else continuation_guidance(issue, turn_number)
    if prompt failed:
      adapter.stop_session(session); run_hook_best_effort("after_run", workspace.path)
      fail_worker("prompt error")

    turn_result = adapter.run_turn(session, prompt,
      on_event = (msg) -> send(orchestrator_channel, {agent_update, issue.id, msg}))
    if turn_result failed:
      adapter.stop_session(session); run_hook_best_effort("after_run", workspace.path)
      fail_worker("agent turn error")

    refreshed = tracker.fetch_issue_states_by_ids([issue.id])        # §11.1
    if refreshed failed:
      adapter.stop_session(session); run_hook_best_effort("after_run", workspace.path)
      fail_worker("issue state refresh error")

    issue = refreshed[0] or issue
    if issue.state is not active or issue is closed
       or required_labels not satisfied: break
    if turn_number >= config.agent.max_turns: break
    turn_number += 1

  adapter.stop_session(session)
  run_hook_best_effort("after_run", workspace.path)
  exit_normal()                                                      # → 1s continuation retry
```

## 17. Test and Validation Matrix

Validation profiles `[= Symphony §17]`: `Core Conformance` (REQUIRED, deterministic),
`Extension Conformance` (only for shipped OPTIONAL features), `Real Integration Profile`
(RECOMMENDED, environment-dependent).

### 17.1 Workflow and Config Parsing `[= Symphony §17.1]`

Path precedence, hot reload with last-known-good fallback, typed errors for missing/invalid
front matter, defaults, `$VAR` and `~` resolution, strict prompt rendering — plus:
`tracker.kind` enforces `github_projects`; `agent.kind` enforces `claude_code`/`copilot`;
runner config blocks parse and validate per §5.3.6–§5.3.7.

### 17.2 Workspace Manager and Safety `[= Symphony §17.2]`

Deterministic paths, create/reuse, hook semantics and timeouts, sanitization and root
containment enforced before agent launch, hook env vars (§5.3.4) present.

### 17.3 Issue Tracker Client

- Project resolution honors `owner_type` and caches project/field IDs.
- Candidate fetch filters by Status option, `repos`, and `required_labels` after normalization.
- Non-Issue items (drafts, PRs) are dropped.
- Pagination preserves order; missing `endCursor` with `hasNextPage` is a typed error.
- Closed issues are treated as terminal regardless of Status.
- Blockers normalize from issue dependencies; missing API access degrades to `[]`.
- State refresh uses `nodes(ids: [ID!]!)` and resolves the Status via the configured project's
  item.
- Error mapping for transport, non-200, GraphQL errors, malformed payloads, secondary rate
  limits.
- `fetch_issues_by_states([])` returns empty without an API call.

### 17.4 Orchestrator Dispatch, Reconciliation, and Retry `[= Symphony §17.4]`

All Symphony items apply verbatim (sort order, blocker gating, reconciliation transitions,
continuation retry attempt 1, exponential backoff with cap, slot-exhaustion requeue, stall kill,
snapshot rows when implemented).

### 17.5 Agent Adapters

- Launch uses workspace cwd; out-of-root paths rejected.
- Claude Code: session id extracted from init; `session_started` emitted with
  `<agent_session_id>-1`; continuation turns resume the same session and increment
  `turn_number`; permission flags from config are passed on every turn; stream-json parse errors
  emit `malformed` without killing the orchestrator; turn timeout enforced; usage extracted per
  §13 delta rules; `turn_input_required` fails the turn.
- Copilot: programmatic mode launch flags honor `allow_all_tools`/allow/deny lists; resume used
  when supported, new-session fallback documented; normalized events sufficient for stall
  detection; absent usage reported as zero.
- stderr kept separate from protocol stream in subprocess mode.

### 17.6 Observability `[= Symphony §17.6]`

Operator-visible validation failures, structured log context fields, sink failure isolation,
token/rate-limit aggregation correctness, status surface driven only from orchestrator state.

### 17.7 CLI and Host Lifecycle `[= Symphony §17.7]`

Positional workflow path, `./WORKFLOW.md` default, clean startup failure surface, exit codes.

### 17.8 Real Integration Profile (RECOMMENDED)

- A real GitHub smoke test runs with `GITHUB_TOKEN` against a dedicated test project/repo, uses
  isolated identifiers/workspaces, and cleans up artifacts when practical.
- A real agent smoke test runs one trivial issue end-to-end with the configured agent CLI
  authenticated on the host.
- Skipped tests report as skipped; explicitly enabled profiles fail their job on failure.

## 18. Implementation Checklist (Definition of Done)

### 18.1 REQUIRED for Conformance

- Workflow path selection (explicit + cwd default); loader with front matter/body split
- Typed config layer with defaults and `$` resolution; dynamic watch/reload/re-apply
- Polling orchestrator with single-authority mutable state
- GitHub Projects v2 client with candidate fetch + state refresh + terminal fetch (+ project/
  field resolution and pagination)
- Workspace manager with sanitized per-issue workspaces and root containment
- Workspace lifecycle hooks with `hooks.timeout_ms` (default 60000) and hook env vars
- At least one agent adapter (`claude_code` RECOMMENDED first) implementing the §10.0 contract
  with session resume for continuation turns
- Strict prompt rendering with `issue` and `attempt`
- Exponential retry queue with continuation retries after normal exit; configurable backoff cap
- Reconciliation stopping runs on terminal/non-active/closed/label-removed issues
- Workspace cleanup for terminal issues (startup sweep + active transition)
- Structured logs with `issue_id`, `issue_identifier`, `session_id`
- Documented approval/sandbox posture (§15.1)

### 18.2 RECOMMENDED Extensions (Not REQUIRED for Conformance)

- Second agent adapter (`copilot`)
- HTTP server extension (§13.7) with `--port` precedence and baseline endpoints
- Webhook-triggered refresh (`projects_v2_item` → internal refresh)
- TODO: persist retry queue and session metadata across restarts
- TODO: first-class tracker write APIs in the orchestrator (currently agent-only by design)
- TODO: pluggable tracker adapters beyond GitHub Projects (e.g. restore a Linear adapter for
  drop-in Symphony parity)

### 18.3 Operational Validation Before Production (RECOMMENDED)

- Run the Real Integration Profile with valid credentials and network access.
- Verify hook execution and workflow path resolution on the target host OS/shell.
- Verify the agent CLI authenticates and runs headless on the target host (no interactive
  login prompts under the service user).
- If the HTTP server ships, verify port behavior and loopback bind.

## Appendix A. SSH Worker Extension (OPTIONAL) `[= Symphony Appendix A]`

The SSH worker extension profile (central orchestrator, remote worker hosts over SSH stdio,
`worker.ssh_hosts`, per-host caps, host-local workspaces, failover semantics) is inherited from
the Symphony SPEC unchanged, with "coding-agent app-server" read as "agent CLI session". Remote
hosts MUST additionally satisfy the agent-authentication prerequisite (Claude Code / Copilot
logged in for the SSH user).

## Appendix B. Differences from the Symphony SPEC (for Symphony users)

| Area | Symphony | Baton |
|---|---|---|
| Tracker | Linear GraphQL (`tracker.kind: linear`, `project_slug`, `LINEAR_API_KEY`) | GitHub Projects v2 GraphQL (`tracker.kind: github_projects`, `owner` + `project_number`, `GITHUB_TOKEN`) |
| Issue state | Linear workflow state | Project Status field option; closed issues always terminal |
| `identifier` | Linear ticket key (`ABC-123`) | `<repo>-<number>` (`myrepo-123`) |
| `blocked_by` | Inverse relations of type `blocks` | GitHub issue dependencies; degrades to `[]` |
| `priority` | Linear priority integer | OPTIONAL `priority_field` single-select position |
| Terminal-state defaults | `Closed, Cancelled, Canceled, Duplicate, Done` | `Done` (+ closed issues) |
| Agent | Codex app-server (JSON-RPC over stdio), `codex.*` config | Claude Code (Agent SDK or `-p` stream-json) / Copilot CLI (`-p`), `claude_code.*` / `copilot.*` config, `agent.kind` selector |
| Session identity | `thread_id`-`turn_id` | `agent_session_id`-`turn_number`; continuation via session resume |
| Approval posture | Codex approval/sandbox policies | `permission_mode` + tool allow/deny lists; user-input-required fails the turn |
| Client-side tracker tool | OPTIONAL `linear_graphql` tool | None; agent uses `gh` CLI (or GitHub MCP) via tool allowlist |
| Token accounting | Codex `tokenUsage` payloads | Agent result/usage payloads; same absolute-vs-delta rules |
| Workspace default root | `<tmp>/symphony_workspaces` | `<tmp>/baton_workspaces` |
| Hook env vars | (unspecified) | `BATON_ISSUE_*`, `BATON_WORKSPACE` specified; Windows also gets `BATON_WORKSPACE_NATIVE` |
| Webhooks | — | OPTIONAL `projects_v2_item` → refresh trigger |

Everything not listed above — orchestration state machine, polling/retry/reconciliation math,
workspace safety invariants, observability requirements, failure model, HTTP extension, and the
reference algorithms — is intentionally identical so that experience operating Symphony
transfers directly.

## Appendix C. Aggregated Dashboard OPTIONAL Extension

The aggregated dashboard (`baton-dashboard`) is a **separate, standalone process** that polls
the §13.7 HTTP APIs of one or more running `baton` instances and exposes a unified view —
multi-board HTML dashboard and a JSON API — for an operations team managing several boards at
once.

### Non-goal boundary (§2.2 clarification)

§2.2 lists "Rich web UI or multi-tenant control plane" as a non-goal. The aggregated dashboard
sits **outside** that boundary: it is a **read-only observability tool** for a single
operations team that already owns every board it watches. It does not manage tenants, does not
issue commands to the individual `baton` processes (the only mutation it proxies is the
`POST /api/v1/refresh` already defined in §13.7), and does not change how any single `baton`
instance evaluates its workflow. Every normative single-workflow rule in this specification
remains unchanged.

### Architecture

```
baton (board A, port 8787) ──┐
                              │  POST /api/v1/refresh proxy
baton (board B, port 8788) ──┤◀── baton-dashboard (port 8080)
                              │     polls GET /api/v1/state
baton (board C, port 8789) ──┘     serves GET /, /api/v1/boards, ...
```

`baton-dashboard` is a consumer of §13.7 APIs; it introduces no new orchestration behavior.

### baton-dashboard configuration schema

`baton-dashboard` reads a YAML file (default: `./baton-dashboard.yaml`) with the following
top-level keys:

- `server` (object) — dashboard server bind settings:
  - `host` (string), default `127.0.0.1` — loopback bind by default.
  - `port` (integer, 1–65535), default `8080`.
- `poll_interval_ms` (integer, positive), default `5000` — how often the dashboard polls each
  target's `/api/v1/state` endpoint.
- `targets` (list, REQUIRED, non-empty) — each entry:
  - `name` (string, unique, REQUIRED) — human-readable board name used in the API and UI.
  - `url` (string, REQUIRED) — base URL of the target `baton` HTTP server (e.g.
    `http://127.0.0.1:8787`). The dashboard appends `/api/v1/state` to poll state and proxies
    refreshes to `/api/v1/refresh`.

CLI flags: `baton-dashboard [config.yaml] [--port N]`. `--port` overrides `server.port`.

### baton-dashboard HTTP API

All routes are observability/control-only (no orchestration logic):

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Multi-board HTML dashboard — per-board status badges, running/retrying tables, aggregated token totals. |
| `GET` | `/api/v1/boards` | JSON array of all `BoardState` objects (credentials and query strings stripped from URLs). |
| `GET` | `/api/v1/boards/<name>/state` | Cached snapshot for the named board. `404` if unknown. |
| `POST` | `/api/v1/boards/<name>/refresh` | Proxy a refresh to the named board's `POST /api/v1/refresh`. Returns `202`; `404` if unknown; `502`/`504` on upstream error. |

Unknown paths return `404`; unsupported methods return `405`; errors use the same JSON
envelope as the per-instance API.

`BoardState` object fields: `name`, `url` (credentials stripped), `up` (boolean), `lastScrapedAt`,
`error` (string, present when `up` is false), `snapshot` (the last successful `/api/v1/state`
payload, or null).

### Multi-instance operation guide

**Distinct ports per instance (REQUIRED when co-located)**

Each `baton` instance that will be aggregated MUST enable `server.port` in its `WORKFLOW.md`
with a port unique to that instance. `baton-dashboard` uses those URLs as `targets`. Example:

```yaml
# board-a/WORKFLOW.md front matter
server:
  port: 8787

# board-b/WORKFLOW.md front matter
server:
  port: 8788
```

If two instances bind the same port on the same host, the second will fail to start.

**Separate workspace roots when repos span multiple Projects**

When the same repository appears in more than one Project (e.g. a repository tracked across
two boards), each `baton` instance MUST use a distinct `workspace.root` to prevent workspace
path collisions:

```yaml
# board-a/WORKFLOW.md
workspace:
  root: ~/baton_workspaces/board-a

# board-b/WORKFLOW.md
workspace:
  root: ~/baton_workspaces/board-b
```

Instances that track non-overlapping repositories MAY share a workspace root because per-issue
paths are namespaced by `<repo>-<issue_number>`.

**GraphQL rate budget is shared per token**

GitHub's GraphQL API enforces a budget of 5,000 points per hour **per access token**. Each
`baton` instance consumes this budget independently (candidate fetch + state refresh on every
poll tick). When multiple instances share the same `GITHUB_TOKEN`:

- Reduce overlap by staggering `polling.interval_ms` values across instances, or
- Use distinct tokens (e.g. one fine-grained PAT per board) so each instance has its own
  5,000-point hourly budget.

Implementations expose `rateLimit { remaining resetAt }` in debug logs (§11.2). Monitor these
fields to detect budget contention early.

**Process supervision**

`baton-dashboard` does not manage the lifecycle of the `baton` processes it aggregates. Use
the host OS process manager (systemd, launchd, pm2, Docker, etc.) to supervise each `baton`
instance and `baton-dashboard` independently. If a `baton` instance is down, `baton-dashboard`
marks its board as `up: false` and retains the last known snapshot; the other boards are
unaffected.
