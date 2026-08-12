# 開発スタイル規約（TDD・issue 駆動・ループエンジニアリング）

> このプロジェクトの開発は「テスト駆動開発（TDD）」「issue 駆動開発（GitHub
> Issue のタスク起点。backlog.md から移行済み、docs/adr/0031
> 参照）」「ループエンジニアリング（複数階層のフィードバックループ）」の 3
> 本柱で進める。人間は開発フローに原則入らず、介入は例外時のみとする（4
> 章を参照）。

## 1. テスト駆動開発（TDD）規約

- テストは実装と同居させる: `src/foo.ts` に対して `src/foo_test.ts`
  を置く。実行は `deno test`。
- タスク Issue の Acceptance Criteria
  を起点にテストケースを設計する。実装より先にテストを書き、red（失敗）を確認してから実装し、green
  にしてから refactor する（red → green → refactor）。
- MapLibre / deck.gl などの
  DOM・描画に依存する処理は、可能な限りロジックを分離して純粋関数として切り出し、ユニットテストの対象を最大化する。特に以下は重点テスト対象:
  - データ変換（GeoJSON 加工・year snapshot 選択など）
  - 色割当ロジック
  - URL 状態のエンコード・デコード
  - 年代スナップの選択ロジック
- 描画結果そのもの（地図が正しく見えるか等）はユニットテストで検証できないため、該当する
  Acceptance Criteria には「目視確認」と明記し、自動テストの対象と区別する。
- bugfix も同じ red → green → refactor を適用する:
  修正より先に問題を再現するテストを書き、red であることを確認してから修正して
  green にする。描画など自動テストで再現できない場合に限り、テストの代わりに
  目視確認 AC で代替する（2 章の bug 起票フォーマットを参照）。

## 2. issue 駆動開発規約

- すべての変更は GitHub Issue のタスク（label `task`）を起点とする。起票は
  `task-intake` スキル（`.claude/skills/task-intake/SKILL.md`）の手順で行う:
  着手前の重複確認は search API を使わず
  `gh issue list --state all --limit 1000 --json number,title,labels,body` を 1
  コール叩いてローカルでマッチし、なければ `gh issue create --body-file <path>`
  で新規作成する（本文はシェル引数で渡さず必ずファイル経由。バッククォートの
  コマンド置換によるテキスト破壊を防ぐ）。本文は
  `.github/ISSUE_TEMPLATE/task.md` の規約（LOOP-META・`AC1` 記法・area
  ラベル）に従う。`backlog` CLI は使わない（移行前のタスクは
  `docs/archive/backlog-tasks/` に凍結。索引は同ディレクトリの README）。
  外出先などでこの起票品質をその場で満たせない場合は、`triage` ラベルによる
  二段階起票を使う（4.5 章の triage フロー）。
- 既存の運用規約（本ファイル末尾ではなくプロジェクト `CLAUDE.md`
  の「タスク駆動開発」節）に定める、ブランチ名 `issue-N-slug`（移行前のタスクは
  `task-N-slug`）・依存関係順の実行 （area が互いに素な場合のタスク間並列を
  含む。4.2 章参照）・PR への Issue 番号 明記（本文の `Closes #N` を含む）は
  継続して守る。
- タスクを Done（Issue クローズ）にできるのは、Acceptance Criteria が
  全てチェック済みで、かつ CI が green の場合に限る。
- 動作確認（`/agent-loop` のマージ後動作確認フェーズや手動確認）・
  `/code-review`・ユーザー報告で見つけた問題は、直接 hotfix せず必ず label `bug`
  付きのタスク Issue として起票してから直す。
- **起票はフェーズ単位でバッチ化する**（根拠と限界は 4.2.1 章）。1 件見つける
  たびに起票して次へ進むのではなく、そのフェーズ（1 回のマージ後動作確認、1 回の
  `/code-review`、1 回のユーザー報告）の確認を最後までやり切って問題を出し切り、
  **見つかった全件をまとめて起票してから**次イテレーションへ進む。
- 起票フォーマット（バッチでも **1 件 = 1 タスク**。複数の問題を 1
  タスクにまとめない）:
  - Description: 再現手順・期待挙動・実際の挙動・発見契機（どのタスクの
    動作確認/どの報告で見つかったか）を記載する。
  - Acceptance Criteria: 「再現テスト（red）が追加されている」「修正により
    green」。自動テストできない描画系の問題に限り「目視確認」を追加する。
  - LOOP-META の depends-on は原則空、ordinal は原則 null（Issue
    番号順）とする（優先順位は label `bug` が担保するため、選択順に ordinal
    は使わない）。

### 2.1 設計判断の記録（ADR / docs/adr/）

タスク横断で影響する設計判断は `docs/adr/` の Architecture Decision Record
（ADR）として記録し、後続タスクが判断の背景・根拠を参照できるようにする。
かつては backlog CLI 管理の decisions（`backlog/decisions/`）だったが、 decision
番号を保持して `docs/adr/` へ移設した（経緯は
`docs/adr/0031-migrate-task-management-to-github-issues.md` を参照）。

**記録する判断（タスク横断で影響するもののみ）:**

- アーキテクチャ・データフローの方式選択（例: 色割当の静的生成、picking の
  レイヤー順制御）
- データソースの採用・不採用（例: historical-basemaps のコミット固定採用）
- ライセンス方針（例: NC ライセンスデータの GPL 派生データからのファイル分離）
- プロジェクト規約の新設・変更（例: area ラベルによるタスク間並列判定）
- 複数の選択肢からトレードオフを比較して下した採否で、後続タスクの実装を
  制約するもの

**記録しない判断:**

- タスク限りの実装意図・Why（そのタスクのスコープで完結し、後続タスクを
  制約しないもの）。これらはコンテキストコミットの `intent:` / `decision:` 行と
  タスク Issue の Implementation Notes コメントに記録すれば十分であり、ADR
  へ転記しない（重複記録は同期切れ・形骸化を招くため禁止）。
- **運用上の判定基準**（ADR にするほど大きくないが、複数タスクで繰り返し
  参照されるもの）。これは第 3 の層として **2.3 章**に置く。ADR が「データや
  アーキテクチャの方式をどう決めたか」を残すのに対し、2.3 章は「その方式の
  下でタスクをどう進める / どう完了と認めるか」という運用の作法を残す。

**3 層の使い分け:**

| 層               | 置き場所                      | 内容                                       | 例                                         |
| ---------------- | ----------------------------- | ------------------------------------------ | ------------------------------------------ |
| 設計判断         | `docs/adr/`                   | タスク横断で実装を制約する方式選択         | 出典なき座標を合成しない（ADR-0014/0018）  |
| 運用の判定基準   | 本書 2.3 章                   | 複数タスクで反復参照される進め方・完了判定 | 上流の構造的欠落時の AC 受理、外科的パッチ |
| タスク限りの意図 | コミット本文 / Issue コメント | そのタスクで完結する Why                   | この関数をこう分けた理由                   |

**コンテキストコミットとの棲み分け:** コミット本文の `decision:` 行は「その
コミット/タスク限りの判断」を残す場所、ADR は「タスク横断の
判断」を残す場所と区別する。タスク横断の判断が実装中に生まれた場合は ADR
に本体を書き、コミット側は decision ID（例: `decision-3 参照`）を
参照するに留める（本文の二重管理をしない）。

**記録タイミング:** `/agent-loop` の finalization 時に「このタスクで下した
判断にタスク横断で影響するものがあるか」を判定して記録する
（`.claude/skills/agent-loop/SKILL.md` の手順に組み込み済み）。

**作成・参照の方法**（backlog CLI は使わない。採番規約の詳細は
`docs/adr/README.md` を参照）:

- 作成: `docs/adr/00NN-<slug>.md` を既存の最大番号の次の連番で直接作成する
  （slug は英語ケバブケース）。frontmatter は `status` / `date` のみとし、 本文
  H1 を `# decision-N: <タイトル>` の形式で書く。タイトルは検索しやすい
  日本語で「何をどう決めたか」まで含める。本文は `## Context` / `## Decision` /
  `## Consequences` を埋める（背景・決定・根拠・関連 TASK を簡潔に）。作成後は
  `docs/adr/README.md` の一覧に行を追加する。
- 一覧: `docs/adr/README.md` の一覧表を見る。
- キーワード検索: `docs/adr/` 配下を grep する。
- 本文の参照: `docs/adr/00NN-<slug>.md` を直接読む。`decision-N` の N は ADR
  番号と一致するため、既存の `decision-N` 参照は番号で引ける。

