import {
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import type { FeatureCollection } from "geojson";
import {
  applyExtentMembership,
  EXTENT_MEMBERSHIP_TABLE,
  indexExtentMembership,
} from "./extent_membership.ts";
import {
  EMPTY_SUZERAIN_OVERRIDES,
  resolveExtentMembership,
} from "./suzerain_extent.ts";

const fc: FeatureCollection = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: { NAME: "Republic of Pisa" },
    geometry: {
      type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
    },
  }],
};

Deno.test("外枠所属表は全 830 feature-year を重複なく明示する", () => {
  assertEquals(EXTENT_MEMBERSHIP_TABLE.entries.length, 830);
  assertEquals(indexExtentMembership().size, 830);
});

Deno.test("indexExtentMembership は member の extent key 欠落を拒否する", () => {
  assertThrows(
    () =>
      indexExtentMembership({
        version: 1,
        entries: [{
          year: 1000,
          layer: "hre",
          name: "Broken member",
          extentKey: null,
          role: "member",
          basis: "test",
        }],
      }),
    Error,
    "外枠所属が不正です",
  );
});

Deno.test("applyExtentMembership は Pisa を周囲の base ではなく self にする", () => {
  const result = applyExtentMembership(
    fc,
    1279,
    "italy",
    EMPTY_SUZERAIN_OVERRIDES,
  );
  assertNotStrictEquals(result, fc);
  assertEquals(result.features[0].properties?.EXTENT_KEY, "Republic of Pisa");
  assertEquals(result.features[0].properties?.EXTENT_ROLE, "self");
  assertEquals(result.features[0].properties?.SUBJECTO, undefined);
});

Deno.test("base は SUBJECTO を外枠契約へコピーするが元プロパティを変えない", () => {
  const base: FeatureCollection = {
    type: "FeatureCollection",
    features: [{
      ...fc.features[0],
      properties: { NAME: "Vassal", SUBJECTO: "Empire" },
    }],
  };
  const result = applyExtentMembership(
    base,
    1000,
    "powers",
    EMPTY_SUZERAIN_OVERRIDES,
  );
  assertEquals(result.features[0].properties?.SUBJECTO, "Empire");
  assertEquals(
    resolveExtentMembership(
      result.features[0].properties,
      EMPTY_SUZERAIN_OVERRIDES,
    ),
    { key: "Empire", role: "member" },
  );
});

Deno.test("明示所属が既に同じなら FeatureCollection の参照を保つ", () => {
  const annotated = applyExtentMembership(
    fc,
    1279,
    "italy",
    EMPTY_SUZERAIN_OVERRIDES,
  );
  assertStrictEquals(
    applyExtentMembership(
      annotated,
      1279,
      "italy",
      EMPTY_SUZERAIN_OVERRIDES,
    ),
    annotated,
  );
});

Deno.test("mixed は上位キーを保ち情報表示可能な正式 role として解決する", () => {
  assertEquals(
    resolveExtentMembership({
      NAME: "Cross-border polity",
      EXTENT_KEY: "Empire",
      EXTENT_ROLE: "mixed",
    }, EMPTY_SUZERAIN_OVERRIDES),
    { key: "Empire", role: "mixed" },
  );
});

Deno.test("旧データ互換でも SUBJECTO が異なる feature は member として解決する", () => {
  assertEquals(
    resolveExtentMembership(
      { NAME: "Vassal", SUBJECTO: "Empire" },
      EMPTY_SUZERAIN_OVERRIDES,
    ),
    { key: "Empire", role: "member" },
  );
});
