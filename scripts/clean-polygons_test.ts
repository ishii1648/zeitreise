import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import area from "@turf/area";
import { polygon as turfPolygon } from "@turf/helpers";
import type {
  Feature,
  FeatureCollection,
  MultiPolygon,
  Polygon,
  Position,
} from "geojson";
import {
  cleanFeatureCollection,
  cleanGeometry,
  DEFAULT_COORD_PRECISION,
  dropTinyRings,
  MIN_HOLE_AREA_M2,
  MIN_PART_AREA_M2,
  MIN_PART_MEAN_WIDTH_M,
  normalizeSelfIntersections,
  polygonParts,
  selfIntersectionPoints,
  separateTouchingRings,
} from "./clean-polygons.ts";
import { COORD_PRECISION, SIZE_LIMIT_BYTES, YEARS } from "./build-data.ts";
import {
  FIEF_SIZE_LIMIT_BYTES,
  FRANCE_FIEF_YEARS,
} from "./build-france-fiefs.ts";
import { HRE_OVERLAY_YEARS, HRE_SIZE_LIMIT_BYTES } from "./build-hre.ts";
import {
  ITALY_FIEF_SIZE_LIMIT_BYTES,
  ITALY_FIEF_YEARS,
} from "./build-italy-fiefs.ts";
import {
  BRITAIN_FIEF_SIZE_LIMIT_BYTES,
  BRITAIN_FIEF_YEARS,
} from "./build-britain-fiefs.ts";
import {
  BASE_FILL_SIZE_LIMIT_BYTES,
  MIN_BASE_FILL_PART_AREA_M2,
} from "./build-fief-dedupe.ts";
import { BASE_OUTLINE_YEARS } from "../src/config.ts";

