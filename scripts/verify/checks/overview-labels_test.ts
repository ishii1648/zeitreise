import { assertEquals } from "@std/assert";
import {
  findOverviewAuditProblems,
  type OverviewAuditProbe,
} from "./overview-labels.ts";

function probe(
  overrides: Partial<OverviewAuditProbe> = {},
): OverviewAuditProbe {
  return {
    zoomStep: 4,
    politicalLevel: "overview",
    overviewLabels: [{
      text: "ラシュカ",
      displayText: "ラシュカ",
      fontSize: 18,
      position: [20, 44],
      screen: { x: 900, y: 500 },
    }],
    ...overrides,
  };
}

Deno.test("findOverviewAuditProblems: z4 の一意な画面内候補は問題なし（#442）", () => {
  assertEquals(findOverviewAuditProblems(probe()), []);
});

Deno.test("findOverviewAuditProblems: 同名・モード違いを検出する", () => {
  const problems = findOverviewAuditProblems(probe({
    zoomStep: 5,
    politicalLevel: "mid",
    overviewLabels: [
      {
        text: "ラシュカ",
        displayText: "ラシュカ",
        fontSize: 18,
        position: [20, 44],
        screen: { x: -1, y: 500 },
      },
      {
        text: "ラシュカ",
        displayText: "ラシュカ",
        fontSize: 18,
        position: [21, 44],
        screen: { x: 900, y: 901 },
      },
    ],
  }));
  assertEquals(problems.some((p) => p.includes("overview 条件不一致")), true);
  assertEquals(problems.some((p) => p.includes("同名候補")), true);
  assertEquals(problems.some((p) => p.includes("画面外アンカー")), false);
});

Deno.test("findOverviewAuditProblems: 元から監査範囲外の候補は救済移動の退行に数えない", () => {
  assertEquals(
    findOverviewAuditProblems(probe({
      overviewLabels: [{
        text: "グリーンランド",
        displayText: "グリーンランド",
        fontSize: 18,
        position: [-40, 70],
        screen: { x: -100, y: -100 },
      }],
    })),
    [],
  );
});

Deno.test("findOverviewAuditProblems: unreadable size and excess lines fail", () => {
  const data = probe();
  data.overviewLabels[0].fontSize = 12;
  data.overviewLabels[0].displayText = "ラ\nシュ\nカ";
  assertEquals(findOverviewAuditProblems(data), [
    "文字サイズ下限: ラシュカ",
    "3行以上: ラシュカ",
  ]);
});
