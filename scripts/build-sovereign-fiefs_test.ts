/**
 * scripts/build-sovereign-fiefs.ts のテスト（#189）。
 * 前半は純粋関数のテストでネットワークに依存しない:
 * 取得対象が「リレーション ID の静的な許可リスト × 年 × 存続区間の包含判定 ×
 * base 重複年の除外」だけで決まることを、年ごとの期待 ID 集合を固定して検証する。
 * 後半は生成物 data/sovereign_fiefs_<year>.geojson そのものを検証する。
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import type { FeatureCollection } from "geojson";
import { SNAPSHOT_YEARS, SOVEREIGN_FIEF_OVERLAY_YEARS } from "../src/config.ts";
import type { OhmRelation } from "./build-france-fiefs.ts";
import { FRANCE_FIEF_NAMES } from "./build-france-fiefs.ts";
import { HRE_FIEF_NAMES } from "./build-hre-fiefs.ts";
import { ITALY_FIEF_NAMES } from "./build-italy-fiefs.ts";
import { BRITAIN_FIEF_ALLOWLIST } from "./build-britain-fiefs.ts";
import {
  buildYearCollection,
  parseTargetYears,
  selectSovereignFiefsForYear,
  SOVEREIGN_FIEF_ALLOWLIST,
  SOVEREIGN_FIEF_BBOX,
  SOVEREIGN_FIEF_EXCLUDED_IDS,
  SOVEREIGN_FIEF_EXCLUSIONS,
  SOVEREIGN_FIEF_SIZE_LIMIT_BYTES,
  SOVEREIGN_FIEF_YEARS,
  sovereignFiefExclusionReason,
  sovereignFiefIdsForYear,
  sovereignFiefTagDrift,
} from "./build-sovereign-fiefs.ts";
import area from "@turf/area";
import {
  dropTinyRings,
  MIN_PART_AREA_M2,
  polygonParts,
  selfIntersectionPoints,
} from "./clean-polygons.ts";

/** タグだけのリレーション（Overpass 相当） */
function relation(id: number, tags: Record<string, string>): OhmRelation {
  return { type: "relation", id, tags };
}

/** 1 パートの正方形ジオメトリを持つリレーション */
function withSquare(id: number, west: number, south: number): OhmRelation {
  const ring = [
    [west, south],
    [west + 1, south],
    [west + 1, south + 1],
    [west, south + 1],
    [west, south],
  ];
  return {
    type: "relation",
    id,
    tags: {},
    members: [{
      type: "way",
      ref: id * 10,
      role: "outer",
      geometry: ring.map(([lon, lat]) => ({ lon, lat })),
    }],
  };
}

/** 許可リストのエントリから tags だけのリレーションを合成する（テスト入力用） */
function relationFromAllowlist(id: number): OhmRelation {
  const entry = SOVEREIGN_FIEF_ALLOWLIST[id];
  return relation(id, {
    "name:en": entry.ohmName,
    admin_level: String(entry.adminLevel),
    start_date: entry.startDate,
    // 現存する政体（#191 のアンドラ・モナコ・リヒテンシュタイン・サンマリノ）は
    // OHM 側に end_date が無く、許可リストも endDate を持たない
    ...(entry.endDate === undefined ? {} : { end_date: entry.endDate }),
  });
}

// ---------------------------------------------------------------------------
// 設定値
// ---------------------------------------------------------------------------

Deno.test("取得範囲は実測に使った全欧 bbox をピン留めする", () => {
  assertEquals(SOVEREIGN_FIEF_BBOX, [34, -25, 72, 60]);
});

