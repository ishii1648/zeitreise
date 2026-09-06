/**
 * 後期（近世）神聖ローマ帝国の**帝国全域**ジオメトリを OpenHistoricalMap（OHM）
 * から生成するデータパイプライン（#332）。
 *
 * ## なぜ「帝国全域」の面が要るのか
 * 勢力圏の外枠（src/suzerain_extent.ts）は長らく「base（europe_<year>）に
 * 属する feature の union」で足りていた。base が帝国を 1 枚の
 * `Holy Roman Empire` ポリゴンで塗っていたからで、領邦オーバーレイは
 * その内側を細分するだけだった。
 *
 * この前提は 1715 年から崩れる（実測）。
 * - 1700: ベルリン・ウィーン・プラハはいずれも base の `Holy Roman Empire`
 *   ポリゴン内（外枠 608,440 km²）
 * - 1715: base の `Holy Roman Empire` は残余 236,581 km² だけになり、
 *   ベルリンは `Brandenburg / SUBJECTO=Prussia`、ウィーン・プラハは
 *   `Austrian Empire` が塗る
 * - 1783 / 1800: base に HRE キーへ解決する feature が 1 件も無い（外枠が空）
 *
 * 個々の領邦を足し上げて帝国を再構成する道は採らない。base 側の
 * Prussia / Austrian Empire のように**帝国内外にまたがる** feature があり、
 * 丸ごと足せばハンガリー王国や東プロイセンまで囲んでしまう一方、切り出すには
 * 結局「帝国の外縁」が要るからである。したがって外縁そのものを出典付きで
 * 持つ。
 *
 * ## 出典
 * OHM は神聖ローマ帝国の行政境界（`boundary=administrative` /
 * `admin_level=2` / `empire=hre`）を条約ごとの時間スライスとして持つ。
 * 本パイプラインはその中から対象年に有効なリレーションを 1 件選び、
 * メンバー way から MultiPolygon を組み立てる。
 * - 1715 → relation 2815489（1713-04-02 ユトレヒト条約〜1742-07-28）
 * - 1783 → relation 2810442（1779-04-23 テシェン条約〜1787）
 * - 1800 → relation 2696467（1797-10-17 カンポ・フォルミオ条約〜1803-04-27）
 *
 * 出典: OpenHistoricalMap（https://www.openhistoricalmap.org/）
 * ライセンス: CC0 1.0。既存の hre_fiefs_<year>.geojson（#187）と同一系統・
 * 同一ライセンスで、領邦オーバーレイと帝国全域が同じ上流の同じ境界解釈に
 * 載る（両者の食い違いが構造的に起きない）。
 *
 * ## 対象年
 * 1000 / 1100 年は同じ OHM 系列の領邦との境界整合に使う。1715 / 1783 / 1800 年は
 * base だけでは帝国外枠が成立しないため使う。1806 年の帝国解体後は対象外。
 *
 * 決定性の担保:
 * - 取得クエリはタグの完全一致だけで決まる（bbox に依存しない）
 * - 対象年ごとに有効なリレーションが複数出た場合は ID 昇順の先頭を採る
 * - 座標は COORD_PRECISION（配信データと同じ 3 桁）へ丸める。この生成物は
 *   flat 化などの派生を持たず**そのまま配信される**ため、raw 精度で持つ
 *   意味が無い（ADR-0037 の「配信される側で丸める」に一致する）
 *
 * ロジックは純粋関数として export しテスト対象にする
 * （scripts/build-hre-realm_test.ts。テストはネットワーク非依存）。
 */

import type { FeatureCollection } from "geojson";
import {
  COORD_PRECISION,
  shrinkToLimit,
  SIMPLIFY_TOLERANCES,
} from "./build-data.ts";
import { formatCleanStats, selfIntersectionPoints } from "./clean-polygons.ts";
import {
  buildGeometryQuery,
  isActiveAtYear,
  OHM_SOURCE_HOMEPAGE,
  OHM_SOURCE_LICENSE,
  OHM_SOURCE_URL,
  type OhmRelation,
  type OverpassResponse,
  relationGeometry,
} from "./build-france-fiefs.ts";
import { removePinchPointsFromCollection } from "./build-hre-fiefs.ts";
import { serializeWithAttribution } from "./build-attribution.ts";
import { SNAPSHOT_YEARS } from "../src/config.ts";

/**
 * 帝国全域を生成する年（#332）。src/config.ts の HRE_REALM_YEARS と同値
 * （src → scripts の import は行わない規約のため値を重複定義し、同値性は
 * 本スクリプトのテストで担保する）。
 */
export const HRE_REALM_YEARS: readonly number[] = [
  1000,
  1100,
  1715,
  1783,
  1800,
];

/** 帝国名。hre_<year> / hre_fiefs_<year> の SUBJECTO と同値 */
export const HRE_REALM_NAME = "Holy Roman Empire";

