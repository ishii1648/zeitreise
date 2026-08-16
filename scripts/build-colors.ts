/**
 * 色割当の静的生成スクリプト。
 * - data/europe_<year>.geojson × 20 から NAME / SUBJECTO を収集する
 * - NAME をキーに決定的ハッシュでパレット色を割り当てる（同一勢力は全年代で同色）
 * - SUBJECTO を持つ feature（属領・植民地）は宗主国の色相に寄せた明度違いの色にする。
 *   SUBJECTO は name-overrides.json の renames で正規化してから宗主国色を引く。
 * - data/colors.json を生成する。クライアントは NAME（属領は "NAME|SUBJECTO"）で
 *   O(1) 参照するのみ（実行時のハッシュ計算・色衝突の揺れを避ける）。
 *
 * 差分追加モード（Issue #193）:
 * 既存の data/colors.json を「スナップショット正」として読み込み、既存キーの色は
 * 一切変えず、現行データに現れた新キーだけを決定的規則（fnv1a 自然スロット +
 * 線形プロービング + 同年非衝突制約）で追加する。全量再生成（buildColorMap）は
 * プロービング連鎖のずれで既存キーが大量に変色するため（#172 実測で 92 キー）、
 * colors.json が存在しない bootstrap 時のみ使う。現行データに存在しなくなった
 * キー（900 年廃止由来等）は既定で保持し、--prune 指定時のみ取り除く。
 *
 * 羊皮紙下地とのコントラスト制約（Issue #385・ADR-0041）:
 * パレット 288 スロットのうち、塗りを FILL_ALPHA で陸地色 #f0e6cd に合成した
 * 実表示色と素の陸地色の CIEDE2000 色差が EARTH_DELTA_E_MIN 未満のスロットは
 * 割当候補から除外する（assignableSlots）。除外前は 288 中 95 が「塗っても
 * 下地と区別が付かない」スロットで、オスマン帝国等が塗られていないように
 * 見えていた。既に埋もれている既存キーの是正は --remap-low-contrast の
 * 一回限りの実行で行う（通常実行では既存キーは動かない）。
 * パレットの (h,s,l) 格子自体（SATURATIONS / LIGHTNESSES）は変えていないので、
 * 既存スナップショット色のパレット逆引きは従来どおり効く。
 *
 * ロジックは純粋関数として export しテスト対象にする（scripts/build-colors_test.ts）。
 * 参照仕様: docs/app-spec.md §4.3
 */

import type { FeatureCollection, Position } from "geojson";
import { SNAPSHOT_YEARS } from "../src/config.ts";
// #385: 羊皮紙の陸地色と塗りの alpha はランタイムと同一の定義を引く（値の
// 二重管理を作らない）。parchment_palette.ts / powers.ts はどちらも npm・DOM
// 非依存なので、データ生成スクリプトから import しても依存は増えない。
import { PARCHMENT_FLAVOR_OVERRIDES } from "../src/parchment_palette.ts";
import { FILL_ALPHA, hexToRgb } from "../src/powers.ts";
import { compositeOver, deltaE2000, type Rgb } from "../src/contrast.ts";
import { HRE_OVERLAY_YEARS } from "./build-hre.ts";
import { FRANCE_FIEF_YEARS } from "./build-france-fiefs.ts";
import { HRE_FIEF_YEARS } from "./build-hre-fiefs.ts";
import { ITALY_FIEF_YEARS } from "./build-italy-fiefs.ts";
import { CLIOPATRIA_FIEF_YEARS } from "./build-cliopatria-fiefs.ts";
import { BRITAIN_FIEF_YEARS } from "./build-britain-fiefs.ts";
import { SOVEREIGN_FIEF_YEARS } from "./build-sovereign-fiefs.ts";

const DATA_DIR = "data";
const OVERRIDES_PATH = `${DATA_DIR}/name-overrides.json`;
const COLORS_PATH = `${DATA_DIR}/colors.json`;

/** 独立勢力キーと属領キー（NAME|SUBJECTO）を区切る文字。国名には現れない */
export const SUBJECT_KEY_SEP = "|";

/**
 * name-overrides.json の構造。
 * - renames: 表記ゆれ・別名のリネームマップ
 * - suzerains: base が欠く封建関係の補正（NAME → 宗主 NAME、TASK-94）。
 *   ランタイム側（src/suzerain_extent.ts applySuzerainOverrides）が SUBJECTO を
 *   補正後の宗主名へ書き換えるため、色キーも同じ補正を通して作る。
 */
export interface NameOverrides {
  renames: Record<string, string>;
  suzerains?: Record<string, string>;
}

/** HSL 色（h: 0..360, s: 0..1, l: 0..1） */
export interface Hsl {
  h: number;
  s: number;
  l: number;
}

/** NAME/複合キー → HEX 色 の割当マップ */
export type ColorMap = Record<string, string>;

/**
 * パレット設計（docs/app-spec.md §4.3）。
 * ヨーロッパ域の全年代合算ユニーク NAME は 272。色衝突を緩和するため、
 * 色相を黄金角で分散させた 24 段 × 彩度 3 段 × 明度 4 段 = 288 色を用意し、
 * 想定ユニーク数を上回る実効色数を確保する。彩度・明度差で隣接色の識別性も高める。
 */
export const HUE_COUNT = 24;

/** 黄金角（度）。色相をインデックス順で大きく分散させ、隣接色の衝突を緩和する */
export const GOLDEN_ANGLE = 137.508;

/**
 * 彩度段（TASK-74: 褪せた顔料トーン）。
 * 羊皮紙ベースマップ（陸地 #f0e6cd）・羊皮紙 UI から浮かないよう低彩度に寄せる。
 *
 * 「下地に埋もれない」ことは彩度の下限では担保できない（#385）。同じ低彩度でも
 * 色相が羊皮紙の黄土帯に入れば埋もれ、外れれば十分判別できるため、彩度・明度の
 * レンジは**見た目のトーンを決めるだけ**の値であり、判別性は
 * EARTH_DELTA_E_MIN による機械的なスロット除外（isAssignableSlot）が担保する。
 */
export const SATURATIONS: readonly number[] = [0.2, 0.3, 0.4];

/**
 * 明度段（TASK-74: 褪せた顔料トーン）。
 * 羊皮紙下地に載る顔料として中〜高明度帯へ引き上げる。
 * 属領の明度シフト（SUBJECT_LIGHTNESS_SHIFT）後も [0,1] に収まる範囲に保つ。
 *
 * #385 でこの値を暗い側へ寄せることを検討したが、**変更しない**。閾値
 * EARTH_DELTA_E_MIN = 10 ではこの明度段のままでも割当候補が 193/288 残り、
 * 同年最大キー数（実測 152・1300 年）を 27% 上回って割当が成立する。据え置く
 * ことでパレットの (h,s,l) 格子が不変になり、既存スナップショット色の
 * パレット逆引き（paletteHexToSlot）が有効なまま保たれる = ADR-0032 の
 * 「既存キーは動かさない」との整合が強くなる。実測表は ADR-0041。
 */
export const LIGHTNESSES: readonly number[] = [0.52, 0.62, 0.72, 0.82];

/** パレット総色数 */
export const PALETTE_SIZE = HUE_COUNT * SATURATIONS.length * LIGHTNESSES.length;

/**
 * FNV-1a 32bit ハッシュ（純粋関数・決定的）。
 * Math.random を使わず、文字列から安定した非負整数を得る。
 */
export function fnv1a(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // 32bit FNV prime 乗算を Math.imul で正確に行い、符号なし化する
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 0..1 を 2 桁 16 進に変換する */
function toHex2(v: number): string {
  const n = Math.round(v * 255);
  const clamped = Math.max(0, Math.min(255, n));
  return clamped.toString(16).padStart(2, "0");
}

/**
 * HSL → HEX 変換（純粋関数）。h: 0..360, s/l: 0..1 → "#rrggbb"。
 */
export function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = hue / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return `#${toHex2(r + m)}${toHex2(g + m)}${toHex2(b + m)}`;
}

/**
 * パレットのインデックス（任意整数）から HSL を返す（純粋関数）。
 * 連続インデックスでは色相が黄金角ぶん離れ（隣接色衝突の緩和）、
 * 一巡するごとに明度・彩度が変化して実効色数を稼ぐ。
 */
