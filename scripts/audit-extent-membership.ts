/**
 * 全年代・全オーバーレイの上位政治圏外枠監査（Issue #436）。
 *
 * 実行: deno task audit-extent-membership
 * 出力: .outputs/extent-membership-audit.json
 */

import area from "@turf/area";
import difference from "@turf/difference";
import union from "@turf/union";
import { featureCollection } from "@turf/helpers";
import type {
  Feature,
  FeatureCollection,
  MultiPolygon,
  Polygon,
  Position,
} from "geojson";
import {
  BORROWED_HRE_OVERLAY_YEARS,
  BORROWED_ITALY_FIEF_OVERLAY_YEARS,
  BRITAIN_FIEF_OVERLAY_YEARS,
  CLIOPATRIA_FIEF_OVERLAY_YEARS,
  FRANCE_FIEF_OVERLAY_YEARS,
  HRE_ALL_OVERLAY_YEARS,
  HRE_FIEF_OVERLAY_YEARS,
  HRE_REALM_YEARS,
  ITALY_FIEF_OVERLAY_YEARS,
  SNAPSHOT_YEARS,
  SOVEREIGN_FIEF_OVERLAY_YEARS,
} from "../src/config.ts";
import {
  applyExtentMembership,
  EXTENT_MEMBERSHIP_TABLE,
  type ExtentLayer,
  type ExtentMembershipEntry,
  indexExtentMembership,
} from "../src/extent_membership.ts";
import {
  buildSuzerainExtent,
  type ExtentRole,
  parseSuzerainOverrides,
  resolveExtentMembership,
} from "../src/suzerain_extent.ts";
import { coastalBandsForSuzerain } from "../src/coastal_fill.ts";
import { hreDataUrlFor } from "../src/powers.ts";

type Poly = Feature<Polygon | MultiPolygon>;

export const WARN_OUTSIDE_KM2 = 1;
export const FAIL_OUTSIDE_KM2 = 100;
export const FAIL_OUTSIDE_RATIO = 0.01;
export const AUDIT_OUTPUT_PATH = ".outputs/extent-membership-audit.json";

export interface ExtentException {
  readonly year: number;
  readonly layer: string;
  readonly name: string;
  readonly extentKey: string;
  readonly classification: "mixed" | "source-difference";
  readonly maxOutsideKm2: number;
  readonly evidence: string;
  readonly sourceUrl?: string;
}

interface ExceptionFile {
  readonly version: 1;
  readonly exceptions: readonly ExtentException[];
}

export interface AuditRow {
  readonly year: number;
  readonly layer: string;
  readonly name: string;
  readonly extentKey: string | null;
  readonly extentRole: ExtentRole;
  readonly featureAreaKm2: number;
  readonly outsideAreaKm2: number;
  readonly outsideRatio: number;
  readonly outsideBbox: [number, number, number, number] | null;
  readonly severity: "ok" | "warning" | "failure";
  readonly classification: "conforming" | "mixed" | "source-difference" | null;
  readonly registeredException: boolean;
  readonly error: string | null;
}

export interface AuditReport {
  readonly version: 1;
  readonly thresholds: {
    readonly warningOutsideKm2: number;
    readonly failureOutsideKm2: number;
    readonly failureOutsideRatio: number;
  };
  readonly rows: readonly AuditRow[];
  readonly summary: {
    readonly featureYears: number;
    readonly warnings: number;
    readonly failures: number;
    readonly unresolved: number;
    readonly significantOutside: number;
  };
}

interface LayerDef {
  readonly layer: Exclude<ExtentLayer, "powers" | "realm">;
  readonly years: readonly number[];
  readonly pathFor: (year: number) => string;
}

const LAYERS: readonly LayerDef[] = [
  {
    layer: "hre",
    years: HRE_ALL_OVERLAY_YEARS,
    pathFor: (year) => `.${hreDataUrlFor(year, HRE_FIEF_OVERLAY_YEARS)}`,
  },
  {
    layer: "france",
    years: FRANCE_FIEF_OVERLAY_YEARS,
    pathFor: (year) => `data/france_fiefs_flat_${year}.geojson`,
  },
  {
    layer: "italy",
    years: ITALY_FIEF_OVERLAY_YEARS,
    pathFor: (year) => `data/italy_fiefs_flat_${year}.geojson`,
  },
  {
    layer: "cliopatria",
    years: CLIOPATRIA_FIEF_OVERLAY_YEARS,
    pathFor: (year) => `data/cliopatria_fiefs_flat_${year}.geojson`,
  },
  {
    layer: "britain",
    years: BRITAIN_FIEF_OVERLAY_YEARS,
    pathFor: (year) => `data/britain_fiefs_flat_${year}.geojson`,
  },
  {
    layer: "sovereign",
    years: SOVEREIGN_FIEF_OVERLAY_YEARS,
    pathFor: (year) => `data/sovereign_fiefs_flat_${year}.geojson`,
  },
];

