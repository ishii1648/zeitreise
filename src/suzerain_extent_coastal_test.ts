/**
 * 勢力圏の外枠（hre-extent）と「画面上のアクティブ表示領域」の幾何一致の
 * 回帰検査（Issue #330 AC1）。
 *
 * 画面でアクティブ（緑青）になる面は 2 つのレイヤーに分かれている:
 * - deck の政治ポリゴン（powers ほか。強調キー colorKeyFor が一致する feature）
 * - MapLibre の沿岸補完の帯（coastal-fill。feature-state "active" が同じキーで
 *   立つ。#305 → #312 → #326 で事前生成された `data/coastal_fill_<year>.geojson`）
 *
 * #330 以前の外枠は前者（元の `europe_<year>` ポリドン）だけを union していた
 * ため、歴史ポリゴンが現代海岸線より内側にある区間では緑青が臙脂線の外へ
 * 広がり、赤線が領域の内部に取り残されていた。ここでは**配信データそのもの**
 * （事前生成の帯 + 年代 GeoJSON）から「実際に緑青で塗られる面」を組み立て、
 * それが外枠に完全に含まれることを固定する。帯を入力から落とすと red になる。
 *
 * 対象は Issue の再現手順に挙がった 2 例（1815 年プロイセン / 1880 年ドイツ）。
 */
import { assert, assertEquals } from "@std/assert";
import type {
  Feature,
  FeatureCollection,
  MultiPolygon,
  Polygon,
  Position,
} from "geojson";
import area from "@turf/area";
import difference from "@turf/difference";
import { featureCollection } from "@turf/helpers";
import union from "@turf/union";
import {
  buildSuzerainExtent,
  EMPTY_SUZERAIN_OVERRIDES,
  resolveSuzerainKey,
  SLIVER_HALF_WIDTH_M,
} from "./suzerain_extent.ts";
import {
  COASTAL_FILL_KEY_PROPERTY,
  coastalBandsForSuzerain,
  coastalFillDataFromBands,
} from "./coastal_fill.ts";
import { colorKeyFor } from "./powers.ts";

/**
 * 許容する「外枠の外へはみ出したアクティブ面」の割合。
 *
 * 0 にしないのは polyclip の座標丸め（差分の結果に幅 1e-9 度級の糸くずが残る）
 * があるため。実測ではこの検査は修正前 9〜13%・修正後 1e-9 未満で、閾値の
 * 取り方に結論は依存しない。
 */
const MAX_OUTSIDE_RATIO = 1e-6;

function readFc(path: string): FeatureCollection {
  return JSON.parse(Deno.readTextFileSync(path)) as FeatureCollection;
}

