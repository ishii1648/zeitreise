/**
 * data_loading.ts のユニットテスト（TASK-145）。
 *
 * 検証する契約:
 * - 各ローダが正しい URL を fetch し、成功時はパース済みデータを返すこと
 * - 縮退契約: 取得失敗（HTTP エラー）・非 JSON 応答のとき console.warn を
 *   1 回出してフォールバック値を返し、例外を外へ漏らさないこと
 * - **warn 文言の固定**: ヘッドレス検証やログ確認が文言に依存し得るため、
 *   HTTP エラー経路の warn 文言は 1 文字も違わない完全一致で assert する
 *   （decision-29 / docs/main-ts-inventory.md §2 U2 の不変条件）
 * - フォールバック値の参照同値: EMPTY_* 定数を返すローダは同一参照を返す
 *   （メモ化キーの安定性。fief_dedupe.ts の方針と同じ）
 */
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  type FetchLike,
  loadCities,
  loadColors,
  loadFiefDedupe,
  loadKnownLimitations,
  loadMountains,
  loadNameJa,
  loadNotes,
  loadOverrides,
  loadPeaks,
  loadRivers,
} from "./data_loading.ts";
import { EMPTY_FEATURE_COLLECTION } from "./powers.ts";
import { EMPTY_SUZERAIN_OVERRIDES } from "./suzerain_extent.ts";
import { EMPTY_FIEF_DEDUPE_TABLE } from "./fief_dedupe.ts";

/** console.warn をフックして呼び出し文言を収集しつつ fn を実行する */
async function captureWarns<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; warns: string[] }> {
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
  try {
    const value = await fn();
    return { value, warns };
  } finally {
    console.warn = original;
  }
}

/** 指定 JSON を 200 で返すスタブ fetch。要求 URL を urls へ記録する */
function okJson(body: unknown, urls: string[] = []): FetchLike {
  return (url) => {
    urls.push(url);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

/** 404 を返すスタブ fetch（データ未生成・欠損の経路） */
const notFound: FetchLike = () =>
  Promise.resolve(new Response("not found", { status: 404 }));

/** 200 だが JSON でない本文を返すスタブ fetch（壊れた配信の経路） */
const nonJson: FetchLike = () =>
  Promise.resolve(new Response("<html>oops</html>", { status: 200 }));

/** 1 ローダ分のテーブル定義 */
interface LoaderCase {
  name: string;
  load: (fetchFn: FetchLike) => Promise<unknown>;
  /** fetch されるべき URL */
  url: string;
  /** 成功経路: サーバが返す JSON */
  okBody: unknown;
  /** 成功経路: ローダの返り値（deep equal） */
  expected: unknown;
  /** 縮退経路: フォールバック返り値（deep equal） */
  fallback: unknown;
  /** 縮退経路の warn 文言（HTTP 404 時の完全一致文字列） */
  warnOn404: string;
  /** 非 JSON 経路の warn 文言プレフィックス（エラー詳細はランタイム依存） */
  warnPrefix: string;
  /** フォールバックが同一参照であるべき定数（あれば strict 比較） */
  fallbackRef?: unknown;
}

const RIVERS_FC = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
    properties: { name: "Rhine" },
  }],
};

const MOUNTAINS_FC = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [0, 1], [0, 0]]],
    },
    properties: { name: "Alps" },
  }],
};

const PEAKS_FC = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    geometry: { type: "Point", coordinates: [6.86, 45.83] },
    properties: { name: "Mont Blanc", ele: 4808 },
  }],
};