Deno.test("対象年は SNAPSHOT_YEARS 全 19 年（#191 でサンマリノが 1914 年にも要る）", () => {
  assertEquals([...SOVEREIGN_FIEF_YEARS], [
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
  for (const year of SOVEREIGN_FIEF_YEARS) {
    assert(SNAPSHOT_YEARS.includes(year), `${year} が SNAPSHOT_YEARS に無い`);
  }
});

Deno.test("表示側 config の年集合と一致する（src → scripts 非依存の重複定義の同値性）", () => {
  assertEquals([...SOVEREIGN_FIEF_OVERLAY_YEARS], [...SOVEREIGN_FIEF_YEARS]);
});

Deno.test("サイズ上限は既存パイプラインと同じ 200 KB", () => {
  assertEquals(SOVEREIGN_FIEF_SIZE_LIMIT_BYTES, 200 * 1000);
});

// ---------------------------------------------------------------------------
// 静的許可リスト
// ---------------------------------------------------------------------------

Deno.test("許可リストは実測した 43 リレーションをピン留めする（#189 の 16 + #190 の 14 + #191 の 13）", () => {
  const ids = Object.keys(SOVEREIGN_FIEF_ALLOWLIST).map(Number).sort((a, b) =>
    a - b
  );
  assertEquals(
    ids,
    [
      2739884, // County of Barcelona (0950-1050)          #190
      2739885, // County of Barcelona (1050-1150)          #190
      2750042, // Kingdom of Naples (1302-1442)            #190
      2750805, // Ligurian Republic (1797-1805)            #190
      2692586, // Cretan State
      2694163, // Principality of Moldavia
      2696816, // Grand Duchy of Finland
      2747433, // Transylvania (1711-1732)
      2809440, // Duchy of Athens (1205-1458)              #190
      2809441, // Principality of Achaea (1205-1432)       #190
      2827696, // United States of the Ionian Islands
      2829140, // Kingdom of Hungary (1779-1848)
      2830352, // Republic of Ragusa
      2835765, // Eyalet of Crete
      2836150, // Grand Principality of Serbia
      2849499, // Crimean Khanate (1475-1774)
      2851381, // Republic of Genoa (1768-1797)            #190
      2854743, // Eastern Rumelia
      2857706, // Prince-Bishopric of Montenegro
      2861788, // Knights Hospitaller / Malta (1665-1798)  #190
      2861790, // Knights Hospitaller / Malta (1530-1651)  #190
      2861791, // Knights Hospitaller / Rhodes (1310-1522) #190
      2878295, // Transylvania (1765-1851)
      2889237, // Papal States (0988-1020)                 #190
      2890623, // Grand Principality of Moscow (1392-1478)
      2892793, // Kingdom of Naples (1463-1501)            #190
      2893918, // Savoyard state (1388-1401)               #190
      2893921, // Savoyard state (1427-1536)               #190
      2929115, // Wallachia (1420-1538)
      2929116, // Wallachia (1538-1829)
      2692719, // San Marino (0301-1100)                   #191
      2692730, // San Marino (1291-1320)                   #191
      2692732, // San Marino (1100-1243)                   #191
      2692734, // San Marino (1320-1463)                   #191
      2692735, // San Marino (1463-1699)                   #191
      2693418, // Monaco (1861-)                           #191
      2739874, // Andorra (1278-)                          #191
      2746467, // Liechtenstein (1806-1960)                #191
      2806727, // San Marino (1243-1291)                   #191
      2806824, // Liechtenstein (1719-1806)                #191
      2851283, // Monaco (1815-1861)                       #191
      2853644, // San Marino (1700-1739)                   #191
      2853735, // San Marino (1740-)                       #191
    ].sort((a, b) => a - b),
  );
});

Deno.test("許可リストの全件がいずれかの対象年で有効（死んだエントリが無い）", () => {
  const active = new Set<number>();
  for (const year of SOVEREIGN_FIEF_YEARS) {
    for (const id of sovereignFiefIdsForYear(year)) active.add(id);
  }
  const dead = Object.keys(SOVEREIGN_FIEF_ALLOWLIST).map(Number).filter((id) =>
    !active.has(id)
  );
  assertEquals(dead, []);
});

Deno.test("許可リストは除外対象と交差しない", () => {
  for (const id of Object.keys(SOVEREIGN_FIEF_EXCLUDED_IDS).map(Number)) {
    assert(
      SOVEREIGN_FIEF_ALLOWLIST[id] === undefined,
      `${id} が許可リストと除外リストの両方にある`,
    );
  }
});

Deno.test("除外の分類キーはすべて根拠文を持ち、未使用の分類が無い", () => {
  const used = new Set(Object.values(SOVEREIGN_FIEF_EXCLUDED_IDS));
  // ID に紐づかない分類（区間内の base 重複年の除外・OHM 側の欠落）は
  // 許可リスト側の設計判断の記録として存在する
  used.add("baseCoveredYearsExcluded");
  used.add("upstreamGapsRecorded");
  // #191: 連鎖の境界年（サンマリノの 1100）も excludedYears で解く
  used.add("chainBoundaryYearExcluded");
  for (const key of used) {
    assert(
      typeof SOVEREIGN_FIEF_EXCLUSIONS[key] === "string" &&
        SOVEREIGN_FIEF_EXCLUSIONS[key].length > 0,
      `${key} の根拠が無い`,
    );
  }
  for (const key of Object.keys(SOVEREIGN_FIEF_EXCLUSIONS)) {
    assert(used.has(key), `分類 ${key} がどの除外にも使われていない`);
  }
});

Deno.test("許可リストの excludedYears は存続区間内のスナップショット年に限る", () => {
  for (const [id, entry] of Object.entries(SOVEREIGN_FIEF_ALLOWLIST)) {
    for (const year of entry.excludedYears ?? []) {
      assert(
        SNAPSHOT_YEARS.includes(year),
        `${id} の excludedYears ${year} が SNAPSHOT_YEARS に無い`,
      );
    }
  }
});

Deno.test("許可リストの名前は仏・独・伊・ブリテンの許可リストと重複しない（二重塗り防止）", () => {
  const others = new Set([
    ...FRANCE_FIEF_NAMES,
    ...HRE_FIEF_NAMES,
    ...ITALY_FIEF_NAMES,
    ...Object.values(BRITAIN_FIEF_ALLOWLIST).map((entry) => entry.name),
  ]);
  for (const entry of Object.values(SOVEREIGN_FIEF_ALLOWLIST)) {
    assert(
      !others.has(entry.name),
      `${entry.name} が他系統の許可リストと重複している`,
    );
  }
});

// ---------------------------------------------------------------------------
// 年ごとの包含判定（静的許可リスト × 存続区間 × base 重複年の除外だけで決まる）
// ---------------------------------------------------------------------------

Deno.test("sovereignFiefIdsForYear: 年ごとの対象 ID 集合が実測どおりに固定される", () => {
  const expected: Record<number, number[]> = {
    1000: [2692719, 2739884, 2889237],
    1100: [2692732, 2739885],
    1200: [2692732, 2836150],
    1279: [2739874, 2806727, 2809440, 2809441],
    1300: [2692730, 2739874, 2809440, 2809441],
    1400: [
      2692734,
      2739874,
      2750042,
      2809440,
      2809441,
      2861791,
      2890623,
      2893918,
    ],
    1492: [2692735, 2739874, 2861791, 2892793, 2893921, 2929115],
    1500: [2692735, 2739874, 2861791, 2892793, 2893921, 2929115],
    1530: [2692735, 2739874, 2861790, 2929115],
    1600: [2692735, 2739874, 2861790, 2929116],
    1650: [2692735, 2739874, 2849499, 2861790, 2929116],
    1700: [2739874, 2830352, 2849499, 2853644, 2861788, 2929116],
    1715: [2739874, 2747433, 2830352, 2849499, 2853644, 2861788, 2929116],
    1783: [
      2739874,
      2806824,
      2829140,
      2830352,
      2851381,
      2853735,
      2861788,
      2878295,
      2929116,
    ],
    1800: [
      2739874,
      2750805,
      2806824,
      2829140,
      2830352,
      2853735,
      2857706,
      2878295,
      2929116,
    ],
    1815: [
      2694163,
      2696816,
      2739874,
      2746467,
      2827696,
      2829140,
      2851283,
      2857706,
      2878295,
      2929116,
    ],
    1880: [2693418, 2696816, 2739874, 2746467, 2835765, 2853735, 2854743],
    1900: [2692586, 2693418, 2696816, 2739874, 2746467, 2853735],
    1914: [2693418, 2739874, 2746467, 2853735],
  };
  for (const year of SOVEREIGN_FIEF_YEARS) {
    assertEquals(sovereignFiefIdsForYear(year), expected[year], String(year));
  }
});

Deno.test("sovereignFiefIdsForYear: 全対象年に収録対象がある", () => {
  for (const year of SOVEREIGN_FIEF_YEARS) {
    assert(sovereignFiefIdsForYear(year).length > 0, `${year} が空`);
  }
});

Deno.test("1530/1600/1650 年のハンガリー王国は面が組めず収録できない（AC1 の実測結果）", () => {
  // OHM の 1401〜1751 年の Kingdom of Hungary（2829404 / 2750054 / 2829139 /
  // 2829520）は label ノードのみで境界 way を持たない（2026-07 実測）。
  // 許可リストに紛れても geometryUnbuildable で落ちることを固定する。
  for (const id of [2829404, 2750054, 2829139, 2829520]) {
    assert(
      sovereignFiefExclusionReason(id) !== null,
      `${id} が除外されていない`,
    );
  }
  for (const year of [1530, 1600, 1650, 1700, 1715]) {
    assert(
      !sovereignFiefIdsForYear(year).includes(2750054) &&
        !sovereignFiefIdsForYear(year).includes(2829139),
      `面が組めないハンガリー王国が ${year} 年に混入`,
    );
  }
});

Deno.test("1783/1800/1815 年にハンガリー王国（ハプスブルク AL3）が含まれる", () => {
  for (const year of [1783, 1800, 1815]) {
    assert(
      sovereignFiefIdsForYear(year).includes(2829140),
      `Kingdom of Hungary が ${year} 年に無い`,
    );
  }
});

Deno.test("1715〜1815 年にトランシルヴァニアが含まれる", () => {
  assert(sovereignFiefIdsForYear(1715).includes(2747433));
  for (const year of [1783, 1800, 1815]) {
    assert(
      sovereignFiefIdsForYear(year).includes(2878295),
      `Transylvania が ${year} 年に無い`,
    );
  }
});

Deno.test("1650〜1715 年にクリミア・ハン国が含まれる（AC2）", () => {
  for (const year of [1650, 1700, 1715]) {
    assert(
      sovereignFiefIdsForYear(year).includes(2849499),
      `Crimean Khanate が ${year} 年に無い`,
    );
  }
});

Deno.test("1400 年にモスクワ大公国が含まれる（AC3）", () => {
  assert(sovereignFiefIdsForYear(1400).includes(2890623));
});

Deno.test("1815/1880/1900 年にフィンランド大公国が含まれる（AC4）", () => {
  for (const year of [1815, 1880, 1900]) {
    assert(
      sovereignFiefIdsForYear(year).includes(2696816),
      `Grand Duchy of Finland が ${year} 年に無い`,
    );
  }
});

Deno.test("1880 年のクレタはオスマン領クレタ、1900 年はクレタ国（AC5）", () => {
  assert(sovereignFiefIdsForYear(1880).includes(2835765));
  assert(!sovereignFiefIdsForYear(1880).includes(2692586));
  assert(sovereignFiefIdsForYear(1900).includes(2692586));
  assert(!sovereignFiefIdsForYear(1900).includes(2835765));
});

Deno.test("base が同じ政体を収録する年は存続区間内でも除外される（excludedYears）", () => {
  // クリミア・ハン国（1475..1774）: base は 1492〜1600 年に Crimean Khanate を
  // 個別収録しており、その間は重複になるため除外。1650 年から収録。
  for (const year of [1492, 1500, 1530, 1600]) {
    assert(
      !sovereignFiefIdsForYear(year).includes(2849499),
      `Crimean Khanate が ${year} 年に混入`,
    );
  }
  // セルビア大公国（1000..1216）: base は 1000 / 1100 年に Serbia を収録。
  // 1200 年だけ Bulgar Khanate へ誤帰属するため 1200 年のみ収録。
  for (const year of [1000, 1100]) {
    assert(
      !sovereignFiefIdsForYear(year).includes(2836150),
      `Grand Principality of Serbia が ${year} 年に混入`,
    );
  }
  // オスマン領クレタ（1667..1898）: base は 1700〜1815 年にクレタ島を
  // Ottoman Empire として正しく塗るため、誤帰属（Bulgaria）の 1880 年のみ収録。
  for (const year of [1700, 1715, 1783, 1800, 1815]) {
    assert(
      !sovereignFiefIdsForYear(year).includes(2835765),
      `Eyalet of Crete が ${year} 年に混入`,
    );
  }
  // フィンランド大公国（1809..1917）: base は 1914 年に Finland を収録。
  assert(!sovereignFiefIdsForYear(1914).includes(2696816));
});

// ---------------------------------------------------------------------------
// #190: 西欧・イタリア・地中海の追加分
// ---------------------------------------------------------------------------

Deno.test("1400/1492/1500 年にナポリ王国が含まれる（#190 AC1。base は Sicily / Aragón の一枚岩）", () => {
  assert(sovereignFiefIdsForYear(1400).includes(2750042));
  for (const year of [1492, 1500]) {
    assert(
      sovereignFiefIdsForYear(year).includes(2892793),
      `Kingdom of Naples が ${year} 年に無い`,
    );
  }
  // NAME は base 1530 年以降の呼称に合わせる（色・和名の連続性）
  for (const id of [2750042, 2892793]) {
    assertEquals(SOVEREIGN_FIEF_ALLOWLIST[id].name, "Naples");
  }
});

Deno.test("base がナポリ王国を個別収録する 1530 年以降のリレーションは収録しない（#190）", () => {
  // base は 1530〜1715 を Naples、1783〜1815 を Kingdom of the Two Sicilies で
  // 収録しており、重ねると同じ土地の二重塗りになる
  for (
    const id of [2750045, 2750048, 2750049, 2750050, 2750744, 2750051, 2750052]
  ) {
    assert(
      sovereignFiefExclusionReason(id) !== null,
      `${id} が除外されていない`,
    );
  }
  for (const year of [1530, 1600, 1650, 1700, 1715, 1783, 1800, 1815]) {
    const ids = sovereignFiefIdsForYear(year);
    assert(!ids.includes(2750045), `${year} 年にナポリ王国が混入`);
    assert(!ids.includes(2750050), `${year} 年にナポリ王国が混入`);
  }
});

Deno.test("1400/1492/1500 年にサヴォイアが含まれ、base 収録年（1530/1600 以降）は除外される（#190 AC4）", () => {
  assert(sovereignFiefIdsForYear(1400).includes(2893918));
  for (const year of [1492, 1500]) {
    assert(
      sovereignFiefIdsForYear(year).includes(2893921),
      `Savoyard state が ${year} 年に無い`,
    );
  }
  // 1530 は base の Savoy が同じ土地を収録するため excludedYears で落とす
  assert(!sovereignFiefIdsForYear(1530).includes(2893921));
  // 1600 の Savoyard state（base の Savoy）・1650〜1783 の Savoyard state /
  // Duchy of Savoy（base の Sardinia-Piedmont / Kingdom of Sardinia）も除外
  for (const id of [2851942, 2893900, 2893920, 2810446]) {
    assert(
      sovereignFiefExclusionReason(id) !== null,
      `${id} が除外されていない`,
    );
  }
  assertEquals(SOVEREIGN_FIEF_ALLOWLIST[2893918].name, "Savoy");
  assertEquals(SOVEREIGN_FIEF_ALLOWLIST[2893921].name, "Savoy");
});

Deno.test("1783 年はジェノヴァ共和国、1800 年はリグリア共和国（#190 AC3）", () => {
  assert(sovereignFiefIdsForYear(1783).includes(2851381));
  assert(!sovereignFiefIdsForYear(1783).includes(2750805));
  assert(sovereignFiefIdsForYear(1800).includes(2750805));
  assert(!sovereignFiefIdsForYear(1800).includes(2851381));
  // NAME は base 1530〜1715 年の呼称（Genoa）に合わせ、伊諸侯領オーバーレイの
  // Republic of Genoa（1100〜1500）とは別キーにして二重塗り検査を通す
  assertEquals(SOVEREIGN_FIEF_ALLOWLIST[2851381].name, "Genoa");
  assertEquals(SOVEREIGN_FIEF_ALLOWLIST[2750805].name, "Ligurian Republic");
  // base が Genoa を収録する 1600〜1700 のリレーションは落とす
  for (const id of [2848942, 2852275]) {
    assert(
      sovereignFiefExclusionReason(id) !== null,
      `${id} が除外されていない`,
    );
  }
});

Deno.test("1000 年のローマは教皇領（#190 AC5。base は Holy Roman Empire 塗り）", () => {
  assert(sovereignFiefIdsForYear(1000).includes(2889237));
  assertEquals(SOVEREIGN_FIEF_ALLOWLIST[2889237].name, "Papal States");
  // base が Papal States を収録する 1100 / 1200 のリレーションは落とす
  assert(sovereignFiefExclusionReason(2805421) !== null);
  for (const year of [1100, 1200]) {
    assert(
      !sovereignFiefIdsForYear(year).includes(2805421),
      `${year} 年に教皇領が二重収録`,
    );
  }
});

Deno.test("1000/1100 年にバルセロナ伯領が含まれる（#190。base は Kingdom of France 塗り）", () => {
  assert(sovereignFiefIdsForYear(1000).includes(2739884));
  assert(sovereignFiefIdsForYear(1100).includes(2739885));
  for (const id of [2739884, 2739885]) {
    assertEquals(SOVEREIGN_FIEF_ALLOWLIST[id].name, "County of Barcelona");
  }
});

Deno.test("1279/1300/1400 年にアテネ公国・アカイア公国が含まれる（#190。base は Byzantine Empire 塗り）", () => {
  for (const year of [1279, 1300, 1400]) {
    const ids = sovereignFiefIdsForYear(year);
    assert(ids.includes(2809440), `Duchy of Athens が ${year} 年に無い`);
    assert(ids.includes(2809441), `Principality of Achaea が ${year} 年に無い`);
  }
  // アカイア公国は 1432 年で終わるため 1492 年には現れない
  assert(!sovereignFiefIdsForYear(1492).includes(2809441));
  assert(!sovereignFiefIdsForYear(1492).includes(2809440));
});

Deno.test("ヨハネ騎士団はロドス期（1400〜1500）とマルタ期（1530〜1783）を単一 NAME で継ぐ（#190）", () => {
  for (const year of [1400, 1492, 1500]) {
    assert(
      sovereignFiefIdsForYear(year).includes(2861791),
      `ロドスの騎士団領が ${year} 年に無い`,
    );
  }
  for (const year of [1530, 1600, 1650]) {
    assert(
      sovereignFiefIdsForYear(year).includes(2861790),
      `マルタの騎士団領が ${year} 年に無い`,
    );
  }
  for (const year of [1700, 1715, 1783]) {
    assert(
      sovereignFiefIdsForYear(year).includes(2861788),
      `マルタの騎士団領が ${year} 年に無い`,
    );
  }
  // 1798 年の失陥後（French Malta 以降）は収録しない
  assert(!sovereignFiefIdsForYear(1800).includes(2861788));
  for (const id of [2861788, 2861790, 2861791]) {
    assertEquals(SOVEREIGN_FIEF_ALLOWLIST[id].name, "Knights Hospitaller");
  }
});

Deno.test("スペイン領ネーデルラントは面が組めず 1650/1700 の Luxembourg 名義を解消できない（#190 AC2 の実測結果）", () => {
  // rel 2848630 / 2848632（Spanish Netherlands）と rel 2812126（Duchy of
  // Brabant 1648〜1797）は label ノードのみで境界 way を 1 本も持たない
  // （2026-07 実測。#187 のブラバント公領・#189 のハンガリー王国と同型）。
  for (const id of [2848630, 2848632, 2812126]) {
    assert(
      sovereignFiefExclusionReason(id) !== null,
      `${id} が除外されていない`,
    );
  }
  for (const year of [1600, 1650, 1700]) {
    const ids = sovereignFiefIdsForYear(year);
    for (const id of [2848630, 2848632, 2812126]) {
      assert(!ids.includes(id), `${year} 年に面の無い低地地方の政体が混入`);
    }
  }
});

Deno.test("ミラノ公国は他系統・base が全対象年を覆うため本系統では収録しない（#190）", () => {
  // 1400 は hre_fiefs、1500 は italy_fiefs、1530〜1715 は base の Milan、
  // 1783 は base の Milano (Austria)、1800 は base の Lombardy が担う。
  // 1492 年は OHM 側に 1447〜1500 のリレーションが無く埋められない。
  for (
    const id of [
      2750055,
      2800654,
      2848874,
      2848848,
      2832183,
      2830845,
    ]
  ) {
    assert(
      sovereignFiefExclusionReason(id) !== null,
      `${id} が除外されていない`,
    );
  }
  for (const year of SOVEREIGN_FIEF_YEARS) {
    const names = sovereignFiefIdsForYear(year).map((id) =>
      SOVEREIGN_FIEF_ALLOWLIST[id].name
    );
    assert(!names.includes("Milan"), `${year} 年にミラノが混入`);
  }
});

// ---------------------------------------------------------------------------
// #191: 微小国家（サンマリノ・アンドラ・モナコ・リヒテンシュタイン）
// ---------------------------------------------------------------------------

/** #191 の 4 政体が表示される年（実測した OHM の収録区間から決まる） */
const MICROSTATE_YEARS: Readonly<Record<string, readonly number[]>> = {
  // base は 1815 年だけ San Marino を個別収録するため、その年は除外して
  // オーバーレイ 18 年 + base 1 年で全 19 年代に現れる（AC1）
  "San Marino": SOVEREIGN_FIEF_YEARS.filter((year) => year !== 1815),
  // OHM の Andorra は start_date=1278 の 1 本きり（AC2）
  "Andorra": SOVEREIGN_FIEF_YEARS.filter((year) => year >= 1279),
  // OHM のモナコ公国は 1815 年（ウィーン会議でサルデーニャの保護下）から（AC3）
  "Monaco": [1815, 1880, 1900, 1914],
  // OHM のリヒテンシュタインは 1719 年（侯国成立）から（AC3）
  "Liechtenstein": [1783, 1800, 1815, 1880, 1900, 1914],
};

/** 表示名 → その年に採るリレーション ID（実測） */
function microstateIdsForYear(name: string, year: number): number[] {
  return sovereignFiefIdsForYear(year).filter((id) =>
    SOVEREIGN_FIEF_ALLOWLIST[id].name === name
  );
}

Deno.test("微小国家 4 政体は実測どおりの年に 1 件ずつ現れる（#191 AC1〜AC3）", () => {
  for (const [name, years] of Object.entries(MICROSTATE_YEARS)) {
    for (const year of SOVEREIGN_FIEF_YEARS) {
      const ids = microstateIdsForYear(name, year);
      assertEquals(
        ids.length,
        years.includes(year) ? 1 : 0,
        `${name} の ${year} 年: ${JSON.stringify(ids)}`,
      );
    }
  }
});

Deno.test("サンマリノは base 収録年（1815）以外の全対象年に現れ、19 年代すべてが埋まる（#191 AC1）", () => {
  // オーバーレイ側（18 年）
  for (const year of SOVEREIGN_FIEF_YEARS) {
    const ids = microstateIdsForYear("San Marino", year);
    assertEquals(ids.length, year === 1815 ? 0 : 1, String(year));
  }
  // 残る 1815 年は base（europe_1815 の San Marino）が担うため、
  // SNAPSHOT_YEARS 全 19 年でサンマリノが地図に出る
  assertEquals([...SOVEREIGN_FIEF_YEARS], [...SNAPSHOT_YEARS]);
});

Deno.test("サンマリノの連鎖は年境界で重ならない（1100 年は後続リレーションが担う）（#191）", () => {
  // rel 2692719（0301..1100）と rel 2692732（1100..1243）は年単位の閉区間では
  // どちらも 1100 年に有効になる。二重塗り・二重ラベルを避けるため、
  // 「その年に成立した側」= 後続を採る（excludedYears で前者から 1100 を落とす）。
  assertEquals(sovereignFiefIdsForYear(1000).includes(2692719), true);
  assertEquals(sovereignFiefIdsForYear(1100).includes(2692719), false);
  assertEquals(sovereignFiefIdsForYear(1100).includes(2692732), true);
});

Deno.test("微小国家の castelli・スナップショット年を持たない区間は収録しない（#191）", () => {
  // City of San Marino（al=6）は表示中の共和国の内部行政区
  assert(sovereignFiefExclusionReason(2692733) !== null);
  // San Marino 1739-10-17..1740-02-04（アルベローニ枢機卿の占領期）は
  // スナップショット年を含まない
  assert(sovereignFiefExclusionReason(2853734) !== null);
  // Liechtenstein 1960-03-17.. は 1914 年より後
  assert(sovereignFiefExclusionReason(2692582) !== null);
  for (const year of SOVEREIGN_FIEF_YEARS) {
    const ids = sovereignFiefIdsForYear(year);
    for (const id of [2692733, 2853734, 2692582]) {
      assert(!ids.includes(id), `${year} 年に ${id} が混入`);
    }
  }
});

Deno.test("現存する政体は endDate を持たず、OHM の end_date 欠損と一致する（#191）", () => {
  for (const id of [2739874, 2693418, 2853735]) {
    assertEquals(SOVEREIGN_FIEF_ALLOWLIST[id].endDate, undefined);
  }
  // end_date が無いタグとの比較では drift にならない
  const { metadata } = buildYearCollection(
    [relationFromAllowlist(2739874)],
    new Map([[2739874, withSquare(2739874, 1.0, 42.0)]]),
    1914,
  );
  assertEquals(metadata.tagDrift, {});
});

Deno.test("存続区間は年単位の閉区間（開始年・終了年の両端を含む）", () => {
  // Wallachia (1538..1829-09-14) は 1829 に含まれ 1830 には含まれない
  assert(sovereignFiefIdsForYear(1829).includes(2929116));
  assert(!sovereignFiefIdsForYear(1830).includes(2929116));
  // United States of the Ionian Islands は 1815-11-20 開始でも 1815 年に含む
  assert(sovereignFiefIdsForYear(1815).includes(2827696));
  // Republic of Ragusa (1699-01-25..1808-01-30) は 1815 年に含まれない
  assert(!sovereignFiefIdsForYear(1815).includes(2830352));
});

// ---------------------------------------------------------------------------
// リレーションの選択（純粋関数・ネットワーク非依存）
// ---------------------------------------------------------------------------

Deno.test("selectSovereignFiefsForYear: 許可リスト外・期間外の ID を落とす", () => {
  const elements = [
    relationFromAllowlist(2929116), // Wallachia 1538..1829
    relationFromAllowlist(2694163), // Principality of Moldavia 1812..1856（1600 年は期間外）
    // 許可リスト外（base が担う中世ハンガリー王国）
    relation(2836151, {
      "name:en": "Kingdom of Hungary",
      admin_level: "2",
      start_date: "1102",
      end_date: "1400",
    }),
  ];
  assertEquals(
    selectSovereignFiefsForYear(elements, 1600).map((e) => e.id),
    [2929116],
  );
});

Deno.test("selectSovereignFiefsForYear: 判定は静的な存続区間で決まりタグに依存しない", () => {
  const bareTags = relation(2929116, { "name:en": "Wallachia" });
  assertEquals(
    selectSovereignFiefsForYear([bareTags], 1600).map((e) => e.id),
    [2929116],
  );
  const driftedTags = relation(2929116, {
    "name:en": "Wallachia",
    start_date: "1850",
    end_date: "1860",
  });
  assertEquals(
    selectSovereignFiefsForYear([driftedTags], 1600).map((e) => e.id),
    [2929116],
  );
});

Deno.test("selectSovereignFiefsForYear: 並びは表示名の昇順で入力順に依存しない", () => {
  const elements = [
    relationFromAllowlist(2929116), // Principality of Wallachia
    relationFromAllowlist(2857706), // Montenegro
    relationFromAllowlist(2696816), // Grand Duchy of Finland
  ];
  const ids = (list: OhmRelation[]) =>
    selectSovereignFiefsForYear(list, 1815).map((e) => e.id);
  assertEquals(ids(elements), [2696816, 2857706, 2929116]);
  assertEquals(ids([...elements].reverse()), [2696816, 2857706, 2929116]);
});

Deno.test("sovereignFiefExclusionReason: 除外 ID は許可リストに紛れても落ちる", () => {
  // base が収録する中世ハンガリー王国のリレーション連鎖
  assert(sovereignFiefExclusionReason(2836151) !== null);
  assert(sovereignFiefExclusionReason(2829404) !== null);
  // ロシア併合年（1783）のクリミア・ハン国
  assert(sovereignFiefExclusionReason(2849498) !== null);
  // base が 1880/1900 年に収録するセルビア
  assert(sovereignFiefExclusionReason(2692353) !== null);
  assert(sovereignFiefExclusionReason(2692716) !== null);
  // 収録対象
  assertEquals(sovereignFiefExclusionReason(2829140), null);
  assertEquals(sovereignFiefExclusionReason(2696816), null);
});

// ---------------------------------------------------------------------------
// FeatureCollection の組み立て（純粋関数）
// ---------------------------------------------------------------------------

Deno.test("buildYearCollection: properties は既存オーバーレイと同じ形", () => {
  const tagged = [relationFromAllowlist(2929116)];
  const geometries = new Map([[2929116, withSquare(2929116, 25.0, 44.5)]]);
  const { fc } = buildYearCollection(tagged, geometries, 1600);
  assertEquals(fc.features.length, 1);
  assertEquals(fc.features[0].properties, {
    NAME: "Principality of Wallachia",
    ADMIN_LEVEL: 4,
    OHM_RELATION_ID: 2929116,
    START_DATE: "1538",
    END_DATE: "1829-09-14",
  });
});

Deno.test("buildYearCollection: メタデータに出典・欠損を記録する", () => {
  const tagged = [
    relationFromAllowlist(2849499),
    relationFromAllowlist(2929116), // ジオメトリ未取得
  ];
  const geometries = new Map([[2849499, withSquare(2849499, 34.0, 45.0)]]);
  const { metadata } = buildYearCollection(tagged, geometries, 1650);
  assertEquals(metadata.source, "OpenHistoricalMap");
  assertEquals(metadata.license, "CC0-1.0");
  assertEquals(metadata.year, 1650);
  assertEquals(metadata.featureCount, 1);
  assertEquals(metadata.relationsWithoutGeometry, [2929116]);
});

Deno.test("buildYearCollection: 表示名を OHM 名から変えたエントリは drift 扱いにしない", () => {
  // Grand Duchy of Moscow の OHM 名は "Grand Principality of Moscow
  // (1392-1478)"。表示名（base の呼称に合わせた NAME）との差は意図した設計で
  // あり、drift は実測した ohmName と現在のタグの差だけを見る。
  const tagged = [relationFromAllowlist(2890623)];
  const geometries = new Map([[2890623, withSquare(2890623, 37.0, 55.0)]]);
  const { fc, metadata } = buildYearCollection(tagged, geometries, 1400);
  assertEquals(fc.features[0].properties?.NAME, "Grand Duchy of Moscow");
  assertEquals(metadata.tagDrift, {});
});

Deno.test("sovereignFiefTagDrift: 記録側の欠損は literal undefined でなくプレースホルダで出る（#220 AC2）", () => {
  // 現存政体（アンドラ 2739874）は許可リストに endDate を持たない。OHM が
  // 後から end_date タグを付けると drift になるが、その差分文で記録側の
  // undefined が生の文字列 "undefined" として埋め込まれてはならない
  // （実測側と同じ "(欠損)" プレースホルダで出す）。
  const entry = SOVEREIGN_FIEF_ALLOWLIST[2739874];
  assertEquals(entry.endDate, undefined);
  const withEndDate = relation(2739874, {
    "name:en": entry.ohmName,
    admin_level: String(entry.adminLevel),
    start_date: entry.startDate,
    end_date: "1960-03-17",
  });
  const drift = sovereignFiefTagDrift(withEndDate);
  assert(drift !== null);
  assert(drift.includes("end_date"), drift);
  assert(!drift.includes("undefined"), `literal undefined が混入: ${drift}`);
  assert(drift.includes("(欠損)"), drift);
});

Deno.test("buildYearCollection: OHM 側の存続区間が実測から動いたら記録する", () => {
  const drifted = relation(2929116, {
    "name:en": "Wallachia",
    admin_level: "4",
    start_date: "1538",
    end_date: "1900", // 実測は 1829-09-14
  });
  const geometries = new Map([[2929116, withSquare(2929116, 25.0, 44.5)]]);
  const { metadata } = buildYearCollection([drifted], geometries, 1600);
  assert(
    Object.keys(metadata.tagDrift).includes("2929116"),
    JSON.stringify(metadata.tagDrift),
  );
});

// ---------------------------------------------------------------------------
// CLI 引数（#188 と同じ年指定方式。既存年の生成物バイト不変の構造的保証）
// ---------------------------------------------------------------------------

Deno.test("parseTargetYears: 引数なしは全対象年", () => {
  assertEquals(parseTargetYears([]), [...SOVEREIGN_FIEF_YEARS]);
});

Deno.test("parseTargetYears: 年を並べるとその年だけ（昇順・重複除去）", () => {
  assertEquals(parseTargetYears(["1880", "1815", "1880"]), [1815, 1880]);
});

Deno.test("parseTargetYears: 対象外の年はエラー", () => {
  // #191 で 1914 も対象年になった（サンマリノ・アンドラ・モナコ・
  // リヒテンシュタインは base に無い）ため、対象外はスナップショット年ですら
  // ない年（900 / 1850）だけになる。
  assertEquals(parseTargetYears(["1914"]), [1914]);
  assertThrows(() => parseTargetYears(["900"]));
  assertThrows(() => parseTargetYears(["1850"]));
});

// ---------------------------------------------------------------------------
// 生成物（data/sovereign_fiefs_<year>.geojson）
// ---------------------------------------------------------------------------

async function readSovereignFiefs(year: number): Promise<
  FeatureCollection & { metadata?: Record<string, unknown> }
> {
  return JSON.parse(
    await Deno.readTextFile(`data/sovereign_fiefs_${year}.geojson`),
  );
}

Deno.test("生成物: 対象年ごとにファイルがあり期待 ID 集合と一致する", async () => {
  for (const year of SOVEREIGN_FIEF_YEARS) {
    const fc = await readSovereignFiefs(year);
    assertEquals(fc.type, "FeatureCollection");
    const ids = fc.features.map((f) => Number(f.properties?.OHM_RELATION_ID))
      .sort((a, b) => a - b);
    assertEquals(ids, sovereignFiefIdsForYear(year), String(year));
    for (const feature of fc.features) {
      assert(typeof feature.properties?.NAME === "string");
      assert(
        feature.geometry.type === "Polygon" ||
          feature.geometry.type === "MultiPolygon",
        `${year} の ${feature.properties?.NAME} がポリゴンでない`,
      );
    }
  }
});

Deno.test("生成物: サイズ上限内・自己交差なし・出典メタデータを持つ", async () => {
  for (const year of SOVEREIGN_FIEF_YEARS) {
    const text = await Deno.readTextFile(
      `data/sovereign_fiefs_${year}.geojson`,
    );
    assert(
      new TextEncoder().encode(text).length <= SOVEREIGN_FIEF_SIZE_LIMIT_BYTES,
      `${year} がサイズ上限超過`,
    );
    const fc = JSON.parse(text) as FeatureCollection & {
      metadata?: { source?: string; license?: string };
    };
    assertEquals(fc.metadata?.source, "OpenHistoricalMap");
    assertEquals(fc.metadata?.license, "CC0-1.0");
    for (const feature of fc.features) {
      if (
        feature.geometry.type !== "Polygon" &&
        feature.geometry.type !== "MultiPolygon"
      ) continue;
      assertEquals(
        selfIntersectionPoints(feature.geometry).length,
        0,
        `${year} の ${feature.properties?.NAME} に自己交差`,
      );
    }
  }
});

Deno.test("生成物（flat）: 対象年ごとにファイルがあり重なりが解消されている", async () => {
  for (const year of SOVEREIGN_FIEF_YEARS) {
    const fc = JSON.parse(
      await Deno.readTextFile(`data/sovereign_fiefs_flat_${year}.geojson`),
    ) as FeatureCollection;
    assertEquals(
      fc.features.length,
      sovereignFiefIdsForYear(year).length,
      String(year),
    );
  }
});

/**
 * #191 AC4: 微小国家が simplify（shrinkToLimit のトレランス 0.005 度 ≒ 556 m）と
 * 微小破片除去（MIN_PART_AREA_M2 = 1 km² / MIN_PART_MEAN_WIDTH_M ≒ 111 m）を
 * 通しても消えないことの下限。
 *
 * 2026-08 実測（生成前に build-data.ts の shrinkToLimit へ通した測定値）:
 * サンマリノ 6.98〜58.3 km²（最小は 0301〜1100 の区画）・アンドラ 465 km²・
 * モナコ 17.9 km²（1861 年以降）/ 73.1 km²（1815〜1861 はマントン・
 * ロクブリュヌを含む）・リヒテンシュタイン 153 km²。いずれも面積下限の 7 倍
 * 以上あり、面積下限の例外機構は要らない（Issue #191 が懸念した「モナコは
 * 面積下限すれすれ」は、OHM のモナコが陸域 2.1 km² ではなく領海を含む
 * 17.9 km² の区画であるため起きない）。
 * 下限 5 km² は最小値（6.98 km²）の直下に置き、簡略化の悪化で面が痩せたら
 * 気付けるようにする。
 */
const MICROSTATE_MIN_AREA_M2 = 5_000_000;

Deno.test("生成物: 微小国家 4 政体が simplify と微小破片除去を通しても残る（#191 AC4）", async () => {
  for (const [name, years] of Object.entries(MICROSTATE_YEARS)) {
    for (const year of years) {
      const fc = await readSovereignFiefs(year);
      const features = fc.features.filter((f) => f.properties?.NAME === name);
      assertEquals(features.length, 1, `${name} が ${year} 年の生成物に無い`);
      const geometry = features[0].geometry;
      assert(
        geometry.type === "Polygon" || geometry.type === "MultiPolygon",
        `${name} ${year} がポリゴンでない`,
      );
      // 面積が保たれている（点に潰れていない）
      const km2 = area(features[0]) / 1e6;
      assert(
        km2 * 1e6 >= MICROSTATE_MIN_AREA_M2,
        `${name} ${year} の面積が ${km2.toFixed(3)} km² まで痩せている`,
      );
      // 微小破片除去（面積下限 + 平均幅下限）をもう一度通しても 1 パートも
      // 落ちない = 生成物は閾値の内側に安全余裕を持って収まっている
      const dropped = dropTinyRings(geometry);
      assertEquals(
        dropped.droppedParts,
        0,
        `${name} ${year} のパートが微小破片として落ちる`,
      );
      assert(dropped.geometry !== null, `${name} ${year} の面が残らない`);
      for (const part of polygonParts(geometry)) {
        assert(
          area({ type: "Polygon", coordinates: [part[0]] }) >= MIN_PART_AREA_M2,
          `${name} ${year} に面積下限未満のパートがある`,
        );
      }
    }
  }
});

/**
 * #220 AC1: flat の残存下限は絶対値ではなく「raw（差引前）面積に対する比率」。
 *
 * `buildSovereignFiefFlat` は主権政体から他系統（france / italy / hre /
 * cliopatria / britain）の flat を差し引くため、オーバーレイの再生成で
 * 微小国家に重なりが生じると flat 段で大きく削られうる（例: アンドラ
 * 465 km² → 6 km² なら絶対下限 5 km² は通ってしまう）。
 *
 * 2026-08 実測（生成物の flat 面積 / raw 面積）: 微小国家 4 政体 × 全対象年の
 * 最小残存比率は 92.2%（San Marino 1300 年。次点 93.7% = San Marino 1400 年、
 * 94.9% = Andorra 1279/1300 年。それ以外はすべて 97% 以上）。下限 80% は
 * 実測最小値から 12 ポイント超の余裕を置きつつ、「面積の大半を失う」劣化
 * （上記アンドラのシナリオは残存 1.3%）を確実に検出する。
 */
const MICROSTATE_FLAT_MIN_RETENTION = 0.8;

/**
 * 微小国家 1 政体の flat 残存検査（純関数）。raw（差引前）の生成物と flat の
 * 生成物を比べ、政体が見つからない・残存比率が下限未満なら違反メッセージを、
 * 満たせば null を返す。
 */
function microstateFlatRetentionViolation(
  rawFc: FeatureCollection,
  flatFc: FeatureCollection,
  name: string,
  year: number,
): string | null {
  const rawFeatures = rawFc.features.filter((f) => f.properties?.NAME === name);
  if (rawFeatures.length !== 1) return `${name} が ${year} 年の生成物に無い`;
  const flatFeatures = flatFc.features.filter((f) =>
    f.properties?.NAME === name
  );
  if (flatFeatures.length !== 1) return `${name} が ${year} 年の flat に無い`;
  const rawKm2 = area(rawFeatures[0]) / 1e6;
  const flatKm2 = area(flatFeatures[0]) / 1e6;
  if (flatKm2 < rawKm2 * MICROSTATE_FLAT_MIN_RETENTION) {
    return `${name} ${year} が flat 化で ${rawKm2.toFixed(3)} km² から ` +
      `${flatKm2.toFixed(3)} km²（残存 ${
        (flatKm2 / rawKm2 * 100).toFixed(1)
      }%）まで削られている`;
  }
  return null;
}

/** 正方形 1 つの Feature（残存検査のフィクスチャ用。sizeDeg は 1 辺の度数） */
function squareFcOf(
  name: string,
  west: number,
  south: number,
  sizeDeg: number,
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { NAME: name },
      geometry: {
        type: "Polygon",
        coordinates: [[
          [west, south],
          [west + sizeDeg, south],
          [west + sizeDeg, south + sizeDeg],
          [west, south + sizeDeg],
          [west, south],
        ]],
      },
    }],
  };
}

