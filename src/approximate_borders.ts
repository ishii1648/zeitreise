/**
 * 「概略境界」としての境界線表現（TASK-80）。DOM / MapLibre / deck.gl に
 * 依存しない純粋ロジックのみを置く。
 *
 * なぜ必要か: 採用データ（aourednik/historical-basemaps）は全 feature の
 * BORDERPRECISION が 1 = approximate（残りの値は 2 = moderately precise /
 * 3 = determined by international law）で、提供者自身が「この年代の全境界は
 * 概略」と宣言している。にもかかわらず従来は 1px の不透明に近い線
 * （powers.ts LINE_COLOR alpha 190/255・blur なし）で描いていたため、精密に
 * 測量された国境という誤ったメッセージを出していた。実際、1200 年のフランス
 * 周辺では境界が数百 km の直線 1 本で近似されている箇所がある（ユーザー指摘:
 * 仏王国 ↔ アンジュー帝国 277 km、トゥールーズ伯領北縁 計 206 km）。
 *
 * 方針は 2 段構え:
 * 1. 全区間を「にじみ + 低 alpha」で描く（BORDERPRECISION=1 の宣言に忠実）。
 * 2. セグメント長で 3 段に分け、長い区間ほど alpha を下げ・太く・強くにじませる
 *    （長い直線 = 頂点が無く補間もされていない = 特に概略）。
 *
 * ただし描くのは**内陸の政治境界だけ**にする（Issue #357）。沿岸補完
 * （#305/#312/#326）が政治塗りを現代海岸線まで延長したため、歴史ポリゴンの
 * 沿岸外周を線として描くと、補完前の海岸線が同色領域の内部に「国境線」の
 * ように残る（1200 年フローニンゲン周辺で報告）。海岸の輪郭はベースマップ
 * 自身の coastline が担うので、元の base で沿岸と判定できるセグメント
 * （coastal_segments.ts）は線の入力から除く。#330 で勢力圏の外枠について
 * 下した判断と同じ方針。
 *
 * 実装手段として MapLibre の line レイヤーを使う: deck.gl の GeoJsonLayer /
 * PathLayer には blur も破線も無い（線幅と色しか制御できない）が、MapLibre の
 * line レイヤーには line-blur がある。段ごとに 1 枚のレイヤーへ分け、paint を
 * 定数（TIER_STYLES）から組み立てる。データ駆動式（["match", ["get","tier"], …]）
 * を使わないのは、段ごとの paint をズーム補間と組み合わせた式が入れ子で
 * 読みにくくなるうえ、レイヤー単位なら各段の見た目を単体テストで
 * 1 対 1 に検証できるため。
 *
 * 却下した案: 塗りの色境界に沿う「かすみ帯」（Euratlas の fuzzy_borders 相当。
 * TASK-80 AC #4）。線を和らげても隣接勢力の塗りの色境界が直線であることは残る
 * ため、長い区間に沿って幅 9〜15px・低 alpha の帯を重ねる案を実装して 1200 年・
 * z6 のヘッドレススクリーンショットで比較した。インクの帯は「より太くはっきり
 * した境界線」になり AC #3 と正面から矛盾する。羊皮紙色（earth #f0e6cd）の帯は
 * 両側の塗りを等しく退色させるが、塗りの中に第 3 の色の明るい筋が生まれ、
 * 帯が付く区間（= まさに目立たせたくない超長直線）だけが光って見えるため、
 * かえって視線を引く結果になった。色の変わり目そのものを和らげるには塗りの
 * ジオメトリ側を揺らす必要がある（TASK-80 Description の案 (d) sketchy
 * rendering）ため、色境界への対処は次段階へ送る。
 */

import type {
  Feature,
  FeatureCollection,
  Geometry,
  LineString,
  Position,
} from "geojson";
import { LINE_COLOR } from "./powers.ts";
import { LABEL_OUTLINE_COLOR } from "./labels.ts";
import { MAX_ZOOM, MIN_ZOOM } from "./config.ts";
import {
  buildCoastalSegmentIndex,
  type CoastalSegmentIndex,
} from "./coastal_segments.ts";

/** GeoJSON ソースの ID（レイヤー ID の接頭辞にもする） */
export const APPROXIMATE_BORDER_SOURCE_ID = "approximate-borders";

/** 不確かさの段（normal → very-long の順に「より概略」） */
export type UncertaintyTier = "normal" | "long" | "very-long";

/** 段の一覧（弱い順）。レイヤー生成・検証はこの順に従う */
export const UNCERTAINTY_TIERS: readonly UncertaintyTier[] = [
  "normal",
  "long",
  "very-long",
];

