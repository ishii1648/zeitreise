/**
 * data/known-limitations.json のパーサ（scripts/known_limitations.ts）の
 * ユニットテスト。
 *
 * #328 でユーザー向け表示（左上の⚠パネル）は撤去したが、データ本体と
 * その静的検証は開発者向け記録として維持する（AC8）。ここが検証するのは
 * 「壊れたデータを安全に受け流すパース」と「年代該当判定」で、
 * scripts/known-limitations-json_test.ts がリポジトリ内の実データを
 * このパーサに通している。
 */
import { assertEquals } from "@std/assert";
import {
  isKnownLimitationActiveForYear,
  type KnownLimitation,
  parseKnownLimitations,
} from "./known_limitations.ts";

// ---- parseKnownLimitations: fetch した JSON の受け入れ・バリデーション ----

Deno.test("parseKnownLimitations は limitations 配列の有効なエントリを返す", () => {
  const json: unknown = {
    limitations: [
      { id: "a", years: { from: 1000, to: 1492 }, text: "text-a" },
      { id: "b", text: "text-b" },
    ],
  };
  const result = parseKnownLimitations(json);
  assertEquals(result.length, 2);
  assertEquals(result[0], {
    id: "a",
    years: { from: 1000, to: 1492 },
    text: "text-a",
  });
  assertEquals(result[1], { id: "b", text: "text-b" });
});

Deno.test("parseKnownLimitations はオブジェクト以外（null / 配列 / 文字列）を空配列にする", () => {
  const warn = suppressWarn();
  try {
    assertEquals(parseKnownLimitations(null), []);
    assertEquals(parseKnownLimitations([]), []);
    assertEquals(parseKnownLimitations("{}"), []);
  } finally {
    warn.restore();
  }
});

Deno.test("parseKnownLimitations は limitations が無い/非配列の JSON を空配列にする", () => {
  const warn = suppressWarn();
  try {
    assertEquals(parseKnownLimitations({}), []);
    assertEquals(parseKnownLimitations({ limitations: "broken" }), []);
    assertEquals(parseKnownLimitations({ limitations: {} }), []);
  } finally {
    warn.restore();
  }
});

Deno.test("parseKnownLimitations は id/text を欠くエントリを 1 件単位で除外する", () => {
  const warn = suppressWarn();
  try {
    const json: unknown = {
      limitations: [
        { id: "ok", text: "valid" },
        { id: "no-text" },
        { text: "no-id" },
        "broken-entry",
        null,
      ],
    };
    const result = parseKnownLimitations(json);
    assertEquals(result, [{ id: "ok", text: "valid" }]);
  } finally {
    warn.restore();
  }
});

Deno.test("parseKnownLimitations は id/text が空文字のエントリを除外する", () => {
  const warn = suppressWarn();
  try {
    const json: unknown = {
      limitations: [
        { id: "", text: "valid" },
        { id: "ok", text: "" },
      ],
    };
    assertEquals(parseKnownLimitations(json), []);
  } finally {
    warn.restore();
  }
});

Deno.test("parseKnownLimitations は years が不正形（from>to・非数値・欠落フィールド）のエントリを除外する", () => {
  const warn = suppressWarn();
  try {
    const json: unknown = {
      limitations: [
        { id: "a", years: { from: 1500, to: 1400 }, text: "t" },
        { id: "b", years: { from: "1500", to: 1600 }, text: "t" },
        { id: "c", years: { from: 1500 }, text: "t" },
        { id: "d", years: null, text: "t" },
      ],
    };
    assertEquals(parseKnownLimitations(json), []);
  } finally {
    warn.restore();
  }
});

Deno.test("parseKnownLimitations は years が同一年（from===to）のエントリを受け入れる", () => {
  const json: unknown = {
    limitations: [{ id: "a", years: { from: 1200, to: 1200 }, text: "t" }],
  };
  assertEquals(parseKnownLimitations(json), [
    { id: "a", years: { from: 1200, to: 1200 }, text: "t" },
  ]);
});

// ---- summary フィールド（#175: 要約と詳細の分離） ----

Deno.test("parseKnownLimitations は summary 付きエントリを受け入れる", () => {
  const json: unknown = {
    limitations: [
      { id: "a", text: "詳細な本文。", summary: "要約。" },
    ],
  };
  assertEquals(parseKnownLimitations(json), [
    { id: "a", text: "詳細な本文。", summary: "要約。" },
  ]);
});

Deno.test("parseKnownLimitations は summary 省略エントリをそのまま受け入れる（後方互換）", () => {
  const json: unknown = {
    limitations: [{ id: "a", text: "本文のみ。" }],
  };
  assertEquals(parseKnownLimitations(json), [{ id: "a", text: "本文のみ。" }]);
});

Deno.test("parseKnownLimitations は summary が非文字列・空文字のエントリを 1 件単位で除外する", () => {
  const warn = suppressWarn();
  try {
    const json: unknown = {
      limitations: [
        { id: "ok", text: "t", summary: "s" },
        { id: "num", text: "t", summary: 123 },
        { id: "empty", text: "t", summary: "" },
        { id: "null", text: "t", summary: null },
      ],
    };
    assertEquals(parseKnownLimitations(json), [
      { id: "ok", text: "t", summary: "s" },
    ]);
  } finally {
    warn.restore();
  }
});

// ---- isKnownLimitationActiveForYear: 年代該当判定 ----

Deno.test("isKnownLimitationActiveForYear は years 省略時は常に true", () => {
  const limitation: KnownLimitation = { id: "a", text: "t" };
  assertEquals(isKnownLimitationActiveForYear(limitation, 1000), true);
  assertEquals(isKnownLimitationActiveForYear(limitation, 1914), true);
});

Deno.test("isKnownLimitationActiveForYear は years 範囲内（境界含む）で true", () => {
  const limitation: KnownLimitation = {
    id: "a",
    years: { from: 1000, to: 1492 },
    text: "t",
  };
  assertEquals(isKnownLimitationActiveForYear(limitation, 1000), true);
  assertEquals(isKnownLimitationActiveForYear(limitation, 1492), true);
  assertEquals(isKnownLimitationActiveForYear(limitation, 1200), true);
});

Deno.test("isKnownLimitationActiveForYear は years 範囲外で false", () => {
  const limitation: KnownLimitation = {
    id: "a",
    years: { from: 1530, to: 1700 },
    text: "t",
  };
  assertEquals(isKnownLimitationActiveForYear(limitation, 1500), false);
  assertEquals(isKnownLimitationActiveForYear(limitation, 1715), false);
});

/**
 * console.warn を一時的に無効化し、意図的な不正データ入力テストの出力ノイズを
 * 抑える（known_limitations は不正データで警告を出す設計のため）。
 */
function suppressWarn(): { restore: () => void } {
  const original = console.warn;
  console.warn = () => {};
  return {
    restore: () => {
      console.warn = original;
    },
  };
}
