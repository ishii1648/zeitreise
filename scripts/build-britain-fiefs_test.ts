/**
 * scripts/build-britain-fiefs.ts のテスト（TASK-151）。
 * 前半は純粋関数のテストでネットワークに依存しない（AC4）:
 * 取得対象が「リレーション ID の静的な許可リスト × 年 × 存続区間の包含判定」
 * だけで決まることを、年ごとの期待 ID 集合を固定して検証する。
 * 後半は生成物 data/britain_fiefs_<year>.geojson そのものを検証する（AC1〜3, 6）。
 */

import { assert, assertEquals } from "@std/assert";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { SNAPSHOT_YEARS } from "../src/config.ts";
import type { OhmRelation } from "./build-france-fiefs.ts";
import { FRANCE_FIEF_NAMES } from "./build-france-fiefs.ts";
import { HRE_FIEF_NAMES } from "./build-hre-fiefs.ts";
import { ITALY_FIEF_NAMES } from "./build-italy-fiefs.ts";
import {
  BRITAIN_FIEF_ALLOWLIST,
  BRITAIN_FIEF_BBOX,
  BRITAIN_FIEF_EXCLUDED_IDS,
  BRITAIN_FIEF_EXCLUSIONS,
  BRITAIN_FIEF_SIZE_LIMIT_BYTES,
  BRITAIN_FIEF_YEARS,
  britainFiefExclusionReason,
  britainFiefIdsForYear,
  buildYearCollection,
  selectBritainFiefsForYear,
} from "./build-britain-fiefs.ts";
import { fiefUnionOf } from "./build-fief-dedupe.ts";
import { resolveOverlaps } from "./build-fief-flat.ts";
import { selfIntersectionPoints } from "./clean-polygons.ts";

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
  const entry = BRITAIN_FIEF_ALLOWLIST[id];
  return relation(id, {
    "name:en": entry.name,
    admin_level: "2",
    start_date: entry.startDate,
    end_date: entry.endDate,
  });
}

// ---------------------------------------------------------------------------
// 設定値
// ---------------------------------------------------------------------------

Deno.test("取得範囲は実測に使ったブリテン諸島の bbox をピン留めする", () => {
  assertEquals(BRITAIN_FIEF_BBOX, [49.5, -11.0, 61.2, 2.2]);
});

