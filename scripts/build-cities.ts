/**
 * 主要都市データパイプラインスクリプト（TASK-27 / TASK-66）。
 * - Historical Urban Population データセット（Chandler 系列）の chandler.csv を
 *   GitHub ミラーから取得（コミット固定）
 * - ヨーロッパ bbox（EUROPE_BBOX）内の都市に絞る
 * - スナップショット年ごとに「過去 50 年〜未来 25 年の最近傍の人口記録」を対応付け、
 *   対応付け可能な候補を全件採用する（TASK-66。従来の「人口上位
 *   CITIES_PER_YEAR=23 件 + 独語圏最低 6 件」の選定は廃止。画面上の間引きは
 *   表示側（src/cities.ts のズーム別表示制御）の責務に移した）
 * - data/cities.json（年 → 都市マーカー配列）を生成する
 *
 * データソース選定の経緯:
 * - 第一候補の Reba, Reitsma & Seto (2016) "Spatializing 6,000 years of global
 *   urbanization from 3700 BC to AD 2000"（Sci. Data 3:160034, DOI
 *   10.7927/H4ZG6QBX, CC BY 4.0）を採用した。原本ホストの NASA SEDAC は
 *   Earthdata ログイン必須で匿名の安定 URL が得られないため、同データの入力
 *   CSV（Chandler のデジタル化）を含む GitHub ミラー
 *   fasiha/Historical-Urban-Population-Growth-Data をコミット固定で参照する。
 * - 検証結果: 欧州 bbox 内で人口記録を持つ候補プールは全 682 行。各スナップ
 *   ショット年の対応付け・統合後の採用数は 1000 年 85 件 → 1200 年 147 件 →
 *   1500 年 228 件 → 1880 年 609 件（ピン留めコミットでの実測。TASK-66 の
 *   全件採用 + Issue #221 の内部ギャップ補間後。900 年は TASK-119 で
 *   スナップショット年ごと廃止）。
 *
 * 対応付け・整形ルール:
 * - 記録年は飛び飛びのため、各スナップショット年に対し過去 PAST_WINDOW_YEARS 年・
 *   未来 FUTURE_WINDOW_YEARS 年の窓内で年差最小の記録を採用する（同差なら過去优
 *   先）。未来側を狭くするのは、産業革命以降の急成長期に未来の記録を割り当てる
 *   と人口を大きく過大評価するため（例: Samara の 1950 年記録を 1900 年に採用
 *   すると 7 倍以上の過大評価になる）。
 * - 窓内に記録が無くても、対象年を挟む前後に記録があれば対数線形補間で採用し、
 *   natureOfEstimate: "imputed" を付けて実測と区別する（Issue #221。片側にしか
 *   記録が無い場合は外挿せず落とす）。
 * - 既知のデータ異常は EXCLUDED_CITY_NAMES / EXCLUDED_RECORDS で除外する
 *   （根拠は各定数の doc コメント参照）。
 * - 都市名は英語の慣用名へ CITY_RENAMES で正規化する（Istanbul→Constantinople 等）。
 *   日本語表記は data/name-ja.json 側で付与する。
 *
 * ロジックは純粋関数として export しテスト対象にする（scripts/build-cities_test.ts）。
 */

import type { BBox } from "geojson";
import { parse } from "@std/csv/parse";
import { SNAPSHOT_YEARS } from "../src/config.ts";
import { EUROPE_BBOX } from "./build-data.ts";

/** 取得元リポジトリ（Reba et al. 2016 の入力 CSV を含むミラー） */
export const CITIES_SOURCE_REPO =
  "fasiha/Historical-Urban-Population-Growth-Data";
/** 取得元のピン留めコミット。元データ更新で選定結果が勝手に変わらないよう固定する */
export const CITIES_SOURCE_COMMIT = "808ff2b4a279013f58621a3696cb9c28058c6af1";
/** 取得元ファイル。Chandler "Four Thousand Years of Urban Growth" のデジタル化 */
export const CITIES_SOURCE_FILE = "chandler.csv";
/** 元データセットのライセンス（NASA SEDAC 配布時のライセンス） */
export const CITIES_SOURCE_LICENSE =
  "CC BY 4.0 (Historical Urban Population, v1; Reba, Reitsma & Seto 2016)";

