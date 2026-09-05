# 上位政治圏外枠の所属・越境監査（Issue #436）

## 1. 契約と再現

外枠は選択 feature の囲みではなく、宗主・帝国など上位政治圏の名目境界である。
所属は `data/extent-membership.json` の 823 feature-year
に明示し、配色・情報表示の `SUBJECTO` やラベルアンカーの位置から推定しない。

```sh
deno task audit-extent-membership
```

監査は全 19 年代・HRE / France / Italy / Cliopatria / Britain / Sovereign の 6
系統（隣接年からの借用 3 feature を含む）を走査し、
`.outputs/extent-membership-audit.json`
に年、系統、`NAME`、外枠キー・role、feature
面積、外側面積・比率・bbox、判定を出す。CI は同じ関数を実データ回帰テストから
呼ぶ。

閾値は 1 km² 以上を警告、100 km² 以上かつ feature 面積の 1% 以上を failure と
する。1 km² は 3 桁座標丸め（緯度方向約 111m）の単一線分より十分大きい一方、
長い境界に沿う差を記録できる監査線である。100 km²・1% は、初回実測で得た 「1 km²
以上 233件」と「100 km²・1% 以上 150件」の間に置き、肉眼で判別できる
差と局所スリバーを分ける。宗主キー未解決、所属表の過不足、根拠表の不足は面積に
関係なく failure とする。

## 2. 1000 / 1100 年ザクセン公領

領邦は両年とも OpenHistoricalMap relation 2805386（`start_date=0804`,
`end_date=1180`）の同一形状で、上流自身が `SUBJECTO=Holy Roman Empire` を宣言
する。同じ OHM 系列の同年 realm として、1000 年は relation `2805484`
（0983–1002）、1100 年は relation `2750623`（1043–1167）を固定入力から生成する。

実測（沿岸補完を含む画面と同じ fallback）:

|   年 | feature 面積 | 外側面積 | 外側比率 | 判定         |
| ---: | -----------: | -------: | -------: | ------------ |
| 1000 |   87,070 km² |  1.2 km² |  0.0014% | `conforming` |
| 1100 |   86,971 km² |  1.1 km² |  0.0012% | `conforming` |

親 realm の置換によりザクセンの重大差は解消した。座標編集、領邦 union、clip は
行っていない。入力 JSON の SHA-256 は順に
`4bd30ac88123218c86e82954487db419d0f97be6a1a494335804712533f4b8df`、
`0bbd0b5f83067a7eba5b6d234446f2781327927451499afed1519d1a3edc0d44`。 取得は
`https://overpass-api.openhistoricalmap.org/api/interpreter` に
`[out:json][timeout:120];rel(<id>);out geom;` を送り、
`timestamp_osm_base=2026-09-04T15:41:41Z`、ライセンスは CC0 1.0 である。

参考:

- OHM HRE project:
  <https://wiki.openstreetmap.org/wiki/OpenHistoricalMap/Projects/Holy_Roman_Empire>
- OHM: <https://www.openhistoricalmap.org/>

## 3. 全件分類結果

明示契約適用後の監査結果は 840 feature-year、外枠キー未解決 0、未登録の重大差
0。重大差は 114 feature-year。既存表のうち通常閾値未満となった 15 件は
`resolutions` に移し、残る 114 件は `unresolved-source-difference` とした。
各行に調査候補、対象年、ライセンス、固定可否、不採用理由、不足入力を記録する。
現時点で史実根拠まで確定した `mixed` は無い（型・表示・例外ゲートは実装済み）。

初回監査の重大 150 feature-year から減ったのは、次を「周囲の base への所属」
ではなくデータ契約の修正として処理したためである。

- Pisa / Genoa → Corsica、1400 Moscow → Blue Horde を廃止して `self`
- Britain の独立政体を周囲の集合的 base 勢力へ従属させず `self`
- Sodor、Isle of Man、Piombino、Knights Hospitaller、Ragusa、Monaco、Ionian
  Islands など旧未解決 27 feature-year を個別に `self` または明示宗主へ分類
- Sovereign 系統は Wallachia / Moldavia / Crimean Khanate / Finland / Hungary /
  Transylvania 等の出典で確認できる宗主関係だけを `member`
  とし、単なる空間包含を従属扱いしない

`unresolved-source-difference` は「正しい形に修正済み」という意味ではない。専用
realm と 同じ出典・年代の領邦なら realm
を権威として外側を記録し、それ以外は独立した
出典間の差として記録する。根拠なく座標を手編集せず、許容上限を超える変化だけを
CI で再審査へ戻すための分類である。
