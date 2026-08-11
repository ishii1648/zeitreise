import { assert, assertEquals } from "@std/assert";
import {
  allCityPositions,
  buildCityLabelData,
  buildCityMarkerData,
  CITIES_DATA_URL,
  type CitiesData,
  CITY_HIT_FILL_COLOR,
  CITY_HIT_RADIUS_PX,
  CITY_LABEL_PRIORITY_MAX,
  CITY_LABEL_PRIORITY_MIN,
  CITY_MARKER_RADIUS_PX,
  CITY_NAME_JA_OVERRIDES,
  CITY_PICK_TOLERANCE_PX,
  CITY_RANK_LIMIT_BASE,
  cityDisplayName,
  cityEntriesForYear,
  type CityEntry,
  cityPickLabel,
  filterCitiesByZoom,
  visibleCityRankLimit,
} from "./cities.ts";
import { MAX_LABEL_PRIORITY, MIN_LABEL_PRIORITY } from "./labels.ts";
import {
  CITY_HIT_LAYER_ID,
  isNearCursorRepickable,
  PICKING_RADIUS_PX,
} from "./picking.ts";
// data/cities.json は .json 拡張子なので `with { type: "json" }` の静的 import
// はモジュール解決の一部として扱われ、`deno test`（CI は --allow-read なしで
// 実行、scripts/name-ja_test.ts と同じ前提）でも読み取り可能。一方
// data/europe_*.geojson・data/hre_*.geojson（勢力名の出典）は .geojson 拡張子で
// あり、Deno は `type: "json"` 属性を付けても "Expected a Json module, but
// identified a Unknown module" として拒否する（拡張子ベースの media type
// 判定のため、権限とは無関係の技術的制約。動作確認済み）。そのため
// 「都市名 × 勢力名の綴り衝突」の判定は cities.json 側のみ実データ、
// 勢力名側は KNOWN_CITY_POWER_NAME_COLLISIONS の静的リスト
// （scripts/name-ja_test.ts の EXPECTED_NAMES と同じ「定数列挙 + 再生成
// コマンド明記」方式）で行う（TASK-47）。
import citiesData from "../data/cities.json" with { type: "json" };

/**
 * data/cities.json の都市名のうち、data/europe_*.geojson / data/hre_*.geojson
 * の NAME/SUBJECTO（勢力名）と綴りが衝突するもの一覧（TASK-47 時点）。
 * 再生成コマンド（リポジトリルートで実行、cities.json 由来分を除外した
 * 勢力名+河川名との積集合を取る）:
 *   python3 -c "import json,glob; s=set(); [s.update(v for f2 in [json.load(open(f))] for ft in f2['features'] for k in ('NAME','SUBJECTO') if (v:=ft['properties'].get(k))) for f in glob.glob('data/europe_*.geojson')+glob.glob('data/hre_*.geojson')]; s.update(v for ft in json.load(open('data/rivers.geojson'))['features'] if (v:=ft['properties'].get('name'))); c=json.load(open('data/cities.json')); names=set(x['name'] for cs in c['years'].values() for x in cs); print(json.dumps(sorted(names & s),ensure_ascii=False,indent=2))"
 */
const KNOWN_CITY_POWER_NAME_COLLISIONS: string[] = [
  // TASK-55 の下限確保で Algiers / Tunis は一時 data/cities.json から消えて
  // いたが、TASK-61 の採用件数拡大（20 → 23）で復帰したため再登録した
  // （Algiers: 1600〜1715 年、Tunis: 1492〜1530 年）。
  "Algiers",
  "Florence",
  "Genoa",
  "Granada",
  "Hamburg",
  "Milan",
  "Naples",
  "Tunis",
  "Venice",
];

/** テスト用の都市エントリを組み立てる */
function city(
  name: string,
  population: number | null = null,
  lon = 2.35,
  lat = 48.85,
  natureOfEstimate: "imputed" | null = null,
): CityEntry {
  return { name, lon, lat, population, natureOfEstimate };
}

function data(years: Record<string, unknown>): CitiesData {
  return { years } as CitiesData;
}

