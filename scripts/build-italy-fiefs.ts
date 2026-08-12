/**
 * イタリア（北・中部）の諸侯領・都市共和国オーバーレイ（中世 1000〜1492 年と
 * 近世初頭 1500 年、#188）を OpenHistoricalMap（OHM）から生成する
 * データパイプライン（TASK-95）。
 *
 * ## なぜ独立系統なのか（hre-fiefs の bbox / 許可リスト拡張ではなく新設した理由）
 * 1. 帰属が単一でない。フィレンツェ・ジェノヴァ・ピサ・シエナ・ルッカのコムーネは
 *    名目上イタリア王国＝帝国の構成王国内だが実質は独立、スポレート公国とアンコーナ
 *    共和国は教皇領の側、サルッツォ辺境伯領はサヴォイア／プロヴァンス圏に属する。
 *    hre_fiefs_<year>.geojson は全 feature に SUBJECTO / PARTOF = Holy Roman Empire
 *    を持たせる前提なので、そこへ混ぜると帰属の記述が壊れる。
 * 2. 除外規則の論拠が噛み合わない。hre-fiefs の freeImperialCities は帝国都市を
 *    「領邦ではなく市域だけの数十 km²」として落とすが、イタリアのコムーネは
 *    contado（周辺農村）を含み 1,000 km² 超（実測: フィレンツェ 2,346 km² /
 *    ジェノヴァ 6,364 km² / ルッカ 1,042 km²）で、同じ規則を当てると取りこぼす。
 * 3. bbox を南へ広げると帝国側の取得件数（現状 34,005 リレーション）が増え、
 *    既存 7 年分の生成物に不要な差分が出るリスクがある。
 * したがって build-france-fiefs.ts / build-hre-fiefs.ts と同じ流儀で、共通ロジック
 * （Overpass クエリ組み立て・start_date/end_date の年判定・リレーション →
 * MultiPolygon 化・くびれ解消）は import し、bbox・許可リスト・生成物だけを分ける。
 *
 * 生成物: data/italy_fiefs_<year>.geojson（year ∈ ITALY_FIEF_YEARS）。
 * properties は france_fiefs_<year>.geojson と同じ形（NAME / ADMIN_LEVEL /
 * OHM_RELATION_ID / START_DATE / END_DATE）に、表示名を上書きした場合の元名
 * OHM_NAME を足した上位集合で、後続の表示タスクが hre_fiefs / france_fiefs と
 * 同じ扱いにできる。
 *
 * 出典: OpenHistoricalMap（https://www.openhistoricalmap.org/）
 * ライセンス: CC0 1.0（パブリックドメイン）。europe_<year>.geojson（GPL-3.0 派生）
 * とも hre_<year>.geojson（CC BY-NC-SA 4.0）とも混合制約が無いが、出典管理を
 * 単純に保つため独立ファイルとして生成する。
 *
 * 決定性の担保:
 * - 取得クエリは bbox とリレーション ID（昇順・重複除去）だけで決まる
 * - feature の並びは表示名の昇順に固定する
 * - 同名リレーションの選択は有効期間の長さ → admin_level → ID で決まる
 * - 座標は RAW_FIEF_COORD_PRECISION で丸める（raw は上流精度のまま保持し、
 *   配信される派生側で COORD_PRECISION へ落とす。ADR-0037）
 *
 * ロジックは純粋関数として export しテスト対象にする
 * （scripts/build-italy-fiefs_test.ts。テストはネットワーク非依存）。
 */

import type { FeatureCollection, Position } from "geojson";
import {
  RAW_FIEF_COORD_PRECISION,
  shrinkToLimit,
  SIMPLIFY_TOLERANCES,
} from "./build-data.ts";
import {
  formatCleanStats,
  type PolygonalGeometry,
  polygonParts,
  selfIntersectionPoints,
} from "./clean-polygons.ts";
import {
  buildGeometryQuery,
  buildTagsQuery,
  type FiefBuildMetadata,
  isActiveAtYear,
  OHM_SOURCE_HOMEPAGE,
  OHM_SOURCE_LICENSE,
  OHM_SOURCE_URL,
  type OhmRelation,
  type OverpassResponse,
  parseOhmYear,
  relationGeometry,
} from "./build-france-fiefs.ts";
import { removePinchPointsFromCollection } from "./build-hre-fiefs.ts";
import { SNAPSHOT_YEARS } from "../src/config.ts";

/**
 * 取得対象の bbox（Overpass の順序: south, west, north, east）。
 * 北・中部イタリア（ピエモンテ〜ヴェネト〜トスカーナ〜ウンブリア・マルケ）を覆う。
 * この範囲の boundary=administrative は 1,353 リレーション。
 * 南限 42.0 は教皇領・シチリア王国の領域（base の europe_<year> が担う）を、
 * 北限 46.6 はアルプス以北（hre_fiefs_<year> が担う）を切る位置に置いた。
 */
export const ITALY_FIEF_BBOX: readonly [number, number, number, number] = [
  42.0,
  6.5,
  46.6,
  14.2,
];

/**
 * 中世の生成対象年。
 * 生成物の実測件数と合計面積（bbox 外パート除去・簡略化の後。球面近似で、
 * 諸侯領同士の重なりは差し引いていない）:
 * 1000 = 3 件 / 57,285 km²、1100 = 7 / 81,226、1200 = 10 / 55,530、
 * 1279 = 12 / 52,630、1300 = 14 / 39,071、1400 = 16 / 44,253、
 * 1492 = 20 / 61,467。比較として hre_fiefs_<year> は 1200 年が 26 件 /
 * 122,184 km²。
 *
 * 1000 年は 3 件（March of Tuscany 31,764 / Duchy of Spoleto 22,146 /
 * March of Montferrat 3,382）と少ないが、トスカーナ辺境伯領とスポレート公国だけで
 * 中部イタリアの大半を覆い面として成立するため収録する（france_fiefs が
 * かつての 900 年を落とした「2 件で面にならない」ケースとは異なる。900 年は
 * TASK-119 でスナップショット年自体が廃止された）。
 */
