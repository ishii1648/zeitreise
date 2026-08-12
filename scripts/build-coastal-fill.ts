/**
 * 沿岸補完の帯（ジオメトリ）を年代別に事前生成するパイプライン（Issue #326）。
 *
 * 入力は既存の生成物のみ（ネットワーク不要）:
 * - data/europe_<year>.geojson（scripts/build-data.ts。SNAPSHOT_YEARS 全 19 年）
 *
 * 出力:
 * - data/coastal_fill_<year>.geojson … 「沿岸 run の外側 COASTAL_FILL_BAND_KM の
 *   バッファ − 全政治ポリゴン」で得た帯の **幾何だけ**。ランタイム
 *   （src/coastal_fill_sync.ts）はこれを取得し、色と強調キーを載せるだけで
 *   描画データにする（src/coastal_fill.ts coastalFillDataFromBands）。
 *
 * ## なぜ事前生成するのか（#326）
 * #312 が帯を polyclip 差分（ポリゴン）へ作り直したことで、未着色帯・二重塗り
 * という視覚上の欠陥は構造的に消えた代わりに、生成が 1 年あたり 0.46〜0.72 秒
 * （実測。9 割超が polyclip 差分）の CPU を食うようになった。#312 は描画後への
 * defer と年代 LRU で「年送り操作そのもの」と「一度見た年への復帰」は守ったが、
 * **初訪問の年ごとに 0.6〜0.9 秒メインスレッドが止まる**症状は残った
 * （本番実測 664/713/859ms）。帯は base 勢力ポリゴンだけで決まる純粋な関数の
 * 出力なので、実行時に毎回計算する必要が無い。
 *
 * ## 色を焼き込まない理由
 * 帯の幾何は colors.json / name-overrides.json に一切依存しない。色を焼き込むと
 * 色定義を変えるたびに全 19 年を作り直す必要が生じ、作り直し漏れが「配信済みの
 * 帯だけ古い色」という形で表に出る。ここでは幾何と「どの base feature 由来か」
 * （COASTAL_FILL_BASE_INDEX_PROPERTY）だけを配信し、色付けはランタイムに残す
 * （実測 1ms 未満）。
 *
 * ## 陳腐化の防止
 * 出力には入力（data/europe_<year>.geojson）の内容ハッシュと帯幅を記録する。
 * 年代 GeoJSON や COASTAL_FILL_BAND_KM を変えたまま再生成し忘れると
 * src/coastal_fill_prebuilt_test.ts が red になる（添字の対応が崩れた帯を
 * 配信する事故を CI で止める）。
 *
 * 使い方:
 *   deno task build-coastal-fill
 */

import type { FeatureCollection, MultiPolygon, Position } from "geojson";
import {
  buildCoastalFillBands,
  COASTAL_FILL_BAND_KM,
} from "../src/coastal_fill.ts";
import { SNAPSHOT_YEARS } from "../src/config.ts";
import { contentHashHex } from "./asset_hashing.ts";
import {
  type AttributableDocument,
  attributionForDocument,
  serializeDataFile,
  withAttribution,
} from "./build-attribution.ts";

/** 入力（年代スナップショット）のファイルパスを返す（純粋関数）。 */
export function coastalFillSourcePathFor(year: number): string {
  return `data/europe_${year}.geojson`;
}

/**
 * 出力のファイルパスを返す（純粋関数）。配信 URL は src/coastal_fill.ts
 * coastalFillDataUrlFor と同じ名前で、scripts/build.ts の getDataCopyTargets が
 * dist/data へハッシュ付きで写す。
 */
export function coastalFillOutputPathFor(year: number): string {
  return `data/coastal_fill_${year}.geojson`;
}

/**
 * 帯の座標を丸める小数桁数（#326）。
 *
 * 年代 GeoJSON 本体（build-data.ts の COORD_PRECISION = 3 桁）より細かくする理由:
 * 帯の座標は polyclip 差分の**交点**で、元データの格子には乗っていない。
 * 3 桁（≈ 111 m 格子）へ丸めると、ほぼ平行に走る帯の内外の辺が同じ格子点へ
 * 潰れて**新しい自己交差**が生まれる（実測: 1000 年で 47 → 133 箇所、
 * 1900 年で 16 → 95 箇所）。帯は半透明（FILL_ALPHA）の fill なので、
 * 自己交差した環が earcut で重なった三角形になると #313 と同じ「濃い斑」に
 * 見え得る。5 桁（≈ 1.1 m）なら自己交差は 55 / 18 箇所と #312 が本番で
 * 描いている無丸めの幾何とほぼ同数に留まり、それでいて JSON サイズは
 * 実測 417KB → 268KB（1000 年）に落ちる。
 *
 * 表示精度の観点では 3 桁でも足りる（最大ズーム z8 の 1 px ≈ 94〜253 m）ので、
 * ここでの桁数の主目的はサイズではなく**幾何の等価性の保持**である。
 */
