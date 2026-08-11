import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { DEFAULT_PORT } from "../serve.ts";
import {
  buildDeviceMetricsParams,
  buildTapEvents,
  buildTouchEmulationParams,
  buildWaitForExpr,
  buildWindowSizeArg,
  createCdpSession,
  DEFAULT_APP_URL,
  DEVICE_PRESETS,
  type EmulationConfig,
  LANDSCAPE_PRESET,
  MOBILE_PRESET,
  openBrokerSession,
  parseBrokerSessionResponse,
  parseCliArgs,
  parseEvaluateResult,
  pickPageTargetUrl,
  resolveBrokerConfig,
  resolveCheckScriptUrl,
  resolveDevicePreset,
  resolveKeyCode,
  rewriteWsUrlHost,
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

Deno.test("DEVICE_PRESETS: mobile プリセットが登録されている", () => {
  assertEquals(DEVICE_PRESETS.mobile, MOBILE_PRESET);
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
