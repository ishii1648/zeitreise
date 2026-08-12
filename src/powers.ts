/**
 * 勢力圏レイヤーの DOM 非依存な純粋ロジック。
 * - colors.json の参照キー組み立て（build-colors.ts の compositeKey と同一規則）
 * - HEX → deck.gl の [r,g,b,a] 変換と塗り/境界線の定数
 * - 年代 GeoJSON のメモリキャッシュ付きローダ（fetch はモック可能な形に分離）
 * 参照仕様: docs/app-spec.md §3.3, §4.3
 */

import type { FeatureCollection, GeoJsonProperties } from "geojson";

/** deck.gl のカラー表現（0..255 の RGBA タプル） */
export type Rgba = [number, number, number, number];

/** 独立勢力キーと属領キー（NAME|SUBJECTO）を区切る文字。国名には現れない */
export const SUBJECT_KEY_SEP = "|";

/** 塗り opacity 0.5 相当の alpha（0..255） */
export const FILL_ALPHA = 128;

/** キー欠落（NAME null 等）時のニュートラルなデフォルト塗り色（グレー系・同 opacity） */
export const DEFAULT_FILL_COLOR: Rgba = [136, 136, 136, FILL_ALPHA];

/**
 * 境界線の色（インク＝焦茶系・やや不透明。TASK-73）。
 *
 * 従来の白 [255,255,255,200] は現代的な light ベースマップ前提の色で、羊皮紙
 * トーンの下地（basemap.ts PARCHMENT_FLAVOR_OVERRIDES）の上では白抜きの線が
 * 浮き、地図外 UI（app.css の --frame #5c3d22 / --ink #3a2712）とも乖離して
 * いた。古地図の「ペンで引いた境界」に合わせて --frame と同値の焦茶にする。
 * alpha は従来どおり 190 前後に留め、下の塗り分けが線に潰されないようにする。
 *
 * 他の境界線との識別: HRE 外縁の臙脂 [140,30,30]（political_layers.ts
 * HRE_EXTENT_LINE_COLOR、3px）、諸侯領内部境界の藍紫 [74,42,130]（同
 * FIEF_BORDER_INK、#267 で階層 × レベル別の細線）とは色相・太さの双方で
 * 区別できる。
 */
export const LINE_COLOR: Rgba = [92, 61, 34, 190];

/** 境界線の幅（ピクセル） */
export const LINE_WIDTH_PX = 1;

