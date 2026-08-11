/**
 * 主要都市マーカー/ラベルの DOM/deck.gl 非依存な純粋ロジック（TASK-27 / #222）。
 * - cities.json（#222 の正規化形式: 都市配列 + 年別 [index, population(,
 *   natureOfEstimate)] セル + sources 配列）から表示年の都市エントリを
 *   取り出す検証付き変換
 * - ScatterplotLayer（マーカー）用・TextLayer（ラベル）用データへの変換
 * - CollisionFilterExtension 用の人口由来ラベル優先度の算出
 * - picking された都市の出典解決（citySourceMetadata。複数ソースの帰属）
 *
 * cities.json はデータ生成スクリプトの成果物で、取得失敗・未生成時は
 * main.ts 側が warn + 空データで「都市なし」のまま継続する契約。
 */

import type { LabelDatum } from "./labels.ts";
// #223: 時代別都市名の手動キュレーション（年区間 + 出典）。表示に効く数十件
// のみを収録する小データなので、fetch（data_loading.ts）ではなく静的 import で
// バンドルへ内蔵し、取得失敗の縮退経路を増やさない。検証は
// scripts/city-names-historical_test.ts（区間重複・年逆転・出典欠落等）。
import cityNamesHistoricalJson from "../data/city-names-historical.json" with {
  type: "json",
};

/** 主要都市 JSON の配信 URL（scripts/build.ts のコピー先と一致させる契約） */
export const CITIES_DATA_URL = "/data/cities.json";

/** 人口値の性質の語彙（Buringh 2021 の natureofestimate 列に合わせる。#222） */
export type CityNatureOfEstimate = "imputed" | "proxied";

/** cities.json の都市 1 件分（都市名は英語。表示時に name-ja.json で日本語化） */
export interface CityEntry {
  name: string;
  lon: number;
  lat: number;
  /** 当時の推定人口。不明は null */
  population: number | null;
  /**
   * 人口値の性質（Issue #221 AC3 / #222）。
   * - "imputed": 上流の実測記録が無いスナップショット年を生成側
   *   （scripts/build-cities.ts）が対数線形補間で埋めた値、または Buringh
   *   2021 が「補完」と宣言する値
   * - "proxied": Buringh 2021 が代理指標（人口記録以外）から推定した値
   * - null: 実推定由来・語彙欠落
   */
  natureOfEstimate: CityNatureOfEstimate | null;
  /**
   * 出典 index（#222 AC6）。cities.json の sources 配列を指し、クリック情報
   * パネルの出典欄が都市ごとの出典（Buringh / Chandler）を解決するのに使う。
   * 不正形は null（データセット全体の metadata へフォールバック）。
   */
  source: number | null;
}

/**
 * cities.json 全体の形（#222 の正規化形式）。
 * - cities: 全年代の都市を一度だけ並べた配列（{name, lon, lat, source}）
 * - years: 年文字列 → [都市 index, 人口(, natureOfEstimate)] セルの配列
 * - sources: 出典レコードの配列（CityEntry.source が指す）
 * 実行時データは fetch 由来で形が保証されないため、読み出しは
 * cityEntriesForYear 等の検証付き変換だけが行う。
 */
export interface CitiesData {
  cities: unknown[];
  years: Record<string, unknown>;
  sources?: unknown;
  metadata?: unknown;
}

/** ScatterplotLayer（都市マーカー）に渡す 1 件分のデータ */
export interface CityMarkerDatum {
  /** 英語の都市名（picking 時のツールチップ/パネル表示で ja 適用する） */
  name: string;
  /** マーカー座標 [lon, lat] */
  position: [number, number];
  /** 当時の推定人口（picking 時の表示用。不明は null）（Issue #221 AC3） */
  population: number | null;
  /** 人口値の性質（CityEntry.natureOfEstimate をそのまま伝搬） */
  natureOfEstimate: CityNatureOfEstimate | null;
  /** 出典 index（CityEntry.source をそのまま伝搬。#222 AC6） */
  source: number | null;
}

/**
 * 都市マーカー（可視ドット）の半径（px）（TASK-27。TASK-82 で main.ts の
 * リテラルから定数化）。国土に対する「点」の記号なのでズームには追従させない。
 */
export const CITY_MARKER_RADIUS_PX = 3;