export const ITALY_FIEF_MEDIEVAL_YEARS: readonly number[] = [
  1000,
  1100,
  1200,
  1279,
  1300,
  1400,
  1492,
];

/**
 * 近世初頭の生成対象年（#188）。base（europe_<year>）が北・中部イタリアの諸邦を
 * 個別収録するのは 1530 年からで、1500 年だけは base が Holy Roman Empire
 * 一括塗りへ退行する（Roller 由来 hre_1500 も独領邦 13 件のみでイタリアを
 * 持たない）。この空白を 1492 年と同じ許可リスト系統
 * （ITALY_FIEF_EARLY_MODERN_NAMES）で埋める。
 *
 * 選抜の許可リストと除外の適用を中世と分けることで、中世 7 年代の候補選抜へ
 * 手を入れずに済み、既存生成物のバイト不変を構造的に保つ（#187 の
 * HRE_FIEF_EARLY_MODERN_YEARS と同じ方針）。
 */
export const ITALY_FIEF_EARLY_MODERN_YEARS: readonly number[] = [
  1500,
];

/** 生成対象年の全体（中世 + 近世初頭、昇順）。 */
export const ITALY_FIEF_YEARS: readonly number[] = [
  ...ITALY_FIEF_MEDIEVAL_YEARS,
  ...ITALY_FIEF_EARLY_MODERN_YEARS,
];

/**
 * 諸侯領として採用する admin_level。
 * 2 は主権国家レベル（Republic of Venice・Papal States・Kingdom of Sicily が
 * ここに入り、base の europe_<year>.geojson が担う）なので採らない。
 * 3 は Republic of Ancona / Lordship of Rimini / Lordship of Oneglia のように
 * OHM 側で上位に置かれた小勢力があるため含める（帝国構成王国 Kingdom of Burgundy・
 * Savoyard state も 3 だが許可リストと除外規則で落とす）。
 * 6 は本来 Plebis（教区）等の細分だが、March of Montferrat（アレラミチ家の
 * 辺境伯領・1000〜1708・3,382 km²）だけが公領・共和国と同格の実体を持ちながら
 * この level に置かれているため含める。level では判別できないので許可リストで採る。
 */
export const ITALY_FIEF_ADMIN_LEVELS: readonly number[] = [3, 4, 6];

/** 出力 1 ファイルあたりのサイズ上限（バイト）。既存の領邦データと同値 */
export const ITALY_FIEF_SIZE_LIMIT_BYTES = 200 * 1000;

/**
 * 収録を見送った対象の分類と根拠（AC6）。
 * bbox 内の boundary=administrative（1,353 件）から admin_level 3 / 4 / 6・
 * ITALY_FIEF_YEARS のいずれかで有効・名前ありに絞ると 40 件強が残る。そこから
 * ここに挙げる分類で落とし、許可リスト ITALY_FIEF_NAMES（27 件）にした。
 * 面積はいずれも本パイプラインのジオメトリ組み立てによる実測（球面近似）。
 */
