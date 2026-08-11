---
name: codex-agent-loop
description: Claude Fable 5 mainagent が GitHub Issue の選定、レビュー、PR、CI、マージを統括し、実装を Codex CLI の gpt-5.6-sol worker へ委譲するローカル自律ループ。ユーザーが /codex-agent-loop を実行したとき、または Codex 実装 worker を使う自律タスクループの開始・再開を指示したときに使う。
---

# codex-agent-loop — Codex 実装 worker 版の自律タスクループ

Claude mainagent が外側ループとレビューを担当し、実装だけを Codex CLI の
`gpt-5.6-sol` worker へ委譲する。

## 実行手順

開始時に [references/loop-procedure.md](references/loop-procedure.md) を**全文読み**、
記載された手順、停止条件、ガード、返却インターフェースをそのまま実行する。
別の loop skill を読み込んだり、slash command として呼び出したりしない。

bundled runner は
[scripts/run-codex-worker.sh](scripts/run-codex-worker.sh) を使う。runner の内容を
場当たり的な `codex exec` コマンドで複製しない。

## 開始前の前提

1. 外側セッションを `claude --model claude-fable-5` で起動していることを確認する。
2. `command -v codex` と `codex login status` が成功することを確認する。
3. `codex exec --help` に `--model`、`--sandbox`、`--ephemeral`、
   `--output-last-message` があることを確認する。
4. 単一セッションガードを確認する。

前提を満たさない場合、Claude native 実装 subagent へ黙ってフォールバックしない。
原因と必要な操作を報告し、loop procedure のエスカレーション規則に従う。
