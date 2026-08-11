/**
 * pick_handlers.ts のユニットテスト（TASK-149 / Issue #167）。
 *
 * 検証する契約:
 * - pickedLabel / pickedMetadata: レイヤー ID 分岐が main.ts 時代と一致し、
 *   ラベルと出典が必ず同じデータ由来になること（TASK-24/27/100/109）
 * - resolveClickInfo: 直下 pick が確定層（rivers / cities 系）ならそのまま、
 *   それ以外は pickMultipleObjects（半径 PICKING_RADIUS_PX・深さ
 *   CLICK_PICK_DEPTH）→ resolveClickPick の選び直しへ落ちること（TASK-36/82）
 * - handlePickHover / handlePickClick: 選択・ホバー状態の遷移
 *   （トグル規則・解除経路）と「値が変わったときだけ requestRender」
 *   （TASK-50 の規律）、ツールチップ / 情報パネルの表示規則
 * - getter: デバッグフック（debug_hooks.ts）・renderLayers の context 組み立てが
 *   読む選択/ホバー状態の読み取り口（状態は factory closure が所有する）
 */
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import type { PickingInfo } from "@deck.gl/core";
import type { Feature, FeatureCollection } from "geojson";
import {
  CLICK_PICK_DEPTH,
  collectionMetadata,
  createPickHandlers,
  mountainNameFromPick,
  peakNameFromPick,
  type PickHandlerDeps,
  powerHighlightKeyFromPick,
} from "./pick_handlers.ts";
import {
  BRITAIN_FIEF_LAYER_ID,
  CLIOPATRIA_FIEF_LAYER_ID,
  FRANCE_FIEF_LAYER_ID,
  HRE_LAYER_ID,
  ITALY_FIEF_LAYER_ID,
  PICKING_PRIORITY,
  PICKING_RADIUS_PX,
  POWER_LAYER_ID,
  RIVERS_HIT_LAYER_ID,
  RIVERS_LAYER_ID,
  SOVEREIGN_FIEF_LAYER_ID,
} from "./picking.ts";
import { CITY_LAYER_ID } from "./picking.ts";
import { MOUNTAIN_HIT_LAYER_ID } from "./mountains.ts";
import { PEAK_LAYER_ID } from "./peaks.ts";
import { displayLabel, sourceLines } from "./info.ts";
import { powerHighlightKey } from "./power_highlight.ts";
import { EMPTY_SUZERAIN_OVERRIDES } from "./suzerain_extent.ts";
import { peakPickLabel } from "./peaks.ts";
import type { CitiesData } from "./cities.ts";

// ---- fixtures ----

/**
 * picking 結果のテストダブル（Deck onHover/onClick が渡す形の最小サブセット）。
 * coordinate は #216 のカーソル内包判定（resolveClickInfo → resolveClickPick）が
 * 読む lng/lat。関与しないテストでは省略してよい。
 */
function pick(
  layerId: string | null,
  object: unknown,
  x = 10,
  y = 20,
  coordinate?: number[],
): PickingInfo {
  return {
    layer: layerId === null ? null : { id: layerId },
    object,
    x,
    y,
    coordinate,
  } as unknown as PickingInfo;
}

/** picking なし（Deck onClick は layer: null の info で呼ばれる） */
function emptyPick(): PickingInfo {
  return pick(null, undefined);
}

