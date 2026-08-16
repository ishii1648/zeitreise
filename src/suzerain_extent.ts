/**
 * 宗主-封臣関係を持つ勢力の「勢力圏の外枠」を扱う DOM/deck.gl 非依存な純粋
 * ロジック（TASK-94。TASK-30 の HRE 専用実装 hre_extent.ts を一般化したもの）。
 *
 * - 色・表示用の宗主キー解決（resolveSuzerainKey）と、独立した外枠所属の
 *   解決（resolveExtentMembership / suzerainExtentKey）
 * - 宗主に属する全 feature の抽出と union（extractSuzerainMembers /
 *   buildSuzerainExtent）
 * - 宗主補正の適用（applySuzerainOverrides / withSuzerainOverrides）
 * - 地図中央の詳細表示 focus の解決と保持（detailFocusKeyAt /
 *   createDetailFocusTracker。#345）と、描画へ渡す形への変換
 *   （detailFocusAppliesAt / detailFocusKeyForZoom /
 *   UNRESOLVED_DETAIL_FOCUS_KEY。#350）
 *
 * ## 外枠の定義と権威（Issue #436）
 * 外枠は選択 feature の囲みではなく、宗主・帝国など上位政治圏の名目境界。
 * 所属は EXTENT_KEY / EXTENT_ROLE=self|member|mixed|none で明示し、SUBJECTO、
 * 配色、情報表示、ラベルアンカー包含から分離する。明示値の付与と全年代監査は
 * extent_membership.ts / scripts/audit-extent-membership.ts が担う。
 *
 * 境界の優先順は同年代の専用 realm > 補正済み base（+ 沿岸補完）。realm が
 * ある場合は base と union せず realm だけを使う。独立 self はその feature
 * 自身を境界候補にできるが、member / mixed の領邦ポリゴンを union して realm
 * を復元・拡張しない。従って帝国内外にまたがる所領を clip せず保持しつつ、
 * Prussia / Austrian Empire の帝国外部分を HRE realm に誤包含しない。
 *
 * containingSuzerainKey は詳細表示 focus を base の表示範囲へ対応づける旧来の
 * 表示分類としてのみ残す。picking から外枠キーを解決する経路は呼ばない。
 */

import union from "@turf/union";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { featureCollection } from "@turf/helpers";
import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  MultiPolygon,
  Polygon,
  Position,
} from "geojson";
import {
  BRITAIN_FIEF_LAYER_ID,
  CLIOPATRIA_FIEF_LAYER_ID,
  FRANCE_FIEF_LAYER_ID,
  HRE_LAYER_ID,
  ITALY_FIEF_LAYER_ID,
  POWER_LAYER_ID,
  SOVEREIGN_FIEF_LAYER_ID,
} from "./picking.ts";
import { labelAnchorFor, politicalDetailVisibleAt } from "./labels.ts";
import { createYearCache, type YearDataLoader } from "./powers.ts";

/**
 * 宗主キーの解決に使う name-overrides.json の内容。
 * - renames: SUBJECTO の表記ゆれ正規化（info.ts displayLabel と同じ規約）
 * - suzerains: base が欠く封建関係の補正（NAME → 宗主 NAME）
 */
export interface SuzerainOverrides {
  renames: Record<string, string>;
  suzerains: Record<string, string>;
}

/** 補正なし（取得失敗時のフォールバック。base の SUBJECTO をそのまま使う） */
export const EMPTY_SUZERAIN_OVERRIDES: SuzerainOverrides = {
  renames: {},
  suzerains: {},
};

/** 上位政治圏の外枠に対する feature の役割（Issue #436）。 */
export type ExtentRole = "self" | "member" | "mixed" | "none";

/** `EXTENT_KEY` / `EXTENT_ROLE` を解決した機械可読な所属。 */
export interface ExtentMembership {
  readonly key: string | null;
  readonly role: ExtentRole;
}

/** GeoJSON properties に置く外枠キー。SUBJECTO・色・表示とは独立する。 */
export const EXTENT_KEY_PROPERTY = "EXTENT_KEY";

/** GeoJSON properties に置く外枠内での役割。 */
export const EXTENT_ROLE_PROPERTY = "EXTENT_ROLE";

const EXTENT_ROLES: readonly ExtentRole[] = [
  "self",
  "member",
  "mixed",
  "none",
];

/**
 * feature の明示的な外枠所属を解決する（Issue #436）。
 *
 * `EXTENT_ROLE` があるデータでは SUBJECTO や幾何を一切参照しない。
 * - self: `EXTENT_KEY`（省略時 NAME）を自分自身の外枠として使う
 * - member / mixed: `EXTENT_KEY` を上位政治圏として使う
 * - none: 外枠を表示しない
 *
 * 古い／synthetic な base データとの互換のため、`EXTENT_ROLE` 自体が無い場合
 * だけ従来の明示属性（宗主補正 > SUBJECTO > NAME）へ縮退する。この縮退は
 * ラベルアンカーを使わない。配信 GeoJSON の欠落は audit-extent-membership が
 * CI で失敗させるため、本番データが暗黙経路へ落ちることはない。
 */
