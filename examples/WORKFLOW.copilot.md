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
  kind: copilot
  max_concurrent_agents: 3
  max_turns: 20
copilot:
  # The runner adds --no-ask-user automatically so the agent never prompts the
  # operator interactively (SPEC §10.2 / §10.3). Tool permissions follow the
  # SPEC §15 minimal-allowlist posture; flip allow_all_tools to true only with
  # an explicit operator decision.
  allow_all_tools: false
  allow_tools:
    - "shell(gh)"
    - "shell(git)"
    - write
    - view
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