export const ITALY_FIEF_EXCLUSIONS: Record<string, string> = {
  hreFiefOverlap:
    "hre_fiefs_<year>.geojson（TASK-85）の許可リストで収録済みの領邦" +
    "（Duchy of Milan / March of Verona / Lordship of Verona / Duchy of Bavaria / " +
    "Duchy of Swabia / Duchy of Carinthia / Duchy of Carniola / " +
    "Prince-Bishopric of Freising / Dauphiné of Viennois）。同じ土地を 2 系統で" +
    "塗らないため本系統では採らない。Milan は 1400 年が hre_fiefs 側の " +
    "Duchy of Milan で収録されており、1279 / 1300 年の Lordship of Milan は" +
    "ジオメトリが無い（ohmGeometryMissing）ので本系統でも埋められない。" +
    "hre_fiefs が存在しない 1500 年（Roller 由来 hre_1500 は独領邦 13 件のみ）に" +
    "限り、この根拠が成り立たない Duchy of Milan の除外を解除して本系統で採る" +
    "（ITALY_FIEF_EARLY_MODERN_EXEMPTIONS、#188）。",
  transalpineImperialTerritories:
    "アルプス以北・アドリア海北岸の帝国領（Margraviate of Istria 696 km² / " +
    "Triest 163 km² / Free Imperial City of Bern）。bbox の北端・東端に掛かるが" +
    "イタリアの諸侯領ではない。イストリア辺境伯領とトリエステはハプスブルク家の" +
    "支配下でイタリア王国の外、ベルンはスイス誓約同盟。",
  imperialKingdomsAndSavoy:
    "帝国の構成王国 Kingdom of Burgundy（1000〜1300 で 101,974〜114,748 km²）と " +
    "Savoyard state（1388〜1536 で 35,989〜40,322 km²）は admin_level 3 で、" +
    "配下の Marquisate of Saluzzo・County of Asti 等と領域が重なるため採らない" +
    "（hre_fiefs の imperialKingdoms と同じ扱い）。",
  kingdomOfSicilyProvinces:
    "シチリア（ナポリ）王国の州 Aprutium beyond the Pescara 9,622 km² / " +
    "Aprutium this side of the Pescara 3,390 km²（アブルッツォ）。bbox の南東端に" +
    "掛かるが、南イタリアは主権国家として base の europe_<year> が担う。",
  franceAndProvence:
    "Provence（1487 年以降・23,215 km²）。bbox の西端に掛かるがイタリアの" +
    "諸侯領ではなく、フランス王国側の領域。",
  microStates:
    "面積 100 km² 未満で簡略化すると点に近くなる領域（San Marino 7〜22 km² と" +
    "その castelli（City of San Marino / Acquaviva / Chiesanuova / Domagnano / " +
    "Faetano / Fiorentino / Mercatale / Montegiardino / Serravalle）/ " +
    "County of Vernio 12 km² / Republic of Noli 58 km² / " +
    "County of Novellara and Bagnolo 50 km²）。" +
    "収録した最小は County of Guastalla 133 km² で、100 km² を採否の境目にした" +
    "（hre_fiefs が「点に近い領域」を落とした判断と同じ基準）。",
  ohmDateErrors:
    "Golden Ambrosian Republic（史実は 1447〜1450 のミラノ市共和国）が OHM では " +
    "1449〜1500 になっており 1492 / 1500 年でも有効判定になる。hre_fiefs と" +
    "同じく OHM 側の end_date 誤りと判断して落とす（結果として 1492 年のミラノは" +
    "空白。1500 年は rel 2800654 の Duchy of Milan（1500〜1512）が埋める。#188）。",
  imperialCircles:
    "帝国クライス（1500 年の帝国改革で設けられた帝国の管区。Bavarian Circle / " +
    "Upper Rhenish Circle、いずれも 1500 年開始の admin_level 3）。領邦ではなく" +
    "領邦を束ねる行政区分で、面としては配下の諸邦と全面的に重なる。",
  ohmGeometryMissing:
    "メンバーが label ノードだけでジオメトリを組めないリレーション" +
    "（Lordship of Milan 1259〜1349 / Pisan Corsica 1050〜1284）。面が作れないので" +
    "採っても feature にならない。1279 / 1300 年のミラノが空白になる既知の制限。",
  islandsCoveredByParent:
    "親リレーションに同じ面が含まれる島（Genoese Corsica / Milanese Corsica、" +
    "いずれも 11,502 km²）。Republic of Genoa の年代スナップショットは" +
    "コルシカのパートを含むため、別 feature として採ると二重塗りになる。",
};

/**
 * 名前で明示的に落とす対象（OHM の名前 → ITALY_FIEF_EXCLUSIONS のキー）。
 * 実測で挙がった候補のうち、パターンで落とせない個別事例をここに置く。
 */
export const ITALY_FIEF_EXCLUDED_NAMES: Record<string, string> = {
  "Acquaviva": "microStates",
  "Aprutium beyond the Pescara": "kingdomOfSicilyProvinces",
  "Aprutium this side of the Pescara": "kingdomOfSicilyProvinces",
  "Bavarian Circle": "imperialCircles",
  "Chiesanuova": "microStates",
  "City of San Marino": "microStates",
  "County of Novellara and Bagnolo": "microStates",
  "County of Vernio": "microStates",
  "Dauphiné of Viennois": "hreFiefOverlap",
  "Domagnano": "microStates",
  "Duchy of Bavaria": "hreFiefOverlap",
  "Duchy of Carinthia": "hreFiefOverlap",
  "Duchy of Carniola": "hreFiefOverlap",
  "Duchy of Milan": "hreFiefOverlap",
  "Duchy of Swabia": "hreFiefOverlap",
  "Faetano": "microStates",
  "Fiorentino": "microStates",
  "Free Imperial City of Bern": "transalpineImperialTerritories",
  "Genoese Corsica": "islandsCoveredByParent",
  "Golden Ambrosian Republic": "ohmDateErrors",
  "Kingdom of Burgundy": "imperialKingdomsAndSavoy",
  "Lordship of Milan": "ohmGeometryMissing",
  "Lordship of Verona": "hreFiefOverlap",
  "March of Verona": "hreFiefOverlap",
  "Margraviate of Istria": "transalpineImperialTerritories",
  "Mercatale": "microStates",
  "Milanese Corsica": "islandsCoveredByParent",
  "Montegiardino": "microStates",
  "Pisan Corsica": "ohmGeometryMissing",
  "Prince-Bishopric of Freising": "hreFiefOverlap",
  "Provence": "franceAndProvence",
  "Republic of Noli": "microStates",
  "San Marino": "microStates",
  "Savoyard state": "imperialKingdomsAndSavoy",
  "Serravalle": "microStates",
  "Triest": "transalpineImperialTerritories",
  "Upper Rhenish Circle": "imperialCircles",
};

/**
 * 近世初頭（1500 年）に限り除外を解除する対象（OHM の名前、#188）。
 * Duchy of Milan の除外根拠 hreFiefOverlap（hre_fiefs 側で収録済み）は、
 * hre_fiefs が存在しない 1500 年には成り立たない（1500 年の hre-powers は
 * Roller 由来 hre_1500 で、収録は独領邦 13 件のみ）。1500 年のミラノは
 * rel 2800654（1500〜1512。1499 年にミラノを征服したフランス王権下の公国）が
 * OHM に実在するため、本系統で採って base の Holy Roman Empire 一括塗りへの
 * 退行を防ぐ。
 */
export const ITALY_FIEF_EARLY_MODERN_EXEMPTIONS: readonly string[] = [
  "Duchy of Milan",
];

