/**
 * 領邦・諸侯領オーバーレイ同士の「二重塗り・微小重なり」を解消した派生データを
 * 生成するパイプライン（TASK-79 / TASK-86）。
 *
 * 入力は既存の生成物のみ（ネットワーク不要）:
 * - data/france_fiefs_<year>.geojson（scripts/build-france-fiefs.ts）
 * - data/hre_fiefs_<year>.geojson（scripts/build-hre-fiefs.ts、TASK-85）
 * - data/italy_fiefs_<year>.geojson（scripts/build-italy-fiefs.ts、TASK-95）
 *
 * 出力:
 * - data/france_fiefs_flat_<year>.geojson（year ∈ FIEF_FLAT_YEARS）… 重なりを
 *   排他化した中世フランス諸侯領。ランタイム（src/powers.ts
 *   franceFiefDataUrlFor）はこちらを取得し、france-fiefs レイヤーの塗り・
 *   境界線・ラベル・picking の全てに使う。
 * - data/hre_fiefs_flat_<year>.geojson（year ∈ HRE_FIEF_FLAT_YEARS）… 同じ扱いの
 *   中世 HRE 領邦（src/powers.ts hreDataUrlFor が中世年代で参照する）。
 *   削り方針だけ OverlapCutPolicy = "keep-smaller" で異なる（理由は同型の解説）。
 *   1000〜1492 は仏諸侯領・伊諸侯領と同時に表示されるため、subtractOverlay で
 *   レイヤーをまたぐ重なりも取り除く。
 * - data/italy_fiefs_flat_<year>.geojson（year ∈ ITALY_FIEF_FLAT_YEARS、TASK-96）…
 *   同じ扱いの中世イタリア諸侯領（src/powers.ts italyFiefDataUrlFor が参照する）。
 *   削り方針は HRE 領邦と同じ "keep-smaller"。
 * - data/britain_fiefs_flat_<year>.geojson（year ∈ BRITAIN_FIEF_FLAT_YEARS、
 *   TASK-151）… 同じ扱いのブリテン諸島の政体。削り方針は "keep-smaller"。
 *   地図への表示は後続 TASK-153 で、ここではデータチェーンにだけ載せる。
 * - data/sovereign_fiefs_flat_<year>.geojson（year ∈ SOVEREIGN_FIEF_FLAT_YEARS、
 *   #189）… 同じ扱いの中東欧・バルカン・東欧の主権政体。削り方針は
 *   "keep-smaller"。全系統の最後に flat 化し、他系統との重なりは常に本系統から
 *   差し引く（buildSovereignFiefFlat の解説を参照）。
 * - data/borrowed_<lineage>_flat_<year>.geojson（#215）… 隣接年から流用した面
 *   （scripts/build-borrowed-fiefs.ts）からホスト系統 flat を差し引いたもの。
 *   借用元ファイル（borrowed_<lineage>_<year>.geojson）は座標無改変のまま残し
 *   （ADR-0033 条件 2）、表示・配信はこちらを使う（buildBorrowedFlat の解説を
 *   参照）。
 *
 * ## なぜ必要か
 * 諸侯領は 1 枚のレイヤーに半透明（src/powers.ts FILL_ALPHA=128）で描かれる。
 * 親公領に内包される伯領（Alençon ⊂ Normandy）は同じ場所を 2 枚の塗りが覆うため
 * 色が濃くなり、境界線も 2 本走って区画が読めなくなる。OHM の別リレーション
 * 同士の境界不一致による微小重なり（Champagne×Bar 等）も同様に濃い帯を作る。
 *
 * ## 方式（実データの分布に基づく設計判断）
 * 重なりを 2 種に分け、削る側を変える:
 * - 内包（被覆率 >= CONTAINMENT_COVERAGE_THRESHOLD）: 親（面積が大きい側）から
 *   子を difference する。子は輪郭・ラベル・picking をそのまま保ち、階層関係は
 *   「親の輪郭の内側に子の区画がある」という入れ子構造で示す。
 * - スリバー（それ未満の重なり）: 面積が小さい側から削る。境界不一致は
 *   どちらの形も正しくないが、より広い（＝代表的な）側の形を保つ方が
 *   地図の読み取りに与える影響が小さい。
 *
 * ### 代替案「子側を塗りなし＋点線輪郭」との比較（不採用）
 * 内包される子を塗らず点線輪郭だけにすれば二重塗りは同じく消える。しかし
 * (1) 子の塗り色（colors.json の諸侯ごとの決定的な色）が失われ、親と子を
 *     色で識別できなくなる（諸侯領オーバーレイの目的そのものを損なう）、
 * (2) 塗りが無いと deck.gl の GeoJsonLayer は内部を picking しない
 *     （filled=false は fill メッシュを描かない）ため、子のホバー/クリックが
 *     効かなくなる（AC の「子の picking は維持」に反する）、
 * (3) 点線は諸侯領の藍紫実線・base の焦茶実線に次ぐ 3 本目の線種となり、
 *     凡例の複雑さに見合わない、
 * という 3 点で劣る。difference 方式はいずれの副作用も持たず、
 * 「見えている塗りの面積 = その諸侯が単独で支配する面」という素直な意味づけになる。
 *
 * ## 閾値の根拠（1000/1100/1200/1279/1300 の全ペアを実測）
 * 小さい側から見た被覆率は 1.0000（Alençon×Normandy）と 0.0541
 * （Bar×Champagne）の 2 群に完全に分かれ、その間に観測値が無い。
 * CONTAINMENT_COVERAGE_THRESHOLD = 0.9 はこの空隙の中にあり、
 * scripts/build-fief-dedupe.ts が「完全内包」と呼ぶ閾値とも一致する。
 * 非内包の重なりは最大 332 km²（Bar×Champagne）で、SLIVER_AREA_LIMIT_M2
 * （1,000 km²）はその 3 倍。これを超える非内包の重なりは境界不一致では
 * 説明できない規模なので、削りはするが警告を残して人が気付けるようにする。
 *
 * 決定性: 判定は常に入力（元）ジオメトリに対して行い、削りは (削る側 index,
 * 相手 index) の昇順で適用する。feature の並び・properties は入力のまま。
 * 座標は base データと同じ COORD_PRECISION へ丸める。
 */

import area from "@turf/area";
import difference from "@turf/difference";
import { featureCollection } from "@turf/helpers";
import intersect from "@turf/intersect";
import truncate from "@turf/truncate";
import type {
  Feature,
  FeatureCollection,
  MultiPolygon,
  Polygon,
} from "geojson";
import { serializeWithAttribution } from "./build-attribution.ts";
import { COORD_PRECISION } from "./build-data.ts";
import { cleanFeatureCollection, formatCleanStats } from "./clean-polygons.ts";
import { BRITAIN_FIEF_YEARS } from "./build-britain-fiefs.ts";
import { SOVEREIGN_FIEF_YEARS } from "./build-sovereign-fiefs.ts";
import { FRANCE_FIEF_YEARS } from "./build-france-fiefs.ts";
import { HRE_FIEF_YEARS } from "./build-hre-fiefs.ts";
import { ITALY_FIEF_YEARS } from "./build-italy-fiefs.ts";
import {
  CLIOPATRIA_FIEF_YEARS,
  cliopatriaRawPathFor,
} from "./build-cliopatria-fiefs.ts";
import { removePinchPoints } from "./build-hre-fiefs.ts";
import {
  BORROWED_FEATURES,
  borrowedFlatPathFor,
  type BorrowedLineage,
  borrowedPathFor,
} from "./build-borrowed-fiefs.ts";

