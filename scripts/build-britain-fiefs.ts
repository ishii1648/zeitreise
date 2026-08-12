/**
 * ブリテン諸島（ウェールズ・アイルランド・周縁島嶼）の政体オーバーレイを
 * OpenHistoricalMap（OHM）から生成するデータパイプライン（TASK-151）。
 *
 * ## 背景
 * base（europe_<year>.geojson）はブリテン諸島を England（ないし
 * England and Ireland の一枚岩）と Scotland しか持たず、ウェールズ諸王国と
 * アイルランド諸王国は空白または England に内包される（TASK-39 が「上流の限界」
 * とした状態）。2026-07-30 の Overpass 実測で、分離に必要なリレーションが OHM に
 * 実在しジオメトリも健全であることを確認したため、build-france-fiefs.ts /
 * build-italy-fiefs.ts と同型のパイプラインで data/britain_fiefs_<year>.geojson を
 * 生成する（地図への表示は後続 TASK-153）。
 *
 * ## 既存 2 系統との違い: 許可リストは name ではなくリレーション ID
 * 仏・伊は「名前の許可リスト × admin_level × タグの存続区間」で選ぶが、本系統の
 * 収録対象は全て admin_level=2（主権政体）で、base が担う England / Scotland も
 * 同じ level に並ぶため、level では選別できない。また Kingdom of Ireland のように
 * 同名で存続区間の異なるリレーションが複数あるため、実測で確認した
 * **リレーション ID の静的な許可リスト**（BRITAIN_FIEF_ALLOWLIST。実測した
 * 存続区間つき）を唯一の真実とし、年の包含判定も許可リストに記録した区間で行う。
 * これにより「どの年に何が収録されるか」がネットワークに依存せず決まる（AC4）。
 * OHM 側のタグが実測から動いた場合は tagDrift として生成物の metadata に記録し、
 * 上流の変化に気付けるようにする（選別自体は動かさない）。
 *
 * ## 収録しない対象とその根拠（AC5）: BRITAIN_FIEF_EXCLUSIONS を参照
 *
 * ## データ側の限界（本タスクで解消できないもの・記録用）
 * - 1283〜1707 のウェールズは OHM にも Cliopatria にも独立実体として存在しない
 *   （Principality of Wales のリレーションが無い）。これは史実（1284 年
 *   ルデュラン法令でイングランド王直轄、1536 年併合法）と整合するため、
 *   欠落ではなく正しい表現に近い。
 * - アイルランドの Munster / Connacht / Ulster は OHM に無く、1000〜1200 の
 *   アイルランドは Leinster / Meath / Dublin による部分的な描画になる。
 * - Cliopatria にもウェールズ諸王国があるが境界が OHM の 4〜7 倍粗く、
 *   アイルランドの収録も薄いため、decision-13 / decision-17 の方針どおり
 *   OHM を主とする。
 *
 * 出典: OpenHistoricalMap（https://www.openhistoricalmap.org/）
 * ライセンス: CC0 1.0（パブリックドメイン）。仏・伊の諸侯領と同じ出典・同じ
 * 独立ファイル構成で、出典管理を単純に保つ。
 *
 * 決定性の担保:
 * - 取得クエリはリレーション ID（昇順・重複除去）だけで決まる
 * - 年ごとの収録は許可リストに記録した存続区間の包含判定だけで決まる
 * - feature の並びは英語名の昇順 → ID 昇順に固定する
 * - 座標は RAW_FIEF_COORD_PRECISION で丸める（raw は上流精度のまま保持し、
 *   配信される派生側で COORD_PRECISION へ落とす。ADR-0037）
 *
 * ロジックは純粋関数として export しテスト対象にする
 * （scripts/build-britain-fiefs_test.ts。テストはネットワーク非依存）。
 */

