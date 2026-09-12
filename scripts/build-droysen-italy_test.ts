import { assert, assertEquals } from "@std/assert";
import { getDataCopyTargets } from "./build.ts";
import area from "@turf/area";
import pointInPolygon from "@turf/boolean-point-in-polygon";
import intersect from "@turf/intersect";
import kinks from "@turf/kinks";
import {
  buildDroysenItaly,
  prepareDroysenItalyBase,
} from "./build-droysen-italy.ts";
import {
  createDroysenItalyLoader,
  createYearDataLoader,
  withBorrowedGeometry,
} from "../src/powers.ts";

Deno.test("D67の両王国は別の有効面であり、教皇領と海峡を含まない", () => {
  const [naples, sicily] = buildDroysenItaly().features;
  for (const f of [naples, sicily]) {
    assertEquals(kinks(f).features.length, 0);
    for (const polygon of f.geometry.coordinates) {
      for (const ring of polygon) assertEquals(ring[0], ring.at(-1));
    }
    assertEquals(f.properties?.ATTRIBUTION.sourceYear, 1300);
    assertEquals(f.properties?.ATTRIBUTION.license, "CC0-1.0");
    assertEquals(f.properties?.BORROWED_FROM, undefined);
  }
  assert(area(naples) > 70_000e6 && area(naples) < 80_000e6);
  assert(area(sicily) > 24_000e6 && area(sicily) < 28_000e6);
  for (const point of [[14.268, 40.851], [13.399, 42.35], [16.25, 39.3]]) {
    assert(pointInPolygon(point, naples));
    assert(!pointInPolygon(point, sicily));
  }
  for (const point of [[13.361, 38.116], [14.28, 37.57]]) {
    assert(pointInPolygon(point, sicily));
    assert(!pointInPolygon(point, naples));
  }
  for (const point of [[14.782, 41.13], [12.496, 41.903], [15.60, 38.20]]) {
    assert(!pointInPolygon(point, naples));
    assert(!pointInPolygon(point, sicily));
  }
  assertEquals(
    intersect({ type: "FeatureCollection", features: [naples, sicily] }),
    null,
  );
});

Deno.test("CC0成果物は生成結果と一致しGPLのbaseとはファイルを分離する", async () => {
  const delivered = getDataCopyTargets("dist", [1300], []).map((target) =>
    target.from
  );
  assert(delivered.includes("data/droysen_italy_1300.geojson"));
  assert(delivered.includes("data/droysen_italy_outline_1300.geojson"));
  const atlas = JSON.parse(
    await Deno.readTextFile("data/droysen_italy_1300.geojson"),
  );
  assertEquals(atlas.features, buildDroysenItaly().features);
  const base = JSON.parse(await Deno.readTextFile("data/europe_1300.geojson"));
  assert(
    !base.features.some((f: { properties: { NAME: string } }) =>
      ["Sicily", "Naples"].includes(f.properties.NAME)
    ),
  );
  const papal = base.features.find((f: { properties: { NAME: string } }) =>
    f.properties.NAME === "Papal States"
  );
  const overlap = intersect({
    type: "FeatureCollection",
    features: [papal, atlas.features[0]],
  });
  assert(overlap === null || area(overlap) < 1);
  for (const year of [1279, 1400]) {
    assertEquals(prepareDroysenItalyBase(base, year), base);
  }
});

Deno.test("通常面・塗り・輪郭の配信は1300年だけD67を加える", async () => {
  const calls: string[] = [];
  const fetcher = (url: string) => {
    calls.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => JSON.parse(await Deno.readTextFile(url.slice(1))),
    });
  };
  for (const prefix of ["europe", "europe_flat", "base_outline"]) {
    const loader = withBorrowedGeometry(
      createYearDataLoader(fetcher, (y) => `/data/${prefix}_${y}.geojson`),
      createDroysenItalyLoader(fetcher, prefix === "base_outline"),
    );
    const data = await loader.load(1300);
    for (const name of ["Naples", "Sicily"]) {
      const features = data.features.filter((f) => f.properties?.NAME === name);
      assert(features.length > 0);
      if (prefix !== "base_outline") assertEquals(features.length, 1);
      assertEquals(features[0].properties?.ATTRIBUTION.sourceYear, 1300);
    }
    const before = calls.length;
    assertEquals(await loader.load(1300), data);
    assertEquals(calls.length, before);
    for (const year of [1279, 1400]) await loader.load(year);
  }
  assert(
    calls.filter((p) => p.includes("droysen")).every((p) =>
      p.endsWith("1300.geojson")
    ),
  );
});
