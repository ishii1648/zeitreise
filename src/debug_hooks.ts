/**
 * ヘッドレス CDP 検証用デバッグフック群（TASK-144。main.ts から抽出）。
 *
 * globalThis に生やす 15 件の読み取り専用フック（__setYear だけは年代切替の
 * 公開 API）。**フック名と返り値の形は scripts/verify/ のヘッドレス検証の
 * 契約**なので、1 文字も変えない（decision-29 / docs/main-ts-inventory.md §2 U1）。
 *
 * decision-29 の方針どおり、このモジュールは module-scope の可変状態を持たない。
 * フックが読む main.ts 所有のモジュール状態（currentView・zoomStep・各データ
 * ストア・選択/ホバー状態）とインスタンス（map・overlay）・メモ化関数群は、
 * すべて {@linkcode DebugHookDeps} の getter・関数として注入される。メモ化
 * 関数を import ではなく注入にするのは、builder と同一のキャッシュインスタンスを
 * 共有するため（デバッグフックの呼び出しがフォントアトラス再生成や polylabel
 * 再計算を誘発しない。TASK-50/136 の参照同値契約）。
 */
import type { PickingInfo } from "@deck.gl/core";
import type { FeatureCollection } from "geojson";
import { WATER_LAYER_ID } from "./basemap.ts";
import {
  approximateBorderStackIsValid,
  politicalFillGroupId,
} from "./layer_stack.ts";
import {
  APPROXIMATE_BORDER_LAYER_IDS,
  APPROXIMATE_BORDER_SOURCE_ID,
  MAX_SEGMENT_KM_PROPERTY,
  TIER_PROPERTY,
} from "./approximate_borders.ts";
import {
  colorKeyFor,
  EMPTY_FEATURE_COLLECTION,
  hasBritainFiefOverlay,
  hasCliopatriaFiefOverlay,
  hasFranceFiefOverlay,
  hasHreOverlay,
  hasItalyFiefOverlay,
  hasSovereignFiefOverlay,
  powerFillDataForMode,
} from "./powers.ts";
import type { FiefDedupeTable } from "./fief_dedupe.ts";
import {
  buildLabelData,
  fiefLabelsVisibleAt,
  type LabelDatum,
  partitionFiefsBySuzerain,
  politicalDetailVisibleAt,
} from "./labels.ts";
import {
  extractSuzerainMembers,
  type SuzerainOverrides,
} from "./suzerain_extent.ts";
import {
  filterVisibleMountainLabels,
  type MountainLabelDatum,
} from "./mountains.ts";
import { type PeakEntry, type PeakLabelDatum, peakLabelText } from "./peaks.ts";
import { filterVisibleRiverLabels, type RiverLabelDatum } from "./rivers.ts";
import {
  type CitiesData,
  cityEntriesForYear,
  type CityEntry,
  filterCitiesByZoom,
  visibleCityRankLimit,
} from "./cities.ts";
import {
  BRITAIN_FIEF_LAYER_ID,
  CLIOPATRIA_FIEF_LAYER_ID,
  FRANCE_FIEF_LAYER_ID,
  HRE_LAYER_ID,
  ITALY_FIEF_LAYER_ID,
  PICKING_RADIUS_PX,
  POWER_LAYER_ID,
  SOVEREIGN_FIEF_LAYER_ID,
} from "./picking.ts";
import { ACTIVE_FILL_COLOR, isPowerActive } from "./power_highlight.ts";
import {
  BRITAIN_FIEF_OVERLAY_YEARS,
  CLIOPATRIA_FIEF_OVERLAY_YEARS,
  FRANCE_FIEF_OVERLAY_YEARS,
  HRE_ALL_OVERLAY_YEARS,
  HRE_FIEF_OVERLAY_YEARS,
  ITALY_FIEF_OVERLAY_YEARS,
  SOVEREIGN_FIEF_OVERLAY_YEARS,
} from "./config.ts";

/**
 * フックが読む「現在年の反映済みデータ」（main.ts currentView のサブセット）。
 * main.ts 側の実体には outlines など他のフィールドもあるが、フックが読む
 * ものだけを構造的に要求する。
 */
