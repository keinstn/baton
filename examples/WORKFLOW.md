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
    # Preserve existing workspace state for normal retries/continuations: keep
    # in-progress git operations and reuse a local branch when possible. Only
    # Rework resets the branch back to origin/HEAD.
    GIT_IN_PROGRESS=false
    if [ -f .git/MERGE_HEAD ] || [ -f .git/CHERRY_PICK_HEAD ] || \
       [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
      GIT_IN_PROGRESS=true
    fi
    if [ "$BATON_ISSUE_STATUS" = "Rework" ]; then
      git switch -C "$BRANCH" origin/HEAD
    elif [ "$GIT_IN_PROGRESS" = true ]; then
      :
    elif git show-ref --verify --quiet "refs/heads/$BRANCH"; then
      git switch "$BRANCH"
    elif git ls-remote --exit-code --heads origin "$BRANCH" > /dev/null 2>&1 && \
         gh pr list --repo "$BATON_ISSUE_REPO" --head "$BRANCH" --state open --json number --jq 'length > 0' | grep -q true; then
      git switch -c "$BRANCH" --track "origin/$BRANCH"
    else
      git switch -C "$BRANCH" origin/HEAD
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
- Before moving the issue into a review state, inspect the project's available Status options and
  choose the destination for this run:
  - if `Agent Review` exists, use `Agent Review`
  - otherwise use `In Review`
  - be consistent within the run and move the issue to the same chosen review state everywhere,
    except for true blockers, which should always move to `In Review`
- If the issue status is "Todo" and no open PR exists for this branch, move the issue to
  "In Progress" on the project board before starting work.
- If an open PR already exists for this branch and the issue status is not "Rework", treat the
  run as a feedback loop. If the issue status is "Todo", move it to "In Progress" on the project
  board before starting.
  - Resolve the Baton branch, PR number, and PR base branch:
    `BRANCH="agent/{{ issue.identifier }}"`
    `PR_NUMBER=$(gh pr view "$BRANCH" --repo "{{ issue.repository }}" --json number --jq '.number')`
    `BASE_BRANCH=$(gh pr view "$BRANCH" --repo "{{ issue.repository }}" --json baseRefName --jq '.baseRefName')`
  - Before starting a new base merge, inspect the current workspace state:
    - if a merge, rebase, or cherry-pick is already in progress, finish it or abort it
      intentionally before continuing; do not start a second merge on top of an unfinished one
    - if there are existing local changes from a prior attempt, inspect `git status` and either
      continue that work, commit it, or stash it intentionally before merging the base
  - After the branch state is clean, integrate the current PR base with
    `git merge --no-edit "origin/$BASE_BRANCH"`.
    - if it is already up to date, continue
    - if it reports conflicts, resolve each unmerged path by hand based on the intent of both
      sides; do not blindly `--ours`/`--theirs` the whole file
    - run the project's tests before continuing; if you resolved conflicts manually, commit
      the merge result first
  - Collect the current actionable feedback set for that PR and address each item (code changes or
    explicit, justified pushback). For PR conversation feedback, post any agent follow-up as a
    later PR comment with a marker of the form
    `<!-- baton-agent-reply source_comment_id=<comment_id> -->` so Baton can tell which
    conversation comment has already been handled. For each actionable inline review thread, treat
    the latest reviewer comment that does not already have a later `<!-- baton-agent-reply -->` reply
    in the same thread as the item to address. After addressing the thread, post the reply using
    the first comment in the thread (`databaseId` of `comments.nodes[0]`)
    (`gh api repos/{{ issue.repository }}/pulls/$PR_NUMBER/comments/<root_databaseId>/replies -f body='<!-- baton-agent-reply --> [Baton Implementer] ...'`).
    Then apply thread-type-specific handling based on the first comment body (`comments.nodes[0].body`):
    - **Bot thread** (first comment contains `<!-- baton-reviewer-finding`): if no
      `baton-agent-reply` reply exists in the thread yet, address the finding and post the reply.
      If a `baton-agent-reply` already exists (partial-failure recovery: a prior run posted the
      reply but `resolveReviewThread` failed), skip re-posting. In both cases, call
      `resolveReviewThread`. If the mutation fails, escalate: move the issue to "In Review" (not
      the chosen review state) and stop.
    - **Human thread** (first comment does not contain `<!-- baton-reviewer-finding`): do not
      resolve the thread; the posted reply is sufficient to mark it as addressed.
  - When all feedback is resolved, push the branch with a normal `git push` (never force-push;
    this single push carries both any merge commit and your feedback changes) and move the issue
    status to the chosen review state.
- Actionable feedback means:
  - PR conversation comments on `issues/$PR_NUMBER/comments` — including comments containing
    `<!-- baton-reviewer-finding -->` or `<!-- baton-reviewer-summary -->`, which are Reviewer
    findings that MUST be addressed with code changes and a `baton-agent-reply` response — that
    do not themselves start with `<!-- baton-agent-reply` or `<!-- baton-impl-progress` (those are the
    Implementer's own comment types and should be skipped) and do not already have a later agent
    follow-up comment containing `<!-- baton-agent-reply source_comment_id=<comment_id> -->` for
    that comment's ID
  - inline review threads, fetched via `gh api graphql` — use `{{ issue.repository }}`
    as the owner/repo value (split into owner/repo inline as needed, e.g.
    `GH_OWNER=$(echo "{{ issue.repository }}" | cut -d/ -f1)`,
    `GH_REPO=$(echo "{{ issue.repository }}" | cut -d/ -f2)`) and
    request fields for `reviewThreads` (including `isResolved`) and `comments(first:10)` including
    pagination metadata (`pageInfo { hasNextPage endCursor }`), then paginate review threads and
    thread comments further as needed. A thread is actionable if:
    - it is a **bot thread** (first comment body contains `<!-- baton-reviewer-finding`) and
      `isResolved` is `false` and no `baton-agent-reply` reply already exists in the thread
      (normal case), or
    - it is a **bot thread** (first comment body contains `<!-- baton-reviewer-finding`) and
      `isResolved` is `false` and a `baton-agent-reply` reply already exists in the thread
      (partial-failure recovery: a prior run posted the reply but `resolveReviewThread` failed), or
    - it is a **human thread** (first comment body does not contain `<!-- baton-reviewer-finding`)
      and the latest reviewer comment does not already have a later `<!-- baton-agent-reply -->`
      reply in the same thread
  - the latest still-actionable top-level review summary per reviewer from
    `pulls/$PR_NUMBER/reviews`
  - paginate all list results; for top-level reviews, later `APPROVED` or `DISMISSED` reviews
    from the same reviewer supersede older requests or comments
- If the issue status is "Rework", close the existing PR, reset the branch to origin/HEAD, and
  take a fresh implementation pass addressing the review feedback. When done, open a new PR and
  move the issue status to the chosen review state.
- Every PR comment or reply that this workflow posts must include a visible `[Baton Implementer]`
  prefix so the implementation workflow's activity can be distinguished from human comments and
  from the reviewer workflow.
- Report progress by editing a single persistent comment on the issue. The comment must begin
  with the marker `<!-- baton-impl-progress -->`. On each run, search existing comments for that
  marker first; if found, edit it in place; if not found, create it. Do not post multiple
  separate comments. The comment body has two sections:
  1. **Summary section** (overwrite on every run): `Role:` and `Status:` lines immediately after
     the marker, giving the current state at a glance. `Role:` must be `Baton Implementer`.
  2. **Log section** (append-only): a `<!-- baton-log -->` block within the same comment. On
     every run, prepend one new line in the format `<ISO8601 timestamp> | <Role> | <summary>`
     so the full round-trip history is preserved. If the existing comment has no
     `<!-- baton-log -->` block (e.g. it predates this format), append the block rather than
     failing.

  Example comment format:
  ```
  <!-- baton-impl-progress -->
  Role: Baton Implementer
  Status: in-progress — implementing validation logic

  <!-- baton-log -->
  2026-06-20T09:10Z | Baton Implementer | pr-opened — PR #42
  2026-06-20T08:45Z | Baton Implementer | in-progress — implementing validation logic
  ```
- On retries or continuations, resume from the current workspace state. Check the existing branch,
  git-operation state, and PR state before redoing work, and do not repeat already-completed steps
  unless new changes require it.
- Only stop early for a true blocker (missing required auth, permissions, or secrets that cannot
  be resolved in-session). If blocked, record what is missing and what action is needed to
  unblock in the progress comment, then move the issue status to "In Review" and stop.
- When done, ensure all tests pass, push the branch, and open a PR with `gh pr create` linking
  the issue. Then move the issue's Status to the chosen review state on the project board.
