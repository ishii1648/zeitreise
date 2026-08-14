import { assert, assertEquals } from "@std/assert";
import nameJa from "../data/name-ja.json" with { type: "json" };
import nameOverrides from "../data/name-overrides.json" with { type: "json" };
import citiesData from "../data/cities.json" with { type: "json" };
import pendingCityNames from "../data/name-ja-pending-cities.json" with {
  type: "json",
};
import { ADOPTED_MOUNTAIN_NAMES } from "./build-mountains.ts";
import { ADOPTED_PEAK_NAMES } from "./build-peaks.ts";
import { CLIOPATRIA_COMPOSITE_PARENTS } from "./build-cliopatria-fiefs.ts";

// data/europe_*.geojson（全 20 年代）・data/hre_*.geojson（Roller 由来の 5 年代 +
// TASK-85/86 の中世 HRE 領邦 hre_fiefs_* 7 年代。再生成コマンドの glob
// `data/hre_*.geojson` が両方を拾う）・data/france_fiefs_*.geojson（5 年代、
// TASK-71）の全 feature の NAME / SUBJECTO のユニーク値（null 除外）に
// data/rivers.geojson の全 feature の name のユニーク値（null 除外）を加えた
// リスト（勢力名 + 河川名）。
//
// TASK-47: 元々は data/name-overrides.json の renames 値・data/cities.json の
// 都市名（TASK-27）もこの静的リストに含めていたが、これらは自己参照問題
// （実データを更新してもリスト更新を忘れると検出できない）を持っていた。
// data/name-overrides.json・data/cities.json は拡張子が .json のため
// `with { type: "json" }` の静的 import で `deno test`（CI は --allow-read
// なしで実行）でも実データを読み取れる（動作確認済み）。そのためこの 2
// ソースは下記テストで実データ突合に切り替え、このリストからは除外した。
//
// 一方 data/europe_*.geojson・data/hre_*.geojson・data/rivers.geojson は拡張子が
// .geojson のため、Deno は `type: "json"` 属性を付けても
// "Expected a Json module, but identified a Unknown module" として拒否する
// （拡張子ベースの media type 判定によるもので、権限の有無とは無関係の
// 技術的制約。動作確認済み）。CI の `deno test` に --allow-read も付与されて
// いない（.github/workflows/ci.yml 参照）ため Deno.readFile 経由でも読めず、
// geojson 由来分は実データ突合が実現不可能。このリストとして静的に列挙し、
// データ変更時は下記コマンドで再生成して手動更新する運用とする。
//
// 再生成コマンド（リポジトリルートで実行）:
//   python3 -c "import json,glob; s=set(); [s.update(v for f2 in [json.load(open(f))] for ft in f2['features'] for k in ('NAME','SUBJECTO') if (v:=ft['properties'].get(k))) for f in glob.glob('data/europe_*.geojson')+glob.glob('data/hre_*.geojson')+glob.glob('data/france_fiefs_*.geojson')+glob.glob('data/italy_fiefs_*.geojson')+glob.glob('data/cliopatria_fiefs_*.geojson')+glob.glob('data/britain_fiefs_*.geojson')+glob.glob('data/sovereign_fiefs_*.geojson')]; s.update(v for ft in json.load(open('data/rivers.geojson'))['features'] if (v:=ft['properties'].get('name'))); print(json.dumps(sorted(s),ensure_ascii=False,indent=2))"
const STATIC_GEOJSON_AND_RIVER_NAMES: string[] = [
  // #352 / ADR-0040: Cliopatria の括弧付き複合体（base 主権の外周置換専用。
  // 配信される flat には出ないが raw の NAME としてこの表に現れる）
  "(Duchies of Poland)",
  "(Kingdom of Poland)",
  "(Polish-Lithuania Kingdom)",
  "Abdelouadides",
  "Afghanistan",
  "Alans",
  "Albania",
  "Algeria",
  "Algeria (FR)",
  "Algiers",
  "Almohad Caliphate",
  "Almoravid dynasty",
  "Amu  Darya",
  // TASK-106: 1400 年の Seljuk Caliphate（1308 年滅亡）を上書きした総称 NAME
  "Anatolian beyliks",
  "Andorra",
  "Angevin Empire",
  "Anhalt",
  "Arabia",
  "Arabia (Nejd)",
  "Arabs",
  "Aragón",
  "Archbishopric of Cologne",
  "Archbishopric of Mainz",
  "Archbishopric of Salzburg",
  "Archbishopric of Trier",
  "Archduchy of Austria",
  "Ariège",
  "Armenia",
  "Arran",
  "Artsakh",
  "Astrakhan Khanate",
  "Austria",
  "Austria Hungary",
  "Austrian Empire",
  "Austrian Netherlands",
  "Austro-Hungarian Empire",
  "Azerbaijan",
  "Baden",
  "Baltic Tribes",
  "Batavian Republic",
  "Bavaria",
  "Belgium",
  "Beylik of Aydin",
  "Billung March",
  "Blue Horde",
  "Bokhara Khanate",
  "Borcea",
  "Bosnia",
  "Bosnia-Herzegovina",
  "Brandenburg",
  "Bratul Chillia",
  "Bratul Sfintu Gheorghe",
  "Bratul Sulina",
  "Bremen",
  "Britany",
  "Brunswick",
  "Brycheiniog",
  "Bulgar Khanate",
  "Bulgaria",
  "Burgandy",
  "Burgraviate of Nuremberg",
  "Buwayhid Emirates",
  "Byzantine Empire",
  "Caliphate of Córdoba",
  "Castile",
  "Castilla",
  "Castille",
  "Celtic kingdoms",
  "Chuds",
  "Comté de Toulouse",
  "Corsica",
  "Counts of Saint-Pol",
  "County of Abensberg",
  "County of Alençon",
  "County of Angoulême",
  "County of Anjou",
  // TASK-110: 以下 11 件は Cliopatria（CC BY 4.0）由来の諸侯領
  // （data/cliopatria_fiefs_*.geojson）。OHM に該当リレーションが無い領邦を
  // 補うために採ったもので、上流の Name をそのまま NAME に使っている。
  "County of Armagnac",
  "County of Artois",
  "County of Asti",
  "County of Auvergne",
  "County of Bar",
  "County of Barcelona",
  "County of Bentheim",
  "County of Blôis",
  "County of Boulogne",
  "County of Castell",
  "County of Champagne",
  "County of Drenthe",
  "County of East Frisia",
  "County of Falkenstein",
  "County of Flanders",
  "County of Foix",
  "County of Guastalla",
  "County of Henneberg-Schleusingen",
  "County of Hohenlohe",
  "County of Hohnstein",
  "County of Holland",
  "County of Holstein-Pinneberg",
  "County of Horne",
  "County of Kladsko",
  "County of La Marche",
  "County of Leiningen",
  "County of Maine",
  "County of Mark",
  "County of Moers",
  "County of Montbéliard",
  "County of Nantes",
  "County of Nevers",
  "County of Perche",
  "County of Pitigliano",
  "County of Poitou",
  "County of Ponthieu",
  "County of Périgord",
  "County of Ravensberg",
  "County of Rietberg",
  "County of Rouergue",
  "County of Santa Fiora",
  "County of Schaumburg",
  "County of Schaunberg",
  "County of Sovana",
  "County of Spiegelberg",
  "County of Sponheim",
  "County of Tecklenburg",
  "County of Toulouse",
  "County of Tours",
  "County of Vendôme",
  "County of Vermandois",
  "County of Vexin",
  "County/Principality of Neuchâtel",
  "Cretan State",
  "Crimean Khanate",
  "Croatia",
  "Cuman Khanates",
  "Cuman-Kipchak confederation",
  "Cuxhaven",
  "Cyprus",
  "Dalälven",
  "Danish March",
  "Danube",
  "Daugava",
  "Dauphiné of Viennois",
  "Deheubarth",
  "Denmark",
  "Denmark-Norway",
  "Derbent",
  "Dniester",
  "Dnipro",
  "Don",
  "Drava",
  // #352: 1279 / 1300 年に上流が個別公国へ分解していない残余
  "Duchies of Poland",
  "Duchy of Aquitaine",
  "Duchy of Athens",
  "Duchy of Austria",
  "Duchy of Bar",
  "Duchy of Bavaria",
  "Duchy of Berg",
  "Duchy of Bohemia",
  "Duchy of Brittany",
  "Duchy of Burgundy",
  "Duchy of Bytom",
  "Duchy of Carinthia",
  "Duchy of Carniola",
  "Duchy of Cleves",
  "Duchy of Crossen",
  "Duchy of Ferrara",
  "Duchy of Florence",
  "Duchy of Franconia",
  "Duchy of Gascony",
  "Duchy of Greater Poland",
  "Duchy of Guelders",
  "Duchy of Głogów",
  "Duchy of Jawor",
  "Duchy of Kuyavia",
  "Duchy of Legnica",
  "Duchy of Lorraine",
  "Duchy of Lower Lotharingia",
  "Duchy of Luxembourg",
  "Duchy of Masovia",
  "Duchy of Massa and Carrara",
  // #187: 以下の近世 HRE 領邦は data/hre_fiefs_1715/1783/1800.geojson 由来
  "Duchy of Mecklenburg-Schwerin",
  "Duchy of Mecklenburg-Strelitz",
  "Duchy of Milan",
  "Duchy of Mirandola",
  "Duchy of Modena and Reggio",
  "Duchy of Normandy",
  "Duchy of Opole",
  "Duchy of Pless",
  "Duchy of Pomerania",
  "Duchy of Pomerania-Stettin",
  "Duchy of Racibórz",
  "Duchy of Sandomierz",
  "Duchy of Saxe-Wittenberg",
  "Duchy of Saxony",
  "Duchy of Siewierz",
  "Duchy of Silesia",
  "Duchy of Spoleto",
  "Duchy of Swabia",
  "Duchy of Thuringia",
  "Duchy of Upper Lotharingia",
  "Duchy of Westphalia",
  "Duchy of Wrocław",
  "Duchy of Württemberg",
  "Duero",
  "Durdzuks",
  "Dutch Republic",
  "Dutchy of Benevento",
  "Eastern Rumelia",
  "Ebro",
  "Elbe",
  "Electoral Hesse",
  "Electorate of Bavaria",
  "Electorate of Brandenburg",
  "Electorate of Cologne",
  "Electorate of Mainz",
  "Electorate of Saxony",
  "Electorate of Saxony(-Wittenberg)",
  "Electorate of the Palatinate",
  "Emirate of Sicily",
  "Emirate of Tiflis",
  "Emirate of the White Sheep Turks",
  "England",
  "England and Ireland",
  "English territory",
  "Erfurt Territory",
  "Euphrates",
  "Eyalet of Crete",
  "Fatimid Caliphate",
  "Finland",
  "Finnmark",
  "Finno-Ugric taiga hunter-gatherers",
  "Fivizzano",
  "Florence",
  "France",
  "Franche-Comté",
  "Friesland",
  "Garonne",
  "Geneva",
  "Genoa",
  "Georgia",
  "German Empire",
  "Germany",
  "Ghaznavid Emirate",
  "Glomma",
  "Goghtn",
  "Golden Horde",
  "Granada",
  "Grand Duchy of Finland",
  "Grand Duchy of Hesse",
  "Grand Duchy of Lithuania",
  "Grand Duchy of Moscow",
  "Greece",
  "Greenland",
  "Göta älv",
  "Habsburg Austria",
  "Habsburg Netherlands",
  "Hafsid Caliphate",
  "Hamburg",
  "Hanover",
  "Helvetic Republic",
  "Hesse-Darmstadt",
  "Hesse-Kassel",
  "Hohenzollern",
  "Holstein",
  "Holy Roman Empire",
  "Hungary",
  "Iceland",
  "Icelandic Commonwealth",
  "Ilkhanate",
  "Imperial Abbey of Berchtesgaden",
  "Imperial Abbey of Burtscheid",
  "Imperial Abbey of Corvey",
  "Imperial Abbey of Essen",
  "Imperial Abbey of Hersfeld",
  "Imperial Abbey of Ottobeuren",
  "Imperial Abbey of Thorn",
  "Imperial Abbey of Werden",
  "Imperial Hungary",
  "Irish Catholic Confederation",
  "Isle of Man",
  "Italy",
  "Kakheti-Hereti",
  "Kalmar Union",
  "Kama",
  "Kara Khitai Khaganate",
  "Karakalpaks",
  "Karelians",
  "Karkhanids",
  "Kazan Khanate",
  "Kem",
  "Kemijoki",
  "Khanate of the Golden Horde",
  "Khazars",
  "Khiva Khanate",
  "Khundzi",
  "Kievan Rus",
  "Kimek-Kipchak khaganate",
  "Kingdom of Bohemia",
  "Kingdom of Dublin",
  "Kingdom of France",
  "Kingdom of Galloway",
  "Kingdom of Georgia",
  "Kingdom of Glywysing/Morgannwg",
  "Kingdom of Gwynedd",
  "Kingdom of Hungary",
  "Kingdom of Ireland",
  "Kingdom of Leinster",
  "Kingdom of Meath",
  "Kingdom of Poland",
  "Kingdom of Powys",
  "Kingdom of Sardinia",
  "Kingdom of Strathclyde",
  "Kingdom of the Two Sicilies",
  "Kingfom of Italy",
  "Knights Hospitaller",
  "Kokemäenjoki",
  "Kurs",
  "Kyivan Rus",
  "Landgraviate of Hesse",
  "Landgraviate of Hesse-Darmstadt",
  "Landgraviate of Hesse-Kassel",
  "Landgraviate of Thurgau",
  "Liechtenstein",
  "Ligurian Republic",
  "Lek",
  "Leks",
  "León",
  "Lippe-Detmold",
  "Lithuania",
  "Loire",
  "Lombardy",
  "Lordship of Cottbus",
  "Lordship of Eastern Meath",
  "Lordship of Lucca",
  "Lordship of Meath",
  "Lordship of Oneglia",
  "Lordship of Piombino",
  "Lordship of Rimini",
  "Lordship of Ruppin",
  "Lordship of Verona",
  "Lordship of Western Meath",
  "Lucca",
  "Luxembourg",
  "Lübeck",
  "Magyars",
  "Malta",
  "Mamluke Sultanate",
  "March of Cham",
  "March of Meissen",
  // TASK-110: Cliopatria 由来（1279 / 1300 / 1400 年のブランデンブルク）
  "Margraviate of Brandenburg",
  "March of Montferrat",
  "March of Tuscany",
  "March of Verona",
  "Margraviate of Baden",
  "Margraviate of Baden-Baden",
  "Margraviate of Baden-Durlach",
  "Margraviate of Mantua",
  "Marquisate of Saluzzo",
  "Maskat",
  "Massa",
  "Mecklenburg-Schwerin",
  "Mecklenburg-Strelitz",
  "Merinides",
  "Milan",
  "Milano (Austria)",
  "Modena",
  "Moldova",
  "Monaco",
  "Montenegro",
  "Moravia",
  "Morocco",
  "Naples",
  "Nassau",
  "Nassau-Weilburg",
  "Navarre",
  "Nederrijn",
  "Netherlands",
  "Neva",
  "Nogai Horde",
  "Norway",
  "Novgorod",
  "Novgorod-Seversky",
  "Oder",
  "Oghuz",
  "Oldenburg",
  "Other Rus Principalities",
  "Ottoman Empire",
  "Palatinate",
  "Paleo-Siberian hunter-gatherers",
  "Papal States",
  "Parma",
  "Peasant Republic of Dithmarschen",
  "Pechora",
  "Persia",
  "Peshemegs",
  "Po",
  "Poland",
  "Poland-Lithuania",
  "Poland-Llituania",
  "Polish–Lithuanian Commonwealth",
  "Pomerania",
  "Pontremoli",
  "Portugal",
  "Prince-Archbishopric of Bremen",
  "Prince-Archbishopric of Magdeburg",
  "Prince-Archbishopric of Salzburg",
  "Prince-Bishopric of Bamberg",
  "Prince-Bishopric of Basel",
  "Prince-Bishopric of Cammin",
  "Prince-Bishopric of Eichstätt",
  "Prince-Bishopric of Freising",
  "Prince-Bishopric of Lübeck",
  "Prince-Bishopric of Minden",
  "Prince-Bishopric of Münster",
  "Prince-Bishopric of Paderborn",
  "Prince-Bishopric of Passau",
  "Prince-Bishopric of Regensburg",
  "Prince-Bishopric of Utrecht",
  "Prince-Bishopric of Verden",
  "Prince-Bishopric of Worms",
  "Prince-Bishopric of Würzburg",
  "Princely Abbey of Fulda",
  "Princely Abbey of Kempten",
  "Princely Abbey of Stavelot-Malmedy",
  "Principality of Achaea",
  "Principality of Ansbach",
  "Principality of Bayreuth",
  "Principality of Galicia-Volhynia",
  "Principality of Kyiv",
  "Principality of Moldavia",
  "Principality of Novgorod",
  "Principality of Oneglia",
  "Principality of Polotsk",
  "Principality of Vladimir-Suzdal",
  "Principality of Wallachia",
  "Prussia",
  "Prussians",
  "Pskov",
  "Quazaq Khanate",
  "Raška",
  "Republic of Ancona",
  "Republic of Florence",
  "Republic of Genoa",
  "Republic of Kraków",
  "Republic of Lucca",
  "Republic of Massa",
  "Republic of Pisa",
  "Republic of Ragusa",
  "Republic of Siena",
  "Republic of the Seven Zenden",
  "Rhine",
  "Rhwng Gwy a Hafren",
  "Rhône",
  "Romania",
  // TASK-110: Cliopatria の "Kingdom of France"（= 王の直轄領）を base の
  // フランス王国と取り違えないよう読み替えた NAME
  // （scripts/build-cliopatria-fiefs.ts の CLIOPATRIA_NAME_OVERRIDES）
  "Royal Domain of France",
  "Russia",
  "Russian Empire",
  "Ryazan",
  "Safavid Empire",
  "Samis",
  "San Marino",
  "Sardinia",
  "Sardinia-Piedmont",
  "Savoy",
  "Savoy-Piedmont",
  "Saxon Eastern March",
  "Saxony",
  "Schaumburg-Lippe",
  "Schleswig",
  "Scotland",
  "Scottalnd",
  "Scottland",
  "Seine",
  "Seljuk Caliphate",
  "Seljuk Empire",
  "Serbia",
  "Severnaya Dvina",
  "Shirvan",
  "Siberians",
  "Sicily",
  "Sodor",
  "Soroksari Duna",
  "Southern Powys",
  "Spain",
  "Spanish Morocco",
  "Sukhona",
  "Suomi",
  "Svir’",
  "Swabia",
  "Sweden",
  "Sweden–Norway",
  "Swiss Confederation",
  "Switzerland",
  "Syunik",
  "Sámi",
  "Tajo",
  "Tashir",
  "Tejo",
  "Teutonic Knights",
  "Thames",
  "Thule",
  "Thuringia",
  "Tigris",
  "Timurid Emirates",
  "Timurid Empire",
  "Tisza",
  "Transylvania",
  "Trebizond",
  "Tsardom of Muscovy",
  "Tunis",
  "Tunisia",
  "Turan",
  "Tuscany",
  "UK",
  "United Kingdom",
  "United Kingdom of Great Britain and Ireland",
  "United Kingdom of Netherlands",
  "United States of the Ionian Islands",
  "Ural",
  "Venetia",
  "Venice",
  "Vistula",
  "Volga",
  "Volga Bulgars",
  "Vorma",
  "Vuoksi",
  "Vychegda",
  "Waal",
  "Waldeck",
  "Watassid Morocco",
  "Wattasid Caliphate",
  "Wetzlar",
  "White Horde",
  "Württemberg",
  "Zayyanid Caliphate",
  "central Asian khanates",
];