/**
 * 都市の透明ヒット層（picking.ts CITY_HIT_LAYER_ID）の半径（px）（TASK-82）。
 * cities と同一データをこの半径・完全透明で cities の直下に重ね、ホバー/
 * クリックの実効判定範囲を CITY_PICK_TOLERANCE_PX まで広げる。
 *
 * 9px を採る根拠:
 * - 従来のクリックの実効範囲（ドット 3px + 近傍再ピック PICKING_RADIUS_PX
 *   6px = 9px）と同値。クリック側の当たり方を一切変えずに、ホバー（従来は
 *   ドットの 3px のみ）をそこへ揃えるという設計にできる（AC #2）。
 * - 可視ドット（半径 3px + 白 stroke 1px ≒ 4px）の約 2 倍で、「点の周りの
 *   見えない余白」として直感に反しない大きさ。AC #1 の目安 8〜10px の中央。
 * - 密集地域とのトレードオフ: 実データの最小都市間距離は 1500 年 z4 の
 *   Ghent–Bruges で 6.4px、z5 の Milan–Pavia（1000 年）で 9.1px、z7 の
 *   Delft–The Hague で 10.7px。半径 9px なら判定円同士は重なるが、
 *   「可視ドット直上は必ずその都市」は cities 層が cities-hit の上にある
 *   ことで保証される（隣接都市の判定円がドットを覆えない）。曖昧なのは
 *   「どちらのドットの上でもない中間帯」だけで、そこでどちらが返っても
 *   ユーザーの意図と大きくは食い違わない。半径をこれ以上大きくすると
 *   中間帯が広がるだけで、直上判定の確実性は上がらない。
 */
export const CITY_HIT_RADIUS_PX = 9;

/**
 * 都市の透明ヒット層の塗り色。完全透明（alpha 0）で、見た目（ドット + 白縁）は
 * 一切変えない判定専用レイヤーにする（rivers.ts RIVER_HIT_LINE_COLOR と同型）。
 */
export const CITY_HIT_FILL_COLOR: [number, number, number, number] = [
  0,
  0,
  0,
  0,
];

/**
 * 都市 picking の実効判定範囲（px）（TASK-82 AC #4。rivers.ts
 * RIVER_CLICK_TOLERANCE_PX と同じ「合成値を定数で固定する」扱い）。
 *
 * 導出: マーカー中心からの距離が
 * - CITY_MARKER_RADIUS_PX（3px）以内 → 可視ドット（cities）の直下 pick
 * - CITY_HIT_RADIUS_PX（9px）以内 → 透明判定円（cities-hit）の直下 pick
 * のいずれかで拾えるので、合成範囲は 2 つの半径の大きい方 = 9px。
 *
 * 近傍再ピック半径（picking.ts PICKING_RADIUS_PX）は**加算されない**。
 * 河川（RIVER_CLICK_TOLERANCE_PX = ヒット帯半幅 + PICKING_RADIUS_PX）と違い、
 * cities-hit は picking.ts isNearCursorRepickable で再ピック候補から除外して
 * あり、クリックだけが 15px まで広がる非対称を作らないため（AC #2）。
 * その代わり、ホバー・クリックとも直下 pick だけでこの範囲を得る
 * （ホバーに pickMultipleObjects を足さない = TASK-36 のコスト設計を維持）。
 */
export const CITY_PICK_TOLERANCE_PX = Math.max(
  CITY_MARKER_RADIUS_PX,
  CITY_HIT_RADIUS_PX,
);

/**
 * 都市ラベル priority の下限（人口不明・人口 ≦ 1 の都市）。
 *
 * 設計根拠: 国名ラベル（labels.ts labelPriorityFor）は面積由来
 * 100 * log10(deg²) で実測 -400〜300 程度に散らばる。cities.json に載る
 * 時点で「その年代の主要都市」なので、小勢力ラベル（負値〜0 近辺）よりは
 * 常に優先しつつ、大国ラベル（200〜300 付近）には譲る中位帯 150〜220 に
 * 固定する。これで国名の骨格表示を壊さずに都市名が空きへ入る。
 */
export const CITY_LABEL_PRIORITY_MIN = 150;

/** 都市ラベル priority の上限（バンド設計は CITY_LABEL_PRIORITY_MIN を参照） */
export const CITY_LABEL_PRIORITY_MAX = 220;

/** 有限数値なら number、それ以外は null */
function finiteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 正規化済みの都市定義（cities 配列の 1 要素の検証結果） */
interface NormalizedCityDef {
  name: string;
  lon: number;
  lat: number;
  source: number | null;
}

