/**
 * モバイル条件のスモークチェック（TASK-131、deno task verify:smoke:mobile で使用）。
 *
 * CDP エミュレーション（幅 390 / 高さ 844 / DPR 3 / mobile / タッチ有効。
 * cdp.ts の MOBILE_PRESET）で以下を無人確認する:
 *   1. エミュレーションの反映（innerWidth / devicePixelRatio / maxTouchPoints）
 *   2. 地図描画（canvas がビューポート相当のサイズで存在）とアプリ起動
 *   3. 年代切替（__setYear → 反映を waitFor）
 *   4. タップ相当入力（Input.dispatchTouchEvent）でポリゴン picking →
 *      情報パネル表示。Issue #253: タップ後はカーソル追従ツールチップが
 *      残らないこと・選択強調（selectedRiverName）が入ることも検査する
 *   5. 主要 UI（タイムライン・情報パネル・トグル群・attribution）の重なり計測。
 *      TASK-132 で小画面レイアウトを調整したため、重なりが 1 件でもあれば
 *      失敗にする（TASK-131 時点は報告のみだった）
 *   6. タップ当たり判定の計測（TASK-132 AC #4）。主要タップ対象の実寸が
 *      44px 未満なら失敗にする
 *   7. スクリーンショット保存（.outputs/claude/task131/。目視確認用）
 *
 * 使い方:
 *   deno task build && deno task serve --port 8131 &
 *   deno task verify:smoke:mobile http://localhost:8131/
 *   （直接起動する場合は
 *    `deno run -A scripts/verify/cdp.ts --device=mobile http://localhost:8131/ \
 *       scripts/verify/checks/mobile-smoke.ts`）
 */
import type { CdpApi } from "../cdp.ts";
// cdp.ts からではなく emulation.ts から import する（cdp.ts の CLI は
// top-level await 中にこのモジュールを dynamic import するため、cdp.ts への
// value import は循環参照でデッドロックする）。
import { MOBILE_PRESET } from "../emulation.ts";

/** スクリーンショット出力先ディレクトリ（gitignore 済みの .outputs/ 配下） */
export const SCREENSHOT_DIR = ".outputs/claude/task131";
/** 初期表示（年代切替後）のスクリーンショット */
export const MOBILE_SCREENSHOT_PATH = `${SCREENSHOT_DIR}/mobile-smoke.png`;
/** タップで情報パネルを開いた状態のスクリーンショット */
export const MOBILE_TAP_SCREENSHOT_PATH = `${SCREENSHOT_DIR}/mobile-tap.png`;

// ---- 重なり計測の純ロジック（mobile-smoke_test.ts でユニットテストする） ----

/** getBoundingClientRect 相当の矩形（viewport 基準）。 */
export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** セレクタと、その要素の viewport 基準矩形。 */
export interface UiRect {
  readonly selector: string;
  readonly rect: Rect;
}

/** 重なりと見なす交差面積の下限（px^2）。角が触れる程度の微小交差を除外する。 */
export const OVERLAP_MIN_AREA_PX = 4;

/** 2 矩形の交差面積を返す（交差しなければ 0）。 */
export function rectOverlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (width <= 0 || height <= 0) return 0;
  return width * height;
}

/**
 * 可視 UI 要素の矩形群から、交差面積が閾値以上のペアを列挙する純粋関数。
 * モバイル幅で UI 同士が重なって操作不能になる箇所を検出する
 * （TASK-132 でレイアウトを調整済みのため、検出 = 回帰として失敗にする）。
 */
export function findOverlaps(
  rects: readonly UiRect[],
  minAreaPx: number = OVERLAP_MIN_AREA_PX,
): Array<{ a: string; b: string; area: number }> {
  const overlaps: Array<{ a: string; b: string; area: number }> = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const area = rectOverlapArea(rects[i].rect, rects[j].rect);
      if (area >= minAreaPx) {
        overlaps.push({
          a: rects[i].selector,
          b: rects[j].selector,
          area,
        });
      }
    }
  }
  return overlaps;
}

/**
 * モバイル幅で地図面を占有・相互干渉しうる主要 UI のセレクタ。
 * 非表示（hidden・display:none 等）の要素は計測時に除外する。
 */