### 2.2 調査レポートの記録（docs/research/）

判断の根拠になった一次調査は `docs/research/` にコミットする。エージェントの
グローバル設定は調査結果を `.outputs/claude/` へ出すと定めているが、そこは git
管理外（global gitignore）で worktree の後始末とともに消えるため、**コミット
済みの docs が根拠として指すレポートを置いてはならない**（Issue #204 の時点で、
`docs/development-style.md` と `docs/data-inventory/` が参照していた一次調査は
すべて消失していた）。

- **`docs/research/` に置く:** 方針の採否・起票根拠・実測に基づく現状分析など、
  他の docs / タスク Issue / ADR が根拠として参照する調査。
- **`.outputs/claude/` のままでよい:** スクリプト 1 コマンドで再生成できる
  中間生成物（`deno task audit-attribution` / `deno task audit-rivers` の
  レポート、検証スクリーンショット、キャッシュ、巨大なダンプ）。docs から
  参照するときは**生成コマンドを併記**し、パスだけを指す参照は残さない。
- 命名規約（`issue-<N>-<slug>.md`）・冒頭のメタ情報・一覧への登録・`docs/adr/`
  および `docs/data-inventory/` との棲み分けは `docs/research/README.md`
  を参照。同じ調査から ADR が生まれる場合は、根拠を `docs/research/`・決定を
  `docs/adr/` に分け、ADR の Context から調査を参照する（2.1 章と同じく本文の
  二重管理をしない）。
- 失われたレポートは復元・再現しない。参照元には「復元不可」であることと結論の
  所在を注記する（一覧は `docs/research/README.md` の「失われた調査レポート」
  節）。

### 2.3 運用上の判定基準（本書に置く先例）

ADR にするほど大きくないが、複数タスクで繰り返し参照される判定基準をここに
置く（2.1 章の 3 層の使い分けを参照）。PR 本文の中だけで先例が継承されると
リポジトリ内から辿れなくなるため、2 回以上参照された判定基準は本節へ昇格
させる（Issue #205）。

#### 上流の構造的欠落により AC が充足不能な場合の受理

**基準:** 採用済みソースおよび検証済み代替ソースのいずれにも、その AC が
要求するジオメトリが**構造的に存在しない**ことを実測で確認できた場合、
ジオメトリを合成せず次の 2 箇所へ明示記録することをもって、その AC を
充足済みとして受理する。

- `data/known-limitations.json`（年代連動で UI に表示され、地図を見ている
  利用者が欠落を知れる）
- `docs/data-inventory/missing-powers-ledger.md`（網羅台帳。上流が埋まれば
  解消できる行として残る）

「構造的に存在しない」の典型は、上流リレーションが label ノードのみで境界 way
を持たない（面が組めない）ケース、収録期間が対象年を覆わないケース。
**判断が割れる場合は受理せず、実装を続けるか Issue を分割する**（安易な 受理は
AC の形骸化を招く）。

**ADR-0014 / ADR-0018 との接続:** ADR-0014（出典なき座標合成の禁止）と
ADR-0018（本旨を「地図が主張する内容の出典」に適用）は **data 側の方針**
＝「埋めてよいか」を定める。本節はその方針を前提としたときの**タスク運用側
の帰結**＝「埋められないと分かった AC をどう扱うか」を定める。両者は
矛盾せず、data 側が「埋めない」と判断した欠落に限って本節の受理が働く。
隣接年からの借用が条件付きで許されるケースは ADR-0033 が別に定めており、
借用が可能なら受理ではなく実装で解決する（借用可能性を先に検討すること）。

**先例:** TASK-121 AC2（宗主を発明しない解釈）→ #187 AC2（1800 年のケルン
選帝侯領＝仏占領で OHM 収録終了）→ #189 AC1（1530〜1650 のハンガリー王国＝ AL2
連鎖が label ノードのみ）→ #190 AC2（南ネーデルラント＝同上）→ #202 AC1
（シュタイアーマルク／チロル／ケルンテンの面が全ソースに不在）。

#### 生成物の外科的パッチ原則

**基準:** データ生成物の一部だけを直したいとき、パイプラインの再生成が
**意図しない差分**（座標精度の変更・簡略化トレランスの揺り戻し・上流の drift
等）を巻き込む場合は、再生成せず意図した箇所のみを外科的にパッチし、
ジオメトリはバイト不変に保つ。パッチした事実と再生成を避けた理由を
コミット本文か Issue の Implementation Notes に残す。

再生成を避ける典型は、上流をピン留めできないデータ（OHM の Overpass 直叩き）を
触るケース。再生成すると意図した箇所以外に上流の drift
が混ざり、「名前だけ直す」 といった意図の範囲を大きく超える。

なお、`COORD_PRECISION` の変更（TASK-130 で 5 → 3 桁）が raw
領邦データに全面差分を 生む問題は #334 で解消済み（raw は
`RAW_FIEF_COORD_PRECISION` = 5 桁で保持し、
丸めは配信される派生側で行う。ADR-0037）。とくに `cliopatria` は入力がコミット
SHA + SHA-256 でピン留めされているため**再生成が正常経路**であり、外科的パッチの
対象ではない。

**先例:** #188（1492 年 `italy_fiefs` の `Duchy of Florence` →
`Republic of
Florence` を NAME 1 件の書き換えのみで是正）・#187（中世
`hre_fiefs` 7 年を 再生成せずバイト不変に保ち、近世 3 年のみ追加）。

**ADR に置かなかった理由:** 外科的パッチは「どのデータをどう作るか」という
方式選択ではなく、既に決まった方式の下でタスクを進めるときの作法であり、 2.1
章の ADR 記録基準（後続タスクの実装を制約する方式選択）に当たらない。

## 3. ループエンジニアリング（3 層ループ運用）

開発中は次の 3 つのフィードバックループを内側から外側へ多重に回す。

1. **内側ループ（秒〜分単位・ローカル）**: `deno test --watch`
   でテストを常時実行し、red/green
   を即座に確認しながら実装する（`deno task test:watch` として task-1
   で整備予定）。
2. **中間ループ（実装完了〜PR前・エージェント自律）**: 実装は subagent
   に委譲する。実装プラン記録時に並列化判定を必須で行う: 独立サブ作業
   （ファイル競合・実行順依存がなく独立にテスト可能な単位）への分割案を
   列挙し、採否と根拠をプランに記録する。並列可なら subagent を並列に複数
   起動し（worktree isolation で衝突回避、conflict は PR で解消）、見送り
   なら理由を明記する。mainagent はレビュー時に並列化判定の記載有無を確認し、
   無記載なら差し戻す。実装が一通り 終わったら mainagent が diff をレビュー
   し、指摘があれば subagent に修正を指示して、mainagent が問題なしと判断
   するまで収束させる（codex など外部エージェントによるレビューは行わない）。
   作業は必ず作業ブランチで行い、default branch（main）上では行わない。
3. **外側ループ（PR ゲート・CI）**: PR 作成後は CI（fmt / lint / test /
   build）が green になるまでマージしない。CI が red の場合は修正してから再度
   push し、このループを回す。

## 4. 次タスク選択の決定化と外側の自律ループ

### 4.1 次タスク選択ルール（決定的）

次に着手するタスクは人が指名するのではなく、次の決定的ルールで一意に定める。
ルール 2・3 は候補の**全順序**を定めるものであり、この順序が単一選択（4.1 章）と
集合選択（4.2 章）の両方の基礎になる。

1. 候補 = status が `To Do` かつ `dependencies` の全てが終端ステータスの
   タスク（Issue 一覧に存在しない依存 ID は未完了として扱う。closed は
   COMPLETED（`Done`）/ NOT_PLANNED（取りやめ）のいずれも依存解決とみなす）。
2. 候補は label `bug` を持つものを `ordinal` に関わらず先頭に並べる。bug
   候補が複数ある場合はその中で `ordinal` 昇順、同値なら ID
   の数値部分が小さい方を先に置く。
   **これは順序の規定であって候補の絞り込み（排他）ではない。**bug
   候補が存在しても非 bug の候補は候補集合に残り、4.2 章の集合判定では area
   が非交差なら同じ集合に選ばれうる。
3. bug でない候補は bug の後ろに、`ordinal` 昇順で並べる（`ordinal`
   欠落は最後回し。同値なら ID の数値部分が小さい方が先）。
