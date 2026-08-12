/**
 * base 勢力ポリゴンの「沿岸」判定（Issue #305/#312 で coastal_fill.ts に
 * 作られたものを #357 で抽出した共有モジュール）。
 *
 * ## なぜ独立したモジュールなのか
 * 沿岸判定の利用者が 2 つになったため。
 * - 沿岸補完（coastal_fill.ts）: 沿岸 run の外側へ帯を敷き、政治塗りを
 *   現代海岸線まで届かせる（#305 → #312 → #326）。
 * - 概略境界（approximate_borders.ts）: 沿岸と判定できる外周セグメントを線の
 *   入力から**除く**（#357）。塗りが現代海岸線まで延びた後も、補完前の歴史的な
 *   外周が同色領域の内部に「国境線」として残っていたため。
 * 同じ判定を 2 か所に書くと、片方だけ閾値が動いたときに「帯は出るのに線も
 * 残る」不整合が生まれる。判定は 1 つに保ち、利用者は run（帯用）か
 * セグメント索引（線の除外用）かの取り出し方だけを選ぶ。
 *
 * このモジュールは幾何演算ライブラリ（@turf/*）に依存しない: 判定は座標の
 * 出現回数と近傍距離だけで決まり、polyclip を使うのは帯の生成
 * （coastal_fill.ts）だけだから。
 *
 * ## 「沿岸」の判定
 * historical-basemaps の base（europe_*）は陸を隙間なくタイルし、内陸境界は
 * 隣接 feature が**同一頂点列**を共有する（実測: 全年代で全共有セグメントが
 * ちょうど 2 回出現）。よって「他 feature と共有されない外環セグメント」が
 * 沿岸（+ データ bbox の切断辺 = MAP_MAX_BOUNDS の外で不可視）になる。
 * 例外は 2 つで、いずれも機械的に除外する:
 * - 頂点数が違うだけの一致境界（T 字接合）: セグメント中点が他 feature の
 *   境界から NEAR_BOUNDARY_EPS_DEG 以内なら内陸とみなす（実測: 1815 年の
 *   独中部・1200 年の西中部などで計 50〜100 セグメント）
 * - ポリゴンの穴（湖・飛び地の刳り抜き）: 外環だけを対象にする
 *
 * ## 向きの正規化
 * 外環を CCW（反時計回り = 陸が進行方向の左）へ正規化すれば、「進行方向の
 * 右」が海側になる（coastal_fill.ts の帯はその向きにだけバッファする）。
 */

import type { Feature, FeatureCollection, Position } from "geojson";

/**
 * T 字接合（頂点数だけが違う一致境界）を内陸とみなす距離（度）。
 *
 * 根拠: build-data.ts は座標を約 56 m（≈ 0.0005°）で丸めるため、一致境界の
 * 中点は他 feature の境界から高々その程度しか離れない。0.002°（緯度で
 * ≈ 220 m）はその 4 倍のマージンで、かつ実データのセグメント長（中央値
 * 10〜16 km）より 2 桁小さく、本物の沿岸セグメントを誤って落とさない
 * （落ちるのは境界接合点の極近傍にある 100 m 級の断片のみで、帯の欠けとして
 * 視認できない）。
 */
export const NEAR_BOUNDARY_EPS_DEG = 0.002;

/**
 * 「線が base の沿岸セグメント上に乗っている」と見なす距離（度。#357）。
 *
 * なぜ完全一致では足りないか: 概略境界の入力
 * （`data/base_outline_<year>.geojson`）は base の環を諸侯領 union の境界で
 * lineSplit して作られるため、切断された沿岸セグメントは「base の 1 本」が
 * 「outline の 2 本（新しい中間頂点で分かれる）」になる。頂点列の完全一致だけで
 * 照合すると、この 2 本だけが取り残されて旧海岸線の断片が残る。
 *
 * 値 0.001° の根拠:
 * - 切断点は build-data.ts と同じ COORD_PRECISION = 3 桁へ丸められるため、
 *   本来の直線から高々 √2 × 5e-4 ≈ 7.1e-4 度しか離れない。0.001° はその
 *   約 1.4 倍のマージン。
 * - 実測（全 19 年代の base_outline × europe）でも、完全一致しない
 *   セグメントの最近傍沿岸距離は 779 本が 1e-3 未満に集中し、そこから
 *   1.5e-3 未満は 3 本しかない（切断由来の断片と、たまたま海岸の近くを走る
 *   内陸境界の間に空きがある）。
 * - {@linkcode NEAR_BOUNDARY_EPS_DEG}（0.002）の半分に留めることで、T 字接合の
 *   許容と重ならない（内陸判定の側が先に効く領域まで沿岸扱いを広げない）。
 *
 * 判定は「セグメントの**両端**が同じ沿岸セグメントからこの距離以内」で行う。
 * 点と線分の距離は凸関数なので、両端が内側なら区間全体が内側に入る。
 */
