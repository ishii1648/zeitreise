import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import type { Feature, FeatureCollection, LineString, Position } from "geojson";
import {
  APPROXIMATE_BORDER_CASING_INK,
  APPROXIMATE_BORDER_CASING_LAYER_IDS,
  APPROXIMATE_BORDER_INK,
  APPROXIMATE_BORDER_LAYER_IDS,
  APPROXIMATE_BORDER_SOURCE_ID,
  approximateBorderCasingLayerId,
  approximateBorderCasingSpecs,
  approximateBorderColor,
  approximateBorderLayerId,
  approximateBorderLayerSpecs,
  approximateBorderSourceSpec,
  buildApproximateBorderData,
  CASING_STYLES,
  CASING_TIERS,
  crossTrackDeviationKm,
  effectiveSegmentLengthsKm,
  EMPTY_APPROXIMATE_BORDER_DATA,
  initialBearingDeg,
  LONG_SEGMENT_KM,
  MAX_SEGMENT_KM_PROPERTY,
  segmentLengthKm,
  STRAIGHT_RUN_MAX_DEVIATION_RATIO,
  STRAIGHT_RUN_MAX_TURN_DEG,
  STRAIGHT_RUN_MIN_DEVIATION_KM,
  straightRunLengthsKm,
  TIER_PROPERTY,
  TIER_STYLES,
  turnAngleDeg,
  UNCERTAINTY_TIERS,
  uncertaintyTier,
  VERY_LONG_SEGMENT_KM,
  ZOOM_SCALE,
} from "./approximate_borders.ts";
import { LINE_COLOR } from "./powers.ts";
import { LABEL_OUTLINE_COLOR } from "./labels.ts";
import { BASE_OUTLINE_YEARS, MAX_ZOOM, MIN_ZOOM } from "./config.ts";

// TASK-80: 元データ（historical-basemaps）は全 feature が BORDERPRECISION=1
// = 「この年代の全境界は概略」と宣言している。1px くっきり線は精密測量の
// 誤ったメッセージを出すため、境界線を「概略境界」として描く（にじみ・低 alpha）。
// セグメント長で不確かさを段階化し、長い区間ほど強く和らげる。

/** 実データ（TASK-78 の派生 base 輪郭）。1200 年 = ユーザー指摘の年代 */
const outline1200 = JSON.parse(
  Deno.readTextFileSync(
    new URL("../data/base_outline_1200.geojson", import.meta.url),
  ),
) as FeatureCollection;

/** 素の base 勢力ポリゴン（諸侯領オーバーレイの無い年の入力形） */
const europe1400 = JSON.parse(
  Deno.readTextFileSync(
    new URL("../data/europe_1400.geojson", import.meta.url),
  ),
) as FeatureCollection;

function lineFeature(coordinates: Position[]): Feature<LineString> {
  return {
    type: "Feature",
    properties: { NAME: "Test" },
    geometry: { type: "LineString", coordinates },
  };
}

