import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { DEFAULT_PORT } from "../serve.ts";
import {
  APP_READY_EXPR,
  APP_READY_MAX_ATTEMPTS,
  APP_READY_TIMEOUT_MS,
  type AppReadyDiagnostics,
  buildAppReadyTimeoutMessage,
  buildDeviceMetricsParams,
  buildTapEvents,
  buildTouchEmulationParams,
  buildWaitForExpr,
  buildWindowSizeArg,
  computeAppReadyAttemptTimeoutMs,
  createCdpSession,
  DEFAULT_APP_URL,
  DEVICE_PRESETS,
  type EmulationConfig,
  formatAppReadyDiagnostics,
  isRecoverableAppReadyStall,
  LANDSCAPE_PRESET,
  MOBILE_PRESET,
  openBrokerSession,
  parseBrokerSessionResponse,
  parseCliArgs,
  parseEvaluateResult,
  pickPageTargetUrl,
  raceWithTimeout,
  resolveBrokerConfig,
  resolveCheckScriptUrl,
  resolveDevicePreset,
  resolveKeyCode,
  rewriteWsUrlHost,
  SMALL_MOBILE_PRESET,
  waitForAppReadyWith,
} from "./cdp.ts";

Deno.test("DEFAULT_APP_URL は dev サーバの既定ポート（scripts/serve.ts の DEFAULT_PORT）に追従する", () => {
  assertEquals(DEFAULT_APP_URL, `http://localhost:${DEFAULT_PORT}/`);
});

Deno.test("pickPageTargetUrl は type=page かつ webSocketDebuggerUrl を持つ最初のターゲットの URL を返す", () => {
  const targets = [
    { type: "background_page", webSocketDebuggerUrl: "ws://bg" },
    { type: "page", webSocketDebuggerUrl: "ws://page1" },
    { type: "page", webSocketDebuggerUrl: "ws://page2" },
  ];
  assertEquals(pickPageTargetUrl(targets), "ws://page1");
});

Deno.test("pickPageTargetUrl は type=page が webSocketDebuggerUrl を持たない場合スキップする", () => {
  const targets = [
    { type: "page" },
    { type: "page", webSocketDebuggerUrl: "ws://page2" },
  ];
  assertEquals(pickPageTargetUrl(targets), "ws://page2");
});

Deno.test("pickPageTargetUrl は該当ターゲットがなければ例外を投げる", () => {
  assertThrows(
    () => pickPageTargetUrl([{ type: "background_page" }]),
    Error,
    "No page target with webSocketDebuggerUrl found",
  );
});

Deno.test("parseEvaluateResult は正常時に result.value を返す", () => {
  const value = parseEvaluateResult<number>({
    result: { result: { value: 42 } },
  });
  assertEquals(value, 42);
});

Deno.test("parseEvaluateResult は exceptionDetails があれば例外の description で Error を投げる", () => {
  assertThrows(
    () =>
      parseEvaluateResult({
        result: {
          exceptionDetails: {
            exception: { description: "ReferenceError: foo is not defined" },
          },
        },
      }),
    Error,
    "ReferenceError: foo is not defined",
  );
});

Deno.test("parseEvaluateResult は description が無い場合 text にフォールバックする", () => {
  assertThrows(
    () =>
      parseEvaluateResult({
        result: {
          exceptionDetails: { text: "Uncaught exception" },
        },
      }),
    Error,
    "Uncaught exception",
  );
});

Deno.test("resolveKeyCode は既知のキーの keyCode/code を返す", () => {
  assertEquals(resolveKeyCode("ArrowDown"), { keyCode: 40, code: "ArrowDown" });
  assertEquals(resolveKeyCode("Enter"), { keyCode: 13, code: "Enter" });
});

Deno.test("resolveKeyCode は未対応キーで例外を投げる", () => {
  assertThrows(
    () => resolveKeyCode("F1"),
    Error,
    'keys(): unsupported key "F1"',
  );
});

Deno.test("buildWaitForExpr は式を Boolean(...) でラップする", () => {
  assertEquals(
    buildWaitForExpr("window.__getYear() === 1500"),
    "Boolean(window.__getYear() === 1500)",
  );
});

// ---- createCdpSession（send の reject 保証） ----

Deno.test("createCdpSession: 応答が来れば send は resolve する", async () => {
  const sent: string[] = [];
  const session = createCdpSession((data) => sent.push(data));
  const p = session.send("Page.enable");
  const { id } = JSON.parse(sent[0]) as { id: number };
  session.handleMessage(JSON.stringify({ id, result: { ok: true } }));
  const msg = await p;
  assertEquals(msg.id, id);
  assertEquals(msg.result, { ok: true });
});

