/**
 * ヘッドレス Chrome + CDP（Chrome DevTools Protocol）による動作確認ハーネス。
 *
 * claude-in-chrome 拡張（可視ウィンドウ必須・ツール呼び出し毎に人間の承認確認
 * = HITL が発生する）に代わり、agent-loop の自律実行中に無人で動作確認を
 * 完結させるための標準手段。実 GPU の `--headless=new` で描画・requestAnimationFrame
 * が動作し、任意 JS 評価・座標指定クリック・キー入力・スクリーンショットを行える。
 *
 * 使い方（ライブラリとして）:
 *   import { DEFAULT_APP_URL, launch } from "./cdp.ts";
 *   const api = await launch();
 *   await api.navigate(DEFAULT_APP_URL);  // dev サーバの既定ポートに追従する
 *   await api.waitForAppReady();
 *   ...
 *   await api.close();
 *
 * 使い方（CLI として）:
 *   deno run -A scripts/verify/cdp.ts <url> <checkScript.ts>
 *   引数順は任意（http(s):// で始まる引数を URL、それ以外を checkScript と
 *   みなす）。標準スモークは `deno task verify:smoke <url>` で起動できる
 *   （checkScript は deno.json のタスク定義に含まれる）。
 *   checkScript.ts は `export async function run(api: CdpApi) { ... }` を
 *   export する。
 *
 * リモート CDP モード（Issue #169）:
 *   環境変数 CDP_BROKER にホスト側 chrome-broker の HTTP ベース URL を
 *   指定すると、ローカルで Chrome を spawn せず broker から取得した外部
 *   Chrome の CDP エンドポイントへ接続する（詳細は本ファイルの
 *   「リモート CDP モード」セクションと docs/development-style.md 4.3.1）。
 *
 * 制約（ヘッドレス検証で踏んだ落とし穴）:
 * - `document.visibilityState` に依存する分岐がある場合、ヘッドレスでも
 *   "visible" 扱いになるとは限らないため、可視性に依存しないロジックを使うこと。
 * - 実 GPU 描画のために `--disable-gpu` は付けない（付けると canvas が
 *   描画されない・スクリーンショットが真っ黒になる等の問題が起きる）。
 * - `window.__getYear()` はアプリの初期化完了前は初期値を返すレースが
 *   ある。`waitFor` で目的の値になるまで明示的に待つこと
 *   （`waitForAppReady` だけでは「関数が存在する」ことしか保証しない）。
 * - デバイスエミュレーション（`--device=...`）を掛けるときは Chrome 起動時に
 *   `--force-device-scale-factor=<DPR>` も必要（{@linkcode buildChromeArgs}）。
 *   `Emulation.setDeviceMetricsOverride` だけでは deck.gl のラベル canvas が
 *   CSS ピクセル解像度のまま残り、TextLayer のラベルが 1 つも描画されない
 *   （Issue #320。原因の実測は label_render.ts 冒頭）。リモート CDP モード
 *   （`CDP_BROKER`）では broker 側 Chrome に同等の設定が要る。
 */

import { isAbsolute, join, toFileUrl } from "@std/path";
import { DEFAULT_PORT } from "../serve.ts";
import {
  buildDeviceMetricsParams,
  buildDeviceScaleFactorArgs,
  buildTapEvents,
  buildTouchEmulationParams,
  buildWindowSizeArg,
  DEVICE_PRESETS,
  type EmulationConfig,
  resolveDevicePreset,
} from "./emulation.ts";

/**
 * `deno task serve` が既定で配信する URL。ポート番号の定義元は
 * scripts/serve.ts の {@linkcode DEFAULT_PORT} 1 箇所とし、ここでは
 * リテラルを書かない（かつて 8011 と書かれてドリフトしていた: TASK-89）。
 */
export const DEFAULT_APP_URL = `http://localhost:${DEFAULT_PORT}/`;

const DEFAULT_CHROME_BIN =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Chrome バイナリパスを返す。環境変数 CHROME_BIN で上書きできる。 */
function resolveChromeBin(): string {
  return Deno.env.get("CHROME_BIN") ?? DEFAULT_CHROME_BIN;
}

export interface CdpApi {
  navigate(url: string): Promise<void>;
  /**
   * ブラウザ HTTP キャッシュの有効/無効を切り替える（TASK-128）。
   * CLI が最初に navigate した後に再 navigate して計測するハーネスでは、
   * 無効化しないと 2 回目のロードが 304 revalidation だらけになり
   * コールドロードの転送量を測れない。
   */
  setCacheDisabled(disabled: boolean): Promise<void>;
  /**
   * 画面・端末条件のエミュレーションを実行中に切り替える（Issue #254）。
   * launch 時の emulation と同じく Emulation.setDeviceMetricsOverride と
   * Emulation.setTouchEmulationEnabled を送る。mobile-smoke が 390x844 の
   * 計測後に 320x568（SMALL_MOBILE_PRESET）へ切り替えて再計測するのに使う。
   */
  setEmulation(config: EmulationConfig): Promise<void>;
  evaluate<T = unknown>(expr: string): Promise<T>;
  waitFor(expr: string, timeoutMs?: number): Promise<void>;
  waitForAppReady(timeoutMs?: number): Promise<void>;
  /** クリックを伴わないマウス移動（ホバー強調の確認に使う。TASK-90） */
  hover(x: number, y: number): Promise<void>;
  click(x: number, y: number): Promise<void>;
  /** タップ相当のタッチ入力（Input.dispatchTouchEvent。TASK-131）。
   * タッチエミュレーション有効時（EmulationConfig.touch）に使う。 */
  tap(x: number, y: number): Promise<void>;
  keys(key: string, count?: number): Promise<void>;
  screenshot(path: string): Promise<void>;
  close(): Promise<void>;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
}

