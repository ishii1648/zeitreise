/**
 * 政治レイヤー builder 群（TASK-148 / Issue #166。main.ts から抽出）。
 *
 * 政治ポリゴン（powers / hre-powers / 諸侯領オーバーレイ 3 系統で共用する
 * {@linkcode createPoliticalLayerBuilders} の buildPowerLayer）・勢力圏の外枠
 * （buildSuzerainExtentLayer）・勢力名ラベル（buildLabelLayer）の 3 builder と、
 * それらの見た目定数（HRE_EXTENT_\* / 内部境界の INTERNAL_BORDER_STYLES。
 * #267）・メモ化を持つ。
 *
 * decision-29 / docs/main-ts-inventory.md §2 U5 の方針（TASK-147 の
 * feature_layers.ts と同型）:
 * - **状態の所有は main.ts に残す**。builder は main が renderLayers ごとに
 *   組み立てる {@linkcode PoliticalLayerContext}（データストア参照・強調キー・
 *   塗り遷移時間・スタイルレイヤー順のスナップショット）だけを読む純関数で、
 *   このモジュールは module-scope の可変状態を持たない。fillTransitionMs の
 *   一時差し替え（renderWithFillTransition）と powerHighlight ストアの所有は
 *   main.ts 側に残り、ここへは**値**として渡る。
 * - `memoizeLatest` のキャッシュ（TASK-50/136 の参照同値契約の実体）と
 *   勢力圏外枠の union キャッシュ（suzerain_extent.ts）は
 *   {@linkcode createPoliticalLayerBuilders} ファクトリの closure に置く。
 *   main.ts はファクトリを 1 度だけ呼び、返り値のメモ化インスタンスを
 *   そのまま debug_hooks.ts へ注入することで「builder とデバッグフックが
 *   同一キャッシュを共有する」（フックの呼び出しが polylabel 再計算や
 *   フォントアトラス再生成を誘発しない）を維持する。
 * - beforeId の計算（underWaterBeforeId / suzerainExtentBeforeId）は MapLibre の
 *   現在スタイルに依存するため、context の styleLayerIds（main.ts
 *   currentStyleLayerIds のスナップショット）を入力に取る。
 * - 勢力圏の外枠が union へ合流させる沿岸補完の帯（#330）も、所有は main.ts
 *   （coastal_fill_sync.ts）に残り context の coastalBands として値で渡る。
 */
import { GeoJsonLayer, TextLayer } from "@deck.gl/layers";
import type { CollisionFilterExtensionProps } from "@deck.gl/extensions";
import type { Feature, FeatureCollection, GeoJsonProperties } from "geojson";
import {
  LABEL_LAYER_ID,
  suzerainExtentBeforeId,
  TOP_LABEL_LAYER_ID,
  underWaterBeforeId,
} from "./layer_stack.ts";
import {
  colorKeyFor,
  EMPTY_FEATURE_COLLECTION,
  FILL_ALPHA,
  fillColorFor,
  hexToRgb,
  hiddenFiefFeatures,
  hiddenFiefSuzerainKey,
  LINE_COLOR,
  LINE_WIDTH_PX,
  powerFillDataForMode,
  type Rgba,
} from "./powers.ts";
import {
  buildLabelData,
  buildTopPoliticalLabelData,
  characterSetFrom,
  COLLISION_SIZE_SCALE,
  FIEF_LABEL_COLOR,
  filterPoliticalLabelsByGroup,
  filterPowerLabelsByFocus,
  filterPowerLabelsByZoom,
  type LabelDatum,
  labelTierOf,
  layoutOverviewLabelCollisions,
  OVERVIEW_TOP_LABEL_COLLISION_SIZE_SCALE,
  partitionFiefsBySuzerain,
  POLITICAL_LABEL_FONT_SETTINGS,
  POLITICAL_LABEL_HALO_COLOR,
  politicalDetailVisibleAt,
  type PoliticalDisplayLevel,
  politicalDisplayLevel,
  type PoliticalLabelGroup,
  politicalLabelStyleFor,
  politicalOverlayTier,
  powerLabelSizePx,
} from "./labels.ts";
import {
  ACTIVE_FILL_COLOR,
  isPowerActive,
  powerFillColor,
  powerLabelColor,
} from "./power_highlight.ts";
import {
  containingSuzerainKey,
  createSuzerainExtentCache,
  resolveSuzerainKey,
  type SuzerainExtentBands,
  type SuzerainOverrides,
} from "./suzerain_extent.ts";
import {
  BRITAIN_FIEF_LAYER_ID,
  CLIOPATRIA_FIEF_LAYER_ID,
  FRANCE_FIEF_LAYER_ID,
  HRE_LAYER_ID,
  ITALY_FIEF_LAYER_ID,
  SOVEREIGN_FIEF_LAYER_ID,
} from "./picking.ts";
import { type FiefDedupeTable, suppressedPowerNames } from "./fief_dedupe.ts";
import { memoizeLatest } from "./memo.ts";
import { labelLayerBaseProps } from "./feature_layers.ts";

/**
 * 勢力圏の外枠オーバーレイ（GeoJsonLayer）のレイヤー ID（TASK-30 / TASK-94）。
 * pickable: false のため PICKING_PRIORITY には含めない（picking 非関与）。
 * ID は "hre-extent" のまま据え置く（TASK-94 で対象を全勢力へ広げたが、
 * レイヤー順・overlaid 分配（layer_stack.ts）の既存の扱いを変えないため）。
 */
export const HRE_EXTENT_LAYER_ID = "hre-extent";

/** 後期 HRE の通常表示用外周。選択時の勢力圏強調とは独立し、picking しない。 */
export const HRE_REALM_OUTLINE_LAYER_ID = "hre-realm-outline";
export const HRE_REALM_OUTLINE_LINE_COLOR: [number, number, number, number] = [
  92,
  61,
  34,
  210,
];
export const HRE_REALM_OUTLINE_LINE_WIDTH_PX = 1.5;

/**
 * 勢力圏の外枠の色（TASK-30 AC #2）。臙脂系の深い赤で「帝国系」の記号を
 * 揃える（旧 HRE 領邦ラベル色と同系。#267 でラベル文字色としての臙脂は
 * 廃止されたが、外枠の記号色はこの値のまま据え置く）。
 * 外縁線は不透明、塗りはごく薄くして下の勢力塗り・領邦境界を隠さない。
 * TASK-94 で対象を全勢力へ広げた際も、この見た目は据え置く（AC #2）。
 */
export const HRE_EXTENT_LINE_COLOR: [number, number, number, number] = [
  140,
  30,
  30,
  255,
];
export const HRE_EXTENT_FILL_COLOR: [number, number, number, number] = [
  140,
  30,
  30,
  30,
];

/** 勢力圏の外枠の線の太さ（px）。通常の勢力境界（1px 白）より明確に太くする */
export const HRE_EXTENT_LINE_WIDTH_PX = 3;

/**
 * 諸侯領オーバーレイの内部境界インク（RGB、#267 AC4）。
 *
 * 色相は TASK-71 以来の藍紫（labels.ts FIEF_LABEL_COLOR と同値）を維持し、
 * 「藍紫の細線 = オーバーレイ由来の区画」という凡例を境界線側に残す
 * （#267 でラベル文字色は明色に統一され、この記号の担い手は境界線だけに
 * なった）。alpha・線幅は固定値（旧 FIEF_LINE_COLOR alpha 160 / 1.5px）を
 * やめ、階層 × 表示レベル別の internalBorderStyleFor が決める。
 */
export const FIEF_BORDER_INK: readonly [number, number, number] = [
  FIEF_LABEL_COLOR[0],
  FIEF_LABEL_COLOR[1],
  FIEF_LABEL_COLOR[2],
];

/**
 * 帝国領邦（HRE 系）の内部境界インク（RGB、#267 AC4）。base 勢力境界と
 * 同じ焦茶（powers.ts LINE_COLOR）の色相。旧実装は LINE_COLOR
 * （alpha 190）をそのまま stroke に使っており、上位勢力外周の normal 段
 * インク（alpha 0.62 ≈ 158）より**強い**内部境界になっていた。#267 では
 * alpha を internalBorderStyleFor に委ね、外周より必ず弱くする。
 */
export const HRE_BORDER_INK: readonly [number, number, number] = [
  LINE_COLOR[0],
  LINE_COLOR[1],
  LINE_COLOR[2],
];

/** 内部境界 1 段分の見た目（線幅 px・alpha 0..255） */
export interface InternalBorderStyle {
  readonly widthPx: number;
  readonly alpha: number;
}

