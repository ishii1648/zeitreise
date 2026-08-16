/**
 * 勢力名ラベルの DOM/deck.gl 非依存な純粋ロジック（TASK-20）。
 * - 各勢力ポリゴンの代表点（最大ポリゴンの pole of inaccessibility）の算出
 * - CollisionFilterExtension 用の面積由来ラベル優先度の算出
 * - FeatureCollection → TextLayer 用データへの変換と characterSet の抽出
 *
 * 地図上の常時ラベルは NAME のみとする。属領（SUBJECTO≠NAME）の宗主国込み表記
 * （"NAME — SUBJECTO 領"）はホバー/クリックのツールチップ（info.ts displayLabel）
 * に委ねる。displayLabel も NAME から始まるため両者の表記は矛盾しない。
 */

import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  MultiPolygon,
  Polygon,
  Position,
} from "geojson";
import polylabelModule from "@mapbox/polylabel";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { MIN_ZOOM } from "./config.ts";
import { colorKeyFor } from "./powers.ts";

/** polylabel の最小契約（パッケージに型定義が無いため自前で与える） */
type PolylabelFn = (
  rings: Position[][],
  precision?: number,
) => [number, number];
const polylabel = polylabelModule as unknown as PolylabelFn;

/**
 * polylabel の探索精度（座標系の単位 = 度）。0.01° ≒ 1km 弱で、国スケールの
 * ラベル位置には十分細かく、計算量も小さい。
 */
const POLYLABEL_PRECISION = 0.01;

/** CollisionFilterExtension getCollisionPriority の許容レンジ下限 */
export const MIN_LABEL_PRIORITY = -1000;

/** CollisionFilterExtension getCollisionPriority の許容レンジ上限 */
export const MAX_LABEL_PRIORITY = 1000;

/**
 * 勢力ラベルの由来種別（TASK-30、TASK-71 で "fief" を追加）。
 * - "base": 独立国など base データ（europe_*）由来
 * - "hre": HRE 領邦オーバーレイ（hre_*）由来
 * - "fief": 中世フランス諸侯領オーバーレイ（france_fiefs_*）由来
 */
export type LabelKind = "base" | "hre" | "fief";

/**
 * 政治表示の階層（#267 AC2）。境界線とラベルが共有する分類で、名称の
 * 接尾辞（「王国」「公領」「伯領」）ではなくデータ構造から決める:
 * - "top": 上位勢力（base = europe_* の feature。宗主色寄せ・外周の単位）
 * - "constituent": 上位勢力の直下にある主要構成勢力（領邦・諸侯領
 *   オーバーレイの feature。分類不能時のフォールバック先でもある）
 * - "sub": より下位の内部単位。SUBJECTO（直接の主君）と PARTOF（最上位の
 *   所属）が別勢力として宣言されている = 2 段以上深い構造が取得できる
 *   feature だけが該当する（politicalOverlayTier）
 */
export type PoliticalTier = "top" | "constituent" | "sub";

/** TextLayer に渡すラベル 1 件分のデータ */
export interface LabelDatum {
  /** 表示テキスト（NAME） */
  text: string;
  /** アンカー座標 [lon, lat] */
  position: [number, number];
  /** z4 だけで使う欧州本国優先アンカー（未指定は position、#407）。 */
  overviewPosition?: [number, number];
  /**
   * z4 overview の事前衝突レイアウトが付ける画面 px オフセット（#407）。
   * 未指定は [0, 0]。地理アンカー自体は position に保ち、deck.gl の
   * getPixelOffset だけで最小限ずらす。
   */
  pixelOffset?: [number, number];
  /** 衝突制御の優先度（大きいほど優先。MIN..MAX_LABEL_PRIORITY） */
  priority: number;
  /** 由来種別（TASK-30 で導入。省略時は base 扱い） */
  kind?: LabelKind;
  /**
   * 政治表示の階層（#267 AC2/AC6）。buildLabelData が kind と properties の
   * 構造（politicalLabelTier）から付与し、サイズ（powerLabelSizePx）と
   * レベル別の表示絞り込み（filterPowerLabelsByZoom）が読む。省略時は
   * kind から解決する（labelTierOf）。
   */
  tier?: PoliticalTier;
  /**
   * 強調キー（TASK-93）。powers.ts colorKeyFor と同一のキーで、塗りの色分け・
   * power_highlight.ts の強調適用単位と一致する。これにより「アクティブ色に
   * 塗られている面のラベル」だけを構造的に選び出せる（飛び地も同時に切り替わる）。
   * 勢力ポリゴン由来のラベルにのみ付く（河川名・都市名は持たない）。
   */
  key?: string;
  /**
   * TASK-78 の二重ラベル抑制対象か（kind="base" のみ・TASK-122 で導入）。
   *
   * TASK-78 では抑制対象の base feature を buildLabelData に渡す前に
   * 落としていた（旧 fief_dedupe.ts excludeSuppressedFeatures、TASK-126 で
   * 削除）が、TASK-122 で
   * 諸侯領ラベルをズーム段で出し分けるようになり「落とす／残す」の判断が
   * ズーム依存になった。datum は常に作っておいてここに印だけ付け、実際に
   * 出すかどうかは filterPowerLabelsByZoom が決める。こうすることで
   * characterSet を**絞り込み前**の全 datum から作れる（ズームインで
   * 未収録グリフが出ない。AC #7）。
   */
  suppressed?: boolean;
}

/** ラベル文字色の RGBA */
export type LabelColor = readonly [number, number, number, number];

/**
 * 政治勢力ラベルの通常文字色（クリーム寄りの明色。#267 AC5）。
 *
 * 案A「境界の階層化」の基本デザイン: 政治勢力名は明色文字 + 濃焦茶 halo
 * （POLITICAL_LABEL_HALO_COLOR）で描き、領土色・地形の明暗にかかわらず
 * halo とのコントラストだけで判読を担保する。TASK-30/71 の「独立勢力 =
 * 濃灰 / 帝国領邦 = 臙脂 / 諸侯領 = 藍紫」という文字色の記号は通常時の
 * 主表現から外し、表示階層はサイズ（powerLabelSizePx）・halo・衝突優先度
 * （tieredLabelPriority）で示す。
 *
 * 値は共通クリーム halo（LABEL_OUTLINE_COLOR #f4ecd7）よりわずかに明るい
 * #f8f2e2。濃焦茶 halo（#3a2712）とのコントラスト比は約 12.7:1 で
 * MIN_HALO_LABEL_CONTRAST（7:1）を大きく満たす。純白にしないのは、通常時から
 * 最大輝度を使うと強調時（ACTIVE_POLITICAL_LABEL_COLOR = 純白）との差が
 * 作れなくなるのと、羊皮紙トーンの地図で白が浮くため。
 */
export const POLITICAL_LABEL_COLOR: LabelColor = [248, 242, 226, 255];

/**
 * 強調（ホバー/クリック）中の政治勢力ラベルの文字色（純白。#267 AC5）。
 *
 * TASK-93 では「暗色文字 + クリーム halo」の構図だったため強調時は文字を
 * さらに暗く沈めたが、#267 で構図が反転（明色文字 + 濃焦茶 halo）したので
 * 強調も明るい方向（クリーム → 純白）へ振る。判読の担保は halo が担う
 * ため、アクティブ塗り（緑青）の明度に依存しない。
 */
export const ACTIVE_POLITICAL_LABEL_COLOR: LabelColor = [255, 255, 255, 255];

/**
 * 政治勢力ラベルの halo / 影の色（濃い焦茶の SDF アウトライン。#267 AC5）。
 *
 * app.css の --ink #3a2712 と同値。上位勢力外周のインク（powers.ts
 * LINE_COLOR #5c3d22 = --frame）と同系のさらに深い焦茶で、「境界も
 * ラベルの輪郭も同じインクで引いた古地図」という視覚文法に揃える。
 * 真黒 [0,0,0] を使わないのは境界線と同じ理由（羊皮紙調に馴染ませる）。
 * 不透明な矩形パネルは使わず（labelTextStyleProps background: false）、
 * 判読の担保はこの halo に一本化する。
 *
 * 政治勢力ラベル（political_layers.ts buildLabelLayer）だけがこの halo を
 * 使い、河川・都市・山岳の注記は従来どおり共通クリーム halo
 * （LABEL_OUTLINE_COLOR）のまま。「明色文字 + 濃 halo = 政治勢力名 /
 * 暗色文字 + クリーム halo = 注記」という 2 系統の描き分けになる。
 */
export const POLITICAL_LABEL_HALO_COLOR: LabelColor = [58, 39, 18, 255];

/**
 * 中世諸侯領の記号色（藍紫。TASK-71 AC #1 で導入）。
 *
 * #267 以降、ラベル文字色としては使わない（政治ラベルは
 * POLITICAL_LABEL_COLOR の明色に統一）。諸侯領オーバーレイの内部境界線の
 * インク（political_layers.ts FIEF_BORDER_INK）の色相定義として残す。
 * 「藍紫の細線 = オーバーレイ由来の区画」という凡例（TASK-71/96、#172/#189）
 * は境界線側で維持される。
 */
export const FIEF_LABEL_COLOR: LabelColor = [74, 42, 130, 255];

/**
 * 強調（ホバー/クリック）中の国名・諸侯領名ラベルに求めるコントラスト比
 * （TASK-93 AC #2）。アクティブ塗り + 羊皮紙下地の合成色に対する比で測る。
 *
 * 基準値 4.5:1 の根拠: WCAG 2.1 の「通常サイズのテキスト」AA 基準。ラベルは
 * 14px（POWER_LABEL_SIZE_PX）・weight 600 で、WCAG の「大きめテキスト」
 * （18pt = 24px、または bold 14pt = 18.66px）には届かないため、緩い 3:1 では
 * なく 4.5:1 を採る。強調は一時的な状態だが、その最中こそ「それが何か」を
 * 読ませたい場面なので通常表示より基準を緩めない（AC #1 の「同等以上」）。
 *
 * #267: 政治ラベルは明色文字 + 濃焦茶 halo になり、判読の相手は塗りの
 * 合成背景ではなく halo（POLITICAL_LABEL_HALO_COLOR）になった。この基準は
 * 強調中の文字色 vs halo に適用する（label_contrast_test.ts）。
 */
export const MIN_ACTIVE_LABEL_CONTRAST = 4.5;

/**
 * 強調塗りの上に載る副次ラベル（都市名）の下限（TASK-93）。
 * 都市名は強調キーを持たず色を切り替えないため、塗り側の明度調整だけで
 * 満たせる水準として WCAG の大きめテキスト相当 3:1 を下限に置く。
 */
export const MIN_SECONDARY_LABEL_CONTRAST = 3;

/**
 * 文字色とクリーム halo（LABEL_OUTLINE_COLOR）の間に保つコントラスト比
 * （TASK-93）。TASK-72 以降、判読性の主要な担保は halo による輪郭なので、
 * 強調時に文字を明色へ振って halo と同化させてはいけない。7:1（WCAG AAA
 * 相当）を下限にして「濃インク + クリーム halo」の関係を固定する。
 */
export const MIN_HALO_LABEL_CONTRAST = 7;

/**
 * アクティブ塗り（合成後）と羊皮紙下地の間に保つコントラスト比（TASK-93）。
 * ラベル判読のために塗りを明るくしていくと、いずれ強調そのものが下地に
 * 埋もれて TASK-90 の目的（国土の広がりが一目で分かる）を失う。塗りの
 * 明度調整に上限を与えるための下限値で、1.8:1 は「弱い階調差」とされる
 * 1.5:1 を明確に超える水準として採る。
 */
export const MIN_HIGHLIGHT_VISIBILITY_CONTRAST = 1.8;

/**
 * 政治勢力ラベルの文字色を強調状態から決める（純粋関数、#267 AC5）。
 *
 * 通常はクリーム寄りの明色、強調（ホバー/クリック）中は純白。由来種別
 * （kind）では塗り分けない: TASK-30/71 の文字色による系統の記号は #267 で
 * 通常時の主表現から外し、表示階層はサイズ・halo・優先度で示すため。
 * どちらの状態でも判読は濃焦茶 halo（POLITICAL_LABEL_HALO_COLOR）が担う。
 */
export function politicalLabelColor(active: boolean = false): LabelColor {
  return active ? ACTIVE_POLITICAL_LABEL_COLOR : POLITICAL_LABEL_COLOR;
}

/**
 * 都市名ラベルの文字色（濃茶。TASK-27 から不変）。国名の濃グレー・
 * HRE 領邦の臙脂・河川の水色のいずれとも色相が離れており、クリーム halo 上で
 * 都市だと一見して区別できる。
 */