export function resolveExtentMembership(
  props: GeoJsonProperties,
  overrides: SuzerainOverrides,
): ExtentMembership {
  const rawRole = stringProp(props, EXTENT_ROLE_PROPERTY);
  if (rawRole === null) {
    const key = resolveSuzerainKey(props, overrides);
    const name = stringProp(props, "NAME");
    return {
      key,
      role: key === null ? "none" : key === name ? "self" : "member",
    };
  }
  if (!EXTENT_ROLES.includes(rawRole as ExtentRole)) {
    return { key: null, role: "none" };
  }
  const role = rawRole as ExtentRole;
  if (role === "none") return { key: null, role };
  const explicit = stringProp(props, EXTENT_KEY_PROPERTY);
  if (explicit !== null) {
    return { key: overrides.renames[explicit] ?? explicit, role };
  }
  if (role === "self") return { key: stringProp(props, "NAME"), role };
  // member / mixed は上位政治圏を省略できない。audit と同じ fail-closed 契約。
  return { key: null, role };
}

/** 外枠所属キーだけを取り出す短縮形。 */
export function resolveExtentKey(
  props: GeoJsonProperties,
  overrides: SuzerainOverrides,
): string | null {
  return resolveExtentMembership(props, overrides).key;
}

/** 明示的な外枠所属から外枠を引ける base / HRE レイヤー。 */
const EXTENT_SOURCE_LAYER_IDS: readonly string[] = [
  POWER_LAYER_ID,
  HRE_LAYER_ID,
];

/** 明示的な外枠所属から外枠を引ける諸侯領オーバーレイ。 */
const FIEF_EXTENT_SOURCE_LAYER_IDS: readonly string[] = [
  FRANCE_FIEF_LAYER_ID,
  CLIOPATRIA_FIEF_LAYER_ID,
  ITALY_FIEF_LAYER_ID,
  BRITAIN_FIEF_LAYER_ID,
  SOVEREIGN_FIEF_LAYER_ID,
];

/** properties から文字列プロパティを取り出す。空文字・非文字列は null */
function stringProp(props: GeoJsonProperties, key: string): string | null {
  const v = props?.[key];
  return typeof v === "string" && v !== "" ? v : null;
}