export const COASTAL_MATCH_EPS_DEG = 0.001;

/** 座標の量子化キー（1e-7 度 = データの丸め精度より 3 桁細かい） */
export function pointKey(p: Position): string {
  return `${Math.round(p[0] * 1e7)},${Math.round(p[1] * 1e7)}`;
}

/** 無向セグメントキー（共有判定用。端点の順序に依存しない） */
function segmentKey(a: Position, b: Position): string {
  const ka = pointKey(a);
  const kb = pointKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

/** ポリゴン系ジオメトリの環（外環・穴とも）を列挙する */
export function ringsOf(
  geometry: Feature["geometry"] | null,
): Position[][] {
  if (geometry === null || geometry === undefined) return [];
  switch (geometry.type) {
    case "Polygon":
      return geometry.coordinates;
    case "MultiPolygon":
      return geometry.coordinates.flat();
    default:
      return [];
  }
}

/** ポリゴン系ジオメトリの外環だけを列挙する（穴は沿岸判定の対象外） */
function exteriorRingsOf(
  geometry: Feature["geometry"] | null,
): Position[][] {
  if (geometry === null || geometry === undefined) return [];
  switch (geometry.type) {
    case "Polygon":
      return geometry.coordinates.slice(0, 1);
    case "MultiPolygon":
      return geometry.coordinates.map((polygon) => polygon[0]).filter(
        (ring) => ring !== undefined,
      );
    default:
      return [];
  }
}

/** 環の署名付き面積 ×2（shoelace。正 = CCW = 陸が進行方向の左） */
function signedArea2(ring: readonly Position[]): number {
  let sum = 0;
  for (let i = 1; i < ring.length; i++) {
    sum += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
  }
  return sum;
}

/** 点とセグメントの平面距離（度）。この用途では緯度スケールの差は無視できる */
function distancePointToSegment(p: Position, a: Position, b: Position): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq),
  );
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** 近傍検索用のセグメント（どの feature 由来かを持つ） */
interface IndexedSegment {
  readonly a: Position;
  readonly b: Position;
  readonly featureIndex: number;
}

/** 格子ハッシュのセル辺（度）。EPS より十分大きく、1 セルの平均密度が低い値 */
const GRID_CELL_DEG = 0.05;

/** セグメントを、その bbox が覆う全セルへ登録する */
function insertIntoGrid(
  grid: Map<string, IndexedSegment[]>,
  segment: IndexedSegment,
): void {
  const x0 = Math.min(segment.a[0], segment.b[0]);
  const x1 = Math.max(segment.a[0], segment.b[0]);
  const y0 = Math.min(segment.a[1], segment.b[1]);
  const y1 = Math.max(segment.a[1], segment.b[1]);
  for (
    let cx = Math.floor(x0 / GRID_CELL_DEG);
    cx <= Math.floor(x1 / GRID_CELL_DEG);
    cx++
  ) {
    for (
      let cy = Math.floor(y0 / GRID_CELL_DEG);
      cy <= Math.floor(y1 / GRID_CELL_DEG);
      cy++
    ) {
      const key = `${cx},${cy}`;
      const bucket = grid.get(key);
      if (bucket === undefined) grid.set(key, [segment]);
      else bucket.push(segment);
    }
  }
}

/** 点を含むセルとその 8 近傍に登録されたセグメント（重複あり）を列挙する */
function* segmentsNear(
  grid: Map<string, IndexedSegment[]>,
  p: Position,
): Generator<IndexedSegment> {
  const cx = Math.floor(p[0] / GRID_CELL_DEG);
  const cy = Math.floor(p[1] / GRID_CELL_DEG);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (const segment of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
        yield segment;
      }
    }
  }
}

