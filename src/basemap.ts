/**
 * ベースマップスタイルの組み立て（DOM 非依存の純粋ロジック）。
 *
 * 歴史地図の下地として「地形・海岸線」だけを描画し、現代の
 * 国境・地名・道路等はスタイル定義の段階で除外する（docs/app-spec.md §2.2）。
 *
 * Natural Earth 主要河川オーバーレイ（TASK-21）は、クリック/ホバー可能に
 * するため TASK-24 で deck.gl の GeoJsonLayer（src/rivers.ts + main.ts）へ
 * 移行した。ここでは MapLibre style に rivers ソース/レイヤーを含めない。
 * さらに TASK-44 でベースマップ側の川ライン（water_river / water_stream）も
 * 除外し、河川の見た目とクリック対象を deck オーバーレイへ一本化した。
 */

import { type Flavor, layers, namedFlavor } from "@protomaps/basemaps";
import { BASEMAP_SOURCE_ID, DEM_PMTILES_URL, DEM_SOURCE_ID } from "./config.ts";

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

/**
 * light flavor に羊皮紙トーンの上書きを適用した flavor を返す純粋関数
 * （TASK-73）。namedFlavor("light") の戻り値は呼び出しごとの新しいオブジェクト
 * だが、破壊的変更を避けるため常に新オブジェクトへ spread して返す。
 * 採用しないレイヤー（道路・建物・POI 等、BASEMAP_LAYER_IDS 外）の色は
 * light flavor のまま残す（filterBasemapLayers で捨てられるため無害）。
 */
export function parchmentFlavor(): Flavor {
  return {
    ...namedFlavor("light"),
    ...PARCHMENT_FLAVOR_OVERRIDES,
    landcover: { ...PARCHMENT_LANDCOVER_COLORS },
  };
}

/**
 * @protomaps/basemaps ^5.7.2 の nolabels_layers()（src/base_layers.ts）に
 * 実在するレイヤー id のうち、採用するもの。
 *
 * 採用（地形・海岸線に相当）:
 * - background:   下地色
 * - earth:        陸地ポリゴン（海との境界 = 海岸線の描画を担う）
 * - landcover:    森林・草地・氷河など自然被覆（地形の表現）
 * - water:        海洋・湖沼ポリゴン
 *
 * 除外（河川ライン。TASK-44）:
 * - water_river / water_stream: ベースマップの川ラインは deck.gl の pickable
 *   河川（NE50m, src/rivers.ts）と経路が乖離し、クリックできないデコイに
 *   なるため採用しない。河川表示は deck オーバーレイへ一本化する。
 *
 * 除外（現代の情報が歴史地図に透けるため）:
 * - boundaries / boundaries_country: 現代の国境・行政境界
 * - roads_*:                         道路・鉄道・滑走路など
 * - landuse_*:                       公園・病院・工業地など現代の土地利用
 * - buildings:                       建物
 * - ラベル系（places_* / *_label* / pois / roads_shields 等）はそもそも
 *   layers() を lang なしで呼ぶことで生成しない（labels_layers() を使わない）
 */
/**
 * 海洋・湖沼ポリゴンのレイヤー ID（@protomaps/basemaps の base_layers.ts 由来）。
 * TASK-77: 勢力・諸侯領ポリゴンをこのレイヤーより下へ差し込む（deck.gl の
 * beforeId）ため、id を定数として公開する。スタイル側の実在は
 * basemap_test.ts / underwater_test.ts が実レイヤー定義に対して検証する。
 */
export const WATER_LAYER_ID = "water";

export const BASEMAP_LAYER_IDS: readonly string[] = [
  "background",
  "earth",
  "landcover",
  WATER_LAYER_ID,
];

/**
 * 内水面（湖・川・運河・貯水池など）だけを描く水面レイヤーの ID（TASK-84）。
 *
 * TASK-77 で政治ポリゴンを water の下へ回した結果、海上のはみ出しは隠れたが
 * 同時に内陸の水面ポリゴンまで政治ポリゴンの塗りの上に来てしまい、塗りが
 * 虫食い状に抜けた（ジロンド川筋・ランド地方の湖沼で顕著）。海のはみ出しを
 * 隠すのに必要なのは「海岸より外の水面」だけなので、water を kind で 2 つに
 * 分割し、内水面だけを政治ポリゴンより下（= このレイヤー）へ下げる。
 * 塗り色・ソースは分割前の water と同一で、重ね順以外は何も変えない。
 */