import type { FeatureCollection } from "geojson";
import {
  RAW_FIEF_COORD_PRECISION,
  shrinkToLimit,
  SIMPLIFY_TOLERANCES,
} from "./build-data.ts";
import { formatCleanStats, selfIntersectionPoints } from "./clean-polygons.ts";
import {
  buildGeometryQuery,
  type FiefBuildMetadata,
  isActiveAtYear,
  OHM_SOURCE_HOMEPAGE,
  OHM_SOURCE_LICENSE,
  OHM_SOURCE_URL,
  type OhmRelation,
  type OverpassResponse,
  relationGeometry,
} from "./build-france-fiefs.ts";
import { removePinchPointsFromCollection } from "./build-hre-fiefs.ts";
import { SNAPSHOT_YEARS } from "../src/config.ts";

/**
 * 実測に使った bbox（Overpass の順序: south, west, north, east）。
 * ブリテン諸島全域（アイルランド西岸〜シェトランド南部）を覆う。
 * 取得クエリ自体は ID 指定（buildGeometryQuery）で bbox を使わないが、
 * 許可リストの洗い出し（boundary=administrative の全件調査）に使った範囲を
 * 再調査の手掛かりとしてピン留めする。
 */
export const BRITAIN_FIEF_BBOX: readonly [number, number, number, number] = [
  49.5,
  -11.0,
  61.2,
  2.2,
];

/**
 * 生成対象年。SNAPSHOT_YEARS のうち 1000〜1700 の 12 年。
 * 全 12 年で許可リストのいずれかが有効になる（britainFiefIdsForYear の実測。
 * 件数は 1000=11 / 1100=9 / 1200=6 / 1279=5 / 1300=3 / 1400〜1530=2 /
 * 1600=3 / 1650=2 / 1700=2）。1715 以降を対象にしない理由は
 * BRITAIN_FIEF_EXCLUSIONS.baseAlreadySplitFrom1715 を参照。
 */
export const BRITAIN_FIEF_YEARS: readonly number[] = [
  1000,
  1100,
  1200,
  1279,
  1300,
  1400,
  1492,
  1500,
  1530,
  1600,
  1650,
  1700,
];

/** 出力 1 ファイルあたりのサイズ上限（バイト）。既存の諸侯領データと同値 */
export const BRITAIN_FIEF_SIZE_LIMIT_BYTES = 200 * 1000;

/** 許可リストの 1 エントリ（実測した OHM のタグ値のピン留め） */
export interface BritainFiefEntry {
  /** OHM の name:en（表示名にそのまま使う） */
  name: string;
  /** 実測した start_date（2026-07-30 時点の OHM タグ値） */
  startDate: string;
  /** 実測した end_date（同上） */
  endDate: string;
  /** 地域区分（記録用。選別には使わない） */
  region: "wales" | "ireland" | "isles";
}

/**
 * 採用するリレーション ID の静的な許可リスト（21 件・AC4）。
 * 全て bbox 内の boundary=administrative / admin_level=2 のリレーションで、
 * ID・存続区間とも 2026-07-30 に Overpass で実測した値をピン留めする。
 * 年ごとの収録はこの表の存続区間の包含判定**だけ**で決まる
 * （britainFiefIdsForYear）。OHM 側のタグが変わっても選別は動かず、
 * 差分は tagDrift として metadata に記録される。
 */
export const BRITAIN_FIEF_ALLOWLIST: Readonly<
  Record<number, BritainFiefEntry>
