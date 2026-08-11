import { assert, assertEquals } from "@std/assert";
import type { FeatureCollection } from "geojson";
import {
  type AttributableDocument,
  ATTRIBUTION_KEYS,
  attributionForDataFile,
  attributionForDocument,
  basePrecisionOf,
  BORDER_PRECISION,
  DATA_ATTRIBUTIONS,
  type DataAttribution,
  isBasemapFile,
  UNATTRIBUTED_DATA_FILES,
  withAttribution,
} from "./build-attribution.ts";
import { SOURCE_COMMIT, SOURCE_LICENSE, SOURCE_REPO } from "./build-data.ts";
import {
  OHM_SOURCE_HOMEPAGE,
  OHM_SOURCE_LICENSE,
} from "./build-france-fiefs.ts";
import { HRE_SOURCE_DOI, HRE_SOURCE_LICENSE } from "./build-hre.ts";
import {
  RIVERS_SOURCE_COMMIT,
  RIVERS_SOURCE_LICENSE,
  RIVERS_SOURCE_REPO,
} from "./build-rivers.ts";
import { MOUNTAINS_SOURCE_COMMIT } from "./build-mountains.ts";
import { PEAKS_SOURCE_COMMIT } from "./build-peaks.ts";
import {
  BURINGH_SOURCE_DOI,
  BURINGH_SOURCE_LICENSE,
  CITIES_SOURCE_COMMIT,
  CITIES_SOURCE_LICENSE,
} from "./build-cities.ts";
import { getDataCopyTargets } from "./build.ts";
import {
  BASE_OUTLINE_YEARS,
  FRANCE_FIEF_OVERLAY_YEARS,
  HRE_ALL_OVERLAY_YEARS,
  HRE_FIEF_OVERLAY_YEARS,
  ITALY_FIEF_OVERLAY_YEARS,
  SNAPSHOT_YEARS,
} from "../src/config.ts";
import {
  baseFillDataUrlFor,
  baseOutlineDataUrlFor,
  dataUrlFor,
  franceFiefDataUrlFor,
  hreDataUrlFor,
  italyFiefDataUrlFor,
} from "../src/powers.ts";
import { RIVERS_DATA_URL } from "../src/rivers.ts";
import { MOUNTAINS_DATA_URL } from "../src/mountains.ts";
import { PEAKS_DATA_URL } from "../src/peaks.ts";
import { CITIES_DATA_URL } from "../src/cities.ts";
import { HRE_OVERLAY_YEARS } from "./build-hre.ts";
import { FRANCE_FIEF_YEARS } from "./build-france-fiefs.ts";
import { HRE_FIEF_YEARS } from "./build-hre-fiefs.ts";
import { ITALY_FIEF_YEARS } from "./build-italy-fiefs.ts";

/** data/ 直下の生成物（.geojson と cities.json）を列挙する */
async function dataFiles(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir("data")) {
    if (!entry.isFile) continue;
    if (entry.name.endsWith(".geojson") || entry.name === "cities.json") {
      names.push(entry.name);
    }
  }
  return names.sort();
}

/** data/<name> を JSON として読む */
async function readJson(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Deno.readTextFile(`data/${name}`)) as Record<
    string,
    unknown
  >;
}

// ---------------------------------------------------------------------------
// 区分の語彙（AC #3）
// ---------------------------------------------------------------------------

Deno.test("境界の確からしさの区分は一意で、いずれも「概略ではない」と読めない", () => {
  const values = Object.values(BORDER_PRECISION);
  assertEquals(new Set(values).size, values.length);
  for (const value of values) assert(value.length > 0);
  // TASK-80 は「描かれている境界は概略」を前提に全年でにじませて描いている。
  // どの区分も「測量された正確な境界」を意味しないこと（＝概略性の否定を
  // 含まないこと）を語彙そのもので担保する。
  assert(BORDER_PRECISION.approximate.includes("概略"));
  assert(BORDER_PRECISION.simplifiedTreaty.includes("概略"));
  assert(BORDER_PRECISION.reconstructed.includes("概略"));
  assert(BORDER_PRECISION.modernGeneralized.includes("歴史的境界ではない"));
});