/**
 * 帝国全域リレーションを一意に決めるタグ条件。
 * - boundary=administrative / admin_level=2: 主権国家レベルの行政境界
 * - empire=hre: 帝国そのもの（配下の領邦は admin_level 4/5 で別物）
 * 実測では 23 件が該当し、うち 21 件が `Holy Roman Empire` の時間スライス、
 * 残り 2 件は帝国内の政体（Principality of Neuchâtel 1648〜1707、
 * Duchy of Bohemia 999〜1002）なので名前で落とす。
 */
export const HRE_REALM_TAG_FILTERS: readonly (readonly [string, string])[] = [
  ["boundary", "administrative"],
  ["admin_level", "2"],
  ["empire", "hre"],
];

/**
 * 帝国全域として採る name:en。時間スライスの一部は曖昧性解消の括弧付き
 * （`Holy Roman Empire (1512-1648)`）なので前方一致も許す。
 */
export function isHreRealmName(nameEn: string | undefined): boolean {
  if (typeof nameEn !== "string") return false;
  return nameEn === HRE_REALM_NAME || nameEn.startsWith(`${HRE_REALM_NAME} `);
}

/** 出力 1 ファイルあたりのサイズ上限（バイト）。hre_<year>.geojson と同値 */
export const HRE_REALM_SIZE_LIMIT_BYTES = 200 * 1000;

/** タグ条件だけで帝国全域リレーションを取得するクエリ（純粋関数） */
export function buildHreRealmTagsQuery(
  filters: readonly (readonly [string, string])[] = HRE_REALM_TAG_FILTERS,
): string {
  const selector = filters.map(([k, v]) => `["${k}"="${v}"]`).join("");
  return `[out:json][timeout:180];\n` +
    `relation${selector};\n` +
    `out tags;\n`;
}

/**
 * year 時点で有効な帝国全域リレーションを 1 件選ぶ（純粋関数）。
 * 名前で帝国そのものに絞り、start_date / end_date で年を絞る。
 * 複数残った場合は ID 昇順の先頭（取得順に依存しない）。該当なしは null。
 */
export function selectHreRealmForYear(
  elements: readonly OhmRelation[],
  year: number,
): OhmRelation | null {
  const candidates = elements.filter((element) => {
    const tags = element.tags ?? {};
    if (!isHreRealmName(tags["name:en"])) return false;
    return isActiveAtYear(tags["start_date"], tags["end_date"], year);
  });
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => a.id - b.id)[0];
}

/** buildRealmCollection の結果 */
export interface HreRealmCollection {
  fc: FeatureCollection;
  metadata: Record<string, unknown>;
}

/**
 * year 時点の帝国全域 FeatureCollection とメタデータを組み立てる（純粋関数）。
 *
 * properties は hre_fiefs_<year>.geojson と同じ形（NAME / SUBJECTO / PARTOF +
 * OHM 出典プロパティ）にする。SUBJECTO を帝国自身にすることで、外枠の宗主
 * キー解決（src/suzerain_extent.ts resolveSuzerainKey）が base の
 * `Holy Roman Empire` feature とまったく同じ規則でこの面を拾う
 * （帝国専用の分岐をランタイムへ持ち込まない）。
 */
export function buildRealmCollection(
  tagged: readonly OhmRelation[],
  geometries: ReadonlyMap<number, OhmRelation>,
  year: number,
): HreRealmCollection {
  const selected = selectHreRealmForYear(tagged, year);
  if (selected === null) {
    throw new Error(`${year} 年に有効な帝国全域リレーションがありません`);
  }
  const withGeometry = geometries.get(selected.id);
  if (withGeometry === undefined) {
    throw new Error(
      `relation ${selected.id}（${year} 年）のジオメトリを取得できませんでした`,
    );
  }
  const result = relationGeometry(withGeometry);
  if (result.geometry === null) {
    throw new Error(
      `relation ${selected.id}（${year} 年）から面を組み立てられませんでした`,
    );
  }
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {
        NAME: HRE_REALM_NAME,
        SUBJECTO: HRE_REALM_NAME,
        PARTOF: HRE_REALM_NAME,
        ADMIN_LEVEL: Number.parseInt(selected.tags["admin_level"], 10),
        OHM_RELATION_ID: selected.id,
        START_DATE: selected.tags["start_date"] ?? null,
        END_DATE: selected.tags["end_date"] ?? null,
        ...(year < 1715 ? { EXTENT_ONLY: true } : {}),
      },
      geometry: result.geometry,
    }],
  };
  return {
    fc,
    metadata: {
      source: "OpenHistoricalMap",
      sourceUrl: OHM_SOURCE_HOMEPAGE,
      license: OHM_SOURCE_LICENSE,
      year,
      relationId: selected.id,
      startDate: selected.tags["start_date"] ?? null,
      endDate: selected.tags["end_date"] ?? null,
      partCount: result.geometry.coordinates.length,
      missingWays: result.missingWays,
      unclosedRings: result.unclosedRings,
      droppedInnerRings: result.droppedInnerRings,
    },
  };
}