function polygonsOnly(features: Feature[]): Feature<Polygon | MultiPolygon>[] {
  return features.filter((f): f is Feature<Polygon | MultiPolygon> =>
    f.geometry !== null &&
    (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")
  );
}

/** 複数ポリゴンを 1 枚へ融合する（0 件は null） */
function mergeAll(
  features: Feature<Polygon | MultiPolygon>[],
): Feature<Polygon | MultiPolygon> | null {
  if (features.length === 0) return null;
  if (features.length === 1) return features[0];
  return union(featureCollection(features), { properties: {} });
}

/**
 * ホバー/クリックで緑青になる面（deck の政治ポリゴン + 沿岸補完の帯）を、
 * ランタイムと同じ経路（colorKeyFor / coastalFillDataFromBands）で組み立てる。
 */
function activeArea(
  base: FeatureCollection,
  bands: FeatureCollection,
  activeKey: string,
): Feature<Polygon | MultiPolygon> | null {
  const fills = polygonsOnly(
    base.features.filter((f) => colorKeyFor(f.properties) === activeKey),
  );
  const fillData = coastalFillDataFromBands(
    base,
    bands,
    {},
    EMPTY_SUZERAIN_OVERRIDES,
  );
  assert(fillData !== null, "事前生成の帯が年代 GeoJSON と対応していない");
  const activeBands = polygonsOnly(
    fillData.features.filter((f) =>
      f.properties?.[COASTAL_FILL_KEY_PROPERTY] === activeKey
    ),
  );
  return mergeAll([...fills, ...activeBands]);
}

/** 環の平均半幅（m）。細長い糸くず環はこの値が座標丸めの桁に落ちる */
function ringHalfWidthMeters(ring: readonly Position[]): number {
  const latMean = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
  const scale = Math.cos((latMean * Math.PI) / 180);
  const xs = ring.map((p) => p[0] * scale * 111_320);
  const ys = ring.map((p) => p[1] * 110_574);
  let twice = 0;
  let perimeter = 0;
  for (let i = 1; i < ring.length; i++) {
    twice += xs[i - 1] * ys[i] - xs[i] * ys[i - 1];
    perimeter += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  }
  if (perimeter === 0) return 0;
  return Math.abs(twice / 2) / perimeter;
}

function ringsOf(feature: Feature<Polygon | MultiPolygon>): Position[][] {
  const geometry = feature.geometry;
  const polygons = geometry.type === "MultiPolygon"
    ? geometry.coordinates
    : [geometry.coordinates];
  return polygons.flat();
}

for (const [year, name] of [[1815, "Prussia"], [1880, "Germany"]] as const) {
  Deno.test(`${year} 年 ${name} のアクティブ表示領域は勢力圏の外枠に収まる（#330 AC1）`, () => {
    const base = readFc(`data/europe_${year}.geojson`);
    const bands = readFc(`data/coastal_fill_${year}.geojson`);
    const picked = base.features.find((f) => f.properties?.NAME === name);
    assert(picked !== undefined, `${year} 年の base に ${name} が無い`);
    const activeKey = colorKeyFor(picked.properties);
    assert(activeKey !== null);
    const extentKey = resolveSuzerainKey(
      picked.properties,
      EMPTY_SUZERAIN_OVERRIDES,
    );
    const extent = buildSuzerainExtent(
      base,
      extentKey,
      EMPTY_SUZERAIN_OVERRIDES,
      { base, bands, select: coastalBandsForSuzerain },
    );
    const outline = mergeAll(polygonsOnly(extent.features));
    assert(outline !== null);
    const active = activeArea(base, bands, activeKey);
    assert(active !== null);
    const outside = difference(featureCollection([active, outline]));
    const ratio = outside === null ? 0 : area(outside) / area(active);
    assert(
      ratio < MAX_OUTSIDE_RATIO,
      `アクティブ表示領域の ${(ratio * 100).toFixed(2)}% が外枠の外にある` +
        `（臙脂線が領域の内部に取り残される。${
          ((outside === null ? 0 : area(outside)) / 1e6).toFixed(0)
        } km2）`,
    );
  });

  Deno.test(`${year} 年 ${name} の外枠に糸くず環（元の海岸線の痕跡）が残らない（#330 AC4）`, () => {
    const base = readFc(`data/europe_${year}.geojson`);
    const bands = readFc(`data/coastal_fill_${year}.geojson`);
    const picked = base.features.find((f) => f.properties?.NAME === name);
    assert(picked !== undefined);
    const extent = buildSuzerainExtent(
      base,
      resolveSuzerainKey(picked.properties, EMPTY_SUZERAIN_OVERRIDES),
      EMPTY_SUZERAIN_OVERRIDES,
      { base, bands, select: coastalBandsForSuzerain },
    );
    // 帯（配信データは 5 桁 ≈ 1.1m へ丸め済み）と元ポリゴンの縁は同じ線を
    // 通るが、polyclip の交点座標がサブメートルずれるため、union すると
    // 平均半幅 0.1m 級の糸くず環が海岸線に沿って残る。面積としては無視
    // できるが、3px の臙脂線として領域の内部に元の概略海岸線を描いてしまう
    // （実測: 1815 年プロイセン 9 本・最長 23.4km／1880 年ドイツ 24 本・
    // 最長 31.9km）。
    const slivers = polygonsOnly(extent.features)
      .flatMap((f) => ringsOf(f))
      .map((ring) => ringHalfWidthMeters(ring))
      .filter((halfWidth) => halfWidth < SLIVER_HALF_WIDTH_M);
    assertEquals(
      slivers.length,
      0,
      `幅 ${SLIVER_HALF_WIDTH_M}m 未満の糸くず環が ${slivers.length} 本残っている`,
    );
  });
}