const mapping = nameJa as Record<string, string>;

Deno.test("name-ja.json はフラットな Record<string, string> で値は全て非空文字列", () => {
  assert(typeof nameJa === "object" && nameJa !== null);
  assert(!Array.isArray(nameJa));
  const entries = Object.entries(mapping);
  assert(entries.length > 0);
  for (const [key, value] of entries) {
    assert(key.length > 0, "空のキーが存在する");
    assertEquals(
      typeof value,
      "string",
      `値が文字列でない: ${key} -> ${JSON.stringify(value)}`,
    );
    assert(value.length > 0, `値が空文字列: ${key}`);
  }
});

Deno.test("主要国の日本語表記が期待どおり", () => {
  const expected: Record<string, string> = {
    "Holy Roman Empire": "神聖ローマ帝国",
    "France": "フランス",
    "Kingdom of France": "フランス王国",
    "England": "イングランド王国",
    "Castile": "カスティーリャ王国",
    "Ottoman Empire": "オスマン帝国",
    "Byzantine Empire": "ビザンツ帝国",
    "Teutonic Knights": "ドイツ騎士団領",
    "Papal States": "教皇領",
    "Venice": "ヴェネツィア共和国",
    "Golden Horde": "キプチャク・ハン国（ジョチ・ウルス）",
    "Grand Duchy of Moscow": "モスクワ大公国",
    "Kalmar Union": "カルマル同盟",
    "Austria": "オーストリア",
    // HRE 領邦は正式称号付きで統一（TASK-32）
    "Kingdom of Bohemia": "ボヘミア王国",
    "Electorate of Saxony": "ザクセン選帝侯領",
    "Duchy of Saxony": "ザクセン公領",
    "Electorate of Brandenburg": "ブランデンブルク選帝侯領",
    "Electorate of the Palatinate": "プファルツ選帝侯領",
    "Archbishopric of Mainz": "マインツ大司教領",
    "Archduchy of Austria": "オーストリア大公領",
    "Duchy of Bavaria": "バイエルン公領",
    "Electorate of Bavaria": "バイエルン選帝侯領",
  };
  for (const [name, ja] of Object.entries(expected)) {
    assertEquals(mapping[name], ja, `${name} の訳が期待と異なる`);
  }
});