/** 生成先パス（純粋関数）。src/powers.ts hreRealmDataUrlFor と同値 */
export function hreRealmPathFor(year: number): string {
  return `data/hre_realm_${year}.geojson`;
}

/** Overpass の連続クエリの間に空ける待ち時間（ミリ秒）。レート制限対策 */
const OVERPASS_COOLDOWN_MS = 5_000;

/** Overpass に Overpass QL を POST して JSON を得る（429 / 504 は指数後退で再試行） */
async function runOverpass(
  query: string,
  attempts = 4,
): Promise<OverpassResponse> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await fetch(OHM_SOURCE_URL, {
      method: "POST",
      body: new URLSearchParams({ data: query }),
    });
    if (res.ok) return await res.json() as OverpassResponse;
    await res.body?.cancel();
    const retryable = res.status === 429 || res.status === 504;
    if (!retryable || attempt === attempts) {
      throw new Error(
        `Overpass への問い合わせに失敗しました (status ${res.status})`,
      );
    }
    const waitMs = OVERPASS_COOLDOWN_MS * 2 ** (attempt - 1);
    console.warn(`  Overpass ${res.status}: ${waitMs} ms 待って再試行します`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  throw new Error("到達しない");
}

async function main(): Promise<void> {
  for (const year of HRE_REALM_YEARS) {
    if (!SNAPSHOT_YEARS.includes(year)) {
      throw new Error(`${year} は SNAPSHOT_YEARS に含まれない年です`);
    }
  }
  // 1 段目: タグ条件だけで帝国全域の時間スライスを tags のみ取得（実測 23 件）
  const tagged = (await runOverpass(buildHreRealmTagsQuery())).elements;
  console.log(`tags: ${tagged.length} relations`);

  // 2 段目: 対象年で必要になるリレーションのジオメトリだけをまとめて 1 回取得
  const ids = new Set<number>();
  for (const year of HRE_REALM_YEARS) {
    const selected = selectHreRealmForYear(tagged, year);
    if (selected === null) {
      throw new Error(`${year} 年に有効な帝国全域リレーションがありません`);
    }
    ids.add(selected.id);
  }
  await new Promise((resolve) => setTimeout(resolve, OVERPASS_COOLDOWN_MS));
  const geomElements =
    (await runOverpass(buildGeometryQuery([...ids]))).elements;
  const geometries = new Map(geomElements.map((e) => [e.id, e]));
  console.log(`geom: ${geometries.size}/${ids.size} relations`);

  for (const year of HRE_REALM_YEARS) {
    const { fc, metadata } = buildRealmCollection(tagged, geometries, year);
    const { fc: shrunk, tolerance, cleanStats } = shrinkToLimit(
      fc,
      HRE_REALM_SIZE_LIMIT_BYTES,
      SIMPLIFY_TOLERANCES,
      COORD_PRECISION,
    );
    // 座標丸めで生じた「くびれ」を解消する（build-hre-fiefs.ts と同じ後処理。
    // data/ 全体の「自己交差ゼロ」不変条件 = scripts/clean-polygons_test.ts）
    const { fc: unpinched, removed, droppedFeatures } =
      removePinchPointsFromCollection(shrunk);
    const output = { ...unpinched, metadata };
    const outPath = hreRealmPathFor(year);
    const json = serializeWithAttribution(outPath, output);
    const finalBytes = new TextEncoder().encode(json).length;
    if (finalBytes > HRE_REALM_SIZE_LIMIT_BYTES) {
      throw new Error(`${outPath} が上限を超えました (${finalBytes} バイト)`);
    }
    const residual = unpinched.features.filter((feature) =>
      (feature.geometry.type === "Polygon" ||
        feature.geometry.type === "MultiPolygon") &&
      selfIntersectionPoints(feature.geometry).length > 0
    ).map((feature) => String(feature.properties?.NAME));
    if (residual.length > 0) {
      throw new Error(
        `${outPath} に自己交差が残りました: ${residual.join(", ")}`,
      );
    }

    await Deno.writeTextFile(outPath, json);
    console.log(
      `${outPath}: ${finalBytes} bytes, tolerance=${tolerance}, relation=${metadata.relationId}, parts=${metadata.partCount}`,
    );
    if (removed > 0) {
      console.log(`  くびれを解消: 重複頂点 ${removed} 個を除去`);
    }
    if (droppedFeatures.length > 0) {
      console.warn(`  面が残らず除外: ${droppedFeatures.join(", ")}`);
    }
    const cleanLog = formatCleanStats(cleanStats);
    if (cleanLog !== null) console.log(`  ${cleanLog.trim()}（くびれ解消前）`);
  }
}

if (import.meta.main) {
  await main();
}
