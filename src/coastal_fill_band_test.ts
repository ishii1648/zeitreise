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
 *
 * #389 で「帯自身が持つ折り返しの穴」の検査を足した（末尾 2 件）。#312 が
 * 固定したのは「帯が届く範囲」と「帯が乗ってはいけない面」だけで、帯の内側に
 * 空いた穴（片側オフセットの折り返しでできるポケット）は素通りしていた。
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
import { pointKey, ringsOf } from "./coastal_segments.ts";
import { SNAPSHOT_YEARS } from "./config.ts";
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

/**
 * クロニアン砂州（Curonian Spit）上で、#389 以前の帯に空いていたポケット
 * （折り返しの穴）の内部に取った点。いずれも
 * - 1815 年の政治ポリゴンの外（＝帯が覆うべき「現代の陸だが政治ポリゴン外」）
 * - Issue #389 が挙げた bbox `[20.754,55.101,20.794,55.149]` の内側
 * で、修正前は帯の穴に落ちて未着色だった（実測: 砂州側の環 62.2 km² のうち
 * 現代の陸 2.08 km²）。ここが塗られないと、勢力圏の外枠がその穴を内環として
 * 引き継ぎ、z7 で約 22px の孤立した臙脂線として見える（#358 の症状）。
 *
 * 事前生成データ（配信するファイルそのもの）に対して見るのは、画面に出るのが
 * この丸め後の幾何だからで、実行時生成との等価性は
 * coastal_fill_prebuilt_test.ts が別に固定している。
 */
const CURONIAN_SPIT_PROBES: Position[] = [
  [20.760, 55.110],
  [20.774, 55.125],
  [20.784, 55.140],
  [20.790, 55.145],
];

Deno.test("帯はクロニアン砂州上の未着色域を穴なしで覆う（#389 AC1）", async () => {
  const bands = JSON.parse(
    await Deno.readTextFile("data/coastal_fill_1815.geojson"),
  ) as FeatureCollection<MultiPolygon>;
  const uncovered = CURONIAN_SPIT_PROBES.filter((point) =>
    !bands.features.some((band) => booleanPointInPolygon(point, band))
  );
  assertEquals(
    uncovered.map((point) => point.join(",")),
    [],
    "クロニアン砂州上の点が帯の穴（折り返しポケット）に落ちている",
  );
});

/**
 * 「折り返しの穴」と見なす内環の最小の平均半幅（m。面積 ÷ 周長）。
 *
 * polyclip の交点座標はサブメートルずれるため、帯どうしの union や差分では
 * 平均半幅 1m 未満の糸くず環が常に少数残る（suzerain_extent.ts の
 * SLIVER_HALF_WIDTH_M = 5m と同じ性質）。500m はその桁から 2 桁以上離れており、
 * かつ #389 が問題にした実寸の穴（クロニアン砂州側 1,096m・潟の北側 2,508m）を
 * 確実に捕まえる。
 */
const FOLD_POCKET_MIN_HALF_WIDTH_M = 500;

/** 環の平均半幅（m）。細長い糸くず環ではこの値が座標丸めの桁に落ちる */
function ringHalfWidthMeters(ring: readonly Position[]): number {
  const latMean = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
  const scale = Math.cos((latMean * Math.PI) / 180);
  let twiceArea = 0;
  let perimeter = 0;
  for (let i = 1; i < ring.length; i++) {
    const x0 = ring[i - 1][0] * scale * 111_320;
    const y0 = ring[i - 1][1] * 110_574;
    const x1 = ring[i][0] * scale * 111_320;
    const y1 = ring[i][1] * 110_574;
    twiceArea += x0 * y1 - x1 * y0;
    perimeter += Math.hypot(x1 - x0, y1 - y0);
  }
  if (perimeter === 0) return 0;
  return Math.abs(twiceArea / 2) / perimeter;
}

