/**
 * info_panel.ts のユニットテスト（TASK-146 / Issue #283）。
 *
 * 検証する契約:
 * - setupInfoUI がハンドル（showTooltip / hideTooltip / showInfoPanel）を返し、
 *   DOM 要素欠如時は warn（文言固定）を出して no-op ハンドルへ縮退すること
 * - ツールチップの配置が tooltipPlacement（純粋関数）+ 注入 viewport に
 *   一致すること
 * - #283 案A: パネル 1 行目が「名称 + 現在の年代（弱い文字）」、区切り線の下が
 *   一文要約になり、年代・説明が無い対象では欄ごと畳まれること（AC1/AC2/AC8）
 * - #283 AC5: パネルへ出典・ライセンス・境界・コミットの欄を作らないこと
 */
import {
  assert,
  assertEquals,
  assertFalse,
  assertStrictEquals,
} from "@std/assert";
import { setupInfoUI } from "./info_panel.ts";
import { tooltipPlacement } from "../info.ts";
import { captureWarns, FakeDocument } from "./fake_dom.ts";

/** fake 一式を組み立てて setupInfoUI を配線する */
function setup() {
  const doc = new FakeDocument();
  const tooltip = doc.addElement("info-tooltip");
  const panel = doc.addElement("info-panel");
  const panelLabel = doc.addElement("info-panel-label");
  const panelYear = doc.addElement("info-panel-year");
  const panelDescription = doc.addElement("info-panel-description");
  const panelClose = doc.addElement("info-panel-close");
  const viewport = { width: 800, height: 600 };
  const handle = setupInfoUI({ doc, viewportSize: () => viewport });
  return {
    doc,
    tooltip,
    panel,
    panelLabel,
    panelYear,
    panelDescription,
    panelClose,
    viewport,
    handle,
  };
}

Deno.test("要素欠如時は warn を出して no-op ハンドルを返す（文言固定）", () => {
  const doc = new FakeDocument();
  const { value: handle, warns } = captureWarns(() =>
    setupInfoUI({ doc, viewportSize: () => ({ width: 800, height: 600 }) })
  );
  assertEquals(warns, [
    "情報表示 UI 要素が見つからないため配線をスキップします",
  ]);
  // no-op ハンドルは呼んでも例外を出さない
  handle.showTooltip("x", 0, 0);
  handle.hideTooltip();
  handle.showInfoPanel({ label: "x", year: null, description: null });
});

Deno.test("#283 で追加した年代・説明の要素が欠けていても同じ縮退契約に従う", () => {
  const doc = new FakeDocument();
  doc.addElement("info-tooltip");
  doc.addElement("info-panel");
  doc.addElement("info-panel-label");
  doc.addElement("info-panel-close");
  const { value: handle, warns } = captureWarns(() =>
    setupInfoUI({ doc, viewportSize: () => ({ width: 800, height: 600 }) })
  );
  assertEquals(warns, [
    "情報表示 UI 要素が見つからないため配線をスキップします",
  ]);
  handle.showInfoPanel({ label: "x", year: 1600, description: "y" });
});

Deno.test("配線時にパネルへ出典欄（dl/dt/dd）を作らない（#283 AC5）", () => {
  const { doc, panel } = setup();
  assertEquals(doc.created.length, 0);
  assertEquals(panel.children.length, 0);
});

