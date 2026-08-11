import { assert, assertEquals, assertThrows } from "@std/assert";
import type { Feature, FeatureCollection } from "geojson";
import {
  BORROWED_FEATURES,
  type BorrowedFeatureSpec,
  borrowedPathFor,
  borrowFeature,
  buildBorrowedCollection,
} from "./build-borrowed-fiefs.ts";
import {
  attributionForDataFile,
  DATA_ATTRIBUTIONS,
} from "./build-attribution.ts";
import { borrowedFlatPathFor } from "./build-fief-flat.ts";
import {
  BORROWED_HRE_OVERLAY_YEARS,
  BORROWED_ITALY_FIEF_OVERLAY_YEARS,
  SNAPSHOT_YEARS,
} from "../src/config.ts";
import knownLimitations from "../data/known-limitations.json" with {
  type: "json",
};

/** テスト用の最小 FeatureCollection */
function fcOf(...features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

const SQUARE: Feature = {
  type: "Feature",
  properties: { NAME: "Archduchy of Austria", SUBJECTO: "Holy Roman Empire" },
  geometry: {
    type: "Polygon",
    coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
  },
};

const SPEC: BorrowedFeatureSpec = {
  year: 1492,
  lineage: "hre",
  name: "Archduchy of Austria",
  from: {
    year: 1500,
    file: "data/hre_1500.geojson",
    sourceRef: "Roller territories_manual: id=Österreich",
  },
  reason: "テスト用",
};

/** data/<name> を読む */
async function readCollection(path: string): Promise<FeatureCollection> {
  return JSON.parse(await Deno.readTextFile(path)) as FeatureCollection;
}

/** 点がポリゴン/マルチポリゴンの内側か（テスト専用の素朴な判定） */
function containsPoint(
  geometry: Feature["geometry"],
  point: readonly [number, number],
): boolean {
  const parts = geometry.type === "Polygon"
    ? [geometry.coordinates]
    : geometry.type === "MultiPolygon"
    ? geometry.coordinates
    : [];
  let inside = false;
  for (const part of parts) {
    let hit = false;
    for (const [ringIndex, ring] of part.entries()) {
      let crossings = false;
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        if (
          (y1 > point[1]) !== (y2 > point[1]) &&
          point[0] < (x2 - x1) * (point[1] - y1) / (y2 - y1) + x1
        ) {
          crossings = !crossings;
        }
      }
      if (ringIndex === 0) hit = crossings;
      else if (crossings) hit = false;
    }
    if (hit) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// 純粋関数（借用は「座標を 1 頂点も変えない複製」であること）
// ---------------------------------------------------------------------------

Deno.test("borrowFeature は借用元のジオメトリをそのまま複製する（ADR-0033 条件 2）", () => {
  const borrowed = borrowFeature(fcOf(SQUARE), SPEC);
  assertEquals(borrowed.geometry, SQUARE.geometry);
  // properties は借用元をそのまま引き継ぐ（色キー・ラベルが既存年と一致する）
  assertEquals(borrowed.properties?.NAME, "Archduchy of Austria");
  assertEquals(borrowed.properties?.SUBJECTO, "Holy Roman Empire");
});

Deno.test("borrowFeature は借用の事実を feature に記録する（ADR-0033 追跡可能性）", () => {
  const borrowed = borrowFeature(fcOf(SQUARE), SPEC);
  assertEquals(borrowed.properties?.BORROWED_FROM, {
    year: 1500,
    file: "data/hre_1500.geojson",
    sourceRef: "Roller territories_manual: id=Österreich",
  });
});

Deno.test("borrowFeature は入力を破壊しない", () => {
  const source = fcOf(SQUARE);
  const before = JSON.stringify(source);
  borrowFeature(source, SPEC);
  assertEquals(JSON.stringify(source), before);
});

Deno.test("borrowFeature は借用元に対象 NAME が無ければ失敗する", () => {
  assertThrows(
    () => borrowFeature(fcOf(), SPEC),
    Error,
    "Archduchy of Austria",
  );
});

Deno.test("buildBorrowedCollection は借用元をファイル単位の metadata にも記録する", () => {
  const { fc } = buildBorrowedCollection(
    [SPEC],
    new Map([[
      "data/hre_1500.geojson",
      fcOf(SQUARE),
    ]]),
  );
  assertEquals(fc.features.length, 1);
  assertEquals((fc as unknown as { metadata: unknown }).metadata, {
    borrowedFrom: [{
      name: "Archduchy of Austria",
      year: 1500,
      file: "data/hre_1500.geojson",
      sourceRef: "Roller territories_manual: id=Österreich",
      reason: "テスト用",
    }],
  });
});

Deno.test("borrowedPathFor は系統ごとに別ファイルを指す（ライセンス混在を作らない）", () => {
  assertEquals(borrowedPathFor("hre", 1492), "data/borrowed_hre_1492.geojson");
  assertEquals(
    borrowedPathFor("italy", 1492),
    "data/borrowed_italy_1492.geojson",
  );
});

// ---------------------------------------------------------------------------
// 許可リスト（#202: 1492 年のオーストリア大公領・ミラノ公国）
// ---------------------------------------------------------------------------

Deno.test("許可リストは 1492 年の 2 件（#202）と 1715 年のザクセン選帝侯領（#209）", () => {
  assertEquals(
    BORROWED_FEATURES.map((spec) => [spec.year, spec.lineage, spec.name]),
    [
      [1492, "hre", "Archduchy of Austria"],
      [1492, "italy", "Duchy of Milan"],
      [1715, "hre", "Electorate of Saxony"],
    ],
  );
  for (const spec of BORROWED_FEATURES) {
    // ADR-0033 条件 4: 隣接するスナップショット年からの借用に限る。年差の絶対値
    // ではなく SNAPSHOT_YEARS 上の隣接（1 区間以内）で判定する（本プロジェクトの
    // 年代刻みは不均等で、1700↔1715 は 15 年差でも隣接年）。
    const target = SNAPSHOT_YEARS.indexOf(spec.year);
    const from = SNAPSHOT_YEARS.indexOf(spec.from.year);
    assert(
      target >= 0 && from >= 0,
      `${spec.name} の年がスナップショット年でない`,
    );
    assert(
      Math.abs(target - from) === 1,
      `${spec.name} の借用元が隣接スナップショット年ではない`,
    );
    // ADR-0033 条件 3: 史実の根拠を必ず持つ
    assert(spec.reason.length > 0, `${spec.name} に借用の根拠が無い`);
  }
});

// ---------------------------------------------------------------------------
// 生成物（AC1 / AC2 / AC3 / AC5）
// ---------------------------------------------------------------------------

Deno.test("借用ファイルの座標は借用元と 1 頂点も違わない（ADR-0033 条件 2）", async () => {
  for (const spec of BORROWED_FEATURES) {
    const source = await readCollection(spec.from.file);
    const target = await readCollection(
      borrowedPathFor(spec.lineage, spec.year),
    );
    const original = source.features.find((f) =>
      f.properties?.NAME === spec.name
    );
    const copied = target.features.find((f) =>
      f.properties?.NAME === spec.name
    );
    assert(original !== undefined, `${spec.from.file} に ${spec.name} が無い`);
    assert(copied !== undefined, `借用ファイルに ${spec.name} が無い`);
    assertEquals(
      JSON.stringify(copied.geometry),
      JSON.stringify(original.geometry),
      `${spec.name} のジオメトリが借用元と一致しない`,
    );
  }
});

Deno.test("借用ファイルは借用元（年・ファイル・ソース識別子）を metadata に記録する（AC3 / AC5）", async () => {
  for (const spec of BORROWED_FEATURES) {
    const path = borrowedPathFor(spec.lineage, spec.year);
    const target = await readCollection(path) as unknown as {
      metadata?: { borrowedFrom?: unknown };
      features: Feature[];
    };
    const entries = target.metadata?.borrowedFrom;
    assert(Array.isArray(entries), `${path} の metadata.borrowedFrom が無い`);
    const entry = entries.find((e) =>
      (e as { name?: string }).name === spec.name
    );
    assertEquals(entry, {
      name: spec.name,
      year: spec.from.year,
      file: spec.from.file,
      sourceRef: spec.from.sourceRef,
      reason: spec.reason,
    });
    const feature = target.features.find((f) =>
      f.properties?.NAME === spec.name
    );
    assertEquals(feature?.properties?.BORROWED_FROM, {
      year: spec.from.year,
      file: spec.from.file,
      sourceRef: spec.from.sourceRef,
    });
  }
});

Deno.test("借用ファイルの出典・ライセンスは借用元の系統と一致する（AC4 の出典表示）", async () => {
  const expected = {
    hre: DATA_ATTRIBUTIONS.ethHreTerritories,
    italy: DATA_ATTRIBUTIONS.openHistoricalMap,
  } as const;
  for (const spec of BORROWED_FEATURES) {
    const name = borrowedPathFor(spec.lineage, spec.year).slice("data/".length);
    assertEquals(attributionForDataFile(name), expected[spec.lineage]);
    const metadata = (await readCollection(`data/${name}`) as unknown as {
      metadata: Record<string, unknown>;
    }).metadata;
    assertEquals(metadata.source, expected[spec.lineage].source);
    assertEquals(metadata.license, expected[spec.lineage].license);
    assertEquals(metadata.sourceUrl, expected[spec.lineage].sourceUrl);
  }
});

Deno.test("1492 年のウィーンはオーストリア大公領に含まれる（AC1）", async () => {
  const fc = await readCollection("data/borrowed_hre_1492.geojson");
  const austria = fc.features.find((f) =>
    f.properties?.NAME === "Archduchy of Austria"
  );
  assert(austria !== undefined);
  assert(
    containsPoint(austria.geometry, [16.37, 48.21]),
    "ウィーンが大公領に含まれない",
  );
});

Deno.test("1492 年のミラノはミラノ公国に含まれる（AC2）", async () => {
  const fc = await readCollection("data/borrowed_italy_1492.geojson");
  const milan = fc.features.find((f) =>
    f.properties?.NAME === "Duchy of Milan"
  );
  assert(milan !== undefined);
  assert(
    containsPoint(milan.geometry, [9.19, 45.46]),
    "ミラノがミラノ公国に含まれない",
  );
});

Deno.test("1715 年のドレスデン・ライプツィヒ・ヴィッテンベルクはザクセン選帝侯領に含まれる（#209 AC1）", async () => {
  const fc = await readCollection("data/borrowed_hre_1715.geojson");
  const saxony = fc.features.find((f) =>
    f.properties?.NAME === "Electorate of Saxony"
  );
  assert(
    saxony !== undefined,
    "borrowed_hre_1715 に Electorate of Saxony が無い",
  );
  for (
    const [label, point] of [
      ["ドレスデン", [13.74, 51.05]],
      ["ライプツィヒ", [12.37, 51.34]],
      ["ヴィッテンベルク", [12.65, 51.87]],
    ] as const
  ) {
    assert(
      containsPoint(saxony.geometry, point as readonly [number, number]),
      `${label} がザクセン選帝侯領に含まれない`,
    );
  }
});

Deno.test("表示側の年集合（src/config.ts）と許可リストが一致する（#202）", () => {
  const yearsOf = (lineage: BorrowedFeatureSpec["lineage"]) =>
    [
      ...new Set(
        BORROWED_FEATURES.filter((spec) => spec.lineage === lineage).map((
          spec,
        ) => spec.year),
      ),
    ].sort((a, b) => a - b);
  assertEquals([...BORROWED_HRE_OVERLAY_YEARS], yearsOf("hre"));
  assertEquals([...BORROWED_ITALY_FIEF_OVERLAY_YEARS], yearsOf("italy"));
  // 借用先は必ずスナップショット年（借用元も同様）
  for (const spec of BORROWED_FEATURES) {
    assert(SNAPSHOT_YEARS.includes(spec.year));
    assert(SNAPSHOT_YEARS.includes(spec.from.year));
  }
});

// ---------------------------------------------------------------------------
// 台帳（docs/data-inventory/README.md）との整合（#219 AC1 / AC2）
// ---------------------------------------------------------------------------
//
// docs/data-inventory/README.md の出典表はファイル単位のライセンス登録簿として
// 唯一のもの（CLAUDE.md はデータの性質・出典の正を docs/data-inventory/ と
// 定める）。#209 で borrowed_hre_1715 が生成されながら台帳の借用行だけが
// 更新されず、CC BY-NC-SA 4.0 の借用資産を過小に記載する状態になっていた。
// 将来 BORROWED_FEATURES に借用を追加したとき台帳の更新漏れが red になるよう、
// 許可リストから導出した借用ファイル集合（raw + flat。ADR-0035）と台帳の
// 記載を機械的に突き合わせる。

/** 台帳から借用ファイルの具体パスを抜き出す（テンプレート表記 <系統> は除外） */
function documentedBorrowedPaths(readme: string): string[] {
  return readme.match(/data\/borrowed_[a-z]+(?:_flat)?_\d+\.geojson/g) ?? [];
}

Deno.test("台帳の借用ファイル記載は BORROWED_FEATURES から導出した集合（raw + flat）と一致する（#219 AC2）", async () => {
  const readme = await Deno.readTextFile("docs/data-inventory/README.md");
  const documented = [...new Set(documentedBorrowedPaths(readme))].sort();
  const expected = new Set<string>();
  for (const spec of BORROWED_FEATURES) {
    // 借用元の複製（座標無改変の中間生成物。ADR-0033 条件 2 / ADR-0035）
    expected.add(borrowedPathFor(spec.lineage, spec.year));
    // 配信・描画される flat 派生（#215 / ADR-0035）
    expected.add(borrowedFlatPathFor(spec.lineage, spec.year));
  }
  assertEquals(
    documented,
    [...expected].sort(),
    "docs/data-inventory/README.md の借用ファイル記載が生成物の集合と一致しない",
  );
});

Deno.test("台帳の借用行はカバー年代とライセンスを正しく示す（#219 AC1）", async () => {
  const readme = await Deno.readTextFile("docs/data-inventory/README.md");
  const rows = readme
    .split("\n")
    .filter((line) => documentedBorrowedPaths(line).length > 0);
  assert(rows.length > 0, "台帳に借用ファイルの行が無い");
  const years = [...new Set(BORROWED_FEATURES.map((spec) => spec.year))];
  for (const row of rows) {
    // カバー年代: 借用の全対象年（1492 / 1715）が読めること
    for (const year of years) {
      assert(
        row.includes(String(year)),
        `借用行がカバー年代 ${year} を示していない: ${row.slice(0, 60)}…`,
      );
    }
    // ライセンス: hre 系は Roller（CC BY-NC-SA 4.0）、italy 系は OHM（CC0）を
    // 引き継ぐことがファイルと同じ行で読めること
    if (row.includes("data/borrowed_hre_")) {
      assert(
        row.includes(DATA_ATTRIBUTIONS.ethHreTerritories.license),
        `hre 系の借用行に Roller のライセンスが無い: ${row.slice(0, 60)}…`,
      );
    }
    if (row.includes("data/borrowed_italy_")) {
      assert(
        row.includes("CC0"),
        `italy 系の借用行に OHM のライセンスが無い: ${row.slice(0, 60)}…`,
      );
    }
  }
});

Deno.test("借用は data/known-limitations.json で年代連動に開示される（AC5 / ADR-0033）", () => {
  const entry = knownLimitations.limitations.find((limitation) =>
    limitation.id === "borrowed-geometry-1492"
  ) as { years?: { from: number; to: number }; text: string } | undefined;
  assert(entry !== undefined, "borrowed-geometry-1492 が無い");
  assertEquals(entry.years, { from: 1492, to: 1492 });
  // 借用元の年・政体・出典・ライセンスが読めること
  for (
    const keyword of [
      "1500",
      "オーストリア大公領",
      "ミラノ公国",
      "CC BY-NC-SA 4.0",
      "CC0",
      "近似",
    ]
  ) {
    assert(entry.text.includes(keyword), `text が ${keyword} に言及していない`);
  }
});

Deno.test("1715 年の借用も known-limitations で年代連動に開示される（#209 AC3 / ADR-0033）", () => {
  const entry = knownLimitations.limitations.find((limitation) =>
    limitation.id === "borrowed-geometry-1715"
  ) as { years?: { from: number; to: number }; text: string } | undefined;
  assert(entry !== undefined, "borrowed-geometry-1715 が無い");
  assertEquals(entry.years, { from: 1715, to: 1715 });
  for (
    const keyword of [
      "1700",
      "ザクセン選帝侯領",
      "CC BY-NC-SA 4.0",
      "近似",
    ]
  ) {
    assert(entry.text.includes(keyword), `text が ${keyword} に言及していない`);
  }
});

Deno.test("1715〜1800 年の既知の制限はザクセンを「借用で解消」へ更新している（#209 AC4）", () => {
  const entry = knownLimitations.limitations.find((limitation) =>
    limitation.id === "hre-fiefs-1715-1800-missing-territories"
  ) as { text: string } | undefined;
  assert(entry !== undefined, "hre-fiefs-1715-1800-missing-territories が無い");
  // 「1715 年に表示されず」という記述は解消済み（借用で表示される）
  assert(
    !entry.text.includes("1715年に表示されず"),
    "ザクセンが 1715 年に表示されない旨の記述が残っている",
  );
  assert(
    entry.text.includes("1700年"),
    "ザクセンの借用元（1700 年）に言及していない",
  );
  // 他の欠落（トリーア・ヴュルテンベルク等）はエントリに残す
  for (const keyword of ["トリーア選帝侯領", "ヴュルテンベルク公国"]) {
    assert(entry.text.includes(keyword), `${keyword} の記述が失われている`);
  }
});

Deno.test("借用 feature の色キー・日本語表記は既存年と同一キーを再利用する（AC4）", async () => {
  const colors = JSON.parse(
    await Deno.readTextFile("data/colors.json"),
  ) as Record<string, string>;
  const nameJa = JSON.parse(
    await Deno.readTextFile("data/name-ja.json"),
  ) as Record<string, string>;
  for (const spec of BORROWED_FEATURES) {
    const fc = await readCollection(borrowedPathFor(spec.lineage, spec.year));
    const feature = fc.features.find((f) => f.properties?.NAME === spec.name);
    assert(feature !== undefined);
    const subjecto = feature.properties?.SUBJECTO;
    const key = typeof subjecto === "string" && subjecto !== spec.name
      ? `${spec.name}|${subjecto}`
      : spec.name;
    assert(colors[key] !== undefined, `colors.json に ${key} が無い`);
    assert(
      nameJa[spec.name] !== undefined,
      `name-ja.json に ${spec.name} が無い`,
    );
  }
});
