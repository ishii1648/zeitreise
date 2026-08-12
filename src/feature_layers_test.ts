/**
 * feature_layers.ts のユニットテスト（TASK-147）。
 *
 * 検証する契約:
 * - labelLayerBaseProps: 衝突制御（extensions 2 段 + sizeScale）・不可視背景
 *   クアッド（TASK-143）・priority accessor が 1 箇所に集約されていること
 * - 各 builder が返すレイヤーの要点（id・pickable・判定半径・透明色・
 *   ピクセルオフセット等）が main.ts 時代の値と一致すること
 * - **メモ化の参照同値（TASK-50/136 の非退行。AC #4）**: hover/selection だけが
 *   変わる再構築では、deck.gl へ渡る data / characterSet の参照が前回と同一で
 *   あること（属性再計算・フォントアトラス再生成が走らない）
 * - **キャッシュ共有（debug_hooks.ts との契約）**: factory が公開するメモ化
 *   インスタンスは builder と同一キャッシュを共有し、builder 実行後に同じ
 *   引数で呼ぶと再計算なしで同一参照が返ること
 */
import { assert, assertEquals, assertNotStrictEquals } from "@std/assert";
import { assertStrictEquals } from "@std/assert";
import type { FeatureCollection } from "geojson";
import {
  createFeatureLayerBuilders,
  type FeatureLayerContext,
  labelLayerBaseProps,
} from "./feature_layers.ts";
import {
  COLLISION_SIZE_SCALE,
  LABEL_FONT_SETTINGS,
  LABEL_OUTLINE_COLOR,
  LABEL_OUTLINE_WIDTH,
  type LabelDatum,
} from "./labels.ts";
import { RIVER_HIT_LINE_COLOR, RIVER_HIT_LINE_WIDTH_PX } from "./rivers.ts";
import {
  MOUNTAIN_HIT_FILL_COLOR,
  MOUNTAIN_HIT_RADIUS_PX,
  MOUNTAIN_OUTLINE_LAYER_ID,
} from "./mountains.ts";
import {
  PEAK_HIT_FILL_COLOR,
  PEAK_HIT_RADIUS_PX,
  PEAK_LABEL_PIXEL_OFFSET,
  PEAK_MARKER_GLYPH,
} from "./peaks.ts";
import { CITY_HIT_FILL_COLOR, CITY_HIT_RADIUS_PX } from "./cities.ts";
import {
  CITY_LABEL_LAYER_ID,
  MOUNTAIN_LABEL_LAYER_ID,
  PEAK_LABEL_LAYER_ID,
  RIVER_LABEL_LAYER_ID,
} from "./layer_stack.ts";
import {
  CITY_HIT_LAYER_ID,
  CITY_LAYER_ID,
  MOUNTAIN_HIT_LAYER_ID,
  PEAK_HIT_LAYER_ID,
  PEAK_LAYER_ID,
  RIVERS_HIT_LAYER_ID,
  RIVERS_LAYER_ID,
} from "./picking.ts";

// ---- fixtures ----

/** 河川 2 本（LineString）。name は rivers.ts riverNameFor が読む契約キー */
const riversFc: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "Rhine" },
      geometry: {
        type: "LineString",
        coordinates: [[6, 47], [6.5, 49], [7, 51]],
      },
    },
    {
      type: "Feature",
      properties: { name: "Po" },
      geometry: {
        type: "LineString",
        coordinates: [[7, 45], [9, 45], [12, 45]],
      },
    },
  ],
};

/** 山脈 1 件（Polygon）。min_label=4 なので z4 から表示される */
const mountainsFc: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "Alps", scalerank: 1, min_label: 4 },
      geometry: {
        type: "Polygon",
        coordinates: [[[6, 45], [10, 45], [10, 47], [6, 47], [6, 45]]],
      },
    },
  ],
};

/** 山峰 1 件（Point）。scalerank=3 なので z4 から表示される */
const peaksFc: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "Mont Blanc", elevation: 4807, scalerank: 3 },
      geometry: { type: "Point", coordinates: [6.86, 45.83] },
    },
  ],
};

/** 都市 1 件（1000 年） */
// #222 の正規化形式（cities 配列 + 年別 [index, population] セル）
const citiesData = {
  cities: [{ name: "Paris", lon: 2.35, lat: 48.85, source: 0 }],
  years: { "1000": [[0, 20000]] },
};

