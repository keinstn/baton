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
    gh repo clone "$BATON_ISSUE_REPO" . -- --depth 50 --no-single-branch
  before_run: |
    git fetch origin
    BRANCH="agent/$BATON_ISSUE_IDENTIFIER"
    # Review-only: never push, so always hard-reset to the origin head. This avoids reviewing a
    # stale local branch when re-reviewing after the implementer pushed new commits.
    if git show-ref --verify --quiet "refs/remotes/origin/$BRANCH" && \
       gh pr list --repo "$BATON_ISSUE_REPO" --head "$BRANCH" --state open --json number --jq 'length > 0' | grep -q true; then
      git switch -C "$BRANCH" --track "origin/$BRANCH"
    else
      git switch --detach origin/HEAD
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
    # Minimal allowlist for a Copilot reviewer run. Copilot CLI uses its own
    # permission model: bare tool names (report_intent, bash, rg, view) are
    # permitted as-is; shell subcommands need a wildcard to match any argument.
    - "report_intent"  # signal reviewer intent before taking actions
    - "bash"           # run shell commands during review
    - "rg"             # ripgrep for local code search
    - "view"           # read files without triggering unqualified-tool failures
    # shell(command:*) syntax: wildcard required to permit any subcommand.
    # "shell(gh)" without a wildcard matches only the bare `gh` invocation and
    # rejects every subcommand (pr, api, issue…), producing tool_failed: unknown.
    - "shell(gh:*)"    # gh pr diff/view/checks/api/comment/issue
    - "shell(git:*)"   # git fetch/switch/log/ls-remote (before_run hook + review)
---

You are working on GitHub issue {{ issue.repository }}#{{ issue.number }}: {{ issue.title }}.

{{ issue.description }}

Rules:

- Work only inside this workspace. This workflow is review-only: inspect the current PR and leave
  review feedback through GitHub. Do not create commits, push branch changes, or implement the
  fix yourself.
- This workflow is paired with an implementation workflow. It should only act while the issue
  status is "Agent Review".
- The implementation workflow, this reviewer workflow, and human reviewers may all share the same
  GitHub account. Do not rely on comment author identity to tell human and agent activity apart;
  use Baton markers instead.
- Resolve the Baton branch and confirm there is an open PR for it:
  `BRANCH="agent/{{ issue.identifier }}"`
  `OPEN_PR_COUNT=$(gh pr list --repo "{{ issue.repository }}" --head "$BRANCH" --state open --json number --jq 'length')`
- If no open PR exists for the Baton branch, treat that as an implementation-side blocker:
  update the progress comment, move the issue status back to "In Progress", and stop.
- Once an open PR exists, resolve the PR number:
  `PR_NUMBER=$(gh pr view "$BRANCH" --repo "{{ issue.repository }}" --json number --jq '.number')`
- Review the PR as it exists now. Use `gh pr diff`, `gh pr view`, `gh pr checks`, `gh api`, and
  local read-only inspection as needed. Take existing review threads and comments into account so
  you do not re-raise feedback that is already resolved in the current diff.
- When evaluating inline review threads to determine whether feedback has been addressed, apply
  the following per-thread rules (fetch threads via `gh api graphql` including `isResolved` and
  all comment bodies):
  - **Bot thread** (first comment body contains `<!-- baton-reviewer-finding`): skip the thread
    if `isResolved` is `true`; it has been resolved by the implementation workflow.
  - **Human thread** (first comment body does not contain `<!-- baton-reviewer-finding`): skip
    the thread if it already contains a subsequent reply with `<!-- baton-agent-reply -->` in the
    same thread; that reply signals the implementer has addressed it.
- Every PR comment that this workflow creates must include a Baton reviewer marker plus a visible
  label:
  - summary comment marker:
    `<!-- baton-reviewer-summary status=<pass|needs_changes> -->`
  - finding comment marker: `<!-- baton-reviewer-finding id=<stable_id> -->`
  - visible prefix: `[Baton Reviewer]`
