/**
 * データ生成物へ出典・ライセンス・境界の確からしさを刻むパイプライン（TASK-109）。
 *
 * 地図には出典もライセンスも確度も異なる 5 系統のデータが同時に載っている
 * （historical-basemaps の base 勢力・OHM の諸侯領・ETH Zürich の HRE 領邦・
 * Natural Earth の河川/山脈/山峰・Reba et al. の都市）。クリック情報パネルが
 * feature 単位で出典を開示できるよう、各生成物の FeatureCollection（cities.json は
 * オブジェクト）の `metadata` に共通キーを持たせる。
 *
 * ## 何が唯一の定義元か（AC #2）
 * 出典の値は**各ビルドスクリプトの定数だけ**から組み立てる（SOURCE_REPO /
 * SOURCE_COMMIT / SOURCE_LICENSE / RIVERS_SOURCE_COMMIT / OHM_SOURCE_LICENSE …）。
 * このファイルは値を持たず、定数を出典レコードへ束ねるだけなので、ピン留め
 * コミットやライセンスを変えれば metadata も自動的に追従する。生成物が古いまま
 * 取り残された場合は scripts/build-attribution_test.ts の
 * 「生成物の metadata が出典定数と一致する」が落ちる。
 *
 * ## なぜ独立した最終段なのか
 * 各ビルドスクリプトへ metadata 生成を配ると、このモジュールが全ビルド
 * スクリプトの定数を import する一方で全ビルドスクリプトがこのモジュールを
 * import する循環になり、定数の初期化順に依存する壊れ方をする。出典の付与を
 * 最終段の 1 スクリプトに集めれば依存は一方向で済み、しかも**ネットワーク不要**に
 * なる（OHM の諸侯領は Overpass の生クエリ由来でピン留めが無く、出典を足すために
 * 再取得すると本タスクと無関係な差分が出てしまう）。
 *
 * 実行順: build-data / build-hre / build-*-fiefs / build-rivers / build-mountains /
 * build-peaks / build-cities → build-fief-flat → build-fief-dedupe →
 * **build-attribution**（最後）。データを再生成したら必ず本スクリプトを流す。
 *
 * 実行: deno task build-attribution
 */

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
import {
  MOUNTAINS_SOURCE_COMMIT,
  MOUNTAINS_SOURCE_LICENSE,
  MOUNTAINS_SOURCE_REPO,
} from "./build-mountains.ts";
import {
  PEAKS_SOURCE_COMMIT,
  PEAKS_SOURCE_LICENSE,
  PEAKS_SOURCE_REPO,
} from "./build-peaks.ts";
import {
  BURINGH_SOURCE_DOI_URL,
  BURINGH_SOURCE_LICENSE,
  CITIES_SOURCE_COMMIT,
  CITIES_SOURCE_REPO,
} from "./build-cities.ts";
import {
  CLIOPATRIA_SOURCE_COMMIT,
  CLIOPATRIA_SOURCE_HOMEPAGE,
  CLIOPATRIA_SOURCE_LICENSE,
  CLIOPATRIA_SOURCE_NAME,
} from "./build-cliopatria-fiefs.ts";

