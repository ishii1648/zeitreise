/**
 * coastal_fill.ts のユニットテスト（Issue #305 / #312）。
 *
 * 検証する契約:
 * - buildCoastalRuns が「他 feature と共有されない外環セグメント（= 沿岸）」
 *   だけを LineString run として取り出すこと（内陸境界・穴・T 字接合の
 *   不一致境界は含まれない）
 * - run の向きが CCW（陸が進行方向の左）に正規化され、外側 = 進行方向の右
 *   （海側）が成り立つこと
 * - coastalBandPolygon が run の外側だけに帯の面を作ること（#312）
 * - 色プロパティ（detailColor / overviewColor）が塗り（powers /
 *   political_layers）と同じ規則で決まること
 * - レイヤー定義（coastalFillLayerSpec）が fill レイヤーで、強調
 *   feature-state・z4/z5 の色切替を持つこと
 * - 挿入位置（coastalFillBeforeId）が内水面の直下であること
 * - 実データ（europe_1900）で沿岸 run が取れ、内陸（仏中部・独中部など海の
 *   ない領域）には run が現れないこと（#305 AC1 の機械的検出）
 *
 * 帯そのものの被覆率・二重塗りの回帰検査は coastal_fill_band_test.ts（#312）。
 */
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { FeatureCollection, LineString, Polygon, Position } from "geojson";
import {
  buildCoastalRuns,
  COASTAL_FILL_BAND_KM,
  COASTAL_FILL_DETAIL_COLOR_PROPERTY,
  COASTAL_FILL_KEY_PROPERTY,
  COASTAL_FILL_OVERVIEW_COLOR_PROPERTY,
  COASTAL_FILL_SOURCE_ID,
  coastalBandPolygon,
  coastalFillBeforeId,
  coastalFillLayerSpec,
  coastalFillSourceSpec,
  EMPTY_COASTAL_FILL_DATA,
  overviewCoastalFillColor,
  rgbaString,
} from "./coastal_fill.ts";
import {
  COASTAL_FILL_LAYER_ID,
  WATER_INLAND_LAYER_ID,
  WATER_LAYER_ID,
} from "./basemap.ts";
import { FIEF_LABEL_MIN_ZOOM } from "./labels.ts";
import { FILL_ALPHA } from "./powers.ts";
import { ACTIVE_FILL_COLOR } from "./power_highlight.ts";
import { EMPTY_SUZERAIN_OVERRIDES } from "./suzerain_extent.ts";
import { overviewPowerFillColor } from "./political_layers.ts";

const COLORS: Record<string, string> = {
  "A": "#ff0000",
  "B": "#00ff00",
  "Vassal|A": "#112233",
};

/** 隣接する 2 つの正方形（x=1 の辺を厳密に共有）。A は CW 巻きで入れる */
function twoSquares(): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { NAME: "A" },
        geometry: {
          type: "Polygon",
          // CW（時計回り）: 向きの正規化（CCW 化）を検証する
          coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
        },
      },
      {
        type: "Feature",
        properties: { NAME: "B" },
        geometry: {
          type: "Polygon",
          // CCW: 左辺 (1,1)→(1,0) が A の右辺と同一セグメント
          coordinates: [[[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]]],
        },
      },
    ],
  };
}

/** run 群から（正規化済みの）セグメント集合を取り出す */
function segmentsOf(data: FeatureCollection): [Position, Position][] {
  const segments: [Position, Position][] = [];
  for (const feature of data.features) {
    const line = feature.geometry as LineString;
    for (let i = 1; i < line.coordinates.length; i++) {
      segments.push([line.coordinates[i - 1], line.coordinates[i]]);
    }
  }
  return segments;
}

function hasSegment(
  segments: [Position, Position][],
  a: Position,
  b: Position,
): boolean {
  return segments.some(([p, q]) =>
    (p[0] === a[0] && p[1] === a[1] && q[0] === b[0] && q[1] === b[1]) ||
    (p[0] === b[0] && p[1] === b[1] && q[0] === a[0] && q[1] === a[1])
  );
}

Deno.test("buildCoastalRuns は共有辺（内陸境界）を除いた外環 run を返す", () => {
  const data = buildCoastalRuns(
    twoSquares(),
    COLORS,
    EMPTY_SUZERAIN_OVERRIDES,
  );
  const segments = segmentsOf(data);
  // 共有辺 x=1 は含まれない
  assert(!hasSegment(segments, [1, 0], [1, 1]));
  // 沿岸相当の辺（A の左・上・下、B の右・上・下）は全て含まれる
  assert(hasSegment(segments, [0, 0], [1, 0]));
  assert(hasSegment(segments, [0, 0], [0, 1]));
  assert(hasSegment(segments, [0, 1], [1, 1]));
  assert(hasSegment(segments, [1, 0], [2, 0]));
  assert(hasSegment(segments, [2, 0], [2, 1]));
  assert(hasSegment(segments, [2, 1], [1, 1]));
  // 3 セグメント × 2 feature（共有辺 2 本を除く）
  assertEquals(segments.length, 6);
});

