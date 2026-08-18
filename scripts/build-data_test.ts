import { assert, assertEquals, assertThrows } from "@std/assert";
import area from "@turf/area";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { featureCollection } from "@turf/helpers";
import intersect from "@turf/intersect";
import type {
  Feature,
  FeatureCollection,
  MultiPolygon,
  Polygon,
} from "geojson";
import { segmentLengthKm } from "../src/approximate_borders.ts";
import { MAX_ZOOM, SNAPSHOT_YEARS } from "../src/config.ts";
import { colorKeyFor } from "../src/powers.ts";
import { CLIOPATRIA_COMPOSITE_PARENTS } from "./build-cliopatria-fiefs.ts";
import {
  applyNameOverrides,
  applyPropertyFixes,
  BASE_FIEF_SPLITS,
  BASE_POWER_MERGES,
  BASE_POWER_REPLACEMENTS,
  buildIndex,
  buildSourceUrl,
  clipToBbox,
  COORD_PRECISION,
  EUROPE_BBOX,
  mergeBasePower,
  mergeSeveredRemainders,
  normalizeSubjectProps,
  replaceBasePower,
  resolveName,
  shrinkToLimit,
  SIMPLIFY_TOLERANCES,
  SOURCE_COMMIT,
  SOURCE_LICENSE,
  SOURCE_REPO,
  splitFiefFromBase,
  unionByName,
  YEARS,
} from "./build-data.ts";
import { NO_TILING_DEG, unpaintedGapsIn } from "./unpainted_gaps.ts";

/** テスト用に MultiPolygon の Feature を組み立てる（正方形リングの集合） */
function multiPolygonFeature(
  properties: Record<string, unknown>,
  squares: Array<[number, number, number, number]>,
): Feature<MultiPolygon> {
  const coordinates = squares.map((
    [minX, minY, maxX, maxY],
  ) => [[
    [minX, minY],
    [minX, maxY],
    [maxX, maxY],
    [maxX, minY],
    [minX, minY],
  ]]);
  return {
    type: "Feature",
    properties,
    geometry: { type: "MultiPolygon", coordinates },
  };
}

/** feature の面積（km²）。#352 の置換テストで面の入替を数値で確かめる */
function areaKm2(feature: Feature): number {
  return area(feature) / 1e6;
}

/** リング配列から Polygon feature を作る（パートごとの面積比較用） */
function turfPolygonOf(rings: number[][][]): Feature<Polygon> {
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: rings },
  };
}

Deno.test("buildSourceUrl はピン留めコミットの raw URL を生成する", () => {
  assertEquals(
    buildSourceUrl(1492),
    `https://raw.githubusercontent.com/aourednik/historical-basemaps/${SOURCE_COMMIT}/geojson/world_1492.geojson`,
  );
});

Deno.test("定数は仕様どおりの出典情報を持つ", () => {
  assertEquals(SOURCE_REPO, "aourednik/historical-basemaps");
  assertEquals(SOURCE_LICENSE, "GPL-3.0");
  assertEquals(SOURCE_COMMIT.length, 40);
  assertEquals(EUROPE_BBOX, [-25, 34, 60, 72]);
  assertEquals(YEARS.length, 19);
  assertEquals(YEARS[0], 1000);
  assertEquals(YEARS[YEARS.length - 1], 1914);
});

Deno.test("YEARS は src/config.ts の SNAPSHOT_YEARS と一致する（二重定義ドリフト防止）", () => {
  assertEquals(YEARS, [...SNAPSHOT_YEARS]);
});

Deno.test("clipToBbox は bbox 外の feature を除去し、空パートを残さない", () => {
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      // 完全に内側
      multiPolygonFeature({ NAME: "inside" }, [[2, 2, 8, 8]]),
      // 完全に外側 → 除去される
      multiPolygonFeature({ NAME: "outside" }, [[20, 20, 30, 30]]),
      // 一部が内側・一部が外側 → 内側パートのみ残る
      multiPolygonFeature({ NAME: "mixed" }, [[2, 2, 8, 8], [20, 20, 30, 30]]),
    ],
  };

  const clipped = clipToBbox(fc, [0, 0, 10, 10]);

  const names = clipped.features.map((f) => f.properties?.NAME);
  assertEquals(names.sort(), ["inside", "mixed"]);

  for (const feature of clipped.features) {
    const geometry = feature.geometry;
    assert(geometry !== null);
    if (geometry.type === "MultiPolygon") {
      for (const part of geometry.coordinates) {
        assert(part.length > 0, "空のポリゴンパートが残ってはいけない");
      }
      assert(geometry.coordinates.length > 0);
    }
  }
});

Deno.test("resolveName は NAME を優先しつつ null は ABBREVN→SUBJECTO→PARTOF で補完する", () => {
  const overrides = { renames: {} };
  assertEquals(
    resolveName({ NAME: "France", ABBREVN: "FR" }, overrides),
    "France",
  );
  assertEquals(
    resolveName(
      { NAME: null, ABBREVN: "HRE", SUBJECTO: "Empire" },
      overrides,
    ),
    "HRE",
  );
  assertEquals(
    resolveName(
      { NAME: null, ABBREVN: null, SUBJECTO: "Ottoman Empire" },
      overrides,
    ),
    "Ottoman Empire",
  );
  assertEquals(
    resolveName(
      {
        NAME: null,
        ABBREVN: null,
        SUBJECTO: null,
        PARTOF: "Latin Christendom",
      },
      overrides,
    ),
    "Latin Christendom",
  );
  assertEquals(
    resolveName({ NAME: null, ABBREVN: null }, overrides),
    null,
  );
});

Deno.test("resolveName は renames マップで表記ゆれを補正する", () => {
  const overrides = { renames: { "Byzantine Empire": "Byzantium" } };
  assertEquals(
    resolveName({ NAME: "Byzantine Empire" }, overrides),
    "Byzantium",
  );
  // フォールバックで得た名前にも rename が適用される
  assertEquals(
    resolveName({ NAME: null, ABBREVN: "Byzantine Empire" }, overrides),
    "Byzantium",
  );
});

Deno.test("applyNameOverrides は全 feature の NAME を解決して書き換える", () => {
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      multiPolygonFeature({ NAME: "Kingdom of France" }, [[0, 0, 1, 1]]),
      multiPolygonFeature(
        { NAME: null, SUBJECTO: "Holy Roman Empire" },
        [[1, 1, 2, 2]],
      ),
    ],
  };
  const overrides = { renames: { "Kingdom of France": "France" } };

  const result = applyNameOverrides(fc, overrides);

  assertEquals(result.features[0].properties?.NAME, "France");
  assertEquals(result.features[1].properties?.NAME, "Holy Roman Empire");
  // 元の SUBJECTO などは保持される
  assertEquals(
    result.features[1].properties?.SUBJECTO,
    "Holy Roman Empire",
  );
});

Deno.test("applyPropertyFixes は該当年の同名 feature を全て上書きする（TASK-102）", () => {
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      multiPolygonFeature(
        { NAME: "Lombardy", SUBJECTO: "3", BORDERPRECISION: 0 },
        [[0, 0, 1, 1]],
      ),
      multiPolygonFeature(
        { NAME: "Lombardy", SUBJECTO: "3", BORDERPRECISION: 0 },
        [[2, 2, 3, 3]],
      ),
      multiPolygonFeature({ NAME: "Venice", SUBJECTO: "Venice" }, [[
        4,
        4,
        5,
        5,
      ]]),
    ],
  };
  const fixes = [{
    years: [1783],
    name: "Lombardy",
    set: { SUBJECTO: "Lombardy", BORDERPRECISION: 3 },
  }];

  const result = applyPropertyFixes(fc, 1783, fixes);

  for (const index of [0, 1]) {
    assertEquals(result.features[index].properties?.SUBJECTO, "Lombardy");
    assertEquals(result.features[index].properties?.BORDERPRECISION, 3);
  }
  // 対象外の feature は素通しする
  assertEquals(result.features[2].properties?.SUBJECTO, "Venice");
});

Deno.test("applyPropertyFixes は対象年以外に適用しない（TASK-102）", () => {
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      multiPolygonFeature({ NAME: "Lombardy", SUBJECTO: "3" }, [[0, 0, 1, 1]]),
    ],
  };
  const fixes = [{
    years: [1783],
    name: "Lombardy",
    set: { SUBJECTO: "Lombardy" },
  }];

  assertEquals(
    applyPropertyFixes(fc, 1800, fixes).features[0].properties?.SUBJECTO,
    "3",
  );
});

