# 年代別データインベントリ（ヨーロッパ域内 — 国 / 都市 / 諸侯領土）

本リポジトリの `data/`
に現時点でコミットされているデータソースから、スナップショット年ごとに取得できる「国・勢力」「都市」「諸侯領土（HRE
領邦・フランス諸侯領・イタリア諸侯領）」を機械的に集計したもの。**集計対象は地理的ヨーロッパの域内に限定**しており、北アフリカ・アナトリア・レヴァント・南コーカサス・中央アジア・シベリアの領域は除外している（§2）。年代ごとの詳細は個別ファイルに分割している。逆方向の一覧
——「史実に存在したが地図に独立ポリゴンとして現れない勢力」——は
[missing-powers-ledger.md](./missing-powers-ledger.md)（年代別の欠落勢力台帳、Issue
#186）に網羅している。`data/known-limitations.json` はその抜粋（#328 で
ユーザー向け表示は撤去し、開発者向け記録として維持している）で、役割分担は
台帳の冒頭 §1 を参照。クリック情報パネルに出す年代別の
勢力説明（`data/power-descriptions.json`）は
[power-descriptions.md](./power-descriptions.md)（Issue #283）が正で、収録方針・
カバレッジ・根拠はそちらにまとめている。

## 1. データソース一覧

