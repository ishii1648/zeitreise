/**
 * 主要河川レイヤーの DOM/deck.gl 非依存な純粋ロジック（TASK-24）。
 * - クリックによる河川選択のトグル状態遷移
 * - 選択状態に応じたライン色・線幅の決定
 * - 河川ラベルのアンカー座標（最長 LineString の中点。都市アンカー直上の
 *   場合のみライン上の代替点へ回避、TASK-136）と優先度の算出
 *
 * TASK-21 で MapLibre style（basemap.ts）の line レイヤーとして描画していた
 * Natural Earth 主要河川を、クリック/ホバー可能にするため deck.gl の
 * GeoJsonLayer（main.ts）へ移行した。RIVERS_DATA_URL はその移設に伴い
 * basemap.ts からここへ移した。
 */

import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  Position,
} from "geojson";
import type { Rgba } from "./powers.ts";
import {
  ACTIVE_RIVER_LABEL_COLOR,
  type LabelDatum,
  MAX_LABEL_PRIORITY,
  MIN_LABEL_PRIORITY,
  RIVER_LABEL_COLOR,
} from "./labels.ts";
import { PICKING_RADIUS_PX } from "./picking.ts";

/** 主要河川 GeoJSON の配信 URL（scripts/build.ts のコピー先と一致させる契約） */
export const RIVERS_DATA_URL = "/data/rivers.geojson";

/**
 * 通常時のライン色（淡青灰 #94a8b0。TASK-73 / Issue #225）。
 *
 * TASK-21〜42 では light flavor の water 色（#80deea、シアン）と同系の
 * 明るい水色だったが、羊皮紙トーンのベースマップ（basemap.ts
 * PARCHMENT_FLAVOR_OVERRIDES の低彩度な海色）の上では彩度が高すぎて浮く。
 * TASK-73 で海と同系のくすんだ青灰 #7a949e に置き換えたが、それでも羊皮紙
 * トーンの上で通常時の河川が主張しすぎたため、Issue #225 で一段淡い
 * #94a8b0 へ引き上げた。海より暗く保ち、河口付近で
 * 海面と河川が溶けないようにする点は従来どおり。
 *
 * #94a8b0 は淡さの実質的な下限である。羊皮紙下地 #f0e6cd（重み付き輝度
 * 230.3）との輝度差は 66.0 で、テストの「> 60」制約に対する余裕が
 * 27（#7a949e）→ 6 に縮んでいる。さらに淡い #a8bac0 は褐色・桃色の政治
 * ポリゴン塗りの上で追跡が怪しくなるため不採用とした。一方ホバー/選択色
 * #4a6a7a との輝度差は 42.8 → 64.0 に広がるため、3 状態識別は退行しない。
 * ベースマップ側の定数を直接参照しないのは従来どおり（basemaps への依存を
 * この定数のためだけに持ち込まない）。
 */
export const RIVER_LINE_COLOR: Rgba = [148, 168, 176, 255];

/**
 * 選択（強調）時のライン色（濃い青灰 #4a6a7a。TASK-91）。
 *
 * TASK-73 では古地図の朱に倣って選択だけ赤茶 #7a2e22（app.css の --wax）へ
 * 色相を振っていたが、ユーザー要望によりクリックによる色相変化を廃止し、
 * ホバー色（RIVER_HOVERED_LINE_COLOR）と同一値に揃える。色は「通常 / 強調」の
 * 2 値、選択とホバーの差は線幅（3.75px / 4.5px）だけが担う。
 */
export const RIVER_SELECTED_LINE_COLOR: Rgba = [74, 106, 122, 255];

/**
 * ホバー（未選択）時のライン色（濃い青灰 #4a6a7a。TASK-42 / TASK-73 / TASK-91）。
 *
 * 3 状態は「色（2 値）+ 線幅（3 段階）」で区別する:
 * - 通常 #94a8b0 / 3px: 淡い青灰
 * - ホバー #4a6a7a / 3.75px: 通常と同色相のまま明確に暗く（= マウス直下の予告）
 * - 選択 #4a6a7a / 4.5px: 色はホバーと同一、線幅だけさらに太く（TASK-91）
 */
export const RIVER_HOVERED_LINE_COLOR: Rgba = [74, 106, 122, 255];