- Treat the reviewer summary comment as the source of truth for the `status` field only. The
  `handoff_count` and `last_reviewed_sha` state is owned by GitHub Projects custom fields
  (`Handoff Count` and `Last Reviewed SHA`), not the comment body. Keep the marker line
  machine-readable and stable, and add a visible note such as `Managed by Baton; do not edit the
  marker line manually.` below it.
- Every reviewer finding should also carry exactly one intent prefix after `[Baton Reviewer]`:
  - `[must]` for a concrete defect, regression, security problem, or other change that should be fixed
  - `[ask]` for an ambiguity, missing context, or specification question that needs clarification
  - `[imo]` for a non-blocking suggestion that still has clear technical value
- Do not use `[nits]`. Keep the workflow high-signal.
- Treat comments without a Baton reviewer marker as human-authored for workflow purposes, even if
  they were posted by the same GitHub account. Do not edit, replace, or classify unmarked comments
  as this workflow's own output.
- Focus on actionable review findings: correctness bugs, missing edge cases, regressions,
  dangerous migrations, broken tests, mismatches between the issue and the implementation,
  backward-compatibility risks, failure-mode gaps, security problems, and operational risk.
- Check both the intended behavior and the safety of the change:
  - verify the implementation matches the issue, PR description, and any explicit design intent
  - look for regressions in existing APIs, configuration, data flows, and operator workflows
  - inspect boundary conditions and failure paths, not just the happy path
  - call out risky permissions, secret exposure, destructive commands, or unsafe automation
- Prefer fewer, high-confidence findings over many low-signal comments. Avoid speculative,
  style-only, naming-preference, or minor-refactor comments unless they hide a real defect.
- When leaving a finding, explain the concrete risk: what breaks, when it breaks, and why it
  matters.
- When you can see a likely repair direction, add a brief implementation hint that helps the
  implementer understand how to resolve the problem. Keep it short and non-binding: clarify the
  shape of a fix without dictating the only acceptable implementation.