/**
 * 境界の確からしさの区分（AC #3）。
 *
 * ## 4 区分にした根拠
 * データは「境界がどう決まったか」で分かれ、その差は利用者の読み方を変える。
 * それより細かく分けても、区分の違いを裏づける情報がデータ側に無い
 * （例: 諸侯領 1 件ごとの典拠の質は OHM のタグからは分からない）。
 *
 * 1. approximate … 出典自身が「この年代の全境界は概略」と宣言しているもの。
 *    historical-basemaps は BORDERPRECISION（1 = approximate / 2 = moderately
 *    precise / 3 = determined by international law）を feature に持ち、本アプリの
 *    中世〜近世前半（1000〜1530）の生成物は全 feature が 1 だった（実測）。
 *    TASK-80 はこれを根拠に境界をにじませて描いている（src/approximate_borders.ts）。
 *    区間ごとの粗さの違い（長い直線ほど概略）は同タスクの 3 段の描画が担うので、
 *    ここでは出典の宣言をそのまま伝える。
 * 2. simplifiedTreaty … 上流が 2 / 3 を宣言する feature を含むファイル（実測では
 *    1600 年以降。1600 は 71:2、1650 以降はほぼ全て 3）。**上流の宣言をそのまま
 *    「正確」と伝えてはいけない**: 本パイプラインは simplify のトレランス
 *    0.005〜0.1 度（およそ 0.5〜11 km）で頂点を間引き、座標も 3 桁へ丸めてから
 *    配信しているため、条約で確定した境界であっても地図上の線は数 km 規模の
 *    近似になる。TASK-80 のにじみ描画も年代を問わず全年に掛かる（main.ts の
 *    memoizedApproximateBorderData）ので、「描かれている線は概略」という点は
 *    区分 1 と変わらない。違うのは概略になった理由だけで、それを明示する。
 * 3. reconstructed … 領域ごとに存続期間付きで作図された復元。OHM の諸侯領
 *    （start_date / end_date を持つ個別リレーション）と ETH Zürich（Roller）の
 *    HRE 領邦が該当する。base の一括スナップショットより典拠は個別だが、
 *    測量された境界ではないので「概略」であること自体は変わらない。だから
 *    文言にも「概略」を残し、TASK-80 の全体注記と矛盾させない。
 * 4. modernGeneralized … 現代の自然地物を縮尺相当に簡略化した線・面
 *    （Natural Earth の河川・山脈）。そもそも歴史的境界ではなく、当時の流路とも
 *    限らないことを明示する。
 * 5. digitizedFromMapImages … 既存の歴史地図の**画像**をトレース・自動抽出して
 *    得た境界（Cliopatria / TASK-110）。3 の reconstructed と分けるのは、区分の
 *    違いを裏づける情報がデータ側にあるため: Cliopatria は 2014 年に手描きされた
 *    地図画像群から Python で自動抽出し 0.07 度（およそ 7.8 km）で平滑化した
 *    もので、論文自身が「境界は必然的に概略で解釈の余地がある」「過去に遡るほど
 *    不確かさが増す」と明記している。実測でも頂点密度は OHM の 1/4〜1/7
 *    （1000 年の Duchy of Aquitaine が 69 頂点、OHM の 1200 年版が 330 頂点）で、
 *    領域ごとに存続期間付きで作図された 3 とは確からしさの根拠が違う。
 *

 * 点データ（山峰・都市）には付けない。線も面も持たないため「境界の確からしさ」を
 * 語れる対象が無く、無理に区分を与えると位置の精度と取り違えられる。
 *
 * 値を日本語の短文にしているのは、表示側が語彙をハードコードせず metadata の
 * 文字列をそのまま出す契約だから（データ側が語彙を変えても表示側が壊れない）。
 */
export const BORDER_PRECISION = {
  approximate: "概略（出典が全境界を概略と宣言）",
  simplifiedTreaty: "概略（出典は確定境界を含むが、簡略化により数 km の近似）",
  reconstructed: "史料に基づく復元（概略。測量された境界ではない）",
  modernGeneralized: "現代地形の簡略化（歴史的境界ではない）",
  digitizedFromMapImages:
    "史料地図のデジタイズ（概略。手描き地図の自動抽出を 0.07 度で平滑化）",
} as const;

/** 境界の確からしさの区分の値 */
export type BorderPrecision =
  typeof BORDER_PRECISION[keyof typeof BORDER_PRECISION];

/**
 * 生成物の metadata に載せる出典（表示側との契約）。
 * - source: パネルに出すデータセット名
 * - sourceUrl: 取得元 URL
 * - license: ライセンス識別子。値はビルド定数をそのまま使う（表記を整えるために
 *   書き写すと、定数を変えたときに追従漏れが起きるため）
 * - commit: ピン留めコミット。持たない出典（OHM の Overpass・ETH の bitstream
 *   UUID）では省略する
 * - borderPrecision: 境界の確からしさ。点データでは省略する
 */
export interface DataAttribution {
  readonly source: string;
  readonly sourceUrl: string;
  readonly license: string;
  readonly commit?: string;
  readonly borderPrecision?: BorderPrecision;
}

/** metadata に書き出す出典キー（この順に並べる） */
export const ATTRIBUTION_KEYS = [
  "source",
  "sourceUrl",
  "license",
  "commit",
  "borderPrecision",
] as const satisfies readonly (keyof DataAttribution)[];

