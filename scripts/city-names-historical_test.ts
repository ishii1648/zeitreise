/**
 * data/city-names-historical.json（時代別都市名の手動キュレーション。#223）の
 * 検証テスト。
 *
 * データは「その年代の支配勢力の呼称が英語慣用名と大きく異なり、地図の理解に
 * 効く」都市だけを年区間付きで収録する（探索源は Wikidata / Buringh の別名列。
 * 採用理由と出典は各エントリの source に記録する。ADR-0023 の「上流の語彙に
 * 対するオーバーライドは出典付きで持つ」流儀）。表示側は src/cities.ts の
 * cityDisplayName(name, ja, year) が区間該当年のみ歴史名を優先する。
 *
 * .json 拡張子は `with { type: "json" }` の静的 import でモジュール解決として
 * 読めるため、CI の `deno test`（--allow-read は data/ のみ）でも検証できる
 * （scripts/name-ja_test.ts と同じ方式）。
 */

import { assert, assertEquals } from "@std/assert";
import historicalNames from "../data/city-names-historical.json" with {
  type: "json",
};
import citiesJson from "../data/cities.json" with { type: "json" };
import { SNAPSHOT_YEARS } from "../src/config.ts";

interface HistoricalEntry {
  from: number;
  to: number;
  name: string;
  ja: string;
  source: string;
}

/** 検証対象を型不定のまま列挙する（形の検証自体がテストのため cast で読む） */
const table = historicalNames as Record<string, unknown>;

/** 形の検証を通ったエントリを [都市名, エントリ] で列挙する */
function entries(): [string, HistoricalEntry][] {
  const out: [string, HistoricalEntry][] = [];
  for (const [cityName, value] of Object.entries(table)) {
    for (const entry of value as HistoricalEntry[]) {
      out.push([cityName, entry]);
    }
  }
  return out;
}

Deno.test("city-names-historical.json は都市名 → エントリ配列で、各エントリは from/to/name/ja/source を持つ（#223 AC4）", () => {
  assert(typeof table === "object" && table !== null && !Array.isArray(table));
  const keys = Object.keys(table);
  assert(keys.length > 0, "エントリが 1 件も無い");
  for (const [cityName, value] of Object.entries(table)) {
    assert(Array.isArray(value), `${cityName}: 値が配列でない`);
    assert(value.length > 0, `${cityName}: 空配列（キーごと削除すべき）`);
    for (const entry of value as Record<string, unknown>[]) {
      assert(
        typeof entry === "object" && entry !== null,
        `${cityName}: エントリがオブジェクトでない`,
      );
      assert(
        Number.isInteger(entry.from),
        `${cityName}: from が整数でない: ${entry.from}`,
      );
      assert(
        Number.isInteger(entry.to),
        `${cityName}: to が整数でない: ${entry.to}`,
      );
      for (const field of ["name", "ja", "source"] as const) {
        assert(
          typeof entry[field] === "string" && entry[field] !== "",
          `${cityName}: ${field} が非空文字列でない（出典欠落等）`,
        );
      }
      assertEquals(
        Object.keys(entry).sort(),
        ["from", "ja", "name", "source", "to"],
        `${cityName}: 未知のフィールドがある`,
      );
    }
  }
});

Deno.test("全エントリで from <= to（年の逆転を検知する。#223 AC4）", () => {
  const offenders = entries()
    .filter(([, e]) => e.from > e.to)
    .map(([cityName, e]) => `${cityName}: ${e.from} > ${e.to}`);
  assertEquals(offenders, []);
});

Deno.test("同一都市の区間は重複しない（#223 AC4）", () => {
  const offenders: string[] = [];
  for (const [cityName, value] of Object.entries(table)) {
    const sorted = [...(value as HistoricalEntry[])].sort(
      (a, b) => a.from - b.from,
    );
    for (let i = 1; i < sorted.length; i++) {
      // 区間は両端含みなので、前の区間の to と次の区間の from が同年でも重複
      if (sorted[i].from <= sorted[i - 1].to) {
        offenders.push(
          `${cityName}: [${sorted[i - 1].from}, ${sorted[i - 1].to}] と ` +
            `[${sorted[i].from}, ${sorted[i].to}] が重複`,
        );
      }
    }
  }
  assertEquals(offenders, []);
});

Deno.test("対象都市は全て data/cities.json に実在する（#223 AC4）", () => {
  const cities = citiesJson as { cities: { name: string }[] };
  const cityNames = new Set(cities.cities.map((c) => c.name));
  const missing = Object.keys(table).filter((name) => !cityNames.has(name));
  assertEquals(
    missing,
    [],
    `data/cities.json に存在しない都市: ${missing.join(", ")}`,
  );
});

Deno.test("ja 表記は name-ja 規約に整合する（片仮名 + 長音・中黒・全角括弧のみ、NFC 正規化済み）", () => {
  // data/name-ja.json の都市値と同じ表記体系（例: クルジュ＝ナポカ、
  // フェオドシア（カッファ））に合わせる。ASCII・ひらがな・半角記号の混入と
  // 結合文字（NFC 非正規形）を検知する。
  const allowed = /^[ァ-ヴー・＝（）]+$/u;
  const offenders = entries()
    .filter(([, e]) => !allowed.test(e.ja) || e.ja.normalize("NFC") !== e.ja)
    .map(([cityName, e]) => `${cityName}: ${e.ja}`);
  assertEquals(offenders, []);
});

Deno.test("各エントリの区間は、その都市が表示されるスナップショット年を少なくとも 1 つ含む（表示に効かない死にエントリの検知）", () => {
  const data = citiesJson as unknown as {
    cities: { name: string }[];
    years: Record<string, [number, ...unknown[]][]>;
  };
  const indexByName = new Map(data.cities.map((c, i) => [c.name, i]));
  const offenders: string[] = [];
  for (const [cityName, value] of Object.entries(table)) {
    const index = indexByName.get(cityName);
    if (index === undefined) continue; // 実在検証は別テストが担う
    const presentYears = SNAPSHOT_YEARS.filter((year) =>
      (data.years[String(year)] ?? []).some((cell) => cell[0] === index)
    );
    for (const entry of value as HistoricalEntry[]) {
      const covered = presentYears.some(
        (year) => year >= entry.from && year <= entry.to,
      );
      if (!covered) {
        offenders.push(
          `${cityName} [${entry.from}, ${entry.to}]（表示年: ${
            presentYears.join(", ")
          }）`,
        );
      }
    }
  }
  assertEquals(offenders, []);
});

Deno.test("ベオグラードのハンガリー領期（1427–1521）がナーンドルフェヘールヴァール表記で収録されている（#223 AC1 の基準データ）", () => {
  const belgrade = table["Belgrade"] as HistoricalEntry[];
  assert(Array.isArray(belgrade), "Belgrade のエントリが無い");
  const entry = belgrade.find((e) => e.from === 1427 && e.to === 1521);
  assert(entry !== undefined, "1427–1521 の区間が無い");
  assertEquals(entry.name, "Nándorfehérvár");
  assertEquals(entry.ja, "ナーンドルフェヘールヴァール");
  assert(entry.source.length > 0);
});