export const CITY_LABEL_COLOR: LabelColor = [121, 62, 22, 255];

/**
 * 河川名ラベルの常時表示（通常）色（暗青灰 #2a485c。TASK-123）。
 *
 * TASK-24〜69 の水色 #0277bd はホバー/選択時の強調色
 * （ACTIVE_RIVER_LABEL_COLOR）として残し、TASK-123 でズーム段による常時表示を
 * 戻すにあたり通常色を新設した。値の根拠:
 * - 河川ラインのホバー色 #4a6a7a（RIVER_HOVERED_LINE_COLOR）と同色相の青灰を
 *   さらに暗く沈めたインク。ライン（#94a8b0。Issue #225）と同じ
 *   「くすんだ水系の青」の
 *   系統に収まり、羊皮紙トーン（TASK-73）の上で騒がない。
 * - クリーム halo（LABEL_OUTLINE_COLOR）とのコントラスト比は約 8:1 で
 *   MIN_HALO_LABEL_CONTRAST（7:1）を満たす。旧水色 #0277bd は約 4:1 しかなく、
 *   一時的な注記なら許容できたが常時表示の判読基準には暗さが足りない。
 * - 国名の濃グレー [40,40,40]（無彩色）・HRE 領邦の臙脂（赤系）・仏諸侯領の
 *   藍紫（紫系）・都市の茶（橙系）・山脈の苔緑（緑系）のいずれとも色相が
 *   異なり、青が最大チャンネルの「水系」記号として一見して区別できる。
 */
export const RIVER_LABEL_COLOR: LabelColor = [42, 72, 92, 255];

/**
 * ホバー/クリック選択中の河川名ラベルの強調色（濃い水色 #0277bd。TASK-123）。
 * TASK-24 から河川ラベルの色として使われてきた値で、TASK-69（ホバー/選択時
 * のみ表示）の期間は事実上この色が唯一の表示色だった。常時表示（暗青灰）との
 * 差は「彩度と明るさ」で付け、強調中の河川ライン（濃青灰 #4a6a7a）の隣で
 * 発色して見えるようにする。名前は ACTIVE_*_LABEL_COLOR（TASK-93）の系列に
 * 揃えるが、他種別と違い「暗く沈める」のではなく従来の強調表示を維持する
 * （アクティブ塗りの上に載るラベルではないため、halo 基準は課さない）。
 */
export const ACTIVE_RIVER_LABEL_COLOR: LabelColor = [2, 119, 189, 255];

/**
 * 山脈名ラベルの文字色（深い苔緑 #35543F。TASK-97）。国名の濃グレー
 * [40,40,40]・HRE 領邦の臙脂・仏諸侯領の藍紫・都市の濃茶・河川の水色の
 * いずれとも色相が離れており、「地形の注記」だと一見して区別できる。
 * 緑はこの地図で唯一使われていない色相で、山地・自然物の記号としても素直。
 * クリーム halo（LABEL_OUTLINE_COLOR）に対するコントラスト比は約 7:1 で、
 * MIN_HALO_LABEL_CONTRAST と同水準（陰影の濃い山体の上でも輪郭が効く）。
 */
export const MOUNTAIN_LABEL_COLOR: LabelColor = [53, 84, 63, 255];

/**
 * 全 TextLayer（国名・HRE 領邦名・都市名・河川名）に共通のフォントスタック
 * （TASK-38 AC #2）。日本語ラベル（name-ja.json、TASK-23）と欧文ラベルの
 * 双方を高い可読性で描画できるよう、主要 OS の高品質な和文/欧文 sans-serif を
 * 優先し、最後に総称フォールバックを置く。deck.gl TextLayer は
 * CanvasRenderingContext2D でグリフを生成するため、CSS のフォントスタック
 * 文字列がそのまま使える。
 */
export const LABEL_FONT_FAMILY =
  '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", ' +
  '"Noto Sans JP", "Segoe UI", "Helvetica Neue", Arial, sans-serif';

/**
 * SDF フォントアトラスの radius（deck.gl fontSettings.radius。既定値と同じ 12 を
 * 明示する。TASK-72）。outlineWidth はこの値との比で正規化されるため、
 * 「outlineWidth の意味」を読み解くのに必須の値として定数化しておく。
 */
export const LABEL_SDF_RADIUS = 12;

/**
 * 全 TextLayer 共通の fontSettings（TASK-38 AC #1、TASK-72 で改訂）。
 * - sdf: true は outlineWidth/outlineColor（halo）の前提であり、既存の日本語
 *   グリフ対応（characterSet をラベル文字列から動的に導出する運用、TASK-23）
 *   とも両立する。
 * - buffer はフォントアトラス上のグリフ周囲の余白（px）で、halo が描ける幅の
 *   上限になる。deck.gl 既定の 4 では LABEL_OUTLINE_WIDTH 相当の halo が
 *   アトラスの外で切れるため 8 に広げる。字送り（グリフの配置間隔）には
 *   影響しない。
 * - smoothing は SDF のアンチエイリアス幅（gamma）であり、同時に
 *   outlineBuffer の下限でもある（max(smoothing, 0.75 * (1 - 正規化
 *   outlineWidth))）。TASK-38 で 0.15 にしていたが、これは halo を細らせる
 *   方向にしか効かないため既定の 0.1 に戻す。
 * - radius は既定値 12 の明示（LABEL_SDF_RADIUS）。
 */
export const LABEL_FONT_SETTINGS = {
  sdf: true,
  smoothing: 0.1,
  buffer: 8,
  radius: LABEL_SDF_RADIUS,
} as const;

/**
 * 全 TextLayer 共通のアウトライン（halo）色（TASK-38 AC #1、TASK-72 で改訂）。
 * 純白ではなく羊皮紙トーンのクリーム（app.css --parchment #f4ecd7 と同値）。
 * TASK-73 で地図の下地を羊皮紙（earth #f0e6cd）に寄せたため、純白 halo は
 * 地色から浮いて「白い縁取り」として目立ってしまう。クリームなら下地と
 * 連続して見えつつ、濃グレー/臙脂/茶/藍紫の文字色に対しては十分な明度差を
 * 保てる。背景パネル（TASK-54、TASK-72 で撤去）に代わる唯一のコントラスト
 * 確保手段になったため alpha は完全不透明にする。
 */
export const LABEL_OUTLINE_COLOR: LabelColor = [244, 236, 215, 255];

/**
 * 全 TextLayer 共通のアウトライン幅（TASK-38 AC #1、TASK-72 で改訂）。
 * **単位は px ではない**: deck.gl は outlineWidth を fontSettings.radius
 * （= LABEL_SDF_RADIUS）で割って正規化し、SDF の
 * outlineBuffer = max(smoothing, 0.75 * (1 - outlineWidth / radius)) として
 * 使う（@deck.gl/layers text-layer.js / multi-icon-layer.js）。
 * TASK-38 の値 2 は 14px 表示で halo 幅 0.3 CSS px 相当にしかならず、
 * 事実上描かれていなかった（TASK-72 の調査で判明。旧コメントの「px」は誤り）。
 * 5 は実測（ヘッドレス CDP スクリーンショット）で HRE 密集地帯でも背景パネル
 * 無しに判読できた値。9 まで上げると日本語ラベルが文字ごとの白ベタ矩形に
 * 潰れるため 5〜6 が実用上限（AC #3）。
 */
export const LABEL_OUTLINE_WIDTH = 5;

/**
 * SDF フォントアトラスのグリフ描画サイズ（px）。deck.gl の
 * DEFAULT_FONT_SETTINGS.fontSize と同値で、`fontSettings` では上書きしていない
 * （font-atlas-manager.js）。アトラス上の距離 1px は、画面上では
 * `getSize / SDF_ATLAS_FONT_SIZE_PX` CSS px に縮む。#308 の実効幅計算に使う。
 */
export const SDF_ATLAS_FONT_SIZE_PX = 64;

/**
 * SDF 上でグリフの輪郭を表す値（= 1 - cutoff 0.25。deck.gl multi-icon-layer.js
 * の DEFAULT_BUFFER と同値）。SDF の値はグリフ外側へ 1 アトラス px 進むごとに
 * `1 / radius` ずつ減るので、halo のしきい値 outlineBuffer との差
 * `(0.75 - outlineBuffer) * radius` がアトラス px 単位の halo 幅になる。#308。
 */
export const SDF_GLYPH_EDGE_VALUE = 0.75;

/**
 * `outlineWidth` が実際に何 CSS px の halo になるかを返す純粋関数（#308）。
 *
 * deck.gl の実装（@deck.gl/layers 9.3.7）をそのまま写したもの:
 * 1. text-layer.js が `outlineWidth / fontSettings.radius` へ正規化する
 * 2. multi-icon-layer.js が
 *    `outlineBuffer = max(smoothing, 0.75 * (1 - 正規化値))` を SDF の
 *    しきい値にする
 * 3. fragment shader は SDF 値が outlineBuffer 以上の画素を halo で塗る
 *
 * したがってアトラス上の halo 幅は `(0.75 - outlineBuffer) * radius`
 * （= smoothing で頭打ちする前は `0.75 * outlineWidth`）、画面上ではその
 * `fontSizePx / 64` 倍。**この関数があって初めて「halo が外枠として見えるか」を
 * 単体テストで固定できる**（props の色とコントラストだけでは太さの退行を
 * 検出できない、というのが #308 の指摘）。
 */
export function labelHaloWidthPx(
  outlineWidth: number,
  fontSizePx: number,
  fontSettings: { radius?: number; smoothing?: number } = LABEL_FONT_SETTINGS,
): number {
  if (outlineWidth <= 0) return 0;
  // deck.gl の既定値（DEFAULT_FONT_SETTINGS.radius / MultiIconLayer.smoothing）へ
  // フォールバックする。TextLayer の props をそのまま渡して実効幅を測れるよう、
  // 省略可能なフィールドを受け取る（#322 の配線テストが layer.props を渡す）。
  const radius = fontSettings.radius ?? LABEL_SDF_RADIUS;
  const smoothing = fontSettings.smoothing ?? 0.1;
  const normalized = outlineWidth / radius;
  const outlineBuffer = Math.max(
    smoothing,
    SDF_GLYPH_EDGE_VALUE * (1 - normalized),
  );
  const atlasPx = Math.max(0, SDF_GLYPH_EDGE_VALUE - outlineBuffer) * radius;
  return atlasPx * fontSizePx / SDF_ATLAS_FONT_SIZE_PX;
}

/**
 * 政治勢力ラベル専用の SDF フォントアトラス設定（#322。候補A の実体）。
 *
 * ## なぜ専用設定が要るのか（#308 が閉じなかった理由）
 *
 * 共通 {@linkcode LABEL_FONT_SETTINGS}（smoothing 0.1 / buffer 8 / radius 12）
 * のままでは、`outlineWidth` をいくら上げてもアトラス上の halo は
 * `(0.75 - smoothing) * radius = 7.8` atlas px で頭打ちになり、14px ラベルでは
 * `7.8 * 14 / 64 ≈ 1.71` CSS px が上限になる。#308 の `outlineWidth = 9`
 * （実効 1.48 CSS px）は既にその近傍で、幅の再調整では「一見して明確な外枠」に
 * 届かない。加えて `buffer = 8` を超える halo はグリフ端でクリップされる。
 *
 * ## 値の根拠（#322 の実測。ヘッドレス CDP スクリーンショット）
 *
 * - `radius: 24`: halo のしきい値 `outlineBuffer = 0.75 * (1 - width/radius)` が
 *   smoothing 下限に張り付かないための余裕。width 12 では 0.375 で、下限
 *   （0.05）から十分離れる。**radius 自体は halo の太さを変えない**
 *   （太さは `0.75 * outlineWidth` atlas px）。効くのは「頭打ちまでの余裕」。
 * - `smoothing: 0.05`: smoothing は SDF のしきい値の下限であると同時に
 *   アンチエイリアス幅（gamma）でもあり、アトラス px 換算では
 *   `smoothing * radius`。radius を 12 → 24 にした分だけ 0.1 → 0.05 へ下げ、
 *   字面とアウトラインのぼけ幅（2.4 atlas px）を共通設定と同一に保つ。
 *   下げ忘れると halo の外縁が 2 倍にぼけ、太くしても輪郭が締まらない。
 * - `buffer: 11`: アトラス上の halo `0.75 * 12 = 9` px にアンチエイリアスの裾
 *   `smoothing * radius = 1.2` px を足した 10.2 px を収める最小の整数
 *   （足りないとグリフ端で halo が切れる）。12 以上にするとグリフの升目が
 *   1 行あたり 1 文字減り、アトラス canvas の高さが 2 の冪で 1024 → 2048 へ
 *   跳ねる（実測: 4.2MB → 8.4MB）。11 なら 1024x1024 に収まり、共通アトラスと
 *   同じ 4.2MB で済む。
 *
 * ## 代償（許容する）
 *
 * フォントアトラスのキャッシュキーは fontFamily / fontWeight / fontSize /
 * buffer / radius / cutoff（font-atlas-manager.ts `_getKey`）なので、この層は
 * 注記ラベルとは**別のアトラス**を持つ。実測（1600x900 / DPR 1、1100 年 z5）:
 * アトラス canvas +1 枚・1024x1024・約 4.2MB、初回ロードの long task 合計
 * 677ms → 690ms（+2%）、年代切替の long task 合計 480ms → 476ms（差なし）、
 * 定常フレーム間隔は両者とも中央値 16.7ms（60fps 上限）で退行なし。
 */