4. 単一選択ではこの順序の**先頭 1 件**を次タスクとする。ただし `In Progress`
   のタスクが 1 つでも残っている間は次タスクを選ばない
   （イテレーション境界規約。進行中タスクの finalization 完了が先）。

このルールは `scripts/next_task.ts` に実装されており、`deno task next-task`
で次タスク ID（例: `#12`）が出力される（候補なしなら出力なし・exit 0）。
タスクの読み取り元は環境変数 `TASK_SOURCE` で切り替わり、**既定は github**
（GitHub Issue を `gh issue list` 1 コールで取得し、status は open/closed と
`status:in-progress` ラベル、依存と ordinal は本文 LOOP-META から導出する。
TASK-139 で抽象化、TASK-140 で既定を切替）。`TASK_SOURCE=backlog` の明示指定は
移行前のチェックアウト（`backlog/tasks/*.md` が存在する時点）向けに残る。 本章の
status 名（`To Do` / `In Progress` / `Done`）は Issue の state・ラベル
から導出する論理ステータスであり、着手中（`In Progress`）の**権威**は claim
タグ（4.3 章）である。`status:in-progress` ラベルは advisory
表示のため、ラベルと claim のずれは `deno task loop-doctor` が検出・修復する
（4.3.3 章）。`TASK-N` 表記は移行前タスクの歴史的参照であり（索引は
`docs/archive/backlog-tasks/` の README）、移行後のタスク ID は Issue 番号 `#N`
である。 動作確認で見つけた問題（2 章参照）を label `bug`
付きで起票すると、このルールにより次イテレーションで最優先に選ばれる（単一選択
なら 1 件目、集合選択なら集合の先頭）。 バッチ起票で bug
候補が複数になった場合も ルール 2 が順序を一意に定める（bug 群内は `ordinal` →
ID 順）ため決定性は 変わらず、 そのうえで 4.2 章の area 判定が bug
群の中で働く余地が生まれる（4.2.1 章）。

**「最優先」を排他にしない理由（TASK-115）:** bug
を先頭に置けば、着手順・レビュー順・マージ順のいずれでも bug が先になり、「bug
を最優先で片付ける」という意図は満たされる。候補集合から非 bug を除外しても bug
の優先度は上がらない一方、area が完全に非交差の非 bug
タスクまで待たせるため、判定機会を空費する（2026-07-27 の agent-loop
並列度調査の再生では、除外が集合を 単独に縮退させた判定が 32 回中 4
回。レポート本体は現存しない。4.2 章の注記を参照）。bug と非 bug
を同じイテレーションで扱っても 1 タスク = 1 PR・`In Progress` → `Done`
遷移の一意性・イテレーション境界ガードは 不変であり、area
が非交差である以上、実ファイルの競合も起きない。

### 4.2 area ラベル規約とタスク間並列実行

タスク間の並列実行可否を機械的に判定できるよう、各タスクには「変更するファイル
領域」を表す `area:<領域>` ラベルを labels に付与する（複数可）。領域一覧と
対応パスの目安:

| area                | 対応パスの目安                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `area:docs`         | `docs/`                                                                                                                                    |
| `area:workflow`     | `.claude/`・`CLAUDE.md`・タスク Issue 運用                                                                                                 |
| `area:scripts-*`    | `scripts/` 配下（下の細分化表を参照。粗い `area:scripts` は使わない）                                                                      |
| `area:data-*`       | `data/` 配下（下の細分化表を参照。粗い `area:data` は使わない）                                                                            |
| `area:src-main`     | `src/main.ts`・`index.html`・`app.css` の UI 統合部。UI 系タスクの大半は ここに触るため、`src-main` を持つタスク同士は互いに衝突扱いとする |
| `area:src-<module>` | `src/` 配下の独立モジュール（例: `area:src-labels`、`area:src-powers`）                                                                    |

**`scripts/` の細分化**（`src-<module>` と同じくモジュール単位で切る）:

| area                    | 対応パスの目安                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `area:scripts-base`     | `scripts/build-data.ts`・`scripts/build-hre.ts`・`scripts/clean-polygons.ts`・`scripts/build-coastal-fill.ts`・`scripts/base-properties_test.ts`（base 勢力・Roller HRE・沿岸補完の帯の生成と検証）      |
| `area:scripts-fiefs`    | `scripts/build-france-fiefs.ts`・`build-hre-fiefs.ts`・`build-italy-fiefs.ts`・`build-cliopatria-fiefs.ts`・`build-borrowed-fiefs.ts`・`build-fief-dedupe.ts`・`build-fief-flat.ts`・`clean-polygons.ts` |
| `area:scripts-features` | `scripts/build-rivers.ts`・`build-mountains.ts`・`build-peaks.ts`・`build-cities.ts`・`audit-rivers.ts`（河川・山脈・山峰・都市）                                                                        |
| `area:scripts-meta`     | `scripts/build-colors.ts`・`build-attribution.ts`・`audit-attribution.ts`・`name-ja_test.ts`・`known-limitations-json_test.ts`                                                                           |
| `area:scripts-build`    | `scripts/build.ts`・`extract-pmtiles.ts`・`extract-dem.ts`（ビルド統合エントリとベースマップ素材取得）。`build.ts` は全パイプラインのハブなので `src-main` と同様に同士は衝突扱いとする                  |
| `area:scripts-loop`     | `scripts/next_task.ts`・`next_tasks.ts`・`task_source.ts`・`cleanup_branches.ts`・`loop_doctor.ts`（agent-loop 支援ツール）                                                                              |
| `area:scripts-verify`   | `scripts/serve.ts`・`scripts/verify/`（ローカル配信と headless 動作確認ハーネス）                                                                                                                        |

**`data/` の細分化**（生成元パイプラインと 1 対 1 に対応させる）:

| area                 | 対応パスの目安                                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `area:data-base`     | `data/europe_<year>.geojson`・`europe_flat_<year>.geojson`・`base_outline_<year>.geojson`・`coastal_fill_<year>.geojson`・`hre_<year>.geojson`・`index.json`・`name-overrides.json` |
| `area:data-fiefs`    | `data/<region>_fiefs_<year>.geojson`・`<region>_fiefs_flat_<year>.geojson`（`hre_fiefs_*` を含む）・`fief-dedupe.json`                                                              |
| `area:data-features` | `data/rivers.geojson`・`mountains.geojson`・`peaks.geojson`・`cities.json`                                                                                                          |
| `area:data-meta`     | `data/colors.json`・`name-ja.json`・`known-limitations.json`                                                                                                                        |

細分化の運用ルール:

- **領域名は `<ディレクトリ>-<パイプライン>` で決める。** 新しい領域を足すのは
  「既存のどの領域にも属さないファイル群が生まれたとき」に限り、1 ファイルごとの
  領域は作らない（判断コストが上がり、ラベル漏れで false parallel を招く）。
- **`scripts-*` と `data-*` は同名サフィックスが対になる。** `scripts-base` が
  `data-base` を、`scripts-fiefs` が `data-fiefs` を生成する、という対応で
  覚える（`scripts-build` / `scripts-loop` / `scripts-verify` は生成物を持たない
  ため対になる `data-*` がない）。「どのパイプラインを触るか」を一度決めれば
  両方のラベルが決まる。
- **複数領域に載るファイルは両方の表に現れる**（例: `clean-polygons.ts` は base
  と fiefs の両パイプラインが import する共有ジオメトリ補正）。そのファイルを
  **変更する**タスクは該当する area を両方付ける。呼び出すだけなら不要。
- **粗い `area:scripts` / `area:data` は使わない。** `scripts/` や `data/`
  全体に 及ぶ変更は、該当する細分化 area
  を複数併記する。粗いラベルと細分化ラベルが 混在すると `next-tasks`
  は文字列一致で衝突を見るため交差せず、実際には
  衝突するタスクが並列に選ばれてしまう。

**細分化の根拠（実測）:** agent-loop 並列度調査（2026-07-27）で `next-tasks` が
area 衝突を理由にスキップした延べ 17 回のうち `area:scripts` 5・ `area:data` 4
は、実ファイルの競合ではなくラベル粒度だけの問題だった（`scripts/` は 40
以上、`data/` は 89 ファイルに物理的に分かれているのに粗いラベル 1 個で
束ねていた）。過去 32 判定機会の反実仮想再生では、この 2 領域の細分化だけで並列
成立が 6/32（19%）→ 11/32（34%）に増える。上の区分は恣意的に決めたものではなく、
`origin/main` の全マージ PR で `scripts/` `data/` のどのファイルが同一 PR 内で
一緒に変更されたかから導いた（例: `next_task.ts` / `next_tasks.ts` /
`cleanup_branches.ts` はビルドパイプラインと一度も同時に変更されていない一方、
`build-fief-dedupe.ts` と `build-fief-flat.ts` は 4 PR で同時に変更されている。
`rivers` / `mountains` / `peaks` / `cities` の生成物が
`europe_*`・`base_outline_*`・ `*_fiefs_*` と同一 PR で変更されたのは、全
feature に出典プロパティを付与した TASK-109 の 1 回だけ）。

