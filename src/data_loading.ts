/**
 * 起動時データローダ群（TASK-145。main.ts から抽出）。
 *
 * 年代非依存の静的データ 9 件（colors / name-overrides / name-ja /
 * fief-dedupe / rivers / mountains / marine / peaks / cities）を
 * fetch し、共通形（fetch → parse → 任意データは warn + フォールバック値）を
 * {@linkcode fetchJson} に集約する。
 *
 * **縮退契約（decision-29 / docs/main-ts-inventory.md §2 U2）**:
 * 任意データは取得失敗時に console.warn とフォールバック値で継続する。
 * colors と起動時の name-overrides は正しい政治色キーに必須なので失敗を外へ
 * 伝え、全グレーや未補正の色へ固定しない。
 * 任意データの **warn 文言は 1 文字も変えない**
 * （ヘッドレス検証やユーザーのログ確認が文言に依存し得る）。文言は
 * data_loading_test.ts が完全一致で固定している。
 *
 * decision-29 の方針どおり、このモジュールは module-scope の可変状態を
 * 持たない。従来の「モジュール変数へ直接代入する副作用型」から返り値型へ
 * 整理し、モジュール変数への代入（状態の所有）は main.ts 側に残す。fetch は
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
import { MARINE_DATA_URL } from "./marine.ts";
import { CITIES_DATA_URL, type CitiesData } from "./cities.ts";

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

/**
 * colors.json を取得する。正しい政治色に必須なので、失敗時は reject し、
 * 呼び出し側の起動エラー UI から再読み込みで復帰させる。
 */
export async function loadColors(
  fetchFn: FetchLike = fetch,
): Promise<Record<string, string>> {
  const raw = await fetchJson("/data/colors.json", fetchFn);
  if (
    raw === null || typeof raw !== "object" || Array.isArray(raw) ||
    Object.keys(raw).length === 0 ||
    Object.values(raw).some((value) => typeof value !== "string")
  ) {
    throw new Error("colors.json が空または不正な形式です");
  }
  return raw as Record<string, string>;
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

/** 起動時の政治色キー用。通常の任意縮退をせず最終失敗を呼び出し側へ伝える。 */
async function loadRequiredOverrides(
  fetchFn: FetchLike,
): Promise<SuzerainOverrides> {
  const parsed = parseSuzerainOverrides(
    await fetchJson("/data/name-overrides.json", fetchFn),
  );
  if (
    Object.keys(parsed.renames).length === 0 &&
    Object.keys(parsed.suzerains).length === 0
  ) {
    throw new Error("name-overrides.json が空または不正な形式です");
  }
  return parsed;
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

/** 海域ラベルアンカー。失敗時は海域名なしで起動を継続する。 */
export async function loadMarineLabels(
  fetchFn: FetchLike = fetch,
): Promise<FeatureCollection> {
  try {
    return await fetchJson(MARINE_DATA_URL, fetchFn) as FeatureCollection;
  } catch (error) {
    console.warn(
      `marine-labels.geojson の取得に失敗しました。海域ラベルなしで継続します: ${
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
  marine: Promise<FeatureCollection>;
  peaks: Promise<FeatureCollection>;
  cities: Promise<CitiesData>;
}

/** 政治ポリゴンを正しい色で描く前に必要な静的データ。 */
export interface CriticalStartupData {
  readonly colors: Record<string, string>;
  readonly overrides: SuzerainOverrides;
}

/**
 * 起動データを必須系と後追い可能系に分け、必須系だけを待つ。
 * nameJa / fiefDedupe / rivers / mountains / marine / peaks / cities は
 * main.ts が個別に追従させるため、どれかが未解決でもこの Promise は停止しない。
 */
export async function loadCriticalStartupData(
  startup: StartupDataPromises,
): Promise<CriticalStartupData> {
  const [colors, overrides] = await Promise.all([
    startup.colors,
    startup.overrides,
  ]);
  return { colors, overrides };
}

/**
 * 後追い可能データを解決時点のアプリ状態へ反映する。年代などのスナップショットを
 * 引数に持たず、requestRender 側が常に現在値を読むことで古い結果の巻き戻りを防ぐ。
 */
export async function followDeferredStartupData<T>(
  pending: Promise<T>,
  apply: (value: T) => void,
  hasCurrentView: () => boolean,
  requestRender: () => void,
): Promise<void> {
  const value = await pending;
  apply(value);
  if (hasCurrentView()) requestRender();
}

/**
 * 起動データ（年代非依存の静的 9 件）の取得を一括で開始する（#249 AC1）。
 *
 * #328: データ制限一覧（TASK-46）はユーザー向け表示ごと撤去したため、
 * クライアントはその JSON を取得しない（データ本体と静的検証は開発者向け
 * 記録として data/ と scripts/ に残る）。
 *
 * 返り値は「開始済みの Promise」の束で、この関数の呼び出しと同期に全 9 件の
 * fetch が始まる（map の load イベントや他データの完了を待たない）。各 Promise
 * は対応するローダの契約をそのまま持つ。任意データは失敗時にフォールバックへ
 * 解決する。必須の colors / overrides は reject し、main.ts が即座に handler を付けた
 * loadCriticalStartupData 経由で起動エラーへ遷移させる。
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
    overrides: loadRequiredOverrides(fetchFn),
    nameJa: loadNameJa(fetchFn),
    fiefDedupe: loadFiefDedupe(fetchFn),
    rivers: loadRivers(fetchFn),
    mountains: loadMountains(fetchFn),
    marine: loadMarineLabels(fetchFn),
    peaks: loadPeaks(fetchFn),
    cities: loadCities(fetchFn),
  };
}
