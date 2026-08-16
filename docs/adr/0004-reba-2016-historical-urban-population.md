---
status: superseded
date: '2026-07-21 15:52'
---

# decision-4: 都市データに Reba et al. 2016 Historical Urban Population（CC BY 4.0）を採用

> **置き換え:** #222 で都市データの主ソースと選定方式が変更されたため、
> 本決定は ADR-0043 に置き換えられた。以下は当時の決定として保持する。

## Context

各年代スナップショットの主要都市を表示するため、歴史的都市の位置・人口データが必要だった。既存データソース（historical-basemaps / ETH Roller）には都市位置が含まれない（TASK-27）。

## Decision

Reba et al. 2016「Historical Urban Population 3700BC-AD2000」（Chandler/Modelski のデジタル化・CC BY 4.0）をコミット固定で採用し、scripts/build-cities.ts で各スナップショット年の欧州域内・人口上位 20 都市を抽出して data/cities.json を生成する。手作業キュレーションは代替案として検討したが、出典のある実データが取得できたため不採用。

## Consequences

- 全 20 年代 × 20 都市が出典付きで再現可能に生成される（CC BY 4.0 のため帰属表示をフッターに明記）。
- 「主要都市」の基準は人口上位に一本化され、恣意的な都市選定を避けられる。
- 都市名は英語で保持し、日本語表記は表示層で適用する（decision-6 参照）。
- 関連タスク: TASK-27
- 後継決定: ADR-0043（Buringh 2021 を主ソースとするハイブリッド方式）
