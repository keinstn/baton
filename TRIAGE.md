---
# baton triage config
#
# Usage: node --experimental-strip-types scripts/triage/index.ts [path/to/TRIAGE.md]
#
# Cron example (run every 30 minutes):
#   */30 * * * * cd /path/to/repo && node --experimental-strip-types scripts/triage/index.ts >> /var/log/triage.log 2>&1
#
# The YAML body after the closing --- is an optional LiquidJS prompt template.
# Leave it empty (or omit it entirely) to use the built-in default (scripts/triage/prompt.md).
# Available template variables: `repository` (owner/name string) and `issues` (array of Issue objects).

# Required: GitHub authentication token.
# Use $GITHUB_TOKEN (recommended) or a literal PAT with repo + project scopes.
tracker:
  token: $GITHUB_TOKEN

  # GitHub user or organization that owns the project board.
  owner: myorg

  # "organization" or "user" — must match the owner type.
  owner_type: organization

  # GitHub Projects v2 project number (visible in the project URL: /projects/<number>).
  project_number: 1

  # Name of the single-select Status field on the project board.
  status_field: Status

  # Status option whose issues should be evaluated in this triage pass.
  todo_state: Todo

  # Label to apply to issues the evaluator marks as "ready".
  ai_ready_label: ai-ready

  # Optional: restrict triage to specific repos.
  # When omitted, all repositories in the project board are included.
  # repos:
  #   - myorg/api
  #   - myorg/web

# Evaluator that runs the LLM judgment pass.
evaluator:
  # "claude_code" (uses the `claude` CLI) or "copilot" (uses the `copilot` CLI).
  kind: claude_code

  # Model to use. Omit to use each CLI's default.
  model: claude-sonnet-4-6

  # Optional overrides:
  # command: claude          # override CLI binary name or path
  # timeout_ms: 60000        # evaluation timeout in milliseconds (default: 60000)
  # permission_mode: bypassPermissions
  # deny_tools: ["Bash", "Edit"]
---