Deno.test("applyPropertyFixes は当たらなかった上書きを警告する（TASK-102）", () => {
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [multiPolygonFeature({ NAME: "Venice" }, [[0, 0, 1, 1]])],
  };
  const warnings: string[] = [];

  applyPropertyFixes(
    fc,
    1783,
    [{ years: [1783], name: "Lombardy", set: { SUBJECTO: "Lombardy" } }],
    (message) => warnings.push(message),
  );

  assertEquals(warnings.length, 1);
  assert(warnings[0].includes("Lombardy"));
});

Deno.test("normalizeSubjectProps は空の SUBJECTO / PARTOF を NAME で埋める（TASK-102）", () => {
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      multiPolygonFeature({ NAME: "Sweden", SUBJECTO: "", PARTOF: null }, [[
        0,
        0,
        1,
        1,
      ]]),
      multiPolygonFeature(
        { NAME: "Britany", SUBJECTO: "France", PARTOF: "France" },
        [[2, 2, 3, 3]],
      ),
      // NAME が無い feature（上流がどの勢力にも帰属させていない土地）は対象外
      multiPolygonFeature({ NAME: null, SUBJECTO: null, PARTOF: null }, [[
        4,
        4,
        5,
        5,
      ]]),
    ],
  };

  const result = normalizeSubjectProps(fc);

  assertEquals(result.features[0].properties?.SUBJECTO, "Sweden");
  assertEquals(result.features[0].properties?.PARTOF, "Sweden");
  assertEquals(result.features[1].properties?.SUBJECTO, "France");
  assertEquals(result.features[2].properties?.SUBJECTO, null);
  assertEquals(result.features[2].properties?.NAME, null);
});

Deno.test("normalizeSubjectProps は色キーを変えない（TASK-102）", () => {
  // 空 → 自己参照は表示上の意味を変えない、が normalizeSubjectProps の前提。
  const empty = { NAME: "Sweden", SUBJECTO: "", PARTOF: null };
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [multiPolygonFeature(empty, [[0, 0, 1, 1]])],
  };

  assertEquals(
    colorKeyFor(normalizeSubjectProps(fc).features[0].properties),
    colorKeyFor(empty),
  );
});

Deno.test("buildIndex は年一覧と出典メタを返す", () => {
  const source = { repo: "r", commit: "c", license: "GPL-3.0" };
  assertEquals(buildIndex([1000, 1100], source), {
    years: [1000, 1100],
    source: { repo: "r", commit: "c", license: "GPL-3.0" },
  });
});

Deno.test("shrinkToLimit は limit 以下になる最小トレランスの結果を返す", () => {
  // ぎざぎざの多点ポリゴンを作る
  const ring: number[][] = [];
  for (let i = 0; i <= 200; i++) {
    const x = i * 0.01;
    const y = (i % 2 === 0 ? 0 : 0.001) + Math.sin(i) * 0.0001;
    ring.push([x, y]);
  }
  ring.push([2, -1]);
  ring.push([0, -1]);
  ring.push([0, 0]);
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { NAME: "jagged" },
      geometry: { type: "Polygon", coordinates: [ring] },
    }],
  };

  const large = shrinkToLimit(fc, 1_000_000);
  assertEquals(large.tolerance, SIMPLIFY_TOLERANCES[0]);
  assert(large.size <= 1_000_000);
  assert(
    new TextEncoder().encode(JSON.stringify(large.fc)).length <= 1_000_000,
  );

  // 現実的な小さめ limit ではより大きいトレランスが選ばれ、なお limit 以下
  const small = shrinkToLimit(fc, 3_000);
  assert(small.size <= 3_000);
  assert(SIMPLIFY_TOLERANCES.includes(small.tolerance));
});

Deno.test("shrinkToLimit は座標を COORD_PRECISION（小数3桁）に丸める", () => {
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { NAME: "precise" },
      geometry: {
        type: "Polygon",
        coordinates: [[
          [1.123456789, 2.987654321],
          [3.111111111, 4.0],
          [5.0, 6.222222222],
          [1.123456789, 2.987654321],
        ]],
      },
    }],
  };
  const result = shrinkToLimit(fc, 1_000_000);
  const geometry = result.fc.features[0].geometry as Polygon;
  // 先頭頂点が小数3桁へ丸められている（1.123456789 → 1.123、2.987654321 → 2.988）
  assertEquals(geometry.coordinates[0][0], [1.123, 2.988]);
  // 全頂点が 10^-COORD_PRECISION のグリッド上にある（それ以上の桁が残らない）
  const scale = 10 ** COORD_PRECISION;
  for (const [x, y] of geometry.coordinates[0]) {
    assert(Number.isInteger(Math.round(x * scale * 1e6) / 1e6), `x=${x}`);
    assert(Number.isInteger(Math.round(y * scale * 1e6) / 1e6), `y=${y}`);
  }
});

Deno.test("COORD_PRECISION は MAX_ZOOM の 1 ピクセル相当距離に対し過不足がない", () => {
  // MapLibre のズーム z では世界全体が 512·2^z CSS px に写るため、
  // 1 px ≈ 赤道周長 / (512·2^z) · cos(緯度) メートル。
  const EQUATOR_M = 40_075_016.686;
  const northLat = EUROPE_BBOX[3]; // ヨーロッパ bbox の最高緯度（px が最も細かい）
  const metersPerPixel = EQUATOR_M / (512 * 2 ** MAX_ZOOM) *
    Math.cos((northLat * Math.PI) / 180);
  // 丸め誤差の最大は緯度方向のグリッド半分（経度方向は cos(緯度) 倍で常に小さい）
  const maxRoundingErrorM = 111_320 * 10 ** -COORD_PRECISION / 2;
  // 採用桁数: 丸め誤差が最悪ケース（bbox 北端・ズーム上限）でも 1 px 未満
  assert(
    maxRoundingErrorM < metersPerPixel,
    `丸め誤差 ${maxRoundingErrorM}m が 1px ${metersPerPixel}m を超えている`,
  );
  // 1 桁減らすと 1 px を超える（= これ以上桁を落とせない下限であること）
  const coarserErrorM = 111_320 * 10 ** -(COORD_PRECISION - 1) / 2;
  assert(
    coarserErrorM >= metersPerPixel,
    `1 桁粗い ${coarserErrorM}m でも 1px 未満なら、さらに桁を落とせるはず`,
  );
});

Deno.test("shrinkToLimit はどのトレランスでも収まらなければ例外を投げる", () => {
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { NAME: "x" },
      geometry: {
        type: "Polygon",
        coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
      },
    }],
  };
  assertThrows(() => shrinkToLimit(fc, 5));
});

// --- TASK-101: 半独立の封土を base から切り出す ---

/** 正方形 1 枚の Polygon feature */
function squareFeature(
  properties: Record<string, unknown>,
  [minX, minY, maxX, maxY]: [number, number, number, number],
): Feature<Polygon> {
  return {
    type: "Feature",
    properties,
    geometry: {
      type: "Polygon",
      coordinates: [[
        [minX, minY],
        [minX, maxY],
        [maxX, maxY],
        [maxX, minY],
        [minX, minY],
      ]],
    },
  };
}

const NORMANDY_SPLIT = {
  year: 1000,
  fromName: "Kingdom of France",
  fiefName: "Duchy of Normandy",
  subjecto: "Duchy of Normandy",
  fiefPath: "data/france_fiefs_flat_1000.geojson",
};

Deno.test("unionByName は同名 feature を 1 つに統合し、該当が無ければ null", () => {
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      squareFeature({ NAME: "a" }, [0, 0, 1, 1]),
      squareFeature({ NAME: "a" }, [1, 0, 2, 1]),
      squareFeature({ NAME: "b" }, [5, 5, 6, 6]),
    ],
  };
  const merged = unionByName(fc, "a");
  assert(merged !== null);
  assert(booleanPointInPolygon([0.5, 0.5], merged));
  assert(booleanPointInPolygon([1.5, 0.5], merged));
  assertEquals(unionByName(fc, "z"), null);
});

Deno.test("mergeBasePower は source を target の名目枠へ統合して他勢力を保つ", () => {
  const england = squareFeature({ NAME: "England" }, [5, 0, 6, 1]);
  const base: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      squareFeature({ NAME: "Kingdom of France", SUBJECTO: "France" }, [
        0,
        0,
        1,
        1,
      ]),
      squareFeature({ NAME: "Britany", SUBJECTO: "Britany" }, [-1, 0, 0, 1]),
      england,
    ],
  };
  const result = mergeBasePower(base, BASE_POWER_MERGES[0]);
  assertEquals(result.features.map((f) => f.properties?.NAME), [
    "Kingdom of France",
    "England",
  ]);
  const france = result.features[0] as Feature<Polygon | MultiPolygon>;
  assert(booleanPointInPolygon([0.5, 0.5], france));
  assert(booleanPointInPolygon([-0.5, 0.5], france));
  assertEquals(france.properties?.SUBJECTO, "France");
  assertEquals(result.features[1], england);
});

