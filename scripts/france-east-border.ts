import {
  cleanFeatureCollection,
  normalizeSelfIntersections,
} from "./clean-polygons.ts";
import bp from "@turf/boolean-point-in-polygon";
import difference from "@turf/difference";
import { featureCollection, multiPolygon, polygon } from "@turf/helpers";
import intersect from "@turf/intersect";
import union from "@turf/union";
import type {
  Feature,
  FeatureCollection,
  MultiPolygon,
  Polygon,
} from "geojson";

type Surface = Feature<Polygon | MultiPolygon>;
const CITIES = [[5.383, 49.159], [5.894, 48.675], [4.835, 45.764], [
  4.627,
  43.677,
]];
const FRENCH_FIEFS = new Set([
  "Duchy of Burgundy",
  "County of Champagne",
  "County of Toulouse",
  "County of Rouergue",
  "Duchy of Aquitaine",
  "Royal Domain of France",
]);

function withBoundaryMetadata(
  fc: FeatureCollection,
  year: number,
): FeatureCollection {
  const previous =
    (fc as FeatureCollection & { metadata?: Record<string, unknown> }).metadata;
  const result = {
    ...cleanFeatureCollection(fc).fc,
    metadata: {
      ...previous,
      boundaryAlignment: {
        issue: 513,
        inputs: [
          year === 1200
            ? "data/hre_boundary_1200.geojson"
            : `data/hre_realm_${year}.geojson`,
          ...(year === 1000 ? ["data/burgundy_realm_1000.geojson"] : []),
        ],
        scope: year === 1200
          ? "フランス東境の都市を含む重複成分と指定領邦。北部の共有境界はOHMへ双方向に整合するが、フランドル・ヴェルマンドワの塗りは維持する（#517）。"
          : "フランス東境の都市を含む重複成分と、同境界に接する指定領邦。フランドルは対象外。",
        uncertainty:
          "同年代の表示整合のために採用したOHM境界。推測・描写年未確定図版に由来する区間を含み、史料で確定した境界ではない。",
      },
    },
  };
  return result;
}

async function boundaries(year: number): Promise<Surface[]> {
  const paths = [
    year === 1200
      ? "data/hre_boundary_1200.geojson"
      : `data/hre_realm_${year}.geojson`,
  ];
  if (year === 1000) paths.push("data/burgundy_realm_1000.geojson");
  return await Promise.all(paths.map(async (path) => {
    const fc = JSON.parse(await Deno.readTextFile(path));
    return fc.features[0] as Surface;
  }));
}

