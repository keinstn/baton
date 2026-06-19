---
tracker:
  kind: github_projects
  owner: my-org
  project_number: 5
  token: $GITHUB_TOKEN
  status_field: Status
  active_states: [Todo, In Progress, Rework]
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
    BRANCH="agent/$BATON_ISSUE_IDENTIFIER"
    if [ "$BATON_ISSUE_STATUS" = "Rework" ]; then
      git switch -C "$BRANCH" origin/main
    elif git ls-remote --exit-code --heads origin "$BRANCH" > /dev/null 2>&1 && \
         gh pr list --repo "$BATON_ISSUE_REPO" --head "$BRANCH" --state open --json number --jq 'length > 0' | grep -q true; then
      git switch "$BRANCH"
    else
      git switch -C "$BRANCH" origin/main
    fi
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
- If the issue status is "Todo" and no open PR exists for this branch, move the issue to
  "In Progress" on the project board before starting work.
- If the issue status is "Todo" and an open PR already exists for this branch, move the issue
  to "In Progress" on the project board, then treat it as a feedback loop: review all open PR
  comments — general conversation comments (fetch them with
  `gh api --paginate repos/$BATON_ISSUE_REPO/issues/<n>/comments`), top-level PR reviews
  including REQUEST_CHANGES and COMMENT reviews (fetch them with
  `gh api --paginate repos/$BATON_ISSUE_REPO/pulls/<n>/reviews`), and inline review-thread
  comments (fetch them with
  `gh api --paginate repos/$BATON_ISSUE_REPO/pulls/<n>/comments`) — and address each one (code
  changes or explicit, justified pushback). Reply to each review-thread comment describing how
  you addressed it
  (`gh api repos/$BATON_ISSUE_REPO/pulls/<n>/comments/<comment_id>/replies -f body=...`); do
  not resolve the threads. When all feedback is resolved, push the branch and move the issue
  status back to "In Review".
- If the issue status is "Rework", treat it as a full approach reset: close the existing PR,
  create a fresh branch from origin/main, and restart implementation from scratch addressing
  the review feedback. When done, open a new PR and move the issue status to "In Review".
- Report progress by editing a single persistent comment on the issue. The comment must begin
  with the marker `<!-- baton-progress -->`. On each run, search existing comments for that
  marker first; if found, edit it in place; if not found, create it. Do not post multiple
  separate comments.
- Only stop early for a true blocker (missing required auth, permissions, or secrets that cannot
  be resolved in-session). If blocked, record what is missing and what action is needed to
  unblock in the progress comment, then move the issue status to "In Review" and stop.
- When done, ensure all tests pass, push the branch, and open a PR with `gh pr create` linking
  the issue. Then move the issue's Status to "In Review" on the project board.
{% if attempt %}
This is retry/continuation attempt {{ attempt }}.
- Resume from the current workspace state; do not restart from scratch.
- Check existing branch/PR state with `gh` before redoing any work.
- Do not repeat already-completed steps unless new changes require it.
{% endif %}
