/**
 * ロード性能計測ハーネス（TASK-128、deno task verify:perf で使用）。
 *
 * ヘッドレス CDP（scripts/verify/cdp.ts）経由で以下を無人計測し、gitignore
 * 済みのパス（scripts/verify/checks/.perf-*.json）へ JSON で書き出す:
 *   1. 初期ロード: 政治レイヤー描画済み（isAppReady。#244）までの所要時間・
 *      圧縮後の総転送量（Resource Timing の transferSize 合計）・非圧縮換算
 *      サイズ（decodedBodySize 合計）
 *   2. 年代切替: SNAPSHOT_YEARS の全年代を順に切り替え、1 回あたりの所要時間と
 *      追加転送量（切替前後の Resource Timing 差分）
 *   3. 全年代切替後の JS heap 使用量（performance.memory）
 *
 * 計測はすべてページ内の Resource Timing / performance.memory を evaluate で
 * 読むだけで完結させ、CDP Network ドメインへの依存を増やさない（cdp.ts の
 * CdpApi をそのまま使う）。
 *
 * before/after 比較の使い方:
 *   deno task serve --port 8128 &
 *   PERF_OUT=scripts/verify/checks/.perf-before.json \
 *     deno task verify:perf http://localhost:8128/
 *   （変更を適用して再ビルド）
 *   PERF_OUT=scripts/verify/checks/.perf-after.json \
 *     deno task verify:perf http://localhost:8128/
 *   PERF_OUT 未指定時は UTC タイムスタンプ付きファイル名で出力する。
 */
import type { CdpApi } from "../cdp.ts";
import { INITIAL_YEAR, SNAPSHOT_YEARS } from "../../../src/config.ts";

// ---- 純ロジック（perf_test.ts でユニットテストする関数群） ----

/** Resource Timing エントリのうち転送量計測に使うフィールド。 */
export interface ResourceSizes {
  transferSize?: number;
  encodedBodySize?: number;
  decodedBodySize?: number;
}

/** リソース群の転送量サマリ。 */
export interface ResourceSummary {
  count: number;
  /** ヘッダ込みの実転送バイト数（圧縮後）。 */
  transferBytes: number;
  /** 圧縮後の body バイト数。 */
  encodedBodyBytes: number;
  /** 非圧縮換算の body バイト数。 */
  decodedBodyBytes: number;
}

/** Resource Timing エントリ群の転送量を合算する（欠損フィールドは 0 扱い）。 */
export function summarizeResources(
  entries: readonly ResourceSizes[],
): ResourceSummary {
  const summary: ResourceSummary = {
    count: entries.length,
    transferBytes: 0,
    encodedBodyBytes: 0,
    decodedBodyBytes: 0,
  };
  for (const e of entries) {
    summary.transferBytes += e.transferSize ?? 0;
    summary.encodedBodyBytes += e.encodedBodySize ?? 0;
    summary.decodedBodyBytes += e.decodedBodySize ?? 0;
  }
  return summary;
}

/**
 * 年代切替の巡回対象を返す。初期表示済みの年代だけを除いた全スナップショット
 * 年代（昇順のまま）。初期年代を含めると 2 回目の表示（キャッシュヒット）が
 * 混ざり「1 回あたりの追加転送量」の計測を汚すため除外する。
 */
export function yearsToCycle(
  snapshotYears: readonly number[],
  initialYear: number,
): number[] {
  return snapshotYears.filter((y) => y !== initialYear);
}

/** Resource Timing エントリのうち取得開始時刻の抽出に使うフィールド。 */
export interface ResourceStart {
  name: string;
  startTime: number;
}

/**
 * 名前に substring を含むリソースのうち最小の startTime（navigation 起点 ms）を
 * 返す（純粋関数。#247）。PMTiles の取得開始時刻の計測に使う: app.js の分割で
 * 初期チャンクの評価が早まると、この値が前倒しされる。一致が無ければ null
 * （PMTiles 未配置環境でも計測全体は落とさない）。
 */
export function firstStartTimeMatching(
  entries: readonly ResourceStart[],
  substring: string,
): number | null {
  let min: number | null = null;
  for (const e of entries) {
    if (!e.name.includes(substring)) continue;
    if (min === null || e.startTime < min) min = e.startTime;
  }
  return min;
}

/** 年代切替 1 回分の計測値。 */
export interface YearSwitchMetrics {
  durationMs: number;
  transferBytes: number;
  decodedBodyBytes: number;
}

