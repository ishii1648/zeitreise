import { assert, assertEquals } from "@std/assert";
import {
  buildCitiesData,
  buildCitiesSourceUrl,
  CITIES_SOURCE_COMMIT,
  CITIES_SOURCE_FILE,
  CITIES_SOURCE_REPO,
  type CitiesData,
  type CityRow,
  filterCitiesToBbox,
  interpolatePopulation,
  MAX_CITIES_PER_YEAR,
  MIN_CITIES_PER_YEAR,
  parseChandlerCsv,
  pickNearestRecord,
  selectCitiesForYear,
  validateCitiesData,
} from "./build-cities.ts";
import { SNAPSHOT_YEARS } from "../src/config.ts";
import { EUROPE_BBOX } from "./build-data.ts";
// CI の `deno test` は権限なしで実行されるため、生成物はファイル読み込みではなく
// static import で検証する（scripts/name-ja_test.ts と同じ方式）。
import citiesJson from "../data/cities.json" with { type: "json" };

// ---------------------------------------------------------------------------
// buildCitiesSourceUrl
// ---------------------------------------------------------------------------

Deno.test("buildCitiesSourceUrl はピン留めコミットの raw URL を返す", () => {
  const url = buildCitiesSourceUrl();
  assertEquals(
    url,
    `https://raw.githubusercontent.com/${CITIES_SOURCE_REPO}/${CITIES_SOURCE_COMMIT}/${CITIES_SOURCE_FILE}`,
  );
});

// ---------------------------------------------------------------------------
// parseChandlerCsv
// ---------------------------------------------------------------------------

const FIXTURE_CSV = [
  "City,OtherName,Country,Latitude,Longitude,Certainty,BC_200,AD_900,AD_950,AD_1000",
  'Istanbul,"Constantinople, Byzantium",Turkey,41.01,28.96,1,,300000,,300000',
  "Rome,,Italy,41.89,12.48,1,100000,40000,,35000",
  "NoCoords,,Nowhere,,,1,,100,,",
  "NoRecords,,Italy,45.0,9.0,1,,,,",
  "Cairo,,Egypt,30.04,31.24,1,,150000,,135000",
].join("\n");

Deno.test("parseChandlerCsv は City/座標/年別人口を CityRow に変換する", () => {
  const rows = parseChandlerCsv(FIXTURE_CSV);
  const istanbul = rows.find((r) => r.name === "Istanbul");
  assert(istanbul !== undefined);
  assertEquals(istanbul.lat, 41.01);
  assertEquals(istanbul.lon, 28.96);
  assertEquals(istanbul.records, { 900: 300000, 1000: 300000 });
});

Deno.test("parseChandlerCsv は BC_ 列を負の年として読む", () => {
  const rows = parseChandlerCsv(FIXTURE_CSV);
  const rome = rows.find((r) => r.name === "Rome");
  assert(rome !== undefined);
  assertEquals(rome.records[-200], 100000);
});

Deno.test("parseChandlerCsv は引用符付き OtherName（カンマ入り）を壊さない", () => {
  const rows = parseChandlerCsv(FIXTURE_CSV);
  // "Constantinople, Byzantium" のカンマで列がずれると座標が NaN になり行が落ちる
  assert(rows.some((r) => r.name === "Istanbul"));
});

Deno.test("parseChandlerCsv は座標欠損・人口記録なしの行を除外する", () => {
  const rows = parseChandlerCsv(FIXTURE_CSV);
  const names = rows.map((r) => r.name);
  assert(!names.includes("NoCoords"));
  assert(!names.includes("NoRecords"));
});

// ---------------------------------------------------------------------------
// filterCitiesToBbox
// ---------------------------------------------------------------------------

Deno.test("filterCitiesToBbox は bbox 外の都市を除外する", () => {
  const rows = filterCitiesToBbox(parseChandlerCsv(FIXTURE_CSV), EUROPE_BBOX);
  const names = rows.map((r) => r.name);
  assert(names.includes("Istanbul"));
  assert(names.includes("Rome"));
  // Cairo は lat 30.04 < 34 で bbox 外
  assert(!names.includes("Cairo"));
});

