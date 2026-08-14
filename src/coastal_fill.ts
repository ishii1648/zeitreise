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
 * ## #326: 帯の生成はビルド時へ
 * polyclip 差分は 1 年あたり 0.46〜0.72 秒（実測。9 割超が差分そのもの）かかり、
 * 描画後への defer（#312）で隠せるのは「年送り操作が止まらない」ことだけで、
 * 初訪問の年ごとにメインスレッドが 0.6〜0.9 秒止まる症状は残っていた
 * （本番実測 664/713/859ms）。帯は base 勢力ポリゴンだけで決まる純粋な関数の
 * 出力なので、幾何は **ビルド時**（scripts/build-coastal-fill.ts）に作って
 * 年代別に配信し（`/data/coastal_fill_<year>.geojson`）、ランタイムは
 * coastalFillDataFromBands で色を載せるだけにする（実測 1ms 未満）。
 * 色（colors.json / name-overrides.json 依存）を焼き込まないので、色定義を
 * 変えても事前生成データは作り直さなくてよい。実行時生成
 * （buildCoastalFillData）は事前生成データを取得できないときの縮退経路として
 * 残る。
 *
 * ## 「沿岸」の判定（buildCoastalRuns）
 * 判定そのものは coastal_segments.ts が持つ（#357 で抽出。概略境界
 * approximate_borders.ts が旧海岸外周を線から除くために同じ判定を使うため）。
 * 要点は「他 feature と共有されない外環セグメント」が沿岸で、T 字接合と穴を
 * 機械的に除くこと。根拠と閾値は coastal_segments.ts を参照。
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
import { coastalRunsByFeature, pointKey, ringsOf } from "./coastal_segments.ts";

/** GeoJSON ソースの ID（レイヤー ID は basemap.ts COASTAL_FILL_LAYER_ID） */
export const COASTAL_FILL_SOURCE_ID = "coastal-fill";

/**
 * 事前生成した帯の幾何（年代別）の配信 URL を返す（純粋関数。#326）。
 * 生成は `deno task build-coastal-fill`（scripts/build-coastal-fill.ts）、
 * 配信は scripts/build.ts の getDataCopyTargets（ハッシュ付き immutable）。
 */
export function coastalFillDataUrlFor(year: number): string {
  return `/data/coastal_fill_${year}.geojson`;
}

/**
 * run の properties キー。key は塗りの強調と同じ colorKeyFor（NAME /
 * "NAME|SUBJECTO"）で、source の promoteId により feature-state のキーになる。
 */
export const COASTAL_FILL_KEY_PROPERTY = "key";
export const COASTAL_FILL_DETAIL_COLOR_PROPERTY = "detailColor";
export const COASTAL_FILL_OVERVIEW_COLOR_PROPERTY = "overviewColor";

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

/**
 * 帯に焼き込む properties（色と強調キー）を base feature の properties から
 * 作る（純粋関数。#326 で run の抽出から切り離した）。
 *
 * 幾何（沿岸 run・帯ポリゴン）は colors / overrides に一切依存しないため、
 * #326 の事前生成（scripts/build-coastal-fill.ts）は幾何だけを配信し、
 * この色付けはランタイムが毎回行う。色定義（colors.json）や宗主補正
 * （name-overrides.json）を変えても事前生成データを作り直さずに済み、
 * 「配信済みの帯だけ古い色のまま」という事故が起きない。
 */
