import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  buildYearReflectedOrErrorExpr,
  CANVAS_CENTER_EXPR,
  ERROR_TOAST_STATE_EXPR,
  waitForYearReflected,
  YEAR_REFLECT_TIMEOUT_MS,
} from "./smoke.ts";

/**
 * CANVAS_CENTER_EXPR をスタブ document で評価するヘルパー。
 * ブラウザ内評価と同じ式文字列を Function として実行し、rect 原点を
 * 考慮したビューポート座標が返ることを検証する。
 */
function evalCenterExpr(
  rect: { left: number; top: number; width: number; height: number },
): [number, number] {
  const stubDocument = {
    querySelector: () => ({ getBoundingClientRect: () => rect }),
  };
  const fn = new Function("document", `return ${CANVAS_CENTER_EXPR};`);
  return fn(stubDocument) as [number, number];
}

Deno.test("CANVAS_CENTER_EXPR: canvas が原点にある場合は width/2, height/2 を返す", () => {
  assertEquals(
    evalCenterExpr({ left: 0, top: 0, width: 1600, height: 900 }),
    [800, 450],
  );
});

Deno.test("CANVAS_CENTER_EXPR: canvas が原点以外にある場合も rect 原点を加味したビューポート座標を返す", () => {
  assertEquals(
    evalCenterExpr({ left: 100, top: 50, width: 200, height: 100 }),
    [200, 100],
  );
});

// ---- 年代反映待ち（Issue #282） ----

/** ERROR_TOAST_STATE_EXPR / buildYearReflectedOrErrorExpr 用のスタブ要素。 */
interface StubToast {
  display?: string;
  visibility?: string;
  offsetParent?: unknown;
  textContent?: string;
}

/**
 * ブラウザ内評価と同じ式文字列をスタブ document / window で実行するヘルパー。
 * toast が undefined なら `.error-toast` 要素なし、year は window.__getYear の
 * 返り値（undefined なら __getYear 自体が未定義 = アプリ初期化前）を表す。
 */
function evalInStub(
  expr: string,
  opts: { toast?: StubToast; year?: number } = {},
): unknown {
  const el = opts.toast === undefined ? null : {
    offsetParent: "offsetParent" in opts.toast ? opts.toast.offsetParent : {},
    textContent: opts.toast.textContent ?? "",
  };
  const stubDocument = {
    querySelector: (sel: string) => (sel === ".error-toast" ? el : null),
  };
  const stubWindow = {
    __getYear: opts.year === undefined ? undefined : () => opts.year,
    getComputedStyle: () => ({
      display: opts.toast?.display ?? "block",
      visibility: opts.toast?.visibility ?? "visible",
    }),
  };
  const fn = new Function("document", "window", `return ${expr};`);
  return fn(stubDocument, stubWindow);
}

Deno.test("ERROR_TOAST_STATE_EXPR: 要素が無ければ present も visible も false", () => {
  assertEquals(evalInStub(ERROR_TOAST_STATE_EXPR), {
    present: false,
    visible: false,
    text: null,
  });
});

Deno.test("ERROR_TOAST_STATE_EXPR: 可視トーストは visible: true とテキストを返す", () => {
  assertEquals(
    evalInStub(ERROR_TOAST_STATE_EXPR, {
      toast: { textContent: "1500年のデータ取得に失敗しました" },
    }),
    { present: true, visible: true, text: "1500年のデータ取得に失敗しました" },
  );
});

Deno.test("ERROR_TOAST_STATE_EXPR: display:none のトーストは visible: false", () => {
  assertEquals(
    evalInStub(ERROR_TOAST_STATE_EXPR, {
      toast: { display: "none", textContent: "x" },
    }),
    { present: true, visible: false, text: "x" },
  );
});

Deno.test("ERROR_TOAST_STATE_EXPR: offsetParent が null のトーストは visible: false", () => {
  assertEquals(
    evalInStub(ERROR_TOAST_STATE_EXPR, {
      toast: { offsetParent: null, textContent: "x" },
    }),
    { present: true, visible: false, text: "x" },
  );
});