async function readCollection(path: string): Promise<FeatureCollection> {
  return JSON.parse(await Deno.readTextFile(path)) as FeatureCollection;
}

function polygon(feature: Feature): feature is Poly {
  return feature.geometry?.type === "Polygon" ||
    feature.geometry?.type === "MultiPolygon";
}

function mergeExtent(fc: FeatureCollection): Poly | null {
  const polys = fc.features.filter(polygon);
  if (polys.length === 0) return null;
  if (polys.length === 1) return polys[0];
  try {
    return union(featureCollection(polys)) as Poly | null;
  } catch {
    return null;
  }
}

function bboxOf(feature: Poly | null): [number, number, number, number] | null {
  if (feature === null) return null;
  const positions: Position[] = [];
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (
      value.length >= 2 && typeof value[0] === "number" &&
      typeof value[1] === "number"
    ) {
      positions.push(value as Position);
      return;
    }
    for (const child of value) visit(child);
  };
  visit(feature.geometry.coordinates);
  if (positions.length === 0) return null;
  return [
    Math.min(...positions.map((p) => p[0])),
    Math.min(...positions.map((p) => p[1])),
    Math.max(...positions.map((p) => p[0])),
    Math.max(...positions.map((p) => p[1])),
  ];
}

function exceptionId(year: number, layer: string, name: string): string {
  return `${year}\u0000${layer}\u0000${name}`;
}

function entryId(entry: ExtentMembershipEntry): string {
  return exceptionId(entry.year, entry.layer, entry.name);
}

