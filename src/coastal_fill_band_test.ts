/**
 * 沿岸補完の帯（ポリゴン差分バッファ）の回帰検査（Issue #312）。
 *
 * #305 の帯は「run（LineString）＋ MapLibre line-offset」で描いていたため、
 * (1) 帯幅が地上 ≈ 7.6 km 固定で大河口・低地の大きな乖離に届かず、
 * (2) 凹部では offset 線が自己交差して自色が二重に乗る、
 * という 2 つの残差があった。#312 は帯を **ジオメトリ上のポリゴン**
 * （沿岸 run の外側バッファ − 全政治ポリゴン）として作り直す。ここでは
 * その 2 点を**ジオメトリ被覆率**で機械的に固定する。
 *
 * 画素分類（レンダリング結果の色判定）を使わないのは、#305 の検証で「淡い
 * 国色（当時のオランダ `#dad8c8` / ノルウェー `#cfc8da`）が earth `#f0e6cd` と
 * 判別できない」限界が判明しているため。ジオメトリ被覆率は色に依存せず、
 * ズームにも依存しない。
 *
 * なお #385 でパレットに earth とのコントラスト制約が入り、この 2 国も含めて
 * 全キーが ΔE00 >= 10 を満たすようになったが、画素分類はズーム・アンチ
 * エイリアス・重なり順にも左右されるため、検査方式はジオメトリ被覆率のまま
 * とする（色が判別できることは scripts/build-colors_test.ts が担保する）。
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
import { buildCoastalFillData, COASTAL_FILL_BAND_KM } from "./coastal_fill.ts";
import { EMPTY_SUZERAIN_OVERRIDES } from "./suzerain_extent.ts";

/**
 * Holderness 〜 The Wash 〜 北 Norfolk（`?year=1900&zoom=5.0&center=-1.5,53.5`）で
 * 「現代の陸でありながら 1900 年の政治ポリゴンに覆われていない」実測点と、
 * その点から政治ポリゴン境界までの実測距離（km）。
 *
 * 出典・計測方法: Natural Earth 10m physical `ne_10m_land`（public domain）と
 * `data/europe_1900.geojson` を 0.005°（≈ 350〜550 m）でラスタ化し、
 * 「land かつ ¬political」画素の政治ポリゴン境界までの距離を測った
 * （区間内の最大 25.0 km / p99 21.7 km）。同じ計測をベースマップ
 * （`tiles.zeitreises.com/europe.pmtiles` の earth レイヤー z8）に対して
 * 行っても最大 25.3 km で一致するため、Natural Earth を代表値として使う。
 * #305 の帯（地上 ≈ 7.6 km）はこのうち大半の点に届かない。
 */
const UNCOVERED_LAND_PROBES: { point: Position; gapKm: number }[] = [
  { point: [0.1075, 53.6625], gapKm: 25.0 }, // Holderness / Spurn
  { point: [-0.0025, 53.6475], gapKm: 18.7 }, // Humber 北岸
  { point: [-0.0775, 54.1125], gapKm: 16.8 }, // Bridlington 南
  { point: [0.0075, 53.7525], gapKm: 16.7 }, // Holderness 中部
  { point: [-0.0025, 53.7525], gapKm: 16.1 }, // Holderness 中部
  { point: [1.6625, 52.7625], gapKm: 11.8 }, // 北 Norfolk / Happisburgh 沖
  { point: [-0.2675, 54.1975], gapKm: 11.8 }, // Bridlington 湾
  { point: [0.5675, 52.9675], gapKm: 11.0 }, // The Wash 西岸
  { point: [1.2775, 52.9275], gapKm: 10.2 }, // 北 Norfolk 海岸
  { point: [0.2075, 52.8275], gapKm: 9.3 }, // The Wash 南
];

/**
 * 帯が届いてはいけない参照点（沖合）。帯幅を無制限に広げる「対処」を
 * 回帰検査が素通りさせないための上限側の固定。いずれも政治ポリゴン境界から
 * COASTAL_FILL_BAND_KM の 2 倍以上離れた北海の海上。
 */
const OFFSHORE_PROBES: Position[] = [
  [1.5, 54.0], // Holderness 沖 ≈ 90 km
  [2.0, 53.2], // The Wash 沖 ≈ 110 km
];

/**
 * AC6（内陸境界・湖・内水面・穴の二重塗り）を代表する確認地点。
 * いずれも「政治ポリゴンの内側」で、帯が 1px でも掛かってはいけない。
 */
