/**
 * picking イベント処理（TASK-149 / Issue #167。main.ts から抽出）。
 *
 * Deck レベル onHover/onClick の実体（handlePickHover / handlePickClick）と、
 * picking 結果の解決（pickedLabel / resolveClickInfo）を
 * {@linkcode createPickHandlers} ファクトリに閉じ込める。
 *
 * decision-29 / docs/main-ts-inventory.md §2 U6 の方針:
 * - **選択/ホバー状態（selectedRiverName / hoveredRiverName /
 *   selectedMountainName / hoveredMountainName / selectedPeakName /
 *   hoveredPeakName / 勢力圏外枠の選択・ホバーキー）だけは、このファクトリの
 *   closure が所有する**
 *   （U6 で明示的に許された例外。§3-3「選択/ホバー状態だけは U6 のファクトリへ
 *   移す選択肢を許す」）。書き込み経路が handlePickHover / handlePickClick の
 *   2 本に閉じているため、状態と遷移規則を同じモジュールで直接ユニットテスト
 *   できる。main.ts の renderLayers（context 組み立て）とデバッグフック
 *   （debug_hooks.ts）へは返り値ハンドルの**読み取り用 getter** で提供する。
 * - それ以外の状態（データストア・currentView・powerHighlight ストア・
 *   fillTransitionMs）の所有は従来どおり main.ts に残し、getter・コールバックで
 *   注入される（{@linkcode PickHandlerDeps}）。powerHighlight を移さないのは、
 *   年代切替時の clear 抑止（suppressPowerHighlightRender）と塗り遷移時間の
 *   一時差し替え（renderWithFillTransition）が yearSwitcher / renderLayers と
 *   結びついた main.ts の配線責務のため。
 * - レイヤー再構築は requestRender コールバック（main.ts renderLayers）へ
 *   委譲し、**値が変わったときだけ**呼ぶ（TASK-50 の規律。apply* の変化検知）。
 */
import type { PickingInfo } from "@deck.gl/core";
import type { Feature, FeatureCollection } from "geojson";
import { displayLabel } from "./info.ts";
import {
  BRITAIN_FIEF_LAYER_ID,
  CLIOPATRIA_FIEF_LAYER_ID,
  FRANCE_FIEF_LAYER_ID,
  HRE_LAYER_ID,
  isBoundaryUnavailableMarkerLayerId,
  isCityPickLayerId,
  isDirectPickFinal,
  isMountainPickLayerId,
  isPeakPickLayerId,
  isRiversPickLayerId,
  ITALY_FIEF_LAYER_ID,
  type PickDetailFocus,
  PICKING_PRIORITY,
  PICKING_RADIUS_PX,
  POWER_LAYER_ID,
  resolveClickPick,
  SOVEREIGN_FIEF_LAYER_ID,
} from "./picking.ts";
import { EMPTY_FEATURE_COLLECTION } from "./powers.ts";
import { memoizeLatest } from "./memo.ts";
import {
  type MountainLabelDatum,
  mountainPickLabel,
  toggleMountainSelection,
} from "./mountains.ts";
import {
  type PeakMarkerDatum,
  peakPickLabel,
  togglePeakSelection,
} from "./peaks.ts";
import { riverNameFor, toggleRiverSelection } from "./rivers.ts";
import { type CityMarkerDatum, cityPickLabel } from "./cities.ts";
import {
  containingSuzerainKey,
  suzerainExtentKey,
  type SuzerainOverrides,
} from "./suzerain_extent.ts";
import { powerHighlightKey, togglePowerSelection } from "./power_highlight.ts";
import {
  borrowedBoundaryDescription,
  boundaryMarkerTooltip,
  type BoundaryUnavailableMarker,
} from "./hre_major_polities.ts";

/**
 * pickMultipleObjects で近傍候補を取得する際の最大件数（depth）（TASK-36）。
 * deck.gl デフォルトの 10 より絞り、余分な GPU 読み戻しコストを抑える。
 *
 * TASK-96: pickable 層の数（PICKING_PRIORITY.length）そのものを使う。
 * 3 系統の領邦オーバーレイ（hre-powers / france-fiefs / italy-fiefs）は
 * scripts/build-fief-flat.ts が幾何的に排他化するため、同一ピクセルへ実際に
 * 重なるのは高々 6 層だが、この定数を層数から導いておけば層を足すたびに
 * 「上限に収まっているか」を数え直さずに済む（TASK-71 以来この見積もりは
 * 2 度陳腐化した）。
 */
export const CLICK_PICK_DEPTH = PICKING_PRIORITY.length;