export interface DebugYearView {
  year: number;
  base: FeatureCollection;
  /** TASK-92: powers の塗りにだけ使う派生 base（空なら base をそのまま塗る） */
  baseFill: FeatureCollection;
  hre: FeatureCollection;
  fiefs: FeatureCollection;
  italyFiefs: FeatureCollection;
  cliopatriaFiefs: FeatureCollection;
  britainFiefs: FeatureCollection;
  sovereignFiefs: FeatureCollection;
}

/**
 * installDebugHooks へ main.ts から注入する依存。状態の所有は main.ts に残し
 * （decision-29）、ここでは読み取り用の getter・関数だけを受ける。
 */
export interface DebugHookDeps {
  /** 年代切替の公開 API（main.ts switchYear） */
  switchYear: (year: number) => Promise<void>;
  /** 現在年。年未確定時は初期年へフォールバック済みの値を返す契約 */
  currentYear: () => number;

  // ---- main.ts が所有するモジュール状態（getter 注入） ----
  getZoomStep: () => number;
  getCurrentView: () => DebugYearView | null;
  getNameJa: () => Record<string, string>;
  getOverrides: () => SuzerainOverrides;
  getFiefDedupe: () => FiefDedupeTable;
  getCitiesData: () => CitiesData;
  getMountainsData: () => FeatureCollection;
  getPeaksData: () => FeatureCollection;
  getRiversData: () => FeatureCollection;
  getApproximateBorderData: () => FeatureCollection;
  getHoveredRiverName: () => string | null;
  getSelectedRiverName: () => string | null;
  /** ホバー/クリック中の勢力の宗主キー（TASK-94。null は外枠なし） */
  getExtentKey: () => string | null;
  /** 政治ポリゴンの強調ストア（power_highlight.ts）。読み取りのみ使う */
  powerHighlight: { selected(): string | null; hovered(): string | null };

  // ---- main.ts 所有のインスタンス能力（使う操作だけ構造的に受ける） ----
  /** maplibre Map.project（[lon, lat] → container px） */
  project: (lngLat: [number, number]) => { x: number; y: number };
  /** maplibre Map.getSource（存在確認にのみ使う） */
  getStyleSource: (id: string) => unknown;
  /** 現在の MapLibre スタイルのレイヤー ID 列（main.ts currentStyleLayerIds） */
  currentStyleLayerIds: () => string[];
  /** deck.gl overlay.pickObject（Deck onHover と同じ単一 pick） */
  pickObject: (
    opts: { x: number; y: number; radius: number },
  ) => PickingInfo | null;

  // ---- main.ts の picking 解決・メタデータ関数 ----
  /** クリック時の picking 補正（main.ts resolveClickInfo。TASK-36） */
  resolveClickInfo: (info: PickingInfo) => PickingInfo;
  /** picking 結果の表示ラベル（main.ts pickedLabel） */
  pickedLabel: (info: PickingInfo) => string | null;
  /** 非標準トップレベル metadata の取り出し（main.ts collectionMetadata） */
  collectionMetadata: (data: unknown) => unknown;

  // ---- main.ts のメモ化インスタンス（builder とキャッシュを共有するため注入） ----
  memoizedMountainLabelData: (
    fc: FeatureCollection,
    ja: Record<string, string>,
  ) => { data: readonly MountainLabelDatum[] };
  memoizedPeakEntries: (fc: FeatureCollection) => readonly PeakEntry[];
  memoizedVisiblePeaks: (
    entries: readonly PeakEntry[],
    zoomStep: number,
  ) => readonly PeakEntry[];
  memoizedPeakLabelData: (
    entries: readonly PeakEntry[],
    ja: Record<string, string>,
  ) => readonly PeakLabelDatum[];
  memoizedPowerLabelData: (
    year: number,
    base: FeatureCollection,
    hre: FeatureCollection,
    fiefs: FeatureCollection,
    italyFiefs: FeatureCollection,
    cliopatriaFiefs: FeatureCollection,
    britainFiefs: FeatureCollection,
    sovereignFiefs: FeatureCollection,
    ja: Record<string, string>,
    dedupe: FiefDedupeTable,
  ) => { data: readonly LabelDatum[]; characterSet: readonly string[] };
  memoizedVisiblePowerLabels: (
    data: readonly LabelDatum[],
    zoomStep: number,
  ) => readonly LabelDatum[];
  memoizedCityAvoidPoints: (data: CitiesData) => readonly [number, number][];
  memoizedRiverLabelData: (
    fc: FeatureCollection,
    ja: Record<string, string>,
    avoidPoints: readonly [number, number][],
  ) => { data: readonly RiverLabelDatum[] };
  memoizedVisibleCityEntries: (
    data: CitiesData,
    year: number,
    zoomStep: number,
  ) => readonly CityEntry[];
}