function fcOf(features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

/**
 * 沿岸判定を無効にする base（#357）。ポリゴンを 1 つも持たないので沿岸
 * セグメントの索引が空になり、入力の全環がそのまま線になる。
 *
 * ジオメトリ → 線の変換規則（環を閉じた線として扱う・MultiPolygon の穴も
 * 含める）だけを見たいテストで使う。沿岸を落とす契約そのものは
 * approximate_borders_coastal_test.ts が検証する。
 */
const NO_COASTAL_BASE: FeatureCollection = fcOf([]);

function tierOf(feature: Feature): string {
  return String(feature.properties?.[TIER_PROPERTY]);
}

// --- セグメント長（不確かさの一次指標）---

Deno.test("segmentLengthKm は既知の大円距離を再現する", () => {
  // 緯度 1 度 ≒ 111.19 km（scripts/audit-rivers.ts haversineKm と同じ球面近似）
  assertAlmostEquals(segmentLengthKm([0, 0], [0, 1]), 111.19, 0.05);
  assertEquals(segmentLengthKm([10, 50], [10, 50]), 0);
  // 経度 1 度は緯度 60 度で半分になる
  assertAlmostEquals(
    segmentLengthKm([0, 60], [1, 60]) / segmentLengthKm([0, 0], [1, 0]),
    0.5,
    0.01,
  );
});

Deno.test("segmentLengthKm はユーザー指摘の超長直線の実測長を再現する（TASK-80）", () => {
  // 指摘 1: Kingdom of France ↔ Angevin Empire の 277 km（europe_1200 の生データ）
  assertAlmostEquals(
    segmentLengthKm([0.53482, 48.00995], [1.15139, 45.55267]),
    277,
    2,
  );
  // 指摘 2: Comté de Toulouse 北縁の 141 km（諸侯領 union で切った後は 128 km）
  assertAlmostEquals(
    segmentLengthKm([0.86513, 44.55714], [2.62675, 44.77639]),
    141,
    2,
  );
  assertAlmostEquals(
    segmentLengthKm([1.02662, 44.57724], [2.62675, 44.77639]),
    128,
    2,
  );
});

// --- 不確かさの段階（AC #2 / AC #5）---

Deno.test("閾値は実測分布に基づく 50 km / 100 km（TASK-80 AC #5）", () => {
  // base_outline_1200 の実測: 中央値 15.8 km・p90 53.8 km・p99 291 km。
  // 50 km ≒ p90（全長の 52% を占める上位 11% の区間）、100 km ≒ p95
  // （同 40% を占める上位 5%）で、ユーザー指摘の直線は全て 100 km 以上。
  assertEquals(LONG_SEGMENT_KM, 50);
  assertEquals(VERY_LONG_SEGMENT_KM, 100);
  assert(LONG_SEGMENT_KM < VERY_LONG_SEGMENT_KM);
});

Deno.test("uncertaintyTier は閾値で 3 段に分ける（境界は上側の段に含める）", () => {
  assertEquals(uncertaintyTier(0), "normal");
  assertEquals(uncertaintyTier(15.8), "normal");
  assertEquals(uncertaintyTier(LONG_SEGMENT_KM - 0.001), "normal");
  assertEquals(uncertaintyTier(LONG_SEGMENT_KM), "long");
  assertEquals(uncertaintyTier(VERY_LONG_SEGMENT_KM - 0.001), "long");
  assertEquals(uncertaintyTier(VERY_LONG_SEGMENT_KM), "very-long");
  assertEquals(uncertaintyTier(277), "very-long");
});

Deno.test("ユーザー指摘の直線はいずれも最も強く和らげる段になる（TASK-80 AC #3）", () => {
  for (
    const [a, b] of [
      // 仏王国 ↔ アンジュー帝国 277 km（諸侯領オーバーレイの無い年の base）
      [[0.53482, 48.00995], [1.15139, 45.55267]],
      // トゥールーズ伯領 北縁 141 km / 切り出し後 128 km
      [[0.86513, 44.55714], [2.62675, 44.77639]],
      [[1.02662, 44.57724], [2.62675, 44.77639]],
      // Burgandy ↔ Holy Roman Empire 150 km
      [[8.41115, 47.46217], [8.49267, 46.11709]],
      // León ↔ Castile 294 km（1000〜1200 年の base に共通）
      [[-5.0864, 43.49486], [-4.44432, 40.89431]],
    ] as [Position, Position][]
  ) {
    assertEquals(
      uncertaintyTier(segmentLengthKm(a, b)),
      "very-long",
      `${JSON.stringify(a)}→${JSON.stringify(b)} が最強段になっていない`,
    );
  }
});

// --- 直線 run の検出（#309 AC3 / AC4）---
// 個々のセグメントが 50 km 未満でも、ほぼ同一直線上に連続すれば地図上では
// 「定規で引いた 1 本の線」に見える。方位差・基準線からの偏差・累積長で
// 「ほぼ直線の連続区間」を検出し、run 全体を同じ段へ揃える。

/**
 * 起点から「初期方位・距離」を順に辿る折れ線を作る（テスト専用）。
 * 球面上の destination point 公式を使う（実装の initialBearingDeg /
 * segmentLengthKm と同じ球面モデル）ので、指定した方位・長さがそのまま
 * 実装側の測定値になり、閾値ちょうどの境界値をテストできる。
 */
function polyline(
  start: Position,
  steps: readonly { km: number; bearingDeg: number }[],
): Position[] {
  const R = 6371.0088;
  const rad = Math.PI / 180;
  const out: Position[] = [start];
  for (const { km, bearingDeg } of steps) {
    const [lon, lat] = out[out.length - 1];
    const d = km / R;
    const theta = bearingDeg * rad;
    const lat1 = lat * rad;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(d) +
        Math.cos(lat1) * Math.sin(d) * Math.cos(theta),
    );
    const lon2 = lon * rad +
      Math.atan2(
        Math.sin(theta) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
      );
    out.push([lon2 / rad, lat2 / rad]);
  }
  return out;
}

/** 同じ方位・同じ長さのセグメントを n 本つなげた直線 */
function straightLine(km: number, n: number, bearingDeg = 0): Position[] {
  return polyline(
    [10, 50],
    Array.from({ length: n }, () => ({ km, bearingDeg })),
  );
}

Deno.test("initialBearingDeg は真北 0°・真東 90° を返す（#309 AC3）", () => {
  assertAlmostEquals(initialBearingDeg([10, 50], [10, 51]), 0, 0.01);
  assertAlmostEquals(initialBearingDeg([10, 50], [11, 50]), 90, 0.5);
  assertAlmostEquals(initialBearingDeg([10, 50], [10, 49]), 180, 0.01);
  assertAlmostEquals(
    Math.abs(initialBearingDeg([10, 50], [9, 50])),
    90,
    0.5,
  );
});

Deno.test("turnAngleDeg は 0〜180 の絶対差で、0°/360° をまたいでも小さい方を返す", () => {
  assertAlmostEquals(turnAngleDeg(0, 5), 5, 1e-9);
  assertAlmostEquals(turnAngleDeg(350, 10), 20, 1e-9);
  assertAlmostEquals(turnAngleDeg(10, 350), 20, 1e-9);
  assertAlmostEquals(turnAngleDeg(-170, 170), 20, 1e-9);
  assertAlmostEquals(turnAngleDeg(0, 180), 180, 1e-9);
  assertEquals(turnAngleDeg(90, 90), 0);
});

Deno.test("crossTrackDeviationKm は基準線からの垂線距離（線上は 0）", () => {
  // 東西の基準線に対し、緯度 0.1 度ずれた点は約 11.1 km 離れる
  assertAlmostEquals(
    crossTrackDeviationKm([0, 50], [2, 50], [1, 50.1]),
    11.1,
    0.3,
  );
  // 基準線上（中点）はほぼ 0
  assert(crossTrackDeviationKm([0, 50], [2, 50], [1, 50]) < 0.1);
  // 端点も 0
  assert(crossTrackDeviationKm([0, 50], [2, 50], [0, 50]) < 1e-6);
});