Deno.test("createCdpSession: CDP エラー応答は reject される", async () => {
  const sent: string[] = [];
  const session = createCdpSession((data) => sent.push(data));
  const p = session.send("Runtime.evaluate");
  const { id } = JSON.parse(sent[0]) as { id: number };
  session.handleMessage(
    JSON.stringify({ id, error: { message: "Invalid expression" } }),
  );
  await assertRejects(() => p, Error, "Invalid expression");
});

Deno.test("createCdpSession: 切断時に pending の send が全て reject される", async () => {
  const session = createCdpSession(() => {});
  const p1 = session.send("Runtime.evaluate");
  const p2 = session.send("Page.captureScreenshot");
  session.handleDisconnect("WebSocket closed");
  await assertRejects(() => p1, Error, "CDP connection lost");
  await assertRejects(() => p2, Error, "CDP connection lost");
});

Deno.test("createCdpSession: 切断後の send は即 reject される", async () => {
  const session = createCdpSession(() => {});
  session.handleDisconnect("WebSocket error");
  await assertRejects(
    () => session.send("Page.enable"),
    Error,
    "CDP connection lost",
  );
});

Deno.test("createCdpSession: 応答が無ければ sendTimeoutMs で reject される", async () => {
  const session = createCdpSession(() => {}, { sendTimeoutMs: 20 });
  await assertRejects(
    () => session.send("Page.enable"),
    Error,
    "timed out",
  );
});

Deno.test("createCdpSession: once はイベント受信で resolve する", async () => {
  const session = createCdpSession(() => {});
  const p = session.once("Page.loadEventFired");
  session.handleMessage(
    JSON.stringify({ method: "Page.loadEventFired", params: { ts: 1 } }),
  );
  assertEquals(await p, { ts: 1 });
});

Deno.test("createCdpSession: 切断時に once の待機も reject される", async () => {
  const session = createCdpSession(() => {});
  const p = session.once("Page.loadEventFired");
  session.handleDisconnect("process exited");
  await assertRejects(() => p, Error, "CDP connection lost");
});

// ---- parseCliArgs（CLI 引数解決） ----

Deno.test("parseCliArgs: <url> <checkScript> の順で解決する", () => {
  assertEquals(
    parseCliArgs(["http://localhost:8000/", "scripts/verify/checks/smoke.ts"]),
    {
      url: "http://localhost:8000/",
      checkScriptPath: "scripts/verify/checks/smoke.ts",
    },
  );
});

Deno.test("parseCliArgs: <checkScript> <url> の順（deno task で URL が末尾に付く形）でも解決する", () => {
  assertEquals(
    parseCliArgs(["scripts/verify/checks/smoke.ts", "https://example.com/"]),
    {
      url: "https://example.com/",
      checkScriptPath: "scripts/verify/checks/smoke.ts",
    },
  );
});

Deno.test("parseCliArgs: 余分な重複引数は無視する（旧スタイル呼び出しの互換）", () => {
  assertEquals(
    parseCliArgs([
      "scripts/verify/checks/smoke.ts",
      "http://localhost:8000/",
      "scripts/verify/checks/smoke.ts",
    ]),
    {
      url: "http://localhost:8000/",
      checkScriptPath: "scripts/verify/checks/smoke.ts",
    },
  );
});

Deno.test("parseCliArgs: URL が無ければ usage エラーを投げる", () => {
  assertThrows(
    () => parseCliArgs(["scripts/verify/checks/smoke.ts"]),
    Error,
    "Usage:",
  );
});

Deno.test("parseCliArgs: checkScript が無ければ usage エラーを投げる", () => {
  assertThrows(
    () => parseCliArgs(["http://localhost:8000/"]),
    Error,
    "Usage:",
  );
});

// ---- デバイスエミュレーション（TASK-131） ----

Deno.test("MOBILE_PRESET: 幅 390 / 高さ 844（iPhone 縦持ち相当。Issue #253 の再現条件）/ DPR 3 / mobile / touch が定義されている", () => {
  assertEquals(MOBILE_PRESET, {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
  });
});

Deno.test("LANDSCAPE_PRESET: 幅 844 / 高さ 390（iPhone 横持ち相当）/ DPR 3 / mobile / touch が定義されている（Issue #252）", () => {
  assertEquals(LANDSCAPE_PRESET, {
    width: 844,
    height: 390,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
  });
});

Deno.test("SMALL_MOBILE_PRESET: 幅 320 / 高さ 568（iPhone SE 初代相当。Issue #254 AC2 の実測条件）/ DPR 2 / mobile / touch が定義されている", () => {
  assertEquals(SMALL_MOBILE_PRESET, {
    width: 320,
    height: 568,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
  });
});

Deno.test("DEVICE_PRESETS: mobile プリセットが登録されている", () => {
  assertEquals(DEVICE_PRESETS.mobile, MOBILE_PRESET);
});