// 借用 flat のパス定義は build-borrowed-fiefs.ts に置く（孤児掃除・#218 AC2 が
// raw と flat の期待集合を許可リストから導出するため。逆向きの import は循環に
// なる）。生成は本スクリプト（buildBorrowedFlat）が担うので、従来どおり
// ここからも参照できるよう re-export する。
export { borrowedFlatPathFor };

/** 生成対象年。諸侯領オーバーレイが存在する年と同一 */
export const FIEF_FLAT_YEARS: readonly number[] = FRANCE_FIEF_YEARS;

/**
 * HRE 領邦（OHM 由来・TASK-85）の生成対象年。build-hre-fiefs.ts の対象年と同一。
 */
export const HRE_FIEF_FLAT_YEARS: readonly number[] = HRE_FIEF_YEARS;

/**
 * イタリア諸侯領（OHM 由来・TASK-95）の生成対象年。build-italy-fiefs.ts の
 * 対象年と同一。
 */
export const ITALY_FIEF_FLAT_YEARS: readonly number[] = ITALY_FIEF_YEARS;

/**
 * Cliopatria 由来の諸侯領・領邦（TASK-110）の生成対象年。
 * build-cliopatria-fiefs.ts の対象年と同一。
 */
export const CLIOPATRIA_FIEF_FLAT_YEARS: readonly number[] =
  CLIOPATRIA_FIEF_YEARS;

/**
 * ブリテン諸島の政体（OHM 由来・TASK-151）の生成対象年。
 * build-britain-fiefs.ts の対象年と同一。
 */
export const BRITAIN_FIEF_FLAT_YEARS: readonly number[] = BRITAIN_FIEF_YEARS;

/**
 * 主権政体オーバーレイ（OHM 由来・#189）の生成対象年。
 * build-sovereign-fiefs.ts の対象年と同一。
 */
export const SOVEREIGN_FIEF_FLAT_YEARS: readonly number[] =
  SOVEREIGN_FIEF_YEARS;

/** 借用面（#202 / #209）の flat 化対象年を系統ごとに引く（#215） */
export function borrowedFlatYearsFor(lineage: BorrowedLineage): number[] {
  return [
    ...new Set(
      BORROWED_FEATURES.filter((spec) => spec.lineage === lineage).map(
        (spec) => spec.year,
      ),
    ),
  ].sort((a, b) => a - b);
}

/**
 * 借用面（HRE 系統）の flat 化対象年（#215）。
 * build-borrowed-fiefs.ts の許可リスト（lineage="hre"）と同一。
 */
export const BORROWED_HRE_FLAT_YEARS: readonly number[] = borrowedFlatYearsFor(
  "hre",
);

/**
 * 借用面（イタリア諸侯領系統）の flat 化対象年（#215）。
 * build-borrowed-fiefs.ts の許可リスト（lineage="italy"）と同一。
 */
export const BORROWED_ITALY_FLAT_YEARS: readonly number[] =
  borrowedFlatYearsFor("italy");

/**
 * 重なりを解消するとき「どちら側のジオメトリを削るか」の方針（TASK-86）。
 *
 * - "containment-aware"（既定・中世フランス諸侯領 / TASK-79）: 内包は親（大きい側）
 *   を削り、スリバーは小さい側を削る。仏諸侯領の重なりは 1.0000（親子）と 0.0541
 *   以下（境界不一致）に二分され、中間が無いためこの 2 分岐で足りる。
 * - "keep-smaller"（HRE 領邦 / TASK-86、イタリア諸侯領 / TASK-96）: 内包かスリバーかに
 *   関わらず常に大きい側を削り、小さい側の形を丸ごと残す。
 *
 * なぜ HRE では方針を変えるのか（1000〜1492 の全ペアを実測した結果）:
 * 帝国は部族大公領（Franconia・Saxony・Lower Lotharingia 等）の中に司教領・
 * 帝国修道院領・城伯領が入れ子で存在し、しかも OHM 側の境界が両者で一致しない。
 * その結果「小さい側から見た被覆率」が仏諸侯領のような 0/1 の二極ではなく
 * 中間帯に散らばる（Burgraviate of Nuremberg × Duchy of Franconia = 0.77、
 * Imperial Abbey of Hersfeld は Franconia 0.77 + Thuringia 0.23 で合計 1.00、
 * Imperial Abbey of Werden は Lower Lotharingia 0.45 + Saxony 0.55）。
 * "containment-aware" をそのまま当てると、これらは内包と判定されず「小さい側を
 * 削る」に落ちるため、Hersfeld や Werden のような帝国修道院領は面がほぼ残らず
 * 地図から消えてしまう。常に大きい側を削れば、
 * - 小さい領邦（＝より個別性の高い情報）は形・色・ラベル・picking を完全に保つ
 * - 大きい大公領は面積のごく一部を失うだけで、輪郭の外形は変わらない
 * となり、実データの入れ子構造をそのまま「大公領の中に個別領邦が抜けている」
 * 絵として描ける。
 *
 * イタリア諸侯領でも同じ方針を採る（TASK-96。1000〜1492 の全ペアを実測）:
 * 被覆率は 0.9955〜0.9982 の内包群（Santa Fiora / Sovana ⊂ シエナ共和国、
 * ミランドラ公国 ⊂ モデナ＝レッジョ公領）と 0.27 以下の群に分かれ、閾値 0.9 でも
 * 判定自体は成立する。それでも "keep-smaller" を採るのは、閾値未満の側に
 * 「境界不一致ではない実在の入れ子」が混ざるため:
 * - 1100 年 Republic of Pisa × March of Tuscany = 4,356 km²（ピサの 27%）。
 *   ピサのコンタード（周辺農村）はトスカーナ辺境伯領の内側にあり、
 *   "containment-aware" だと小さい側のピサから 27% を削ってしまう。
 * - 1300/1400 Lordship of Oneglia × Republic of Genoa = 28 km²（オネーリアの 10%）。
 *   270 km² の小領主領から 10% を削ると形が痩せる。
 * 常に大きい側を削れば、都市共和国・小伯領という「より個別性の高い情報」が
 * 形・色・ラベル・picking を完全に保ち、辺境伯領・大共和国は面積の数 % を失う
 * だけで外形が変わらない。なお 4,356 km² の重なりは SLIVER_AREA_LIMIT_M2 を
 * 超えるため方針に関わらず警告が出るが、これは「境界不一致では説明できない
 * 規模」を人へ知らせる設計どおりの挙動で、実データを確認した結果
 * （ピサ ⊂ トスカーナの実在の入れ子）として受け入れる。
 */
export type OverlapCutPolicy = "containment-aware" | "keep-smaller";

/** 既定の削り方針（TASK-79 の中世フランス諸侯領で確立したもの） */
export const DEFAULT_CUT_POLICY: OverlapCutPolicy = "containment-aware";

