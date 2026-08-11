import { assertEquals } from "@std/assert";
import { MOBILE_PRESET, SMALL_MOBILE_PRESET } from "../cdp.ts";
import {
  AUX_PANEL_SCREENSHOT_DIR,
  AUX_PANEL_TAP_TARGET_SELECTORS,
  buildAllUiRectsExpr,
  findHorizontalOverflow,
  findMissingTapTargets,
  findOverlaps,
  findSmallTapTargets,
  findTapDisplayProblems,
  MIN_TAP_TARGET_PX,
  MOBILE_SCREENSHOT_PATH,
  MOBILE_TAP_SCREENSHOT_PATH,
  OVERLAP_MIN_AREA_PX,
  type PanelScrollProbe,
  type Rect,
  rectOverlapArea,
  TAP_TARGET_SELECTORS,
  type TapDisplayState,
  UI_OVERLAP_SELECTORS,
  type UiRect,
} from "./mobile-smoke.ts";

// ---- rectOverlapArea（矩形交差面積の純粋関数） ----

function rect(left: number, top: number, right: number, bottom: number): Rect {
  return { left, top, right, bottom };
}

Deno.test("rectOverlapArea: 交差しない矩形は 0 を返す", () => {
  assertEquals(rectOverlapArea(rect(0, 0, 10, 10), rect(20, 20, 30, 30)), 0);
});

Deno.test("rectOverlapArea: 辺が接するだけの矩形は 0 を返す", () => {
  assertEquals(rectOverlapArea(rect(0, 0, 10, 10), rect(10, 0, 20, 10)), 0);
});

Deno.test("rectOverlapArea: 交差する矩形は交差領域の面積を返す", () => {
  // 交差領域は x: 5..10, y: 5..10 の 5x5 = 25
  assertEquals(rectOverlapArea(rect(0, 0, 10, 10), rect(5, 5, 20, 20)), 25);
});

Deno.test("rectOverlapArea: 包含関係なら内側の矩形の面積を返す", () => {
  assertEquals(
    rectOverlapArea(rect(0, 0, 100, 100), rect(10, 10, 20, 20)),
    100,
  );
});

// ---- findOverlaps（重なりペア抽出の純粋関数） ----

Deno.test("findOverlaps: 重なる UI 要素のペアと面積を列挙する", () => {
  const rects: UiRect[] = [
    { selector: ".timeline", rect: rect(0, 700, 375, 812) },
    { selector: ".info-panel", rect: rect(200, 650, 375, 760) },
    { selector: ".footer-toggle", rect: rect(0, 0, 40, 40) },
  ];
  const overlaps = findOverlaps(rects);
  assertEquals(overlaps, [
    {
      a: ".timeline",
      b: ".info-panel",
      // 交差領域は x: 200..375 (175), y: 700..760 (60) = 10500
      area: 10500,
    },
  ]);
});

Deno.test("findOverlaps: 閾値未満の微小な重なりは無視する", () => {
  const rects: UiRect[] = [
    { selector: "a", rect: rect(0, 0, 10, 10) },
    { selector: "b", rect: rect(9, 9, 20, 20) }, // 1x1 = 1px^2
  ];
  assertEquals(findOverlaps(rects), []);
});

Deno.test("findOverlaps: 重なりが無ければ空配列を返す", () => {
  const rects: UiRect[] = [
    { selector: "a", rect: rect(0, 0, 10, 10) },
    { selector: "b", rect: rect(50, 50, 60, 60) },
  ];
  assertEquals(findOverlaps(rects), []);
});

Deno.test("OVERLAP_MIN_AREA_PX: 微小交差を除外する正の閾値が定義されている", () => {
  assertEquals(OVERLAP_MIN_AREA_PX > 0, true);
});

// ---- 定数（スクリーンショット出力先・監視対象セレクタ） ----

Deno.test("スクリーンショットは .outputs/claude/task131/ 配下に保存される", () => {
  assertEquals(
    MOBILE_SCREENSHOT_PATH.startsWith(".outputs/claude/task131/"),
    true,
  );
  assertEquals(
    MOBILE_TAP_SCREENSHOT_PATH.startsWith(".outputs/claude/task131/"),
    true,
  );
  assertEquals(
    (MOBILE_SCREENSHOT_PATH as string) !==
      (MOBILE_TAP_SCREENSHOT_PATH as string),
    true,
  );
});