/** 経緯度の矩形リング（反時計回り）。widthDeg 四方 */
function square(
  west: number,
  south: number,
  widthDeg: number,
): Position[] {
  const east = west + widthDeg;
  const north = south + widthDeg;
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

/** 自己交差する蝶ネクタイ型リング（(0.5,0.5) で交差する） */
const BOWTIE: Position[] = [
  [0, 0],
  [1, 1],
  [1, 0],
  [0, 1],
  [0, 0],
];

function poly(rings: Position[][]): Polygon {
  return { type: "Polygon", coordinates: rings };
}

function multi(polygons: Position[][][]): MultiPolygon {
  return { type: "MultiPolygon", coordinates: polygons };
}

function feature(
  name: string,
  geometry: Polygon | MultiPolygon,
): Feature<Polygon | MultiPolygon> {
  return { type: "Feature", properties: { NAME: name }, geometry };
}

function ringAreaM2(ring: Position[]): number {
  return area(turfPolygon([ring]));
}

Deno.test("DEFAULT_COORD_PRECISION は build-data.ts の COORD_PRECISION と一致する", () => {
  // clean-polygons.ts は build-data.ts から import される側なので、循環 import を
  // 避けるため定数を複製している。ドリフトはこのテストで検出する。
  assertEquals(DEFAULT_COORD_PRECISION, COORD_PRECISION);
});

Deno.test("selfIntersectionPoints は自己交差点を検出し、単純なポリゴンでは空", () => {
  const kinked = selfIntersectionPoints(poly([BOWTIE]));
  assertEquals(kinked.length, 1);
  assertAlmostEquals(kinked[0][0], 0.5, 1e-9);
  assertAlmostEquals(kinked[0][1], 0.5, 1e-9);

  assertEquals(selfIntersectionPoints(poly([square(0, 0, 1)])).length, 0);
});

Deno.test("selfIntersectionPoints は MultiPolygon の全パートを見る", () => {
  const geometry = multi([[square(10, 10, 1)], [BOWTIE]]);
  assertEquals(selfIntersectionPoints(geometry).length, 1);
});

Deno.test("normalizeSelfIntersections は自己交差を解消し面積を保つ", () => {
  const before = poly([BOWTIE]);
  const after = normalizeSelfIntersections(before);
  assert(after !== null);
  assertEquals(selfIntersectionPoints(after).length, 0);
  // 蝶ネクタイは交点 (0.5,0.5) で 2 枚の三角形に分割される。面積の合計は
  // 元のリングが実際に囲む面（両ローブ）と一致し、交差部を二重に数えない
  assertEquals(polygonParts(after).length, 2);
  const expected = ringAreaM2([[0, 0], [0.5, 0.5], [0, 1], [0, 0]]) +
    ringAreaM2([[0.5, 0.5], [1, 1], [1, 0], [0.5, 0.5]]);
  assertAlmostEquals(
    area({
      type: "Feature",
      properties: {},
      geometry: after,
    } as Feature),
    expected,
    expected * 1e-6,
  );
});

Deno.test("normalizeSelfIntersections は入力を変更しない（純粋関数）", () => {
  const geometry = poly([BOWTIE]);
  const snapshot = JSON.stringify(geometry);
  normalizeSelfIntersections(geometry);
  assertEquals(JSON.stringify(geometry), snapshot);
});

Deno.test("normalizeSelfIntersections は面が残らない退化ジオメトリで null を返す", () => {
  // 全頂点が一直線に潰れたリング（bbox クリップ・simplify の残骸）
  const degenerate = poly([[
    [0, 0],
    [1, 0],
    [0, 0],
    [0, 0],
  ]]);
  assertEquals(normalizeSelfIntersections(degenerate), null);
});

Deno.test("dropTinyRings は閾値未満のパートと穴だけを落とす", () => {
  // 1 度四方 ≒ 12,300 km² なので、0.01 度四方 ≒ 1.2 km²、0.005 度四方 ≒ 0.3 km²
  const big = square(0, 0, 1);
  const smallPart = square(50, 0, 0.005);
  const bigHole = square(0.2, 0.2, 0.5);
  const smallHole = square(0.1, 0.1, 0.005);
  assert(ringAreaM2(smallPart) < MIN_PART_AREA_M2);
  assert(ringAreaM2(smallHole) < MIN_HOLE_AREA_M2);
  assert(ringAreaM2(bigHole) > MIN_HOLE_AREA_M2);

  const result = dropTinyRings(
    multi([[big, bigHole, smallHole], [smallPart]]),
  );
  assertEquals(result.droppedParts, 1);
  assertEquals(result.droppedHoles, 1);
  assert(result.geometry !== null);
  assertEquals(polygonParts(result.geometry).length, 1);
  assertEquals(polygonParts(result.geometry)[0].length, 2);
});

Deno.test("dropTinyRings は面積が閾値以上でも線状のパート（平均幅がグリッド未満）を落とす（TASK-130）", () => {
  // 実データの残骸: europe_1500 の Denmark-Norway スライバ（約 20 km × 60 m の
  // 三角形、面積 1.27 km²）。面積は MIN_PART_AREA_M2 を超えるが、平均幅
  // 2·面積/周長 ≒ 61 m は座標グリッド 1 目盛り（≒ 111 m）未満で、丸めが
  // 偶然引き伸ばした線状の残骸。これが残ると幻の勢力ラベルが復活する。
  const sliver: Position[] = [
    [11.767, 55.176],
    [11.907, 55.021],
    [11.97, 54.954],
    [11.767, 55.176],
  ];
  assert(ringAreaM2(sliver) >= MIN_PART_AREA_M2);
  const result = dropTinyRings(multi([[sliver]]));
  assertEquals(result.geometry, null);
  assertEquals(result.droppedParts, 1);

  // 同程度の面積でもコンパクトな飛び地（1.2 km 四方、平均幅 ≒ 1.1 km）は残す
  const enclave = square(11, 55, 0.019);
  assert(ringAreaM2(enclave) >= MIN_PART_AREA_M2);
  const kept = dropTinyRings(multi([[enclave]]));
  assertEquals(kept.droppedParts, 0);
  assert(kept.geometry !== null);
});

Deno.test("dropTinyRings は全パートが閾値未満なら null を返す", () => {
  const result = dropTinyRings(multi([[square(0, 0, 0.005)]]));
  assertEquals(result.geometry, null);
  assertEquals(result.droppedParts, 1);
});

Deno.test("dropTinyRings は入力を変更しない（純粋関数）", () => {
  const geometry = multi([[square(0, 0, 1)], [square(50, 0, 0.005)]]);
  const snapshot = JSON.stringify(geometry);
  dropTinyRings(geometry);
  assertEquals(JSON.stringify(geometry), snapshot);
});

Deno.test("cleanGeometry は自己交差が無ければジオメトリを作り直さない", () => {
  const geometry = poly([square(0, 0, 1)]);
  const result = cleanGeometry(geometry);
  // 同一参照で返る = union による正規化を通していない（差分を出さない）
  assertEquals(result.geometry, geometry);
  assertEquals(result.normalized, false);
});

Deno.test("cleanGeometry は自己交差解消と微小破片除去の両方を行う", () => {
  const geometry = multi([[BOWTIE], [square(50, 0, 0.005)]]);
  const result = cleanGeometry(geometry);
  assert(result.geometry !== null);
  assertEquals(selfIntersectionPoints(result.geometry).length, 0);
  assertEquals(result.normalized, true);
  assertEquals(result.droppedParts, 1);
  assertEquals(polygonParts(result.geometry).length, 2);
});

Deno.test("cleanFeatureCollection は並び・properties・非ポリゴンを保つ", () => {
  const line: Feature = {
    type: "Feature",
    properties: { NAME: "river" },
    geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
  };
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      feature("a", poly([square(0, 0, 1)])),
      line,
      feature("b", poly([BOWTIE])),
    ],
  };
  const { fc: cleaned, stats } = cleanFeatureCollection(fc);
  assertEquals(cleaned.features.map((f) => f.properties?.NAME), [
    "a",
    "river",
    "b",
  ]);
  assertEquals(cleaned.features[0], fc.features[0]);
  assertEquals(cleaned.features[1], line);
  assertEquals(stats.normalizedFeatures, 1);
  assertEquals(stats.droppedFeatures, []);
  assertEquals(
    selfIntersectionPoints(
      cleaned.features[2].geometry as Polygon | MultiPolygon,
    ).length,
    0,
  );
});

