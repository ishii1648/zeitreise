/** info_tooltip.ts のユニットテスト（Issue #423）。 */
import { assert, assertEquals, assertFalse } from "@std/assert";
import { tooltipPlacement } from "../info.ts";
import { captureWarns, FakeDocument } from "./fake_dom.ts";
import { setupInfoTooltip } from "./info_tooltip.ts";

function setup() {
  const doc = new FakeDocument();
  const tooltip = doc.addElement("info-tooltip");
  const viewport = { width: 800, height: 600 };
  const handle = setupInfoTooltip({ doc, viewportSize: () => viewport });
  return { tooltip, viewport, handle };
}

Deno.test("要素欠如時は warn を出して no-op ハンドルを返す", () => {
  const doc = new FakeDocument();
  const { value: handle, warns } = captureWarns(() =>
    setupInfoTooltip({
      doc,
      viewportSize: () => ({ width: 800, height: 600 }),
    })
  );
  assertEquals(warns, [
    "情報ツールチップ要素が見つからないため配線をスキップします",
  ]);
  handle.show("x", 0, 0);
  handle.hide();
});

Deno.test("show は tooltipPlacement + viewport どおりに配置し表示する", () => {
  const { tooltip, viewport, handle } = setup();
  tooltip.rect = { width: 120, height: 40 };
  handle.show("フランス王国", 100, 200);
  assertEquals(tooltip.textContent, "フランス王国");
  assertFalse(tooltip.hidden);
  const expected = tooltipPlacement(
    { x: 100, y: 200 },
    { width: 120, height: 40 },
    viewport,
  );
  assertEquals(tooltip.style.left, `${expected.left}px`);
  assertEquals(tooltip.style.top, `${expected.top}px`);
});

Deno.test("show は viewport 右下端でフリップした座標を使う", () => {
  const { tooltip, viewport, handle } = setup();
  tooltip.rect = { width: 120, height: 40 };
  handle.show("端", 790, 590);
  const expected = tooltipPlacement(
    { x: 790, y: 590 },
    { width: 120, height: 40 },
    viewport,
  );
  assertEquals(tooltip.style.left, `${expected.left}px`);
  assertEquals(tooltip.style.top, `${expected.top}px`);
});

Deno.test("hide はツールチップを隠す", () => {
  const { tooltip, handle } = setup();
  handle.show("x", 0, 0);
  handle.hide();
  assert(tooltip.hidden);
});