/**
 * 通常時の線幅（px）。TASK-44 でベースマップの川ラインを除外し deck 河川が
 * 唯一の川表示になったため、視認性を確保して 2px から 3px へ引き上げた。
 * deck.gl では選択強調（太線）と層単位の lineWidthMaxPixels が両立しない
 * （clamp が強調幅も潰す）ため、固定 px 幅 + getLineWidth の per-feature
 * 切替で近似する。
 */
export const RIVER_LINE_WIDTH_PX = 3;

/** 選択（強調）時の線幅（px）。通常幅より明確に太くして全体を際立たせる */
export const RIVER_SELECTED_LINE_WIDTH_PX = 4.5;

/**
 * ホバー（未選択）時の線幅（px）（TASK-42）。通常幅（3px）と選択幅（4.5px）の
 * 中間かつやや選択寄りの 3.75px を採用する。マウス直下の反応として通常幅との
 * 差を確実に視認させつつ、クリック確定（選択）との違いも幅の変化量で残す。
 */
export const RIVER_HOVERED_LINE_WIDTH_PX = 3.75;

/**
 * 透明ヒットライン層（picking.ts RIVERS_HIT_LAYER_ID）の線幅（px）（TASK-43）。
 * rivers と同一データをこの幅・完全透明で rivers の最前面に重ね、
 * ホバー/クリックの実効判定幅（±半分 = 7px 程度）を確保する。TASK-36 の
 * pickingRadius（picking.ts PICKING_RADIUS_PX = 6px）と同程度の判定幅を
 * カーソル直下 pick だけで得られるよう、6px の余裕を見て 14px を採る。
 * この半幅（7px）と PICKING_RADIUS_PX（6px）は独立に合成され、河川クリックの
 * 実効許容範囲になる（RIVER_CLICK_TOLERANCE_PX を参照、TASK-51）。
 */
export const RIVER_HIT_LINE_WIDTH_PX = 14;

/**
 * 透明ヒットライン層の色。完全透明（alpha 0）にし、見た目上は rivers の
 * 通常表示（色・線幅の 3 状態）を一切変えない判定専用レイヤーにする。
 */
export const RIVER_HIT_LINE_COLOR: Rgba = [0, 0, 0, 0];

/**
 * 河川クリックの実効許容範囲（px）（TASK-51）。透明ヒットライン層の半幅
 * （RIVER_HIT_LINE_WIDTH_PX / 2 = 7px、上記）と、main.ts のクリック時
 * 近傍再ピック半径（picking.ts PICKING_RADIUS_PX = 6px、main.ts
 * resolveClickInfo が pickMultipleObjects の radius に使う）が合成された値。
 *
 * 背景（TASK-36 → TASK-43 → TASK-49 → TASK-51）: PICKING_RADIUS_PX は
 * 「カーソル直下に pick 対象が無い場合」の近傍探索にしか効かず、全面を覆う
 * powers ポリゴンがある本アプリでは単独では河川の実効判定幅を広げられない
 * （TASK-36）。そこで TASK-43 は rivers と同一形状・完全透明・太幅
 * （RIVER_HIT_LINE_WIDTH_PX）の判定専用層を重ね、直下 pick だけで太幅分の
 * 判定幅を得るようにした。この 2 つは独立した仕組みだが、resolveClickInfo は
 * 直下 pick が河川系（rivers/rivers-hit）でない場合にのみ PICKING_RADIUS_PX
 * 半径の再ピックへフォールバックするため、実際にユーザーが河川をクリック
 * できる範囲はヒット帯の半幅の外側にさらに PICKING_RADIUS_PX 分の余裕が乗り、
 * 結果として「半幅 + 半径」が合成された範囲になる。
 *
 * どちらか一方の定数だけを変更すると、この合成範囲は既存テストを壊さずに
 * 暗黙に変わってしまう。RIVER_CLICK_TOLERANCE_PX をテストで固定することで、
 * 変更時に必ずこの関係を意識させる。
 */
export const RIVER_CLICK_TOLERANCE_PX = RIVER_HIT_LINE_WIDTH_PX / 2 +
  PICKING_RADIUS_PX;

// 自己衝突対策の不可視背景クアッド（TASK-136 でこの層に導入した
// RIVER_LABEL_COLLISION_BACKGROUND_COLOR）は、TASK-143 で全ラベル層へ
// 一般化して labels.ts の LABEL_COLLISION_BACKGROUND_COLOR /
// labelCollisionBackgroundProps に移した。「ライン川」（偶数 4 文字で
// テキスト中央が「イ|ン」の文字間空白に落ち、自分の可視判定に常に失敗して
// 一度も描画されない）の解消経緯もそちらの doc コメントを参照。