Deno.test("NAME を上書きした勢力の日本語表記が登録されている（TASK-106）", () => {
  // propertyFixes で NAME を上書きした先（監査 §4）。日本語表記は英語 NAME を
  // キーにするため、上書き先の訳が無いと画面には英語のまま出る（decision-6）。
  const expected: Record<string, string> = {
    // 1400: ルーム・セルジューク朝（1308 年滅亡）の代わりに置いた総称
    "Anatolian beyliks": "アナトリア諸侯国（ベイリク）",
    // 1279 / 1300: 131 万 km² を覆う Ryazan の代わりに置いた総称（1200 年に前例）
    "Other Rus Principalities": "その他のルーシ諸公国",
  };
  for (const [name, ja] of Object.entries(expected)) {
    assertEquals(mapping[name], ja, `${name} の訳が期待と異なる`);
  }
  // 上書き前の名前は他年代でなお正しく使われるので訳を消さない
  // （1492 / 1500 の Ryazan・1279 / 1300 の Seljuk Caliphate）
  for (const name of ["Ryazan", "Seljuk Caliphate"]) {
    assert(
      typeof mapping[name] === "string" && mapping[name].length > 0,
      `${name} の訳が失われている`,
    );
  }
});

Deno.test("中世フランス諸侯領 14 件が称号付きの日本語表記で登録されている（TASK-71 AC #2）", () => {
  const expected: Record<string, string> = {
    "County of Alençon": "アランソン伯領",
    "County of Anjou": "アンジュー伯領",
    "County of Artois": "アルトワ伯領",
    "County of Bar": "バール伯領",
    "County of Champagne": "シャンパーニュ伯領",
    "County of Flanders": "フランドル伯領",
    "County of Maine": "メーヌ伯領",
    "County of Poitou": "ポワトゥー伯領",
    "County of Ponthieu": "ポンチュー伯領",
    "Duchy of Aquitaine": "アキテーヌ公領",
    "Duchy of Brittany": "ブルターニュ公領",
    "Duchy of Burgundy": "ブルゴーニュ公領",
    "Duchy of Gascony": "ガスコーニュ公領",
    "Duchy of Normandy": "ノルマンディー公領",
  };
  for (const [name, ja] of Object.entries(expected)) {
    assertEquals(mapping[name], ja, `${name} の訳が期待と異なる`);
    // 称号（公領 / 伯領）付きで統一されていること
    assert(
      ja.endsWith("公領") || ja.endsWith("伯領"),
      `${name} の訳に称号が無い: ${ja}`,
    );
  }
});

