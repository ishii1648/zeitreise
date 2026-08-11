/**
 * 主要都市データパイプラインスクリプト（TASK-27 / TASK-66 / #221 / #222）。
 *
 * ## データソース（#222 でハイブリッド化）
 * - **主ソース: Buringh (2021) "European urban population, 700–2000"**
 *   （DANS Data Station SSH, DOI 10.17026/dans-xzy-u62q, CC0-1.0）。
 *   2,262 都市 × 19 年（700〜2000 の 50〜100 年グリッド）の完全グリッドで
 *   欠損セルが無く、スナップショット年がグリッドに無い年（1279/1492/1530/
 *   1715/1783/1815/1880/1914）も両側が必ず埋まっているため対数線形補間が
 *   常に成立する（= 歯抜けが構造的に起こらない）。人口下限
 *   BURINGH_MIN_POPULATION（5,000 人 = Bairoch 1988 の元来の収録基準）を
 *   年別に適用し、「一貫性」と「史実性」（例: ベルリンの中世 imputed 値を
 *   出さない）を両立させる。
 * - **補完ソース: Historical Urban Population（Chandler 系列、Reba, Reitsma &
 *   Seto 2016 のデジタル化、CC BY 4.0）**。Buringh は欧州限定のため、bbox 内でも
 *   欧州外縁（ニシャプール・カイラワーン・アレッポ・タブリーズ等）は Buringh に
 *   無い。3 段名寄せ（正式名 → 別名列 → 座標 15km）で Buringh に無い都市だけを
 *   従来ロジック（対応付け窓 + #221 の補間）で補完する。
 *
 * ## 取得の再現性（ADR-0001/0004 のピン留め方針との整合）
 * - Chandler: GitHub ミラーをコミット固定（CITIES_SOURCE_COMMIT）。
 * - Buringh: 上流の DANS Dataverse にはコミットの概念が無いため、DOI +
 *   ファイル ID（BURINGH_SOURCE_FILE_ID）で取得先を固定し、内容の SHA-256
 *   （BURINGH_SOURCE_SHA256）と行数（BURINGH_SOURCE_ROW_COUNT）を取得時に
 *   検証する。上流が差し替わった場合はビルドが fail し、「元データ更新で
 *   選定結果が勝手に変わらない」というピン留めの目的を同等に満たす。
 *   取得日は BURINGH_SOURCE_FETCHED_AT に記録する。
 *
 * ## 出力形式（#222 で正規化）
 * data/cities.json は「都市配列 + 年別セル」の正規化形式:
 *   { cities: [{name, lon, lat, source}], years: {"1000": [[index,
 *     population(, natureOfEstimate)], …]}, sources: [Buringh, Chandler] }
 * 従来の年ごとに name/lon/lat を繰り返す形式だと Buringh 併合（延べ約 2 万
 * セル）で約 1.6MB に膨らむが、正規化形式なら旧データ（0.53MB）より小さい。
 * 読み取り側は src/cities.ts の cityEntriesForYear が新形式を解決する。
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

// ---------------------------------------------------------------------------
// Buringh 2021（#222 の主ソース）の取得定数
// ---------------------------------------------------------------------------

/** Buringh 2021 データセットの DOI（DANS Data Station SSH） */
export const BURINGH_SOURCE_DOI = "10.17026/dans-xzy-u62q";
/** データファイル ID（DOI 配下の TSV。Dataverse API のファイル一覧で確認） */
export const BURINGH_SOURCE_FILE_ID = 20415;
/** 取得 URL（DOI + ファイル ID で固定） */
export const BURINGH_SOURCE_URL =
  `https://ssh.datastations.nl/api/access/datafile/${BURINGH_SOURCE_FILE_ID}`;
/** DOI のランディング URL（出典表示用） */
export const BURINGH_SOURCE_DOI_URL = `https://doi.org/${BURINGH_SOURCE_DOI}`;
/** ライセンス（Dataverse API で確認。CC0 のため帰属は義務ではないが明示する） */
export const BURINGH_SOURCE_LICENSE = "CC0-1.0";
/**
 * 取得内容の SHA-256。上流にコミット固定が無いため、内容ハッシュの検証で
 * ピン留めを代替する（ヘッダ doc コメント参照）。
 */
export const BURINGH_SOURCE_SHA256 =
  "d799dbeaafe7e00f897696cf828e55146394ae1bdd7618aee3d37d0364291a31";
/** データ行数（ヘッダ除く）。2,262 都市 × 19 年の完全グリッド */
export const BURINGH_SOURCE_ROW_COUNT = 42978;
/** 取得日（ピン留めハッシュを確認した日） */
export const BURINGH_SOURCE_FETCHED_AT = "2026-08-11";

/**
 * Buringh 側の人口下限（人）。年別に適用する。
 * Bairoch (1988) の元来の収録基準（5,000 人以上）と一致し、調査
 * （docs/research/2026-08-01-city-coverage-and-historical-names.md §4.1）では
 * この値で「一貫性」（ベオグラード全 19 年連続）と「史実性」（ベルリンの
 * 中世 imputed 値 1〜4 千人を表示しない）が両立する。
 */
export const BURINGH_MIN_POPULATION = 5000;

/** 名寄せ第 3 段（座標一致）の距離上限（km）。調査 §4.1 の実測と同じ値 */
export const BURINGH_MATCH_MAX_KM = 15;

