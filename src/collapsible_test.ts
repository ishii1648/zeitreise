import { assert, assertEquals, assertFalse } from "@std/assert";
import { wireCollapsiblePanel } from "./collapsible.ts";

/**
 * wireCollapsiblePanel のユニットテスト（TASK-53）。
 * DOM 実体を使わず、collapsible.ts が要求する最小インターフェースを満たす
 * fake を渡して「イベント → reducer → aria-expanded / hidden の同期」の
 * 配線仕様（setupFooter / setupKnownLimitationsUI と同一挙動）を検証する。
 */

/** トグルボタンの fake（属性と click リスナーを記録する） */
class FakeToggle {
  attributes = new Map<string, string>();
  private clickListeners: Array<() => void> = [];

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(_type: "click", listener: () => void): void {
    this.clickListeners.push(listener);
  }

  /** トグルボタンのクリックを模倣する */
  click(): void {
    for (const listener of this.clickListeners) listener();
  }
}

/** document 相当の fake（click / keydown リスナーを記録・発火する） */
class FakeEventSource {
  private clickListeners: Array<(event: { target: unknown }) => void> = [];
  private keydownListeners: Array<(event: { key: string }) => void> = [];

  addEventListener(
    type: "click",
    listener: (event: { target: unknown }) => void,
  ): void;
  addEventListener(
    type: "keydown",
    listener: (event: { key: string }) => void,
  ): void;
  addEventListener(
    type: "click" | "keydown",
    listener:
      | ((event: { target: unknown }) => void)
      | ((event: { key: string }) => void),
  ): void {
    if (type === "click") {
      this.clickListeners.push(
        listener as (event: { target: unknown }) => void,
      );
    } else {
      this.keydownListeners.push(listener as (event: { key: string }) => void);
    }
  }

  /** document への click を模倣する */
  dispatchClick(target: unknown): void {
    for (const listener of this.clickListeners) listener({ target });
  }

  /** document への keydown を模倣する */
  dispatchKeydown(key: string): void {
    for (const listener of this.keydownListeners) listener({ key });
  }
}

/** パネル見出しの fake（focus の呼び出し回数を記録する。#284 AC17） */
class FakeHeading {
  focusCount = 0;

  focus(): void {
    this.focusCount++;
  }
}

/** fake 一式を組み立てて wireCollapsiblePanel を配線する */
function setup() {
  const toggle = new FakeToggle();
  const content = { hidden: false };
  const eventSource = new FakeEventSource();
  const heading = new FakeHeading();
  const closeButton = new FakeToggle();
  let returnFocusCount = 0;
  // root 内判定の fake: この Set に入っている target だけ「root 内」とみなす
  const insideTargets = new Set<unknown>();
  const containsCalls: unknown[] = [];
  wireCollapsiblePanel({
    toggle,
    content,
    heading,
    closeButton,
    returnFocus: () => {
      returnFocusCount++;
    },
    containsTarget: (target) => {
      containsCalls.push(target);
      return insideTargets.has(target);
    },
    eventSource,
  });
  return {
    toggle,
    content,
    eventSource,
    heading,
    closeButton,
    returnFocusCount: () => returnFocusCount,
    insideTargets,
    containsCalls,
  };
}

function assertCollapsed(
  toggle: FakeToggle,
  content: { hidden: boolean },
): void {
  assertEquals(toggle.attributes.get("aria-expanded"), "false");
  assert(content.hidden);
}

function assertExpanded(
  toggle: FakeToggle,
  content: { hidden: boolean },
): void {
  assertEquals(toggle.attributes.get("aria-expanded"), "true");
  assertFalse(content.hidden);
}

Deno.test("配線直後に初期 render が走る（折りたたみ・aria-expanded=false）", () => {
  const { toggle, content } = setup();
  assertCollapsed(toggle, content);
});

Deno.test("トグル click で展開し、aria-expanded / hidden が同期する", () => {
  const { toggle, content } = setup();
  toggle.click();
  assertExpanded(toggle, content);
});

Deno.test("トグル click 2 回で折りたたみに戻る", () => {
  const { toggle, content } = setup();
  toggle.click();
  toggle.click();
  assertCollapsed(toggle, content);
});

