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
  Position,
} from "geojson";
import polylabelModule from "@mapbox/polylabel";
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
    const key = colorKeyFor(feature.properties);
    if (key !== null) datum.key = key;
    const name = stringProp(feature.properties, "NAME");
    if (name !== null && suppressedNames.has(name)) datum.suppressed = true;
    data.push(datum);
  }
  return data;
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
 * - overview（z4）: kind = "hre" / "fief" を全て落とし、上位勢力名だけにする
 *   （TASK-122 AC #1）。同時に **TASK-78 の base 抑制を解除**する
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
): LabelDatum[] {
  const level = politicalDisplayLevel(zoom);
  if (level === "overview") {
    return data.filter((d) => d.kind !== "hre" && d.kind !== "fief");
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
