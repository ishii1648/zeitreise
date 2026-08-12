/**
 * スマートフォン横持ち条件のスモークチェック
 * （Issue #252、deno task verify:smoke:landscape で使用）。
 *
 * CDP エミュレーション（幅 844 / 高さ 390 / DPR 3 / mobile / タッチ有効。
 * emulation.ts の LANDSCAPE_PRESET）で以下を無人確認する:
 *   1. エミュレーションの反映（innerWidth / devicePixelRatio /
 *      maxTouchPoints / pointer: coarse のメディア判定）
 *   2. 地図描画（canvas が存在）とアプリ起動
 *   3. 年代切替（__setYear → 反映を waitFor）
 *   3b. ラベル描画の検査（Issue #320。mobile-smoke と同一）。4 種のラベルが
 *      データ段に存在し、deck のラベル canvas が devicePixelRatio 倍の
 *      解像度を持つ（= TextLayer が描画される）ことを検査する
 *   4. タップ相当入力（Input.dispatchTouchEvent）でポリゴン picking →
 *      情報パネル表示
 *   5. タップ当たり判定の計測（Issue #252 AC1/AC2）。前後ボタン・スライダー・
 *      ⓘ・⚠・「解説」・情報パネル閉じるの実寸が 44px 未満なら失敗にする
 *   6. タイムラインの画面高占有率（Issue #252 AC3 の自動化可能部分）。
 *      縦帯のまま高さが画面高の 50% を超えていれば失敗にする
 *      （デスクトップ配置に戻ると縦帯 358px / 390px ≈ 92% で検出される）
 *   7. 主要 UI の重なり計測（mobile-smoke と同じセレクタ集合。1 件でも失敗）
 *   7b. Safe Area inset エミュレーション（Issue #256 AC1/AC2）。app.css の
 *      --safe-area-* 変数を横持ちノッチ相当（left/right 47px + bottom 21px）で
 *      上書きし、主要 UI が inset 帯へ入らない・重ならない・文書の横スクロールが
 *      出ないことを検査する（違反 1 件でも失敗）
 *   8. スクリーンショット保存（.outputs/claude/issue252/ と
 *      .outputs/claude/issue256/。目視確認用）
 *
 * 使い方:
 *   deno task build && deno task serve --port 8252 &
 *   deno task verify:smoke:landscape http://localhost:8252/
 *   （直接起動する場合は
 *    `deno run -A scripts/verify/cdp.ts --device=landscape http://localhost:8252/ \
 *       scripts/verify/checks/landscape-smoke.ts`）
 */
import type { CdpApi } from "../cdp.ts";
// cdp.ts からではなく emulation.ts / mobile-smoke.ts から import する
// （cdp.ts の CLI は top-level await 中にこのモジュールを dynamic import する
// ため、cdp.ts への value import は循環参照でデッドロックする）。
import { LANDSCAPE_PRESET } from "../emulation.ts";
import {
  findLabelRenderProblems,
  LABEL_RENDER_PROBE_EXPR,
  type LabelRenderProbe,
} from "../label_render.ts";
import {
  buildUiRectsExpr,
  findOverlaps,
  findSmallTapTargets,
  MIN_TAP_TARGET_PX,
  type Rect,
  TAP_TARGET_SELECTORS,
  UI_OVERLAP_SELECTORS,
  type UiRect,
} from "./mobile-smoke.ts";
import {
  buildClearSafeAreaInsetsExpr,
  buildSetSafeAreaInsetsExpr,
  findSafeAreaViolations,
  LANDSCAPE_NOTCH_INSETS,
} from "./safe-area.ts";

/** スクリーンショット出力先ディレクトリ（gitignore 済みの .outputs/ 配下） */
export const SCREENSHOT_DIR = ".outputs/claude/issue252";
/** 初期表示（年代切替後）のスクリーンショット */
export const LANDSCAPE_SCREENSHOT_PATH =
  `${SCREENSHOT_DIR}/landscape-smoke.png`;
/** タップで情報パネルを開いた状態のスクリーンショット */
export const LANDSCAPE_TAP_SCREENSHOT_PATH =
  `${SCREENSHOT_DIR}/landscape-tap.png`;
/** Safe Area inset 検証のスクリーンショット出力先（Issue #256） */
export const SAFE_AREA_SCREENSHOT_DIR = ".outputs/claude/issue256";
/** 横持ちノッチ inset 注入時のスクリーンショット（Issue #256 AC3） */
export const LANDSCAPE_INSET_SCREENSHOT_PATH =
  `${SAFE_AREA_SCREENSHOT_DIR}/landscape-notch-insets.png`;

/**
 * タイムラインが占有してよい画面高の上限比率。横持ち（390px 高）で
 * デスクトップの縦帯（高さ 358px ≈ 92%）に戻る回帰を検出する。
 * 小画面レイアウトの下端横帯は約 62px（≈ 16%）で余裕を持って収まる。
 */
export const MAX_TIMELINE_HEIGHT_RATIO = 0.5;

