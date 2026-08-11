/**
 * 起動時データローダ群（TASK-145。main.ts から抽出）。
 *
 * 年代非依存の静的データ 9 件（colors / name-overrides / name-ja /
 * fief-dedupe / rivers / mountains / peaks / cities / known-limitations）を
 * fetch し、共通形（fetch → parse → 失敗時 warn + フォールバック値）を
 * {@linkcode fetchJson} に集約する。
 *
 * **縮退契約（decision-29 / docs/main-ts-inventory.md §2 U2 の不変条件）**:
 * 取得失敗・未生成・不正形のときは console.warn を出してフォールバック値を
 * 返し、例外を外へ漏らさず継続する。**warn 文言は 1 文字も変えない**
 * （ヘッドレス検証やユーザーのログ確認が文言に依存し得る）。文言は
 * data_loading_test.ts が完全一致で固定している。
 *
 * decision-29 の方針どおり、このモジュールは module-scope の可変状態を
 * 持たない。従来の「モジュール変数へ直接代入する副作用型」から返り値型へ
 * 整理し、モジュール変数への代入（状態の所有）と成功時フックの発火
 * （known-limitations の reveal）は main.ts 側に残す。fetch は
 * 依存注入（省略時は本番の fetch）でテスト時に差し替える。
 */
import type { FeatureCollection } from "geojson";
import { EMPTY_FEATURE_COLLECTION } from "./powers.ts";
import {
  EMPTY_SUZERAIN_OVERRIDES,
  parseSuzerainOverrides,
  type SuzerainOverrides,
} from "./suzerain_extent.ts";
import {
  EMPTY_FIEF_DEDUPE_TABLE,
  FIEF_DEDUPE_DATA_URL,
  type FiefDedupeTable,
  parseFiefDedupeTable,
} from "./fief_dedupe.ts";
import { RIVERS_DATA_URL } from "./rivers.ts";
import { MOUNTAINS_DATA_URL } from "./mountains.ts";
import { PEAKS_DATA_URL } from "./peaks.ts";
import { CITIES_DATA_URL, type CitiesData } from "./cities.ts";
import {
  KNOWN_LIMITATIONS_DATA_URL,
  type KnownLimitation,
  parseKnownLimitations,
} from "./known_limitations.ts";

/** fetch の注入型（テストでは URL → Response のスタブを渡す） */
export type FetchLike = (url: string) => Promise<Response>;

/**
 * URL から JSON を取得する共通ヘルパ。HTTP エラー（!ok）は
 * `status <code>` を持つ例外にして投げ、非 JSON 応答は res.json() の
 * 例外をそのまま伝播する。縮退（warn + フォールバック）は各ローダが行う。
 */
async function fetchJson(url: string, fetchFn: FetchLike): Promise<unknown> {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return await res.json();
}

/** colors.json を取得する。失敗時は空マップを返しデフォルト色で継続する */
export async function loadColors(
  fetchFn: FetchLike = fetch,
): Promise<Record<string, string>> {
  try {
    return await fetchJson("/data/colors.json", fetchFn) as Record<
      string,
      string
    >;
  } catch (error) {
    console.warn(
      `colors.json の取得に失敗しました。デフォルト色で継続します: ${
        String(error)
      }`,
    );
    return {};
  }
}

/**
 * name-overrides.json を取得する。失敗時は補正なし
 * （EMPTY_SUZERAIN_OVERRIDES と同一参照）を返し SUBJECTO 生値で継続する。
 * ラベル整形（displayLabel）が SUBJECTO の綴りゆれを正規化するのに使い、
 * 宗主補正（suzerains）は勢力圏の外枠・色キー・表示ラベルで使う（TASK-94）。
 */
export async function loadOverrides(
  fetchFn: FetchLike = fetch,
): Promise<SuzerainOverrides> {
  try {
    return parseSuzerainOverrides(
      await fetchJson("/data/name-overrides.json", fetchFn),
    );
  } catch (error) {
    console.warn(
      `name-overrides.json の取得に失敗しました。SUBJECTO 生値で継続します: ${
        String(error)
      }`,
    );
    return EMPTY_SUZERAIN_OVERRIDES;
  }
}

/**
 * name-ja.json（英語 NAME → 日本語名）を取得する（TASK-23）。
 * 失敗時は空マップを返し英語表記で継続する。
 */
export async function loadNameJa(
  fetchFn: FetchLike = fetch,
): Promise<Record<string, string>> {
  try {
    return await fetchJson("/data/name-ja.json", fetchFn) as Record<
      string,
      string
    >;
  } catch (error) {
    console.warn(
      `name-ja.json の取得に失敗しました。英語表記で継続します: ${
        String(error)
      }`,
    );
    return {};
  }
}

/**
 * fief-dedupe.json（諸侯領による base 勢力の被覆率表）を取得する（TASK-78）。
 * 失敗・未生成・不正形のときは空表（EMPTY_FIEF_DEDUPE_TABLE と同一参照）を
 * 返し、base ラベルの抑制を一切行わない（= TASK-78 以前の表示。colors.json
 * 等と同じ縮退方針）。
 */
export async function loadFiefDedupe(
  fetchFn: FetchLike = fetch,
): Promise<FiefDedupeTable> {
  try {
    return parseFiefDedupeTable(await fetchJson(FIEF_DEDUPE_DATA_URL, fetchFn));
  } catch (error) {
    console.warn(
      `fief-dedupe.json の取得に失敗しました。諸侯領と base の二重ラベルを抑制せず継続します: ${
        String(error)
      }`,
    );
    return EMPTY_FIEF_DEDUPE_TABLE;
  }
}

