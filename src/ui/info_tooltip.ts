/**
 * ホバーツールチップの DOM 配線（TASK-7/111、app-spec §5.2）。
 *
 * decision-29 の方針どおり module-scope の可変状態は持たず、setupInfoTooltip が
 * 表示・非表示用のハンドルを返す。表示内容は呼び出し側で整形済みのラベルだけを
 * 受け取り、DOM 要素が無い場合は warn を出して no-op へ縮退する。
 */
import { tooltipPlacement } from "../info.ts";
import type { UiDocument } from "./dom.ts";

/** ツールチップ要素の最小形（HTMLElement が満たす） */
interface TooltipElement {
  textContent: string | null;
  hidden: boolean;
  style: { left: string; top: string };
  getBoundingClientRect(): { width: number; height: number };
}

/** setupInfoTooltip が返すハンドル */
export interface InfoTooltipHandle {
  show(label: string, x: number, y: number): void;
  hide(): void;
}

/** setupInfoTooltip へ main.ts から注入する依存 */
export interface InfoTooltipDeps {
  doc: UiDocument;
  /** viewport の実寸（main.ts は globalThis.innerWidth/Height を渡す） */
  viewportSize(): { width: number; height: number };
}

/** 要素欠如時の縮退用 no-op ハンドル */
const NOOP_INFO_TOOLTIP: InfoTooltipHandle = {
  show: () => {},
  hide: () => {},
};

/** ホバーツールチップの DOM を配線し、表示ハンドルを返す。 */
export function setupInfoTooltip(deps: InfoTooltipDeps): InfoTooltipHandle {
  const tooltip = deps.doc.getElementById(
    "info-tooltip",
  ) as TooltipElement | null;
  if (!tooltip) {
    console.warn(
      "情報ツールチップ要素が見つからないため配線をスキップします",
    );
    return NOOP_INFO_TOOLTIP;
  }

  // hidden のままでは getBoundingClientRect が 0 を返すため、内容と原点を
  // 反映してから表示・計測する。原点へ戻すことで、前回座標による
  // shrink-to-fit 幅への影響も除く（TASK-111）。
  const show = (label: string, x: number, y: number): void => {
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

  const hide = (): void => {
    tooltip.hidden = true;
  };

  return { show, hide };
}