// ---- cityEntriesForYear ----

Deno.test("cityEntriesForYear: 該当年の都市配列を返す", () => {
  const d = data({ "1500": [city("Paris", 200000)] });
  const entries = cityEntriesForYear(d, 1500);
  assertEquals(entries.length, 1);
  assertEquals(entries[0].name, "Paris");
  assertEquals(entries[0].population, 200000);
});

Deno.test("cityEntriesForYear: 年キーが無ければ空配列", () => {
  const d = data({ "1500": [city("Paris")] });
  assertEquals(cityEntriesForYear(d, 1600), []);
});

Deno.test("cityEntriesForYear: データ不正形（null / years 非オブジェクト）は空配列", () => {
  assertEquals(cityEntriesForYear(null as unknown as CitiesData, 1500), []);
  assertEquals(
    cityEntriesForYear({ years: "broken" } as unknown as CitiesData, 1500),
    [],
  );
  assertEquals(cityEntriesForYear({} as unknown as CitiesData, 1500), []);
});

Deno.test("cityEntriesForYear: 年の値が配列でなければ空配列", () => {
  const d = data({ "1500": { name: "Paris" } });
  assertEquals(cityEntriesForYear(d, 1500), []);
});

Deno.test("cityEntriesForYear: 型が不正なエントリは除外する", () => {
  const d = data({
    "1500": [
      city("Paris", 200000),
      null,
      "London",
      { name: 42, lon: 0, lat: 0, population: null },
      { name: "NoLon", lat: 0, population: null },
      { name: "BadLat", lon: 0, lat: Number.NaN, population: null },
    ],
  });
  const entries = cityEntriesForYear(d, 1500);
  assertEquals(entries.map((e) => e.name), ["Paris"]);
});

Deno.test("cityEntriesForYear: population 欠落・非数値は null に正規化する", () => {
  const d = data({
    "1500": [
      { name: "A", lon: 0, lat: 0 },
      { name: "B", lon: 0, lat: 0, population: "many" },
      { name: "C", lon: 0, lat: 0, population: 5000 },
    ],
  });
  const entries = cityEntriesForYear(d, 1500);
  assertEquals(entries.map((e) => e.population), [null, null, 5000]);
});

Deno.test("cityEntriesForYear: natureOfEstimate は 'imputed' のみ保持し、欠落・未知値は null に正規化する（Issue #221 AC3）", () => {
  const d = data({
    "1200": [
      // 補間値（生成側が付けるフラグ）
      {
        name: "Copenhagen",
        lon: 12.57,
        lat: 55.68,
        natureOfEstimate: "imputed",
      },
      // 実測記録（フラグ無し = 旧データと同形）
      { name: "Paris", lon: 2.35, lat: 48.85, population: 110000 },
      // 未知の文字列（Buringh 2021 の語彙にある "proxied" 含む）は採らない
      { name: "A", lon: 0, lat: 0, natureOfEstimate: "proxied" },
      // 型不正（数値）も null
      { name: "B", lon: 0, lat: 0, natureOfEstimate: 42 },
    ],
  });
  const entries = cityEntriesForYear(d, 1200);
  assertEquals(
    entries.map((e) => e.natureOfEstimate),
    ["imputed", null, null, null],
  );
});

// ---- cityDisplayName ----

Deno.test("cityDisplayName: 通常は ja 適用・未登録は英語フォールバック", () => {
  assertEquals(cityDisplayName("Paris", { Paris: "パリ" }), "パリ");
  assertEquals(cityDisplayName("London", {}), "London");
});

Deno.test("cityDisplayName: 勢力名と衝突する都市はオーバーライド訳が勝つ", () => {
  // name-ja.json は勢力名と共有のフラットマップのため、Venice 等は
  // 「ヴェネツィア共和国」（勢力訳）になってしまう。都市表示では都市訳を使う。
  const ja = {
    Venice: "ヴェネツィア共和国",
    Milan: "ミラノ公国",
    Naples: "ナポリ王国",
    Granada: "グラナダ王国",
  };
  assertEquals(cityDisplayName("Venice", ja), "ヴェネツィア");
  assertEquals(cityDisplayName("Milan", ja), "ミラノ");
  assertEquals(cityDisplayName("Naples", ja), "ナポリ");
  assertEquals(cityDisplayName("Granada", ja), "グラナダ");
});

