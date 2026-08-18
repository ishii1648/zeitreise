import { assert, assertEquals } from "@std/assert";
import {
  BASE_OUTLINE_YEARS,
  BASEMAP_PMTILES_URL,
  BASEMAP_SOURCE_ID,
  BRITAIN_FIEF_OVERLAY_YEARS,
  CLIOPATRIA_FIEF_OVERLAY_YEARS,
  FALLBACK_STYLE_URL,
  FRANCE_FIEF_OVERLAY_YEARS,
  HRE_ALL_OVERLAY_YEARS,
  HRE_FIEF_OVERLAY_YEARS,
  HRE_OVERLAY_YEARS,
  INITIAL_CENTER,
  INITIAL_YEAR,
  INITIAL_ZOOM,
  ITALY_FIEF_OVERLAY_YEARS,
  MAP_MAX_BOUNDS,
  MAX_ZOOM,
  MIN_ZOOM,
  SNAPSHOT_YEARS,
  SOVEREIGN_FIEF_OVERLAY_YEARS,
} from "./config.ts";

Deno.test("INITIAL_CENTER はヨーロッパ中心付近の [15, 50] である", () => {
  assertEquals(INITIAL_CENTER, [15, 50]);
});

Deno.test("INITIAL_ZOOM は 4 である", () => {
  assertEquals(INITIAL_ZOOM, 4);
});

Deno.test("MIN_ZOOM は MAX_ZOOM より小さい", () => {
  assert(MIN_ZOOM < MAX_ZOOM);
});

Deno.test("MIN_ZOOM は 4、MAX_ZOOM は 8 である", () => {
  // TASK-22: ヨーロッパ全域が一望できる下限に引き上げ（z3 は圏外まで見えすぎる）
  assertEquals(MIN_ZOOM, 4);
  assertEquals(MAX_ZOOM, 8);
});

Deno.test("MAP_MAX_BOUNDS はヨーロッパ域 [[-25, 34], [60, 72]] である", () => {
  // scripts/build-data.ts の EUROPE_BBOX ([-25, 34, 60, 72]) と同値であること
  assertEquals(MAP_MAX_BOUNDS, [[-25, 34], [60, 72]]);
});

Deno.test("MAP_MAX_BOUNDS は南西・北東の順で矛盾がない", () => {
  const [[west, south], [east, north]] = MAP_MAX_BOUNDS;
  assert(west < east);
  assert(south < north);
});

Deno.test("INITIAL_CENTER は MAP_MAX_BOUNDS の内側にある", () => {
  const [[west, south], [east, north]] = MAP_MAX_BOUNDS;
  const [lon, lat] = INITIAL_CENTER;
  assert(west <= lon && lon <= east);
  assert(south <= lat && lat <= north);
});

Deno.test("SNAPSHOT_YEARS は昇順である", () => {
  const sorted = [...SNAPSHOT_YEARS].sort((a, b) => a - b);
  assertEquals(SNAPSHOT_YEARS, sorted);
});

Deno.test("SNAPSHOT_YEARS に重複がない", () => {
  const unique = new Set(SNAPSHOT_YEARS);
  assertEquals(unique.size, SNAPSHOT_YEARS.length);
});

Deno.test("SNAPSHOT_YEARS は仕様書どおりの 19 件である（TASK-119 で 900 を廃止）", () => {
  assertEquals(SNAPSHOT_YEARS, [
    1000,
    1100,
    1200,
    1279,
    1300,
    1400,
    1492,
    1500,
    1530,
    1600,
    1650,
    1700,
    1715,
    1783,
    1800,
    1815,
    1880,
    1900,
    1914,
  ]);
});

Deno.test("SNAPSHOT_YEARS の最古年は 1000 で 900 を含まない（TASK-119）", () => {
  assertEquals(SNAPSHOT_YEARS[0], 1000);
  assert(!SNAPSHOT_YEARS.includes(900));
});

Deno.test("INITIAL_YEAR は 1000 である", () => {
  assertEquals(INITIAL_YEAR, 1000);
});

Deno.test("INITIAL_YEAR は SNAPSHOT_YEARS に含まれる", () => {
  assert(SNAPSHOT_YEARS.includes(INITIAL_YEAR));
});

Deno.test("BASEMAP_PMTILES_URL は同一オリジン配信の .pmtiles パスである", () => {
  // 開発時は dist/ 直下に配置した europe.pmtiles を同一オリジンで配信する。
  // 本番 R2 の絶対 URL への差し替えは TASK-10。
  assert(BASEMAP_PMTILES_URL.startsWith("/"));
  assert(BASEMAP_PMTILES_URL.endsWith(".pmtiles"));
});

