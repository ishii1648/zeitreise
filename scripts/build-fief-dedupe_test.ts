import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertThrows,
} from "@std/assert";
import area from "@turf/area";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import difference from "@turf/difference";
import { featureCollection } from "@turf/helpers";
import union from "@turf/union";
import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiPolygon,
  Polygon,
  Position,
} from "geojson";
import {
  baseFillOutsideFiefs,
  baseFillPathFor,
  coverageByPowerName,
  fiefsPathsFor,
  fiefUnionOf,
  mergeThinBaseFillParts,
  MIN_RECORDED_COVERAGE,
  outlinesOutsideFiefs,
} from "./build-fief-dedupe.ts";
import {
  BASE_OUTLINE_YEARS,
  FRANCE_FIEF_OVERLAY_YEARS,
  HRE_FIEF_OVERLAY_YEARS,
} from "../src/config.ts";
import { FIEF_DEDUPE_YEARS, parseTargetYears } from "./build-fief-dedupe.ts";
import dedupeTable from "../data/fief-dedupe.json" with { type: "json" };
import {
  FIEF_COVERAGE_SUPPRESS_THRESHOLD,
  parseFiefDedupeTable,
  suppressedPowerNames,
} from "../src/fief_dedupe.ts";

/** 矩形ポリゴンの feature（NAME 付き） */
function box(
  name: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Feature<Polygon> {
  return {
    type: "Feature",
    properties: { NAME: name },
    geometry: {
      type: "Polygon",
      coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
    },
  };
}

function fc(features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

/** data/ 直下の生成物を読む（TASK-92 の実データ検査で使う） */
async function readCollection(name: string): Promise<FeatureCollection> {
  return JSON.parse(
    await Deno.readTextFile(`data/${name}`),
  ) as FeatureCollection;
}

/** ライン片の中央セグメントの中点（端点は境界上になり得るため使わない） */
function midpoint(coords: readonly Position[]): Position {
  const i = Math.floor((coords.length - 1) / 2);
  return [
    (coords[i][0] + coords[i + 1][0]) / 2,
    (coords[i][1] + coords[i + 1][1]) / 2,
  ];
}

Deno.test("FIEF_DEDUPE_YEARS は base 境界線オーバーレイの対象年（仏諸侯領 ∪ HRE 領邦）と同値（TASK-86）", () => {
  assertEquals([...FIEF_DEDUPE_YEARS], [...BASE_OUTLINE_YEARS]);
  // TASK-86 で HRE 領邦だけがある 1400 / 1492 が加わった
  assert(FIEF_DEDUPE_YEARS.includes(1400));
  assert(FIEF_DEDUPE_YEARS.includes(1492));
  // #189: 主権政体オーバーレイで 1815 / 1880 / 1900 が加わった
  assert(FIEF_DEDUPE_YEARS.includes(1815));
  assert(FIEF_DEDUPE_YEARS.includes(1880));
  assert(FIEF_DEDUPE_YEARS.includes(1900));
});

Deno.test("parseTargetYears: 年指定で対象年を絞れる（#189。既存年のバイト不変の構造的保証）", () => {
  assertEquals(parseTargetYears([]), [...FIEF_DEDUPE_YEARS]);
  assertEquals(parseTargetYears(["1880", "1815", "1880"]), [1815, 1880]);
  // #191: 1914 も主権政体オーバーレイ（微小国家 4 政体）の対象年になった
  assertEquals(parseTargetYears(["1914"]), [1914]);
  assertThrows(() => parseTargetYears(["1850"]));
});

Deno.test("fiefsPathsFor はその年に存在するオーバーレイの入力を全て返す（TASK-86/96/110、#172）", () => {
  // 同時表示年は仏諸侯領・HRE 領邦・伊諸侯領 + Cliopatria + ブリテンの 5 系統。
  // #390: 渡すのは全系統とも **ランタイムが描く flat**。raw を渡すと、flat 化で
  // 落ちた面（#376 の 1200 年 Cliopatria の分離片など）が union に入って base
  // 塗りを削り、誰も描かない穴になる。年ごとの例外扱いをやめて機構で揃えた
  assertEquals(fiefsPathsFor(1200), [
    "data/france_fiefs_flat_1200.geojson",
    "data/hre_fiefs_flat_1200.geojson",
    "data/italy_fiefs_flat_1200.geojson",
    "data/cliopatria_fiefs_flat_1200.geojson",
    "data/britain_fiefs_flat_1200.geojson",
    "data/sovereign_fiefs_flat_1200.geojson",
  ]);
  // 1400 以降は HRE 領邦・伊諸侯領・Cliopatria + ブリテン（仏諸侯領は 1300 まで）。
  // TASK-110: Cliopatria を外すと 1400 / 1492 のバイエルン公領などの下に
  // base 塗りが残り、半透明が二重に重なって濃くなる。
  // #202: 1492 年だけは隣接年から流用した面（オーストリア大公領・ミラノ公国）も
  // 入力に含む。借用面もランタイムが描くのはホスト系統 flat を差し引いた
  // borrowed_<系統>_flat_<year>（#215）なので、そちらを渡す。
  assertEquals(fiefsPathsFor(1492), [
    "data/hre_fiefs_flat_1492.geojson",
    "data/italy_fiefs_flat_1492.geojson",
    "data/cliopatria_fiefs_flat_1492.geojson",
    "data/britain_fiefs_flat_1492.geojson",
    "data/sovereign_fiefs_flat_1492.geojson",
    "data/borrowed_hre_flat_1492.geojson",
    "data/borrowed_italy_flat_1492.geojson",
  ]);
  // #188: 1500 年は伊諸侯領（近世初頭拡張）+ ブリテン。伊を登録しないと
  // base の Holy Roman Empire 一括塗りが北・中伊の諸邦の下に残り、
  // 半透明が二重に重なって濃くなる。
  assertEquals(fiefsPathsFor(1500), [
    "data/italy_fiefs_flat_1500.geojson",
    "data/cliopatria_fiefs_flat_1500.geojson",
    "data/britain_fiefs_flat_1500.geojson",
    "data/sovereign_fiefs_flat_1500.geojson",
  ]);
  // #172: 近世（1530〜1700）はブリテンのみが対象。これを登録しないと
  // 1600 以降の England and Ireland の下に base 塗りが残り、アイルランド王国の
  // 半透明が二重に重なって濃くなる（既存 4 系統と同じ二重塗りの解消方針）。
  assertEquals(fiefsPathsFor(1530), [
    "data/cliopatria_fiefs_flat_1530.geojson",
    "data/britain_fiefs_flat_1530.geojson",
    "data/sovereign_fiefs_flat_1530.geojson",
  ]);
  assertEquals(fiefsPathsFor(1600), [
    "data/cliopatria_fiefs_flat_1600.geojson",
    "data/britain_fiefs_flat_1600.geojson",
    "data/sovereign_fiefs_flat_1600.geojson",
  ]);
  // #187: 1715 以降は HRE 領邦（OHM 由来の近世 3 年代）に加え、#189 の
  // 主権政体オーバーレイが対象。これを登録しないとハンガリー王国・
  // クリミア・ハン国などの下に base の一枚岩塗りが残り、半透明が二重に
  // 重なって濃くなる。
  // #209: 1715 年は隣接年（1700）から流用したザクセン選帝侯領も入力に含む。
  assertEquals(fiefsPathsFor(1715), [
    "data/hre_fiefs_flat_1715.geojson",
    "data/cliopatria_fiefs_flat_1715.geojson",
    "data/sovereign_fiefs_flat_1715.geojson",
    "data/borrowed_hre_flat_1715.geojson",
  ]);
  assertEquals(fiefsPathsFor(1783), [
    "data/hre_fiefs_flat_1783.geojson",
    "data/cliopatria_fiefs_flat_1783.geojson",
    "data/sovereign_fiefs_flat_1783.geojson",
  ]);
  assertEquals(fiefsPathsFor(1800), [
    "data/hre_fiefs_flat_1800.geojson",
    "data/cliopatria_fiefs_flat_1800.geojson",
    "data/sovereign_fiefs_flat_1800.geojson",
  ]);
  // #189: 1815〜1900 は主権政体オーバーレイのみが対象
  assertEquals(fiefsPathsFor(1815), ["data/sovereign_fiefs_flat_1815.geojson"]);
  assertEquals(fiefsPathsFor(1880), ["data/sovereign_fiefs_flat_1880.geojson"]);
  assertEquals(fiefsPathsFor(1900), ["data/sovereign_fiefs_flat_1900.geojson"]);
  // #191: 1914 年も主権政体オーバーレイ（微小国家 4 政体）だけが対象
  assertEquals(fiefsPathsFor(1914), ["data/sovereign_fiefs_flat_1914.geojson"]);
  // 対象外年（スナップショット年ですらない）は 1 件も無い
  assertEquals(fiefsPathsFor(1850), []);
});

Deno.test("生成済みの fief-dedupe.json は HRE 領邦年代を含み、帝国本体のラベルは抑制しない（TASK-86 AC #3/#5）", () => {
  const table = parseFiefDedupeTable(dedupeTable);
  for (const year of FIEF_DEDUPE_YEARS) {
    assert(
      table.years[String(year)] !== undefined,
      `${year} の被覆率が fief-dedupe.json に無い`,
    );
    // 帝国本体は領邦オーバーレイに覆い尽くされないため、
    // 「神聖ローマ帝国」のラベルは 1500 年以降と同じく常に出る
    assert(
      !suppressedPowerNames(table, year).has("Holy Roman Empire"),
      `${year} で Holy Roman Empire のラベルが抑制されている`,
    );
  }
});

Deno.test("base と HRE 領邦の双方に現れる勢力は base 側のラベルが抑制される（TASK-86 AC #3）", () => {
  // europe_1000 の Duchy of Swabia は hre_fiefs_1000 にも同名で入っており、
  // オーバーレイが同じ土地を描き直すため base 側のラベルは二重表示になる。
  const table = parseFiefDedupeTable(dedupeTable);
  const coverage = table.years["1000"]?.["Duchy of Swabia"] ?? 0;
  assert(
    coverage >= FIEF_COVERAGE_SUPPRESS_THRESHOLD,
    `Duchy of Swabia の被覆率が閾値未満: ${coverage}`,
  );
  assert(suppressedPowerNames(table, 1000).has("Duchy of Swabia"));
});

Deno.test("fiefUnionOf は隣接する諸侯領を 1 つのポリゴンへ統合する", () => {
  const union = fiefUnionOf(
    fc([box("A", 0, 0, 1, 1), box("B", 1, 0, 2, 1)]),
  );
  assert(union !== null);
  assertAlmostEquals(area(union), area(box("AB", 0, 0, 2, 1)), 1);
});

Deno.test("fiefUnionOf は諸侯領が無ければ null を返す", () => {
  assertEquals(fiefUnionOf(fc([])), null);
});

Deno.test("coverageByPowerName は諸侯領に完全内包される勢力を 1 とする（ブルターニュ相当）", () => {
  const union = fiefUnionOf(fc([box("Fief", 0, 0, 1, 1)]));
  const coverage = coverageByPowerName(
    fc([box("Britany", 0.2, 0.2, 0.8, 0.8)]),
    union,
  );
  assertAlmostEquals(coverage["Britany"], 1, 0.001);
});

Deno.test("coverageByPowerName は部分重複を面積比で返す（ブルターニュ以外は抑制されない）", () => {
  const union = fiefUnionOf(fc([box("Fief", 0, 0, 1, 1)]));
  const coverage = coverageByPowerName(fc([box("France", 0, 0, 2, 1)]), union);
  assertAlmostEquals(coverage["France"], 0.5, 0.01);
});

Deno.test("coverageByPowerName は同名の複数 feature を面積加重で集計する", () => {
  const union = fiefUnionOf(fc([box("Fief", 0, 0, 1, 1)]));
  const coverage = coverageByPowerName(
    fc([box("Split", 0, 0, 1, 1), box("Split", 2, 0, 3, 1)]),
    union,
  );
  assertAlmostEquals(coverage["Split"], 0.5, 0.01);
});

Deno.test("coverageByPowerName は重ならない勢力を表に載せない", () => {
  const union = fiefUnionOf(fc([box("Fief", 0, 0, 1, 1)]));
  const coverage = coverageByPowerName(fc([box("Far", 10, 10, 11, 11)]), union);
  assertEquals(Object.hasOwn(coverage, "Far"), false);
});

Deno.test("coverageByPowerName は MIN_RECORDED_COVERAGE 未満の微小重複を捨てる", () => {
  const union = fiefUnionOf(fc([box("Fief", 0, 0, 1, 1)]));
  // 1000 x 1 の勢力が 1 x 1 だけ重なる ≒ 被覆率 0.001 未満
  const coverage = coverageByPowerName(fc([box("Huge", 0, 0, 2000, 1)]), union);
  assert(MIN_RECORDED_COVERAGE > 0);
  assertEquals(Object.hasOwn(coverage, "Huge"), false);
});

Deno.test("coverageByPowerName は諸侯領 union が null なら空表を返す", () => {
  assertEquals(coverageByPowerName(fc([box("France", 0, 0, 1, 1)]), null), {});
});

Deno.test("coverageByPowerName は NAME を持たない feature を無視する", () => {
  const union = fiefUnionOf(fc([box("Fief", 0, 0, 1, 1)]));
  const anonymous: Feature = {
    type: "Feature",
    properties: {},
    geometry: box("x", 0, 0, 1, 1).geometry,
  };
  assertEquals(coverageByPowerName(fc([anonymous]), union), {});
});

Deno.test("coverageByPowerName のキーは昇順で決定的", () => {
  const union = fiefUnionOf(fc([box("Fief", 0, 0, 10, 10)]));
  const coverage = coverageByPowerName(
    fc([box("Zeta", 0, 0, 1, 1), box("Alpha", 1, 1, 2, 2)]),
    union,
  );
  assertEquals(Object.keys(coverage), ["Alpha", "Zeta"]);
});

Deno.test("outlinesOutsideFiefs は諸侯領に完全内包される境界線を出力しない（二重輪郭の解消）", () => {
  const union = fiefUnionOf(fc([box("Fief", 0, 0, 10, 10)]));
  const outlines = outlinesOutsideFiefs(
    fc([box("Britany", 1, 1, 2, 2)]),
    union,
  );
  assertEquals(outlines.features.length, 0);
});

Deno.test("outlinesOutsideFiefs は諸侯領の外側の境界線をそのまま残す", () => {
  const union = fiefUnionOf(fc([box("Fief", 0, 0, 1, 1)]));
  const outside = box("Bohemia", 10, 10, 11, 11);
  const outlines = outlinesOutsideFiefs(fc([outside]), union);
  assertEquals(outlines.features.length, 1);
  assertEquals(outlines.features[0].properties?.NAME, "Bohemia");
  assertEquals(
    (outlines.features[0].geometry as LineString).coordinates,
    outside.geometry.coordinates[0],
  );
});

Deno.test("outlinesOutsideFiefs は諸侯領を跨ぐ境界線から内側の部分だけを落とす", () => {
  const fief = box("Fief", 0, 0, 1, 1);
  const union = fiefUnionOf(fc([fief]));
  assert(union !== null);
  const outlines = outlinesOutsideFiefs(
    fc([box("France", 0.5, 0.5, 3, 3)]),
    union,
  );
  assert(outlines.features.length > 0);
  for (const feature of outlines.features) {
    const coords = (feature.geometry as LineString).coordinates;
    assert(
      !booleanPointInPolygon(
        midpoint(coords),
        union as Feature<Polygon | MultiPolygon>,
      ),
      `諸侯領内部に残ったライン: ${JSON.stringify(coords)}`,
    );
  }
});

Deno.test("outlinesOutsideFiefs は bbox が重なるだけで交差しない境界線を落とさない", () => {
  // 諸侯領 union の bbox（[0,0,4,4]）の内側だが、どの諸侯領とも交差しない位置。
  // turf の lineSplit は交差が無いと 0 件を返すため、これを「内側」と誤って
  // 扱うと神聖ローマ帝国・イングランドの輪郭が丸ごと消える（実測で発生）。
  const union = fiefUnionOf(fc([box("A", 0, 0, 1, 1), box("B", 3, 3, 4, 4)]));
  const outlines = outlinesOutsideFiefs(
    fc([box("Holy Roman Empire", 1.5, 1.5, 2.5, 2.5)]),
    union,
  );
  assertEquals(outlines.features.length, 1);
  assertEquals(
    (outlines.features[0].geometry as LineString).coordinates.length,
    5,
  );
});

Deno.test("outlinesOutsideFiefs は union が null なら全境界線を残す（対象外年の非退行）", () => {
  const outlines = outlinesOutsideFiefs(
    fc([box("France", 0, 0, 1, 1), box("Bohemia", 5, 5, 6, 6)]),
    null,
  );
  assertEquals(outlines.features.length, 2);
});

Deno.test("outlinesOutsideFiefs は穴（内環）も独立したラインとして出力する", () => {
  const withHole: Feature<Polygon> = {
    type: "Feature",
    properties: { NAME: "Donut" },
    geometry: {
      type: "Polygon",
      coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
        [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
      ],
    },
  };
  const outlines = outlinesOutsideFiefs(fc([withHole]), null);
  assertEquals(outlines.features.length, 2);
});

// ---------------------------------------------------------------------------
// TASK-92: 諸侯領オーバーレイと base 勢力の二重塗り解消（europe_flat_<year>）
// ---------------------------------------------------------------------------

Deno.test("baseFillOutsideFiefs は諸侯領 union と重なる部分を base 塗りから取り除く（TASK-92）", () => {
  const base = fc([box("France", 0, 0, 10, 10)]);
  const union = box("fiefs", 0, 0, 5, 10);
  const { fc: flat, removedNames } = baseFillOutsideFiefs(base, union);
  assertEquals(removedNames, []);
  assertEquals(flat.features.length, 1);
  assertEquals(flat.features[0].properties?.NAME, "France");
  // 残るのは東半分だけ（面積比 1/2）
  assertAlmostEquals(
    area(flat.features[0]) / area(base.features[0]),
    0.5,
    0.01,
  );
  // 残った面は諸侯領の内側を含まない
  assert(
    !booleanPointInPolygon([2.5, 5], flat.features[0] as Feature<Polygon>),
  );
  assert(booleanPointInPolygon([7.5, 5], flat.features[0] as Feature<Polygon>));
});

Deno.test("baseFillOutsideFiefs は諸侯領 union に完全内包される勢力を落とす（ブルターニュ相当。TASK-92）", () => {
  const base = fc([box("Britany", 2, 2, 4, 4), box("France", 0, 0, 10, 10)]);
  const union = box("fiefs", 1, 1, 5, 5);
  const { fc: flat, removedNames } = baseFillOutsideFiefs(base, union);
  assertEquals(removedNames, ["Britany"]);
  assertEquals(flat.features.map((f) => f.properties?.NAME), ["France"]);
});

Deno.test("baseFillOutsideFiefs は諸侯領と重ならない勢力を同一参照のまま残す（TASK-92）", () => {
  const untouched = box("Poland", 20, 20, 30, 30);
  const base = fc([untouched]);
  const { fc: flat, removedNames } = baseFillOutsideFiefs(
    base,
    box("fiefs", 0, 0, 5, 5),
  );
  assertEquals(removedNames, []);
  assertEquals(
    JSON.stringify(flat.features[0].geometry),
    JSON.stringify(untouched.geometry),
  );
});

Deno.test("baseFillOutsideFiefs は union が null なら入力をそのまま返す（対象外年の非退行。TASK-92）", () => {
  const base = fc([box("France", 0, 0, 10, 10)]);
  const { fc: flat, removedNames } = baseFillOutsideFiefs(base, null);
  assertEquals(removedNames, []);
  assertEquals(flat, base);
});

Deno.test("baseFillPathFor は data/europe_flat_<year>.geojson を指す（TASK-92）", () => {
  assertEquals(baseFillPathFor(1200), "data/europe_flat_1200.geojson");
});

// ---------------------------------------------------------------------------
// #390: 差し引きの残片（細片）を捨てない
//
// europe_flat は塗り専用の派生なので、落としたパートはそのまま未塗装の穴に
// なる。細片は「隣接 feature へ併合」か「元の feature に残す」のどちらかで
// 必ず塗りとして残らなければならない。
// ---------------------------------------------------------------------------

/**
 * 細片の寸法（度）。座標グリッド 1 目盛り（0.001 度 ≒ 111 m）幅 × 0.05 度長で
 * 面積は約 0.62 km²、clean-polygons の MIN_PART_AREA_M2（1 km²）に満たない。
 *
 * グリッドに載る値を選ぶのは、mergeThinBaseFillParts が結果を COORD_PRECISION
 * へ丸めるため。半端な値を使うと丸めで形が変わり、面積の保存を検査できない。
 */
const THIN_W = 0.001;
const THIN_H = 0.05;

/** ジオメトリのパート数 */
function partCount(feature: Feature): number {
  const geometry = feature.geometry as Polygon | MultiPolygon;
  return geometry.type === "Polygon" ? 1 : geometry.coordinates.length;
}

/** FeatureCollection の総面積（km²） */
function totalAreaKm2(collection: FeatureCollection): number {
  return collection.features.reduce((sum, f) => sum + area(f), 0) / 1e6;
}

Deno.test("#390: 隣接勢力と境界を共有する細片は併合され、面積が失われない", () => {
  // France の本体（0–1）と、その東隣に細片だけが残った Moravia。
  // 帯の西辺は France の東辺に載るので共有境界が見つかる
  const fill = fc([
    box("France", 0, 0, 1, 1),
    box("Moravia", 1, 0, 1 + THIN_W, THIN_H),
  ]);
  const before = totalAreaKm2(fill);
  const { fc: merged, merged: log, orphaned, droppedNames } =
    mergeThinBaseFillParts(fill, () => {});
  // 帯は France に吸われ、幅 111 m だけの Moravia は feature ごと消える
  // （TASK-130 が塞いだ「幻の勢力」を作らない）
  assertEquals(merged.features.map((f) => f.properties?.NAME), ["France"]);
  assertEquals(partCount(merged.features[0]), 1);
  assertEquals(log.map((m) => `${m.from}->${m.into}`), ["Moravia->France"]);
  assertEquals(orphaned, []);
  assertEquals(droppedNames, ["Moravia"]);
  // 面積は失われない（帯の分だけ France が広がる）
  assertAlmostEquals(totalAreaKm2(merged), before, before * 1e-6);
});

Deno.test("#390: 本体が残っている feature の細片は自分自身へ戻る", () => {
  // Poland は本体（0–1）と、東へ突き出た細片を持つ。帯は本体と辺を共有する
  // ので、他所へ渡さず本体に吸収されるのが正しい
  const fill = fc([
    {
      type: "Feature",
      properties: { NAME: "Poland" },
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
          [[[1, 0], [1 + THIN_W, 0], [1 + THIN_W, THIN_H], [1, THIN_H], [
            1,
            0,
          ]]],
        ],
      },
    },
    box("Hungary", 0, -1, 1, 0),
  ]);
  const { fc: merged, merged: log } = mergeThinBaseFillParts(fill, () => {});
  assertEquals(log.map((m) => `${m.from}->${m.into}`), ["Poland->Poland"]);
  const poland = merged.features.find((f) => f.properties?.NAME === "Poland")!;
  assertEquals(partCount(poland), 1);
});

