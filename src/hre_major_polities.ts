/**
 * HRE 主要領邦の期待値台帳と 3 段階表現の解決。
 *
 * 同年面 > 静的許可リストの借用面 > 境界未収録マーカー、の順をこのモジュール
 * だけで決める。最近傍年探索や last-observation-carried-forward は行わない。
 */
import type { Feature, FeatureCollection } from "geojson";
import ledgerJson from "../data/hre-major-polities.json" with { type: "json" };
import type { CitiesData } from "./cities.ts";
import type { Rgba } from "./powers.ts";

export const HRE_BOUNDARY_MARKER_LAYER_ID = "hre-boundary-unavailable";
export const HRE_BOUNDARY_LABEL_LAYER_ID = "hre-boundary-unavailable-labels";
export const HRE_BOUNDARY_MARKER_RADIUS_PX = 6;
export const HRE_BOUNDARY_MARKER_FILL_COLOR: Rgba = [235, 196, 88, 235];
export const HRE_BOUNDARY_MARKER_LINE_COLOR: Rgba = [92, 61, 34, 255];
export const HRE_BOUNDARY_LABEL_COLOR: [number, number, number, number] = [
  104,
  39,
  30,
  255,
];
export const HRE_BOUNDARY_LABEL_SIZE_PX = 12;

export type HreRepresentation =
  | "exact-polygon"
  | "borrowed-polygon"
  | "boundary-unavailable-marker";

export interface HreMajorPolityEntry {
  readonly id: string;
  readonly year: number;
  readonly nameEn: string;
  readonly nameJa: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly centerCity: string;
  readonly priority: number;
  readonly evidence: { readonly url: string; readonly note: string };
  readonly expectedRepresentation: HreRepresentation;
  readonly existence: { readonly from: number; readonly to: number };
  readonly suzerain: string;
  readonly limitationId: string;
  readonly missingReason: string;
}

export interface HreMajorPolityLedger {
  readonly schemaVersion: 1;
  readonly entries: readonly HreMajorPolityEntry[];
}

export interface BoundaryUnavailableMarker {
  readonly entry: HreMajorPolityEntry;
  readonly position: [number, number];
  readonly text: string;
  readonly priority: number;
}

export interface ResolvedHreMajorPolity {
  readonly entry: HreMajorPolityEntry;
  readonly representation: HreRepresentation;
  readonly feature: Feature | null;
  readonly marker: BoundaryUnavailableMarker | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`HRE主要領邦台帳: ${field} は空でない文字列が必要です`);
  }
  return value;
}

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`HRE主要領邦台帳: ${field} は整数が必要です`);
  }
  return value;
}

const REPRESENTATIONS = new Set<HreRepresentation>([
  "exact-polygon",
  "borrowed-polygon",
  "boundary-unavailable-marker",
]);

