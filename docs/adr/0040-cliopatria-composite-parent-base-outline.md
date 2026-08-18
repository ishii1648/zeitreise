---
status: accepted
date: '2026-08-15'
---

# decision-40: Cliopatria の括弧付き複合体を base 主権の外周置換に限って採る（ADR-0026 の適用範囲の拡張）

## Context

ADR-0026 は Cliopatria を「OHM の欠落を埋める第 2 の領邦データ」として採用し、
その際に **名前を丸括弧で囲んだ複合体を構造的に除外**した
（`scripts/build-cliopatria-fiefs.ts` の `isCompositeName` /
`cliopatriaExclusionReason` / `CLIOPATRIA_EXCLUSIONS.composite`）。理由は
諸侯領オーバーレイの目的に照らして明快である。

> 1000 年の `(Kingdom of France)` は 420,259 km² で、単独の
> `Kingdom of France` = 王領 49,071 km² の 8.6 倍。そのまま描くと王国全体が
> 1 色で塗られ、「誰がどこを直接支配していたか」という
> **諸侯領オーバーレイの目的が完全に失われる**。

#352 はこの除外と真正面から衝突する。症状は諸侯領ではなく **base 主権の外周**に
ある。

- base（historical-basemaps・`BORDERPRECISION=1` = approximate）の
  1000〜1400 年のポーランドは、世界・大陸スケール用の概略ポリゴンで、
  外周が少数の長大な直線で構成される。実測の最長線分は
  1000 年 312.4 km / 1100 年 264.4 km / 1200 年 183.9 km / 1400 年 841.7 km。
- 上流と生成後の座標を突き合わせると、50 km 以上の主要線分は完全に一致した。
  つまり `simplify`・座標丸め・polygon cleanup のいずれでもなく、**上流の
  ポリゴンそのもの**が原因である（#352 の調査）。
- 一方 Cliopatria には、当該 6 年をそれぞれ直接覆う区間の
  `(Kingdom of Poland)` / `(Duchies of Poland)` / `(Polish-Lithuania Kingdom)`
  が存在し、外周の最長線分は 74.4 / 90.2 / 75.5 / 110.7 / 110.7 / 195.4 km と
  1 桁近く短い。しかもこれらの複合体は、**同じ出典の leaf 子区画の union と
  IoU 1.0（重なり 0 km²）で一致する**。

つまり「複合体は封臣の領域を飲み込んだ 1 枚のポリゴンだから描かない」という
ADR-0026 の根拠が、この用途では逆に働く。**base 主権の外周は本来「封臣の領域を
含む主権の外側の輪郭」であり、複合体はまさにその形をしている。**

決めずに実装すると、`CLIOPATRIA_EXCLUSIONS.composite` を無条件に緩めるか、
許可リストの外で例外を積むかのどちらかになり、以後「複合体をどこまで使って
よいか」の基準が失われる。

## Decision

**ADR-0026 の適用範囲を次の 1 点だけ拡張する。**

> Cliopatria の括弧付き複合体は、**base 主権の外周（`europe_<year>.geojson` の
> 勢力ポリゴン）の置換入力としてのみ**採ってよい。諸侯領・領邦オーバーレイの
> feature として描くことは従来どおり禁止する。

発火条件は #346 の `CLIOPATRIA_BORROWED_YEARS` と同じ形式の
**name × 年 × 上流区間 × SeshatID の全点一致許可リスト**
（`CLIOPATRIA_COMPOSITE_PARENTS`）に限る。1 つでもずれたら採らない
（上流の版が変われば静かに別の面へ差し替わるのではなく、許可が消えて生成物
テストが落ちる側へ倒す）。

### 1. 許可リストの形（親 1 件 + leaf 子区画の明示）

`allowedYearsFor` の平坦表（name → 年）は親子の区別を持てないため、年ごとに
次を持つ構造にする。

| 項目 | 意味 |
| --- | --- |
| `targetYear` | 対象スナップショット年 |
| `name` | 上流の Name（括弧付き複合体） |
| `fromYear` / `toYear` | 上流区間（`FromYear` / `ToYear` と厳密一致） |
| `seshatId` / `wikidata` | 同名の別政体を取り違えないための鍵 |
| `basePowerName` | 置換する base 勢力の NAME（= 子区画の SUBJECTO） |
| `childNames` | leaf 子区画の上流 Name（昇順・全件） |
| `reason` | 採る根拠 |

