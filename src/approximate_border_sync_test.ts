/**
 * approximate_border_sync.ts のユニットテスト（TASK-150 / Issue #168）。
 *
 * 検証する契約:
 * - ファクトリが styledata 購読を組み立て、発火で source + 4 レイヤー
 *   （casing + tier 3 段。#228）をスタイルへ反映すること（beforeId は
 *   approximateBorderBeforeId に従う）
 * - 再入ガード: sync 中の requestRender（renderLayers 相当）から再帰的に
 *   sync が呼ばれても二重同期しないこと（無限再帰・レイヤー二重追加なし）
 * - メモ化の参照同値（TASK-50/136 の契約）: 同じ base/outlines 参照の apply では
 *   data() が同一参照のまま（セグメント分割を再計算しない）
 * - 「すでに正しい」状態では何も変更しない収束性（既存 source は setData、
 *   既存レイヤーは追加しない、スタックが正しければ requestRender しない）
 * - 例外は warn へ握りつぶし、ガードが解放されて次回の sync が動くこと
 * - 詳細表示 focus（#347）: focus 内は outlines（諸侯領 union で切り出し済み）、
 *   focus 外は素の base ポリゴンの環から境界を引くこと。focus を渡さない
 *   （既存の 2 引数呼び出し）出力は従来と一致すること
 */
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import type { FeatureCollection } from "geojson";
import {
  type ApproximateBorderSyncDeps,
  type ApproximateBorderSyncHandle,
  createApproximateBorderSync,
} from "./approximate_border_sync.ts";
import {
  APPROXIMATE_BORDER_LAYER_IDS,
  APPROXIMATE_BORDER_SOURCE_ID,
  buildApproximateBorderData,
  EMPTY_APPROXIMATE_BORDER_DATA,
} from "./approximate_borders.ts";
import {
  DECK_LAYER_GROUP_ID_PREFIX,
  WATER_STYLE_LAYER_ID,
} from "./layer_stack.ts";
import { resolveSuzerainKey } from "./suzerain_extent.ts";

/** 政治ポリゴンの塗りが入る deck レイヤーグループ ID（水面直下） */
const FILL_GROUP_ID =
  `${DECK_LAYER_GROUP_ID_PREFIX}before:${WATER_STYLE_LAYER_ID}`;

/** base 勢力ポリゴン相当（環 3 セグメント + 閉合） */
const BASE: FeatureCollection = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
    },
  }],
};

/** TASK-78 の派生 base 輪郭相当（LineString 1 本） */
const OUTLINES: FeatureCollection = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: [[0, 0], [2, 2]] },
  }],
};

const EMPTY_OUTLINES: FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

/** 概略境界がまだ無いスタイル（水面 + 塗りグループのみ） */
const STYLE_BEFORE_SYNC = [FILL_GROUP_ID, WATER_STYLE_LAYER_ID];

/** 同期後の正しい順序（塗り → 概略境界 → 水面） */
const STYLE_VALID = [
  FILL_GROUP_ID,
  ...APPROXIMATE_BORDER_LAYER_IDS,
  WATER_STYLE_LAYER_ID,
];

/** 崩れた順序（概略境界が塗りグループの下 = deck の beforeId が古い） */
const STYLE_INVALID = [
  ...APPROXIMATE_BORDER_LAYER_IDS,
  FILL_GROUP_ID,
  WATER_STYLE_LAYER_ID,
];

/** 偽 MapLibre Map + 記録付き deps。テストごとに必要な部分だけ上書きする */
function createHarness(overrides: Partial<ApproximateBorderSyncDeps> = {}) {
  const addedSources: { id: string; data: FeatureCollection }[] = [];
  const setDataCalls: FeatureCollection[] = [];
  const addedLayers: { id: string; beforeId: string | undefined }[] = [];
  const styleListeners: (() => void)[] = [];
  const warnings: string[] = [];
  const rendered: number[] = [];
  const state = {
    styleLayerIds: [...STYLE_BEFORE_SYNC] as string[],
    sourcePresent: false,
  };
  const deps: ApproximateBorderSyncDeps = {
    getStyleLayerIds: () => state.styleLayerIds,
    getSource: (id) =>
      state.sourcePresent && id === APPROXIMATE_BORDER_SOURCE_ID
        ? { setData: (data: FeatureCollection) => setDataCalls.push(data) }
        : undefined,
    addSource: (id, spec) => {
      state.sourcePresent = true;
      addedSources.push({ id, data: spec.data as FeatureCollection });
    },
    getLayer: (id) =>
      state.styleLayerIds.includes(id) ||
        addedLayers.some((layer) => layer.id === id)
        ? { id }
        : undefined,
    addLayer: (spec, beforeId) => addedLayers.push({ id: spec.id, beforeId }),
    onStyleData: (listener) => styleListeners.push(listener),
    hasCurrentView: () => true,
    requestRender: () => rendered.push(1),
    warn: (message) => warnings.push(message),
    ...overrides,
  };
  return {
    deps,
    addedSources,
    setDataCalls,
    addedLayers,
    styleListeners,
    warnings,
    rendered,
    state,
  };
}