/** properties から河川名（name）を取り出す。欠落・空文字・非文字列は null */
export function riverNameFor(props: GeoJsonProperties): string | null {
  const v = props?.name;
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * 河川クリックによる選択状態のトグル遷移（純粋関数）。
 * - 選択中の河川を再クリック（current === clickedName）→ 解除（null）
 * - 別の河川をクリック → その河川へ切替
 * - 河川以外のクリック（clickedName null）→ 解除（null）
 */
export function toggleRiverSelection(
  current: string | null,
  clickedName: string | null,
): string | null {
  if (clickedName === null) return null;
  return current === clickedName ? null : clickedName;
}

/**
 * 河川ラインの色を決める（純粋関数）。選択 / ホバー / 通常の 3 状態を持つ
 * （TASK-42）。優先順位は選択 > ホバー > 通常: 選択中の河川にホバーしても
 * 選択強調を維持し、中間強調で上書きしない（AC #3）。hovered 省略時（null）は
 * 従来どおり選択 / 通常の 2 状態のまま（後方互換）。
 */
export function riverLineColor(
  name: string | null,
  selected: string | null,
  hovered: string | null = null,
): Rgba {
  if (name !== null && name === selected) return RIVER_SELECTED_LINE_COLOR;
  if (name !== null && name === hovered) return RIVER_HOVERED_LINE_COLOR;
  return RIVER_LINE_COLOR;
}

/**
 * 河川ラインの線幅（px）を決める（純粋関数）。色と同じ優先順位（選択 >
 * ホバー > 通常）で太さを決める（TASK-42）。
 */
export function riverLineWidth(
  name: string | null,
  selected: string | null,
  hovered: string | null = null,
): number {
  if (name !== null && name === selected) return RIVER_SELECTED_LINE_WIDTH_PX;
  if (name !== null && name === hovered) return RIVER_HOVERED_LINE_WIDTH_PX;
  return RIVER_LINE_WIDTH_PX;
}

/**
 * 河川ラベルの文字色を決める（純粋関数、TASK-123）。ライン
 * （riverLineColor）と同じ「英語名での突合」「選択 > ホバー > 通常」の
 * 優先度で、常時表示ラベルは暗青灰（RIVER_LABEL_COLOR）、ホバー/選択中の
 * 河川は従来の濃い水色（ACTIVE_RIVER_LABEL_COLOR）で強調する。
 * deck.gl の accessor へモジュール定数の参照を直接渡さないため、
 * 呼び出しごとに複製して返す。
 */
export function riverLabelColor(
  name: string,
  selected: string | null,
  hovered: string | null,
): Rgba {
  if (name === selected || name === hovered) {
    return [...ACTIVE_RIVER_LABEL_COLOR];
  }
  return [...RIVER_LABEL_COLOR];
}

/** 折れ線の全長（座標系の単位 = 度の平面近似）。ラベル配置用途には十分 */
function lineLength(coords: readonly Position[]): number {
  let sum = 0;
  for (let i = 1; i < coords.length; i++) {
    sum += Math.hypot(
      coords[i][0] - coords[i - 1][0],
      coords[i][1] - coords[i - 1][1],
    );
  }
  return sum;
}

/**
 * 折れ線に沿った弧長比 fraction（0..1）の地点を返す。頂点に丸めず頂点間を
 * 線形補間するため、頂点密度の偏りに影響されずライン上の狙った位置に
 * ラベルが乗る。fraction 0.5 が従来の「中点」（TASK-136 で一般化）。
 */
function pointAlong(
  coords: readonly Position[],
  fraction: number,
): [number, number] {
  const total = lineLength(coords);
  if (total === 0) return [coords[0][0], coords[0][1]];
  let remaining = total * fraction;
  for (let i = 1; i < coords.length; i++) {
    const seg = Math.hypot(
      coords[i][0] - coords[i - 1][0],
      coords[i][1] - coords[i - 1][1],
    );
    if (seg >= remaining) {
      const t = remaining / seg;
      return [
        coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t,
        coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t,
      ];
    }
    remaining -= seg;
  }
  const last = coords[coords.length - 1];
  return [last[0], last[1]];
}

/**
 * 河川ラベルアンカーが都市アンカーから確保すべき最小距離（度、平面近似）
 * （TASK-136）。中点アンカーがこの距離未満まで都市に近い場合のみ、ライン上の
 * 代替候補点へアンカーを移す。
 *
 * 0.1° の根拠（実データ data/rivers.geojson × data/cities.json 全年代 union
 * 634 都市での実測）:
 * - ライン川の旧中点アンカー [7.093, 50.757] は Bonn まで 0.023°（ケルンまで
 *   約 0.22°）で、CollisionFilterExtension の共有衝突空間（衝突判定は
 *   COLLISION_SIZE_SCALE=2.8 倍）で都市ラベル（priority 150 以上 > 河川上限
 *   145）に常に負け、z4〜z6 で一度も描画されなかった。
 * - 一方、既に表示できている河川の中点アンカーの最小クリアランスは
 *   Lek 0.108° / Tajo 0.121° / Dnipro 0.138° / Loire 0.240°（z4 表示実績）…と
 *   続く。しきい値 0.1° はこの間に落ち、**実データで動くのはライン川だけ**に
 *   なる（rivers_test.ts の実データテストで固定）。既表示河川の位置を
 *   動かさないこと（AC #2）を最優先した最小介入の値。
 */
export const RIVER_LABEL_CITY_CLEARANCE_DEG = 0.1;

/** アンカー候補の弧長等分数（TASK-136）。候補は k/20（k=2..18）= 0.1〜0.9 */
const ANCHOR_CANDIDATE_STEPS = 20;

/** 候補の最小ステップ（= 弧長比 0.1）。両端 10% は「川の端のラベル」に見えるため除外 */
const ANCHOR_CANDIDATE_MIN_STEP = 2;

/** 候補の最大ステップ（= 弧長比 0.9） */
const ANCHOR_CANDIDATE_MAX_STEP = 18;

/** point から最寄りの回避点（都市アンカー）までの距離（度、平面近似）。空なら +Inf */
function nearestAvoidDistance(
  point: readonly [number, number],
  avoid: readonly Position[],
): number {
  let min = Number.POSITIVE_INFINITY;
  for (const p of avoid) {
    const d = Math.hypot(p[0] - point[0], p[1] - point[1]);
    if (d < min) min = d;
  }
  return min;
}

/**
 * 河川ラベルのアンカー点をライン上から選ぶ（純粋関数、TASK-136）。
 *
 * 規則（決定的。同一入力 → 同一出力）:
 * 1. 中点（弧長比 0.5）が全回避点から RIVER_LABEL_CITY_CLEARANCE_DEG 以上
 *    離れていれば中点をそのまま使う（従来挙動。既に表示できている河川の
 *    ラベル位置を一切動かさない）。
 * 2. 中点が都市直上（クリアランス未満）の場合のみ、弧長比 0.1〜0.9 を 0.05
 *    刻みで等分した候補点のうち「最寄り回避点までの距離が最大」の点を選ぶ。
 *    同率なら中点に近い側 → 弧長位置が小さい側の順で決定的にタイブレークする
 *    （比較はステップ整数 |k - 10| → k で行い、浮動小数の丸めに依存しない）。
 *
 * 「しきい値を満たす最寄り候補」ではなく最大クリアランス点を選ぶのは、
 * 発動時 = 都市密集地帯を流れる川であり、境界ぎりぎりの点では
 * COLLISION_SIZE_SCALE 倍の衝突判定に再び負ける可能性が高いため
 * （ライン川はこの規則でクレーフェルト〜アルネム間の下流域
 * [6.36, 51.77]（クリアランス 0.49°）へ移り、z4 から描画される）。
 */
export function selectRiverLabelAnchor(
  coords: readonly Position[],
  avoid: readonly Position[],
): [number, number] {
  const midpoint = pointAlong(coords, 0.5);
  if (
    avoid.length === 0 ||
    nearestAvoidDistance(midpoint, avoid) >= RIVER_LABEL_CITY_CLEARANCE_DEG
  ) {
    return midpoint;
  }
  let best = midpoint;
  let bestClearance = Number.NEGATIVE_INFINITY;
  let bestCenterDistance = Number.POSITIVE_INFINITY;
  for (
    let k = ANCHOR_CANDIDATE_MIN_STEP;
    k <= ANCHOR_CANDIDATE_MAX_STEP;
    k++
  ) {
    const point = pointAlong(coords, k / ANCHOR_CANDIDATE_STEPS);
    const clearance = nearestAvoidDistance(point, avoid);
    const centerDistance = Math.abs(k - ANCHOR_CANDIDATE_STEPS / 2);
    if (
      clearance > bestClearance ||
      (clearance === bestClearance && centerDistance < bestCenterDistance)
    ) {
      best = point;
      bestClearance = clearance;
      bestCenterDistance = centerDistance;
    }
  }
  return best;
}

/** feature の折れ線一覧（LineString は 1 本、MultiLineString は全パート）。他は空 */
function riverLines(feature: Feature): Position[][] {
  const geometry = feature.geometry;
  if (geometry === null || geometry === undefined) return [];
  if (geometry.type === "LineString") return [geometry.coordinates];
  if (geometry.type === "MultiLineString") return geometry.coordinates;
  return [];
}

/**
 * ライン長由来のラベル優先度（純粋関数）。長い川ほど高優先で、
 * CollisionFilterExtension の getCollisionPriority に渡す。
 * labels.ts の面積優先度と同じ対数スケール（100 * log10）にそろえ、
 * 勢力ラベルと同一衝突空間で自然に競合させる。
 */
function riverLabelPriority(totalLength: number): number {
  if (totalLength <= 0) return MIN_LABEL_PRIORITY;
  const priority = Math.round(100 * Math.log10(totalLength));
  return Math.min(MAX_LABEL_PRIORITY, Math.max(MIN_LABEL_PRIORITY, priority));
}

/**
 * 河川ラベル 1 件分のアンカーデータ（TASK-69）。
 * 表示テキスト（text）は日本語化され得るため、ホバー/選択状態
 * （selectedRiverName / hoveredRiverName、いずれも properties.name の英語名）
 * との突合には使えない。突合キーとして元の英語名を name に保持する。
 */
export interface RiverLabelDatum extends LabelDatum {
  /** 河川の元名（properties.name、英語）。hover/selected 状態との突合キー */
  name: string;
}

/**
 * FeatureCollection から河川ラベルのアンカーデータを組み立てる（純粋関数）。
 * - name を持つ feature ごとに 1 件（name 欠落・折れ線を持たないものは除外）
 * - position は最長 LineString（MultiLineString は最長パート）上の点。
 *   通常は中点、中点が avoidPoints（都市アンカー）の直上にある場合のみ
 *   同ライン上の都市から遠い候補点へ移す（selectRiverLabelAnchor、TASK-136）
 * - priority は全パート合計長由来（長い川を優先表示）。アンカー回避では変えない
 * - ja（name-ja.json、英語名 → 日本語名）を渡すと text を日本語化。未登録は英語のまま
 * - avoidPoints は年代非依存にするため全年代の都市座標 union
 *   （cities.ts allCityPositions）を渡す契約。union から離れた点は
 *   どの年代でも都市から離れており、年代切替でラベルが跳ばない
 *
 * TASK-50: 年代・hover/selection に依存しない計算なので、呼び出し側
 * （main.ts memoizedRiverLabelData）は起動時ロード済みの riversData/nameJa/
 * 都市座標 union に対して 1 度だけ実行し、以降はメモ化された結果を使い回す。
 * TASK-69 の表示対象の絞り込みは filterVisibleRiverLabels（この結果に対する
 * 純粋なフィルタ）で行い、アンカー再計算は発生させない。
 */
export function riverLabelAnchors(
  fc: FeatureCollection,
  ja: Record<string, string> = {},
  avoidPoints: readonly Position[] = [],
): RiverLabelDatum[] {
  const data: RiverLabelDatum[] = [];
  for (const feature of fc.features) {
    const name = riverNameFor(feature.properties);
    if (name === null) continue;
    const lines = riverLines(feature).filter((c) => c.length >= 2);
    if (lines.length === 0) continue;
    let longest = lines[0];
    let longestLength = lineLength(lines[0]);
    let totalLength = longestLength;
    for (let i = 1; i < lines.length; i++) {
      const len = lineLength(lines[i]);
      totalLength += len;
      if (len > longestLength) {
        longestLength = len;
        longest = lines[i];
      }
    }
    data.push({
      name,
      text: ja[name] ?? name,
      position: selectRiverLabelAnchor(longest, avoidPoints),
      priority: riverLabelPriority(totalLength),
    });
  }
  return data;
}

/**
 * 常時表示する河川ラベルの priority 下限をズーム段から決める（純粋関数、
 * TASK-123）。この値以上の priority を持つ河川だけが、ホバー/選択に依らず
 * 地図上に常時表示される。
 *
 * しきい値の方式: 都市（cities.ts visibleCityRankLimit）のような「件数上限」
 * ではなく「priority の絶対値」で切る。理由:
 * - priority は riverLabelPriority（100 * log10(全パート合計長)）由来で、
 *   「どのくらい大きな川か」を直接表す安定な尺度。件数上限だと同率 priority の
 *   タイブレーク規則が別途必要になり、データへ河川を追加しただけで既存の
 *   大河が枠から押し出される。
 * - 山脈（NE MIN_LABEL をズーム段へ写像、TASK-97）・諸侯領
 *   （FIEF_LABEL_MIN_ZOOM、TASK-122）と同じ「各対象が出始める段を持つ」体系
 *   になる（都市の件数上限は年ごとに候補プールが変わる都市特有の事情）。
 *
 * 段の設計（データは data/rivers.geojson の 77 feature = 同名集約後 50 河川、
 * TASK-152 の scalerank 6 拡大後。しきい値自体は TASK-123 の実機確認
 * （ヘッドレス CDP で 1000/1200/1300 年 × z4〜z6）で決めた値を維持）:
 * - z4 以下（初期表示。欧州全域）: 70。ライン川（75）・ドナウ川（125）・
 *   ロワール川（95）・ポー川（78）・ローヌ川（80）級の大河 27 本だけが出る。
 *   セーヌ川（73）・ケミ川（71）まで含み、タホ川（67）以下は出さない。
 * - z5: 30。タホ川・テムズ川（44）・ガロンヌ川（45）・スヴィリ川（34）など
 *   中規模まで 35 本。
 * - z6 以上: MIN_LABEL_PRIORITY（事実上すべて）。レク/ワール川など分流・
 *   短流（priority 負値あり）も含め全 50 河川を解禁する。z6 では画面内に
 *   入る河川が数本に絞られるため、全解禁しても密度は問題にならない。
 * - 判定は整数ズーム段（Math.floor）。都市・山脈・山峰・諸侯領と同じ粒度で、
 *   呼び出し側（main.ts）の「整数段が変わった時のみ再構築」とも揃える。
 * - 非有限値（NaN 等の防御）は最も保守的な z4 しきい値へフォールバック。
 */
export function riverLabelMinPriority(zoom: number): number {
  if (!Number.isFinite(zoom)) return 70;
  const step = Math.floor(zoom);
  if (step <= 4) return 70;
  if (step === 5) return 30;
  return MIN_LABEL_PRIORITY;
}

/**
 * 地図上に表示する河川ラベルを、ズーム段とホバー/選択状態から選び出す
 * （純粋関数、TASK-69 → TASK-123）。
 *
 * TASK-69 ではホバー中・クリック選択中の河川に限って表示していたが、
 * TASK-122 で低ズームの諸侯領ラベルが消え密度問題が解消したため、TASK-123 で
 * 「ズーム段に応じた常時表示」を戻した。表示されるのは次の和集合:
 * - priority が riverLabelMinPriority(zoom) 以上の河川（常時表示）
 * - ホバー中・選択中の河川（しきい値未満でも必ず表示 = TASK-69 挙動の非退行）。
 *   ライン強調（riverLineColor/riverLineWidth）と同じ「英語名での突合」を
 *   使うため、強調されているラインとラベルが必ず一致する。
 *
 * 同名の feature が複数ある場合（Natural Earth の rivers は Rhine が 4 分割
 * されている等、パート分割が普通にある）は最も priority が高い（= 合計長が
 * 最長の）アンカー 1 件だけを残す。全件残すと 1 本の川に同じ名前のラベルが
 * 何枚も出てしまうため。しきい値判定はパートごとの priority で行うが、
 * 「最高 priority のパートが通れば名前が出る」ので河川単位の判定と一致する。
 *
 * アンカー自体は再計算せず、渡された datum の参照をそのまま返す
 * （TASK-50 のメモ化を無効化しないための契約）。入力配列は破壊しない。
 */
export function filterVisibleRiverLabels(
  anchors: readonly RiverLabelDatum[],
  hovered: string | null,
  selected: string | null,
  zoom: number,
): RiverLabelDatum[] {
  const minPriority = riverLabelMinPriority(zoom);
  const best = new Map<string, RiverLabelDatum>();
  for (const a of anchors) {
    if (a.priority < minPriority && a.name !== hovered && a.name !== selected) {
      continue;
    }
    const current = best.get(a.name);
    if (current === undefined || a.priority > current.priority) {
      best.set(a.name, a);
    }
  }
  return [...best.values()];
}