function coastalFillPropertiesFor(
  props: GeoJsonProperties,
  colors: Record<string, string>,
  overrides: SuzerainOverrides,
): GeoJsonProperties {
  const properties: GeoJsonProperties = {
    [COASTAL_FILL_DETAIL_COLOR_PROPERTY]: rgbaString(
      fillColorFor(props, colors),
    ),
    [COASTAL_FILL_OVERVIEW_COLOR_PROPERTY]: rgbaString(
      overviewCoastalFillColor(props, colors, overrides),
    ),
  };
  const key = colorKeyFor(props);
  if (key !== null) properties[COASTAL_FILL_KEY_PROPERTY] = key;
  return properties;
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
  coastalRunsByFeature(base).forEach((runs, featureIndex) => {
    const properties = coastalFillPropertiesFor(
      base.features[featureIndex].properties,
      colors,
      overrides,
    );
    for (const coordinates of runs) {
      features.push({
        type: "Feature",
        properties,
        geometry: { type: "LineString", coordinates },
      });
    }
  });
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
 *
 * **既知の残差（#358）**: 海岸線が帯幅より細かい刻みでジグザグする区間では
 * offset 列が折り返し、巻き数が打ち消し合ったポケットが**帯の穴**として残る
 * （正規化は重なりを畳むだけで、折り返しの内側を埋め直しはしない）。穴は
 * 塗りの欠けとして、また勢力圏の外枠（suzerain_extent.ts）の内環 = 臙脂線と
 * して出る。ほとんどは沖合で海洋 water に覆われるが、クロニアン砂州沖の 2 環
 * だけは 7.75 km が現代の陸に出る（19 年代中 17 年代・z7 で約 22px）。是正は
 * このオフセット構成そのものを変える話になるため #358 では対処せず記録した
 * （docs/data-inventory/README.md §3.14 /
 * docs/research/issue-358-suzerain-extent-inner-ring.md）。
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
 * 事前生成した帯（幾何のみ）の feature が base の何番目の feature 由来かを
 * 示す properties キー（#326）。
 *
 * 色（detailColor / overviewColor）と強調キー（key）は幾何と違って
 * colors.json / name-overrides.json に依存するため、事前生成データには
 * 焼き込まず、この添字から**ランタイムで**引き直す
 * （{@linkcode coastalFillDataFromBands}）。
 */
export const COASTAL_FILL_BASE_INDEX_PROPERTY = "baseIndex";

/**
 * base 勢力ポリゴンから沿岸補完の帯の**幾何だけ**を作る（純粋関数。
 * Issue #305 → #312 → #326）。
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
 * bbox 絞り込みで 1 桁以上速くなる。
 *
 * #326: それでも 1 年あたり 0.46〜0.72 秒（うち 9 割超が polyclip 差分）かかり、
 * 初訪問の年ごとにメインスレッドを止めていた。この関数は
 * **ビルド時**（scripts/build-coastal-fill.ts）に実行して結果を配信し、
 * ランタイムは {@linkcode coastalFillDataFromBands} で色を載せるだけにする。
 * ランタイムからも（事前生成データが取れないときの縮退経路として）
 * {@linkcode buildCoastalFillData} 経由で呼ばれる。
 */
export function buildCoastalFillBands(
  base: FeatureCollection,
): FeatureCollection<MultiPolygon> {
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

  const features: Feature<MultiPolygon>[] = [];
  coastalRunsByFeature(base).forEach(
    (runs, featureIndex) => {
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
        properties: { [COASTAL_FILL_BASE_INDEX_PROPERTY]: featureIndex },
        geometry: { type: "MultiPolygon", coordinates: parts },
      });
    },
  );
  return { type: "FeatureCollection", features };
}

/**
 * 帯（幾何）のうち、宗主キー `key` に属する base feature 由来のものを
 * ポリゴンとして取り出す（純粋関数。#330）。
 *
 * 勢力圏の外枠（suzerain_extent.ts buildSuzerainExtent）の union 入力になる。
 * 画面上でアクティブ（緑青）になる面は「元の政治ポリゴン + この帯」なので、
 * 外枠の入力にも帯を足さないと、歴史ポリゴンが現代海岸線より内側にある区間で
 * 臙脂線が領域の内部に取り残される（#330 の原因 2）。
 *
 * 対応づけは事前生成データと同じ base の添字
 * （{@linkcode COASTAL_FILL_BASE_INDEX_PROPERTY}）で行う。添字が範囲外・非整数の
 * 帯（配信データと年代 GeoJSON の組の食い違い）は誤った勢力の外枠を広げるより
 * 落とす方が安全なので無視する（描画側 {@linkcode coastalFillDataFromBands} が
 * null を返して実行時生成へ縮退するのと同じ判断）。
 *
 * この関数を coastal_fill.ts 側に置くのは、帯の properties の形（添字で色を
 * 引き直す #326 の契約）を知っているのがこのモジュールだからで、
 * suzerain_extent.ts へは呼び出し可能な形（SuzerainExtentBands.select）で
 * 注入される（相互 import を作らない）。
 */
