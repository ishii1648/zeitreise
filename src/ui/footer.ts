/**
 * attribution フッターの折りたたみ UI 配線（TASK-26。TASK-146 で main.ts
 * から抽出）。
 *
 * 状態遷移は footer.ts の reducer（純粋関数）、イベント購読と
 * aria-expanded / hidden の同期・フォーカス管理（#284 AC15/AC17: 展開直後は
 * 見出しへ、閉じたらトグルへ）は collapsible.ts の共通配線（TASK-53）に
 * 集約されており、ここでは要素の取得と root 内判定の注入だけを行う。
 * - ⓘボタン click でトグル（native button なので Enter/Space は標準動作。AC #4）
 * - フッター外の click / Escape キー / パネル内の閉じるボタンで折りたたみ
 *   （展開時のみ。AC #3 / #284 AC15）
 * DOM 要素欠如時は warn を出して配線をスキップする（契約維持）。
 */
import {
  type CollapsibleContent,
  type CollapsibleEventSource,
  type CollapsibleHeading,
  type CollapsibleToggle,
  wireCollapsiblePanel,
} from "../collapsible.ts";
import type { UiDocument } from "./dom.ts";

/** フッター root の最小形（HTMLElement が満たす。root 内判定に使う） */
interface FooterRootElement {
  contains(target: Node | null): boolean;
}

/** フォーカスを戻せるトグルの最小形（HTMLButtonElement が満たす） */
type FocusableToggle = CollapsibleToggle & { focus(): void };

/** setupFooter へ main.ts から注入する依存（document をそのまま渡す） */
export interface FooterDeps {
  doc: UiDocument & CollapsibleEventSource;
}

/** attribution フッターの折りたたみ UI を配線する */
export function setupFooter(deps: FooterDeps): void {
  const { doc } = deps;
  const footer = doc.getElementById("app-footer") as FooterRootElement | null;
  const toggle = doc.getElementById(
    "footer-toggle",
  ) as FocusableToggle | null;
  const content = doc.getElementById(
    "footer-content",
  ) as CollapsibleContent | null;
  const heading = doc.getElementById(
    "footer-heading",
  ) as CollapsibleHeading | null;
  const closeButton = doc.getElementById(
    "footer-close",
  ) as CollapsibleToggle | null;
  if (!footer || !toggle || !content || !heading || !closeButton) {
    console.warn("フッター UI 要素が見つからないため配線をスキップします");
    return;
  }

  // AC #1〜#4: 配線仕様（トグル / 外側 click / Escape / 閉じるボタン /
  // 属性同期 / フォーカス管理）は wireCollapsiblePanel に共通化した。
  // ⓘボタン自身のクリックは footer 内なので outside-click にならず、
  // 二重発火しない。
  // Node の存在確認は Deno（ユニットテスト実行時）に Node グローバルが無い
  // ための防御で、ブラウザでは常に成立し従来と同一挙動になる。
  wireCollapsiblePanel({
    toggle,
    content,
    heading,
    closeButton,
    returnFocus: () => toggle.focus(),
    containsTarget: (target) =>
      typeof Node !== "undefined" && target instanceof Node &&
      footer.contains(target),
    eventSource: doc,
  });
}