/** Natural Earth 由来 3 系統の出典レコードを組み立てる（純粋関数） */
function naturalEarth(
  repo: string,
  commit: string,
  license: string,
  borderPrecision?: BorderPrecision,
): DataAttribution {
  return {
    source: "Natural Earth",
    sourceUrl: `https://github.com/${repo}`,
    license,
    commit,
    ...(borderPrecision === undefined ? {} : { borderPrecision }),
  };
}

/**
 * データセット別の出典。値は全てビルドスクリプトの定数から作る（AC #2）。
 *
 * Natural Earth の 3 系統を 1 レコードにまとめないのは、河川・山脈・山峰が
 * それぞれ独自のピン留め定数を持つため。1 つにまとめると片方だけコミットを
 * 更新したときに気付けない。
 */
export const DATA_ATTRIBUTIONS = {
  /**
   * base 勢力（GPL-3.0。派生も同ライセンス）。
   * borderPrecision はここでは決めない: 上流の BORDERPRECISION が年代で変わる
   * ため、ファイルの中身から basePrecisionOf で決める（attributionForDocument）。
   */
  historicalBasemaps: {
    source: "historical-basemaps (aourednik)",
    sourceUrl: `https://github.com/${SOURCE_REPO}`,
    license: SOURCE_LICENSE,
    commit: SOURCE_COMMIT,
  },
  /**
   * 仏・独・伊・ブリテン諸島の諸侯領・政体オーバーレイ
   * （Overpass 由来のためコミットは無い）
   */
  openHistoricalMap: {
    source: "OpenHistoricalMap",
    sourceUrl: OHM_SOURCE_HOMEPAGE,
    license: OHM_SOURCE_LICENSE,
    borderPrecision: BORDER_PRECISION.reconstructed,
  },
  /**
   * 近世 HRE 領邦（CC BY-NC-SA 4.0）。ピン留めは Shapefile の bitstream UUID で
   * コミットではないため commit は持たせない（UUID は build-hre.ts に記録がある）。
   */
  ethHreTerritories: {
    source: "Territories of the Holy Roman Empire (Roller, ETH Zürich)",
    sourceUrl: `https://doi.org/${HRE_SOURCE_DOI}`,
    license: HRE_SOURCE_LICENSE,
    borderPrecision: BORDER_PRECISION.reconstructed,
  },
  /** 主要河川（NE 50m rivers_lake_centerlines） */
  naturalEarthRivers: naturalEarth(
    RIVERS_SOURCE_REPO,
    RIVERS_SOURCE_COMMIT,
    RIVERS_SOURCE_LICENSE,
    BORDER_PRECISION.modernGeneralized,
  ),
  /** 主要山脈（NE 50m geography_regions_polys） */
  naturalEarthMountains: naturalEarth(
    MOUNTAINS_SOURCE_REPO,
    MOUNTAINS_SOURCE_COMMIT,
    MOUNTAINS_SOURCE_LICENSE,
    BORDER_PRECISION.modernGeneralized,
  ),
  /** 主要山峰（NE 10m elevation_points）。点なので境界の区分は付けない */
  naturalEarthPeaks: naturalEarth(
    PEAKS_SOURCE_REPO,
    PEAKS_SOURCE_COMMIT,
    PEAKS_SOURCE_LICENSE,
  ),
  /**
   * OHM の欠落を埋める第 2 の領邦データ（CC BY 4.0・TASK-110 / decision-26）。
   * sourceUrl は DOI ではなく GitHub リポジトリにする: 取得は同リポジトリの
   * コミット SHA でピン留めしており、パネルの commit がその URL から辿れる
   * （historicalBasemaps / citiesReba と同じ「repo + commit」の組）。CC BY 4.0 の
   * 帰属で求められる書誌情報と DOI はフッターの attribution が担う。
   */
  cliopatria: {
    source: CLIOPATRIA_SOURCE_NAME,
    sourceUrl: CLIOPATRIA_SOURCE_HOMEPAGE,
    license: CLIOPATRIA_SOURCE_LICENSE,
    commit: CLIOPATRIA_SOURCE_COMMIT,
    borderPrecision: BORDER_PRECISION.digitizedFromMapImages,
  },
  /**
   * 主要都市の主ソース（#222）: Buringh 2021 "European urban population,
   * 700–2000"（DANS Data Station SSH / CC0-1.0）。点なので境界の区分は付けない。
   * 上流にコミットの概念が無いため commit は持たせない（ピン留めは
   * build-cities.ts の BURINGH_SOURCE_SHA256 = 内容ハッシュ検証が代替する）。
   * cities.json の metadata（データセット全体の出典）はこの主ソースを指し、
   * 都市ごとの出典はデータ側の sources 配列（build-cities.ts が書く）を
   * CityDef.source index で引く（src/cities.ts citySourceMetadata）。
   */
  citiesBuringh: {
    source: "European urban population 700–2000 (Buringh 2021)",
    sourceUrl: BURINGH_SOURCE_DOI_URL,
    license: BURINGH_SOURCE_LICENSE,
  },
  /**
   * 主要都市の補完ソース（Reba, Reitsma & Seto 2016 / Chandler）。Buringh に
   * 無い都市（欧州外縁）だけをこちらから補う。license は
   * CITIES_SOURCE_LICENSE の先頭の識別子だけを採る（同定数は「識別子 +
   * データセット名」の長い表記で、パネルの 1 行には向かないため）。
   * 両者の整合は build-attribution_test.ts が startsWith で見張る。
   */
  citiesReba: {
    source:
      "Historical Urban Population (Reba, Reitsma & Seto 2016; Chandler 系列)",
    sourceUrl: `https://github.com/${CITIES_SOURCE_REPO}`,
    license: "CC BY 4.0",
    commit: CITIES_SOURCE_COMMIT,
  },
} as const satisfies Record<string, DataAttribution>;