/** 出力の source index: Buringh 2021（主ソース） */
export const CITY_SOURCE_BURINGH = 0;
/** 出力の source index: Chandler / Reba et al.（欧州外の補完） */
export const CITY_SOURCE_CHANDLER = 1;

/**
 * Buringh の都市名の既知の異常の正規化。実データ 2,262 都市中この 4 件のみ:
 * - "Warszawa, Warsaw, Worszewa, Werszewa": 別名列が name 列へ混入している
 * - "Pest (for >1900 see Buda)": 集計上の注記が名前に付いている
 * - "Armentieres (ArmentiÃ¨res)" / "Sete (SÈte)": 二重エンコードで壊れた
 *   別綴りの括弧書き（ASCII 綴りを採る）
 * - "Nove Za¡mky": Nové Zámky の文字化け（ASCII 綴りを採る）
 */
export const BURINGH_CITY_RENAMES: Readonly<Record<string, string>> = {
  "Warszawa, Warsaw, Worszewa, Werszewa": "Warsaw",
  "Pest (for >1900 see Buda)": "Pest",
  "Armentieres (ArmentiÃ¨res)": "Armentieres",
  "Sete (SÃ¨te)": "Sete",
  "Nove Za¡mky": "Nove Zamky",
};

/** 対応付け窓: スナップショット年から過去方向に許容する年数 */
export const PAST_WINDOW_YEARS = 50;
/**
 * 対応付け窓: 未来方向に許容する年数。過去より狭いのは、急成長期（19 世紀以降）
 * に未来の記録を使うと人口を大きく過大評価するため。
 */
export const FUTURE_WINDOW_YEARS = 25;

/**
 * 検証: 各年の都市数の下限。
 * #222 の併合後の最少年は 1000 年（Buringh 下限 5,000 で 121 件 + Chandler
 * 補完）。これを大きく割るのは名寄せ・下限・bbox の退行を疑うべき異常。
 */
export const MIN_CITIES_PER_YEAR = 100;
/**
 * 検証: 各年の都市数の上限。
 * 併合後の実測最大は 1914 年の約 2,150 件（Buringh 2,105 + Chandler 補完）。
 * Buringh の bbox 内都市数（約 2,230）+ Chandler 補完の上限を超えることは
 * 構造上ありえないため、2,500 を「併合ロジックの暴走（重複統合の破れ等）」の
 * 検知しきい値とする。
 */
export const MAX_CITIES_PER_YEAR = 2500;

/** 出力先パス */
export const CITIES_OUTPUT_PATH = "data/cities.json";

/**
 * 都市単位で除外する既知のデータ異常（Chandler 側）。
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
 * - #222: Buringh 側の名前にも適用する（名寄せ漏れで Buringh の綴り Gent 等が
 *   素通りしても「改名前の名前を出力しない」契約を守るため）
 * - #223: 年区間付きの時代別都市名（ハンガリー領期のベオグラード等）は表示側の
 *   data/city-names-historical.json + cityDisplayName(name, ja, year) が扱う。
 *   Istanbul → Constantinople はこの機構へ移さない: 本アプリの全スナップショット
 *   年（1000〜1914）で慣用名が Constantinople のままなので表示は変わらず、
 *   移すと cities.json の再生成と名寄せ・name-ja キーの付け替えだけが増えるため
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
  /** OtherName 列の別名（#222 の名寄せ第 2 段で使う） */
  otherNames: string[];
  lon: number;
  lat: number;
  /** 年（BC は負値）→ 人口 */
  records: Record<number, number>;
}

/** Buringh の 1 年分の記録 */
export interface BuringhRecord {
  population: number;
  /** natureofestimate: "" → null（実推定）/ imputed（補完）/ proxied（代理指標） */
  nature: "imputed" | "proxied" | null;
}

/** Buringh の 1 都市（19 年グリッドの記録を持つ） */
export interface BuringhCity {
  name: string;
  /** synonymsandhistoricalnames 列の別名 */
  synonyms: string[];
  country: string;
  lon: number;
  lat: number;
  /** グリッド年 → 記録（人口 0・空欄の年は持たない） */
  records: Record<number, BuringhRecord>;
}

/** 併合後の 1 都市マーカー（年別選定の中間表現） */
export interface CityMarker {
  name: string;
  lon: number;
  lat: number;
  population: number;
  /** 補間値は "imputed"、Buringh の代理指標推定は "proxied"、実推定は省略 */
  natureOfEstimate?: "imputed" | "proxied";
  /** CITY_SOURCE_BURINGH | CITY_SOURCE_CHANDLER。Chandler 単独選定では省略 */
  source?: number;
}

/** 正規化形式の都市定義（cities 配列の 1 要素） */
export interface CityDef {
  name: string;
  lon: number;
  lat: number;
  /** sources 配列への index（CITY_SOURCE_BURINGH | CITY_SOURCE_CHANDLER） */
  source: number;
}

/** 正規化形式の年別セル: [都市 index, 人口] または [都市 index, 人口, 性質] */
export type CityYearCell =
  | [number, number]
  | [number, number, "imputed" | "proxied"];