/**
 * 内包と判定する被覆率（小さい側の面積に対する重なりの割合）の下限。
 * 実測値は 1.0000 と 0.0541 に二分され、その間に観測値は無い。
 */
export const CONTAINMENT_COVERAGE_THRESHOLD = 0.9;

/**
 * 処理対象にする重なり面積の下限（m²）。1,000 m²（0.001 km²）未満は
 * 座標丸め（COORD_PRECISION=5 ≒ 1m）由来のノイズとみなして無視する。
 * 実測の最小重なりは Artois×Flanders の 0.01 km²（= 10,000 m²）で、
 * 実データの重なりは全てこの下限を超える。
 */
export const MIN_OVERLAP_AREA_M2 = 1_000;

/** スリバーとして黙って削れる重なり面積の上限（m²）。実測最大 332 km² の約 3 倍 */
export const SLIVER_AREA_LIMIT_M2 = 1_000e6;

/** 重なりの種別。none は処理対象外 */
export type OverlapKind = "containment" | "sliver" | "none";

/** ポリゴン系ジオメトリを持つ feature */
type PolygonalFeature = Feature<Polygon | MultiPolygon>;

/** feature がポリゴン系ジオメトリを持つか */
function isPolygonal(feature: Feature): feature is PolygonalFeature {
  const type = feature.geometry?.type;
  return type === "Polygon" || type === "MultiPolygon";
}

/** properties.NAME を取り出す。空文字・非文字列は "(no name)" */
function nameOf(feature: Feature): string {
  const value = feature.properties?.NAME;
  return typeof value === "string" && value !== "" ? value : "(no name)";
}

/**
 * 重なり面積と「小さい側の面積」から重なりの種別を決める（純粋関数）。
 * 被覆率は必ず小さい側を分母に取る: 大きい側を分母にすると内包でも比が
 * 小さくなり（Alençon ⊂ Normandy は 0.06）判定できない。
 */
export function classifyOverlap(
  overlapArea: number,
  smallerArea: number,
): OverlapKind {
  if (!(overlapArea >= MIN_OVERLAP_AREA_M2)) return "none";
  if (smallerArea <= 0) return "none";
  return overlapArea / smallerArea >= CONTAINMENT_COVERAGE_THRESHOLD
    ? "containment"
    : "sliver";
}

/** 検出した重なり 1 件（どちらを削るかまで決まっている） */
export interface OverlapPair {
  /** 削る側の feature index（入力配列内） */
  cutIndex: number;
  /** 形を保つ側の feature index */
  keepIndex: number;
  /** 削る側の NAME */
  cutName: string;
  /** 形を保つ側の NAME */
  keepName: string;
  kind: "containment" | "sliver";
  /** 重なりの測地面積（m²） */
  overlapArea: number;
  /** 面積が小さい側から見た被覆率（0..1） */
  coverageOfSmaller: number;
}

/**
 * feature 群の全ペアから処理対象の重なりを列挙する（純粋関数）。
 * 判定は入力ジオメトリのみに依存し、削りの適用順に影響されない。
 * 返り値は (cutIndex, keepIndex) の昇順で決定的。
 */
export function overlapsOf(
  features: readonly Feature[],
  warnFn: (message: string) => void = console.warn,
  policy: OverlapCutPolicy = DEFAULT_CUT_POLICY,
): OverlapPair[] {
  const pairs: OverlapPair[] = [];
  const areas = features.map((f) => (isPolygonal(f) ? area(f) : 0));
  for (let i = 0; i < features.length; i++) {
    if (!isPolygonal(features[i])) continue;
    for (let j = i + 1; j < features.length; j++) {
      if (!isPolygonal(features[j])) continue;
      let overlap: Feature<Polygon | MultiPolygon> | null;
      try {
        overlap = intersect(
          featureCollection([
            features[i] as PolygonalFeature,
            features[j] as PolygonalFeature,
          ]),
        );
      } catch (error) {
        // 交差計算に失敗したペアは「重なり無し」として続行する
        // （生成を失敗させない: build-fief-dedupe.ts と同方針）
        warnFn(
          `${nameOf(features[i])} と ${
            nameOf(features[j])
          } の交差計算に失敗しました: ${String(error)}`,
        );
        continue;
      }
      if (overlap === null) continue;
      const overlapArea = area(overlap);
      const smallerIndex = areas[i] <= areas[j] ? i : j;
      const largerIndex = smallerIndex === i ? j : i;
      const kind = classifyOverlap(overlapArea, areas[smallerIndex]);
      if (kind === "none") continue;
      // 内包は親（大きい側）を削り、子の形を丸ごと残す。
      // スリバーは既定方針では小さい側を削り、より広い側の形を保つ。
      // "keep-smaller"（HRE 領邦）は種別に関わらず常に大きい側を削る。
      const cutIndex = policy === "keep-smaller" || kind === "containment"
        ? largerIndex
        : smallerIndex;
      const keepIndex = cutIndex === i ? j : i;
      if (kind === "sliver" && overlapArea > SLIVER_AREA_LIMIT_M2) {
        warnFn(
          `${nameOf(features[i])} と ${nameOf(features[j])} の重なり ${
            (overlapArea / 1e6).toFixed(1)
          } km² は内包でもスリバーの想定規模でもありません（${
            nameOf(features[cutIndex])
          } を削りますが元データの確認が必要です）`,
        );
      }
      pairs.push({
        cutIndex,
        keepIndex,
        cutName: nameOf(features[cutIndex]),
        keepName: nameOf(features[keepIndex]),
        kind,
        overlapArea,
        coverageOfSmaller: overlapArea / areas[smallerIndex],
      });
    }
  }
  pairs.sort((a, b) => a.cutIndex - b.cutIndex || a.keepIndex - b.keepIndex);
  return pairs;
}

/** 解消結果 1 件（レポート・メタデータ用の表示形） */
export interface OverlapResolution {
  kind: "containment" | "sliver";
  /** 削られた諸侯領の NAME */
  cutName: string;
  /** 形を保った諸侯領の NAME */
  keptName: string;
  /** 重なりの面積（km²、小数 2 桁） */
  overlapKm2: number;
  /** 面積が小さい側から見た被覆率（0..1、小数 4 桁） */
  coverageOfSmaller: number;
}

/** resolveOverlaps の結果 */
export interface ResolvedOverlaps {
  fc: FeatureCollection;
  resolutions: OverlapResolution[];
}

/**
 * 諸侯領同士の重なりを排他化した FeatureCollection を返す（純粋関数）。
 * - feature の並び・properties・非ポリゴン feature はそのまま保つ
 * - 削る側だけジオメトリを差し替える（相手の元ジオメトリで difference）
 * - difference が null（削った結果が消滅）になる場合は元のまま残して警告する
 *   （面が消えるより二重塗りが残る方が安全）
 * 座標は COORD_PRECISION へ丸める（新しくできる交点の桁が伸びるため）。
 */