> **この調査のレポート本体は現存しない。** 旧
> `.outputs/claude/agent-loop-parallelism-investigation.md` は git 管理外に出力
> されていたため失われており、内容の復元・再現はしない。上の実測値がその結論の
> 転記であり、4.1 章・4.2.1 章の数値も同じ調査に由来する（決定は
> `docs/adr/0008-parallel-tasks-by-area-labels.md`、適用タスクは
> `docs/archive/backlog-tasks/` の TASK-113 / 114 / 115 / 116）。失われた
> レポートの一覧と結論の所在は `docs/research/README.md` の「失われた調査
> レポート」節にまとめてある。以後の一次調査は 2.2 章のとおり `docs/research/`
> にコミットする。

area ラベル全体の運用:

- area の付与はタスク作成時に行い、既存タスクの整備時にも追記する
  （`gh issue edit <N> --add-label` を使い、既存ラベルを消さない）。
- `deno task next-tasks` は、To Do かつ dependencies 全 Done の候補から 4.1
  章と同じ優先順（bug 最優先 → `ordinal` → ID）の貪欲選択で「area が互いに
  素なタスク集合」を決定的に返す。出力は JSON（`tasks` = 選択された集合、
  `skipped` = area 衝突等で見送った候補と理由）。area 未付与のタスクは変更範囲が
  不明なため、貪欲選択の先頭に来た場合のみ単独選択する（保守的フォールバック＝
  直列）。`In Progress` のタスクが存在する間は空集合を返す。
- **bug 候補があっても候補集合は bug 群に絞られない**（4.1 章のルール 2
  は順序であって排他ではない）。走査順の先頭は必ず bug になるため返る集合の
  先頭は bug 候補だが、その後ろには area が非交差なら非 bug
  候補も入る。したがって「bug 1 件 + area が非交差の非 bug 1
  件」は同じイテレーションで並列に処理してよい。bug と area が交差する非 bug
  候補は、他の交差と同様に `skipped` に落ちる。
- 従来の `deno task next-task`（単一選択）は互換維持されており、単一タスクの
  判定にはそのまま使える。
- タスク間並列実行のルール:
  - `next-tasks` が返した集合が複数タスクなら、それらを同時に実装してよい。
    集合内の各タスクは個別ブランチ・個別 PR で進める（1 タスク = 1 PR）。
  - bug 最優先（集合の先頭が bug）・各タスクの `In Progress` → `Done`
    遷移の一意性は並列時も維持する。集合に bug と非 bug が同居する場合、bug
    の実装・レビュー・マージを先に片付けることを優先する。
  - 並列不可の場合（area が交差する・area 未付与・依存関係で候補が 1 件のみ）
    は従来どおり直列で 1 タスクずつ進める。
- 並列化判定は二層で行う: **タスク間並列**（本節。`next-tasks` による集合判定）
  と、**タスク内並列**（3 章の中間ループ。タスクを独立サブ作業に分割して
  subagent を並列起動する判定）。両者は独立に判定し、実装プランにはタスク内
  並列の判定結果を従来どおり記録する。

### 4.2.1 bug 起票のバッチ化（判定機会を増やす）

`next-tasks` が複数タスクの集合を返せるかどうかは、area ラベルの設計より前に
**候補がそもそも 2 件以上あるか**で決まる。

**根拠（実測）:** 同じ agent-loop 並列度調査（2026-07-27。4.2
章の注記のとおりレポート本体は現存しない）で `next_tasks.ts` 導入以降の main
first-parent 77 コミットを再生した ところ、判定機会 32 回のうち並列集合（2
件以上）が返ったのは 6 回（19%）に とどまった。最大の要因は area 交差（8
回）ではなく**候補の供給不足**で、45 コミットの時点で To Do が 0 件、さらに 10
回は候補が 1 件のみだった。同じ形は 10 タスクを処理した 2026-07-27
のループ実行でも再現しており、判定機会 8 回のうち 並列集合は 2 回、bug を 1
件ずつ起票した TASK-117（TASK-105 の実装中に発見）と TASK-118（TASK-112
のマージ後動作確認で発見）はいずれも次イテレーションで単独 処理され、「1 件起票
→ 1 件消化」のピンポンになった。

**運用:** そこで bug の起票は**フェーズ単位でバッチ化する**（規約は 2 章）。

- マージ後動作確認・`/code-review`・ユーザー報告のいずれでも、1 件見つけた時点で
  起票して次へ進まず、そのフェーズの確認・読み込みを最後までやり切って問題を
  出し切る。
- 出し切った問題を**次イテレーション開始前に全件まとめて起票する**（1 件 = 1
  タスク）。
- 起票を終えてから `deno task next-tasks` の集合判定に進む。

候補が 1 件しかない状態では area 判定は原理的に働かないため、これは area の
粒度を調整するのではなく**判定機会そのものを増やす**対処である。bug 候補が複数に
なれば、area が互いに素な bug 同士は同じイテレーションで並列に処理されうる（bug
最優先は順序であって排他ではないため、bug 1 件でも area が非交差の非 bug
と組める。4.1 章・4.2 章）。

**イテレーション境界のガードは維持する。** `In Progress` のタスクが 1 つでも
残っている間は次の集合を判定しない（4.1 章のルール 4、4.2 章の「`In Progress` の
タスクが存在する間は空集合を返す」、4.3 章の安全ガード）。バッチ起票はこの
ガードと矛盾しない: 起票はイテレーションの終わり（集合内の全タスクがマージ・
finalization・後始末まで完了したあと）に行い、集合判定はその後に行うため
である。イテレーション途中で見つけた問題を現イテレーションの集合へ合流させる
ことは、引き続き行わない。

**この対処が効く範囲（限界）:** バッチ化が判定機会を増やすのは「同じフェーズで
**互いに独立した**複数の問題を見つけた場合」に限られる。直前のタスクの直接の
帰結として問題が 1 件だけ出る場合には効かない。実例として
TASK-118（`cleanup-branches` が subagent worktree を削除できない）は TASK-112
が入れた後始末そのものが 動かなかったという TASK-112
の直接の帰結であり、TASK-112 のマージ後動作確認で
しか見つけようがないため、バッチ化しても同じイテレーションには入れられなかった。
したがってバッチ化は並列化の十分条件ではなく、供給不足を緩和する一手段として
扱う（area 粒度は TASK-114 で細分化済み、bug の絞り込み廃止は TASK-115
で対応済み。残る `src/main.ts` の分割など他の要因は上記調査の
「改善案」を参照）。なお bug の絞り込みを廃止した現在は、bug が 1
件しかないイテレーションでも area が非交差の非 bug 候補があれば並列に なりうる。

### 4.3 外側の自律ループ（ローカル実行・/agent-loop）

外側ループはローカルの Claude Code セッション自身が実行主体となって回す。 GitHub
Actions からセッションを起動する方式は用いない。手順は
`.claude/skills/agent-loop/SKILL.md`（`/agent-loop` スキル）に定義されており、
セッションは「`deno task next-tasks` で着手可能なタスク集合を判定（4.2 章）→
各タスクに claim タグを push して着手を宣言 → 集合内の各タスクを標準タスク
フロー（TDD・subagent 実装・mainagent レビュー）で実装（並列可なら同時に）→
タスクごとに個別 PR 作成（本文に `Closes #N` 必須）→ CI 監視 → green で
finalization → マージ（Issue は `Closes #N` の自動クローズで Done になる）→
次の集合へ」を人の指示なしで繰り返す。集合が単一タスクの場合は従来どおりの
直列フローと同一になる。finalization での Issue 本文の read-modify-write は AC
チェックの 1 回だけに限り、Implementation Plan / Notes / Final Summary は Issue
コメントに投稿する。

