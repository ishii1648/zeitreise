/**
 * 隣接年の出典付きジオメトリを、その年に面が無い政体へ流用するパイプライン
 * （#202 / ADR-0033 decision-33）。
 *
 * ## 何をするスクリプトか
 * 既に本リポジトリが生成物として持っている面を**座標を 1 頂点も変えずに複製**し、
 * 対象年の借用ファイル data/borrowed_<系統>_<year>.geojson として書き出す。
 * 新しい座標は一切作らない（ADR-0014 の合成禁止はそのまま効く）。入力は既存の
 * 生成物だけで、ネットワークは不要。
 *
 * ## なぜ借用元と同じ系統の別ファイルに置くのか
 * 出典の粒度がファイル単位だから（scripts/build-attribution.ts が
 * FeatureCollection の metadata に出典を刻み、情報パネルはそれを読む）。
 * オーストリア大公領は Roller / ETH Zürich（CC BY-NC-SA 4.0）、ミラノ公国は
 * OpenHistoricalMap（CC0 1.0）で、1 つのファイルへ混ぜるとその metadata が
 * 2 つのライセンスを同時に主張することになる。CC0 のファイルへ CC BY-NC-SA の
 * 面を混ぜるのは「他人の著作物をパブリックドメインへ献呈する」記述になり
 * 事実としても誤りなので、系統ごとに別ファイルへ分ける。
 *
 * 表示側は powers.ts の withBorrowedGeometry が、借用ファイルの metadata を
 * 各 feature の properties.ATTRIBUTION へ写しながら既存レイヤーの
 * FeatureCollection へ足す。これにより「レイヤーは 1 枚のまま・出典は feature
 * ごとに正しい」状態になり、1492 年の大公領をクリックすると Roller の
 * CC BY-NC-SA 4.0 が、ミラノ公国をクリックすると OHM の CC0 が出る。
 *
 * ## simplify / 座標丸めを再適用しない理由（ADR-0033 条件 2）
 * 借用元は既に各パイプラインの simplify・座標丸めを通った生成物であり、
 * ここで再度掛けると「単純化しての流用」になって条件 2 に触れる。したがって
 * 本スクリプトは shrinkToLimit も truncate も呼ばず、geometry を構造化複製する
 * だけにする。本スクリプトの出力（borrowed_<系統>_<year>.geojson）は以後も
 * 座標無改変のまま残す。
 *
 * ## 重なり解消は下流の flat 化が担う（#215）
 * 借用面が覆う既存領邦のピック不能・系統間の二重塗りを解消するため、
 * scripts/build-fief-flat.ts が本スクリプトの出力からホスト系統 flat
 * （hre_fiefs_flat / italy_fiefs_flat）を差し引いた派生データ
 * （borrowed_<系統>_flat_<year>.geojson）を生成し、配信・表示はそちらを使う
 * （既存 7 系統と同じ扱い）。ADR-0033 条件 2 が禁じるのは借用元の頂点の改変で、
 * 派生 flat の生成はこれに触れない。base 側の二重塗りは従来どおり
 * scripts/build-fief-dedupe.ts が借用ファイルも union に含めて解消する。
 *
 * ## 上流が埋まったときの差し替え（ADR-0033）
 * BORROWED_FEATURES から該当エントリを外し、本スクリプトを流し直して
 * 借用ファイルを消す。data/known-limitations.json の年代連動エントリと
 * docs/data-inventory/missing-powers-ledger.md の記載も同時に落とす。
 *
 * 実行: deno task build-borrowed-fiefs
 * 実行順: 各取得スクリプト → **build-borrowed-fiefs** → build-fief-flat →
 * build-fief-dedupe → build-attribution。
 */

import type { Feature, FeatureCollection } from "geojson";
import { serializeWithAttribution } from "./build-attribution.ts";

/**
 * 借用面を置く系統。借用元と同じ系統（＝同じ出典・同じライセンス）にする。
 * - hre … Roller / ETH Zürich 由来（data/hre_<year>.geojson）
 * - italy … OpenHistoricalMap 由来（data/italy_fiefs_<year>.geojson）
 */
export type BorrowedLineage = "hre" | "italy";

/** 借用元の指定（ADR-0033 の「追跡可能性」に必要な 3 点） */
export interface BorrowedSource {
  /** 借用元の年（隣接スナップショット年） */
  readonly year: number;
  /** 借用元のファイル（リポジトリ内の生成物） */
  readonly file: string;
  /** 借用元の識別子（OHM の relation id / Roller の id など） */
  readonly sourceRef: string;
}

