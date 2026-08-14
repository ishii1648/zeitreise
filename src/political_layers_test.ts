/**
 * political_layers.ts のユニットテスト（TASK-148 / Issue #166）。
 *
 * 検証する契約:
 * - 見た目定数（HRE_EXTENT_* / FIEF_LINE_*）が main.ts 時代の値と一致すること
 * - buildPowerLayer: id・pickable・stroked・境界線・beforeId（underWaterBeforeId
 *   由来）・塗り遷移時間（context の fillTransitionMs）・強調 updateTriggers が
 *   main.ts 時代と一致すること
 * - buildSuzerainExtentLayer: extentKey の有無で visible/data が切り替わり、
 *   同一入力の再構築では union（キャッシュ）が再計算されないこと
 * - buildLabelLayer: **メモ化の参照同値（TASK-50/136 の非退行）**。強調キー
 *   だけが変わる再構築では data / characterSet の参照が前回と同一で、
 *   ズーム段が変わっても characterSet（全 datum 由来。TASK-122 AC #7）は
 *   同一参照のままであること
 * - **キャッシュ共有（debug_hooks.ts との契約）**: factory が公開する
 *   memoizedPowerLabelData / memoizedVisiblePowerLabels は builder と同一
 *   キャッシュを共有し、builder 実行後に同じ引数で呼ぶと再計算なしで
 *   同一参照が返ること
 */
import {
  assert,
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import type { Feature, FeatureCollection } from "geojson";
import {
  createPoliticalLayerBuilders,
  FIEF_BORDER_INK,
  HRE_BORDER_INK,
  HRE_EXTENT_FILL_COLOR,
  HRE_EXTENT_LAYER_ID,
  HRE_EXTENT_LINE_COLOR,
  HRE_EXTENT_LINE_WIDTH_PX,
  internalBorderLineColor,
  internalBorderLineWidth,
  internalBorderStyleFor,
  overviewPowerFillColor,
  type PoliticalLayerBuilders,
  type PoliticalLayerContext,
} from "./political_layers.ts";
import {
  COLLISION_SIZE_SCALE,
  FIEF_LABEL_COLOR,
  FIEF_LABEL_MIN_ZOOM,
  LABEL_COLLISION_BACKGROUND_COLOR,
  LABEL_FONT_SETTINGS,
  type LabelDatum,
  labelHaloWidthPx,
  labelTextStyleProps,
  OVERVIEW_POWER_LABEL_SIZE_PX,
  POLITICAL_DETAIL_MIN_ZOOM,
  POLITICAL_LABEL_FONT_SETTINGS,
  POLITICAL_LABEL_HALO_COLOR,
  POLITICAL_LABEL_STYLES,
  politicalLabelStyleFor,
  POWER_LABEL_SIZE_PX,
  SUB_POWER_LABEL_SIZE_PX,
  TOP_POWER_LABEL_SIZE_PX,
} from "./labels.ts";
import { labelCollisionExtensions } from "./label_collision.ts";
import { labelLayerBaseProps } from "./feature_layers.ts";
import { TIER_STYLES, ZOOM_SCALE } from "./approximate_borders.ts";
import {
  LABEL_LAYER_ID,
  TOP_LABEL_LAYER_ID,
  underWaterBeforeId,
} from "./layer_stack.ts";
import {
  BRITAIN_FIEF_LAYER_ID,
  CLIOPATRIA_FIEF_LAYER_ID,
  FRANCE_FIEF_LAYER_ID,
  HRE_LAYER_ID,
  ITALY_FIEF_LAYER_ID,
  POWER_LAYER_ID,
  SOVEREIGN_FIEF_LAYER_ID,
} from "./picking.ts";
import {
  DEFAULT_FILL_COLOR,
  FILL_ALPHA,
  LINE_COLOR,
  LINE_WIDTH_PX,
  type Rgba,
} from "./powers.ts";
import {
  ACTIVE_FILL_COLOR,
  powerFillColor,
  powerLabelColor,
} from "./power_highlight.ts";
import {
  EMPTY_SUZERAIN_OVERRIDES,
  resolveSuzerainKey,
  type SuzerainOverrides,
  UNRESOLVED_DETAIL_FOCUS_KEY,
} from "./suzerain_extent.ts";
import { coastalBandsForSuzerain } from "./coastal_fill.ts";
import { WATER_LAYER_ID } from "./basemap.ts";
import { EMPTY_FIEF_DEDUPE_TABLE } from "./fief_dedupe.ts";

// ---- fixtures ----

/** 正方形ポリゴンの Feature を組み立てる */
function polygonFeature(
  properties: Record<string, string>,
  origin: [number, number],
): Feature {
  const [x, y] = origin;
  return {
    type: "Feature",
    properties,
    geometry: {
      type: "Polygon",
      coordinates: [[[x, y], [x + 2, y], [x + 2, y + 2], [x, y + 2], [x, y]]],
    },
  };
}

/** base: 独立勢力 2 + France を宗主とする封臣 1（外枠 union の入力になる） */
const baseFc: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    polygonFeature({ NAME: "France" }, [0, 45]),
    polygonFeature({ NAME: "Normandy", SUBJECTO: "France" }, [2, 45]),
    polygonFeature({ NAME: "England" }, [-4, 50]),
  ],
};

/** HRE 領邦 1 件（kind=hre のラベルになり、ズーム段の出し分け対象） */
const hreFc: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    polygonFeature(
      { NAME: "Bavaria", SUBJECTO: "Holy Roman Empire" },
      [10, 47],
    ),
  ],
};

const emptyFc: FeatureCollection = { type: "FeatureCollection", features: [] };

const colors: Record<string, string> = { France: "#aabbcc" };
const nameJa: Record<string, string> = { France: "フランス" };

/** beforeId は deck.gl の型定義に現れないため、読み出しだけ型を緩める */
function beforeIdOf(layer: { props: unknown }): string | undefined {
  return (layer.props as { beforeId?: string }).beforeId;
}

/** 全フィールドを埋めた context。テストごとに必要な部分だけ上書きする */
function ctx(
  overrides: Partial<PoliticalLayerContext> = {},
): PoliticalLayerContext {
  return {
    year: 1000,
    colors,
    nameJa,
    overrides: EMPTY_SUZERAIN_OVERRIDES,
    fiefDedupe: EMPTY_FIEF_DEDUPE_TABLE,
    zoomStep: 4,
    extentKey: null,
    selectedPowerKey: null,
    hoveredPowerKey: null,
    fillTransitionMs: 400,
    styleLayerIds: [],
    coastalBands: null,
    ...overrides,
  };
}

// ---- 見た目定数（main.ts 時代の値の固定）----

Deno.test("勢力圏外枠の見た目定数は main.ts 時代の値と一致する", () => {
  assertEquals(HRE_EXTENT_LAYER_ID, "hre-extent");
  assertEquals(HRE_EXTENT_LINE_COLOR, [140, 30, 30, 255]);
  assertEquals(HRE_EXTENT_FILL_COLOR, [140, 30, 30, 30]);
  assertEquals(HRE_EXTENT_LINE_WIDTH_PX, 3);
  // 諸侯領境界の固定 alpha 定数（旧 FIEF_LINE_COLOR/FIEF_LINE_WIDTH_PX）は
  // #267 で階層 × レベル別の internalBorderStyleFor へ置き換えられた
  // （不変条件は後段の #267 テスト群が固定する）
});

// ---- buildPowerLayer ----

Deno.test("buildPowerLayer は id・pickable・境界線既定値・opacity を保つ", () => {
  const f = createPoliticalLayerBuilders();
  const layer = f.buildPowerLayer(ctx(), POWER_LAYER_ID, baseFc);
  assertEquals(layer.id, POWER_LAYER_ID);
  assertStrictEquals(layer.props.data, baseFc);
  assert(layer.props.pickable);
  assert(layer.props.stroked);
  assert(layer.props.filled);
  assertEquals(layer.props.opacity, 1);
  assertEquals(layer.props.getLineColor, LINE_COLOR);
  assertEquals(layer.props.getLineWidth, LINE_WIDTH_PX);
  assertEquals(layer.props.lineWidthUnits, "pixels");
});

Deno.test("buildPowerLayer は lineColor/lineWidth/stroked の上書きを反映する", () => {
  const f = createPoliticalLayerBuilders();
  const lineColor: Rgba = [
    FIEF_BORDER_INK[0],
    FIEF_BORDER_INK[1],
    FIEF_BORDER_INK[2],
    140,
  ];
  const layer = f.buildPowerLayer(
    ctx(),
    HRE_LAYER_ID,
    hreFc,
    lineColor,
    1.5,
    false,
  );
  assertEquals(layer.props.stroked, false);
  assertEquals(layer.props.getLineColor, lineColor);
  assertEquals(layer.props.getLineWidth, 1.5);
});

