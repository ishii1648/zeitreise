import { assertEquals } from "@std/assert";
import {
  formatKnownLimitationYears,
  isKnownLimitationActiveForYear,
  KNOWN_LIMITATION_SUMMARY_MAX_CHARS,
  type KnownLimitation,
  knownLimitationEntries,
  knownLimitationSummary,
  parseKnownLimitations,
  visibleKnownLimitationEntries,
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

// ---- knownLimitationSummary: 表示用の要約（欠落時は text 冒頭で縮退） ----

Deno.test("knownLimitationSummary は summary があればそれを返す", () => {
  const limitation: KnownLimitation = {
    id: "a",
    text: "長い詳細。続きの文。",
    summary: "短い要約。",
  };
  assertEquals(knownLimitationSummary(limitation), "短い要約。");
});

Deno.test("knownLimitationSummary は summary 欠落時に text の先頭 1 文で代替する", () => {
  const limitation: KnownLimitation = {
    id: "a",
    text: "最初の文。二番目の文。三番目の文。",
  };
  assertEquals(knownLimitationSummary(limitation), "最初の文。");
});

Deno.test("knownLimitationSummary は句点の無い text をそのまま使う（120 字以内）", () => {
  const limitation: KnownLimitation = { id: "a", text: "句点なしの短文" };
  assertEquals(knownLimitationSummary(limitation), "句点なしの短文");
});

Deno.test("knownLimitationSummary は代替文が 120 字を超えるとき 119 字 + … に切り詰める", () => {
  const long = "あ".repeat(KNOWN_LIMITATION_SUMMARY_MAX_CHARS + 10);
  // 句点なしで 130 字
  const noPeriod: KnownLimitation = { id: "a", text: long };
  const truncated = knownLimitationSummary(noPeriod);
  assertEquals(
    [...truncated].length,
    KNOWN_LIMITATION_SUMMARY_MAX_CHARS,
  );
  assertEquals(
    truncated,
    "あ".repeat(KNOWN_LIMITATION_SUMMARY_MAX_CHARS - 1) + "…",
  );
  // 先頭 1 文自体が 120 字を超える場合も同様に切り詰める
  const longSentence: KnownLimitation = {
    id: "b",
    text: long + "。二文目。",
  };
  assertEquals(
    [...knownLimitationSummary(longSentence)].length,
    KNOWN_LIMITATION_SUMMARY_MAX_CHARS,
  );
});

// ---- formatKnownLimitationYears: 年代範囲の表示ラベル ----

Deno.test("formatKnownLimitationYears は years 省略時に「全年代」を返す", () => {
  assertEquals(formatKnownLimitationYears(undefined), "全年代");
});

Deno.test("formatKnownLimitationYears は単一年（from===to）を「N年」にする", () => {
  assertEquals(
    formatKnownLimitationYears({ from: 1200, to: 1200 }),
    "1200年",
  );
});

Deno.test("formatKnownLimitationYears は範囲を「from〜to年」にする", () => {
  assertEquals(
    formatKnownLimitationYears({ from: 1530, to: 1700 }),
    "1530〜1700年",
  );
});

// ---- visibleKnownLimitationEntries: 年代該当フィルタ（#175） ----

const FILTER_FIXTURE: KnownLimitation[] = [
  { id: "early", years: { from: 1530, to: 1700 }, text: "t-a" },
  { id: "always", text: "t-b" },
  { id: "medieval", years: { from: 1000, to: 1300 }, text: "t-c" },
];

Deno.test("visibleKnownLimitationEntries は該当年の項目だけを元の順序で返す", () => {
  const result = visibleKnownLimitationEntries(FILTER_FIXTURE, 1200, false);
  assertEquals(result.map((e) => e.id), ["always", "medieval"]);
  assertEquals(result.map((e) => e.active), [true, true]);
});

Deno.test("visibleKnownLimitationEntries は years 未指定（常時該当）を全年代で返す", () => {
  for (const year of [1000, 1600, 1914]) {
    const result = visibleKnownLimitationEntries(FILTER_FIXTURE, year, false);
    assertEquals(result.some((e) => e.id === "always"), true, `${year} 年`);
  }
});

Deno.test("visibleKnownLimitationEntries は showAll=true で全件を active フラグ付きで返す", () => {
  const result = visibleKnownLimitationEntries(FILTER_FIXTURE, 1600, true);
  assertEquals(result.map((e) => e.id), ["early", "always", "medieval"]);
  assertEquals(result.map((e) => e.active), [true, true, false]);
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

// ---- knownLimitationEntries: UI 配線用（年代該当フラグ付きの一覧） ----

Deno.test("knownLimitationEntries は年代範囲内の項目に active: true を付与する", () => {
  const limitations: KnownLimitation[] = [
    { id: "a", years: { from: 1000, to: 1492 }, text: "t-a" },
  ];
  const result = knownLimitationEntries(limitations, 1200);
  assertEquals(result, [
    { id: "a", years: { from: 1000, to: 1492 }, text: "t-a", active: true },
  ]);
});

Deno.test("knownLimitationEntries は年代範囲外の項目に active: false を付与する", () => {
  const limitations: KnownLimitation[] = [
    { id: "a", years: { from: 1530, to: 1700 }, text: "t-a" },
  ];
  const result = knownLimitationEntries(limitations, 1500);
  assertEquals(result, [
    { id: "a", years: { from: 1530, to: 1700 }, text: "t-a", active: false },
  ]);
});

Deno.test("knownLimitationEntries は years 省略項目に常に active: true を付与する", () => {
  const limitations: KnownLimitation[] = [{ id: "a", text: "t-a" }];
  const result = knownLimitationEntries(limitations, 1000);
  assertEquals(result, [{ id: "a", text: "t-a", active: true }]);
});

Deno.test("knownLimitationEntries は全件を保持し元の順序を維持する", () => {
  const limitations: KnownLimitation[] = [
    { id: "a", years: { from: 1530, to: 1700 }, text: "t-a" },
    { id: "b", text: "t-b" },
    { id: "c", years: { from: 1000, to: 1100 }, text: "t-c" },
  ];
  const result = knownLimitationEntries(limitations, 1050);
  assertEquals(result.map((entry) => entry.id), ["a", "b", "c"]);
  assertEquals(result.map((entry) => entry.active), [false, true, true]);
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