/** 出力 JSON 全体（A/B 契約の形式。#222 の正規化形式） */
export interface CitiesData {
  cities: CityDef[];
  years: Record<string, CityYearCell[]>;
  /** 出典（index が CityDef.source と対応）。詳細は buildCitiesData 参照 */
  sources: Record<string, unknown>[];
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
 * - OtherName 列は名寄せ（#222）用にカンマ区切りの別名リストとして保持する
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
    const otherNames = (record[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    rows.push({ name, otherNames, lon, lat, records });
  }
  return rows;
}

/** bbox（[west, south, east, north]）内の都市のみ残す（純粋関数） */
export function filterCitiesToBbox<
  T extends { lon: number; lat: number },
>(rows: T[], bbox: BBox): T[] {
  const [west, south, east, north] = bbox;
  return rows.filter(
    (row) =>
      row.lon >= west && row.lon <= east && row.lat >= south &&
      row.lat <= north,
  );
}

// ---------------------------------------------------------------------------
// Buringh TSV のパース（#222）
// ---------------------------------------------------------------------------

/** 欧州データセットとして妥当な座標レンジ（decodeBuringhCoordinate の候補判定） */
const BURINGH_PLAUSIBLE_RANGE = {
  lat: { min: 27, max: 72 },
  lon: { min: -32, max: 62 },
} as const;

/** 国別レンジに掛ける許容パディング（度）。国境沿い・港湾都市のはみ出し分 */
const BURINGH_COUNTRY_RANGE_PADDING_DEG = 1.5;

/**
 * Buringh の座標セルを数値へ復元する（純粋関数）。
 *
 * 実データの座標には 3 形態が混在する:
 * 1. カンマ小数点（"44,83"）… 大半。カンマを小数点に読み替える
 * 2. 整数の正当値（"44" / "0" / "-3"）… 小数部が 0 の座標
 * 3. **小数点が消えた値**（"53383" = 53.383、"-1467" = -1.467、
 *    "513330001831055" = 51.333…）… 上流の表計算由来の破損。約 60 セル
 *
 * 3 の復元は「10 のべき乗で割った候補のうち、欧州レンジ
 * （BURINGH_PLAUSIBLE_RANGE）内のもの」を列挙し、複数残る場合は同国の正常
 * セルから作った国別レンジに最も近い候補を採る（例: UK の "-1467" は
 * -14.67 と -1.467 が欧州レンジ内だが、UK のレンジは -1.467 だけを支持する）。
 * 一意に決められない値は null（黙って誤った座標にせず、都市ごと落として
 * 件数検証で気付けるようにする）。
 */
export function decodeBuringhCoordinate(
  raw: string,
  axis: "lat" | "lon",
  countryRange: { min: number; max: number } | null,
): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.includes(",") || trimmed.includes(".")) {
    const v = Number(trimmed.replace(",", "."));
    return Number.isFinite(v) ? v : null;
  }
  if (!/^-?\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  const digits = trimmed.replace("-", "");
  if (digits.length <= 2) return n;
  const plausible = BURINGH_PLAUSIBLE_RANGE[axis];
  const candidates: number[] = [];
  for (let k = 0; k < digits.length; k++) {
    const candidate = n / 10 ** k;
    if (
      candidate >= plausible.min && candidate <= plausible.max &&
      !candidates.includes(candidate)
    ) {
      candidates.push(candidate);
    }
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  if (countryRange === null) return null;
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let tied = false;
  for (const candidate of candidates) {
    const distance = candidate < countryRange.min
      ? countryRange.min - candidate
      : candidate > countryRange.max
      ? candidate - countryRange.max
      : 0;
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
      tied = false;
    } else if (distance === bestDistance) {
      tied = true;
    }
  }
  return tied ? null : best;
}

/** TSV フィールドの囲み引用符を外す */
function unquote(field: string): string {
  const trimmed = field.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') &&
      trimmed.length >= 2
    ? trimmed.slice(1, -1)
    : trimmed;
}

/** natureofestimate 列の語彙を正規化する */
function normalizeNature(value: string): "imputed" | "proxied" | null {
  return value === "imputed" || value === "proxied" ? value : null;
}

/**
 * Buringh の TSV をパースして BuringhCity の配列にする（純粋関数）。
 * - フィールドは引用符囲みの TSV。座標はカンマ小数点（一部は小数点消失。
 *   decodeBuringhCoordinate 参照）、人口は千人単位
 * - 都市は (name, 座標セル) 単位で集約する（同名別都市が 4 組ある:
 *   Belgorod / Brest / Nicosia / Oldenburg）
 * - 人口が空欄・0 の年は「記録なし」として落とす（グリッドの完全性より
 *   都市の実在を優先。0 人の都市を下限判定に掛ける意味が無い）
 * - 座標が復元できない都市は落とす（誤った位置に描くより欠けを選ぶ。
 *   ADR-0014 の「出典のない座標合成の禁止」と同じ姿勢）
 */