export const WATER_INLAND_LAYER_ID = "water-inland";

/**
 * 沿岸補完（政治ポリゴンの塗りを現代海岸線まで届かせる帯）レイヤーの ID
 * （Issue #305）。
 *
 * レイヤー実体は MapLibre の line レイヤーで、追加・データ同期は
 * coastal_fill_sync.ts が行う（概略境界 approximate_border_sync.ts と同型）。
 * 挿入位置は内水面（WATER_INLAND_LAYER_ID）の直下 =「沿岸補完 → 内水面 →
 * 政治ポリゴン → 概略境界 → 海洋 → 海岸線」で、帯の海側は海洋 water が、
 * 湖・内水面にかかる部分は water-inland が覆う。ID をここ（basemap.ts）に
 * 置くのは、hillshadeBeforeId が遅延追加の挿入位置としてこの ID を参照する
 * ため（coastal_fill.ts に置くと相互 import になる）。
 */
export const COASTAL_FILL_LAYER_ID = "coastal-fill";

/**
 * 陸の輪郭（海岸線）を描くレイヤーの ID（TASK-84）。
 *
 * 政治ポリゴン（historical-basemaps 等）の海岸線は現代のベースマップより粗く、
 * 輪郭線の総延長のおよそ 2〜3 割が海側へはみ出す（仏大西洋・海峡沿岸で実測:
 * 諸侯領 32.9%・base 26.4%。海への浮き幅は中央値 1〜6 km、p90 で 5〜11 km、
 * 最大 26 km）。この線を水面より上に戻すと「海の上を走る間違った海岸線」に
 * なるため、政治ポリゴンは水面下に置いたまま、陸の輪郭はベースマップ自身の
 * 陸ポリゴン（earth）の縁として描く。水面（water）と同じタイルから引くので、
 * 塗りが切れる位置と線の位置が定義上一致する（別ソースの海岸線を重ねたときの
 * 二重線が原理的に起きない）。
 */
export const COASTLINE_LAYER_ID = "coastline";

/**
 * 政治ポリゴンより下へ下げる水面の kind（TASK-84）。
 *
 * Protomaps basemap schema の water.kind のうち内陸の水域。ここに載っていない
 * kind（ocean / sea / bay / strait / fjord / dock / reef、および将来スキーマが
 * 増やす未知の値）は従来どおり政治ポリゴンより上に残す。判定を「内水面の
 * 許可リスト」にしてあるのは、取りこぼしが必ず安全側（海のはみ出しを隠す
 * 従来挙動）に倒れるようにするため。
 *
 * 河口（ジロンド）や潟湖（アルカション湾）は OSM の海岸線の外側にあり
 * kind: ocean なので内水面には含まれない。これらは水面のまま残るが、
 * COASTLINE_LAYER_ID の線が縁を描くため「塗りの虫食い」ではなく入り江として
 * 読める（TASK-84 の実機確認で確認）。
 */
export const INLAND_WATER_KINDS: readonly string[] = [
  "lake",
  "water",
  "river",
  "stream",
  "canal",
  "ditch",
  "drain",
  "reservoir",
  "basin",
  "playa",
  "pond",
  "swimming_pool",
];

/** kind が海洋側（政治ポリゴンより上に残す水面）かを返す純粋関数（TASK-84） */
export function waterKindIsMarine(kind: string): boolean {
  return !INLAND_WATER_KINDS.includes(kind);
}

/**
 * 海岸線の色（TASK-84）。境界線と同じインク（--frame #5c3d22 = powers.ts の
 * LINE_COLOR と同値）を alpha 0.6 まで落としたもの。古地図のペン画に揃えつつ、
 * 政治境界線（同色 alpha 0.75・1px）より一段弱くすることで「地形の線」と
 * 「政治の線」を濃さで読み分けられるようにする。
 */
export const COASTLINE_COLOR = "rgba(92, 61, 34, 0.6)";

/** 海岸線レイヤー定義（TASK-84）。earth は島名の Point も含むためポリゴンに絞る */
const COASTLINE_LAYER: BasemapStyle["layers"][number] = {
  id: COASTLINE_LAYER_ID,
  type: "line",
  source: BASEMAP_SOURCE_ID,
  "source-layer": "earth",
  filter: ["==", ["geometry-type"], "Polygon"],
  paint: {
    "line-color": COASTLINE_COLOR,
    // 広域では細く（線が主張して塗り分けを邪魔しない）、詰めると少し太く
    "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.8, 7, 1, 10, 1.4],
  },
};