Deno.test("直線 run の閾値は定数化されている（#309 AC4）", () => {
  // 根拠（全 19 年代の base_outline_<year>.geojson を実測。#309 の Notes）:
  // - 方位差 8°: 5° → 8° で昇格率が動き、8°/10°/12°/15° は同一結果（偏差条件が
  //   先に効くため飽和する）。「方位差が律速でなくなる最小値」を採る。
  // - 偏差 2%（基準線長に対する比）: 1% で昇格 0.8〜1.4%、2% で 1.3〜2.6%、
  //   3% で 2.6〜5.0%。100 km の弦に対する 2% = 2 km は z4〜z6 で 0.4〜1.4px
  //   ＝ インク線 1 本分未満で、画面上は直線と区別できない。3% は 1200 年の
  //   normal 比率を 86.5% まで落とすため過剰。
  // - 偏差の下限 1 km: 弦が短いと 2% が 1 km を割り、どのズームでも 1px 未満の
  //   揺れで run が切れてしまう。実測では 2 km 以上に上げると昇格率が 1.5 倍に
  //   跳ねる（1815 年 1.49% → 2.46%）ため 1 km に留める。
  assertEquals(STRAIGHT_RUN_MAX_TURN_DEG, 8);
  assertEquals(STRAIGHT_RUN_MAX_DEVIATION_RATIO, 0.02);
  assertEquals(STRAIGHT_RUN_MIN_DEVIATION_KM, 1);
});

Deno.test("straightRunLengthsKm は直線上の連続セグメントへ累積長を割り当てる（#309 AC3）", () => {
  const line = straightLine(40, 3);
  const lengths = straightRunLengthsKm(line);
  assertEquals(lengths.length, 3);
  for (const km of lengths) assertAlmostEquals(km, 120, 1);
  // 単独セグメントはその長さのまま
  assertAlmostEquals(straightRunLengthsKm(straightLine(40, 1))[0], 40, 1);
  // セグメントが無い（1 点・空）なら空
  assertEquals(straightRunLengthsKm([[10, 50]]), []);
  assertEquals(straightRunLengthsKm([]), []);
});

Deno.test("straightRunLengthsKm は方位差が閾値を超える折れ曲がりで run を切る（#309 AC4）", () => {
  // 直角に折れる: 前後は別の run
  const corner = polyline([10, 50], [
    { km: 40, bearingDeg: 0 },
    { km: 40, bearingDeg: 0 },
    { km: 40, bearingDeg: 90 },
    { km: 40, bearingDeg: 90 },
  ]);
  const lengths = straightRunLengthsKm(corner);
  assertAlmostEquals(lengths[0], 80, 1);
  assertAlmostEquals(lengths[1], 80, 1);
  assertAlmostEquals(lengths[2], 80, 1);
  assertAlmostEquals(lengths[3], 80, 1);
  // 方位差の境界値。長い区間の先に短いセグメントが付く形で見る: この形では
  // 折れの頂点は弦からほとんど離れないため（60 km + 3 km で 0.4 km 程度）、
  // 偏差条件は通り、方位差条件だけが run を切る側になる
  const kink = (turnDeg: number) =>
    straightRunLengthsKm(polyline([10, 50], [
      { km: 60, bearingDeg: 0 },
      { km: 3, bearingDeg: turnDeg },
    ]));
  // 閾値の直下は「直線」に含める
  assertAlmostEquals(kink(STRAIGHT_RUN_MAX_TURN_DEG - 0.01)[0], 63, 0.5);
  // 閾値をわずかに超えると切れる
  assertAlmostEquals(kink(STRAIGHT_RUN_MAX_TURN_DEG + 0.01)[0], 60, 0.5);
});

Deno.test("straightRunLengthsKm は 1 回ごとの方位差が小さくても偏差が積もれば run を切る（#309 AC4）", () => {
  // 5° ずつ 4 回曲がる緩い弧: 方位差はどこも閾値内だが、弦からの偏差が
  // 2% を超えるため全体は「直線」とは見なさない
  const arc = polyline(
    [10, 50],
    [0, 5, 10, 15].map((bearingDeg) => ({ km: 40, bearingDeg })),
  );
  const arcLengths = straightRunLengthsKm(arc);
  assert(
    arcLengths.every((km) => km < 160),
    `弧が 1 本の直線 run になっている: ${arcLengths.join(" / ")}`,
  );
  // 同じ本数・同じ長さでも完全な直線なら 1 本の run
  for (const km of straightRunLengthsKm(straightLine(40, 4))) {
    assertAlmostEquals(km, 160, 1);
  }
});

Deno.test("effectiveSegmentLengthsKm はセグメント長と直線 run 長の大きい方を返す", () => {
  // 短いセグメントの直線 run は run 長へ引き上げる
  const promoted = effectiveSegmentLengthsKm(straightLine(40, 3));
  for (const km of promoted) assertAlmostEquals(km, 120, 1);
  // 単独の超長セグメントは従来どおり自身の長さ（run 検出で弱まらない）
  const single = effectiveSegmentLengthsKm([[0.53482, 48.00995], [
    1.15139,
    45.55267,
  ]]);
  assertAlmostEquals(single[0], 277, 2);
});

Deno.test("buildApproximateBorderData は細切れの直線を 1 本の run として同じ段へ揃える（#309 AC3）", () => {
  // 40 km × 3 = 120 km: 個々は normal だが、直線 run としては very-long
  const data = buildApproximateBorderData(fcOf([
    lineFeature(straightLine(40, 3)),
  ]));
  assertEquals(data.features.length, 1);
  assertEquals(tierOf(data.features[0]), "very-long");
  assertEquals((data.features[0].geometry as LineString).coordinates.length, 4);
  // 30 km × 2 = 60 km: long へ揃う
  const mid = buildApproximateBorderData(fcOf([
    lineFeature(straightLine(30, 2)),
  ]));
  assertEquals(mid.features.map(tierOf), ["long"]);
  // 10 km × 3 = 30 km: 累積しても閾値未満なので normal のまま（過剰昇格しない）
  const short = buildApproximateBorderData(fcOf([
    lineFeature(straightLine(10, 3)),
  ]));
  assertEquals(short.features.map(tierOf), ["normal"]);
});