interface CdpTarget {
  type?: string;
  webSocketDebuggerUrl?: string;
}

interface EvaluateResult {
  result?: { value?: unknown };
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string };
  };
}

// ---- 純ロジック（プロセス起動に依存せずユニットテスト可能な関数群） ----

/**
 * `/json/list` のターゲット一覧から、接続すべきページターゲットの
 * webSocketDebuggerUrl を選ぶ（type=page かつ webSocketDebuggerUrl を持つ
 * 最初のもの）。該当が無ければ例外を投げる。
 */
export function pickPageTargetUrl(targets: CdpTarget[]): string {
  const target = targets.find((t) =>
    t.type === "page" && t.webSocketDebuggerUrl
  );
  if (!target?.webSocketDebuggerUrl) {
    throw new Error("No page target with webSocketDebuggerUrl found");
  }
  return target.webSocketDebuggerUrl;
}

/**
 * `Runtime.evaluate` のレスポンスから評価結果の値を取り出す。
 * 例外が発生していれば description（無ければ text）で Error を投げる。
 */
export function parseEvaluateResult<T = unknown>(
  res: { result?: EvaluateResult },
): T {
  const result = res.result as EvaluateResult ?? {};
  if (result.exceptionDetails) {
    const desc = result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text ?? "unknown evaluation error";
    throw new Error(`evaluate() threw: ${desc}`);
  }
  return result.result?.value as T;
}

// キー入力で使う最小のキーコード表（検証スクリプトで必要なキーのみ）。
const KEY_CODES: Record<string, { keyCode: number; code: string }> = {
  ArrowDown: { keyCode: 40, code: "ArrowDown" },
  ArrowUp: { keyCode: 38, code: "ArrowUp" },
  ArrowLeft: { keyCode: 37, code: "ArrowLeft" },
  ArrowRight: { keyCode: 39, code: "ArrowRight" },
  Enter: { keyCode: 13, code: "Enter" },
  Tab: { keyCode: 9, code: "Tab" },
  Escape: { keyCode: 27, code: "Escape" },
};

/** キー名から keyCode/code を解決する。未対応キーは例外を投げる。 */
export function resolveKeyCode(
  key: string,
): { keyCode: number; code: string } {
  const mapped = KEY_CODES[key];
  if (!mapped) {
    throw new Error(`keys(): unsupported key "${key}"`);
  }
  return mapped;
}

/** waitFor に渡す式を `Boolean(...)` でラップする（真偽値化）。 */
export function buildWaitForExpr(expr: string): string {
  return `Boolean(${expr})`;
}

// ---- appReady 待ち（タイムアウト値・待機条件・タイムアウト診断。Issue #295） ----

/**
 * appReady 待ち（{@linkcode CdpApi.waitForAppReady}）の既定タイムアウト。
 *
 * 値の根拠（Issue #295）:
 * - 本番の初回 appReady は通常数秒で成立する（#245 の perf 実測ワーストは
 *   5150ms。FAIL 直後の診断でも readyState complete → `__getYear` 定義まで
 *   約 2s）。
 * - 一方、旧値 30s（実測ワーストの約 6 倍の予算）でも間欠的に届かない
 *   ケースが実測された（2026-08-12: 本番 URL への verify:smoke が冒頭
 *   2 回連続で appReady 待ち 30s タイムアウト。エッジキャッシュのコールド等が
 *   候補だが原因未特定の heavy tail）。
 * - そこで #282 の前例（年代反映待ち: 実測で不足した 15s の 3 倍 = 45s）と
 *   同じ規律で「実測で不足した 30s」の 3 倍 = 90s を採用する。
 * - タイムアウトを伸ばす代償（確定失敗時に長く待つ）について: appReady は
 *   バンドルのロード・実行〜デバッグフック設置までの待ちであり、エラー
 *   トースト等の「確定失敗」シグナル自体がバンドル実行後にしか存在しない
 *   ため、年代反映待ち（#282）のような早期 fail 条件は組み込めない。90s を
 *   フルに待つのはアプリが一度も起動しない異常時のみで、無人ループの
 *   偽 FAIL（やり直しコスト）の方が高くつくと判断した。
 *
 * Issue #311 での見直し: 値は 90s のまま据え置く（原因は待ち不足ではなく
 * 終端状態だったため、引き上げても意味が無い）。ただし本値は**総予算**の
 * 意味に変わり、{@linkcode APP_READY_MAX_ATTEMPTS} 回の試行へ等分される。
 */