Deno.test("cityDisplayName: TASK-47 で追加した都市名/勢力名衝突（Algiers/Florence/Genoa/Hamburg/Tunis）もオーバーライド訳が勝つ", () => {
  // name-ja.json 側が将来「勢力名」形（例: フィレンツェ公国）に変わっても
  // 都市表示が壊れないよう、都市訳を明示的に固定する（Venice 等と同じ意図）。
  const ja = {
    Algiers: "アルジェ首長国",
    Florence: "フィレンツェ公国",
    Genoa: "ジェノヴァ共和国",
    Hamburg: "ハンブルク自由市",
    Tunis: "チュニス太守国",
  };
  assertEquals(cityDisplayName("Algiers", ja), "アルジェ");
  assertEquals(cityDisplayName("Florence", ja), "フィレンツェ");
  assertEquals(cityDisplayName("Genoa", ja), "ジェノヴァ");
  assertEquals(cityDisplayName("Hamburg", ja), "ハンブルク");
  assertEquals(cityDisplayName("Tunis", ja), "チュニス");
});

Deno.test("CITY_NAME_JA_OVERRIDES: 既知の都市名×勢力名衝突は全て登録済み", () => {
  const missing = KNOWN_CITY_POWER_NAME_COLLISIONS.filter(
    (name) => !(name in CITY_NAME_JA_OVERRIDES),
  );
  assertEquals(
    missing,
    [],
    `衝突するが CITY_NAME_JA_OVERRIDES 未登録: ${missing.join(", ")}`,
  );
});

Deno.test("KNOWN_CITY_POWER_NAME_COLLISIONS: 実データ（data/cities.json）に存在しない名前が残っていない（リスト陳腐化の検出）", () => {
  const cities = citiesData as { years: Record<string, { name: string }[]> };
  const cityNames = new Set<string>();
  for (const entries of Object.values(cities.years)) {
    for (const entry of entries) cityNames.add(entry.name);
  }
  const stale = KNOWN_CITY_POWER_NAME_COLLISIONS.filter(
    (name) => !cityNames.has(name),
  );
  assertEquals(
    stale,
    [],
    `data/cities.json に存在しなくなった衝突名（リスト更新が必要）: ${
      stale.join(", ")
    }`,
  );
});

// ---- cityPickLabel（Issue #221 AC3）----

Deno.test("cityPickLabel: 人口不明（null）は表示名のみ", () => {
  assertEquals(
    cityPickLabel(
      { name: "Paris", population: null, natureOfEstimate: null },
      { Paris: "パリ" },
    ),
    "パリ",
  );
});

Deno.test("cityPickLabel: 実測人口は「表示名 人口約N人」（桁区切りあり・補間マーカーなし）", () => {
  assertEquals(
    cityPickLabel(
      { name: "Paris", population: 200000, natureOfEstimate: null },
      { Paris: "パリ" },
    ),
    "パリ 人口約200,000人",
  );
});

Deno.test("cityPickLabel: 補間値（natureOfEstimate: 'imputed'）は末尾に（補間値）を付し実測と区別できる", () => {
  assertEquals(
    cityPickLabel(
      { name: "Copenhagen", population: 30000, natureOfEstimate: "imputed" },
      { Copenhagen: "コペンハーゲン" },
    ),
    "コペンハーゲン 人口約30,000人（補間値）",
  );
});

Deno.test("cityPickLabel: 表示名は cityDisplayName の解決順（オーバーライド → ja → 英語）", () => {
  // Venice は勢力訳（ヴェネツィア共和国）でなく都市オーバーライド訳が勝つ
  assertEquals(
    cityPickLabel(
      { name: "Venice", population: 100000, natureOfEstimate: null },
      { Venice: "ヴェネツィア共和国" },
    ),
    "ヴェネツィア 人口約100,000人",
  );
  // ja 未登録は英語名フォールバック
  assertEquals(
    cityPickLabel(
      { name: "London", population: null, natureOfEstimate: null },
      {},
    ),
    "London",
  );
});