Deno.test("basePrecisionOf は上流の BORDERPRECISION 宣言から区分を決める", () => {
  const f = (value: unknown) => ({ properties: { BORDERPRECISION: value } });
  assertEquals(
    basePrecisionOf([f(1), f(1)]),
    BORDER_PRECISION.approximate,
  );
  // 1 件でも 2 / 3（＝上流がより高い精度を主張）を含めば理由を明示する側へ倒す
  assertEquals(
    basePrecisionOf([f(1), f(3)]),
    BORDER_PRECISION.simplifiedTreaty,
  );
  assertEquals(
    basePrecisionOf([f(1), f(2)]),
    BORDER_PRECISION.simplifiedTreaty,
  );
  // 値を持たない feature（TASK-101 の封土切り出し）は判定に使わない
  assertEquals(
    basePrecisionOf([{ properties: { NAME: "Duchy of Normandy" } }, f(1)]),
    BORDER_PRECISION.approximate,
  );
  assertEquals(basePrecisionOf([]), BORDER_PRECISION.approximate);
});

// ---------------------------------------------------------------------------
// ファイル → 出典の解決（純粋関数）
// ---------------------------------------------------------------------------

Deno.test("base 勢力の 3 系統は historical-basemaps の出典に解決する", () => {
  for (
    const name of [
      "europe_1200.geojson",
      "europe_flat_1200.geojson",
      "base_outline_1200.geojson",
    ]
  ) {
    const attribution = attributionForDataFile(name);
    assert(attribution !== null, `${name} が解決できない`);
    assert(isBasemapFile(name), `${name} が base 系と判定されない`);
    assertEquals(attribution.sourceUrl, `https://github.com/${SOURCE_REPO}`);
    assertEquals(attribution.license, SOURCE_LICENSE);
    assertEquals(attribution.commit, SOURCE_COMMIT);
    // 区分はファイルの中身（BORDERPRECISION の分布）で決まるので静的には持たない
    assertEquals(attribution.borderPrecision, undefined);
  }
});

Deno.test("attributionForDocument は base 系だけ中身から区分を決める", () => {
  const base = attributionForDocument("europe_1200.geojson", {
    type: "FeatureCollection",
    features: [{ properties: { BORDERPRECISION: 1 } }],
  });
  assertEquals(base?.borderPrecision, BORDER_PRECISION.approximate);
  const modern = attributionForDocument("europe_1783.geojson", {
    type: "FeatureCollection",
    features: [{ properties: { BORDERPRECISION: 3 } }],
  });
  assertEquals(modern?.borderPrecision, BORDER_PRECISION.simplifiedTreaty);
  // base 系以外は中身に依らず静的な区分のまま
  const fief = attributionForDocument("france_fiefs_flat_1200.geojson", {
    type: "FeatureCollection",
    features: [{ properties: { BORDERPRECISION: 3 } }],
  });
  assertEquals(fief?.borderPrecision, BORDER_PRECISION.reconstructed);
  assertEquals(attributionForDocument("colors.json", {}), null);
});

Deno.test("諸侯領オーバーレイ（raw / flat の 5 系統）は OHM の出典に解決する", () => {
  for (
    const name of [
      "france_fiefs_1200.geojson",
      "france_fiefs_flat_1200.geojson",
      "hre_fiefs_1200.geojson",
      "hre_fiefs_flat_1200.geojson",
      "italy_fiefs_1200.geojson",
      "italy_fiefs_flat_1200.geojson",
      "britain_fiefs_1200.geojson",
      "britain_fiefs_flat_1200.geojson",
      "sovereign_fiefs_1815.geojson",
      "sovereign_fiefs_flat_1815.geojson",
    ]
  ) {
    const attribution = attributionForDataFile(name);
    assert(attribution !== null, `${name} が解決できない`);
    assertEquals(attribution.source, "OpenHistoricalMap");
    assertEquals(attribution.sourceUrl, OHM_SOURCE_HOMEPAGE);
    assertEquals(attribution.license, OHM_SOURCE_LICENSE);
    // Overpass の生クエリで取るためピン留めコミットは無い（契約どおり省略する）
    assertEquals(attribution.commit, undefined);
    assertEquals(attribution.borderPrecision, BORDER_PRECISION.reconstructed);
  }
});

Deno.test("hre_<year> は ETH Zürich（Roller）の出典に解決し、諸侯領 OHM と混ざらない", () => {
  const attribution = attributionForDataFile("hre_1500.geojson");
  assert(attribution !== null);
  assertEquals(attribution.license, HRE_SOURCE_LICENSE);
  assertEquals(attribution.sourceUrl, `https://doi.org/${HRE_SOURCE_DOI}`);
  assertEquals(attribution.borderPrecision, BORDER_PRECISION.reconstructed);
  // ライセンス混合禁止（decision-2）の 2 系統が同じ出典に潰れていないこと
  assert(attribution.license !== OHM_SOURCE_LICENSE);
});