export const APP_READY_TIMEOUT_MS = 90_000;

/**
 * appReady の待機条件式。「デバッグフック `__getYear` が定義済み（バンドル
 * 実行完了）かつ loading-spinner が非表示（進行中の初期ロードなし）」。
 * spinner 要素が無い場合（`?.hidden` が undefined）も ready 扱いにする。
 * 初期データ取得の失敗時も spinner は隠れてトーストに切り替わる
 * （src/ui/loading.ts）ため、この条件は失敗時にハングせず、成否の判定は
 * 後続の年代反映待ち（checks/smoke.ts の waitForYearReflected）が担う。
 * 条件自体は #295 でも妥当と判断し変更しない（見直し記録）。
 */
export const APP_READY_EXPR =
  "window.__getYear && document.querySelector('.loading-spinner')?.hidden !== false";

/**
 * appReady 待ちタイムアウト時に採取する、待機条件の各要素の最終観測値
 * （どこで時間を食っているかの切り分け用。Issue #295 AC2）。
 */
export interface AppReadyDiagnostics {
  /** document.readyState（HTML パース〜サブリソースロードの進み具合） */
  readyState: string;
  /** window.__getYear が定義済みか（バンドル実行〜デバッグフック設置完了） */
  getYearDefined: boolean;
  /** .loading-spinner 要素が存在するか */
  spinnerPresent: boolean;
  /** spinner の hidden 属性（要素が無ければ null） */
  spinnerHidden: boolean | null;
  /** エラートーストが可視か（初期ロードの確定失敗の兆候） */
  errorToastVisible: boolean;
}

/** {@linkcode AppReadyDiagnostics} を採取するブラウザ内評価式。 */
export const APP_READY_DIAG_EXPR = `(() => {
  const spinner = document.querySelector('.loading-spinner');
  const toast = document.querySelector('.error-toast');
  return {
    readyState: document.readyState,
    getYearDefined: typeof window.__getYear === 'function',
    spinnerPresent: spinner !== null,
    spinnerHidden: spinner === null ? null : spinner.hidden,
    errorToastVisible: toast !== null && !toast.hidden,
  };
})()`;

/** 最終観測値を 1 行のテキストに整形する（エラーメッセージ用）。 */
export function formatAppReadyDiagnostics(diag: AppReadyDiagnostics): string {
  return `__getYear defined=${diag.getYearDefined}, ` +
    `loading-spinner present=${diag.spinnerPresent} hidden=${diag.spinnerHidden}, ` +
    `document.readyState=${diag.readyState}, ` +
    `error-toast visible=${diag.errorToastVisible}`;
}

/**
 * waitFor のタイムアウトメッセージに診断テキストを付加する。
 * note が指定された場合は再 navigate の試行状況も併記する（Issue #311）。
 */
export function buildAppReadyTimeoutMessage(
  baseMessage: string,
  diagText: string,
  note?: { attempts: number; renavigated: number; renavigateError?: string },
): string {
  const base = `${baseMessage} [appReady diagnostics: ${diagText}]`;
  if (note === undefined) return base;
  const tail = note.renavigateError !== undefined
    ? `re-navigate failed: ${note.renavigateError}`
    : `re-navigated ${note.renavigated}`;
  return `${base} (attempts=${note.attempts}, ${tail})`;
}

// ---- チャンク取得の一過性失敗からの再 navigate 復帰（Issue #311） ----
//
// 実測で特定した失敗モード（#311）:
//   デバッグフック（__getYear ほか）の設置は動的 import した deck.gl チャンク
//   （src/deck_app.ts）の解決後に行われる（src/main.ts の deckAppPromise.then）。
//   そのチャンクの取得が一度でも失敗すると、
//   (a) HTML と静的モジュールグラフのロードは完了するので readyState は
//       complete になり、
//   (b) main.ts は console.warn/error を出すだけで縮退継続するためエラー
//       トーストも spinner も出ず、
//   (c) 失敗した動的 import は HTML 仕様どおり module map に失敗が記録され、
//       同一 specifier の再 import は再フェッチされない
//       （実測: 同一文書のままいくら待っても __getYear は生えない）。
//   つまり「__getYear defined=false / spinner present=true hidden=true /
//   readyState=complete / error-toast visible=false」は**進行中の遅い読み込み
//   ではなく終端状態**であり、待ち時間をいくら伸ばしても解消しない
//   （#295 で 30s → 90s に伸ばしても再発したのはこのため）。
//
// 復帰手段は新しい文書を作ること（= 再 navigate）だけである。実測で、
// 一過性の失敗が去った後の再 navigate は成功し、失敗が継続している間の
// 再 navigate は依然失敗する（= 本当の破損を握り潰さない）ことを確認した。

/**
 * 再 navigate を挟む appReady 待ちの試行回数。総予算
 * （{@linkcode APP_READY_TIMEOUT_MS}）は変えず、それを等分して各試行に割り当てる
 * （待ち時間の再引き上げはしないという #311 の方針）。
 */