/**
 * インストールされるフックの形（globalThis に生やすプロパティ）。
 * 名前・返り値の形ともヘッドレス検証（scripts/verify/checks/*）の契約。
 */
export interface DebugHooksTarget {
  __setYear?: (year: number) => Promise<void>;
  __getYear?: () => number;
  __getCityDebug?: () => {
    zoomStep: number;
    rankLimit: number;
    totalCities: number;
    visibleCities: number;
  };
  __getMountainLabelDebug?: () => {
    zoomStep: number;
    totalMountains: number;
    visibleLabels: { name: string; text: string; minZoom: number }[];
    screen: { name: string; x: number; y: number }[];
  };
  __getPeakDebug?: () => {
    zoomStep: number;
    totalPeaks: number;
    visible: {
      name: string;
      text: string;
      elevation: number | null;
      priority: number;
      x: number;
      y: number;
    }[];
  };
  __getPowerLabelDebug?: () => {
    zoomStep: number;
    fiefLabelsVisible: boolean;
    /**
     * #228 AC1/AC10: 政治領域の表示モード（true = 詳細 / false = 概観）。
     * 塗り・境界・ラベル・picking が共有する politicalDetailVisibleAt の値で、
     * ヘッドレス検証が z4/z5 のモード切替を無人確認するためのフィールド。
     * 既存フィールドは従来の契約のまま（追加のみ）。
     */
    politicalDetail: boolean;
    total: Record<string, number>;
    visible: Record<string, number>;
    suppressedVisible: string[];
    characterSetSize: number;
  };
  __getRiverLabelDebug?: () => {
    hovered: string | null;
    selected: string | null;
    zoomStep: number;
    visibleLabels: string[];
    visibleAnchors: { name: string; position: [number, number] }[];
  };
  __getFranceFiefDebug?: () => {
    year: number;
    overlay: boolean;
    featureCount: number;
    labels: string[];
  };
  __getHreFiefDebug?: () => {
    year: number;
    overlay: boolean;
    source: "ohm-medieval" | "roller-early-modern" | "none";
    featureCount: number;
    labels: string[];
  };
  __getItalyFiefDebug?: () => {
    year: number;
    overlay: boolean;
    featureCount: number;
    labels: string[];
  };
  __getCliopatriaFiefDebug?: () => {
    year: number;
    overlay: boolean;
    featureCount: number;
    source: unknown;
    hreLabels: string[];
    fiefLabels: string[];
  };
  __getBritainFiefDebug?: () => {
    year: number;
    overlay: boolean;
    featureCount: number;
    source: unknown;
    labels: string[];
  };
  __getSovereignFiefDebug?: () => {
    year: number;
    overlay: boolean;
    featureCount: number;
    source: unknown;
    labels: string[];
  };
  __getApproximateBorderDebug?: () => {
    year: number;
    sourcePresent: boolean;
    layers: { id: string; index: number }[];
    fillGroupIndex: number;
    waterIndex: number;
    stackValid: boolean;
    styleOrder: string[];
    runsByTier: Record<string, number>;
    longestRunKm: number;
  };
  __probePick?: (x: number, y: number) => {
    hoverLayer: string | null;
    hoverLabel: string | null;
    clickLayer: string | null;
    clickLabel: string | null;
  };
  __getPowerHighlightDebug?: () => {
    selected: string | null;
    hovered: string | null;
    activeColor: number[];
    activeFeatures: Record<string, number>;
    extentKey: string | null;
    extentMembers: string[];
  };
  __getCityScreenPositions?: () => { name: string; x: number; y: number }[];
}