Deno.test("中世 HRE 領邦が TASK-32 の称号規約に沿った日本語表記で登録されている（TASK-86 AC #2）", () => {
  // 爵位・称号ごとの規約: Duchy → 公領 / County → 伯領 / March・Margraviate →
  // 辺境伯領 / Burgraviate → 城伯領 / Landgraviate → 方伯領 /
  // Electorate → 選帝侯領 / Principality → 侯領 / Lordship → 領主領 /
  // Prince-Bishopric → 司教領 / Prince-Archbishopric → 大司教領 /
  // Imperial Abbey → 帝国修道院領 / Princely Abbey → 侯修道院領
  const expected: Record<string, string> = {
    "Duchy of Austria": "オーストリア公領",
    "Duchy of Lower Lotharingia": "下ロタリンギア公領",
    "Duchy of Swabia": "シュヴァーベン公領",
    "County of Holland": "ホラント伯領",
    "County of Mark": "マルク伯領",
    "March of Meissen": "マイセン辺境伯領",
    "Billung March": "ビルング辺境伯領",
    "Moravia": "モラヴィア辺境伯領",
    "Burgraviate of Nuremberg": "ニュルンベルク城伯領",
    "Landgraviate of Thurgau": "トゥールガウ方伯領",
    "Electorate of Cologne": "ケルン選帝侯領",
    "Principality of Ansbach": "アンスバッハ侯領",
    "Lordship of Cottbus": "コトブス領主領",
    "Prince-Bishopric of Würzburg": "ヴュルツブルク司教領",
    "Prince-Archbishopric of Magdeburg": "マクデブルク大司教領",
    "Imperial Abbey of Corvey": "コルヴァイ帝国修道院領",
    "Princely Abbey of Fulda": "フルダ侯修道院領",
    "Peasant Republic of Dithmarschen": "ディトマルシェン農民共和国",
  };
  for (const [name, ja] of Object.entries(expected)) {
    assertEquals(mapping[name], ja, `${name} の訳が期待と異なる`);
  }
});