/**
 * rivers.geojson（主要河川ライン）を取得する（TASK-24）。
 * 失敗時は空 FeatureCollection（EMPTY_FEATURE_COLLECTION と同一参照）を返し
 * 河川なしで継続する（colors.json 等と同様）。
 */
export async function loadRivers(
  fetchFn: FetchLike = fetch,
): Promise<FeatureCollection> {
  try {
    return await fetchJson(RIVERS_DATA_URL, fetchFn) as FeatureCollection;
  } catch (error) {
    console.warn(
      `rivers.geojson の取得に失敗しました。河川なしで継続します: ${
        String(error)
      }`,
    );
    return EMPTY_FEATURE_COLLECTION;
  }
}

/**
 * mountains.geojson（主要山脈ポリゴン）を取得する（TASK-97）。
 * 失敗・未生成時は空 FeatureCollection を返し山脈ラベルなしで継続する
 * （河川と同じ縮退方針）。
 */
export async function loadMountains(
  fetchFn: FetchLike = fetch,
): Promise<FeatureCollection> {
  try {
    return await fetchJson(MOUNTAINS_DATA_URL, fetchFn) as FeatureCollection;
  } catch (error) {
    console.warn(
      `mountains.geojson の取得に失敗しました。山脈ラベルなしで継続します: ${
        String(error)
      }`,
    );
    return EMPTY_FEATURE_COLLECTION;
  }
}

/**
 * peaks.geojson（主要山峰の Point）を取得する（TASK-99）。
 * 失敗・未生成時は空 FeatureCollection を返し山峰なしで継続する
 * （河川・山脈と同じ縮退方針）。形の検証は表示時の peakEntries が行うため、
 * ここでは丸ごと保持する。
 */
export async function loadPeaks(
  fetchFn: FetchLike = fetch,
): Promise<FeatureCollection> {
  try {
    return await fetchJson(PEAKS_DATA_URL, fetchFn) as FeatureCollection;
  } catch (error) {
    console.warn(
      `peaks.geojson の取得に失敗しました。山峰なしで継続します: ${
        String(error)
      }`,
    );
    return EMPTY_FEATURE_COLLECTION;
  }
}

/**
 * cities.json（年 → 主要都市配列）を取得する（TASK-27）。
 * 失敗・未生成時は空データを返し都市なしで継続する（colors.json 等と同様）。
 * 形の検証は表示時の cityEntriesForYear が行うため、ここでは丸ごと保持する。
 */
export async function loadCities(
  fetchFn: FetchLike = fetch,
): Promise<CitiesData> {
  try {
    return await fetchJson(CITIES_DATA_URL, fetchFn) as CitiesData;
  } catch (error) {
    console.warn(
      `cities.json の取得に失敗しました。都市なしで継続します: ${
        String(error)
      }`,
    );
    return { cities: [], years: {} };
  }
}

/**
 * known-limitations.json（データの既知の制限一覧）を取得する（TASK-46）。
 * 失敗・未生成・全件不正のときは空配列を返す。main.ts は空のとき
 * revealKnownLimitations を発火させないためトグルボタンごと非表示になる
 * （従来表示を一切変えない）。
 */
export async function loadKnownLimitations(
  fetchFn: FetchLike = fetch,
): Promise<KnownLimitation[]> {
  try {
    const parsed = parseKnownLimitations(
      await fetchJson(KNOWN_LIMITATIONS_DATA_URL, fetchFn),
    );
    if (parsed.length === 0) throw new Error("limitations が空または不正");
    return parsed;
  } catch (error) {
    console.warn(
      `known-limitations.json の取得に失敗しました。制限事項なしで継続します: ${
        String(error)
      }`,
    );
    return [];
  }
}

/**
 * {@linkcode startStartupDataLoad} が返す、開始済みの静的データ取得 Promise 群。
 * キーは main.ts が所有するモジュール変数（colors / overrides / …）に対応する。
 */
export interface StartupDataPromises {
  colors: Promise<Record<string, string>>;
  overrides: Promise<SuzerainOverrides>;
  nameJa: Promise<Record<string, string>>;
  fiefDedupe: Promise<FiefDedupeTable>;
  rivers: Promise<FeatureCollection>;
  mountains: Promise<FeatureCollection>;
  peaks: Promise<FeatureCollection>;
  cities: Promise<CitiesData>;
  knownLimitations: Promise<KnownLimitation[]>;
}

/**
 * 起動データ（年代非依存の静的 9 件）の取得を一括で開始する（#249 AC1）。
 *
 * 返り値は「開始済みの Promise」の束で、この関数の呼び出しと同期に全 9 件の
 * fetch が始まる（map の load イベントや他データの完了を待たない）。各 Promise
 * は対応するローダ（{@linkcode loadColors} 等）の縮退契約をそのまま持つ:
 * 失敗時は warn を出してフォールバック値へ **解決** し、決して reject しない。
 * したがって消費側（main.ts の initPowerLayer）が await するまで保持しても
 * unhandled rejection にはならない。
 *
 * decision-29: この関数もモジュールスコープの可変状態を持たないファクトリで
 * あり、開始済み Promise の所有（モジュール変数としての保持）と結果の反映は
 * 従来どおり main.ts 側が行う。
 */
export function startStartupDataLoad(
  fetchFn: FetchLike = fetch,
): StartupDataPromises {
  return {
    colors: loadColors(fetchFn),
    overrides: loadOverrides(fetchFn),
    nameJa: loadNameJa(fetchFn),
    fiefDedupe: loadFiefDedupe(fetchFn),
    rivers: loadRivers(fetchFn),
    mountains: loadMountains(fetchFn),
    peaks: loadPeaks(fetchFn),
    cities: loadCities(fetchFn),
    knownLimitations: loadKnownLimitations(fetchFn),
  };
}
