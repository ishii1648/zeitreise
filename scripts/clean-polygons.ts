/**
 * 勢力ポリゴンの自己交差と微小破片をクリーンアップする純粋関数群（TASK-81）。
 *
 * 適用箇所は build-data.ts の shrinkToLimit（simplify → 座標丸め → 本モジュール）で、
 * europe_<year> / hre_<year> / france_fiefs_<year> の 3 パイプラインが共有する。
 * simplify 自体が自己交差を作る（凹んだ海岸線を粗くすると辺が交差する）ため、
 * クリーンアップは必ず simplify の後段に置く。
 *
 * ## なぜ必要か
 * 自己交差したリングは「内側」が定義できず、deck.gl の earcut 三角形分割が
 * 破綻して塗りが裏返る・抜ける。@turf/area や @turf/intersect も符号付き面積を
 * 打ち消し合うため、下流の派生データ（build-fief-flat / build-fief-dedupe）の
 * 判定が狂う。微小破片は画面上 1px 未満で意味を持たないうえ、パート数だけ増やして
 * ラベル配置（polylabel）とサイズ上限を圧迫する。
 *
 * ## 手法: polygon clipping による自己 union（buffer(0) 相当）
 * @turf/union（内部は polyclip-ts）に同一ジオメトリを 2 つ渡すと、交差点で
 * リングが分割され OGC 的に妥当な MultiPolygon に正規化される。GEOS の
 * buffer(0) と同じ確立した手法で、@turf/unkink-polygon と違って
 * 「交差で生じた重なり分を二重に数えない」（unkink は交差部を別ポリゴンとして
 * 残すため面積が増える）。実測でヨーロッパ全 20 年代の総面積変化は
 * 相対 1e-7 未満だった。
 *
 * 丸めは union の後にもう一度必要になる（交点の座標は桁が伸びる）が、丸め自体が
 * ごく稀に新しい交差を生む。そのため「union → 丸め → 再検査」を
 * MAX_NORMALIZE_ITERATIONS 回まで繰り返し、収束しない場合だけ丸めを諦めて
 * 交差の無い union 結果を採る（自己交差の解消を丸めより優先する）。
 *
 * ## 自己交差が無いジオメトリは触らない
 * union は交差が無くてもリングの開始頂点・向き・並びを組み替えるため、
 * 健全なジオメトリまで通すと生成物の差分が全ファイルに広がる。cleanGeometry は
 * 自己交差を検出したときだけ正規化する（france_fiefs_<year> は全年代で
 * 自己交差ゼロなので完全に無変更になる）。
 */

import area from "@turf/area";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { featureCollection, polygon as turfPolygon } from "@turf/helpers";
import kinks from "@turf/kinks";
import truncate from "@turf/truncate";
import union from "@turf/union";
import type {
  Feature,
  FeatureCollection,
  MultiPolygon,
  Polygon,
  Position,
} from "geojson";

/**
 * 残すパート（外環）の面積下限（m²）= 1 km²。
 *
 * 実測分布（europe 全 20 年代・hre 5 年代・france_fiefs 5 年代）の根拠:
 * - europe_<year> には面積 0（測地面積が倍精度で 0 に潰れた線状の残骸）の
 *   パートが計 111 個ある。bbox クリップが境界線上に作る 4 点の細片と、
 *   simplify が細い半島を線に潰した残骸で、いずれも領域ではない。
 * - 0 より大きく 1 km² 未満のパートは 40 個で、うち 36 個は頂点 4〜5 個の
 *   三角形・四角形。最小は Württemberg の 0.0003 km²（30cm 四方相当）。
 *   これらも simplify が細片を潰した残骸で、史料上の飛び地に対応しない。
 * - 1 km² 以上には史実の飛び地が現れる: Lombardy 1.78 km²、Milan 1.88 km²、
 *   Württemberg 1.09 km²、Swiss Confederation 6.76 km²、Cuxhaven 16.65 km²、
 *   Malta 66.4 km²。1 km² はこの帯の直下にある。
 * - County of Bar（バロワ）の飛び地は 4.14 / 4.77 / 8.78 / 14.01 / 42.06 /
 *   61.09 km² で、全て閾値の 4 倍以上。史実として錯綜した飛び地群を 1 つも
 *   削らない。目安として提示された 10 km² ではこのうち 3 つと
 *   Swiss Confederation・Württemberg の飛び地まで消えるため採らない。
 */
