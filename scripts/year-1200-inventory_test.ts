/**
 * 年代別台帳 `docs/data-inventory/year-1200.md` と `data/`
 * の現物のドリフトを機械的に検出する回帰テスト（Issue #379 AC5）。
 *
 * ## なぜ必要か
 * 台帳は「データの性質・欠落・監査結果の正」（プロジェクト CLAUDE.md）で、他の
 * docs / Issue / ADR が根拠として指す。しかし `data/` を更新しても台帳が
 * 追随しているかを見るものが無く、#379 の時点で 1200 年の件数・面積・領邦節が
 * 広範に現物とずれていた（属領 3 件 → 実際 6 件、HRE 領邦「存在しない」→ 実際
 * 26 件など）。手作業の是正だけでは再発するので、**件数と集合**を機械的に
 * 突き合わせる。
 *
 * ## 対象を件数と集合に絞る理由
 * 面積は照合しない。台帳の「面積 km²（欧州域内）」は README.md §2.1
 * の地理的ヨーロッパ境界でクリップした値だが、そのクリップを行うスクリプトは
 * 失われていて再現できない（README.md §10・year-1200.md §2 冒頭）。raw
 * の面積だけを照合しても列の意味とずれるため、ここでは扱わない。
 *
 * ## 1200 年だけを対象にする理由
 * 他年代の `year-*.md` は §3 の節構造自体が未整備で（領邦系統の節が無い）、
 * 同じ検査を今広げると 19 年代ぶん red になる。#379 では 1200 年の是正だけを
 * 行い、他年代への拡大は後続 Issue に回す。パーサは 1200 年専用の分岐を
 * 持たないので、他年代の台帳が整い次第そのまま横展開できる。
 *
 * 突き合わせ方式（本文からパスと件数を正規表現で抜いて生成物集合と照合する）は
 * `scripts/build-borrowed-fiefs_test.ts` の借用ファイル照合（#219 AC2）に倣う。
 */
import { assert, assertEquals } from "@std/assert";
import type { FeatureCollection } from "geojson";

const YEAR = 1200;
const LEDGER_PATH = `docs/data-inventory/year-${YEAR}.md`;

/** 表の 1 行をセルに割る（前後の空セルを落とす）。表以外の行は null */
function tableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
}

/** 表の区切り行（`| --- | ---: |`）か */
function isTableSeparator(line: string): boolean {
  const cells = tableCells(line);
  // deno fmt は 1 文字幅の列を `| - |` に詰めるので 1 個のハイフンも許す
  return cells !== null && cells.every((cell) => /^:?-+:?$/.test(cell));
}

/** 見出し行（`## ` / `### `）か */
function isHeading(line: string): boolean {
  return /^#{2,3} /.test(line.trim());
}

/**
 * 見出しの正規表現に一致する節の本文（次の同レベル以上の見出しの手前まで）を返す。
 * 見出し行自身を先頭に含む。
 */
function sectionOf(lines: readonly string[], heading: RegExp): string[] {
  const start = lines.findIndex((line) => heading.test(line));
  assert(start >= 0, `台帳に ${heading} に一致する見出しが無い`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(isHeading);
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))];
}

/** 節の中の最初の表の本体行（ヘッダ行を除く）を返す */
function firstTableRows(section: readonly string[]): string[][] {
  const rows: string[][] = [];
  for (const line of section) {
    if (isTableSeparator(line)) continue;
    const cells = tableCells(line);
    if (cells === null) {
      // 表が始まったあとの非表行で 1 つ目の表は終わり
      if (rows.length > 0) break;
      continue;
    }
    rows.push(cells);
  }
  assert(rows.length >= 2, "節の中に表が見つからない");
  return rows.slice(1); // 先頭はヘッダ行
}

/** "1,234" のような桁区切りつきの数を読む */
function parseCount(text: string): number {
  const value = Number(text.replace(/,/g, ""));
  assert(Number.isInteger(value), `件数として読めない: ${text}`);
  return value;
}

/** 見出しの「— N 件」を読む */
function headingCount(heading: string): number {
  const m = /—\s*([\d,]+)\s*件/.exec(heading);
  assert(m !== null, `見出しに「— N 件」が無い: ${heading}`);
  return parseCount(m[1]);
}

