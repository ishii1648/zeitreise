/**
 * Cliopatria（Seshat Global History Databank・CC BY 4.0）由来の諸侯領・領邦
 * オーバーレイのデータパイプライン（TASK-110 / decision-26）。
 *
 * ## 何のために足すのか
 * OHM（CC0）由来の諸侯領には年代・地域による大きな欠落がある。1000/1100 年の
 * フランスはアキテーヌ公領もトゥールーズ伯領も王領も収録が無く王国が一枚岩に
 * なり、1279〜1492 年の帝国はバイエルン公領が一度も表示されない。TASK-88 は
 * 現代県ポリゴンの union でこれを埋める案を却下し（decision-18）、「空白を埋める
 * 唯一の整合的な道は出典のあるデータの獲得」と記録した。本スクリプトがその道で、
 * **OHM が持っていない領邦だけ**を Cliopatria から補う。
 *
 * ## decision-14 / decision-18 との関係
 * 両 decision が禁じるのは「出典を持たない座標の合成」である。本パイプラインは
 * Cliopatria の座標をそのまま採り、頂点を 1 つも作らない・混ぜない・合成しない。
 * 選別は年代区間の包含判定（FromYear <= year <= ToYear）と静的な許可リストだけで
 * 決まり、県 union のように「どれを選ぶか」で形状が変わる余地が無い。
 *
 * ## 出典とピン留め
 * - Bennett, J., Mutch, E., Chalstrey, E. et al. (2025) "Cliopatria: A geospatial
 *   database of world-wide political entities from 3400BCE to 2024CE",
 *   Scientific Data. DOI 10.5281/zenodo.14714684
 * - 取得は GitHub のコミット SHA でピン留めした raw URL（CLIOPATRIA_ARCHIVE_URL）。
 *   Zenodo の DOI は「全バージョン」を指す concept DOI でバイト列を固定できない
 *   ため、再現性はコミット SHA + アーカイブの SHA-256 で担保し、DOI は帰属表示
 *   （CC BY 4.0）と引用のために保持する。
 * - 由来と限界: 2014 年に手描きされた歴史地図画像群を自動抽出し 0.07 度
 *   （約 7.8 km）で平滑化したもの。論文自身が「境界は必然的に概略で解釈の余地が
 *   ある」と明記している。頂点密度は OHM の 1/4〜1/7（1000 年の Duchy of
 *   Aquitaine は 69 頂点、OHM の 1200 年版は 330 頂点）。
 *
 * ## 出力
 * - data/cliopatria_fiefs_<year>.geojson（year ∈ CLIOPATRIA_FIEF_YEARS）
 *   … 派生（scripts/build-fief-flat.ts）の入力。dist には含めない。
 * アプリが配信・描画するのは重なりを排他化した
 * data/cliopatria_fiefs_flat_<year>.geojson の方。
 *
 * ## 決定性の担保
 * - 取得はコミット SHA 固定の URL で、アーカイブの SHA-256 を検証してから使う
 * - 年の選択は包含判定のみ。区間外の年へ寄せる救済（最近傍・外挿）はしない
 * - feature の並びは NAME 昇順に固定し、座標は RAW_FIEF_COORD_PRECISION
 *   （raw は上流精度のまま保持する。丸めは配信される派生側で行う。ADR-0037）
 *   へ丸める
 *
 * ロジックは純粋関数として export しテスト対象にする
 * （scripts/build-cliopatria-fiefs_test.ts。テストはネットワーク非依存）。
 *
 * 実行: deno task build-cliopatria-fiefs
 * 実行後に `deno task build-fief-flat` → `deno task build-fief-dedupe` →
 * `deno task build-colors` → `deno task build-attribution` を流すこと。
 */

import type {
  Feature,
  FeatureCollection,
  MultiPolygon,
  Polygon,
} from "geojson";
import truncate from "@turf/truncate";
import { RAW_FIEF_COORD_PRECISION } from "./build-data.ts";
import { cleanFeatureCollection, formatCleanStats } from "./clean-polygons.ts";

/** 配布元リポジトリ（GitHub） */
export const CLIOPATRIA_SOURCE_REPO =
  "Seshat-Global-History-Databank/cliopatria";

/**
 * ピン留めコミット（v0.2.0、2026-05-16）。データを更新するときはここと
 * CLIOPATRIA_ARCHIVE_SHA256 を同時に更新し、生成物を作り直す。
 */
