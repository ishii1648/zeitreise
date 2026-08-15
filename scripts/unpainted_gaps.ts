/**
 * 「どのレイヤーにも塗られていない面」を数え上げる検査ヘルパ（#390）。
 *
 * base 塗り（europe_flat_<year>）と領邦オーバーレイ（<region>_fiefs_flat_<year>）の
 * 間には幅 100 m 級の未塗装の筋が残る。これは特定の 1 箇所の欠陥ではないので、
 * 「ここを見る」ではなく「範囲を与えて機械的に走査する」形で検査できるように
 * しておく必要がある（#390 AC3・AC4）。
 *
 * 方式:
 *
 * - 格子点のサンプリングではなくポリゴン差分で測る。矩形から「その矩形に触れる
 *   塗り」を順に差し引き、残った連結成分ごとに面積と平均幅を返す。格子走査は
 *   幅 100 m 級の筋を取りこぼす（0.002 度格子でも 1 セル 約 150 m）。
 * - 塗りは 1 枚の FeatureCollection ではなく **複数レイヤーの合成** を受け取れる。
 *   実際の用途は base 塗り + 全オーバーレイ flat + 沿岸補完の帯である。
 * - 広すぎる矩形に備えてタイル分割走査を持つ（tileDegrees）。ただし現行データでは
 *   分割しないほうが速く、かつ正確である（DEFAULT_TILE_DEGREES のコメント参照）。
 *
 * 平均幅 = 2·面積 ÷ 周長。細長い形ならほぼ実幅にあたる。scripts/clean-polygons.ts
 * が細片判定に使っているのと同じ尺度である。
 */
import area from "@turf/area";
import difference from "@turf/difference";
import { featureCollection } from "@turf/helpers";
import union from "@turf/union";
import type {
  Feature,
  FeatureCollection,
  MultiPolygon,
  Polygon,
} from "geojson";

/** west, south, east, north */
export type Box = readonly [number, number, number, number];

/** 未塗装の連結成分 1 件 */
export interface UnpaintedGap {
  /** 成分の面積（km²） */
  areaKm2: number;
  /** 平均幅 = 2·面積 ÷ 周長（m）。細長い形ならほぼ実幅 */
  meanWidthM: number;
  /** 成分の外接矩形（west, south, east, north） */
  bbox: [number, number, number, number];
}

/**
 * 「タイル分割しない」ことを表す tileDegrees。全球より大きいので必ず 1 タイルに
 * なる。
 *
 * **分割の有無で面積はわずかに動く。現状は「分割ありのほうが正確」である。**
 * 矩形が広いほど 1 回の差分に載る頂点数が増え、共有辺の細片を取りこぼすためで、
 * タイルを細かくするほど値は収束する。実測（data/europe_1200.geojson 単体、
 * 18.3–18.7 / 49.5–49.9 の最大成分）:
 *
 * | tileDegrees | 面積 |
 * | ----------- | ---- |
 * | 分割なし    | 22.858 km² |
 * | 0.25        | 22.691 km² |
 * | 0.125       | 22.680 km² |
 * | 0.1         | 22.678 km² |
 * | 0.05        | 22.677 km² |
 *
 * それでも既定を分割なしにしているのは、この 22.858 が
 * `data/known-limitations.json` の "bohemia-hungary-east-1200" で
 * 「約22.9km²」としてユーザ向けに開示済みだからである。開示値を動かすには台帳の
 * 書き換えが要り、それは #390 の範囲外なので別 Issue に切り出してある。
 * **「分割なしが正しい」のではなく「開示値との整合のために分割なしで固定して
 * いる」** と読むこと。
 */
export const NO_TILING_DEG = 360;

/**
 * tileDegrees の既定値。現行データでは分割しないのが最善なので分割なし。
 *
 * タイル分割は「広い範囲は一度に差分を取れないだろう」という想定で入れたが、
 * 実測ではその想定が成り立たなかった。1200 年の base 塗り + 全オーバーレイ flat
 * + 沿岸補完を合成し、12–19 / 48–51.5（25.5 平方度）を走査した実測:
 *
 * | tileDegrees | タイル数 | 所要   | 未被覆合計 |
 * | ----------- | -------- | ------ | ---------- |
 * | 分割なし    | 1        | 0.10 s | 1.386 km²  |
 * | 3.5         | 6        | 0.18 s | 1.386 km²  |
 * | 1           | 28       | 0.77 s | 1.386 km²  |
 * | 0.5         | 98       | 2.35 s | 1.370 km²  |
 * | 0.25        | 392      | 8.72 s | 1.341 km²  |
 *
 * 塗りの feature 数はどの年も 100〜250 程度しかなく、1 タイルあたりの差分は
 * もともと軽い。一方「タイルに触れる feature を集め直して差分を取り直す」固定費は
 * タイル数だけ線形にかかるので、細かくするほど遅くなる。加えて細かいタイルは
 * タイル縁で細片を落とし、合計面積がじわじわ減る（0.25 度で 3% 欠ける）。
 * 全欧（-12–42 / 34–62）を分割なしで走らせても 13.9 s で完走するため、
 * 現行データの規模では分割する理由が無い。
 *
 * tileDegrees はこの前提が崩れたとき（feature 数が桁で増える等）のための逃げ道
 * として残してある。
 */