/**
 * タイムライン矩形の高さがビューポート高に占める比率を返す純粋関数
 * （landscape-smoke_test.ts でユニットテストする）。
 */
export function timelineHeightRatio(
  rect: Rect,
  viewportHeight: number,
): number {
  return (rect.bottom - rect.top) / viewportHeight;
}

// mobile-smoke.ts と同じライン川（Rhein）上の一点。URL の zoom/center クエリで
// この座標を画面中央に据え、canvas 中央へのタップで picking を検証する。
const RHEIN_POINT: [number, number] = [9.12754, 47.67068];
const TAP_ZOOM = 7;

const CANVAS_CENTER_EXPR =
  "(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()";

export async function run(api: CdpApi): Promise<void> {
  const results: Record<string, unknown> = {};
  await Deno.mkdir(SCREENSHOT_DIR, { recursive: true });
  await Deno.mkdir(SAFE_AREA_SCREENSHOT_DIR, { recursive: true });

  // 1. エミュレーションの反映確認（横持ち: 幅 844 / 高さ 390 / touch）。
  // app.css の横持ち条件は (pointer: coarse) を含むため、メディア判定の
  // 成立もここで確認する（不成立ならハーネス側の前提崩れとして失敗）。
  await api.waitForAppReady();
  const viewport = await api.evaluate<{
    innerWidth: number;
    innerHeight: number;
    devicePixelRatio: number;
    maxTouchPoints: number;
    pointerCoarse: boolean;
  }>(
    `({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      maxTouchPoints: navigator.maxTouchPoints,
      pointerCoarse: matchMedia("(pointer: coarse)").matches,
    })`,
  );
  results.viewport = viewport;
  const emulationOk = viewport.innerWidth === LANDSCAPE_PRESET.width &&
    viewport.innerHeight === LANDSCAPE_PRESET.height &&
    viewport.devicePixelRatio === LANDSCAPE_PRESET.deviceScaleFactor &&
    viewport.maxTouchPoints > 0 &&
    viewport.pointerCoarse;
  results.emulationOk = emulationOk;

  // 2. 地図描画（canvas が存在）とアプリ起動
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
  await api.screenshot(LANDSCAPE_SCREENSHOT_PATH);
  results.screenshot = LANDSCAPE_SCREENSHOT_PATH;

  // 3b. ラベル描画の検査（Issue #320。mobile-smoke と同一の検査）。
  // 4 種のラベルがデータ段に存在し、deck のラベル canvas が
  // devicePixelRatio 倍の解像度を持つこと（= TextLayer が全滅していない
  // こと）を確認する。LANDSCAPE_SCREENSHOT_PATH にラベルが写る前提。
  const labelRenderProbe = await api.evaluate<LabelRenderProbe>(
    LABEL_RENDER_PROBE_EXPR,
  );
  results.labelRenderProbe = labelRenderProbe;
  const labelRenderProblems = findLabelRenderProblems(labelRenderProbe);
  results.labelRenderProblems = labelRenderProblems;
  const labelRenderOk = labelRenderProblems.length === 0;
  results.labelRenderOk = labelRenderOk;

  // 4. タップで picking → 情報パネル表示
  // ライン川を画面中央に据えた URL へ再 navigate し、canvas 中央をタップする。
  const origin = await api.evaluate<string>("location.origin");
  await api.navigate(
    `${origin}/?year=1500&zoom=${TAP_ZOOM}&center=${RHEIN_POINT[0]},${
      RHEIN_POINT[1]
    }`,
  );
  await api.waitForAppReady();
  await api.waitFor("window.__getYear() === 1500", 15000);
  const center = await api.evaluate<[number, number]>(CANVAS_CENTER_EXPR);
  results.tapPoint = center;
  await api.tap(Math.round(center[0]), Math.round(center[1]));
  await new Promise((r) => setTimeout(r, 800));
  const infoPanelLabel = await api.evaluate<string | null>(
    "document.querySelector('.info-panel-label')?.textContent ?? null",
  );
  results.infoPanelLabel = infoPanelLabel;
  await api.screenshot(LANDSCAPE_TAP_SCREENSHOT_PATH);
  results.tapScreenshot = LANDSCAPE_TAP_SCREENSHOT_PATH;

  // 5. タップ当たり判定の計測（Issue #252 AC1/AC2。44px 未満の対象があれば
  // 失敗）。情報パネルが開いた状態（前段の picking 後）で測ることで
  // `.info-panel-close` も計測対象に含める。
  const tapTargetRects = await api.evaluate<UiRect[]>(
    buildUiRectsExpr(TAP_TARGET_SELECTORS),
  );
  results.tapTargetRects = tapTargetRects;
  const smallTapTargets = findSmallTapTargets(tapTargetRects);
  results.smallTapTargets = smallTapTargets;
  const tapTargetsOk = smallTapTargets.length === 0;
  results.tapTargetsOk = tapTargetsOk;

  // 6. タイムラインの画面高占有率（Issue #252。縦帯のままなら ≈ 92% で失敗）
  const timelineRect = await api.evaluate<UiRect[]>(
    buildUiRectsExpr([".timeline"]),
  );
  const ratio = timelineRect.length === 1
    ? timelineHeightRatio(timelineRect[0].rect, viewport.innerHeight)
    : null;
  results.timelineRect = timelineRect;
  results.timelineHeightRatio = ratio;
  const timelineHeightOk = ratio !== null &&
    ratio <= MAX_TIMELINE_HEIGHT_RATIO;
  results.timelineHeightOk = timelineHeightOk;

  // 7. UI の重なり計測（mobile-smoke と同じ基準。重なり検出 = 失敗）
  const uiRects = await api.evaluate<UiRect[]>(
    buildUiRectsExpr(UI_OVERLAP_SELECTORS),
  );
  results.uiRects = uiRects;
  const overlaps = findOverlaps(uiRects);
  results.overlaps = overlaps;
  const overlapsOk = overlaps.length === 0;
  results.overlapsOk = overlapsOk;

  // 7b. Safe Area inset エミュレーション（Issue #256 AC1/AC2）。
  // ヘッドレスでは env(safe-area-inset-*) が 0 のため、app.css が :root に
  // 定義する --safe-area-* 変数を横持ちノッチ相当の値で上書きして再現する。
  // 変数が消費されていなければ UI は動かず inset 帯に残るので、この検査は
  // 「注入が効いていること」自体も兼ねる。検査後は上書きを解除して
  // 後続の検査（エラートースト）を inset 0 に戻す。
  await api.evaluate(buildSetSafeAreaInsetsExpr(LANDSCAPE_NOTCH_INSETS));
  await new Promise((r) => setTimeout(r, 300));
  const safeAreaRects = await api.evaluate<UiRect[]>(
    buildUiRectsExpr(UI_OVERLAP_SELECTORS),
  );
  results.safeAreaRects = safeAreaRects;
  const safeAreaViolations = findSafeAreaViolations(
    safeAreaRects,
    { width: viewport.innerWidth, height: viewport.innerHeight },
    LANDSCAPE_NOTCH_INSETS,
  );
  results.safeAreaViolations = safeAreaViolations;
  const safeAreaOverlaps = findOverlaps(safeAreaRects);
  results.safeAreaOverlaps = safeAreaOverlaps;
  const safeAreaDocScroll = await api.evaluate<
    { scrollWidth: number; clientWidth: number }
  >(
    "({ scrollWidth: document.documentElement.scrollWidth, " +
      "clientWidth: document.documentElement.clientWidth })",
  );
  results.safeAreaDocScroll = safeAreaDocScroll;
  const safeAreaOk = safeAreaViolations.length === 0 &&
    safeAreaOverlaps.length === 0 &&
    safeAreaDocScroll.scrollWidth <=
      safeAreaDocScroll.clientWidth + 1;
  results.safeAreaOk = safeAreaOk;
  await api.screenshot(LANDSCAPE_INSET_SCREENSHOT_PATH);
  results.safeAreaScreenshot = LANDSCAPE_INSET_SCREENSHOT_PATH;
  await api.evaluate(buildClearSafeAreaInsetsExpr());

  // 8. エラートースト非表示の確認
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
      labelRenderOk &&
      infoPanelLabel === "ライン川" &&
      tapTargetsOk &&
      timelineHeightOk &&
      overlapsOk &&
      safeAreaOk &&
      errorToastOk,
  );
  results.overallOk = overallOk;

  console.log(JSON.stringify(results, null, 2));
  if (labelRenderProblems.length > 0) {
    console.log(
      `\n[LABEL-RENDER] エミュレーション下のラベル描画に問題を ` +
        `${labelRenderProblems.length} 件検出（Issue #320）:\n  ` +
        labelRenderProblems.join("\n  "),
    );
  }
  if (smallTapTargets.length > 0) {
    console.log(
      `\n[TAP-TARGET] 横持ちで ${MIN_TAP_TARGET_PX}px 未満のタップ対象を ` +
        `${smallTapTargets.length} 件検出（Issue #252 AC2。上の smallTapTargets を参照）`,
    );
  }
  if (!timelineHeightOk) {
    console.log(
      `\n[TIMELINE] タイムラインが画面高の ${
        MAX_TIMELINE_HEIGHT_RATIO * 100
      }% を超過（実測比率: ${ratio}。Issue #252 の縦帯回帰）`,
    );
  }
  if (overlaps.length > 0) {
    console.log(
      `\n[OVERLAP] 横持ちで UI の重なりを ${overlaps.length} 件検出` +
        "（上の overlaps を参照）",
    );
  }
  if (!safeAreaOk) {
    console.log(
      "\n[SAFE-AREA] 横持ちノッチ inset 注入時の違反を検出" +
        `（Issue #256。violations: ${safeAreaViolations.length} / ` +
        `overlaps: ${safeAreaOverlaps.length} / docScroll: ${
          JSON.stringify(safeAreaDocScroll)
        }）`,
    );
  }
  console.log(overallOk ? "\n[RESULT] PASS" : "\n[RESULT] FAIL");
  if (!overallOk) {
    throw new Error("landscape smoke check failed: see JSON output above");
  }
}