Deno.test("cleanFeatureCollection は面が残らない feature を落として記録する", () => {
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      feature("keep", poly([square(0, 0, 1)])),
      feature("debris", multi([[square(50, 0, 0.005)]])),
    ],
  };
  const { fc: cleaned, stats } = cleanFeatureCollection(fc);
  assertEquals(cleaned.features.length, 1);
  assertEquals(stats.droppedFeatures, ["debris"]);
});

Deno.test("cleanFeatureCollection は入力を変更しない（純粋関数）", () => {
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [feature("b", poly([BOWTIE]))],
  };
  const snapshot = JSON.stringify(fc);
  cleanFeatureCollection(fc);
  assertEquals(JSON.stringify(fc), snapshot);
});

/**
 * クリーンアップの不変条件を課さない生成物（#326）。
 *
 * 沿岸補完の帯（data/coastal_fill_<year>.geojson、scripts/build-coastal-fill.ts）は
 * 政治ポリゴンではなく**表示専用のマスク**で、本モジュールの前提が当てはまらない:
 * - 帯は定義上「外側 30km バッファ − 全政治ポリゴン」であり、穴は
 *   政治ポリゴンそのものである。MIN_HOLE_AREA_M2（1km²）未満の穴を落とすと
 *   その分だけ帯が政治ポリゴンに重なり、#312 / #313 が構造的に消した
 *   二重塗り（半透明の塗りが濃くなる）が再発する。同じくパートを落とすことは
 *   未着色帯の再発を意味する。
 * - 自己交差は polyclip 差分の出力そのものに含まれる（実測: 1000 年で 47 箇所、
 *   1900 年で 16 箇所）。#312 以降の本番はこの幾何をそのまま MapLibre の fill
 *   レイヤーへ渡しており（ランタイム生成 = 無丸め）、事前生成データも
 *   COASTAL_FILL_COORD_PRECISION を 5 桁に取ることで同数に留めている。
 * - deck.gl の picking・ラベル（polylabel）・派生データの入力にならないため、
 *   本モジュールが守ろうとしている下流（earcut の破綻・面積判定の狂い）が無い。
 */