/**
 * FeatureCollection / cities.json が持つ非標準トップレベルの `metadata` を
 * 型を緩めて取り出す（TASK-109）。GeoJSON の型定義に `metadata` は無く、
 * cities.json は GeoJSON ですらないため、読み出しはここ 1 箇所に閉じ込める。
 * データが未ロード・metadata 未付与ならそのまま undefined になり、
 * 呼び出し側（sourceLines）が空の出典行に倒す。
 */
export function collectionMetadata(data: unknown): unknown {
  return (data as { metadata?: unknown } | null | undefined)?.metadata;
}

/**
 * 政治勢力（base 勢力 + 領邦・主権政体オーバーレイ）のレイヤー ID か。
 */
export function isPowerPickLayerId(layerId: string | undefined): boolean {
  return layerId === POWER_LAYER_ID || layerId === HRE_LAYER_ID ||
    layerId === FRANCE_FIEF_LAYER_ID || layerId === ITALY_FIEF_LAYER_ID ||
    layerId === CLIOPATRIA_FIEF_LAYER_ID ||
    layerId === BRITAIN_FIEF_LAYER_ID ||
    layerId === SOVEREIGN_FIEF_LAYER_ID;
}

/**
 * タッチ主体の入力でカーソル追従ツールチップを抑止するか判定する純粋関数
 * （Issue #253）。
 *
 * ホバーを持たないタッチ操作では、タップでも onHover が発火し、カーソル追従
 * ツールチップがタップ後に残る。タッチ主体と判定したらツールチップを抑止し、
 * クリックでは選択強調だけを更新する。
 *
 * 判定は 2 信号の OR:
 * - `pointerType === "touch"`: pick イベント（mjolnir.js MjolnirPointerEvent）
 *   が運ぶイベント単位の信号。タッチ画面 + マウス併用の端末でも、タッチ由来の
 *   イベントだけを正しく抑止できる。
 * - `coarsePointer`（matchMedia("(pointer: coarse)")）: 端末単位の信号。
 *   pointerType が取れない経路や、タッチから合成された互換 mouse イベントでも
 *   タッチ端末なら抑止に倒せるフォールバック。
 *
 * デスクトップのマウス・ペン（fine pointer 環境）はどちらの信号も立たず、
 * 従来どおりホバーでツールチップが出る（AC3）。
 */
export function suppressHoverTooltip(
  pointerType: string | undefined,
  coarsePointer: boolean,
): boolean {
  return pointerType === "touch" || coarsePointer;
}

/**
 * picking 結果から山脈名（英語の元名）を解決する（TASK-100）。
 * 対象外レイヤー・picking なしは null。extentKeyFromPick / powerHighlightKeyFromPick
 * と同型で、ホバー（直下 pick）とクリック（resolveClickInfo で選び直した pick）が
 * 同じ経路を通ることを保証する。
 */
export function mountainNameFromPick(info: PickingInfo): string | null {
  if (info.object === undefined || !isMountainPickLayerId(info.layer?.id)) {
    return null;
  }
  return (info.object as MountainLabelDatum).name;
}

/** picking 結果から山峰名（英語の元名）を解決する（TASK-100） */
export function peakNameFromPick(info: PickingInfo): string | null {
  if (info.object === undefined || !isPeakPickLayerId(info.layer?.id)) {
    return null;
  }
  return (info.object as PeakMarkerDatum).name;
}

/**
 * picking 結果から政治ポリゴンの強調キーを解決する（TASK-90）。
 * 判定本体は power_highlight.ts の powerHighlightKey（純粋関数）。
 * extentKeyFromPick と同型にし、ホバー（直下 pick）とクリック
 * （resolveClickInfo で選び直した pick）が同じ経路を通ることを保証する。
 * 都市マーカーの picking 結果は GeoJSON Feature ではないが、
 * powerHighlightKey がレイヤー ID を先に見るため安全に null になる。
 */
export function powerHighlightKeyFromPick(info: PickingInfo): string | null {
  if (info.object === undefined || info.layer === null) return null;
  return powerHighlightKey(info.layer.id, (info.object as Feature).properties);
}

/**
 * picking 解決が読む「現在年の反映済みデータ」（main.ts currentView の
 * サブセット）。main.ts 側の実体には outlines など他のフィールドもあるが、
 * picking と強調処理が読むものだけを構造的に要求する
 * （debug_hooks.ts の DebugYearView と同じ流儀）。
 */
