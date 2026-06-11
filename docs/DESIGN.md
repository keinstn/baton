# Baton 実装設計書

Status: Draft v1

本書は [SPEC.md](SPEC.md) を TypeScript で実装するための設計判断をまとめたもの。仕様(何を満たすか)は
SPEC.md が規範であり、本書は「どう作るか」を扱う。

## 1. アーキテクチャ概要

Symphony のアーキテクチャ(Symphony SPEC §3)をそのまま流用し、アダプタ2層だけを差し替える。

```
┌────────────────────────────────────────────────┐
│ Orchestrator(ポーリング/claim/retry/reconcile) │ ← Symphony SPEC §7-8 を無修正で実装
├──────────────────┬─────────────────────────────┤
│ Tracker Adapter  │ Agent Runner                │
│ GitHub Projects  │ Claude Code (Agent SDK)     │ ← Baton で新規実装する2層
│ v2 GraphQL       │ / Copilot CLI               │
└──────────────────┴─────────────────────────────┘
```

- オーケストレーション層(tick ループ、状態機械、retry/backoff、reconciliation、workspace 安全性)は
  Symphony SPEC の意味論を変えない。Symphony の運用経験がそのまま通用することを設計原則とする。
- 差分の全量は SPEC.md Appendix B のマッピング表を参照。

## 2. Tracker: Linear → GitHub Projects v2 マッピング

| Symphony の概念 | Baton (GitHub Projects v2) |
|---|---|
| `tracker.project_slug` | `owner` + `project_number` → ProjectV2 node ID に解決してキャッシュ |
| Issue state | Project の Status フィールド(single-select)のオプション名 |
| `issue.id` | Issue node ID(`I_...`)。加えて ProjectV2Item ID(`PVTI_...`)を `item_id` として保持 |
| `issue.identifier` | `<repo>-<issue番号>`(例 `myrepo-123`)→ workspace ディレクトリ名 |
| `labels` / `priority` | Issue labels / OPTIONAL な Priority single-select フィールドの選択肢順位 |
| `blocked_by` | GitHub issue dependencies("blocked by")。API 不可時は `[]` に縮退 |
| チケット書き込み | エージェント自身が `gh` CLI で実行(コメント、`gh project item-edit`、`gh pr create`)。オーケストレータは読み取り専用 |

実装メモ:

- 認証: fine-grained PAT または GitHub App。オーケストレータは Projects read のみで動く。
- レート制限: GraphQL 5,000 pt/h。30 秒ポーリング 1 プロジェクトなら数 pt/tick で余裕。
  `rateLimit { remaining resetAt }` をデバッグログに出す。
- items connection にはサーバーサイドの Status フィルタがないため、ページを取り切ってから
  クライアント側でフィルタする(SPEC §11.2)。
- webhook(`projects_v2_item`)は「即時 refresh トリガー」のオプション拡張に留め、ポーリングを
  真実の源とする(SPEC §13.7)。

## 3. Agent: Codex app-server → Claude Code / Copilot CLI マッピング

Symphony 実装の最大の難所だった app-server プロトコル(Symphony SPEC §10、全体の約 1/4)は、
Claude Code では Claude Agent SDK のライブラリ呼び出しに置き換わる。これが言語選定(§5)の決め手。

| Symphony の要件 | Baton (Claude Code) |
|---|---|
| app-server 起動 / thread 作成 | Agent SDK `query()`(または `claude -p --output-format stream-json`)を workspace cwd で起動 |
| `thread_id` + continuation turn | init メッセージの `session_id` + resume オプションで同一セッション継続 |
| `max_turns` | worker ループで `agent.max_turns` を強制(SPEC §16 worker algorithm) |
| approval / sandbox policy | `permission_mode`(既定 `acceptEdits`)+ `allowed_tools` / `disallowed_tools` |
| ストリーミングイベント / usage | stream-json の assistant / tool_use / result メッセージ。result の usage → token accounting(SPEC §13) |
| stall / turn timeout | オーケストレータ側のイベント無活動タイマー(変更なし) |

`AgentRunner` インターフェース(SPEC §10.0: `start_session` / `run_turn` / `stop_session`)を切り、

