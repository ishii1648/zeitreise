/**
 * scripts/build-hre-realm.ts の純粋関数と生成物の不変条件（#332）。
 * ネットワークには一切依存しない（Overpass の応答は合成データで与える）。
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import area from "@turf/area";
import type { FeatureCollection } from "geojson";
import type { OhmRelation } from "./build-france-fiefs.ts";
import {
  buildHreRealmTagsQuery,
  buildRealmCollection,
  HRE_REALM_NAME,
  HRE_REALM_SIZE_LIMIT_BYTES,
  HRE_REALM_TAG_FILTERS,
  HRE_REALM_YEARS,
  hreRealmPathFor,
  isHreRealmName,
  selectHreRealmForYear,
} from "./build-hre-realm.ts";
import { HRE_REALM_YEARS as CONFIG_HRE_REALM_YEARS } from "../src/config.ts";
import { SNAPSHOT_YEARS } from "../src/config.ts";

/** 実測の帝国面積（km²、OHM の各時間スライス）。生成物の下限・上限の根拠 */
const EXPECTED_AREA_KM2: Record<number, number> = {
  1000: 726_209,
  1100: 927_960,
  1715: 689_321,
  1783: 638_317,
  1800: 563_471,
};

/** 対象年ごとに採るべき OHM リレーション ID（条約による時間スライス） */
const EXPECTED_RELATION_ID: Record<number, number> = {
  1000: 2805484,
  1100: 2750623,
  1715: 2815489,
  1783: 2810442,
  1800: 2696467,
};

function relation(
  id: number,
  tags: Record<string, string>,
  members: OhmRelation["members"] = [],
): OhmRelation {
  return { type: "relation", id, tags, members } as OhmRelation;
}

/** 単位正方形（1 度四方）を 1 本の outer way で持つリレーション */
function squareRelation(id: number, tags: Record<string, string>): OhmRelation {
  return relation(
    id,
    tags,
    [
      {
        type: "way",
        ref: 1,
        role: "outer",
        geometry: [
          { lat: 0, lon: 0 },
          { lat: 0, lon: 1 },
          { lat: 1, lon: 1 },
          { lat: 1, lon: 0 },
          { lat: 0, lon: 0 },
        ],
      },
    ] as OhmRelation["members"],
  );
}

Deno.test("HRE_REALM_YEARS は src/config.ts と同値で SNAPSHOT_YEARS の部分集合", () => {
  assertEquals([...HRE_REALM_YEARS], [...CONFIG_HRE_REALM_YEARS]);
  for (const year of HRE_REALM_YEARS) {
    assert(SNAPSHOT_YEARS.includes(year), `${year} が SNAPSHOT_YEARS に無い`);
  }
  // 1806 年の帝国解体後は対象にしない
  for (const year of SNAPSHOT_YEARS) {
    if (year >= 1815) {
      assert(!HRE_REALM_YEARS.includes(year), `${year} が対象年に入っている`);
    }
  }
});

Deno.test("buildHreRealmTagsQuery はタグ完全一致だけのクエリを組み立てる（bbox 非依存）", () => {
  const query = buildHreRealmTagsQuery();
  assertEquals(
    query,
    '[out:json][timeout:180];\nrelation["boundary"="administrative"]' +
      '["admin_level"="2"]["empire"="hre"];\nout tags;\n',
  );
  assertEquals(HRE_REALM_TAG_FILTERS.length, 3);
});

Deno.test("isHreRealmName は帝国そのものだけを通す", () => {
  assert(isHreRealmName("Holy Roman Empire"));
  assert(isHreRealmName("Holy Roman Empire (1512-1648)"));
  assert(!isHreRealmName("Principality of Neuchâtel"));
  assert(!isHreRealmName("Duchy of Bohemia"));
  assert(!isHreRealmName(undefined));
});

Deno.test("selectHreRealmForYear は年で時間スライスを 1 件に絞る", () => {
  const elements = [
    relation(2831111, {
      "name:en": "Holy Roman Empire",
      "admin_level": "2",
      "start_date": "1697-09-20",
      "end_date": "1713-04-02",
    }),
    relation(2815489, {
      "name:en": "Holy Roman Empire",
      "admin_level": "2",
      "start_date": "1713-04-02",
      "end_date": "1742-07-28",
    }),
    // 帝国内の政体（empire=hre / admin_level=2 だが帝国そのものではない）
    relation(2748495, {
      "name:en": "Principality of Neuchâtel",
      "admin_level": "2",
      "start_date": "1648-10-24",
      "end_date": "1707-06-16",
    }),
  ];
  assertEquals(selectHreRealmForYear(elements, 1715)?.id, 2815489);
  // 端の年は両スライスに掛かるが、ID 昇順の先頭で決定的になる
  assertEquals(selectHreRealmForYear(elements, 1713)?.id, 2815489);
  assertEquals(selectHreRealmForYear(elements, 1700)?.id, 2831111);
  // 帝国解体後は該当なし
  assertEquals(selectHreRealmForYear(elements, 1815), null);
});

