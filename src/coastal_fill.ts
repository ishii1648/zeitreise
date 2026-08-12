/**
 * 沿岸補完（coastal fill）の DOM / MapLibre / deck.gl 非依存な純粋ロジック
 * （Issue #305 → #312）。
 *
 * なぜ必要か: ベースマップ（Protomaps / OSM の現代海岸線・メートル級）と政治
 * ポリゴン（historical-basemaps 等の概略海岸線）は別々の海岸線を持つ。TASK-77
 * は塗りを海洋の水面より下へ回して「海側へのはみ出し」を隠したが、逆向きの
 * ずれ = 政治ポリゴンが現代海岸線より内側にある区間では、ベースマップの陸色
 * （earth #f0e6cd）が国土の外周に帯状に露出したまま残る（TASK-77 当時の実測で
 * 陸側の未被覆 ≈ 0.9%。英国全周・デンマーク西岸・オランダ沿岸で顕著）。
 *
 * 方針: 政治ポリゴンの「沿岸の外環セグメント」に沿って、塗りと同色の帯
 * （MapLibre fill レイヤー）をポリゴンの**外側だけ**へ敷き、ベースマップの
 * 水面に刈らせる。挿入位置は**内水面（water-inland）の直下**で、TASK-77/84 の
 * 重ね順を拡張した
 *   沿岸補完 → 内水面 → 政治ポリゴン → 概略境界 → 海洋 → 海岸線
 * が成り立つ。これにより
 * - 帯のうち現代海岸線の外（海上）は海洋 water に覆われる（AC3: 海上に浮く
 *   塗りは構造的に再発しない）
 * - 帯のうち湖・内水面へかかる部分は water-inland に覆われる（AC4: 湖・
 *   内水面は誤って塗られない。Bodensee・レマン湖のような「複数勢力に挟まれ
 *   データ側で刳り抜かれた湖」の岸も安全）
 * が同時に成り立つ。出典付きの歴史ポリゴン自体には一切手を入れず（データ改変
 * なし）、picking は deck 側の元ポリゴンのまま（この帯は MapLibre レイヤーで
 * deck の picking に関与しない = AC5）。
 *
 * ## #312: line-offset からポリゴン差分へ
 * #305 は帯を「run（LineString）＋ MapLibre line-offset = 幅の半分」で描いた。
 * この作り方には 2 つの限界があった:
 * - 幅がピクセル指定（ズーム比例）で地上 ≈ 7.6 km に固定され（MapLibre の
 *   タイルは 512px なので z4 の 1px は緯度 53° で ≈ 2.9 km。#305 のコメントの
 *   「≈ 16 km」は 256px タイル前提の誤り）、大河口・低地で実測 25 km に達する
 *   ギャップに届かない（#312）
 * - 凹部では offset した線が自己交差し、折り返した分が自色の上に重なって
 *   濃く見える（#313）。幅を広げるほど悪化するので、前者を幅の拡大で
 *   直すこともできなかった（#305 の検証で 2.6→3.6px にするとレマン湖 z7 の
 *   二重塗りが 2 倍超）
 * #312 は帯を**ジオメトリ上の面**として作り直す:
 *   帯 = （沿岸 run の外側 COASTAL_FILL_BAND_KM のバッファ）−（全政治ポリゴン）
 * 差分を polyclip（@turf/difference）で取ると、自己交差した折り返しは正規化で
 * 畳まれ、政治ポリゴンと重なる面は残らない。つまり「自色・隣接色への二重塗り」
 * は幅に関係なく構造的に起きなくなり、幅を実測ギャップまで広げられる。
 * レイヤーは line ではなく fill なので、見え方はズームに依存しない。
 *
 * ## 「沿岸」の判定（buildCoastalRuns）
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
 * ## 向きの正規化とバッファの向き
 * 外環を CCW（反時計回り = 陸が進行方向の左）へ正規化すれば、「進行方向の
 * 右」が海側になる。coastalBandPolygon はその向きにだけ run をバッファする。
 * 全周が沿岸の環（島）は 1 本の閉じた LineString にまとめ、帯は外側環＋島を
 * 穴とするドーナツになる（島の中の湖を塗り潰さない）。
 *
 * ## 色
 * 塗り（political_layers.ts buildPowerLayer）と同じ規則を feature 単位の
 * プロパティに焼き込む: 詳細表示（z5 以上）は固有色（powers.ts fillColorFor）、
 * 概観（z4）は宗主色（overviewPowerFillColor と同値の
 * overviewCoastalFillColor）。切替はズーム式（["step"]）が政治表示レベル
 * （labels.ts politicalDisplayLevel = Math.floor(zoom) 基準）と同じ境界
 * FIEF_LABEL_MIN_ZOOM で行う。ホバー/クリックの強調（ACTIVE_FILL_COLOR）は
 * feature-state "active"（キーは塗りと同じ colorKeyFor。source の promoteId で
 * 昇格）が塗りと同時に切り替える。
 *
 * 既知の割り切り（見た目のみ・データ/picking に影響なし）:
 * - 帯の色は常に base（powers）由来。諸侯領オーバーレイが海岸まで達する年代・
 *   場所では、帯（base の色）と塗り（諸侯領の色）の色相がわずかに異なる
 * - 幅の狭い海峡（エーレスンド等）では対岸の未被覆帯に帯が届き、色が混ざる
 *   ことがある（従来は陸色の帯だった場所で、混色でも領域帰属の誤読は増えない）
 */