Deno.test("UI_OVERLAP_SELECTORS: モバイルで地図面を占有しうる主要 UI を監視対象に含む", () => {
  for (
    const selector of [
      ".timeline",
      ".info-panel",
      ".footer-toggle",
      ".known-limitations-toggle",
      // TASK-132: maplibre の attribution は初期表示で展開されており
      // （maplibregl-compact-show）、TASK-131 で下端トグル群との衝突を実測した。
      // AC #3 の対象なので監視に含める。
      ".maplibregl-ctrl-attrib",
    ]
  ) {
    assertEquals(
      UI_OVERLAP_SELECTORS.includes(selector),
      true,
      `missing ${selector}`,
    );
  }
});

// ---- findSmallTapTargets（タップ当たり判定の検査。TASK-132 AC #4） ----

Deno.test("MIN_TAP_TARGET_PX: タップ当たり判定の下限は 44px（AC #4）", () => {
  assertEquals(MIN_TAP_TARGET_PX, 44);
});

Deno.test("findSmallTapTargets: 幅または高さが下限未満の要素を寸法付きで列挙する", () => {
  const rects: UiRect[] = [
    // 28x28 の丸トグル（幅・高さとも不足）
    { selector: ".footer-toggle", rect: rect(8, 778, 36, 806) },
    // 58x27 のピル型ボタン（高さのみ不足）
    {
      selector: ".known-limitations-detail-toggle",
      rect: rect(309, 751, 367, 778),
    },
    // 44x44 ちょうど（合格）
    { selector: "#timeline-prev", rect: rect(0, 0, 44, 44) },
  ];
  assertEquals(findSmallTapTargets(rects), [
    { selector: ".footer-toggle", width: 28, height: 28 },
    { selector: ".known-limitations-detail-toggle", width: 58, height: 27 },
  ]);
});

Deno.test("findSmallTapTargets: 全て 44px 以上なら空配列を返す", () => {
  const rects: UiRect[] = [
    { selector: "a", rect: rect(0, 0, 44, 44) },
    { selector: "b", rect: rect(0, 0, 200, 48) },
  ];
  assertEquals(findSmallTapTargets(rects), []);
});

Deno.test("TAP_TARGET_SELECTORS: 主要なタップ対象を検査に含む（AC #4）", () => {
  for (
    const selector of [
      "#timeline-prev",
      "#timeline-next",
      ".timeline-slider",
      ".footer-toggle",
      ".known-limitations-toggle",
      ".info-panel-close",
    ]
  ) {
    assertEquals(
      TAP_TARGET_SELECTORS.includes(selector),
      true,
      `missing ${selector}`,
    );
  }
});

Deno.test("MOBILE_PRESET とスモークの前提が一致する（幅 390 / 高さ 844 / DPR 3 / タッチ有効。Issue #253 の再現条件）", () => {
  assertEquals(MOBILE_PRESET.width, 390);
  assertEquals(MOBILE_PRESET.height, 844);
  assertEquals(MOBILE_PRESET.deviceScaleFactor, 3);
  assertEquals(MOBILE_PRESET.touch, true);
});

// ---- 補助パネル内のタップ対象検査（Issue #254） ----

Deno.test("AUX_PANEL_TAP_TARGET_SELECTORS: 補助パネル内のリンク・詳細ボタンを検査に含む（Issue #254 AC1/AC3）", () => {
  for (
    const selector of [
      // 既知の制限パネル: 「詳細」「詳細を閉じる」（同一クラス）と
      // 「他の年代の制限も表示」
      ".known-limitations-detail-toggle",
      ".known-limitations-show-all-btn",
      // 出典パネル（ⓘ attribution）の本文リンク
      ".footer-content a",
      // 情報パネル内の出典リンク
      ".info-panel-source-value a",
      // ⓘ/⚠ パネルの閉じるボタン（#284 AC15）
      ".popover-card-close",
    ]
  ) {
    assertEquals(
      AUX_PANEL_TAP_TARGET_SELECTORS.includes(selector),
      true,
      `missing ${selector}`,
    );
  }
});

Deno.test("buildAllUiRectsExpr: querySelectorAll で全マッチを列挙する評価式を組み立てる", () => {
  const expr = buildAllUiRectsExpr([".footer-content a"]);
  assertEquals(expr.includes("querySelectorAll"), true);
  assertEquals(expr.includes(".footer-content a"), true);
});