Deno.test("FALLBACK_STYLE_URL は OpenFreeMap のスタイル URL である", () => {
  assert(FALLBACK_STYLE_URL.startsWith("https://tiles.openfreemap.org/"));
});

Deno.test("BASEMAP_SOURCE_ID は非空文字列である", () => {
  assert(BASEMAP_SOURCE_ID.length > 0);
});

Deno.test("HRE_OVERLAY_YEARS は 1700 を含む（1650 境界の外挿。TASK-68）", () => {
  assertEquals([...HRE_OVERLAY_YEARS], [1500, 1530, 1600, 1650, 1700]);
});

Deno.test("HRE_OVERLAY_YEARS は 1715 以降のスナップショット年を含まない（ベースマップのドイツ諸邦個別収録との二重表示回避）", () => {
  for (const year of HRE_OVERLAY_YEARS) {
    assert(year < 1715, `${year} は 1715 以降（二重表示になる）`);
    assert(SNAPSHOT_YEARS.includes(year), `${year} は SNAPSHOT_YEARS に無い`);
  }
});

Deno.test("FRANCE_FIEF_OVERLAY_YEARS は中世 5 年代である（TASK-71）", () => {
  assertEquals([...FRANCE_FIEF_OVERLAY_YEARS], [1000, 1100, 1200, 1279, 1300]);
});

Deno.test("FRANCE_FIEF_OVERLAY_YEARS は昇順・重複なしで SNAPSHOT_YEARS の部分集合（TASK-71）", () => {
  const sorted = [...FRANCE_FIEF_OVERLAY_YEARS].sort((a, b) => a - b);
  assertEquals([...FRANCE_FIEF_OVERLAY_YEARS], sorted);
  assertEquals(
    new Set(FRANCE_FIEF_OVERLAY_YEARS).size,
    FRANCE_FIEF_OVERLAY_YEARS.length,
  );
  for (const year of FRANCE_FIEF_OVERLAY_YEARS) {
    assert(SNAPSHOT_YEARS.includes(year), `${year} は SNAPSHOT_YEARS に無い`);
  }
});

Deno.test("FRANCE_FIEF_OVERLAY_YEARS は近世以降（1400 年以降）を含まない（ベースマップ勢力表示との二重表示回避。TASK-71 AC #4）", () => {
  for (const year of FRANCE_FIEF_OVERLAY_YEARS) {
    assert(year <= 1300, `${year} は中世の対象年ではない（二重表示になる）`);
  }
  for (const year of SNAPSHOT_YEARS) {
    if (year >= 1400) {
      assert(
        !FRANCE_FIEF_OVERLAY_YEARS.includes(year),
        `${year} でフランス諸侯オーバーレイが出てはいけない`,
      );
    }
  }
});

Deno.test("FRANCE_FIEF_OVERLAY_YEARS と HRE_OVERLAY_YEARS は互いに素（Roller 由来の近世領邦と中世仏諸侯領は同時表示年を持たない。TASK-71）", () => {
  const overlap = FRANCE_FIEF_OVERLAY_YEARS.filter((y) =>
    HRE_OVERLAY_YEARS.includes(y)
  );
  assertEquals(overlap, []);
});

Deno.test("HRE_FIEF_OVERLAY_YEARS は中世 7 年代 + 近世 3 年代である（TASK-86 / #187）", () => {
  assertEquals([...HRE_FIEF_OVERLAY_YEARS], [
    1000,
    1100,
    1200,
    1279,
    1300,
    1400,
    1492,
    1715,
    1783,
    1800,
  ]);
});

Deno.test("HRE_FIEF_OVERLAY_YEARS は昇順・重複なしで SNAPSHOT_YEARS の部分集合（TASK-86）", () => {
  const sorted = [...HRE_FIEF_OVERLAY_YEARS].sort((a, b) => a - b);
  assertEquals([...HRE_FIEF_OVERLAY_YEARS], sorted);
  assertEquals(
    new Set(HRE_FIEF_OVERLAY_YEARS).size,
    HRE_FIEF_OVERLAY_YEARS.length,
  );
  for (const year of HRE_FIEF_OVERLAY_YEARS) {
    assert(SNAPSHOT_YEARS.includes(year), `${year} は SNAPSHOT_YEARS に無い`);
  }
});

