/**
 * picking イベント処理（TASK-149 / Issue #167。main.ts から抽出）。
 *
 * Deck レベル onHover/onClick の実体（handlePickHover / handlePickClick）と、
 * picking 結果の解決（pickedLabel / pickedMetadata / resolveClickInfo）を
 * {@linkcode createPickHandlers} ファクトリに閉じ込める。
 *
 * decision-29 / docs/main-ts-inventory.md §2 U6 の方針:
 * - **選択/ホバー状態 7 変数（selectedRiverName / hoveredRiverName /
 *   selectedMountainName / hoveredMountainName / selectedPeakName /
 *   hoveredPeakName / extentKey）だけは、このファクトリの closure が所有する**
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
import { displayLabel, type InfoPanelContent } from "./info.ts";
import {
  powerDescriptionFor,
  type PowerDescriptionTable,
} from "./power_descriptions.ts";
import {
  BRITAIN_FIEF_LAYER_ID,
  CLIOPATRIA_FIEF_LAYER_ID,
  FRANCE_FIEF_LAYER_ID,
  HRE_LAYER_ID,
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
import { EMPTY_FEATURE_COLLECTION, powerFillDataForMode } from "./powers.ts";
import { politicalDetailVisibleAt } from "./labels.ts";
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
import {
  type CitiesData,
  type CityMarkerDatum,
  cityPickLabel,
  citySourceMetadata,
} from "./cities.ts";
import {
  suzerainExtentKey,
  type SuzerainOverrides,
} from "./suzerain_extent.ts";
import { powerHighlightKey } from "./power_highlight.ts";

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
 * feature 自身が持つ出典（properties.ATTRIBUTION）を取り出す（#202 / ADR-0033）。
 *
 * 出典の粒度は通常 FeatureCollection 単位（= レイヤー単位）だが、隣接年から
 * 流用した面は借用元と同じ系統のレイヤーへ載せるため、出典もライセンスも違う
 * feature が 1 枚のレイヤーに同居する（1492 年の hre-powers に OHM / CC0 の
 * 領邦と Roller / CC BY-NC-SA の大公領が並ぶ）。powers.ts の
 * mergeBorrowedFeatures が借用ファイルの metadata をここへ写しているので、
 * feature 側の出典があればそれを優先する。無ければ従来どおりレイヤーの出典。
 */
export function featureAttribution(object: unknown): unknown {
  const attribution = (object as
    | { properties?: { ATTRIBUTION?: unknown } | null }
    | null
    | undefined)?.properties?.ATTRIBUTION;
  return typeof attribution === "object" && attribution !== null
    ? attribution
    : undefined;
}

/**
 * 政治勢力（base 勢力 + 領邦・主権政体オーバーレイ）のレイヤー ID か（#283）。
 *
 * ラベル整形（pickedLabel）と年代別説明の参照（pickedPowerName）が同じ集合を
 * 見るように、判定を 1 箇所へ寄せる。ここに含まれない対象（河川・都市・
 * 山脈・山峰）は年代別の勢力説明を持たず、パネルは従来どおり名称だけになる
 * （AC9）。
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
 * ホバーを持たないタッチ操作では、タップで onHover（ツールチップ）と
 * onClick（情報パネル）が続けて発火し、同じラベルが 2 か所に出てしまう。
 * タッチ主体と判定したらツールチップを出さず、情報パネルだけに表示する。
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
 * pickedMetadata / extentKeyFromPick が読むものだけを構造的に要求する
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
 * createPickHandlers へ main.ts から注入する依存。選択/ホバー状態 7 変数
 * **以外**の状態所有は main.ts に残るため（decision-29）、ここでは getter・
 * コールバック・能力関数だけを受ける。
 */