// ---------------------------------------------------------------------------
// pickNearestRecord
// ---------------------------------------------------------------------------

Deno.test("pickNearestRecord はスナップショット年ちょうどの記録を最優先する", () => {
  const picked = pickNearestRecord({ 980: 10, 1000: 20, 1010: 30 }, 1000);
  assertEquals(picked, { year: 1000, population: 20 });
});

Deno.test("pickNearestRecord は年差が最小の記録を選ぶ", () => {
  const picked = pickNearestRecord({ 960: 10, 995: 20 }, 1000);
  assertEquals(picked, { year: 995, population: 20 });
});

Deno.test("pickNearestRecord は年差が同じなら過去の記録を優先する", () => {
  const picked = pickNearestRecord({ 990: 10, 1010: 20 }, 1000);
  assertEquals(picked, { year: 990, population: 10 });
});

Deno.test("pickNearestRecord は過去 50 年・未来 25 年の窓の外を無視する", () => {
  // 過去 51 年 → 窓外、過去 50 年 → 窓内
  assertEquals(pickNearestRecord({ 949: 10 }, 1000), null);
  assertEquals(pickNearestRecord({ 950: 10 }, 1000), {
    year: 950,
    population: 10,
  });
  // 未来 26 年 → 窓外、未来 25 年 → 窓内
  assertEquals(pickNearestRecord({ 1026: 10 }, 1000), null);
  assertEquals(pickNearestRecord({ 1025: 10 }, 1000), {
    year: 1025,
    population: 10,
  });
});

// ---------------------------------------------------------------------------
// interpolatePopulation（Issue #221: 内部ギャップの対数線形補間）
// ---------------------------------------------------------------------------

Deno.test("interpolatePopulation は前後の記録から対数線形で補間する", () => {
  // パリ相当: 記録 1000 年 20,000・1150 年 50,000 → 1100 年は
  // round(exp(ln(20000) + (ln(50000) − ln(20000)) × 100/150)) = 36,840
  assertEquals(
    interpolatePopulation({ 1000: 20000, 1150: 50000 }, 1100),
    36840,
  );
  // 等間隔の中点は幾何平均: sqrt(10000 × 40000) = 20,000
  assertEquals(
    interpolatePopulation({ 1000: 10000, 1200: 40000 }, 1100),
    20000,
  );
  // コペンハーゲン相当: 記録 1101 年 12,000・1400 年 30,000 → 1200 年 16,253
  assertEquals(
    interpolatePopulation({ 1101: 12000, 1400: 30000 }, 1200),
    16253,
  );
});

Deno.test("interpolatePopulation は対象年の直近の前後記録を使う（外側の記録は無視）", () => {
  // 1000/1300 でなく直近の 1000..1200 で補間する（1200 の記録が y1）
  assertEquals(
    interpolatePopulation(
      { 900: 999999, 1000: 10000, 1200: 40000, 1300: 1 },
      1100,
    ),
    20000,
  );
});

Deno.test("interpolatePopulation は片側にしか記録が無ければ null（外挿しない）", () => {
  assertEquals(interpolatePopulation({ 1000: 10000 }, 1100), null);
  assertEquals(interpolatePopulation({ 1000: 10000, 1050: 20000 }, 1100), null);
  assertEquals(interpolatePopulation({ 1200: 40000 }, 1100), null);
  assertEquals(interpolatePopulation({}, 1100), null);
});

Deno.test("interpolatePopulation は人口 0 以下を跨ぐ場合 null（対数が定義できない）", () => {
  assertEquals(interpolatePopulation({ 1000: 0, 1200: 40000 }, 1100), null);
  assertEquals(interpolatePopulation({ 1000: 10000, 1200: 0 }, 1100), null);
  assertEquals(interpolatePopulation({ 1000: -5, 1200: 40000 }, 1100), null);
});