Deno.test("buildApproximateBorderData は折れ曲がりを挟む短いセグメント群を昇格させない（#309 AC4）", () => {
  // 40 km × 4 だが 1 本ごとに 90° 折れる（ジグザグ）: 直線ではないので normal
  const zigzag = polyline([10, 50], [
    { km: 40, bearingDeg: 0 },
    { km: 40, bearingDeg: 90 },
    { km: 40, bearingDeg: 0 },
    { km: 40, bearingDeg: 90 },
  ]);
  const data = buildApproximateBorderData(fcOf([lineFeature(zigzag)]));
  assertEquals(data.features.map(tierOf), ["normal"]);
});

Deno.test("段が進むほど alpha が下がり・太く・にじむ（AC #1 / AC #2）", () => {
  const styles = UNCERTAINTY_TIERS.map((tier) => TIER_STYLES[tier]);
  assertEquals(UNCERTAINTY_TIERS, ["normal", "long", "very-long"]);
  for (let i = 1; i < styles.length; i++) {
    assert(
      styles[i].alpha < styles[i - 1].alpha,
      `${UNCERTAINTY_TIERS[i]} の alpha が前段以上`,
    );
    assert(
      styles[i].widthPx > styles[i - 1].widthPx,
      `${UNCERTAINTY_TIERS[i]} の線幅が前段以下`,
    );
    assert(
      styles[i].blurPx > styles[i - 1].blurPx,
      `${UNCERTAINTY_TIERS[i]} のにじみが前段以下`,
    );
  }
  // AC #1: 最も確度が高い段でも従来の境界線（powers の stroke: alpha 190/255・
  // blur 0）より薄く、かつ全段でにじみが入る（精密線に見えない）
  assert(styles[0].alpha < LINE_COLOR[3] / 255);
  for (const style of styles) assert(style.blurPx > 0);
});

Deno.test("線色は境界線と同じインクで段ごとに alpha だけを変える", () => {
  const [r, g, b] = APPROXIMATE_BORDER_INK;
  // 従来の境界線（powers.ts LINE_COLOR）と同じ顔料（TASK-73/74 の褪せパレット）
  assertEquals([r, g, b], [LINE_COLOR[0], LINE_COLOR[1], LINE_COLOR[2]]);
  for (const tier of UNCERTAINTY_TIERS) {
    assertEquals(
      approximateBorderColor(tier),
      `rgba(${r}, ${g}, ${b}, ${TIER_STYLES[tier].alpha})`,
    );
  }
});

// --- 派生データ（セグメント長で切った tier 単位の LineString 群）---

Deno.test("buildApproximateBorderData は tier が変わる位置で線を分割する", () => {
  // 短い区間 2 本 → 超長 1 本 → 短い区間 1 本
  const data = buildApproximateBorderData(fcOf([
    lineFeature([
      [0, 45],
      [0.1, 45],
      [0.2, 45],
      [0.2, 48], // ≒ 333 km（very-long）
      [0.3, 48],
    ]),
  ]));
  assertEquals(data.features.map(tierOf), ["normal", "very-long", "normal"]);
  // 隣接する run は頂点を共有する（線が途切れない）
  const coords = data.features.map((f) =>
    (f.geometry as LineString).coordinates
  );
  assertEquals(coords[0], [[0, 45], [0.1, 45], [0.2, 45]]);
  assertEquals(coords[1], [[0.2, 45], [0.2, 48]]);
  assertEquals(coords[2], [[0.2, 48], [0.3, 48]]);
});

Deno.test("buildApproximateBorderData は run の最長セグメント長を属性に持つ", () => {
  const data = buildApproximateBorderData(fcOf([
    lineFeature([[0, 45], [0.1, 45], [0.2, 45]]),
  ]));
  assertEquals(data.features.length, 1);
  const maxKm = Number(data.features[0].properties?.[MAX_SEGMENT_KM_PROPERTY]);
  assertAlmostEquals(maxKm, segmentLengthKm([0, 45], [0.1, 45]), 0.01);
});

Deno.test("buildApproximateBorderData はポリゴンの環を閉じた線として扱う", () => {
  // 閉環（先頭 = 末尾）の Polygon。閉合セグメントまで含めて 4 セグメント
  const data = buildApproximateBorderData(
    fcOf([{
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [[[0, 45], [0.1, 45], [0.1, 45.1], [0, 45.1], [0, 45]]],
      },
    }]),
    NO_COASTAL_BASE,
  );
  assertEquals(data.features.length, 1);
  assertEquals(tierOf(data.features[0]), "normal");
  assertEquals(
    (data.features[0].geometry as LineString).coordinates.length,
    5,
  );
});

Deno.test("buildApproximateBorderData は MultiPolygon の全環と穴を含める", () => {
  const ring = (x: number): Position[] => [
    [x, 45],
    [x + 0.1, 45],
    [x + 0.1, 45.1],
    [x, 45],
  ];
  const data = buildApproximateBorderData(
    fcOf([{
      type: "Feature",
      properties: {},
      geometry: {
        type: "MultiPolygon",
        // 1 つ目のポリゴンは外環 + 穴、2 つ目は外環のみ
        coordinates: [[ring(0), ring(0.02)], [ring(1)]],
      },
    }]),
    NO_COASTAL_BASE,
  );
  assertEquals(data.features.length, 3);
});

Deno.test("buildApproximateBorderData は MultiLineString と混在 FC を扱える", () => {
  const data = buildApproximateBorderData(fcOf([
    lineFeature([[0, 45], [0.1, 45]]),
    {
      type: "Feature",
      properties: {},
      geometry: {
        type: "MultiLineString",
        coordinates: [[[1, 45], [1.1, 45]], [[2, 45], [2, 48]]],
      },
    },
    // 面・線以外（Point）は無視する
    {
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [3, 45] },
    },
  ]));
  assertEquals(data.features.map(tierOf), ["normal", "normal", "very-long"]);
});