export function paletteHslForIndex(index: number): Hsl {
  const i = ((index % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE;
  const hueIdx = i % HUE_COUNT;
  const rest = Math.floor(i / HUE_COUNT);
  const lightIdx = rest % LIGHTNESSES.length;
  const satIdx = Math.floor(rest / LIGHTNESSES.length) % SATURATIONS.length;
  return {
    h: (hueIdx * GOLDEN_ANGLE) % 360,
    s: SATURATIONS[satIdx],
    l: LIGHTNESSES[lightIdx],
  };
}

/**
 * NAME → 自然スロット（決定的・純粋関数）。
 *
 * **#385 で意味が変わった**: 起点はパレット全 288 スロット上の位置
 * （`fnv1a(name) % PALETTE_SIZE`）ではなく、**割当候補スロット列
 * （assignableSlots）上の位置**である。羊皮紙下地と判別できないスロットは
 * 起点にもならない。probeAssignSlots / buildColorMapAdditive /
 * remapLowContrastColors のプロービング起点と同じ規則に揃えてある。
 */
export function naturalSlotFor(name: string): number {
  const candidates = assignableSlots();
  return candidates[fnv1a(name) % candidates.length];
}

/**
 * NAME → 割当 HSL（決定的・純粋関数。衝突が無ければ実表示色と一致する）。
 * **#385 以降、起点は割当候補スロット（naturalSlotFor）である**ため、
 * 戻り値は必ず ΔE00 >= EARTH_DELTA_E_MIN を満たす。
 */
export function assignColorHsl(name: string): Hsl {
  return paletteHslForIndex(naturalSlotFor(name));
}

/** NAME → 割当 HEX（決定的・純粋関数） */
export function assignColor(name: string): string {
  const { h, s, l } = assignColorHsl(name);
  return hslToHex(h, s, l);
}

/** 明度シフト量。属領を宗主国と明確に識別できる差をつける */
export const SUBJECT_LIGHTNESS_SHIFT = 0.18;

/**
 * 宗主国のベース色（HSL）から属領用の HSL を作る（純粋関数）。
 * 色相・彩度を保ち、明度だけをずらして「同系色の明度違い」にする。
 * 宗主国が明るめなら暗く、暗めなら明るくして [0,1] に収める。
 */
export function shiftLightnessForSubject(base: Hsl): Hsl {
  const l = base.l >= 0.58
    ? base.l - SUBJECT_LIGHTNESS_SHIFT
    : base.l + SUBJECT_LIGHTNESS_SHIFT;
  return { h: base.h, s: base.s, l };
}

/**
 * 宗主国名 → 属領用の HSL（純粋関数・生ハッシュ起点）。
 * プロービングを介さない自然スロットからの派生で、式（同色相・明度シフト）の単体確認用。
 * buildColorMap 内ではプロービング後の宗主国スロットから派生する。
 */
export function deriveSubjectColorHsl(suzerain: string): Hsl {
  return shiftLightnessForSubject(assignColorHsl(suzerain));
}

/** 宗主国名 → 属領用の HEX（純粋関数・生ハッシュ起点） */
export function deriveSubjectColor(suzerain: string): string {
  const { h, s, l } = deriveSubjectColorHsl(suzerain);
  return hslToHex(h, s, l);
}

// ---- 羊皮紙下地に対するコントラスト制約（Issue #385） ----

/**
 * 判別性の基準面。羊皮紙ベースマップの陸地色（src/parchment_palette.ts）。
 * 勢力の塗りは必ずこの色の上に半透明で載るため、実表示色はここへの合成結果になる。
 * 定義元の HEX からその場でパースする（数値を書き写すと二重管理になる。
 * src/label_contrast_test.ts が basemap の色を引くのと同じやり方）。
 */
const EARTH: Rgb = hexToRgb(PARCHMENT_FLAVOR_OVERRIDES.earth)!;

/**
 * 塗り色 HEX の「実表示色」と素の陸地色の知覚色差 ΔE00（純粋関数）。
 *
 * 画面上の色は deck.gl の getFillColor に [r,g,b,FILL_ALPHA] を渡した結果
 * （src/powers.ts fillColorFor）なので、compositeOver で同じ合成を再現してから
 * 測る。HEX が不正な場合は 0（= 判別不能扱い）を返す。
 */
export function fillDeltaEFromEarth(hex: string): number {
  const rgb = hexToRgb(hex);
  if (rgb === null) return 0;
  return deltaE2000(
    compositeOver([rgb[0], rgb[1], rgb[2], FILL_ALPHA], EARTH),
    EARTH,
  );
}

/** HSL 版の fillDeltaEFromEarth */
export function hslDeltaEFromEarth(hsl: Hsl): number {
  return fillDeltaEFromEarth(hslToHex(hsl.h, hsl.s, hsl.l));
}

/**
 * 塗りが羊皮紙下地と判別できるとみなす ΔE00 の下限（Issue #385）。
 *
 * 決め方は「視認性の問題を確実に解く**最小**の閾値」。閾値を上げるほど再割当て
 * されるキーが増え、ADR-0032 が守ろうとした「既存キーの見た目を動かさない」から
 * 遠ざかるため、大きいほど良い値ではない（閾値候補ごとの実測表は ADR-0041）。
 *
 * 実測された「塗られていないように見える」勢力の ΔE00 は Peshemegs 1.70 /
 * Siberians 1.90 / Netherlands 2.62 / Nogai Horde 4.66 / England and Ireland
 * 4.48 / Ottoman Empire 4.55 / Ilkhanate 5.87 / **Safavid Empire 8.28**。
 * 起票時に列挙された失敗例の最大が 8.28 なので、閾値はこれを確実に超える必要が
 * ある。T=9 では是正後の最小 ΔE00 が 9.04 にしかならず、「壊れている」と判定した
 * 8.28 とほとんど変わらない。T=10 なら是正後の最小が 10.03（失敗例最大の 1.2 倍・
 * 最悪例 Ottoman の 2.2 倍・JND の約 10 倍）になり、かつ起票時の経験則
 * 「ΔE < 12」を式の違いで換算した値（ΔE00 ≒ 10）とも一致する。
 *
 * 割当の成立も確認済み: 候補 193/288 は同年最大キー数 152（1300 年）を 27%
 * 上回る。T=11 以上は LIGHTNESSES 据え置きでは候補が足りず割当が失敗する。
 */
export const EARTH_DELTA_E_MIN = 10;

/**
 * 陸続きの上位勢力どうしに要求する、実表示色の CIEDE2000 色差下限（#438）。
 * 下地との判別閾値と同じ 10 に揃え、「国境を挟んだ別の面」も少なくとも
 * 「塗りと羊皮紙」と同程度には判別できることを保証する。
 */
export const ADJACENT_DELTA_E_MIN = 10;

/** #438 の明示回帰ペア。近似色を離す方向（France=青緑、HRE=黄味オリーブ）。 */
export const TOP_LEVEL_HUE_PREFERENCES: Readonly<Record<string, number>> = {
  France: 180,
  "Holy Roman Empire": 85,
};

/** France の青緑回帰色と既存色差を両立するため同時に可動にする隣接 3 勢力。 */
export const TOP_LEVEL_HUE_COLLATERAL: readonly string[] = [
  "Navarre",
  "Palatinate",
  "Pontremoli",
];

/** 塗り HEX を実描画と同じ source-over で羊皮紙陸地色へ合成する。 */
export function compositeFillColor(hex: string): Rgb | null {
  const rgb = hexToRgb(hex);
  if (rgb === null) return null;
  return compositeOver([rgb[0], rgb[1], rgb[2], FILL_ALPHA], EARTH);
}

/** 2 勢力の塗り HEX 間の、実表示（羊皮紙へ合成後）CIEDE2000 色差。 */
export function adjacentFillDeltaE(a: string, b: string): number {
  const ca = compositeFillColor(a);
  const cb = compositeFillColor(b);
  if (ca === null || cb === null) return 0;
  return deltaE2000(ca, cb);
}

/**
 * パレットスロットが割当候補として使えるか（純粋関数）。
 *
 * ベース色だけでなく**属領の派生色（明度シフト後）も**閾値を満たすことを要求する。
 * 宗主のスロットは属領色の供給元でもあり、片方だけ判別できても意味がないため。
 */
export function isAssignableSlot(slot: number): boolean {
  const base = paletteHslForIndex(slot);
  return hslDeltaEFromEarth(base) >= EARTH_DELTA_E_MIN &&
    hslDeltaEFromEarth(shiftLightnessForSubject(base)) >= EARTH_DELTA_E_MIN;
}

/** assignableSlots() の結果キャッシュ（純粋・定数なので一度計算すれば足りる） */
let assignableSlotsCache: readonly number[] | null = null;

/**
 * 割当候補スロット（昇順）。パレット 288 のうち羊皮紙下地と判別できるものだけ。
 * 候補が 0 の場合はパレット設計が破綻しているので例外で落とす。
 */
export function assignableSlots(): readonly number[] {
  if (assignableSlotsCache !== null) return assignableSlotsCache;
  const slots: number[] = [];
  for (let i = 0; i < PALETTE_SIZE; i++) {
    if (isAssignableSlot(i)) slots.push(i);
  }
  if (slots.length === 0) {
    throw new Error(
      `割当候補スロットが 0 件（ΔE00 >= ${EARTH_DELTA_E_MIN}）。` +
        `SATURATIONS / LIGHTNESSES / EARTH_DELTA_E_MIN の整合が崩れている`,
    );
  }
  assignableSlotsCache = slots;
  return slots;
}

/**
 * 勢力名の集合に決定的にパレットスロットを割り当てる（純粋関数）。
 * - 入力順に依存しないよう内部でソートしてから割り当てる
 * - 割当先は**割当候補スロット（assignableSlots）に限る**（#385）。羊皮紙下地と
 *   判別できないスロットは最初から選ばれない
 * - 各名前は fnv1a の自然位置を起点に、使用済みなら候補列上を線形プロービング
 *   （+1, mod）して最初の空きを取る。名前数 <= 候補数なら全員が相異なる色になる
 * - 名前数が候補数を超えた場合のみ、自然位置の再利用を許容する
 * Math.random 不使用・同一入力なら常に同一出力。
 */
export function probeAssignSlots(names: string[]): Map<string, number> {
  const candidates = assignableSlots();
  const sorted = [...names].sort();
  const used = new Set<number>();
  const result = new Map<string, number>();
  for (const name of sorted) {
    if (result.has(name)) continue;
    let idx = fnv1a(name) % candidates.length;
    if (used.size < candidates.length) {
      while (used.has(idx)) idx = (idx + 1) % candidates.length;
      used.add(idx);
    }
    result.set(name, candidates[idx]);
  }
  return result;
}

/**
 * feature の NAME / SUBJECTO からクライアント参照キーを組み立てる（純粋関数）。
 * SUBJECTO を持ち、かつ自分自身でない場合のみ "NAME|SUBJECTO"（属領キー）。
 * それ以外は NAME（独立勢力キー）。SUBJECTO は生の値（クライアントが持つ値）を使う。
 */
export function compositeKey(name: string, subjecto: string | null): string {
  if (subjecto !== null && subjecto !== "" && subjecto !== name) {
    return `${name}${SUBJECT_KEY_SEP}${subjecto}`;
  }
  return name;
}

/** properties から文字列プロパティを取り出す。空文字・非文字列は null */
function stringProp(
  props: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const v = props?.[key];
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * 色キーに使う SUBJECTO を決める（純粋関数、TASK-94）。
 * overrides.suzerains に NAME の宗主補正があればそれ（renames 正規化後）を、
 * なければ生の SUBJECTO を使う。ランタイム側の
 * src/suzerain_extent.ts applySuzerainOverrides と同一の規則。
 */
function effectiveSubjecto(
  name: string,
  props: Record<string, unknown> | null | undefined,
  overrides: NameOverrides,
): string | null {
  const suzerain = overrides.suzerains?.[name];
  if (suzerain !== undefined) return overrides.renames[suzerain] ?? suzerain;
  return stringProp(props, "SUBJECTO");
}

/** buildColorMap の第 1 パスで抽出する 1 エントリ分の割当情報 */
interface ColorEntry {
  /** クライアント参照キー（NAME または NAME|SUBJECTO） */
  key: string;
  /** ベース色を引く勢力名（独立勢力は自分、属領は正規化した宗主国名） */
  baseName: string;
  /** 属領（宗主国色から明度シフトで派生）なら true */
  subject: boolean;
}

/**
 * 1 feature ぶんの割当情報を組み立てる（純粋関数）。
 * buildColorMap（全量生成）と buildColorMapAdditive（差分追加）で共有する
 * キー・ベース勢力・属領判定の単一の真実。NAME が無い feature は null。
 */
function entryForFeature(
  props: Record<string, unknown> | null | undefined,
  overrides: NameOverrides,
  independentSubjectSuzerains: ReadonlySet<string>,
): ColorEntry | null {
  const name = stringProp(props, "NAME");
  if (name === null) return null;
  const subjecto = effectiveSubjecto(name, props, overrides);
  const key = compositeKey(name, subjecto);
  if (subjecto !== null && subjecto !== name) {
    const suzerain = overrides.renames[subjecto] ?? subjecto;
    // suzerains 補正済みの値は既に正規化されているので renames は no-op
    if (suzerain === name) {
      // 補正前綴りの自己参照 → 属領扱いせずベース色
      return { key, baseName: name, subject: false };
    }
    if (independentSubjectSuzerains.has(suzerain)) {
      // 独立色にする宗主国（HRE 等）配下 → NAME ベースの独立プロービング色
      return { key, baseName: name, subject: false };
    }
    return { key, baseName: suzerain, subject: true };
  }
  return { key, baseName: name, subject: false };
}

/**
 * 「属領でも独立色にする宗主国名」の既定集合（TASK-19）。
 * HRE 領邦オーバーレイ（data/hre_<year>.geojson）は全 feature が
 * SUBJECTO="Holy Roman Empire" のため、従来の「宗主国色の明度シフト」では
 * 全領邦が同色になってしまう。HRE 配下は NAME ベースの独立プロービング色にする。
 */
export const INDEPENDENT_SUBJECT_SUZERAINS: ReadonlySet<string> = new Set([
  "Holy Roman Empire",
]);

/**
 * 全年代の FeatureCollection から色割当マップを組み立てる（純粋関数）。
 * - NAME が null の feature は載せない（クライアント側でデフォルト色）
 * - 独立勢力は決定的プロービングで相異なるパレット色を割り当てる（ハッシュ衝突での同色を回避）
 * - 属領（SUBJECTO を持ち NAME と異なる）は複合キーで、宗主国のプロービング後スロットの
 *   色相を保ち明度をずらした色にする（宗主国の実表示色と同色相ファミリーになる）
 * - SUBJECTO は overrides.renames で正規化してから宗主国色を引く。
 *   正規化後に自分自身へ帰着する自己参照は属領扱いせずベース色にする
 * - 正規化後の宗主国名が independentSubjectSuzerains に入る feature は属領扱いせず、
 *   NAME ベースの独立プロービング色を割り当てる（キーは複合キーのまま）
 */
export function buildColorMap(
  collections: FeatureCollection[],
  overrides: NameOverrides,
  independentSubjectSuzerains: ReadonlySet<string> = new Set(),
): ColorMap {
  // 第 1 パス: 参照キーごとに割当情報を集め、ベース色が必要な勢力名を収集する。
  // 独立勢力の NAME に加え、属領の宗主国名も「色相の供給元」としてスロットを予約する。
  const entries: ColorEntry[] = [];
  const seenKeys = new Set<string>();
  const baseNames = new Set<string>();
  for (const fc of collections) {
    for (const f of fc.features) {
      const entry = entryForFeature(
        f.properties as Record<string, unknown> | null,
        overrides,
        independentSubjectSuzerains,
      );
      if (entry === null || seenKeys.has(entry.key)) continue;
      seenKeys.add(entry.key);
      entries.push(entry);
      baseNames.add(entry.baseName);
    }
  }

  // 第 2 パス: ベース勢力名に決定的プロービングでスロットを割り当てる。
  const slots = probeAssignSlots([...baseNames]);

  // 第 3 パス: キーごとに最終色を確定する。
  const map: ColorMap = {};
  for (const { key, baseName, subject } of entries) {
    const base = paletteHslForIndex(slots.get(baseName)!);
    const hsl = subject ? shiftLightnessForSubject(base) : base;
    map[key] = hslToHex(hsl.h, hsl.s, hsl.l);
  }
  return map;
}

/** 年 1 つぶんのコレクション。差分追加モードの「同年非衝突制約」の単位 */
export interface YearCollection {
  year: number;
  collection: FeatureCollection;
}

/** 名前を辞書順へ正規化した、同一年の上位勢力隣接ペア。 */
export interface TopLevelAdjacencyPair {
  readonly a: string;
  readonly b: string;
}

/** 年代別の上位勢力隣接グラフ（辺だけを保持する）。 */
export interface YearTopLevelAdjacency {
  readonly year: number;
  readonly pairs: readonly TopLevelAdjacencyPair[];
}

interface PowerBoundarySegment {
  readonly a: Position;
  readonly b: Position;
  readonly power: string;
  readonly featureIndex: number;
}

/** 隣接判定用の座標許容差。データの 1e-7 度量子化と同じ桁に置く。 */
const ADJACENCY_EPS_DEG = 1e-7;
/** bbox 空間索引のセル辺。1 年 5〜7 千辺で候補を十分絞れる値。 */
const ADJACENCY_GRID_DEG = 0.25;

/** Polygon / MultiPolygon の全環（穴を含む）を列挙する。 */
function polygonRings(collection: FeatureCollection): PowerBoundarySegment[] {
  const segments: PowerBoundarySegment[] = [];
  collection.features.forEach((feature, featureIndex) => {
    const props = feature.properties as Record<string, unknown> | null;
    const power = typeof props?.__topLevelPower === "string"
      ? props.__topLevelPower
      : null;
    if (power === null) return;
    const geometry = feature.geometry;
    const rings = geometry?.type === "Polygon"
      ? geometry.coordinates
      : geometry?.type === "MultiPolygon"
      ? geometry.coordinates.flat()
      : [];
    for (const ring of rings) {
      for (let i = 1; i < ring.length; i++) {
        const a = ring[i - 1];
        const b = ring[i];
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) <= ADJACENCY_EPS_DEG) {
          continue;
        }
        segments.push({ a, b, power, featureIndex });
      }
    }
  });
  return segments;
}

/** 2 線分が同一直線上で正の長さを共有するか（端点 1 点だけの接触は false）。 */
export function segmentsSharePositiveLength(
  a0: Position,
  a1: Position,
  b0: Position,
  b1: Position,
): boolean {
  const ax = a1[0] - a0[0];
  const ay = a1[1] - a0[1];
  const bx = b1[0] - b0[0];
  const by = b1[1] - b0[1];
  const aLength = Math.hypot(ax, ay);
  const bLength = Math.hypot(bx, by);
  if (aLength <= ADJACENCY_EPS_DEG || bLength <= ADJACENCY_EPS_DEG) {
    return false;
  }
  const distanceFromALine = (p: Position) =>
    Math.abs(ax * (p[1] - a0[1]) - ay * (p[0] - a0[0])) / aLength;
  if (
    distanceFromALine(b0) > ADJACENCY_EPS_DEG ||
    distanceFromALine(b1) > ADJACENCY_EPS_DEG
  ) return false;

  // 数値的に安定する長い軸へ射影して重なり長を測る。
  const axis = Math.abs(ax) >= Math.abs(ay) ? 0 : 1;
  const aMin = Math.min(a0[axis], a1[axis]);
  const aMax = Math.max(a0[axis], a1[axis]);
  const bMin = Math.min(b0[axis], b1[axis]);
  const bMax = Math.max(b0[axis], b1[axis]);
  return Math.min(aMax, bMax) - Math.max(aMin, bMin) > ADJACENCY_EPS_DEG;
}

function segmentCells(segment: PowerBoundarySegment): string[] {
  const minX = Math.floor(
    Math.min(segment.a[0], segment.b[0]) / ADJACENCY_GRID_DEG,
  );
  const maxX = Math.floor(
    Math.max(segment.a[0], segment.b[0]) / ADJACENCY_GRID_DEG,
  );
  const minY = Math.floor(
    Math.min(segment.a[1], segment.b[1]) / ADJACENCY_GRID_DEG,
  );
  const maxY = Math.floor(
    Math.max(segment.a[1], segment.b[1]) / ADJACENCY_GRID_DEG,
  );
  const cells: string[] = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) cells.push(`${x},${y}`);
  }
  return cells;
}