export async function auditExtentMembership(): Promise<AuditReport> {
  const overrides = parseSuzerainOverrides(
    JSON.parse(await Deno.readTextFile("data/name-overrides.json")),
  );
  const exceptionFile = JSON.parse(
    await Deno.readTextFile("data/extent-exceptions.json"),
  ) as ExceptionFile;
  if (exceptionFile.version !== 1 || !Array.isArray(exceptionFile.exceptions)) {
    throw new Error("extent exception table is invalid");
  }
  for (const entry of exceptionFile.exceptions) {
    if (
      !Number.isInteger(entry.year) ||
      !LAYERS.some((def) => def.layer === entry.layer) ||
      typeof entry.name !== "string" || entry.name === "" ||
      typeof entry.extentKey !== "string" || entry.extentKey === "" ||
      !["mixed", "source-difference"].includes(entry.classification) ||
      !Number.isFinite(entry.maxOutsideKm2) || entry.maxOutsideKm2 < 0 ||
      typeof entry.evidence !== "string" || entry.evidence.trim() === "" ||
      (entry.classification === "mixed" &&
        (entry.sourceUrl?.trim() ?? "") === "")
    ) {
      throw new Error(
        `extent exception is invalid: ${
          exceptionId(entry.year, entry.layer, entry.name)
        }`,
      );
    }
  }
  const declaredExceptionIds = exceptionFile.exceptions.map((entry) =>
    exceptionId(entry.year, entry.layer, entry.name)
  );
  const exceptions = new Map(
    exceptionFile.exceptions.map((entry) => [
      exceptionId(entry.year, entry.layer, entry.name),
      entry,
    ]),
  );
  if (exceptions.size !== declaredExceptionIds.length) {
    throw new Error("duplicate extent exception");
  }
  const membershipIndex = indexExtentMembership(EXTENT_MEMBERSHIP_TABLE);
  const declaredEntries = new Set(EXTENT_MEMBERSHIP_TABLE.entries.map(entryId));
  const seenEntries = new Set<string>();
  const rows: AuditRow[] = [];

  for (const year of SNAPSHOT_YEARS) {
    const baseRaw = await readCollection(`data/europe_${year}.geojson`);
    const base = applyExtentMembership(
      baseRaw,
      year,
      "powers",
      overrides,
      membershipIndex,
    );
    const coastal = await readCollection(`data/coastal_fill_${year}.geojson`);
    const realm = HRE_REALM_YEARS.includes(year)
      ? applyExtentMembership(
        await readCollection(`data/hre_realm_${year}.geojson`),
        year,
        "realm",
        overrides,
        membershipIndex,
      )
      : null;

    for (const def of LAYERS) {
      if (!def.years.includes(year)) continue;
      const raw = await readCollection(def.pathFor(year));
      if (def.layer === "hre" && BORROWED_HRE_OVERLAY_YEARS.includes(year)) {
        raw.features.push(
          ...(await readCollection(`data/borrowed_hre_flat_${year}.geojson`))
            .features,
        );
      }
      if (
        def.layer === "italy" &&
        BORROWED_ITALY_FIEF_OVERLAY_YEARS.includes(year)
      ) {
        raw.features.push(
          ...(await readCollection(`data/borrowed_italy_flat_${year}.geojson`))
            .features,
        );
      }
      const data = applyExtentMembership(
        raw,
        year,
        def.layer,
        overrides,
        membershipIndex,
      );
      for (const feature of data.features) {
        if (!polygon(feature)) continue;
        const name = feature.properties?.NAME;
        if (typeof name !== "string" || name === "") continue;
        const id = exceptionId(year, def.layer, name);
        seenEntries.add(id);
        const membership = resolveExtentMembership(
          feature.properties,
          overrides,
        );
        const featureAreaKm2 = area(feature) / 1e6;
        let error: string | null = null;
        if (!declaredEntries.has(id)) error = "membership-not-registered";
        if (membership.role !== "none" && membership.key === null) {
          error = "extent-key-unresolved";
        }

        let extent: Poly | null = null;
        if (membership.role === "self") {
          extent = feature;
        } else if (membership.key !== null && membership.role !== "none") {
          extent = mergeExtent(buildSuzerainExtent(
            base,
            membership.key,
            overrides,
            {
              base,
              bands: coastal,
              select: coastalBandsForSuzerain,
            },
            realm,
          ));
          if (extent === null) error = "extent-geometry-unresolved";
        }

        let outside: Poly | null = null;
        if (extent !== null && membership.role !== "self") {
          try {
            outside = difference(featureCollection([feature, extent])) as
              | Poly
              | null;
          } catch {
            error = "difference-failed";
          }
        }
        const outsideAreaKm2 = outside === null ? 0 : area(outside) / 1e6;
        const outsideRatio = featureAreaKm2 === 0
          ? 0
          : outsideAreaKm2 / featureAreaKm2;
        const significant = outsideAreaKm2 >= FAIL_OUTSIDE_KM2 &&
          outsideRatio >= FAIL_OUTSIDE_RATIO;
        const exception = exceptions.get(id);
        const exceptionValid = exception !== undefined &&
          exception.extentKey === membership.key &&
          outsideAreaKm2 <= exception.maxOutsideKm2;
        if (
          membership.role === "mixed" && exception?.classification !== "mixed"
        ) {
          error = "mixed-exception-required";
        }
        if (
          exception?.classification === "mixed" && membership.role !== "mixed"
        ) {
          error = "mixed-role-required";
        }
        const failure = error !== null || (significant && !exceptionValid);
        rows.push({
          year,
          layer: def.layer,
          name,
          extentKey: membership.key,
          extentRole: membership.role,
          featureAreaKm2,
          outsideAreaKm2,
          outsideRatio,
          outsideBbox: bboxOf(outside),
          severity: failure
            ? "failure"
            : outsideAreaKm2 >= WARN_OUTSIDE_KM2
            ? "warning"
            : "ok",
          classification: exception?.classification ??
            (outsideAreaKm2 < WARN_OUTSIDE_KM2 ? "conforming" : null),
          registeredException: exceptionValid,
          error,
        });
      }
    }
  }

  for (const entry of declaredEntries) {
    if (seenEntries.has(entry)) continue;
    const [year, layer, name] = entry.split("\u0000");
    rows.push({
      year: Number(year),
      layer,
      name,
      extentKey: null,
      extentRole: "none",
      featureAreaKm2: 0,
      outsideAreaKm2: 0,
      outsideRatio: 0,
      outsideBbox: null,
      severity: "failure",
      classification: null,
      registeredException: false,
      error: "membership-entry-has-no-feature",
    });
  }

  const staleExceptions = declaredExceptionIds.filter((id) =>
    !seenEntries.has(id)
  );
  if (staleExceptions.length > 0) {
    throw new Error(
      `extent exception has no feature: ${staleExceptions.join(", ")}`,
    );
  }

  return {
    version: 1,
    thresholds: {
      warningOutsideKm2: WARN_OUTSIDE_KM2,
      failureOutsideKm2: FAIL_OUTSIDE_KM2,
      failureOutsideRatio: FAIL_OUTSIDE_RATIO,
    },
    rows,
    summary: {
      featureYears: rows.length,
      warnings: rows.filter((row) => row.severity === "warning").length,
      failures: rows.filter((row) => row.severity === "failure").length,
      unresolved:
        rows.filter((row) => row.error?.includes("unresolved")).length,
      significantOutside:
        rows.filter((row) =>
          row.outsideAreaKm2 >= FAIL_OUTSIDE_KM2 &&
          row.outsideRatio >= FAIL_OUTSIDE_RATIO
        ).length,
    },
  };
}

if (import.meta.main) {
  const report = await auditExtentMembership();
  await Deno.mkdir(".outputs", { recursive: true });
  await Deno.writeTextFile(
    AUDIT_OUTPUT_PATH,
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report.summary));
  if (report.summary.failures > 0) Deno.exit(1);
}