export const CLIOPATRIA_SOURCE_COMMIT =
  "ad28a691b7c07c1fca89d0e0636d324667d2a258";

/** ライセンス識別子（パネル・フッターにこの値をそのまま出す） */
export const CLIOPATRIA_SOURCE_LICENSE = "CC BY 4.0";

/** 引用用の DOI（Zenodo の concept DOI。全バージョンを指す） */
export const CLIOPATRIA_SOURCE_DOI = "10.5281/zenodo.14714684";

/** CC BY 4.0 の帰属表示に使う書誌情報 */
export const CLIOPATRIA_SOURCE_CITATION =
  "Bennett, J., Mutch, E., Chalstrey, E. et al. (2025) " +
  "Cliopatria: A geospatial database of world-wide political entities " +
  "from 3400BCE to 2024CE. Scientific Data.";

/** 出典表示用のリポジトリ URL（ピン留めコミットが解決できる URL） */
export const CLIOPATRIA_SOURCE_HOMEPAGE =
  `https://github.com/${CLIOPATRIA_SOURCE_REPO}`;

/** 取得するアーカイブ（44,231,317 バイト） */
export const CLIOPATRIA_ARCHIVE_URL =
  `https://raw.githubusercontent.com/${CLIOPATRIA_SOURCE_REPO}/${CLIOPATRIA_SOURCE_COMMIT}/cliopatria.geojson.zip`;

/** アーカイブの SHA-256（バイト列のピン留め。取得のたびに検証する） */
export const CLIOPATRIA_ARCHIVE_SHA256 =
  "d01ae3a20d358cc5d54f69d9d725d390767d9c8759ac89ad6f90c58d106f3370";

/** アーカイブ内の GeoJSON（展開後 165,608,072 バイト・13,765 feature） */
export const CLIOPATRIA_ARCHIVE_MEMBER = "cliopatria_polities_only.geojson";

/**
 * 生成対象年。仏（1000〜1300）と帝国（1279〜1492）の和。
 *
 * - 1000 / 1100 / 1200 は仏のみ。帝国側は Cliopatria が 1000〜1200 の帝国を
 *   Holy Roman Empire 一枚岩（1200 年で 879,279 km²）でモデル化しており、
 *   内部領邦の feature が存在しない。1000 / 1100 は OHM の部族大公領が
 *   542,000 km² を既に覆っているので補う必要も無い。
 * - 1279 / 1300 は仏 + 帝国。
 * - 1400 / 1492 は帝国のみ。仏は base（europe_<year>）のフランス勢力が実態に
 *   一致する年代で、諸侯領オーバーレイ自体を持たない（src/config.ts の
 *   FRANCE_FIEF_OVERLAY_YEARS の解説）。
 */
export const CLIOPATRIA_FIEF_YEARS: readonly number[] = [
  1000,
  1100,
  1200,
  1279,
  1300,
  1400,
  1492,
];

/**
 * 仏諸侯領の許可リスト（上流の Name → 収録する年）。
 *
 * 挙げているのは **OHM に該当リレーションが存在しない**領邦だけで、OHM が
 * 収録している年は載せない（TASK-70/87/88 が boundary=administrative 4,923 件で
 * 3 回実測した欠落一覧と、data/france_fiefs_<year>.geojson の実データを突き
 * 合わせて決めた）。同じ領邦を 2 つの出典で二重に描かないため、また Cliopatria の
 * 境界は OHM より 4〜7 倍粗いため、OHM がある側を常に優先する。
 *
 * 年は Cliopatria 側の [FromYear, ToYear] が実際に覆う年だけを挙げる。
 */
export const CLIOPATRIA_FRANCE_FIEF_NAMES: Readonly<
  Record<string, readonly number[]>