/**
 * cities 配列の 1 要素を検証・正規化する（純粋関数）。
 * name 非文字列・lon/lat 非有限数値は不正として null。
 * source は有限整数以外（欠落・文字列等）を null に正規化する。
 */
function normalizeCityDef(value: unknown): NormalizedCityDef | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string") return null;
  const lon = finiteNumber(v.lon);
  const lat = finiteNumber(v.lat);
  if (lon === null || lat === null) return null;
  const source = finiteNumber(v.source);
  return {
    name: v.name,
    lon,
    lat,
    source: source !== null && Number.isInteger(source) ? source : null,
  };
}

/** cities 配列を取り出す（不正形は null） */
function citiesArrayOf(data: CitiesData): unknown[] | null {
  const cities = (data as unknown as Record<string, unknown> | null)?.cities;
  return Array.isArray(cities) ? cities : null;
}

/**
 * natureOfEstimate の語彙を検証する。既知の語彙（imputed / proxied）のみ
 * 保持し、欠落・未知値・型不正は null に正規化する（「性質が明示された
 * ものだけ区別表示」。旧データ・不正形でも従来表示が成立する縮退）。
 */
function normalizeNature(value: unknown): CityNatureOfEstimate | null {
  return value === "imputed" || value === "proxied" ? value : null;
}

/**
 * 表示年の都市エントリ一覧を返す（純粋関数）。
 *
 * #222 の正規化形式（cities 配列 + 年別 [index, population(, nature)] セル）を
 * 検証しながら CityEntry へ展開する。データ不正形（null・cities 非配列・
 * years 非オブジェクト・年の値が非配列）・年キー欠落は空配列にし、fetch
 * 失敗と同様「都市なし」で継続できるようにする。不正セル（非配列・範囲外
 * index・不正な都市定義）は 1 件単位で除外する。population の非数値・非正値は
 * null に正規化する（表示側は人口不明として名称のみ出す）。
 */
export function cityEntriesForYear(
  data: CitiesData,
  year: number,
): CityEntry[] {
  const cities = citiesArrayOf(data);
  if (cities === null) return [];
  const years = (data as unknown as Record<string, unknown> | null)?.years;
  if (typeof years !== "object" || years === null) return [];
  const list = (years as Record<string, unknown>)[String(year)];
  if (!Array.isArray(list)) return [];
  const entries: CityEntry[] = [];
  for (const cell of list) {
    if (!Array.isArray(cell)) continue;
    const index = cell[0];
    if (typeof index !== "number" || !Number.isInteger(index)) continue;
    const def = normalizeCityDef(cities[index]);
    if (def === null) continue;
    const population = finiteNumber(cell[1]);
    entries.push({
      name: def.name,
      lon: def.lon,
      lat: def.lat,
      population: population !== null && population > 0 ? population : null,
      natureOfEstimate: normalizeNature(cell[2]),
      source: def.source,
    });
  }
  return entries;
}

/**
 * 全年代の都市座標の和集合を返す（純粋関数、TASK-136）。
 *
 * 河川ラベルのアンカー回避（rivers.ts riverLabelAnchors の avoidPoints）用。
 * 表示年の都市だけでなく union を使うのは、河川アンカーを年代非依存
 * （TASK-50 のメモ化 = 起動後 1 度だけ計算）に保つため。union から
 * 離れた点はどの年代の都市からも離れているので、年代切替でラベルが跳ばない。
 *
 * #222 の正規化形式では cities 配列そのものが「全年代の都市の和集合」なので、
 * 年別セルを走査せず cities 配列から直接作る。
 * - 同一座標（lon,lat 完全一致）は 1 件に重複排除する
 * - 不正エントリは 1 件単位で除外して継続する
 * - 決定的: cities 配列順で安定
 */
export function allCityPositions(data: CitiesData): [number, number][] {
  const cities = citiesArrayOf(data);
  if (cities === null) return [];
  const seen = new Set<string>();
  const positions: [number, number][] = [];
  for (const item of cities) {
    const def = normalizeCityDef(item);
    if (def === null) continue;
    const key = `${def.lon},${def.lat}`;
    if (seen.has(key)) continue;
    seen.add(key);
    positions.push([def.lon, def.lat]);
  }
  return positions;
}

