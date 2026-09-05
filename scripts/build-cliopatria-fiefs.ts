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
 * - 年の選択は包含判定のみ。区間外の年へ寄せる救済（最近傍・外挿）は
 *   **一般規則としては行わない**。例外は CLIOPATRIA_BORROWED_YEARS に明示的に
 *   列挙した年借用だけで、name × 対象年 × 区間 × SeshatID の全点一致でしか
 *   発火しない（ADR-0039 / #346）
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

/**
 * データセット名（生成物の出典キーに刻む値。scripts/build-attribution.ts の
 * DATA_ATTRIBUTIONS.cliopatria.source と同値で、こちらが正）。
 */
export const CLIOPATRIA_SOURCE_NAME =
  "Cliopatria (Seshat Global History Databank)";

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
 * 生成対象年。仏・帝国領邦と東欧の補完面の和。
 *
 * - 1000 年は仏 + ボヘミア公国の同年面（1000〜1002）。OHM のボヘミア
 *   公国はこの年を覆わない。1100 年の帝国領邦は OHM を使い、1200 年の
 *   ボヘミア王国は CLIOPATRIA_BORROWED_YEARS の許可区間から借用する。
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
  1500,
  1530,
  1600,
  1650,
  1700,
  1715,
  1783,
  1800,
];

/**
 * モルダヴィア公国の静的許可リスト（#450）。通常の name × year 許可より厳しく、
 * 上流 Name・対象年・区間・SeshatID の全点一致でだけ収録する。1600 年だけは
 * 同年の三公国合成面を意味論上不適合として除外し、直前の [1595-1599] を借りる。
 */
export const CLIOPATRIA_MOLDAVIA_INTERVALS = [
  [1400, 1385, 1401, "md_moldavia_principality_1"],
  [1492, 1487, 1506, "md_moldavia_principality_1"],
  [1500, 1487, 1506, "md_moldavia_principality_1"],
  [1530, 1529, 1539, "md_moldavia_principality_2"],
  [1650, 1602, 1658, "md_moldavia_principality_2"],
  [1700, 1696, 1712, "md_moldavia_principality_2"],
  [1715, 1713, 1768, "md_moldavia_principality_3"],
  [1783, 1775, 1790, "md_moldavia_principality_3"],
  [1800, 1792, 1806, "md_moldavia_principality_3"],
] as const;

function isExactMoldaviaInterval(
  props: CliopatriaProperties,
  year: number,
): boolean {
  return props.Name === "Principality of Moldavia" &&
    CLIOPATRIA_MOLDAVIA_INTERVALS.some(([target, from, to, id]) =>
      target === year && from === props.FromYear && to === props.ToYear &&
      id === props.SeshatID
    );
}

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
 * - Duchy / Kingdom of Bohemia … OHM の Duchy of Bohemia は 1100 年のみ
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
  "Duchy of Bohemia": [1000],
  "Kingdom of Bohemia": [1279, 1300, 1400, 1492],
  "Electorate of Saxony": [1492],
};

/**
 * 上流の隣接**区間**から対象年へ面を借りる許可リストの 1 件（ADR-0039 / #346）。
 *
 * 通常収録（CLIOPATRIA_FRANCE_FIEF_NAMES / CLIOPATRIA_HRE_FIEF_NAMES）は
 * containsYear の包含判定を必ず通るが、ここに載せた 1 件だけは包含判定を通ら
 * なくても採る。ADR-0033（隣接年の出典付きジオメトリの流用）の追補として、
 * 「本リポジトリの生成物」ではなく「上流データセットの隣接区間」を借用元に
 * できる例外を ADR-0039 が明文化している。
 */
