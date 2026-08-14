/**
 * データパイプラインスクリプト。
 * - historical-basemaps の world_<year>.geojson × 19 年代を取得（コミット固定）
 * - ヨーロッパ bbox でクリップし、空ジオメトリになった feature を除去
 * - NAME の表記ゆれ・null を name-overrides.json で補正
 * - 上流が王国領・帝国領に一括で含めている封土を、諸侯領オーバーレイの区画で
 *   切り出して独立 feature にする（BASE_FIEF_SPLITS、TASK-101 / TASK-124）
 * - 上流 properties の異常（文字化け・列ずれの異常値・年代間で揺れる SUBJECTO・
 *   誤った宗主）を name-overrides.json の propertyFixes で上書きし、空の
 *   SUBJECTO / PARTOF を NAME（＝独立勢力）に寄せて正規化する（TASK-102。
 *   切り出した封土 feature にも届くよう、上書きは切り出しの後段に置く）
 * - simplify + 座標丸め + ポリゴンのクリーンアップ（自己交差の解消・微小破片の除去、
 *   scripts/clean-polygons.ts）で 1 ファイル SIZE_LIMIT_BYTES 以下に収める
 * - data/europe_<year>.geojson × 19 と data/index.json を生成する
 *
 * ロジックは純粋関数として export しテスト対象にする（scripts/build-data_test.ts）。
 */

import type {
  BBox,
  Feature,
  FeatureCollection,
  Geometry,
  MultiPolygon,
  Polygon,
  Position,
} from "geojson";
import area from "@turf/area";
import bboxClip from "@turf/bbox-clip";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import difference from "@turf/difference";
import { featureCollection, polygon as turfPolygon } from "@turf/helpers";
import intersect from "@turf/intersect";
import simplify from "@turf/simplify";
import truncate from "@turf/truncate";
import union from "@turf/union";
import {
  cleanFeatureCollection,
  type CleanStats,
  formatCleanStats,
  polygonParts,
} from "./clean-polygons.ts";
import { SNAPSHOT_YEARS } from "../src/config.ts";

/** 取得元リポジトリ（出典・ライセンス表記の根拠） */
export const SOURCE_REPO = "aourednik/historical-basemaps";
/** 取得元のピン留めコミット。元データ更新で境界が勝手に変わらないよう固定する */
export const SOURCE_COMMIT = "62d8f1a03a71f2d3ff17f2d166f7553f256bce68";
/** 取得元のライセンス。派生データも同ライセンスで公開する義務がある */
export const SOURCE_LICENSE = "GPL-3.0";

/** ヨーロッパ域の bbox = [西経25°, 北緯34°, 東経60°, 北緯72°] */
export const EUROPE_BBOX: BBox = [-25, 34, 60, 72];

/**
 * 対象スナップショット年。src/config.ts の SNAPSHOT_YEARS を唯一の定義元とし、
 * 二重定義によるドリフトを避ける（docs/app-spec.md §2.1）。
 */
export const YEARS: number[] = [...SNAPSHOT_YEARS];

/**
 * simplify のトレランス候補（昇順）。サイズが limit 以下になる最小トレランス
 * （＝最も詳細を残す結果）を採用する。
 */
export const SIMPLIFY_TOLERANCES: number[] = [0.005, 0.01, 0.02, 0.05, 0.1];

/** 出力 1 ファイルあたりのサイズ上限（バイト）。300 KB を安全側に解釈する */
export const SIZE_LIMIT_BYTES = 300 * 1000;

/**
 * 座標を丸める小数桁数（TASK-130）。
 *
 * アプリのズーム上限は MAX_ZOOM = 8（src/config.ts）で、MapLibre のズーム z では
 * 世界全体が 512·2^z CSS px に写るため、1 px ≈ 40,075km / (512·2^8) · cos(緯度)
 * ≈ 306·cos(緯度) m。ヨーロッパ bbox（緯度 34〜72°）では 1 px ≈ 253〜94 m になる。
 * 小数 3 桁のグリッドは緯度方向 1e-3 度 ≈ 111 m 刻みで、丸め誤差の最大は
 * その半分の約 56 m。px が最も細かい bbox 北端（72°N・1 px ≈ 94 m）でも
 * 1 px 未満に収まり、表示上の劣化は生じない（2 桁だと誤差 ≈ 557 m で 1 px を
 * 超えるため、これ以上は落とせない）。また SIMPLIFY_TOLERANCES の最小値
 * 0.005 度（≈ 556 m）が先に形状の詳細を律速するため、丸めが解像度のボトルネック
 * になることもない。根拠の数値関係は build-data_test.ts が固定する。
 */
export const COORD_PRECISION = 3;

/**
 * raw 領邦データ（data/<source>_fiefs_<year>.geojson）を丸める小数桁数
 * （ADR-0037・#334）。
 *
 * raw 領邦データは**配信されない中間生成物**で、アプリが読むのは重なりを
 * 排他化した派生側（*_fiefs_flat_<year>.geojson と fief-dedupe の出力）である。
 * 派生側は必ず COORD_PRECISION へ丸め直されるため、raw を細かく保っても
 * TASK-130 が得た配信サイズの削減は損なわれない。逆に raw を 3 桁へ落とすと、
 * 差分の union・difference を粗いグリッド上で解く分だけ情報が減るうえ、
 * TASK-130 が「ライブ Overpass 由来の drift 回避のため意図的に再生成しない」と
 * 決めた既存 raw と食い違い、入力不変でも全年・全 feature に差分が出る。
 *
 * 5 桁は上流（OHM / Cliopatria）から取り込んだときの精度で、TASK-130 以前の
 * COORD_PRECISION と同値。この値でピン留め入力の cliopatria を再生成すると
 * コミット済みの data/cliopatria_fiefs_<year>.geojson とジオメトリが一致する。
 * 「raw は上流精度・丸めは配信される派生側で一度だけ」が方針であり、
 * scripts/raw-fief-precision_test.ts がコミット済みデータとの整合を固定する。
 */
export const RAW_FIEF_COORD_PRECISION = 5;

const DATA_DIR = "data";
const OVERRIDES_PATH = `${DATA_DIR}/name-overrides.json`;
const INDEX_PATH = `${DATA_DIR}/index.json`;

/**
 * 年代を限定した properties の上書き（TASK-102）。
 *
 * 上流の properties には、文字化け・列ずれと思われる異常値・年代間で揺れる
 * SUBJECTO が混ざっている。生成物を直接直すと再生成で失われるため、
 * data/name-overrides.json 側に宣言してパイプラインで当てる。
 * 対象 feature は「その年代の、リネーム適用後の NAME」で指定する
 * （renames / suzerains と同じく正規化後の名前をキーにする）。
 */
export interface PropertyFix {
  /** 適用対象の年 */
  years: number[];
  /** 対象 feature の NAME（applyNameOverrides 適用後の値） */
  name: string;
  /** 上書きする properties */
  set: Record<string, string | number | null>;
  /** 上書きの根拠（人間向けの注記。パイプラインは参照しない） */
  note?: string;
}

/**
 * name-overrides.json の構造。
 * - renames: 表記ゆれ・別名のリネームマップ
 * - propertyFixes: 年代付きの properties 上書き（TASK-102）
 *
 * suzerains（宗主補正・TASK-94）は同じファイルに同居するが、ランタイム側
 * （src/suzerain_extent.ts）と色割当（scripts/build-colors.ts）が読むもので、
 * base の生成には関与しないためここでは解釈しない。
 */