/** JSON の形、ID×年、alias、中心都市参照を決定的に検証する。 */
export function parseHreMajorPolityLedger(
  raw: unknown,
  knownCityNames?: ReadonlySet<string>,
): HreMajorPolityLedger {
  const root = record(raw);
  if (
    root === null || root.schemaVersion !== 1 || !Array.isArray(root.entries)
  ) {
    throw new Error(
      "HRE主要領邦台帳: schemaVersion=1 と entries 配列が必要です",
    );
  }
  const seen = new Set<string>();
  const entries = root.entries.map((item, index): HreMajorPolityEntry => {
    const v = record(item);
    if (v === null) {
      throw new Error(`HRE主要領邦台帳: entries[${index}] が不正です`);
    }
    const id = nonEmpty(v.id, `entries[${index}].id`);
    if (!/^[a-z0-9-]+$/.test(id)) {
      throw new Error(`HRE主要領邦台帳: ${id} は安定IDの語彙に適合しません`);
    }
    const year = integer(v.year, `${id}.year`);
    const key = `${year}:${id}`;
    if (seen.has(key)) {
      throw new Error(`HRE主要領邦台帳: ${key} が重複しています`);
    }
    seen.add(key);
    if (!Array.isArray(v.aliases) || v.aliases.length === 0) {
      throw new Error(`HRE主要領邦台帳: ${key}.aliases が空です`);
    }
    const aliases = v.aliases.map((alias, aliasIndex) =>
      nonEmpty(alias, `${key}.aliases[${aliasIndex}]`)
    );
    if (new Set(aliases).size !== aliases.length) {
      throw new Error(`HRE主要領邦台帳: ${key}.aliases が重複しています`);
    }
    const expectedRepresentation = v.expectedRepresentation;
    if (
      typeof expectedRepresentation !== "string" ||
      !REPRESENTATIONS.has(expectedRepresentation as HreRepresentation)
    ) {
      throw new Error(
        `HRE主要領邦台帳: ${key}.expectedRepresentation が不正です`,
      );
    }
    const centerCity = nonEmpty(v.centerCity, `${key}.centerCity`);
    if (knownCityNames !== undefined && !knownCityNames.has(centerCity)) {
      throw new Error(
        `HRE主要領邦台帳: ${key} の中心都市 ${centerCity} が cities.json にありません`,
      );
    }
    const evidence = record(v.evidence);
    const existence = record(v.existence);
    if (evidence === null || existence === null) {
      throw new Error(`HRE主要領邦台帳: ${key} の根拠または存続期間が不正です`);
    }
    const from = integer(existence.from, `${key}.existence.from`);
    const to = integer(existence.to, `${key}.existence.to`);
    if (from > year || to < year || from > to) {
      throw new Error(`HRE主要領邦台帳: ${key} の対象年が存続期間外です`);
    }
    const priority = integer(v.priority, `${key}.priority`);
    if (priority < 0) {
      throw new Error(`HRE主要領邦台帳: ${key}.priority が負です`);
    }
    return {
      id,
      year,
      nameEn: nonEmpty(v.nameEn, `${key}.nameEn`),
      nameJa: nonEmpty(v.nameJa, `${key}.nameJa`),
      title: nonEmpty(v.title, `${key}.title`),
      aliases,
      centerCity,
      priority,
      evidence: {
        url: nonEmpty(evidence.url, `${key}.evidence.url`),
        note: nonEmpty(evidence.note, `${key}.evidence.note`),
      },
      expectedRepresentation: expectedRepresentation as HreRepresentation,
      existence: { from, to },
      suzerain: nonEmpty(v.suzerain, `${key}.suzerain`),
      limitationId: nonEmpty(v.limitationId, `${key}.limitationId`),
      missingReason: nonEmpty(v.missingReason, `${key}.missingReason`),
    };
  });
  return { schemaVersion: 1, entries };
}

export const HRE_MAJOR_POLITY_LEDGER = parseHreMajorPolityLedger(
  ledgerJson as unknown,
);

/** cities.json の座標定義だけを読む。人口年次セルから座標は作らない。 */
export function cityCenters(
  data: CitiesData,
  requiredNames?: ReadonlySet<string>,
): Map<string, [number, number]> {
  const centers = new Map<string, [number, number]>();
  if (!Array.isArray(data.cities)) return centers;
  for (const value of data.cities) {
    const v = record(value);
    if (
      v !== null && typeof v.name === "string" &&
      typeof v.lon === "number" && Number.isFinite(v.lon) &&
      typeof v.lat === "number" && Number.isFinite(v.lat)
    ) {
      if (centers.has(v.name) && requiredNames?.has(v.name)) {
        throw new Error(`cities.json: 中心都市候補 ${v.name} が重複しています`);
      }
      if (!centers.has(v.name)) centers.set(v.name, [v.lon, v.lat]);
    }
  }
  return centers;
}

export function isBorrowedFeature(feature: Feature): boolean {
  return record(feature.properties?.BORROWED_FROM) !== null;
}

function namedMatches(
  entry: HreMajorPolityEntry,
  collections: readonly FeatureCollection[],
): Feature[] {
  const aliases = new Set(entry.aliases);
  return collections.flatMap((fc) =>
    fc.features.filter((feature) => {
      const name = feature.properties?.NAME;
      return typeof name === "string" && aliases.has(name);
    })
  );
}

/**
 * 1 エントリを必ず 1 状態へ解決する。同年面が後から追加されれば、借用面が同時に
 * 残っていても exact を選び、マーカーは生成しない。
 */
