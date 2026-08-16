/** base 勢力に対する諸侯領オーバーレイの被覆率を raw GeoJSON から再計測する。 */
import area from "@turf/area";
import { featureCollection } from "@turf/helpers";
import intersect from "@turf/intersect";
import union from "@turf/union";
import type {
  Feature,
  FeatureCollection,
  MultiPolygon,
  Polygon,
} from "geojson";

type AreaFeature = Feature<Polygon | MultiPolygon>;
async function readCollection(
  path: string,
): Promise<FeatureCollection<Polygon | MultiPolygon>> {
  return JSON.parse(await Deno.readTextFile(path));
}
function merge(features: readonly AreaFeature[]): AreaFeature | null {
  if (features.length === 0) return null;
  return features.length === 1
    ? features[0]
    : union(featureCollection(features));
}
export function measureCoverage(
  base: readonly AreaFeature[],
  overlays: readonly AreaFeature[],
) {
  const baseUnion = merge(base);
  if (baseUnion === null) throw new Error("base 勢力が見つかりません");
  const overlayUnion = merge(overlays);
  const covered = overlayUnion === null
    ? null
    : intersect(featureCollection([baseUnion, overlayUnion]));
  const baseKm2 = area(baseUnion) / 1_000_000;
  const coveredKm2 = covered === null ? 0 : area(covered) / 1_000_000;
  return {
    baseKm2,
    coverage: coveredKm2 / baseKm2,
    gapKm2: baseKm2 - coveredKm2,
  };
}
if (import.meta.main) {
  const [year, power] = Deno.args;
  if (!year || !power) {
    throw new Error("usage: measure-fief-coverage <year> <base NAME>");
  }
  const base = await readCollection(`data/europe_${year}.geojson`);
  const ohm = await readCollection(`data/france_fiefs_${year}.geojson`);
  const cliopatria = await readCollection(
    `data/cliopatria_fiefs_${year}.geojson`,
  );
  const baseFeatures = base.features.filter((feature) =>
    feature.properties?.NAME === power
  );
  for (
    const [label, overlays] of [["OHM", ohm.features], ["OHM + Cliopatria", [
      ...ohm.features,
      ...cliopatria.features,
    ]]] as const
  ) {
    const result = measureCoverage(baseFeatures, overlays);
    console.log(
      `${label}\tbase=${Math.round(result.baseKm2)} km²\tcoverage=${
        (result.coverage * 100).toFixed(1)
      }%\tgap=${Math.round(result.gapKm2)} km²`,
    );
  }
}
