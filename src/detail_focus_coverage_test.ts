/**
 * 詳細表示 focus をどこに置いても「政治レイヤーが塗る面 = base の厳密な分割」
 * が崩れないことを**実データ**で固定する（#382）。
 *
 * 1000〜1300 年のシロンスク／モラヴィア境界一帯では、base（Poland）と HRE 領邦
 * オーバーレイ（ボヘミア公領 / モラヴィア辺境伯領）の境界が数百 km² 食い違い、
 * 諸侯領が Poland の base ポリゴンの内側へ食い込む。`europe_flat_<year>` は
 * 諸侯領 union を base から差し引くため、この食い込み分は Poland 側の flat から
 * 消える。したがって
 *
 * - focus が Poland: HRE 系の諸侯領は 1 枚も描かれず、Poland は flat（穴あき）を
 *   塗るので、その面はどの層にも塗られない（白い穴・picking も無反応）
 * - focus が HRE 側: 諸侯領は描かれるが、focus 外の Poland は素の base を塗るので
 *   同じ面が二重に塗られる（わずかに濃いパッチ）
 *
 * となり、**同一の面が focus 次第で未塗装にも二重塗りにもなる**。塗られる面は
 * focus に依らず常にちょうど 1 枚でなければならない。
 *
 * 検証は代表地点（Issue #382 の再現座標）で行う。地点は非網羅的な回帰検知点で、
 * 面積そのものは `data/known-limitations.json` が開示する微小断片（1279 年
 * 7.0 km² / 1300 年 1.0 km²）とは桁が 2 つ違う別物である。
 */

import { assert, assertEquals } from "@std/assert";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type {
  Feature,
  FeatureCollection,
  MultiPolygon,
  Polygon,
  Position,
} from "geojson";
import { createPoliticalLayerBuilders } from "./political_layers.ts";
import {
  BRITAIN_FIEF_LAYER_ID,
  CLIOPATRIA_FIEF_LAYER_ID,
  FRANCE_FIEF_LAYER_ID,
  HRE_LAYER_ID,
  ITALY_FIEF_LAYER_ID,
  POWER_LAYER_ID,
  resolveClickPick,
  SOVEREIGN_FIEF_LAYER_ID,
} from "./picking.ts";
import {
  detailFocusKeyAt,
  parseSuzerainOverrides,
  suzerainExtentKey,
  type SuzerainOverrides,
  UNRESOLVED_DETAIL_FOCUS_KEY,
} from "./suzerain_extent.ts";
import { EMPTY_FIEF_DEDUPE_TABLE } from "./fief_dedupe.ts";

/** 焦点が中央の Poland に落ちる（再現手順の URL は各地点を中央に据える） */
const POLAND = "Poland";

/** 諸侯領側の宗主キー（HRE 領邦オーバーレイの SUBJECTO） */
const HRE = "Holy Roman Empire";

/** 再現座標（Issue #382 の「再現手順」と同じ地点） */
interface CoverageCase {
  readonly year: number;
  readonly point: Position;
  readonly place: string;
  /** その面を塗るべき勢力の NAME（1100 年はボヘミア公領、以降はモラヴィア辺境伯領） */
  readonly expected: string;
}

const CASES: readonly CoverageCase[] = [
  {
    year: 1100,
    point: [17.838, 50.150],
    place: "クルノフ／オパヴァ",
    expected: "Duchy of Bohemia",
  },
  {
    year: 1100,
    point: [16.368, 50.629],
    place: "ノヴァ・ルダ",
    expected: "Duchy of Bohemia",
  },
  {
    year: 1200,
    point: [17.609, 50.247],
    place: "プルドニク",
    expected: "Moravia",
  },
  {
    year: 1279,
    point: [17.588, 50.245],
    place: "プルドニク",
    expected: "Moravia",
  },
  {
    year: 1300,
    point: [17.588, 50.245],
    place: "プルドニク",
    expected: "Moravia",
  },
  {
    year: 1300,
    point: [18.007, 50.090],
    place: "ラチブシュ西",
    expected: "Moravia",
  },
];

/** 年代ごとの表示データ（main.ts の currentView と同じ組） */
interface YearData {
  readonly year: number;
  readonly base: FeatureCollection;
  readonly baseFill: FeatureCollection;
  readonly hre: FeatureCollection;
  readonly fiefs: FeatureCollection;
  readonly italyFiefs: FeatureCollection;
  readonly cliopatriaFiefs: FeatureCollection;
  readonly britainFiefs: FeatureCollection;
  readonly sovereignFiefs: FeatureCollection;
}

async function readCollection(path: string): Promise<FeatureCollection> {
  return JSON.parse(await Deno.readTextFile(path)) as FeatureCollection;
}

const yearCache = new Map<number, YearData>();

