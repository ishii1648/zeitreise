/**
 * 折りたたみパネルの共通配線ファクトリ（TASK-53）。
 *
 * attribution フッター（TASK-26）と既知の制限一覧（TASK-46）で同型に複製
 * されていた「イベント → reducer → aria-expanded / hidden の同期」の配線を
 * 1 箇所に集約する。状態遷移そのものは footer.ts の reducer（純粋関数）を
 * そのまま使い、このモジュールはイベント購読と属性同期だけを担う。
 * - トグル click でトグル（native button なので Enter/Space は標準動作）
 * - root 外の document click / Escape キー / パネル内の閉じるボタンで
 *   折りたたみ（展開時のみ。閉じるボタンは #284 AC15）
 * - 配線直後に初期 render を 1 回実行（aria-expanded="false"・hidden=true）
 * - フォーカス管理（#284 AC17）: 展開直後は見出し（tabindex="-1"）へ
 *   フォーカスを移して読み上げ対象にし、Escape / 閉じるボタンで閉じたときは
 *   トグルへ戻す。外側クリックで閉じたときはユーザーのクリック先から
 *   フォーカスを奪わない
 *
 * DOM 型には直接依存せず、HTMLElement / document が構造的に満たす最小
 * インターフェースで受ける（Deno のユニットテストで fake を渡せるようにする）。
 * 「e.target が root 内か」の判定は、fake では `instanceof Node` が成立しない
 * ため注入可能な述語 containsTarget に寄せる（実呼び出し側の main.ts が
 * `target instanceof Node && root.contains(target)` を渡し、実 DOM での挙動は
 * 従来と変わらない）。
 */

import {
  ariaExpandedValue,
  createFooterState,
  type FooterEvent,
  isContentHidden,
  reduceFooterEvent,
} from "./footer.ts";

/** トグルボタンの最小インターフェース（HTMLButtonElement が満たす） */
export interface CollapsibleToggle {
  setAttribute(name: string, value: string): void;
  addEventListener(type: "click", listener: () => void): void;
}

/** 展開コンテンツの最小インターフェース（HTMLElement が満たす） */
export interface CollapsibleContent {
  hidden: boolean;
}

/** パネル見出しの最小インターフェース（tabindex="-1" の HTMLElement が満たす） */
export interface CollapsibleHeading {
  focus(): void;
}

/**
 * document 相当のイベント購読口の最小インターフェース（Document が満たす）。
 * 実呼び出し側は document を渡す。
 */
export interface CollapsibleEventSource {
  addEventListener(
    type: "click",
    listener: (event: { target: unknown }) => void,
  ): void;
  addEventListener(
    type: "keydown",
    listener: (event: { key: string }) => void,
  ): void;
}

/** wireCollapsiblePanel の配線対象一式 */
export interface CollapsiblePanelOptions {
  toggle: CollapsibleToggle;
  content: CollapsibleContent;
  /**
   * パネル見出し（#284 AC17）。展開直後にフォーカスを移し、スクリーン
   * リーダーの読み上げ対象にする。省略時はフォーカス移動しない。
   */
  heading?: CollapsibleHeading;
  /**
   * パネル内の明示的な閉じるボタン（#284 AC15）。click で折りたたみ、
   * returnFocus でトグルへフォーカスを戻す。省略時は配線しない。
   */
  closeButton?: CollapsibleToggle;
  /**
   * 折りたたみ時（Escape / 閉じるボタン / トグル）にフォーカスを戻す先
   * （#284 AC17。通常はトグルの focus()）。外側クリックでは呼ばない。
   */
  returnFocus?: () => void;
  /**
   * click の target がパネル root 内にあるかの述語（Node でない target は
   * false を返すこと）。展開中の root 外クリック（outside-click）の判定に
   * 使う。トグル自身のクリックは root 内なのでここでは処理せず、二重発火
   * しない（従来の setupFooter / setupKnownLimitationsUI と同じ）。
   */
  containsTarget: (target: unknown) => boolean;
  eventSource: CollapsibleEventSource;
}

/**
 * 折りたたみパネルを配線する。状態遷移は footer.ts の reducer に集約されて
 * いるため、ここでは「イベント → reducer → 属性同期」だけを行う。
 */
export function wireCollapsiblePanel(options: CollapsiblePanelOptions): void {
  const {
    toggle,
    content,
    heading,
    closeButton,
    returnFocus,
    containsTarget,
    eventSource,
  } = options;

  let state = createFooterState();

  /** 現在の状態を aria-expanded / hidden へ反映する */
  function render(): void {
    toggle.setAttribute("aria-expanded", ariaExpandedValue(state));
    content.hidden = isContentHidden(state);
  }

  function dispatch(event: FooterEvent): void {
    const wasExpanded = state.expanded;
    state = reduceFooterEvent(state, event);
    render();
    // #284 AC17: 展開直後は見出しへフォーカスを移して読み上げ対象にする。
    // Escape / 閉じるボタン / トグルで閉じたときはトグルへ戻す。外側クリック
    // ではユーザーのクリック先からフォーカスを奪わない。
    if (!wasExpanded && state.expanded) {
      heading?.focus();
    } else if (wasExpanded && !state.expanded && event !== "outside-click") {
      returnFocus?.();
    }
  }

  toggle.addEventListener("click", () => dispatch("toggle"));

  // パネル内の明示的な閉じるボタン（#284 AC15）。native button なので
  // Enter/Space は標準動作。未展開時は reducer が状態を変えない
  closeButton?.addEventListener("click", () => dispatch("close"));

  // 展開中に root 外をクリック/タップしたら折りたたむ。
  // expanded 判定を先に行うため、折りたたみ中は containsTarget に到達しない。
  eventSource.addEventListener("click", (e) => {
    if (!state.expanded) return;
    if (containsTarget(e.target)) return;
    dispatch("outside-click");
  });

  // Escape キーで折りたたむ（未展開時は reducer が状態を変えない）
  eventSource.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!state.expanded) return;
    dispatch("escape");
  });

  render();
}
