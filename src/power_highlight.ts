/**
 * 勢力・領邦ポリゴンのアクティブ強調（ホバー/クリック）の DOM・deck.gl 非依存な
 * 純粋ロジック（TASK-90）。
 * - 強調キーの解決（powerHighlightKey。適用単位の定義そのもの）
 * - クリックの保持・解除規則（togglePowerSelection）
 * - アクティブ判定と塗り色（isPowerActive / powerFillColor）
 * - 変化検知つきの状態保持（createPowerHighlightStore）
 *
 * 勢力圏の外枠（suzerain_extent.ts、TASK-30 / TASK-94）は「宗主に属する勢力圏の
 * 外縁を臙脂の線で囲む」別建ての表現で、本モジュールは「ホバー/クリックした
 * 任意の勢力・領邦の塗り自体を変える」表現を担う。両者はレイヤーも色域も
 * 分かれているため同時に成立する（AC #5）。
 *
 * 参照仕様: docs/app-spec.md §3.3 / §5.2
 */

import type { GeoJsonProperties } from "geojson";
import { colorKeyFor, fillColorFor, type Rgba } from "./powers.ts";
import {
  type LabelColor,
  type LabelDatum,
  politicalLabelColor,
} from "./labels.ts";
import {
  BRITAIN_FIEF_LAYER_ID,
  CLIOPATRIA_FIEF_LAYER_ID,
  FRANCE_FIEF_LAYER_ID,
  HRE_LAYER_ID,
  ITALY_FIEF_LAYER_ID,
  POWER_LAYER_ID,
  SOVEREIGN_FIEF_LAYER_ID,
} from "./picking.ts";

/**
 * アクティブ強調の対象になるレイヤー（政治ポリゴンの 5 層）。
 * 河川・都市・判定専用層・ラベル層は対象外（それぞれ固有の強調表現を持つか、
 * そもそも「国土の広がり」を持たない）。
 *
 * TASK-110: Cliopatria 由来の領邦も同じ扱い。強調キーは colorKeyFor と同一
 * （NAME、SUBJECTO があれば NAME|SUBJECTO）なので、出典が違っても同じ領邦の
 * 飛び地は 1 つの面として光る。出典の違いは情報パネルの出典行（TASK-109）が
 * 開示するので、強調表現の側で区別を作る必要はない。
 *
 * #172: ブリテン諸島の政体も同じ扱い。SUBJECTO を持たないため強調キーは
 * NAME 単独になる（独立主権政体として振る舞う既存の仏諸侯領と同型）。
 *
 * #189: 主権政体オーバーレイも同じ扱い（SUBJECTO なし・NAME 単独キー）。
 * NAME を base の呼称に合わせているため（Crimean Khanate 等）、年代を跨いで
 * base 側と同じ政体が同じキーで強調される。
 */
export const POWER_HIGHLIGHT_LAYER_IDS: readonly string[] = [
  POWER_LAYER_ID,
  HRE_LAYER_ID,
  FRANCE_FIEF_LAYER_ID,
  ITALY_FIEF_LAYER_ID,
  CLIOPATRIA_FIEF_LAYER_ID,
  BRITAIN_FIEF_LAYER_ID,
  SOVEREIGN_FIEF_LAYER_ID,
];

/**
 * アクティブ時の塗り色（緑青＝ヴェルディグリ #68a094、alpha 214）。
 *
 * 色の選定（TASK-90 AC #8。TASK-73 / TASK-74 の褪せ顔料・古地図トーン方針に沿う）:
 * - 緑青（銅の錆）は古地図の彩色に実在した顔料で、羊皮紙トーンの下地
 *   （basemap.ts PARCHMENT_FLAVOR_OVERRIDES）と同じ「褪せた顔料」の系統に収まる。
 *   蛍光的な選択色（純シアン・純黄など）を使わずに済み、地図全体の質感を壊さない。
 * - 既存の強調色と色相が離れている: HRE 帝国範囲の臙脂 [140,30,30]
 *   （political_layers.ts HRE_EXTENT_LINE_COLOR）・諸侯領境界の藍紫
 *   [74,42,130]（同 FIEF_BORDER_INK）・河川選択の赤茶 [122,46,34]
 *   （rivers.ts）のいずれとも
 *   色相が 60 度以上離れる（単体テストで固定）。「臙脂の外縁 = 帝国範囲」
 *   「藍紫の細線 = 諸侯領の区画」「緑青の塗り = いま指している勢力の国土」が
 *   同時に出ても読み分けられる。
 * - alpha は通常塗り（powers.ts FILL_ALPHA = 128）より高い 214。勢力ごとの
 *   固有色（colors.json）を実質的に覆い隠すことで、飛び地を含む同一勢力の
 *   範囲が「1 つの面」として一目で読める。完全不透明にしないのは、下地の
 *   陰影・概略境界・領邦境界を残して地図としての情報を失わせないため。
 *
 * TASK-93 で明度を引き上げた（旧 #2e6e66 → #68a094。色相・alpha は不変）。
 * 旧値は合成後の背景が中明度の暗い面（相対輝度 0.19）になり、その上に載る
 * 暗色ラベル（国名・諸侯領名・都市名）が沈んで読めなかった。文字色を深く
 * するだけでは 3.9:1 止まりで基準（labels.ts MIN_ACTIVE_LABEL_CONTRAST）に
 * 届かず、色を切り替えない都市名は 1.9:1 のまま救えないため、塗り側も
 * 「褪せた緑青の淡彩」へ寄せる。上げすぎると強調自体が羊皮紙の下地に
 * 埋もれるため、下地とのコントラストは MIN_HIGHLIGHT_VISIBILITY_CONTRAST
 * を下限として単体テストで固定する（AC #5 の両立点）。
 */