export interface PickYearView {
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
 * createPickHandlers へ main.ts から注入する依存。選択/ホバー状態
 * **以外**の状態所有は main.ts に残るため（decision-29）、ここでは getter・
 * コールバック・能力関数だけを受ける。
 */
export interface PickHandlerDeps {
  // ---- main.ts が所有するデータストア（getter 注入） ----
  getNameJa: () => Record<string, string>;
  getOverrides: () => SuzerainOverrides;
  getCurrentView: () => PickYearView | null;
  /**
   * 現在の表示年（#223）。都市の pick ラベル（cityPickLabel）が時代別都市名を
   * ラベル（buildCityLabelData）と同じ cityDisplayName(name, ja, year) で
   * 解決するために読む。
   */
  getYear: () => number;

  // ---- 表示先（src/ui/info_tooltip.ts のハンドル。コールバック注入） ----
  showTooltip: (label: string, x: number, y: number) => void;
  hideTooltip: () => void;

  /**
   * レイヤー再構築（main.ts renderLayers）。apply* の変化検知を通った
   * 「値が変わったとき」だけ呼ばれる（TASK-50 の規律）。
   */
  requestRender: () => void;

  /**
   * 政治ポリゴンの強調ストア（power_highlight.ts。所有は main.ts）。
   * 変化検知と再構築（onChange）はストア側が持つため、ここでは
   * 現在キーを読み、hover / click の次状態を同期する。
   */
  powerHighlight: {
    selected(): string | null;
    hovered(): string | null;
    hover(key: string | null): void;
    click(key: string | null): void;
  };

  /** deck.gl overlay.pickMultipleObjects（クリック時の近傍再ピック。TASK-36） */
  pickMultipleObjects: (
    opts: { x: number; y: number; radius: number; depth: number },
  ) => PickingInfo[];

  /**
   * 主ポインタが粗い（タッチ端末相当）環境かどうか（Issue #253）。
   * main.ts は matchMedia("(pointer: coarse)").matches を注入する。
   * suppressHoverTooltip のフォールバック信号として、pick イベントの
   * pointerType が取れない経路でもタッチ端末ならツールチップを抑止する。
   * getter 注入なのは他の deps と同じ理由（状態の所有は main.ts / ブラウザ環境
   * 側に残し、テストではダブルへ差し替えるため）。
   */
  isCoarsePointer: () => boolean;