export function resolveHreMajorPolities(
  ledger: HreMajorPolityLedger,
  year: number,
  collections: readonly FeatureCollection[],
  cities: CitiesData,
): ResolvedHreMajorPolity[] {
  const yearEntries = ledger.entries.filter((entry) => entry.year === year);
  const centers = cityCenters(
    cities,
    new Set(yearEntries.map((entry) => entry.centerCity)),
  );
  return yearEntries.map((entry) => {
    const matches = namedMatches(entry, collections);
    const exactMatches = matches.filter((feature) =>
      !isBorrowedFeature(feature)
    );
    const borrowedMatches = matches.filter(isBorrowedFeature);
    if (exactMatches.length > 1) {
      throw new Error(
        `HRE主要領邦台帳: ${year}:${entry.id} の同年面が ${exactMatches.length} 件重複しています`,
      );
    }
    if (borrowedMatches.length > 1) {
      throw new Error(
        `HRE主要領邦台帳: ${year}:${entry.id} の借用面が ${borrowedMatches.length} 件重複しています`,
      );
    }
    const exact = exactMatches[0];
    if (exact !== undefined) {
      return {
        entry,
        representation: "exact-polygon",
        feature: exact,
        marker: null,
      };
    }
    const borrowed = borrowedMatches[0];
    if (borrowed !== undefined) {
      return {
        entry,
        representation: "borrowed-polygon",
        feature: borrowed,
        marker: null,
      };
    }
    const position = centers.get(entry.centerCity);
    // cities は任意起動データなので、未ロード中は一時的に marker を空にする。
    // 実データの参照完全性は schema テストで必須検証する。
    const marker = position === undefined ? null : {
      entry,
      position,
      text: `◇ ${entry.nameJa}（境界未収録）`,
      priority: entry.priority + 225,
    };
    return {
      entry,
      representation: "boundary-unavailable-marker",
      feature: null,
      marker,
    };
  });
}

export function boundaryUnavailableMarkers(
  ledger: HreMajorPolityLedger,
  year: number,
  collections: readonly FeatureCollection[],
  cities: CitiesData,
): BoundaryUnavailableMarker[] {
  return resolveHreMajorPolities(ledger, year, collections, cities)
    .flatMap((resolved) => resolved.marker === null ? [] : [resolved.marker]);
}

export function boundaryMarkerDescription(
  marker: BoundaryUnavailableMarker,
): string {
  const e = marker.entry;
  return [
    `称号: ${e.title}`,
    `存続期間: ${e.existence.from}–${e.existence.to}年`,
    `宗主勢力: ${e.suzerain}`,
    `中心都市: ${e.centerCity}`,
    `境界未収録: ${e.missingReason}`,
    `既知の制限: ${e.limitationId}`,
  ].join("\n");
}

export function boundaryMarkerTooltip(
  marker: BoundaryUnavailableMarker,
): string {
  return `${marker.text}\n${boundaryMarkerDescription(marker)}`;
}

/** 借用面の alpha を通常面より低くし、近似であることを面自体でも開示する。 */
export function approximateBorrowedColor(color: Rgba): Rgba {
  return [color[0], color[1], color[2], Math.min(color[3], 82)];
}

/** hover/click ツールチップへ借用元年・出典・ライセンス・理由を追加する。 */
export function borrowedBoundaryDescription(feature: Feature): string | null {
  const from = record(feature.properties?.BORROWED_FROM);
  if (from === null || typeof from.year !== "number") return null;
  const attribution = record(feature.properties?.ATTRIBUTION);
  const borrowedFrom =
    attribution !== null && Array.isArray(attribution.borrowedFrom)
      ? attribution.borrowedFrom.map(record).find((entry) =>
        entry?.name === feature.properties?.NAME
      ) ?? null
      : null;
  const source = attribution !== null && typeof attribution.source === "string"
    ? attribution.source
    : "借用元データセット";
  const license =
    attribution !== null && typeof attribution.license === "string"
      ? attribution.license
      : "ライセンスはアトリビューション参照";
  const reason =
    borrowedFrom !== null && typeof borrowedFrom.reason === "string"
      ? borrowedFrom.reason
      : "同年の境界面がなく、許可リストで確認済みの隣接年面を近似表示している。";
  return `近似境界（借用元: ${from.year}年）\n出典: ${source}\nライセンス: ${license}\n理由: ${reason}`;
}