> = {
  // --- ウェールズ諸王国 ---
  2874011: {
    name: "Kingdom of Gwynedd",
    startDate: "0785",
    endDate: "1165",
    region: "wales",
  },
  2800203: {
    name: "Kingdom of Gwynedd",
    startDate: "1165",
    endDate: "1282-12-11",
    region: "wales",
  },
  2805938: {
    name: "Kingdom of Powys",
    startDate: "0430",
    endDate: "1160",
    region: "wales",
  },
  2798863: {
    name: "Southern Powys",
    startDate: "1160",
    endDate: "1283",
    region: "wales",
  },
  2803537: {
    name: "Deheubarth",
    startDate: "0920",
    endDate: "1197",
    region: "wales",
  },
  2803536: {
    name: "Brycheiniog",
    startDate: "0450",
    endDate: "1045",
    region: "wales",
  },
  2805408: {
    name: "Kingdom of Glywysing/Morgannwg",
    startDate: "0974",
    endDate: "1055",
    region: "wales",
  },
  2804440: {
    name: "Rhwng Gwy a Hafren",
    startDate: "0900",
    endDate: "1100",
    region: "wales",
  },
  // --- アイルランド諸政体 ---
  2851759: {
    name: "Kingdom of Dublin",
    startDate: "0853",
    endDate: "1170",
    region: "ireland",
  },
  2875840: {
    name: "Kingdom of Leinster",
    startDate: "0800",
    endDate: "1603",
    region: "ireland",
  },
  2875846: {
    name: "Kingdom of Meath",
    startDate: "0100",
    endDate: "1172-03",
    region: "ireland",
  },
  2875845: {
    name: "Lordship of Meath",
    startDate: "1172-03",
    endDate: "1244",
    region: "ireland",
  },
  2875843: {
    name: "Lordship of Eastern Meath",
    startDate: "1244",
    endDate: "1328",
    region: "ireland",
  },
  2875844: {
    name: "Lordship of Western Meath",
    startDate: "1244",
    endDate: "1328",
    region: "ireland",
  },
  2802031: {
    name: "Kingdom of Ireland",
    startDate: "1542-06-18",
    endDate: "1641-10-23",
    region: "ireland",
  },
  2697729: {
    name: "Kingdom of Ireland",
    startDate: "1660-04-04",
    endDate: "1800-12-31",
    region: "ireland",
  },
  2802030: {
    name: "Irish Catholic Confederation",
    startDate: "1642",
    endDate: "1652-05",
    region: "ireland",
  },
  // --- 島嶼・周縁 ---
  2869802: {
    name: "Kingdom of Strathclyde",
    startDate: "0870",
    endDate: "1030",
    region: "isles",
  },
  2869805: {
    name: "Kingdom of Galloway",
    startDate: "1034",
    endDate: "1235",
    region: "isles",
  },
  2851756: {
    name: "Sodor",
    startDate: "0877",
    endDate: "1265",
    region: "isles",
  },
  2693293: {
    name: "Isle of Man",
    startDate: "1333-08-09",
    endDate: "1987-05-15",
    region: "isles",
  },
};

/**
 * 収録を見送った対象の分類と根拠（AC5）。
 * bbox 内の boundary=administrative のうち対象年で有効な候補から、ここに挙げる
 * 分類で落とした残りが許可リスト 21 件になる。
 */
export const BRITAIN_FIEF_EXCLUSIONS: Record<string, string> = {
  sovereignsCoveredByBase:
    "base（europe_<year>.geojson）が主権勢力として全対象年で収録済みの政体。" +
    "Scotland は 1000〜1700 の全年代に base の feature があり、Kingdom of " +
    "Scotland（2802009）を足すと二重塗りになる。Kingdom of England（2802012）・" +
    "Commonwealth of England（2802013）も base の England / England and " +
    "Ireland が担う。本オーバーレイは「base に無い政体を足す」補完であり、" +
    "base と同じ主権政体は採らない。",
  baseAlreadySplitFrom1715:
    "1715 / 1783 / 1800 年は base が United Kingdom と Kingdom of Ireland を" +
    "分けて収録しており史実どおり。オーバーレイで足すものが無いため対象年を " +
    "1700 で止める。",
  ukConstituentsFrom1815:
    "1815 年以降の UK 構成国（admin_level=4 の Scotland 2697543 / 2874398、" +
    "England and Wales 2697737 / 2874397、Ireland 2697728）は主権政体ではなく" +
    "連合王国の内部区分で、封建諸侯領オーバーレイとは意味論が異なる" +
    "（凡例・レイヤー設計の判断を伴う）。別タスクで扱う。",
  principalityOfWalesAbsent:
    "1283〜1707 のウェールズ（Principality of Wales）は OHM にリレーションが" +
    "存在せず収録できない。史実（1284 年ルデュラン法令でイングランド王直轄、" +
    "1536 年併合法）と整合するため、欠落ではなく正しい表現に近い。" +
    "同様にアイルランドの Munster / Connacht / Ulster も OHM に無く、" +
    "1000〜1200 のアイルランドは部分的な描画になる（既知の制限）。",
};