Deno.test("buildCoastalRuns は run の向きを CCW（陸が左）へ正規化する", () => {
  const data = buildCoastalRuns(
    twoSquares(),
    COLORS,
    EMPTY_SUZERAIN_OVERRIDES,
  );
  // A（CW 入力）の底辺は CCW なら (0,0)→(1,0) の向き（陸 = y>0 が左）
  const aRuns = data.features.filter(
    (f) => f.properties?.[COASTAL_FILL_KEY_PROPERTY] === "A",
  );
  const found = segmentsOf({ type: "FeatureCollection", features: aRuns })
    .filter(([p, q]) => p[1] === 0 && q[1] === 0);
  assertEquals(found.length, 1);
  assertEquals(found[0][0], [0, 0]);
  assertEquals(found[0][1], [1, 0]);
});

Deno.test("buildCoastalRuns は閉じた環（島）の連続 run を切れ目 1 箇所の閉 LineString にまとめる", () => {
  const island: FeatureCollection = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { NAME: "A" },
      geometry: {
        type: "Polygon",
        coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
      },
    }],
  };
  const data = buildCoastalRuns(island, COLORS, EMPTY_SUZERAIN_OVERRIDES);
  assertEquals(data.features.length, 1);
  const line = data.features[0].geometry as LineString;
  assertEquals(line.coordinates.length, 5);
  assertEquals(line.coordinates[0], line.coordinates[4]);
});

Deno.test("buildCoastalRuns は穴（湖など）の環を対象にしない", () => {
  const withHole: FeatureCollection = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { NAME: "A" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [[0, 0], [3, 0], [3, 3], [0, 3], [0, 0]],
          [[1, 1], [1, 2], [2, 2], [2, 1], [1, 1]],
        ],
      },
    }],
  };
  const data = buildCoastalRuns(withHole, COLORS, EMPTY_SUZERAIN_OVERRIDES);
  const segments = segmentsOf(data);
  // 外環 4 セグメントのみ（穴の 4 セグメントは現れない）
  assertEquals(segments.length, 4);
  assert(!hasSegment(segments, [1, 1], [1, 2]));
});

Deno.test("buildCoastalRuns は T 字接合（頂点不一致の内陸境界）を沿岸と誤認しない", () => {
  const tJunction: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { NAME: "A" },
        geometry: {
          type: "Polygon",
          coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
        },
      },
      {
        type: "Feature",
        properties: { NAME: "B" },
        geometry: {
          type: "Polygon",
          // 左辺に中間頂点 (1, 0.5) を持つ = A の右辺と 1:2 で対応し
          // セグメント単位では共有されない
          coordinates: [[[1, 0], [2, 0], [2, 1], [1, 1], [1, 0.5], [1, 0]]],
        },
      },
    ],
  };
  const data = buildCoastalRuns(
    tJunction,
    COLORS,
    EMPTY_SUZERAIN_OVERRIDES,
  );
  const segments = segmentsOf(data);
  // x=1 上のセグメント（A 側 1 本・B 側 2 本）はいずれも現れない
  assert(segments.every(([p, q]) => !(p[0] === 1 && q[0] === 1)));
});

Deno.test("buildCoastalRuns の色プロパティは塗りと同じ規則（詳細 = 固有色 / 概観 = 宗主色）", () => {
  const vassal: FeatureCollection = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { NAME: "Vassal", SUBJECTO: "A" },
      geometry: {
        type: "Polygon",
        coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
      },
    }],
  };
  const data = buildCoastalRuns(vassal, COLORS, EMPTY_SUZERAIN_OVERRIDES);
  assertEquals(data.features.length, 1);
  const props = data.features[0].properties;
  assertEquals(props?.[COASTAL_FILL_KEY_PROPERTY], "Vassal|A");
  // 詳細表示の色 = 固有色（colors["Vassal|A"] = #112233）
  assertEquals(
    props?.[COASTAL_FILL_DETAIL_COLOR_PROPERTY],
    rgbaString([0x11, 0x22, 0x33, FILL_ALPHA]),
  );
  // 概観表示の色 = 宗主色（colors["A"] = #ff0000）
  assertEquals(
    props?.[COASTAL_FILL_OVERVIEW_COLOR_PROPERTY],
    rgbaString([255, 0, 0, FILL_ALPHA]),
  );
});

