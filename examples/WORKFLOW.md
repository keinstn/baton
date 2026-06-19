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
    GIT_IN_PROGRESS=false
    if [ -f .git/MERGE_HEAD ] || [ -f .git/CHERRY_PICK_HEAD ] || \
       [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
      GIT_IN_PROGRESS=true
    fi
    if [ "$BATON_ISSUE_STATUS" = "Rework" ]; then
      if [ -f .git/MERGE_HEAD ]; then
        git merge --abort
      fi
      if [ -f .git/CHERRY_PICK_HEAD ]; then
        git cherry-pick --abort
      fi
      if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
        git rebase --abort
      fi
      git switch -C "$BRANCH" origin/main
    elif [ "$GIT_IN_PROGRESS" = true ]; then
      :
    elif git show-ref --verify --quiet "refs/heads/$BRANCH"; then
      git switch "$BRANCH"
    elif git ls-remote --exit-code --heads origin "$BRANCH" > /dev/null 2>&1 && \
         gh pr list --repo "$BATON_ISSUE_REPO" --head "$BRANCH" --state open --json number --jq 'length > 0' | grep -q true; then
      git switch -c "$BRANCH" --track "origin/$BRANCH"
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
- If an open PR already exists for this branch and the issue status is not "Rework", treat the
  run as a feedback loop. If the issue status is "Todo", move it to "In Progress" on the project
  board before starting. Resolve the open PR number and base branch
  (`BRANCH="agent/$BATON_ISSUE_IDENTIFIER"`,
  `PR_NUMBER=$(gh pr view "$BRANCH" --repo "$BATON_ISSUE_REPO" --json number --jq '.number')`,
  `BASE_BRANCH=$(gh pr view "$BRANCH" --repo "$BATON_ISSUE_REPO" --json baseRefName --jq '.baseRefName')`). Before starting a new base
  merge, check whether the workspace is already in the middle of a merge, rebase, or cherry-pick
  from a prior attempt. If so, inspect the current state and either finish that in-progress
  operation or abort it intentionally before continuing; do not start a second merge on top of an
  unfinished one. If there are existing local changes from a prior attempt, inspect `git status`
  and either continue that work, commit it, or stash it intentionally before merging the base.
  After the branch state is clean, integrate the current PR base with
  `git merge --no-edit "origin/$BASE_BRANCH"`. If it merges cleanly (or is already up to date),
  continue. If it reports conflicts, resolve each unmerged path by hand based on the intent of
  both sides — do not blindly `--ours`/`--theirs` the whole file — then run the project's tests,
  commit the merge, and continue. Then collect the current actionable feedback set for that PR,
  address each item (code changes
  or explicit, justified pushback). For PR conversation feedback, post any agent follow-up as a
  later PR comment with a marker of the form
  `<!-- baton-agent-reply source_comment_id=<comment_id> -->` so Baton can tell which
  conversation comment has already been handled. For each unresolved review thread, treat the
  latest reviewer comment that does not already have a later `<!-- baton-agent-reply -->` reply
  in the same thread as the item to address, and post the reply using the first comment in the
  thread (`databaseId` of `comments.nodes[0]`)
  (`gh api repos/$BATON_ISSUE_REPO/pulls/$PR_NUMBER/comments/<root_databaseId>/replies -f body='<!-- baton-agent-reply --> ...'`);
  do not resolve the threads. When all feedback is resolved, push the branch with a normal
  `git push` (never force-push; this single push carries both any merge commit and your feedback
  changes) and move the issue status back to "In Review".
- Actionable feedback means:
  - PR conversation comments on `issues/$PR_NUMBER/comments` that do not themselves contain
    `<!-- baton-agent-reply source_comment_id=<comment_id> -->` and do not already have a later
    agent follow-up comment containing that marker for that comment's ID
  - unresolved inline review threads, fetched via `gh api graphql` — split `$BATON_ISSUE_REPO`
    into owner/repo (`GH_OWNER=${BATON_ISSUE_REPO%%/*}`, `GH_REPO=${BATON_ISSUE_REPO##*/}`) and
    request fields for `reviewThreads` and `comments(first:10)` including pagination metadata
    (`pageInfo { hasNextPage endCursor }`), then paginate review threads and thread comments
    further as needed until you can identify the latest reviewer comment that does not already
    have a later `<!-- baton-agent-reply -->` reply in the same thread
  - the latest still-actionable top-level review summary per reviewer from
    `pulls/$PR_NUMBER/reviews`
  - paginate all list results; for top-level reviews, later `APPROVED` or `DISMISSED` reviews
    from the same reviewer supersede older requests or comments
- If the issue status is "Rework", treat it as a full approach reset: close the existing PR,
  create a fresh branch from origin/main, and restart implementation from scratch addressing
  the review feedback. When done, open a new PR and move the issue status to "In Review".
- Report progress by editing a single persistent comment on the issue. The comment must begin
  with the marker `<!-- baton-progress -->`. On each run, search existing comments for that
  marker first; if found, edit it in place; if not found, create it. Do not post multiple
  separate comments.
- On retries or continuations, resume from the current workspace state. Check the existing branch,
  git-operation state, and PR state before redoing work, and do not repeat already-completed steps
  unless new changes require it.
- Only stop early for a true blocker (missing required auth, permissions, or secrets that cannot
  be resolved in-session). If blocked, record what is missing and what action is needed to
  unblock in the progress comment, then move the issue status to "In Review" and stop.
- When done, ensure all tests pass, push the branch, and open a PR with `gh pr create` linking
  the issue. Then move the issue's Status to "In Review" on the project board.
