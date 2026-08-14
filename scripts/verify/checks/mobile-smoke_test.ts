import { assertEquals } from "@std/assert";
import { MOBILE_PRESET, SMALL_MOBILE_PRESET } from "../cdp.ts";
import {
  type AttributionState,
  AUX_PANEL_SCREENSHOT_DIR,
  AUX_PANEL_TAP_TARGET_SELECTORS,
  buildAllUiRectsExpr,
  findAttributionProblems,
  findHorizontalOverflow,
  findMissingTapTargets,
  findOverlaps,
  findSmallTapTargets,
  findTapDisplayProblems,
  FORBIDDEN_ATTRIBUTION_TOKENS,
  MIN_TAP_TARGET_PX,
  MOBILE_SCREENSHOT_PATH,
  MOBILE_TAP_SCREENSHOT_PATH,
  OVERLAP_MIN_AREA_PX,
  type PanelScrollProbe,
  type Rect,
  rectOverlapArea,
  REQUIRED_ATTRIBUTION_TOKENS,
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
    { selector: ".maplibregl-ctrl-attrib", rect: rect(0, 0, 44, 44) },
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
      // #328: 常設の補助 UI は右下のアトリビューション「ⓘ」1 個だけになった
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

Deno.test("UI_OVERLAP_SELECTORS: 撤去した左上トグルは監視対象から外れている（#328 AC2）", () => {
  // 撤去済みの要素を残すと「1 件も計測できないまま重なり 0 件」で
  // 素通りするため、監視対象から外す
  for (const selector of [".footer-toggle", ".known-limitations-toggle"]) {
    assertEquals(UI_OVERLAP_SELECTORS.includes(selector), false, selector);
  }
});

// ---- findSmallTapTargets（タップ当たり判定の検査。TASK-132 AC #4） ----

Deno.test("MIN_TAP_TARGET_PX: タップ当たり判定の下限は 44px（AC #4）", () => {
  assertEquals(MIN_TAP_TARGET_PX, 44);
});

Deno.test("findSmallTapTargets: 幅または高さが下限未満の要素を寸法付きで列挙する", () => {
  const rects: UiRect[] = [
    // 24x24 の ⓘ ボタン（MapLibre 既定。幅・高さとも不足）
    { selector: ".maplibregl-ctrl-attrib-button", rect: rect(8, 778, 32, 802) },
    // 58x27 のリンク（高さのみ不足）
    {
      selector: ".maplibregl-ctrl-attrib-inner a",
      rect: rect(309, 751, 367, 778),
    },
    // 44x44 ちょうど（合格）
    { selector: "#timeline-prev", rect: rect(0, 0, 44, 44) },
  ];
  assertEquals(findSmallTapTargets(rects), [
    { selector: ".maplibregl-ctrl-attrib-button", width: 24, height: 24 },
    { selector: ".maplibregl-ctrl-attrib-inner a", width: 58, height: 27 },
  ]);
});

Deno.test("findSmallTapTargets: 全て 44px 以上なら空配列を返す", () => {
  const rects: UiRect[] = [
    { selector: "a", rect: rect(0, 0, 44, 44) },
    { selector: "b", rect: rect(0, 0, 200, 48) },
  ];
  assertEquals(findSmallTapTargets(rects), []);
});

Deno.test("TAP_TARGET_SELECTORS: 主要なタップ対象を検査に含む（AC #4・#328 AC9）", () => {
  for (
    const selector of [
      "#timeline-prev",
      "#timeline-next",
      ".timeline-slider",
      // #328: 左上トグルの代わりに統合アトリビューションの ⓘ
      ".maplibregl-ctrl-attrib-button",
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

Deno.test("AUX_PANEL_TAP_TARGET_SELECTORS: 撤去したパネルの要素は検査対象から外れている（#283 AC5 / #328 AC2）", () => {
  // 撤去済みの選択子を残すと「1 件も計測できない空振り」として毎回 FAIL する
  for (
    const selector of [
      ".info-panel-source-value a",
      ".known-limitations-detail-toggle",
      ".known-limitations-show-all-btn",
      ".footer-content a",
      ".popover-card-close",
    ]
  ) {
    assertEquals(
      AUX_PANEL_TAP_TARGET_SELECTORS.includes(selector),
      false,
      selector,
    );
  }
});

Deno.test("AUX_PANEL_TAP_TARGET_SELECTORS: 展開したアトリビューション本文のリンクを検査に含む（Issue #254 AC1/AC3・#328）", () => {
  assertEquals(
    AUX_PANEL_TAP_TARGET_SELECTORS.includes(".maplibregl-ctrl-attrib-inner a"),
    true,
  );
});

Deno.test("buildAllUiRectsExpr: querySelectorAll で全マッチを列挙する評価式を組み立てる", () => {
  const expr = buildAllUiRectsExpr([".maplibregl-ctrl-attrib-inner a"]);
  assertEquals(expr.includes("querySelectorAll"), true);
  assertEquals(expr.includes(".maplibregl-ctrl-attrib-inner a"), true);
});

Deno.test("findMissingTapTargets: 1 件も計測されなかったセレクタを列挙する（計測ゼロでの空振り合格を防ぐ）", () => {
  const rects: UiRect[] = [
    // buildAllUiRectsExpr は複数マッチを selector[i] のラベルで返す
    {
      selector: ".maplibregl-ctrl-attrib-inner a[0]",
      rect: rect(0, 0, 100, 44),
    },
    {
      selector: ".maplibregl-ctrl-attrib-inner a[1]",
      rect: rect(0, 50, 100, 94),
    },
  ];
  assertEquals(
    findMissingTapTargets(rects, [
      ".maplibregl-ctrl-attrib-inner a",
      ".info-panel-close",
    ]),
    [".info-panel-close"],
  );
});

Deno.test("findMissingTapTargets: 全セレクタに計測結果があれば空配列を返す", () => {
  const rects: UiRect[] = [
    {
      selector: ".maplibregl-ctrl-attrib-inner a[0]",
      rect: rect(0, 0, 100, 44),
    },
    { selector: ".info-panel-close[0]", rect: rect(0, 0, 44, 44) },
  ];
  assertEquals(
    findMissingTapTargets(rects, [
      ".maplibregl-ctrl-attrib-inner a",
      ".info-panel-close",
    ]),
    [],
  );
});

Deno.test("findHorizontalOverflow: scrollWidth が clientWidth を許容誤差超で上回るパネルを列挙する（AC4 の横スクロール検出）", () => {
  const probes: PanelScrollProbe[] = [
    // 横スクロールなし
    {
      selector: ".maplibregl-ctrl-attrib",
      scrollWidth: 300,
      clientWidth: 300,
    },
    // サブピクセル誤差（1px 以内）は許容
    {
      selector: ".maplibregl-ctrl-attrib-inner",
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

// ---- ラベル描画検査の組み込み（#320） ----

Deno.test("mobile-smoke: ラベル描画検査（#320）を実行して overallOk に反映する", async () => {
  const source = await Deno.readTextFile(
    new URL("./mobile-smoke.ts", import.meta.url),
  );
  assertEquals(source.includes("LABEL_RENDER_PROBE_EXPR"), true);
  assertEquals(source.includes("findLabelRenderProblems"), true);
  assertEquals(source.includes("labelRenderOk &&"), true);
});

// ---- deck オーバーレイ初期化待ち（#384） ----

Deno.test("mobile-smoke: ラベル描画プローブの前に deck オーバーレイの初期化を待つ（#384）", async () => {
  const source = await Deno.readTextFile(
    new URL("./mobile-smoke.ts", import.meta.url),
  );
  const waitIndex = source.indexOf("await waitForDeckOverlayReady(api)");
  assertEquals(
    waitIndex >= 0,
    true,
    "deck オーバーレイ初期化待ち（waitForDeckOverlayReady）が呼ばれていない",
  );
  // import 行ではなく run() 内の評価箇所（最後の出現）と比較する
  const probeIndex = source.lastIndexOf("LABEL_RENDER_PROBE_EXPR");
  assertEquals(
    waitIndex < probeIndex,
    true,
    "ラベル描画プローブの評価が deck オーバーレイ初期化待ちより前にある",
  );
});

Deno.test("mobile-smoke: 年代反映は共通の waitForYearReflected（早期 fail + 45s）で待つ（#384）", async () => {
  const source = await Deno.readTextFile(
    new URL("./mobile-smoke.ts", import.meta.url),
  );
  assertEquals(source.includes("waitForYearReflected"), true);
  // 素の 15s 待ち（#282 で不足が実測された予算）が残っていないこと
  assertEquals(source.includes('window.__getYear() === 1500", 15000'), false);
  assertEquals(source.includes('window.__getYear() === 1000", 15000'), false);
});

// ---- findAttributionProblems（統合アトリビューションの検査。#328） ----

/** 検査に合格する展開後の状態を組み立てる */
function expandedState(
  overrides: Partial<AttributionState> = {},
): AttributionState {
  return {
    compact: true,
    expanded: true,
    detailsOpen: true,
    toggleAriaLabel: "データ出典・ライセンス",
    text: REQUIRED_ATTRIBUTION_TOKENS.join(" / "),
    hrefs: ["https://openstreetmap.org/copyright"],
    ...overrides,
  };
}

/** 検査に合格する初期表示（折りたたみ）の状態 */
const COLLAPSED_STATE: AttributionState = {
  compact: true,
  expanded: false,
  detailsOpen: false,
  toggleAriaLabel: "データ出典・ライセンス",
  text: "",
  hrefs: [],
};

Deno.test("findAttributionProblems: 折りたたみ初期表示 + 展開で全出典に到達できれば問題なし", () => {
  assertEquals(
    findAttributionProblems(COLLAPSED_STATE, expandedState()),
    [],
  );
});

Deno.test("findAttributionProblems: 初期表示が展開されていれば AC1 違反として検出する", () => {
  const problems = findAttributionProblems(
    { ...COLLAPSED_STATE, expanded: true, detailsOpen: true },
    expandedState(),
  );
  assertEquals(problems.length, 1);
  assertEquals(problems[0].includes("初期表示"), true);
});

Deno.test("findAttributionProblems: 必要な出典が欠けていれば欠けた分だけ検出する", () => {
  const problems = findAttributionProblems(
    COLLAPSED_STATE,
    expandedState({ text: "OpenStreetMap Protomaps ODbL Terrain Tiles" }),
  );
  // historical-basemaps / GPL-3.0 / ETH Zürich / CC BY-NC-SA 4.0 /
  // Cliopatria / CC BY 4.0 / 変更 の 7 件
  assertEquals(problems.length, 7);
});

Deno.test("findAttributionProblems: 境界精度の免責・制限一覧が混ざっていれば検出する（AC6）", () => {
  for (const token of FORBIDDEN_ATTRIBUTION_TOKENS) {
    const problems = findAttributionProblems(
      COLLAPSED_STATE,
      expandedState({
        text: `${REQUIRED_ATTRIBUTION_TOKENS.join(" / ")} / ${token}`,
      }),
    );
    assertEquals(problems.length, 1, token);
    assertEquals(problems[0].includes(token), true);
  }
});

Deno.test("findAttributionProblems: 1 タップで展開されなければ検出する（AC3）", () => {
  const problems = findAttributionProblems(
    COLLAPSED_STATE,
    expandedState({ expanded: false, detailsOpen: false }),
  );
  assertEquals(problems.length, 1);
  assertEquals(problems[0].includes("1 回の操作"), true);
});

Deno.test("findAttributionProblems: aria-label が無ければ検出する（AC10）", () => {
  const problems = findAttributionProblems(
    COLLAPSED_STATE,
    expandedState({ toggleAriaLabel: null }),
  );
  assertEquals(problems.length, 1);
  assertEquals(problems[0].includes("aria-label"), true);
});

Deno.test("findAttributionProblems: コントロールが見つからなければ 1 件の問題を返す", () => {
  assertEquals(findAttributionProblems(null, null).length, 1);
});