/** unknown が「文字列だけを値に持つ辞書」ならそれを返す。それ以外は空辞書 */
function stringMap(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** name-overrides.json の JSON を SuzerainOverrides へ解釈する（純粋関数） */
export function parseSuzerainOverrides(data: unknown): SuzerainOverrides {
  if (data === null || typeof data !== "object") {
    return EMPTY_SUZERAIN_OVERRIDES;
  }
  const obj = data as Record<string, unknown>;
  return {
    renames: stringMap(obj.renames),
    suzerains: stringMap(obj.suzerains),
  };
}

/**
 * feature の宗主キーを解決する（純粋関数）。
 * 優先順は 宗主補正テーブル（NAME 起点）> SUBJECTO（renames 正規化）> NAME。
 * 独立勢力は SUBJECTO が自己参照なので自分自身のキーになり、外枠は自分だけを
 * 囲む（無関係な勢力へ波及しない）。NAME を持たない feature は null。
 *
 * 補正は SUBJECTO の書き換えとしても適用される（applySuzerainOverrides）ため、
 * 書き換え前後のどちらの properties を渡しても同じキーになる（冪等）。
 */
export function resolveSuzerainKey(
  props: GeoJsonProperties,
  overrides: SuzerainOverrides,
): string | null {
  const name = stringProp(props, "NAME");
  if (name === null) return null;
  const override = overrides.suzerains[name];
  if (override !== undefined) return overrides.renames[override] ?? override;
  const subjecto = stringProp(props, "SUBJECTO");
  if (subjecto === null) return name;
  return overrides.renames[subjecto] ?? subjecto;
}

/**
 * 諸侯領オーバーレイの feature の宗主キーを、base の包含関係から解決する
 * （純粋関数、TASK-120）。
 *
 * 優先順は 宗主補正テーブル > SUBJECTO > 包含する base 勢力の宗主キー。
 * 前 2 段は resolveSuzerainKey と同じで、上流や補正が宗主を宣言していれば
 * それに従う（Cliopatria 由来の HRE 領邦は SUBJECTO を持つのでここで決まる）。
 * 宣言が無いときだけ幾何に落ちる。
 *
 * 包含の判定にはラベルのアンカー（最大ポリゴンの pole of inaccessibility、
 * labels.ts labelAnchorFor）を使う。境界をまたぐ封土でも「その封土の名前が
 * 描かれている点を含む勢力」という一意で目視可能な規則になり、面積按分の
 * ような閾値を持ち込まずに済む。実データ（1000〜1492 の仏諸侯領・Cliopatria
 * 領邦 全 128 feature）では包含する base 勢力が常にちょうど 1 つに定まる。
 *
 * base 側に一致が無い（海側にはみ出した封土など）場合は null = 外枠なしで、
 * 従来どおりの挙動に落ちる（伊諸侯領のピオンビーノ領主領 1400 / 1492 が該当）。
 *
 * 「宗主候補の版図が封土より小さいなら包含とは言えない」という面積のガードは
 * 採らない。ピサ・ジェノヴァのコルシカを外枠なしに落とせる代わりに、base の
 * ブルターニュ公領・ノルマンディー公領のポリゴンがオーバーレイ側より小さい
 * ために仏封土 7 件（1000〜1300 の Duchy of Brittany / Duchy of Normandy）が
 * 外枠を失い、TASK-120 で直した挙動を壊すため（実測）。
 */
export function containingSuzerainKey(
  fief: Feature,
  base: FeatureCollection,
  overrides: SuzerainOverrides,
): string | null {
  const name = stringProp(fief.properties, "NAME");
  if (name !== null) {
    const override = overrides.suzerains[name];
    if (override !== undefined) return overrides.renames[override] ?? override;
  }
  if (stringProp(fief.properties, "SUBJECTO") !== null) {
    return resolveSuzerainKey(fief.properties, overrides);
  }
  const anchor = labelAnchorFor(fief);
  if (anchor === null) return null;
  for (const f of polygonsOnly(base.features)) {
    if (booleanPointInPolygon(anchor, f.geometry)) {
      return resolveSuzerainKey(f.properties, overrides);
    }
  }
  return null;
}

/**
 * picking 結果から「表示すべき外枠の宗主キー」を解決する（純粋関数）。
 * 対象外レイヤー（都市・河川・山脈・picking なし）は null = 外枠を出さない。
 * レイヤー ID を先に判定するため、GeoJSON Feature でない picking 結果
 * （都市マーカー）でも安全に null を返す。
 *
 * Issue #436 以降、諸侯領も `EXTENT_KEY` / `EXTENT_ROLE` だけで解決する。
 * `base` 引数は呼び出し側 API の互換性のため残すが、アンカー包含推定には
 * 使用しない。
 */
export function suzerainExtentKey(
  pickedLayerId: string | undefined,
  picked: Feature | undefined,
  _base: FeatureCollection,
  overrides: SuzerainOverrides,
): string | null {
  if (pickedLayerId === undefined) return null;
  if (FIEF_EXTENT_SOURCE_LAYER_IDS.includes(pickedLayerId)) {
    if (picked === undefined) return null;
    return resolveExtentKey(picked.properties, overrides);
  }
  if (!EXTENT_SOURCE_LAYER_IDS.includes(pickedLayerId)) return null;
  return resolveExtentKey(picked?.properties ?? null, overrides);
}

/**
 * 地図中央が属する上位勢力（宗主キー）を base の包含から解決する
 * （純粋関数。#345 / #293 分割 1/5）。
 *
 * 詳細表示の対象を「画面中央の 1 か国」に絞るための judgement で、判定規則は
 * 既存の宗主解決と同じものを共有する（{@linkcode containingSuzerainKey} が
 * 封土のラベル地点で行うのと同じ「base の塗りがそのまま答えになる」規則を、
 * 地図中央の 1 点に対して適用する）。従属勢力の上でも返るのは宗主キー
 * （= 上位勢力）なので、詳細表示の単位が領邦へ落ちることはない。
 *
 * 中央が海上・base 勢力の外なら null（focus 無し）。
 *
 * `current`（直前の focus）を優先するのは、境界の真上で止まったときのちらつきを
 * 防ぐため。共有辺の上の点は隣接する両ポリゴンの内側と判定される
 * （booleanPointInPolygon は既定で境界を含む）ため候補が 2 件以上になり、
 * 「先に見つかった方」を機械的に採ると、パンのたびに feature の並び順で
 * focus が振れる。候補に直前の focus があるならそれを保ち、無いときだけ
 * 先頭の候補（base の並び順）へ移る。
 */
export function detailFocusKeyAt(
  center: Position,
  base: FeatureCollection,
  overrides: SuzerainOverrides,
  current: string | null = null,
): string | null {
  let first: string | null = null;
  for (const f of polygonsOnly(base.features)) {
    if (!booleanPointInPolygon(center, f.geometry)) continue;
    const key = resolveSuzerainKey(f.properties, overrides);
    if (key === null) continue;
    // 境界上で複数候補になったときは現在の focus を優先する
    if (key === current) return current;
    if (first === null) first = key;
  }
  return first;
}

/**
 * 「詳細表示 focus は有効だが、地図中央に対応する上位勢力が無い」ことを表す
 * 宗主キー（#350 / #293 AC5）。
 *
 * ## なぜ null ではなく専用キーなのか
 *
 * 描画側（political_layers.ts `focusedLayerData` / powers.ts
 * `composeDetailFocus` / labels.ts `filterPowerLabelsByFocus`）は
 * **`null` を「focus 機能そのものがオフ」**（絞り込みを一切しない = 従来表示）
 * として扱う契約で確定している（#347/#348 AC6。z4 の概観表示と、focus 導入前の
 * 挙動を同一に保つための契約）。一方 #293 AC5 が要求するのは「中央が海上・
 * base 勢力外なら詳細表示を行わない」= **全領邦を描かない**で、これは
 * 「絞り込まない」の正反対にあたる。
 *
 * この 2 状態を区別するために、picking 側（picking.ts `PickDetailFocus`）は
 * 「オブジェクトの有無」と「`key` の null」で表現している。描画側は焦点キー
 * 1 本しか受けないため、同じ区別を **どの feature の宗主キーにもならない値**で
 * 表現する。こうすると既存の絞り込み・合成の規則をそのまま通すだけで
 * 「一致 0 件 = 領邦は描かれず、塗り・境界・ラベルは素の base に戻る」が
 * 得られ、4 経路（塗り・概略境界・レイヤー・ラベル）に「海上のとき」の分岐を
 * 増やさずに済む。
 *
 * 値に制御文字を含めるのは、宗主キーが GeoJSON の NAME / SUBJECTO（人間可読の
 * 地名）由来で、実データと衝突し得ないことを構造的に保証するため。
 */
export const UNRESOLVED_DETAIL_FOCUS_KEY = "\u0000zeitreise:no-detail-focus";

/**
 * 詳細表示 focus が有効なズーム段か（#350 AC8）。
 *
 * focus は「z5 以上の詳細表示を中央 1 か国へ絞る」機構なので、概観表示（z4）
 * では常に無効。判定は塗り・境界・ラベル・picking と同じ
 * {@linkcode politicalDetailVisibleAt} を共有する（閾値をここで再現しない）。
 */
export function detailFocusAppliesAt(zoomStep: number): boolean {
  return politicalDetailVisibleAt(zoomStep);
}

/**
 * tracker が解決した focus を「描画へ渡す focus」へ変換する（純粋関数、#350）。
 *
 * - 概観表示（z4）: `null` = focus 機能オフ。塗り・境界・レイヤー・ラベル・
 *   picking のすべてが #293 導入前と同一になる（AC8）。
 * - 詳細表示（z5 以上）で中央が上位勢力の中: その宗主キーをそのまま渡す。
 * - 詳細表示で中央が海上・base 勢力外: {@linkcode UNRESOLVED_DETAIL_FOCUS_KEY}
 *   = どの宗主にも一致しないキー。領邦は 1 枚も描かれず、塗り・境界は素の
 *   base へ戻る（AC5）。
 *
 * main.ts はこの 1 関数の結果を 4 経路すべてへ配るため、経路ごとにゲートを
 * 書き分けて食い違う余地がない。
 */
export function detailFocusKeyForZoom(
  key: string | null,
  zoomStep: number,
): string | null {
  if (!detailFocusAppliesAt(zoomStep)) return null;
  return key ?? UNRESOLVED_DETAIL_FOCUS_KEY;
}

/**
 * {@linkcode createDetailFocusTracker} へ注入する依存（#345）。
 * maplibre / DOM に依存しないよう、使う操作だけを構造的に受ける。
 */
export interface DetailFocusDeps {
  /** 地図中央（[lon, lat]。maplibre Map.getCenter 相当） */
  readonly getCenter: () => Position | null;
  /** 現在年の base（年代データ未確定なら null） */
  readonly getBase: () => FeatureCollection | null;
  /** 宗主補正（main.ts 所有。取得前は EMPTY_SUZERAIN_OVERRIDES） */
  readonly getOverrides: () => SuzerainOverrides;
  /**
   * `moveend` の購読（main.ts の URL 同期と同じ確定イベント）。ファクトリが
   * 生成時に 1 度だけ呼ぶ。**ここで購読するのは moveend だけ**で、連続発火する
   * `move` / `zoom` は購読しない（パン/ズームの毎フレーム再解決を避ける）。
   */
  readonly onMoveEnd: (listener: () => void) => void;
  /**
   * `moveend` による再解決で focus が**実際に変わったとき**だけ呼ばれる通知
   * （#350）。main.ts はここで `renderLayers()` を呼び、パン停止で中央が別の
   * 上位勢力へ移ったときに詳細表示を追従させる（#293 AC6）。
   *
   * 通知を tracker 側に持たせるのは、main.ts が `map.on("moveend")` を後付けで
   * 購読して自前で前回値と比較する案が、tracker の購読登録順への暗黙の依存に
   * なるため（tracker より先に登録されると、常に 1 回分古い focus を見る）。
   *
   * **`refresh()` の明示呼び出し（年代変更）では呼ばれない**: 呼び出し側
   * （yearSwitcher の applyFn）が直後に必ず `renderLayers()` を行うため、
   * 通知すると同じ描画が 2 回走る。変化の有無は `refresh()` の返り値で取れる。
   */
  readonly onChange?: (key: string | null) => void;
}

/** createDetailFocusTracker が返すハンドル（読み取り + 明示的な再解決） */
export interface DetailFocusHandle {
  /**
   * 現在の focus（null = 中央が海上・base 勢力外、または未解決）。
   * 描画へ渡す前に {@linkcode detailFocusKeyForZoom} でズームゲートを通す。
   */
  key(): string | null;
  /** 直近の解決に使った中央座標（未解決・focus 無しの判定前は null） */
  center(): Position | null;
  /**
   * 中央から focus を解決し直す（年代変更時に main.ts が呼ぶ）。
   * #350: focus が**変わったかどうか**を返す（呼び出し側が再描画の要否を
   * 判断できるようにする。年代切替は無条件に再描画するため戻り値を捨ててよい）。
   */
  refresh(): boolean;
}

/**
 * 地図中央の詳細表示 focus を保持する tracker を生成し、`moveend` を購読する
 * （#345）。
 *
 * 更新契機は **`moveend`（パン/ズームの確定）と年代変更（refresh）だけ**。
 * 連続する `move` / `zoom` では再解決しない（1 回の解決は base 全 feature への
 * 点内包判定で、毎フレーム回す重さではない。表示単位が操作中に揺れないという
 * 意味でも確定イベントだけで足りる）。
 *
 * 状態（現在の focus）をこのファクトリの closure が持つのは
 * approximate_border_sync.ts / pick_handlers.ts と同じ理由（decision-29 の
 * 例外）: 書き込み経路が moveend と refresh の 2 本に閉じるため、更新契機
 * そのものを同じモジュールで直接ユニットテストできる。main.ts へは読み取り用
 * getter を返す。
 */
export function createDetailFocusTracker(
  deps: DetailFocusDeps,
): DetailFocusHandle {
  let key: string | null = null;
  let center: Position | null = null;

  function refresh(): boolean {
    const previous = key;
    const next = deps.getCenter();
    const base = deps.getBase();
    if (next === null || base === null) {
      // 年代データ未確定・中央不明の間は focus を持たない
      key = null;
      center = null;
      return previous !== null;
    }
    center = next;
    key = detailFocusKeyAt(next, base, deps.getOverrides(), key);
    return key !== previous;
  }

  // #350: パン/ズームの確定で focus が変わったときだけ通知する。同じ上位勢力の
  // 中を動いている間は通知しない（再描画を誘発しない）。
  deps.onMoveEnd(() => {
    if (refresh()) deps.onChange?.(key);
  });

  return { key: () => key, center: () => center, refresh };
}

/**
 * base から宗主キーに属する feature（本体 + 従属）を抽出する（純粋関数）。
 * key が null・該当なしなら空配列。
 */
export function extractSuzerainMembers(
  fc: FeatureCollection,
  key: string | null,
  overrides: SuzerainOverrides,
): Feature[] {
  if (key === null) return [];
  return fc.features.filter((f) =>
    resolveExtentKey(f.properties, overrides) === key
  );
}

/** Polygon / MultiPolygon の feature だけに絞る（union の入力条件） */
function polygonsOnly(
  features: Feature[],
): Feature<Polygon | MultiPolygon>[] {
  return features.filter((f): f is Feature<Polygon | MultiPolygon> =>
    f.geometry !== null &&
    (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")
  );
}

/**
 * 糸くず環と判定する平均半幅（m。#330）。
 *
 * 帯と元ポリゴンの縁は同じ線を通るが、帯は「バッファ − 全政治ポリゴン」の
 * polyclip 差分で作られ、配信データはさらに 5 桁（≈ 1.1 m。
 * scripts/build-coastal-fill.ts の COASTAL_FILL_COORD_PRECISION）へ丸めて
 * ある。そのため union すると両者の間に幅 1 m 未満・長さ数〜数十 km の
 * 糸くず環（sliver）が内環として残り、面積は無視できるのに **3px の臙脂線と
 * しては元の概略海岸線をそのまま描いてしまう**（AC4 が禁じる「領域内部に残る
 * 概略海岸線」そのもの）。
 *
 * 5 m の根拠（実測）: 1815 年プロイセンは糸くず 9 本・平均半幅の最大 0.11 m・
 * 最長 23.4 km、1880 年ドイツは 24 本・最大 0.12 m・最長 31.9 km。一方、
 * 落としてはいけない実在の未着色域（湖・内水面・飛び地・データの隙間）は
 * 同じ 2 例で最小 7.9 m（1880 年のボーデン湖付近。年代 GeoJSON の 3 桁格子
 * ≈ 111 m に由来する隙間）、次点は 108 m 以上。糸くず（0.1 m 級）と実在
 * （8 m 以上）の間に 1 桁以上の空きがあり、5 m はどちらからも離れている。
 */
export const SLIVER_HALF_WIDTH_M = 5;

/** 度の座標を局所平面（m）へ写す係数（緯度 1 度・経度 1 度） */
const DEG_LAT_M = 110_574;
const DEG_LON_M = 111_320;

/**
 * 環の平均半幅（面積 ÷ 周長。m）を返す。長さ L・幅 w の細長い環では
 * ≈ w/2 になり、丸め由来の糸くずと実在の未着色域を分けられる。
 */
function ringHalfWidthMeters(ring: readonly Position[]): number {
  if (ring.length < 4) return 0;
  const latMean = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
  const scale = Math.cos((latMean * Math.PI) / 180);
  let twiceArea = 0;
  let perimeter = 0;
  for (let i = 1; i < ring.length; i++) {
    const x0 = ring[i - 1][0] * scale * DEG_LON_M;
    const y0 = ring[i - 1][1] * DEG_LAT_M;
    const x1 = ring[i][0] * scale * DEG_LON_M;
    const y1 = ring[i][1] * DEG_LAT_M;
    twiceArea += x0 * y1 - x1 * y0;
    perimeter += Math.hypot(x1 - x0, y1 - y0);
  }
  if (perimeter === 0) return 0;
  return Math.abs(twiceArea / 2) / perimeter;
}

/**
 * union の結果から糸くず環（{@linkcode SLIVER_HALF_WIDTH_M} 未満）を落とす
 * （純粋関数。#330）。外環が糸くずならそのパートごと落とす。
 *
 * 面積ではなく**幅**で判定するのは、糸くずが「細くて長い」形だから。
 * 面積の閾値にすると、長い海岸線に沿った糸くず（実測 0.03 km2）と、実在の
 * 小さな未着色域（同 0.47 km2）が同じ桁に並んでしまい分けられない。
 *
 * **落とさないもの**: 実寸（平均半幅 km 級）の内環はここでは落ちないし、
 * 落とさないのが正しい。その面は緑青の塗りにも空いているので、内環の臙脂線は
 * **見えている塗りの縁**と一致しており、線だけ消すと #330 が却下した「塗りだけの
 * 段差が残る」状態になる。#389 以降に残るのは、帯（外側 30 km）が届かない
 * 湾・海峡の中央のような**実在の未着色域**で（実測: 全 19 年代 × 全宗主キーで
 * 109 環。最大はカテガット海峡の 2,133 km²、いずれも海洋 water に覆われる）、
 * 帯自身の折り返しポケットは残らない。
 *
 * かつては帯の作り方（片側オフセットの単環）に由来する穴が同じ形で混ざって
 * いた（#358 で観測。19 年代 × 全宗主キーで 750 環。うちクロニアン砂州沖の
 * 2 環は現代の陸に出て塗りの欠けとして見えていた）。これは #389 が帯の側で
 * 断ち（coastal_fill.ts coastalBandPolygon の self-union）、解消したことは
 * src/suzerain_extent_coastal_test.ts が固定している。
 */
function dropSliverRings(
  geometry: Polygon | MultiPolygon,
): Polygon | MultiPolygon {
  const polygons = geometry.type === "MultiPolygon"
    ? geometry.coordinates
    : [geometry.coordinates];
  const kept = polygons
    .filter((rings) => ringHalfWidthMeters(rings[0]) >= SLIVER_HALF_WIDTH_M)
    .map((rings) =>
      rings.filter((ring, index) =>
        index === 0 || ringHalfWidthMeters(ring) >= SLIVER_HALF_WIDTH_M
      )
    );
  if (
    kept.length === 0 ||
    (kept.length === polygons.length &&
      kept.every((rings, i) => rings.length === polygons[i].length))
  ) {
    return geometry; // 変更なし（同一参照を保つ）
  }
  if (kept.length === 1) return { type: "Polygon", coordinates: kept[0] };
  return { type: "MultiPolygon", coordinates: kept };
}

/**
 * 沿岸補完の帯（coastal_fill.ts）を外枠の union へ合流させるための入力
 * （#330）。
 *
 * なぜ要るのか: 画面上でその勢力の面として塗られるのは「元の政治ポリゴン +
 * 沿岸補完の帯（海面・内水面でマスクされた残り）」で、ホバー/選択では帯も
 * 同じアクティブ色へ切り替わる。外枠の入力が元ポリゴンだけだと、歴史ポリゴンが
 * 現代海岸線より内側にある区間で緑青が臙脂線の外へ広がる（#330 の原因 2。
 * 実測: 1815 年プロイセンでアクティブ面の 8.8%・1880 年ドイツで 7.0%）。
 *
 * なぜ関数を注入するのか: 帯の properties の形（base の添字で色を引き直す
 * #326 の契約）を知っているのは coastal_fill.ts で、そちらは既にこの
 * モジュールへ依存している（resolveSuzerainKey）。選別を関数として受け取れば
 * 相互 import にならず、キャッシュミスのときだけ選別を走らせられる。
 */
export interface SuzerainExtentBands {
  /**
   * 帯が対応する年代 base。`buildSuzerainExtent` に渡された FeatureCollection と
   * **参照が一致しないときは帯を使わない**（年代切替の途中では、帯が前年の
   * base の添字を指したまま渡りうる）。
   */
  readonly base: FeatureCollection;
  /** 帯の幾何（`data/coastal_fill_<year>.geojson` または実行時生成） */
  readonly bands: FeatureCollection;
  /** 宗主キーに属する帯パートを取り出す（coastal_fill.ts coastalBandsForSuzerain） */
  readonly select: (
    bands: FeatureCollection,
    base: FeatureCollection,
    key: string,
    overrides: SuzerainOverrides,
  ) => Feature<Polygon | MultiPolygon>[];
}

/**
 * 宗主キーの名目外枠を FeatureCollection で返す（純粋関数）。
 *
 * union で融合することで、宗主本体と従属勢力の間に走る内部境界が外縁線として
 * 描かれず、「どこからどこまでが 1 つの勢力圏か」だけが読める。飛び地
 * （アンジュー帝国の英本土と大陸領など）は MultiPolygon として保たれる。
 *
 * #330: 帯（{@linkcode SuzerainExtentBands}）を渡すと、その勢力圏に属する帯も
 * 同じ union に入る。帯は元ポリゴンの沿岸へ接して外側へ張り出す面なので、
 * 融合すると元の概略海岸線は内部境界として消え、外縁が「実際に塗られる面」の
 * 縁と一致する（海側へ出た部分は海洋 water が覆う = 見える線は残らない）。
 * 帯を渡さない・base が対応しないときは従来どおり元ポリゴンだけの外枠になる。
 *
 * #332 / #436: realm（data/hre_realm_<year>.geojson）に同じキーの feature が
 * あれば、それだけを正本とする。base・帯・領邦を足さないため、帝国外所領で
 * realm を拡張しない。realm が無い場合だけ base（+ 帯）へフォールバックする。
 * `selfExtents` は独立オーバーレイ自身の外枠候補で、member / mixed は含めない。
 *
 * union が失敗した場合（base ポリゴンの自己交差など）は構成 feature をそのまま
 * 返す。外枠が内部境界込みになるだけで、範囲の情報は失われない。
 */
export function buildSuzerainExtent(
  fc: FeatureCollection,
  key: string | null,
  overrides: SuzerainOverrides,
  bands: SuzerainExtentBands | null = null,
  realm: FeatureCollection | null = null,
  selfExtents: FeatureCollection | null = null,
): FeatureCollection {
  const realmMembers = realm === null
    ? []
    : polygonsOnly(extractSuzerainMembers(realm, key, overrides));
  // 専用 realm は上位政治圏そのものの正本であり、base はフォールバック。
  // 両者を union すると帝国内外にまたがる base feature が realm を拡張し得る。
  const members = realmMembers.length > 0 ? realmMembers : polygonsOnly([
    ...extractSuzerainMembers(fc, key, overrides),
    ...(selfExtents === null
      ? []
      : extractSuzerainMembers(selfExtents, key, overrides)),
  ]);
  // realm がある場合は沿岸補完も足さない。沿岸補完は base の見た目を補う面で、
  // 名目境界である realm の権威を越えて外枠を拡張してはならない。
  const bandParts = realmMembers.length > 0 || key === null || bands === null ||
      bands.base !== fc
    ? []
    : bands.select(bands.bands, fc, key, overrides);
  // 融合する相手が無い（宗主-封臣関係を持たない単独勢力で帯も無い）なら、
  // そのポリゴンの外縁がそのまま外枠になる（turf union は 2 件未満を
  // 受け付けないため、最も多いこのケースを先に返す）
  if (members.length + bandParts.length <= 1) {
    return { type: "FeatureCollection", features: members };
  }
  const properties = { NAME: key };
  try {
    const merged = union(
      featureCollection([...members, ...bandParts]),
      { properties },
    );
    if (merged !== null) {
      // 帯との継ぎ目に残る糸くず環（座標丸め由来）を落とす。残すと 3px の
      // 臙脂線が元の概略海岸線を領域の内部に描いてしまう（#330 AC4）
      const geometry = dropSliverRings(merged.geometry);
      const feature = geometry === merged.geometry
        ? merged
        : { ...merged, geometry };
      return { type: "FeatureCollection", features: [feature] };
    }
  } catch (error) {
    console.warn(
      `勢力圏の外枠の union に失敗しました。構成ポリゴンをそのまま描画します (${key}): ${
        String(error)
      }`,
    );
  }
  return { type: "FeatureCollection", features: members };
}

/** buildSuzerainExtent をメモ化した関数の型 */
export type SuzerainExtentCache = (
  fc: FeatureCollection,
  key: string | null,
  overrides: SuzerainOverrides,
  bands?: SuzerainExtentBands | null,
  realm?: FeatureCollection | null,
  selfExtents?: FeatureCollection | null,
) => FeatureCollection;

/**
 * buildSuzerainExtent の結果を宗主キー単位でメモ化する（TASK-94）。
 *
 * union は毎フレーム計算してよい重さではない。ビルド時に全宗主の union を
 * 派生データとして持つ案（年代 × 宗主ぶんのファイル）と比較して、実行時
 * オンデマンド + メモ化を採る:
 * - 外枠が要るのはホバー/クリックした 1 宗主だけで、1 年代あたり実際に計算
 *   されるのは高々数キー。base の feature 数は年代あたり 100 未満で、
 *   構成 feature も数枚のため 1 回の union は軽い。
 * - 宗主補正（name-overrides.json）を唯一の真実に保てる。派生データにすると
 *   補正の変更がビルド生成物の再生成とセットになり、data/ に年代 × 宗主の
 *   ファイルが増え、取得経路（ローダ・失敗時フォールバック）も増える。
 *
 * base の参照が変わったら（年代切替）キャッシュを丸ごと捨てる。同じ宗主を
 * 再びホバーしたときは同一インスタンスを返すため、deck.gl の data 差分更新も
 * 無駄打ちしない。
 */
export function createSuzerainExtentCache(): SuzerainExtentCache {
  let lastFc: FeatureCollection | null = null;
  let lastOverrides: SuzerainOverrides | null = null;
  /**
   * 直近に使った帯の幾何（#330）。帯は年代 GeoJSON より後から非同期で届く
   * （coastal_fill_sync.ts）ため、届いた時点でキャッシュを捨てて外枠を
   * 作り直させる。判定は幾何 FeatureCollection の参照同値で、renderLayers の
   * たびに組み直される入力オブジェクト（SuzerainExtentBands）の同一性には
   * 依存しない。
   */
  let lastBands: FeatureCollection | null = null;
  /**
   * 直近に使った帝国全域ジオメトリ（#332）。base と同じ複合ローダで届くので
   * 年代切替では base と同時に差し替わるが、取得失敗からの再試行で後から
   * 実体が届く経路（createOverlayLoader は失敗をキャッシュしない）があるため、
   * 帯と同じく参照同値で監視して届いた時点で作り直させる。
   */
  let lastRealm: FeatureCollection | null = null;
  let lastSelfExtents: FeatureCollection | null = null;
  const cache = new Map<string, FeatureCollection>();
  const empty: FeatureCollection = { type: "FeatureCollection", features: [] };

  return (
    fc,
    key,
    overrides,
    bands = null,
    realm = null,
    selfExtents = null,
  ) => {
    const bandsFc = bands === null ? null : bands.bands;
    if (
      fc !== lastFc || overrides !== lastOverrides || bandsFc !== lastBands ||
      realm !== lastRealm || selfExtents !== lastSelfExtents
    ) {
      cache.clear();
      lastFc = fc;
      lastOverrides = overrides;
      lastBands = bandsFc;
      lastRealm = realm;
      lastSelfExtents = selfExtents;
    }
    if (key === null) return empty;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const built = buildSuzerainExtent(
      fc,
      key,
      overrides,
      bands,
      realm,
      selfExtents,
    );
    cache.set(key, built);
    return built;
  };
}

/**
 * 宗主補正を FeatureCollection の SUBJECTO へ適用する（純粋関数）。
 *
 * 外枠の判定は resolveSuzerainKey だけで足りるが、色キー（powers.ts
 * colorKeyFor）と表示ラベル（info.ts displayLabel）は properties の SUBJECTO を
 * 直接読む。補正した勢力の色・ラベルが「独立勢力のまま」では外枠と食い違うため、
 * 取得直後のデータへ一度だけ適用して以降の全経路を揃える
 * （colors.json も scripts/build-colors.ts で同じ補正を適用して生成する）。
 *
 * 補正が 1 件も効かない場合は入力インスタンスをそのまま返す（deck.gl の
 * data 参照同値による差分更新・memoizeLatest を壊さないため）。
 */
export function applySuzerainOverrides(
  fc: FeatureCollection,
  overrides: SuzerainOverrides,
): FeatureCollection {
  let changed = false;
  const features = fc.features.map((f) => {
    const name = stringProp(f.properties, "NAME");
    if (name === null) return f;
    const suzerain = overrides.suzerains[name];
    if (suzerain === undefined) return f;
    const normalized = overrides.renames[suzerain] ?? suzerain;
    if (stringProp(f.properties, "SUBJECTO") === normalized) return f;
    changed = true;
    return { ...f, properties: { ...f.properties, SUBJECTO: normalized } };
  });
  return changed ? { ...fc, features } : fc;
}

/**
 * 年代データローダに宗主補正を挟む（TASK-94）。
 * 変換結果は年ごとに保持し、保持中の年に対しては常に同一インスタンスを返す
 * （ローダ本体のキャッシュと同じ参照安定性を保つ）。
 *
 * TASK-129: この保持もローダ本体と同じ LRU（上限 YEAR_CACHE_MAX_YEARS 年）に
 * 載せる。ここが無制限の Map のままだと、内側ローダのキャッシュを退避しても
 * 補正後の FeatureCollection が全年代分残り続け、上限の意味がなくなるため。
 * 解放された年の再ロードは内側ローダ（再 fetch）へ戻る。
 *
 * #217: 保持するのは load 後に内側ローダが「キャッシュ済み（has = fetch なしで
 * 解決できる）」と申告する年だけ。オーバーレイの取得失敗はキャッシュされず空 FC
 * などへ縮退する契約（powers.ts createOverlayLoader / withBorrowedGeometry）で、
 * その縮退結果をここで保持すると LRU から追い出されるまで再試行が潰れるため、
 * 保持せず次の load を内側へ委譲する。縮退中の年は同一インスタンス保証も
 * かからないが、成功してキャッシュ済みになった時点から従来どおり保持する。
 *
 * #249: getOverrides は Promise を返してもよい。年代 geojson の取得を起動時に
 * 前倒しすると、geojson が name-overrides.json より先に解決するタイミングが
 * 生まれるが、適用（とキャッシュ）は overrides の解決を待ってから行うため、
 * 前倒しの結果にも常に補正が入る。geojson と overrides の fetch 自体は並行の
 * ままで、ここでの await が取得を直列化することはない。
 */
export function withSuzerainOverrides(
  loader: YearDataLoader,
  getOverrides: () => SuzerainOverrides | Promise<SuzerainOverrides>,
): YearDataLoader {
  const cache = createYearCache<FeatureCollection>();
  return {
    has: (year) => loader.has(year),
    async load(year) {
      const cached = cache.get(year);
      if (cached !== undefined) return cached;
      const applied = applySuzerainOverrides(
        await loader.load(year),
        await getOverrides(),
      );
      if (loader.has(year)) cache.set(year, applied);
      return applied;
    },
  };
}
