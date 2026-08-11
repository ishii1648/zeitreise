import { assert, assertEquals } from "@std/assert";
import {
  ALLOWED_COINCIDENT_CITY_PAIRS,
  ALLOWED_COINCIDENT_COORDINATE_PAIRS,
  buildCitiesData,
  buildCitiesSourceUrl,
  BURINGH_COORDINATE_OVERRIDES,
  BURINGH_EXCLUDED_CITY_NAMES,
  BURINGH_MATCH_MAX_KM,
  BURINGH_MIN_POPULATION,
  BURINGH_SOURCE_DOI,
  BURINGH_SOURCE_LICENSE,
  BURINGH_SOURCE_ROW_COUNT,
  BURINGH_SOURCE_SHA256,
  BURINGH_SOURCE_URL,
  type BuringhCity,
  buringhValueForYear,
  CITIES_SOURCE_COMMIT,
  CITIES_SOURCE_FILE,
  CITIES_SOURCE_REPO,
  type CitiesData,
  CITY_SOURCE_BURINGH,
  CITY_SOURCE_CHANDLER,
  type CityMarker,
  type CityRow,
  decodeBuringhCoordinate,
  decodeCityMarkersForYear,
  encodeCitiesData,
  filterCitiesToBbox,
  haversineKm,
  interpolatePopulation,
  matchChandlerToBuringh,
  MAX_CITIES_PER_YEAR,
  MIN_CITIES_PER_YEAR,
  parseBuringhTsv,
  parseChandlerCsv,
  pickNearestRecord,
  selectCitiesForYear,
  selectMergedCitiesForYear,
  validateCitiesData,
} from "./build-cities.ts";
import { SNAPSHOT_YEARS } from "../src/config.ts";
import { EUROPE_BBOX } from "./build-data.ts";
// CI の `deno test` は data/ 以外の読み取り権限なしで実行されるため、生成物は
// static import で検証する（scripts/name-ja_test.ts と同じ方式）。
import citiesJson from "../data/cities.json" with { type: "json" };

// ---------------------------------------------------------------------------
// buildCitiesSourceUrl / Buringh 取得定数
// ---------------------------------------------------------------------------

Deno.test("buildCitiesSourceUrl はピン留めコミットの raw URL を返す", () => {
  const url = buildCitiesSourceUrl();
  assertEquals(
    url,
    `https://raw.githubusercontent.com/${CITIES_SOURCE_REPO}/${CITIES_SOURCE_COMMIT}/${CITIES_SOURCE_FILE}`,
  );
});