export const POLITICAL_LABEL_FONT_SETTINGS = {
  sdf: true,
  smoothing: 0.05,
  buffer: 11,
  radius: 24,
} as const;

/**
 * 政治ラベルの描画グループ（#333 AC3）。
 *
 * `tier` は 3 値（top / constituent / sub）だが、描画スタイルを分ける単位は
 * 「上位国名（top）」と「それ以外（constituent / sub）」の 2 つで足りる:
 * - #333 修正方針 2 が求めるのは「**少なくとも上位国名**は専用スタイルを持ち、
 *   12px の下位ラベルを潰さないための上限に縛られないこと」。
 * - constituent（14px）と sub（12px）は 2px 差で、halo の実効 CSS px は
 *   getSize に比例する（{@linkcode labelHaloWidthPx}）ため同一 outlineWidth で
 *   同じ視覚文法に収まる。
 *
 * グループは TextLayer の分割単位でもある（political_layers.ts
 * buildLabelLayer）。`outlineWidth` / `backgroundPadding` /
 * `backgroundBorderRadius` は deck.gl では**レイヤー単位の props で accessor に
 * できない**ため、階層別に変えるにはレイヤーを分ける以外の方法が無い。
 * 1 つの datum は必ずどちらか一方のレイヤーにしか入らない（#322 が棄却した
 * 二重 TextLayer と決定的に違う点）ので、同一アンカーで自己衝突することは
 * 構造的に起こらない（#333 AC8）。
 */
export type PoliticalLabelGroup = "top" | "lower";

/** 表示階層から描画グループを決める（純粋関数、#333 AC3） */
export function politicalLabelGroupOf(
  tier: PoliticalTier,
): PoliticalLabelGroup {
  return tier === "top" ? "top" : "lower";
}

/** datum を描画グループで振り分ける（純粋関数、#333 AC3/AC8） */
export function filterPoliticalLabelsByGroup(
  data: readonly LabelDatum[],
  group: PoliticalLabelGroup,
): LabelDatum[] {
  return data.filter((d) => politicalLabelGroupOf(labelTierOf(d)) === group);
}

/**
 * 政治ラベルの「下支え」（文字列単位の濃色プレート）の塗り色
 * （#333 AC2/AC4。参考画像 docs/images/issue333-label-reference/ の実測由来。
 * 測定手順と生の数値は docs/research/issue-333-label-reference-targets.md）。
 *
 * ## なぜ「見える背景」を復活させるのか（TASK-72 との関係）
 *
 * TASK-72 が撤去したのは **クリーム #f4ecd7 を alpha 200 で敷いた明色のベタ
 * 矩形**で、ユーザー報告の言葉は「白枠として目立ちすぎる」だった。禁止の趣旨は
 * 「ラベルの周りに明るい板を置いて地図を分断しないこと」であり、「文字列の背後を
 * 一切暗くしてはならない」ではない。参考画像（案A・#228/#267 で導入し #333 が
 * 完成見本として規範化）は、**濃色を薄く敷いた角丸プレート**を全ラベルに
 * 持っている。明暗が逆で、濃度も 1/3 以下（後述の実測 alpha）である。
 *
 * TASK-72 のもう 1 つの含意「halo 一本化」は #333 修正方針 3 が明示的に
 * 上書きしている（「TASK-72 の『見える背景パネル禁止』は注記ラベル全体の過去
 * 要件であり、本件の政治ラベル完成見本より優先する前提にしない」）。なお
 * **注記ラベル（都市・河川・山岳・山峰）は TASK-72 のまま**で、プレートを持つのは
 * 政治ラベル 2 層だけ（#333 AC9）。共通スタイル
 * {@linkcode labelTextStyleProps} の `background: false` も不変で、TASK-143 の
 * 不可視衝突クアッド（{@linkcode LABEL_COLLISION_BACKGROUND_COLOR}）を政治ラベル層
 * だけが「見えるプレート」に差し替える形を取る。したがって描画要素は増えず、
 * 衝突判定・priority・anchor・表示/非表示は TextLayer の background サブレイヤーと
 * characters サブレイヤーが同一データ・同一 accessor を共有する既存の仕組みで
 * そのまま同期する（#333 AC8）。
 *
 * ## 値の根拠（参考画像の実測）
 *
 * 参考画像（1412x1114）の「神聖ローマ帝国」「ポーランド」のプレート内側と
 * 隣接する同一領土色の外側を比べ、`inside = α·C + (1-α)·outside` を C =
 * #3a2712（{@linkcode POLITICAL_LABEL_HALO_COLOR} と同値）として解くと
 * α = 0.219 / 0.206 / 0.242（HRE、RGB 各チャンネル）、0.192 / 0.200 / 0.244
 * （ポーランド）。明色領土（ポーランドの淡橙）でも濃色領土（HRE の苔緑）でも
 * 同じ α に落ちるので、参考画像のプレートは**乗算ではなく一定 alpha の
 * 濃色オーバーレイ**である。採る値は 56/255 ≈ 0.22。
 */
export const POLITICAL_LABEL_PLATE_COLOR: LabelColor = [58, 39, 18, 56];

/**
 * 政治ラベルのプレートの縁色（#333 AC2）。共通クリーム halo と同じ
 * {@linkcode LABEL_OUTLINE_COLOR} #f4ecd7 を半透明で 1px 入れる。
 *
 * 参考画像の実測: プレート外周 2px に明色の帯があり、外側の地色に対する
 * クリーム比率は外側の画素で 0.33、内側の画素で 0.22（合計 ≈ 0.55 px·α）。
 * 1px の縁を alpha 128（0.50）で引くとこれにほぼ一致する。プレートを
 * 「にじんだ影」ではなく「意図して置かれた札」に見せているのがこの縁で、
 * 羊皮紙トーンの地図（TASK-73）にも凡例枠と同じ語彙で馴染む。
 *
 * TASK-72 が撤去した明色パネルとの違いは面積と濃度: あちらはラベル全面を
 * alpha 200 のクリームで塗っていたが、こちらは輪郭 1px を alpha 128 で
 * なぞるだけで、内側は {@linkcode POLITICAL_LABEL_PLATE_COLOR} の濃色である。
 */
export const POLITICAL_LABEL_PLATE_BORDER_COLOR: LabelColor = [
  244,
  236,
  215,
  128,
];

/** プレートの縁の太さ（CSS px、#333 AC2。参考画像の実測 ≈ 1px） */
export const POLITICAL_LABEL_PLATE_BORDER_WIDTH_PX = 1;

/**
 * 政治ラベル 1 グループ分の描画スタイル（#333 AC3）。
 *
 * `outlineWidth` / `padding` / `borderRadiusPx` は deck.gl TextLayer の
 * **レイヤー単位 props**（accessor 不可）で、ここを階層別に持てるように
 * したことが #333 の構造上の要点。色（plate*）は accessor 化できるが、
 * 「グループのスタイルは 1 か所を見れば全部わかる」ようにここへ揃える。
 */
export interface PoliticalLabelStyle {
  /** SDF halo の幅（px ではなく radius 比。labelHaloWidthPx で実効 px にする） */
  readonly outlineWidth: number;
  /** プレートの塗り色 */
  readonly plateColor: LabelColor;
  /** プレートの縁色 */
  readonly plateBorderColor: LabelColor;
  /** プレートの縁の太さ（CSS px） */
  readonly plateBorderWidthPx: number;
  /** プレートの余白 [left, top, right, bottom]（CSS px。文字ボックスの外側） */
  readonly platePadding: readonly [number, number, number, number];
  /** プレートの角丸（CSS px） */
  readonly plateBorderRadiusPx: number;
}

/**
 * 描画グループ別の政治ラベルスタイル（#333 AC2/AC3）。
 *
 * ## 参考画像から読み取った目標値（正規化 = フォントサイズ比）
 *
 * 参考画像のラベルは CJK の送り幅からフォントサイズを逆算できる（等幅送り）。
 * 「神聖ローマ帝国」7 字 = 139px → 約 20px、「ノルマンディー公領」9 字 = 138px
 * → 約 15.3px。この 2 つを top / constituent の代表として測ると:
 *
 * | 項目 | 参考画像の実測 | 正規化 |
 * | --- | --- | --- |
 * | 文字の濃色外縁 | 1.0〜1.5 CSS px（20px の字でも 15px の字でもほぼ一定） | 0.065 em（top） / 0.078 em（constituent） |
 * | プレート高 | 32px（フォント 20px） | 1.60 × フォントサイズ |
 * | プレート左右余白 | 5〜7px | 0.275 em |
 * | プレート角丸 | 5〜6px | 0.28 em |
 *
 * **#322 との決定的な違いはここにある。** #322 は halo の実効幅を 14px ラベルで
 * 1.97 CSS px（0.14 em）まで広げたが、参考画像の外縁は 0.065〜0.078 em しか
 * なく、代わりに濃色プレートが「地色からの分離」を担っている。外縁だけで
 * 分離しようとすると 12px ラベルのカウンターが潰れる（#322 が実測した上限）
 * ——つまり **#322 が避けた「暗い板」こそが参考画像の主要素**で、外縁は
 * それより細い。#267 / #308 / #322 が参考画像に届かなかった構造的な理由が
 * これである。
 *
 * ## 実装値
 *
 * `labelHaloWidthPx(outlineWidth, size, POLITICAL_LABEL_FONT_SETTINGS)` は
 * `0.75 * outlineWidth * size / 64` なので、目標 em から
 * `outlineWidth = 目標em * 64 / 0.75` で逆算する。
 *
 * | グループ | サイズ | outlineWidth | 実効 halo | 参考画像 |
 * | --- | --- | --- | --- | --- |
 * | top | 18px（概観） | 6 | 1.27 px | 1.3 px（20px の字） |
 * | top | 16px（中間・詳細） | 6 | 1.13 px | 1.04 px 相当 |
 * | lower | 14px（constituent） | 7 | 1.15 px | 1.10 px 相当 |
 * | lower | 12px（sub） | 7 | 0.98 px | 0.94 px 相当 |
 *
 * **lower の方が outlineWidth が大きい**のは誤りではない: 参考画像の外縁は
 * 絶対幅がほぼ一定（≈1.2px）で、小さい字ほどフォントサイズ比では太い。
 * deck.gl の実効 halo はサイズ比例なので、同じ絶対幅を保つには小さい側の
 * 係数を上げる必要がある。**同一 outlineWidth では両立しない**——これが
 * #333 AC3「top を constituent / sub と独立して調整できる構造」の実体であり、
 * 12px のカウンター潰れ上限（#322 実測で outlineWidth 13 相当 = 2.13 CSS px）は
 * どちらのグループにも掛からない位置に両方が収まっている。
 *
 * 余白・角丸も同様にサイズ比 0.28〜0.3 em を代表サイズで丸めた整数 px
 * （deck.gl の `backgroundPadding` / `backgroundBorderRadius` は CSS px 固定で
 * getSize に比例しないため、グループの代表サイズで決める）。
 */
export const POLITICAL_LABEL_STYLES: Record<
  PoliticalLabelGroup,
  PoliticalLabelStyle
> = {
  top: {
    outlineWidth: 6,
    plateColor: POLITICAL_LABEL_PLATE_COLOR,
    plateBorderColor: POLITICAL_LABEL_PLATE_BORDER_COLOR,
    plateBorderWidthPx: POLITICAL_LABEL_PLATE_BORDER_WIDTH_PX,
    platePadding: [5, 5, 5, 5],
    plateBorderRadiusPx: 5,
  },
  lower: {
    outlineWidth: 7,
    plateColor: POLITICAL_LABEL_PLATE_COLOR,
    plateBorderColor: POLITICAL_LABEL_PLATE_BORDER_COLOR,
    plateBorderWidthPx: POLITICAL_LABEL_PLATE_BORDER_WIDTH_PX,
    platePadding: [4, 4, 4, 4],
    plateBorderRadiusPx: 4,
  },
};