Deno.test("overviewCoastalFillColor は overviewPowerFillColor（強調なし）と同値", () => {
  const cases = [
    { NAME: "Vassal", SUBJECTO: "A" },
    { NAME: "A" },
    { NAME: "Unknown" },
    { NAME: null },
  ];
  for (const props of cases) {
    assertEquals(
      overviewCoastalFillColor(props, COLORS, EMPTY_SUZERAIN_OVERRIDES),
      overviewPowerFillColor(
        props,
        COLORS,
        EMPTY_SUZERAIN_OVERRIDES,
        null,
        null,
      ),
    );
  }
});

Deno.test("coastalFillLayerSpec は面（fill）で、ズーム依存の幅を持たない（#312 AC3）", () => {
  const spec = coastalFillLayerSpec();
  assertEquals(spec.id, COASTAL_FILL_LAYER_ID);
  assertEquals(spec.type, "fill");
  assertEquals(spec.source, COASTAL_FILL_SOURCE_ID);
  // 帯の広さはジオメトリ（COASTAL_FILL_BAND_KM）だけが決める
  assertEquals(spec.paint["line-width"], undefined);
  assertEquals(spec.paint["line-offset"], undefined);
  assertEquals(spec.paint["fill-antialias"], false);
});

Deno.test("coastalBandPolygon は run の外側（進行方向の右）にだけ帯の面を作る（#312）", () => {
  // 東向きに進む run（CCW = 陸が北側）。外側 = 南
  const band = coastalBandPolygon([[0, 50], [1, 50]], COASTAL_FILL_BAND_KM);
  assert(band !== null);
  const feature = { type: "Feature" as const, properties: {}, geometry: band };
  // 帯幅の半分だけ南（外側）は覆われる
  const half = COASTAL_FILL_BAND_KM / 2 / 110.574;
  assert(booleanPointInPolygon([0.5, 50 - half], feature));
  // 同じだけ北（陸側）は覆われない
  assert(!booleanPointInPolygon([0.5, 50 + half], feature));
  // 帯幅を超えた先（1.5 倍）も覆われない
  assert(
    !booleanPointInPolygon(
      [0.5, 50 - (COASTAL_FILL_BAND_KM * 1.5) / 110.574],
      feature,
    ),
  );
});

Deno.test("coastalBandPolygon は閉じた run（島）を穴付きのドーナツにする（#312 / #389）", () => {
  const ring: Position[] = [[0, 50], [1, 50], [1, 51], [0, 51], [0, 50]];
  const band = coastalBandPolygon(ring, COASTAL_FILL_BAND_KM);
  assert(band !== null);
  // #389 の正規化（self-union）は折り返しポケットだけを埋め、run の頂点で
  // できた穴（島そのもの）は残すので、1 パート・外環 + 穴の 2 環になる
  assertEquals(band.type, "Polygon");
  assertEquals((band as Polygon).coordinates.length, 2);
  const feature = { type: "Feature" as const, properties: {}, geometry: band };
  // 島の内部（穴）は覆われない
  assert(!booleanPointInPolygon([0.5, 50.5], feature));
  // 島のすぐ外側は覆われる
  assert(booleanPointInPolygon([0.5, 49.95], feature));
});

/**
 * #389: 帯幅より細かい刻みでジグザグする海岸線では、片側オフセット列が
 * 折り返して巻き数の打ち消し合うポケットができる。差分の前に self-union で
 * 正規化してこのポケットを埋めるので、帯には run 頂点由来でない穴が残らない
 * （クロニアン砂州の 2.08 km² が塗られなかった原因。実データでの検査は
 * coastal_fill_band_test.ts の #389 AC1 / AC3）。
 */
