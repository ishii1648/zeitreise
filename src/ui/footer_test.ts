/**
 * footer.ts（src/ui/）のユニットテスト（TASK-146）。
 *
 * 検証する契約:
 * - setupFooter が要素を引いて wireCollapsiblePanel（TASK-53）へ配線すること
 *   （トグル / Escape / aria-expanded / hidden 同期は collapsible_test.ts が
 *   網羅済みなので、ここでは配線されていることだけを確認する）
 * - DOM 要素欠如時は warn（文言固定）を出して配線をスキップすること
 *
 * outside-click の root 内判定（`target instanceof Node`）は実 DOM 依存のため
 * ユニットテストでは扱わず、ヘッドレス CDP 検証で担保する。
 */
import { assert, assertEquals, assertFalse } from "@std/assert";
import { setupFooter } from "./footer.ts";
import { captureWarns, FakeDocument } from "./fake_dom.ts";

function setup() {
  const doc = new FakeDocument();
  const footer = doc.addElement("app-footer");
  const toggle = doc.addElement("footer-toggle");
  const content = doc.addElement("footer-content");
  const heading = doc.addElement("footer-heading");
  const closeButton = doc.addElement("footer-close");
  setupFooter({ doc });
  return { doc, footer, toggle, content, heading, closeButton };
}

Deno.test("要素欠如時は warn を出して配線をスキップする（文言固定）", () => {
  const doc = new FakeDocument();
  const { warns } = captureWarns(() => setupFooter({ doc }));
  assertEquals(warns, [
    "フッター UI 要素が見つからないため配線をスキップします",
  ]);
});

Deno.test("配線直後は折りたたみ状態（aria-expanded=false / hidden）", () => {
  const { toggle, content } = setup();
  assertEquals(toggle.attributes.get("aria-expanded"), "false");
  assert(content.hidden);
});

Deno.test("トグル click で展開し、aria-expanded / hidden が同期する", () => {
  const { toggle, content } = setup();
  toggle.click();
  assertEquals(toggle.attributes.get("aria-expanded"), "true");
  assertFalse(content.hidden);
});

Deno.test("展開中の Escape キー（document 宛）で折りたたむ", () => {
  const { doc, toggle, content } = setup();
  toggle.click();
  doc.dispatchKeydown("Escape");
  assertEquals(toggle.attributes.get("aria-expanded"), "false");
  assert(content.hidden);
});

// ---- #284 AC15/AC17: 見出し・閉じるボタン・フォーカス管理 ----

Deno.test("展開直後に見出しへフォーカスが移る（#284 AC17）", () => {
  const { toggle, heading } = setup();
  toggle.click();
  assertEquals(heading.focusCount, 1);
});

Deno.test("閉じるボタン click で折りたたみ、トグルへフォーカスが戻る（#284 AC15/AC17）", () => {
  const { toggle, content, closeButton } = setup();
  toggle.click();
  closeButton.click();
  assert(content.hidden);
  assertEquals(toggle.focusCount, 1);
});

Deno.test("Escape で閉じたときもトグルへフォーカスが戻る（#284 AC17）", () => {
  const { doc, toggle } = setup();
  toggle.click();
  doc.dispatchKeydown("Escape");
  assertEquals(toggle.focusCount, 1);
});
