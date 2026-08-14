/**
 * 年代別インベントリ集計スクリプト（Issue #379）の単体テスト。
 *
 * 集計規則（独立／属領の判定・NAME 単位の面積合算・色キー・bbox）を固定する。
 * 現物の `data/` に依存する期待値はここでは持たない（データ更新のたびに落ちる
 * テストになるため）。台帳と現物の突き合わせは別途 AC5 の判断による。
 */
import { assertAlmostEquals, assertEquals } from "@std/assert";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import {
  aggregateFiefs,
  aggregatePowers,
  aggregateUnnamed,
  bboxOf,
  colorKeyOf,
} from "./measure-year-inventory.ts";

/** 経度・緯度の矩形 feature を作る */
function rect(
  properties: Record<string, unknown>,
  west: number,
  south: number,
  east: number,
  north: number,
): Feature<Polygon> {
  return {
    type: "Feature",
    properties,
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
}

function collection(features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

Deno.test("aggregatePowers は SUBJECTO と NAME の一致で独立／属領を分ける", () => {
  const fc = collection([
    rect({ NAME: "A", SUBJECTO: "A" }, 0, 0, 1, 1),
    rect({ NAME: "B", SUBJECTO: "A" }, 2, 0, 3, 1),
    rect({ NAME: "C" }, 4, 0, 5, 1),
  ]);
  const rows = aggregatePowers(fc, {}, {});
  const byName = new Map(rows.map((row) => [row.name, row]));
  assertEquals(byName.get("A")?.subordinate, false);
  assertEquals(byName.get("B")?.subordinate, true);
  // SUBJECTO 欠損は独立扱い（台帳 §2.1 の「SUBJECTO が自身 or null」）
  assertEquals(byName.get("C")?.subordinate, false);
});

Deno.test("aggregatePowers は同一 NAME の feature を合算し件数を数える", () => {
  const fc = collection([
    rect({ NAME: "A", SUBJECTO: "A" }, 0, 0, 1, 1),
    rect({ NAME: "A", SUBJECTO: "A" }, 2, 0, 3, 1),
  ]);
  const [row] = aggregatePowers(fc, {}, {});
  assertEquals(row.name, "A");
  assertEquals(row.features, 2);
  // 同緯度・同サイズの矩形 2 枚なので単体の 2 倍になる（km² への丸めで ±1）
  const [single] = aggregatePowers(
    collection([rect({ NAME: "A", SUBJECTO: "A" }, 0, 0, 1, 1)]),
    {},
    {},
  );
  assertAlmostEquals(row.areaKm2, single.areaKm2 * 2, 1);
});

Deno.test("aggregatePowers は NAME = null を除外し面積降順に並べる", () => {
  const fc = collection([
    rect({ NAME: "small", SUBJECTO: "small" }, 0, 0, 1, 1),
    rect({ NAME: "big", SUBJECTO: "big" }, 10, 0, 20, 5),
    rect({}, 30, 0, 31, 1),
  ]);
  assertEquals(aggregatePowers(fc, {}, {}).map((row) => row.name), [
    "big",
    "small",
  ]);
});

Deno.test("aggregatePowers は日本語名と色を引き当てる（属領は NAME|SUBJECTO）", () => {
  const fc = collection([
    rect({ NAME: "Moravia", SUBJECTO: "Holy Roman Empire" }, 0, 0, 1, 1),
    rect({ NAME: "Poland", SUBJECTO: "Poland" }, 2, 0, 3, 1),
  ]);
  const rows = aggregatePowers(
    fc,
    { Moravia: "モラヴィア辺境伯領", Poland: "ポーランド" },
    { "Moravia|Holy Roman Empire": "#8b91b1", Poland: "#cda8a2" },
  );
  const byName = new Map(rows.map((row) => [row.name, row]));
  assertEquals(byName.get("Moravia")?.nameJa, "モラヴィア辺境伯領");
  assertEquals(byName.get("Moravia")?.color, "#8b91b1");
  assertEquals(byName.get("Poland")?.color, "#cda8a2");
});

Deno.test("colorKeyOf は独立勢力を NAME、属領を NAME|SUBJECTO にする", () => {
  assertEquals(colorKeyOf("Poland", "Poland"), "Poland");
  assertEquals(colorKeyOf("Poland", null), "Poland");
  assertEquals(
    colorKeyOf("Moravia", "Holy Roman Empire"),
    "Moravia|Holy Roman Empire",
  );
});

Deno.test("aggregateUnnamed は NAME = null だけを bbox 付きで返す", () => {
  const fc = collection([
    rect({ NAME: "A", SUBJECTO: "A" }, 0, 0, 1, 1),
    rect({}, -25, 69, -21, 72),
  ]);
  const rows = aggregateUnnamed(fc);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].bbox, [-25, 69, -21, 72]);
});

Deno.test("bboxOf は MultiPolygon の全パートを覆う", () => {
  assertEquals(
    bboxOf({
      type: "MultiPolygon",
      coordinates: [
        [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
        [[[5, -2], [6, -2], [6, 3], [5, 3], [5, -2]]],
      ],
    }),
    [0, -2, 6, 3],
  );
});

Deno.test("aggregateFiefs は OHM 属性を保ったまま面積降順で返す", () => {
  const fc = collection([
    rect(
      { NAME: "County of Small", ADMIN_LEVEL: 4, OHM_RELATION_ID: 2 },
      0,
      0,
      1,
      1,
    ),
    rect(
      {
        NAME: "Duchy of Big",
        ADMIN_LEVEL: 3,
        OHM_RELATION_ID: 1,
        START_DATE: "1137-04-09",
        END_DATE: "1214-09-28",
      },
      10,
      0,
      20,
      5,
    ),
  ]);
  const rows = aggregateFiefs(fc, { "Duchy of Big": "大公領" });
  assertEquals(rows.map((row) => row.name), [
    "Duchy of Big",
    "County of Small",
  ]);
  assertEquals(rows[0].nameJa, "大公領");
  assertEquals(rows[0].adminLevel, 3);
  assertEquals(rows[0].ohmRelationId, 1);
  assertEquals(rows[0].startDate, "1137-04-09");
  assertEquals(rows[1].nameJa, null);
  assertEquals(rows[1].startDate, null);
});