/**
 * 「長い」と見なすセグメント長（km）の閾値（TASK-80 AC #2/#5）。
 *
 * 根拠は実データの分布（data/base_outline_1200.geojson の 4659 セグメント:
 * 中央値 15.8 km・p90 53.8 km・p99 291 km。europe_1000 / europe_1500 でも
 * 中央値 10〜15 km・p90 35〜42 km と同傾向）。
 * - LONG_SEGMENT_KM = 50 ≒ p90。セグメント数の 7〜11% だが線の総延長の
 *   35〜52% を占める「頂点が粗い区間」の入口。
 * - VERY_LONG_SEGMENT_KM = 100 ≒ p95。ユーザー指摘の直線（277 km / 141 km、
 *   諸侯領 union で切った後の 128 km）と同種の超長直線（Burgandy ↔ 神聖
 *   ローマ帝国 150 km、León ↔ Castile 294 km）が全てここに入る一方、
 *   セグメント数では 2〜5% に留まるため、地図全体が薄くなりすぎない。
 */
export const LONG_SEGMENT_KM = 50;
export const VERY_LONG_SEGMENT_KM = 100;

/** 地球半径（km）。scripts/audit-rivers.ts の haversineKm と同値 */
const EARTH_RADIUS_KM = 6371.0088;
const DEG = Math.PI / 180;

/**
 * 2 点間の大円距離（km）。
 *
 * scripts/audit-rivers.ts に同じ式の haversineKm があるが、あちらは Deno 専用の
 * 監査スクリプト側のモジュールで、ブラウザバンドル（src/）から import すると
 * 監査用の I/O まで巻き込む。数式は 6 行なのでここに持つ（両者が乖離しても
 * 用途が独立しているため実害は無い）。
 */