export function resolveOverlaps(
  fc: FeatureCollection,
  warnFn: (message: string) => void = console.warn,
  policy: OverlapCutPolicy = DEFAULT_CUT_POLICY,
): ResolvedOverlaps {
  const original = fc.features;
  const pairs = overlapsOf(original, warnFn, policy);
  const geometries = original.map((f) => f.geometry);
  for (const pair of pairs) {
    const target = original[pair.cutIndex];
    const current: PolygonalFeature = {
      ...target,
      geometry: geometries[pair.cutIndex] as Polygon | MultiPolygon,
    };
    let cut: Feature<Polygon | MultiPolygon> | null;
    try {
      cut = difference(
        featureCollection([
          current,
          original[pair.keepIndex] as PolygonalFeature,
        ]),
      );
    } catch (error) {
      warnFn(
        `${pair.cutName} から ${pair.keepName} を差し引けませんでした: ${
          String(error)
        }`,
      );
      continue;
    }
    if (cut === null) {
      warnFn(
        `${pair.cutName} は ${pair.keepName} を差し引くと消滅するため元のまま残します`,
      );
      continue;
    }
    geometries[pair.cutIndex] = cut.geometry;
  }
  const features = original.map((feature, index) =>
    geometries[index] === feature.geometry
      ? feature
      : { ...feature, geometry: geometries[index] }
  );
  const truncated = truncate(
    { type: "FeatureCollection", features } as FeatureCollection,
    { precision: COORD_PRECISION, coordinates: 2 },
  );
  return {
    fc: truncated,
    resolutions: pairs.map((pair) => ({
      kind: pair.kind,
      cutName: pair.cutName,
      keptName: pair.keepName,
      overlapKm2: Number((pair.overlapArea / 1e6).toFixed(2)),
      coverageOfSmaller: Number(pair.coverageOfSmaller.toFixed(4)),
    })),
  };
}

/** 別レイヤーの領域を差し引いた 1 件（メタデータ・レポート用） */
export interface ExternalRemoval {
  /** 削られた feature の NAME */
  cutName: string;
  /** 削る根拠になった別レイヤー側の NAME */
  externalName: string;
  /** 重なりの面積（km²、小数 2 桁） */
  overlapKm2: number;
}

/** subtractOverlay の結果 */
export interface SubtractedOverlay {
  fc: FeatureCollection;
  removals: ExternalRemoval[];
}

/**
 * 別レイヤーで描かれる領域（others）を差し引いた FeatureCollection を返す
 * （純粋関数、TASK-86）。
 *
 * 1000〜1300 は仏諸侯領（france-fiefs）と HRE 領邦（hre-powers）の 2 枚が同時に
 * 表示される。同じ土地を両方が塗ると半透明が重なって濃くなり、境界線も二重に
 * 走る（resolveOverlaps がレイヤー内の重なりに対して解いているのと同じ問題）。
 * レイヤーをまたぐ分は幾何的な入れ子関係で決まるため、より局所的・具体的な側
 * （仏諸侯領）を残し、帝国側の広域な公領から差し引く。
 *
 * 実データで該当するのは 1100 年の Duchy of Upper Lotharingia × County of Bar
 * （5,544 km²、Bar の 90%）の 1 件のみで、他の年・組み合わせでは
 * MIN_OVERLAP_AREA_M2 を超える重なりが無い。
 *
 * feature の並び・properties は保持し、削る対象が無い feature は同一参照のまま
 * 返す。判定・差し引きは (対象 index, others index) の昇順で決定的。
 */
export function subtractOverlay(
  fc: FeatureCollection,
  others: readonly Feature[],
  warnFn: (message: string) => void = console.warn,
): SubtractedOverlay {
  const removals: ExternalRemoval[] = [];
  const geometries = fc.features.map((f) => f.geometry);
  const externals = others.filter(isPolygonal);
  for (const [index, feature] of fc.features.entries()) {
    if (!isPolygonal(feature)) continue;
    for (const external of externals) {
      const current: PolygonalFeature = {
        ...feature,
        geometry: geometries[index] as Polygon | MultiPolygon,
      };
      let overlap: Feature<Polygon | MultiPolygon> | null;
      try {
        overlap = intersect(featureCollection([current, external]));
      } catch (error) {
        warnFn(
          `${nameOf(feature)} と ${
            nameOf(external)
          } の交差計算に失敗しました: ${String(error)}`,
        );
        continue;
      }
      if (overlap === null) continue;
      const overlapArea = area(overlap);
      if (overlapArea < MIN_OVERLAP_AREA_M2) continue;
      let cut: Feature<Polygon | MultiPolygon> | null;
      try {
        cut = difference(featureCollection([current, external]));
      } catch (error) {
        warnFn(
          `${nameOf(feature)} から ${
            nameOf(external)
          } を差し引けませんでした: ${String(error)}`,
        );
        continue;
      }
      if (cut === null) {
        warnFn(
          `${nameOf(feature)} は ${
            nameOf(external)
          } を差し引くと消滅するため元のまま残します`,
        );
        continue;
      }
      geometries[index] = cut.geometry;
      removals.push({
        cutName: nameOf(feature),
        externalName: nameOf(external),
        overlapKm2: Number((overlapArea / 1e6).toFixed(2)),
      });
    }
  }
  const features = fc.features.map((feature, index) =>
    geometries[index] === feature.geometry
      ? feature
      : { ...feature, geometry: geometries[index] }
  );
  const truncated = truncate(
    { type: "FeatureCollection", features } as FeatureCollection,
    { precision: COORD_PRECISION, coordinates: 2 },
  );
  return { fc: truncated, removals };
}

/** 入力（build-france-fiefs.ts の生成物）のパス */
export function rawPathFor(year: number): string {
  return `data/france_fiefs_${year}.geojson`;
}

/** 出力（重なり解消済み）のパス */
export function flatPathFor(year: number): string {
  return `data/france_fiefs_flat_${year}.geojson`;
}

/** 入力（build-hre-fiefs.ts の生成物）のパス（TASK-86） */
export function hreRawPathFor(year: number): string {
  return `data/hre_fiefs_${year}.geojson`;
}

/** 出力（HRE 領邦・重なり解消済み）のパス（TASK-86） */
export function hreFlatPathFor(year: number): string {
  return `data/hre_fiefs_flat_${year}.geojson`;
}

/** 入力（build-italy-fiefs.ts の生成物）のパス（TASK-96） */
export function italyRawPathFor(year: number): string {
  return `data/italy_fiefs_${year}.geojson`;
}

/** 出力（イタリア諸侯領・重なり解消済み）のパス（TASK-96） */
export function italyFlatPathFor(year: number): string {
  return `data/italy_fiefs_flat_${year}.geojson`;
}

/** 出力（Cliopatria 由来・重なり解消済み）のパス（TASK-110） */
export function cliopatriaFlatPathFor(year: number): string {
  return `data/cliopatria_fiefs_flat_${year}.geojson`;
}

/** 入力（build-britain-fiefs.ts の生成物）のパス（TASK-151） */
export function britainRawPathFor(year: number): string {
  return `data/britain_fiefs_${year}.geojson`;
}

/** 出力（ブリテン諸島の政体・重なり解消済み）のパス（TASK-151） */
export function britainFlatPathFor(year: number): string {
  return `data/britain_fiefs_flat_${year}.geojson`;
}