Deno.test("buildPowerLayer の beforeId は styleLayerIds から underWaterBeforeId で決まる", () => {
  const f = createPoliticalLayerBuilders();
  const withWater = f.buildPowerLayer(
    ctx({ styleLayerIds: ["landcover", "water", "waterway"] }),
    POWER_LAYER_ID,
    baseFc,
  );
  assertEquals(
    beforeIdOf(withWater),
    underWaterBeforeId(POWER_LAYER_ID, ["landcover", "water", "waterway"]),
  );
  assertEquals(beforeIdOf(withWater), "water");
  // スタイル未読込（空配列）では beforeId なし = 従来描画順
  const withoutStyle = f.buildPowerLayer(ctx(), POWER_LAYER_ID, baseFc);
  assertEquals(beforeIdOf(withoutStyle), undefined);
});

Deno.test("buildPowerLayer の塗り遷移時間は context の fillTransitionMs を使う", () => {
  const f = createPoliticalLayerBuilders();
  const layer = f.buildPowerLayer(
    ctx({ fillTransitionMs: 120 }),
    POWER_LAYER_ID,
    baseFc,
  );
  const transitions = layer.props.transitions as {
    getFillColor: { duration: number };
  };
  assertEquals(transitions.getFillColor.duration, 120);
});

Deno.test("buildPowerLayer の塗りは強調キーを反映し updateTriggers にも載る", () => {
  const f = createPoliticalLayerBuilders();
  // 詳細表示（z5 以上）では従来どおり feature 自身の色キーで塗る
  const c = ctx({ hoveredPowerKey: "France", zoomStep: FIEF_LABEL_MIN_ZOOM });
  const layer = f.buildPowerLayer(c, POWER_LAYER_ID, baseFc);
  const getFillColor = layer.props.getFillColor as (f: Feature) => Rgba;
  const [france, , england] = baseFc.features;
  assertEquals(
    getFillColor(france),
    powerFillColor(france.properties, colors, null, "France"),
  );
  assertEquals(
    getFillColor(england),
    powerFillColor(england.properties, colors, null, null),
  );
  // 強調キーと表示モードは accessor の入力なので trigger に載る（#228 AC2）
  const triggers = layer.props.updateTriggers as Record<string, unknown>;
  assertEquals(triggers.getFillColor, [1000, null, "France", true]);
});

Deno.test("buildPowerLayer の visible は省略時 true・明示で切り替わる（#228 AC2/AC6）", () => {
  const f = createPoliticalLayerBuilders();
  const shown = f.buildPowerLayer(ctx(), HRE_LAYER_ID, hreFc);
  assertEquals(shown.props.visible, true);
  // 概観（z4）では main.ts が領邦オーバーレイ 6 枚へ false を渡す。
  // visible: false は deck.gl 9.3.7 で描画・picking の両パスから外れるため、
  // pickable は据え置きのまま「不可視レイヤーが picking を奪わない」が成立する
  const hidden = f.buildPowerLayer(
    ctx(),
    HRE_LAYER_ID,
    hreFc,
    LINE_COLOR,
    LINE_WIDTH_PX,
    true,
    false,
  );
  assertEquals(hidden.props.visible, false);
  assertEquals(hidden.props.pickable, true);
  // data 参照は据え置き（layers 配列から抜かず deck の差分更新に任せる）
  assertStrictEquals(hidden.props.data, hreFc);
});

Deno.test("概観（z4）の塗りは SUBJECTO の宗主色へ寄せる（#228 AC2）", () => {
  const f = createPoliticalLayerBuilders();
  const layer = f.buildPowerLayer(ctx({ zoomStep: 4 }), POWER_LAYER_ID, baseFc);
  const getFillColor = layer.props.getFillColor as (f: Feature) => Rgba;
  const [france, normandy, england] = baseFc.features;
  // 封臣（SUBJECTO: France）は宗主 France の色（colors.json）で塗られ、
  // 勢力圏が一まとまりの色として読める
  assertEquals(getFillColor(normandy), [0xaa, 0xbb, 0xcc, FILL_ALPHA]);
  assertEquals(getFillColor(france), [0xaa, 0xbb, 0xcc, FILL_ALPHA]);
  // 宗主キーが colors.json に無い勢力は従来色へフォールバック
  assertEquals(
    getFillColor(england),
    powerFillColor(england.properties, colors, null, null),
  );
  // 表示モードが detail=false として trigger に載る（z4↔z5 で再評価される）
  const triggers = layer.props.updateTriggers as Record<string, unknown>;
  assertEquals(triggers.getFillColor, [1000, null, null, false]);
});

Deno.test("概観でも選択/ホバー強調はアクティブ色が勝つ（#228: 強調の維持）", () => {
  const f = createPoliticalLayerBuilders();
  const layer = f.buildPowerLayer(
    ctx({ zoomStep: 4, hoveredPowerKey: "Normandy|France" }),
    POWER_LAYER_ID,
    baseFc,
  );
  const getFillColor = layer.props.getFillColor as (f: Feature) => Rgba;
  const [, normandy] = baseFc.features;
  assertEquals(getFillColor(normandy), ACTIVE_FILL_COLOR);
});

Deno.test("overviewPowerFillColor: 宗主キーの色 / フォールバック / アクティブ優先（#228 AC2）", () => {
  const normandy = { NAME: "Normandy", SUBJECTO: "France" };
  const england = { NAME: "England" };
  // 宗主キーが colors.json にあれば宗主の色（alpha は通常塗りと同じ）
  assertEquals(
    overviewPowerFillColor(
      normandy,
      colors,
      EMPTY_SUZERAIN_OVERRIDES,
      null,
      null,
    ),
    [0xaa, 0xbb, 0xcc, FILL_ALPHA],
  );
  // 無ければ従来色（fillColorFor のフォールバック = デフォルトのグレー）
  assertEquals(
    overviewPowerFillColor(
      england,
      colors,
      EMPTY_SUZERAIN_OVERRIDES,
      null,
      null,
    ),
    DEFAULT_FILL_COLOR,
  );
  // 宗主補正（name-overrides.json suzerains）も外枠と同じ規則で効く
  assertEquals(
    overviewPowerFillColor(
      england,
      colors,
      { renames: {}, suzerains: { England: "France" } },
      null,
      null,
    ),
    [0xaa, 0xbb, 0xcc, FILL_ALPHA],
  );
  // アクティブ強調（キーは colorKeyFor と同じ NAME|SUBJECTO）は宗主色より優先
  assertEquals(
    overviewPowerFillColor(
      normandy,
      colors,
      EMPTY_SUZERAIN_OVERRIDES,
      "Normandy|France",
      null,
    ),
    ACTIVE_FILL_COLOR,
  );
});

// ---- buildSuzerainExtentLayer ----

Deno.test("勢力圏の外枠は extentKey が null なら非表示・空データ", () => {
  const f = createPoliticalLayerBuilders();
  const layer = f.buildSuzerainExtentLayer(ctx(), baseFc);
  assertEquals(layer.id, HRE_EXTENT_LAYER_ID);
  assertEquals(layer.props.visible, false);
  assertEquals(layer.props.pickable, false);
  assertEquals((layer.props.data as FeatureCollection).features.length, 0);
});

Deno.test("勢力圏の外枠は extentKey の宗主 + 封臣を union して表示する", () => {
  const f = createPoliticalLayerBuilders();
  const layer = f.buildSuzerainExtentLayer(
    ctx({ extentKey: "France" }),
    baseFc,
  );
  assertEquals(layer.props.visible, true);
  // France 本体 + Normandy（SUBJECTO=France）が 1 枚に融合される
  assertEquals((layer.props.data as FeatureCollection).features.length, 1);
  assertEquals(layer.props.getLineColor, HRE_EXTENT_LINE_COLOR);
  assertEquals(layer.props.getFillColor, HRE_EXTENT_FILL_COLOR);
  assertEquals(layer.props.getLineWidth, HRE_EXTENT_LINE_WIDTH_PX);
});

Deno.test("勢力圏の外枠は海洋 water の直下へ差し込む（#330 原因 1）", () => {
  const f = createPoliticalLayerBuilders();
  const layer = f.buildSuzerainExtentLayer(
    ctx({ extentKey: "France", styleLayerIds: [WATER_LAYER_ID, "coastline"] }),
    baseFc,
  );
  assertEquals(beforeIdOf(layer), WATER_LAYER_ID);
  // water を持たないフォールバックスタイルでは beforeId なし（AC6）
  const fallback = f.buildSuzerainExtentLayer(
    ctx({ extentKey: "France", styleLayerIds: ["background", "earth"] }),
    baseFc,
  );
  assertEquals(beforeIdOf(fallback), undefined);
});

Deno.test("勢力圏の外枠は沿岸補完の帯を合流した外縁になる（#330 原因 2）", () => {
  const f = createPoliticalLayerBuilders();
  const bands: FeatureCollection = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      // baseFc の添字 1 = Normandy（SUBJECTO=France）の沿岸補完帯
      properties: { baseIndex: 1 },
      geometry: {
        type: "MultiPolygon",
        coordinates: [[[[4, 45], [5, 45], [5, 47], [4, 47], [4, 45]]]],
      },
    }],
  };
  const layer = f.buildSuzerainExtentLayer(
    ctx({
      extentKey: "France",
      coastalBands: { base: baseFc, bands, select: coastalBandsForSuzerain },
    }),
    baseFc,
  );
  const data = layer.props.data as FeatureCollection;
  assertEquals(data.features.length, 1);
  const geometry = data.features[0].geometry;
  assert(geometry.type === "Polygon");
  // France(0..2) + Normandy(2..4) + 帯(4..5) が 1 枚に融合し、外縁は 5 まで伸びる
  assertEquals(
    Math.max(...geometry.coordinates[0].map(([x]) => x)),
    5,
  );
});