/**
 * 都市の出典 index からクリック情報パネルへ出す出典レコードを解決する
 * （純粋関数。#222 AC6）。
 * cities.json は複数ソース（Buringh 主 + Chandler 補完）の帰属を sources
 * 配列で持つため、picking された都市の source index に対応するレコードを
 * 返す。index 不明（null）・範囲外・sources 不正形はデータセット全体の
 * metadata（build-attribution が刻む主ソースの出典）へフォールバックする。
 * 返り値の解釈は info.ts sourceLines（source / sourceUrl / license / commit）
 * に委ねる。
 */
export function citySourceMetadata(
  data: CitiesData,
  source: number | null,
): unknown {
  const record = data as unknown as Record<string, unknown> | null;
  const sources = record?.sources;
  if (
    source !== null && Number.isInteger(source) && source >= 0 &&
    Array.isArray(sources) && source < sources.length &&
    typeof sources[source] === "object" && sources[source] !== null
  ) {
    return sources[source];
  }
  return record?.metadata;
}

/**
 * 最遠〜初期ズーム（z4 以下）で表示する都市数の上限（TASK-66 AC #3）。
 *
 * 設計根拠: 現行データ（scripts/build-cities.ts）は各年
 * CITIES_PER_YEAR=20 + HRE 域内最低 6 件補充で最大 23 件/年（TASK-61）。
 * 初期表示 z4 の密度をこの実績値と同じに保つことで、TASK-54/TASK-60/TASK-72 の
 * ラベル視認性対策（halo・衝突間引き）を破綻させない。
 */
export const CITY_RANK_LIMIT_BASE = 23;

/**
 * ズームレベル別の表示都市数の上限を返す（純粋関数。TASK-66 AC #2/#3）。
 *
 * 段階設計の根拠:
 * - 判定はズームの整数段（Math.floor）で行う。小数ズームの連続変化で
 *   表示が細かく揺れないようにし、呼び出し側（main.ts）の「整数段が
 *   変わった時のみレイヤー再構築」という抑制（TASK-50 方針の踏襲）と
 *   同じ粒度に揃える。
 * - z4 以下（MIN_ZOOM=4 だが maxBounds クランプ等の防御込み）は
 *   CITY_RANK_LIMIT_BASE（23 件 = 現行密度）で据え置く。
 * - ズーム 1 段で画面内の対象面積は約 1/4 になるため、1 段ごとに約 2 倍
 *   （40 → 80 → 160）解禁しても画面上の密度増加は緩やかに留まる。
 * - 最大ズーム z8（config.ts MAX_ZOOM）では上限なし（全件）。元データの
 *   欧州候補プールは最大 679 都市（TASK-66 調査）で、z8 の画面範囲では
 *   十分に疎になる。
 * - 非有限値（NaN 等の防御）は最も保守的な基準件数へフォールバックする。
 */
export function visibleCityRankLimit(zoom: number): number {
  if (!Number.isFinite(zoom)) return CITY_RANK_LIMIT_BASE;
  const step = Math.floor(zoom);
  if (step <= 4) return CITY_RANK_LIMIT_BASE;
  if (step === 5) return 40;
  if (step === 6) return 80;
  if (step === 7) return 160;
  return Number.POSITIVE_INFINITY;
}

/**
 * ズームレベルに応じて表示都市を人口上位ランクへ絞り込む（純粋関数。
 * TASK-66 AC #2）。呼び出し側は cityEntriesForYear の結果（単一年の配列）を
 * 渡す想定で、ランク付けは年内で完結する。
 *
 * - ランクは人口降順。population null（不明）は人口 0 よりさらに下位の
 *   最下位ランク扱い（不明都市を優先して残す理由がないため）。
 * - 人口同数（ランク同数）は元配列で先のエントリが勝つ（安定ソート）。
 *   上限の境界で同人口が並んでも結果が決定的になる。
 * - 出力は元配列の並び順を保つ（deck.gl へ渡すデータ順を年内で安定させ、
 *   ズーム段の変化時に共通部分の順序が入れ替わらないようにする）。
 */
export function filterCitiesByZoom(
  entries: readonly CityEntry[],
  zoom: number,
): CityEntry[] {
  const limit = visibleCityRankLimit(zoom);
  if (entries.length <= limit) return [...entries];
  const ranked = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const pa = a.entry.population ?? Number.NEGATIVE_INFINITY;
      const pb = b.entry.population ?? Number.NEGATIVE_INFINITY;
      // 人口降順 → 同数は元配列順（index 昇順）で決定的に切る
      return pb - pa || a.index - b.index;
    });
  const keep = new Set(ranked.slice(0, limit).map((r) => r.index));
  return entries.filter((_, index) => keep.has(index));
}

