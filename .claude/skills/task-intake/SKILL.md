---
name: task-intake
description: ユーザーの依頼内容から GitHub Issue 運用ルールに沿ったタスクを起票する skill。「起票して」「タスク作成して」「タスク化して」等、タスク Issue の新規作成が必要なときに使う。
---

# task-intake — GitHub Issue タスク起票

ユーザーの依頼（機能要望・bug 報告・改善アイデア等）を、プロジェクトの運用
ルール（`docs/development-style.md`・`.github/ISSUE_TEMPLATE/task.md`）に 沿った
GitHub Issue として起票する。以下の手順を上から順に実行する。 タスク管理は
backlog.md から GitHub Issue へ移行済み（`docs/adr/0031`）。 `backlog` CLI
は使わない。

## 1. 重複確認（起票前に必須）

同じ内容の Issue が既に存在しないかを必ず確認してから起票する。 **search API
は使わない**（30 req/min 制限）。issue list を 1 コールだけ叩き、
ローカルでマッチする。

```bash
gh issue list --state all --limit 1000 \
  --json number,title,labels,body > /tmp/issues.json
```

- 取得した JSON に対して、依頼内容から抽出した**複数のキーワード**
  （機能名・対象モジュール・症状など言い換えを含む）で title / body を
  ローカル検索する（jq / grep / Read での目視など。追加の gh
  呼び出しはしない）。
- 一致しそうな Issue は body まで読んで重複か否かを判定する。
- 既存 Issue で内容がカバーされているなら起票せず、その Issue 番号をユーザーに
  提示する。部分的に重なるなら、既存 Issue の拡張（`gh issue edit`）か
  差分のみの新規起票かを判断する。
- あわせてアーカイブ済み backlog タスク（`docs/archive/backlog-tasks/`）にも
  同種の既知課題がないか grep しておくと、過去の経緯・却下理由を拾える
  （アーカイブは凍結されているため、こちらへの起票・編集はしない）。

## 2. スコープ判定

依頼を以下の 3 パターンに分類してから起票する。

| 判定                                                                | 構造             | 起票方法                                                       |
| ------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------- |
| 単一の焦点を持つ PR 1 つで完結し、レビュアーが一度に読める          | 単一タスク       | Issue 1 件                                                     |
| 共有ゴールが 1 つで同一サブシステム内に閉じるが、作業単位を分けたい | 分割 + 依存      | Issue を分け、後続の LOOP-META `depends-on` で実行順を表現する |
| 独立して届けられる成果物が複数あり、サブシステム・レイヤーをまたぐ  | 依存関係付き分割 | 同上（`depends-on: ["#N"]`。先行 Issue を先に作る）            |

判定の問い: 「単一 PR で完結するか」「レビュアーは全変更を一度に確認できる
か」「独立したデリバリーポイントがあるか」「複数サブシステムにまたがるか」。
迷ったら小さく分ける方に倒す（1 タスク = 1 PR の原則）。

## 3. 起票は `gh issue create --body-file` で行う

本文をシェル引数で渡すと、ダブルクォート内のバッククォートがコマンド置換として
実行されテキストが破壊される（置換後の復元は不可能）。**本文は必ず一時ファイル
に書き出し、`--body-file` で渡す**。シェルの heredoc も使わず、ファイル作成は
Write ツール（またはエディタ）で行う。

手順:

1. 本文ファイルを作成する（例: `/tmp/issue-body.md`）。テンプレート
   `.github/ISSUE_TEMPLATE/task.md` の本文規約に従う:

   ```markdown
   <!-- LOOP-META
   depends-on: []
   ordinal: null
   -->

   ## Description

   （背景・確定事項・スコープ外を書く）

   ## Acceptance Criteria

   - [ ] AC1 検証可能な振る舞い
   - [ ] AC2 検証可能な振る舞い
   ```

2. 起票する（title は本文と違い破壊リスクが小さいが、バッククォートを含む
   場合はシングルクォートで渡す）:

   ```bash
   gh issue create \
     --title '<タイトル>' \
     --body-file /tmp/issue-body.md \
     --label triage \
     --label 'area:<領域>'
   ```

- `--label` は複数回指定できる。作成時は必ず`triage`に置き、本文と依存関係を
  read-backで検証する前に`codex-loop:ready`を付けない。常駐loopが不完全なIssueを
  claimするraceを防ぐためである。
- bug 起票は `--label bug` を必ず追加する。
- ラベルがリポジトリに未作成だと `gh issue create` が失敗する。
  `area:src-<module>` 系の新しいラベルは先に
  `gh label create 'area:src-<module>' --color 006B75 --description '変更ファイル領域'`
  で作成する（既定 area ラベル一式は `deno task setup-issue-labels`
  で同期済み）。

## 4. 記述ルール

### LOOP-META（本文先頭の HTML コメント）

- `depends-on`: 依存 Issue の配列。**必ず `"#N"` とクォートする**（YAML では `#`
  がコメント開始のため、クォート無しは値が消える）。依存なしは `[]`。
  `codex-issue-loop`はこの値を解釈しないため、producerが全依存Issueのclosedまたは
  `codex-loop:done`を確認してからready labelを付ける。
