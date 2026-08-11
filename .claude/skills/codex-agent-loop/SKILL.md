---
name: codex-agent-loop
description: GitHub Issue のタスクを選定して実装・PR・CI・finalization を繰り返し、リポジトリの実装作業を Codex CLI worker へ委譲する自律ループ。ユーザーが /codex-agent-loop を実行したとき、または実装を Codex に任せるタスクループの開始・再開を指示したときに使う。任意の Codex model ID を引数で指定できる。
---

# codex-agent-loop

GitHub Issue を順に処理し、**リポジトリの実装は必ず Codex CLI worker に行わせる**。
管理セッションはタスク選定、計画、レビュー、GitHub 操作、CI 監視、マージ、
後始末だけを担う。管理セッション自身の model は問わない。

## Model を決める

slash command の引数またはユーザーの指示に Codex model ID があれば、その値を
変更せず worker の `--model` へ渡す。指定がなければ `gpt-5.6-sol` を使う。
model の family、version、tier をこの skill で制限しない。

例:

```text
/codex-agent-loop gpt-5.6-luna
/codex-agent-loop gpt-5.6-sol
/codex-agent-loop gpt-5.5
```

開始前に `command -v codex`、`codex login status`、`codex exec --help` を確認する。
利用できない場合は別の実装手段へフォールバックせず、原因を報告して停止する。

## Loop

1. **タスクを選ぶ**
   - `git ls-remote origin 'refs/tags/claim/issue-*'` で進行中 claim を確認し、
     このセッションが再開できるタスクがあれば先に続行する。
   - 進行中タスクがなければ `deno task next-tasks` で次の集合を取得する。
   - 集合が空なら完了レポートを出して停止する。
2. **タスクを開始する**
   - `git push origin main:refs/tags/claim/issue-<N>` で claim する。拒否された
     Issue は触らない。
   - `status:in-progress` を付け、並列化判定を含む Implementation Plan を Issue
     コメントへ投稿する。
   - `issue-<N>-<slug>` を main から作る。1 タスク = 1 branch = 1 PR を守る。
3. **Codex に実装させる**
   - 実装、テスト追加、ドキュメント変更、レビュー後の修正、CI red の修正は
     すべて Codex worker へ委譲する。管理セッションが直接編集しない。
   - 独立した作業は worker ごとに分担し、専用 linked worktree で並列実行する。
   - worker の result と diff を管理セッションがレビューし、問題があれば新しい
     prompt で Codex worker に修正させる。
4. **検証して PR を完了する**
   - `deno task fmt:ci --check`、`deno lint`、`deno task test:quiet`、
     `deno task build` を green にする。修正が必要なら Codex worker へ戻す。
   - `Closes #<N>` を含む PR を作り、CI と mergeability を監視する。
   - CI green 後に AC、Implementation Notes、必要な ADR を finalization し、
     マージする。
   - `deno task cleanup-branches --apply` と `deno task loop-doctor` を実行する。
5. **次へ進む**
   - 動作確認で見つけた問題は `task-intake` の形式で bug Issue にする。
   - 曖昧な仕様、権限不足、同じ失敗の反復、または
     `docs/development-style.md` 4.4.1 の上限超過時だけ `needs-human` を起票して
     停止する。それ以外は手順 1 へ戻る。

## Codex worker を実行する

worker ごとに未使用の branch と worktree を作る。

```bash
git worktree add \
  -b worktree-agent-codex-<issue>-<slot> \
  .claude/worktrees/codex-<issue>-<slot> \
  issue-<issue>-<slug>
```

prompt と result file は `/tmp` 配下に実行ごとの一意な名前で作る。prompt には
Issue、AC、担当範囲、変更可能ファイル、TDD、必要な検証と次を含める。

- commit、push、`gh`、worktree 操作をしない
- main/default branch と担当外ファイルを変更しない
- 変更ファイル、red/green の証拠、残課題を最終報告する

選んだ model を runner へ渡す。

```bash
bash .claude/skills/codex-agent-loop/scripts/run-codex-worker.sh \
  --model <codex-model-id> \
  --worktree /absolute/path/to/.claude/worktrees/codex-<issue>-<slot> \
  --prompt-file /tmp/<task>/worker-<slot>-<attempt>.md \
  --result-file /tmp/<task>/worker-<slot>-<attempt>-result.md
```

runner は `workspace-write` sandbox、ephemeral session、worktree lock、repo 外の
result/log を強制する。成功時は result file と worktree の diff だけを確認する。
成果は binary staged patch としてタスクブランチへ適用し、レビュー後に worker
worktree を元へ戻す。Codex worker に commit、push、GitHub 操作、レビューを
させない。

## ガード

- 実装を管理セッションや Claude native subagent にフォールバックしない。
- 1 タスク = 1 PR と claim タグによる二重着手防止を維持する。
- worker の変更は管理セッションのレビューと標準チェックを通してから push する。
- foreground の sleep で worker や CI を待たない。