/** 対応付け窓: スナップショット年から過去方向に許容する年数 */
export const PAST_WINDOW_YEARS = 50;
/**
 * 対応付け窓: 未来方向に許容する年数。過去より狭いのは、急成長期（19 世紀以降）
 * に未来の記録を使うと人口を大きく過大評価するため。
 */
export const FUTURE_WINDOW_YEARS = 25;

// TASK-66 で削除した選定定数の記録（削除理由）:
// - CITIES_PER_YEAR（23）: 「人口上位 N 件」の切り詰め自体を廃止したため不要。
//   最遠ズームの表示件数は表示側（src/cities.ts）が自前の定数で制御する設計で、
//   パイプライン側に件数上限を残す意味がない。
// - GERMAN_REGION_BBOX / GERMAN_REGION_MIN_CITIES（TASK-55）: 独語圏の下限確保は
//   「上位選定で独語圏が選外に落ちる」ことへの補正だった。全件採用では独語圏
//   候補も常に全件含まれるため、下限確保は恒真となり不要。
// - HRE_DISSOLUTION_YEAR（1806、TASK-61）: 独語圏下限確保の適用年代を区切る
//   ためだけの定数で、下限確保の廃止に伴い不要。

/**
 * 検証: 各年の都市数の下限。
 * TASK-66 で「人口上位 15〜25 件」の契約から「候補全件」の契約へ改定した。
 * 元データの薄い 1000〜1100 年の実測は 44〜59 件（最少は 1100 年の 44 件。
 * TASK-119 で 900 年を廃止する前の最少はデータ最古の 900 年の 20 件だった）。
 * 下限 15 は当時の最少年に多少の余裕を持たせた検知しきい値として維持する
 * （これを割るのは対応付け窓や bbox の退行を疑うべき異常）。
 */
export const MIN_CITIES_PER_YEAR = 15;
/**
 * 検証: 各年の都市数の上限。
 * 全件採用での実測最大は 1880 年の 609 件（ピン留めコミットの chandler.csv、
 * 欧州 bbox 内の候補プールは全 682 行）。プール全行を超えることは構造上あり
 * えないため、700 を「対応付けロジックの暴走（窓の拡大・重複統合の破れ等）」
 * の検知しきい値とする。
 */
export const MAX_CITIES_PER_YEAR = 700;

/** 出力先パス */
export const CITIES_OUTPUT_PATH = "data/cities.json";

/**
 * 都市単位で除外する既知のデータ異常。
 * - Gelibolu: 全記録が Istanbul と同値の重複行（1000 年に 300,000 は明らかな誤り）
 * - Qum: Qom と同一都市の別表記重複（Qom 行を採用）
 * - Ruhr: 都市ではなく工業地帯の集計値（単一マーカーとして表示できない）
 */
export const EXCLUDED_CITY_NAMES: ReadonlySet<string> = new Set([
  "Gelibolu",
  "Qum",
  "Ruhr",
]);

/**
 * 記録単位で除外する既知のデータ異常（都市自体は他の年で有効）。
 * - Algiers 1925: 2,220,000 は桁誤り（同時期の実人口は約 220,000）
 * - Iznik 1800: 125,000 は誤記録（19 世紀のイズニクは数千人規模の小邑）
 */
export const EXCLUDED_RECORDS: ReadonlyArray<{ name: string; year: number }> = [
  { name: "Algiers", year: 1925 },
  { name: "Iznik", year: 1800 },
];

