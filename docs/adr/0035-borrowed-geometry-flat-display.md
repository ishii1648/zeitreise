---
status: accepted
date: '2026-08-11'
---

# decision-35: 借用ジオメトリの表示は差引済み flat 派生物とする（ADR-0033 の追補）

## Context

ADR-0033 は隣接年からの流用（借用）を「借用元の座標を 1 頂点も変えない」
条件付きで認めた。当初の実装はこの条件を「借用面を差引パイプラインに一切
通さない」と解釈し、借用ファイルをそのまま配信・描画していた。その結果、
借用面が覆った既存領邦がピック不能になり（1492 年の County of Schaunberg は
99.7% 被覆）、系統間の差引漏れで二重塗り・誤ピックが生じた（#215）。

既存の全 7 系統は build-fief-flat の差引（同一レイヤー内の keep-smaller・
系統間の subtractOverlay）を通した flat 派生物を表示しており、借用面だけが
例外だった。

## Decision

- 借用面も既存系統と同じく **差引済みの flat 派生物**
  （`data/borrowed_<lineage>_flat_<year>.geojson`、build-fief-flat が生成）を
  配信・描画する。差引の向きは「借用面**から**ホスト系統 flat の全 feature を
  引く」: 既存領邦は 1 頂点も変わらず、広域な借用面側に穴が空く
  （keep-smaller と同じ「より個別性の高い情報を残す」原則）。
- **ADR-0033 の「座標を 1 頂点も変えない」条件は借用元ファイル
  （`borrowed_<lineage>_<year>.geojson`）に対して維持する。** 借用元は座標
  無改変の中間生成物として残し（検証テストも不変）、flat 派生物の生成は
  既存 7 系統の raw → flat と同じ扱いとする。
- sovereign 等の他系統との重なりは、既存の系統間差引
  （buildSovereignFiefFlat の externalPaths）に借用 flat を加えて解消する。
- 差し引かない残余（例: 手描き地図由来で借用面より 4〜7 倍粗い Cliopatria
  との重なり）は、粗い側を上に載せる削りが情報を減らすため意図的に残し、
  known-limitations で定量開示する。

## Consequences

- 借用面が覆っていた既存領邦のピック・表示が回復し、系統間の二重塗りが
  解消される（#215 の生成物テストが契約として固定）。
- 表示される借用面は「流用元の複製そのもの」ではなく「複製から既存区画を
  くり抜いた派生物」になる。トレーサビリティは flat 側 metadata
  （input / externalRemovals / borrowedFrom）で保たれる。
- 今後の借用追加（ADR-0033 の条件を満たす新規流用）は、build-borrowed-fiefs
  への登録に加えて build-fief-flat の借用 flat 生成対象に自動的に含まれる
  （許可リスト BORROWED_FEATURES から年集合を導出）。