Deno.test("近世 HRE 領邦（1715/1783/1800 年）が称号規約に沿った日本語表記で登録されている（#187 AC）", () => {
  // scripts/build-hre-fiefs.ts の HRE_FIEF_EARLY_MODERN_NAMES 全 17 件。
  // OHM の name:en が称号を持たないヘッセン・ナッサウも、日本語では実態の称号
  // （方伯領・侯領）を付けて既存の領邦表記（TASK-32 規約）と揃える。
  const expected: Record<string, string> = {
    "Duchy of Mecklenburg-Schwerin": "メクレンブルク＝シュヴェリーン公領",
    "Duchy of Mecklenburg-Strelitz": "メクレンブルク＝シュトレーリッツ公領",
    "Electorate of Bavaria": "バイエルン選帝侯領",
    "Electorate of Brandenburg": "ブランデンブルク選帝侯領",
    "Electorate of Cologne": "ケルン選帝侯領",
    "Electorate of Mainz": "マインツ選帝侯領",
    "Electorate of Saxony": "ザクセン選帝侯領",
    "Hesse-Darmstadt": "ヘッセン＝ダルムシュタット方伯領",
    "Hesse-Kassel": "ヘッセン＝カッセル方伯領",
    "Margraviate of Baden": "バーデン辺境伯領",
    "Margraviate of Baden-Baden": "バーデン＝バーデン辺境伯領",
    "Margraviate of Baden-Durlach": "バーデン＝ドゥルラハ辺境伯領",
    "Nassau-Weilburg": "ナッサウ＝ヴァイルブルク侯領",
    "Prince-Archbishopric of Salzburg": "ザルツブルク大司教領",
    "Prince-Bishopric of Bamberg": "バンベルク司教領",
    "Prince-Bishopric of Münster": "ミュンスター司教領",
    "Prince-Bishopric of Würzburg": "ヴュルツブルク司教領",
  };
  assertEquals(Object.keys(expected).length, 17);
  for (const [name, ja] of Object.entries(expected)) {
    assertEquals(mapping[name], ja, `${name} の訳が期待と異なる`);
    assert(ja.endsWith("領"), `${name} の訳に称号が無い: ${ja}`);
  }
});

Deno.test("中世イタリア諸侯領 27 件が TASK-32 の称号規約に沿った日本語表記で登録されている（TASK-96 AC #4）", () => {
  // 規約は HRE 領邦・仏諸侯領と同一: Duchy → 公領 / County → 伯領 /
  // March・Margraviate・Marquisate → 辺境伯領 / Lordship → 領主領 /
  // Principality → 侯領。Republic は主権を持つ都市共和国なので「〜共和国」。
  //
  // Duchy を「公国」ではなく「公領」に揃えるのは、既存の
  // "Duchy of Milan" → "ミラノ公領"（hre_fiefs 由来）と同じ地域・同じ地図上で
  // 表記が割れないようにするため。Marquisate of Saluzzo と March of Montferrat は
  // どちらもイタリアの marchesato で、OHM 側の英語表記が揺れているだけなので
  // 日本語では同じ「辺境伯領」に寄せる。
  const expected: Record<string, string> = {
    "County of Asti": "アスティ伯領",
    "County of Guastalla": "グアスタッラ伯領",
    "County of Pitigliano": "ピティリアーノ伯領",
    "County of Santa Fiora": "サンタ・フィオーラ伯領",
    "County of Sovana": "ソヴァーナ伯領",
    "Duchy of Ferrara": "フェラーラ公領",
    "Duchy of Florence": "フィレンツェ公領",
    "Duchy of Massa and Carrara": "マッサ＝カッラーラ公領",
    "Duchy of Mirandola": "ミランドラ公領",
    "Duchy of Modena and Reggio": "モデナ＝レッジョ公領",
    "Duchy of Spoleto": "スポレート公領",
    "Lordship of Lucca": "ルッカ領主領",
    "Lordship of Oneglia": "オネーリア領主領",
    "Lordship of Piombino": "ピオンビーノ領主領",
    "Lordship of Rimini": "リミニ領主領",
    "March of Montferrat": "モンフェッラート辺境伯領",
    "March of Tuscany": "トスカーナ辺境伯領",
    "Margraviate of Mantua": "マントヴァ辺境伯領",
    "Marquisate of Saluzzo": "サルッツォ辺境伯領",
    "Principality of Oneglia": "オネーリア侯領",
    "Republic of Ancona": "アンコーナ共和国",
    "Republic of Florence": "フィレンツェ共和国",
    "Republic of Genoa": "ジェノヴァ共和国",
    "Republic of Lucca": "ルッカ共和国",
    "Republic of Massa": "マッサ共和国",
    "Republic of Pisa": "ピサ共和国",
    "Republic of Siena": "シエナ共和国",
  };
  assertEquals(Object.keys(expected).length, 27);
  for (const [name, ja] of Object.entries(expected)) {
    assertEquals(mapping[name], ja, `${name} の訳が期待と異なる`);
    // 称号（〜領 / 〜共和国）付きで統一されていること
    assert(
      ja.endsWith("領") || ja.endsWith("共和国"),
      `${name} の訳に称号が無い: ${ja}`,
    );
  }
});