/**
 * base 1 年分から、正の長さを持つ内陸境界を共有する上位勢力ペアを列挙する。
 *
 * 上位勢力はランタイムの概観塗りと同じ「宗主補正 > SUBJECTO > NAME」で解決
 * する。異なる feature の境界線分が共線で正長に重なる場合だけを辺にするため、
 * 点接触・海峡越し・沿岸外周は入らない。長辺の途中に頂点がある T 字接合も
 * 線分の部分重なりとして拾う。返り値は入力 feature 順に依存しない辞書順。
 */
export function buildTopLevelAdjacencyPairs(
  collection: FeatureCollection,
  overrides: NameOverrides,
): TopLevelAdjacencyPair[] {
  // polygonRings を小さく保つため、一時 properties に解決済みキーを載せた浅い
  // コピーを作る。元 collection / properties は変更しない。
  const keyed: FeatureCollection = {
    ...collection,
    features: collection.features.map((feature) => {
      const props = feature.properties as Record<string, unknown> | null;
      const name = stringProp(props, "NAME");
      if (name === null) return feature;
      const subjecto = effectiveSubjecto(name, props, overrides);
      const power = subjecto === null
        ? name
        : overrides.renames[subjecto] ?? subjecto;
      return {
        ...feature,
        properties: { ...props, __topLevelPower: power },
      };
    }),
  };
  const segments = polygonRings(keyed);
  const grid = new Map<string, number[]>();
  segments.forEach((segment, index) => {
    for (const cell of segmentCells(segment)) {
      const bucket = grid.get(cell);
      if (bucket === undefined) grid.set(cell, [index]);
      else bucket.push(index);
    }
  });

  const pairKeys = new Set<string>();
  for (let i = 0; i < segments.length; i++) {
    const left = segments[i];
    const candidates = new Set<number>();
    for (const cell of segmentCells(left)) {
      for (const j of grid.get(cell) ?? []) if (j > i) candidates.add(j);
    }
    for (const j of candidates) {
      const right = segments[j];
      if (
        left.featureIndex === right.featureIndex ||
        left.power === right.power ||
        !segmentsSharePositiveLength(left.a, left.b, right.a, right.b)
      ) continue;
      const [a, b] = left.power < right.power
        ? [left.power, right.power]
        : [right.power, left.power];
      pairKeys.add(`${a}\u0000${b}`);
    }
  }
  return [...pairKeys].sort().map((key) => {
    const [a, b] = key.split("\u0000");
    return { a, b };
  });
}