> = {
  // 王領（domaine royal）。OHM にフランス王の直轄領を表すリレーションが無い。
  // 1279 / 1300 の Cliopatria "Kingdom of France" は 206,111 / 242,840 km² と
  // 王国規模になり、諸侯領ではなく base のフランス勢力と同じものを描くだけに
  // なるため採らない（1000 = 49,071 / 1100 = 21,966 / 1200 = 37,024 km²）。
  "Kingdom of France": [1000, 1100, 1200],
  // OHM の収録は 1137-04-09〜1214-09-28 のみ。その前後を Cliopatria で補う。
  "Duchy of Aquitaine": [1000, 1100, 1279, 1300],
  // 同上（OHM は 1200 年だけ有効）。
  "Duchy of Gascony": [1000],
  // decision-18 が「OHM に該当リレーションが存在しない」と記録した筆頭。
  "County of Toulouse": [1000, 1100, 1200],
  "County of Auvergne": [1279, 1300],
  "County of Foix": [1279, 1300],
  "County of Armagnac": [1279, 1300],
  "County of Nevers": [1100, 1200, 1300],
  "County of Périgord": [1279, 1300],
  "County of Rouergue": [1000],
  "County of Vermandois": [1000, 1100, 1200],
  "County of Vexin": [1000],
  // 1300 年は採らない。上流の [1294-1332] は閉点を除いて 5 頂点・3,658 km²
  // しか無く、ロワール川ともブロワの街とも無関係な細長い四角形になる
  // （CLIOPATRIA_EXCLUSIONS.upstreamGeometryTooCoarse・#321）。
  "County of Blôis": [1000, 1100, 1200, 1279],
  "County of Boulogne": [1200],
  // OHM の収録は 1237 年（フランドルから分離した年）以降のみ。
  "County of Flanders": [1000, 1100, 1200],
  // OHM の収録は 1200 年以降のみ。
  "County of Champagne": [1000, 1100],
};

/**
 * 帝国領邦の許可リスト（上流の Name → 収録する年）。
 *
 * 対象は OHM 側に該当年の収録が無い 4 領邦に限る（帝国 bbox の name:en 一致
 * 174 リレーションを全件確認した TASK-110 起票時の実測）:
 * - Duchy of Bavaria … OHM は 0962-1100 と 1505-1623 のみで 1100〜1505 が完全欠落
 * - Brandenburg … OHM の Electorate of Brandenburg は 1648 年以降のみ
 * - Kingdom of Bohemia … OHM の Duchy of Bohemia は 1100 年のみ
 * - Electorate of Saxony … OHM は 1400 年の Electorate of Saxony(-Wittenberg) を
 *   持つのでその年は採らず、1485 年のライプツィヒ分割で切れる 1492 年だけ採る
 *
 * 名称が年代で変わる領邦（辺境伯領 → 選帝侯領）は上流の Name をそのまま別
 * エントリにする（OHM 由来の hre_fiefs も年代で称号が変わる同じ扱い）。
 */
export const CLIOPATRIA_HRE_FIEF_NAMES: Readonly<
  Record<string, readonly number[]>
> = {
  "Duchy of Bavaria": [1279, 1300, 1400, 1492],
  "Margraviate of Brandenburg": [1279, 1300, 1400],
  "Electorate of Brandenburg": [1492],
  "Kingdom of Bohemia": [1279, 1300, 1400, 1492],
  "Electorate of Saxony": [1492],
};

/**
 * 上流の Name を地図上の NAME へ読み替える対応（純粋なデータ定義）。
 *
 * Cliopatria は王国全体を複合体 "(Kingdom of France)" として別に持ち、丸括弧
 * 無しの "Kingdom of France" は王の直轄領（domaine royal）を指す。この NAME を
 * そのまま使うと base（europe_<year>）のフランス王国と色キー・ラベル・
 * クリックパネルの見出しが衝突し、王国全体を諸侯領として描いているように
 * 読めてしまう。**ジオメトリには一切触れない語彙の上書き**で、上流の名前は
 * properties.CLIOPATRIA_NAME に残す（decision-23 と同じ方針）。
 */
export const CLIOPATRIA_NAME_OVERRIDES: Readonly<Record<string, string>> = {
  "Kingdom of France": "Royal Domain of France",
};

/** 帝国領邦に付ける SUBJECTO / PARTOF（hre_fiefs_<year>.geojson と同値） */
export const HRE_SUZERAIN = "Holy Roman Empire";

/**
 * 収録しない対象の分類と根拠（TASK-110 AC #1）。
 * 許可リストとは独立に適用する二重の防波堤で、将来の許可リスト編集で複合体や
 * 残余カテゴリが紛れ込んでも生成物に入らないようにする
 * （scripts/build-france-fiefs.ts の franceFiefExclusionReason と同じ方針）。
 */