/**
 * 人口由来の都市ラベル優先度（純粋関数）。人口が多い都市ほど高優先。
 * 100 * log10 だと人口（1e3〜1e6 人）でバンド幅 300 を食い潰すため、
 * 10 * log10(population) の緩い傾斜でバンド内（150〜220）に収める。
 * 人口不明（null）・0 以下はバンド下限。
 */
function cityLabelPriority(population: number | null): number {
  if (population === null || population <= 1) return CITY_LABEL_PRIORITY_MIN;
  const priority = CITY_LABEL_PRIORITY_MIN +
    Math.round(10 * Math.log10(population));
  return Math.min(CITY_LABEL_PRIORITY_MAX, priority);
}

/**
 * 勢力名と綴りが衝突する都市の日本語訳オーバーライド。
 * name-ja.json は勢力名と共有のフラットな 1:1 マップのため、Venice 等は
 * 勢力訳（ヴェネツィア共和国 等）が登録されている。都市マーカー/ラベルの
 * 表示では都市としての訳を優先する（ここに無い名前は ja → 英語の順）。
 */
export const CITY_NAME_JA_OVERRIDES: Record<string, string> = {
  Venice: "ヴェネツィア",
  Milan: "ミラノ",
  Naples: "ナポリ",
  Granada: "グラナダ",
  Algiers: "アルジェ",
  Florence: "フィレンツェ",
  Genoa: "ジェノヴァ",
  Hamburg: "ハンブルク",
  Tunis: "チュニス",
  // #222: Buringh 併合で新たに勢力名（都市国家・領邦・公国など）と綴りが
  // 衝突するようになった都市。都市としての慣用表記を固定する。
  Brandenburg: "ブランデンブルク",
  Bremen: "ブレーメン",
  Derbent: "デルベント",
  Geneva: "ジュネーヴ",
  Lucca: "ルッカ",
  Massa: "マッサ",
  Modena: "モデナ",
  Novgorod: "ノヴゴロド",
  Oldenburg: "オルデンブルク",
  Parma: "パルマ",
  Pskov: "プスコフ",
  Ryazan: "リャザン",
  Schleswig: "シュレースヴィヒ",
  Wetzlar: "ヴェツラー",
};

/**
 * 時代別都市名の 1 区間（#223。data/city-names-historical.json の 1 エントリ）。
 * 区間は両端含み（from 年ちょうど・to 年ちょうども該当）。
 */
export interface CityHistoricalName {
  from: number;
  to: number;
  /** 当該年代の支配勢力による呼称（原語・出典確認用） */
  name: string;
  /** 表示に使う日本語表記（name-ja.json の都市表記と同じ規約） */
  ja: string;
  /** 出典と採用根拠（Wikidata / Wikipedia 等。検証テストが欠落を検知する） */
  source: string;
}

/**
 * 時代別都市名のキュレーションデータ（#223）。
 * 対象は「その年代の支配勢力の呼称が英語慣用名と大きく異なり、地図の理解に
 * 効くもの」に絞る（例: ハンガリー領期のベオグラード = ナーンドルフェヘール
 * ヴァール、上流の現代名 Volgograd の帝政期 = ツァリーツィン）。
 * 全年代一律の改名（Istanbul → Constantinople 等）は従来どおり
 * scripts/build-cities.ts の CITY_RENAMES が生成時に正規化する。
 */
export const CITY_HISTORICAL_NAMES: Record<
  string,
  readonly CityHistoricalName[]
> = cityNamesHistoricalJson;

/**
 * 表示年に該当する時代別都市名の区間を返す（純粋関数。#223）。
 * 区間は両端含みで、該当なし・未収録都市は null。同一都市の区間は検証テストが
 * 重複なしを保証するため、最初に該当した区間を返せば一意に決まる。
 */
export function historicalCityName(
  name: string,
  year: number,
  historical: Record<string, readonly CityHistoricalName[]> =
    CITY_HISTORICAL_NAMES,
): CityHistoricalName | null {
  const spans = historical[name];
  if (spans === undefined) return null;
  for (const span of spans) {
    if (year >= span.from && year <= span.to) return span;
  }
  return null;
}