export interface CliopatriaBorrowedYear {
  /** 上流の Name（NAME 読み替え前。許可リストと同じ語彙で書く） */
  readonly name: string;
  /** 借用先のスナップショット年（CLIOPATRIA_FIEF_YEARS の要素） */
  readonly targetYear: number;
  /** 借用元の上流区間の始点（FromYear と厳密一致） */
  readonly fromYear: number;
  /** 借用元の上流区間の終点（ToYear と厳密一致） */
  readonly toYear: number;
  /** 借用元 feature の SeshatID（同名の別政体を取り違えないための鍵） */
  readonly seshatId: string;
  /** 借用の根拠（政体の同一性と領域の連続性。ADR-0033 条件 3） */
  readonly reason: string;
  /** 同年面があるが意味論上不適合な限定例外。その面だけを superseded 判定から除く。 */
  readonly excludedDirectInterval?: {
    readonly fromYear: number;
    readonly toYear: number;
    readonly seshatId: string;
  };
}

/**
 * 年借用の許可リスト（ADR-0039 / #346）。**明示的に列挙した 1 件だけ**が
 * 包含判定の例外になる。最近傍・外挿の一般規則にはしない（containsYear の
 * 解説にあるとおり、出典が「この年に存在した」と言っていない領域を描かない
 * のが既定であり、ここはその既定を name × targetYear × 区間 × SeshatID の
 * 4 点一致でだけ緩める）。
 *
 * 上流に対象年を直接覆う区間が現れたらこのエントリを外して通常収録へ
 * 切り替える。検知は borrowSupersededReason がビルド時に行う。
 */
export const CLIOPATRIA_BORROWED_YEARS: readonly CliopatriaBorrowedYear[] = [
  {
    name: "Kingdom of Bohemia",
    targetYear: 1200,
    fromYear: 1202,
    toYear: 1215,
    seshatId: "cz_bohemian_k_1",
    reason: "1200 年のボヘミアを覆う面が上流のどこにも無い（Cliopatria の " +
      "Duchy of Bohemia は [.. -1002] で終わり、Kingdom of Bohemia は " +
      "[1202-1215] から始まる。OHM の Duchy of Bohemia は end_date 1100）。" +
      "プシェミスル・オタカル 1 世は 1198 年の王号取得から 1230 年まで継続して" +
      "ボヘミア王であり、1200〜1202 年にこの地図の縮尺で有意な領域断絶は無い" +
      "（借用元 70,806 km² は 1100 年 OHM の Duchy of Bohemia と IoU 84.8%）。" +
      "年差 2 年で、上流の区間としては対象年の直後に隣接する。",
  },
  {
    name: "Principality of Moldavia",
    targetYear: 1600,
    fromYear: 1595,
    toYear: 1599,
    seshatId: "md_moldavia_principality_2",
    excludedDirectInterval: {
      fromYear: 1600,
      toYear: 1601,
      seshatId: "md_moldavia_principality_2",
    },
    reason:
      "Cliopatria の [1600-1601] はミハイ勇敢公が一時支配したモルダヴィア・" +
      "ワラキア・トランシルヴァニア三公国を一枚にした 256,733 km² の合成面で、" +
      "同君連合を構成政体の消滅・領土統合として扱わない本アプリの政体モデルと" +
      "両立しない。既存のワラキア公国を独立した面として保つため、直前に隣接する" +
      "[1595-1599]（81,506 km²）の座標を無改変で借用する（#450 / ADR-0044）。",
  },
];

/**
 * base 主権の外周を置換するために採る**括弧付き複合体**の 1 件
 * （ADR-0040 / #352）。
 *
 * ADR-0026 は複合体（丸括弧で囲まれた Name）を「封臣の領域を飲み込んだ 1 枚の
 * ポリゴン」として構造的に除外している。その根拠は諸侯領オーバーレイの目的
 * （誰がどこを直接支配していたか）に照らしたもので、**base 主権の外周**
 * （europe_<year>.geojson の勢力ポリゴン）には当てはまらない。主権の外周とは
 * まさに「封臣の領域を含む外側の輪郭」だからである。
 *
 * ADR-0040 はこの 1 用途に限って ADR-0026 の適用範囲を拡張する。発火は
 * CLIOPATRIA_BORROWED_YEARS と同じく **name × 対象年 × 上流区間 × SeshatID の
 * 全点一致**でしか起きない（1 つでもずれたら採らない）。
 */