export const CLIOPATRIA_EXCLUSIONS: Readonly<Record<string, string>> = {
  composite:
    "名前を丸括弧で囲んだ feature は従属政体を含む複合体で、封臣の領域を全て" +
    "飲み込んだ 1 枚のポリゴンになる（1000 年の (Kingdom of France) は " +
    "420,259 km² で、単独の Kingdom of France = 王領 49,071 km² の 8.6 倍）。" +
    "そのまま描くと王国全体が 1 色で塗られ、諸侯領オーバーレイの目的" +
    "（誰がどこを直接支配していたか）が完全に失われる。",
  relation:
    "Type = RELATION は人的同君連合・臣従・同盟などの上位関係を表す複合体で、" +
    "ジオメトリは関係する政体の合併と同一（1400 年の (Vassalage of Kingdom of " +
    "Bohemia to Holy Roman Empire) は帝国複合体と同じ 1,035,034 km²）。" +
    "領域ではなく関係を表す feature なので面としては描かない。",
  residualCategory:
    "Holy Roman Empire Minor States は帝国の残余カテゴリで、数百の小領邦を" +
    "ひとまとめにした袋（1279 年 518,669 km² / 1300 年 555,409 km² / " +
    "1400 年 458,794 km² / 1492 年 343,299 km²）。1 つの名前・1 つの色・" +
    "1 つのラベルで描くと事実に反するうえ、補ったバイエルン公領・" +
    "ブランデンブルク辺境伯領・ボヘミア王国を丸ごと覆ってしまう。",
  sovereignPowers:
    "Holy Roman Empire / Kingdom of England / Crown of Castile / " +
    "Kingdom of Hungary / Byzantine Empire などの主権国家は " +
    "base（europe_<year>.geojson・historical-basemaps）が担う。諸侯領" +
    "オーバーレイに重ねても同じ領域を二重に描くだけになる。許可リストに" +
    "載せないことで落ちる。",
  dynasticHouses:
    "House of Habsburg / House of Ascania / House of Wittelsbach / " +
    "House of Luxembourg / House of Valois-Anjou / Capetian House of Anjou は" +
    "領邦ではなく帝国・王国内に散在する所領の集合体で、OHM が個別に収録して" +
    "いる領邦（Duchy of Austria 等）と領域が重なる。1279 年の House of " +
    "Wittelsbach（17,892 km²）は同年の Duchy of Bavaria（35,323 km²）と" +
    "重なるため、両方を採ると同じ土地が二重に塗られる。",
  imperialKingdomsOnFrenchSide:
    "Kingdom of Arles と Dauphiné は Cliopatria が MemberOf = " +
    "(Kingdom of France) に置いているが、いずれもアルル王国（帝国）側の領域で" +
    "フランス王国の封建諸侯領ではない（Dauphiné のフランス編入は 1349 年、" +
    "Dauphiné of Viennois は OHM 由来の hre_fiefs_1300 で収録済み）。" +
    "scripts/build-france-fiefs.ts の lowCountriesAndBurgundianKingdom と" +
    "同じ扱いにする。",
  upstreamPlacementMismatch:
    "上流のポリゴンが名前の指す土地に載っていないもの。County of Touraine は " +
    "1279 / 1300 年とも bbox が 0.90〜2.60E・45.56〜46.55N で、トゥール" +
    "（0.69E・47.39N）を 1 度も含まずリムーザン〜マルシュ地方を覆っている。" +
    "OHM 由来の County of La Marche と 7,272 km²（この feature の 73%）" +
    "重なることからも、実体はトゥーレーヌではない。名前と土地が一致しない" +
    "feature を足すのは空白のままにするより悪いので採らない。",
  upstreamGeometryTooCoarse:
    "上流の面が粗すぎて、その土地の形として読めないもの。1300 年の " +
    "County of Blôis（上流の区間 [1294-1332]）は閉点を除いて 5 頂点しか無く、" +
    "3,658 km² をロワール川ともブロワの街とも無関係な細長い四角形で覆う" +
    "（同じ領邦の 1279 年は [1250-1293] の 16 頂点・8,090 km² で、期間・面積・" +
    "形状が別物）。1300 年に使える面は OHM にも（Blois の名を持つ " +
    "boundary リレーションが 0 件）Cliopatria の他の区間にも無く、" +
    "1300 年を含む区間はこの 1 件だけである。誤解を招く四角形を描くより" +
    "空白にして data/known-limitations.json で明示する方を採る（#321）。" +
    "許可リストからその年を外すことで落とす。",
  coveredByOpenHistoricalMap:
    "OHM（CC0）が同じ領邦を同じ年代で収録している場合は OHM を優先し" +
    "Cliopatria 側を採らない。Cliopatria は 2014 年の手描き地図画像を自動抽出し" +
    "0.07 度で平滑化したもので境界が 4〜7 倍粗く、同じ領邦を 2 つの出典で" +
    "二重に描く意味が無いため。許可リストの年を OHM の欠落年だけに絞ることで" +
    "落とす（例: Electorate of Saxony は OHM が 1400 年を持つので 1492 年のみ、" +
    "County of Champagne は OHM が 1200 年以降を持つので 1000 / 1100 のみ）。",
};