export const APP_READY_MAX_ATTEMPTS = 3;

/** 総予算を試行回数で等分した 1 試行分の待ち時間（最低 1ms）。 */
export function computeAppReadyAttemptTimeoutMs(
  totalMs: number,
  attempts: number,
): number {
  if (attempts <= 1) return totalMs;
  return Math.max(1, Math.floor(totalMs / attempts));
}

/**
 * 観測値が「再 navigate で復帰し得る終端状態」かを判定する。
 *
 * - `readyState === "complete"`: HTML と静的モジュールグラフのロードは完了して
 *   いる（＝まだ読み込み中なのではない）。complete 未満なら単に遅いだけなので
 *   文書を捨てない。
 * - `!getYearDefined`: デバッグフックが設置されていない＝動的チャンクが未解決。
 * - `!errorToastVisible`: トーストが出ているならアプリのエラーパスに入った
 *   確定失敗であり、再 navigate ではなく FAIL として報告すべき。
 */
export function isRecoverableAppReadyStall(diag: AppReadyDiagnostics): boolean {
  return diag.readyState === "complete" && !diag.getYearDefined &&
    !diag.errorToastVisible;
}

/** promise に上限時間を付ける（再 navigate が無期限に待たないようにする）。 */
export function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * appReady を待つ実体。汎用 waitFor は変更せず、appReady 専用に
 * 「タイムアウト時に最終観測値を採取し、終端状態なら再 navigate して
 * 試行し直す」層を重ねる。waitFor / evaluate / renavigate だけに依存するため、
 * 実ブラウザ無しでユニットテストできる（launch() 内の
 * {@linkcode CdpApi.waitForAppReady} はこれへの委譲）。
 *
 * - waitFor のタイムアウト（"waitFor timed out" で始まるエラー）のみ診断を
 *   付加する。接続断などそれ以外のエラーは診断の evaluate も失敗するはず
 *   なので、そのまま伝播させる。
 * - 診断の採取自体が失敗しても元のタイムアウトエラーを失わない
 *   （"diagnostics unavailable" として理由を併記する）。
 * - `renavigate` が渡され、かつ観測値が
 *   {@linkcode isRecoverableAppReadyStall} を満たす場合のみ、文書を作り直して
 *   最大 {@linkcode APP_READY_MAX_ATTEMPTS} 回まで試行する（Issue #311）。
 *   渡されない（まだ navigate していない）場合の挙動は従来どおり 1 回で失敗。
 */
export async function waitForAppReadyWith(
  api: Pick<CdpApi, "waitFor" | "evaluate"> & {
    /** 直前に navigate した URL への再 navigate（無い場合は再試行しない）。 */
    renavigate?: () => Promise<void>;
  },
  timeoutMs: number = APP_READY_TIMEOUT_MS,
  maxAttempts: number = APP_READY_MAX_ATTEMPTS,
): Promise<void> {
  const attemptTimeoutMs = computeAppReadyAttemptTimeoutMs(
    timeoutMs,
    maxAttempts,
  );
  let renavigated = 0;
  for (let attempt = 1;; attempt++) {
    try {
      await api.waitFor(APP_READY_EXPR, attemptTimeoutMs);
      return;
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith("waitFor timed out")) {
        throw e;
      }
      let diag: AppReadyDiagnostics | null = null;
      let diagText: string;
      try {
        diag = await api.evaluate<AppReadyDiagnostics>(APP_READY_DIAG_EXPR);
        diagText = formatAppReadyDiagnostics(diag);
      } catch (diagError) {
        diagText = `diagnostics unavailable: ${
          diagError instanceof Error ? diagError.message : String(diagError)
        }`;
      }
      const canRetry = api.renavigate !== undefined && attempt < maxAttempts &&
        diag !== null && isRecoverableAppReadyStall(diag);
      if (!canRetry) {
        throw new Error(
          buildAppReadyTimeoutMessage(
            e.message,
            diagText,
            renavigated === 0 ? undefined : { attempts: attempt, renavigated },
          ),
        );
      }
      console.warn(
        `appReady 待ちが終端状態でタイムアウトしました（試行 ${attempt}/${maxAttempts}）。` +
          `動的チャンクの取得失敗は同一文書では復帰しないため再 navigate します: ${diagText}`,
      );
      try {
        await raceWithTimeout(
          api.renavigate!(),
          attemptTimeoutMs,
          "re-navigate",
        );
      } catch (navError) {
        throw new Error(
          buildAppReadyTimeoutMessage(e.message, diagText, {
            attempts: attempt,
            renavigated,
            renavigateError: navError instanceof Error
              ? navError.message
              : String(navError),
          }),
        );
      }
      renavigated++;
    }
  }
}

// ---- デバイスエミュレーション（TASK-131） ----
//
// 純ロジックの実体は emulation.ts（checkScript が value import しても
// cdp.ts との循環参照にならないよう分離）。従来どおり cdp.ts からも
// import できるように再 export する。