export const ACTIVE_FILL_COLOR: Rgba = [104, 160, 148, 214];

/** 年代切替時の塗りフェード時間（ms）。従来からの値（docs/app-spec.md §5.1） */
export const YEAR_FILL_TRANSITION_MS = 400;

/**
 * 強調の変化に使う塗りの遷移時間（ms）。
 *
 * 年代切替のフェード（400ms）をそのままホバー強調へ流用すると、カーソルを
 * 動かすたびに色が遅れて追いつく「反応が鈍い」表示になる（deck.gl の
 * transitions は accessor 単位で、getFillColor 一本に両方の用途が乗る）。
 * そこで renderLayers の呼び出し要因に応じて duration を切り替え、強調では
 * 120ms（知覚上ほぼ即時だが、切り替えの硬さを取る程度）を使う。0 にしない
 * のは、パリパリと切り替わる印象を避けて古地図トーンの落ち着きを保つため。
 */
export const HIGHLIGHT_FILL_TRANSITION_MS = 120;

/**
 * picking 結果から強調キーを解決する（純粋関数）。
 *
 * 適用単位の決定（AC #4）: feature 単位ではなく **勢力キー単位**
 * （powers.ts colorKeyFor と同一のキー = NAME もしくは "NAME|SUBJECTO"）。
 * - 要望は「国土（領域）の広がりが一目で分かる」ことで、飛び地・島嶼で複数
 *   feature に分かれる勢力（イングランド + 大陸領、デンマーク等）を同時に
 *   強調しなければ「国土」にならない。
 * - キーを colorKeyFor と同一にすることで「同じ色で塗られている面が全部
 *   アクティブ色になる」が構造的に保証され、塗り分けと強調の単位が食い違わない。
 * - hre-powers / france-fiefs の領邦は colorKeyFor が親と別のキー
 *   （"Bavaria|Holy Roman Empire" / "Normandy"）を返すため、親勢力（HRE 本体・
 *   France 本体）とは独立に強調される。領邦をホバーしたときに帝国全体が
 *   塗り潰されると、TASK-30 の帝国範囲強調（臙脂の外縁）と情報が二重になり
 *   範囲が読めなくなる（AC #5）。
 * - レイヤー ID でキーを修飾しない（"powers:France" のようにしない）のは、
 *   同一勢力が base と領邦オーバーレイの双方に現れる場合でも同じ国土として
 *   同時に光るのが自然なため。
 *
 * 対象外レイヤー（河川・都市・判定専用層）や NAME を持たない feature は null。
 */
export function powerHighlightKey(
  layerId: string | undefined,
  props: GeoJsonProperties | undefined,
): string | null {
  if (layerId === undefined) return null;
  if (!POWER_HIGHLIGHT_LAYER_IDS.includes(layerId)) return null;
  return colorKeyFor(props ?? null);
}

/**
 * クリックによる強調選択の遷移（純粋関数）。rivers.ts の toggleRiverSelection と
 * 同一の規則にし、河川とポリゴンで「クリックの意味」を揃える。
 * - 選択中と同じ勢力を再クリック → 解除（null）
 * - 別の勢力をクリック → その勢力へ移動
 * - 強調対象でないクリック（河川・都市・何も無い場所 = clickedKey が null）→ 解除
 */
export function togglePowerSelection(
  current: string | null,
  clickedKey: string | null,
): string | null {
  if (clickedKey === null) return null;
  return current === clickedKey ? null : clickedKey;
}