const nameJa: Record<string, string> = { Rhine: "ライン川", Paris: "パリ" };

/** 全フィールドを埋めた context。テストごとに必要な部分だけ上書きする */
function ctx(
  overrides: Partial<FeatureLayerContext> = {},
): FeatureLayerContext {
  return {
    year: 1000,
    riversData: riversFc,
    mountainsData: mountainsFc,
    peaksData: peaksFc,
    citiesData,
    nameJa,
    zoomStep: 4,
    selectedRiverName: null,
    hoveredRiverName: null,
    selectedMountainName: null,
    hoveredMountainName: null,
    selectedPeakName: null,
    hoveredPeakName: null,
    ...overrides,
  };
}

// ---- labelLayerBaseProps ----

Deno.test("labelLayerBaseProps は衝突制御 2 段 + sizeScale + priority accessor を返す", () => {
  const props = labelLayerBaseProps();
  assertEquals(props.sizeUnits, "pixels");
  // CollisionFilterExtension + 二値化 extension の 2 段（順序契約は
  // label_collision.ts labelCollisionExtensions が唯一の入口）
  assertEquals(props.extensions.length, 2);
  assertEquals(props.collisionTestProps, { sizeScale: COLLISION_SIZE_SCALE });
  // TASK-143: 自己衝突対策の不可視背景クアッドが labelTextStyleProps の
  // background: false を上書きしている（スプレッド順の契約）
  assertEquals(props.background, true);
  const d = { priority: 42 } as unknown as LabelDatum;
  assertEquals(props.getCollisionPriority(d), 42);
});

// ---- builder が返すレイヤーの要点 ----

Deno.test("注記ラベル層（都市・河川・山岳・山峰）は共通の SDF 設定と halo を保つ（#322）", () => {
  // #322 は勢力ラベルだけに専用 fontSettings / outlineWidth を与える。
  // 注記ラベルの共通クリーム halo と共有フォントアトラスは変えない。
  const f = createFeatureLayerBuilders();
  const c = ctx();
  const layers = [
    f.buildCityLabelLayer(c),
    f.buildRiverLabelLayer(c),
    f.buildMountainLabelLayer(c),
    f.buildPeakLabelLayer(c),
    f.buildPeakMarkerLayer(c),
  ];
  for (const layer of layers) {
    const props = (layer as unknown as {
      props: {
        fontSettings: unknown;
        outlineWidth: number;
        outlineColor: number[];
      };
    }).props;
    assertStrictEquals(
      props.fontSettings,
      LABEL_FONT_SETTINGS,
      `${layer.id} は共通 fontSettings を使うはず`,
    );
    assertEquals(
      props.outlineWidth,
      LABEL_OUTLINE_WIDTH,
      `${layer.id} は共通 outlineWidth を使うはず`,
    );
    assertEquals(
      props.outlineColor,
      [...LABEL_OUTLINE_COLOR],
      `${layer.id} は共通クリーム halo を使うはず`,
    );
  }
});

Deno.test("12 builder の id・pickable が main.ts 時代の契約と一致する", () => {
  const f = createFeatureLayerBuilders();
  const c = ctx();
  const expectations: [string, boolean, { id: string }][] = [
    [RIVERS_LAYER_ID, true, f.buildRiversLineLayer(c)],
    [RIVERS_HIT_LAYER_ID, true, f.buildRiversHitLayer(c)],
    [RIVER_LABEL_LAYER_ID, false, f.buildRiverLabelLayer(c)],
    [MOUNTAIN_LABEL_LAYER_ID, false, f.buildMountainLabelLayer(c)],
    [MOUNTAIN_HIT_LAYER_ID, true, f.buildMountainHitLayer(c)],
    [MOUNTAIN_OUTLINE_LAYER_ID, false, f.buildMountainOutlineLayer(c)],
    [PEAK_LAYER_ID, true, f.buildPeakMarkerLayer(c)],
    [PEAK_HIT_LAYER_ID, true, f.buildPeakHitLayer(c)],
    [PEAK_LABEL_LAYER_ID, false, f.buildPeakLabelLayer(c)],
    [CITY_LAYER_ID, true, f.buildCityMarkerLayer(c)],
    [CITY_HIT_LAYER_ID, true, f.buildCityHitLayer(c)],
    [CITY_LABEL_LAYER_ID, false, f.buildCityLabelLayer(c)],
  ];
  for (const [id, pickable, layer] of expectations) {
    assertEquals(layer.id, id);
    assertEquals(
      (layer as unknown as { props: { pickable: boolean } }).props.pickable,
      pickable,
      `${id} の pickable`,
    );
  }
});