export const MIN_PART_AREA_M2 = 1_000_000;

/**
 * 残す穴（内環）の面積下限（m²）= 1 km²。パートと同じ理由・同じ値。
 * 実測で 1 km² 未満の穴は europe_1500 の 0 km²（潰れた内環）1 個だけで、
 * France 側の飛び地由来の穴（Burgundy 3.95 km²、County of Bar 7.06 / 40.08 km²）は
 * 全て残る。
 */
export const MIN_HOLE_AREA_M2 = 1_000_000;

/** union → 座標丸め → 再検査 の最大反復回数 */
export const MAX_NORMALIZE_ITERATIONS = 5;

/**
 * 座標を丸める既定の小数桁数（build-data.ts の COORD_PRECISION と同値。
 * 本モジュールは build-data.ts から import される側なので、循環 import を避ける
 * ため定数を複製する。一致は clean-polygons_test.ts が固定する。TASK-130）
 */
export const DEFAULT_COORD_PRECISION = 3;

/**
 * 残すパート（外環）の平均幅の下限（m）= 座標グリッド 1 目盛り
 * （緯度方向 10^-DEFAULT_COORD_PRECISION 度 ≒ 111 m。TASK-130）。
 *
 * 面積閾値だけでは「線状の残骸」と「コンパクトな史実の飛び地」を区別できない。
 * COORD_PRECISION = 3 への丸めはスライバの面積を最大で周長 × 半グリッド
 * （≒ 56 m）ぶん伸縮させるため、simplify が半島を線に潰した残骸が偶然
 * MIN_PART_AREA_M2 を超えて復活することがある（実測: europe_1500 の
 * Denmark-Norway、約 20 km × 60 m・1.27 km² の三角形。幻の勢力ラベルが
 * 地図に出る）。一方、同じ面積帯の史実の飛び地（Württemberg 1.09 km² など）は
 * コンパクトで平均幅が数百 m ある。平均幅 = 2·面積 ÷ 周長（細長い形なら
 * ほぼ実幅）がグリッド 1 目盛りに満たないパートは、丸め誤差と同じスケールの
 * 幅しか持たない = 形として信頼できない残骸なので落とす。
 */
export const MIN_PART_MEAN_WIDTH_M = 111_320 * 10 ** -DEFAULT_COORD_PRECISION;

/** ポリゴン系ジオメトリ */
export type PolygonalGeometry = Polygon | MultiPolygon;

/**
 * ジオメトリをパート（= リング配列）の配列として見る（純粋関数）。
 * Polygon は 1 パートの MultiPolygon として扱う。返り値は入力を共有する
 * （読み取り専用に使う）。
 */
export function polygonParts(geometry: PolygonalGeometry): Position[][][] {
  return geometry.type === "Polygon"
    ? [geometry.coordinates]
    : geometry.coordinates;
}

/** パート配列からジオメトリを組み立てる。1 パートなら Polygon にする（純粋関数） */
function fromParts(parts: Position[][][]): PolygonalGeometry | null {
  if (parts.length === 0) return null;
  if (parts.length === 1) return { type: "Polygon", coordinates: parts[0] };
  return { type: "MultiPolygon", coordinates: parts };
}

/**
 * ジオメトリの自己交差点を列挙する（純粋関数）。
 * パートごとに @turf/kinks を掛ける。リングが 4 点未満などで polygon として
 * 成立しないパートは交差判定の対象外（後段の微小破片除去で落ちる）。
 */
