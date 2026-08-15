/**
 * 羊皮紙トーンの色定数（TASK-73）。DOM・npm 非依存の純粋モジュール。
 *
 * 元は src/basemap.ts に置いていたが、同ファイルは `@protomaps/basemaps` を
 * import するため、データ生成スクリプト（scripts/build-colors.ts）から陸地色を
 * 引くと生成系に npm 依存が乗ってしまう（Issue #385）。色の**値そのもの**だけを
 * ここへ切り出し、basemap.ts は re-export して従来どおりの参照点を保つ。
 *
 * これにより「羊皮紙の陸地色」の定義は本ファイルの 1 箇所だけになり、
 * ランタイム（src/）とパレット生成（scripts/）が同じ値を共有する。
 */

/**
 * 自然被覆（landcover）の羊皮紙トーン（TASK-73）。
 *
 * light flavor の landcover は彩度の高い緑（forest rgba(196,231,210)、
 * grassland rgba(210,239,207) 等）で、羊皮紙の下地に載せると「現代の
 * 植生図」に見えてしまう。古地図の顔料（黄土・オリーブ）に寄せるため、
 * 色相を緑〜黄緑から黄土へ振り、彩度を大きく落とす。被覆種別の識別は
 * 明度差（forest が最も暗く、barren が最も明るい）で残す。
 *
 * なお landcover は fill-opacity が z5→z7 で 1→0 に落ちるため、この色が
 * 効くのは広域表示（ヨーロッパ全体〜地方）に限られる。
 */
export const PARCHMENT_LANDCOVER_COLORS = {
  // 森林: 最も暗いオリーブ（古地図の緑顔料の退色を想定）
  forest: "rgba(196, 188, 145, 1)",
  // 草地・農地: 森林よりやや明るい黄土オリーブ
  grassland: "rgba(214, 203, 160, 1)",
  farmland: "rgba(219, 209, 168, 1)",
  scrub: "rgba(223, 213, 174, 1)",
  // 荒地: 砂地（sand）に近い明るい黄土
  barren: "rgba(234, 223, 193, 1)",
  // 市街地: 彩度をほぼ落とした灰褐色（現代的な要素なので目立たせない）
  urban_area: "rgba(221, 209, 181, 1)",
  // 氷河: 羊皮紙の最も明るい部分（純白にはしない）
  glacier: "rgba(244, 239, 226, 1)",
} as const satisfies Record<string, string>;

/**
 * ベースマップ（protomaps light flavor）への羊皮紙トーン上書き（TASK-73）。
 *
 * 地図外 UI（app.css の --parchment #f4ecd7 / --parchment-shade #e7d9b2 /
 * --ink #3a2712 / --frame #5c3d22、TASK-40）に対し、地図本体が light flavor の
 * まま（海 #80deea のシアン、背景 #cccccc のグレー）だったため配色が乖離して
 * いた。地図外 UI と同じ羊皮紙系のパレットへ揃える。
 *
 * 各値の根拠:
 * - background #e7d9b2: --parchment-shade と同値。タイル未読込領域と UI の
 *   縁が同色になり、地図の「紙」が画面外まで続いて見える。
 * - earth #f0e6cd: --parchment (#f4ecd7) をわずかに沈めた値。ラベルの
 *   クリーム halo（labels.ts LABEL_OUTLINE_COLOR = rgb(244,236,215)、TASK-72）
 *   より暗いため、halo が下地に完全に溶けず、かつ同系色で浮かない。
 * - water #c7d2d0: くすんだ青灰。陸（暖色）との明度・色相差で海岸線は明確に
 *   読めるが、彩度は勢力ポリゴンの塗り（colors.json 由来）より十分低く、
 *   海が主張して勢力の色分けを邪魔しない。
 * - glacier #f4efe2 / sand #e8dcc0 / beach #ece0c4: 陸地と同系の羊皮紙階調。
 */
export const PARCHMENT_FLAVOR_OVERRIDES = {
  background: "#e7d9b2",
  earth: "#f0e6cd",
  water: "#c7d2d0",
  glacier: "#f4efe2",
  sand: "#e8dcc0",
  beach: "#ece0c4",
} as const satisfies Record<string, string>;
