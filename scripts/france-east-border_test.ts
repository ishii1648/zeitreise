import { assert, assertEquals } from "@std/assert";
import bp from "@turf/boolean-point-in-polygon";
import area from "@turf/area";
import difference from "@turf/difference";
import intersect from "@turf/intersect";
import { featureCollection, polygon } from "@turf/helpers";
import type {
  Feature,
  FeatureCollection,
  MultiPolygon,
  Polygon,
} from "geojson";
import {
  buildSuzerainExtent,
  parseSuzerainOverrides,
  resolveSuzerainKey,
} from "../src/suzerain_extent.ts";
import {
  alignFranceEastBase,
  alignFranceEastFiefs,
} from "./france-east-border.ts";

const read = (path: string): FeatureCollection =>
  JSON.parse(Deno.readTextFileSync(path));
const overrides = parseSuzerainOverrides(
  JSON.parse(Deno.readTextFileSync("data/name-overrides.json")),
);
const cities = {
  Verdun: [5.383, 49.159],
  Toul: [5.894, 48.675],
  Lyon: [4.835, 45.764],
  Arles: [4.627, 43.677],
};
type Surface = Feature<Polygon | MultiPolygon>;

for (const year of [1000, 1100, 1200]) {
  Deno.test(`${year}: eastern cities agree across base, fief fills and selected extents`, () => {
    const base = read(`data/europe_${year}.geojson`);
    const realm = read(
      year === 1200
        ? "data/hre_boundary_1200.geojson"
        : `data/hre_realm_${year}.geojson`,
    );
    const france = buildSuzerainExtent(base, "France", overrides);
    const empire = buildSuzerainExtent(
      base,
      "Holy Roman Empire",
      overrides,
      null,
      year === 1200 ? null : realm,
    );
    for (const [city, point] of Object.entries(cities)) {
      const expected = year === 1000 && (city === "Lyon" || city === "Arles")
        ? "Burgandy"
        : "Holy Roman Empire";
      const hits = base.features.filter((f) => bp(point, f as Surface));
      assertEquals(hits.length, 1, `${city}: base coverage`);
      assertEquals(
        resolveSuzerainKey(hits[0].properties, overrides),
        expected,
        city,
      );
      assert(
        !france.features.some((f) => bp(point, f as Surface)),
        `${city}: France selection`,
      );
      assertEquals(
        empire.features.some((f) => bp(point, f as Surface)),
        expected === "Holy Roman Empire",
        city,
      );
      for (const stem of ["france_fiefs_flat", "cliopatria_fiefs_flat"]) {
        const hits = read(`data/${stem}_${year}.geojson`).features.filter((f) =>
          bp(point, f as Surface)
        );
        assertEquals(hits.length, 0, `${city}: ${stem} must not paint France`);
      }
    }
    const dijon = base.features.find((f) => bp([5.041, 47.322], f as Surface));
    assertEquals(resolveSuzerainKey(dijon!.properties, overrides), "France");
    const besancon = base.features.find((f) =>
      bp([6.024, 47.238], f as Surface)
    );
    assertEquals(
      resolveSuzerainKey(besancon!.properties, overrides),
      year === 1000 ? "Burgandy" : "Holy Roman Empire",
    );
  });

  Deno.test(`${year}: shared border has no overlapping France fill or missing base near the reported cities`, () => {
    const base = read(`data/europe_${year}.geojson`);
    const empire = read(
      year === 1200
        ? "data/hre_boundary_1200.geojson"
        : `data/hre_realm_${year}.geojson`,
    );
    const burgundy = year === 1000
      ? read("data/burgundy_realm_1000.geojson")
      : empire;
    for (const [city, p] of Object.entries(cities)) {
      const [x, y] = p;
      const window = polygon([[
        [x - .08, y - .08],
        [x + .08, y - .08],
        [x + .08, y + .08],
        [x - .08, y + .08],
        [x - .08, y - .08],
      ]]);
      let gap: Surface | null = window;
      for (const f of base.features) {
        if (gap) gap = difference(featureCollection([gap, f as Surface]));
      }
      assert(area(gap ?? featureCollection([])) < 1e6, `${city}: base gap`);
      const reference = (year === 1000 && (city === "Lyon" || city === "Arles")
        ? burgundy
        : empire).features[0] as Surface;
      for (
        const f of base.features.filter((f) =>
          resolveSuzerainKey(f.properties, overrides) === "France"
        )
      ) {
        const local = intersect(
          featureCollection([window, f as Surface, reference]),
        );
        assert(
          area(local ?? featureCollection([])) < 1e6,
          `${city}: overlapping France / realm`,
        );
      }
    }
  });
}