/**
 * 内部境界の階層 × 表示レベル別スタイル（#267 AC3/AC4）。
 *
 * 上限の制約: 上位勢力外周のインク線（approximate_borders.ts TIER_STYLES.normal
 * alpha 0.62 ≈ 158、幅 1.0px × ZOOM_SCALE 0.9〜1.4）より、どの階層・どの
 * レベルでも細く・低 alpha でなければならない（AC4「内部区画の線が外周より
 * 強く見えない」。上下関係はユニットテストで固定）。
 *
 * - constituent（主要構成勢力）: mid 0.8px/110 → detail 1.0px/140。z5〜6 は
 *   構成勢力の「並び」を読む段なので区画線は気配に留め、z7〜8 で個別領邦を
 *   判別できる強さまで上げる（それでも外周の z7 実効幅 1.28px・alpha 158 の
 *   下に収まる）。
 * - sub（下位境界）: 各レベルで constituent よりさらに細く低 alpha
 *   （AC2 の 3 分類の最下段。現行データでは politicalOverlayTier が全て
 *   constituent へフォールバックするため描画には現れない）。
 */
export const INTERNAL_BORDER_STYLES: Record<
  "constituent" | "sub",
  Record<"mid" | "detail", InternalBorderStyle>
> = {
  constituent: {
    mid: { widthPx: 0.8, alpha: 110 },
    detail: { widthPx: 1.0, alpha: 140 },
  },
  sub: {
    mid: { widthPx: 0.6, alpha: 80 },
    detail: { widthPx: 0.8, alpha: 110 },
  },
};

/**
 * 内部境界のスタイルを階層 × 表示レベルから返す（純粋関数、#267 AC3/AC4）。
 * overview（z4）ではオーバーレイ自体が visible: false（#228 AC2）で内部境界は
 * 描かれないため、mid のスタイルへ倒す（deck.gl の props を常に妥当な値に
 * 保つための全域定義）。
 */
export function internalBorderStyleFor(
  tier: "constituent" | "sub",
  level: PoliticalDisplayLevel,
): InternalBorderStyle {
  return INTERNAL_BORDER_STYLES[tier][level === "detail" ? "detail" : "mid"];
}

/**
 * 内部境界の線色を決める（純粋関数、#267 AC2/AC4）。インク（色相 = 記号）は
 * レイヤー側が選び、alpha は feature の構造分類（politicalOverlayTier）と
 * 表示レベルで決まる。
 */
export function internalBorderLineColor(
  ink: readonly [number, number, number],
  properties: GeoJsonProperties,
  level: PoliticalDisplayLevel,
): Rgba {
  const style = internalBorderStyleFor(politicalOverlayTier(properties), level);
  return [ink[0], ink[1], ink[2], style.alpha];
}

/** 内部境界の線幅を決める（純粋関数、#267 AC2/AC4。色と同じ分類を共有） */
export function internalBorderLineWidth(
  properties: GeoJsonProperties,
  level: PoliticalDisplayLevel,
): number {
  return internalBorderStyleFor(politicalOverlayTier(properties), level)
    .widthPx;
}

/**
 * 概観表示（z4）用の政治ポリゴン塗り色（純粋関数、#228 AC2）。
 *
 * SUBJECTO / PARTOF を持つ従属勢力を**宗主の色**へ寄せ、同じ勢力圏
 * （アンジュー帝国・HRE など）が一まとまりの色として読めるようにする。
 * 宗主キーの解決は勢力圏の外枠（suzerain_extent.ts resolveSuzerainKey）と
 * 同じ規則（宗主補正 > SUBJECTO > NAME）で、「外枠が囲む範囲」と「同色に
 * 寄る範囲」が構造的に一致する。独立勢力は宗主キー = 自分の NAME なので
 * 従来どおり自分の色になる。
 *
 * フォールバック: 宗主キーが colors.json に無い・NAME 欠落の feature は
 * 従来色（fillColorFor。実測では NAME を持つ全 feature が colors.json に
 * ヒットするため、実質 NAME 欠落 = デフォルトグレーのみ）。
 *
 * 選択/ホバー強調（isPowerActive、キーは詳細表示と同じ colorKeyFor 単位）は
 * 宗主色より優先し、概観でも「いま指している勢力」のフィードバックを保つ。
 */
export function overviewPowerFillColor(
  props: GeoJsonProperties,
  colors: Record<string, string>,
  overrides: SuzerainOverrides,
  selected: string | null,
  hovered: string | null,
): Rgba {
  return suzerainKeyFillColor(
    props,
    colors,
    resolveSuzerainKey(props, overrides),
    selected,
    hovered,
  );
}

/**
 * 与えられた宗主キーの色で塗る（純粋関数、#228 / #382）。
 *
 * {@linkcode overviewPowerFillColor} の本体で、宗主キーの**求め方**だけを
 * 呼び出し側に委ねた形。概観表示（z4）は宣言された宗主（`resolveSuzerainKey`）
 * を、詳細表示で focus から外れた諸侯領（#382）は分類器が解いた宗主
 * （powers.ts `HIDDEN_FIEF_SUZERAIN_PROP`）を渡す。どちらも「上位勢力単位で
 * 一まとまりに見える」という同じ表現なので、色の決め方は 1 か所に保つ。
 *
 * 選択/ホバー強調は宗主色より優先し、キーが colors.json に無い場合は従来色
 * （fillColorFor）へフォールバックする。
 */
export function suzerainKeyFillColor(
  props: GeoJsonProperties,
  colors: Record<string, string>,
  suzerainKey: string | null,
  selected: string | null,
  hovered: string | null,
): Rgba {
  if (isPowerActive(colorKeyFor(props), selected, hovered)) {
    return ACTIVE_FILL_COLOR;
  }
  const hex = suzerainKey === null ? undefined : colors[suzerainKey];
  const rgb = hex === undefined ? null : hexToRgb(hex);
  if (rgb !== null) return [rgb[0], rgb[1], rgb[2], FILL_ALPHA];
  return fillColorFor(props, colors);
}

/**
 * 詳細表示（z5 以上）の政治ポリゴン塗り色（純粋関数、#382）。
 *
 * 通常の feature は従来どおり自分の色（{@linkcode powerFillColor}）。詳細表示
 * focus で描画から外れ、powers レイヤーが肩代わりして塗る諸侯領
 * （powers.ts {@linkcode hiddenFiefFeatures} が印を付けた feature）だけ、
 * **宗主の色**で塗る。focus 外は「上位勢力単位の連続した塗り」であるべき
 * （#293 AC3）で、その面だけ諸侯領固有の色が出ると focus の内外が読めなくなる。
 */
export function detailPowerFillColor(
  props: GeoJsonProperties,
  colors: Record<string, string>,
  selected: string | null,
  hovered: string | null,
): Rgba {
  const hiddenSuzerain = hiddenFiefSuzerainKey(props);
  if (hiddenSuzerain === null) {
    return powerFillColor(props, colors, selected, hovered);
  }
  return suzerainKeyFillColor(props, colors, hiddenSuzerain, selected, hovered);
}

/**
 * builder が読む main.ts 所有の状態のスナップショット。main.ts が
 * renderLayers のたびに現在値から組み立てて渡す（getter ではなく値で受ける
 * ことで、builder は入力が固定された純関数になる。feature_layers.ts の
 * {@linkcode FeatureLayerContext} と同型）。
 *
 * メモ化（参照同値）の前提: colors / nameJa / overrides / fiefDedupe は
 * 起動時ロードで 1 度だけ差し替わる参照、year は switchYear 成功時のみ変わる
 * 値、zoomStep は整数段の変化時のみ変わる値、extentKey と強調キー
 * （selectedPowerKey / hoveredPowerKey）は変化検知（applyExtentKey /
 * powerHighlight ストア）を通った値。この前提が TASK-50/136 の「hover
 * 連続移動で再計算しない」を成立させる。
 */
