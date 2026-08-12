/**
 * power_descriptions.ts のユニットテスト（Issue #283）。
 *
 * 検証する契約:
 * - `data/power-descriptions.json` の形（descriptions 配列）を寛容にパースし、
 *   壊れたエントリだけを落として残りは使えること
 * - 年代 × 補正後の内部名（英語 NAME）で一文要約を引けること
 * - 未登録・別年代・名称欠落では null へ安全にフォールバックすること
 *   （AC8: 空欄・誤った年代の文・不要な区切り線を出さないための土台）
 */
import { assertEquals } from "@std/assert";
import { captureWarns } from "./ui/fake_dom.ts";
import {
  EMPTY_POWER_DESCRIPTIONS,
  parsePowerDescriptions,
  POWER_DESCRIPTIONS_DATA_URL,
  powerDescriptionFor,
} from "./power_descriptions.ts";

/** 2 勢力 × 3 年代の最小データ（年代で文が切り替わることを見るため) */
const SAMPLE = {
  descriptions: [
    {
      name: "Poland-Lithuania",
      years: [1500, 1600],
      text: "ポーランド・リトアニアが東欧最大級の版図を治めていた時代です。",
    },
    {
      name: "Poland-Lithuania",
      years: [1400],
      text: "ポーランドとリトアニアが同君連合として結びついた時代です。",
    },
    { name: "France", years: [1600], text: "フランス王国の時代です。" },
  ],
};

Deno.test("POWER_DESCRIPTIONS_DATA_URL は /data/ 配下の固定パス", () => {
  assertEquals(POWER_DESCRIPTIONS_DATA_URL, "/data/power-descriptions.json");
});

Deno.test("parsePowerDescriptions は name × year で引ける表を作る", () => {
  const table = parsePowerDescriptions(SAMPLE);
  assertEquals(
    powerDescriptionFor(table, 1500, "Poland-Lithuania"),
    "ポーランド・リトアニアが東欧最大級の版図を治めていた時代です。",
  );
  assertEquals(
    powerDescriptionFor(table, 1600, "Poland-Lithuania"),
    "ポーランド・リトアニアが東欧最大級の版図を治めていた時代です。",
  );
  assertEquals(
    powerDescriptionFor(table, 1400, "Poland-Lithuania"),
    "ポーランドとリトアニアが同君連合として結びついた時代です。",
  );
});

Deno.test("powerDescriptionFor は登録の無い年代で null を返す（別年代の文を出さない）", () => {
  const table = parsePowerDescriptions(SAMPLE);
  assertEquals(powerDescriptionFor(table, 1700, "Poland-Lithuania"), null);
  assertEquals(powerDescriptionFor(table, 1000, "France"), null);
});

Deno.test("powerDescriptionFor は未登録の勢力で null を返す", () => {
  const table = parsePowerDescriptions(SAMPLE);
  assertEquals(powerDescriptionFor(table, 1600, "Fivizzano"), null);
});

Deno.test("powerDescriptionFor は名称が null・空文字なら null を返す", () => {
  const table = parsePowerDescriptions(SAMPLE);
  assertEquals(powerDescriptionFor(table, 1600, null), null);
  assertEquals(powerDescriptionFor(table, 1600, ""), null);
});

Deno.test("powerDescriptionFor は空の表で常に null を返す", () => {
  assertEquals(
    powerDescriptionFor(EMPTY_POWER_DESCRIPTIONS, 1600, "France"),
    null,
  );
});

Deno.test("powerDescriptionFor は renames で内部名を正規化してから引く", () => {
  // 表示名（日本語）ではなく補正後の内部名がキー。生値の綴りゆれ（Castille）は
  // displayLabel / build-colors と同じ renames で正規化してから照合する
  const table = parsePowerDescriptions({
    descriptions: [
      { name: "Castile", years: [1492], text: "カスティーリャの時代です。" },
    ],
  });
  assertEquals(
    powerDescriptionFor(table, 1492, "Castille", { Castille: "Castile" }),
    "カスティーリャの時代です。",
  );
  // renames を渡さなければ生値のまま照合し、一致しなければ null
  assertEquals(powerDescriptionFor(table, 1492, "Castille"), null);
});

Deno.test("parsePowerDescriptions は不正なトップレベルで空の表 + warn", () => {
  for (const raw of [null, undefined, 42, "x", [], { descriptions: {} }]) {
    const { value, warns } = captureWarns(() => parsePowerDescriptions(raw));
    assertEquals(value.size, 0);
    assertEquals(warns, [
      "power-descriptions.json の形式が不正です（descriptions が配列ではありません）。勢力説明なしで継続します。",
    ]);
  }
});

Deno.test("parsePowerDescriptions は壊れたエントリだけを除外して残りを使う", () => {
  const { value: table, warns } = captureWarns(() =>
    parsePowerDescriptions({
      descriptions: [
        { name: "", years: [1600], text: "名称が空" },
        { name: "France", years: [], text: "年代が空" },
        { name: "France", years: [1600], text: "" },
        { name: "France", years: ["1600"], text: "年代が文字列" },
        { name: "France", years: [1600.5], text: "年代が非整数" },
        null,
        "France",
        { name: "France", years: [1600], text: "フランスの時代です。" },
      ],
    })
  );
  assertEquals(
    powerDescriptionFor(table, 1600, "France"),
    "フランスの時代です。",
  );
  assertEquals(table.size, 1);
  assertEquals(warns.length, 7);
  assertEquals(
    warns[0],
    "power-descriptions.json の descriptions[0] が不正な形式のため除外しました。",
  );
});

Deno.test("parsePowerDescriptions は同一 name × year の重複を先勝ちで解決し warn する", () => {
  const { value: table, warns } = captureWarns(() =>
    parsePowerDescriptions({
      descriptions: [
        { name: "France", years: [1600], text: "先に登録した文です。" },
        { name: "France", years: [1600], text: "後から来た文です。" },
      ],
    })
  );
  assertEquals(
    powerDescriptionFor(table, 1600, "France"),
    "先に登録した文です。",
  );
  assertEquals(warns, [
    "power-descriptions.json に France × 1600 の説明が重複しています。先に現れた方を使います。",
  ]);
});