Deno.test("Natural Earth 系はそれぞれ自分のピン留めコミットに解決する", () => {
  const rivers = attributionForDataFile("rivers.geojson");
  const mountains = attributionForDataFile("mountains.geojson");
  const peaks = attributionForDataFile("peaks.geojson");
  assert(rivers !== null && mountains !== null && peaks !== null);
  assertEquals(rivers.commit, RIVERS_SOURCE_COMMIT);
  assertEquals(mountains.commit, MOUNTAINS_SOURCE_COMMIT);
  assertEquals(peaks.commit, PEAKS_SOURCE_COMMIT);
  assertEquals(rivers.license, RIVERS_SOURCE_LICENSE);
  assertEquals(rivers.sourceUrl, `https://github.com/${RIVERS_SOURCE_REPO}`);
});

Deno.test("cities.json は主ソース Buringh（CC0-1.0）の出典に解決する（#222）", () => {
  const attribution = attributionForDataFile("cities.json");
  assert(attribution !== null);
  assertEquals(attribution, DATA_ATTRIBUTIONS.citiesBuringh);
  assertEquals(attribution.license, BURINGH_SOURCE_LICENSE);
  assert(attribution.sourceUrl.includes(BURINGH_SOURCE_DOI));
  // 上流にコミットの概念が無い（DOI + 内容ハッシュでピン留め）ため commit は
  // 持たせない（OHM / ETH と同じ契約どおりの省略）
  assertEquals(attribution.commit, undefined);
});

Deno.test("補完ソース Reba/Chandler の出典レコードはビルド定数と整合する", () => {
  const reba = DATA_ATTRIBUTIONS.citiesReba;
  assertEquals(reba.commit, CITIES_SOURCE_COMMIT);
  assert(
    CITIES_SOURCE_LICENSE.startsWith(reba.license),
    `${CITIES_SOURCE_LICENSE} が ${reba.license} で始まらない`,
  );
});

Deno.test("cities.json の複数ソース（sources 配列）は DATA_ATTRIBUTIONS と index が対応する（#222 AC6）", async () => {
  // 生成物のトップレベル sources（build-cities.ts が書く。各都市の source
  // index が指す配列）と、出典定数の 2 レコードが同じ順序・同じライセンスで
  // 並んでいること。ずれるとクリックパネルの出典が別ソースを指してしまう。
  const doc = await readJson("cities.json");
  const sources = doc.sources as Record<string, unknown>[];
  assert(Array.isArray(sources) && sources.length === 2);
  assertEquals(sources[0].license, DATA_ATTRIBUTIONS.citiesBuringh.license);
  assertEquals(sources[0].sourceUrl, DATA_ATTRIBUTIONS.citiesBuringh.sourceUrl);
  assertEquals(sources[1].license, DATA_ATTRIBUTIONS.citiesReba.license);
  assertEquals(sources[1].sourceUrl, DATA_ATTRIBUTIONS.citiesReba.sourceUrl);
  assertEquals(sources[1].commit, DATA_ATTRIBUTIONS.citiesReba.commit);
});

Deno.test("線・面を持たない点データには境界の確からしさを付けない", () => {
  for (const name of ["peaks.geojson", "cities.json"]) {
    const attribution = attributionForDataFile(name);
    assert(attribution !== null);
    assertEquals(attribution.borderPrecision, undefined, name);
  }
});

Deno.test("出典を持たないファイル名は null を返す", () => {
  for (
    const name of ["colors.json", "notes.json", "index.json", "unknown.geojson"]
  ) {
    assertEquals(attributionForDataFile(name), null, name);
  }
});

// ---------------------------------------------------------------------------
// metadata のマージ（純粋関数）
// ---------------------------------------------------------------------------

const SAMPLE: DataAttribution = {
  source: "Sample",
  sourceUrl: "https://example.com/",
  license: "CC0-1.0",
  commit: "0".repeat(40),
  borderPrecision: BORDER_PRECISION.approximate,
};