Deno.test("勢力圏の外枠は帝国全域ジオメトリも union に取り込む（#332）", () => {
  const f = createPoliticalLayerBuilders();
  // base に France 本体が無い年（後期 HRE の base に HRE feature が無いのと
  // 同じ状況）でも、宗主キーが同じ出典付きジオメトリだけで外枠が立つ
  const realm: FeatureCollection = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { NAME: "France", SUBJECTO: "France" },
      geometry: {
        type: "Polygon",
        coordinates: [[[0, 40], [8, 40], [8, 48], [0, 48], [0, 40]]],
      },
    }],
  };
  const withoutRealm = f.buildSuzerainExtentLayer(
    ctx({ extentKey: "France" }),
    baseFc,
  );
  const withRealm = f.buildSuzerainExtentLayer(
    ctx({ extentKey: "France" }),
    baseFc,
    realm,
  );
  const before = withoutRealm.props.data as FeatureCollection;
  const after = withRealm.props.data as FeatureCollection;
  assertEquals(after.features.length, 1);
  const geometry = after.features[0].geometry;
  assert(geometry.type === "Polygon");
  // 帝国全域ぶん（経度 8 まで）へ外縁が広がる
  assertEquals(Math.max(...geometry.coordinates[0].map(([x]) => x)), 8);
  assertNotStrictEquals(after, before);
  // 空 FC（非対象年のローダが返す値）は従来どおりの外枠に落ちる
  const emptyRealm = f.buildSuzerainExtentLayer(
    ctx({ extentKey: "France" }),
    baseFc,
    { type: "FeatureCollection", features: [] },
  );
  assertEquals(
    (emptyRealm.props.data as FeatureCollection).features.length,
    before.features.length,
  );
});

Deno.test("同一 extentKey の再構築では union が再計算されない（キャッシュ）", () => {
  const f = createPoliticalLayerBuilders();
  const first = f.buildSuzerainExtentLayer(
    ctx({ extentKey: "France" }),
    baseFc,
  );
  const second = f.buildSuzerainExtentLayer(
    ctx({ extentKey: "France" }),
    baseFc,
  );
  assertStrictEquals(second.props.data, first.props.data);
});

// ---- buildLabelLayer ----

Deno.test("勢力ラベル層は id・pickable・サイズが main.ts 時代の契約と一致する", () => {
  const f = createPoliticalLayerBuilders();
  const layer = f.buildLabelLayer(
    ctx(),
    baseFc,
    hreFc,
    emptyFc,
    emptyFc,
    emptyFc,
    emptyFc,
    emptyFc,
    "lower",
  );
  assertEquals(layer.id, LABEL_LAYER_ID);
  assertEquals(layer.props.pickable, false);
  // 既定 ctx は z4 = 概観なので上位勢力名は一段大きいサイズになる（#228 AC3。
  // #267 で getSize は tier × レベルの accessor になった）
  const getSize = layer.props.getSize as unknown as (
    d: Pick<LabelDatum, "tier">,
  ) => number;
  assertEquals(getSize({ tier: "top" }), OVERVIEW_POWER_LABEL_SIZE_PX);
});

Deno.test("勢力ラベルの getSize は概観で一段大きく・詳細で階層別サイズ（#228 AC3 / #267 AC6）", () => {
  const f = createPoliticalLayerBuilders();
  const build = (zoomStep: number) =>
    f.buildLabelLayer(
      ctx({ zoomStep }),
      baseFc,
      hreFc,
      emptyFc,
      emptyFc,
      emptyFc,
      emptyFc,
      emptyFc,
      "lower",
    );
  const sizeOf = (
    layer: { props: { getSize: unknown } },
    d: Pick<LabelDatum, "tier">,
  ) => (layer.props.getSize as (d: Pick<LabelDatum, "tier">) => number)(d);
  const overview = build(FIEF_LABEL_MIN_ZOOM - 1);
  const detail = build(FIEF_LABEL_MIN_ZOOM);
  assertEquals(sizeOf(overview, { tier: "top" }), OVERVIEW_POWER_LABEL_SIZE_PX);
  assertEquals(sizeOf(detail, { tier: "top" }), TOP_POWER_LABEL_SIZE_PX);
  assertEquals(sizeOf(detail, { tier: "constituent" }), POWER_LABEL_SIZE_PX);
  // getSize は zoomStep 依存になったため trigger に載る
  const overviewTriggers = overview.props.updateTriggers as Record<
    string,
    unknown
  >;
  assertEquals(overviewTriggers.getSize, [FIEF_LABEL_MIN_ZOOM - 1]);
  const detailTriggers = detail.props.updateTriggers as Record<string, unknown>;
  assertEquals(detailTriggers.getSize, [FIEF_LABEL_MIN_ZOOM]);
});

Deno.test("勢力ラベルの文字色は強調キーを反映し updateTriggers にも載る", () => {
  const f = createPoliticalLayerBuilders();
  const layer = f.buildLabelLayer(
    ctx({ selectedPowerKey: "France" }),
    baseFc,
    hreFc,
    emptyFc,
    emptyFc,
    emptyFc,
    emptyFc,
    emptyFc,
    "lower",
  );
  const getColor = layer.props.getColor as unknown as (
    d: Pick<LabelDatum, "kind" | "key">,
  ) => number[];
  const datum: Pick<LabelDatum, "kind" | "key"> = {
    kind: "base",
    key: "France",
  };
  assertEquals(getColor(datum), [...powerLabelColor(datum, "France", null)]);
  const triggers = layer.props.updateTriggers as Record<string, unknown>;
  assertEquals(triggers.getColor, ["France", null]);
  assertEquals(triggers.getText, [1000, 4]);
  assertEquals(triggers.getPosition, [1000, 4]);
});

Deno.test("強調キーだけの再構築では勢力ラベルの data・characterSet が再計算されない", () => {
  const f = createPoliticalLayerBuilders();
  const build = (c: PoliticalLayerContext) =>
    f.buildLabelLayer(
      c,
      baseFc,
      hreFc,
      emptyFc,
      emptyFc,
      emptyFc,
      emptyFc,
      emptyFc,
      "lower",
    );
  const first = build(ctx());
  const second = build(ctx({ hoveredPowerKey: "France" }));
  // data 参照が同一 = polylabel（buildLabelData）が走らない（TASK-50 非退行）
  assertStrictEquals(second.props.data, first.props.data);
  // characterSet 参照が同一 = フォントアトラスが作り直されない
  assertStrictEquals(second.props.characterSet, first.props.characterSet);
});

Deno.test("ズーム段が変わっても characterSet は全 datum 由来の同一参照を保つ", () => {
  const f = createPoliticalLayerBuilders();
  const build = (c: PoliticalLayerContext) =>
    f.buildLabelLayer(
      c,
      baseFc,
      hreFc,
      emptyFc,
      emptyFc,
      emptyFc,
      emptyFc,
      emptyFc,
      "lower",
    );
  const z4 = build(ctx({ zoomStep: 4 }));
  const z5 = build(ctx({ zoomStep: 5 }));
  // TASK-122 AC #7: characterSet はズーム絞り込み前の全 datum から作る
  assertStrictEquals(z5.props.characterSet, z4.props.characterSet);
  // 表示対象はズーム段で変わる（z4 は base のみ・z5 は領邦ラベルも出る）
  assertNotStrictEquals(z5.props.data, z4.props.data);
  const kinds = (layer: { props: { data: unknown } }) =>
    (layer.props.data as { kind?: string }[]).map((d) => d.kind);
  assert(!kinds(z4).includes("hre"));
  assert(kinds(z5).includes("hre"));
});

Deno.test("z4↔z5 の往復でも polylabel・characterSet は再計算されない（#228 AC8）", () => {
  const f = createPoliticalLayerBuilders();
  const build = (zoomStep: number) =>
    f.buildLabelLayer(
      ctx({ zoomStep }),
      baseFc,
      hreFc,
      emptyFc,
      emptyFc,
      emptyFc,
      emptyFc,
      emptyFc,
      "lower",
    );
  const first = build(4);
  const firstAll = f.memoizedPowerLabelData(
    1000,
    baseFc,
    hreFc,
    emptyFc,
    emptyFc,
    emptyFc,
    emptyFc,
    emptyFc,
    nameJa,
    EMPTY_FIEF_DEDUPE_TABLE,
  );
  build(5);
  const again = build(4);
  // 全 datum（polylabel の結果）とフォントアトラスの入力は往復後も同一参照
  assertStrictEquals(
    f.memoizedPowerLabelData(
      1000,
      baseFc,
      hreFc,
      emptyFc,
      emptyFc,
      emptyFc,
      emptyFc,
      emptyFc,
      nameJa,
      EMPTY_FIEF_DEDUPE_TABLE,
    ),
    firstAll,
  );
  assertStrictEquals(again.props.characterSet, first.props.characterSet);
});