Deno.test("coastalBandPolygon はジグザグ区間で折り返しの穴を残さない（#389）", () => {
  // 帯幅 30km に対して 5km 刻みで南北に振れる run（東向き = 外側は南）
  const step = 5 / 111.320 / Math.cos((55 * Math.PI) / 180);
  const amplitude = 5 / 110.574;
  const run: Position[] = [];
  for (let i = 0; i <= 12; i++) {
    run.push([20 + i * step, 55 + (i % 2 === 0 ? 0 : amplitude)]);
  }
  const band = coastalBandPolygon(run, COASTAL_FILL_BAND_KM);
  assert(band !== null);
  const feature = { type: "Feature" as const, properties: {}, geometry: band };
  // 折り返しポケットの内部（run から南へ 28km。帯幅 30km の内側）。修正前は
  // 自己交差した単環のままで、この点が帯から抜けていた
  assert(
    booleanPointInPolygon(
      [20 + 2 * step, 55 + amplitude - 28 / 110.574],
      feature,
    ),
    "折り返しポケットの内側が帯から抜けている",
  );
  // 帯幅の外（35km）へは広がらない
  assert(
    !booleanPointInPolygon(
      [20 + 2 * step, 55 + amplitude - 35 / 110.574],
      feature,
    ),
  );
  // 構造としても run 頂点由来でない内環（＝ポケット）を持たない
  const polygons = band.type === "MultiPolygon"
    ? band.coordinates
    : [band.coordinates];
  const runKeys = new Set(run.map((p) => `${p[0]},${p[1]}`));
  const pockets = polygons.flatMap((rings) => rings.slice(1)).filter((hole) =>
    !hole.some((position) => runKeys.has(`${position[0]},${position[1]}`))
  );
  assertEquals(
    pockets.length,
    0,
    "run の頂点を含まない内環（折り返しポケット）が帯に残っている",
  );
});

Deno.test("coastalFillLayerSpec の色は 強調 feature-state > 概観/詳細のズーム切替", () => {
  const spec = coastalFillLayerSpec();
  // ["zoom"] はトップレベルの step / interpolate の入力にしか使えないため、
  // ズーム切替が最外・feature-state の分岐が内側になる
  const activeOrProperty = (colorProperty: string) => [
    "case",
    ["boolean", ["feature-state", "active"], false],
    rgbaString(ACTIVE_FILL_COLOR),
    ["get", colorProperty],
  ];
  assertEquals(spec.paint["fill-color"], [
    "step",
    ["zoom"],
    activeOrProperty(COASTAL_FILL_OVERVIEW_COLOR_PROPERTY),
    FIEF_LABEL_MIN_ZOOM,
    activeOrProperty(COASTAL_FILL_DETAIL_COLOR_PROPERTY),
  ]);
});

Deno.test("coastalFillSourceSpec は feature-state 用に色キーを promoteId へ昇格する", () => {
  const spec = coastalFillSourceSpec();
  assertEquals(spec.type, "geojson");
  assertEquals(spec.promoteId, COASTAL_FILL_KEY_PROPERTY);
  assertStrictEquals(spec.data, EMPTY_COASTAL_FILL_DATA);
});

Deno.test("coastalFillBeforeId は内水面の直下（無ければ海洋の直下、水面なしは null）", () => {
  assertEquals(
    coastalFillBeforeId([
      "earth",
      WATER_INLAND_LAYER_ID,
      WATER_LAYER_ID,
      "coastline",
    ]),
    WATER_INLAND_LAYER_ID,
  );
  assertEquals(
    coastalFillBeforeId(["earth", WATER_LAYER_ID]),
    WATER_LAYER_ID,
  );
  assertEquals(coastalFillBeforeId(["background", "landuse"]), null);
});

Deno.test("実データ（europe_1900）の沿岸 run は内陸に現れない（AC1 の機械的検出）", async () => {
  const base = JSON.parse(
    await Deno.readTextFile("data/europe_1900.geojson"),
  ) as FeatureCollection;
  const data = buildCoastalRuns(base, {}, EMPTY_SUZERAIN_OVERRIDES);
  // 沿岸 run が実際に取れている（英国・デンマーク・オランダ周辺の帯の材料）
  assert(data.features.length > 100);
  // 海の無い内陸領域には run が 1 本も現れない（AC4: 内陸境界の二重塗り防止）
  const inlandBoxes: [number, number, number, number][] = [
    [0, 45.5, 4, 48], // 仏中部
    [8.5, 48.5, 12, 52], // 独中部
    [-6, 38.5, -2, 41.5], // 西中部
    [16.5, 45.5, 20, 48.5], // ハンガリー内陸
  ];
  for (const feature of data.features) {
    const line = feature.geometry as LineString;
    for (let i = 1; i < line.coordinates.length; i++) {
      const [ax, ay] = line.coordinates[i - 1];
      const [bx, by] = line.coordinates[i];
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      for (const [w, s, e, n] of inlandBoxes) {
        assert(
          !(mx >= w && mx <= e && my >= s && my <= n),
          `内陸 run を検出: (${mx}, ${my})`,
        );
      }
    }
  }
  // 英国（ブリテン島周辺）には沿岸 run がある
  const britain = data.features.some((feature) => {
    const line = feature.geometry as LineString;
    return line.coordinates.some(([lon, lat]) =>
      lon > -6 && lon < 2 && lat > 50 && lat < 59
    );
  });
  assert(britain);
});