export interface NameOverrides {
  renames: Record<string, string>;
  propertyFixes?: PropertyFix[];
}

/** index.json の source フィールド */
export interface SourceMeta {
  repo: string;
  commit: string;
  license: string;
}

/** index.json の内容 */
export interface IndexData {
  years: number[];
  source: SourceMeta;
}

/** ピン留めコミットの raw GeoJSON URL を生成する（純粋関数） */
export function buildSourceUrl(year: number): string {
  return `https://raw.githubusercontent.com/${SOURCE_REPO}/${SOURCE_COMMIT}/geojson/world_${year}.geojson`;
}

/**
 * ジオメトリから空パート（bbox 外のクリップ結果）を除去する（純粋関数）。
 * 残るパートが無ければ null を返す。Polygon / MultiPolygon 以外は null。
 */
function cleanGeometry(geometry: Geometry): Geometry | null {
  if (geometry.type === "Polygon") {
    const rings = geometry.coordinates.filter((ring) => ring.length > 0);
    return rings.length > 0 ? { type: "Polygon", coordinates: rings } : null;
  }
  if (geometry.type === "MultiPolygon") {
    const polygons = geometry.coordinates
      .map((polygon) => polygon.filter((ring) => ring.length > 0))
      .filter((polygon) => polygon.length > 0);
    return polygons.length > 0
      ? { type: "MultiPolygon", coordinates: polygons }
      : null;
  }
  return null;
}

/**
 * bbox でクリップし、空ジオメトリになった feature を除去する（純粋関数）。
 * 元データは全 feature が MultiPolygon。Polygon / MultiPolygon 以外はスキップする。
 */