- Limit agent-only review loops. Track how many times this workflow has sent the issue back from
  `Agent Review` to `In Progress` using the `Handoff Count` GitHub Projects custom field (number
  type). Use the `Last Reviewed SHA` custom field (text type) to prevent duplicate increments when
  the agent re-reviews the same PR commit.
  - **Resolve field node IDs at the start of each run.** Field node IDs must NOT be hardcoded;
    resolve them by name at runtime:
    1. Get the project node ID from the item:
       ```
       PROJECT_ID=$(gh api graphql \
         -f query='query($id:ID!){node(id:$id){...on ProjectV2Item{project{id}}}}' \
         -f id="{{ issue.item_id }}" --jq '.data.node.project.id')
       ```
    2. List the project's fields and filter by name:
       ```
       FIELDS=$(gh api graphql \
         -f query='query($id:ID!){node(id:$id){...on ProjectV2{fields(first:50){nodes{...on ProjectV2FieldCommon{id name}}}}}}' \
         -f id="$PROJECT_ID")
       HANDOFF_COUNT_FIELD_ID=$(echo "$FIELDS" | jq -r '.data.node.fields.nodes[]|select(.name=="Handoff Count")|.id')
       LAST_SHA_FIELD_ID=$(echo "$FIELDS" | jq -r '.data.node.fields.nodes[]|select(.name=="Last Reviewed SHA")|.id')
       ```
    3. If either field ID is empty or the queries fail, do not proceed: update the reviewer
       summary and progress comment to say `Human attention required: required Project fields
       (Handoff Count / Last Reviewed SHA) could not be resolved.` and move the issue to
       `In Review`.
  - **Read current field values** from the project item. Use `first:50` (the API maximum per
    page) and fetch `pageInfo.hasNextPage`; if the response was truncated, the target fields may
    be absent — take the human-escalation path rather than silently defaulting:
    ```
    ITEM=$(gh api graphql \
      -f query='query($id:ID!){node(id:$id){...on ProjectV2Item{fieldValues(first:50){pageInfo{hasNextPage}nodes{
        ...on ProjectV2ItemFieldNumberValue{number field{...on ProjectV2FieldCommon{name}}}
        ...on ProjectV2ItemFieldTextValue{text field{...on ProjectV2FieldCommon{name}}}}}}}}' \
      -f id="{{ issue.item_id }}")
    if echo "$ITEM" | jq -e '.data.node.fieldValues.pageInfo.hasNextPage' | grep -q true; then
      # fieldValues was truncated; target fields may be absent — take the human-escalation path
      # (same as field-ID resolution failure: update reviewer summary and progress comment,
      #  move issue to In Review, stop)
    fi
    CURRENT_COUNT=$(echo "$ITEM" | jq -r '.data.node.fieldValues.nodes[]|select(.field.name=="Handoff Count")|.number' | head -1)
    CURRENT_SHA=$(echo "$ITEM"   | jq -r '.data.node.fieldValues.nodes[]|select(.field.name=="Last Reviewed SHA")|.text // ""' | head -1)
    CURRENT_COUNT=${CURRENT_COUNT:-0}
    CURRENT_SHA=${CURRENT_SHA:-""}
    ```
  - **Get the current PR head SHA:**
    ```
    PR_HEAD_SHA=$(gh pr view "$PR_NUMBER" --repo "{{ issue.repository }}" --json headRefOid --jq '.headRefOid')
    ```
  - **Apply status-based reset** (prevents normal agent → human → agent round-trips from consuming
    the loop budget): check the existing reviewer summary comment's `status` field:
    - if `status=pass`: the prior cycle ended with approval; reset `Handoff Count` to `0` in the
      project field, set `CURRENT_SHA=""` locally (so the duplicate-increment check treats the
      first commit of the new cycle as new even if the implementer pushed no new commits), and use
      `0` as the effective count for this run.
    - if `status=needs_changes` or no prior summary comment: keep the value read from the project
      field as the effective count.
    - if `status` is present but cannot be parsed as `pass` or `needs_changes` (malformed or
      unrecognised value): update the reviewer summary and progress comment to say
      `Human attention required: reviewer state could not be read safely.` and move the issue
      to `In Review`.
  - **Duplicate-increment prevention**: when this workflow is about to return the issue to
    `In Progress`, compare `PR_HEAD_SHA` with `CURRENT_SHA`:
    - if they are equal, the agent is re-reviewing the same commit — do not increment the count.
    - if they differ, increment the effective count by 1.
    Assign `$NEW_COUNT` explicitly before writing to the project fields:
    ```
    if [ "$PR_HEAD_SHA" = "$CURRENT_SHA" ]; then
      NEW_COUNT=$CURRENT_COUNT          # same commit — no increment
    else
      NEW_COUNT=$((CURRENT_COUNT + 1))  # new commit — increment
    fi
    ```
    Always write both the new count and `PR_HEAD_SHA` back to the project fields when sending
    back or when approving:
    ```
    # Update Handoff Count
    gh api graphql \
      -f query='mutation($pid:ID!,$iid:ID!,$fid:ID!,$val:Float!){updateProjectV2ItemFieldValue(input:{projectId:$pid,itemId:$iid,fieldId:$fid,value:{number:$val}}){projectV2Item{id}}}' \
      -f pid="$PROJECT_ID" -f iid="{{ issue.item_id }}" -f fid="$HANDOFF_COUNT_FIELD_ID" -F val="$NEW_COUNT"
    # Update Last Reviewed SHA
    gh api graphql \
      -f query='mutation($pid:ID!,$iid:ID!,$fid:ID!,$val:String!){updateProjectV2ItemFieldValue(input:{projectId:$pid,itemId:$iid,fieldId:$fid,value:{text:$val}}){projectV2Item{id}}}' \
      -f pid="$PROJECT_ID" -f iid="{{ issue.item_id }}" -f fid="$LAST_SHA_FIELD_ID" -f val="$PR_HEAD_SHA"
    ```
  - once the effective count reaches `3`, stop sending the issue back to `In Progress`
  - after the third send-back, escalate by updating the reviewer summary and progress comment to
    say `Human attention required: agent review loop limit reached.` and move the issue to
    `In Review` for human review
