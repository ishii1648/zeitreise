---
status: accepted
date: '2026-08-14'
---

# decision-39: 上流データセットの隣接区間からの年借用を認め、CC BY 4.0 の面を BASE_FIEF_SPLITS の入力に使う（ADR-0033 の追補）

## Context

ADR-0033 は「上流に面が無い年へ隣接年の出典付きジオメトリを流用する」ことを
4 条件つきで認めた。実装（`scripts/build-borrowed-fiefs.ts` の
`BORROWED_FEATURES`）はその条件 2 を素直に読み、**本リポジトリが既に生成物と
して持っているファイル**（`data/hre_1500.geojson` 等）からしか複製できない。

#346（1200 年のボヘミア王国がポーランド塗りに呑まれる）はこの枠に収まらない。
実測すると次の状態だった。

- 1200 年のボヘミアを覆う面は**どの採用済みソースにも無い**。OHM の
  `Duchy of Bohemia` は end_date 1100、Cliopatria は `Duchy of Bohemia`
  ［.. -1002］の次が `Kingdom of Bohemia` ［1202-1215］で、1003〜1201 年の
  区間を持たない。
- 使える面は Cliopatria の `Kingdom of Bohemia`［1202-1215］（SeshatID
  `cz_bohemian_k_1`、Wikidata Q42585、70,806 km²）だけ。この区間は
  `SNAPSHOT_YEARS`（`src/config.ts`）に無いため、**本リポジトリのどの生成物にも
  存在しない**。
- 同じ 1200 年の切り出しはすでに OHM の `Moravia`（1182〜1742）で行っており、
  ボヘミア本体だけが残っていた（TASK-157 / `data/known-limitations.json` の
  `base-poland-paint-bohemia-1200`）。

この事案は既存の規約 3 点に文言上ひっかかる。

1. **ADR-0033 条件 2**（借用元は「既に本リポジトリが採用し生成物として持って
   いる面」）— Cliopatria の 1202–1215 区間はどの生成物にも無い。
2. **ADR-0033 条件 4**（「隣接するスナップショット年からの借用のみ」）— 今回は
   スナップショット年ではなく**上流データセットの隣接区間**からの借用である。
   年差は 2 年で、条件 4 の本旨（領域の連続性が担保される近さ）は満たす。
3. **`BASE_FIEF_SPLITS` の入力ライセンス規約**（`scripts/build-data.ts`）—
   コメントが「入力に使えるのは CC0 のオーバーレイに限る」と宣言していたが、
   Cliopatria は **CC BY 4.0** である。

3 点を決めないまま実装すると、以後「どこまでが借用として許されるか」の基準が
失われる。

## Decision

**ADR-0033 の追補として、次の 3 点を認める。**

### 1. 借用元は「上流データセットの実在区間」でもよい

ADR-0033 条件 2 の目的は「借用元が出典付きの実在ジオメトリであること」であって
「本リポジトリのファイルであること」ではない。**上流データセットの feature を、
コミット SHA とアーカイブの SHA-256 でバイト列まで特定できる形で指せるなら、
借用元として認める。**

- 座標は 1 頂点も編集・合成・簡略化しない（ADR-0014 の禁止はそのまま効く）。
- 借用元 feature は **name × 対象年 × 上流区間 × ソース識別子（SeshatID）の
  全点一致**で指定する。1 つでもずれたら借用は発火しない（上流の版が変わったら
  静かに別の面を借りるのではなく、借用が消えて生成物テストが落ちる側へ倒す）。
- 実装は既存系統のパイプラインの中に置き、**新しい lineage を作らない**。
  #346 では `scripts/build-cliopatria-fiefs.ts` の `CLIOPATRIA_BORROWED_YEARS`
  という許可リストが、`selectForYear` の包含判定（`containsYear`）を
  **その 1 件に限って**迂回する。出力は既存の
  `data/cliopatria_fiefs_1200.geojson`（同一系統・同一ライセンス・同一ファイル）
  なので「1 ファイル 1 出典」は崩れない。
- 無条件の最近傍・外挿は**引き続き禁止**である。緩めるのは列挙した許可リストの
  範囲だけで、許可リストに載らない name / 年 / 区間は従来どおり包含判定で落ちる。

### 2. 年差は「1 スナップショット区間以内」を「上流区間の隣接」まで広げる

ADR-0033 条件 4 の本旨は「その間に地図の縮尺で見て有意な領域変動が無い」ことの
機械的な代理指標である。**上流データセットの区間が対象年の直前・直後に隣接して
いる場合も、同じ本旨を満たすものとして認める。**離れた区間からの借用は、条件 3
（政体の同一性と領域の連続性）を満たしていても認めない。

### 3. `BASE_FIEF_SPLITS` の入力に CC BY 4.0 のオーバーレイを認める

`BASE_FIEF_SPLITS`（`scripts/build-data.ts`）は base（GPL-3.0）へ別系統の形を
取り込む操作なので、入力は**混合制約の無いオーバーレイ**に限る。既定の CC0
（`france_fiefs` / `hre_fiefs` / `italy_fiefs`）に加えて、**CC BY 4.0 の
Cliopatria（`cliopatria_fiefs_flat_<year>.geojson`）を認める**。

- CC BY 4.0 は GPL-3.0 派生との混合制約を持たない。要求されるのは帰属表示だけ
  で、それは既に稼働している（ADR-0026 が Cliopatria を第 2 の領邦データとして
  採用し、`scripts/build-attribution.ts` がファイル単位の出典キーを刻み、
  `deno task audit-attribution` が欠落を検出し、フッターの attribution が書誌
  情報と DOI を出す）。
- ETH Zürich（Roller）の CC BY-NC-SA 4.0 データ（`hre_<year>`）は**従来どおり
  禁止**である（decision-2）。NC / SA は GPL-3.0 派生との混合制約を持つ。

