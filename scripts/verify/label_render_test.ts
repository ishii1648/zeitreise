import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  DECK_LABEL_CANVAS_ID,
  findLabelRenderProblems,
  LABEL_RENDER_PROBE_EXPR,
  type LabelRenderProbe,
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