import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  LineString,
  MultiPolygon,
  Polygon,
  Position,
} from "geojson";
import bboxClip from "@turf/bbox-clip";
import difference from "@turf/difference";
import { featureCollection } from "@turf/helpers";
import {
  COASTAL_FILL_LAYER_ID,
  WATER_INLAND_LAYER_ID,
  WATER_LAYER_ID,
} from "./basemap.ts";
import { FIEF_LABEL_MIN_ZOOM } from "./labels.ts";
import {
  colorKeyFor,
  FILL_ALPHA,
  fillColorFor,
  hexToRgb,
  type Rgba,
} from "./powers.ts";
import { ACTIVE_FILL_COLOR } from "./power_highlight.ts";
import {
  resolveSuzerainKey,
  type SuzerainOverrides,
} from "./suzerain_extent.ts";

/** GeoJSON ソースの ID（レイヤー ID は basemap.ts COASTAL_FILL_LAYER_ID） */
export const COASTAL_FILL_SOURCE_ID = "coastal-fill";

/**
 * run の properties キー。key は塗りの強調と同じ colorKeyFor（NAME /
 * "NAME|SUBJECTO"）で、source の promoteId により feature-state のキーになる。
 */
export const COASTAL_FILL_KEY_PROPERTY = "key";
export const COASTAL_FILL_DETAIL_COLOR_PROPERTY = "detailColor";
export const COASTAL_FILL_OVERVIEW_COLOR_PROPERTY = "overviewColor";

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
 * 帯の幅（地上 km）。#312 でピクセル幅（ズーム比例の line-width）から
 * ジオメトリ上の地上距離へ移した。
 *
 * 値 30 km の根拠（#312 の実測）: Natural Earth 10m `ne_10m_land` と
 * `data/europe_1900.geojson` を 0.005° でラスタ化し、「現代の陸かつ政治
 * ポリゴン外」の画素から政治ポリゴン境界までの距離を測ると、問題区間
 * （Holderness 〜 The Wash 〜 北 Norfolk）は中央値 4.8 km・p90 10.1 km・
 * p99 21.7 km・**最大 25.0 km**。同じ計測をベースマップ本体
 * （`tiles.zeitreises.com/europe.pmtiles` の earth レイヤー z8）で行っても
 * 最大 25.3 km で一致する。30 km は実測最大に約 20% の余裕を持たせた値で、
 * かつドーバー海峡（≈ 33 km）より狭く、対岸へ帯が渡って色が混ざる範囲を
 * 増やさない。
 *
 * #305 の 2.6px（地上 ≈ 7.6 km）から広げられるのは、帯が line-offset から
 * **ポリゴン差分**（外側バッファ − 全政治ポリゴン）に変わり、幅を広げると
 * 凹部で自己交差して二重塗りが増える性質（#305 AC4 に抵触した理由）が
 * 構造的に消えたため。
 */
