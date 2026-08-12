import { assert, assertEquals } from "@std/assert";
import { layers, namedFlavor } from "@protomaps/basemaps";
import {
  addDeferredHillshade,
  BASEMAP_LAYER_IDS,
  type BasemapStyle,
  buildBasemapStyle,
  buildDemSource,
  COASTAL_FILL_LAYER_ID,
  COASTLINE_COLOR,
  COASTLINE_LAYER_ID,
  filterBasemapLayers,
  HILLSHADE_EXAGGERATION_STOPS,
  HILLSHADE_LAYER_ID,
  HILLSHADE_MIN_SHORT_SIDE_PX,
  hillshadeBeforeId,
  INLAND_WATER_KINDS,
  PARCHMENT_FLAVOR_OVERRIDES,
  PARCHMENT_LANDCOVER_COLORS,
  parchmentFlavor,
  shouldEnableHillshade,
  WATER_INLAND_LAYER_ID,
  WATER_LAYER_ID,
  waterKindIsMarine,
} from "./basemap.ts";
import {
  BASEMAP_PMTILES_URL,
  BASEMAP_SOURCE_ID,
  DEM_PMTILES_URL,
  DEM_SOURCE_ID,
} from "./config.ts";

/** @protomaps/basemaps ^5 の実レイヤー定義（light flavor・ラベルなし） */
const realLayers = layers(BASEMAP_SOURCE_ID, namedFlavor("light"));

Deno.test("BASEMAP_LAYER_IDS は地形・海岸線系のみを含む（河川ラインは TASK-44 で除外）", () => {
  assertEquals(BASEMAP_LAYER_IDS, [
    "background",
    "earth",
    "landcover",
    // 順序は @protomaps/basemaps の描画順（base_layers.ts の定義順）を維持
    "water",
  ]);
});

Deno.test("filterBasemapLayers は採用レイヤーのみを残す", () => {
  const filtered = filterBasemapLayers(realLayers);
  assertEquals(
    filtered.map((l) => l.id),
    [...BASEMAP_LAYER_IDS],
  );
});

Deno.test("filterBasemapLayers は現代の国境・道路・地名等を除外する", () => {
  const filteredIds = new Set(filterBasemapLayers(realLayers).map((l) => l.id));
  // @protomaps/basemaps ^5.7.2 の base_layers.ts に実在する除外対象の代表
  const excluded = [
    "boundaries",
    "boundaries_country",
    "buildings",
    "landuse_park",
    "landuse_industrial",
    "roads_major",
    "roads_highway",
    "roads_rail",
  ];
  for (const id of excluded) {
    assert(
      realLayers.some((l) => l.id === id),
      `前提: 実レイヤー定義に ${id} が存在すること`,
    );
    assert(!filteredIds.has(id), `${id} は除外されるべき`);
  }
});

Deno.test("filterBasemapLayers はプレフィックス一致の別レイヤーを誤って残さない", () => {
  const input = [
    { id: "water" },
    { id: "water_label_ocean" },
    { id: "earth" },
    { id: "earth_label_islands" },
  ];
  assertEquals(
    filterBasemapLayers(input).map((l) => l.id),
    ["water", "earth"],
  );
});

Deno.test("buildBasemapStyle は version 8 の MapLibre スタイルを返す", () => {
  const style = buildBasemapStyle(BASEMAP_PMTILES_URL);
  assertEquals(style.version, 8);
});

Deno.test("buildBasemapStyle は pmtiles:// スキームのベクタソースを定義する", () => {
  const style = buildBasemapStyle(BASEMAP_PMTILES_URL);
  const source = style.sources[BASEMAP_SOURCE_ID];
  assert(source.type === "vector"); // 型の絞り込みを兼ねる
  assertEquals(source.url, `pmtiles://${BASEMAP_PMTILES_URL}`);
});

Deno.test("buildBasemapStyle のソースに OSM/Protomaps の attribution がある", () => {
  const style = buildBasemapStyle(BASEMAP_PMTILES_URL);
  const attribution = style.sources[BASEMAP_SOURCE_ID].attribution ?? "";
  assert(attribution.includes("protomaps.com"));
  assert(attribution.includes("openstreetmap.org"));
});

Deno.test("buildBasemapStyle のレイヤーは採用レイヤー + hillshade + 水面分割 + coastline で構成される", () => {
  const style = buildBasemapStyle(BASEMAP_PMTILES_URL);
  // TASK-34: hillshade は landcover の後・water の前に挿入する
  // TASK-84: water は内水面（water-inland）と海洋（water）に分かれ、その上に
  // 海岸線（coastline）が乗る
  assertEquals(
    style.layers.map((l) => l.id),
    [
      "background",
      "earth",
      "landcover",
      HILLSHADE_LAYER_ID,
      WATER_INLAND_LAYER_ID,
      "water",
      COASTLINE_LAYER_ID,
    ],
  );
});

