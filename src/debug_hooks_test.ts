/**
 * debug_hooks.ts のユニットテスト（TASK-144）。
 *
 * 検証する契約:
 * - installDebugHooks が 15 件のフック名（scripts/verify のヘッドレス検証が
 *   依存する globalThis 上のプロパティ名）を全てターゲットに定義すること
 * - 各フックが deps（getter・関数の注入）経由で main.ts 所有の状態を読むこと
 * - 二重インストール時は後勝ちで上書きされること（従来の代入と同じ挙動）
 *
 * フックの返り値の「形」はヘッドレス検証（scripts/verify/checks/*）の契約
 * なので、キー名まで含めて assert する。
 */
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import type { FeatureCollection } from "geojson";
import type { PickingInfo } from "@deck.gl/core";
import {
  DEBUG_HOOK_NAMES,
  type DebugHookDeps,
  type DebugHooksTarget,
  type DebugYearView,
  installDebugHooks,
} from "./debug_hooks.ts";
import { EMPTY_FEATURE_COLLECTION } from "./powers.ts";
import { EMPTY_FIEF_DEDUPE_TABLE } from "./fief_dedupe.ts";
import {
  detailFocusKeyForZoom,
  EMPTY_SUZERAIN_OVERRIDES,
} from "./suzerain_extent.ts";
import {
  cityEntriesForYear,
  filterCitiesByZoom,
  visibleCityRankLimit,
} from "./cities.ts";
import { ACTIVE_FILL_COLOR } from "./power_highlight.ts";
import {
  BRITAIN_FIEF_LAYER_ID,
  CLIOPATRIA_FIEF_LAYER_ID,
  FRANCE_FIEF_LAYER_ID,
  HRE_LAYER_ID,
  ITALY_FIEF_LAYER_ID,
  POWER_LAYER_ID,
  SOVEREIGN_FIEF_LAYER_ID,
} from "./picking.ts";
import { FRANCE_FIEF_OVERLAY_YEARS } from "./config.ts";

/** 全フィールドを埋めたスタブ deps。テストごとに必要な部分だけ上書きする */
function stubDeps(overrides: Partial<DebugHookDeps> = {}): DebugHookDeps {
  return {
    switchYear: () => Promise.resolve(),
    currentYear: () => 1000,
    getZoomStep: () => 4,
    getCurrentView: () => null,
    getNameJa: () => ({}),
    getOverrides: () => EMPTY_SUZERAIN_OVERRIDES,
    getFiefDedupe: () => EMPTY_FIEF_DEDUPE_TABLE,
    getCitiesData: () => ({ cities: [], years: {} }),
    getMountainsData: () => EMPTY_FEATURE_COLLECTION,
    getPeaksData: () => EMPTY_FEATURE_COLLECTION,
    getRiversData: () => EMPTY_FEATURE_COLLECTION,
    getApproximateBorderData: () => EMPTY_FEATURE_COLLECTION,
    getHoveredRiverName: () => null,
    getSelectedRiverName: () => null,
    getExtentKey: () => null,
    powerHighlight: { selected: () => null, hovered: () => null },
    detailFocus: { key: () => null, center: () => null },
    getDetailFocusKey: () => null,
    suzerainKeyOf: () => null,
    memoizedSuzerainClassifier: () => () => null,
    project: ([lon, lat]) => ({ x: lon * 10, y: lat * 10 }),
    getStyleSource: () => undefined,
    currentStyleLayerIds: () => [],
    pickObject: () => null,
    resolveClickInfo: (info) => info,
    pickedLabel: () => null,
    collectionMetadata: (data) =>
      (data as { metadata?: unknown } | null | undefined)?.metadata,
    memoizedMountainLabelData: () => ({ data: [] }),
    memoizedPeakEntries: () => [],
    memoizedVisiblePeaks: (entries) => entries,
    memoizedPeakLabelData: () => [],
    memoizedPowerLabelData: () => ({ data: [], characterSet: [] }),
    memoizedVisiblePowerLabels: (data) => data,
    memoizedCityAvoidPoints: () => [],
    memoizedRiverLabelData: () => ({ data: [] }),
    memoizedVisibleCityEntries: () => [],
    ...overrides,
  };
}