async function readLedger(): Promise<string[]> {
  return (await Deno.readTextFile(LEDGER_PATH)).split("\n");
}

async function readFeatureCount(path: string): Promise<number> {
  const fc = JSON.parse(await Deno.readTextFile(path)) as FeatureCollection;
  return fc.features.length;
}

/** `europe_<year>.geojson` の NAME 集合（独立／属領／無名の内訳つき） */
async function readPowers(): Promise<{
  independent: Set<string>;
  subordinate: Set<string>;
  unnamed: number;
}> {
  const fc = JSON.parse(
    await Deno.readTextFile(`data/europe_${YEAR}.geojson`),
  ) as FeatureCollection;
  const independent = new Set<string>();
  const subordinate = new Set<string>();
  let unnamed = 0;
  for (const feature of fc.features) {
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const name = typeof props.NAME === "string" && props.NAME !== ""
      ? props.NAME
      : null;
    if (name === null) {
      unnamed += 1;
      continue;
    }
    const subjecto = typeof props.SUBJECTO === "string" && props.SUBJECTO !== ""
      ? props.SUBJECTO
      : null;
    (subjecto !== null && subjecto !== name ? subordinate : independent)
      .add(name);
  }
  return { independent, subordinate, unnamed };
}

/** §1 サマリの「項目 → 件数」 */
async function readSummary(): Promise<Map<string, number>> {
  const lines = await readLedger();
  const rows = firstTableRows(sectionOf(lines, /^## 1\. サマリ/));
  const summary = new Map<string, number>();
  for (const [label, count] of rows) {
    summary.set(label, parseCount(count));
  }
  return summary;
}

Deno.test("§1 サマリの領邦・諸侯領の件数が data/ の現物と一致する", async () => {
  const summary = await readSummary();
  // 生成物のパスを本文に書いている行だけを対象にする（項目名の表記に依存しない）
  const rows = [...summary].filter(([label]) =>
    /`data\/\S+\.geojson`/.test(label)
  );
  assert(rows.length >= 5, "§1 にファイルパスつきの行が足りない");
  for (const [label, documented] of rows) {
    const path = /`(data\/\S+\.geojson)`/.exec(label)![1];
    assertEquals(
      documented,
      await readFeatureCount(path),
      `§1「${label}」の件数が ${path} の feature 数と一致しない`,
    );
  }
});

Deno.test("§1 サマリの勢力件数が SUBJECTO の判定と §2.4 の除外件数から導ける", async () => {
  const lines = await readLedger();
  const summary = await readSummary();
  const powers = await readPowers();
  const excluded = firstTableRows(
    sectionOf(lines, /^### 2\.4 ヨーロッパ域外として除外した勢力/),
  ).length;
  assertEquals(
    summary.get("勢力（NAME あり・独立）"),
    powers.independent.size - excluded,
    "§1 の独立件数が「raw の独立 − §2.4 の除外」と一致しない",
  );
  assertEquals(
    summary.get("勢力（NAME あり・属領/従属）"),
    powers.subordinate.size,
    "§1 の属領件数が SUBJECTO ≠ NAME の勢力数と一致しない",
  );
});

Deno.test("§2.1 / §2.2 / §2.4 の見出しの件数が表の行数と一致する", async () => {
  const lines = await readLedger();
  for (const heading of [/^### 2\.1 /, /^### 2\.2 /, /^### 2\.4 /]) {
    const section = sectionOf(lines, heading);
    assertEquals(
      headingCount(section[0]),
      firstTableRows(section).length,
      `見出しの件数と表の行数が一致しない: ${section[0]}`,
    );
  }
});

Deno.test("§2.1 / §2.2 / §2.4 の勢力名の集合が data/europe_1200.geojson と一致する", async () => {
  const lines = await readLedger();
  const powers = await readPowers();
  const namesOf = (heading: RegExp) =>
    firstTableRows(sectionOf(lines, heading)).map((cells) => cells[1]);
  const documentedIndependent = [
    ...namesOf(/^### 2\.1 /),
    ...namesOf(/^### 2\.4 /),
  ].sort();
  const documentedSubordinate = namesOf(/^### 2\.2 /).sort();
  assertEquals(
    documentedIndependent,
    [...powers.independent].sort(),
    "§2.1 + §2.4 の勢力名が現物の独立勢力と一致しない",
  );
  assertEquals(
    documentedSubordinate,
    [...powers.subordinate].sort(),
    "§2.2 の勢力名が現物の属領・従属勢力と一致しない",
  );
});

Deno.test("§2.3 の無名ポリゴンは raw 件数 = 域内件数 + 域外除外件数を満たす", async () => {
  const lines = await readLedger();
  const summary = await readSummary();
  const powers = await readPowers();
  const section = sectionOf(lines, /^### 2\.3 無名ポリゴン/);
  const text = section.join("\n");
  const raw = /raw で\s*([\d,]+)\s*件/.exec(text);
  const inside = /域内は\s*\*{0,2}\s*([\d,]+)\s*件/.exec(text);
  assert(raw !== null, "§2.3 に raw の件数が書かれていない");
  assert(inside !== null, "§2.3 に域内の件数が書かれていない");
  const excluded = firstTableRows(section).length;
  assertEquals(
    parseCount(raw[1]),
    powers.unnamed,
    "§2.3 の raw 件数が NAME = null の feature 数と一致しない",
  );
  assertEquals(
    parseCount(inside[1]) + excluded,
    powers.unnamed,
    "§2.3 の「域内件数 + 域外として除外した件数」が raw 件数と一致しない",
  );
  assertEquals(
    summary.get("無名ポリゴン（NAME = null）"),
    parseCount(inside[1]),
    "§1 の無名ポリゴン件数が §2.3 の域内件数と一致しない",
  );
});

Deno.test("§3 の領邦系統の表が raw / flat の実ファイルと件数まで一致する", async () => {
  const lines = await readLedger();
  const rows = firstTableRows(sectionOf(lines, /^## 3\. 諸侯領土/));
  assert(rows.length >= 5, "§3 の系統一覧の行が足りない");
  for (const cells of rows) {
    const path = /`(data\/\S+\.geojson)`/.exec(cells[1]);
    assert(path !== null, `§3 の行にファイルパスが無い: ${cells.join(" | ")}`);
    const rawPath = path[1];
    const flatPath = rawPath.replace("_fiefs_", "_fiefs_flat_");
    assertEquals(
      parseCount(cells[2]),
      await readFeatureCount(rawPath),
      `§3 の raw 件数が ${rawPath} と一致しない`,
    );
    assertEquals(
      parseCount(cells[3]),
      await readFeatureCount(flatPath),
      `§3 の flat 件数が ${flatPath} と一致しない`,
    );
  }
});

Deno.test("§3 が参照する data/ のファイルはすべて実在する", async () => {
  const ledger = (await readLedger()).join("\n");
  const section = ledger.slice(
    ledger.indexOf("\n## 3. 諸侯領土"),
    ledger.indexOf("\n## 4. 都市"),
  );
  const paths = [...new Set(section.match(/data\/\S+?\.geojson/g) ?? [])];
  assert(paths.length >= 6, "§3 が data/ のファイルを参照していない");
  for (const path of paths) {
    assert((await Deno.stat(path)).isFile, `§3 が参照する ${path} が無い`);
  }
});

Deno.test("§4 の都市件数が §1 の内訳と data/cities.json の 1200 年と一致する", async () => {
  const lines = await readLedger();
  const summary = await readSummary();
  const heading = lines.find((line) => /^## 4\. 都市/.test(line));
  assert(heading !== undefined, "§4 の見出しが無い");
  const m = /域内\s*([\d,]+)\s*件/.exec(heading);
  assert(m !== null, `§4 の見出しに「域内 N 件」が無い: ${heading}`);
  const inside = parseCount(m[1]);
  assertEquals(
    summary.get("都市"),
    inside,
    "§1 の都市件数が §4 の見出しと違う",
  );
  const outside = summary.get("（参考）ヨーロッパ域外として除外した都市");
  assert(outside !== undefined, "§1 に域外都市の行が無い");
  const cities = JSON.parse(await Deno.readTextFile("data/cities.json")) as {
    years: Record<string, unknown[]>;
  };
  assertEquals(
    inside + outside,
    cities.years[String(YEAR)].length,
    "「§4 の域内 + §1 の域外」が data/cities.json の 1200 年の件数と一致しない",
  );
});