export function coastalBandsForSuzerain(
  bands: FeatureCollection,
  base: FeatureCollection,
  key: string,
  overrides: SuzerainOverrides,
): Feature<Polygon | MultiPolygon>[] {
  const parts: Feature<Polygon | MultiPolygon>[] = [];
  for (const band of bands.features) {
    const index = band.properties?.[COASTAL_FILL_BASE_INDEX_PROPERTY];
    if (
      typeof index !== "number" || !Number.isInteger(index) ||
      index < 0 || index >= base.features.length
    ) continue;
    if (
      resolveSuzerainKey(base.features[index].properties, overrides) !== key
    ) continue;
    const geometry = band.geometry;
    if (
      geometry === null ||
      (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")
    ) continue;
    parts.push({ type: "Feature", properties: {}, geometry });
  }
  return parts;
}

/**
 * 帯の幾何（{@linkcode buildCoastalFillBands} または事前生成データ）に色と
 * 強調キーを載せて描画データにする（純粋関数。#326）。
 *
 * base の添字（{@linkcode COASTAL_FILL_BASE_INDEX_PROPERTY}）で色の由来を
 * 引くため、**bands が base と同じ年・同じ内容から作られている**ことが前提に
 * なる。添字が範囲外・非整数のときは対応関係が壊れている（配信データと
 * 年代 GeoJSON の組が食い違う）ので、誤った色で描くより **null を返して
 * 呼び出し側の縮退（実行時生成へフォールバック）に委ねる**。
 *
 * 実測コスト: 1 年あたり 1ms 未満（feature 数 47〜80。幾何には触れず
 * properties を作るだけ）。
 */
export function coastalFillDataFromBands(
  base: FeatureCollection,
  bands: FeatureCollection,
  colors: Record<string, string>,
  overrides: SuzerainOverrides,
): FeatureCollection | null {
  const features: Feature[] = [];
  for (const band of bands.features) {
    const index = band.properties?.[COASTAL_FILL_BASE_INDEX_PROPERTY];
    if (
      typeof index !== "number" || !Number.isInteger(index) ||
      index < 0 || index >= base.features.length
    ) {
      return null;
    }
    features.push({
      type: "Feature",
      properties: coastalFillPropertiesFor(
        base.features[index].properties,
        colors,
        overrides,
      ),
      geometry: band.geometry,
    });
  }
  return { type: "FeatureCollection", features };
}

/**
 * base 勢力ポリゴンから沿岸補完の描画データ（色付きの帯）を作る（純粋関数。
 * Issue #305 → #312 → #326）。
 *
 * #326 以降、本番のランタイムはこの経路を通らない（事前生成した幾何を
 * {@linkcode coastalFillDataFromBands} で色付けする）。事前生成データを
 * 取得できないときの縮退経路と、事前生成そのもの・回帰検査のために残す。
 * 幾何生成が自前（buildCoastalFillBands）である以上、添字の不一致は起こり
 * 得ないので null にはならない。
 */
export function buildCoastalFillData(
  base: FeatureCollection,
  colors: Record<string, string>,
  overrides: SuzerainOverrides,
): FeatureCollection {
  return coastalFillDataFromBands(
    base,
    buildCoastalFillBands(base),
    colors,
    overrides,
  ) ?? EMPTY_COASTAL_FILL_DATA;
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