適用年は **6 年すべてが対象年を直接覆う区間**で、ADR-0039 の年借用は使わない
（外挿・最近傍は従来どおり禁止）。

| 年 | 上流 Name | 区間 | SeshatID | 置換する base | leaf 子区画 |
| ---: | --- | --- | --- | --- | ---: |
| 1000 | `(Kingdom of Poland)` | 990–1002 | `pl_piast_dyn_1` | `Poland` | 1 |
| 1100 | `(Kingdom of Poland)` | 1056–1125 | `pl_piast_dyn_1` | `Poland` | 1 |
| 1200 | `(Duchies of Poland)` | 1192–1201 | `pl_piast_dyn_2` | `Poland` | 6 |
| 1279 | `(Duchies of Poland)` | 1279–1284 | `pl_piast_dyn_2` | `Poland` | 9 |
| 1300 | `(Duchies of Poland)` | 1294–1304 | `pl_piast_dyn_2` | `Poland` | 11 |
| 1400 | `(Polish-Lithuania Kingdom)` | 1395–1401 | `pl_jagiellonian_dyn` | `Poland-Lithuania` | 2 |

### 2. leaf の判定は `MemberOf` で構造的に行い、許可リストと突き合わせる

子区画は「その年に有効で `MemberOf` に親名を含む feature」のうち
**leaf**（= その年に有効な feature の `MemberOf` に一度も現れない名前）だけを
採る。これにより 1400 年の `(Kingdom of Poland)` wrapper（親と同形状・
`Kingdom of Poland` を配下に持つ）が自動的に落ち、leaf 2 件
（`Kingdom of Poland` / `Grand Duchy of Lithuania`）だけが残る。

`MemberOf` から算出した leaf 集合が許可リストの `childNames` と一致しなければ
ビルドを失敗させる。上流の版が変わって構成が動いたことを、生成物が静かに
変わる前に検出するための歯止めである。

### 3. 親は「base 置換専用」で、オーバーレイには出さない

親 feature は `data/cliopatria_fiefs_<year>.geojson`（raw・配信しない中間
生成物）にだけ置き、配信される `data/cliopatria_fiefs_flat_<year>.geojson`
には出さない。理由は 2 つ。

- `buildCliopatriaFiefFlat` の `resolveOverlaps(..., "keep-smaller")` は
  子区画で親を削るため、親（= 子の union）は面が残らず消える。消えるものを
  入力に入れておく意味が無い。
- 親を配信すると ADR-0026 が禁じた「複合体を 1 色 1 ラベルで描く」ことに
  なる。本 ADR が緩めるのは base の外周だけで、オーバーレイの禁止は据え置く。

`scripts/build-fief-dedupe.ts` の `fiefsPathsFor` が取る union と被覆率の意味は
変わらない。親は子区画 union と IoU 1.0 で一致するため、union に親を足しても
引いても集合として同値だからである。

### 4. base の置換は「外周の入替 + 差分の再配分」で、穴も二重塗りも残さない

`scripts/build-data.ts` に `BASE_POWER_REPLACEMENTS` を新設する。適用は
`applyBaseFiefSplits` の**後段**に置く。

- **前段に置かない理由**: 1100 / 1200 年の `BASE_FIEF_SPLITS` は
  ボヘミア公領・ボヘミア王国・モラヴィアを **Poland 塗りから**切り出している
  （TASK-157 / #346）。Cliopatria のポーランドはプラハもブルノも含まないため、
  先に置換すると切り出し元が消えて #346 の成果が失われる。後段に置けば、
  切り出し済みの feature はそのまま残り、置換は「切り出した残りの Poland」に
  対して行われる。
- **差分の扱い**: 旧ポリゴンにしか無い領域（`oldOnly`）は、#342 の
  `mergeSeveredRemainders` と同じ規則で**連結成分ごとに共有境界が最長の隣接
  勢力へ併合**する。落として穴にすると、隙間なく塗り分けられた base に
  そのまま見える穴が空くためである。新ポリゴンにしか無い領域（`newOnly`）は
  隣接勢力から差し引く（同じ土地を二度塗らない）。