Deno.test("border correction preserves Flanders and is inactive outside the three years", async () => {
  const flanders = polygon([[
    [3.1, 50.1],
    [3.7, 50.1],
    [3.7, 50.7],
    [3.1, 50.7],
    [3.1, 50.1],
  ]], { NAME: "Kingdom of France" });
  const hre = polygon([[[8, 48], [9, 48], [9, 49], [8, 49], [8, 48]]], {
    NAME: "Holy Roman Empire",
  });
  const burgundy = polygon([[[6, 46], [7, 46], [7, 47], [6, 47], [6, 46]]], {
    NAME: "Burgandy",
  });
  const fc = featureCollection([flanders, hre, burgundy]);
  const after = await alignFranceEastBase(fc, 1000);
  assertEquals(after.features, fc.features);
  assertEquals(await alignFranceEastBase(fc, 1300), fc);
  const fiefs = featureCollection([{
    ...flanders,
    properties: { NAME: "County of Flanders" },
  }]);
  assertEquals(
    (await alignFranceEastFiefs(fiefs, 1100)).features,
    fiefs.features,
  );
  const royalNorth = featureCollection([{
    ...flanders,
    properties: { NAME: "Royal Domain of France" },
  }]);
  assertEquals(
    (await alignFranceEastFiefs(royalNorth, 1200)).features,
    royalNorth.features,
  );
});

Deno.test("shared-boundary transfer conserves coverage along the whole affected component", async () => {
  const france = polygon([[[4, 43.1], [6.9, 43.1], [6.9, 49.7], [4, 49.7], [
    4,
    43.1,
  ]]], { NAME: "Kingdom of France" });
  const hre = polygon([[[8, 48], [9, 48], [9, 49], [8, 49], [8, 48]]], {
    NAME: "Holy Roman Empire",
  });
  const burgundy = polygon([[[8, 46], [9, 46], [9, 47], [8, 47], [8, 46]]], {
    NAME: "Burgandy",
  });
  const before = featureCollection([france, hre, burgundy]);
  for (const year of [1000, 1100, 1200]) {
    const after = await alignFranceEastBase(before, year);
    for (const [source, subtract] of [[before, after], [after, before]]) {
      for (const feature of source.features) {
        let rest: Surface | null = feature as Surface;
        for (const other of subtract.features) {
          if (rest) {
            rest = difference(featureCollection([rest, other as Surface]));
          }
        }
        if (rest) {
          const parts = rest.geometry.type === "Polygon"
            ? [rest.geometry.coordinates]
            : rest.geometry.coordinates;
          for (const part of parts) {
            assert(
              area(polygon(part)) < 1e6,
              `${year}: transfer leaves a gap or adds land beyond the existing 1 km² cleanup threshold`,
            );
          }
        }
      }
    }
    const remaining = after.features.find((f) =>
      f.properties?.NAME === "Kingdom of France"
    ) as Surface;
    for (
      const target of after.features.filter((f) =>
        f.properties?.NAME !== "Kingdom of France"
      )
    ) {
      const overlap = intersect(
        featureCollection([remaining, target as Surface]),
      );
      assert(
        area(overlap ?? featureCollection([])) < 1e6,
        `${year}: transferred land overlaps France`,
      );
    }
  }
});