Deno.test("createApproximateBorderSync は styledata 購読を 1 本組み立てる", () => {
  const h = createHarness();
  createApproximateBorderSync(h.deps);
  assertEquals(h.styleListeners.length, 1);
});

Deno.test("styledata 発火で source と 4 レイヤー（casing + tier 3 段）が水面直下へ追加される", () => {
  const h = createHarness();
  createApproximateBorderSync(h.deps);
  h.styleListeners[0]();
  assertEquals(h.addedSources.length, 1);
  assertEquals(h.addedSources[0].id, APPROXIMATE_BORDER_SOURCE_ID);
  // apply 前は空データ（同一参照）で source を登録する
  assertStrictEquals(h.addedSources[0].data, EMPTY_APPROXIMATE_BORDER_DATA);
  // 追加順は APPROXIMATE_BORDER_LAYER_IDS（casing → tier 弱い順）。同じ
  // beforeId（水面直下）へ順に挿すことで casing が最下段になる（#228）
  assertEquals(
    h.addedLayers.map((layer) => layer.id),
    [...APPROXIMATE_BORDER_LAYER_IDS],
  );
  for (const layer of h.addedLayers) {
    assertEquals(layer.beforeId, WATER_STYLE_LAYER_ID);
  }
});

Deno.test("水面レイヤーが無いスタイルでは beforeId なしで追加する", () => {
  const h = createHarness();
  h.state.styleLayerIds = ["some-basemap-layer"];
  const sync = createApproximateBorderSync(h.deps);
  sync.sync();
  assertEquals(h.addedLayers.length, APPROXIMATE_BORDER_LAYER_IDS.length);
  for (const layer of h.addedLayers) {
    assertEquals(layer.beforeId, undefined);
  }
});

Deno.test("スタイル未読込（レイヤー ID 列が空）では何もしない", () => {
  const h = createHarness();
  h.state.styleLayerIds = [];
  const sync = createApproximateBorderSync(h.deps);
  sync.sync();
  assertEquals(h.addedSources.length, 0);
  assertEquals(h.addedLayers.length, 0);
  assertEquals(h.rendered.length, 0);
});

Deno.test("2 回目の sync は setData のみでレイヤーを二重追加しない（収束）", () => {
  const h = createHarness();
  const sync = createApproximateBorderSync(h.deps);
  sync.sync();
  h.state.styleLayerIds = [...STYLE_VALID];
  sync.sync();
  assertEquals(h.addedSources.length, 1);
  assertEquals(h.addedLayers.length, APPROXIMATE_BORDER_LAYER_IDS.length);
  assertEquals(h.setDataCalls.length, 1);
  assertEquals(h.rendered.length, 0);
});

Deno.test("再入ガード: requestRender からの再帰 sync は二重同期しない", () => {
  // renderLayers 相当: requestRender の中で apply → sync が再帰的に呼ばれる
  let handle: ApproximateBorderSyncHandle | null = null;
  const h = createHarness({
    requestRender: () => {
      h.rendered.push(1);
      handle?.apply(BASE, EMPTY_OUTLINES);
    },
  });
  // 同期後もスタックが崩れたまま（deck の beforeId が古い）とみなすことで、
  // ガードが無ければ sync → requestRender → sync → … と無限再帰する状況を作る
  h.state.styleLayerIds = [...STYLE_INVALID];
  handle = createApproximateBorderSync(h.deps);
  handle.sync();
  // requestRender は外側の sync から 1 回だけ。内側の sync はガードで何もしない
  assertEquals(h.rendered.length, 1);
  assertEquals(h.addedLayers.length, 0);
  assertEquals(h.addedSources.length, 1);
});