export {
  buildDeviceMetricsParams,
  buildDeviceScaleFactorArgs,
  buildTapEvents,
  buildTouchEmulationParams,
  buildWindowSizeArg,
  DEVICE_PRESETS,
  LANDSCAPE_PRESET,
  MOBILE_PRESET,
  resolveDevicePreset,
  SMALL_MOBILE_PRESET,
} from "./emulation.ts";
export type { EmulationConfig } from "./emulation.ts";

/** send() のデフォルトタイムアウト。単発コマンドの応答としては十分長い
 * 30s とする。waitFor はポーリング毎に単発の evaluate（即応答想定）を送る
 * ため、waitFor 全体のタイムアウト（appReady 待ちの 90s 等）が本値を
 * 超えていても干渉しない。 */
export const DEFAULT_SEND_TIMEOUT_MS = 30_000;

export interface CdpSession {
  /** CDP コマンドを送信する。応答・エラー応答・切断・タイムアウトのいずれかで
   * 必ず settle する（永久 pending にならない）。 */
  send(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<CdpMessage>;
  /** 指定イベントの初回発火を待つ。切断時は reject される。 */
  once(method: string): Promise<unknown>;
  /** WebSocket の onmessage から生メッセージを渡す。 */
  handleMessage(data: string): void;
  /** WebSocket の onerror/onclose・プロセス死亡時に呼ぶ。pending の send と
   * once 待機を全て reject し、以降の send を即 reject にする。 */
  handleDisconnect(reason: string): void;
}

/**
 * CDP メッセージの送受信セッションを作る。WebSocket 実体から切り離してあり、
 * rawSend（送信関数）と handleMessage/handleDisconnect の呼び出しだけで
 * 動くため、プロセス起動なしでユニットテストできる。
 *
 * 信頼性の保証（TASK-62）:
 * - handleDisconnect() で pending の全 send / once 待機が reject される
 *   （Chrome プロセス死亡・WebSocket 切断で無期限ブロックしない）。
 * - 各 send にタイムアウト（既定 30s）を設け、応答が来ない場合も reject する。
 */
export function createCdpSession(
  rawSend: (data: string) => void,
  opts: { sendTimeoutMs?: number } = {},
): CdpSession {
  const sendTimeoutMs = opts.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  let nextId = 1;
  let disconnectedReason: string | null = null;
  const pending = new Map<
    number,
    { resolve: (v: CdpMessage) => void; reject: (e: Error) => void }
  >();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const eventListeners = new Map<string, Array<(params: unknown) => void>>();
  const onceRejecters = new Set<(e: Error) => void>();

  function settle(id: number): void {
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
    pending.delete(id);
  }

  function handleMessage(data: string): void {
    const msg = JSON.parse(data) as CdpMessage;
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (p) {
        settle(msg.id);
        if (msg.error) {
          p.reject(new Error(msg.error.message));
        } else {
          p.resolve(msg);
        }
      }
    } else if (msg.method) {
      const listeners = eventListeners.get(msg.method);
      if (listeners) {
        for (const l of [...listeners]) l(msg.params);
      }
    }
  }

  function handleDisconnect(reason: string): void {
    if (disconnectedReason !== null) return;
    disconnectedReason = reason;
    const err = new Error(`CDP connection lost (${reason})`);
    for (const [id, p] of [...pending]) {
      settle(id);
      p.reject(err);
    }
    for (const reject of [...onceRejecters]) reject(err);
    onceRejecters.clear();
    eventListeners.clear();
  }