/** 全 feature の全環セグメントを格子ハッシュへ引く（T 字接合の判定用） */
function buildSegmentGrid(
  base: FeatureCollection,
): Map<string, IndexedSegment[]> {
  const grid = new Map<string, IndexedSegment[]>();
  base.features.forEach((feature, featureIndex) => {
    for (const ring of ringsOf(feature.geometry)) {
      for (let i = 1; i < ring.length; i++) {
        insertIntoGrid(grid, { a: ring[i - 1], b: ring[i], featureIndex });
      }
    }
  });
  return grid;
}

/** セグメント中点が他 feature の境界の極近傍にあるか（T 字接合 = 内陸） */
function isNearOtherBoundary(
  grid: Map<string, IndexedSegment[]>,
  midpoint: Position,
  featureIndex: number,
): boolean {
  for (const segment of segmentsNear(grid, midpoint)) {
    if (segment.featureIndex === featureIndex) continue;
    if (
      distancePointToSegment(midpoint, segment.a, segment.b) <=
        NEAR_BOUNDARY_EPS_DEG
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 外環 1 本ぶんの沿岸判定結果。vertices は閉合の重複を除いた頂点列
 * （CCW 正規化済み）、coastal[i] はセグメント (v_i, v_{i+1 mod n}) が沿岸か。
 */
interface CoastalRing {
  readonly vertices: Position[];
  readonly coastal: boolean[];
}

/**
 * base 勢力ポリゴンの外環ごとに沿岸判定を行う（全ての利用者の唯一の入口）。
 * 返り値の添字は base.features の添字に対応する。
 *
 * 1 年あたり 5〜7 千セグメントで実測 14〜56ms。
 */
function coastalRingsByFeature(base: FeatureCollection): CoastalRing[][] {
  // 1. 全環（穴を含む）でセグメントの出現回数を数える。穴も数える側に入れる
  //    のは、穴と一致する飛び地の外環（完全内包の別勢力）を沿岸と誤認しない
  //    ため。
  const counts = new Map<string, number>();
  for (const feature of base.features) {
    for (const ring of ringsOf(feature.geometry)) {
      for (let i = 1; i < ring.length; i++) {
        const key = segmentKey(ring[i - 1], ring[i]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  const grid = buildSegmentGrid(base);
  return base.features.map((feature, featureIndex) => {
    const rings: CoastalRing[] = [];
    for (const ring of exteriorRingsOf(feature.geometry)) {
      if (ring.length < 4) continue;
      // 閉合の重複頂点を除き、CCW（陸が進行方向の左）へ正規化する
      const closed = pointKey(ring[0]) === pointKey(ring[ring.length - 1]);
      const vertices = closed ? ring.slice(0, -1) : [...ring];
      if (vertices.length < 3) continue;
      if (signedArea2(ring) < 0) vertices.reverse();
      const coastal = vertices.map((vertex, i) => {
        const next = vertices[(i + 1) % vertices.length];
        if (counts.get(segmentKey(vertex, next)) !== 1) return false;
        const midpoint: Position = [
          (vertex[0] + next[0]) / 2,
          (vertex[1] + next[1]) / 2,
        ];
        return !isNearOtherBoundary(grid, midpoint, featureIndex);
      });
      rings.push({ vertices, coastal });
    }
    return rings;
  });
}

/**
 * 全周が沿岸の閉じた環（島）の切れ目に選ぶ、最も平坦な頂点の添字。
 * offset 付きの LineString は端点で継ぎ目の楔ができるため、曲がりの最も
 * 小さい頂点に置いて楔を実質ゼロにする。
 */
function flattestVertexIndex(vertices: readonly Position[]): number {
  const n = vertices.length;
  let best = 0;
  let bestDot = -Infinity;
  for (let k = 0; k < n; k++) {
    const prev = vertices[(k - 1 + n) % n];
    const curr = vertices[k];
    const next = vertices[(k + 1) % n];
    const inLen = Math.hypot(curr[0] - prev[0], curr[1] - prev[1]);
    const outLen = Math.hypot(next[0] - curr[0], next[1] - curr[1]);
    if (inLen === 0 || outLen === 0) continue;
    const dot = ((curr[0] - prev[0]) * (next[0] - curr[0]) +
      (curr[1] - prev[1]) * (next[1] - curr[1])) / (inLen * outLen);
    if (dot > bestDot) {
      bestDot = dot;
      best = k;
    }
  }
  return best;
}

/**
 * 1 つの外環から沿岸 run（連続する沿岸セグメントの列）を取り出す。
 */
function coastalRunsOf(
  vertices: readonly Position[],
  coastal: readonly boolean[],
): Position[][] {
  const n = vertices.length;
  if (coastal.every((flag) => flag)) {
    // 全周が沿岸（島）: 1 本の閉じた LineString（切れ目は最も平坦な頂点）
    const start = flattestVertexIndex(vertices);
    const coordinates: Position[] = [];
    for (let i = 0; i <= n; i++) coordinates.push(vertices[(start + i) % n]);
    return [coordinates];
  }
  // 内陸境界を含む環: 非沿岸セグメントの直後から 1 周して run を集める
  // （先頭から走査すると環の閉合をまたぐ run が 2 本に割れる）
  let anchor = coastal.findIndex((flag) => !flag);
  if (anchor < 0) anchor = 0;
  const runs: Position[][] = [];
  let current: Position[] | null = null;
  for (let step = 0; step < n; step++) {
    const i = (anchor + step) % n;
    if (!coastal[i]) {
      current = null;
      continue;
    }
    if (current === null) {
      current = [vertices[i]];
      runs.push(current);
    }
    current.push(vertices[(i + 1) % n]);
  }
  return runs;
}

/**
 * base 勢力ポリゴンから feature ごとの沿岸 run を取り出す（純粋関数）。
 * 返り値の添字は base.features の添字に対応する。
 *
 * 内陸境界（共有セグメント・T 字接合）と穴は含まれない。
 */
export function coastalRunsByFeature(
  base: FeatureCollection,
): Position[][][] {
  return coastalRingsByFeature(base).map((rings) =>
    rings.flatMap(({ vertices, coastal }) => coastalRunsOf(vertices, coastal))
  );
}

/**
 * 「与えられたセグメントが base の沿岸セグメント上に乗るか」を答える索引
 * （#357）。概略境界の入力から旧海岸外周を落とすために使う。
 */
export interface CoastalSegmentIndex {
  /** 索引が持つ沿岸セグメントの本数（0 なら判定は常に false） */
  readonly size: number;
  /**
   * セグメント (a, b) が沿岸セグメント上に乗るか。
   * 完全一致（頂点列が同一）と、途中分割された部分セグメント
   * （両端が同じ沿岸セグメントから {@linkcode COASTAL_MATCH_EPS_DEG} 以内）の
   * 両方を拾う。
   */
  includes(a: Position, b: Position): boolean;
}

/**
 * base 勢力ポリゴンから沿岸セグメントの索引を作る（純粋関数。#357）。
 *
 * 照合を「完全一致 → 近傍」の 2 段にするのは速度のため: 実データでは
 * outline セグメントの 52〜76% が完全一致で決着し（頂点が無変更で通る環）、
 * 残りだけが近傍判定に回る。近傍判定は端点 a の属するセルとその 8 近傍しか
 * 見ない（{@linkcode COASTAL_MATCH_EPS_DEG} ≪ セル辺 0.05° なので、a から
 * eps 以内にあるセグメントは必ずこの 9 セルのどれかに登録されている）ため、
 * セグメント長に依らず定数時間で終わる。
 *
 * ポリゴンを 1 つも持たない入力（LineString だけの FeatureCollection など）
 * では size が 0 になり、includes は常に false を返す = 何も除外しない。
 */
export function buildCoastalSegmentIndex(
  base: FeatureCollection,
): CoastalSegmentIndex {
  const keys = new Set<string>();
  const grid = new Map<string, IndexedSegment[]>();
  let size = 0;
  coastalRingsByFeature(base).forEach((rings, featureIndex) => {
    for (const { vertices, coastal } of rings) {
      for (let i = 0; i < vertices.length; i++) {
        if (!coastal[i]) continue;
        const a = vertices[i];
        const b = vertices[(i + 1) % vertices.length];
        keys.add(segmentKey(a, b));
        insertIntoGrid(grid, { a, b, featureIndex });
        size++;
      }
    }
  });
  return {
    size,
    includes(a: Position, b: Position): boolean {
      if (size === 0) return false;
      if (keys.has(segmentKey(a, b))) return true;
      for (const segment of segmentsNear(grid, a)) {
        if (
          distancePointToSegment(a, segment.a, segment.b) <=
            COASTAL_MATCH_EPS_DEG &&
          distancePointToSegment(b, segment.a, segment.b) <=
            COASTAL_MATCH_EPS_DEG
        ) {
          return true;
        }
      }
      return false;
    },
  };
}
