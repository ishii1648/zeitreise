import { assert, assertEquals, assertThrows } from "@std/assert";
import type { Feature, FeatureCollection } from "geojson";
import citiesJson from "../data/cities.json" with { type: "json" };
import ledgerJson from "../data/hre-major-polities.json" with { type: "json" };
import limitationsJson from "../data/known-limitations.json" with {
  type: "json",
};
import {
  approximateBorrowedColor,
  borrowedBoundaryDescription,
  boundaryMarkerTooltip,
  cityCenters,
  HRE_MAJOR_POLITY_LEDGER,
  parseHreMajorPolityLedger,
  resolveHreMajorPolities,
} from "./hre_major_polities.ts";
import type { CitiesData } from "./cities.ts";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

function fc(...features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

function polygon(name: string, borrowed = false): Feature {
  return {
    type: "Feature",
    properties: {
      NAME: name,
      ...(borrowed
        ? { BORROWED_FROM: { year: 1500, file: "x", sourceRef: "y" } }
        : {}),
    },
    geometry: {
      type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
    },
  };
}

Deno.test("HRE主要領邦台帳は schema、ID×年、中心都市参照を検証できる", () => {
  const requiredCities = new Set(
    ledgerJson.entries.map((entry) => entry.centerCity),
  );
  const centers = cityCenters(citiesJson as CitiesData, requiredCities);
  const parsed = parseHreMajorPolityLedger(
    ledgerJson,
    new Set(centers.keys()),
  );
  assertEquals(parsed.schemaVersion, 1);
  assertEquals(parsed.entries.length, 37);
  assertEquals(
    [...new Set(parsed.entries.map((entry) => entry.year))],
    [1000, 1100, 1200, 1279, 1300, 1400, 1492, 1715, 1783],
  );
  const limitationIds = new Set(
    limitationsJson.limitations.map((limitation) => limitation.id),
  );
  for (const entry of parsed.entries) {
    assert(
      limitationIds.has(entry.limitationId),
      `${entry.id}@${entry.year}: 未知の既知制限 ${entry.limitationId}`,
    );
  }
});

Deno.test("HRE主要領邦台帳は重複ID、未知の中心都市、未知の表現語彙を拒否する", () => {
  const base = structuredClone(ledgerJson) as typeof ledgerJson;
  base.entries.push(structuredClone(base.entries[0]));
  assertThrows(() => parseHreMajorPolityLedger(base), Error, "重複");

  const unknownCity = structuredClone(ledgerJson) as typeof ledgerJson;
  unknownCity.entries[0].centerCity = "Atlantis";
  assertThrows(
    () => parseHreMajorPolityLedger(unknownCity, new Set(["Prague"])),
    Error,
    "cities.json",
  );

  const unknownRepresentation = structuredClone(ledgerJson) as unknown as {
    entries: Array<Record<string, unknown>>;
  } & Record<string, unknown>;
  unknownRepresentation.entries[0].expectedRepresentation = "nearest-year";
  assertThrows(
    () => parseHreMajorPolityLedger(unknownRepresentation),
    Error,
    "expectedRepresentation",
  );
});

Deno.test("解決順は exact polygon > borrowed polygon > marker で常に1状態", () => {
  const entry = HRE_MAJOR_POLITY_LEDGER.entries.find((e) => e.year === 1000)!;
  const ledger = { schemaVersion: 1 as const, entries: [entry] };
  const borrowed = polygon(entry.aliases[0], true);
  const exact = polygon(entry.aliases[0]);
  const cities = citiesJson as CitiesData;

  let resolved = resolveHreMajorPolities(ledger, 1000, [fc(borrowed)], cities);
  assertEquals(resolved.map((r) => r.representation), ["borrowed-polygon"]);
  assertEquals(resolved[0].marker, null);

  resolved = resolveHreMajorPolities(
    ledger,
    1000,
    [fc(borrowed), fc(exact)],
    cities,
  );
  assertEquals(resolved.map((r) => r.representation), ["exact-polygon"]);
  assertEquals(resolved[0].feature, exact);
  assertEquals(resolved[0].marker, null);

  resolved = resolveHreMajorPolities(ledger, 1000, [EMPTY], cities);
  assertEquals(resolved.map((r) => r.representation), [
    "boundary-unavailable-marker",
  ]);
  assert(resolved[0].marker !== null);
});

Deno.test("同じ表現段階に一致する面が重複したら解決を拒否する", () => {
  const entry = HRE_MAJOR_POLITY_LEDGER.entries.find((e) => e.year === 1000)!;
  const ledger = { schemaVersion: 1 as const, entries: [entry] };
  const cities = citiesJson as CitiesData;
  assertThrows(
    () =>
      resolveHreMajorPolities(
        ledger,
        1000,
        [fc(polygon(entry.aliases[0])), fc(polygon(entry.aliases[0]))],
        cities,
      ),
    Error,
    "同年面が 2 件重複",
  );
  assertThrows(
    () =>
      resolveHreMajorPolities(
        ledger,
        1000,
        [
          fc(polygon(entry.aliases[0], true)),
          fc(polygon(entry.aliases[0], true)),
        ],
        cities,
      ),
    Error,
    "借用面が 2 件重複",
  );
});

const POLITICAL_PATHS = (year: number): string[] => [
  `data/europe_${year}.geojson`,
  `data/hre_${year}.geojson`,
  `data/hre_fiefs_flat_${year}.geojson`,
  `data/france_fiefs_flat_${year}.geojson`,
  `data/italy_fiefs_flat_${year}.geojson`,
  `data/cliopatria_fiefs_flat_${year}.geojson`,
  `data/britain_fiefs_flat_${year}.geojson`,
  `data/sovereign_fiefs_flat_${year}.geojson`,
  `data/borrowed_hre_flat_${year}.geojson`,
  `data/borrowed_italy_flat_${year}.geojson`,
];

async function collectionsFor(year: number): Promise<FeatureCollection[]> {
  const collections: FeatureCollection[] = [];
  for (const path of POLITICAL_PATHS(year)) {
    try {
      collections.push(JSON.parse(await Deno.readTextFile(path)));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return collections;
}

Deno.test("全台帳エントリが実データで期待する3段階表現のちょうど1つに解決される", async () => {
  const cities = citiesJson as CitiesData;
  for (const year of [1000, 1100, 1200, 1279, 1300, 1400, 1492, 1715, 1783]) {
    const expected = HRE_MAJOR_POLITY_LEDGER.entries.filter((e) =>
      e.year === year
    );
    const resolved = resolveHreMajorPolities(
      HRE_MAJOR_POLITY_LEDGER,
      year,
      await collectionsFor(year),
      cities,
    );
    assertEquals(resolved.length, expected.length, `${year}年の解決件数`);
    for (const item of resolved) {
      assertEquals(
        item.representation,
        item.entry.expectedRepresentation,
        `${year}:${item.entry.id}`,
      );
      assertEquals(
        Number(item.feature !== null) + Number(item.marker !== null),
        1,
        `${year}:${item.entry.id} は feature/marker の一方だけを持つ`,
      );
    }
  }
});

Deno.test("red回帰: 借用面を除いた旧状態では1492/1715の許可対象も未解決markerへ落ちる", async () => {
  const cities = citiesJson as CitiesData;
  for (const year of [1492, 1715]) {
    const collections = (await collectionsFor(year)).map((collection) => ({
      ...collection,
      features: collection.features.filter((feature) =>
        feature.properties?.BORROWED_FROM === undefined
      ),
    }));
    const resolved = resolveHreMajorPolities(
      HRE_MAJOR_POLITY_LEDGER,
      year,
      collections,
      cities,
    );
    const formerlyMissing = resolved.filter((item) =>
      item.entry.expectedRepresentation === "borrowed-polygon"
    );
    assert(formerlyMissing.length > 0);
    assert(
      formerlyMissing.every((item) =>
        item.representation === "boundary-unavailable-marker"
      ),
    );
  }
});

Deno.test("境界未収録markerのhover/click情報は必要項目を全て含む", () => {
  const resolved = resolveHreMajorPolities(
    HRE_MAJOR_POLITY_LEDGER,
    1000,
    [EMPTY],
    citiesJson as CitiesData,
  )[0];
  const marker = resolved.marker!;
  const tooltip = boundaryMarkerTooltip(marker);
  for (
    const text of [
      marker.entry.nameJa,
      "称号:",
      "存続期間:",
      "宗主勢力:",
      "中心都市:",
      "境界未収録:",
      marker.entry.limitationId,
    ]
  ) assert(tooltip.includes(text), text);
});

Deno.test("借用面は低alphaになり、情報に近似・借用元年・出典・license・理由が出る", () => {
  assertEquals(approximateBorrowedColor([10, 20, 30, 128]), [10, 20, 30, 82]);
  const feature = polygon("Electorate of the Palatinate", true);
  feature.properties!.ATTRIBUTION = {
    source: "Roller / ETH Zürich",
    license: "CC BY-NC-SA 4.0",
    borrowedFrom: [{
      name: "Electorate of the Palatinate",
      reason: "領域連続性を確認済み",
    }],
  };
  const text = borrowedBoundaryDescription(feature)!;
  for (
    const expected of [
      "近似境界",
      "1500年",
      "Roller",
      "CC BY-NC-SA",
      "領域連続性",
    ]
  ) {
    assert(text.includes(expected), expected);
  }
});

Deno.test("1000年ボヘミアの同年面が境界未収録markerを抑制する", async () => {
  const resolved = resolveHreMajorPolities(
    HRE_MAJOR_POLITY_LEDGER,
    1000,
    await collectionsFor(1000),
    citiesJson as CitiesData,
  );
  assertEquals(resolved.length, 1);
  assertEquals(resolved[0].entry.id, "bohemia");
  assertEquals(resolved[0].representation, "exact-polygon");
  assertEquals(resolved[0].feature?.properties?.NAME, "Duchy of Bohemia");
  assertEquals(resolved[0].marker, null);
});