/** 入力（build-sovereign-fiefs.ts の生成物）のパス（#189） */
export function sovereignRawPathFor(year: number): string {
  return `data/sovereign_fiefs_${year}.geojson`;
}

/** 出力（主権政体・重なり解消済み）のパス（#189） */
export function sovereignFlatPathFor(year: number): string {
  return `data/sovereign_fiefs_flat_${year}.geojson`;
}

/** *_flat_<year>.geojson に埋め込むメタデータ */
export interface FiefFlatMetadata {
  generatedBy: string;
  /** 入力ファイルのパス */
  input: string;
  year: number;
  /** 適用した削り方針（TASK-86） */
  cutPolicy: OverlapCutPolicy;
  containmentCoverageThreshold: number;
  minOverlapAreaM2: number;
  sliverAreaLimitM2: number;
  /** 解消した重なりの一覧（削る側 → 相手の feature 並び順で決定的） */
  resolutions: OverlapResolution[];
  /**
   * 別レイヤー（仏諸侯領・伊諸侯領）と重なるため差し引いた一覧
   * （TASK-86 / TASK-96。無ければ省略）
   */
  externalRemovals?: ExternalRemoval[];
  /**
   * externalRemovals の入力ファイル（TASK-86。TASK-96 で複数系統を差し引ける
   * ようにしたため配列。無ければ省略）
   */
  externalInputs?: string[];
  /**
   * 入力側の metadata.borrowedFrom をそのまま温存する（ADR-0033 の追跡可能性 /
   * ADR-0039 の年借用。借用が無いファイルでは省略）。
   */
  borrowedFrom?: unknown;
}

async function readCollection(path: string): Promise<FeatureCollection> {
  return JSON.parse(await Deno.readTextFile(path)) as FeatureCollection;
}

/**
 * difference で生じた微小パート・微小な穴を落とす（TASK-81 のクリーンアップを
 * 派生データにも適用する）。
 *
 * 重なりを削ると、境界がわずかにずれた 2 つのポリゴンの差分として面積 0〜数百 m²
 * のかけら（1492 年の Electorate of Cologne では 0 m² のものを含む 10 件以上）が
 * 残る。描画では見えないが、data/*.geojson 全体に掛かる不変条件
 * （scripts/clean-polygons_test.ts）を破るうえ、ファイルサイズも無駄に増やす。
 *
 * 面が丸ごと消える feature が出た場合は生成を止める: 領邦が 1 つ地図から
 * 消えることになり、黙って進めてよい状態ではない。
 */
function cleanFlat(fc: FeatureCollection, label: string): FeatureCollection {
  const { fc: cleaned, stats } = cleanFeatureCollection(fc, COORD_PRECISION);
  if (stats.droppedFeatures.length > 0) {
    throw new Error(
      `${label}: クリーンアップで面が残らなかった feature があります: ${
        stats.droppedFeatures.join(", ")
      }`,
    );
  }
  const line = formatCleanStats(stats);
  if (line !== null) console.log(line);
  return cleaned;
}

/**
 * 1 点で接触するリング（くびれ）を解いた FeatureCollection を返す（TASK-110）。
 *
 * difference の交点を COORD_PRECISION へ丸めると、近接した 2 頂点が同一座標へ
 * 潰れて「穴が外環に 1 点で触れる」形が生まれることがある（実測では Cliopatria
 * 由来の County of Vermandois が 1000 / 1100 年に該当し、[3.64753,50.04648] を
 * 2 回通る）。面としては正しいので clean-polygons.ts の
 * normalizeSelfIntersections では解けないが、@turf/kinks は自己交差として
 * 検出するため data/ 全体の「自己交差ゼロ」不変条件
 * （scripts/clean-polygons_test.ts）を破る。build-hre-fiefs.ts が同種のくびれに
 * 対して持つ removePinchPoints を、派生データ側でもそのまま使う。
 *
 * 既存の 3 系統（仏・伊・帝国）には適用しない: いずれも実データでくびれが
 * 発生しておらず、通すと丸め由来の無用な差分が出るため。TASK-151 で追加した
 * ブリテン諸島には最初から適用する（新設系統なので差分の懸念が無く、
 * くびれ無しなら入力をそのまま返すため無害）。
 *
 * 副作用: くびれの頂点を落とすと、その頂点で切れていた「相手レイヤーの切り欠き」の
 * 先端が塞がり、差し引いたはずの面がごく僅かに戻る。実測で残るのは
 * 1000 / 1100 年の County of Vermandois × Duchy of Lower Lotharingia の
 * 1.83 km²（Vermandois 17,404 km² の 0.01%、差し渡し約 1.3 km）1 件だけで、
 * 最大ズーム z8 でも数ピクセルにしかならない。戻った分をもう一度差し引くと
 * 同じ位置にくびれが再生して自己交差ゼロの不変条件を満たせなくなるため
 * （2 巡させても収束しないことを実測で確認）、ここでは自己交差ゼロを優先する。
 */
function unpinch(fc: FeatureCollection): FeatureCollection {
  let removed = 0;
  const features = fc.features.map((feature) => {
    if (!isPolygonal(feature)) return feature;
    const result = removePinchPoints(
      feature.geometry as Polygon | MultiPolygon,
    );
    if (result.removed === 0 || result.geometry === null) return feature;
    removed += result.removed;
    return { ...feature, geometry: result.geometry };
  });
  if (removed === 0) return fc;
  console.log(`  くびれ（1 点接触）を解消: ${removed} 頂点`);
  return { ...fc, features };
}

function logResolutions(resolutions: readonly OverlapResolution[]): void {
  for (const r of resolutions) {
    console.log(
      `  ${
        r.kind === "containment" ? "内包  " : "スリバー"
      } ${r.cutName} -= ${r.keptName} (${r.overlapKm2} km², 被覆率 ${r.coverageOfSmaller})`,
    );
  }
}

/** 中世フランス諸侯領の flat 化（TASK-79） */
async function buildFranceFiefFlat(): Promise<void> {
  for (const year of FIEF_FLAT_YEARS) {
    const raw = await readCollection(rawPathFor(year));
    const { fc, resolutions } = resolveOverlaps(raw);
    const metadata: FiefFlatMetadata = {
      generatedBy: "scripts/build-fief-flat.ts",
      input: rawPathFor(year),
      year,
      cutPolicy: DEFAULT_CUT_POLICY,
      containmentCoverageThreshold: CONTAINMENT_COVERAGE_THRESHOLD,
      minOverlapAreaM2: MIN_OVERLAP_AREA_M2,
      sliverAreaLimitM2: SLIVER_AREA_LIMIT_M2,
      resolutions,
    };
    const outPath = flatPathFor(year);
    const json = serializeWithAttribution(outPath, {
      ...cleanFlat(fc, outPath),
      metadata,
    });
    await Deno.writeTextFile(outPath, json);
    console.log(
      `${outPath}: ${json.length} bytes, features=${fc.features.length}, 解消=${resolutions.length} 件`,
    );
    logResolutions(resolutions);
  }
}