Deno.test("HRE_FIEF_OVERLAY_YEARS は Roller 由来の HRE_OVERLAY_YEARS と互いに素（TASK-86）", () => {
  const overlap = HRE_FIEF_OVERLAY_YEARS.filter((y) =>
    HRE_OVERLAY_YEARS.includes(y)
  );
  assertEquals(overlap, []);
});

Deno.test("HRE_ALL_OVERLAY_YEARS は OHM 年代（中世 + 近世 1715〜1800）と Roller 年代の和で昇順・重複なし（TASK-86 / #187）", () => {
  const expected = [
    ...new Set([...HRE_FIEF_OVERLAY_YEARS, ...HRE_OVERLAY_YEARS]),
  ].sort((a, b) => a - b);
  assertEquals([...HRE_ALL_OVERLAY_YEARS], expected);
  const sorted = [...HRE_ALL_OVERLAY_YEARS].sort((a, b) => a - b);
  assertEquals([...HRE_ALL_OVERLAY_YEARS], sorted);
  assertEquals(
    new Set(HRE_ALL_OVERLAY_YEARS).size,
    HRE_ALL_OVERLAY_YEARS.length,
  );
});

Deno.test("HRE_ALL_OVERLAY_YEARS は 1492 と 1500 を連続して含む（1492↔1500 の切替で表示が途切れない。TASK-86 AC #5）", () => {
  assert(HRE_ALL_OVERLAY_YEARS.includes(1492));
  assert(HRE_ALL_OVERLAY_YEARS.includes(1500));
});

Deno.test("HRE_ALL_OVERLAY_YEARS は 1700 と 1715 を連続して含む（1700↔1715 の切替で領邦レイヤーが途切れない。#187）", () => {
  assert(HRE_ALL_OVERLAY_YEARS.includes(1700));
  assert(HRE_ALL_OVERLAY_YEARS.includes(1715));
  assert(HRE_ALL_OVERLAY_YEARS.includes(1783));
  assert(HRE_ALL_OVERLAY_YEARS.includes(1800));
});

Deno.test("ITALY_FIEF_OVERLAY_YEARS は中世〜近世初頭の 8 年代である（TASK-95/96、#188）", () => {
  assertEquals([...ITALY_FIEF_OVERLAY_YEARS], [
    1000,
    1100,
    1200,
    1279,
    1300,
    1400,
    1492,
    1500,
  ]);
});

Deno.test("ITALY_FIEF_OVERLAY_YEARS は昇順・重複なしで SNAPSHOT_YEARS の部分集合（TASK-96）", () => {
  const sorted = [...ITALY_FIEF_OVERLAY_YEARS].sort((a, b) => a - b);
  assertEquals([...ITALY_FIEF_OVERLAY_YEARS], sorted);
  assertEquals(
    new Set(ITALY_FIEF_OVERLAY_YEARS).size,
    ITALY_FIEF_OVERLAY_YEARS.length,
  );
  for (const year of ITALY_FIEF_OVERLAY_YEARS) {
    assert(SNAPSHOT_YEARS.includes(year), `${year} は SNAPSHOT_YEARS に無い`);
  }
});

Deno.test("ITALY_FIEF_OVERLAY_YEARS は 1500 を含み 1530 以降を含まない（base の個別収録は 1530 から。#188）", () => {
  assert(ITALY_FIEF_OVERLAY_YEARS.includes(1500));
  for (const year of ITALY_FIEF_OVERLAY_YEARS) {
    assert(year < 1530, `${year} は base が伊諸邦を個別収録する年代`);
  }
});

Deno.test("ITALY_FIEF_OVERLAY_YEARS は AC #1/#2 の対象年（1100・1200）を含む（TASK-96）", () => {
  assert(ITALY_FIEF_OVERLAY_YEARS.includes(1100));
  assert(ITALY_FIEF_OVERLAY_YEARS.includes(1200));
});

// ---- Cliopatria 由来の領邦オーバーレイ（TASK-110）----

Deno.test("CLIOPATRIA_FIEF_OVERLAY_YEARS はモルダヴィア補完年代を含む（#450）", () => {
  assertEquals([...CLIOPATRIA_FIEF_OVERLAY_YEARS], [
    1000,
    1100,
    1200,
    1279,
    1300,
    1400,
    1492,
    1500,
    1530,
    1600,
    1650,
    1700,
    1715,
    1783,
    1800,
  ]);
});