export function parseBuringhTsv(text: string): BuringhCity[] {
  const lines = text.split("\n")
    .map((line) => line.endsWith("\r") ? line.slice(0, -1) : line)
    .filter((line) => line !== "");
  if (lines.length <= 1) return [];
  const header = lines[0].split("\t").map(unquote);
  const col = (name: string): number => header.indexOf(name);
  const cCity = col("city");
  const cSynonyms = col("synonymsandhistoricalnames");
  const cCountry = col("country");
  const cLat = col("latitudeindegrees");
  const cLon = col("longitudeindegrees");
  const cYear = col("year");
  const cPop = col("inhabitantsin000-s");
  const cNature = col("natureofestimate");
  if ([cCity, cLat, cLon, cYear, cPop].some((i) => i < 0)) return [];

  interface RawCity {
    name: string;
    synonyms: string[];
    country: string;
    latRaw: string;
    lonRaw: string;
    cells: Array<{ year: number; population: number; nature: string }>;
  }
  const rawCities = new Map<string, RawCity>();
  for (const line of lines.slice(1)) {
    const fields = line.split("\t");
    const name = unquote(fields[cCity] ?? "");
    if (name === "") continue;
    const latRaw = unquote(fields[cLat] ?? "");
    const lonRaw = unquote(fields[cLon] ?? "");
    const key = `${name} ${latRaw} ${lonRaw}`;
    let city = rawCities.get(key);
    if (city === undefined) {
      city = {
        name,
        synonyms: (cSynonyms < 0 ? "" : unquote(fields[cSynonyms] ?? ""))
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== ""),
        country: cCountry < 0 ? "" : unquote(fields[cCountry] ?? ""),
        latRaw,
        lonRaw,
        cells: [],
      };
      rawCities.set(key, city);
    }
    const year = Number.parseFloat(unquote(fields[cYear] ?? ""));
    const popRaw = unquote(fields[cPop] ?? "");
    if (!Number.isFinite(year) || popRaw === "") continue;
    const population = Number.parseFloat(popRaw);
    if (!Number.isFinite(population) || population <= 0) continue;
    city.cells.push({
      year: Math.round(year),
      population: Math.round(population * 1000),
      nature: cNature < 0 ? "" : unquote(fields[cNature] ?? ""),
    });
  }

  // 国別レンジ: 復元不要なセル（カンマ小数点 / 2 桁以下の整数）だけから作る
  const ranges = new Map<
    string,
    { lat: { min: number; max: number }; lon: { min: number; max: number } }
  >();
  const reliable = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (trimmed.includes(",")) {
      const v = Number(trimmed.replace(",", "."));
      return Number.isFinite(v) ? v : null;
    }
    if (/^-?\d{1,2}$/.test(trimmed)) return Number(trimmed);
    return null;
  };
  for (const city of rawCities.values()) {
    const lat = reliable(city.latRaw);
    const lon = reliable(city.lonRaw);
    if (lat === null || lon === null) continue;
    const range = ranges.get(city.country) ?? {
      lat: { min: lat, max: lat },
      lon: { min: lon, max: lon },
    };
    range.lat.min = Math.min(range.lat.min, lat);
    range.lat.max = Math.max(range.lat.max, lat);
    range.lon.min = Math.min(range.lon.min, lon);
    range.lon.max = Math.max(range.lon.max, lon);
    ranges.set(city.country, range);
  }
  const padded = (
    range: { min: number; max: number } | undefined,
  ): { min: number; max: number } | null =>
    range === undefined ? null : {
      min: range.min - BURINGH_COUNTRY_RANGE_PADDING_DEG,
      max: range.max + BURINGH_COUNTRY_RANGE_PADDING_DEG,
    };

  const cities: BuringhCity[] = [];
  for (const raw of rawCities.values()) {
    const countryRange = ranges.get(raw.country);
    const lat = decodeBuringhCoordinate(
      raw.latRaw,
      "lat",
      padded(countryRange?.lat),
    );
    const lon = decodeBuringhCoordinate(
      raw.lonRaw,
      "lon",
      padded(countryRange?.lon),
    );
    if (lat === null || lon === null) continue;
    const records: Record<number, BuringhRecord> = {};
    for (const cell of raw.cells) {
      records[cell.year] = {
        population: cell.population,
        nature: normalizeNature(cell.nature),
      };
    }
    cities.push({
      name: BURINGH_CITY_RENAMES[raw.name] ?? raw.name,
      synonyms: raw.synonyms,
      country: raw.country,
      lon,
      lat,
      records,
    });
  }
  return cities;
}

/**
 * Buringh のグリッド記録からスナップショット年の値を得る（純粋関数）。
 * - グリッド年ちょうどなら実値と natureofestimate をそのまま返す
 * - グリッドに無い年（1279/1492/1530/1715/1783/1815/1880/1914）は前後の
 *   グリッド年から対数線形補間し、nature: "imputed" を付ける（#221 と同じ
 *   補間式。グリッドは完全なので 1000〜1914 の範囲では常に両側が埋まる）
 * - 片側にしか記録が無ければ null（外挿しない）
 */
export function buringhValueForYear(
  records: BuringhCity["records"],
  year: number,
): { population: number; nature: "imputed" | "proxied" | null } | null {
  const exact = records[year];
  if (exact !== undefined) {
    return { population: exact.population, nature: exact.nature };
  }
  const populations: Record<number, number> = {};
  for (const [key, record] of Object.entries(records)) {
    populations[Number(key)] = record.population;
  }
  const interpolated = interpolatePopulation(populations, year);
  if (interpolated === null) return null;
  return { population: interpolated, nature: "imputed" };
}

// ---------------------------------------------------------------------------
// 名寄せ（#222: 正式名 → 別名列 → 座標 15km の 3 段）
// ---------------------------------------------------------------------------

/** 2 点間の大円距離（km）。名寄せ第 3 段の座標一致に使う（純粋関数） */
export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371.0088;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 名寄せの段別件数（調査 §4.1 の実測との突き合わせ・ログ用） */
export interface MatchStats {
  byName: number;
  bySynonym: number;
  byCoordinate: number;
  unmatched: number;
}

/** matchChandlerToBuringh の結果 */
export interface MatchResult {
  /** Buringh index → 表示名（Chandler 側の英語慣用名を維持する） */
  matchedNames: Map<number, string>;
  /** どの段でも一致しなかった Chandler 行（補完ソースとして採用する） */
  unmatchedRows: CityRow[];
  stats: MatchStats;
}

