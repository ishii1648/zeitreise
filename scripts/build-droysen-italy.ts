import type { FeatureCollection, MultiPolygon, Position } from "geojson";
import difference from "@turf/difference";
import trace from "./droysen-italy-trace.json" with { type: "json" };

export const DROYSEN_ITALY_ATTRIBUTION = {
  source:
    "Gustav Droysen, Allgemeiner historischer Handatlas (1886), plate 67: Italien um das Jahr 1300; Polona / Wikimedia Commons",
  sourceUrl: trace.source.url,
  license: "CC0-1.0",
  borderPrecision: "1300年の歴史図版から転写した概略境界",
  sourceYear: 1300,
  sourceSha256: trace.source.sha256,
  changes:
    "PD原スキャンの境界を自前トレースし、経緯線でWGS84へ較正。微小島は判読できたもののみ収録。",
} as const;

function terms(x: number, y: number): number[] {
  return [1, x, y, x * x, x * y, y * y];
}

function fit(axis: number): number[] {
  const rows = trace.controlPoints.map((p) =>
    terms(...p.coordinate as [number, number])
  );
  const matrix = Array.from({ length: 6 }, (_, i) => [
    ...Array.from(
      { length: 6 },
      (_, j) => rows.reduce((sum, r) => sum + r[i] * r[j], 0),
    ),
    rows.reduce(
      (sum, r, k) => sum + r[i] * trace.controlPoints[k].pixel[axis],
      0,
    ),
  ]);
  for (let i = 0; i < 6; i++) {
    const pivot = matrix[i][i];
    matrix[i] = matrix[i].map((v) => v / pivot);
    for (let j = 0; j < 6; j++) {
      if (j === i) continue;
      const factor = matrix[j][i];
      matrix[j] = matrix[j].map((v, k) => v - factor * matrix[i][k]);
    }
  }
  return matrix.map((r) => r[6]);
}

export function buildDroysenItaly(): FeatureCollection<MultiPolygon> {
  const cx = fit(0);
  const cy = fit(1);
  function coordinate(pixel: number[]): Position {
    let x = 14;
    let y = 40;
    for (let i = 0; i < 8; i++) {
      const t = terms(x, y);
      const dx = t.reduce((v, n, j) => v + n * cx[j], -pixel[0]);
      const dy = t.reduce((v, n, j) => v + n * cy[j], -pixel[1]);
      const a = cx[1] + 2 * cx[3] * x + cx[4] * y;
      const b = cx[2] + cx[4] * x + 2 * cx[5] * y;
      const c = cy[1] + 2 * cy[3] * x + cy[4] * y;
      const d = cy[2] + cy[4] * x + 2 * cy[5] * y;
      const determinant = a * d - b * c;
      x -= (d * dx - b * dy) / determinant;
      y -= (a * dy - c * dx) / determinant;
    }
    return [Number(x.toFixed(5)), Number(y.toFixed(5))];
  }
  return {
    type: "FeatureCollection",
    features: trace.features.map((f) => ({
      type: "Feature",
      properties: {
        NAME: f.name,
        ABBREVN: f.name,
        SUBJECTO: f.name,
        PARTOF: f.name,
        BORDERPRECISION: 1,
        ATTRIBUTION: DROYSEN_ITALY_ATTRIBUTION,
      },
      geometry: {
        type: "MultiPolygon",
        coordinates: f.pixels.map((p) => p.map((r) => r.map(coordinate))),
      },
    })),
  };
}

export function prepareDroysenItalyBase(
  fc: FeatureCollection,
  year: number,
): FeatureCollection {
  if (year !== 1300) return fc;
  const naples = buildDroysenItaly().features[0];
  return {
    ...fc,
    features: fc.features.filter((f) => f.properties?.NAME !== "Sicily").map(
      (f) => {
        if (f.properties?.NAME !== "Papal States") return f;
        const clipped = difference({
          type: "FeatureCollection",
          features: [f as typeof naples, naples],
        });
        if (!clipped) throw new Error("D67 mask removed the Papal States");
        return { ...f, geometry: clipped.geometry };
      },
    ),
  };
}

if (import.meta.main) {
  const sourcePath = Deno.args[0];
  if (!sourcePath) {
    throw new Error("Pass the pinned D67 JPEG path to verify the trace source");
  }
  const bytes = await Deno.readFile(sourcePath);
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  if (digest !== trace.source.sha256) {
    throw new Error("D67 source checksum mismatch");
  }
  const collection = buildDroysenItaly();
  await Deno.writeTextFile(
    "data/droysen_italy_1300.geojson",
    JSON.stringify({ ...collection, metadata: DROYSEN_ITALY_ATTRIBUTION }) +
      "\n",
  );
  const outlines = collection.features.flatMap((f) =>
    f.geometry.coordinates.flatMap((p) =>
      p.map((r) => ({ ...f, geometry: { type: "LineString", coordinates: r } }))
    )
  );
  await Deno.writeTextFile(
    "data/droysen_italy_outline_1300.geojson",
    JSON.stringify({
      ...collection,
      features: outlines,
      metadata: DROYSEN_ITALY_ATTRIBUTION,
    }) + "\n",
  );
}