// ---- キャッシュ共有（debug_hooks.ts へ注入するインスタンスとの契約）----

Deno.test("公開メモ化インスタンスは builder と同一キャッシュを共有する", () => {
  const f = createPoliticalLayerBuilders();
  const layer = f.buildLabelLayer(
    ctx(),
    baseFc,
    hreFc,
    emptyFc,
    emptyFc,
    emptyFc,
    emptyFc,
    emptyFc,
    "lower",
  );
  // builder 実行でキャッシュが埋まり、同じ引数の直接呼び出しは同一参照を返す
  // （別インスタンスなら初回計算で新しいオブジェクトが返り、この assert は落ちる）
  const memoized = f.memoizedPowerLabelData(
    1000,
    baseFc,
    hreFc,
    emptyFc,
    emptyFc,
    emptyFc,
    emptyFc,
    emptyFc,
    nameJa,
    EMPTY_FIEF_DEDUPE_TABLE,
  );
  assertStrictEquals(memoized.characterSet, layer.props.characterSet);
  // #333: レイヤーの data は「ズーム絞り込み → 描画グループ振り分け」を通った
  // 参照。どちらの段もメモ化インスタンス経由であることを固定する
  // （どこかで配列を作り直すと deck.gl の属性再計算がホバーのたびに走る）。
  const visible = f.memoizedVisiblePowerLabels(memoized.data, 4);
  assertStrictEquals(
    f.memoizedLabelsByGroup.lower(visible, "lower"),
    layer.props.data,
  );
});

Deno.test("factory ごとにキャッシュは独立している", () => {
  const f1 = createPoliticalLayerBuilders();
  const f2 = createPoliticalLayerBuilders();
  const args = [
    1000,
    baseFc,
    hreFc,
    emptyFc,
    emptyFc,
    emptyFc,
    emptyFc,
    emptyFc,
    nameJa,
    EMPTY_FIEF_DEDUPE_TABLE,
  ] as const;
  const r1 = f1.memoizedPowerLabelData(...args);
  const r2 = f2.memoizedPowerLabelData(...args);
  assertNotStrictEquals(r1, r2);
  // それぞれのキャッシュは自分の直近結果を返し続ける
  assertStrictEquals(f1.memoizedPowerLabelData(...args), r1);
  assertStrictEquals(f2.memoizedPowerLabelData(...args), r2);
});

Deno.test("被覆率表による base ラベル抑制はズーム段で解除される（配線契約）", () => {
  const f = createPoliticalLayerBuilders();
  const dedupe = { years: { "1000": { England: 1 } } };
  const build = (zoomStep: number) =>
    f.buildLabelLayer(
      ctx({ zoomStep, fiefDedupe: dedupe }),
      baseFc,
      hreFc,
      emptyFc,
      emptyFc,
      emptyFc,
      emptyFc,
      emptyFc,
      "top",
    );
  const texts = (layer: { props: { data: unknown } }) =>
    (layer.props.data as { text: string }[]).map((d) => d.text);
  // 諸侯領ラベルを出す段（z5）では被覆された base ラベルが抑制される
  assert(!texts(build(5)).includes("England"));
  // 諸侯領ラベルの無い段（z4）では抑制を解除して base ラベルを出す（TASK-122）
  assert(texts(build(4)).includes("England"));
});

// ---- #267: 内部境界のスタイル（AC3/AC4） ----

/** 概略境界（外周インク線）のズーム z での実効幅（px） */
function outerInkWidthAt(zoom: number): number {
  const t = (zoom - ZOOM_SCALE.minZoom) /
    (ZOOM_SCALE.maxZoom - ZOOM_SCALE.minZoom);
  const scale = ZOOM_SCALE.minScale +
    (ZOOM_SCALE.maxScale - ZOOM_SCALE.minScale) * t;
  return TIER_STYLES.normal.widthPx * scale;
}

Deno.test("内部境界はどのレベルでも上位勢力外周（normal tier インク線）より細く低 alpha（#267 AC4）", () => {
  const outerAlpha = TIER_STYLES.normal.alpha * 255;
  const levelMinZoom = {
    mid: FIEF_LABEL_MIN_ZOOM,
    detail: POLITICAL_DETAIL_MIN_ZOOM,
  } as const;
  for (const tier of ["constituent", "sub"] as const) {
    for (const level of ["mid", "detail"] as const) {
      const style = internalBorderStyleFor(tier, level);
      assert(
        style.alpha < outerAlpha,
        `${tier}/${level} の alpha ${style.alpha} が外周 ${outerAlpha} 以上`,
      );
      assert(
        style.widthPx < outerInkWidthAt(levelMinZoom[level]),
        `${tier}/${level} の幅 ${style.widthPx} が外周以上`,
      );
    }
  }
});

Deno.test("下位境界（sub）は主要構成勢力（constituent）よりさらに弱い（#267 AC2/AC4）", () => {
  for (const level of ["mid", "detail"] as const) {
    const constituent = internalBorderStyleFor("constituent", level);
    const sub = internalBorderStyleFor("sub", level);
    assert(sub.widthPx < constituent.widthPx);
    assert(sub.alpha < constituent.alpha);
  }
});

Deno.test("internalBorderStyleFor: overview はオーバーレイ非表示のため mid のスタイルへ倒す", () => {
  for (const tier of ["constituent", "sub"] as const) {
    assertEquals(
      internalBorderStyleFor(tier, "overview"),
      internalBorderStyleFor(tier, "mid"),
    );
  }
});

Deno.test("internalBorderLineColor / Width: 構造分類（politicalOverlayTier）でスタイルが決まる", () => {
  const constituentProps = {
    NAME: "Bavaria",
    SUBJECTO: "Holy Roman Empire",
    PARTOF: "Holy Roman Empire",
  };
  const subProps = {
    NAME: "County of Tyrol",
    SUBJECTO: "Duchy of Bavaria",
    PARTOF: "Holy Roman Empire",
  };
  const c = internalBorderStyleFor("constituent", "detail");
  const s = internalBorderStyleFor("sub", "detail");
  assertEquals(
    internalBorderLineColor(FIEF_BORDER_INK, constituentProps, "detail"),
    [
      FIEF_BORDER_INK[0],
      FIEF_BORDER_INK[1],
      FIEF_BORDER_INK[2],
      c.alpha,
    ],
  );
  assertEquals(internalBorderLineColor(HRE_BORDER_INK, subProps, "detail"), [
    HRE_BORDER_INK[0],
    HRE_BORDER_INK[1],
    HRE_BORDER_INK[2],
    s.alpha,
  ]);
  assertEquals(
    internalBorderLineWidth(constituentProps, "detail"),
    c.widthPx,
  );
  assertEquals(internalBorderLineWidth(subProps, "detail"), s.widthPx);
});

Deno.test("境界インクは記号の色相を保つ（藍紫 = 諸侯領 / 焦茶 = base と同系）", () => {
  assertEquals(FIEF_BORDER_INK, [
    FIEF_LABEL_COLOR[0],
    FIEF_LABEL_COLOR[1],
    FIEF_LABEL_COLOR[2],
  ]);
  assertEquals(HRE_BORDER_INK, [LINE_COLOR[0], LINE_COLOR[1], LINE_COLOR[2]]);
});

Deno.test("buildPowerLayer は lineWidth の accessor を受け、線スタイルの trigger にレベルが載る（#267 AC1/AC4）", () => {
  const f = createPoliticalLayerBuilders();
  const widthAccessor = (feature: Feature) =>
    internalBorderLineWidth(feature.properties, "detail");
  const layer = f.buildPowerLayer(
    ctx({ zoomStep: 7 }),
    HRE_LAYER_ID,
    hreFc,
    (feature: Feature) =>
      internalBorderLineColor(HRE_BORDER_INK, feature.properties, "detail"),
    widthAccessor,
  );
  assertStrictEquals(layer.props.getLineWidth, widthAccessor);
  const triggers = layer.props.updateTriggers as Record<string, unknown>;
  assertEquals(triggers.getLineColor, ["detail"]);
  assertEquals(triggers.getLineWidth, ["detail"]);
});

// ---- #267: 明色ラベル + 濃焦茶 halo・階層別サイズ（AC5/AC6） ----

Deno.test("勢力ラベル層は濃焦茶 halo（outlineColor）を使う（#267 AC5）", () => {
  const f = createPoliticalLayerBuilders();
  const layer = f.buildLabelLayer(
    ctx(),
    baseFc,
    hreFc,
    emptyFc,
    emptyFc,
    emptyFc,
    emptyFc,
    emptyFc,
    "lower",
  );
  assertEquals(layer.props.outlineColor, [...POLITICAL_LABEL_HALO_COLOR]);
});

// ---- #333: 参考画像（案A）を規範にした階層別スタイルの配線 ----
//
// #267 / #308 / #322 はいずれも「参考画像との一致」ではなく「現状より N 倍」
// 「内部計算で N px 以上」を合格基準にしていた。ここで固定するのは
// docs/images/issue333-label-reference/ の参考画像から実測した目標値
// （docs/research/issue-333-label-reference-targets.md）
// であって、過去の実装値との相対関係ではない。