export interface PoliticalLayerContext {
  /** 現在の反映済み年代（抑制対象の解決・updateTriggers に使う） */
  year: number;
  /** colors.json（NAME / "NAME|SUBJECTO" → HEX のフラットマップ） */
  colors: Record<string, string>;
  /** name-ja.json（英語 NAME → 日本語名）。未登録名は英語のまま */
  nameJa: Record<string, string>;
  /** name-overrides.json（renames + 宗主補正）。外枠の宗主解決に使う */
  overrides: SuzerainOverrides;
  /** 諸侯領による base 勢力の被覆率表（TASK-78。ラベル抑制の入力） */
  fiefDedupe: FiefDedupeTable;
  /** ズーム別表示制御に使う現在の整数ズーム段（TASK-122） */
  zoomStep: number;
  /** ホバー/クリック中の勢力の宗主キー（TASK-94。null は外枠なし） */
  extentKey: string | null;
  /** クリックで選択中の強調キー（powerHighlight.selected()。TASK-90） */
  selectedPowerKey: string | null;
  /** ホバー中の強調キー（powerHighlight.hovered()。TASK-90） */
  hoveredPowerKey: string | null;
  /**
   * 政治ポリゴンの getFillColor 遷移時間（ms）。既定は年代切替のフェード
   * （400ms）で、強調の変化だけ main.ts の renderWithFillTransition が
   * 一時的に短い値へ差し替える（TASK-90。差し替えの所有は main.ts）。
   */
  fillTransitionMs: number;
  /**
   * 現在の MapLibre スタイルのレイヤー ID 列（main.ts currentStyleLayerIds
   * のスナップショット）。beforeId（underWaterBeforeId /
   * suzerainExtentBeforeId）の入力になる。スタイル未読込・差し替え中は
   * 空配列 = beforeId なしの従来描画順。
   */
  styleLayerIds: string[];
  /**
   * 反映済みの沿岸補完の帯（#330。coastal_fill_sync.ts extentBands()）。
   * 勢力圏の外枠の union へ合流させ、外縁を「実際に塗られる面」に一致させる。
   * 帯が未取得・帯を描かないスタイル（フォールバック）では null = 従来どおり
   * 元ポリゴンだけの外枠。
   */
  coastalBands: SuzerainExtentBands | null;
  /**
   * 詳細表示の focus（地図中央が属する上位勢力の宗主キー。#345
   * `detailFocusKeyAt` / `createDetailFocusTracker` が解決した値。#348）。
   *
   * 非 null のとき、領邦・諸侯領オーバーレイ 6 系統
   * （{@linkcode FOCUS_FILTERED_LAYER_IDS}）と勢力ラベルを **feature 単位** で
   * この宗主キーに属するものだけへ絞る。`null` / 未指定なら絞り込みは一切
   * 行わず、出力も参照同値も従来と完全に一致する（#348 AC6）。実値の注入は
   * main.ts `politicalLayerContext()` 側の後続タスク（#350）。
   */
  detailFocusKey?: string | null;
  /**
   * 現在年の base（europe_*）。focus の宗主分類（`containingSuzerainKey`。
   * SUBJECTO を持たない諸侯領はラベル地点を包含する base 勢力から宗主が
   * 決まる）に使う。未指定・null なら focus 絞り込みは行わない（年代データ
   * 未確定時に従来表示へ縮退する）。
   *
   * ラベル builder は base を引数でも受けるが、分類には**必ずこの
   * ctx.base を使う**。同じ参照を全経路で共有することで、宗主分類の
   * メモ化（`memoizeLatest`。キーは base と overrides の参照）が builder を
   * またいで 1 回で済む。
   */
  base?: FeatureCollection | null;
  /**
   * 現在年の領邦・諸侯領オーバーレイ 6 系統（#382）。focus で**描画から外れる**
   * feature を powers の塗りへ戻す（{@linkcode PoliticalLayerBuilders.powerFillData}
   * → powers.ts `hiddenFiefFeatures`）ための入力で、`buildPowerLayer` /
   * `buildLabelLayer` へ引数で渡すのと同じ参照を渡す。
   *
   * 省略・未指定なら「隠れる諸侯領は無い」扱いになり、塗りは従来どおり派生
   * base（`baseFill`）そのものになる。**参照を安定させること**（合成結果の
   * メモ化キーに入るため。main.ts は currentView のスロットをそのまま渡す）。
   */
  hre?: FeatureCollection | null;
  fiefs?: FeatureCollection | null;
  italyFiefs?: FeatureCollection | null;
  cliopatriaFiefs?: FeatureCollection | null;
  britainFiefs?: FeatureCollection | null;
  sovereignFiefs?: FeatureCollection | null;
}

/**
 * `detailFocusKey` で feature 単位に絞り込む領邦・諸侯領オーバーレイ 6 系統の
 * レイヤー ID（#348 AC1/AC2）。
 *
 * `powers`（POWER_LAYER_ID）は含まない: base の塗りデータの focus 対応は
 * 分割タスク 2/5（#347 の powers.ts）が持つ。ここで base まで絞ると focus 外が
 * 透明に抜ける（#293 AC3 が禁じる状態）。
 *
 * イタリア・Cliopatria は 1 枚のレイヤーに複数宗主の feature が同居するため、
 * レイヤー単位の on/off ではなく FeatureCollection を宗主キーで絞る（AC2）。
 */
export const FOCUS_FILTERED_LAYER_IDS: readonly string[] = [
  HRE_LAYER_ID,
  FRANCE_FIEF_LAYER_ID,
  ITALY_FIEF_LAYER_ID,
  CLIOPATRIA_FIEF_LAYER_ID,
  BRITAIN_FIEF_LAYER_ID,
  SOVEREIGN_FIEF_LAYER_ID,
];

/** オーバーレイ feature 1 件の宗主キーを返す分類器（year ごとに 1 インスタンス） */
export type SuzerainClassifier = (feature: Feature) => string | null;

/**
 * feature → 宗主キーの分類器を作る（#348 AC4）。
 *
 * `containingSuzerainKey` は SUBJECTO を持たない feature で base 全 feature の
 * 線形走査（polylabel + point-in-polygon）に落ちるため、focus を切り替える
 * たびに走らせてはいけない。結果を feature の参照でキャッシュし、同じ年代
 * （= 同じ base / overrides 参照）の間は 1 feature につき 1 回だけ計算する。
 *
 * WeakMap を使うのは、年代切替でこの分類器ごと捨てられたときに古い feature を
 * 掴み続けないため。
 */
function createSuzerainClassifier(
  base: FeatureCollection,
  overrides: SuzerainOverrides,
): SuzerainClassifier {
  // 値は string | null しか入らないため、undefined = 未計算で判別できる
  const cache = new WeakMap<Feature, string | null>();
  return (feature: Feature): string | null => {
    const hit = cache.get(feature);
    if (hit !== undefined) return hit;
    const key = containingSuzerainKey(feature, base, overrides);
    cache.set(feature, key);
    return key;
  };
}

/**
 * FeatureCollection を focus の宗主キーに属する feature だけへ絞る（純粋関数、
 * #348 AC1/AC2）。
 *
 * 該当が 0 件でも**空の FeatureCollection を返す**（レイヤーを消したり
 * `visible: false` にしたりしない）。レイヤー ID・layers 配列内の位置・
 * `visible` の意味を保つことで、picking 優先順の検証
 * （picking.ts `layerOrderMatchesPickingPriority`）と deck.gl の差分更新が
 * 壊れない（#348 AC5）。
 *
 * 全 feature が focus 内なら**入力をそのまま同一参照で返す**（無駄な再アップ
 * ロードを避ける）。`metadata`（TASK-109 の出典）はスプレッドで引き継ぐ。
 */
function focusedFeatureCollection(
  data: FeatureCollection,
  focusKey: string,
  classify: SuzerainClassifier,
): FeatureCollection {
  const features = data.features.filter((f) => classify(f) === focusKey);
  if (features.length === data.features.length) return data;
  return { ...data, features };
}

/**
 * 勢力ラベル datum → 宗主キーの引き当てを作る（#348 AC3）。
 *
 * datum 自身は宗主キーを持たない（`buildLabelData` は base / オーバーレイの
 * 区別なく同じ形の datum を作る）ため、`LabelDatum.key`（= powers.ts
 * `colorKeyFor`。塗り・強調と同一のキー）を橋渡しに使う。datum の key は
 * 生成元 feature の properties から作られるので、同じ properties を持つ
 * feature を走査すれば一意に引き当てられる。
 *
 * - base（europe_*）は宣言された宗主（`resolveSuzerainKey`）で決まる。焦点の
 *   解決（#345 `detailFocusKeyAt`）と同じ規則なので、「focus 内かどうか」の
 *   判定が中央の判定とずれない。
 * - オーバーレイ 6 系統は `classify`（`containingSuzerainKey` のキャッシュ付き）
 *   で決まる。同じ分類器をオーバーレイの絞り込みと共有するため、focus 切替でも
 *   1 feature につき 1 回しか計算されない（AC4）。
 *
 * 同じ色キーが複数 feature に現れた場合は**先勝ち**（base 優先）。実データでは
 * base とオーバーレイで NAME|SUBJECTO が衝突する組み合わせは無く、衝突しても
 * 宣言された宗主が同じなら同じ答えになる。
 */
