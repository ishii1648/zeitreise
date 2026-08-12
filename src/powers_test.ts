import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import type { FeatureCollection } from "geojson";
import {
  baseFillDataUrlFor,
  baseOutlineDataUrlFor,
  borrowedHreDataUrlFor,
  borrowedItalyFiefDataUrlFor,
  britainFiefDataUrlFor,
  cliopatriaFiefDataUrlFor,
  colorKeyFor,
  createBaseFillLoader,
  createBaseOutlineLoader,
  createBorrowedHreLoader,
  createBritainFiefOverlayLoader,
  createCliopatriaFiefOverlayLoader,
  createCombinedYearLoader,
  createFranceFiefOverlayLoader,
  createHreOverlayLoader,
  createItalyFiefOverlayLoader,
  createSovereignFiefOverlayLoader,
  createYearDataLoader,
  createYearSwitcher,
  dataUrlFor,
  DEFAULT_FILL_COLOR,
  EMPTY_FEATURE_COLLECTION,
  FILL_ALPHA,
  fillColorFor,
  franceFiefDataUrlFor,
  hasBaseOutline,
  hasBritainFiefOverlay,
  hasCliopatriaFiefOverlay,
  hasFranceFiefOverlay,
  hasHreOverlay,
  hasItalyFiefOverlay,
  hasSovereignFiefOverlay,
  hexToRgb,
  hreDataUrlFor,
  italyFiefDataUrlFor,
  LINE_COLOR,
  mergeBorrowedFeatures,
  powerFillDataFor,
  powerFillDataForMode,
  type Rgba,
  sovereignFiefDataUrlFor,
  withBorrowedGeometry,
  withPrimedYear,
  YEAR_CACHE_MAX_YEARS,
  type YearDataLoader,
  type YearLayerData,
} from "./powers.ts";
import {
  BRITAIN_FIEF_OVERLAY_YEARS,
  CLIOPATRIA_FIEF_OVERLAY_YEARS,
  FRANCE_FIEF_OVERLAY_YEARS,
  HRE_ALL_OVERLAY_YEARS,
  HRE_FIEF_OVERLAY_YEARS,
  HRE_OVERLAY_YEARS,
  ITALY_FIEF_OVERLAY_YEARS,
  SNAPSHOT_YEARS,
  SOVEREIGN_FIEF_OVERLAY_YEARS,
} from "./config.ts";

Deno.test("colorKeyFor は独立勢力（SUBJECTO が NAME と同じ）では NAME を返す", () => {
  assertEquals(colorKeyFor({ NAME: "Cyprus", SUBJECTO: "Cyprus" }), "Cyprus");
});

Deno.test("colorKeyFor は SUBJECTO が null なら NAME を返す", () => {
  assertEquals(colorKeyFor({ NAME: "France", SUBJECTO: null }), "France");
});

Deno.test("colorKeyFor は SUBJECTO が空文字なら NAME を返す", () => {
  assertEquals(colorKeyFor({ NAME: "France", SUBJECTO: "" }), "France");
});

Deno.test("colorKeyFor は属領（SUBJECTO≠NAME）で NAME|SUBJECTO を返す", () => {
  assertEquals(
    colorKeyFor({ NAME: "Algeria", SUBJECTO: "France" }),
    "Algeria|France",
  );
});

Deno.test("colorKeyFor は NAME が null なら null を返す", () => {
  assertEquals(colorKeyFor({ NAME: null, SUBJECTO: null }), null);
});

Deno.test("colorKeyFor は properties が null なら null を返す", () => {
  assertEquals(colorKeyFor(null), null);
});

Deno.test("hexToRgb は #rrggbb を [r,g,b] に変換する", () => {
  assertEquals(hexToRgb("#ffffff"), [255, 255, 255]);
  assertEquals(hexToRgb("#000000"), [0, 0, 0]);
  assertEquals(hexToRgb("#94aa41"), [0x94, 0xaa, 0x41]);
});

Deno.test("hexToRgb は不正な文字列で null を返す", () => {
  assertEquals(hexToRgb("94aa41"), null);
  assertEquals(hexToRgb("#fff"), null);
  assertEquals(hexToRgb("#gggggg"), null);
});

Deno.test("fillColorFor は割当色を [r,g,b,FILL_ALPHA] で返す", () => {
  const colors = { "Algeria|France": "#94aa41" };
  assertEquals(
    fillColorFor({ NAME: "Algeria", SUBJECTO: "France" }, colors),
    [0x94, 0xaa, 0x41, FILL_ALPHA],
  );
});

Deno.test("fillColorFor は独立勢力の NAME キーを引く", () => {
  const colors = { France: "#123456" };
  assertEquals(
    fillColorFor({ NAME: "France", SUBJECTO: null }, colors),
    [0x12, 0x34, 0x56, FILL_ALPHA],
  );
});

Deno.test("fillColorFor はキー欠落時にデフォルト色を返す", () => {
  assertEquals(
    fillColorFor({ NAME: "Unknown", SUBJECTO: null }, {}),
    DEFAULT_FILL_COLOR,
  );
});

Deno.test("fillColorFor は NAME null 時にデフォルト色を返す", () => {
  assertEquals(
    fillColorFor({ NAME: null, SUBJECTO: null }, { France: "#123456" }),
    DEFAULT_FILL_COLOR,
  );
});

Deno.test("FILL_ALPHA は opacity 0.5 相当（128 前後）", () => {
  assert(FILL_ALPHA >= 110 && FILL_ALPHA <= 140);
});

Deno.test("DEFAULT_FILL_COLOR は塗りと同じ alpha を持つグレー系", () => {
  assertEquals(DEFAULT_FILL_COLOR[3], FILL_ALPHA);
  // R≈G≈B のニュートラルなグレー
  const [r, g, b] = DEFAULT_FILL_COLOR;
  assert(Math.abs(r - g) <= 8 && Math.abs(g - b) <= 8);
});

// TASK-73: 白線は羊皮紙下地から浮くため、app.css の --frame #5c3d22 と同系の
// インク（焦茶）へ変更する。

Deno.test("LINE_COLOR はインク（焦茶）系で、白系ではない", () => {
  // app.css の --frame #5c3d22 と同値の RGB
  assertEquals(LINE_COLOR, [92, 61, 34, 190]);
  const [r, g, b, a] = LINE_COLOR;
  assert(!(r >= 200 && g >= 200 && b >= 200), "白系ではないこと");
  // 暖色の焦茶: R > G > B かつ十分暗い
  assert(r > g && g > b, `LINE_COLOR=${LINE_COLOR} は暖色の焦茶のはず`);
  assert(r < 140, "羊皮紙下地に対して十分暗いインク色であること");
  assert(a > 150 && a < 255, "境界線は不透明寄りだが完全不透明ではない");
});

Deno.test("dataUrlFor は同一オリジンの GeoJSON パスを返す", () => {
  assertEquals(dataUrlFor(1000), "/data/europe_1000.geojson");
  assertEquals(dataUrlFor(1914), "/data/europe_1914.geojson");
});

function fakeCollection(name: string): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { NAME: name, SUBJECTO: name },
        geometry: { type: "Point", coordinates: [0, 0] },
      },
    ],
  };
}

Deno.test("createYearDataLoader は年代 GeoJSON を fetch して返す", async () => {
  const calls: string[] = [];
  const loader = createYearDataLoader((url) => {
    calls.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fakeCollection("A")),
    });
  });
  const fc = await loader.load(1000);
  assertEquals(fc.features[0].properties?.NAME, "A");
  assertEquals(calls, ["/data/europe_1000.geojson"]);
});

Deno.test("createYearDataLoader は同一年代を 1 度だけ fetch する（キャッシュ）", async () => {
  let count = 0;
  const loader = createYearDataLoader((_url) => {
    count++;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fakeCollection("A")),
    });
  });
  await loader.load(1000);
  assert(!loader.has(1200));
  await loader.load(1000);
  assertEquals(count, 1);
  assert(loader.has(1000));
});

Deno.test("createYearDataLoader は並行呼び出しを 1 度の fetch に集約する", async () => {
  let count = 0;
  const loader = createYearDataLoader((_url) => {
    count++;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fakeCollection("A")),
    });
  });
  await Promise.all([loader.load(1000), loader.load(1000)]);
  assertEquals(count, 1);
});

Deno.test("createYearDataLoader は非 ok レスポンスで reject し、キャッシュしない", async () => {
  let count = 0;
  const loader = createYearDataLoader((_url) => {
    count++;
    return Promise.resolve({
      ok: false,
      status: 404,
      json: () => Promise.resolve({}),
    });
  });
  await assertRejects(() => loader.load(1000));
  assert(!loader.has(1000));
  // 失敗後は再試行できる（inflight が残らない）
  await assertRejects(() => loader.load(1000));
  assertEquals(count, 2);
});

// ---- 年代キャッシュの保持上限（LRU 退避、TASK-129） ----

/** テスト用: URL ごとの fetch 回数を数える年代ローダを作る */
function countingLoader(): {
  loader: YearDataLoader;
  countFor: (year: number) => number;
} {
  const counts = new Map<string, number>();
  const loader = createYearDataLoader((url) => {
    counts.set(url, (counts.get(url) ?? 0) + 1);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fakeCollection(url)),
    });
  });
  return { loader, countFor: (year) => counts.get(dataUrlFor(year)) ?? 0 };
}

/** 先頭年 from から連続する n 年分の年代リスト（テスト用） */
function yearsFrom(from: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => from + i);
}

Deno.test("YEAR_CACHE_MAX_YEARS は 2 以上かつ全年代数未満の整数（TASK-129 AC #2）", () => {
  assert(Number.isInteger(YEAR_CACHE_MAX_YEARS));
  assert(YEAR_CACHE_MAX_YEARS >= 2);
  assert(YEAR_CACHE_MAX_YEARS < SNAPSHOT_YEARS.length);
});

Deno.test("createYearDataLoader は上限超過で最も古く使われた年代を解放する（TASK-129 AC #1）", async () => {
  const { loader } = countingLoader();
  const years = yearsFrom(1000, YEAR_CACHE_MAX_YEARS + 1);
  for (const y of years) await loader.load(y);
  assert(!loader.has(years[0]));
  for (const y of years.slice(1)) assert(loader.has(y));
});