Deno.test("buildApproximateBorderData は空 FC・退化ジオメトリで空を返す", () => {
  assertEquals(buildApproximateBorderData(fcOf([])).features, []);
  // 1 点しかない線・同一点の連続はセグメントが無いので落とす
  assertEquals(
    buildApproximateBorderData(fcOf([
      lineFeature([[0, 45]]),
      lineFeature([]),
    ])).features,
    [],
  );
  assertEquals(EMPTY_APPROXIMATE_BORDER_DATA.features, []);
  assertEquals(EMPTY_APPROXIMATE_BORDER_DATA.type, "FeatureCollection");
});

Deno.test("buildApproximateBorderData の出力は全 feature が有効な tier を持つ 2 点以上の線", () => {
  for (const source of [outline1200, europe1400]) {
    const data = buildApproximateBorderData(source);
    assert(data.features.length > 0);
    for (const feature of data.features) {
      assert(
        (UNCERTAINTY_TIERS as readonly string[]).includes(tierOf(feature)),
        `未知の tier: ${tierOf(feature)}`,
      );
      const coords = (feature.geometry as LineString).coordinates;
      assert(coords.length >= 2, "1 点しかない run が残っている");
      assertEquals(feature.geometry.type, "LineString");
    }
  }
});

Deno.test("実データ: 1200 年の指摘箇所が最強段の run に含まれる（AC #3）", () => {
  const data = buildApproximateBorderData(outline1200);
  // 南仏の 114.5 km 垂直線と Burgandy ↔ HRE（アルプス西部、111 km）
  //
  // TASK-86: Burgandy ↔ HRE の指摘箇所は元々 [8.41115,47.46217]〜[8.49267,46.11709]
  // の 150 km 直線だったが、中世 HRE 領邦オーバーレイの追加で北半分が
  // Duchy of Swabia の内側に入り、base 輪郭からは切り出されるようになった
  // （その区間の境界は領邦側の輪郭が描く。TASK-78 の二重輪郭解消と同じ扱い）。
  // 南側に残る 111 km の直線が同じ境界の同じ性質を代表するのでこちらを固定する。
  //
  // TASK-110: 1 本目は元々トゥールーズ伯領 北縁 [1.02662,44.57724]〜[2.62675,44.77639]
  // だったが、Cliopatria 由来の County of Toulouse オーバーレイ（1200 年 52,816 km²）の
  // 内側に入り base 輪郭から切り出された。TASK-86 と同型の帰結で、実測でも消えた区間の
  // 中点 (1.82668, 44.67682) が cliopatria_fiefs_flat_1200 の County of Toulouse に
  // 含まれることを確認済み。代わりに、新しい base_outline_1200 で最強段に残る南仏の
  // 最長直線（経度 5.34626 の完全な垂直線・114.5 km）を固定する。「概念上の直線 1 本で
  // 近似された境界」という同じ性質を代表する。
  // TASK-130: 座標は COORD_PRECISION = 3 桁へ丸めた生成物の値で固定する
  // （丸め前は [5.34626,44.06078]〜[5.34626,45.09594] と
  // [8.49267,46.11709]〜[7.51443,45.38341]。同じ頂点の丸め後の値）。
  const targets: [Position, Position][] = [
    [[5.346, 44.061], [5.346, 45.096]],
    [[8.493, 46.117], [7.514, 45.383]],
  ];
  for (const [a, b] of targets) {
    const runs = data.features.filter((feature) => {
      const coords = (feature.geometry as LineString).coordinates;
      return coords.some((p, i) => {
        const q = coords[i + 1];
        if (q === undefined) return false;
        const same = (u: Position, v: Position) =>
          u[0] === v[0] && u[1] === v[1];
        return (same(p, a) && same(q, b)) || (same(p, b) && same(q, a));
      });
    });
    assert(runs.length > 0, `${JSON.stringify(a)} の run が見つからない`);
    for (const run of runs) {
      assertEquals(
        tierOf(run),
        "very-long",
        `${JSON.stringify(a)} の run が最強段になっていない`,
      );
    }
  }
});

Deno.test("実データ: セグメント数では通常段が大半で、最強段は数 % に留まる（AC #1 の非退行）", () => {
  const data = buildApproximateBorderData(outline1200);
  const segments = (tier: string) =>
    data.features
      .filter((f) => tierOf(f) === tier)
      .reduce(
        (n, f) => n + (f.geometry as LineString).coordinates.length - 1,
        0,
      );
  const total = segments("normal") + segments("long") + segments("very-long");
  const detail = `normal ${segments("normal")} / long ${
    segments("long")
  } / very-long ${segments("very-long")} / total ${total}`;
  // 境界の「ほとんどの場所」は通常段のまま = 従来どおり境界として読める。
  // なお総延長で見ると 50 km 超が半分近くを占める（少数の超長直線が長さを
  // 稼ぐため）が、地図上で線として認識される箇所の数はセグメント数に比例する。
  assert(segments("normal") > total * 0.7, detail);
  assert(segments("very-long") < total * 0.15, detail);
  assert(
    segments("very-long") > 0,
    `最強段が 1 本も無い（閾値が高すぎる）: ${detail}`,
  );
});

