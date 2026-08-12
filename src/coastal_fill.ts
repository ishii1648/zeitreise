/**
 * 沿岸補完（coastal fill）の DOM / MapLibre / deck.gl 非依存な純粋ロジック
 * （Issue #305）。
 *
 * なぜ必要か: ベースマップ（Protomaps / OSM の現代海岸線・メートル級）と政治
 * ポリゴン（historical-basemaps 等の概略海岸線）は別々の海岸線を持つ。TASK-77
 * は塗りを海洋の水面より下へ回して「海側へのはみ出し」を隠したが、逆向きの
 * ずれ = 政治ポリゴンが現代海岸線より内側にある区間では、ベースマップの陸色
 * （earth #f0e6cd）が国土の外周に帯状に露出したまま残る（TASK-77 当時の実測で
 * 陸側の未被覆 ≈ 0.9%。英国全周・デンマーク西岸・オランダ沿岸で顕著）。
 *
 * 方針: 政治ポリゴンの「沿岸の外環セグメント」に沿って、塗りと同色の帯
 * （MapLibre line レイヤー）をポリゴンの**外側だけ**（line-offset = 幅の半分）
 * へ敷き、ベースマップの水面に刈らせる。挿入位置は**内水面（water-inland）の
 * 直下**で、TASK-77/84 の重ね順を拡張した
 *   沿岸補完 → 内水面 → 政治ポリゴン → 概略境界 → 海洋 → 海岸線
 * が成り立つ。これにより
 * - 帯のうち現代海岸線の外（海上）は海洋 water に覆われる（AC3: 海上に浮く
 *   塗りは構造的に再発しない）
 * - 帯のうち湖・内水面へかかる部分は water-inland に覆われる（AC4: 湖・
 *   内水面は誤って塗られない。Bodensee・レマン湖のような「複数勢力に挟まれ
 *   データ側で刳り抜かれた湖」の岸も安全）
 * - 帯は offset でポリゴンの外側にだけ描かれるため、自分の塗り（半透明
 *   FILL_ALPHA）と重なって濃くならない（AC4）
 * が同時に成り立つ。出典付きの歴史ポリゴン自体には一切手を入れず（データ改変
 * なし）、picking は deck 側の元ポリゴンのまま（この帯は MapLibre レイヤーで
 * deck の picking に関与しない = AC5）。
 *
 * ## 「沿岸」の判定（buildCoastalFillData）
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
 * ## 向きの正規化と offset
 * MapLibre の line-offset は「進行方向の右」へ正値でずらす。外環を CCW
 * （反時計回り = 陸が進行方向の左）へ正規化すれば、正の offset = 海側になる。
 * offset を幅の半分にすることで帯の内縁がポリゴンの縁に一致し、帯全体が
 * 外側に出る。全周が沿岸の環（島）は 1 本の閉じた LineString にまとめ、
 * 切れ目は最も平坦な頂点に置いて継ぎ目の楔を最小化する。
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
  Position,
} from "geojson";
import {
  COASTAL_FILL_LAYER_ID,
  WATER_INLAND_LAYER_ID,
  WATER_LAYER_ID,
} from "./basemap.ts";
import { MAX_ZOOM, MIN_ZOOM } from "./config.ts";
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
 * 帯の幅（MIN_ZOOM でのピクセル値）。ズームに対し 2^z 比例（MapLibre の
 * exponential 補間）で広げるため、地上距離としてはほぼ一定になる。
 *
 * 値 2.6px の根拠: z4 の 1px は緯度 50° で ≈ 6.3 km なので、帯は ≈ 16 km を
 * 覆う。TASK-84 当時の実測で陸側の未被覆幅は中央値 1〜6 km・p90 5〜11 km・
 * 最大 26 km であり、p90 を全ズームで確実に覆い、最悪値も z4〜5（AC2 の確認
 * ズーム）では 1px 未満の残差に収まる。これ以上広げると幅の狭い海峡で対岸へ
 * 届く帯が増えるため、覆いの確実さと混色リスクの折衷でこの値にする。
 */
export const COASTAL_FILL_MIN_ZOOM_WIDTH_PX = 2.6;

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