Deno.test("findMissingTapTargets: 1 件も計測されなかったセレクタを列挙する（計測ゼロでの空振り合格を防ぐ）", () => {
  const rects: UiRect[] = [
    // buildAllUiRectsExpr は複数マッチを selector[i] のラベルで返す
    { selector: ".footer-content a[0]", rect: rect(0, 0, 100, 44) },
    { selector: ".footer-content a[1]", rect: rect(0, 50, 100, 94) },
  ];
  assertEquals(
    findMissingTapTargets(rects, [
      ".footer-content a",
      ".known-limitations-detail-toggle",
    ]),
    [".known-limitations-detail-toggle"],
  );
});

Deno.test("findMissingTapTargets: 全セレクタに計測結果があれば空配列を返す", () => {
  const rects: UiRect[] = [
    { selector: ".footer-content a[0]", rect: rect(0, 0, 100, 44) },
    {
      selector: ".known-limitations-detail-toggle[0]",
      rect: rect(0, 0, 44, 44),
    },
  ];
  assertEquals(
    findMissingTapTargets(rects, [
      ".footer-content a",
      ".known-limitations-detail-toggle",
    ]),
    [],
  );
});

Deno.test("findHorizontalOverflow: scrollWidth が clientWidth を許容誤差超で上回るパネルを列挙する（AC4 の横スクロール検出）", () => {
  const probes: PanelScrollProbe[] = [
    // 横スクロールなし
    { selector: "#footer-content", scrollWidth: 300, clientWidth: 300 },
    // サブピクセル誤差（1px 以内）は許容
    {
      selector: "#known-limitations-content",
      scrollWidth: 301,
      clientWidth: 300,
    },
    // 2px 以上のはみ出しは検出
    { selector: "#info-panel", scrollWidth: 320, clientWidth: 300 },
  ];
  assertEquals(findHorizontalOverflow(probes), [
    { selector: "#info-panel", scrollWidth: 320, clientWidth: 300 },
  ]);
});

Deno.test("補助パネルのスクリーンショットは .outputs/claude/issue254/ 配下に保存される", () => {
  assertEquals(AUX_PANEL_SCREENSHOT_DIR, ".outputs/claude/issue254");
});

Deno.test("SMALL_MOBILE_PRESET とスモークの前提が一致する（幅 320 / 高さ 568 / DPR 2 / タッチ有効。Issue #254 AC2 の実測条件）", () => {
  assertEquals(SMALL_MOBILE_PRESET.width, 320);
  assertEquals(SMALL_MOBILE_PRESET.height, 568);
  assertEquals(SMALL_MOBILE_PRESET.deviceScaleFactor, 2);
  assertEquals(SMALL_MOBILE_PRESET.touch, true);
});

// ---- findTapDisplayProblems（タップ後の表示検査の純粋関数。Issue #253 AC4） ----

const TAP_EXPECTATION = {
  infoPanelLabel: "ライン川",
  selectedRiverName: "Rhine",
} as const;

Deno.test("findTapDisplayProblems: 情報パネル + 選択強調のみ（ツールチップなし）なら問題なし", () => {
  const state: TapDisplayState = {
    infoPanelLabel: "ライン川",
    tooltipVisible: false,
    selectedRiverName: "Rhine",
  };
  assertEquals(findTapDisplayProblems(state, TAP_EXPECTATION), []);
});

Deno.test("findTapDisplayProblems: タップ後にツールチップが残っていれば二重表示として検出する（Issue #253）", () => {
  const state: TapDisplayState = {
    infoPanelLabel: "ライン川",
    tooltipVisible: true,
    selectedRiverName: "Rhine",
  };
  const problems = findTapDisplayProblems(state, TAP_EXPECTATION);
  assertEquals(problems.length, 1);
  assertEquals(problems[0].includes("ツールチップ"), true);
});

Deno.test("findTapDisplayProblems: パネル未表示・選択強調なしもそれぞれ検出する", () => {
  const state: TapDisplayState = {
    infoPanelLabel: null,
    tooltipVisible: false,
    selectedRiverName: null,
  };
  const problems = findTapDisplayProblems(state, TAP_EXPECTATION);
  assertEquals(problems.length, 2);
});