/**
 * 英語の慣用名への正規化マップ。
 * - Istanbul→Constantinople: 公式改名は 1930 年で、本アプリの全スナップショット年
 *   （1000〜1914）では英語圏の慣用名は Constantinople
 * - その他は元データの現地語綴りを英語の慣用綴りへ（Genova→Genoa 等）
 * - Augsberg は元データの誤綴り（正: Augsburg）、Nurnberg は英語慣用綴りの
 *   Nuremberg へ（TASK-55 で HRE 域内都市が採用されるようになったため追加）
 * - 以下は TASK-66 の全件採用で新たに出力へ露出した誤名称・誤綴りの正規化:
 *   - Louveigne: 座標（4.70E, 50.88N）・OtherName（Louvain）とも Leuven を指す
 *     （Louveigné はリエージュ近郊の別の村）。英語慣用名 Louvain へ
 *   - Meckenbeuren: 座標（11.41E, 53.63N）・OtherName（Schwerin）とも Schwerin
 *     を指す（Meckenbeuren はボーデン湖畔の別の村）
 *   - Weisbaden: Wiesbaden の誤綴り（座標は Wiesbaden）
 *   - Brunn: 独語綴り Brünn の ASCII 化。英語慣用名は Brno
 *   - Mulhausen: 独語綴り Mülhausen の ASCII 化。英語慣用名は Mulhouse
 *     （ドイツの Muhlhausen = Mühlhausen とは別都市で、正規化により両者の
 *     取り違えも防ぐ）
 */
export const CITY_RENAMES: Readonly<Record<string, string>> = {
  Istanbul: "Constantinople",
  Genova: "Genoa",
  Brussel: "Brussels",
  Gent: "Ghent",
  Brugge: "Bruges",
  Augsberg: "Augsburg",
  Nurnberg: "Nuremberg",
  Louveigne: "Louvain",
  Meckenbeuren: "Schwerin",
  Weisbaden: "Wiesbaden",
  Brunn: "Brno",
  Mulhausen: "Mulhouse",
};

/** chandler.csv の 1 行（人口記録を 1 つ以上持つ都市） */
export interface CityRow {
  name: string;
  lon: number;
  lat: number;
  /** 年（BC は負値）→ 人口 */
  records: Record<number, number>;
}

/** 出力 JSON の都市マーカー（A/B 契約の形式） */
export interface CityMarker {
  name: string;
  lon: number;
  lat: number;
  population: number | null;
  /**
   * 人口値の性質（Issue #221）。実測記録由来なら省略、前後の記録からの
   * 対数線形補間なら "imputed"。語彙は Buringh 2021 の natureofestimate 列
   * （"" / imputed / proxied）に合わせ、将来の別ソース併合で拡張できるようにする。
   */
  natureOfEstimate?: "imputed";
}

/** 出力 JSON 全体（A/B 契約の形式） */
export interface CitiesData {
  years: Record<string, CityMarker[]>;
  source: {
    description: string;
    license: string;
    [key: string]: unknown;
  };
}

/** ピン留めコミットの raw CSV URL を生成する（純粋関数） */
export function buildCitiesSourceUrl(): string {
  return `https://raw.githubusercontent.com/${CITIES_SOURCE_REPO}/${CITIES_SOURCE_COMMIT}/${CITIES_SOURCE_FILE}`;
}

/**
 * chandler.csv をパースして CityRow の配列にする（純粋関数）。
 * - ヘッダの AD_YYYY / BC_YYYY 列を年（BC は負値）として読む
 * - 座標が数値でない行・人口記録が 1 つもない行は除外する
 * - 人口は整数へ丸める（元データに少数の小数値がある）
 */
export function parseChandlerCsv(text: string): CityRow[] {
  const table = parse(text);
  if (table.length === 0) return [];
  const header = table[0];
  const yearCols: Array<{ index: number; year: number }> = [];
  for (let i = 0; i < header.length; i++) {
    const h = header[i];
    if (h.startsWith("AD_")) {
      yearCols.push({ index: i, year: Number(h.slice(3)) });
    } else if (h.startsWith("BC_")) {
      yearCols.push({ index: i, year: -Number(h.slice(3)) });
    }
  }
  const rows: CityRow[] = [];
  for (const record of table.slice(1)) {
    const name = record[0];
    const lat = Number.parseFloat(record[3]);
    const lon = Number.parseFloat(record[4]);
    if (name === "" || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue;
    }
    const records: Record<number, number> = {};
    for (const { index, year } of yearCols) {
      const value = index < record.length ? record[index].trim() : "";
      if (value === "") continue;
      const population = Number.parseFloat(value);
      if (Number.isFinite(population) && population > 0) {
        records[year] = Math.round(population);
      }
    }
    if (Object.keys(records).length === 0) continue;
    rows.push({ name, lon, lat, records });
  }
  return rows;
}

