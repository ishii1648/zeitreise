---
status: accepted
date: '2026-07-27 19:08'
---

# decision-26: Cliopatria（CC BY 4.0）を OHM の欠落を埋める第 2 の領邦データとして採用する

> **追補**: 本 ADR が構造的に除外した「丸括弧で囲まれた複合体」は、
> ADR-0040（decision-40）により **base 主権の外周置換に限って**採れるように
> なった（#352）。オーバーレイの feature として描く禁止は据え置きで、緩むのは
> `CLIOPATRIA_COMPOSITE_PARENTS` に name × 年 × 上流区間 × SeshatID で全点一致
> した親だけである。

## Context

OHM（CC0）由来の諸侯領には年代・地域による大きな欠落がある。1000/1100 年のフランスはアキテーヌ公領もトゥールーズ伯領も王領も収録が無く王国が一枚岩になり、1279〜1492 年の帝国はバイエルン公領が一度も表示されない。TASK-70/87/88 は `boundary=administrative` 4,923 件を 3 回実測して該当リレーションが 0 件であることを確認しており、これは許可リストの狭さではなく上流の欠落である。

TASK-88 は現代県ポリゴンの union で埋める案を実測のうえ却下し（decision-18）、Consequences に「空白を埋める唯一の整合的な道は出典のあるデータの獲得（別データセットの調査 = 検討する場合は別タスク）」と記録した。TASK-110 がその別タスクで、候補として Cliopatria（Seshat Global History Databank、Bennett, Mutch, Chalstrey et al. 2025, Scientific Data, DOI 10.5281/zenodo.14714684、CC BY 4.0、13,765 feature）を実データで評価した。

## Decision

Cliopatria を**第 2 の領邦データソースとして採用する**。ただし用途を「OHM の欠落を埋める補完」に限定し、OHM が同じ領邦を同じ年代で収録している場合は常に OHM を優先する。

### decision-14 / decision-18 との関係（抵触しない根拠）

両 decision が禁じているのは「**出典を持たない座標の合成**」である。decision-18 が県 union を却下した理由は座標の出所（IGN）ではなく「1200 年の境界としての出典がゼロで、どの県を選ぶかという編集判断が成果物の主要部分を決める（同一通説から作った変種間で面積が 1.9 倍ふれる）」ことだった。Cliopatria はこれに当たらない。

- ジオメトリは Cliopatria が作図した座標をそのまま採る。頂点を 1 つも作らない・混ぜない・合成しない
- 各 feature が存続期間（FromYear/ToYear）・SeshatID・Wikidata を持ち、査読論文と DOI、GitHub のコミット SHA、アーカイブの SHA-256 まで追跡できる
- 選別は年代区間の**包含判定のみ**（`FromYear <= year <= ToYear`）と静的な許可リストで決まり、形状が編集判断で変わる余地が無い

したがって「地図が主張する内容の出典が追跡可能である」という decision-14 の本旨は保たれる。

### 適用範囲

- **仏（対象年は 1000/1100/1200/1279/1300 の範囲。実際に収録する年は領邦ごとに違い、下表が正確な内訳）**: 王領（domaine royal）・トゥールーズ伯領・アキテーヌ公領・ガスコーニュ公領・オーヴェルニュ / フォワ / アルマニャック / ヌヴェール / ペリゴール / ルエルグ / ヴェルマンドワ / ヴェクサン / ブロワ / ブーローニュ伯領、および OHM の収録が始まる前のシャンパーニュ伯領（〜1100）・フランドル伯領（〜1200）
- **帝国（対象年は 1279/1300/1400/1492 の範囲。同じく下表が内訳）**: バイエルン公領・ブランデンブルク辺境伯領→選帝侯領・ボヘミア王国・ザクセン選帝侯領（1492 のみ。1400 は OHM が Electorate of Saxony(-Wittenberg) を収録済み）