// ---------------------------------------------------------------------------
// selectCitiesForYear
// ---------------------------------------------------------------------------

function row(
  name: string,
  lon: number,
  lat: number,
  records: Record<number, number>,
): CityRow {
  return { name, lon, lat, records };
}

Deno.test("selectCitiesForYear は人口降順・同数なら name 昇順で並べる", () => {
  const rows = [
    row("Small", 10, 50, { 1500: 1000 }),
    row("Big", 11, 51, { 1500: 9000 }),
    row("B-Tie", 12, 52, { 1500: 5000 }),
    row("A-Tie", 13, 53, { 1500: 5000 }),
  ];
  const markers = selectCitiesForYear(rows, 1500);
  assertEquals(markers.map((m) => m.name), ["Big", "A-Tie", "B-Tie", "Small"]);
  assertEquals(markers[0], { name: "Big", lon: 11, lat: 51, population: 9000 });
});

Deno.test("selectCitiesForYear は窓内に記録を持つ候補を全件採用する（上位切り詰めをしない）", () => {
  // TASK-66: 従来の「人口上位 CITIES_PER_YEAR 件 + 独語圏下限」の選定を廃止し、
  // 対応付け可能な候補は原則全件採用する（表示の間引きは表示側の責務）。
  const rows = Array.from(
    { length: 100 },
    (_, i) =>
      row(`City${String(i).padStart(3, "0")}`, 10, 50, { 1500: 1000 + i }),
  );
  const markers = selectCitiesForYear(rows, 1500);
  assertEquals(markers.length, 100);
  // 並びは人口降順のまま
  assertEquals(markers[0].population, 1099);
  assertEquals(markers[99].population, 1000);
});

Deno.test("selectCitiesForYear は窓外の都市（対応付け不能）だけを落とす", () => {
  const rows = [
    row("InWindow", 10, 50, { 1480: 5000 }),
    row("OutOfWindow", 11, 51, { 1400: 9000 }),
  ];
  const markers = selectCitiesForYear(rows, 1500);
  assertEquals(markers.map((m) => m.name), ["InWindow"]);
});

Deno.test("selectCitiesForYear は既知の重複・非都市エントリ（Gelibolu/Qum/Ruhr）を除外する", () => {
  const rows = [
    row("Gelibolu", 26.7, 40.4, { 1000: 300000 }),
    row("Qum", 50.9, 34.6, { 1000: 60000 }),
    row("Ruhr", 7.2, 51.5, { 1000: 700000 }),
    row("Rome", 12.48, 41.89, { 1000: 35000 }),
  ];
  const markers = selectCitiesForYear(rows, 1000);
  assertEquals(markers.map((m) => m.name), ["Rome"]);
});

Deno.test("selectCitiesForYear は既知の誤記録（Algiers 1925 等）を無視する", () => {
  const rows = [
    row("Algiers", 3.06, 36.77, { 1700: 85000, 1925: 2220000 }),
  ];
  // 1914 のスナップショットで 1925 の誤記録（2,220,000）を拾ってはいけない
  const markers = selectCitiesForYear(rows, 1914);
  assertEquals(markers, []);
  // 1700 の正しい記録はそのまま使われる
  const markers1700 = selectCitiesForYear(rows, 1700);
  assertEquals(markers1700.map((m) => m.population), [85000]);
});

Deno.test("selectCitiesForYear は Istanbul を Constantinople へ改名する", () => {
  const rows = [row("Istanbul", 28.96, 41.01, { 1000: 300000 })];
  const markers = selectCitiesForYear(rows, 1000);
  assertEquals(markers.map((m) => m.name), ["Constantinople"]);
});