const CLEANUP_EXEMPT_PATTERN = /^coastal_fill_\d+\.geojson$/;

/** 派生 base（塗り専用。閾値が既定と異なる。#390） */
const BASE_FILL_PATTERN = /^europe_flat_\d+\.geojson$/;

/** クリーンアップ閾値の組 */
interface Thresholds {
  minPartAreaM2: number;
  minHoleAreaM2: number;
  minPartMeanWidthM: number;
}

/**
 * 生成物ごとのクリーンアップ閾値（#390）。
 *
 * 既定（MIN_PART_AREA_M2 = 1 km² / MIN_PART_MEAN_WIDTH_M = 111 m）は
 * 「幻の勢力ラベルを出さない」ための値で、ラベル・picking の主になる
 * `europe_<year>` 系に効かせるものである。`europe_flat_<year>` は**塗り専用**の
 * 派生（ラベル・picking の主・帝国範囲強調は元の base を使う）なので、
 * 落としたパートはそのまま未塗装の穴になる。したがってこのファイルだけは
 * 「面として存在しない退化パート」だけを落とす閾値
 * （MIN_BASE_FILL_PART_AREA_M2 = 1 m²・平均幅の下限なし）で見る。
 * 細片の始末は build-fief-dedupe.ts の mergeThinBaseFillParts が
 * 「隣接勢力へ併合 or 元の勢力に残す」で済ませている。
 */
function thresholdsFor(name: string): Thresholds {
  return BASE_FILL_PATTERN.test(name)
    ? {
      minPartAreaM2: MIN_BASE_FILL_PART_AREA_M2,
      minHoleAreaM2: MIN_HOLE_AREA_M2,
      minPartMeanWidthM: 0,
    }
    : {
      minPartAreaM2: MIN_PART_AREA_M2,
      minHoleAreaM2: MIN_HOLE_AREA_M2,
      minPartMeanWidthM: MIN_PART_MEAN_WIDTH_M,
    };
}

/** data/ の全 GeoJSON を列挙する（クリーンアップ対象外の生成物を除く） */
async function dataGeoJsonFiles(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir("data")) {
    if (!entry.isFile || !entry.name.endsWith(".geojson")) continue;
    if (CLEANUP_EXEMPT_PATTERN.test(entry.name)) continue;
    names.push(entry.name);
  }
  return names.sort();
}

async function readCollection(name: string): Promise<FeatureCollection> {
  return JSON.parse(
    await Deno.readTextFile(`data/${name}`),
  ) as FeatureCollection;
}