/**
 * 都市の表示名を返す（純粋関数）。
 * 時代別都市名（year が区間に該当する場合。#223）→ CITY_NAME_JA_OVERRIDES →
 * ja（name-ja.json）→ 英語名 の順で解決する。
 * year 省略時は従来の解決順そのまま（年代非依存の呼び出しの後方互換）。
 */
export function cityDisplayName(
  name: string,
  ja: Record<string, string> = {},
  year?: number,
  historical: Record<string, readonly CityHistoricalName[]> =
    CITY_HISTORICAL_NAMES,
): string {
  if (year !== undefined) {
    const span = historicalCityName(name, year, historical);
    if (span !== null) return span.ja;
  }
  return CITY_NAME_JA_OVERRIDES[name] ?? ja[name] ?? name;
}

/**
 * 都市エントリを TextLayer 用ラベルデータへ変換する（純粋関数）。
 * - text は cityDisplayName（時代別都市名 → 都市オーバーライド → ja → 英語）で
 *   解決する。year を渡すと区間該当年のみ歴史名になる（#223 AC1）
 * - name 空のエントリは除外（ラベル・picking 表示のどちらも成立しない）
 * - priority は人口由来の都市固定バンド（CITY_LABEL_PRIORITY_MIN..MAX）
 */
export function buildCityLabelData(
  entries: readonly CityEntry[],
  ja: Record<string, string> = {},
  year?: number,
): LabelDatum[] {
  const data: LabelDatum[] = [];
  for (const entry of entries) {
    if (entry.name === "") continue;
    data.push({
      text: cityDisplayName(entry.name, ja, year),
      position: [entry.lon, entry.lat],
      priority: cityLabelPriority(entry.population),
    });
  }
  return data;
}

/**
 * ホバーのツールチップ・クリックの情報パネルへ出す都市のラベルを返す
 * （純粋関数、Issue #221 AC3 / #222。peaks.ts peakPickLabel と同型）。
 * - 人口不明（null）: 表示名のみ（従来表示と同一）
 * - 人口あり: `<表示名> 人口約N人`（N は ja-JP ロケールの桁区切り。上流の
 *   人口はそもそも推定値なので「約」を常に付す）
 * - 補間値（natureOfEstimate === "imputed"）: 末尾に `（補間値）` を付し、
 *   実測記録由来の人口と区別できるようにする
 * - 代理推定（natureOfEstimate === "proxied"、Buringh 2021 が人口記録以外の
 *   代理指標から推定した値）: 末尾に `（代理推定）` を付す（#222）
 *
 * 地図上のラベル（buildCityLabelData）には人口を出さない（衝突ボックスを
 * 太らせないため。山峰の標高が z7 未満で隠れるのと同じ理由の恒久版）。
 * 引数の population/natureOfEstimate は CityMarkerDatum からの pick を想定し、
 * 旧データ由来でフィールドが無い（undefined）場合も表示名のみで成立する。
 * year を渡すと表示名がラベルと同じ年代別表記になる（#223 AC3）。
 */
export function cityPickLabel(
  d: {
    name: string;
    population?: number | null;
    natureOfEstimate?: CityNatureOfEstimate | null;
  },
  ja: Record<string, string> = {},
  year?: number,
): string {
  const name = cityDisplayName(d.name, ja, year);
  const population = finiteNumber(d.population);
  if (population === null) return name;
  const formatted = population.toLocaleString("ja-JP");
  const suffix = d.natureOfEstimate === "imputed"
    ? "（補間値）"
    : d.natureOfEstimate === "proxied"
    ? "（代理推定）"
    : "";
  return `${name} 人口約${formatted}人${suffix}`;
}

/**
 * 都市エントリを ScatterplotLayer 用マーカーデータへ変換する（純粋関数）。
 * name はホバー/クリック時の表示（ja 適用）に使うため保持する。
 * population / natureOfEstimate も picking 表示（cityPickLabel）用に、
 * source も picking の出典解決（citySourceMetadata）用に伝搬する
 * （Issue #221 AC3 / #222 AC6）。name 空のエントリはラベル同様に除外する。
 */
export function buildCityMarkerData(
  entries: readonly CityEntry[],
): CityMarkerDatum[] {
  const data: CityMarkerDatum[] = [];
  for (const entry of entries) {
    if (entry.name === "") continue;
    data.push({
      name: entry.name,
      position: [entry.lon, entry.lat],
      population: entry.population,
      natureOfEstimate: entry.natureOfEstimate,
      source: entry.source,
    });
  }
  return data;
}