export function segmentLengthKm(a: Position, b: Position): number {
  const dLat = (b[1] - a[1]) * DEG;
  const dLon = (b[0] - a[0]) * DEG;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * DEG) * Math.cos(b[1] * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** セグメント長から不確かさの段を決める（境界値は上側の段に含める） */
export function uncertaintyTier(lengthKm: number): UncertaintyTier {
  if (lengthKm >= VERY_LONG_SEGMENT_KM) return "very-long";
  if (lengthKm >= LONG_SEGMENT_KM) return "long";
  return "normal";
}

/**
 * 「ほぼ直線の連続区間（直線 run）」の判定閾値（Issue #309 AC3/AC4）。
 *
 * なぜ必要か: tier をセグメント長だけで決めると、50 km 未満のセグメントが
 * ほぼ同一方位で連なって作る長い直線を検出できない。地図上では頂点の数ではなく
 * 「定規で引いた 1 本の線に見えるか」が問題なので、隣接セグメントの方位差・
 * 基準線（run の両端を結ぶ弦）からの偏差・累積長で run を検出し、run 全体を
 * 同じ段へ揃える。
 *
 * 閾値の根拠は全 19 年代の data/base_outline_<year>.geojson の実測（#309）:
 * - 方位差 8°: 5° → 8° で昇格率が動くが、8° / 10° / 12° / 15° は同一結果に
 *   なる（偏差条件が先に効いて飽和する）。「方位差が律速でなくなる最小値」を
 *   採ることで、緩い折れをむやみに直線扱いしない。
 * - 偏差 2%（弦長に対する比）: 1% では昇格が全セグメントの 0.8〜1.4%、2% で
 *   1.3〜2.6%、3% で 2.6〜5.0%（1200 年の normal 比率が 86.5% まで下がる）。
 *   100 km の弦に対する 2% = 2 km は、この地図が使う z4〜z6 では 0.4〜1.4px
 *   （lat 54 付近）＝ normal tier のインク線 1 本分未満で、画面上は直線と
 *   区別できない。
 * - 偏差の下限 1 km: 弦が 50 km を切ると 2% が 1 km を割り、どのズームでも
 *   1px に満たない揺れで run が切れる。実測では下限を 2 km 以上に上げると
 *   昇格率が 1.5 倍へ跳ねる（1815 年 1.49% → 2.46%）ため 1 km に留める。
 */
export const STRAIGHT_RUN_MAX_TURN_DEG = 8;
export const STRAIGHT_RUN_MAX_DEVIATION_RATIO = 0.02;
export const STRAIGHT_RUN_MIN_DEVIATION_KM = 1;

/** 2 点間の初期方位（度。真北 0・真東 90・西は負） */
export function initialBearingDeg(a: Position, b: Position): number {
  const dLon = (b[0] - a[0]) * DEG;
  const lat1 = a[1] * DEG;
  const lat2 = b[1] * DEG;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return Math.atan2(y, x) / DEG;
}

/** 2 つの方位の差（0〜180 度。0°/360° をまたいでも小さい方を返す） */
export function turnAngleDeg(fromDeg: number, toDeg: number): number {
  return Math.abs(((toDeg - fromDeg) % 360 + 540) % 360 - 180);
}

/**
 * 基準線 a→b に対する点 p の垂線距離（km）。
 *
 * 局所平面近似（緯度で経度をスケールする等距円筒）で足りる: 対象は高々
 * 数百 km の区間で、判定に使う閾値は弦長の 2%（数 km）なので、球面の厳密な
 * cross-track distance との差は閾値よりずっと小さい。
 */
export function crossTrackDeviationKm(
  a: Position,
  b: Position,
  p: Position,
): number {
  const kmPerDegLat = EARTH_RADIUS_KM * DEG;
  const lat0 = (a[1] + b[1] + p[1]) / 3;
  const kmPerDegLon = kmPerDegLat * Math.cos(lat0 * DEG);
  const ax = a[0] * kmPerDegLon, ay = a[1] * kmPerDegLat;
  const bx = b[0] * kmPerDegLon, by = b[1] * kmPerDegLat;
  const px = p[0] * kmPerDegLon, py = p[1] * kmPerDegLat;
  const vx = bx - ax, vy = by - ay;
  const chord = Math.hypot(vx, vy);
  if (chord === 0) return Math.hypot(px - ax, py - ay);
  return Math.abs(vx * (py - ay) - vy * (px - ax)) / chord;
}

/**
 * 座標列の各セグメントについて「属する直線 run の累積長（km）」を返す
 * （長さ = line.length - 1。Issue #309 AC3）。
 *
 * 貪欲に前から run を伸ばす: 現在の run へ次のセグメントを加えられるのは
 * (1) 直前のセグメントとの方位差が STRAIGHT_RUN_MAX_TURN_DEG 以下、かつ
 * (2) run に含まれる全ての中間頂点が、拡張後の run の両端を結ぶ弦から
 *     max(STRAIGHT_RUN_MIN_DEVIATION_KM, 弦長 × 比) 以内、の両方を満たすとき。
 *
 * (1) だけでは緩い弧（1 回ごとの折れは小さいが曲がり続ける海岸線・河川沿い）を
 * 直線と誤判定し、(2) だけでは V 字に折れて戻る区間を拾ってしまうため両方を見る。
 *
 * 環（ポリゴンの外環・穴）の先頭と末尾をまたぐ run は検出しない: GeoJSON の環は
 * 先頭 = 末尾で閉じるだけで「どの頂点が先頭か」に意味は無く、またぐ処理を足すと
 * 開いた線（base_outline の LineString）と分岐が分かれる。実データ（全 19 年代）
 * では、環の継ぎ目に長い直線が跨がる例は昇格対象の run に現れなかった。
 */
export function straightRunLengthsKm(line: Position[]): number[] {
  const n = line.length - 1;
  if (n < 1) return [];
  const segmentKm: number[] = [];
  const bearings: number[] = [];
  for (let i = 0; i < n; i++) {
    segmentKm.push(segmentLengthKm(line[i], line[i + 1]));
    bearings.push(initialBearingDeg(line[i], line[i + 1]));
  }
  const runKm = new Array<number>(n);
  let start = 0;
  while (start < n) {
    let end = start;
    let total = segmentKm[start];
    while (end + 1 < n) {
      if (
        turnAngleDeg(bearings[end], bearings[end + 1]) >
          STRAIGHT_RUN_MAX_TURN_DEG
      ) {
        break;
      }
      const from = line[start];
      const to = line[end + 2];
      const tolerance = Math.max(
        STRAIGHT_RUN_MIN_DEVIATION_KM,
        STRAIGHT_RUN_MAX_DEVIATION_RATIO * segmentLengthKm(from, to),
      );
      let straight = true;
      for (let v = start + 1; v <= end + 1; v++) {
        if (crossTrackDeviationKm(from, to, line[v]) > tolerance) {
          straight = false;
          break;
        }
      }
      if (!straight) break;
      end++;
      total += segmentKm[end];
    }
    for (let i = start; i <= end; i++) runKm[i] = total;
    start = end + 1;
  }
  return runKm;
}

/**
 * 各セグメントの「実効長」= 自身の長さと、属する直線 run の累積長の大きい方
 * （Issue #309）。tier 判定はこの値で行う。
 *
 * max を取るのは、単独の超長セグメント（従来の判定対象）が run 検出によって
 * 弱まらないことを保証するため（run が 1 本しか無いときは両者が一致する）。
 */
export function effectiveSegmentLengthsKm(line: Position[]): number[] {
  const runKm = straightRunLengthsKm(line);
  return runKm.map((km, i) =>
    Math.max(km, segmentLengthKm(line[i], line[i + 1]))
  );
}

/** 1 段分の見た目（色の alpha・線幅 px・にじみ px） */
export interface TierStyle {
  readonly alpha: number;
  readonly widthPx: number;
  readonly blurPx: number;
}

/**
 * 段ごとの見た目（TASK-80 AC #1/#2/#5）。
 *
 * 設計: 段が進むほど alpha を下げ、太く、そして「にじみ / 線幅」の比を上げる。
 * ink の総量をおおよそ保ったまま「輪郭のある細い線 → 輪郭を持たない幅広い帯」へ
 * 連続的に移すのが狙いで、帯として読めれば「この辺りが境目」という情報は残り、
 * 「ここが測量された国境線」という誤読だけが消える。
 *
 * - normal（< 50 km）: alpha 0.70・1.2px・blur 0.6px（比 0.5）。従来
 *   （alpha 0.75・blur 0）より弱くにじむが、輪郭は残す。ここを更に弱めると
 *   1815 年のドイツ諸邦のような小国が密集する年代で境界が読めなくなり
 *   （ヘッドレス確認で alpha 0.5・blur 1.0px 版が塗りの色差だけになることを確認）、
 *   「概略として描く」ではなく「描かない」になってしまう。
 * - long（50〜100 km）: alpha 0.4・1.8px・blur 2.5px（比 1.4）。少し離れると
 *   線ではなく帯に見える。
 * - very-long（≥ 100 km）: alpha 0.24・2.8px・blur 5.0px（比 1.8）。位置は
 *   分かるが輪郭がまったく無く、「引いた線」には見えない（AC #3）。
 */
export const TIER_STYLES: Record<UncertaintyTier, TierStyle> = {
  "normal": { alpha: 0.70, widthPx: 1.2, blurPx: 0.6 },
  "long": { alpha: 0.4, widthPx: 1.8, blurPx: 2.5 },
  "very-long": { alpha: 0.24, widthPx: 2.8, blurPx: 5.0 },
};

/**
 * 線のインク（RGB）。従来の境界線（powers.ts LINE_COLOR）と同じ褪せ顔料
 * （TASK-73/74 のパレット）にし、段ごとに alpha だけを変える。
 */
export const APPROXIMATE_BORDER_INK: readonly [number, number, number] = [
  LINE_COLOR[0],
  LINE_COLOR[1],
  LINE_COLOR[2],
];

/** 段に対応する line-color（CSS rgba 文字列） */
export function approximateBorderColor(tier: UncertaintyTier): string {
  const [r, g, b] = APPROXIMATE_BORDER_INK;
  return `rgba(${r}, ${g}, ${b}, ${TIER_STYLES[tier].alpha})`;
}

/**
 * 線幅・にじみのズーム倍率（TASK-80）。線幅とにじみに同じ倍率をかけるので、
 * 段の見た目の比率（にじみ / 線幅）はズームに依らず一定に保たれる。
 * - 最小ズーム（ヨーロッパ全体）は境界線が密集するため 0.9 倍に絞る（潰れ防止）
 * - 最大ズーム（地方）は 1.4 倍に広げ、拡大してもにじみが 1px 未満にならない
 *   ようにする
 * 補間の両端は config.ts の MIN_ZOOM / MAX_ZOOM に合わせる: アプリはこの範囲外へ
 * ズームできない（maxBounds と同様に Map の minZoom/maxZoom で制限している）ため、
 * 端をこれより外に置くと最小・最大ズームでも倍率が中途半端な値のままになる。
 */
export const ZOOM_SCALE = {
  minZoom: MIN_ZOOM,
  maxZoom: MAX_ZOOM,
  minScale: 0.9,
  maxScale: 1.4,
} as const;

/**
 * 上位勢力外周の casing のインク（RGB）（Issue #228 AC5）。
 *
 * ラベル halo と同じ羊皮紙トーンのクリーム（labels.ts LABEL_OUTLINE_COLOR =
 * app.css --parchment #f4ecd7）。casing は「境界階層の最上位（上位勢力の外周）
 * である」ことを示す下地であり、精密な国境線に見える硬い二重線にしてはいけない
 * （#228「境界精度表現との整合」）ため、第 2 のインク線ではなく halo と同じ
 * 視覚文法（濃インクの周りに地の色と連続するクリーム）で描く。
 *
 * モジュール先頭の却下案（羊皮紙色 earth #f0e6cd の帯）との違い: あちらは
 * 超長直線の区間だけに帯を付けたため「目立たせたくない区間だけが光る」逆効果に
 * なった。casing は base 外周の全区間へ一様に敷くので、特定の区間だけが
 * 浮くことはない。
 */
export const APPROXIMATE_BORDER_CASING_INK: readonly [
  number,
  number,
  number,
] = [
  LABEL_OUTLINE_COLOR[0],
  LABEL_OUTLINE_COLOR[1],
  LABEL_OUTLINE_COLOR[2],
];

/** casing の見た目 1 点分（alpha・線幅 px・にじみ px。TierStyle と同形） */
export interface CasingStyle {
  readonly alpha: number;
  readonly widthPx: number;
  readonly blurPx: number;
}

/** casing を敷く段（Issue #309）。very-long には敷かない */
export type CasingTier = "normal" | "long";

/**
 * casing を敷く段の一覧（弱い順。Issue #309 AC1/AC2）。
 *
 * very-long を外すのは、#228 の casing が filter `["has", "tier"]` で全段へ
 * 一律に敷かれており、最も不確かな区間（インク線は alpha 0.24・blur 5.0px の
 * にじみ帯）の下に alpha 0.5・blur 1.4px の明るい帯が残って、TASK-80 /
 * ADR-0016 が弱めたはずの長距離直線を再び強調していたため。casing が示すのは
 * 「上位勢力の外周」という境界階層だが、その記号が不確かさの表現を上書きして
 * よい理由は無い（#228 AC5 の「長距離直線ほど弱く、広くにじませる」とも矛盾）。
 */
export const CASING_TIERS: readonly CasingTier[] = ["normal", "long"];

/**
 * casing のズーム両端の見た目（Issue #228 AC5・#309 で段別化）。MIN_ZOOM
 * （z4 = 概観表示）と MAX_ZOOM（z8 = 詳細表示）の 2 点を MapLibre の zoom 補間
 * （線形）で結ぶ。
 *
 * normal（#228 の値をそのまま維持。境界階層の記号としての casing はここが本体）:
 * - 幅: どのズームでも最太の tier 線（very-long 2.8px × ZOOM_SCALE 0.9〜1.4 =
 *   2.52〜3.92px）より広く、インク線の下からはみ出して「外周の下地」として
 *   読める。ただし、はみ出し（片側 (casing 幅 − tier 幅)/2）は最太 tier 線に
 *   対して 1px 以下に抑える: normal tier のインク線 1 本分（1px）を超えて
 *   覗くと、下地の縁取りではなく境界沿いの第 3 の帯 = 隣接領域への「塗り漏れ」
 *   に見える（#280。旧値 z4: 6.0px は 1.74px はみ出していた）。z4 側（4.4px）を
 *   相対的に太くする（tier 比 1.75 倍 > z8 の 1.07 倍）のは、概観表示では
 *   上位勢力の外周が境界階層の最上位になるため。
 * - alpha: 0.5 → 0.28 の低 alpha。塗りが透けるので「縁取りされた精密な国境」に
 *   ならず、詳細ズームでは内部境界・都市の情報を邪魔しない控えめさに落とす。
 * - blur: 幅の 1/3 以下（約 3 割）の軽いにじみ。エッジを和らげて硬い二重線化を
 *   防ぎつつ、blur が幅を超える「にじみ帯」（tier very-long の表現）とは
 *   区別する。旧値（幅の 4 割弱）から比も下げるのは、blur がエッジの alpha
 *   勾配で見かけの帯幅を広げるため、幅だけ縮めても縮小分がにじみで埋め戻される
 *   ため（#280）。
 *
 * long（#309 で追加。「外周である」ことは残しつつ直線を強調しない）:
 * - alpha を normal の半分未満（0.5 → 0.22 / 0.28 → 0.13）まで落とす。
 *   long のインク線は alpha 0.4・blur 2.5px のにじんだ帯なので、その下に
 *   normal と同じ明るさの下地があると「にじませた線の中心に明るい芯がある」
 *   逆転が起きる。alpha を主たるレバーにするのは、幅と blur が #280 の制約
 *   （はみ出し ≤ 1px・blur ≤ 幅/3）で頭打ちだから。
 * - にじみ / 幅の比は normal（0.318）より上げて 1/3 ちょうどに置き、tier
 *   インク線と同じ「長いほど輪郭を失う」文法へ合わせる。blur の絶対値を
 *   normal より上げないのは #280 の制約を維持するため（幅を広げれば blur も
 *   上げられるが、はみ出しが増えて #280 の「塗り漏れ」が再発する）。
 * - 幅は normal より僅かに細くする（はみ出しを増やさない範囲で最小限に）。
 */
export const CASING_STYLES: Record<CasingTier, {
  readonly overview: CasingStyle;
  readonly detail: CasingStyle;
}> = {
  normal: {
    overview: { alpha: 0.5, widthPx: 4.4, blurPx: 1.4 },
    detail: { alpha: 0.28, widthPx: 4.2, blurPx: 1.3 },
  },
  long: {
    overview: { alpha: 0.22, widthPx: 4.2, blurPx: 1.4 },
    detail: { alpha: 0.13, widthPx: 4.0, blurPx: 1.32 },
  },
};

/** run（同じ段の連続区間）の properties キー */
export const TIER_PROPERTY = "tier";
export const MAX_SEGMENT_KM_PROPERTY = "maxSegmentKm";

/** feature を持たない空の FeatureCollection（同一参照で setData の差分を減らす） */
export const EMPTY_APPROXIMATE_BORDER_DATA: FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

/** ジオメトリから「線として扱う座標列」を取り出す（ポリゴンの環も線として扱う） */
function linesOf(geometry: Geometry): Position[][] {
  switch (geometry.type) {
    case "LineString":
      return [geometry.coordinates];
    case "MultiLineString":
      return geometry.coordinates;
    // ポリゴンの環（外環・穴）はそのまま閉じた線。GeoJSON では先頭 = 末尾の
    // 座標を含むため、閉合セグメントも自然に含まれる
    case "Polygon":
      return geometry.coordinates;
    case "MultiPolygon":
      return geometry.coordinates.flat();
    case "GeometryCollection":
      return geometry.geometries.flatMap(linesOf);
    default:
      // Point / MultiPoint は境界線を持たない
      return [];
  }
}

/**
 * 1 本の座標列を「同じ段が連続する区間（run）」へ切り分ける。
 * 隣接する run は切り替え位置の頂点を共有するため、段が変わる場所で線が
 * 途切れない（レイヤーが分かれても見た目は 1 本の連続した境界に見える）。
 *
 * #309: 段の判定はセグメント長ではなく実効長（= 属する直線 run の累積長との
 * max）で行う。細切れの直線が 1 本の長い直線に見える箇所を、単独の長い
 * セグメントと同じ表現へ揃えるため。
 *
 * #357: coastal が渡されると、沿岸と判定されたセグメントを飛ばして run を
 * 切る（旧海岸外周を描かない）。**段の判定（実効長 = 直線 run の検出）は
 * 除外前の座標列全体に対して行う**のが要点で、順序を逆にすると沿岸を挟んで
 * 続く内陸区間の直線 run が短く切れ、内陸境界の tier が #309 以前より弱く
 * なってしまう（Issue #357 AC5 の非退行）。
 */
function runsOf(
  line: Position[],
  coastal: CoastalSegmentIndex | null,
): Feature<LineString>[] {
  if (line.length < 2) return [];
  const effectiveKm = effectiveSegmentLengthsKm(line);
  const runs: Feature<LineString>[] = [];
  /** 現在の run の開始頂点（null = 直前が沿岸で run が閉じている） */
  let start: number | null = null;
  let tier: UncertaintyTier = "normal";
  let maxKm = 0;
  const flush = (end: number) => {
    if (start === null) return;
    const coordinates = line.slice(start, end + 1);
    start = null;
    if (coordinates.length < 2) return;
    runs.push({
      type: "Feature",
      properties: {
        [TIER_PROPERTY]: tier,
        // 描画には使わないが、実データの検証・ヘッドレス確認で「どの区間が
        // どれだけ長いのか」を追えるようにする
        [MAX_SEGMENT_KM_PROPERTY]: maxKm,
      },
      geometry: { type: "LineString", coordinates },
    });
  };
  for (let i = 1; i < line.length; i++) {
    if (coastal !== null && coastal.includes(line[i - 1], line[i])) {
      flush(i - 1);
      continue;
    }
    const km = segmentLengthKm(line[i - 1], line[i]);
    const next = uncertaintyTier(effectiveKm[i - 1]);
    if (start === null || next !== tier) {
      flush(i - 1);
      start = i - 1;
      tier = next;
      maxKm = km;
    } else {
      maxKm = Math.max(maxKm, km);
    }
  }
  flush(line.length - 1);
  return runs;
}

/**
 * 境界線の FeatureCollection（base 勢力ポリゴン、または TASK-78 の派生
 * base_outline の LineString 群）から、段ごとに切り分けた LineString 群を作る。
 * 元の base で沿岸と判定できるセグメントは除く（#357。下記「base 引数」）。
 *
 * 入力を選ばないのは、諸侯領オーバーレイ対象年（1000〜1300）は
 * data/base_outline_<year>.geojson（諸侯領 union の外側だけに切り出した線。
 * TASK-78 の二重輪郭解消をそのまま維持する）、それ以外の年は
 * data/europe_<year>.geojson のポリゴンの環、と入力形が違うため。
 *
 * 実行時に計算する（ビルド時の派生データを増やさない）: 対象は 1 年あたり
 * 5〜7 千セグメントで、年代切替のたびに走っても数十 ms 程度（実測 28〜44ms／年。
 * うち大半が #357 の沿岸判定で、段分けだけなら 1ms 前後）。結果は呼び出し側
 * approximate_border_sync が年ごとにメモ化するので、同じ年の再描画では走らない。
 * 年代ごとに派生ファイルを増やすと dist へのコピー・サイズ・生成スクリプトの
 * 保守が増える一方、得られるのは同じ結果でしかない。
 *
 * ## base 引数（#357）
 * `base` は**沿岸判定の基準**にだけ使う「元の勢力ポリゴン」で、線として描く
 * 対象は常に `source` である。両者を分けるのは、`source` が派生データ
 * （`base_outline_<year>`。諸侯領 union の境界で lineSplit 済み）でも、
 * 沿岸かどうかは元のポリゴンでしか決められないため
 * （coastal_segments.ts COASTAL_MATCH_EPS_DEG）。
 *
 * base を省くと `source` 自身が基準になる:
 * - 素の勢力ポリゴンを渡す経路（諸侯領オーバーレイの無い年・縮退）はそれで
 *   正しく沿岸が落ちる。
 * - LineString だけの入力では沿岸判定の材料が無く索引が空になるので、
 *   TASK-80 以来の「全環を線にする」挙動そのままになる（後方互換）。
 * `source` に base と outline を混ぜて合成する経路（#347 の focus 表示）でも、
 * base を明示すれば合成の仕方に依らず沿岸外周は再導入されない。
 */
export function buildApproximateBorderData(
  source: FeatureCollection,
  base: FeatureCollection = source,
): FeatureCollection {
  const index = buildCoastalSegmentIndex(base);
  const coastal = index.size === 0 ? null : index;
  const features = source.features.flatMap((feature) =>
    feature.geometry === null
      ? []
      : linesOf(feature.geometry).flatMap((line) => runsOf(line, coastal))
  );
  return { type: "FeatureCollection", features };
}

/** 段に対応する MapLibre レイヤー ID */
export function approximateBorderLayerId(tier: UncertaintyTier): string {
  return `${APPROXIMATE_BORDER_SOURCE_ID}-${tier}`;
}

/** 段に対応する casing レイヤーの ID（Issue #228 / #309。tier 群の下に敷く） */
export function approximateBorderCasingLayerId(tier: UncertaintyTier): string {
  return `${APPROXIMATE_BORDER_SOURCE_ID}-casing-${tier}`;
}

/** casing レイヤーの ID 一覧（弱い順。very-long は含まない。#309） */
export const APPROXIMATE_BORDER_CASING_LAYER_IDS: readonly string[] =
  CASING_TIERS.map(approximateBorderCasingLayerId);

/**
 * 概略境界レイヤーの ID 一覧（下から順: casing 群 → 弱い段から順）。順序は
 * layer_stack.ts が deck の挿入位置（先頭 = 最下段の直下へ政治ポリゴンを
 * 入れる）とレイヤーどうしの順序検証に使うため、下から順であることが必須。
 * casing はインク線の下地なので最下段（#228）。
 */
export const APPROXIMATE_BORDER_LAYER_IDS: readonly string[] = [
  ...APPROXIMATE_BORDER_CASING_LAYER_IDS,
  ...UNCERTAINTY_TIERS.map(approximateBorderLayerId),
];

/** MapLibre の line レイヤー定義の最小型（LineLayerSpecification 互換） */
export interface ApproximateBorderLayerSpec {
  readonly id: string;
  readonly type: "line";
  readonly source: string;
  readonly filter: unknown;
  readonly layout: Readonly<Record<string, unknown>>;
  readonly paint: Readonly<Record<string, unknown>>;
}

/** 線幅・にじみのズーム補間式を組み立てる（値は TIER_STYLES × ZOOM_SCALE） */
function zoomScaled(basePx: number): unknown {
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    ZOOM_SCALE.minZoom,
    basePx * ZOOM_SCALE.minScale,
    ZOOM_SCALE.maxZoom,
    basePx * ZOOM_SCALE.maxScale,
  ];
}

