---
name: codex-agent-loop
description: 既存の agent-loop を変更せず、その全手順を継承して実装 subagent だけを Codex CLI の GPT-5.6 Sol worker へ差し替えるローカル自律ループ。ユーザーが /codex-agent-loop を実行したとき、Claude Fable 5 を mainagent、gpt-5.6-sol を実装 worker として GitHub Issue の連続処理を開始・再開するときに使う。
---

# codex-agent-loop — Codex 実装 worker 版の自律タスクループ

Claude mainagent が外側ループとレビューを担当し、実装だけを Codex CLI の
`gpt-5.6-sol` worker へ委譲する。既存 `/agent-loop` のファイルと挙動は変更しない。

## 基準手順を読み込む

開始時に `.claude/skills/agent-loop/SKILL.md` を**全文読み込み**、そこに定義された
ループ手順、停止条件、ガード、返却インターフェースを基準として実行する。
`/agent-loop` 自体を slash command として再呼び出してはならない。

本 skill が上書きするのは、基準手順のうち次の箇所だけである。

- 手順 2 の実装 subagent
- mainagent の diff レビュー後に必要となった追加実装
- 手順 3 の CI red 修正で、コード変更を再委譲する場合の実装 subagent

CI red の原因調査、マージ後の動作確認、bug intake の重複確認・本文起草など、
**読み取り専用 subagent は基準手順どおり Claude Code native Agent を使う**。
GitHub 操作、claim、ブランチ管理、レビュー、成果取り込み、テストの最終確認、
CI 監視、マージ、finalization、後始末、上限カウンタ追跡は mainagent に残す。

## 前提を確認する

1. 外側セッションを `claude --model claude-fable-5` で起動していることを確認する。
2. `command -v codex` と `codex login status` が成功することを確認する。
3. `codex exec --help` に `--model`、`--sandbox`、`--ephemeral`、
   `--output-last-message` がある現在の CLI であることを確認する。
4. 基準手順の単一セッションガードを確認する。

前提を満たさない場合、Claude native 実装 subagent へ黙ってフォールバックしない。
原因と必要な操作を報告し、基準手順のエスカレーション規則に従う。

## Codex 実装 worker を起動する

### 1. 専用 worktree を用意する

mainagent がタスクブランチから worker ごとの linked worktree を作る。worktree は
`.claude/worktrees/` 配下、ブランチは `worktree-agent-*` とし、既存の後始末
スクリプトが安全に認識できる名前にする。

```bash
git worktree add \
  -b worktree-agent-codex-<issue>-<slot> \
  .claude/worktrees/codex-<issue>-<slot> \
  issue-<issue>-<slug>
```

作成前に `git worktree list --porcelain` と `git branch --list` で、対象 path と
branch が未使用であることを確認する。並列実装では `<slot>` を分け、各 worker を
同じタスクブランチの同じ tip から作る。

### 2. prompt と返却先を repo 外へ作る

prompt file と result file は `/tmp` 配下の task 固有ディレクトリへ置き、
再試行を含む worker 実行ごとに一意なファイル名を使う。
heredoc や shell の文字列展開で prompt を組み立てず、Write ツールで作成する。
prompt に最低限、次を含める。

- Issue 本文、Acceptance Criteria、実装プラン
- worker の担当範囲と変更可能なファイル。並列時は他 worker の担当範囲も示す
- リポジトリ規約と、テスト先行で red を確認してから green にする指示
- `commit`、`push`、`gh`、PR/Issue 操作、worktree 作成・削除を禁止する指示
- 担当外の既存変更を戻さず、main/default branch を編集しない指示
- 必要なローカル検証を実行する指示。基準手順に従いテストは
  `deno task test:quiet` を使う
- 最終報告の必須項目: 変更ファイル、red の証拠、green の証拠、残課題、
  mainagent に確認してほしい判断

### 3. bundled runner で実行する

```bash
bash .claude/skills/codex-agent-loop/scripts/run-codex-worker.sh \
  --worktree /absolute/path/to/.claude/worktrees/codex-<issue>-<slot> \
  --prompt-file /tmp/<task>/worker-<slot>.md \
  --result-file /tmp/<task>/worker-<slot>-result.md
```

runner は次を固定する。

- model: `gpt-5.6-sol`
- sandbox: `workspace-write`
- session: `--ephemeral`
- cwd: mainagent が検証済みの linked worktree
- 親へ戻す通常出力: 完了通知と result file の path のみ

Codex の詳細ログは `<result-file>.log` に隔離する。成功時は result file だけを読み、
ログを親コンテキストへ入れない。失敗時だけ runner が出す末尾の診断を読む。

独立サブ作業が 2 つ以上ある場合は、基準手順の分担表どおり複数 runner を Bash の
background execution で起動する。foreground の sleep で待たず、各 background
task の完了通知を待つ。

### 4. mainagent が成果をレビューして取り込む

各 worker の result file と worktree の diff を mainagent 自身が確認する。
外部 Codex にレビューを委譲してはならない。基準手順の「subagent の成果の
取り込みと worktree の復元」に従い、binary を含む staged patch をタスク
ブランチへ適用してから、担当範囲、AC、TDD、既存変更の保持をレビューする。

指摘があれば同じ worktree に修正 prompt を新しく作り、runner を再実行する。
ephemeral worker の会話継続には依存せず、修正 prompt に前回結果、mainagent の
指摘、未解決事項を明記し、新しい result file を指定する。各 runner 実行を
基準手順の「実装 subagent 試行回数」に 1 回として数える。

レビューが収束したら mainagent が標準チェックを実行する。その後の PR、CI、
finalization、マージ、動作確認、後始末は基準手順へ戻る。

## 失敗を扱う

- runner が worktree、branch、prompt、result path の検証で失敗したら、対象を
  広げたり検証を外したりせず mainagent が入力を直す。
- Codex が非ゼロ終了したら `<result-file>.log` の runner が提示した末尾だけで
  原因を切り分ける。認証・モデル利用不可は環境ブロックとして扱う。
- result file が空または返却項目不足なら実装完了とみなさず、修正 prompt で
  再実行する。
- 同じ失敗の反復、試行回数、経過時間、CI red は基準手順の定量上限に含める。

## 不変条件

- `.claude/skills/agent-loop/SKILL.md` を変更しない。
- 1 タスク = 1 PR、claim タグ CAS、bug 最優先、イテレーション境界を維持する。
- Codex worker に commit、push、GitHub 書き込み、レビューをさせない。
- mainagent のレビューを通さず worker の変更を push しない。