Deno.test("DEBUG_HOOK_NAMES はヘッドレス検証の契約 19 件と一致する", () => {
  assertEquals([...DEBUG_HOOK_NAMES], [
    "__setYear",
    "__getYear",
    "__getCityDebug",
    "__getMountainLabelDebug",
    "__getPeakDebug",
    "__getPowerLabelDebug",
    "__getRiverLabelDebug",
    "__getFranceFiefDebug",
    "__getHreFiefDebug",
    "__getItalyFiefDebug",
    "__getCliopatriaFiefDebug",
    "__getBritainFiefDebug",
    "__getSovereignFiefDebug",
    "__getApproximateBorderDebug",
    "__probePick",
    "__getPowerHighlightDebug",
    "__getCityScreenPositions",
    // #345: 追加のみ（既存 17 件の名前・意味は変えない）
    "__getDetailFocusDebug",
    // #350: 追加のみ（既存 18 件の名前・意味は変えない）
    "__getDetailFocusRenderDebug",
  ]);
});

Deno.test("installDebugHooks: 19 件のフックを全てターゲットへ定義する", () => {
  const target: DebugHooksTarget = {};
  installDebugHooks(stubDeps(), target);
  for (const name of DEBUG_HOOK_NAMES) {
    assertEquals(
      typeof (target as Record<string, unknown>)[name],
      "function",
      `${name} が定義されていない`,
    );
  }
});

Deno.test("installDebugHooks: ターゲット省略時は globalThis に定義する", () => {
  const g = globalThis as Record<string, unknown>;
  try {
    installDebugHooks(stubDeps({ currentYear: () => 1234 }));
    assertEquals((g.__getYear as () => number)(), 1234);
  } finally {
    for (const name of DEBUG_HOOK_NAMES) delete g[name];
  }
});

Deno.test("二重インストールは後勝ちで上書きされる（従来の代入と同じ）", () => {
  const target: DebugHooksTarget = {};
  installDebugHooks(stubDeps({ currentYear: () => 1000 }), target);
  installDebugHooks(stubDeps({ currentYear: () => 1500 }), target);
  assertEquals(target.__getYear?.(), 1500);
});

Deno.test("__setYear は deps.switchYear へそのまま委譲する", async () => {
  const calls: number[] = [];
  const target: DebugHooksTarget = {};
  installDebugHooks(
    stubDeps({
      switchYear: (year) => {
        calls.push(year);
        return Promise.resolve();
      },
    }),
    target,
  );
  await target.__setYear?.(1500);
  assertEquals(calls, [1500]);
});

Deno.test("__getCityDebug: 現在年・ズーム段のフィルタ結果を返す", () => {
  // #222 の正規化形式（cities 配列 + 年別 [index, population] セル）
  const citiesData = {
    cities: [
      { name: "Paris", lon: 2.35, lat: 48.85, source: 0 },
      { name: "Rouen", lon: 1.1, lat: 49.44, source: 0 },
    ],
    years: { "1000": [[0, 100_000], [1, 30_000]] },
  };
  const target: DebugHooksTarget = {};
  installDebugHooks(
    stubDeps({
      currentYear: () => 1000,
      getZoomStep: () => 5,
      getCitiesData: () => citiesData,
    }),
    target,
  );
  const info = target.__getCityDebug?.();
  const expected = cityEntriesForYear(citiesData, 1000);
  assertEquals(info, {
    zoomStep: 5,
    rankLimit: visibleCityRankLimit(5),
    totalCities: expected.length,
    visibleCities: filterCitiesByZoom(expected, 5).length,
  });
});

Deno.test("__getMountainLabelDebug: 可視ラベルと deps.project の画面座標を返す", () => {
  const anchors = [
    {
      name: "Alps",
      text: "アルプス山脈",
      minZoom: 4,
      position: [10, 45] as [number, number],
      priority: 50,
    },
    {
      name: "Jura",
      text: "ジュラ山脈",
      minZoom: 7,
      position: [6, 46.5] as [number, number],
      priority: 40,
    },
  ];
  const target: DebugHooksTarget = {};
  installDebugHooks(
    stubDeps({
      getZoomStep: () => 4,
      memoizedMountainLabelData: () => ({ data: anchors }),
    }),
    target,
  );
  const info = target.__getMountainLabelDebug?.();
  assertEquals(info, {
    zoomStep: 4,
    totalMountains: 2,
    // minZoom 7 の Jura は z4 では出ない（filterVisibleMountainLabels）
    visibleLabels: [{ name: "Alps", text: "アルプス山脈", minZoom: 4 }],
    screen: [{ name: "Alps", x: 100, y: 450 }],
  });
});

