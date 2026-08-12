# #333 政治ラベルの参考画像（案A）と reference / before / after 比較

Issue #333（「修正 issue を何度積んでも参考画像のような国名ラベルにならない」）
の完了判定を第三者が再確認できるようにするための証跡。

**この Issue の要点は「参考画像そのものを固定比較の対象に据える」こと**である。
#267 は参考画像を「表示階層の参考」へ弱め、#308 は「1.2px 以上」、#322 は 「#308
の 1.3 倍」「1.6〜2.6px」を合格基準にした。いずれも**参考画像との一致を
基準にしていない**。ここには参考画像そのものと、reference / #322 before / after
を同じ倍率で並べた比較画像を置く。

## 参考画像（規範）

`reference-plan-a.png`（1412x1114 PNG、無劣化）は #228 で導入され #267 / #333
が参照している案A「境界の階層化（ラベル完成見本）」。原本は GitHub の 添付
URL（`user-attachments/assets/8025deec-f2ae-45e0-9195-cdc21994e5cc`）
だが、Issue の添付だけに置いておくと本文からしか辿れず、実装値の根拠として
参照できない（#204 と同じ失敗）。**この PNG がラベル外観の規範**で、地名・
領土形状・地図配色の再現は求めない（#333 スコープ外）。

この画像から読み取った目標値と、それを実装値へ落とした過程は
[`docs/research/issue-333-label-reference-targets.md`](../../research/issue-333-label-reference-targets.md)
にある（測定スクリプトと生の数値つき）。

## 比較画像

| ファイル                                                                                       | 内容                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cmp-labels-x4.png`                                                                            | **AC1 / AC11 の中心**。reference / #322 before / after の同一倍率（x4 nearest）比較。上から参考画像の「神聖ローマ帝国」「ノルマンディー公領」、#322 本番相当、本修正後                                                     |
| `cmp-z4-y1100-dpr1.jpg` / `cmp-z5-y{1000,1100,1300}-dpr1.jpg` / `cmp-z7-y{1100,1300}-dpr1.jpg` | 上段 #322 before / 下段 after のフルビュー（1600x757、等倍）。z4 = top 18px、z5 / z7 = top 16px・constituent 14px。`cmp-z7-y1300` は #322 が「カウンターが潰れる」上限の根拠に挙げた「オットーボイレン帝国修道院領」を含む |
| `cmp-z{4,5,7}-y1100-dpr2.jpg`                                                                  | 同じ画面の DPR 2（`--device=desktop-hidpi`）。中央 1600x800 をデバイスピクセル等倍で切り出したもの（AC6）                                                                                                                  |
| `cmp-states-z5-y1100-dpr1.jpg`                                                                 | after の通常 / ホバー / 選択 / 選択解除（ボヘミア公領。強調中は文字が純白へ、プレートと外縁は不変。解除で通常表示へ戻る。AC7）                                                                                             |

`cmp-labels-x4.png` で一目で分かるのが #322 が参考画像から外れていた点である。

- 参考画像: **細い濃色外縁（1.0〜1.5 CSS px）＋ 文字列単位の濃色プレート**
  （角丸・クリーム 1px 縁・alpha 約 0.22）
- #322 before: **太い濃色外縁（14px ラベルで 1.97 CSS
  px）のみ**。プレートが無く、
  外縁だけで地色から分離しようとした結果、隣接グリフの halo が繋がって
  「暗い板」に近づいている（#322 自身が不採用理由に挙げた見た目に、外縁側で
  近づいてしまっていた）
- after: 参考画像と同じ「細い外縁 + プレート」

## 再生成

```fish
# 1) 地色を本番と揃えるためタイルを取得してから dist を作る
deno task build
curl -sS -o dist/europe.pmtiles https://tiles.zeitreises.com/europe.pmtiles
curl -sS -o dist/europe-dem.pmtiles https://tiles.zeitreises.com/europe-dem.pmtiles
deno task serve --port 8333

# 2) 各ビューを撮る（DPR 2 は --device=desktop-hidpi。#320 の
#    --force-device-scale-factor 経路が無いとラベルが 1 つも描画されない）
deno run -A scripts/verify/cdp.ts "http://localhost:8333/?year=1100&zoom=5&center=10.0,49.5" <撮影スクリプト>
deno run -A scripts/verify/cdp.ts --device=desktop-hidpi "http://localhost:8333/?..." <撮影スクリプト>
```

撮影スクリプトは `?year=<Y>&zoom=<Z>&center=<lon>,<lat>` へ navigate →
`waitForAppReady` → `window.__getYear() === <Y>` を waitFor → 3 秒待って
`api.screenshot()` を回すだけの使い捨てハーネス。撮影に使ったビューは z4 =
`8.0,48.0` / z5 = `10.0,49.5` / z7 = `10.5,48.5`。

**before 側の再現**は `src/labels.ts` の `POLITICAL_LABEL_STYLES` を #322 相当
（両グループとも `outlineWidth: 12` / `plateColor: [0,0,0,1]` /
`plateBorderWidthPx: 0` / `platePadding: [0,0,0,0]` /
`plateBorderRadiusPx: 0`）へ差し替えて再ビルドすれば得られる。この差し替えは
**#333 で追加した固定標本テスト 7 件を red
にする**（`deno test
src/labels_test.ts src/political_layers_test.ts` → 125
passed / 7 failed）ので、 「before
に戻すとテストが落ちる」ことも同時に確認できる。