Deno.test("rivers 表示ラインは riversData をそのまま参照する", () => {
  const f = createFeatureLayerBuilders();
  const layer = f.buildRiversLineLayer(ctx());
  assertStrictEquals(layer.props.data, riversFc);
});

Deno.test("rivers-hit は透明・14px の判定専用ライン", () => {
  const f = createFeatureLayerBuilders();
  const layer = f.buildRiversHitLayer(ctx());
  assertStrictEquals(layer.props.data, riversFc);
  assertEquals(layer.props.getLineWidth, RIVER_HIT_LINE_WIDTH_PX);
  assertEquals(layer.props.getLineColor, RIVER_HIT_LINE_COLOR);
});

Deno.test("山脈/山峰/都市の判定層は透明色・規定半径の円", () => {
  const f = createFeatureLayerBuilders();
  const c = ctx();
  const mountainHit = f.buildMountainHitLayer(c);
  assertEquals(mountainHit.props.getRadius, MOUNTAIN_HIT_RADIUS_PX);
  assertEquals(mountainHit.props.getFillColor, MOUNTAIN_HIT_FILL_COLOR);
  const peakHit = f.buildPeakHitLayer(c);
  assertEquals(peakHit.props.getRadius, PEAK_HIT_RADIUS_PX);
  assertEquals(peakHit.props.getFillColor, PEAK_HIT_FILL_COLOR);
  const cityHit = f.buildCityHitLayer(c);
  assertEquals(cityHit.props.getRadius, CITY_HIT_RADIUS_PX);
  assertEquals(cityHit.props.getFillColor, CITY_HIT_FILL_COLOR);
});

Deno.test("山峰マーカーは ▲ グリフ・ラベルは規定のピクセルオフセット", () => {
  const f = createFeatureLayerBuilders();
  const c = ctx();
  const marker = f.buildPeakMarkerLayer(c);
  const getText = marker.props.getText as () => string;
  assertEquals(getText(), PEAK_MARKER_GLYPH);
  const label = f.buildPeakLabelLayer(c);
  assertEquals(label.props.getPixelOffset, [...PEAK_LABEL_PIXEL_OFFSET]);
  const cityLabel = f.buildCityLabelLayer(c);
  assertEquals(cityLabel.props.getPixelOffset, [0, -10]);
});

// ---- メモ化の参照同値（AC #4。TASK-50/136 の非退行）----

Deno.test("hover 連続移動では river ラベルのアンカー・characterSet が再計算されない", () => {
  const f = createFeatureLayerBuilders();
  const first = f.buildRiverLabelLayer(ctx({ hoveredRiverName: null }));
  const second = f.buildRiverLabelLayer(ctx({ hoveredRiverName: "Rhine" }));
  // characterSet は全河川分のメモ化結果（同一参照）を渡し続ける契約
  // （フォントアトラスが作り直されない）
  assertStrictEquals(second.props.characterSet, first.props.characterSet);
  // アンカー生成（riverLabelAnchors）もキャッシュに当たり続ける
  const memoized = f.memoizedRiverLabelData(
    riversFc,
    nameJa,
    f.memoizedCityAvoidPoints(citiesData),
  );
  assertStrictEquals(memoized.characterSet, first.props.characterSet);
});

Deno.test("同一状態の再構築では river ラベルの data 参照も安定する", () => {
  const f = createFeatureLayerBuilders();
  const first = f.buildRiverLabelLayer(ctx());
  const second = f.buildRiverLabelLayer(ctx());
  assertStrictEquals(second.props.data, first.props.data);
});