Deno.test("AC #1/#2 の対象諸侯（1200 年の 6 勢力・1100 年のトスカーナ）が日本語表記を持つ（TASK-96 AC #1/#2/#4）", () => {
  for (
    const name of [
      "Republic of Florence",
      "Republic of Genoa",
      "Republic of Pisa",
      "Republic of Siena",
      "Republic of Lucca",
      "Duchy of Spoleto",
      "March of Tuscany",
    ]
  ) {
    assert(
      typeof mapping[name] === "string" && mapping[name] !== "",
      `${name} の日本語表記が無い（地図ラベルが英語のままになる）`,
    );
  }
});

Deno.test("帝国内の称号を持つ領邦の訳は全て『〜領』で終わる（TASK-86 AC #2）", () => {
  // base データ側の HRE 領邦（TASK-32 で統一済み）と中世領邦で表記規約を揃える。
  // "Principality of ..." は帝国外の主権公国（キエフ・ワラキア等）にも使われ
  // 「〜公国」が正しい訳になるため、この検査の対象から外す（帝国内の
  // Principality of Ansbach / Bayreuth は上のテストが個別に固定している）。
  const titled =
    /^(Duchy|County|March|Margraviate|Burgraviate|Landgraviate|Electorate|Lordship|Prince-Bishopric|Prince-Archbishopric|Archbishopric|Bishopric|Imperial Abbey|Princely Abbey) of /;
  // 帝国外の主権政体で、称号の英語表記だけが帝国領邦と同じ形になるもの。
  // #190 の Duchy of Athens は第 4 回十字軍後のラテン系国家で、日本語文献の
  // 慣用も「アテネ公国」。帝国領邦の表記規約（〜領）を当てる対象ではない。
  // #352 / ADR-0040: ポーランド諸公国（分割期ピャスト朝の分領公国）は帝国の
  // 領邦ではなくポーランド王権の下の公国で、日本語文献の慣用も「〜公国」
  // （マゾフシェ公国・シロンスク公国）。Duchy of Athens と同じ扱いで対象外に
  // する。列挙ではなく許可リスト（CLIOPATRIA_COMPOSITE_PARENTS の childNames）
  // から引くことで、上流の構成が変わっても手で足す必要が無い。
  const nonImperialTitled = new Set([
    "Duchy of Athens",
    ...CLIOPATRIA_COMPOSITE_PARENTS.flatMap((entry) => [...entry.childNames]),
  ]);
  const offenders = Object.entries(mapping)
    .filter(([name]) => titled.test(name) && !nonImperialTitled.has(name))
    .filter(([, ja]) => !ja.endsWith("領"))
    .map(([name, ja]) => `${name} -> ${ja}`);
  assertEquals(offenders, []);
});

Deno.test("ブリテン諸島の政体 19 件が日本語表記で登録されている（#172 AC #3）", () => {
  // TASK-151 の許可リスト（scripts/build-britain-fiefs.ts）全 19 政体名。
  // 称号は NAME の英語表記に従う（Kingdom → 王国 / Lordship → 卿領。
  // アングロ・ノルマン期アイルランドの Lordship は日本語文献の慣用
  // 「アイルランド卿領」に合わせて「〜卿領」とし、イタリアのシニョリーア
  // 「〜領主領」とは訳し分ける）。称号を持たないウェールズ語名
  // （Deheubarth 等）は音写のみ。Sodor はノルド語 Suðreyjar（南諸島）由来の
  // 「マン島と諸島の王国」の別名なので、補足を丸括弧で付す。
  const expected: Record<string, string> = {
    "Kingdom of Gwynedd": "グウィネズ王国",
    "Kingdom of Powys": "ポウィス王国",
    "Southern Powys": "南ポウィス",
    "Deheubarth": "デヘイバース",
    "Brycheiniog": "ブリチェイニョグ",
    "Kingdom of Glywysing/Morgannwg": "グリウィシング（モーガンヌグ）王国",
    "Rhwng Gwy a Hafren": "ルング・グイ・ア・ハヴレン",
    "Kingdom of Dublin": "ダブリン王国",
    "Kingdom of Leinster": "レンスター王国",
    "Kingdom of Meath": "ミース王国",
    "Lordship of Meath": "ミース卿領",
    "Lordship of Eastern Meath": "東ミース卿領",
    "Lordship of Western Meath": "西ミース卿領",
    "Kingdom of Ireland": "アイルランド王国",
    "Irish Catholic Confederation": "アイルランド・カトリック同盟",
    "Kingdom of Strathclyde": "ストラスクライド王国",
    "Kingdom of Galloway": "ギャロウェイ王国",
    "Sodor": "ソドール王国（マン島と諸島）",
    "Isle of Man": "マン島",
  };
  assertEquals(Object.keys(expected).length, 19);
  for (const [name, ja] of Object.entries(expected)) {
    assertEquals(mapping[name], ja, `${name} の訳が期待と異なる`);
  }
});

Deno.test("主権政体オーバーレイの新出 8 政体が日本語表記で登録されている（#189）", () => {
  // #189 の許可リスト（scripts/build-sovereign-fiefs.ts）のうち base に
  // 現れない NAME。base と共通の政体（ハンガリー王国・ワラキア公国・
  // モスクワ大公国・クリミア・ハン国・セルビア・モンテネグロ）は base の
  // NAME に合わせており、既存の訳がそのまま使われる。
  // Transylvania は 1715 年（公国）と 1783 年以降（大公国）を単一 NAME で
  // 覆うため、時代で正誤が割れる称号を付けず地名のままとする。
  // Eyalet of Crete は「オスマン帝国のクレタ州」で、1880 年の base の
  // Bulgaria 誤帰属を正すための区画。日本語文献に定訳が無いため、実態を
  // 示す「オスマン領クレタ」とする（欠落勢力台帳と同じ表記）。
  const expected: Record<string, string> = {
    "Transylvania": "トランシルヴァニア",
    "Principality of Moldavia": "モルダヴィア公国",
    "Republic of Ragusa": "ラグーザ共和国",
    "Grand Duchy of Finland": "フィンランド大公国",
    "Eastern Rumelia": "東ルメリ自治州",
    "United States of the Ionian Islands": "イオニア諸島合衆国",
    "Eyalet of Crete": "オスマン領クレタ",
    "Cretan State": "クレタ国",
  };
  assertEquals(Object.keys(expected).length, 8);
  for (const [name, ja] of Object.entries(expected)) {
    assertEquals(mapping[name], ja, `${name} の訳が期待と異なる`);
  }
});