Deno.test("mergeBasePower は target または source が無ければ警告して入力を保つ", () => {
  const base: FeatureCollection = {
    type: "FeatureCollection",
    features: [squareFeature({ NAME: "Kingdom of France" }, [0, 0, 1, 1])],
  };
  const warnings: string[] = [];
  assertEquals(
    mergeBasePower(
      base,
      BASE_POWER_MERGES[0],
      (message) => warnings.push(message),
    ),
    base,
  );
  assertEquals(warnings.length, 1);
});

Deno.test("splitFiefFromBase は封土を切り出して独立 feature を立てる", () => {
  const base: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      squareFeature({ NAME: "Kingdom of France", SUBJECTO: "France" }, [
        0,
        0,
        10,
        10,
      ]),
      squareFeature({ NAME: "England", SUBJECTO: "England" }, [
        -5,
        12,
        -1,
        16,
      ]),
    ],
  };
  // base をはみ出す区画（北へ 2 度はみ出す）を渡し、交差だけが使われることを見る
  const fief = squareFeature({ NAME: "Duchy of Normandy" }, [1, 8, 4, 12]);
  const result = splitFiefFromBase(base, fief, NORMANDY_SPLIT);

  const normandy = result.features.find((f) =>
    f.properties?.NAME === "Duchy of Normandy"
  );
  assert(normandy !== undefined, "封土の feature が立っていない");
  // 独立勢力として扱う（SUBJECTO が NAME 自身）
  assertEquals(normandy.properties?.SUBJECTO, "Duchy of Normandy");
  assert(booleanPointInPolygon([2, 9], normandy as Feature<Polygon>));
  // base の外へははみ出さない
  assert(!booleanPointInPolygon([2, 11], normandy as Feature<Polygon>));

  const france = result.features.find((f) =>
    f.properties?.NAME === "Kingdom of France"
  );
  assert(france !== undefined);
  assert(
    !booleanPointInPolygon([2, 9], france as Feature<Polygon>),
    "王国側から封土が差し引かれていない",
  );
  assert(
    booleanPointInPolygon([8, 9], france as Feature<Polygon>),
    "王国の残りの領域が失われている",
  );

  // 他勢力は一切変えない
  assertEquals(
    result.features.find((f) => f.properties?.NAME === "England"),
    base.features[1],
  );
  // 封土は切り出し元の直後（決定的な並び）
  assertEquals(result.features.map((f) => f.properties?.NAME), [
    "Kingdom of France",
    "Duchy of Normandy",
    "England",
  ]);
});

Deno.test("splitFiefFromBase は丸ごと封土になった飛び地を落とす", () => {
  const base: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      squareFeature({ NAME: "Kingdom of France" }, [0, 0, 2, 2]),
      squareFeature({ NAME: "Kingdom of France" }, [5, 5, 7, 7]),
    ],
  };
  const fief = squareFeature({ NAME: "Duchy of Normandy" }, [4, 4, 8, 8]);
  const result = splitFiefFromBase(base, fief, NORMANDY_SPLIT);
  assertEquals(result.features.map((f) => f.properties?.NAME), [
    "Kingdom of France",
    "Duchy of Normandy",
  ]);
});

Deno.test("mergeSeveredRemainders は切り出しで分断された残余を隣接勢力へ併合する（#342）", () => {
  // 元勢力は 1 枚の連結ポリゴン（[0,10]×[0,10]）＋遠方の飛び地。封土の帯
  // （[3,5]×[-1,11]）が本体を左右に分断し、小さい左側（[0,3]）が本体から
  // 切り離される。左側は封土を跨がないと本体へ行けない = 上流が封土の外まで
  // 塗り過ぎた分なので、境界を最も長く共有する隣接勢力へ併合する。
  const base: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      multiPolygonFeature({ NAME: "Kingdom of France" }, [
        [0, 0, 10, 10],
        [20, 20, 22, 22],
      ]),
      // 左辺全体（長さ 10）を分断された成分と共有する
      squareFeature({ NAME: "England" }, [-4, 0, 0, 10]),
      // 下辺の一部（長さ 3）しか共有しない = 併合先にはならない
      squareFeature({ NAME: "Brittany" }, [0, -4, 3, 0]),
    ],
  };
  const fief = squareFeature({ NAME: "Duchy of Normandy" }, [3, -1, 5, 11]);
  const result = mergeSeveredRemainders(
    base,
    splitFiefFromBase(base, fief, NORMANDY_SPLIT),
    NORMANDY_SPLIT.year,
    console.warn,
    [NORMANDY_SPLIT],
  );

  const france = result.features.find((f) =>
    f.properties?.NAME === "Kingdom of France"
  ) as Feature<Polygon | MultiPolygon>;
  assert(france !== undefined);
  assert(
    !booleanPointInPolygon([1, 5], france),
    "分断された成分が元勢力に残っている",
  );
  assert(
    booleanPointInPolygon([8, 5], france),
    "元勢力の本体が失われている",
  );
  // 切り出しと無関係な飛び地（元から別ポリゴン）は残す
  assert(
    booleanPointInPolygon([21, 21], france),
    "切り出しと無関係な飛び地が落ちている",
  );

  const england = result.features.find((f) =>
    f.properties?.NAME === "England"
  ) as Feature<Polygon | MultiPolygon>;
  assert(
    booleanPointInPolygon([1, 5], england),
    "分断された成分が最長の境界を共有する隣接勢力へ併合されていない",
  );
  const brittany = result.features.find((f) =>
    f.properties?.NAME === "Brittany"
  ) as Feature<Polygon | MultiPolygon>;
  assert(
    !booleanPointInPolygon([1, 5], brittany),
    "共有境界が短い側へ併合されている",
  );
  // 封土自身は「オーバーレイの区画 ∩ 元勢力」のまま広げない
  const normandy = result.features.find((f) =>
    f.properties?.NAME === "Duchy of Normandy"
  ) as Feature<Polygon | MultiPolygon>;
  assert(!booleanPointInPolygon([1, 5], normandy));
});

Deno.test("mergeSeveredRemainders は隣接勢力が無い分断残余を警告して落とす（#342）", () => {
  const base: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      squareFeature({ NAME: "Kingdom of France" }, [0, 0, 10, 10]),
    ],
  };
  const warnings: string[] = [];
  const fief = squareFeature({ NAME: "Duchy of Normandy" }, [3, -1, 5, 11]);
  const result = mergeSeveredRemainders(
    base,
    splitFiefFromBase(base, fief, NORMANDY_SPLIT),
    NORMANDY_SPLIT.year,
    (m) => warnings.push(m),
    [NORMANDY_SPLIT],
  );
  const france = result.features.find((f) =>
    f.properties?.NAME === "Kingdom of France"
  ) as Feature<Polygon | MultiPolygon>;
  assert(!booleanPointInPolygon([1, 5], france));
  assert(booleanPointInPolygon([8, 5], france));
  assertEquals(warnings.length, 1);
});

Deno.test("splitFiefFromBase は切り出せないとき警告して base をそのまま返す", () => {
  const base: FeatureCollection = {
    type: "FeatureCollection",
    features: [squareFeature({ NAME: "Kingdom of France" }, [0, 0, 2, 2])],
  };
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);

  // 交差しない区画
  const apart = squareFeature({ NAME: "Duchy of Normandy" }, [20, 20, 21, 21]);
  assertEquals(splitFiefFromBase(base, apart, NORMANDY_SPLIT, warn), base);

  // 切り出し元が存在しない
  const other: FeatureCollection = {
    type: "FeatureCollection",
    features: [squareFeature({ NAME: "England" }, [0, 0, 2, 2])],
  };
  const fief = squareFeature({ NAME: "Duchy of Normandy" }, [0, 0, 1, 1]);
  assertEquals(splitFiefFromBase(other, fief, NORMANDY_SPLIT, warn), other);
  assertEquals(warnings.length, 2);
});

Deno.test("1000/1100 のノルマンディーは切り出さず、Britany を France へ統合する", () => {
  const normandy = BASE_FIEF_SPLITS.filter(
    (s) => s.fiefName === "Duchy of Normandy",
  );
  assertEquals(normandy, []);
  assertEquals(BASE_POWER_MERGES, [
    { year: 1000, targetName: "Kingdom of France", sourceName: "Britany" },
    { year: 1100, targetName: "Kingdom of France", sourceName: "Britany" },
  ]);
});

