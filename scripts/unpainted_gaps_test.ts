/**
 * scripts/unpainted_gaps.ts の単体テスト（#390）。
 *
 * 実データではなく合成ジオメトリだけを使い、ヘルパ自体の正しさ
 * （検出の有無・平均幅の尺度・複数レイヤーの合成・タイル分割の不変性）を
 * 検査する。実データに対する回帰テストは build-data_test.ts 側にある。
 */
import { assertAlmostEquals, assertEquals } from "@std/assert";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import {
  DEFAULT_TILE_DEGREES,
  NO_TILING_DEG,
  unpaintedGapsIn,
} from "./unpainted_gaps.ts";

/** [west, south, east, north] の矩形 Feature */
function rect(
  [west, south, east, north]: [number, number, number, number],
): Feature<Polygon> {
  return {
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
}

/** 矩形の集合から FeatureCollection を組み立てる */
function layerOf(
  ...boxes: Array<[number, number, number, number]>
): FeatureCollection {
  return { type: "FeatureCollection", features: boxes.map(rect) };
}

/** 度で表した経度差の、緯度 lat での概算メートル（perimeter と同じ尺度） */
function lonDegToM(deg: number, lat: number): number {
  return deg * 111_320 * Math.cos(lat * Math.PI / 180);
}

const BOX: [number, number, number, number] = [0, 48, 1, 49];

Deno.test("隙間なく隣接する 2 つの矩形には未塗装が残らない", () => {
  const gaps = unpaintedGapsIn(
    layerOf([0, 48, 0.5, 49], [0.5, 48, 1, 49]),
    BOX,
  );
  assertEquals(gaps, []);
});

Deno.test("幅 W の隙間は 1 件検出され、平均幅が W に一致する", () => {
  const widthDeg = 0.002;
  const gaps = unpaintedGapsIn(
    layerOf([0, 48, 0.5, 49], [0.5 + widthDeg, 48, 1, 49]),
    BOX,
  );
  assertEquals(gaps.length, 1);
  // 平均幅 = 2·面積 ÷ 周長。細長い矩形なら実幅にほぼ一致する
  const expected = lonDegToM(widthDeg, 48.5);
  assertAlmostEquals(gaps[0].meanWidthM, expected, expected * 0.02);
  // 面積も帯の実面積（幅 × 高さ）と整合する
  const expectedKm2 = expected * 111_320 / 1e6;
  assertAlmostEquals(gaps[0].areaKm2, expectedKm2, expectedKm2 * 0.02);
  // bbox は隙間の範囲を指す
  assertEquals(gaps[0].bbox.map((v) => v.toFixed(3)), [
    "0.500",
    "48.000",
    "0.502",
    "49.000",
  ]);
});

Deno.test("他レイヤーが覆う穴は未塗装として数えない", () => {
  const base = layerOf([0, 48, 0.5, 49], [0.502, 48, 1, 49]);
  // base だけなら 1 件残る
  assertEquals(unpaintedGapsIn(base, BOX).length, 1);
  // 隙間を跨ぐオーバーレイを重ねると 0 件になる
  const overlay = layerOf([0.4, 48, 0.6, 49]);
  assertEquals(unpaintedGapsIn([base, overlay], BOX), []);
});

Deno.test("複数レイヤーは合成され、どのレイヤーも覆わない面だけが残る", () => {
  // 上半分を base、左下をオーバーレイが塗り、右下だけどちらも塗らない
  const base = layerOf([0, 48.5, 1, 49]);
  const overlay = layerOf([0, 48, 0.5, 48.5]);
  const gaps = unpaintedGapsIn([base, overlay], BOX);
  assertEquals(gaps.length, 1);
  assertEquals(gaps[0].bbox.map((v) => v.toFixed(3)), [
    "0.500",
    "48.000",
    "1.000",
    "48.500",
  ]);
});

Deno.test("塗りが 1 つも無ければ矩形全体が 1 件の未塗装になる", () => {
  const gaps = unpaintedGapsIn(layerOf(), BOX);
  assertEquals(gaps.length, 1);
  assertEquals(gaps[0].bbox, [0, 48, 1, 49]);
});

Deno.test("minAreaKm2 より小さい成分は捨てる", () => {
  const base = layerOf([0, 48, 0.5, 49], [0.502, 48, 1, 49]);
  assertEquals(unpaintedGapsIn(base, BOX).length, 1);
  assertEquals(unpaintedGapsIn(base, BOX, { minAreaKm2: 1e6 }), []);
});

Deno.test("既定はタイル分割なし", () => {
  // 既定を変えるときは、開示済みの実測値を固定しているテスト
  // （build-data_test.ts の #376 / #378）への影響を確認すること
  assertEquals(DEFAULT_TILE_DEGREES, NO_TILING_DEG);
});

// ---------------------------------------------------------------------------
// タイル分割の不変性
//
// 現行データでは分割しないほうが速く正確なので既定は分割なしだが、feature 数が
// 桁で増えたときの逃げ道としてタイル分割を残してある。タイル境界をまたぐ隙間が
// 分断されて数え上げが変わってはならない。
// ---------------------------------------------------------------------------

/** タイル分割の有無で結果が変わらないことを確かめる */
function assertTilingInvariant(
  layers: FeatureCollection[],
  box: [number, number, number, number],
  tileDegrees: number,
  expectedCount: number,
): void {
  const whole = unpaintedGapsIn(layers, box, { tileDegrees: NO_TILING_DEG });
  const tiled = unpaintedGapsIn(layers, box, { tileDegrees });
  assertEquals(whole.length, expectedCount, "分割なしの件数が期待と違う");
  assertEquals(tiled.length, expectedCount, "タイル分割で件数が変わった");
  for (let i = 0; i < whole.length; i++) {
    assertAlmostEquals(
      tiled[i].areaKm2,
      whole[i].areaKm2,
      Math.max(whole[i].areaKm2 * 1e-6, 1e-9),
      "タイル分割で面積が変わった",
    );
    assertAlmostEquals(
      tiled[i].meanWidthM,
      whole[i].meanWidthM,
      Math.max(whole[i].meanWidthM * 1e-4, 1e-6),
      "タイル分割で平均幅が変わった",
    );
  }
}

Deno.test("タイル境界を縦断する細長い隙間は 1 件として検出される", () => {
  // 緯度 48–49 を貫く幅 0.002 度の帯。0.25 度タイルなら 4 段に分断される
  const layers = [layerOf([0, 48, 0.5, 49], [0.502, 48, 1, 49])];
  assertTilingInvariant(layers, BOX, 0.25, 1);
});

Deno.test("タイル境界を横断する細長い隙間は 1 件として検出される", () => {
  // 経度 0–1 を貫く幅 0.002 度の帯。0.25 度タイルなら 4 列に分断される
  const layers = [layerOf([0, 48, 1, 48.6], [0, 48.602, 1, 49])];
  assertTilingInvariant(layers, BOX, 0.25, 1);
});

Deno.test("タイル境界の線上に載る隙間も 1 件として検出される", () => {
  // 帯の中心（緯度 48.5）がちょうどタイル境界に一致する最悪ケース
  const layers = [layerOf([0, 48, 1, 48.499], [0, 48.501, 1, 49])];
  assertTilingInvariant(layers, BOX, 0.25, 1);
});

Deno.test("タイル境界をまたぐ L 字の隙間も 1 件として検出される", () => {
  // 縦帯（経度 0.5 付近）と横帯（緯度 48.6 付近）が交わる L 字
  const layers = [layerOf(
    [0, 48, 0.5, 48.6],
    [0.502, 48, 1, 48.6],
    [0, 48.602, 1, 49],
  )];
  assertTilingInvariant(layers, BOX, 0.25, 1);
});

Deno.test("離れた 2 つの隙間はタイル分割後も 2 件のまま", () => {
  const layers = [layerOf(
    [0, 48, 0.2, 49],
    [0.202, 48, 0.6, 49],
    [0.605, 48, 1, 49],
  )];
  assertTilingInvariant(layers, BOX, 0.25, 2);
});

Deno.test("タイルに分けても隙間の平均幅は実幅のまま", () => {
  // 分断片をそのまま数えると、切断面が周長に加わって幅が過小に出る。
  // 結合が効いていることを実幅との比較で直接確かめる
  const layers = [layerOf([0, 48, 0.5, 49], [0.502, 48, 1, 49])];
  const tiled = unpaintedGapsIn(layers, BOX, { tileDegrees: 0.125 });
  assertEquals(tiled.length, 1);
  const expected = lonDegToM(0.002, 48.5);
  assertAlmostEquals(tiled[0].meanWidthM, expected, expected * 0.02);
});