/**
 * 中世イタリア諸侯領の flat 化（TASK-96）。
 *
 * 削り方針は "keep-smaller"（OverlapCutPolicy の解説を参照）。別レイヤーの
 * 差し引き（subtractOverlay）は行わない: 実測で仏諸侯領との重なりは全年ゼロ、
 * HRE 領邦との重なりは 3 件（最大 280 km²）だけで、いずれも伊側の方が局所的
 * （March of Montferrat 3,380 km² ⊂ Duchy of Milan 46,551 km² 等）なため、
 * より広域な HRE 側から差し引く（buildHreFiefFlat が伊 flat を入力に取る）。
 * 同じ重なりを両側から削ると土地が誰にも塗られない隙間になる。
 */
async function buildItalyFiefFlat(): Promise<void> {
  for (const year of ITALY_FIEF_FLAT_YEARS) {
    const raw = await readCollection(italyRawPathFor(year));
    const { fc, resolutions } = resolveOverlaps(
      raw,
      console.warn,
      "keep-smaller",
    );
    const metadata: FiefFlatMetadata = {
      generatedBy: "scripts/build-fief-flat.ts",
      input: italyRawPathFor(year),
      year,
      cutPolicy: "keep-smaller",
      containmentCoverageThreshold: CONTAINMENT_COVERAGE_THRESHOLD,
      minOverlapAreaM2: MIN_OVERLAP_AREA_M2,
      sliverAreaLimitM2: SLIVER_AREA_LIMIT_M2,
      resolutions,
    };
    const outPath = italyFlatPathFor(year);
    const json = serializeWithAttribution(outPath, {
      ...cleanFlat(fc, outPath),
      metadata,
    });
    await Deno.writeTextFile(outPath, json);
    console.log(
      `${outPath}: ${json.length} bytes, features=${fc.features.length}, 解消=${resolutions.length} 件`,
    );
    logResolutions(resolutions);
  }
}

/**
 * 中世 HRE 領邦の flat 化（TASK-86 / TASK-96）。仏諸侯領・伊諸侯領より後に
 * 実行する: 同時表示年では、実際に描かれる france_fiefs_flat_<year> /
 * italy_fiefs_flat_<year> を差し引き元として使うため。
 *
 * 帝国側から差し引くのは、レイヤーをまたぐ重なりが常に「広域な帝国の公領 ⊃
 * 局所的な諸侯領」の入れ子だから（1100 年 Duchy of Upper Lotharingia ×
 * County of Bar、1400 年 Duchy of Milan × March of Montferrat）。
 */
async function buildHreFiefFlat(): Promise<void> {
  for (const year of HRE_FIEF_FLAT_YEARS) {
    const raw = await readCollection(hreRawPathFor(year));
    const resolved = resolveOverlaps(raw, console.warn, "keep-smaller");
    const externalPaths = [
      ...(FIEF_FLAT_YEARS.includes(year) ? [flatPathFor(year)] : []),
      ...(ITALY_FIEF_FLAT_YEARS.includes(year) ? [italyFlatPathFor(year)] : []),
    ];
    const externals = await Promise.all(externalPaths.map(readCollection));
    const subtracted = externals.length === 0
      ? { fc: resolved.fc, removals: [] as ExternalRemoval[] }
      : subtractOverlay(
        resolved.fc,
        externals.flatMap((c) => c.features),
      );
    const metadata: FiefFlatMetadata = {
      generatedBy: "scripts/build-fief-flat.ts",
      input: hreRawPathFor(year),
      year,
      cutPolicy: "keep-smaller",
      containmentCoverageThreshold: CONTAINMENT_COVERAGE_THRESHOLD,
      minOverlapAreaM2: MIN_OVERLAP_AREA_M2,
      sliverAreaLimitM2: SLIVER_AREA_LIMIT_M2,
      resolutions: resolved.resolutions,
      ...(externalPaths.length === 0 ? {} : {
        externalInputs: externalPaths,
        externalRemovals: subtracted.removals,
      }),
    };
    const outPath = hreFlatPathFor(year);
    const json = serializeWithAttribution(outPath, {
      ...cleanFlat(subtracted.fc, outPath),
      metadata,
    });
    await Deno.writeTextFile(outPath, json);
    console.log(
      `${outPath}: ${json.length} bytes, features=${subtracted.fc.features.length}, 解消=${resolved.resolutions.length} 件, 他レイヤー差引=${subtracted.removals.length} 件`,
    );
    logResolutions(resolved.resolutions);
    for (const r of subtracted.removals) {
      console.log(
        `  他オーバーレイ  ${r.cutName} -= ${r.externalName} (${r.overlapKm2} km²)`,
      );
    }
  }
}

/** 借用 flat（#215）に埋め込むメタデータ */
export interface BorrowedFlatMetadata {
  generatedBy: string;
  /** 入力（借用元ファイル。座標無改変の生成物）のパス */
  input: string;
  year: number;
  minOverlapAreaM2: number;
  /** 差し引いたホスト系統 flat のパス */
  externalInputs: string[];
  /** ホスト系統 flat と重なるため差し引いた一覧 */
  externalRemovals: ExternalRemoval[];
  /** 借用元ファイルの metadata.borrowedFrom をそのまま温存（ADR-0033 追跡可能性） */
  borrowedFrom?: unknown;
}

/**
 * 借用面の flat 化（#215）。ホスト系統（hre は buildHreFiefFlat、italy は
 * buildItalyFiefFlat）の **直後** に実行する: その年に実際に描かれる
 * hre_fiefs_flat_<year> / italy_fiefs_flat_<year> を差し引き元として使うため。
 *
 * 借用面（#202 / #209 / ADR-0033）は隣接年の面を座標無改変で複製したもので、
 * これまで差引パイプラインを一切通らず、借用面が覆った既存領邦（1492 年の
 * County of Schaunberg は 99.7% 被覆でピック不能）や、1715 年のザクセン ×
 * ブランデンブルクの二重塗り（941 km²）が残っていた。ここで借用面**から**
 * ホスト系統 flat の全 feature を差し引く: 既存領邦は 1 頂点も変えず形・色・
 * ラベル・picking を保ち、広域な借用面側に穴を空ける（"keep-smaller" と同じ
 * 「より個別性の高い情報を残す」原則）。借用元ファイル
 * （borrowed_<lineage>_<year>.geojson）は座標無改変のまま残る（ADR-0033 条件 2
 * が禁じるのは借用元の頂点の改変で、派生 flat の生成は既存 7 系統と同じ扱い）。
 *
 * 他系統の flat は差し引かない（実測 2026-08、1 km² 未満は不問）:
 * - hre flat × 借用ミラノ公国・italy flat × 借用オーストリア大公領・
 *   france flat × 借用面は交差 0.01 km² 未満。
 * - cliopatria flat 1492 × 借用オーストリア大公領は Duchy of Bavaria 279 km² /
 *   Kingdom of Bohemia 422 km² が残る。Cliopatria は 2014 年の手描き地図画像
 *   由来で Roller 由来の借用面より 4〜7 倍粗く、粗い側を上に載せる削りは
 *   情報を減らすため、ここでは削らず known-limitations
 *   （borrowed-geometry-1492）で定量開示する。
 * - sovereign flat との重なり（1492 年の Savoy 等）は buildSovereignFiefFlat が
 *   本系統側から差し引く（借用 flat を externalPaths に取る）。
 */