/** 年代切替計測の平均（1 回あたり）を返す。空なら null。 */
export function averageYearSwitch(
  switches: readonly YearSwitchMetrics[],
): YearSwitchMetrics | null {
  if (switches.length === 0) return null;
  const avg = (f: (s: YearSwitchMetrics) => number) =>
    Math.round(switches.reduce((sum, s) => sum + f(s), 0) / switches.length);
  return {
    durationMs: avg((s) => s.durationMs),
    transferBytes: avg((s) => s.transferBytes),
    decodedBodyBytes: avg((s) => s.decodedBodyBytes),
  };
}

/**
 * READY_EXPR がページ内で収集する初期ロード完了の判定材料（#244）。
 * READY_PROBE_EXPR が組み立て、isAppReady が判定する。
 */
export interface ReadyProbe {
  /**
   * `__getPowerLabelDebug().total.base`（政治レイヤー base の勢力名ラベル
   * 総数）。フック未定義（バンドル未実行）のときは null。フックは
   * currentView 未確定（初期年代 GeoJSON 未反映）のとき 0 を返し、
   * main.ts では currentView の確定と renderLayers()（政治レイヤーの組み
   * 立て）が同一同期タスク内で行われるため、1 以上が観測できた時点で
   * 政治レイヤーは描画済みと判定できる。
   */
  politicalBaseLabelCount: number | null;
  /** `#loading-spinner` の hidden。要素が存在しないときは null。 */
  spinnerHidden: boolean | null;
}

/**
 * アプリの初期ロードが完了したか（#244）。
 *
 * 旧判定（__getYear の存在 + spinner hidden + リソース 6 件以上）はすべて
 * 「バンドル実行直後」に満たされる偽陽性だった: __getYear は installDebugHooks
 * が無条件で生やし、spinner は index.html の初期状態から hidden 属性付き、
 * リソース 6 件は CSS 2 件 + app.js + PMTiles ヘッダで即座に届く。
 *
 * 新判定は「政治レイヤーの base ラベルが 1 件以上」（= 初期年代 GeoJSON が
 * 反映され renderLayers が走った後にのみ真）を必須とし、spinner は
 * 「表示中（hidden === false）なら未完了」という否定条件にだけ使う
 * （要素が消えても永久待機しない）。
 *
 * 注意: この関数は Function.prototype.toString で直列化してブラウザへ送る
 * ため、外側のスコープを一切参照しない自己完結な式だけで書くこと。
 */
export function isAppReady(probe: ReadyProbe): boolean {
  if (probe.spinnerHidden === false) return false;
  return typeof probe.politicalBaseLabelCount === "number" &&
    probe.politicalBaseLabelCount > 0;
}

/**
 * 計測結果 JSON の出力先を決める。環境変数 PERF_OUT があればそれを、無ければ
 * UTC タイムスタンプ付きの既定パスを返す。既定パスは .gitignore の
 * `scripts/verify/checks/.perf-*.json` に一致し、リポジトリにコミットされない。
 */
export function resolveOutPath(
  getEnv: (key: string) => string | undefined,
  now: Date,
): string {
  const override = getEnv("PERF_OUT");
  if (override) return override;
  const stamp = now.toISOString().replace(/\.\d+Z$/, "Z").replaceAll(
    /[-:]/g,
    "",
  );
  return `scripts/verify/checks/.perf-${stamp}.json`;
}

// ---- ブラウザ内評価式 ----

/** Resource Timing の件数（切替前後の差分計測に使う）。 */
const RESOURCE_COUNT_EXPR = 'performance.getEntriesByType("resource").length';

/** index 以降の Resource Timing エントリを転送量フィールドだけ抜き出す式。 */
function resourceSliceExpr(from: number): string {
  return `performance.getEntriesByType("resource").slice(${from})` +
    ".map((e) => ({ transferSize: e.transferSize, " +
    "encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize }))";
}

/**
 * 全 Resource Timing エントリの名前と取得開始時刻を抜き出す式（#247）。
 * firstStartTimeMatching で PMTiles の取得開始時刻を求める入力になる。
 */
const RESOURCE_START_EXPR = 'performance.getEntriesByType("resource")' +
  ".map((e) => ({ name: e.name, startTime: e.startTime }))";