Deno.test("createYearDataLoader はキャッシュヒットした年代を退避順の最後尾へ回す（LRU、TASK-129 AC #1）", async () => {
  const { loader } = countingLoader();
  const years = yearsFrom(1000, YEAR_CACHE_MAX_YEARS);
  for (const y of years) await loader.load(y);
  // 最古の years[0] をキャッシュヒットで「最近使った」に更新してから上限超過
  await loader.load(years[0]);
  await loader.load(2000);
  assert(loader.has(years[0]));
  assert(!loader.has(years[1]));
  assert(loader.has(2000));
});

Deno.test("createYearDataLoader は解放済み年代の再ロードで再 fetch して返す（TASK-129 AC #3）", async () => {
  const { loader, countFor } = countingLoader();
  const years = yearsFrom(1000, YEAR_CACHE_MAX_YEARS + 1);
  for (const y of years) await loader.load(y);
  assertEquals(countFor(years[0]), 1);
  const fc = await loader.load(years[0]);
  assertEquals(countFor(years[0]), 2);
  assertEquals(fc.features[0].properties?.NAME, dataUrlFor(years[0]));
  assert(loader.has(years[0]));
});

Deno.test("createYearDataLoader は上限到達後も並行呼び出しを 1 fetch に集約する（TASK-129 AC #4）", async () => {
  const { loader, countFor } = countingLoader();
  for (const y of yearsFrom(1000, YEAR_CACHE_MAX_YEARS)) await loader.load(y);
  await Promise.all([loader.load(2000), loader.load(2000)]);
  assertEquals(countFor(2000), 1);
});

Deno.test("Rgba 型は 4 要素タプル", () => {
  const c: Rgba = [1, 2, 3, 4];
  assertEquals(c.length, 4);
});

/** 解決タイミングを外部から制御できる Promise */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

Deno.test("createYearSwitcher の currentYear は初期状態で undefined", () => {
  const loader = { load: () => Promise.resolve(fakeCollection("A")) };
  const switcher = createYearSwitcher(loader, () => {});
  assertEquals(switcher.currentYear(), undefined);
});

Deno.test("createYearSwitcher は逐次解決なら各要求を順に反映する", async () => {
  const loader = {
    load: (year: number) => Promise.resolve(fakeCollection(`Y${year}`)),
  };
  const applied: number[] = [];
  const switcher = createYearSwitcher(loader, (year) => applied.push(year));
  await switcher.switchTo(1200);
  await switcher.switchTo(1300);
  assertEquals(applied, [1200, 1300]);
  assertEquals(switcher.currentYear(), 1300);
});

Deno.test("createYearSwitcher は後から解決した古い要求を破棄する（最新のみ反映）", async () => {
  const d1200 = deferred<FeatureCollection>();
  const d1300 = deferred<FeatureCollection>();
  const loader = {
    load: (year: number) => year === 1200 ? d1200.promise : d1300.promise,
  };
  const applied: Array<{ year: number; name: string }> = [];
  const switcher = createYearSwitcher(loader, (year, data) => {
    applied.push({ year, name: String(data.features[0].properties?.NAME) });
  });
  const p1 = switcher.switchTo(1200);
  const p2 = switcher.switchTo(1300);
  // 新しい 1300 が先に、古い 1200 が後から解決する（ドラッグ時の競合を再現）
  d1300.resolve(fakeCollection("Y1300"));
  d1200.resolve(fakeCollection("Y1200"));
  await Promise.all([p1, p2]);
  // 古い 1200 は破棄され、表示も currentYear も 1300 のまま
  assertEquals(applied, [{ year: 1300, name: "Y1300" }]);
  assertEquals(switcher.currentYear(), 1300);
});

Deno.test("createYearSwitcher は追い越された（stale）要求の失敗を黙殺する（TASK-48）", async () => {
  const d1200 = deferred<FeatureCollection>();
  const loader = {
    load: (year: number) =>
      year === 1200 ? d1200.promise : Promise.resolve(fakeCollection("Y1300")),
  };
  const applied: number[] = [];
  const switcher = createYearSwitcher(loader, (year) => {
    applied.push(year);
  });
  const p1 = switcher.switchTo(1200); // スライダーで通り過ぎた古い要求
  const p2 = switcher.switchTo(1300); // 最新要求。即成功・反映
  await p2;
  assertEquals(applied, [1300]);
  // 追い越された要求が後から失敗しても、switchTo は reject してはいけない
  // （reject すると main.ts 側で現在表示と無関係な失敗トーストが出る）
  d1200.reject(new Error("network down"));
  await p1;
  assertEquals(switcher.currentYear(), 1300);
});

Deno.test("createYearSwitcher は連続要求で最後の要求だけを反映する", async () => {
  const deferreds = new Map<
    number,
    ReturnType<typeof deferred<FeatureCollection>>
  >();
  const loader = {
    load: (year: number) => {
      const d = deferred<FeatureCollection>();
      deferreds.set(year, d);
      return d.promise;
    },
  };
  const applied: number[] = [];
  const switcher = createYearSwitcher(loader, (year) => applied.push(year));
  const ps = [
    switcher.switchTo(1200),
    switcher.switchTo(1300),
    switcher.switchTo(1400),
  ];
  // 逆順（新しいものから）に解決しても、反映されるのは最後に要求した 1400 のみ
  deferreds.get(1400)!.resolve(fakeCollection("A"));
  deferreds.get(1300)!.resolve(fakeCollection("A"));
  deferreds.get(1200)!.resolve(fakeCollection("A"));
  await Promise.all(ps);
  assertEquals(applied, [1400]);
  assertEquals(switcher.currentYear(), 1400);
});

// ---- TASK-19: HRE（神聖ローマ帝国）領邦オーバーレイ ----

Deno.test("HRE_OVERLAY_YEARS は ETH データのカバー年 + 1700 外挿で、全て SNAPSHOT_YEARS に含まれる", () => {
  // 1700 は Roller データ範囲（〜1650）外だが 1650 境界の外挿として配信する
  // （TASK-68。1715 以降はベースマップがドイツ諸邦を個別収録するため含めない）
  assertEquals([...HRE_OVERLAY_YEARS], [1500, 1530, 1600, 1650, 1700]);
  for (const year of HRE_OVERLAY_YEARS) {
    assert(SNAPSHOT_YEARS.includes(year));
  }
});

Deno.test("hreDataUrlFor は HRE オーバーレイ GeoJSON のパスを返す", () => {
  assertEquals(hreDataUrlFor(1500), "/data/hre_1500.geojson");
  assertEquals(hreDataUrlFor(1650), "/data/hre_1650.geojson");
});

Deno.test("hreDataUrlFor は中世年代（TASK-85 収録年）で OHM 由来の hre_fiefs_flat を指す（TASK-86）", () => {
  for (const year of HRE_FIEF_OVERLAY_YEARS) {
    assertEquals(
      hreDataUrlFor(year, HRE_FIEF_OVERLAY_YEARS),
      `/data/hre_fiefs_flat_${year}.geojson`,
    );
  }
  // 近世（Roller 由来）は従来のまま
  for (const year of HRE_OVERLAY_YEARS) {
    assertEquals(
      hreDataUrlFor(year, HRE_FIEF_OVERLAY_YEARS),
      `/data/hre_${year}.geojson`,
    );
  }
});

Deno.test("hreDataUrlFor の第 2 引数を省略すると従来の hre_<year> 規則になる（後方互換。TASK-86）", () => {
  assertEquals(hreDataUrlFor(1300), "/data/hre_1300.geojson");
});

Deno.test("hasHreOverlay は HRE_ALL_OVERLAY_YEARS で中世・近世の双方を true にする（TASK-86 AC #1/#5）", () => {
  for (const year of [1000, 1100, 1200, 1279, 1300, 1400, 1492, 1500, 1700]) {
    assert(
      hasHreOverlay(year, HRE_ALL_OVERLAY_YEARS),
      `${year} で HRE オーバーレイが無い`,
    );
  }
  // #187: 1715〜1800 も OHM 由来の近世領邦で対象になった
  assert(hasHreOverlay(1715, HRE_ALL_OVERLAY_YEARS));
  assert(hasHreOverlay(1783, HRE_ALL_OVERLAY_YEARS));
  assert(hasHreOverlay(1800, HRE_ALL_OVERLAY_YEARS));
  // 1815 以降はウィーン体制でベースマップが諸邦を個別収録するため対象外
  assert(!hasHreOverlay(1815, HRE_ALL_OVERLAY_YEARS));
  assert(!hasHreOverlay(1914, HRE_ALL_OVERLAY_YEARS));
});

Deno.test("hasHreOverlay は対象年のみ true を返す", () => {
  assert(hasHreOverlay(1500, HRE_OVERLAY_YEARS));
  assert(hasHreOverlay(1650, HRE_OVERLAY_YEARS));
  assert(hasHreOverlay(1700, HRE_OVERLAY_YEARS)); // TASK-68: 1650 境界の外挿
  assert(!hasHreOverlay(1400, HRE_OVERLAY_YEARS));
  assert(!hasHreOverlay(1715, HRE_OVERLAY_YEARS)); // ベースマップ個別収録と二重表示になる年
});

Deno.test("EMPTY_FEATURE_COLLECTION は feature を持たない FeatureCollection", () => {
  assertEquals(EMPTY_FEATURE_COLLECTION, {
    type: "FeatureCollection",
    features: [],
  });
});

Deno.test("createHreOverlayLoader は非対象年で fetch せず空 FeatureCollection を返す", async () => {
  const calls: string[] = [];
  const loader = createHreOverlayLoader((url) => {
    calls.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fakeCollection("Austria")),
    });
  }, HRE_OVERLAY_YEARS);
  const fc = await loader.load(1400);
  assertEquals(fc, EMPTY_FEATURE_COLLECTION);
  assertEquals(calls, []);
  // 非対象年は fetch 不要なので「取得済み」扱い（スピナーを出さない）
  assert(loader.has(1400));
});

Deno.test("createHreOverlayLoader は対象年で hre URL を fetch して返す（キャッシュあり）", async () => {
  const calls: string[] = [];
  const loader = createHreOverlayLoader((url) => {
    calls.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fakeCollection("Austria")),
    });
  }, HRE_OVERLAY_YEARS);
  assert(!loader.has(1500));
  const fc = await loader.load(1500);
  assertEquals(fc.features[0].properties?.NAME, "Austria");
  assertEquals(calls, ["/data/hre_1500.geojson"]);
  await loader.load(1500);
  assertEquals(calls, ["/data/hre_1500.geojson"]);
  assert(loader.has(1500));
});