実装だけでなく、使い捨ての重い調査フェーズ — CI red の原因調査（手順 3）・
マージ後の動作確認（手順 4）・bug intake の重複確認と本文起草（手順 7）— も
**読み取り専用の subagent に委譲し、mainagent は結論のみを受け取る**（#231。
生ログ・走査結果を親のコンテキストに残すと以降の全ターンで再課金されるため。
実測は `docs/research/2026-08-11-agent-loop-context-boundary.md`）。これらの
subagent はファイルを編集しないため worktree isolation は付けない。外向き操作
（`gh issue create`・push・マージ）と 4.4.1 章のエスカレーション上限のカウンタ
追跡は mainagent 側に残し、subagent は事実（失敗内容が前回と同一か等）を
返すだけにする。各委譲の返却項目は `.claude/skills/agent-loop/SKILL.md` の
該当手順に定める。

CI や PR のステータスは、GitHub Actions のトリガーではなくセッション側が
監視する:

- PR activity 購読（`subscribe_pr_activity` 等の MCP）でレビューコメントや CI
  失敗イベントを受け取る。
- CI の完了は Monitor ツール（check-runs をポーリングし success / failure
  などの終端ステータスを検知するスクリプト）で監視する。フォアグラウンドの sleep
  待ちはしない。

安全ガード:

- 着手可能なタスクがない場合はループを終了する（claim 済みの進行中タスクが
  あればそれを再開する）。
- **二重着手ガードの権威は origin への claim タグ push**
  （`git push origin main:refs/tags/claim/issue-<N>`）。タグ ref への push は
  既存タグがあるとサーバ側で拒否されるため、push の成否がアトミックな
  compare-and-swap になる。拒否されたら他セッションが着手済みとしてその Issue
  をスキップする（claim への force push は禁止）。`status:in-progress`
  ラベルは人間向けの advisory 表示であり、権威ではない。
- 次タスクのブランチ `issue-N-*` が既に origin に存在する場合は状態を調査し、
  再開またはエスカレーションする。
- ループは同時に 1 セッションのみ。1 イテレーション = 1 タスク集合（各タスクは
  個別 PR）。claim 済みの進行中タスクが残っている間は新たな集合判定を
  開始しない。

起動はローカルセッションで `/agent-loop` を実行するだけでよい。停止は
セッションを止めるか、停止条件（全タスク完了・needs-human 起票）に達した
ときにループ自身が終了する。

**コンテキスト境界（supervisor モード。ADR-0036）:** マージ後の次タスク
継続は、従来の「同一セッションが同一コンテキストのまま次の集合判定へ進む」
方式に加え、**イテレーション境界でコンテキストを全量投棄して外部から
`/agent-loop` を再投入する supervisor 方式**を持つ。イテレーションをまたぐ
コンテキスト蓄積は N² で効く（実測: 1 タスクあたり永続残骸 R ≒ 40.9K tok、 9
タスクで 47K → 455K tok。
`docs/research/2026-08-11-agent-loop-context-boundary.md`）ため、herdr 配下で
ループを回す場合は supervisor モードを標準とする。環境変数
`ZEITREISE_LOOP_SUPERVISOR=1` 付きで起動されたセッションは、イテレーション
境界（進行中 claim ゼロ + bug intake 完了）で次の集合判定へ進まずターンを 終えて
idle になり、ホスト側の `scripts/loop_supervisor.sh` が idle/done を 検知して
`/clear` → `/agent-loop` 再投入でコンテキストを捨てて次の
イテレーションを開始する。ループの永続状態はすべて外部化済み（claim タグ・
Issue・git・PR）なので投棄しても再開に支障はない。環境変数なしのセッション
は従来どおり同一セッションで継続する（後方互換。この場合 supervisor を
併用してはならない）。終端動作・判定・起動手順の詳細は
`.claude/skills/agent-loop/SKILL.md` の「supervisor モード」節を参照。

`/code-review` はループ内で自律実行しない（`disable-model-invocation` で
エージェント起動不可・ループに挟むと HITL になるため）。全タスク完了時の
最終レポートでユーザーへ `/code-review`（対象＝このループで main にマージ
した一連の変更）の実行を促し、その指摘は bug intake で label `bug`
タスク化してループに還流する。このとき指摘は 1 件ずつではなく**全件を読み切って
からまとめて起票する**（2 章・4.2.1 章）。詳細は
`.claude/skills/agent-loop/SKILL.md`。

### 4.3.1 動作確認の標準（ヘッドレス Chrome + CDP）

自律ループ中の「マージ後の動作確認」（手順 4）を含め、ブラウザでの動作確認は
**ヘッドレス Chrome + CDP ハーネス（`scripts/verify/`）による無人スモーク
チェックを標準とする**。`claude-in-chrome` 拡張は可視ウィンドウが必須で、
ツール呼び出し毎に人間の承認確認（HITL）が発生し自律ループが頻繁に停止する
ため、ユーザーの実体感確認がどうしても必要な場合の最終手段に格下げする。
ハーネスは `deno task verify:smoke <dev サーバ URL>`
のように起動し（標準スモーク `scripts/verify/checks/smoke.ts`
はタスク定義に含まれる）、アプリ起動・年代切替・
クリック操作・エラートースト不在確認・スクリーンショット保存を任意の JS 評価と
CDP 経由の入力イベントで無人実行する。ヘッドレス実行の制約: (1)
`document.visibilityState` に依存する分岐は可視性に依存しないロジックへ
倒すこと（ヘッドレスでも "visible" 扱いになるとは限らない）、(2) 実 GPU
描画を使うため `--disable-gpu` は付けないこと（付けると canvas
描画・スクリーンショットが破綻する）、(3) `window.__getYear()`
はアプリ初期化完了前は初期値を返すレースがあるため、目的の値になるまで `waitFor`
で明示的に待つこと。

**リモート CDP モード（Issue #169。Phase 1 では使わない）**: 現行の Phase 1
（Mac mini ホスト直・4.5 章）ではこのモードを**使わない**。実 GPU を持つ macOS
ホスト上では `deno task verify:smoke` がローカル Chrome
（`scripts/verify/cdp.ts` の既定パス。`CHROME_BIN` で上書き可）の spawn で
完走することを実測済みで、`CDP_BROKER` は未設定のままにする。以下は Phase 3 で
実装セッションを pod へ戻したときに再び使う記述であり、実装
（`scripts/verify/cdp.ts`）とともに残してある（4.5 章「Phase 3（pod 移行）で
戻る構成」）。agent-loop セッションを Linux pod（kind on colima 等、実 GPU
描画を持たない環境）で動かす構成では、 環境変数 `CDP_BROKER` にホスト側
chrome-broker の HTTP ベース URL（例:
`http://192.168.5.2:8377`）を指定する。指定時、ハーネスはローカルで Chrome を
spawn せず、broker へ `POST /session` してセッション
（`{ id, webSocketDebuggerUrl }`）を取得し、ws URL の host を broker の host
へ書き換えて外部 Chrome の CDP エンドポイントに接続する（実 GPU 描画は ホスト側
Chrome が担う）。`close()` は `DELETE /session/{id}` で
セッションを破棄する（失敗時は broker 側 TTL の孤児掃除に委ねる）。broker
本体（launchd 常駐サービス）と plist は k8s-lab リポジトリ側の管理。
`CDP_BROKER` 未設定時は従来のローカル spawn のままで、フォールバック連鎖上の
位置づけも変わらない（ヘッドレス CDP［ローカル spawn またはリモート broker］→
機械的スモークチェック）。

Chrome を起動できない環境（バイナリ欠如・サンドボックス等でヘッドレス CDP も
claude-in-chrome も使えない場合）は、ビルド成果物・データ出力のスモーク
チェック（生成物の存在・件数・スキーマ等の機械的な確認）で代替する。検証
経路が無いことを理由に自律ループを停止したり HITL に落としたりしない
（フォールバック連鎖: ヘッドレス CDP → 機械的スモークチェック。TASK-64）。

最終手段として claude-in-chrome（可視ウィンドウ）を使う場合の運用（TASK-57）:

- 動作確認は**専用の Chrome ウィンドウ（MCP タブグループ）**で行い、
  ユーザーの普段遣いウィンドウにタブを足さない。
- `tabs_context_mcp {createIfEmpty: true}` は新規ウィンドウを作るとは
  限らず、**普段遣いウィンドウ内にタブグループができる場合がある**。その
  場合は対象タブを別ウィンドウへ切り離してから検証する。
- 地図タブが `visibilityState: hidden`（他ウィンドウの背後等）になると maplibre
  の rAF が停止し描画・検証がブロックされるため、**検証前に専用
  ウィンドウを前面化**する。