/** Cliopatria の生 feature properties（上流のスキーマそのまま） */
export interface CliopatriaProperties {
  Name: string;
  FromYear: number;
  ToYear: number;
  Area: number;
  /** POLITY または RELATION */
  Type: string;
  Wikipedia: string;
  Wikidata: string;
  SeshatID: string;
  Components: string;
  MemberOf: string;
}

/** 名前が丸括弧で囲まれた複合体か（純粋関数） */
export function isCompositeName(name: string): boolean {
  return name.startsWith("(") && name.endsWith(")");
}

/**
 * 収録しない対象なら根拠を返す（純粋関数）。収録してよいなら null。
 * 許可リストの前段に置く構造的な防波堤で、判定は properties だけに依存する。
 */
export function cliopatriaExclusionReason(
  props: CliopatriaProperties,
): string | null {
  if (props.Type !== "POLITY") return CLIOPATRIA_EXCLUSIONS.relation;
  if (isCompositeName(props.Name)) return CLIOPATRIA_EXCLUSIONS.composite;
  if (props.Name.endsWith("Minor States")) {
    return CLIOPATRIA_EXCLUSIONS.residualCategory;
  }
  return null;
}

/** 許可リストで収録が許された年の一覧を返す（純粋関数）。載っていなければ null */
export function allowedYearsFor(name: string): readonly number[] | null {
  return CLIOPATRIA_FRANCE_FIEF_NAMES[name] ??
    CLIOPATRIA_HRE_FIEF_NAMES[name] ?? null;
}

/**
 * 存続区間が year を含むか（純粋関数）。
 *
 * Cliopatria の [FromYear, ToYear] はスナップショット年をまたぐ形で不規則に
 * 切られている（1279 年は [1279-1284]、1300 年は [1294-1304]、Duchy of Brittany
 * は [990-1146]）。判定は**包含だけ**にして、区間外の年へ近い区間を寄せる救済
 * （最近傍・外挿）はしない。出典が「この年に存在した」と言っていない領域を
 * 描かないための規則で、decision-14 の本旨と揃える。
 */
export function containsYear(
  props: CliopatriaProperties,
  year: number,
): boolean {
  return props.FromYear <= year && year <= props.ToYear;
}

/** 区間の幅（狭いほどスナップショット年に固有の記述） */
function intervalWidth(props: CliopatriaProperties): number {
  return props.ToYear - props.FromYear;
}

/**
 * その年に収録する feature を選ぶ（純粋関数）。
 *
 * 1. 構造的な除外（複合体・RELATION・残余カテゴリ）
 * 2. 許可リスト（名前 + その年が許可されていること）
 * 3. 存続区間の包含判定
 * 4. 同じ名前に複数の区間が当たったら **最も狭い区間** を採る。同幅なら
 *    FromYear が小さい方、それも同じなら Area が大きい方（完全に決定的）。
 * 返り値は NAME 昇順（france_fiefs / hre_fiefs と同じ並びの規約）。
 */
export function selectForYear(
  features: readonly Feature[],
  year: number,
): Feature[] {
  const best = new Map<string, Feature>();
  for (const feature of features) {
    const props = feature.properties as unknown as CliopatriaProperties | null;
    if (props === null || typeof props.Name !== "string") continue;
    if (cliopatriaExclusionReason(props) !== null) continue;
    const allowed = allowedYearsFor(props.Name);
    if (allowed === null || !allowed.includes(year)) continue;
    if (!containsYear(props, year)) continue;
    const current = best.get(props.Name);
    if (current === undefined) {
      best.set(props.Name, feature);
      continue;
    }
    const a = current.properties as unknown as CliopatriaProperties;
    if (
      intervalWidth(props) < intervalWidth(a) ||
      (intervalWidth(props) === intervalWidth(a) &&
        (props.FromYear < a.FromYear ||
          (props.FromYear === a.FromYear && props.Area > a.Area)))
    ) {
      best.set(props.Name, feature);
    }
  }
  return [...best.values()]
    .map((feature): Feature => ({
      ...feature,
      properties: fiefPropertiesOf(
        feature.properties as unknown as CliopatriaProperties,
        year,
      ),
    }))
    .sort((x, y) => {
      const a = String(x.properties?.NAME ?? "");
      const b = String(y.properties?.NAME ?? "");
      return a < b ? -1 : a > b ? 1 : 0;
    });
}