/**
 * ID で明示的に落とす対象（リレーション ID → BRITAIN_FIEF_EXCLUSIONS のキー）。
 * 実測で bbox 内に確認した候補のうち収録しないものを ID で記録する
 * （採否の根拠をコード内に残す: AC5）。
 */
export const BRITAIN_FIEF_EXCLUDED_IDS: Readonly<Record<number, string>> = {
  2802009: "sovereignsCoveredByBase", // Kingdom of Scotland
  2802012: "sovereignsCoveredByBase", // Kingdom of England
  2802013: "sovereignsCoveredByBase", // Commonwealth of England
  2697543: "ukConstituentsFrom1815", // Scotland (lvl4, 1801-)
  2874398: "ukConstituentsFrom1815", // Scotland (lvl4)
  2697737: "ukConstituentsFrom1815", // England and Wales (lvl4)
  2874397: "ukConstituentsFrom1815", // England and Wales (lvl4)
  2697728: "ukConstituentsFrom1815", // Ireland (lvl4, 1801-1919)
};

/**
 * 収録しない対象なら、その根拠を返す（純粋関数）。収録するなら null。
 * 許可リスト BRITAIN_FIEF_ALLOWLIST とは独立に適用する二重の防波堤で、
 * 将来の許可リスト編集で base 側の主権政体や UK 構成国が紛れ込んでも生成物に
 * 入らないようにする（build-france-fiefs.ts の franceFiefExclusionReason と
 * 同じ方針）。
 */
export function britainFiefExclusionReason(id: number): string | null {
  const key = BRITAIN_FIEF_EXCLUDED_IDS[id];
  return key === undefined ? null : BRITAIN_FIEF_EXCLUSIONS[key];
}

/**
 * year 時点で有効な許可リストのリレーション ID を返す（純粋関数・AC4）。
 * 判定は許可リストに記録した存続区間（実測値）だけで行い、ネットワークにも
 * OHM の現在のタグにも依存しない。返り値は ID 昇順で決定的。
 */
export function britainFiefIdsForYear(
  year: number,
  allowlist: Readonly<Record<number, BritainFiefEntry>> =
    BRITAIN_FIEF_ALLOWLIST,
): number[] {
  return Object.entries(allowlist)
    .filter(([id, entry]) =>
      britainFiefExclusionReason(Number(id)) === null &&
      isActiveAtYear(entry.startDate, entry.endDate, year)
    )
    .map(([id]) => Number(id))
    .sort((a, b) => a - b);
}

/**
 * year 時点で収録するリレーションを選ぶ（純粋関数）。
 * britainFiefIdsForYear の ID 集合に一致する要素だけを残す（OHM のタグは
 * 判定に使わない: AC4）。返り値は表示名の昇順 → ID 昇順で入力順に依存しない。
 */
export function selectBritainFiefsForYear(
  elements: readonly OhmRelation[],
  year: number,
  allowlist: Readonly<Record<number, BritainFiefEntry>> =
    BRITAIN_FIEF_ALLOWLIST,
): OhmRelation[] {
  const active = new Set(britainFiefIdsForYear(year, allowlist));
  const selected = elements.filter((element) => active.has(element.id));
  return [...selected].sort((a, b) => {
    const nameDiff = allowlist[a.id].name.localeCompare(
      allowlist[b.id].name,
      "en",
    );
    return nameDiff !== 0 ? nameDiff : a.id - b.id;
  });
}

/**
 * OHM 側のタグが許可リストの実測値から動いていれば差分を文で返す（純粋関数）。
 * 動いていなければ null。選別は静的な許可リストが決めるため、この差分は
 * 生成物の metadata（tagDrift）と警告ログに記録するだけで、収録は変えない。
 * 名前は name:en が無ければ name にフォールバックして比較する（Brycheiniog /
 * Deheubarth / Rhwng Gwy a Hafren は name:en を持たず name が英語名。
 * build-italy-fiefs.ts の relationName と同じ扱い）。
 */
