---
tracker:
  kind: github_projects
  owner: my-org
  project_number: 5
  token: $GITHUB_TOKEN
  status_field: Status
  active_states: [Agent Review]
  terminal_states: [Done]
  required_labels: [ai-ready]
polling:
  interval_ms: 30000
workspace:
  # Use a separate root from the implementation workflow (examples/WORKFLOW.md) so the two
  # Baton processes never share a working tree. The reviewer always re-syncs to origin below,
  # so it reviews the published PR head rather than the implementer's local state.
  root: ~/baton_review_workspaces
hooks:
  after_create: |
    gh repo clone "$BATON_ISSUE_REPO" . -- --depth 50
  before_run: |
    git fetch origin
    BRANCH="agent/$BATON_ISSUE_IDENTIFIER"
    # Review-only: never push, so always hard-reset to the origin head. This avoids reviewing a
    # stale local branch when re-reviewing after the implementer pushed new commits.
    if git ls-remote --exit-code --heads origin "$BRANCH" > /dev/null 2>&1 && \
       gh pr list --repo "$BATON_ISSUE_REPO" --head "$BRANCH" --state open --json number --jq 'length > 0' | grep -q true; then
      git switch -C "$BRANCH" --track "origin/$BRANCH"
      git reset --hard "origin/$BRANCH"
    else
      git switch --detach origin/main
    fi
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
    - view
---

You are working on GitHub issue {{ issue.repository }}#{{ issue.number }}: {{ issue.title }}.

{{ issue.description }}

Rules:

- Work only inside this workspace. This workflow is review-only: inspect the current PR and leave
  review feedback through GitHub. Do not create commits, push branch changes, or implement the
  fix yourself.
- This workflow is paired with an implementation workflow. It should only act while the issue
  status is "Agent Review".
- Resolve the Baton branch and confirm there is an open PR for it:
  `BRANCH="agent/$BATON_ISSUE_IDENTIFIER"`
  `OPEN_PR_COUNT=$(gh pr list --repo "$BATON_ISSUE_REPO" --head "$BRANCH" --state open --json number --jq 'length')`
- If no open PR exists for the Baton branch, treat that as an implementation-side blocker:
  update the progress comment, move the issue status back to "In Progress", and stop.
- Once an open PR exists, resolve the PR number and base branch:
  `PR_NUMBER=$(gh pr view "$BRANCH" --repo "$BATON_ISSUE_REPO" --json number --jq '.number')`
  `BASE_BRANCH=$(gh pr view "$BRANCH" --repo "$BATON_ISSUE_REPO" --json baseRefName --jq '.baseRefName')`
- Review the PR as it exists now. Use `gh pr diff`, `gh pr view`, `gh pr checks`, `gh api`, and
  local read-only inspection as needed. Take existing review threads and comments into account so
  you do not re-raise feedback that is already resolved in the current diff.
- Focus on actionable review findings: correctness bugs, missing edge cases, regressions,
  dangerous migrations, broken tests, and mismatches between the issue and the implementation.
  Avoid speculative or style-only comments.
- If you find actionable issues:
  - submit PR comments with concrete guidance, using inline comments when a code location matters
  - update the issue progress comment with a concise summary of what the implementation workflow
    should address next
  - move the issue status back to "In Progress" so the implementation workflow can resume
- If you do not find actionable issues:
  - post a summary comment that makes it clear the agent review pass is complete
  - update the issue progress comment to say the PR is ready for human review
  - move the issue status to "In Review"
- Do not resolve review threads on behalf of humans. Leave the discussion state visible unless a
  human reviewer resolves it later.
- Report progress by editing a single persistent comment on the issue. The comment must begin
  with the marker `<!-- baton-progress -->`. On each run, search existing comments for that
  marker first; if found, edit it in place; if not found, create it. Do not post multiple
  separate comments.
- Only stop early for a true blocker (missing required auth, permissions, or secrets that cannot
  be resolved in-session). If blocked, record what is missing and what action is needed to
  unblock in the progress comment, then move the issue status to "In Review" and stop.
{% if attempt %}
This is retry/continuation attempt {{ attempt }}.
- Re-review the latest PR state instead of assuming your earlier findings still apply.
- Check existing branch/PR state with `gh` before posting another review.
- Avoid duplicating comments when a previous finding is already addressed or already recorded.
{% endif %}