/** 描画グループのスタイルを返す（純粋関数、#333 AC3） */
export function politicalLabelStyleFor(
  group: PoliticalLabelGroup,
): PoliticalLabelStyle {
  return POLITICAL_LABEL_STYLES[group];
}

/**
 * 国名・HRE 領邦名ラベルのサイズ（px）。従来 13px から 14px へ（TASK-38 AC #2）。
 * +1px 程度の控えめな引き上げに留め、CollisionFilterExtension による
 * ラベル間引き（sizeScale: 2 の衝突判定）への影響を小さくする。
 */
export const POWER_LABEL_SIZE_PX = 14;

/**
 * 概観表示（z4、politicalDetailVisibleAt が false の段）での国名ラベルの
 * サイズ（px）（#228 AC3）。
 *
 * 値 18 の根拠: 概観は「上位勢力名だけ」を出す段（filterPowerLabelsByZoom が
 * kind=base に絞る）で、詳細表示のような密集がなく衝突制御
 * （COLLISION_SIZE_SCALE 倍判定）に余裕がある。POWER_LABEL_SIZE_PX(14) の
 * 約 1.3 倍で「一段大きい」ことがひと目で分かり、かつ河川・都市ラベル
 * （12px）との階層差を保ったまま halo（LABEL_OUTLINE_WIDTH）が SDF radius
 * （LABEL_SDF_RADIUS）に対して破綻しない範囲に収まる。20px 以上にすると
 * 小勢力（アイルランド諸王国など）のラベルが自国のポリゴンから大きく
 * はみ出すため採らない。
 */
export const OVERVIEW_POWER_LABEL_SIZE_PX = 18;

/**
 * 中間・詳細表示（z5〜8）での上位勢力（tier "top"）ラベルのサイズ（px）
 * （#267 AC6/AC9）。
 *
 * 値 16 の根拠: 構成勢力の 14px（POWER_LABEL_SIZE_PX）に対して +2px で
 * 「一段上の階層」がひと目で分かり、かつ概観の 18px
 * （OVERVIEW_POWER_LABEL_SIZE_PX）より控えめにして詳細ズームで領邦ラベルの
 * 密集を圧迫しない。詳細表示でも上位勢力名がこのサイズ + 最優先の衝突帯
 * （tieredLabelPriority の top 帯）で残るため、個別領邦の中に埋没しない。
 */
export const TOP_POWER_LABEL_SIZE_PX = 16;

/**
 * 下位境界単位（tier "sub"）ラベルのサイズ（px）（#267 AC6）。
 * 構成勢力（14px）よりさらに一段小さく、河川・都市の注記（12px）と同じ
 * 大きさに置く。現行データに sub 階層の feature は無い（politicalOverlayTier
 * のフォールバック仕様どおり全て constituent になる）が、構造が宣言された
 * データが入った時に階層差が自動で付くよう定義しておく。
 */
export const SUB_POWER_LABEL_SIZE_PX = 12;

/**
 * 政治勢力ラベルのサイズを階層 × 表示レベルから決める（純粋関数、#267 AC6）。
 * - top: 概観 18px（上位勢力名だけの段。#228 の値を維持）/ 中間・詳細 16px
 * - constituent: 14px（従来の勢力ラベルサイズ）
 * - sub: 12px
 * 概観では top 以外のラベルは表示されない（filterPowerLabelsByZoom）ため、
 * top 以外へのレベル依存は持たせない。
 */
export function powerLabelSizePx(
  tier: PoliticalTier,
  level: PoliticalDisplayLevel,
): number {
  if (tier === "top") {
    return level === "overview"
      ? OVERVIEW_POWER_LABEL_SIZE_PX
      : TOP_POWER_LABEL_SIZE_PX;
  }
  return tier === "sub" ? SUB_POWER_LABEL_SIZE_PX : POWER_LABEL_SIZE_PX;
}

/**
 * 政治ラベル 1 種（階層 × 表示レベル）の**実際に画面へ出る寸法**（#333 AC12）。
 *
 * props の値（outlineWidth = 6 など）は deck.gl の正規化を通らないと画面上の
 * 太さにならないため、それ単体を固定しても「参考画像と同じに見えるか」は
 * 守れない（#308 / #322 が数値だけ動かして参考画像に届かなかった原因）。
 * この構造体は props ではなく **CSS px の実寸**を並べ、
 * {@linkcode politicalLabelRenderSpecTable} が全 4 種の一覧を返すことで
 * 「固定標本の出力」をテストで丸ごと突き合わせられるようにする。
 */
export interface PoliticalLabelRenderSpec {
  readonly tier: PoliticalTier;
  readonly level: PoliticalDisplayLevel;
  readonly group: PoliticalLabelGroup;
  /** 文字サイズ（CSS px） */
  readonly fontSizePx: number;
  /** 濃色外縁の実効幅（CSS px。labelHaloWidthPx に専用 fontSettings を適用） */
  readonly haloPx: number;
  /** 下支えプレートの高さ（CSS px。文字ボックス = fontSizePx + 上下余白） */
  readonly plateHeightPx: number;
  /** 下支えプレートの水平余白（CSS px、片側） */
  readonly platePaddingXPx: number;
  /** 下支えプレートの角丸（CSS px） */
  readonly plateBorderRadiusPx: number;
  /** 下支えプレートの塗り alpha（0..255） */
  readonly plateAlpha: number;
}

/** 政治ラベル 1 種の実寸を返す（純粋関数、#333 AC12） */
export function politicalLabelRenderSpec(
  tier: PoliticalTier,
  level: PoliticalDisplayLevel,
): PoliticalLabelRenderSpec {
  const group = politicalLabelGroupOf(tier);
  const style = politicalLabelStyleFor(group);
  const fontSizePx = powerLabelSizePx(tier, level);
  const [padLeft, padTop, , padBottom] = style.platePadding;
  return {
    tier,
    level,
    group,
    fontSizePx,
    haloPx: Number(
      labelHaloWidthPx(
        style.outlineWidth,
        fontSizePx,
        POLITICAL_LABEL_FONT_SETTINGS,
      ).toFixed(2),
    ),
    plateHeightPx: fontSizePx + padTop + padBottom,
    platePaddingXPx: padLeft,
    plateBorderRadiusPx: style.plateBorderRadiusPx,
    plateAlpha: style.plateColor[3],
  };
}

/**
 * 画面に現れる政治ラベルの全 4 種（top 概観 18px / top 中間・詳細 16px /
 * constituent 14px / sub 12px）の実寸一覧（#333 AC12 の固定標本）。
 *
 * overview では constituent / sub が表示されない（filterPowerLabelsByZoom）
 * ため、その組み合わせは含めない。
 */
export function politicalLabelRenderSpecTable(): PoliticalLabelRenderSpec[] {
  return [
    politicalLabelRenderSpec("top", "overview"),
    politicalLabelRenderSpec("top", "detail"),
    politicalLabelRenderSpec("constituent", "detail"),
    politicalLabelRenderSpec("sub", "detail"),
  ];
}

/**
 * 河川名ラベルのサイズ（px）。従来 11px から 12px へ（TASK-38 AC #2）。
 * 国名ラベル（14px）より小さいままとし、既存の「注記」としての位置づけを保つ。
 */
export const RIVER_LABEL_SIZE_PX = 12;

/**
 * 都市名ラベルのサイズ（px）。従来 11px から 12px へ（TASK-38 AC #2）。
 * 国名ラベル（14px）より小さいままとし、既存の視覚的な階層を保つ。
 */
export const CITY_LABEL_SIZE_PX = 12;

/**
 * 山脈名ラベルのサイズ（px）（TASK-97）。国名ラベル（14px）より小さく、
 * 河川名・都市名（12px）と同じ「注記」の階層に置く。山脈は広い面を持つが、
 * この地図の主題は勢力・都市なので文字サイズでは主張させない。
 */
export const MOUNTAIN_LABEL_SIZE_PX = 12;

/** 全 TextLayer 共通のフォントウェイト（TASK-38 以来の semi-bold） */
export const LABEL_FONT_WEIGHT = 600;

/**
 * 全 TextLayer（国名・HRE 領邦名・仏諸侯領名・都市名・河川名）で共通の
 * 描画スタイル props（TASK-72）。deck.gl 非依存な純粋関数で、main.ts の
 * labelLayerBaseProps がこれを展開して TextLayer に渡す。
 *
 * background: false が要点（AC #1）。TASK-54 で導入した半透明の背景パネル
 * （白枠に見えていたもの）は撤去し、可読性の確保は halo
 * （LABEL_OUTLINE_WIDTH / LABEL_OUTLINE_COLOR）に一本化する。deck.gl の
 * background は既定で false だが、「意図して持たない」ことをテストで固定
 * できるよう明示的に false を返す。
 *
 * 配列（outlineColor）は呼び出しごとに複製して返し、deck.gl にモジュール
 * 定数の参照をそのまま渡さない。
 */
export function labelTextStyleProps(): {
  fontFamily: string;
  fontWeight: number;
  fontSettings: typeof LABEL_FONT_SETTINGS;
  outlineWidth: number;
  outlineColor: number[];
  background: false;
} {
  return {
    fontFamily: LABEL_FONT_FAMILY,
    fontWeight: LABEL_FONT_WEIGHT,
    fontSettings: LABEL_FONT_SETTINGS,
    outlineWidth: LABEL_OUTLINE_WIDTH,
    outlineColor: [...LABEL_OUTLINE_COLOR],
    background: false,
  };
}

/**
 * 全ラベル層共通の衝突用背景クアッド色（ほぼ不可視の alpha 1。TASK-143）。
 *
 * CollisionFilterExtension の可視判定は「衝突 FBO 上の自アンカー画素
 * （±2px の 5x5 サンプル）が自分の描画で占められているか」を見るが、
 * TASK-72 で背景パネルを撤去して以降、背景の無い TextLayer は衝突 FBO に
 * グリフの字形しか残さない（SDF 透明部は picking 系シェーダの alpha==0
 * discard で描かれない）。そのためアンカーがグリフの空白に落ちるラベルは
 * **自分自身の可視判定に永遠に失敗して一度も描画されない**。該当するのは
 * - 偶数文字数でテキスト中央が文字間空白になるもの（TASK-136 の「ライン川」
 *   = イ|ン 境界。都市の「ルーアン」「カイセリ」「メス」、勢力の
 *   「ボヘミア王国」= ミ|ア 境界など）
 * - 中央の文字が「ー」「・」でアンカー行にインクが無いもの（都市の
 *   「ローマ」「ボローニャ」「ヴェリコ・タルノヴォ」など。都市・山峰は
 *   getPixelOffset で文字列がアンカーの上へずれるため、アンカー行は
 *   グリフ下部にあたり「ー」の横棒から外れる）
 * TASK-143 の実機監査（1000/1200/1300 × z4〜z7 の 106 ビュー、色検出 +
 * 目視）で 11 件が該当した。
 *
 * 対策は TASK-136 が河川層で実証したものの一般化: TextLayer の background を
 * 有効化し、テキスト矩形を埋める背景クアッドを衝突 FBO の実体にする。alpha は
 * 0 だと上記の discard で FBO に描かれないため、目視では識別不能な 1 を使う。
 * 矩形は従来のグリフ描画を包む範囲なので、他ラベルとの衝突関係は「字形の
 * 隙間頼み」がなくなる方向にのみ変わる。実機 before/after 比較
 * （1000/1200/1300 × z4〜z7 の 69 ビュー、色検出 + 目視）では、被疑 11 件が
 * 全て描画されるようになる一方、表示ラベル総数はほぼ全ビューで同数以上
 * （増加最大 +5、減少は 4 ビューで各 -1）。相手の字形の隙間に偶然頼って
 * 出ていた低優先ラベル（z4 のライン川 1300・ポルトガル 1300 等 17 ビュー
 * ケース）は優先度どおり間引かれるようになるが、いずれも隣接ズーム段では
 * 表示されることを確認済み。
 */
export const LABEL_COLLISION_BACKGROUND_COLOR: LabelColor = [0, 0, 0, 1];

