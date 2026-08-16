import type { FeatureCollection, Point } from "geojson";
import type { LabelColor, LabelDatum } from "./labels.ts";
import { MAX_LABEL_PRIORITY, MIN_LABEL_PRIORITY } from "./labels.ts";
import { MAX_ZOOM, MIN_ZOOM } from "./config.ts";

export const MARINE_DATA_URL = "/data/marine-labels.geojson";
export const MARINE_LABEL_COLOR: LabelColor = [72, 103, 120, 230];
export const MARINE_LABEL_SIZE_PX = 13;

export interface MarineLabelDatum extends LabelDatum {
  name: string;
  featureClass: string;
  minZoom: number;
  maxZoom: number;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Natural Earth の label 範囲をアプリの整数 z4〜z8 に写す。 */
export function marineLabelZoomRange(props: Record<string, unknown>): {
  minZoom: number;
  maxZoom: number;
} {
  return {
    minZoom: Math.max(MIN_ZOOM, Math.ceil(finite(props.min_label, MIN_ZOOM))),
    maxZoom: Math.min(MAX_ZOOM, Math.floor(finite(props.max_label, MAX_ZOOM))),
  };
}

export function marineLabelData(fc: FeatureCollection): MarineLabelDatum[] {
  const result: MarineLabelDatum[] = [];
  for (const feature of fc.features) {
    if (feature.geometry?.type !== "Point") continue;
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const name = typeof props.name === "string" ? props.name.trim() : "";
    if (!name) continue;
    const ja = typeof props.name_ja === "string" ? props.name_ja.trim() : "";
    const rank = finite(props.scalerank, 9);
    const { minZoom, maxZoom } = marineLabelZoomRange(props);
    if (minZoom > maxZoom) continue;
    result.push({
      name,
      text: ja || name,
      position: (feature.geometry as Point).coordinates as [number, number],
      featureClass: typeof props.featurecla === "string"
        ? props.featurecla
        : "marine",
      minZoom,
      maxZoom,
      priority: Math.max(
        MIN_LABEL_PRIORITY,
        Math.min(MAX_LABEL_PRIORITY, MAX_LABEL_PRIORITY - rank * 20),
      ),
    });
  }
  return result;
}

export function filterVisibleMarineLabels(
  labels: readonly MarineLabelDatum[],
  zoom: number,
): MarineLabelDatum[] {
  const step = Number.isFinite(zoom) ? Math.floor(zoom) : MIN_ZOOM;
  return labels.filter((label) =>
    step >= label.minZoom && step <= label.maxZoom
  );
}
