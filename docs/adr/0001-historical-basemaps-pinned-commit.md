---
status: accepted
date: '2026-07-21 15:52'
---

# decision-1: 勢力圏データソースに aourednik/historical-basemaps をコミット固定で採用

## Context

勢力圏（国境）ポリゴンの時系列データとして、年代別 world GeoJSON を提供するオープンデータが必要だった（TASK-2）。上流リポジトリは随時更新されるため、参照が動くと成果物の再現性が失われる。

## Decision

aourednik/historical-basemaps を勢力圏データソースとして採用し、取得元コミットを `SOURCE_COMMIT=62d8f1a03a71f2d3ff17f2d166f7553f256bce68` としてスクリプト（scripts/build-data.ts）内に固定する。`src/config.ts` の `SNAPSHOT_YEARS` が定める 1000〜1914 年の 19 年代（1000 / 1100 / 1200 / 1279 / 1300 / 1400 / 1492 / 1500 / 1530 / 1600 / 1650 / 1700 / 1715 / 1783 / 1800 / 1815 / 1880 / 1900 / 1914）をヨーロッパ bbox（N34-72°, W25°-E60°）でクリップ・simplify して data/europe_<year>.geojson を生成・コミットする。年集合の正は `SNAPSHOT_YEARS` であり、この列挙は現在値の写しである。

当初は 900 年を含む 20 年代だったが、TASK-119 で 900 年スナップショットを廃止した。これは historical-basemaps のコミット固定採用という決定を変えず、適用対象だけを変更したため、本 ADR を現状へ改訂した（#354）。

## Consequences

- 同一入力から常に同一出力が得られ、data/ 成果物の再現性が保たれる（data/index.json に repo / commit / license を記録）。
- GPL-3.0 由来のため、リポジトリの LICENSE は GPL-3.0 とし出典を README に明記。派生データの扱いは decision-2 の分離方針に影響する。
- 上流の更新（境界修正等）は自動では取り込まれず、コミット固定値の明示的な更新が必要。
- 関連タスク: TASK-2