Deno.test("withAttribution は既存 metadata を温存して出典キーだけ足す", () => {
  const doc = {
    type: "FeatureCollection",
    features: [],
    metadata: { year: 1200, featureCount: 0, license: "OLD" },
  };
  const merged = withAttribution(doc, SAMPLE) as typeof doc & {
    metadata: Record<string, unknown>;
  };
  assertEquals(merged.metadata.year, 1200);
  assertEquals(merged.metadata.featureCount, 0);
  assertEquals(merged.metadata.license, SAMPLE.license);
  assertEquals(merged.metadata.source, SAMPLE.source);
  assertEquals(merged.metadata.borderPrecision, SAMPLE.borderPrecision);
  // 入力を破壊しない（純粋関数）
  assertEquals(doc.metadata.license, "OLD");
});

Deno.test("withAttribution は metadata の無い文書にも付けられ、features を変えない", () => {
  const doc = {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { NAME: "x" }, geometry: null }],
  };
  const before = JSON.stringify(doc.features);
  const merged = withAttribution(doc, SAMPLE) as typeof doc & {
    metadata: Record<string, unknown>;
  };
  assertEquals(JSON.stringify(merged.features), before);
  assertEquals(merged.metadata.sourceUrl, SAMPLE.sourceUrl);
});

Deno.test("withAttribution は commit / borderPrecision が無い出典でキーを作らない", () => {
  const doc: AttributableDocument = {
    type: "FeatureCollection",
    features: [],
  };
  const merged = withAttribution(doc, {
    source: "S",
    sourceUrl: "u",
    license: "l",
  });
  const metadata = merged.metadata as Record<string, unknown>;
  assertEquals("commit" in metadata, false);
  assertEquals("borderPrecision" in metadata, false);
});

// ---------------------------------------------------------------------------
// AC #2: 定数と生成物のずれをテストが検出する
// ---------------------------------------------------------------------------

Deno.test("生成物の metadata が出典定数と一致する（全データファイル）", async () => {
  const offenders: string[] = [];
  for (const name of await dataFiles()) {
    if (attributionForDataFile(name) === null) continue;
    const doc = await readJson(name);
    const attribution = attributionForDocument(name, doc)!;
    const metadata = doc.metadata as Record<string, unknown> | undefined;
    if (metadata === undefined) {
      offenders.push(`${name}: metadata が無い`);
      continue;
    }
    for (const key of ATTRIBUTION_KEYS) {
      const expected = attribution[key];
      const actual = metadata[key];
      if (expected === undefined) {
        if (key in metadata) offenders.push(`${name}.${key}: 余分なキー`);
        continue;
      }
      if (actual !== expected) {
        offenders.push(
          `${name}.${key}: ${JSON.stringify(actual)} ≠ ${
            JSON.stringify(expected)
          }`,
        );
      }
    }
  }
  assertEquals(
    offenders,
    [],
    "deno task build-attribution で生成物を更新してください",
  );
});

Deno.test("アプリが実際にロードする GeoJSON / JSON に出典キーが揃っている", async () => {
  // クリックパネルは「ロードした FeatureCollection の metadata」を読む。元ファイル
  // （france_fiefs_<year> 等）に出典があっても、ランタイムが引くのは派生ファイル
  // （*_flat_<year> / europe_flat_<year> / base_outline_<year>）なので、そちらに
  // 出典が無いと出典欄が空になる（AC #1）。URL は src 側の定数から引き、
  // 参照先が変わればこのテストが追従する。
  const urls = new Set<string>();
  for (const year of SNAPSHOT_YEARS) urls.add(dataUrlFor(year));
  for (const year of HRE_ALL_OVERLAY_YEARS) {
    urls.add(hreDataUrlFor(year, HRE_FIEF_OVERLAY_YEARS));
  }
  for (const year of FRANCE_FIEF_OVERLAY_YEARS) {
    urls.add(franceFiefDataUrlFor(year));
  }
  for (const year of ITALY_FIEF_OVERLAY_YEARS) {
    urls.add(italyFiefDataUrlFor(year));
  }
  for (const year of BASE_OUTLINE_YEARS) {
    urls.add(baseOutlineDataUrlFor(year));
    urls.add(baseFillDataUrlFor(year));
  }
  urls.add(RIVERS_DATA_URL);
  urls.add(MOUNTAINS_DATA_URL);
  urls.add(PEAKS_DATA_URL);
  urls.add(CITIES_DATA_URL);

  const offenders: string[] = [];
  for (const url of [...urls].sort()) {
    const name = url.slice("/data/".length);
    if (attributionForDataFile(name) === null) {
      offenders.push(`${name}: 出典が未登録`);
      continue;
    }
    const metadata = (await readJson(name)).metadata as
      | Record<string, unknown>
      | undefined;
    for (const key of ["source", "sourceUrl", "license"] as const) {
      if (typeof metadata?.[key] !== "string") {
        offenders.push(`${name}: metadata.${key} が無い`);
      }
    }
  }
  assertEquals(offenders, []);
});