/** bbox（[west, south, east, north]）内の都市のみ残す（純粋関数） */
export function filterCitiesToBbox(rows: CityRow[], bbox: BBox): CityRow[] {
  const [west, south, east, north] = bbox;
  return rows.filter(
    (row) =>
      row.lon >= west && row.lon <= east && row.lat >= south &&
      row.lat <= north,
  );
}

/**
 * スナップショット年に対応する最近傍の人口記録を選ぶ（純粋関数）。
 * 過去 pastWindow 年・未来 futureWindow 年の窓内で年差最小の記録を返す。
 * 年差が同じ場合は過去の記録を優先する（未来の記録は過大評価しやすいため）。
 * 窓内に記録がなければ null。
 */
export function pickNearestRecord(
  records: Record<number, number>,
  targetYear: number,
  pastWindow: number = PAST_WINDOW_YEARS,
  futureWindow: number = FUTURE_WINDOW_YEARS,
): { year: number; population: number } | null {
  let best: { year: number; population: number } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestIsFuture = true;
  for (const key of Object.keys(records)) {
    const year = Number(key);
    const delta = year - targetYear;
    if (delta < -pastWindow || delta > futureWindow) continue;
    const distance = Math.abs(delta);
    const isFuture = delta > 0;
    if (
      distance < bestDistance ||
      (distance === bestDistance && bestIsFuture && !isFuture)
    ) {
      best = { year, population: records[year] };
      bestDistance = distance;
      bestIsFuture = isFuture;
    }
  }
  return best;
}

/**
 * 対象年を挟む直近の前後の記録から人口を対数線形補間する（純粋関数。Issue #221）。
 * (y0, p0) = 対象年より過去で最も近い記録、(y1, p1) = 未来で最も近い記録とし、
 * round(exp(ln(p0) + (ln(p1) − ln(p0)) × (targetYear − y0) / (y1 − y0))) を返す。
 * 人口成長は指数的なため、線形補間より対数線形の方が中間年の推定として自然。
 *
 * 境界:
 * - 片側にしか記録が無ければ null（外挿はしない。Issue #221 のスコープ外）
 * - p0 ≦ 0 または p1 ≦ 0 は対数が定義できないため null
 *   （parseChandlerCsv は人口 > 0 の記録のみ残すため実データでは起きない防御）
 * - y0 === y1 は「対象年を挟む」前提から構造上起こらない。また対象年ちょうどの
 *   記録がある場合は pickNearestRecord が必ず窓内で拾うため、本関数は呼ばれない
 *   前提（呼ばれても対象年の記録は前後どちらにも数えず無視する）
 */
export function interpolatePopulation(
  records: Record<number, number>,
  targetYear: number,
): number | null {
  let y0 = Number.NEGATIVE_INFINITY;
  let y1 = Number.POSITIVE_INFINITY;
  for (const key of Object.keys(records)) {
    const year = Number(key);
    if (year < targetYear && year > y0) y0 = year;
    if (year > targetYear && year < y1) y1 = year;
  }
  if (!Number.isFinite(y0) || !Number.isFinite(y1)) return null;
  const p0 = records[y0];
  const p1 = records[y1];
  if (p0 <= 0 || p1 <= 0) return null;
  return Math.round(
    Math.exp(
      Math.log(p0) +
        (Math.log(p1) - Math.log(p0)) * (targetYear - y0) / (y1 - y0),
    ),
  );
}