- 既存タブへの `navigate` を基本とし、タブ・ウィンドウを無駄に増やさない
  （タブの乱立は次回セッションの tabs_context 判断も汚す）。

### 4.3.2 単一セッションガードと暴走ジョブ復旧

ループは同時に 1 セッションのみ実行する（`.claude/skills/agent-loop/SKILL.md`
のガード）。ただしこのガードはセッション間で自動検知されないため、 `/agent-loop`
の開始・再開前には**単一セッション事前チェック**（origin の 直近 push・直近 PR
の mergedAt・reflog の異常・残存 dev サーバ）を必ず行う。 対話プロセスを kill
してもループが継続する場合は daemon ホストの
ヘッドレスジョブ（自己起床）を疑う。事前チェックの詳細・検知・停止・
静穏確認の手順、および subagent の git 操作制約（worktree 外への コミット/push
禁止）は `docs/agent-loop-recovery.md` を参照（TASK-59。 2026-07-24〜25
のインシデント記録を含む）。

### 4.3.3 マージ後の後始末（refs の掃除）

自律ループは 1 タスクにつきタスクブランチ 1 本と subagent の worktree isolation
用ブランチ（`worktree-agent-*`）、着手宣言の claim タグ
（`refs/tags/claim/issue-<N>`。4.3 章）を作る。マージ後にこれらを消さないと
refs・worktree が単調増加し、ブランチ一覧や worktree の状態把握といった日常の
git 操作の見通しが劣化するうえ、掃除漏れの claim タグ・ブランチは「進行中に
見えるゴミ」として二重着手判定や不整合調査のノイズになる。（歴史的経緯:
掃除を仕組み化した当初の動機は backlog.md のクロスブランチ走査で、refs 285 本
（うち 279 本がマージ済み）まで膨らんだ結果 `backlog board` が 12.7 秒かかる
状態になった（TASK-112。調査レポート（旧
`.outputs/claude/backlog-board-slowdown.md`）は git 管理外だったため現存せず
復元しない。実測値は本節と `docs/archive/backlog-tasks/` の TASK-112
本文に残る。所在は `docs/research/README.md` の「失われた調査レポート」節）。
backlog.md は撤去済みでこの劣化自体は再発しないが、refs
を溜めない運用は上記の理由で継続する。）

そのため **1 タスクのマージが完了するたびに `deno task cleanup-branches --apply`
を実行する**（`/agent-loop` 手順 5）。実装は `scripts/cleanup_branches.ts` で、
`git fetch --prune` → `git worktree remove` / `git worktree prune` →
`git branch -d` → クローズ済み Issue の claim タグ削除
（`git push origin --delete refs/tags/claim/issue-<N>`）を 1 回で行い、
`refsBefore` / `refsAfter` と削除した claim タグの Issue 番号 `claimTags` を
含む JSON を返す。`refsAfter` がイテレーションをまたいで単調増加していない
ことが、後始末が効いていることの確認になる。

複数の worktree が同時に存在する運用（mainagent のセッション worktree ＋ 実行中
subagent の worktree）のため、**他セッションのものを誤って消さない**
ことを最優先に設計している。ブランチ削除に `-D` は使わず、git が拒否した削除は
skipped として理由付きで報告する。加えて削除対象を次の条件で絞る:

- loop が生成した名前のみ（ブランチ `task-<N>-*`（移行前）/ `issue-<N>-*` /
  `worktree-agent-*`、 worktree は `.claude/worktrees/` 配下）。人手の
  `feat/*`・`docs/*` ブランチ、 セッション worktree（`<repo>@feat-*`）、main
  worktree は対象外。
- origin/main にマージ済みのブランチのみ。
- どこかの worktree にチェックアウト中のブランチは対象外（同じ実行で削除する
  worktree の分だけは解放されるものとして扱う）。
- `locked` な worktree（実行中の subagent が保持）と自分自身の worktree は
  対象外。
- **tip が origin/main と同一のブランチは対象外**。着手直後でまだコミットが
  無いタスクブランチは `git branch --merged origin/main` に載ってしまうため、
  この条件が無いと他セッションが実装中のブランチを消す事故が起きる。

この最後の条件は「main がまだ進んでいない間」しか効かない（別 PR のマージで main
が進むと、コミットの無い in-flight ブランチも tip != origin/main になる）。
ただし該当するのはコミットが 1 つも無いブランチだけなので失われる作業は無く、
同名ブランチを作り直せば復帰できる。逆に `worktree-agent-*` はそもそも
コミットを持たない足場ブランチなので、この条件により削除が 1
イテレーション遅れる（TASK-118 で `--force` による回収を入れたあとも、この 1
イテレーション遅れは変わらない）。いずれも steady state のブランチ数は「1
イテレーションぶん」で頭打ちになり、単調増加はしない。

判定ロジックは純粋関数（`planCleanup` / `canForceRemoveWorktree` /
`parseWorktreeList` / `parseMergedBranches` / `parseClaimTagNumbers` /
`planClaimTagCleanup`）に切り出し、 `scripts/cleanup_branches_test.ts`
でネットワーク・git 非依存の単体テストを 持つ。

#### claim タグの掃除と loop-doctor（TASK-141 / #165）

claim タグ掃除の安全条件はブランチ削除と同じ発想の保守設計にする: 削除する のは
**gh でクローズ済みと確認できた Issue の claim だけ**で、open な Issue の
claim（着手中の権威そのもの）は絶対に消さない。Issue 一覧に現れない番号の claim
も「一覧の取り漏れ」と区別できないため消さず、skipped として理由付きで
報告する。`--no-fetch` 時と gh / `git ls-remote` が失敗した場合は claim 掃除
だけをスキップし、ブランチ・worktree の掃除は巻き添えにしない。

Issue 移行で着手〜クローズがアトミックでなくなった代償として、不整合の検出・
修復は `deno task loop-doctor`（`scripts/loop_doctor.ts`）が明示的に担う。
検査パターンは (1) open なのに `Closes #N` 指定 PR がマージ済み、(2) closed
なのに AC 未チェック、(3) claim タグ残存、(4) `status:in-progress` ラベルと
claim タグの不一致。診断は純粋関数 `diagnose` に切り出してフィクスチャ JSON で
テストし（`scripts/loop_doctor_test.ts`）、`--issues-json` / `--prs-json` /
`--claims` で gh / git 非依存に入力を注入できる。dry-run 既定・`--apply` で
修復可能なもの（閉じた Issue の claim タグ削除・advisory ラベルの整合。権威は
常に claim タグ側）だけを修復し、(1)(2) は判断を要するため検出のみとする。

#### subagent worktree の dirty は常態として扱う（TASK-118）

subagent には「commit / push はしない。ファイル変更のみ行い報告する」と
指示しているため、mainagent がパッチを取り出したあとの subagent worktree は
**必ず未コミットの変更を抱えたまま終わる**。TASK-112 は `git worktree remove` の
dirty 拒否を安全装置に据えたが、この運用では dirty は異常ではなく常態
なので安全装置が常に発動し、worktree の削除が一切進まなかった（実測: 7 タスク
処理後の `--apply` で 8 件すべて拒否・`worktree-agent-*` が 9 本残存）。
そのため次の二段構えに改めた。

1. **通常経路（mainagent の手順）**: subagent の成果をパッチとして取り出した
   直後に `git -C <wt> reset --hard HEAD && git -C <wt> clean -fd` で worktree
   を元に戻す（`-x` は付けない。ignored ファイルが残っていても
   `git worktree remove` は通る）。これで `--force` なしで削除できる。手順は
   `.claude/skills/agent-loop/SKILL.md` の手順 2 に定義する。
2. **取りこぼしの回収（スクリプト）**: 1 を忘れた・subagent が異常終了した等で
   dirty なまま残った worktree を回収するため、通常の `git worktree remove` が
   拒否された場合に限り `--force` で再試行する。許すのは
   `canForceRemoveWorktree` が真、すなわち次を**すべて**満たすものだけ:
   `.claude/worktrees/` 配下・`locked` でない・自分自身の worktree でない・
   チェックアウト中のブランチが `worktree-agent-*`。

`--force` の範囲を「loop が生成した使い捨ての足場」に厳密に限定するのが要点で、
subagent の成果は mainagent がパッチとして取り出し済みなので worktree に残る
変更は複製にすぎず、失われるものは無い。逆に agent worktree であっても detached
や `task-N-*` がチェックアウトされている場合は loop の足場ではないため `--force`
の対象外とし、従来どおり git の拒否を尊重して skipped に残す。
**この限定が崩れると他セッションの作業を破壊する**ため、条件を緩める変更は
`scripts/cleanup_branches_test.ts` の `canForceRemoveWorktree` テストと本章・
decision-24 の更新をセットで行う。