Deno.test("BASE_FIEF_SPLITS は 1279/1300 の帝国塗り封土を正しい宗主で切り出す（TASK-124）", () => {
  // 上流 base が Holy Roman Empire の単一ポリゴンに含めて塗っている
  // 仏封土（Artois / Saint-Pol / Flanders）とリミニを切り出す。宗主の確定は
  // propertyFixes（data/name-overrides.json）が後段で行うが、切り出し直後から
  // 正しい宗主を持つよう subjecto にも同じ値を宣言する。
  const carved = BASE_FIEF_SPLITS.filter(
    (s) => s.fromName === "Holy Roman Empire",
  );
  const expected: Array<[number, string, string, string]> = [
    [
      1279,
      "Counts of Saint-Pol",
      "France",
      "data/france_fiefs_flat_1279.geojson",
    ],
    [1279, "County of Artois", "France", "data/france_fiefs_flat_1279.geojson"],
    [
      1279,
      "County of Flanders",
      "France",
      "data/france_fiefs_flat_1279.geojson",
    ],
    [
      1300,
      "Counts of Saint-Pol",
      "France",
      "data/france_fiefs_flat_1300.geojson",
    ],
    [1300, "County of Artois", "France", "data/france_fiefs_flat_1300.geojson"],
    [
      1300,
      "County of Flanders",
      "France",
      "data/france_fiefs_flat_1300.geojson",
    ],
    [
      1300,
      "Lordship of Rimini",
      "Papal States",
      "data/italy_fiefs_flat_1300.geojson",
    ],
  ];
  assertEquals(
    carved
      .map((
        s,
      ): [number, string, string, string] => [
        s.year,
        s.fiefName,
        s.subjecto,
        s.fiefPath,
      ])
      .sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1], "en")),
    expected,
  );
});

/** ノルマンディー公領の内陸点（簡略化後も内側に残る位置を選ぶ） */
const NORMANDY_POINTS: Array<[string, [number, number]]> = [
  ["ルーアン", [1.10, 49.44]],
  ["カーン", [-0.37, 49.18]],
  ["バイユー", [-0.70, 49.28]],
  ["リジュー", [0.23, 49.15]],
];

/** 上流で独立 Britany feature になっていたブルターニュ西部の点 */
const BRITTANY_POINTS: Array<[string, [number, number]]> = [
  ["ブレスト", [-4.49, 48.39]],
  ["カンペール", [-4.10, 48.00]],
  ["ロリアン", [-3.37, 47.75]],
];

/** フランス王領（ノルマンディー外）の点 */
const FRANCE_POINTS: Array<[string, [number, number]]> = [
  ["パリ", [2.35, 48.85]],
  ["オルレアン", [1.90, 47.90]],
  ["ブールジュ", [2.40, 47.08]],
];

/** イングランドの点 */
const ENGLAND_POINTS: Array<[string, [number, number]]> = [
  ["ロンドン", [-0.12, 51.51]],
  ["ヨーク", [-1.08, 53.96]],
];

function readBase(year: number): FeatureCollection {
  return JSON.parse(
    Deno.readTextFileSync(`data/europe_${year}.geojson`),
  ) as FeatureCollection;
}

