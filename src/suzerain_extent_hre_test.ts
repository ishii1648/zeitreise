/**
 * 後期 HRE（1715 / 1783 / 1800）の勢力圏外枠が、その年代に神聖ローマ帝国を
 * 構成する領域全体を囲むことを**実データ**で固定する（#332）。
 *
 * 代表地点だけでは「一部の領邦を足して終わり」の部分修正を検出できないため、
 * 検証は次の 4 系統を組み合わせる（Issue #332 AC3）。
 * 1. 面積（外枠 union の球面近似面積の下限・上限）
 * 2. feature 集合（HRE 領邦オーバーレイの全 feature が外枠に覆われること・
 *    base の帝国構成 feature が過半被覆されること）
 * 3. 代表地点（非網羅的な回帰検知点。AC1）
 * 4. 帝国外の除外（同じ君主・王朝に属していても帝国外は含めない。AC4）
 */

import { assert, assertEquals } from "@std/assert";
import area from "@turf/area";
import intersect from "@turf/intersect";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { featureCollection } from "@turf/helpers";
import type {
  Feature,
  FeatureCollection,
  MultiPolygon,
  Polygon,
} from "geojson";
import {
  buildSuzerainExtent,
  extractSuzerainMembers,
  parseSuzerainOverrides,
  type SuzerainOverrides,
} from "./suzerain_extent.ts";
import { HRE_REALM_YEARS } from "./config.ts";
import { hreRealmDataUrlFor } from "./powers.ts";

/** 宗主キー（base の NAME / オーバーレイの SUBJECTO と同値） */
const HRE_KEY = "Holy Roman Empire";

/** 本 Issue の対象年（帝国解体は 1806 年なので 1815 以降は対象外） */
const LATE_HRE_YEARS = [1715, 1783, 1800] as const;

type Poly = Feature<Polygon | MultiPolygon>;

async function readCollection(path: string): Promise<FeatureCollection> {
  return JSON.parse(await Deno.readTextFile(path)) as FeatureCollection;
}

async function realOverrides(): Promise<SuzerainOverrides> {
  return parseSuzerainOverrides(
    JSON.parse(await Deno.readTextFile("data/name-overrides.json")),
  );
}