Deno.test("createHreOverlayLoader は中世年代で hre_fiefs_flat を fetch する（TASK-86 AC #1）", async () => {
  const calls: string[] = [];
  const loader = createHreOverlayLoader(
    (url) => {
      calls.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(fakeCollection("Duchy of Bavaria")),
      });
    },
    HRE_ALL_OVERLAY_YEARS,
    () => {},
    HRE_FIEF_OVERLAY_YEARS,
  );
  const fc = await loader.load(1300);
  assertEquals(fc.features[0].properties?.NAME, "Duchy of Bavaria");
  assertEquals(calls, ["/data/hre_fiefs_flat_1300.geojson"]);
  // 同一ローダで近世年代は Roller 由来のファイルを引く（年代をまたいで一貫）
  await loader.load(1500);
  assertEquals(calls, [
    "/data/hre_fiefs_flat_1300.geojson",
    "/data/hre_1500.geojson",
  ]);
});

Deno.test("createHreOverlayLoader は #187 の近世年代（1715）で hre_fiefs_flat を fetch する", async () => {
  const calls: string[] = [];
  const loader = createHreOverlayLoader(
    (url) => {
      calls.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(fakeCollection("Electorate of Bavaria")),
      });
    },
    HRE_ALL_OVERLAY_YEARS,
    () => {},
    HRE_FIEF_OVERLAY_YEARS,
  );
  const fc = await loader.load(1715);
  assertEquals(fc.features[0].properties?.NAME, "Electorate of Bavaria");
  assertEquals(calls, ["/data/hre_fiefs_flat_1715.geojson"]);
});

Deno.test("createHreOverlayLoader は非対象年（1815）で fetch せず空 FC を返す（TASK-86 AC #6 / #187）", async () => {
  const calls: string[] = [];
  const loader = createHreOverlayLoader(
    (url) => {
      calls.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(fakeCollection("Duchy of Bavaria")),
      });
    },
    HRE_ALL_OVERLAY_YEARS,
    () => {},
    HRE_FIEF_OVERLAY_YEARS,
  );
  assertEquals(await loader.load(1815), EMPTY_FEATURE_COLLECTION);
  assertEquals(calls, []);
});

Deno.test("createHreOverlayLoader は取得失敗時に warn して空 FC を返す（キャッシュせず再試行可能）", async () => {
  let count = 0;
  const warns: string[] = [];
  const loader = createHreOverlayLoader(
    (_url) => {
      count++;
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      });
    },
    HRE_OVERLAY_YEARS,
    (msg) => warns.push(msg),
  );
  const fc = await loader.load(1500);
  assertEquals(fc, EMPTY_FEATURE_COLLECTION);
  assertEquals(warns.length, 1);
  assert(!loader.has(1500));
  // 失敗はキャッシュされず、次のロードで再試行される
  await loader.load(1500);
  assertEquals(count, 2);
});

Deno.test("createHreOverlayLoader は fetch 自体の reject でも空 FC を返す", async () => {
  const warns: string[] = [];
  const loader = createHreOverlayLoader(
    (_url) => Promise.reject(new Error("network down")),
    HRE_OVERLAY_YEARS,
    (msg) => warns.push(msg),
  );
  const fc = await loader.load(1600);
  assertEquals(fc, EMPTY_FEATURE_COLLECTION);
  assertEquals(warns.length, 1);
});

/** base（europe_*）と hre（hre_*）を出し分けるモック fetch を作る */
function makeCombinedFetch(calls: string[]) {
  return (url: string) => {
    calls.push(url);
    const name = url.includes("hre_") ? "Austria" : "France";
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fakeCollection(name)),
    });
  };
}

Deno.test("createCombinedYearLoader は対象年で base と hre を両方ロードして返す", async () => {
  const calls: string[] = [];
  const fetchFn = makeCombinedFetch(calls);
  const loader = createCombinedYearLoader(
    createYearDataLoader(fetchFn),
    createHreOverlayLoader(fetchFn, HRE_OVERLAY_YEARS),
  );
  const data = await loader.load(1500);
  assertEquals(data.base.features[0].properties?.NAME, "France");
  assertEquals(data.hre.features[0].properties?.NAME, "Austria");
  assertEquals(calls.sort(), [
    "/data/europe_1500.geojson",
    "/data/hre_1500.geojson",
  ]);
});

Deno.test("createCombinedYearLoader は非対象年で base のみ fetch し hre は空 FC", async () => {
  const calls: string[] = [];
  const fetchFn = makeCombinedFetch(calls);
  const loader = createCombinedYearLoader(
    createYearDataLoader(fetchFn),
    createHreOverlayLoader(fetchFn, HRE_OVERLAY_YEARS),
  );
  const data = await loader.load(1400);
  assertEquals(data.base.features[0].properties?.NAME, "France");
  assertEquals(data.hre, EMPTY_FEATURE_COLLECTION);
  assertEquals(calls, ["/data/europe_1400.geojson"]);
});

Deno.test("createCombinedYearLoader は base と hre を並行に要求する", async () => {
  const calls: string[] = [];
  const pending = new Map<string, ReturnType<typeof deferred<unknown>>>();
  const loader = createCombinedYearLoader(
    createYearDataLoader((url) => {
      calls.push(url);
      const d = deferred<unknown>();
      pending.set(url, d);
      return d.promise as Promise<{
        ok: boolean;
        status: number;
        json: () => Promise<unknown>;
      }>;
    }),
    createHreOverlayLoader((url) => {
      calls.push(url);
      const d = deferred<unknown>();
      pending.set(url, d);
      return d.promise as Promise<{
        ok: boolean;
        status: number;
        json: () => Promise<unknown>;
      }>;
    }, HRE_OVERLAY_YEARS),
  );
  const p = loader.load(1530);
  // どちらの fetch も解決していない時点で、両方の要求が発行されている（並行ロード）
  assertEquals(calls.sort(), [
    "/data/europe_1530.geojson",
    "/data/hre_1530.geojson",
  ]);
  for (const [url, d] of pending) {
    d.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(fakeCollection(url.includes("hre_") ? "A" : "B")),
    });
  }
  const data = await p;
  assertEquals(data.base.features[0].properties?.NAME, "B");
  assertEquals(data.hre.features[0].properties?.NAME, "A");
});

Deno.test("createCombinedYearLoader は base 失敗で reject する（hre は成功しても）", async () => {
  const loader = createCombinedYearLoader(
    createYearDataLoader((_url) =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      })
    ),
    createHreOverlayLoader(
      (_url) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(fakeCollection("Austria")),
        }),
      HRE_OVERLAY_YEARS,
    ),
  );
  await assertRejects(() => loader.load(1500));
});

Deno.test("createCombinedYearLoader は hre 失敗でも base を返す（overlay は空扱い）", async () => {
  const warns: string[] = [];
  const loader = createCombinedYearLoader(
    createYearDataLoader((_url) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(fakeCollection("France")),
      })
    ),
    createHreOverlayLoader(
      (_url) =>
        Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({}),
        }),
      HRE_OVERLAY_YEARS,
      (msg) => warns.push(msg),
    ),
  );
  const data = await loader.load(1500);
  assertEquals(data.base.features[0].properties?.NAME, "France");
  assertEquals(data.hre, EMPTY_FEATURE_COLLECTION);
  assertEquals(warns.length, 1);
});

Deno.test("createCombinedYearLoader の has は base と hre の両方が取得済みのとき true", async () => {
  const calls: string[] = [];
  const fetchFn = makeCombinedFetch(calls);
  const loader = createCombinedYearLoader(
    createYearDataLoader(fetchFn),
    createHreOverlayLoader(fetchFn, HRE_OVERLAY_YEARS),
  );
  assert(!loader.has(1500));
  await loader.load(1500);
  assert(loader.has(1500));
  // 非対象年は hre 側が常に「取得済み」なので base のキャッシュ状況に従う
  assert(!loader.has(1400));
  await loader.load(1400);
  assert(loader.has(1400));
});

Deno.test("createYearSwitcher は複合データ（base+hre）でも古い要求を破棄する", async () => {
  const d1400 = deferred<YearLayerData>();
  const d1500 = deferred<YearLayerData>();
  const loader = {
    load: (year: number) => year === 1400 ? d1400.promise : d1500.promise,
  };
  const applied: Array<{ year: number; hreCount: number }> = [];
  const switcher = createYearSwitcher(loader, (year, data) => {
    applied.push({ year, hreCount: data.hre.features.length });
  });
  const p1 = switcher.switchTo(1400);
  const p2 = switcher.switchTo(1500);
  // 新しい 1500 が先に、古い 1400 が後から解決する
  d1500.resolve({
    base: fakeCollection("F"),
    hre: fakeCollection("A"),
    fiefs: EMPTY_FEATURE_COLLECTION,
    outlines: EMPTY_FEATURE_COLLECTION,
    baseFill: EMPTY_FEATURE_COLLECTION,
    italyFiefs: EMPTY_FEATURE_COLLECTION,
    cliopatriaFiefs: EMPTY_FEATURE_COLLECTION,
    britainFiefs: EMPTY_FEATURE_COLLECTION,
    sovereignFiefs: EMPTY_FEATURE_COLLECTION,
    hreRealm: EMPTY_FEATURE_COLLECTION,
  });
  d1400.resolve({
    base: fakeCollection("F"),
    hre: EMPTY_FEATURE_COLLECTION,
    fiefs: EMPTY_FEATURE_COLLECTION,
    outlines: EMPTY_FEATURE_COLLECTION,
    baseFill: EMPTY_FEATURE_COLLECTION,
    italyFiefs: EMPTY_FEATURE_COLLECTION,
    cliopatriaFiefs: EMPTY_FEATURE_COLLECTION,
    britainFiefs: EMPTY_FEATURE_COLLECTION,
    sovereignFiefs: EMPTY_FEATURE_COLLECTION,
    hreRealm: EMPTY_FEATURE_COLLECTION,
  });
  await Promise.all([p1, p2]);
  assertEquals(applied, [{ year: 1500, hreCount: 1 }]);
  assertEquals(switcher.currentYear(), 1500);
});

// ---- フランス諸侯領オーバーレイ（TASK-71）----

Deno.test("franceFiefDataUrlFor はフランス諸侯領オーバーレイ GeoJSON のパスを返す（TASK-71）", () => {
  assertEquals(
    franceFiefDataUrlFor(1000),
    "/data/france_fiefs_flat_1000.geojson",
  );
  assertEquals(
    franceFiefDataUrlFor(1279),
    "/data/france_fiefs_flat_1279.geojson",
  );
});