Deno.test("#390: 境界を共有する相手が無い細片は元の feature に残す（落とさない）", () => {
  // オーバーレイどうしの継ぎ目に取り残された島（周囲に base の隣接が無い）。
  // 併合先が無いからと落とすと、そこがそのまま未塗装の筋になる
  const island = box("Austrian Empire", 5, 5, 5 + THIN_W, 5 + THIN_H);
  const fill = fc([
    {
      type: "Feature",
      properties: { NAME: "Austrian Empire" },
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          (box("Austrian Empire", 0, 0, 1, 1).geometry as Polygon).coordinates,
          (island.geometry as Polygon).coordinates,
        ],
      },
    },
  ]);
  const before = totalAreaKm2(fill);
  const { fc: kept, merged, orphaned } = mergeThinBaseFillParts(fill, () => {});
  assertEquals(merged, []);
  assertEquals(orphaned.map((o) => o.from), ["Austrian Empire"]);
  assertEquals(partCount(kept.features[0]), 2);
  assertAlmostEquals(totalAreaKm2(kept), before, before * 1e-6);
});

Deno.test("#390: 併合先は境界を最も長く共有する feature（#342 と同じ規則）", () => {
  // 帯は France と 0.05 度、Hungary と 0.02 度の辺を共有する
  const fill = fc([
    box("France", 0, 0, 1, 1),
    box("Moravia", 1, 0, 1 + THIN_W, THIN_H),
    box("Hungary", 1 + THIN_W, 0, 2, 0.02),
  ]);
  const { fc: merged, merged: log } = mergeThinBaseFillParts(fill, () => {});
  assertEquals(log.map((m) => `${m.from}->${m.into}`), ["Moravia->France"]);
  assertEquals(merged.features.map((f) => f.properties?.NAME), [
    "France",
    "Hungary",
  ]);
});