function polygonsOnly(features: Feature[]): Poly[] {
  return features.filter((f): f is Poly =>
    f.geometry !== null &&
    (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")
  );
}

/** km² */
function km2(f: Poly | FeatureCollection): number {
  return area(f) / 1e6;
}

/** feature のうち extent に覆われている面積の割合（0〜1） */
function coveredFraction(f: Poly, extent: Poly[]): number {
  const total = area(f);
  if (total === 0) return 0;
  let covered = 0;
  for (const part of extent) {
    const hit = intersect(featureCollection([f, part]));
    if (hit !== null) covered += area(hit);
  }
  return covered / total;
}

function insideAny(point: [number, number], extent: Poly[]): boolean {
  return extent.some((f) => booleanPointInPolygon(point, f.geometry));
}

/**
 * アプリと同じ入力規則で HRE の外枠を組み立てる。
 * base（europe_<year>）に加えて、後期 HRE は帝国全域の出典付きジオメトリ
 * （hre_realm_<year>、OHM の admin_level=2 帝国境界）も入力になる。
 */
async function hreExtent(year: number): Promise<Poly[]> {
  const overrides = await realOverrides();
  const base = await readCollection(`data/europe_${year}.geojson`);
  const realm = HRE_REALM_YEARS.includes(year)
    ? await readCollection(`data/hre_realm_${year}.geojson`)
    : null;
  return polygonsOnly(
    buildSuzerainExtent(base, HRE_KEY, overrides, null, realm).features,
  );
}

/**
 * 外枠面積の下限（km²）。OHM の帝国境界（実測: 1715 = 689,321 /
 * 1783 = 638,317 / 1800 = 563,471 km²）に対して、簡略化と union の誤差ぶんの
 * 余裕を取った値。base の残余 HRE ポリゴンだけ（1715 = 236,580 km²、
 * 1783 / 1800 = 0）では到底届かない水準に置く。
 */
const MIN_EXTENT_KM2: Record<number, number> = {
  1715: 650_000,
  1783: 600_000,
  1800: 530_000,
};

/**
 * 外枠面積の上限（km²）。ハンガリー王国（約 320,000 km²）や東プロイセンを
 * 丸ごと巻き込むと必ず超える水準に置く（AC4 の面積側の担保）。
 */
const MAX_EXTENT_KM2: Record<number, number> = {
  1715: 820_000,
  1783: 780_000,
  1800: 700_000,
};

/**
 * 帝国内の代表地点（非網羅的な回帰検知点。AC1）。
 * 1715 年に base が別勢力として塗る領域（ベルリン = Brandenburg/Prussia、
 * ウィーン・プラハ = Austrian Empire）を含む。
 */
const INSIDE_POINTS: Record<string, [number, number]> = {
  ベルリン: [13.405, 52.52],
  ウィーン: [16.373, 48.208],
  プラハ: [14.42, 50.088],
  ミュンヘン: [11.58, 48.14],
  ハンブルク: [9.99, 53.55],
  ドレスデン: [13.74, 51.05],
  ザルツブルク: [13.05, 47.8],
};

/**
 * 帝国外の代表地点（非網羅的な除外確認例。AC4）。
 * ブダペシュト・デブレツェンはハンガリー王国、ケーニヒスベルクは
 * プロイセン王国の帝国外領、リヴィウはガリツィア（1772 年以降オーストリア領
 * だが帝国外）。いずれも「同じ君主・王朝に属していても帝国外」の例。
 */
const OUTSIDE_POINTS: Record<string, [number, number]> = {
  ブダペシュト: [19.04, 47.498],
  デブレツェン: [21.63, 47.53],
  ケーニヒスベルク: [20.51, 54.71],
  リヴィウ: [24.03, 49.84],
  ザグレブ: [15.98, 45.81],
  ワルシャワ: [21.01, 52.23],
  パリ: [2.35, 48.86],
  アムステルダム: [4.9, 52.37],
  ベルン: [7.45, 46.95],
  コペンハーゲン: [12.57, 55.68],
};

/**
 * 各年の base で「帝国構成領域として外枠に入るべき」勢力（NAME）。
 * base の勢力一覧から史実で帝国等族と確定するものを網羅的に挙げたもので、
 * 代表例に絞っていない（Issue #332 が禁じる部分修正の検出）。
 * 帝国内外にまたがる Austrian Empire / Prussia は別途 STRADDLING_COVERAGE で扱う。
 */
const REQUIRED_BASE_MEMBERS: Record<number, readonly string[]> = {
  1715: [
    "Baden",
    "Brandenburg",
    "Bremen",
    "Hamburg",
    "Hanover",
    "Hohenzollern",
    "Holy Roman Empire",
    "Lübeck",
    "Oldenburg",
  ],
  1783: [
    "Anhalt",
    "Baden",
    "Bavaria",
    "Bremen",
    "Brunswick",
    "Cuxhaven",
    "Hamburg",
    "Hanover",
    "Hohenzollern",
    "Lippe-Detmold",
    "Lübeck",
    "Mecklenburg-Schwerin",
    "Mecklenburg-Strelitz",
    "Oldenburg",
    "Saxony",
    "Schaumburg-Lippe",
    "Thuringia",
    "Waldeck",
    "Württemberg",
  ],
  1800: [
    "Anhalt",
    "Baden",
    "Bavaria",
    "Bremen",
    "Brunswick",
    "Hamburg",
    "Hanover",
    "Hohenzollern",
    "Lippe-Detmold",
    "Lübeck",
    "Mecklenburg-Schwerin",
    "Mecklenburg-Strelitz",
    "Oldenburg",
    "Saxony",
    "Schaumburg-Lippe",
    "Swabia",
    "Thuringia",
    "Waldeck",
    "Württemberg",
  ],
};

/**
 * 外枠に過半（面積の 50% 以上）が入る base 勢力の**完全な集合**（NAME 昇順・
 * 重複除去）。実測を固定したもので、AC3 の「既知の代表例だけを追加する部分
 * 修正になっていないこと」を件数と集合の同一性で押さえる。
 *
 * ここに現れないことも意味を持つ: Austrian Empire（ハンガリー・ガリツィアを
 * 含むため 1715 = 39% / 1783・1800 = 31%）・Kingdom of Sardinia・Venetia・
 * Swiss Confederation などは過半に届かず、帝国外の領域が巻き込まれていない
 * ことを示す。
 */
const MAJORITY_COVERED_BASE_POWERS: Record<number, readonly string[]> = {
  1715: [
    "Austrian Netherlands",
    "Baden",
    "Brandenburg",
    "Bremen",
    "Hamburg",
    "Hanover",
    "Hohenzollern",
    "Holy Roman Empire",
    "Luxembourg",
    "Lübeck",
    "Oldenburg",
  ],
  1783: [
    "Anhalt",
    "Austrian Netherlands",
    "Baden",
    "Bavaria",
    "Bremen",
    "Brunswick",
    "Cuxhaven",
    "Hamburg",
    "Hanover",
    "Hohenzollern",
    "Holstein",
    "Lippe-Detmold",
    "Luxembourg",
    "Lübeck",
    "Mecklenburg-Schwerin",
    "Mecklenburg-Strelitz",
    "Oldenburg",
    "Prussia",
    "Saxony",
    "Schaumburg-Lippe",
    "Thuringia",
    "Waldeck",
    "Württemberg",
  ],
  1800: [
    "Anhalt",
    "Baden",
    "Bavaria",
    "Bremen",
    "Brunswick",
    "Cuxhaven",
    "Hamburg",
    "Hanover",
    "Hohenzollern",
    "Holstein",
    "Lippe-Detmold",
    "Lübeck",
    "Mecklenburg-Schwerin",
    "Mecklenburg-Strelitz",
    "Oldenburg",
    "Saxony",
    "Schaumburg-Lippe",
    "Swabia",
    "Thuringia",
    "Waldeck",
    "Württemberg",
  ],
};

/**
 * 帝国内外にまたがる base 勢力の被覆率の許容範囲 [下限, 上限]（AC4 の面差分側）。
 *
 * - Austrian Empire: オーストリア大公領・ボヘミア・シュレージエン等は帝国内、
 *   ハンガリー王冠領・ガリツィア（1772〜）は帝国外。丸ごと入れれば 1.0 に、
 *   まったく入れなければ 0 になるので、その中間にあること自体が
 *   「帝国内だけを採っている」ことの証拠になる（実測 1715 = 0.39 /
 *   1783 = 0.31 / 1800 = 0.31）。
 * - Prussia: ブランデンブルクは帝国内、東プロイセンは帝国外。1715 年は base が
 *   帝国内側を Brandenburg という別 feature に分けているため、NAME=Prussia の
 *   feature は帝国外だけになり被覆率がほぼ 0 になる（実測 0 未満 1%）。
 *   1783 / 1800 は 2 feature の合算（実測 0.58 / 0.27）。
 */
const STRADDLING_COVERAGE: Record<
  number,
  Readonly<Record<string, readonly [number, number]>>
> = {
  1715: {
    "Austrian Empire": [0.3, 0.5],
    "Prussia": [0, 0.01],
  },
  1783: {
    "Austrian Empire": [0.25, 0.4],
    "Prussia": [0.45, 0.7],
  },
  1800: {
    "Austrian Empire": [0.25, 0.4],
    "Prussia": [0.15, 0.4],
  },
};

/**
 * 帝国外の勢力（NAME）と、外枠と重なってよい面積割合の上限。
 * 既定は 0.01（実質ゼロ）。上流どうしの境界解釈が食い違う区画だけを、
 * 根拠つきで個別に緩める。
 *
 * 個別緩和の実測（被覆率 = 重複面積 / 各 base 勢力の全面積）:
 * - 1715 France: 0.030377 = 16,490 / 542,845 km²。ロレーヌ公領・バロワ
 * （中心 6.20,48.54 / 5.83,49.28）とモンベリアール伯領（7.16,47.34）で、
 * いずれも 1766 年のロレーヌ併合まで帝国のフェーフである。OHM の帝国境界は
 * これらを帝国内に描き、base（historical-basemaps）は France 色で塗るという
 * 上流間の食い違いで、外枠側は出典（OHM）の解釈に従う。1783 / 1800 年は
 * base 側も France に確定しており重なりは 1% 未満。
 * - 1715 Dutch Republic: 0.078442 = 2,588 / 32,991 km²、1783 Netherlands:
 *   0.078395 = 2,586 / 32,991 km²。リンブルフ等、低地地方の帝国領を一体化した
 *   base ポリゴンと OHM 帝国境界の帰属差を 0.10 の上限で固定する。
 * - 1715 Sweden: 0.015925 = 14,515 / 911,436 km²。スウェーデン領ポメラニア等の
 *   帝国領を含むため 0.02 の上限で固定する。
 * - 1800 Batavian Republic: 0.014156 = 512 / 36,181 km²。ライン左岸付近の
 *   境界解釈差を 0.05 の上限で固定する。
 */
const FOREIGN_MAX_COVERAGE: Record<
  number,
  Readonly<Record<string, number>>
> = {
  1715: {
    "France": 0.05,
    "Ottoman Empire": 0.01,
    "Polish–Lithuanian Commonwealth": 0.01,
    "Spain": 0.01,
    "Portugal": 0.01,
    "Sweden": 0.02,
    "Denmark-Norway": 0.01,
    "Dutch Republic": 0.1,
    "United Kingdom": 0.01,
    "Papal States": 0.01,
    "Tsardom of Muscovy": 0.01,
  },
  1783: {
    "France": 0.01,
    "Ottoman Empire": 0.01,
    "Poland": 0.01,
    "Spain": 0.01,
    "Portugal": 0.01,
    "Sweden": 0.01,
    "Denmark-Norway": 0.01,
    "Netherlands": 0.1,
    "United Kingdom": 0.01,
    "Papal States": 0.01,
    "Russian Empire": 0.01,
  },
  1800: {
    "France": 0.01,
    "Ottoman Empire": 0.01,
    "Spain": 0.01,
    "Portugal": 0.01,
    "Sweden": 0.01,
    "Denmark-Norway": 0.01,
    "Batavian Republic": 0.05,
    "United Kingdom": 0.01,
    "Papal States": 0.01,
    "Russian Empire": 0.01,
  },
};

/**
 * 領邦オーバーレイ feature の被覆率の下限。既定は 0.99（簡略化差ぶんの余裕）。
 * 帝国外に飛び地を持つ領邦だけ、根拠つきで個別に下げる。
 *
 * - 1783 Hesse-Darmstadt（実測 0.872）: 外れる 617 km² は経度 7.4〜8.0 /
 *   緯度 48.7〜49.0 に集まる。1736 年にハーナウ＝リヒテンベルク伯領として
 *   継承した**アルザスの飛び地**で、アルザスは 1648 / 1697 年以降フランス領
 *   （＝帝国外）である。Issue #332 の「同じ君主に属していても帝国外の領域は
 *   含めない」がそのまま当てはまるため、覆わないのが正しい。
 * - 1800 Nassau-Weilburg（実測 0.965）: 外れる 15 km² はどのパートも
 *   20 km² 未満に散る縁の差で、1797 年カンポ・フォルミオ以降フランスが
 *   占めるライン左岸との境界の簡略化差。
 */
const FIEF_COVERAGE_MIN: Record<
  number,
  Readonly<Record<string, number>>
> = {
  1715: {},
  1783: { "Hesse-Darmstadt": 0.85 },
  1800: { "Nassau-Weilburg": 0.95 },
};

/** base 勢力 NAME → 外枠に覆われた面積割合（同名 feature は面積で加重合算） */
async function baseCoverageByName(
  year: number,
  extent: Poly[],
): Promise<Map<string, number>> {
  const base = await readCollection(`data/europe_${year}.geojson`);
  const totals = new Map<string, number>();
  const covered = new Map<string, number>();
  for (const f of polygonsOnly(base.features)) {
    const name = typeof f.properties?.NAME === "string"
      ? f.properties.NAME
      : null;
    if (name === null) continue;
    const size = area(f);
    totals.set(name, (totals.get(name) ?? 0) + size);
    covered.set(
      name,
      (covered.get(name) ?? 0) + coveredFraction(f, extent) * size,
    );
  }
  const out = new Map<string, number>();
  for (const [name, total] of totals) {
    out.set(name, total === 0 ? 0 : (covered.get(name) ?? 0) / total);
  }
  return out;
}

for (const year of LATE_HRE_YEARS) {
  Deno.test(`実データ: ${year} 年の HRE 外枠が帝国の構成領域全体を囲む（面積）`, async () => {
    const extent = await hreExtent(year);
    assert(extent.length > 0, `${year}: 外枠が空`);
    const total = extent.reduce((sum, f) => sum + km2(f), 0);
    assert(
      total >= MIN_EXTENT_KM2[year],
      `${year}: 外枠面積 ${Math.round(total)} km² が下限 ${
        MIN_EXTENT_KM2[year]
      } km² に満たない`,
    );
    assert(
      total <= MAX_EXTENT_KM2[year],
      `${year}: 外枠面積 ${Math.round(total)} km² が上限 ${
        MAX_EXTENT_KM2[year]
      } km² を超える（帝国外を巻き込んでいる疑い）`,
    );
  });

  Deno.test(`実データ: ${year} 年の HRE 外枠が代表地点を含み帝国外を含まない`, async () => {
    const extent = await hreExtent(year);
    for (const [name, point] of Object.entries(INSIDE_POINTS)) {
      assert(insideAny(point, extent), `${year}: ${name} が外枠に入っていない`);
    }
    for (const [name, point] of Object.entries(OUTSIDE_POINTS)) {
      assert(
        !insideAny(point, extent),
        `${year}: 帝国外の ${name} が外枠に入っている`,
      );
    }
  });

  Deno.test(`実データ: ${year} 年の HRE 外枠が領邦オーバーレイ全 feature を覆う`, async () => {
    const extent = await hreExtent(year);
    const fiefs = await readCollection(`data/hre_fiefs_flat_${year}.geojson`);
    const parts = polygonsOnly(fiefs.features);
    assert(parts.length > 0, `${year}: 領邦オーバーレイが空`);
    for (const f of parts) {
      const name = String(f.properties?.NAME);
      const min = FIEF_COVERAGE_MIN[year][name] ?? 0.99;
      const fraction = coveredFraction(f, extent);
      assert(
        fraction >= min,
        `${year}: 領邦 ${name} の被覆率が ${
          fraction.toFixed(3)
        }（${min} 未満）`,
      );
    }
  });

  Deno.test(`実データ: ${year} 年の HRE 外枠が base の帝国構成勢力を網羅する`, async () => {
    const extent = await hreExtent(year);
    const coverage = await baseCoverageByName(year, extent);
    // (1) 史実で帝国等族と確定する base 勢力は必ず過半が入る
    for (const name of REQUIRED_BASE_MEMBERS[year]) {
      const fraction = coverage.get(name);
      assert(fraction !== undefined, `${year}: base に ${name} が無い`);
      assert(
        fraction >= 0.5,
        `${year}: 帝国構成勢力 ${name} の被覆率が ${
          fraction.toFixed(3)
        }（0.5 未満）`,
      );
    }
    // (2) 過半が入る base 勢力の集合そのものを固定する。代表領邦だけを足した
    //     部分修正なら集合が縮み、帝国外を巻き込めば集合が広がって落ちる
    const majority = [...coverage.entries()]
      .filter(([, fraction]) => fraction >= 0.5)
      .map(([name]) => name)
      .sort();
    assertEquals(
      majority,
      [...MAJORITY_COVERED_BASE_POWERS[year]],
      `${year}: 外枠に過半が入る base 勢力の集合`,
    );
  });

  Deno.test(`実データ: ${year} 年の HRE 外枠は帝国外の領域を含まない（面差分）`, async () => {
    const extent = await hreExtent(year);
    const coverage = await baseCoverageByName(year, extent);
    // 同じ君主・王朝に属していても帝国外の部分は外枠へ入らない
    for (
      const [name, [min, max]] of Object.entries(STRADDLING_COVERAGE[year])
    ) {
      const fraction = coverage.get(name);
      assert(fraction !== undefined, `${year}: base に ${name} が無い`);
      assert(
        fraction >= min && fraction <= max,
        `${year}: ${name} の被覆率 ${
          fraction.toFixed(3)
        } が許容範囲 [${min}, ${max}] の外`,
      );
    }
    // 完全に帝国外の勢力は（上流間の解釈差を除いて）重ならない
    for (const [name, max] of Object.entries(FOREIGN_MAX_COVERAGE[year])) {
      const fraction = coverage.get(name);
      assert(fraction !== undefined, `${year}: base に ${name} が無い`);
      assert(
        fraction < max,
        `${year}: 帝国外の ${name} が外枠に ${
          (fraction * 100).toFixed(1)
        }% 含まれている（上限 ${(max * 100).toFixed(0)}%）`,
      );
    }
  });

  Deno.test(`実データ: ${year} 年は HRE 本体・領邦のどちらを選んでも同じ外枠になる`, async () => {
    const overrides = await realOverrides();
    const fiefs = await readCollection(`data/hre_fiefs_flat_${year}.geojson`);
    // 領邦オーバーレイの全 feature が HRE の宗主キーへ解決する = ホバー/選択で
    // 同じ extentKey になり、同じ union（同じ外枠）が引かれる
    for (const f of fiefs.features) {
      assertEquals(
        f.properties?.SUBJECTO,
        HRE_KEY,
        `${year}: 領邦 ${String(f.properties?.NAME)} の SUBJECTO`,
      );
    }
    // base 側に HRE キーへ解決する feature が 1 件も無い年（1783 / 1800）でも、
    // 帝国全域ジオメトリだけで外枠が立つ
    const base = await readCollection(`data/europe_${year}.geojson`);
    const realm = await readCollection(`data/hre_realm_${year}.geojson`);
    const baseOnly = buildSuzerainExtent(base, HRE_KEY, overrides);
    const withRealm = buildSuzerainExtent(
      base,
      HRE_KEY,
      overrides,
      null,
      realm,
    );
    assert(
      withRealm.features.length > 0,
      `${year}: 帝国全域ジオメトリを入れても外枠が空`,
    );
    const baseOnlyKm2 = baseOnly.features.length === 0
      ? 0
      : area(baseOnly) / 1e6;
    assert(
      area(withRealm) / 1e6 > baseOnlyKm2,
      `${year}: 帝国全域ジオメトリが外枠を広げていない`,
    );
    assertEquals(
      extractSuzerainMembers(realm, HRE_KEY, overrides).length,
      1,
      `${year}: 帝国全域ジオメトリの構成 feature 数`,
    );
  });
}

Deno.test("1806 年の帝国解体後（1815 年以降）は HRE 外枠を出さない", async () => {
  const overrides = await realOverrides();
  for (const year of [1815, 1880, 1900, 1914]) {
    assert(
      !HRE_REALM_YEARS.includes(year),
      `${year}: 帝国全域データの対象年に入っている`,
    );
    const base = await readCollection(`data/europe_${year}.geojson`);
    const extent = buildSuzerainExtent(base, HRE_KEY, overrides, null, null);
    assertEquals(
      extent.features.length,
      0,
      `${year}: HRE 外枠が空でない`,
    );
  }
});

/**
 * 1000〜1700 年の HRE 外枠の面積（km²、実測を固定）。base の
 * `Holy Roman Empire` ポリゴンが帝国全域を塗っている年代で、#332 の入力規則
 * 追加が**この年代の外枠を 1 km² も動かさない**ことを押さえる（AC7）。
 *
 * 値は base のデータが変われば当然動く（この検査が見るのは「#332 の入力追加で
 * 動かないこと」であって値そのものの不変ではない）。1100 の 785_656 は #342 が
 * ボヘミア西〜南のスリバー（18,197 + 65 km²）を Poland から HRE へ併合した後の
 * 実測で、それ以前は 767,390 km² だった。1200 の 786_104 は #346 が Poland から
 * ボヘミア王国（宗主 = 帝国）を切り出し、その結果分断された残余 25,733 km² が
 * #342 の規則で HRE へ併合された後の実測で、それ以前は 713,865 km² だった。
 *
 * #352 での更新（1100 / 1200 / 1279 / 1300 / 1400 の 5 年）: ポーランドの外周を
 * Cliopatria の複合体へ置換した（ADR-0040）結果、旧外周にしか無い成分のうち
 * 隣接として帝国が選ばれたものが HRE へ併合された。年ごとの内訳は
 * `deno task build-data` のログが出す（1100: +10,944 / 1200: +8,251 /
 * 1279: +4,800 +6,608 +191 / 1300: +6,608 / 1400: +11,670 +3,813 +230 +206
 * +45 +6 +2 +1 km²。1300 は逆に旧ポーランド塗りが Cliopatria の外周へ
 * 置き換わって帝国側の重なりが差し引かれた分が大きく、正味では減っている）。
 * 1000 は帝国と接する残余がポメラニア・プロイセン・キエフ側へ流れたため不変。
 */
const EARLY_HRE_EXTENT_KM2: Record<number, number> = {
  // #443: 旧 Poland 西側残余を HRE へ統合した分だけ外枠が広がる。
  1000: 764_848,
  1100: 795_568,
  1200: 793_951,
  1279: 870_764,
  1300: 868_706,
  1400: 931_030,
  1492: 851_324,
  1500: 851_324,
  1530: 691_173,
  1600: 674_387,
  1650: 626_584,
  1700: 608_440,
};

Deno.test("非退行: 1000〜1700 年の HRE 外枠は #332 の入力追加で変わらない", async () => {
  const overrides = await realOverrides();
  for (const [key, expected] of Object.entries(EARLY_HRE_EXTENT_KM2)) {
    const year = Number(key);
    assert(
      !HRE_REALM_YEARS.includes(year),
      `${year}: 帝国全域データの対象年に入っている`,
    );
    const base = await readCollection(`data/europe_${year}.geojson`);
    const before = buildSuzerainExtent(base, HRE_KEY, overrides);
    // 非対象年のローダは空 FC を返す（createOverlayLoader の契約）
    const after = buildSuzerainExtent(base, HRE_KEY, overrides, null, {
      type: "FeatureCollection",
      features: [],
    });
    assertEquals(
      after.features.length,
      before.features.length,
      `${year}: 外枠の feature 数`,
    );
    const km2After = area(after) / 1e6;
    assert(
      Math.abs(km2After - area(before) / 1e6) < 1,
      `${year}: 外枠面積が変化した`,
    );
    assert(
      Math.abs(km2After - expected) / expected < 0.001,
      `${year}: 外枠面積 ${
        Math.round(km2After)
      } km² が実測 ${expected} km² と乖離`,
    );
  }
});

Deno.test("帝国全域データの対象年は 1715 / 1783 / 1800 のみ", () => {
  assertEquals([...HRE_REALM_YEARS], [...LATE_HRE_YEARS]);
  for (const year of HRE_REALM_YEARS) {
    assertEquals(hreRealmDataUrlFor(year), `/data/hre_realm_${year}.geojson`);
  }
});