/** properties から文字列プロパティを取り出す。空文字・非文字列は null */
function stringProp(props: GeoJsonProperties, key: string): string | null {
  const v = props?.[key];
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * feature の NAME / SUBJECTO から colors.json の参照キーを組み立てる（純粋関数）。
 * SUBJECTO を持ち、かつ NAME と異なる場合のみ "NAME|SUBJECTO"（属領キー）。
 * それ以外は NAME（独立勢力キー）。NAME が無い feature は null。
 * build-colors.ts の compositeKey と同一規則に揃える。
 */
export function colorKeyFor(props: GeoJsonProperties): string | null {
  const name = stringProp(props, "NAME");
  if (name === null) return null;
  const subjecto = stringProp(props, "SUBJECTO");
  if (subjecto !== null && subjecto !== name) {
    return `${name}${SUBJECT_KEY_SEP}${subjecto}`;
  }
  return name;
}

/** "#rrggbb" を [r,g,b] に変換する（純粋関数）。不正な形式は null */
export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (m === null) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * feature の properties と色マップから塗り色 [r,g,b,a] を決める（純粋関数）。
 * キーが引けない／HEX が不正な場合はデフォルトのグレーにフォールバックする。
 */
export function fillColorFor(
  props: GeoJsonProperties,
  colors: Record<string, string>,
): Rgba {
  const key = colorKeyFor(props);
  if (key === null) return DEFAULT_FILL_COLOR;
  const hex = colors[key];
  if (hex === undefined) return DEFAULT_FILL_COLOR;
  const rgb = hexToRgb(hex);
  if (rgb === null) return DEFAULT_FILL_COLOR;
  return [rgb[0], rgb[1], rgb[2], FILL_ALPHA];
}

/** 年代スナップショット GeoJSON の同一オリジン配信 URL を返す（純粋関数） */
export function dataUrlFor(year: number): string {
  return `/data/europe_${year}.geojson`;
}

/**
 * HRE（神聖ローマ帝国）領邦オーバーレイ GeoJSON の配信 URL を返す（純粋関数）。
 *
 * 出典が年代で 2 系統に分かれる（TASK-86 / #187）:
 * - OHM 年代（ohmFiefYears ∈ config.HRE_FIEF_OVERLAY_YEARS = 中世 1000〜1492 +
 *   近世 1715〜1800）: OpenHistoricalMap 由来の hre_fiefs_flat_<year>（生成は
 *   scripts/build-hre-fiefs.ts → scripts/build-fief-flat.ts）
 * - Roller 年代（それ以外 = config.HRE_OVERLAY_YEARS = 1500〜1700）: ETH Zürich
 *   Roller 由来の hre_<year>（生成は scripts/build-hre.ts）
 *
 * どちらも properties は NAME / SUBJECTO / PARTOF 互換なので、レイヤー
 * （hre-powers）・色解決（colorKeyFor）・ラベル・picking は年代をまたいで同一の
 * 経路で処理される。参照するのは flat（領邦同士の重なりを排他化した派生データ）で、
 * franceFiefDataUrlFor と同じ理由（半透明の塗りが二重に濃くならないようにする）。
 *
 * ohmFiefYears を省略すると従来どおり全年代で hre_<year> を指す。
 */
export function hreDataUrlFor(
  year: number,
  ohmFiefYears: readonly number[] = [],
): string {
  return ohmFiefYears.includes(year)
    ? `/data/hre_fiefs_flat_${year}.geojson`
    : `/data/hre_${year}.geojson`;
}

/**
 * 帝国全域ジオメトリ（hre_realm_<year>.geojson）の配信 URL を返す
 * （純粋関数、#332）。生成は scripts/build-hre-realm.ts（OHM / CC0）。
 *
 * このデータは政治レイヤーとして**描画も picking もしない**。勢力圏の外枠
 * （suzerain_extent.ts buildSuzerainExtent）の union 入力にだけ入り、後期 HRE
 * （1715 / 1783 / 1800）で base が帝国全域を塗らなくなった分を補う。
 * flat 化などの派生を持たず、このファイルがそのまま配信される。
 */
export function hreRealmDataUrlFor(year: number): string {
  return `/data/hre_realm_${year}.geojson`;
}

/** 指定年に HRE オーバーレイが存在するか（純粋関数）。対象年は config.HRE_OVERLAY_YEARS */
export function hasHreOverlay(
  year: number,
  overlayYears: readonly number[],
): boolean {
  return overlayYears.includes(year);
}

/**
 * 中世フランス諸侯領オーバーレイ GeoJSON の配信 URL を返す（純粋関数、TASK-71）。
 *
 * TASK-79: 参照先は OHM 由来の生データ（france_fiefs_<year>、生成は
 * scripts/build-france-fiefs.ts / CC0）ではなく、諸侯領同士の重なりを排他化した
 * 派生データ france_fiefs_flat_<year>（生成は scripts/build-fief-flat.ts）。
 * 親公領に内包される伯領（Alençon ⊂ Normandy）や OHM の境界不一致による微小
 * 重なりを、半透明（FILL_ALPHA）の塗りが二重に重なる前に幾何的に取り除いた
 * ものが flat 側で、feature の並び・properties・子側のジオメトリは生データと
 * 同一のため、ラベル・picking・色の解決規則はこれまでと変わらない。
 */
export function franceFiefDataUrlFor(year: number): string {
  return `/data/france_fiefs_flat_${year}.geojson`;
}

/**
 * 指定年にフランス諸侯領オーバーレイが存在するか（純粋関数、TASK-71）。
 * 対象年は config.FRANCE_FIEF_OVERLAY_YEARS。判定規則は hasHreOverlay と同一だが、
 * 呼び出し側で「どちらのオーバーレイの話か」を取り違えないよう別名で公開する。
 */
export function hasFranceFiefOverlay(
  year: number,
  overlayYears: readonly number[],
): boolean {
  return overlayYears.includes(year);
}

/**
 * 中世イタリア諸侯領オーバーレイ GeoJSON の配信 URL を返す（純粋関数、TASK-96）。
 *
 * 参照先は OHM 由来の生データ（italy_fiefs_<year>、生成は
 * scripts/build-italy-fiefs.ts / CC0）ではなく、諸侯領同士の重なりを排他化した
 * 派生データ italy_fiefs_flat_<year>（生成は scripts/build-fief-flat.ts）。
 * 理由は franceFiefDataUrlFor / hreDataUrlFor と同じで、半透明（FILL_ALPHA）の
 * 塗りが二重に重ならないようにするため。1400 年の County of Santa Fiora ⊂
 * Republic of Siena のような内包関係が実データにある。
 */
export function italyFiefDataUrlFor(year: number): string {
  return `/data/italy_fiefs_flat_${year}.geojson`;
}

/**
 * 指定年にイタリア諸侯領オーバーレイが存在するか（純粋関数、TASK-96）。
 * 対象年は config.ITALY_FIEF_OVERLAY_YEARS。判定規則は hasHreOverlay /
 * hasFranceFiefOverlay と同一だが、呼び出し側で「どのオーバーレイの話か」を
 * 取り違えないよう別名で公開する。
 */
export function hasItalyFiefOverlay(
  year: number,
  overlayYears: readonly number[],
): boolean {
  return overlayYears.includes(year);
}

/**
 * Cliopatria 由来の領邦オーバーレイ GeoJSON の配信 URL を返す（純粋関数、
 * TASK-110）。出典は Cliopatria / Seshat Global History Databank
 * （CC BY 4.0、doi:10.5281/zenodo.14714684）。
 *
 * 参照先は生データ（cliopatria_fiefs_<year>、生成は
 * scripts/build-cliopatria-fiefs.ts）ではなく、既存 3 系統の OHM 由来
 * オーバーレイおよび Cliopatria 内部の重なりを排他化した派生データ
 * cliopatria_fiefs_flat_<year>（生成は scripts/build-fief-flat.ts）。
 * 理由は franceFiefDataUrlFor / italyFiefDataUrlFor と同じで、半透明
 * （FILL_ALPHA）の塗りが二重に重ならないようにするため。Cliopatria は
 * 「名前を丸括弧で囲んだ複合体 feature」（封臣を含む王国全体）を持ち、
 * 内側の単独 feature と完全に重なるので、排他化なしでは巨大な塗りが
 * 既存レイヤーを覆う。
 */
export function cliopatriaFiefDataUrlFor(year: number): string {
  return `/data/cliopatria_fiefs_flat_${year}.geojson`;
}

/**
 * 指定年に Cliopatria 領邦オーバーレイが存在するか（純粋関数、TASK-110）。
 * 対象年は config.CLIOPATRIA_FIEF_OVERLAY_YEARS。判定規則は hasHreOverlay /
 * hasFranceFiefOverlay / hasItalyFiefOverlay と同一だが、呼び出し側で
 * 「どのオーバーレイの話か」を取り違えないよう別名で公開する。
 */
export function hasCliopatriaFiefOverlay(
  year: number,
  overlayYears: readonly number[],
): boolean {
  return overlayYears.includes(year);
}

/**
 * ブリテン諸島の政体オーバーレイ GeoJSON の配信 URL を返す（純粋関数、#172）。
 * 出典は OpenHistoricalMap（CC0、生成は scripts/build-britain-fiefs.ts →
 * scripts/build-fief-flat.ts）。
 *
 * 参照先は生データ（britain_fiefs_<year>）ではなく、政体同士の重なりを
 * 排他化した派生データ britain_fiefs_flat_<year>。理由は franceFiefDataUrlFor /
 * italyFiefDataUrlFor と同じで、半透明（FILL_ALPHA）の塗りが二重に重ならない
 * ようにするため（1600 年の Kingdom of Leinster ⊂ Kingdom of Ireland の
 * 内包 12,700 km² を flat 側が解消している。TASK-151）。
 */
export function britainFiefDataUrlFor(year: number): string {
  return `/data/britain_fiefs_flat_${year}.geojson`;
}

/**
 * 指定年にブリテン諸島の政体オーバーレイが存在するか（純粋関数、#172）。
 * 対象年は config.BRITAIN_FIEF_OVERLAY_YEARS。判定規則は hasHreOverlay /
 * hasFranceFiefOverlay / hasItalyFiefOverlay と同一だが、呼び出し側で
 * 「どのオーバーレイの話か」を取り違えないよう別名で公開する。
 */
export function hasBritainFiefOverlay(
  year: number,
  overlayYears: readonly number[],
): boolean {
  return overlayYears.includes(year);
}

/**
 * 主権政体オーバーレイ GeoJSON の配信 URL を返す（純粋関数、#189）。
 * 出典は OpenHistoricalMap（CC0、生成は scripts/build-sovereign-fiefs.ts →
 * scripts/build-fief-flat.ts）。
 *
 * 参照先は生データ（sovereign_fiefs_<year>）ではなく、政体同士の重なりを
 * 排他化した派生データ sovereign_fiefs_flat_<year>。理由は
 * britainFiefDataUrlFor と同じで、半透明（FILL_ALPHA）の塗りが二重に
 * 重ならないようにするため（1783〜1815 年のハンガリー王国とトランシル
 * ヴァニアの境界スリバー等を flat 側が解消している。#189）。
 */
export function sovereignFiefDataUrlFor(year: number): string {
  return `/data/sovereign_fiefs_flat_${year}.geojson`;
}

/**
 * 指定年に主権政体オーバーレイが存在するか（純粋関数、#189）。
 * 対象年は config.SOVEREIGN_FIEF_OVERLAY_YEARS。判定規則は hasHreOverlay /
 * hasBritainFiefOverlay と同一だが、呼び出し側で「どのオーバーレイの話か」を
 * 取り違えないよう別名で公開する。
 */
export function hasSovereignFiefOverlay(
  year: number,
  overlayYears: readonly number[],
): boolean {
  return overlayYears.includes(year);
}

/**
 * base 境界線オーバーレイ GeoJSON の配信 URL を返す（純粋関数、TASK-78）。
 * 中身は base 勢力ポリゴンの環を諸侯領 union の外側だけに切り出した LineString
 * 群（生成は scripts/build-fief-dedupe.ts）。諸侯領オーバーレイ対象年に限り、
 * powers レイヤーの stroke を止めてこの層で境界線を描くことで、諸侯領の内側を
 * 走る base 境界線（= 二重輪郭）だけを消す。
 */
export function baseOutlineDataUrlFor(year: number): string {
  return `/data/base_outline_${year}.geojson`;
}

/**
 * 指定年に base 境界線オーバーレイが存在するか（純粋関数、TASK-78）。
 * 諸侯領オーバーレイと同じ年集合（config.FRANCE_FIEF_OVERLAY_YEARS）を渡す：
 * 派生データは諸侯領がある年にしか生成されない。
 */
export function hasBaseOutline(
  year: number,
  overlayYears: readonly number[],
): boolean {
  return overlayYears.includes(year);
}

/**
 * base 塗りオーバーレイ GeoJSON の配信 URL を返す（純粋関数、TASK-92）。
 * 中身は base 勢力ポリゴンから諸侯領 union を差し引いた派生 base
 * （生成は scripts/build-fief-dedupe.ts）。諸侯領オーバーレイ対象年に限り
 * powers レイヤーの塗りをこちらへ差し替えることで、半透明の諸侯領の下に
 * base の塗りが重なって生じる「境界線を伴わない濃淡」を消す。
 * baseOutlineDataUrlFor（線）と同じ union から作られており、
 * 「base の輪郭が消える範囲」と「base の塗りが消える範囲」は常に一致する。
 */
export function baseFillDataUrlFor(year: number): string {
  return `/data/europe_flat_${year}.geojson`;
}

/**
 * powers レイヤーの塗りに使う FeatureCollection を選ぶ（純粋関数、TASK-92）。
 * 派生 base（baseFill）があればそれを、無ければ従来どおり base を返す。
 *
 * 空 FC になるのは「諸侯領オーバーレイが無い年」と「派生データの取得に
 * 失敗した年」で、どちらも従来の描画（base をそのまま塗る）へ縮退させたい。
 * ラベル・帝国範囲強調・picking の入力は base のままにするため、差し替えは
 * この 1 箇所に閉じ込める。
 */
export function powerFillDataFor(
  base: FeatureCollection,
  baseFill: FeatureCollection,
): FeatureCollection {
  return baseFill.features.length > 0 ? baseFill : base;
}

/**
 * 表示モードを踏まえて powers レイヤーの塗りデータを選ぶ（純粋関数、#228 AC2）。
 *
 * - 詳細表示（detail: true、z5 以上）: 従来どおり powerFillDataFor（派生 base が
 *   あればそれ、無ければ base）。
 * - 概観表示（detail: false、z4）: 常に**穴のない素の base**（europe_<year>）。
 *   概観では領邦・諸侯領オーバーレイを visible: false で隠すため、領邦 union を
 *   差し引いた baseFill（europe_flat_<year>）を塗るとその分が透明な穴として
 *   抜け落ちる。
 *
 * powers の塗り（main.ts）・picking の出典解決（pick_handlers.ts）・デバッグ
 * フック（debug_hooks.ts）は必ずこの関数を通し、「実際に塗っている FC」と
 * 「picking / 出典が指す FC」が表示モードをまたいで食い違わないようにする。
 */
export function powerFillDataForMode(
  base: FeatureCollection,
  baseFill: FeatureCollection,
  detail: boolean,
): FeatureCollection {
  return detail ? powerFillDataFor(base, baseFill) : base;
}

/**
 * feature を持たない空の FeatureCollection（非対象年の HRE オーバーレイ用）。
 * 同一参照を返し続けることで deck.gl の data 差分判定を最小化する。
 */
export const EMPTY_FEATURE_COLLECTION: FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

/**
 * 年代キャッシュの保持上限（ローダ 1 本あたりの年代数。TASK-129）。
 *
 * 年代切替 1 回は最大 9 本の GeoJSON（base / hre / fiefs / outlines /
 * baseFill / italyFiefs / cliopatriaFiefs / britainFiefs / sovereignFiefs、
 * main.ts の複合ローダ構成）をローダ 1 本 = 1 ファイル系統で読み込む。
 * 上限なしだと全 19 年代の巡回で 19 年 × 9 本 = 最大 171 個の
 * FeatureCollection がヒープに残り続け（パース済み GeoJSON は元テキストの
 * 数倍を占める）、メモリ制約の厳しいモバイルでタブクラッシュの懸念がある。
 *
 * 4 年なら保持は最大 4 × 9 = 36 個（無制限時の約 2 割）に収まり、かつ
 * スライダーで隣接年代を行き来する典型操作（現在年 ± 数年分）は
 * キャッシュヒットのまま賄える。解放済みの年代は再選択時に再 fetch する
 * （HTTP キャッシュが効くため再取得コストはネットワーク往復に限られる）。
 */
export const YEAR_CACHE_MAX_YEARS = 4;

/** 年代キーの LRU キャッシュ（保持数上限つき。TASK-129） */
export interface YearCache<V> {
  /** 値を返し、その年代を「最近使った」扱いにする */
  get(year: number): V | undefined;
  /** 値を格納する。上限超過時は最も古く使われた年代を解放する */
  set(year: number, value: V): void;
  /** 年代が保持中か（退避順は更新しない） */
  has(year: number): boolean;
}

/**
 * 年代キーの LRU キャッシュを作る（TASK-129）。
 * Map の挿入順を「使った順」に写す定番の実装: get / set のたびに再挿入して
 * 末尾へ回し、上限超過時は先頭（= 最も古く使われた年代）を削除する。
 * createYearDataLoader と withSuzerainOverrides（suzerain_extent.ts）の
 * 双方で使い、年代 GeoJSON を保持する全キャッシュに同じ上限を効かせる。
 */
export function createYearCache<V>(
  maxYears: number = YEAR_CACHE_MAX_YEARS,
): YearCache<V> {
  const map = new Map<number, V>();
  return {
    has: (year) => map.has(year),
    get(year) {
      if (!map.has(year)) return undefined;
      const value = map.get(year) as V;
      map.delete(year);
      map.set(year, value);
      return value;
    },
    set(year, value) {
      map.delete(year);
      map.set(year, value);
      if (map.size > maxYears) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
    },
  };
}

/** fetch の最小契約（テストでモックできるよう Response 全体には依存しない） */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

/** URL を受け取りレスポンスを返す fetch 相当の関数 */
export type FetchLike = (url: string) => Promise<FetchResponseLike>;

/** 年代 GeoJSON のメモリキャッシュ付きローダ */
export interface YearDataLoader {
  /** 年代 GeoJSON を取得する（取得済みならキャッシュを返す） */
  load(year: number): Promise<FeatureCollection>;
  /** 年代がキャッシュ済みか */
  has(year: number): boolean;
}

/**
 * 年代 GeoJSON のメモリキャッシュ付きローダを作る。
 * - 取得済み年代はキャッシュから即返す
 * - キャッシュは LRU（保持上限 YEAR_CACHE_MAX_YEARS 年）。上限超過時は
 *   最も古く使われた年代を解放し、再選択時は再 fetch する（TASK-129）
 * - 同一年代への並行呼び出しは 1 回の fetch に集約する（inflight 共有）
 * - 失敗時はキャッシュも inflight も残さず、再試行できるようにする
 * fetch 部を引数で受けることで DOM 非依存にテストできる。
 * urlFor で URL 規則を差し替えられる（既定は base の europe_<year>、HRE は hre_<year>）。
 */
export function createYearDataLoader(
  fetchFn: FetchLike,
  urlFor: (year: number) => string = dataUrlFor,
): YearDataLoader {
  const cache = createYearCache<FeatureCollection>();
  const inflight = new Map<number, Promise<FeatureCollection>>();

  return {
    has: (year) => cache.has(year),
    load(year) {
      const cached = cache.get(year);
      if (cached !== undefined) return Promise.resolve(cached);
      const existing = inflight.get(year);
      if (existing !== undefined) return existing;

      const promise = (async () => {
        try {
          const res = await fetchFn(urlFor(year));
          if (!res.ok) {
            throw new Error(
              `GeoJSON 取得失敗 (year=${year}, status=${res.status})`,
            );
          }
          const data = await res.json() as FeatureCollection;
          cache.set(year, data);
          return data;
        } finally {
          inflight.delete(year);
        }
      })();
      inflight.set(year, promise);
      return promise;
    },
  };
}

/**
 * 年代限定オーバーレイ（HRE 領邦・フランス諸侯領）共通のローダを作る（TASK-71）。
 * - オーバーレイが無い年（overlayYears に含まれない）は fetch せず空 FC を即返す
 * - 対象年は urlFor(year) をキャッシュ・inflight 共有付きで取得する
 * - 取得失敗は reject せず warnFn へ通知して空 FC で解決する。オーバーレイは
 *   base 地図の付加情報であり、その欠落で年代切替全体（base の表示・ローディング
 *   /エラー UI）を失敗扱いにしない方針のため。失敗はキャッシュされず、次の
 *   切替時に再試行される。
 */
function createOverlayLoader(
  fetchFn: FetchLike,
  overlayYears: readonly number[],
  urlFor: (year: number) => string,
  overlayLabel: string,
  warnFn: (message: string) => void,
): YearDataLoader {
  const inner = createYearDataLoader(fetchFn, urlFor);
  return {
    // 非対象年は fetch 自体が不要なので常に「取得済み」扱い（スピナー抑止）
    has: (year) => !overlayYears.includes(year) || inner.has(year),
    load(year) {
      if (!overlayYears.includes(year)) {
        return Promise.resolve(EMPTY_FEATURE_COLLECTION);
      }
      return inner.load(year).catch((error: unknown) => {
        warnFn(
          `${overlayLabel}の取得に失敗しました。基本地図のみ表示します: ${
            String(error)
          }`,
        );
        return EMPTY_FEATURE_COLLECTION;
      });
    },
  };
}

/**
 * HRE 領邦オーバーレイ用のローダを作る（TASK-19）。
 * 挙動は createOverlayLoader（非対象年は空 FC・取得失敗は warn + 空 FC）に従う。
 *
 * TASK-86: overlayYears には OHM 年代と Roller 年代を合わせた
 * config.HRE_ALL_OVERLAY_YEARS を、ohmFiefYears には OHM 由来の
 * config.HRE_FIEF_OVERLAY_YEARS（中世 1000〜1492 + 近世 1715〜1800、#187）を渡す。
 * 「オーバーレイがあるか」と「どの出典のファイルを引くか」を 1 つのローダ内で
 * 分離することで、呼び出し側（main.ts）は年代をまたいで同一の hre スロットだけを
 * 見ればよく、UI（レイヤー・ラベル色・帝国範囲強調・picking）に年代分岐が入らない。
 */
export function createHreOverlayLoader(
  fetchFn: FetchLike,
  overlayYears: readonly number[],
  warnFn: (message: string) => void = console.warn,
  ohmFiefYears: readonly number[] = [],
): YearDataLoader {
  return createOverlayLoader(
    fetchFn,
    overlayYears,
    (year) => hreDataUrlFor(year, ohmFiefYears),
    "HRE オーバーレイ",
    warnFn,
  );
}

/**
 * 帝国全域ジオメトリ用のローダを作る（#332）。
 * 既存オーバーレイと同じ機構（createOverlayLoader）に載せることで、
 * - 非対象年（1700 以前・1815 以降）は fetch せず空 FC を返し、帝国が存在
 *   しない年代に外枠が復活しないことを構造的に保証する
 * - 取得失敗・データ未生成は reject せず warn + 空 FC に落ちるので、年代切替も
 *   base の表示も壊れない。このとき外枠は #332 以前と同じ「base だけの
 *   union」に縮退する（見た目が退行するだけで壊れない）
 */
export function createHreRealmLoader(
  fetchFn: FetchLike,
  overlayYears: readonly number[],
  warnFn: (message: string) => void = console.warn,
): YearDataLoader {
  return createOverlayLoader(
    fetchFn,
    overlayYears,
    hreRealmDataUrlFor,
    "帝国全域ジオメトリ",
    warnFn,
  );
}

/**
 * 中世フランス諸侯領オーバーレイ用のローダを作る（TASK-71）。
 * HRE 領邦オーバーレイと同じ機構（createOverlayLoader）に載せることで、
 * 非対象年（近世以降）は fetch せず空 FC を返し、ベースマップの France
 * ポリゴンと二重表示にならないことを構造的に保証する（AC #4）。
 */
export function createFranceFiefOverlayLoader(
  fetchFn: FetchLike,
  overlayYears: readonly number[],
  warnFn: (message: string) => void = console.warn,
): YearDataLoader {
  return createOverlayLoader(
    fetchFn,
    overlayYears,
    franceFiefDataUrlFor,
    "フランス諸侯領オーバーレイ",
    warnFn,
  );
}

/**
 * 中世イタリア諸侯領オーバーレイ用のローダを作る（TASK-96）。
 * HRE 領邦・仏諸侯領オーバーレイと同じ機構（createOverlayLoader）に載せることで、
 * 非対象年（1500 以降）は fetch せず空 FC を返し、ベースマップの
 * ヴェネツィア共和国・教皇領・ミラノ公国と二重表示にならないことを構造的に
 * 保証する。
 */
export function createItalyFiefOverlayLoader(
  fetchFn: FetchLike,
  overlayYears: readonly number[],
  warnFn: (message: string) => void = console.warn,
): YearDataLoader {
  return createOverlayLoader(
    fetchFn,
    overlayYears,
    italyFiefDataUrlFor,
    "イタリア諸侯領オーバーレイ",
    warnFn,
  );
}

/**
 * Cliopatria 領邦オーバーレイ用のローダを作る（TASK-110）。
 * 既存 3 系統と同じ機構（createOverlayLoader）に載せることで、
 * - 非対象年（1500 以降）は fetch せず空 FC を返し、base の主権国家
 *   ポリゴンと二重表示にならないことを構造的に保証する
 * - 取得失敗・**データ未生成**（cliopatria_fiefs_flat_* がまだ無い環境）は
 *   reject せず warn + 空 FC に落ちるので、年代切替も base の表示も壊れない
 *   （河川・山脈・諸侯領と同じ縮退契約）
 */
export function createCliopatriaFiefOverlayLoader(
  fetchFn: FetchLike,
  overlayYears: readonly number[],
  warnFn: (message: string) => void = console.warn,
): YearDataLoader {
  return createOverlayLoader(
    fetchFn,
    overlayYears,
    cliopatriaFiefDataUrlFor,
    "Cliopatria 領邦オーバーレイ",
    warnFn,
  );
}

/**
 * ブリテン諸島の政体オーバーレイ用のローダを作る（#172）。
 * 既存 4 系統と同じ機構（createOverlayLoader）に載せることで、
 * - 非対象年（1715 以降）は fetch せず空 FC を返し、base の United Kingdom /
 *   Kingdom of Ireland と二重表示にならないことを構造的に保証する
 * - 取得失敗・データ未生成は reject せず warn + 空 FC に落ちるので、
 *   年代切替も base の表示も壊れない（既存オーバーレイと同じ縮退契約）
 */
export function createBritainFiefOverlayLoader(
  fetchFn: FetchLike,
  overlayYears: readonly number[],
  warnFn: (message: string) => void = console.warn,
): YearDataLoader {
  return createOverlayLoader(
    fetchFn,
    overlayYears,
    britainFiefDataUrlFor,
    "ブリテン諸島の政体オーバーレイ",
    warnFn,
  );
}

/**
 * 主権政体オーバーレイ用のローダを作る（#189）。
 * 既存 5 系統と同じ機構（createOverlayLoader）に載せることで、
 * - 非対象年（1914 等）は fetch せず空 FC を返し、base が個別収録する
 *   後継国家（Finland ほか）と二重表示にならないことを構造的に保証する
 * - 取得失敗・データ未生成は reject せず warn + 空 FC に落ちるので、
 *   年代切替も base の表示も壊れない（既存オーバーレイと同じ縮退契約）
 */
export function createSovereignFiefOverlayLoader(
  fetchFn: FetchLike,
  overlayYears: readonly number[],
  warnFn: (message: string) => void = console.warn,
): YearDataLoader {
  return createOverlayLoader(
    fetchFn,
    overlayYears,
    sovereignFiefDataUrlFor,
    "主権政体オーバーレイ",
    warnFn,
  );
}

/**
 * base 境界線オーバーレイ用のローダを作る（TASK-78）。
 * HRE 領邦・諸侯領オーバーレイと同じ機構（createOverlayLoader）に載せるため、
 * 非対象年は fetch せず空 FC、取得失敗は warn + 空 FC になる。空 FC のときは
 * main.ts が powers レイヤーの stroke を従来どおり残すので、この派生データが
 * 欠けても見た目は TASK-78 以前と同じになる（縮退しても壊れない）。
 */
export function createBaseOutlineLoader(
  fetchFn: FetchLike,
  overlayYears: readonly number[],
  warnFn: (message: string) => void = console.warn,
): YearDataLoader {
  return createOverlayLoader(
    fetchFn,
    overlayYears,
    baseOutlineDataUrlFor,
    "base 境界線オーバーレイ",
    warnFn,
  );
}

/**
 * base 塗りオーバーレイ用のローダを作る（TASK-92）。
 * base 境界線オーバーレイ（createBaseOutlineLoader）と同じ機構に載せるため、
 * 非対象年は fetch せず空 FC、取得失敗は warn + 空 FC になる。空 FC のときは
 * powerFillDataFor が従来の base を返すので、この派生データが欠けても
 * 見た目は TASK-92 以前（＝二重塗りは残るが表示は壊れない）に留まる。
 */
export function createBaseFillLoader(
  fetchFn: FetchLike,
  overlayYears: readonly number[],
  warnFn: (message: string) => void = console.warn,
): YearDataLoader {
  return createOverlayLoader(
    fetchFn,
    overlayYears,
    baseFillDataUrlFor,
    "base 塗りオーバーレイ",
    warnFn,
  );
}

/**
 * 隣接年から流用した HRE 領邦（borrowed_hre_flat_<year>.geojson）の配信 URL を
 * 返す（純粋関数、#202 / ADR-0033）。
 *
 * 借用元の複製は scripts/build-borrowed-fiefs.ts が座標を変えずに作り
 * （borrowed_hre_<year>.geojson、Roller 由来 hre_<year>.geojson から）、配信
 * するのはそこから同年の hre_fiefs_flat を差し引いた flat 版（#215、
 * scripts/build-fief-flat.ts）。差し引かないと借用面が覆う既存領邦（1492 年の
 * County of Schaunberg）が picking で選択不能になる。既存の
 * hre_fiefs_flat_<year>（OHM / CC0）とは出典もライセンスも違うため、
 * **ファイルを分けたまま**ランタイムで hre-powers レイヤーへ足す
 * （withBorrowedGeometry）。1 ファイル 1 出典という生成物側の粒度を崩さずに、
 * feature 単位で正しい出典を出すための構成。
 */
export function borrowedHreDataUrlFor(year: number): string {
  return `/data/borrowed_hre_flat_${year}.geojson`;
}

/**
 * 隣接年から流用したイタリア諸侯領（borrowed_italy_flat_<year>.geojson）の
 * 配信 URL を返す（純粋関数、#202 / ADR-0033）。借用元は
 * italy_fiefs_<year>.geojson（OHM / CC0）で、配信するのは同年の
 * italy_fiefs_flat を差し引いた flat 版（#215）。italy-fiefs レイヤーと
 * 同一出典・同一ライセンスだが、「借用した面」を生成物として区別できるよう
 * 別ファイルに置く（借用の解消 = ファイルごと落とす、で済むようにするため）。
 */
export function borrowedItalyFiefDataUrlFor(year: number): string {
  return `/data/borrowed_italy_flat_${year}.geojson`;
}

/**
 * 借用面（HRE 系統）のローダを作る（#202）。
 * 既存オーバーレイと同じ機構（createOverlayLoader）に載せるため、借用の無い年は
 * fetch せず空 FC、取得失敗・未生成は warn + 空 FC に落ちる。
 *
 * #217: 取得失敗年の縮退先は「当該区画の無塗り」。base（europe_flat_<year>）は
 * ビルド時に借用 footprint を差し引き済み（scripts/build-fief-dedupe.ts）なので、
 * 借用面が欠けるとその区画は素のベースマップのまま残り、#209 以前の一括塗りには
 * 戻らない（正常時の二重塗り・picking 不能の防止を優先する）。失敗はキャッシュ
 * されず、次の年代切替で再試行される。
 */
export function createBorrowedHreLoader(
  fetchFn: FetchLike,
  borrowedYears: readonly number[],
  warnFn: (message: string) => void = console.warn,
): YearDataLoader {
  return createOverlayLoader(
    fetchFn,
    borrowedYears,
    borrowedHreDataUrlFor,
    "HRE 領邦の借用オーバーレイ",
    warnFn,
  );
}

/** 借用面（イタリア諸侯領系統）のローダを作る（#202）。挙動は HRE 側と同じ */
export function createBorrowedItalyFiefLoader(
  fetchFn: FetchLike,
  borrowedYears: readonly number[],
  warnFn: (message: string) => void = console.warn,
): YearDataLoader {
  return createOverlayLoader(
    fetchFn,
    borrowedYears,
    borrowedItalyFiefDataUrlFor,
    "イタリア諸侯領の借用オーバーレイ",
    warnFn,
  );
}

/**
 * 借用ファイルの feature を既存オーバーレイの FeatureCollection へ足す（純粋関数、
 * #202 / ADR-0033）。
 *
 * 借用 feature には借用ファイルの metadata（出典・ライセンス・境界の確からしさ・
 * borrowedFrom）を properties.ATTRIBUTION として写す。情報パネルは
 * FeatureCollection の metadata を読む契約（pick_handlers.ts pickedMetadata）
 * だが、1 枚のレイヤーへ出典の異なる面が載る場合はそれでは足りないため、
 * feature 側の出典を優先させるための土台をここで用意する。データファイル自体は
 * 系統ごとに分かれたままなので、生成物の「1 ファイル 1 出典」は崩れない。
 *
 * 借用が無い（feature 0 件）ときは入力をそのまま（同一参照で）返し、deck.gl の
 * 差分更新に無用な再アップロードを起こさない。既存 feature も同一参照のまま
 * 保ち、レイヤー側の metadata（既存系統の出典）は書き換えない。
 */
export function mergeBorrowedFeatures(
  fc: FeatureCollection,
  borrowed: FeatureCollection,
): FeatureCollection {
  if (borrowed.features.length === 0) return fc;
  const attribution = (borrowed as { metadata?: unknown }).metadata;
  const added = borrowed.features.map((feature) =>
    attribution === undefined ? feature : {
      ...feature,
      properties: { ...(feature.properties ?? {}), ATTRIBUTION: attribution },
    }
  );
  return { ...fc, features: [...fc.features, ...added] };
}

/**
 * 既存オーバーレイのローダに借用面のローダを重ねる（#202）。
 * 両者を並行に取得して mergeBorrowedFeatures で束ねるため、呼び出し側
 * （main.ts）から見ると従来どおり 1 本のローダのままで、レイヤー・色・ラベル・
 * picking は借用の有無で分岐しない。マージ結果は年ごとに保持して、同じ年を
 * 再ロードしたときの参照を安定させる（deck.gl の差分更新のため）。保持は
 * withSuzerainOverrides と同じ LRU（上限 YEAR_CACHE_MAX_YEARS 年）に載せる。
 *
 * #217: 保持するのはマージが完全に成功した年だけ。base が縮退（取得失敗で
 * 空 FC）した年は、借用面 1 枚だけのマージ結果を保持すると復旧後も内側
 * fetch が二度と走らないため保持しない。借用側だけ失敗した年も従来どおり
 * 保持しない（result === base）。どちらの縮退も次の load が内側ローダへ
 * 戻って fetch を再試行する（createOverlayLoader の「失敗はキャッシュしない」
 * 契約と同じ）。has() はマージ結果を保持中の年を true にする。内側ローダの
 * LRU から追い出された年でもここが保持していれば fetch なしで解決できるため、
 * ローディング表示を出さない（従来は内側の has だけを見て false になっていた）。
 */
export function withBorrowedGeometry(
  loader: YearDataLoader,
  borrowedLoader: YearDataLoader,
): YearDataLoader {
  const merged = createYearCache<FeatureCollection>();
  return {
    has: (year) =>
      merged.has(year) || (loader.has(year) && borrowedLoader.has(year)),
    async load(year) {
      const cached = merged.get(year);
      if (cached !== undefined) return cached;
      const [base, borrowed] = await Promise.all([
        loader.load(year),
        borrowedLoader.load(year),
      ]);
      const result = mergeBorrowedFeatures(base, borrowed);
      if (result !== base && base.features.length > 0) {
        merged.set(year, result);
      }
      return result;
    },
  };
}

/**
 * 年代切替で同時に反映する base（europe_*）・hre（hre_*）・
 * fiefs（france_fiefs_*、TASK-71）・outlines（base_outline_*、TASK-78）の
 * データ組
 */
export interface YearLayerData {
  /** 勢力圏 base レイヤーの FeatureCollection */
  base: FeatureCollection;
  /** HRE 領邦オーバーレイの FeatureCollection（非対象年・取得失敗時は空） */
  hre: FeatureCollection;
  /** 中世フランス諸侯領オーバーレイの FeatureCollection（非対象年・取得失敗時は空） */
  fiefs: FeatureCollection;
  /**
   * base 境界線オーバーレイ（諸侯領の内側を除いた base 輪郭）の
   * FeatureCollection（非対象年・取得失敗時は空 = powers の stroke で描く）
   */
  outlines: FeatureCollection;
  /**
   * base 塗りオーバーレイ（諸侯領 union を差し引いた派生 base、TASK-92）の
   * FeatureCollection（非対象年・取得失敗時は空 = base をそのまま塗る）
   */
  baseFill: FeatureCollection;
  /**
   * イタリア諸侯領オーバーレイ（italy_fiefs_flat_*、1000〜1500。TASK-96、#188）の
   * FeatureCollection（非対象年・取得失敗時は空）
   */
  italyFiefs: FeatureCollection;
  /**
   * Cliopatria 由来の領邦オーバーレイ（cliopatria_fiefs_flat_*、1000〜1492。
   * TASK-110）の FeatureCollection（非対象年・取得失敗・未生成時は空）
   */
  cliopatriaFiefs: FeatureCollection;
  /**
   * ブリテン諸島の政体オーバーレイ（britain_fiefs_flat_*、1000〜1700。#172）の
   * FeatureCollection（非対象年・取得失敗・未生成時は空）
   */
  britainFiefs: FeatureCollection;
  /**
   * 主権政体オーバーレイ（sovereign_fiefs_flat_*、1200〜1900。#189）の
   * FeatureCollection（非対象年・取得失敗・未生成時は空）
   */
  sovereignFiefs: FeatureCollection;
  /**
   * 帝国全域ジオメトリ（hre_realm_<year>、1715〜1800。#332）の
   * FeatureCollection（非対象年・取得失敗・未生成時は空）。
   *
   * 他のスロットと違い**レイヤーとして描画も picking もしない**。勢力圏の
   * 外枠（suzerain_extent.ts）の union 入力にだけ渡す。base と同じ複合ローダで
   * 束ねるのは、外枠が常に「表示中の年の帝国」を囲む必要があるため
   * （遅れて届く経路にすると、年代切替直後に前年の帝国や空の外枠が出る）。
   */
  hreRealm: FeatureCollection;
}

/** base + hre + fiefs をまとめてロードする複合ローダ */
export interface CombinedYearLoader {
  /** base・hre・fiefs を並行ロードし、全て揃ってから返す */
  load(year: number): Promise<YearLayerData>;
  /** base・hre・fiefs の全てが取得済み（fetch 不要）か */
  has(year: number): boolean;
}

/**
 * base ローダと 2 系統のオーバーレイローダ（HRE 領邦・フランス諸侯領）を束ねた
 * 複合ローダを作る。Promise.all で並行ロードし、全て揃ってから解決するため、
 * applyFn には常に同じ年の base / hre / fiefs が対になって渡る（一部だけ先に
 * 反映されるちらつきが無い）。base の失敗は reject（既存のローディング/エラー
 * UI が処理）、オーバーレイの失敗は各 createXxxOverlayLoader 側で空 FC に
 * 落ちるため、ここでは特別扱いしない。
 *
 * fiefLoader（TASK-71）・outlineLoader（TASK-78）・baseFillLoader（TASK-92）・
 * italyFiefLoader（TASK-96）・cliopatriaFiefLoader（TASK-110）・
 * britainFiefLoader（#172）・sovereignFiefLoader（#189）は任意
 * （それ以前の呼び出しと後方互換）。
 * 省略時はそれぞれ常に空 FC になり、従来どおりの挙動になる。
 */
export function createCombinedYearLoader(
  baseLoader: YearDataLoader,
  hreLoader: YearDataLoader,
  fiefLoader?: YearDataLoader,
  outlineLoader?: YearDataLoader,
  baseFillLoader?: YearDataLoader,
  italyFiefLoader?: YearDataLoader,
  cliopatriaFiefLoader?: YearDataLoader,
  britainFiefLoader?: YearDataLoader,
  sovereignFiefLoader?: YearDataLoader,
  hreRealmLoader?: YearDataLoader,
): CombinedYearLoader {
  return {
    has: (year) =>
      baseLoader.has(year) && hreLoader.has(year) &&
      (fiefLoader === undefined || fiefLoader.has(year)) &&
      (outlineLoader === undefined || outlineLoader.has(year)) &&
      (baseFillLoader === undefined || baseFillLoader.has(year)) &&
      (italyFiefLoader === undefined || italyFiefLoader.has(year)) &&
      (cliopatriaFiefLoader === undefined || cliopatriaFiefLoader.has(year)) &&
      (britainFiefLoader === undefined || britainFiefLoader.has(year)) &&
      (sovereignFiefLoader === undefined || sovereignFiefLoader.has(year)) &&
      (hreRealmLoader === undefined || hreRealmLoader.has(year)),
    async load(year) {
      const [
        base,
        hre,
        fiefs,
        outlines,
        baseFill,
        italyFiefs,
        cliopatriaFiefs,
        britainFiefs,
        sovereignFiefs,
        hreRealm,
      ] = await Promise
        .all([
          baseLoader.load(year),
          hreLoader.load(year),
          fiefLoader?.load(year) ?? Promise.resolve(EMPTY_FEATURE_COLLECTION),
          outlineLoader?.load(year) ??
            Promise.resolve(EMPTY_FEATURE_COLLECTION),
          baseFillLoader?.load(year) ??
            Promise.resolve(EMPTY_FEATURE_COLLECTION),
          italyFiefLoader?.load(year) ??
            Promise.resolve(EMPTY_FEATURE_COLLECTION),
          cliopatriaFiefLoader?.load(year) ??
            Promise.resolve(EMPTY_FEATURE_COLLECTION),
          britainFiefLoader?.load(year) ??
            Promise.resolve(EMPTY_FEATURE_COLLECTION),
          sovereignFiefLoader?.load(year) ??
            Promise.resolve(EMPTY_FEATURE_COLLECTION),
          hreRealmLoader?.load(year) ??
            Promise.resolve(EMPTY_FEATURE_COLLECTION),
        ]);
      return {
        base,
        hre,
        fiefs,
        outlines,
        baseFill,
        italyFiefs,
        cliopatriaFiefs,
        britainFiefs,
        sovereignFiefs,
        hreRealm,
      };
    },
  };
}

/** createYearSwitcher が必要とする loader の最小契約（load のみ） */
export interface YearLoaderLike<T = FeatureCollection> {
  load(year: number): Promise<T>;
}

/**
 * {@linkcode withPrimedYear} が扱うローダの最小契約
 * （{@linkcode CombinedYearLoader} と構造的に互換）。
 */
export interface PrimableYearLoader<T> {
  load(year: number): Promise<T>;
  has(year: number): boolean;
}

/**
 * 指定年の load を生成と同時に 1 回だけ前倒しで開始するローダを作る（#249）。
 *
 * 起動時、初期年代 geojson の取得を map の load イベント・静的データ 10 件の
 * 完了を待たずに始めるための注入点。最初の load(year) 呼び出し
 * （main.ts では initPowerLayer → switchYear → yearSwitcher 経由）が前倒しの
 * 結果を受け取り、指定年以外・2 回目以降の load と has は内側へそのまま
 * 委譲する。
 *
 * エラー経路の設計（unhandled rejection を出さない）:
 * - 前倒しした Promise は reject させず Result（ok / error）に包んで保持する。
 *   消費されるまで放置されても unhandled rejection にならない。
 * - 消費時に error を投げ直すため、待ち合わせ側（switchYear）は従来どおり
 *   failLoading + console.error のエラー経路で処理できる。
 * - 前倒し結果は一度きりで破棄する（一度きりでないと、失敗結果を返し続けて
 *   エラートーストからの再試行が永遠に同じ失敗を掴む）。再試行は内側の素の
 *   load（再 fetch）へ届く。
 */
export function withPrimedYear<T>(
  loader: PrimableYearLoader<T>,
  year: number,
): PrimableYearLoader<T> {
  type PrimedResult = { ok: true; data: T } | { ok: false; error: unknown };
  let primed: Promise<PrimedResult> | null = loader.load(year).then(
    (data): PrimedResult => ({ ok: true, data }),
    (error): PrimedResult => ({ ok: false, error }),
  );
  return {
    has: (y) => loader.has(y),
    load(y) {
      if (y !== year || primed === null) return loader.load(y);
      const pending = primed;
      primed = null;
      return pending.then((result) => {
        if (result.ok) return result.data;
        throw result.error;
      });
    },
  };
}

/** 表示年代の切替を担う（並行要求の競合ガード付き） */
export interface YearSwitcher {
  /** 指定年代へ切り替える。最新要求以外は解決しても反映しない */
  switchTo(year: number): Promise<void>;
  /** 直近に反映（適用）された年代。未適用なら undefined */
  currentYear(): number | undefined;
}

/**
 * 年代切替のロジック（DOM/deck.gl 非依存）。
 *
 * switchTo(1200) → switchTo(1300) と高頻度に呼ばれた際（TASK-6 のスライダードラッグ）、
 * 古い 1200 の fetch が新しい 1300 の後に解決すると表示が巻き戻る競合が起きる。
 * これを防ぐため要求ごとに単調増加トークンを発行し、解決時点で自分が最新要求で
 * なければ applyFn を呼ばない（＝表示・currentYear を巻き戻さない）。
 *
 * applyFn は「取得済みデータを実際に表示へ反映する」副作用（overlay 更新など）を担う。
 * loader はキャッシュ・fetch を担い、ここには DOM も deck.gl も持ち込まない。
 * データ型はジェネリクス T（既定 FeatureCollection）で、複合ローダの
 * YearLayerData（base+hre）もそのまま扱える。
 */
export function createYearSwitcher<T = FeatureCollection>(
  loader: YearLoaderLike<T>,
  applyFn: (year: number, data: T) => void,
): YearSwitcher {
  let latestToken = 0;
  let applied: number | undefined = undefined;

  return {
    currentYear: () => applied,
    async switchTo(year) {
      const token = ++latestToken;
      let data: T;
      try {
        data = await loader.load(year);
      } catch (error) {
        // TASK-48: 追い越された（stale）要求の失敗は成功時と同様に黙殺する。
        // reject を伝播すると、呼び出し側（switchYear）が現在表示と無関係な
        // 年代の失敗トーストを出してしまう。最新要求の失敗のみ伝播する。
        if (token !== latestToken) return;
        throw error;
      }
      // 自分より後に発行された要求があれば、この解決は古い ＝ 破棄する
      if (token !== latestToken) return;
      applied = year;
      applyFn(year, data);
    },
  };
}