export const UI_OVERLAP_SELECTORS: readonly string[] = [
  ".timeline",
  ".info-panel",
  ".footer-toggle",
  ".known-limitations-toggle",
  ".notes-toggle",
  ".notes-panel",
  // TASK-132: maplibre の attribution は小画面ではコンパクト表示だが初期状態は
  // 展開されている（maplibregl-compact-show。最初の地図ドラッグまで開いたまま）。
  // TASK-131 でこの展開状態が下端トグル群と重なることを実測したため（AC #3）、
  // 「初期表示で開いたままでも重ならない」ことを保証対象にする。
  ".maplibregl-ctrl-attrib",
];

// ---- タップ当たり判定の計測（TASK-132 AC #4） ----

/**
 * タップ当たり判定の下限（px）。iOS HIG / WCAG 2.5.5 相当の 44px。
 * app.css の小画面ブレークポイントはこの値を満たすようトグル・ボタン類を
 * 44px 以上にしている。
 */
export const MIN_TAP_TARGET_PX = 44;

/**
 * タップ当たり判定を検査する主要タップ対象。`.info-panel-close` は情報パネルが
 * 開いた状態（タップ picking 後）でのみ可視になるため、計測は picking 確認の
 * 後に行う。非表示の要素は buildUiRectsExpr が除外する。
 */
export const TAP_TARGET_SELECTORS: readonly string[] = [
  "#timeline-prev",
  "#timeline-next",
  ".timeline-slider",
  ".footer-toggle",
  ".known-limitations-toggle",
  ".notes-toggle",
  ".info-panel-close",
];

/**
 * 可視タップ対象の矩形群から、幅または高さが下限未満のものを寸法付きで
 * 列挙する純粋関数（mobile-smoke_test.ts でユニットテストする）。
 */
export function findSmallTapTargets(
  rects: readonly UiRect[],
  minPx: number = MIN_TAP_TARGET_PX,
): Array<{ selector: string; width: number; height: number }> {
  const small: Array<{ selector: string; width: number; height: number }> = [];
  for (const { selector, rect } of rects) {
    const width = rect.right - rect.left;
    const height = rect.bottom - rect.top;
    if (width < minPx || height < minPx) {
      small.push({ selector, width, height });
    }
  }
  return small;
}

// ---- タップ後の表示検査（Issue #253 AC4） ----

/** タップ picking 後の表示状態（ブラウザから収集した実測値）。 */
export interface TapDisplayState {
  /** 情報パネルのラベル文字列（要素なしは null） */
  readonly infoPanelLabel: string | null;
  /** カーソル追従ツールチップ（#info-tooltip）が可視かどうか */
  readonly tooltipVisible: boolean;
  /** 選択強調中の河川名（__getRiverLabelDebug().selected） */
  readonly selectedRiverName: string | null;
}

/** タップ後の表示の期待値。 */
export interface TapDisplayExpectation {
  /** 情報パネルに出るべきラベル */
  readonly infoPanelLabel: string;
  /** 選択強調されるべき河川名（英語の元名） */
  readonly selectedRiverName: string;
}

/**
 * タップ後の表示状態の問題点を列挙する純粋関数（Issue #253 AC4。
 * mobile-smoke_test.ts でユニットテストする）。問題なしは空配列。
 *
 * ホバーを持たないタッチ操作では、選択結果は情報パネル + 選択強調だけに
 * 出るのが正しく、カーソル追従ツールチップが残っていたら二重表示の回帰
 * （Issue #253）として検出する。
 */
export function findTapDisplayProblems(
  state: TapDisplayState,
  expected: TapDisplayExpectation,
): string[] {
  const problems: string[] = [];
  if (state.infoPanelLabel !== expected.infoPanelLabel) {
    problems.push(
      `情報パネルのラベルが「${expected.infoPanelLabel}」ではない: ` +
        JSON.stringify(state.infoPanelLabel),
    );
  }
  if (state.tooltipVisible) {
    problems.push(
      "タップ後にカーソル追従ツールチップが表示されている" +
        "（Issue #253: タッチでは情報パネルだけに出す）",
    );
  }
  if (state.selectedRiverName !== expected.selectedRiverName) {
    problems.push(
      `選択強調中の河川が「${expected.selectedRiverName}」ではない: ` +
        JSON.stringify(state.selectedRiverName),
    );
  }
  return problems;
}