- If you find actionable issues:
  - post marker-tagged PR comments with concrete guidance; use inline comments when a code location
    matters
  - choose a stable `id` for each finding (for example, path + short slug) and search existing
    `<!-- baton-reviewer-finding id=... -->` comments first; if the same still-applicable finding
    is already present, do not post it again
  - create or update exactly one reviewer summary comment: search existing PR comments for
    `<!-- baton-reviewer-summary status=` first; if found, edit it in place via
    `gh api repos/{{ issue.repository }}/issues/comments/<comment_id> --method PATCH -f body='...'`;
    if not found, post a new one with `gh pr comment $PR_NUMBER --repo {{ issue.repository }} --body '...'`.
    The comment must contain `<!-- baton-reviewer-summary status=needs_changes -->`
    and a visible `[Baton Reviewer]` prefix plus `Managed by Baton; do not edit the marker line
    manually.`. Each finding comment should normally use `[must]`; use `[ask]` instead when you
    need clarification before deciding whether the change is wrong, and use `[imo]` sparingly for
    non-blocking advice.
  - update the issue progress comment with `Role: Baton Reviewer` plus a concise summary of what
    the implementation workflow should address next
  - if `$NEW_COUNT` is still below `3`, move the issue status back to "In Progress" so the
    implementation workflow can resume
  - if `$NEW_COUNT` would reach or exceed `3`, do not send the issue back again; instead, keep
    `status=needs_changes`, say `Human attention required: agent review loop limit reached.`, and
    move the issue to "In Review"
- If you do not find actionable issues:
  - set `NEW_COUNT=$CURRENT_COUNT` (no increment on the approval path) and write both `$NEW_COUNT`
    and `$PR_HEAD_SHA` to the project fields using the same mutation snippets as the send-back path
  - create or update exactly one reviewer summary comment using the same search-then-edit-or-create
    pattern: `<!-- baton-reviewer-summary status=pass -->` and a visible
    `[Baton Reviewer]` prefix plus `Managed by Baton; do not edit the marker line manually.`
  - update the issue progress comment with `Role: Baton Reviewer` and say the PR is ready for
    human review
  - move the issue status to "In Review"
- Do not resolve review threads on behalf of humans. Leave the discussion state visible unless a
  human reviewer resolves it later.
- Report progress by editing a single persistent comment on the issue. The comment must begin
  with the marker `<!-- baton-review-progress -->`. On each run, search existing comments for that
  marker first; if found, edit it in place; if not found, create it. Do not post multiple
  separate comments. The comment body has two sections:
  1. **Summary section** (overwrite on every run): `Role:` and `Status:` lines immediately after
     the marker, giving the current state at a glance. `Role:` must be `Baton Reviewer`.
  2. **Log section** (append-only): a `<!-- baton-log -->` block within the same comment. On
     every run, prepend one new line in the format `<ISO8601 timestamp> | <Role> | <summary>`
     so the full round-trip history is preserved. If the existing comment has no
     `<!-- baton-log -->` block (e.g. it predates this format), append the block rather than
     failing.

  Example comment format:
  ```
  <!-- baton-review-progress -->
  Role: Baton Reviewer
  Status: needs_changes — missing edge case in retry logic

  <!-- baton-log -->
  2026-06-20T10:30Z | Baton Reviewer | needs_changes — missing edge case in retry logic
  2026-06-20T09:10Z | Baton Implementer | pr-opened — PR #42
  ```
- Only stop early for a true blocker (missing required auth, permissions, or secrets that cannot
  be resolved in-session). If blocked, record what is missing and what action is needed to
  unblock in the progress comment, include `Role: Baton Reviewer`, create or update the reviewer
  summary comment with `status=needs_changes`, say `Human attention required:` in both places, then
  move the issue status to "In Review" and stop.
{% if attempt %}
This is retry/continuation attempt {{ attempt }}.
- Re-review the latest PR state instead of assuming your earlier findings still apply.
- Check existing branch/PR state with `gh` before posting another review.
- Avoid duplicating comments when a previous finding is already addressed or already recorded, and
  update the existing Baton reviewer summary comment instead of posting a new one.
{% endif %}