Deno.test("#390: 細片が無ければ mergeThinBaseFillParts は何も変えない", () => {
  const fill = fc([box("France", 0, 0, 1, 1), box("Hungary", 1, 0, 2, 1)]);
  const { fc: merged, merged: log, orphaned, droppedNames } =
    mergeThinBaseFillParts(fill, () => {});
  assertEquals(log, []);
  assertEquals(orphaned, []);
  assertEquals(droppedNames, []);
  assertEquals(JSON.stringify(merged.features), JSON.stringify(fill.features));
});

/** bbox 付きの feature（点包含判定の前フィルタ用） */
interface Indexed {
  feature: Feature;
  bbox: [number, number, number, number];
}

function bboxOf(feature: Feature): [number, number, number, number] {
  const geometry = feature.geometry as Polygon | MultiPolygon;
  const parts = geometry.type === "Polygon"
    ? [geometry.coordinates]
    : geometry.coordinates;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const part of parts) {
    for (const [x, y] of part[0]) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return [minX, minY, maxX, maxY];
}

function indexOf(features: readonly Feature[]): Indexed[] {
  return features
    .filter((f) =>
      f.geometry?.type === "Polygon" || f.geometry?.type === "MultiPolygon"
    )
    .map((feature) => ({ feature, bbox: bboxOf(feature) }));
}