Deno.test("Buringh の取得は DOI + ファイル ID + 内容ハッシュ + 行数で再現性を固定する（#222）", () => {
  // 上流（DANS Dataverse）はコミットの概念を持たないため、ADR-0001/0004 の
  // 「ピン留めで選定結果が勝手に変わらない」方針は内容ハッシュの検証で満たす。
  assertEquals(BURINGH_SOURCE_DOI, "10.17026/dans-xzy-u62q");
  assert(BURINGH_SOURCE_URL.includes("ssh.datastations.nl"));
  assert(/^[0-9a-f]{64}$/.test(BURINGH_SOURCE_SHA256), "SHA-256 hex でない");
  // 2,262 都市 × 19 年の完全グリッド（調査レポート §4.1 の実測）
  assertEquals(BURINGH_SOURCE_ROW_COUNT, 2262 * 19);
  assertEquals(BURINGH_SOURCE_LICENSE, "CC0-1.0");
  // 人口下限は Bairoch (1988) の元来の収録基準（5,000 人以上）と一致させる
  assertEquals(BURINGH_MIN_POPULATION, 5000);
  assertEquals(BURINGH_MATCH_MAX_KM, 15);
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

Deno.test("parseChandlerCsv は OtherName 列を別名リストとして保持する（#222 の名寄せ用）", () => {
  const rows = parseChandlerCsv(FIXTURE_CSV);
  const istanbul = rows.find((r) => r.name === "Istanbul");
  assert(istanbul !== undefined);
  assertEquals(istanbul.otherNames, ["Constantinople", "Byzantium"]);
  const rome = rows.find((r) => r.name === "Rome");
  assert(rome !== undefined);
  assertEquals(rome.otherNames, []);
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
// parseBuringhTsv（#222）
// ---------------------------------------------------------------------------

/** Buringh TSV のフィクスチャ（実データと同じ列構成・引用符・カンマ小数点） */
const BURINGH_TSV = [
  "city\tsynonymsandhistoricalnames\tISO-3166countrycode\tcountry\ttransportlocation/watercatchmentarea\tlatitudeindegrees\tlongitudeindegrees\televationinm\tyear\tinhabitantsin000-s\tsource\tnatureofestimate",
  '"Belgrade"\t"Singidunum, Belgrad, Belgrado"\t688.0\t"Serbia"\t"danube"\t"44,83"\t"20,5"\t117.0\t1000.0\t7.0\t""\t"imputed"',
  '"Belgrade"\t"Singidunum, Belgrad, Belgrado"\t688.0\t"Serbia"\t"danube"\t"44,83"\t"20,5"\t117.0\t1300.0\t20.0\t"src"\t""',
  '"Istanbul"\t"Constantinople, Byzantium, Konstantinopel"\t792.0\t"Turkey"\t"sea"\t"41,02"\t"28,95"\t20.0\t1000.0\t235.0\t""\t"imputed"',
  '"Aachen"\t"Aix-la-Chapelle, Aken"\t276.0\t"Germany"\t"land"\t"50,78"\t"6,08"\t176.0\t1000.0\t2.0\t""\t"proxied"',
  // 人口 0 の年は「記録なし」として落とす（下限判定以前にデータが無い扱い）
  '"Aachen"\t"Aix-la-Chapelle, Aken"\t276.0\t"Germany"\t"land"\t"50,78"\t"6,08"\t176.0\t1100.0\t0.0\t""\t""',
  // 人口空欄（Pest の 1900 年以降など）も「記録なし」
  '"Aachen"\t"Aix-la-Chapelle, Aken"\t276.0\t"Germany"\t"land"\t"50,78"\t"6,08"\t176.0\t1200.0\t\t""\t""',
].join("\n");

Deno.test("parseBuringhTsv は都市・別名・座標（カンマ小数点）・千人単位の人口を読む", () => {
  const cities = parseBuringhTsv(BURINGH_TSV);
  const belgrade = cities.find((c) => c.name === "Belgrade");
  assert(belgrade !== undefined);
  assertEquals(belgrade.lat, 44.83);
  assertEquals(belgrade.lon, 20.5);
  assertEquals(belgrade.synonyms, ["Singidunum", "Belgrad", "Belgrado"]);
  // 人口は千人単位 → 実数へ換算。natureofestimate は "" → null（実推定）
  assertEquals(belgrade.records[1000], { population: 7000, nature: "imputed" });
  assertEquals(belgrade.records[1300], { population: 20000, nature: null });
});

Deno.test("parseBuringhTsv は natureofestimate の proxied を保持し、人口 0・空欄の年を落とす", () => {
  const cities = parseBuringhTsv(BURINGH_TSV);
  const aachen = cities.find((c) => c.name === "Aachen");
  assert(aachen !== undefined);
  assertEquals(aachen.records[1000], { population: 2000, nature: "proxied" });
  assertEquals(1100 in aachen.records, false);
  assertEquals(1200 in aachen.records, false);
});

Deno.test("parseBuringhTsv は既知の壊れた都市名（別名の混入・注記・文字化け）を正規化する", () => {
  // 実データに 4 件だけある異常名（BURINGH_CITY_RENAMES の doc コメント参照）
  const tsv = [
    BURINGH_TSV.split("\n")[0],
    '"Warszawa, Warsaw, Worszewa, Werszewa"\t""\t616.0\t"Poland"\t"vistula"\t"52,25"\t"21"\t100.0\t1500.0\t10.0\t""\t""',
    '"Pest (for >1900 see Buda)"\t""\t348.0\t"Hungary"\t"danube"\t"47,5"\t"19,08"\t100.0\t1500.0\t10.0\t""\t""',
  ].join("\n");
  const names = parseBuringhTsv(tsv).map((c) => c.name);
  assert(names.includes("Warsaw"), `Warsaw が正規化されていない: ${names}`);
  assert(names.includes("Pest"), `Pest が正規化されていない: ${names}`);
});

Deno.test("parseBuringhTsv は小数点が消えた座標を国別レンジで復元する（実データの既知の壊れ方）", () => {
  // 実データの Sheffield は lat "53383" / lon "-1467"（小数点消失）。同国の
  // 正常行から作った座標レンジで一意に復元できる（53.383 / -1.467。
  // -14.67 は UK のレンジ外なので選ばれない）。
  const tsv = [
    BURINGH_TSV.split("\n")[0],
    '"London"\t""\t826.0\t"UK"\t"thames"\t"51,5"\t"-0,12"\t10.0\t1500.0\t50.0\t""\t""',
    '"Liverpool"\t""\t826.0\t"UK"\t"mersey"\t"53,4"\t"-3"\t10.0\t1500.0\t5.0\t""\t""',
    '"Plymouth"\t""\t826.0\t"UK"\t"sea"\t"50,37"\t"-4,14"\t10.0\t1500.0\t5.0\t""\t""',
    '"Sheffield"\t""\t826.0\t"UK"\t"don"\t53383\t-1467\t50.0\t1500.0\t5.0\t""\t""',
  ].join("\n");
  const sheffield = parseBuringhTsv(tsv).find((c) => c.name === "Sheffield");
  assert(sheffield !== undefined, "Sheffield が座標復元できず落ちた");
  assertEquals(sheffield.lat, 53.383);
  assertEquals(sheffield.lon, -1.467);
});

Deno.test("parseBuringhTsv は Frankfurt 複製行の都市（BURINGH_EXCLUDED_CITY_NAMES）を除外する（#269 AC1）", () => {
  // 実データの Frankenthal は全 19 年の座標が Frankfurt am Main と同一
  // （50,1 / 8,67）で、1500 年以降の人口も Frankfurt の完全な複製。
  // 正値が上流に無いため都市ごと除外する（BURINGH_EXCLUDED_CITY_NAMES の
  // doc コメント参照）。
  const tsv = [
    BURINGH_TSV.split("\n")[0],
    '"Frankenthal"\t"Frankenthal (Pfalz), Franconodal"\t276.0\t"Germany"\t"river north sea"\t"50,1"\t"8,67"\t96.0\t1900.0\t289.0\t"Wikipedia"\t""',
    '"Frankfurt am Main"\t"Franconofurd,"\t276.0\t"Germany"\t"river north sea"\t"50,1"\t"8,67"\t119.0\t1900.0\t289.0\t"Wikipedia"\t""',
  ].join("\n");
  const names = parseBuringhTsv(tsv).map((c) => c.name);
  assert(BURINGH_EXCLUDED_CITY_NAMES.has("Frankenthal"));
  assert(
    !names.includes("Frankenthal"),
    `Frankenthal（Frankfurt 複製）が除外されていない: ${names}`,
  );
  assert(names.includes("Frankfurt am Main"), "本物の Frankfurt まで消えた");
});

Deno.test("parseBuringhTsv は既知の座標誤り（BURINGH_COORDINATE_OVERRIDES）を上書きする（#269 AC2）", () => {
  // 実データの Riga の経度は "21,1"（リエパーヤ付近）。表記としては正常に
  // 読めてしまう値の誤りなので、decodeBuringhCoordinate ではなく個別の
  // 上書きリストで是正する（実際のリガは約 24.1E）。
  const tsv = [
    BURINGH_TSV.split("\n")[0],
    '"Riga"\t"Duna Urbs,"\t428.0\t"Latvia"\t"baltic + river"\t"56,95"\t"21,1"\t7.0\t1900.0\t283.0\t""\t""',
    // 同名でも country が違えば上書きしない（同名別都市の取り違え防止）
    '"Riga"\t""\t380.0\t"Italy"\t"sea"\t"38,1"\t"15,5"\t7.0\t1900.0\t6.0\t""\t""',
  ].join("\n");
  assert(
    BURINGH_COORDINATE_OVERRIDES.some(
      (o) => o.name === "Riga" && o.country === "Latvia" && o.lon === 24.1,
    ),
  );
  const cities = parseBuringhTsv(tsv);
  const riga = cities.find((c) => c.country === "Latvia");
  assert(riga !== undefined);
  assertEquals(riga.lon, 24.1);
  assertEquals(riga.lat, 56.95);
  const other = cities.find((c) => c.country === "Italy");
  assert(other !== undefined);
  assertEquals(other.lon, 15.5);
});

Deno.test("parseBuringhTsv は座標だけ複製された 4 都市を実座標へ上書きする（#276 AC1）", () => {
  // 実データの 4 都市は座標セルだけが別都市の行から複製されている（人口・
  // 標高は自前の値。BURINGH_COORDINATE_OVERRIDES の doc コメント参照）。
  // フィクスチャは実データの 1900 年行そのまま（座標は複製元: Burscheid ←
  // Aachen、Caltabellotta ← Caltagirone、Oristano ← Novi、Semur ← Selestat）。
  const tsv = [
    BURINGH_TSV.split("\n")[0],
    '"Burscheid"\t""\t276.0\t"Germany"\t"land north sea"\t"50,78"\t"6,08"\t195.0\t1900.0\t8.0\t""\t"imputed"',
    '"Caltabellotta"\t"Triocala, Trecalae"\t380.0\t"Italy"\t"land mediterranean"\t"37,23"\t"14,52"\t949.0\t1900.0\t7.0\t"Wikipedia"\t""',
    '"Oristano"\t"Aristanis,"\t380.0\t"Italy"\t"med"\t"44,77"\t"8,78"\t10.0\t1900.0\t9.0\t"Wikipedia 1901 -"\t""',
    '"Semur en Auxois"\t"Semur-en-Auxois, Sinemuro"\t250.0\t"France"\t"river north sea"\t"48,27"\t"7,45"\t237.0\t1900.0\t4.0\t""\t""',
  ].join("\n");
  const cities = parseBuringhTsv(tsv);
  const coord = (name: string): [number, number] => {
    const city = cities.find((c) => c.name === name);
    assert(city !== undefined, `${name} が読めていない`);
    return [city.lon, city.lat];
  };
  assertEquals(coord("Burscheid"), [7.12, 51.1]);
  assertEquals(coord("Caltabellotta"), [13.22, 37.58]);
  assertEquals(coord("Oristano"), [8.58, 39.9]);
  assertEquals(coord("Semur en Auxois"), [4.33, 47.49]);
});

Deno.test("decodeBuringhCoordinate: カンマ小数点はそのまま読む", () => {
  assertEquals(decodeBuringhCoordinate("44,83", "lat", null), 44.83);
  assertEquals(decodeBuringhCoordinate("-0,6095", "lon", null), -0.6095);
});

Deno.test("decodeBuringhCoordinate: 2 桁以下の整数座標はそのまま読む（整数の正当値）", () => {
  assertEquals(decodeBuringhCoordinate("44", "lat", null), 44);
  assertEquals(decodeBuringhCoordinate("0", "lon", null), 0);
  assertEquals(decodeBuringhCoordinate("-3", "lon", null), -3);
});

Deno.test("decodeBuringhCoordinate: 小数点消失値は国別レンジに最も近い候補へ復元する", () => {
  // lat "513330001831055" → 51.333…（欧州の緯度レンジで一意）
  assertEquals(
    decodeBuringhCoordinate("513330001831055", "lat", null),
    51.3330001831055,
  );
  // lon "-1467" は -14.67 / -1.467 の両方が欧州レンジ内 → 国別レンジで解決
  assertEquals(
    decodeBuringhCoordinate("-1467", "lon", { min: -8, max: 2 }),
    -1.467,
  );
  // 国別レンジの外側でも、最も近い候補を採る（Sverdlovsk の lon 60.583 相当）
  assertEquals(
    decodeBuringhCoordinate("60583", "lon", { min: 31, max: 57 }),
    60.583,
  );
});

Deno.test("decodeBuringhCoordinate: 復元できない値は null（黙って誤った座標にしない）", () => {
  assertEquals(decodeBuringhCoordinate("", "lat", null), null);
  assertEquals(decodeBuringhCoordinate("abc", "lat", null), null);
  // 欧州レンジ内の候補が複数あり、国別レンジでも同距離なら決められない
  assertEquals(decodeBuringhCoordinate("-1467", "lon", null), null);
});

// ---------------------------------------------------------------------------
// buringhValueForYear（グリッド年は実値、非グリッド年は対数線形補間）
// ---------------------------------------------------------------------------

const BELGRADE_RECORDS: BuringhCity["records"] = {
  1200: { population: 14000, nature: null },
  1300: { population: 20000, nature: null },
  1800: { population: 5000, nature: null },
  1850: { population: 18000, nature: "imputed" },
};

Deno.test("buringhValueForYear はグリッド年の実値と natureofestimate をそのまま返す", () => {
  assertEquals(buringhValueForYear(BELGRADE_RECORDS, 1300), {
    population: 20000,
    nature: null,
  });
  assertEquals(buringhValueForYear(BELGRADE_RECORDS, 1850), {
    population: 18000,
    nature: "imputed",
  });
});

Deno.test("buringhValueForYear は非グリッド年を前後から対数線形補間し imputed を付ける", () => {
  // 1279 年: exp(ln(14000) + (ln(20000)−ln(14000)) × 79/100) = 18557
  assertEquals(buringhValueForYear(BELGRADE_RECORDS, 1279), {
    population: 18557,
    nature: "imputed",
  });
  // 1815 年: exp(ln(5000) + (ln(18000)−ln(5000)) × 15/50) = 7343
  assertEquals(buringhValueForYear(BELGRADE_RECORDS, 1815), {
    population: 7343,
    nature: "imputed",
  });
});

Deno.test("buringhValueForYear は片側にしか記録が無い年は null（外挿しない）", () => {
  assertEquals(buringhValueForYear(BELGRADE_RECORDS, 1100), null);
  assertEquals(buringhValueForYear(BELGRADE_RECORDS, 1900), null);
  assertEquals(buringhValueForYear({}, 1500), null);
});

// ---------------------------------------------------------------------------
// haversineKm / matchChandlerToBuringh（3 段名寄せ）
// ---------------------------------------------------------------------------

Deno.test("haversineKm は既知の都市間距離とおおむね一致する", () => {
  // パリ〜ロンドン ≒ 344 km
  const d = haversineKm(48.8566, 2.3522, 51.5074, -0.1278);
  assert(Math.abs(d - 344) < 5, `パリ〜ロンドン ${d} km`);
  assertEquals(haversineKm(50, 10, 50, 10), 0);
});

function row(
  name: string,
  lon: number,
  lat: number,
  records: Record<number, number>,
  otherNames: string[] = [],
): CityRow {
  return { name, otherNames, lon, lat, records };
}

function buringhCity(
  name: string,
  lon: number,
  lat: number,
  records: BuringhCity["records"],
  synonyms: string[] = [],
): BuringhCity {
  return { name, synonyms, country: "X", lon, lat, records };
}

const REC_1500: BuringhCity["records"] = {
  1500: { population: 50000, nature: null },
};

Deno.test("matchChandlerToBuringh: 第 1 段は正式名の一致（大文字小文字を無視）", () => {
  const chandler = [row("Paris", 2.35, 48.85, { 1500: 100000 })];
  const buringh = [buringhCity("paris", 2.35, 48.85, REC_1500)];
  const result = matchChandlerToBuringh(chandler, buringh);
  assertEquals(result.stats, {
    byName: 1,
    bySynonym: 0,
    byCoordinate: 0,
    unmatched: 0,
  });
  assertEquals(result.matchedNames.get(0), "Paris");
  assertEquals(result.unmatchedRows, []);
});

Deno.test("matchChandlerToBuringh: CITY_RENAMES 適用後の名前でも一致する（Istanbul→Constantinople 等）", () => {
  // Chandler の Istanbul は出力名 Constantinople。Buringh 側は Istanbul 名で
  // 収録されているため、正規化前の名前でも照合する。
  const chandler = [row("Istanbul", 28.96, 41.01, { 1500: 200000 })];
  const buringh = [
    buringhCity("Istanbul", 28.95, 41.02, REC_1500, [
      "Constantinople",
      "Byzantium",
    ]),
  ];
  const result = matchChandlerToBuringh(chandler, buringh);
  assertEquals(result.stats.byName, 1);
  // 表示名は既存の英語慣用名（Constantinople）を維持する
  assertEquals(result.matchedNames.get(0), "Constantinople");
});

Deno.test("matchChandlerToBuringh: 第 2 段は別名列（synonymsandhistoricalnames / OtherName）の一致", () => {
  const chandler = [
    row("Abo", 22.28, 60.45, { 1500: 7000 }, ["Turku"]),
    row("Ghent", 3.72, 51.05, { 1500: 40000 }),
  ];
  const buringh = [
    buringhCity("Turku", 22.28, 60.45, REC_1500, ["Åbo"]),
    buringhCity("Gent", 3.72, 51.05, REC_1500, ["Ghent", "Gand"]),
  ];
  const result = matchChandlerToBuringh(chandler, buringh);
  // Abo は OtherName "Turku" が Buringh 正式名と一致、Ghent は Buringh の
  // 別名列と一致。どちらも「別名列を介した一致」として第 2 段に数える。
  assertEquals(result.stats, {
    byName: 0,
    bySynonym: 2,
    byCoordinate: 0,
    unmatched: 0,
  });
  assertEquals(result.matchedNames.get(0), "Abo");
  assertEquals(result.matchedNames.get(1), "Ghent");
});

Deno.test("matchChandlerToBuringh: 第 3 段は座標 15km 以内の最近傍", () => {
  const chandler = [row("Munich", 11.58, 48.14, { 1500: 13000 })];
  const buringh = [
    // 約 1 km（一致すべき）と約 40 km（Augsburg 相当。一致してはいけない）
    buringhCity("Muenchen", 11.57, 48.13, REC_1500),
    buringhCity("Augsburg", 10.9, 48.37, REC_1500),
  ];
  const result = matchChandlerToBuringh(chandler, buringh);
  assertEquals(result.stats.byCoordinate, 1);
  assertEquals(result.matchedNames.get(0), "Munich");
  assertEquals(result.matchedNames.has(1), false);
});

Deno.test("matchChandlerToBuringh: 同じ Buringh 都市への複数一致は確度の高い段の名前が勝つ", () => {
  // 実データの例: Chandler の Bobastro（座標が Malaga とほぼ同一の誤り）が
  // 先に座標一致しても、正式名一致の Malaga が表示名になる。
  const chandler = [
    row("Bobastro", -4.42, 36.72, { 900: 20000 }),
    row("Malaga", -4.42, 36.72, { 1500: 20000 }),
  ];
  const buringh = [
    buringhCity("Malaga", -4.42, 36.72, REC_1500),
  ];
  const result = matchChandlerToBuringh(chandler, buringh);
  assertEquals(result.matchedNames.get(0), "Malaga");
  // どちらの行も一致扱い（補完対象には残らない）
  assertEquals(result.unmatchedRows, []);
});

Deno.test("matchChandlerToBuringh: 既知異常行（EXCLUDED_CITY_NAMES）は名寄せに使わない", () => {
  // Chandler の Ruhr（工業地帯の集計値）はルール地方の Buringh 都市と座標
  // 一致してしまう。異常行の名前が正常な Buringh 都市の表示名にならないこと。
  const chandler = [row("Ruhr", 7.2, 51.5, { 1900: 700000 })];
  const buringh = [
    buringhCity("Essen", 7.01, 51.45, {
      1900: { population: 119000, nature: null },
    }),
  ];
  const result = matchChandlerToBuringh(chandler, buringh);
  assertEquals(result.matchedNames.size, 0);
  assertEquals(result.unmatchedRows, []);
  assertEquals(result.stats, {
    byName: 0,
    bySynonym: 0,
    byCoordinate: 0,
    unmatched: 0,
  });
});

Deno.test("matchChandlerToBuringh: どの段でも一致しない都市は補完対象（unmatchedRows）に残る", () => {
  const chandler = [
    row("Nishapur", 58.8, 36.21, { 1000: 125000 }),
    row("Paris", 2.35, 48.85, { 1500: 100000 }),
  ];
  const buringh = [buringhCity("Paris", 2.35, 48.85, REC_1500)];
  const result = matchChandlerToBuringh(chandler, buringh);
  assertEquals(result.stats.unmatched, 1);
  assertEquals(result.unmatchedRows.map((r) => r.name), ["Nishapur"]);
});

// ---------------------------------------------------------------------------
// selectCitiesForYear（Chandler 補完側の選定。従来ロジックを維持）
// ---------------------------------------------------------------------------

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
// selectMergedCitiesForYear（Buringh 主 + Chandler 補完の併合。#222）
// ---------------------------------------------------------------------------

Deno.test("selectMergedCitiesForYear は Buringh 主（下限 5,000 適用）+ Chandler 補完を併合する", () => {
  const buringh = [
    buringhCity("Paris", 2.35, 48.85, {
      1500: { population: 100000, nature: null },
    }),
    // 下限未満 → その年は出さない（史実性の調整弁。ベルリン 1000〜1300 相当）
    buringhCity("Berlin", 13.4, 52.52, {
      1500: { population: 4000, nature: "imputed" },
    }),
  ];
  const chandlerOnly = [row("Nishapur", 58.8, 36.21, { 1500: 30000 })];
  const markers = selectMergedCitiesForYear(
    buringh,
    new Map(),
    chandlerOnly,
    1500,
  );
  assertEquals(markers.map((m) => [m.name, m.source]), [
    ["Paris", CITY_SOURCE_BURINGH],
    ["Nishapur", CITY_SOURCE_CHANDLER],
  ]);
});

Deno.test("selectMergedCitiesForYear は名寄せ済みの表示名（matchedNames）を Buringh 側に適用する", () => {
  const buringh = [
    buringhCity("Istanbul", 28.95, 41.02, {
      1500: { population: 200000, nature: null },
    }),
  ];
  const markers = selectMergedCitiesForYear(
    buringh,
    new Map([[0, "Constantinople"]]),
    [],
    1500,
  );
  assertEquals(markers.map((m) => m.name), ["Constantinople"]);
});

Deno.test("selectMergedCitiesForYear は非グリッド年を補間し natureOfEstimate: imputed を付ける", () => {
  const buringh = [
    buringhCity("Belgrade", 20.5, 44.83, {
      1200: { population: 14000, nature: null },
      1300: { population: 20000, nature: null },
    }),
  ];
  const markers = selectMergedCitiesForYear(buringh, new Map(), [], 1279);
  assertEquals(markers, [
    {
      name: "Belgrade",
      lon: 20.5,
      lat: 44.83,
      population: 18557,
      natureOfEstimate: "imputed",
      source: CITY_SOURCE_BURINGH,
    },
  ]);
});

Deno.test("selectMergedCitiesForYear はグリッド年の natureofestimate（proxied 含む）を伝搬する", () => {
  const buringh = [
    buringhCity("A", 10, 50, { 1500: { population: 8000, nature: "proxied" } }),
    buringhCity("B", 11, 51, { 1500: { population: 9000, nature: "imputed" } }),
    buringhCity("C", 12, 52, { 1500: { population: 10000, nature: null } }),
  ];
  const markers = selectMergedCitiesForYear(buringh, new Map(), [], 1500);
  assertEquals(
    markers.map((m) => [m.name, m.natureOfEstimate]),
    [["C", undefined], ["B", "imputed"], ["A", "proxied"]],
  );
});

Deno.test("selectMergedCitiesForYear の同名重複は人口最大 1 件へ統合し、同数なら Buringh 側が勝つ", () => {
  const buringh = [
    buringhCity("Brest", -4.49, 48.39, {
      1500: { population: 10000, nature: null },
    }),
  ];
  const chandlerOnly = [
    row("Brest", 23.7, 52.1, { 1500: 10000 }), // 同数 → Buringh 優先
    row("Dvin", 44.58, 40.01, { 1500: 20000 }),
  ];
  const markers = selectMergedCitiesForYear(
    buringh,
    new Map(),
    chandlerOnly,
    1500,
  );
  assertEquals(markers.length, 2);
  const brest = markers.find((m) => m.name === "Brest");
  assert(brest !== undefined);
  assertEquals(brest.source, CITY_SOURCE_BURINGH);
  assertEquals(brest.lon, -4.49);
});

Deno.test("selectMergedCitiesForYear は Buringh 側の別名残り（CITY_RENAMES 対象名）も慣用名へ正規化する", () => {
  // 名寄せ漏れで Buringh の綴りが素通りしても、出力の語彙（改名前の名前を
  // 出さない契約）を破らない
  const buringh = [
    buringhCity("Gent", 3.72, 51.05, {
      1500: { population: 40000, nature: null },
    }),
  ];
  const markers = selectMergedCitiesForYear(buringh, new Map(), [], 1500);
  assertEquals(markers.map((m) => m.name), ["Ghent"]);
});

// ---------------------------------------------------------------------------
// encodeCitiesData / decodeCityMarkersForYear（正規化形式。#222）
// ---------------------------------------------------------------------------

function marker(
  name: string,
  population: number,
  source: 0 | 1 = 0,
  natureOfEstimate?: "imputed" | "proxied",
  lon = 10,
  lat = 50,
): CityMarker {
  const m: CityMarker = { name, lon, lat, population, source };
  if (natureOfEstimate !== undefined) m.natureOfEstimate = natureOfEstimate;
  return m;
}

const SAMPLE_SOURCES: CitiesData["sources"] = [
  { source: "Buringh", sourceUrl: "u0", license: "CC0-1.0" },
  { source: "Chandler", sourceUrl: "u1", license: "CC BY 4.0" },
];

Deno.test("encodeCitiesData は都市を一度だけ並べ、年別は [index, population(, nature)] で持つ", () => {
  const byYear = {
    "1000": [marker("Paris", 20000), marker("Nishapur", 125000, 1)],
    "1100": [marker("Paris", 30000, 0, "imputed")],
  };
  const data = encodeCitiesData(byYear, SAMPLE_SOURCES);
  assertEquals(data.cities.length, 2);
  assertEquals(data.cities[0], { name: "Paris", lon: 10, lat: 50, source: 0 });
  assertEquals(data.cities[1], {
    name: "Nishapur",
    lon: 10,
    lat: 50,
    source: 1,
  });
  assertEquals(data.years["1000"], [[0, 20000], [1, 125000]]);
  assertEquals(data.years["1100"], [[0, 30000, "imputed"]]);
  assertEquals(data.sources, SAMPLE_SOURCES);
});

Deno.test("encodeCitiesData: 同名でも座標かソースが違えば別都市として持つ（Brest 仏/白露）", () => {
  const byYear = {
    "1000": [marker("Brest", 20000, 0, undefined, -4.49, 48.39)],
    "1100": [marker("Brest", 10000, 1, undefined, 23.7, 52.1)],
  };
  const data = encodeCitiesData(byYear, SAMPLE_SOURCES);
  assertEquals(data.cities.length, 2);
});

Deno.test("decodeCityMarkersForYear は encodeCitiesData の逆変換になる（往復で不変）", () => {
  const byYear = {
    "1000": [
      marker("Paris", 20000),
      marker("Nishapur", 125000, 1),
      marker("Aachen", 8000, 0, "proxied"),
    ],
    "1100": [marker("Paris", 30000, 0, "imputed")],
  };
  const data = encodeCitiesData(byYear, SAMPLE_SOURCES);
  assertEquals(decodeCityMarkersForYear(data, 1000), byYear["1000"]);
  assertEquals(decodeCityMarkersForYear(data, 1100), byYear["1100"]);
  assertEquals(decodeCityMarkersForYear(data, 1200), []);
});

// ---------------------------------------------------------------------------
// buildCitiesData / validateCitiesData
// ---------------------------------------------------------------------------

Deno.test("buildCitiesData は SNAPSHOT_YEARS 全てを年キーに持ち、両ソースの出典を刻む", () => {
  const chandler = [row("Nishapur", 58.8, 36.21, { 1000: 40000, 1914: 50000 })];
  const buringh = [
    buringhCity("Paris", 2.35, 48.85, {
      1000: { population: 20000, nature: null },
      1900: { population: 2700000, nature: null },
      1950: { population: 2800000, nature: null },
    }),
  ];
  const data = buildCitiesData(chandler, buringh, SNAPSHOT_YEARS);
  assertEquals(
    Object.keys(data.years),
    SNAPSHOT_YEARS.map((y) => String(y)),
  );
  assertEquals(data.sources.length, 2);
  assertEquals(data.sources[0].license, BURINGH_SOURCE_LICENSE);
  assert(String(data.sources[0].sourceUrl).includes(BURINGH_SOURCE_DOI));
  assertEquals(data.sources[1].license, "CC BY 4.0");
  assertEquals(data.sources[1].commit, CITIES_SOURCE_COMMIT);
});

function validData(): CitiesData {
  // 各年 MIN_CITIES_PER_YEAR + 1 件。内部ギャップ検査のテストが 1 件除去しても
  // 件数下限違反と混ざらないよう、下限より 1 件多くしておく。
  // 座標は都市ごとに変える（#276 の同一座標の別都市ペア検出に掛からないよう、
  // 「正しいデータ」の前提として座標一意を満たす）。
  const byYear: Record<string, CityMarker[]> = {};
  for (const year of SNAPSHOT_YEARS) {
    byYear[String(year)] = Array.from(
      { length: MIN_CITIES_PER_YEAR + 1 },
      (_, i) =>
        marker(
          `City${String(i).padStart(4, "0")}`,
          1000 * (MIN_CITIES_PER_YEAR + 1 - i),
          i % 2 === 0 ? 0 : 1,
          undefined,
          10 + i * 0.01,
        ),
    );
  }
  return encodeCitiesData(byYear, SAMPLE_SOURCES);
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
    (_, i) => [i % tooMany.cities.length, 100 + i] as [number, number],
  );
  assert(validateCitiesData(tooMany, SNAPSHOT_YEARS, EUROPE_BBOX).length > 0);
});

Deno.test("MIN/MAX_CITIES_PER_YEAR は併合後の実測レンジを包含する（#222）", () => {
  // Buringh 併合後の最少は 1000 年（Buringh 121 件 + Chandler 補完）、最多は
  // 1914 年（Buringh 2,105 件 + Chandler 補完）。
  assert(MIN_CITIES_PER_YEAR <= 121, "下限が 1000 年の実測を上回っている");
  assert(MAX_CITIES_PER_YEAR >= 2200, "上限が 1914 年の実測を下回っている");
});

Deno.test("validateCitiesData は Chandler 補完都市の内部ギャップ（初出〜最終年の間の欠落）を検出する", () => {
  // Issue #221（AC2）: 前後の年に出現する都市が中間年で消えていたら違反。
  // Buringh 側（source 0）は人口下限 5,000 の年別適用が意図的に年を欠けさせる
  // ため対象外（下限未満の年は表示しないという #222 の仕様）。
  const gapped = validData();
  const target = gapped.cities.findIndex((c) => c.source === 1);
  gapped.years["1100"] = gapped.years["1100"].filter(
    (cell) => cell[0] !== target,
  );
  const errors = validateCitiesData(gapped, SNAPSHOT_YEARS, EUROPE_BBOX);
  assert(
    errors.some((e) => e.includes(gapped.cities[target].name)),
    `内部ギャップが検出されていない: ${JSON.stringify(errors)}`,
  );
});

Deno.test("validateCitiesData は Buringh 側（source 0）の年別下限による欠落を違反にしない", () => {
  // ベオグラード 1783 年（6 千人）のように下限すれすれの都市は年により
  // 出たり消えたりしうる。これは仕様（人口下限の年別適用）なので合格。
  const data = validData();
  const target = data.cities.findIndex((c) => c.source === 0);
  data.years["1100"] = data.years["1100"].filter(
    (cell) => cell[0] !== target,
  );
  assertEquals(validateCitiesData(data, SNAPSHOT_YEARS, EUROPE_BBOX), []);
});

Deno.test("validateCitiesData は初出前・最終出現後の不在（ギャップでない）を違反にしない", () => {
  const data = validData();
  const target = data.cities.findIndex((c) => c.source === 1);
  data.years["1000"] = data.years["1000"].filter((c) => c[0] !== target);
  data.years["1914"] = data.years["1914"].filter((c) => c[0] !== target);
  assertEquals(validateCitiesData(data, SNAPSHOT_YEARS, EUROPE_BBOX), []);
});

Deno.test("validateCitiesData は bbox 外の座標を検出する", () => {
  const data = validData();
  data.cities[0] = { ...data.cities[0], lat: 30 };
  assert(validateCitiesData(data, SNAPSHOT_YEARS, EUROPE_BBOX).length > 0);
});

Deno.test("validateCitiesData は年内の重複（同一都市 index・同名）を検出する", () => {
  const dupIndex = validData();
  dupIndex.years["1000"] = [
    ...dupIndex.years["1000"],
    dupIndex.years["1000"][0],
  ];
  assert(validateCitiesData(dupIndex, SNAPSHOT_YEARS, EUROPE_BBOX).length > 0);
  const dupName = validData();
  dupName.cities[1] = { ...dupName.cities[1], name: dupName.cities[0].name };
  assert(validateCitiesData(dupName, SNAPSHOT_YEARS, EUROPE_BBOX).length > 0);
});

/**
 * validData の 1000 年の先頭 2 都市を「同一座標・同一人口」の Frankenthal 型
 * 複製ペアにする（#269/#276 の検出テスト用）。ペア名（辞書順連結）を返す。
 */
function makeCoincidentPair(dup: CitiesData): string {
  const [firstCell, secondCell] = dup.years["1000"];
  dup.cities[secondCell[0]] = {
    ...dup.cities[secondCell[0]],
    lon: dup.cities[firstCell[0]].lon,
    lat: dup.cities[firstCell[0]].lat,
  };
  dup.years["1000"] = [
    firstCell,
    [secondCell[0], firstCell[1]],
    ...dup.years["1000"].slice(2),
  ];
  return [
    dup.cities[firstCell[0]].name,
    dup.cities[secondCell[0]].name,
  ].sort().join("|");
}

Deno.test("validateCitiesData は年内の同一座標・同一人口の重複ペアを検出する（#269 AC3）", () => {
  // 座標と人口の両方が一致すると Frankenthal 型の複製（上流 Buringh の
  // 隣接行コピー）の兆候として違反になる。
  const dup = validData();
  makeCoincidentPair(dup);
  const errors = validateCitiesData(dup, SNAPSHOT_YEARS, EUROPE_BBOX);
  assert(
    errors.some((e) => e.includes("同一座標・同一人口")),
    `重複ペアが検出されていない: ${JSON.stringify(errors)}`,
  );
});

Deno.test("validateCitiesData は許容リストにあるペアの同一座標・同一人口を違反にしない（#269 AC3）", () => {
  const dup = validData();
  const pair = makeCoincidentPair(dup);
  // 座標一致の検出（#276）にも掛かるため、両方の許容リストへ入れて合格を見る
  assertEquals(
    validateCitiesData(
      dup,
      SNAPSHOT_YEARS,
      EUROPE_BBOX,
      new Set([pair]),
      new Set([pair]),
    ),
    [],
  );
  // 既定の許容リストは空（既知の複製 Frankenthal は都市ごと除外済みで、
  // 許容が必要なペアは現データに存在しない）
  assertEquals(ALLOWED_COINCIDENT_CITY_PAIRS.size, 0);
});

Deno.test("validateCitiesData は別都市どうしの座標完全一致（人口不一致）を検出する（#276 AC2）", () => {
  // Burscheid ← Aachen 型（上流 Buringh の座標セルだけの複製）は人口が
  // 自前の値のため #269 の同一座標・同一人口検出に掛からない。座標の完全
  // 一致そのものを cities 配列で検出する。
  const dup = validData();
  const [firstCell, secondCell] = dup.years["1000"];
  dup.cities[secondCell[0]] = {
    ...dup.cities[secondCell[0]],
    lon: dup.cities[firstCell[0]].lon,
    lat: dup.cities[firstCell[0]].lat,
  };
  const errors = validateCitiesData(dup, SNAPSHOT_YEARS, EUROPE_BBOX);
  assert(
    errors.some((e) => e.includes("同一座標の別都市ペア")),
    `座標複製ペアが検出されていない: ${JSON.stringify(errors)}`,
  );
});

Deno.test("validateCitiesData は許容リストにある別都市ペアの座標一致を違反にしない（#276 AC2）", () => {
  const dup = validData();
  const [firstCell, secondCell] = dup.years["1000"];
  dup.cities[secondCell[0]] = {
    ...dup.cities[secondCell[0]],
    lon: dup.cities[firstCell[0]].lon,
    lat: dup.cities[firstCell[0]].lat,
  };
  const pair = [
    dup.cities[firstCell[0]].name,
    dup.cities[secondCell[0]].name,
  ].sort().join("|");
  assertEquals(
    validateCitiesData(
      dup,
      SNAPSHOT_YEARS,
      EUROPE_BBOX,
      ALLOWED_COINCIDENT_CITY_PAIRS,
      new Set([pair]),
    ),
    [],
  );
  // 既定の許容リストは空（既知の座標複製 4 都市は BURINGH_COORDINATE_OVERRIDES
  // で実座標へ是正済みで、許容が必要なペアは現データに存在しない）
  assertEquals(ALLOWED_COINCIDENT_COORDINATE_PAIRS.size, 0);
});

Deno.test("validateCitiesData は存在しない都市 index・不正 population を検出する", () => {
  const badIndex = validData();
  badIndex.years["1000"] = [
    ...badIndex.years["1000"].slice(1),
    [badIndex.cities.length, 1000] as [number, number],
  ];
  assert(validateCitiesData(badIndex, SNAPSHOT_YEARS, EUROPE_BBOX).length > 0);
  const zeroPop = validData();
  zeroPop.years["1000"] = [
    [zeroPop.years["1000"][0][0], 0] as [number, number],
    ...zeroPop.years["1000"].slice(1),
  ];
  assert(validateCitiesData(zeroPop, SNAPSHOT_YEARS, EUROPE_BBOX).length > 0);
});

Deno.test("validateCitiesData はどの年からも参照されない都市を検出する", () => {
  const orphan = validData();
  orphan.cities = [
    ...orphan.cities,
    { name: "Orphan", lon: 10, lat: 50, source: 0 },
  ];
  assert(validateCitiesData(orphan, SNAPSHOT_YEARS, EUROPE_BBOX).length > 0);
});

// ---------------------------------------------------------------------------
// 生成物 data/cities.json の検証（static import・権限不要）
// ---------------------------------------------------------------------------

const generated = citiesJson as unknown as CitiesData;

function generatedYear(year: number): CityMarker[] {
  return decodeCityMarkersForYear(generated, year);
}

Deno.test("data/cities.json は validateCitiesData を全て満たす", () => {
  assertEquals(validateCitiesData(generated, SNAPSHOT_YEARS, EUROPE_BBOX), []);
});

Deno.test("data/cities.json の各年は人口降順に並んでいる", () => {
  for (const year of SNAPSHOT_YEARS) {
    const markers = generatedYear(year);
    for (let i = 1; i < markers.length; i++) {
      assert(
        markers[i - 1].population >= markers[i].population,
        `${year} 年の並びが人口降順でない (index ${i})`,
      );
    }
  }
});

Deno.test("data/cities.json: ベオグラードが 1000〜1914 年の全スナップショット年に存在する（#222 AC1）", () => {
  for (const year of SNAPSHOT_YEARS) {
    const m = generatedYear(year).find((c) => c.name === "Belgrade");
    assert(m !== undefined, `${year} 年に Belgrade がいない`);
    assertEquals(m.source, CITY_SOURCE_BURINGH);
  }
  // グリッド年（1000）は Buringh の実値そのまま（7 千人・imputed）
  const y1000 = generatedYear(1000).find((c) => c.name === "Belgrade");
  assertEquals(y1000?.population, 7000);
  assertEquals(y1000?.natureOfEstimate, "imputed");
});

Deno.test("data/cities.json: ベルリンは人口下限適用で 1400 年から出現し 1914 年まで連続する（#222 AC2）", () => {
  // Buringh のベルリンは 1000〜1300 年が 1〜4 千人の imputed で、下限 5,000 を
  // 掛けると史実（市壁都市の成立は 1230 年代）と整合する 1400 年以降になる。
  for (const year of [1000, 1100, 1200, 1279, 1300]) {
    assert(
      generatedYear(year).every((c) => c.name !== "Berlin"),
      `${year} 年に Berlin がいる（下限が効いていない）`,
    );
  }
  for (const year of SNAPSHOT_YEARS.filter((y) => y >= 1400)) {
    const m = generatedYear(year).find((c) => c.name === "Berlin");
    assert(m !== undefined, `${year} 年に Berlin がいない`);
  }
  assertEquals(
    generatedYear(1400).find((c) => c.name === "Berlin")?.population,
    5000,
  );
});

Deno.test("data/cities.json: コンスタンティノープルは Buringh の Istanbul と名寄せされ全年で表示される（#222 AC3/AC4）", () => {
  for (const year of SNAPSHOT_YEARS) {
    const markers = generatedYear(year);
    const m = markers.find((c) => c.name === "Constantinople");
    assert(m !== undefined, `${year} 年に Constantinople がいない`);
    // 名寄せが効いていれば Istanbul 名の重複マーカーは存在しない
    assert(
      markers.every((c) => c.name !== "Istanbul"),
      `${year} 年に Istanbul が重複表示されている`,
    );
  }
});

Deno.test("data/cities.json: Buringh に無い都市（ニシャプール・カイラワーン等）は Chandler 補完で残る（#222 AC3）", () => {
  const y1000 = generatedYear(1000);
  for (const name of ["Nishapur", "Kairouan", "Rayy", "Ani"]) {
    const m = y1000.find((c) => c.name === name);
    assert(m !== undefined, `1000 年に ${name} がいない`);
    assertEquals(
      m.source,
      CITY_SOURCE_CHANDLER,
      `${name} の source が補完側でない`,
    );
  }
  // 中東の主要都市も引き続き表示される
  assert(generatedYear(1500).some((c) => c.name === "Tabriz"));
  assert(generatedYear(1500).some((c) => c.name === "Aleppo"));
});

Deno.test("data/cities.json: 年内に同名の都市が存在しない（#222 AC4）", () => {
  for (const year of SNAPSHOT_YEARS) {
    const names = generatedYear(year).map((c) => c.name);
    assertEquals(
      names.length,
      new Set(names).size,
      `${year} 年に同名重複がある`,
    );
  }
});

Deno.test("data/cities.json の年別件数が Issue #222 の期待値と整合する", () => {
  // Buringh 単独の実測（Issue の期待表: 1000:121 / 1500:506 / 1880:2065 等）に
  // Chandler 補完分が上乗せされるため、各年とも期待表以上の件数になる。
  const expectedFloor: Record<string, number> = {
    "1000": 121,
    "1100": 177,
    "1200": 271,
    "1300": 428,
    "1500": 506,
    "1600": 801,
    "1700": 919,
    "1800": 1759,
    "1880": 2065,
    "1914": 2105,
  };
  for (const [year, floor] of Object.entries(expectedFloor)) {
    const count = generatedYear(Number(year)).length;
    assert(
      count >= floor,
      `${year} 年の件数 ${count} が Buringh 単独の期待値 ${floor} を下回る`,
    );
    // 補完は最大でも Chandler 由来 100 件程度（未マッチ 79 + 座標名寄せの揺れ）
    assert(
      count <= floor + 130,
      `${year} 年の件数 ${count} が期待値 ${floor} から乖離しすぎている（名寄せの退行を疑う）`,
    );
  }
});

Deno.test("data/cities.json: Riga は正しい経度（約 24.1）で表示される（#269 AC2）", () => {
  // 上流 Buringh の Riga は経度 21,1（リエパーヤ付近）。
  // BURINGH_COORDINATE_OVERRIDES で実座標（24.1E）へ上書きされている。
  const rigas = generated.cities.filter((c) => c.name === "Riga");
  assertEquals(rigas.length, 1);
  assertEquals(rigas[0].lon, 24.1);
  assertEquals(rigas[0].lat, 56.95);
});

Deno.test("data/cities.json: 座標複製 4 都市が実座標で表示される（#276 AC1）", () => {
  // 上流 Buringh で座標セルだけが別都市の行から複製されていた 4 都市。
  // BURINGH_COORDINATE_OVERRIDES で実座標へ上書きされている（出典は同
  // オーバーライドの doc コメント）。
  const expected: Record<string, [number, number]> = {
    Burscheid: [7.12, 51.1], // ← Aachen (6.08, 50.78) の複製だった
    Caltabellotta: [13.22, 37.58], // ← Caltagirone (14.52, 37.23) の複製だった
    Oristano: [8.58, 39.9], // ← Novi (8.78, 44.77) の複製だった
    "Semur en Auxois": [4.33, 47.49], // ← Selestat (7.45, 48.27) の複製だった
  };
  for (const [name, [lon, lat]] of Object.entries(expected)) {
    const matches = generated.cities.filter((c) => c.name === name);
    assertEquals(matches.length, 1, `${name} が一意でない`);
    assertEquals([matches[0].lon, matches[0].lat], [lon, lat], name);
  }
});

Deno.test("data/cities.json: 別都市どうしの座標完全一致が存在しない（#276 AC2）", () => {
  // Burscheid ← Aachen 型（座標だけの複製）の再発検知。許容するペアは
  // ALLOWED_COINCIDENT_COORDINATE_PAIRS に明示する。
  const seen = new Map<string, string>();
  for (const city of generated.cities) {
    const key = `${city.lon} ${city.lat}`;
    const prev = seen.get(key);
    if (prev !== undefined && prev !== city.name) {
      const pair = [prev, city.name].sort().join("|");
      assert(
        ALLOWED_COINCIDENT_COORDINATE_PAIRS.has(pair),
        `同一座標の別都市ペア: ${pair}（${key}）`,
      );
    }
    seen.set(key, city.name);
  }
});

Deno.test("data/cities.json: 年内に同一座標・同一人口の重複ペアが存在しない（#269 AC3）", () => {
  // Frankenthal = Frankfurt am Main の複製（上流 Buringh の隣接行コピー）の
  // 再発検知。許容するペアは ALLOWED_COINCIDENT_CITY_PAIRS に明示する。
  for (const year of SNAPSHOT_YEARS) {
    const seen = new Map<string, string>();
    for (const m of generatedYear(year)) {
      const key = `${m.lon} ${m.lat} ${m.population}`;
      const prev = seen.get(key);
      if (prev !== undefined) {
        const pair = [prev, m.name].sort().join("|");
        assert(
          ALLOWED_COINCIDENT_CITY_PAIRS.has(pair),
          `${year} 年に同一座標・同一人口の重複ペア: ${pair}（${key}）`,
        );
      }
      seen.set(key, m.name);
    }
  }
});

Deno.test("data/cities.json に除外対象・改名前の名前が現れない", () => {
  const banned = new Set([
    // 都市単位の既知異常
    "Gelibolu",
    "Ruhr",
    "Qum",
    // Buringh 側の都市単位の既知異常（#269: Frankfurt am Main の複製行）
    "Frankenthal",
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
    // Buringh 側の既知の異常名（BURINGH_CITY_RENAMES の改名前）
    "Pest (for >1900 see Buda)",
    "Warszawa, Warsaw, Worszewa, Werszewa",
  ]);
  for (const city of generated.cities) {
    assert(!banned.has(city.name), `${city.name} が出力に含まれている`);
  }
});

Deno.test("data/cities.json の sources は Buringh（CC0-1.0）と Reba/Chandler（CC BY 4.0）を明記する（#222 AC6）", () => {
  assertEquals(generated.sources.length, 2);
  const [buringh, chandler] = generated.sources;
  assertEquals(buringh.license, "CC0-1.0");
  assert(String(buringh.sourceUrl).includes("10.17026/dans-xzy-u62q"));
  assertEquals(buringh.sha256, BURINGH_SOURCE_SHA256);
  assertEquals(chandler.license, "CC BY 4.0");
  assertEquals(chandler.commit, CITIES_SOURCE_COMMIT);
  // 各都市の source index が sources 配列を指す
  for (const city of generated.cities) {
    assert(
      city.source === 0 || city.source === 1,
      `source index が不正: ${city.name}`,
    );
  }
});