export const COASTAL_FILL_BAND_KM = 30;

/** 緯度 1 度の距離（km）。WGS84 の平均的な子午線弧長 */
const KM_PER_DEG_LAT = 110.574;

/** 赤道での経度 1 度の距離（km） */
const KM_PER_DEG_LON = 111.320;

/**
 * 丸め継ぎ（round join）・端点キャップの円弧を刻む角度（ラジアン）。
 * 15° 刻みなら 30 km 半径の円弧の弦の誤差は 0.26 km 未満で、最小ズーム
 * （z4 の 1px ≈ 6.3 km）でも視認できない。
 */
const JOIN_ARC_STEP_RAD = Math.PI / 12;

/** feature を持たない空の FeatureCollection（同一参照で setData の差分を減らす） */
export const EMPTY_COASTAL_FILL_DATA: FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

/** Rgba（0..255）を MapLibre の CSS rgba 文字列にする（alpha は 0..1） */
export function rgbaString([r, g, b, a]: Rgba): string {
  return `rgba(${r}, ${g}, ${b}, ${Number((a / 255).toFixed(4))})`;
}

/**
 * 概観表示（z4）の帯の色（純粋関数）。political_layers.ts の
 * overviewPowerFillColor（強調なし）と同じ規則で、従属勢力を宗主の色へ
 * 寄せる。同値性はユニットテストで固定する（あちらは deck.gl を値 import
 * するモジュールにあり、初期チャンク（main.ts 経由）からは参照できない）。
 */
export function overviewCoastalFillColor(
  props: GeoJsonProperties,
  colors: Record<string, string>,
  overrides: SuzerainOverrides,
): Rgba {
  const suzerainKey = resolveSuzerainKey(props, overrides);
  const hex = suzerainKey === null ? undefined : colors[suzerainKey];
  const rgb = hex === undefined ? null : hexToRgb(hex);
  if (rgb !== null) return [rgb[0], rgb[1], rgb[2], FILL_ALPHA];
  return fillColorFor(props, colors);
}

/** 座標の量子化キー（1e-7 度 = データの丸め精度より 3 桁細かい） */
function pointKey(p: Position): string {
  return `${Math.round(p[0] * 1e7)},${Math.round(p[1] * 1e7)}`;
}