/** データセットのキー */
export type DatasetKey = keyof typeof DATA_ATTRIBUTIONS;

/**
 * ファイル名 → データセットの対応（先頭から順に照合する）。
 * 年を含むファイルは年の一覧に依存させず正規表現で受ける（対象年が増えても
 * 対応表を直さずに済む）。`hre_fiefs_*` は OHM 側の規則が先に当たるため、
 * ETH の `hre_<year>` と取り違えない。
 */
const FILE_PATTERNS: readonly (readonly [RegExp, DatasetKey])[] = [
  [/^europe_\d+\.geojson$/, "historicalBasemaps"],
  [/^europe_flat_\d+\.geojson$/, "historicalBasemaps"],
  [/^base_outline_\d+\.geojson$/, "historicalBasemaps"],
  // #326: 沿岸補完の帯（scripts/build-coastal-fill.ts）。base の沿岸区間を
  // 外側へ 30km オフセットして base 自身を差し引いた派生ジオメトリなので、
  // 座標の出所は base と同じ historical-basemaps。feature は上流属性
  // （NAME / BORDERPRECISION 等）を持たない表示専用のマスクで、picking にも
  // 関与しないため、区分は常に approximate に解決する（そもそも 30km の
  // オフセット自体が概略であり、上流が条約線を主張する年でもそれを
  // 引き継がないのが正しい）
  [/^coastal_fill_\d+\.geojson$/, "historicalBasemaps"],
  [
    /^(?:france|hre|italy|britain|sovereign)_fiefs_(?:flat_)?\d+\.geojson$/,
    "openHistoricalMap",
  ],
  // #332: 帝国全域ジオメトリ（scripts/build-hre-realm.ts）。OHM の
  // admin_level=2 / empire=hre 行政境界そのもので、hre_fiefs_* と同一系統・
  // 同一ライセンス（CC0）。flat 化などの派生を持たずそのまま配信される。
  [/^hre_realm_\d+\.geojson$/, "openHistoricalMap"],
  [/^cliopatria_fiefs_(?:flat_)?\d+\.geojson$/, "cliopatria"],
  [/^hre_\d+\.geojson$/, "ethHreTerritories"],
  // #202 / ADR-0033: 隣接年から流用した面（scripts/build-borrowed-fiefs.ts）。
  // 借用元と同じ系統の別ファイルへ置くので、出典・ライセンスも借用元の系統を
  // そのまま引く（borrowed_hre_* は Roller / CC BY-NC-SA 4.0、borrowed_italy_* は
  // OHM / CC0）。1 ファイルに 1 出典という既存の粒度を崩さないための分離で、
  // 「どの年から借りたか」は各ファイルの metadata.borrowedFrom が持つ。
  // #215: flat 版（scripts/build-fief-flat.ts がホスト系統 flat を差し引いた
  // 派生データ。配信・表示はこちら）も同じ系統の出典に解決する。
  [/^borrowed_hre_(?:flat_)?\d+\.geojson$/, "ethHreTerritories"],
  [/^borrowed_italy_(?:flat_)?\d+\.geojson$/, "openHistoricalMap"],
  [/^rivers\.geojson$/, "naturalEarthRivers"],
  [/^mountains\.geojson$/, "naturalEarthMountains"],
  [/^peaks\.geojson$/, "naturalEarthPeaks"],
  // #222: cities.json のデータセット全体の出典は主ソース（Buringh）。補完
  // ソース（Reba/Chandler）由来の都市はデータ側の sources 配列 + source index
  // で個別に解決する（citiesBuringh の doc コメント参照）。
  [/^cities\.json$/, "citiesBuringh"],
];