function createLabelSuzerainLookup(
  base: FeatureCollection,
  overlays: readonly FeatureCollection[],
  overrides: SuzerainOverrides,
  classify: SuzerainClassifier,
): (d: LabelDatum) => string | null {
  const byColorKey = new Map<string, string>();
  const put = (props: GeoJsonProperties, key: string | null): void => {
    if (key === null) return;
    const colorKey = colorKeyFor(props);
    if (colorKey === null || byColorKey.has(colorKey)) return;
    byColorKey.set(colorKey, key);
  };
  for (const f of base.features) {
    put(f.properties, resolveSuzerainKey(f.properties, overrides));
  }
  for (const fc of overlays) {
    for (const f of fc.features) put(f.properties, classify(f));
  }
  return (d: LabelDatum): string | null =>
    d.key === undefined ? null : byColorKey.get(d.key) ?? null;
}

/**
 * 政治レイヤーの builder 群とメモ化インスタンスを生成する（TASK-148）。
 *
 * main.ts はこれを起動時に 1 度だけ呼ぶ。返り値の builder は
 * {@linkcode PoliticalLayerContext} を受ける純関数で、メモ化キャッシュ
 * （closure 内）だけがファクトリ呼び出し間で持続する。メモ化インスタンス
 * （memoized*）も返すのは、debug_hooks.ts へ**同一インスタンス**を注入する
 * ため（デバッグフックの呼び出しがフォントアトラス再生成や polylabel
 * 再計算を誘発しない。TASK-50/136 の参照同値契約）。
 */