Deno.test("__getRiverLabelDebug: hovered/selected と可視ラベル・アンカーを返す", () => {
  const anchors = [
    {
      name: "Rhine",
      text: "ライン川",
      position: [7.6, 47.6] as [number, number],
      priority: 0,
    },
  ];
  const target: DebugHooksTarget = {};
  installDebugHooks(
    stubDeps({
      getZoomStep: () => 4,
      getHoveredRiverName: () => "Rhine",
      memoizedRiverLabelData: () => ({ data: anchors }),
    }),
    target,
  );
  const info = target.__getRiverLabelDebug?.();
  // priority 0 でもホバー中の河川は必ず可視（filterVisibleRiverLabels の契約）
  assertEquals(info, {
    hovered: "Rhine",
    selected: null,
    zoomStep: 4,
    visibleLabels: ["Rhine"],
    visibleAnchors: [{ name: "Rhine", position: [7.6, 47.6] }],
  });
});

Deno.test("__getFranceFiefDebug: 対象年判定と feature 数を返す", () => {
  const overlayYear = FRANCE_FIEF_OVERLAY_YEARS[0];
  const fiefs: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { NAME: "Normandy" },
        geometry: {
          type: "Polygon",
          coordinates: [[[0, 49], [1, 49], [1, 50], [0, 50], [0, 49]]],
        },
      },
    ],
  };
  const target: DebugHooksTarget = {};
  installDebugHooks(
    stubDeps({
      currentYear: () => overlayYear,
      getCurrentView: () => ({
        year: overlayYear,
        base: EMPTY_FEATURE_COLLECTION,
        baseFill: EMPTY_FEATURE_COLLECTION,
        hre: EMPTY_FEATURE_COLLECTION,
        fiefs,
        italyFiefs: EMPTY_FEATURE_COLLECTION,
        cliopatriaFiefs: EMPTY_FEATURE_COLLECTION,
        britainFiefs: EMPTY_FEATURE_COLLECTION,
        sovereignFiefs: EMPTY_FEATURE_COLLECTION,
        hreRealm: EMPTY_FEATURE_COLLECTION,
      }),
    }),
    target,
  );
  const info = target.__getFranceFiefDebug?.();
  assertEquals(info?.year, overlayYear);
  assertEquals(info?.overlay, true);
  assertEquals(info?.featureCount, 1);
  assertEquals(info?.labels.length, 1);
});

Deno.test("__getPowerLabelDebug: 表示モード（politicalDetail）を公開する（#228 AC1/AC10）", () => {
  // z4 = 概観（politicalDetail: false）・z5 = 詳細（true）。ヘッドレス検証は
  // このフィールドで「塗り・境界・picking がどちらのモードか」を無人確認する
  const overview: DebugHooksTarget = {};
  installDebugHooks(stubDeps({ getZoomStep: () => 4 }), overview);
  assertEquals(overview.__getPowerLabelDebug?.().politicalDetail, false);
  assertEquals(overview.__getPowerLabelDebug?.().fiefLabelsVisible, false);
  const detail: DebugHooksTarget = {};
  installDebugHooks(stubDeps({ getZoomStep: () => 5 }), detail);
  assertEquals(detail.__getPowerLabelDebug?.().politicalDetail, true);
  assertEquals(detail.__getPowerLabelDebug?.().fiefLabelsVisible, true);
});

Deno.test("__getPowerLabelDebug: 3 段階の表示レベル（politicalLevel）を公開する（#267 AC1）", () => {
  // z4 = overview / z5〜6 = mid / z7〜8 = detail。ヘッドレス検証（AC12）が
  // 各撮影ズームのレベルを無人確認するためのフィールド（追加のみ）
  for (
    const [zoom, level] of [
      [4, "overview"],
      [5, "mid"],
      [6, "mid"],
      [7, "detail"],
      [8, "detail"],
    ] as const
  ) {
    const target: DebugHooksTarget = {};
    installDebugHooks(stubDeps({ getZoomStep: () => zoom }), target);
    assertEquals(
      target.__getPowerLabelDebug?.().politicalLevel,
      level,
      `zoom ${zoom}`,
    );
  }
});

