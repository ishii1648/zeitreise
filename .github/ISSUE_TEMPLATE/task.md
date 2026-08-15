---
name: Task
about: codex-issue-loop へ投入する前に triage で整形する開発タスク
title: ""
labels: triage
---

<!-- LOOP-META
depends-on: []
ordinal: null
-->
<!--
LOOP-META は producer が依存解決を判定するための YAML 断片。
codex-issue-loop 自体はこの断片を解釈しない。
- depends-on: 依存 Issue の配列。例: depends-on: ["#12", "#34"]
  （YAML では # がコメント開始になるため必ずクォートする）
- ordinal: legacy metadata。codex-issue-loop v0.2 の選択順には影響しない
本文の規約:
- Implementation Plan / Notes / Final Summary は本文ではなくコメントに投稿する
- AC は「- [ ] AC1 ...」形式で連番を振る（#N 形式は Issue リンクに化けるため禁止）
- area ラベル（area:*）を 1 つ以上付与する（development-style.md 4.2 章）
- 起票後に内容と依存関係を確認し、triage を ready / blocked / needs-human /
  do-not-automate のいずれかへ置き換える
-->

## Description

（背景・確定事項・スコープ外を書く）

## Acceptance Criteria

<!-- AC 記法: `- [ ] AC1 ...`。`#N` 形式は禁止（Issue リンクに化ける） -->

- [ ] AC1
- [ ] AC2