async function loadYear(year: number): Promise<YearData> {
  const cached = yearCache.get(year);
  if (cached !== undefined) return cached;
  const [
    base,
    baseFill,
    hre,
    fiefs,
    italyFiefs,
    cliopatriaFiefs,
    britainFiefs,
    sovereignFiefs,
  ] = await Promise.all([
    readCollection(`data/europe_${year}.geojson`),
    readCollection(`data/europe_flat_${year}.geojson`),
    readCollection(`data/hre_fiefs_flat_${year}.geojson`),
    readCollection(`data/france_fiefs_flat_${year}.geojson`),
    readCollection(`data/italy_fiefs_flat_${year}.geojson`),
    readCollection(`data/cliopatria_fiefs_flat_${year}.geojson`),
    readCollection(`data/britain_fiefs_flat_${year}.geojson`),
    readCollection(`data/sovereign_fiefs_flat_${year}.geojson`),
  ]);
  const data: YearData = {
    year,
    base,
    baseFill,
    hre,
    fiefs,
    italyFiefs,
    cliopatriaFiefs,
    britainFiefs,
    sovereignFiefs,
  };
  yearCache.set(year, data);
  return data;
}

let overridesCache: SuzerainOverrides | null = null;

async function realOverrides(): Promise<SuzerainOverrides> {
  if (overridesCache === null) {
    overridesCache = parseSuzerainOverrides(
      JSON.parse(await Deno.readTextFile("data/name-overrides.json")),
    );
  }
  return overridesCache;
}

/**
 * main.ts `politicalLayerContext()` 相当の context を組み立てる。
 *
 * **返り値に型注釈を付けない**のは、`PoliticalLayerContext` へ後から足す
 * フィールド（諸侯領 6 系統）を余剰プロパティ検査で弾かせないため。呼び出し側で
 * 構造的に代入可能かだけが検査される。
 */
function focusContext(
  data: YearData,
  detailFocusKey: string | null,
  overrides: SuzerainOverrides,
  zoomStep = 5,
) {
  return {
    year: data.year,
    colors: {} as Record<string, string>,
    nameJa: {} as Record<string, string>,
    overrides,
    fiefDedupe: EMPTY_FIEF_DEDUPE_TABLE,
    // 既定の z5 = 詳細表示（focus が効く段）の下限
    zoomStep,
    extentKey: null,
    selectedPowerKey: null,
    hoveredPowerKey: null,
    fillTransitionMs: 400,
    styleLayerIds: [] as string[],
    coastalBands: null,
    detailFocusKey,
    base: data.base,
    // focus で描画から外れた諸侯領を powers の塗りへ戻すための入力（#382）
    hre: data.hre,
    fiefs: data.fiefs,
    italyFiefs: data.italyFiefs,
    cliopatriaFiefs: data.cliopatriaFiefs,
    britainFiefs: data.britainFiefs,
    sovereignFiefs: data.sovereignFiefs,
  };
}