async function buildBorrowedFlat(lineage: BorrowedLineage): Promise<void> {
  const hostFlatPathFor = lineage === "hre" ? hreFlatPathFor : italyFlatPathFor;
  for (const year of borrowedFlatYearsFor(lineage)) {
    const rawPath = borrowedPathFor(lineage, year);
    const raw = await readCollection(rawPath);
    const hostPath = hostFlatPathFor(year);
    const host = await readCollection(hostPath);
    const subtracted = subtractOverlay(raw, host.features);
    const metadata: BorrowedFlatMetadata = {
      generatedBy: "scripts/build-fief-flat.ts",
      input: rawPath,
      year,
      minOverlapAreaM2: MIN_OVERLAP_AREA_M2,
      externalInputs: [hostPath],
      externalRemovals: subtracted.removals,
      // 借用元の記録（どの年のどの面を借りたか）は flat 側でも読めるように
      // 温存する。ランタイム（powers.ts mergeBorrowedFeatures）はこの metadata
      // を feature の ATTRIBUTION へ写す。
      ...((raw as { metadata?: { borrowedFrom?: unknown } }).metadata
          ?.borrowedFrom === undefined
        ? {}
        : {
          borrowedFrom: (raw as { metadata?: { borrowedFrom?: unknown } })
            .metadata
            ?.borrowedFrom,
        }),
    };
    const outPath = borrowedFlatPathFor(lineage, year);
    const json = serializeWithAttribution(outPath, {
      ...cleanFlat(unpinch(subtracted.fc), outPath),
      metadata,
    });
    await Deno.writeTextFile(outPath, json);
    console.log(
      `${outPath}: ${json.length} bytes, features=${subtracted.fc.features.length}, 他レイヤー差引=${subtracted.removals.length} 件`,
    );
    for (const r of subtracted.removals) {
      console.log(
        `  他オーバーレイ  ${r.cutName} -= ${r.externalName} (${r.overlapKm2} km²)`,
      );
    }
  }
}

/**
 * Cliopatria 由来の諸侯領・領邦の flat 化（TASK-110 / decision-26）。
 * 仏・伊・帝国の 3 系統より **後** に実行する。
 *
 * 削り方針は "keep-smaller"（帝国・伊と同じ）。Cliopatria の許可リストには
 * 王領（1200 年で 37,024 km²）とその内側に入りうる伯領が同居するため、
 * 「小さい側 = より個別性の高い情報」を丸ごと残す方が地図の読み取りに合う。
 *
 * レイヤーをまたぐ重なりは **常に Cliopatria 側から差し引く**（他の 3 系統は
 * 差し引かない）。理由は 2 つ:
 * - Cliopatria の境界は 2014 年の手描き地図画像を自動抽出し 0.07 度で平滑化した
 *   もので、OHM の個別リレーション（存続期間付きで作図された復元）より 4〜7 倍
 *   粗い。同じ土地に両方の主張があるときは細かい側の形を残す方が情報が多い。
 * - Cliopatria は「OHM の欠落を埋める補完」として採っている（decision-26）ので、
 *   OHM がある場所では下がるのが役割そのもの。
 * 同じ重なりを両側から削ると土地が誰にも塗られない隙間になるため、削る側は
 * 必ず一方だけにする（buildHreFiefFlat と同じ原則）。
 */
/**
 * base 置換専用の複合体の親（ADR-0040 / #352）を落とす（純粋関数）。
 * 判定は properties の刻印（CLIOPATRIA_COMPOSITE = "parent"）だけに依存する。
 */
export function dropCompositeParents(
  fc: FeatureCollection,
): FeatureCollection {
  return {
    ...fc,
    features: fc.features.filter((f) =>
      f.properties?.CLIOPATRIA_COMPOSITE !== "parent"
    ),
  };
}

async function buildCliopatriaFiefFlat(): Promise<void> {
  for (const year of CLIOPATRIA_FIEF_FLAT_YEARS) {
    const raw = await readCollection(cliopatriaRawPathFor(year));
    const rawBorrowedFrom = (raw as { metadata?: { borrowedFrom?: unknown } })
      .metadata?.borrowedFrom;
    // ADR-0040 / #352: 括弧付き複合体の親は **base 主権の外周置換専用**で、
    // オーバーレイには出さない。理由は 2 つ:
    // - resolveOverlaps("keep-smaller") は子区画で親を削るため、親（= 子の
    //   union）は面が残らず必ず消える。入力に入れておく意味が無い。
    // - 親を配信すると ADR-0026 が禁じた「複合体を 1 色 1 ラベルで描く」ことに
    //   なる。ADR-0040 が緩めたのは base の外周だけで、この禁止は据え置く。
    const displayed = dropCompositeParents(raw);
    const resolved = resolveOverlaps(displayed, console.warn, "keep-smaller");
    const externalPaths = [
      ...(FIEF_FLAT_YEARS.includes(year) ? [flatPathFor(year)] : []),
      ...(ITALY_FIEF_FLAT_YEARS.includes(year) ? [italyFlatPathFor(year)] : []),
      ...(HRE_FIEF_FLAT_YEARS.includes(year) ? [hreFlatPathFor(year)] : []),
    ];
    const externals = await Promise.all(externalPaths.map(readCollection));
    const subtracted = externals.length === 0
      ? { fc: resolved.fc, removals: [] as ExternalRemoval[] }
      : subtractOverlay(
        resolved.fc,
        externals.flatMap((c) => c.features),
      );
    const unpinched = unpinch(subtracted.fc);
    const metadata: FiefFlatMetadata = {
      generatedBy: "scripts/build-fief-flat.ts",
      input: cliopatriaRawPathFor(year),
      year,
      cutPolicy: "keep-smaller",
      containmentCoverageThreshold: CONTAINMENT_COVERAGE_THRESHOLD,
      minOverlapAreaM2: MIN_OVERLAP_AREA_M2,
      sliverAreaLimitM2: SLIVER_AREA_LIMIT_M2,
      resolutions: resolved.resolutions,
      ...(externalPaths.length === 0 ? {} : {
        externalInputs: externalPaths,
        externalRemovals: subtracted.removals,
      }),
      // 年借用（ADR-0039）の記録は配信される flat 側でも読めるように温存する。
      // 借用が無い年は キー自体を持たない（既存年の生成物を変えない）。
      ...(rawBorrowedFrom === undefined ? {} : {
        borrowedFrom: rawBorrowedFrom,
      }),
    };
    const outPath = cliopatriaFlatPathFor(year);
    const json = serializeWithAttribution(outPath, {
      ...cleanFlat(unpinched, outPath),
      metadata,
    });
    await Deno.writeTextFile(outPath, json);
    console.log(
      `${outPath}: ${json.length} bytes, features=${unpinched.features.length}, 解消=${resolved.resolutions.length} 件, 他レイヤー差引=${subtracted.removals.length} 件`,
    );
    logResolutions(resolved.resolutions);
    for (const r of subtracted.removals) {
      console.log(
        `  他オーバーレイ  ${r.cutName} -= ${r.externalName} (${r.overlapKm2} km²)`,
      );
    }
  }
}