Deno.test("hover 変化だけの再構築では山岳・都市の data 参照が安定する", () => {
  const f = createFeatureLayerBuilders();
  const before = ctx();
  const after = ctx({
    hoveredRiverName: "Rhine",
    hoveredMountainName: "Alps",
    hoveredPeakName: "Mont Blanc",
  });
  assertStrictEquals(
    f.buildMountainHitLayer(after).props.data,
    f.buildMountainHitLayer(before).props.data,
  );
  assertStrictEquals(
    f.buildPeakMarkerLayer(after).props.data,
    f.buildPeakMarkerLayer(before).props.data,
  );
  assertStrictEquals(
    f.buildPeakHitLayer(after).props.data,
    f.buildPeakHitLayer(before).props.data,
  );
  assertStrictEquals(
    f.buildPeakLabelLayer(after).props.data,
    f.buildPeakLabelLayer(before).props.data,
  );
  assertStrictEquals(
    f.buildCityMarkerLayer(after).props.data,
    f.buildCityMarkerLayer(before).props.data,
  );
  assertStrictEquals(
    f.buildCityHitLayer(after).props.data,
    f.buildCityHitLayer(before).props.data,
  );
  assertStrictEquals(
    f.buildCityLabelLayer(after).props.data,
    f.buildCityLabelLayer(before).props.data,
  );
  assertStrictEquals(
    f.buildCityLabelLayer(after).props.characterSet,
    f.buildCityLabelLayer(before).props.characterSet,
  );
  // 山脈/山峰ラベルの characterSet も同一参照（全件分のメモ化結果）
  assertStrictEquals(
    f.buildMountainLabelLayer(after).props.characterSet,
    f.buildMountainLabelLayer(before).props.characterSet,
  );
  assertStrictEquals(
    f.buildPeakLabelLayer(after).props.characterSet,
    f.buildPeakLabelLayer(before).props.characterSet,
  );
});

Deno.test("ズーム段の変化では都市の data が再計算される（メモ化キーに含まれる）", () => {
  const f = createFeatureLayerBuilders();
  const z4 = f.buildCityMarkerLayer(ctx({ zoomStep: 4 }));
  const z5 = f.buildCityMarkerLayer(ctx({ zoomStep: 5 }));
  assertNotStrictEquals(z5.props.data, z4.props.data);
});

// ---- キャッシュ共有（debug_hooks.ts へ注入するインスタンスとの契約）----

Deno.test("公開メモ化インスタンスは builder と同一キャッシュを共有する", () => {
  const f = createFeatureLayerBuilders();
  const c = ctx();
  // builder 実行でキャッシュが埋まり、同じ引数の直接呼び出しは同一参照を返す
  // （別インスタンスなら初回計算で新しいオブジェクトが返り、この assert は落ちる）
  const mountainLayer = f.buildMountainLabelLayer(c);
  assertStrictEquals(
    f.memoizedMountainLabelData(mountainsFc, nameJa).characterSet,
    mountainLayer.props.characterSet,
  );
  const peakMarker = f.buildPeakMarkerLayer(c);
  assertStrictEquals(
    f.memoizedPeakMarkerData(
      f.memoizedVisiblePeaks(f.memoizedPeakEntries(peaksFc), 4),
    ),
    peakMarker.props.data,
  );
  const cityLabel = f.buildCityLabelLayer(c);
  // #223: ラベルデータは年を受け取り歴史名区間を反映するため、メモ化キーにも
  // year が入る（builder が ctx.year を渡していることをここで固定する）
  assertStrictEquals(
    f.memoizedCityLabelData(
      f.memoizedVisibleCityEntries(citiesData, 1000, 4),
      nameJa,
      1000,
    ).data,
    cityLabel.props.data,
  );
});

Deno.test("factory ごとにキャッシュは独立している", () => {
  const f1 = createFeatureLayerBuilders();
  const f2 = createFeatureLayerBuilders();
  const avoid1 = f1.memoizedCityAvoidPoints(citiesData);
  const avoid2 = f2.memoizedCityAvoidPoints(citiesData);
  assertNotStrictEquals(avoid1, avoid2);
  // それぞれのキャッシュは自分の直近結果を返し続ける
  assertStrictEquals(f1.memoizedCityAvoidPoints(citiesData), avoid1);
  assertStrictEquals(f2.memoizedCityAvoidPoints(citiesData), avoid2);
});

Deno.test("河川ラインの色・幅は選択/ホバー状態を updateTriggers に載せる", () => {
  const f = createFeatureLayerBuilders();
  const layer = f.buildRiversLineLayer(
    ctx({ selectedRiverName: "Po", hoveredRiverName: "Rhine" }),
  );
  const triggers = layer.props.updateTriggers as Record<string, unknown>;
  assertEquals(triggers.getLineColor, ["Po", "Rhine"]);
  assertEquals(triggers.getLineWidth, ["Po", "Rhine"]);
  assert(layer.props.pickable);
});