Deno.test("__getPowerHighlightDebug: powers の件数は表示モードの塗りデータから数える（#228 AC2）", () => {
  const franceFeature = (suffix: string) => ({
    type: "Feature" as const,
    properties: { NAME: "France", ID: suffix },
    geometry: {
      type: "Polygon" as const,
      coordinates: [[[0, 45], [2, 45], [2, 47], [0, 47], [0, 45]]],
    },
  });
  const view = {
    year: 1200,
    base: {
      type: "FeatureCollection" as const,
      features: [franceFeature("base")],
    },
    // 派生 base（領邦差し引き済み）には France の面が 2 枚ある想定
    baseFill: {
      type: "FeatureCollection" as const,
      features: [franceFeature("fill-1"), franceFeature("fill-2")],
    },
    hre: EMPTY_FEATURE_COLLECTION,
    fiefs: EMPTY_FEATURE_COLLECTION,
    italyFiefs: EMPTY_FEATURE_COLLECTION,
    cliopatriaFiefs: EMPTY_FEATURE_COLLECTION,
    britainFiefs: EMPTY_FEATURE_COLLECTION,
    sovereignFiefs: EMPTY_FEATURE_COLLECTION,
    hreRealm: EMPTY_FEATURE_COLLECTION,
  };
  const deps = (zoomStep: number) =>
    stubDeps({
      getCurrentView: () => view,
      getZoomStep: () => zoomStep,
      powerHighlight: { selected: () => "France", hovered: () => null },
    });
  // 詳細（z5）: powers が実際に塗るのは baseFill なのでそちらを数える
  const detail: DebugHooksTarget = {};
  installDebugHooks(deps(5), detail);
  assertEquals(
    detail.__getPowerHighlightDebug?.().activeFeatures[POWER_LAYER_ID],
    2,
  );
  // 概観（z4）: 塗りは素の base に切り替わるため base 側を数える
  const overview: DebugHooksTarget = {};
  installDebugHooks(deps(4), overview);
  assertEquals(
    overview.__getPowerHighlightDebug?.().activeFeatures[POWER_LAYER_ID],
    1,
  );
});

Deno.test("__probePick: pick 結果なしでも null 4 値の形で返す", () => {
  const target: DebugHooksTarget = {};
  installDebugHooks(stubDeps({ pickObject: () => null }), target);
  assertEquals(target.__probePick?.(10, 20), {
    hoverLayer: null,
    hoverLabel: null,
    clickLayer: null,
    clickLabel: null,
  });
});

Deno.test("__probePick: hover は生 pick・click は resolveClickInfo 経由", () => {
  const raw = { layer: { id: "rivers-hit" }, object: {} } as PickingInfo;
  const resolved = { layer: { id: "rivers" }, object: {} } as PickingInfo;
  const pickArgs: { x: number; y: number; radius: number }[] = [];
  const target: DebugHooksTarget = {};
  installDebugHooks(
    stubDeps({
      pickObject: (opts) => {
        pickArgs.push(opts);
        return raw;
      },
      resolveClickInfo: (info) => {
        assertStrictEquals(info, raw);
        return resolved;
      },
      pickedLabel: (info) => (info === raw ? "ライン川(raw)" : "ライン川"),
    }),
    target,
  );
  assertEquals(target.__probePick?.(10, 20), {
    hoverLayer: "rivers-hit",
    hoverLabel: "ライン川(raw)",
    clickLayer: "rivers",
    clickLabel: "ライン川",
  });
  // Deck の onHover と同じ pickingRadius 付きで 1 回だけ pick する
  assertEquals(pickArgs.length, 1);
  assertEquals(pickArgs[0].x, 10);
  assertEquals(pickArgs[0].y, 20);
  assert(pickArgs[0].radius > 0);
});