Deno.test("CLIOPATRIA_FIEF_OVERLAY_YEARS は昇順・重複なしで SNAPSHOT_YEARS の部分集合（TASK-110）", () => {
  const sorted = [...CLIOPATRIA_FIEF_OVERLAY_YEARS].sort((a, b) => a - b);
  assertEquals([...CLIOPATRIA_FIEF_OVERLAY_YEARS], sorted);
  assertEquals(
    new Set(CLIOPATRIA_FIEF_OVERLAY_YEARS).size,
    CLIOPATRIA_FIEF_OVERLAY_YEARS.length,
  );
  for (const year of CLIOPATRIA_FIEF_OVERLAY_YEARS) {
    assert(SNAPSHOT_YEARS.includes(year), `${year} は SNAPSHOT_YEARS に無い`);
  }
});

Deno.test("CLIOPATRIA_FIEF_OVERLAY_YEARS の近世分はモルダヴィア対象年だけ（#450）", () => {
  for (const year of [1500, 1530, 1600, 1650, 1700, 1715, 1783, 1800]) {
    assert(CLIOPATRIA_FIEF_OVERLAY_YEARS.includes(year));
  }
});

Deno.test("CLIOPATRIA_FIEF_OVERLAY_YEARS は AC #5 の対象年（1000/1100 の仏・1279〜1492 の帝国）を含む（TASK-110）", () => {
  for (const year of [1000, 1100, 1279, 1300, 1400, 1492]) {
    assert(
      CLIOPATRIA_FIEF_OVERLAY_YEARS.includes(year),
      `${year} は AC #5 の目視確認対象`,
    );
  }
});

Deno.test("CLIOPATRIA_FIEF_OVERLAY_YEARS は BASE_OUTLINE_YEARS の部分集合（既存の派生 base を再生成せずに済む）（TASK-110）", () => {
  // base_outline_* / europe_flat_* は OHM 由来 3 系統の union で生成済み。
  // Cliopatria の対象年がその年集合を超えると派生データの無い年が生じるため、
  // 部分集合であることをここで固定する（超えたらデータ側の再生成が必要）。
  for (const year of CLIOPATRIA_FIEF_OVERLAY_YEARS) {
    assert(
      BASE_OUTLINE_YEARS.includes(year),
      `${year} の base_outline / europe_flat が存在しない`,
    );
  }
});

Deno.test("BASE_OUTLINE_YEARS は 5 系統のオーバーレイ年代の和集合で昇順・重複なし（TASK-86/96、#172 でブリテン・#189 で主権政体を追加）", () => {
  const expected = [
    ...new Set([
      ...FRANCE_FIEF_OVERLAY_YEARS,
      ...HRE_FIEF_OVERLAY_YEARS,
      ...ITALY_FIEF_OVERLAY_YEARS,
      ...BRITAIN_FIEF_OVERLAY_YEARS,
      ...SOVEREIGN_FIEF_OVERLAY_YEARS,
    ]),
  ].sort((a, b) => a - b);
  assertEquals([...BASE_OUTLINE_YEARS], expected);
  for (const year of BASE_OUTLINE_YEARS) {
    assert(SNAPSHOT_YEARS.includes(year), `${year} は SNAPSHOT_YEARS に無い`);
  }
});

// ---- ブリテン諸島の政体オーバーレイ（#172）----

Deno.test("BRITAIN_FIEF_OVERLAY_YEARS は TASK-151 が生成した 12 年代である（#172）", () => {
  assertEquals([...BRITAIN_FIEF_OVERLAY_YEARS], [
    1000,
    1100,
    1200,
    1279,
    1300,
    1400,
    1492,
    1500,
    1530,
    1600,
    1650,
    1700,
  ]);
});

Deno.test("BRITAIN_FIEF_OVERLAY_YEARS は昇順・重複なしで SNAPSHOT_YEARS の部分集合（#172）", () => {
  const sorted = [...BRITAIN_FIEF_OVERLAY_YEARS].sort((a, b) => a - b);
  assertEquals([...BRITAIN_FIEF_OVERLAY_YEARS], sorted);
  assertEquals(
    new Set(BRITAIN_FIEF_OVERLAY_YEARS).size,
    BRITAIN_FIEF_OVERLAY_YEARS.length,
  );
  for (const year of BRITAIN_FIEF_OVERLAY_YEARS) {
    assert(SNAPSHOT_YEARS.includes(year), `${year} は SNAPSHOT_YEARS に無い`);
  }
});

Deno.test("BRITAIN_FIEF_OVERLAY_YEARS は 1715 以降を含まない（base が UK とアイルランド王国を分けて収録する年代。#172）", () => {
  for (const year of BRITAIN_FIEF_OVERLAY_YEARS) {
    assert(year <= 1700, `${year} は base が既に分離収録する年代`);
  }
});