export interface CliopatriaCompositeParent {
  /** 対象スナップショット年（CLIOPATRIA_FIEF_YEARS の要素） */
  readonly targetYear: number;
  /** 上流の Name（括弧付き複合体） */
  readonly name: string;
  /** 上流区間の始点（FromYear と厳密一致） */
  readonly fromYear: number;
  /** 上流区間の終点（ToYear と厳密一致） */
  readonly toYear: number;
  /** 同名の別政体を取り違えないための鍵 */
  readonly seshatId: string;
  /** 上流の Wikidata（追跡用。判定には使わない） */
  readonly wikidata: string;
  /**
   * 置換する base 勢力の NAME（scripts/build-data.ts の
   * BASE_POWER_REPLACEMENTS と同値）。子区画の SUBJECTO / PARTOF にもなる。
   */
  readonly basePowerName: string;
  /**
   * leaf 子区画の上流 Name（昇順・全件）。MemberOf から算出した leaf 集合が
   * これと一致しなければビルドを失敗させる（compositeLeafMismatchReason）。
   */
  readonly childNames: readonly string[];
  /** 採る根拠（ADR-0040 の表と対になる人間向けの注記） */
  readonly reason: string;
}

/**
 * 複合体の許可リスト（ADR-0040 / #352）。**明示的に列挙した 6 件だけ**が
 * CLIOPATRIA_EXCLUSIONS.composite の例外になる。
 *
 * 6 年とも上流に対象年を直接覆う区間があるため、ADR-0039 の年借用は使わない
 * （外挿・最近傍は従来どおり禁止）。
 */
export const CLIOPATRIA_COMPOSITE_PARENTS:
  readonly CliopatriaCompositeParent[] = [
    {
      targetYear: 1000,
      name: "(Kingdom of Poland)",
      fromYear: 990,
      toYear: 1002,
      seshatId: "pl_piast_dyn_1",
      wikidata: "Q577867",
      basePowerName: "Poland",
      childNames: ["Kingdom of Poland"],
      reason:
        "base（historical-basemaps・BORDERPRECISION=1）の 1000 年 Poland は " +
        "最長線分 312.4 km の概略ポリゴンで、外周が定規で引いたような直線に " +
        "なる。上流の [990-1002] は 1000 年を直接覆い、最長線分 74.4 km・" +
        "100 km 超 0 本まで下がる（#352）。",
    },
    {
      targetYear: 1100,
      name: "(Kingdom of Poland)",
      fromYear: 1056,
      toYear: 1125,
      seshatId: "pl_piast_dyn_1",
      wikidata: "Q577867",
      basePowerName: "Poland",
      childNames: ["Kingdom of Poland"],
      reason:
        "base の 1100 年 Poland は最長線分 264.4 km。上流の [1056-1125] は " +
        "1100 年を直接覆い、最長線分 90.2 km・100 km 超 0 本になる（#352）。",
    },
    {
      targetYear: 1200,
      name: "(Duchies of Poland)",
      fromYear: 1192,
      toYear: 1201,
      seshatId: "pl_piast_dyn_2",
      wikidata: "Q2984183",
      basePowerName: "Poland",
      childNames: [
        "Duchy of Greater Poland",
        "Duchy of Kuyavia",
        "Duchy of Opole",
        "Duchy of Sandomierz",
        "Duchy of Silesia",
        "Duchy of Wrocław",
      ],
      reason:
        "base の 1200 年 Poland は最長線分 183.9 km で、プラハ・ブルノまで " +
        "呑み込む。上流の [1192-1201] は 1200 年を直接覆い、最長線分 75.5 km・" +
        "100 km 超 0 本。分割期のポーランドを 6 公国の内訳付きで描ける（#352）。",
    },
    {
      targetYear: 1279,
      name: "(Duchies of Poland)",
      fromYear: 1279,
      toYear: 1284,
      seshatId: "pl_piast_dyn_2",
      wikidata: "Q2984183",
      basePowerName: "Poland",
      childNames: [
        "Duchies of Poland",
        "Duchy of Greater Poland",
        "Duchy of Głogów",
        "Duchy of Jawor",
        "Duchy of Legnica",
        "Duchy of Masovia",
        "Duchy of Opole",
        "Duchy of Sandomierz",
        "Duchy of Silesia",
      ],
      reason:
        "base の 1279 年 Poland は最長線分 116.5 km。上流の [1279-1284] は " +
        "対象年そのもので、最長線分 110.7 km・100 km 超 1 本。leaf の 1 件は " +
        "上流が個別公国へ分解していない残余（Name = Duchies of Poland）で、" +
        "親と同名ではないため区別できる（#352）。",
    },
    {
      targetYear: 1300,
      name: "(Duchies of Poland)",
      fromYear: 1294,
      toYear: 1304,
      seshatId: "pl_piast_dyn_2",
      wikidata: "Q2984183",
      basePowerName: "Poland",
      childNames: [
        "Duchies of Poland",
        "Duchy of Bytom",
        "Duchy of Greater Poland",
        "Duchy of Głogów",
        "Duchy of Jawor",
        "Duchy of Legnica",
        "Duchy of Masovia",
        "Duchy of Opole",
        "Duchy of Racibórz",
        "Duchy of Sandomierz",
        "Duchy of Silesia",
      ],
      reason:
        "base の 1300 年 Poland は最長線分 115.3 km。上流の [1294-1304] は " +
        "1300 年を直接覆い、最長線分 110.7 km・100 km 超 1 本（#352）。",
    },
    {
      targetYear: 1400,
      name: "(Polish-Lithuania Kingdom)",
      fromYear: 1395,
      toYear: 1401,
      seshatId: "pl_jagiellonian_dyn",
      wikidata: "Q194355",
      basePowerName: "Poland-Lithuania",
      childNames: ["Grand Duchy of Lithuania", "Kingdom of Poland"],
      reason:
        "base の 1400 年 Poland-Lithuania は最長線分 841.7 km で、東部が " +
        "1 本の直線になる。上流の [1395-1401] は 1400 年を直接覆い、" +
        "最長線分 195.4 km・100 km 超 4 本。子は leaf の 2 件だけで、" +
        "親と同形状の括弧付き wrapper (Kingdom of Poland) は MemberOf の " +
        "leaf 判定で落ちる（#352）。",
    },
  ];