Deno.test("hasFranceFiefOverlay は中世の対象年のみ true を返す（TASK-71 AC #4）", () => {
  for (const year of FRANCE_FIEF_OVERLAY_YEARS) {
    assert(hasFranceFiefOverlay(year, FRANCE_FIEF_OVERLAY_YEARS));
  }
  // 近世以降（ベースマップの France ポリゴンだけで表現される年）は対象外
  for (const year of [1400, 1492, 1500, 1650, 1700, 1815, 1914]) {
    assert(
      !hasFranceFiefOverlay(year, FRANCE_FIEF_OVERLAY_YEARS),
      `${year} でフランス諸侯オーバーレイが有効になってはいけない`,
    );
  }
});

Deno.test("createFranceFiefOverlayLoader は非対象年で fetch せず空 FC を返す（二重表示回避。TASK-71 AC #4）", async () => {
  const calls: string[] = [];
  const loader = createFranceFiefOverlayLoader((url) => {
    calls.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fakeCollection("Duchy of Normandy")),
    });
  }, FRANCE_FIEF_OVERLAY_YEARS);
  for (
    const year of SNAPSHOT_YEARS.filter((y) =>
      !FRANCE_FIEF_OVERLAY_YEARS.includes(y)
    )
  ) {
    const fc = await loader.load(year);
    assertEquals(fc, EMPTY_FEATURE_COLLECTION, `${year} で空 FC でない`);
    // 非対象年は fetch 不要なので「取得済み」扱い（スピナーを出さない）
    assert(loader.has(year));
  }
  assertEquals(calls, []);
});

Deno.test("createFranceFiefOverlayLoader は対象年で france_fiefs URL を fetch して返す（キャッシュあり）（TASK-71）", async () => {
  const calls: string[] = [];
  const loader = createFranceFiefOverlayLoader((url) => {
    calls.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fakeCollection("Duchy of Normandy")),
    });
  }, FRANCE_FIEF_OVERLAY_YEARS);
  assert(!loader.has(1200));
  const fc = await loader.load(1200);
  assertEquals(fc.features[0].properties?.NAME, "Duchy of Normandy");
  assertEquals(calls, ["/data/france_fiefs_flat_1200.geojson"]);
  await loader.load(1200);
  assertEquals(calls, ["/data/france_fiefs_flat_1200.geojson"]);
  assert(loader.has(1200));
});

Deno.test("createFranceFiefOverlayLoader は取得失敗時に warn して空 FC を返す（キャッシュせず再試行可能）（TASK-71）", async () => {
  let count = 0;
  const warns: string[] = [];
  const loader = createFranceFiefOverlayLoader(
    (_url) => {
      count++;
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      });
    },
    FRANCE_FIEF_OVERLAY_YEARS,
    (msg) => warns.push(msg),
  );
  const fc = await loader.load(1000);
  assertEquals(fc, EMPTY_FEATURE_COLLECTION);
  assertEquals(warns.length, 1);
  assert(!loader.has(1000));
  await loader.load(1000);
  assertEquals(count, 2);
});

/** base / hre / france_fiefs を出し分けるモック fetch を作る（TASK-71） */
function makeThreeWayFetch(calls: string[]) {
  return (url: string) => {
    calls.push(url);
    const name = url.includes("france_fiefs_flat_")
      ? "Duchy of Normandy"
      : url.includes("hre_")
      ? "Austria"
      : "France";
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fakeCollection(name)),
    });
  };
}

Deno.test("createCombinedYearLoader は fiefs ローダを渡すと base/hre/fiefs を並行ロードして返す（TASK-71）", async () => {
  const calls: string[] = [];
  const fetchFn = makeThreeWayFetch(calls);
  const loader = createCombinedYearLoader(
    createYearDataLoader(fetchFn),
    createHreOverlayLoader(fetchFn, HRE_OVERLAY_YEARS),
    createFranceFiefOverlayLoader(fetchFn, FRANCE_FIEF_OVERLAY_YEARS),
  );
  const data = await loader.load(1200);
  assertEquals(data.base.features[0].properties?.NAME, "France");
  assertEquals(data.hre, EMPTY_FEATURE_COLLECTION);
  assertEquals(data.fiefs.features[0].properties?.NAME, "Duchy of Normandy");
  assertEquals(calls.sort(), [
    "/data/europe_1200.geojson",
    "/data/france_fiefs_flat_1200.geojson",
  ]);
});

Deno.test("createCombinedYearLoader はオーバーレイ対象外の年で fiefs を fetch せず空 FC にする（TASK-71 AC #4）", async () => {
  const calls: string[] = [];
  const fetchFn = makeThreeWayFetch(calls);
  const loader = createCombinedYearLoader(
    createYearDataLoader(fetchFn),
    createHreOverlayLoader(fetchFn, HRE_OVERLAY_YEARS),
    createFranceFiefOverlayLoader(fetchFn, FRANCE_FIEF_OVERLAY_YEARS),
  );
  const data = await loader.load(1500);
  assertEquals(data.fiefs, EMPTY_FEATURE_COLLECTION);
  assertEquals(data.fiefs.features.length, 0);
  assertEquals(calls.sort(), [
    "/data/europe_1500.geojson",
    "/data/hre_1500.geojson",
  ]);
});

Deno.test("createCombinedYearLoader は fiefs ローダ省略時も従来どおり動く（空 FC）（TASK-71）", async () => {
  const calls: string[] = [];
  const fetchFn = makeThreeWayFetch(calls);
  const loader = createCombinedYearLoader(
    createYearDataLoader(fetchFn),
    createHreOverlayLoader(fetchFn, HRE_OVERLAY_YEARS),
  );
  const data = await loader.load(1200);
  assertEquals(data.fiefs, EMPTY_FEATURE_COLLECTION);
});

Deno.test("createCombinedYearLoader の has は fiefs も含めて判定する（TASK-71）", async () => {
  const calls: string[] = [];
  const fetchFn = makeThreeWayFetch(calls);
  const loader = createCombinedYearLoader(
    createYearDataLoader(fetchFn),
    createHreOverlayLoader(fetchFn, HRE_OVERLAY_YEARS),
    createFranceFiefOverlayLoader(fetchFn, FRANCE_FIEF_OVERLAY_YEARS),
  );
  assert(!loader.has(1200));
  await loader.load(1200);
  assert(loader.has(1200));
});

// --- TASK-78: base 境界線オーバーレイ（諸侯領の内側を除いた base 輪郭） ---

Deno.test("baseOutlineDataUrlFor は data/base_outline_<year>.geojson を指す（TASK-78）", () => {
  assertEquals(baseOutlineDataUrlFor(1200), "/data/base_outline_1200.geojson");
});

Deno.test("hasBaseOutline は諸侯領オーバーレイ対象年のみ true（TASK-78 AC #3）", () => {
  for (const year of FRANCE_FIEF_OVERLAY_YEARS) {
    assert(hasBaseOutline(year, FRANCE_FIEF_OVERLAY_YEARS));
  }
  for (const year of [1400, 1492, 1500, 1914]) {
    assert(!hasBaseOutline(year, FRANCE_FIEF_OVERLAY_YEARS));
  }
});

Deno.test("createBaseOutlineLoader は非対象年で fetch せず空 FC を返す（TASK-78 AC #3）", async () => {
  const calls: string[] = [];
  const loader = createBaseOutlineLoader((url) => {
    calls.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(EMPTY_FEATURE_COLLECTION),
    });
  }, FRANCE_FIEF_OVERLAY_YEARS);
  assertEquals(await loader.load(1400), EMPTY_FEATURE_COLLECTION);
  assertEquals(calls, []);
  assert(loader.has(1400));
});

Deno.test("createBaseOutlineLoader は対象年で base_outline URL を fetch する（TASK-78）", async () => {
  const calls: string[] = [];
  const loader = createBaseOutlineLoader((url) => {
    calls.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          type: "FeatureCollection",
          features: [{
            type: "Feature",
            properties: { NAME: "France" },
            geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
          }],
        } as FeatureCollection),
    });
  }, FRANCE_FIEF_OVERLAY_YEARS);
  const data = await loader.load(1200);
  assertEquals(data.features.length, 1);
  assertEquals(calls, ["/data/base_outline_1200.geojson"]);
  // 2 回目はキャッシュから返す
  await loader.load(1200);
  assertEquals(calls.length, 1);
});

Deno.test("createBaseOutlineLoader は取得失敗時に warn して空 FC を返す（base 輪郭は powers 側の stroke で継続。TASK-78）", async () => {
  const warnings: string[] = [];
  const loader = createBaseOutlineLoader(
    () =>
      Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      }),
    FRANCE_FIEF_OVERLAY_YEARS,
    (message) => warnings.push(message),
  );
  assertEquals(await loader.load(1200), EMPTY_FEATURE_COLLECTION);
  assertEquals(warnings.length, 1);
  assert(warnings[0].includes("base 境界線"));
});

Deno.test("createCombinedYearLoader は outlines ローダを渡すと 4 系統を並行ロードする（TASK-78）", async () => {
  const calls: string[] = [];
  const fetchFn = (url: string) => {
    calls.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          type: "FeatureCollection",
          features: [{
            type: "Feature",
            properties: { NAME: url },
            geometry: { type: "Point", coordinates: [0, 0] },
          }],
        } as FeatureCollection),
    });
  };
  const loader = createCombinedYearLoader(
    createYearDataLoader(fetchFn),
    createHreOverlayLoader(fetchFn, HRE_OVERLAY_YEARS),
    createFranceFiefOverlayLoader(fetchFn, FRANCE_FIEF_OVERLAY_YEARS),
    createBaseOutlineLoader(fetchFn, FRANCE_FIEF_OVERLAY_YEARS),
  );
  const data = await loader.load(1200);
  assertEquals(
    data.outlines.features[0].properties?.NAME,
    "/data/base_outline_1200.geojson",
  );
  assert(calls.includes("/data/base_outline_1200.geojson"));
});

Deno.test("createCombinedYearLoader は outlines ローダ省略時に空 FC を返す（後方互換。TASK-78）", async () => {
  const fetchFn = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(EMPTY_FEATURE_COLLECTION),
    });
  const loader = createCombinedYearLoader(
    createYearDataLoader(fetchFn),
    createHreOverlayLoader(fetchFn, HRE_OVERLAY_YEARS),
  );
  const data = await loader.load(1200);
  assertEquals(data.outlines, EMPTY_FEATURE_COLLECTION);
});