/**
 * イタリア諸侯領として収録しない対象なら、その根拠を返す（純粋関数）。収録するなら null。
 * 許可リスト ITALY_FIEF_NAMES とは独立に適用する二重の防波堤で、将来の許可リスト
 * 編集で帝国側の領邦や南イタリアの州が紛れ込んでも生成物に入らないようにする
 * （scripts/build-hre-fiefs.ts の hreFiefExclusionReason と同じ方針）。
 * 期間つき曖昧性解消（"Savoyard state (1388-1401)" 等）は表示名で判定するので、
 * 除外リストには期間を外した名前を置く。
 *
 * #188: year を渡すと年で除外根拠が変わる対象を判定できる。近世初頭
 * （ITALY_FIEF_EARLY_MODERN_YEARS）は ITALY_FIEF_EARLY_MODERN_EXEMPTIONS の
 * 対象（Duchy of Milan）だけ除外を解除する。year 省略時は従来どおり全除外を
 * 適用する（中世 7 年代の判定は year の有無で変わらない）。
 */
export function italyFiefExclusionReason(
  name: string,
  year?: number,
): string | null {
  const display = italyFiefDisplayName(name);
  if (
    year !== undefined && ITALY_FIEF_EARLY_MODERN_YEARS.includes(year) &&
    ITALY_FIEF_EARLY_MODERN_EXEMPTIONS.includes(display)
  ) {
    return null;
  }
  for (const candidate of [name, display]) {
    const explicit = ITALY_FIEF_EXCLUDED_NAMES[candidate];
    if (explicit !== undefined) return ITALY_FIEF_EXCLUSIONS[explicit];
  }
  if (display.startsWith("Free Imperial City of ")) {
    return ITALY_FIEF_EXCLUSIONS.transalpineImperialTerritories;
  }
  return null;
}

/**
 * 採用する諸侯領の名前（OHM の name:en。無ければ name）許可リスト（昇順・27 件）。
 * ITALY_FIEF_EXCLUSIONS の分類で落とした残りで、全 27 件が ITALY_FIEF_YEARS の
 * いずれかの生成物に実際に現れる。括弧内は実測面積（bbox 外パート除去後・
 * 簡略化前・球面近似）と OHM 上の有効期間。
 *
 * 都市共和国（コムーネ）: Republic of Florence 2,346 km²（1115〜1405）/
 * Republic of Genoa 6,143〜6,422（1099〜1540 の年代別リレーション）/
 * Republic of Pisa 3,918〜16,184（1050〜1406）/ Republic of Siena 422〜7,588 /
 * Republic of Lucca 1,042 / Republic of Ancona 626 / Republic of Massa 387。
 * 帝国都市を落とす hre_fiefs の論拠（市域だけの数十 km²）は、contado を含む
 * これらのコムーネには当てはまらない。
 *
 * 世俗領邦: Duchy of Spoleto 22,146（0831〜1201）/ March of Tuscany 31,764
 * （0988〜1115）/ March of Montferrat 3,382（1000〜1708）/ Marquisate of Saluzzo
 * 2,304 / County of Asti 778 / Margraviate of Mantua 2,128 / Lordship of Rimini
 * 2,456 / Lordship of Piombino 1,507 / Lordship of Oneglia 270 /
 * Principality of Oneglia 270 / Lordship of Lucca 1,042。
 *
 * 近世初頭（1492 年）の公領・伯領: Duchy of Florence 12,773
 * （rel 2800633。表示は Republic of Florence に上書きする。
 * ITALY_FIEF_DISPLAY_NAME_OVERRIDES を参照）/
 * Duchy of Modena and Reggio 4,624 / Duchy of Ferrara 3,244 /
 * Duchy of Massa and Carrara 212 / Duchy of Mirandola 201 /
 * County of Sovana 300 / County of Santa Fiora 185 / County of Pitigliano 149 /
 * County of Guastalla 133。
 *
 * OHM に無く収録できない主要勢力: ミラノ（1279 / 1300 の Lordship of Milan は
 * ジオメトリ無し、1492 は end_date 誤りの Golden Ambrosian Republic のみ。
 * 1500 は rel 2800654 があり ITALY_FIEF_EARLY_MODERN_NAMES で採る）・
 * ヴェネツィア（admin_level 2 で base 側）・ボローニャ・パドヴァ・
 * ウルビーノ公領。詳細は docs/data-inventory/README.md を参照。
 */
export const ITALY_FIEF_NAMES: readonly string[] = [
  "County of Asti",
  "County of Guastalla",
  "County of Pitigliano",
  "County of Santa Fiora",
  "County of Sovana",
  "Duchy of Ferrara (1471-1597)",
  "Duchy of Florence",
  "Duchy of Massa and Carrara",
  "Duchy of Mirandola",
  "Duchy of Modena and Reggio",
  "Duchy of Spoleto",
  "Lordship of Lucca",
  "Lordship of Oneglia (1298-1488)",
  "Lordship of Piombino",
  "Lordship of Rimini",
  "March of Montferrat",
  "March of Tuscany",
  "Margraviate of Mantua",
  "Marquisate of Saluzzo",
  "Principality of Oneglia (1488-1576)",
  "Republic of Ancona",
  "Republic of Florence",
  "Republic of Genoa",
  "Republic of Lucca",
  "Republic of Massa",
  "Republic of Pisa (1399-1406)",
  "Republic of Siena",
];

