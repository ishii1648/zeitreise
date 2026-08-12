/**
 * coastal_fill_sync.ts のユニットテスト（Issue #305）。
 *
 * 検証する契約:
 * - ファクトリが styledata 購読を組み立て、発火で source + line レイヤーを
 *   内水面（water-inland）の直下へ反映すること
 * - 水面レイヤーを持たないスタイル（OpenFreeMap フォールバック）では何も
 *   追加しないこと（政治ポリゴンのマスクも無い状態なので帯も出さない）
 * - メモ化の参照同値: 同じ base/colors/overrides 参照の apply では data() が
 *   同一参照のまま（沿岸 run 抽出を再計算しない）
 * - 「すでに正しい」状態では収束する（既存 source は setData、既存レイヤーは
 *   追加しない）
 * - 強調 feature-state: apply の強調キーが setFeatureState / removeFeatureState
 *   の差分として反映されること（picking は deck 側のまま = AC5）
 * - 例外は warn へ握りつぶし、次回の sync が動くこと
 */
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import type { FeatureCollection } from "geojson";
import {
  type CoastalFillSyncDeps,
  createCoastalFillSync,
} from "./coastal_fill_sync.ts";
import { COASTAL_FILL_SOURCE_ID } from "./coastal_fill.ts";
import {
  COASTAL_FILL_LAYER_ID,
  WATER_INLAND_LAYER_ID,
  WATER_LAYER_ID,
} from "./basemap.ts";
import { EMPTY_SUZERAIN_OVERRIDES } from "./suzerain_extent.ts";

const BASE: FeatureCollection = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: { NAME: "A" },
    geometry: {
      type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
    },
  }],
};

const COLORS: Record<string, string> = { "A": "#ff0000" };

/** 内水面・海洋・海岸線を持つ通常スタイル */
const STYLE = ["earth", WATER_INLAND_LAYER_ID, WATER_LAYER_ID, "coastline"];

interface FakeSource {
  setDataCalls: FeatureCollection[];
  setData(data: FeatureCollection): void;
}

function createFakeMap(initialLayers: string[]) {
  const layers = [...initialLayers];
  const sources = new Map<string, FakeSource>();
  const listeners: (() => void)[] = [];
  const warns: string[] = [];
  const featureStates = new Map<string, { active: boolean }>();
  const addLayerCalls: { id: string; beforeId?: string }[] = [];
  const deps: CoastalFillSyncDeps = {
    getStyleLayerIds: () => [...layers],
    getSource: (id) => sources.get(id),
    addSource: (id, spec) => {
      const source: FakeSource = {
        setDataCalls: [],
        setData(data) {
          this.setDataCalls.push(data);
        },
      };
      sources.set(id, source);
      // 初期データは spec.data として渡る
      void spec;
    },
    getLayer: (id) => layers.includes(id) ? { id } : undefined,
    addLayer: (spec, beforeId) => {
      addLayerCalls.push({ id: spec.id, beforeId });
      const idx = beforeId === undefined ? layers.length : layers.indexOf(
        beforeId,
      );
      layers.splice(idx < 0 ? layers.length : idx, 0, spec.id);
    },
    setFeatureState: (target, state) => {
      featureStates.set(`${target.source}:${target.id}`, state);
    },
    removeFeatureState: (target) => {
      featureStates.delete(`${target.source}:${target.id}`);
    },
    onStyleData: (listener) => listeners.push(listener),
    warn: (message) => warns.push(message),
  };
  return {
    deps,
    layers,
    sources,
    listeners,
    warns,
    featureStates,
    addLayerCalls,
    fireStyleData: () => listeners.forEach((listener) => listener()),
  };
}

Deno.test("styledata 発火で source + レイヤーが内水面の直下へ追加される", () => {
  const fake = createFakeMap(STYLE);
  createCoastalFillSync(fake.deps);
  assertEquals(fake.listeners.length, 1);
  fake.fireStyleData();
  assert(fake.sources.has(COASTAL_FILL_SOURCE_ID));
  assertEquals(fake.addLayerCalls, [{
    id: COASTAL_FILL_LAYER_ID,
    beforeId: WATER_INLAND_LAYER_ID,
  }]);
  // 実際の順序: coastal-fill が water-inland の直前
  assertEquals(
    fake.layers.indexOf(COASTAL_FILL_LAYER_ID),
    fake.layers.indexOf(WATER_INLAND_LAYER_ID) - 1,
  );
});

Deno.test("水面レイヤーを持たないスタイルでは何も追加しない", () => {
  const fake = createFakeMap(["background", "landuse"]);
  const sync = createCoastalFillSync(fake.deps);
  sync.apply(BASE, COLORS, EMPTY_SUZERAIN_OVERRIDES, null, null);
  assertEquals(fake.addLayerCalls.length, 0);
  assert(!fake.sources.has(COASTAL_FILL_SOURCE_ID));
  assertEquals(fake.warns.length, 0);
});

Deno.test("apply は参照同値でメモ化され、既存 source は setData で更新される", () => {
  const fake = createFakeMap(STYLE);
  const sync = createCoastalFillSync(fake.deps);
  sync.apply(BASE, COLORS, EMPTY_SUZERAIN_OVERRIDES, null, null);
  const first = sync.data();
  assert(first.features.length > 0);
  sync.apply(BASE, COLORS, EMPTY_SUZERAIN_OVERRIDES, null, null);
  assertStrictEquals(sync.data(), first);
  // レイヤーは二重追加されない
  assertEquals(fake.addLayerCalls.length, 1);
  // 2 回目は setData（追加済み source の更新経路）
  const source = fake.sources.get(COASTAL_FILL_SOURCE_ID);
  assert(source !== undefined && source.setDataCalls.length >= 1);
});

Deno.test("強調キーの変化が feature-state の差分として反映される", () => {
  const fake = createFakeMap(STYLE);
  const sync = createCoastalFillSync(fake.deps);
  sync.apply(BASE, COLORS, EMPTY_SUZERAIN_OVERRIDES, "A", null);
  assertEquals(
    fake.featureStates.get(`${COASTAL_FILL_SOURCE_ID}:A`),
    { active: true },
  );
  // 選択解除 + 別キーへホバー
  sync.apply(BASE, COLORS, EMPTY_SUZERAIN_OVERRIDES, null, "B");
  assertEquals(
    fake.featureStates.get(`${COASTAL_FILL_SOURCE_ID}:A`),
    undefined,
  );
  assertEquals(
    fake.featureStates.get(`${COASTAL_FILL_SOURCE_ID}:B`),
    { active: true },
  );
  // 全解除
  sync.apply(BASE, COLORS, EMPTY_SUZERAIN_OVERRIDES, null, null);
  assertEquals(fake.featureStates.size, 0);
});

Deno.test("例外は warn へ握りつぶし、次回の sync は正常に動く", () => {
  const fake = createFakeMap(STYLE);
  let failing = true;
  const deps: CoastalFillSyncDeps = {
    ...fake.deps,
    addSource: (id, spec) => {
      if (failing) throw new Error("boom");
      fake.deps.addSource(id, spec);
    },
  };
  const sync = createCoastalFillSync(deps);
  sync.apply(BASE, COLORS, EMPTY_SUZERAIN_OVERRIDES, null, null);
  assertEquals(fake.warns.length, 1);
  failing = false;
  sync.sync();
  assert(fake.sources.has(COASTAL_FILL_SOURCE_ID));
  assertEquals(fake.warns.length, 1);
});