/**
 * Chandler の各都市を Buringh へ 3 段で名寄せする（純粋関数。#222）。
 * 1. 正式名: Chandler の名前（CITY_RENAMES 適用後・適用前の両方）と Buringh の
 *    city 列の一致（大文字小文字を無視）
 * 2. 別名列: Chandler 名 × Buringh の synonymsandhistoricalnames、および
 *    Chandler の OtherName × Buringh の**正式名**の一致。OtherName × Buringh
 *    別名（別名同士）の照合はしない: 歴史名は同名別都市が多く（例: Nicaea は
 *    ニース（仏）とイズニク（土）双方の古名）、別名同士の一致は誤併合の
 *    危険が高すぎる
 * 3. 座標: BURINGH_MATCH_MAX_KM（15km）以内の最近傍
 *
 * 一致した Chandler 都市は Buringh 側へ吸収し（重複表示の防止 = AC4）、表示名は
 * Chandler 側の英語慣用名を維持する（Constantinople / Munich 等。既存の
 * 日本語表記マップのキーとも連続する）。同じ Buringh 都市に複数の Chandler
 * 行が一致した場合は**より確度の高い段で一致した行の名前**を採る（正式名 >
 * 別名 > 座標。例: Buringh の Malaga には Chandler の Bobastro が座標一致
 * するが、正式名一致の Malaga が表示名になる）。同段なら最初の行（入力順で
 * 決定的）。
 */