Deno.test("DEVICE_PRESETS: mobile-small プリセットが登録されている（Issue #254）", () => {
  assertEquals(DEVICE_PRESETS["mobile-small"], SMALL_MOBILE_PRESET);
});

Deno.test("DEVICE_PRESETS: landscape プリセットが登録されている（Issue #252）", () => {
  assertEquals(DEVICE_PRESETS.landscape, LANDSCAPE_PRESET);
});

Deno.test("resolveDevicePreset: 既知のプリセット名で設定を返す", () => {
  assertEquals(resolveDevicePreset("mobile"), MOBILE_PRESET);
  assertEquals(resolveDevicePreset("landscape"), LANDSCAPE_PRESET);
});

Deno.test("resolveDevicePreset: 未知のプリセット名は既知の名前を列挙して例外を投げる", () => {
  assertThrows(
    () => resolveDevicePreset("tablet"),
    Error,
    'unknown device preset "tablet"',
  );
  assertThrows(() => resolveDevicePreset("tablet"), Error, "mobile");
});

Deno.test("buildWindowSizeArg: エミュレーション未指定ならデスクトップ既定 1600,900 のまま", () => {
  assertEquals(buildWindowSizeArg(undefined), "--window-size=1600,900");
  assertEquals(buildWindowSizeArg(), "--window-size=1600,900");
});

Deno.test("buildWindowSizeArg: エミュレーション指定時はその width/height を使う", () => {
  assertEquals(buildWindowSizeArg(MOBILE_PRESET), "--window-size=390,844");
  assertEquals(buildWindowSizeArg(LANDSCAPE_PRESET), "--window-size=844,390");
});

Deno.test("buildDeviceMetricsParams: Emulation.setDeviceMetricsOverride のパラメータを組み立てる（touch は含めない）", () => {
  assertEquals(buildDeviceMetricsParams(MOBILE_PRESET), {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  });
});

Deno.test("buildTouchEmulationParams: touch=true なら enabled/maxTouchPoints を返す", () => {
  assertEquals(buildTouchEmulationParams(MOBILE_PRESET), {
    enabled: true,
    maxTouchPoints: 5,
  });
});

Deno.test("buildTouchEmulationParams: touch=false なら enabled: false を返す", () => {
  const noTouch: EmulationConfig = { ...MOBILE_PRESET, touch: false };
  assertEquals(buildTouchEmulationParams(noTouch), {
    enabled: false,
    maxTouchPoints: 5,
  });
});

Deno.test("buildTapEvents: touchStart（座標 1 点）→ touchEnd（空）の 2 イベントを組み立てる", () => {
  assertEquals(buildTapEvents(120, 340), [
    { type: "touchStart", touchPoints: [{ x: 120, y: 340 }] },
    { type: "touchEnd", touchPoints: [] },
  ]);
});

// ---- parseCliArgs の --device フラグ（TASK-131） ----

Deno.test("parseCliArgs: --device=mobile でエミュレーション設定が解決される", () => {
  assertEquals(
    parseCliArgs([
      "--device=mobile",
      "http://localhost:8131/",
      "scripts/verify/checks/mobile-smoke.ts",
    ]),
    {
      url: "http://localhost:8131/",
      checkScriptPath: "scripts/verify/checks/mobile-smoke.ts",
      emulation: MOBILE_PRESET,
    },
  );
});

Deno.test("parseCliArgs: --device が末尾でも解決される（deno task で URL が後置される形）", () => {
  assertEquals(
    parseCliArgs([
      "scripts/verify/checks/mobile-smoke.ts",
      "http://localhost:8131/",
      "--device=mobile",
    ]),
    {
      url: "http://localhost:8131/",
      checkScriptPath: "scripts/verify/checks/mobile-smoke.ts",
      emulation: MOBILE_PRESET,
    },
  );
});

Deno.test("parseCliArgs: --device 未指定なら emulation キーを持たない（デスクトップ既定）", () => {
  const parsed = parseCliArgs([
    "http://localhost:8000/",
    "scripts/verify/checks/smoke.ts",
  ]);
  assertEquals("emulation" in parsed, false);
});

Deno.test("parseCliArgs: 未知の --device 値はエラーを投げる", () => {
  assertThrows(
    () =>
      parseCliArgs([
        "--device=tablet",
        "http://localhost:8000/",
        "scripts/verify/checks/smoke.ts",
      ]),
    Error,
    'unknown device preset "tablet"',
  );
});

Deno.test("parseCliArgs: 未知の -- フラグは usage エラーを投げる（checkScript と誤認しない）", () => {
  assertThrows(
    () =>
      parseCliArgs([
        "--emulate=mobile",
        "http://localhost:8000/",
        "scripts/verify/checks/smoke.ts",
      ]),
    Error,
    "Usage:",
  );
});

