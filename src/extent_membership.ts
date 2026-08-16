/**
 * 上位政治圏の外枠所属データ契約（Issue #436）。
 *
 * SUBJECTO（情報・配色）、レイヤー種別、ラベルアンカーの包含関係から外枠を
 * 推定せず、data/extent-membership.json の明示レコードを feature properties の
 * EXTENT_KEY / EXTENT_ROLE へ付与する。base と専用 realm は元データ自身の宣言を
 * 機械的に正規化できるため、表はオーバーレイ 6 系統だけを列挙する。
 */

import type { FeatureCollection, GeoJsonProperties } from "geojson";
import membershipJson from "../data/extent-membership.json" with {
  type: "json",
};
import { createYearCache, type YearDataLoader } from "./powers.ts";
import {
  EXTENT_KEY_PROPERTY,
  EXTENT_ROLE_PROPERTY,
  type ExtentRole,
  resolveSuzerainKey,
  type SuzerainOverrides,
} from "./suzerain_extent.ts";

export type ExtentLayer =
  | "powers"
  | "hre"
  | "france"
  | "italy"
  | "cliopatria"
  | "britain"
  | "sovereign"
  | "realm";

export interface ExtentMembershipEntry {
  readonly year: number;
  readonly layer: Exclude<ExtentLayer, "powers" | "realm">;
  readonly name: string;
  readonly extentKey: string | null;
  readonly role: ExtentRole;
  readonly basis: string;
}

export interface ExtentMembershipTable {
  readonly version: 1;
  readonly entries: readonly ExtentMembershipEntry[];
}

export const EXTENT_MEMBERSHIP_TABLE = membershipJson as ExtentMembershipTable;

function nameOf(props: GeoJsonProperties): string | null {
  const name = props?.NAME;
  return typeof name === "string" && name !== "" ? name : null;
}

function entryId(year: number, layer: string, name: string): string {
  return `${year}\u0000${layer}\u0000${name}`;
}

const OVERLAY_LAYERS: readonly ExtentMembershipEntry["layer"][] = [
  "hre",
  "france",
  "italy",
  "cliopatria",
  "britain",
  "sovereign",
];

/** 表を検証して高速参照用 Map へ変換し、不正値・重複を fail-fast で検出する。 */
export function indexExtentMembership(
  table: ExtentMembershipTable = EXTENT_MEMBERSHIP_TABLE,
): ReadonlyMap<string, ExtentMembershipEntry> {
  if (table.version !== 1 || !Array.isArray(table.entries)) {
    throw new Error("外枠所属表の形式が不正です");
  }
  const index = new Map<string, ExtentMembershipEntry>();
  for (const entry of table.entries) {
    if (
      !Number.isInteger(entry.year) ||
      !OVERLAY_LAYERS.includes(entry.layer) ||
      typeof entry.name !== "string" || entry.name === "" ||
      typeof entry.basis !== "string" || entry.basis.trim() === "" ||
      !["self", "member", "mixed", "none"].includes(entry.role) ||
      ((entry.role === "member" || entry.role === "mixed") &&
        (typeof entry.extentKey !== "string" || entry.extentKey === "")) ||
      (entry.role === "none" && entry.extentKey !== null)
    ) {
      throw new Error(
        `外枠所属が不正です: ${entryId(entry.year, entry.layer, entry.name)}`,
      );
    }
    const id = entryId(entry.year, entry.layer, entry.name);
    if (index.has(id)) throw new Error(`外枠所属が重複しています: ${id}`);
    index.set(id, entry);
  }
  return index;
}

const DEFAULT_INDEX = indexExtentMembership();

/**
 * 1 年・1 レイヤーの feature へ明示的な外枠所属を付与する（純粋関数）。
 *
 * base は SUBJECTO の宣言（宗主補正適用後）を外枠契約へコピーするだけで、
 * 以後の描画は EXTENT_* だけを読む。realm は上位政治圏そのものなので self。
 * オーバーレイは例外表の完全一致だけを採用し、未登録は none にして誤った外枠を
 * 出さない。未登録自体は audit の CI ゲートが失敗させる。
 */
export function applyExtentMembership(
  fc: FeatureCollection,
  year: number,
  layer: ExtentLayer,
  overrides: SuzerainOverrides,
  index: ReadonlyMap<string, ExtentMembershipEntry> = DEFAULT_INDEX,
): FeatureCollection {
  let changed = false;
  const features = fc.features.map((feature) => {
    const name = nameOf(feature.properties);
    let key: string | null = null;
    let role: ExtentRole = "none";
    if (name !== null && layer === "powers") {
      key = resolveSuzerainKey(feature.properties, overrides);
      role = key === name ? "self" : "member";
    } else if (name !== null && layer === "realm") {
      key = name;
      role = "self";
    } else if (name !== null) {
      const entry = index.get(entryId(year, layer, name));
      if (entry !== undefined) {
        key = entry.extentKey;
        role = entry.role;
      } else if (
        typeof feature.properties?.SUBJECTO === "string" &&
        feature.properties.SUBJECTO !== ""
      ) {
        // HRE / Cliopatria / 借用面は生成物自身が宗主を明示している。
        key = resolveSuzerainKey(feature.properties, overrides);
        role = key === name ? "self" : "member";
      }
    }
    const currentKey = feature.properties?.[EXTENT_KEY_PROPERTY];
    const currentRole = feature.properties?.[EXTENT_ROLE_PROPERTY];
    if (currentKey === key && currentRole === role) return feature;
    changed = true;
    const properties: Record<string, unknown> = {
      ...feature.properties,
      [EXTENT_ROLE_PROPERTY]: role,
    };
    if (key === null) delete properties[EXTENT_KEY_PROPERTY];
    else properties[EXTENT_KEY_PROPERTY] = key;
    return { ...feature, properties };
  });
  return changed ? { ...fc, features } : fc;
}

/** YearDataLoader の取得結果へ外枠契約を 1 年 1 回だけ付与する。 */
export function withExtentMembership(
  loader: YearDataLoader,
  layer: ExtentLayer,
  getOverrides: () => Promise<SuzerainOverrides>,
): YearDataLoader {
  const cache = createYearCache<FeatureCollection>();
  const inflight = new Map<number, Promise<FeatureCollection>>();
  return {
    has: (year) => cache.has(year),
    load(year) {
      const cached = cache.get(year);
      if (cached !== undefined) return Promise.resolve(cached);
      const running = inflight.get(year);
      if (running !== undefined) return running;
      const promise = Promise.all([loader.load(year), getOverrides()])
        .then(([fc, overrides]) => {
          const result = applyExtentMembership(fc, year, layer, overrides);
          cache.set(year, result);
          return result;
        })
        .finally(() => inflight.delete(year));
      inflight.set(year, promise);
      return promise;
    },
  };
}