export function selfIntersectionPoints(
  geometry: PolygonalGeometry,
): Position[] {
  const points: Position[] = [];
  for (const part of polygonParts(geometry)) {
    let candidate: Feature<Polygon>;
    try {
      candidate = turfPolygon(part);
    } catch {
      continue;
    }
    for (const kink of kinks(candidate).features) {
      points.push(kink.geometry.coordinates);
    }
  }
  return points;
}

/** 自己 union（buffer(0) 相当）。面が残らなければ null */
function unionSelf(geometry: PolygonalGeometry): PolygonalGeometry | null {
  const self: Feature<PolygonalGeometry> = {
    type: "Feature",
    properties: {},
    geometry,
  };
  const merged = union(featureCollection([self, self]));
  return merged === null ? null : merged.geometry;
}

/** ジオメトリの座標を precision 桁に丸める（純粋関数） */
function roundGeometry(
  geometry: PolygonalGeometry,
  precision: number,
): PolygonalGeometry {
  const rounded = truncate(
    { type: "Feature", properties: {}, geometry } as Feature<PolygonalGeometry>,
    { precision, coordinates: 2, mutate: false },
  );
  return rounded.geometry;
}

/**
 * 自己交差を解消したジオメトリを返す（純粋関数）。
 * 面が残らない退化ジオメトリ（線・点に潰れたリングだけ）では null を返す。
 * 詳細な方針はファイル冒頭のコメントを参照。
 */
export function normalizeSelfIntersections(
  geometry: PolygonalGeometry,
  precision: number = DEFAULT_COORD_PRECISION,
  maxIterations: number = MAX_NORMALIZE_ITERATIONS,
): PolygonalGeometry | null {
  let current = geometry;
  // 座標丸め前で自己交差が無い候補（丸めが収束しない場合の退避先）
  let unrounded: PolygonalGeometry | null = null;
  for (let i = 0; i < maxIterations; i++) {
    const merged = unionSelf(current);
    if (merged === null) return null;
    if (unrounded === null && selfIntersectionPoints(merged).length === 0) {
      unrounded = merged;
    }
    const rounded = roundGeometry(merged, precision);
    if (selfIntersectionPoints(rounded).length === 0) return rounded;
    current = rounded;
  }
  return unrounded ?? current;
}

/**
 * リング同士が 1 点で接している箇所を、接触点をグリッド 1 目盛り分ずらして
 * 引き離したジオメトリを返す（純粋関数、TASK-92）。修復できなければ null。
 *
 * ## なぜ union（自己 union）では消せないのか
 * @turf/difference（polyclip-ts）で他のポリゴンを差し引くと、差し引いた面が
 * 「外環に 1 点で接する穴」や「互いに 1 点で接する 2 つの穴」として残ることが
 * ある（元データが点で接している、あるいは接する位置に頂点が来るため）。
 * これは polygon clipping の出力として正当なので unionSelf を何度掛けても
 * 同じ形が返り、normalizeSelfIntersections では解消できない。しかし
 * @turf/kinks は接触点を自己交差として報告し、実際 earcut の三角形分割でも
 * 穴の橋渡しが縮退する。ジオメトリ自体を僅かに変えるしかない。
 *
 * ## 方式
 * 接触点を含むリングのうち面積が最大のもの（＝外環や本体側）はそのままにし、
 * 残りのリングの当該頂点だけを「そのリングの内側」へ 10^-precision 単位で
 * 動かす。穴なら穴が僅かに縮む方向で、隣の環から離れる。移動量は 1〜3 目盛り
 * （COORD_PRECISION=3 なら 100〜300 m）で、座標はグリッド上に留まるため丸めの
 * 不変条件も崩れない。
 *
 * 修復後に自己交差が 1 つでも残る場合は null を返す（呼び出し側は元の
 * ジオメトリを保ち、従来どおり unresolved として報告する）。頂点でない位置での
 * 交差（simplify 由来の本物のクロス）は動かす頂点が決まらないため null になる。
 */