/** 全対象年代の上位勢力隣接グラフを、年・勢力名の辞書順で返す。 */
export function buildTopLevelAdjacencyGraph(
  years: YearCollection[],
  overrides: NameOverrides,
): YearTopLevelAdjacency[] {
  return [...years].sort((a, b) => a.year - b.year).map((
    { year, collection },
  ) => ({
    year,
    pairs: buildTopLevelAdjacencyPairs(collection, overrides),
  }));
}

/** buildColorMapAdditive のオプション */
export interface AdditiveOptions {
  /**
   * true のとき、現行データに存在しなくなったスナップショットのキー
   * （900 年廃止由来等）を出力から取り除く。既定 false（保持）。
   * クライアントは colors.json に無いキーをデフォルト色で縮退させるため
   * 削除自体は安全だが、既定は「実行しても diff ゼロ」を優先する。
   */
  prune?: boolean;
}

/** パレット全 288 色の HEX → スロット番号の逆引きマップ（全 HEX は一意） */
function paletteHexToSlot(): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < PALETTE_SIZE; i++) {
    const { h, s, l } = paletteHslForIndex(i);
    map.set(hslToHex(h, s, l), i);
  }
  return map;
}

/** HEX → HSL の数値変換。パレット逆引きで解決できない色（派生色等）の縮退用 */
function hexToHsl(hex: string): Hsl {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h, s, l };
}

/**
 * 差分追加モード（Issue #193・#172 追加限定方式の正式化）。純粋関数。
 *
 * snapshot（既存 data/colors.json）を正とし、既存キーの色は一切変えない。
 * 現行データに現れた新キーだけを次の決定的規則で追加する:
 * - 新しいベース勢力名は fnv1a の自然スロットを起点に線形プロービング（+1, mod）。
 *   制約は「同年非衝突」: その勢力が現れるいずれかの年に既に表示される色とは
 *   同色にしない。年が交差しない既存色との一致（パレット再利用）は許容する
 *   （パレット 288 色はほぼ使用済みのため、全域一意は構造的に成立しない）。
 * - 新しい属領キーは、宗主国のスナップショット色をパレット逆引きして HSL に
 *   戻し、明度シフトで派生させる（宗主国の実表示色と同色相ファミリー）。
 * - 全候補が同年衝突する場合のみ自然スロットへ縮退する（決定性を優先）。
 * 入力順に依存しない（キー・ベース名ともソート順に処理する）。
 */