/** Navigation Timing（ドキュメント自身の転送量・ロードイベント時刻）。 */
const NAVIGATION_EXPR = "(() => {" +
  'const n = performance.getEntriesByType("navigation")[0];' +
  "return n ? { transferSize: n.transferSize, " +
  "encodedBodySize: n.encodedBodySize, decodedBodySize: n.decodedBodySize, " +
  "domContentLoadedEventEnd: n.domContentLoadedEventEnd, " +
  "loadEventEnd: n.loadEventEnd } : null;" +
  "})()";

/** JS heap 使用量（Chrome 固有の performance.memory。無ければ null）。 */
const JS_HEAP_EXPR = "(() => {" +
  "const m = performance.memory;" +
  "return m ? { usedJSHeapSize: m.usedJSHeapSize, " +
  "totalJSHeapSize: m.totalJSHeapSize, jsHeapSizeLimit: m.jsHeapSizeLimit } " +
  ": null;" +
  "})()";

/**
 * ネットワーク完了時刻（navigation 起点の ms）。ドキュメントの loadEventEnd と
 * 全リソースの responseEnd の最大値で、ポーリング粒度に依存しない精密な
 * 「初期ロード完了までの所要時間」として使う。
 */
const NETWORK_QUIET_MS_EXPR = "(() => {" +
  'const nav = performance.getEntriesByType("navigation")[0];' +
  'const ends = performance.getEntriesByType("resource")' +
  ".map((e) => e.responseEnd);" +
  "return Math.max(nav ? nav.loadEventEnd : 0, 0, ...ends);" +
  "})()";

/**
 * isAppReady へ渡す ReadyProbe をページ内で組み立てる式（#244）。
 * 判定材料は既存デバッグフック __getPowerLabelDebug（src/debug_hooks.ts。
 * builder とメモ化キャッシュを共有するため、描画済みならポーリングしても
 * ラベル再計算を誘発しない）とスピナーの表示状態のみで、Resource Timing の
 * 件数には依存しない。
 */
const READY_PROBE_EXPR = "({ " +
  "politicalBaseLabelCount: " +
  'typeof globalThis.__getPowerLabelDebug === "function" ' +
  "? globalThis.__getPowerLabelDebug().total.base : null, " +
  "spinnerHidden: (() => { " +
  'const el = document.getElementById("loading-spinner"); ' +
  "return el === null ? null : el.hidden === true; })() " +
  "})";

/**
 * アプリの初期ロードが完了した状態（#244）。テスト済みの純ロジック
 * isAppReady をそのまま直列化し、READY_PROBE_EXPR が集めた判定材料へ適用
 * する（判定式とテスト対象が乖離しない）。
 */
export const READY_EXPR = `(${isAppReady})(${READY_PROBE_EXPR})`;

/** api.waitFor（500ms 間隔）より細かい 100ms 間隔のポーリング待機。 */
async function waitUntil(
  api: CdpApi,
  expr: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await api.evaluate<boolean>(`Boolean(${expr})`)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms: ${expr}`);
}

/**
 * ネットワーク静止（Resource Timing の件数が idlePolls 回連続で不変）まで
 * 待つ。スピナー消灯後に遅れて届くフォント・ラベル等の取りこぼしを防ぐ。
 */
async function waitForNetworkIdle(
  api: CdpApi,
  { pollMs = 200, idlePolls = 5, timeoutMs = 30_000 } = {},
): Promise<void> {
  const start = Date.now();
  let last = -1;
  let stable = 0;
  while (Date.now() - start < timeoutMs) {
    const count = await api.evaluate<number>(RESOURCE_COUNT_EXPR);
    stable = count === last ? stable + 1 : 0;
    last = count;
    if (stable >= idlePolls) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitForNetworkIdle timed out after ${timeoutMs}ms`);
}

const SETTLE_MS = 500;

// ---- 本体 ----