// ---- buildCityLabelData ----

Deno.test("buildCityLabelData: ja 適用と英語フォールバック", () => {
  const entries = [city("Paris", 200000), city("London", 50000)];
  const ja = { Paris: "パリ" };
  const labels = buildCityLabelData(entries, ja);
  assertEquals(labels.map((l) => l.text), ["パリ", "London"]);
  assertEquals(labels[0].position, [2.35, 48.85]);
});

Deno.test("buildCityLabelData: 勢力名と衝突する都市名はオーバーライド訳で表示する", () => {
  const labels = buildCityLabelData(
    [city("Venice", 100000)],
    { Venice: "ヴェネツィア共和国" },
  );
  assertEquals(labels.map((l) => l.text), ["ヴェネツィア"]);
});

Deno.test("buildCityLabelData: name 空のエントリは除外する", () => {
  const labels = buildCityLabelData([city(""), city("Paris")], {});
  assertEquals(labels.map((l) => l.text), ["Paris"]);
});

Deno.test("buildCityLabelData: priority は都市固定バンド内に収まる", () => {
  const entries = [
    city("None", null),
    city("Zero", 0),
    city("Small", 1000),
    city("Big", 500000),
    city("Huge", 100_000_000),
  ];
  for (const l of buildCityLabelData(entries, {})) {
    assert(
      l.priority >= CITY_LABEL_PRIORITY_MIN &&
        l.priority <= CITY_LABEL_PRIORITY_MAX,
      `priority ${l.priority} がバンド外`,
    );
  }
});

Deno.test("buildCityLabelData: priority は人口に対して単調非減少", () => {
  const [small, mid, big] = buildCityLabelData(
    [city("S", 1000), city("M", 100000), city("B", 1_000_000)],
    {},
  );
  assert(small.priority <= mid.priority);
  assert(mid.priority <= big.priority);
  assert(small.priority < big.priority, "人口差 1000 倍で優先度が上がること");
});

Deno.test("buildCityLabelData: population null はバンド下限の priority", () => {
  const [l] = buildCityLabelData([city("Unknown", null)], {});
  assertEquals(l.priority, CITY_LABEL_PRIORITY_MIN);
});

Deno.test("都市 priority バンドは CollisionFilterExtension の許容レンジ内の中位帯", () => {
  // 国名ラベルの面積由来 priority（実測 -400〜300 程度）と競る中位帯であること
  assert(CITY_LABEL_PRIORITY_MIN >= MIN_LABEL_PRIORITY);
  assert(CITY_LABEL_PRIORITY_MAX <= MAX_LABEL_PRIORITY);
  assert(CITY_LABEL_PRIORITY_MIN > 0, "小勢力ラベル（負値）には勝つこと");
  assert(CITY_LABEL_PRIORITY_MAX < 300, "大国ラベル（300 付近）には負けること");
});

// ---- buildCityMarkerData ----

Deno.test("buildCityMarkerData: name と position [lon, lat] へ変換する", () => {
  const markers = buildCityMarkerData([city("Paris", 200000, 2.35, 48.85)]);
  assertEquals(markers, [{
    name: "Paris",
    position: [2.35, 48.85],
    population: 200000,
    natureOfEstimate: null,
  }]);
});

Deno.test("buildCityMarkerData: population / natureOfEstimate を伝搬する（picking 表示用。Issue #221 AC3）", () => {
  const markers = buildCityMarkerData([
    city("Copenhagen", 30000, 12.57, 55.68, "imputed"),
    city("Unknown", null, 0, 0),
  ]);
  assertEquals(
    markers.map((m) => [m.population, m.natureOfEstimate]),
    [[30000, "imputed"], [null, null]],
  );
});

Deno.test("buildCityMarkerData: name 空のエントリは除外する", () => {
  const markers = buildCityMarkerData([city(""), city("Rome")]);
  assertEquals(markers.map((m) => m.name), ["Rome"]);
});