Deno.test("showTooltip は tooltipPlacement + viewport どおりに配置し表示する", () => {
  const { tooltip, viewport, handle } = setup();
  tooltip.rect = { width: 120, height: 40 };
  handle.showTooltip("フランス王国", 100, 200);
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

Deno.test("showTooltip は viewport 右下端でフリップした座標を使う", () => {
  const { tooltip, viewport, handle } = setup();
  tooltip.rect = { width: 120, height: 40 };
  handle.showTooltip("端", 790, 590);
  const expected = tooltipPlacement(
    { x: 790, y: 590 },
    { width: 120, height: 40 },
    viewport,
  );
  assertEquals(tooltip.style.left, `${expected.left}px`);
  assertEquals(tooltip.style.top, `${expected.top}px`);
});

Deno.test("hideTooltip はツールチップを隠す", () => {
  const { tooltip, handle } = setup();
  handle.showTooltip("x", 0, 0);
  handle.hideTooltip();
  assert(tooltip.hidden);
});

Deno.test("showInfoPanel は名称 + 年代 + 一文要約を描画する（#283 AC1/AC2）", () => {
  const { panel, panelLabel, panelYear, panelDescription, handle } = setup();
  handle.showInfoPanel({
    label: "ポーランド・リトアニア共和国",
    year: 1600,
    description: "東欧最大級の版図を誇っていた時代です。",
  });
  assertEquals(panelLabel.textContent, "ポーランド・リトアニア共和国");
  assertEquals(panelYear.textContent, "1600年");
  assertFalse(panelYear.hidden);
  assertEquals(
    panelDescription.textContent,
    "東欧最大級の版図を誇っていた時代です。",
  );
  assertFalse(panelDescription.hidden);
  assertFalse(panel.hidden);
});

Deno.test("showInfoPanel は年代を切り替えると説明も差し替える（#283 AC3）", () => {
  const { panelYear, panelDescription, handle } = setup();
  handle.showInfoPanel({
    label: "ポーランド・リトアニア共和国",
    year: 1600,
    description: "東欧最大級の版図を誇っていた時代です。",
  });
  handle.showInfoPanel({
    label: "ポーランド・リトアニア共和国",
    year: 1700,
    description: "周辺国の介入を受けるようになった時代です。",
  });
  assertEquals(panelYear.textContent, "1700年");
  assertEquals(
    panelDescription.textContent,
    "周辺国の介入を受けるようになった時代です。",
  );
});

Deno.test("showInfoPanel は説明が無い対象で説明欄ごと畳む（#283 AC8）", () => {
  const { panel, panelLabel, panelYear, panelDescription, handle } = setup();
  handle.showInfoPanel({
    label: "フィヴィッツァーノ",
    year: 1650,
    description: null,
  });
  assertEquals(panelLabel.textContent, "フィヴィッツァーノ");
  // 年代は出るが、区切り線を持つ説明欄は畳む（空の区切り線を出さない）
  assertFalse(panelYear.hidden);
  assert(panelDescription.hidden);
  assertEquals(panelDescription.textContent, "");
  assertFalse(panel.hidden);
});

Deno.test("showInfoPanel は年代非依存の対象で年代欄も畳む（#283 AC9）", () => {
  const { panelLabel, panelYear, panelDescription, handle } = setup();
  handle.showInfoPanel({ label: "ローヌ川", year: null, description: null });
  assertEquals(panelLabel.textContent, "ローヌ川");
  assert(panelYear.hidden);
  assertEquals(panelYear.textContent, "");
  assert(panelDescription.hidden);
});

Deno.test("showInfoPanel は前回の説明を持ち越さない（対象を切り替えたときの残留防止）", () => {
  const { panelYear, panelDescription, handle } = setup();
  handle.showInfoPanel({
    label: "フランス王国",
    year: 1600,
    description: "説明です。",
  });
  handle.showInfoPanel({
    label: "モンブラン 4807m",
    year: null,
    description: null,
  });
  assert(panelDescription.hidden);
  assertEquals(panelDescription.textContent, "");
  assert(panelYear.hidden);
  assertEquals(panelYear.textContent, "");
});

Deno.test("閉じるボタンでパネルを隠す", () => {
  const { panel, panelClose, handle } = setup();
  handle.showInfoPanel({ label: "x", year: null, description: null });
  panelClose.click();
  assert(panel.hidden);
});

Deno.test("パネルの各欄は index.html の要素をそのまま使う（DOM を増やさない）", () => {
  const { doc, panelLabel, panelYear, panelDescription } = setup();
  assertStrictEquals(doc.getElementById("info-panel-label"), panelLabel);
  assertStrictEquals(doc.getElementById("info-panel-year"), panelYear);
  assertStrictEquals(
    doc.getElementById("info-panel-description"),
    panelDescription,
  );
});
