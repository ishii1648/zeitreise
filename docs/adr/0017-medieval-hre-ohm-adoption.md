---
status: accepted
date: '2026-07-26 13:55'
---

# decision-17: 中世 HRE・イタリア領邦は OHM（CC0）を採用し、1500〜1700 の HRE は Roller を維持する

## Context

TASK-37（2026-07-23）は「900〜1492 年の HRE 領邦を表示できるオープンデータは存在しない」と結論したが、これは OHM Wiki の自己申告に基づくもので実クエリを投げていなかった。TASK-70 で OHM 取得パイプラインが整った後の実測（帝国中核域 bbox の boundary=administrative 34,005 件）で、1000〜1492 年に有効な領邦データが実在することを確認し、TASK-85 で取り込んだ（TASK-37 の結論を訂正）。

## Decision

中世年代（1000〜1492 の 7 スナップショット）の HRE 領邦は OpenHistoricalMap（CC0 1.0）を出典とし、data/hre_fiefs_<year>.geojson として独立生成する。1500〜1700 の Roller（ETH Zürich, CC BY-NC-SA 4.0）は置き換えず併存する: Roller は査読済み学術データで属性が厚く、同一ソースの時系列として年代間の形状が整合するため。900 年は帝国成立（962 年）前かつ有効 6 件のみのため生成しない。許可リストは admin_level 4/5 に限定（2=主権国家・3=構成王国は配下領邦と二重塗りになるため除外）し、除外理由の二重防波堤（hreFiefExclusionReason）を置く。

現在、OHM 由来 HRE 系列の対象は `src/config.ts` の `HRE_FIEF_OVERLAY_YEARS` が定める 10 年代（1000 / 1100 / 1200 / 1279 / 1300 / 1400 / 1492 / 1715 / 1783 / 1800）である。1715 / 1783 / 1800 の採用は、Roller が終了した後を OHM で補うという新たなデータソース採否なので、本 Decision の書き換えではなく追補 ADR-0044 が定める。年集合の正は `HRE_FIEF_OVERLAY_YEARS` であり、この列挙は現在値の写しである。

### 追記（TASK-95, 2026-07-27）

中世イタリアの諸侯・都市共和国も同じ OHM（CC0）から取得し、data/italy_fiefs_<year>.geojson の独立系統として生成する。hre_fiefs へ混ぜないのは、イタリアのコムーネは帰属が単一でなく（名目上は帝国構成王国内だが実態は半独立）、SUBJECTO=Holy Roman Empire 固定の hre_fiefs と噛み合わないため。地域系統（france / hre / italy）はそれぞれ専用 bbox・許可リスト・除外規則を持つ独立ファイルとし、共通ロジックのみ共有する構成を標準とする。

現在の対象は `src/config.ts` の `ITALY_FIEF_OVERLAY_YEARS` が定める 8 年代（1000 / 1100 / 1200 / 1279 / 1300 / 1400 / 1492 / 1500）である。#188 で追加した 1500 年は、同じ OHM 系統・選抜規則を base の一括塗りが残る年へ適用したもので、新たな方式・採否ではないため本 ADR の適用結果として改訂した（#354）。年集合の正は `ITALY_FIEF_OVERLAY_YEARS` であり、この列挙は現在値の写しである。

## Consequences

- 中世年代の領邦オーバーレイ表示（別タスク）のデータ側が整う。1492 と 1500 の間で出典が変わり形状が飛ぶ可能性は既知（表示タスクで扱いを判断）。
- OHM は CC0 のためライセンス混合の制約なし。出典管理は data 系列（hre_fiefs_* vs hre_*）で分離。
- OHM の収録は編集途上であり、年代による粒度差（1200 年の谷 = 部族大公領解体後の移行期）はデータの性質として受け入れ、必要に応じ known-limitations で明示する。
- 関連タスク: TASK-37, TASK-70, TASK-85, TASK-95, #188 / 関連 decision: decision-14（出典なき補完はしない）、decision-44（Roller 終了後の OHM 採用）