Deno.test("政治ラベル層は文字列単位の濃色プレート（下支え）を敷く（#333 AC2/AC4）", () => {
  const f = createPoliticalLayerBuilders();
  for (const group of ["top", "lower"] as const) {
    const layer = f.buildLabelLayer(
      ctx(),
      baseFc,
      hreFc,
      emptyFc,
      emptyFc,
      emptyFc,
      emptyFc,
      emptyFc,
      group,
    );
    const style = politicalLabelStyleFor(group);
    const props = layer.props as unknown as {
      background?: boolean;
      getBackgroundColor?: number[];
      getBorderColor?: number[];
      getBorderWidth?: number;
      backgroundPadding?: readonly number[];
      backgroundBorderRadius?: number;
    };
    assertEquals(props.background, true);
    // TASK-143 の不可視クアッド（alpha 1）ではなく、参考画像の実測 alpha を
    // 持つ「見えるプレート」であること。ここが #322 との分岐点で、
    // #322 本番相当ではこの assert が落ちる（AC1 の red の実体）。
    assertEquals(props.getBackgroundColor, [...style.plateColor]);
    assert(
      (props.getBackgroundColor?.[3] ?? 0) >
        LABEL_COLLISION_BACKGROUND_COLOR[3],
      "プレートは衝突用の不可視クアッドより濃いはず",
    );
    // 参考画像のプレートは濃色（文字より暗い）で、TASK-72 が撤去した明色パネル
    // （クリーム alpha 200）とは明暗も濃度も逆。ここを取り違えると「白枠」が
    // 戻る。
    const [r, g, b, a] = props.getBackgroundColor as number[];
    assert(
      r < 96 && g < 96 && b < 96,
      `プレートは濃色のはず: rgb(${r},${g},${b})`,
    );
    assert(
      a > 32 && a < 96,
      `プレート alpha ${a} は薄く敷く範囲（33..95）のはず`,
    );
    // 縁・余白・角丸（参考画像の「札」らしさの実体）
    assertEquals(props.getBorderColor, [...style.plateBorderColor]);
    assertEquals(props.getBorderWidth, style.plateBorderWidthPx);
    assertEquals(props.backgroundPadding, style.platePadding);
    assertEquals(props.backgroundBorderRadius, style.plateBorderRadiusPx);
    // deck.gl にモジュール定数の参照をそのまま渡さない（破壊的変更の防止）
    assert(
      (props.getBackgroundColor as unknown) !== (style.plateColor as unknown),
    );
  }
});

Deno.test("政治ラベルの濃色外縁は階層別に独立して決まる（#333 AC3）", () => {
  const f = createPoliticalLayerBuilders();
  const build = (group: "top" | "lower", zoomStep: number) =>
    f.buildLabelLayer(
      ctx({ zoomStep }),
      baseFc,
      hreFc,
      emptyFc,
      emptyFc,
      emptyFc,
      emptyFc,
      emptyFc,
      group,
    );
  const top = build("top", POLITICAL_DETAIL_MIN_ZOOM);
  const lower = build("lower", POLITICAL_DETAIL_MIN_ZOOM);
  assertEquals(top.props.outlineWidth, POLITICAL_LABEL_STYLES.top.outlineWidth);
  assertEquals(
    lower.props.outlineWidth,
    POLITICAL_LABEL_STYLES.lower.outlineWidth,
  );
  // AC3 の要点: 12px ラベル（sub）を潰さないための上限が top を縛らない構造で
  // あること。両者が別の props を持てている = 片方を動かしてももう片方は
  // 変わらない、を値の相違で固定する。
  assertNotStrictEquals(
    top.props.outlineWidth,
    lower.props.outlineWidth,
    "top と lower が同じ outlineWidth なら階層別に調整できていない",
  );
  assertNotStrictEquals(
    (top.props as unknown as { backgroundPadding: unknown }).backgroundPadding,
    (lower.props as unknown as { backgroundPadding: unknown })
      .backgroundPadding,
  );
  // #322 が上限に張り付いていた 12（14px で実効 1.97 CSS px）より、どちらも
  // 細い。参考画像の濃色外縁は 1.0〜1.5 CSS px で、地色からの分離はプレートが
  // 担うため外縁を太らせる必要が無い。
  for (const layer of [top, lower]) {
    assert(
      layer.props.outlineWidth < 12,
      `outlineWidth=${layer.props.outlineWidth} は #322 の 12 より細いはず`,
    );
  }
  // フォントアトラスは 2 層で共有（キャッシュキーは fontFamily/weight/fontSize/
  // buffer/radius/cutoff で outlineWidth を含まない）。層を分けてもアトラスは
  // 増えない（#333 AC10）。
  assertStrictEquals(top.props.fontSettings, POLITICAL_LABEL_FONT_SETTINGS);
  assertStrictEquals(lower.props.fontSettings, POLITICAL_LABEL_FONT_SETTINGS);
  assertNotStrictEquals(
    top.props.fontSettings as unknown,
    LABEL_FONT_SETTINGS as unknown,
    "勢力ラベルの fontSettings は共通設定と別インスタンスのはず",
  );
});

Deno.test("政治ラベルの実効外縁（CSS px）は参考画像の実測レンジに入る（#333 AC2）", () => {
  // 参考画像の濃色外縁は「神聖ローマ帝国」（約 20px）で 1.3 px、
  // 「ノルマンディー公領」（約 15.3px）で 1.2 px。フォントサイズが違っても
  // 絶対幅がほぼ一定なのが特徴で、実装もこのレンジへ収める。
  const f = createPoliticalLayerBuilders();
  const cases: [group: "top" | "lower", size: number][] = [
    ["top", OVERVIEW_POWER_LABEL_SIZE_PX],
    ["top", TOP_POWER_LABEL_SIZE_PX],
    ["lower", POWER_LABEL_SIZE_PX],
    ["lower", SUB_POWER_LABEL_SIZE_PX],
  ];
  for (const [group, size] of cases) {
    const layer = f.buildLabelLayer(
      ctx(),
      baseFc,
      hreFc,
      emptyFc,
      emptyFc,
      emptyFc,
      emptyFc,
      emptyFc,
      group,
    );
    // 実効幅は**レイヤーが実際に渡した fontSettings** で計算する。props の値
    // だけを見ると #308 の轍（共通 SDF 設定の上限に張り付いたまま数値だけ
    // 大きい）を踏む。
    const effective = labelHaloWidthPx(
      layer.props.outlineWidth,
      size,
      layer.props.fontSettings,
    );
    assert(
      effective >= 0.9 && effective <= 1.5,
      `${group}/${size}px の実効外縁 ${effective} CSS px は参考画像レンジ 0.9〜1.5 のはず`,
    );
  }
});

Deno.test("政治ラベルは datum ごとに 1 層だけ（#322 候補B の不採用は維持。#333 AC8）", () => {
  // #322: 候補B（同じ datum を下層 = 影・上層 = 文字の 2 枚に描く二重
  // TextLayer）は、TextLayer の文字送りがサイズに比例するため下層の各グリフが
  // 上層とずれ、かつ 2 層を同一衝突空間に置くと同じアンカーで互いに衝突して
  // 表示/非表示が同期しない。#333 で層は 2 枚になったが、**1 つの datum は
  // 必ずどちらか一方にしか入らない**ので同じ罠を踏まない。それをここで固定
  // する（文字・外縁・下支えの 3 要素は 1 枚の TextLayer のサブレイヤーとして
  // data・anchor・size・衝突 extension を共有する）。
  const f = createPoliticalLayerBuilders();
  const built = f.buildLabelLayers(
    ctx({ zoomStep: POLITICAL_DETAIL_MIN_ZOOM }),
    baseFc,
    hreFc,
    emptyFc,
    emptyFc,
    emptyFc,
    emptyFc,
    emptyFc,
  );
  assertEquals(built.map((l) => l.id), [LABEL_LAYER_ID, TOP_LABEL_LAYER_ID]);
  const data = built.map((l) => l.props.data as LabelDatum[]);
  // 分割は網羅的かつ排他的（どの datum も落ちない・重複しない）
  const all = f.memoizedVisiblePowerLabels(
    f.memoizedPowerLabelData(
      1000,
      baseFc,
      hreFc,
      emptyFc,
      emptyFc,
      emptyFc,
      emptyFc,
      emptyFc,
      nameJa,
      EMPTY_FIEF_DEDUPE_TABLE,
    ).data,
    POLITICAL_DETAIL_MIN_ZOOM,
  );
  assertEquals(data[0].length + data[1].length, all.length);
  for (const d of all) {
    const hits = data.filter((group) => group.includes(d)).length;
    assertEquals(hits, 1, `datum ${d.text} が ${hits} 層に現れている`);
  }
  // 衝突空間・優先度・アンカーは 2 層で共有される（同一の base props 由来）
  for (const layer of built) {
    const props = layer.props as unknown as {
      collisionTestProps: { sizeScale: number };
      getCollisionPriority: (d: LabelDatum) => number;
      extensions: unknown[];
    };
    assertEquals(props.collisionTestProps.sizeScale, COLLISION_SIZE_SCALE);
    assertEquals(props.getCollisionPriority({ priority: 7 } as LabelDatum), 7);
    assertEquals(props.extensions.length, labelCollisionExtensions().length);
    assertEquals(layer.props.outlineColor, [...POLITICAL_LABEL_HALO_COLOR]);
  }
});

