<CRITICAL_INSTRUCTION>

## GitHub Issue Workflow

This project uses GitHub Issues for task management (migrated from Backlog.md;
see `docs/adr/0031-migrate-task-management-to-github-issues.md`).

- `codex-issue-loop` is the only autonomous Issue executor. Do not start the
  legacy `.claude/skills/agent-loop` or `.claude/skills/codex-agent-loop` loops
  while the LaunchAgent is registered.
- An Issue enters the execution queue only when it has `codex-loop:ready`. Add
  it only after the body and Acceptance Criteria are complete, every
  `LOOP-META depends-on` Issue is closed or has `codex-loop:done`, and no human
  decision or time-based prerequisite remains. `codex-issue-loop` does not parse
  `LOOP-META`.
- Create or formalize an Issue under `triage` first. After validation, remove
  `triage` and add exactly one admission label: `codex-loop:ready` when it can
  start now, `blocked` for an unresolved dependency or external condition,
  `needs-human` for a required user decision, or `do-not-automate` when it must
  never be executed automatically.
- Never add, remove, or repurpose `codex-loop:running`,
  `codex-loop:needs-input`, `codex-loop:failed`, or `codex-loop:done`; they are
  owned by the `codex-issue-loop` supervisor. The legacy `task` and
  `status:in-progress` labels must not be added to new Issues.
- When an Issue is closed or receives `codex-loop:done`, re-evaluate open
  `blocked` Issues that depend on it. Promote an Issue to `codex-loop:ready`
  only after all dependencies and other prerequisites are satisfied.
- Create tasks with the `task-intake` skill
  (`.claude/skills/task-intake/SKILL.md`): duplicate check via one
  `gh issue list --state all --json number,title,labels,body` call + local
  matching, then `gh issue create --body-file <path>` following
  `.github/ISSUE_TEMPLATE/task.md` (LOOP-META, `AC1` notation, area labels).
  Never pass issue bodies as inline shell arguments (backtick command
  substitution destroys them).
- Do not use the `backlog` CLI. Archived Backlog.md tasks live frozen in
  `docs/archive/backlog-tasks/` (index in its README); read them for history,
  never edit or revive them there.
- Task state is represented by the `codex-loop:*` labels and durable supervisor
  state. A closed Issue is terminal; closing as not planned means cancelled.

</CRITICAL_INSTRUCTION>

## タスク駆動開発（GitHub Issue）

- ブランチ名には Issue 番号を含める: `issue-N-slug`（例:
  `issue-160-deno-setup`）。これによりブランチからタスク Issue
  へ常に追跡できるようにする（旧 backlog 時代の `task-N-*` は TASK-N 由来。
  アーカイブ側の README で対応が引ける）。
- タスク Issue の依存関係（本文 LOOP-META の `depends-on`）順に厳密に作業する。
  依存 Issue が全てクローズされるか `codex-loop:done` になるまでは
  `codex-loop:ready` を付けない。現行の `codex-issue-loop` は 1 worker で Issue
  を直列実行するため、旧 `deno task next-tasks` による Issue 間並列化は
  行わない。
- PR タイトル・説明には Issue 番号（`#N`）を明記し、レビュー履歴がタスク Issue
  と紐づくようにする。
- TDD は必須: 実装より先にテストを書き、red（失敗）を確認してから green
  にする。詳細は `docs/development-style.md` を参照。
- エージェント分担: 実装は subagent に委譲し、レビューは mainagent
  自身が行う。codex など外部エージェントによるレビューは行わない。
- default branch（main）上で作業しない。編集・コミットは必ず作業ブランチで行い、
  main への反映は常に PR 経由とする。
- Issue 間の並列実行は行わない。1 Issue の内部で互いに独立した作業がある場合
  に限り、worker は安全性を確認したうえで subagent を利用してよい。area label
  は担当領域を示すものであり、現行 v0.2 の queue 順や並列度は変更しない。
- 標準タスクフロー: producer が Issue を `triage` で起票・整形 → 依存関係と
  着手条件を検証 → `triage` を外して `codex-loop:ready` を付与 → Mac mini の
  `codex-issue-loop` が claim・worktree・Codex worker・検証・commit・push・draft
  PR 作成を担当する。Claude は supervisor 所有の状態 label を操作しない。
  動作確認で見つけた問題は label `bug` 付き Issue として task-intake スキルで
  起票し、直接 hotfix しない。
- タスクは Acceptance Criteria が全てチェック済みかつ CI が green の場合にのみ
  Done（Issue クローズ）となる。
- 次タスクは`.agent-loop.yaml`に従い、`codex-loop:ready`を持つIssueから
  `issue_number_asc`で決定的に選ばれる。`LOOP-META`、`ordinal`、`bug`、area
  labelはv0.2のqueue順を変更しない。依存解決と優先投入が必要な場合はproducerが
  ready labelを付ける前に判断する。
- 人の介入は例外時のみ: AC が曖昧・CI が恒常 red・仕様判断が必要な場合に限り
  `needs-human` ラベル付き issue を起票して停止し、判断を仰ぐ。それ以外で人の
  指示を待たない。加えて、CI red 連続回数・実装 subagent 試行回数・タスク
  着手からの経過時間・停滞検出のいずれかが定量上限を超えた場合も強制的に
  エスカレーションする（上限値は `docs/development-style.md` 4.4.1 章を参照）。

## 調査ドキュメントの出力先

グローバル設定（`~/.claude/CLAUDE.md`）は調査結果を `.outputs/claude/` へ出力
すると定めるが、**本プロジェクトでは以下を優先する**（グローバル側もプロジェクト
CLAUDE.md の指定を優先すると定めている）。

- **判断根拠になる一次調査レポートは `docs/research/` にコミットする。** 方針の
  採否・起票根拠・実測に基づく現状分析など、他の docs / Issue / ADR が根拠として
  指すものが該当する。置くもの・置かないもの・命名規約・他ディレクトリとの
  棲み分けは `docs/research/README.md` を参照（規約本体は
  `docs/development-style.md` 2.2 章）。
- **再生成可能な中間生成物は従来どおり `.outputs/claude/` でよい。** スクリプト
  1 コマンドで作り直せる出力（`deno task audit-attribution` /
  `deno task audit-rivers` のレポート、検証スクリーンショット、ダウンロード
  キャッシュ、巨大なダンプ）が該当する。ただし docs から参照する場合は
  **生成コマンドを併記**し、パスだけを指す参照を残さない。
- 理由: `.outputs/` は git 管理外（global gitignore）で worktree の後始末と
  ともに消える。実際にコミット済みの docs が消失したレポートを参照する状態に
  なっていた（Issue #204）。失われた分の結論の所在は `docs/research/README.md`
  の「失われた調査レポート」節にまとめてある。
- 決定そのものは ADR（`docs/adr/`）、データの性質・欠落・監査結果は台帳
  （`docs/data-inventory/`）が正であり、`docs/research/` はその根拠となる調査の
  記録を置く場所である。