Deno.test("selectCitiesForYear は Augsberg/Nurnberg を英語慣用綴りへ正規化する", () => {
  // Augsberg は元データの誤綴り（正: Augsburg）、Nurnberg の英語慣用綴りは
  // Nuremberg（TASK-55 で HRE 域内都市が採用されるようになったため対応）
  const rows = [
    row("Augsberg", 10.9, 48.37, { 1500: 34000 }),
    row("Nurnberg", 11.08, 49.45, { 1500: 31000 }),
  ];
  const markers = selectCitiesForYear(rows, 1500);
  assertEquals(markers.map((m) => m.name), ["Augsburg", "Nuremberg"]);
});

Deno.test("selectCitiesForYear は全件採用で露出する誤名称（Louveigne/Meckenbeuren 等）を正規化する", () => {
  // TASK-66 の全件採用で従来は選外だった行が出力に含まれるようになったため、
  // 元データの誤名称・誤綴りを正しい慣用名へ正規化する（CITY_RENAMES の
  // doc コメントに根拠を記載）。
  const rows = [
    row("Louveigne", 4.70, 50.88, { 1500: 25000 }), // 座標・別名とも Louvain（Leuven）
    row("Meckenbeuren", 11.41, 53.63, { 1880: 30000 }), // 座標・別名とも Schwerin
    row("Weisbaden", 8.24, 50.06, { 1880: 50000 }), // Wiesbaden の誤綴り
    row("Brunn", 16.62, 49.2, { 1500: 8000 }), // Brno の独語綴り
    row("Mulhausen", 7.34, 47.75, { 1880: 60000 }), // Mulhouse の独語綴り
  ];
  assertEquals(selectCitiesForYear(rows, 1500).map((m) => m.name), [
    "Louvain",
    "Brno",
  ]);
  assertEquals(selectCitiesForYear(rows, 1880).map((m) => m.name).sort(), [
    "Mulhouse",
    "Schwerin",
    "Wiesbaden",
  ]);
});

Deno.test("selectCitiesForYear は窓外でも前後に記録があれば補間して natureOfEstimate: imputed を付ける", () => {
  // コペンハーゲン相当: 記録は 1101 と 1400 のみ。1200 は窓（-50/+25）外だが
  // 前後に記録があるため対数線形補間で採用される（Issue #221）。
  const rows = [row("Copenhagen", 12.57, 55.68, { 1101: 12000, 1400: 30000 })];
  const markers = selectCitiesForYear(rows, 1200);
  assertEquals(markers, [
    {
      name: "Copenhagen",
      lon: 12.57,
      lat: 55.68,
      population: 16253,
      natureOfEstimate: "imputed",
    },
  ]);
});

Deno.test("selectCitiesForYear は記録由来のマーカーに natureOfEstimate を付けない", () => {
  const rows = [row("Copenhagen", 12.57, 55.68, { 1101: 12000, 1400: 30000 })];
  // 1101 の実測記録は 1100 年の窓（未来 +25 年）内 → 補間ではなく記録採用
  const markers = selectCitiesForYear(rows, 1100);
  assertEquals(markers, [
    { name: "Copenhagen", lon: 12.57, lat: 55.68, population: 12000 },
  ]);
});

Deno.test("selectCitiesForYear は片側にしか記録が無い都市を補間しない（外挿禁止）", () => {
  // ベルリン相当: 最古の記録が 1600 → 1500 年は外挿になるため採用しない
  const rows = [row("Berlin", 13.4, 52.52, { 1600: 14000, 1700: 26000 })];
  assertEquals(selectCitiesForYear(rows, 1500), []);
});