/**
 * 衝突参加の全ラベル TextLayer に敷く不可視背景クアッドの props（純粋関数、
 * TASK-143）。main.ts の labelLayerBaseProps が CollisionFilterExtension と
 * 組で展開する（背景クアッドは衝突 FBO の実体を作る対策なので、衝突に参加
 * しない層 = 山峰マーカー ▲ には敷かない）。
 *
 * labelTextStyleProps（background: false）と分けるのは、TASK-72 の「見える
 * 背景パネルは持たない」という描画スタイルの契約を保ったまま、衝突対策の
 * 不可視クアッドだけを追加するため。スプレッド順は必ずこちらを後にする。
 *
 * 配列（getBackgroundColor）は呼び出しごとに複製して返し、deck.gl に
 * モジュール定数の参照をそのまま渡さない。
 */
export function labelCollisionBackgroundProps(): {
  background: true;
  getBackgroundColor: number[];
} {
  return {
    background: true,
    getBackgroundColor: [...LABEL_COLLISION_BACKGROUND_COLOR],
  };
}

/**
 * CollisionFilterExtension の collisionTestProps.sizeScale（TASK-54 案B、
 * TASK-72 で再調整）。衝突判定領域を実表示より広く取ることで、ケルン
 * 大司教領・ザクセン選帝侯領/公領のような密集地帯で下位優先のラベルを
 * より積極的に間引く。
 *
 * TASK-54 では 2（TASK-20 以来）→ 2.6 へ引き上げたうえで、背景パネルの
 * padding（[3, 2]px、sizeScale で拡大されない実 px）も衝突箱に加算されて
 * いた。TASK-72 でパネルを撤去した分だけ箱が縮むため 2.8 に引き上げて補う
 * （14px・6 文字程度のラベルで、旧「2.6 倍 + padding」の箱とほぼ等価）。
 * 3 以上にするとズーム 5〜6 の全体観で中小勢力ラベルが消えすぎる。
 * 国名/HRE 領邦・仏諸侯領・河川・都市の全 TextLayer が共有する衝突空間で
 * 共通に使う（priority 設計は不変: 国名の面積 > 都市の人口バンド > 河川の
 * ライン長）。
 */
export const COLLISION_SIZE_SCALE = 2.8;

/**
 * z4 の上位勢力名だけに使う衝突判定倍率（#407）。
 *
 * 通常の 2.8 は z5 以降の領邦密集表示を間引くための余白で、18px の国名だけに
 * なる z4 へそのまま適用すると、1880 年の Germany と Netherlands のように
 * 実表示間には十分な間隔があるラベルまで衝突扱いになる。2.0 は同条件の
 * 決定的シミュレーションで両方を残しつつ、実表示の 1.5 倍の余白を保つ。
 */
export const OVERVIEW_TOP_LABEL_COLLISION_SIZE_SCALE = 1.5;

/**
 * 衝突フェードの二値化 GLSL を差し込むシェーダフック（TASK-108）。
 *
 * 色（vs:DECKGL_FILTER_COLOR）ではなく頂点位置のフックを使うのが要点。
 * TextLayer の SDF フラグメントシェーダは
 * `color = mix(sdf.outlineColor, vColor, inFill)` として halo 部分の alpha を
 * **outlineColor 側**（LABEL_OUTLINE_COLOR の alpha = 255）から取るため、
 * vColor.a を 0 にしてもクリーム色の輪郭だけが不透明のまま残る。これが
 * TASK-108 の「文字が消えて白っぽい輪郭だけ残る」の正体なので、消すときは
 * ジオメトリごとクリップ空間の外へ飛ばす必要がある。
 */
export const LABEL_COLLISION_INJECT_HOOK = "vs:DECKGL_FILTER_GL_POSITION";

/**
 * 衝突フェード cutoff の下限（TASK-108）。@deck.gl/extensions 9.3.7 の
 * collision モジュールが自前でジオメトリを捨てる閾値（collision_fade < 0.0001）
 * と同値。これ未満に設定しても deck.gl 既定の挙動と区別が付かないため、
 * ここでクランプして「二値化が効いていないのに効いているつもり」を防ぐ。
 */
export const MIN_LABEL_COLLISION_FADE_CUTOFF = 0.0001;

/**
 * 衝突フェードを二値化する閾値（TASK-108）。
 *
 * `CollisionFilterExtension` は衝突判定を 0/1 ではなく
 * `pow(アンカー近傍 5x5 px の一致率, 2.2)` の連続値（collision_fade）で返し、
 * それを色の alpha に乗算する（ちらつき低減のための意図的なフェード）。
 * 優先度の高いラベルの衝突ボックスがアンカー近傍を部分的に覆っている
 * **静止状態**では、負けた側がこの中途半端な alpha で描かれ続ける。
 *
 * 0.5 は `pow(x, 2.2)` の圧縮を戻すと生の一致率 約 0.73 に相当する
 * （0.5 ** (1/2.2) ≈ 0.729）。アンカー近傍 25 px のうち 19 px 以上を自分で
 * 取れていれば残す、という水準。完全勝利（一致率 1.0 → fade 1.0）のラベルは
 * 必ず残るので、衝突していないラベルの表示は従来と変わらない（AC #4）。
 * priority 設計・COLLISION_SIZE_SCALE には一切触れないため、層をまたいだ
 * 相対的な表示優先も従来どおり（AC #5）。
 *
 * 実機（1400 / 1492 × zoom 5.5 / 6.5 / 7.5、北ドイツ）で 0.25 も試した。
 * 0.25 ではさらに 3 件（トルン帝国修道院領・ハノーファー・リューベック）が
 * 不透明で残り、いずれも重なりは起きなかった。一方で、本当に潰れていた
 * ゴースト（ホルシュタイン＝ピンネベルク伯領など）は全て fade < 0.25 で、
 * どちらの値でも同じく消える。つまり 0.25〜0.5 の帯は「衝突ボックス
 * （2.8 倍）の縁がアンカーを掠めただけで、実グリフは離れている」ケースに
 * 対応する。差が小さい以上、未検証のビューで「実際に重なるラベルを
 * 不透明で復活させる」危険が小さい 0.5 を採る。緩めたいときはこの定数を
 * 下げれば足りる（GLSL 側は 1 箇所で参照している）。
 */
export const LABEL_COLLISION_FADE_CUTOFF = 0.5;

/**
 * 数値を GLSL の float リテラル文字列にする。整数値でも小数点を必ず含める
 * （`collision_fade < 1` は float と int の比較になりコンパイルできない）。
 */