Deno.test("new border inputs retain source dates, license and checksum", () => {
  for (
    const [path, id, year] of [[
      "data/burgundy_realm_1000.geojson",
      2805402,
      1000,
    ], ["data/hre_boundary_1200.geojson", 2892299, 1200]] as const
  ) {
    const fc = JSON.parse(Deno.readTextFileSync(path));
    assertEquals(fc.metadata.relationId, id);
    assertEquals(fc.metadata.license, "CC0-1.0");
    assertEquals(fc.metadata.year, year);
    assert(Number.parseInt(fc.metadata.startDate, 10) <= year);
    assert(Number.parseInt(fc.metadata.endDate, 10) >= year);
    assert(/^[a-f0-9]{64}$/.test(fc.metadata.inputSha256));
    assert(fc.metadata.uncertainty.length > 0);
  }
});

Deno.test("1200: northern base and both extents use the OHM border without the old straight segments", () => {
  const base = read("data/europe_1200.geojson");
  const realm = read("data/hre_boundary_1200.geojson").features[0] as Surface;
  const window = polygon([[[3.3, 49.7], [5.3, 49.7], [5.3, 51.1], [3.3, 51.1], [
    3.3,
    49.7,
  ]]]);
  const france = buildSuzerainExtent(base, "France", overrides)
    .features[0] as Surface;
  const empire = buildSuzerainExtent(base, "Holy Roman Empire", overrides)
    .features[0] as Surface;
  assert(
    area(
      intersect(featureCollection([france, empire, window])) ??
        featureCollection([]),
    ) < 1,
  );
  let gap: Surface | null = window;
  for (const f of base.features) {
    if (gap) gap = difference(featureCollection([gap, f as Surface]));
  }
  assert(area(gap ?? featureCollection([])) < 1);
  assert(
    area(
      intersect(featureCollection([france, realm, window])) ??
        featureCollection([]),
    ) < 1e4,
  );
  const localEmpire = intersect(featureCollection([empire, window]))!;
  assert(
    area(
      difference(featureCollection([localEmpire, realm])) ??
        featureCollection([]),
    ) < 1e4,
  );
  for (const name of ["Kingdom of France", "Holy Roman Empire"]) {
    const f = base.features.find((f) => f.properties?.NAME === name)!;
    for (const point of ["[3.82,50.039]", "[4.255,49.887]", "[5.361,49.697]"]) {
      assert(
        !JSON.stringify(f.geometry).includes(point),
        `${name}: old border vertex ${point}`,
      );
    }
  }
});

Deno.test("1200: northern transfer conserves land and keeps uncertain fief geometry", async () => {
  const west = polygon([[[3, 49.8], [3.8, 49.8], [3.8, 51.2], [3, 51.2], [
    3,
    49.8,
  ]]], { NAME: "Kingdom of France" });
  const east = polygon([[[3.8, 49.8], [5, 49.8], [5, 51.2], [3.8, 51.2], [
    3.8,
    49.8,
  ]]], { NAME: "Holy Roman Empire" });
  const before = featureCollection([west, east]);
  const after = await alignFranceEastBase(before, 1200);
  for (const [source, subtract] of [[before, after], [after, before]]) {
    for (const f of source.features) {
      let remainder: Surface | null = f as Surface;
      for (const other of subtract.features) {
        if (remainder) {
          remainder = difference(
            featureCollection([remainder, other as Surface]),
          );
        }
      }
      assert(area(remainder ?? featureCollection([])) < 1);
    }
  }
  const fiefs = read("data/cliopatria_fiefs_flat_1200.geojson");
  const aligned = await alignFranceEastFiefs(fiefs, 1200);
  for (
    const name of [
      "County of Flanders",
      "County of Vermandois",
    ]
  ) {
    const original = fiefs.features.find((f) => f.properties?.NAME === name)!;
    assertEquals(
      aligned.features.find((f) => f.properties?.NAME === name)!.geometry,
      original.geometry,
    );
  }
});