Deno.test("__getPowerHighlightDebug: view なしでは全レイヤー 0 件を返す", () => {
  const target: DebugHooksTarget = {};
  installDebugHooks(stubDeps(), target);
  const info = target.__getPowerHighlightDebug?.();
  assertEquals(info, {
    selected: null,
    hovered: null,
    activeColor: [...ACTIVE_FILL_COLOR],
    activeFeatures: {
      [POWER_LAYER_ID]: 0,
      [HRE_LAYER_ID]: 0,
      [FRANCE_FIEF_LAYER_ID]: 0,
      [ITALY_FIEF_LAYER_ID]: 0,
      [CLIOPATRIA_FIEF_LAYER_ID]: 0,
      [BRITAIN_FIEF_LAYER_ID]: 0,
      [SOVEREIGN_FIEF_LAYER_ID]: 0,
    },
    extentKey: null,
    extentMembers: [],
    extentRealmMembers: [],
  });
});

Deno.test("__getCityScreenPositions: 可視都市を deps.project で画面座標へ写す", () => {
  const target: DebugHooksTarget = {};
  const requested: [number, number, number][] = [];
  installDebugHooks(
    stubDeps({
      currentYear: () => 1500,
      getZoomStep: () => 6,
      memoizedVisibleCityEntries: (_data, year, zoomStep) => {
        requested.push([0, year, zoomStep]);
        return [
          {
            name: "Paris",
            lon: 2,
            lat: 48,
            population: 200_000,
            natureOfEstimate: null,
            source: 0,
          },
        ];
      },
    }),
    target,
  );
  assertEquals(target.__getCityScreenPositions?.(), [
    { name: "Paris", x: 20, y: 480 },
  ]);
  // 現在年・現在ズーム段で（呼び出し時点の値で）絞り込む
  assertEquals(requested, [[0, 1500, 6]]);
});

Deno.test("__getDetailFocusDebug: 現在の focus と解決に使った中央座標を返す（#345）", () => {
  const target: DebugHooksTarget = {};
  installDebugHooks(
    stubDeps({
      detailFocus: {
        key: () => "Holy Roman Empire",
        center: () => [11.5, 48.1],
      },
    }),
    target,
  );
  assertEquals(target.__getDetailFocusDebug?.(), {
    key: "Holy Roman Empire",
    center: [11.5, 48.1],
  });
});

Deno.test("__getDetailFocusDebug: focus 無し（海上・年代未確定）は null を返す（#345）", () => {
  const target: DebugHooksTarget = {};
  installDebugHooks(stubDeps(), target);
  assertEquals(target.__getDetailFocusDebug?.(), { key: null, center: null });
});

// ---- #350: __getDetailFocusRenderDebug（描画へ効いた focus の観測） ----

/** 宗主キーを properties の SUZ で決める検査用 view（幾何に依らない） */
function focusView(): DebugYearView {
  const f = (NAME: string, SUZ: string, ORIGIN?: string) => ({
    type: "Feature" as const,
    properties: ORIGIN === undefined ? { NAME, SUZ } : { NAME, SUZ, ORIGIN },
    geometry: { type: "Point" as const, coordinates: [0, 0] },
  });
  const fc = (features: ReturnType<typeof f>[]) => ({
    type: "FeatureCollection" as const,
    features,
  });
  return {
    year: 1300,
    base: fc([f("France", "France"), f("Papal States", "Papal States")]),
    baseFill: fc([
      f("France", "France", "flat"),
      f("Papal States", "Papal States", "flat"),
    ]),
    hre: fc([f("Bavaria", "Holy Roman Empire")]),
    fiefs: fc([f("Champagne", "France")]),
    italyFiefs: fc([f("Tuscany", "Papal States")]),
    cliopatriaFiefs: fc([f("Aquitaine", "France"), f("Bohemia", "HRE")]),
    britainFiefs: EMPTY_FEATURE_COLLECTION,
    sovereignFiefs: EMPTY_FEATURE_COLLECTION,
    hreRealm: EMPTY_FEATURE_COLLECTION,
  };
}

/** SUZ プロパティを読むだけの分類器（political_layers の分類器と同型） */
const suzOf = (props: unknown): string | null => {
  const suz = (props as { SUZ?: unknown } | null | undefined)?.SUZ;
  return typeof suz === "string" ? suz : null;
};