/** インストールする 17 件のフック名（ヘッドレス検証の契約。変更禁止） */
export const DEBUG_HOOK_NAMES: readonly (keyof DebugHooksTarget)[] = [
  "__setYear",
  "__getYear",
  "__getCityDebug",
  "__getMountainLabelDebug",
  "__getPeakDebug",
  "__getPowerLabelDebug",
  "__getRiverLabelDebug",
  "__getFranceFiefDebug",
  "__getHreFiefDebug",
  "__getItalyFiefDebug",
  "__getCliopatriaFiefDebug",
  "__getBritainFiefDebug",
  "__getSovereignFiefDebug",
  "__getApproximateBorderDebug",
  "__probePick",
  "__getPowerHighlightDebug",
  "__getCityScreenPositions",
];

/**
 * デバッグフック群を target（既定は globalThis）へインストールする。
 * 既存の同名フックは代入で上書きされる（後勝ち。抽出前の逐次代入と同じ挙動）。
 */
export function installDebugHooks(
  deps: DebugHookDeps,
  target: DebugHooksTarget = globalThis as DebugHooksTarget,
): void {
  // 目視確認・TASK-6 スライダー用に year 切替を公開する（インラインスクリプト不要）。
  target.__setYear = deps.switchYear;
  target.__getYear = deps.currentYear;

  // TASK-66: ヘッドレス CDP 検証用にズーム別都市表示の内部状態を公開する
  // （__getYear と同じ「目視/無人確認のための読み取り専用フック」。deck.gl の
  // canvas からは表示都市数を数えられないため、フィルタ結果の件数を直接返す）。
  target.__getCityDebug = () => {
    const year = deps.currentYear();
    const zoomStep = deps.getZoomStep();
    const entries = cityEntriesForYear(deps.getCitiesData(), year);
    return {
      zoomStep: zoomStep,
      rankLimit: visibleCityRankLimit(zoomStep),
      totalCities: entries.length,
      visibleCities: filterCitiesByZoom(entries, zoomStep).length,
    };
  };

  // TASK-97: ヘッドレス CDP 検証用に山脈ラベルの表示状態を公開する
  // （__getCityDebug と同じ読み取り専用フック）。canvas からは表示中のラベルを
  // 数えられないため、ズーム段・表示中の山脈名・アンカーの画面座標を直接返す。
  // AC #2（ズーム出し分け）は visibleLabels の増減で、AC #8（陰影との位置一致）は
  // screen の座標をスクリーンショットと突き合わせて確認する。
  target.__getMountainLabelDebug = () => {
    const zoomStep = deps.getZoomStep();
    const { data } = deps.memoizedMountainLabelData(
      deps.getMountainsData(),
      deps.getNameJa(),
    );
    const visible = filterVisibleMountainLabels(data, zoomStep);
    return {
      zoomStep,
      totalMountains: data.length,
      visibleLabels: visible.map((d) => ({
        name: d.name,
        text: d.text,
        minZoom: d.minZoom,
      })),
      screen: visible.map((d) => {
        const point = deps.project(d.position);
        return { name: d.name, x: point.x, y: point.y };
      }),
    };
  };

  // TASK-99: ヘッドレス CDP 検証用に山峰マーカー/ラベルの表示状態を公開する
  // （__getMountainLabelDebug と同じ読み取り専用フック）。AC #4（ズーム出し分け）は
  // visible の増減で、AC #9（陰影の山地との位置一致）は screen の座標を
  // スクリーンショットと突き合わせて確認する。text はそのズーム段で実際に描く
  // 文字列（標高併記の有無を含む）。
  target.__getPeakDebug = () => {
    const zoomStep = deps.getZoomStep();
    const allEntries = deps.memoizedPeakEntries(deps.getPeaksData());
    const labels = deps.memoizedPeakLabelData(
      deps.memoizedVisiblePeaks(allEntries, zoomStep),
      deps.getNameJa(),
    );
    return {
      zoomStep,
      totalPeaks: allEntries.length,
      visible: labels.map((d) => {
        const point = deps.project(d.position);
        return {
          name: d.name,
          text: peakLabelText(d, zoomStep),
          elevation: d.elevation,
          priority: d.priority,
          x: point.x,
          y: point.y,
        };
      }),
    };
  };

  // TASK-122: ヘッドレス CDP 検証用に勢力ラベルのズーム別表示状態を公開する
  // （__getMountainLabelDebug と同じ読み取り専用フック）。canvas からは表示中の
  // ラベルを数えられないため、絞り込み前後の内訳を直接返す。AC #1/#2 は
  // visible の kind 別件数で、AC #4（base 抑制の解除）は suppressedVisible
  // （そのズーム段で復活している base ラベル名）で確認する。
  target.__getPowerLabelDebug = () => {
    const zoomStep = deps.getZoomStep();
    const view = deps.getCurrentView();
    const { data, characterSet } = view === null
      ? { data: [] as LabelDatum[], characterSet: [] as string[] }
      : deps.memoizedPowerLabelData(
        view.year,
        view.base,
        view.hre,
        view.fiefs,
        view.italyFiefs,
        view.cliopatriaFiefs,
        view.britainFiefs,
        view.sovereignFiefs,
        deps.getNameJa(),
        deps.getFiefDedupe(),
      );
    const countByKind = (list: readonly LabelDatum[]) => {
      const counts: Record<string, number> = { base: 0, hre: 0, fief: 0 };
      for (const d of list) counts[d.kind ?? "base"]++;
      return counts;
    };
    const visible = deps.memoizedVisiblePowerLabels(data, zoomStep);
    return {
      zoomStep,
      fiefLabelsVisible: fiefLabelsVisibleAt(zoomStep),
      // #228 AC1/AC10: 塗り・境界・picking と共有する表示モード判定を公開する
      politicalDetail: politicalDetailVisibleAt(zoomStep),
      total: countByKind(data),
      visible: countByKind(visible),
      suppressedVisible: visible.filter((d) => d.suppressed === true).map((d) =>
        d.text
      ),
      characterSetSize: characterSet.length,
    };
  };

  // TASK-69: ヘッドレス CDP 検証用に河川ラベルの表示状態を公開する
  // （__getCityDebug と同じ「目視/無人確認のための読み取り専用フック」。deck.gl の
  // canvas からは表示中の河川ラベルを数えられないため、フィルタ結果を直接返す）。
  target.__getRiverLabelDebug = () => {
    const zoomStep = deps.getZoomStep();
    const hoveredRiverName = deps.getHoveredRiverName();
    const selectedRiverName = deps.getSelectedRiverName();
    const { data } = deps.memoizedRiverLabelData(
      deps.getRiversData(),
      deps.getNameJa(),
      deps.memoizedCityAvoidPoints(deps.getCitiesData()),
    );
    const visible = filterVisibleRiverLabels(
      data,
      hoveredRiverName,
      selectedRiverName,
      zoomStep,
    );
    return {
      hovered: hoveredRiverName,
      selected: selectedRiverName,
      // TASK-123: ズーム段で常時表示が変わるため、判定に使った段も返す
      zoomStep,
      visibleLabels: visible.map((d) => d.name),
      // TASK-136: アンカー回避の実機検証用に描画位置も返す（読み取り専用）
      visibleAnchors: visible.map((d) => ({
        name: d.name,
        position: d.position,
      })),
    };
  };

  // TASK-71: ヘッドレス CDP 検証用に中世フランス諸侯領オーバーレイの表示状態を
  // 公開する（__getCityDebug / __getRiverLabelDebug と同じ「目視/無人確認のための
  // 読み取り専用フック」。deck.gl の canvas からは表示中の諸侯領・ラベルを
  // 数えられないため、現在年のオーバーレイ有無・feature 数・ラベル名一覧を直接返す）。
  // AC #4 の「対象外の年で表示されない」ことは overlay=false / featureCount=0 /
  // labels=[] で確認できる。
  target.__getFranceFiefDebug = () => {
    const year = deps.currentYear();
    const fiefs = deps.getCurrentView()?.fiefs ?? EMPTY_FEATURE_COLLECTION;
    return {
      year,
      overlay: hasFranceFiefOverlay(year, FRANCE_FIEF_OVERLAY_YEARS),
      featureCount: fiefs.features.length,
      labels: buildLabelData(fiefs, deps.getNameJa(), "fief").map((d) =>
        d.text
      ),
    };
  };

  // TASK-86: ヘッドレス CDP 検証用に HRE 領邦オーバーレイの表示状態を公開する
  // （__getFranceFiefDebug と同型の読み取り専用フック）。中世（OHM 由来）と
  // 近世（Roller 由来）で出典が替わっても同じ hre-powers レイヤーに載ることを、
  // 年代を切り替えながら source / featureCount / labels で確認できる。
  target.__getHreFiefDebug = () => {
    const year = deps.currentYear();
    const hre = deps.getCurrentView()?.hre ?? EMPTY_FEATURE_COLLECTION;
    const overlay = hasHreOverlay(year, HRE_ALL_OVERLAY_YEARS);
    return {
      year,
      overlay,
      // #187 で OHM 由来年代は中世 + 近世（1715〜1800）に広がったが、CDP 検証
      // スクリプトが参照する識別子は互換のため据え置く（ohm-medieval = OHM 由来
      // hre_fiefs_flat_*、roller-early-modern = Roller 由来 hre_*）
      source: !overlay
        ? "none"
        : HRE_FIEF_OVERLAY_YEARS.includes(year)
        ? "ohm-medieval"
        : "roller-early-modern",
      featureCount: hre.features.length,
      labels: buildLabelData(hre, deps.getNameJa(), "hre").map((d) => d.text),
    };
  };

  // TASK-96: ヘッドレス CDP 検証用に中世イタリア諸侯領オーバーレイの表示状態を
  // 公開する（__getFranceFiefDebug / __getHreFiefDebug と同型の読み取り専用フック）。
  // AC #1（1200 年のフィレンツェ・ジェノヴァ・ピサ・シエナ・ルッカ・スポレート）・
  // AC #2（1100 年のトスカーナ辺境伯領）は labels の内容で確認できる。
  target.__getItalyFiefDebug = () => {
    const year = deps.currentYear();
    const italyFiefs = deps.getCurrentView()?.italyFiefs ??
      EMPTY_FEATURE_COLLECTION;
    return {
      year,
      overlay: hasItalyFiefOverlay(year, ITALY_FIEF_OVERLAY_YEARS),
      featureCount: italyFiefs.features.length,
      labels: buildLabelData(italyFiefs, deps.getNameJa(), "fief").map((d) =>
        d.text
      ),
    };
  };

  // TASK-110: ヘッドレス CDP 検証用に Cliopatria 由来の領邦オーバーレイの表示
  // 状態を公開する（__getItalyFiefDebug と同型の読み取り専用フック）。
  // AC #5（1000/1100 年のアキテーヌ公領・トゥールーズ伯領・王領、1279〜1492 年の
  // バイエルン公領）は labels の内容で、AC #3（出典が OHM 由来と区別できる）は
  // source の内容で確認できる。hreLabels / fiefLabels を分けて返すのは、
  // 凡例（臙脂 = 帝国領邦 / 藍紫 = 諸侯領）の出し分けが宗主どおりに効いて
  // いるかを canvas を見ずに突き合わせるため。
  target.__getCliopatriaFiefDebug = () => {
    const year = deps.currentYear();
    const nameJa = deps.getNameJa();
    const cliopatriaFiefs = deps.getCurrentView()?.cliopatriaFiefs ??
      EMPTY_FEATURE_COLLECTION;
    const groups = partitionFiefsBySuzerain(cliopatriaFiefs);
    return {
      year,
      overlay: hasCliopatriaFiefOverlay(year, CLIOPATRIA_FIEF_OVERLAY_YEARS),
      featureCount: cliopatriaFiefs.features.length,
      // TASK-109 の出典 metadata（source / license / sourceUrl …）をそのまま返す。
      // 情報パネルに出るのと同じ値なので、AC #3 の「OHM 由来と区別できる」を
      // 出典行の生成前の段階で確認できる。
      source: deps.collectionMetadata(cliopatriaFiefs),
      hreLabels: buildLabelData(groups.hre, nameJa, "hre").map((d) => d.text),
      fiefLabels: buildLabelData(groups.fief, nameJa, "fief").map((d) =>
        d.text
      ),
    };
  };

  // #172: ヘッドレス CDP 検証用にブリテン諸島の政体オーバーレイの表示状態を
  // 公開する（__getItalyFiefDebug と同型の読み取り専用フック）。ウェールズ・
  // アイルランド諸王国（1000〜1279）とアイルランドの政体（1600〜1700）の表示は
  // labels の内容で、出典・ライセンス（OpenHistoricalMap / CC0-1.0）は source の
  // 内容で確認できる。
  target.__getBritainFiefDebug = () => {
    const year = deps.currentYear();
    const britainFiefs = deps.getCurrentView()?.britainFiefs ??
      EMPTY_FEATURE_COLLECTION;
    return {
      year,
      overlay: hasBritainFiefOverlay(year, BRITAIN_FIEF_OVERLAY_YEARS),
      featureCount: britainFiefs.features.length,
      source: deps.collectionMetadata(britainFiefs),
      labels: buildLabelData(britainFiefs, deps.getNameJa(), "fief").map((d) =>
        d.text
      ),
    };
  };

  // #189: ヘッドレス CDP 検証用に主権政体オーバーレイの表示状態を公開する
  // （__getBritainFiefDebug と同型の読み取り専用フック）。ハンガリー王国・
  // クリミア・ハン国・フィンランド大公国などの表示は labels の内容で、
  // 出典・ライセンス（OpenHistoricalMap / CC0-1.0）は source の内容で
  // 確認できる。
  target.__getSovereignFiefDebug = () => {
    const year = deps.currentYear();
    const sovereignFiefs = deps.getCurrentView()?.sovereignFiefs ??
      EMPTY_FEATURE_COLLECTION;
    return {
      year,
      overlay: hasSovereignFiefOverlay(year, SOVEREIGN_FIEF_OVERLAY_YEARS),
      featureCount: sovereignFiefs.features.length,
      source: deps.collectionMetadata(sovereignFiefs),
      labels: buildLabelData(sovereignFiefs, deps.getNameJa(), "fief").map((
        d,
      ) => d.text),
    };
  };

  // TASK-80: ヘッドレス CDP 検証用に概略境界（MapLibre line レイヤー）の状態を
  // 公開する（__getCityDebug と同じ読み取り専用フック）。canvas のピクセルからは
  // 「どの区間がどの段で描かれているか」を数えられないため、段ごとの run 数と
  // スタイル上の重ね順（塗り → 概略境界 → 海洋 water）を直接返す。
  target.__getApproximateBorderDebug = () => {
    const styleLayerIds = deps.currentStyleLayerIds();
    const runsByTier: Record<string, number> = {};
    let longestRunKm = 0;
    for (const feature of deps.getApproximateBorderData().features) {
      const tier = String(feature.properties?.[TIER_PROPERTY]);
      runsByTier[tier] = (runsByTier[tier] ?? 0) + 1;
      longestRunKm = Math.max(
        longestRunKm,
        Number(feature.properties?.[MAX_SEGMENT_KM_PROPERTY] ?? 0),
      );
    }
    return {
      year: deps.currentYear(),
      sourcePresent:
        deps.getStyleSource(APPROXIMATE_BORDER_SOURCE_ID) !== undefined,
      layers: APPROXIMATE_BORDER_LAYER_IDS.map((id) => ({
        id,
        index: styleLayerIds.indexOf(id),
      })),
      // 政治ポリゴンの塗りは deck のレイヤーグループ（custom レイヤー）として
      // 1 枚に束ねられる（"powers" という ID はスタイル上に存在しない）
      fillGroupIndex: styleLayerIds.indexOf(
        politicalFillGroupId(styleLayerIds) ?? "",
      ),
      waterIndex: styleLayerIds.indexOf(WATER_LAYER_ID),
      stackValid: approximateBorderStackIsValid(styleLayerIds),
      styleOrder: styleLayerIds,
      runsByTier,
      longestRunKm,
    };
  };

  // TASK-82: ヘッドレス CDP 検証用に「画面座標 (x, y) をホバー/クリックしたら
  // 何が拾えるか」を公開する（__getCityDebug と同じ読み取り専用フック）。
  // ホバー側は Deck が onHover で使うのと同じ pickObject（pickingRadius 付き）、
  // クリック側はさらに resolveClickInfo を通した結果で、両者のレイヤー ID と
  // 表示ラベルを返す。都市マーカー中心からのオフセットを変えながら呼べば、
  // 実効判定範囲（cities.ts CITY_PICK_TOLERANCE_PX = 9px）とホバー/クリックの
  // 一致（AC #1/#2）、河畔都市・密集地域での取り違えの有無（AC #3/#6）を
  // canvas のピクセルを見ずに確認できる。
  target.__probePick = (x, y) => {
    const raw = deps.pickObject({ x, y, radius: PICKING_RADIUS_PX }) ??
      ({ x, y, layer: null, object: undefined } as unknown as PickingInfo);
    const click = deps.resolveClickInfo(raw);
    return {
      hoverLayer: raw.layer?.id ?? null,
      hoverLabel: deps.pickedLabel(raw),
      clickLayer: click.layer?.id ?? null,
      clickLabel: deps.pickedLabel(click),
    };
  };

  // TASK-90: ヘッドレス CDP 検証用に政治ポリゴンの強調状態を公開する
  // （__getCityDebug と同じ読み取り専用フック）。canvas のピクセルからは
  // 「どの feature がアクティブ色で塗られているか」を数えられないため、
  // 現在の選択・ホバーキーと、そのキーでアクティブになる feature 数を
  // レイヤー別に返す。飛び地を含む同一勢力が同時に強調されること（AC #1/#4）と、
  // 解除（AC #2/#6）・HRE 帝国範囲強調との併存（AC #5）を無人で確認できる。
  target.__getPowerHighlightDebug = () => {
    const view = deps.getCurrentView();
    const extentKey = deps.getExtentKey();
    const selected = deps.powerHighlight.selected();
    const hovered = deps.powerHighlight.hovered();
    const countActive = (fc: FeatureCollection) =>
      fc.features.filter((f) =>
        isPowerActive(colorKeyFor(f.properties), selected, hovered)
      ).length;
    return {
      selected,
      hovered,
      activeColor: [...ACTIVE_FILL_COLOR],
      activeFeatures: {
        [POWER_LAYER_ID]: countActive(
          // TASK-92: powers が実際に塗るのは派生 base（対象年）なのでそれを数える。
          // #228: 概観（z4）では塗りが素の base に切り替わるため、表示モードを
          // 塗り側（main.ts renderLayers）と同じ選択関数で共有する
          powerFillDataForMode(
            view?.base ?? EMPTY_FEATURE_COLLECTION,
            view?.baseFill ?? EMPTY_FEATURE_COLLECTION,
            politicalDetailVisibleAt(deps.getZoomStep()),
          ),
        ),
        [HRE_LAYER_ID]: countActive(view?.hre ?? EMPTY_FEATURE_COLLECTION),
        [FRANCE_FIEF_LAYER_ID]: countActive(
          view?.fiefs ?? EMPTY_FEATURE_COLLECTION,
        ),
        [ITALY_FIEF_LAYER_ID]: countActive(
          view?.italyFiefs ?? EMPTY_FEATURE_COLLECTION,
        ),
        [CLIOPATRIA_FIEF_LAYER_ID]: countActive(
          view?.cliopatriaFiefs ?? EMPTY_FEATURE_COLLECTION,
        ),
        [BRITAIN_FIEF_LAYER_ID]: countActive(
          view?.britainFiefs ?? EMPTY_FEATURE_COLLECTION,
        ),
        [SOVEREIGN_FIEF_LAYER_ID]: countActive(
          view?.sovereignFiefs ?? EMPTY_FEATURE_COLLECTION,
        ),
      },
      // TASK-94: 外枠の対象（宗主キー）と、その外枠に含まれる base feature の
      // NAME 一覧。canvas のピクセルからは外枠の範囲を読めないため、実機検証は
      // ここで「誰が囲まれているか」を突き合わせる（AC #1/#3/#8/#9）。
      extentKey,
      extentMembers: extractSuzerainMembers(
        view?.base ?? EMPTY_FEATURE_COLLECTION,
        extentKey,
        deps.getOverrides(),
      ).map((f) => String(f.properties?.NAME ?? "")),
    };
  };

  // TASK-82: __probePick の呼び出し座標を組み立てるための補助フック。現在表示中の
  // 都市マーカー（ズームフィルタ済み）の画面座標（container px = deck の x/y と
  // 同一系）を返す。密集地域（1500 年 HRE 域）での隣接都市の間隔や、河畔都市
  // （パリ・ルーアン）の中心座標を実行時に取得して probe に渡すために使う。
  target.__getCityScreenPositions = () => {
    const year = deps.currentYear();
    const entries = deps.memoizedVisibleCityEntries(
      deps.getCitiesData(),
      year,
      deps.getZoomStep(),
    );
    return entries.map((entry) => {
      const point = deps.project([entry.lon, entry.lat]);
      return { name: entry.name, x: point.x, y: point.y };
    });
  };
}