/** 年を 4 桁ゼロ詰めの文字列にする（既存 fief の START_DATE / END_DATE 表記） */
function yearString(year: number): string {
  return String(year).padStart(4, "0");
}

/**
 * 上流 properties を既存 fief と同型の properties へ写す（純粋関数）。
 *
 * - 仏諸侯領は france_fiefs_<year> と同型（SUBJECTO / PARTOF を持たない）
 * - 帝国領邦は hre_fiefs_<year> と同型（SUBJECTO / PARTOF = "Holy Roman Empire"）
 * どちらも src/powers.ts colorKeyFor が既存レイヤーと同じキーを組み立てるので、
 * 色・ラベル・picking の経路は出典が変わっても同一になる。
 *
 * Cliopatria 固有の出所（SeshatID / Wikidata / Wikipedia / 上流の Name / 面積）
 * は接頭辞付きで残し、feature 単位で上流まで辿れるようにする。
 */
export function fiefPropertiesOf(
  props: CliopatriaProperties,
  year: number,
): Record<string, unknown> {
  const name = CLIOPATRIA_NAME_OVERRIDES[props.Name] ?? props.Name;
  const isImperial = CLIOPATRIA_HRE_FIEF_NAMES[props.Name] !== undefined;
  return {
    NAME: name,
    ...(isImperial ? { SUBJECTO: HRE_SUZERAIN, PARTOF: HRE_SUZERAIN } : {}),
    START_DATE: yearString(props.FromYear),
    END_DATE: yearString(props.ToYear),
    /** 上流の Name（NAME を上書きした場合でも追跡できるようにする） */
    CLIOPATRIA_NAME: props.Name,
    CLIOPATRIA_SESHAT_ID: props.SeshatID,
    /** 上流が申告する面積（km²）。本パイプラインは再計算しない */
    CLIOPATRIA_AREA_KM2: Math.round(props.Area),
    WIKIDATA: props.Wikidata,
    WIKIPEDIA: props.Wikipedia,
    /** どのスナップショット年のために選ばれた区間か */
    SNAPSHOT_YEAR: year,
  };
}

/** 出力（Cliopatria 由来の生データ）のパス */
export function cliopatriaRawPathFor(year: number): string {
  return `data/cliopatria_fiefs_${year}.geojson`;
}

/** 生成物に埋め込むメタデータ（出典キーは build-attribution が別に足す） */
export interface CliopatriaFiefMetadata {
  generatedBy: string;
  year: number;
  featureCount: number;
  /** 取得したアーカイブの URL と SHA-256（バイト列のピン留め） */
  archiveUrl: string;
  archiveSha256: string;
  /** 引用（CC BY 4.0 の帰属要件） */
  doi: string;
  citation: string;
  /** 収録した領邦（上流の Name → 採った区間） */
  selected: Array<{
    name: string;
    upstreamName: string;
    fromYear: number;
    toYear: number;
    upstreamAreaKm2: number;
  }>;
}

// ---------------------------------------------------------------------------
// 以下は取得・生成（ネットワークに触れる部分。テスト対象外）
// ---------------------------------------------------------------------------

/** バイト列の SHA-256 を 16 進文字列で返す */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * ピン留めしたアーカイブを取得して SHA-256 を検証し、一時ファイルのパスを返す。
 * 環境変数 CLIOPATRIA_ARCHIVE にローカルの zip を指すとダウンロードを省略できる
 * （44 MB の再取得を避けるための開発用。検証は同じように行う）。
 */