Deno.test("microstateFlatRetentionViolation: 大きく削られた flat を検出する（#220 AC1）", () => {
  // raw はアンドラ相当の 0.2 度四方（実測 ≒ 363 km²）。flat が 0.03 度四方
  // （≒ 8.2 km²）まで削られると、旧検査の絶対下限 5 km² は上回るが raw の
  // 2.3% しか残っていない = Issue #220 の「465 km² → 6 km²」シナリオ相当
  const raw = squareFcOf("Andorra", 1.5, 42.4, 0.2);
  const clipped = squareFcOf("Andorra", 1.5, 42.4, 0.03);
  assert(
    microstateFlatRetentionViolation(raw, clipped, "Andorra", 1914) !== null,
    "raw の大半を失った flat が検出されない",
  );
  // 現行データ相当の軽い差引（残存 ≒ 92% = 実測の最小値）は違反にしない
  const lightlyClipped = squareFcOf(
    "Andorra",
    1.5,
    42.4,
    0.2 * Math.sqrt(0.92),
  );
  assertEquals(
    microstateFlatRetentionViolation(raw, lightlyClipped, "Andorra", 1914),
    null,
  );
  // 政体が flat に見つからない場合も違反
  const empty: FeatureCollection = { type: "FeatureCollection", features: [] };
  assert(
    microstateFlatRetentionViolation(raw, empty, "Andorra", 1914) !== null,
  );
});

Deno.test("生成物（flat）: 微小国家は他系統との差引後も raw 面積の大半が残る（#191 AC4 / #220 AC1）", async () => {
  for (const [name, years] of Object.entries(MICROSTATE_YEARS)) {
    for (const year of years) {
      const rawFc = await readSovereignFiefs(year);
      const flatFc = JSON.parse(
        await Deno.readTextFile(`data/sovereign_fiefs_flat_${year}.geojson`),
      ) as FeatureCollection;
      assertEquals(
        microstateFlatRetentionViolation(rawFc, flatFc, name, year),
        null,
      );
    }
  }
});