/**
 * 全 19 年代の配信データについて、帯が「折り返し由来の穴」を持たないことを
 * 固定する（#389 AC3）。
 *
 * 判定は実装（coastal_fill.ts の折り返しポケット除去）と同じ定義を使う:
 * **年代 GeoJSON の頂点を 1 つも含まない内環**は、オフセット点だけで囲まれた
 * ポケット＝片側バッファの折り返しの産物である。逆に、島（閉じた run）の
 * ドーナツ穴やデータ側の穴は元の政治ポリゴンの頂点そのものを含むので、この
 * 検査では拾わない（拾って埋めると島の内部を塗り潰す #312 の回帰になる）。
 *
 * 起票時点の実測は 19 年合計 809 環（1000 年 46 環 〜 1880 年 56 環）。
 */
Deno.test("帯に折り返し由来の穴（base の頂点を含まない内環）が無い（#389 AC3）", async () => {
  const offenders: string[] = [];
  for (const year of SNAPSHOT_YEARS) {
    const base = JSON.parse(
      await Deno.readTextFile(`data/europe_${year}.geojson`),
    ) as FeatureCollection;
    const bands = JSON.parse(
      await Deno.readTextFile(`data/coastal_fill_${year}.geojson`),
    ) as FeatureCollection<MultiPolygon>;
    const baseKeys = new Set<string>();
    for (const feature of base.features) {
      for (const ring of ringsOf(feature.geometry)) {
        for (const position of ring) baseKeys.add(pointKey(position));
      }
    }
    let count = 0;
    for (const band of bands.features) {
      for (const polygon of band.geometry.coordinates) {
        for (const hole of polygon.slice(1)) {
          if (hole.some((position) => baseKeys.has(pointKey(position)))) {
            continue;
          }
          if (ringHalfWidthMeters(hole) >= FOLD_POCKET_MIN_HALF_WIDTH_M) {
            count++;
          }
        }
      }
    }
    if (count > 0) offenders.push(`${year}: ${count} 環`);
  }
  assertEquals(
    offenders,
    [],
    `平均半幅 ${FOLD_POCKET_MIN_HALF_WIDTH_M}m 以上の折り返しポケットが帯に` +
      `残っている（deno task build-coastal-fill での再生成漏れも疑う）`,
  );
});

/**
 * #389 で帯の面が増えた区間について、#313 の不変条件（帯は政治ポリゴンの内側を
 * 覆わない）を**配信データそのもの**で確かめる。上の #312 AC6 は 1900 年・
 * 0.5° 格子・実行時生成に対する検査なので、面が増えた東プロイセン沖について
 * 1815 年を 0.02°（≈ 1.3〜2.2 km）の細かい格子で見る。
 *
 * なお #389 の実装が折り返しポケットを埋めるのを**差分の前**に置いているのは、
 * 差分の後に埋めるとポケット内部の別勢力ポリゴンの上へ帯が乗るため（詳細は
 * coastal_fill.ts の JSDoc）。現行データにはポケットと政治ポリゴンが重なる例が
 * 無い（19 年代全ての折り返しポケットについて実測 0 件）ので、順序の誤りを
 * データで見分けることはできない。ここで固定できるのは「増えた面が既存の塗りへ
 * 侵入していないこと」までである。
 */
Deno.test("埋めた折り返しポケットが他勢力のポリゴンへ乗らない（1815 年・配信データ・#389 / #313）", async () => {
  const base = JSON.parse(
    await Deno.readTextFile("data/europe_1815.geojson"),
  ) as FeatureCollection;
  const bands = JSON.parse(
    await Deno.readTextFile("data/coastal_fill_1815.geojson"),
  ) as FeatureCollection<MultiPolygon>;
  const land = base.features.filter(
    (feature): feature is Feature<Polygon | MultiPolygon> =>
      feature.geometry !== null &&
      (feature.geometry.type === "Polygon" ||
        feature.geometry.type === "MultiPolygon"),
  );
  const violations: string[] = [];
  for (let lon = 20.4; lon <= 21.4; lon += 0.02) {
    for (let lat = 54.9; lat <= 55.7; lat += 0.02) {
      const point: Position = [lon, lat];
      if (!land.some((feature) => booleanPointInPolygon(point, feature))) {
        continue;
      }
      if (bands.features.some((band) => booleanPointInPolygon(point, band))) {
        violations.push(point.map((v) => v.toFixed(2)).join(","));
      }
    }
  }
  assertEquals(violations, [], "政治ポリゴンの内側が帯に覆われている");
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