export const DEFAULT_TILE_DEGREES = NO_TILING_DEG;

/** unpaintedGapsIn のオプション */
export interface UnpaintedGapOptions {
  /** タイル 1 辺の度数（既定 DEFAULT_TILE_DEGREES = 分割なし） */
  tileDegrees?: number;
  /** この面積（km²）未満の成分は捨てる（既定 0 = 捨てない） */
  minAreaKm2?: number;
}

/** 隣接判定に使う許容誤差（度）。タイル境界で接する成分を取りこぼさないため */
const TOUCH_EPSILON_DEG = 1e-9;

type Ring = number[][];
type PolygonRings = Ring[];

/** Polygon / MultiPolygon をパート（リング配列）の列に開く */
function partsOf(geometry: Polygon | MultiPolygon): PolygonRings[] {
  return geometry.type === "Polygon"
    ? [geometry.coordinates]
    : geometry.coordinates;
}

/** リング配列から Polygon feature を作る */
function polygonOf(rings: PolygonRings): Feature<Polygon> {
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: rings },
  };
}

/** リング配列の外接矩形 */
function bboxOfRings(rings: PolygonRings): [number, number, number, number] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < west) west = x;
      if (x > east) east = x;
      if (y < south) south = y;
      if (y > north) north = y;
    }
  }
  return [west, south, east, north];
}

/** 2 つの矩形が（許容誤差込みで）重なるか */
function boxesOverlap(a: Box, b: Box, epsilon = 0): boolean {
  return a[0] - epsilon <= b[2] && a[2] + epsilon >= b[0] &&
    a[1] - epsilon <= b[3] && a[3] + epsilon >= b[1];
}

/** 矩形の Polygon feature */
function rectOf(box: Box): Feature<Polygon> {
  const [west, south, east, north] = box;
  return polygonOf([[
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ]]);
}

/** 塗りとして使える feature（Polygon / MultiPolygon）とその外接矩形 */
interface PaintedFeature {
  feature: Feature<Polygon | MultiPolygon>;
  bbox: [number, number, number, number];
}

/** レイヤー群を「面を持つ feature + 外接矩形」の配列に平坦化する */
function paintedFeaturesOf(
  layers: readonly FeatureCollection[],
): PaintedFeature[] {
  const out: PaintedFeature[] = [];
  for (const layer of layers) {
    for (const feature of layer.features) {
      const type = feature.geometry?.type;
      if (type !== "Polygon" && type !== "MultiPolygon") continue;
      const geometry = feature.geometry as Polygon | MultiPolygon;
      out.push({
        feature: feature as Feature<Polygon | MultiPolygon>,
        bbox: bboxOfRings(partsOf(geometry).flat()),
      });
    }
  }
  return out;
}

/**
 * 原点に整列したグリッドで box をタイルに切る。
 *
 * グリッドを box ではなく原点に合わせるのは、box をずらして走査し直しても同じ
 * 切り方になるようにするため。box の縁ではタイルを box で切り詰める。
 */
function tilesOf(box: Box, tileDegrees: number): Box[] {
  const [west, south, east, north] = box;
  const tiles: Box[] = [];
  const firstX = Math.floor(west / tileDegrees);
  const lastX = Math.ceil(east / tileDegrees);
  const firstY = Math.floor(south / tileDegrees);
  const lastY = Math.ceil(north / tileDegrees);
  for (let ix = firstX; ix < lastX; ix++) {
    const x0 = Math.max(west, ix * tileDegrees);
    const x1 = Math.min(east, (ix + 1) * tileDegrees);
    if (!(x1 > x0)) continue;
    for (let iy = firstY; iy < lastY; iy++) {
      const y0 = Math.max(south, iy * tileDegrees);
      const y1 = Math.min(north, (iy + 1) * tileDegrees);
      if (!(y1 > y0)) continue;
      tiles.push([x0, y0, x1, y1]);
    }
  }
  return tiles;
}

/**
 * 1 タイル分の未塗装ポリゴン（連結成分ごと）を返す。
 *
 * 塗りを union してから 1 回差し引くのではなく、矩形から候補を 1 枚ずつ差し引く。
 * 結果は同じだが（実測で #376 / #378 / 報告事例のいずれも一致）、union の失敗を
 * 黙って握り潰す経路が無くなり、残りが空になった時点で打ち切れる分だけ速い
 * （1200 年 12–19 / 48–51.5 で 0.61 s → 0.10 s）。
 */
