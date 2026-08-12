# 勢力ラベル外枠の描画方式（候補A 専用 SDF 設定 / 候補B 二重 TextLayer）の比較（Issue #322）

- 調査日: 2026-08-13
- 契機: Issue #322（#308 適用後も勢力ラベルの外枠が細く、共通 SDF 設定のまま
  `outlineWidth` を増やす方式では明確な太さにできない）
- 対象: `src/labels.ts` の SDF halo 設定 / `src/political_layers.ts`
  `buildLabelLayer`
- 使用ツール: ヘッドレス CDP ハーネス（`scripts/verify/cdp.ts`）+ ローカル
  dist（`deno task build` + 本番タイル `tiles.zeitreises.com/europe*.pmtiles`）
- 結論の反映先: `src/labels.ts` の `POLITICAL_LABEL_FONT_SETTINGS` /
  `POLITICAL_LABEL_OUTLINE_WIDTH`、比較画像は
  `docs/images/issue322-political-label-halo/`

## 1. 前提: deck.gl 9.3.7 の SDF halo が取れる幅の上限

`@deck.gl/layers` の実装（`text-layer.ts` / `multi-icon-layer/*`）より:

```
normalized    = outlineWidth / fontSettings.radius
outlineBuffer = max(smoothing, 0.75 * (1 - normalized))
atlasHaloPx   = (0.75 - outlineBuffer) * radius   // = 0.75 * outlineWidth（頭打ち前）
cssHaloPx     = atlasHaloPx * fontSize / 64
alpha         = smoothstep(outlineBuffer - gamma, outlineBuffer + gamma, sdf)  // gamma = smoothing
```

ここから 3 つの事実が出る。

1. **halo の太さは `radius` に依存しない**。アトラス上は `0.75 * outlineWidth`
   px で、`radius` が効くのは「`outlineBuffer` が `smoothing` 下限に張り付く
   まで、どこまで `outlineWidth` を上げられるか」だけ。
2. **上限は `(0.75 - smoothing) * radius`**。共通設定（smoothing 0.1 / radius
   12）では 7.8 atlas px = 14px ラベルで約 1.71 CSS px。#308 の
   `outlineWidth = 9`（実効 1.48 CSS px）は既にその近傍だった。
3. **`buffer` を超える halo はグリフ端でクリップされる**。共通設定の
   `buffer = 8` は `outlineWidth ≤ 10.67` 相当。

したがって Issue の指摘どおり、共通 SDF 設定のまま幅だけを変える案は成立しない。

また `radius` を上げる場合は `smoothing` を同じ比率で下げないと、アンチ
エイリアス幅（アトラス px 換算で `smoothing * radius`）が広がって halo の外縁が
ぼけ、太くしても輪郭が締まらない。共通設定のぼけ幅は `0.1 * 12 = 1.2` atlas px。

## 2. 候補B（二重 TextLayer）— 実画面で不採用

下層に濃焦茶の文字を大きめサイズで描き、上層に明色文字を重ねる案。試作
（`buildLabelUnderlayLayer` を追加し、下層サイズ = 上層 +3 / +4 / +5 px）を 1100
年 z5 で撮影して確認した。**2 つの構造的な欠陥が実画面に出た。**

1. **グリフの位置が合わない。** TextLayer は文字列を 1 文字ずつ配置し、字送りが
   `getSize` に比例する。下層を +4px にすると文字列全体が約 29% 長くなり、
   アンカー（文字列中央）以外の文字は左右へずれる。「神聖ローマ帝国」では
   下層の「神」が上層の左外に、下層の「国」が右外にはみ出して**二重像**になった。
   これは外枠ではなく「ずれた影」であり、サイズ差を詰めても外枠として必要な
   太さが出ない（太さとずれが同じパラメータで動く）。
2. **表示/非表示が同期しない。** 2 層を同じ衝突空間（CollisionFilterExtension
   の既定 collisionGroup）に置くと、同じアンカーの 2 つのラベルが互いに衝突して
   どちらかが消える。別 group に分けると衝突判定の入力が層ごとに変わり、
   実際に下層サイズ +5 では「フランケン公領」の下層だけが間引かれ、**上層の
   明色文字だけが外枠なしで残った**（試作の撮影で確認）。

副次的に、下層は上層と同じデータ・同じ更新トリガー・同じアンカー・同じ
`characterSet` を持つ 2 枚目の TextLayer なので、描画呼び出しとフォント
アトラスの参照が単純に倍になる。**利点（SDF 上限に依存しない）よりも、
文字形状の再現性と表示の一貫性を壊す代償の方が大きい**ため採らない。

