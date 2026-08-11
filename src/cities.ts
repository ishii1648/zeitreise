/**
 * 主要都市マーカー/ラベルの DOM/deck.gl 非依存な純粋ロジック（TASK-27）。
 * - cities.json（年 → 都市配列）から表示年の都市エントリを取り出す検証付き変換
 * - ScatterplotLayer（マーカー）用・TextLayer（ラベル）用データへの変換
 * - CollisionFilterExtension 用の人口由来ラベル優先度の算出
 *
 * cities.json はデータ生成スクリプトの成果物で、取得失敗・未生成時は
 * main.ts 側が warn + 空データで「都市なし」のまま継続する契約。
 */

import type { LabelDatum } from "./labels.ts";

/** 主要都市 JSON の配信 URL（scripts/build.ts のコピー先と一致させる契約） */
export const CITIES_DATA_URL = "/data/cities.json";

/** cities.json の都市 1 件分（都市名は英語。表示時に name-ja.json で日本語化） */
export interface CityEntry {
  name: string;
  lon: number;
  lat: number;
  /** 当時の推定人口。不明は null */
  population: number | null;
  /**
   * 人口値の性質（Issue #221 AC3）。上流の実測記録が無いスナップショット年を
   * 生成側（scripts/build-cities.ts）が対数線形補間で埋めた値は "imputed"。
   * 実測記録由来・旧データ（フィールド無し）は null。語彙は Buringh 2021 の
   * `natureofestimate` 列に合わせてあり、後続のデータソース併合でも流用できる。
   */
  natureOfEstimate: "imputed" | null;
}

/** cities.json 全体の形（years: 年文字列 → 都市配列） */
export interface CitiesData {
  years: Record<string, CityEntry[]>;
  source?: unknown;
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
  natureOfEstimate: "imputed" | null;
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

/**
 * unknown 値を CityEntry として検証・正規化する（純粋関数）。
 * name 非文字列・lon/lat 非有限数値は不正として null。
 * population は有限数値以外（欠落・文字列等）を null に正規化する。
 * natureOfEstimate は既知の語彙 "imputed" のみ保持し、欠落・未知値
 * （"proxied" 等の未対応語彙・型不正含む）は null に正規化する
 * （「補間と明示されたものだけ補間表示」。旧データはフィールド無し = null）。
 */
function normalizeCityEntry(value: unknown): CityEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string") return null;
  const lon = finiteNumber(v.lon);
  const lat = finiteNumber(v.lat);
  if (lon === null || lat === null) return null;
  return {
    name: v.name,
    lon,
    lat,
    population: finiteNumber(v.population),
    natureOfEstimate: v.natureOfEstimate === "imputed" ? "imputed" : null,
  };
}

/**
 * 表示年の都市エントリ一覧を返す（純粋関数）。
 * データ不正形（null・years 非オブジェクト・年の値が非配列）・年キー欠落は
 * 空配列にし、fetch 失敗と同様「都市なし」で継続できるようにする。
 * 配列内の不正エントリは 1 件単位で除外する。
 */
export function cityEntriesForYear(
  data: CitiesData,
  year: number,
): CityEntry[] {
  const years = (data as unknown as Record<string, unknown> | null)?.years;
  if (typeof years !== "object" || years === null) return [];
  const list = (years as Record<string, unknown>)[String(year)];
  if (!Array.isArray(list)) return [];
  const entries: CityEntry[] = [];
  for (const item of list) {
    const entry = normalizeCityEntry(item);
    if (entry !== null) entries.push(entry);
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
 * - 同一座標（lon,lat 完全一致）は 1 件に重複排除する
 * - 不正エントリ・不正形の年（非配列等）は cityEntriesForYear と同じ基準で
 *   1 件/1 年単位で除外して継続する
 * - 決定的: 年キーの列挙順（JS の整数風キーは数値昇順）× 配列順で安定
 */
export function allCityPositions(data: CitiesData): [number, number][] {
  const years = (data as unknown as Record<string, unknown> | null)?.years;
  if (typeof years !== "object" || years === null) return [];
  const seen = new Set<string>();
  const positions: [number, number][] = [];
  for (const list of Object.values(years)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const entry = normalizeCityEntry(item);
      if (entry === null) continue;
      const key = `${entry.lon},${entry.lat}`;
      if (seen.has(key)) continue;
      seen.add(key);
      positions.push([entry.lon, entry.lat]);
    }
  }
  return positions;
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
};

/**
 * 都市の表示名を返す（純粋関数）。
 * CITY_NAME_JA_OVERRIDES → ja（name-ja.json）→ 英語名 の順で解決する。
 */
export function cityDisplayName(
  name: string,
  ja: Record<string, string> = {},
): string {
  return CITY_NAME_JA_OVERRIDES[name] ?? ja[name] ?? name;
}

/**
 * 都市エントリを TextLayer 用ラベルデータへ変換する（純粋関数）。
 * - text は cityDisplayName（都市オーバーライド → ja → 英語）で解決する
 * - name 空のエントリは除外（ラベル・picking 表示のどちらも成立しない）
 * - priority は人口由来の都市固定バンド（CITY_LABEL_PRIORITY_MIN..MAX）
 */
export function buildCityLabelData(
  entries: readonly CityEntry[],
  ja: Record<string, string> = {},
): LabelDatum[] {
  const data: LabelDatum[] = [];
  for (const entry of entries) {
    if (entry.name === "") continue;
    data.push({
      text: cityDisplayName(entry.name, ja),
      position: [entry.lon, entry.lat],
      priority: cityLabelPriority(entry.population),
    });
  }
  return data;
}

/**
 * ホバーのツールチップ・クリックの情報パネルへ出す都市のラベルを返す
 * （純粋関数、Issue #221 AC3。peaks.ts peakPickLabel と同型）。
 * - 人口不明（null）: 表示名のみ（従来表示と同一）
 * - 人口あり: `<表示名> 人口約N人`（N は ja-JP ロケールの桁区切り。上流の
 *   人口はそもそも推定値なので「約」を常に付す）
 * - 補間値（natureOfEstimate === "imputed"）: 末尾に `（補間値）` を付し、
 *   実測記録由来の人口と区別できるようにする
 *
 * 地図上のラベル（buildCityLabelData）には人口を出さない（衝突ボックスを
 * 太らせないため。山峰の標高が z7 未満で隠れるのと同じ理由の恒久版）。
 * 引数の population/natureOfEstimate は CityMarkerDatum からの pick を想定し、
 * 旧データ由来でフィールドが無い（undefined）場合も表示名のみで成立する。
 */
export function cityPickLabel(
  d: {
    name: string;
    population?: number | null;
    natureOfEstimate?: "imputed" | null;
  },
  ja: Record<string, string> = {},
): string {
  const name = cityDisplayName(d.name, ja);
  const population = finiteNumber(d.population);
  if (population === null) return name;
  const formatted = population.toLocaleString("ja-JP");
  const suffix = d.natureOfEstimate === "imputed" ? "（補間値）" : "";
  return `${name} 人口約${formatted}人${suffix}`;
}

/**
 * 都市エントリを ScatterplotLayer 用マーカーデータへ変換する（純粋関数）。
 * name はホバー/クリック時の表示（ja 適用）に使うため保持する。
 * population / natureOfEstimate も picking 表示（cityPickLabel）用に伝搬する
 * （Issue #221 AC3）。name 空のエントリはラベル同様に除外する。
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
    });
  }
  return data;
}
