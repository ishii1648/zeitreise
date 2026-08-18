---
status: accepted
date: '2026-08-18'
---

# decision-44: 同年面が政体モデルと意味論的に両立しない場合の限定除外

## Context

モルダヴィア公国は1359〜1859年に存続するが、baseでは1492〜1800年に
Poland-LithuaniaまたはOttoman Empireへ吸収される。Cliopatria v0.2.0には
対象年を直接覆う出典付き面がある。一方、1600〜1601年面（256,733km²）は
ミハイ勇敢公が短期間支配したモルダヴィア・ワラキア・トランシルヴァニアを
`Principality of Moldavia` 一枚にまとめ、同君連合を構成政体の領土統合として
扱わないアプリのモデルと両立しない。

## Decision

- `Principality of Moldavia` は `Name × target year × FromYear × ToYear ×
  SeshatID` の全点一致で列挙した1400〜1800年だけをCliopatriaから採る。
- 1600〜1601年面だけを意味論的不適合として除外し、直前に隣接する1595〜1599年面
  （SeshatID `md_moldavia_principality_2`）を座標無改変で1600年へ借用する。
- `BORROWED_FROM` とraw/flat metadataにtarget year、区間、dataset、固定commit、
  SeshatID、license、reasonを残す。一般的な最近傍探索や外挿には広げない。
- 1600〜1601年面以外に1600年を直接覆う候補が追加された場合は
  `borrowSupersededReason` が検知し、通常収録への切替を要求する。
- 1492年以後は`SUBJECTO` / `PARTOF = Ottoman Empire`として宗主関係を示す。
  1815年は直接包含する高密度なOHM relation 2694163を優先する。

## Relationship to existing decisions

ADR-0026のCliopatria採用・CC BY 4.0帰属と、ADR-0033/0039の座標無改変・静的許可・
追跡可能性は維持する。本決定が追加するのは「同年面が存在しても、同君連合を単一
構成国の領土として表すため意味論的に利用不能」という一件の除外だけである。
出典なしの座標合成を禁じるADR-0014は緩和しない。