export function separateTouchingRings(
  geometry: PolygonalGeometry,
  precision: number = DEFAULT_COORD_PRECISION,
): PolygonalGeometry | null {
  const step = 10 ** -precision;
  const parts = polygonParts(geometry).map((part) => [...part]);
  let repaired = false;
  for (const part of parts) {
    for (const point of dedupePositions(touchPointsOf(part))) {
      const ringIndexes = ringsWithVertex(part, point);
      if (ringIndexes.length === 0) return null;
      // 接触点を頂点に持つリングが複数あるときは、面積が最大のもの
      // （外環・本体側）を動かさず他を内側へ逃がす。1 つだけのとき
      // （相手側は辺の途中で接している）はそのリングを動かす。
      const areas = ringIndexes.map((index) => ringArea(part[index]));
      const keep = ringIndexes.length === 1
        ? -1
        : ringIndexes[areas.indexOf(Math.max(...areas))];
      for (const index of ringIndexes) {
        if (index === keep) continue;
        const moved = nudgeVertexInward(part[index], point, step);
        if (moved === null) return null;
        part[index] = moved;
        repaired = true;
      }
    }
  }
  if (!repaired) return null;
  const result = fromParts(parts);
  if (result === null) return null;
  return selfIntersectionPoints(result).length === 0 ? result : null;
}

/** パート（リング配列）1 つ分の自己交差点 */
function touchPointsOf(part: Position[][]): Position[] {
  try {
    return kinks(turfPolygon(part)).features.map((f) => f.geometry.coordinates);
  } catch {
    return [];
  }
}

