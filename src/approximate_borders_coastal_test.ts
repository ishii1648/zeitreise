/**
 * 概略境界から「元の base で沿岸と判定できる外周セグメント」を除く契約の
 * ユニットテスト（Issue #357）。
 *
 * 背景: 沿岸補完（#305/#312/#326）が政治塗りを現代海岸線まで延長した一方、
 * 概略境界は base（または派生 base_outline）の**全環**を線として描いていた
 * ため、補完前の歴史的な外周が同色領域の内部に「国境線」のように残っていた
 * （1200 年フローニンゲン周辺の [5.39,53.139]〜[7.969,53.638]）。
 *
 * 検証する契約:
 * - 沿岸セグメントは概略境界の出力に現れない（AC1/AC2/AC3）
 * - 内陸境界（共有辺・T 字接合・諸侯領 union で切断された正当な境界）は
 *   従来どおり残る（AC4）
 * - 照合は座標列の完全一致に依存せず、lineSplit の途中分割で生まれた
 *   部分セグメントも落ちる（AC7）
 * - base を渡さない従来呼び出しの結果が変わらない（AC8 の後方互換）
 *
 * tier / 直線 run / casing / レイヤー定義の非退行は
 * approximate_borders_test.ts が引き続き固定する。
 */
import { assert, assertEquals } from "@std/assert";
import type { Feature, FeatureCollection, LineString, Position } from "geojson";
import {
  buildApproximateBorderData,
  TIER_PROPERTY,
} from "./approximate_borders.ts";
import { buildCoastalSegmentIndex, ringsOf } from "./coastal_segments.ts";
import { BASE_OUTLINE_YEARS } from "./config.ts";

