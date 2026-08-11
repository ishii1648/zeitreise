/**
 * 標準スモークチェック（deno task verify:smoke で使用）。
 *
 * agent-loop の「マージ後の動作確認」フェーズで、無人で以下を確認する:
 *   1. アプリ起動（__getYear が使えるまで waitFor）
 *   2. 年代切替（__setYear → 反映を waitFor。年代反映待ちは
 *      エラートースト表示を検知したら早期 fail する。Issue #282）
 *   3. 河川クリック（rivers.geojson の座標を地図中心に指定して画面中央をクリック）
 *   4. エラートースト非表示の確認
 *   5. スクリーンショット保存
 *
 * dev サーバの URL は `deno task verify:smoke <url>` の <url> 引数で渡す
 * （このスクリプト自体は deno.json の "verify:smoke" タスク定義に含まれる。
 * 直接起動する場合は
 * `deno run -A scripts/verify/cdp.ts <url> scripts/verify/checks/smoke.ts`）。
 */
import type { CdpApi } from "../cdp.ts";

const SCREENSHOT_PATH = "scripts/verify/checks/.smoke-screenshot.png";

/**
 * canvas 中央のビューポート座標を返すブラウザ内評価式。クリック座標は
 * ビューポート基準のため、rect の原点（left/top）を加味する（canvas が
 * 原点以外に配置されるレイアウトでも正しい座標になる）。
 */
export const CANVAS_CENTER_EXPR =
  "(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()";

// ライン川（Rhein）上の一点。URL の zoom/center クエリでこの座標を画面中央に
// 据えることで、rivers.geojson の実座標から画面ピクセル座標を手計算する
// 必要をなくす（Mercator 手計算はズレやすいため、地図側のクエリパラメータ
// 反映機構に投影を任せる）。
const RHEIN_POINT: [number, number] = [9.12754, 47.67068];
const CLICK_ZOOM = 7;

// ---- 年代反映待ち（Issue #282） ----

/**
 * 年代反映（`window.__getYear() === <year>`）待ちのタイムアウト。
 *
 * 年代の反映は該当年の GeoJSON 読み込み完了後に行われるため、この待ちは
 * 実質「本番からの年代データ fetch + 反映」の待ちである。値の根拠:
 *
 * - 計装レプリカでは再 navigate 後約 1.2s、#245 の perf 実測でも本番の初回
 *   appReady（HTML + JS + PMTiles + 初期データ込み）ワーストは 5150ms で、
 *   通常の本番は数秒で収まる。
 * - 一方、旧値 15s は本番のワーストに間欠的に届かなかった（Issue #282:
 *   5 回中 2 回、年が 1000 のまま 15s 経過してタイムアウト。エッジキャッシュ
 *   ミス時はオリジン往復が支配的になり heavy tail になる）。
 * - そこで「実測で不足した 15s」の 3 倍 = 45s を採用する（実測ワースト
 *   appReady 5150ms の約 9 倍の余裕を持たせ、タイミング flake での偽 FAIL を
 *   避ける。なお appReady 待ち自体の予算は #295 で同じ規律により 30s → 90s に
 *   見直された。cdp.ts の APP_READY_TIMEOUT_MS を参照）。
 * - タイムアウトを伸ばす代償（確定失敗時に長く待つ）は、下の
 *   {@linkcode waitForYearReflected} がエラートースト表示を検知した時点で
 *   早期 fail することで抑える。データ取得の確定失敗はトーストに現れる
 *   （自動リトライは無く、トーストは手動の再試行/閉じるまで表示され続ける）
 *   ため、45s をフルに待つのは原因不明のハング時のみ。
 */
export const YEAR_REFLECT_TIMEOUT_MS = 45_000;

/**
 * エラートーストの状態 { present, visible, text } を返すブラウザ内評価式。
 * 年代反映待ちの早期 fail 判定と step 4（エラートースト非表示の確認）で共用。
 */
export const ERROR_TOAST_STATE_EXPR = `(() => {
  const el = document.querySelector('.error-toast');
  if (!el) return { present: false, visible: false, text: null };
  const style = window.getComputedStyle(el);
  const visible = style.display !== 'none' &&
    style.visibility !== 'hidden' && el.offsetParent !== null;
  return { present: true, visible, text: el.textContent };
})()`;