export function buildColorMapAdditive(
  snapshot: ColorMap,
  yearCollections: YearCollection[],
  overrides: NameOverrides,
  independentSubjectSuzerains: ReadonlySet<string> = new Set(),
  options: AdditiveOptions = {},
): ColorMap {
  // 第 1 パス: 現行データのキー → 割当情報・出現年集合を収集する。
  const entryByKey = new Map<string, ColorEntry>();
  const yearsByKey = new Map<string, Set<number>>();
  for (const { year, collection } of yearCollections) {
    for (const f of collection.features) {
      const entry = entryForFeature(
        f.properties as Record<string, unknown> | null,
        overrides,
        independentSubjectSuzerains,
      );
      if (entry === null) continue;
      if (!entryByKey.has(entry.key)) entryByKey.set(entry.key, entry);
      let years = yearsByKey.get(entry.key);
      if (years === undefined) {
        years = new Set<number>();
        yearsByKey.set(entry.key, years);
      }
      years.add(year);
    }
  }

  // 第 2 パス: スナップショットの既存キーを無条件で引き継ぐ（prune 時は
  // 現行データに存在するキーのみ）。
  const result: ColorMap = {};
  for (const key of Object.keys(snapshot)) {
    if (options.prune === true && !entryByKey.has(key)) continue;
    result[key] = snapshot[key];
  }

  // 第 3 パス: 年 → その年に表示される既存色の集合（同年非衝突制約の判定材料）。
  const colorsByYear = new Map<number, Set<string>>();
  const addYearColor = (year: number, hex: string) => {
    let colors = colorsByYear.get(year);
    if (colors === undefined) {
      colors = new Set<string>();
      colorsByYear.set(year, colors);
    }
    colors.add(hex);
  };
  for (const [key, years] of yearsByKey) {
    const hex = result[key];
    if (hex === undefined) continue;
    for (const year of years) addYearColor(year, hex);
  }

  const hexToSlot = paletteHexToSlot();
  const newKeys = [...entryByKey.keys()].filter((key) => !(key in result))
    .sort();

  // 第 4 パス: 新キーが参照するベース勢力名の HSL を解決する。
  // 既存の実表示色（プロービング後）から逆引きし、無ければ新規にプロービングする。
  const baseHslByName = new Map<string, Hsl>();
  const resolveFromExisting = (baseName: string): Hsl | null => {
    // ① ベース勢力名そのものの独立キー
    const direct = result[baseName];
    if (direct !== undefined) {
      const slot = hexToSlot.get(direct);
      return slot !== undefined ? paletteHslForIndex(slot) : hexToHsl(direct);
    }
    // ② 同じベース勢力名を持つ既存のベース色キー（複合キーの独立色等）
    for (const key of Object.keys(result).sort()) {
      const entry = entryByKey.get(key);
      if (entry === undefined || entry.subject || entry.baseName !== baseName) {
        continue;
      }
      const hex = result[key];
      const slot = hexToSlot.get(hex);
      return slot !== undefined ? paletteHslForIndex(slot) : hexToHsl(hex);
    }
    return null;
  };

  // 新規プロービングが必要なベース勢力名と、その制約材料（出現年・用途）を集める。
  const pending = new Map<
    string,
    { years: Set<number>; baseUse: boolean; subjectUse: boolean }
  >();
  for (const key of newKeys) {
    const entry = entryByKey.get(key)!;
    if (baseHslByName.has(entry.baseName)) continue;
    const existing = resolveFromExisting(entry.baseName);
    if (existing !== null) {
      baseHslByName.set(entry.baseName, existing);
      continue;
    }
    let info = pending.get(entry.baseName);
    if (info === undefined) {
      info = { years: new Set<number>(), baseUse: false, subjectUse: false };
      pending.set(entry.baseName, info);
    }
    for (const year of yearsByKey.get(key) ?? []) info.years.add(year);
    if (entry.subject) info.subjectUse = true;
    else info.baseUse = true;
  }

  const candidates = assignableSlots();
  for (const baseName of [...pending.keys()].sort()) {
    const info = pending.get(baseName)!;
    const start = fnv1a(baseName) % candidates.length;
    let chosen: number | null = null;
    for (let d = 0; d < candidates.length; d++) {
      const slot = candidates[(start + d) % candidates.length];
      const base = paletteHslForIndex(slot);
      const rawHex = hslToHex(base.h, base.s, base.l);
      const shifted = shiftLightnessForSubject(base);
      const derivedHex = hslToHex(shifted.h, shifted.s, shifted.l);
      let conflict = false;
      for (const year of info.years) {
        const colors = colorsByYear.get(year);
        if (colors === undefined) continue;
        if (
          (info.baseUse && colors.has(rawHex)) ||
          (info.subjectUse && colors.has(derivedHex))
        ) {
          conflict = true;
          break;
        }
      }
      if (!conflict) {
        chosen = slot;
        break;
      }
    }
    if (chosen === null) {
      // #385: 従来は自然スロットへ縮退していたが、候補は「羊皮紙下地と判別
      // できるスロット」に絞られたため、全滅は縮退で誤魔化してよい状態ではない
      // （同年に同色が出るか、下地に埋もれるかのどちらかを選ぶことになる）。
      // パレット設計の破綻として落とし、テストで検出できるようにする。
      throw new Error(
        `${baseName}: 同年非衝突を満たす割当候補が枯渇した` +
          `（候補 ${candidates.length} 件・出現年 ${[...info.years].sort()}）`,
      );
    }
    const base = paletteHslForIndex(chosen);
    baseHslByName.set(baseName, base);
    // 後続のプロービングが同年で同色を選ばないよう、実表示色を予約する。
    const rawHex = hslToHex(base.h, base.s, base.l);
    const shifted = shiftLightnessForSubject(base);
    const derivedHex = hslToHex(shifted.h, shifted.s, shifted.l);
    for (const year of info.years) {
      if (info.baseUse) addYearColor(year, rawHex);
      if (info.subjectUse) addYearColor(year, derivedHex);
    }
  }

  // 第 5 パス: 新キーの色を確定する。
  for (const key of newKeys) {
    const entry = entryByKey.get(key)!;
    const base = baseHslByName.get(entry.baseName)!;
    const hsl = entry.subject ? shiftLightnessForSubject(base) : base;
    result[key] = hslToHex(hsl.h, hsl.s, hsl.l);
  }
  return result;
}

/**
 * 参照キー文字列から割当情報を復元する（純粋関数、#385）。
 *
 * entryForFeature が feature から作るのに対し、こちらは既存 colors.json の
 * キーから作る。キーは compositeKey が組み立てた "NAME" / "NAME|SUBJECTO" で、
 * SUBJECTO は既に suzerains 補正後の値なので、renames 正規化と
 * independentSubjectSuzerains 判定だけで entryForFeature と同じ結論になる。
 * 現行データに現れないスナップショット固有のキー（900 年廃止由来等）も扱える。
 */
export function entryForKey(
  key: string,
  overrides: NameOverrides,
  independentSubjectSuzerains: ReadonlySet<string>,
): { key: string; baseName: string; subject: boolean } {
  const sep = key.indexOf(SUBJECT_KEY_SEP);
  if (sep < 0) return { key, baseName: key, subject: false };
  const name = key.slice(0, sep);
  const subjecto = key.slice(sep + SUBJECT_KEY_SEP.length);
  const suzerain = overrides.renames[subjecto] ?? subjecto;
  if (suzerain === name || independentSubjectSuzerains.has(suzerain)) {
    return { key, baseName: name, subject: false };
  }
  return { key, baseName: suzerain, subject: true };
}

/**
 * 低コントラストキーの一回限りの是正パス（#385・ADR-0041）。純粋関数。
 *
 * ADR-0032 は既存キーを無条件でバイト単位保持すると定めるが、「下地と判別
 * できない」キーは**そもそも見えていない**ため保全すべき見た目が無い。
 * 機械的判定（fillDeltaEFromEarth < EARTH_DELTA_E_MIN）を満たす閉じた集合だけを
 * 再割当てし、それ以外のキーは 1 バイトも変えない。
 *
 * 再割当ての単位は**ベース勢力名**である（個々のキーではない）。属領色は宗主の
 * 色から明度シフトで導出されるため、宗主が動けば属領も新しい宗主色から再導出
 * しないと親子関係（同色相ファミリー）が壊れる。逆に属領色だけが閾値未満の
 * 場合も宗主ごと動かす（宗主の色を据え置いたまま属領だけ別色相にはできない）。
 * したがって「変更されるキー」は違反キーそのものより多くなりうる。
 *
 * 新しいスロットは fnv1a の自然位置から候補列（assignableSlots）を線形
 * プロービングし、ADR-0032 と同じ同年非衝突制約（据え置いたキーの色・先に
 * 再割当てしたベース名の色と同年で衝突しない）を満たす最初のものを取る。
 * 全滅した場合は縮退せず例外で落とす。
 */
export function remapLowContrastColors(
  snapshot: ColorMap,
  yearCollections: YearCollection[],
  overrides: NameOverrides,
  independentSubjectSuzerains: ReadonlySet<string> = new Set(),
): ColorMap {
  // 第 1 パス: 現行データからキー → 出現年集合（同年非衝突制約の判定材料）。
  const yearsByKey = new Map<string, Set<number>>();
  for (const { year, collection } of yearCollections) {
    for (const f of collection.features) {
      const entry = entryForFeature(
        f.properties as Record<string, unknown> | null,
        overrides,
        independentSubjectSuzerains,
      );
      if (entry === null) continue;
      let years = yearsByKey.get(entry.key);
      if (years === undefined) {
        years = new Set<number>();
        yearsByKey.set(entry.key, years);
      }
      years.add(year);
    }
  }

  // 第 2 パス: スナップショットの全キーをベース勢力名でグルーピングする。
  const keysByBase = new Map<string, ColorEntry[]>();
  for (const key of Object.keys(snapshot).sort()) {
    const entry = entryForKey(key, overrides, independentSubjectSuzerains);
    let list = keysByBase.get(entry.baseName);
    if (list === undefined) {
      list = [];
      keysByBase.set(entry.baseName, list);
    }
    list.push(entry);
  }

  // 第 3 パス: 配下のキーに 1 つでも閾値未満があるベース名を対象にする。
  const targets = new Set<string>();
  for (const [baseName, entries] of keysByBase) {
    const violates = entries.some((e) =>
      fillDeltaEFromEarth(snapshot[e.key]) < EARTH_DELTA_E_MIN
    );
    if (violates) targets.add(baseName);
  }

  // 第 4 パス: 対象外キーを据え置き、その色を年ごとに予約する。
  const result: ColorMap = {};
  const colorsByYear = new Map<number, Set<string>>();
  const addYearColor = (year: number, hex: string) => {
    let colors = colorsByYear.get(year);
    if (colors === undefined) {
      colors = new Set<string>();
      colorsByYear.set(year, colors);
    }
    colors.add(hex);
  };
  for (const [baseName, entries] of keysByBase) {
    if (targets.has(baseName)) continue;
    for (const e of entries) {
      result[e.key] = snapshot[e.key];
      for (const year of yearsByKey.get(e.key) ?? []) {
        addYearColor(year, snapshot[e.key]);
      }
    }
  }

  // 第 5 パス: 対象ベース名を決定的順序（名前のソート順）で再割当てする。
  const candidates = assignableSlots();
  for (const baseName of [...targets].sort()) {
    const entries = keysByBase.get(baseName)!;
    const years = new Set<number>();
    let baseUse = false;
    let subjectUse = false;
    for (const e of entries) {
      for (const year of yearsByKey.get(e.key) ?? []) years.add(year);
      if (e.subject) subjectUse = true;
      else baseUse = true;
    }
    const start = fnv1a(baseName) % candidates.length;
    let chosen: number | null = null;
    for (let d = 0; d < candidates.length; d++) {
      const slot = candidates[(start + d) % candidates.length];
      const base = paletteHslForIndex(slot);
      const rawHex = hslToHex(base.h, base.s, base.l);
      const shifted = shiftLightnessForSubject(base);
      const derivedHex = hslToHex(shifted.h, shifted.s, shifted.l);
      let conflict = false;
      for (const year of years) {
        const colors = colorsByYear.get(year);
        if (colors === undefined) continue;
        if (
          (baseUse && colors.has(rawHex)) ||
          (subjectUse && colors.has(derivedHex))
        ) {
          conflict = true;
          break;
        }
      }
      if (!conflict) {
        chosen = slot;
        break;
      }
    }
    if (chosen === null) {
      throw new Error(
        `${baseName}: remap 時に同年非衝突を満たす割当候補が枯渇した` +
          `（候補 ${candidates.length} 件・出現年 ${[...years].sort()}）`,
      );
    }
    const base = paletteHslForIndex(chosen);
    const rawHex = hslToHex(base.h, base.s, base.l);
    const shifted = shiftLightnessForSubject(base);
    const derivedHex = hslToHex(shifted.h, shifted.s, shifted.l);
    for (const e of entries) result[e.key] = e.subject ? derivedHex : rawHex;
    for (const year of years) {
      if (baseUse) addYearColor(year, rawHex);
      if (subjectUse) addYearColor(year, derivedHex);
    }
  }
  return result;
}

