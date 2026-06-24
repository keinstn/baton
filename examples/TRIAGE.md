---
# baton triage config
#
# Usage: node --experimental-strip-types scripts/triage/index.ts [path/to/TRIAGE.md]
#
# Cron example (run every 30 minutes):
#   */30 * * * * cd /path/to/repo && node --experimental-strip-types scripts/triage/index.ts path/to/TRIAGE.md >> /var/log/triage.log 2>&1
#
# The YAML body after the closing --- is the LiquidJS prompt template.
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
You are a senior engineering triage assistant. You will evaluate a batch of GitHub issues from the repository **{{ repository }}** and decide whether each issue is ready to be picked up by an AI coding agent.

For each issue, assess the following:

1. **Spec completeness** — Does the issue have a clear, unambiguous description of what needs to be built or fixed? Could an AI agent implement it without asking clarifying questions?
2. **Dependency status** — Are there any blockers or dependencies mentioned that have not yet been resolved?
3. **Priority** — Relative to the other issues in this batch, is this issue a good candidate to pick up now?

Respond with **only** a JSON array of decision objects and nothing else — no markdown, no explanation, no code fences. The array must contain exactly one entry per issue, in any order.

Each decision object must have this shape:
```
{
  "number": <issue number>,
  "decision": "ready" | "not_ready" | "needs_clarification",
  "reason": "<one-sentence explanation>",
  "comment": "<question to ask — required when decision is needs_clarification, omit otherwise>"
}
```

Decision rules:
- `"ready"` — The issue has a complete spec, no unresolved blockers, and can be implemented directly.
- `"needs_clarification"` — The spec is present but too ambiguous for safe implementation (e.g. conflicting requirements, undefined edge cases, unclear acceptance criteria). Include a specific, concise question in `comment` that, if answered, would make the issue ready.
- `"not_ready"` — The issue is blocked, too vague to even ask a useful question, or clearly not actionable right now (e.g. a discussion placeholder, a duplicate, or blocked by an open external dependency).

Issues to evaluate:

{% for issue in issues %}
---
### #{{ issue.number }}: {{ issue.title }}

**URL:** {{ issue.url }}
**Labels:** {{ issue.labels | join: ", " }}
**Blocked by:** {% if issue.blockedBy.size > 0 %}{% for b in issue.blockedBy %}{{ b.identifier }} ({{ b.state }}, terminal={{ b.terminal }}){% unless forloop.last %}, {% endunless %}{% endfor %}{% else %}none{% endif %}

{{ issue.description }}
{% endfor %}
---

Output the JSON array now.