// ---------------------------------------------------------------------------
// TASK-92: 諸侯領の下地になる base 塗りを取り除いた派生 base（europe_flat_*）
// ---------------------------------------------------------------------------

Deno.test("baseFillDataUrlFor は data/europe_flat_<year>.geojson を指す（TASK-92）", () => {
  assertEquals(baseFillDataUrlFor(1200), "/data/europe_flat_1200.geojson");
});

Deno.test("createBaseFillLoader は非対象年を fetch せず空 FC を返す（TASK-92）", async () => {
  const calls: string[] = [];
  const loader = createBaseFillLoader(
    (url) => {
      calls.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(EMPTY_FEATURE_COLLECTION),
      });
    },
    FRANCE_FIEF_OVERLAY_YEARS,
  );
  assertEquals(await loader.load(1600), EMPTY_FEATURE_COLLECTION);
  assertEquals(calls, []);
});

Deno.test("createBaseFillLoader は取得失敗を warn して空 FC に落とす（TASK-92）", async () => {
  const warnings: string[] = [];
  const loader = createBaseFillLoader(
    () =>
      Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      }),
    FRANCE_FIEF_OVERLAY_YEARS,
    (message) => warnings.push(message),
  );
  assertEquals(await loader.load(1200), EMPTY_FEATURE_COLLECTION);
  assertEquals(warnings.length, 1);
  assert(warnings[0].includes("base 塗り"));
});

Deno.test("createCombinedYearLoader は baseFill ローダを渡すと 5 系統を並行ロードする（TASK-92）", async () => {
  const calls: string[] = [];
  const fetchFn = (url: string) => {
    calls.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          type: "FeatureCollection",
          features: [{
            type: "Feature",
            properties: { NAME: url },
            geometry: { type: "Point", coordinates: [0, 0] },
          }],
        } as FeatureCollection),
    });
  };
  const loader = createCombinedYearLoader(
    createYearDataLoader(fetchFn),
    createHreOverlayLoader(fetchFn, HRE_OVERLAY_YEARS),
    createFranceFiefOverlayLoader(fetchFn, FRANCE_FIEF_OVERLAY_YEARS),
    createBaseOutlineLoader(fetchFn, FRANCE_FIEF_OVERLAY_YEARS),
    createBaseFillLoader(fetchFn, FRANCE_FIEF_OVERLAY_YEARS),
  );
  const data = await loader.load(1200);
  assertEquals(
    data.baseFill.features[0].properties?.NAME,
    "/data/europe_flat_1200.geojson",
  );
  assert(calls.includes("/data/europe_flat_1200.geojson"));
});

Deno.test("createCombinedYearLoader は baseFill ローダ省略時に空 FC を返す（後方互換。TASK-92）", async () => {
  const fetchFn = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(EMPTY_FEATURE_COLLECTION),
    });
  const loader = createCombinedYearLoader(
    createYearDataLoader(fetchFn),
    createHreOverlayLoader(fetchFn, HRE_OVERLAY_YEARS),
  );
  const data = await loader.load(1200);
  assertEquals(data.baseFill, EMPTY_FEATURE_COLLECTION);
});

Deno.test("powerFillDataFor は派生 base があればそれを、無ければ base を返す（TASK-92）", () => {
  const base: FeatureCollection = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { NAME: "Kingdom of France" },
      geometry: { type: "Point", coordinates: [0, 0] },
    }],
  };
  const flat: FeatureCollection = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { NAME: "Kingdom of France (flat)" },
      geometry: { type: "Point", coordinates: [0, 0] },
    }],
  };
  assertEquals(powerFillDataFor(base, flat), flat);
  // 非対象年・取得失敗（空 FC）は従来どおり base を塗る
  assertEquals(powerFillDataFor(base, EMPTY_FEATURE_COLLECTION), base);
});

Deno.test("powerFillDataForMode: 詳細表示では powerFillDataFor と同じ選択（#228 AC2）", () => {
  const base: FeatureCollection = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { NAME: "Kingdom of France" },
      geometry: { type: "Point", coordinates: [0, 0] },
    }],
  };
  const flat: FeatureCollection = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { NAME: "Kingdom of France (flat)" },
      geometry: { type: "Point", coordinates: [0, 0] },
    }],
  };
  assertStrictEquals(powerFillDataForMode(base, flat, true), flat);
  assertStrictEquals(
    powerFillDataForMode(base, EMPTY_FEATURE_COLLECTION, true),
    base,
  );
});

Deno.test("powerFillDataForMode: 概観表示では baseFill があっても穴のない素の base を返す（#228 AC2）", () => {
  const base: FeatureCollection = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { NAME: "Kingdom of France" },
      geometry: { type: "Point", coordinates: [0, 0] },
    }],
  };
  const flat: FeatureCollection = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { NAME: "Kingdom of France (flat)" },
      geometry: { type: "Point", coordinates: [0, 0] },
    }],
  };
  // 概観（z4）は諸侯領を隠すため、領邦差し引き済みの baseFill を塗ると
  // その分が透明な穴になる。必ず素の base を返す（参照そのまま）
  assertStrictEquals(powerFillDataForMode(base, flat, false), base);
  assertStrictEquals(
    powerFillDataForMode(base, EMPTY_FEATURE_COLLECTION, false),
    base,
  );
});

// ---- 中世イタリア諸侯領オーバーレイ（TASK-96）----

Deno.test("italyFiefDataUrlFor はイタリア諸侯領オーバーレイ GeoJSON のパスを返す（TASK-96）", () => {
  // 参照するのは flat（諸侯領同士の重なりを排他化した派生データ）。
  // 生データ italy_fiefs_<year> は派生データの入力で、配信もしない。
  assertEquals(
    italyFiefDataUrlFor(1200),
    "/data/italy_fiefs_flat_1200.geojson",
  );
  assertEquals(
    italyFiefDataUrlFor(1492),
    "/data/italy_fiefs_flat_1492.geojson",
  );
});

Deno.test("hasItalyFiefOverlay は対象年（1000〜1500）のみ true を返す（TASK-96、#188）", () => {
  for (const year of ITALY_FIEF_OVERLAY_YEARS) {
    assert(hasItalyFiefOverlay(year, ITALY_FIEF_OVERLAY_YEARS));
  }
  // 1530 以降は base が伊諸邦を主権国家として個別収録する
  for (const year of [1530, 1650, 1914]) {
    assert(!hasItalyFiefOverlay(year, ITALY_FIEF_OVERLAY_YEARS));
  }
});

Deno.test("createItalyFiefOverlayLoader は非対象年で fetch せず空 FC を返す（二重表示回避。TASK-96）", async () => {
  const calls: string[] = [];
  const loader = createItalyFiefOverlayLoader((url) => {
    calls.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fakeCollection("Republic of Florence")),
    });
  }, ITALY_FIEF_OVERLAY_YEARS);
  assertEquals(await loader.load(1530), EMPTY_FEATURE_COLLECTION);
  assertEquals(await loader.load(1914), EMPTY_FEATURE_COLLECTION);
  assertEquals(calls, []);
  // 非対象年は fetch 不要なので「取得済み」扱い（スピナーを出さない）
  assert(loader.has(1530));
});

Deno.test("createItalyFiefOverlayLoader は対象年で italy_fiefs_flat を fetch して返す（キャッシュあり）（TASK-96 AC #1）", async () => {
  const calls: string[] = [];
  const loader = createItalyFiefOverlayLoader((url) => {
    calls.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fakeCollection("Republic of Florence")),
    });
  }, ITALY_FIEF_OVERLAY_YEARS);
  assert(!loader.has(1200));
  const fc = await loader.load(1200);
  assertEquals(fc.features[0].properties?.NAME, "Republic of Florence");
  assertEquals(calls, ["/data/italy_fiefs_flat_1200.geojson"]);
  await loader.load(1200);
  assertEquals(calls, ["/data/italy_fiefs_flat_1200.geojson"]);
  assert(loader.has(1200));
});

Deno.test("createItalyFiefOverlayLoader は取得失敗時に warn して空 FC を返す（base の表示は壊さない）（TASK-96）", async () => {
  let count = 0;
  const warns: string[] = [];
  const loader = createItalyFiefOverlayLoader(
    (_url) => {
      count++;
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      });
    },
    ITALY_FIEF_OVERLAY_YEARS,
    (msg) => warns.push(msg),
  );
  assertEquals(await loader.load(1200), EMPTY_FEATURE_COLLECTION);
  assertEquals(warns.length, 1);
  assert(!loader.has(1200));
  // 失敗はキャッシュされず、次のロードで再試行される
  await loader.load(1200);
  assertEquals(count, 2);
});

Deno.test("createCombinedYearLoader は 3 系統のオーバーレイ（HRE 領邦・仏諸侯領・伊諸侯領）を同時に返す（TASK-96 AC #5）", async () => {
  const calls: string[] = [];
  const fetchFn = (url: string) => {
    calls.push(url);
    const name = url.includes("italy_fiefs")
      ? "Republic of Florence"
      : url.includes("france_fiefs")
      ? "Normandy"
      : url.includes("hre_fiefs")
      ? "Duchy of Bavaria"
      : "Kingdom of France";
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fakeCollection(name)),
    });
  };
  const loader = createCombinedYearLoader(
    createYearDataLoader(fetchFn),
    createHreOverlayLoader(
      fetchFn,
      HRE_ALL_OVERLAY_YEARS,
      () => {},
      HRE_FIEF_OVERLAY_YEARS,
    ),
    createFranceFiefOverlayLoader(fetchFn, FRANCE_FIEF_OVERLAY_YEARS),
    undefined,
    undefined,
    createItalyFiefOverlayLoader(fetchFn, ITALY_FIEF_OVERLAY_YEARS),
  );
  const data = await loader.load(1200);
  assertEquals(data.base.features[0].properties?.NAME, "Kingdom of France");
  assertEquals(data.hre.features[0].properties?.NAME, "Duchy of Bavaria");
  assertEquals(data.fiefs.features[0].properties?.NAME, "Normandy");
  assertEquals(
    data.italyFiefs.features[0].properties?.NAME,
    "Republic of Florence",
  );
  assert(calls.includes("/data/italy_fiefs_flat_1200.geojson"));
});