Deno.test("buildBasemapStyle に symbol レイヤー（ラベル）が含まれない", () => {
  const style = buildBasemapStyle(BASEMAP_PMTILES_URL);
  assert(style.layers.every((l) => l.type !== "symbol"));
});

// --- TASK-24: 主要河川オーバーレイの deck.gl 移行 ---
// TASK-21 で MapLibre style に置いていた rivers ソース/レイヤーは、クリック/
// ホバー可能にするため deck.gl の GeoJsonLayer（rivers.ts + main.ts）へ移行し、
// style には含めない。

Deno.test("buildBasemapStyle に rivers ソースが含まれない", () => {
  const style = buildBasemapStyle(BASEMAP_PMTILES_URL);
  assertEquals(Object.keys(style.sources), [BASEMAP_SOURCE_ID, DEM_SOURCE_ID]);
});

Deno.test("buildBasemapStyle に rivers レイヤーが含まれない", () => {
  const style = buildBasemapStyle(BASEMAP_PMTILES_URL);
  assert(style.layers.every((l) => l.id !== "rivers"));
});

// --- TASK-34: 地形（hillshade）表現 ---
// DEM（terrarium PMTiles）を raster-dem ソースとして追加し、hillshade レイヤー
// で起伏を表現する。DEM アーカイブは任意生成（dist に無い環境もある）。

// TASK-127: 本番は R2 カスタムドメインの絶対 URL を使うため、DEM の URL も
// 引数で差し替えられる（省略時は従来どおり同一オリジンの DEM_PMTILES_URL）。
Deno.test("buildBasemapStyle は第 2 引数で DEM の PMTiles URL を差し替えられる（TASK-127）", () => {
  const demUrl = "https://tiles.zeitreises.com/europe-dem.pmtiles";
  const style = buildBasemapStyle(BASEMAP_PMTILES_URL, demUrl);
  const dem = style.sources[DEM_SOURCE_ID];
  assert(dem !== undefined && dem.type === "raster-dem");
  assertEquals(dem.url, `pmtiles://${demUrl}`);
});

Deno.test("buildBasemapStyle は terrarium エンコーディングの raster-dem ソースを定義する", () => {
  const style = buildBasemapStyle(BASEMAP_PMTILES_URL);
  const dem = style.sources[DEM_SOURCE_ID];
  assert(dem !== undefined, "dem ソースが存在すること");
  assert(dem.type === "raster-dem"); // 型の絞り込みを兼ねる
  assertEquals(dem.url, `pmtiles://${DEM_PMTILES_URL}`);
  assertEquals(dem.encoding, "terrarium");
  // terrarium（AWS Terrain Tiles）は 256px タイル
  assertEquals(dem.tileSize, 256);
});

Deno.test("dem ソースに Terrain Tiles の attribution がある", () => {
  const style = buildBasemapStyle(BASEMAP_PMTILES_URL);
  const attribution = style.sources[DEM_SOURCE_ID].attribution ?? "";
  assert(attribution.includes("Terrain Tiles"));
  assert(attribution.includes("registry.opendata.aws/terrain-tiles"));
});

Deno.test("hillshade レイヤーは dem ソースを参照する type: hillshade", () => {
  const style = buildBasemapStyle(BASEMAP_PMTILES_URL);
  const hillshade = style.layers.find((l) => l.id === HILLSHADE_LAYER_ID);
  assert(hillshade !== undefined, "hillshade レイヤーが存在すること");
  assertEquals(hillshade.type, "hillshade");
  assertEquals(hillshade.source, DEM_SOURCE_ID);
});

Deno.test("hillshade は landcover の後・water の前に挿入される", () => {
  const style = buildBasemapStyle(BASEMAP_PMTILES_URL);
  const ids = style.layers.map((l) => l.id);
  const hillshadeIdx = ids.indexOf(HILLSHADE_LAYER_ID);
  const landcoverIdx = ids.indexOf("landcover");
  const waterIdx = ids.indexOf("water");
  assert(hillshadeIdx > landcoverIdx, "hillshade は landcover より上");
  assert(hillshadeIdx < waterIdx, "hillshade は water より下");
});