const KEEP_IDS: ReadonlySet<string> = new Set(BASEMAP_LAYER_IDS);

/** レイヤー定義から採用レイヤーのみを残す純粋関数（id の完全一致で判定） */
export function filterBasemapLayers<T extends { id: string }>(
  layerList: readonly T[],
): T[] {
  return layerList.filter((layer) => KEEP_IDS.has(layer.id));
}

/** ベクタタイルソースの最小型（MapLibre VectorSourceSpecification 互換） */
export interface BasemapVectorSource {
  type: "vector";
  url: string;
  attribution?: string;
}

/**
 * 地形 DEM ソースの最小型（MapLibre RasterDEMSourceSpecification 互換）。
 * TASK-34: terrarium エンコーディングの PMTiles を hillshade の入力にする。
 */
export interface BasemapRasterDemSource {
  type: "raster-dem";
  url: string;
  encoding: "terrarium";
  tileSize: number;
  attribution?: string;
}

/** スタイルに現れうるソースの合併型 */
export type BasemapSource = BasemapVectorSource | BasemapRasterDemSource;

/** buildBasemapStyle が返すスタイルの最小型（MapLibre StyleSpecification 互換） */
export interface BasemapStyle {
  version: 8;
  sources: {
    [id: string]: BasemapSource;
  };
  layers: Array<{ id: string; type: string; [key: string]: unknown }>;
}

/** 地形陰影（hillshade）レイヤーの ID（TASK-34） */
export const HILLSHADE_LAYER_ID = "hillshade";

/**
 * hillshade を有効にするビューポート短辺の下限（CSS px）（TASK-133）。
 *
 * 768 は iPad 縦持ちの論理幅（768/810/834pt 系の下端）で、一般的な
 * 「タブレット以上」のブレークポイント。これ未満の短辺はスマートフォン
 * 相当（TASK-131 の MOBILE_PRESET は 375x812 で短辺 375）とみなす。
 * 小画面では hillshade の判読寄与が小さい割に、DEM タイル（terrarium
 * 256px raster）のテクスチャが GPU メモリと帯域を消費し、deck.gl の
 * ポリゴン・ラベルと合わせた描画負荷を押し上げるため、閾値未満では
 * hillshade を含めない。
 */
export const HILLSHADE_MIN_SHORT_SIDE_PX = 768;

/**
 * hillshade 有効判定の入力（TASK-133）。いずれもブラウザで実測できる値:
 * - viewportWidthPx / viewportHeightPx: globalThis.innerWidth / innerHeight
 * - maxTouchPoints: navigator.maxTouchPoints（取得不能なら 0 を渡す）
 */
export interface HillshadeDeviceInput {
  /** ビューポート幅（CSS px） */
  viewportWidthPx: number;
  /** ビューポート高さ（CSS px） */
  viewportHeightPx: number;
  /** タッチ接点数（0 = タッチ非対応 = デスクトップとみなす） */
  maxTouchPoints: number;
}

/**
 * 端末条件から DEM hillshade を有効にすべきかを返す純粋関数（TASK-133）。
 *
 * 判定基準: 「タッチ対応端末（maxTouchPoints > 0）かつビューポート短辺が
 * {@linkcode HILLSHADE_MIN_SHORT_SIDE_PX} 未満」のときだけ無効。それ以外は
 * 従来どおり有効（AC #4: デスクトップ既定 1600x900 は不変）。
 *
 * 各入力の選定根拠:
 * - ビューポート短辺: 「表示が小さく起伏表現の判読寄与が小さい」ことの直接の
 *   指標。min(width, height) で判定するため、画面回転（縦持ち/横持ち）で
 *   有効/無効が反転しない。
 * - maxTouchPoints: 小画面条件だけだと、デスクトップでウィンドウを小さく
 *   リサイズした場合まで hillshade が消えてしまう。タッチ入力の有無を掛け
 *   合わせることで、無効化の対象を実際のモバイル端末（GPU メモリ・帯域の
 *   制約が動機。TASK-131 の MOBILE_PRESET は touch 有効）に限定する。
 * - navigator.deviceMemory は採用しない: Chrome 系限定（Safari/Firefox は
 *   undefined）かつ 8GB で上限クランプされる近似値のため、同一端末でも
 *   ブラウザによって判定が変わり、決定的な基準にならない。
 *
 * 判定はアプリ起動時に 1 度だけ行う想定（スタイルの組み立て・PMTiles
 * アーカイブ登録の入力になるため）。短辺基準は回転で不変なので、起動後の
 * 端末回転で判定が陳腐化することもない。
 */