Deno.test("createCombinedYearLoader は伊諸侯領ローダを省略しても従来どおり動く（後方互換。TASK-96）", async () => {
  const fetchFn = (url: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fakeCollection(url)),
    });
  const loader = createCombinedYearLoader(
    createYearDataLoader(fetchFn),
    createHreOverlayLoader(fetchFn, HRE_OVERLAY_YEARS),
  );
  const data = await loader.load(1200);
  assertEquals(data.italyFiefs, EMPTY_FEATURE_COLLECTION);
});

// ---- Cliopatria 由来の領邦オーバーレイ（TASK-110）----

Deno.test("cliopatriaFiefDataUrlFor は Cliopatria 領邦オーバーレイ GeoJSON のパスを返す（TASK-110）", () => {
  // 参照するのは flat（OHM 由来 3 系統との重なりを排他化した派生データ）。
  // 生データ cliopatria_fiefs_<year> は派生データの入力で、配信もしない。
  assertEquals(
    cliopatriaFiefDataUrlFor(1000),
    "/data/cliopatria_fiefs_flat_1000.geojson",
  );
  assertEquals(
    cliopatriaFiefDataUrlFor(1492),
    "/data/cliopatria_fiefs_flat_1492.geojson",
  );
});

Deno.test("hasCliopatriaFiefOverlay は対象年（1000〜1492）のみ true を返す（TASK-110）", () => {
  for (const year of CLIOPATRIA_FIEF_OVERLAY_YEARS) {
    assert(hasCliopatriaFiefOverlay(year, CLIOPATRIA_FIEF_OVERLAY_YEARS));
  }
  // 1500 以降は base が主権国家を個別収録するため対象外
  for (const year of [1500, 1650, 1914]) {
    assert(!hasCliopatriaFiefOverlay(year, CLIOPATRIA_FIEF_OVERLAY_YEARS));
  }
});

Deno.test("createCliopatriaFiefOverlayLoader は非対象年で fetch せず空 FC を返す（二重表示回避。TASK-110 AC #4）", async () => {
  const calls: string[] = [];
  const loader = createCliopatriaFiefOverlayLoader((url) => {
    calls.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fakeCollection("Duchy of Aquitaine")),
    });
  }, CLIOPATRIA_FIEF_OVERLAY_YEARS);
  assertEquals(await loader.load(1500), EMPTY_FEATURE_COLLECTION);
  assertEquals(await loader.load(1914), EMPTY_FEATURE_COLLECTION);
  assertEquals(calls, []);
  assert(loader.has(1500));
});

Deno.test("createCliopatriaFiefOverlayLoader は対象年で cliopatria_fiefs_flat を fetch して返す（キャッシュあり）（TASK-110 AC #5）", async () => {
  const calls: string[] = [];
  const loader = createCliopatriaFiefOverlayLoader((url) => {
    calls.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fakeCollection("Duchy of Aquitaine")),
    });
  }, CLIOPATRIA_FIEF_OVERLAY_YEARS);
  assert(!loader.has(1000));
  const fc = await loader.load(1000);
  assertEquals(fc.features[0].properties?.NAME, "Duchy of Aquitaine");
  assertEquals(calls, ["/data/cliopatria_fiefs_flat_1000.geojson"]);
  await loader.load(1000);
  assertEquals(calls, ["/data/cliopatria_fiefs_flat_1000.geojson"]);
  assert(loader.has(1000));
});

Deno.test("createCliopatriaFiefOverlayLoader は未生成・取得失敗時に warn して空 FC を返す（base の表示は壊さない）（TASK-110）", async () => {
  // データ側の生成前（cliopatria_fiefs_flat_* が存在しない）でもアプリが
  // 起動し年代を切り替えられることを、この縮退契約で保証する
  let count = 0;
  const warns: string[] = [];
  const loader = createCliopatriaFiefOverlayLoader(
    (_url) => {
      count++;
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      });
    },
    CLIOPATRIA_FIEF_OVERLAY_YEARS,
    (msg) => warns.push(msg),
  );
  assertEquals(await loader.load(1000), EMPTY_FEATURE_COLLECTION);
  assertEquals(warns.length, 1);
  assert(!loader.has(1000));
  // 失敗はキャッシュされず、次のロードで再試行される
  await loader.load(1000);
  assertEquals(count, 2);
});

Deno.test("createCombinedYearLoader は 4 系統のオーバーレイ（HRE 領邦・仏諸侯領・伊諸侯領・Cliopatria 領邦）を同時に返す（TASK-110）", async () => {
  const calls: string[] = [];
  const fetchFn = (url: string) => {
    calls.push(url);
    const name = url.includes("cliopatria_fiefs")
      ? "Duchy of Aquitaine"
      : url.includes("italy_fiefs")
      ? "Republic of Florence"
      : url.includes("france_fiefs")
      ? "Normandy"
      : url.includes("hre_fiefs")
      ? "Duchy of Bavaria"
      : "Kingdom of France";
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fakeCollection(name)),
    });
  };
  const loader = createCombinedYearLoader(
    createYearDataLoader(fetchFn),
    createHreOverlayLoader(
      fetchFn,
      HRE_ALL_OVERLAY_YEARS,
      () => {},
      HRE_FIEF_OVERLAY_YEARS,
    ),
    createFranceFiefOverlayLoader(fetchFn, FRANCE_FIEF_OVERLAY_YEARS),
    undefined,
    undefined,
    createItalyFiefOverlayLoader(fetchFn, ITALY_FIEF_OVERLAY_YEARS),
    createCliopatriaFiefOverlayLoader(fetchFn, CLIOPATRIA_FIEF_OVERLAY_YEARS),
  );
  const data = await loader.load(1000);
  assertEquals(data.base.features[0].properties?.NAME, "Kingdom of France");
  assertEquals(
    data.cliopatriaFiefs.features[0].properties?.NAME,
    "Duchy of Aquitaine",
  );
  assert(calls.includes("/data/cliopatria_fiefs_flat_1000.geojson"));
});

Deno.test("createCombinedYearLoader は Cliopatria ローダを省略しても従来どおり動く（後方互換・未生成時の縮退。TASK-110）", async () => {
  const fetchFn = (url: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fakeCollection(url)),
    });
  const loader = createCombinedYearLoader(
    createYearDataLoader(fetchFn),
    createHreOverlayLoader(fetchFn, HRE_OVERLAY_YEARS),
  );
  const data = await loader.load(1200);
  assertEquals(data.cliopatriaFiefs, EMPTY_FEATURE_COLLECTION);
});

// ---- ブリテン諸島の政体オーバーレイ（#172）----

Deno.test("britainFiefDataUrlFor はブリテン諸島オーバーレイ GeoJSON のパスを返す（#172）", () => {
  // 参照先は重なりを排他化した flat（scripts/build-fief-flat.ts）。
  // 生データ britain_fiefs_<year> は派生データの入力で、配信もしない。
  assertEquals(
    britainFiefDataUrlFor(1000),
    "/data/britain_fiefs_flat_1000.geojson",
  );
  assertEquals(
    britainFiefDataUrlFor(1700),
    "/data/britain_fiefs_flat_1700.geojson",
  );
});

Deno.test("hasBritainFiefOverlay は対象年（1000〜1700 の 12 年）でのみ true（#172）", () => {
  for (const year of BRITAIN_FIEF_OVERLAY_YEARS) {
    assert(hasBritainFiefOverlay(year, BRITAIN_FIEF_OVERLAY_YEARS));
  }
  // 1715 以降は base が UK とアイルランド王国を分けて収録するため対象外
  for (const year of [1715, 1783, 1800, 1815, 1914]) {
    assert(!hasBritainFiefOverlay(year, BRITAIN_FIEF_OVERLAY_YEARS));
  }
});

Deno.test("createBritainFiefOverlayLoader は非対象年では fetch せず空 FC を返す（#172）", async () => {
  let count = 0;
  const loader = createBritainFiefOverlayLoader(() => {
    count++;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fakeCollection("X")),
    });
  }, BRITAIN_FIEF_OVERLAY_YEARS);
  assertEquals(await loader.load(1715), EMPTY_FEATURE_COLLECTION);
  assertEquals(count, 0);
  assert(loader.has(1715));
});

Deno.test("createBritainFiefOverlayLoader は対象年で britain_fiefs_flat を fetch して返す（キャッシュあり）（#172）", async () => {
  const calls: string[] = [];
  const loader = createBritainFiefOverlayLoader((url) => {
    calls.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fakeCollection("Kingdom of Gwynedd")),
    });
  }, BRITAIN_FIEF_OVERLAY_YEARS);
  const data = await loader.load(1000);
  assertEquals(data.features[0].properties?.NAME, "Kingdom of Gwynedd");
  assertEquals(calls, ["/data/britain_fiefs_flat_1000.geojson"]);
  await loader.load(1000);
  assertEquals(calls, ["/data/britain_fiefs_flat_1000.geojson"]);
});

Deno.test("createBritainFiefOverlayLoader は取得失敗時に warn して空 FC で縮退する（#172）", async () => {
  const warns: string[] = [];
  let count = 0;
  const loader = createBritainFiefOverlayLoader(
    () => {
      count++;
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      });
    },
    BRITAIN_FIEF_OVERLAY_YEARS,
    (msg) => warns.push(msg),
  );
  assertEquals(await loader.load(1000), EMPTY_FEATURE_COLLECTION);
  assertEquals(warns.length, 1);
  assert(!loader.has(1000));
  // 失敗はキャッシュされず、次のロードで再試行される
  await loader.load(1000);
  assertEquals(count, 2);
});