export function clipToBbox(
  fc: FeatureCollection,
  bbox: BBox,
): FeatureCollection {
  const features: Feature[] = [];
  for (const feature of fc.features) {
    const geometry = feature.geometry;
    if (
      geometry === null ||
      (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")
    ) {
      continue;
    }
    const clipped = bboxClip(
      feature as Feature<Polygon | MultiPolygon>,
      bbox,
    );
    const cleaned = cleanGeometry(clipped.geometry);
    if (cleaned === null) continue;
    features.push({ ...feature, geometry: cleaned });
  }
  return { type: "FeatureCollection", features };
}

/** 値の中から最初の非空文字列を返す（純粋関数）。無ければ null */
function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

/**
 * feature の properties から表示名を解決する（純粋関数）。
 * NAME を優先し、null なら ABBREVN → SUBJECTO → PARTOF の順にフォールバックする。
 * 解決後の名前に overrides.renames のリネームを適用する。全て空なら null。
 */
export function resolveName(
  props: Record<string, unknown>,
  overrides: NameOverrides,
): string | null {
  const base = firstNonEmptyString(
    props.NAME,
    props.ABBREVN,
    props.SUBJECTO,
    props.PARTOF,
  );
  if (base === null) return null;
  return overrides.renames[base] ?? base;
}

/**
 * 全 feature の NAME を resolveName で解決して書き換える（純粋関数）。
 * 他の properties は保持する。
 */
export function applyNameOverrides(
  fc: FeatureCollection,
  overrides: NameOverrides,
): FeatureCollection {
  const features = fc.features.map((feature) => {
    const props = feature.properties ?? {};
    const name = resolveName(props as Record<string, unknown>, overrides);
    return { ...feature, properties: { ...props, NAME: name } };
  });
  return { type: "FeatureCollection", features };
}

/**
 * 指定年に該当する propertyFixes を全 feature へ適用する（純粋関数、TASK-102）。
 *
 * 対象は「NAME が fix.name と一致する feature」。同名 feature が複数あれば全てに
 * 当てる（上流は 1 勢力を複数 feature に分けて持つことがあり、片方だけ直すと
 * 同じ勢力の中で色キーが分かれてしまう）。
 *
 * 該当 feature が 1 件も無い fix は警告する。上流データが更新されて対象が消えた
 * ことに気付かず、直したつもりの異常が復活するのを防ぐ（生成は止めない）。
 */
export function applyPropertyFixes(
  fc: FeatureCollection,
  year: number,
  fixes: readonly PropertyFix[],
  warnFn: (message: string) => void = console.warn,
): FeatureCollection {
  const applicable = fixes.filter((fix) => fix.years.includes(year));
  if (applicable.length === 0) return fc;

  const hits = new Map<PropertyFix, number>(applicable.map((fix) => [fix, 0]));
  const features = fc.features.map((feature) => {
    const props = feature.properties ?? {};
    let patched = props;
    for (const fix of applicable) {
      if (props.NAME !== fix.name) continue;
      hits.set(fix, hits.get(fix)! + 1);
      patched = { ...patched, ...fix.set };
    }
    return patched === props ? feature : { ...feature, properties: patched };
  });
  for (const [fix, count] of hits) {
    if (count === 0) {
      warnFn(
        `${year}: propertyFixes の対象 ${fix.name} が base に無く、上書きが当たりませんでした`,
      );
    }
  }
  return { type: "FeatureCollection", features };
}

/**
 * 空の SUBJECTO / PARTOF を NAME で埋める（純粋関数、TASK-102）。
 *
 * 上流は独立勢力の SUBJECTO / PARTOF を、自己参照（Sweden.SUBJECTO = Sweden）に
 * する feature と、null / 空文字にする feature の両方で持っている。空は「宗主が
 * 不明」ではなく「上位の勢力が無い＝独立」を意味するので、自己参照の側に寄せて
 * 表記を 1 つにする。
 *
 * 表示上の意味は変わらない。空も自己参照も、色キー（powers.ts colorKeyFor）は
 * NAME 単独、宗主キー（suzerain_extent.ts resolveSuzerainKey）は NAME、表示ラベル
 * （info.ts displayLabel）は NAME のみになる。揃えるのは「空か自己参照か」で
 * 分岐する読み手（人・テスト・将来の派生スクリプト）を無くすため。
 *
 * NAME 自体が空の feature（上流がどの勢力にも帰属させていない土地）は対象外。
 * 埋める値が無いうえ、無名のまま中立色で描くのが正しい扱いのため。
 */
export function normalizeSubjectProps(
  fc: FeatureCollection,
): FeatureCollection {
  const features = fc.features.map((feature) => {
    const props = feature.properties ?? {};
    const name = firstNonEmptyString(props.NAME);
    if (name === null) return feature;
    let patched = props;
    for (const key of ["SUBJECTO", "PARTOF"] as const) {
      if (firstNonEmptyString(props[key]) === null) {
        patched = { ...patched, [key]: name };
      }
    }
    return patched === props ? feature : { ...feature, properties: patched };
  });
  return { type: "FeatureCollection", features };
}

/**
 * base の勢力ポリゴンから切り出して独立 feature にする封土の指定（TASK-101）。
 *
 * 上流（historical-basemaps）は「王が名目上の宗主である領域」をまとめて 1 つの
 * 王国ポリゴンにしており、実効支配が及んでいない半独立の封土も王国領として
 * 塗られてしまう。切り出す区画は諸侯領オーバーレイ（OHM 由来）の同名 feature を
 * 使うため、出典を持たない座標を合成することにはならない（decision-18）。
 *
 * ライセンス: 切り出しは base（GPL-3.0）に別系統の形を取り込む操作なので、
 * 入力に使えるのは **混合制約の無いオーバーレイ**に限る。既定は CC0 の
 * オーバーレイ（france_fiefs / hre_fiefs / italy_fiefs）で、加えて CC BY 4.0 の
 * Cliopatria（cliopatria_fiefs_flat_<year>）を認める（ADR-0039・#346。CC BY 4.0
 * は GPL-3.0 派生との混合制約を持たず、要求されるのは帰属表示だけで、それは
 * 既存の attribution パイプライン（build-attribution / audit-attribution・
 * フッターの書誌情報と DOI）が満たしている）。ETH Zürich（Roller）の HRE
 * 領邦データ（CC BY-NC-SA 4.0、hre_<year>）は GPL-3.0 派生と統合してはならない
 * ため、ここには渡さない（decision-2）。
 */
export interface BaseFiefSplit {
  /** 対象年 */
  year: number;
  /** 切り出し元の base 勢力 NAME */
  fromName: string;
  /** 切り出す封土の NAME。オーバーレイ側の NAME と一致させる */
  fiefName: string;
  /**
   * 切り出した feature に与える SUBJECTO。NAME と同じ値（自己参照）なら
   * 独立勢力の扱いになり、色キー（powers.ts colorKeyFor）はオーバーレイと同じ
   * NAME 単独キー、表示ラベル（info.ts displayLabel）は NAME のみ、勢力圏の
   * 外枠（suzerain_extent.ts）は自分だけを囲う。別勢力名（TASK-124 の
   * France / Papal States）なら従属の扱いになり、色キーは複合キー
   * "NAME|SUBJECTO"、外枠は宗主の union に含まれる。
   */
  subjecto: string;
  /** 切り出しに使うオーバーレイ GeoJSON のパス */
  fiefPath: string;
}

/**
 * 適用する切り出しの一覧（TASK-101）。
 *
 * ## ノルマンディー公国（1000 / 1100）
 * 上流の `Kingdom of France` はノルマンディーを含むが、911 年のサン・クレール・
 * シュール・エプト条約以降のノルマンディーはカペー朝の実効支配が及ばない事実上
 * 独立した公国で、フランス王国領として一括表示するのは不正確（カペー朝の実効
 * 支配はイル・ド・フランス周辺に限られる）。
 *
 * SUBJECTO を NAME 自身（＝独立勢力）にする理由:
 * - 1000 年・1100 年とも公はフランス王へ臣従礼を行う立場ではあるが、それは名目に
 *   留まり、王が公領へ実効的な権限を及ぼした事実は無い。decision-19 は宗主補正を
 *   「歴史的に宗主関係が明白でデータが欠いているもの」に限る方針で、名目のみの
 *   この関係は該当しない（明白な例＝ブルターニュ公とは性質が異なる）。
 * - `SUBJECTO = "France"` にすると勢力圏の外枠（TASK-94）は宗主キーの union なので
 *   フランス王国を選んだときの外枠がノルマンディーを囲んだままになり、本タスクが
 *   直そうとしている「フランス王国領として囲われて見える」症状が残る。
 * - 1100 年はノルマンディー公ロベール 2 世とイングランド王ヘンリー 1 世が別人の
 *   英諾分離期（1087〜1106）なので、England 配下に付け替えるのも不正確。
 * - 独立扱いにすると色キーがオーバーレイと同じ `Duchy of Normandy` になり、base の
 *   塗りと諸侯領オーバーレイの色が一致する（colors.json に新キーも増えない）。
 */
export const BASE_FIEF_SPLITS: readonly BaseFiefSplit[] = [
  ...[1000, 1100].map((year): BaseFiefSplit => ({
    year,
    fromName: "Kingdom of France",
    fiefName: "Duchy of Normandy",
    subjecto: "Duchy of Normandy",
    fiefPath: `data/france_fiefs_flat_${year}.geojson`,
  })),
  /**
   * ## 帝国ポリゴンからの仏封土・リミニの切り出し（TASK-124）
   *
   * 上流の 1279 / 1300 年 base は、アルトワ伯領・サンポル伯領・フランドル
   * 伯領（史実ではいずれもフランス王の封土）とリミニ（1278 年にルドルフ 1 世が
   * ロマーニャの帝国権を教皇ニコラウス 3 世へ譲渡済み）を、単一の
   * Holy Roman Empire MultiPolygon に含めて塗っている。該当地域に独立の
   * feature が存在しないため propertyFixes（properties の上書きのみ・
   * decision-20）では届かず、まずここで OHM 由来の同名区画 ∩ 帝国ポリゴンを
   * 切り出して feature を立てる。宗主（SUBJECTO / PARTOF = France /
   * Papal States）の宣言と年号付きの根拠は data/name-overrides.json の
   * propertyFixes 側に置き、「形状の出所は OHM（decision-18）・帰属の是正は
   * propertyFixes（decision-20）」という既存の分担を保つ（subjecto は
   * 切り出し直後から正しい宗主にしておき、後段の propertyFixes が PARTOF を
   * 含めて確定させる）。
   *
   * ノルマンディー（独立 = 自己参照）と違い宗主を France にするのは、これらが
   * 「王の実効支配が及ばない半独立の封土」ではなく「上流が誤って帝国側に
   * 塗った王の封土」だから。SUBJECTO=France により勢力圏の外枠
   * （suzerain_extent.ts）はフランス王国の union に含まれ、諸侯領オーバーレイの
   * ホバーも包含判定（containingSuzerainKey）でフランスの外枠に解決する。
   *
   * リミニは italy_fiefs に feature がある 1300 年のみ。1279 年の
   * ロマーニャ一帯も同じ根拠（1278 年譲渡）で帝国塗りは誤りだが、切り出しに
   * 使える出典付きの区画が無く（decision-14 / decision-18: 出典を持たない
   * 座標は合成しない）、known-limitations に明記して残す。
   */
  ...[1279, 1300].flatMap((year): BaseFiefSplit[] => [
    {
      year,
      fromName: "Holy Roman Empire",
      fiefName: "County of Artois",
      subjecto: "France",
      fiefPath: `data/france_fiefs_flat_${year}.geojson`,
    },
    {
      year,
      fromName: "Holy Roman Empire",
      fiefName: "Counts of Saint-Pol",
      subjecto: "France",
      fiefPath: `data/france_fiefs_flat_${year}.geojson`,
    },
    {
      year,
      fromName: "Holy Roman Empire",
      fiefName: "County of Flanders",
      subjecto: "France",
      fiefPath: `data/france_fiefs_flat_${year}.geojson`,
    },
  ]),
  {
    year: 1300,
    fromName: "Holy Roman Empire",
    fiefName: "Lordship of Rimini",
    subjecto: "Papal States",
    fiefPath: "data/italy_fiefs_flat_1300.geojson",
  },
  /**
   * ## ポーランド塗りボヘミア・モラヴィアの切り出し（TASK-157）
   *
   * 上流の 1100 / 1200 年 base はプラハ・ブルノを含むボヘミア・モラヴィア一帯を
   * 単一の Poland ポリゴンに含めて塗っているが、史実では 1100 年は帝国内の
   * ボヘミア公領（ボジヴォイ 2 世）、1200 年は帝国内のボヘミア王国
   * （プシェミスル・オタカル 1 世、1198 年に王号取得）で、いずれもポーランドの
   * 領域ではない。decision-28 と同型の事案として、OHM 由来の区画 ∩ Poland を
   * 切り出して feature を立て、宗主（SUBJECTO / PARTOF = Holy Roman Empire）の
   * 宣言と年号付きの根拠は data/name-overrides.json の propertyFixes 側に置く。
   *
   * 切り出しに使える OHM 由来の区画は 1100 年の Duchy of Bohemia
   * （リレーション 2805282、1017〜1100）と 1200 年の Moravia
   * （リレーション 2830504、1182〜1742）のみ。
   *
   * ## 1200 年のボヘミア本体（#346 / ADR-0039）
   *
   * TASK-157 時点では 1200 年を覆う区画が上流のどこにも無く（OHM の
   * Duchy of Bohemia は end_date 1100、Cliopatria の Kingdom of Bohemia は
   * FromYear 1202）、形状を合成しない方針（decision-14 / decision-18）に従って
   * Poland 塗りのまま known-limitations に残していた。#346 で ADR-0039 を定め、
   * Cliopatria の隣接区間 [1202-1215] を 1200 年へ座標無改変で借用したので、
   * その flat（= より細かい OHM の Moravia を差し引き済み。ADR-0026 /
   * ADR-0035）を切り出し元に使ってボヘミア王国を立てる。Moravia の切り出しを
   * 先に置くのは並び（＝描画順）を決定的にするためで、借用面は flat の段階で
   * すでに Moravia を含まないため同じ土地を二度切り出すことにはならない。
   */
  {
    year: 1100,
    fromName: "Poland",
    fiefName: "Duchy of Bohemia",
    subjecto: "Holy Roman Empire",
    fiefPath: "data/hre_fiefs_flat_1100.geojson",
  },
  {
    year: 1200,
    fromName: "Poland",
    fiefName: "Moravia",
    subjecto: "Holy Roman Empire",
    fiefPath: "data/hre_fiefs_flat_1200.geojson",
  },
  {
    year: 1200,
    fromName: "Poland",
    fiefName: "Kingdom of Bohemia",
    subjecto: "Holy Roman Empire",
    fiefPath: "data/cliopatria_fiefs_flat_1200.geojson",
  },
];

/**
 * base 主権の**外周そのもの**を別出典のポリゴンで置き換える指定
 * （ADR-0040 / #352）。
 *
 * BASE_FIEF_SPLITS が「1 枚の勢力ポリゴンから内訳を切り出す」操作なのに対し、
 * こちらは「勢力ポリゴンの輪郭を丸ごと入れ替える」操作である。上流
 * （historical-basemaps・BORDERPRECISION=1）のポリゴンが世界・大陸スケール用の
 * 概略で、外周が少数の長大な直線で構成されている年代に限って使う。
 *
 * NAME・SUBJECTO・PARTOF・色キー・ラベルは base の語彙のまま据え置き、
 * 変わるのは座標だけ。内訳（子区画）は Cliopatria オーバーレイ側が担う。
 *
 * ライセンス: BASE_FIEF_SPLITS と同じ制約が効く（ADR-0039 決定 3）。入力は
 * 混合制約の無いオーバーレイに限り、CC BY 4.0 の Cliopatria は認める。
 */
export interface BasePowerReplacement {
  /** 対象年 */
  year: number;
  /** 置換する base 勢力の NAME */
  fromName: string;
  /** 置換元 GeoJSON のパス（Cliopatria の raw。親は flat に出ない） */
  sourcePath: string;
  /** 置換元ファイル内の NAME（括弧付き複合体の親） */
  sourceName: string;
  /** 置換の根拠（人間向けの注記。パイプラインは参照しない） */
  note: string;
  /**
   * 旧外周にしか無い連結成分のうち、**置換した勢力へ残す**もの（内点で指定）。
   *
   * 既定は #342 と同じ「共有境界が最長の隣接へ併合」だが、置換元が対象年の
   * 領域を過小に描いている場合は、機械的な併合先が歴史的に成立しないことが
   * ある（1279 / 1300 のクラクフ周辺は上流 Cliopatria の外に出るため、共有境界
   * 最長の Hungary へ渡ってしまう）。無根拠な帰属を避けるため、成分の内点と
   * 根拠を明示して置換した勢力に残す。ADR-0040 決定 4 の「実測判断」の実体で、
   * 列挙した点を含む成分だけが対象になる。
   */
  retainedRemainders?: readonly { point: [number, number]; reason: string }[];
}

/**
 * 適用する置換の一覧（ADR-0040 / #352）。
 *
 * 対象は 1000〜1400 年のポーランド（1400 年はポーランド・リトアニア）。
 * 上流 base の外周は最長線分 312.4 / 264.4 / 183.9 / 116.5 / 115.3 / 841.7 km で、
 * 地図の縮尺に対して定規で引いたような直線になっていた。Cliopatria には 6 年とも
 * **対象年を直接覆う区間**の括弧付き複合体があり、置換すると最長線分は
 * 74.4 / 90.2 / 75.5 / 110.7 / 110.7 / 195.4 km まで下がる。
 *
 * 置換元は Cliopatria の **raw**（`cliopatria_fiefs_<year>.geojson`）を指す。
 * 親は「base 置換専用」で配信される flat には出さないため（ADR-0040 決定 3）、
 * flat を指すと解決できない。
 */
export const BASE_POWER_REPLACEMENTS: readonly BasePowerReplacement[] = [
  ...[1000, 1100].map((year): BasePowerReplacement => ({
    year,
    fromName: "Poland",
    sourcePath: `data/cliopatria_fiefs_${year}.geojson`,
    sourceName: "(Kingdom of Poland)",
    note:
      "上流 base のピャスト朝ポーランドは最長線分 312.4 km（1000）/ 264.4 km" +
      "（1100）の概略ポリゴン。Cliopatria の [990-1002] / [1056-1125] へ" +
      "置き換えると 74.4 km / 90.2 km になり、100 km 超の単一線分が消える。",
  })),
  ...[1200, 1279, 1300].map((year): BasePowerReplacement => ({
    year,
    fromName: "Poland",
    sourcePath: `data/cliopatria_fiefs_${year}.geojson`,
    sourceName: "(Duchies of Poland)",
    note: "分割期のポーランド。上流 base はプラハ・ブルノまで呑み込んだうえ" +
      "外周が長大な直線で構成される。Cliopatria の諸公国複合体へ置き換え、" +
      "内訳は同じ出典の leaf 子区画（1200: 6 / 1279: 9 / 1300: 11）が担う。",
    // 1279 / 1300 の上流 (Duchies of Poland) はクラクフ（小ポーランド）を
    // 含まない。共有境界が最長の隣接は Hungary になるが、クラクフはピャスト朝の
    // 宗主権を象徴する都市でハンガリー領だった事実は無い。1200 年の上流は
    // クラクフを含むので指定しない。
    ...(year === 1200 ? {} : {
      retainedRemainders: [{
        point: [19.94, 50.06] as [number, number],
        reason:
          "クラクフを含む小ポーランドは上流 Cliopatria の (Duchies of Poland) " +
          "の外に出るが、共有境界が最長の隣接（Hungary）はこの土地を支配して" +
          "いない。無根拠な帰属を避けるため置換した Poland に残す（#352）。",
      }],
    }),
  })),
  {
    year: 1400,
    fromName: "Poland-Lithuania",
    sourcePath: "data/cliopatria_fiefs_1400.geojson",
    sourceName: "(Polish-Lithuania Kingdom)",
    note: "上流 base の東部境界は 841.7 km の 1 本の直線。Cliopatria の " +
      "[1395-1401] へ置き換えると最長 195.4 km になり、内訳は leaf 2 件" +
      "（Kingdom of Poland / Grand Duchy of Lithuania）が担う。",
  },
];

/** ポリゴン系ジオメトリを持つ feature か */
function isPolygonal(
  feature: Feature,
): feature is Feature<Polygon | MultiPolygon> {
  const type = feature.geometry?.type;
  return type === "Polygon" || type === "MultiPolygon";
}

/**
 * FeatureCollection から NAME が一致するポリゴンを 1 つに統合する（純粋関数）。
 * 該当が無ければ null。
 */
export function unionByName(
  fc: FeatureCollection,
  name: string,
): Feature<Polygon | MultiPolygon> | null {
  let merged: Feature<Polygon | MultiPolygon> | null = null;
  for (const feature of fc.features) {
    if (feature.properties?.NAME !== name || !isPolygonal(feature)) continue;
    merged = merged === null
      ? feature
      : union(featureCollection([merged, feature])) ?? merged;
  }
  return merged;
}

/** パート配列からポリゴン系ジオメトリを組み立てる（純粋関数） */
function geometryFromParts(parts: Position[][][]): Polygon | MultiPolygon {
  return parts.length === 1
    ? { type: "Polygon", coordinates: parts[0] }
    : { type: "MultiPolygon", coordinates: parts };
}

/**
 * 2 点間の距離（度）。経度差は緯度で縮むので cos 補正して長さの比較に使う。
 * 共有境界の「長さ」の比較にしか使わないため、測地線ではなく平面近似で足りる。
 */
function segmentLength(a: Position, b: Position): number {
  const meanLat = ((a[1] + b[1]) / 2) * Math.PI / 180;
  return Math.hypot((a[0] - b[0]) * Math.cos(meanLat), a[1] - b[1]);
}

/**
 * パートの外環のうち candidate と共有している境界の長さ（純粋関数、#342）。
 *
 * base 勢力は上流で隙間なく塗り分けられており、隣り合う勢力は同じ境界線の
 * 座標列を共有する。したがって共有区間の頂点は相手のポリゴンの辺の上に載り、
 * 点包含（境界を含む判定）が true になる。両端がともに相手に載っている辺を
 * 共有区間とみなして長さを合計する（片端だけの辺＝共有区間の端で直角に
 * 折れる辺を数えないよう、辺の単位で見る）。
 */
function sharedBoundaryLength(
  part: Position[][],
  candidate: Feature<Polygon | MultiPolygon>,
): { length: number; vertices: number } {
  const ring = part[0];
  let length = 0;
  let vertices = 0;
  let previousOn = booleanPointInPolygon(
    ring[0] as [number, number],
    candidate,
  );
  if (previousOn) vertices++;
  for (let i = 1; i < ring.length - 1; i++) {
    const on = booleanPointInPolygon(ring[i] as [number, number], candidate);
    if (on) vertices++;
    if (previousOn && on) length += segmentLength(ring[i - 1], ring[i]);
    previousOn = on;
  }
  // 閉じた環の最後の辺（末尾の点は先頭と同じなので頂点は数え直さない）
  const first = booleanPointInPolygon(ring[0] as [number, number], candidate);
  if (previousOn && first) {
    length += segmentLength(ring[ring.length - 2], ring[ring.length - 1]);
  }
  return { length, vertices };
}

/** ジオメトリのパートのうち、点を最も多く含むものの添字（純粋関数） */
function dominantPartIndex(ring: Position[], parts: Position[][][]): number {
  if (parts.length === 1) return 0;
  let best = 0;
  let bestHits = -1;
  for (const [index, part] of parts.entries()) {
    const polygon = turfPolygon(part);
    let hits = 0;
    for (const position of ring) {
      if (booleanPointInPolygon(position as [number, number], polygon)) hits++;
    }
    if (hits > bestHits) {
      bestHits = hits;
      best = index;
    }
  }
  return best;
}

/**
 * base の勢力 feature から封土の区画を差し引き、独立した封土 feature を
 * 同じ FeatureCollection に立てる（純粋関数、TASK-101）。
 *
 * 封土のジオメトリは「オーバーレイの区画 ∩ 切り出し元の勢力」にする。オーバーレイ
 * （OHM）と base（historical-basemaps）は解像度も海岸線も異なるため、オーバーレイを
 * そのまま置くと base の外へはみ出して海や隣国に重なる。交差を取れば base の
 * 面の内訳が入れ替わるだけになり、他勢力の領域には一切触れない。
 *
 * 差し引きで面が残らなかった元 feature は落とす（飛び地が丸ごと封土だった場合）。
 * 切り出し元が見つからない・交差が空の場合は警告して base をそのまま返す
 * （生成を失敗させない）。
 *
 * 切り出しで元勢力が分断されて生じる残余の始末は、その年の切り出しを全て終えた
 * 後段（mergeSeveredRemainders、#342）が行う。
 */
export function splitFiefFromBase(
  base: FeatureCollection,
  fief: Feature<Polygon | MultiPolygon>,
  split: BaseFiefSplit,
  warnFn: (message: string) => void = console.warn,
): FeatureCollection {
  const sourceIndexes = base.features
    .map((feature, index) =>
      feature.properties?.NAME === split.fromName && isPolygonal(feature)
        ? index
        : -1
    )
    .filter((index) => index >= 0);
  if (sourceIndexes.length === 0) {
    warnFn(
      `${split.year}: ${split.fromName} が base に無いため ${split.fiefName} を切り出せません`,
    );
    return base;
  }

  let carved: Feature<Polygon | MultiPolygon> | null = null;
  const remainders = new Map<number, Feature | null>();
  for (const index of sourceIndexes) {
    const source = base.features[index] as Feature<Polygon | MultiPolygon>;
    const overlap = intersect(featureCollection([source, fief]));
    if (overlap !== null) {
      carved = carved === null
        ? overlap
        : union(featureCollection([carved, overlap])) ?? carved;
    }
    const rest = difference(featureCollection([source, fief]));
    remainders.set(
      index,
      rest === null ? null : { ...source, geometry: rest.geometry },
    );
  }
  if (carved === null) {
    warnFn(
      `${split.year}: ${split.fiefName} が ${split.fromName} と交差しないため切り出しません`,
    );
    return base;
  }

  const fiefFeature: Feature = {
    type: "Feature",
    properties: { NAME: split.fiefName, SUBJECTO: split.subjecto },
    geometry: carved.geometry,
  };
  const lastSourceIndex = sourceIndexes[sourceIndexes.length - 1];
  const features: Feature[] = [];
  for (const [index, feature] of base.features.entries()) {
    if (remainders.has(index)) {
      const rest = remainders.get(index)!;
      if (rest !== null) features.push(rest);
    } else {
      features.push(feature);
    }
    // 封土は切り出し元の直後に置き、feature の並び（＝描画順）を決定的にする
    if (index === lastSourceIndex) features.push(fiefFeature);
  }
  return { type: "FeatureCollection", features };
}

/**
 * 切り出しで分断された残余を隣接勢力へ付け替える（純粋関数、#342）。
 *
 * ## 何を分断された残余と呼ぶか
 *
 * 上流（historical-basemaps）が封土の区画より広く塗っていると、封土を引いた
 * 残りが複数の連結成分に割れる。割れた成分のうち最大のもの以外は、封土を
 * 跨がないと本体へたどり着けない位置にある = 切り出しの根拠（「その区画は
 * 元勢力の領域ではない」）がそのまま及ぶ塗り過ぎの続きなので、元勢力には
 * 残さない。判定は「切り出し前の元勢力のどのポリゴン由来か」でまとめてから
 * 行うため、元から別ポリゴンだった飛び地（島・飛び地）は自分自身が最大成分に
 * なり必ず残る。年代・勢力名の列挙は一切持たず、切り出しの性質だけから決まる。
 *
 * ## なぜ落とさず付け替えるか
 *
 * base 勢力は上流で隙間なく塗り分けられているため、単に落とすと地図に穴が
 * 空く（概観表示は諸侯領オーバーレイに隠れないので、穴がそのまま見える）。
 * そこで**その成分と境界を最も長く共有している隣接 feature へ併合する**。
 * 共有境界の長さは隣接そのものの尺度で、上流が同じ境界線の座標列を両側で
 * 共有していることを使って測れる（sharedBoundaryLength）。併合先の候補から
 * 外すのは次の 2 つだけ:
 *
 * - 分断元の勢力自身（分断された成分は定義上そこへは戻せない）
 * - 同じ年に BASE_FIEF_SPLITS が立てる封土 feature。封土は「OHM 区画 ∩ 元勢力」
 *   でなければならず（decision-18）、広げるとオーバーレイとの被覆率が 1 を
 *   割って派生側（fief-dedupe / europe_flat）の前提が崩れる
 *
 * 隣接 feature が見つからない成分だけは警告して落とす（穴が空くが、帰属先を
 * 決める根拠が無い以上どこかへ足すのは座標の合成に等しい）。
 *
 * ## なぜ切り出しの後段に置くか
 *
 * 同じ年に同じ勢力から複数の封土を切り出すことがあり（1279 / 1300 の帝国）、
 * 後の切り出しが前の切り出しで分断された成分の中の区画を使う（Counts of
 * Saint-Pol は County of Artois の切り出しで分断される成分の中にある）。
 * 切り出しの途中で付け替えると後続の切り出しが元勢力を見つけられなくなるため、
 * その年の切り出しを全て終えてから、切り出し前の状態と突き合わせて判定する。
 */
export function mergeSeveredRemainders(
  original: FeatureCollection,
  split: FeatureCollection,
  year: number,
  warnFn: (message: string) => void = console.warn,
): FeatureCollection {
  const splits = BASE_FIEF_SPLITS.filter((s) => s.year === year);
  if (splits.length === 0) return split;
  // 同じ年に立てる封土は「OHM 区画 ∩ 元勢力」のまま保つため候補から外す
  const fiefNames = new Set(splits.map((s) => s.fiefName));
  const features = [...split.features];
  // 全パートが分断された成分だった feature（面が残らないので出力から落とす）
  const emptied = new Set<number>();
  for (const fromName of new Set(splits.map((s) => s.fromName))) {
    const sourceParts = original.features
      .filter((f) => f.properties?.NAME === fromName && isPolygonal(f))
      .flatMap((f) =>
        polygonParts((f as Feature<Polygon | MultiPolygon>).geometry)
      );
    if (sourceParts.length === 0) continue;
    // 切り出し後の同名 feature のパートを、切り出し前のどのポリゴン由来かで束ねる
    const groups = new Map<number, Array<{ feature: number; part: number }>>();
    for (const [index, feature] of features.entries()) {
      if (feature.properties?.NAME !== fromName || !isPolygonal(feature)) {
        continue;
      }
      const geometry = (feature as Feature<Polygon | MultiPolygon>).geometry;
      for (const [part, ring] of polygonParts(geometry).entries()) {
        const owner = dominantPartIndex(ring[0], sourceParts);
        groups.set(owner, [...(groups.get(owner) ?? []), {
          feature: index,
          part,
        }]);
      }
    }
    const severed: Array<{ feature: number; part: number }> = [];
    for (const members of groups.values()) {
      if (members.length <= 1) continue;
      const areas = members.map(({ feature, part }) =>
        area(turfPolygon(partAt(split.features[feature], part)))
      );
      const main = areas.indexOf(Math.max(...areas));
      severed.push(...members.filter((_, index) => index !== main));
    }
    if (severed.length === 0) continue;
    for (const index of new Set(severed.map((s) => s.feature))) {
      const dropped = new Set(
        severed.filter((s) => s.feature === index).map((s) => s.part),
      );
      const feature = features[index] as Feature<Polygon | MultiPolygon>;
      const kept = polygonParts(feature.geometry)
        .filter((_, part) => !dropped.has(part));
      if (kept.length === 0) emptied.add(index);
      else features[index] = { ...feature, geometry: geometryFromParts(kept) };
    }
    for (const { feature, part } of severed) {
      mergeIntoNeighbour(
        features,
        partAt(split.features[feature], part),
        { fromName, fiefNames, year },
        warnFn,
      );
    }
  }
  return {
    type: "FeatureCollection",
    features: features.filter((_, index) => !emptied.has(index)),
  };
}

/** feature の n 番目のパート（リング配列）を返す */
function partAt(feature: Feature, index: number): Position[][] {
  return polygonParts(
    (feature as Feature<Polygon | MultiPolygon>).geometry,
  )[index];
}

/**
 * 分断された成分を、境界を最も長く共有する隣接 feature へ併合する（#342）。
 * features を破壊的に更新する（呼び出し元が作ったコピーだけを渡すこと）。
 */
function mergeIntoNeighbour(
  features: Feature[],
  part: Position[][],
  context: { fromName: string; fiefNames: Set<string>; year: number },
  warnFn: (message: string) => void,
): void {
  const polygon = turfPolygon(part);
  const size = (area(polygon) / 1e6).toFixed(0);
  let bestIndex = -1;
  let best = { length: 0, vertices: 0 };
  for (const [index, feature] of features.entries()) {
    const name = String(feature.properties?.NAME);
    if (name === context.fromName || context.fiefNames.has(name)) continue;
    if (!isPolygonal(feature)) continue;
    const shared = sharedBoundaryLength(part, feature);
    if (shared.length === 0 && shared.vertices === 0) continue;
    // 共有辺の長さで比べ、辺を共有しない（点でしか触れていない）ときだけ
    // 共有頂点数で比べる
    const better = shared.length > best.length ||
      (shared.length === best.length && shared.vertices > best.vertices);
    if (better) {
      best = shared;
      bestIndex = index;
    }
  }
  if (bestIndex < 0) {
    warnFn(
      `${context.year}: ${context.fromName} から分断された残余 ${size} km² は隣接勢力が見つからないため落とします`,
    );
    return;
  }
  const neighbour = features[bestIndex] as Feature<Polygon | MultiPolygon>;
  const grown = union(featureCollection([neighbour, polygon]));
  if (grown === null) return;
  features[bestIndex] = { ...neighbour, geometry: grown.geometry };
  warnFn(
    `${context.year}: ${context.fromName} から分断された残余 ${size} km² を ${neighbour.properties?.NAME} へ併合しました`,
  );
}

/**
 * base 勢力の外周を別出典のポリゴンで置き換える（純粋関数・ADR-0040 / #352）。
 *
 * base は上流で隙間なく塗り分けられているため、外周を入れ替えるだけでは
 * 「新しい外周が隣国へはみ出す」「旧外周との差分が誰にも塗られない穴になる」の
 * 2 つが同時に起きる。どちらも放置できないので次の 3 段で始末する。
 *
 * 1. **置換**: 対象 NAME の feature を 1 件に畳み、ジオメトリを置換元にする
 *    （NAME / SUBJECTO / PARTOF などの properties は据え置き）。
 * 2. **はみ出しの差し引き**: 置換元と重なる他の feature から重なりを引く。
 *    同じ土地を二度塗らないための操作で、面が残らなかった feature は落とす。
 * 3. **残余の再配分**: 旧ポリゴンにしか無い領域を連結成分に分け、#342 の
 *    mergeSeveredRemainders と同じ規則で**共有境界が最長の隣接勢力へ併合**する。
 *    落として穴にすると、概観表示ではオーバーレイに隠れないため穴がそのまま
 *    見える。併合先の候補から外すのは「置換した勢力自身」と「同じ年に
 *    BASE_FIEF_SPLITS が立てる封土」の 2 つだけ（封土は
 *    「オーバーレイ区画 ∩ 元勢力」でなければならず、広げると派生側の前提が
 *    崩れる）。隣接が見つからない成分は警告して落とす。
 *
 * 置換元が見つからない・対象 NAME が base に無い場合は警告して base をその
 * まま返す（生成を失敗させない。splitFiefFromBase と同じ縮退）。
 */
export function replaceBasePower(
  base: FeatureCollection,
  replacement: Feature<Polygon | MultiPolygon>,
  spec: BasePowerReplacement,
  warnFn: (message: string) => void = console.warn,
): FeatureCollection {
  const targetIndexes = base.features
    .map((feature, index) =>
      feature.properties?.NAME === spec.fromName && isPolygonal(feature)
        ? index
        : -1
    )
    .filter((index) => index >= 0);
  if (targetIndexes.length === 0) {
    warnFn(
      `${spec.year}: ${spec.fromName} が base に無いため外周を置換できません`,
    );
    return base;
  }
  let old: Feature<Polygon | MultiPolygon> | null = null;
  for (const index of targetIndexes) {
    const feature = base.features[index] as Feature<Polygon | MultiPolygon>;
    old = old === null
      ? feature
      : union(featureCollection([old, feature])) ?? old;
  }

  const keptIndex = targetIndexes[0];
  const dropped = new Set(targetIndexes.slice(1));
  const features: Feature[] = [];
  for (const [index, feature] of base.features.entries()) {
    if (dropped.has(index)) continue;
    if (index === keptIndex) {
      features.push({ ...feature, geometry: replacement.geometry });
      continue;
    }
    if (!isPolygonal(feature)) {
      features.push(feature);
      continue;
    }
    const rest = difference(featureCollection([feature, replacement]));
    if (rest === null) {
      warnFn(
        `${spec.year}: ${feature.properties?.NAME} は ${spec.fromName} の新しい外周に` +
          "完全に覆われるため落とします",
      );
      continue;
    }
    features.push({ ...feature, geometry: rest.geometry });
  }

  const severed = difference(featureCollection([old!, replacement]));
  if (severed !== null) {
    const fiefNames = new Set(
      BASE_FIEF_SPLITS.filter((s) => s.year === spec.year).map((s) =>
        s.fiefName
      ),
    );
    const keptIndexAfter = features.findIndex((f) =>
      f.properties?.NAME === spec.fromName
    );
    for (const part of polygonParts(severed.geometry)) {
      const polygon = turfPolygon(part);
      const retained = (spec.retainedRemainders ?? []).find((r) =>
        booleanPointInPolygon(r.point, polygon)
      );
      if (retained !== undefined) {
        const target = features[keptIndexAfter] as Feature<
          Polygon | MultiPolygon
        >;
        const grown = union(featureCollection([target, polygon]));
        if (grown !== null) {
          features[keptIndexAfter] = { ...target, geometry: grown.geometry };
        }
        warnFn(
          `${spec.year}: ${spec.fromName} の旧外周の残余 ${
            (area(polygon) / 1e6).toFixed(0)
          } km² は ${spec.fromName} に残します（${retained.reason}）`,
        );
        continue;
      }
      mergeIntoNeighbour(
        features,
        part,
        { fromName: spec.fromName, fiefNames, year: spec.year },
        warnFn,
      );
    }
  }
  return { type: "FeatureCollection", features };
}

/** index.json の内容を生成する（純粋関数） */
export function buildIndex(years: number[], source: SourceMeta): IndexData {
  return {
    years: [...years],
    source: {
      repo: source.repo,
      commit: source.commit,
      license: source.license,
    },
  };
}

/** UTF-8 でシリアライズしたときのバイト数を返す */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * simplify・座標丸め・ポリゴンのクリーンアップで FeatureCollection を
 * limitBytes 以下に収める（純粋関数）。
 * tolerances を昇順に試し、シリアライズ後サイズが limit 以下になる最小トレランスの
 * 結果を返す。どのトレランスでも超える場合はエラーを投げる。
 *
 * クリーンアップ（自己交差の解消と微小破片・微小な穴の除去、TASK-81）は
 * simplify の後段に置く。simplify 自体が自己交差を生む（凹んだ海岸線を粗くすると
 * 辺が交差する）ため、前段に置いても意味が無い。サイズ判定はクリーンアップ後の
 * 出力に対して行うので、生成物は必ず limit 以下になる。
 * 詳細は scripts/clean-polygons.ts を参照。
 */
export function shrinkToLimit(
  fc: FeatureCollection,
  limitBytes: number,
  tolerances: number[] = SIMPLIFY_TOLERANCES,
  precision: number = COORD_PRECISION,
): {
  fc: FeatureCollection;
  tolerance: number;
  size: number;
  cleanStats: CleanStats;
} {
  for (const tolerance of tolerances) {
    const simplified = simplify(fc, {
      tolerance,
      highQuality: false,
      mutate: false,
    });
    const truncated = truncate(simplified, {
      precision,
      coordinates: 2,
      mutate: true,
    });
    const { fc: cleaned, stats: cleanStats } = cleanFeatureCollection(
      truncated,
      precision,
    );
    const size = byteLength(JSON.stringify(cleaned));
    if (size <= limitBytes) {
      return { fc: cleaned, tolerance, size, cleanStats };
    }
  }
  throw new Error(
    `どのトレランス (${
      tolerances.join(", ")
    }) でも ${limitBytes} バイト以下にできませんでした`,
  );
}

/** ピン留め URL から FeatureCollection を取得する */
async function fetchFeatureCollection(
  year: number,
): Promise<FeatureCollection> {
  const url = buildSourceUrl(year);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url} の取得に失敗しました (status ${res.status})`);
  }
  return await res.json() as FeatureCollection;
}

/** name-overrides.json を読み込む。存在しなければ空のマップを返す */
async function loadOverrides(path: string): Promise<NameOverrides> {
  try {
    const data = JSON.parse(await Deno.readTextFile(path));
    const renames = data && typeof data === "object" && data.renames &&
        typeof data.renames === "object"
      ? data.renames as Record<string, string>
      : {};
    const propertyFixes =
      data && typeof data === "object" && Array.isArray(data.propertyFixes)
        ? data.propertyFixes as PropertyFix[]
        : [];
    return { renames, propertyFixes };
  } catch {
    return { renames: {}, propertyFixes: [] };
  }
}

/**
 * 切り出しに使うオーバーレイの区画を読み込む（TASK-101）。
 * 入力は生成済みかつリポジトリにコミット済みの派生データなので、欠けていれば
 * 黙って素通りさせず失敗させる（素通りすると再生成のたびに修正が消えるため）。
 */
async function loadFiefPolygon(
  split: BaseFiefSplit,
): Promise<Feature<Polygon | MultiPolygon>> {
  const fc = JSON.parse(
    await Deno.readTextFile(split.fiefPath),
  ) as FeatureCollection;
  const merged = unionByName(fc, split.fiefName);
  if (merged === null) {
    throw new Error(
      `${split.fiefPath} に ${split.fiefName} のポリゴンが無く、base から切り出せません`,
    );
  }
  return merged;
}

/** その年に適用する切り出しを全て適用する（TASK-101） */
async function applyBaseFiefSplits(
  fc: FeatureCollection,
  year: number,
): Promise<FeatureCollection> {
  let result = fc;
  for (const split of BASE_FIEF_SPLITS.filter((s) => s.year === year)) {
    const fief = await loadFiefPolygon(split);
    result = splitFiefFromBase(result, fief, split);
    console.log(
      `${year}: ${split.fromName} から ${split.fiefName} を独立 feature として切り出しました`,
    );
  }
  // 分断された残余の付け替えは全ての切り出しを終えてから（#342）
  return mergeSeveredRemainders(fc, result, year);
}

/**
 * 置換元のポリゴンを読み込む（ADR-0040 / #352）。
 *
 * 入力は生成済みかつコミット済みの派生データなので、欠けていれば黙って素通り
 * させず失敗させる（loadFiefPolygon と同じ方針）。ヨーロッパ bbox でクリップ
 * するのは base 側と同じ切り取りに揃えるため（対象 6 年の実データでは bbox
 * 外に出る面が無いので実質恒等だが、上流が広がったときに base の外へ塗りが
 * はみ出すのを構造的に防ぐ）。
 */
async function loadReplacementPolygon(
  spec: BasePowerReplacement,
): Promise<Feature<Polygon | MultiPolygon>> {
  const fc = JSON.parse(
    await Deno.readTextFile(spec.sourcePath),
  ) as FeatureCollection;
  const merged = unionByName(fc, spec.sourceName);
  if (merged === null) {
    throw new Error(
      `${spec.sourcePath} に ${spec.sourceName} のポリゴンが無く、` +
        `${spec.fromName} の外周を置換できません`,
    );
  }
  const clipped = bboxClip(merged, EUROPE_BBOX);
  const cleaned = cleanGeometry(clipped.geometry);
  if (cleaned === null) {
    throw new Error(
      `${spec.sourcePath} の ${spec.sourceName} がヨーロッパ bbox の外にあります`,
    );
  }
  return { ...merged, geometry: cleaned as Polygon | MultiPolygon };
}

/**
 * その年に適用する外周置換を全て適用する（ADR-0040 / #352）。
 *
 * applyBaseFiefSplits の**後段**に置く。1100 / 1200 年の BASE_FIEF_SPLITS は
 * ボヘミア公領・ボヘミア王国・モラヴィアを Poland 塗りから切り出しており
 * （TASK-157 / #346）、Cliopatria のポーランドはプラハもブルノも含まないため、
 * 先に置換すると切り出し元が消えて #346 の成果が失われる。後段に置けば、
 * 切り出し済みの feature はそのまま残り、置換は「切り出した残りの Poland」に
 * 対して行われる。
 */
async function applyBasePowerReplacements(
  fc: FeatureCollection,
  year: number,
): Promise<FeatureCollection> {
  let result = fc;
  for (const spec of BASE_POWER_REPLACEMENTS.filter((r) => r.year === year)) {
    const replacement = await loadReplacementPolygon(spec);
    result = replaceBasePower(result, replacement, spec);
    console.log(
      `${year}: ${spec.fromName} の外周を ${spec.sourceName}（${spec.sourcePath}）へ置換しました`,
    );
  }
  return result;
}

async function main(): Promise<void> {
  await Deno.mkdir(DATA_DIR, { recursive: true });
  const overrides = await loadOverrides(OVERRIDES_PATH);

  for (const year of YEARS) {
    const raw = await fetchFeatureCollection(year);
    const clipped = clipToBbox(raw, EUROPE_BBOX);
    const named = applyNameOverrides(clipped, overrides);
    // 切り出しは simplify の前に行い、王国側の残余と封土が同じ座標列から
    // 同じトレランスで簡略化されるようにする
    const split = await applyBaseFiefSplits(named, year);
    // ADR-0040 / #352: 外周の置換は切り出しの後段。1100 / 1200 のボヘミア・
    // モラヴィアは Poland 塗りから切り出すため、先に置換すると切り出し元が消える
    const replaced = await applyBasePowerReplacements(split, year);
    // TASK-102: 個別の異常（文字化け・列ずれ・年代間で揺れる SUBJECTO）は
    // 正規化（normalizeSubjectProps）より先に当てる。順序を逆にすると、直すべき
    // 空値が正規化で先に埋まって上書きが素通りする。切り出しより後に置くのは、
    // TASK-124 で切り出した封土 feature（County of Artois 等）にも propertyFixes
    // が届くようにするため（切り出し前には対象 feature が存在しない）。上流由来の
    // feature の NAME は切り出しで変わらないので、既存エントリの挙動は変わらない。
    const fixed = applyPropertyFixes(
      replaced,
      year,
      overrides.propertyFixes ?? [],
    );
    // 正規化は切り出し・上書きの後。TASK-101 が立てる封土 feature も通し、
    // 「SUBJECTO / PARTOF が空の feature は出力に残らない」を段の位置で保証する
    const normalized = normalizeSubjectProps(fixed);
    const { fc, tolerance, size, cleanStats } = shrinkToLimit(
      normalized,
      SIZE_LIMIT_BYTES,
    );
    const outPath = `${DATA_DIR}/europe_${year}.geojson`;
    await Deno.writeTextFile(outPath, JSON.stringify(fc));
    console.log(
      `${outPath}: ${size} bytes, tolerance=${tolerance}, features=${fc.features.length}`,
    );
    const cleanLog = formatCleanStats(cleanStats);
    if (cleanLog !== null) console.log(cleanLog);
  }

  const index = buildIndex(YEARS, {
    repo: SOURCE_REPO,
    commit: SOURCE_COMMIT,
    license: SOURCE_LICENSE,
  });
  await Deno.writeTextFile(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`);
  console.log(`${INDEX_PATH} を生成しました`);
}

if (import.meta.main) {
  await main();
}