- `claude-code.ts` — 第一級アダプタ。SDK モードを推奨、CLI subprocess モードもサポート。
- `copilot.ts` — 第二アダプタ。`copilot -p` + `--allow-tool`/`--deny-tool`。イベントが粗いため
  正規化イベント(§10.0)への変換と stall 検知用ハートビートを必須とする。

の 2 実装を提供する。

## 4. WORKFLOW.md の例

```yaml
---
tracker:
  kind: github_projects
  owner: my-org
  project_number: 5
  token: $GITHUB_TOKEN
  status_field: Status
  active_states: [Todo, In Progress]
  terminal_states: [Done]
  required_labels: [ai-ready]        # 暴発・プロンプトインジェクション対策の主ゲート
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
claude_code:
  permission_mode: acceptEdits
  allowed_tools:
    - "Bash(gh:*)"
    - "Bash(git:*)"
    - "Bash(npm:*)"
    - Edit
    - Write
---

You are working on GitHub issue {{ issue.repository }}#{{ issue.number }}: {{ issue.title }}.

{{ issue.description }}

Rules:
- Work only inside this workspace. Create a branch, implement, and run the tests.
- Report progress with `gh issue comment {{ issue.number }} --repo {{ issue.repository }}`.
- When done, open a PR with `gh pr create` linking the issue, then move the issue's
  Status to "In Review" with `gh project item-edit`.
{% if attempt %}
This is retry/continuation attempt {{ attempt }}. Check existing branch/PR state with
`gh` before redoing work.
{% endif %}
```

## 5. 実装言語: TypeScript(Node.js 20+)

| 観点 | TypeScript | Python | Go | Elixir |
|---|---|---|---|---|
| Claude Agent SDK | ◎ 第一級 | ◎ あり | ✕(CLI 直叩き) | ✕ |
| GitHub GraphQL | ◎ `@octokit/graphql` | ○ | ○ | ○ |
| 並行オーケストレータ | ○ async + 単一状態 | ○ asyncio | ◎ goroutine | ◎ OTP(参照実装あり) |
| 配布 | △(Bun single-file 可) | △ | ◎ 単一バイナリ | △ |

決め手は Agent Runner 層のコスト。Go は運用面で優れるが stream-json パースとセッション管理の自作が
必要で MVP が遠い。Elixir は Symphony 参照実装の移植としては最短だが、tracker/agent 両方を書き直す
以上 SDK のある言語が有利。

主要依存(最小):

- `@anthropic-ai/claude-agent-sdk` — Claude Code セッション
- `@octokit/graphql` — GitHub GraphQL
- `yaml` — front matter、`liquidjs` — strict プロンプトレンダリング(SPEC §5.4)
- `pino` — 構造化ログ
- `chokidar` — WORKFLOW.md watch(ホットリロード、SPEC §6.2)
- (Phase 3)`fastify` 等 — HTTP 拡張

## 6. モジュール構成

```
src/
  cli.ts                 # `baton [WORKFLOW.md] [--port N]`(SPEC §17.7)
  workflow/loader.ts     # front matter + prompt 分離、watch + ホットリロード(§5, §6.2)
  config/schema.ts       # 型付き getter、デフォルト、$VAR 解決、preflight 検証(§6)
  orchestrator/
    orchestrator.ts      # tick ループ、running/claimed/retry_attempts の単一状態(§7-8, §16)
    retry.ts             # バックオフ計算とタイマー(§8.4)
    reconcile.ts         # stall 検知 + tracker state refresh(§8.5)
  tracker/
    types.ts             # Issue 正規化モデル(§4.1.1)
    github-projects.ts   # GraphQL 3操作 + project/field 解決キャッシュ + ページネーション(§11)
  workspace/
    manager.ts           # sanitize、root 封じ込め、作成/掃除(§9)
    hooks.ts             # bash -lc 実行、timeout、BATON_* env(§5.3.4)
  agent/
    runner.ts            # AgentRunner インターフェース(§10.0)
    claude-code.ts       # Agent SDK アダプタ(§10.1)
    copilot.ts           # Copilot CLI アダプタ(§10.2)
  prompt/builder.ts      # LiquidJS strict mode(§12)
  observability/
    logger.ts            # 構造化ログ(§13.1)
    http.ts              # 任意: /api/v1/state ほか(§13.7)
test/                    # SPEC §17 のマトリクスに対応(tracker/agent はモック)
```