Deno.test("実データ: 全 19 年代で直線 run 検出が成立し、年代固有の例外を要さない（#309 AC3/AC8）", () => {
  // 年代・勢力名の例外リストを作らない = 同じ閾値のまま全年代で
  // 「昇格が起きる」かつ「通常段が大半のまま」が成り立つこと
  for (const year of BASE_OUTLINE_YEARS) {
    const source = JSON.parse(
      Deno.readTextFileSync(
        new URL(`../data/base_outline_${year}.geojson`, import.meta.url),
      ),
    ) as FeatureCollection;
    const data = buildApproximateBorderData(source);
    assert(data.features.length > 0, `${year}: run が 1 本も無い`);
    let promoted = 0;
    let total = 0;
    const counts: Record<string, number> = {
      normal: 0,
      long: 0,
      "very-long": 0,
    };
    for (const feature of data.features) {
      const coords = (feature.geometry as LineString).coordinates;
      const tier = tierOf(feature);
      counts[tier] += coords.length - 1;
      total += coords.length - 1;
      for (let i = 1; i < coords.length; i++) {
        const own = uncertaintyTier(segmentLengthKm(coords[i - 1], coords[i]));
        if (own !== tier) promoted++;
      }
    }
    const detail =
      `${year}: normal ${counts.normal} / long ${counts.long} / very-long ${
        counts["very-long"]
      } / 昇格 ${promoted} / total ${total}`;
    // 直線 run による昇格が各年代で必ず起きる（閾値が全年代で機能している）
    assert(promoted > 0, `${detail} — 昇格が 1 本も無い`);
    // 過剰昇格でどの年代も「境界が読めない地図」にならない（AC7 の非退行）
    assert(counts.normal > total * 0.8, `${detail} — 通常段が 8 割を切った`);
    assert(promoted < total * 0.05, `${detail} — 昇格が 5% を超えた`);
  }
});

// --- MapLibre スタイル（source / layer）---

Deno.test("casing は tier ごとに 1 枚 + 段ごとに 1 枚の line レイヤーを持ち、id は tier から決まる", () => {
  const specs = approximateBorderLayerSpecs();
  // #228 / #309: 先頭は上位勢力外周の casing（tier 群の下に敷く下地）。
  // casing は very-long を持たないので tier 群より 1 枚少ない
  assertEquals(specs.length, UNCERTAINTY_TIERS.length + CASING_TIERS.length);
  assertEquals(
    specs.slice(0, CASING_TIERS.length).map((s) => s.id),
    [...APPROXIMATE_BORDER_CASING_LAYER_IDS],
  );
  assertEquals(
    specs.slice(CASING_TIERS.length).map((s) => s.id),
    UNCERTAINTY_TIERS.map(approximateBorderLayerId),
  );
  assertEquals([...APPROXIMATE_BORDER_LAYER_IDS], specs.map((s) => s.id));
  // id はベースマップ・deck 側のどれとも衝突しない専用の接頭辞
  for (const id of APPROXIMATE_BORDER_LAYER_IDS) {
    assert(id.startsWith(APPROXIMATE_BORDER_SOURCE_ID));
  }
});

Deno.test("各 tier レイヤーは自段の tier だけを filter し、同一 GeoJSON source を引く", () => {
  for (
    const [i, spec] of approximateBorderLayerSpecs().slice(CASING_TIERS.length)
      .entries()
  ) {
    const tier = UNCERTAINTY_TIERS[i];
    assertEquals(spec.type, "line");
    assertEquals(spec.source, APPROXIMATE_BORDER_SOURCE_ID);
    assertEquals(spec.filter, ["==", ["get", TIER_PROPERTY], tier]);
    // 角・端の丸めは layout 側（paint に置くと MapLibre のスタイル検証で弾かれる）
    assertEquals(spec.layout, { "line-join": "round", "line-cap": "round" });
    assertEquals(spec.paint["line-join"], undefined);
  }
});

Deno.test("tier の paint は TIER_STYLES から導かれ、色・にじみ・太さが段に対応する", () => {
  for (
    const [i, spec] of approximateBorderLayerSpecs().slice(CASING_TIERS.length)
      .entries()
  ) {
    const tier = UNCERTAINTY_TIERS[i];
    const style = TIER_STYLES[tier];
    assertEquals(spec.paint["line-color"], approximateBorderColor(tier));
    // 太さ・にじみはズームで倍率をかける（低ズームで潰れず高ズームで消えない）
    assertEquals(spec.paint["line-width"], [
      "interpolate",
      ["linear"],
      ["zoom"],
      ZOOM_SCALE.minZoom,
      style.widthPx * ZOOM_SCALE.minScale,
      ZOOM_SCALE.maxZoom,
      style.widthPx * ZOOM_SCALE.maxScale,
    ]);
    assertEquals(spec.paint["line-blur"], [
      "interpolate",
      ["linear"],
      ["zoom"],
      ZOOM_SCALE.minZoom,
      style.blurPx * ZOOM_SCALE.minScale,
      ZOOM_SCALE.maxZoom,
      style.blurPx * ZOOM_SCALE.maxScale,
    ]);
  }
});

Deno.test("ズーム倍率はアプリのズーム範囲の両端で縮小・拡大する（z4〜z8 の見え方）", () => {
  // 補間の端がアプリのズーム範囲（config.ts）とずれていると、最小・最大ズームでも
  // 倍率が中途半端な値のままになる
  assertEquals(ZOOM_SCALE.minZoom, MIN_ZOOM);
  assertEquals(ZOOM_SCALE.maxZoom, MAX_ZOOM);
  assert(ZOOM_SCALE.minZoom < ZOOM_SCALE.maxZoom);
  assert(ZOOM_SCALE.minScale < 1);
  assert(ZOOM_SCALE.maxScale > 1);
  // 線幅・にじみに同じ倍率をかけるため、段の見た目の比率はズームで変わらない
  // （どのズームでも「輪郭の失われ具合」が段の識別に効く）
  for (const tier of UNCERTAINTY_TIERS) {
    for (const px of [TIER_STYLES[tier].widthPx, TIER_STYLES[tier].blurPx]) {
      assert(px * ZOOM_SCALE.minScale > 0);
    }
  }
});

