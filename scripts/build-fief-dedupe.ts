/**
 * 諸侯領オーバーレイと base 勢力の「二重輪郭・二重ラベル」を解消するための
 * 派生データを生成するパイプライン（TASK-78）。
 *
 * 入力はどちらも既存の生成物（ネットワーク不要）:
 * - data/europe_<year>.geojson（scripts/build-data.ts）
 * - data/france_fiefs_<year>.geojson（scripts/build-france-fiefs.ts）
 * - data/hre_fiefs_<year>.geojson（scripts/build-hre-fiefs.ts）
 * - data/italy_fiefs_<year>.geojson（scripts/build-italy-fiefs.ts）
 *
 * 出力（year ∈ FIEF_DEDUPE_YEARS）:
 * 1. data/fief-dedupe.json … 諸侯領 union による base 勢力の被覆率表
 *    （year → 勢力 NAME → 0..1）。ランタイム（src/fief_dedupe.ts）は
 *    FIEF_COVERAGE_SUPPRESS_THRESHOLD 以上の勢力のラベルを抑制する。
 * 2. data/base_outline_<year>.geojson … base 境界線（各ポリゴンの環）を
 *    諸侯領 union の外側だけに切り出した LineString の集合。ランタイムは
 *    諸侯領対象年に限り base ポリゴンの stroke を止めてこの層を描くため、
 *    諸侯領の内側を走る base 境界線が消え、外側の境界線は従来と同一に見える。
 * 3. data/europe_flat_<year>.geojson … base 勢力ポリゴンから諸侯領 union を
 *    差し引いた派生 base（TASK-92）。ランタイム（powers レイヤー）は諸侯領
 *    対象年に限りこちらを塗りのデータに使い、諸侯領の下に別の半透明が重なって
 *    生じる「境界線を伴わない濃淡」を消す。ラベル・帝国範囲強調・被覆率計算は
 *    従来どおり元の europe_<year> を使う（形が変わると polylabel の位置や
 *    帝国範囲の外形が動くため）。
 *
 * 3 つとも同じ union（fiefUnionOf）から導くため、「base の輪郭が消える範囲」と
 * 「base の塗りが消える範囲」は常に一致する。
 *
 * なぜ 2 系統に分けるのか（実測に基づく設計判断。1200 年のデータで計測）:
 * - 完全内包される base 勢力は Britany（被覆率 1.0000）のみで、次に高い
 *   Angevin Empire は 0.5126。つまり被覆率だけで抑制できるのは「勢力全体が
 *   諸侯領に置き換わっている」ケースに限られ、ラベルの重複（AC #1）はこれで解ける。
 * - 一方、諸侯領の内側を走る base 境界線は部分重複の勢力に由来する分が多数を
 *   占める（1200 年: Angevin Empire 2,097 km・Kingdom of France 795 km に対し
 *   Britany は 794 km。うち union 外周から 3km 以上内側に入るものが大半）。
 *   deck.gl の accessor は feature 単位でしか効かないため、被覆率による
 *   feature 単位の減衰では消せない。線を幾何的に切り出す必要がある。
 *
 * 決定性: 入力の座標をそのまま使い（切断点のみ COORD_PRECISION で丸める）、
 * feature の並びは入力順、被覆率表のキーは NAME の昇順に固定する。
 */

import area from "@turf/area";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { serializeWithAttribution } from "./build-attribution.ts";
import { BRITAIN_FIEF_YEARS } from "./build-britain-fiefs.ts";
import { SOVEREIGN_FIEF_YEARS } from "./build-sovereign-fiefs.ts";
import {
  CLIOPATRIA_FIEF_YEARS,
  cliopatriaRawPathFor,
} from "./build-cliopatria-fiefs.ts";
import difference from "@turf/difference";
import { featureCollection, lineString } from "@turf/helpers";
import intersect from "@turf/intersect";
import lineSplit from "@turf/line-split";
import truncate from "@turf/truncate";
import union from "@turf/union";
import type {
  BBox,
  Feature,
  FeatureCollection,
  LineString,
  MultiPolygon,
  Polygon,
  Position,
} from "geojson";
import {
  BASE_OUTLINE_YEARS,
  BORROWED_HRE_OVERLAY_YEARS,
  BORROWED_ITALY_FIEF_OVERLAY_YEARS,
  FRANCE_FIEF_OVERLAY_YEARS,
  HRE_FIEF_OVERLAY_YEARS,
  ITALY_FIEF_OVERLAY_YEARS,
} from "../src/config.ts";
import { COORD_PRECISION } from "./build-data.ts";
import { cleanFeatureCollection, formatCleanStats } from "./clean-polygons.ts";