// ---- resolveCheckScriptUrl（file:// URL 化） ----

Deno.test("resolveCheckScriptUrl: 相対パスを cwd 基準の file:// URL にする", () => {
  assertEquals(
    resolveCheckScriptUrl("checks/smoke.ts", "/repo"),
    "file:///repo/checks/smoke.ts",
  );
});

Deno.test("resolveCheckScriptUrl: ./ 始まりの相対パスも解決する", () => {
  assertEquals(
    resolveCheckScriptUrl("./checks/smoke.ts", "/repo"),
    "file:///repo/checks/smoke.ts",
  );
});

Deno.test("resolveCheckScriptUrl: 空白を含むパスをパーセントエンコードする", () => {
  assertEquals(
    resolveCheckScriptUrl("my checks/smoke test.ts", "/tmp/dir with space"),
    "file:///tmp/dir%20with%20space/my%20checks/smoke%20test.ts",
  );
});

Deno.test("resolveCheckScriptUrl: 絶対パスは cwd に依存せず file:// URL にする", () => {
  assertEquals(
    resolveCheckScriptUrl("/abs path/smoke.ts", "/ignored"),
    "file:///abs%20path/smoke.ts",
  );
});

// ---- リモート CDP モード（CDP_BROKER。旧 TASK-155 / Issue #169） ----

Deno.test("resolveBrokerConfig: 未設定（undefined）ならローカルモード（null）", () => {
  assertEquals(resolveBrokerConfig(undefined), null);
});

Deno.test("resolveBrokerConfig: 空文字・空白のみならローカルモード（null）", () => {
  assertEquals(resolveBrokerConfig(""), null);
  assertEquals(resolveBrokerConfig("   "), null);
});

Deno.test("resolveBrokerConfig: http(s) の broker URL を baseUrl として返す", () => {
  assertEquals(resolveBrokerConfig("http://192.168.5.2:8377"), {
    baseUrl: "http://192.168.5.2:8377",
  });
  assertEquals(resolveBrokerConfig("https://broker.example:9000"), {
    baseUrl: "https://broker.example:9000",
  });
});

Deno.test("resolveBrokerConfig: 末尾スラッシュ・前後空白を正規化する", () => {
  assertEquals(resolveBrokerConfig(" http://192.168.5.2:8377/ "), {
    baseUrl: "http://192.168.5.2:8377",
  });
});

Deno.test("resolveBrokerConfig: http(s) 以外のスキーム・不正 URL は例外を投げる", () => {
  assertThrows(
    () => resolveBrokerConfig("ws://192.168.5.2:8377"),
    Error,
    "CDP_BROKER",
  );
  assertThrows(() => resolveBrokerConfig("not a url"), Error, "CDP_BROKER");
});

Deno.test("rewriteWsUrlHost: ws URL の host を broker の host に書き換える（ws のポートは保持）", () => {
  assertEquals(
    rewriteWsUrlHost(
      "ws://127.0.0.1:52345/devtools/page/ABC",
      "http://192.168.5.2:8377",
    ),
    "ws://192.168.5.2:52345/devtools/page/ABC",
  );
});

Deno.test("rewriteWsUrlHost: スキーム（wss）とパス・クエリを保持する", () => {
  assertEquals(
    rewriteWsUrlHost(
      "wss://localhost:9222/devtools/page/XYZ?x=1",
      "https://broker.example:9000",
    ),
    "wss://broker.example:9222/devtools/page/XYZ?x=1",
  );
});

Deno.test("parseBrokerSessionResponse: id と webSocketDebuggerUrl を取り出す", () => {
  assertEquals(
    parseBrokerSessionResponse({
      id: "s1",
      webSocketDebuggerUrl: "ws://127.0.0.1:52345/devtools/page/ABC",
    }),
    {
      id: "s1",
      webSocketDebuggerUrl: "ws://127.0.0.1:52345/devtools/page/ABC",
    },
  );
});

Deno.test("parseBrokerSessionResponse: id が欠けていれば例外を投げる", () => {
  assertThrows(
    () => parseBrokerSessionResponse({ webSocketDebuggerUrl: "ws://x" }),
    Error,
    "broker",
  );
});

Deno.test("parseBrokerSessionResponse: webSocketDebuggerUrl が欠けていれば例外を投げる", () => {
  assertThrows(() => parseBrokerSessionResponse({ id: "s1" }), Error, "broker");
});

Deno.test("parseBrokerSessionResponse: オブジェクトでない応答は例外を投げる", () => {
  assertThrows(() => parseBrokerSessionResponse(null), Error, "broker");
  assertThrows(() => parseBrokerSessionResponse("ok"), Error, "broker");
});

