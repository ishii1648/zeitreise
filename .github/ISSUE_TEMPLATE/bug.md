---
name: Bug
about: 動作確認・レビュー・ユーザー報告で見つけた問題（1 件 = 1 Issue）
title: ""
labels: triage, bug
---

<!-- LOOP-META
depends-on: []
ordinal: null
-->
<!--
LOOP-META は producer が依存解決を判定するための YAML 断片
（書式は task テンプレート参照）。codex-issue-loop 自体は解釈しない。
`bug` と ordinal は codex-issue-loop v0.2 の選択順には影響しない。
複数の問題を 1 Issue にまとめない（1 件 = 1 Issue）。
-->

## Description

### 再現手順

1.

### 期待挙動

### 実際の挙動

### 発見契機

（どのタスクの動作確認 / どのレビュー / どの報告で見つけたか）

## Acceptance Criteria

<!-- AC 記法: `- [ ] AC1 ...`。`#N` 形式は禁止（Issue リンクに化ける） -->
<!-- 描画など自動テストで再現できない場合に限り「目視確認」AC で代替する -->

- [ ] AC1 問題を再現するテスト（red）が追加されている
- [ ] AC2 修正によりテストが green になる