function namesAt(
  fc: FeatureCollection,
  point: [number, number],
): string[] {
  return fc.features
    .filter((f) =>
      f.geometry !== null &&
      (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon") &&
      booleanPointInPolygon(point, f as Feature<Polygon | MultiPolygon>)
    )
    .map((f) => String(f.properties?.NAME));
}

for (const year of [1000, 1100]) {
  Deno.test(`${year} 年の base はノルマンディー・ブルターニュをフランス王国の名目枠に含める`, () => {
    const base = readBase(year);
    for (const [label, point] of [...NORMANDY_POINTS, ...BRITTANY_POINTS]) {
      const names = namesAt(base, point);
      assert(
        names.includes("Kingdom of France"),
        `${label} が Kingdom of France に含まれていない: ${names.join(", ")}`,
      );
    }
  });

  Deno.test(`${year} 年の base に Normandy / Britany の独立 feature は残らない`, () => {
    const base = readBase(year);
    assertEquals(
      base.features.filter((f) =>
        ["Duchy of Normandy", "Britany"].includes(String(f.properties?.NAME))
      ).length,
      0,
    );
  });

  Deno.test(`${year} 年の base はフランス王国とイングランドの他領域を保つ`, () => {
    const base = readBase(year);
    for (const [label, point] of FRANCE_POINTS) {
      const names = namesAt(base, point);
      assert(
        names.includes("Kingdom of France"),
        `${label} が Kingdom of France から失われた: ${names.join(", ")}`,
      );
    }
    for (const [label, point] of ENGLAND_POINTS) {
      const names = namesAt(base, point);
      assert(
        names.includes("England"),
        `${label} が England から失われた: ${names.join(", ")}`,
      );
      assert(!names.includes("Kingdom of France"));
    }
  });

  Deno.test(`${year} 年の諸侯領オーバーレイに Normandy / Brittany が残る`, () => {
    const fiefs = JSON.parse(
      Deno.readTextFileSync(`data/france_fiefs_flat_${year}.geojson`),
    ) as FeatureCollection;
    const names = new Set(fiefs.features.map((f) => f.properties?.NAME));
    assert(names.has("Duchy of Normandy"));
    assert(names.has("Duchy of Brittany"));
  });
}

Deno.test("切り出しの対象外年（1200）の base には Duchy of Normandy を作らない", () => {
  const base = readBase(1200);
  assertEquals(
    base.features.filter((f) => f.properties?.NAME === "Duchy of Normandy")
      .length,
    0,
  );
});

Deno.test("BASE_FIEF_SPLITS は 1100/1200 のポーランド塗りボヘミア・モラヴィアを帝国封土として切り出す（TASK-157 / #346）", () => {
  // 上流 base の 1100 / 1200 年はボヘミア・モラヴィア一帯を単一の Poland
  // ポリゴンに塗り込めている（史実では 1100 年は帝国内のボヘミア公領、
  // 1200 年は帝国内のボヘミア王国）。1100 年は OHM の Duchy of Bohemia、
  // 1200 年は OHM の Moravia に加えて、#346 で Cliopatria の 1202–1215 区間を
  // 1200 年へ借用した Kingdom of Bohemia（ADR-0039）を切り出す。より細かい
  // OHM のモラヴィアを先に切り出し、借用面は flat の段階でそれを差し引いた
  // 残り（ADR-0035）なので、同じ土地を二度切り出すことにはならない。
  const carved = BASE_FIEF_SPLITS.filter((s) => s.fromName === "Poland");
  assertEquals(
    carved.map((
      s,
    ): [number, string, string, string] => [
      s.year,
      s.fiefName,
      s.subjecto,
      s.fiefPath,
    ]),
    [
      [
        1100,
        "Duchy of Bohemia",
        "Holy Roman Empire",
        "data/hre_fiefs_flat_1100.geojson",
      ],
      [
        1200,
        "Moravia",
        "Holy Roman Empire",
        "data/hre_fiefs_flat_1200.geojson",
      ],
      [
        1200,
        "Kingdom of Bohemia",
        "Holy Roman Empire",
        "data/cliopatria_fiefs_flat_1200.geojson",
      ],
    ],
  );
});

/** ボヘミア公領（1100 年の OHM 区画）の内陸点 */
const BOHEMIA_POINTS: Array<[string, [number, number]]> = [
  ["プラハ", [14.42, 50.08]],
  ["ブルノ", [16.61, 49.19]],
];

/** ポーランド本体の点（切り出しで失われてはいけない領域） */
const POLAND_POINTS: Array<[string, [number, number]]> = [
  ["クラクフ", [19.94, 50.06]],
  ["グニェズノ", [17.60, 52.53]],
];

Deno.test("1100 年の base はボヘミア・モラヴィアをポーランド領に含めない（TASK-157）", () => {
  const base = readBase(1100);
  for (const [label, point] of BOHEMIA_POINTS) {
    const names = namesAt(base, point);
    assert(
      !names.includes("Poland"),
      `${label} が Poland に含まれている: ${names.join(", ")}`,
    );
    assert(
      names.includes("Duchy of Bohemia"),
      `${label} が Duchy of Bohemia に含まれていない: ${names.join(", ")}`,
    );
  }
  const bohemia = base.features.filter((f) =>
    f.properties?.NAME === "Duchy of Bohemia"
  );
  assertEquals(bohemia.length, 1);
  // 帝国の封建諸侯領（宗主 = 神聖ローマ帝国）として立つ
  assertEquals(bohemia[0].properties?.SUBJECTO, "Holy Roman Empire");
  assertEquals(bohemia[0].properties?.PARTOF, "Holy Roman Empire");
  for (const [label, point] of POLAND_POINTS) {
    const names = namesAt(base, point);
    assert(
      names.includes("Poland"),
      `${label} が Poland から失われた: ${names.join(", ")}`,
    );
  }
});

Deno.test("1200 年の base はボヘミア王国とモラヴィアを別々の帝国封土として分離する（TASK-157 / #346）", () => {
  const base = readBase(1200);
  const brno: [number, number] = [16.61, 49.19];
  const brnoNames = namesAt(base, brno);
  assert(
    !brnoNames.includes("Poland"),
    `ブルノが Poland に含まれている: ${brnoNames.join(", ")}`,
  );
  assert(
    brnoNames.includes("Moravia"),
    `ブルノが Moravia に含まれていない: ${brnoNames.join(", ")}`,
  );
  // ブルノはモラヴィア辺境伯領のまま。借用したボヘミア王国とは二重に塗らない
  assert(
    !brnoNames.includes("Kingdom of Bohemia"),
    `ブルノが Kingdom of Bohemia と二重に塗られている: ${brnoNames.join(", ")}`,
  );
  const moravia = base.features.filter((f) => f.properties?.NAME === "Moravia");
  assertEquals(moravia.length, 1);
  assertEquals(moravia[0].properties?.SUBJECTO, "Holy Roman Empire");
  assertEquals(moravia[0].properties?.PARTOF, "Holy Roman Empire");
  // ボヘミア本体（プラハ）は Cliopatria の 1202–1215 区画を 1200 年へ借用して
  // 切り出す（ADR-0039）。ポーランド塗りには残らない
  const pragueNames = namesAt(base, [14.42, 50.08]);
  assert(
    !pragueNames.includes("Poland"),
    `プラハが Poland に含まれている: ${pragueNames.join(", ")}`,
  );
  assert(
    pragueNames.includes("Kingdom of Bohemia"),
    `プラハが Kingdom of Bohemia に含まれていない: ${pragueNames.join(", ")}`,
  );
  const bohemia = base.features.filter((f) =>
    f.properties?.NAME === "Kingdom of Bohemia"
  );
  assertEquals(bohemia.length, 1);
  assertEquals(bohemia[0].properties?.SUBJECTO, "Holy Roman Empire");
  assertEquals(bohemia[0].properties?.PARTOF, "Holy Roman Empire");
  // 勢力圏の外枠（suzerain_extent.ts）は宗主キーの union なので、宗主が同年に
  // 勢力として実在しないと外枠がボヘミア王国を含めない
  assert(
    base.features.some((f) => f.properties?.NAME === "Holy Roman Empire"),
    "1200 年に Holy Roman Empire が勢力として存在しない",
  );
  // 1100 年の称号（公領）は 1200 年に残さない
  assertEquals(
    base.features.filter((f) => f.properties?.NAME === "Duchy of Bohemia")
      .length,
    0,
  );
  for (const [label, point] of POLAND_POINTS) {
    const names = namesAt(base, point);
    assert(
      names.includes("Poland"),
      `${label} が Poland から失われた: ${names.join(", ")}`,
    );
  }
});

// ---------------------------------------------------------------------------
// #376: 借用したボヘミア王国がモラヴィアより南へはみ出さない
//
// 上流 Cliopatria の cz_bohemian_k_1 は OHM のモラヴィア辺境伯領より粗く、
// 南（ターヤ川以南の下オーストリア）へはみ出す。差し引きの残りがボヘミア本体
// から切り離された帯として残ると、(a) ウィーン北方が「ボヘミア王国」として
// 塗られ・pick され、(b) その帯の南縁に z8 で 1px の未塗装スリバーが出る。
// ---------------------------------------------------------------------------

/** 起票時の帯（ウィーン北方の下オーストリア、298.3 km²）の内点 */
const BOHEMIA_DETACHED_BAND_POINT: [number, number] = [16.5, 48.78];

/** 起票時の分離パート 5 件の bbox（#376 の表） */
const BOHEMIA_DETACHED_BBOXES: Array<[number, number, number, number]> = [
  [16.110, 48.720, 16.892, 48.814],
  [17.030, 48.747, 17.246, 48.875],
  [18.132, 49.190, 18.231, 49.293],
  [17.905, 48.976, 17.977, 49.026],
  [15.799, 48.811, 15.956, 48.877],
];

Deno.test("#376: 1200 年のボヘミア王国はボヘミア本体から分離した帯を持たない", () => {
  const base = readBase(1200);
  const bohemia = base.features.filter((f) =>
    f.properties?.NAME === "Kingdom of Bohemia"
  );
  assertEquals(bohemia.length, 1);
  const geometry = bohemia[0].geometry as Polygon | MultiPolygon;
  const parts = geometry.type === "Polygon"
    ? [geometry.coordinates]
    : geometry.coordinates;
  // ボヘミア本体（プラハを含む最大成分）だけが残る
  assertEquals(
    parts.length,
    1,
    `ボヘミア本体から分離したパートが ${parts.length - 1} 件残っている: ` +
      parts.map((p) => `${areaKm2(turfPolygonOf(p)).toFixed(1)} km²`).join(
        ", ",
      ),
  );
  assert(
    booleanPointInPolygon([14.42, 50.08], bohemia[0] as Feature<Polygon>),
    "プラハがボヘミア王国から失われた",
  );
  // 帯（ウィーン北方の下オーストリア）は「ボヘミア王国」として塗られない
  const names = namesAt(base, BOHEMIA_DETACHED_BAND_POINT);
  assert(
    !names.includes("Kingdom of Bohemia"),
    `ウィーン北方の帯が Kingdom of Bohemia のまま: ${names.join(", ")}`,
  );
  // 起票時の 5 パートの bbox 中心はいずれもボヘミア王国に含まれない
  for (const [west, south, east, north] of BOHEMIA_DETACHED_BBOXES) {
    const center: [number, number] = [(west + east) / 2, (south + north) / 2];
    assert(
      !booleanPointInPolygon(center, bohemia[0] as Feature<Polygon>),
      `分離パート ${west},${south},${east},${north} が残っている`,
    );
  }
});

Deno.test("#376: 1200 年のモラヴィア／下オーストリア境に細長い未塗装スリバーが残らない", () => {
  // 起票時の実測: 8.649 km²・平均幅 166 m のスリバーが 16.180–16.889 /
  // 48.717–48.720（帯の南縁、ターヤ川沿い）に残り、z8 で 1px のクリーム色の
  // 地形が線状に露出していた。z7 以下では不可視。
  // NO_TILING_DEG（現状の既定と同じだが明示する）: 起票時の実測はタイル分割
  // なしで採ったもので、分割すると面積がわずかに動く。閾値がその差より十分
  // 大きいので分割しても結論は変わらないが、測り方を固定しておく
  const gaps = unpaintedGapsIn(readBase(1200), [16.1, 48.70, 17.0, 48.90], {
    tileDegrees: NO_TILING_DEG,
  });
  const slivers = gaps.filter((g) => g.areaKm2 >= 0.01 && g.meanWidthM < 1_000);
  assertEquals(
    slivers.map((g) =>
      `${g.areaKm2.toFixed(3)} km² / 幅 ${g.meanWidthM.toFixed(0)} m`
    ),
    [],
    "モラヴィア／下オーストリア境に幅 1 km 未満の未塗装スリバーが残っている",
  );
});

// ---------------------------------------------------------------------------
// #378: 借用したボヘミア王国が東（ベスキディ方面）でハンガリーと食い違う
//
// 借用元 cz_bohemian_k_1 の東端（東経 18.716 度）は、別出典
// （historical-basemaps）のハンガリーの外周を越える。BASE_FIEF_SPLITS は
// ポーランドからしか切り出さないので base の塗りはハンガリーのまま残るが、
// Cliopatria の領邦オーバーレイは同じ土地をボヘミア王国として覆う。座標を
// 編集せずに解消できないため是正せず、known-limitations.json で開示する。
// ここでは開示した実測値が配信データとずれたら落ちるよう固定する。
// ---------------------------------------------------------------------------

/** 諸侯領オーバーレイ（flat）を読む */
function readFlatFiefs(path: string): FeatureCollection {
  return JSON.parse(Deno.readTextFileSync(path)) as FeatureCollection;
}

/** feature の全頂点の bbox（west, south, east, north） */
function bboxOfFeature(feature: Feature): [number, number, number, number] {
  const geometry = feature.geometry as Polygon | MultiPolygon;
  const parts = geometry.type === "Polygon"
    ? [geometry.coordinates]
    : geometry.coordinates;
  const positions = parts.flat(2) as unknown as number[][];
  const xs = positions.map((p) => p[0]);
  const ys = positions.map((p) => p[1]);
  return [
    Math.min(...xs),
    Math.min(...ys),
    Math.max(...xs),
    Math.max(...ys),
  ];
}

Deno.test("#378: 1200 年のボヘミアの東方はみ出しは開示した実測どおりの範囲に留まる", () => {
  const base = readBase(1200);
  const overlay = readFlatFiefs("data/cliopatria_fiefs_flat_1200.geojson");
  const named = (fc: FeatureCollection, name: string) => {
    const found = fc.features.filter((f) => f.properties?.NAME === name);
    assertEquals(found.length, 1, `${name} が 1 件でない`);
    return found[0] as Feature<Polygon | MultiPolygon>;
  };
  const baseBohemia = named(base, "Kingdom of Bohemia");
  const overlayBohemia = named(overlay, "Kingdom of Bohemia");
  const hungary = named(base, "Hungary");
  const poland = named(base, "Poland");

  // 借用元の東端は base の切り出し結果より東にある（= はみ出している）
  assertEquals(bboxOfFeature(baseBohemia)[2].toFixed(3), "18.639");
  assertEquals(bboxOfFeature(overlayBohemia)[2].toFixed(3), "18.716");

  // オーバーレイがハンガリーの塗りに重なる面積と範囲（開示した数値）
  const overHungary = intersect(
    featureCollection([overlayBohemia, hungary]),
  );
  assert(overHungary !== null, "オーバーレイとハンガリーが重なっていない");
  assertEquals(areaKm2(overHungary).toFixed(1), "123.3");
  assertEquals(
    bboxOfFeature(overHungary).map((v) => v.toFixed(3)),
    ["18.452", "49.464", "18.716", "49.579"],
  );

  // base 側の塗りは重なっていない（二重塗りは base では起きていない）
  const neighbours = [
    ["ハンガリー", hungary],
    ["ポーランド", poland],
  ] as const;
  for (const [label, other] of neighbours) {
    const overlap = intersect(featureCollection([baseBohemia, other]));
    const km2 = overlap === null ? 0 : areaKm2(overlap);
    assert(
      km2 < 1,
      `base のボヘミア王国と${label}が ${km2.toFixed(3)} km² 重なっている`,
    );
  }

  // ボヘミア王国とポーランドの間に残る帰属未詳の空白（#352 の外周置換で生じた
  // 「どの勢力にも属さない空白」の一部）。開示した面積と一致することを固定する
  // NO_TILING_DEG（現状の既定と同じだが明示する）: known-limitations.json が
  // 「約22.9km²」として開示している実測はタイル分割なしで採ったもの。分割すると
  // 22.7 km² になり開示と食い違うので、ここでは測り方を固定する
  // （どちらの尺度で開示するかは #390 の範囲外・別 Issue）
  const gaps = unpaintedGapsIn(base, [18.3, 49.5, 18.7, 49.9], {
    tileDegrees: NO_TILING_DEG,
  })
    .filter((g) => g.areaKm2 >= 0.05)
    .sort((a, b) => b.areaKm2 - a.areaKm2);
  assertEquals(gaps[0].areaKm2.toFixed(1), "22.9");
});

/**
 * 切り出しで元勢力から分断された残余（#342）。
 *
 * 上流の base 勢力は隙間なく塗り分けられているため、分断された成分をただ
 * 落とすと base に穴が空く。切り出し（splitFiefFromBase）は最大成分以外を
 * 「封土を跨がないと本体へ行けない = 上流が封土の外まで塗り過ぎた分」とみなし、
 * 境界を最も長く共有する隣接勢力へ併合する。ここでは生成物側でその結果を固定する
 * （実測点は Issue #342 と、同じ規則が効く他年代の残余から採った）。
 */
const SEVERED_REMAINDER_POINTS: ReadonlyArray<{
  year: number;
  label: string;
  point: [number, number];
  from: string;
  to: string;
}> = [
  // 1100 Poland − Duchy of Bohemia: ボヘミアの西〜南を回り込む三日月（18197 km²）
  {
    year: 1100,
    label: "オーバープファルツ",
    point: [12.5, 49.6],
    from: "Poland",
    to: "Holy Roman Empire",
  },
  {
    year: 1100,
    label: "バイエルンの森",
    point: [13.0, 49.0],
    from: "Poland",
    to: "Holy Roman Empire",
  },
  {
    year: 1100,
    label: "上オーストリア",
    point: [14.5, 48.4],
    from: "Poland",
    to: "Holy Roman Empire",
  },
  {
    year: 1100,
    label: "オーストリア辺境伯領",
    point: [16.2, 48.55],
    from: "Poland",
    to: "Holy Roman Empire",
  },
  // 1100 / 1200 の同型残片: モラヴィア南東（西スロヴァキア。837 / 804 km²）
  {
    year: 1100,
    label: "西スロヴァキア",
    point: [18.0, 49.0],
    from: "Poland",
    to: "Hungary",
  },
  {
    year: 1200,
    label: "西スロヴァキア",
    point: [18.0, 49.0],
    from: "Poland",
    to: "Hungary",
  },
  // 1279 / 1300 Holy Roman Empire − County of Artois / County of Flanders
  {
    year: 1279,
    label: "アルトワ西方",
    point: [1.835, 50.253],
    from: "Holy Roman Empire",
    to: "France",
  },
  {
    year: 1300,
    label: "アルトワ西方",
    point: [1.835, 50.253],
    from: "Holy Roman Empire",
    to: "France",
  },
  {
    year: 1279,
    label: "ブローニュ",
    point: [1.807, 50.682],
    from: "Holy Roman Empire",
    to: "France",
  },
  {
    year: 1300,
    label: "ブローニュ",
    point: [1.807, 50.682],
    from: "Holy Roman Empire",
    to: "France",
  },
];

Deno.test("切り出しで分断された残余は元勢力に残らず隣接勢力へ併合される（#342）", () => {
  const wrong: string[] = [];
  for (const expected of SEVERED_REMAINDER_POINTS) {
    const names = namesAt(readBase(expected.year), expected.point);
    if (names.includes(expected.from)) {
      wrong.push(
        `${expected.year} ${expected.label}(${
          expected.point.join(",")
        }) が ${expected.from} に残っている: ${names.join(", ")}`,
      );
    }
    if (!names.includes(expected.to)) {
      wrong.push(
        `${expected.year} ${expected.label}(${
          expected.point.join(",")
        }) が ${expected.to} に併合されていない: ${names.join(", ")}`,
      );
    }
  }
  assertEquals(wrong, []);
});

Deno.test("1100 年の Poland は切り出しによる分断された成分を持たない（#342 / #352）", () => {
  // #342: 三日月は Poland の別ポリゴンとして残っていた。切り出し後の Poland は
  // 上流と同じく 1 枚の連結ポリゴンに戻っていた。
  // #352: 外周を Cliopatria の (Kingdom of Poland)［1056-1125］へ置換したので、
  // パート数は上流 Cliopatria のパート構成（バルト海沿岸の小島を含む）に従う。
  // 「切り出しの副作用で本土が割れていないこと」は最大パートが全体の 99% 超を
  // 占めることで確かめる（#342 が防いだのは面積が拮抗する分断だった）。
  const poland = readBase(1100).features.filter((f) =>
    f.properties?.NAME === "Poland"
  );
  assertEquals(poland.length, 1);
  const geometry = poland[0].geometry as Polygon | MultiPolygon;
  const parts = geometry.type === "Polygon"
    ? [geometry.coordinates]
    : geometry.coordinates;
  const areas = parts.map((rings) => area(turfPolygonOf(rings)));
  const total = areas.reduce((a, b) => a + b, 0);
  assert(
    Math.max(...areas) / total > 0.99,
    `本土以外のパートが大きすぎる: ${
      areas.map((a) => (a / 1e6).toFixed(0)).join(", ")
    } km²`,
  );
});

// ---------------------------------------------------------------------------
// #352 / ADR-0040: base 主権の外周を Cliopatria の複合体で置換する
// ---------------------------------------------------------------------------

Deno.test("#352: BASE_POWER_REPLACEMENTS は 6 年ぶんで、入力は Cliopatria の raw を指す", () => {
  assertEquals(
    BASE_POWER_REPLACEMENTS.filter((r) => r.year <= 1400).map((
      r,
    ): [number, string, string, string] => [
      r.year,
      r.fromName,
      r.sourcePath,
      r.sourceName,
    ]),
    [
      [
        1000,
        "Poland",
        "data/cliopatria_fiefs_1000.geojson",
        "(Kingdom of Poland)",
      ],
      [
        1100,
        "Poland",
        "data/cliopatria_fiefs_1100.geojson",
        "(Kingdom of Poland)",
      ],
      [
        1200,
        "Poland",
        "data/cliopatria_fiefs_1200.geojson",
        "(Duchies of Poland)",
      ],
      [
        1279,
        "Poland",
        "data/cliopatria_fiefs_1279.geojson",
        "(Duchies of Poland)",
      ],
      [
        1300,
        "Poland",
        "data/cliopatria_fiefs_1300.geojson",
        "(Duchies of Poland)",
      ],
      [
        1400,
        "Poland-Lithuania",
        "data/cliopatria_fiefs_1400.geojson",
        "(Polish-Lithuania Kingdom)",
      ],
    ],
  );
  // 許可リスト（ADR-0040）と 1 対 1 で対応する（片方だけ増えない）
  assertEquals(
    BASE_POWER_REPLACEMENTS.filter((r) => r.year <= 1400).map((
      r,
    ): [number, string] => [r.year, r.sourceName]),
    CLIOPATRIA_COMPOSITE_PARENTS.map((
      e,
    ): [number, string] => [e.targetYear, e.name]),
  );
  for (const r of BASE_POWER_REPLACEMENTS.filter((r) => r.year <= 1400)) {
    const entry = CLIOPATRIA_COMPOSITE_PARENTS.find((e) =>
      e.targetYear === r.year
    );
    assert(entry !== undefined, `${r.year} の許可リストが無い`);
    assertEquals(entry.basePowerName, r.fromName);
    assert(r.note.length > 0, `${r.year} の根拠が空`);
  }
});

Deno.test("#352: replaceBasePower は外周を入れ替え、はみ出しを隣接から差し引く", () => {
  const base: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      multiPolygonFeature({ NAME: "Poland" }, [[0, 0, 2, 1]]),
      multiPolygonFeature({ NAME: "Neighbour" }, [[2, 0, 4, 1]]),
      multiPolygonFeature({ NAME: "North" }, [[0, 1, 4, 2]]),
    ],
  };
  const replacement = multiPolygonFeature({}, [[1, 0, 3, 1]]) as Feature<
    MultiPolygon
  >;
  const warnings: string[] = [];
  const result = replaceBasePower(
    base,
    replacement,
    {
      year: 1200,
      fromName: "Poland",
      sourcePath: "x",
      sourceName: "y",
      note: "t",
    },
    (m) => warnings.push(m),
  );
  const byName = (name: string) =>
    result.features.filter((f) => f.properties?.NAME === name);
  // 置換した勢力は Cliopatria の外周そのものになる
  assertEquals(byName("Poland").length, 1);
  assertEquals(
    Math.round(areaKm2(byName("Poland")[0])),
    Math.round(areaKm2(replacement)),
  );
  // はみ出した [2,3] の帯は隣接から差し引かれる（同じ土地を二度塗らない）
  assert(
    !booleanPointInPolygon(
      [2.5, 0.5],
      byName("Neighbour")[0] as Feature<Polygon | MultiPolygon>,
    ),
    "隣接勢力からはみ出し分が差し引かれていない",
  );
  assert(
    booleanPointInPolygon(
      [3.5, 0.5],
      byName("Neighbour")[0] as Feature<Polygon | MultiPolygon>,
    ),
    "隣接勢力の残りまで削られている",
  );
  // 旧ポリゴンにしか無い [0,1] の帯は境界を最も長く共有する North へ併合する
  // （落として穴にすると、隙間なく塗り分けられた base に穴が見える）
  assert(
    booleanPointInPolygon(
      [0.5, 0.5],
      byName("North")[0] as Feature<Polygon | MultiPolygon>,
    ),
    "旧ポリゴンの残余が隣接へ併合されていない",
  );
  assertEquals(result.features.length, 3);
});

