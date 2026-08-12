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
  underWaterBeforeId,
} from "./layer_stack.ts";
import {
  colorKeyFor,
  FILL_ALPHA,
  fillColorFor,
  hexToRgb,
  LINE_COLOR,
  LINE_WIDTH_PX,
  type Rgba,
} from "./powers.ts";
import {
  buildLabelData,
  characterSetFrom,
  FIEF_LABEL_COLOR,
  filterPowerLabelsByZoom,
  type LabelDatum,
  labelTierOf,
  partitionFiefsBySuzerain,
  POLITICAL_LABEL_FONT_SETTINGS,
  POLITICAL_LABEL_HALO_COLOR,
  POLITICAL_LABEL_OUTLINE_WIDTH,
  politicalDetailVisibleAt,
  type PoliticalDisplayLevel,
  politicalDisplayLevel,
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
  createSuzerainExtentCache,
  resolveSuzerainKey,
  type SuzerainExtentBands,
  type SuzerainOverrides,
} from "./suzerain_extent.ts";
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
  if (isPowerActive(colorKeyFor(props), selected, hovered)) {
    return ACTIVE_FILL_COLOR;
  }
  const suzerainKey = resolveSuzerainKey(props, overrides);
  const hex = suzerainKey === null ? undefined : colors[suzerainKey];
  const rgb = hex === undefined ? null : hexToRgb(hex);
  if (rgb !== null) return [rgb[0], rgb[1], rgb[2], FILL_ALPHA];
  return fillColorFor(props, colors);
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
      data,
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
      getFillColor: (f: Feature) =>
        detail
          ? powerFillColor(
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
      updateTriggers: {
        getFillColor: [ctx.year, selectedPowerKey, hoveredPowerKey, detail],
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
   */
  function buildSuzerainExtentLayer(
    ctx: PoliticalLayerContext,
    base: FeatureCollection,
  ): GeoJsonLayer {
    return new GeoJsonLayer({
      id: HRE_EXTENT_LAYER_ID,
      data: suzerainExtent(
        base,
        ctx.extentKey,
        ctx.overrides,
        ctx.coastalBands,
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
        ...buildLabelData(base, ja, "base", suppressed),
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
   */
  const memoizedVisiblePowerLabels = memoizeLatest(
    (data: readonly LabelDatum[], zoomStep: number) =>
      filterPowerLabelsByZoom(data, zoomStep),
  );

  /**
   * 勢力名ラベルの TextLayer を生成する（TASK-20）。
   * base（europe_*）と HRE 領邦オーバーレイ（hre_*）双方のラベルを 1 枚に束ね、
   * CollisionFilterExtension で重なりを間引く。面積由来の priority（labels.ts）
   * により大勢力を優先表示し、小勢力はズームインで空きができ次第表示される。
   * pickable は false（ラベル自体はホバー対象にせず、下のポリゴンの picking を
   * 妨げない）。年代切替では同一 ID のまま data を差し替えるのみ。
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
  ): TextLayer<LabelDatum, CollisionFilterExtensionProps<LabelDatum>> {
    const { year, zoomStep, selectedPowerKey, hoveredPowerKey } = ctx;
    // #267 AC1: 表示レベルはサイズ accessor の入力（塗り・境界・picking と
    // 同じ politicalDisplayLevel を共有する）
    const level = politicalDisplayLevel(zoomStep);
    // TextLayer は 1 枚のまま・衝突制御（共有空間・priority）も従来どおり。
    const { data: allData, characterSet } = memoizedPowerLabelData(
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
    );
    // TASK-122: FIEF_LABEL_MIN_ZOOM 未満では諸侯領・帝国領邦ラベルを出さず、
    // 代わりに TASK-78 で抑制していた base ラベルを復活させる。
    const data = memoizedVisiblePowerLabels(allData, zoomStep);
    return new TextLayer<LabelDatum, CollisionFilterExtensionProps<LabelDatum>>(
      {
        // フォント・衝突制御（COLLISION_SIZE_SCALE 倍判定）・不可視衝突
        // クアッド（TASK-143）は共通 base props
        ...labelLayerBaseProps(),
        id: LABEL_LAYER_ID,
        data,
        pickable: false,
        // #267 AC5: 政治勢力名は明色文字 + 濃焦茶 halo（案A）。共通 base props
        // のクリーム halo（LABEL_OUTLINE_COLOR。河川・都市・山岳の注記が使う）
        // をこの層だけ上書きする。
        outlineColor: [...POLITICAL_LABEL_HALO_COLOR],
        // #308/#322: halo が「文字の可読性補助」ではなく「外枠そのもの」に
        // なった層なので、幅も共通値（LABEL_OUTLINE_WIDTH = 5、実効 0.82 CSS
        // px）では足りない。専用値で上書きする（注記ラベルの共通幅は不変）。
        outlineWidth: POLITICAL_LABEL_OUTLINE_WIDTH,
        // #322: 共通 SDF 設定（radius 12 / smoothing 0.1 / buffer 8）は
        // アトラス上 7.8px = 14px ラベルで約 1.71 CSS px が上限で、幅だけ
        // 増やしても明確な外枠にできない（#308 の残課題）。この層だけ専用の
        // SDF 設定へ切り替える。**モジュール定数をそのまま渡す**のが要点で、
        // レンダーごとに同値の新しいオブジェクトを渡すと deck.gl が
        // fontSettings の変化を検知してフォントアトラスを毎回作り直す。
        // 代償として注記ラベルとは別アトラスになる（キャッシュキーに buffer と
        // radius が入るため。メモリ +4.2MB / 初回生成 +2% は実測で許容）。
        fontSettings: POLITICAL_LABEL_FONT_SETTINGS,
        getText: (d) => d.text,
        getPosition: (d) => d.position,
        // #267 AC5/AC6: 明色文字 + 濃焦茶 halo（outlineColor）で塗りの明暗に
        // よらず判読できる。TASK-30/71 の kind 別文字色は廃止し、表示階層は
        // サイズ（powerLabelSizePx）・衝突優先度（tieredLabelPriority）で示す。
        // TASK-93 の強調フィードバックは維持（強調中は純白へ。判定は
        // d.key = 塗りと同一の強調キー）。
        // #228 AC3 / #267 AC6: サイズは階層 × 表示レベル。概観（z4）の上位
        // 勢力名は最大 18px、中間・詳細では top 16px > constituent 14px >
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
          getColor: [selectedPowerKey, hoveredPowerKey],
          getSize: [zoomStep],
        },
      },
    );
  }

  return {
    // builder（renderLayers から context 付きで呼ばれる）
    buildPowerLayer,
    buildSuzerainExtentLayer,
    buildLabelLayer,
    // メモ化インスタンス（debug_hooks.ts へ同一インスタンスを注入するため公開。
    // builder とキャッシュを共有し、フックの呼び出しが再計算を誘発しない）
    memoizedPowerLabelData,
    memoizedVisiblePowerLabels,
  };
}

/** createPoliticalLayerBuilders の返り値型（main.ts の配線・テストで使う） */
export type PoliticalLayerBuilders = ReturnType<
  typeof createPoliticalLayerBuilders
>;