function gapPartsInTile(
  painted: readonly PaintedFeature[],
  tile: Box,
): PolygonRings[] {
  let remaining: Feature<Polygon | MultiPolygon> | null = rectOf(tile);
  for (const { feature, bbox } of painted) {
    if (remaining === null) break;
    if (!boxesOverlap(bbox, tile)) continue;
    remaining = difference(featureCollection([remaining, feature]));
  }
  if (remaining === null) return [];
  return partsOf(remaining.geometry as Polygon | MultiPolygon);
}

/**
 * タイルごとに切り出された未塗装パートを、接しているもの同士で束ねる。
 *
 * タイル境界をまたぐ 1 本の筋は分断されて複数タイルに現れるため、そのまま数えると
 * 件数も平均幅も壊れる（分断片は短くなり、切断面が周長に加わって幅が小さく出る）。
 * 外接矩形が接するパートを union-find で同じ組にまとめ、組ごとに turf union して
 * 1 つの面へ戻す。タイル矩形は同じグリッドから作るので境界の座標は両側で完全に
 * 一致し、union は接する辺を継ぎ目なく結合する（余分な共線頂点も落ちる）。
 */
function mergeAdjacent(parts: readonly PolygonRings[]): PolygonRings[] {
  if (parts.length <= 1) return parts.slice();
  const boxes = parts.map(bboxOfRings);
  const parent = parts.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    let cur = i;
    while (parent[cur] !== cur) {
      const next = parent[cur];
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      if (!boxesOverlap(boxes[i], boxes[j], TOUCH_EPSILON_DEG)) continue;
      const a = find(i);
      const b = find(j);
      if (a !== b) parent[a] = b;
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < parts.length; i++) {
    const root = find(i);
    const group = groups.get(root);
    if (group === undefined) groups.set(root, [i]);
    else group.push(i);
  }
  const out: PolygonRings[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(parts[group[0]]);
      continue;
    }
    const merged = union(
      featureCollection(group.map((i) => polygonOf(parts[i]))),
    );
    // union が失敗したときは分断されたまま数える（黙って落とさない）
    if (merged === null) {
      for (const i of group) out.push(parts[i]);
      continue;
    }
    out.push(...partsOf(merged.geometry as Polygon | MultiPolygon));
  }
  return out;
}

/** 外周リングの周長（m）。緯度に応じて経度差を縮める簡易測地 */
function perimeterM(ring: Ring): number {
  let perimeter = 0;
  for (let i = 1; i < ring.length; i++) {
    const lat = (ring[i][1] + ring[i - 1][1]) / 2 * Math.PI / 180;
    perimeter += Math.hypot(
      (ring[i][0] - ring[i - 1][0]) * Math.cos(lat),
      ring[i][1] - ring[i - 1][1],
    ) * 111_320;
  }
  return perimeter;
}

/** パート 1 件を計測結果に変換する */
function measure(part: PolygonRings): UnpaintedGap {
  const areaM2 = area(polygonOf(part));
  const perimeter = perimeterM(part[0]);
  return {
    areaKm2: areaM2 / 1e6,
    meanWidthM: perimeter === 0 ? 0 : 2 * areaM2 / perimeter,
    bbox: bboxOfRings(part),
  };
}

/**
 * 矩形の中で「どのレイヤーにも塗られていない」連結成分を返す。
 *
 * @param layers 塗りのレイヤー。1 枚だけなら FeatureCollection をそのまま渡せる
 *   （テストローカルだった頃の呼び出しと互換）。複数枚渡すと合成して扱う
 * @param box 走査する矩形（west, south, east, north）
 * @returns 面積の降順に並べた未塗装の連結成分
 */
export function unpaintedGapsIn(
  layers: FeatureCollection | readonly FeatureCollection[],
  box: Box,
  options: UnpaintedGapOptions = {},
): UnpaintedGap[] {
  const list = Array.isArray(layers)
    ? layers as readonly FeatureCollection[]
    : [layers as FeatureCollection];
  const tileDegrees = options.tileDegrees ?? DEFAULT_TILE_DEGREES;
  const minAreaKm2 = options.minAreaKm2 ?? 0;
  const painted = paintedFeaturesOf(list);
  const parts: PolygonRings[] = [];
  for (const tile of tilesOf(box, tileDegrees)) {
    parts.push(...gapPartsInTile(painted, tile));
  }
  return mergeAdjacent(parts)
    .map(measure)
    .filter((gap) => gap.areaKm2 >= minAreaKm2)
    .sort((a, b) => b.areaKm2 - a.areaKm2 || a.bbox[0] - b.bbox[0]);
}