// --- TASK-98: 地形陰影のコントラストを上げる ---
// TASK-34 の paint 値は「勢力ポリゴン（alpha 128）越しでも邪魔をしない」ことを
// 優先して控えめに置いたが、その塗りの下では起伏がほとんど読めなかった。
// 陰影を強めつつ、政治色の判別（塗りは半透明のまま）とラベル判読（halo が
// 局所背景を作る）を壊さない値へ引き上げる。

/** TASK-34 の paint 値（引き上げ前の基準として固定する） */
const LEGACY_HILLSHADE_PAINT = {
  exaggeration: 0.4,
  shadowAlpha: 0.35,
  highlightAlpha: 0.25,
  accentAlpha: 0.15,
} as const;

/** "rgba(r, g, b, a)" から alpha を取り出す（不正な値は NaN） */
function alphaOf(color: unknown): number {
  const m = /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)$/
    .exec(String(color));
  return m ? Number(m[1]) : NaN;
}

Deno.test("hillshade の exaggeration はどのズーム段でも TASK-34 の値より強い", () => {
  for (const [zoom, value] of HILLSHADE_EXAGGERATION_STOPS) {
    assert(
      value > LEGACY_HILLSHADE_PAINT.exaggeration,
      `z${zoom} の exaggeration ${value} が TASK-34 の ${LEGACY_HILLSHADE_PAINT.exaggeration} 以下`,
    );
  }
});

Deno.test("hillshade の exaggeration はズームが上がるほど弱まる（高ズームの DEM ノイズを抑える）", () => {
  const stops = HILLSHADE_EXAGGERATION_STOPS;
  assert(stops.length >= 2, "停止点は 2 つ以上");
  for (let i = 1; i < stops.length; i++) {
    assert(stops[i][0] > stops[i - 1][0], "停止点のズームは昇順");
    assert(stops[i][1] <= stops[i - 1][1], "exaggeration は高ズームほど弱い");
  }
  assert(
    stops[stops.length - 1][1] < stops[0][1],
    "広域より拡大側を弱める（拡大では DEM の粒状ノイズが目立つため）",
  );
});

Deno.test("hillshade の exaggeration は停止点どおりの zoom 補間式になる", () => {
  const style = buildBasemapStyle(BASEMAP_PMTILES_URL);
  const paint = (style.layers.find((l) => l.id === HILLSHADE_LAYER_ID)
    ?.paint ?? {}) as Record<string, unknown>;
  assertEquals(paint["hillshade-exaggeration"], [
    "interpolate",
    ["linear"],
    ["zoom"],
    ...HILLSHADE_EXAGGERATION_STOPS.flat(),
  ]);
});

Deno.test("hillshade の影・ハイライト・アクセントは TASK-34 より濃く、かつ半透明を保つ", () => {
  const style = buildBasemapStyle(BASEMAP_PMTILES_URL);
  const paint = (style.layers.find((l) => l.id === HILLSHADE_LAYER_ID)
    ?.paint ?? {}) as Record<string, unknown>;
  const cases: Array<[string, number]> = [
    ["hillshade-shadow-color", LEGACY_HILLSHADE_PAINT.shadowAlpha],
    ["hillshade-highlight-color", LEGACY_HILLSHADE_PAINT.highlightAlpha],
    ["hillshade-accent-color", LEGACY_HILLSHADE_PAINT.accentAlpha],
  ];
  for (const [key, legacy] of cases) {
    const alpha = alphaOf(paint[key]);
    assert(
      Number.isFinite(alpha),
      `${key} が rgba() 形式でない: ${paint[key]}`,
    );
    assert(
      alpha > legacy,
      `${key} の alpha ${alpha} が TASK-34 の ${legacy} 以下`,
    );
    // 不透明にすると勢力ポリゴンの色が陰影で潰れる（AC #2）
    assert(alpha < 1, `${key} の alpha ${alpha} が不透明`);
  }
});

Deno.test("hillshade・水面分割・coastline の追加後もベースマップ採用レイヤーの相対順序は不変", () => {
  const style = buildBasemapStyle(BASEMAP_PMTILES_URL);
  const added: readonly string[] = [
    HILLSHADE_LAYER_ID,
    WATER_INLAND_LAYER_ID,
    COASTLINE_LAYER_ID,
  ];
  const idsWithoutAdded = style.layers
    .map((l) => l.id)
    .filter((id) => !added.includes(id));
  assertEquals(idsWithoutAdded, [...BASEMAP_LAYER_IDS]);
});