/** 人口降順・同数なら name 昇順の比較関数（選定順序の唯一の定義） */
function byPopulationDescThenName(a: CityMarker, b: CityMarker): number {
  return (b.population ?? 0) - (a.population ?? 0) ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/**
 * 1 つのスナップショット年の都市マーカーを選定する（純粋関数）。
 * 1. 既知異常（EXCLUDED_CITY_NAMES / EXCLUDED_RECORDS）を除外
 * 2. 最近傍記録の対応付け。窓内に記録が無くても前後に記録があれば対数線形補間で
 *    採用し、natureOfEstimate: "imputed" を付ける（Issue #221。記録年が飛び飛び
 *    なことによる年代間の歯抜けを解消する。片側外挿はしない）
 * 3. CITY_RENAMES で英語慣用名へ正規化
 * 4. 同名都市は人口最大の 1 件へ統合（Brest 仏/白露のような同名別都市の重複防止。
 *    勝った側の natureOfEstimate を維持する）
 * 5. 人口降順（同数なら name 昇順）に並べて全件返す（TASK-66。従来の
 *    「上位 CITIES_PER_YEAR 件 + 独語圏下限確保」は廃止。ズームレベルに応じた
 *    表示件数の間引きは表示側 src/cities.ts の責務）
 */
export function selectCitiesForYear(
  rows: CityRow[],
  year: number,
): CityMarker[] {
  const byName = new Map<string, CityMarker>();
  for (const row of rows) {
    if (EXCLUDED_CITY_NAMES.has(row.name)) continue;
    const records = { ...row.records };
    for (const excluded of EXCLUDED_RECORDS) {
      if (excluded.name === row.name) delete records[excluded.year];
    }
    const picked = pickNearestRecord(records, year);
    let population: number;
    let imputed: boolean;
    if (picked !== null) {
      population = picked.population;
      imputed = false;
    } else {
      const interpolated = interpolatePopulation(records, year);
      if (interpolated === null) continue;
      population = interpolated;
      imputed = true;
    }
    const name = CITY_RENAMES[row.name] ?? row.name;
    const existing = byName.get(name);
    if (existing === undefined || (existing.population ?? 0) < population) {
      const marker: CityMarker = {
        name,
        lon: row.lon,
        lat: row.lat,
        population,
      };
      if (imputed) marker.natureOfEstimate = "imputed";
      byName.set(name, marker);
    }
  }
  return [...byName.values()].sort(byPopulationDescThenName);
}

/** 全スナップショット年の出力データを組み立てる（純粋関数） */
export function buildCitiesData(
  rows: CityRow[],
  years: readonly number[],
): CitiesData {
  const byYear: Record<string, CityMarker[]> = {};
  for (const year of years) {
    byYear[String(year)] = selectCitiesForYear(rows, year);
  }
  return {
    years: byYear,
    source: {
      description: "European cities per snapshot year (all cities with a " +
        `population record within -${PAST_WINDOW_YEARS}/+` +
        `${FUTURE_WINDOW_YEARS} years of the snapshot, sorted by population; ` +
        "cities without a record in the window but with records on both " +
        "sides are kept via log-linear interpolation and flagged " +
        'natureOfEstimate: "imputed" — no one-sided extrapolation), ' +
        "derived from the Historical Urban Population dataset (Chandler, " +
        "digitized by Reba, Reitsma & Seto 2016, DOI 10.7927/H4ZG6QBX)",
      license: CITIES_SOURCE_LICENSE,
      repo: CITIES_SOURCE_REPO,
      commit: CITIES_SOURCE_COMMIT,
      file: CITIES_SOURCE_FILE,
      url: buildCitiesSourceUrl(),
    },
  };
}

/**
 * 出力データが A/B 契約を満たすか検証する（純粋関数）。
 * 違反メッセージの配列を返す（空配列なら合格）。
 * - 年キーが years と過不足なく一致
 * - 各年の都市数が MIN_CITIES_PER_YEAR〜MAX_CITIES_PER_YEAR 件
 * - 全マーカーが bbox 内・name 非空・年内で name 重複なし
 * - population は null か正の有限数
 * - 各都市が初出年〜最終出現年の間のスナップショット年で欠落しない
 *   （内部ギャップゼロ。Issue #221 の補間で保証される契約）
 */
export function validateCitiesData(
  data: CitiesData,
  years: readonly number[],
  bbox: BBox,
): string[] {
  const errors: string[] = [];
  const expectedKeys = years.map((year) => String(year));
  const actualKeys = Object.keys(data.years);
  for (const key of expectedKeys) {
    if (!actualKeys.includes(key)) errors.push(`年キー ${key} が存在しない`);
  }
  for (const key of actualKeys) {
    if (!expectedKeys.includes(key)) {
      errors.push(`SNAPSHOT_YEARS にない年キー ${key} がある`);
    }
  }
  const [west, south, east, north] = bbox;
  for (const [year, markers] of Object.entries(data.years)) {
    if (
      markers.length < MIN_CITIES_PER_YEAR ||
      markers.length > MAX_CITIES_PER_YEAR
    ) {
      errors.push(
        `${year} 年の都市数 ${markers.length} が ${MIN_CITIES_PER_YEAR}〜${MAX_CITIES_PER_YEAR} 件の範囲外`,
      );
    }
    const seen = new Set<string>();
    for (const marker of markers) {
      if (marker.name === "") errors.push(`${year} 年に空の name がある`);
      if (seen.has(marker.name)) {
        errors.push(`${year} 年に name 重複: ${marker.name}`);
      }
      seen.add(marker.name);
      if (
        !Number.isFinite(marker.lon) || !Number.isFinite(marker.lat) ||
        marker.lon < west || marker.lon > east || marker.lat < south ||
        marker.lat > north
      ) {
        errors.push(
          `${year} 年の ${marker.name} が bbox 外: [${marker.lon}, ${marker.lat}]`,
        );
      }
      if (
        marker.population !== null &&
        (!Number.isFinite(marker.population) || marker.population <= 0)
      ) {
        errors.push(
          `${year} 年の ${marker.name} の population が不正: ${marker.population}`,
        );
      }
    }
  }
  // 内部ギャップ検査（Issue #221）: 各都市は初出年〜最終出現年の間の全スナップ
  // ショット年に存在しなければならない（前後に記録があれば補間で埋まる契約）。
  const sortedYears = [...years].sort((a, b) => a - b);
  const appearanceIndices = new Map<string, number[]>();
  for (let i = 0; i < sortedYears.length; i++) {
    const markers = data.years[String(sortedYears[i])] ?? [];
    for (const marker of markers) {
      const indices = appearanceIndices.get(marker.name);
      if (indices === undefined) {
        appearanceIndices.set(marker.name, [i]);
      } else {
        indices.push(i);
      }
    }
  }
  for (const [name, indices] of appearanceIndices) {
    const first = indices[0];
    const last = indices[indices.length - 1];
    if (indices.length === last - first + 1) continue;
    const present = new Set(indices);
    const missing = [];
    for (let i = first + 1; i < last; i++) {
      if (!present.has(i)) missing.push(sortedYears[i]);
    }
    errors.push(
      `${name} が初出 ${sortedYears[first]} 年〜最終 ${
        sortedYears[last]
      } 年の` +
        `間で欠落: ${missing.join(", ")} 年（内部ギャップ）`,
    );
  }
  return errors;
}

/** ピン留め URL から CSV テキストを取得する（Latin-1 エンコーディング） */
async function fetchCsvText(): Promise<string> {
  const url = buildCitiesSourceUrl();
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url} の取得に失敗しました (status ${res.status})`);
  }
  // 元 CSV は Latin-1（OtherName 列に非 UTF-8 バイトを含む）。
  // 採用する City 列は ASCII のみであることをパイプライン検証で確認済み。
  const buffer = await res.arrayBuffer();
  return new TextDecoder("iso-8859-1").decode(buffer);
}

async function main(): Promise<void> {
  const csvText = await fetchCsvText();
  const rows = filterCitiesToBbox(parseChandlerCsv(csvText), EUROPE_BBOX);
  const data = buildCitiesData(rows, SNAPSHOT_YEARS);
  const errors = validateCitiesData(data, SNAPSHOT_YEARS, EUROPE_BBOX);
  if (errors.length > 0) {
    throw new Error(`検証エラー:\n${errors.join("\n")}`);
  }
  await Deno.writeTextFile(
    CITIES_OUTPUT_PATH,
    `${JSON.stringify(data, null, 2)}\n`,
  );
  const counts = Object.entries(data.years)
    .map(([year, markers]) => `${year}:${markers.length}`)
    .join(" ");
  console.log(`${CITIES_OUTPUT_PATH} を生成しました（${counts}）`);
}

if (import.meta.main) {
  await main();
}