Deno.test("生成物の全ポリゴンに自己交差が無い（全年代）", async () => {
  const offenders: string[] = [];
  for (const name of await dataGeoJsonFiles()) {
    const fc = await readCollection(name);
    for (const f of fc.features) {
      const geometry = f.geometry;
      if (
        geometry === null ||
        (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")
      ) {
        continue;
      }
      for (const point of selfIntersectionPoints(geometry)) {
        offenders.push(
          `${name} ${String(f.properties?.NAME)} @ ${point.join(",")}`,
        );
      }
    }
  }
  assertEquals(offenders, []);
});

Deno.test("生成物にクリーンアップ閾値未満のパート・穴が無い（全年代）", async () => {
  const offenders: string[] = [];
  for (const name of await dataGeoJsonFiles()) {
    const { minPartAreaM2, minHoleAreaM2 } = thresholdsFor(name);
    const fc = await readCollection(name);
    for (const f of fc.features) {
      const geometry = f.geometry;
      if (
        geometry === null ||
        (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")
      ) {
        continue;
      }
      for (const part of polygonParts(geometry)) {
        const outer = ringAreaM2(part[0]);
        if (outer < minPartAreaM2) {
          offenders.push(
            `${name} ${String(f.properties?.NAME)} part ${outer.toFixed(0)} m²`,
          );
        }
        for (const hole of part.slice(1)) {
          const holeArea = ringAreaM2(hole);
          if (holeArea < minHoleAreaM2) {
            offenders.push(
              `${name} ${String(f.properties?.NAME)} hole ${
                holeArea.toFixed(0)
              } m²`,
            );
          }
        }
      }
    }
  }
  assertEquals(offenders, []);
});

Deno.test("生成物はクリーンアップの不動点（再適用しても変化しない）", async () => {
  for (const name of await dataGeoJsonFiles()) {
    const { minPartAreaM2, minHoleAreaM2, minPartMeanWidthM } = thresholdsFor(
      name,
    );
    const fc = await readCollection(name);
    const { fc: cleaned, stats } = cleanFeatureCollection(
      fc,
      DEFAULT_COORD_PRECISION,
      minPartAreaM2,
      minHoleAreaM2,
      minPartMeanWidthM,
    );
    // 巨大な文字列を assertEquals に渡すと差分生成でメモリを食い潰すため、
    // 一致判定は assert で行い、失敗時は stats だけを報告する
    assert(
      JSON.stringify(cleaned.features) === JSON.stringify(fc.features),
      `${name} がクリーンアップで変化しました: ${JSON.stringify(stats)}`,
    );
  }
});

Deno.test("閾値は County of Bar の史実の飛び地を削らない", async () => {
  for (const year of FRANCE_FIEF_YEARS) {
    const fc = await readCollection(`france_fiefs_${year}.geojson`);
    const bar = fc.features.find((f) => f.properties?.NAME === "County of Bar");
    if (bar === undefined) continue;
    const geometry = bar.geometry as Polygon | MultiPolygon;
    const parts = polygonParts(geometry);
    const result = cleanGeometry(geometry);
    assert(result.geometry !== null);
    assertEquals(
      result.droppedParts,
      0,
      `${year} の County of Bar の飛び地が削られました`,
    );
    assertEquals(result.droppedHoles, 0);
    assertEquals(polygonParts(result.geometry).length, parts.length);
  }
});

Deno.test("生成物は年代ごとのサイズ上限に収まる", async () => {
  const limits: Array<[string, number]> = [
    ...YEARS.map((y): [string, number] => [
      `europe_${y}.geojson`,
      SIZE_LIMIT_BYTES,
    ]),
    ...FRANCE_FIEF_YEARS.map((y): [string, number] => [
      `france_fiefs_${y}.geojson`,
      FIEF_SIZE_LIMIT_BYTES,
    ]),
    ...FRANCE_FIEF_YEARS.map((y): [string, number] => [
      `france_fiefs_flat_${y}.geojson`,
      FIEF_SIZE_LIMIT_BYTES,
    ]),
    ...HRE_OVERLAY_YEARS.map((y): [string, number] => [
      `hre_${y}.geojson`,
      HRE_SIZE_LIMIT_BYTES,
    ]),
    // TASK-95: 中世イタリアの諸侯領・都市共和国オーバーレイ
    ...ITALY_FIEF_YEARS.map((y): [string, number] => [
      `italy_fiefs_${y}.geojson`,
      ITALY_FIEF_SIZE_LIMIT_BYTES,
    ]),
    // TASK-151: ブリテン諸島の政体オーバーレイ（raw / flat）
    ...BRITAIN_FIEF_YEARS.map((y): [string, number] => [
      `britain_fiefs_${y}.geojson`,
      BRITAIN_FIEF_SIZE_LIMIT_BYTES,
    ]),
    ...BRITAIN_FIEF_YEARS.map((y): [string, number] => [
      `britain_fiefs_flat_${y}.geojson`,
      BRITAIN_FIEF_SIZE_LIMIT_BYTES,
    ]),
    // TASK-92: 諸侯領 union を差し引いた派生 base。境界が諸侯領の輪郭に沿う分
    // 元の europe_<year> より頂点が増えるため、穴の縁の余白を持つ独立の上限
    // （build-fief-dedupe.ts BASE_FILL_SIZE_LIMIT_BYTES）で見張る。#190 で
    // 1783 年にジェノヴァ共和国の穴が開き base 上限（300 KB）を 0.3% 超えた
    ...BASE_OUTLINE_YEARS.map((y): [string, number] => [
      `europe_flat_${y}.geojson`,
      BASE_FILL_SIZE_LIMIT_BYTES,
    ]),
  ];
  for (const [name, limit] of limits) {
    const { size } = await Deno.stat(`data/${name}`);
    assert(size <= limit, `data/${name} が ${size} バイトで上限 ${limit} 超過`);
  }
});

// ---------------------------------------------------------------------------
// TASK-92: 1 点で接するリング同士の分離（difference が作る接触の修復）
// ---------------------------------------------------------------------------

/** 外環の頂点 (0,5) に穴が 1 点で接するポリゴン（difference が作る形と同型） */
function ringTouchingShell(): Polygon {
  return poly([
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 5], [0, 0]],
    [[0, 5], [3, 3], [3, 7], [0, 5]],
  ]);
}