- **#443 の補足**: 共有境界規則が大面積の残余を別勢力へ移し、置換元の長辺まで
  名前を変えて残す場合は `remainderRules` で年・連結成分・帰属先・理由・出典を
  明示する。1000 年の旧 Poland 西側約 25,414 km² は、Cambridge University
  Press『Medieval Heresies』map 3（Europe in the year 1000）が Poland の西・
  南西側を Holy Roman Empire とすることに基づき同勢力へ統合する。これにより
  Pomerania への誤併合と旧 Poland―HRE 間の 312.4 km 線分を同時に除く。
- **開示**: 併合先が歴史的に自明でない差分は `data/known-limitations.json` に
  年・面積・併合先・根拠の限界を明記する。旧 Poland に無条件で残すことは
  しない。

### 5. 変えないもの

- 座標は 1 頂点も編集・合成・簡略化しない（ADR-0014）。現代国境・スプライン・
  ランダム揺らぎによる補間は引き続き禁止で、残る長辺（1279 / 1300 の
  110.7 km、1400 の 195.4 km）は **Cliopatria 原典由来の制約**として
  known-limitations に記録する。
- `CLIOPATRIA_EXCLUSIONS` の `relation` / `residualCategory` /
  `sovereignPowers` / `dynasticHouses` などの分類は据え置く。緩めるのは
  `composite` の 1 分類、かつ許可リストに全点一致した親だけである。
- 諸侯領・領邦オーバーレイ（`CLIOPATRIA_FRANCE_FIEF_NAMES` /
  `CLIOPATRIA_HRE_FIEF_NAMES`）の選定規則は変えない。

## Consequences

### 追跡可能性（生成物と UI の両方から辿れること）

- **feature の properties**: 親・子とも `CLIOPATRIA_COMPOSITE`
  （`parent` / `child`）・`CLIOPATRIA_NAME`（上流 Name）・
  `CLIOPATRIA_SESHAT_ID`・`WIKIDATA`・`START_DATE` / `END_DATE`（上流区間）を
  持つ。子区画の `SUBJECTO` / `PARTOF` は `basePowerName`（`Poland` /
  `Poland-Lithuania`）にし、色キー・勢力圏の外枠・ラベルが base の主権へ
  解決するようにする。
- **ファイル単位の metadata**: `data/cliopatria_fiefs_<year>.geojson` の
  `metadata.compositeParents` に対象年・上流区間・SeshatID・置換した base 勢力
  ・leaf 子区画を記録する。出典キー（`source` / `license` = CC BY 4.0 /
  `commit`）は `scripts/build-attribution.ts` が従来どおり刻む。
- **UI での開示**: `data/known-limitations.json` に、置換した 6 年の外周が
  Cliopatria 由来であること・残る長辺・差分の再配分先を年ごとに書く。
- **台帳**: `docs/data-inventory/README.md` と
  `docs/data-inventory/year-<year>.md`・`missing-powers-ledger.md` を同期する。

### 波及

- base（GPL-3.0）へ CC BY 4.0 の面を取り込む点は ADR-0039 決定 3 と同じ判断で、
  CC BY 4.0 は GPL-3.0 派生との混合制約を持たず、要求される帰属表示は既存の
  attribution パイプラインが満たしている。ETH Zürich（CC BY-NC-SA 4.0）の面は
  従来どおり禁止（decision-2）。
- 許可リストの追加は ADR の表への 1 行と対になる（乖離は
  `scripts/build-cliopatria-fiefs_test.ts` が検出する。#336 / #346 と同じ規律で
  **コード側が正**）。
- ポーランド以外の base 勢力へ同じ手当てを広げるかは本 ADR では決めない。
  広げるときは同じ許可リスト形式で年・区間・SeshatID を全点一致で足し、
  差分の再配分と known-limitations の記載を同時に行うこと。
- 関連 ADR: 0014（出典なき座標合成の禁止）・0016（概略境界の描画）・
  0026（本 ADR の親。Cliopatria の採用と複合体の除外）・0028（BASE_FIEF_SPLITS）・
  0033 / 0039（借用と CC BY 4.0 の入力）・0035（表示は差引済み flat）・
  0037（raw は上流精度）。関連 Issue: #352（実装）・#346（1200 年ボヘミア）・
  #342（切り出し残余の併合）・#321 / #336（許可リストと ADR の同期）。
