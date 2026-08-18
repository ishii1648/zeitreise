import { assert, assertEquals } from "@std/assert";
import area from "@turf/area";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { featureCollection } from "@turf/helpers";
import intersect from "@turf/intersect";
import union from "@turf/union";
import type {
  Feature,
  FeatureCollection,
  MultiPolygon,
  Polygon,
  Position,
} from "geojson";
import {
  segmentLengthKm,
  VERY_LONG_SEGMENT_KM,
} from "../src/approximate_borders.ts";
import {
  borrowedEntryFor,
  borrowSupersededReason,
  CLIOPATRIA_ARCHIVE_MEMBER,
  CLIOPATRIA_ARCHIVE_SHA256,
  CLIOPATRIA_ARCHIVE_URL,
  CLIOPATRIA_BORROWED_YEARS,
  CLIOPATRIA_COMPOSITE_PARENTS,
  CLIOPATRIA_EXCLUSIONS,
  CLIOPATRIA_FIEF_YEARS,
  CLIOPATRIA_FRANCE_FIEF_NAMES,
  CLIOPATRIA_HRE_FIEF_NAMES,
  CLIOPATRIA_MOLDAVIA_INTERVALS,
  CLIOPATRIA_NAME_OVERRIDES,
  CLIOPATRIA_SOURCE_COMMIT,
  CLIOPATRIA_SOURCE_DOI,
  CLIOPATRIA_SOURCE_LICENSE,
  CLIOPATRIA_SOURCE_NAME,
  cliopatriaExclusionReason,
  type CliopatriaProperties,
  cliopatriaRawPathFor,
  compositeChildEntryFor,
  compositeLeafMismatchReason,
  compositeParentEntryFor,
  containsYear,
  fiefPropertiesOf,
  isCompositeName,
  nonLeafNames,
  selectForYear,
} from "./build-cliopatria-fiefs.ts";

/** テスト用の Cliopatria 生 properties を作る */
function props(
  over: Partial<CliopatriaProperties> = {},
): CliopatriaProperties {
  return {
    Name: "County of Toulouse",
    FromYear: 990,
    ToYear: 1027,
    Area: 21359,
    Type: "POLITY",
    Wikipedia: "County of Toulouse",
    Wikidata: "Q1194109",
    SeshatID: "fr_capetian_k_1",
    Components: "",
    MemberOf: "(Kingdom of France)",
    ...over,
  };
}

/** properties だけを持つダミー feature（selectForYear は幾何を見ない） */
function feature(over: Partial<CliopatriaProperties> = {}): Feature {
  return {
    type: "Feature",
    properties: props(over) as unknown as Record<string, unknown>,
    geometry: { type: "Polygon", coordinates: [] },
  };
}

// ---------------------------------------------------------------------------
// ピン留め（AC #2: コミット / DOI で固定されたソースから決定的に生成する）
// ---------------------------------------------------------------------------

Deno.test("ソースはコミット SHA とアーカイブの SHA-256 で二重にピン留めされる", () => {
  assertEquals(CLIOPATRIA_SOURCE_COMMIT.length, 40);
  assert(/^[0-9a-f]{40}$/.test(CLIOPATRIA_SOURCE_COMMIT));
  assert(/^[0-9a-f]{64}$/.test(CLIOPATRIA_ARCHIVE_SHA256));
  // 取得 URL がピン留めコミットを含む（ブランチ名や latest を指していない）
  assert(
    CLIOPATRIA_ARCHIVE_URL.includes(CLIOPATRIA_SOURCE_COMMIT),
    "取得 URL がピン留めコミットを含まない",
  );
  assert(CLIOPATRIA_ARCHIVE_URL.endsWith(".zip"));
  assert(CLIOPATRIA_ARCHIVE_MEMBER.endsWith(".geojson"));
  // CC BY 4.0 の帰属で使う DOI とライセンス識別子
  assertEquals(CLIOPATRIA_SOURCE_LICENSE, "CC BY 4.0");
  assert(CLIOPATRIA_SOURCE_DOI.startsWith("10.5281/zenodo."));
});

// ---------------------------------------------------------------------------
// 年代区間の選択規則（不規則な FromYear / ToYear を決定的に扱う）
// ---------------------------------------------------------------------------

Deno.test("年代区間は包含判定だけで採り、外挿も最近傍も行わない", () => {
  // 実データの区間はスナップショット年をまたぐ形で不規則に切られている
  assert(containsYear(props({ FromYear: 1279, ToYear: 1284 }), 1279));
  assert(containsYear(props({ FromYear: 1294, ToYear: 1304 }), 1300));
  assert(containsYear(props({ FromYear: 990, ToYear: 1146 }), 1000));
  assert(containsYear(props({ FromYear: 990, ToYear: 1146 }), 1100));
  // 端点は含む
  assert(containsYear(props({ FromYear: 1000, ToYear: 1000 }), 1000));
  // 区間外は採らない（近い区間へ寄せる救済をしない = 出典の主張を超えない）
  assert(!containsYear(props({ FromYear: 1301, ToYear: 1400 }), 1300));
  assert(!containsYear(props({ FromYear: 990, ToYear: 1002 }), 1100));
});

Deno.test("同じ領邦に複数の区間が当たったら最も狭い区間を採る（決定的）", () => {
  const at1279 = { Name: "County of Foix" } as const;
  const narrow = feature({ ...at1279, FromYear: 1279, ToYear: 1284, Area: 1 });
  const wide = feature({ ...at1279, FromYear: 1200, ToYear: 1300, Area: 2 });
  // 入力順に依らず同じ結果になること
  const a = selectForYear([wide, narrow], 1279);
  const b = selectForYear([narrow, wide], 1279);
  assertEquals(a.length, 1);
  assertEquals(JSON.stringify(a), JSON.stringify(b));
  // 出力の properties は写像後の形（START_DATE / END_DATE）
  assertEquals((a[0].properties as { START_DATE: string }).START_DATE, "1279");
  assertEquals((a[0].properties as { END_DATE: string }).END_DATE, "1284");
});

Deno.test("selectForYear は NAME 昇順の決定的な並びを返す", () => {
  const years = 1279;
  const picked = selectForYear([
    feature({ Name: "County of Foix", FromYear: 1279, ToYear: 1293 }),
    feature({ Name: "County of Auvergne", FromYear: 1272, ToYear: 1332 }),
    feature({ Name: "County of Armagnac", FromYear: 1279, ToYear: 1332 }),
  ], years);
  assertEquals(
    picked.map((f) => (f.properties as { NAME: string }).NAME),
    ["County of Armagnac", "County of Auvergne", "County of Foix"],
  );
});

// ---------------------------------------------------------------------------
// 複合体・残余カテゴリの扱い（そのまま描くと巨大な塗りが既存レイヤーを覆う）
// ---------------------------------------------------------------------------

Deno.test("丸括弧で囲まれた名前は封臣を含む複合体として判定する", () => {
  assert(isCompositeName("(Kingdom of France)"));
  assert(isCompositeName("(Holy Roman Empire)"));
  assert(
    isCompositeName("(Allegiance of Duchy of Aquitaine to Kingdom of France)"),
  );
  assert(!isCompositeName("Kingdom of France"));
  assert(!isCompositeName("County of Blôis"));
});

Deno.test("複合体・RELATION・残余カテゴリは許可リストに関わらず落ちる", () => {
  // (Kingdom of France) は 1000 年で 420,259 km²、単独の Kingdom of France は
  // 49,071 km²。複合体を描くと王国全体が 1 枚の塗りになり王領が読めなくなる。
  assert(
    cliopatriaExclusionReason(props({ Name: "(Kingdom of France)" })) !== null,
  );
  // RELATION は上位関係の複合体で、ジオメトリは関係先の合併と同一
  assert(
    cliopatriaExclusionReason(
      props({
        Type: "RELATION",
        Name: "(Vassalage of Kingdom of Bohemia to Holy Roman Empire)",
      }),
    ) !== null,
  );
  // 残余カテゴリ（1279 年で 518,669 km²）は数百の領邦の寄せ集めで、
  // 1 つの塗り・1 つのラベル・1 つの色で描くと事実に反する
  assert(
    cliopatriaExclusionReason(
      props({ Name: "Holy Roman Empire Minor States" }),
    ) !==
      null,
  );
  // 許可リストに載る領邦は落ちない
  assertEquals(cliopatriaExclusionReason(props()), null);
  assertEquals(
    cliopatriaExclusionReason(props({ Name: "Duchy of Bavaria" })),
    null,
  );
});

Deno.test("除外の分類は全て根拠テキストを持ち、除外理由はその分類から引く", () => {
  for (const [key, reason] of Object.entries(CLIOPATRIA_EXCLUSIONS)) {
    assert(reason.length > 0, `${key} の除外根拠が空`);
  }
  const reasons = new Set(Object.values(CLIOPATRIA_EXCLUSIONS));
  for (
    const name of [
      "(Kingdom of France)",
      "Holy Roman Empire Minor States",
    ]
  ) {
    const reason = cliopatriaExclusionReason(props({ Name: name }));
    assert(reason !== null && reasons.has(reason), `${name} の理由が分類外`);
  }
});

// ---------------------------------------------------------------------------
// 適用範囲（許可リスト）: OHM の欠落だけを埋める
// ---------------------------------------------------------------------------