Deno.test("注記ラベル（都市・河川・山岳・山峰）は不可視クアッドのまま（#333 AC9）", () => {
  // 政治ラベルだけがプレートを持ち、共通スタイル・注記ラベルは TASK-72 /
  // TASK-143 のまま（明色パネルは戻らない）。
  const base = labelLayerBaseProps() as unknown as {
    background: boolean;
    getBackgroundColor: number[];
    backgroundPadding?: unknown;
    backgroundBorderRadius?: unknown;
  };
  assertEquals(base.background, true);
  assertEquals(base.getBackgroundColor, [...LABEL_COLLISION_BACKGROUND_COLOR]);
  assertEquals(base.backgroundPadding, undefined);
  assertEquals(base.backgroundBorderRadius, undefined);
  assertEquals(labelTextStyleProps().background, false);
});

Deno.test("勢力ラベルの getSize は階層とレベルで決まる accessor（#267 AC6）", () => {
  const f = createPoliticalLayerBuilders();
  const build = (zoomStep: number) =>
    f.buildLabelLayer(
      ctx({ zoomStep }),
      baseFc,
      hreFc,
      emptyFc,
      emptyFc,
      emptyFc,
      emptyFc,
      emptyFc,
      "lower",
    );
  const sizeOf = (
    layer: { props: { getSize: unknown } },
    d: Partial<LabelDatum>,
  ) => (layer.props.getSize as (d: Partial<LabelDatum>) => number)(d);
  const overview = build(4);
  assertEquals(
    sizeOf(overview, { tier: "top" }),
    OVERVIEW_POWER_LABEL_SIZE_PX,
  );
  const mid = build(5);
  assertEquals(sizeOf(mid, { tier: "top" }), TOP_POWER_LABEL_SIZE_PX);
  assertEquals(sizeOf(mid, { tier: "constituent" }), POWER_LABEL_SIZE_PX);
  const detail = build(7);
  assertEquals(sizeOf(detail, { tier: "top" }), TOP_POWER_LABEL_SIZE_PX);
  assertEquals(sizeOf(detail, { tier: "sub" }), SUB_POWER_LABEL_SIZE_PX);
  // tier 未付与の datum（後方互換）は kind から解決する
  assertEquals(sizeOf(detail, { kind: "hre" }), POWER_LABEL_SIZE_PX);
  assertEquals(sizeOf(detail, {}), TOP_POWER_LABEL_SIZE_PX);
  // getSize は zoomStep 依存のため trigger に載る（既存契約の維持）
  const triggers = detail.props.updateTriggers as Record<string, unknown>;
  assertEquals(triggers.getSize, [7]);
});

Deno.test("z5↔z7 の往復でも polylabel・characterSet は再計算されない（#267 AC1/AC11）", () => {
  const f = createPoliticalLayerBuilders();
  const build = (zoomStep: number) =>
    f.buildLabelLayer(
      ctx({ zoomStep }),
      baseFc,
      hreFc,
      emptyFc,
      emptyFc,
      emptyFc,
      emptyFc,
      emptyFc,
      "lower",
    );
  const first = build(5);
  build(7);
  const again = build(5);
  assertStrictEquals(again.props.characterSet, first.props.characterSet);
});

// ---- #348: detailFocusKey による領邦オーバーレイ・勢力ラベルの絞り込み ----