/**
 * base 勢力ポリゴンから沿岸補完の描画データを作る（純粋関数）。
 *
 * run は LineString（CCW = 陸が左）で、properties に強調キー（colorKeyFor）と
 * 詳細/概観の塗り色を持つ。内陸境界（共有セグメント・T 字接合）と穴は
 * 含まれない。実行時に計算する（1 年あたり 5〜7 千セグメントで数 ms。
 * approximate_borders.ts と同じ判断で、年代ごとの派生ファイルは増やさない）。
 */
export function buildCoastalFillData(
  base: FeatureCollection,
  colors: Record<string, string>,
  overrides: SuzerainOverrides,
): FeatureCollection {
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
  const features: Feature<LineString>[] = [];
  base.features.forEach((feature, featureIndex) => {
    const runProperties: GeoJsonProperties = {
      [COASTAL_FILL_DETAIL_COLOR_PROPERTY]: rgbaString(
        fillColorFor(feature.properties, colors),
      ),
      [COASTAL_FILL_OVERVIEW_COLOR_PROPERTY]: rgbaString(
        overviewCoastalFillColor(feature.properties, colors, overrides),
      ),
    };
    const key = colorKeyFor(feature.properties);
    if (key !== null) runProperties[COASTAL_FILL_KEY_PROPERTY] = key;
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
      for (const coordinates of coastalRunsOf(vertices, coastal)) {
        features.push({
          type: "Feature",
          properties: runProperties,
          geometry: { type: "LineString", coordinates },
        });
      }
    }
  });
  return { type: "FeatureCollection", features };
}

/** MapLibre の line レイヤー定義の最小型（LineLayerSpecification 互換） */
export interface CoastalFillLayerSpec {
  readonly id: string;
  readonly type: "line";
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

/** 幅・offset の 2^z 比例補間式（地上距離ほぼ一定） */
function zoomProportional(minZoomPx: number): unknown {
  return [
    "interpolate",
    ["exponential", 2],
    ["zoom"],
    MIN_ZOOM,
    minZoomPx,
    MAX_ZOOM,
    minZoomPx * 2 ** (MAX_ZOOM - MIN_ZOOM),
  ];
}

/**
 * 沿岸補完レイヤーの定義（Issue #305）。
 *
 * - line-offset = 幅の半分: 帯の内縁が環に一致し、帯全体がポリゴンの外側へ
 *   出る（自分の半透明塗りと重ならない = AC4）。CCW 正規化と合わせて正値 =
 *   海側。
 * - line-color: 強調 feature-state（塗りの ACTIVE_FILL_COLOR と同じ色・
 *   同じキー）> 概観/詳細のズーム切替（["step"] の境界は塗りの表示レベル
 *   判定 politicalDisplayLevel と同じ FIEF_LABEL_MIN_ZOOM。どちらも
 *   Math.floor(zoom) === FIEF_LABEL_MIN_ZOOM で切り替わる）。式の入れ子は
 *   ["step", ["zoom"], …] を最外にする: MapLibre は ["zoom"] をトップレベルの
 *   step / interpolate の入力にしか許さず、["case", …, ["step", ["zoom"] …]]
 *   はスタイル検証で弾かれてレイヤー追加自体が失敗する（実機で確認）。
 * - line-cap は既定の butt: round にすると run 端の半円がポリゴンの内側・
 *   隣接勢力側へ食み出し、AC4 の二重塗りを起こす。継ぎ目の楔は島の環では
 *   最平坦頂点への切れ目移動（buildCoastalFillData）で抑え、内陸境界との
 *   接合部は上に重なる概略境界のインク線が覆う。
 */
export function coastalFillLayerSpec(): CoastalFillLayerSpec {
  return {
    id: COASTAL_FILL_LAYER_ID,
    type: "line",
    source: COASTAL_FILL_SOURCE_ID,
    layout: { "line-join": "round" },
    paint: {
      "line-color": [
        "step",
        ["zoom"],
        activeOrProperty(COASTAL_FILL_OVERVIEW_COLOR_PROPERTY),
        FIEF_LABEL_MIN_ZOOM,
        activeOrProperty(COASTAL_FILL_DETAIL_COLOR_PROPERTY),
      ],
      "line-width": zoomProportional(COASTAL_FILL_MIN_ZOOM_WIDTH_PX),
      "line-offset": zoomProportional(COASTAL_FILL_MIN_ZOOM_WIDTH_PX / 2),
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