Deno.test("dist へ配信する全データファイルは出典を持つか、意図的な除外に載る", () => {
  const targets = getDataCopyTargets(
    "dist",
    SNAPSHOT_YEARS,
    HRE_OVERLAY_YEARS,
    FRANCE_FIEF_YEARS,
    HRE_FIEF_YEARS,
    ITALY_FIEF_YEARS,
  );
  const missing: string[] = [];
  for (const { from } of targets) {
    const name = from.slice("data/".length);
    if (attributionForDataFile(name) !== null) continue;
    if (name in UNATTRIBUTED_DATA_FILES) continue;
    missing.push(name);
  }
  assertEquals(missing, []);
});

Deno.test("除外リストは実在するファイルだけを挙げる（削除済みファイルの残骸を防ぐ）", async () => {
  const names = new Set(
    (await dataFiles()).concat(
      await (async () => {
        const rest: string[] = [];
        for await (const entry of Deno.readDir("data")) {
          if (entry.isFile) rest.push(entry.name);
        }
        return rest;
      })(),
    ),
  );
  for (const name of Object.keys(UNATTRIBUTED_DATA_FILES)) {
    assert(names.has(name), `除外リストの ${name} が data/ に無い`);
    assert(
      UNATTRIBUTED_DATA_FILES[name].length > 0,
      `${name} の除外理由が空`,
    );
  }
});

// ---------------------------------------------------------------------------
// AC #3: TASK-80 の概略境界の説明・描画と矛盾しない
// ---------------------------------------------------------------------------

Deno.test("「出典が全境界を概略と宣言」を名乗る生成物は BORDERPRECISION が 1 だけ", async () => {
  const offenders: string[] = [];
  let declared = 0;
  for (const name of await dataFiles()) {
    if (attributionForDataFile(name) === null) continue;
    const doc = await readJson(name);
    if (
      attributionForDocument(name, doc)?.borderPrecision !==
        BORDER_PRECISION.approximate
    ) {
      continue;
    }
    declared++;
    const fc = doc as unknown as FeatureCollection;
    for (const feature of fc.features) {
      const precision = feature.properties?.BORDERPRECISION;
      // パイプラインが立てた feature（TASK-101 の封土切り出し）は上流の属性を
      // 持たない。上流由来の値がある feature は全て 1 = approximate であること。
      if (precision === undefined || precision === null) continue;
      if (precision !== 1) {
        offenders.push(`${name}: ${feature.properties?.NAME} = ${precision}`);
      }
    }
  }
  assertEquals(offenders, []);
  // TASK-80 の根拠（中世年代の base は全て approximate 宣言）が実データで
  // 成り立っていること自体も確認する
  assert(declared > 0, "approximate 宣言の生成物が 1 件も無い");
});

Deno.test("上流の宣言が割れるファイルは理由を明示する区分になる（TASK-80 と両立）", async () => {
  // 1783 年は上流が全 feature を 3（determined by international law）と宣言する
  // 一方、TASK-80 のにじみ描画は全年に掛かる。区分は「概略」を保ったまま
  // 理由（簡略化）を明示する側であること。
  const doc = await readJson("europe_1783.geojson");
  assertEquals(
    attributionForDocument("europe_1783.geojson", doc)?.borderPrecision,
    BORDER_PRECISION.simplifiedTreaty,
  );
  const medieval = await readJson("europe_1200.geojson");
  assertEquals(
    attributionForDocument("europe_1200.geojson", medieval)?.borderPrecision,
    BORDER_PRECISION.approximate,
  );
});

Deno.test("base 系以外のデータセットは静的な区分を持ち、base の区分と混ざらない", () => {
  const entries = Object.entries(
    DATA_ATTRIBUTIONS as Record<string, DataAttribution>,
  );
  const baseOnly = [
    BORDER_PRECISION.approximate,
    BORDER_PRECISION.simplifiedTreaty,
  ] as string[];
  for (const [key, attribution] of entries) {
    if (key === "historicalBasemaps") {
      assertEquals(attribution.borderPrecision, undefined);
      continue;
    }
    assert(
      attribution.borderPrecision === undefined ||
        !baseOnly.includes(attribution.borderPrecision),
      `${key} に base 系の区分が付いている`,
    );
  }
});