/** 点を含む feature の NAME 一覧（bbox で前フィルタしてから厳密判定） */
function namesContaining(index: readonly Indexed[], point: Position): string[] {
  const names: string[] = [];
  for (const { feature, bbox } of index) {
    if (
      point[0] < bbox[0] || point[0] > bbox[2] ||
      point[1] < bbox[1] || point[1] > bbox[3]
    ) {
      continue;
    }
    if (booleanPointInPolygon(point, feature as Feature<Polygon>)) {
      const name = feature.properties?.NAME;
      names.push(typeof name === "string" ? name : "(no name)");
    }
  }
  return names;
}

/** feature の内部を格子状にサンプリングした点（決定的） */
function samplePointsInside(feature: Feature, steps: number): Position[] {
  const [minX, minY, maxX, maxY] = bboxOf(feature);
  const points: Position[] = [];
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      const point: Position = [
        minX + ((i + 0.5) / steps) * (maxX - minX),
        minY + ((j + 0.5) / steps) * (maxY - minY),
      ];
      if (booleanPointInPolygon(point, feature as Feature<Polygon>)) {
        points.push(point);
      }
    }
  }
  return points;
}

/** その年に実際に描かれる諸侯領（flat）の feature を全系統ぶん集める */
async function renderedFiefFeatures(year: number): Promise<Feature[]> {
  const paths: string[] = [];
  if (FRANCE_FIEF_OVERLAY_YEARS.includes(year)) {
    paths.push(`france_fiefs_flat_${year}.geojson`);
  }
  if (HRE_FIEF_OVERLAY_YEARS.includes(year)) {
    paths.push(`hre_fiefs_flat_${year}.geojson`);
  }
  const collections = await Promise.all(paths.map(readCollection));
  return collections.flatMap((c) => c.features);
}