/** 借用エントリ（許可リストの 1 行） */
export interface BorrowedFeatureSpec {
  /** 借用先の年 */
  readonly year: number;
  /** 借用面を置く系統（借用元と同じ） */
  readonly lineage: BorrowedLineage;
  /** 借用する feature の NAME（借用元・借用先で同一） */
  readonly name: string;
  /** 借用元 */
  readonly from: BorrowedSource;
  /** ADR-0033 条件 3（政体の同一性と領域の連続性）の史実根拠 */
  readonly reason: string;
}

/**
 * 借用の許可リスト（#202）。ADR-0033 の 4 条件を全て満たすものだけを載せる。
 *
 * - **オーストリア大公領（1492 ← 1500）**: 1492 年は OHM に後継リレーションが
 *   無く（rel 2852945 Duchy of Austria が 1453-01-06 で打ち切り。Privilegium
 *   maius による大公位昇格日で領域の消滅ではない）、Roller 由来 hre_<year> も
 *   1500 年からしか無いため、どの上流にも面が無い（条件 1）。借用元は
 *   data/hre_1500.geojson の実在面（条件 2）。マクシミリアン 1 世の世襲領統合
 *   直後で 1492↔1500 に有意な領域変動が無く（条件 3）、隣接スナップショット年
 *   （条件 4）。なお Roller の Österreich は上・下オーストリア（30,693 km²）で
 *   シュタイアーマルク・チロル・ケルンテンを含まない。それらは借用元自体が
 *   存在しないため本エントリでは埋まらない（known-limitations に記録）。
 * - **ミラノ公国（1492 ← 1500）**: OHM は 1447〜1500 が空白（rel 2848818 が
 *   1447 で切れ、rel 2800654 は 1500 開始）で 1492 年に面が無い（条件 1）。
 *   借用元は data/italy_fiefs_1500.geojson の rel 2800654（条件 2）。1492 年も
 *   1500 年もスフォルツァ期の同一領域で、1499 年のフランス占領は支配者の交代
 *   であって領域の変化ではない（条件 3）。隣接スナップショット年（条件 4）。
 * - **ザクセン選帝侯領（1715 ← 1700）**: OHM の Electorate of Saxony は
 *   1423〜1485 の次が 1780-03-31〜1806 で 1485〜1780 が空白、Roller 由来の
 *   hre_<year> も 1700 年で打ち切られるため、1715 年はどの上流にも面が無い
 *   （実測: 1715 年の全レイヤーでドレスデン・ライプツィヒ・ヴィッテンベルクの
 *   3 点が base の Holy Roman Empire のみ。条件 1）。借用元は
 *   data/hre_1700.geojson の Electorate of Saxony（34,071 km²・条件 2）。
 *   1700↔1715 はいずれもアウグスト強王（フリードリヒ・アウグスト 1 世、
 *   在位 1694〜1733）の選帝侯領で、1697 年のポーランド王位兼任は同君連合、
 *   大北方戦争のスウェーデン占領（1706〜1707 年アルトランシュテット条約）も
 *   占領であって領域の変更ではない（条件 3）。1700 は 1715 の直前の
 *   スナップショット年（条件 4）。
 */
export const BORROWED_FEATURES: readonly BorrowedFeatureSpec[] = [
  {
    year: 1492,
    lineage: "hre",
    name: "Archduchy of Austria",
    from: {
      year: 1500,
      file: "data/hre_1500.geojson",
      sourceRef: "Roller territories_manual: id=Österreich",
    },
    reason:
      "1490 年のチロル継承・1493 年の世襲領統合を経たハプスブルク家の世襲領で、" +
      "1492 年と 1500 年で上・下オーストリアの領域に有意な変動が無い。" +
      "1453 年の大公位昇格は称号の変更であって領域の断絶ではない。",
  },
  {
    year: 1492,
    lineage: "italy",
    name: "Duchy of Milan",
    from: {
      year: 1500,
      file: "data/italy_fiefs_1500.geojson",
      sourceRef: "OpenHistoricalMap relation 2800654",
    },
    reason:
      "1492 年・1500 年ともスフォルツァ家支配下のミラノ公国で領域はほぼ同一。" +
      "1499 年のフランスによる征服は支配者の交代であり領域の変化ではない。",
  },
  {
    year: 1715,
    lineage: "hre",
    name: "Electorate of Saxony",
    from: {
      year: 1700,
      file: "data/hre_1700.geojson",
      sourceRef: "Roller territories_manual: id=albertinischesSachsennach1635",
    },
    reason:
      "1700 年・1715 年ともアウグスト強王（フリードリヒ・アウグスト 1 世）の" +
      "ザクセン選帝侯領で、領域は 1635 年のプラハ条約（ラウジッツ獲得）以降 " +
      "1815 年まで安定している。1697 年のポーランド王位兼任は同君連合であり" +
      "選帝侯領の領域を変えず、大北方戦争のスウェーデン占領（1706〜1707）も" +
      "占領であって割譲ではない。",
  },
];

