/**
 * Safe Area inset エミュレーションの純ロジック（Issue #256）。
 *
 * ヘッドレス Chrome では env(safe-area-inset-*) が常に 0 のため、実機の
 * ノッチ・ホームインジケーター条件を CDP から直接は再現できない
 * （Emulation ドメインに inset の override は無い）。app.css は inset を
 * :root の CSS カスタムプロパティ（--safe-area-bottom/left/right =
 * env(safe-area-inset-*, 0px)）として一元定義しているので、検証ハーネスは
 * documentElement のインラインスタイルでこの変数を上書きして inset を注入する。
 *
 * 限界: env() → 変数の橋渡し（:root の定義そのもの）はこの方法では検証
 * できない。その部分は src/safe_area_test.ts の CSS 構造テストが「変数定義が
 * 存在し、消費側が env() を直接書いていない」ことを固定して補完する。
 *
 * inset の代表値は iPhone 12〜14 系（MOBILE_PRESET / LANDSCAPE_PRESET と
 * 同一端末）の実測値: 縦持ち bottom 34px（ホームインジケーター）、横持ち
 * left/right 47px（ノッチ側とその反対側）+ bottom 21px。
 */
import type { UiRect } from "./mobile-smoke.ts";

/** Safe Area inset（px）。top は本 Issue のスコープ外だが値としては持つ。 */
export interface SafeAreaInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** 縦持ちノッチ端末の代表値（iPhone 12〜14 系）。 */
export const PORTRAIT_NOTCH_INSETS: SafeAreaInsets = {
  top: 47,
  right: 0,
  bottom: 34,
  left: 0,
};

/** 横持ちノッチ端末の代表値（iPhone 12〜14 系）。 */
export const LANDSCAPE_NOTCH_INSETS: SafeAreaInsets = {
  top: 0,
  right: 47,
  bottom: 21,
  left: 47,
};

/** app.css が :root に定義する Safe Area 変数名（上書き・解除の対象）。 */
export const SAFE_AREA_CSS_VARS = [
  "--safe-area-bottom",
  "--safe-area-left",
  "--safe-area-right",
] as const;

/**
 * documentElement のインラインスタイルで Safe Area 変数を上書きする評価式を
 * 組み立てる（inset 注入）。top は app.css が参照しないため注入しない。
 */
export function buildSetSafeAreaInsetsExpr(insets: SafeAreaInsets): string {
  return `(() => {
  const s = document.documentElement.style;
  s.setProperty("--safe-area-bottom", "${insets.bottom}px");
  s.setProperty("--safe-area-left", "${insets.left}px");
  s.setProperty("--safe-area-right", "${insets.right}px");
})()`;
}

/** Safe Area 変数の上書きを全て解除する評価式を組み立てる（inset 0 へ復帰）。 */
export function buildClearSafeAreaInsetsExpr(): string {
  const removes = SAFE_AREA_CSS_VARS.map((name) =>
    `  s.removeProperty("${name}");`
  ).join("\n");
  return `(() => {
  const s = document.documentElement.style;
${removes}
})()`;
}

/** Safe Area 違反 1 件。要素が inset 帯（非安全領域）へ入っている。 */
export interface SafeAreaViolation {
  readonly selector: string;
  readonly edge: "left" | "right" | "bottom";
  /** inset 帯への進入量（px） */
  readonly overflowPx: number;
}

/** サブピクセル丸めを違反扱いしない許容誤差（px）。 */
export const SAFE_AREA_TOLERANCE_PX = 1;

/**
 * 可視 UI 要素の矩形群から、Safe Area の inset 帯（左・右・下端の非安全
 * 領域）へ入っているものを列挙する純粋関数（safe-area_test.ts でユニット
 * テストする）。top 帯は検査しない（#256 のスコープは bottom/left/right。
 * AC3 の各 inset 条件に対応）。
 */
export function findSafeAreaViolations(
  rects: readonly UiRect[],
  viewport: { width: number; height: number },
  insets: SafeAreaInsets,
  tolerancePx: number = SAFE_AREA_TOLERANCE_PX,
): SafeAreaViolation[] {
  const violations: SafeAreaViolation[] = [];
  for (const { selector, rect } of rects) {
    const leftOverflow = insets.left - rect.left;
    if (leftOverflow > tolerancePx) {
      violations.push({ selector, edge: "left", overflowPx: leftOverflow });
    }
    const rightOverflow = rect.right - (viewport.width - insets.right);
    if (rightOverflow > tolerancePx) {
      violations.push({ selector, edge: "right", overflowPx: rightOverflow });
    }
    const bottomOverflow = rect.bottom - (viewport.height - insets.bottom);
    if (bottomOverflow > tolerancePx) {
      violations.push({ selector, edge: "bottom", overflowPx: bottomOverflow });
    }
  }
  return violations;
}