| 対象                             | ファイル                                                                                                                          | 出典                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | ライセンス                                                                                      | カバー年代                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 国・勢力ポリゴン                 | `data/europe_<year>.geojson` × 20                                                                                                 | [aourednik/historical-basemaps](https://github.com/aourednik/historical-basemaps) @ `62d8f1a03a71`                                                                                                                                                                                                                                                                                                                                                                                  | GPL-3.0                                                                                         | 全 20 年代                                                                   |
| 都市                             | `data/cities.json`                                                                                                                | 主: Buringh, E. "European urban population 700–2000"（DANS Data Station SSH, [DOI 10.17026/dans-xzy-u62q](https://doi.org/10.17026/dans-xzy-u62q)、fileId 20415、内容 SHA-256 固定）。補完（Buringh に無い欧州外縁の都市のみ）: Historical Urban Population（Chandler / Reba, Reitsma & Seto 2016, DOI 10.7927/H4ZG6QBX）を [fasiha/Historical-Urban-Population-Growth-Data](https://github.com/fasiha/Historical-Urban-Population-Growth-Data) @ `808ff2b4a279` 経由で取得（§3.2） | CC0-1.0（Buringh 2021）/ CC BY 4.0 (Historical Urban Population, v1; Reba, Reitsma & Seto 2016) | 全 19 年代                                                                   |
| 諸侯領土（HRE 領邦）             | `data/hre_<year>.geojson` × 5                                                                                                     | Roller, R. "Spatio-temporal data on territories of the Holy Roman Empire", ETH Zürich（DOI 10.3929/ethz-b-000472583）                                                                                                                                                                                                                                                                                                                                                               | CC BY-NC-SA 4.0                                                                                 | 1500 / 1530 / 1600 / 1650 / 1700 のみ                                        |
| 諸侯領土（HRE 領邦・中世＋近世） | `data/hre_fiefs_<year>.geojson` × 10                                                                                              | [OpenHistoricalMap](https://www.openhistoricalmap.org/)（Overpass API `https://overpass-api.openhistoricalmap.org/api/interpreter`）                                                                                                                                                                                                                                                                                                                                                | CC0 1.0                                                                                         | 1000 / 1100 / 1200 / 1279 / 1300 / 1400 / 1492 と 1715 / 1783 / 1800（#187） |
| 帝国全域（外枠の入力・#332）     | `data/hre_realm_<year>.geojson` × 3                                                                                               | [OpenHistoricalMap](https://www.openhistoricalmap.org/) の神聖ローマ帝国行政境界（`boundary=administrative` / `admin_level=2` / `empire=hre`。1715 = rel 2815489 / 1783 = rel 2810442 / 1800 = rel 2696467。生成は `deno task build-hre-realm`、§3.12）                                                                                                                                                                                                                             | CC0 1.0                                                                                         | 1715 / 1783 / 1800 のみ                                                      |
| 諸侯領土（伊諸侯領・中世）       | `data/italy_fiefs_<year>.geojson` × 7                                                                                             | [OpenHistoricalMap](https://www.openhistoricalmap.org/)（Overpass API `https://overpass-api.openhistoricalmap.org/api/interpreter`）                                                                                                                                                                                                                                                                                                                                                | CC0 1.0                                                                                         | 1000 / 1100 / 1200 / 1279 / 1300 / 1400 / 1492 のみ                          |
| 諸侯領土（仏諸侯領）             | `data/france_fiefs_<year>.geojson` × 5                                                                                            | [OpenHistoricalMap](https://www.openhistoricalmap.org/)（Overpass API `https://overpass-api.openhistoricalmap.org/api/interpreter`）                                                                                                                                                                                                                                                                                                                                                | CC0 1.0                                                                                         | 1000 / 1100 / 1200 / 1279 / 1300 のみ                                        |
| 二重表示の解消（派生）           | `data/fief-dedupe.json`・`data/base_outline_<year>.geojson` × 7・`data/europe_flat_<year>.geojson` × 7                            | `scripts/build-fief-dedupe.ts` が `europe_<year>` と 3 系統のオーバーレイ（`france_fiefs_<year>` / `hre_fiefs_<year>` / `italy_fiefs_<year>`）の union から生成（§3.5）                                                                                                                                                                                                                                                                                                             | GPL-3.0（`europe_<year>` の派生）                                                               | 1000 / 1100 / 1200 / 1279 / 1300 / 1400 / 1492 のみ                          |
| 諸侯領の重なり解消（派生）       | `data/france_fiefs_flat_<year>.geojson` × 5・`data/hre_fiefs_flat_<year>.geojson` × 7・`data/italy_fiefs_flat_<year>.geojson` × 7 | `scripts/build-fief-flat.ts` が各系統の生データから生成（§3.6）。アプリが実際に配信・描画するのはこちら                                                                                                                                                                                                                                                                                                                                                                             | CC0 1.0（各生データの派生）                                                                     | 仏 1000〜1300 / 帝・伊 1000〜1492                                            |
| 諸侯領土（Cliopatria 補完）      | `data/cliopatria_fiefs_<year>.geojson` × 7                                                                                        | Cliopatria (Seshat Global History Databank) — Bennett, J., Mutch, E., Chalstrey, E. et al. (2025) _Scientific Data_、DOI 10.5281/zenodo.14714684。[Seshat-Global-History-Databank/cliopatria](https://github.com/Seshat-Global-History-Databank/cliopatria) @ `ad28a691b7c07c1fca89d0e0636d324667d2a258`                                                                                                                                                                            | CC BY 4.0                                                                                       | 1000 / 1100 / 1200 / 1279 / 1300 / 1400 / 1492 のみ（§3.11）                 |
| 隣接年からの借用（#202 #209）    | `data/borrowed_hre_1492.geojson`・`data/borrowed_hre_1715.geojson`・`data/borrowed_italy_1492.geojson`                            | `scripts/build-borrowed-fiefs.ts` が隣接年の生成物から座標無改変で複製（ADR-0033）。borrowed_hre_1492 は `hre_1500` の `Archduchy of Austria`、borrowed_hre_1715 は `hre_1700` の `Electorate of Saxony`、borrowed_italy_1492 は `italy_fiefs_1500` の `Duchy of Milan`（OHM rel 2800654）。配信されない中間生成物で、次行の flat 派生の入力になる（ADR-0035）                                                                                                                      | 借用元と同一（borrowed_hre_\*: Roller CC BY-NC-SA 4.0 / borrowed_italy_\*: OHM CC0 1.0）        | 1492 / 1715                                                                  |
| 借用面の重なり解消（派生・#215） | `data/borrowed_hre_flat_1492.geojson`・`data/borrowed_hre_flat_1715.geojson`・`data/borrowed_italy_flat_1492.geojson`             | `scripts/build-fief-flat.ts` が借用元の複製からホスト系統 flat の区画を差し引いて生成（ADR-0035）。アプリが実際に配信・描画するのはこちら                                                                                                                                                                                                                                                                                                                                           | 借用元と同一（hre 系: Roller CC BY-NC-SA 4.0 / italy 系: OHM CC0 1.0）                          | 1492 / 1715                                                                  |
| 日本語表記                       | `data/name-ja.json`                                                                                                               | 本リポジトリで手当て（勢力名・都市名・領邦名・山脈名・山峰名の対訳 2820 件。#222 の Buringh 併合で +1644 件）                                                                                                                                                                                                                                                                                                                                                                       | —                                                                                               | —                                                                            |
| 年代別の勢力説明                 | `data/power-descriptions.json`                                                                                                    | 本リポジトリで執筆（クリック情報パネルの一文要約。年代 × 補正後の内部名で引く 289 件。方針・カバレッジ・根拠は [power-descriptions.md](./power-descriptions.md)、Issue #283）                                                                                                                                                                                                                                                                                                       | —                                                                                               | 全 19 年代（主要勢力のみ）                                                   |
| 勢力色                           | `data/colors.json`                                                                                                                | `scripts/build-colors.ts` が NAME から決定的に生成（473 キー）                                                                                                                                                                                                                                                                                                                                                                                                                      | —                                                                                               | —                                                                            |
| 河川                             | `data/rivers.geojson`                                                                                                             | [nvkelso/natural-earth-vector](https://github.com/nvkelso/natural-earth-vector) @ `ca96624a56bd` の `geojson/ne_50m_rivers_lake_centerlines.geojson`（主要河川オーバーレイ・年代非依存）                                                                                                                                                                                                                                                                                            | Public Domain (Natural Earth)                                                                   | 年代共通                                                                     |
| 山脈                             | `data/mountains.geojson`                                                                                                          | [nvkelso/natural-earth-vector](https://github.com/nvkelso/natural-earth-vector) @ `ca96624a56bd` の `geojson/ne_50m_geography_regions_polys.geojson`（`FEATURECLA = Range/mtn` のみ・山脈名ラベル用・年代非依存、§3.9）                                                                                                                                                                                                                                                             | Public Domain (Natural Earth)                                                                   | 年代共通                                                                     |
| 山峰                             | `data/peaks.geojson`                                                                                                              | [nvkelso/natural-earth-vector](https://github.com/nvkelso/natural-earth-vector) @ `ca96624a56bd` の `geojson/ne_10m_geography_regions_elevation_points.geojson`（`featurecla = mountain` の主要 26 峰・標高付きマーカー用・年代非依存、§3.10）                                                                                                                                                                                                                                      | Public Domain (Natural Earth)                                                                   | 年代共通                                                                     |
| 海域名                           | `data/marine-labels.geojson`                                                                                                      | [nvkelso/natural-earth-vector](https://github.com/nvkelso/natural-earth-vector) @ `ca96624a56bd078437bca8184e78163e5039ad19` の `geojson/ne_10m_geography_marine_polys.geojson`（全世界 306 feature から欧州範囲のラベルアンカーを生成。採用属性: `name`, `name_ja`, `featurecla`, `scalerank`, `min_label`, `max_label`, `wikidataid`）                                                                                                                                            | Public Domain (Natural Earth)                                                                   | 年代共通                                                                     |

> ライセンス上の注意: HRE 領邦データ（CC BY-NC-SA 4.0）は GPL-3.0 派生の
> `europe_<year>.geojson`
> と統合してはならず、別ファイルのオーバーレイとしてのみ利用する（`scripts/build-hre.ts`
> の注記）。フランス諸侯領データ・中世 HRE 領邦データ・中世イタリア諸侯領データ
> （いずれも OpenHistoricalMap・CC0
> 1.0）はパブリックドメインのため混合制約は無いが、出典管理を単純に保つため同じく独立ファイルとして生成する（`scripts/build-france-fiefs.ts`・`scripts/build-hre-fiefs.ts`・`scripts/build-italy-fiefs.ts`）。

> **ポーランドの外周だけは base の出典が違う（#352 / ADR-0040）。** 1000 / 1100
> / 1200 / 1279 / 1300 / 1400 年の `Poland`（1400 年は
> `Poland-Lithuania`）のポリゴンは、historical-basemaps ではなく Cliopatria の
> 括弧付き複合体へ置き換えている（`BASE_POWER_REPLACEMENTS`・§3.13）。
> `europe_<year>.geojson` の `metadata.source` はファイル単位の出典なので
> historical-basemaps のままで、この 1 勢力だけが別出典であることは §3.13 と
> `data/known-limitations.json` の `base-poland-outline-replaced-cliopatria`
> が担う。

> HRE 領邦は年代で出典が分かれる。**1000〜1492 年は OpenHistoricalMap 由来の
> `hre_fiefs_<year>.geojson`（§3.7）**、**1500〜1700 年は Roller
> データセット由来の
> `hre_<year>.geojson`（§3.3）**で、年代は重複しない。統一しない理由は §3.7
> の「Roller データとの統一の是非」を参照。

### 1.1 パネルへ出す出典情報（`metadata`）と境界の確からしさ（TASK-109）

クリック情報パネルは「選択した feature が属する FeatureCollection の
`metadata`」を
読んで出典を表示する。そのため配信する全データファイル（`cities.json` を含む）が
次のキーを持つ。値は**各ビルドスクリプトの定数だけ**から組み立てており
（`scripts/build-attribution.ts` の `DATA_ATTRIBUTIONS`）、出典が変われば
metadata も 追従する。既存の `metadata`（諸侯領のビルド診断・flat
化の解消記録など）は温存し、 下記のキーだけを足す。

| キー              | 意味                       | 無い場合                 |
| ----------------- | -------------------------- | ------------------------ |
| `source`          | パネルに出すデータセット名 | —（必ずある）            |
| `sourceUrl`       | 取得元 URL                 | —（必ずある）            |
| `license`         | ライセンス識別子           | —（必ずある）            |
| `commit`          | ピン留めコミット           | ピン留めが無ければ省略   |
| `borderPrecision` | 境界の確からしさの区分     | 線・面を持たなければ省略 |

| データ系統                                                           | `source`                                                  | `license`                     | `commit`                                       | `borderPrecision`                                |
| -------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| `europe_<year>` / `europe_flat_<year>` / `base_outline_<year>`       | historical-basemaps (aourednik)                           | GPL-3.0                       | `62d8f1a03a71…`                                | 概略（年代で 2 区分。下記）                      |
| `france_fiefs_*` / `hre_fiefs_*` / `italy_fiefs_*`（raw・flat とも） | OpenHistoricalMap                                         | CC0-1.0                       | なし（Overpass の生クエリ）                    | 史料に基づく復元（概略。測量された境界ではない） |
| `hre_<year>`（1500〜1700）                                           | Territories of the Holy Roman Empire (Roller, ETH Zürich) | CC BY-NC-SA 4.0               | なし（Shapefile の bitstream UUID でピン留め） | 史料に基づく復元（概略。測量された境界ではない） |
| `rivers.geojson` / `mountains.geojson`                               | Natural Earth                                             | Public Domain (Natural Earth) | `ca96624a56bd…`                                | 現代地形の簡略化（歴史的境界ではない）           |
| `peaks.geojson`                                                      | Natural Earth                                             | Public Domain (Natural Earth) | `ca96624a56bd…`                                | なし（点データ）                                 |
| `cities.json`                                                        | European urban population 700–2000 (Buringh 2021)         | CC0-1.0                       | なし（DOI + fileId 固定・内容 SHA-256 検証）   | なし（点データ）                                 |
| `cliopatria_fiefs_*`（raw・flat とも）                               | Cliopatria (Seshat Global History Databank)               | CC BY 4.0                     | `ad28a691b7c0…`                                | 史料地図のデジタイズ（概略。§3.11）              |

`license` はビルド定数の値をそのまま使う（表記を整えるために書き写すと、定数を
変えたときに追従漏れが起きるため）。`cities.json` は GeoJSON ではないため
契約のキーを持つ `metadata` を別に持ち、その値は**データセット全体の主ソース**
（Buringh 2021・CC0-1.0）を指す（#222）。都市ごとの出典はデータ側の `sources`
配列（Buringh / Chandler の 2 エントリ。§3.2）を各都市の `source` index で
引いて解決する（`src/cities.ts`）。補完ソース側の定数 `CITIES_SOURCE_LICENSE`
は「識別子 + データセット名」の長い表記なので先頭の識別子（`CC BY 4.0`）だけを
パネルに出し、両者の整合をテストが `startsWith` で見張る。

#### 境界の確からしさの区分（5 区分）とその根拠

区分は「境界がどう決まったか」で分ける。これより細かく分けても、区分の違いを
裏づける情報がデータ側に無い（例: 諸侯領 1 件ごとの典拠の質は OHM のタグからは
分からない）。線も面も持たない点データ（山峰・都市）には**付けない**。「境界の
確からしさ」を語れる対象が無く、無理に区分を与えるとマーカー位置の精度と
取り違えられるため。

1. **概略（出典が全境界を概略と宣言）** — historical-basemaps 由来で、全 feature
   の `BORDERPRECISION` が 1 = approximate のファイル。TASK-80
   が境界をにじませて描く
   根拠そのもの（`src/approximate_borders.ts`）。区間ごとの粗さの違い（長い直線ほど
   概略）は同タスクの 3 段の描画が担うので、metadata
   では出典の宣言をそのまま伝える。
2. **概略（出典は確定境界を含むが、簡略化により数 km の近似）** — 同じ
   historical-basemaps でも `BORDERPRECISION` に 2（moderately precise）や
   3（determined by international
   law）を含むファイル。上流の宣言をそのまま「正確」と 伝えてはいけない:
   本パイプラインは simplify のトレランス 0.005〜0.1 度 （およそ 0.5〜11
   km）で頂点を間引き、座標も 5 桁へ丸めてから配信するため、条約で
   確定した境界でも地図上の線は数 km 規模の近似になる。TASK-80 のにじみ描画も
   年代を問わず全年に掛かる（`src/main.ts` の
   `memoizedApproximateBorderData`）ので、 「描かれている線は概略」という点は 1
   と変わらない。**違うのは概略になった理由だけ**で、 それを明示するための区分。
3. **史料に基づく復元（概略。測量された境界ではない）** —
   領域ごとに存続期間付きで 作図された復元。OHM の諸侯領（`start_date` /
   `end_date` を持つ個別リレーション）と ETH Zürich（Roller）の HRE 領邦。base
   の一括スナップショットより典拠は個別だが、
   測量境界ではないので「概略」であること自体は変わらない。文言に「概略」を残して
   TASK-80 の全体注記と矛盾させない。
4. **現代地形の簡略化（歴史的境界ではない）** — Natural Earth
   の河川・山脈。そもそも
   歴史的境界ではなく、当時の流路とも限らないことを明示する。
5. **史料地図のデジタイズ（概略。手描き地図の自動抽出を 0.07 度で平滑化）** —
   Cliopatria（§3.11・TASK-110）。3 と分けるのは、区分の違いを裏づける情報が
   データ側にあるため: Cliopatria は 2014 年に手描きされた歴史地図の**画像**群を
   Python で自動抽出し 0.07 度（およそ 7.8 km）で平滑化したもので、論文自身が
   「境界は必然的に概略で解釈の余地がある」「過去に遡るほど不確かさが増す」と
   明記している。実測でも頂点密度は OHM の 1/4〜1/7（1000 年の Duchy of
   Aquitaine が 69 頂点、OHM の 1200 年版が 330
   頂点）で、領域ごとに存続期間付きで作図された 3
   とは確からしさの根拠が違う。なお粗さの向き自体は TASK-80 の
   「頂点密度が低い区間ほどにじませて薄く描く」表現と整合しており、TASK-88 が
   県合成を却下した理由（周囲の 4 倍シャープになる）とは逆になる。

区分 1 と 2 の切り分けは定数ではなくファイルの中身から決める
（`basePrecisionOf`）。上流の `BORDERPRECISION` の実測分布（`europe_<year>` の
feature 数）は次のとおりで、年代で宣言が変わるため：

| 年代                  | 分布（値: 件数）                  |
| --------------------- | --------------------------------- |
| 1000〜1530（11 年代） | 1: 50〜93（全件が 1）             |
| 1600                  | 1: 71 / 3: 2                      |
| 1650 / 1700 / 1715    | 1: 3〜5 / 3: 61〜79               |
| 1783〜1914（7 年代）  | 3: 55〜106（1880 のみ 2 が 1 件） |

TASK-80 の「採用データは全 feature の `BORDERPRECISION` が 1」という説明は、
**この地図が主対象とする中世〜近世前半（1000〜1530）では実データどおり**で、1600
年 以降は上流の宣言が 3 へ移る。混在するファイル（1600 年の
71:2）は「宣言が割れたら 理由を明示する側へ倒す」規則で区分 2
を採り、過大な精度を主張しない。

#### 生成と追従漏れの検出

出典の付与は
`deno task build-attribution`（ネットワーク不要）で行う。パイプラインの
**最後**に流す: データを再生成したら必ず実行する。

```
build-data / build-hre / build-*-fiefs / build-cliopatria-fiefs /
build-rivers / build-mountains / build-peaks / build-cities
  →  build-borrowed-fiefs  →  build-fief-flat  →  build-fief-dedupe
                                            →  build-colors
                                            →  build-attribution（最後）
```

- `build-borrowed-fiefs`（#202 / ADR-0033）は、その年に面が無い政体へ隣接年の
  出典付き面を**座標無改変で複製**して `data/borrowed_<系統>_<year>.geojson` を
  作る。借用元と同じ系統の別ファイルに置くのは出典の粒度がファイル単位だから
  （Roller / CC BY-NC-SA と OHM / CC0 を 1 ファイルに混ぜない）。この複製は
  座標無改変のまま残る中間生成物で（ADR-0033 条件 2 は複製に対して維持。
  ADR-0035）、配信・描画には `build-fief-flat` がホスト系統 flat の区画を
  差し引いて生成する `data/borrowed_<系統>_flat_<year>.geojson`（#215）を使う
  （既存 7 系統の raw → flat と同じ扱い）。`build-fief-dedupe` の入力には
  借用面も含める（base の二重塗りを解消するため）。

- 独立した最終段にしているのは、(1) 各取得スクリプトに配ると
  `build-attribution.ts` が全取得スクリプトの定数を import する一方で全取得
  スクリプトが `build-attribution.ts` を import する循環になり、定数の初期化順に
  依存して壊れるため、(2) OHM の諸侯領は Overpass
  の生クエリ由来でピン留めが無く、
  出典を足すためだけに再取得すると無関係な差分が出るため。
- ただし**アプリが実際にロードする派生ファイル**（`*_fiefs_flat_<year>` /
  `borrowed_<系統>_flat_<year>` / `europe_flat_<year>` /
  `base_outline_<year>`）は、生成元の `build-fief-flat.ts` /
  `build-fief-dedupe.ts` 自身が `serializeWithAttribution`
  を通して出典を載せる。 これらは自前の `metadata`
  で上書き保存するため、載せ直さないと再生成のたびに
  出典が落ちてパネルの出典欄が空になる。
- `scripts/build-attribution_test.ts` が (a) 全データファイルの `metadata`
  と定数の 一致、(b) `src/powers.ts` 等の URL
  定数から辿った**ランタイムがロードする全ファイル**に `source` / `sourceUrl` /
  `license` があること、(c) `dist` へ配信する全データ
  ファイルが出典を持つか意図的な除外リスト（`UNATTRIBUTED_DATA_FILES`）に載ること、
  (d) 「出典が全境界を概略と宣言」を名乗るファイルの `BORDERPRECISION` が実際に
  1 だけであることを検証する。定数を変えて生成物を更新し忘れると (a) が落ちる。

出典を持たせないファイルと理由（`UNATTRIBUTED_DATA_FILES`）:
`index.json`（年代一覧・ feature を持たない）、`colors.json`（NAME
から決定的に生成・外部出典なし）、 `name-overrides.json` / `name-ja.json` /
`known-limitations.json`
（本リポジトリで手当てした定義・テキスト）、`fief-dedupe.json`（被覆率表・座標を
持たない）。

### 1.2 座標の小数桁数（raw と配信物で二段。ADR-0037・#334）

領邦データは「取り込んだままの raw」と「重なりを排他化した配信物」で丸めの桁数が
分かれる。

| 段                                                                                                    | 桁数                                   | 定数                                                  | 配信                       |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------- | -------------------------- |
| raw（`<source>_fiefs_<year>.geojson`。cliopatria / france / hre / italy / britain / sovereign）       | 5（≒ 1 m）                             | `RAW_FIEF_COORD_PRECISION`（`scripts/build-data.ts`） | されない（派生の入力のみ） |
| 配信物（`*_fiefs_flat_<year>` / `europe_<year>` / `europe_flat_<year>` / `base_outline_<year>` ほか） | 3（グリッド ≒ 111 m・丸め誤差 ≒ 56 m） | `COORD_PRECISION`（同）                               | される                     |

- **なぜ raw を細かく保つのか**: 配信物は必ず 3 桁へ丸め直されるため、raw
  の桁数は 転送量に効かない（TASK-130 のサイズ削減はそのまま維持される）。一方
  raw を 3 桁へ 落とすと、`build-fief-flat` / `build-fief-dedupe` の
  union・difference を粗い グリッド上で解くことになり、TASK-130
  が実際に踏んだ「穴と外周の半グリッドずれ」
  「線状スライバの復活」と同種のリスクを raw 側へ持ち込む。
- **なぜ方針として明記するのか**: TASK-130 が `COORD_PRECISION` を 5 → 3
  へ下げた とき、OHM 由来 raw は「ライブ Overpass 由来の drift
  回避のため意図的に再生成
  しない」と判断されたが、その判断が生成スクリプト側へ反映されず、raw
  生成側だけが 3 桁を適用する状態が残った。結果、入力が変わっていなくても
  `deno task build-cliopatria-fiefs` を流すと全年・全 feature に差分が出ていた
  （#334）。
- **検証**: `scripts/raw-fief-precision_test.ts` が、コミット済み raw
  全ファイルの 小数桁数が `RAW_FIEF_COORD_PRECISION`
  に収まること、ピン留め入力の cliopatria が
  その桁数をそのまま保持していること、各 raw 生成スクリプトが raw 用定数を
  参照していることを固定する。
- **OHM 由来 raw の扱い**: `france` / `hre` / `italy` / `britain` / `sovereign`
  は Overpass API の直叩きで入力をピン留めできず、再生成すると精度以外の上流変化
  （drift）も同時に取り込む。したがって**完全一致の再生成テストは置かない**（置け
  ない）。担保できるのは上表の精度方針との整合までで、それを上記テストが機械的に
  検出する。`britain` / `sovereign` は TASK-130 より後に新設され 3
  桁で入っている が、方針より粗いだけなので不変条件（≤ 5
  桁）は満たす。次に正当な理由で再生成 したときに 5 桁へ揃う。
- **cliopatria だけは完全一致する**: 入力がコミット SHA
  （`CLIOPATRIA_SOURCE_COMMIT`）+ アーカイブの SHA-256
  でピン留めされているため、 `deno task build-cliopatria-fiefs` →
  `deno task build-attribution` を流すと コミット済みの
  `data/cliopatria_fiefs_<year>.geojson` とバイト単位で一致する （#334
  で実測）。ネットワーク無しで再現するときは
  `CLIOPATRIA_ARCHIVE=<ローカルの zip>` を渡す。

## 2. 「ヨーロッパ」の範囲（本インベントリの絞り込み基準）

元データ `europe_<year>.geojson` はヨーロッパ bbox（西経 25°〜東経 60°、北緯
34°〜72°）でクリップされているだけなので、北アフリカ・アナトリア・レヴァント・南コーカサス・中央アジアの陸地が含まれる。本インベントリではこれを**地理的ヨーロッパの境界線**でさらに絞り込んでいる。

### 2.1 境界の定義

| 方面       | 境界                                                                    | 域内                                                     | 域外                                                                                     |
| ---------- | ----------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 東         | ウラル山脈（東経 60° 線）〜ウラル川（オルスク〜ウラリスク〜アティラウ） | ヴォルガ・ウラル地方、カスピ海北岸ステップ               | シベリア、中央アジア                                                                     |
| 南東       | カスピ海西岸〜大コーカサス分水嶺（バクー〜ソチ）                        | 北コーカサス（ダゲスタン等）                             | 南コーカサス（グルジア・アルメニア・アゼルバイジャン中心部）                             |
| 黒海・海峡 | 黒海中央（北緯 42.3° 前後）〜ボスポラス〜マルマラ海北岸〜ダーダネルス   | クリミア、東トラキア（コンスタンティノープル）           | アナトリア黒海沿岸（シノプ・トラブゾン等）                                               |
| エーゲ海   | アナトリア西岸の沖合                                                    | ギリシャ島嶼（レスボス・キオス・サモス・ロドス・クレタ） | イズミル（スミルナ）以東のアナトリア、キプロス                                           |
| 南         | 地中海（北アフリカ沿岸の沖合）                                          | マルタ、シチリア、パンテッレリーア、ジブラルタル         | 北アフリカ全域（モロッコ・アルジェリア・チュニジア・リビア・エジプト）、セウタ・メリリャ |
| 北西       | 西経 20°／北緯 68° の切り欠き                                           | アイスランド、ヤンマイエン                               | グリーンランド東岸                                                                       |

### 2.2 勢力・都市の採否ルール

- **都市**: 座標が上記の境界内にあるものだけを採用する（例:
  コンスタンティノープルは採用、ブルサ・チュニス・カイロ・タブリーズは除外）。
- **勢力**: ポリゴンを境界でクリップし、**欧州域内の面積が 5,000 km²
  以上、または元面積の 50%
  以上（領域の過半が欧州域内）**なら採用する。オスマン帝国のように域内外にまたがる勢力は採用したうえで、**面積は欧州域内の値のみ**を示し「欧州比率」列に元面積に対する割合を併記する。
- 上記を満たさない勢力（モロッコ・マムルーク朝・キプロス・グルジアなど）は各年代ファイルの
  §2.4
  に除外一覧として残している。海岸線の簡略化に由来する僅かなはみ出しもこのしきい値で落としている。
- 面積はすべてクリップ後の球面近似（R=6,371,008.8
  m）による概算で、史実の領土面積ではない。

## 3. 取得できる属性

### 3.1 国・勢力（`europe_<year>.geojson` の feature properties）

| プロパティ              | 内容                          | 備考                               |
| ----------------------- | ----------------------------- | ---------------------------------- |
| `NAME`                  | 勢力の表示名                  | null あり（無名ポリゴン）          |
| `ABBREVN`               | 略称                          | 一部 null                          |
| `SUBJECTO`              | 宗主・上位勢力                | 自身と同値なら独立、異なれば属領   |
| `PARTOF`                | 文化圏等の上位グルーピング    | アプリ未使用                       |
| `BORDERPRECISION`       | 境界精度 1（概略）〜3（確定） | 描画には未使用                     |
| `wikipedia` / `INFO_UR` | 参考 URL                      | 1000 年など一部年代のみ、ほぼ null |

ジオメトリはすべて MultiPolygon。「ポリゴン数」は同じ NAME / SUBJECTO を持つ
feature の数（クリップ前）で、面積と欧州比率はクリップ後の値。

### 3.2 都市（`cities.json`）

#222 で主ソースを **Buringh (2021) "European urban population, 700–2000"**
（DANS Data Station SSH,
[DOI 10.17026/dans-xzy-u62q](https://doi.org/10.17026/dans-xzy-u62q)、
CC0-1.0）へ切り替え、従来の Historical Urban Population（Chandler / Reba,
Reitsma & Seto 2016、CC BY 4.0）は **Buringh に無い都市**（ニシャプール・
カイラワーン・アレッポ・タブリーズ等、ほぼ欧州外縁）だけを補う二段構成に
した。同時にファイル形式を「都市配列 + 年別セル」の**正規化形式**へ改めた
（従来の年ごとに name / lon / lat を繰り返す形式だと延べ約 1.85 万セルで約 1.6MB
に膨らむが、正規化形式なら約 0.47MB に収まる）。

#### ファイル形式（正規化形式・#222）

```json
{
  "cities": [{ "name": "Constantinople", "lon": 28.95, "lat": 41.02, "source": 0 }, ...],
  "years": { "1000": [[0, 235000, "imputed"], [2, 125000], ...], ... },
  "sources": [{ Buringh の出典 }, { Chandler の出典 }],
  "metadata": { "source": ..., "sourceUrl": ..., "license": ... }
}
```

| キー             | 内容                                                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cities[]`       | 都市の定義（一度だけ載る）。`name` は英語慣用名（`CITY_RENAMES` で正規化済み。例: Istanbul → Constantinople）、`source` は `sources` 配列への index（0 = Buringh / 1 = Chandler） |
| `years.<year>[]` | `[都市 index, 人口]` または `[都市 index, 人口, natureOfEstimate]` のセル。人口降順（同数なら name 昇順）                                                                         |
| `sources[]`      | ソース別の出典（DOI / リポジトリ・ライセンス・ピン留め情報）。クリック情報パネルは都市の `source` index でここを引く                                                              |
| `metadata`       | データセット全体の出典（主ソース Buringh を指す。§1.1）                                                                                                                           |

読み取り側は `src/cities.ts` の `cityEntriesForYear` がこの形式を解決する。

#### 選定・名寄せルール

- **Buringh（主）**: 2,262 都市 × 19 年（700〜2000 の 50〜100 年グリッド）の
  完全グリッド（欠損セルなし）。人口下限 **5,000 人** （`BURINGH_MIN_POPULATION`
  = Bairoch 1988 の元来の収録基準）を年別に適用
  する。下限は「一貫性」（ベオグラードの全年連続表示）と「史実性」（ベルリンの
  中世 imputed 値 1〜4 千人を出さない）を両立させる調整弁。
- **名寄せ（3 段）**: Chandler の都市を 正式名 → 別名列
  （`synonymsandhistoricalnames`）→ 座標 15km 以内（`BURINGH_MATCH_MAX_KM`）の
  順で Buringh に対応付ける。一致した都市は Buringh 側の値を Chandler 側の
  英語慣用名で出す（例: Buringh の Istanbul → Constantinople）。
- **Chandler（補完）**: 名寄せで Buringh に無かった都市のみ従来ルールで採用:
  スナップショット年に対し**過去 50 年〜未来 25 年**の窓で年差最小の記録
  （同差なら過去優先）。未来側を狭くするのは産業革命以降の過大評価を防ぐため。
- **補間（#221）**: 窓内に記録が無くても、対象年を挟む前後に記録があれば
  **対数線形補間**（`round(exp(ln(p0) + (ln(p1) − ln(p0)) × (target − y0) / (y1 − y0)))`）で採用し、`natureOfEstimate: "imputed"`
  を付けて実推定と区別する。片側にしか記録が無い場合は外挿せず落とす。Buringh
  はグリッドに無いスナップショット年（1279 / 1492 / 1530 / 1715 / 1783 / 1815 /
  1880 / 1914）でも両側が必ず埋まっているため、補間が常に成立し歯抜けが構造的に
  起こらない。「前後に記録があるのに中間年で消える」内部ギャップがゼロである
  ことは生成時の `validateCitiesData` で保証される（初出年〜最終出現年の間の
  全スナップショット年に存在する契約）。

#### `natureOfEstimate` の語彙（Buringh 2021 の `natureofestimate` 列に準拠）

| 値          | 意味                                                                |
| ----------- | ------------------------------------------------------------------- |
| （省略）    | 実推定                                                              |
| `"imputed"` | 上流 Buringh の補完推定、または本パイプラインの対数線形補間で得た値 |
| `"proxied"` | 代理指標による推定（上流 Buringh 由来。現行データで延べ 251 セル）  |

#### 取得の再現性

Buringh の上流（DANS Dataverse）にはコミットの概念が無いため、DOI + ファイル
ID（`BURINGH_SOURCE_FILE_ID` = 20415）で取得先を固定し、内容の SHA-256
（`BURINGH_SOURCE_SHA256`）と行数（42,978）を取得時に検証する（上流が
差し替わるとビルドが fail する。`scripts/build-cities.ts` ヘッダ）。Chandler
側は従来どおり GitHub ミラーのコミット固定。

#### データの性質・既知の限界

- **座標の小数点消失セルの復元**: 上流 Buringh の座標セル約 60 件は表計算由来
  の破損で小数点が消えている（例: `"53383"` = 53.383、`"-1467"` = -1.467）。 10
  のべき乗で割った候補のうち欧州レンジ内のものを列挙し、複数残る場合は
  同国の正常セルから作った国別レンジに最も近い候補を採って復元する
  （`decodeBuringhCoordinate`）。一意に決められないセルは黙って誤座標に
  せず**都市ごと除外**し、件数検証で気付けるようにしている。
- **上流の複製行（Frankenthal）の除外**: 上流 Buringh の Frankenthal は全 19 年
  の座標が Frankfurt am Main と同一（50.1N 8.67E）で、1500〜2000 年の人口も
  Frankfurt の完全な複製（1900 年 289 千人等。実在のフランケンタールは 49.53N
  8.35E・1900 年約 1.7 万人）。正値が上流に無く、複製でない 700〜1400 年の
  自前セルは全て人口下限未満で表示されないため、都市ごと除外した
  （`BURINGH_EXCLUDED_CITY_NAMES`、Issue #269）。同種の複製の再発は生成時検証
  `validateCitiesData` の「同一年内の同一座標・同一人口ペア検出」で fail する
  （許容する例外は `ALLOWED_COINCIDENT_CITY_PAIRS` に明示。現在は空）。
- **座標値の誤りの上書き（Riga）**: 上流 Buringh の Riga の経度 21.1 は
  リエパーヤ（21.02E）付近で、実際のリガは約 24.1E（緯度 56.95 は正しい）。
  小数点消失と違い正常に読めてしまう値の誤りのため、`BURINGH_COORDINATE_OVERRIDES`
  で経度のみ 24.1 へ上書きした（Issue #269）。
- **座標のみ複製された 4 都市の上書き**: 上流 Buringh には座標セルだけを別都市
  の行から複製した行がほかに 4 件ある（Burscheid が Aachen の座標、
  Caltabellotta が Caltagirone の座標、Oristano が Novi の座標、Semur en Auxois
  が Selestat の座標。Issue #269 の調査で判明）。人口は各都市自前の値のため
  上記の複製ペア検出には掛からない。4 件とも `BURINGH_COORDINATE_OVERRIDES` で
  実座標へ上書きした（出典は同オーバーライドの doc コメント。Issue #276）。
  同型の再発は `validateCitiesData` の「座標が完全一致する別都市ペア検出」で
  fail する（許容する例外は `ALLOWED_COINCIDENT_COORDINATE_PAIRS` に明示。
  現在は空）。同型の Sollies Pont（St Amand の座標）は全年で人口下限未満の
  ため出力に現れず、上書き対象にしていない。
- **15km 名寄せに吸収された 5 小都市**: Borinage / Dewsbury / Folkestone /
  Motherwell / Rhondda（いずれも旧 Chandler 由来の小都市）は、別都市だが 15km
  以内にある近傍の Buringh 都市（それぞれ Tournai / Wakefield / Dover / Hamilton
  / Merthyr Tydfil）へ名寄せされ選外になった。日本語訳は
  `scripts/name-ja_test.ts` の `RETAINED_CITY_NAME_JA` で保持している。
- **proxied セル**: 代理指標による推定が延べ 251 セル含まれる（地図表示は
  実推定と区別しない。年別ファイルの §4 では ‡ で注記）。
- 人口はいずれも推計値であり、スナップショット年への対応付け・補間にも
  ±数十年規模の不確かさを含む。

#### 年別ファイル（`year-<year>.md`）の §4 の形式

併合で年別の都市数が最大 2,100 件超（従来の約 4 倍）になったため、年別
ファイルの §4 は全件列挙をやめ「**人口上位 50 件 + ソース / natureOfEstimate
内訳 + 全件列挙コマンド（jq）**」の形式にしている（全件の
表は台帳の可読性を損ない、`data/cities.json` から機械的に再列挙できるため）。
ヨーロッパ域外として除外した都市の一覧は従来どおり全件列挙を維持する （§2
の採否判断の記録そのものであるため）。

### 3.3 諸侯領土（`hre_<year>.geojson`）

| プロパティ | 内容                                                                               |
| ---------- | ---------------------------------------------------------------------------------- |
| `NAME`     | 称号付き領邦名（年代で称号が変わる。例: Duchy of Bavaria → Electorate of Bavaria） |
| `SUBJECTO` | `Holy Roman Empire` 固定                                                           |
| `PARTOF`   | `Holy Roman Empire` 固定                                                           |

すべて神聖ローマ帝国内の領邦であり、ヨーロッパ域外の絞り込みによる除外はない。

### 3.4 諸侯領土（`france_fiefs_<year>.geojson`）

| プロパティ        | 内容                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `NAME`            | 諸侯領の英語名（OHM の `name:en` そのまま。例: Duchy of Brittany）                       |
| `ADMIN_LEVEL`     | OHM の `admin_level`（3 = 公領級 / 4 = 伯領級 / 5 = Ponthieu）                           |
| `OHM_RELATION_ID` | 出典の OHM リレーション ID（`https://www.openhistoricalmap.org/relation/<id>` で参照可） |
| `START_DATE`      | OHM の `start_date`（`0918` / `1137-04-09` など生の表記）                                |
| `END_DATE`        | OHM の `end_date`。`null` は無期限（タグ欠損）                                           |

生成物の末尾には `metadata`（出典・ライセンス・年・feature 数・欠損記録）を
GeoJSON の foreign member として埋め込んでいる。欠損記録は
`missingWays`（ジオメトリを取得できなかったメンバー
way）・`unclosedRings`（端点が繋がらず強制的に閉じたリング）・`droppedInnerRings`（どの外環にも入らず破棄した内環）・`relationsWithoutGeometry`（ジオメトリを組み立てられなかったリレーション）の
4 種で、現行の 5 ファイルはいずれも全て空（欠損なし）。

#### 収録できた諸侯領（年代別）

許可リスト `FRANCE_FIEF_NAMES` は TASK-87 で 14 領邦から 21 領邦へ拡張した
（追加はアングレーム / ラ・マルシュ / ヴァンドーム / サン＝ポル / ナント /
トゥール / ペルシュの 7 伯領）。年代ごとの件数は括弧内が拡張前の値。

|   年 |    件数 | 諸侯領                                                                                                                                                                                                                                                           |
| ---: | ------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1000 |  12 (7) | ブルターニュ公領 / ノルマンディー公領 / ブルゴーニュ公領 / ポワトゥー伯領 / アンジュー伯領 / メーヌ伯領 / ラ・マルシュ伯領 / ナント伯領 / トゥール伯領 / アングレーム伯領 / ポンチュー伯領 / ヴァンドーム伯領                                                    |
| 1100 |  16 (9) | 上記 12 件 + バール伯領 / ペルシュ伯領 / アランソン伯領 / サン＝ポル伯領                                                                                                                                                                                         |
| 1200 | 19 (12) | 上記 16 件 + アキテーヌ公領 / シャンパーニュ伯領 / ガスコーニュ公領（ノルマンディー公領は 1195〜1204 年のリレーションに入れ替わる）                                                                                                                              |
| 1279 | 15 (11) | ブルターニュ公領 / シャンパーニュ伯領 / ブルゴーニュ公領 / ポワトゥー伯領 / フランドル伯領 / アンジュー伯領 / メーヌ伯領 / ラ・マルシュ伯領 / バール伯領 / アルトワ伯領 / アングレーム伯領 / ポンチュー伯領 / アランソン伯領 / ヴァンドーム伯領 / サン＝ポル伯領 |
| 1300 | 15 (11) | 1279 年と同一の 15 件                                                                                                                                                                                                                                            |

日本語名は `data/name-ja.json` に従う。年代ごとの内訳（admin_level・OHM
リレーション ID・面積）は各年代ファイルの §3.2 を参照。

対象年を 1000 / 1100 / 1200 / 1279 / 1300 に絞ったのは実データの件数による。1400
年は 6 件まで減り、王領へ併合された諸侯は OHM 側で `admin_level`
2（主権国家レベル）に移るため対象外とした。

#### 収録できない諸侯領・欠落

| 諸侯領                                        | 状況                                                                                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Comté de Toulouse                             | OHM に該当リレーションが存在しない（Toulouse を含むのは `Kingdom of France` のみ）                                                       |
| 王領（domaine royal）                         | 同上。フランス王の直轄領を表すリレーションが無い                                                                                         |
| Foix / Armagnac / Auvergne / Bourbon / Nevers | 同上。いずれも該当リレーションが無い                                                                                                     |
| Provence                                      | 1487 年以降のリレーションしか無く、中世 5 年代には掛からない                                                                             |
| County of Flanders                            | 1237 年以降のみ。1000 / 1100 / 1200 年には収録が無い                                                                                     |
| County of Artois                              | 1237 年以降のみ（Flanders から分離した年）                                                                                               |
| Duchy of Aquitaine / Duchy of Gascony         | 1137-04-09〜1214-09-28 のみ。1279 年以降は収録が切れる                                                                                   |
| Duchy of Normandy                             | 1204 年のフランス王領併合後は `admin_level` 2 になるため 1279 年以降は採らない                                                           |
| County of Namur / County of Zeeland           | OHM に収録はあるが仏諸侯領ではないため §3.4 では採らず、`HRE_FIEF_BBOX`（西端 5.5 度）の外なので §3.7 でも収録されない（両系統とも欠落） |

そのため 1000〜1300
年のフランス王国域は、収録できた諸侯領を重ねてもなお南部（トゥールーズ・オーヴェルニュ）と王領が空白になる。この空白は許可リストの狭さではなく
OHM 側の実データの欠落による（TASK-87 で実測確認済み）。

#### 県ポリゴン合成で空白を埋める案の検討と却下（TASK-88 / decision-18）

上記の空白（トゥールーズ伯領・王領・Foix / Armagnac / Auvergne / Bourbon /
Nevers）を、現代の県（département）ポリゴンの union
で合成して埋める案を実測のうえ却下した。決定は decision-18、実測は次のとおり。

**ソース候補**:
[gregoiredavid/france-geojson](https://github.com/gregoiredavid/france-geojson)
の `departements.geojson`（96 features、IGN Admin Express COG 2018 + INSEE COG
2018 由来、mapshaper で 5 桁 ≈ 1.11 m 丸め + Visvalingam weighted 25% 簡略化）。
ライセンスは README の 1 行（Admin Express の Licence
Ouverte）のみでリポジトリに LICENSE ファイルが無く（`raw.../LICENSE` は
404・GitHub API の `license` も `null`）、master HEAD は
`5d34ee6d0140c29f785fdb047d9329f1aab58833`（2018-10-16、 最終 push
2022-12-02）。attribution-only なので再配布自体は可能だが、
DOI・コミット固定・ライセンス明記で揃えてきた他ソースより出典管理の水準が低い。

**却下の根拠（1200 年で実測）**:

| 指標                                                                           | 実測値                                                                                                                      |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 合成 A（核心 6 県 31 / 81 / 82 / 46 / 12 / 47）の面積                          | 35,185 km²。base の `Comté de Toulouse`（90,755 km²）との IoU = **28.5%**                                                   |
| 合成 B（A + 48 / 30 / 07）                                                     | 51,767 km²、IoU = **30.2%**                                                                                                 |
| 合成 C（B + 34 / 09 / 84）                                                     | 66,460 km²、IoU = **41.6%**                                                                                                 |
| 逆算した最良の県セット（base が 50% 以上覆う 13 県）                           | 74,598 km²、IoU = 72.9%。ただし Bouches-du-Rhône / Var / Alpes 系まで含み、base 側が実質「ラングドック + プロヴァンス」の塊 |
| 1200 年の空白（`europe_1200` の France ∪ Toulouse − `france_fiefs_flat_1200`） | 208,326 km²（対象域の 64.6%）                                                                                               |
| 合成が埋める空白                                                               | A = 26,533 km²（**12.7%**）／ C = 57,638 km²（**27.7%**）／最良でも 33.8%                                                   |
| 出典のある既存 fief との重なり（合成 A）                                       | Duchy of Aquitaine 3,737 km²（同 fief の 5.7%）+ Duchy of Gascony 2,569 km²（10.2%）= 合成 A の **17.9%**                   |
| 頂点密度                                                                       | 6 県の生頂点 12,365 に対し、1200 年の OHM 由来 19 fief 全体で 2,801 頂点（合成領だけが 4 倍以上シャープに描かれる）         |

同じ通説から出発した合成が base と 28〜42%
しか一致しない時点で、形状の大半は「どの県を選ぶか」という編集判断の産物であり、
座標の出所（IGN）が追跡できても「1200
年の境界」としての出典はゼロである。加えて空白の 13〜28%
しか埋まらず、出典のある Aquitaine / Gascony と 6,300 km²
の重なりを新たに作り、`base_outline_<year>`（§3.5、GPL-3.0 派生の線データ）まで
合成ポリゴンで切ることになる。全境界を「概略」として描く方針（§9・TASK-80）とも
矛盾するため、合成は行わず空白のまま既知の制限で説明する（decision-14 の
「出典を持たない座標合成はしない」を維持）。

**出典のある代替の再確認**: `FRANCE_BBOX` 全域の `boundary=administrative`
リレーション **4,923 件**を再取得し、
`toulouse|foix|auvergne|bourbon|nevers|armagnac|royal|domaine|languedoc|rouergue|quercy`
等で名称を横断検索した結果、該当リレーションは **0 件**（Provence は
`rel 2892604` の 1487–1791 のみ、Dauphiné は対象域外）。TASK-70 / TASK-87
の結論を再現した。

**再現手順**:

```sh
# 1. 県ポリゴンを取得（96 features）
curl -sL -o /tmp/departements.geojson \
  https://raw.githubusercontent.com/gregoiredavid/france-geojson/5d34ee6d0140c29f785fdb047d9329f1aab58833/departements.geojson

# 2. 合成・面積・IoU・空白充填率を測る（@turf/union・@turf/intersect・
#    @turf/difference・@turf/area は本リポジトリの import map にある）
#    入力: /tmp/departements.geojson・data/europe_1200.geojson・
#          data/france_fiefs_flat_1200.geojson

# 3. OHM 側にリレーションが無いことを再確認する
printf '[out:json][timeout:180];rel["boundary"="administrative"](40.0,-6.5,52.5,10.5);out tags;' > /tmp/q.txt
curl -s --data-urlencode "data@/tmp/q.txt" \
  https://overpass-api.openhistoricalmap.org/api/interpreter -o /tmp/ohm.json
```

#### 収録を見送った候補と根拠（TASK-87）

`FRANCE_BBOX` 内の `boundary=administrative`（4,917 件）から `admin_level` 3〜5
かつ対象年に有効なものを洗い出すと、許可リスト外に 113 件が残る。フランス王国の
封建諸侯領ではないものを分類して落としており、分類と根拠は
`scripts/build-france-fiefs.ts` の `FRANCE_FIEF_EXCLUSIONS` に記録している。
帰属が問題になる主な個別事例は次の 3 件。

| 候補                          | 判断   | 根拠                                                                                                                           |
| ----------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Cambrésis                     | 不採用 | 1007 年にハインリヒ 2 世が伯権をカンブレー司教へ移した帝国司教領。フランス併合は 1678 年（ナイメーヘン条約）                   |
| County of Clermont-en-Argonne | 不採用 | 10 世紀半ばにヴェルダン司教の城代封として成立した帝国封。バール伯領の支配下でも帝国側にとどまり、フランス割譲は 1641 年        |
| County of Roussillon          | 不採用 | 1172 年にアラゴン王へ、1276 年にマヨルカ王国へ渡ったカタルーニャ系伯領。隣接する Conflent 等と同じ扱い。フランス割譲は 1659 年 |

低地地方・アルル王国側（Namur / Zeeland / Holland / Dauphiné of Viennois /
Montbéliard / Neuchâtel）は帝国領邦なので仏諸侯領としては採らない。うち Holland
/ Montbéliard / Neuchâtel / Viennois は §3.7 の中世 HRE 領邦で収録済みで、
二重収録は `scripts/build-hre-fiefs_test.ts`
の許可リスト排他テストで防いでいる。

`deno task build-france-fiefs` でこのファイルを再生成したときは、派生データも
併せて作り直す必要がある（`deno task build-fief-flat`（§3.6）と
`deno task
build-fief-dedupe`（§3.5））。アプリが配信するのは前者の生成物なので、
再生成を忘れると地図には古い諸侯領が出続ける。

### 3.5 二重表示の解消データ（`fief-dedupe.json` / `base_outline_<year>.geojson`）

諸侯領オーバーレイのある 5 年代では、同じ土地に base
勢力（`europe_<year>`）と諸侯領（`france_fiefs_<year>`）の輪郭・ラベルが二重に
描かれる。`deno task build-fief-dedupe`（`scripts/build-fief-dedupe.ts`、
ネットワーク不要）が既存の生成物 2 つから派生データを作り、これを解消する。

| 生成物                             | 内容                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `data/fief-dedupe.json`            | `years.<year>.<NAME>` = その base 勢力の面積のうち諸侯領 union に覆われた割合（0..1、0.001 未満は非記録）    |
| `data/base_outline_<year>.geojson` | base 各ポリゴンの環を諸侯領 union の外側だけに切り出した `LineString` 群（`properties` は元の feature 由来） |

被覆率の分布は二極化しており、完全内包は 5 年代とも `Britany`（1.0000）のみ、
部分重複の最大は 1200 年の `Angevin Empire` 0.5126 で、0.52〜1.00
の間は空白。アプリは閾値 0.9（`src/fief_dedupe.ts` の
`FIEF_COVERAGE_SUPPRESS_THRESHOLD`）以上の勢力の base
ラベルだけを抑制する（1000〜1300 の `Britany`）。境界線側は部分重複の勢力に
由来する分が多数（1200 年で諸侯領内部を走る base 境界線 4,167 km のうち
`Britany` は 794 km）で、feature 単位の判定では消せないため線を幾何的に
切り出す。切り出し後、諸侯領内部に残る base 境界線は 1000/1100/1200 年で 0
km、1279/1300 年で 21 km（元 3,102 km）。

ライセンス: `base_outline_<year>.geojson` は
`europe_<year>.geojson`（GPL-3.0）の 座標をそのまま切り出した派生物なので
GPL-3.0 を引き継ぐ。クリップに使う `france_fiefs_<year>`（CC0
1.0）はパブリックドメインで混合制約が無いため、この 派生は許される。CC BY-NC-SA
4.0 の HRE 領邦データを同様に混ぜてはならない。

### 3.6 諸侯領同士の重なり解消（`france_fiefs_flat_<year>.geojson`）

諸侯領は 1 枚のレイヤーに半透明（`src/powers.ts` の `FILL_ALPHA` = 128）で
描かれるため、親公領に内包される伯領や OHM のリレーション間の境界不一致が
そのまま「色の濃い帯」と「二重の輪郭」になる。`deno task
build-fief-flat`（`scripts/build-fief-flat.ts`、ネットワーク不要）が
`france_fiefs_<year>` から重なりを排他化した `france_fiefs_flat_<year>.geojson`
を生成し、アプリはこちらを配信・描画する （`src/powers.ts` の
`franceFiefDataUrlFor`、`scripts/build.ts`
のコピー対象）。生データ側は派生の入力として残り、`dist/` には含まれない。

判定は全ペアの交差面積を「面積が小さい側」で割った被覆率で行う。実測（5
年代の全ペア）では被覆率が 1.0000（`Alençon` × `Normandy`。史実の封建的包含で
データ誤りではない）と 0.0541（`Bar` × `Champagne`）の 2
群に完全に分かれ、その間に観測値が無いため、閾値 0.9
（`CONTAINMENT_COVERAGE_THRESHOLD`）で内包とスリバーを分ける。

| 種別     | 判定                  | 処理                                    |
| -------- | --------------------- | --------------------------------------- |
| 内包     | 被覆率 >= 0.9         | 親（面積が大きい側）から子を difference |
| スリバー | 0.001 km² 〜 0.9 未満 | 面積が小さい側から相手を difference     |

子（内包される伯領）のジオメトリは一切変更しないため、輪郭・ラベル・picking
はそのまま維持され、階層関係は「親の輪郭の内側に子の区画がある」入れ子構造で
読み取れる。親の picking が子の領域で反応しなくなるのは意図した挙動
（その位置では子が拾われるのが正しい）。非内包で 1,000 km²
（`SLIVER_AREA_LIMIT_M2`）を超える重なりは境界不一致では説明できない規模なので、
削りはするが警告を出す（現状の実データでは発生しない）。

年別の処理件数: 1000 年 3 件（全てスリバー）、1100 年 4 件（内包 1・スリバー
3）、1200 年 6 件（内包 1・スリバー 5）、1279 / 1300 年 各 5 件（全て
スリバー）。ライセンスは入力の `france_fiefs_<year>`（CC0 1.0）を引き継ぐ。

### 3.7 諸侯領土（中世 HRE 領邦 `hre_fiefs_<year>.geojson`）

`deno task build-hre-fiefs`（`scripts/build-hre-fiefs.ts`、TASK-85）が
OpenHistoricalMap（OHM）の Overpass API から生成する、1000〜1492
年の神聖ローマ帝国 領邦。**§3.3 の `hre_<year>.geojson`（Roller
由来・1500〜1700）とは別系統・別ファイル**
で、年代は重複しない。共通ロジック（Overpass クエリ・`start_date` / `end_date`
の年判定・ リレーション → MultiPolygon 化）は `scripts/build-france-fiefs.ts`
から import している。

| プロパティ        | 内容                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `NAME`            | 領邦の英語名（OHM の `name:en` そのまま。例: Prince-Bishopric of Würzburg）              |
| `SUBJECTO`        | `Holy Roman Empire` 固定（`hre_<year>.geojson` と同じ）                                  |
| `PARTOF`          | `Holy Roman Empire` 固定（同上）                                                         |
| `ADMIN_LEVEL`     | OHM の `admin_level`（4 = 公領・司教領級 / 5 = 下位の伯領・領主領）                      |
| `OHM_RELATION_ID` | 出典の OHM リレーション ID（`https://www.openhistoricalmap.org/relation/<id>` で参照可） |
| `START_DATE`      | OHM の `start_date`（`0962` / `1254-04-03` など生の表記）                                |
| `END_DATE`        | OHM の `end_date`。`null` は無期限（タグ欠損）                                           |

properties は `hre_<year>.geojson` の 3 プロパティ（`NAME` / `SUBJECTO` /
`PARTOF`）を
含む上位集合なので、表示側は年代で出典が変わっても同じ扱いができる。生成物の末尾には
`france_fiefs_<year>.geojson` と同じ `metadata`（出典 `OpenHistoricalMap`・
ライセンス `CC0-1.0`・年・feature 数・欠損記録）を GeoJSON の foreign member
として 埋め込んでいる。

#### 収録できた領邦（年代別）

取得範囲は帝国中核域の bbox（南緯 45.5°〜北緯 55.0°、東経 5.5°〜19.0°）で、
この範囲の `boundary=administrative` は 34,005 リレーション。

|   年 | 件数 | バイト数 | 合計面積（概算 km²） | 主な領邦                                                            |
| ---: | ---: | -------: | -------------------: | ------------------------------------------------------------------- |
| 1000 |   19 |   58,386 |              544,855 | バイエルン公領 / ザクセン公領 / フランケン公領 / シュヴァーベン公領 |
| 1100 |   23 |   68,958 |              542,256 | 上記 + ボヘミア公領                                                 |
| 1200 |   26 |   83,916 |              122,184 | シュヴァーベン公領 / モラヴィア / マクデブルク大司教領              |
| 1279 |   40 |  128,306 |              110,706 | オーストリア公領 / モラヴィア / ニュルンベルク城伯領                |
| 1300 |   52 |  160,944 |              151,447 | 上記 + ヴィエノワ・ドーフィネ / ホラント伯領                        |
| 1400 |   63 |  151,583 |              239,371 | ミラノ公領 / オーストリア公領 / ルクセンブルク公領                  |
| 1492 |   73 |  174,993 |              226,502 | ポンメルン公領 / モラヴィア / ロレーヌ公領 / フリースラント         |

面積は簡略化前の球面近似（クリップなし）で、史実の領土面積ではない。許可リスト
`HRE_FIEF_NAMES`（98 件）は実測データから作っており、全 98 件がいずれかの年代の
生成物に現れる（`scripts/build-hre-fiefs_test.ts` で担保）。

採用したのは帝国等族のうち領域を持つもので、世俗領邦（Duchy / March /
Burgraviate / Landgraviate / County / Lordship / Principality /
Electorate）・聖界領邦 （Prince-Archbishopric / Prince-Bishopric / Imperial
Abbey / Princely Abbey）・ 特殊な 3
件（ディトマルシェン農民共和国・エルフルト行政体・モラヴィア）。

#### 収録を見送った対象

`admin_level` は 4 / 5 のみを採る。2 は主権国家レベル（帝国自身・フランス /
ハンガリー / ポーランド / クロアチア王国・ヴェネツィア）、3 は帝国の構成王国
（Regnum Burgundiae / Regnum
Lotharii）とサヴォイアで、配下の領邦と領域が重なる。 そのうえで対象年に有効な
171 件から 72 件を以下の分類で落とした（根拠は `scripts/build-hre-fiefs.ts` の
`HRE_FIEF_EXCLUSIONS` にコードとして記録している）。

| 分類                                 | 件数 | 理由                                                                                  |
| ------------------------------------ | ---: | ------------------------------------------------------------------------------------- |
| 帝国都市・ハンザ都市・都市共和国     |   43 | 帝国等族だが領邦ではなく、市域だけの数十 km² なので簡略化で微小破片になる             |
| ハンガリー王国の県（`vármegye`）     |    9 | bbox 東端が西ハンガリーに掛かるため入るが帝国外                                       |
| ポーランド王国の県（Voivodeship 等） |   11 | bbox 北東端に掛かる帝国外の行政区画                                                   |
| クロアチア王国の県                   |    1 | Varasdin County。bbox 南東端に掛かる帝国外                                            |
| ザクセン公領内の部族地域             |    4 | Angria / Eastphalia / Nordalbingia / Westphalia。領主のいる領邦ではなく二重塗りになる |
| 仏諸侯領と重複                       |    3 | County of Bar / County of Champagne / Duchy of Burgundy は §3.4 で収録済み            |
| 包含関係の連合体                     |    1 | County of Schaumburg and Holstein-Pinneberg は構成 2 伯領を採るため連合体側を落とす   |
| 表示名に使えない名称                 |    1 | County of Ratzeburg (1143-1204) は `name:en` に期間の曖昧性解消が入っている           |
| OHM 側の年代誤り                     |    1 | Golden Ambrosian Republic（史実 1447〜1450）が 1492 年でも有効判定になる              |

デンマークの Herred（13 件）と北イタリアの Plebis（11 件）はいずれも OHM で
`admin_level` 6 なので、`admin_level` の絞り込みの段で自動的に落ちる。

**最古年は SNAPSHOT_YEARS と同じ 1000。** かつて最古のスナップショット年だった
900 年は当初から生成対象外だった（神聖ローマ帝国の成立は 962 年で 900
年時点は東フランク王国。許可リストで有効なのも 6 件にとどまる）。TASK-119 で 900
年はスナップショット年自体が廃止され、これに伴い 900 年にしか掛からない Duchy of
Lotharingia は許可リストから外したままにしている。

**1200 年は「谷」だが収録する。** 1100 → 1200 で合計面積が 542,256 → 122,184 km²
に 落ちるのは、OHM
が部族大公領（バイエルン・ザクセン・フランケン・チューリンゲン。 いずれも
1100〜1180 で `end_date`）を境に「大公領の面」から「個別領邦の面」へ収録方式を
切り替えているためで、データ欠損ではなく粒度の変化である。1200 年（26 件 /
122,184 km²）は収録済みの 1279 年（40 件 / 110,706 km²）より被覆が広いため、1279
を 採る以上 1200 を落とす理由が無い。ただし 1200
年は帝国中核（バイエルン・ザクセン・ フランケン・チューリンゲン）が空白になる。

#### Roller データとの統一の是非（比較のみ・現状維持）

1500 年以降も OHM に統一すれば出典が 1 本化されライセンスも CC0
に揃うが、採らない。

| 観点         | Roller（`hre_<year>`・1500〜1700）                       | OHM（`hre_fiefs_<year>`・1000〜1492）                      |
| ------------ | -------------------------------------------------------- | ---------------------------------------------------------- |
| 性質         | 査読済み学術データセット（DOI 10.3929/ethz-b-000472583） | コミュニティ編集                                           |
| 属性         | 宗派・上位関係まで属性化（558 行 / 276 ユニーク id）     | `name:en` / `admin_level` / `start_date` / `end_date` のみ |
| 選定         | 276 件から主要 14 領邦を選定して使用                     | 許可リスト 98 件・1492 年は 73 件                          |
| 年代間の整合 | 同一ソースの時系列なので形状が年代間で整合               | 年代ごとに独立したリレーションで、粒度の変化がある         |

差し替えると 1492 → 1500 の境目で形状が不整合になるため、「中世は OHM・近世は
Roller」の 2 系統併存とし、年代の重なりは作らない。

#### 座標丸めで生じる「くびれ」の後処理

`shrinkToLimit` の座標丸め（小数 5 桁 ≒ 1 m）で近接した 2
頂点が同一座標へ潰れると、パート内のリングが 1
点だけを共有した状態になる。実データでは穴が外環に接する形で現れ（Prince-Bishopric
of Passau は穴の始点が外環の頂点と同一座標 `[13.44967, 48.57576]`、Duchy of
Lorraine も 1492 年に同種）、面としては正しいので `@turf/union`
では形が変わらず、`scripts/clean-polygons.ts` の `normalizeSelfIntersections`
では `unresolved` のまま残る。一方 `@turf/kinks`
は自己交差として検出するため、`data/`
全体の「自己交差ゼロ」不変条件（`scripts/clean-polygons_test.ts`
の全年代テスト）を満たせない。

そこで `scripts/build-hre-fiefs.ts` の `removePinchPoints`
が、パート単位で同一座標の 2
回目以降の出現を落として接触を解いている（外環を先に見るので落ちるのは穴側の頂点。形状の変化は丸め誤差の範囲）。実測で落ちるのは
1 年代あたり 1〜2
頂点だけ。生成ログの「自己交差が残存（要調査）」はこの後処理より前の集計なので、最終状態は同じログの「自己交差:
0 件（最終状態）」を見る（残っていればビルドが失敗する）。

微小破片（1 km² 未満の外環・穴）と 4 頂点未満の退化リングも 0
件（`scripts/build-hre-fiefs_test.ts` と `scripts/clean-polygons_test.ts`
で担保）。

### 3.8 諸侯領土（中世イタリア諸侯領 `italy_fiefs_<year>.geojson`）

`deno task build-italy-fiefs`（`scripts/build-italy-fiefs.ts`、TASK-95）が
OpenHistoricalMap（OHM）の Overpass API から生成する、1000〜1492
年の北・中部イタリアの諸侯領・都市共和国。§3.7 の `hre_fiefs_<year>.geojson`
とは別系統・別ファイルで、共通ロジック（Overpass クエリ・`start_date` /
`end_date` の年判定・リレーション → MultiPolygon 化・くびれ解消）は
`scripts/build-france-fiefs.ts` と `scripts/build-hre-fiefs.ts` から import
している。

**なぜ hre-fiefs の bbox・許可リストを広げず独立系統にしたか。** (1)
帰属が単一でない。フィレンツェ・ジェノヴァ・ピサ・シエナ・ルッカのコムーネは名目上イタリア王国＝帝国の構成王国内だが実質は独立、スポレート公国とアンコーナ共和国は教皇領の側、サルッツォ辺境伯領はサヴォイア／プロヴァンス圏で、全
feature に `SUBJECTO` / `PARTOF` = `Holy Roman Empire` を置く `hre_fiefs_<year>`
の前提と噛み合わない。(2) 除外規則の論拠が当てはまらない。 `hre_fiefs`
は帝国都市を「領邦ではなく市域だけの数十
km²」として落とすが、イタリアのコムーネは contado（周辺農村）を含み 1,000〜6,000
km² 規模で、同じ規則を当てると主要勢力を取りこぼす。(3) `hre_fiefs` の bbox
を南へ広げると帝国側の取得件数（34,005
リレーション）が増え、既存の生成物に不要な差分が出る。

| プロパティ        | 内容                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `NAME`            | 表示名（期間つき曖昧性解消を外した名前。例: Republic of Pisa）                           |
| `OHM_NAME`        | OHM 上の名前（`name:en`。無ければ `name`。例: Republic of Pisa (1399-1406)）             |
| `ADMIN_LEVEL`     | OHM の `admin_level`（3 / 4 / 6）                                                        |
| `OHM_RELATION_ID` | 出典の OHM リレーション ID（`https://www.openhistoricalmap.org/relation/<id>` で参照可） |
| `START_DATE`      | OHM の `start_date`（`0831` / `1395-05-11` など生の表記）                                |
| `END_DATE`        | OHM の `end_date`。`null` は無期限（タグ欠損）                                           |

`NAME` / `ADMIN_LEVEL` / `OHM_RELATION_ID` / `START_DATE` / `END_DATE` は
`france_fiefs_<year>.geojson` と同じ形で、`OHM_NAME`
だけが追加。生成物の末尾には同じく `metadata`（出典 `OpenHistoricalMap`・
ライセンス `CC0-1.0`・年・feature 数・欠損記録・bbox 外で落としたパート数）を
GeoJSON の foreign member として埋め込んでいる。

#### 収録できた諸侯領（年代別）

取得範囲は北・中部イタリアの bbox（北緯 42.0°〜46.6°、東経
6.5°〜14.2°）で、この範囲の `boundary=administrative` は 1,353 リレーション。

|   年 | 件数 | バイト数 | 合計面積（概算 km²） | 主な諸侯領                                                                    |
| ---: | ---: | -------: | -------------------: | ----------------------------------------------------------------------------- |
| 1000 |    3 |    8,983 |               57,285 | トスカーナ辺境伯領 / スポレート公国 / モンフェッラート辺境伯領                |
| 1100 |    7 |   20,467 |               81,226 | 上記 + ピサ共和国 / ジェノヴァ共和国 / アンコーナ共和国 / アスティ伯領        |
| 1200 |   10 |   18,416 |               55,530 | フィレンツェ共和国 / シエナ共和国 / ルッカ共和国 / サルッツォ辺境伯領         |
| 1279 |   12 |   22,498 |               52,630 | 上記 + マッサ共和国 / ソヴァーナ伯領 / サンタ・フィオーラ伯領                 |
| 1300 |   14 |   23,568 |               39,071 | 上記 + リミニ領主領 / オネーリア領主領                                        |
| 1400 |   16 |   26,094 |               44,253 | 上記 + ピオンビーノ領主領 / ミランドラ公国 / ピティリアーノ伯領               |
| 1492 |   20 |   38,679 |               61,467 | フィレンツェ公国 / モデナ・レッジョ公国 / フェラーラ公国 / マントヴァ辺境伯領 |

面積は簡略化後の球面近似（諸侯領同士の重なりは差し引いていない）で、史実の領土面積ではない。比較として
§3.7 の HRE 領邦は 1200 年が 26 件 / 122,184 km²。許可リスト
`ITALY_FIEF_NAMES`（27 件）は実測データから作っており、全 27
件がいずれかの年代の生成物に現れる（`scripts/build-italy-fiefs_test.ts`
で担保）。1000 年は 3 件だけだが、トスカーナ辺境伯領（31,764 km²）と
スポレート公国（22,146 km²）で中部イタリアの大半を覆うため収録する。

#### 名前の解決と表示名の上書き

OHM のイタリア系リレーションには `name:en` を持たず `name`
が英語のものがあり（County of Asti / Republic of Ancona / 1350〜1555 の Republic
of Siena / Republic of Noli）、`name:en`
だけを見ると主要勢力を取りこぼす。そこで `name:en` → `name`
の順で名前を解決する（英語でない `name`
は許可リストに載らないので採用されない）。

さらに `name:en` に期間の曖昧性解消が入ったものは表示名を上書きする。とくに
`Republic of Pisa (1399-1406)` は 1050〜1406 の全 5
リレーションが同じこの名前を持っており、括弧内の期間はどのリレーションの実際の期間とも一致しない（OHM
側の誤り）。§3.7 の HRE 領邦は同種の `County of Ratzeburg (1143-1204)`
を落としたが、ピサは中核勢力なので落とさず `Republic of Pisa`
に上書きしている（`Lordship of Oneglia` / `Principality of Oneglia` /
`Duchy of Ferrara` も同様）。

#### 同名リレーションの選択規則

OHM は 1 つの勢力について「存続期間全体を覆う包括リレーション」と「年代ごとの
領域スナップショット」を並存させることがある。ピサ共和国は 6
件すべてが同じ名前・同じ `admin_level` 4 で並ぶ:

| リレーション ID | 期間       | 領域                | 面積（km²） |
| --------------- | ---------- | ------------------- | ----------: |
| 2750719         | 1081〜1406 | 本土のみ            |       4,577 |
| 2853300         | 1050〜1115 | 本土 + コルシカ     |      16,184 |
| 2853298         | 1184〜1207 | 本土 + コルシカ     |      16,184 |
| 2853293         | 1215〜1295 | 本土 + サルデーニャ |      32,298 |
| 2853296         | 1295〜1324 | 本土 + サルデーニャ |      20,796 |
| 2853485         | 1399〜1406 | 本土のみ            |       3,552 |

既存の `selectFiefsForYear` / `selectHreFiefsForYear` は「`admin_level` 昇順 →
ID 昇順」で 1 件に絞るが、この 6 件は同 level なので ID の若い 2750719
が偶然に選ばれ、どの年代でも同じ形になってしまう。そこで**有効期間が短い
リレーションを優先する**（同じなら `admin_level` 昇順 → ID
昇順）。期間の短い方が
その年代に固有のスナップショットで、長い方は存続期間を通じて変わらない中核領域しか
持たないため年代精度が落ちる、というのが根拠。この規則は 1100 / 1200
年にコルシカを含み、1279 / 1300 年にサルデーニャを含み、メロリアの海戦後の 1400
年には本土のみに戻る、という史実の推移を再現する。

#### bbox の外に出るパートの除去

海洋共和国のリレーションはイタリア半島の外に飛び地を持つ。実データでは Republic
of Genoa の黒海（カッファ 908 / 2,463 km²・東経 34〜37 度）とエーゲ海（キオス
1,603 km² 他・東経 26 度）の植民地、Republic of Genoa / Republic of Pisa
のサルデーニャ（北緯 38.8〜41.3
度）が該当する。これらは本オーバーレイの対象外なので、パートのバウンディングボックスが
取得 bbox と交差しないものを落としている（1279 年 5 件・1300 年 6 件・1400 年 5
件・1492 年 1 件）。クリップはしないので形は変えず、一部でも掛かるパートは残る
（コルシカは北緯 41.3〜43.0 度で南限 42.0
に掛かるため残り、ピサ・ジェノヴァのコルシカ支配が表現される）。

#### 収録を見送った対象

`admin_level` は 3 / 4 / 6 を採る。2 は主権国家レベル（ヴェネツィア共和国・
教皇領・シチリア王国）で base の `europe_<year>` が担う。6 は本来 Plebis（教区）
等の細分だが、March of Montferrat（アレラミチ家の辺境伯領・1000〜1708・3,382
km²）だけが公領・共和国と同格の実体を持ちながらこの level に置かれているため、
level ではなく許可リストで採っている。そのうえで以下の分類で落とした（根拠は
`scripts/build-italy-fiefs.ts` の `ITALY_FIEF_EXCLUSIONS`
にコードとして記録している）。

| 分類                                 | 対象                                                                                                                                                                                      | 理由                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| HRE 領邦と重複                       | Duchy of Milan / March of Verona / Lordship of Verona / Duchy of Bavaria / Duchy of Swabia / Duchy of Carinthia / Duchy of Carniola / Prince-Bishopric of Freising / Dauphiné of Viennois | §3.7 で収録済み。同じ土地を 2 系統で塗らない                         |
| アルプス以北・アドリア海北岸の帝国領 | Margraviate of Istria 696 km² / Triest 163 km² / Free Imperial City of Bern                                                                                                               | イタリア王国の外（ハプスブルク領・スイス誓約同盟）                   |
| 帝国構成王国・サヴォイア             | Kingdom of Burgundy 101,974〜114,748 km² / Savoyard state 35,989〜40,322 km²                                                                                                              | `admin_level` 3 で配下のサルッツォ・アスティ等と領域が重なる         |
| シチリア（ナポリ）王国の州           | Aprutium beyond the Pescara 9,622 km² / Aprutium this side of the Pescara 3,390 km²                                                                                                       | 南イタリアは主権国家として base が担う                               |
| フランス側の領域                     | Provence 23,215 km²（1487 年〜）                                                                                                                                                          | イタリアの諸侯領ではない                                             |
| 100 km² 未満の微小領域               | San Marino 7〜22 km² / City of San Marino / Fiorentino / County of Vernio 12 km² / Republic of Noli 58 km² / County of Novellara and Bagnolo 50 km²                                       | 簡略化すると点に近くなる。収録した最小は County of Guastalla 133 km² |
| OHM 側の年代誤り                     | Golden Ambrosian Republic（史実 1447〜1450 が OHM では 1449〜1500）                                                                                                                       | §3.7 と同じ扱い。結果として 1492 年のミラノは空白                    |
| ジオメトリが無い                     | Lordship of Milan（1259〜1349）/ Pisan Corsica（1050〜1284）                                                                                                                              | メンバーが label ノードだけで面を組めない                            |
| 親リレーションに含まれる島           | Genoese Corsica / Milanese Corsica（いずれも 11,502 km²）                                                                                                                                 | Republic of Genoa の年代スナップショットが同じコルシカのパートを含む |

**ミラノは 1279 / 1300 / 1492 年が空白になる。** 1279 / 1300 年の
`Lordship of
Milan` はジオメトリが無く、1492 年に有効なのは年代誤りの
`Golden Ambrosian
Republic` だけで、1400 年は §3.7 の `Duchy of Milan`
が収録している。OHM に無く収録できないその他の主要勢力:
ヴェネツィア共和国（`admin_level` 2 で base
側）・ボローニャ・パドヴァ・ウルビーノ公領。

#### 宗主勢力の外枠（ホバー/クリック時）の解決結果（TASK-121）

伊諸侯領も `SUBJECTO` / `PARTOF` を 1 件も持たないため、勢力圏の外枠
（decision-19）の宗主キーは仏諸侯領・Cliopatria 領邦と同じ包含の規則
（decision-27: 封土のラベルのアンカーを含む base 勢力）で決めている。**帰属の
性格が混在する（帝国イタリア側の領邦・教皇領側・事実上独立の都市共和国）ことは
実装上の判断を要さない**。base が既に描いている帰属をそのまま読むだけなので、
「コムーネを名目上の帝国従属とみなすか」といった解釈を実装者が入れずに済む
（decision-19 の「宗主補正は歴史的に明白な関係に限る」を最も強く満たす形）。

全 7 年代・全 82 feature の実測は次のとおり。

| 年代 | 神聖ローマ帝国 | 教皇領 | Corsica | 外枠なし |
| ---: | -------------: | -----: | ------: | -------: |
| 1000 |              3 |      0 |       0 |        0 |
| 1100 |              4 |      2 |       1 |        0 |
| 1200 |              7 |      2 |       1 |        0 |
| 1279 |             10 |      1 |       1 |        0 |
| 1300 |             12 |      1 |       1 |        0 |
| 1400 |             13 |      1 |       1 |        1 |
| 1492 |             16 |      3 |       0 |        1 |

- **帝国イタリア側**（モンフェッラート辺境伯領・アスティ伯領・サルッツォ辺境伯
  領・マントヴァ辺境伯領・モデナ＝レッジョ公領など）は帝国の外枠が出る。
- **教皇領側**はスポレート公領（1100 / 1200）・アンコーナ共和国（1100〜1492）・
  フェラーラ公領（1492）・リミニ領主領（1492）。1000 年のスポレート公領が帝国に
  なるのは base が同年に中部イタリアを帝国として塗るためで、帝国大公領だった
  史実と整合する。1300 年のリミニ領主領が帝国になるのは base が同年のロマーニャ
  を帝国として塗るためで、1278 年のルドルフ 1 世による教皇領への割譲後という
  史実とはずれる。これは外枠機構ではなく base の帰属の問題なので decision-27 の
  とおり `propertyFixes` の担当（別タスク）。
- **都市共和国**（フィレンツェ・シエナ・ルッカ）は base が該当地を帝国として
  塗るため帝国の外枠が出る。名目上はイタリア王国＝帝国の内側という扱いで、 上の
  §3.8 冒頭の「実質は独立」という性格とは一致しないが、これは base の
  塗り分けをそのまま反映した結果であって本アプリの史実判断ではない。

**既知の制限: ピサ共和国（1100 / 1200 / 1279）とジェノヴァ共和国（1300 / 1400）
は外枠が `Corsica`（コルシカ島）になる。** 両共和国のポリゴンはコルシカ島を含み
（上の「bbox の外に出るパートの除去」を参照）、島の面積（11,472 km²）が本土側を
上回るためラベルのアンカーが島に立つ。base は同じ年代のコルシカを独立の勢力
`Corsica` として塗るので、包含の規則がその勢力を返す。結果として本土リグーリア
側をホバーしても外枠は島だけを囲む。

対処しない理由:

1. 宗主補正（`suzerains`）で帝国へ寄せるのは「海洋共和国は名目上帝国の従属」と
   いう解釈を実装者が持ち込むことになり、decision-19 に反する（TASK-101 が
   ノルマンディー公の臣従礼を宗主補正の基準に当たらないとしたのと同じ理由）。
2. 「宗主候補の版図が封土より小さければ包含とみなさない」という面積のガードも
   検討したが、実測すると仏封土 7 件（1000〜1300 のブルターニュ公領・ノルマン
   ディー公領。base 側のポリゴンがオーバーレイ側より小さい）が外枠を失い、
   TASK-120 で直した挙動を壊す。
3. 根本は「オーバーレイがコルシカをピサ／ジェノヴァ領として描き、base が独立の
   Corsica として描く」という 2 系統の帰属の食い違いで、外枠の側では直せない。

**ピオンビーノ領主領（1400 / 1492）は外枠が出ない。** ラベルのアンカーが base の
どのポリゴンにも含まれない（海側へ出る）ため。従来どおりの挙動に落ちるだけで、
封土自身の強調は行われる。

### 3.9 山脈（`mountains.geojson`、TASK-97）

Natural Earth 50m `geography_regions_polys` の `FEATURECLA = Range/mtn`
を、河川と同じピン留めコミット `ca96624a56bd`（Public Domain）から取得し、
EUROPE_BBOX でクリップした年代非依存の 1
ファイル（`scripts/build-mountains.ts`）。
山脈は全年代で同一の地形なので年代スナップショットとは独立させる。

properties は `name`（NE の `NAME`、英語）/ `scalerank` / `min_label` の 3
つだけに間引き、日本語表記は他と同じく `data/name-ja.json` で引く。NE 側の
`NAME_JA` をそのまま使わない例外は `ELBURZ MTS.` の 1 件で、NE
の「エルブルス山」はコーカサスの Mount Elbrus
との取り違えなので「アルボルズ山脈」を採る。

**収録した 17 件**（`ADOPTED_MOUNTAIN_NAMES`。`km²`
はクリップ後の測地面積、`残存` は元ポリゴンに対する比、`z`
はラベルを出し始めるズーム段 = `ceil(MIN_LABEL)` を `MIN_ZOOM..MAX_ZOOM`
にクランプした値）:

| SCALERANK | NAME                 | 日本語                 |     km² | 残存 |  z |
| --------: | -------------------- | ---------------------- | ------: | ---: | -: |
|         1 | ALPS                 | アルプス山脈           | 176,043 | 100% |  4 |
|         1 | URAL MOUNTAINS       | ウラル山脈             | 175,566 |  84% |  4 |
|         1 | CAUCASUS MTS.        | コーカサス山脈         | 156,149 | 100% |  4 |
|         2 | ATLAS MOUNTAINS      | アトラス山脈           | 334,650 |  49% |  4 |
|         3 | KJØLEN MOUNTAINS     | スカンディナヴィア山脈 | 214,182 | 100% |  4 |
|         3 | CARPATHIAN MOUNTAINS | カルパティア山脈       | 220,507 | 100% |  4 |
|         3 | APPENNINI            | アペニン山脈           |  59,782 | 100% |  4 |
|         3 | PYRENEES             | ピレネー山脈           |  38,895 | 100% |  4 |
|         3 | ELBURZ MTS.          | アルボルズ山脈         |  58,457 | 100% |  4 |
|         3 | ATLAS SAHARIEN       | サハラ・アトラス山脈   |  26,740 |  46% |  5 |
|         4 | Dinaric Alps         | ディナル・アルプス山脈 | 125,286 | 100% |  6 |
|         4 | Lesser Caucasus      | 小コーカサス山脈       |  62,892 | 100% |  6 |
|         4 | PONTIC MOUNTAINS     | ポントス山脈           |  54,860 | 100% |  6 |
|         4 | Balkan Mts.          | バルカン山脈           |  36,811 | 100% |  6 |
|         4 | Cord. Cantábrica     | カンタブリア山脈       |  28,013 | 100% |  6 |
|         4 | S. Nevada            | シエラネバダ山脈       |  22,483 | 100% |  6 |
|         4 | Sierra Morena        | シエラ・モレナ山脈     |  29,399 | 100% |  6 |

**収録しなかったもの**:

| 対象                                                               | 理由                                                                                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ZAGROS MOUNTAINS` 残存 14% / `KUH RUD MOUNTAINS` 残存 10%         | 山体の大半が EUROPE_BBOX の外（ペルシア内陸）。クリップされた断片にアンカーを置くと山脈の代表位置として誤りになる（`MIN_CLIP_AREA_RATIO = 0.4`） |
| `PENÍNSULA IBÉRICA` / `CENTRAL RUSSIAN UPLAND` / `Ustyurt Plateau` | `FEATURECLA = Plateau` で山脈ではない。とくにイベリア半島は半島全体を覆う巨大ポリゴンで、山脈ラベルとして出すと地域名の注記になってしまう        |

`ATLAS MOUNTAINS`（49%）と `ATLAS SAHARIEN`（46%）を残すのは、マグリブが地図に
本体ごと映り（都市マーカーのアルジェ・チュニスと同じ範囲）陰影も見えるため。
`MIN_CLIP_AREA_RATIO = 0.4` はこの 2 件とザグロス（14%）の間に閾値を置いた値。

### 3.10 山峰（`peaks.geojson`、TASK-99）

Natural Earth 10m `geography_regions_elevation_points` を、河川・山脈と同じ
ピン留めコミット `ca96624a56bd`（Public Domain）から取得し、EUROPE_BBOX
内の点に絞った年代非依存の 1 ファイル（`scripts/build-peaks.ts`）。山峰も
全年代で同一の地形なので年代スナップショットとは独立させる。

properties は `name`（NE の `name`、英語）/ `elevation`（m）/ `scalerank` の 3
つだけに間引き、日本語表記は他と同じく `data/name-ja.json` で引く（値は NE の
`name_ja`）。このレイヤーの properties キーは**小文字**で、山脈が使う 50m
`geography_regions_polys` の大文字キーとは異なる。

日本語表記は NE の `name_ja` をそのまま採るのを原則とするが、**1 件だけ手を
入れている**: `Djebel Chelia` は NE が「ドジュベル・シェリア山」としているが、
同じアラビア語 جبل（jabal）を含む `Jebel Tidirhine` は「ジェベル・ティディリーヌ
山」で、同一データ内で同じ語の音写が割れる。日本語表記の慣用に沿う後者へ寄せて
「ジェベル・シェリア山」とした。語尾の「山」の有無（モンブラン／マッターホルンは
付けず、エトナ山／ベン・ネビス山は付ける）は日本語側の慣用が山ごとに割れるため
統一せず NE のままとする。

NE の英語 `name` には ASCII 化の取りこぼしがある（`Galdhpiggen` =
Galdhøpiggen、`Hvannadalshnkur` = Hvannadalshnúkur）。表示に出るのは日本語名
なので地図の見た目には影響しないが、`name-ja.json` のキーは突合キーとして NE
の綴りのまま揃える。

**収録条件**: `featurecla = mountain` かつ `name` を持ち、
`scalerank <= 6`（`MAX_PEAK_SCALERANK`）**または** `elevation >= 4600 m`
（`MIN_PEAK_ELEVATION_M`）。EUROPE_BBOX 内の名前付き `mountain` は 99 件
あり、そのうち 26 件が残る。

- `scalerank <= 6`: EUROPE_BBOX 内の scalerank は 2/3/6/7/9 の 5 段しかなく
  （実測 2=1・3=1・6=20・7=25・9=52 件）、7 まで広げると 47 件でアルプス〜
  バルカンのラベルが密集する。scalerank は標高ではなく「低ズームでも出す価値の
  ある地物か」の格付けなので、ヴェスヴィオ（1,281 m）やベン・ネビス（1,343 m）
  のように標高順では落ちる歴史的な目印がこの帯で拾える。
- `elevation >= 4600 m`: NE の scalerank は標高と一致せず、モンテ・ローザ
  （4,634 m）・シュハラ（5,200 m）・アララト（5,137 m）が scalerank 9、
  サバラン（4,814 m）が 7 に落ちている。scalerank 7 以下を標高降順に並べると
  5,200 / 5,137 / 4,814 / 4,634 / 4,494 / 4,466 / 4,274 …で、4,634 と 4,494 の
  間の 140 m がこの帯で最も広い空き（他は 14〜63 m 刻み）。閾値をその空きに
  置くことで、上流の標高がわずかに更新されても収録集合が揺れない。

**収録した 26 峰**（`ADOPTED_PEAK_NAMES`。標高は NE の `elevation`、座標は
生成物の丸め後）:

| SCALERANK | NAME                     | 日本語                         | 標高 m | 経度, 緯度          |
| --------: | ------------------------ | ------------------------------ | -----: | ------------------- |
|         2 | Gora Elbrus              | エルブルス山                   |  5,642 | 42.4392, 43.35517   |
|         6 | Mount Damavand           | ダマーヴァンド山               |  5,610 | 52.10902, 35.95519  |
|         9 | Gora Shkhara             | シュハラ山                     |  5,200 | 43.1, 43.00001      |
|         9 | Mount Ararat             | アララト山                     |  5,137 | 44.29996, 39.7001   |
|         7 | Sabalon Kuh              | サバロン山                     |  4,814 | 47.82202, 38.25509  |
|         3 | Mont Blanc               | モンブラン                     |  4,807 | 6.86504, 45.83368   |
|         9 | Monte Rosa               | モンテ・ローザ                 |  4,634 | 7.86999, 45.94003   |
|         6 | Matterhorn               | マッターホルン                 |  4,478 | 7.72958, 45.93817   |
|         6 | Grossglockner            | グロースグロックナー山         |  3,798 | 12.69533, 47.07471  |
|         6 | Monte Etna               | エトナ山                       |  3,322 | 14.99514, 37.75512  |
|         6 | Musala                   | ムサラ山                       |  2,925 | 23.58683, 42.17982  |
|         6 | Mount Olympus            | オリンポス山                   |  2,917 | 22.35012, 40.08325  |
|         6 | Moldoveanu               | モルドベアヌ山                 |  2,543 | 24.74769, 45.60846  |
|         6 | Galdhpiggen              | ガルフピッゲン                 |  2,469 | 8.31268, 61.63648   |
|         6 | Jebel Tidirhine          | ジェベル・ティディリーヌ山     |  2,456 | -4.51181, 34.83021  |
|         6 | Djebel Chelia            | ジェベル・シェリア山           |  2,326 | 6.66648, 35.33336   |
|         6 | Lalla Khedidja           | ララ・ケディジャ               |  2,308 | 4.22909, 36.4571    |
|         6 | Kebnekaise               | ケブネカイセ                   |  2,111 | 18.50452, 67.90602  |
|         6 | Hvannadalshnkur          | クヴァンナダルスフニュークル   |  2,110 | -16.65093, 64.03889 |
|         6 | Oksskolten               | オクスコルテン山               |  1,916 | 14.3374, 66.0245    |
|         6 | Gora Yamantau            | ヤマンタウ山                   |  1,638 | 58.11719, 54.24349  |
|         6 | Gora Konzhakovskiy Kamen | コンジャコフスキー・カーメン山 |  1,569 | 59.13449, 59.63278  |
|         6 | Ben Nevis                | ベン・ネビス山                 |  1,343 | -5.00499, 56.797    |
|         6 | Vesuvio                  | ヴェスヴィオ山                 |  1,281 | 14.43337, 40.81672  |
|         6 | Snowdon                  | スノードン山                   |  1,085 | -4.09481, 53.07254  |
|         6 | Carrauntoohil            | キャラントゥール山             |  1,038 | -9.74272, 51.99897  |

**収録しなかったもの**:

| 対象                                                                                | 理由                                                                                                                                                  |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spot elevation` 5 件 / `depression` 1 件（カスピ海沿岸低地 -28 m）                 | `featurecla` が山峰でなく、いずれも `name` 欠損。ラベルを持てずマーカーとして意味を成さない（`PEAK_FEATURECLA = mountain`）                           |
| Gora Tebulosmta 4,494 m / Bazar Dyuzi 4,466 m / Finsteraarhorn 4,274 m など         | scalerank 7 以下かつ標高が閾値未満。いずれも山脈の最高峰は既にマーカーがある（コーカサス＝エルブルス / アルプス＝モンブラン）ので山域の情報は落ちない |
| scalerank 9 の低山（Rock of Gibraltar 426 m・Vaalserberg 321 m・Møllehøj 171 m 等） | 地図上の目印として弱く、収録すると 15〜30 件の目安を大きく超えてラベルが密集する                                                                      |

NE の英語 `name` には元データの ASCII 化による欠落がある（`Galdhpiggen` =
Galdhøpiggen・`Hvannadalshnkur` = Hvannadalshnúkur）。表示は日本語名なので
地図には影響しないが、`data/name-ja.json` のキーは NE の綴りのまま揃える
（山脈と同じく生成物の `name` が唯一の突合キーのため）。

### 3.11 諸侯領土（Cliopatria 由来 `cliopatria_fiefs_<year>.geojson`、TASK-110）

`deno task build-cliopatria-fiefs`（`scripts/build-cliopatria-fiefs.ts`）が
Cliopatria から生成する、**OHM
の欠落を埋めるためだけの補完データ**（decision-26）。
アプリが配信・描画するのは重なりを排他化した
`cliopatria_fiefs_flat_<year>.geojson`（§3.6 と同じ派生）。

| 項目             | 値                                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 出典             | Cliopatria (Seshat Global History Databank)。Bennett, J., Mutch, E., Chalstrey, E. et al. (2025) _Scientific Data_、DOI `10.5281/zenodo.14714684`           |
| ライセンス       | CC BY 4.0                                                                                                                                                   |
| ピン留め         | GitHub `Seshat-Global-History-Databank/cliopatria` @ `ad28a691b7c07c1fca89d0e0636d324667d2a258`（v0.2.0）+ アーカイブの SHA-256 `d01ae3a2…`（44,231,317 B） |
| 元ファイル       | `cliopatria.geojson.zip` 内の `cliopatria_polities_only.geojson`（165,608,072 B・13,765 feature）                                                           |
| 対象年           | 1000 / 1100 / 1200 / 1279 / 1300 / 1400 / 1492                                                                                                              |
| 境界の確からしさ | 「史料地図のデジタイズ（概略。手描き地図の自動抽出を 0.07 度で平滑化）」（§1.1 の区分 5）                                                                   |

#### 生成規則（決定的である根拠）

1. **構造的な除外**（`cliopatriaExclusionReason`）:
   `Type = RELATION`（上位関係の
   複合体）・名前が丸括弧で囲まれた複合体・`… Minor States`（残余カテゴリ）。
   **括弧付き複合体だけは例外がある**（`CLIOPATRIA_COMPOSITE_PARENTS` /
   ADR-0040・#352）。base 主権の外周置換のために採る 6 件（§3.13）に限り、
   「上流の Name × 対象年 × 区間 × SeshatID」の全点一致で除外を迂回する。
   採った親は `CLIOPATRIA_COMPOSITE = "parent"` を刻んで raw にだけ置き、
   配信される flat には出さない。
2. **許可リスト**（`CLIOPATRIA_FRANCE_FIEF_NAMES` /
   `CLIOPATRIA_HRE_FIEF_NAMES`）: 「上流の Name → 収録する年」の静的な対応表。
   OHM が同じ領邦を同じ年代で収録している場合は載せない。
3. **年代区間の選択**: `FromYear <= year <= ToYear` の**包含判定だけ**。区間外の
   年へ近い区間を寄せる救済（最近傍・外挿）はしない。同じ名前に複数の区間が
   当たったら最も狭い区間 → `FromYear` が小さい方 → `Area` が大きい方の順で
   一意に決まる。 **唯一の例外が年借用**（`CLIOPATRIA_BORROWED_YEARS` /
   ADR-0039・#346）で、 許可リストに列挙した「上流の Name × 対象年 × 区間 ×
   SeshatID」の全点一致で だけ包含判定を迂回する。現在の登録は 1 件（1200 年の
   `Kingdom of Bohemia` ← 上流 `[1202-1215]` / SeshatID
   `cz_bohemian_k_1`）。上流に対象年を直接 覆う区間が現れると
   `borrowSupersededReason` がビルドを失敗させ、通常収録への 差し替えを促す。
4. **語彙の上書き**: 上流の `Kingdom of France`（= 王の直轄領。Cliopatria は
   王国全体を複合体 `(Kingdom of France)` として別に持つ）だけ `NAME` を
   `Royal Domain of France` に読み替える。ジオメトリには触れず、上流の名前は
   `CLIOPATRIA_NAME` に残す。

`FromYear` / `ToYear` は不規則で（1279 年は `[1279-1284]`、1300 年は
`[1294-1304]`、Duchy of Brittany は `[990-1146]`）、包含判定はこの不規則さを
そのまま受ける。区間が無い年は「出典がその年について何も言っていない」ことなので
空白のままにする（decision-14 の本旨）。

#### properties

| プロパティ                | 内容                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NAME`                    | 表示名。仏諸侯領は `france_fiefs_*` と、帝国領邦は `hre_fiefs_*` と同じ扱い                                                                                                                             |
| `SUBJECTO` / `PARTOF`     | 帝国領邦は `Holy Roman Empire`、複合体の親子（#352）は置換先の base 勢力（`Poland` / `Poland-Lithuania`）、仏諸侯領は持たない                                                                           |
| `CLIOPATRIA_COMPOSITE`    | 複合体の役割（`parent` = base 置換専用で flat に出ない / `child` = 表示する leaf 区画）。ADR-0040                                                                                                       |
| `CLIOPATRIA_BASE_POWER`   | 置換先の base 勢力 NAME（複合体の親子のみ）                                                                                                                                                             |
| `START_DATE` / `END_DATE` | 採った区間の `FromYear` / `ToYear`（4 桁ゼロ詰め）                                                                                                                                                      |
| `CLIOPATRIA_NAME`         | 上流の `Name`（`NAME` を上書きした場合の追跡用）                                                                                                                                                        |
| `CLIOPATRIA_SESHAT_ID`    | 上流の `SeshatID`                                                                                                                                                                                       |
| `CLIOPATRIA_AREA_KM2`     | 上流が申告する面積（本パイプラインは再計算しない）                                                                                                                                                      |
| `WIKIDATA` / `WIKIPEDIA`  | 上流の同名フィールド                                                                                                                                                                                    |
| `SNAPSHOT_YEAR`           | どのスナップショット年のために選ばれた区間か                                                                                                                                                            |
| `BORROWED_FROM`           | 年借用（ADR-0039）の feature だけが持つ。`targetYear` / `fromYear` / `toYear` / `dataset` / `commit` / `seshatId` / `license` / `reason`。ファイル単位の同じ記録は raw・flat の `metadata.borrowedFrom` |

#### 収録した領邦（年代別）

|   年 | 件数 | 領邦                                                                                                                                                                                                                                              |
| ---: | ---: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1000 |   10 | 王領 49,071 km² / アキテーヌ公領 106,377 / ガスコーニュ公領 40,078 / ルエルグ伯領 27,863 / シャンパーニュ伯領 25,321 / トゥールーズ伯領 21,359 / フランドル伯領 19,129 / ヴェルマンドワ伯領 17,404 / ブロワ伯領 11,241 / ヴェクサン伯領 4,286     |
| 1100 |    8 | アキテーヌ公領 141,788 / トゥールーズ伯領 52,864 / ブロワ伯領 32,981 / シャンパーニュ伯領 25,276 / 王領 21,966 / ヴェルマンドワ伯領 19,332 / フランドル伯領 17,591 / ヌヴェール伯領 12,490                                                        |
| 1200 |    8 | ボヘミア王国 70,806（**年借用**。上流 `[1202-1215]`・ADR-0039） / トゥールーズ伯領 52,816 / 王領 37,024 / ヴェルマンドワ伯領 19,510 / ヌヴェール伯領 12,467 / フランドル伯領 9,229 / ブロワ伯領 7,796 / ブーローニュ伯領 684                      |
| 1279 |    9 | ボヘミア王国 80,824 / ブランデンブルク辺境伯領 41,413 / バイエルン公領 35,323 / オーヴェルニュ伯領 19,408 / アキテーヌ公領 9,626 / ペリゴール伯領 8,547 / ブロワ伯領 8,090 / アルマニャック伯領 6,985 / フォワ伯領 4,515                          |
| 1300 |   10 | ボヘミア王国 107,598 / ブランデンブルク辺境伯領 41,413 / バイエルン公領 35,301 / オーヴェルニュ伯領 19,408 / ヌヴェール伯領 13,355 / アキテーヌ公領 9,626 / フォワ伯領 8,648 / ペリゴール伯領 8,547 / アルマニャック伯領 6,985 / ブロワ伯領 3,658 |
| 1400 |    3 | ボヘミア王国 106,361 / バイエルン公領 47,598 / ブランデンブルク辺境伯領 41,923                                                                                                                                                                    |
| 1492 |    4 | ボヘミア王国 128,617 / ブランデンブルク選帝侯領 42,293 / バイエルン公領 36,100 / ザクセン選帝侯領 34,252                                                                                                                                          |

面積は上流が申告する値（`CLIOPATRIA_AREA_KM2`）で、排他化前・クリップ前のもの。
この表は**諸侯領・領邦オーバーレイとして収録した分**で、#352 で足した
ポーランドの複合体（親 1 + leaf 子区画）は次の表に分ける。

#### 複合体（base 主権の外周置換・#352 / ADR-0040）

親は `CLIOPATRIA_COMPOSITE = "parent"` を持ち raw にだけ現れる（配信される flat
には出ない）。子区画は同じ出典の leaf で、合併は親と IoU 1.0 で一致し、
子どうしの重なりは 0 km²（`scripts/build-cliopatria-fiefs_test.ts` が固定）。

|   年 | 親（上流 Name・面積 km²）              | leaf 子区画                                                                                                                                                                                                                    |
| ---: | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1000 | `(Kingdom of Poland)` 248,543          | ポーランド王国 248,543                                                                                                                                                                                                         |
| 1100 | `(Kingdom of Poland)` 200,900          | ポーランド王国 200,900                                                                                                                                                                                                         |
| 1200 | `(Duchies of Poland)` 224,656          | サンドミェシュ 142,235 / 大ポーランド 34,081 / シロンスク 29,008 / クヤヴィ 6,844 / オポーレ 6,625 / ヴロツワフ 5,861                                                                                                          |
| 1279 | `(Duchies of Poland)` 181,013          | ポーランド諸公国（その他）55,490 / マゾフシェ 31,317 / サンドミェシュ 30,741 / 大ポーランド 25,762 / シロンスク 19,086 / オポーレ 12,261 / グウォグフ 3,087 / レグニツァ 2,323 / ヤヴォル 945                                  |
| 1300 | `(Duchies of Poland)` 175,803          | ポーランド諸公国（その他）55,490 / マゾフシェ 31,317 / サンドミェシュ 25,686 / 大ポーランド 25,762 / シロンスク 19,086 / オポーレ 6,704 / ラチブシュ 3,362 / グウォグフ 3,087 / レグニツァ 2,323 / ビトム 2,040 / ヤヴォル 945 |
| 1400 | `(Polish-Lithuania Kingdom)` 1,040,497 | リトアニア大公国 806,719 / ポーランド王国 233,778                                                                                                                                                                              |

1400 年は親の直下に括弧付きの `(Kingdom of Poland)`（親と同形状の wrapper）が
いるが、`Kingdom of Poland` を配下に持つため leaf 判定（`MemberOf` に一度も
現れない名前）で自動的に落ち、leaf 2 件だけが残る。

#### 充填の効果（base 勢力に対する諸侯領オーバーレイの被覆率）

| 年   | base 勢力         | 面積 (km²) | OHM のみ | ＋Cliopatria |    残る空白 |
| ---- | ----------------- | ---------: | -------: | -----------: | ----------: |
| 1000 | Kingdom of France |    462,579 |    24.9% |    **78.5%** |      99,628 |
| 1100 | Kingdom of France |    464,523 |    26.2% |    **78.4%** |     100,251 |
| 1200 | Kingdom of France |    231,770 |    47.7% |    **77.9%** |      51,316 |
| 1200 | Comté de Toulouse |     90,755 |     4.2% |    **54.1%** |      41,683 |
| 1279 | France            |    393,610 |    31.3% |    **42.6%** |     225,892 |
| 1300 | France            |    393,610 |    35.0% |    **46.0%** |     212,487 |
| 1200 | Holy Roman Empire |    623,652 |    18.3% |        18.7% | **507,304** |
| 1279 | Holy Roman Empire |    884,038 |    16.7% |    **30.9%** |     611,237 |
| 1300 | Holy Roman Empire |    919,619 |    18.8% |    **32.4%** |     621,879 |
| 1400 | Holy Roman Empire |    919,619 |    27.0% |    **45.8%** |     498,504 |
| 1492 | Holy Roman Empire |    851,313 |    27.3% |    **50.6%** |     420,756 |

この表は TASK-110 時点（Cliopatria 採用時）の実測で、以後の base の変化は
反映していない。**1200 年の `Holy Roman Empire` 行は #346 の後で意味がずれる**:
Poland からボヘミア王国を切り出した結果、分断された残余 25,733 km² が #342 の
規則で base の `Holy Roman Empire` へ併合され、base 勢力の面積が 623,652 km²
から 増えている。また借用したボヘミア王国は base では独立 feature（宗主 =
帝国）として
立つため、この行の「被覆率」の分母にも分子にも入らない。再実測は行っていない
（この表の目的は Cliopatria 採用の効果を示すことで、その判断は変わらない）。

#### 適用後も残る空白（TASK-110 AC #6）

| 空白                             | 実測値                                                                                                | 理由                                                                                                                                                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1200 年の帝国中核                | **507,304 km²（帝国の 81.3%）**。1200 年だけ被覆率が 18.3% → 18.7% とほぼ動かない                     | OHM は部族大公領（バイエルン・ザクセン・フランケン・チューリンゲン）を 1100〜1180 で終了させ、Cliopatria は 1200 年の帝国を `Holy Roman Empire` 879,279 km² の一枚岩でモデル化して内部領邦が 0 件。どちらにも材料が無い                                                         |
| 1200 / 1279 年のザクセン公領     | OHM の `Duchy of Saxe-Wittenberg` は 1300 年から、Cliopatria の `Electorate of Saxony` は 1385 年から | 1180 年のゲルンハウゼン裁定で解体されたのは部族大公領で、ザクセン公領自体はアスカーニエン家が縮小領域で 1296 年の分裂まで継承したが、その期間に該当する面がどちらにも無い。1400 年は OHM 側（`Electorate of Saxony(-Wittenberg)`）、1492 年は Cliopatria 側（34,252 km²）が担う |
| ブルボン（Bourbon）              | Cliopatria の `House of Bourbon` は 1385 年以降のみ（1400 年 14,496 km² / 1492 年 43,379 km²）        | 1000〜1300 年の区間が Cliopatria にも無い。仏諸侯領オーバーレイは 1300 年までなので、結局どの年代でも表示されない                                                                                                                                                               |
| ガスコーニュ公領（1279 以降）    | Cliopatria の収録は `[990-1017]` のみ                                                                 | OHM も 1214 年で切れる                                                                                                                                                                                                                                                          |
| 1279 / 1300 年のトゥールーズ伯領 | Cliopatria の収録は `[1188-1205]` で終わる                                                            | 1271 年の王領併合を反映しており、伯領としての面はもう存在しない                                                                                                                                                                                                                 |
| 1279 / 1300 年のフランス         | 225,892 km²（57.4%）/ 212,487 km²（54.0%）                                                            | 王領（Cliopatria では王国規模になるため不採用）とブルゴーニュ以外の中部・南部に、どちらの出典にも領邦が無い                                                                                                                                                                     |

#### 収録を見送った対象と根拠

分類とその根拠は `scripts/build-cliopatria-fiefs.ts` の `CLIOPATRIA_EXCLUSIONS`
にコードとして記録している。要点は decision-26 の「却下した選択肢」を参照。

| 分類                               | 例                                                                                                         | 主な理由                                                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 複合体（丸括弧付き）               | `(Kingdom of France)` 1000 年 420,259 km²（王領 49,071 km² の 8.6 倍）                                     | 封臣を全て飲み込んだ 1 枚のポリゴンで、王国全体が 1 色に潰れる                                                                               |
| `Type = RELATION`                  | `(Vassalage of Kingdom of Bohemia to Holy Roman Empire)` 1400 年 1,035,034 km²                             | 領域ではなく関係を表す feature。ジオメトリは帝国複合体と同一                                                                                 |
| 残余カテゴリ                       | `Holy Roman Empire Minor States` 1279 年 518,669 / 1300 年 555,409 / 1400 年 458,794 / 1492 年 343,299 km² | 数百の小領邦の袋。補ったバイエルン等を丸ごと覆う                                                                                             |
| 主権国家                           | Holy Roman Empire / Kingdom of England / Crown of Castile / Kingdom of Hungary                             | base（`europe_<year>`）が担う                                                                                                                |
| 家門（所領の集合体）               | House of Habsburg / Ascania / Wittelsbach / Luxembourg / Valois-Anjou / Capetian House of Anjou            | 1279 年の House of Wittelsbach 17,892 km² は同年の Duchy of Bavaria 35,323 km² と重なる                                                      |
| 帝国側なのに仏の member になるもの | Kingdom of Arles / Dauphiné                                                                                | アルル王国（帝国）側。`build-france-fiefs.ts` の同種の除外と揃える                                                                           |
| OHM が収録済み                     | 1400 年の Electorate of Saxony / 1200 年の County of Champagne / 1279 年以降の County of Flanders          | 同じ領邦を 2 つの出典で二重に描かない。OHM を常に優先する                                                                                    |
| 名前と土地が一致しない             | County of Touraine（1279 / 1300 年とも bbox 0.90〜2.60E・45.56〜46.55N）                                   | トゥール（0.69E・47.39N）を 1 度も含まずリムーザン〜マルシュ地方を覆う。OHM の County of La Marche と 7,272 km²（この feature の 73%）重なる |

#### 排他化（§3.6 の流用）と二重塗りの実測

`scripts/build-fief-flat.ts` の `resolveOverlaps`（削り方針 `keep-smaller`）と
`subtractOverlay` をそのまま使う。レイヤーをまたぐ重なりは**常に Cliopatria 側
から差し引く**（他の 3 系統は削らない）。Cliopatria の境界が 4〜7 倍粗いことと、
「OHM の欠落を埋める補完」という役割そのものが理由。

`build-fief-dedupe.ts`（§3.5）の union にも Cliopatria を加えている。外すと 1400
/ 1492 年のバイエルン公領などの下に base 塗り（`europe_flat_<year>`）が
残り、半透明が二重に重なって濃くなる。

排他化後に残る重なりの実測（全年・`cliopatria_fiefs_flat_<year>` ×
`{france,hre,italy}_fiefs_flat_<year>` / `europe_flat_<year>`）は **最大 0.034
km²** で、既存レイヤー同士の残存（座標丸め由来、0.004〜0.074 km²）と同水準。
例外は 1000 / 1100 年の County of Vermandois × Duchy of Lower Lotharingia の
**1.83 km²**（Vermandois 17,404 km² の 0.01%、差し渡し約 1.3 km）1 件だけで、
これは丸めで生じた「1 点接触のくびれ」を解いた副作用。戻った分をもう一度
差し引くと同じ位置にくびれが再生して `data/` 全体の自己交差ゼロの不変条件を
満たせなくなるため、自己交差ゼロを優先している（`build-fief-flat.ts` の
`unpinch` の解説）。この不変条件は `scripts/build-cliopatria-fiefs_test.ts`
の「AC #4」テストが上限 8 km² で 見張る。

#### base 輪郭への影響

Cliopatria を union に加えたことで、`base_outline_1200` からトゥールーズ伯領
北縁の直線（`[1.02662,44.57724]`〜`[2.62675,44.77639]`）が切り出された。同区間の
境界は諸侯領側の輪郭が描くようになったためで、TASK-78 の二重輪郭解消・TASK-86 の
Burgandy ↔ HRE と同じ扱い。

#### 再生成

```sh
deno task build-cliopatria-fiefs   # 44 MB の取得。SHA-256 を検証してから使う
deno task build-fief-flat          # cliopatria_fiefs_flat_<year> を作る
deno task build-fief-dedupe        # base_outline / europe_flat を作り直す
deno task build-colors             # 新しい NAME に色を割り当てる
deno task build-attribution        # 最後（出典キーの付与）
```

`CLIOPATRIA_ARCHIVE` 環境変数にローカルの zip を指すと取得を省略できる（検証は
同じように行う）。

### 3.12 帝国全域（`hre_realm_<year>.geojson`、#332）

勢力圏の外枠（`hre-extent`）の union
入力**専用**の派生データ。政治レイヤーとして 描画も picking
もせず、ラベルも色も持たない。

| 年   | OHM relation | 有効期間（OHM）        | 面積 (km²) | パート数 | バイト数 |
| ---- | ------------ | ---------------------- | ---------- | -------- | -------- |
| 1715 | 2815489      | 1713-04-02〜1742-07-28 | 689,268    | 71       | 69,951   |
| 1783 | 2810442      | 1779-04-23〜1787       | 638,237    | 65       | 59,352   |
| 1800 | 2696467      | 1797-10-17〜1803-04-27 | 563,405    | 19       | 38,091   |

**なぜ必要か。** 外枠は長く「base（`europe_<year>`）で宗主キーが一致する feature
の union」で足りていた。base が神聖ローマ帝国を 1
枚のポリゴンで塗っていたためで、
領邦オーバーレイはその内側を細分するだけだった。この前提は 1715 年から崩れる
（実測）。

- 1700 年: base の `Holy Roman Empire` が帝国全域 608,440 km² を塗る
- 1715 年: base の `Holy Roman Empire` は残余 236,581 km² のみ。ベルリンは
  `Brandenburg / SUBJECTO=Prussia`、ウィーン・プラハは `Austrian Empire`
- 1783 / 1800 年: HRE キーへ解決する base feature が 0 件（外枠が空になる）

base の `Prussia` / `Austrian Empire` を宗主キーに関係なく足す解は採れない。
これらは帝国内外にまたがり、丸ごと足せばハンガリー王冠領（実測で
`Austrian Empire` の被覆率は 1715 = 39% / 1783・1800 = 31%）や東プロイセンまで
囲んでしまう。そこで帝国の外縁そのものを出典付きで持つ。

**properties**（`hre_fiefs_<year>` と同形）:

| キー              | 値                                                      |
| ----------------- | ------------------------------------------------------- |
| `NAME`            | `Holy Roman Empire`                                     |
| `SUBJECTO`        | `Holy Roman Empire`（外枠の宗主キー解決がそのまま効く） |
| `PARTOF`          | `Holy Roman Empire`                                     |
| `ADMIN_LEVEL`     | `2`                                                     |
| `OHM_RELATION_ID` | 上表の relation                                         |
| `START_DATE`      | OHM の `start_date`                                     |
| `END_DATE`        | OHM の `end_date`                                       |

**対象年の決め方.** OHM は帝国境界を条約ごとの時間スライスで持ち（`empire=hre` /
`admin_level=2` は実測 23 リレーション）、`start_date` / `end_date` で対象年に
有効なものが一意に決まる。1700 年以前は base だけで外枠が成立するため生成せず、
**1806 年の帝国解体後（1815 年以降）は有効なスライスが存在しないので生成しない**
（＝外枠も出ない）。

**上流間の解釈差（既知）.** OHM と base（historical-basemaps）は次の区画で食い
違い、外枠は OHM の解釈に従う。

- 1715 年のロレーヌ公領・バロワ・モンベリアール伯領（合計 16,490 km²、base の
  `France` ポリゴンの 3.0%）。1766 年のロレーヌ併合まで帝国のフェーフである
- 1783 年のヘッセン＝ダルムシュタットのアルザス飛び地（ハーナウ＝
  リヒテンベルク、617 km²）は帝国外なので外枠に入らない（領邦オーバーレイの
  被覆率 0.872）

**再生成**（ネットワーク必要・Overpass）:

```
deno task build-hre-realm
deno task build-attribution   # 最後（出典キーの付与）
```

生成物は `deno task build-hre-realm` が `serializeWithAttribution`
を通して書くため 出典は生成時点で載る（`build-attribution`
は再生成後の整合確認）。

### 3.13 base 主権の外周置換（ポーランド 1000〜1400、#352 / ADR-0040）

`scripts/build-data.ts` の `BASE_POWER_REPLACEMENTS` が、`europe_<year>.geojson`
の**特定の勢力ポリゴンの座標だけ**を別出典へ差し替える機構。`BASE_FIEF_SPLITS`
（§3.4 / decision-28）が「1 枚の勢力ポリゴンから内訳を切り出す」のに対し、
こちらは「輪郭を丸ごと入れ替える」。適用は現在ポーランド 6 年のみ。

理由は上流（historical-basemaps・`BORDERPRECISION=1`）のポーランドが
世界・大陸スケール向けの概略ポリゴンで、外周が少数の長大な直線で構成されて
いたこと（#352 の実測）。

|   年 | base 勢力          | 置換元（上流 Name）          | 上流区間  | SeshatID              | 置換前の最長線分 |   置換後 | 100 km 超 | leaf 子区画 |
| ---: | ------------------ | ---------------------------- | --------- | --------------------- | ---------------: | -------: | --------: | ----------: |
| 1000 | `Poland`           | `(Kingdom of Poland)`        | 990–1002  | `pl_piast_dyn_1`      |         312.4 km |  74.4 km |      0 本 |           1 |
| 1100 | `Poland`           | `(Kingdom of Poland)`        | 1056–1125 | `pl_piast_dyn_1`      |         264.4 km |  90.2 km |      0 本 |           1 |
| 1200 | `Poland`           | `(Duchies of Poland)`        | 1192–1201 | `pl_piast_dyn_2`      |         183.9 km |  75.5 km |      0 本 |           6 |
| 1279 | `Poland`           | `(Duchies of Poland)`        | 1279–1284 | `pl_piast_dyn_2`      |         116.5 km | 110.7 km |      1 本 |           9 |
| 1300 | `Poland`           | `(Duchies of Poland)`        | 1294–1304 | `pl_piast_dyn_2`      |         115.3 km | 110.7 km |      1 本 |          11 |
| 1400 | `Poland-Lithuania` | `(Polish-Lithuania Kingdom)` | 1395–1401 | `pl_jagiellonian_dyn` |         841.7 km | 195.4 km |      4 本 |   2（leaf） |

最長線分は raw（5 桁）の親区画の実測。配信用の `europe_<year>.geojson` は
`COORD_PRECISION`（3 桁）+ simplify を通るため 0.1 km 単位で差が出る
（`scripts/build-data_test.ts` が両方を固定）。

#### 決まりごと

- **NAME・SUBJECTO・PARTOF・色キー・ラベルは base の語彙のまま**据え置く。
  変わるのは座標だけで、内訳（子区画）は Cliopatria オーバーレイ側が担う。
- **適用は `applyBaseFiefSplits` の後段**。1100 / 1200 年の切り出し
  （ボヘミア公領・ボヘミア王国・モラヴィア）は Poland 塗りが切り出し元なので、
  先に置換すると #346 / TASK-157 の成果が消える。
- **差分の始末**（`replaceBasePower`）:
  - 新しい外周にしか無い領域は隣接勢力から差し引く（同じ土地を二度塗らない）
  - 旧ポリゴンにしか無い領域は連結成分ごとに、#342 の `mergeSeveredRemainders`
    と同じ規則で**共有境界が最長の隣接勢力へ併合**する
  - 機械的な併合先が歴史的に成立しない成分だけは `retainedRemainders` （内点 +
    根拠）で置換した勢力に残す。現在の登録は 1279 / 1300 年の
    クラクフを含む小ポーランド 1 件（上流 Cliopatria がクラクフを含まず、
    共有境界最長の隣接がハンガリーになるため）
  - 隣接が見つからない微小な断片は落とす（帰属の根拠が無いため）
- 年別の内訳は `deno task build-data` のログが出す。開示は
  `data/known-limitations.json` の `base-poland-outline-replaced-cliopatria` /
  `base-poland-outline-difference-reassigned` /
  `cliopatria-poland-long-segments`。

#### 再生成

```sh
deno task build-cliopatria-fiefs   # 置換元（親）を含む raw を作る
deno task build-fief-flat          # 子区画の flat（親は出さない）
deno task build-data               # 外周置換 + 差分の再配分
deno task build-fief-flat
deno task build-fief-dedupe
deno task build-attribution        # europe_<year> に出典キーを戻す
deno task build-coastal-fill       # sourceHash が確定した europe を読む
deno task build-colors
deno task build-attribution        # 最後（新しい生成物への出典キー付与）
```

`build-coastal-fill` は `europe_<year>.geojson` の内容ハッシュを `sourceHash`
に刻むため、**出典キーを載せた後**に走らせる（先に走らせると
`src/coastal_fill_prebuilt_test.ts` が「入力が更新されている」と検出する）。

### 3.14 沿岸補完の帯（`coastal_fill_<year>.geojson`）の内環（#358 → #389）

帯は「沿岸 run の外側 `COASTAL_FILL_BAND_KM = 30` km のバッファ」から全政治
ポリゴンを差し引いた面（#305 → #312 → #326、生成は
`scripts/build-coastal-fill.ts`）で、出典付きの実データではなく
`europe_<year>.geojson` から機械的に導いた表示用の面である。

#389 以前は片側オフセットを**自己交差した 1 本の環**として作り、正規化を後段の
polyclip 差分に委ねていた。差分の正規化は重なりを畳むだけで折り返しの内側を
埋め直さないため、**海岸線が帯幅より細かい刻みでジグザグする区間では巻き数が
打ち消し合ったポケットが帯の穴として残っていた**（#358 で観測）。#389 は
`src/coastal_fill.ts` `coastalBandPolygon` で、差分の**前に**帯を self-union で
正規化し、**沿岸 run の頂点を 1 つも含まない内環**（＝オフセット点だけで囲まれた
折り返しの産物）だけを埋めるようにした。島（閉じた run）のドーナツ穴や政治
ポリゴン側の穴は run の頂点そのものでできているため残り、島の内部を塗り潰す #312
の回帰にはならない。

実測（19 年代の合計。修正前 → 修正後）:

| 対象                                           |  修正前 |  修正後 |
| ---------------------------------------------- | ------: | ------: |
| 帯が持つ内環                                   | 5,116本 | 2,832本 |
| うち base ポリゴンの頂点を含まない（折り返し） | 2,285本 |     0本 |
| うち平均半幅 500 m 以上                        |   809本 |     0本 |

勢力圏の外枠（`hre-extent`）は帯の穴をそのまま内環として引き継ぐため、同じ
計測を全 19 年代 × 全宗主キーの外枠に対して行うと内環 2,420 → 844 本、うち base
の頂点を含まないもの 1,733 → 178 本、うち平均半幅 500 m 以上 750 → 109
本になる。 **残る 109 本は折り返しの穴ではなく、帯（外側 30
km）が届かない湾・海峡の中央
などの実在の未着色域**で、いずれも水面のためベースマップの海洋 `water` に
覆われて画面には出ない（上位 3 例: カテガット海峡 `[10.80,56.24,12.24,57.18]`
2,133 km²・平均半幅 5,038 m／アラル海西部 `[58.94,45.44,59.43,45.71]` 392 km²／
マルマラ海南部 `[28.07,40.65,28.53,40.77]` 234 km²。中央値は 62.1 km²）。

#358 が「画面に出る唯一の実例」として記録した**クロニアン砂州沖の 2 環**（潟の
北側 188.7 km²・平均半幅 2,508.3 m / 砂州側 62.2 km²・同 1,096.7 m）は #389 で
消え、砂州上の現代の陸 2.08 km²（bbox `[20.754,55.101,20.794,55.149]`）が宗主の
アクティブ色で塗られるようになった。そこに出ていた孤立した臙脂線（z7 で約 22
px）も消えている。解消は `src/coastal_fill_band_test.ts`（帯そのもの・全 19
年代）と `src/suzerain_extent_coastal_test.ts`（外枠側・1815 年 Prussia / 1880
年 Germany）が固定する。#358 当時の調査記録は
[../research/issue-358-suzerain-extent-inner-ring.md](../research/issue-358-suzerain-extent-inner-ring.md)
にそのまま残してある（末尾に #389 での解消を追記）。

なお外枠が持つ**実在の未着色域**の内環（1880 年ドイツのボーデン湖付近・平均半幅
7.94 m など）は #330 AC5 のとおり保持する。落としてよいのは座標丸め由来の糸くず
（`SLIVER_HALF_WIDTH_M = 5` m 未満）だけである。

## 4. 年代別サマリ

各列の値は年代別ファイルの §1 サマリと一致する。「HRE 領邦」は Roller 由来の
`hre_<year>.geojson`（1500〜1700 のみ）、「仏諸侯領」は
`france_fiefs_<year>.geojson`（1000〜1300 のみ）の件数で、`—`
はその年代にファイルが無いことを示す。中世 HRE 領邦
`hre_fiefs_<year>.geojson`（§3.7）の件数はこの表には含めず §3.7 に記載する。

|   年 | 独立勢力 | 属領 | 無名ポリゴン | 都市 | HRE 領邦 | 仏諸侯領 | 除外勢力 | 除外都市 | 詳細                           |
| ---: | -------: | ---: | -----------: | ---: | -------: | -------: | -------: | -------: | ------------------------------ |
| 1000 |       39 |    5 |           28 |  122 |        — |       12 |        8 |       20 | [year-1000.md](./year-1000.md) |
| 1100 |       40 |    2 |           28 |  178 |        — |       16 |       16 |       23 | [year-1100.md](./year-1100.md) |
| 1200 |       35 |    3 |           29 |  273 |        — |       19 |        6 |       28 | [year-1200.md](./year-1200.md) |
| 1279 |       26 |    5 |           34 |  327 |        — |       15 |        8 |       26 | [year-1279.md](./year-1279.md) |
| 1300 |       30 |    2 |           23 |  432 |        — |       15 |        7 |       29 | [year-1300.md](./year-1300.md) |
| 1400 |       26 |    5 |           15 |  300 |        — |        — |        8 |       32 | [year-1400.md](./year-1400.md) |
| 1492 |       24 |    3 |           26 |  412 |        — |        — |        9 |       33 | [year-1492.md](./year-1492.md) |
| 1500 |       25 |    3 |           16 |  509 |       13 |        — |        7 |       32 | [year-1500.md](./year-1500.md) |
| 1530 |       27 |    3 |           34 |  519 |       13 |        — |        5 |       32 | [year-1530.md](./year-1530.md) |
| 1600 |       25 |    3 |           24 |  806 |       14 |        — |        5 |       33 | [year-1600.md](./year-1600.md) |
| 1650 |       29 |    8 |           22 |  795 |       14 |        — |        5 |       36 | [year-1650.md](./year-1650.md) |
| 1700 |       29 |    8 |           24 |  922 |       14 |        — |        5 |       37 | [year-1700.md](./year-1700.md) |
| 1715 |       40 |    6 |           28 |  911 |        — |        — |        6 |       37 | [year-1715.md](./year-1715.md) |
| 1783 |       48 |    4 |           31 | 1373 |        — |        — |        5 |       49 | [year-1783.md](./year-1783.md) |
| 1800 |       44 |    7 |           24 | 1776 |        — |        — |        5 |       49 | [year-1800.md](./year-1800.md) |
| 1815 |       49 |    5 |           36 | 1802 |        — |        — |        5 |       49 | [year-1815.md](./year-1815.md) |
| 1880 |       23 |    1 |           40 | 2096 |        — |        — |        5 |       54 | [year-1880.md](./year-1880.md) |
| 1900 |       24 |    0 |           25 | 2126 |        — |        — |        6 |       52 | [year-1900.md](./year-1900.md) |
| 1914 |       24 |    2 |           32 | 2134 |        — |        — |        8 |       43 | [year-1914.md](./year-1914.md) |

## 5. 年代別の最大勢力（欧州域内の面積上位 5・概算 km²）

|   年 | 1位                                               | 2位                                           | 3位                                               | 4位                                     | 5位                             |
| ---: | ------------------------------------------------- | --------------------------------------------- | ------------------------------------------------- | --------------------------------------- | ------------------------------- |
| 1000 | キエフ・ルーシ<br>1,201,605                       | フィン・ウゴル系タイガ狩猟採集民<br>1,194,949 | ペチェネグ<br>744,692                             | 神聖ローマ帝国<br>700,084               | ヴォルガ・ブルガール<br>634,455 |
| 1100 | キエフ・ルーシ<br>1,633,677                       | クマン・キプチャク連合<br>1,314,984           | フィン・ウゴル系タイガ狩猟採集民<br>982,377       | サーミ人<br>673,873                     | 神聖ローマ帝国<br>623,652       |
| 1200 | クマン諸ハン国<br>1,539,500                       | フィン・ウゴル系タイガ狩猟採集民<br>1,176,396 | 神聖ローマ帝国<br>623,652                         | その他のルーシ諸公国<br>539,454         | サーミ人<br>488,327             |
| 1279 | キプチャク・ハン国（ジョチ・ウルス）<br>1,883,078 | リャザン<br>1,311,928                         | ノヴゴロド<br>912,761                             | 神聖ローマ帝国<br>884,521               | シベリア諸民族<br>523,436       |
| 1300 | キプチャク・ハン国（ジョチ・ウルス）<br>1,883,078 | リャザン<br>1,306,535                         | 神聖ローマ帝国<br>919,619                         | ノヴゴロド<br>912,761                   | シベリア諸民族<br>523,436       |
| 1400 | 青帳ハン国<br>1,822,564                           | 神聖ローマ帝国<br>919,619                     | ポーランド・リトアニア<br>893,470                 | ノヴゴロド<br>880,120                   | カルマル同盟<br>866,025         |
| 1492 | モスクワ大公国<br>1,877,799                       | ポーランド・リトアニア<br>1,180,724           | キプチャク・ハン国（ジョチ・ウルス）<br>1,131,402 | 神聖ローマ帝国<br>851,313               | オスマン帝国<br>534,781         |
| 1500 | モスクワ大公国<br>2,272,782                       | カルマル同盟<br>1,105,180                     | キプチャク・ハン国（ジョチ・ウルス）<br>1,040,046 | ポーランド・リトアニア<br>1,024,086     | 神聖ローマ帝国<br>851,313       |
| 1530 | ロシア・ツァーリ国<br>1,822,683                   | ノガイ・オルダ<br>1,479,663                   | オスマン帝国<br>1,037,351                         | ポーランド・リトアニア<br>859,718       | 神聖ローマ帝国<br>691,170       |
| 1600 | ロシア・ツァーリ国<br>3,567,008                   | オスマン帝国<br>1,036,160                     | ポーランド・リトアニア<br>889,711                 | スウェーデン<br>679,373                 | 神聖ローマ帝国<br>674,388       |
| 1650 | ロシア・ツァーリ国<br>3,542,011                   | オスマン帝国<br>1,208,136                     | スウェーデン<br>859,553                           | ポーランド・リトアニア共和国<br>840,797 | 神聖ローマ帝国<br>626,600       |
| 1700 | ロシア・ツァーリ国<br>3,700,464                   | スウェーデン<br>902,966                       | オスマン帝国<br>783,864                           | ポーランド・リトアニア共和国<br>704,668 | 神聖ローマ帝国<br>608,449       |
| 1715 | ロシア・ツァーリ国<br>3,686,933                   | スウェーデン<br>911,403                       | オスマン帝国<br>819,686                           | ポーランド・リトアニア共和国<br>774,285 | フランス<br>542,835             |
| 1783 | ロシア帝国<br>4,296,470                           | スウェーデン<br>752,495                       | オスマン帝国<br>641,631                           | オーストリア帝国<br>620,302             | ポーランド<br>548,574           |
| 1800 | ロシア帝国<br>4,742,416                           | スウェーデン<br>752,494                       | オスマン帝国<br>641,631                           | オーストリア帝国<br>619,536             | フランス<br>543,095             |
| 1815 | ロシア帝国<br>5,250,951                           | スウェーデン＝ノルウェー<br>736,245           | オスマン帝国<br>643,550                           | オーストリア帝国<br>605,250             | フランス<br>539,076             |
| 1880 | ロシア帝国<br>5,195,415                           | スウェーデン＝ノルウェー<br>733,387           | オーストリア＝ハンガリー帝国<br>602,103           | フランス<br>539,076                     | ドイツ<br>502,612               |
| 1900 | ロシア帝国<br>5,227,672                           | スウェーデン＝ノルウェー<br>732,080           | オーストリア＝ハンガリー帝国<br>602,909           | フランス<br>539,076                     | ドイツ<br>502,576               |
| 1914 | ロシア帝国<br>4,922,890                           | オーストリア＝ハンガリー帝国<br>650,539       | フランス<br>530,121                               | ドイツ帝国<br>520,236                   | スペイン<br>485,525             |

## 6. 5 年代以上に登場する勢力（46 件）

| 勢力名                       | 日本語名               | 登場年代数 | 登場年                                                                                               |
| ---------------------------- | ---------------------- | ---------: | ---------------------------------------------------------------------------------------------------- |
| Portugal                     | ポルトガル             |         17 | 1200, 1279, 1300, 1400, 1492, 1500, 1530, 1600, 1650, 1700, 1715, 1783, 1800, 1815, 1880, 1900, 1914 |
| France                       | フランス               |         16 | 1279, 1300, 1400, 1492, 1500, 1530, 1600, 1650, 1700, 1715, 1783, 1800, 1815, 1880, 1900, 1914       |
| Papal States                 | 教皇領                 |         15 | 1100, 1200, 1279, 1300, 1400, 1492, 1500, 1530, 1600, 1650, 1700, 1715, 1783, 1800, 1815             |
| Ottoman Empire               | オスマン帝国           |         14 | 1400, 1492, 1500, 1530, 1600, 1650, 1700, 1715, 1783, 1800, 1815, 1880, 1900, 1914                   |
| Sweden                       | スウェーデン           |         14 | 1000, 1100, 1200, 1279, 1300, 1492, 1530, 1600, 1650, 1700, 1715, 1783, 1800, 1914                   |
| Holy Roman Empire            | 神聖ローマ帝国         |         13 | 1000, 1100, 1200, 1279, 1300, 1400, 1492, 1500, 1530, 1600, 1650, 1700, 1715                         |
| Venice                       | ヴェネツィア共和国     |         13 | 1000, 1100, 1200, 1279, 1300, 1400, 1492, 1500, 1530, 1600, 1650, 1700, 1715                         |
| Scotland                     | スコットランド王国     |         12 | 1000, 1100, 1200, 1279, 1300, 1400, 1492, 1500, 1530, 1600, 1650, 1700                               |
| Sardinia                     | サルデーニャ           |         11 | 1000, 1100, 1200, 1279, 1300, 1400, 1530, 1600, 1650, 1700, 1715                                     |
| Spain                        | スペイン               |         11 | 1530, 1600, 1650, 1700, 1715, 1783, 1800, 1815, 1880, 1900, 1914                                     |
| Denmark-Norway               | デンマーク＝ノルウェー |         10 | 1000, 1492, 1500, 1530, 1600, 1650, 1700, 1715, 1783, 1800                                           |
| Britany                      | ブルターニュ           |          9 | 1000, 1100, 1200, 1279, 1300, 1400, 1492, 1500, 1530                                                 |
| Luxembourg                   | ルクセンブルク         |          9 | 1650, 1700, 1715, 1783, 1800, 1815, 1880, 1900, 1914                                                 |
| Aragón                       | アラゴン王国           |          8 | 1000, 1100, 1200, 1279, 1300, 1400, 1492, 1500                                                       |
| Castile                      | カスティーリャ王国     |          8 | 1000, 1100, 1200, 1279, 1300, 1400, 1492, 1500                                                       |
| Denmark                      | デンマーク             |          8 | 1100, 1200, 1279, 1300, 1815, 1880, 1900, 1914                                                       |
| Navarre                      | ナバラ王国             |          8 | 1000, 1100, 1200, 1279, 1300, 1400, 1492, 1500                                                       |
| Prussia                      | プロイセン             |          8 | 1530, 1600, 1650, 1700, 1715, 1783, 1800, 1815                                                       |
| Sicily                       | シチリア王国           |          8 | 1279, 1300, 1400, 1530, 1600, 1650, 1700, 1715                                                       |
| Swiss Confederation          | スイス盟約者団         |          8 | 1492, 1500, 1530, 1600, 1650, 1700, 1715, 1783                                                       |
| Sámi                         | サーミ人               |          7 | 1100, 1200, 1279, 1400, 1492, 1500, 1530                                                             |
| Austrian Empire              | オーストリア帝国       |          6 | 1650, 1700, 1715, 1783, 1800, 1815                                                                   |
| Bulgar Khanate               | ブルガール・ハン国     |          6 | 1000, 1100, 1200, 1279, 1300, 1400                                                                   |
| Byzantine Empire             | ビザンツ帝国           |          6 | 1000, 1100, 1200, 1279, 1300, 1400                                                                   |
| Corsica                      | コルシカ               |          6 | 1000, 1100, 1200, 1279, 1300, 1400                                                                   |
| Fivizzano                    | フィヴィッツァーノ     |          6 | 1650, 1700, 1715, 1783, 1800, 1815                                                                   |
| Lombardy                     | ロンバルディア         |          6 | 1650, 1700, 1715, 1783, 1800, 1815                                                                   |
| Lucca                        | ルッカ                 |          6 | 1650, 1700, 1715, 1783, 1800, 1815                                                                   |
| Massa                        | マッサ                 |          6 | 1650, 1700, 1715, 1783, 1800, 1815                                                                   |
| Modena                       | モデナ                 |          6 | 1650, 1700, 1715, 1783, 1800, 1815                                                                   |
| Parma                        | パルマ                 |          6 | 1650, 1700, 1715, 1783, 1800, 1815                                                                   |
| Poland                       | ポーランド             |          6 | 1000, 1100, 1200, 1279, 1300, 1783                                                                   |
| Pontremoli                   | ポントレモリ           |          6 | 1650, 1700, 1715, 1783, 1800, 1815                                                                   |
| Republic of the Seven Zenden | 七ツェンデン共和国     |          6 | 1530, 1600, 1650, 1700, 1715, 1783                                                                   |
| Russian Empire               | ロシア帝国             |          6 | 1783, 1800, 1815, 1880, 1900, 1914                                                                   |
| Serbia                       | セルビア               |          6 | 1000, 1100, 1279, 1880, 1900, 1914                                                                   |
| Tuscany                      | トスカーナ             |          6 | 1650, 1700, 1715, 1783, 1800, 1815                                                                   |
| Genoa                        | ジェノヴァ             |          5 | 1530, 1600, 1650, 1700, 1715                                                                         |
| Milan                        | ミラノ公国             |          5 | 1530, 1600, 1650, 1700, 1715                                                                         |
| Naples                       | ナポリ王国             |          5 | 1530, 1600, 1650, 1700, 1715                                                                         |
| Netherlands                  | オランダ               |          5 | 1783, 1815, 1880, 1900, 1914                                                                         |
| Nogai Horde                  | ノガイ・オルダ         |          5 | 1530, 1600, 1650, 1700, 1715                                                                         |
| Norway                       | ノルウェー             |          5 | 1100, 1200, 1279, 1300, 1914                                                                         |
| Poland-Lithuania             | ポーランド・リトアニア |          5 | 1400, 1492, 1500, 1530, 1600                                                                         |
| Teutonic Knights             | ドイツ騎士団領         |          5 | 1279, 1300, 1400, 1492, 1500                                                                         |
| Tsardom of Muscovy           | ロシア・ツァーリ国     |          5 | 1530, 1600, 1650, 1700, 1715                                                                         |

## 7. 属領・従属関係（SUBJECTO ≠ NAME）の全ペア — 52 件

`SUBJECTO` が `NAME` と異なる feature
を「属領」として機械判定している。ただし元データには綴りの揺れ・略称・称号の有無による“見かけの属領”が混ざっており、備考欄に印を付けた（`data/name-overrides.json`
の `renames` は `NAME` にのみ適用され、`SUBJECTO` 側の旧綴りは残っているため）。

| 勢力（NAME）                | 宗主（SUBJECTO）              | 登場年                 | 備考 |
| --------------------------- | ----------------------------- | ---------------------- | ---- |
| Kievan Rus                  | Kyivan Rus                    | 1000                   | —    |
| Castile                     | Castilla                      | 1000, 1100, 1200       | —    |
| Duchy of Swabia             | Holy Roman Empire             | 1000                   | —    |
| Kingdom of France           | France                        | 1000, 1100, 1200       | —    |
| Suomi                       | Suom                          | 1000                   | —    |
| Comté de Toulouse           | France                        | 1200                   | —    |
| English territory           | England                       | 1279                   | —    |
| Ilkhanate                   | Mongol Empire                 | 1279                   | —    |
| Khanate of the Golden Horde | Mongol Empire                 | 1279, 1300             | —    |
| Novgorod                    | Mongol Empire                 | 1279, 1400             | —    |
| Ryazan                      | Mongol Empire                 | 1279                   | —    |
| Ryazan                      | Khanate of the Golden Horde   | 1300                   | —    |
| Blue Horde                  | Mongol Empire                 | 1400                   | —    |
| Bulgar Khanate              | Ottoman Empire                | 1400                   | —    |
| Kingdom of Hungary          | Hungary                       | 1400                   | —    |
| White Horde                 | Mongol Empire                 | 1400                   | —    |
| Castile                     | Castille                      | 1492, 1500             | —    |
| Crimean Khanate             | Ottoman Empire                | 1492, 1500, 1530, 1600 | —    |
| Scotland                    | Scottland                     | 1492, 1500             | —    |
| Astrakhan Khanate           | Nogai Horde                   | 1530                   | —    |
| Poland-Lithuania            | Poland-Llituania              | 1530, 1600             | —    |
| Finnmark                    | Denmark-Norway                | 1600, 1650, 1700, 1800 | —    |
| Franche-Comté               | Spanish Habsburg              | 1650, 1700             | —    |
| Milan                       | Spanish Habsburg              | 1650, 1700             | —    |
| Naples                      | Spanish Habsburg              | 1650                   | —    |
| Sardinia                    | Spanish Habsburg              | 1650                   | —    |
| Scotland                    | Scottalnd                     | 1650, 1700             | —    |
| Sicily                      | Spanish Habsburg              | 1650                   | —    |
| Spain                       | Spanish Habsburg              | 1650, 1700             | —    |
| Naples                      | Austrian Empire               | 1700, 1715             | —    |
| Sardinia                    | Austrian Empire               | 1700, 1715             | —    |
| Sicily                      | Savoy-Piedmont                | 1700, 1715             | —    |
| Austrian Netherlands        | Austrian Empire               | 1715                   | —    |
| Brandenburg                 | Prussia                       | 1715                   | —    |
| Milan                       | Austrian Empire               | 1715                   | —    |
| Austrian Netherlands        | Austria                       | 1783                   | —    |
| Lombardy                    | 3                             | 1783                   | —    |
| Milano (Austria)            | Austria                       | 1783                   | —    |
| United Kingdom              | UK                            | 1783, 1800             | —    |
| Austrian Netherlands        | Habsburg Austria              | 1800                   | —    |
| Hanover                     | UK                            | 1800                   | —    |
| Kingdom of Ireland          | UK                            | 1800                   | —    |
| Kingdom of Sardinia         | France                        | 1800                   | —    |
| Mecklenburg-Strelitz        | UK                            | 1800                   | —    |
| Lombardy                    | Austrian Empire               | 1815                   | —    |
| Modena                      | Austrian Empire               | 1815                   | —    |
| Netherlands                 | United Kingdom of Netherlands | 1815                   | —    |
| Parma                       | Austrian Empire               | 1815                   | —    |
| Venetia                     | Austrian Empire               | 1815                   | —    |
| Iceland                     | Denmark                       | 1880                   | —    |
| Kingfom of Italy            | Italy                         | 1914                   | —    |
| Russian Empire              | Russia                        | 1914                   | —    |

## 8. ヨーロッパ域外として除外した勢力（50 件）

| 勢力名（英語）         | 日本語名               | 除外年代数 | 除外年                                                           |
| ---------------------- | ---------------------- | ---------: | ---------------------------------------------------------------- |
| Morocco                | モロッコ               |         11 | 1300, 1400, 1650, 1700, 1715, 1783, 1800, 1815, 1880, 1900, 1914 |
| Cyprus                 | キプロス               |          8 | 1000, 1100, 1200, 1279, 1300, 1400, 1492, 1500                   |
| Georgia                | グルジア               |          6 | 1000, 1200, 1279, 1300, 1400, 1914                               |
| central Asian khanates | 中央アジア諸ハン国     |          5 | 1650, 1700, 1715, 1815, 1900                                     |
| Hafsid Caliphate       | ハフス朝               |          5 | 1279, 1300, 1400, 1492, 1500                                     |
| Khiva Khanate          | ヒヴァ・ハン国         |          5 | 1530, 1600, 1650, 1700, 1715                                     |
| Mamluke Sultanate      | マムルーク朝           |          5 | 1279, 1300, 1400, 1492, 1500                                     |
| Quazaq Khanate         | カザフ・ハン国         |          5 | 1530, 1600, 1650, 1700, 1715                                     |
| Algiers                | アルジェ               |          4 | 1715, 1783, 1800, 1815                                           |
| Armenia                | アルメニア             |          4 | 1000, 1100, 1200, 1914                                           |
| Greenland              | グリーンランド         |          4 | 1530, 1600, 1880, 1900                                           |
| Safavid Empire         | サファヴィー朝         |          4 | 1530, 1600, 1650, 1700                                           |
| Tunis                  | チュニス               |          4 | 1715, 1783, 1800, 1815                                           |
| Fatimid Caliphate      | ファーティマ朝         |          3 | 1000, 1100, 1200                                                 |
| Ghaznavid Emirate      | ガズナ朝               |          3 | 1000, 1100, 1200                                                 |
| Persia                 | ペルシア               |          3 | 1783, 1800, 1914                                                 |
| Seljuk Caliphate       | セルジューク朝         |          3 | 1279, 1300, 1400                                                 |
| Trebizond              | トレビゾンド帝国       |          3 | 1279, 1300, 1400                                                 |
| Afghanistan            | アフガニスタン         |          2 | 1783, 1800                                                       |
| Algeria                | アルジェリア           |          2 | 1900, 1914                                                       |
| Arabia                 | アラビア               |          2 | 1880, 1900                                                       |
| Arabs                  | アラブ人               |          2 | 1492, 1500                                                       |
| Arran                  | アッラーン             |          2 | 1000, 1100                                                       |
| Kingdom of Georgia     | グルジア王国           |          2 | 1000, 1100                                                       |
| Shirvan                | シルヴァン             |          2 | 1000, 1100                                                       |
| Timurid Emirates       | ティムール朝           |          2 | 1492, 1500                                                       |
| Tunisia                | チュニジア             |          2 | 1900, 1914                                                       |
| Watassid Morocco       | ワッタース朝           |          2 | 1530, 1600                                                       |
| Wattasid Caliphate     | ワッタース朝           |          2 | 1492, 1500                                                       |
| Zayyanid Caliphate     | ザイヤーン朝           |          2 | 1492, 1500                                                       |
| Abdelouadides          | ザイヤーン朝           |          1 | 1279                                                             |
| Algeria (FR)           | フランス領アルジェリア |          1 | 1880                                                             |
| Arabia (Nejd)          | アラビア（ナジュド）   |          1 | 1914                                                             |
| Artsakh                | アルツァフ             |          1 | 1100                                                             |
| Beylik of Aydin        | アイドゥン侯国         |          1 | 1400                                                             |
| Bokhara Khanate        | ブハラ・ハン国         |          1 | 1880                                                             |
| Emirate of Tiflis      | ティフリス首長国       |          1 | 1100                                                             |
| Goghtn                 | ゴグトン               |          1 | 1100                                                             |
| Kakheti-Hereti         | カヘティ＝ヘレティ     |          1 | 1100                                                             |
| Kara Khitai Khaganate  | 西遼（カラ・キタイ）   |          1 | 1200                                                             |
| Karkhanids             | カラハン朝             |          1 | 1100                                                             |
| Merinides              | マリーン朝             |          1 | 1279                                                             |
| Oghuz                  | オグズ                 |          1 | 1100                                                             |
| Seljuk Empire          | セルジューク朝         |          1 | 1100                                                             |
| Siberians              | シベリア諸民族         |          1 | 1492                                                             |
| Spanish Morocco        | スペイン領モロッコ     |          1 | 1914                                                             |
| Syunik                 | シュニク               |          1 | 1100                                                             |
| Tashir                 | タシル                 |          1 | 1100                                                             |
| Thule                  | チューレ               |          1 | 1492                                                             |
| Turan                  | トゥーラン             |          1 | 1815                                                             |

## 9. 既知の制約（data/known-limitations.json）

河川ラインについては、全 30 河川（TASK-76 当時の scalerank<=5 の収録全数。
TASK-152 で scalerank<=6 へ拡大し現在は 50 河川）の端点・連続性を横断検査した
結果（成分分断 0 件 / 出口欠如 0 件 / 生成パイプライン起因 0 件 / EUROPE_BBOX
クリップ 3 件）と、河口部を海として扱う Natural Earth 側の仕様を
[rivers-continuity-audit.md](rivers-continuity-audit.md) にまとめている（TASK-76
調査）。

base 勢力の帰属（名称・宗主・存続期間）については、監査当時の全 20 年代（900
年廃止・TASK-119 より前）を横断監査した結果 （明確な誤り 15 件 / 解釈の余地あり
7 件 / 妥当 11 件）と是正方針を
[base-attribution-audit.md](base-attribution-audit.md) にまとめている（TASK-103
調査）。上流データの粒度に由来し上書きでは直せないもの（滅亡済み勢力名の残存・
代表名による広域の一括塗り・年代間のポリゴン使い回し・名目的宗主権の揺れ）は、
同ドキュメント §6 に `known-limitations.json` への記載候補として整理してある。

- **england-ireland-wales-1530-1700**（1530〜1700 年）:
  1530〜1700年の年代では、イングランドとアイルランドが元データ（historical-basemaps）で単一勢力「イングランド・アイルランド」として収録されており、分離して表示できません。また、ウェールズも独立した勢力として収録されていません（TASK-39
  調査）。
- **hre-boundaries-1700-extrapolated**（1700〜1700 年）:
  1700年の神聖ローマ帝国内の領邦境界は、採用データセット（ETH Zürich,
  Roller）の最終スナップショットである1650年時点の形状をそのまま外挿した近似です。1650年以降の領土変化（1653年のブランデンブルクによるヒンターポンメルン獲得、1680年のマクデブルク獲得など）は反映されていません（TASK-68）。
- **rivers-elbe-estuary-missing**（全年代 / id は TASK-75 当時のまま維持）:
  河川のラインは実際の河口まで届かず、幅の広い河口部・潟・入り江の手前で途切れます。採用している河川データ（Natural
  Earth 50m
  rivers_lake_centerlines）では、こうした水域を河川ではなく海として扱い、センターラインを収録していないためです。エルベ川はハンブルク西のヴェーデル付近（東経約9.78度）、ロワール川はナント西（西経約1.74度）、オーデル川はシュチェチン潟の南端（東経約14.58度）で終わり、いずれも終端が海岸線に接しています。テージョ川・ドニプロ川なども同様で、特定の河川だけの欠落ではなく元データ全体の仕様です。より詳細な10m版（エルベは東経約9.82度とさらに手前）およびヨーロッパ詳細版でも同区間は収録されていないため、補完できる代替データは現状ありません（TASK-75・TASK-76
  調査）。エルベ単独での 10m 版検証手順は §10、全 30 河川での裏付け（終端が
  `ne_50m_coastline` に接することの実測・Loire / Oder への 10m 版適用結果）は
  [rivers-continuity-audit.md](rivers-continuity-audit.md) §3.2 を参照。

## 10. 注記

- 本ドキュメントは `data/` のコミット済みファイル（コミット 9b715d8
  時点）を機械的に集計して生成した。元データの再取得は行っていない。`data/`
  を更新した際は集計し直す必要がある。
- §2
  の境界は地理的なヨーロッパ／アジア・アフリカ境界（ウラル・ウラル川・大コーカサス分水嶺・ボスポラス・地中海）に沿った近似の折れ線であり、EU
  などの政治的な区分ではない。キプロス・南コーカサス三国は地理区分に従って域外扱いとしている。
- 独立勢力と属領の区分は `SUBJECTO` と `NAME`
  の一致で機械判定しているため、元データの表記ゆれ（例: 1914 年の
  `Russian Empire` は `SUBJECTO` が
  `Russia`）で実質独立の勢力が属領側に分類される。§7 の備考欄を参照。
- 元データには綴り誤りがそのまま残っている（例: 1914 年の
  `Kingfom of Italy`、1650・1700 年の `Scottalnd`）。`NAME` 側の主要な誤りは
  `data/name-overrides.json` で補正済み。
- 神聖ローマ帝国は `europe_<year>.geojson`
  では単一の勢力ポリゴンとして収録され、領邦の内訳は別ライセンスの
  `hre_<year>.geojson` を重ねて表現している（統合不可）。
- 中世フランス（1000〜1300 年）の諸侯領は `europe_<year>.geojson` では
  `Kingdom of France` 等の単一ポリゴンに畳まれているため、OpenHistoricalMap
  由来の `france_fiefs_<year>.geojson` を重ねて内訳を表現する。取得は
  `deno task build-france-fiefs`（`scripts/build-france-fiefs.ts`）で再現でき、
  Overpass のクエリが bbox とリレーション ID だけで決まるため出力は決定的。
  収録できない諸侯領は §3.4 を参照。
- 都市の人口は Buringh 2021（主）/ Chandler 系列（補完）の推計値であり、
  スナップショット年への対応付け・補間にも ±数十年のずれを含む（§3.2）。
- 河川オーバーレイ（`data/rivers.geojson`）でエルベ川が河口に届かないのは、元
  データがその区間を持たないため（§9
  `rivers-elbe-estuary-missing`）。ピン留めコミット
  `ca96624a56bd078437bca8184e78163e5039ad19` の 3 データセットを実測した結果:
  | データセット                                       | エルベ川 feature の西端            | 河口部（東経 8.0〜9.95 / 北緯 53.4〜54.3）のライン |
  | -------------------------------------------------- | ---------------------------------- | -------------------------------------------------- |
  | `ne_50m_rivers_lake_centerlines.geojson`（採用中） | 東経 9.784034 / 北緯 53.554638     | 無し（西端で終端）                                 |
  | `ne_10m_rivers_lake_centerlines.geojson`           | 東経 9.819021                      | 無し（50m より手前で終端）                         |
  | `ne_10m_rivers_europe.geojson`                     | 東経 15.829763（上流の別区間のみ） | 該当 feature 無し                                  |

  同区間は `ne_10m_coastline.geojson`
  が両岸を東経約9.83度まで遡って囲んでおり、Natural Earth
  が下流のエルベを海として扱っていることが裏付けられる。再現は各 GeoJSON を
  `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/ca96624a56bd078437bca8184e78163e5039ad19/geojson/<file>`
  から取得し、`name == "Elbe"` の feature の全頂点の最小経度と、上記 bbox
  に入る頂点の有無を数えれば確認できる。同じ手順を Loire・Oder
  に適用しても結論は変わらず、これがエルベ固有ではなく Natural Earth
  全体の仕様であることは
  [rivers-continuity-audit.md](rivers-continuity-audit.md) §3.2 で全 30
  河川を対象に確認している（TASK-76）。
- 集計に使った生成スクリプトは git 管理外の
  `.outputs/claude/data-inventory/_gen/` （`europe-mask.ts` = §2
  の境界定義、`gen-inventory.ts` = 集計・出力）に置いて
  おり、`deno run -A gen-inventory.ts <出力先>` で再生成する運用だった。**この
  ディレクトリは現存しない**（`.outputs/` は git 管理外で、worktree の後始末と
  ともに消えた）。本書の表そのものが集計結果の記録であり、再集計が必要な場合は
  §2.1 の境界定義と §2.2 の採否ルールから同等のスクリプトを書き直す必要がある
  （以後こうした調査・集計スクリプトは `scripts/` か `docs/research/` に置く。
  プロジェクト `CLAUDE.md` の「調査ドキュメントの出力先」節を参照）。
