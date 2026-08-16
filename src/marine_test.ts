import { assertEquals } from "@std/assert";
import { assert } from "@std/assert";
import type { FeatureCollection } from "geojson";
import { filterVisibleMarineLabels, marineLabelData } from "./marine.ts";

const fc: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [10, 40] },
      properties: {
        name: "Mediterranean Sea",
        name_ja: "地中海",
        scalerank: 1,
        min_label: 2,
        max_label: 7.5,
        featurecla: "sea",
      },
    },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [15, 43] },
      properties: {
        name: "Adriatic Sea",
        name_ja: "",
        scalerank: 3,
        min_label: 5,
        max_label: 9.5,
        featurecla: "sea",
      },
    },
  ],
};

Deno.test("海域名は日本語を優先し空文字だけ英語へフォールバックする", () => {
  const labels = marineLabelData(fc);
  assertEquals(labels.map((x) => x.text), ["地中海", "Adriatic Sea"]);
});

Deno.test("Natural Earth の min/max label で段階表示する", () => {
  const labels = marineLabelData(fc);
  assertEquals(filterVisibleMarineLabels(labels, 4).map((x) => x.name), [
    "Mediterranean Sea",
  ]);
  assertEquals(filterVisibleMarineLabels(labels, 5).map((x) => x.name), [
    "Mediterranean Sea",
    "Adriatic Sea",
  ]);
  assertEquals(filterVisibleMarineLabels(labels, 8).map((x) => x.name), [
    "Adriatic Sea",
  ]);
});

Deno.test("配信 asset の件数 metadata と必須ズーム階層が整合する", async () => {
  const asset = JSON.parse(
    await Deno.readTextFile(
      new URL("../data/marine-labels.geojson", import.meta.url),
    ),
  ) as FeatureCollection & { metadata: Record<string, unknown> };
  assertEquals(asset.metadata.targetFeatureCount, asset.features.length);
  assertEquals(asset.metadata.sourceFeatureCount, 306);
  assertEquals(
    asset.metadata.commit,
    "ca96624a56bd078437bca8184e78163e5039ad19",
  );
  const labels = marineLabelData(asset);
  const at = (zoom: number) =>
    new Set(filterVisibleMarineLabels(labels, zoom).map((x) => x.text));
  for (const name of ["大西洋", "地中海", "黒海", "北海", "バルト海"]) {
    assert(at(4).has(name));
  }
  assert(at(5).has("アドリア海"));
  assert(at(6).has("エーゲ海") && at(6).has("イオニア海"));
  assert(!at(8).has("地中海"));
});