function polygonFeature(
  properties: Record<string, string>,
  origin: [number, number] = [0, 45],
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

function fc(features: Feature[], metadata?: unknown): FeatureCollection {
  const collection: FeatureCollection = { type: "FeatureCollection", features };
  if (metadata !== undefined) {
    (collection as unknown as { metadata: unknown }).metadata = metadata;
  }
  return collection;
}

const franceFeature = polygonFeature({ NAME: "France" }, [0, 45]);
const normandyFeature = polygonFeature(
  { NAME: "Normandy", SUBJECTO: "France" },
  [2, 45],
);
const riverFeature: Feature = {
  type: "Feature",
  properties: { name: "Rhine" },
  geometry: { type: "LineString", coordinates: [[6, 47], [7, 51]] },
};

const NAME_JA: Record<string, string> = {
  Rhine: "ライン川",
  France: "フランス王国",
  Alps: "アルプス山脈",
  "Mont Blanc": "モンブラン",
};

interface HarnessCalls {
  render: number;
  tooltip: [string, number, number][];
  hideTooltip: number;
  panel: { label: string; sources: unknown }[];
  highlightHover: (string | null)[];
  highlightClick: (string | null)[];
  multiPick: { x: number; y: number; radius: number; depth: number }[];
}

/** deps を全てテストダブルにした createPickHandlers のハーネス */
function createHarness() {
  const calls: HarnessCalls = {
    render: 0,
    tooltip: [],
    hideTooltip: 0,
    panel: [],
    highlightHover: [],
    highlightClick: [],
    multiPick: [],
  };
  const view = {
    base: fc([franceFeature, normandyFeature], { source: "base" }),
    baseFill: fc([]),
    hre: fc([], { source: "hre" }),
    fiefs: fc([], { source: "fiefs" }),
    italyFiefs: fc([], { source: "italy" }),
    cliopatriaFiefs: fc([], { source: "cliopatria" }),
    britainFiefs: fc([], { source: "britain" }),
    sovereignFiefs: fc([], { source: "sovereign" }),
  };
  const riversData = fc([riverFeature], { source: "rivers" });
  const mountainsData = fc([], { source: "mountains" });
  const peaksData = fc([], { source: "peaks" });
  const citiesData = { years: {}, metadata: { source: "cities" } } as
    & CitiesData
    & { metadata: unknown };
  let multiPickResult: PickingInfo[] = [];
  const deps: PickHandlerDeps = {
    getNameJa: () => NAME_JA,
    getOverrides: () => EMPTY_SUZERAIN_OVERRIDES,
    getCurrentView: () => view,
    getRiversData: () => riversData,
    getMountainsData: () => mountainsData,
    getPeaksData: () => peaksData,
    getCitiesData: () => citiesData,
    showTooltip: (label, x, y) => calls.tooltip.push([label, x, y]),
    hideTooltip: () => calls.hideTooltip++,
    showInfoPanel: (label, sources) => calls.panel.push({ label, sources }),
    requestRender: () => calls.render++,
    powerHighlight: {
      hover: (key) => calls.highlightHover.push(key),
      click: (key) => calls.highlightClick.push(key),
    },
    pickMultipleObjects: (opts) => {
      calls.multiPick.push(opts);
      return multiPickResult;
    },
  };
  const handlers = createPickHandlers(deps);
  return {
    handlers,
    calls,
    view,
    riversData,
    setMultiPickResult(result: PickingInfo[]) {
      multiPickResult = result;
    },
  };
}

// ---- 定数・純粋関数 ----

Deno.test("CLICK_PICK_DEPTH は pickable 層数（PICKING_PRIORITY.length）", () => {
  assertEquals(CLICK_PICK_DEPTH, PICKING_PRIORITY.length);
});

Deno.test("collectionMetadata は非標準トップレベル metadata を取り出す", () => {
  assertEquals(collectionMetadata({ metadata: { source: "x" } }), {
    source: "x",
  });
  assertEquals(collectionMetadata({}), undefined);
  assertEquals(collectionMetadata(null), undefined);
  assertEquals(collectionMetadata(undefined), undefined);
});

Deno.test("mountainNameFromPick / peakNameFromPick は対象レイヤーのみ名前を返す", () => {
  assertEquals(
    mountainNameFromPick(pick(MOUNTAIN_HIT_LAYER_ID, { name: "Alps" })),
    "Alps",
  );
  assertEquals(
    mountainNameFromPick(pick(PEAK_LAYER_ID, { name: "Alps" })),
    null,
  );
  assertEquals(mountainNameFromPick(emptyPick()), null);
  assertEquals(
    peakNameFromPick(
      pick(PEAK_LAYER_ID, { name: "Mont Blanc", elevation: 4808 }),
    ),
    "Mont Blanc",
  );
  assertEquals(
    peakNameFromPick(pick(MOUNTAIN_HIT_LAYER_ID, { name: "Alps" })),
    null,
  );
  assertEquals(peakNameFromPick(emptyPick()), null);
});

Deno.test("powerHighlightKeyFromPick は powerHighlightKey と同じ解決をする", () => {
  assertEquals(
    powerHighlightKeyFromPick(pick(POWER_LAYER_ID, normandyFeature)),
    powerHighlightKey(POWER_LAYER_ID, normandyFeature.properties),
  );
  assertEquals(
    powerHighlightKeyFromPick(pick(RIVERS_LAYER_ID, riverFeature)),
    null,
  );
  assertEquals(powerHighlightKeyFromPick(emptyPick()), null);
});

// ---- pickedLabel / pickedMetadata ----

Deno.test("pickedLabel はレイヤー種別ごとに表示ラベルを整形する", () => {
  const { handlers } = createHarness();
  // 河川（rivers / rivers-hit どちらも同じ経路）
  assertEquals(
    handlers.pickedLabel(pick(RIVERS_LAYER_ID, riverFeature)),
    "ライン川",
  );
  assertEquals(
    handlers.pickedLabel(pick(RIVERS_HIT_LAYER_ID, riverFeature)),
    "ライン川",
  );
  // 都市
  assertEquals(
    handlers.pickedLabel(
      pick(CITY_LAYER_ID, { name: "Rhine", position: [6, 47] }),
    ),
    // cityDisplayName 経由（都市名オーバーライドは無いので ja がそのまま出る）
    "ライン川",
  );
  // 山脈・山峰
  assertEquals(
    handlers.pickedLabel(pick(MOUNTAIN_HIT_LAYER_ID, { name: "Alps" })),
    "アルプス山脈",
  );
  const peakDatum = { name: "Mont Blanc", elevation: 4808 };
  assertEquals(
    handlers.pickedLabel(pick(PEAK_LAYER_ID, peakDatum)),
    peakPickLabel(peakDatum, NAME_JA),
  );
  // 勢力ポリゴン（displayLabel。宗主国込み表記）
  assertEquals(
    handlers.pickedLabel(pick(POWER_LAYER_ID, normandyFeature)),
    displayLabel(normandyFeature.properties, {}, NAME_JA),
  );
  // #172: ブリテン諸島の政体も同じ displayLabel 経路（SUBJECTO を持たないため
  // 宗主なしの NAME 表記になる）
  assertEquals(
    handlers.pickedLabel(pick(BRITAIN_FIEF_LAYER_ID, normandyFeature)),
    displayLabel(normandyFeature.properties, {}, NAME_JA),
  );
  // #189: 主権政体も同じ displayLabel 経路（SUBJECTO を持たないため
  // 宗主なしの NAME 表記になる）
  assertEquals(
    handlers.pickedLabel(pick(SOVEREIGN_FIEF_LAYER_ID, normandyFeature)),
    displayLabel(normandyFeature.properties, {}, NAME_JA),
  );
  // picking なし・対象外レイヤーは null
  assertEquals(handlers.pickedLabel(emptyPick()), null);
  assertEquals(handlers.pickedLabel(pick("power-labels", riverFeature)), null);
});

Deno.test("pickedMetadata はラベルと同じレイヤー分岐で出典を解決する", () => {
  const { handlers, view, riversData } = createHarness();
  assertStrictEquals(
    handlers.pickedMetadata(pick(RIVERS_LAYER_ID, riverFeature)),
    collectionMetadata(riversData),
  );
  assertEquals(
    handlers.pickedMetadata(pick(MOUNTAIN_HIT_LAYER_ID, { name: "Alps" })),
    { source: "mountains" },
  );
  assertEquals(
    handlers.pickedMetadata(pick(PEAK_LAYER_ID, { name: "Mont Blanc" })),
    { source: "peaks" },
  );
  assertEquals(
    handlers.pickedMetadata(pick(CITY_LAYER_ID, { name: "Paris" })),
    { source: "cities" },
  );
  // powers: baseFill が空（metadata なし）なら base の出典へフォールバック
  assertStrictEquals(
    handlers.pickedMetadata(pick(POWER_LAYER_ID, franceFeature)),
    collectionMetadata(view.base),
  );
  assertEquals(
    handlers.pickedMetadata(pick(HRE_LAYER_ID, franceFeature)),
    { source: "hre" },
  );
  assertEquals(
    handlers.pickedMetadata(pick(FRANCE_FIEF_LAYER_ID, franceFeature)),
    { source: "fiefs" },
  );
  assertEquals(
    handlers.pickedMetadata(pick(ITALY_FIEF_LAYER_ID, franceFeature)),
    { source: "italy" },
  );
  assertEquals(
    handlers.pickedMetadata(pick(CLIOPATRIA_FIEF_LAYER_ID, franceFeature)),
    { source: "cliopatria" },
  );
  // #172: ブリテン諸島の政体もレイヤー単位で出典（OHM / CC0）を引く
  assertEquals(
    handlers.pickedMetadata(pick(BRITAIN_FIEF_LAYER_ID, franceFeature)),
    { source: "britain" },
  );
  // #189: 主権政体もレイヤー単位で出典（OHM / CC0）を引く
  assertEquals(
    handlers.pickedMetadata(pick(SOVEREIGN_FIEF_LAYER_ID, franceFeature)),
    { source: "sovereign" },
  );
  // 対象外・picking なしは undefined = 出典欄を出さない
  assertEquals(handlers.pickedMetadata(emptyPick()), undefined);
  assertEquals(
    handlers.pickedMetadata(pick("power-labels", riverFeature)),
    undefined,
  );
});

Deno.test("pickedMetadata は借用 feature の出典（properties.ATTRIBUTION）をレイヤーの出典より優先する（#202）", () => {
  const { handlers } = createHarness();
  const borrowedAttribution = {
    source: "Territories of the Holy Roman Empire (Roller, ETH Zürich)",
    license: "CC BY-NC-SA 4.0",
    borrowedFrom: [{ name: "Archduchy of Austria", year: 1500 }],
  };
  const borrowedFeature = polygonFeature(
    { NAME: "Archduchy of Austria" },
    [16, 48],
  );
  (borrowedFeature.properties as Record<string, unknown>).ATTRIBUTION =
    borrowedAttribution;
  // hre-powers レイヤーには OHM 由来の面（CC0）と借用面（CC BY-NC-SA）が
  // 同居しうる。クリックした feature 自身の出典があればそれを出す
  assertStrictEquals(
    handlers.pickedMetadata(pick(HRE_LAYER_ID, borrowedFeature)),
    borrowedAttribution,
  );
  assertStrictEquals(
    handlers.pickedMetadata(pick(ITALY_FIEF_LAYER_ID, borrowedFeature)),
    borrowedAttribution,
  );
  // 借用でない feature は従来どおりレイヤー（FeatureCollection）の出典
  assertEquals(
    handlers.pickedMetadata(pick(HRE_LAYER_ID, franceFeature)),
    { source: "hre" },
  );
});

// ---- resolveClickInfo ----

Deno.test("resolveClickInfo: 直下 pick が確定層ならそのまま返し再ピックしない", () => {
  const { handlers, calls } = createHarness();
  const info = pick(RIVERS_LAYER_ID, riverFeature);
  assertStrictEquals(handlers.resolveClickInfo(info), info);
  assertEquals(calls.multiPick.length, 0);
});

Deno.test("resolveClickInfo: 非確定層は半径内候補から PICKING_PRIORITY で選び直す", () => {
  const { handlers, calls, setMultiPickResult } = createHarness();
  const powerInfo = pick(POWER_LAYER_ID, franceFeature, 33, 44);
  const riverInfo = pick(RIVERS_HIT_LAYER_ID, riverFeature, 33, 44);
  setMultiPickResult([powerInfo, riverInfo]);
  // 半径内に rivers-hit がいれば powers より優先される（TASK-36）
  assertStrictEquals(handlers.resolveClickInfo(powerInfo), riverInfo);
  assertEquals(calls.multiPick, [
    { x: 33, y: 44, radius: PICKING_RADIUS_PX, depth: CLICK_PICK_DEPTH },
  ]);
});

Deno.test("resolveClickInfo: カーソル座標（coordinate）を再ピックへ引き渡し、カーソルを含まない政治候補は優先上位でも降格される（#216）", () => {
  const { handlers, setMultiPickResult } = createHarness();
  // カーソル [1, 46] は saluzzo（[0,45]〜[2,47]）の内側・savoy（[2,45]〜[4,47]）
  // の外側。近傍再ピック（半径 6px）は隣接する Savoy も候補に返すが、
  // ホバー（直下 pick）と同じ「カーソルを含む面」= 小所領へ解決すること。
  const saluzzo = polygonFeature({ NAME: "Marquisate of Saluzzo" }, [0, 45]);
  const savoy = polygonFeature({ NAME: "Savoy" }, [2, 45]);
  const italyInfo = pick(ITALY_FIEF_LAYER_ID, saluzzo, 33, 44, [1, 46]);
  const sovereignInfo = pick(SOVEREIGN_FIEF_LAYER_ID, savoy, 33, 44, [1, 46]);
  setMultiPickResult([sovereignInfo, italyInfo]);
  assertStrictEquals(handlers.resolveClickInfo(italyInfo), italyInfo);
});

Deno.test("resolveClickInfo: 候補が空なら元の picking 結果へフォールバックする", () => {
  const { handlers, setMultiPickResult } = createHarness();
  setMultiPickResult([]);
  const info = pick(POWER_LAYER_ID, franceFeature);
  assertStrictEquals(handlers.resolveClickInfo(info), info);
});

// ---- handlePickHover ----

Deno.test("handlePickHover: 河川ホバーはツールチップ + 中間強調（変化時のみ再構築）", () => {
  const { handlers, calls } = createHarness();
  handlers.handlePickHover(pick(RIVERS_LAYER_ID, riverFeature, 5, 7));
  assertEquals(calls.tooltip, [["ライン川", 5, 7]]);
  assertEquals(handlers.hoveredRiverName(), "Rhine");
  assertEquals(calls.render, 1);
  assertEquals(calls.highlightHover, [null]);
  assertEquals(handlers.extentKey(), null);
  // 同じ河川の連続ホバー（mousemove）では再構築しない（TASK-50 の規律）
  handlers.handlePickHover(pick(RIVERS_LAYER_ID, riverFeature, 6, 8));
  assertEquals(calls.render, 1);
  // ホバー解除で null へ戻し、ツールチップも消す
  handlers.handlePickHover(emptyPick());
  assertEquals(handlers.hoveredRiverName(), null);
  assertEquals(calls.hideTooltip, 1);
  assertEquals(calls.render, 2);
});

Deno.test("handlePickHover: 勢力ホバーは外枠キー + 強調キーを解決する", () => {
  const { handlers, calls } = createHarness();
  handlers.handlePickHover(pick(POWER_LAYER_ID, normandyFeature));
  // SUBJECTO: France の封臣ホバーで宗主 France の外枠が出る（TASK-94）
  assertEquals(handlers.extentKey(), "France");
  assertEquals(calls.highlightHover, [
    powerHighlightKey(POWER_LAYER_ID, normandyFeature.properties),
  ]);
  assertEquals(calls.render, 1);
  // 同じ宗主の別 feature へ移っても外枠は再構築されない（キー単位の変化検知）
  handlers.handlePickHover(pick(POWER_LAYER_ID, franceFeature));
  assertEquals(handlers.extentKey(), "France");
  assertEquals(calls.render, 1);
  // ホバー解除で外枠も消える
  handlers.handlePickHover(emptyPick());
  assertEquals(handlers.extentKey(), null);
  assertEquals(calls.render, 2);
});

Deno.test("handlePickHover: 山岳ホバーは山脈・山峰の状態を 1 回の再構築で更新する", () => {
  const { handlers, calls } = createHarness();
  handlers.handlePickHover(pick(MOUNTAIN_HIT_LAYER_ID, { name: "Alps" }));
  assertEquals(handlers.hoveredMountainName(), "Alps");
  assertEquals(handlers.hoveredPeakName(), null);
  assertEquals(calls.render, 1);
  // 山脈から山峰へ移る（両方同時に変化）でも再構築は 1 回だけ増える
  handlers.handlePickHover(
    pick(PEAK_LAYER_ID, { name: "Mont Blanc", elevation: 4808 }),
  );
  assertEquals(handlers.hoveredMountainName(), null);
  assertEquals(handlers.hoveredPeakName(), "Mont Blanc");
  assertEquals(calls.render, 2);
});

// ---- handlePickClick ----

Deno.test("handlePickClick: 河川クリックは選択トグル + 情報パネル", () => {
  const { handlers, calls, riversData } = createHarness();
  const info = pick(RIVERS_LAYER_ID, riverFeature);
  handlers.handlePickClick(info);
  assertEquals(handlers.selectedRiverName(), "Rhine");
  assertEquals(calls.render, 1);
  assertEquals(calls.panel.length, 1);
  assertEquals(calls.panel[0].label, "ライン川");
  assertEquals(
    calls.panel[0].sources,
    sourceLines(collectionMetadata(riversData)),
  );
  // 同じ河川の再クリックは解除（選択が残らないのでパネルは更新しない）
  handlers.handlePickClick(info);
  assertEquals(handlers.selectedRiverName(), null);
  assertEquals(calls.render, 2);
  assertEquals(calls.panel.length, 1);
});

Deno.test("handlePickClick: 勢力クリックは河川選択を解除しパネル + 強調 + 外枠", () => {
  const { handlers, calls, view } = createHarness();
  handlers.handlePickClick(pick(RIVERS_LAYER_ID, riverFeature));
  assertEquals(handlers.selectedRiverName(), "Rhine");
  handlers.handlePickClick(pick(POWER_LAYER_ID, franceFeature));
  assertEquals(handlers.selectedRiverName(), null);
  assertEquals(handlers.extentKey(), "France");
  assertEquals(calls.highlightClick, [
    null,
    powerHighlightKey(POWER_LAYER_ID, franceFeature.properties),
  ]);
  assertEquals(calls.panel.length, 2);
  assertEquals(calls.panel[1].label, "フランス王国");
  assertEquals(
    calls.panel[1].sources,
    sourceLines(collectionMetadata(view.base)),
  );
});

Deno.test("handlePickClick: 空白クリックは選択・外枠・強調を全て解除する", () => {
  const { handlers, calls } = createHarness();
  handlers.handlePickClick(pick(RIVERS_LAYER_ID, riverFeature));
  handlers.handlePickClick(pick(MOUNTAIN_HIT_LAYER_ID, { name: "Alps" }));
  const panels = calls.panel.length;
  handlers.handlePickClick(emptyPick());
  assertEquals(handlers.selectedRiverName(), null);
  assertEquals(handlers.selectedMountainName(), null);
  assertEquals(handlers.selectedPeakName(), null);
  assertEquals(handlers.extentKey(), null);
  assertEquals(calls.highlightClick.at(-1), null);
  // 空白クリックではパネルを出さない
  assertEquals(calls.panel.length, panels);
});

Deno.test("handlePickClick: 山岳クリックは選択トグル + パネル（再クリックで解除）", () => {
  const { handlers, calls } = createHarness();
  const info = pick(MOUNTAIN_HIT_LAYER_ID, { name: "Alps" });
  handlers.handlePickClick(info);
  assertEquals(handlers.selectedMountainName(), "Alps");
  assertEquals(calls.panel.length, 1);
  assertEquals(calls.panel[0].label, "アルプス山脈");
  assertEquals(
    calls.panel[0].sources,
    sourceLines({ source: "mountains" }),
  );
  // 再クリックで解除。選択が残らないのでパネルは更新しない
  handlers.handlePickClick(info);
  assertEquals(handlers.selectedMountainName(), null);
  assertEquals(calls.panel.length, 1);
  // 山峰も同じ規則
  const peakInfo = pick(PEAK_LAYER_ID, { name: "Mont Blanc", elevation: 4808 });
  handlers.handlePickClick(peakInfo);
  assertEquals(handlers.selectedPeakName(), "Mont Blanc");
  assertEquals(calls.panel.length, 2);
});

Deno.test("handlePickClick: 選び直し（resolveClickInfo）を経由して河川を選択できる", () => {
  const { handlers, calls, setMultiPickResult } = createHarness();
  const riverInfo = pick(RIVERS_HIT_LAYER_ID, riverFeature, 33, 44);
  setMultiPickResult([riverInfo]);
  // 直下 pick は powers（河川ラインの外側）でも、半径内の rivers-hit が勝つ
  handlers.handlePickClick(pick(POWER_LAYER_ID, franceFeature, 33, 44));
  assertEquals(handlers.selectedRiverName(), "Rhine");
  assertEquals(calls.multiPick.length, 1);
});

Deno.test("getter: 選択/ホバー状態 7 変数の読み取り口を公開する", () => {
  const { handlers } = createHarness();
  assertEquals(handlers.selectedRiverName(), null);
  assertEquals(handlers.hoveredRiverName(), null);
  assertEquals(handlers.selectedMountainName(), null);
  assertEquals(handlers.hoveredMountainName(), null);
  assertEquals(handlers.selectedPeakName(), null);
  assertEquals(handlers.hoveredPeakName(), null);
  assertEquals(handlers.extentKey(), null);
  assert(typeof handlers.handlePickHover === "function");
  assert(typeof handlers.handlePickClick === "function");
});