export function shouldEnableHillshade(input: HillshadeDeviceInput): boolean {
  const shortSidePx = Math.min(input.viewportWidthPx, input.viewportHeightPx);
  const isTouchDevice = input.maxTouchPoints > 0;
  return !(isTouchDevice && shortSidePx < HILLSHADE_MIN_SHORT_SIDE_PX);
}

/**
 * hillshade-exaggeration のズーム停止点（TASK-98）。`[zoom, exaggeration]`。
 *
 * 広域（z4 前後）は勢力ポリゴンの塗り越しに山脈の骨格を読ませたいので強く、
 * 拡大側は DEM（terrarium・256px）の粒状ノイズが平野でも目立つので弱める。
 * 実機比較（アルプス z5/z7・ジロンド z8・アルプス z11）でこの傾斜に決めた。
 */
export const HILLSHADE_EXAGGERATION_STOPS: ReadonlyArray<
  readonly [number, number]
> = [
  [4, 1],
  [8, 0.85],
  [11, 0.55],
];

/**
 * hillshade レイヤー定義（TASK-34）。
 *
 * paint 値の根拠（TASK-98 で TASK-34 の控えめな値から引き上げた）:
 * - exaggeration: {@linkcode HILLSHADE_EXAGGERATION_STOPS} の zoom 補間。
 *   TASK-34 は一律 0.4 だったが、hillshade の上に勢力ポリゴン（alpha 128）が
 *   重なるため塗りの下では起伏がほぼ読めなかった。広域を 1.0 まで上げ、
 *   拡大側は 0.55 まで落とす。
 * - shadow-color: 半透明の暖色グレー alpha 0.65。不透明黒（既定 #000）だと
 *   山岳が黒潰れして勢力色が沈むため、半透明は維持する。
 * - highlight-color: 半透明白 alpha 0.45。稜線の向きを読ませる側の手掛かり。
 * - accent-color: 影と同系の暖色グレー alpha 0.3。急斜面の輪郭を締める。
 *
 * 政治ポリゴンの色分け（AC #2）とラベル判読（AC #3）が保たれる根拠:
 * 塗りも陰影もいずれも半透明で、陰影は同じ勢力の面全体を一様に暗くするのでは
 * なく斜面ごとに明暗を付けるため、面の色相は保たれる。ラベルはクリーム halo
 * （TASK-72）が文字の周囲に局所背景を作るので、下地の陰影に影響されない
 * （実測: 陰影を強めても文字 vs halo のコントラスト比は不変）。
 */
export const HILLSHADE_LAYER: BasemapStyle["layers"][number] = {
  id: HILLSHADE_LAYER_ID,
  type: "hillshade",
  source: DEM_SOURCE_ID,
  paint: {
    "hillshade-exaggeration": [
      "interpolate",
      ["linear"],
      ["zoom"],
      ...HILLSHADE_EXAGGERATION_STOPS.flat(),
    ],
    "hillshade-shadow-color": "rgba(60, 50, 40, 0.65)",
    "hillshade-highlight-color": "rgba(255, 255, 255, 0.45)",
    "hillshade-accent-color": "rgba(60, 50, 40, 0.3)",
  },
};

/**
 * DEM（terrarium PMTiles）の raster-dem ソース定義を返す純粋関数。
 * buildBasemapStyle（起動時から hillshade 有効）と addDeferredHillshade
 * （#248 の遅延追加）の両方がこの 1 箇所から定義を得るため、遅延追加後の
 * ソース定義が起動時有効のスタイルと乖離しない。
 */
export function buildDemSource(
  demPmtilesUrl: string = DEM_PMTILES_URL,
): BasemapRasterDemSource {
  return {
    type: "raster-dem",
    url: `pmtiles://${demPmtilesUrl}`,
    encoding: "terrarium",
    // terrarium（AWS Terrain Tiles）は 256px タイル
    tileSize: 256,
    attribution:
      '<a href="https://registry.opendata.aws/terrain-tiles/">Terrain Tiles</a> (Mapzen)',
  };
}

/**
 * hillshade をベースマップレイヤー列の landcover の後・water の前に挿入する。
 * 陸地（earth / landcover）の陰影が水域・河川の下になり、海面に陰影が
 * かからない。deck.gl の勢力ポリゴン・ラベル等は overlay として常にこの
 * スタイルの上へ重なるため、視認性への影響は paint の不透明度だけで制御できる。
 */