Deno.test("#352: retainedRemainders に載せた成分は置換した勢力へ残す", () => {
  const base: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      multiPolygonFeature({ NAME: "Poland" }, [[0, 0, 2, 1]]),
      multiPolygonFeature({ NAME: "North" }, [[0, 1, 4, 2]]),
    ],
  };
  const replacement = multiPolygonFeature({}, [[1, 0, 3, 1]]) as Feature<
    MultiPolygon
  >;
  const result = replaceBasePower(
    base,
    replacement,
    {
      year: 1279,
      fromName: "Poland",
      sourcePath: "x",
      sourceName: "y",
      note: "t",
      retainedRemainders: [{ point: [0.5, 0.5], reason: "歴史的にポーランド" }],
    },
    () => {},
  );
  const poland = result.features.find((f) => f.properties?.NAME === "Poland")!;
  // 旧外周にしか無い [0,1] の帯は隣接へ渡さず Poland に残る
  assert(
    booleanPointInPolygon(
      [0.5, 0.5],
      poland as Feature<Polygon | MultiPolygon>,
    ),
    "retainedRemainders の成分が Poland に残っていない",
  );
  const north = result.features.find((f) => f.properties?.NAME === "North")!;
  assert(
    !booleanPointInPolygon(
      [0.5, 0.5],
      north as Feature<Polygon | MultiPolygon>,
    ),
    "retainedRemainders の成分が隣接へ併合されている",
  );
  // 置換分（[1,3]）も当然残る
  assert(
    booleanPointInPolygon(
      [2.5, 0.5],
      poland as Feature<Polygon | MultiPolygon>,
    ),
  );
});

