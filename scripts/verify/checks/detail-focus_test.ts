/**
 * detail-focus.ts の判定関数のユニットテスト（#350）。
 *
 * ヘッドレス実行なしで「違反の判定規則」だけを固定する（cdp.ts の起動を伴う
 * run() は対象外。他の checks/*_test.ts と同じ方針）。
 */
import { assert, assertEquals } from "@std/assert";
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
      flatCount: 8,
      hiddenFiefCount: 2,
    },
    totalFiefCount: 5,
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
      // 描画 5 + 肩代わり 0 = 全 5（内訳の違反は出さない）
      powerFill: { featureCount: 8, flatCount: 8, hiddenFiefCount: 0 },
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

Deno.test("findDetailFocusViolations: 塗りが「派生 base + 肩代わり分」と一致しなければ違反（#382 AC2）", () => {
  assertEquals(
    findDetailFocusViolations(
      probe({
        powerFill: { featureCount: 9, flatCount: 8, hiddenFiefCount: 2 },
      }),
      "z5",
    ).length,
    1,
  );
});

Deno.test("findDetailFocusViolations: 描画 + 肩代わりが全諸侯領と一致しなければ違反（#382）", () => {
  // 未塗装の穴（描画 3 + 肩代わり 1 < 全 5）
  const hole = findDetailFocusViolations(
    probe({
      powerFill: { featureCount: 9, flatCount: 8, hiddenFiefCount: 1 },
    }),
    "z5",
  );
  assertEquals(hole.length, 1);
  assertEquals(hole[0].includes("未塗装の穴"), true);
  // 二重塗り（描画 3 + 肩代わり 3 > 全 5）
  assertEquals(
    findDetailFocusViolations(
      probe({
        powerFill: { featureCount: 11, flatCount: 8, hiddenFiefCount: 3 },
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
    powerFill: { featureCount: 10, flatCount: 5, hiddenFiefCount: 5 },
    focusedLabelTexts: [],
  });
  // 1 枚でも描かれると「描画 1 + 肩代わり 5 ≠ 全 5」も同時に崩れる
  assertEquals(findDetailFocusViolations(sea, "z5").length, 2);
  // 領邦が 1 枚も描かれず、その全てを powers が塗るなら違反なし
  assertEquals(
    findDetailFocusViolations(
      { ...sea, byLayer: { ...sea.byLayer, "france-fiefs": 0 } },
      "z5",
    ),
    [],
  );
});

Deno.test("findDetailFocusViolations: 中央が海上で肩代わりされない諸侯領があれば違反（#350 AC5 の透明な穴）", () => {
  const violations = findDetailFocusViolations(
    probe({
      key: null,
      suzerainKeysDrawn: [],
      byLayer: Object.fromEntries(
        DETAIL_FOCUS_LAYER_IDS.map((id) => [id, 0]),
      ),
      // 領邦は 1 枚も描かれていないのに肩代わりも 3 件しかない = 2 件が白い穴
      powerFill: { featureCount: 8, flatCount: 5, hiddenFiefCount: 3 },
      focusedLabelTexts: [],
    }),
    "z5",
  );
  assertEquals(violations.length, 2);
});

Deno.test("findDetailFocusViolations: 概観（z4）は focus 非適用で領邦が描かれないこと（#350 AC8）", () => {
  const overview = probe({
    key: null,
    focusActive: false,
    zoomStep: 4,
    byLayer: Object.fromEntries(DETAIL_FOCUS_LAYER_IDS.map((id) => [id, 0])),
    suzerainKeysDrawn: [],
    powerFill: { featureCount: 10, flatCount: 10, hiddenFiefCount: 0 },
    focusedLabelTexts: [],
  });
  assertEquals(findDetailFocusViolations(overview, "z4"), []);
  // z4 で focus が効いてしまっている（機構が z4 まで降りてきた）なら違反
  // （諸侯領の内訳検査も focus 適用中の扱いになるため、違反は 1 件に限らない）
  assert(
    findDetailFocusViolations(
      { ...overview, focusActive: true, key: "France" },
      "z4",
    ).some((v) => v.includes("概観段")),
  );
});

Deno.test("findDetailFocusViolations: 詳細段（z5 以上）で focus 機構が無効なら違反（#350 AC1）", () => {
  assertEquals(
    findDetailFocusViolations(probe({ focusActive: false }), "z5").length,
    1,
  );
});
