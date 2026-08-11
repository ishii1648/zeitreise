<CRITICAL_INSTRUCTION>

## GitHub Issue Workflow

This project uses GitHub Issues for task management (migrated from Backlog.md;
see `docs/adr/0031-migrate-task-management-to-github-issues.md`).

- Tasks are GitHub Issues with the `task` label. Read them with
  `gh issue view <N>` / `gh issue list`; candidate selection is
  `deno task next-tasks` (single: `deno task next-task`).
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
- Task state: open = To Do, open + `status:in-progress` label = In Progress,
  closed = Done (closed as not planned = cancelled).

</CRITICAL_INSTRUCTION>

## タスク駆動開発（GitHub Issue）

- ブランチ名には Issue 番号を含める: `issue-N-slug`（例:
  `issue-160-deno-setup`）。これによりブランチからタスク Issue
  へ常に追跡できるようにする（旧 backlog 時代の `task-N-*` は TASK-N 由来。
  アーカイブ側の README で対応が引ける）。
- タスク Issue の依存関係（本文 LOOP-META の `depends-on`）順に厳密に作業する。
  あるタスクの依存 Issue が全てクローズされるまでは着手しない。タスク間の
  並列実行は `deno task next-tasks` が返す「area が互いに素なタスク集合」に
  限り許可する （`docs/development-style.md` 4.2 章）。各タスクのステータス
  遷移（`In Progress` → `Done`）の一意性は並列時も維持する。
- PR タイトル・説明には Issue 番号（`#N`）を明記し、レビュー履歴がタスク Issue
  と紐づくようにする。
- TDD は必須: 実装より先にテストを書き、red（失敗）を確認してから green
  にする。詳細は `docs/development-style.md` を参照。
- エージェント分担: 実装は subagent に委譲し、レビューは mainagent
  自身が行う。codex など外部エージェントによるレビューは行わない。
- default branch（main）上で作業しない。編集・コミットは必ず作業ブランチで行い、
  main への反映は常に PR 経由とする。
- 並列化判定は二層で行う。**タスク間並列**: `deno task next-tasks` の集合判定で
  area（`area:<領域>` ラベル）が互いに素なタスク群は同時に実装してよい （1
  タスク = 1 PR・bug 最優先は維持）。area が交差する・未付与・候補が 1
  件のみの場合は従来どおり直列にフォールバックする。**タスク内並列**:
  タスク内で並列作業が可能な場合は作業効率を上げるため subagent を並列に
  複数起動する。可否の判定は実装プラン記録時に必須で行い、判定結果と根拠
  （見送りの場合は理由）をプランに記録する。いずれの並列でも subagent 同士の
  衝突を避けるため worktree isolation を利用し、成果物の conflict は PR で
  解消する。
- 標準タスクフロー: `deno task next-tasks` で着手可能なタスク集合を判定 →
  集合内の各タスクごとにブランチ作成（main から分岐）→
  タスク内並列化判定（実装プランに記録）→ テスト先行 → 実装 （subagent
  に委譲、並列可なら複数起動）→ `deno test` green → mainagent
  によるレビューで収束 → 個別 PR 作成（Issue 番号明記）→ CI green → マージ →
  マージ後動作確認 → finalization（AC チェック・Issue クローズ。ループ内の
  詳細手順は `.claude/skills/agent-loop/SKILL.md`）。集合が単一タスクなら従来の
  直列フローと同一。動作確認で見つけた問題は label `bug` 付き Issue として
  task-intake スキルで起票し、次イテレーションで最優先修正する（直接 hotfix
  しない）。
- タスクは Acceptance Criteria が全てチェック済みかつ CI が green の場合にのみ
  Done（Issue クローズ）となる。
- 次タスクの選択は人の指名ではなく決定的ルールで行う: open（`In Progress`
  ラベルなし）かつ依存 Issue が全てクローズ済みのタスクのうち `ordinal`
  最小（LOOP-META で未指定なら Issue 番号）のものを選ぶ（`In Progress`
  のタスクが残っている間は選ばない）。ただし label `bug` を持つタスクは
  `ordinal` に関わらず最優先で選ぶ（bug 群内は ordinal → ID 順）。判定は
  `deno task next-tasks`（area が互いに素な集合を
  同じ優先順の貪欲選択で返す。単一選択の `deno task next-task` も互換維持）を
  使う。外側ループはローカルの Claude Code セッションで `/agent-loop`
  スキル（`.claude/skills/agent-loop/SKILL.md`）を実行して
  回し、マージ後も同一セッションが次タスクを継続する（herdr 配下では、
  イテレーション境界でコンテキストを投棄して supervisor が `/agent-loop` を
  再投入する supervisor モードを標準とする。ADR-0036・
  `docs/development-style.md` 4.3 章）。CI や PR のステータスは Monitor ツールや
  PR activity 購読で監視する。詳細は `docs/development-style.md` の 4 章を参照。
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