// --- TASK-44: ベースマップ河川ラインのデコイ化を解消 ---
// deck.gl の pickable 河川（NE50m, src/rivers.ts + main.ts）と、ベースマップ
// （Protomaps）の water_river / water_stream の経路が一致せず、ユーザーが
// クリックする川筋で河川を選択できなくなっていた。河川表示は deck オーバー
// レイへ一本化し、ベースマップ側の川ラインは採用しない。

Deno.test("BASEMAP_LAYER_IDS は water_river / water_stream を含まない（河川表示は deck オーバーレイに一本化, TASK-44）", () => {
  assert(!BASEMAP_LAYER_IDS.includes("water_river"));
  assert(!BASEMAP_LAYER_IDS.includes("water_stream"));
});

// --- TASK-73: 羊皮紙/古地図トーンへの配色統一 ---
// 地図外 UI（app.css の --parchment #f4ecd7 / --parchment-shade #e7d9b2 /
// --ink #3a2712 等、TASK-40）と地図本体の乖離を解消するため、protomaps の
// light flavor を羊皮紙系の色で上書きする。

/** "#rrggbb" → [r,g,b]（テスト用の素朴なパーサ） */
function hex(color: string): [number, number, number] {
  const n = parseInt(color.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** "rgba(r, g, b, a)" → [r,g,b]（テスト用の素朴なパーサ） */
function rgba(color: string): [number, number, number] {
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  assert(m !== null, `${color} は rgba(...) 形式のはず`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** HSV 相当の彩度（0..1）。0 に近いほど無彩色 */
function saturation([r, g, b]: [number, number, number]): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

Deno.test("PARCHMENT_FLAVOR_OVERRIDES は承認済みの羊皮紙系の色を定義する", () => {
  assertEquals(PARCHMENT_FLAVOR_OVERRIDES.background, "#e7d9b2");
  assertEquals(PARCHMENT_FLAVOR_OVERRIDES.earth, "#f0e6cd");
  assertEquals(PARCHMENT_FLAVOR_OVERRIDES.water, "#c7d2d0");
  assertEquals(PARCHMENT_FLAVOR_OVERRIDES.glacier, "#f4efe2");
  assertEquals(PARCHMENT_FLAVOR_OVERRIDES.sand, "#e8dcc0");
});

Deno.test("羊皮紙系の陸地・背景色は暖色（R >= G > B）で明るい", () => {
  for (
    const key of ["background", "earth", "glacier", "sand", "beach"] as const
  ) {
    const value = PARCHMENT_FLAVOR_OVERRIDES[key];
    const [r, g, b] = hex(value);
    assert(r >= g && g > b, `${key}=${value} は暖色のはず`);
    assert(r >= 200, `${key}=${value} は明るい下地のはず`);
  }
});

Deno.test("water はシアンではなくくすんだ青灰（低彩度・寒色寄り）", () => {
  const water = hex(PARCHMENT_FLAVOR_OVERRIDES.water);
  // light flavor の #80deea（シアン）は彩度 0.45 超。羊皮紙下地では大幅に落とす
  assert(
    saturation(water) < 0.2,
    `water=${PARCHMENT_FLAVOR_OVERRIDES.water} は低彩度のはず`,
  );
  // 陸（暖色）と区別できるよう、赤より青が強い（または同等）寒色寄りにする
  assert(water[2] >= water[0], "water は青が赤以上（寒色寄り）のはず");
});

Deno.test("PARCHMENT_LANDCOVER_COLORS は light flavor の緑系を彩度の低いオリーブへ置き換える", () => {
  const keys = [
    "grassland",
    "barren",
    "urban_area",
    "farmland",
    "glacier",
    "scrub",
    "forest",
  ] as const;
  const base = namedFlavor("light").landcover as unknown as Record<
    string,
    string
  >;
  for (const key of keys) {
    const color = PARCHMENT_LANDCOVER_COLORS[key];
    assert(color !== undefined, `${key} の色が定義されていること`);
    assert(color !== base[key], `${key} は light flavor から変更されること`);
    const c = rgba(color);
    assert(saturation(c) < 0.3, `landcover.${key}=${color} は低彩度のはず`);
    // 緑被覆も含めて暖色（オリーブ）側に寄せる: 青が最も弱い
    assert(
      c[2] <= c[0] && c[2] <= c[1],
      `landcover.${key}=${color} は青が最も弱い（オリーブ/羊皮紙寄り）はず`,
    );
  }
});

Deno.test("parchmentFlavor は light flavor の上書きで、未指定キーは維持する", () => {
  const base = namedFlavor("light");
  const flavor = parchmentFlavor();
  assertEquals(flavor.background, PARCHMENT_FLAVOR_OVERRIDES.background);
  assertEquals(flavor.earth, PARCHMENT_FLAVOR_OVERRIDES.earth);
  assertEquals(flavor.water, PARCHMENT_FLAVOR_OVERRIDES.water);
  assertEquals(flavor.landcover, PARCHMENT_LANDCOVER_COLORS);
  // 採用しないレイヤー（建物・道路等）の色は light flavor のまま
  assertEquals(flavor.buildings, base.buildings);
  assertEquals(flavor.highway, base.highway);
});

Deno.test("parchmentFlavor は namedFlavor('light') を破壊的に変更しない", () => {
  parchmentFlavor();
  const base = namedFlavor("light");
  assertEquals(base.earth, "#e2dfda");
  assertEquals(base.water, "#80deea");
});

Deno.test("buildBasemapStyle の background / earth / water に羊皮紙色が反映される", () => {
  const style = buildBasemapStyle(BASEMAP_PMTILES_URL);
  const byId = new Map(style.layers.map((l) => [l.id, l]));
  const paintOf = (id: string): Record<string, unknown> => {
    const layer = byId.get(id);
    assert(layer !== undefined, `${id} レイヤーが存在すること`);
    return layer.paint as Record<string, unknown>;
  };
  assertEquals(
    paintOf("background")["background-color"],
    PARCHMENT_FLAVOR_OVERRIDES.background,
  );
  assertEquals(
    paintOf("earth")["fill-color"],
    PARCHMENT_FLAVOR_OVERRIDES.earth,
  );
  assertEquals(
    paintOf("water")["fill-color"],
    PARCHMENT_FLAVOR_OVERRIDES.water,
  );
});

Deno.test("buildBasemapStyle の landcover に羊皮紙系のオリーブが反映され、light flavor の緑が残らない", () => {
  const style = buildBasemapStyle(BASEMAP_PMTILES_URL);
  const landcover = style.layers.find((l) => l.id === "landcover");
  assert(landcover !== undefined);
  const paint = landcover.paint as Record<string, unknown>;
  const serialized = JSON.stringify(paint["fill-color"]);
  for (const color of Object.values(PARCHMENT_LANDCOVER_COLORS)) {
    assert(
      serialized.includes(color),
      `landcover の fill-color に ${color} が含まれること`,
    );
  }
  const baseLandcover = namedFlavor("light").landcover as unknown as Record<
    string,
    string
  >;
  for (const color of Object.values(baseLandcover)) {
    assert(
      !serialized.includes(color),
      `light flavor の landcover 色 ${color} は残らないこと`,
    );
  }
});

Deno.test("buildBasemapStyle に light flavor の現代的な色（シアンの海・グレー背景）が残らない", () => {
  const style = buildBasemapStyle(BASEMAP_PMTILES_URL);
  const serialized = JSON.stringify(style.layers);
  for (const legacy of ["#80deea", "#e2dfda", "#cccccc", "#e7e7e7"]) {
    assert(!serialized.includes(legacy), `${legacy} は残らないこと`);
  }
});

// --- TASK-84: 沿岸の輪郭線の回復と内水面の重ね順 ---
// TASK-77 で政治ポリゴンを水面（water）の下へ回した副作用として、(1) 陸の輪郭に
// 沿った線が一切描かれなくなり沿岸が読めない、(2) 湖・川など内水面のポリゴンが
// 政治ポリゴンの塗りを虫食い状に抜く、という 2 つの退行が出た。ベースマップ側で
// 海岸線（coastline）を描き、水面を海洋側（water）と内水面側（water-inland）に
// 分割して、内水面だけを政治ポリゴンより下へ下げることで両方を解消する。

Deno.test("buildBasemapStyle は water を内水面（water-inland）と海洋（water）に分け、その上に coastline を置く", () => {
  const style = buildBasemapStyle(BASEMAP_PMTILES_URL);
  assertEquals(
    style.layers.map((l) => l.id),
    [
      "background",
      "earth",
      "landcover",
      HILLSHADE_LAYER_ID,
      WATER_INLAND_LAYER_ID,
      WATER_LAYER_ID,
      COASTLINE_LAYER_ID,
    ],
  );
});

Deno.test("water-inland は政治ポリゴンの挿入位置（beforeId = water）より下・coastline は上", () => {
  const ids = buildBasemapStyle(BASEMAP_PMTILES_URL).layers.map((l) => l.id);
  // 政治ポリゴンは water の直下へ入るため、water-inland < water < coastline の
  // 順序がそのまま「内水面 → 政治ポリゴン → 海洋 → 海岸線」の重ね順になる
  assert(ids.indexOf(WATER_INLAND_LAYER_ID) < ids.indexOf(WATER_LAYER_ID));
  assert(ids.indexOf(WATER_LAYER_ID) < ids.indexOf(COASTLINE_LAYER_ID));
});

Deno.test("water（海洋側）は内水面の kind を除外し、water-inland は内水面の kind だけを通す", () => {
  const style = buildBasemapStyle(BASEMAP_PMTILES_URL);
  const marine = style.layers.find((l) => l.id === WATER_LAYER_ID);
  const inland = style.layers.find((l) => l.id === WATER_INLAND_LAYER_ID);
  assert(marine !== undefined && inland !== undefined);
  for (const kind of INLAND_WATER_KINDS) {
    assert(!waterKindIsMarine(kind), `${kind} は内水面のはず`);
  }
  // 海洋・不明な kind は従来どおり海洋側（政治ポリゴンより上）に残す
  for (const kind of ["ocean", "sea", "bay", "strait", "fjord", "dock", ""]) {
    assert(waterKindIsMarine(kind), `${kind} は海洋側に残すはず`);
  }
  // filter は同じ定数から組み立てられていること（片側だけ変わる事故を防ぐ）
  const serialized = JSON.stringify([marine.filter, inland.filter]);
  for (const kind of INLAND_WATER_KINDS) {
    assert(serialized.includes(`"${kind}"`), `filter に ${kind} が現れること`);
  }
});

Deno.test("water-inland は water と同じ塗り色（分割で見た目が変わらない）", () => {
  const style = buildBasemapStyle(BASEMAP_PMTILES_URL);
  const marine = style.layers.find((l) => l.id === WATER_LAYER_ID);
  const inland = style.layers.find((l) => l.id === WATER_INLAND_LAYER_ID);
  assert(marine !== undefined && inland !== undefined);
  assertEquals(inland.type, marine.type);
  assertEquals(inland.source, marine.source);
  assertEquals(inland["source-layer"], marine["source-layer"]);
  assertEquals(
    (inland.paint as Record<string, unknown>)["fill-color"],
    (marine.paint as Record<string, unknown>)["fill-color"],
  );
});

Deno.test("coastline は earth ポリゴンの輪郭を描く line レイヤー", () => {
  const style = buildBasemapStyle(BASEMAP_PMTILES_URL);
  const coastline = style.layers.find((l) => l.id === COASTLINE_LAYER_ID);
  assert(coastline !== undefined);
  assertEquals(coastline.type, "line");
  assertEquals(coastline.source, BASEMAP_SOURCE_ID);
  assertEquals(coastline["source-layer"], "earth");
  // earth には島名の Point も入るため、ポリゴンだけに絞る
  assert(
    JSON.stringify(coastline.filter).includes("geometry-type"),
    "geometry-type でポリゴンに絞ること",
  );
});

Deno.test("coastline の色は羊皮紙のインク系（暖色の焦茶）で、海より暗い", () => {
  const [r, g, b] = rgba(COASTLINE_COLOR);
  assert(r >= g && g >= b, `${COASTLINE_COLOR} は暖色のはず`);
  const [wr, wg, wb] = hex(PARCHMENT_FLAVOR_OVERRIDES.water);
  assert(r + g + b < wr + wg + wb, "海の色より暗いこと（線として読めること）");
});

// --- TASK-133: モバイル端末での DEM hillshade 抑制 ---
// 小画面のモバイルでは hillshade の判読寄与が小さい割に DEM タイルの GPU
// メモリ・帯域を消費するため、端末条件（ビューポート短辺 + タッチ入力）に
// 応じて hillshade を無効化できるようにする。判定は DOM 非依存の純粋関数
// shouldEnableHillshade で行い（AC #1/#2/#6）、無効時は buildBasemapStyle が
// DEM ソース・hillshade レイヤー自体を含めない（AC #5 の前提）。

Deno.test("shouldEnableHillshade: モバイルプリセット相当（375x812・タッチあり）では無効（TASK-133）", () => {
  // TASK-131 の MOBILE_PRESET（幅 375 / 高さ 812 / タッチ有効）で false になる
  assertEquals(
    shouldEnableHillshade({
      viewportWidthPx: 375,
      viewportHeightPx: 812,
      maxTouchPoints: 5,
    }),
    false,
  );
});

Deno.test("shouldEnableHillshade: 横持ち（812x375）でも短辺で判定するため無効のまま", () => {
  // 判定は min(width, height) なので、画面回転で有効/無効が反転しない
  assertEquals(
    shouldEnableHillshade({
      viewportWidthPx: 812,
      viewportHeightPx: 375,
      maxTouchPoints: 5,
    }),
    false,
  );
});

Deno.test("shouldEnableHillshade: デスクトップ既定（1600x900・タッチなし）では有効（AC #4）", () => {
  assertEquals(
    shouldEnableHillshade({
      viewportWidthPx: 1600,
      viewportHeightPx: 900,
      maxTouchPoints: 0,
    }),
    true,
  );
});

Deno.test("shouldEnableHillshade: タッチなしなら小さいウィンドウでも有効（デスクトップの縮小ウィンドウを巻き込まない）", () => {
  assertEquals(
    shouldEnableHillshade({
      viewportWidthPx: 500,
      viewportHeightPx: 400,
      maxTouchPoints: 0,
    }),
    true,
  );
});

Deno.test("shouldEnableHillshade: タッチ対応でも短辺が閾値以上なら有効（タブレット・タッチ対応ラップトップ）", () => {
  // iPad 縦持ち（768x1024）とタッチ対応ラップトップ（1600x900）は有効のまま
  assertEquals(
    shouldEnableHillshade({
      viewportWidthPx: 768,
      viewportHeightPx: 1024,
      maxTouchPoints: 5,
    }),
    true,
  );
  assertEquals(
    shouldEnableHillshade({
      viewportWidthPx: 1600,
      viewportHeightPx: 900,
      maxTouchPoints: 10,
    }),
    true,
  );
});

Deno.test("shouldEnableHillshade: 閾値は短辺 768px（境界の下は無効・境界ちょうどは有効）", () => {
  assertEquals(HILLSHADE_MIN_SHORT_SIDE_PX, 768);
  assertEquals(
    shouldEnableHillshade({
      viewportWidthPx: HILLSHADE_MIN_SHORT_SIDE_PX - 1,
      viewportHeightPx: 1024,
      maxTouchPoints: 1,
    }),
    false,
  );
  assertEquals(
    shouldEnableHillshade({
      viewportWidthPx: HILLSHADE_MIN_SHORT_SIDE_PX,
      viewportHeightPx: 1024,
      maxTouchPoints: 1,
    }),
    true,
  );
});

Deno.test("buildBasemapStyle は hillshade 無効時に DEM ソース自体を含めない（TASK-133 AC #5 の前提）", () => {
  const style = buildBasemapStyle(BASEMAP_PMTILES_URL, DEM_PMTILES_URL, false);
  // DEM ソースがスタイルに存在しなければ、MapLibre が DEM PMTiles への
  // リクエスト（ヘッダ・タイル取得）を発行する経路が存在しない
  assertEquals(Object.keys(style.sources), [BASEMAP_SOURCE_ID]);
});

Deno.test("buildBasemapStyle は hillshade 無効時に hillshade レイヤーを含めず、他レイヤー構成は不変（AC #3）", () => {
  const style = buildBasemapStyle(BASEMAP_PMTILES_URL, DEM_PMTILES_URL, false);
  // hillshade だけが抜け、ベースマップ・水面分割・海岸線は従来どおり
  assertEquals(
    style.layers.map((l) => l.id),
    [
      "background",
      "earth",
      "landcover",
      WATER_INLAND_LAYER_ID,
      WATER_LAYER_ID,
      COASTLINE_LAYER_ID,
    ],
  );
});

Deno.test("buildBasemapStyle の第 3 引数は省略時 true（デスクトップは従来どおり hillshade を含む。AC #4）", () => {
  const style = buildBasemapStyle(BASEMAP_PMTILES_URL);
  assert(style.layers.some((l) => l.id === HILLSHADE_LAYER_ID));
  assert(style.sources[DEM_SOURCE_ID] !== undefined);
});

// --- Issue #248: DEM hillshade の遅延ロード ---
// europe-dem.pmtiles（ヘッダ + タイル 28 件 = 初期ロードの全リクエストの約 4 割）
// が MapLibre の load イベント（= 起動データ取得のトリガ）の critical path に
// 乗っていた。起動時は hillshade 無効のスタイル（buildBasemapStyle 第 3 引数
// false。DEM ソース・hillshade レイヤーを含まない = 初期ロードで DEM への
// リクエスト経路が構造的に存在しない）で開始し、map.on("load") 後に
// addDeferredHillshade で DEM ソース + hillshade レイヤーを追加する。
// 遅延追加後のソース定義・レイヤー順は従来（起動時から有効）と完全一致させる。

/** addDeferredHillshade のテスト用フェイク（スタイルオブジェクトを直接操作） */
function fakeMapOf(style: BasemapStyle) {
  return {
    getSource: (id: string) => style.sources[id],
    getLayersOrder: () => style.layers.map((l) => l.id),
    addSource: (id: string, source: BasemapStyle["sources"][string]) => {
      style.sources[id] = source;
    },
    addLayer: (layer: BasemapStyle["layers"][number], beforeId?: string) => {
      const idx = beforeId === undefined
        ? style.layers.length
        : style.layers.findIndex((l) => l.id === beforeId);
      if (idx < 0) throw new Error(`beforeId が存在しない: ${beforeId}`);
      style.layers.splice(idx, 0, layer);
    },
  };
}

Deno.test("buildDemSource は hillshade 有効スタイルの DEM ソース定義と一致する（#248）", () => {
  const demUrl = "https://tiles.zeitreises.com/europe-dem.pmtiles";
  const enabled = buildBasemapStyle(BASEMAP_PMTILES_URL, demUrl, true);
  assertEquals(buildDemSource(demUrl), enabled.sources[DEM_SOURCE_ID]);
  // 省略時は従来どおり同一オリジンの DEM_PMTILES_URL
  assertEquals(buildDemSource().url, `pmtiles://${DEM_PMTILES_URL}`);
});

Deno.test("hillshadeBeforeId は hillshade 無効スタイルに対して water-inland を返す（挿入位置が有効時と同一。#248）", () => {
  const disabled = buildBasemapStyle(
    BASEMAP_PMTILES_URL,
    DEM_PMTILES_URL,
    false,
  );
  assertEquals(
    hillshadeBeforeId(disabled.layers.map((l) => l.id)),
    WATER_INLAND_LAYER_ID,
  );
});

Deno.test("hillshadeBeforeId は沿岸補完レイヤーがあればその直前を返す（帯も塗りと同じく hillshade の上。#305）", () => {
  assertEquals(
    hillshadeBeforeId([
      "background",
      "earth",
      "landcover",
      COASTAL_FILL_LAYER_ID,
      WATER_INLAND_LAYER_ID,
      WATER_LAYER_ID,
      COASTLINE_LAYER_ID,
    ]),
    COASTAL_FILL_LAYER_ID,
  );
});

Deno.test("hillshadeBeforeId は水面分割前なら water、水面レイヤーが無ければ null（insertHillshade と同じ縮退。#248）", () => {
  // 水面分割（TASK-84）が効いていないレイヤー列でも water の直前 = 従来位置
  assertEquals(
    hillshadeBeforeId(["background", "earth", "landcover", WATER_LAYER_ID]),
    WATER_LAYER_ID,
  );
  // water 系が無い場合（想定外・フォールバックスタイル等）は末尾追加を示す null
  assertEquals(hillshadeBeforeId(["background", "earth"]), null);
});

Deno.test("addDeferredHillshade を hillshade 無効スタイルへ適用すると有効時のスタイルと完全一致する（#248 AC2/AC3）", () => {
  const demUrl = "https://tiles.zeitreises.com/europe-dem.pmtiles";
  const deferred = buildBasemapStyle(BASEMAP_PMTILES_URL, demUrl, false);
  const added = addDeferredHillshade(fakeMapOf(deferred), demUrl);
  assertEquals(added, true);
  // ソース定義（DEM）もレイヤー順（landcover → hillshade → water-inland →
  // water → coastline）も、起動時から有効だった場合と区別が付かないこと
  assertEquals(deferred, buildBasemapStyle(BASEMAP_PMTILES_URL, demUrl, true));
});

Deno.test("addDeferredHillshade は二重適用しない（既に hillshade があるスタイルでは no-op。#248）", () => {
  const enabled = buildBasemapStyle(BASEMAP_PMTILES_URL, DEM_PMTILES_URL, true);
  const before = structuredClone(enabled);
  const added = addDeferredHillshade(fakeMapOf(enabled), DEM_PMTILES_URL);
  assertEquals(added, false);
  assertEquals(enabled, before);
});

Deno.test("addDeferredHillshade は水面レイヤーが無いスタイルでは末尾に追加する（スタイルを壊さない縮退。#248）", () => {
  const style: BasemapStyle = {
    version: 8,
    sources: {},
    layers: [{ id: "background", type: "background" }],
  };
  const added = addDeferredHillshade(fakeMapOf(style), DEM_PMTILES_URL);
  assertEquals(added, true);
  assertEquals(style.layers.map((l) => l.id), [
    "background",
    HILLSHADE_LAYER_ID,
  ]);
  assert(style.sources[DEM_SOURCE_ID] !== undefined);
});