/** 同一座標を 1 件に畳む（kinks は同じ接触点を複数回報告する） */
function dedupePositions(points: readonly Position[]): Position[] {
  const seen = new Set<string>();
  const unique: Position[] = [];
  for (const point of points) {
    const key = `${point[0]},${point[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(point);
  }
  return unique;
}

/** その座標を頂点として持つリングの index 一覧 */
function ringsWithVertex(
  part: readonly Position[][],
  point: Position,
): number[] {
  const indexes: number[] = [];
  for (const [index, ring] of part.entries()) {
    if (ring.some(([x, y]) => x === point[0] && y === point[1])) {
      indexes.push(index);
    }
  }
  return indexes;
}

/**
 * リング上の指定頂点を、そのリングの内側へ step の 1〜3 倍だけ動かした
 * リングを返す。動かす向きが決まらない・内側に入らない場合は null。
 * 閉じたリングの先頭頂点は末尾と同一なので両方を差し替える。
 */
function nudgeVertexInward(
  ring: readonly Position[],
  point: Position,
  step: number,
): Position[] | null {
  const index = ring.findIndex(([x, y]) => x === point[0] && y === point[1]);
  if (index < 0) return null;
  const last = ring.length - 1;
  // 閉じたリングの末尾は先頭の複製なので、隣接頂点は循環で取る
  const prev = ring[(index - 1 + last) % last];
  const next = ring[(index + 1) % last];
  const bisector = normalizedSum(
    unitVector(point, prev),
    unitVector(point, next),
  );
  if (bisector === null) return null;
  let polygon: Feature<Polygon>;
  try {
    polygon = turfPolygon([[...ring]]);
  } catch {
    return null;
  }
  // 角の二等分方向へ「グリッド k 目盛り分」進めた点をグリッドへ丸める。
  // 座標軸方向（符号だけ）で動かすと鋭角な頂点では簡単に外へ出るため、
  // 移動量ではなく向きを二等分線に合わせるのが要点。
  const scale = Math.max(Math.abs(bisector[0]), Math.abs(bisector[1]));
  for (const sign of [1, -1]) {
    for (let k = 1; k <= 3; k++) {
      const distance = sign * k * step / scale;
      const candidate: Position = [
        roundTo(point[0] + distance * bisector[0], step),
        roundTo(point[1] + distance * bisector[1], step),
      ];
      if (candidate[0] === point[0] && candidate[1] === point[1]) continue;
      if (!booleanPointInPolygon(candidate, polygon)) continue;
      const moved = [...ring];
      moved[index] = candidate;
      if (index === 0) moved[last] = candidate;
      if (index === last) moved[0] = candidate;
      return moved;
    }
  }
  return null;
}

/** 座標をグリッド（step 刻み）へ丸める。浮動小数の桁伸びを持ち込まない */
function roundTo(value: number, step: number): number {
  return Number((Math.round(value / step) * step).toFixed(12));
}

/** from → to の単位ベクトル。長さ 0 なら null */
function unitVector(from: Position, to: Position): [number, number] | null {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy);
  return length === 0 ? null : [dx / length, dy / length];
}

/** 2 つの単位ベクトルの和を正規化する（角の二等分方向）。決まらなければ null */
function normalizedSum(
  a: [number, number] | null,
  b: [number, number] | null,
): [number, number] | null {
  if (a === null || b === null) return null;
  const sum: [number, number] = [a[0] + b[0], a[1] + b[1]];
  const length = Math.hypot(sum[0], sum[1]);
  return length === 0 ? null : [sum[0] / length, sum[1] / length];
}

/** dropTinyRings の結果 */
export interface DroppedRings {
  /** 残ったジオメトリ。パートが全て閾値未満なら null */
  geometry: PolygonalGeometry | null;
  /** 落としたパート数 */
  droppedParts: number;
  /** 落とした穴の数 */
  droppedHoles: number;
}

/** リングの測地面積（m²）。polygon として成立しないリングは 0 */
function ringArea(ring: Position[]): number {
  try {
    return area(turfPolygon([ring]));
  } catch {
    return 0;
  }
}

/** 地球の平均半径（m）。周長の近似計算に使う */
const EARTH_RADIUS_M = 6_371_008.8;

/**
 * リングの周長（m）。equirectangular 近似（経度差を中点緯度の cos で縮める）。
 * MIN_PART_MEAN_WIDTH_M との比較にしか使わないため、数 % の誤差は許容できる。
 */
function ringPerimeterM(ring: Position[]): number {
  const toRad = Math.PI / 180;
  let total = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[i + 1];
    const dx = (bx - ax) * toRad * Math.cos(((ay + by) / 2) * toRad);
    const dy = (by - ay) * toRad;
    total += Math.hypot(dx, dy) * EARTH_RADIUS_M;
  }
  return total;
}

/**
 * パート（外環）が微小破片として落とされるかを判定する（純粋関数、#390）。
 * 空のパート・面積が閾値未満のパート・平均幅（2·面積 ÷ 周長）が閾値未満の
 * 線状のパートが該当する。閾値の根拠は MIN_PART_AREA_M2 /
 * MIN_PART_MEAN_WIDTH_M のコメントを参照。
 *
 * dropTinyRings の判定そのものを公開するのは、**落とす代わりに別の扱いを
 * したい呼び出し元**があるため。scripts/build-fief-dedupe.ts は base 塗りから
 * オーバーレイを差し引いた残片がこの判定に掛かるとき、捨てずに隣接勢力へ
 * 併合する（捨てると誰も塗らない未塗装の筋になる。#390 経路 b）。判定を複製
 * させると閾値が二重に育つので、述語を 1 つに保つ。
 */
export function isTinyPart(
  part: readonly Position[][],
  minPartAreaM2: number = MIN_PART_AREA_M2,
  minPartMeanWidthM: number = MIN_PART_MEAN_WIDTH_M,
): boolean {
  if (part.length === 0) return true;
  const partArea = ringArea(part[0]);
  if (partArea < minPartAreaM2) return true;
  return 2 * partArea / ringPerimeterM(part[0]) < minPartMeanWidthM;
}

/**
 * 閾値未満のパート（外環）と穴（内環）を落とす（純粋関数）。
 * 穴を落とすのはその内側を親の面で塗り潰すことに等しい。閾値は
 * MIN_PART_AREA_M2 / MIN_HOLE_AREA_M2 の根拠コメントを参照。
 * 面積が閾値以上でも、平均幅（2·面積 ÷ 周長）が minPartMeanWidthM に満たない
 * 線状のパートは落とす（座標丸めスケールの幅しか無い残骸。TASK-130。
 * 根拠は MIN_PART_MEAN_WIDTH_M のコメントを参照）。
 */
export function dropTinyRings(
  geometry: PolygonalGeometry,
  minPartAreaM2: number = MIN_PART_AREA_M2,
  minHoleAreaM2: number = MIN_HOLE_AREA_M2,
  minPartMeanWidthM: number = MIN_PART_MEAN_WIDTH_M,
): DroppedRings {
  const kept: Position[][][] = [];
  let droppedParts = 0;
  let droppedHoles = 0;
  for (const part of polygonParts(geometry)) {
    if (isTinyPart(part, minPartAreaM2, minPartMeanWidthM)) {
      droppedParts++;
      continue;
    }
    const holes = part.slice(1).filter((hole) => {
      if (ringArea(hole) >= minHoleAreaM2) return true;
      droppedHoles++;
      return false;
    });
    kept.push([part[0], ...holes]);
  }
  return { geometry: fromParts(kept), droppedParts, droppedHoles };
}

/** cleanGeometry の結果 */
export interface CleanedGeometry extends DroppedRings {
  /** 自己交差を検出して union で作り直したか */
  normalized: boolean;
  /** 反復上限まで自己交差が残ったか（要調査。生成は止めない） */
  unresolved: boolean;
}

/**
 * 1 ジオメトリをクリーンアップする（純粋関数）。
 * 自己交差があるときだけ union で作り直し、そのあと微小破片・微小な穴を落とす。
 * 自己交差が無く落とすものも無い場合は入力ジオメトリをそのまま返す
 * （同一参照。生成物に無用な差分を出さないため）。
 *
 * #390: `minPartMeanWidthM` も引数で受ける。落としたパートがそのまま未塗装の
 * 穴になる派生 base（scripts/build-fief-dedupe.ts）が、面積・平均幅の両方の
 * 閾値を下げて呼ぶため。既定は従来どおり MIN_PART_MEAN_WIDTH_M。
 */
export function cleanGeometry(
  geometry: PolygonalGeometry,
  precision: number = DEFAULT_COORD_PRECISION,
  minPartAreaM2: number = MIN_PART_AREA_M2,
  minHoleAreaM2: number = MIN_HOLE_AREA_M2,
  minPartMeanWidthM: number = MIN_PART_MEAN_WIDTH_M,
): CleanedGeometry {
  const hasKinks = selfIntersectionPoints(geometry).length > 0;
  let normalized = geometry;
  if (hasKinks) {
    const fixed = normalizeSelfIntersections(geometry, precision);
    if (fixed === null) {
      return {
        geometry: null,
        droppedParts: polygonParts(geometry).length,
        droppedHoles: 0,
        normalized: true,
        unresolved: false,
      };
    }
    normalized = fixed;
    // TASK-92: union で消えない「1 点で接するリング」だけは頂点をずらして離す。
    // 修復できなければ従来どおり交差が残ったまま進み unresolved に記録される。
    if (selfIntersectionPoints(normalized).length > 0) {
      const separated = separateTouchingRings(normalized, precision);
      if (separated !== null) normalized = separated;
    }
  }
  const dropped = dropTinyRings(
    normalized,
    minPartAreaM2,
    minHoleAreaM2,
    minPartMeanWidthM,
  );
  return {
    ...dropped,
    geometry: dropped.droppedParts === 0 && dropped.droppedHoles === 0
      ? normalized
      : dropped.geometry,
    normalized: hasKinks,
    unresolved: hasKinks && dropped.geometry !== null &&
      selfIntersectionPoints(dropped.geometry).length > 0,
  };
}

/** cleanFeatureCollection の集計 */
export interface CleanStats {
  /** 自己交差を解消した feature 数 */
  normalizedFeatures: number;
  /** 落としたパートの合計 */
  droppedParts: number;
  /** 落とした穴の合計 */
  droppedHoles: number;
  /** 面が残らず丸ごと落とした feature の NAME（入力順） */
  droppedFeatures: string[];
  /** 自己交差が残った feature の NAME（入力順。要調査） */
  unresolvedFeatures: string[];
}

/** cleanFeatureCollection の結果 */
export interface CleanedCollection {
  fc: FeatureCollection;
  stats: CleanStats;
}

/** properties.NAME を表示用文字列にする */
function nameOf(feature: Feature): string {
  const value = feature.properties?.NAME;
  return typeof value === "string" && value !== "" ? value : "(no name)";
}

/**
 * FeatureCollection 全体をクリーンアップする（純粋関数）。
 * feature の並び・properties は保つ。ポリゴン以外のジオメトリ（rivers の
 * LineString など）は同一参照でそのまま通す。面が残らなくなった feature は
 * 落とし、NAME を stats に記録する（描画されない残骸なので残す意味が無い）。
 */
export function cleanFeatureCollection(
  fc: FeatureCollection,
  precision: number = DEFAULT_COORD_PRECISION,
  minPartAreaM2: number = MIN_PART_AREA_M2,
  minHoleAreaM2: number = MIN_HOLE_AREA_M2,
  minPartMeanWidthM: number = MIN_PART_MEAN_WIDTH_M,
): CleanedCollection {
  const features: Feature[] = [];
  const stats: CleanStats = {
    normalizedFeatures: 0,
    droppedParts: 0,
    droppedHoles: 0,
    droppedFeatures: [],
    unresolvedFeatures: [],
  };
  for (const feature of fc.features) {
    const geometry = feature.geometry;
    if (
      geometry === null ||
      (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")
    ) {
      features.push(feature);
      continue;
    }
    const cleaned = cleanGeometry(
      geometry,
      precision,
      minPartAreaM2,
      minHoleAreaM2,
      minPartMeanWidthM,
    );
    if (cleaned.normalized) stats.normalizedFeatures++;
    stats.droppedParts += cleaned.droppedParts;
    stats.droppedHoles += cleaned.droppedHoles;
    if (cleaned.unresolved) stats.unresolvedFeatures.push(nameOf(feature));
    if (cleaned.geometry === null) {
      stats.droppedFeatures.push(nameOf(feature));
      continue;
    }
    features.push(
      cleaned.geometry === geometry
        ? feature
        : { ...feature, geometry: cleaned.geometry },
    );
  }
  return { fc: { type: "FeatureCollection", features }, stats };
}

/**
 * ビルドログ用に stats を 1 行にまとめる（純粋関数）。
 * 何も起きていなければ null を返す（ログを出さない）。
 */
export function formatCleanStats(stats: CleanStats): string | null {
  const parts: string[] = [];
  if (stats.normalizedFeatures > 0) {
    parts.push(`自己交差を解消: ${stats.normalizedFeatures} feature`);
  }
  if (stats.droppedParts > 0) {
    parts.push(`微小パートを除去: ${stats.droppedParts}`);
  }
  if (stats.droppedHoles > 0) {
    parts.push(`微小な穴を除去: ${stats.droppedHoles}`);
  }
  if (stats.droppedFeatures.length > 0) {
    parts.push(`面が残らず除去: ${stats.droppedFeatures.join(", ")}`);
  }
  if (stats.unresolvedFeatures.length > 0) {
    parts.push(
      `自己交差が残存（要調査）: ${stats.unresolvedFeatures.join(", ")}`,
    );
  }
  return parts.length === 0 ? null : `  ${parts.join(" / ")}`;
}