/** モック broker: fetch 呼び出しを記録し、決められた応答を返す。 */
function createMockBrokerFetch(
  responses: { post?: Response; del?: Response } = {},
) {
  const calls: { url: string; method: string }[] = [];
  const fetchFn = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (method === "POST") {
      return Promise.resolve(
        responses.post ??
          Response.json({
            id: "sess-1",
            webSocketDebuggerUrl: "ws://127.0.0.1:52345/devtools/page/ABC",
          }),
      );
    }
    if (method === "DELETE") {
      return Promise.resolve(
        responses.del ?? new Response(null, {
          status: 204,
        }),
      );
    }
    return Promise.reject(new Error(`unexpected method ${method}`));
  };
  return { calls, fetchFn };
}

Deno.test("openBrokerSession: POST /session で取得した ws URL を broker host へ書き換えて返す", async () => {
  const { calls, fetchFn } = createMockBrokerFetch();
  const conn = await openBrokerSession(
    { baseUrl: "http://192.168.5.2:8377" },
    fetchFn,
  );
  assertEquals(calls, [
    { url: "http://192.168.5.2:8377/session", method: "POST" },
  ]);
  assertEquals(conn.wsUrl, "ws://192.168.5.2:52345/devtools/page/ABC");
  await conn.cleanup();
});

Deno.test("openBrokerSession: cleanup() が DELETE /session/:id を呼ぶ（AC #3）", async () => {
  const { calls, fetchFn } = createMockBrokerFetch();
  const conn = await openBrokerSession(
    { baseUrl: "http://192.168.5.2:8377" },
    fetchFn,
  );
  await conn.cleanup();
  assertEquals(calls[1], {
    url: "http://192.168.5.2:8377/session/sess-1",
    method: "DELETE",
  });
});

Deno.test("openBrokerSession: POST が非 2xx なら status 付きで例外を投げる", async () => {
  const { fetchFn } = createMockBrokerFetch({
    post: new Response("boom", { status: 500 }),
  });
  await assertRejects(
    () => openBrokerSession({ baseUrl: "http://192.168.5.2:8377" }, fetchFn),
    Error,
    "500",
  );
});

Deno.test("openBrokerSession: cleanup() は DELETE 失敗でも例外を投げない（best-effort）", async () => {
  let posted = false;
  const fetchFn = (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if ((init?.method ?? "GET") === "POST" && !posted) {
      posted = true;
      return Promise.resolve(
        Response.json({
          id: "sess-1",
          webSocketDebuggerUrl: "ws://127.0.0.1:52345/devtools/page/ABC",
        }),
      );
    }
    return Promise.reject(new Error("network down"));
  };
  const conn = await openBrokerSession(
    { baseUrl: "http://192.168.5.2:8377" },
    fetchFn,
  );
  await conn.cleanup();
});