/** 借用ファイルのパスを返す（純粋関数） */
export function borrowedPathFor(
  lineage: BorrowedLineage,
  year: number,
): string {
  return `data/borrowed_${lineage}_${year}.geojson`;
}

/**
 * 借用元の FeatureCollection から対象 feature を複製する（純粋関数）。
 *
 * geometry は structuredClone による丸ごとの複製で、簡略化も座標丸めも行わない
 * （ADR-0033 条件 2）。properties も借用元のまま引き継ぎ、借用の事実を
 * BORROWED_FROM（年・ファイル・ソース識別子）として足すだけにする。NAME /
 * SUBJECTO を触らないので、色キー（powers.ts colorKeyFor）も日本語表記
 * （name-ja.json）も既存年と同一キーに解決する。
 */
export function borrowFeature(
  source: FeatureCollection,
  spec: BorrowedFeatureSpec,
): Feature {
  const original = source.features.find((feature) =>
    feature.properties?.NAME === spec.name
  );
  if (original === undefined) {
    throw new Error(
      `${spec.from.file} に ${spec.name} が見つかりません（借用元が消えた可能性があります）`,
    );
  }
  const copy = structuredClone(original) as Feature;
  return {
    ...copy,
    properties: {
      ...(copy.properties ?? {}),
      BORROWED_FROM: {
        year: spec.from.year,
        file: spec.from.file,
        sourceRef: spec.from.sourceRef,
      },
    },
  };
}

/** 借用ファイル 1 件分の中身（metadata に借用元の一覧を持つ） */
export interface BorrowedCollection {
  readonly fc: FeatureCollection & {
    metadata: { borrowedFrom: BorrowedRecord[] };
  };
}

/** metadata.borrowedFrom の 1 件 */
export interface BorrowedRecord extends BorrowedSource {
  readonly name: string;
  readonly reason: string;
}

/**
 * 借用エントリ群から 1 ファイル分の FeatureCollection を組み立てる（純粋関数）。
 * sources は「借用元のパス → その FeatureCollection」。feature の並びは
 * 許可リストの並びで決定的。
 */
export function buildBorrowedCollection(
  specs: readonly BorrowedFeatureSpec[],
  sources: ReadonlyMap<string, FeatureCollection>,
): BorrowedCollection {
  const features: Feature[] = [];
  const borrowedFrom: BorrowedRecord[] = [];
  for (const spec of specs) {
    const source = sources.get(spec.from.file);
    if (source === undefined) {
      throw new Error(`借用元 ${spec.from.file} が読み込まれていません`);
    }
    features.push(borrowFeature(source, spec));
    borrowedFrom.push({
      name: spec.name,
      year: spec.from.year,
      file: spec.from.file,
      sourceRef: spec.from.sourceRef,
      reason: spec.reason,
    });
  }
  return {
    fc: { type: "FeatureCollection", features, metadata: { borrowedFrom } },
  };
}

/** 許可リストを (系統, 年) ごとにまとめる（純粋関数） */
export function groupBorrowedFeatures(
  specs: readonly BorrowedFeatureSpec[] = BORROWED_FEATURES,
): Map<string, BorrowedFeatureSpec[]> {
  const groups = new Map<string, BorrowedFeatureSpec[]>();
  for (const spec of specs) {
    const path = borrowedPathFor(spec.lineage, spec.year);
    const group = groups.get(path);
    if (group === undefined) groups.set(path, [spec]);
    else group.push(spec);
  }
  return groups;
}

async function main(): Promise<void> {
  const sources = new Map<string, FeatureCollection>();
  for (const spec of BORROWED_FEATURES) {
    if (sources.has(spec.from.file)) continue;
    sources.set(
      spec.from.file,
      JSON.parse(
        await Deno.readTextFile(spec.from.file),
      ) as FeatureCollection,
    );
  }
  for (const [path, specs] of groupBorrowedFeatures()) {
    const { fc } = buildBorrowedCollection(specs, sources);
    // 出典（source / sourceUrl / license / borderPrecision）は
    // build-attribution.ts が系統から解決して刻む。metadata.borrowedFrom は
    // そのまま温存される（withAttribution は既存キーを残す）。
    await Deno.writeTextFile(path, serializeWithAttribution(path, fc));
    console.log(
      `${path}: ${fc.features.length} 件（${
        specs.map((spec) => `${spec.name} ← ${spec.from.year}`).join(" / ")
      }）`,
    );
  }
}

if (import.meta.main) {
  await main();
}