Deno.test("にじみ / 線幅の比が段ごとに上がる（輪郭が段階的に失われる。AC #2）", () => {
  const ratios = UNCERTAINTY_TIERS.map((tier) =>
    TIER_STYLES[tier].blurPx / TIER_STYLES[tier].widthPx
  );
  for (let i = 1; i < ratios.length; i++) {
    assert(
      ratios[i] > ratios[i - 1],
      `${UNCERTAINTY_TIERS[i]} のにじみ比が前段以下: ${ratios.join(" / ")}`,
    );
  }
  // 最強段は線幅より広くにじませ、エッジを完全に失わせる（AC #3）
  const strongest =
    TIER_STYLES[UNCERTAINTY_TIERS[UNCERTAINTY_TIERS.length - 1]];
  assert(strongest.blurPx > strongest.widthPx);
});

// --- 上位勢力外周の casing（Issue #228 AC5）---
// z4 の概観表示で「上位勢力の外周」を境界階層の最上位として読ませるため、
// tier 群の下にクリーム色の下地を 1 枚敷く。tier の blur・alpha 差（境界位置は
// 概略、という表現）は不変のまま、外周だけを一段持ち上げる。

Deno.test("casing はクリーム（labels の halo と同系）で、境界インクとは別の顔料（#228 AC5）", () => {
  // 羊皮紙トーンのクリーム = ラベル halo（labels.ts LABEL_OUTLINE_COLOR、
  // app.css --parchment #f4ecd7）と同じ RGB。地の色と連続して見えるため
  // 「控えめな下地」になり、インク系の色だと生まれる硬い二重線にならない
  assertEquals(
    [...APPROXIMATE_BORDER_CASING_INK],
    [LABEL_OUTLINE_COLOR[0], LABEL_OUTLINE_COLOR[1], LABEL_OUTLINE_COLOR[2]],
  );
  assert(
    APPROXIMATE_BORDER_CASING_INK.some((c, i) =>
      c !== APPROXIMATE_BORDER_INK[i]
    ),
    "casing が境界インクと同色では二重線になる",
  );
});

Deno.test("casing は normal / long の 2 段だけで、very-long には敷かない（#309 AC1/AC2）", () => {
  assertEquals([...CASING_TIERS], ["normal", "long"]);
  assert(
    !(CASING_TIERS as readonly string[]).includes("very-long"),
    "最も不確かな段にクリーム帯を敷くと長距離直線を再強調する（#309）",
  );
  // casing の段は必ず uncertainty tier の部分集合（未知の段を作らない）
  for (const tier of CASING_TIERS) {
    assert((UNCERTAINTY_TIERS as readonly string[]).includes(tier));
  }
  const specs = approximateBorderCasingSpecs();
  assertEquals(specs.length, CASING_TIERS.length);
  assertEquals(
    specs.map((s) => s.id),
    CASING_TIERS.map(approximateBorderCasingLayerId),
  );
  assertEquals(
    [...APPROXIMATE_BORDER_CASING_LAYER_IDS],
    specs.map((s) => s.id),
  );
});

Deno.test("各 casing レイヤーは自段の run だけを filter し、layout は tier レイヤーと揃える（#309 AC1）", () => {
  for (const [i, spec] of approximateBorderCasingSpecs().entries()) {
    const tier = CASING_TIERS[i];
    assertEquals(spec.type, "line");
    assertEquals(spec.source, APPROXIMATE_BORDER_SOURCE_ID);
    // #228 は ["has", tier] で全段へ一律に敷いていた（= very-long でも明るい帯が
    // 残り、インク線より直線を強調していた）。#309 で段ごとの filter へ分ける
    assertEquals(spec.filter, ["==", ["get", TIER_PROPERTY], tier]);
    assertEquals(spec.layout, { "line-join": "round", "line-cap": "round" });
    assertEquals(spec.paint["line-join"], undefined);
  }
});

Deno.test("casing の paint は段ごとに z4 側を強く・詳細ズームで控えめにするズーム補間（#228 AC5 / #309）", () => {
  const [r, g, b] = APPROXIMATE_BORDER_CASING_INK;
  for (const [i, spec] of approximateBorderCasingSpecs().entries()) {
    const { overview, detail } = CASING_STYLES[CASING_TIERS[i]];
    // 色（alpha）・幅・にじみとも MIN_ZOOM（z4 概観）→ MAX_ZOOM（詳細）の線形補間
    assertEquals(spec.paint["line-color"], [
      "interpolate",
      ["linear"],
      ["zoom"],
      MIN_ZOOM,
      `rgba(${r}, ${g}, ${b}, ${overview.alpha})`,
      MAX_ZOOM,
      `rgba(${r}, ${g}, ${b}, ${detail.alpha})`,
    ]);
    assertEquals(spec.paint["line-width"], [
      "interpolate",
      ["linear"],
      ["zoom"],
      MIN_ZOOM,
      overview.widthPx,
      MAX_ZOOM,
      detail.widthPx,
    ]);
    assertEquals(spec.paint["line-blur"], [
      "interpolate",
      ["linear"],
      ["zoom"],
      MIN_ZOOM,
      overview.blurPx,
      MAX_ZOOM,
      detail.blurPx,
    ]);
    // z4（概観）側が強く、詳細ズームでは控えめ
    assert(overview.alpha > detail.alpha);
    assert(overview.widthPx > detail.widthPx);
  }
});

Deno.test("casing は tier 線より広く・低 alpha・軽い blur の「控えめな下地」（#228 AC5）", () => {
  const widestTier = TIER_STYLES["very-long"];
  for (const tier of CASING_TIERS) {
    const { overview, detail } = CASING_STYLES[tier];
    // どのズーム端でも最太の tier 線より広い（下地が線からはみ出して見える）
    assert(overview.widthPx > widestTier.widthPx * ZOOM_SCALE.minScale);
    assert(detail.widthPx > widestTier.widthPx * ZOOM_SCALE.maxScale);
    for (const style of [overview, detail]) {
      // 低 alpha: 塗りが透けて「精密な国境線の縁取り」に見えない
      assert(style.alpha > 0 && style.alpha <= 0.55);
      // 軽い blur: エッジは和らげるが、blur が幅を超える「にじみ帯」にはしない
      assert(style.blurPx > 0);
      assert(style.blurPx < style.widthPx);
    }
  }
});

