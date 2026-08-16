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
する。一方、現在リポジトリに同年代の `hre_realm_1000/1100` は無い。OHM HRE
project は 919–1125 の帝国境界の典拠と mapped 状態を公表しているが、その realm
export はこのリポジトリの再現可能な生成物として未収録である。このため、監査で
権威として使えるのは出典の異なる `historical-basemaps` の補正済み base fallback
までである。

実測（沿岸補完を含む画面と同じ fallback）:

|   年 | feature 面積 |    外側面積 | 外側比率 | 判定                |
| ---: | -----------: | ----------: | -------: | ------------------- |
| 1000 |   87,070 km² | 6,088.6 km² |    6.99% | `source-difference` |
| 1100 |   86,971 km² | 6,114.2 km² |    7.03% | `source-difference` |

同一 OHM 領邦形状が、別出典の 2 年代 base に対してほぼ同じ約 6,100 km²だけ外へ
出る。史実上の帝国外所領だったと断定できる根拠は収録データに無く、専用 realm
との包含比較も再現可能な形で完了していない。したがって `mixed` とはせず、
**解消不能な出典差**として `data/extent-exceptions.json`
に年別の許容上限とともに登録した。ザクセン形状の clip、base の拡張、領邦 union
による realm 復元は行わない。将来同年代 OHM realm を取得・固定した時点で、realm
内なら base 不足として realm を採用し、realm
外なら領邦形状または史実越境を再分類する。

参考:

- OHM HRE project:
  <https://wiki.openstreetmap.org/wiki/OpenHistoricalMap/Projects/Holy_Roman_Empire>
- OHM: <https://www.openhistoricalmap.org/>

## 3. 全件分類結果

明示契約適用後の監査結果は 823 feature-year、外枠キー未解決 0、未登録の重大差
0。1 km² 以上は 187 feature-year、そのうち重大差は 121 feature-year / 67
政体・系統ケースで、すべて年別に `source-difference` として根拠表へ登録した。
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

`source-difference` は「正しい形に修正済み」という意味ではない。専用 realm と
同じ出典・年代の領邦なら realm を権威として外側を記録し、それ以外は独立した
出典間の差として記録する。根拠なく座標を手編集せず、許容上限を超える変化だけを
CI で再審査へ戻すための分類である。
