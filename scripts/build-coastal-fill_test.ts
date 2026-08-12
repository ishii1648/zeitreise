/**
 * scripts/build-coastal-fill.ts の純ロジックのユニットテスト（Issue #326）。
 *
 * 生成物そのもの（全 19 年の存在・入力との対応・ランタイムコスト）の検査は
 * src/coastal_fill_prebuilt_test.ts にある。ここではパス規則・座標の丸め・
 * 指紋の往復（buildCoastalFillDocument ⇄ readCoastalFillMeta）を固定する。
 */
import { assertEquals } from "@std/assert";
import type { FeatureCollection, MultiPolygon } from "geojson";
import {
  buildCoastalFillDocument,
  COASTAL_FILL_COORD_PRECISION,
  coastalFillOutputPathFor,
  coastalFillSourcePathFor,
  readCoastalFillMeta,
  roundBandCoordinates,
} from "./build-coastal-fill.ts";
import { COORD_PRECISION } from "./build-data.ts";
import { COASTAL_FILL_BAND_KM } from "../src/coastal_fill.ts";

const BANDS: FeatureCollection<MultiPolygon> = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: { baseIndex: 3 },
    geometry: {
      type: "MultiPolygon",
      coordinates: [[[
        [1.23456789, 45.98765432],
        [1.5, 45.5],
        [1.0004999, 45.0],
        [1.23456789, 45.98765432],
      ]]],
    },
  }],
};

Deno.test("入力・出力のパス規則は年代別の 1 ファイル（#326）", () => {
  assertEquals(coastalFillSourcePathFor(1900), "data/europe_1900.geojson");
  assertEquals(
    coastalFillOutputPathFor(1900),
    "data/coastal_fill_1900.geojson",
  );
});

Deno.test("座標は帯専用の精度（5 桁）へ丸める（#326）", () => {
  // 帯の座標は polyclip 差分の交点で元データの格子に乗らない。本体と同じ
  // 3 桁へ落とすと平行に走る内外の辺が同じ格子点へ潰れて自己交差が増えるため、
  // 本体（COORD_PRECISION）より細かい 5 桁（≈ 1.1m）を使う
  assertEquals(COORD_PRECISION, 3);
  assertEquals(COASTAL_FILL_COORD_PRECISION, 5);
  const rounded = roundBandCoordinates(BANDS);
  assertEquals(rounded.features[0].geometry.coordinates, [[[
    [1.23457, 45.98765],
    [1.5, 45.5],
    [1.0005, 45],
    [1.23457, 45.98765],
  ]]]);
  // properties（base の添字）は素通し
  assertEquals(rounded.features[0].properties, { baseIndex: 3 });
});

Deno.test("丸めの桁数は指定できる（#326）", () => {
  const rounded = roundBandCoordinates(BANDS, 3);
  assertEquals(rounded.features[0].geometry.coordinates[0][0][0], [
    1.235,
    45.988,
  ]);
});

Deno.test("指紋は foreign member として書き出され、そのまま読み戻せる（#326）", () => {
  const document = buildCoastalFillDocument(BANDS, {
    sourcePath: "data/europe_1900.geojson",
    sourceHash: "0123456789",
    bandKm: COASTAL_FILL_BAND_KM,
  });
  assertEquals(document.type, "FeatureCollection");
  assertEquals(document.features, BANDS.features);
  // JSON を往復しても指紋が保たれる（配信ファイルから読めることの担保）
  assertEquals(readCoastalFillMeta(JSON.parse(JSON.stringify(document))), {
    sourcePath: "data/europe_1900.geojson",
    sourceHash: "0123456789",
    bandKm: COASTAL_FILL_BAND_KM,
  });
});

Deno.test("指紋を持たない・形が違うデータは null（陳腐化を検出できない扱い。#326）", () => {
  assertEquals(readCoastalFillMeta(null), null);
  assertEquals(readCoastalFillMeta("x"), null);
  assertEquals(readCoastalFillMeta({ type: "FeatureCollection" }), null);
  assertEquals(
    readCoastalFillMeta({
      sourcePath: "data/europe_1900.geojson",
      sourceHash: "0123456789",
      bandKm: "30",
    }),
    null,
  );
});