### #346 への適用（この基準で何が通ったか）

| 条件 | 判定 |
| --- | --- |
| ADR-0033 条件 1: 対象年に面が無い | ○ OHM・Cliopatria とも 1200 年のボヘミアを覆う区間が無い（`Duchy of Bohemia` は OHM が 〜1100、Cliopatria が 〜1002） |
| 条件 2（本 ADR で緩和）: 借用元が出典付きの実在ジオメトリ | ○ Cliopatria `Kingdom of Bohemia`［1202-1215］/ SeshatID `cz_bohemian_k_1` / コミット `ad28a691b7c07c1fca89d0e0636d324667d2a258` / アーカイブ SHA-256 `d01ae3a2…` |
| 条件 3: 政体の同一性と領域の連続性 | ○ プシェミスル・オタカル 1 世は 1198 年の王号取得から 1230 年まで継続してボヘミア王。借用面は 1100 年 OHM の `Duchy of Bohemia` と IoU 84.8%、1200 年 OHM `Moravia` の 96.4% を覆う |
| 条件 4（本 ADR で緩和）: 上流区間の隣接 | ○ 年差 2 年（1200 → 1202） |
| ライセンス（本 ADR で緩和） | ○ CC BY 4.0 を `BASE_FIEF_SPLITS` の入力に使う |

Euratlas は高品質な候補だが有償・再配布制限のため OSS リポジトリに収録できず、
1100 年 OHM 区画の 100 年外挿は条件 3・条件 4 のどちらも満たさない。

## Consequences

### 帰属表示と借用の追跡可能性（生成物と UI の両方から辿れること）

ADR-0033 の開示要件を、上流区間からの借用に合わせて具体化する。**借用面の
帰属表示（出典・ライセンス・コミット）と借用の事実は、生成物と UI の双方から
追跡できなければならない。**

- **feature の properties**: `BORROWED_FROM` に `targetYear` / `fromYear` /
  `toYear` / `dataset` / `commit` / `seshatId` / `license` / `reason` を刻む。
  `START_DATE` / `END_DATE` は**上流の区間のまま**（1202 / 1215）にするので、
  地図が主張する内容は「1200 年の境界」ではなく「1202–1215 年の出典付き境界を
  1200 年の近似として示したもの」になる。
- **ファイル単位の metadata**: `data/cliopatria_fiefs_1200.geojson` と、配信
  される `data/cliopatria_fiefs_flat_1200.geojson` の `metadata.borrowedFrom`
  に同じ記録を持つ。ファイル単位の出典キー（`source` / `sourceUrl` /
  `license` = CC BY 4.0 / `commit` / `borderPrecision`）は
  `scripts/build-attribution.ts` が従来どおり刻み、
  `deno task audit-attribution` の対象に含まれる。
- **UI での開示**: `data/known-limitations.json` の
  `base-poland-paint-bohemia-1200`（1200 年だけで active）に、借用元の区間
  1202–1215・データセット名 Cliopatria・SeshatID `cz_bohemian_k_1`・ライセンス
  CC BY 4.0・固定コミットを書く。地図を見ている利用者が「この境界は 2 年後の
  区画を借りた近似である」と読める状態を保つ。加えてフッターの attribution が
  CC BY 4.0 の書誌情報と DOI を出す（ADR-0026）。
- **台帳**: `docs/data-inventory/missing-powers-ledger.md` の該当行を「借用で
  表示」に更新し、上流が埋まれば解消できる行として残す。

### 表示は差引済みの flat 派生物（ADR-0035 の適用）

借用面も既存系統と同じく flat 派生物を配信・描画する。#346 では
`data/cliopatria_fiefs_flat_1200.geojson` がそれにあたり、既存の
`buildCliopatriaFiefFlat` が OHM の `hre_fiefs_flat_1200`（= `Moravia`）を
Cliopatria 側から差し引く（ADR-0026 の「重なりは常に Cliopatria 側から
差し引く」）。結果として、モラヴィア辺境伯領はより細かい OHM の形のまま残り、
ボヘミア王国は差し引かれた残りとして立つ。二重塗り・二重ピックは発生しない。
借用元の座標無改変は raw（`data/cliopatria_fiefs_1200.geojson`）で維持する。

### 上流が埋まった場合の差し替え（自動検知）

借用は暫定措置である。上流に対象年を直接覆う区間が現れたら、
`borrowSupersededReason` がビルド時に検知して
`deno task build-cliopatria-fiefs` を失敗させる（ADR-0033 条件 1「既存の収録が
常に優先する」の機械化）。そのときは借用エントリを許可リストから外して通常
収録へ切り替え、`BORROWED_FROM`・known-limitations・台帳の記載も同時に落とす。

### 波及

- 「作れるものは作る」への後退ではない。合成（新しい座標を作る）は引き続き全面
  禁止で、本 ADR が認めるのは**既存の出典付き座標を、由来を明示して隣接区間から
  流用すること**と、その入力に CC BY 4.0 を使えるようにすることだけである。
- 借用の追加は許可リストへの 1 行と ADR の追記が対になる（乖離は
  `scripts/build-cliopatria-fiefs_test.ts` の #346 のテストが検出する。#336 と
  同じ規律で**コード側が正**）。
- 関連 ADR: 0014（出典なき座標合成の禁止）・0018（本旨を「主張の出典」へ適用）・
  0026（Cliopatria の採用と CC BY 4.0 の帰属）・0028（切り出しと propertyFixes の
  併用）・0033（本 ADR の親）・0035（借用の表示は差引済み flat）。
  関連 Issue: #346（実装）・#342（切り出し残余の併合）・#157（TASK-157、
  1200 年のボヘミア本体を見送った判断）。