Deno.test("展開中の外側クリックで折りたたむ", () => {
  const { toggle, content, eventSource } = setup();
  toggle.click();
  eventSource.dispatchClick("outside-node");
  assertCollapsed(toggle, content);
});

Deno.test("展開中でも root 内のクリックでは折りたたまない", () => {
  const { toggle, content, eventSource, insideTargets } = setup();
  const insideNode = { name: "inside" };
  insideTargets.add(insideNode);
  toggle.click();
  eventSource.dispatchClick(insideNode);
  assertExpanded(toggle, content);
});

Deno.test("未展開時の外側クリックでは何も起きない（root 内判定も呼ばない）", () => {
  const { toggle, content, eventSource, containsCalls } = setup();
  eventSource.dispatchClick("outside-node");
  assertCollapsed(toggle, content);
  // 既存実装（setupFooter）は expanded 判定を先に行うため、折りたたみ中は
  // root 内判定（e.target instanceof Node && root.contains(...)）に到達しない
  assertEquals(containsCalls.length, 0);
});

Deno.test("展開中の Escape キーで折りたたむ", () => {
  const { toggle, content, eventSource } = setup();
  toggle.click();
  eventSource.dispatchKeydown("Escape");
  assertCollapsed(toggle, content);
});

Deno.test("未展開時の Escape キーでは何も起きない", () => {
  const { toggle, content, eventSource } = setup();
  eventSource.dispatchKeydown("Escape");
  assertCollapsed(toggle, content);
});

Deno.test("Escape 以外のキーでは折りたたまない", () => {
  const { toggle, content, eventSource } = setup();
  toggle.click();
  eventSource.dispatchKeydown("Enter");
  assertExpanded(toggle, content);
});

// ---- #284 AC15/AC17: 閉じるボタンとフォーカス管理 ----

Deno.test("展開直後に見出しへフォーカスが移る（#284 AC17: 読み上げ対象）", () => {
  const { toggle, heading } = setup();
  assertEquals(heading.focusCount, 0);
  toggle.click();
  assertEquals(heading.focusCount, 1);
});

Deno.test("折りたたみ時には見出しへフォーカスを移さない", () => {
  const { toggle, heading } = setup();
  toggle.click();
  toggle.click();
  assertEquals(heading.focusCount, 1);
});

Deno.test("閉じるボタン click で折りたたむ（#284 AC15）", () => {
  const { toggle, content, closeButton } = setup();
  toggle.click();
  closeButton.click();
  assertCollapsed(toggle, content);
});

Deno.test("閉じるボタンで閉じるとトグルへフォーカスが戻る（#284 AC17）", () => {
  const { toggle, closeButton, returnFocusCount } = setup();
  toggle.click();
  assertEquals(returnFocusCount(), 0);
  closeButton.click();
  assertEquals(returnFocusCount(), 1);
});

Deno.test("Escape で閉じたときもトグルへフォーカスが戻る（#284 AC17）", () => {
  const { toggle, eventSource, returnFocusCount } = setup();
  toggle.click();
  eventSource.dispatchKeydown("Escape");
  assertEquals(returnFocusCount(), 1);
});

Deno.test("外側クリックで閉じたときはフォーカスを奪わない", () => {
  const { toggle, eventSource, returnFocusCount } = setup();
  toggle.click();
  eventSource.dispatchClick("outside-node");
  assertEquals(returnFocusCount(), 0);
});

Deno.test("未展開時の閉じるボタン click では何も起きない", () => {
  const { toggle, content, closeButton, returnFocusCount } = setup();
  closeButton.click();
  assertCollapsed(toggle, content);
  assertEquals(returnFocusCount(), 0);
});

Deno.test("heading / closeButton / returnFocus 省略時も従来どおり配線できる", () => {
  const toggle = new FakeToggle();
  const content = { hidden: false };
  const eventSource = new FakeEventSource();
  wireCollapsiblePanel({
    toggle,
    content,
    containsTarget: () => false,
    eventSource,
  });
  toggle.click();
  assertExpanded(toggle, content);
  eventSource.dispatchKeydown("Escape");
  assertCollapsed(toggle, content);
});