/** casing の MIN_ZOOM → MAX_ZOOM 線形補間式（CASING_STYLES の 2 点を結ぶ） */
function casingZoomInterpolated(
  tier: CasingTier,
  valueOf: (style: CasingStyle) => number | string,
): unknown {
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    MIN_ZOOM,
    valueOf(CASING_STYLES[tier].overview),
    MAX_ZOOM,
    valueOf(CASING_STYLES[tier].detail),
  ];
}

/**
 * 上位勢力外周の casing レイヤー定義（Issue #228 AC5・#309 で段別化）。
 *
 * tier 群と同じ GeoJSON ソースを引き、filter で自段の run だけを描く。
 * #228 は `["has", "tier"]` で全段へ一律に敷いていたが、それでは最も不確かな
 * very-long でも明るい帯が残り、長距離直線を再強調していた（#309）。
 *
 * データ駆動式（`["match", ["get","tier"], …]`）で 1 枚に畳まないのは 2 点:
 * (1) MapLibre では `["zoom"]` は最上位の interpolate / step の入力にしか
 *     置けないため、段別 × ズーム補間は interpolate の各ストップの中へ match を
 *     入れ子にする形になり、tier 群でこの形を避けた理由（読みにくさ・段ごとの
 *     見た目を単体テストで 1 対 1 に検証できない）がそのまま当てはまる。
 * (2) very-long は「レイヤーそのものが無い」形にできるので、描かないことが
 *     レイヤー一覧を見るだけで分かる。段を分けても run は頂点を共有するため、
 *     見た目は 1 本の連続した下地のままになる。
 *
 * 幅・alpha・blur は z4（概観）側を強く、詳細ズームで控えめにするズーム補間
 * （値と根拠は CASING_STYLES）。tier の ZOOM_SCALE（高ズームほど太い）と逆向き
 * なのは、概観表示 z4 でこそ外周が塗り・勢力名に次ぐ主役になるため。
 */
