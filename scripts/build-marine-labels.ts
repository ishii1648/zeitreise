/** Natural Earth の海域ポリゴンからヨーロッパ用ラベルアンカーを生成する。 */
import type { Feature, FeatureCollection, Point } from "geojson";
import bboxClip from "@turf/bbox-clip";
import { labelAnchorFor } from "../src/labels.ts";
import { EUROPE_BBOX } from "./build-data.ts";

export const MARINE_SOURCE_REPO = "nvkelso/natural-earth-vector";
export const MARINE_SOURCE_COMMIT = "ca96624a56bd078437bca8184e78163e5039ad19";
export const MARINE_SOURCE_LICENSE = "Public Domain (Natural Earth)";
export const MARINE_SOURCE_FILE =
  "geojson/ne_10m_geography_marine_polys.geojson";
export const MARINE_OUTPUT_PATH = "data/marine-labels.geojson";
export const MARINE_ADOPTED_ATTRIBUTES = [
  "name",
  "name_ja",
  "featurecla",
  "scalerank",
  "min_label",
  "max_label",
  "wikidataid",
] as const;

export function buildMarineSourceUrl(): string {
  return `https://raw.githubusercontent.com/${MARINE_SOURCE_REPO}/${MARINE_SOURCE_COMMIT}/${MARINE_SOURCE_FILE}`;
}

function prop(props: Record<string, unknown>, lower: string): unknown {
  return props[lower] ?? props[lower.toUpperCase()];
}

export function buildMarineLabels(
  source: FeatureCollection,
): FeatureCollection<Point> {
  const features: Feature<Point>[] = [];
  for (const feature of source.features) {
    if (
      feature.geometry?.type !== "Polygon" &&
      feature.geometry?.type !== "MultiPolygon"
    ) continue;
    let clipped: Feature;
    try {
      clipped = bboxClip(feature as never, EUROPE_BBOX) as Feature;
    } catch {
      continue;
    }
    const anchor = labelAnchorFor(clipped);
    if (!anchor) continue;
    const sourceProps = (feature.properties ?? {}) as Record<string, unknown>;
    const properties: Record<string, unknown> = {};
    for (const key of MARINE_ADOPTED_ATTRIBUTES) {
      properties[key] = prop(sourceProps, key);
    }
    if (typeof properties.name !== "string" || properties.name === "") continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: anchor },
      properties,
    });
  }
  return {
    type: "FeatureCollection",
    features,
    metadata: {
      source:
        `https://github.com/${MARINE_SOURCE_REPO}/blob/${MARINE_SOURCE_COMMIT}/${MARINE_SOURCE_FILE}`,
      sourceCommit: MARINE_SOURCE_COMMIT,
      license: MARINE_SOURCE_LICENSE,
      adoptedAttributes: [...MARINE_ADOPTED_ATTRIBUTES],
      sourceFeatureCount: source.features.length,
      targetFeatureCount: features.length,
    },
  } as FeatureCollection<Point>;
}

if (import.meta.main) {
  const response = await fetch(buildMarineSourceUrl());
  if (!response.ok) {
    throw new Error(`海域データ取得失敗: status ${response.status}`);
  }
  const output = buildMarineLabels(await response.json());
  await Deno.writeTextFile(MARINE_OUTPUT_PATH, JSON.stringify(output) + "\n");
  console.log(`${MARINE_OUTPUT_PATH}: ${output.features.length} features`);
}