/**
 * 複合体の中でのその feature の役割（ADR-0040 / #352）。
 * `parent` は base 主権の外周置換専用（配信される flat には出さない）、
 * `child` は諸侯領オーバーレイとして表示する leaf 子区画。
 */
export interface CliopatriaCompositeRole {
  readonly role: "parent" | "child";
  readonly entry: CliopatriaCompositeParent;
}

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
 *
 * この関数自体の意味は #346 でも変えていない。区間外の面を採るのは
 * CLIOPATRIA_BORROWED_YEARS に列挙した年借用（ADR-0039）だけで、そちらは
 * selectForYear が本判定を**迂回**する形で扱う。借用は借用元の区間を
 * START_DATE / END_DATE と BORROWED_FROM に刻んで開示するため、「この年に
 * 存在したと出典が言っている」と偽ることにはならない。
 */
export function containsYear(
  props: CliopatriaProperties,
  year: number,
): boolean {
  return props.FromYear <= year && year <= props.ToYear;
}

/**
 * その feature がこの年の借用対象かを返す（純粋関数・ADR-0039 / #346）。
 * 対象でなければ null。
 *
 * 判定は許可リストの name / targetYear / fromYear / toYear / seshatId の
 * **全点一致**で、1 つでもずれたら借用しない。上流の版が変わって区間の切り方や
 * SeshatID が動いたら静かに別の面を借りるのではなく、借用が消えて生成物テストが
 * 落ちる側へ倒している。
 */
export function borrowedEntryFor(
  props: CliopatriaProperties,
  year: number,
): CliopatriaBorrowedYear | null {
  for (const entry of CLIOPATRIA_BORROWED_YEARS) {
    if (
      entry.targetYear === year &&
      entry.name === props.Name &&
      entry.fromYear === props.FromYear &&
      entry.toYear === props.ToYear &&
      entry.seshatId === props.SeshatID
    ) {
      return entry;
    }
  }
  return null;
}