許可リストは「上流の Name → 収録する年」の静的な対応表（`scripts/build-cliopatria-fiefs.ts` の `CLIOPATRIA_FRANCE_FIEF_NAMES` / `CLIOPATRIA_HRE_FIEF_NAMES`）で、年は Cliopatria 側の区間が実際に覆う年だけを挙げる。**正はコードの対応表**で、以下の表はその写しである（ずれたら `scripts/build-cliopatria-fiefs_test.ts` の「#336: ADR-0026 の適用範囲の表がコードの許可リストと一致する」が落ちる）。

#### 仏諸侯領

| 上流の Name | 収録する年 | 備考 |
| --- | --- | --- |
| `Kingdom of France` | 1000 / 1100 / 1200 | 王領（domaine royal）。`NAME` は `Royal Domain of France` へ読み替える。上流の 1279 / 1300 は王国規模になるため採らない |
| `Duchy of Aquitaine` | 1000 / 1100 / 1279 / 1300 | OHM の収録は 1137-04-09〜1214-09-28 のみ |
| `Duchy of Gascony` | 1000 | 上流の区間は `[990-1017]` のみ |
| `County of Toulouse` | 1000 / 1100 / 1200 | 上流の収録は `[1188-1205]` で終わる（1271 年の王領併合を反映） |
| `County of Auvergne` | 1279 / 1300 | |
| `County of Foix` | 1279 / 1300 | |
| `County of Armagnac` | 1279 / 1300 | |
| `County of Nevers` | 1100 / 1200 / 1300 | |
| `County of Périgord` | 1279 / 1300 | |
| `County of Rouergue` | 1000 | |
| `County of Vermandois` | 1000 / 1100 / 1200 | |
| `County of Vexin` | 1000 | |
| `County of Blôis` | 1000 / 1100 / 1200 / 1279 | **1300 年は収録しない**（#321）。上流の `[1294-1332]` は閉点を除いて 5 頂点・3,658 km² しか無く、ロワール川ともブロワの街とも無関係な細長い四角形になる（`CLIOPATRIA_EXCLUSIONS.upstreamGeometryTooCoarse` / `data/known-limitations.json`） |
| `County of Boulogne` | 1200 | |
| `County of Flanders` | 1000 / 1100 / 1200 | OHM の収録は 1237 年（フランドルから分離した年）以降のみ |
| `County of Champagne` | 1000 / 1100 | OHM の収録は 1200 年以降のみ |

#### 帝国領邦

| 上流の Name | 収録する年 | 備考 |
| --- | --- | --- |
| `Duchy of Bavaria` | 1279 / 1300 / 1400 / 1492 | OHM は 0962-1100 と 1505-1623 のみで 1100〜1505 が完全欠落 |
| `Margraviate of Brandenburg` | 1279 / 1300 / 1400 | OHM の `Electorate of Brandenburg` は 1648 年以降のみ |
| `Electorate of Brandenburg` | 1492 | 同上 |
| `Duchy of Bohemia` | 1000 | 同年区間［1000-1002］（cz_bohemian_duc）。raw は上流座標を無改変で保持する |
| `Kingdom of Bohemia` | 1279 / 1300 / 1400 / 1492 | OHM の `Duchy of Bohemia` は 1100 年のみ。この表は**通常収録**（上流の区間がその年を実際に覆うもの）の一覧で、1200 年は上流に区間が無く年借用で入る（`CLIOPATRIA_BORROWED_YEARS` / ADR-0039 / #346） |
| `Electorate of Saxony` | 1492 | 1400 は OHM が `Electorate of Saxony(-Wittenberg)` を収録済み |

**改訂（#336）**: 初版のこの節は仏側・帝国側の対象年を一括で示していたが、収録年は領邦ごとに違うため上表へ展開し、コードの許可リストと全 feature × 年を照合した。決定そのもの（採用の可否・用途の限定・選別規則）は変えていない。初版からの実体の差は #321 の 1 件（1300 年の `County of Blôis` を除外）だけで、これは「年は Cliopatria 側の区間が実際に覆う年だけを挙げる」という本 ADR の規則と、上流の粗すぎるジオメトリを採らないという `CLIOPATRIA_EXCLUSIONS` の適用結果であって、新しい方式判断ではない（改訂か新規 ADR かの使い分けは `docs/development-style.md` 2.1 章を参照）。