Deno.test("casing の幅・blur は隣接領域への「塗り漏れ」に見えない範囲に収める（#280）", () => {
  const widestTier = TIER_STYLES["very-long"];
  // #309: casing が段ごとに分かれた後も、全段が #280 の制約を満たす
  for (const tier of CASING_TIERS) {
    const ends = [
      { style: CASING_STYLES[tier].overview, scale: ZOOM_SCALE.minScale },
      { style: CASING_STYLES[tier].detail, scale: ZOOM_SCALE.maxScale },
    ] as const;
    for (const { style, scale } of ends) {
      // はみ出し（casing がインク線の下から片側に覗く量）は、そのズーム端の
      // 最太 tier 線に対して 1px 以下。normal tier のインク線 1 本分（1px）を
      // 超えて覗くと「外周の下地」ではなく境界沿いの第 3 の帯 = 隣接領域への
      // 塗り漏れに見える（#280 の再現条件。z4 の旧値 6.0px は 1.74px はみ出す）
      const overhangPx = (style.widthPx - widestTier.widthPx * scale) / 2;
      assert(
        overhangPx <= 1.0,
        `${tier} casing のはみ出しが 1px 超: ${overhangPx}px`,
      );
      // blur はエッジの alpha 勾配で見かけの帯幅をさらに広げるため、幅の 1/3
      // 以下に抑える。幅だけ縮めて blur を据え置くと、縮めた分がにじみで
      // 埋め戻されてはみ出し縮小の効果が消える
      assert(
        style.blurPx <= style.widthPx / 3,
        `${tier} casing の blur が幅の 1/3 超: ${style.blurPx}px / 幅 ${style.widthPx}px`,
      );
    }
  }
});

Deno.test("casing は段が進むほど弱まり、long は normal より相対的に強くにじむ（#309 AC1）", () => {
  // AC1: normal → long → very-long が「長距離直線を強調しない」単調な表現。
  // very-long は casing 自体が無いので、単調性は normal > long > (無し) で成る
  for (const end of ["overview", "detail"] as const) {
    const normal = CASING_STYLES.normal[end];
    const long = CASING_STYLES.long[end];
    assert(
      long.alpha < normal.alpha * 0.5,
      `${end}: long casing の alpha ${long.alpha} が normal ${normal.alpha} の半分未満になっていない`,
    );
    // にじみ / 幅の比は上げる（tier インク線と同じ「長いほど輪郭を失う」文法）。
    // 絶対値の blur を上げられないのは #280 の「blur ≤ 幅 / 3」制約があるため
    assert(
      long.blurPx / long.widthPx > normal.blurPx / normal.widthPx,
      `${end}: long casing のにじみ比が normal 以下`,
    );
    // 幅は広げない（広げるとインク線からのはみ出しが増え #280 が再発する）
    assert(long.widthPx <= normal.widthPx);
  }
});

Deno.test("very-long ではクリーム casing が無く、インク線だけが残る（#309 AC2）", () => {
  const ids = approximateBorderLayerSpecs().map((s) => s.id);
  assert(!ids.includes(approximateBorderCasingLayerId("very-long")));
  // very-long の run を含むデータでも、casing レイヤーの filter は弾く
  const veryLong = ["==", ["get", TIER_PROPERTY], "very-long"];
  for (const spec of approximateBorderCasingSpecs()) {
    assert(JSON.stringify(spec.filter) !== JSON.stringify(veryLong));
  }
});

Deno.test("tier の見た目定数を固定する（#228 / #309 / #438）", () => {
  // #438 で normal だけを小幅強調した。long / very-long の低 alpha・強い blur は
  // #309 のまま固定し、通常境界の変更が不確実な段へ波及したらここで落ちる。
  assertEquals(TIER_STYLES, {
    "normal": { alpha: 0.70, widthPx: 1.2, blurPx: 0.6 },
    "long": { alpha: 0.4, widthPx: 1.8, blurPx: 2.5 },
    "very-long": { alpha: 0.24, widthPx: 2.8, blurPx: 5.0 },
  });
});

Deno.test("#438: normal ink と long casing だけを指定値へ強める", () => {
  assertEquals(TIER_STYLES.normal, {
    alpha: 0.70,
    widthPx: 1.2,
    blurPx: 0.6,
  });
  assertEquals(CASING_STYLES.long, {
    overview: { alpha: 0.22, widthPx: 4.2, blurPx: 1.4 },
    detail: { alpha: 0.13, widthPx: 4.0, blurPx: 1.32 },
  });
  // long / very-long ink は #309 の不確実性表現をそのまま維持する。
  assertEquals(TIER_STYLES.long, {
    alpha: 0.4,
    widthPx: 1.8,
    blurPx: 2.5,
  });
  assertEquals(TIER_STYLES["very-long"], {
    alpha: 0.24,
    widthPx: 2.8,
    blurPx: 5.0,
  });
});

Deno.test("source は GeoJSON ソースで、渡した FeatureCollection を data に持つ", () => {
  const data = buildApproximateBorderData(fcOf([
    lineFeature([[0, 45], [0.1, 45]]),
  ]));
  const spec = approximateBorderSourceSpec(data);
  assertEquals(spec.type, "geojson");
  assertEquals(spec.data, data);
  assertEquals(
    approximateBorderSourceSpec().data,
    EMPTY_APPROXIMATE_BORDER_DATA,
  );
});