const INLAND_PROBES: { point: Position; label: string }[] = [
  { point: [6.30, 46.35], label: "レマン湖南岸（仏側）" },
  { point: [6.45, 46.52], label: "レマン湖北岸（スイス側）" },
  { point: [9.30, 47.60], label: "ボーデン湖南岸" },
  { point: [9.40, 47.68], label: "ボーデン湖北岸" },
  { point: [0.60, 51.45], label: "テムズ河口北岸" },
  { point: [0.60, 51.40], label: "テムズ河口南岸" },
];

function bandPolygons(
  data: FeatureCollection,
): Feature<Polygon | MultiPolygon>[] {
  return data.features.filter(
    (feature): feature is Feature<Polygon | MultiPolygon> =>
      feature.geometry !== null &&
      (feature.geometry.type === "Polygon" ||
        feature.geometry.type === "MultiPolygon"),
  );
}

function coveredBy(
  bands: Feature<Polygon | MultiPolygon>[],
  point: Position,
): Feature<Polygon | MultiPolygon> | null {
  for (const band of bands) {
    if (booleanPointInPolygon(point, band)) return band;
  }
  return null;
}

async function coastalFillOf(year: number): Promise<FeatureCollection> {
  const base = JSON.parse(
    await Deno.readTextFile(`data/europe_${year}.geojson`),
  ) as FeatureCollection;
  const colors = JSON.parse(
    await Deno.readTextFile("data/colors.json"),
  ) as Record<string, string>;
  return buildCoastalFillData(base, colors, EMPTY_SUZERAIN_OVERRIDES);
}

Deno.test("帯は Holderness〜The Wash〜北 Norfolk の未着色域を面として覆う（#312 AC1）", async () => {
  const bands = bandPolygons(await coastalFillOf(1900));
  assert(bands.length > 0, "帯ポリゴンが 1 つも生成されていない");
  const uncovered = UNCOVERED_LAND_PROBES.filter(
    ({ point }) => coveredBy(bands, point) === null,
  );
  assertEquals(
    uncovered.map(({ point, gapKm }) => `${point.join(",")}(${gapKm}km)`),
    [],
    "実測ギャップ地点が帯に覆われていない",
  );
});

Deno.test("帯は沖合へ無制限には広がらない（帯幅の単純拡大への歯止め・#312 AC4）", async () => {
  const bands = bandPolygons(await coastalFillOf(1900));
  for (const point of OFFSHORE_PROBES) {
    assertEquals(
      coveredBy(bands, point) === null,
      true,
      `沖合 ${point.join(",")} まで帯が伸びている`,
    );
  }
});

Deno.test("帯は政治ポリゴンの内側を覆わない（湖岸・河口・内陸境界の二重塗り防止・#312 AC6）", async () => {
  const base = JSON.parse(
    await Deno.readTextFile("data/europe_1900.geojson"),
  ) as FeatureCollection;
  const colors = JSON.parse(
    await Deno.readTextFile("data/colors.json"),
  ) as Record<string, string>;
  const bands = bandPolygons(
    buildCoastalFillData(base, colors, EMPTY_SUZERAIN_OVERRIDES),
  );
  const land = base.features.filter(
    (feature): feature is Feature<Polygon | MultiPolygon> =>
      feature.geometry !== null &&
      (feature.geometry.type === "Polygon" ||
        feature.geometry.type === "MultiPolygon"),
  );

  // 1. AC6 の代表地点（レマン湖・ボーデン湖・テムズ河口）
  for (const { point, label } of INLAND_PROBES) {
    if (!land.some((feature) => booleanPointInPolygon(point, feature))) {
      continue;
    }
    assertEquals(
      coveredBy(bands, point) === null,
      true,
      `${label} が帯に二重塗りされている`,
    );
  }

  // 2. ヨーロッパ全域の格子サンプル: 政治ポリゴンの内側の点は 1 つも帯に
  //    覆われない（ポリゴン差分の不変条件）
  const violations: string[] = [];
  for (let lon = -10; lon <= 30; lon += 0.5) {
    for (let lat = 36; lat <= 62; lat += 0.5) {
      const point: Position = [lon + 0.13, lat + 0.17];
      if (!land.some((feature) => booleanPointInPolygon(point, feature))) {
        continue;
      }
      if (coveredBy(bands, point) !== null) violations.push(point.join(","));
    }
  }
  assertEquals(violations, [], "政治ポリゴン内側が帯に覆われている");
});

Deno.test("COASTAL_FILL_BAND_KM は実測ギャップ（最大 25.3km）を覆い、かつ過大でない", () => {
  assert(
    COASTAL_FILL_BAND_KM >= 26,
    "実測最大ギャップ 25.3km を覆えない帯幅",
  );
  assert(
    COASTAL_FILL_BAND_KM <= 40,
    "ドーバー海峡（≈33km）を越えて対岸へ届く帯幅",
  );
});