/**
 * 生成対象年。オーバーレイ（中世フランス諸侯領・中世 HRE 領邦）のいずれかが
 * 存在する年と同一（src/config.ts BASE_OUTLINE_YEARS）。対象外の年は派生データを
 * 持たないため、ランタイムは従来どおりの描画（base ポリゴンの環・base ラベル
 * 全件）になる（AC #3）。
 *
 * TASK-86: HRE 領邦（1000〜1492）を加えたことで 1400 / 1492 が対象に増え、
 * 1000〜1300 は 2 系統のオーバーレイの union に対して被覆率・輪郭を計算する。
 * TASK-96: イタリア諸侯領（1000〜1492）を加えた。年集合は変わらない（HRE 領邦が
 * 既に全年を覆う）が、union に北・中部イタリアが加わるため被覆率・輪郭・
 * 派生 base が変わる。
 */
export const FIEF_DEDUPE_YEARS: readonly number[] = BASE_OUTLINE_YEARS;

/** 被覆率を丸める小数桁数（0.0001 = 面積比 0.01% 刻み） */
export const COVERAGE_PRECISION = 4;

/**
 * 派生 base（europe_flat_<year>.geojson）1 ファイルあたりのサイズ上限（バイト）。
 *
 * この派生ファイルは「base のポリゴン ＋ オーバーレイ union の輪郭（穴の縁）」で
 * できているため、オーバーレイの収録が増えるほど元の europe_<year> より頂点が
 * 増える。base 本体の上限（build-data.ts SIZE_LIMIT_BYTES = 300 KB）をそのまま
 * 当てると、オーバーレイを 1 政体足すたびに base 側の簡略化をやり直す羽目に
 * なるため、穴の縁の分の余白（+20 KB ≒ 実測で最大の 1783 年が 301 KB）を持つ
 * 独立の上限にする。上限自体は残す: 際限なく増えると配信ペイロードが膨らむ。
 */
export const BASE_FILL_SIZE_LIMIT_BYTES = 320 * 1000;

/**
 * 被覆率表に記録する下限。これ未満（0.1% 未満）の重複は境界線の解像度差や
 * 座標丸めに由来するノイズで、抑制判定にも目視確認にも意味を持たないため
 * 表に載せない（ファイルを小さく保ち、差分を読みやすくする）。
 */
export const MIN_RECORDED_COVERAGE = 0.001;

/** ポリゴン系ジオメトリを持つ feature */
type PolygonalFeature = Feature<Polygon | MultiPolygon>;

/** feature がポリゴン系ジオメトリを持つか */
function isPolygonal(feature: Feature): feature is PolygonalFeature {
  const type = feature.geometry?.type;
  return type === "Polygon" || type === "MultiPolygon";
}

/** feature のポリゴン（= 環の配列）一覧を返す */
function polygonsOf(feature: PolygonalFeature): Position[][][] {
  return feature.geometry.type === "Polygon"
    ? [feature.geometry.coordinates]
    : feature.geometry.coordinates;
}