  /**
   * 現在の詳細表示 focus（#293 の `detailFocusKey`。#349 / #293 分割 4/5）。
   *
   * **任意**。省略した場合は focus 機能そのものがオフで、picking・出典解決は
   * 既存実装と完全に同一の挙動になる（#349 AC6）。
   *
   * #350: `main.ts` が `detailFocusKeyForZoom(detailFocus.key(), zoomStep)`
   * （suzerain_extent.ts）を注入する。塗り・概略境界・レイヤー・ラベルへ配る
   * 値と**同一の関数の結果**なので、「表示されている領邦だけが pickable」が
   * ズーム段の切替をまたいでも崩れない。
   *
   * 返り値の `null` は概観表示（z4）= focus 非適用で、領邦オーバーレイ自体が
   * `visible: false` のため降格の有無に関わらず picking へ現れない。中央が
   * 海上・base 勢力外のときは `UNRESOLVED_DETAIL_FOCUS_KEY`（どの宗主にも
   * 一致しないキー）が渡り、全領邦が降格されて全域が上位勢力単位になる
   * （#293 AC5 / #349 AC4）。
   */
  getDetailFocusKey?: () => string | null;
}

/**
 * picking イベント処理のハンドラ群と選択/ホバー状態を生成する（TASK-149）。
 *
 * main.ts はこれを起動時に 1 度だけ呼び、handlePickHover / handlePickClick を
 * MapboxOverlay の onHover / onClick へ渡す。選択/ホバー状態は
 * この closure が所有し、renderLayers の context 組み立て・デバッグフックは
 * 返り値の getter で読む。
 */
export function createPickHandlers(deps: PickHandlerDeps) {
  /** クリックで選択（強調）中の河川名。null は未選択（TASK-24 AC #2） */
  let selectedRiverName: string | null = null;

  /**
   * ホバー中の河川名。null はホバーなし（TASK-42）。選択とは独立に管理し、
   * riverLineColor/riverLineWidth で選択 > ホバー > 通常の優先度で強調へ変換する。
   */
  let hoveredRiverName: string | null = null;

  /**
   * クリックで選択（強調）中の山脈名・山峰名（英語の元名。null は未選択）
   * （TASK-100 AC #4）。河川と同じく「選択」と「ホバー」を独立に持ち、
   * mountains.ts / peaks.ts の純粋関数で色・線幅・記号サイズへ変換する。
   *
   * 山脈と山峰を別々の状態にするのは、両者が別レイヤー（面の輪郭 / 点の記号）
   * で別の強調表現を持つため。同時に強調されることはあり得る（モンブランを
   * ホバーしたままアルプス山脈を選択している等）が、それぞれの表現が独立して
   * いるので混乱しない。年代非依存なので年代切替では解除しない（AC #5）。
   */
  let selectedMountainName: string | null = null;
  let hoveredMountainName: string | null = null;
  let selectedPeakName: string | null = null;
  let hoveredPeakName: string | null = null;

  /**
   * 勢力圏外枠のクリック選択とホバーを独立に保持する（#431）。表示時は
   * hover > selected の順で解決し、ホバー解除時は選択外枠へ戻す。
   * power key も対で覚えるのは、同じ宗主に属する別 feature のクリックを
   * 「同じ対象の再クリック」と誤認せず、powerHighlight のトグルと外枠選択を
   * 同じ遷移にするため。store が年代切替などで外部から clear された場合も、
   * key の不一致を検出して古い外枠を表示しない。
   */
  let selectedExtentPowerKey: string | null = null;
  let selectedExtentKey: string | null = null;
  let hoveredExtentPowerKey: string | null = null;
  let hoveredExtentKey: string | null = null;

  /**
   * picking 結果からツールチップ/パネル用の表示ラベルを整形する（TASK-24）。
   * - rivers: 河川名（name-ja.json 適用。未登録は英語のまま）
   * - cities: 都市名（TASK-27。name-ja.json 適用。未登録は英語のまま）
   * - powers / hre-powers: 勢力ラベル（displayLabel。宗主国込み表記）
   * - それ以外（picking なし・ラベル系レイヤー）は null
   *
   * TASK-29: 引数の info は Deck レベル onHover/onClick が渡す単一の picking
   * 結果で、deck.gl は最前面のレイヤーを返す。renderLayers が描画順を
   * PICKING_PRIORITY の逆順（優先が高いほど上）から導出しているため、
   * ホバーでは「単一 pick = PICKING_PRIORITY の最優先候補」が概ね成立する。
   * ただし河川ラインは描画幅が細く、カーソル直下ピクセルには常に powers
   * ポリゴンが存在するため、河川に対しては単一 pick だけでは優先が効かない
   * （TASK-36）。クリックでは handlePickClick が resolveClickPick で選び直した
   * info を渡すため、この関数自体は info の由来（単一 pick か選び直し後か）を
   * 意識しない。
   */
  function pickedLabel(info: PickingInfo): string | null {
    const layerId = info.layer?.id;
    if (info.object === undefined || layerId === undefined) return null;
    const nameJa = deps.getNameJa();
    if (isBoundaryUnavailableMarkerLayerId(layerId)) {
      return boundaryMarkerTooltip(info.object as BoundaryUnavailableMarker);
    }
    // TASK-100: 山岳は年代非依存の地形。ラベル整形（mountainPickLabel /
    // peakPickLabel）は年を引数に取らない純粋関数なので、年代を切り替えても
    // 同じ pick からは必ず同じ文字列が出る（AC #5）。
    if (isMountainPickLayerId(layerId)) {
      return mountainPickLabel(info.object as MountainLabelDatum, nameJa);
    }
    if (isPeakPickLayerId(layerId)) {
      // peaks（可視 ▲）と peaks-hit（透明判定円）はデータが同一（PeakMarkerDatum）
      // なので、どちらの pick でも同じ経路で「名称 標高m」を出せる
      return peakPickLabel(info.object as PeakMarkerDatum, nameJa);
    }
    if (isCityPickLayerId(layerId)) {
      // 都市は cityPickLabel で「表示名 + 人口（補間値なら明示）」を整形する
      // （Issue #221 AC3。表示名の解決は従来どおり cityDisplayName 経由で、
      // Venice 等の勢力名衝突キーは都市訳を優先）
      // TASK-82: cities（可視ドット）と cities-hit（透明判定円）はデータが同一
      // （CityMarkerDatum）なので、どちらの pick でも同じ経路で表示できる
      // #223: 表示年を渡し、時代別都市名（ベオグラード = ナーンドルフェヘール
      // ヴァール 1427–1521 等）をラベルと同じ年代別表記にする
      return cityPickLabel(
        info.object as CityMarkerDatum,
        nameJa,
        deps.getYear(),
      );
    }
    const feature = info.object as Feature;
    if (isRiversPickLayerId(layerId)) {
      const name = riverNameFor(feature.properties);
      return name === null ? null : nameJa[name] ?? name;
    }
    if (isPowerPickLayerId(layerId)) {
      // TASK-71/96: フランス諸侯領・イタリア諸侯領は SUBJECTO を持たないため
      // displayLabel は NAME の日本語表記（称号付き）をそのまま返す
      // （宗主国込み表記にはならない）
      // TASK-110: Cliopatria 由来の領邦は SUBJECTO を持つものがあり、その場合は
      // HRE 領邦と同じく「宗主国込み」の表記になる（displayLabel の既存規則）
      // #172: ブリテン諸島の政体も SUBJECTO を持たず、独立主権政体として
      // 宗主なしの NAME 表記になる
      // #189: 主権政体オーバーレイも同様（SUBJECTO なしの NAME 表記）
      const label = displayLabel(
        feature.properties,
        deps.getOverrides().renames,
        nameJa,
      );
      const approximate = borrowedBoundaryDescription(feature);
      return approximate === null ? label : `${label}\n${approximate}`;
    }
    return null;
  }

  /**
   * picking 結果から、外枠を出すべき宗主キーを解決する（TASK-94 / TASK-120）。
   * 判定本体は suzerain_extent.ts の suzerainExtentKey（純粋関数）。都市マーカーの
   * picking 結果は GeoJSON Feature ではないが、suzerainExtentKey がレイヤー ID
   * を先に見るため feature でなくても安全に null になる。
   *
   * Issue #436: 外枠所属は `EXTENT_KEY` / `EXTENT_ROLE` を正本とし、ラベル
   * アンカーによる推定は行わない。base は旧データ互換の関数引数として残る。
   * 同じ feature の上を動く間の再計算を避けるため memoizeLatest で 1 スロット
   * だけ覚える（TASK-50 の規律）。
   */
  const memoizedExtentKey = memoizeLatest(suzerainExtentKey);

  /**
   * 近傍再ピック（resolveClickInfo）へ渡す詳細表示 focus を組み立てる
   * （#349 / #293 分割 4/5）。
   *
   * `deps.getDetailFocusKey` が注入されていなければ null = focus 機能オフで、
   * `resolveClickPick` は既存とまったく同じ経路を通る（AC6）。
   *
   * 領邦候補の分類は外枠所属とは別責務である。detail focus は表示中の base
   * 領域に含まれる候補を選ぶ視覚的フィルターなので、#293 分割 3/5 の
   * オーバーレイ絞り込みと同じ `containingSuzerainKey` を使う。これにより
   * 「表示されている領邦だけが pickable」が成り立つ一方、外枠の権威を
   * ラベルアンカーへ戻すことはない（Issue #436）。
   *
   * ここでは memoizeLatest を挟まない。この経路はクリック 1 回につき近傍候補
   * （高々 CLICK_PICK_DEPTH 件）を一巡するだけで、1 スロットのメモ化は連続
   * ヒットしない（毎 mousemove で同じ封土を引く extentKeyFromPick とは事情が
   * 違う）。
   */
  function detailFocusForPick(): PickDetailFocus | null {
    const getKey = deps.getDetailFocusKey;
    if (getKey === undefined) return null;
    const base = deps.getCurrentView()?.base ?? EMPTY_FEATURE_COLLECTION;
    const overrides = deps.getOverrides();
    return {
      key: getKey(),
      suzerainKeyOf: (_layerId, object) =>
        containingSuzerainKey(object as Feature, base, overrides),
    };
  }

  function extentKeyFromPick(info: PickingInfo): string | null {
    if (info.object === undefined || info.layer === null) return null;
    return memoizedExtentKey(
      info.layer.id,
      info.object as Feature,
      deps.getCurrentView()?.base ?? EMPTY_FEATURE_COLLECTION,
      deps.getOverrides(),
    );
  }

  /** 現在表示する外枠。ホバーを優先し、無ければクリック選択へ戻す。 */
  function extentKey(): string | null {
    const hovered = deps.powerHighlight.hovered() === hoveredExtentPowerKey
      ? hoveredExtentKey
      : null;
    if (hovered !== null) return hovered;
    return deps.powerHighlight.selected() === selectedExtentPowerKey
      ? selectedExtentKey
      : null;
  }

  /**
   * ホバー外枠を更新する。powerHighlight と同じ info 由来のキーを対で保持し、
   * 有効な表示キーが変わった場合だけ外枠用の再構築を要求する。
   */
  function applyExtentHover(
    nextPowerKey: string | null,
    nextExtentKey: string | null,
  ): void {
    const previous = extentKey();
    hoveredExtentPowerKey = nextPowerKey;
    hoveredExtentKey = nextExtentKey;
    deps.powerHighlight.hover(nextPowerKey);
    if (extentKey() !== previous) deps.requestRender();
  }

  /**
   * クリック外枠を powerHighlight の選択トグルと同じ遷移で更新する。
   * 同じ宗主キーの別領邦へ選択が移っても、表示外枠が同じなら再構築しない。
   */
  function applyExtentSelection(
    clickedPowerKey: string | null,
    clickedExtentKey: string | null,
  ): void {
    const previous = extentKey();
    const nextPowerKey = togglePowerSelection(
      deps.powerHighlight.selected(),
      clickedPowerKey,
    );
    selectedExtentPowerKey = nextPowerKey;
    selectedExtentKey = nextPowerKey === null ? null : clickedExtentKey;
    deps.powerHighlight.click(clickedPowerKey);
    if (extentKey() !== previous) deps.requestRender();
  }

  /** 河川の選択状態を更新し、変化があればレイヤーを再構築して反映する */
  function applyRiverSelection(next: string | null): void {
    if (next === selectedRiverName) return;
    selectedRiverName = next;
    deps.requestRender();
  }

  /**
   * 河川のホバー状態を更新し、変化があればレイヤーを再構築して反映する
   * （TASK-42）。毎 mousemove で呼ばれるため、値が変化しない限り
   * requestRender を呼ばない（無駄な再構築を避ける）。
   */
  function applyRiverHover(next: string | null): void {
    if (next === hoveredRiverName) return;
    hoveredRiverName = next;
    deps.requestRender();
  }

  /**
   * 山脈・山峰のホバー状態をまとめて更新し、変化があれば 1 度だけレイヤーを
   * 再構築する（TASK-100）。山脈と山峰を 1 本の関数で扱うのは、両者が
   * 同時に変化する（山峰から外れて山脈へ入る等）ときに requestRender を
   * 2 度呼ばないため。毎 mousemove で呼ばれるので、値が変化しない限り
   * requestRender を呼ばない（applyRiverHover と同じ変化検知。TASK-50 の規律）。
   */
  function applyTerrainHover(
    nextMountain: string | null,
    nextPeak: string | null,
  ): void {
    if (nextMountain === hoveredMountainName && nextPeak === hoveredPeakName) {
      return;
    }
    hoveredMountainName = nextMountain;
    hoveredPeakName = nextPeak;
    deps.requestRender();
  }

  /** 山脈・山峰の選択状態をまとめて更新する（変化時のみ再構築。TASK-100） */
  function applyTerrainSelection(
    nextMountain: string | null,
    nextPeak: string | null,
  ): void {
    if (
      nextMountain === selectedMountainName && nextPeak === selectedPeakName
    ) {
      return;
    }
    selectedMountainName = nextMountain;
    selectedPeakName = nextPeak;
    deps.requestRender();
  }

  /**
   * Deck レベルのホバー処理（TASK-24 AC #3）。最前面の picking 結果 1 件だけを
   * 受け取るため、河川ライン上では河川名、勢力ポリゴン上では勢力ラベル、
   * どちらも無ければ非表示、が一意に決まる（rivers が powers のホバーを阻害しない）。
   *
   * TASK-69: 河川ホバー時はカーソル追従ツールチップ（ここ）と地図上の河川名
   * ラベル（buildRiverLabelLayer）が同時に出る。ツールチップは残す方針とした:
   * 地図上ラベルのアンカーは川の中点（rivers.ts riverLabelAnchors）で、ホバー
   * 位置から遠い・ビューポート外のこともあり、それ単独ではホバーの即時
   * フィードバックにならないため。ツールチップ = カーソル直下の即応表示、
   * 地図ラベル = 川そのものへの注記（選択時は解除まで残る）と役割が異なり、
   * 勢力・都市のホバー挙動（ツールチップ）とも一貫する。
   *
   * TASK-123（ズーム段による常時表示の復活）でもこの判断を維持する。常時表示に
   * 戻っても中点ラベルが「カーソル直下の即応表示」になれない事情は変わらず、
   * 常時ラベルが出ている勢力・都市もホバーでツールチップを重ねて出しており、
   * 河川だけ挙動を変える理由がない。
   *
   * Issue #253: 上記のツールチップ方針は「ホバーできるマウス・ペン」限定。
   * タッチではタップが onHover → onClick と連続発火してツールチップが残るため、
   * タッチ主体（suppressHoverTooltip: pick イベントの pointerType が
   * touch、または pointer: coarse 環境）ではツールチップを出さず隠す。
   * 強調系（外枠・勢力強調・河川/山岳ホバー）は入力種別に依存しないので
   * 従来どおり更新する。event は MapboxOverlay onHover が渡す
   * MjolnirPointerEvent（構造的に pointerType だけ要求する。デバッグフック等
   * イベントを持たない呼び出しは省略可で、その場合は端末条件だけで判定する）。
   *
   * #349: ホバーには詳細表示 focus の降格を入れない。ホバーは Deck が返す
   * 直下 pick 1 件だけを見る経路で、降格しても「その下の base 勢力」を得る
   * 手段が無い（得るには mousemove ごとに pickMultipleObjects を回すことに
   * なり、クリック限定という TASK-36 の設計判断を覆す）。focus 外の領邦は
   * #293 分割 3/5 が data を空 FC にして描画自体を止めるため、そもそも
   * ホバーの候補にならない。降格が要るのは「半径内の候補を集め直す」
   * クリック側（resolveClickInfo）だけ。
   */
  function handlePickHover(
    info: PickingInfo,
    event?: { pointerType?: string },
  ): void {
    const label = pickedLabel(info);
    if (
      label !== null &&
      !suppressHoverTooltip(event?.pointerType, deps.isCoarsePointer())
    ) {
      deps.showTooltip(label, info.x, info.y);
    } else deps.hideTooltip();
    const hoveredPowerKey = powerHighlightKeyFromPick(info);
    // TASK-30 / TASK-94 / #431: 勢力（宗主・封臣のいずれ）のホバーではその
    // 勢力圏を優先表示し、ホバー解除時はクリック選択中の外枠へ戻す。
    applyExtentHover(hoveredPowerKey, extentKeyFromPick(info));
    // TASK-90: 勢力・領邦のホバー強調。河川・都市・何も無い場所のホバーでは
    // キーが null になり強調が解除される（AC #2/#6）。判定経路は
    // extentKeyFromPick と同型（同じ info から純粋関数でキーを解決する）。
    // TASK-42: 河川ホバー中の中間強調。pick が rivers 以外・picking なしの場合は
    // null（通常表示）に戻す。ホバーの picking 方式自体（直下 pick）は変更しない
    // （TASK-36 の半径補正はクリック限定という設計判断を維持）。
    applyRiverHover(
      isRiversPickLayerId(info.layer?.id) && info.object !== undefined
        ? riverNameFor((info.object as Feature).properties)
        : null,
    );
    // TASK-100: 山岳のホバー強調（山脈は輪郭・山峰は記号）。河川と同じく
    // 「対象外の pick・picking なし」では null に倒れて強調が解除される。
    applyTerrainHover(mountainNameFromPick(info), peakNameFromPick(info));
  }

  /**
   * Deck レベルの単一 picking 結果を、必要な場合のみ半径内の複数候補で選び
   * 直す（TASK-36）。単一 pick が既に rivers ならそのまま使う（再ピック不要）。
   * 単一 pick が rivers 以外（powers 等）または何も無い場合にのみ
   * overlay.pickMultipleObjects で半径内の候補を集め、resolveClickPick
   * （PICKING_PRIORITY 準拠）で選び直す。これにより河川の描画幅（2px）の外側
   * でも pickingRadius 分の近傍探索が河川に対して機能するようになる。
   * ホバーでは呼ばない（mousemove 毎の pickMultipleObjects は高コストなため、
   * この補正はクリックに限定する設計判断。TASK-36）。
   *
   * TASK-51: この PICKING_RADIUS_PX（picking.ts、near-cursor 再ピック半径）と
   * rivers.ts の透明ヒットライン半幅（RIVER_HIT_LINE_WIDTH_PX / 2）が合成され、
   * 河川クリックの実効許容範囲になる（rivers.ts RIVER_CLICK_TOLERANCE_PX を参照）。
   *
   * TASK-82: 都市側は逆に合成させない。cities-hit（透明判定円）は
   * picking.ts isNearCursorRepickable で再ピック候補から除外されるため、
   * 都市の実効判定範囲はホバー・クリックとも cities.ts CITY_PICK_TOLERANCE_PX
   * （= CITY_HIT_RADIUS_PX）で一致する。直下 pick が cities/cities-hit なら
   * isDirectPickFinal でそのまま確定する（再ピックへ落ちない）。
   *
   * #216: カーソル座標（rawInfo.coordinate、lng/lat）を resolveClickPick へ
   * 引き渡す。政治ポリゴン候補のうちカーソルを実際に含まないもの（半径内の
   * 「隣」の面）は優先順の適用前に降格され、ホバー（直下 pick = カーソルを
   * 含む面）とクリックの解決 feature が一致する。
   */
  function resolveClickInfo(info: PickingInfo): PickingInfo {
    if (isDirectPickFinal(info.layer?.id)) return info;
    const candidates = deps.pickMultipleObjects({
      x: info.x,
      y: info.y,
      radius: PICKING_RADIUS_PX,
      depth: CLICK_PICK_DEPTH,
    });
    return resolveClickPick(
      candidates,
      info.coordinate,
      detailFocusForPick(),
    ) ?? info;
  }

  /**
   * Deck レベルのクリック処理（TASK-24 AC #2/#3、TASK-36）。
   * - 河川ライン: 選択をトグル
   * - 勢力ポリゴン: 勢力を選択し、河川選択は解除
   * - 何も無い場所: 河川選択を解除（Deck の onClick は picking なしでも
   *   layer: null の info で呼ばれることを @deck.gl/core の実装で確認済み）
   * TASK-36: Deck onClick が渡す単一 info をそのまま使わず、まず
   * resolveClickInfo で半径内の河川優先の選び直しを行う。
   */
  function handlePickClick(rawInfo: PickingInfo): void {
    const info = resolveClickInfo(rawInfo);
    const clickLabel = pickedLabel(info);
    if (
      clickLabel !== null &&
      (isBoundaryUnavailableMarkerLayerId(info.layer?.id) ||
        (info.object !== undefined &&
          borrowedBoundaryDescription(info.object as Feature) !== null))
    ) {
      deps.showTooltip(clickLabel, info.x, info.y);
    }
    const clickedPowerKey = powerHighlightKeyFromPick(info);
    // TASK-30 / TASK-94 / #431: クリック選択の外枠はホバーと独立に保持する。
    // 河川・都市・空白は null、同じ対象の再クリックはトグルで null になる。
    applyExtentSelection(clickedPowerKey, extentKeyFromPick(info));
    // TASK-90: 勢力・領邦のクリック強調（ホバーの無いタッチ操作でも成立させる）。
    // 保持・解除規則は power_highlight.ts togglePowerSelection（河川の選択トグルと
    // 同一規則）: 同一対象の再クリックで解除・別対象で移動・河川/都市/空クリック
    // （キー null）で解除。年代切替では yearSwitcher の applyFn が clear する。
    // TASK-100: 山岳のクリック強調（ホバーの無いタッチ操作でも成立させる）。
    // 保持・解除規則は河川・勢力と同一（toggleMountainSelection /
    // togglePeakSelection）。山岳以外のクリックはキーが null になり解除される。
    applyTerrainSelection(
      toggleMountainSelection(selectedMountainName, mountainNameFromPick(info)),
      togglePeakSelection(selectedPeakName, peakNameFromPick(info)),
    );
    const layerId = info.layer?.id;
    if (isMountainPickLayerId(layerId) || isPeakPickLayerId(layerId)) {
      // 山岳のクリックは河川の選択を解除する（都市・勢力のクリックと同じ扱い）。
      applyRiverSelection(null);
      return;
    }
    if (isRiversPickLayerId(layerId) && info.object !== undefined) {
      const name = riverNameFor((info.object as Feature).properties);
      applyRiverSelection(toggleRiverSelection(selectedRiverName, name));
      return;
    }
    // 河川以外（都市マーカー・勢力ポリゴン・空白）のクリックは河川選択を解除する。
    applyRiverSelection(null);
  }

  return {
    // Deck レベルのイベントハンドラ（MapboxOverlay の onHover / onClick へ渡す）
    handlePickHover,
    handlePickClick,
    // picking 解決（debug_hooks.ts の __probePick 系が同じ経路を使う）
    resolveClickInfo,
    pickedLabel,
    // 選択/ホバー状態の読み取り用 getter（renderLayers の context 組み立てと
    // デバッグフックが読む。書き込みは handlePickHover / handlePickClick 経由のみ）
    selectedRiverName: () => selectedRiverName,
    hoveredRiverName: () => hoveredRiverName,
    selectedMountainName: () => selectedMountainName,
    hoveredMountainName: () => hoveredMountainName,
    selectedPeakName: () => selectedPeakName,
    hoveredPeakName: () => hoveredPeakName,
    extentKey,
  };
}

/** createPickHandlers の返り値型（main.ts の配線・テストで使う） */
export type PickHandlers = ReturnType<typeof createPickHandlers>;