// ---- visibleCityRankLimit（TASK-66 AC #2/#3）----

Deno.test("visibleCityRankLimit: z4 以下は基準件数（現状密度維持。AC #3）", () => {
  assertEquals(visibleCityRankLimit(4), CITY_RANK_LIMIT_BASE);
  // MIN_ZOOM=4 だが maxBounds クランプ等で下回っても基準件数のまま
  assertEquals(visibleCityRankLimit(3), CITY_RANK_LIMIT_BASE);
  assertEquals(visibleCityRankLimit(0), CITY_RANK_LIMIT_BASE);
});

Deno.test("visibleCityRankLimit: 小数ズームは整数段へ切り捨てて判定する", () => {
  // z4.99 はまだ z4 段（初期表示密度を保つ）。z5.0 で初めて拡大する
  assertEquals(visibleCityRankLimit(4.99), CITY_RANK_LIMIT_BASE);
  assertEquals(visibleCityRankLimit(5.0), visibleCityRankLimit(5.7));
  assertEquals(visibleCityRankLimit(6.2), visibleCityRankLimit(6.9));
});

Deno.test("visibleCityRankLimit: ズーム 1 段ごとに指数的（約 2 倍）に拡大する", () => {
  assertEquals(visibleCityRankLimit(5), 40);
  assertEquals(visibleCityRankLimit(6), 80);
  assertEquals(visibleCityRankLimit(7), 160);
});

Deno.test("visibleCityRankLimit: 最大ズーム z8 以上は全件（上限なし）", () => {
  assertEquals(visibleCityRankLimit(8), Number.POSITIVE_INFINITY);
  assertEquals(visibleCityRankLimit(12), Number.POSITIVE_INFINITY);
});

Deno.test("visibleCityRankLimit: ズームに対して単調非減少", () => {
  let prev = visibleCityRankLimit(0);
  for (let z = 0; z <= 10; z += 0.5) {
    const limit = visibleCityRankLimit(z);
    assert(limit >= prev, `z=${z} で上限が減少（${prev} → ${limit}）`);
    prev = limit;
  }
});

Deno.test("visibleCityRankLimit: 非有限ズーム（NaN 等）は基準件数へフォールバック", () => {
  assertEquals(visibleCityRankLimit(Number.NaN), CITY_RANK_LIMIT_BASE);
  assertEquals(
    visibleCityRankLimit(Number.NEGATIVE_INFINITY),
    CITY_RANK_LIMIT_BASE,
  );
});

// ---- filterCitiesByZoom（TASK-66 AC #2/#3）----

/** 人口 population の連番都市 n 件を生成する（C0 が最小人口） */
function rankedCities(n: number): CityEntry[] {
  return Array.from({ length: n }, (_, i) => city(`C${i}`, (i + 1) * 1000));
}

Deno.test("filterCitiesByZoom: 件数が上限以下なら全件をそのまま返す", () => {
  const entries = rankedCities(10);
  assertEquals(filterCitiesByZoom(entries, 4), entries);
});

Deno.test("filterCitiesByZoom: 人口降順の上位ランクだけを残す", () => {
  const entries = [
    city("Small", 1000),
    city("Big", 900000),
    city("Mid", 50000),
    city("Tiny", 10),
  ];
  // 上限 23 のため 30 件で超過させる代わりに、小さい zoom 段の意味論を
  // 直接テストできるよう十分な件数を用意する
  const many = [...entries, ...rankedCities(30)];
  const visible = filterCitiesByZoom(many, 4);
  assertEquals(visible.length, CITY_RANK_LIMIT_BASE);
  const names = visible.map((e) => e.name);
  assert(names.includes("Big"), "最大人口の都市は必ず残る");
  assert(!names.includes("Tiny"), "最小人口の都市は落ちる");
});

Deno.test("filterCitiesByZoom: 出力は元配列の並び順を保つ", () => {
  const entries = [...rankedCities(30)].reverse(); // C29(大) → C0(小)
  const visible = filterCitiesByZoom(entries, 4);
  const indexes = visible.map((e) => entries.indexOf(e));
  assertEquals(indexes, [...indexes].sort((a, b) => a - b));
});