async function fetchArchive(): Promise<string> {
  const local = Deno.env.get("CLIOPATRIA_ARCHIVE");
  let path: string;
  let bytes: Uint8Array;
  if (local !== undefined && local !== "") {
    path = local;
    bytes = await Deno.readFile(local);
    console.log(`ローカルのアーカイブを使用: ${local}`);
  } else {
    console.log(`取得: ${CLIOPATRIA_ARCHIVE_URL}`);
    const res = await fetch(CLIOPATRIA_ARCHIVE_URL);
    if (!res.ok) {
      throw new Error(`アーカイブの取得に失敗しました: ${res.status}`);
    }
    bytes = new Uint8Array(await res.arrayBuffer());
    path = `${await Deno.makeTempDir()}/cliopatria.geojson.zip`;
    await Deno.writeFile(path, bytes);
  }
  const actual = await sha256Hex(bytes);
  if (actual !== CLIOPATRIA_ARCHIVE_SHA256) {
    throw new Error(
      `アーカイブの SHA-256 が一致しません（ピン留めが壊れています）: ` +
        `期待 ${CLIOPATRIA_ARCHIVE_SHA256} / 実際 ${actual}`,
    );
  }
  console.log(`SHA-256 検証 OK（${bytes.length} バイト）`);
  return path;
}

/** アーカイブから GeoJSON を取り出して読む（unzip -p で標準出力へ流す） */
async function readArchiveMember(zipPath: string): Promise<FeatureCollection> {
  const command = new Deno.Command("unzip", {
    args: ["-p", zipPath, CLIOPATRIA_ARCHIVE_MEMBER],
    stdout: "piped",
    stderr: "inherit",
  });
  const { success, stdout } = await command.output();
  if (!success) {
    throw new Error(
      `unzip -p ${zipPath} ${CLIOPATRIA_ARCHIVE_MEMBER} が失敗しました`,
    );
  }
  return JSON.parse(new TextDecoder().decode(stdout)) as FeatureCollection;
}

/** Polygon を MultiPolygon へ揃える（既存 fief の出力形に合わせる） */
function toMultiPolygon(feature: Feature): Feature<MultiPolygon> {
  const geometry = feature.geometry as Polygon | MultiPolygon;
  return {
    ...feature,
    geometry: geometry.type === "Polygon"
      ? { type: "MultiPolygon", coordinates: [geometry.coordinates] }
      : geometry,
  } as Feature<MultiPolygon>;
}

async function main(): Promise<void> {
  const zipPath = await fetchArchive();
  const raw = await readArchiveMember(zipPath);
  console.log(`Cliopatria: ${raw.features.length} feature`);

  for (const year of CLIOPATRIA_FIEF_YEARS) {
    const selected = selectForYear(raw.features, year).map(toMultiPolygon);
    const truncated = truncate(
      { type: "FeatureCollection", features: selected } as FeatureCollection,
      { precision: RAW_FIEF_COORD_PRECISION, coordinates: 2 },
    );
    const { fc: cleaned, stats } = cleanFeatureCollection(
      truncated,
      RAW_FIEF_COORD_PRECISION,
    );
    if (stats.droppedFeatures.length > 0) {
      throw new Error(
        `${year}: クリーンアップで面が残らなかった feature があります: ` +
          stats.droppedFeatures.join(", "),
      );
    }
    const line = formatCleanStats(stats);
    if (line !== null) console.log(`  ${line}`);

    const metadata: CliopatriaFiefMetadata = {
      generatedBy: "scripts/build-cliopatria-fiefs.ts",
      year,
      featureCount: cleaned.features.length,
      archiveUrl: CLIOPATRIA_ARCHIVE_URL,
      archiveSha256: CLIOPATRIA_ARCHIVE_SHA256,
      doi: CLIOPATRIA_SOURCE_DOI,
      citation: CLIOPATRIA_SOURCE_CITATION,
      selected: cleaned.features.map((f) => ({
        name: String(f.properties?.NAME),
        upstreamName: String(f.properties?.CLIOPATRIA_NAME),
        fromYear: Number(f.properties?.START_DATE),
        toYear: Number(f.properties?.END_DATE),
        upstreamAreaKm2: Number(f.properties?.CLIOPATRIA_AREA_KM2),
      })),
    };
    const outPath = cliopatriaRawPathFor(year);
    const json = JSON.stringify({ ...cleaned, metadata });
    await Deno.writeTextFile(outPath, json);
    console.log(
      `${outPath}: ${json.length} bytes, features=${cleaned.features.length}`,
    );
    for (const s of metadata.selected) {
      console.log(
        `  ${s.name} [${s.fromYear}-${s.toYear}] ${s.upstreamAreaKm2} km²`,
      );
    }
  }
  console.log(
    "出典キーは deno task build-attribution で付与する（このスクリプトは付けない）",
  );
}

if (import.meta.main) {
  await main();
}