  function send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<CdpMessage> {
    if (disconnectedReason !== null) {
      return Promise.reject(
        new Error(
          `CDP connection lost (${disconnectedReason}): cannot send ${method}`,
        ),
      );
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      timers.set(
        id,
        setTimeout(() => {
          settle(id);
          reject(
            new Error(`CDP send timed out after ${sendTimeoutMs}ms: ${method}`),
          );
        }, sendTimeoutMs),
      );
      try {
        rawSend(JSON.stringify({ id, method, params }));
      } catch (e) {
        settle(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  function once(method: string): Promise<unknown> {
    if (disconnectedReason !== null) {
      return Promise.reject(
        new Error(
          `CDP connection lost (${disconnectedReason}): cannot wait for ${method}`,
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const handler = (params: unknown) => {
        const arr = eventListeners.get(method);
        const idx = arr?.indexOf(handler) ?? -1;
        if (arr && idx >= 0) arr.splice(idx, 1);
        onceRejecters.delete(reject);
        resolve(params);
      };
      if (!eventListeners.has(method)) eventListeners.set(method, []);
      eventListeners.get(method)!.push(handler);
      onceRejecters.add(reject);
    });
  }

  return { send, once, handleMessage, handleDisconnect };
}

const CLI_USAGE =
  "Usage: deno run -A scripts/verify/cdp.ts [--device=<preset>] <url> <checkScript.ts>\n" +
  "  (引数順は任意。http(s):// で始まる引数を URL、-- で始まらない引数を\n" +
  "   checkScript とみなす。標準スモークは `deno task verify:smoke <url>`、\n" +
  `   モバイル条件は --device=<preset>（${
    Object.keys(DEVICE_PRESETS).join(", ")
  }）)`;

/**
 * CLI 引数から url・checkScript パス・エミュレーション設定を解決する。
 * 順不同で受け付ける（`deno task verify:smoke <url>` はタスク定義の
 * checkScript の後ろに URL が付くため）。重複する余分な引数は無視する。
 * url / checkScript のどちらかが欠ける、または未知の -- フラグがあれば
 * usage を含む例外を投げる。`--device=<preset>` 指定時のみ emulation キーを
 * 持ち、未指定時はキー自体を持たない（デスクトップ既定。TASK-131）。
 */
export function parseCliArgs(
  args: string[],
): { url: string; checkScriptPath: string; emulation?: EmulationConfig } {
  let emulation: EmulationConfig | undefined;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--device=")) {
      emulation = resolveDevicePreset(arg.slice("--device=".length));
    } else if (arg.startsWith("--")) {
      throw new Error(`不明なオプション: ${arg}\n${CLI_USAGE}`);
    } else {
      positional.push(arg);
    }
  }
  const url = positional.find((a) => /^https?:\/\//.test(a));
  const checkScriptPath = positional.find((a) => !/^https?:\/\//.test(a));
  if (!url || !checkScriptPath) {
    throw new Error(CLI_USAGE);
  }
  return emulation === undefined
    ? { url, checkScriptPath }
    : { url, checkScriptPath, emulation };
}

/**
 * checkScript のパスを dynamic import 可能な file:// URL 文字列にする。
 * 素朴な文字列連結ではなく `toFileUrl` を使うことで、空白等を含むパスでも
 * 正しくパーセントエンコードされる。
 */
export function resolveCheckScriptUrl(
  path: string,
  cwd: string = Deno.cwd(),
): string {
  const absolute = isAbsolute(path) ? path : join(cwd, path);
  return toFileUrl(absolute).href;
}

// ---- リモート CDP モード（CDP_BROKER。旧 TASK-155 / Issue #169） ----
//
// agent-loop を Linux pod（実 GPU 描画不可）へ移すための「pod = 頭脳、
// macOS ホスト = 網膜」分離。環境変数 CDP_BROKER にホスト側 chrome-broker
// の HTTP ベース URL（例: http://192.168.5.2:8377）を指定すると、ローカルで
// Chrome を spawn する代わりに broker からセッションを取得して外部 Chrome
// の CDP エンドポイントへ接続する。未設定時の挙動は従来と完全に同一。
//
// broker API 契約（本タスクで確定。broker 実体は k8s-lab リポジトリ側）:
// - POST {base}/session
//     → 2xx / JSON { "id": string, "webSocketDebuggerUrl": string }
//       （fresh profile + 空きポートで headless Chrome を spawn した結果）
// - DELETE {base}/session/{id}
//     → セッション破棄（Chrome kill）。close() が best-effort で呼ぶ。
// broker は 127.0.0.1 bind のため webSocketDebuggerUrl の host は
// 127.0.0.1 になっている。pod から到達できるよう、接続前に CDP_BROKER の
// host（Lima slirp ゲートウェイ等）へ書き換える（ポートは ws URL のまま）。

/** リモート CDP モードの接続設定。 */
export interface BrokerConfig {
  /** broker の HTTP ベース URL（末尾スラッシュなしに正規化済み）。 */
  baseUrl: string;
}

/**
 * 環境変数 CDP_BROKER の値から接続モードを解決する。未設定・空文字なら
 * ローカルモード（null）。設定時は http(s) の URL であることを検証し、
 * 前後空白と末尾スラッシュを正規化した {@linkcode BrokerConfig} を返す。
 */
export function resolveBrokerConfig(
  value: string | undefined,
): BrokerConfig | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`CDP_BROKER が URL として不正です: "${trimmed}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `CDP_BROKER は http(s) の broker URL を指定してください: "${trimmed}"`,
    );
  }
  return { baseUrl: trimmed.replace(/\/+$/, "") };
}

/**
 * broker が返す webSocketDebuggerUrl の host（127.0.0.1）を、こちらから
 * 到達可能な broker の host に書き換える。スキーム・ポート・パス・クエリは
 * ws URL のまま保持する。
 */
export function rewriteWsUrlHost(wsUrl: string, brokerBaseUrl: string): string {
  const ws = new URL(wsUrl);
  ws.hostname = new URL(brokerBaseUrl).hostname;
  return ws.href;
}

/**
 * POST {base}/session の応答 JSON を検証して id と webSocketDebuggerUrl を
 * 取り出す。形式が契約と異なる場合は内容を含めて例外を投げる。
 */
export function parseBrokerSessionResponse(
  body: unknown,
): { id: string; webSocketDebuggerUrl: string } {
  const record = body as
    | { id?: unknown; webSocketDebuggerUrl?: unknown }
    | null;
  if (
    typeof record !== "object" || record === null ||
    typeof record.id !== "string" ||
    typeof record.webSocketDebuggerUrl !== "string"
  ) {
    throw new Error(
      `broker の /session 応答が契約 { id, webSocketDebuggerUrl } と異なります: ${
        JSON.stringify(body)
      }`,
    );
  }
  return { id: record.id, webSocketDebuggerUrl: record.webSocketDebuggerUrl };
}

/**
 * CDP エンドポイントへの「接続」を抽象化する。ローカル（Chrome spawn）と
 * リモート（broker セッション）で wsUrl の得方と後始末だけが異なり、
 * 接続後の CDP プロトコル操作は完全に共通。
 */
interface CdpConnection {
  wsUrl: string;
  /** WebSocket close 後の後始末（プロセス kill / broker セッション破棄）。
   * 例外を投げない（best-effort）。 */
  cleanup(): Promise<void>;
}

/**
 * broker からセッションを取得してリモート接続を作る。fetch を注入できる
 * ため、実ブローカー無しでモックによる単体テストが可能。
 */
export async function openBrokerSession(
  broker: BrokerConfig,
  fetchFn: typeof fetch = fetch,
): Promise<CdpConnection> {
  const res = await fetchFn(`${broker.baseUrl}/session`, { method: "POST" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `broker POST /session が失敗しました: ${res.status} ${body}`.trim(),
    );
  }
  const session = parseBrokerSessionResponse(await res.json());
  const wsUrl = rewriteWsUrlHost(session.webSocketDebuggerUrl, broker.baseUrl);
  async function cleanup(): Promise<void> {
    try {
      const del = await fetchFn(`${broker.baseUrl}/session/${session.id}`, {
        method: "DELETE",
      });
      await del.body?.cancel();
    } catch {
      // best-effort: broker 側 TTL による孤児掃除に委ねる
    }
  }
  return { wsUrl, cleanup };
}

// ---- プロセス起動・CDP 通信（副作用あり） ----

function findFreePort(): Promise<number> {
  const listener = Deno.listen({ port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return Promise.resolve(port);
}

async function waitForCdpReady(
  port: number,
  timeoutMs = 15000,
): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/json/version`);
      if (res.ok) {
        await res.body?.cancel();
        return;
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`CDP endpoint not ready on port ${port}: ${lastErr}`);
}

export interface LaunchOptions {
  /** 画面・端末条件のエミュレーション（未指定ならデスクトップ既定のまま）。 */
  emulation?: EmulationConfig;
}

/**
 * ヘッドレス Chrome の起動引数を組み立てる純粋関数（Issue #320 でテスト可能な
 * 形に切り出した）。`--disable-gpu` は**付けない**（付けると canvas が描画
 * されない。本ファイル冒頭の制約を参照）。エミュレーション指定時のみ
 * `--force-device-scale-factor`（{@linkcode buildDeviceScaleFactorArgs}）が
 * 加わり、未指定のデスクトップ既定では従来と同一の引数列になる。
 */
export function buildChromeArgs(options: {
  port: number;
  userDataDir: string;
  emulation?: EmulationConfig;
}): string[] {
  const { port, userDataDir, emulation } = options;
  return [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    buildWindowSizeArg(emulation),
    ...buildDeviceScaleFactorArgs(emulation),
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ];
}

/**
 * ローカルモードの接続: ヘッドレス Chrome を spawn し、CDP エンドポイント
 * から接続すべき ws URL を得る。cleanup はプロセス kill と一時プロファイル
 * 削除（従来の close() と同じ内容・同じ順序）。
 */
async function launchLocalChrome(
  emulation?: EmulationConfig,
): Promise<CdpConnection> {
  const port = await findFreePort();
  const userDataDir = await Deno.makeTempDir({ prefix: "cdp-verify-" });

  const cmd = new Deno.Command(resolveChromeBin(), {
    args: buildChromeArgs({ port, userDataDir, emulation }),
    stdout: "null",
    stderr: "null",
  });
  const process = cmd.spawn();

  await waitForCdpReady(port);

  const listRes = await fetch(`http://localhost:${port}/json/list`);
  const targets = await listRes.json() as CdpTarget[];
  const wsUrl = pickPageTargetUrl(targets);

  async function cleanup(): Promise<void> {
    try {
      process.kill("SIGTERM");
    } catch {
      // ignore
    }
    try {
      await process.status;
    } catch {
      // ignore
    }
    try {
      await Deno.remove(userDataDir, { recursive: true });
    } catch {
      // ignore
    }
  }

  return { wsUrl, cleanup };
}

export async function launch(options: LaunchOptions = {}): Promise<CdpApi> {
  const { emulation } = options;
  // CDP_BROKER 設定時はリモートモード: Chrome の spawn・ポート待ち・kill を
  // 全てスキップし、broker が用意した外部 Chrome へ接続する。未設定時は
  // 従来どおりローカル spawn（挙動を一切変えない）。
  const broker = resolveBrokerConfig(Deno.env.get("CDP_BROKER"));
  const connection = broker
    ? await openBrokerSession(broker)
    : await launchLocalChrome(emulation);

  const ws = new WebSocket(connection.wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(e);
  });

  // send() が永久 pending にならないよう、切断（onerror/onclose・Chrome
  // プロセス死亡による WebSocket close）とタイムアウトで必ず reject する
  // セッションに委譲する（TASK-62）。
  const session = createCdpSession((data) => ws.send(data));
  ws.onmessage = (ev) => session.handleMessage(String(ev.data));
  ws.onerror = () => session.handleDisconnect("WebSocket error");
  ws.onclose = () => session.handleDisconnect("WebSocket closed");
  const { send, once } = session;

  await send("Page.enable");
  await send("Runtime.enable");

  // エミュレーション指定時のみ画面・端末条件を上書きする（TASK-131）。
  // 未指定（デスクトップ既定）では Emulation ドメインを一切呼ばず、
  // 従来の挙動を変えない。
  if (emulation) {
    await send(
      "Emulation.setDeviceMetricsOverride",
      buildDeviceMetricsParams(emulation),
    );
    await send(
      "Emulation.setTouchEmulationEnabled",
      buildTouchEmulationParams(emulation),
    );
  }

  // #311: appReady 待ちが「動的チャンク取得の一過性失敗による終端状態」に
  // 陥ったときの唯一の復帰手段が再 navigate なので、直近の navigate 先を
  // 覚えておく（CdpApi は URL を渡さない waitForAppReady 契約のため）。
  let lastNavigatedUrl: string | null = null;

  async function navigate(url: string): Promise<void> {
    const loaded = once("Page.loadEventFired");
    await send("Page.navigate", { url });
    await loaded;
    lastNavigatedUrl = url;
  }

  async function setCacheDisabled(disabled: boolean): Promise<void> {
    await send("Network.enable");
    await send("Network.setCacheDisabled", { cacheDisabled: disabled });
  }

  async function setEmulation(config: EmulationConfig): Promise<void> {
    await send(
      "Emulation.setDeviceMetricsOverride",
      buildDeviceMetricsParams(config),
    );
    await send(
      "Emulation.setTouchEmulationEnabled",
      buildTouchEmulationParams(config),
    );
  }

  async function evaluate<T = unknown>(expr: string): Promise<T> {
    const res = await send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    return parseEvaluateResult<T>(res);
  }

  async function waitFor(expr: string, timeoutMs = 10000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await evaluate<boolean>(buildWaitForExpr(expr));
      if (ok) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms: ${expr}`);
  }

  async function waitForAppReady(
    timeoutMs: number = APP_READY_TIMEOUT_MS,
  ): Promise<void> {
    const url = lastNavigatedUrl;
    await waitForAppReadyWith(
      url === null
        ? { waitFor, evaluate }
        : { waitFor, evaluate, renavigate: () => navigate(url) },
      timeoutMs,
    );
  }

  async function hover(x: number, y: number): Promise<void> {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }

  async function click(x: number, y: number): Promise<void> {
    await hover(x, y);
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }

  async function tap(x: number, y: number): Promise<void> {
    for (const event of buildTapEvents(x, y)) {
      await send("Input.dispatchTouchEvent", event);
    }
  }

  async function keys(key: string, count = 1): Promise<void> {
    const mapped = resolveKeyCode(key);
    for (let i = 0; i < count; i++) {
      await send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key,
        code: mapped.code,
        windowsVirtualKeyCode: mapped.keyCode,
        nativeVirtualKeyCode: mapped.keyCode,
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        code: mapped.code,
        windowsVirtualKeyCode: mapped.keyCode,
        nativeVirtualKeyCode: mapped.keyCode,
      });
    }
  }

  async function screenshot(path: string): Promise<void> {
    const res = await send("Page.captureScreenshot", { format: "png" });
    const data = (res.result as { data: string }).data;
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    await Deno.writeFile(path, bytes);
  }

  async function close(): Promise<void> {
    try {
      ws.close();
    } catch {
      // ignore
    }
    // ローカル: プロセス kill + 一時プロファイル削除 /
    // リモート: broker セッション破棄（DELETE /session/:id）
    await connection.cleanup();
  }

  return {
    navigate,
    setCacheDisabled,
    setEmulation,
    evaluate,
    waitFor,
    waitForAppReady,
    hover,
    click,
    tap,
    keys,
    screenshot,
    close,
  };
}

// ---- CLI エントリポイント ----
if (import.meta.main) {
  let cli: {
    url: string;
    checkScriptPath: string;
    emulation?: EmulationConfig;
  };
  try {
    cli = parseCliArgs(Deno.args);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    Deno.exit(1);
  }
  const { url, checkScriptPath, emulation } = cli;
  const mod = await import(resolveCheckScriptUrl(checkScriptPath));
  if (typeof mod.run !== "function") {
    console.error(`checkScript must export an async function run(api)`);
    Deno.exit(1);
  }
  const api = await launch({ emulation });
  try {
    await api.navigate(url);
    await mod.run(api);
  } finally {
    await api.close();
  }
}