Deno.test("separateTouchingRings は 1 点で接する穴を引き離して自己交差を消す（TASK-92）", () => {
  const geometry = ringTouchingShell();
  assert(selfIntersectionPoints(geometry).length > 0);
  const repaired = separateTouchingRings(geometry);
  assert(repaired !== null);
  assertEquals(selfIntersectionPoints(repaired).length, 0);
  // 外環は 1 頂点も動かさない（動かすのは面積が小さい側 = 穴）
  assertEquals(polygonParts(repaired)[0][0], polygonParts(geometry)[0][0]);
  // 穴の形の変化は頂点 1 つを数グリッド（10^-DEFAULT_COORD_PRECISION 度）
  // 動かした分だけ。許容幅はグリッド刻みに比例させ、桁数変更に追従させる
  const step = 10 ** -DEFAULT_COORD_PRECISION;
  const before = area(turfPolygon([polygonParts(geometry)[0][1]]));
  const after = area(turfPolygon([polygonParts(repaired)[0][1]]));
  assert(
    Math.abs(after - before) / before < step,
    `穴の面積が ${before} から ${after} へ変わりすぎ`,
  );
});

Deno.test("separateTouchingRings は接触点が頂点でない交差を修復できず null を返す（TASK-92）", () => {
  assertEquals(separateTouchingRings(poly([BOWTIE])), null);
});

Deno.test("separateTouchingRings は入力を変更しない（純粋関数。TASK-92）", () => {
  const geometry = ringTouchingShell();
  const snapshot = JSON.stringify(geometry);
  separateTouchingRings(geometry);
  assertEquals(JSON.stringify(geometry), snapshot);
});

Deno.test("cleanGeometry は 1 点で接する穴を分離し unresolved にしない（TASK-92）", () => {
  const result = cleanGeometry(ringTouchingShell());
  assert(result.geometry !== null);
  assertEquals(selfIntersectionPoints(result.geometry).length, 0);
  assertEquals(result.unresolved, false);
});