/** テスト側の無向セグメントキー（照合が完全一致に依存しない検証に使う） */
function segmentKeyOf(a: Position, b: Position): string {
  const ka = `${a[0]},${a[1]}`;
  const kb = `${b[0]},${b[1]}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

/** 実データ: 1200 年（ユーザー報告の年代）の base と派生 base 輪郭 */
const europe1200 = JSON.parse(
  Deno.readTextFileSync(
    new URL("../data/europe_1200.geojson", import.meta.url),
  ),
) as FeatureCollection;
const outline1200 = JSON.parse(
  Deno.readTextFileSync(
    new URL("../data/base_outline_1200.geojson", import.meta.url),
  ),
) as FeatureCollection;

/** 出力の全セグメント（[始点, 終点] の列） */
function segmentsOf(data: FeatureCollection): [Position, Position][] {
  const segments: [Position, Position][] = [];
  for (const feature of data.features) {
    const coordinates = (feature.geometry as LineString).coordinates;
    for (let i = 1; i < coordinates.length; i++) {
      segments.push([coordinates[i - 1], coordinates[i]]);
    }
  }
  return segments;
}

/** セグメントキー → tier（同じセグメントが 2 度現れないことも同時に確かめる） */
function tierBySegment(data: FeatureCollection): Map<string, string> {
  const tiers = new Map<string, string>();
  for (const feature of data.features) {
    const tier = String(feature.properties?.[TIER_PROPERTY]);
    const coordinates = (feature.geometry as LineString).coordinates;
    for (let i = 1; i < coordinates.length; i++) {
      tiers.set(segmentKeyOf(coordinates[i - 1], coordinates[i]), tier);
    }
  }
  return tiers;
}

function samePoint(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function hasSegment(
  segments: readonly [Position, Position][],
  a: Position,
  b: Position,
): boolean {
  return segments.some(([p, q]) =>
    (samePoint(p, a) && samePoint(q, b)) || (samePoint(p, b) && samePoint(q, a))
  );
}

function polygonFeature(name: string, rings: Position[][]): Feature {
  return {
    type: "Feature",
    properties: { NAME: name },
    geometry: { type: "Polygon", coordinates: rings },
  };
}

function lineFeature(name: string, coordinates: Position[]): Feature {
  return {
    type: "Feature",
    properties: { NAME: name },
    geometry: { type: "LineString", coordinates },
  };
}

function fcOf(features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

/** 隣接する 2 つの正方形（x=1 の辺を厳密に共有 = 内陸境界） */
function twoSquares(): FeatureCollection {
  return fcOf([
    polygonFeature("A", [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]),
    polygonFeature("B", [[[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]]]),
  ]);
}

// --- 合成データ: 沿岸だけを落とし、内陸は残す（AC1 / AC4）---

Deno.test("base ポリゴンを直接渡すと、沿岸の外周セグメントは概略境界に現れない（#357 AC1）", () => {
  const data = buildApproximateBorderData(twoSquares());
  const segments = segmentsOf(data);
  // 共有辺 x=1（内陸境界）は残る
  assert(hasSegment(segments, [1, 0], [1, 1]), "内陸の共有辺が消えている");
  // 外周（沿岸判定）は 1 本も残らない
  for (const [p, q] of segments) {
    assert(
      p[0] === 1 && q[0] === 1,
      `沿岸セグメントが残っている: ${JSON.stringify([p, q])}`,
    );
  }
});

Deno.test("T 字接合（頂点数だけが違う一致境界）は内陸として残る（#357 AC4）", () => {
  const tJunction = fcOf([
    polygonFeature("A", [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]),
    // 左辺に中間頂点 (1, 0.5) を持つ = A の右辺と 1:2 で対応し、
    // セグメント単位では共有されない
    polygonFeature("B", [[[1, 0], [2, 0], [2, 1], [1, 1], [1, 0.5], [1, 0]]]),
  ]);
  const segments = segmentsOf(buildApproximateBorderData(tJunction));
  // A 側の 1 本と B 側の 2 本、いずれも残る（沿岸と誤認して消さない）
  assert(hasSegment(segments, [1, 0], [1, 1]), "A 側の T 字境界が消えた");
  assert(hasSegment(segments, [1, 1], [1, 0.5]), "B 側の T 字境界が消えた");
  assert(hasSegment(segments, [1, 0.5], [1, 0]), "B 側の T 字境界が消えた");
  // x=1 以外（外周 = 沿岸）は残らない
  for (const [p, q] of segments) {
    assert(
      p[0] === 1 && q[0] === 1,
      `沿岸が残っている: ${JSON.stringify([p, q])}`,
    );
  }
});

Deno.test("穴（湖など）の環は沿岸ではないので概略境界に残る（#357 AC6 の非退行）", () => {
  const withHole = fcOf([
    polygonFeature("A", [
      [[0, 0], [3, 0], [3, 3], [0, 3], [0, 0]],
      [[1, 1], [1, 2], [2, 2], [2, 1], [1, 1]],
    ]),
  ]);
  const segments = segmentsOf(buildApproximateBorderData(withHole));
  assert(hasSegment(segments, [1, 1], [1, 2]), "穴の環が消えている");
  assert(!hasSegment(segments, [0, 0], [3, 0]), "外環（沿岸）が残っている");
});

// --- outline を入力にする経路（諸侯領オーバーレイ対象年）---

Deno.test("outline を入力にしても base 由来の沿岸判定で外周が落ちる（#357 AC1）", () => {
  const base = twoSquares();
  // base_outline 相当: 環をそのまま LineString にしたもの
  const outlines = fcOf([
    lineFeature("A", [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]),
    lineFeature("B", [[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]]),
  ]);
  const segments = segmentsOf(buildApproximateBorderData(outlines, base));
  assert(hasSegment(segments, [1, 0], [1, 1]), "内陸の共有辺が消えている");
  assert(!hasSegment(segments, [0, 0], [1, 0]), "沿岸セグメントが残っている");
  assert(!hasSegment(segments, [2, 0], [2, 1]), "沿岸セグメントが残っている");
});

Deno.test("途中分割された沿岸セグメント（lineSplit 由来）も落ちる（#357 AC7）", () => {
  const base = twoSquares();
  // 沿岸辺 (0,0)-(1,0) が中間頂点 (0.5, 0) で 2 本に割れている。さらに切断点は
  // 座標丸め（COORD_PRECISION = 3 桁）で本来の直線から僅かにずれ得る
  const outlines = fcOf([
    lineFeature("A", [[0, 0], [0.5, 0.0004], [1, 0]]),
  ]);
  const segments = segmentsOf(buildApproximateBorderData(outlines, base));
  assertEquals(segments.length, 0, JSON.stringify(segments));
});

Deno.test("沿岸から十分離れた線は落ちない（照合の許容が無制限でない）（#357 AC4）", () => {
  const base = twoSquares();
  // 沿岸辺 (0,0)-(1,0) から 0.005°（= COASTAL_MATCH_EPS_DEG の 5 倍）内側
  const outlines = fcOf([lineFeature("A", [[0, 0.005], [1, 0.005]])]);
  const segments = segmentsOf(buildApproximateBorderData(outlines, base));
  assertEquals(segments.length, 1);
});

Deno.test("base を渡さない従来呼び出しは結果が変わらない（#357 AC8 の後方互換）", () => {
  // LineString だけの入力は沿岸判定の材料（ポリゴンの外環）を持たないため、
  // 索引が空になり 1 本も落ちない = TASK-80 以来の挙動そのまま
  const outlines = fcOf([
    lineFeature("A", [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]),
  ]);
  const withoutBase = buildApproximateBorderData(outlines);
  assertEquals(segmentsOf(withoutBase).length, 4);
});

Deno.test("base と outline を合成した入力でも沿岸外周は再導入されない（#357 AC8 / #347 前提）", () => {
  const base = twoSquares();
  // #347 の focus 経路が想定する「base の環 + outline の線」の合成入力
  const composed = fcOf([
    ...base.features,
    lineFeature("A", [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]),
  ]);
  const segments = segmentsOf(buildApproximateBorderData(composed, base));
  for (const [p, q] of segments) {
    assert(
      p[0] === 1 && q[0] === 1,
      `沿岸セグメントが残っている: ${JSON.stringify([p, q])}`,
    );
  }
  assert(hasSegment(segments, [1, 0], [1, 1]));
});

// --- 実データ: 1200 年フローニンゲン（ユーザー報告の箇所）---

/** ユーザー報告の区間（Issue #357 本文の bbox） */
const GRONINGEN_BOX = [5.39, 53.139, 7.969, 53.638] as const;

function inGroningenBox(p: Position): boolean {
  return p[0] >= GRONINGEN_BOX[0] && p[0] <= GRONINGEN_BOX[2] &&
    p[1] >= GRONINGEN_BOX[1] && p[1] <= GRONINGEN_BOX[3];
}

Deno.test("実データ: 1200 年フローニンゲンの旧海岸外周が概略境界から消える（#357 AC1/AC2）", () => {
  // 修正前は Holy Roman Empire の外周 13 セグメントが normal / long 段の線として
  // 生成され、沿岸補完後の緑色領域の内部に薄い「国境線」として残っていた。
  const before = buildApproximateBorderData(outline1200);
  const inBoxBefore = segmentsOf(before).filter(([p, q]) =>
    inGroningenBox(p) && inGroningenBox(q)
  );
  assertEquals(
    inBoxBefore.length,
    13,
    "前提が変わった: 旧挙動での該当セグメント数",
  );

  const after = buildApproximateBorderData(outline1200, europe1200);
  const inBoxAfter = segmentsOf(after).filter(([p, q]) =>
    inGroningenBox(p) && inGroningenBox(q)
  );
  assertEquals(
    inBoxAfter.length,
    0,
    `旧海岸外周が残っている: ${JSON.stringify(inBoxAfter)}`,
  );
});

Deno.test("実データ: 1200 年の HRE ↔ デンマークの内陸国境は従来どおり残る（#357 AC4）", () => {
  const data = buildApproximateBorderData(outline1200, europe1200);
  const segments = segmentsOf(data);
  // europe_1200 で Holy Roman Empire と Denmark がちょうど 2 回出現する形で
  // 共有する 14 本のうちの代表 4 本（ユトランド半島の付け根）
  const inland: [Position, Position][] = [
    [[8.884, 54.229], [8.962, 54.276]],
    [[8.962, 54.276], [9.056, 54.349]],
    [[9.056, 54.349], [9.136, 54.298]],
    [[9.296, 54.247], [9.441, 54.247]],
  ];
  for (const [a, b] of inland) {
    assert(
      hasSegment(segments, a, b),
      `内陸の共有国境が消えた: ${JSON.stringify([a, b])}`,
    );
  }
});

Deno.test("実データ: 1200 年の途中分割された沿岸断片（完全一致しない）も消える（#357 AC7）", () => {
  const data = buildApproximateBorderData(outline1200, europe1200);
  const segments = segmentsOf(data);
  // コルシカ島の外周 [8.609,42.487]→[8.5,42.36] を諸侯領 union で切った断片。
  // base には同じ頂点列が存在しないため、完全一致だけの照合では残ってしまう
  const split: [Position, Position][] = [
    [[8.573, 42.445], [8.597, 42.472]],
    [[8.736, 41.555], [8.727, 41.561]],
    [[9.039, 41.369], [9.024, 41.421]],
  ];
  for (const [a, b] of split) {
    assert(
      !hasSegment(segments, a, b),
      `途中分割された沿岸断片が残っている: ${JSON.stringify([a, b])}`,
    );
  }
  // 完全一致だけでは落ちない = 近傍照合が効いていることの裏取り
  const exactOnly = segmentsOf(buildApproximateBorderData(outline1200));
  for (const [a, b] of split) {
    assert(hasSegment(exactOnly, a, b), "前提が変わった: 旧挙動では残っていた");
  }
});

// --- 実データ: 全 19 年代（AC3）---

Deno.test("実データ: 全 19 年代で base が沿岸と判定する外周が描画出力に含まれない（#357 AC3/AC7）", () => {
  /** base に同じ頂点列が存在しない = lineSplit が作った断片の落ちた本数 */
  let splitDrops = 0;
  for (const year of BASE_OUTLINE_YEARS) {
    const base = JSON.parse(
      Deno.readTextFileSync(
        new URL(`../data/europe_${year}.geojson`, import.meta.url),
      ),
    ) as FeatureCollection;
    const outlines = JSON.parse(
      Deno.readTextFileSync(
        new URL(`../data/base_outline_${year}.geojson`, import.meta.url),
      ),
    ) as FeatureCollection;
    const coastal = buildCoastalSegmentIndex(base);
    assert(coastal.size > 0, `${year}: 沿岸セグメントが 1 本も無い`);

    const data = buildApproximateBorderData(outlines, base);
    assert(data.features.length > 0, `${year}: run が 1 本も無い`);
    for (const [p, q] of segmentsOf(data)) {
      assert(
        !coastal.includes(p, q),
        `${year}: 沿岸セグメントが出力に残っている ${JSON.stringify([p, q])}`,
      );
    }

    // 内陸境界が全滅していないこと（線がまるごと消える実装への保険）
    const kept = segmentsOf(data).length;
    const total = segmentsOf(buildApproximateBorderData(outlines)).length;
    assert(
      kept > total * 0.2,
      `${year}: 残った線が少なすぎる ${kept}/${total}`,
    );

    // 落ちたセグメントには「base に同じ頂点列が無いもの」= lineSplit が
    // 作った断片が含まれる（照合が完全一致だけに依存していない証拠。AC7）
    const baseKeys = new Set<string>();
    for (const feature of base.features) {
      for (const ring of ringsOf(feature.geometry)) {
        for (let i = 1; i < ring.length; i++) {
          baseKeys.add(segmentKeyOf(ring[i - 1], ring[i]));
        }
      }
    }
    for (const [p, q] of segmentsOf(buildApproximateBorderData(outlines))) {
      if (!coastal.includes(p, q)) continue;
      if (!baseKeys.has(segmentKeyOf(p, q))) splitDrops++;
    }
  }
  assert(splitDrops > 0, "途中分割の断片が 1 本も落ちていない");
});

Deno.test("実データ: 残った内陸境界の tier は修正前と完全に同じ（#357 AC5 / #309 非退行）", () => {
  // 沿岸の除去は「線を落とす」だけで、残る区間の不確かさ表現（tier =
  // 直線 run 検出込みの実効長で決まる）を動かしてはいけない。tier が変われば
  // line-width / line-blur / alpha / casing の有無まで連動して変わるため、
  // セグメント単位の tier が 1 本残らず一致することを全 19 年代で固定する。
  for (const year of BASE_OUTLINE_YEARS) {
    const base = JSON.parse(
      Deno.readTextFileSync(
        new URL(`../data/europe_${year}.geojson`, import.meta.url),
      ),
    ) as FeatureCollection;
    const outlines = JSON.parse(
      Deno.readTextFileSync(
        new URL(`../data/base_outline_${year}.geojson`, import.meta.url),
      ),
    ) as FeatureCollection;
    const before = tierBySegment(buildApproximateBorderData(outlines));
    const after = tierBySegment(buildApproximateBorderData(outlines, base));
    assert(after.size > 0, `${year}: 残ったセグメントが無い`);
    for (const [key, tier] of after) {
      assertEquals(before.get(key), tier, `${year}: ${key} の tier が変わった`);
    }
  }
});