## 3. 候補A（勢力ラベル専用 SDF 設定）— 採用

`fontSettings` を勢力ラベル層だけ差し替える。パラメータは上記の式から逆算し、
実画面で確認して決めた。

```ts
POLITICAL_LABEL_FONT_SETTINGS = {
  sdf: true,
  smoothing: 0.05,
  buffer: 11,
  radius: 24,
};
POLITICAL_LABEL_OUTLINE_WIDTH = 12;
```

- `radius: 24` … `outlineBuffer = 0.75 * (1 - 12/24) = 0.375` で smoothing
  （0.05）から十分離れ、頭打ちしない（限界は `outlineWidth = 22.4`）。
- `smoothing: 0.05` … `smoothing * radius = 1.2` atlas px で、共通設定の
  ぼけ幅と同一。字面の太さ・シャープさが変わらない。
- `buffer: 11` … halo 9 atlas px + ぼけの裾 1.2 atlas px = 10.2 を収める最小の
  整数。**12 以上にするとアトラス canvas の高さが 1024 → 2048 に跳ねる**
  （実測。グリフの升目が 1 行 1 文字減り、2 の冪への切り上げをまたぐ）。

### 実効 halo（CSS px）

| ラベルサイズ                       | 12px | 14px | 16px | 18px |
| ---------------------------------- | ---- | ---- | ---- | ---- |
| before（#308, width 9 + 共通設定） | 1.27 | 1.48 | 1.69 | 1.90 |
| after（#322, width 12 + 専用設定） | 1.69 | 1.97 | 2.25 | 2.53 |

### `outlineWidth` の上下限（実画面での確認）

| 値                   | 14px 実効 | 所見                                                                |
| -------------------- | --------- | ------------------------------------------------------------------- |
| 9（共通設定 = #308） | 1.48      | 細い。Issue の報告どおり                                            |
| 11                   | 1.80      | 明確に太いが、18px（z4）ではまだ物足りない                          |
| **12（採用）**       | **1.97**  | 全サイズで外枠として読め、12px の CJK もカウンターが残る            |
| 13                   | 2.13      | 12px の「院」「領」のカウンターが埋まり始める                       |
| 14                   | 2.30      | z7 の 12px ラベル（「オットーボイレン帝国修道院領」等）がベタ矩形化 |
| 16                   | 2.63      | 16px でも隣接グリフの halo が完全に繋がり、暗い板になる             |

### コスト実測（1600x900 / DPR 1、1100 年 z5、同一ビルドを URL クエリで切替）

| 指標                                     | before（共通設定）           | after（専用設定）                              |
| ---------------------------------------- | ---------------------------- | ---------------------------------------------- |
| フォントアトラス canvas                  | 1024x1024（共通 1 枚）       | 1024x1024（共通）+ 1024x1024（勢力ラベル専用） |
| アトラス由来のメモリ                     | 約 4.2 MB                    | 約 8.4 MB（+4.2 MB）                           |
| 初回ロードの long task 合計              | 664–684 ms（5 回）           | 682–702 ms（5 回。+2%）                        |
| 年代切替（1100 → 1300）の long task 合計 | 464–538 ms                   | 462–498 ms（差なし）                           |
| 定常フレーム間隔                         | 中央値 16.7 ms / p90 16.7 ms | 中央値 16.7 ms / p90 16.7 ms                   |
| appReady までの実測                      | 751–891 ms                   | 720–897 ms                                     |

計測は dist の `index.html` に使い捨ての計測スクリプト（`document.createElement`
を包んで `willReadFrequently` 付き canvas を数える / `PerformanceObserver` の
`longtask` を積む / `requestAnimationFrame` の間隔を 120
フレーム採る）を注入して 行った。`buffer` を 12 以上にすると専用アトラスが
1024x2048 になり、メモリ増が +8.4 MB
になることも同じ手順で確認している（`buffer: 11` を選んだ理由）。

## 4. 変えなかったもの

- 都市・河川・山岳・山峰の共通クリーム halo（`LABEL_OUTLINE_WIDTH = 5` /
  `LABEL_OUTLINE_COLOR` / `LABEL_FONT_SETTINGS`）は不変。これらの層は従来どおり
  共通アトラスを共有する（`src/feature_layers_test.ts` の非退行テストで固定）。
- 背景パネル（TASK-54 で入れて TASK-72 で撤去したもの）は再導入しない。
  `labelTextStyleProps().background` は `false` のまま。
- 衝突制御・優先度・サイズ階層・強調時の文字色（#267 / #228 / TASK-93）は不変。