export function createPoliticalLayerBuilders() {
  /**
   * 宗主キーごとの外枠（union）のメモ化キャッシュ（TASK-94）。base の参照が
   * 変われば内部で捨てられるため、年代切替をまたいで古い形が残ることはない。
   */
  const suzerainExtent = createSuzerainExtentCache();

  /**
   * 年代ごとの領邦 → 宗主キー分類器（#348 AC4）。キーは base と overrides の
   * 参照なので、年代が変わらない限り同じインスタンス（= 同じキャッシュ）が
   * 返り、focus を切り替えても `containingSuzerainKey` は走らない。
   * オーバーレイの絞り込みとラベルの絞り込みがこの 1 インスタンスを共有する。
   */
  const memoizedSuzerainClassifier = memoizeLatest(createSuzerainClassifier);

  /**
   * focus で絞り込んだオーバーレイ data のメモ化（レイヤーごとに 1 スロット）。
   *
   * 6 系統が同じ renderLayers で 1 回ずつ呼ぶため、単一の memoizeLatest では
   * キャッシュが順に落ちる（#333 の memoizedLabelsByGroup と同じ理由）。
   * レイヤーごとに分けることで、ホバー等の再構築で data の参照が変わらず
   * deck.gl の差分更新に載り続ける。
   */
  const memoizedFocusedOverlayData: Record<
    string,
    (
      data: FeatureCollection,
      focusKey: string,
      classify: SuzerainClassifier,
    ) => FeatureCollection
  > = {};
  for (const id of FOCUS_FILTERED_LAYER_IDS) {
    memoizedFocusedOverlayData[id] = memoizeLatest(focusedFeatureCollection);
  }

  /**
   * オーバーレイ data を focus で絞る（対象外レイヤー・focus 無し・base 未確定は
   * 入力をそのまま返す）。判定を 1 か所に閉じ込め、`buildPowerLayer` の
   * シグネチャと呼び出し側（deck_app.ts）を無変更に保つ。
   */
  function focusedLayerData(
    ctx: PoliticalLayerContext,
    id: string,
    data: FeatureCollection,
  ): FeatureCollection {
    const focusKey = ctx.detailFocusKey ?? null;
    const base = ctx.base ?? null;
    if (focusKey === null || base === null) return data;
    const memoized = memoizedFocusedOverlayData[id];
    // powers（base の塗り。#347 の担当）など対象外レイヤーは絞らない
    if (memoized === undefined) return data;
    return memoized(
      data,
      focusKey,
      memoizedSuzerainClassifier(base, ctx.overrides),
    );
  }

  /**
   * powers（base）の塗りデータのメモ化（#350 / #382）。
   *
   * `powerFillDataForMode` は隠れた諸侯領がある間 **毎回新しい
   * FeatureCollection** を返す（派生 base に feature を足した合成なので参照を
   * 保てない）。renderLayers はホバー・選択・ズーム段の変化でも全レイヤーを
   * 作り直すため、包まないと mousemove のたびに deck.gl が塗りジオメトリを
   * 再アップロードする。
   *
   * キーは base / baseFill / 表示モード / 隠れた諸侯領の 4 つ。最後の 1 つは
   * {@linkcode memoizedHiddenFiefs} が参照を安定させるので、focus が変わらない
   * 限り同じ配列が渡り続けてキャッシュに当たる。focus が無い経路では
   * `powerFillDataForMode` 自身が入力を同一参照で返すので、メモ化の有無に
   * 関わらず従来と同じ参照が渡る。
   */
  const memoizedPowerFillData = memoizeLatest(powerFillDataForMode);

  /** 隠れた諸侯領が無いときに返す不変の空配列（メモ化キーの参照を安定させる） */
  const NO_HIDDEN_FIEFS: readonly Feature[] = [];

  /**
   * focus で描画から外れた諸侯領のメモ化（#382）。オーバーレイ 6 系統は配列に
   * まとめず個別の引数で受ける（配列を組み立てると毎回新しい参照になり
   * メモ化が効かない。`memoizedLabelSuzerainLookup` と同じ理由）。
   *
   * 分類器（`memoizedSuzerainClassifier`）はオーバーレイの絞り込みと共有する
   * ため、focus を切り替えても `containingSuzerainKey` の線形走査は
   * 1 feature につき 1 回しか走らない（#348 AC4 の非退行）。
   */
  const memoizedHiddenFiefs = memoizeLatest((
    focusKey: string,
    classify: SuzerainClassifier,
    hre: FeatureCollection,
    fiefs: FeatureCollection,
    italyFiefs: FeatureCollection,
    cliopatriaFiefs: FeatureCollection,
    britainFiefs: FeatureCollection,
    sovereignFiefs: FeatureCollection,
  ): readonly Feature[] =>
    hiddenFiefFeatures(
      [hre, fiefs, italyFiefs, cliopatriaFiefs, britainFiefs, sovereignFiefs],
      focusKey,
      classify,
    )
  );

  /**
   * 現在の context で「描画から外れる諸侯領」を求める（#382）。
   *
   * focus 無し・base 未確定・概観表示（z4 = オーバーレイを全て隠す段）では
   * 隠れる諸侯領という概念自体が無いので、不変の空配列を返す。
   */
  function hiddenFiefsFor(
    ctx: PoliticalLayerContext,
    detail: boolean,
  ): readonly Feature[] {
    const focusKey = ctx.detailFocusKey ?? null;
    const focusBase = ctx.base ?? null;
    if (!detail || focusKey === null || focusBase === null) {
      return NO_HIDDEN_FIEFS;
    }
    return memoizedHiddenFiefs(
      focusKey,
      memoizedSuzerainClassifier(focusBase, ctx.overrides),
      ctx.hre ?? EMPTY_FEATURE_COLLECTION,
      ctx.fiefs ?? EMPTY_FEATURE_COLLECTION,
      ctx.italyFiefs ?? EMPTY_FEATURE_COLLECTION,
      ctx.cliopatriaFiefs ?? EMPTY_FEATURE_COLLECTION,
      ctx.britainFiefs ?? EMPTY_FEATURE_COLLECTION,
      ctx.sovereignFiefs ?? EMPTY_FEATURE_COLLECTION,
    );
  }

  /**
   * powers レイヤーが実際に塗る FeatureCollection を返す（#228 / #350 / #382）。
   *
   * - 概観（z4 = `detail` が false）: 常に穴のない素の base。focus は詳細表示の
   *   概念でしかないため、ここで無視される（#350 AC8）。
   * - 詳細（z5 以上）で focus 無し: 従来どおり派生 base（baseFill）。
   * - 詳細で focus 有り: 派生 base に「focus で描かれなくなった諸侯領」を足す
   *   （#382）。差し引き（`europe_flat_*`）が引いた単位そのままを戻すので、
   *   塗りは focus に依らず base をちょうど 1 度だけ覆う。
   *
   * 塗り（deck_app.ts）・picking の出典解決（pick_handlers.ts）・デバッグフック
   * （debug_hooks.ts）は「同じ判定・同じ合成」を通す契約なので、判定を
   * builder 側の 1 か所に閉じ込めて main.ts / deck_app.ts からは引数を渡すだけに
   * する。
   */
  function powerFillData(
    ctx: PoliticalLayerContext,
    base: FeatureCollection,
    baseFill: FeatureCollection,
    detail: boolean,
  ): FeatureCollection {
    return memoizedPowerFillData(
      base,
      baseFill,
      detail,
      hiddenFiefsFor(ctx, detail),
    );
  }

  /**
   * 勢力ラベル datum → 宗主キーの引き当て（年代ごとにメモ化）。分類器を
   * オーバーレイ側と共有するため、focus 切替では 1 度も再計算されない。
   * 6 系統の FeatureCollection は配列にまとめず個別の引数で受ける
   * （配列を組み立てると毎回新しい参照になりメモ化が効かない）。
   */
  const memoizedLabelSuzerainLookup = memoizeLatest((
    base: FeatureCollection,
    overrides: SuzerainOverrides,
    classify: SuzerainClassifier,
    hre: FeatureCollection,
    fiefs: FeatureCollection,
    italyFiefs: FeatureCollection,
    cliopatriaFiefs: FeatureCollection,
    britainFiefs: FeatureCollection,
    sovereignFiefs: FeatureCollection,
  ) =>
    createLabelSuzerainLookup(
      base,
      [hre, fiefs, italyFiefs, cliopatriaFiefs, britainFiefs, sovereignFiefs],
      overrides,
      classify,
    )
  );

  /**
   * focus による勢力ラベルの絞り込み（#348 AC3）。ズーム段の絞り込みの**前**に
   * 置く（suppressed な base ラベルの復活がズーム側で潰されないため）。
   * `memoizedPowerLabelData` の外に置くことで、characterSet は従来どおり
   * **絞り込み前**の全 datum から作られる（TASK-122 AC #7）。
   */
  const memoizedFocusedPowerLabels = memoizeLatest(filterPowerLabelsByFocus);

  /**
   * 指定年代の FeatureCollection から GeoJsonLayer を 1 枚生成する。
   * data 以外のプロパティは全年代で不変。updateTriggers に year を渡し、
   * 色関数の再評価を促す（colors 読み込み前後でも齟齬が出ないようにする）。
   * powers / hre-powers / france-fiefs の 3 枚で共用し、id と境界線の見た目
   * （lineColor / lineWidth）以外は同一の挙動にする（TASK-19、TASK-71）。
   *
   * TASK-77: 3 枚とも beforeId（underWaterBeforeId）でベースマップの水面
   * ポリゴンの下へ差し込み、海岸線の解像度差による海上へのはみ出しを水面に
   * 覆わせて隠す。水面より上に残す河川・都市・ラベルはこの builder を通らない
   * ため、対象は構造的に政治ポリゴンの 3 枚だけになる。
   */
  function buildPowerLayer(
    ctx: PoliticalLayerContext,
    id: string,
    data: FeatureCollection,
    // TASK-110: 定数だけでなく feature 単位のアクセサも受ける。Cliopatria 由来の
    // レイヤーは仏諸侯領と帝国領邦を同居させるため、境界線の記号（藍紫 = 諸侯領の
    // 区画 / 焦茶 = base と同じ線）を feature ごとに選ぶ必要がある。
    // #267 AC4: 線幅もアクセサを受ける（内部境界は feature の構造分類
    // internalBorderLineWidth で幅が変わる）。
    lineColor: Rgba | ((feature: Feature) => Rgba) = LINE_COLOR,
    lineWidth: number | ((feature: Feature) => number) = LINE_WIDTH_PX,
    stroked: boolean = true,
    // #228 AC2/AC6: 概観表示（z4）では main.ts が領邦オーバーレイ 6 枚へ false を
    // 渡す。layers 配列からは抜かず（レイヤー ID・順序検証・差分更新を保つ）、
    // visible: false で描画・picking の両パスから外す（deck.gl 9.3.7 の
    // layer-manager / deck-picker が visible でフィルタすることを確認済み）。
    // pickable は据え置きなので、詳細表示へ戻れば従来どおり pick される。
    visible: boolean = true,
  ): GeoJsonLayer {
    const { colors, overrides, selectedPowerKey, hoveredPowerKey } = ctx;
    // #228 AC1: 表示モードは共有の純粋関数で決める（ラベル・picking と同一判定）
    const detail = politicalDetailVisibleAt(ctx.zoomStep);
    // #267 AC1: 内部境界のスタイル（deck_app.ts が lineColor / lineWidth の
    // アクセサに織り込む）はレベル依存のため、trigger 用にレベルも取る
    const level = politicalDisplayLevel(ctx.zoomStep);
    return new GeoJsonLayer({
      id,
      // #348 AC1/AC2/AC5: 領邦・諸侯領オーバーレイ 6 系統は detailFocusKey で
      // feature 単位に絞る。focus 外は空 FC になるだけで、レイヤー ID・配列内の
      // 位置・visible の意味は変わらない（focus 無しなら同一参照がそのまま渡る）。
      data: focusedLayerData(ctx, id, data),
      visible,
      // TASK-77: 水面ポリゴンの直下へ差し込む（interleaved 前提。水面レイヤーが
      // 無いスタイルでは undefined = 従来どおり最前面グループへフォールバック）
      beforeId: underWaterBeforeId(id, ctx.styleLayerIds),
      // AC #3: ホバー/クリックを有効化（ツールチップ UI は TASK-7）
      pickable: true,
      // TASK-78: powers は諸侯領オーバーレイ対象年のみ stroke を止め、境界線を
      // base-outlines 層（諸侯領の内側を除いた輪郭）に委ねる。塗り・picking は不変。
      stroked,
      filled: true,
      // AC #2: 塗り色は colors.json 参照・opacity 0.5 相当（alpha はカラーに内包）
      // TASK-90: ホバー/クリック中の勢力キー（飛び地含む全 feature）だけは
      // アクティブ色へ差し替える（判定は power_highlight.ts の純粋関数）
      // #228 AC2: 概観表示では従属勢力を宗主の色へ寄せる（overviewPowerFillColor。
      // 強調は詳細表示と同じキー・同じアクティブ色で維持される）
      // #382: 詳細表示でも、focus で描画から外れて powers が肩代わりする諸侯領
      // だけは宗主色で塗る（detailPowerFillColor）。それ以外は従来どおり
      // 自分の色。
      getFillColor: (f: Feature) =>
        detail
          ? detailPowerFillColor(
            f.properties,
            colors,
            selectedPowerKey,
            hoveredPowerKey,
          )
          : overviewPowerFillColor(
            f.properties,
            colors,
            overrides,
            selectedPowerKey,
            hoveredPowerKey,
          ),
      // AC #2: 白系の境界線（TASK-71: フランス諸侯領のみ藍紫の少し太い線）
      getLineColor: lineColor,
      lineWidthUnits: "pixels",
      getLineWidth: lineWidth,
      // 塗りの alpha はカラー側で表現するため、レイヤー opacity は等倍にする
      opacity: 1,
      // TASK-90: 強調キー（選択・ホバー）も accessor の入力なので trigger に足す。
      // 足さないと deck.gl が getFillColor を再評価せず、色が変わらない。
      // #228: 表示モード（detail）も accessor の入力なので trigger に足す。
      // z4↔z5 の切替で getFillColor が再評価され、宗主色寄せ⇄固有色が
      // フェード遷移（transitions.getFillColor）付きで切り替わる。
      // #267 AC1/AC4: lineColor / lineWidth アクセサ（internalBorderLine*）は
      // 表示レベルを閉じ込めた新しい関数が毎回渡るため、レベルを trigger に
      // 載せて z5〜6 ↔ z7〜8 の切替でだけ再評価させる（連続 zoom 中の
      // 再評価はしない）。
      // #382: focus が変わると「宗主色で塗る feature」の集合が変わるため、
      // focus も getFillColor の入力として trigger に足す。
      updateTriggers: {
        getFillColor: [
          ctx.year,
          selectedPowerKey,
          hoveredPowerKey,
          detail,
          ctx.detailFocusKey ?? null,
        ],
        getLineColor: [level],
        getLineWidth: [level],
      },
      // AC #5: 年代切替時に塗り色を数百 ms かけて補間し、ポリゴンをフェードさせる。
      // 同一 layer id を保つため deck.gl が差分更新し、getFillColor の遷移が発火する。
      // TASK-90: 同じ accessor に強調の色変化も乗るため、遷移時間は再構築の要因で
      // 切り替える（年代切替 400ms / 強調 HIGHLIGHT_FILL_TRANSITION_MS）。年代
      // フェードの 400ms をホバーへ流用すると色の追従が鈍く見える。
      transitions: { getFillColor: { duration: ctx.fillTransitionMs } },
      // ホバー/クリックの表示処理は Deck レベルの handlePickHover / handlePickClick
      // に集約する（TASK-24。per-layer に分けると rivers との発火順レースになる）
    });
  }

  /**
   * 勢力圏の外枠オーバーレイ（GeoJsonLayer）を生成する（TASK-30 AC #2〜#4 /
   * TASK-94）。データは base（europe_*）から宗主キーで集めた feature の union
   * （suzerain_extent.ts）で、領邦オーバーレイの有無に依らず勢力圏全体の輪郭が
   * 取れる。太い臙脂の外縁線 + ごく薄い塗りで「どこからどこまでが 1 つの勢力圏か」
   * を一目で示す。pickable: false のため picking の優先順位（PICKING_PRIORITY）・
   * ツールチップ・パネルには一切関与しない（AC #5）。表示の on/off は visible で
   * 切り替え、レイヤー ID を保って deck.gl の差分更新に任せる。
   *
   * #330: union の入力に沿岸補完の帯（ctx.coastalBands）を足し、beforeId で
   * 海洋 water の直下へ差し込む。前者は「緑青のアクティブ領域が臙脂線の外へ
   * 広がる」乖離を、後者は「海へはみ出した臙脂線だけが海上に残る」乖離を
   * 消す（どちらか片方だけでは沿岸の乖離は解消しない）。
   *
   * #332: union の入力に帝国全域ジオメトリ（hreRealm。data/hre_realm_<year>）も
   * 足す。base が勢力圏を 1 枚のポリゴンで塗らなくなった後期 HRE
   * （1715 / 1783 / 1800）でも、帝国の構成領域全体が 1 つの外枠として読める。
   * 非対象年は空 FC なので、外枠は従来どおり base（+ 帯）だけで決まる。
   */
  function buildSuzerainExtentLayer(
    ctx: PoliticalLayerContext,
    base: FeatureCollection,
    // 帝国全域を持たない年代（1700 以前・1815 以降）は空 FC が渡る。null は
    // 「渡されなかった」で、どちらも従来どおり base（+ 帯）だけの外枠になる
    hreRealm: FeatureCollection | null = null,
  ): GeoJsonLayer {
    return new GeoJsonLayer({
      id: HRE_EXTENT_LAYER_ID,
      data: suzerainExtent(
        base,
        ctx.extentKey,
        ctx.overrides,
        ctx.coastalBands,
        hreRealm,
      ),
      visible: ctx.extentKey !== null,
      beforeId: suzerainExtentBeforeId(ctx.styleLayerIds),
      pickable: false,
      stroked: true,
      filled: true,
      getFillColor: HRE_EXTENT_FILL_COLOR,
      getLineColor: HRE_EXTENT_LINE_COLOR,
      lineWidthUnits: "pixels",
      getLineWidth: HRE_EXTENT_LINE_WIDTH_PX,
      opacity: 1,
      updateTriggers: { getFillColor: [ctx.year], getLineColor: [ctx.year] },
    });
  }

  /**
   * `hre_realm_*` を通常時の帝国外周として描く。面は塗らず、領邦の塗りと
   * 内部境界をそのまま見せる。空 FC（1815 年以降）なら非表示になる。
   */
  function buildHreRealmOutlineLayer(
    ctx: PoliticalLayerContext,
    hreRealm: FeatureCollection,
  ): GeoJsonLayer {
    return new GeoJsonLayer({
      id: HRE_REALM_OUTLINE_LAYER_ID,
      data: hreRealm,
      visible: hreRealm.features.length > 0,
      beforeId: suzerainExtentBeforeId(ctx.styleLayerIds),
      pickable: false,
      stroked: true,
      filled: false,
      getLineColor: HRE_REALM_OUTLINE_LINE_COLOR,
      lineWidthUnits: "pixels",
      getLineWidth: HRE_REALM_OUTLINE_LINE_WIDTH_PX,
      opacity: 1,
      updateTriggers: { getLineColor: [ctx.year] },
    });
  }

  /**
   * 勢力名ラベルのデータ + characterSet をメモ化する（TASK-50）。
   * 直近実測 ~4.3ms/回の主因だった buildLabelData（全 base+hre feature への
   * polylabel）を、year・base・hre・nameJa の参照同値でキャッシュする。
   * applyRiverHover / applyRiverSelection / applyExtentKey は currentView
   * （base/hre）を書き換えずに renderLayers() を呼ぶだけなので、同じ引数の
   * 参照が渡り続けてキャッシュヒットし polylabel は走らない。switchYear
   * 経由で currentView が新しい base/hre に置き換わったとき（年代切替・
   * データ再ロード）だけ、参照が変わって正しく再計算される。
   */
  const memoizedPowerLabelData = memoizeLatest(
    (
      // year は抑制対象の解決（suppressedPowerNames）に使い、同時にメモ化キーの
      // 一部にもなる（base/hre/fiefs と揃えて明示的に年代依存であることを示す）
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
      hreRealm: FeatureCollection = EMPTY_FEATURE_COLLECTION,
    ) => {
      // TASK-23: ラベルは name-ja.json で日本語化する（未登録 NAME は英語のまま）。
      // TASK-30: kind（base/hre）を付与し、HRE 領邦ラベルだけ帝国色で塗り分ける。
      // TASK-71: フランス諸侯領は kind=fief で藍紫。オーバーレイ非対象年では
      // fiefs が空 FC なのでラベルも 0 件になる（二重ラベルにならない）。
      // TASK-78 AC #1: 諸侯領にほぼ完全内包される base 勢力（1000〜1300 の
      // Britany）は、同じ土地の諸侯領ラベル（ブルターニュ公領）と二重表示に
      // なるため base 側のラベルだけ落とす。抑制対象が無い年（1400 以降や
      // 対応表の取得失敗時）は同一参照が返り、polylabel のメモ化も効き続ける。
      // TASK-122: 抑制対象を FeatureCollection から落とすのではなく datum に
      // suppressed の印だけ付ける。諸侯領ラベルを出していないズーム段では抑制を
      // 解除しないとその土地のラベルが 1 つも無くなる（AC #4）ため、実際に出すか
      // どうかの判断は filterPowerLabelsByZoom（ズーム段依存）へ移した。datum を
      // 常に作っておくことで characterSet も絞り込み前の全テキストから作れる。
      const suppressed = suppressedPowerNames(dedupe, year);
      const cliopatriaLabelGroups = partitionFiefsBySuzerain(cliopatriaFiefs);
      const data = [
        ...buildTopPoliticalLabelData(base, hreRealm, ja, suppressed),
        ...buildLabelData(hre, ja, "hre"),
        ...buildLabelData(fiefs, ja, "fief"),
        // TASK-96: 伊諸侯領も kind=fief（藍紫）。base 側の教皇領・帝国との
        // 二重ラベルは fief-dedupe.json の被覆率が抑制する（1100 年以降の
        // Corsica は被覆率 0.9983 で抑制側に入る）。
        ...buildLabelData(italyFiefs, ja, "fief"),
        // TASK-110: Cliopatria 由来は 1 枚のレイヤーに仏諸侯領と帝国領邦が同居
        // するため、kind をレイヤー一律ではなく宗主で決める（labels.ts
        // partitionFiefsBySuzerain）。こうしないと 1400/1492 年に Cliopatria 由来の
        // バイエルンだけ藍紫・隣の OHM 由来領邦は臙脂、という凡例の破れが出る。
        ...buildLabelData(cliopatriaLabelGroups.hre, ja, "hre"),
        ...buildLabelData(cliopatriaLabelGroups.fief, ja, "fief"),
        // #172: ブリテン諸島の政体も kind=fief（藍紫）。「base が描き分けない
        // 政体をオーバーレイ由来の区画として重ねている」ことをラベル色で
        // 開示する（仏・伊諸侯領と同じ記号）。base 側の Celtic kingdoms /
        // England and Ireland との二重ラベルは fief-dedupe.json の被覆率が
        // 抑制を判断する（部分被覆の年は両方のラベルが出るのが正しい）。
        ...buildLabelData(britainFiefs, ja, "fief"),
        // #189: 主権政体オーバーレイも kind=fief（藍紫）。「base が描き分けない
        // 政体をオーバーレイ由来の区画として重ねている」ことをラベル色で
        // 開示する（既存 5 系統と同じ記号）。base 側（Ottoman Empire /
        // Russian Empire 等）との二重ラベルは fief-dedupe.json の被覆率が
        // 抑制を判断する（部分被覆の年は両方のラベルが出るのが正しい）。
        ...buildLabelData(sovereignFiefs, ja, "fief"),
      ];
      // TASK-122 AC #7: characterSet はズームで絞り込む**前**の全 datum から
      // 作る。表示中の datum から作ると、ズームインで諸侯領ラベルが増えた瞬間に
      // 未収録グリフ（ü・日本語）が豆腐になるか、フォントアトラスが作り直される。
      return { data, characterSet: characterSetFrom(data.map((d) => d.text)) };
    },
  );

  /**
   * 現在のズーム段で表示する勢力ラベルだけに絞る（TASK-122）。
   * memoizedPowerLabelData の安定参照 + zoomStep をキーにするので、ホバー/
   * 選択のたびに走る renderLayers() では再計算されない（山脈の
   * memoizedMountainHitData と同型）。zoomStep をこちら側のキーに置くことで、
   * 段が変わっても polylabel（memoizedPowerLabelData）は再計算されない。
   *
   * #348: focus が有効な間、builder が渡すのは focus 絞り込み済みの配列
   * （memoizedFocusedPowerLabels の結果）で、debug_hooks.ts の
   * `__getPowerLabelDebug` が渡す絞り込み前の配列とは参照が異なる。
   * フックを呼ぶとこの単一スロットが一時的に落ちるが、再計算されるのは
   * O(n) の配列フィルタだけで、polylabel・characterSet・宗主分類
   * （memoizedPowerLabelData / memoizedSuzerainClassifier）の共有キャッシュは
   * 従来どおり効き続ける。focus が null の間は両者が同一参照なので、
   * 現状（#350 前）の挙動は完全に据え置き。
   */
  const memoizedVisiblePowerLabels = memoizeLatest(
    (
      data: readonly LabelDatum[],
      zoomStep: number,
      suzerainOf?: (datum: LabelDatum) => string | null,
    ) => filterPowerLabelsByZoom(data, zoomStep, suzerainOf),
  );

  /** #407: z4 の国名候補へ衝突前の最小 pixel offset を決定的に付ける。 */
  const memoizedOverviewLabelLayout = memoizeLatest(
    layoutOverviewLabelCollisions,
  );

  /**
   * 表示対象のラベルを描画グループ（#333 AC3）で振り分ける。
   *
   * top / lower の 2 レイヤーが同じ renderLayers で 1 回ずつ呼ぶため、
   * memoizeLatest（直近 1 件）ではキャッシュが交互に落ちる。グループごとに
   * 別のメモ化インスタンスを持たせて、どちらも参照同値を保つ（ホバー移動の
   * たびに配列が作り直されて deck.gl の属性再計算が走るのを防ぐ）。
   */
  const memoizedLabelsByGroup: Record<
    PoliticalLabelGroup,
    (data: readonly LabelDatum[], group: PoliticalLabelGroup) => LabelDatum[]
  > = {
    top: memoizeLatest(filterPoliticalLabelsByGroup),
    lower: memoizeLatest(filterPoliticalLabelsByGroup),
  };

  /**
   * 勢力名ラベルの TextLayer を 1 グループ分生成する（TASK-20、#333 AC3 で
   * 階層別の 2 層へ分割）。
   *
   * base（europe_*）と HRE 領邦オーバーレイ（hre_*）双方のラベルを
   * CollisionFilterExtension で間引きながら描く。面積由来の priority
   * （labels.ts）により大勢力を優先表示し、小勢力はズームインで空きができ次第
   * 表示される。pickable は false（ラベル自体はホバー対象にせず、下のポリゴンの
   * picking を妨げない）。年代切替では同一 ID のまま data を差し替えるのみ。
   *
   * ## #333: なぜ group ごとに 1 枚ずつなのか
   *
   * `outlineWidth` / `backgroundPadding` / `backgroundBorderRadius` は deck.gl
   * TextLayer の**レイヤー単位 props**（accessor 化できない）なので、上位国名
   * （16〜18px）と構成勢力・下位（12〜14px）に別の値を与えるにはレイヤーを
   * 分けるしかない。1 つの datum は
   * {@linkcode filterPoliticalLabelsByGroup} で必ずどちらか一方に振り分けられ、
   * 両層に同じアンカーの datum が並ぶことはない（#322 が棄却した二重
   * TextLayer との決定的な違い。自己衝突も字送りのずれも起きない）。
   *
   * ## #333 AC8: 描画要素の同期
   *
   * 描画要素は「文字（characters サブレイヤー）」「濃色外縁（同サブレイヤーの
   * SDF halo）」「下支えプレート（background サブレイヤー）」の 3 つだが、
   * これらは**1 枚の TextLayer が内部で生成するサブレイヤー**であり、data /
   * getPosition / getSize / getPixelOffset / extensions（衝突）/
   * getCollisionPriority を deck.gl 側で共有する（@deck.gl/layers
   * text-layer.ts renderLayers）。したがって「文字だけ・外縁だけ・下支えだけが
   * 残る」状態は構造的に作れない。
   */
  function buildLabelLayer(
    ctx: PoliticalLayerContext,
    base: FeatureCollection,
    hre: FeatureCollection,
    fiefs: FeatureCollection,
    italyFiefs: FeatureCollection,
    cliopatriaFiefs: FeatureCollection,
    britainFiefs: FeatureCollection,
    sovereignFiefs: FeatureCollection,
    group: PoliticalLabelGroup,
    hreRealm: FeatureCollection = EMPTY_FEATURE_COLLECTION,
  ): TextLayer<LabelDatum, CollisionFilterExtensionProps<LabelDatum>> {
    const { year, zoomStep, selectedPowerKey, hoveredPowerKey } = ctx;
    // #267 AC1: 表示レベルはサイズ accessor の入力（塗り・境界・picking と
    // 同じ politicalDisplayLevel を共有する）
    const level = politicalDisplayLevel(zoomStep);
    // #333 AC2/AC3: 濃色外縁の幅・下支えの余白/角丸は階層別（labels.ts）
    const style = politicalLabelStyleFor(group);
    // 衝突制御（共有空間・priority）は従来どおり全ラベル層で共通。
    // 後期 HRE 以外は従来の 10 引数呼び出しを保つ。memoizeLatest は引数列を
    // キャッシュキーにするため、空 realm を明示的な第 11 引数にすると既存の
    // debug hook / テストによる直接呼び出しとキャッシュを共有できなくなる。
    const labelSource = hreRealm.features.length === 0
      ? memoizedPowerLabelData(
        year,
        base,
        hre,
        fiefs,
        italyFiefs,
        cliopatriaFiefs,
        britainFiefs,
        sovereignFiefs,
        ctx.nameJa,
        ctx.fiefDedupe,
      )
      : memoizedPowerLabelData(
        year,
        base,
        hre,
        fiefs,
        italyFiefs,
        cliopatriaFiefs,
        britainFiefs,
        sovereignFiefs,
        ctx.nameJa,
        ctx.fiefDedupe,
        hreRealm,
      );
    const { data: allData, characterSet } = labelSource;
    // #348 AC3: focus（地図中央の上位勢力）で絞る。ズーム段の絞り込みより
    // **前**に置く（focus 外の上位勢力名を復活させる処理が、ズーム側の
    // suppressed 除去に潰されないため）。focus 無し・base 未確定なら
    // allData がそのまま渡り、以降の参照同値も従来どおり保たれる。
    const focusKey = ctx.detailFocusKey ?? null;
    const classify = memoizedSuzerainClassifier(base, ctx.overrides);
    const suzerainOf = memoizedLabelSuzerainLookup(
      base,
      ctx.overrides,
      classify,
      hre,
      fiefs,
      italyFiefs,
      cliopatriaFiefs,
      britainFiefs,
      sovereignFiefs,
    );
    const focusedData = focusKey === null
      ? allData
      : memoizedFocusedPowerLabels(
        allData,
        focusKey,
        suzerainOf,
      );
    // TASK-122: FIEF_LABEL_MIN_ZOOM 未満では諸侯領・帝国領邦ラベルを出さず、
    // 代わりに TASK-78 で抑制していた base ラベルを復活させる。
    const visible = memoizedVisiblePowerLabels(
      focusedData,
      zoomStep,
      suzerainOf,
    );
    const laidOut = level === "overview"
      ? memoizedOverviewLabelLayout(visible)
      : visible;
    const data = memoizedLabelsByGroup[group](laidOut, group);
    return new TextLayer<LabelDatum, CollisionFilterExtensionProps<LabelDatum>>(
      {
        // フォント・衝突制御（COLLISION_SIZE_SCALE 倍判定）・衝突クアッド
        // （TASK-143）は共通 base props
        ...labelLayerBaseProps(),
        // #407: 18px の上位国名だけになる z4 は、領邦密集表示向けの 2.8 倍
        // 余白を 1.5 倍へ緩和する。lower 層および z5 以降は共通値を維持する。
        collisionTestProps: {
          sizeScale: group === "top" && level === "overview"
            ? OVERVIEW_TOP_LABEL_COLLISION_SIZE_SCALE
            : COLLISION_SIZE_SCALE,
        },
        id: group === "top" ? TOP_LABEL_LAYER_ID : LABEL_LAYER_ID,
        data,
        pickable: false,
        // #267 AC5: 政治勢力名は明色文字 + 濃焦茶 halo（案A）。共通 base props
        // のクリーム halo（LABEL_OUTLINE_COLOR。河川・都市・山岳の注記が使う）
        // をこの層だけ上書きする。
        outlineColor: [...POLITICAL_LABEL_HALO_COLOR],
        // #333 AC2/AC3: halo の幅は階層別。参考画像の濃色外縁は 20px の字でも
        // 15px の字でも 1.0〜1.5 CSS px とほぼ一定で、フォントサイズ比では
        // 小さい字ほど太い（0.065 em → 0.078 em）。deck.gl の実効 halo は
        // サイズ比例なので、同じ絶対幅にするには小さい側の outlineWidth を
        // 上げる必要がある = 単一の値では両立しない。#322 の 12（14px で
        // 実効 1.97 CSS px）は参考画像の約 1.8 倍あり、12px ラベルの
        // カウンター潰れ上限に張り付いていた。地色からの分離は下支えプレート
        // （getBackgroundColor 以下）が担う。
        outlineWidth: style.outlineWidth,
        // #322: 共通 SDF 設定（radius 12 / smoothing 0.1 / buffer 8）は
        // アトラス上 7.8px = 14px ラベルで約 1.71 CSS px が上限で、幅だけ
        // 増やしても明確な外枠にできない（#308 の残課題）。この層だけ専用の
        // SDF 設定へ切り替える。**モジュール定数をそのまま渡す**のが要点で、
        // レンダーごとに同値の新しいオブジェクトを渡すと deck.gl が
        // fontSettings の変化を検知してフォントアトラスを毎回作り直す。
        // 代償として注記ラベルとは別アトラスになる（キャッシュキーに buffer と
        // radius が入るため。メモリ +4.2MB / 初回生成 +2% は実測で許容）。
        // top / lower は SDF 設定を共有する。#427 では fontWeight が異なるため
        // アトラスは階層別になるが、hover/selected では作り直さない。
        fontSettings: POLITICAL_LABEL_FONT_SETTINGS,
        // #427: top は bold、lower は従来の semi-bold。TextLayer は tier ごとに
        // 分割済みなので、datum accessor を増やさずレイヤー単位で指定できる。
        fontWeight: style.fontWeight,
        // lower は文字列をひとまとまりとして読ませる濃色の下支えを使い、top は
        // #427 で可視プレートを外す。どちらも共通 base props の衝突用クアッド
        // （TASK-143）を維持する。TextLayer の background
        // サブレイヤーなので、描画要素が増えても衝突判定・priority・anchor・
        // 表示/非表示は文字側と常に同期する（AC8）。注記ラベル（都市・河川・
        // 山岳・山峰）は不可視クアッドのまま（AC9）。
        getBackgroundColor: [...style.plateColor],
        getBorderColor: [...style.plateBorderColor],
        getBorderWidth: style.plateBorderWidthPx,
        backgroundPadding: style.platePadding,
        backgroundBorderRadius: style.plateBorderRadiusPx,
        getText: (d) => d.text,
        getPosition: (d) =>
          level === "overview" ? d.overviewPosition ?? d.position : d.position,
        getPixelOffset: (d) => d.pixelOffset ?? [0, 0],
        // #267 AC5/AC6: 明色文字 + 濃焦茶 halo（outlineColor）で塗りの明暗に
        // よらず判読できる。TASK-30/71 の kind 別文字色は廃止し、表示階層は
        // サイズ（powerLabelSizePx）・衝突優先度（tieredLabelPriority）で示す。
        // TASK-93 の強調フィードバックは維持（強調中は純白へ。判定は
        // d.key = 塗りと同一の強調キー）。
        // #228 AC3 / #267 AC6: サイズは階層 × 表示レベル。概観（z4）の上位
        // 勢力名は全段で top 18px > constituent 14px >
        // sub 12px の階層差を付ける。判定は塗り・picking と共有の
        // politicalDisplayLevel（整数段）で、フォント・halo・衝突制御は不変。
        getSize: (d: LabelDatum) => powerLabelSizePx(labelTierOf(d), level),
        getColor: (d: LabelDatum) => [
          ...powerLabelColor(d, selectedPowerKey, hoveredPowerKey),
        ],
        // ü などの非 ASCII 文字（Württemberg 等）もグリフを生成する
        characterSet,
        // TASK-93: 強調キーは getColor の入力なので trigger に足す（足さないと
        // deck.gl が getColor を再評価せず文字色が切り替わらない）。data 自体は
        // 強調状態に依存しないため memoizedPowerLabelData のキャッシュは効き続け、
        // ホバーのたびに polylabel が走ることはない。
        // TASK-122: 表示対象がズーム段でも変わるため trigger に zoomStep を足す。
        // characterSet は絞り込み前の全テキストなので段が変わっても不変
        // （フォントアトラスは作り直されない）。
        // #228 AC3: getSize もズーム段の入力を持つため trigger に足す（定数の
        // 切替でも明示しておくことで、accessor 化しても再評価漏れが起きない）。
        updateTriggers: {
          getText: [year, zoomStep],
          getPosition: [year, zoomStep],
          getPixelOffset: [year, zoomStep],
          getColor: [selectedPowerKey, hoveredPowerKey],
          getSize: [zoomStep],
        },
      },
    );
  }

  /**
   * 政治ラベルの全レイヤー（constituent/sub → top の順）を返す（#333 AC3）。
   *
   * 並びは layer_stack.ts の {@linkcode OVERLAID_LAYER_IDS} と一致させる
   * （deck_app.ts の overlaySplitIsValid が毎回検証する）。呼び出し側が
   * 順序やグループの網羅を知らなくて済むよう、束ねるのは builder の責務に
   * する。
   */
  function buildLabelLayers(
    ctx: PoliticalLayerContext,
    base: FeatureCollection,
    hre: FeatureCollection,
    fiefs: FeatureCollection,
    italyFiefs: FeatureCollection,
    cliopatriaFiefs: FeatureCollection,
    britainFiefs: FeatureCollection,
    sovereignFiefs: FeatureCollection,
    hreRealm: FeatureCollection = EMPTY_FEATURE_COLLECTION,
  ): TextLayer<LabelDatum, CollisionFilterExtensionProps<LabelDatum>>[] {
    return (["lower", "top"] as const).map((group) =>
      buildLabelLayer(
        ctx,
        base,
        hre,
        fiefs,
        italyFiefs,
        cliopatriaFiefs,
        britainFiefs,
        sovereignFiefs,
        group,
        hreRealm,
      )
    );
  }

  return {
    // builder（renderLayers から context 付きで呼ばれる）
    buildPowerLayer,
    // #350: powers の塗りデータ（表示モード × focus 合成、メモ化付き）。
    // deck_app.ts の renderLayers が buildPowerLayer へ渡す data を作る。
    powerFillData,
    buildSuzerainExtentLayer,
    buildHreRealmOutlineLayer,
    buildLabelLayer,
    buildLabelLayers,
    // メモ化インスタンス（debug_hooks.ts へ同一インスタンスを注入するため公開。
    // builder とキャッシュを共有し、フックの呼び出しが再計算を誘発しない）
    memoizedPowerLabelData,
    memoizedVisiblePowerLabels,
    memoizedOverviewLabelLayout,
    // #333: 描画グループ別の振り分け（レイヤーの data はこれを通った参照）。
    // 参照同値の非退行テストが「レイヤーが実際に渡した配列」と突き合わせる。
    memoizedLabelsByGroup,
    // #348 AC4: 年代ごとの宗主分類器。オーバーレイ 6 系統とラベルが **同一
    // インスタンス**（= 同一キャッシュ）を使うことを非退行テストが突き合わせる
    // （どちらかが別の base 参照を渡すと単一スロットのキャッシュが落ち、
    // focus 切替のたびに containingSuzerainKey の線形走査が復活する）。
    memoizedSuzerainClassifier,
    memoizedLabelSuzerainLookup,
  };
}

/** createPoliticalLayerBuilders の返り値型（main.ts の配線・テストで使う） */
export type PoliticalLayerBuilders = ReturnType<
  typeof createPoliticalLayerBuilders
>;
