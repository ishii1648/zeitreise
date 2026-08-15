import { assert, assertEquals } from "@std/assert";

type Position = [number, number];
type Feature = {
  properties: Record<string, unknown>;
  geometry: { coordinates: unknown };
};

const data = JSON.parse(await Deno.readTextFile("data/europe_1700.geojson"));
const austria = data.features.filter((f: Feature) =>
  f.properties.NAME === "Austrian Empire"
);
const positions = (value: unknown): Position[] =>
  Array.isArray(value) && value.length === 2 &&
    value.every((v) => typeof v === "number")
    ? [value as Position]
    : Array.isArray(value)
    ? value.flatMap(positions)
    : [];
const points: Position[] = austria.flatMap((f: Feature) =>
  positions(f.geometry.coordinates)
);
const distance = (a: Position, b: Position): number => {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(h));
};

Deno.test("#404: 1700 Austrian Empire は誤った長辺・東方張り出し・東プロイセン飛地を含まない", () => {
  assertEquals(austria.length, 1);
  assert(Math.max(...points.map(([x]) => x)) < 26.5);
  assert(!points.some(([x, y]) => x >= 19.5 && x <= 21.1 && y >= 53.4));
  for (let i = 1; i < points.length; i++) {
    assert(distance(points[i - 1], points[i]) < 400);
  }
});

Deno.test("#404: 借用面は1715年本土の座標を無改変で保持する", async () => {
  const borrowed = JSON.parse(
    await Deno.readTextFile("data/borrowed_austrian_empire_1700.geojson"),
  );
  const source = JSON.parse(
    await Deno.readTextFile("data/europe_1715.geojson"),
  );
  const sourceFeature = source.features.find((f: Feature) =>
    f.properties.NAME === "Austrian Empire"
  );
  assertEquals(borrowed.features[0].geometry.coordinates, [
    sourceFeature.geometry.coordinates[0],
  ]);
  assertEquals(borrowed.metadata.borrowedFromYear, 1715);
});