Deno.test("filterCitiesByZoom: ズームインで表示件数が段階的に増える", () => {
  const entries = rankedCities(200);
  const z4 = filterCitiesByZoom(entries, 4).length;
  const z5 = filterCitiesByZoom(entries, 5).length;
  const z6 = filterCitiesByZoom(entries, 6).length;
  const z7 = filterCitiesByZoom(entries, 7).length;
  const z8 = filterCitiesByZoom(entries, 8).length;
  assertEquals([z4, z5, z6, z7, z8], [CITY_RANK_LIMIT_BASE, 40, 80, 160, 200]);
});

Deno.test("filterCitiesByZoom: 人口同数（ランク同数）は元配列で先のものが勝つ（決定的）", () => {
  // 上限ちょうどの境界に同人口都市を並べ、元配列順で決定的に切ること
  const filler = rankedCities(CITY_RANK_LIMIT_BASE - 1).map((e) => ({
    ...e,
    population: 1_000_000, // 全員が境界より上位
  }));
  const entries = [...filler, city("First", 500), city("Second", 500)];
  const visible = filterCitiesByZoom(entries, 4);
  const names = visible.map((e) => e.name);
  assert(names.includes("First"), "同人口なら元配列で先の都市を採用する");
  assert(!names.includes("Second"), "同人口で後の都市は上限で落ちる");
});

Deno.test("filterCitiesByZoom: population 欠落（null）は最下位ランク扱い", () => {
  const entries = [
    city("Unknown", null),
    ...rankedCities(CITY_RANK_LIMIT_BASE),
  ];
  const visible = filterCitiesByZoom(entries, 4);
  const names = visible.map((e) => e.name);
  assert(!names.includes("Unknown"), "population null は人口 0 より下位");
  assertEquals(visible.length, CITY_RANK_LIMIT_BASE);
});

Deno.test("filterCitiesByZoom: population null は人口 0 の都市よりも下位", () => {
  const filler = rankedCities(CITY_RANK_LIMIT_BASE - 1).map((e) => ({
    ...e,
    population: 1_000_000,
  }));
  const entries = [...filler, city("NullPop", null), city("ZeroPop", 0)];
  const visible = filterCitiesByZoom(entries, 4);
  const names = visible.map((e) => e.name);
  assert(names.includes("ZeroPop"), "人口 0 は null より上位で残る");
  assert(!names.includes("NullPop"), "population null が最下位で落ちる");
});

Deno.test("filterCitiesByZoom: 最大ズームでは population null 含め全件返す", () => {
  const entries = [city("Unknown", null), ...rankedCities(300)];
  assertEquals(filterCitiesByZoom(entries, 8).length, 301);
});

Deno.test("filterCitiesByZoom: 空配列は空配列のまま", () => {
  assertEquals(filterCitiesByZoom([], 4), []);
  assertEquals(filterCitiesByZoom([], 8), []);
});

Deno.test("CITY_RANK_LIMIT_BASE は現行データの採用上限 23 と同値（AC #3: 初期密度維持）", () => {
  // scripts/build-cities.ts の CITIES_PER_YEAR=20 + HRE 最低 6 件補充で
  // 実データは最大 23 件/年（TASK-61）。最遠ズームはこれと同じ密度を保つ。
  assertEquals(CITY_RANK_LIMIT_BASE, 23);
});

// ---- 都市 picking の実効判定範囲（TASK-82 AC #4）----

Deno.test("CITY_MARKER_RADIUS_PX: 可視ドットの半径は 3px（従来の見た目を変えない）（TASK-82）", () => {
  assertEquals(CITY_MARKER_RADIUS_PX, 3);
});

Deno.test("CITY_HIT_RADIUS_PX: 透明判定円の半径は 9px（AC #1 の目安 8〜10px 内）（TASK-82）", () => {
  assertEquals(CITY_HIT_RADIUS_PX, 9);
  assert(CITY_HIT_RADIUS_PX >= 8 && CITY_HIT_RADIUS_PX <= 10);
});