/**
 * 借用が不要になったか（＝上流が対象年を直接覆う区間を持つようになったか）を
 * 判定する（純粋関数・ADR-0033 条件 1「既存の収録が常に優先する」）。
 *
 * 不要になっていればその区間を説明する文字列、まだ必要なら null。ビルド時に
 * 呼んで、不要になっていたら失敗させる。借用は暫定措置なので、上流が埋まった
 * ことに気づかないまま近似を配信し続けないための歯止めである。
 */
export function borrowSupersededReason(
  features: readonly Feature[],
  entry: CliopatriaBorrowedYear,
): string | null {
  for (const feature of features) {
    const props = feature.properties as unknown as CliopatriaProperties | null;
    if (props === null || props.Name !== entry.name) continue;
    if (cliopatriaExclusionReason(props) !== null) continue;
    if (!containsYear(props, entry.targetYear)) continue;
    if (
      entry.excludedDirectInterval !== undefined &&
      props.FromYear === entry.excludedDirectInterval.fromYear &&
      props.ToYear === entry.excludedDirectInterval.toYear &&
      props.SeshatID === entry.excludedDirectInterval.seshatId
    ) continue;
    return `${entry.name}: 上流に ${entry.targetYear} 年を直接覆う区間 ` +
      `[${props.FromYear}-${props.ToYear}] が現れました。` +
      "CLIOPATRIA_BORROWED_YEARS から借用エントリを外し、通常の許可リストの年へ" +
      "移してください（ADR-0033 条件 1 / ADR-0039）。" +
      "data/known-limitations.json・docs/data-inventory の記載も同時に落とすこと。";
  }
  return null;
}

/**
 * MemberOf を分解して所属先の名前を返す（純粋関数・ADR-0040 / #352）。
 * 上流は `"(Holy Roman Empire);(Kingdom of Bohemia)"` のように `;` 区切りで
 * 複数の所属を持つ。空文字・空白だけの要素は捨てる。
 */