export async function alignFranceEastBase(
  fc: FeatureCollection,
  year: number,
): Promise<FeatureCollection> {
  if (![1000, 1100, 1200].includes(year)) return fc;
  let features = [...fc.features];
  for (const realm of await boundaries(year)) {
    const target = features.findIndex((f) =>
      f.properties?.NAME === realm.properties?.NAME
    );
    if (target < 0) {
      throw new Error(`${year}: missing ${realm.properties?.NAME}`);
    }
    for (let i = 0; i < features.length; i++) {
      if (
        !["Kingdom of France", "Comté de Toulouse"].includes(
          features[i].properties?.NAME,
        )
      ) continue;
      const overlap = intersect(
        featureCollection([features[i] as Surface, realm]),
      );
      if (!overlap) continue;
      const parts = overlap.geometry.type === "Polygon"
        ? [overlap.geometry.coordinates]
        : overlap.geometry.coordinates;
      // 都市は連結成分の選択にだけ使う。境界座標は同年代realmとbaseの交点から得る。
      // フランドルの別成分と1000年のアルプス側の別成分は移さない。
      const selected = parts.filter((part) =>
        CITIES.some((point) => bp(point, polygon(part)))
      );
      if (selected.length === 0) continue;
      const transferred = multiPolygon(selected);
      const rest = difference(
        featureCollection([features[i] as Surface, transferred]),
      );
      const grown = union(
        featureCollection([features[target] as Surface, transferred]),
      );
      if (!rest || !grown) throw new Error(`${year}: empty border correction`);
      features[i] = { ...features[i], geometry: rest.geometry };
      features[target] = { ...features[target], geometry: grown.geometry };
    }
  }
  const aligned = withBoundaryMetadata({ ...fc, features }, year);
  if (year !== 1200) return aligned;
  features = [...aligned.features];
  const realm = (await boundaries(year))[0];
  const empireIndex = features.findIndex((f) =>
    f.properties?.NAME === "Holy Roman Empire"
  );
  const franceIndex = features.findIndex((f) =>
    f.properties?.NAME === "Kingdom of France"
  );
  for (
    const [from, to] of [[franceIndex, empireIndex], [empireIndex, franceIndex]]
  ) {
    const pair = featureCollection([features[from] as Surface, realm]);
    const delta = from === franceIndex ? intersect(pair) : difference(pair);
    const parts = delta?.geometry.type === "Polygon"
      ? [delta.geometry.coordinates]
      : delta?.geometry.coordinates ?? [];
    // 連結成分全体を双方向に移す。矩形は選択にだけ使い、その辺で境界を切らない。
    const northern = parts.filter((part) =>
      part[0].every(([x, y]) => x > 2 && x < 6 && y > 49 && y < 52)
    );
    if (northern.length === 0) continue;
    const transferred = multiPolygon(northern);
    const rest = difference(
      featureCollection([features[from] as Surface, transferred]),
    );
    const grown = union(
      featureCollection([features[to] as Surface, transferred]),
    );
    if (!rest || !grown) {
      throw new Error(`${year}: empty northern border correction`);
    }
    features[from] = { ...features[from], geometry: rest.geometry };
    features[to] = { ...features[to], geometry: grown.geometry };
  }
  for (const index of [franceIndex, empireIndex]) {
    // 交点の浮動小数点差で残るゼロ面積の旧境界を除く。南部の座標精度は維持する。
    const geometry = normalizeSelfIntersections(
      (features[index] as Surface).geometry,
      12,
    );
    if (!geometry) throw new Error(`${year}: empty normalized border`);
    features[index] = { ...features[index], geometry };
  }
  return { ...aligned, features };
}

export async function alignFranceEastFiefs(
  fc: FeatureCollection,
  year: number,
): Promise<FeatureCollection> {
  if (![1000, 1100, 1200].includes(year)) return fc;
  const realms = await boundaries(year);
  const features = fc.features.map((feature) => {
    const name = feature.properties?.NAME;
    if (name === "County of Bar" && year !== 1000) {
      const clipped = intersect(
        featureCollection([feature as Surface, realms[0]]),
      );
      if (!clipped) throw new Error(`${year}: empty County of Bar`);
      return {
        ...feature,
        geometry: clipped.geometry,
        properties: {
          ...feature.properties,
          SUBJECTO: "Holy Roman Empire",
          PARTOF: "Holy Roman Empire",
        },
      };
    }
    if (!FRENCH_FIEFS.has(name)) return feature;
    let result = feature as Surface;
    for (const realm of realms) {
      const overlap = intersect(featureCollection([result, realm]));
      if (!overlap) continue;
      const parts = overlap.geometry.type === "Polygon"
        ? [overlap.geometry.coordinates]
        : overlap.geometry.coordinates;
      // 北緯50度以北に達する成分はフランドル側として温存する。緯線で境界を切らない。
      const eastern = parts.filter((part) => part[0].every((p) => p[1] < 50));
      if (eastern.length === 0) continue;
      const rest = difference(
        featureCollection([result, multiPolygon(eastern)]),
      );
      if (!rest) throw new Error(`${year}: empty ${name}`);
      result = { ...result, geometry: rest.geometry };
    }
    return result;
  });
  return withBoundaryMetadata({ ...fc, features }, year);
}
