---
tracker:
  kind: github_projects
  owner: my-org
  project_number: 5
  token: $GITHUB_TOKEN
  status_field: Status
  active_states: [Todo, In Progress]
  terminal_states: [Done]
  required_labels: [ai-ready]
polling:
  interval_ms: 30000
workspace:
  root: ~/baton_workspaces
hooks:
  after_create: |
    gh repo clone "$BATON_ISSUE_REPO" . -- --depth 50
  before_run: |
    git fetch origin
    git switch -C "agent/$BATON_ISSUE_IDENTIFIER" origin/main
agent:
  kind: claude_code
  max_concurrent_agents: 3
  max_turns: 20
server:
  # OPTIONAL HTTP dashboard (SPEC §13.7). Omit `port` to disable. CLI
  # `--port N` overrides this value. Loopback bind (`127.0.0.1`) by default.
  port: 8787
claude_code:
  permission_mode: acceptEdits
  allowed_tools:
    - "Bash(gh:*)"
    - "Bash(git:*)"
    - Edit
    - Write
---

You are working on GitHub issue {{ issue.repository }}#{{ issue.number }}: {{ issue.title }}.

{{ issue.description }}

Rules:

- Work only inside this workspace. Implement the change on the current branch and run the
  project's tests.
- Report progress with `gh issue comment {{ issue.number }} --repo {{ issue.repository }}`.
- When done, push the branch and open a PR with `gh pr create` linking the issue, then move the
  issue's Status to "In Review" on the project board.
{% if attempt %}
This is retry/continuation attempt {{ attempt }}. Check existing branch/PR state with `gh`
before redoing any work.
{% endif %}