function glslFloat(n: number): string {
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

/**
 * 衝突フェードを二値化する GLSL inject を組み立てる（純粋関数、TASK-108）。
 *
 * `collision` シェーダモジュールが `collision_fade` を計算した**後**に走る前提で、
 * - cutoff 未満: クリップ空間の外へ飛ばして完全に消す（halo ごと消える）
 * - cutoff 以上: `collision_fade` を 1.0 に戻し、後段の
 *   `color.a *= collision_fade` を無効化して本来の不透明度で描く
 * のいずれかに倒す。「読める」か「出ない」かの二択になり、中途半端に潰れた
 * 半透明ゴーストが残らない（AC #1〜#3）。
 *
 * `collision.enabled` が false のとき（衝突マップ描画パス）は何もしない。
 * 衝突マップは従来どおり全ラベルのボックスを priority 順に描くので、
 * どのラベルが勝つかの判定自体は一切変えていない。
 *
 * cutoff は (MIN_LABEL_COLLISION_FADE_CUTOFF, 1] にクランプし、非有限値は
 * 既定値へフォールバックする。
 */
export function labelCollisionCutoffInject(
  cutoff: number = LABEL_COLLISION_FADE_CUTOFF,
): Record<typeof LABEL_COLLISION_INJECT_HOOK, string> {
  const raw = Number.isFinite(cutoff) ? cutoff : LABEL_COLLISION_FADE_CUTOFF;
  const clamped = Math.min(1, Math.max(MIN_LABEL_COLLISION_FADE_CUTOFF, raw));
  return {
    [LABEL_COLLISION_INJECT_HOOK]: `
  // TASK-108: collision_fade（0..1 の連続値）を二値化し、半透明ゴーストを無くす
  if (collision.enabled) {
    if (collision_fade < ${glslFloat(clamped)}) {
      position = vec4(0.0, 0.0, 2.0, 1.0);
      collision_fade = 0.0;
    } else {
      collision_fade = 1.0;
    }
  }
`,
  };
}

/** properties から文字列プロパティを取り出す。空文字・非文字列は null */
function stringProp(props: GeoJsonProperties, key: string): string | null {
  const v = props?.[key];
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * 地図上の常時ラベルのテキストを返す（純粋関数）。NAME のみ。
 * NAME が無い（null・空・非文字列）feature は null（ラベルを出さない）。
 *
 * TASK-23: ja（英語 NAME → 日本語名のフラットマップ、name-ja.json）を渡すと
 * 日本語表記を返す。ja に無い NAME は英語のままフォールバックし、省略時
 * （空マップ）は従来どおり NAME を返す。
 */
export function labelTextFor(
  props: GeoJsonProperties,
  ja: Record<string, string> = {},
): string | null {
  const name = stringProp(props, "NAME");
  if (name === null) return null;
  return ja[name] ?? name;
}

/** 外環リングの近似面積（shoelace、座標系の単位²）。閉環前提 */
function ringArea(ring: Position[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(sum) / 2;
}

/**
 * feature から最大ポリゴン（外環の近似面積が最大）のリング一覧を返す。
 * Polygon はそのまま、MultiPolygon は面積最大の要素を選ぶ。
 * Polygon/MultiPolygon 以外・空・面積 0 の退化形は null。
 */
function largestPolygonRings(feature: Feature): Position[][] | null {
  const geometry = feature.geometry;
  if (geometry === null || geometry === undefined) return null;

  let polygons: Position[][][];
  if (geometry.type === "Polygon") {
    polygons = [geometry.coordinates];
  } else if (geometry.type === "MultiPolygon") {
    polygons = geometry.coordinates;
  } else {
    return null;
  }

  let best: Position[][] | null = null;
  let bestArea = 0;
  for (const rings of polygons) {
    if (rings.length === 0) continue;
    const area = ringArea(rings[0]);
    if (area > bestArea) {
      bestArea = area;
      best = rings;
    }
  }
  return best;
}

/**
 * z4 の欧州概観で「本国」として扱うアンカー範囲。
 *
 * データの表示範囲全体ではなく、アイスランド（経度 -18 前後）と
 * グリーンランド（経度 -23 前後）を西端の外に置きつつ、アイルランド・
 * イベリア半島・スカンディナヴィア・ロシア西部を含む。範囲内に成分が無い
 * 勢力は従来どおり最大成分へフォールバックするので、アイスランド等の国名を
 * 消すためのフィルターではない。
 */
export const EUROPE_OVERVIEW_ANCHOR_BOUNDS = {
  west: -12,
  south: 34,
  east: 45,
  north: 72,
} as const;

/** アンカーが欧州概観の本国優先範囲に入るか。 */
function isInEuropeOverviewAnchorBounds(
  [lon, lat]: readonly [number, number],
): boolean {
  const bounds = EUROPE_OVERVIEW_ANCHOR_BOUNDS;
  return lon >= bounds.west && lon <= bounds.east &&
    lat >= bounds.south && lat <= bounds.north;
}

/**
 * 上位勢力ラベル用の代表アンカーを返す（#407）。
 *
 * Polygon は {@linkcode labelAnchorFor} と同じ。MultiPolygon は各成分の
 * polylabel を求め、欧州概観の本国優先範囲にある成分のうち最大のものを使う。
 * 対象が無ければ従来の最大成分へフォールバックする。
 *
 * 単純な最大面積だけでは、1815 年 Denmark はアイスランド、1914 年 Denmark
 * はグリーンランド側が選ばれる。本関数は「欧州概観で国名が説明すべき本体」を
 * 幾何だけから決定し、年代・国名ごとの座標ハードコードを避ける。
 */
export function overviewLabelAnchorFor(
  feature: Feature,
): [number, number] | null {
  const geometry = feature.geometry;
  if (geometry?.type !== "MultiPolygon") return labelAnchorFor(feature);

  let bestAnchor: [number, number] | null = null;
  let bestArea = 0;
  for (const rings of geometry.coordinates) {
    if (rings.length === 0) continue;
    const area = ringArea(rings[0]);
    if (area <= bestArea) continue;
    const point = polylabel(rings, POLYLABEL_PRECISION) as [number, number];
    if (!isInEuropeOverviewAnchorBounds(point)) continue;
    bestArea = area;
    bestAnchor = [point[0], point[1]];
  }
  return bestAnchor ?? labelAnchorFor(feature);
}

/**
 * ラベルのアンカー座標 [lon, lat] を返す（純粋関数）。
 * 最大ポリゴンの pole of inaccessibility（内部で最も境界から遠い点）を
 * polylabel で求めるため、凹形状や飛び地持ちでもラベルが本体の内部に乗る。
 * Polygon/MultiPolygon 以外・空ジオメトリは null。
 */
export function labelAnchorFor(feature: Feature): [number, number] | null {
  const rings = largestPolygonRings(feature);
  if (rings === null) return null;
  const p = polylabel(rings, POLYLABEL_PRECISION);
  return [p[0], p[1]];
}

/**
 * 面積由来のラベル優先度を返す（純粋関数）。大きい勢力ほど高優先で、
 * CollisionFilterExtension の getCollisionPriority に渡す。
 *
 * 対数スケール（100 * log10(面積)）で、欧州の勢力ポリゴン（1e-4〜1e3 deg² 程度)
 * が -400〜300 付近に散らばる単調写像になる。極端値は許容レンジ
 * MIN..MAX_LABEL_PRIORITY（-1000..1000）にクランプし、ポリゴンを持たない
 * feature は最低優先度とする。
 */
export function labelPriorityFor(feature: Feature): number {
  const rings = largestPolygonRings(feature);
  if (rings === null) return MIN_LABEL_PRIORITY;
  const area = ringArea(rings[0]);
  if (area <= 0) return MIN_LABEL_PRIORITY;
  const priority = Math.round(100 * Math.log10(area));
  return Math.min(MAX_LABEL_PRIORITY, Math.max(MIN_LABEL_PRIORITY, priority));
}

/**
 * 表示階層ごとの優先度帯のオフセット（#267 AC6）。帯は互いに素:
 * top = [400, 1000] / constituent = [-300, 300] / sub = [-1000, -400]。
 * どんな面積差でも階層をまたいで逆転しない（表示階層 > 面積）。
 */
export const LABEL_TIER_PRIORITY_OFFSETS: Record<PoliticalTier, number> = {
  top: 700,
  constituent: 0,
  sub: -700,
};

/**
 * 面積由来 priority を帯内へ圧縮する係数（#267 AC6）。
 * clamp 済みの面積 priority（±1000）× 0.3 で各帯の幅 ±300 に収まる。
 */
export const LABEL_TIER_PRIORITY_SCALE = 0.3;

/**
 * 表示階層 > 面積のラベル優先度を返す（純粋関数、#267 AC6）。
 *
 * CollisionFilterExtension の衝突空間はラベル全層で共有される
 * （feature_layers.ts labelLayerBaseProps）ため、他層との関係も帯で決まる:
 * - top 帯（400 以上）は都市（150〜220）・山脈（80〜140）・河川より常に
 *   優先。上位勢力名が下位ラベルどころか注記にも消されない（#267 方針 3
 *   「z4 の上位勢力ラベルは最優先の衝突順位」と、labels.ts が従来から
 *   掲げる「国名の面積 > 都市の人口バンド」の明文化）。
 * - constituent 帯（±300 だが実データの諸侯領は -93〜32 程度）は従来の
 *   面積優先度とほぼ同じ位置に残り、都市・山脈との相対関係を大きく
 *   変えない。
 * - sub 帯は常に最下位（現行データには存在しない。politicalOverlayTier）。
 */
export function tieredLabelPriority(
  tier: PoliticalTier,
  areaPriority: number,
): number {
  const clamped = Math.min(
    MAX_LABEL_PRIORITY,
    Math.max(MIN_LABEL_PRIORITY, areaPriority),
  );
  return LABEL_TIER_PRIORITY_OFFSETS[tier] +
    Math.round(clamped * LABEL_TIER_PRIORITY_SCALE);
}

/**
 * FeatureCollection を TextLayer 用のラベルデータへ変換する（純粋関数）。
 * NAME が無い・ポリゴンを持たない feature は除外する。
 * TASK-23: ja を渡すと text を日本語表記にする（未登録 NAME は英語のまま）。
 * TASK-30: kind を渡すと全 datum に由来種別を付与する（文字色分け用）。
 * 省略時は kind キー自体を持たない（従来の呼び出しと完全互換）。
 * TASK-93: 強調キー（colorKeyFor と同一）を key に付与する。強調状態には
 * 依存しないためホバーで再計算は起きない（polylabel のメモ化は有効なまま）。
 * TASK-122: suppressedNames（TASK-78 の抑制対象 NAME 集合）に一致する
 * feature の datum には suppressed=true を付ける。datum 自体は落とさない
 * （LabelDatum.suppressed のコメント参照）。
 * #267 AC2/AC6: 表示階層（tier。politicalLabelTier で kind + 構造から決定）を
 * 付与し、priority は面積単独ではなく階層帯込み（tieredLabelPriority）にする。
 */
export function buildLabelData(
  fc: FeatureCollection,
  ja: Record<string, string> = {},
  kind?: LabelKind,
  suppressedNames: ReadonlySet<string> = EMPTY_NAME_SET,
): LabelDatum[] {
  const data: LabelDatum[] = [];
  for (const feature of fc.features) {
    const text = labelTextFor(feature.properties, ja);
    if (text === null) continue;
    const position = labelAnchorFor(feature);
    if (position === null) continue;
    const tier = politicalLabelTier(kind, feature.properties);
    const datum: LabelDatum = {
      text,
      position,
      priority: tieredLabelPriority(tier, labelPriorityFor(feature)),
      tier,
    };
    if (kind !== undefined) datum.kind = kind;
    // #407: z4 の base 国名だけは欧州本国成分を優先する。通常 position は
    // 最大成分のまま残し、z5/z7 の既存アンカー規則を変えない。
    if (kind === "base" && feature.geometry?.type === "MultiPolygon") {
      const overviewPosition = overviewLabelAnchorFor(feature);
      if (
        overviewPosition !== null &&
        (overviewPosition[0] !== position[0] ||
          overviewPosition[1] !== position[1])
      ) {
        datum.overviewPosition = overviewPosition;
      }
    }
    const key = colorKeyFor(feature.properties);
    if (key !== null) datum.key = key;
    const name = stringProp(feature.properties, "NAME");
    if (name !== null && suppressedNames.has(name)) datum.suppressed = true;
    data.push(datum);
  }
  return data;
}

/**
 * 後期 HRE の上位政治圏ラベル用データを組み立てる（#341）。
 *
 * `hreRealm` は #332 の出典付き帝国全域であり、空なら従来どおり base をそのまま
 * 上位勢力として扱う。存在する年は各 base feature を Polygon 成分へ分け、各成分の
 * polylabel アンカーが帝国外にある成分だけを上位勢力ラベル候補として残す。
 * そのうえで `hreRealm` 自身から「神聖ローマ帝国」を 1 件生成する。
 *
 * これによりオーストリア・プロイセン等を feature 全体で HRE 構成国へ分類せず、
 * ハンガリー王国・東プロイセン等の帝国外部分は HRE 階層へ取り込まれない。
 * 帝国内の構成国・領邦名は別途 hre オーバーレイから生成し、ズーム階層で制御する。
 */
export function buildTopPoliticalLabelData(
  base: FeatureCollection,
  hreRealm: FeatureCollection,
  ja: Record<string, string> = {},
  suppressedNames: ReadonlySet<string> = EMPTY_NAME_SET,
): LabelDatum[] {
  if (hreRealm.features.length === 0) {
    return buildLabelData(base, ja, "base", suppressedNames);
  }

  const realmContains = (position: [number, number]): boolean =>
    hreRealm.features.some((realm) =>
      (realm.geometry?.type === "Polygon" ||
        realm.geometry?.type === "MultiPolygon") &&
      booleanPointInPolygon(
        position,
        realm as Feature<Polygon | MultiPolygon>,
      )
    );
  const outsideFeatures: Feature[] = [];
  for (const source of base.features) {
    // 1715 の base にだけ残る HRE 残余は、#332 の帝国全域 feature で置換する。
    // 境界精度差の微小片へ旧ラベルが立ち、HRE 名が 2 件になるのを防ぐ。
    if (stringProp(source.properties, "NAME") === HRE_SUZERAIN_NAME) continue;
    if (source.geometry?.type === "Polygon") {
      const anchor = labelAnchorFor(source);
      if (anchor !== null && !realmContains(anchor)) {
        outsideFeatures.push(source);
      }
      continue;
    }
    if (source.geometry?.type !== "MultiPolygon") continue;
    const outsidePolygons = source.geometry.coordinates.filter(
      (coordinates) => {
        const component: Feature = {
          type: "Feature",
          properties: source.properties,
          geometry: { type: "Polygon", coordinates },
        };
        const anchor = labelAnchorFor(component);
        return anchor !== null && !realmContains(anchor);
      },
    );
    if (outsidePolygons.length === 0) continue;
    outsideFeatures.push({
      ...source,
      geometry: { type: "MultiPolygon", coordinates: outsidePolygons },
    });
  }

  return [
    ...buildLabelData(
      { type: "FeatureCollection", features: outsideFeatures },
      ja,
      "base",
      suppressedNames,
    ),
    ...buildLabelData(hreRealm, ja, "base"),
  ];
}

/** buildLabelData の suppressedNames 既定値（同一参照で無駄な再生成を避ける） */
const EMPTY_NAME_SET: ReadonlySet<string> = new Set<string>();

/**
 * 諸侯領・帝国領邦ラベル（kind = "fief" / "hre"）を出し始める整数ズーム段
 * （TASK-122）。この段未満では国名（kind = "base"）だけを表示する。
 *
 * 置き場を config.ts ではなく labels.ts にした理由: config.ts が持つのは
 * MIN_ZOOM / MAX_ZOOM / 年集合のように**複数モジュールが共有する**地図の
 * 基本設定で、「どの種別のラベルをどの段から出すか」は表示ポリシーであり
 * ラベル層だけの関心事。同型の先例も、都市が cities.ts の
 * visibleCityRankLimit、山脈が mountains.ts の mountainLabelMinZoom と
 * 各レイヤーのモジュール側に置いている。
 *
 * 値 5 の根拠（実機・ヘッドレス CDP で 1000 / 1300 年を z4〜z7、しきい値
 * 候補 5 と 6 の両方で描き比べて決めた）:
 * - z4（初期表示・MIN_ZOOM）は欧州全域が入る段で、TASK-110 以降は仏の
 *   諸侯領被覆率 78.5% + 帝国側領邦のラベルが一斉に載る。1300 年では
 *   フランスの領域がシャンパーニュ伯領・ブルターニュ公領・ポワトゥー伯領…で
 *   埋まり、肝心の「フランス」が衝突（COLLISION_SIZE_SCALE 2.8 倍判定）に
 *   埋もれて読み取れない。ここを base だけにすると国名が確実に読める。
 * - z5 は西欧がほぼ画面いっぱいになる段で、諸侯領ラベルを全部出しても
 *   halo（TASK-72）+ 衝突二値化（TASK-108）が効いて 1 件ずつ判読できる。
 *   実測で重なりも潰れも出なかった。
 * - しきい値 6 も試したが、z5 でフランス全土が「色違いの無名ポリゴンの
 *   パッチワーク」になり、領域が分かれていること自体は見えるのに何なのか
 *   分からない状態になった。**引きすぎた段でラベルを出さない**のが目的で
 *   あって、寄った段で情報を減らすのは目的ではないので 5 を採る。
 * 面積・priority による段階解禁は採らなかった: 諸侯領は都市の人口のような
 * 明確なランクを持たず段の切り方が恣意的になるうえ、「この段では国名だけ」
 * という読み方の単純さが失われるため（単一しきい値で足りると実機で確認）。
 */
export const FIEF_LABEL_MIN_ZOOM = 5;

/**
 * そのズームで諸侯領・帝国領邦ラベルを表示するかを返す（純粋関数、TASK-122）。
 * 判定は整数ズーム段（Math.floor）で行い、都市（visibleCityRankLimit）・
 * 山脈（filterVisibleMountainLabels）・山峰（filterVisiblePeaks）と同じ粒度に
 * 揃える。呼び出し側（main.ts）も整数段が変わった時だけレイヤーを作り直す。
 * 非有限のズーム（防御）は最遠段（MIN_ZOOM）として扱う。
 */
export function fiefLabelsVisibleAt(zoom: number): boolean {
  const step = Number.isFinite(zoom) ? Math.floor(zoom) : MIN_ZOOM;
  return step >= FIEF_LABEL_MIN_ZOOM;
}

/**
 * 詳細表示（z7〜8）を開始する整数ズーム段（#267 AC1）。
 *
 * FIEF_LABEL_MIN_ZOOM（z5 = 中間詳細の開始）と対で 3 段階のレベル境界を成す。
 * 値 7 の根拠: z5〜6 は西欧の 1〜数か国が画面に入る「構成勢力の並びを読む」
 * 段で、z7 以降は単一地方（ノルマンディー + 隣接伯領程度）が画面を占め、
 * 小さな伯領のラベルにも空間の余裕ができる。MAX_ZOOM（8）以下であることは
 * テストで固定し、「詳細の段が実在しないしきい値」を防ぐ。
 */
export const POLITICAL_DETAIL_MIN_ZOOM = 7;

/**
 * 政治表示レベル（#267 AC1）。z4 = overview（概観）/ z5〜6 = mid（中間詳細）/
 * z7〜8 = detail（詳細）。
 */
export type PoliticalDisplayLevel = "overview" | "mid" | "detail";

/**
 * 現在のズームの政治表示レベルを返す純粋関数（#267 AC1）。
 *
 * 塗り（powerFillDataForMode）・境界（internalBorderStyleFor）・ラベル
 * （filterPowerLabelsByZoom / powerLabelSizePx）・picking
 * （pick_handlers.ts の出典解決とオーバーレイ visible）の全経路がこの判定を
 * 共有し、しきい値（FIEF_LABEL_MIN_ZOOM / POLITICAL_DETAIL_MIN_ZOOM)を直接
 * 参照しない。判定は整数ズーム段（Math.floor）で、都市・山脈・山峰の
 * ズーム別表示と同じ粒度。非有限のズーム（防御）は最遠段 = overview。
 */
export function politicalDisplayLevel(zoom: number): PoliticalDisplayLevel {
  const step = Number.isFinite(zoom) ? Math.floor(zoom) : MIN_ZOOM;
  if (step < FIEF_LABEL_MIN_ZOOM) return "overview";
  return step < POLITICAL_DETAIL_MIN_ZOOM ? "mid" : "detail";
}

/**
 * 政治領域を詳細表示（領邦・諸侯領オーバーレイの塗り・内部境界・picking）する
 * ズームかを返す純粋関数（#228 AC1、#267 で 3 段階レベルの派生に変更）。
 * false は概観表示（z4）: 上位勢力単位の連続した塗り + 勢力名だけを出す。
 *
 * #267 AC1: 実体は politicalDisplayLevel の「overview かどうか」。
 * オーバーレイの塗り・visible・picking・出典解決は mid / detail を区別する
 * 必要が無い（どちらも構成勢力を表示・pick する）ため、この二値のまま残す。
 * mid / detail の差はラベル密度（filterPowerLabelsByZoom）と境界の強さ
 * （political_layers.ts internalBorderStyleFor）だけが持つ。
 */
export function politicalDetailVisibleAt(zoom: number): boolean {
  return politicalDisplayLevel(zoom) !== "overview";
}

/**
 * 中間詳細（z5〜6）で構成勢力ラベルを出す面積 priority（labelPriorityFor の
 * 生値）の下限（#267 AC8）。
 *
 * 値 -50（面積 ≈ 0.32 deg²、約 60km 四方）の根拠: 実データ
 * （1000/1100/1300 の全オーバーレイ）の constituent 面積 priority は
 * -311〜108 に分布し、中央値は -99〜45。-50 は主要な公領・伯領
 * （ノルマンディー 40 前後・アキテーヌ 60 前後・ボヘミア 106）を残しつつ、
 * 1300 年 HRE の小領邦（中央値 -99）の約半分を z7 へ送る位置にある。
 * 「一斉に出さない」目的の階層・面積による事前抑制で、残った候補の最終的な
 * 取捨は従来どおり衝突制御（COLLISION_SIZE_SCALE + priority）が行う。
 */
export const MID_LEVEL_MIN_AREA_PRIORITY = -50;

/**
 * MID_LEVEL_MIN_AREA_PRIORITY を tiered priority（LabelDatum.priority）の
 * 単位へ写した比較値。datum 側に生の面積 priority を持たせずに済ませる。
 */
const MID_LEVEL_MIN_CONSTITUENT_PRIORITY = tieredLabelPriority(
  "constituent",
  MID_LEVEL_MIN_AREA_PRIORITY,
);

/**
 * 現在のズーム段で表示する勢力ラベルを選び出す純粋関数（TASK-122、#267 で
 * 3 段階レベルへ拡張）。
 *
 * - overview（z4）: kind = "hre" / "fief" を全て落とし、base は宗主キーごとに
 *   代表 1 件へ集約して上位勢力名だけにする。宗主と同名の feature を優先し、
 *   無ければ既存 priority 最大を使う（#403）。同時に **TASK-78 の base 抑制を解除**する
 *   （suppressed な base ラベルを復活させる）。抑制は「同じ土地に諸侯領
 *   ラベルが出ている」ことが前提の重複回避なので、諸侯領ラベルを出して
 *   いない段で効かせるとその土地のラベルが 1 つも無くなる（AC #4）。
 * - mid（z5〜6）: 上位勢力名を残したまま、主要構成勢力（constituent）は
 *   面積 priority がしきい値（MID_LEVEL_MIN_AREA_PRIORITY）以上のものだけを
 *   追加する。下位（sub）はまだ出さない。「すべての下位ラベルを一斉には
 *   表示しない」（#267 AC8）の階層・面積による事前抑制で、衝突制御は
 *   この後に従来どおり効く。suppressed な base は落とす（同じ土地の
 *   諸侯領ラベルが出ている前提が z5 から成立するため）。
 * - detail（z7〜8）: 従来どおり全階層を出し、suppressed な base ラベルを
 *   落とす（TASK-78 の挙動そのまま。AC9 の「個別領邦を十分に表示」）。
 *
 * datum は再生成せず参照をそのまま返し、入力配列も破壊しない（main.ts 側の
 * メモ化を無効化しないための契約。filterVisibleMountainLabels と同型）。
 * characterSet は**この関数を通す前**の全 datum から作ること（AC #7）。
 */
export function filterPowerLabelsByZoom(
  data: readonly LabelDatum[],
  zoom: number,
  suzerainOf?: (datum: LabelDatum) => string | null,
): LabelDatum[] {
  const level = politicalDisplayLevel(zoom);
  if (level === "overview") {
    const base = data.filter((d) => d.kind !== "hre" && d.kind !== "fief");
    const representativeByLogicalPower = new Map<string, LabelDatum>();
    for (const datum of base) {
      // 宗主が解決できる product 経路では宗主単位、手組み datum や realm の
      // ように解決不能な場合も表示名単位で必ず集約する。後者を素通しすると
      // 同名 feature がそのまま複数の有効候補になる（#407 AC3）。
      const suzerain = suzerainOf?.(datum) ?? null;
      const logicalKey = suzerain === null
        ? `text:${datum.text}`
        : `suzerain:${suzerain}`;
      const current = representativeByLogicalPower.get(logicalKey);
      if (current === undefined) {
        representativeByLogicalPower.set(logicalKey, datum);
        continue;
      }
      const sourceName = datum.key?.split("|")[0];
      const currentSourceName = current.key?.split("|")[0];
      const isSuzerainFeature = suzerain !== null && sourceName === suzerain;
      const currentIsSuzerainFeature = suzerain !== null &&
        currentSourceName === suzerain;
      if (
        (isSuzerainFeature && !currentIsSuzerainFeature) ||
        (isSuzerainFeature === currentIsSuzerainFeature &&
          datum.priority > current.priority)
      ) {
        representativeByLogicalPower.set(logicalKey, datum);
      }
    }

    // 表記が同じなのに異なる（または欠落した）宗主キーへ分かれたデータも
    // 最終表示上は同一の論理名なので 1 件にする。最大 priority を選ぶことで
    // Germany の本体 + 微小な飛び地では本体側が残る。
    const representativeByText = new Map<string, LabelDatum>();
    for (const datum of representativeByLogicalPower.values()) {
      const current = representativeByText.get(datum.text);
      if (current === undefined || datum.priority > current.priority) {
        representativeByText.set(datum.text, datum);
      }
    }
    const representatives = new Set(representativeByText.values());
    return base.filter((datum) => representatives.has(datum));
  }
  if (level === "detail") {
    return data.filter((d) => d.suppressed !== true);
  }
  return data.filter((d) => {
    if (d.suppressed === true) return false;
    const tier = labelTierOf(d);
    if (tier === "top") return true;
    return tier === "constituent" &&
      d.priority >= MID_LEVEL_MIN_CONSTITUENT_PRIORITY;
  });
}

/** z4 国名ラベルの決定的衝突シミュレーションに使う viewport。 */
export interface OverviewLabelCollisionViewport {
  readonly width: number;
  readonly height: number;
  readonly center: readonly [number, number];
  readonly zoom: number;
}

/** Issue #407 の再現手順（欧州全体、中心 15/50）に対応する desktop viewport。 */
export const EUROPE_OVERVIEW_COLLISION_VIEWPORT:
  OverviewLabelCollisionViewport = {
    width: 1600,
    height: 900,
    center: [15, 50],
    zoom: MIN_ZOOM,
  };

interface CollisionRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** MapLibre/deck.gl と同じ Web Mercator world pixel へ射影する。 */
function mercatorWorldPixel(
  [lon, lat]: readonly [number, number],
  zoom: number,
): [number, number] {
  const worldSize = 512 * 2 ** zoom;
  const clampedLat = Math.max(-85.051129, Math.min(85.051129, lat));
  const sin = Math.sin(clampedLat * Math.PI / 180);
  return [
    (lon + 180) / 360 * worldSize,
    (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) *
    worldSize,
  ];
}

/** Canvas の欧文/和文メトリクスを保守的に近似した文字列幅（em）。 */
function overviewTextWidthEm(text: string): number {
  let width = 0;
  for (const ch of text) {
    if (ch === " ") width += 0.34;
    else if (/[-–—]/u.test(ch)) width += 0.45;
    else if (/[A-Z0-9]/u.test(ch)) width += 0.63;
    else if (/\p{ASCII}/u.test(ch)) width += 0.56;
    else width += 1;
  }
  return width;
}

function collisionRectsOverlap(a: CollisionRect, b: CollisionRect): boolean {
  return a.left < b.right && a.right > b.left &&
    a.top < b.bottom && a.bottom > b.top;
}

function overviewCollisionRect(
  datum: LabelDatum,
  viewport: OverviewLabelCollisionViewport,
  sizeScale: number,
  pixelOffset: readonly [number, number] = datum.pixelOffset ?? [0, 0],
): CollisionRect {
  const center = mercatorWorldPixel(viewport.center, viewport.zoom);
  const world = mercatorWorldPixel(
    datum.overviewPosition ?? datum.position,
    viewport.zoom,
  );
  const padding = POLITICAL_LABEL_STYLES.top.platePadding;
  const textWidthEm = overviewTextWidthEm(datum.text);
  const width = (
    textWidthEm * OVERVIEW_POWER_LABEL_SIZE_PX +
    padding[0] + padding[2]
  ) * sizeScale;
  const height = (
    OVERVIEW_POWER_LABEL_SIZE_PX + padding[1] + padding[3]
  ) * sizeScale;
  const x = world[0] - center[0] + viewport.width / 2 + pixelOffset[0];
  const y = world[1] - center[1] + viewport.height / 2 + pixelOffset[1];
  return {
    left: x - width / 2,
    right: x + width / 2,
    top: y - height / 2,
    bottom: y + height / 2,
  };
}

function collisionRectTouchesViewport(
  rect: CollisionRect,
  viewport: OverviewLabelCollisionViewport,
): boolean {
  return rect.right >= 0 && rect.left <= viewport.width &&
    rect.bottom >= 0 && rect.top <= viewport.height;
}

/**
 * z4 の候補へ決定的に最小限の pixel offset を割り当てる（#407）。
 *
 * 同じ画面位置へ出すと CollisionFilterExtension で片方が消える候補だけを、
 * ラベル高 + 4px ずつ上下左右へ探索する。position（地理アンカー）は変えず、
 * 最大 2 step の近傍だけを使うため、国名が説明対象から遠くへ漂流しない。
 * 置き場所を見つけられない datum は無理に動かさず、従来どおり extension の
 * priority 判定に委ねる。
 */
export function layoutOverviewLabelCollisions(
  data: readonly LabelDatum[],
  viewport: OverviewLabelCollisionViewport = EUROPE_OVERVIEW_COLLISION_VIEWPORT,
  sizeScale: number = OVERVIEW_TOP_LABEL_COLLISION_SIZE_SCALE,
): LabelDatum[] {
  const step = (OVERVIEW_POWER_LABEL_SIZE_PX +
        POLITICAL_LABEL_STYLES.top.platePadding[1] +
        POLITICAL_LABEL_STYLES.top.platePadding[3]) * sizeScale + 4;
  const offsets: readonly (readonly [number, number])[] = [
    [0, 0],
    [0, -step],
    [0, step],
    [-step, 0],
    [step, 0],
    [-step, -step],
    [step, -step],
    [-step, step],
    [step, step],
    [0, -2 * step],
    [0, 2 * step],
    [-2 * step, 0],
    [2 * step, 0],
  ];
  let result = [...data];
  const originalIndex = new Map(data.map((datum, index) => [datum, index]));
  const protectedMoved = new Set<LabelDatum>();

  // シミュレーションの最終可視集合を直接評価して offset を選ぶ。単純に既配置の
  // 全矩形を障害物にすると、本番では priority により既に消える矩形まで空間を
  // 占有し、1815 Netherlands のような候補に空きが無いと誤判定するため。
  // 救済対象は画面の西→東（同経度は南→北）という地理的な走査順にし、入力順や
  // 同名 feature の並びに左右されない。2 pass 目で前の移動により新たに隠れた
  // 候補にも一度だけ機会を与える。
  for (let pass = 0; pass < 2; pass++) {
    const visible = new Set(
      simulateOverviewLabelCollisions(
        result,
        viewport,
        sizeScale,
      ),
    );
    const hidden = result.filter((datum) => !visible.has(datum)).sort((a, b) =>
      (a.overviewPosition?.[0] ?? a.position[0]) -
        (b.overviewPosition?.[0] ?? b.position[0]) ||
      (a.overviewPosition?.[1] ?? a.position[1]) -
        (b.overviewPosition?.[1] ?? b.position[1]) ||
      b.priority - a.priority ||
      (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0)
    );
    let moved = false;
    for (const datum of hidden) {
      const index = result.indexOf(datum);
      if (index < 0) continue;
      for (const offset of offsets.slice(1)) {
        const candidate = {
          ...datum,
          pixelOffset: [offset[0], offset[1]] as [number, number],
        };
        const proposed = [...result];
        proposed[index] = candidate;
        const proposedVisible = new Set(
          simulateOverviewLabelCollisions(
            proposed,
            viewport,
            sizeScale,
          ),
        );
        if (
          proposedVisible.has(candidate) &&
          [...protectedMoved].every((movedDatum) =>
            proposedVisible.has(movedDatum)
          )
        ) {
          result = proposed;
          originalIndex.set(candidate, originalIndex.get(datum) ?? index);
          protectedMoved.add(candidate);
          moved = true;
          break;
        }
      }
    }
    if (!moved) break;
  }
  return result;
}

/**
 * z4 上位勢力ラベルへ CollisionFilterExtension 相当の決定的な矩形衝突を適用する
 * （#407 AC8）。
 *
 * Web Mercator 射影、実際の overview font size（18px）、top plate padding
 * （左右上下 5px）、priority 降順、レイヤーの sizeScale を入力にする。
 * deck.gl の SDF glyph 単位の差に依存しない回帰検証用なので、文字幅だけは
 * Canvas の代表メトリクスを保守的に近似する。候補配列だけを見るテストと違い、
 * Germany / Netherlands のアンカー間隔・文字幅・衝突倍率を変える退行を検出する。
 */
export function simulateOverviewLabelCollisions(
  data: readonly LabelDatum[],
  viewport: OverviewLabelCollisionViewport = EUROPE_OVERVIEW_COLLISION_VIEWPORT,
  sizeScale: number = OVERVIEW_TOP_LABEL_COLLISION_SIZE_SCALE,
): LabelDatum[] {
  const entries = data.map((datum, index) => {
    return {
      datum,
      index,
      rect: overviewCollisionRect(
        datum,
        viewport,
        sizeScale,
        datum.pixelOffset ?? [0, 0],
      ),
    };
  }).filter(({ rect }) => collisionRectTouchesViewport(rect, viewport)).sort(
    (a, b) => b.datum.priority - a.datum.priority || a.index - b.index,
  );

  const occupied: CollisionRect[] = [];
  const visible = new Set<LabelDatum>();
  for (const entry of entries) {
    if (occupied.some((rect) => collisionRectsOverlap(rect, entry.rect))) {
      continue;
    }
    occupied.push(entry.rect);
    visible.add(entry.datum);
  }
  return data.filter((datum) => visible.has(datum));
}

/**
 * 詳細表示の focus（地図中央の上位勢力。#345 detailFocusKeyAt）で勢力ラベルを
 * 絞り込む純粋関数（#348 AC3）。
 *
 * ズーム段の絞り込み（{@linkcode filterPowerLabelsByZoom}）の**前**に通す。
 * ズーム側は suppressed な base ラベルを mid / detail で落とすため、後に置くと
 * 「focus 外の上位勢力名を復活させる」処理が効かなくなる。
 *
 * 絞り込みの規則:
 * - オーバーレイ由来（kind = "hre" / "fief"）は、宗主キーが focus と一致する
 *   ものだけ残す。宗主が解決できない（`suzerainOf` が null）datum は focus 外
 *   として落とす。これにより「詳細表示されるのは常に最大 1 上位勢力」（#293
 *   AC2）がラベル側でも成立する。
 * - 上位勢力名（kind = "base" / 省略）は必ず残す。加えて **focus 外の
 *   suppressed な base ラベルは抑制を解除**する（TASK-78 の抑制は「同じ土地に
 *   諸侯領ラベルが出ている」ことが前提の重複回避で、その諸侯領ラベルを focus
 *   で落とす以上、解除しないとその土地のラベルが 1 つも無くなる）。focus 内の
 *   抑制はそのまま残し、従来どおり領邦ラベルへ譲る（二重ラベルにならない）。
 *
 * focus が null（中央が海上・概観表示・#350 前の既定）なら**入力をそのまま
 * 同一参照で返す**。呼び出し側のメモ化（political_layers.ts）と組み合わせて、
 * focus を使わない間の出力・参照同値を完全に据え置くための契約。
 *
 * 抑制を解除する datum だけは複製する（入力配列と元 datum は破壊しない）。
 * 複製が起きるのは focus が変わったときだけで、同じ focus の再構築では
 * 呼び出し側のメモ化により同一配列が返り続ける。
 */
export function filterPowerLabelsByFocus(
  data: readonly LabelDatum[],
  focusKey: string | null,
  suzerainOf: (d: LabelDatum) => string | null,
): readonly LabelDatum[] {
  if (focusKey === null) return data;
  const out: LabelDatum[] = [];
  for (const d of data) {
    if (d.kind === "hre" || d.kind === "fief") {
      if (suzerainOf(d) === focusKey) out.push(d);
      continue;
    }
    if (d.suppressed === true && suzerainOf(d) !== focusKey) {
      out.push({ ...d, suppressed: false });
      continue;
    }
    out.push(d);
  }
  return out;
}

/**
 * 神聖ローマ帝国を宗主とする feature が SUBJECTO / PARTOF に持つ名称
 * （TASK-110）。base（europe_*）・hre_fiefs_* いずれもこの綴りで統一されている。
 */
export const HRE_SUZERAIN_NAME = "Holy Roman Empire";

/**
 * feature の宗主が神聖ローマ帝国かを判定する純粋関数（TASK-110）。
 *
 * なぜ必要か: TASK-110 で追加した Cliopatria 由来のオーバーレイは、1 枚の
 * レイヤーに**仏諸侯領（トゥールーズ伯領・アキテーヌ公領・王領）と帝国領邦
 * （バイエルン公領・ブランデンブルク・ボヘミア王国）の両方**を載せる
 * （出典が同じなので分けない）。ところが本アプリのラベル色は出典ではなく
 * **系統**を表す記号で、臙脂 = 帝国域内の領邦・藍紫 = 諸侯領と決まっている
 * （TASK-30 AC #1 / TASK-71 AC #1）。レイヤー単位で kind を固定すると、
 * 1400/1492 年に Cliopatria 由来のバイエルンだけが藍紫、OHM 由来の隣接領邦は
 * 臙脂という、同じ画面内で凡例が破れた状態になる。feature 単位で宗主を見て
 * kind を決めることで、出典が変わっても凡例の意味が変わらない。
 *
 * SUBJECTO を先に見るのは TASK-94 の宗主補正（name-overrides.json suzerains）が
 * 書き換えるのが SUBJECTO だから。欠けていれば PARTOF へ倒す。
 */
export function isHreSuzerainFeature(properties: GeoJsonProperties): boolean {
  const suzerain = properties?.SUBJECTO ?? properties?.PARTOF;
  return suzerain === HRE_SUZERAIN_NAME;
}

/**
 * オーバーレイ feature の表示階層を構造から分類する（純粋関数、#267 AC2）。
 *
 * 名称の接尾辞（「王国」「公領」「伯領」）は根拠にしない（スコープ外の
 * 歴史的序列決定になるため）。使う構造は SUBJECTO（直接の主君）と PARTOF
 * （最上位の所属）の宣言だけ:
 * - 両方があり互いに別勢力（かつ SUBJECTO が自己参照でない）→ 直接の主君が
 *   自身も上位勢力の構成勢力 = 2 段以上深い構造が宣言されている → "sub"
 * - それ以外（SUBJECTO = PARTOF・片方欠落・両方欠落・自己参照）→
 *   "constituent"（上位勢力直下の主要構成勢力）へフォールバック
 *
 * 現行データの実測（hre_fiefs_flat / cliopatria_fiefs_flat の SUBJECTO 持ち
 * 全 feature）では SUBJECTO = PARTOF、仏・伊・ブリテン・主権政体は両方
 * 欠落のため、全てフォールバック先の "constituent" に落ちる。sub の分岐は
 * 深い構造が宣言されたデータが入った時に自動で効く。
 */
export function politicalOverlayTier(
  properties: GeoJsonProperties,
): Exclude<PoliticalTier, "top"> {
  const name = stringProp(properties, "NAME");
  const subjecto = stringProp(properties, "SUBJECTO");
  const partof = stringProp(properties, "PARTOF");
  if (
    subjecto !== null && partof !== null && subjecto !== partof &&
    subjecto !== name
  ) {
    return "sub";
  }
  return "constituent";
}

/**
 * ラベル由来種別 + properties から表示階層を決める（純粋関数、#267 AC2）。
 * base（kind 省略含む）は上位勢力（top）、オーバーレイ由来（hre / fief）は
 * politicalOverlayTier の構造分類に従う。
 */
export function politicalLabelTier(
  kind: LabelKind | undefined,
  properties: GeoJsonProperties,
): PoliticalTier {
  if (kind === undefined || kind === "base") return "top";
  return politicalOverlayTier(properties);
}

/**
 * datum の表示階層を返す（純粋関数）。tier 未付与の datum（buildLabelData を
 * 通らない手組みデータ・旧形式）は kind から解決する後方互換フォールバック。
 */
export function labelTierOf(
  d: Pick<LabelDatum, "kind" | "tier">,
): PoliticalTier {
  if (d.tier !== undefined) return d.tier;
  return d.kind === "hre" || d.kind === "fief" ? "constituent" : "top";
}

/**
 * 出典混在オーバーレイ（TASK-110 の Cliopatria）の FeatureCollection を、
 * 帝国領邦（kind="hre" = 臙脂）と諸侯領（kind="fief" = 藍紫）の 2 つへ分ける
 * 純粋関数。feature の並び・properties・ジオメトリはそのまま保つ。
 *
 * `metadata`（TASK-109 の出典）は引き継がない: 用途がラベルデータの生成に
 * 限られ、出典パネルは分割前の FeatureCollection（main.ts の currentView）を
 * 直接読むため。ここで metadata を複製すると「同じ出典の FC が 3 つある」
 * 状態になり、どれが正か曖昧になる。
 *
 * 空 FC（オーバーレイ非対象年・取得失敗・データ未生成）では両側とも空になり、
 * ラベルが 1 件も出ない従来表示へ素直に縮退する。
 */
export function partitionFiefsBySuzerain(
  fc: FeatureCollection,
): { hre: FeatureCollection; fief: FeatureCollection } {
  const hre: Feature[] = [];
  const fief: Feature[] = [];
  for (const feature of fc.features) {
    if (isHreSuzerainFeature(feature.properties)) hre.push(feature);
    else fief.push(feature);
  }
  return {
    hre: { type: "FeatureCollection", features: hre },
    fief: { type: "FeatureCollection", features: fief },
  };
}

/**
 * 全ラベルテキストに現れる文字の重複なし配列を返す（純粋関数）。
 * TextLayer の characterSet に渡し、Württemberg の ü などデフォルトの
 * ASCII セットに無い文字もグリフを生成させる。
 */
export function characterSetFrom(texts: readonly string[]): string[] {
  return [...new Set(texts.join(""))];
}