interface TopLevelPowerUsage {
  readonly power: string;
  readonly baseName: string;
  /** true: 宗主キー不在時のランタイム fallback が属領派生色を表示する。 */
  readonly subject: boolean;
  /** 入力スナップショットで実際に表示される色（同一宗主内の一貫性検査用）。 */
  readonly snapshotHex: string;
  readonly years: Set<number>;
}

/**
 * 実描画で上位勢力に使われる色の種類を解決する。
 * colors[宗主キー] があれば概観塗りは必ずそのベース色を使う。無い場合
 * （Austria など）は feature 自身の複合キーへ fallback し、宗主ファミリーの
 * 属領派生色が表示される。実データで同じ宗主が複数種類へ割れる場合は、
 * 「上位勢力が同色」という前提が壊れているので例外にする。
 */
function topLevelPowerUsages(
  snapshot: ColorMap,
  baseYears: YearCollection[],
  overrides: NameOverrides,
  independentSubjectSuzerains: ReadonlySet<string>,
): Map<string, TopLevelPowerUsage> {
  const usages = new Map<string, TopLevelPowerUsage>();
  for (const { year, collection } of baseYears) {
    for (const feature of collection.features) {
      const props = feature.properties as Record<string, unknown> | null;
      const name = stringProp(props, "NAME");
      if (name === null) continue;
      const subjecto = effectiveSubjecto(name, props, overrides);
      const power = subjecto === null
        ? name
        : overrides.renames[subjecto] ?? subjecto;
      const direct = snapshot[power];
      const entry = direct === undefined
        ? entryForFeature(props, overrides, independentSubjectSuzerains)
        : entryForKey(power, overrides, independentSubjectSuzerains);
      if (entry === null) continue;
      if (direct === undefined && snapshot[entry.key] === undefined) {
        throw new Error(
          `${year}: ${power} の概観表示色キー ${entry.key} が colors.json に無い`,
        );
      }
      const snapshotHex = direct ?? snapshot[entry.key];
      const before = usages.get(power);
      if (before === undefined) {
        usages.set(power, {
          power,
          baseName: entry.baseName,
          subject: direct === undefined && entry.subject,
          snapshotHex,
          years: new Set([year]),
        });
        continue;
      }
      if (
        before.baseName !== entry.baseName ||
        before.subject !== (direct === undefined && entry.subject) ||
        before.snapshotHex !== snapshotHex
      ) {
        throw new Error(
          `${power}: 概観表示色が同一ファミリーへ解決しない` +
            `（${before.baseName}/${before.subject}/${before.snapshotHex} と ` +
            `${entry.baseName}/${entry.subject}/${snapshotHex}）`,
        );
      }
      before.years.add(year);
    }
  }
  return usages;
}

function displayHexForUsage(
  usage: TopLevelPowerUsage,
  map: ColorMap,
  keysByBase: Map<string, ColorEntry[]>,
): string | null {
  const direct = map[usage.power];
  if (direct !== undefined) return direct;
  const entry = keysByBase.get(usage.baseName)?.find((candidate) =>
    candidate.subject === usage.subject && map[candidate.key] !== undefined
  );
  return entry === undefined ? null : map[entry.key];
}

/** 実描画と同じ規則で、上位勢力 1 件の表示 HEX を返す（監査用の純粋関数）。 */
export function topLevelDisplayColor(
  snapshot: ColorMap,
  baseYears: YearCollection[],
  overrides: NameOverrides,
  power: string,
  independentSubjectSuzerains: ReadonlySet<string> = new Set(),
): string | null {
  const usages = topLevelPowerUsages(
    snapshot,
    baseYears,
    overrides,
    independentSubjectSuzerains,
  );
  const keysByBase = new Map<string, ColorEntry[]>();
  for (const key of Object.keys(snapshot).sort()) {
    const entry = entryForKey(key, overrides, independentSubjectSuzerains);
    const entries = keysByBase.get(entry.baseName);
    if (entries === undefined) keysByBase.set(entry.baseName, [entry]);
    else entries.push(entry);
  }
  const usage = usages.get(power);
  return usage === undefined
    ? null
    : displayHexForUsage(usage, snapshot, keysByBase);
}

/**
 * 陸続きの上位勢力間色差を一回限り是正する（#438）。
 *
 * 初期違反辺の両端（+ France の明示色相を成立させる隣接 3 勢力）だけを対象に
 * する。対象ファミリーは自然スロットから決定的にプローブし、同年色一意性・
 * 羊皮紙色差・全隣接色差を同時に満たす候補へ移す。属領キーは宗主色から
 * 再導出するため、既存の色ファミリー契約も維持する。
 */