/**
 * 近世初頭（1500 年）に採用する諸侯領の名前許可リスト（昇順・21 件、#188）。
 *
 * OHM 実測（bbox 内 1,353 リレーションのうち admin_level 3 / 4 / 6・名前あり・
 * 1500 年に有効 = 59 件）で確定した結果、1492 年の生成物 20 件の元リレーションは
 * 全て 1500 年にも有効（最短の存続は Lordship of Rimini の 1295〜1500 で、
 * end_date は年単位の包含判定により 1500 年を含む。史実でも Malatesta 家の
 * リミニは 1500 年のチェーザレ・ボルジアの征服まで存続）。そこへ 1500 年開始の
 * Duchy of Milan（rel 2800654、1500〜1512）を加えた 21 件を採る。
 *
 * 21 件以外で 1500 年に有効な候補は、既存の除外分類（帝国クライス・
 * サンマリノの castelli・Savoyard state・Golden Ambrosian Republic 等）で落ちる
 * （ITALY_FIEF_EXCLUSIONS / ITALY_FIEF_EXCLUDED_NAMES を参照）。
 *
 * 中世の許可リスト ITALY_FIEF_NAMES と分けるのは、中世 7 年代の候補選抜に
 * 手を入れず既存生成物のバイト不変を保つため（#187 の
 * HRE_FIEF_EARLY_MODERN_NAMES と同じ方針）。
 */
export const ITALY_FIEF_EARLY_MODERN_NAMES: readonly string[] = [
  "County of Asti",
  "County of Guastalla",
  "County of Pitigliano",
  "County of Santa Fiora",
  "County of Sovana",
  "Duchy of Ferrara (1471-1597)",
  "Duchy of Florence",
  "Duchy of Massa and Carrara",
  "Duchy of Milan",
  "Duchy of Mirandola",
  "Duchy of Modena and Reggio",
  "Lordship of Piombino",
  "Lordship of Rimini",
  "March of Montferrat",
  "Margraviate of Mantua",
  "Marquisate of Saluzzo",
  "Principality of Oneglia (1488-1576)",
  "Republic of Ancona",
  "Republic of Genoa",
  "Republic of Lucca",
  "Republic of Siena",
];

/**
 * year の選抜に使う許可リストを返す（純粋関数、#188）。
 * 中世 7 年代は従来の ITALY_FIEF_NAMES のまま（生成物のバイト不変を保つ）、
 * 近世初頭（1500 年）は ITALY_FIEF_EARLY_MODERN_NAMES。
 */
export function italyFiefNamesForYear(year: number): readonly string[] {
  return ITALY_FIEF_EARLY_MODERN_YEARS.includes(year)
    ? ITALY_FIEF_EARLY_MODERN_NAMES
    : ITALY_FIEF_NAMES;
}

/**
 * 表示名の上書き（OHM の名前 → 表示名。AC4）。
 * OHM のイタリア系リレーションには name:en に期間の曖昧性解消が入ったものがあり、
 * そのままでは表示名に使えない。とくに "Republic of Pisa (1399-1406)" は
 * 1050〜1406 の全 5 リレーションが同じこの名前を持っており、括弧内の期間は
 * どのリレーションの実際の期間とも一致しない（OHM 側の誤り）。
 * hre_fiefs は同種の "County of Ratzeburg (1143-1204)" を unusableNames として
 * 落としたが、本系統では中核勢力なので落とさず表示名を上書きする。
 * italyFiefDisplayName が末尾の "(開始-終了)" を機械的に外すため、この表は
 * 「意図した上書きだ」という記録を兼ねる。
 *
 * #188: "Duchy of Florence" は OHM の rel 2800633（1406〜1555）が存続期間全体に
 * 後年の公国名を与えた時代錯誤で、フィレンツェ公国の成立は 1532 年
 * （アレッサンドロ・デ・メディチの世襲公位）。本パイプラインがこのリレーションを
 * 使う年は 1492 / 1500 のみで、いずれも共和政期にあたるため史実名
 * "Republic of Florence" へ上書きする。中世（1200〜1400 年）の
 * Republic of Florence（rel 2800634、1115〜1405）とは期間が重ならないので、
 * 同一年に表示名が衝突することはない。OHM_NAME に元名が残るため出典への追跡は
 * 保たれる。
 */
export const ITALY_FIEF_DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  "Duchy of Ferrara (1471-1597)": "Duchy of Ferrara",
  "Duchy of Florence": "Republic of Florence",
  "Lordship of Oneglia (1298-1488)": "Lordship of Oneglia",
  "Principality of Oneglia (1488-1576)": "Principality of Oneglia",
  "Republic of Pisa (1399-1406)": "Republic of Pisa",
};

/** 末尾の期間つき曖昧性解消（例: " (1399-1406)"）にマッチする */
const PERIOD_SUFFIX = /\s*\(\d{3,4}-\d{3,4}\)$/;

/**
 * OHM の名前から表示名を求める（純粋関数。AC4）。
 * ITALY_FIEF_DISPLAY_NAME_OVERRIDES にあればそれを、無ければ末尾の期間つき
 * 曖昧性解消を外した名前を返す。"Electorate of Saxony(-Wittenberg)" のような
 * 期間でない括弧はそのまま残す。
 */
export function italyFiefDisplayName(name: string): string {
  const override = ITALY_FIEF_DISPLAY_NAME_OVERRIDES[name];
  if (override !== undefined) return override;
  return name.replace(PERIOD_SUFFIX, "");
}

/**
 * リレーションのタグから名前を取り出す（純粋関数）。
 * name:en を優先し、無ければ name を使う。OHM のイタリア系には name:en を持たず
 * name が英語のリレーションがあり（County of Asti / Republic of Ancona /
 * 1350〜1555 の Republic of Siena / Republic of Noli など）、name:en だけを見ると
 * 主要勢力を取りこぼす。英語以外の name（Repùbrica de Zêna 等）は許可リストに
 * 載らないので採用されない。
 */