Deno.test("スタックが正しければ requestRender しない", () => {
  const h = createHarness();
  h.state.styleLayerIds = [...STYLE_VALID];
  const sync = createApproximateBorderSync(h.deps);
  sync.sync();
  assertEquals(h.rendered.length, 0);
});

Deno.test("スタックが崩れていても currentView 未確定なら requestRender しない", () => {
  const h = createHarness({ hasCurrentView: () => false });
  h.state.styleLayerIds = [...STYLE_INVALID];
  const sync = createApproximateBorderSync(h.deps);
  sync.sync();
  assertEquals(h.rendered.length, 0);
});

Deno.test("data() の初期値は EMPTY_APPROXIMATE_BORDER_DATA と同一参照", () => {
  const h = createHarness();
  const sync = createApproximateBorderSync(h.deps);
  assertStrictEquals(sync.data(), EMPTY_APPROXIMATE_BORDER_DATA);
});

Deno.test("メモ化: 同じ base/outlines 参照の apply では data() が同一参照", () => {
  const h = createHarness();
  const sync = createApproximateBorderSync(h.deps);
  sync.apply(BASE, EMPTY_OUTLINES);
  const first = sync.data();
  sync.apply(BASE, EMPTY_OUTLINES);
  assertStrictEquals(sync.data(), first);
});

Deno.test("メモ化: 参照が変われば（年代切替相当）data() は再計算される", () => {
  const h = createHarness();
  const sync = createApproximateBorderSync(h.deps);
  sync.apply(BASE, EMPTY_OUTLINES);
  const first = sync.data();
  const nextBase: FeatureCollection = structuredClone(BASE);
  sync.apply(nextBase, EMPTY_OUTLINES);
  assert(sync.data() !== first, "新しい参照では再計算されるはず");
});

Deno.test("apply: outlines があれば outlines から、無ければ base から組み立てる", () => {
  const h = createHarness();
  const sync = createApproximateBorderSync(h.deps);
  sync.apply(BASE, OUTLINES);
  assertEquals(sync.data(), buildApproximateBorderData(OUTLINES));
  sync.apply(BASE, EMPTY_OUTLINES);
  assertEquals(sync.data(), buildApproximateBorderData(BASE));
});

// ---- 詳細表示 focus の境界合成（#347 / #293 分割 2/5）----

/**
 * focus 合成用の base。France と Norway が経度 1 の辺（[1,0]-[1,1]）を共有する
 * 2 勢力ポリゴン。共有辺だけが「沿岸でない = 概略境界として描かれる」区間で、
 * 外周は #357 の沿岸判定で落ちる。
 */
const FOCUS_BASE: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { NAME: "France", SUBJECTO: "France" },
      geometry: {
        type: "Polygon",
        coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
      },
    },
    {
      type: "Feature",
      properties: { NAME: "Norway", SUBJECTO: "Norway" },
      geometry: {
        type: "Polygon",
        coordinates: [[[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]]],
      },
    },
  ],
};

/**
 * 同じ勢力の派生 base 輪郭（TASK-78。諸侯領 union の内側を切り落とした線）。
 * どちらの勢力も共有辺の一部しか残っていない = 領邦を重ねないと輪郭が途切れる。
 */
const FOCUS_OUTLINES: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { NAME: "France", SUBJECTO: "France" },
      geometry: { type: "LineString", coordinates: [[1, 0], [1, 0.4]] },
    },
    {
      type: "Feature",
      properties: { NAME: "Norway", SUBJECTO: "Norway" },
      geometry: { type: "LineString", coordinates: [[1, 1], [1, 0.6]] },
    },
  ],
};

/** FeatureCollection の LineString 座標列だけを取り出す */
function lineCoords(fc: FeatureCollection): unknown[] {
  return fc.features.map((f) =>
    (f.geometry as { coordinates: unknown }).coordinates
  );
}

Deno.test("apply: focus を渡すと focus 外は連続した base の輪郭、focus 内は outlines になる（#347 AC4）", () => {
  const h = createHarness();
  const sync = createApproximateBorderSync(h.deps);
  sync.apply(FOCUS_BASE, FOCUS_OUTLINES, "France");
  // focus 外（Norway）は base ポリゴンの環をそのまま使うので共有辺が途切れず
  // 1 本に繋がる。focus 内（France）は領邦 union で切り出した outlines のまま
  assertEquals(lineCoords(sync.data()), [
    [[1, 1], [1, 0]],
    [[1, 0], [1, 0.4]],
  ]);
});