Deno.test("selectCitiesForYear の同名統合は勝った側の natureOfEstimate を維持する", () => {
  // 補間値の側が人口最大で勝つケース: フラグが維持される
  const rows = [
    row("Brest", -4.49, 48.39, { 1100: 40000, 1300: 40000 }), // 1200 は補間
    row("Brest", 23.7, 52.1, { 1200: 10000 }), // 実測だが人口で負ける
  ];
  const markers = selectCitiesForYear(rows, 1200);
  assertEquals(markers.length, 1);
  assertEquals(markers[0].population, 40000);
  assertEquals(markers[0].natureOfEstimate, "imputed");
  // 実測の側が勝つケース: フラグは付かない
  const rows2 = [
    row("Brest", -4.49, 48.39, { 1100: 8000, 1300: 8000 }), // 1200 は補間
    row("Brest", 23.7, 52.1, { 1200: 10000 }), // 実測が人口で勝つ
  ];
  const markers2 = selectCitiesForYear(rows2, 1200);
  assertEquals(markers2.length, 1);
  assertEquals(markers2[0].population, 10000);
  assertEquals(markers2[0].natureOfEstimate, undefined);
});

Deno.test("selectCitiesForYear は同名都市（Brest 仏/白露等）を人口最大の 1 件に統合する", () => {
  const rows = [
    row("Brest", -4.49, 48.39, { 1800: 30000 }),
    row("Brest", 23.7, 52.1, { 1800: 10000 }),
  ];
  const markers = selectCitiesForYear(rows, 1800);
  assertEquals(markers.length, 1);
  assertEquals(markers[0].lon, -4.49);
  assertEquals(markers[0].population, 30000);
});

// ---------------------------------------------------------------------------
// buildCitiesData / validateCitiesData
// ---------------------------------------------------------------------------

Deno.test("buildCitiesData は SNAPSHOT_YEARS 全てを年キーに持つ", () => {
  const rows = [row("Rome", 12.48, 41.89, { 1000: 40000, 1914: 500000 })];
  const data = buildCitiesData(rows, SNAPSHOT_YEARS);
  assertEquals(
    Object.keys(data.years),
    SNAPSHOT_YEARS.map((y) => String(y)),
  );
  assert(typeof data.source.description === "string");
  assert(typeof data.source.license === "string");
});

function validData(): CitiesData {
  // 16 件 = MIN_CITIES_PER_YEAR + 1。内部ギャップ検査のテストが 1 件除去しても
  // 件数下限違反と混ざらないよう、下限より 1 件多くしておく。
  const years: CitiesData["years"] = {};
  for (const year of SNAPSHOT_YEARS) {
    years[String(year)] = Array.from({ length: 16 }, (_, i) => ({
      name: `City${String(i).padStart(2, "0")}`,
      lon: 10,
      lat: 50,
      population: 1000 * (16 - i),
    }));
  }
  return {
    years,
    source: { description: "test", license: "test" },
  };
}

Deno.test("validateCitiesData は正しいデータで空配列を返す", () => {
  assertEquals(
    validateCitiesData(validData(), SNAPSHOT_YEARS, EUROPE_BBOX),
    [],
  );
});

Deno.test("validateCitiesData は年キーの過不足を検出する", () => {
  const missing = validData();
  delete missing.years["1000"];
  assert(
    validateCitiesData(missing, SNAPSHOT_YEARS, EUROPE_BBOX).length > 0,
  );
  const extra = validData();
  extra.years["1850"] = extra.years["1800"];
  assert(validateCitiesData(extra, SNAPSHOT_YEARS, EUROPE_BBOX).length > 0);
});

Deno.test("validateCitiesData の件数契約は全件採用の実測レンジ（20〜609 件）を許容する", () => {
  // TASK-66: 契約を「人口上位 15〜25 件」から「候補全件（実測 1000 年 59 件〜
  // 1880 年 609 件）」に合わせて改定した。600 件規模の年が違反にならないこと。
  const data = validData();
  // 既存 16 件を残したまま 1880 年だけ 609 件へ増やす（丸ごと差し替えると
  // City00〜15 に人工的な内部ギャップができ、ギャップ検査と混ざるため）。
  data.years["1880"] = [
    ...data.years["1880"],
    ...Array.from({ length: 609 - data.years["1880"].length }, (_, i) => ({
      name: `X${i}`,
      lon: 10,
      lat: 50,
      population: 700000 - i,
    })),
  ];
  assertEquals(validateCitiesData(data, SNAPSHOT_YEARS, EUROPE_BBOX), []);
});