export interface PickHandlerDeps {
  // ---- main.ts が所有するデータストア（getter 注入） ----
  getNameJa: () => Record<string, string>;
  getOverrides: () => SuzerainOverrides;
  /**
   * 年代別の勢力説明の参照表（#283。所有は main.ts、実体は
   * data/power-descriptions.json）。クリック情報パネルの一文要約を
   * 「表示年 × 補正後の内部名」で引くために読む。未ロード・取得失敗時は
   * 空の表が渡り、パネルは名称（+ 年代）だけへ縮退する。
   */
  getPowerDescriptions: () => PowerDescriptionTable;
  getCurrentView: () => PickYearView | null;
  /**
   * 現在の整数ズーム段（main.ts zoomStep。#228）。powers の picking 出典解決が
   * 表示モード（politicalDetailVisibleAt）を塗り側と共有するために読む。
   */
  getZoomStep: () => number;
  /**
   * 現在の表示年（#223）。都市の pick ラベル（cityPickLabel）が時代別都市名を
   * ラベル（buildCityLabelData）と同じ cityDisplayName(name, ja, year) で
   * 解決するために読む。
   */
  getYear: () => number;
  getRiversData: () => FeatureCollection;
  getMountainsData: () => FeatureCollection;
  getPeaksData: () => FeatureCollection;
  getCitiesData: () => CitiesData;

  // ---- 表示先（src/ui/info_panel.ts のハンドル。コールバック注入） ----
  showTooltip: (label: string, x: number, y: number) => void;
  hideTooltip: () => void;
  showInfoPanel: (content: InfoPanelContent) => void;

  /**
   * レイヤー再構築（main.ts renderLayers）。apply* の変化検知を通った
   * 「値が変わったとき」だけ呼ばれる（TASK-50 の規律）。
   */
  requestRender: () => void;