function fcOf(features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

/**
 * focus 絞り込み用の base（4 か国）。各国の 2°×2° の正方形の中に、対応する
 * オーバーレイ feature のアンカー（labelAnchorFor = 正方形の中心）が入る。
 */
const focusBaseFc: FeatureCollection = fcOf([
  polygonFeature({ NAME: "France" }, [0, 45]),
  polygonFeature({ NAME: "Papal States" }, [10, 41]),
  polygonFeature({ NAME: "England" }, [-4, 50]),
  polygonFeature({ NAME: "Ottoman Empire" }, [26, 39]),
]);

/** hre-powers: SUBJECTO で宗主が宣言されるため幾何に落ちない */
const focusHreFc = fcOf([
  polygonFeature({ NAME: "Bavaria", SUBJECTO: "Holy Roman Empire" }, [12, 47]),
]);
/** france-fiefs: SUBJECTO なし = 包含する base（France）から宗主が決まる */
const focusFranceFiefsFc = fcOf([
  polygonFeature({ NAME: "Champagne" }, [0.2, 45.2]),
]);
/** italy-fiefs: 包含する base は Papal States */
const focusItalyFiefsFc = fcOf([
  polygonFeature({ NAME: "Tuscany" }, [10.2, 41.2]),
]);
/** cliopatria-fiefs: 帝国領邦と仏諸侯領が **同一レイヤーに同居** する（AC2） */
const focusCliopatriaFc = fcOf([
  polygonFeature({ NAME: "Bohemia", SUBJECTO: "Holy Roman Empire" }, [14, 49]),
  polygonFeature({ NAME: "Aquitaine" }, [0.3, 45.3]),
]);
/** britain-fiefs: 包含する base は England */
const focusBritainFiefsFc = fcOf([
  polygonFeature({ NAME: "Gwynedd" }, [-3.8, 50.2]),
]);
/** sovereign-fiefs: 包含する base は Ottoman Empire */
const focusSovereignFiefsFc = fcOf([
  polygonFeature({ NAME: "Crimean Khanate" }, [26.2, 39.2]),
]);

/** 6 系統の (レイヤー ID, データ) 対（deck_app.ts renderLayers と同じ組み合わせ） */
const FOCUS_OVERLAYS: readonly (readonly [string, FeatureCollection])[] = [
  [HRE_LAYER_ID, focusHreFc],
  [FRANCE_FIEF_LAYER_ID, focusFranceFiefsFc],
  [ITALY_FIEF_LAYER_ID, focusItalyFiefsFc],
  [CLIOPATRIA_FIEF_LAYER_ID, focusCliopatriaFc],
  [BRITAIN_FIEF_LAYER_ID, focusBritainFiefsFc],
  [SOVEREIGN_FIEF_LAYER_ID, focusSovereignFiefsFc],
];

/** focus を与えて 6 系統を組み立て、レイヤー ID → 残った NAME 一覧を返す */
function overlayNamesByLayer(
  f: PoliticalLayerBuilders,
  detailFocusKey: string | null,
): Record<string, string[]> {
  const c = ctx({ zoomStep: 5, detailFocusKey, base: focusBaseFc });
  const out: Record<string, string[]> = {};
  for (const [id, data] of FOCUS_OVERLAYS) {
    const layer = f.buildPowerLayer(
      c,
      id,
      data,
      LINE_COLOR,
      LINE_WIDTH_PX,
      true,
      true,
    );
    out[id] = (layer.props.data as FeatureCollection).features.map(
      (ft) => String(ft.properties?.NAME),
    );
  }
  return out;
}

Deno.test("focus と同じ宗主の領邦だけが 6 系統に残る（#348 AC1/AC7）", () => {
  const f = createPoliticalLayerBuilders();
  assertEquals(overlayNamesByLayer(f, "France"), {
    [HRE_LAYER_ID]: [],
    [FRANCE_FIEF_LAYER_ID]: ["Champagne"],
    [ITALY_FIEF_LAYER_ID]: [],
    [CLIOPATRIA_FIEF_LAYER_ID]: ["Aquitaine"],
    [BRITAIN_FIEF_LAYER_ID]: [],
    [SOVEREIGN_FIEF_LAYER_ID]: [],
  });
  assertEquals(overlayNamesByLayer(f, "Holy Roman Empire"), {
    [HRE_LAYER_ID]: ["Bavaria"],
    [FRANCE_FIEF_LAYER_ID]: [],
    [ITALY_FIEF_LAYER_ID]: [],
    [CLIOPATRIA_FIEF_LAYER_ID]: ["Bohemia"],
    [BRITAIN_FIEF_LAYER_ID]: [],
    [SOVEREIGN_FIEF_LAYER_ID]: [],
  });
  assertEquals(overlayNamesByLayer(f, "Papal States")[ITALY_FIEF_LAYER_ID], [
    "Tuscany",
  ]);
  assertEquals(overlayNamesByLayer(f, "England")[BRITAIN_FIEF_LAYER_ID], [
    "Gwynedd",
  ]);
  assertEquals(
    overlayNamesByLayer(f, "Ottoman Empire")[SOVEREIGN_FIEF_LAYER_ID],
    ["Crimean Khanate"],
  );
});

Deno.test("複数宗主が同居するレイヤーは feature 単位で絞られる（#348 AC2）", () => {
  const f = createPoliticalLayerBuilders();
  // cliopatria-fiefs は帝国領邦（Bohemia）と仏諸侯領（Aquitaine）が同居する。
  // レイヤー単位の on/off では「片方だけ残す」が表現できない。
  assertEquals(
    overlayNamesByLayer(f, "France")[CLIOPATRIA_FIEF_LAYER_ID],
    ["Aquitaine"],
  );
  assertEquals(
    overlayNamesByLayer(f, "Holy Roman Empire")[CLIOPATRIA_FIEF_LAYER_ID],
    ["Bohemia"],
  );
});

Deno.test("focus 外のレイヤーは空データになるだけで ID・visible は変わらない（#348 AC5）", () => {
  const f = createPoliticalLayerBuilders();
  const c = ctx({
    zoomStep: 5,
    detailFocusKey: "France",
    base: focusBaseFc,
    styleLayerIds: ["landcover", "water"],
  });
  const layer = f.buildPowerLayer(
    c,
    HRE_LAYER_ID,
    focusHreFc,
    LINE_COLOR,
    LINE_WIDTH_PX,
    true,
    true,
  );
  // レイヤーを消す（visible: false / layers 配列から抜く）のではなく空 FC にする。
  // ID・配列内の位置・visible の意味を保つことで picking 優先順の検証
  // （layerOrderMatchesPickingPriority）と deck.gl の差分更新が壊れない。
  assertEquals(layer.id, HRE_LAYER_ID);
  assertEquals(layer.props.visible, true);
  assertEquals(layer.props.pickable, true);
  assertEquals(beforeIdOf(layer), "water");
  const data = layer.props.data as FeatureCollection;
  assertEquals(data.type, "FeatureCollection");
  assertEquals(data.features.length, 0);
  // 概観（z4）で main.ts が渡す visible: false はそのまま効く
  const hidden = f.buildPowerLayer(
    ctx({ detailFocusKey: "France", base: focusBaseFc }),
    HRE_LAYER_ID,
    focusHreFc,
    LINE_COLOR,
    LINE_WIDTH_PX,
    true,
    false,
  );
  assertEquals(hidden.props.visible, false);
});

Deno.test("powers レイヤーは detailFocusKey で絞られない（#348 スコープ外）", () => {
  const f = createPoliticalLayerBuilders();
  const layer = f.buildPowerLayer(
    ctx({ zoomStep: 5, detailFocusKey: "France", base: focusBaseFc }),
    POWER_LAYER_ID,
    focusBaseFc,
  );
  // powers の塗りデータの focus 対応は分割タスク 2/5（#347）の担当
  assertStrictEquals(layer.props.data, focusBaseFc);
});

Deno.test("focus が無ければ 6 系統の data は入力と同一参照（#348 AC6）", () => {
  const f = createPoliticalLayerBuilders();
  for (const [id, data] of FOCUS_OVERLAYS) {
    // detailFocusKey 未指定（現状の main.ts）
    assertStrictEquals(
      f.buildPowerLayer(ctx({ zoomStep: 5 }), id, data).props.data,
      data,
    );
    // base だけ渡っていて focus が null（海上など）でも同じ
    assertStrictEquals(
      f.buildPowerLayer(
        ctx({ zoomStep: 5, detailFocusKey: null, base: focusBaseFc }),
        id,
        data,
      ).props.data,
      data,
    );
    // base が未確定なら focus があっても絞らない（従来表示へ縮退）
    assertStrictEquals(
      f.buildPowerLayer(
        ctx({ zoomStep: 5, detailFocusKey: "France" }),
        id,
        data,
      ).props.data,
      data,
    );
  }
});

Deno.test("同じ focus の再構築では data の参照が変わらない（差分更新の維持）", () => {
  const f = createPoliticalLayerBuilders();
  const c = ctx({ zoomStep: 5, detailFocusKey: "France", base: focusBaseFc });
  const a = f.buildPowerLayer(c, CLIOPATRIA_FIEF_LAYER_ID, focusCliopatriaFc);
  const b = f.buildPowerLayer(c, CLIOPATRIA_FIEF_LAYER_ID, focusCliopatriaFc);
  assertStrictEquals(b.props.data, a.props.data);
});

/** geometry の読み出し回数を数える feature（宗主分類の再計算検出用） */
function countingFeature(
  properties: Record<string, string>,
  origin: [number, number],
): { feature: Feature; reads: () => number } {
  const feature = polygonFeature(properties, origin);
  const geometry = feature.geometry;
  let reads = 0;
  Object.defineProperty(feature, "geometry", {
    get() {
      reads++;
      return geometry;
    },
    configurable: true,
    enumerable: true,
  });
  return { feature, reads: () => reads };
}

Deno.test("focus を変えても領邦の宗主分類は再計算されない（#348 AC4）", () => {
  const f = createPoliticalLayerBuilders();
  // SUBJECTO を持たない諸侯領は containingSuzerainKey が labelAnchorFor
  // （= feature.geometry の読み出し）まで落ちる。focus を切り替えるたびに
  // base 全 feature の線形走査が走らないことを読み出し回数で固定する。
  const spy = countingFeature({ NAME: "Champagne" }, [0.2, 45.2]);
  const data = fcOf([spy.feature]);
  const build = (detailFocusKey: string) =>
    f.buildPowerLayer(
      ctx({ zoomStep: 5, detailFocusKey, base: focusBaseFc }),
      FRANCE_FIEF_LAYER_ID,
      data,
    );
  assertEquals(
    (build("France").props.data as FeatureCollection).features.length,
    1,
  );
  const afterFirst = spy.reads();
  assert(afterFirst > 0, "初回は幾何から宗主を解決する");
  assertEquals(
    (build("England").props.data as FeatureCollection).features.length,
    0,
  );
  build("France");
  build("Holy Roman Empire");
  assertEquals(spy.reads(), afterFirst);
});

Deno.test("オーバーレイとラベルは同一の宗主分類器インスタンスを共有する（#348 AC4）", () => {
  const f = createPoliticalLayerBuilders();
  const c = ctx({
    zoomStep: POLITICAL_DETAIL_MIN_ZOOM,
    detailFocusKey: "France",
    base: focusBaseFc,
  });
  f.buildPowerLayer(c, CLIOPATRIA_FIEF_LAYER_ID, focusCliopatriaFc);
  const classifier = f.memoizedSuzerainClassifier(
    focusBaseFc,
    EMPTY_SUZERAIN_OVERRIDES,
  );
  // ラベル builder は base を引数でも受け取るが、分類には ctx.base を使う。
  // 別の参照を渡すと単一スロットのキャッシュが落ち、focus 切替のたびに
  // containingSuzerainKey の線形走査が復活する。
  f.buildLabelLayers(
    c,
    focusBaseFc,
    focusHreFc,
    focusFranceFiefsFc,
    focusItalyFiefsFc,
    focusCliopatriaFc,
    focusBritainFiefsFc,
    focusSovereignFiefsFc,
  );
  assertStrictEquals(
    f.memoizedSuzerainClassifier(focusBaseFc, EMPTY_SUZERAIN_OVERRIDES),
    classifier,
  );
});

Deno.test("focus を変えても polylabel・characterSet は再計算されない（#348 AC4）", () => {
  const f = createPoliticalLayerBuilders();
  const build = (detailFocusKey: string | null) =>
    f.buildLabelLayer(
      ctx({
        zoomStep: POLITICAL_DETAIL_MIN_ZOOM,
        detailFocusKey,
        base: focusBaseFc,
      }),
      focusBaseFc,
      focusHreFc,
      focusFranceFiefsFc,
      focusItalyFiefsFc,
      focusCliopatriaFc,
      focusBritainFiefsFc,
      focusSovereignFiefsFc,
      "lower",
    );
  const first = build("France");
  const second = build("England");
  assertStrictEquals(second.props.characterSet, first.props.characterSet);
  // 表示対象そのものは focus で変わる
  assertNotStrictEquals(second.props.data, first.props.data);
  assertStrictEquals(
    build("France").props.characterSet,
    first.props.characterSet,
  );
});

/** focus 付きで組み立てたラベル 2 層のテキストを 1 つに集める */
function focusedLabelTexts(
  f: PoliticalLayerBuilders,
  detailFocusKey: string | null,
  fiefDedupe = EMPTY_FIEF_DEDUPE_TABLE,
): string[] {
  return f.buildLabelLayers(
    ctx({
      zoomStep: POLITICAL_DETAIL_MIN_ZOOM,
      detailFocusKey,
      base: focusBaseFc,
      fiefDedupe,
    }),
    focusBaseFc,
    focusHreFc,
    focusFranceFiefsFc,
    focusItalyFiefsFc,
    focusCliopatriaFc,
    focusBritainFiefsFc,
    focusSovereignFiefsFc,
  ).flatMap((l) => (l.props.data as LabelDatum[]).map((d) => d.text));
}

Deno.test("focus 内は領邦名・focus 外は上位勢力名がラベルになる（#348 AC3）", () => {
  const f = createPoliticalLayerBuilders();
  const texts = focusedLabelTexts(f, "France");
  // focus 内（France 圏）の領邦名は出る
  assert(texts.includes("Champagne"));
  assert(texts.includes("Aquitaine"));
  // focus 外の領邦名は出ない
  for (const name of ["Bavaria", "Bohemia", "Tuscany", "Gwynedd"]) {
    assert(!texts.includes(name), `focus 外の ${name} が残っている`);
  }
  // focus 外の上位勢力名は残る（概観表示に落ちるだけで無名にはならない）
  for (const name of ["Papal States", "England", "Ottoman Empire"]) {
    assert(texts.includes(name), `focus 外の上位勢力 ${name} が消えている`);
  }
});

Deno.test("focus 外の base ラベル抑制は解除され二重ラベルも出ない（#348 AC3）", () => {
  const f = createPoliticalLayerBuilders();
  // Papal States は伊諸侯領にほぼ完全内包され、通常は base ラベルが抑制される
  const dedupe = { years: { "1000": { "Papal States": 1 } } };
  const focused = focusedLabelTexts(f, "France", dedupe);
  // focus 外なので伊諸侯領ラベル（Tuscany）は消え、代わりに上位勢力名が復活する
  assert(!focused.includes("Tuscany"));
  assertEquals(focused.filter((t) => t === "Papal States").length, 1);
  // focus が Papal States 側へ移れば従来どおり領邦名に譲る（二重にならない）
  const inFocus = focusedLabelTexts(f, "Papal States", dedupe);
  assert(inFocus.includes("Tuscany"));
  assert(!inFocus.includes("Papal States"));
});

Deno.test("focus が無いときのラベル出力は既存実装と一致する（#348 AC6）", () => {
  const f = createPoliticalLayerBuilders();
  const dedupe = { years: { "1000": { "Papal States": 1 } } };
  const build = (c: PoliticalLayerContext) =>
    f.buildLabelLayer(
      c,
      focusBaseFc,
      focusHreFc,
      focusFranceFiefsFc,
      focusItalyFiefsFc,
      focusCliopatriaFc,
      focusBritainFiefsFc,
      focusSovereignFiefsFc,
      "lower",
    );
  const plain = build(
    ctx({ zoomStep: POLITICAL_DETAIL_MIN_ZOOM, fiefDedupe: dedupe }),
  );
  const withBase = build(
    ctx({
      zoomStep: POLITICAL_DETAIL_MIN_ZOOM,
      fiefDedupe: dedupe,
      base: focusBaseFc,
      detailFocusKey: null,
    }),
  );
  // focus 無しでは配列そのものが同一参照（メモ化も従来どおり効く）
  assertStrictEquals(withBase.props.data, plain.props.data);
  const texts = (plain.props.data as LabelDatum[]).map((d) => d.text);
  for (const name of ["Bavaria", "Bohemia", "Tuscany", "Gwynedd"]) {
    assert(texts.includes(name), `${name} が既存表示から欠けている`);
  }
});

// ---- #350: powers の塗りデータ（focus 合成）とメモ化 ----

/**
 * 領邦 union を差し引いた派生 base（europe_flat_*）。focus 外でこれを塗ると
 * 差し引きの穴が透明に抜けるため、focus 外だけ素の base へ戻す（#347 AC3）。
 * 由来を判別できるよう ORIGIN を付ける（実データには無い検査用プロパティ）。
 */
const focusBaseFillFc: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    polygonFeature({ NAME: "France", ORIGIN: "flat" }, [0, 45]),
    polygonFeature({ NAME: "Papal States", ORIGIN: "flat" }, [10, 41]),
    polygonFeature({ NAME: "England", ORIGIN: "flat" }, [-4, 50]),
    polygonFeature({ NAME: "Ottoman Empire", ORIGIN: "flat" }, [26, 39]),
  ],
  // TASK-109: 出典 metadata は派生側のものを引き継ぐ（#347）
  metadata: { source: "europe_flat" },
} as FeatureCollection;