function containsPoint(feature: Feature, point: Position): boolean {
  const geometry = feature.geometry;
  if (
    geometry === null ||
    (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")
  ) {
    return false;
  }
  return booleanPointInPolygon(point, geometry as Polygon | MultiPolygon);
}

/** 実際に塗られる 1 件（レイヤー ID + feature） */
interface Painted {
  readonly layerId: string;
  readonly feature: Feature;
}

/**
 * 指定 focus で **実際に各レイヤーへ渡る data** を組み立て、点を覆う feature を
 * 全て集める。deck_app.ts `renderLayers` と同じ builder・同じ引数を通すため、
 * 「テストだけが通る合成」にならない。
 */
function paintedAt(
  data: YearData,
  detailFocusKey: string | null,
  overrides: SuzerainOverrides,
  point: Position,
  zoomStep = 5,
): Painted[] {
  const builders = createPoliticalLayerBuilders();
  const ctx = focusContext(data, detailFocusKey, overrides, zoomStep);
  const layers: readonly (readonly [string, FeatureCollection])[] = [
    [
      POWER_LAYER_ID,
      builders.powerFillData(ctx, data.base, data.baseFill, true),
    ],
    [HRE_LAYER_ID, data.hre],
    [FRANCE_FIEF_LAYER_ID, data.fiefs],
    [ITALY_FIEF_LAYER_ID, data.italyFiefs],
    [CLIOPATRIA_FIEF_LAYER_ID, data.cliopatriaFiefs],
    [BRITAIN_FIEF_LAYER_ID, data.britainFiefs],
    [SOVEREIGN_FIEF_LAYER_ID, data.sovereignFiefs],
  ];
  const painted: Painted[] = [];
  for (const [layerId, fc] of layers) {
    const layer = builders.buildPowerLayer(ctx, layerId, fc);
    const drawn = layer.props.data as FeatureCollection;
    for (const feature of drawn.features) {
      if (containsPoint(feature, point)) painted.push({ layerId, feature });
    }
  }
  return painted;
}

function paintedNames(painted: readonly Painted[]): string[] {
  return painted.map((p) => String(p.feature.properties?.NAME));
}

Deno.test("#382: focus が Poland でもシロンスク／モラヴィア境界は 1 度だけ塗られる", async () => {
  const overrides = await realOverrides();
  for (const c of CASES) {
    const data = await loadYear(c.year);
    const label = `${c.year} ${c.place} (${c.point.join(",")})`;
    // 再現手順は各地点を画面中央に据えるため、focus は base の Poland になる
    assertEquals(
      detailFocusKeyAt(c.point, data.base, overrides),
      POLAND,
      label,
    );
    assertEquals(
      paintedNames(paintedAt(data, POLAND, overrides, c.point)),
      [c.expected],
      `${label}: focus=Poland で塗られる feature がちょうど 1 件でない`,
    );
  }
});

Deno.test("#382 AC4: focus が HRE 側でも同じ面が二重塗りにならない", async () => {
  const overrides = await realOverrides();
  for (const c of CASES) {
    const data = await loadYear(c.year);
    const label = `${c.year} ${c.place} (${c.point.join(",")})`;
    assertEquals(
      paintedNames(paintedAt(data, HRE, overrides, c.point)),
      [c.expected],
      `${label}: focus=HRE で塗られる feature がちょうど 1 件でない`,
    );
  }
});

Deno.test("#382: 解決不能 focus（中央が海上）でも同じ面が 1 度だけ塗られる", async () => {
  const overrides = await realOverrides();
  for (const c of CASES) {
    const data = await loadYear(c.year);
    const label = `${c.year} ${c.place} (${c.point.join(",")})`;
    assertEquals(
      paintedNames(
        paintedAt(data, UNRESOLVED_DETAIL_FOCUS_KEY, overrides, c.point),
      ),
      [c.expected],
      `${label}: 解決不能 focus で塗られる feature がちょうど 1 件でない`,
    );
  }
});

/**
 * 塗られている feature（= その地点の pick 候補）から、クリックが実際に採る
 * 1 件を決める（pick_handlers.ts `resolveClickInfo` と同じ純粋関数を通す）。
 */
function resolvedPickName(
  data: YearData,
  focusKey: string,
  overrides: SuzerainOverrides,
  point: Position,
  painted: readonly Painted[],
): string | null {
  const picks = painted.map((p) => ({
    layer: { id: p.layerId },
    object: p.feature,
  }));
  const resolved = resolveClickPick(picks, point, {
    key: focusKey,
    suzerainKeyOf: (layerId, object) =>
      suzerainExtentKey(
        layerId,
        object as Feature | undefined,
        data.base,
        overrides,
      ),
  });
  const name = (resolved?.object as Feature | undefined)?.properties?.NAME;
  return typeof name === "string" ? name : null;
}

Deno.test("#382 AC3: 該当地点の picking が諸侯領を返す（focus の中外を問わず）", async () => {
  const overrides = await realOverrides();
  for (const c of CASES) {
    const data = await loadYear(c.year);
    const label = `${c.year} ${c.place} (${c.point.join(",")})`;
    for (const focusKey of [POLAND, HRE]) {
      const painted = paintedAt(data, focusKey, overrides, c.point);
      assert(
        painted.length > 0,
        `${label}: focus=${focusKey} で pick 候補が無い`,
      );
      assertEquals(
        resolvedPickName(data, focusKey, overrides, c.point, painted),
        c.expected,
        `${label}: focus=${focusKey} の picking が諸侯領を返さない`,
      );
    }
  }
});

Deno.test("#382: 塗りと picking がズーム段（z6 / z8）で食い違わない", async () => {
  // 実測では z6 の未塗装部分をクリックすると隣接する「ヴロツワフ公国 —
  // ポーランド領」が返り、z8 では null が返っていた（塗りが無いのに pick が
  // 返る／段によって答えが変わる）。詳細表示の対象選択は z5 以上で一律
  // （suzerain_extent.ts detailFocusAppliesAt）なので、塗りも picking も
  // z6 と z8 で同一でなければならない。
  const overrides = await realOverrides();
  for (const c of CASES) {
    const data = await loadYear(c.year);
    const label = `${c.year} ${c.place} (${c.point.join(",")})`;
    for (const focusKey of [POLAND, HRE]) {
      const [mid, detail] = [6, 8].map((zoomStep) =>
        paintedAt(data, focusKey, overrides, c.point, zoomStep)
      );
      assertEquals(paintedNames(mid), [c.expected], `${label}: z6 の塗り`);
      assertEquals(paintedNames(detail), [c.expected], `${label}: z8 の塗り`);
      assertEquals(
        resolvedPickName(data, focusKey, overrides, c.point, mid),
        resolvedPickName(data, focusKey, overrides, c.point, detail),
        `${label}: focus=${focusKey} の picking が z6 と z8 で食い違う`,
      );
    }
  }
});