const CASES: LoaderCase[] = [
  {
    name: "loadColors",
    load: loadColors,
    url: "/data/colors.json",
    okBody: { France: "#123456" },
    expected: { France: "#123456" },
    fallback: {},
    warnOn404:
      "colors.json の取得に失敗しました。デフォルト色で継続します: Error: status 404",
    warnPrefix: "colors.json の取得に失敗しました。デフォルト色で継続します: ",
  },
  {
    name: "loadOverrides",
    load: loadOverrides,
    url: "/data/name-overrides.json",
    okBody: {
      renames: { Franks: "France" },
      suzerains: { Normandy: "France" },
    },
    expected: {
      renames: { Franks: "France" },
      suzerains: { Normandy: "France" },
    },
    fallback: EMPTY_SUZERAIN_OVERRIDES,
    fallbackRef: EMPTY_SUZERAIN_OVERRIDES,
    warnOn404:
      "name-overrides.json の取得に失敗しました。SUBJECTO 生値で継続します: Error: status 404",
    warnPrefix:
      "name-overrides.json の取得に失敗しました。SUBJECTO 生値で継続します: ",
  },
  {
    name: "loadNameJa",
    load: loadNameJa,
    url: "/data/name-ja.json",
    okBody: { France: "フランス" },
    expected: { France: "フランス" },
    fallback: {},
    warnOn404:
      "name-ja.json の取得に失敗しました。英語表記で継続します: Error: status 404",
    warnPrefix: "name-ja.json の取得に失敗しました。英語表記で継続します: ",
  },
  {
    name: "loadFiefDedupe",
    load: loadFiefDedupe,
    url: "/data/fief-dedupe.json",
    okBody: { years: { "1000": { Britany: 1 } } },
    expected: { years: { "1000": { Britany: 1 } } },
    fallback: EMPTY_FIEF_DEDUPE_TABLE,
    fallbackRef: EMPTY_FIEF_DEDUPE_TABLE,
    warnOn404:
      "fief-dedupe.json の取得に失敗しました。諸侯領と base の二重ラベルを抑制せず継続します: Error: status 404",
    warnPrefix:
      "fief-dedupe.json の取得に失敗しました。諸侯領と base の二重ラベルを抑制せず継続します: ",
  },
  {
    name: "loadRivers",
    load: loadRivers,
    url: "/data/rivers.geojson",
    okBody: RIVERS_FC,
    expected: RIVERS_FC,
    fallback: EMPTY_FEATURE_COLLECTION,
    fallbackRef: EMPTY_FEATURE_COLLECTION,
    warnOn404:
      "rivers.geojson の取得に失敗しました。河川なしで継続します: Error: status 404",
    warnPrefix: "rivers.geojson の取得に失敗しました。河川なしで継続します: ",
  },
  {
    name: "loadMountains",
    load: loadMountains,
    url: "/data/mountains.geojson",
    okBody: MOUNTAINS_FC,
    expected: MOUNTAINS_FC,
    fallback: EMPTY_FEATURE_COLLECTION,
    fallbackRef: EMPTY_FEATURE_COLLECTION,
    warnOn404:
      "mountains.geojson の取得に失敗しました。山脈ラベルなしで継続します: Error: status 404",
    warnPrefix:
      "mountains.geojson の取得に失敗しました。山脈ラベルなしで継続します: ",
  },
  {
    name: "loadPeaks",
    load: loadPeaks,
    url: "/data/peaks.geojson",
    okBody: PEAKS_FC,
    expected: PEAKS_FC,
    fallback: EMPTY_FEATURE_COLLECTION,
    fallbackRef: EMPTY_FEATURE_COLLECTION,
    warnOn404:
      "peaks.geojson の取得に失敗しました。山峰なしで継続します: Error: status 404",
    warnPrefix: "peaks.geojson の取得に失敗しました。山峰なしで継続します: ",
  },
  {
    name: "loadCities",
    load: loadCities,
    url: "/data/cities.json",
    okBody: { years: { "1000": [] } },
    expected: { years: { "1000": [] } },
    fallback: { cities: [], years: {} },
    warnOn404:
      "cities.json の取得に失敗しました。都市なしで継続します: Error: status 404",
    warnPrefix: "cities.json の取得に失敗しました。都市なしで継続します: ",
  },
  {
    name: "loadNotes",
    load: loadNotes,
    url: "/data/notes.json",
    okBody: { years: { "1000": { points: ["a"], summary: "s" } } },
    expected: { years: { "1000": { points: ["a"], summary: "s" } } },
    fallback: null,
    warnOn404:
      "notes.json の取得に失敗しました。解説なしで継続します: Error: status 404",
    warnPrefix: "notes.json の取得に失敗しました。解説なしで継続します: ",
  },
  {
    name: "loadKnownLimitations",
    load: loadKnownLimitations,
    url: "/data/known-limitations.json",
    okBody: { limitations: [{ id: "a", text: "t" }] },
    expected: [{ id: "a", text: "t" }],
    fallback: [],
    warnOn404:
      "known-limitations.json の取得に失敗しました。制限事項なしで継続します: Error: status 404",
    warnPrefix:
      "known-limitations.json の取得に失敗しました。制限事項なしで継続します: ",
  },
];

for (const c of CASES) {
  Deno.test(`${c.name}: 成功時は正しい URL を fetch しパース済みデータを返す（warn なし）`, async () => {
    const urls: string[] = [];
    const { value, warns } = await captureWarns(() =>
      c.load(okJson(c.okBody, urls))
    );
    assertEquals(urls, [c.url]);
    assertEquals(value, c.expected);
    assertEquals(warns, []);
  });

  Deno.test(`${c.name}: HTTP エラー時は固定文言で warn しフォールバック値で継続する`, async () => {
    const { value, warns } = await captureWarns(() => c.load(notFound));
    assertEquals(value, c.fallback);
    assertEquals(warns, [c.warnOn404]);
    if (c.fallbackRef !== undefined) {
      assertStrictEquals(value, c.fallbackRef);
    }
  });

  Deno.test(`${c.name}: 非 JSON 応答時も warn してフォールバック値で継続する`, async () => {
    const { value, warns } = await captureWarns(() => c.load(nonJson));
    assertEquals(value, c.fallback);
    assertEquals(warns.length, 1);
    assert(
      warns[0].startsWith(c.warnPrefix),
      `warn 文言が契約プレフィックスで始まらない: ${warns[0]}`,
    );
  });
}

// ---- ローダ固有の縮退経路 ----

Deno.test("loadNotes: years が不正・空のときは warn して null を返す（トグル非表示の契約）", async () => {
  const { value, warns } = await captureWarns(() => loadNotes(okJson({})));
  assertEquals(value, null);
  assertEquals(warns, [
    "notes.json の取得に失敗しました。解説なしで継続します: Error: years が不正または空",
  ]);
});

Deno.test("loadKnownLimitations: 有効エントリが 0 件のときは warn して空配列を返す", async () => {
  const { value, warns } = await captureWarns(() =>
    loadKnownLimitations(okJson({ limitations: [] }))
  );
  assertEquals(value, []);
  assertEquals(warns, [
    "known-limitations.json の取得に失敗しました。制限事項なしで継続します: Error: limitations が空または不正",
  ]);
});

Deno.test("fetch 自体が例外を投げても各ローダはフォールバック値で継続する", async () => {
  const rejecting: FetchLike = () =>
    Promise.reject(new TypeError("network down"));
  for (const c of CASES) {
    const { value, warns } = await captureWarns(() => c.load(rejecting));
    assertEquals(value, c.fallback, c.name);
    assertEquals(warns, [`${c.warnPrefix}TypeError: network down`], c.name);
  }
});
