import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  ariaExpandedValue,
  createFooterState,
  type FooterState,
  isContentHidden,
  reduceFooterEvent,
} from "./footer.ts";

/** 初期状態は折りたたみ（AC #1: 未展開時は全文が隠れている） */
Deno.test("createFooterState は折りたたみ状態で始まる", () => {
  const s = createFooterState();
  assertFalse(s.expanded);
});

Deno.test("toggle は expanded を反転する（折りたたみ→展開）", () => {
  const s = reduceFooterEvent(createFooterState(), "toggle");
  assert(s.expanded);
});

Deno.test("toggle は expanded を反転する（展開→折りたたみ）", () => {
  const expanded: FooterState = { expanded: true };
  const s = reduceFooterEvent(expanded, "toggle");
  assertFalse(s.expanded);
});

Deno.test("outside-click は展開時のみ折りたたむ", () => {
  const expanded: FooterState = { expanded: true };
  const s = reduceFooterEvent(expanded, "outside-click");
  assertFalse(s.expanded);
});

Deno.test("outside-click は未展開時には状態を変えない", () => {
  const collapsed = createFooterState();
  const s = reduceFooterEvent(collapsed, "outside-click");
  assertFalse(s.expanded);
});

Deno.test("close は展開時のみ折りたたむ（#284 AC15: 明示的な閉じるボタン）", () => {
  const expanded: FooterState = { expanded: true };
  const s = reduceFooterEvent(expanded, "close");
  assertFalse(s.expanded);
});

Deno.test("close は未展開時には状態を変えない", () => {
  const collapsed = createFooterState();
  const s = reduceFooterEvent(collapsed, "close");
  assertFalse(s.expanded);
});

Deno.test("escape は展開時のみ折りたたむ", () => {
  const expanded: FooterState = { expanded: true };
  const s = reduceFooterEvent(expanded, "escape");
  assertFalse(s.expanded);
});

Deno.test("escape は未展開時には状態を変えない", () => {
  const collapsed = createFooterState();
  const s = reduceFooterEvent(collapsed, "escape");
  assertFalse(s.expanded);
});

Deno.test("reduceFooterEvent は元の state を破壊しない（純粋関数）", () => {
  const before: FooterState = { expanded: true };
  reduceFooterEvent(before, "toggle");
  assert(before.expanded);
});

/** AC #4: aria-expanded は "true"/"false" の文字列で導出される */
Deno.test("ariaExpandedValue は展開状態から 'true'/'false' を導出する", () => {
  assertEquals(ariaExpandedValue({ expanded: true }), "true");
  assertEquals(ariaExpandedValue({ expanded: false }), "false");
});

/** AC #1/#2: 全文コンテナの hidden は expanded の否定 */
Deno.test("isContentHidden は未展開時 true・展開時 false", () => {
  assert(isContentHidden({ expanded: false }));
  assertFalse(isContentHidden({ expanded: true }));
});