Deno.test("createCombinedYearLoader はブリテン諸島オーバーレイも同時に返す（#172）", async () => {
  const calls: string[] = [];
  const fetchFn = (url: string) => {
    calls.push(url);
    const name = url.includes("britain_fiefs")
      ? "Kingdom of Gwynedd"
      : url.includes("cliopatria_fiefs")
      ? "Duchy of Aquitaine"
      : "Kingdom of France";
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fakeCollection(name)),
    });
  };
  const loader = createCombinedYearLoader(
    createYearDataLoader(fetchFn),
    createHreOverlayLoader(
      fetchFn,
      HRE_ALL_OVERLAY_YEARS,
      () => {},
      HRE_FIEF_OVERLAY_YEARS,
    ),
    createFranceFiefOverlayLoader(fetchFn, FRANCE_FIEF_OVERLAY_YEARS),
    undefined,
    undefined,
    createItalyFiefOverlayLoader(fetchFn, ITALY_FIEF_OVERLAY_YEARS),
    createCliopatriaFiefOverlayLoader(fetchFn, CLIOPATRIA_FIEF_OVERLAY_YEARS),
    createBritainFiefOverlayLoader(fetchFn, BRITAIN_FIEF_OVERLAY_YEARS),
  );
  const data = await loader.load(1000);
  assertEquals(
    data.britainFiefs.features[0].properties?.NAME,
    "Kingdom of Gwynedd",
  );
  assert(calls.includes("/data/britain_fiefs_flat_1000.geojson"));
  // 近世（1600）はブリテンだけが対象で、中世限定のオーバーレイは空 FC のまま
  const early = await loader.load(1600);
  assertEquals(
    early.britainFiefs.features[0].properties?.NAME,
    "Kingdom of Gwynedd",
  );
  assertEquals(early.fiefs, EMPTY_FEATURE_COLLECTION);
  assertEquals(early.italyFiefs, EMPTY_FEATURE_COLLECTION);
  assertEquals(early.cliopatriaFiefs, EMPTY_FEATURE_COLLECTION);
});

Deno.test("createCombinedYearLoader はブリテンローダを省略しても従来どおり動く（後方互換・未生成時の縮退。#172）", async () => {
  const fetchFn = (url: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fakeCollection(url)),
    });
  const loader = createCombinedYearLoader(
    createYearDataLoader(fetchFn),
    createHreOverlayLoader(fetchFn, HRE_OVERLAY_YEARS),
  );
  const data = await loader.load(1200);
  assertEquals(data.britainFiefs, EMPTY_FEATURE_COLLECTION);
});

// ---- 主権政体オーバーレイ（#189）----

Deno.test("sovereignFiefDataUrlFor は主権政体オーバーレイ GeoJSON のパスを返す（#189）", () => {
  // 参照先は重なりを排他化した flat（scripts/build-fief-flat.ts）。
  // 生データ sovereign_fiefs_<year> は派生データの入力で、配信もしない。
  assertEquals(
    sovereignFiefDataUrlFor(1200),
    "/data/sovereign_fiefs_flat_1200.geojson",
  );
  assertEquals(
    sovereignFiefDataUrlFor(1900),
    "/data/sovereign_fiefs_flat_1900.geojson",
  );
});

Deno.test("hasSovereignFiefOverlay は対象年（1000〜1914 の 19 年）でのみ true（#189/#190/#191）", () => {
  for (const year of SOVEREIGN_FIEF_OVERLAY_YEARS) {
    assert(hasSovereignFiefOverlay(year, SOVEREIGN_FIEF_OVERLAY_YEARS));
  }
  // #190 で 1000〜1100（教皇領・バルセロナ伯領）・1279〜1300（アテネ公国・
  // アカイア公国）が、#191 で 1914（微小国家 4 政体）が対象年に加わり、
  // 全スナップショット年が対象になった
  for (const year of [1000, 1100, 1279, 1300, 1914]) {
    assert(hasSovereignFiefOverlay(year, SOVEREIGN_FIEF_OVERLAY_YEARS));
  }
  // 対象外はスナップショット年ですらない年だけ
  assert(!hasSovereignFiefOverlay(1850, SOVEREIGN_FIEF_OVERLAY_YEARS));
});

Deno.test("createSovereignFiefOverlayLoader は非対象年では fetch せず空 FC を返す（#189）", async () => {
  let count = 0;
  const loader = createSovereignFiefOverlayLoader(() => {
    count++;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fakeCollection("X")),
    });
  }, SOVEREIGN_FIEF_OVERLAY_YEARS);
  // #191 で 1914 も対象年になったため、非対象年はスナップショット年ですら
  // ない年（1850）で確かめる
  assertEquals(await loader.load(1850), EMPTY_FEATURE_COLLECTION);
  assertEquals(count, 0);
  assert(loader.has(1850));
});

Deno.test("createSovereignFiefOverlayLoader は対象年で sovereign_fiefs_flat を fetch して返す（キャッシュあり）（#189）", async () => {
  const calls: string[] = [];
  const loader = createSovereignFiefOverlayLoader((url) => {
    calls.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fakeCollection("Grand Duchy of Finland")),
    });
  }, SOVEREIGN_FIEF_OVERLAY_YEARS);
  const data = await loader.load(1815);
  assertEquals(data.features[0].properties?.NAME, "Grand Duchy of Finland");
  assertEquals(calls, ["/data/sovereign_fiefs_flat_1815.geojson"]);
  await loader.load(1815);
  assertEquals(calls, ["/data/sovereign_fiefs_flat_1815.geojson"]);
});

Deno.test("createSovereignFiefOverlayLoader は取得失敗時に warn して空 FC で縮退する（#189）", async () => {
  const warns: string[] = [];
  let count = 0;
  const loader = createSovereignFiefOverlayLoader(
    () => {
      count++;
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      });
    },
    SOVEREIGN_FIEF_OVERLAY_YEARS,
    (msg) => warns.push(msg),
  );
  assertEquals(await loader.load(1815), EMPTY_FEATURE_COLLECTION);
  assertEquals(warns.length, 1);
  assert(!loader.has(1815));
  // 失敗はキャッシュされず、次のロードで再試行される
  await loader.load(1815);
  assertEquals(count, 2);
});

Deno.test("createCombinedYearLoader は主権政体オーバーレイも同時に返す（#189）", async () => {
  const calls: string[] = [];
  const fetchFn = (url: string) => {
    calls.push(url);
    const name = url.includes("sovereign_fiefs")
      ? "Grand Duchy of Finland"
      : "Kingdom of France";
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fakeCollection(name)),
    });
  };
  const loader = createCombinedYearLoader(
    createYearDataLoader(fetchFn),
    createHreOverlayLoader(
      fetchFn,
      HRE_ALL_OVERLAY_YEARS,
      () => {},
      HRE_FIEF_OVERLAY_YEARS,
    ),
    createFranceFiefOverlayLoader(fetchFn, FRANCE_FIEF_OVERLAY_YEARS),
    undefined,
    undefined,
    createItalyFiefOverlayLoader(fetchFn, ITALY_FIEF_OVERLAY_YEARS),
    createCliopatriaFiefOverlayLoader(fetchFn, CLIOPATRIA_FIEF_OVERLAY_YEARS),
    createBritainFiefOverlayLoader(fetchFn, BRITAIN_FIEF_OVERLAY_YEARS),
    createSovereignFiefOverlayLoader(fetchFn, SOVEREIGN_FIEF_OVERLAY_YEARS),
  );
  // 1815 は主権政体だけが対象（中世限定のオーバーレイは空 FC のまま）
  const data = await loader.load(1815);
  assertEquals(
    data.sovereignFiefs.features[0].properties?.NAME,
    "Grand Duchy of Finland",
  );
  assert(calls.includes("/data/sovereign_fiefs_flat_1815.geojson"));
  assertEquals(data.fiefs, EMPTY_FEATURE_COLLECTION);
  assertEquals(data.italyFiefs, EMPTY_FEATURE_COLLECTION);
  assertEquals(data.cliopatriaFiefs, EMPTY_FEATURE_COLLECTION);
  assertEquals(data.britainFiefs, EMPTY_FEATURE_COLLECTION);
});

Deno.test("createCombinedYearLoader は主権政体ローダを省略しても従来どおり動く（後方互換・未生成時の縮退。#189）", async () => {
  const fetchFn = (url: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fakeCollection(url)),
    });
  const loader = createCombinedYearLoader(
    createYearDataLoader(fetchFn),
    createHreOverlayLoader(fetchFn, HRE_OVERLAY_YEARS),
  );
  const data = await loader.load(1200);
  assertEquals(data.sovereignFiefs, EMPTY_FEATURE_COLLECTION);
});

// ---------------------------------------------------------------------------
// #202 / ADR-0033: 隣接年から流用した面のマージ
// ---------------------------------------------------------------------------

/** 借用ファイル相当の FeatureCollection（metadata に出典を持つ） */
function fakeBorrowedCollection(name: string): FeatureCollection {
  return {
    ...fakeCollection(name),
    metadata: {
      source: "Territories of the Holy Roman Empire (Roller, ETH Zürich)",
      sourceUrl: "https://doi.org/10.3929/ethz-b-000472583",
      license: "CC BY-NC-SA 4.0",
      borrowedFrom: [{ name, year: 1500 }],
    },
  } as FeatureCollection;
}

Deno.test("borrowedHreDataUrlFor / borrowedItalyFiefDataUrlFor は系統ごとの借用 flat を指す（#202 / #215）", () => {
  // #215: 配信・表示するのはホスト系統 flat を差し引いた flat 版。借用元
  // （borrowed_<lineage>_<year>.geojson）は座標無改変のまま残る中間生成物。
  assertEquals(
    borrowedHreDataUrlFor(1492),
    "/data/borrowed_hre_flat_1492.geojson",
  );
  assertEquals(
    borrowedItalyFiefDataUrlFor(1492),
    "/data/borrowed_italy_flat_1492.geojson",
  );
});

Deno.test("mergeBorrowedFeatures は借用 feature を足し、その出典を feature 単位で持たせる（#202）", () => {
  const base = fakeCollection("County of Schaunberg");
  const borrowed = fakeBorrowedCollection("Archduchy of Austria");
  const merged = mergeBorrowedFeatures(base, borrowed);
  assertEquals(merged.features.length, 2);
  assertEquals(
    merged.features.map((feature) => feature.properties?.NAME),
    ["County of Schaunberg", "Archduchy of Austria"],
  );
  // 借用元のファイル metadata を feature へ写す（1 枚のレイヤーに 2 出典が
  // 載っても、クリックした feature の出典・ライセンスが正しく出る）
  assertEquals(
    merged.features[1].properties?.ATTRIBUTION,
    (borrowed as unknown as { metadata: unknown }).metadata,
  );
  // 既存 feature には触らない（同一参照のまま）
  assertEquals(merged.features[0], base.features[0]);
  // レイヤーの metadata（既存系統の出典）は借用で書き換えない
  assertEquals(
    (merged as unknown as { metadata?: unknown }).metadata,
    (base as unknown as { metadata?: unknown }).metadata,
  );
});