export function britainFiefTagDrift(
  element: OhmRelation,
  allowlist: Readonly<Record<number, BritainFiefEntry>> =
    BRITAIN_FIEF_ALLOWLIST,
): string | null {
  const entry = allowlist[element.id];
  if (entry === undefined) return null;
  const tags = element.tags ?? {};
  const drifts: string[] = [];
  const observed = {
    name: tags["name:en"] ?? tags["name"],
    start_date: tags["start_date"],
    end_date: tags["end_date"],
  };
  const recorded = {
    name: entry.name,
    start_date: entry.startDate,
    end_date: entry.endDate,
  };
  for (const key of ["name", "start_date", "end_date"] as const) {
    if (observed[key] !== recorded[key]) {
      drifts.push(
        `${key}: 実測 ${recorded[key]} -> 現在 ${observed[key] ?? "(欠損)"}`,
      );
    }
  }
  return drifts.length === 0 ? null : drifts.join(", ");
}

/** 生成物に埋め込むビルドメタデータ */
export interface BritainFiefBuildMetadata extends FiefBuildMetadata {
  /** OHM 側のタグが実測から動いたリレーション（ID → 差分の説明） */
  tagDrift: Record<string, string>;
}

/** buildYearCollection の結果 */
export interface BritainFiefYearCollection {
  fc: FeatureCollection;
  metadata: BritainFiefBuildMetadata;
}

/**
 * year 時点のブリテン諸島政体 FeatureCollection とメタデータを組み立てる
 * （純粋関数）。tagged は取得したリレーション（tags 付き）、geometries は
 * ID → メンバー付きリレーション。properties は france_fiefs_<year>.geojson と
 * 同じ形（NAME / ADMIN_LEVEL / OHM_RELATION_ID / START_DATE / END_DATE）で、
 * 後続の flat 化・表示タスクが既存 3 系統と同じ扱いにできる。
 * NAME と START/END_DATE は許可リストの実測値を使う（タグの変動に依存させず
 * 生成物を決定的にするため。タグとの差分は tagDrift に記録する）。
 */