export function relationName(
  tags: Record<string, string> | undefined,
): string | null {
  const name = tags?.["name:en"] ?? tags?.["name"];
  return typeof name === "string" && name.length > 0 ? name : null;
}

/** OHM の有効期間の長さ（年）。start / end 欠損は幅が最大になるよう扱う */
function activeSpan(tags: Record<string, string>): number {
  const start = parseOhmYear(tags["start_date"]) ?? 0;
  const end = parseOhmYear(tags["end_date"]) ?? 9999;
  return end - start;
}

/**
 * year 時点で有効なイタリア諸侯領のリレーションを選ぶ（純粋関数）。
 * 許可リスト（OHM の名前）・admin_level・除外規則で絞り、表示名が同じものが
 * 複数あれば 1 件に絞る。返り値は表示名の昇順で、入力順に依存しない。
 *
 * ## 同名リレーションの選択規則とその根拠（AC3）
 * OHM は 1 つの勢力について「存続期間全体を覆う包括リレーション」と
 * 「年代ごとの領域スナップショット」を並存させることがあり、Republic of Pisa は
 * 5 件すべてが同じ name:en・同じ admin_level 4 で並ぶ:
 * - 2750719（1081〜1406）本土のみ 4,577 km²
 * - 2853300（1050〜1115）本土 + コルシカ 16,184 km²
 * - 2853298（1184〜1207）本土 + コルシカ 16,184 km²
 * - 2853293（1215〜1295）本土 + サルデーニャ 32,298 km²
 * - 2853296（1295〜1324）本土 + サルデーニャ 20,796 km²
 * - 2853485（1399〜1406）本土のみ 3,552 km²
 * 既存の selectFiefsForYear / selectHreFiefsForYear は「admin_level 昇順 → ID 昇順」
 * で絞るが、この 6 件は同 level なので ID の若い 2750719 が偶然に選ばれ、
 * どの年代でも同じ本土のみの形になってしまう。
 *
 * そこで**有効期間が短いリレーションを優先する**（同じなら admin_level 昇順 →
 * ID 昇順）。根拠は、期間の短い方がその年代に固有のスナップショットであり、
 * 長い方は存続期間を通じて変わらない中核領域しか持たないため年代精度が落ちること。
 * 実際この規則は、1100 / 1200 年にコルシカを含み（ピサがコルシカを支配した時期）、
 * 1279 / 1300 年にサルデーニャを含み、メロリアの海戦後の 1400 年には本土のみに
 * 戻る、という史実の推移を再現する。
 * なお bbox の外に出るパート（サルデーニャ・ジェノヴァの黒海／エーゲ海植民地）は
 * restrictPartsToBbox で落とすので、生成物にはイタリア本土とコルシカだけが残る。
 */