Deno.test("validateCitiesData は都市数が契約レンジ外（下限未満・上限超過）を検出する", () => {
  const tooFew = validData();
  tooFew.years["1000"] = tooFew.years["1000"].slice(
    0,
    MIN_CITIES_PER_YEAR - 1,
  );
  assert(validateCitiesData(tooFew, SNAPSHOT_YEARS, EUROPE_BBOX).length > 0);
  const tooMany = validData();
  tooMany.years["1000"] = Array.from(
    { length: MAX_CITIES_PER_YEAR + 1 },
    (_, i) => ({
      name: `X${i}`,
      lon: 10,
      lat: 50,
      population: 100,
    }),
  );
  assert(validateCitiesData(tooMany, SNAPSHOT_YEARS, EUROPE_BBOX).length > 0);
});

Deno.test("MIN/MAX_CITIES_PER_YEAR は全件採用の実測レンジ（44〜609 件）を包含する", () => {
  // 元データの薄い 1000〜1100 年（44〜59 件）が下限違反にならないこと、
  // 最多の 1880 年（609 件）が上限違反にならないこと。
  assert(MIN_CITIES_PER_YEAR <= 44, "下限が 1100 年の実測 44 件を上回っている");
  assert(
    MAX_CITIES_PER_YEAR >= 609,
    "上限が 1880 年の実測 609 件を下回っている",
  );
});

Deno.test("validateCitiesData は初出年〜最終出現年の間の欠落（内部ギャップ）を検出する", () => {
  // Issue #221（AC2）: 前後の年に出現する都市が中間年で消えていたら違反。
  const gapped = validData();
  gapped.years["1100"] = gapped.years["1100"].filter(
    (m) => m.name !== "City00",
  );
  const errors = validateCitiesData(gapped, SNAPSHOT_YEARS, EUROPE_BBOX);
  assert(
    errors.some((e) => e.includes("City00")),
    `内部ギャップが検出されていない: ${JSON.stringify(errors)}`,
  );
});

Deno.test("validateCitiesData は初出前・最終出現後の不在（ギャップでない）を違反にしない", () => {
  // 1000 年にだけ存在しない（初出が 1100）・1914 年にだけ存在しない
  // （最終出現が 1900）は内部ギャップではないので合格。
  const data = validData();
  data.years["1000"] = data.years["1000"].filter((m) => m.name !== "City00");
  data.years["1914"] = data.years["1914"].filter((m) => m.name !== "City01");
  assertEquals(validateCitiesData(data, SNAPSHOT_YEARS, EUROPE_BBOX), []);
});

Deno.test("validateCitiesData は bbox 外の座標を検出する", () => {
  const data = validData();
  data.years["1000"][0] = { ...data.years["1000"][0], lat: 30 };
  assert(validateCitiesData(data, SNAPSHOT_YEARS, EUROPE_BBOX).length > 0);
});

Deno.test("validateCitiesData は年内の name 重複を検出する", () => {
  const data = validData();
  data.years["1000"][1] = { ...data.years["1000"][1], name: "City00" };
  assert(validateCitiesData(data, SNAPSHOT_YEARS, EUROPE_BBOX).length > 0);
});

Deno.test("validateCitiesData は population が正整数でも null でもない値を検出する", () => {
  const zero = validData();
  zero.years["1000"][0] = { ...zero.years["1000"][0], population: 0 };
  assert(validateCitiesData(zero, SNAPSHOT_YEARS, EUROPE_BBOX).length > 0);
  const nullable = validData();
  nullable.years["1000"][0] = {
    ...nullable.years["1000"][0],
    population: null,
  };
  assertEquals(
    validateCitiesData(nullable, SNAPSHOT_YEARS, EUROPE_BBOX),
    [],
  );
});