/**
 * ブリテン諸島の政体の flat 化（TASK-151）。
 *
 * 削り方針は "keep-smaller"（帝国・伊・Cliopatria と同じ）。実データの重なりは
 * 「Kingdom of Dublin ⊂ Kingdom of Leinster」のような広域王国と局所政体の
 * 入れ子で、小さい側（＝より個別性の高い情報）の形・色・ラベル・picking を
 * 丸ごと残す方が地図の読み取りに合う。
 *
 * 別レイヤーの差し引き（subtractOverlay）は行わない: 仏・伊・帝国・Cliopatria の
 * 各オーバーレイはいずれも大陸側で、ブリテン諸島とは地理的に交わらない
 * （FRANCE_BBOX の北西端はウェールズに掛かるが、仏許可リストの諸侯領は全て
 * 大陸側にある）。base の England / Scotland との重なりは、表示時に
 * build-fief-dedupe が担う構造（後続 TASK-153 で登録）で、flat 化の責務ではない。
 */
async function buildBritainFiefFlat(): Promise<void> {
  for (const year of BRITAIN_FIEF_FLAT_YEARS) {
    const raw = await readCollection(britainRawPathFor(year));
    const { fc, resolutions } = resolveOverlaps(
      raw,
      console.warn,
      "keep-smaller",
    );
    const metadata: FiefFlatMetadata = {
      generatedBy: "scripts/build-fief-flat.ts",
      input: britainRawPathFor(year),
      year,
      cutPolicy: "keep-smaller",
      containmentCoverageThreshold: CONTAINMENT_COVERAGE_THRESHOLD,
      minOverlapAreaM2: MIN_OVERLAP_AREA_M2,
      sliverAreaLimitM2: SLIVER_AREA_LIMIT_M2,
      resolutions,
    };
    const outPath = britainFlatPathFor(year);
    const json = serializeWithAttribution(outPath, {
      ...cleanFlat(unpinch(fc), outPath),
      metadata,
    });
    await Deno.writeTextFile(outPath, json);
    console.log(
      `${outPath}: ${json.length} bytes, features=${fc.features.length}, 解消=${resolutions.length} 件`,
    );
    logResolutions(resolutions);
  }
}

/**
 * 主権政体オーバーレイの flat 化（#189）。全系統の **最後** に実行する。
 *
 * 削り方針は "keep-smaller"（帝国・伊・Cliopatria・ブリテンと同じ）。実データの
 * 重なりは 1715 年の「トランシルヴァニア ⊂ 名目上の隣接領」のような広域と
 * 局所の入れ子になりうるため、小さい側（＝より個別性の高い情報）の形・色・
 * ラベル・picking を丸ごと残す。
 *
 * レイヤーをまたぐ重なりは **常に主権政体側から差し引く**。同時表示になる
 * 既存 5 系統（仏・伊・帝国・Cliopatria・ブリテン）は西欧〜中欧に集中し、
 * 中東欧・バルカン・東欧の主権政体とは実測で交わらない（1715〜1800 年の
 * hre_fiefs のザルツブルク大司教領等ともハンガリー西縁で接するだけ）が、
 * 境界の解像度差による微小な重なりが将来の再生成で入り込んでも、後から
 * 追加した本系統が下がる構造にしておく（buildCliopatriaFiefFlat と同じ原則。
 * 同じ重なりを両側から削ると土地が誰にも塗られない隙間になる）。
 */
async function buildSovereignFiefFlat(): Promise<void> {
  for (const year of SOVEREIGN_FIEF_FLAT_YEARS) {
    const raw = await readCollection(sovereignRawPathFor(year));
    const resolved = resolveOverlaps(raw, console.warn, "keep-smaller");
    const externalPaths = [
      ...(FIEF_FLAT_YEARS.includes(year) ? [flatPathFor(year)] : []),
      ...(ITALY_FIEF_FLAT_YEARS.includes(year) ? [italyFlatPathFor(year)] : []),
      ...(HRE_FIEF_FLAT_YEARS.includes(year) ? [hreFlatPathFor(year)] : []),
      ...(CLIOPATRIA_FIEF_FLAT_YEARS.includes(year)
        ? [cliopatriaFlatPathFor(year)]
        : []),
      ...(BRITAIN_FIEF_FLAT_YEARS.includes(year)
        ? [britainFlatPathFor(year)]
        : []),
      // #215: 隣接年から流用した面の flat（buildBorrowedFlat）。1492 年の
      // Savoy / March of Montferrat / Republic of Genoa が借用ミラノ公国域を
      // 保持したまま最上段に描かれる二重塗り・誤ピックを、本系統側から
      // 差し引いて解消する（重なりが無い年でも構造として登録し、将来の
      // 再生成で入り込む重なりに備える。既存 5 系統と同じ原則）。
      ...(BORROWED_HRE_FLAT_YEARS.includes(year)
        ? [borrowedFlatPathFor("hre", year)]
        : []),
      ...(BORROWED_ITALY_FLAT_YEARS.includes(year)
        ? [borrowedFlatPathFor("italy", year)]
        : []),
    ];
    const externals = await Promise.all(externalPaths.map(readCollection));
    const subtracted = externals.length === 0
      ? { fc: resolved.fc, removals: [] as ExternalRemoval[] }
      : subtractOverlay(
        resolved.fc,
        externals.flatMap((c) => c.features),
      );
    const unpinched = unpinch(subtracted.fc);
    const metadata: FiefFlatMetadata = {
      generatedBy: "scripts/build-fief-flat.ts",
      input: sovereignRawPathFor(year),
      year,
      cutPolicy: "keep-smaller",
      containmentCoverageThreshold: CONTAINMENT_COVERAGE_THRESHOLD,
      minOverlapAreaM2: MIN_OVERLAP_AREA_M2,
      sliverAreaLimitM2: SLIVER_AREA_LIMIT_M2,
      resolutions: resolved.resolutions,
      ...(externalPaths.length === 0 ? {} : {
        externalInputs: externalPaths,
        externalRemovals: subtracted.removals,
      }),
    };
    const outPath = sovereignFlatPathFor(year);
    const json = serializeWithAttribution(outPath, {
      ...cleanFlat(unpinched, outPath),
      metadata,
    });
    await Deno.writeTextFile(outPath, json);
    console.log(
      `${outPath}: ${json.length} bytes, features=${unpinched.features.length}, 解消=${resolved.resolutions.length} 件, 他レイヤー差引=${subtracted.removals.length} 件`,
    );
    logResolutions(resolved.resolutions);
    for (const r of subtracted.removals) {
      console.log(
        `  他オーバーレイ  ${r.cutName} -= ${r.externalName} (${r.overlapKm2} km²)`,
      );
    }
  }
}

async function main(): Promise<void> {
  await buildFranceFiefFlat();
  await buildItalyFiefFlat();
  // #215: 借用 flat はホスト系統 flat（差し引き元）の直後に生成する。
  // borrowed italy は italy flat に、borrowed hre は hre flat に依存し、
  // 両者を sovereign（最後）が externalPaths に取る。
  await buildBorrowedFlat("italy");
  await buildHreFiefFlat();
  await buildBorrowedFlat("hre");
  await buildCliopatriaFiefFlat();
  await buildBritainFiefFlat();
  await buildSovereignFiefFlat();
}

if (import.meta.main) {
  await main();
}