export async function run(api: CdpApi): Promise<void> {
  // cdp.ts の CLI が既に 1 度 navigate 済みなので、そこから origin を得て
  // 計測用に再 navigate する（タイムラインを 0 から取り直すため）。
  const origin = await api.evaluate<string>("location.origin");
  const url = `${origin}/`;

  // CLI の 1 回目の navigate で温まった HTTP キャッシュを無効化してから
  // 再 navigate する（有効なままだと 304 revalidation だらけになり、
  // コールドロードの転送量を測れない）。
  await api.setCacheDisabled(true);

  // 1. 初期ロード
  const t0 = Date.now();
  await api.navigate(url);
  // Resource Timing のバッファ既定値（250 件）を超えて年代を巡回しても
  // エントリが落ちないよう先に広げる。
  await api.evaluate("performance.setResourceTimingBufferSize(100000)");
  await waitUntil(api, READY_EXPR, 60_000);
  const appReadyMs = Date.now() - t0;
  await waitForNetworkIdle(api);

  const navigation = await api.evaluate<
    | {
      transferSize: number;
      encodedBodySize: number;
      decodedBodySize: number;
      domContentLoadedEventEnd: number;
      loadEventEnd: number;
    }
    | null
  >(NAVIGATION_EXPR);
  const initialEntries = await api.evaluate<ResourceSizes[]>(
    resourceSliceExpr(0),
  );
  const initialResources = summarizeResources(initialEntries);
  const networkQuietMs = Math.round(
    await api.evaluate<number>(NETWORK_QUIET_MS_EXPR),
  );
  // #247: PMTiles（ベースマップ）への最初のリクエスト開始時刻。app.js の分割で
  // 初期チャンクの取得・評価が早まるほど、この値が前倒しされる（AC4 の記録）。
  const resourceStarts = await api.evaluate<ResourceStart[]>(
    RESOURCE_START_EXPR,
  );
  const rawPmtilesStart = firstStartTimeMatching(resourceStarts, ".pmtiles");
  const pmtilesFirstStartMs = rawPmtilesStart === null
    ? null
    : Math.round(rawPmtilesStart);
  const initialLoad = {
    /** navigate 開始から政治レイヤー描画済み（isAppReady）までの実測時間
     * （粒度 100ms。#244） */
    appReadyMs,
    /** navigation 起点で最後のリソース受信が完了した時刻（精密値） */
    networkQuietMs,
    /** PMTiles への最初のリクエスト開始時刻（navigation 起点 ms。#247） */
    pmtilesFirstStartMs,
    navigation,
    resources: initialResources,
    /** ドキュメント + 全リソースの実転送量（圧縮後・ヘッダ込み） */
    totalTransferBytes: (navigation?.transferSize ?? 0) +
      initialResources.transferBytes,
    /** 非圧縮換算の合計サイズ */
    totalDecodedBytes: (navigation?.decodedBodySize ?? 0) +
      initialResources.decodedBodyBytes,
  };

  // 2. 年代切替（全年代を順に巡回し、1 回ごとに所要時間と追加転送量を計測）
  const yearSwitches: Array<
    YearSwitchMetrics & { year: number; resourceCount: number }
  > = [];
  for (const year of yearsToCycle(SNAPSHOT_YEARS, INITIAL_YEAR)) {
    const before = await api.evaluate<number>(RESOURCE_COUNT_EXPR);
    const start = Date.now();
    await api.evaluate(`window.__setYear(${year})`);
    await waitUntil(api, `window.__getYear() === ${year}`, 30_000);
    const durationMs = Date.now() - start;
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const entries = await api.evaluate<ResourceSizes[]>(
      resourceSliceExpr(before),
    );
    const summary = summarizeResources(entries);
    yearSwitches.push({
      year,
      durationMs,
      transferBytes: summary.transferBytes,
      decodedBodyBytes: summary.decodedBodyBytes,
      resourceCount: summary.count,
    });
  }

  // 3. 全年代切替後の JS heap
  const jsHeap = await api.evaluate<
    | {
      usedJSHeapSize: number;
      totalJSHeapSize: number;
      jsHeapSizeLimit: number;
    }
    | null
  >(JS_HEAP_EXPR);

  const report = {
    meta: {
      url,
      timestamp: new Date().toISOString(),
      userAgent: await api.evaluate<string>("navigator.userAgent"),
      initialYear: INITIAL_YEAR,
      cycledYears: yearsToCycle(SNAPSHOT_YEARS, INITIAL_YEAR),
    },
    initialLoad,
    yearSwitches,
    yearSwitchAverage: averageYearSwitch(yearSwitches),
    jsHeap,
  };

  const outPath = resolveOutPath((k) => Deno.env.get(k), new Date());
  await Deno.writeTextFile(outPath, JSON.stringify(report, null, 2) + "\n");

  console.log(JSON.stringify(report, null, 2));
  console.log(`\n[PERF] wrote ${outPath}`);
}