/**
 * 強調キーがアクティブ（選択中またはホバー中）かを判定する（純粋関数）。
 *
 * 選択とホバーを OR で扱う（rivers.ts のように「選択 > ホバー」の段階を作らない）
 * 理由: 強調はアクティブ色 1 段階のみで、段階を分ける表現差が無い。選択中に
 * 別の勢力へホバーしたときは両方がアクティブ色になるが、これは河川で
 * 「選択中の川を残したままホバー中の川も強調される」のと同じ挙動で、
 * ホバーのフィードバックがクリック後に死なないという利点がある。
 * キーが null（NAME を持たない feature）は決してアクティブにしない。
 */
export function isPowerActive(
  key: string | null,
  selected: string | null,
  hovered: string | null,
): boolean {
  if (key === null) return false;
  return key === selected || key === hovered;
}

/**
 * 政治ポリゴンの塗り色を決める（純粋関数）。アクティブならアクティブ色、
 * それ以外は従来どおり colors.json 由来の勢力色（powers.ts fillColorFor）。
 * 3 層（powers / hre-powers / france-fiefs）で共用する。
 */
export function powerFillColor(
  props: GeoJsonProperties,
  colors: Record<string, string>,
  selected: string | null,
  hovered: string | null,
): Rgba {
  if (isPowerActive(colorKeyFor(props), selected, hovered)) {
    return ACTIVE_FILL_COLOR;
  }
  return fillColorFor(props, colors);
}

/**
 * ラベルの文字色を強調状態から決める（純粋関数、TASK-93 AC #1/#3/#4、
 * #267 AC5 で明色系へ変更）。
 *
 * 判定単位は powerFillColor と同じ強調キー（LabelDatum.key = colorKeyFor）で、
 * 「アクティブ色に塗られた面の上に載るラベル」と「色を切り替えるラベル」が
 * 構造的に一致する。飛び地を持つ勢力ではすべてのラベルが同時に切り替わる。
 * key を持たないラベル（河川名・都市名）は常に通常色（対象外。判読は
 * クリーム halo と、アクティブ塗り側の明度調整が担う）。
 *
 * #267: 色の実体は politicalLabelColor（通常 = クリーム明色 / 強調 = 純白）。
 * kind 別の文字色（TASK-30/71）は通常時の主表現から外れたため、d.kind は
 * もう色に影響しない（強調キーの判定にだけ d.key を使う）。
 *
 * 強調が解除されれば selected/hovered が null になり、そのまま通常色へ戻る
 * （切替のために別途状態を持たない）。
 */
export function powerLabelColor(
  d: Pick<LabelDatum, "kind" | "key">,
  selected: string | null,
  hovered: string | null,
): LabelColor {
  return politicalLabelColor(isPowerActive(d.key ?? null, selected, hovered));
}

/** 強調状態（選択・ホバー）の保持と変化検知 */
export interface PowerHighlightStore {
  /** クリックで選択中の強調キー（null は未選択） */
  selected(): string | null;
  /** ホバー中の強調キー（null はホバーなし） */
  hovered(): string | null;
  /** ホバー状態を更新する。変化した場合のみ onChange を呼ぶ */
  hover(key: string | null): void;
  /** クリックを反映する（togglePowerSelection の規則）。変化時のみ onChange */
  click(key: string | null): void;
  /** 選択・ホバーをまとめて解除する（年代切替など）。変化時のみ onChange */
  clear(): void;
}

/**
 * 強調状態のストアを作る（TASK-90 AC #3/#7）。
 *
 * onChange（main.ts では renderLayers）は **値が実際に変わったときだけ** 呼ぶ。
 * ホバーは mousemove ごとに発火するため、この変化検知を外すと TASK-50 と同じ
 * 「ホバーのたびに全レイヤー再構築」の性能退行になる。clear は選択・ホバーの
 * 両方を落とすが、onChange は最大 1 回（再構築をまとめる）。
 */
export function createPowerHighlightStore(
  onChange: () => void,
): PowerHighlightStore {
  let selectedKey: string | null = null;
  let hoveredKey: string | null = null;

  return {
    selected: () => selectedKey,
    hovered: () => hoveredKey,
    hover(key) {
      if (key === hoveredKey) return;
      hoveredKey = key;
      onChange();
    },
    click(key) {
      const next = togglePowerSelection(selectedKey, key);
      if (next === selectedKey) return;
      selectedKey = next;
      onChange();
    },
    clear() {
      if (selectedKey === null && hoveredKey === null) return;
      selectedKey = null;
      hoveredKey = null;
      onChange();
    },
  };
}
