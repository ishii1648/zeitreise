import { assert, assertEquals } from "@std/assert";
import { LANDSCAPE_PRESET } from "../emulation.ts";
import {
  MIN_TAP_TARGET_PX,
  type Rect,
  TAP_TARGET_SELECTORS,
  UI_OVERLAP_SELECTORS,
} from "./mobile-smoke.ts";
import {
  MAX_TIMELINE_HEIGHT_RATIO,
  timelineHeightRatio,
} from "./landscape-smoke.ts";

function rect(left: number, top: number, right: number, bottom: number): Rect {
  return { left, top, right, bottom };
}

// ---- timelineHeightRatio（タイムラインの画面高占有率の純粋関数） ----

Deno.test("timelineHeightRatio: 矩形の高さ / ビューポート高を返す", () => {
  // 高さ 62px（小画面レイアウトの下端横帯）/ 390px → 約 0.159
  assertEquals(timelineHeightRatio(rect(8, 214, 836, 276), 390), 62 / 390);
});

Deno.test("timelineHeightRatio: Issue #252 の実測（縦帯 358px / 390px 高）は上限を超える", () => {
  // 横持ち 844x390 でデスクトップ配置に戻ると縦タイムラインが高さ 358px に
  // なり画面高のほぼ全域を占める（Issue #252 の実際の挙動）。この状態を
  // 上限超過として検出できることを固定する。
  const ratio = timelineHeightRatio(rect(16, 16, 108, 374), 390);
  assert(ratio > MAX_TIMELINE_HEIGHT_RATIO);
});

Deno.test("timelineHeightRatio: 小画面レイアウトの横帯（62px / 390px 高）は上限内", () => {
  const ratio = timelineHeightRatio(rect(8, 214, 836, 276), 390);
  assert(ratio <= MAX_TIMELINE_HEIGHT_RATIO);
});

Deno.test("MAX_TIMELINE_HEIGHT_RATIO: 上限は画面高の 50%（地図を過度に覆わない）", () => {
  assertEquals(MAX_TIMELINE_HEIGHT_RATIO, 0.5);
});

// ---- 横持ちチェックが前提とする共有定義（mobile-smoke.ts から再利用） ----

Deno.test("横持ちチェックの対象要素: Issue #252 の対象（前後ボタン・スライダー）と統合アトリビューションの ⓘ を含む（#328）", () => {
  for (
    const selector of [
      "#timeline-prev",
      "#timeline-next",
      ".timeline-slider",
      // #328: 左上の ⓘ・⚠ は撤去し、右下のアトリビューションへ統合した
      ".maplibregl-ctrl-attrib-button",
    ]
  ) {
    assert(
      TAP_TARGET_SELECTORS.includes(selector),
      `${selector} が TAP_TARGET_SELECTORS に含まれていない`,
    );
  }
  assert(MIN_TAP_TARGET_PX === 44);
  assert(UI_OVERLAP_SELECTORS.includes(".timeline"));
});

Deno.test("LANDSCAPE_PRESET: 横持ちは縦持ちプリセットの width/height を入れ替えた形ではなく 844x390 を使う", () => {
  // Issue #252 の再現手順どおり 844x390（iPhone 12/13/14 系の横持ち論理解像度）
  assertEquals(LANDSCAPE_PRESET.width, 844);
  assertEquals(LANDSCAPE_PRESET.height, 390);
  assertEquals(LANDSCAPE_PRESET.touch, true);
});

// ---- ラベル描画検査の組み込み（#320） ----

Deno.test("landscape-smoke: ラベル描画検査（#320）を実行して overallOk に反映する", async () => {
  const source = await Deno.readTextFile(
    new URL("./landscape-smoke.ts", import.meta.url),
  );
  assertEquals(source.includes("LABEL_RENDER_PROBE_EXPR"), true);
  assertEquals(source.includes("findLabelRenderProblems"), true);
  assertEquals(source.includes("labelRenderOk &&"), true);
});

// ---- deck オーバーレイ初期化待ち（#384） ----

Deno.test("landscape-smoke: ラベル描画プローブの前に deck オーバーレイの初期化を待つ（#384）", async () => {
  const source = await Deno.readTextFile(
    new URL("./landscape-smoke.ts", import.meta.url),
  );
  const waitIndex = source.indexOf("await waitForDeckOverlayReady(api)");
  assertEquals(
    waitIndex >= 0,
    true,
    "deck オーバーレイ初期化待ち（waitForDeckOverlayReady）が呼ばれていない",
  );
  const probeIndex = source.lastIndexOf("LABEL_RENDER_PROBE_EXPR");
  assertEquals(
    waitIndex < probeIndex,
    true,
    "ラベル描画プローブの評価が deck オーバーレイ初期化待ちより前にある",
  );
});

Deno.test("landscape-smoke: 年代反映は共通の waitForYearReflected（早期 fail + 45s）で待つ（#384）", async () => {
  const source = await Deno.readTextFile(
    new URL("./landscape-smoke.ts", import.meta.url),
  );
  assertEquals(source.includes("waitForYearReflected"), true);
  assertEquals(source.includes('window.__getYear() === 1500", 15000'), false);
  assertEquals(source.includes('window.__getYear() === 1000", 15000'), false);
});
