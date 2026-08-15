---
status: accepted
date: '2026-08-15'
---

# decision-42: 差し引く geometry は描画する geometry と同一にし、塗り専用生成物は細片を捨てない

## Context

base 塗り（`data/europe_flat_<year>.geojson`）と領邦オーバーレイ
（`data/<region>_fiefs_flat_<year>.geojson`）の間に幅 100 m 級の未塗装の筋が残って
いた（Issue #390）。

起票時は「base と領邦がファイル単位で独立に simplify トレランスを選ぶため」と
されていたが、実測の結果これは成立しない。`shrinkToLimit` は上限以下になる最初＝
**最小**のトレランスを返し、全パイプライン・全年代で 0.005 が選ばれている。
同様に「base と領邦が境界を共有するすべての箇所に潜在する」という描像も不正確で、
`europe_flat` の穴の縁は `build-fief-dedupe` の `difference` が作るため、**単に
境界を共有するだけの箇所では原理的にズレは生じない**。

未塗装が生じる経路は次の 2 つだけである。

- **(a)** `europe_flat` = base − union(領邦) の union 入力が **raw**
  （`hre_fiefs_<year>` 等）なのに、画面に描かれるのは **flat**
  （`hre_fiefs_flat_<year>`）。`build-fief-flat.ts` が重なり解消・
  `dropCompositeParents`・`dropDetachedRemainders`・`removePinchPoints` を適用する
  ため flat は raw より小さくなりうる。その差が未塗装になる
- **(b)** 差し引いた残りに生じる細片を `cleanFeatureCollection` が閾値未満
  （`MIN_PART_AREA_M2` = 1 km² / `MIN_PART_MEAN_WIDTH_M` = 111.32 m）として捨てる

(a) については #376 が 1200 年 Cliopatria だけを flat に切り替える例外で凌いでいた。
(b) の細片は `BASE_FIEF_SPLITS` の切り出し由来のものが目立つが、1400 年は
`BASE_FIEF_SPLITS` が 1 件も無いのに 6.7 km² あり、実際には「オーバーレイの縁が
base ポリゴンを浅い角度で切ると細片ができる」という一般形である。

## Decision

### 1. 差し引く geometry は、描画する geometry と同一にする

`build-fief-dedupe` が base から差し引く領邦は、**画面に描かれるのと同じ flat 生成物**
とする（`borrowed_<系統>_flat_` を含む全系統）。#376 の Cliopatria 限定の例外を
一般規則へ昇格させ、raw を参照するパスヘルパは削除する。

「raw と flat で union は変わらない」という暗黙の前提は、`build-fief-flat` が形を
落とす年で崩れる。**新しいオーバーレイ系統を追加するときも、差し引き側は必ず
flat を使うこと。**

### 2. 塗り専用の生成物は細片を捨てず、隣接へ併合するか保持する

`europe_flat_<year>` は**塗り専用**であり、ラベル・picking・extent はいずれも
`europe_<year>` を読む。したがって `europe_flat` から細片を落とすことは、そのまま
**画面に穴を開けること**と同義である。

`cleanFeatureCollection` の既定閾値（1 km² / 平均幅 111.32 m）は、`europe_<year>` で
幅 100 m の勢力 feature が生き残って幻のラベルを出すのを防ぐためのものであり
（TASK-81）、塗り専用の生成物には当てはまらない。そこで `europe_flat` の生成では:

- 細片を **境界を最も長く共有する隣接 feature へ併合**する（#342 の
  `sharedBoundaryLength` の規則を流用。取り除いた元の feature も候補に含めるので、
  自分の本体に接する細片は元へ戻る）
- **隣接が無い細片は元の feature のパートとして保持**する。実測ではこちらが支配的で、
  多くの残片は継ぎ目の一致しない 2 つのオーバーレイに挟まれた base の島であり、
  接する base feature が存在しない。落とすと (a) の修正だけではほぼ無意味になる
  （1300 年 10.0 km² / 1400 年 8.9 km² が残ったまま）
- 面積がゼロになった feature だけを落とす。幅 100 m の幻の feature は残さない
- clean の閾値は `europe_flat` 専用に 1 m² / 平均幅 0 とする。自己交差の解消と穴の
  閾値は従来どおり適用する

**単に clean を外す案は採らない。** 幅 100 m の "Moravia" が feature として復活し、
TASK-81 が防いだ幻のラベルが戻る。

### 3. 塗り専用生成物のサイズ上限は、細片を捨てる理由にしない

`BASE_FILL_SIZE_LIMIT_BYTES` を 320 KB → 360 KB へ引き上げた（1783 年が
341,054 B になるため）。増分はそのまま「これまで誰も塗っていなかった面」に対応
する（1783 年で 370 件 / 86 km²、+12.4%。gzip 後 103 KB）。勢力の外周は 1 頂点も
動いていない。

**上限に当たったとき、細片を捨てて容量を作ってはならない**（それは本 ADR が塞いだ
欠陥そのものを戻す）。上限を上げる前に、まず**細片が増える原因＝オーバーレイ側の
継ぎ目**（`build-fief-flat` の `resolveOverlaps`）を疑うこと。

## Consequences

- 12–19 / 48–51.5 の未被覆は 1100 年 4.147 → 1.741、1200 年 1.386 → 0.817、
  1300 年 11.312 → 0.805、1400 年 10.418 → 2.293 km²。報告事例の bbox は
  0.6343 km²・平均幅 102 m → 0.0731 km²・平均幅 17 m
- 残差 17 m は機構の欠陥ではなく `COORD_PRECISION = 3` への丸めの帰結である
  （`difference` が置いた交点頂点が弦から 33 m ずれる。丸めなしで測ると
  0.0000 km²）。これ以上詰めるには配信座標の精度そのものを変える必要がある
- `europe_flat_1783` のパートが 341 → 808 に増えるが、ヘッドレス検証で視覚的
  ノイズにならないことを確認済み（新規露出 31 px・最大成分 4 px、版図の欠落や
  同色パート間のヘアラインクラックは観測されず）
- `data/europe_<year>.geojson`（base）は不変。`deno task build-fief-dedupe` のみで
  再生成でき、ネットワーク再取得は要らない
- 検査は `scripts/unpainted_gaps.ts` の `unpaintedGapsIn` に集約した。上記 (a)(b) の
  2 経路を対象にすればよく、全境界の網羅走査は原理的に不要である
- **疑ったが否定された仮説**: 「`fiefUnionOf` が全領邦を一度に union するため、
  頂点数が多いと polyclip が微小片を吸収して外周が内側へ寄る」。全 19 年・全欧で
  union と個別ファイルの結果が小数 4 桁まで一致し（約 12,000,000 km² に対し差
  0.0000 km²）、寄与は無い。`union(...) ?? merged` の暗黙 drop も発火 0 回だったが、
  黙って落とすと二重塗りになるため警告を出す形にした