Deno.test("buildYearReflectedOrErrorExpr: 年が一致すれば true", () => {
  assertEquals(
    evalInStub(buildYearReflectedOrErrorExpr(1500), { year: 1500 }),
    true,
  );
});

Deno.test("buildYearReflectedOrErrorExpr: 年が不一致・トーストなしなら false（待機継続）", () => {
  assertEquals(
    evalInStub(buildYearReflectedOrErrorExpr(1500), { year: 1000 }),
    false,
  );
});

Deno.test("buildYearReflectedOrErrorExpr: __getYear 未定義でもトーストが無ければ false", () => {
  assertEquals(evalInStub(buildYearReflectedOrErrorExpr(1500)), false);
});

Deno.test("buildYearReflectedOrErrorExpr: 年が不一致でも可視トーストがあれば true（早期打ち切り）", () => {
  assertEquals(
    evalInStub(buildYearReflectedOrErrorExpr(1500), {
      year: 1000,
      toast: { textContent: "取得失敗" },
    }),
    true,
  );
});

Deno.test("buildYearReflectedOrErrorExpr: 非可視トーストでは true にならない", () => {
  assertEquals(
    evalInStub(buildYearReflectedOrErrorExpr(1500), {
      year: 1000,
      toast: { display: "none", textContent: "取得失敗" },
    }),
    false,
  );
});

Deno.test("YEAR_REFLECT_TIMEOUT_MS: 本番実測で不足した旧値 15s を上回る", () => {
  // Issue #282: 15s では本番の年代 GeoJSON ロードのワーストに間欠的に届かない
  assertEquals(YEAR_REFLECT_TIMEOUT_MS > 15_000, true);
});

/** waitForYearReflected 用の fake api（waitFor / evaluate のみ）。 */
function fakeApi(opts: {
  waitForError?: Error;
  reflected: boolean;
  toast?: { present: boolean; visible: boolean; text: string | null };
}) {
  const calls: { waitFor: Array<[string, number | undefined]> } = {
    waitFor: [],
  };
  return {
    calls,
    waitFor(expr: string, timeoutMs?: number): Promise<void> {
      calls.waitFor.push([expr, timeoutMs]);
      return opts.waitForError
        ? Promise.reject(opts.waitForError)
        : Promise.resolve();
    },
    evaluate<T = unknown>(expr: string): Promise<T> {
      if (expr === ERROR_TOAST_STATE_EXPR) {
        return Promise.resolve(
          (opts.toast ?? { present: false, visible: false, text: null }) as T,
        );
      }
      return Promise.resolve(opts.reflected as T);
    },
  };
}

Deno.test("waitForYearReflected: 年が反映されれば resolve し既定タイムアウトを使う", async () => {
  const api = fakeApi({ reflected: true });
  await waitForYearReflected(api, 1500);
  assertEquals(api.calls.waitFor.length, 1);
  assertEquals(api.calls.waitFor[0][1], YEAR_REFLECT_TIMEOUT_MS);
});

Deno.test("waitForYearReflected: トースト可視で抜けた場合はトーストのテキストを含めて reject", async () => {
  const api = fakeApi({
    reflected: false,
    toast: { present: true, visible: true, text: "1500年のデータ取得に失敗" },
  });
  const err = await assertRejects(() => waitForYearReflected(api, 1500));
  assertStringIncludes(String(err), "1500年のデータ取得に失敗");
});

Deno.test("waitForYearReflected: waitFor のタイムアウトはそのまま伝播する", async () => {
  const api = fakeApi({
    reflected: false,
    waitForError: new Error("waitFor timed out after 45000ms: ..."),
  });
  const err = await assertRejects(() => waitForYearReflected(api, 1500));
  assertStringIncludes(String(err), "waitFor timed out");
});