### 4.4 エスカレーション規約（人の介入は例外時のみ）

エージェントは次のいずれかに該当する場合のみ、`needs-human` ラベル付きの GitHub
issue を起票して作業を停止し、人の判断を仰ぐ。それ以外で人の指示を
待ってはならない。

- タスクの Acceptance Criteria が曖昧で、複数の解釈がありどれを選ぶかで
  成果物が大きく変わる場合
- CI が恒常的に red で、タスクのスコープ内の修正では解消できない場合
- 仕様・アーキテクチャ・運用に関わる判断（外部サービス契約、秘密情報の設定、
  破壊的変更など）が必要な場合

issue には「何がブロックしているか」「検討した選択肢」「推奨案」を書き、 人は
issue 上で判断を返す。判断が返ったらエージェントがタスクを再開する。

### 4.4.1 エスカレーション上限（設定値）

上記の定性基準（AC 曖昧・CI 恒常 red・仕様判断）に加え、実装難航の兆候を
定量的に検知するため、以下の上限値を設ける。**同一タスクについていずれか
一つでも超過した時点で**、実装の途中経過に関わらず、4.4
章冒頭のフォーマット（何がブロックしているか・検討した選択肢・推奨案）に 従って
`needs-human` ラベル付き issue を起票し、ループを停止する。

| 設定値                               | 上限                                                                       | 根拠                                                                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| CI red 連続回数（同一タスク）        | 3 回                                                                       | 正常タスクは 1〜2 回で green 収束（本リポジトリ実績）。3 連続は構造的問題の兆候                                                    |
| 実装 subagent 試行回数（同一タスク） | 5 回                                                                       | 正常タスクは 1〜3 起動で収束。5 回は再委譲では解決しない兆候                                                                       |
| タスク着手からの経過時間             | 24 時間                                                                    | 1 タスクは通常数時間以内。外部ブロック（環境・人待ち）と区別するため、待機時間はループが「ブロック中」と明示している場合は除外する |
| 停滞検出                             | 同一テストの失敗が 3 回連続、または直近 2 回の修正 push の diff が実質同一 | 「失敗内容が変化する試行錯誤」と「同じ失敗の反復」を区別する                                                                       |

判定手順:

- ループは各タスクについて CI red 連続回数・subagent 起動回数・着手時刻・
  直近の失敗テスト内容と修正 diff を追跡し、集合内の全タスクを通じて
  イテレーションのたびに上表の上限と照合する。
- いずれか一つでも超過した場合、それが定性基準（4.4 章冒頭）のどれに
  実質該当するかを判断せず、**上限超過そのものを起票理由**として issue
  化し、直ちにループを停止する（超過後も実装を継続してはならない）。
- 「ブロック中」であることをループ自身が明示している期間（外部サービス
  応答待ち・人の判断待ちなど）は経過時間の上限から除外する。除外した場合は issue
  にその旨と除外区間を明記する。
- 上限値は運用しながら調整可能な設定値であり、変更する場合はこの表のみを
  更新すればよい。`.claude/skills/agent-loop/SKILL.md` および `CLAUDE.md`
  はこの表を参照するのみで値を重複定義しないため、他文書の追随作業は
  不要である。

### 4.5 二拠点運用モデル（Phase 1: Mac mini ホスト常駐・単一セッション）

外出先からスマホでも開発を進められるよう、開発環境は「常駐実行 = Mac mini /
起票・観察 = MacBook・スマホ」の二拠点構成を前提とする（Issue #170。移行前の
経緯は TASK-156）。実行形態は k8s-lab 側のフェーズ再構成（ishii1648/k8s-lab#16）
により段階移行中で、**pod 化は最後（Phase 3）に回された**。本節は**現行の Phase
1（Mac mini ホスト直・herdr・単一 claude セッション）を正**として記述し、Phase 3
で戻る構成は末尾の「Phase 3（pod 移行）で戻る構成」節に残す（Issue #226）。

| 役割                                  | 実行場所（Phase 1）                                                                                                | 備考                                                                                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 実装・ループ（agent-loop セッション） | Mac mini の**ホスト上**（pod は使わない）。herdr のセッション／pane に常駐させる                                   | 実 GPU を持つ macOS ホストなので CDP 動作確認はローカル Chrome を直接 spawn する（`CDP_BROKER` は未設定。4.3.1 章）。コンテキスト境界は supervisor モードが標準（4.3 章・ADR-0036）                     |
| 起票・状況確認（intake）              | PC 作業時は MacBook。外出時はスマホ → Tailscale → Mac mini ホストの herdr セッション、または GitHub モバイルアプリ | タスクは GitHub Issue に一元化済みのため、起票はサーバ側 API への書き込みで完結し、どのマシンから行っても同期の考慮は不要。**Phase 1 では intake も実装と同一の claude セッション（main agent）が担う** |
| スマホでの見た目確認                  | Cloudflare 本番デプロイの URL（TASK-127 系）                                                                       | Mac mini 上の dev サーバへスマホから直接接続しない                                                                                                                                                      |

**スコープ:** 本節はこのリポジトリの開発フローに関わる運用ルール（役割分担・
資源専有・接続手順・triage フロー）のみを定める。Mac mini のホスト構築
（Tailscale・herdr の導入と常駐・Chrome の導入。Phase 3 で復活する launchd
常駐の chrome-broker 等を含む）や k8s マニフェスト・pod イメージそのものは
k8s-lab / dotfiles リポジトリの管轄であり、本 doc の範囲外とする。

#### 書き込み権限の分離（単一セッション構成での担保）

Phase 1 は intake と実装オーケストレーションを**同一 claude セッションの main
agent が兼ねる**ため、旧構成（pod = 実装 / ホスト = intake）の「セッション単位の
権限分離」はそのままでは成立しない。代わりに次の 3 層で担保する。

1. **二重着手の権威はサーバ側の claim タグ CAS**（4.3 章）。着手宣言は
   `git push origin main:refs/tags/claim/issue-<N>` であり、既存タグがあれば
   サーバ側が push を拒否するアトミックな compare-and-swap である。したがって
   「ループは同時に 1 セッションのみ」の実効的な担保は、**セッションの実行場所
   （pod 固定）ではなく claim タグの CAS** である。Phase 1 でセッションが Mac
   mini ホストに 1 本だけ常駐しているのは運用上の前提にすぎず、権威では
   ない。人手の並行起動に対する事前検知は 4.3.2 章の単一セッション事前チェック
   が担い、事後の不整合検出・修復は `deno task loop-doctor`（4.3.3 章）が担う。
   `status:in-progress` ラベルは従来どおり advisory 表示にすぎない。
2. **セッション内では「外向き操作 = main agent の専権 / subagent = ファイル編集
   のみ」で分離する。** claim タグ push・`status:in-progress` の付け外し・AC
   チェック（Issue 本文の read-modify-write）・PR
   作成・マージ・`gh issue create` といった**リポジトリ外部（origin /
   GitHub）への書き込みはすべて main agent が 行う**。実装 subagent は worktree
   isolation 下でファイルを変更するだけで、 **commit / push
   をしてはならない**（成果は main agent がパッチとして取り出す。 4.3.3
   章・ADR-0024・`.claude/skills/agent-loop/SKILL.md` 手順 2）。調査 subagent
   は読み取り専用で、worktree isolation も付けない（4.3 章）。これに
   より、外向きの書き込み主体はセッションあたり常に 1 つ（main agent）に保たれ、
   並列 subagent が増えても claim・ステータス遷移の一意性は崩れない。
3. **起票・triage
   と実装ステータス遷移は「イテレーション境界」で時間的に分ける。** 同一 main
   agent が両方を行うため、旧構成の空間的な分離（別セッション）を時間的
   な分離に置き換える。起票（bug intake・`triage` Issue の正式化）を行うのは
   **イテレーション境界（進行中 claim ゼロ + 起票完了）に限る**（4.3 章の
   supervisor 境界と同一の点。ADR-0036）。この時点では claim
   済みの進行中タスクが無いため、 Issue
   の新規作成・ラベル編集が実行中タスクの選定や二重着手判定と干渉しない。
   イテレーション途中で思いつきの起票を挟まない規律は、bug 起票のバッチ化
   （4.2.1 章）としてすでに定めたものと同じである。

