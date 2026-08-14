import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  buildDeckOverlayReadyExpr,
  DECK_LABEL_CANVAS_ID,
  DECK_OVERLAY_READY_DIAG_EXPR,
  DECK_OVERLAY_READY_TIMEOUT_MS,
  type DeckOverlayReadyDiagnostics,
  findLabelRenderProblems,
  formatDeckOverlayReadyDiagnostics,
  LABEL_RENDER_PROBE_EXPR,
  LABEL_RENDER_WAIT_TIMEOUT_PREFIX,
  type LabelRenderProbe,
  waitForDeckOverlayReady,
} from "./label_render.ts";

/** 正常系（--force-device-scale-factor=3 + DPR 3 エミュレーション相当）。 */
function healthyProbe(): LabelRenderProbe {
  return {
    devicePixelRatio: 3,
    deckCanvas: {
      cssWidth: 390,
      cssHeight: 844,
      bufferWidth: 1170,
      bufferHeight: 2532,
    },
    labelCounts: { power: 55, city: 23, river: 27, mountain: 9 },
  };
}

Deno.test("findLabelRenderProblems: 正常な計測では問題なし（#320）", () => {
  assertEquals(findLabelRenderProblems(healthyProbe()), []);
});

Deno.test("findLabelRenderProblems: DPR 1 のデスクトップ条件でも問題なし（#320 AC3）", () => {
  assertEquals(
    findLabelRenderProblems({
      devicePixelRatio: 1,
      deckCanvas: {
        cssWidth: 1600,
        cssHeight: 757,
        bufferWidth: 1600,
        bufferHeight: 757,
      },
      labelCounts: { power: 55, city: 23, river: 27, mountain: 9 },
    }),
    [],
  );
});

Deno.test("findLabelRenderProblems: ラベル canvas が CSS ピクセル解像度のままなら検出する（#320 の再現条件）", () => {
  // Emulation.setDeviceMetricsOverride だけを掛けた現行ハーネスの実測値:
  // window.devicePixelRatio は 3 だが deck の overlaid canvas は 390x844 の
  // ままで、TextLayer のラベルが 1 つも描画されない。
  const problems = findLabelRenderProblems({
    devicePixelRatio: 3,
    deckCanvas: {
      cssWidth: 390,
      cssHeight: 844,
      bufferWidth: 390,
      bufferHeight: 844,
    },
    labelCounts: { power: 55, city: 23, river: 27, mountain: 9 },
  });
  assertEquals(problems.length, 1);
  assertStringIncludes(problems[0], "1170x2532");
  assertStringIncludes(problems[0], "390x844");
});

Deno.test("findLabelRenderProblems: 端数はサブピクセル 1px まで許容する（#320）", () => {
  assertEquals(
    findLabelRenderProblems({
      devicePixelRatio: 3,
      deckCanvas: {
        cssWidth: 390.4,
        cssHeight: 843.6,
        bufferWidth: 1171,
        bufferHeight: 2531,
      },
      labelCounts: { power: 55, city: 23, river: 27, mountain: 9 },
    }),
    [],
  );
});

Deno.test("findLabelRenderProblems: ラベル canvas が無ければ検出する（#320）", () => {
  const problems = findLabelRenderProblems({
    ...healthyProbe(),
    deckCanvas: null,
  });
  assertEquals(problems.length, 1);
  assertStringIncludes(problems[0], DECK_LABEL_CANVAS_ID);
});

Deno.test("findLabelRenderProblems: 4 種のラベルそれぞれの 0 件を検出する（#320 AC2）", () => {
  for (
    const [kind, label] of [
      ["power", "勢力名"],
      ["city", "都市名"],
      ["river", "河川名"],
      ["mountain", "山岳名"],
    ] as const
  ) {
    const probe = healthyProbe();
    const problems = findLabelRenderProblems({
      ...probe,
      labelCounts: { ...probe.labelCounts, [kind]: 0 },
    });
    assertEquals(problems.length, 1, kind);
    assertStringIncludes(problems[0], label);
  }
});

// ---- deck オーバーレイ初期化待ち（#384） ----

Deno.test("buildDeckOverlayReadyExpr: canvas の実解像度とラベル系フックの両方を条件に含む（#384）", () => {
  const expr = buildDeckOverlayReadyExpr();
  // #deckgl-overlay のドローイングバッファが innerWidth * DPR 以上であること
  assertStringIncludes(expr, DECK_LABEL_CANVAS_ID);
  assertStringIncludes(expr, "innerWidth");
  assertStringIncludes(expr, "innerHeight");
  assertStringIncludes(expr, "devicePixelRatio");
  // ラベル系デバッグフックが定義済みであること
  for (
    const hook of [
      "__getPowerLabelDebug",
      "__getCityDebug",
      "__getRiverLabelDebug",
      "__getMountainLabelDebug",
    ]
  ) {
    assertStringIncludes(expr, hook);
  }
});

