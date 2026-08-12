import { assert, assertEquals } from "@std/assert";
import area from "@turf/area";
import { featureCollection } from "@turf/helpers";
import intersect from "@turf/intersect";
import type {
  Feature,
  FeatureCollection,
  MultiPolygon,
  Polygon,
} from "geojson";
import {
  CLIOPATRIA_ARCHIVE_MEMBER,
  CLIOPATRIA_ARCHIVE_SHA256,
  CLIOPATRIA_ARCHIVE_URL,
  CLIOPATRIA_EXCLUSIONS,
  CLIOPATRIA_FIEF_YEARS,
  CLIOPATRIA_FRANCE_FIEF_NAMES,
  CLIOPATRIA_HRE_FIEF_NAMES,
  CLIOPATRIA_NAME_OVERRIDES,
  CLIOPATRIA_SOURCE_COMMIT,
  CLIOPATRIA_SOURCE_DOI,
  CLIOPATRIA_SOURCE_LICENSE,
  cliopatriaExclusionReason,
  type CliopatriaProperties,
  cliopatriaRawPathFor,
  containsYear,
  fiefPropertiesOf,
  isCompositeName,
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

Deno.test("許可リストは仏と帝国で互いに素（同じ領邦が 2 つの帰属を持たない）", () => {
  const france = new Set(Object.keys(CLIOPATRIA_FRANCE_FIEF_NAMES));
  for (const name of Object.keys(CLIOPATRIA_HRE_FIEF_NAMES)) {
    assert(!france.has(name), `${name} が仏・帝国の両方に載っている`);
  }
});

Deno.test("帝国側は 1200 年を持たない（Cliopatria が帝国を一枚岩でモデル化するため）", () => {
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
      const allowed = CLIOPATRIA_FRANCE_FIEF_NAMES[upstream] ??
        CLIOPATRIA_HRE_FIEF_NAMES[upstream];
      assert(allowed !== undefined, `${year}: ${upstream} が許可リストに無い`);
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

Deno.test("#321: 1300 年の他の Cliopatria feature は 1 頂点も変わっていない", async () => {
  // 生成物の実測値（#321 の修正前に採取。County of Blôis だけを除いた一覧）
  // NAME, kind, 頂点数, ジオメトリ指紋
  const expected: Array<[string, "raw" | "flat", number, string]> = [
    ["County of Armagnac", "raw", 17, "ae95bb90ad843f91"],
    ["County of Auvergne", "raw", 42, "9e750115edd85ddd"],
    ["County of Foix", "raw", 26, "9f2d91a439898f2d"],
    ["County of Nevers", "raw", 33, "d2741893403640f4"],
    ["County of Périgord", "raw", 10, "990d99a3e3450aa9"],
    ["Duchy of Aquitaine", "raw", 11, "3857adc3da97d688"],
    ["Duchy of Bavaria", "raw", 68, "09c927fe8d17c791"],
    ["Kingdom of Bohemia", "raw", 88, "b9809f99a53094a5"],
    ["Margraviate of Brandenburg", "raw", 55, "1c88fb750d144818"],
    ["County of Armagnac", "flat", 17, "3e95cd4561d64e17"],
    ["County of Auvergne", "flat", 55, "fc87d43764c26f40"],
    ["County of Foix", "flat", 26, "f767460712c092ef"],
    ["County of Nevers", "flat", 65, "7b4876475f23e945"],
    ["County of Périgord", "flat", 10, "21f9b1e8bda99699"],
    ["Duchy of Aquitaine", "flat", 14, "61f5a8f81b3d7bba"],
    ["Duchy of Bavaria", "flat", 606, "d00c792e4411d274"],
    ["Kingdom of Bohemia", "flat", 500, "a729681679b88e01"],
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