interface ErrorToastState {
  present: boolean;
  visible: boolean;
  text: string | null;
}

/**
 * 「年代が反映された、またはエラートーストが可視になった」で真になる
 * ポーリング式を組み立てる。トースト可視でも真にするのは、データ取得の
 * 確定失敗時にタイムアウトまで待たず早期 fail するため（成否の判別は
 * {@linkcode waitForYearReflected} が待機後に行う）。
 */
export function buildYearReflectedOrErrorExpr(year: number): string {
  return `(() => {
    if (window.__getYear && window.__getYear() === ${year}) return true;
    return ${ERROR_TOAST_STATE_EXPR}.visible;
  })()`;
}

/**
 * 年代反映を待つ。反映されれば resolve。エラートーストが可視になって
 * 待機を抜けた場合はトーストのテキストを含めて reject し、どちらも起きずに
 * タイムアウトした場合は waitFor のタイムアウトエラーがそのまま伝播する。
 */
export async function waitForYearReflected(
  api: Pick<CdpApi, "waitFor" | "evaluate">,
  year: number,
  timeoutMs: number = YEAR_REFLECT_TIMEOUT_MS,
): Promise<void> {
  await api.waitFor(buildYearReflectedOrErrorExpr(year), timeoutMs);
  const reflected = await api.evaluate<boolean>(
    `window.__getYear && window.__getYear() === ${year}`,
  );
  if (reflected) return;
  const toast = await api.evaluate<ErrorToastState>(ERROR_TOAST_STATE_EXPR);
  throw new Error(
    `year ${year} not reflected: error toast visible (${
      JSON.stringify(toast.text)
    })`,
  );
}

export async function run(api: CdpApi): Promise<void> {
  const results: Record<string, unknown> = {};

  // 1. アプリ起動確認
  await api.waitForAppReady();
  await waitForYearReflected(api, 1000);
  const yearInitial = await api.evaluate<number>("window.__getYear()");
  results.yearInitial = yearInitial;

  // 2. 年代切替
  await api.evaluate("window.__setYear(1500)");
  await waitForYearReflected(api, 1500);
  const yearAfterSwitch = await api.evaluate<number>("window.__getYear()");
  results.yearAfterSwitch = yearAfterSwitch;

  // 3. 河川クリック
  // ライン川を画面中央に据えた URL へ再 navigate し、canvas 中央をクリックする。
  const origin = await api.evaluate<string>("location.origin");
  await api.navigate(
    `${origin}/?year=1500&zoom=${CLICK_ZOOM}&center=${RHEIN_POINT[0]},${
      RHEIN_POINT[1]
    }`,
  );
  await api.waitForAppReady();
  await waitForYearReflected(api, 1500);
  const center = await api.evaluate<[number, number]>(CANVAS_CENTER_EXPR);
  results.clickPoint = center;
  await api.click(Math.round(center[0]), Math.round(center[1]));
  await new Promise((r) => setTimeout(r, 800));
  const infoPanelLabel = await api.evaluate<string | null>(
    "document.querySelector('.info-panel-label')?.textContent ?? null",
  );
  results.infoPanelLabel = infoPanelLabel;

  // 4. エラートースト非表示の確認
  const errorToast = await api.evaluate<ErrorToastState>(
    ERROR_TOAST_STATE_EXPR,
  );
  results.errorToast = errorToast;
  const errorToastOk = !errorToast.present || !errorToast.visible;
  results.errorToastOk = errorToastOk;

  // 5. スクリーンショット
  await api.screenshot(SCREENSHOT_PATH);
  results.screenshot = SCREENSHOT_PATH;

  const overallOk = Boolean(
    yearInitial === 1000 &&
      yearAfterSwitch === 1500 &&
      infoPanelLabel === "ライン川" &&
      errorToastOk,
  );
  results.overallOk = overallOk;

  console.log(JSON.stringify(results, null, 2));
  console.log(overallOk ? "\n[RESULT] PASS" : "\n[RESULT] FAIL");
  if (!overallOk) {
    throw new Error("smoke check failed: see JSON output above");
  }
}