export function remapAdjacentTopLevelColors(
  snapshot: ColorMap,
  allYears: YearCollection[],
  baseYears: YearCollection[],
  graph: YearTopLevelAdjacency[],
  overrides: NameOverrides,
  independentSubjectSuzerains: ReadonlySet<string> = new Set(),
): ColorMap {
  const usages = topLevelPowerUsages(
    snapshot,
    baseYears,
    overrides,
    independentSubjectSuzerains,
  );
  const keysByBase = new Map<string, ColorEntry[]>();
  for (const key of Object.keys(snapshot).sort()) {
    const entry = entryForKey(key, overrides, independentSubjectSuzerains);
    const entries = keysByBase.get(entry.baseName);
    if (entries === undefined) keysByBase.set(entry.baseName, [entry]);
    else entries.push(entry);
  }

  const uniquePairs = new Map<string, TopLevelAdjacencyPair>();
  for (const { pairs } of graph) {
    for (const pair of pairs) uniquePairs.set(`${pair.a}\u0000${pair.b}`, pair);
  }
  const violations = [...uniquePairs.entries()].filter(([, pair]) => {
    const aUsage = usages.get(pair.a);
    const bUsage = usages.get(pair.b);
    if (aUsage === undefined || bUsage === undefined) {
      throw new Error(
        `${pair.a}–${pair.b}: 上位勢力の表示色用途を解決できない`,
      );
    }
    const a = displayHexForUsage(aUsage, snapshot, keysByBase);
    const b = displayHexForUsage(bUsage, snapshot, keysByBase);
    if (a === null || b === null) {
      throw new Error(`${pair.a}–${pair.b}: 上位勢力の表示色を解決できない`);
    }
    return adjacentFillDeltaE(a, b) < ADJACENT_DELTA_E_MIN;
  }).sort(([a], [b]) => a.localeCompare(b));
  if (violations.length === 0) return { ...snapshot };

  // 初期違反辺の端点だけを対象にする。片端だけの頂点被覆へ絞ると、その頂点が
  // 多数の年代で持つ「既に合格している隣接色」を全て避ける候補が無くなることが
  // ある。両端を可動にすれば解空間を確保できる。唯一の追加例外は、明示された
  // France の青緑色相を成立させる TOP_LEVEL_HUE_COLLATERAL の 3 勢力。
  const targetPowers = new Set<string>();
  for (const [, pair] of violations) {
    targetPowers.add(pair.a);
    targetPowers.add(pair.b);
  }
  for (const power of TOP_LEVEL_HUE_COLLATERAL) {
    if (usages.has(power)) targetPowers.add(power);
  }
  const targetBases = new Set(
    [...targetPowers].map((power) => usages.get(power)!.baseName),
  );

  // 全データキーの出現年を集める（既存の同年非衝突契約と同じ母集団）。
  const yearsByKey = new Map<string, Set<number>>();
  for (const { year, collection } of allYears) {
    for (const feature of collection.features) {
      const entry = entryForFeature(
        feature.properties as Record<string, unknown> | null,
        overrides,
        independentSubjectSuzerains,
      );
      if (entry === null) continue;
      const years = yearsByKey.get(entry.key);
      if (years === undefined) yearsByKey.set(entry.key, new Set([year]));
      else years.add(year);
    }
  }

  const result: ColorMap = {};
  const colorsByYear = new Map<number, Set<string>>();
  const addYearColor = (year: number, hex: string) => {
    const colors = colorsByYear.get(year);
    if (colors === undefined) colorsByYear.set(year, new Set([hex]));
    else colors.add(hex);
  };
  for (const [baseName, entries] of keysByBase) {
    if (targetBases.has(baseName)) continue;
    for (const entry of entries) {
      result[entry.key] = snapshot[entry.key];
      for (const year of yearsByKey.get(entry.key) ?? []) {
        addYearColor(year, snapshot[entry.key]);
      }
    }
  }

  const candidates = assignableSlots();
  const adjacencyDegree = (baseName: string): number => {
    const powers = new Set(
      [...usages.values()].filter((usage) => usage.baseName === baseName).map(
        (usage) => usage.power,
      ),
    );
    const neighbors = new Set<string>();
    for (const pair of uniquePairs.values()) {
      if (powers.has(pair.a)) neighbors.add(pair.b);
      if (powers.has(pair.b)) neighbors.add(pair.a);
    }
    return neighbors.size;
  };
  const targetOrder = [...targetBases].sort((a, b) => {
    const aRegression = TOP_LEVEL_HUE_PREFERENCES[a] === undefined ? 1 : 0;
    const bRegression = TOP_LEVEL_HUE_PREFERENCES[b] === undefined ? 1 : 0;
    return aRegression - bRegression ||
      adjacencyDegree(b) - adjacencyDegree(a) || a.localeCompare(b);
  });
  for (const baseName of targetOrder) {
    const entries = keysByBase.get(baseName);
    if (entries === undefined) {
      throw new Error(`${baseName}: 色ファミリーが無い`);
    }
    const baseYears = new Set<number>();
    const subjectYears = new Set<number>();
    for (const entry of entries) {
      for (const year of yearsByKey.get(entry.key) ?? []) {
        (entry.subject ? subjectYears : baseYears).add(year);
      }
    }
    const start = fnv1a(baseName) % candidates.length;
    const preferredHue = TOP_LEVEL_HUE_PREFERENCES[baseName];
    const orderedCandidates = Array.from(
      { length: candidates.length },
      (_, offset) => candidates[(start + offset) % candidates.length],
    );
    if (preferredHue !== undefined) {
      const hueDistance = (slot: number) => {
        const diff = Math.abs(paletteHslForIndex(slot).h - preferredHue);
        return Math.min(diff, 360 - diff);
      };
      orderedCandidates.sort((a, b) => hueDistance(a) - hueDistance(b));
    }
    let chosen: number | null = null;
    let chosenRank: readonly number[] | null = null;
    for (const [candidateOrder, slot] of orderedCandidates.entries()) {
      const hsl = paletteHslForIndex(slot);
      const rawHex = hslToHex(hsl.h, hsl.s, hsl.l);
      const shifted = shiftLightnessForSubject(hsl);
      const derivedHex = hslToHex(shifted.h, shifted.s, shifted.l);
      let conflict = false;
      for (const year of baseYears) {
        const reserved = colorsByYear.get(year);
        if (reserved?.has(rawHex)) {
          conflict = true;
          break;
        }
      }
      if (!conflict) {
        for (const year of subjectYears) {
          if (colorsByYear.get(year)?.has(derivedHex)) {
            conflict = true;
            break;
          }
        }
      }
      if (conflict) continue;

      // 既に色が確定した隣接勢力との ΔE00 を検査する。未割当の対象隣接勢力は
      // その勢力を処理するときに逆向きで検査される。
      const powersForBase = [...usages.values()].filter((usage) =>
        usage.baseName === baseName
      );
      for (const selfUsage of powersForBase) {
        for (const pair of uniquePairs.values()) {
          const neighbor = pair.a === selfUsage.power
            ? pair.b
            : pair.b === selfUsage.power
            ? pair.a
            : null;
          if (neighbor === null) continue;
          const neighborUsage = usages.get(neighbor)!;
          const neighborHex = displayHexForUsage(
            neighborUsage,
            result,
            keysByBase,
          );
          if (neighborHex === null) continue;
          const selfHex = selfUsage.subject ? derivedHex : rawHex;
          if (
            adjacentFillDeltaE(selfHex, neighborHex) < ADJACENT_DELTA_E_MIN
          ) {
            conflict = true;
            break;
          }
        }
        if (conflict) break;
      }
      if (conflict) continue;

      // 未割当の隣接勢力が現在色を保てる候補を優先する（least-constraining
      // value）。これを入れないと、早い頂点の任意選択で後段の候補を全滅させる。
      let futureConflicts = 0;
      for (const selfUsage of powersForBase) {
        const selfHex = selfUsage.subject ? derivedHex : rawHex;
        for (const pair of uniquePairs.values()) {
          const neighbor = pair.a === selfUsage.power
            ? pair.b
            : pair.b === selfUsage.power
            ? pair.a
            : null;
          if (neighbor === null) continue;
          const neighborUsage = usages.get(neighbor)!;
          if (!targetBases.has(neighborUsage.baseName)) continue;
          if (
            displayHexForUsage(neighborUsage, result, keysByBase) !== null
          ) continue;
          const current = displayHexForUsage(
            neighborUsage,
            snapshot,
            keysByBase,
          );
          if (
            current !== null &&
            adjacentFillDeltaE(selfHex, current) < ADJACENT_DELTA_E_MIN
          ) futureConflicts++;
        }
      }
      const hue = paletteHslForIndex(slot).h;
      const hueDiff = preferredHue === undefined ? 0 : Math.min(
        Math.abs(hue - preferredHue),
        360 - Math.abs(hue - preferredHue),
      );
      // 明示回帰色は目標色相 ±25° の候補を最優先し、その帯の中で後続を最も
      // 縛らない色を選ぶ。一般勢力は将来衝突数 → 自然プローブ順。
      const rank = preferredHue === undefined
        ? [futureConflicts, candidateOrder]
        : [hueDiff <= 45 ? 0 : 1, hueDiff, futureConflicts, candidateOrder];
      if (
        chosenRank === null || rank.some((value, i) =>
          value < chosenRank![i] &&
          rank.slice(0, i).every((prefix, j) => prefix === chosenRank![j])
        )
      ) {
        chosen = slot;
        chosenRank = rank;
      }
    }
    if (chosen === null) {
      throw new Error(
        `${baseName}: 隣接色差と同年非衝突を満たす候補が枯渇した` +
          `（候補 ${candidates.length} 件）`,
      );
    }
    const hsl = paletteHslForIndex(chosen);
    const rawHex = hslToHex(hsl.h, hsl.s, hsl.l);
    const shifted = shiftLightnessForSubject(hsl);
    const derivedHex = hslToHex(shifted.h, shifted.s, shifted.l);
    for (const entry of entries) {
      result[entry.key] = entry.subject ? derivedHex : rawHex;
    }
    for (const year of baseYears) addYearColor(year, rawHex);
    for (const year of subjectYears) addYearColor(year, derivedHex);
  }

  // アルゴリズム全体の後条件。貪欲順の見落としを成果物へ持ち込まない。
  for (const pair of uniquePairs.values()) {
    const a = displayHexForUsage(usages.get(pair.a)!, result, keysByBase);
    const b = displayHexForUsage(usages.get(pair.b)!, result, keysByBase);
    if (
      a === null || b === null ||
      adjacentFillDeltaE(a, b) < ADJACENT_DELTA_E_MIN
    ) {
      throw new Error(`${pair.a}–${pair.b}: 再割当て後も隣接色差が不足`);
    }
  }
  return result;
}

/** キーをソートした安定な ColorMap を返す（diff を安定させる） */
function sortColorMap(map: ColorMap): ColorMap {
  const sorted: ColorMap = {};
  for (const key of Object.keys(map).sort()) sorted[key] = map[key];
  return sorted;
}

/** name-overrides.json を読み込む。存在しなければ空のマップを返す */
async function loadOverrides(path: string): Promise<NameOverrides> {
  try {
    const data = JSON.parse(await Deno.readTextFile(path));
    const renames = data && typeof data === "object" && data.renames &&
        typeof data.renames === "object"
      ? data.renames as Record<string, string>
      : {};
    const suzerains = data && typeof data === "object" && data.suzerains &&
        typeof data.suzerains === "object"
      ? data.suzerains as Record<string, string>
      : {};
    return { renames, suzerains };
  } catch {
    return { renames: {}, suzerains: {} };
  }
}