Deno.test("DECK_OVERLAY_READY_DIAG_EXPR: 待機タイムアウトの切り分けに使う観測値を採取する（#384）", () => {
  for (
    const key of [
      "deckCanvasPresent",
      "bufferWidth",
      "bufferHeight",
      "expectedBufferWidth",
      "expectedBufferHeight",
      "missingHooks",
    ]
  ) {
    assertStringIncludes(DECK_OVERLAY_READY_DIAG_EXPR, key);
  }
});

Deno.test("formatDeckOverlayReadyDiagnostics: 観測値を 1 行で読める形にする（#384）", () => {
  const text = formatDeckOverlayReadyDiagnostics({
    deckCanvasPresent: true,
    bufferWidth: 300,
    bufferHeight: 150,
    expectedBufferWidth: 1170,
    expectedBufferHeight: 2532,
    devicePixelRatio: 3,
    missingHooks: ["__getCityDebug"],
  });
  assertStringIncludes(text, "300x150");
  assertStringIncludes(text, "1170x2532");
  assertStringIncludes(text, "__getCityDebug");
});

/** waitFor / evaluate を差し替えた擬似 CdpApi を作る */
function fakeApi(
  waitForImpl: (expr: string, timeoutMs?: number) => Promise<void>,
  diag: DeckOverlayReadyDiagnostics | null = null,
) {
  const calls: Array<{ expr: string; timeoutMs?: number }> = [];
  return {
    calls,
    api: {
      waitFor: (expr: string, timeoutMs?: number) => {
        calls.push({ expr, timeoutMs });
        return waitForImpl(expr, timeoutMs);
      },
      evaluate: <T>(_expr: string): Promise<T> =>
        diag === null
          ? Promise.reject(new Error("no diagnostics"))
          : Promise.resolve(diag as T),
    },
  };
}

Deno.test("waitForDeckOverlayReady: 条件が成立すれば待機式を 1 回だけ評価して返る（#384）", async () => {
  const { api, calls } = fakeApi(() => Promise.resolve());
  await waitForDeckOverlayReady(api);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].expr, buildDeckOverlayReadyExpr());
  assertEquals(calls[0].timeoutMs, DECK_OVERLAY_READY_TIMEOUT_MS);
});

Deno.test("waitForDeckOverlayReady: タイムアウトは「待機タイムアウト」として明示的に失敗する（#384 AC4）", async () => {
  const { api } = fakeApi(
    () => Promise.reject(new Error("waitFor timed out after 30000ms: <expr>")),
    {
      deckCanvasPresent: true,
      bufferWidth: 300,
      bufferHeight: 150,
      expectedBufferWidth: 1170,
      expectedBufferHeight: 2532,
      devicePixelRatio: 3,
      missingHooks: [],
    },
  );
  const error = await assertRejects(
    () => waitForDeckOverlayReady(api),
    Error,
  );
  // ラベル 0 件・canvas 300x150 のような紛らわしい失敗ではなく、待機の
  // タイムアウトであることが一目で分かるメッセージにする
  assertStringIncludes(error.message, LABEL_RENDER_WAIT_TIMEOUT_PREFIX);
  assertStringIncludes(error.message, "300x150");
  assertStringIncludes(error.message, "1170x2532");
});

Deno.test("waitForDeckOverlayReady: 診断の採取に失敗してもタイムアウトを握り潰さない（#384 AC4）", async () => {
  const { api } = fakeApi(
    () => Promise.reject(new Error("waitFor timed out after 30000ms: <expr>")),
  );
  const error = await assertRejects(() => waitForDeckOverlayReady(api), Error);
  assertStringIncludes(error.message, LABEL_RENDER_WAIT_TIMEOUT_PREFIX);
  assertStringIncludes(error.message, "diagnostics unavailable");
});

Deno.test("waitForDeckOverlayReady: タイムアウト以外のエラーはそのまま伝播する（#384）", async () => {
  const { api } = fakeApi(() =>
    Promise.reject(new Error("CDP connection lost (WebSocket closed)"))
  );
  const error = await assertRejects(() => waitForDeckOverlayReady(api), Error);
  assertEquals(error.message, "CDP connection lost (WebSocket closed)");
});

Deno.test("LABEL_RENDER_PROBE_EXPR: 4 種のラベルのデバッグフックと deck canvas を参照する（#320）", () => {
  for (
    const hook of [
      "__getPowerLabelDebug",
      "__getCityDebug",
      "__getRiverLabelDebug",
      "__getMountainLabelDebug",
    ]
  ) {
    assertStringIncludes(LABEL_RENDER_PROBE_EXPR, hook);
  }
  assertStringIncludes(LABEL_RENDER_PROBE_EXPR, DECK_LABEL_CANVAS_ID);
  assertStringIncludes(LABEL_RENDER_PROBE_EXPR, "devicePixelRatio");
});