Deno.test("主権政体オーバーレイの #190 追加分 5 政体が日本語表記で登録されている", () => {
  // #190 の許可リスト（scripts/build-sovereign-fiefs.ts）のうち base に
  // 現れない NAME。base と共通の政体（Naples / Savoy / Genoa / Papal States）は
  // base の NAME に合わせており、既存の訳（ナポリ王国 / サヴォイア /
  // ジェノヴァ / 教皇領）がそのまま使われる。
  // Knights Hospitaller はロドス期（1400〜1500）とマルタ期（1530〜1783）を
  // 単一 NAME で継ぐため、拠点名を含めず「ヨハネ騎士団領」とする。
  const expected: Record<string, string> = {
    "County of Barcelona": "バルセロナ伯領",
    "Duchy of Athens": "アテネ公国",
    "Principality of Achaea": "アカイア公国",
    "Knights Hospitaller": "ヨハネ騎士団領",
    "Ligurian Republic": "リグリア共和国",
  };
  assertEquals(Object.keys(expected).length, 5);
  for (const [name, ja] of Object.entries(expected)) {
    assertEquals(mapping[name], ja, `${name} の訳が期待と異なる`);
  }
  // base と共通の政体は既存の訳を再利用する（色・表記の連続性）
  assertEquals(mapping["Naples"], "ナポリ王国");
  assertEquals(mapping["Savoy"], "サヴォイア");
  assertEquals(mapping["Genoa"], "ジェノヴァ");
  assertEquals(mapping["Papal States"], "教皇領");
});

Deno.test("主権政体オーバーレイの #191 追加分（微小国家 4 政体）が日本語表記で登録されている", () => {
  // #191 の許可リスト（scripts/build-sovereign-fiefs.ts）の 4 政体。
  // San Marino は base の 1815 年にも現れる（既存の訳「サンマリノ」を再利用し、
  // base とオーバーレイで表記・色が連続する）。
  // 通称が定着しているため称号（公国・侯国・共和国）は付けず、現行の国名表記
  // （外務省の国名表記に合わせた片仮名）を採る。
  const expected: Record<string, string> = {
    "San Marino": "サンマリノ",
    "Andorra": "アンドラ",
    "Monaco": "モナコ",
    "Liechtenstein": "リヒテンシュタイン",
  };
  assertEquals(Object.keys(expected).length, 4);
  for (const [name, ja] of Object.entries(expected)) {
    assertEquals(mapping[name], ja, `${name} の訳が期待と異なる`);
  }
});

Deno.test("主要山脈の日本語表記が登録されている（TASK-97 AC #1）", () => {
  // NE 側の NAME_JA をそのまま採る。例外は "ELBURZ MTS." で、NE の
  // NAME_JA「エルブルス山」はコーカサスのエルブルス山（Mount Elbrus）との
  // 取り違えなので、イランの山脈としての正しい表記「アルボルズ山脈」を採る。
  const expected: Record<string, string> = {
    "ALPS": "アルプス山脈",
    "PYRENEES": "ピレネー山脈",
    "CARPATHIAN MOUNTAINS": "カルパティア山脈",
    "APPENNINI": "アペニン山脈",
    "KJØLEN MOUNTAINS": "スカンディナヴィア山脈",
    "ELBURZ MTS.": "アルボルズ山脈",
  };
  for (const [name, ja] of Object.entries(expected)) {
    assertEquals(mapping[name], ja, `${name} の訳が期待と異なる`);
  }
  // 収録した山脈は全て「〜山脈」で終わる表記に統一する
  const offenders = ADOPTED_MOUNTAIN_NAMES
    .filter((name) => !(mapping[name] ?? "").endsWith("山脈"))
    .map((name) => `${name} -> ${mapping[name]}`);
  assertEquals(offenders, []);
});

Deno.test("主要山峰の日本語表記が登録されている（TASK-99 AC #1）", () => {
  // 値は NE（10m elevation points）の name_ja をそのまま採る。山脈
  // （ADOPTED_MOUNTAIN_NAMES）と違い「〜山脈」のような語尾の統一規約は置かない。
  // 日本語の慣用が山ごとに割れている（モンブラン / マッターホルン＝「山」を
  // 付けない、エトナ山 / ベン・ネビス山＝付ける）ため、統一すると慣用から
  // 外れた表記になってしまう。
  const expected: Record<string, string> = {
    "Mont Blanc": "モンブラン",
    "Matterhorn": "マッターホルン",
    "Grossglockner": "グロースグロックナー山",
    "Monte Rosa": "モンテ・ローザ",
    "Gora Elbrus": "エルブルス山",
    "Monte Etna": "エトナ山",
  };
  for (const [name, ja] of Object.entries(expected)) {
    assertEquals(mapping[name], ja, `${name} の訳が期待と異なる`);
  }
  // 収録した山峰は全て日本語表記を持つ（英語のまま出るものが無い）
  const missing = ADOPTED_PEAK_NAMES.filter(
    (name) => typeof mapping[name] !== "string" || mapping[name] === "",
  );
  assertEquals(missing, []);
});

Deno.test("TASK-55 で消えた手書き都市訳が復元されている（TASK-61）", () => {
  // TASK-55 の選定変更で選外となった都市の手書き訳が name-ja.json から
  // 削除された。訳辞書は採用状況に依存せず保持できるため、削除された
  // 手書き訳を復元し、以後も保持されることを固定する。
  const expected: Record<string, string> = {
    Antwerp: "アントウェルペン",
    Bruges: "ブリュージュ",
    Barcelona: "バルセロナ",
    Bologna: "ボローニャ",
    Edinburgh: "エディンバラ",
    Antioch: "アンティオキア",
    Gdansk: "グダンスク",
    Almeria: "アルメリア",
    Amalfi: "アマルフィ",
    Cartagena: "カルタヘナ",
    Algiers: "アルジェ",
    Tunis: "チュニス",
  };
  for (const [name, ja] of Object.entries(expected)) {
    assertEquals(mapping[name], ja, `${name} の訳が期待と異なる`);
  }
});

/**
 * data/name-ja.json のキーとして期待される名前の全体集合を実データから組み立てる。
 * - 勢力名 + 河川名（data/europe_*.geojson・data/hre_*.geojson・
 *   data/rivers.geojson 由来）: 拡張子 .geojson は静的 import 不可（上記コメント
 *   参照）なため STATIC_GEOJSON_AND_RIVER_NAMES の静的リストを使う。
 * - renames 正規化後名・都市名（data/name-overrides.json・data/cities.json 由来）:
 *   拡張子 .json は静的 import 可能なため実データを直接読み、リストの
 *   自己参照問題（データ更新時の更新漏れを検出できない）を解消する。
 */