Deno.test("#443: remainderRules は大きな残余を根拠付きの明示先へ統合する", () => {
  const base: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      multiPolygonFeature({ NAME: "Poland" }, [[0, 0, 2, 1]]),
      multiPolygonFeature({ NAME: "Holy Roman Empire" }, [[-1, 0, 0, 1]]),
      multiPolygonFeature({ NAME: "Pomerania" }, [[0, 1, 3, 2]]),
    ],
  };
  const replacement = multiPolygonFeature({}, [[1, 0, 3, 1]]) as Feature<
    MultiPolygon
  >;
  const warnings: string[] = [];
  const result = replaceBasePower(
    base,
    replacement,
    {
      year: 1000,
      fromName: "Poland",
      sourcePath: "x",
      sourceName: "y",
      note: "t",
      remainderRules: [{
        point: [0.5, 0.5],
        targetName: "Holy Roman Empire",
        reason: "参照図の帰属",
        source: "https://example.test/map",
      }],
    },
    (message) => warnings.push(message),
  );
  const hre = result.features.find((f) =>
    f.properties?.NAME === "Holy Roman Empire"
  )!;
  const pomerania = result.features.find((f) =>
    f.properties?.NAME === "Pomerania"
  )!;
  assert(
    booleanPointInPolygon(
      [0.5, 0.5],
      hre as Feature<Polygon | MultiPolygon>,
    ),
    "明示した残余が Holy Roman Empire へ統合されていない",
  );
  assert(
    !booleanPointInPolygon(
      [0.5, 0.5],
      pomerania as Feature<Polygon | MultiPolygon>,
    ),
    "共有境界が長い Pomerania へ残余が機械的に移っている",
  );
  assert(
    warnings.some((message) =>
      message.includes("参照図の帰属") &&
      message.includes("https://example.test/map")
    ),
    "帰属理由と出典がログから追跡できない",
  );
});

Deno.test("#443: remainderRules の内点が残余から外れたら自動配分へ縮退せず失敗する", () => {
  const base: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      multiPolygonFeature({ NAME: "Poland" }, [[0, 0, 2, 1]]),
      multiPolygonFeature({ NAME: "Holy Roman Empire" }, [[-1, 0, 0, 1]]),
    ],
  };
  assertThrows(
    () =>
      replaceBasePower(
        base,
        multiPolygonFeature({}, [[1, 0, 3, 1]]) as Feature<MultiPolygon>,
        {
          year: 1000,
          fromName: "Poland",
          sourcePath: "x",
          sourceName: "y",
          note: "t",
          remainderRules: [{
            point: [10, 10],
            targetName: "Holy Roman Empire",
            reason: "参照図の帰属",
            source: "https://example.test/map",
          }],
        },
        () => {},
      ),
    Error,
    "どの連結成分にも一致しません",
  );
});

Deno.test("#352: 1279 / 1300 のクラクフ周辺は Cliopatria の外に出るため Poland へ残す", () => {
  // 上流 Cliopatria の (Duchies of Poland) はクラクフ（小ポーランド）を含まない。
  // 共有境界最長の隣接は Hungary になるが、クラクフはピャスト朝の宗主権を象徴
  // する都市でハンガリー領だった事実は無い。無根拠な帰属を避けるため、この成分
  // だけは置換した Poland に残す（ADR-0040 決定 4 の「実測判断」）。
  const KRAKOW: [number, number] = [19.94, 50.06];
  for (const year of [1279, 1300]) {
    const spec = BASE_POWER_REPLACEMENTS.find((r) => r.year === year)!;
    const retained = spec.retainedRemainders ?? [];
    assertEquals(retained.length, 1, `${year} の残余指定`);
    assertEquals(retained[0].point, KRAKOW);
    assert(retained[0].reason.length > 0);
    const names = namesAt(readBase(year), KRAKOW);
    assert(
      names.includes("Poland"),
      `${year} 年のクラクフが Poland から失われた: ${names.join(", ")}`,
    );
    assert(
      !names.includes("Hungary"),
      `${year} 年のクラクフが Hungary へ併合されている: ${names.join(", ")}`,
    );
  }
});