Deno.test("apply: focus 無しの出力は従来どおり outlines 優先（#347 AC5 回帰）", () => {
  const h = createHarness();
  const sync = createApproximateBorderSync(h.deps);
  sync.apply(FOCUS_BASE, FOCUS_OUTLINES);
  const withoutFocus = sync.data();
  // 両勢力とも領邦で切り落とされた区間のまま（focus 導入前の挙動）
  assertEquals(lineCoords(withoutFocus), [
    [[1, 0], [1, 0.4]],
    [[1, 1], [1, 0.6]],
  ]);
  assertEquals(
    withoutFocus,
    buildApproximateBorderData(FOCUS_OUTLINES, FOCUS_BASE),
  );
  // 明示的な null も同じ（既存の 2 引数呼び出しと等価）
  sync.apply(structuredClone(FOCUS_BASE), FOCUS_OUTLINES, null);
  assertEquals(sync.data(), withoutFocus);
});

Deno.test("apply: focus 合成でも沿岸外周は再導入されない（#357 の base 明示。#347 AC4）", () => {
  const h = createHarness();
  const sync = createApproximateBorderSync(h.deps);
  sync.apply(FOCUS_BASE, FOCUS_OUTLINES, "France");
  // focus 外を base ポリゴンへ戻しても、共有されない外周（[2,0]-[2,1] など）は
  // 沿岸として落ちたまま
  const flat = JSON.stringify(lineCoords(sync.data()));
  assert(!flat.includes("[2,0]"), `沿岸外周が混入している: ${flat}`);
  assert(!flat.includes("[0,0]"), `沿岸外周が混入している: ${flat}`);
});

Deno.test("apply: 宗主キー解決を 4 引数目で渡せる（#347 AC4）", () => {
  const h = createHarness();
  const sync = createApproximateBorderSync(h.deps);
  const overrides = { renames: {}, suzerains: { Norway: "France" } };
  // Norway も France 宗主になるため、両勢力とも outlines 側から引かれる
  sync.apply(
    FOCUS_BASE,
    FOCUS_OUTLINES,
    "France",
    (props) => resolveSuzerainKey(props, overrides),
  );
  assertEquals(
    sync.data(),
    buildApproximateBorderData(FOCUS_OUTLINES, FOCUS_BASE),
  );
});

Deno.test("メモ化: focus が変わればセグメント分割を引き直す（#347）", () => {
  const h = createHarness();
  const sync = createApproximateBorderSync(h.deps);
  sync.apply(FOCUS_BASE, FOCUS_OUTLINES, "France");
  const first = sync.data();
  sync.apply(FOCUS_BASE, FOCUS_OUTLINES, "France");
  assertStrictEquals(sync.data(), first, "同じ focus では再計算しない");
  sync.apply(FOCUS_BASE, FOCUS_OUTLINES, "Norway");
  assert(sync.data() !== first, "focus が変われば再計算されるはず");
});

Deno.test("apply は同期まで行い、最新データが setData へ渡る", () => {
  const h = createHarness();
  const sync = createApproximateBorderSync(h.deps);
  sync.sync(); // source を登録
  sync.apply(BASE, EMPTY_OUTLINES);
  assertEquals(h.setDataCalls.length, 1);
  assertStrictEquals(h.setDataCalls[0], sync.data());
});

Deno.test("例外は warn へ握りつぶし、ガードが解放されて次回は同期できる", () => {
  let failing = true;
  const h = createHarness();
  const addSource = h.deps.addSource;
  h.deps.addSource = (id, spec) => {
    if (failing) throw new Error("addSource failed");
    addSource(id, spec);
  };
  const sync = createApproximateBorderSync(h.deps);
  sync.sync();
  assertEquals(h.warnings.length, 1);
  assert(h.warnings[0].includes("addSource failed"));
  // ガードが解放されているので、復旧後の sync は通常どおり同期する
  failing = false;
  sync.sync();
  assertEquals(h.addedSources.length, 1);
  assertEquals(h.addedLayers.length, APPROXIMATE_BORDER_LAYER_IDS.length);
});