  /**
   * 政治ポリゴンの強調ストア（power_highlight.ts。所有は main.ts）。
   * 変化検知と再構築（onChange）はストア側が持つため、ここでは
   * hover / click のキーを流し込むだけでよい。
   */
  powerHighlight: {
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
   * 既存実装と完全に同一の挙動になる（#349 AC6）。実値の注入は #350（分割
   * 5/5）が `main.ts` の `createDetailFocusTracker`（suzerain_extent.ts、#345）
   * から行うため、本タスクの時点では `main.ts` は無変更。
   *
   * 返り値の `null` は「focus 機能はオンだが中央が海上・base 勢力外」= 詳細
   * 表示を行わない状態を意味する（省略とは意味が違う）。このとき領邦
   * オーバーレイは 1 枚も表示されないので、picking も全領邦を降格して全域を
   * 上位勢力単位で返す（#293 AC6 / #349 AC4）。
   */
  getDetailFocusKey?: () => string | null;
}

/**
 * picking イベント処理のハンドラ群と選択/ホバー状態を生成する（TASK-149）。
 *
 * main.ts はこれを起動時に 1 度だけ呼び、handlePickHover / handlePickClick を
 * MapboxOverlay の onHover / onClick へ渡す。選択/ホバー状態 7 変数は
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
   * ホバー/クリック中の勢力の「宗主キー」（TASK-94。null は外枠なし）。
   * この宗主に属する全 feature（本体 + 従属）の union が勢力圏の外枠として
   * 描かれる。判定は suzerain_extent.ts の suzerainExtentKey に委ねる。
   * TASK-30 の HRE 専用状態（hreHighlighted）を一般化したもの。
   */
  let extentKey: string | null = null;

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
      return displayLabel(
        feature.properties,
        deps.getOverrides().renames,
        nameJa,
      );
    }
    return null;
  }

  /**
   * picking 結果から、年代別説明を引くための**補正後の内部名**を解決する
   * （#283 AC7）。政治勢力レイヤー以外・NAME を持たない対象は null。
   *
   * 表示名（日本語）ではなく `NAME` を使うのは、`data/name-ja.json` の訳語を
   * 変えただけで説明との紐付けが壊れるのを避けるため。綴りゆれの正規化
   * （name-overrides.json の renames）は powerDescriptionFor が行うので、
   * ここでは生値のまま返す（displayLabel と同じ解決順）。
   */
  function pickedPowerName(info: PickingInfo): string | null {
    if (!isPowerPickLayerId(info.layer?.id)) return null;
    const name = (info.object as Feature | null | undefined)?.properties?.NAME;
    return typeof name === "string" && name !== "" ? name : null;
  }

  /**
   * クリック情報パネルの表示内容を組み立てる（#283 案A）。
   *
   * 政治勢力なら「名称 + 現在の年代 + その年代の一文要約」、それ以外
   * （河川・都市・山脈・山峰）は従来どおり名称だけ（year / description は
   * null）。説明が未登録なら description だけが null になり、パネル側が
   * 説明欄ごと畳む（AC8）。
   */
  function panelContent(info: PickingInfo, label: string): InfoPanelContent {
    const name = pickedPowerName(info);
    if (name === null) return { label, year: null, description: null };
    const year = deps.getYear();
    return {
      label,
      year,
      description: powerDescriptionFor(
        deps.getPowerDescriptions(),
        year,
        name,
        deps.getOverrides().renames,
      ),
    };
  }

  /**
   * picking 結果から、その feature が属するデータセットの `metadata` を解決する
   * （TASK-109）。pickedLabel と同じレイヤー ID の分岐で、ラベルと出典が必ず
   * 同じデータ由来になるようにする。metadata の中身は解釈せず、整形は info.ts の
   * sourceLines（純粋関数）に委ねる。
   *
   * 対象外レイヤー・picking なし・未ロードは undefined = 出典欄を出さない。
   */
  function pickedMetadata(info: PickingInfo): unknown {
    const layerId = info.layer?.id;
    if (layerId === undefined) return undefined;
    if (isMountainPickLayerId(layerId)) {
      return collectionMetadata(deps.getMountainsData());
    }
    if (isPeakPickLayerId(layerId)) {
      return collectionMetadata(deps.getPeaksData());
    }
    if (isCityPickLayerId(layerId)) {
      // #222 AC6: cities.json は複数ソース（Buringh 主 + Chandler 補完）を
      // 持つため、picking された都市の source index（CityMarkerDatum.source）で
      // 都市ごとの出典レコードへ解決する。index 不明・不正形はデータセット
      // 全体の metadata（主ソース）へフォールバックする。
      const source = (info.object as { source?: unknown } | null | undefined)
        ?.source;
      return citySourceMetadata(
        deps.getCitiesData(),
        typeof source === "number" && Number.isInteger(source) ? source : null,
      );
    }
    if (isRiversPickLayerId(layerId)) {
      return collectionMetadata(deps.getRiversData());
    }
    // #202 / ADR-0033: 隣接年から流用した面は、載っているレイヤーの出典では
    // なく借用元の出典を持つ（1 枚のレイヤーに 2 出典が同居する）。feature 側の
    // 出典があれば常にそちらを優先し、無ければ従来のレイヤー分岐へ落ちる。
    const borrowed = featureAttribution(info.object);
    if (borrowed !== undefined) return borrowed;
    const currentView = deps.getCurrentView();
    if (currentView === null) return undefined;
    if (layerId === POWER_LAYER_ID) {
      // TASK-92 の派生 base（baseFill）を塗っている年は、picking もその FC を
      // 返す。派生物は base から切り出しただけで出典は同じなので、派生側に
      // metadata が無ければ base のものへフォールバックする。
      // #228: 概観（z4）では塗りが素の base に切り替わるため、出典も同じ
      // 選択関数（powerFillDataForMode）を通して表示と食い違わないようにする。
      //
      // #349: 詳細表示 focus でも同じ関数を通す方針は変わらない。#293 分割 2/5
      // （#347）が powerFillDataForMode へ focus 引数を足したら、ここに
      // deps.getDetailFocusKey?.() を渡して塗りと出典の合成を一致させる。
      // それまでは focus を渡さず既存の 3 引数のまま呼ぶ。focus 合成後の塗りは
      // base と baseFill の feature を選び分けた合成でしかなく、どちらも出典は
      // 同じ base 由来（下の ?? currentView.base フォールバックが受ける）ため、
      // この暫定でも出典表示は表示と食い違わない。
      const fill = powerFillDataForMode(
        currentView.base,
        currentView.baseFill,
        politicalDetailVisibleAt(deps.getZoomStep()),
      );
      return collectionMetadata(fill) ?? collectionMetadata(currentView.base);
    }
    if (layerId === HRE_LAYER_ID) return collectionMetadata(currentView.hre);
    if (layerId === FRANCE_FIEF_LAYER_ID) {
      return collectionMetadata(currentView.fiefs);
    }
    if (layerId === ITALY_FIEF_LAYER_ID) {
      return collectionMetadata(currentView.italyFiefs);
    }
    // TASK-110: Cliopatria 由来の領邦だけが別出典（CC BY 4.0）。レイヤーを
    // 分けてあるので、この 1 行で AC #3（クリックで出典が出て OHM 由来と
    // 区別できる）が成立する。metadata の中身は解釈せず sourceLines に委ねる。
    if (layerId === CLIOPATRIA_FIEF_LAYER_ID) {
      return collectionMetadata(currentView.cliopatriaFiefs);
    }
    // #172: ブリテン諸島の政体はレイヤー単位で OHM（CC0）の出典を引く
    // （britain_fiefs_flat_* の metadata。AC #5 の出典・ライセンス表示）。
    if (layerId === BRITAIN_FIEF_LAYER_ID) {
      return collectionMetadata(currentView.britainFiefs);
    }
    // #189: 主権政体オーバーレイもレイヤー単位で OHM（CC0）の出典を引く
    // （sovereign_fiefs_flat_* の metadata）。
    if (layerId === SOVEREIGN_FIEF_LAYER_ID) {
      return collectionMetadata(currentView.sovereignFiefs);
    }
    return undefined;
  }

  /**
   * picking 結果から、外枠を出すべき宗主キーを解決する（TASK-94 / TASK-120）。
   * 判定本体は suzerain_extent.ts の suzerainExtentKey（純粋関数）。都市マーカーの
   * picking 結果は GeoJSON Feature ではないが、suzerainExtentKey がレイヤー ID
   * を先に見るため feature でなくても安全に null になる。
   *
   * TASK-120: 諸侯領オーバーレイは「封土を包含する base 勢力」で宗主キーを
   * 決めるため base も渡す。包含判定は polylabel（labelAnchorFor）と
   * point-in-polygon で mousemove 1 回あたり 1ms 未満だが、同じ封土の上を
   * 動く間の再計算まで避けるため memoizeLatest で 1 スロットだけ覚える
   * （TASK-50 の規律。picking 結果の object は data 配列の feature そのもので
   * 参照が安定しているため、同一封土の連続ホバーは必ずキャッシュに当たる）。
   */
  const memoizedExtentKey = memoizeLatest(suzerainExtentKey);

  /**
   * 近傍再ピック（resolveClickInfo）へ渡す詳細表示 focus を組み立てる
   * （#349 / #293 分割 4/5）。
   *
   * `deps.getDetailFocusKey` が注入されていなければ null = focus 機能オフで、
   * `resolveClickPick` は既存とまったく同じ経路を通る（AC6）。
   *
   * 領邦候補の宗主キー解決は **勢力圏の外枠と同じ純粋関数**
   * （suzerain_extent.ts `suzerainExtentKey`）に委ねる。宣言宗主（`SUBJECTO`）
   * を持つ HRE 領邦と、base の包含で決まる仏・伊・ブリテン・主権政体の両方を
   * 1 本の規則で扱えるうえ、#293 分割 3/5 のオーバーレイ絞り込み
   * （`containingSuzerainKey`）と同じ分類になるため「表示されている領邦だけが
   * pickable」が成り立つ。
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
      suzerainKeyOf: (layerId, object) =>
        suzerainExtentKey(
          layerId,
          object as Feature | undefined,
          base,
          overrides,
        ),
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

  /**
   * 勢力圏の外枠の対象（宗主キー）を更新し、変化があればレイヤーを再構築する。
   * キー単位の変化検知なので、同じ宗主の別 feature へホバーが移っても
   * requestRender は呼ばれない（TASK-50 の規律）。
   */
  function applyExtentKey(next: string | null): void {
    if (next === extentKey) return;
    extentKey = next;
    deps.requestRender();
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
   * タッチではタップが onHover → onClick と連続発火して情報パネルと二重表示に
   * なるため、タッチ主体（suppressHoverTooltip: pick イベントの pointerType が
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
    // TASK-30 / TASK-94: 勢力（宗主・封臣のいずれ）のホバーでその勢力圏の外枠を
    // 出し、ホバー解除（picking なし・対象外レイヤー）で通常表示へ戻す
    applyExtentKey(extentKeyFromPick(info));
    // TASK-90: 勢力・領邦のホバー強調。河川・都市・何も無い場所のホバーでは
    // キーが null になり強調が解除される（AC #2/#6）。判定経路は
    // extentKeyFromPick と同型（同じ info から純粋関数でキーを解決する）。
    deps.powerHighlight.hover(powerHighlightKeyFromPick(info));
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
   * - 河川ライン: 選択をトグルし、選択時は情報パネルに河川名を表示
   * - 勢力ポリゴン: 従来どおり勢力ラベルをパネル表示し、河川選択は解除
   * - 何も無い場所: 河川選択を解除（Deck の onClick は picking なしでも
   *   layer: null の info で呼ばれることを @deck.gl/core の実装で確認済み）
   * TASK-36: Deck onClick が渡す単一 info をそのまま使わず、まず
   * resolveClickInfo で半径内の河川優先の選び直しを行う。
   */
  function handlePickClick(rawInfo: PickingInfo): void {
    const info = resolveClickInfo(rawInfo);
    // TASK-30 / TASK-94: クリックでも勢力圏の外枠を反映する（デスクトップでは
    // ホバー経路で既に反映済みだが、ホバーの無いタッチ操作でも成立させる。
    // 河川・都市・空白のクリックはキー null に倒れて外枠が消える）
    applyExtentKey(extentKeyFromPick(info));
    // TASK-90: 勢力・領邦のクリック強調（ホバーの無いタッチ操作でも成立させる）。
    // 保持・解除規則は power_highlight.ts togglePowerSelection（河川の選択トグルと
    // 同一規則）: 同一対象の再クリックで解除・別対象で移動・河川/都市/空クリック
    // （キー null）で解除。年代切替では yearSwitcher の applyFn が clear する。
    deps.powerHighlight.click(powerHighlightKeyFromPick(info));
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
      // パネルは「選択が残っているとき」だけ更新する: 同じ対象の再クリックは
      // 強調を解除する操作なので、そこでパネルだけ出続けると状態が食い違う
      // （河川と同一規則）。
      applyRiverSelection(null);
      if (selectedMountainName !== null || selectedPeakName !== null) {
        const label = pickedLabel(info);
        if (label !== null) {
          deps.showInfoPanel(panelContent(info, label));
        }
      }
      return;
    }
    if (isRiversPickLayerId(layerId) && info.object !== undefined) {
      const name = riverNameFor((info.object as Feature).properties);
      applyRiverSelection(toggleRiverSelection(selectedRiverName, name));
      if (selectedRiverName !== null) {
        const label = pickedLabel(info);
        if (label !== null) {
          deps.showInfoPanel(panelContent(info, label));
        }
      }
      return;
    }
    // 河川以外（都市マーカー・勢力ポリゴン・空白）のクリックは河川選択を解除し、
    // picking があれば整形済みラベル（都市名/勢力名）をパネルへ出す（TASK-27）
    applyRiverSelection(null);
    const label = pickedLabel(info);
    if (label !== null) {
      deps.showInfoPanel(panelContent(info, label));
    }
  }

  return {
    // Deck レベルのイベントハンドラ（MapboxOverlay の onHover / onClick へ渡す）
    handlePickHover,
    handlePickClick,
    // picking 解決（debug_hooks.ts の __probePick 系が同じ経路を使う）
    resolveClickInfo,
    pickedLabel,
    pickedMetadata,
    // #283: 年代別説明の解決（テスト・デバッグフックが同じ経路を使う）
    pickedPowerName,
    panelContent,
    // 選択/ホバー状態の読み取り用 getter（renderLayers の context 組み立てと
    // デバッグフックが読む。書き込みは handlePickHover / handlePickClick 経由のみ）
    selectedRiverName: () => selectedRiverName,
    hoveredRiverName: () => hoveredRiverName,
    selectedMountainName: () => selectedMountainName,
    hoveredMountainName: () => hoveredMountainName,
    selectedPeakName: () => selectedPeakName,
    hoveredPeakName: () => hoveredPeakName,
    extentKey: () => extentKey,
  };
}

/** createPickHandlers の返り値型（main.ts の配線・テストで使う） */
export type PickHandlers = ReturnType<typeof createPickHandlers>;