Deno.test("mergeBorrowedFeatures は借用が無ければ入力をそのまま返す（deck.gl の差分更新を壊さない）", () => {
  const base = fakeCollection("County of Schaunberg");
  assertEquals(mergeBorrowedFeatures(base, EMPTY_FEATURE_COLLECTION), base);
});

Deno.test("withBorrowedGeometry は対象年だけ借用ファイルを fetch してマージする（#202）", async () => {
  const calls: string[] = [];
  const fetchFn = (url: string) => {
    calls.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(
          url.includes("borrowed")
            ? fakeBorrowedCollection("Archduchy of Austria")
            : fakeCollection("County of Schaunberg"),
        ),
    });
  };
  const loader = withBorrowedGeometry(
    createHreOverlayLoader(
      fetchFn,
      HRE_ALL_OVERLAY_YEARS,
      () => {},
      HRE_FIEF_OVERLAY_YEARS,
    ),
    createBorrowedHreLoader(fetchFn, [1492], () => {}),
  );
  const borrowedYear = await loader.load(1492);
  assertEquals(
    borrowedYear.features.map((feature) => feature.properties?.NAME),
    ["County of Schaunberg", "Archduchy of Austria"],
  );
  assertEquals(calls, [
    "/data/hre_fiefs_flat_1492.geojson",
    "/data/borrowed_hre_flat_1492.geojson",
  ]);
  // 借用の無い年は借用ファイルを fetch しない（404 のノイズを出さない）
  const plainYear = await loader.load(1400);
  assertEquals(
    plainYear.features.map((feature) => feature.properties?.NAME),
    ["County of Schaunberg"],
  );
  assertEquals(calls, [
    "/data/hre_fiefs_flat_1492.geojson",
    "/data/borrowed_hre_flat_1492.geojson",
    "/data/hre_fiefs_flat_1400.geojson",
  ]);
  assert(loader.has(1492));
});

Deno.test("withBorrowedGeometry は借用ファイルの取得失敗時に base だけで表示し再試行に委ねる（#202 / #217）", async () => {
  const warnings: string[] = [];
  const fetchFn = (url: string) =>
    Promise.resolve(
      url.includes("borrowed")
        ? { ok: false, status: 404, json: () => Promise.resolve({}) }
        : {
          ok: true,
          status: 200,
          json: () => Promise.resolve(fakeCollection("County of Schaunberg")),
        },
    );
  const loader = withBorrowedGeometry(
    createHreOverlayLoader(
      fetchFn,
      HRE_ALL_OVERLAY_YEARS,
      () => {},
      HRE_FIEF_OVERLAY_YEARS,
    ),
    createBorrowedHreLoader(fetchFn, [1492], (message) => {
      warnings.push(message);
    }),
  );
  const fc = await loader.load(1492);
  assertEquals(
    fc.features.map((feature) => feature.properties?.NAME),
    ["County of Schaunberg"],
  );
  assertEquals(warnings.length, 1);
});

Deno.test("withBorrowedGeometry は内側ローダの縮退結果をキャッシュせず再試行する（#217 AC1）", async () => {
  // 1492 年で base（hre_fiefs_flat）が 5xx になり借用だけ取れたケース。
  // 縮退したマージ結果（借用面 1 枚だけ）を merged に恒久キャッシュすると、
  // 復旧後も内側 fetch が二度と走らず OHM 由来の領邦が消えたままになる。
  let hreFails = true;
  const hreCalls: string[] = [];
  const fetchFn = (url: string) => {
    if (url.includes("borrowed")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(fakeBorrowedCollection("Archduchy of Austria")),
      });
    }
    hreCalls.push(url);
    return Promise.resolve(
      hreFails ? { ok: false, status: 500, json: () => Promise.resolve({}) } : {
        ok: true,
        status: 200,
        json: () => Promise.resolve(fakeCollection("County of Schaunberg")),
      },
    );
  };
  const loader = withBorrowedGeometry(
    createHreOverlayLoader(
      fetchFn,
      HRE_ALL_OVERLAY_YEARS,
      () => {},
      HRE_FIEF_OVERLAY_YEARS,
    ),
    createBorrowedHreLoader(fetchFn, [1492], () => {}),
  );
  const degraded = await loader.load(1492);
  assertEquals(
    degraded.features.map((feature) => feature.properties?.NAME),
    ["Archduchy of Austria"],
  );
  assertEquals(hreCalls.length, 1);
  // 縮退結果は「fetch なしで解決できる」扱いにしない
  assert(!loader.has(1492));
  // 復旧後の再 load で内側 fetch が再実行され、完全なマージ結果へ戻る
  hreFails = false;
  const recovered = await loader.load(1492);
  assertEquals(hreCalls.length, 2);
  assertEquals(
    recovered.features.map((feature) => feature.properties?.NAME),
    ["County of Schaunberg", "Archduchy of Austria"],
  );
});

Deno.test("withBorrowedGeometry の has はマージ済みキャッシュを見る（#217 AC3）", async () => {
  const hreCalls: string[] = [];
  const fetchFn = (url: string) => {
    if (!url.includes("borrowed")) hreCalls.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(
          url.includes("borrowed")
            ? fakeBorrowedCollection("Archduchy of Austria")
            : fakeCollection("County of Schaunberg"),
        ),
    });
  };
  const loader = withBorrowedGeometry(
    createHreOverlayLoader(
      fetchFn,
      HRE_ALL_OVERLAY_YEARS,
      () => {},
      HRE_FIEF_OVERLAY_YEARS,
    ),
    createBorrowedHreLoader(fetchFn, [1492], () => {}),
  );
  const first = await loader.load(1492);
  // 内側 hre ローダの LRU（上限 YEAR_CACHE_MAX_YEARS 年）から 1492 を追い出す
  for (const year of [1000, 1100, 1200, 1300]) await loader.load(year);
  // merged キャッシュは借用年しか持たないため 1492 を保持し続けており、
  // fetch なしで解決できる → has は true でローディング表示を出さない
  assert(loader.has(1492));
  const callsBefore = hreCalls.length;
  const second = await loader.load(1492);
  assertStrictEquals(second, first);
  assertEquals(hreCalls.length, callsBefore);
});

Deno.test("withBorrowedGeometry は正当に空の base（取得成功）でも毎回 fetch しない（#217 回帰）", async () => {
  // base 側ファイルが取得成功しつつ 0 件のケース。縮退（取得失敗）と同じ
  // 空 FC に見えるが、内側ローダがキャッシュ済みなので再 fetch は起きない。
  let hreCalls = 0;
  const fetchFn = (url: string) => {
    if (!url.includes("borrowed")) hreCalls++;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(
          url.includes("borrowed")
            ? fakeBorrowedCollection("Archduchy of Austria")
            : { type: "FeatureCollection", features: [] },
        ),
    });
  };
  const loader = withBorrowedGeometry(
    createHreOverlayLoader(
      fetchFn,
      HRE_ALL_OVERLAY_YEARS,
      () => {},
      HRE_FIEF_OVERLAY_YEARS,
    ),
    createBorrowedHreLoader(fetchFn, [1492], () => {}),
  );
  const first = await loader.load(1492);
  assertEquals(
    first.features.map((feature) => feature.properties?.NAME),
    ["Archduchy of Austria"],
  );
  const second = await loader.load(1492);
  assertEquals(
    second.features.map((feature) => feature.properties?.NAME),
    ["Archduchy of Austria"],
  );
  assertEquals(hreCalls, 1);
  // 空でも取得済みの年は fetch なしで解決できる → スピナーを出さない
  assert(loader.has(1492));
});

// ---- 初期年代ロードの前倒し（withPrimedYear、#249） ----

/** テスト用: load 呼び出し年を記録する最小ローダ（T = string） */
function recordingPrimableLoader(): {
  loader: { load(year: number): Promise<string>; has(year: number): boolean };
  calls: number[];
} {
  const calls: number[] = [];
  return {
    calls,
    loader: {
      has: (year) => calls.includes(year),
      load(year) {
        calls.push(year);
        return Promise.resolve(`data-${year}`);
      },
    },
  };
}

Deno.test("withPrimedYear は生成と同期に指定年の load を 1 回だけ開始する（#249 AC2）", () => {
  const { loader, calls } = recordingPrimableLoader();
  withPrimedYear(loader, 1000);
  // await も map load も待たず、生成した時点で取得が始まっている
  assertEquals(calls, [1000]);
});

Deno.test("withPrimedYear の最初の load(指定年) は前倒し結果を返し、内側 load を増やさない（#249）", async () => {
  const { loader, calls } = recordingPrimableLoader();
  const primed = withPrimedYear(loader, 1000);
  assertEquals(await primed.load(1000), "data-1000");
  assertEquals(calls, [1000]);
});

Deno.test("withPrimedYear は指定年以外・2 回目以降の load を内側へ委譲する（#249）", async () => {
  const { loader, calls } = recordingPrimableLoader();
  const primed = withPrimedYear(loader, 1000);
  assertEquals(await primed.load(1200), "data-1200");
  await primed.load(1000); // 前倒し分の一度きり消費
  await primed.load(1000); // 以降は内側（キャッシュ）へ
  assertEquals(calls, [1000, 1200, 1000]);
});

Deno.test("withPrimedYear の has は内側へ委譲する（#249）", async () => {
  const { loader } = recordingPrimableLoader();
  const primed = withPrimedYear(loader, 1000);
  assert(primed.has(1000)); // 前倒し load 済み → 内側の has が true
  assert(!primed.has(1200));
  await primed.load(1200);
  assert(primed.has(1200));
});

Deno.test("withPrimedYear は前倒しの失敗を消費まで unhandled rejection にせず、最初の load(指定年) の reject として伝える（#249）", async () => {
  const error = new Error("GeoJSON 取得失敗 (year=1000, status=500)");
  let callCount = 0;
  const loader = {
    has: () => false,
    load(_year: number) {
      callCount++;
      return callCount === 1
        ? Promise.reject<string>(error)
        : Promise.resolve("retried");
    },
  };
  const primed = withPrimedYear(loader, 1000);
  // 前倒し Promise が reject で settle した後まで消費を遅らせる。この間に
  // unhandled rejection が出れば deno test 自体が失敗する（出ないことの検証）。
  await new Promise((r) => setTimeout(r, 0));
  const thrown = await assertRejects(() => primed.load(1000));
  assertStrictEquals(thrown, error);
  // 失敗した前倒し結果は一度きりで破棄され、再試行は内側の素の load に届く
  assertEquals(await primed.load(1000), "retried");
  assertEquals(callCount, 2);
});
