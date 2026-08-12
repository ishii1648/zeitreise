/**
 * coastal_segments.ts のユニットテスト（Issue #357）。
 *
 * 沿岸 run そのものの契約（向き・島の閉じ方・穴の除外・T 字接合）は
 * coastal_fill_test.ts が buildCoastalRuns 経由で引き続き固定する。ここでは
 * #357 で追加した「セグメント索引」の照合規則を検証する:
 * - 沿岸セグメントの完全一致
 * - 途中分割された部分セグメント（丸め誤差つき）の近傍一致
 * - 内陸境界（共有辺・T 字接合）と穴を沿岸と誤認しないこと
 * - 許容距離の外側（COASTAL_MATCH_EPS_DEG 超）は一致しないこと
 */
import { assert, assertEquals } from "@std/assert";
import type { Feature, FeatureCollection, Position } from "geojson";
import {
  buildCoastalSegmentIndex,
  COASTAL_MATCH_EPS_DEG,
  coastalRunsByFeature,
  NEAR_BOUNDARY_EPS_DEG,
} from "./coastal_segments.ts";

function polygonFeature(name: string, rings: Position[][]): Feature {
  return {
    type: "Feature",
    properties: { NAME: name },
    geometry: { type: "Polygon", coordinates: rings },
  };
}

function fcOf(features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

/** 隣接する 2 つの正方形（x=1 の辺を厳密に共有）。A は CW 巻きで入れる */
function twoSquares(): FeatureCollection {
  return fcOf([
    polygonFeature("A", [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]]),
    polygonFeature("B", [[[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]]]),
  ]);
}

Deno.test("索引は外環の沿岸セグメントを完全一致で拾い、内陸の共有辺は拾わない", () => {
  const index = buildCoastalSegmentIndex(twoSquares());
  assertEquals(index.size, 6);
  assert(index.includes([0, 0], [1, 0]));
  // 端点の順序に依存しない
  assert(index.includes([1, 0], [0, 0]));
  assert(index.includes([2, 0], [2, 1]));
  assert(!index.includes([1, 0], [1, 1]), "共有辺を沿岸と誤認した");
});

Deno.test("索引は途中分割された部分セグメントを近傍一致で拾う（丸め誤差込み）", () => {
  const index = buildCoastalSegmentIndex(twoSquares());
  // 沿岸辺 (0,0)-(1,0) を (0.5, 0) で割った 2 本
  assert(index.includes([0, 0], [0.5, 0]));
  assert(index.includes([0.5, 0], [1, 0]));
  // 切断点が COORD_PRECISION = 3 桁へ丸められて僅かにずれた場合
  const rounded: Position = [0.5, 0.0007];
  assert(index.includes([0, 0], rounded));
  assert(index.includes(rounded, [1, 0]));
});

Deno.test("索引は許容距離の外側（COASTAL_MATCH_EPS_DEG 超）を拾わない", () => {
  const index = buildCoastalSegmentIndex(twoSquares());
  const outside = COASTAL_MATCH_EPS_DEG * 2;
  assert(!index.includes([0, outside], [1, outside]));
  // 片端だけが乗っていても一致にしない（区間全体が沿岸に乗ることが条件）
  assert(!index.includes([0, 0], [1, outside]));
  // 許容は T 字接合の許容（内陸判定側）より狭い
  assert(COASTAL_MATCH_EPS_DEG < NEAR_BOUNDARY_EPS_DEG);
});

Deno.test("索引は T 字接合（頂点数だけが違う一致境界）を沿岸と誤認しない", () => {
  const tJunction = fcOf([
    polygonFeature("A", [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]),
    polygonFeature("B", [[[1, 0], [2, 0], [2, 1], [1, 1], [1, 0.5], [1, 0]]]),
  ]);
  const index = buildCoastalSegmentIndex(tJunction);
  assert(!index.includes([1, 0], [1, 1]));
  assert(!index.includes([1, 1], [1, 0.5]));
  assert(!index.includes([1, 0.5], [1, 0]));
  assert(index.includes([0, 0], [1, 0]));
});

Deno.test("索引は穴（湖など）の環を沿岸に含めない", () => {
  const withHole = fcOf([
    polygonFeature("A", [
      [[0, 0], [3, 0], [3, 3], [0, 3], [0, 0]],
      [[1, 1], [1, 2], [2, 2], [2, 1], [1, 1]],
    ]),
  ]);
  const index = buildCoastalSegmentIndex(withHole);
  assertEquals(index.size, 4);
  assert(!index.includes([1, 1], [1, 2]));
});

Deno.test("ポリゴンを持たない入力では索引が空になり、何も沿岸と判定しない", () => {
  const lines = fcOf([{
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: [[0, 0], [1, 0]] },
  }]);
  const index = buildCoastalSegmentIndex(lines);
  assertEquals(index.size, 0);
  assert(!index.includes([0, 0], [1, 0]));
});

Deno.test("索引と沿岸 run は同じ判定から作られる（run のセグメントは必ず索引に入る）", () => {
  const base = twoSquares();
  const index = buildCoastalSegmentIndex(base);
  let count = 0;
  for (const runs of coastalRunsByFeature(base)) {
    for (const run of runs) {
      for (let i = 1; i < run.length; i++) {
        assert(index.includes(run[i - 1], run[i]));
        count++;
      }
    }
  }
  assertEquals(count, index.size);
});