Deno.test("selectHreRealmForYear は入力順に依存しない", () => {
  const a = relation(2815489, {
    "name:en": "Holy Roman Empire",
    "admin_level": "2",
    "start_date": "1713",
    "end_date": "1742",
  });
  const b = relation(2810442, {
    "name:en": "Holy Roman Empire",
    "admin_level": "2",
    "start_date": "1713",
    "end_date": "1742",
  });
  assertEquals(selectHreRealmForYear([a, b], 1715)?.id, 2810442);
  assertEquals(selectHreRealmForYear([b, a], 1715)?.id, 2810442);
});

Deno.test("buildRealmCollection は帝国名で 1 feature を作り出典を metadata へ記録する", () => {
  const tags = {
    "name:en": "Holy Roman Empire",
    "admin_level": "2",
    "start_date": "1713-04-02",
    "end_date": "1742-07-28",
  };
  const tagged = [relation(2815489, tags)];
  const geometries = new Map([[2815489, squareRelation(2815489, tags)]]);
  const { fc, metadata } = buildRealmCollection(tagged, geometries, 1715);
  assertEquals(fc.features.length, 1);
  assertEquals(fc.features[0].properties?.NAME, HRE_REALM_NAME);
  // 外枠の宗主キー解決（resolveSuzerainKey）が base の HRE feature と
  // まったく同じ規則でこの面を拾えること
  assertEquals(fc.features[0].properties?.SUBJECTO, HRE_REALM_NAME);
  assertEquals(fc.features[0].properties?.OHM_RELATION_ID, 2815489);
  assertEquals(metadata.source, "OpenHistoricalMap");
  assertEquals(metadata.license, "CC0-1.0");
  assertEquals(metadata.relationId, 2815489);
  assertEquals(metadata.year, 1715);
});

Deno.test("buildRealmCollection は該当年が無い・ジオメトリが無いとき失敗する", () => {
  const tags = {
    "name:en": "Holy Roman Empire",
    "admin_level": "2",
    "start_date": "1713",
    "end_date": "1742",
  };
  const tagged = [relation(2815489, tags)];
  assertThrows(
    () => buildRealmCollection(tagged, new Map(), 1715),
    Error,
    "ジオメトリを取得できませんでした",
  );
  assertThrows(
    () => buildRealmCollection(tagged, new Map(), 1800),
    Error,
    "有効な帝国全域リレーションがありません",
  );
});

Deno.test("hreRealmPathFor は data/hre_realm_<year>.geojson を返す", () => {
  assertEquals(hreRealmPathFor(1715), "data/hre_realm_1715.geojson");
});

// ---- 生成物に対する回帰 ----

async function readRealm(year: number): Promise<FeatureCollection> {
  return JSON.parse(
    await Deno.readTextFile(hreRealmPathFor(year)),
  ) as FeatureCollection;
}

Deno.test("生成物: 各対象年の帝国全域が 1 feature・出典付き・上限内", async () => {
  for (const year of HRE_REALM_YEARS) {
    const text = await Deno.readTextFile(hreRealmPathFor(year));
    assert(
      new TextEncoder().encode(text).length <= HRE_REALM_SIZE_LIMIT_BYTES,
      `${year}: サイズ上限超過`,
    );
    const fc = JSON.parse(text) as FeatureCollection & {
      metadata?: Record<string, unknown>;
    };
    assertEquals(fc.features.length, 1, `${year}: feature 数`);
    assertEquals(fc.features[0].properties?.NAME, HRE_REALM_NAME);
    assertEquals(fc.features[0].properties?.SUBJECTO, HRE_REALM_NAME);
    assertEquals(
      fc.features[0].properties?.OHM_RELATION_ID,
      EXPECTED_RELATION_ID[year],
      `${year}: 採用した OHM リレーション`,
    );
    assertEquals(fc.metadata?.source, "OpenHistoricalMap");
    assertEquals(fc.metadata?.license, "CC0-1.0");
    assertEquals(fc.metadata?.relationId, EXPECTED_RELATION_ID[year]);
  }
});

Deno.test("生成物: 帝国全域の面積が上流の実測と 1% 以内で一致する", async () => {
  for (const year of HRE_REALM_YEARS) {
    const km2 = area(await readRealm(year)) / 1e6;
    const expected = EXPECTED_AREA_KM2[year];
    const ratio = Math.abs(km2 - expected) / expected;
    assert(
      ratio < 0.01,
      `${year}: 面積 ${Math.round(km2)} km² が上流実測 ${expected} km² と ${
        (ratio * 100).toFixed(2)
      }% 乖離`,
    );
  }
});

Deno.test("生成物: 後期帝国全域は年を追って縮む（1715 > 1783 > 1800）", async () => {
  // 1742 シュレージエン喪失〜1797 カンポ・フォルミオの左岸割譲を反映する。
  // 「どの時間スライスを採ったか」の取り違えを面積の単調性で検出する。
  const years = [1715, 1783, 1800];
  const areas = await Promise.all(
    years.map(async (year) => area(await readRealm(year)) / 1e6),
  );
  for (let i = 1; i < areas.length; i++) {
    assert(
      areas[i] < areas[i - 1],
      `${years[i]} 年の帝国が ${years[i - 1]} 年より小さくない`,
    );
  }
});