// ---------------------------------------------------------------------------
// 生成物 data/cities.json の検証（static import・権限不要）
// ---------------------------------------------------------------------------

const generated = citiesJson as unknown as CitiesData;

Deno.test("data/cities.json は validateCitiesData を全て満たす", () => {
  assertEquals(validateCitiesData(generated, SNAPSHOT_YEARS, EUROPE_BBOX), []);
});

Deno.test("data/cities.json の各年は人口降順に並んでいる", () => {
  for (const [year, markers] of Object.entries(generated.years)) {
    for (let i = 1; i < markers.length; i++) {
      const prev = markers[i - 1].population;
      const curr = markers[i].population;
      if (prev === null || curr === null) continue;
      assert(prev >= curr, `${year} 年の並びが人口降順でない (index ${i})`);
    }
  }
});

Deno.test("data/cities.json は候補全件を採用している（代表年の件数がピン留めソースの実測値と一致）", () => {
  // TASK-66: ピン留めコミット（CITIES_SOURCE_COMMIT）の chandler.csv を
  // 現行ルール（bbox / 窓 / 除外 / rename / 同名統合）で集計した実測値。
  // 従来の上位 23 件選定のままだとどの年もこの件数に届かない。
  // Issue #221 の内部ギャップ補間で 1000〜1815 年は増加した（1880/1900 は +0。
  // パイプライン実測の増分: 1000:+26 1100:+61 1200:+38 1500:+71）。
  // docs/research/2026-08-01-city-coverage-and-historical-names.md §3.2 の
  // 増分（1100:+62 1500:+72 等）は EXCLUDED_CITY_NAMES / EXCLUDED_RECORDS の
  // 除外前の生データで測ったもので、除外都市（Gelibolu / Qum）と除外記録
  // （Iznik 1800）由来の補間セル分だけ一部の年で 1〜2 大きい。
  const expected: Record<string, number> = {
    "1000": 85,
    "1100": 105,
    "1200": 147,
    "1500": 228,
    "1880": 609,
  };
  for (const [year, count] of Object.entries(expected)) {
    assertEquals(
      generated.years[year].length,
      count,
      `${year} 年の件数が実測値 ${count} と異なる`,
    );
  }
});

Deno.test("data/cities.json: コペンハーゲンの歯抜け年が補間で埋まり imputed フラグを持つ（Issue #221 AC1/AC3）", () => {
  // 記録は 1101 / 1400 / 1600 のため従来は 1200〜1530 の 6 年で消えていた。
  const marker = (year: number) =>
    generated.years[String(year)].find((m) => m.name === "Copenhagen");
  for (const year of [1200, 1279, 1300, 1492, 1500, 1530]) {
    const m = marker(year);
    assert(m !== undefined, `${year} 年に Copenhagen がいない`);
    assertEquals(
      m.natureOfEstimate,
      "imputed",
      `${year} 年の Copenhagen が imputed フラグを持たない`,
    );
    assert(
      m.population !== null && m.population > 0,
      `${year} 年の Copenhagen の補間人口が不正`,
    );
  }
  // 記録年（1101 / 1400 / 1600 が窓内）由来の年にはフラグが無い
  for (const year of [1100, 1400, 1600]) {
    const m = marker(year);
    assert(m !== undefined, `${year} 年に Copenhagen がいない`);
    assertEquals(
      m.natureOfEstimate,
      undefined,
      `${year} 年の Copenhagen は実測記録由来なのに imputed フラグがある`,
    );
  }
});

Deno.test("data/cities.json: パリ 1100・プラハ 1100・ミュンヘン 1400 が補間で表示される（Issue #221 AC1）", () => {
  const cases: Array<[number, string]> = [
    [1100, "Paris"],
    [1100, "Prague"],
    [1400, "Munich"],
  ];
  for (const [year, name] of cases) {
    const m = generated.years[String(year)].find((c) => c.name === name);
    assert(m !== undefined, `${year} 年に ${name} がいない`);
    assertEquals(
      m.natureOfEstimate,
      "imputed",
      `${year} 年の ${name} が imputed フラグを持たない`,
    );
  }
});