export function buildYearCollection(
  tagged: readonly OhmRelation[],
  geometries: ReadonlyMap<number, OhmRelation>,
  year: number,
): BritainFiefYearCollection {
  const selected = selectBritainFiefsForYear(tagged, year);
  const features: FeatureCollection["features"] = [];
  const missingWays: Record<string, number[]> = {};
  const unclosedRings: Record<string, number> = {};
  const droppedInnerRings: Record<string, number> = {};
  const tagDrift: Record<string, string> = {};
  const relationsWithoutGeometry: number[] = [];
  for (const element of selected) {
    const entry = BRITAIN_FIEF_ALLOWLIST[element.id];
    const drift = britainFiefTagDrift(element);
    if (drift !== null) tagDrift[String(element.id)] = drift;
    const withGeometry = geometries.get(element.id);
    const result = withGeometry === undefined
      ? null
      : relationGeometry(withGeometry);
    if (result === null || result.geometry === null) {
      relationsWithoutGeometry.push(element.id);
      continue;
    }
    const key = String(element.id);
    if (result.missingWays.length > 0) missingWays[key] = result.missingWays;
    if (result.unclosedRings > 0) unclosedRings[key] = result.unclosedRings;
    if (result.droppedInnerRings > 0) {
      droppedInnerRings[key] = result.droppedInnerRings;
    }
    features.push({
      type: "Feature",
      properties: {
        NAME: entry.name,
        ADMIN_LEVEL: 2,
        OHM_RELATION_ID: element.id,
        START_DATE: entry.startDate,
        END_DATE: entry.endDate,
      },
      geometry: result.geometry,
    });
  }
  relationsWithoutGeometry.sort((a, b) => a - b);
  return {
    fc: { type: "FeatureCollection", features },
    metadata: {
      source: "OpenHistoricalMap",
      sourceUrl: OHM_SOURCE_HOMEPAGE,
      license: OHM_SOURCE_LICENSE,
      year,
      featureCount: features.length,
      missingWays,
      unclosedRings,
      droppedInnerRings,
      tagDrift,
      relationsWithoutGeometry,
    },
  };
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
  for (const year of BRITAIN_FIEF_YEARS) {
    if (!SNAPSHOT_YEARS.includes(year)) {
      throw new Error(`${year} は SNAPSHOT_YEARS に含まれない年です`);
    }
  }
  // 許可リストは ID が確定しているため、tags 全件取得（1 段目）は不要で、
  // 全対象年で必要になるリレーションのジオメトリを 1 回の geom クエリで取る
  // （out geom は tags も返すので、選別・drift 検出にも同じ応答を使う）
  const ids = new Set<number>();
  for (const year of BRITAIN_FIEF_YEARS) {
    for (const id of britainFiefIdsForYear(year)) ids.add(id);
  }
  const elements = (await runOverpass(buildGeometryQuery([...ids]))).elements;
  const geometries = new Map(elements.map((e) => [e.id, e]));
  console.log(`geom: ${geometries.size}/${ids.size} relations`);

  for (const year of BRITAIN_FIEF_YEARS) {
    const { fc, metadata } = buildYearCollection(elements, geometries, year);
    const { fc: shrunk, tolerance, cleanStats } = shrinkToLimit(
      fc,
      BRITAIN_FIEF_SIZE_LIMIT_BYTES,
      SIMPLIFY_TOLERANCES,
      // raw は上流精度のまま保持する（丸めは配信される派生側で行う。ADR-0037）
      RAW_FIEF_COORD_PRECISION,
    );
    // 座標丸めで生じた「くびれ」を解消する（build-italy-fiefs.ts と同じ理由で、
    // data/ 全体の「自己交差ゼロ」不変条件を満たすのに必要）
    const { fc: unpinched, removed, droppedFeatures } =
      removePinchPointsFromCollection(shrunk);
    // メタデータは simplify / truncate の後に付け直す（欠損を生成物に記録）
    const output = { ...unpinched, metadata };
    const outPath = `data/britain_fiefs_${year}.geojson`;
    const json = JSON.stringify(output);
    const finalBytes = new TextEncoder().encode(json).length;
    if (finalBytes > BRITAIN_FIEF_SIZE_LIMIT_BYTES) {
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
      `${outPath}: ${finalBytes} bytes, tolerance=${tolerance}, features=${unpinched.features.length}`,
    );
    console.log(
      `  ${
        unpinched.features.map((f) => String(f.properties?.NAME)).join(" / ")
      }`,
    );
    if (removed > 0) {
      console.log(`  くびれを解消: 重複頂点 ${removed} 個を除去`);
    }
    if (droppedFeatures.length > 0) {
      console.warn(`  面が残らず除外: ${droppedFeatures.join(", ")}`);
    }
    const cleanLog = formatCleanStats(cleanStats);
    if (cleanLog !== null) console.log(`  ${cleanLog.trim()}（くびれ解消前）`);
    const warnings = [
      ...Object.entries(metadata.missingWays).map(([id, ways]) =>
        `  欠損 way: relation ${id} -> ${ways.join(",")}`
      ),
      ...Object.entries(metadata.unclosedRings).map(([id, count]) =>
        `  強制クローズしたリング: relation ${id} -> ${count}`
      ),
      ...Object.entries(metadata.droppedInnerRings).map(([id, count]) =>
        `  破棄した内環: relation ${id} -> ${count}`
      ),
      ...Object.entries(metadata.tagDrift).map(([id, drift]) =>
        `  タグが実測から変化: relation ${id} -> ${drift}`
      ),
      ...(metadata.relationsWithoutGeometry.length > 0
        ? [`  ジオメトリ未取得: ${metadata.relationsWithoutGeometry.join(",")}`]
        : []),
    ];
    for (const warning of warnings) console.warn(warning);
  }
}

if (import.meta.main) {
  await main();
}