/** 無向セグメントキー（共有判定用。端点の順序に依存しない） */
function segmentKey(a: Position, b: Position): string {
  const ka = pointKey(a);
  const kb = pointKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

/** ポリゴン系ジオメトリの環（外環・穴とも）を列挙する */
function ringsOf(
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

/** ポリゴン系ジオメトリの外環だけを列挙する（穴は沿岸補完の対象外） */
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
  a: Position;
  b: Position;
  featureIndex: number;
}

/** 格子ハッシュのセル辺（度）。EPS より十分大きく、1 セルの平均密度が低い値 */
const GRID_CELL_DEG = 0.05;

/** 全 feature の全環セグメントを格子ハッシュへ引く（T 字接合の判定用） */
function buildSegmentGrid(
  base: FeatureCollection,
): Map<string, IndexedSegment[]> {
  const grid = new Map<string, IndexedSegment[]>();
  base.features.forEach((feature, featureIndex) => {
    for (const ring of ringsOf(feature.geometry)) {
      for (let i = 1; i < ring.length; i++) {
        const segment: IndexedSegment = {
          a: ring[i - 1],
          b: ring[i],
          featureIndex,
        };
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
  const cx = Math.floor(midpoint[0] / GRID_CELL_DEG);
  const cy = Math.floor(midpoint[1] / GRID_CELL_DEG);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (const segment of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
        if (segment.featureIndex === featureIndex) continue;
        if (
          distancePointToSegment(midpoint, segment.a, segment.b) <=
            NEAR_BOUNDARY_EPS_DEG
        ) {
          return true;
        }
      }
    }
  }
  return false;
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
 * vertices は閉合の重複を除いた頂点列（CCW 正規化済み）、coastal[i] は
 * セグメント (v_i, v_{i+1 mod n}) が沿岸かどうか。
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

/** 1 つの base feature から取れた沿岸 run と、その帯に焼き込む properties */
interface CoastalFeatureRuns {
  readonly properties: GeoJsonProperties;
  /** CCW（陸が進行方向の左）の頂点列。閉じた run は先頭 = 末尾 */
  readonly runs: Position[][];
}

/**
 * base 勢力ポリゴンから feature ごとの沿岸 run を取り出す（純粋関数）。
 *
 * 内陸境界（共有セグメント・T 字接合）と穴は含まれない。実行時に計算する
 * （1 年あたり 5〜7 千セグメントで数 ms。approximate_borders.ts と同じ判断で、
 * 年代ごとの派生ファイルは増やさない）。
 */
function coastalRunsByFeature(
  base: FeatureCollection,
  colors: Record<string, string>,
  overrides: SuzerainOverrides,
): CoastalFeatureRuns[] {
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
    const properties: GeoJsonProperties = {
      [COASTAL_FILL_DETAIL_COLOR_PROPERTY]: rgbaString(
        fillColorFor(feature.properties, colors),
      ),
      [COASTAL_FILL_OVERVIEW_COLOR_PROPERTY]: rgbaString(
        overviewCoastalFillColor(feature.properties, colors, overrides),
      ),
    };
    const key = colorKeyFor(feature.properties);
    if (key !== null) properties[COASTAL_FILL_KEY_PROPERTY] = key;
    const runs: Position[][] = [];
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
      runs.push(...coastalRunsOf(vertices, coastal));
    }
    return { properties, runs };
  });
}

/**
 * 沿岸 run を LineString の FeatureCollection として返す（純粋関数）。
 * 帯（buildCoastalFillData）の材料であり、沿岸判定そのものの検証にも使う。
 */
export function buildCoastalRuns(
  base: FeatureCollection,
  colors: Record<string, string>,
  overrides: SuzerainOverrides,
): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = [];
  for (
    const { properties, runs } of coastalRunsByFeature(
      base,
      colors,
      overrides,
    )
  ) {
    for (const coordinates of runs) {
      features.push({
        type: "Feature",
        properties,
        geometry: { type: "LineString", coordinates },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

/** 緯度 lat での経度スケール（等方平面へ写すときの x 係数）。極でも 0 にしない */
function lonScaleAt(lat: number): number {
  return Math.max(Math.cos((lat * Math.PI) / 180), 0.05);
}

/** 頂点 v から単位法線 normal 方向へ km だけずらした点（度） */
function offsetPoint(
  v: Position,
  normal: readonly [number, number],
  km: number,
): Position {
  return [
    v[0] + (normal[0] * km) / (KM_PER_DEG_LON * lonScaleAt(v[1])),
    v[1] + (normal[1] * km) / KM_PER_DEG_LAT,
  ];
}

/**
 * セグメント a→b の「進行方向の右」向き単位法線（等方平面での向き）。
 * run は CCW（陸が左）に正規化済みなので、右 = 海側 = 帯を出す向きになる。
 */
function rightNormal(a: Position, b: Position): [number, number] | null {
  const scale = lonScaleAt((a[1] + b[1]) / 2);
  const dx = (b[0] - a[0]) * scale;
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return null;
  return [dy / length, -dx / length];
}

/**
 * 頂点 v で法線 from → to をつなぐ offset 点列（両端を含む）。
 *
 * 外側（海側）へ開く凸の角では、2 本の offset 点の間に隙間ができるので円弧で
 * 埋める（miter の尖りを作らず、帯幅を角で超えない）。逆に湾のように内側へ
 * 閉じる凹の角では 2 本の offset 点が交差するので、円弧は要らず端点 2 つで
 * よい（交差してできる折り返しは polyclip の正規化が畳む）。凹側の円弧を
 * 省くと帯ポリゴンの頂点数が実測で 1/4 以下になり、差分の計算時間も下がる。
 */
function joinArc(
  v: Position,
  from: readonly [number, number],
  to: readonly [number, number],
  km: number,
): Position[] {
  const start = Math.atan2(from[1], from[0]);
  let delta = Math.atan2(to[1], to[0]) - start;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  // 右向き offset では、法線が時計回り（delta < 0）に回る角が凸 = 隙間側
  const steps = delta < 0
    ? Math.max(1, Math.ceil(-delta / JOIN_ARC_STEP_RAD))
    : 1;
  const points: Position[] = [];
  for (let k = 0; k <= steps; k++) {
    const angle = start + (delta * k) / steps;
    points.push(offsetPoint(v, [Math.cos(angle), Math.sin(angle)], km));
  }
  return points;
}

/**
 * 1 本の沿岸 run から「外側 km の帯」を表すポリゴンを作る（純粋関数）。
 *
 * - 開いた run: 元の頂点列と、その外側 offset 列を逆順につないだ 1 枚の環
 *   （片側バッファ）。端点は butt（run の端で切る）。
 * - 閉じた run（島など全周が沿岸）: 外側 offset 環を外環、元の環を穴とする
 *   ドーナツ。島の内部（と島の中の湖）を帯が塗り潰さない。
 *
 * 凹部では offset 列が自己交差するが、呼び出し側の polyclip 差分
 * （@turf/difference）が OGC 的に妥当な面へ正規化するため、重なった分が
 * 二重に塗られることはない（scripts/clean-polygons.ts の自己 union と同じ
 * 確立した手法）。
 */
export function coastalBandPolygon(
  run: readonly Position[],
  km: number,
): Polygon | null {
  const closed = run.length > 3 &&
    pointKey(run[0]) === pointKey(run[run.length - 1]);
  const vertices = closed ? run.slice(0, -1) : [...run];
  if (vertices.length < 2) return null;
  const count = vertices.length;
  const normals: ([number, number] | null)[] = [];
  const segments = closed ? count : count - 1;
  for (let i = 0; i < segments; i++) {
    normals.push(rightNormal(vertices[i], vertices[(i + 1) % count]));
  }
  const usable = normals.filter((n): n is [number, number] => n !== null);
  if (usable.length === 0) return null;
  /** 添字 i のセグメント法線（退化セグメントは直近の有効な法線で代用する） */
  const normalAt = (i: number): [number, number] => {
    for (let k = 0; k < segments; k++) {
      const n = normals[(((i - k) % segments) + segments) % segments];
      if (n !== null) return n;
    }
    return usable[0];
  };

  if (closed) {
    const outer: Position[] = [];
    for (let i = 0; i < count; i++) {
      outer.push(...joinArc(vertices[i], normalAt(i - 1), normalAt(i), km));
    }
    if (outer.length < 3) return null;
    outer.push(outer[0]);
    const hole = [...vertices, vertices[0]];
    return { type: "Polygon", coordinates: [outer, hole] };
  }

  const outer: Position[] = [offsetPoint(vertices[0], normalAt(0), km)];
  for (let i = 1; i < count - 1; i++) {
    outer.push(...joinArc(vertices[i], normalAt(i - 1), normalAt(i), km));
  }
  outer.push(offsetPoint(vertices[count - 1], normalAt(count - 2), km));
  const ring = [...vertices, ...outer.reverse(), vertices[0]];
  return { type: "Polygon", coordinates: [ring] };
}

/** ジオメトリの bbox（[西, 南, 東, 北]）。ポリゴン以外は null */
function bboxOf(
  geometry: Feature["geometry"] | null,
): [number, number, number, number] | null {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const ring of ringsOf(geometry)) {
    for (const [lon, lat] of ring) {
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }
  return west === Infinity ? null : [west, south, east, north];
}

function bboxOverlaps(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/**
 * 帯から陸を差し引く（polyclip の破綻に備えた退避つき）。
 *
 * polyclip-ts は自己交差の激しい入力でごく稀に "Unable to complete output
 * ring" を投げる（実測: 1650 年のバルト海 Gotland 付近）。沿岸補完は地図全体を
 * 落とす理由にならないので、その run だけ帯を諦める（#305 以前の見え方に
 * 戻るだけで、差し引き前の帯を代わりに出して二重塗りを作ることはしない）。
 */
function safeDifference(
  band: Feature<Polygon>,
  subtrahends: readonly Feature<Polygon | MultiPolygon>[],
): Polygon | MultiPolygon | null {
  try {
    const clipped = difference(featureCollection([band, ...subtrahends]));
    return clipped === null ? null : clipped.geometry;
  } catch {
    return null;
  }
}

/**
 * base 勢力ポリゴンから沿岸補完の描画データ（帯のポリゴン）を作る
 * （純粋関数。Issue #305 → #312）。
 *
 * 帯 = 「沿岸 run の外側 COASTAL_FILL_BAND_KM のバッファ」−「全政治ポリゴン」。
 * 差分を取ることで
 * - 自分の塗り・隣接勢力の塗りと重なる面が**構造的に**存在しなくなる
 *   （凹部の自己交差による二重塗り = #313 も含めて消える）
 * - それでも残るのは海と「現代の陸だが政治ポリゴン外」の帯だけになる
 * が同時に成り立つので、#305 で二重塗りを恐れて広げられなかった幅を実測
 * ギャップまで広げられる。
 *
 * 差分は **run 単位**で取り、差し引く相手はその run の帯の bbox と重なる
 * ポリゴン部（feature ではなく MultiPolygon のパート）に限る。polyclip の
 * 走査は「主題 + 全被減数」の辺の総数に効くので、feature 単位でまとめて
 * 差分すると 1 年あたり 0.8〜1.3 秒かかる（実測）。run 単位 + パート単位の
 * bbox 絞り込みで 1 桁以上速くなり、年の切り替えを妨げない。
 */
export function buildCoastalFillData(
  base: FeatureCollection,
  colors: Record<string, string>,
  overrides: SuzerainOverrides,
): FeatureCollection {
  /** 差分の相手: 政治ポリゴンを「1 パート（外環 + 穴）＋ bbox」に展開したもの */
  const landParts: {
    readonly box: [number, number, number, number];
    readonly polygon: Feature<Polygon>;
  }[] = [];
  for (const feature of base.features) {
    const geometry = feature.geometry;
    if (geometry === null) continue;
    const polygons = geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon"
      ? geometry.coordinates
      : [];
    for (const coordinates of polygons) {
      const box = bboxOf({ type: "Polygon", coordinates });
      if (box === null) continue;
      landParts.push({
        box,
        polygon: {
          type: "Feature",
          properties: {},
          geometry: { type: "Polygon", coordinates },
        },
      });
    }
  }

  const features: Feature<Polygon | MultiPolygon>[] = [];
  coastalRunsByFeature(base, colors, overrides).forEach(
    ({ properties, runs }) => {
      const parts: Position[][][] = [];
      for (const run of runs) {
        const band = coastalBandPolygon(run, COASTAL_FILL_BAND_KM);
        if (band === null) continue;
        const box = bboxOf(band);
        if (box === null) continue;
        // 被減数は帯の bbox で切っておく。polyclip の計算量は「主題 + 全被減数」
        // の辺の総数に効くので、ロシアやオスマン帝国のような巨大な環をそのまま
        // 渡すと帯本体の 5 倍以上の辺を毎回走査することになる（実測: 被減数
        // 頂点 83k → 11k、差分の所要時間はほぼ半減）。
        const subtrahends: Feature<Polygon | MultiPolygon>[] = [];
        for (const part of landParts) {
          if (!bboxOverlaps(box, part.box)) continue;
          const trimmed = bboxClip(part.polygon, box) as Feature<Polygon>;
          if (trimmed.geometry.coordinates.length === 0) continue;
          subtrahends.push(trimmed);
        }
        if (subtrahends.length === 0) {
          parts.push(band.coordinates);
          continue;
        }
        const bandFeature: Feature<Polygon> = {
          type: "Feature",
          properties: {},
          geometry: band,
        };
        const clipped = safeDifference(bandFeature, subtrahends);
        if (clipped === null) continue;
        if (clipped.type === "Polygon") {
          parts.push(clipped.coordinates);
        } else {
          parts.push(...clipped.coordinates);
        }
      }
      if (parts.length === 0) return;
      features.push({
        type: "Feature",
        properties,
        geometry: { type: "MultiPolygon", coordinates: parts },
      });
    },
  );
  return { type: "FeatureCollection", features };
}

/** MapLibre の fill レイヤー定義の最小型（FillLayerSpecification 互換） */
export interface CoastalFillLayerSpec {
  readonly id: string;
  readonly type: "fill";
  readonly source: string;
  readonly layout: Readonly<Record<string, unknown>>;
  readonly paint: Readonly<Record<string, unknown>>;
}

/** 強調 feature-state が立っていれば ACTIVE_FILL_COLOR、なければ properties の色 */
function activeOrProperty(colorProperty: string): unknown {
  return [
    "case",
    ["boolean", ["feature-state", "active"], false],
    rgbaString(ACTIVE_FILL_COLOR),
    ["get", colorProperty],
  ];
}

/**
 * 沿岸補完レイヤーの定義（Issue #305 → #312 で line から fill へ）。
 *
 * 帯はジオメトリ側で「外側バッファ − 全政治ポリゴン」として作ってあるので、
 * レイヤーは面をそのまま塗るだけでよい。幅・offset のズーム式を持たないため
 * 見え方はズームに依存せず、地上距離として常に COASTAL_FILL_BAND_KM になる
 * （#312 AC3: ズームを上げるほど残差が悪化する挙動が構造的に消える）。
 *
 * - fill-color: 強調 feature-state（塗りの ACTIVE_FILL_COLOR と同じ色・
 *   同じキー）> 概観/詳細のズーム切替（["step"] の境界は塗りの表示レベル
 *   判定 politicalDisplayLevel と同じ FIEF_LABEL_MIN_ZOOM。どちらも
 *   Math.floor(zoom) === FIEF_LABEL_MIN_ZOOM で切り替わる）。式の入れ子は
 *   ["step", ["zoom"], …] を最外にする: MapLibre は ["zoom"] をトップレベルの
 *   step / interpolate の入力にしか許さず、["case", …, ["step", ["zoom"] …]]
 *   はスタイル検証で弾かれてレイヤー追加自体が失敗する（実機で確認）。
 * - fill-antialias は false: 帯は隣接勢力の帯と辺を接して並ぶことがあり、
 *   アンチエイリアスの縁が半透明で重なると継ぎ目に濃い線が出る。
 */
export function coastalFillLayerSpec(): CoastalFillLayerSpec {
  return {
    id: COASTAL_FILL_LAYER_ID,
    type: "fill",
    source: COASTAL_FILL_SOURCE_ID,
    layout: {},
    paint: {
      "fill-color": [
        "step",
        ["zoom"],
        activeOrProperty(COASTAL_FILL_OVERVIEW_COLOR_PROPERTY),
        FIEF_LABEL_MIN_ZOOM,
        activeOrProperty(COASTAL_FILL_DETAIL_COLOR_PROPERTY),
      ],
      "fill-antialias": false,
    },
  };
}

/** GeoJSON ソース定義（promoteId で強調キーを feature-state の id へ昇格） */
export function coastalFillSourceSpec(
  data: FeatureCollection = EMPTY_COASTAL_FILL_DATA,
): {
  readonly type: "geojson";
  readonly promoteId: string;
  readonly data: FeatureCollection;
} {
  return { type: "geojson", promoteId: COASTAL_FILL_KEY_PROPERTY, data };
}

/**
 * 沿岸補完レイヤーの挿入位置（beforeId）を返す純粋関数。
 *
 * 内水面（water-inland）の直下が正位置（湖・内水面が帯を覆う = AC4）。
 * 水面分割前のスタイル（想定外の縮退）では海洋 water の直下、水面レイヤーが
 * 無いスタイル（OpenFreeMap フォールバック）では null = 追加しない
 * （マスクが無い状態で帯を足すと海上に浮くため、帯ごと出さないのが安全側）。
 */
export function coastalFillBeforeId(
  styleLayerIds: readonly string[],
): string | null {
  for (const id of [WATER_INLAND_LAYER_ID, WATER_LAYER_ID]) {
    if (styleLayerIds.includes(id)) return id;
  }
  return null;
}