#### 資源の専有（serve の既定ポート 8000）

- Phase 1 は実装も確認も同一ホスト・同一セッションなので、`deno task serve` の
  既定ポート 8000 は**マージ後動作確認（4.3.1 章）のハーネスが専有する**。
  intake 用に別の dev サーバを常時立てる理由は無い。
- それでも 2 つ目の配信が必要な場合（別ビルドの比較など）は、`--port` で明示的に
  分離する（例: `deno task serve --port 8100`）か `--auto-port` で空きポートへ
  逃がす。既定は占有時に黙って別ポートへ逃げず占有プロセスと対処を表示して終了
  する（TASK-89。README の「dev サーバの後始末」）ため、ポートの奪い合いが暗黙に
  隠れることはない。
- **残存 dev サーバは旧ビルドを配信して動作確認を誤判定させる**ため、確認後は
  必ず停止する。残存の検知は 4.3.2 章の単一セッション事前チェックと
  `docs/agent-loop-recovery.md` にも含まれる。

#### スマホからの接続手順（外出時の intake）

1. スマホの Tailscale アプリで tailnet に接続する（Mac mini は同一 tailnet に
   常駐している前提。ホスト側の常駐設定は k8s-lab / dotfiles 管轄）。
2. ターミナルクライアントから `herdr --remote <mac-mini> --session intake` で
   ホスト側のセッションに attach する。**クライアントを落としても `herdr server`
   はホスト側で生き残り**（`herdr session list` が `status: running` を維持し、
   workspace / tab / pane / cwd も保持される）、回線の切断・IP
   変化に耐えるため、 mosh + tmux のような組み合わせを別途用意する必要はない。
3. 回っている agent-loop の様子を見たい場合は、同じ herdr セッションのループ用
   pane を開く。**観察（read-only）に限る**。Phase 1 では観察対象の pane が
   ループ本体そのものなので、プロンプト投入はそのまま介入になる（介入が必要な
   事態は 4.4 章のエスカレーションで扱う）。supervisor が動いている場合は
   `/clear` 注入とレースするため、境界以外での入力は特に避ける（ADR-0036）。
4. 見た目の確認はスマホのブラウザで Cloudflare 本番デプロイの URL を開く。

#### 未整形 Issue の triage フロー

外出先では正式な起票品質（重複確認・LOOP-META・AC 記法・area ラベル。2 章と
`task-intake` スキル）を満たすのが難しいため、起票を二段階に分ける。

1. **雑起票（GitHub モバイルアプリ）**: 思いついた時点でスマホの GitHub
   モバイルアプリから Issue を起票し、ラベルは `triage` のみを付ける。 **`task`
   ラベルは付けない** — `task` の無い Issue は `deno task next-tasks`
   の選定候補に入らないため（`scripts/task_source.ts`）、未整形のまま agent-loop
   に拾われることがない。本文はメモ書きで構わない。
2. **正式化（イテレーション境界の main agent）**: 後で
   `gh issue list --label triage` で未整形 Issue を洗い出し、`task-intake`
   スキルの手順（重複確認 → 本文を LOOP-META・Description・AC 規約へ整形 → area
   ラベル付与）で正式化する。重複していれば既存 Issue 番号を示して not planned
   でクローズする。正式化したら `task` ラベルを付与して `triage`
   を外す。この時点で初めて選定候補に入る。Phase 1 ではこの正式化も実装と同じ
   セッションの main agent が行うため、**実行するのはイテレーション境界に限る**
   （上記「書き込み権限の分離」3）。対象が `task` ラベルの付く前の Issue で
   あることは変わらず、進行中タスクのステータス遷移には触れない。

`triage` ラベルの定義は他の固定ラベルと同様 `deno task setup-issue-labels`
（`scripts/setup-issue-labels.ts`）が同期する。

#### Phase 3（pod 移行）で戻る構成

k8s-lab のフェーズ再構成（ishii1648/k8s-lab#16）では pod 化が最後（Phase 3）に
置かれている。Phase 3 で実装セッションを Mac mini 上の k8s pod（kind on colima）
へ移すと、本節の前提は次のように戻る。関連する実装・記述を消さずに残してあるのは
このためである。

- **実行場所**: ホスト直 → pod（マニフェスト・イメージは k8s-lab 管轄）。
- **CDP 動作確認**: ローカル Chrome の直接 spawn → `CDP_BROKER` によるホスト側
  chrome-broker への委譲（4.3.1 章のリモート CDP モード。Issue #169 で実装済みで
  `scripts/verify/cdp.ts` に残っている）。
- **セッション構成**: 単一セッション → 実装（pod）と intake（ホスト）の 2
  セッション。このとき「書き込み権限の分離」には上記 3 層に**セッション境界が
  加わる**: intake セッションは起票と参照に限定し、claim タグ push・
  `status:in-progress` ラベル操作・AC チェック・実装コミット / push を行わない
  （Issue #170 の規定）。ただし**権威は Phase 1 と同じく claim タグの CAS の
  ままとする**（pod 固定はガードの補強であって権威ではない）。
- **接続**: herdr でホストへ入る点は変わらず、ループの観察はホストから
  `kubectl exec -it <agent-loop-pod> -- ...` 等で pod 内のセッションを見る形に
  なる（観察は read-only）。

移行の際は本節と 4.3.1 章を Phase 3 の実態へ更新する。

## 5. 旧 backlog.md 資産の扱い

タスク管理は GitHub Issue へ移行済みで、`backlog` CLI は使わない
（docs/adr/0031・TASK-140）。移行前のタスク markdown は
`docs/archive/backlog-tasks/` に凍結アーカイブされており（TASK-N →
ファイル名の索引は同ディレクトリの README）、読み取り専用の歴史的記録として
参照する（起票・編集・復活はしない）。移行時点で未終端だったタスクは
`scripts/migrate-tasks-to-issues.ts` で Issue 化され、アーカイブ側 md の
「移行先: #N」と Issue 本文末尾の旧 ID・アーカイブパスで相互リンクされている。
`backlog/config.yml`・board export の `Backlog.md` 等の残骸は撤去済みで、
リポジトリに backlog.md の設定・成果物は残っていない（Issue #171）。

## 6. branch protection 設定手順

main ブランチで CI 必須チェックと PR
必須をまだ設定していない場合、リポジトリ管理権限を持つユーザが以下を実行する（`gh`
CLI が必要）。

```bash
printf '%s' '{"required_status_checks":{"strict":true,"contexts":["ci"]},"enforce_admins":true,"required_pull_request_reviews":{"required_approving_review_count":0},"restrictions":null}' \
  | gh api -X PUT repos/{owner}/{repo}/branches/main/protection \
      -H "Accept: application/vnd.github+json" --input -
```

- `gh api` の `-f`/`-F` はドット記法をネスト展開しないため、ネストした設定は
  `--input` で JSON ボディを渡す。
- `required_status_checks.contexts` には `.github/workflows/ci.yml` のジョブ名
  `ci` を指定する。
- 権限不足で失敗する場合は、GitHub リポジトリの Settings > Branches
  からブラウザ上で同等の設定（Require status checks to pass: `ci`、Require a
  pull request before merging）を行う。

## 7. GitHub Actions の外部 action ピン留め

`.github/workflows/` のワークフローで外部 action
を追加・更新する際は、タグ（`@v4` など可変参照）ではなく**フルコミット SHA（40
桁）で固定**し、対応するバージョンを
コメントで併記する。タグは後から別コミットへ付け替え可能なため、タグ固定のままだと
タグ乗っ取りによるサプライチェーン攻撃を受けうる（SHA は不変なので固定できる）。

```yaml
# 良い例（SHA 固定 + バージョンコメント）
uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
uses: denoland/setup-deno@22d081ff2d3a40755e97629de92e3bcbfa7cf2ed # v2.0.5

# 悪い例（可変タグ参照）
uses: actions/checkout@v4
```

- SHA はタグ/ブランチが指す実体を GitHub API で取得する（例:
  `gh api repos/actions/checkout/git/ref/tags/v4 --jq .object.sha`。annotated
  tag で `object.type` が `tag` の場合は
  `gh api repos/<owner>/<repo>/git/tags/<sha>` で さらに deref する）。取得した
  SHA が対象バージョンに対応することを確認してから
  コメントのバージョンを記載する。
- action を更新する際は SHA とコメントのバージョンを同時に書き換える。Dependabot
  等で更新する場合も SHA 固定＋コメント併記の形式を維持する。