/**
 * dist へ配信するが出典を持たせないファイルと、その理由（純粋なデータ定義）。
 * 「新しいデータファイルが増えたのに出典が付いていない」ことをテストで
 * 検出するための明示リストで、判断を保留したまま素通りさせない。
 */
export const UNATTRIBUTED_DATA_FILES: Readonly<Record<string, string>> = {
  "index.json":
    "年代一覧とソース情報のインデックス。feature を持たず、パネルの pick 対象にならない",
  "colors.json":
    "色割当（scripts/build-colors.ts が base の NAME から決定的に生成）。外部出典を持たない",
  "name-overrides.json":
    "表記ゆれ・属性補正の宣言。本リポジトリで手当てした定義",
  "name-ja.json": "日本語表記マップ。本リポジトリで付与した表記",
  "known-limitations.json": "既知の制限一覧。本リポジトリで整理したテキスト",
  "power-descriptions.json":
    "年代別の勢力説明（#283）。本リポジトリで執筆した一文要約で、feature も座標も持たず pick 対象にならない（根拠は docs/data-inventory/power-descriptions.md）",
  "fief-dedupe.json":
    "二重表示の解消メタデータ。座標を持たず、pick 対象の feature も持たない",
};

/** ファイル名（data/ 直下の basename）から出典を引く（純粋関数）。無ければ null */
export function attributionForDataFile(
  fileName: string,
): DataAttribution | null {
  for (const [pattern, key] of FILE_PATTERNS) {
    if (pattern.test(fileName)) return DATA_ATTRIBUTIONS[key];
  }
  return null;
}

/** ファイル名（data/ 直下の basename）が base 勢力系かを返す（純粋関数） */
export function isBasemapFile(fileName: string): boolean {
  return attributionForDataFile(fileName) ===
    DATA_ATTRIBUTIONS.historicalBasemaps;
}

/**
 * base 勢力の feature が持つ上流の BORDERPRECISION から区分を決める（純粋関数）。
 *
 * 1 = approximate 以外（2 = moderately precise / 3 = determined by international
 * law）が 1 件でもあれば simplifiedTreaty を採る。「最も精度を主張する feature に
 * 合わせて上げる」のではなく「宣言が割れたら理由を明示する側へ倒す」ことで、
 * 混在するファイル（実測では 1600 年の 71:2）でも過大な精度を主張しない。
 * 値を持たない feature（TASK-101 の封土切り出しでパイプラインが立てた feature）は
 * 判定に使わない。値が 1 件も無い場合は approximate（最も控えめな側）。
 */
export function basePrecisionOf(
  features: readonly { properties?: Record<string, unknown> | null }[],
): BorderPrecision {
  for (const feature of features) {
    const value = feature.properties?.BORDERPRECISION;
    if (value === undefined || value === null) continue;
    if (value !== 1) return BORDER_PRECISION.simplifiedTreaty;
  }
  return BORDER_PRECISION.approximate;
}

/**
 * ファイル名と中身から、その生成物に載せる出典を決める（純粋関数）。
 * base 勢力系だけは中身（BORDERPRECISION の分布）で区分が変わるため、
 * 生成側もテスト側もこの関数を通して同じ結論を得る。
 */
export function attributionForDocument(
  fileName: string,
  doc: AttributableDocument,
): DataAttribution | null {
  const attribution = attributionForDataFile(fileName);
  if (attribution === null || !isBasemapFile(fileName)) return attribution;
  const features = Array.isArray(doc.features)
    ? doc.features as { properties?: Record<string, unknown> | null }[]
    : [];
  return { ...attribution, borderPrecision: basePrecisionOf(features) };
}