### 却下した選択肢

- **Cliopatria を全面採用して OHM を置き換える**: 採らない。Cliopatria は 2014 年に手描きされた歴史地図画像を Python で自動抽出し 0.07 度（約 7.8 km）で平滑化したもので、論文自身が「境界は必然的に概略で解釈の余地がある」と明記している。頂点密度も OHM の 1/4〜1/7（1000 年の Duchy of Aquitaine が 69 頂点、OHM の 1200 年版が 330 頂点）。同じ領邦を 2 つの出典で二重に描く意味も無い
- **複合体（丸括弧付き feature）を描く**: 採らない。1000 年の `(Kingdom of France)` は 420,259 km² で封臣を全て飲み込んでおり、単独の `Kingdom of France`（= 王領 49,071 km²）の 8.6 倍。描くと王国全体が 1 色になり諸侯領オーバーレイの目的そのものを損なう
- **`Holy Roman Empire Minor States` を描く**: 採らない。数百の小領邦の残余カテゴリで 1279 年 518,669 km² / 1300 年 555,409 km² / 1400 年 458,794 km² / 1492 年 343,299 km²。1 つの名前・色・ラベルで描くと事実に反し、補ったバイエルン公領・ブランデンブルク辺境伯領・ボヘミア王国を丸ごと覆う
- **`Type = RELATION` を描く**: 採らない。人的同君連合・臣従などの上位関係で、ジオメトリは関係先の合併と同一（1400 年の `(Vassalage of Kingdom of Bohemia to Holy Roman Empire)` は帝国複合体と同じ 1,035,034 km²）
- **家門（House of Habsburg / Ascania / Wittelsbach / Luxembourg / Valois-Anjou）を描く**: 採らない。領邦ではなく帝国内に散在する所領の集合体で、OHM が個別収録する領邦と重なる（1279 年の House of Wittelsbach 17,892 km² は同年の Duchy of Bavaria 35,323 km² と重複）
- **1279/1300 の `Kingdom of France` を王領として描く**: 採らない。同年の Cliopatria の値は 206,111 / 242,840 km² と王国規模で、諸侯領ではなく base のフランス勢力と同じものを描くだけになる。王領として採るのは 1000（49,071）/ 1100（21,966）/ 1200（37,024）km² の 3 年
- **上流のポリゴンが名前の指す土地に載っていない feature を採る**: 採らない。`County of Touraine` は 1279 / 1300 年とも bbox が 0.90〜2.60E・45.56〜46.55N で、トゥール（0.69E・47.39N）を 1 度も含まずリムーザン〜マルシュ地方を覆う。OHM 由来の `County of La Marche` と 7,272 km²（この feature の 73%）重なることからも実体はトゥーレーヌではない。名前と土地が一致しない feature を足すのは空白のままにするより悪い
- **Zenodo の DOI でピン留めする**: 採らない。10.5281/zenodo.14714684 は「全バージョン」を指す concept DOI でバイト列を固定できない。再現性は GitHub のコミット SHA（`ad28a691b7c07c1fca89d0e0636d324667d2a258` = v0.2.0）とアーカイブの SHA-256（`d01ae3a2…`、44,231,317 バイト）で担保し、DOI は CC BY 4.0 の帰属表示と引用のために保持する

### 実装上の帰結（データ契約）