/** properties.NAME を取り出す。空文字・非文字列は null */
function nameOf(feature: Feature): string | null {
  const value = feature.properties?.NAME;
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * 諸侯領 FeatureCollection を 1 つのポリゴンへ統合する（純粋関数）。
 * 被覆率も境界線の切り出しも「諸侯領全体が覆う面」に対する判定なので、
 * 諸侯領同士の重なり（OHM の伯領は境界が微妙に重なる）を先に潰しておく。
 * ポリゴンを持つ feature が無ければ null。
 */
export function fiefUnionOf(fiefs: FeatureCollection): PolygonalFeature | null {
  let merged: PolygonalFeature | null = null;
  for (const feature of fiefs.features) {
    if (!isPolygonal(feature)) continue;
    if (merged === null) {
      merged = feature;
      continue;
    }
    merged = union(featureCollection([merged, feature])) ?? merged;
  }
  return merged;
}

/**
 * base 勢力ごとの「諸侯領 union に覆われた面積の割合」を返す（純粋関数）。
 * 同一 NAME の複数 feature（飛び地）は面積で加重して 1 件に集計する。
 * fiefUnion が null（諸侯領なし）のときは空表。
 *
 * 面積は turf の測地面積（m²）で、緯度による経線収束の影響を受けない。
 * intersect が不正ジオメトリで例外を投げた場合はその feature の重複を 0 と
 * みなし、警告して続行する（生成を失敗させない: build-france-fiefs と同方針）。
 */
export function coverageByPowerName(
  base: FeatureCollection,
  fiefUnion: PolygonalFeature | null,
  warnFn: (message: string) => void = console.warn,
): Record<string, number> {
  if (fiefUnion === null) return {};
  const totals = new Map<string, { base: number; covered: number }>();
  for (const feature of base.features) {
    const name = nameOf(feature);
    if (name === null || !isPolygonal(feature)) continue;
    const entry = totals.get(name) ?? { base: 0, covered: 0 };
    entry.base += area(feature);
    try {
      const overlap = intersect(featureCollection([feature, fiefUnion]));
      if (overlap !== null) entry.covered += area(overlap);
    } catch (error) {
      warnFn(`${name} と諸侯領の交差計算に失敗しました: ${String(error)}`);
    }
    totals.set(name, entry);
  }
  const coverage: Record<string, number> = {};
  for (
    const name of [...totals.keys()].sort((a, b) => a.localeCompare(b, "en"))
  ) {
    const entry = totals.get(name)!;
    if (entry.base <= 0) continue;
    const ratio = Number(
      (entry.covered / entry.base).toFixed(COVERAGE_PRECISION),
    );
    if (ratio < MIN_RECORDED_COVERAGE) continue;
    coverage[name] = ratio;
  }
  return coverage;
}

/** 環の bbox（[minX, minY, maxX, maxY]） */
function ringBbox(ring: readonly Position[]): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/** ポリゴン系ジオメトリ全体の bbox */
function geometryBbox(feature: PolygonalFeature): BBox {
  const boxes = polygonsOf(feature).map((polygon) => ringBbox(polygon[0]));
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}

/** 2 つの bbox が交差するか（接触も交差扱い） */
function bboxIntersects(a: BBox, b: BBox): boolean {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

/**
 * ライン片の代表点（中央セグメントの中点）。端点は諸侯領の境界上に乗るため
 * 内外判定に使えない（lineSplit の切断点は必ず境界上に来る）。
 */
function representativePoint(coords: readonly Position[]): Position {
  const i = Math.floor((coords.length - 1) / 2);
  return [
    (coords[i][0] + coords[i + 1][0]) / 2,
    (coords[i][1] + coords[i + 1][1]) / 2,
  ];
}

/**
 * base 境界線（各ポリゴンの外環・内環）を諸侯領 union の外側だけに切り出した
 * LineString の FeatureCollection を返す（純粋関数）。
 *
 * - union と bbox が交差しない環はそのまま採用する（切断不要・座標も無変更）
 * - 交差しうる環は lineSplit で union の境界で切り、代表点が union の内側に
 *   ある片を捨てる
 * - fiefUnion が null なら全ての環をそのまま返す（対象外年の非退行）
 *
 * 出力の properties は元の feature の properties をそのまま引き継ぐ
 * （NAME により、どの勢力の境界線かをデバッグできるようにする。描画では未使用）。
 */
export function outlinesOutsideFiefs(
  base: FeatureCollection,
  fiefUnion: PolygonalFeature | null,
  warnFn: (message: string) => void = console.warn,
): FeatureCollection<LineString> {
  const unionBbox = fiefUnion === null ? null : geometryBbox(fiefUnion);
  const lines: Feature<LineString>[] = [];
  for (const feature of base.features) {
    if (!isPolygonal(feature)) continue;
    const properties = feature.properties ?? {};
    for (const polygon of polygonsOf(feature)) {
      for (const ring of polygon) {
        if (ring.length < 2) continue;
        const line = lineString(ring, properties);
        if (
          fiefUnion === null || unionBbox === null ||
          !bboxIntersects(ringBbox(ring), unionBbox)
        ) {
          lines.push(line);
          continue;
        }
        let pieces: Feature<LineString>[];
        try {
          pieces = lineSplit(line, fiefUnion).features;
        } catch (error) {
          // 切断に失敗した環は従来どおり全体を描く（線が消えるより二重輪郭が残る方が安全）
          warnFn(
            `${nameOf(feature) ?? "(no name)"} の境界線の切断に失敗しました: ${
              String(error)
            }`,
          );
          lines.push(line);
          continue;
        }
        // lineSplit は交差点が 1 つも無いと 0 件を返す（元の線を返さない）。
        // bbox は重なるが実際には交差しない環（神聖ローマ帝国・イングランドの
        // 輪郭で発生）がここに来るため、環全体の内外を代表点 1 つで判定する
        // （交差が無い = 環全体が union の内側か外側のどちらかに決まる）。
        if (pieces.length === 0) {
          if (!booleanPointInPolygon(representativePoint(ring), fiefUnion)) {
            lines.push(line);
          }
          continue;
        }
        for (const piece of pieces) {
          const coords = piece.geometry.coordinates;
          if (coords.length < 2) continue;
          if (booleanPointInPolygon(representativePoint(coords), fiefUnion)) {
            continue;
          }
          lines.push(lineString(coords, properties));
        }
      }
    }
  }
  // 切断点は浮動小数の交点計算で桁が伸びるため、base データと同じ精度へ丸める
  return truncate(featureCollection(lines), {
    precision: COORD_PRECISION,
    coordinates: 2,
  });
}

/** baseFillOutsideFiefs の結果 */
export interface BaseFillOutsideFiefs {
  fc: FeatureCollection;
  /** union に完全に覆われ、塗りを 1 つも持たなくなった勢力 NAME（入力順） */
  removedNames: string[];
}

/**
 * base 勢力ポリゴンからオーバーレイ union を差し引いた FeatureCollection を返す
 * （純粋関数、TASK-92）。outlinesOutsideFiefs が境界線に対して行うことの塗り版。
 *
 * ## なぜ必要か
 * 諸侯領（france-fiefs / hre-powers）は base 勢力（powers）の直上に FILL_ALPHA=128
 * の半透明で描かれるため、見える色は「0.5 × 諸侯領色 + 0.5 × 下地」になる。
 * 下地の base 勢力は諸侯領と境界が一致しておらず、1 つの諸侯領の内側を base の
 * 境界が横切る（1200 年の Duchy of Gascony は下地が Angevin Empire 88% ＋
 * County of Toulouse 11%）。同じ諸侯領なのに下地が替わる場所で合成色が変わり、
 * 「境界線を伴わない濃淡」として見える。下地を幾何的に取り除けば諸侯領の下は
 * 常にベースマップだけになり、1 つの諸侯領は 1 色に落ち着く。
 *
 * ## 完全に覆われる勢力は feature ごと落とす
 * difference が null（＝ union に完全内包）になる base 勢力（1200 年の Britany は
 * 被覆率 1.0000）は、塗りが全て諸侯領の下に隠れているので残す意味が無い。
 * build-fief-flat.ts の subtractOverlay は同じ状況で「元のまま残して警告」する
 * が、あちらは領邦が地図から消えることを避ける判断で、ここでは逆に残すと
 * 二重塗り（＝解決したい症状そのもの）が残る。落としても base ラベルは
 * fief-dedupe.json の被覆率で既に抑制されており（FIEF_COVERAGE_SUPPRESS_THRESHOLD）、
 * ラベル・picking・帝国範囲強調は元の base（europe_<year>）を使い続けるため
 * 影響しない。
 *
 * union と bbox が交差しない feature は差し引きを試みず座標をそのまま返す
 * （形は一切変わらない・重い difference も省く）。差し引きに失敗した feature は警告して
 * 元のまま残す（塗りが消えるより二重塗りが残る方が安全）。
 * 座標は新しくできる交点の桁が伸びるため COORD_PRECISION へ丸める。
 */
export function baseFillOutsideFiefs(
  base: FeatureCollection,
  fiefUnion: PolygonalFeature | null,
  warnFn: (message: string) => void = console.warn,
): BaseFillOutsideFiefs {
  if (fiefUnion === null) return { fc: base, removedNames: [] };
  const unionBbox = geometryBbox(fiefUnion);
  const kept: Feature[] = [];
  const removedNames: string[] = [];
  for (const feature of base.features) {
    if (!isPolygonal(feature)) {
      kept.push(feature);
      continue;
    }
    if (!bboxIntersects(geometryBbox(feature), unionBbox)) {
      kept.push(feature);
      continue;
    }
    let cut: Feature<Polygon | MultiPolygon> | null;
    try {
      cut = difference(featureCollection([feature, fiefUnion]));
    } catch (error) {
      warnFn(
        `${
          nameOf(feature) ?? "(no name)"
        } からオーバーレイを差し引けませんでした: ${String(error)}`,
      );
      kept.push(feature);
      continue;
    }
    if (cut === null) {
      removedNames.push(nameOf(feature) ?? "(no name)");
      continue;
    }
    kept.push({ ...feature, geometry: cut.geometry });
  }
  const fc: FeatureCollection = { type: "FeatureCollection", features: kept };
  return {
    fc: truncate(fc, { precision: COORD_PRECISION, coordinates: 2 }),
    removedNames,
  };
}

/** fief-dedupe.json の中身 */
export interface FiefDedupeFile {
  metadata: {
    generatedBy: string;
    /** 年 → 入力ファイルのパス（再生成の手掛かり）。fiefs は複数系統ありうる */
    inputs: Record<string, { base: string; fiefs: string[] }>;
    coveragePrecision: number;
    minRecordedCoverage: number;
  };
  /** 年（文字列キー）→ 勢力 NAME → 被覆率（0..1） */
  years: Record<string, Record<string, number>>;
}

/** base / fiefs / base_outline の各パスを返す（純粋関数） */
export function basePathFor(year: number): string {
  return `data/europe_${year}.geojson`;
}

export function fiefsPathFor(year: number): string {
  return `data/france_fiefs_${year}.geojson`;
}

/** HRE 領邦（OHM 由来・TASK-85）の入力パス */
export function hreFiefsPathFor(year: number): string {
  return `data/hre_fiefs_${year}.geojson`;
}

/** イタリア諸侯領（OHM 由来・TASK-95）の入力パス */
export function italyFiefsPathFor(year: number): string {
  return `data/italy_fiefs_${year}.geojson`;
}

/**
 * Cliopatria 由来の諸侯領・領邦（TASK-110）の入力パス。
 *
 * 年集合は src/config.ts ではなく scripts 側の CLIOPATRIA_FIEF_YEARS を参照する
 * （src → scripts の import を行わない規約の下で、表示側の定数と本パイプラインの
 * 定数が別々に育つのを避けるため。両者の同値は build-cliopatria-fiefs_test.ts で
 * 担保する）。
 */
export function cliopatriaFiefsPathFor(year: number): string {
  return cliopatriaRawPathFor(year);
}

/**
 * ブリテン諸島の政体（OHM 由来・TASK-151 / #172）の入力パス。
 *
 * 年集合は scripts 側の BRITAIN_FIEF_YEARS を参照する（cliopatria と同じく、
 * src → scripts の import を行わない規約の下で定数の二重成長を避ける。
 * src/config.ts BRITAIN_FIEF_OVERLAY_YEARS との同値は
 * build-britain-fiefs_test.ts で担保する）。
 */
export function britainFiefsPathFor(year: number): string {
  return `data/britain_fiefs_${year}.geojson`;
}

/**
 * 主権政体オーバーレイ（OHM 由来・#189）の入力パス。
 *
 * 年集合は scripts 側の SOVEREIGN_FIEF_YEARS を参照する（cliopatria・britain と
 * 同じく、src → scripts の import を行わない規約の下で定数の二重成長を避ける。
 * src/config.ts SOVEREIGN_FIEF_OVERLAY_YEARS との同値は
 * build-sovereign-fiefs_test.ts で担保する）。
 */
export function sovereignFiefsPathFor(year: number): string {
  return `data/sovereign_fiefs_${year}.geojson`;
}

/**
 * 隣接年から流用した HRE 領邦（#202 / ADR-0033）の入力パス。
 * 生成は scripts/build-borrowed-fiefs.ts で、年集合は src/config.ts の
 * BORROWED_HRE_OVERLAY_YEARS（表示側と同一の定義元）。
 */
export function borrowedHrePathFor(year: number): string {
  return `data/borrowed_hre_${year}.geojson`;
}

/** 隣接年から流用したイタリア諸侯領（#202 / ADR-0033）の入力パス */
export function borrowedItalyFiefsPathFor(year: number): string {
  return `data/borrowed_italy_${year}.geojson`;
}

/**
 * その年に存在するオーバーレイの入力パスを全て返す（純粋関数、TASK-86/96/110）。
 * 被覆率も境界線の切り出しも「その年に描かれるオーバーレイ全体」に対する判定
 * なので、仏諸侯領・HRE 領邦・伊諸侯領が揃う年（1000〜1300）は 3 件を返す。
 * TASK-110 の Cliopatria 由来オーバーレイも同じ扱いで足す: これを外すと
 * 1400 / 1492 のバイエルン公領などの下に base 塗りが残り、半透明が二重に
 * 重なって濃くなる（AC #4 の二重塗り）。
 *
 * 参照するのは flat（重なり解消済み）ではなく生データ: union を取る
 * 以上どちらでも結果は同じで、生データの方が入力として素直なため
 * （flat は「どちらのレイヤーが塗るか」を決めたもので、union は変わらない）。
 */
export function fiefsPathsFor(year: number): string[] {
  const paths: string[] = [];
  if (FRANCE_FIEF_OVERLAY_YEARS.includes(year)) paths.push(fiefsPathFor(year));
  if (HRE_FIEF_OVERLAY_YEARS.includes(year)) paths.push(hreFiefsPathFor(year));
  if (ITALY_FIEF_OVERLAY_YEARS.includes(year)) {
    paths.push(italyFiefsPathFor(year));
  }
  if (CLIOPATRIA_FIEF_YEARS.includes(year)) {
    paths.push(cliopatriaFiefsPathFor(year));
  }
  // #172: ブリテン諸島の政体（1000〜1700）。これを登録しないと base の
  // Celtic kingdoms / England and Ireland の塗りがオーバーレイの下に残り、
  // 半透明が二重に重なって濃くなる（既存 4 系統と同じ二重塗りの解消）。
  // 近世（1500〜1700）はブリテンだけが対象で、この年集合の追加により
  // FIEF_DEDUPE_YEARS（= BASE_OUTLINE_YEARS）が 12 年へ広がる。
  if (BRITAIN_FIEF_YEARS.includes(year)) {
    paths.push(britainFiefsPathFor(year));
  }
  // #189: 主権政体オーバーレイ（1200〜1900 の 14 年）。これを登録しないと
  // base の一枚岩塗り（Ottoman / Austrian / Russian Empire・1200 年の
  // Bulgar Khanate 等）がハンガリー王国・クリミア・ハン国・フィンランド
  // 大公国などの下に残り、半透明が二重に重なって濃くなる。この年集合の
  // 追加により FIEF_DEDUPE_YEARS が 1815 / 1880 / 1900 を含む 18 年へ広がる。
  if (SOVEREIGN_FIEF_YEARS.includes(year)) {
    paths.push(sovereignFiefsPathFor(year));
  }
  // #202 / ADR-0033: 隣接年から流用した面（1492 年のオーストリア大公領・
  // ミラノ公国）。ここへ足さないと大公領・公国の下に base の Holy Roman
  // Empire 塗りが残り、半透明が二重に重なって色が濁る（既存 6 系統と同じ
  // 理由）。union に足すのは座標無改変の借用元（borrowed_<系統>_<year>）。
  // #215 で配信用にはホスト系統 flat を差し引いた borrowed_<系統>_flat_<year>
  // が生えたが、union(ホスト flat, 借用元) と union(ホスト flat, 借用 flat) は
  // 集合として同値であり、穴の無い借用元の方がスリバー（微小隙間）が出ない。
  if (BORROWED_HRE_OVERLAY_YEARS.includes(year)) {
    paths.push(borrowedHrePathFor(year));
  }
  if (BORROWED_ITALY_FIEF_OVERLAY_YEARS.includes(year)) {
    paths.push(borrowedItalyFiefsPathFor(year));
  }
  return paths;
}

export function outlinePathFor(year: number): string {
  return `data/base_outline_${year}.geojson`;
}

/**
 * base 塗り（オーバーレイ union を差し引いた派生 base）の出力パス（TASK-92）。
 * ランタイム（src/powers.ts baseFillDataUrlFor）が powers レイヤーの data として
 * 引くのはこのファイルで、ラベル・帝国範囲強調・被覆率の計算は従来どおり
 * 元の europe_<year> を使う。
 */
export function baseFillPathFor(year: number): string {
  return `data/europe_flat_${year}.geojson`;
}

/** fief-dedupe.json のパス */
export const DEDUPE_PATH = "data/fief-dedupe.json";

async function readCollection(path: string): Promise<FeatureCollection> {
  return JSON.parse(await Deno.readTextFile(path)) as FeatureCollection;
}

/**
 * CLI 引数から生成対象年を決める（純粋関数、#188 / #189 と同じ方式）。
 * 引数なしなら全対象年（従来どおり）。年を並べる（例: `1815 1880 1900`）と
 * その年の base_outline / europe_flat だけを生成・書き込みし、他の年の
 * 生成物へ一切触れない（fief-dedupe.json は既存内容へ対象年をマージする）。
 * 既存年の生成物のバイト不変を「再生成しない」ことで構造的に保証するための
 * 仕組みで、対象年に無い年の指定はエラーにする。
 */
export function parseTargetYears(args: readonly string[]): number[] {
  if (args.length === 0) return [...FIEF_DEDUPE_YEARS];
  const years = args.map((arg) => Number.parseInt(arg, 10));
  for (const year of years) {
    if (!FIEF_DEDUPE_YEARS.includes(year)) {
      throw new Error(`${year} は FIEF_DEDUPE_YEARS に含まれない年です`);
    }
  }
  return [...new Set(years)].sort((a, b) => a - b);
}

/**
 * 既存の fief-dedupe.json を読み、無ければ空の器を返す。
 * 年指定の部分再生成（parseTargetYears）で対象外の年の被覆率・inputs を
 * 保持するために使う。
 */
async function readExistingDedupe(): Promise<{
  years: Record<string, Record<string, number>>;
  inputs: Record<string, { base: string; fiefs: string[] }>;
}> {
  try {
    const file = JSON.parse(
      await Deno.readTextFile(DEDUPE_PATH),
    ) as FiefDedupeFile;
    return { years: file.years ?? {}, inputs: file.metadata?.inputs ?? {} };
  } catch {
    return { years: {}, inputs: {} };
  }
}

async function main(): Promise<void> {
  const targetYears = parseTargetYears(Deno.args);
  console.log(`target years: ${targetYears.join(", ")}`);
  const { years, inputs } = await readExistingDedupe();
  // 対象年集合から外れた年（オーバーレイ廃止など）が残骸として残らないよう、
  // 現在の FIEF_DEDUPE_YEARS に無い年は捨てる
  for (const key of Object.keys(years)) {
    if (!FIEF_DEDUPE_YEARS.includes(Number(key))) {
      delete years[key];
      delete inputs[key];
    }
  }
  for (const year of targetYears) {
    const base = await readCollection(basePathFor(year));
    const fiefPaths = fiefsPathsFor(year);
    const collections = await Promise.all(fiefPaths.map(readCollection));
    // 2 系統のオーバーレイは同じ 1 枚の「オーバーレイが覆う面」として扱う。
    // union の前に座標を COORD_PRECISION へ丸める（TASK-130）: 配信される
    // fiefs_flat の外周は丸め後の頂点で描かれるため、生データ（丸め前）の
    // union で base に穴を開けると、丸めで外へ動いた辺の分（最大で半グリッド
    // ≒ 56 m）だけ base 塗りが諸侯領の内側に残り、二重塗りの帯になる。
    // 先に丸めれば穴の縁と fiefs_flat の外周が同一頂点列になり、帯が消える
    // （一致は build-fief-dedupe_test.ts の二重塗り再現テストが担保する）。
    const fiefs: FeatureCollection = truncate(
      {
        type: "FeatureCollection",
        features: collections.flatMap((c) => c.features),
      },
      { precision: COORD_PRECISION, coordinates: 2 },
    );
    const fiefUnion = fiefUnionOf(fiefs);
    if (fiefUnion === null) {
      throw new Error(
        `${
          fiefPaths.join(" / ")
        } にポリゴンが無くオーバーレイ union を作れません`,
      );
    }
    const coverage = coverageByPowerName(base, fiefUnion);
    years[String(year)] = coverage;
    inputs[String(year)] = {
      base: basePathFor(year),
      fiefs: fiefPaths,
    };

    const outlines = outlinesOutsideFiefs(base, fiefUnion);
    const outlinePath = outlinePathFor(year);
    // TASK-109: アプリがロードするのはこの派生ファイルなので、入力 base の出典
    // （historical-basemaps / GPL-3.0 / 境界の確からしさ）を必ず載せて書き出す
    const json = serializeWithAttribution(outlinePath, outlines);
    await Deno.writeTextFile(outlinePath, json);
    console.log(
      `${outlinePath}: ${json.length} bytes, lines=${outlines.features.length}`,
    );
    // TASK-92: 諸侯領の下地になる base 塗りを取り除いた派生 base
    const { fc: fill, removedNames } = baseFillOutsideFiefs(base, fiefUnion);
    const { fc: cleanedFill, stats } = cleanFeatureCollection(
      fill,
      COORD_PRECISION,
    );
    const cleanLine = formatCleanStats(stats);
    if (cleanLine !== null) console.log(`  ${cleanLine}`);
    const fillPath = baseFillPathFor(year);
    const fillJson = serializeWithAttribution(fillPath, cleanedFill);
    const fillBytes = new TextEncoder().encode(fillJson).length;
    if (fillBytes > BASE_FILL_SIZE_LIMIT_BYTES) {
      throw new Error(
        `${fillPath} が上限を超えました (${fillBytes} バイト > ${BASE_FILL_SIZE_LIMIT_BYTES})`,
      );
    }
    await Deno.writeTextFile(fillPath, fillJson);
    console.log(
      `${fillPath}: ${fillJson.length} bytes, features=${cleanedFill.features.length}（完全被覆で除外=${
        removedNames.join(", ") || "なし"
      }${
        stats.droppedFeatures.length > 0
          ? `, 微小片のみで除外=${stats.droppedFeatures.join(", ")}`
          : ""
      }）`,
    );

    const suppressed = Object.entries(coverage)
      .filter(([, ratio]) => ratio >= 0.9)
      .map(([name, ratio]) => `${name}(${ratio})`);
    console.log(
      `  ${year} 被覆率: ${
        Object.entries(coverage).map(([n, r]) => `${n}=${r}`).join(", ")
      }`,
    );
    console.log(
      `  ${year} 完全内包（>=0.9）: ${suppressed.join(", ") || "なし"}`,
    );
  }
  // 年キーは常に昇順で書き出す（マージ後の挿入順に依存させない）
  const sortByYear = <T>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(
      Object.keys(record).sort((a, b) => Number(a) - Number(b)).map((
        key,
      ) => [key, record[key]]),
    );
  const file: FiefDedupeFile = {
    metadata: {
      generatedBy: "scripts/build-fief-dedupe.ts",
      inputs: sortByYear(inputs),
      coveragePrecision: COVERAGE_PRECISION,
      minRecordedCoverage: MIN_RECORDED_COVERAGE,
    },
    years: sortByYear(years),
  };
  await Deno.writeTextFile(DEDUPE_PATH, JSON.stringify(file, null, 2) + "\n");
  console.log(`${DEDUPE_PATH}: years=${Object.keys(years).join(", ")}`);
}

if (import.meta.main) {
  await main();
}