中核コードのスケッチ(worker ループ、SPEC §16 準拠):

```typescript
// agent/claude-code.ts
import { query } from "@anthropic-ai/claude-agent-sdk";

async function runAttempt(issue: Issue, workspace: string, prompt: string, onEvent: EventCb) {
  let sessionId: string | undefined;
  for (let turn = 1; turn <= cfg.agent.maxTurns; turn++) {
    const q = query({
      prompt: turn === 1 ? prompt : continuationGuidance(issue, turn),
      options: {
        cwd: workspace,                        // 不変条件1: cwd = workspace(§9.5)
        resume: sessionId,                     // 同一セッション継続(§10.1)
        permissionMode: cfg.claudeCode.permissionMode,
        allowedTools: cfg.claudeCode.allowedTools,
      },
    });
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") sessionId = msg.session_id;
      onEvent(normalize(msg));                 // usage / last_event を orchestrator へ(§13)
    }
    const [state] = await tracker.fetchIssueStatesByIds([issue.id]);  // ターン後再確認(§7.1)
    if (!isActive(state)) break;
  }
}
```

注: Agent SDK のオプション名は実装時に SDK の型定義で確認すること(上記は設計時点のスケッチ)。

## 7. 段階実装計画

**Phase 1 — MVP**

1. workflow loader + config layer(§5-6)
2. GitHub Projects クライアント 3 操作(§11.1)
3. オーケストレータ: tick → 検証 → 候補取得 → ソート → dispatch(§8.1-8.3)
4. workspace manager + `after_create`/`before_run` フック(§9)
5. Claude Code アダプタ(1 issue = 1 セッション、まず resume なしの単発ターン)
6. 構造化ログ(§13.1)

**Phase 2 — 耐障害性(SPEC §18.1 Core Conformance 完了)**

- 継続ターン(resume)+ 正常終了後 1 秒 continuation retry(§7.1)
- 指数バックオフ retry(§8.4)、reconciliation(§8.5)、stall 検知
- WORKFLOW.md ホットリロード(§6.2)、起動時 terminal workspace 掃除(§8.6)
- §17.1-17.4 のテスト整備

  > **ホットリロードのスコープ制限(Phase 2時点):**
  > `tracker.*`・`polling.*`・`agent.*`・プロンプトテンプレートの変更は次 tick から反映される。
  > `claude_code.*` と `workspace.*`(root・hooks)の変更はプロセス再起動が必要。
  > これらは `ClaudeCodeRunner` と `WorkspaceManager` がコンストラクタで設定を固定しているため。
  > Phase 3 で両クラスに `applyConfig` を追加して対応予定。

**Phase 3 — 拡張(SPEC §18.2)**

- Copilot アダプタ ✅ (`src/agent/copilot.ts`、`-p` argv + `--output-format json` JSONL、`--session-id`/`--resume` で継続ターン、resume 失敗時は同ターン内で fresh-session フォールバック、token usage は SPEC §10.2 通り 0 報告)
- state 別並列度 ✅ (Phase 2 で実装済み: `agent.max_concurrent_agents_by_state`)
- HTTP ダッシュボード(`/api/v1/state` 等)+ webhook refresh トリガー
- Real Integration Profile(§17.8)のスモークテスト

## 8. セキュリティ方針(要約)

SPEC §15 参照。運用上の要点:

- public リポジトリの issue 本文は信頼できない入力。`required_labels`(メンテナのみ付与可能な
  ラベル)を必須ゲートにする。
- `allowed_tools` は最小限(`gh`/`git`/ビルドコマンド + Edit/Write)。`bypassPermissions` /
  `allow_all_tools` は明示的なオプトインのみ。
- token は fine-grained PAT で対象リポジトリに限定。ブランチ保護 + PR 必須レビューで
  エージェントの変更が無審査でマージされない構成にする。
