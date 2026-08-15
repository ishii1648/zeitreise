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
import { pointKey } from "./coastal_segments.ts";
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

/**
 * クロニアン潟・砂州を含む bbox（[西, 南, 東, 北]）。#358 が記録し #389 が
 * 解消した帯の穴（2 環）が入っていた範囲で、内環の絞り込みにだけ使う。
 */
const CURONIAN_BOX = [20.6, 55.0, 21.2, 55.6] as const;

/** 環が bbox に完全に収まるか */
function ringWithin(
  ring: readonly Position[],
  box: readonly [number, number, number, number],
): boolean {
  return ring.every((p) =>
    p[0] >= box[0] && p[0] <= box[2] && p[1] >= box[1] && p[1] <= box[3]
  );
}

/** 外枠を組み立てる（帯つき。#330 と同じ入力） */
function extentOf(
  base: FeatureCollection,
  bands: FeatureCollection,
  name: string,
): { extent: FeatureCollection; key: string } {
  const picked = base.features.find((f) => f.properties?.NAME === name);
  assert(picked !== undefined, `base に ${name} が無い`);
  const key = resolveSuzerainKey(picked.properties, EMPTY_SUZERAIN_OVERRIDES);
  assert(key !== null);
  return {
    key,
    extent: buildSuzerainExtent(base, key, EMPTY_SUZERAIN_OVERRIDES, {
      base,
      bands,
      select: coastalBandsForSuzerain,
    }),
  };
}

/** feature 群の内環（穴）を平坦に取り出す */
function holesOf(features: Feature<Polygon | MultiPolygon>[]): Position[][] {
  return features.flatMap((f) => {
    const polygons = f.geometry.type === "MultiPolygon"
      ? f.geometry.coordinates
      : [f.geometry.coordinates];
    return polygons.flatMap((rings) => rings.slice(1));
  });
}

// --- #389: クロニアン砂州沖の内環（#358 の既知の残差）が解消したことの検査 ---
//
// #358 は「1815 年プロイセンを選ぶと緑青の内部に孤立した臙脂線が残る」報告で、
// その線の正体が**沿岸補完の帯（coastal_fill_<year>）そのものが持つ穴**の縁で
// あることを実測で突き止めた（docs/research/issue-358-suzerain-extent-inner-ring.md）。
// 帯は「沿岸 run の外側 30km のバッファ」を片側オフセットの**単環**で表して
// いたため、粗い海岸線が数 km 刻みで東西に折れる東プロイセン沖ではオフセット列が
// 折り返し、巻き数が打ち消し合ったポケットが帯の穴 = 塗りの欠けとして残っていた
// （実測 2 環・平均半幅 1,096.7m と 2,508.3m。19 年代中 17 年代に同じ形で出る）。
// #358 自身はこれを既知の残差として記録するに留め、#389 が帯の側で断った:
// 帯を差分の**前に** self-union で正規化し、run の頂点を 1 つも含まない内環
// （＝オフセット点だけで囲まれた折り返しポケット）を埋める
// （src/coastal_fill.ts coastalBandPolygon）。
//
// ここでは症状が出ていた 2 例で、残差が戻っていないことを 2 つの角度から見る:
// (1) クロニアン潟・砂州の範囲に内環が 1 つも無いこと（#358 の症状そのもの）
// (2) 「base の頂点を 1 つも含まない実寸（平均半幅 500m 以上）の内環」が
//     無いこと。これは帯側の検査（coastal_fill_band_test.ts の #389 AC3）と
//     同じ定義で、外枠は帯の穴をそのまま内環として引き継ぐため同じ条件で
//     見える。修正前の実測はどちらの年も 2 環（上記のクロニアンの 2 環）。
//
// 落としてはいけない実在の未着色域（次の #330 AC5・ボーデン湖付近 7.94m）は
// 元の政治ポリゴンの頂点でできているため (2) には掛からない。
const FOLD_POCKET_MIN_HALF_WIDTH_M = 500;

for (
  const [year, name] of [[1815, "Prussia"], [1880, "Germany"]] as const
) {
  Deno.test(`${year} 年 ${name} の外枠にクロニアン砂州沖の内環（帯の折り返し穴）が残らない（#389 / 旧 #358 残差）`, () => {
    const base = readFc(`data/europe_${year}.geojson`);
    const bands = readFc(`data/coastal_fill_${year}.geojson`);
    const { extent, key } = extentOf(base, bands, name);
    const holes = holesOf(polygonsOnly(extent.features));

    const curonian = holes.filter((ring) => ringWithin(ring, CURONIAN_BOX));
    assertEquals(
      curonian.map((ring) => ringHalfWidthMeters(ring).toFixed(1)),
      [],
      "クロニアン潟・砂州の範囲に内環が残っている（帯の折り返し穴の再発）",
    );

    // 帯の側にも穴が空いていないこと（外枠は帯の穴をそのまま引き継ぐので、
    // 外枠だけ塞がって帯に穴が残る＝塗りだけ欠ける状態を作らない）
    const bandHoles = holesOf(
      coastalBandsForSuzerain(bands, base, key, EMPTY_SUZERAIN_OVERRIDES),
    ).filter((ring) => ringWithin(ring, CURONIAN_BOX));
    assertEquals(
      bandHoles.length,
      0,
      "沿岸補完の帯にクロニアン砂州沖の穴が残っている",
    );

    // base の頂点を含まない実寸の内環 = 折り返しポケット由来（修正前は 2 環）
    const baseKeys = new Set(
      polygonsOnly(base.features).flatMap(ringsOf).flat().map(pointKey),
    );
    const pockets = holes.filter((ring) =>
      !ring.some((position) => baseKeys.has(pointKey(position))) &&
      ringHalfWidthMeters(ring) >= FOLD_POCKET_MIN_HALF_WIDTH_M
    );
    assertEquals(
      pockets.map((ring) => `${ringHalfWidthMeters(ring).toFixed(1)}m`),
      [],
      "base の頂点を含まない実寸の内環（帯の折り返しポケット）が外枠に残っている",
    );
  });
}

Deno.test("1880 年 Germany の外枠は実在の未着色域（平均半幅 7.9m）の内環を保持する（#330 AC5 / #358）", () => {
  const base = readFc("data/europe_1880.geojson");
  const bands = readFc("data/coastal_fill_1880.geojson");
  const { extent } = extentOf(base, bands, "Germany");
  // #330 が糸くず（0.1m 級）と実在（8m 以上）を分ける根拠にした最小の実在環
  // （ボーデン湖付近・年代 GeoJSON の 3 桁格子 ≈ 111m 由来の隙間）。閾値を
  // 上げる方向の変更でここが落ちる（#358 のスコープ外とした対処が入ると red）。
  const narrow = holesOf(polygonsOnly(extent.features))
    .map(ringHalfWidthMeters)
    .filter((halfWidth) => halfWidth < 10);
  assertEquals(
    narrow.length,
    1,
    "実在の未着色域（7.9m）の環が保持されていない",
  );
  assert(
    Math.abs(narrow[0] - 7.94) < 0.1,
    `最小の実在環の平均半幅が ${narrow[0].toFixed(2)}m（実測は 7.94m）`,
  );
});