function focusDeps(
  zoomStep: number,
  key: string | null,
): Partial<DebugHookDeps> {
  return {
    getCurrentView: focusView,
    getZoomStep: () => zoomStep,
    detailFocus: { key: () => key, center: () => [2, 47] },
    getDetailFocusKey: () => detailFocusKeyForZoom(key, zoomStep),
    suzerainKeyOf: suzOf,
    memoizedSuzerainClassifier: () => (feature) => suzOf(feature.properties),
  };
}

Deno.test("__getDetailFocusRenderDebug: focus 内の領邦だけが描画対象になる（#350 AC1/AC3）", () => {
  const target: DebugHooksTarget = {};
  installDebugHooks(stubDeps(focusDeps(6, "France")), target);
  const info = target.__getDetailFocusRenderDebug?.();
  assertEquals(info?.key, "France");
  assertEquals(info?.focusActive, true);
  assertEquals(info?.zoomStep, 6);
  assertEquals(info?.byLayer, {
    "hre-powers": 0,
    "france-fiefs": 1,
    "italy-fiefs": 0,
    "cliopatria-fiefs": 1,
    "britain-fiefs": 0,
    "sovereign-fiefs": 0,
  });
  // AC1: 領邦が描かれる上位勢力は最大 1 件
  assertEquals(info?.suzerainKeysDrawn, ["France"]);
  // AC2: 合成後の塗り = focus 外 base ∪ focus 内 flat
  assertEquals(info?.powerFill, {
    featureCount: 2,
    baseOutsideCount: 1,
    detailInsideCount: 1,
  });
});

Deno.test("__getDetailFocusRenderDebug: 概観（z4）では focus が効かない（#350 AC8）", () => {
  const target: DebugHooksTarget = {};
  installDebugHooks(stubDeps(focusDeps(4, "France")), target);
  const info = target.__getDetailFocusRenderDebug?.();
  assertEquals(info?.key, null);
  assertEquals(info?.focusActive, false);
  // 概観では領邦オーバーレイが visible: false（描画対象 0 件）
  assertEquals(info?.suzerainKeysDrawn, []);
  // 塗りは素の base（powerFillDataForMode の概観経路）
  assertEquals(info?.powerFill.featureCount, 2);
  assertEquals(info?.powerFill.detailInsideCount, 0);
});

Deno.test("__getDetailFocusRenderDebug: 中央が海上なら領邦を 1 枚も描かない（#350 AC5）", () => {
  const target: DebugHooksTarget = {};
  installDebugHooks(stubDeps(focusDeps(6, null)), target);
  const info = target.__getDetailFocusRenderDebug?.();
  assertEquals(info?.key, null);
  assertEquals(info?.focusActive, true);
  assertEquals(info?.suzerainKeysDrawn, []);
  assertEquals(Object.values(info?.byLayer ?? {}), [0, 0, 0, 0, 0, 0]);
  // 透明な穴が出ないよう、塗りは全 feature が差し引き前の base
  assertEquals(info?.powerFill, {
    featureCount: 2,
    baseOutsideCount: 2,
    detailInsideCount: 0,
  });
});

Deno.test("__getApproximateBorderDebug: 段ごとの run 数と最長 run を集計する", () => {
  const borderData: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { tier: "snapshot", maxSegmentKm: 12.5 },
        geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
      },
      {
        type: "Feature",
        properties: { tier: "snapshot", maxSegmentKm: 3 },
        geometry: { type: "LineString", coordinates: [[1, 1], [2, 2]] },
      },
      {
        type: "Feature",
        properties: { tier: "interpolated", maxSegmentKm: 7 },
        geometry: { type: "LineString", coordinates: [[2, 2], [3, 3]] },
      },
    ],
  };
  const target: DebugHooksTarget = {};
  installDebugHooks(
    stubDeps({ getApproximateBorderData: () => borderData }),
    target,
  );
  const info = target.__getApproximateBorderDebug?.();
  assertEquals(info?.runsByTier, { snapshot: 2, interpolated: 1 });
  assertEquals(info?.longestRunKm, 12.5);
  assertEquals(info?.sourcePresent, false);
});