export function memberOfNames(props: CliopatriaProperties): string[] {
  return String(props.MemberOf ?? "")
    .split(";")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

/**
 * その年に leaf でない（＝誰かの MemberOf に現れる）名前の集合を返す
 * （純粋関数・ADR-0040 / #352）。
 *
 * leaf の定義は「その feature を MemberOf に持つ**その年に有効な** feature が
 * 0 件」。判定を有効な feature に限るのは、別の年代にだけ存在する中間層で
 * 子区画が落ちるのを避けるため。1400 年の `(Kingdom of Poland)` は
 * `Kingdom of Poland` を配下に持つのでこの集合に入り、子区画から落ちる。
 */
export function nonLeafNames(
  features: readonly Feature[],
  year: number,
): Set<string> {
  const names = new Set<string>();
  for (const feature of features) {
    const props = feature.properties as unknown as CliopatriaProperties | null;
    if (props === null || typeof props.Name !== "string") continue;
    if (!containsYear(props, year)) continue;
    for (const name of memberOfNames(props)) names.add(name);
  }
  return names;
}

/**
 * その feature がこの年の複合体の**親**かを返す（純粋関数・ADR-0040 / #352）。
 * 対象でなければ null。判定は name / targetYear / fromYear / toYear / seshatId の
 * 全点一致で、1 つでもずれたら採らない（CLIOPATRIA_BORROWED_YEARS と同じ規律）。
 */
export function compositeParentEntryFor(
  props: CliopatriaProperties,
  year: number,
): CliopatriaCompositeParent | null {
  for (const entry of CLIOPATRIA_COMPOSITE_PARENTS) {
    if (
      entry.targetYear === year &&
      entry.name === props.Name &&
      entry.fromYear === props.FromYear &&
      entry.toYear === props.ToYear &&
      entry.seshatId === props.SeshatID
    ) {
      return entry;
    }
  }
  return null;
}

/**
 * その feature がこの年の複合体の **leaf 子区画**かを返す（純粋関数・
 * ADR-0040 / #352）。対象でなければ null。
 *
 * 条件は 4 つ全て:
 * 1. その年の区間に含まれる（containsYear。借用は使わない）
 * 2. MemberOf に親の Name を含む
 * 3. 許可リストの childNames に載っている（name × year の全点一致）
 * 4. leaf である（nonLeaf に入っていない）
 */
export function compositeChildEntryFor(
  props: CliopatriaProperties,
  year: number,
  nonLeaf: ReadonlySet<string>,
): CliopatriaCompositeParent | null {
  if (!containsYear(props, year)) return null;
  if (nonLeaf.has(props.Name)) return null;
  const members = memberOfNames(props);
  for (const entry of CLIOPATRIA_COMPOSITE_PARENTS) {
    if (entry.targetYear !== year) continue;
    if (!members.includes(entry.name)) continue;
    if (!entry.childNames.includes(props.Name)) continue;
    return entry;
  }
  return null;
}

/**
 * 上流の leaf 構成が許可リストとずれたら理由を返す（純粋関数・ADR-0040）。
 * ずれていなければ null。ビルド時に呼んで、ずれていたら失敗させる。
 *
 * 許可リスト（childNames）は「上流をこう読んだ」という記録なので、上流の版が
 * 変わって構成が動いたら生成物が静かに変わる前に気づく必要がある。判定は
 * MemberOf から算出した leaf 集合との集合一致で行う。
 */
export function compositeLeafMismatchReason(
  features: readonly Feature[],
  entry: CliopatriaCompositeParent,
): string | null {
  const nonLeaf = nonLeafNames(features, entry.targetYear);
  const actual = new Set<string>();
  for (const feature of features) {
    const props = feature.properties as unknown as CliopatriaProperties | null;
    if (props === null || typeof props.Name !== "string") continue;
    if (!containsYear(props, entry.targetYear)) continue;
    if (!memberOfNames(props).includes(entry.name)) continue;
    if (nonLeaf.has(props.Name)) continue;
    actual.add(props.Name);
  }
  const expected = new Set(entry.childNames);
  const missing = [...expected].filter((name) => !actual.has(name)).sort();
  const added = [...actual].filter((name) => !expected.has(name)).sort();
  if (missing.length === 0 && added.length === 0) return null;
  return `${entry.targetYear} 年の ${entry.name}: 上流の leaf 構成が ` +
    "CLIOPATRIA_COMPOSITE_PARENTS の childNames とずれています" +
    (missing.length === 0 ? "" : `（上流から消えた: ${missing.join(", ")}）`) +
    (added.length === 0 ? "" : `（上流に増えた: ${added.join(", ")}）`) +
    "。許可リストと ADR-0040 の表・data/name-ja.json を同時に更新してください。";
}

/** 区間の幅（狭いほどスナップショット年に固有の記述） */
function intervalWidth(props: CliopatriaProperties): number {
  return props.ToYear - props.FromYear;
}

/**
 * その年に収録する feature を選ぶ（純粋関数）。
 *
 * 1. 構造的な除外（複合体・RELATION・残余カテゴリ）。ただし
 *    CLIOPATRIA_COMPOSITE_PARENTS に全点一致した括弧付き複合体（親）と、
 *    その leaf 子区画だけは base 主権の外周置換のために採る（ADR-0040 / #352）
 * 2. 許可リスト（名前 + その年が許可されていること）と存続区間の包含判定。
 *    ただし CLIOPATRIA_BORROWED_YEARS に載る 1 件だけは、包含判定を通らない
 *    隣接区間からの**年借用**として採る（ADR-0039 / #346）
 * 3. 同じ名前に複数の候補が当たったら、**通常収録が借用より常に優先**する
 *    （ADR-0033 条件 1: 既存の収録が常に優先する）。同種どうしなら
 *    **最も狭い区間** を採り、同幅なら FromYear が小さい方、それも同じなら
 *    Area が大きい方（完全に決定的）。
 * 返り値は NAME 昇順（france_fiefs / hre_fiefs と同じ並びの規約）。
 */
export function selectForYear(
  features: readonly Feature[],
  year: number,
): Feature[] {
  const nonLeaf = nonLeafNames(features, year);
  /** 名前ごとの最良候補（borrowed が null なら通常収録） */
  const best = new Map<
    string,
    {
      feature: Feature;
      borrowed: CliopatriaBorrowedYear | null;
      composite: CliopatriaCompositeRole | null;
    }
  >();
  for (const feature of features) {
    const props = feature.properties as unknown as CliopatriaProperties | null;
    if (props === null || typeof props.Name !== "string") continue;
    const parentEntry = compositeParentEntryFor(props, year);
    const childEntry = parentEntry === null
      ? compositeChildEntryFor(props, year, nonLeaf)
      : null;
    const composite: CliopatriaCompositeRole | null = parentEntry !== null
      ? { role: "parent", entry: parentEntry }
      : childEntry !== null
      ? { role: "child", entry: childEntry }
      : null;
    let borrowed: CliopatriaBorrowedYear | null = null;
    if (composite === null) {
      // ADR-0026 の構造的な除外は据え置き（緩めるのは全点一致した複合体だけ）
      if (cliopatriaExclusionReason(props) !== null) continue;
      borrowed = borrowedEntryFor(props, year);
      if (borrowed === null) {
        if (isExactMoldaviaInterval(props, year)) {
          // #450 の主権政体は一般の name × year 許可へ広げない。
        } else {
          const allowed = allowedYearsFor(props.Name);
          if (allowed === null || !allowed.includes(year)) continue;
          if (!containsYear(props, year)) continue;
        }
      }
    }
    const current = best.get(props.Name);
    if (current === undefined) {
      best.set(props.Name, { feature, borrowed, composite });
      continue;
    }
    if ((current.borrowed === null) !== (borrowed === null)) {
      // 借用と通常収録が競合したら通常収録を採る
      if (borrowed === null) {
        best.set(props.Name, { feature, borrowed, composite });
      }
      continue;
    }
    const a = current.feature.properties as unknown as CliopatriaProperties;
    if (
      intervalWidth(props) < intervalWidth(a) ||
      (intervalWidth(props) === intervalWidth(a) &&
        (props.FromYear < a.FromYear ||
          (props.FromYear === a.FromYear && props.Area > a.Area)))
    ) {
      best.set(props.Name, { feature, borrowed, composite });
    }
  }
  return [...best.values()]
    .map(({ feature, borrowed, composite }): Feature => ({
      ...feature,
      properties: fiefPropertiesOf(
        feature.properties as unknown as CliopatriaProperties,
        year,
        borrowed,
        composite,
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
 *
 * 年借用（ADR-0039）の feature には BORROWED_FROM を足す。START_DATE /
 * END_DATE は上流の区間のままなので、地図が主張するのは「1200 年の境界」では
 * なく「1202–1215 年の出典付き境界を 1200 年の近似として示したもの」になる
 * （ADR-0033 の開示要件）。
 */
export function fiefPropertiesOf(
  props: CliopatriaProperties,
  year: number,
  borrowed: CliopatriaBorrowedYear | null = null,
  composite: CliopatriaCompositeRole | null = null,
): Record<string, unknown> {
  const name = CLIOPATRIA_NAME_OVERRIDES[props.Name] ?? props.Name;
  const isImperial = CLIOPATRIA_HRE_FIEF_NAMES[props.Name] !== undefined;
  // 宗主は三分岐（ADR-0040 / #352）: 帝国領邦 → 帝国、複合体の親子 → 置換
  // 先の base 主権（Poland / Poland-Lithuania）、仏諸侯領 → 持たない
  const isMoldavia = props.Name === "Principality of Moldavia";
  const suzerain = isImperial
    ? HRE_SUZERAIN
    : isMoldavia && year >= 1492
    ? "Ottoman Empire"
    : composite === null
    ? null
    : composite.entry.basePowerName;
  return {
    NAME: name,
    ...(suzerain === null ? {} : { SUBJECTO: suzerain, PARTOF: suzerain }),
    ...(composite === null ? {} : {
      /** parent は base 置換専用（flat には出さない）、child は表示する区画 */
      CLIOPATRIA_COMPOSITE: composite.role,
      CLIOPATRIA_BASE_POWER: composite.entry.basePowerName,
    }),
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
    ...(borrowed === null ? {} : {
      BORROWED_FROM: borrowedFromOf(borrowed),
    }),
  };
}

/** BORROWED_FROM / metadata.borrowedFrom に刻む借用の出所（純粋関数） */
export function borrowedFromOf(
  borrowed: CliopatriaBorrowedYear,
): Record<string, unknown> {
  return {
    targetYear: borrowed.targetYear,
    fromYear: borrowed.fromYear,
    toYear: borrowed.toYear,
    dataset: CLIOPATRIA_SOURCE_NAME,
    commit: CLIOPATRIA_SOURCE_COMMIT,
    seshatId: borrowed.seshatId,
    license: CLIOPATRIA_SOURCE_LICENSE,
    reason: borrowed.reason,
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
  /**
   * 年借用の記録（ADR-0033 の追跡可能性 / ADR-0039）。借用が 1 件も無い年は
   * このキー自体を持たない（既存年の生成物をバイト単位で変えないため）。
   */
  borrowedFrom?: Array<Record<string, unknown>>;
  /**
   * base 主権の外周置換に採った複合体の記録（ADR-0040 / #352）。対象が無い年は
   * このキー自体を持たない（既存年の生成物をバイト単位で変えないため）。
   */
  compositeParents?: Array<Record<string, unknown>>;
}

/** metadata.compositeParents に刻む複合体の出所（純粋関数・ADR-0040） */
export function compositeParentRecordOf(
  entry: CliopatriaCompositeParent,
): Record<string, unknown> {
  return {
    name: entry.name,
    targetYear: entry.targetYear,
    fromYear: entry.fromYear,
    toYear: entry.toYear,
    seshatId: entry.seshatId,
    wikidata: entry.wikidata,
    basePowerName: entry.basePowerName,
    childNames: [...entry.childNames],
    dataset: CLIOPATRIA_SOURCE_NAME,
    commit: CLIOPATRIA_SOURCE_COMMIT,
    license: CLIOPATRIA_SOURCE_LICENSE,
    reason: entry.reason,
  };
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

  // 年借用は暫定措置（ADR-0039）。上流が対象年を直接覆うようになっていたら
  // 近似を配信し続けずにビルドを失敗させ、通常収録への差し替えを促す。
  for (const entry of CLIOPATRIA_BORROWED_YEARS) {
    const superseded = borrowSupersededReason(raw.features, entry);
    if (superseded !== null) throw new Error(superseded);
  }

  // 複合体の leaf 構成（ADR-0040）は許可リストの写しなので、上流の版が変わって
  // ずれたら生成物が静かに変わる前に失敗させる。
  for (const entry of CLIOPATRIA_COMPOSITE_PARENTS) {
    const mismatch = compositeLeafMismatchReason(raw.features, entry);
    if (mismatch !== null) throw new Error(mismatch);
  }

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
    // 1000年のボヘミアは上流との座標同一性を保持する。丸めは配信側で行う。
    if (year === 1000) {
      const bohemia = selected.find((f) =>
        f.properties?.NAME === "Duchy of Bohemia"
      );
      const output = cleaned.features.find((f) =>
        f.properties?.NAME === "Duchy of Bohemia"
      );
      if (bohemia && output) output.geometry = bohemia.geometry;
    }
    const line = formatCleanStats(stats);
    if (line !== null) console.log(`  ${line}`);

    const borrowedRecords = cleaned.features
      .filter((f) => f.properties?.BORROWED_FROM !== undefined)
      .map((f) => ({
        name: String(f.properties?.NAME),
        upstreamName: String(f.properties?.CLIOPATRIA_NAME),
        ...(f.properties?.BORROWED_FROM as Record<string, unknown>),
      }));
    const compositeRecords = CLIOPATRIA_COMPOSITE_PARENTS
      .filter((entry) => entry.targetYear === year)
      .map(compositeParentRecordOf);
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
      ...(borrowedRecords.length === 0 ? {} : {
        borrowedFrom: borrowedRecords,
      }),
      ...(compositeRecords.length === 0 ? {} : {
        compositeParents: compositeRecords,
      }),
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
