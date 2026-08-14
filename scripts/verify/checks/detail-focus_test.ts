/**
 * detail-focus.ts の判定関数のユニットテスト（#350）。
 *
 * ヘッドレス実行なしで「違反の判定規則」だけを固定する（cdp.ts の起動を伴う
 * run() は対象外。他の checks/*_test.ts と同じ方針）。
 */
import { assertEquals } from "@std/assert";
import {
  DETAIL_FOCUS_LAYER_IDS,
  type DetailFocusProbe,
  findDetailFocusViolations,
} from "./detail-focus.ts";

/** 全フィールドを埋めた probe。テストごとに必要な部分だけ上書きする */
function probe(overrides: Partial<DetailFocusProbe> = {}): DetailFocusProbe {
  return {
    key: "France",
    focusActive: true,
    zoomStep: 5,
    byLayer: {
      "hre-powers": 0,
      "france-fiefs": 3,
      "italy-fiefs": 0,
      "cliopatria-fiefs": 0,
      "britain-fiefs": 0,
      "sovereign-fiefs": 0,
    },
    suzerainKeysDrawn: ["France"],
    powerFill: {
      featureCount: 10,
      baseOutsideCount: 9,
      detailInsideCount: 1,
    },
    focusedLabelTexts: ["シャンパーニュ伯領"],
    ...overrides,
  };
}

Deno.test("DETAIL_FOCUS_LAYER_IDS は絞り込み対象の 6 系統（political_layers の契約）", () => {
  assertEquals([...DETAIL_FOCUS_LAYER_IDS], [
    "hre-powers",
    "france-fiefs",
    "italy-fiefs",
    "cliopatria-fiefs",
    "britain-fiefs",
    "sovereign-fiefs",
  ]);
});

Deno.test("findDetailFocusViolations: 正常な focus 表示は違反なし（#350 AC1）", () => {
  assertEquals(findDetailFocusViolations(probe(), "z5"), []);
});

Deno.test("findDetailFocusViolations: 領邦が 2 つ以上の上位勢力へまたがれば違反（#350 AC1）", () => {
  const violations = findDetailFocusViolations(
    probe({
      suzerainKeysDrawn: ["France", "Holy Roman Empire"],
      byLayer: {
        "hre-powers": 2,
        "france-fiefs": 3,
        "italy-fiefs": 0,
        "cliopatria-fiefs": 0,
        "britain-fiefs": 0,
        "sovereign-fiefs": 0,
      },
    }),
    "z5",
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0].includes("z5"), true);
});

Deno.test("findDetailFocusViolations: focus 以外の宗主が描かれていれば違反（#350 AC1）", () => {
  assertEquals(
    findDetailFocusViolations(
      probe({ suzerainKeysDrawn: ["Holy Roman Empire"] }),
      "z6",
    ).length,
    1,
  );
});

Deno.test("findDetailFocusViolations: 合成後の塗りが focus 外 base ∪ focus 内 flat と一致しなければ違反（#350 AC2）", () => {
  assertEquals(
    findDetailFocusViolations(
      probe({
        powerFill: {
          featureCount: 9,
          baseOutsideCount: 9,
          detailInsideCount: 1,
        },
      }),
      "z5",
    ).length,
    1,
  );
});

Deno.test("findDetailFocusViolations: 中央が海上なら領邦が 1 枚でも描かれていれば違反（#350 AC5）", () => {
  const sea = probe({
    key: null,
    suzerainKeysDrawn: [],
    byLayer: {
      "hre-powers": 0,
      "france-fiefs": 1,
      "italy-fiefs": 0,
      "cliopatria-fiefs": 0,
      "britain-fiefs": 0,
      "sovereign-fiefs": 0,
    },
    powerFill: { featureCount: 10, baseOutsideCount: 10, detailInsideCount: 0 },
    focusedLabelTexts: [],
  });
  assertEquals(findDetailFocusViolations(sea, "z5").length, 1);
  // 領邦が 1 枚も描かれず、塗りが全て素の base なら違反なし
  assertEquals(
    findDetailFocusViolations(
      { ...sea, byLayer: { ...sea.byLayer, "france-fiefs": 0 } },
      "z5",
    ),
    [],
  );
});

Deno.test("findDetailFocusViolations: 中央が海上で派生 base を塗っていれば違反（#350 AC5 の透明な穴）", () => {
  assertEquals(
    findDetailFocusViolations(
      probe({
        key: null,
        suzerainKeysDrawn: [],
        byLayer: Object.fromEntries(
          DETAIL_FOCUS_LAYER_IDS.map((id) => [id, 0]),
        ),
        powerFill: {
          featureCount: 10,
          baseOutsideCount: 8,
          detailInsideCount: 2,
        },
        focusedLabelTexts: [],
      }),
      "z5",
    ).length,
    1,
  );
});

Deno.test("findDetailFocusViolations: 概観（z4）は focus 非適用で領邦が描かれないこと（#350 AC8）", () => {
  const overview = probe({
    key: null,
    focusActive: false,
    zoomStep: 4,
    byLayer: Object.fromEntries(DETAIL_FOCUS_LAYER_IDS.map((id) => [id, 0])),
    suzerainKeysDrawn: [],
    powerFill: { featureCount: 10, baseOutsideCount: 10, detailInsideCount: 0 },
    focusedLabelTexts: [],
  });
  assertEquals(findDetailFocusViolations(overview, "z4"), []);
  // z4 で focus が効いてしまっている（機構が z4 まで降りてきた）なら違反
  assertEquals(
    findDetailFocusViolations(
      { ...overview, focusActive: true, key: "France" },
      "z4",
    ).length,
    1,
  );
});

Deno.test("findDetailFocusViolations: 詳細段（z5 以上）で focus 機構が無効なら違反（#350 AC1）", () => {
  assertEquals(
    findDetailFocusViolations(probe({ focusActive: false }), "z5").length,
    1,
  );
});