function insertHillshade(
  baseLayers: BasemapStyle["layers"],
): BasemapStyle["layers"] {
  const waterIdx = baseLayers.findIndex((l) => l.id === "water");
  if (waterIdx < 0) {
    // water が無い場合（想定外）は末尾に置き、スタイル全体は壊さない
    return [...baseLayers, HILLSHADE_LAYER];
  }
  return [
    ...baseLayers.slice(0, waterIdx),
    HILLSHADE_LAYER,
    ...baseLayers.slice(waterIdx),
  ];
}

/**
 * water を「内水面（water-inland）→ 海洋（water）」の 2 枚に分割し、海洋の直上に
 * 海岸線（coastline）を挿入する純粋関数（TASK-84）。
 *
 * 分割後の重ね順は
 *   earth → landcover → hillshade → water-inland → 〈政治ポリゴン〉→ water → coastline
 * で、政治ポリゴンは beforeId = water（layer_stack.ts）によりこの位置へ入る。
 * これにより
 * - 海側へはみ出した塗りは海洋 water に覆われる（TASK-77 の目的を維持）
 * - 湖・川の水面は政治ポリゴンの下に来るので塗りが虫食いにならない（TASK-84）
 * - 陸の輪郭は coastline が水面より上に描くので沿岸でも線が読める（TASK-84）
 * が同時に成り立つ。
 *
 * water が無いレイヤー列（想定外・将来のスタイル変更）ではそのまま返す。
 * 分割・海岸線なしでも従来表示に縮退するだけで、スタイル全体は壊れない。
 */
export function splitWaterAndAddCoastline(
  baseLayers: BasemapStyle["layers"],
): BasemapStyle["layers"] {
  const waterIdx = baseLayers.findIndex((l) => l.id === WATER_LAYER_ID);
  if (waterIdx < 0) return [...baseLayers];
  const water = baseLayers[waterIdx];
  const kinds: unknown = ["literal", [...INLAND_WATER_KINDS]];
  // 元の filter（["==", "$type", "Polygon"]）はレガシー構文で式と混在できない
  // ため、ポリゴン絞り込みも式（geometry-type）で書き直す
  const polygonOnly: unknown = ["==", ["geometry-type"], "Polygon"];
  const inland = {
    ...water,
    id: WATER_INLAND_LAYER_ID,
    filter: ["all", polygonOnly, ["in", ["get", "kind"], kinds]],
  };
  const marine = {
    ...water,
    filter: ["all", polygonOnly, ["!", ["in", ["get", "kind"], kinds]]],
  };
  return [
    ...baseLayers.slice(0, waterIdx),
    inland,
    marine,
    COASTLINE_LAYER,
    ...baseLayers.slice(waterIdx + 1),
  ];
}

/**
 * 遅延追加する hillshade レイヤーの挿入位置（beforeId）を返す純粋関数
 * （#248）。起動時から有効な場合のレイヤー順（insertHillshade →
 * splitWaterAndAddCoastline の合成結果: landcover → hillshade → water-inland →
 * water → coastline）と同一になる位置を、現在のレイヤー ID 列から選ぶ:
 * - 沿岸補完（#305、coastal_fill_sync.ts が water-inland の直下へ追加する）が
 *   あればその直前。帯は政治ポリゴンの塗りと同じく hillshade より上に来る
 *   必要がある（下に潜ると帯の区間だけ陰影の重なり順が塗りと変わり、沿岸で
 *   明暗の継ぎ目が出る）
 * - water-inland があればその直前（水面分割済み = 通常のスタイル）
 * - 無ければ water の直前（分割前の並びへの縮退。insertHillshade と同じ）
 * - 水面レイヤーが無ければ null = 末尾追加（insertHillshade と同じ縮退で、
 *   スタイル全体は壊さない）
 */
export function hillshadeBeforeId(
  layerIds: readonly string[],
): string | null {
  for (
    const id of [COASTAL_FILL_LAYER_ID, WATER_INLAND_LAYER_ID, WATER_LAYER_ID]
  ) {
    if (layerIds.includes(id)) return id;
  }
  return null;
}

/**
 * addDeferredHillshade が操作する map の最小型（MapLibre Map 互換。#248）。
 * DOM 非依存のフェイクで遅延追加の結果（ソース定義・レイヤー順）を
 * ユニットテストできるようにするための注入点。
 */