function expectedNames(): Set<string> {
  const names = new Set(STATIC_GEOJSON_AND_RIVER_NAMES);
  // TASK-97: 山脈名（data/mountains.geojson の name）。生成物は .geojson で
  // 静的 import できないが、収録一覧は scripts/build-mountains.ts の
  // ADOPTED_MOUNTAIN_NAMES が唯一の定義元で、生成時に実データと突き合わせる
  // （不一致なら build-mountains が fail する）ため静的リストの二重管理にならない。
  for (const name of ADOPTED_MOUNTAIN_NAMES) names.add(name);
  // TASK-99: 山峰名（data/peaks.geojson の name）。山脈と同じ理由で
  // scripts/build-peaks.ts の ADOPTED_PEAK_NAMES を唯一の定義元とする
  // （生成時に実データと突き合わせ、不一致なら build-peaks が fail する）。
  for (const name of ADOPTED_PEAK_NAMES) names.add(name);
  const overrides = nameOverrides as { renames: Record<string, string> };
  for (const renamed of Object.values(overrides.renames)) names.add(renamed);
  // #222: cities.json は正規化形式（トップレベル cities 配列に全年代の都市を
  // 一度だけ持つ）。年別セルは index 参照のため、名前の全集合は cities 配列。
  const cities = citiesData as { cities: { name: string }[] };
  for (const entry of cities.cities) names.add(entry.name);
  return names;
}

/**
 * 未訳都市の許容リスト（#222 フェーズ 1 → フェーズ 2 の段階導入）。
 *
 * Buringh 2021 の併合で都市が一挙に約 2,000 件増えた。日本語表記の付与
 * （フェーズ 2）は別作業として進めるため、その間このリストに載っている
 * 都市名だけはカバレッジ 100% の突合から除外する。フェーズ 2 完了時に
 * このファイルは空配列になり、従来どおり全都市に訳が必須となる。
 * 訳を追加したらこのリストから外すこと（下の陳腐化検査が機械的に強制する）。
 */
const PENDING_CITY_NAMES: string[] = pendingCityNames as string[];

Deno.test("全ユニーク NAME / SUBJECTO と renames 正規化後名・都市名を 100% カバーする（未訳許容リスト除く）", () => {
  const expected = expectedNames();
  const pending = new Set(PENDING_CITY_NAMES);
  const missing = [...expected].filter(
    (name) => !(name in mapping) && !pending.has(name),
  );
  assertEquals(
    missing,
    [],
    `未登録の名前が ${missing.length} 件ある（カバレッジ 100% が必須。` +
      `#222 フェーズ 2 未了の都市は data/name-ja-pending-cities.json に載せる）`,
  );
});

Deno.test("未訳許容リストは実データ由来かつ未訳の名前だけを含む（リスト陳腐化の検出）", () => {
  const expected = expectedNames();
  // 訳が付いたのにリストに残っている名前（フェーズ 2 の消し込み漏れ）
  const translated = PENDING_CITY_NAMES.filter((name) => name in mapping);
  assertEquals(
    translated,
    [],
    "訳が付いた名前が未訳許容リストに残っている（リストから外す）",
  );
  // データに存在しない名前（選定変更で消えた残骸）
  const stale = PENDING_CITY_NAMES.filter((name) => !expected.has(name));
  assertEquals(
    stale,
    [],
    "cities.json に存在しない名前が未訳許容リストに残っている",
  );
  // 重複（機械生成の破れ）
  assertEquals(
    PENDING_CITY_NAMES.length,
    new Set(PENDING_CITY_NAMES).size,
    "未訳許容リストに重複がある",
  );
});

/**
 * 現在の data/cities.json の選定には含まれないが保持する手書き都市訳（TASK-61）。
 * 都市選定はパイプライン調整（採用件数・地域下限等）で変動するため、一度
 * 書いた手書き訳は採用状況に依存せず保持できる。ここに列挙したキーは孤立キー
 * 検査の対象外とする。選定に復帰したキー（expectedNames に含まれるように
 * なったもの）は下のテストが検出するので、このリストから外して陳腐化を防ぐ。
 */
const RETAINED_CITY_NAME_JA: string[] = [
  // TASK-66 の全件採用でかつての保持キー（Antioch/Bologna/Cartagena/Gdansk/
  // Soltaniyeh/Targoviste/Wuppertal）は全て data/cities.json に復帰したため
  // 一度空になった。選定条件の変更で再び選外の手書き訳が生じたらここへ移す。
  //
  // #222 の Buringh 併合で、以下 5 都市は座標 15km の名寄せにより近傍の
  // Buringh 都市（Tournai / Wakefield / Dover / Hamilton / Merthyr Tydfil）へ
  // 吸収され選外になった（別都市だが 15km 以内で、Issue の名寄せ仕様どおり）。
  // 訳は選定に依存せず保持する。
  "Borinage",
  "Dewsbury",
  "Folkestone",
  "Motherwell",
  "Rhondda",
  // #269: Buringh の Frankenthal は Frankfurt am Main の複製行（座標・人口とも
  // 同一）で、正値が上流に無いため都市ごと除外した（BURINGH_EXCLUDED_CITY_NAMES）。
  // 訳は選定に依存せず保持する。
  "Frankenthal",
];

Deno.test("name-ja.json にデータ由来でない孤立キーが存在しない（保持リストのキーを除く）", () => {
  const expected = expectedNames();
  const retained = new Set(RETAINED_CITY_NAME_JA);
  const orphans = Object.keys(mapping).filter(
    (key) => !expected.has(key) && !retained.has(key),
  );
  assertEquals(
    orphans,
    [],
    "geojson / renames / cities に存在せず保持リストにもないキーがある",
  );
});

Deno.test("RETAINED_CITY_NAME_JA のキーは name-ja.json に存在し、かつデータ由来に復帰していない（リスト陳腐化の検出）", () => {
  const expected = expectedNames();
  const missing = RETAINED_CITY_NAME_JA.filter((key) => !(key in mapping));
  assertEquals(missing, [], "保持リストにあるが name-ja.json に訳がないキー");
  const revived = RETAINED_CITY_NAME_JA.filter((key) => expected.has(key));
  assertEquals(
    revived,
    [],
    "データ由来に復帰したキーが保持リストに残っている（リストから外す）",
  );
});
