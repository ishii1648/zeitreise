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

/** TextLayer に渡すラベル 1 件分のデータ */
export interface LabelDatum {
  /** 表示テキスト（NAME） */
  text: string;
  /** アンカー座標 [lon, lat] */
  position: [number, number];
  /** 衝突制御の優先度（大きいほど優先。MIN..MAX_LABEL_PRIORITY） */
  priority: number;
  /** 由来種別（TASK-30 の文字色分け用。省略時は base 扱い） */
  kind?: LabelKind;
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

/** 独立国など通常ラベルの文字色（濃グレー。TASK-20 から不変） */
export const BASE_LABEL_COLOR: LabelColor = [40, 40, 40, 255];

/**
 * HRE 域内領邦ラベルの文字色（TASK-30 AC #1）。
 * 臙脂（えんじ）系の深い赤。既存のラベル色 — 国名の濃グレー [40,40,40]・
 * 都市の茶 [121,62,22]・河川の水色 [2,119,189] — のいずれとも色相が離れて
 * おり、クリーム halo（TASK-72）上で判読しつつ「帝国系」の記号として一目で区別できる。
 * 帝国範囲の強調レイヤー（main.ts hre-extent）と同系色で揃える。
 */
export const HRE_LABEL_COLOR: LabelColor = [140, 30, 30, 255];

/**
 * 中世フランス諸侯領ラベルの文字色（TASK-71 AC #1）。青紫（藍紫）系の深い色。
 * 既存のラベル色 — 独立国の濃グレー [40,40,40]・HRE 領邦の臙脂 [140,30,30]・
 * 都市の茶 [121,62,22]・河川の水色 [2,119,189] — のいずれとも色相・明度が
 * 離れており、クリーム halo（TASK-72）上で判読しつつ「フランス王国内の封建諸侯」の
 * 記号として一目で区別できる。河川の水色とは同じ寒色域だが、彩度を落として
 * 紫寄りにすることで注記（河川）と領域ラベル（諸侯領）を混同しない。
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
 * 強調中の独立国ラベルの文字色（TASK-93）。通常の濃グレー [40,40,40] より
 * さらに深いインク。アクティブ塗り（緑青）の上でも 4.5:1 を確保する。
 */
export const ACTIVE_BASE_LABEL_COLOR: LabelColor = [26, 26, 26, 255];

/**
 * 強調中の HRE 領邦ラベルの文字色（TASK-93）。臙脂の色相を保ったまま暗く
 * 沈めた深臙脂。TASK-30 の「帝国系は赤系」という記号性を強調中も維持する。
 */
export const ACTIVE_HRE_LABEL_COLOR: LabelColor = [95, 16, 16, 255];

/**
 * 強調中の仏諸侯領ラベルの文字色（TASK-93）。藍紫の色相を保ったまま暗く
 * 沈めた深藍紫。TASK-71 の「諸侯領は青紫」という記号性を強調中も維持する。
 * 通常色 [74,42,130] はアクティブ塗り上で最も沈むため、切替の効果が最大。
 */
export const ACTIVE_FIEF_LABEL_COLOR: LabelColor = [40, 20, 80, 255];

/**
 * ラベルの文字色を由来種別から決める（純粋関数、TASK-30 AC #1・TASK-71 AC #1）。
 * kind=hre は帝国色、kind=fief は仏諸侯領色、それ以外（base・省略）は
 * 従来の濃グレー。
 *
 * TASK-93: active（そのラベルの勢力がホバー/クリックで強調中）のときは、
 * 同じ色相のまま暗く沈めた強調用の色を返す。アクティブ塗りは通常塗りより
 * 濃く、通常のラベル色では合成後の背景に埋もれて読めなくなるため。
 * 色相を変えないので「濃グレー = 独立国 / 臙脂 = 帝国 / 藍紫 = 諸侯領」の
 * 読み分けは強調中も保たれる。
 */
export function labelColorFor(
  d: Pick<LabelDatum, "kind">,
  active: boolean = false,
): LabelColor {
  if (d.kind === "hre") {
    return active ? ACTIVE_HRE_LABEL_COLOR : HRE_LABEL_COLOR;
  }
  if (d.kind === "fief") {
    return active ? ACTIVE_FIEF_LABEL_COLOR : FIEF_LABEL_COLOR;
  }
  return active ? ACTIVE_BASE_LABEL_COLOR : BASE_LABEL_COLOR;
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
    const datum: LabelDatum = {
      text,
      position,
      priority: labelPriorityFor(feature),
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
 * 政治領域を詳細表示（領邦・諸侯領オーバーレイの塗り・内部境界・picking）する
 * ズームかを返す純粋関数（#228 AC1）。false は概観表示（z4）: 上位勢力単位の
 * 連続した塗り + 勢力名だけを出す。
 *
 * 判定は fiefLabelsVisibleAt へ委譲する（同じ FIEF_LABEL_MIN_ZOOM・同じ整数段
 * 規約）。別関数として公開するのは、TASK-122 が「ラベルだけ」の出し分けだった
 * のに対し、#228 で塗り・境界・ラベル・picking の 4 経路が**同じ判定**を共有する
 * ことが要件になったため。呼び出し側（political_layers.ts / main.ts /
 * pick_handlers.ts / debug_hooks.ts）はすべてこの関数を通し、しきい値を
 * 直接参照しない（判定が 1 箇所からズレると「概観なのに領邦の塗りが残る」
 * という本タスクの動機そのものが再発する）。
 */
export function politicalDetailVisibleAt(zoom: number): boolean {
  return fiefLabelsVisibleAt(zoom);
}

/**
 * 現在のズーム段で表示する勢力ラベルを選び出す純粋関数（TASK-122）。
 *
 * - FIEF_LABEL_MIN_ZOOM 未満: kind = "hre" / "fief" を全て落とし、国名だけに
 *   する（AC #1）。同時に **TASK-78 の base 抑制を解除**する（suppressed な
 *   base ラベルを復活させる）。抑制は「同じ土地に諸侯領ラベルが出ている」
 *   ことが前提の重複回避なので、諸侯領ラベルを出していない段で効かせると
 *   その土地のラベルが 1 つも無くなる（1000〜1300 の Britany。AC #4）。
 * - FIEF_LABEL_MIN_ZOOM 以上: 従来どおり諸侯領・領邦ラベルを出し、
 *   suppressed な base ラベルを落とす（TASK-78 の挙動そのまま）。
 *
 * datum は再生成せず参照をそのまま返し、入力配列も破壊しない（main.ts 側の
 * メモ化を無効化しないための契約。filterVisibleMountainLabels と同型）。
 * characterSet は**この関数を通す前**の全 datum から作ること（AC #7）。
 */
export function filterPowerLabelsByZoom(
  data: readonly LabelDatum[],
  zoom: number,
): LabelDatum[] {
  if (fiefLabelsVisibleAt(zoom)) {
    return data.filter((d) => d.suppressed !== true);
  }
  return data.filter((d) => d.kind !== "hre" && d.kind !== "fief");
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