Deno.test("data/cities.json の natureOfEstimate は imputed のみで、人口を持たない補間マーカーは無い", () => {
  for (const [year, markers] of Object.entries(generated.years)) {
    for (const m of markers) {
      if (m.natureOfEstimate === undefined) continue;
      assertEquals(
        m.natureOfEstimate,
        "imputed",
        `${year} 年の ${m.name} の natureOfEstimate が不正: ${m.natureOfEstimate}`,
      );
      assert(
        m.population !== null && m.population > 0,
        `${year} 年の ${m.name} は補間なのに人口が不正: ${m.population}`,
      );
    }
  }
});

Deno.test("data/cities.json は代表都市を含む（1000/1500: Constantinople、1500: Paris/Venice、1914: London/Berlin）", () => {
  const names = (year: number) =>
    generated.years[String(year)].map((m) => m.name);
  assert(names(1000).includes("Constantinople"));
  assert(names(1500).includes("Constantinople"));
  assert(names(1500).includes("Paris"));
  assert(names(1500).includes("Venice"));
  assert(names(1914).includes("London"));
  assert(names(1914).includes("Berlin"));
  assert(names(1914).includes("Paris"));
});

Deno.test("data/cities.json はドイツの中堅都市を含む（TASK-66 のユーザー要望の当体）", () => {
  // 従来の上位選定では 1492〜1700 年のドイツは 3〜6 件しか表示されず、
  // ハンザ・領邦都市（Lübeck/Bremen/Magdeburg/Königsberg 等）がほぼ非表示
  // だった。全件採用でこれらが含まれることを固定する。
  const names = (year: number) =>
    generated.years[String(year)].map((m) => m.name);
  for (const city of ["Lubeck", "Bremen", "Magdeburg", "Konigsberg"]) {
    assert(names(1500).includes(city), `1500 年に ${city} がいない`);
  }
  for (const city of ["Stuttgart", "Dusseldorf", "Hannover"]) {
    assert(names(1880).includes(city), `1880 年に ${city} がいない`);
  }
});

Deno.test("data/cities.json: Bruges は HRE 存在年代（1279〜1500）で採用される（TASK-61）", () => {
  for (const year of [1279, 1300, 1400, 1492, 1500]) {
    assert(
      generated.years[String(year)].some((m) => m.name === "Bruges"),
      `${year} 年に Bruges がいない`,
    );
  }
});

Deno.test("data/cities.json: 1880 年 Antwerp・1900 年 Barcelona を含む（TASK-61 の実害の回帰防止）", () => {
  assert(
    generated.years["1880"].some((m) => m.name === "Antwerp"),
    "1880 年に Antwerp がいない",
  );
  assert(
    generated.years["1900"].some((m) => m.name === "Barcelona"),
    "1900 年に Barcelona がいない",
  );
});

Deno.test("data/cities.json に除外対象・改名前の名前が現れない", () => {
  const banned = new Set([
    // 都市単位の既知異常
    "Gelibolu",
    "Ruhr",
    "Qum",
    // CITY_RENAMES の改名前の名前（出力は改名後のみ）
    "Istanbul",
    "Genova",
    "Brussel",
    "Gent",
    "Brugge",
    "Augsberg",
    "Nurnberg",
    "Louveigne",
    "Meckenbeuren",
    "Weisbaden",
    "Brunn",
    "Mulhausen",
  ]);
  for (const markers of Object.values(generated.years)) {
    for (const marker of markers) {
      assert(!banned.has(marker.name), `${marker.name} が出力に含まれている`);
    }
  }
});

Deno.test("data/cities.json の source は出典・ライセンス（CC BY 4.0）を明記する", () => {
  assert(generated.source.license.includes("CC BY 4.0"));
  assert(generated.source.description.length > 0);
});