/**
 * data/europe_<year>.geojson を全年代ぶんと、存在する data/hre_<year>.geojson
 * （HRE 主要領邦オーバーレイ・`deno task build-hre` で生成）・
 * data/france_fiefs_<year>.geojson（中世フランス諸侯領オーバーレイ・
 * `deno task build-france-fiefs` で生成、TASK-71）・
 * data/hre_fiefs_<year>.geojson（中世 HRE 領邦オーバーレイ・
 * `deno task build-hre-fiefs` で生成、TASK-85/86）を読み込む。
 *
 * 中世 HRE 領邦は近世の hre_<year> と同じく全 feature が SUBJECTO="Holy Roman
 * Empire" なので、INDEPENDENT_SUBJECT_SUZERAINS により NAME ベースの独立色に
 * なる（複合キー "NAME|Holy Roman Empire" のまま色だけ独立プロービング）。
 * 参照は生データ側で十分: flat（scripts/build-fief-flat.ts）はジオメトリだけを
 * 変え、NAME / SUBJECTO は生データと同一のため色キーは変わらない。
 *
 * フランス諸侯領は SUBJECTO を持たない（属性は NAME / ADMIN_LEVEL /
 * OHM_RELATION_ID / START_DATE / END_DATE）ため、buildColorMap では NAME キーの
 * 独立勢力として扱われ、決定的プロービングで諸侯ごとに相異なる色が割り当てられる
 * （HRE 領邦の INDEPENDENT_SUBJECT_SUZERAINS 相当の特別扱いは不要）。
 *
 * イタリア諸侯領（data/italy_fiefs_<year>.geojson、`deno task build-italy-fiefs`
 * で生成、TASK-95/96）も同じく SUBJECTO を持たないため、フランス諸侯領と同じ
 * 扱いになる。名目上は帝国内のコムーネも含むが、SUBJECTO を持たせない選択
 * （TASK-95）がここでもそのまま「独立色を割り当てる」意味になり、hre_fiefs の
 * 複合キー（"NAME|Holy Roman Empire"）とは衝突しない。
 */
/** 隣接グラフの対象となる europe_<year>.geojson だけを読み込む。 */
export async function loadBaseYearCollections(): Promise<YearCollection[]> {
  const collections: YearCollection[] = [];
  for (const year of SNAPSHOT_YEARS) {
    const path = `${DATA_DIR}/europe_${year}.geojson`;
    const fc = JSON.parse(await Deno.readTextFile(path)) as FeatureCollection;
    collections.push({ year, collection: fc });
  }
  return collections;
}

export async function loadYearCollections(
  baseCollections?: YearCollection[],
): Promise<YearCollection[]> {
  const collections = baseCollections === undefined
    ? await loadBaseYearCollections()
    : [...baseCollections];
  const optionalEntries: Array<{ year: number; path: string }> = [
    ...HRE_OVERLAY_YEARS.map((year) => ({
      year,
      path: `${DATA_DIR}/hre_${year}.geojson`,
    })),
    ...FRANCE_FIEF_YEARS.map((year) => ({
      year,
      path: `${DATA_DIR}/france_fiefs_${year}.geojson`,
    })),
    ...HRE_FIEF_YEARS.map((year) => ({
      year,
      path: `${DATA_DIR}/hre_fiefs_${year}.geojson`,
    })),
    ...ITALY_FIEF_YEARS.map((year) => ({
      year,
      path: `${DATA_DIR}/italy_fiefs_${year}.geojson`,
    })),
    // TASK-110: Cliopatria 由来の諸侯領・領邦。仏側は SUBJECTO を持たないので
    // france_fiefs と同じ NAME キー、帝国側は SUBJECTO="Holy Roman Empire" を
    // 持つので hre_fiefs と同じ複合キーになり、既存の色割当規則がそのまま効く。
    ...CLIOPATRIA_FIEF_YEARS.map((year) => ({
      year,
      path: `${DATA_DIR}/cliopatria_fiefs_${year}.geojson`,
    })),
    // #172: ブリテン諸島の政体（TASK-151、`deno task build-britain-fiefs` で
    // 生成）。SUBJECTO を持たないため france_fiefs と同じ NAME キーの独立
    // プロービング色になる。
    ...BRITAIN_FIEF_YEARS.map((year) => ({
      year,
      path: `${DATA_DIR}/britain_fiefs_${year}.geojson`,
    })),
    // #189: 主権政体オーバーレイ（`deno task build-sovereign-fiefs` で生成）。
    // SUBJECTO を持たないため NAME キーの独立プロービング色になる。NAME を
    // base の呼称に合わせた政体（Kingdom of Hungary / Crimean Khanate 等）は
    // base 側と同じキーに解決し、新しい色は「base に現れないキー」だけに付く。
    ...SOVEREIGN_FIEF_YEARS.map((year) => ({
      year,
      path: `${DATA_DIR}/sovereign_fiefs_${year}.geojson`,
    })),
  ];
  for (const { year, path } of optionalEntries) {
    try {
      const fc = JSON.parse(await Deno.readTextFile(path)) as FeatureCollection;
      collections.push({ year, collection: fc });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      // 未生成環境（build-hre / build-france-fiefs 前）ではスキップして従来どおり動かす
    }
  }
  return collections;
}

/** 既存 colors.json を読み込む。存在しなければ null（bootstrap の全量生成へ） */
async function loadSnapshot(
  path: string,
): Promise<{ map: ColorMap; text: string } | null> {
  try {
    const text = await Deno.readTextFile(path);
    return { map: JSON.parse(text) as ColorMap, text };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

/** 通常実行（bootstrap 全量生成 / 差分追加）の ColorMap を組み立てる */
function buildNormalMap(
  snapshot: ColorMap | null,
  yearCollections: YearCollection[],
  overrides: NameOverrides,
  prune: boolean,
): ColorMap {
  if (snapshot === null) {
    return buildColorMap(
      yearCollections.map((yc) => yc.collection),
      overrides,
      INDEPENDENT_SUBJECT_SUZERAINS,
    );
  }
  return buildColorMapAdditive(
    snapshot,
    yearCollections,
    overrides,
    INDEPENDENT_SUBJECT_SUZERAINS,
    { prune },
  );
}

async function main(): Promise<void> {
  const prune = Deno.args.includes("--prune");
  const check = Deno.args.includes("--check");
  // #385・ADR-0041: 一回限りの是正パス。通常実行では絶対に走らない。
  const remapLowContrast = Deno.args.includes("--remap-low-contrast");
  // #438: 隣接する上位勢力の一回限りの是正。通常実行では走らない。
  const remapAdjacent = Deno.args.includes("--remap-adjacent");
  if (remapLowContrast && remapAdjacent) {
    console.error("2 種類の remap フラグは同時に指定できない");
    Deno.exit(1);
  }
  const overrides = await loadOverrides(OVERRIDES_PATH);
  const baseYearCollections = await loadBaseYearCollections();
  const yearCollections = await loadYearCollections(baseYearCollections);
  const adjacencyGraph = buildTopLevelAdjacencyGraph(
    baseYearCollections,
    overrides,
  );
  const snapshot = await loadSnapshot(COLORS_PATH);
  if ((remapLowContrast || remapAdjacent) && snapshot === null) {
    console.error(
      `${COLORS_PATH} が無い状態では remap フラグは使えない` +
        `（bootstrap 生成は最初から制約付きスロットしか使わない）`,
    );
    Deno.exit(1);
  }
  const map = sortColorMap(
    remapAdjacent
      ? remapAdjacentTopLevelColors(
        snapshot!.map,
        yearCollections,
        baseYearCollections,
        adjacencyGraph,
        overrides,
        INDEPENDENT_SUBJECT_SUZERAINS,
      )
      : remapLowContrast
      ? remapLowContrastColors(
        snapshot!.map,
        yearCollections,
        overrides,
        INDEPENDENT_SUBJECT_SUZERAINS,
      )
      : buildNormalMap(
        snapshot?.map ?? null,
        yearCollections,
        overrides,
        prune,
      ),
  );
  const text = `${JSON.stringify(map, null, 2)}\n`;

  const before = snapshot?.map ?? {};
  const added = Object.keys(map).filter((k) => !(k in before));
  const removed = Object.keys(before).filter((k) => !(k in map));
  const subjectKeys = Object.keys(map).filter((k) =>
    k.includes(SUBJECT_KEY_SEP)
  );
  const changed = Object.keys(map).filter((k) =>
    k in before && before[k] !== map[k]
  );
  const changedSubject = changed.filter((k) => k.includes(SUBJECT_KEY_SEP));
  const summary = `${COLORS_PATH}: ${Object.keys(map).length} entries ` +
    `(${subjectKeys.length} subject-derived, +${added.length} added, ` +
    `-${removed.length} removed, ~${changed.length} recolored` +
    `[${changedSubject.length} subject]), ` +
    `palette=${PALETTE_SIZE} assignable=${assignableSlots().length} ` +
    `earth ΔE00>=${EARTH_DELTA_E_MIN}, adjacent ΔE00>=${ADJACENT_DELTA_E_MIN}`;

  if (check) {
    // ドリフト検出モード（#193 AC3）: 実行しても colors.json が変化しないことを
    // 検証する。差分があれば非 0 終了で CI / 手元の検証を失敗させる。
    if (snapshot !== null && text === snapshot.text) {
      console.log(`${summary} — no drift`);
      return;
    }
    console.error(`${summary} — DRIFT DETECTED`);
    if (added.length > 0) console.error(`  added: ${added.join(", ")}`);
    if (removed.length > 0) console.error(`  removed: ${removed.join(", ")}`);
    Deno.exit(1);
  }

  await Deno.writeTextFile(COLORS_PATH, text);
  console.log(summary);
}

if (import.meta.main) {
  await main();
}