Deno.test("対象年は SNAPSHOT_YEARS の部分集合で 1000〜1700 の 12 年（AC1）", () => {
  assertEquals([...BRITAIN_FIEF_YEARS], [
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
  for (const year of BRITAIN_FIEF_YEARS) {
    assert(SNAPSHOT_YEARS.includes(year), `${year} が SNAPSHOT_YEARS に無い`);
  }
});

Deno.test("サイズ上限は既存パイプラインと同じ 200 KB", () => {
  assertEquals(BRITAIN_FIEF_SIZE_LIMIT_BYTES, 200 * 1000);
});

// ---------------------------------------------------------------------------
// 静的許可リスト（AC4）
// ---------------------------------------------------------------------------

Deno.test("許可リストは実測した 21 リレーションをピン留めする", () => {
  const ids = Object.keys(BRITAIN_FIEF_ALLOWLIST).map(Number).sort((a, b) =>
    a - b
  );
  assertEquals(ids, [
    2693293, // Isle of Man
    2697729, // Kingdom of Ireland (1660-1800)
    2798863, // Southern Powys
    2800203, // Kingdom of Gwynedd (1165-1282)
    2802030, // Irish Catholic Confederation
    2802031, // Kingdom of Ireland (1542-1641)
    2803536, // Brycheiniog
    2803537, // Deheubarth
    2804440, // Rhwng Gwy a Hafren
    2805408, // Kingdom of Glywysing/Morgannwg
    2805938, // Kingdom of Powys
    2851756, // Sodor
    2851759, // Kingdom of Dublin
    2869802, // Kingdom of Strathclyde
    2869805, // Kingdom of Galloway
    2874011, // Kingdom of Gwynedd (785-1165)
    2875840, // Kingdom of Leinster
    2875843, // Lordship of Eastern Meath
    2875844, // Lordship of Western Meath
    2875845, // Lordship of Meath
    2875846, // Kingdom of Meath
  ]);
});

Deno.test("許可リストの全件がいずれかの対象年で有効（死んだエントリが無い）", () => {
  const active = new Set<number>();
  for (const year of BRITAIN_FIEF_YEARS) {
    for (const id of britainFiefIdsForYear(year)) active.add(id);
  }
  const dead = Object.keys(BRITAIN_FIEF_ALLOWLIST).map(Number).filter((id) =>
    !active.has(id)
  );
  assertEquals(dead, []);
});

Deno.test("許可リストは除外対象と交差しない", () => {
  for (const id of Object.keys(BRITAIN_FIEF_EXCLUDED_IDS).map(Number)) {
    assert(
      BRITAIN_FIEF_ALLOWLIST[id] === undefined,
      `${id} が許可リストと除外リストの両方にある`,
    );
  }
});

Deno.test("除外の分類キーはすべて根拠文を持ち、未使用の分類が無い（AC5）", () => {
  const used = new Set(Object.values(BRITAIN_FIEF_EXCLUDED_IDS));
  // ID に紐づかない分類（対象年の打ち切り・OHM 側の欠落）は許可リスト側の
  // 設計判断の記録として存在する
  used.add("baseAlreadySplitFrom1715");
  used.add("principalityOfWalesAbsent");
  for (const key of used) {
    assert(
      typeof BRITAIN_FIEF_EXCLUSIONS[key] === "string" &&
        BRITAIN_FIEF_EXCLUSIONS[key].length > 0,
      `${key} の根拠が無い`,
    );
  }
  for (const key of Object.keys(BRITAIN_FIEF_EXCLUSIONS)) {
    assert(used.has(key), `分類 ${key} がどの除外にも使われていない`);
  }
});

Deno.test("許可リストの名前は仏・独・伊の許可リストと重複しない（二重塗り防止）", () => {
  const others = new Set([
    ...FRANCE_FIEF_NAMES,
    ...HRE_FIEF_NAMES,
    ...ITALY_FIEF_NAMES,
  ]);
  for (const entry of Object.values(BRITAIN_FIEF_ALLOWLIST)) {
    assert(
      !others.has(entry.name),
      `${entry.name} が他系統の許可リストと重複している`,
    );
  }
});

// ---------------------------------------------------------------------------
// 年ごとの包含判定（AC4: 静的許可リスト × 存続区間だけで決まる）
// ---------------------------------------------------------------------------

Deno.test("britainFiefIdsForYear: 年ごとの対象 ID 集合が実測どおりに固定される", () => {
  const expected: Record<number, number[]> = {
    1000: [
      2803536,
      2803537,
      2804440,
      2805408,
      2805938,
      2851756,
      2851759,
      2869802,
      2874011,
      2875840,
      2875846,
    ],
    1100: [
      2803537,
      2804440,
      2805938,
      2851756,
      2851759,
      2869805,
      2874011,
      2875840,
      2875846,
    ],
    1200: [2798863, 2800203, 2851756, 2869805, 2875840, 2875845],
    1279: [2798863, 2800203, 2875840, 2875843, 2875844],
    1300: [2875840, 2875843, 2875844],
    1400: [2693293, 2875840],
    1492: [2693293, 2875840],
    1500: [2693293, 2875840],
    1530: [2693293, 2875840],
    1600: [2693293, 2802031, 2875840],
    1650: [2693293, 2802030],
    1700: [2693293, 2697729],
  };
  for (const year of BRITAIN_FIEF_YEARS) {
    assertEquals(britainFiefIdsForYear(year), expected[year], String(year));
  }
});

Deno.test("britainFiefIdsForYear: 全対象年に収録対象がある（AC1）", () => {
  for (const year of BRITAIN_FIEF_YEARS) {
    assert(britainFiefIdsForYear(year).length > 0, `${year} が空`);
  }
});

Deno.test("1000 年にウェールズ諸王国とアイルランド諸王国が含まれる（AC2）", () => {
  const ids = new Set(britainFiefIdsForYear(1000));
  // ウェールズ: Gwynedd / Powys / Deheubarth / Brycheiniog / Morgannwg
  for (const id of [2874011, 2805938, 2803537, 2803536, 2805408]) {
    assert(ids.has(id), `ウェールズ ${id} が 1000 年に無い`);
  }
  // アイルランド: Dublin / Leinster / Meath
  for (const id of [2851759, 2875840, 2875846]) {
    assert(ids.has(id), `アイルランド ${id} が 1000 年に無い`);
  }
});

Deno.test("1600 / 1650 / 1700 年にアイルランドの政体が含まれる（AC3）", () => {
  // Kingdom of Ireland（1542-06-18..1641-10-23）
  assert(britainFiefIdsForYear(1600).includes(2802031));
  // Irish Catholic Confederation（1642..1652-05）
  assert(britainFiefIdsForYear(1650).includes(2802030));
  // Kingdom of Ireland（1660-04-04..1800-12-31）
  assert(britainFiefIdsForYear(1700).includes(2697729));
});

Deno.test("存続区間は年単位の閉区間（開始年・終了年の両端を含む）", () => {
  // Rhwng Gwy a Hafren は 0900..1100 なので 1100 に含まれ、1101 には含まれない
  assert(britainFiefIdsForYear(1100).includes(2804440));
  assert(!britainFiefIdsForYear(1101).includes(2804440));
  // Sodor は 0877..1265 なので 1279 には含まれない
  assert(!britainFiefIdsForYear(1279).includes(2851756));
});

// ---------------------------------------------------------------------------
// リレーションの選択（純粋関数・ネットワーク非依存）
// ---------------------------------------------------------------------------

Deno.test("selectBritainFiefsForYear: 許可リスト外・期間外の ID を落とす", () => {
  const elements = [
    relationFromAllowlist(2875840), // Kingdom of Leinster 0800..1603
    relationFromAllowlist(2802031), // Kingdom of Ireland 1542..1641（1000 年は期間外）
    // 許可リスト外（base が担う Kingdom of Scotland）
    relation(2802009, {
      "name:en": "Kingdom of Scotland",
      admin_level: "2",
      start_date: "0843",
      end_date: "1707",
    }),
  ];
  assertEquals(
    selectBritainFiefsForYear(elements, 1000).map((e) => e.id),
    [2875840],
  );
});

Deno.test("selectBritainFiefsForYear: 判定は静的な存続区間で決まりタグに依存しない（AC4）", () => {
  // OHM 側のタグが変わっても（欠けても）静的許可リストの区間が判定を決める
  const bareTags = relation(2875840, { "name:en": "Kingdom of Leinster" });
  assertEquals(
    selectBritainFiefsForYear([bareTags], 1000).map((e) => e.id),
    [2875840],
  );
  const driftedTags = relation(2875840, {
    "name:en": "Kingdom of Leinster",
    start_date: "1601",
    end_date: "1610",
  });
  assertEquals(
    selectBritainFiefsForYear([driftedTags], 1000).map((e) => e.id),
    [2875840],
  );
});

Deno.test("selectBritainFiefsForYear: 並びは表示名の昇順で入力順に依存しない", () => {
  const elements = [
    relationFromAllowlist(2875846), // Kingdom of Meath
    relationFromAllowlist(2851759), // Kingdom of Dublin
    relationFromAllowlist(2874011), // Kingdom of Gwynedd
  ];
  const names = (list: OhmRelation[]) =>
    selectBritainFiefsForYear(list, 1000).map((e) => e.id);
  assertEquals(names(elements), [2851759, 2874011, 2875846]);
  assertEquals(names([...elements].reverse()), [2851759, 2874011, 2875846]);
});

Deno.test("britainFiefExclusionReason: 除外 ID は許可リストに紛れても落ちる", () => {
  // base が担う主権政体（Kingdom of Scotland / England / Commonwealth）
  assert(britainFiefExclusionReason(2802009) !== null);
  assert(britainFiefExclusionReason(2802012) !== null);
  assert(britainFiefExclusionReason(2802013) !== null);
  // 1815 年以降の UK 構成国（admin_level 4）
  assert(britainFiefExclusionReason(2697543) !== null);
  assert(britainFiefExclusionReason(2697728) !== null);
  // 収録対象
  assertEquals(britainFiefExclusionReason(2875840), null);
  assertEquals(britainFiefExclusionReason(2693293), null);
});

// ---------------------------------------------------------------------------
// FeatureCollection の組み立て（純粋関数）
// ---------------------------------------------------------------------------

Deno.test("buildYearCollection: properties は france_fiefs と同じ形（AC6 の前提）", () => {
  const tagged = [relationFromAllowlist(2875840)];
  const geometries = new Map([[2875840, withSquare(2875840, -7.0, 52.5)]]);
  const { fc } = buildYearCollection(tagged, geometries, 1000);
  assertEquals(fc.features.length, 1);
  assertEquals(fc.features[0].properties, {
    NAME: "Kingdom of Leinster",
    ADMIN_LEVEL: 2,
    OHM_RELATION_ID: 2875840,
    START_DATE: "0800",
    END_DATE: "1603",
  });
});

Deno.test("buildYearCollection: メタデータに出典・欠損を記録する", () => {
  const tagged = [
    relationFromAllowlist(2875840),
    relationFromAllowlist(2875846), // ジオメトリ未取得
  ];
  const geometries = new Map([[2875840, withSquare(2875840, -7.0, 52.5)]]);
  const { metadata } = buildYearCollection(tagged, geometries, 1000);
  assertEquals(metadata.source, "OpenHistoricalMap");
  assertEquals(metadata.license, "CC0-1.0");
  assertEquals(metadata.year, 1000);
  assertEquals(metadata.featureCount, 1);
  assertEquals(metadata.relationsWithoutGeometry, [2875846]);
});

Deno.test("buildYearCollection: OHM 側の存続区間が実測から動いたら記録する", () => {
  const drifted = relation(2875840, {
    "name:en": "Kingdom of Leinster",
    admin_level: "2",
    start_date: "0800",
    end_date: "1650", // 実測は 1603
  });
  const geometries = new Map([[2875840, withSquare(2875840, -7.0, 52.5)]]);
  const { metadata } = buildYearCollection([drifted], geometries, 1000);
  assert(
    Object.keys(metadata.tagDrift).includes("2875840"),
    JSON.stringify(metadata.tagDrift),
  );
});

// ---------------------------------------------------------------------------
// 生成物（data/britain_fiefs_<year>.geojson）
// ---------------------------------------------------------------------------

async function readBritainFiefs(year: number): Promise<
  FeatureCollection & { metadata?: Record<string, unknown> }
> {
  return JSON.parse(
    await Deno.readTextFile(`data/britain_fiefs_${year}.geojson`),
  );
}

Deno.test("生成物: 対象年ごとにファイルがあり feature を持つ（AC1）", async () => {
  for (const year of BRITAIN_FIEF_YEARS) {
    const fc = await readBritainFiefs(year);
    assertEquals(fc.type, "FeatureCollection");
    assert(fc.features.length > 0, `${year} の feature が 0 件`);
    for (const feature of fc.features) {
      assert(typeof feature.properties?.NAME === "string");
      assert(
        feature.geometry.type === "Polygon" ||
          feature.geometry.type === "MultiPolygon",
      );
    }
  }
});

Deno.test("生成物: 1000 年にウェールズ・アイルランド諸王国が含まれる（AC2）", async () => {
  const names = new Set(
    (await readBritainFiefs(1000)).features.map((f) =>
      String(f.properties?.NAME)
    ),
  );
  for (
    const expected of [
      "Kingdom of Gwynedd",
      "Kingdom of Powys",
      "Deheubarth",
      "Kingdom of Dublin",
      "Kingdom of Leinster",
      "Kingdom of Meath",
    ]
  ) {
    assert(names.has(expected), `1000 年に ${expected} が無い`);
  }
});

Deno.test("生成物: 1600 / 1650 / 1700 年にアイルランドの政体が含まれる（AC3）", async () => {
  const namesOf = async (year: number) =>
    new Set(
      (await readBritainFiefs(year)).features.map((f) =>
        String(f.properties?.NAME)
      ),
    );
  assert((await namesOf(1600)).has("Kingdom of Ireland"));
  assert((await namesOf(1650)).has("Irish Catholic Confederation"));
  assert((await namesOf(1700)).has("Kingdom of Ireland"));
});

Deno.test("生成物: 収録は許可リストの ID だけで、feature 数は包含判定と一致する", async () => {
  for (const year of BRITAIN_FIEF_YEARS) {
    const fc = await readBritainFiefs(year);
    const expected = britainFiefIdsForYear(year);
    const got = fc.features.filter((f) =>
      f.properties?.OHM_RELATION_ID !== undefined
    ).map((f) => Number(f.properties?.OHM_RELATION_ID))
      .sort((a, b) => a - b);
    // ジオメトリ未取得で欠ける可能性は metadata.relationsWithoutGeometry に
    // 現れる。実測では全リレーションのジオメトリが健全なので完全一致を要求する
    assertEquals(got, expected, String(year));
  }
});

Deno.test("生成物: 出典・ライセンスが metadata に記録されている", async () => {
  for (const year of BRITAIN_FIEF_YEARS) {
    const fc = await readBritainFiefs(year);
    assertEquals(
      fc.metadata?.source,
      year === 1300
        ? "OpenHistoricalMap; Shepherd, Historical Atlas (1911), p.74"
        : "OpenHistoricalMap",
    );
    assertEquals(fc.metadata?.license, "CC0-1.0");
    assertEquals(fc.metadata?.year, year);
  }
});

Deno.test("生成物: サイズ上限内", async () => {
  for (const year of BRITAIN_FIEF_YEARS) {
    const path = `data/britain_fiefs_${year}.geojson`;
    const bytes =
      new TextEncoder().encode(await Deno.readTextFile(path)).length;
    assert(
      bytes <= BRITAIN_FIEF_SIZE_LIMIT_BYTES,
      `${path} が ${bytes} バイトで上限超過`,
    );
  }
});

// ---------------------------------------------------------------------------
// 既存チェーンでの処理（AC6）
// ---------------------------------------------------------------------------

Deno.test("生成物: build-fief-flat の重なり解消がそのまま適用できる（AC6）", async () => {
  for (const year of BRITAIN_FIEF_YEARS) {
    const raw = await readBritainFiefs(year);
    const warnings: string[] = [];
    const { fc } = resolveOverlaps(
      raw,
      (m) => warnings.push(m),
      "keep-smaller",
    );
    assertEquals(fc.features.length, raw.features.length, String(year));
    assertEquals(warnings, [], String(year));
  }
});

Deno.test("生成物: build-fief-dedupe の union 生成がそのまま適用できる（AC6）", async () => {
  for (const year of BRITAIN_FIEF_YEARS) {
    const raw = await readBritainFiefs(year);
    assert(fiefUnionOf(raw) !== null, `${year} の union が作れない`);
  }
});

Deno.test("flat 生成物: britain_fiefs_flat_<year>.geojson が存在し自己交差が無い（AC6）", async () => {
  for (const year of BRITAIN_FIEF_YEARS) {
    const fc: FeatureCollection = JSON.parse(
      await Deno.readTextFile(`data/britain_fiefs_flat_${year}.geojson`),
    );
    assert(fc.features.length > 0, `${year} の flat が空`);
    for (const feature of fc.features) {
      const geometry = feature.geometry as Polygon | MultiPolygon;
      assertEquals(
        selfIntersectionPoints(geometry).length,
        0,
        `${year} の ${String(feature.properties?.NAME)} に自己交差`,
      );
    }
  }
});

Deno.test("Shepherd Principality: 同年だけ生成し、PD原図とCC0転写を追跡できる", async () => {
  const trace = JSON.parse(
    await Deno.readTextFile("scripts/shepherd-principality-1300.json"),
  );
  for (const year of [1279, 1300, 1400]) {
    const generated = buildYearCollection([], new Map(), year).fc.features;
    assertEquals(generated.length, year === 1300 ? 1 : 0);
    if (year !== 1300) continue;
    const actual = (await readBritainFiefs(year)).features.find((f) =>
      f.properties?.NAME === "Principality of Wales"
    )!;
    assertEquals(actual, generated[0]);
    assertEquals(actual.properties?.SUBJECTO, "England");
    assertEquals(actual.properties?.ATTRIBUTION.license, "CC0-1.0");
    assertEquals(actual.properties?.ATTRIBUTION.imageSha256, trace.imageSha256);
    assertEquals(trace.imageSize, [2479, 3975]);
    assertEquals(
      trace.pdfSha256,
      "1e4896a3f55ac0073a81ac00c8ac66afcfbca7e50197f48f1085de86e978a825",
    );
    assertEquals(selfIntersectionPoints(actual.geometry as MultiPolygon), []);
  }
  const { originPixel, originLonLat, pixelsPerDegree, controlPoints } =
    trace.calibration;
  for (const [x, y, lon, lat] of controlPoints) {
    const deltaLon = originLonLat[0] +
      (x - originPixel[0]) / pixelsPerDegree[0] - lon;
    const deltaLat = originLonLat[1] +
      (y - originPixel[1]) / pixelsPerDegree[1] - lat;
    const km = Math.hypot(
      deltaLon * 111.32 * Math.cos(lat * Math.PI / 180),
      deltaLat * 111.32,
    );
    assert(km < 4, `経緯線交点の較正残差 ${km} km`);
  }
});

Deno.test("Principality: March・Flint・南東ウェールズを含めない", async () => {
  const { default: contains } = await import("@turf/boolean-point-in-polygon");
  const feature = (await readBritainFiefs(1300)).features.find((f) =>
    f.properties?.NAME === "Principality of Wales"
  ) as import("geojson").Feature<MultiPolygon>;
  for (
    const position of [[-4.4, 53.28], [-4.15, 52.87], [-4, 52.3], [-4.4, 51.96]]
  ) {
    assert(contains(position, feature), `Principality内の確認点 ${position}`);
  }
  for (
    const position of [[-3.18, 51.48], [-2.75, 52.7], [-3.15, 53.25], [
      -3.15,
      52.56,
    ], [-4.1, 52.5]]
  ) {
    assert(!contains(position, feature), `対象外の確認点 ${position}`);
  }
});

Deno.test("1300年のウェールズ以外の既存外枠線を変更しない", async () => {
  const outlines: FeatureCollection = JSON.parse(
    await Deno.readTextFile("data/base_outline_1300.geojson"),
  );
  const untouched = outlines.features.filter((f) =>
    f.properties?.NAME !== null && f.properties?.NAME !== "English territory"
  );
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(untouched)),
    ),
  );
  assertEquals(
    Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""),
    "a26b455a3379ba0e5450ab1e1b7b636cb2109f0fe1922ca25c406242f5e54eb4",
  );
});
