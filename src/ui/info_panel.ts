/**
 * ホバーツールチップとクリックパネルの DOM 配線（TASK-7/111, app-spec
 * §5.2。TASK-146 で main.ts から抽出、Issue #283 で案A へ作り替え）。
 *
 * decision-29 の方針どおり module-scope の可変状態は持たず、setupInfoUI が
 * ハンドル（showTooltip / hideTooltip / showInfoPanel）を返す。従来の
 * 「モジュールスコープの let フックへ実体を差し込む」パターンの置き換えで、
 * buildPowerLayer 等のレイヤー側は main.ts が受領したハンドルを参照する
 * （DOM 配線は 1 度だけ行う）。
 * - ツールチップ: onHover の {x, y} を使いカーソル近傍へ absolute 配置。
 *   object なしで非表示
 * - パネル: クリックで表示し続ける固定小パネル（右上）。閉じるボタンで非表示。
 *   1 行目が「名称 + 現在の年代（弱い文字）」、区切り線の下が一文要約
 *   （Issue #283 案A）。要素はすべて index.html にあり、ここでは中身を
 *   流し込むだけで DOM を増やさない
 * どちらも整形済みの値（displayLabel / InfoPanelContent）を受け取るだけにする。
 * DOM 要素欠如時は warn を出して no-op ハンドルへ縮退する（契約維持）。
 *
 * #283 AC5: 出典 / ライセンス / 境界 / コミットの欄はパネルから外した。確認先は
 * 上部の attribution（ⓘ）と既知の制限（⚠）で、データ側の `metadata` は
 * 従来どおり保持している（AC6）。
 */
import {
  type InfoPanelContent,
  panelYearText,
  tooltipPlacement,
} from "../info.ts";
import type { UiDocument } from "./dom.ts";

/** ツールチップ要素の最小形（HTMLElement が満たす） */
interface TooltipElement {
  textContent: string | null;
  hidden: boolean;
  style: { left: string; top: string };
  getBoundingClientRect(): { width: number; height: number };
}

/** パネル要素の最小形（HTMLElement が満たす） */
interface PanelElement {
  hidden: boolean;
}

/** パネルの名前 / 年代 / 説明の各行の最小形 */
interface PanelTextElement {
  textContent: string | null;
  hidden: boolean;
}

/** 閉じるボタンの最小形（HTMLButtonElement が満たす） */
interface PanelCloseElement {
  addEventListener(type: "click", listener: () => void): void;
}

/** setupInfoUI が返すハンドル。main.ts が picking ハンドラから呼ぶ */
export interface InfoUiHandle {
  showTooltip(label: string, x: number, y: number): void;
  hideTooltip(): void;
  showInfoPanel(content: InfoPanelContent): void;
}

/** setupInfoUI へ main.ts から注入する依存 */
export interface InfoUiDeps {
  doc: UiDocument;
  /** viewport の実寸（main.ts は globalThis.innerWidth/Height を渡す） */
  viewportSize(): { width: number; height: number };
}

/** 要素欠如時の縮退用 no-op ハンドル */
const NOOP_INFO_UI: InfoUiHandle = {
  showTooltip: () => {},
  hideTooltip: () => {},
  showInfoPanel: () => {},
};

/**
 * ホバーツールチップとクリックパネルの DOM を配線し、表示ハンドルを返す。
 */
export function setupInfoUI(deps: InfoUiDeps): InfoUiHandle {
  const { doc } = deps;
  const tooltip = doc.getElementById("info-tooltip") as TooltipElement | null;
  const panel = doc.getElementById("info-panel") as PanelElement | null;
  const panelLabel = doc.getElementById(
    "info-panel-label",
  ) as PanelTextElement | null;
  const panelYear = doc.getElementById(
    "info-panel-year",
  ) as PanelTextElement | null;
  const panelDescription = doc.getElementById(
    "info-panel-description",
  ) as PanelTextElement | null;
  const panelClose = doc.getElementById(
    "info-panel-close",
  ) as PanelCloseElement | null;
  if (
    !tooltip || !panel || !panelLabel || !panelYear || !panelDescription ||
    !panelClose
  ) {
    console.warn("情報表示 UI 要素が見つからないため配線をスキップします");
    return NOOP_INFO_UI;
  }

  // TASK-111: カーソル近傍への配置は tooltipPlacement（純粋関数）に委ね、ここは
  // 実測サイズの取得と style への反映だけを行う。hidden のままでは
  // getBoundingClientRect が 0 を返すので、先に表示してから測る。折り返し後の
  // 実寸が要るため、textContent の更新より後に測ることも必須。測る前に left/top を
  // 原点へ戻すのは、絶対配置の shrink-to-fit 幅が「左端から親の右端まで」の
  // 余白に依存し、前回の右寄り座標のままだと本来より狭く折り返された幅を
  // 測ってしまうため（配置後は left + width <= viewport なので再折り返しは起きない）。
  const showTooltip = (label: string, x: number, y: number): void => {
    tooltip.textContent = label;
    tooltip.style.left = "0px";
    tooltip.style.top = "0px";
    tooltip.hidden = false;
    const rect = tooltip.getBoundingClientRect();
    const { left, top } = tooltipPlacement(
      { x, y },
      { width: rect.width, height: rect.height },
      deps.viewportSize(),
    );
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };
  const hideTooltip = (): void => {
    tooltip.hidden = true;
  };

  /**
   * 任意の 1 行を流し込む。値が null なら**文字も消してから**畳む
   * （前の対象の年代・説明が畳んだ欄に残り、次に開いたとき一瞬見えるのを防ぐ）。
   * 説明欄は区切り線（border-top）を自分で持つので、畳めば空の区切り線も
   * 出ない（AC8）。
   */
  const setLine = (element: PanelTextElement, text: string | null): void => {
    element.textContent = text ?? "";
    element.hidden = text === null;
  };

  const showInfoPanel = (content: InfoPanelContent): void => {
    panelLabel.textContent = content.label;
    setLine(panelYear, panelYearText(content.year));
    setLine(panelDescription, content.description);
    panel.hidden = false;
  };

  panelClose.addEventListener("click", () => {
    panel.hidden = true;
  });

  return { showTooltip, hideTooltip, showInfoPanel };
}