Deno.test("#352: replaceBasePower は置換先が無ければ base をそのまま返す", () => {
  const base: FeatureCollection = {
    type: "FeatureCollection",
    features: [multiPolygonFeature({ NAME: "Neighbour" }, [[2, 0, 4, 1]])],
  };
  const warnings: string[] = [];
  const result = replaceBasePower(
    base,
    multiPolygonFeature({}, [[1, 0, 3, 1]]) as Feature<MultiPolygon>,
    {
      year: 1200,
      fromName: "Poland",
      sourcePath: "x",
      sourceName: "y",
      note: "t",
    },
    (m) => warnings.push(m),
  );
  assertEquals(result, base);
  assertEquals(warnings.length, 1);
});

/** feature の全リング（外環・内環・全パート） */
function allRings(feature: Feature): number[][][] {
  const g = feature.geometry as Polygon | MultiPolygon;
  return (g.type === "Polygon"
    ? g.coordinates
    : g.coordinates.flat()) as number[][][];
}

/** feature の単一線分の長さ（km）を降順で返す */
function segmentLengthsKm(feature: Feature): number[] {
  const lengths: number[] = [];
  for (const ring of allRings(feature)) {
    for (let i = 1; i < ring.length; i++) {
      lengths.push(segmentLengthKm(ring[i - 1], ring[i]));
    }
  }
  return lengths.sort((a, b) => b - a);
}

/** ジオメトリの頂点数（閉点も数える） */
function vertexCount(feature: Feature): number {
  return allRings(feature).reduce((n, ring) => n + ring.length, 0);
}

/** feature のリングに向きを問わず同じ端点の線分があるか */
function hasSegment(
  feature: Feature,
  a: [number, number],
  b: [number, number],
): boolean {
  const same = (p: number[], q: number[]) => p[0] === q[0] && p[1] === q[1];
  return allRings(feature).some((ring) =>
    ring.some((point, index) =>
      index > 0 &&
      ((same(ring[index - 1], a) && same(point, b)) ||
        (same(ring[index - 1], b) && same(point, a)))
    )
  );
}

function isPolygonFeature(
  feature: Feature,
): feature is Feature<Polygon | MultiPolygon> {
  return feature.geometry?.type === "Polygon" ||
    feature.geometry?.type === "MultiPolygon";
}

Deno.test("#443: 1000年の旧Poland残余はPomeraniaへ移らず、312.4km線分も残らない", () => {
  const base = readBase(1000);
  const pomerania = base.features.find((f) =>
    f.properties?.NAME === "Pomerania" && isPolygonFeature(f)
  ) as Feature<Polygon | MultiPolygon>;
  const hre = base.features.find((f) =>
    f.properties?.NAME === "Holy Roman Empire" && isPolygonFeature(f)
  ) as Feature<Polygon | MultiPolygon>;
  assert(
    Math.abs(areaKm2(pomerania) - 37_200) < 100,
    `Pomerania に旧 Poland 残余が残っている: ${areaKm2(pomerania)} km²`,
  );
  assert(
    Math.abs(areaKm2(hre) - 725_500) < 100,
    `Holy Roman Empire が明示残余を取り込んでいない: ${areaKm2(hre)} km²`,
  );

  const a: [number, number] = [14.68, 50.909];
  const b: [number, number] = [18.478, 49.5];
  const owners = base.features.filter((feature) =>
    isPolygonFeature(feature) && hasSegment(feature, a, b)
  ).map((feature) => feature.properties?.NAME);
  assertEquals(
    owners,
    [],
    `旧Poland–HRE境界が別featureへ移っている: ${owners.join(", ")}`,
  );

  const overlap = intersect(featureCollection([pomerania, hre]));
  assert(
    overlap === null || areaKm2(overlap) < 1,
    "Pomerania と Holy Roman Empire に1 km²以上の二重塗りがある",
  );
});

Deno.test("#443: 全BASE_POWER_REPLACEMENTSで置換元の旧最長線分が別featureへ移らない", () => {
  const removed: Record<number, [[number, number], [number, number]]> = {
    1000: [[18.478, 49.5], [14.68, 50.909]],
    1100: [[24.348, 51.905], [24.169, 54.28]],
    1200: [[24.169, 54.28], [21.464, 53.819]],
    1279: [[18.47, 49.939], [16.995, 50.391]],
    1300: [[21.75, 50.781], [21.768, 49.744]],
    1400: [[30.816, 56.15], [38.181, 49.997]],
  };
  for (const spec of BASE_POWER_REPLACEMENTS.filter((r) => r.year <= 1400)) {
    const [a, b] = removed[spec.year];
    const owners = readBase(spec.year).features.filter((feature) =>
      isPolygonFeature(feature) && hasSegment(feature, a, b)
    ).map((feature) => feature.properties?.NAME);
    assertEquals(
      owners,
      [],
      `${spec.year}: 置換元の旧最長線分が ${owners.join(", ")} へ移っている`,
    );
  }
});

Deno.test("#352: 置換後の base ポーランドの外周から長大な直線が消えている（AC）", () => {
  // 年 → [頂点数, 最長線分 km, 100 km 以上の本数, 面積 km²]
  //
  // 置換前（上流 historical-basemaps）の最長線分は 1000: 312.4 / 1100: 264.4 /
  // 1200: 183.9 / 1279: 116.5 / 1300: 115.3 / 1400: 841.7 km だった。
  // 値は COORD_PRECISION（3 桁）へ丸めた配信用生成物からの実測なので、raw の
  // Cliopatria 親区画（build-cliopatria-fiefs_test.ts が固定）とは 0.1 km 単位で
  // 差が出る。1279 / 1300 は BASE_POWER_REPLACEMENTS の retainedRemainders
  // （クラクフを含む小ポーランド）を足した分だけ面積・頂点数が大きい。
  const expected: Record<number, [number, number, number, number]> = {
    1000: [91, 74.4, 0, 247_597],
    1100: [97, 90.2, 0, 200_152],
    1200: [93, 75.4, 0, 223_808],
    1279: [111, 110.7, 1, 200_106],
    1300: [107, 110.7, 1, 194_869],
    1400: [215, 195.3, 4, 1_036_570],
  };
  for (const r of BASE_POWER_REPLACEMENTS.filter((r) => r.year <= 1400)) {
    const powers = readBase(r.year).features.filter((f) =>
      f.properties?.NAME === r.fromName
    );
    assertEquals(powers.length, 1, `${r.year}: ${r.fromName} の feature 数`);
    const [verts, longest, over100, km2] = expected[r.year];
    assertEquals(vertexCount(powers[0]), verts, `${r.year}: 頂点数`);
    assertEquals(Math.round(areaKm2(powers[0])), km2, `${r.year}: 面積`);
    const lengths = segmentLengthsKm(powers[0]);
    assertEquals(
      Number(lengths[0].toFixed(1)),
      longest,
      `${r.year}: 最長線分（km）`,
    );
    assertEquals(
      lengths.filter((km) => km >= 100).length,
      over100,
      `${r.year}: 100 km 以上の単一線分の本数`,
    );
    // 置換前の長大な直線が 1 本も残っていない（AC）
    for (const removed of [312.4, 264.4, 183.9, 841.7]) {
      assert(
        !lengths.some((km) => Math.abs(km - removed) < 1),
        `${r.year}: 置換前の ${removed} km の線分が残っている`,
      );
    }
  }
});

Deno.test("#352: 置換した 6 年の base は Cliopatria の外周（NAME は据え置き）になる", () => {
  // 置換は勢力の**外周だけ**を入れ替える操作で、NAME・色キー・ラベルは
  // base の語彙のまま（Poland / Poland-Lithuania）。子区画は Cliopatria
  // オーバーレイ側が担う。
  for (const r of BASE_POWER_REPLACEMENTS.filter((r) => r.year <= 1400)) {
    const powers = readBase(r.year).features.filter((f) =>
      f.properties?.NAME === r.fromName
    );
    assert(powers.length > 0, `${r.year} 年の ${r.fromName} が base に無い`);
    for (const power of powers) {
      // 置換は座標だけを入れ替えるので、宗主（= 独立勢力の自己参照）は不変。
      // PARTOF は上流の列ずれ（1400 年の Poland-Lithuania は "Riazan"）を
      // そのまま持つ feature があるため見ない
      assertEquals(power.properties?.SUBJECTO, r.fromName);
    }
  }
});