Deno.test("CITY_HIT_RADIUS_PX: 可視ドットより必ず大きい（判定だけを広げる層）（TASK-82）", () => {
  assert(CITY_HIT_RADIUS_PX > CITY_MARKER_RADIUS_PX);
});

Deno.test("CITY_PICK_TOLERANCE_PX: ドット半径と判定円半径の合成（大きい方）= 9px（TASK-82 AC #4）", () => {
  assertEquals(CITY_PICK_TOLERANCE_PX, 9);
  assertEquals(
    CITY_PICK_TOLERANCE_PX,
    Math.max(CITY_MARKER_RADIUS_PX, CITY_HIT_RADIUS_PX),
  );
});

Deno.test("CITY_PICK_TOLERANCE_PX: 近傍再ピック半径（PICKING_RADIUS_PX）は加算されない（ホバー = クリック）（TASK-82 AC #2/#4）", () => {
  // 河川（RIVER_CLICK_TOLERANCE_PX = 半幅 + PICKING_RADIUS_PX）と異なり、
  // 都市は cities-hit を近傍再ピックの候補から除外（picking.ts
  // isNearCursorRepickable）するため、クリックの実効範囲もこの値のまま。
  assert(!isNearCursorRepickable(CITY_HIT_LAYER_ID));
  assertEquals(CITY_PICK_TOLERANCE_PX, CITY_HIT_RADIUS_PX);
  assertEquals(CITY_PICK_TOLERANCE_PX + PICKING_RADIUS_PX, 15);
  assert(CITY_PICK_TOLERANCE_PX < CITY_PICK_TOLERANCE_PX + PICKING_RADIUS_PX);
});

Deno.test("CITY_PICK_TOLERANCE_PX: 従来のクリック実効範囲（ドット 3px + 再ピック 6px）と同値（クリック側は広げず、ホバーを揃える）（TASK-82）", () => {
  assertEquals(
    CITY_PICK_TOLERANCE_PX,
    CITY_MARKER_RADIUS_PX + PICKING_RADIUS_PX,
  );
});

Deno.test("CITY_HIT_FILL_COLOR: 完全透明（見た目に影響しない判定専用層）（TASK-82）", () => {
  assertEquals(CITY_HIT_FILL_COLOR[3], 0);
});

// ---- allCityPositions（TASK-136）----

Deno.test("allCityPositions: 全年代の都市座標の和集合を返す（年をまたぐ都市の追加分も含む）", () => {
  const d = data({
    "1000": [city("Paris", 20000, 2.35, 48.85)],
    "1200": [city("Cologne", 40000, 6.96, 50.94)],
  });
  assertEquals(allCityPositions(d), [[2.35, 48.85], [6.96, 50.94]]);
});

Deno.test("allCityPositions: 同一座標の都市は年をまたいで重複しない", () => {
  const d = data({
    "1000": [city("Paris", 20000, 2.35, 48.85)],
    "1200": [city("Paris", 110000, 2.35, 48.85)],
  });
  assertEquals(allCityPositions(d), [[2.35, 48.85]]);
});

Deno.test("allCityPositions: 不正エントリ・不正形データは除外して継続する", () => {
  const d = data({
    "1000": [city("Paris", 20000, 2.35, 48.85), { name: "Broken" }],
    "1200": "not-an-array",
  });
  assertEquals(allCityPositions(d), [[2.35, 48.85]]);
  assertEquals(allCityPositions({ years: null } as unknown as CitiesData), []);
});

Deno.test("allCityPositions: 決定的（同一入力 → 同一出力）", () => {
  // 実データの JSON は natureOfEstimate 等の任意フィールドを持たないエントリを
  // 含みうる（正規化は allCityPositions 側の責務）ため unknown 経由で渡す
  const d = citiesData as unknown as CitiesData;
  assertEquals(allCityPositions(d), allCityPositions(d));
  assert(allCityPositions(d).length > 0);
});

// ---- 契約 ----

Deno.test("CITIES_DATA_URL は /data/cities.json（build 成果物の配信パス契約）", () => {
  assertEquals(CITIES_DATA_URL, "/data/cities.json");
});