Deno.test({
  name:
    "resolveCheckScriptUrl: 空白入り一時ディレクトリのスクリプトを実際に import できる",
  ignore: Deno.permissions.querySync({ name: "write" }).state !== "granted" ||
    Deno.permissions.querySync({ name: "read" }).state !== "granted",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "cdp verify space " });
    try {
      const scriptPath = `${dir}/smoke check.ts`;
      await Deno.writeTextFile(
        scriptPath,
        "export function run() { return 'loaded'; }\n",
      );
      const mod = await import(resolveCheckScriptUrl(scriptPath));
      assertEquals(mod.run(), "loaded");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// ---- appReady 待ち（タイムアウト値・診断。Issue #295） ----

Deno.test("APP_READY_TIMEOUT_MS は実測で不足した 30s の 3 倍（#282 の 15s→45s と同じ倍率）", () => {
  assertEquals(APP_READY_TIMEOUT_MS, 90_000);
});

Deno.test("APP_READY_EXPR は __getYear 定義と loading-spinner 非表示の両方を条件に含む", () => {
  assertEquals(
    APP_READY_EXPR,
    "window.__getYear && document.querySelector('.loading-spinner')?.hidden !== false",
  );
});

Deno.test("formatAppReadyDiagnostics は待機条件の各要素の最終観測値を列挙する", () => {
  const diag: AppReadyDiagnostics = {
    readyState: "complete",
    getYearDefined: false,
    spinnerPresent: true,
    spinnerHidden: false,
    errorToastVisible: false,
  };
  assertEquals(
    formatAppReadyDiagnostics(diag),
    "__getYear defined=false, loading-spinner present=true hidden=false, " +
      "document.readyState=complete, error-toast visible=false",
  );
});

Deno.test("formatAppReadyDiagnostics は spinner 欠如時に hidden=null と表す", () => {
  const diag: AppReadyDiagnostics = {
    readyState: "loading",
    getYearDefined: true,
    spinnerPresent: false,
    spinnerHidden: null,
    errorToastVisible: true,
  };
  assertEquals(
    formatAppReadyDiagnostics(diag),
    "__getYear defined=true, loading-spinner present=false hidden=null, " +
      "document.readyState=loading, error-toast visible=true",
  );
});

Deno.test("buildAppReadyTimeoutMessage は waitFor のエラーメッセージに診断を付加する", () => {
  assertEquals(
    buildAppReadyTimeoutMessage(
      "waitFor timed out after 90000ms: expr",
      "diag text",
    ),
    "waitFor timed out after 90000ms: expr [appReady diagnostics: diag text]",
  );
});

/** waitForAppReadyWith のテスト用フェイク API を作る。 */
function createFakeAppReadyApi(opts: {
  waitForError?: Error;
  /** 試行ごとの waitFor 結果（指定した数だけ順に使い、以降は waitForError）。 */
  waitForErrors?: Array<Error | null>;
  diag?: AppReadyDiagnostics;
  diagError?: Error;
  renavigateError?: Error;
  withRenavigate?: boolean;
}): {
  api: {
    waitFor(expr: string, timeoutMs?: number): Promise<void>;
    evaluate<T>(expr: string): Promise<T>;
    renavigate?: () => Promise<void>;
  };
  calls: {
    waitFor: Array<{ expr: string; timeoutMs?: number }>;
    evaluate: string[];
    renavigate: number;
  };
} {
  const calls: {
    waitFor: Array<{ expr: string; timeoutMs?: number }>;
    evaluate: string[];
    renavigate: number;
  } = { waitFor: [], evaluate: [], renavigate: 0 };
  const api: {
    waitFor(expr: string, timeoutMs?: number): Promise<void>;
    evaluate<T>(expr: string): Promise<T>;
    renavigate?: () => Promise<void>;
  } = {
    waitFor(expr: string, timeoutMs?: number): Promise<void> {
      const index = calls.waitFor.length;
      calls.waitFor.push({ expr, timeoutMs });
      const scripted = opts.waitForErrors?.[index];
      if (opts.waitForErrors && index < opts.waitForErrors.length) {
        return scripted ? Promise.reject(scripted) : Promise.resolve();
      }
      return opts.waitForError
        ? Promise.reject(opts.waitForError)
        : Promise.resolve();
    },
    evaluate<T>(expr: string): Promise<T> {
      calls.evaluate.push(expr);
      if (opts.diagError) return Promise.reject(opts.diagError);
      return Promise.resolve(opts.diag as unknown as T);
    },
  };
  if (opts.withRenavigate || opts.renavigateError) {
    api.renavigate = () => {
      calls.renavigate++;
      return opts.renavigateError
        ? Promise.reject(opts.renavigateError)
        : Promise.resolve();
    };
  }
  return { api, calls };
}

/** deck チャンク取得の一過性失敗で固まった文書の観測値（Issue #311 の実測）。 */
const CHUNK_STALL_DIAG: AppReadyDiagnostics = {
  readyState: "complete",
  getYearDefined: false,
  spinnerPresent: true,
  spinnerHidden: true,
  errorToastVisible: false,
};

Deno.test("waitForAppReadyWith: 条件成立なら resolve し、診断の evaluate は呼ばない", async () => {
  const { api, calls } = createFakeAppReadyApi({});
  await waitForAppReadyWith(api);
  assertEquals(calls.waitFor.length, 1);
  assertEquals(calls.waitFor[0].expr, APP_READY_EXPR);
  // 総予算 APP_READY_TIMEOUT_MS を試行回数で割った 1 試行分が渡る（#311）
  assertEquals(
    calls.waitFor[0].timeoutMs,
    APP_READY_TIMEOUT_MS / APP_READY_MAX_ATTEMPTS,
  );
  assertEquals(calls.evaluate.length, 0);
});

Deno.test("waitForAppReadyWith: timeoutMs は総予算として試行回数で分割される（#311）", async () => {
  const { api, calls } = createFakeAppReadyApi({});
  await waitForAppReadyWith(api, 9000);
  assertEquals(calls.waitFor[0].timeoutMs, 3000);
});

Deno.test("waitForAppReadyWith: タイムアウト時は最終観測値付きのエラーを投げる", async () => {
  const { api } = createFakeAppReadyApi({
    waitForError: new Error(`waitFor timed out after 10ms: ${APP_READY_EXPR}`),
    diag: {
      readyState: "complete",
      getYearDefined: false,
      spinnerPresent: true,
      spinnerHidden: false,
      errorToastVisible: false,
    },
  });
  const err = await assertRejects(() => waitForAppReadyWith(api, 10), Error);
  assertEquals(
    err.message,
    `waitFor timed out after 10ms: ${APP_READY_EXPR} [appReady diagnostics: ` +
      "__getYear defined=false, loading-spinner present=true hidden=false, " +
      "document.readyState=complete, error-toast visible=false]",
  );
});

Deno.test("waitForAppReadyWith: 診断の evaluate が失敗しても元のタイムアウトを報告する", async () => {
  const { api } = createFakeAppReadyApi({
    waitForError: new Error("waitFor timed out after 10ms: expr"),
    diagError: new Error("CDP connection lost (WebSocket closed)"),
  });
  const err = await assertRejects(() => waitForAppReadyWith(api, 10), Error);
  assertEquals(
    err.message,
    "waitFor timed out after 10ms: expr [appReady diagnostics: " +
      "diagnostics unavailable: CDP connection lost (WebSocket closed)]",
  );
});

Deno.test("waitForAppReadyWith: タイムアウト以外のエラーは診断を付けずそのまま伝播する", async () => {
  const { api, calls } = createFakeAppReadyApi({
    waitForError: new Error("CDP connection lost (WebSocket error)"),
  });
  const err = await assertRejects(() => waitForAppReadyWith(api, 10), Error);
  assertEquals(err.message, "CDP connection lost (WebSocket error)");
  assertEquals(calls.evaluate.length, 0);
});

// ---- チャンク取得の一過性失敗からの再 navigate 復帰（Issue #311） ----

Deno.test("APP_READY_MAX_ATTEMPTS は再 navigate を挟む試行回数（総予算は APP_READY_TIMEOUT_MS のまま）", () => {
  assertEquals(APP_READY_MAX_ATTEMPTS, 3);
  assertEquals(APP_READY_TIMEOUT_MS, 90_000);
});

Deno.test("computeAppReadyAttemptTimeoutMs: 総予算を試行回数で等分する", () => {
  assertEquals(computeAppReadyAttemptTimeoutMs(90_000, 3), 30_000);
  assertEquals(computeAppReadyAttemptTimeoutMs(10_000, 3), 3_333);
});

Deno.test("computeAppReadyAttemptTimeoutMs: 試行回数が 1 以下なら総予算をそのまま使う", () => {
  assertEquals(computeAppReadyAttemptTimeoutMs(90_000, 1), 90_000);
  assertEquals(computeAppReadyAttemptTimeoutMs(90_000, 0), 90_000);
});

Deno.test("computeAppReadyAttemptTimeoutMs: 1 試行分が 0ms にならない", () => {
  assertEquals(computeAppReadyAttemptTimeoutMs(2, 3), 1);
});

Deno.test("isRecoverableAppReadyStall: readyState=complete かつ __getYear 未定義かつトースト無しは再 navigate で復帰し得る", () => {
  assertEquals(isRecoverableAppReadyStall(CHUNK_STALL_DIAG), true);
});

Deno.test("isRecoverableAppReadyStall: readyState が complete 未満（ロード継続中）なら再 navigate しない", () => {
  assertEquals(
    isRecoverableAppReadyStall({ ...CHUNK_STALL_DIAG, readyState: "loading" }),
    false,
  );
  assertEquals(
    isRecoverableAppReadyStall({
      ...CHUNK_STALL_DIAG,
      readyState: "interactive",
    }),
    false,
  );
});

Deno.test("isRecoverableAppReadyStall: エラートースト表示中はアプリ側の確定失敗なので再 navigate しない", () => {
  assertEquals(
    isRecoverableAppReadyStall({
      ...CHUNK_STALL_DIAG,
      errorToastVisible: true,
    }),
    false,
  );
});

Deno.test("isRecoverableAppReadyStall: チャンク失敗トースト（#319）は再 navigate の対象のままにする", () => {
  // #319 でアプリ側がチャンク取得失敗をトーストで告知するようになった。この
  // トーストが指す失敗の復帰手段は「新しい文書を作る」＝再 navigate であり、
  // #311 の復帰対象そのものなので、種別 chunk のときだけ復帰可能と見なす。
  assertEquals(
    isRecoverableAppReadyStall({
      ...CHUNK_STALL_DIAG,
      errorToastVisible: true,
      errorToastKind: "chunk",
    }),
    true,
  );
});

Deno.test("isRecoverableAppReadyStall: データ取得失敗トースト（種別 data）は従来どおり再 navigate しない", () => {
  assertEquals(
    isRecoverableAppReadyStall({
      ...CHUNK_STALL_DIAG,
      errorToastVisible: true,
      errorToastKind: "data",
    }),
    false,
  );
});

Deno.test("isRecoverableAppReadyStall: チャンク失敗トーストでも readyState が complete 未満なら再 navigate しない", () => {
  assertEquals(
    isRecoverableAppReadyStall({
      ...CHUNK_STALL_DIAG,
      readyState: "loading",
      errorToastVisible: true,
      errorToastKind: "chunk",
    }),
    false,
  );
});

Deno.test("formatAppReadyDiagnostics はトーストの種別も併記する（#319）", () => {
  assertEquals(
    formatAppReadyDiagnostics({
      ...CHUNK_STALL_DIAG,
      errorToastVisible: true,
      errorToastKind: "chunk",
    }),
    "__getYear defined=false, loading-spinner present=true hidden=true, " +
      "document.readyState=complete, error-toast visible=true kind=chunk",
  );
});

Deno.test("isRecoverableAppReadyStall: __getYear 定義済み（spinner 待ち）なら再 navigate しない", () => {
  assertEquals(
    isRecoverableAppReadyStall({
      ...CHUNK_STALL_DIAG,
      getYearDefined: true,
      spinnerHidden: false,
    }),
    false,
  );
});

Deno.test("waitForAppReadyWith: チャンク取得停止を検知したら再 navigate して復帰する（#311）", async () => {
  const { api, calls } = createFakeAppReadyApi({
    waitForErrors: [
      new Error(`waitFor timed out after 30000ms: ${APP_READY_EXPR}`),
      null,
    ],
    diag: CHUNK_STALL_DIAG,
    withRenavigate: true,
  });
  await waitForAppReadyWith(api, 90_000);
  assertEquals(calls.waitFor.length, 2);
  assertEquals(calls.renavigate, 1);
});

Deno.test("waitForAppReadyWith: 再 navigate しても復帰しなければ試行回数付きで失敗する（#311）", async () => {
  const { api, calls } = createFakeAppReadyApi({
    waitForError: new Error("waitFor timed out after 30000ms: expr"),
    diag: CHUNK_STALL_DIAG,
    withRenavigate: true,
  });
  const err = await assertRejects(
    () => waitForAppReadyWith(api, 90_000),
    Error,
  );
  assertEquals(calls.waitFor.length, APP_READY_MAX_ATTEMPTS);
  assertEquals(calls.renavigate, APP_READY_MAX_ATTEMPTS - 1);
  assertEquals(
    err.message,
    "waitFor timed out after 30000ms: expr [appReady diagnostics: " +
      "__getYear defined=false, loading-spinner present=true hidden=true, " +
      "document.readyState=complete, error-toast visible=false]" +
      " (attempts=3, re-navigated 2)",
  );
});

Deno.test("waitForAppReadyWith: 再 navigate 不可（URL 未記録）なら 1 試行で失敗する（#311）", async () => {
  const { api, calls } = createFakeAppReadyApi({
    waitForError: new Error("waitFor timed out after 30000ms: expr"),
    diag: CHUNK_STALL_DIAG,
  });
  await assertRejects(() => waitForAppReadyWith(api, 90_000), Error);
  assertEquals(calls.waitFor.length, 1);
});

Deno.test("waitForAppReadyWith: 復帰し得ない状態（ロード継続中）では再 navigate せず即失敗する（#311）", async () => {
  const { api, calls } = createFakeAppReadyApi({
    waitForError: new Error("waitFor timed out after 30000ms: expr"),
    diag: { ...CHUNK_STALL_DIAG, readyState: "loading" },
    withRenavigate: true,
  });
  await assertRejects(() => waitForAppReadyWith(api, 90_000), Error);
  assertEquals(calls.waitFor.length, 1);
  assertEquals(calls.renavigate, 0);
});

Deno.test("waitForAppReadyWith: 再 navigate 自体が失敗したら理由を添えて元のタイムアウトを報告する（#311）", async () => {
  const { api } = createFakeAppReadyApi({
    waitForError: new Error("waitFor timed out after 30000ms: expr"),
    diag: CHUNK_STALL_DIAG,
    renavigateError: new Error("CDP connection lost (WebSocket closed)"),
  });
  const err = await assertRejects(
    () => waitForAppReadyWith(api, 90_000),
    Error,
  );
  assertEquals(
    err.message.endsWith(
      " (attempts=1, re-navigate failed: CDP connection lost (WebSocket closed))",
    ),
    true,
  );
});

Deno.test("buildAppReadyTimeoutMessage: 再 navigate した回数を注記に含める（#311）", () => {
  assertEquals(
    buildAppReadyTimeoutMessage("base", "diag text", {
      attempts: 3,
      renavigated: 2,
    }),
    "base [appReady diagnostics: diag text] (attempts=3, re-navigated 2)",
  );
});

Deno.test("raceWithTimeout: 期限内に解決すればその値を返す", async () => {
  assertEquals(await raceWithTimeout(Promise.resolve(7), 1000, "x"), 7);
});

Deno.test("raceWithTimeout: 期限を過ぎたらラベル付きで reject する", async () => {
  const err = await assertRejects(
    () => raceWithTimeout(new Promise<void>(() => {}), 5, "re-navigate"),
    Error,
  );
  assertEquals(err.message, "re-navigate timed out after 5ms");
});