Deno.test("BRITAIN_FIEF_OVERLAY_YEARS は AC の対象年（1000〜1279 のウェールズ・アイルランド諸王国、1600〜1700 のアイルランド）を含む（#172）", () => {
  for (const year of [1000, 1100, 1200, 1279, 1600, 1650, 1700]) {
    assert(
      BRITAIN_FIEF_OVERLAY_YEARS.includes(year),
      `${year} は目視確認対象の年`,
    );
  }
});

Deno.test("BRITAIN_FIEF_OVERLAY_YEARS は BASE_OUTLINE_YEARS の部分集合（全対象年に base_outline / europe_flat が存在する）（#172）", () => {
  for (const year of BRITAIN_FIEF_OVERLAY_YEARS) {
    assert(
      BASE_OUTLINE_YEARS.includes(year),
      `${year} の base_outline / europe_flat が存在しない`,
    );
  }
});

// ---- 主権政体オーバーレイ（#189）----

Deno.test("SOVEREIGN_FIEF_OVERLAY_YEARS は #189/#190/#191 が生成した 19 年代である", () => {
  assertEquals([...SOVEREIGN_FIEF_OVERLAY_YEARS], [
    1000,
    1100,
    1200,
    1279,
    1300,
    1400,
    1492,
    1500,
    1530,
    1600,
    1650,
    1700,
    1715,
    1783,
    1800,
    1815,
    1880,
    1900,
    // #191: 微小国家 4 政体（サンマリノ・アンドラ・モナコ・
    // リヒテンシュタイン）は 1914 年の base にも 1 件も無い
    1914,
  ]);
});

Deno.test("SOVEREIGN_FIEF_OVERLAY_YEARS は昇順・重複なしで SNAPSHOT_YEARS の部分集合（#189）", () => {
  const sorted = [...SOVEREIGN_FIEF_OVERLAY_YEARS].sort((a, b) => a - b);
  assertEquals([...SOVEREIGN_FIEF_OVERLAY_YEARS], sorted);
  assertEquals(
    new Set(SOVEREIGN_FIEF_OVERLAY_YEARS).size,
    SOVEREIGN_FIEF_OVERLAY_YEARS.length,
  );
  for (const year of SOVEREIGN_FIEF_OVERLAY_YEARS) {
    assert(SNAPSHOT_YEARS.includes(year), `${year} は SNAPSHOT_YEARS に無い`);
  }
});

Deno.test("SOVEREIGN_FIEF_OVERLAY_YEARS は SNAPSHOT_YEARS 全 19 年（#191 で 1914 も対象になった）", () => {
  // #189 時点では「base が Finland ほか後継の主権国家を個別収録する」ことを
  // 理由に 1914 を外していた。#191 で加えた微小国家（サンマリノ・アンドラ・
  // モナコ・リヒテンシュタイン）は 1914 年の base にも無いため、この年も
  // オーバーレイが要る。BASE_OUTLINE_YEARS もこれに伴い全 19 年になる。
  assertEquals([...SOVEREIGN_FIEF_OVERLAY_YEARS], [...SNAPSHOT_YEARS]);
  assert(BASE_OUTLINE_YEARS.includes(1914));
});

Deno.test("SOVEREIGN_FIEF_OVERLAY_YEARS は AC の対象年（1650〜1715 のクリミア、1400 のモスクワ、1815〜1900 のフィンランド、1880 のクレタ、#190 の 1000 の教皇領・1279〜1500 のナポリ / アテネ / サヴォイア・1783〜1800 のジェノヴァ）を含む", () => {
  for (
    const year of [
      1000,
      1100,
      1279,
      1300,
      1400,
      1492,
      1500,
      1650,
      1700,
      1715,
      1783,
      1800,
      1815,
      1880,
      1900,
    ]
  ) {
    assert(
      SOVEREIGN_FIEF_OVERLAY_YEARS.includes(year),
      `${year} は目視確認対象の年`,
    );
  }
});

Deno.test("SOVEREIGN_FIEF_OVERLAY_YEARS は BASE_OUTLINE_YEARS の部分集合（全対象年に base_outline / europe_flat が存在する）（#189）", () => {
  for (const year of SOVEREIGN_FIEF_OVERLAY_YEARS) {
    assert(
      BASE_OUTLINE_YEARS.includes(year),
      `${year} の base_outline / europe_flat が存在しない`,
    );
  }
});