/** 合成後の feature を「NAME:由来」で並べる（base 由来は "base"） */
function fillOrigins(fc: FeatureCollection): string[] {
  return fc.features.map((f) =>
    `${String(f.properties?.NAME)}:${String(f.properties?.ORIGIN ?? "base")}`
  );
}

Deno.test("powerFillData は focus 外を素の base・focus 内を派生 base で合成する（#350 AC2/AC3）", () => {
  const f = createPoliticalLayerBuilders();
  const c = ctx({ zoomStep: 5, detailFocusKey: "France", base: focusBaseFc });
  const fill = f.powerFillData(c, focusBaseFc, focusBaseFillFc, true);
  assertEquals(fillOrigins(fill), [
    // focus 外 3 か国は差し引き前の base（穴なし・領邦由来の内部境界なし）
    "Papal States:base",
    "England:base",
    "Ottoman Empire:base",
    // focus 内だけ派生 base（領邦オーバーレイと二重塗りにならない）
    "France:flat",
  ]);
  // 出典 metadata は派生側を引き継ぐ（pick_handlers.ts の出典解決と一致）
  assertEquals(
    (fill as { metadata?: unknown }).metadata,
    { source: "europe_flat" },
  );
});

Deno.test("powerFillData は同じ入力で同一参照を返す（#350: hover ごとの再アップロード回避）", () => {
  const f = createPoliticalLayerBuilders();
  const c = ctx({ zoomStep: 5, detailFocusKey: "France", base: focusBaseFc });
  const first = f.powerFillData(c, focusBaseFc, focusBaseFillFc, true);
  // ホバー・選択の変化では context が作り直されるだけで入力の参照は変わらない
  const again = f.powerFillData(
    ctx({
      zoomStep: 5,
      detailFocusKey: "France",
      base: focusBaseFc,
      hoveredPowerKey: "France|",
    }),
    focusBaseFc,
    focusBaseFillFc,
    true,
  );
  assertStrictEquals(again, first);
  // focus が変われば当然作り直される
  assertNotStrictEquals(
    f.powerFillData(
      ctx({ zoomStep: 5, detailFocusKey: "England", base: focusBaseFc }),
      focusBaseFc,
      focusBaseFillFc,
      true,
    ),
    first,
  );
});

Deno.test("powerFillData は概観表示（z4）では focus を無視して素の base を返す（#350 AC8）", () => {
  const f = createPoliticalLayerBuilders();
  const c = ctx({ detailFocusKey: "France", base: focusBaseFc });
  assertStrictEquals(
    f.powerFillData(c, focusBaseFc, focusBaseFillFc, false),
    focusBaseFc,
  );
});

Deno.test("powerFillData は focus 無しなら派生 base を同一参照で返す（#350 AC10 の非退行）", () => {
  const f = createPoliticalLayerBuilders();
  assertStrictEquals(
    f.powerFillData(ctx({ zoomStep: 5 }), focusBaseFc, focusBaseFillFc, true),
    focusBaseFillFc,
  );
});

Deno.test("解決不能 focus では領邦が 1 枚も描かれず塗りが素の base になる（#350 AC5）", () => {
  const f = createPoliticalLayerBuilders();
  const c = ctx({
    zoomStep: 5,
    detailFocusKey: UNRESOLVED_DETAIL_FOCUS_KEY,
    base: focusBaseFc,
  });
  // 塗り: focus 内が空 = 全 feature が差し引き前の base（透明な穴が出ない）
  assertEquals(
    fillOrigins(f.powerFillData(c, focusBaseFc, focusBaseFillFc, true)),
    [
      "France:base",
      "Papal States:base",
      "England:base",
      "Ottoman Empire:base",
    ],
  );
  // オーバーレイ: 6 系統とも空 FC
  for (const [id, data] of FOCUS_OVERLAYS) {
    const layer = f.buildPowerLayer(c, id, data);
    assertEquals(
      (layer.props.data as FeatureCollection).features.length,
      0,
      `${id} に領邦が残っている`,
    );
  }
  // ラベル: 領邦名は 1 つも出ず、上位勢力名だけが残る
  const texts = focusedLabelTexts(f, UNRESOLVED_DETAIL_FOCUS_KEY);
  for (const name of ["Champagne", "Aquitaine", "Bavaria", "Bohemia"]) {
    assert(!texts.includes(name), `${name} が残っている`);
  }
  // 上位勢力名は残る（France は name-ja.json 適用で「フランス」）
  for (
    const name of ["フランス", "Papal States", "England", "Ottoman Empire"]
  ) {
    assert(texts.includes(name), `上位勢力 ${name} が消えている`);
  }
});

Deno.test("powerFillData は ctx.suzerainKeyOf で宗主補正を効かせる（#350）", () => {
  const f = createPoliticalLayerBuilders();
  // 補正: Papal States を France の封臣とみなす（renames まで効く注入経路）
  const overrides: SuzerainOverrides = {
    renames: {},
    suzerains: { "Papal States": "France" },
  };
  const c = ctx({
    zoomStep: 5,
    detailFocusKey: "France",
    base: focusBaseFc,
    overrides,
    suzerainKeyOf: (props) => resolveSuzerainKey(props, overrides),
  });
  assertEquals(
    fillOrigins(f.powerFillData(c, focusBaseFc, focusBaseFillFc, true)),
    [
      "England:base",
      "Ottoman Empire:base",
      "France:flat",
      "Papal States:flat",
    ],
  );
});