export function selectItalyFiefsForYear(
  elements: readonly OhmRelation[],
  year: number,
  names: readonly string[] = italyFiefNamesForYear(year),
  adminLevels: readonly number[] = ITALY_FIEF_ADMIN_LEVELS,
): OhmRelation[] {
  const allowed = new Set(names);
  const levels = new Set(adminLevels);
  const candidates = elements.filter((element) => {
    const tags = element.tags ?? {};
    const name = relationName(tags);
    if (name === null || !allowed.has(name)) return false;
    if (italyFiefExclusionReason(name, year) !== null) return false;
    const level = Number.parseInt(tags["admin_level"] ?? "", 10);
    if (!Number.isInteger(level) || !levels.has(level)) return false;
    return isActiveAtYear(tags["start_date"], tags["end_date"], year);
  });
  candidates.sort((a, b) => {
    const nameDiff = italyFiefDisplayName(relationName(a.tags) as string)
      .localeCompare(
        italyFiefDisplayName(relationName(b.tags) as string),
        "en",
      );
    if (nameDiff !== 0) return nameDiff;
    const spanDiff = activeSpan(a.tags) - activeSpan(b.tags);
    if (spanDiff !== 0) return spanDiff;
    const levelDiff = Number.parseInt(a.tags["admin_level"], 10) -
      Number.parseInt(b.tags["admin_level"], 10);
    if (levelDiff !== 0) return levelDiff;
    return a.id - b.id;
  });
  const seen = new Set<string>();
  return candidates.filter((element) => {
    const name = italyFiefDisplayName(relationName(element.tags) as string);
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

/** restrictPartsToBbox の結果 */
export interface BboxRestriction {
  /** bbox に掛かるパートだけを残したジオメトリ。1 つも残らなければ null */
  geometry: PolygonalGeometry | null;
  /** 落としたパートの数 */
  droppedParts: number;
}

/**
 * bbox に一切掛からないパートを落とす（純粋関数）。
 *
 * 海洋共和国のリレーションはイタリア半島の外に飛び地を持つ。実データでは
 * Republic of Genoa の黒海（カッファ 908 km² / 2,463 km²・東経 34〜37 度）と
 * エーゲ海（キオス 1,603 km² 他・東経 26 度）の植民地、Republic of Genoa /
 * Republic of Pisa のサルデーニャ（北緯 38.8〜41.3 度）が該当する。これらは
 * 「北・中部イタリアの諸侯領オーバーレイ」の対象外で、残すと地図上に脈絡のない
 * 塗りが現れるうえ、ファイルサイズ上限を頂点数で圧迫する。
 *
 * 判定はパートの外環のバウンディングボックスと ITALY_FIEF_BBOX の交差で行い、
 * 一部でも掛かるパートは残す（コルシカは北緯 41.3〜43.0 度で南限 42.0 に掛かる
 * ため残り、ピサ・ジェノヴァのコルシカ支配が表現される）。クリップはしないので
 * 形は変えず、境界付近のパートが欠けることもない。
 * 落とすパートが無ければ入力をそのまま（同一参照で）返す。
 */
export function restrictPartsToBbox(
  geometry: PolygonalGeometry,
  bbox: readonly [number, number, number, number] = ITALY_FIEF_BBOX,
): BboxRestriction {
  const [south, west, north, east] = bbox;
  const parts = polygonParts(geometry);
  const kept: Position[][][] = parts.filter((part) => {
    const lons = part[0].map((point) => point[0]);
    const lats = part[0].map((point) => point[1]);
    return Math.max(...lons) >= west && Math.min(...lons) <= east &&
      Math.max(...lats) >= south && Math.min(...lats) <= north;
  });
  const droppedParts = parts.length - kept.length;
  if (droppedParts === 0) return { geometry, droppedParts };
  if (kept.length === 0) return { geometry: null, droppedParts };
  return {
    geometry: kept.length === 1
      ? { type: "Polygon", coordinates: kept[0] }
      : { type: "MultiPolygon", coordinates: kept },
    droppedParts,
  };
}

/** 生成物に埋め込むビルドメタデータ */
export interface ItalyFiefBuildMetadata extends FiefBuildMetadata {
  /** bbox 外で落としたパート数（リレーション ID → 件数） */
  droppedPartsOutsideBbox: Record<string, number>;
}

/** buildYearCollection の結果 */
export interface ItalyFiefYearCollection {
  fc: FeatureCollection;
  metadata: ItalyFiefBuildMetadata;
}

/**
 * year 時点のイタリア諸侯領 FeatureCollection とメタデータを組み立てる（純粋関数）。
 * tagged は tags クエリの全リレーション、geometries は geom クエリの結果
 * （リレーション ID → メンバー付きリレーション）。
 * properties は france_fiefs_<year>.geojson と同じ形に、表示名を上書きした場合の
 * 元名 OHM_NAME を足した上位集合。feature の並びは表示名の昇順で決定的。
 */
export function buildYearCollection(
  tagged: readonly OhmRelation[],
  geometries: ReadonlyMap<number, OhmRelation>,
  year: number,
  names: readonly string[] = italyFiefNamesForYear(year),
): ItalyFiefYearCollection {
  const selected = selectItalyFiefsForYear(tagged, year, names);
  const features: FeatureCollection["features"] = [];
  const missingWays: Record<string, number[]> = {};
  const unclosedRings: Record<string, number> = {};
  const droppedInnerRings: Record<string, number> = {};
  const droppedPartsOutsideBbox: Record<string, number> = {};
  const relationsWithoutGeometry: number[] = [];
  for (const element of selected) {
    const withGeometry = geometries.get(element.id);
    const result = withGeometry === undefined
      ? null
      : relationGeometry(withGeometry);
    const restricted = result === null || result.geometry === null
      ? null
      : restrictPartsToBbox(result.geometry);
    if (
      result === null || restricted === null || restricted.geometry === null
    ) {
      relationsWithoutGeometry.push(element.id);
      continue;
    }
    const key = String(element.id);
    if (result.missingWays.length > 0) missingWays[key] = result.missingWays;
    if (result.unclosedRings > 0) unclosedRings[key] = result.unclosedRings;
    if (result.droppedInnerRings > 0) {
      droppedInnerRings[key] = result.droppedInnerRings;
    }
    if (restricted.droppedParts > 0) {
      droppedPartsOutsideBbox[key] = restricted.droppedParts;
    }
    const ohmName = relationName(element.tags) as string;
    features.push({
      type: "Feature",
      properties: {
        NAME: italyFiefDisplayName(ohmName),
        OHM_NAME: ohmName,
        ADMIN_LEVEL: Number.parseInt(element.tags["admin_level"], 10),
        OHM_RELATION_ID: element.id,
        START_DATE: element.tags["start_date"] ?? null,
        END_DATE: element.tags["end_date"] ?? null,
      },
      geometry: restricted.geometry,
    });
  }
  relationsWithoutGeometry.sort((a, b) => a - b);
  return {
    fc: { type: "FeatureCollection", features },
    metadata: {
      source: "OpenHistoricalMap",
      sourceUrl: OHM_SOURCE_HOMEPAGE,
      license: OHM_SOURCE_LICENSE,
      year,
      featureCount: features.length,
      missingWays,
      unclosedRings,
      droppedInnerRings,
      droppedPartsOutsideBbox,
      relationsWithoutGeometry,
    },
  };
}

/** Overpass の連続クエリの間に空ける待ち時間（ミリ秒）。レート制限対策 */
const OVERPASS_COOLDOWN_MS = 5_000;

/** Overpass に Overpass QL を POST して JSON を得る（429 / 504 は指数後退で再試行） */
async function runOverpass(
  query: string,
  attempts = 4,
): Promise<OverpassResponse> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await fetch(OHM_SOURCE_URL, {
      method: "POST",
      body: new URLSearchParams({ data: query }),
    });
    if (res.ok) return await res.json() as OverpassResponse;
    await res.body?.cancel();
    const retryable = res.status === 429 || res.status === 504;
    if (!retryable || attempt === attempts) {
      throw new Error(
        `Overpass への問い合わせに失敗しました (status ${res.status})`,
      );
    }
    const waitMs = OVERPASS_COOLDOWN_MS * 2 ** (attempt - 1);
    console.warn(`  Overpass ${res.status}: ${waitMs} ms 待って再試行します`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  throw new Error("到達しない");
}

/**
 * CLI 引数から生成対象年を決める（純粋関数、#188）。
 * 引数なしなら全対象年（従来どおり）。年を並べる（例: `1492 1500`）と
 * その年だけを生成・書き込みし、他の年の生成物へ一切触れない。
 * 既存年の生成物のバイト不変を「再生成しない」ことで構造的に保証するための
 * 仕組みで、対象年に無い年の指定はエラーにする。
 */
export function parseTargetYears(args: readonly string[]): number[] {
  if (args.length === 0) return [...ITALY_FIEF_YEARS];
  const years = args.map((arg) => Number.parseInt(arg, 10));
  for (const year of years) {
    if (!ITALY_FIEF_YEARS.includes(year)) {
      throw new Error(`${year} は ITALY_FIEF_YEARS に含まれない年です`);
    }
  }
  return [...new Set(years)].sort((a, b) => a - b);
}

async function main(): Promise<void> {
  for (const year of ITALY_FIEF_YEARS) {
    if (!SNAPSHOT_YEARS.includes(year)) {
      throw new Error(`${year} は SNAPSHOT_YEARS に含まれない年です`);
    }
  }
  const targetYears = parseTargetYears(Deno.args);
  console.log(`target years: ${targetYears.join(", ")}`);
  // 1 段目: bbox 内の boundary=administrative を tags のみ取得（約 1,350 件）
  const tagged = (await runOverpass(buildTagsQuery(ITALY_FIEF_BBOX))).elements;
  console.log(`tags: ${tagged.length} relations`);

  // 2 段目: 対象年で必要になるリレーションのジオメトリだけをまとめて 1 回取得
  const ids = new Set<number>();
  for (const year of targetYears) {
    for (const element of selectItalyFiefsForYear(tagged, year)) {
      ids.add(element.id);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, OVERPASS_COOLDOWN_MS));
  const geomElements =
    (await runOverpass(buildGeometryQuery([...ids]))).elements;
  const geometries = new Map(geomElements.map((e) => [e.id, e]));
  console.log(`geom: ${geometries.size}/${ids.size} relations`);

  for (const year of targetYears) {
    const { fc, metadata } = buildYearCollection(tagged, geometries, year);
    const { fc: shrunk, tolerance, cleanStats } = shrinkToLimit(
      fc,
      ITALY_FIEF_SIZE_LIMIT_BYTES,
      SIMPLIFY_TOLERANCES,
      // raw は上流精度のまま保持する（丸めは配信される派生側で行う。ADR-0037）
      RAW_FIEF_COORD_PRECISION,
    );
    // 座標丸めで生じた「くびれ」を解消する（build-hre-fiefs.ts と同じ理由で、
    // data/ 全体の「自己交差ゼロ」不変条件を満たすのに必要）
    const { fc: unpinched, removed, droppedFeatures } =
      removePinchPointsFromCollection(shrunk);
    // メタデータは simplify / truncate の後に付け直す（欠損を生成物に記録）
    const output = { ...unpinched, metadata };
    const outPath = `data/italy_fiefs_${year}.geojson`;
    const json = JSON.stringify(output);
    // 上限判定は UTF-8 のバイト数で行う（領邦名に é 等の多バイト文字がある）
    const finalBytes = new TextEncoder().encode(json).length;
    if (finalBytes > ITALY_FIEF_SIZE_LIMIT_BYTES) {
      throw new Error(`${outPath} が上限を超えました (${finalBytes} バイト)`);
    }
    const residual = unpinched.features.filter((feature) =>
      (feature.geometry.type === "Polygon" ||
        feature.geometry.type === "MultiPolygon") &&
      selfIntersectionPoints(feature.geometry).length > 0
    ).map((feature) => String(feature.properties?.NAME));
    if (residual.length > 0) {
      throw new Error(
        `${outPath} に自己交差が残りました: ${residual.join(", ")}`,
      );
    }

    await Deno.writeTextFile(outPath, json);
    console.log(
      `${outPath}: ${finalBytes} bytes, tolerance=${tolerance}, features=${unpinched.features.length}`,
    );
    console.log(
      `  ${
        unpinched.features.map((f) => String(f.properties?.NAME)).join(" / ")
      }`,
    );
    if (removed > 0) {
      console.log(`  くびれを解消: 重複頂点 ${removed} 個を除去`);
    }
    if (droppedFeatures.length > 0) {
      console.warn(`  面が残らず除外: ${droppedFeatures.join(", ")}`);
    }
    const cleanLog = formatCleanStats(cleanStats);
    if (cleanLog !== null) console.log(`  ${cleanLog.trim()}（くびれ解消前）`);
    const warnings = [
      ...Object.entries(metadata.missingWays).map(([id, ways]) =>
        `  欠損 way: relation ${id} -> ${ways.join(",")}`
      ),
      ...Object.entries(metadata.unclosedRings).map(([id, count]) =>
        `  強制クローズしたリング: relation ${id} -> ${count}`
      ),
      ...Object.entries(metadata.droppedInnerRings).map(([id, count]) =>
        `  破棄した内環: relation ${id} -> ${count}`
      ),
      ...Object.entries(metadata.droppedPartsOutsideBbox).map(([id, count]) =>
        `  bbox 外で落としたパート: relation ${id} -> ${count}`
      ),
      ...(metadata.relationsWithoutGeometry.length > 0
        ? [`  ジオメトリ未取得: ${metadata.relationsWithoutGeometry.join(",")}`]
        : []),
    ];
    for (const warning of warnings) console.warn(warning);
  }
}

if (import.meta.main) {
  await main();
}