export function approximateBorderCasingSpecs(): ApproximateBorderLayerSpec[] {
  const [r, g, b] = APPROXIMATE_BORDER_CASING_INK;
  return CASING_TIERS.map((tier) => ({
    id: approximateBorderCasingLayerId(tier),
    type: "line" as const,
    source: APPROXIMATE_BORDER_SOURCE_ID,
    filter: ["==", ["get", TIER_PROPERTY], tier],
    layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-color": casingZoomInterpolated(
        tier,
        (style) => `rgba(${r}, ${g}, ${b}, ${style.alpha})`,
      ),
      "line-width": casingZoomInterpolated(tier, (style) => style.widthPx),
      "line-blur": casingZoomInterpolated(tier, (style) => style.blurPx),
    },
  }));
}

/**
 * 概略境界の全レイヤー定義（下から順: casing 群 → 弱い段から順）。tier
 * レイヤーは同一 GeoJSON ソースを引き、filter で自段の run だけを描く。
 */
export function approximateBorderLayerSpecs(): ApproximateBorderLayerSpec[] {
  return [
    ...approximateBorderCasingSpecs(),
    ...UNCERTAINTY_TIERS.map((tier) => ({
      id: approximateBorderLayerId(tier),
      type: "line" as const,
      source: APPROXIMATE_BORDER_SOURCE_ID,
      filter: ["==", ["get", TIER_PROPERTY], tier],
      // 角・端の処理は layout プロパティ（paint に置くとスタイル検証で弾かれる）。
      // 概略の帯なので尖らせず丸め、にじみと馴染ませる
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": approximateBorderColor(tier),
        "line-width": zoomScaled(TIER_STYLES[tier].widthPx),
        "line-blur": zoomScaled(TIER_STYLES[tier].blurPx),
      },
    })),
  ];
}

/** GeoJSON ソース定義（MapLibre GeoJSONSourceSpecification 互換の最小型） */
export function approximateBorderSourceSpec(
  data: FeatureCollection = EMPTY_APPROXIMATE_BORDER_DATA,
): { readonly type: "geojson"; readonly data: FeatureCollection } {
  return { type: "geojson", data };
}
