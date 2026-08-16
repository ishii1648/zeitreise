---
status: accepted
date: '2026-07-21 15:52'
---

# decision-2: HRE 領邦データ（ETH Zürich Roller・CC BY-NC-SA）は GPL 派生データとファイル分離

## Context

historical-basemaps は神聖ローマ帝国（HRE）を単一 feature で表現しており、内部領邦を表示できない。調査の結果、HRE 領邦粒度を満たす唯一のオープンデータは ETH Zürich の Roller データセット（DOI 10.3929/ethz-b-000472583）だったが、ライセンスが CC BY-NC-SA 4.0 で NC（非営利）条項を含む（TASK-19）。リポジトリ本体は GPL-3.0 派生データ（decision-1）を含む。

## Decision

CC BY-NC-SA の Roller データは GPL-3.0 派生の data/europe_<year>.geojson に統合せず、別ファイル data/hre_<year>.geojson のオーバーレイとして分離する。対象は `src/config.ts` の `HRE_OVERLAY_YEARS` が定める 5 年代（1500 / 1530 / 1600 / 1650 / 1700）で、`data/hre_1700.geojson` も Roller の 1650 年境界を外挿した同じ分離系列である。年集合の正は `HRE_OVERLAY_YEARS` であり、この列挙は現在値の写しである。コレクション（集合著作物）扱いとし、削除・差し替えが可能な可逆構成を保つ。出典・ライセンスはフッターに DOI リンク付きで明記する。

当初の対象は 1500〜1650 の 4 年代だったが、TASK-68 で 1700 年を追加した。これはライセンス分離という決定を変えず、適用対象だけを変更したため、本 ADR を現状へ改訂した（#354）。

## Consequences

- ライセンス非互換（NC 条項と GPL）の混合を回避しつつ、HRE 領邦表示を実現できる。
- NC 条項により、本プロジェクトの利用は非営利範囲に制約される（該当データを削除すれば解除可能な構成）。
- 今後ライセンスが非互換な外部データを追加する場合も、同様に「別ファイル分離 + フッター出典明記」を先例とする。
- 関連タスク: TASK-19