- `ordinal`: legacy metadataとして通常は`null`にする。codex-issue-loop v0.2の
  queue順は`.agent-loop.yaml`の`issue_number_asc`であり、ordinalやbug labelでは
  上書きされない。

### Description

- 背景・目的・調査済みの事実を書き、**会話コンテキストなしで将来のエージェント
  が着手できる**内容にする。実装プランは書かない（着手時に worker が調べて
  記録する）。Implementation Plan / Notes / Final Summary は本文ではなく Issue
  コメントに投稿する（本文の read-modify-write を減らす）。
- **bug の場合**は `docs/development-style.md` 2 章の bug intake フォーマットに
  従う: 再現手順・期待挙動・実際の挙動・発見契機（どのタスクの動作確認/どの
  報告で見つかったか）を Description に記載し、label `bug` を付ける。

### Acceptance Criteria

- **`- [ ] AC1 ...` 形式で連番を振る。`#N` 形式は禁止**（GitHub 上で Issue
  リンクに化けるため）。
- 実装手順ではなく**検証可能な振る舞い**を書く（「〜関数を実装する」は不可、
  「〜すると〜が表示される」「テストが green」は可）。
- 自動テストできない描画系の確認に限り「目視確認」を AC にしてよい。
- bug の場合の AC は「再現テスト（red）が追加されている」「修正により green」
  を基本とする。

### area ラベル

- `docs/development-style.md` 4.2 章の表に従い `area:<領域>` を付与する
  （複数可）。変更範囲とreview scopeを明示するため省略しない。
- 領域: `area:docs` / `area:workflow` / `area:src-main` / `area:src-<module>`
  と、 `scripts/` `data/` の細分化領域。対応パスの目安は同章の表を参照。
- **`scripts/` `data/` は細分化領域を使う。** 粗い `area:scripts` / `area:data`
  は使わない（`next-tasks` は文字列一致で衝突を見るため、粗いラベルと
  細分化ラベルが混在すると実際には衝突するタスクが並列に選ばれる）。範囲が広い
  タスクは該当する細分化領域を複数併記する。
- `scripts-*` と `data-*` は同名サフィックスが対になる（`scripts-base` が
  `data-base` を生成する等）。触るパイプラインを決めれば両方のラベルが決まる。
  `scripts-build` / `scripts-loop` / `scripts-verify` は生成物を持たないため
  対になる `data-*` はない。

## 5. triage Issue の正式化（外出先の雑起票の受け皿）

外出先の GitHub モバイルアプリ等からの雑起票は、`triage` ラベルで積まれる
（`docs/development-style.md` 4.5 章の triage フロー）。`triage`は
`.agent-loop.yaml`のexclude labelなので自動実行されない。intake
セッションはタスク起票のついで、または依頼を受けた時に
`gh issue list --label triage --state open` で未整形 Issue を洗い出し、各件を 本
skill の手順 1〜4 に従って正式化する:

- 重複していれば既存 Issue 番号をコメントで示し、
  `gh issue close <番号> --reason "not planned"` でクローズする。
- 正式化する場合は本文を LOOP-META・Description・AC 規約へ整形したファイルを
  作り `gh issue edit <番号> --body-file <path>` で置き換え、
  必要なarea/type labelを追加する。依存・着手条件の判定後、`triage`を外して
  `codex-loop:ready`、`blocked`、`needs-human`、`do-not-automate`のいずれか1つを
  付ける。readyを付けた時点で常駐loopの選定候補に入る。

## 6. 起票後の確認

- 本文をread-backし、依存Issueのstateと外部着手条件を確認してからadmission labelを
  確定する。今すぐ着手可能な場合の標準操作は次のとおり。

  ```bash
  gh issue edit <番号> \
    --remove-label triage \
    --add-label codex-loop:ready
  ```

  依存未解決・外部条件待ちは`blocked`、ユーザー判断待ちは`needs-human`、自動実行を
  恒久的に禁止するIssueは`do-not-automate`へ置き換える。
- Issueがclosedまたは`codex-loop:done`になったときは、そのIssueを`depends-on`に
  持つopen + `blocked` Issueを再評価し、全条件を満たしたものだけを
  `codex-loop:ready`へ昇格する。
- `gh issue view <番号>` で、Description・Acceptance Criteria・area/type labels・
  LOOP-META（depends-onのクォート）と、admission labelが期待どおり着地したことを
  確認する。
- admission labelは`codex-loop:ready`、`blocked`、`needs-human`、
  `do-not-automate`のいずれか1つだけにする。supervisor所有の
  `codex-loop:running`、`codex-loop:needs-input`、`codex-loop:failed`、
  `codex-loop:done`は操作しない。legacyの`task`と`status:in-progress`も追加しない。
- 改行の欠落・AC の粒度（実装手順になっていないか）・`#N` 記法の混入を
  ここで点検し、ずれていれば本文を修正したファイルを作り
  `gh issue edit <番号> --body-file <path>` で直す。
- 起票した Issue 番号とタイトルをユーザーに報告する。