- 独立ファイルとして生成する: `data/cliopatria_fiefs_<year>.geojson`（生データ）と、アプリが配信・描画する `data/cliopatria_fiefs_flat_<year>.geojson`。CC BY 4.0 は GPL-3.0 派生とも CC BY-NC-SA とも混合制約が無いが、出典表記の一貫性のため decision-2 と同じく分離する
- properties は既存 fief と同型。仏側は `france_fiefs_*` と同じく `SUBJECTO` を持たず、帝国側は `hre_fiefs_*` と同じ `SUBJECTO` / `PARTOF` = `Holy Roman Empire`。上流の出所（`CLIOPATRIA_NAME` / `CLIOPATRIA_SESHAT_ID` / `CLIOPATRIA_AREA_KM2` / `WIKIDATA` / `WIKIPEDIA`）を接頭辞付きで残す
- 上流の `Kingdom of France` は `NAME` を `Royal Domain of France` へ読み替える。Cliopatria は王国全体を複合体として別に持つので丸括弧無しの方は王の直轄領を指すが、そのままだと base のフランス王国と色キー・ラベル・パネル見出しが衝突する。**ジオメトリには触れない語彙の上書き**で、上流の名前は `CLIOPATRIA_NAME` に残す（decision-23 と同方針）
- 境界の確からしさに 5 区分目 `digitizedFromMapImages`「史料地図のデジタイズ（概略。手描き地図の自動抽出を 0.07 度で平滑化）」を新設する。OHM / Roller の `reconstructed`（領域ごとに存続期間付きで作図された復元）とは確からしさの根拠が違い、その差を裏づける情報（原図の由来・平滑化の度合い・頂点密度）がデータ側にある
- 重なりはレイヤーまたぎで**常に Cliopatria 側から差し引く**（`scripts/build-fief-flat.ts` の `subtractOverlay`）。より細かい OHM の形を残すため、かつ「OHM の欠落を埋める補完」という役割そのもののため
- base 塗り・base 輪郭の派生（`europe_flat_<year>` / `base_outline_<year>`）の union にも Cliopatria を加える。外すと 1400/1492 のバイエルン公領などの下に base 塗りが残って半透明が二重に重なる

## Consequences

- 空白が大きく埋まる（base 勢力に対する諸侯領オーバーレイの被覆率）: 1000 年フランス 24.9% → 78.5%、1100 年 26.2% → 78.4%、1200 年 47.7% → 77.9%、1200 年のトゥールーズ伯領 4.2% → 54.1%、1279 年のフランス 31.3% → 42.6%、1300 年 35.0% → 46.0%、1279 年の帝国 16.7% → 30.9%、1300 年 18.8% → 32.4%、1400 年 27.0% → 45.8%、1492 年 27.3% → 50.6%。
- **1200 年の帝国中核の空白は残る**（507,304 km²、帝国の 81.3%）。Cliopatria は 1200 年の帝国を `Holy Roman Empire` 879,279 km² の一枚岩でモデル化しており内部領邦の feature が 0 件で、補える材料が無い。1200/1279 年のザクセン後継領邦・ブルボンも同様に残る（実測値は `data/known-limitations.json` と `docs/data-inventory/README.md` §3.11）。
- 地図上に出典が 6 系統になる（historical-basemaps / OHM / ETH Zürich Roller / Natural Earth / Reba et al. / Cliopatria）。TASK-109 の feature 単位の出典表示があるので、利用者はクリックでどれを見ているか判別できる。
- CC BY 4.0 の帰属要件を満たすため、フッターの attribution に書誌情報（Bennett, Mutch, Chalstrey et al. 2025）と DOI を出す。
- ソースを更新するときは `CLIOPATRIA_SOURCE_COMMIT` と `CLIOPATRIA_ARCHIVE_SHA256` を同時に更新し、許可リストの年が新しい区間でも有効かを再確認する（区間は版で変わりうる）。許可リストを変えたときは本 ADR の適用範囲の表も同じコミットで更新する（忘れると `scripts/build-cliopatria-fiefs_test.ts` の #336 のテストが落ちる）。
- 以後の欠落判断の基準: decision-14 / decision-18 の「出典が無いなら描かず説明する」は維持したうえで、**出典のある第 2 のデータセットで補えるなら補う**を追加する。判定は「上流の座標をそのまま使うか」「選別が決定的か」の 2 点で行う。
- 関連タスク: TASK-70, TASK-87, TASK-88, TASK-109, TASK-110 / 関連 decision: decision-2, decision-13, decision-14, decision-18, decision-23