export const COASTAL_FILL_COORD_PRECISION = 5;

/**
 * 帯の座標を {@linkcode COASTAL_FILL_COORD_PRECISION} 桁へ丸める（純粋関数）。
 * 内側の環は元の政治ポリゴンの頂点そのもの（既に 3 桁）なので無損失で、
 * 外側の環（km 単位のオフセットと円弧）にだけ ≤ 0.6 m の誤差が乗る。
 */
export function roundBandCoordinates(
  bands: FeatureCollection<MultiPolygon>,
  precision: number = COASTAL_FILL_COORD_PRECISION,
): FeatureCollection<MultiPolygon> {
  const factor = 10 ** precision;
  const round = (value: number): number => Math.round(value * factor) / factor;
  return {
    type: "FeatureCollection",
    features: bands.features.map((feature) => ({
      type: "Feature",
      properties: feature.properties,
      geometry: {
        type: "MultiPolygon",
        coordinates: feature.geometry.coordinates.map((polygon) =>
          polygon.map((ring) =>
            ring.map(([lon, lat]): Position => [round(lon), round(lat)])
          )
        ),
      },
    })),
  };
}

/** 事前生成データに記録する、入力と生成条件の指紋（陳腐化検出用）。 */
export interface CoastalFillMeta {
  /** 入力ファイルのパス（data/europe_<year>.geojson）。 */
  sourcePath: string;
  /** 入力ファイルの内容ハッシュ（asset_hashing.ts contentHashHex と同じ規則）。 */
  sourceHash: string;
  /** 生成に使った帯幅（km）。src/coastal_fill.ts COASTAL_FILL_BAND_KM。 */
  bandKm: number;
}

/**
 * 帯 FeatureCollection に指紋を添えた配信用ドキュメントを組み立てる（純粋関数）。
 * 指紋は GeoJSON の foreign member として置く（RFC 7946 が許す拡張で、
 * ランタイム・地図ライブラリはいずれも無視する）。
 */
export function buildCoastalFillDocument(
  bands: FeatureCollection<MultiPolygon>,
  meta: CoastalFillMeta,
): FeatureCollection<MultiPolygon> & CoastalFillMeta {
  return {
    type: "FeatureCollection",
    sourcePath: meta.sourcePath,
    sourceHash: meta.sourceHash,
    bandKm: meta.bandKm,
    features: bands.features,
  };
}

/**
 * 事前生成データから指紋を読み取る（純粋関数）。形が違えば null を返し、
 * 呼び出し側（テスト）が「指紋なし = 陳腐化を検出できない」として扱う。
 */
export function readCoastalFillMeta(raw: unknown): CoastalFillMeta | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (
    typeof record.sourcePath !== "string" ||
    typeof record.sourceHash !== "string" ||
    typeof record.bandKm !== "number"
  ) {
    return null;
  }
  return {
    sourcePath: record.sourcePath,
    sourceHash: record.sourceHash,
    bandKm: record.bandKm,
  };
}

/** 1 年分を生成して書き出し、ログ用の要約を返す。 */
async function buildYear(year: number): Promise<string> {
  const sourcePath = coastalFillSourcePathFor(year);
  const bytes = await Deno.readFile(sourcePath);
  const base = JSON.parse(new TextDecoder().decode(bytes)) as FeatureCollection;
  const started = performance.now();
  const bands = roundBandCoordinates(buildCoastalFillBands(base));
  const elapsed = performance.now() - started;
  const document = buildCoastalFillDocument(bands, {
    sourcePath,
    sourceHash: await contentHashHex(bytes),
    bandKm: COASTAL_FILL_BAND_KM,
  });
  const outputPath = coastalFillOutputPathFor(year);
  const fileName = outputPath.slice("data/".length);
  // 座標の出所は base と同じ historical-basemaps。生成のたびに出典を載せ直し、
  // `deno task build-attribution` を挟み忘れても検査（build-attribution_test.ts）
  // が red にならないようにする
  const doc = document as unknown as AttributableDocument;
  const json = serializeDataFile(
    fileName,
    withAttribution(doc, attributionForDocument(fileName, doc)!),
  );
  await Deno.writeTextFile(outputPath, json);
  return `${outputPath}: ${
    new TextEncoder().encode(json).length
  } bytes, features=${bands.features.length}, ${elapsed.toFixed(0)}ms`;
}

async function main(): Promise<void> {
  for (const year of SNAPSHOT_YEARS) {
    console.log(await buildYear(year));
  }
}

if (import.meta.main) {
  await main();
}