export interface HillshadeMapLike {
  getSource(id: string): unknown;
  getLayersOrder(): string[];
  addSource(id: string, source: BasemapRasterDemSource): void;
  addLayer(layer: BasemapStyle["layers"][number], beforeId?: string): void;
}

/**
 * DEM ソースと hillshade レイヤーを読み込み済みの map へ遅延追加する
 * （#248）。起動時は hillshade 無効のスタイル（buildBasemapStyle 第 3 引数
 * false）で開始することで europe-dem.pmtiles を初期ロードの critical path
 * から外し、map.on("load") 後（起動データ取得の開始後）にこの関数で追加する。
 * ソース定義は buildDemSource、レイヤー定義は HILLSHADE_LAYER、挿入位置は
 * hillshadeBeforeId が返す位置で、いずれも起動時から有効だった場合と同一に
 * なる（basemap_test.ts が完全一致を検証）。
 *
 * 冪等: 既に hillshade レイヤーまたは DEM ソースが存在する場合は何もしない
 * （false を返す）。追加した場合は true を返す。
 */
export function addDeferredHillshade(
  map: HillshadeMapLike,
  demPmtilesUrl: string = DEM_PMTILES_URL,
): boolean {
  if (
    map.getLayersOrder().includes(HILLSHADE_LAYER_ID) ||
    map.getSource(DEM_SOURCE_ID) !== undefined
  ) {
    return false;
  }
  map.addSource(DEM_SOURCE_ID, buildDemSource(demPmtilesUrl));
  map.addLayer(
    HILLSHADE_LAYER,
    hillshadeBeforeId(map.getLayersOrder()) ?? undefined,
  );
  return true;
}

/**
 * PMTiles URL からベースマップ用の MapLibre スタイルを組み立てる純粋関数。
 * ラベルレイヤーを生成しないため glyphs / sprite は不要。
 *
 * TASK-73: 配色は protomaps の light flavor をそのまま使わず、
 * parchmentFlavor()（羊皮紙トーン）を通す。
 *
 * TASK-34: DEM（terrarium PMTiles）ソースと hillshade レイヤーを含める。
 * DEM アーカイブは任意生成のため存在しない環境もあるが、MapLibre はソースの
 * タイル取得失敗でスタイル全体を落とさず、hillshade が描画されないだけで
 * 従来表示を維持する（dem ソースのエラーで OpenFreeMap へフォールバック
 * しないことは src/fallback.ts が担保する）。
 *
 * TASK-133: hillshadeEnabled = false（モバイル小画面。判定は
 * shouldEnableHillshade）のときは DEM ソースと hillshade レイヤー自体を
 * スタイルに含めない。ソースが存在しなければ MapLibre が DEM PMTiles への
 * リクエスト（ヘッダ・タイル）を発行する経路が存在しないため、「無効時は
 * DEM への一切のリクエストが発生しない」（AC #5）が構造的に保証される。
 */
export function buildBasemapStyle(
  pmtilesUrl: string,
  // TASK-127: 本番は R2 カスタムドメインの絶対 URL に差し替える。
  // 省略時は従来どおり同一オリジン（ローカル開発・既存テストの互換）
  demPmtilesUrl: string = DEM_PMTILES_URL,
  // TASK-133: 省略時は従来どおり hillshade を含める（デスクトップ既定。AC #4）
  hillshadeEnabled: boolean = true,
): BasemapStyle {
  // TASK-73: light flavor をそのまま使わず、羊皮紙トーンへ上書きした flavor
  // から生成する（配色の定義は PARCHMENT_FLAVOR_OVERRIDES に集約）。
  const flavor = parchmentFlavor();
  const allLayers = layers(BASEMAP_SOURCE_ID, flavor);
  const sources: BasemapStyle["sources"] = {
    [BASEMAP_SOURCE_ID]: {
      type: "vector",
      url: `pmtiles://${pmtilesUrl}`,
      attribution:
        '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
    },
  };
  if (hillshadeEnabled) {
    sources[DEM_SOURCE_ID] = buildDemSource(demPmtilesUrl);
  }
  const baseLayers = filterBasemapLayers(
    allLayers,
  ) as BasemapStyle["layers"];
  return {
    version: 8,
    sources,
    layers: splitWaterAndAddCoastline(
      hillshadeEnabled ? insertHillshade(baseLayers) : baseLayers,
    ),
  };
}
