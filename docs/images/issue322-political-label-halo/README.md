# #322 勢力ラベル外枠の before / after 比較画像

Issue #322（「勢力ラベルの外枠が #308 適用後も細く、SDF 共有設定では明確な
太さにできない」）の完了判定を第三者が再確認できるようにするための証跡。 #308
では PR 本文にしか画像を残さず、リポジトリ側に何も残らなかった（Issue #322
の指摘）ため、ここに縮小 JPEG でコミットする。

- **before** = #308 適用後（共通 SDF 設定 +
  `POLITICAL_LABEL_OUTLINE_WIDTH = 9`。 14px ラベルで実効 halo 約 1.48 CSS px）
- **after** = #322（勢力ラベル専用 SDF 設定
  `POLITICAL_LABEL_FONT_SETTINGS = { smoothing: 0.05, buffer: 11, radius: 24 }`
  \+ `POLITICAL_LABEL_OUTLINE_WIDTH = 12`。14px ラベルで実効 halo 約 1.97 CSS
  px）

各画像は上段 before / 下段 after を縦に並べたもので、**地図部分は等倍 （1
デバイスピクセル = 1 画像ピクセル）**。同一 URL・同一ビューポートで
撮っているので、同じ位置の同じラベルを直接見比べられる。

## ファイル

| ファイル                                  | 内容                                                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cmp-z{4,5,7}-y{1000,1100,1300}-dpr1.jpg` | z4 / z5 / z7 × 1000 / 1100 / 1300 年、DPR 1（1600x900）。z4（overview）は top 18px、z5 / z7 は top 16px・constituent 14px・sub 12px の勢力ラベルを含む |
| `cmp-z5-y1100-dpr2.jpg`                   | 同じ画面の DPR 2（`--force-device-scale-factor=2`。実デバイスピクセルで等倍）                                                                          |
| `cmp-states-z5-y1100-dpr1.jpg`            | after の通常時 / ホバー時 / 選択時（強調中は文字が純白へ。外枠は同じ濃焦茶）                                                                           |
| `cmp-latin-z5-y1100-dpr1.jpg`             | 欧文ラベルの before / after。現行データでは全勢力名に日本語表記があるため、`name-ja.json` を空にして英語名へフォールバックさせて撮影した               |
| `cmp-zoom3x-z5-y1100-dpr1.jpg`            | z5 の一部を 3 倍（nearest）に拡大したもの。外枠の太さの差とカウンター（「国」「領」の内側の空き）が潰れていないことを見るため                          |

`cmp-latin-*` では都市名「Cologne」（暗色文字 + 共通クリーム halo）が before /
after で変化していないことも確認できる — #322 は勢力ラベルだけを
変更し、都市・河川・山岳の共通 halo には触れていない。

## 再生成

```fish
# 1) 地色を本番と揃えるためタイルを取得してから dist を作る
deno task build
curl -sS -o dist/europe.pmtiles https://tiles.zeitreises.com/europe.pmtiles
curl -sS -o dist/europe-dem.pmtiles https://tiles.zeitreises.com/europe-dem.pmtiles
deno task serve --port 8322

# 2) 各ビューを撮る（DPR 2 は --device=desktop-hidpi。#320 の
#    --force-device-scale-factor 経路が無いとラベルが 1 つも描画されない）
deno run -A scripts/verify/cdp.ts "http://localhost:8322/?year=1100&zoom=5.0&center=10.0,49.5" <撮影スクリプト>
deno run -A scripts/verify/cdp.ts --device=desktop-hidpi "http://localhost:8322/?..." <撮影スクリプト>
```

撮影スクリプトは `?year=<Y>&zoom=<Z>&center=<lon>,<lat>` へ navigate →
`waitForAppReady` → `window.__getYear() === <Y>` を waitFor → `api.screenshot()`
を回すだけの使い捨てハーネス（`CdpApi` の `navigate` / `waitFor` / `hover` /
`click` / `screenshot` のみを使う）。 before 側は `src/labels.ts` の
`POLITICAL_LABEL_OUTLINE_WIDTH` / `POLITICAL_LABEL_FONT_SETTINGS` を #322
以前へ戻して再ビルドすれば得られる。