/** ブラウザ内で可視 UI 要素の矩形を収集する評価式を組み立てる。 */
export function buildUiRectsExpr(selectors: readonly string[]): string {
  return `(() => {
  const selectors = ${JSON.stringify(selectors)};
  const rects = [];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const style = window.getComputedStyle(el);
    if (
      el.hidden || style.display === "none" || style.visibility === "hidden"
    ) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    rects.push({
      selector,
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    });
  }
  return rects;
})()`;
}

// smoke.ts と同じライン川（Rhein）上の一点。URL の zoom/center クエリで
// この座標を画面中央に据え、canvas 中央へのタップで picking を検証する。
const RHEIN_POINT: [number, number] = [9.12754, 47.67068];
const TAP_ZOOM = 7;

const CANVAS_CENTER_EXPR =
  "(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()";

export async function run(api: CdpApi): Promise<void> {
  const results: Record<string, unknown> = {};
  await Deno.mkdir(SCREENSHOT_DIR, { recursive: true });

  // 1. エミュレーションの反映確認
  await api.waitForAppReady(30000);
  const viewport = await api.evaluate<{
    innerWidth: number;
    innerHeight: number;
    devicePixelRatio: number;
    maxTouchPoints: number;
  }>(
    `({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      maxTouchPoints: navigator.maxTouchPoints,
    })`,
  );
  results.viewport = viewport;
  const emulationOk = viewport.innerWidth === MOBILE_PRESET.width &&
    viewport.devicePixelRatio === MOBILE_PRESET.deviceScaleFactor &&
    viewport.maxTouchPoints > 0;
  results.emulationOk = emulationOk;

  // 2. 地図描画（canvas がビューポート幅相当で存在）
  await api.waitFor("window.__getYear && window.__getYear() === 1000", 15000);
  const canvas = await api.evaluate<
    { width: number; height: number } | null
  >(
    `(() => {
      const c = document.querySelector('canvas');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { width: r.width, height: r.height };
    })()`,
  );
  results.canvas = canvas;
  const canvasOk = canvas !== null && canvas.width > 0 && canvas.height > 0;
  results.canvasOk = canvasOk;

  // 3. 年代切替
  await api.evaluate("window.__setYear(1500)");
  await api.waitFor("window.__getYear() === 1500", 15000);
  const yearAfterSwitch = await api.evaluate<number>("window.__getYear()");
  results.yearAfterSwitch = yearAfterSwitch;
  await api.screenshot(MOBILE_SCREENSHOT_PATH);
  results.screenshot = MOBILE_SCREENSHOT_PATH;

  // 4. タップで picking → 情報パネル表示
  // ライン川を画面中央に据えた URL へ再 navigate し、canvas 中央をタップする。
  const origin = await api.evaluate<string>("location.origin");
  await api.navigate(
    `${origin}/?year=1500&zoom=${TAP_ZOOM}&center=${RHEIN_POINT[0]},${
      RHEIN_POINT[1]
    }`,
  );
  await api.waitForAppReady(30000);
  await api.waitFor("window.__getYear() === 1500", 15000);
  const center = await api.evaluate<[number, number]>(CANVAS_CENTER_EXPR);
  results.tapPoint = center;
  await api.tap(Math.round(center[0]), Math.round(center[1]));
  await new Promise((r) => setTimeout(r, 800));
  const infoPanelLabel = await api.evaluate<string | null>(
    "document.querySelector('.info-panel-label')?.textContent ?? null",
  );
  results.infoPanelLabel = infoPanelLabel;
  await api.screenshot(MOBILE_TAP_SCREENSHOT_PATH);
  results.tapScreenshot = MOBILE_TAP_SCREENSHOT_PATH;

  // 4b. タップ後の表示検査（Issue #253 AC4）。情報パネルのラベルに加えて、
  // カーソル追従ツールチップが残っていないこと（AC2 の回帰検出）と、
  // タップ対象（ライン川）の選択強調が入っていることを検査する。
  const tooltipVisible = await api.evaluate<boolean>(
    `(() => {
      const el = document.getElementById('info-tooltip');
      if (!el) return false;
      const style = window.getComputedStyle(el);
      return !el.hidden && style.display !== 'none' &&
        style.visibility !== 'hidden';
    })()`,
  );
  const selectedRiverName = await api.evaluate<string | null>(
    "window.__getRiverLabelDebug().selected",
  );
  const tapDisplay: TapDisplayState = {
    infoPanelLabel,
    tooltipVisible,
    selectedRiverName,
  };
  results.tapDisplay = tapDisplay;
  const tapDisplayProblems = findTapDisplayProblems(tapDisplay, {
    infoPanelLabel: "ライン川",
    selectedRiverName: "Rhine",
  });
  results.tapDisplayProblems = tapDisplayProblems;
  const tapDisplayOk = tapDisplayProblems.length === 0;
  results.tapDisplayOk = tapDisplayOk;

  // 5. UI の重なり計測（TASK-132 で調整済みのため、重なり検出 = 失敗）。
  // 情報パネルが開いた状態（前段の picking 後）で測ることで
  // 「常時 UI + 情報パネル」の共存レイアウトを検証する。
  const uiRects = await api.evaluate<UiRect[]>(
    buildUiRectsExpr(UI_OVERLAP_SELECTORS),
  );
  results.uiRects = uiRects;
  const overlaps = findOverlaps(uiRects);
  results.overlaps = overlaps;
  const overlapsOk = overlaps.length === 0;
  results.overlapsOk = overlapsOk;

  // 6. タップ当たり判定の計測（TASK-132 AC #4。44px 未満の対象があれば失敗）
  const tapTargetRects = await api.evaluate<UiRect[]>(
    buildUiRectsExpr(TAP_TARGET_SELECTORS),
  );
  results.tapTargetRects = tapTargetRects;
  const smallTapTargets = findSmallTapTargets(tapTargetRects);
  results.smallTapTargets = smallTapTargets;
  const tapTargetsOk = smallTapTargets.length === 0;
  results.tapTargetsOk = tapTargetsOk;

  // 7. エラートースト非表示の確認
  const errorToast = await api.evaluate<
    { present: boolean; visible: boolean; text: string | null }
  >(
    `(() => {
      const el = document.querySelector('.error-toast');
      if (!el) return { present: false, visible: false, text: null };
      const style = window.getComputedStyle(el);
      const visible = style.display !== 'none' &&
        style.visibility !== 'hidden' && el.offsetParent !== null;
      return { present: true, visible, text: el.textContent };
    })()`,
  );
  results.errorToast = errorToast;
  const errorToastOk = !errorToast.present || !errorToast.visible;
  results.errorToastOk = errorToastOk;

  const overallOk = Boolean(
    emulationOk &&
      canvasOk &&
      yearAfterSwitch === 1500 &&
      tapDisplayOk &&
      overlapsOk &&
      tapTargetsOk &&
      errorToastOk,
  );
  results.overallOk = overallOk;

  console.log(JSON.stringify(results, null, 2));
  if (tapDisplayProblems.length > 0) {
    console.log(
      `\n[TAP-DISPLAY] タップ後の表示に問題を ${tapDisplayProblems.length} 件検出` +
        "（Issue #253 AC4。上の tapDisplayProblems を参照）",
    );
  }
  if (overlaps.length > 0) {
    console.log(
      `\n[OVERLAP] モバイル幅で UI の重なりを ${overlaps.length} 件検出` +
        "（AC #3 の回帰。上の overlaps を参照）",
    );
  }
  if (smallTapTargets.length > 0) {
    console.log(
      `\n[TAP-TARGET] ${MIN_TAP_TARGET_PX}px 未満のタップ対象を ` +
        `${smallTapTargets.length} 件検出（AC #4 の回帰。上の smallTapTargets を参照）`,
    );
  }
  console.log(overallOk ? "\n[RESULT] PASS" : "\n[RESULT] FAIL");
  if (!overallOk) {
    throw new Error("mobile smoke check failed: see JSON output above");
  }
}
