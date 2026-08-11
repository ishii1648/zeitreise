import { assert, assertEquals } from "@std/assert";
import type { Rect, UiRect } from "./mobile-smoke.ts";
import {
  buildClearSafeAreaInsetsExpr,
  buildSetSafeAreaInsetsExpr,
  findSafeAreaViolations,
  LANDSCAPE_NOTCH_INSETS,
  PORTRAIT_NOTCH_INSETS,
  SAFE_AREA_CSS_VARS,
  type SafeAreaInsets,
} from "./safe-area.ts";

function rect(left: number, top: number, right: number, bottom: number): Rect {
  return { left, top, right, bottom };
}

// ---- プリセット（実機の代表値であること） ----

Deno.test("プリセット: 横持ちノッチは left/right 47px + bottom 21px", () => {
  assertEquals(LANDSCAPE_NOTCH_INSETS, {
    top: 0,
    left: 47,
    right: 47,
    bottom: 21,
  });
});

Deno.test("プリセット: 縦持ちノッチは bottom 34px（ホームインジケーター）", () => {
  assertEquals(PORTRAIT_NOTCH_INSETS.bottom, 34);
  assertEquals(PORTRAIT_NOTCH_INSETS.left, 0);
  assertEquals(PORTRAIT_NOTCH_INSETS.right, 0);
});

// ---- buildSetSafeAreaInsetsExpr / buildClearSafeAreaInsetsExpr ----

Deno.test("buildSetSafeAreaInsetsExpr: 3 変数を px 値で上書きする式を作る", () => {
  const expr = buildSetSafeAreaInsetsExpr(LANDSCAPE_NOTCH_INSETS);
  assert(expr.includes('setProperty("--safe-area-bottom", "21px")'));
  assert(expr.includes('setProperty("--safe-area-left", "47px")'));
  assert(expr.includes('setProperty("--safe-area-right", "47px")'));
});

Deno.test("buildClearSafeAreaInsetsExpr: 全変数の上書きを除去する式を作る", () => {
  const expr = buildClearSafeAreaInsetsExpr();
  for (const name of SAFE_AREA_CSS_VARS) {
    assert(expr.includes(`removeProperty("${name}")`));
  }
});

// ---- findSafeAreaViolations ----

const VIEWPORT = { width: 844, height: 390 };

Deno.test("findSafeAreaViolations: 安全領域内の要素は違反にならない", () => {
  const rects: UiRect[] = [
    // 左右 55px（inset 47 + 余白 8）・下端 h - 29（inset 21 + 余白 8）
    { selector: ".timeline", rect: rect(55, 322, 789, 361) },
  ];
  assertEquals(
    findSafeAreaViolations(rects, VIEWPORT, LANDSCAPE_NOTCH_INSETS),
    [],
  );
});

Deno.test("findSafeAreaViolations: 左ノッチ帯へ入った要素を検出する", () => {
  const rects: UiRect[] = [
    { selector: ".timeline", rect: rect(8, 322, 789, 361) },
  ];
  const violations = findSafeAreaViolations(
    rects,
    VIEWPORT,
    LANDSCAPE_NOTCH_INSETS,
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0].selector, ".timeline");
  assertEquals(violations[0].edge, "left");
  assertEquals(violations[0].overflowPx, 39);
});

Deno.test("findSafeAreaViolations: 右ノッチ帯・下端帯への進入も検出する", () => {
  const rects: UiRect[] = [
    // 右端 = 844 - 8 = 836 > 844 - 47 = 797
    { selector: ".maplibregl-ctrl-attrib", rect: rect(700, 300, 836, 324) },
    // 下端 = 390 - 4 = 386 > 390 - 21 = 369
    { selector: ".timeline", rect: rect(55, 322, 789, 386) },
  ];
  const violations = findSafeAreaViolations(
    rects,
    VIEWPORT,
    LANDSCAPE_NOTCH_INSETS,
  );
  assertEquals(violations.map((v) => [v.selector, v.edge]), [
    [".maplibregl-ctrl-attrib", "right"],
    [".timeline", "bottom"],
  ]);
  assertEquals(violations[0].overflowPx, 39);
  assertEquals(violations[1].overflowPx, 17);
});

Deno.test("findSafeAreaViolations: 1 要素が複数の辺で違反したら全て列挙する", () => {
  const rects: UiRect[] = [
    { selector: ".timeline", rect: rect(8, 322, 840, 388) },
  ];
  const violations = findSafeAreaViolations(
    rects,
    VIEWPORT,
    LANDSCAPE_NOTCH_INSETS,
  );
  assertEquals(violations.map((v) => v.edge), ["left", "right", "bottom"]);
});

Deno.test("findSafeAreaViolations: 許容誤差以内のはみ出しは無視する", () => {
  const insets: SafeAreaInsets = { top: 0, left: 47, right: 47, bottom: 21 };
  const rects: UiRect[] = [
    // 0.5px だけ左帯に入っている（サブピクセル丸め相当）
    { selector: ".timeline", rect: rect(46.5, 322, 789, 361) },
  ];
  assertEquals(findSafeAreaViolations(rects, VIEWPORT, insets, 1), []);
});

Deno.test("findSafeAreaViolations: inset 0 なら何も検出しない", () => {
  const insets: SafeAreaInsets = { top: 0, left: 0, right: 0, bottom: 0 };
  const rects: UiRect[] = [
    { selector: ".timeline", rect: rect(0, 322, 844, 390) },
  ];
  assertEquals(findSafeAreaViolations(rects, VIEWPORT, insets), []);
});