Deno.test("対象年は仏 1000〜1300 と帝国 1279〜1492 の和で昇順", () => {
  assertEquals([...CLIOPATRIA_FIEF_YEARS].sort((a, b) => a - b), [
    ...CLIOPATRIA_FIEF_YEARS,
  ]);
  assertEquals(CLIOPATRIA_FIEF_YEARS, [
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
  // 許可リストが挙げる年は全て対象年に含まれる（生成されないファイルを指さない）
  for (
    const [name, years] of [
      ...Object.entries(CLIOPATRIA_FRANCE_FIEF_NAMES),
      ...Object.entries(CLIOPATRIA_HRE_FIEF_NAMES),
    ]
  ) {
    assert(years.length > 0, `${name} の対象年が空`);
    for (const year of years) {
      assert(
        CLIOPATRIA_FIEF_YEARS.includes(year),
        `${name} の ${year} 年が対象年に無い`,
      );
    }
  }
});

Deno.test("#450: モルダヴィアは Name × target × interval × SeshatID の全点一致だけを採る", () => {
  for (const [year, from, to, seshatId] of CLIOPATRIA_MOLDAVIA_INTERVALS) {
    const exact = feature({
      Name: "Principality of Moldavia",
      FromYear: from,
      ToYear: to,
      SeshatID: seshatId,
    });
    assertEquals(selectForYear([exact], year).length, 1, `${year}: exact`);
    assertEquals(
      selectForYear([
        feature({
          Name: "Principality of Moldavia",
          FromYear: from - 1,
          ToYear: to,
          SeshatID: seshatId,
        }),
      ], year).length,
      0,
      `${year}: interval mismatch`,
    );
    assertEquals(
      selectForYear([
        feature({
          Name: "Principality of Moldavia",
          FromYear: from,
          ToYear: to,
          SeshatID: `${seshatId}-wrong`,
        }),
      ], year).length,
      0,
      `${year}: SeshatID mismatch`,
    );
  }
});

Deno.test("#450: 1600 年は三公国合成面を落とし [1595-1599] を借用する", () => {
  const composite = feature({
    Name: "Principality of Moldavia",
    FromYear: 1600,
    ToYear: 1601,
    Area: 256733.09,
    SeshatID: "md_moldavia_principality_2",
  });
  const previous = feature({
    Name: "Principality of Moldavia",
    FromYear: 1595,
    ToYear: 1599,
    Area: 81506.35,
    SeshatID: "md_moldavia_principality_2",
  });
  const picked = selectForYear([composite, previous], 1600);
  assertEquals(picked.length, 1);
  assertEquals(picked[0].properties?.START_DATE, "1595");
  assertEquals(picked[0].properties?.END_DATE, "1599");
  assertEquals(picked[0].properties?.SUBJECTO, "Ottoman Empire");
  assertEquals(
    (picked[0].properties?.BORROWED_FROM as Record<string, unknown>).targetYear,
    1600,
  );
  const entry = CLIOPATRIA_BORROWED_YEARS.find((e) => e.targetYear === 1600)!;
  assertEquals(borrowSupersededReason([composite, previous], entry), null);
  assert(
    borrowSupersededReason([
      composite,
      feature({
        Name: "Principality of Moldavia",
        FromYear: 1599,
        ToYear: 1602,
        SeshatID: "md_moldavia_principality_2",
      }),
    ], entry) !== null,
    "別の同年面が追加されたら借用の置換を要求する",
  );
});

Deno.test("許可リストは仏と帝国で互いに素（同じ領邦が 2 つの帰属を持たない）", () => {
  const france = new Set(Object.keys(CLIOPATRIA_FRANCE_FIEF_NAMES));
  for (const name of Object.keys(CLIOPATRIA_HRE_FIEF_NAMES)) {
    assert(!france.has(name), `${name} が仏・帝国の両方に載っている`);
  }
});

Deno.test("帝国側の通常収録は 1200 年を持たない（Cliopatria が帝国を一枚岩でモデル化するため）", () => {
  // 1200 年のボヘミア王国は上流の隣接区間 [1202-1215] からの**年借用**
  // （CLIOPATRIA_BORROWED_YEARS・ADR-0039）で入る。通常収録の許可リストは
  // 「上流の区間が実際にその年を覆う」ものだけを挙げる規則なので 1200 年を
  // 持たない。両者を別の許可リストに分けておくことで、借用が包含判定の
  // 緩和として他の領邦・他の年へ広がらない（#346）。
  for (const years of Object.values(CLIOPATRIA_HRE_FIEF_NAMES)) {
    assert(!years.includes(1200), "帝国側の許可リストに 1200 年がある");
    assert(
      !years.includes(1000) && !years.includes(1100),
      "帝国側 1000/1100 は OHM が担う",
    );
  }
});

Deno.test("仏側は 1400 / 1492 を持たない（base のフランス勢力が実態に一致する年代）", () => {
  for (const years of Object.values(CLIOPATRIA_FRANCE_FIEF_NAMES)) {
    assert(!years.includes(1400) && !years.includes(1492));
  }
});

Deno.test("許可リストの年は Cliopatria 側の区間で有効な年だけを挙げる", () => {
  // AC #5 の対象。実測した区間（タスク説明の実測値）と一致すること
  assertEquals(CLIOPATRIA_HRE_FIEF_NAMES["Duchy of Bavaria"], [
    1279,
    1300,
    1400,
    1492,
  ]);
  assertEquals(CLIOPATRIA_FRANCE_FIEF_NAMES["County of Toulouse"], [
    1000,
    1100,
    1200,
  ]);
  // 王領（domaine royal）。1279 / 1300 の Cliopatria "Kingdom of France" は
  // 206,111 / 242,840 km² と王国規模になり base のフランス勢力と重複するため採らない
  assertEquals(CLIOPATRIA_FRANCE_FIEF_NAMES["Kingdom of France"], [
    1000,
    1100,
    1200,
  ]);
});

// ---------------------------------------------------------------------------
// properties の写像（既存 fief と同型 + Cliopatria 固有の出所）
// ---------------------------------------------------------------------------

Deno.test("仏諸侯領の properties は france_fiefs と同型（SUBJECTO を持たない）", () => {
  const mapped = fiefPropertiesOf(props(), 1000);
  assertEquals(mapped.NAME, "County of Toulouse");
  assertEquals(mapped.START_DATE, "0990");
  assertEquals(mapped.END_DATE, "1027");
  assertEquals(mapped.SUBJECTO, undefined);
  assertEquals(mapped.PARTOF, undefined);
  // 出所（feature 単位で Cliopatria まで辿れる）
  assertEquals(mapped.CLIOPATRIA_SESHAT_ID, "fr_capetian_k_1");
  assertEquals(mapped.WIKIDATA, "Q1194109");
});

Deno.test("帝国領邦の properties は hre_fiefs と同型（SUBJECTO / PARTOF を持つ）", () => {
  const mapped = fiefPropertiesOf(
    props({ Name: "Duchy of Bavaria", MemberOf: "(Holy Roman Empire)" }),
    1279,
  );
  assertEquals(mapped.NAME, "Duchy of Bavaria");
  assertEquals(mapped.SUBJECTO, "Holy Roman Empire");
  assertEquals(mapped.PARTOF, "Holy Roman Empire");
});

Deno.test("王領は上流の Kingdom of France と別名にして base の王国と取り違えない", () => {
  // 上流の Name は "Kingdom of France" だが、この feature が指すのは王領
  // （複合体 "(Kingdom of France)" が王国全体を別に持つ）。base の勢力名と
  // 同じ NAME を使うと色キー・ラベル・パネルが王国と衝突する。
  assertEquals(
    CLIOPATRIA_NAME_OVERRIDES["Kingdom of France"],
    "Royal Domain of France",
  );
  const mapped = fiefPropertiesOf(props({ Name: "Kingdom of France" }), 1000);
  assertEquals(mapped.NAME, "Royal Domain of France");
  // 上流の名前は追跡できるよう残す
  assertEquals(mapped.CLIOPATRIA_NAME, "Kingdom of France");
});

Deno.test("START_DATE / END_DATE は 4 桁ゼロ詰めで既存 fief の表記に揃う", () => {
  const mapped = fiefPropertiesOf(props({ FromYear: 990, ToYear: 1002 }), 1000);
  assertEquals(mapped.START_DATE, "0990");
  assertEquals(mapped.END_DATE, "1002");
});

// ---------------------------------------------------------------------------
// 生成物（ネットワーク非依存。生成済みファイルを読む）
// ---------------------------------------------------------------------------

async function readCollection(path: string): Promise<
  FeatureCollection & { metadata?: Record<string, unknown> }
> {
  return JSON.parse(await Deno.readTextFile(path)) as
    & FeatureCollection
    & { metadata?: Record<string, unknown> };
}

/** ポリゴン系ジオメトリを持つ feature だけを取り出す */
function polygonalFeatures(
  fc: FeatureCollection,
): Feature<Polygon | MultiPolygon>[] {
  return fc.features.filter((f) =>
    f.geometry?.type === "Polygon" || f.geometry?.type === "MultiPolygon"
  ) as Feature<Polygon | MultiPolygon>[];
}

Deno.test("生成物は対象年ぶん存在し、metadata がピン留めを保持する", async () => {
  for (const year of CLIOPATRIA_FIEF_YEARS) {
    const fc = await readCollection(cliopatriaRawPathFor(year));
    assert(fc.features.length > 0, `${year} 年の feature が 0 件`);
    assertEquals(fc.metadata?.year, year);
    assertEquals(fc.metadata?.commit, CLIOPATRIA_SOURCE_COMMIT);
    assertEquals(fc.metadata?.license, CLIOPATRIA_SOURCE_LICENSE);
    assertEquals(fc.metadata?.archiveSha256, CLIOPATRIA_ARCHIVE_SHA256);
  }
});

Deno.test("生成物の feature は許可リストの領邦だけで、その年に許可された年である", async () => {
  for (const year of CLIOPATRIA_FIEF_YEARS) {
    const fc = await readCollection(cliopatriaRawPathFor(year));
    for (const f of fc.features) {
      const upstream = f.properties?.CLIOPATRIA_NAME as string;
      // #352 / ADR-0040: 複合体の親（base 置換専用）と leaf 子区画は別の
      // 許可リスト（CLIOPATRIA_COMPOSITE_PARENTS）が支配する。刻印
      // （CLIOPATRIA_COMPOSITE）と許可リストの両方が一致することを確かめる
      // （どちらか一方だけでは、構造的な除外を素通りした feature を見逃す）。
      const composite = f.properties?.CLIOPATRIA_COMPOSITE as
        | string
        | undefined;
      if (composite !== undefined) {
        const entry = CLIOPATRIA_COMPOSITE_PARENTS.find((e) =>
          e.targetYear === year
        );
        assert(entry !== undefined, `${year}: 複合体の許可リストが無い`);
        if (composite === "parent") {
          assertEquals(upstream, entry.name, `${year}: 親の上流 Name`);
        } else {
          assertEquals(composite, "child", `${year}: ${upstream} の刻印`);
          assert(
            entry.childNames.includes(upstream),
            `${year}: ${upstream} が子区画の許可リストに無い`,
          );
        }
        assertEquals(
          f.properties?.CLIOPATRIA_BASE_POWER,
          entry.basePowerName,
          `${year}: ${upstream} の置換先 base 勢力`,
        );
        continue;
      }
      // 年借用（ADR-0039）の feature だけは通常の許可年に載らない。借用で
      // 入ったことは BORROWED_FROM の有無と借用許可リストの両方で確かめる
      // （どちらか一方だけでは、包含判定を素通りした feature を見逃す）。
      const borrowed = CLIOPATRIA_BORROWED_YEARS.find((entry) =>
        entry.name === upstream && entry.targetYear === year
      );
      if (borrowed !== undefined) {
        assert(
          f.properties?.BORROWED_FROM !== undefined,
          `${year}: ${upstream} が借用なのに BORROWED_FROM を持たない`,
        );
        continue;
      }
      const moldavia = CLIOPATRIA_MOLDAVIA_INTERVALS.find(([target]) =>
        target === year
      );
      if (upstream === "Principality of Moldavia" && moldavia !== undefined) {
        assertEquals(Number(f.properties?.START_DATE), moldavia[1]);
        assertEquals(Number(f.properties?.END_DATE), moldavia[2]);
        assertEquals(f.properties?.CLIOPATRIA_SESHAT_ID, moldavia[3]);
        continue;
      }
      const allowed = CLIOPATRIA_FRANCE_FIEF_NAMES[upstream] ??
        CLIOPATRIA_HRE_FIEF_NAMES[upstream];
      assert(allowed !== undefined, `${year}: ${upstream} が許可リストに無い`);
      assert(
        f.properties?.BORROWED_FROM === undefined,
        `${year}: ${upstream} は借用許可リストに無いのに BORROWED_FROM を持つ`,
      );
      assert(
        allowed.includes(year),
        `${year}: ${upstream} がこの年に許可されていない`,
      );
    }
  }
});

Deno.test("AC #5: 1000 / 1100 年にアキテーヌ・トゥールーズ・王領が入る", async () => {
  for (const year of [1000, 1100]) {
    const names = new Set(
      (await readCollection(cliopatriaRawPathFor(year))).features.map((f) =>
        f.properties?.NAME as string
      ),
    );
    for (
      const name of [
        "Duchy of Aquitaine",
        "County of Toulouse",
        "Royal Domain of France",
      ]
    ) {
      assert(names.has(name), `${year} 年に ${name} が無い`);
    }
  }
});

Deno.test("AC #4: 配信する flat は他の 3 系統・base 塗りと二重に塗らない", async () => {
  // 「二重塗りが無い」を目視ではなくデータで担保する。既存レイヤー同士の残存
  // 重なり（座標丸め由来）は 1000〜1492 の全年・全組み合わせで最大 0.074 km²
  // なので、その 100 倍を上限にしても「幾何的に排他化されている」ことしか
  // 通らない。実測の最大は 1000 / 1100 年の County of Vermandois ×
  // Duchy of Lower Lotharingia の 1.83 km²（くびれ解消の副作用。
  // scripts/build-fief-flat.ts の unpinch の解説を参照）。
  const LIMIT_KM2 = 8;
  const offenders: string[] = [];
  for (const year of CLIOPATRIA_FIEF_YEARS) {
    const clio = polygonalFeatures(
      await readCollection(`data/cliopatria_fiefs_flat_${year}.geojson`),
    );
    for (
      const other of [
        `france_fiefs_flat_${year}`,
        `hre_fiefs_flat_${year}`,
        `italy_fiefs_flat_${year}`,
        `europe_flat_${year}`,
      ]
    ) {
      let fc: FeatureCollection;
      try {
        fc = await readCollection(`data/${other}.geojson`);
      } catch {
        continue; // その年に存在しないレイヤー
      }
      let total = 0;
      for (const a of clio) {
        for (const b of polygonalFeatures(fc)) {
          const overlap = intersect(featureCollection([a, b]));
          if (overlap === null) continue;
          total += area(overlap) / 1e6;
        }
      }
      if (total > LIMIT_KM2) {
        offenders.push(`${year} × ${other}: ${total.toFixed(3)} km²`);
      }
    }
  }
  assertEquals(offenders, []);
});

Deno.test("AC #5: 1279〜1492 年の帝国にバイエルン公領が入る", async () => {
  for (const year of [1279, 1300, 1400, 1492]) {
    const names = new Set(
      (await readCollection(cliopatriaRawPathFor(year))).features.map((f) =>
        f.properties?.NAME as string
      ),
    );
    assert(names.has("Duchy of Bavaria"), `${year} 年にバイエルン公領が無い`);
  }
});

// ---------------------------------------------------------------------------
// #321: 1300 年の County of Blôis（上流 [1294-1332]）の除外と、
// 他年代・他 feature の不変性
// ---------------------------------------------------------------------------

/** ジオメトリの頂点数（閉点も数える） */
function vertexCount(feature: Feature): number {
  const g = feature.geometry as Polygon | MultiPolygon;
  return g.type === "Polygon"
    ? g.coordinates.reduce((n, ring) => n + ring.length, 0)
    : g.coordinates.reduce(
      (n, poly) => n + poly.reduce((m, ring) => m + ring.length, 0),
      0,
    );
}

/** ジオメトリの指紋（座標を 1 つでも変えたら変わる） */
async function geometryDigest(feature: Feature): Promise<string> {
  const json = JSON.stringify(feature.geometry);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(json),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** 生成物から NAME で feature を引く */
function featureNamed(
  fc: FeatureCollection,
  name: string,
): Feature | undefined {
  return fc.features.find((f) => f.properties?.NAME === name);
}

/** flat（配信物）のパス */
function cliopatriaFlatPathFor(year: number): string {
  return `data/cliopatria_fiefs_flat_${year}.geojson`;
}

Deno.test("#321: 1300 年の County of Blôis は Cliopatria 許可対象から外れている", () => {
  const years = CLIOPATRIA_FRANCE_FIEF_NAMES["County of Blôis"];
  assert(years !== undefined, "County of Blôis が許可リストから消えている");
  assert(
    !years.includes(1300),
    "1300 年が許可されたまま（上流 [1294-1332] は閉点を除き 5 頂点・3,658 km² の" +
      "粗い面で、細長い四角形として描かれる）",
  );
  // 他の年は従来どおり収録する（#321 の修正の境界）
  assertEquals([...years], [1000, 1100, 1200, 1279]);
});

Deno.test("#321: 1300 年の生成物・配信物のどちらにも County of Blôis が含まれない", async () => {
  for (
    const path of [cliopatriaRawPathFor(1300), cliopatriaFlatPathFor(1300)]
  ) {
    const fc = await readCollection(path);
    assertEquals(
      fc.features.filter((f) =>
        f.properties?.NAME === "County of Blôis" ||
        f.properties?.CLIOPATRIA_NAME === "County of Blôis"
      ).length,
      0,
      `${path} に County of Blôis が残っている`,
    );
  }
  // metadata の収録一覧からも消えていること（追跡記録と生成物の一致）
  const raw = await readCollection(cliopatriaRawPathFor(1300));
  const selected = raw.metadata?.selected as Array<{ name: string }>;
  assertEquals(
    selected.filter((s) => s.name === "County of Blôis").length,
    0,
    "metadata.selected に County of Blôis が残っている",
  );
});

Deno.test("#321: 1000 / 1100 / 1200 / 1279 年の County of Blôis は 1 頂点も変わっていない", async () => {
  // 生成物の実測値（#321 の修正前に採取）。座標が 1 つでも変われば落ちる。
  // year, kind, START_DATE, END_DATE, 頂点数, ジオメトリ指紋
  const expected: Array<
    [number, "raw" | "flat", string, string, number, string]
  > = [
    [1000, "raw", "0990", "1027", 32, "86847a7b85b39229"],
    [1000, "flat", "0990", "1027", 45, "87fe673f9621a548"],
    [1100, "raw", "1085", "1110", 59, "49683d910efd222a"],
    [1100, "flat", "1085", "1110", 40, "e4d3cad370a56f1d"],
    [1200, "raw", "1169", "1205", 20, "8a5b2864013e163a"],
    [1200, "flat", "1169", "1205", 42, "f673bdaba6b231c4"],
    [1279, "raw", "1250", "1293", 16, "a6f5942008dfc648"],
    [1279, "flat", "1250", "1293", 26, "d9ccdf80b995cc7b"],
  ];
  for (const [year, kind, from, to, verts, digest] of expected) {
    const path = kind === "raw"
      ? cliopatriaRawPathFor(year)
      : cliopatriaFlatPathFor(year);
    const f = featureNamed(await readCollection(path), "County of Blôis");
    assert(f !== undefined, `${path} に County of Blôis が無い`);
    assertEquals(f.properties?.START_DATE, from, `${path} の START_DATE`);
    assertEquals(f.properties?.END_DATE, to, `${path} の END_DATE`);
    assertEquals(vertexCount(f), verts, `${path} の頂点数`);
    assertEquals(await geometryDigest(f), digest, `${path} のジオメトリ`);
  }
});

Deno.test("#321 / #352: 1300 年の Cliopatria feature の一覧とジオメトリを固定する", async () => {
  // 生成物の実測値（#321 の修正前に採取した表を #352 で更新）。
  // NAME, kind, 頂点数, ジオメトリ指紋
  //
  // #352 での更新理由:
  // - ポーランドの複合体（親 1 + leaf 子 11）が入った（ADR-0040）。親は
  //   base 置換専用なので raw にだけ現れ、flat には出ない。
  // - Kingdom of Bohemia の flat は 500 → 508 頂点。同じレイヤー内の重なり
  //   解消（resolveOverlaps "keep-smaller"）で、より小さいポーランド諸公国が
  //   ボヘミア王国から差し引かれたため（上流 Cliopatria は 1294-1304 の
  //   Kingdom of Bohemia にシロンスク・小ポーランドを含めている）。
  // - 仏諸侯領（Armagnac / Auvergne / Foix / Nevers / Périgord / Aquitaine）と
  //   Duchy of Bavaria / Margraviate of Brandenburg は 1 頂点も変わらない
  //   （#352 の変更がポーランド系に閉じていることの固定）。
  const expected: Array<[string, "raw" | "flat", number, string]> = [
    ["(Duchies of Poland)", "raw", 135, "8b1b59ce2344a944"],
    ["County of Armagnac", "raw", 17, "ae95bb90ad843f91"],
    ["County of Auvergne", "raw", 42, "9e750115edd85ddd"],
    ["County of Foix", "raw", 26, "9f2d91a439898f2d"],
    ["County of Nevers", "raw", 33, "d2741893403640f4"],
    ["County of Périgord", "raw", 10, "990d99a3e3450aa9"],
    ["Duchies of Poland", "raw", 58, "afa016d233587133"],
    ["Duchy of Aquitaine", "raw", 11, "3857adc3da97d688"],
    ["Duchy of Bavaria", "raw", 68, "09c927fe8d17c791"],
    ["Duchy of Bytom", "raw", 14, "7caf7b2ca2cdc8cf"],
    ["Duchy of Greater Poland", "raw", 28, "31da570fd879b93b"],
    ["Duchy of Głogów", "raw", 15, "6e8925787bb3e80d"],
    ["Duchy of Jawor", "raw", 5, "762c6fbe474fa978"],
    ["Duchy of Legnica", "raw", 21, "273760351d01eab4"],
    ["Duchy of Masovia", "raw", 26, "63efdadf22d5033a"],
    ["Duchy of Opole", "raw", 17, "95f216563ff790d2"],
    ["Duchy of Racibórz", "raw", 18, "0d11880759571acc"],
    ["Duchy of Sandomierz", "raw", 23, "259a9058c2a070da"],
    ["Duchy of Silesia", "raw", 47, "7955c1f9f6d3231e"],
    ["Kingdom of Bohemia", "raw", 88, "b9809f99a53094a5"],
    ["Margraviate of Brandenburg", "raw", 55, "1c88fb750d144818"],
    ["County of Armagnac", "flat", 17, "3e95cd4561d64e17"],
    ["County of Auvergne", "flat", 55, "fc87d43764c26f40"],
    ["County of Foix", "flat", 26, "f767460712c092ef"],
    ["County of Nevers", "flat", 65, "7b4876475f23e945"],
    ["County of Périgord", "flat", 10, "21f9b1e8bda99699"],
    ["Duchies of Poland", "flat", 58, "76ee1fad84b69c24"],
    ["Duchy of Aquitaine", "flat", 14, "61f5a8f81b3d7bba"],
    ["Duchy of Bavaria", "flat", 606, "d00c792e4411d274"],
    ["Duchy of Bytom", "flat", 14, "edc873d47f1839b2"],
    ["Duchy of Greater Poland", "flat", 28, "a2554933d34e2df3"],
    ["Duchy of Głogów", "flat", 15, "ebd1df51460148ab"],
    ["Duchy of Jawor", "flat", 5, "53d9e94e131e4791"],
    ["Duchy of Legnica", "flat", 21, "9356c5b1dcd20529"],
    ["Duchy of Masovia", "flat", 26, "563f203793396997"],
    ["Duchy of Opole", "flat", 61, "706625e35fc0be08"],
    ["Duchy of Racibórz", "flat", 24, "b52cd9548d7838ab"],
    ["Duchy of Sandomierz", "flat", 23, "7cdf4531cfdad02a"],
    ["Duchy of Silesia", "flat", 47, "3e46d41345ca05f8"],
    ["Kingdom of Bohemia", "flat", 508, "8edacd479bad986a"],
    ["Margraviate of Brandenburg", "flat", 406, "040c2777c3676f79"],
  ];
  for (const [name, kind, verts, digest] of expected) {
    const path = kind === "raw"
      ? cliopatriaRawPathFor(1300)
      : cliopatriaFlatPathFor(1300);
    const f = featureNamed(await readCollection(path), name);
    assert(f !== undefined, `${path} に ${name} が無い`);
    assertEquals(vertexCount(f), verts, `${path} の ${name} の頂点数`);
    assertEquals(await geometryDigest(f), digest, `${path} の ${name}`);
  }
  // 一覧そのものが増減していないこと（除外は Blôis 1 件だけ）
  for (const kind of ["raw", "flat"] as const) {
    const path = kind === "raw"
      ? cliopatriaRawPathFor(1300)
      : cliopatriaFlatPathFor(1300);
    const names = (await readCollection(path)).features
      .map((f) => String(f.properties?.NAME))
      .sort();
    assertEquals(
      names,
      expected.filter((e) => e[1] === kind).map((e) => e[0]).sort(),
      `${path} の feature 一覧`,
    );
  }
});

// ---------------------------------------------------------------------------
// #346: 上流の隣接区間からの年借用（ADR-0039）
//
// Cliopatria は 1200 年のボヘミアを覆う区間を持たない（Duchy of Bohemia は
// [.. -1002] で終わり、Kingdom of Bohemia は [1202-1215] から始まる）。
// ADR-0039 はこの 2 年の穴に限り、上流の隣接区間の面を座標無改変で借りることを
// 認める。緩めるのは containsYear の包含判定だけで、**許可リストに載せた
// name × targetYear × 区間 × SeshatID が全て一致する 1 件だけ**が対象になる
// （無条件の最近傍・外挿は従来どおり禁止）。
// ---------------------------------------------------------------------------

/** 上流の 1202–1215 区間のボヘミア王国（#346 が借りる実在 feature の写し） */
function bohemiaFeature(over: Partial<CliopatriaProperties> = {}): Feature {
  return feature({
    Name: "Kingdom of Bohemia",
    FromYear: 1202,
    ToYear: 1215,
    Area: 70805.87693192092,
    Wikipedia: "Kingdom of Bohemia",
    Wikidata: "Q42585",
    SeshatID: "cz_bohemian_k_1",
    MemberOf: "(Holy Roman Empire);(Kingdom of Bohemia)",
    ...over,
  });
}

/** selectForYear の結果から NAME で properties を引く */
function propsNamed(
  picked: readonly Feature[],
  name: string,
): Record<string, unknown> | undefined {
  return picked.find((f) => f.properties?.NAME === name)?.properties ??
    undefined;
}

Deno.test("#346: 1200 年のボヘミア王国の借用許可を固定する", () => {
  const entry = CLIOPATRIA_BORROWED_YEARS.find((e) => e.targetYear === 1200)!;
  assertEquals(entry.name, "Kingdom of Bohemia");
  assertEquals(entry.targetYear, 1200);
  assertEquals([entry.fromYear, entry.toYear], [1202, 1215]);
  assertEquals(entry.seshatId, "cz_bohemian_k_1");
  assert(entry.reason.length > 0, "借用の根拠が空");
  // 借用先はスナップショット年でなければ生成物が作られない
  assert(CLIOPATRIA_FIEF_YEARS.includes(entry.targetYear));
  // 年差は 2 年（ADR-0039: 上流の隣接区間からの借用に限る）
  assert(
    entry.fromYear - entry.targetYear <= 2 && entry.fromYear > entry.targetYear,
    "借用元区間が対象年の直後に隣接していない",
  );
});

Deno.test("#346: 1200 年の選択に上流 [1202-1215] のボヘミア王国が BORROWED_FROM 付きで入る", () => {
  const picked = selectForYear([bohemiaFeature()], 1200);
  assertEquals(picked.length, 1);
  const props = propsNamed(picked, "Kingdom of Bohemia");
  assert(props !== undefined, "1200 年にボヘミア王国が入っていない");
  // 上流の区間はそのまま刻む（1200 年の境界だと偽らない）
  assertEquals(props.START_DATE, "1202");
  assertEquals(props.END_DATE, "1215");
  assertEquals(props.SNAPSHOT_YEAR, 1200);
  // 帝国領邦なので宗主は帝国（AC: SUBJECTO / PARTOF = Holy Roman Empire）
  assertEquals(props.SUBJECTO, "Holy Roman Empire");
  assertEquals(props.PARTOF, "Holy Roman Empire");
  assertEquals(props.CLIOPATRIA_SESHAT_ID, "cz_bohemian_k_1");
  assertEquals(props.BORROWED_FROM, {
    targetYear: 1200,
    fromYear: 1202,
    toYear: 1215,
    dataset: CLIOPATRIA_SOURCE_NAME,
    commit: CLIOPATRIA_SOURCE_COMMIT,
    seshatId: "cz_bohemian_k_1",
    license: CLIOPATRIA_SOURCE_LICENSE,
    reason: CLIOPATRIA_BORROWED_YEARS[0].reason,
  });
});

Deno.test("#346: 借用は name × 対象年 × 区間 × SeshatID が全て一致するときだけ起きる", () => {
  // 区間がずれる（次の区間 [1216-1219] は借りない）
  assertEquals(
    borrowedEntryFor(
      props({
        Name: "Kingdom of Bohemia",
        FromYear: 1216,
        ToYear: 1219,
        SeshatID: "cz_bohemian_k_1",
      }),
      1200,
    ),
    null,
  );
  // SeshatID がずれる（同名でも別政体なら借りない）
  assertEquals(
    borrowedEntryFor(
      props({
        Name: "Kingdom of Bohemia",
        FromYear: 1202,
        ToYear: 1215,
        SeshatID: "cz_bohemian_k_2",
      }),
      1200,
    ),
    null,
  );
  // 名前がずれる（同じ区間でも他の領邦へは波及しない）
  assertEquals(
    borrowedEntryFor(
      props({
        Name: "Duchy of Bavaria",
        FromYear: 1202,
        ToYear: 1215,
        SeshatID: "cz_bohemian_k_1",
      }),
      1200,
    ),
    null,
  );
  // 対象年がずれる（1100 / 1279 へは借用しない）
  for (const year of [1000, 1100, 1279, 1300, 1400, 1492]) {
    assertEquals(
      borrowedEntryFor(
        props({
          Name: "Kingdom of Bohemia",
          FromYear: 1202,
          ToYear: 1215,
          SeshatID: "cz_bohemian_k_1",
        }),
        year,
      ),
      null,
      `${year} 年へ借用が漏れている`,
    );
  }
});

Deno.test("#346: 借用は他の年・他の領邦の選択を変えない", () => {
  // 1200 年以外へ同じ feature を渡しても 0 件（許可リストに 1200 しか無い）
  for (const year of [1000, 1100, 1279, 1300, 1400, 1492]) {
    assertEquals(
      selectForYear([bohemiaFeature()], year).length,
      0,
      `${year} 年に借用 feature が漏れている`,
    );
  }
  // 1279 年の通常収録（実在区間 [1279-1284]）は従来どおり包含判定で入り、
  // 借用の刻印を持たない
  const at1279 = selectForYear(
    [bohemiaFeature({ FromYear: 1279, ToYear: 1284, Area: 80823 })],
    1279,
  );
  assertEquals(at1279.length, 1);
  assertEquals(
    propsNamed(at1279, "Kingdom of Bohemia")?.BORROWED_FROM,
    undefined,
  );
  // 1200 年の仏諸侯領（通常収録）は借用の刻印を持たない
  const france = selectForYear(
    [feature({ Name: "County of Toulouse", FromYear: 1188, ToYear: 1205 })],
    1200,
  );
  assertEquals(france.length, 1);
  assertEquals(
    propsNamed(france, "County of Toulouse")?.BORROWED_FROM,
    undefined,
  );
});

Deno.test("#346: 上流が対象年を直接覆うようになったら借用は失敗して差し替えを促す", () => {
  const entry = CLIOPATRIA_BORROWED_YEARS[0];
  // 現状の上流（借用元区間だけ）では差し替えの必要は無い
  assertEquals(borrowSupersededReason([bohemiaFeature()], entry), null);
  // 対象年を覆う区間が上流に現れたら null ではなくなる（ADR-0033 条件 1:
  // 既存の収録が常に優先する。借用エントリを外して通常収録へ切り替える）
  const superseded = borrowSupersededReason(
    [bohemiaFeature(), bohemiaFeature({ FromYear: 1195, ToYear: 1201 })],
    entry,
  );
  assert(
    superseded !== null && superseded.includes("1195"),
    `上流の新区間を検知できていない: ${superseded}`,
  );
});

Deno.test("#346: 生成物の 1200 年ボヘミア王国が借用の出所を保持する", async () => {
  const raw = await readCollection(cliopatriaRawPathFor(1200));
  const f = featureNamed(raw, "Kingdom of Bohemia");
  assert(f !== undefined, "cliopatria_fiefs_1200 にボヘミア王国が無い");
  assertEquals(f.properties?.START_DATE, "1202");
  assertEquals(f.properties?.END_DATE, "1215");
  assertEquals(f.properties?.SUBJECTO, "Holy Roman Empire");
  assertEquals(f.properties?.PARTOF, "Holy Roman Empire");
  assertEquals(f.properties?.CLIOPATRIA_SESHAT_ID, "cz_bohemian_k_1");
  assertEquals(f.properties?.WIKIDATA, "Q42585");
  const borrowedFrom = f.properties?.BORROWED_FROM as Record<string, unknown>;
  assert(borrowedFrom !== undefined, "BORROWED_FROM が生成物に無い");
  assertEquals(borrowedFrom.targetYear, 1200);
  assertEquals(borrowedFrom.fromYear, 1202);
  assertEquals(borrowedFrom.toYear, 1215);
  assertEquals(borrowedFrom.commit, CLIOPATRIA_SOURCE_COMMIT);
  assertEquals(borrowedFrom.license, CLIOPATRIA_SOURCE_LICENSE);
  assertEquals(borrowedFrom.seshatId, "cz_bohemian_k_1");
  // ファイル単位の追跡（metadata.borrowedFrom。ADR-0033 の追跡可能性）
  const records = raw.metadata?.borrowedFrom as Array<Record<string, unknown>>;
  assert(Array.isArray(records), "metadata.borrowedFrom が無い");
  assertEquals(records.length, 1);
  assertEquals(records[0].name, "Kingdom of Bohemia");
  assertEquals(records[0].targetYear, 1200);
  assertEquals(records[0].fromYear, 1202);
  assertEquals(records[0].toYear, 1215);
});

Deno.test("#346: 借用のない年の生成物は metadata.borrowedFrom を持たない", async () => {
  for (const year of CLIOPATRIA_FIEF_YEARS) {
    if (CLIOPATRIA_BORROWED_YEARS.some((e) => e.targetYear === year)) continue;
    const raw = await readCollection(cliopatriaRawPathFor(year));
    assertEquals(
      raw.metadata?.borrowedFrom,
      undefined,
      `${year} 年に借用記録が付いている`,
    );
    for (const f of raw.features) {
      assertEquals(
        f.properties?.BORROWED_FROM,
        undefined,
        `${year} 年の ${f.properties?.NAME} に借用の刻印がある`,
      );
    }
  }
});

Deno.test("#346: 配信する flat にも借用の出所が残る（ADR-0035: 表示は差引済み派生物）", async () => {
  const flat = await readCollection(cliopatriaFlatPathFor(1200));
  const f = featureNamed(flat, "Kingdom of Bohemia");
  assert(f !== undefined, "cliopatria_fiefs_flat_1200 にボヘミア王国が無い");
  const borrowedFrom = f.properties?.BORROWED_FROM as Record<string, unknown>;
  assert(borrowedFrom !== undefined, "flat 側に BORROWED_FROM が無い");
  assertEquals(borrowedFrom.fromYear, 1202);
  assertEquals(borrowedFrom.toYear, 1215);
  const records = flat.metadata?.borrowedFrom as Array<Record<string, unknown>>;
  assert(Array.isArray(records), "flat の metadata.borrowedFrom が無い");
  assertEquals(records.length, 1);
});

Deno.test("#346: 借用面は OHM のモラヴィアを含まない（より細かい側を残す差引）", async () => {
  // ADR-0026: レイヤーまたぎの重なりは常に Cliopatria 側から差し引く。
  // ブルノ（16.61, 49.19）は OHM の Moravia が担うので、借用したボヘミア王国の
  // flat には含まれない（AC: 二重塗り・二重ピックが無い）。
  const flat = await readCollection(cliopatriaFlatPathFor(1200));
  const bohemia = featureNamed(flat, "Kingdom of Bohemia");
  assert(bohemia !== undefined);
  assert(
    !booleanPointInPolygon(
      [16.61, 49.19],
      bohemia as Feature<Polygon | MultiPolygon>,
    ),
    "ブルノが借用したボヘミア王国の flat に残っている（Moravia と二重塗り）",
  );
  // プラハ（14.42, 50.08）は借用面に残る
  assert(
    booleanPointInPolygon(
      [14.42, 50.08],
      bohemia as Feature<Polygon | MultiPolygon>,
    ),
    "プラハが借用したボヘミア王国の flat に無い",
  );
});

// ---------------------------------------------------------------------------
// #346: ADR-0039 の記述とコードの借用許可リストの一致（乖離の再発検出）
//
// #336 と同じ規律。**コード側が正**で、ADR は追随する。
// ---------------------------------------------------------------------------

const ADR_0039_PATH = "docs/adr/0039-cliopatria-borrowed-upstream-interval.md";
const ADR_0044_PATH = "docs/adr/0044-cliopatria-moldavia-semantic-exclusion.md";

Deno.test("#346: ADR-0039 が借用エントリを追える形で記述している", async () => {
  const generalMarkdown = await Deno.readTextFile(ADR_0039_PATH);
  for (const entry of CLIOPATRIA_BORROWED_YEARS) {
    const markdown = await Deno.readTextFile(
      entry.name === "Principality of Moldavia" ? ADR_0044_PATH : ADR_0039_PATH,
    );
    for (
      const token of [
        entry.name,
        String(entry.targetYear),
        String(entry.fromYear),
        String(entry.toYear),
        entry.seshatId,
      ]
    ) {
      assert(
        markdown.includes(token),
        `ADR-0039 に借用エントリの ${token} が無い`,
      );
    }
  }
  // 帰属表示の追跡可能性（Consequences で明記する契約）
  for (
    const token of [
      CLIOPATRIA_SOURCE_LICENSE,
      "BORROWED_FROM",
      "known-limitations",
    ]
  ) {
    assert(
      generalMarkdown.includes(token),
      `ADR-0039 に ${token} の記述が無い`,
    );
  }
});

Deno.test("#346: ADR-0033 が追補 ADR-0039 への相互参照を持つ", async () => {
  const markdown = await Deno.readTextFile(
    "docs/adr/0033-borrowed-adjacent-year-geometry.md",
  );
  assert(
    markdown.includes("ADR-0039") || markdown.includes("decision-39"),
    "ADR-0033 に ADR-0039 への相互参照が無い",
  );
});

// ---------------------------------------------------------------------------
// #336: ADR-0026「適用範囲」の記述とコードの許可リストの一致（乖離の再発検出）
//
// ADR-0026 は許可リストを「上流の Name → 収録する年」の静的な対応表と定めて
// おり、ADR 本文の適用範囲はその写しである。#321 で 1300 年の County of Blôis
// を除いたとき ADR 側が更新されず乖離した（#336）ため、写しがずれたら落ちる
// テストで固定する。**コード側が正**で、ADR は表を追随させる。
// ---------------------------------------------------------------------------

const ADR_0026_PATH = "docs/adr/0026-cliopatria-second-territory-source.md";

/**
 * ADR-0026 の適用範囲節にある markdown 表から「上流の Name → 収録する年」を読む。
 *
 * 見出し行（`#### 仏諸侯領` / `#### 帝国領邦`）の直後の表だけを見て、次の
 * 見出しで打ち切る。Name は 1 列目のバッククォート、年は 2 列目の 4 桁数字
 * だけから拾う（3 列目の備考には除外年など別の意味の 4 桁が入るため）。
 */
function parseAdrAllowList(
  markdown: string,
  heading: string,
): Record<string, number[]> {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  assert(start >= 0, `${ADR_0026_PATH} に見出し「${heading}」が無い`);
  const parsed: Record<string, number[]> = {};
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) break;
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2) continue;
    const name = cells[0].match(/`([^`]+)`/)?.[1];
    if (name === undefined) continue; // 見出し行・区切り行
    parsed[name] = [...cells[1].matchAll(/\d{4}/g)].map((m) => Number(m[0]));
  }
  return parsed;
}

/** Readonly な許可リストを比較用のプレーンなオブジェクトにする */
function plainAllowList(
  list: Readonly<Record<string, readonly number[]>>,
): Record<string, number[]> {
  return Object.fromEntries(
    Object.entries(list).map(([name, years]) => [name, [...years]]),
  );
}

Deno.test("#336: ADR-0026 の適用範囲の表がコードの許可リストと一致する", async () => {
  const markdown = await Deno.readTextFile(ADR_0026_PATH);
  assertEquals(
    parseAdrAllowList(markdown, "#### 仏諸侯領"),
    plainAllowList(CLIOPATRIA_FRANCE_FIEF_NAMES),
    "ADR-0026 の仏側の表が CLIOPATRIA_FRANCE_FIEF_NAMES とずれている",
  );
  assertEquals(
    parseAdrAllowList(markdown, "#### 帝国領邦"),
    plainAllowList(CLIOPATRIA_HRE_FIEF_NAMES),
    "ADR-0026 の帝国側の表が CLIOPATRIA_HRE_FIEF_NAMES とずれている",
  );
});

Deno.test("#336: ADR-0026 が 1300 年のブロワ伯領の除外を追える形で残している", async () => {
  const markdown = await Deno.readTextFile(ADR_0026_PATH);
  const row = markdown.split("\n").find((line) =>
    line.trim().startsWith("|") && line.includes("County of Blôis")
  );
  assert(row !== undefined, "ADR-0026 に County of Blôis の行が無い");
  assert(
    row.includes("1300") && row.includes("#321"),
    "ADR-0026 の County of Blôis 行に 1300 年の除外と契機（#321）が書かれていない",
  );
});

// ---------------------------------------------------------------------------
// #352 / ADR-0040: Cliopatria の括弧付き複合体を base 主権の外周置換に採る
//
// ADR-0026 は複合体（丸括弧で囲まれた Name）を構造的に除外している。ADR-0040 は
// その適用範囲を「base 主権の外周（europe_<year>.geojson）の置換入力としてのみ」
// 拡張し、発火条件を **name × 年 × 上流区間 × SeshatID の全点一致許可リスト**
// （CLIOPATRIA_COMPOSITE_PARENTS）に限る。子区画は MemberOf の leaf 判定で採る。
// ---------------------------------------------------------------------------

/** 1200 年の親区画（(Duchies of Poland) [1192-1201]）の写し */
function duchiesOfPolandFeature(
  over: Partial<CliopatriaProperties> = {},
): Feature {
  return feature({
    Name: "(Duchies of Poland)",
    FromYear: 1192,
    ToYear: 1201,
    Area: 224655.8662187854,
    Wikipedia: "Duchies of Poland",
    Wikidata: "Q2984183",
    SeshatID: "pl_piast_dyn_2",
    MemberOf: "",
    Components:
      "Duchy of Kuyavia;Duchy of Sandomierz;Duchy of Opole;Duchy of Silesia;" +
      "Duchy of Wrocław;Duchy of Greater Poland",
    ...over,
  });
}

/** 1200 年の leaf 子区画（MemberOf = (Duchies of Poland)）の写し */
function duchyFeature(
  name: string,
  over: Partial<CliopatriaProperties> = {},
): Feature {
  return feature({
    Name: name,
    FromYear: 1192,
    ToYear: 1201,
    Area: 1000,
    Wikipedia: name,
    Wikidata: "Q1",
    SeshatID: "pl_piast_dyn_2",
    MemberOf: "(Duchies of Poland)",
    ...over,
  });
}

Deno.test("#352: 複合体の許可リストは 6 年ぶんで、name × 年 × 区間 × SeshatID を全点持つ", () => {
  assertEquals(
    CLIOPATRIA_COMPOSITE_PARENTS.map((
      e,
    ): [number, string, number, number, string, string, number] => [
      e.targetYear,
      e.name,
      e.fromYear,
      e.toYear,
      e.seshatId,
      e.basePowerName,
      e.childNames.length,
    ]),
    [
      [1000, "(Kingdom of Poland)", 990, 1002, "pl_piast_dyn_1", "Poland", 1],
      [1100, "(Kingdom of Poland)", 1056, 1125, "pl_piast_dyn_1", "Poland", 1],
      [1200, "(Duchies of Poland)", 1192, 1201, "pl_piast_dyn_2", "Poland", 6],
      [1279, "(Duchies of Poland)", 1279, 1284, "pl_piast_dyn_2", "Poland", 9],
      [1300, "(Duchies of Poland)", 1294, 1304, "pl_piast_dyn_2", "Poland", 11],
      [
        1400,
        "(Polish-Lithuania Kingdom)",
        1395,
        1401,
        "pl_jagiellonian_dyn",
        "Poland-Lithuania",
        2,
      ],
    ],
  );
  for (const entry of CLIOPATRIA_COMPOSITE_PARENTS) {
    assert(
      CLIOPATRIA_FIEF_YEARS.includes(entry.targetYear),
      `${entry.targetYear} が対象年に無い`,
    );
    assert(isCompositeName(entry.name), `${entry.name} が複合体名でない`);
    assert(entry.reason.length > 0, `${entry.name} の根拠が空`);
    // 子区画は昇順・重複なしで、親自身を含まない
    assertEquals(
      [...entry.childNames],
      [...entry.childNames].sort(),
      `${entry.targetYear} の childNames が昇順でない`,
    );
    assertEquals(
      new Set(entry.childNames).size,
      entry.childNames.length,
      `${entry.targetYear} の childNames に重複がある`,
    );
    assert(
      !entry.childNames.includes(entry.name),
      `${entry.targetYear} の childNames に親が入っている`,
    );
  }
});

Deno.test("#352: 1400 年の leaf は Kingdom of Poland と Grand Duchy of Lithuania の 2 件で wrapper を含まない", () => {
  const entry = CLIOPATRIA_COMPOSITE_PARENTS.find((e) => e.targetYear === 1400);
  assert(entry !== undefined);
  assertEquals([...entry.childNames], [
    "Grand Duchy of Lithuania",
    "Kingdom of Poland",
  ]);
  assert(
    !entry.childNames.includes("(Kingdom of Poland)"),
    "括弧付き wrapper が子区画に混ざっている",
  );
});

Deno.test("#352: 複合体の採用は name × 年 × 区間 × SeshatID の全点一致でだけ起きる", () => {
  const props1200 = duchiesOfPolandFeature()
    .properties as unknown as CliopatriaProperties;
  assert(compositeParentEntryFor(props1200, 1200) !== null);
  // 年がずれる
  for (const year of [1000, 1100, 1279, 1300, 1400, 1492]) {
    assertEquals(
      compositeParentEntryFor(props1200, year),
      null,
      `${year} 年へ漏れている`,
    );
  }
  // 区間がずれる
  assertEquals(
    compositeParentEntryFor(
      { ...props1200, FromYear: 1190, ToYear: 1201 },
      1200,
    ),
    null,
  );
  // SeshatID がずれる
  assertEquals(
    compositeParentEntryFor({ ...props1200, SeshatID: "pl_piast_dyn_9" }, 1200),
    null,
  );
  // 名前がずれる
  assertEquals(
    compositeParentEntryFor(
      { ...props1200, Name: "(Kingdom of Poland)" },
      1200,
    ),
    null,
  );
});

Deno.test("#352: 許可リストに無い複合体は従来どおり構造的に落ちる", () => {
  // ADR-0026 の除外は据え置き（緩めるのは全点一致した親だけ）
  assert(
    cliopatriaExclusionReason(props({ Name: "(Kingdom of France)" })) !== null,
  );
  assertEquals(
    selectForYear(
      [feature({ Name: "(Kingdom of France)", FromYear: 990, ToYear: 1027 })],
      1000,
    ).length,
    0,
  );
  // 全点一致した親だけが 1200 年の選択に入る
  const picked = selectForYear([duchiesOfPolandFeature()], 1200);
  assertEquals(picked.length, 1);
  assertEquals(picked[0].properties?.NAME, "(Duchies of Poland)");
});

Deno.test("#352: leaf 判定は MemberOf に一度も現れない名前だけを採る", () => {
  const parent = duchiesOfPolandFeature();
  const leaf = duchyFeature("Duchy of Silesia");
  // Duchy of Silesia を配下に持つ中間層があると Silesia は leaf ではなくなる
  const intermediateChild = duchyFeature("Duchy of Wrocław", {
    MemberOf: "(Duchies of Poland);Duchy of Silesia",
  });
  const features = [parent, leaf, intermediateChild];
  const nonLeaf = nonLeafNames(features, 1200);
  // 親は子の MemberOf に現れるので nonLeaf に入る（親の採用は leaf 判定では
  // なく CLIOPATRIA_COMPOSITE_PARENTS の全点一致で決まる）
  assert(nonLeaf.has("(Duchies of Poland)"));
  assert(nonLeaf.has("Duchy of Silesia"), "中間層が leaf 扱いになっている");
  assertEquals(
    compositeChildEntryFor(
      leaf.properties as unknown as CliopatriaProperties,
      1200,
      nonLeaf,
    ),
    null,
  );
  assert(
    compositeChildEntryFor(
      intermediateChild.properties as unknown as CliopatriaProperties,
      1200,
      nonLeaf,
    ) !== null,
  );
});

Deno.test("#352: 親の properties は base 置換専用の刻印を持ち、子は base 主権を宗主にする", () => {
  const entry = CLIOPATRIA_COMPOSITE_PARENTS.find((e) =>
    e.targetYear === 1200
  )!;
  const parent = fiefPropertiesOf(
    duchiesOfPolandFeature().properties as unknown as CliopatriaProperties,
    1200,
    null,
    { role: "parent", entry },
  );
  assertEquals(parent.NAME, "(Duchies of Poland)");
  assertEquals(parent.CLIOPATRIA_COMPOSITE, "parent");
  assertEquals(parent.CLIOPATRIA_BASE_POWER, "Poland");
  assertEquals(parent.SUBJECTO, "Poland");
  assertEquals(parent.PARTOF, "Poland");
  assertEquals(parent.START_DATE, "1192");
  assertEquals(parent.END_DATE, "1201");
  const child = fiefPropertiesOf(
    duchyFeature("Duchy of Silesia")
      .properties as unknown as CliopatriaProperties,
    1200,
    null,
    { role: "child", entry },
  );
  assertEquals(child.NAME, "Duchy of Silesia");
  assertEquals(child.CLIOPATRIA_COMPOSITE, "child");
  assertEquals(child.SUBJECTO, "Poland");
  assertEquals(child.PARTOF, "Poland");
  // 帝国領邦の宗主（Holy Roman Empire）とは取り違えない
  assertEquals(
    fiefPropertiesOf(props({ Name: "Duchy of Bavaria" }), 1279).SUBJECTO,
    "Holy Roman Empire",
  );
  // 仏諸侯領は従来どおり宗主を持たない
  assertEquals(fiefPropertiesOf(props(), 1000).SUBJECTO, undefined);
});

Deno.test("#352: 上流の leaf 構成が許可リストとずれたらビルドを失敗させる", () => {
  const entry = CLIOPATRIA_COMPOSITE_PARENTS.find((e) =>
    e.targetYear === 1200
  )!;
  const features = [
    duchiesOfPolandFeature(),
    ...entry.childNames.map((name) => duchyFeature(name)),
  ];
  assertEquals(compositeLeafMismatchReason(features, entry), null);
  // 上流に子区画が 1 件増えたら検知する
  const reason = compositeLeafMismatchReason(
    [...features, duchyFeature("Duchy of Łęczyca")],
    entry,
  );
  assert(
    reason !== null && reason.includes("Duchy of Łęczyca"),
    `leaf 構成の変化を検知できていない: ${reason}`,
  );
});

Deno.test("#352: 複合体の親子は他の年へ漏れない", () => {
  const features = [
    duchiesOfPolandFeature(),
    duchyFeature("Duchy of Silesia"),
  ];
  for (const year of [1000, 1100, 1279, 1300, 1400, 1492]) {
    assertEquals(
      selectForYear(features, year).length,
      0,
      `${year} 年へ 1200 年の複合体が漏れている`,
    );
  }
  assertEquals(selectForYear(features, 1200).length, 2);
});

// ---------------------------------------------------------------------------
// #352: ADR-0040 の記述とコードの許可リストの一致（乖離の再発検出）
// #336 / #346 と同じ規律。**コード側が正**で、ADR は追随する。
// ---------------------------------------------------------------------------

const ADR_0040_PATH =
  "docs/adr/0040-cliopatria-composite-parent-base-outline.md";

Deno.test("#352: ADR-0040 が複合体の許可リストを追える形で記述している", async () => {
  const markdown = await Deno.readTextFile(ADR_0040_PATH);
  for (const entry of CLIOPATRIA_COMPOSITE_PARENTS) {
    for (
      const token of [
        entry.name,
        String(entry.targetYear),
        String(entry.fromYear),
        String(entry.toYear),
        entry.seshatId,
        entry.basePowerName,
      ]
    ) {
      assert(
        markdown.includes(token),
        `ADR-0040 に許可リストの ${token} が無い`,
      );
    }
  }
  for (
    const token of [
      CLIOPATRIA_SOURCE_LICENSE,
      "MemberOf",
      "BASE_POWER_REPLACEMENTS",
      "known-limitations",
    ]
  ) {
    assert(markdown.includes(token), `ADR-0040 に ${token} の記述が無い`);
  }
});

Deno.test("#352: ADR-0026 が適用範囲の拡張として ADR-0040 を相互参照する", async () => {
  const markdown = await Deno.readTextFile(ADR_0026_PATH);
  assert(
    markdown.includes("ADR-0040") || markdown.includes("decision-40"),
    "ADR-0026 に ADR-0040 への相互参照が無い",
  );
});

// ---------------------------------------------------------------------------
// #352: 生成物の幾何（AC の数値表）
//
// 値は生成物からの実測で、#321 / #346 と同じく「入力が変われば当然動く」種類の
// 固定値。ここが見るのは「置換で外周の長大な直線が消えたこと」と
// 「親子が完全に一致すること」で、Issue #352 の AC の数値をそのまま固定する。
// ---------------------------------------------------------------------------

/** 複合体の親と leaf 子区画を持つ年（ADR-0040 の許可リストの対象年） */
const COMPOSITE_YEARS = [1000, 1100, 1200, 1279, 1300, 1400] as const;

/** feature の全リング（外環・内環・全パート） */
function allRings(feature: Feature): Position[][] {
  const g = feature.geometry as Polygon | MultiPolygon;
  return g.type === "Polygon" ? g.coordinates : g.coordinates.flat();
}

/** feature の単一線分の長さ（km）を降順で返す */
function segmentLengthsKm(feature: Feature): number[] {
  const lengths: number[] = [];
  for (const ring of allRings(feature)) {
    for (let i = 1; i < ring.length; i++) {
      lengths.push(segmentLengthKm(ring[i - 1], ring[i]));
    }
  }
  return lengths.sort((a, b) => b - a);
}

/** ポリゴン系 feature の union（空なら null） */
function unionAll(
  features: readonly Feature[],
): Feature<Polygon | MultiPolygon> | null {
  let merged: Feature<Polygon | MultiPolygon> | null = null;
  for (
    const f of polygonalFeatures({
      type: "FeatureCollection",
      features: [...features],
    })
  ) {
    merged = merged === null
      ? f
      : union(featureCollection([merged, f])) ?? merged;
  }
  return merged;
}

const km2 = (feature: Feature): number => area(feature) / 1e6;

Deno.test("#352: 親区画の外周から長大な直線が消えている（AC の数値表）", async () => {
  // 年 → [頂点数, 最長線分 km, 100 km 以上の単一線分の本数, 50 km 以上の本数]
  // 上流 base（historical-basemaps）の最長線分は 1000: 312.4 / 1100: 264.4 /
  // 1200: 183.9 / 1279: 116.5 / 1300: 115.3 / 1400: 841.7 km だった。
  const expected: Record<number, [number, number, number, number]> = {
    1000: [93, 74.4, 0, 10],
    1100: [98, 90.2, 0, 8],
    1200: [98, 75.5, 0, 12],
    1279: [126, 110.7, 1, 15],
    1300: [135, 110.7, 1, 13],
    1400: [222, 195.4, 4, 38],
  };
  for (const year of COMPOSITE_YEARS) {
    const raw = await readCollection(cliopatriaRawPathFor(year));
    const parent = raw.features.find((f) =>
      f.properties?.CLIOPATRIA_COMPOSITE === "parent"
    );
    assert(parent !== undefined, `${year}: 親区画が生成物に無い`);
    const [verts, longest, over100, over50] = expected[year];
    assertEquals(vertexCount(parent), verts, `${year}: 親の頂点数`);
    const lengths = segmentLengthsKm(parent);
    assertEquals(
      Number(lengths[0].toFixed(1)),
      longest,
      `${year}: 親の最長線分（km）`,
    );
    assertEquals(
      lengths.filter((km) => km >= 100).length,
      over100,
      `${year}: 100 km 以上の単一線分の本数`,
    );
    assertEquals(
      lengths.filter((km) => km >= 50).length,
      over50,
      `${year}: 50 km 以上の単一線分の本数`,
    );
  }
});

Deno.test("#352: 1000 / 1100 / 1200 年の親区画に 100 km 以上の単一線分が無い（AC）", async () => {
  for (const year of [1000, 1100, 1200]) {
    const raw = await readCollection(cliopatriaRawPathFor(year));
    const parent = raw.features.find((f) =>
      f.properties?.CLIOPATRIA_COMPOSITE === "parent"
    )!;
    const longest = segmentLengthsKm(parent)[0];
    assert(
      longest < VERY_LONG_SEGMENT_KM,
      `${year}: 最長線分 ${
        longest.toFixed(1)
      } km が ${VERY_LONG_SEGMENT_KM} km 以上`,
    );
  }
});

Deno.test("#352: 1279 / 1300 は最長 111 km 以下・100 km 超 1 本以下、1400 は 196 km 以下・4 本以下（AC）", async () => {
  // 残る辺は Cliopatria 原典に由来する制約で、補間で丸めない
  // （data/known-limitations.json の cliopatria-poland-long-segments-* が開示）。
  const limits: Record<number, [number, number]> = {
    1279: [111, 1],
    1300: [111, 1],
    1400: [196, 4],
  };
  for (const [key, [maxKm, maxCount]] of Object.entries(limits)) {
    const year = Number(key);
    const raw = await readCollection(cliopatriaRawPathFor(year));
    const parent = raw.features.find((f) =>
      f.properties?.CLIOPATRIA_COMPOSITE === "parent"
    )!;
    const lengths = segmentLengthsKm(parent);
    assert(lengths[0] <= maxKm, `${year}: 最長 ${lengths[0].toFixed(1)} km`);
    assert(
      lengths.filter((km) => km >= VERY_LONG_SEGMENT_KM).length <= maxCount,
      `${year}: 100 km 超が ${
        lengths.filter((km) => km >= VERY_LONG_SEGMENT_KM).length
      } 本`,
    );
  }
});

Deno.test("#352: leaf 子区画の union は親区画と IoU 1.0 で一致し、子どうしは重ならない（AC）", async () => {
  // 丸めの許容値: raw は RAW_FIEF_COORD_PRECISION（5 桁 ≒ 1.1 m）へ丸めた座標
  // どうしの集合演算なので、IoU は 1 から 1e-9 未満しかずれない。重なりの許容値
  // 0.001 km²（= 1,000 m²）は 5 桁グリッド 1 マス（約 1.2 m²）の 800 倍で、
  // 「幾何的に重なっていない」ことしか通らない。
  const IOU_TOLERANCE = 1e-9;
  const OVERLAP_LIMIT_KM2 = 0.001;
  const expectedChildren: Record<number, number> = {
    1000: 1,
    1100: 1,
    1200: 6,
    1279: 9,
    1300: 11,
    1400: 2,
  };
  for (const year of COMPOSITE_YEARS) {
    const raw = await readCollection(cliopatriaRawPathFor(year));
    const parent = raw.features.find((f) =>
      f.properties?.CLIOPATRIA_COMPOSITE === "parent"
    )!;
    const children = raw.features.filter((f) =>
      f.properties?.CLIOPATRIA_COMPOSITE === "child"
    );
    assertEquals(children.length, expectedChildren[year], `${year}: 子区画数`);
    const merged = unionAll(children);
    assert(merged !== null, `${year}: 子区画の union が空`);
    const inter = intersect(featureCollection([merged, parent as never]));
    const uni = union(featureCollection([merged, parent as never]));
    assert(inter !== null && uni !== null, `${year}: 親子が交差しない`);
    const iou = km2(inter) / km2(uni);
    assert(
      Math.abs(iou - 1) < IOU_TOLERANCE,
      `${year}: 親子 union の IoU が ${iou}（許容 1±${IOU_TOLERANCE}）`,
    );
    let overlap = 0;
    for (let i = 0; i < children.length; i++) {
      for (let j = i + 1; j < children.length; j++) {
        const ov = intersect(
          featureCollection([children[i] as never, children[j] as never]),
        );
        if (ov !== null) overlap += km2(ov);
      }
    }
    assert(
      overlap <= OVERLAP_LIMIT_KM2,
      `${year}: 子区画どうしが ${overlap.toFixed(4)} km² 重なっている`,
    );
  }
});

Deno.test("#352: 親は base 置換専用で配信 flat に出ず、子は flat に全件残る（ADR-0040 決定 3）", async () => {
  for (const year of COMPOSITE_YEARS) {
    const entry = CLIOPATRIA_COMPOSITE_PARENTS.find((e) =>
      e.targetYear === year
    )!;
    const flat = await readCollection(cliopatriaFlatPathFor(year));
    assertEquals(
      flat.features.filter((f) =>
        f.properties?.CLIOPATRIA_COMPOSITE === "parent" ||
        f.properties?.CLIOPATRIA_NAME === entry.name
      ).length,
      0,
      `${year}: 親が配信 flat に出ている`,
    );
    const childNames = flat.features
      .filter((f) => f.properties?.CLIOPATRIA_COMPOSITE === "child")
      .map((f) => String(f.properties?.CLIOPATRIA_NAME))
      .sort();
    assertEquals(childNames, [...entry.childNames], `${year}: flat の子区画`);
    for (const f of flat.features) {
      if (f.properties?.CLIOPATRIA_COMPOSITE !== "child") continue;
      assertEquals(f.properties?.SUBJECTO, entry.basePowerName);
      assertEquals(f.properties?.PARTOF, entry.basePowerName);
    }
  }
});

Deno.test("#352: 1200 年の子区画はグニェズノ・クラクフ・ヴロツワフ・ワルシャワを含みプラハ・ブルノを含まない（AC）", async () => {
  const flat = polygonalFeatures(
    await readCollection(cliopatriaFlatPathFor(1200)),
  );
  const children = flat.filter((f) =>
    f.properties?.CLIOPATRIA_COMPOSITE === "child"
  );
  const inChildren = (point: [number, number]) =>
    children.filter((f) => booleanPointInPolygon(point, f))
      .map((f) => String(f.properties?.NAME));
  for (
    const [label, point, expected] of [
      ["グニェズノ", [17.60, 52.53], "Duchy of Greater Poland"],
      ["クラクフ", [19.94, 50.06], "Duchy of Sandomierz"],
      ["ヴロツワフ", [17.04, 51.11], "Duchy of Silesia"],
      ["ワルシャワ", [21.01, 52.23], "Duchy of Sandomierz"],
    ] as Array<[string, [number, number], string]>
  ) {
    assertEquals(inChildren(point), [expected], `${label} の帰属`);
  }
  for (
    const [label, point] of [
      ["プラハ", [14.42, 50.08]],
      ["ブルノ", [16.61, 49.19]],
    ] as Array<[string, [number, number]]>
  ) {
    assertEquals(
      inChildren(point),
      [],
      `${label} がポーランド諸公国に入っている`,
    );
  }
});