Deno.test("諸侯領の内側に base 塗りが残っていない（二重塗りの再現テスト。TASK-92 AC #1）", async () => {
  const offenders: string[] = [];
  for (const year of FIEF_DEDUPE_YEARS) {
    const flat = indexOf(
      (await readCollection(`europe_flat_${year}.geojson`)).features,
    );
    for (const fief of await renderedFiefFeatures(year)) {
      for (const point of samplePointsInside(fief, 8)) {
        for (const name of namesContaining(flat, point)) {
          offenders.push(
            `${year} ${String(fief.properties?.NAME)} @ ${
              point.map((v) => v.toFixed(4)).join(",")
            } に base ${name} が残存`,
          );
        }
      }
    }
  }
  assertEquals(offenders.slice(0, 10), []);
});

Deno.test("諸侯領が覆わない領域の base 塗りは従来どおり残る（TASK-92 AC #2）", async () => {
  const coverage = parseFiefDedupeTable(dedupeTable);
  for (const year of FIEF_DEDUPE_YEARS) {
    const base = await readCollection(`europe_${year}.geojson`);
    const flat = await readCollection(`europe_flat_${year}.geojson`);
    const areaByName = (features: readonly Feature[]) => {
      const totals = new Map<string, number>();
      for (const f of features) {
        const name = f.properties?.NAME;
        if (typeof name !== "string" || f.geometry === null) continue;
        if (
          f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon"
        ) {
          continue;
        }
        totals.set(name, (totals.get(name) ?? 0) + area(f));
      }
      return totals;
    };
    const before = areaByName(base.features);
    const after = areaByName(flat.features);
    for (const [name, baseArea] of before) {
      const covered = coverage.years[String(year)]?.[name] ?? 0;
      const expected = baseArea * (1 - covered);
      const actual = after.get(name) ?? 0;
      // 被覆率は fief-dedupe.json と同じ union から求めた値なので、残る面積は
      // (1 - 被覆率) × 元面積 に一致する（差は座標丸め・微小片の除去のみ）
      assertAlmostEquals(
        actual / baseArea,
        expected / baseArea,
        0.02,
        `${year} ${name} の残存塗り面積が想定と乖離（覆われた割合 ${covered}）`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// #376: 合成塗り（europe_flat + 実際に描かれるオーバーレイ）に穴を残さない
//
// europe_flat は「base − オーバーレイ union」なので、union に入っているのに
// どのオーバーレイも描かない面があると、そこは誰も塗らない穴になる。#376 で
// Cliopatria flat から分離片を落としたため、union の入力を raw のままにすると
// 落とした 298 km² がちょうどこの穴になる（実測で確認済み）。
// ---------------------------------------------------------------------------

/** 1200 年に実際に描かれる塗りのファイル（europe_flat + 全オーバーレイ flat） */
const RENDERED_1200_LAYERS = [
  "europe_flat_1200.geojson",
  "france_fiefs_flat_1200.geojson",
  "hre_fiefs_flat_1200.geojson",
  "italy_fiefs_flat_1200.geojson",
  "cliopatria_fiefs_flat_1200.geojson",
  "britain_fiefs_flat_1200.geojson",
  "sovereign_fiefs_flat_1200.geojson",
];

Deno.test("#376: 1200 年の合成塗りはモラヴィア／下オーストリア境に未塗装の面を残さない", async () => {
  // 起票時の実測: 帯の南縁に 8.649 km²（平均幅 166 m）の未塗装スリバーがあり、
  // z8 で 1px のクリーム色の地形が線状に露出していた。
  const [west, south, east, north] = [16.1, 48.70, 17.0, 48.90];
  const rect: Feature<Polygon> = {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [[
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ]],
    },
  };
  let painted: Feature<Polygon | MultiPolygon> | null = null;
  for (const layer of RENDERED_1200_LAYERS) {
    for (const feature of (await readCollection(layer)).features) {
      const type = feature.geometry?.type;
      if (type !== "Polygon" && type !== "MultiPolygon") continue;
      const [minX, minY, maxX, maxY] = bboxOf(feature);
      if (minX > east || maxX < west || minY > north || maxY < south) continue;
      const current = feature as Feature<Polygon | MultiPolygon>;
      painted = painted === null
        ? current
        : union(featureCollection([painted, current])) ?? painted;
    }
  }
  assert(painted !== null, "1200 年の塗りが 1 枚も見つからない");
  const gaps = difference(featureCollection([rect, painted]));
  const geometry = gaps === null
    ? null
    : gaps.geometry as Polygon | MultiPolygon;
  const parts = geometry === null
    ? []
    : geometry.type === "Polygon"
    ? [geometry.coordinates]
    : geometry.coordinates;
  const unpainted = parts
    .map((part) =>
      area({ type: "Polygon", coordinates: part } as Polygon) / 1e6
    )
    // 座標丸め（COORD_PRECISION=3 ≒ 111 m）由来の微小片は数えない
    .filter((km2) => km2 >= 0.01);
  assertEquals(
    unpainted.map((km2) => `${km2.toFixed(3)} km²`),
    [],
    "1200 年の合成塗りに未塗装の面が残っている",
  );
});