export function matchChandlerToBuringh(
  rows: CityRow[],
  buringh: BuringhCity[],
): MatchResult {
  const byName = new Map<string, number>();
  const bySynonym = new Map<string, number>();
  for (let i = 0; i < buringh.length; i++) {
    const key = buringh[i].name.toLowerCase();
    if (!byName.has(key)) byName.set(key, i);
    for (const synonym of buringh[i].synonyms) {
      const synKey = synonym.toLowerCase();
      if (!bySynonym.has(synKey)) bySynonym.set(synKey, i);
    }
  }
  const matchedNames = new Map<number, string>();
  /** 表示名を主張した段（1 = 正式名 / 2 = 別名 / 3 = 座標）。小さいほど優先 */
  const matchedStages = new Map<number, number>();
  const unmatchedRows: CityRow[] = [];
  const stats: MatchStats = {
    byName: 0,
    bySynonym: 0,
    byCoordinate: 0,
    unmatched: 0,
  };
  for (const row of rows) {
    // 既知のデータ異常行は名寄せにも使わない。座標一致で正常な Buringh 都市に
    // 異常行の名前（Gelibolu / Ruhr 等）を付けてしまうのを防ぐ
    if (EXCLUDED_CITY_NAMES.has(row.name)) continue;
    const displayName = CITY_RENAMES[row.name] ?? row.name;
    const ownNames = [...new Set([displayName, row.name])].map((n) =>
      n.toLowerCase()
    );
    let hit: number | undefined;
    let stage = 1;
    // 第 1 段: 正式名
    for (const name of ownNames) {
      hit = byName.get(name);
      if (hit !== undefined) break;
    }
    if (hit !== undefined) {
      stats.byName++;
    } else {
      // 第 2 段: 別名列（両方向）
      for (const name of ownNames) {
        hit = bySynonym.get(name);
        if (hit !== undefined) break;
      }
      if (hit === undefined) {
        for (const other of row.otherNames) {
          hit = byName.get(other.toLowerCase());
          if (hit !== undefined) break;
        }
      }
      if (hit !== undefined) {
        stats.bySynonym++;
        stage = 2;
      } else {
        // 第 3 段: 座標 15km 以内の最近傍
        let bestDistance = BURINGH_MATCH_MAX_KM;
        for (let i = 0; i < buringh.length; i++) {
          const distance = haversineKm(
            row.lat,
            row.lon,
            buringh[i].lat,
            buringh[i].lon,
          );
          if (distance <= bestDistance) {
            hit = i;
            bestDistance = distance;
          }
        }
        if (hit !== undefined) {
          stats.byCoordinate++;
          stage = 3;
        } else {
          stats.unmatched++;
          unmatchedRows.push(row);
          continue;
        }
      }
    }
    const claimed = matchedStages.get(hit);
    if (claimed === undefined || stage < claimed) {
      matchedNames.set(hit, displayName);
      matchedStages.set(hit, stage);
    }
  }
  return { matchedNames, unmatchedRows, stats };
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
  return b.population - a.population ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/**
 * Chandler 補完側: 1 つのスナップショット年の都市マーカーを選定する（純粋関数）。
 * 1. 既知異常（EXCLUDED_CITY_NAMES / EXCLUDED_RECORDS）を除外
 * 2. 最近傍記録の対応付け。窓内に記録が無くても前後に記録があれば対数線形補間で
 *    採用し、natureOfEstimate: "imputed" を付ける（Issue #221。記録年が飛び飛び
 *    なことによる年代間の歯抜けを解消する。片側外挿はしない）
 * 3. CITY_RENAMES で英語慣用名へ正規化
 * 4. 同名都市は人口最大の 1 件へ統合（Brest 仏/白露のような同名別都市の重複防止。
 *    勝った側の natureOfEstimate を維持する）
 * 5. 人口降順（同数なら name 昇順）に並べて全件返す（TASK-66。表示の間引きは
 *    表示側 src/cities.ts の責務）
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
    if (existing === undefined || existing.population < population) {
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

/**
 * 併合: 1 つのスナップショット年の都市マーカーを選定する（純粋関数。#222）。
 * 1. Buringh（主ソース）: buringhValueForYear で年の値を得て、人口下限
 *    BURINGH_MIN_POPULATION 以上の都市を採用。表示名は名寄せ済みなら
 *    Chandler 側の英語慣用名（matchedNames）、それ以外は Buringh の名前
 *    （CITY_RENAMES を適用し、改名前の綴りを出さない契約を守る）
 * 2. Chandler（補完）: 名寄せで Buringh に無かった行だけを従来ロジック
 *    （selectCitiesForYear）で選定
 * 3. 同名は人口最大の 1 件へ統合。同数なら先に並べた Buringh 側が勝つ
 *    （主ソース優先）
 * 4. 人口降順（同数なら name 昇順）
 */
export function selectMergedCitiesForYear(
  buringh: BuringhCity[],
  matchedNames: ReadonlyMap<number, string>,
  chandlerOnlyRows: CityRow[],
  year: number,
): CityMarker[] {
  const candidates: CityMarker[] = [];
  for (let i = 0; i < buringh.length; i++) {
    const value = buringhValueForYear(buringh[i].records, year);
    if (value === null || value.population < BURINGH_MIN_POPULATION) continue;
    const rawName = matchedNames.get(i) ?? buringh[i].name;
    const marker: CityMarker = {
      name: CITY_RENAMES[rawName] ?? rawName,
      lon: buringh[i].lon,
      lat: buringh[i].lat,
      population: value.population,
      source: CITY_SOURCE_BURINGH,
    };
    if (value.nature !== null) marker.natureOfEstimate = value.nature;
    candidates.push(marker);
  }
  for (const marker of selectCitiesForYear(chandlerOnlyRows, year)) {
    candidates.push({ ...marker, source: CITY_SOURCE_CHANDLER });
  }
  const byName = new Map<string, CityMarker>();
  for (const marker of candidates) {
    const existing = byName.get(marker.name);
    if (existing === undefined || existing.population < marker.population) {
      byName.set(marker.name, marker);
    }
  }
  return [...byName.values()].sort(byPopulationDescThenName);
}

// ---------------------------------------------------------------------------
// 正規化形式のエンコード/デコード（#222）
// ---------------------------------------------------------------------------

/** 都市の同一性キー（name + 座標 + source が同じなら同一都市） */
function cityKey(marker: CityMarker): string {
  return `${marker.name} ${marker.lon} ${marker.lat} ${marker.source ?? ""}`;
}

/**
 * 年別マーカーを正規化形式へエンコードする（純粋関数）。
 * 都市は初出順に cities 配列へ一度だけ載せ、年別は
 * [都市 index, 人口(, natureOfEstimate)] のセルで持つ。
 */
export function encodeCitiesData(
  byYear: Record<string, CityMarker[]>,
  sources: Record<string, unknown>[],
): CitiesData {
  const indexByKey = new Map<string, number>();
  const cities: CityDef[] = [];
  const years: Record<string, CityYearCell[]> = {};
  for (const [year, markers] of Object.entries(byYear)) {
    const cells: CityYearCell[] = [];
    for (const marker of markers) {
      const key = cityKey(marker);
      let index = indexByKey.get(key);
      if (index === undefined) {
        index = cities.length;
        cities.push({
          name: marker.name,
          lon: marker.lon,
          lat: marker.lat,
          source: marker.source ?? CITY_SOURCE_CHANDLER,
        });
        indexByKey.set(key, index);
      }
      cells.push(
        marker.natureOfEstimate === undefined
          ? [index, marker.population]
          : [index, marker.population, marker.natureOfEstimate],
      );
    }
    years[year] = cells;
  }
  return { cities, years, sources };
}

/**
 * 正規化形式から 1 年分のマーカー配列を復元する（純粋関数）。
 * encodeCitiesData の逆変換で、生成物の検証・テストが年別ビューで書けるように
 * する。不正セル（範囲外 index 等）は例外にせず落とす。
 */
export function decodeCityMarkersForYear(
  data: CitiesData,
  year: number,
): CityMarker[] {
  const cells = data.years[String(year)];
  if (!Array.isArray(cells)) return [];
  const markers: CityMarker[] = [];
  for (const cell of cells) {
    if (!Array.isArray(cell)) continue;
    const def = data.cities[cell[0]];
    if (def === undefined) continue;
    const marker: CityMarker = {
      name: def.name,
      lon: def.lon,
      lat: def.lat,
      population: cell[1],
      source: def.source,
    };
    if (cell[2] !== undefined) marker.natureOfEstimate = cell[2];
    markers.push(marker);
  }
  return markers;
}

/**
 * 全スナップショット年の出力データを組み立てる（純粋関数。#222）。
 * 名寄せ → 年別併合 → 正規化エンコード。sources には Buringh（主）と
 * Chandler/Reba（補完）を index 順（CITY_SOURCE_BURINGH / CITY_SOURCE_CHANDLER）
 * で刻む。source / sourceUrl / license は表示側（クリック情報パネルの
 * 出典欄）が読む契約のキー（scripts/build-attribution.ts と同じ語彙）。
 */
export function buildCitiesData(
  chandlerRows: CityRow[],
  buringhCities: BuringhCity[],
  years: readonly number[],
): CitiesData {
  const { matchedNames, unmatchedRows } = matchChandlerToBuringh(
    chandlerRows,
    buringhCities,
  );
  const byYear: Record<string, CityMarker[]> = {};
  for (const year of years) {
    byYear[String(year)] = selectMergedCitiesForYear(
      buringhCities,
      matchedNames,
      unmatchedRows,
      year,
    );
  }
  const sources: Record<string, unknown>[] = [];
  sources[CITY_SOURCE_BURINGH] = {
    source: "European urban population 700–2000 (Buringh 2021)",
    sourceUrl: BURINGH_SOURCE_DOI_URL,
    license: BURINGH_SOURCE_LICENSE,
    doi: BURINGH_SOURCE_DOI,
    fileId: BURINGH_SOURCE_FILE_ID,
    url: BURINGH_SOURCE_URL,
    sha256: BURINGH_SOURCE_SHA256,
    rowCount: BURINGH_SOURCE_ROW_COUNT,
    fetchedAt: BURINGH_SOURCE_FETCHED_AT,
    description:
      "Primary source. All European cities with an estimated population of " +
      `at least ${BURINGH_MIN_POPULATION} in the snapshot year (the ` +
      "threshold matches Bairoch 1988). Snapshot years absent from the " +
      "700–2000 grid are filled by log-linear interpolation and flagged " +
      'natureOfEstimate: "imputed"; the upstream natureofestimate column ' +
      '("" / imputed / proxied) is propagated for grid years.',
  };
  sources[CITY_SOURCE_CHANDLER] = {
    source:
      "Historical Urban Population (Reba, Reitsma & Seto 2016; Chandler 系列)",
    sourceUrl: `https://github.com/${CITIES_SOURCE_REPO}`,
    license: "CC BY 4.0",
    repo: CITIES_SOURCE_REPO,
    commit: CITIES_SOURCE_COMMIT,
    file: CITIES_SOURCE_FILE,
    url: buildCitiesSourceUrl(),
    description:
      "Supplement for cities absent from Buringh 2021 (matched by official " +
      "name → synonym list → coordinates within " +
      `${BURINGH_MATCH_MAX_KM} km; mostly cities outside Europe proper). ` +
      `Population records within -${PAST_WINDOW_YEARS}/+` +
      `${FUTURE_WINDOW_YEARS} years of the snapshot are used directly; ` +
      "gaps with records on both sides are filled by log-linear " +
      'interpolation and flagged natureOfEstimate: "imputed" — no ' +
      "one-sided extrapolation.",
  };
  return encodeCitiesData(byYear, sources);
}

/**
 * 出力データが A/B 契約を満たすか検証する（純粋関数）。
 * 違反メッセージの配列を返す（空配列なら合格）。
 * - 年キーが years と過不足なく一致
 * - 各年の都市数が MIN_CITIES_PER_YEAR〜MAX_CITIES_PER_YEAR 件
 * - 全都市が bbox 内・name 非空・source が sources 配列内の index
 * - 年内で都市 index / name の重複なし（#222 AC4）
 * - population は正の有限数
 * - どの年からも参照されない都市が cities 配列に残っていない
 * - Chandler 補完都市（source = CITY_SOURCE_CHANDLER）は初出年〜最終出現年の
 *   間のスナップショット年で欠落しない（内部ギャップゼロ。Issue #221 の補間で
 *   保証される契約）。Buringh 側は人口下限の年別適用が意図的に年を欠けさせる
 *   （下限未満の年は表示しない仕様）ため、この検査の対象にしない
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
  const nameSeen = new Set<string>();
  for (let i = 0; i < data.cities.length; i++) {
    const city = data.cities[i];
    if (city.name === "") errors.push(`cities[${i}] の name が空`);
    if (
      !Number.isFinite(city.lon) || !Number.isFinite(city.lat) ||
      city.lon < west || city.lon > east || city.lat < south ||
      city.lat > north
    ) {
      errors.push(
        `${city.name} が bbox 外: [${city.lon}, ${city.lat}]`,
      );
    }
    if (
      !Number.isInteger(city.source) || city.source < 0 ||
      city.source >= data.sources.length
    ) {
      errors.push(`${city.name} の source index が不正: ${city.source}`);
    }
    nameSeen.add(`${city.name} ${city.lon} ${city.lat}`);
  }
  if (nameSeen.size !== data.cities.length) {
    errors.push("cities 配列に同一 (name, 座標) の重複がある");
  }
  const referenced = new Set<number>();
  for (const [year, cells] of Object.entries(data.years)) {
    if (
      cells.length < MIN_CITIES_PER_YEAR || cells.length > MAX_CITIES_PER_YEAR
    ) {
      errors.push(
        `${year} 年の都市数 ${cells.length} が ${MIN_CITIES_PER_YEAR}〜${MAX_CITIES_PER_YEAR} 件の範囲外`,
      );
    }
    const indexSeen = new Set<number>();
    const yearNames = new Set<string>();
    for (const cell of cells) {
      if (!Array.isArray(cell) || cell.length < 2) {
        errors.push(`${year} 年に不正なセルがある: ${JSON.stringify(cell)}`);
        continue;
      }
      const [index, population, nature] = cell;
      const def = data.cities[index];
      if (!Number.isInteger(index) || def === undefined) {
        errors.push(`${year} 年に存在しない都市 index: ${index}`);
        continue;
      }
      referenced.add(index);
      if (indexSeen.has(index)) {
        errors.push(`${year} 年に都市 index 重複: ${index}（${def.name}）`);
      }
      indexSeen.add(index);
      if (yearNames.has(def.name)) {
        errors.push(`${year} 年に name 重複: ${def.name}`);
      }
      yearNames.add(def.name);
      if (!Number.isFinite(population) || population <= 0) {
        errors.push(
          `${year} 年の ${def.name} の population が不正: ${population}`,
        );
      }
      if (
        nature !== undefined && nature !== "imputed" && nature !== "proxied"
      ) {
        errors.push(
          `${year} 年の ${def.name} の natureOfEstimate が不正: ${nature}`,
        );
      }
    }
  }
  for (let i = 0; i < data.cities.length; i++) {
    if (!referenced.has(i)) {
      errors.push(
        `どの年からも参照されない都市がある: ${data.cities[i].name}`,
      );
    }
  }
  // 内部ギャップ検査（Issue #221）: Chandler 補完都市は初出年〜最終出現年の間の
  // 全スナップショット年に存在しなければならない（前後に記録があれば補間で
  // 埋まる契約）。Buringh 側は人口下限の年別適用による欠けが仕様なので対象外。
  const sortedYears = [...years].sort((a, b) => a - b);
  const appearanceIndices = new Map<number, number[]>();
  for (let i = 0; i < sortedYears.length; i++) {
    const cells = data.years[String(sortedYears[i])] ?? [];
    for (const cell of cells) {
      if (!Array.isArray(cell)) continue;
      const cityIndex = cell[0];
      if (data.cities[cityIndex]?.source !== CITY_SOURCE_CHANDLER) continue;
      const indices = appearanceIndices.get(cityIndex);
      if (indices === undefined) {
        appearanceIndices.set(cityIndex, [i]);
      } else {
        indices.push(i);
      }
    }
  }
  for (const [cityIndex, indices] of appearanceIndices) {
    const first = indices[0];
    const last = indices[indices.length - 1];
    if (indices.length === last - first + 1) continue;
    const present = new Set(indices);
    const missing = [];
    for (let i = first + 1; i < last; i++) {
      if (!present.has(i)) missing.push(sortedYears[i]);
    }
    errors.push(
      `${data.cities[cityIndex].name} が初出 ${sortedYears[first]} 年〜最終 ${
        sortedYears[last]
      } 年の間で欠落: ${missing.join(", ")} 年（内部ギャップ）`,
    );
  }
  return errors;
}

/** ピン留め URL から Chandler CSV テキストを取得する（Latin-1 エンコーディング） */
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

/**
 * Buringh の TSV を取得し、内容ハッシュと行数を検証する。
 * 上流にコミット固定が無いため、この検証がピン留めの代替になる
 * （ヘッダ doc コメント参照）。不一致なら fail し、上流の差し替えに気付ける。
 */
async function fetchBuringhTsvText(): Promise<string> {
  const res = await fetch(BURINGH_SOURCE_URL);
  if (!res.ok) {
    throw new Error(
      `${BURINGH_SOURCE_URL} の取得に失敗しました (status ${res.status})`,
    );
  }
  const buffer = await res.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (hex !== BURINGH_SOURCE_SHA256) {
    throw new Error(
      `Buringh TSV の SHA-256 がピン留め値と一致しません: ${hex}（上流が` +
        `差し替わった可能性。BURINGH_SOURCE_SHA256 の更新は選定結果の確認とセットで）`,
    );
  }
  const text = new TextDecoder("utf-8").decode(buffer);
  const rows = text.split("\n").filter((line) => line.trim() !== "").length - 1;
  if (rows !== BURINGH_SOURCE_ROW_COUNT) {
    throw new Error(
      `Buringh TSV の行数 ${rows} が期待値 ${BURINGH_SOURCE_ROW_COUNT} と異なります`,
    );
  }
  return text;
}

async function main(): Promise<void> {
  const [csvText, tsvText] = await Promise.all([
    fetchCsvText(),
    fetchBuringhTsvText(),
  ]);
  const chandlerRows = filterCitiesToBbox(
    parseChandlerCsv(csvText),
    EUROPE_BBOX,
  );
  const buringhCities = filterCitiesToBbox(
    parseBuringhTsv(tsvText),
    EUROPE_BBOX,
  );
  const { stats } = matchChandlerToBuringh(chandlerRows, buringhCities);
  console.log(
    `名寄せ: 正式名 ${stats.byName} / 別名 ${stats.bySynonym} / 座標 ${stats.byCoordinate} / 未マッチ ${stats.unmatched}` +
      `（Chandler ${chandlerRows.length} 行 × Buringh ${buringhCities.length} 都市）`,
  );
  const data = buildCitiesData(chandlerRows, buringhCities, SNAPSHOT_YEARS);
  const errors = validateCitiesData(data, SNAPSHOT_YEARS, EUROPE_BBOX);
  if (errors.length > 0) {
    throw new Error(`検証エラー:\n${errors.join("\n")}`);
  }
  // 正規化形式はセル数が多いため 1 行 JSON で書く（geojson 生成物と同じ扱い。
  // scripts/build-attribution.ts の serializeDataFile と揃えること）
  await Deno.writeTextFile(
    CITIES_OUTPUT_PATH,
    `${JSON.stringify(data)}\n`,
  );
  const counts = Object.entries(data.years)
    .map(([year, cells]) => `${year}:${cells.length}`)
    .join(" ");
  console.log(
    `${CITIES_OUTPUT_PATH} を生成しました（都市 ${data.cities.length} 件、${counts}）`,
  );
}

if (import.meta.main) {
  await main();
}
