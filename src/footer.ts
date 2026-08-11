/**
 * attribution フッターの折りたたみ状態（TASK-26）。DOM 非依存の純粋ロジック。
 *
 * 未展開時は小さなトグルボタン（ⓘ）だけを常時表示し、クリック/タップ/
 * キーボード操作で attribution 全文の表示/非表示を切り替える。
 * - toggle: ボタン操作。展開状態を反転する
 * - outside-click: フッター外のクリック。展開時のみ折りたたむ
 * - escape: Escape キー。展開時のみ折りたたむ
 * - close: パネル内の明示的な閉じるボタン。展開時のみ折りたたむ（#284 AC15）
 *
 * DOM への反映（aria-expanded / hidden）は導出用の純粋関数で行い、
 * main.ts の setupFooter は「イベント → reducer → 属性同期」に徹する。
 */

/** フッターの折りたたみ状態 */
export interface FooterState {
  /** attribution 全文が展開表示されているか */
  readonly expanded: boolean;
}

/** フッターへのユーザー操作イベント */
export type FooterEvent = "toggle" | "outside-click" | "escape" | "close";

/** 初期状態を作る（AC #1: 起動時は折りたたみで全文は隠れている） */
export function createFooterState(): FooterState {
  return { expanded: false };
}

/**
 * イベントから次状態を導く純粋関数。元の state は破壊しない。
 * outside-click / escape / close は「閉じる」専用で、未展開時は状態を変えない
 * （折りたたみ状態のフッターが外側クリックで勝手に開かないことを保証する）。
 */
export function reduceFooterEvent(
  state: FooterState,
  event: FooterEvent,
): FooterState {
  switch (event) {
    case "toggle":
      return { expanded: !state.expanded };
    case "outside-click":
    case "escape":
    case "close":
      return { expanded: false };
  }
}

/** トグルボタンの aria-expanded 属性値を導出する（AC #4） */
export function ariaExpandedValue(state: FooterState): "true" | "false" {
  return state.expanded ? "true" : "false";
}

/** attribution 全文コンテナの hidden 属性値を導出する（AC #1/#2） */
export function isContentHidden(state: FooterState): boolean {
  return !state.expanded;
}