/** metadata を持ちうる生成物（GeoJSON も cities.json も対象にできる最小型） */
export type AttributableDocument = Record<string, unknown>;

/**
 * 生成物へ出典を載せた新しいオブジェクトを返す（純粋関数）。
 * 既存の metadata（諸侯領のビルド診断・flat 化の解消記録など）は温存し、
 * 出典キーだけを上書きする。値を持たない出典キー（commit / borderPrecision）は
 * キー自体を作らない（表示側は「あれば出す」契約なので、空の欄が出ない）。
 */
export function withAttribution<T extends AttributableDocument>(
  doc: T,
  attribution: DataAttribution,
): T {
  const existing = (doc.metadata ?? {}) as Record<string, unknown>;
  const added: Record<string, unknown> = {};
  for (const key of ATTRIBUTION_KEYS) {
    const value = attribution[key];
    if (value !== undefined) added[key] = value;
  }
  return { ...doc, metadata: { ...existing, ...added } };
}

/** data/ 直下の生成物（.geojson と cities.json）を列挙する */
async function dataFiles(dir = "data"): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile) continue;
    if (entry.name.endsWith(".geojson") || entry.name === "cities.json") {
      names.push(entry.name);
    }
  }
  return names.sort();
}

/**
 * 出典を載せてシリアライズする（派生データのビルドスクリプト用）。
 *
 * scripts/build-fief-flat.ts / scripts/build-fief-dedupe.ts は自前の metadata
 * （flat 化の解消記録など）で書き出すため、そのままだと入力にあった出典が
 * 派生ファイルから落ちる。アプリがロードするのは派生ファイルの方
 * （src/powers.ts の franceFiefDataUrlFor / baseFillDataUrlFor 等）なので、
 * 落とすとクリックパネルの出典欄が空になる。両スクリプトはここを通して書く。
 *
 * 依存の向き: build-attribution.ts → 各取得スクリプト（定数の参照）の一方向。
 * 逆に build-attribution.ts から build-fief-flat.ts / build-fief-dedupe.ts を
 * import してはならない（循環になり、定数の初期化順に依存して壊れる）。
 */
export function serializeWithAttribution(path: string, doc: unknown): string {
  const fileName = path.startsWith("data/") ? path.slice("data/".length) : path;
  const document = doc as AttributableDocument;
  const attribution = attributionForDocument(fileName, document);
  if (attribution === null) {
    throw new Error(
      `${path} の出典が DATA_ATTRIBUTIONS に登録されていません（scripts/build-attribution.ts）`,
    );
  }
  return serializeDataFile(fileName, withAttribution(document, attribution));
}

/**
 * 生成物ごとのシリアライズ形式を保つ（純粋関数）。
 * .geojson は 1 行（build-data.ts 等と同じ JSON.stringify）、cities.json も
 * 1 行 + 末尾改行（#222 の正規化形式はセル数が多く、字下げすると行数・サイズ
 * とも読める差分にならないため build-cities.ts と同じ 1 行にする）。ここを
 * 揃えないと出典の付与だけでファイル全体が書き換わり、差分が読めなくなる。
 */
export function serializeDataFile(
  fileName: string,
  doc: AttributableDocument,
): string {
  return fileName.endsWith(".geojson")
    ? JSON.stringify(doc)
    : `${JSON.stringify(doc)}\n`;
}

async function main(): Promise<void> {
  let stamped = 0;
  let skipped = 0;
  for (const name of await dataFiles()) {
    if (attributionForDataFile(name) === null) {
      skipped++;
      continue;
    }
    const path = `data/${name}`;
    const doc = JSON.parse(
      await Deno.readTextFile(path),
    ) as AttributableDocument;
    const attribution = attributionForDocument(name, doc)!;
    const text = serializeDataFile(name, withAttribution(doc, attribution));
    await Deno.writeTextFile(path, text);
    stamped++;
    console.log(`${path}: ${attribution.source} / ${attribution.license}`);
  }
  console.log(`出典を付与: ${stamped} 件、対象外: ${skipped} 件`);
}

if (import.meta.main) {
  await main();
}
