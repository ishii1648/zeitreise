---
status: accepted
date: '2026-08-16'
---

# decision-43: 都市データは Buringh 2021 を主ソースとし Chandler / Reba を補完に用いる

## Context

ADR-0004 は Reba et al. 2016 の Historical Urban Population（Chandler / Modelski
系列、CC BY 4.0）から各年の人口上位 20 都市を選ぶと決めていた。しかし、この
データだけでは都市の年代間の欠落が多く、収録範囲と表示の一貫性にも限界があった。

#222 では、欧州都市をより広く時系列で収録する Buringh 2021「European urban
population, 700–2000」を評価し、都市データの構成を変更した。この変更は値の更新
ではない。主ソースの採否、ライセンス、選定方式について、読み手が従来とは別の
選択肢を選びうる判断を新たに下している。そのため
`docs/development-style.md` 2.1 章の「決定そのものが変わる」分岐を適用し、
ADR-0004 を改訂するのではなく、本 ADR で置き換える。

## Decision

- 主ソースとして Buringh 2021「European urban population, 700–2000」
  （DANS Data Station SSH、DOI `10.17026/dans-xzy-u62q`、CC0 1.0）を採用する。
- Chandler / Modelski 系列をデジタル化した Reba, Reitsma & Seto 2016
  Historical Urban Population（CC BY 4.0）は、Buringh に無い都市、主に欧州外縁を
  補うソースとして維持する。Buringh と名寄せできた都市は重複して補完しない。
- 都市選定は人口上位 20 件への切り詰めを廃止する。Buringh 側には人口下限を
  年別に適用し、Buringh と Chandler / Reba の併合結果には年ごとの件数制約を
  検証契約として適用する。
- Buringh は DOI とファイル ID に加え、取得内容の SHA-256 と行数を検証して
  再現性を固定する。Chandler / Reba は従来どおりコミットを固定する。

現在の実装値は次のとおり。これは判断を理解するための最小限の写しであり、
**正はコード側（`scripts/build-cities.ts`）**とする。

| 実装定数 | 値 | 意味 |
| --- | ---: | --- |
| `BURINGH_MIN_POPULATION` | 5,000 | Buringh 側へ年別に適用する人口下限（Bairoch 1988 の元来の収録基準） |
| `MIN_CITIES_PER_YEAR` | 100 | 併合後の年別都市件数の検証下限 |
| `MAX_CITIES_PER_YEAR` | 2,500 | 併合後の年別都市件数の検証上限 |

## Consequences

- 欧州の都市は Buringh 2021（CC0 1.0）が主となり、Buringh に無い都市だけを
  Chandler / Reba（CC BY 4.0）で補完するハイブリッド構成になる。
- 「主要都市」は固定件数の人口上位ではなく、人口下限と年別件数制約で選定・検証
  される。実装値を変更する場合はコードを先に変更し、同期テストに従って本 ADR の
  表も更新する。
- Buringh 自体は CC0 1.0 だが、補完データには CC BY 4.0 が引き続き含まれるため、
  出力のソース情報と Reba et al. への帰属表示は維持する。
- ADR-0004 は `superseded` とし、当初の Reba 単独採用の記録として本文を保持する。
  関連 Issue は #222（実装）と #353（ADR への記録）である。
