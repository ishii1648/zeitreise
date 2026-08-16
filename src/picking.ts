/**
 * picking（ホバー/クリック対象の解決）の優先順位ロジック（TASK-29）。
 * DOM / deck.gl に依存しない純粋関数のみを置く。
 *
 * deck.gl の Deck レベル onHover/onClick は「最前面の picking 結果 1 件」だけを
 * 返すため、picking の優先順位は描画レイヤー順（配列の後ろほど上）で決まる。
 * 本モジュールはその暗黙の対応を PICKING_PRIORITY として明示し、
 * - renderOrderFromPickingPriority: 優先順から描画順（下→上）を導出する
 * - layerOrderMatchesPickingPriority: レイヤー配列が優先順と整合するか検証する
 * - selectPreferredPick: 複数候補から最優先の 1 件を選ぶ
 * を提供する。
 */

import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import { MOUNTAIN_HIT_LAYER_ID } from "./mountains.ts";
import { PEAK_HIT_LAYER_ID, PEAK_LAYER_ID } from "./peaks.ts";

/**
 * 山岳系のレイヤー ID は本モジュールではなく mountains.ts / peaks.ts が定義し、
 * ここでは再エクスポートするだけにする（TASK-100）。両モジュールは
 * 「その層が何を描くか」の設計根拠（判定円の半径・記号の形）と ID を一体で
 * 持っており、ID だけを picking.ts へ移すと根拠と定義が離れる。逆向きの
 * 依存（mountains/peaks → picking）を作らないので循環にはならない。
 */
export { MOUNTAIN_HIT_LAYER_ID, PEAK_HIT_LAYER_ID, PEAK_LAYER_ID };

/** 勢力圏ポリゴン（GeoJsonLayer）のレイヤー ID（TASK-5） */
export const POWER_LAYER_ID = "powers";

/** HRE（神聖ローマ帝国）主要領邦オーバーレイのレイヤー ID（TASK-19） */
export const HRE_LAYER_ID = "hre-powers";

/**
 * 中世フランス諸侯領（公領・伯領）オーバーレイのレイヤー ID（TASK-71）。
 * HRE 領邦（hre-powers）と同じ「ベースの勢力ポリゴンの上に重ねる領邦層」で、
 * 現状は対象年が排他（フランス諸侯 1000〜1300 / HRE 領邦 1500〜1700）だが、
 * 機構としては独立レイヤーとして共存する。同時表示年が生じた場合の picking は
 * PICKING_PRIORITY の並び（hre-powers > france-fiefs > powers）で一意に決まる。
 */
export const FRANCE_FIEF_LAYER_ID = "france-fiefs";

/**
 * 中世イタリア諸侯領（都市共和国・公領・辺境伯領）オーバーレイのレイヤー ID
 * （TASK-96）。出典は OpenHistoricalMap（CC0、生成は
 * scripts/build-italy-fiefs.ts → scripts/build-fief-flat.ts）。
 *
 * なぜ既存レイヤーへ合流させず独立レイヤーにするのか:
 * - hre-powers への合流は帰属の記述が壊れる。hre_fiefs_<year> は全 feature が
 *   SUBJECTO/PARTOF = Holy Roman Empire を持つ前提で、フィレンツェ・ジェノヴァ
 *   （名目は帝国内だが実質独立）やスポレート公国・アンコーナ共和国（教皇領側）を
 *   そこへ混ぜると、色キー（powers.ts colorKeyFor）も情報パネル（info.ts
 *   displayLabel）も誤った宗主を主張してしまう。
 * - france-fiefs への合流は年集合が食い違う。仏諸侯領は 1000〜1300、伊諸侯領は
 *   1000〜1492 なので、1400 / 1492 では "france-fiefs" レイヤーがイタリアの
 *   ポリゴンだけを載せることになり、レイヤー ID が実態を偽る。
 * - 独立レイヤーの追加コストは PICKING_PRIORITY / UNDER_WATER_LAYER_IDS /
 *   POWER_HIGHLIGHT_LAYER_IDS への各 1 行で、整合はいずれも既存の汎用テスト
 *   （layerOrderMatchesPickingPriority 等）がそのまま検証する。
 *
 * PICKING_PRIORITY 上の位置は powers の直上（既存 2 系統の下）。3 系統は
 * scripts/build-fief-flat.ts が幾何的に排他化するため同一ピクセルを 2 枚が
 * 覆うことは無く、オーバーレイ同士の相対順は表示・picking のどちらにも影響
 * しない。ならば既存の相対順（hre-powers > france-fiefs）を動かさない位置に
 * 置くのが最も影響が小さい。
 */
export const ITALY_FIEF_LAYER_ID = "italy-fiefs";

/**
 * Cliopatria 由来の領邦オーバーレイのレイヤー ID（TASK-110）。出典は
 * Cliopatria / Seshat Global History Databank（CC BY 4.0、
 * doi:10.5281/zenodo.14714684）で、既存 3 系統（OHM / Roller）とは別出典。
 *
 * なぜ既存レイヤーへ合流させず独立レイヤーにするのか（ITALY_FIEF_LAYER_ID の
 * 判断をそのまま踏襲する）:
 * - **出典の粒度をレイヤー単位で維持するため**。OHM 由来の FC へ Cliopatria の
 *   feature を混ぜると、1 つの metadata が 2 つの出典・2 つのライセンスを
 *   同時に主張する。CC BY 4.0 の帰属要件を生成物内でも追跡できるよう分離する。
 * - 年集合・地域も既存レイヤーと食い違う（仏 1000〜1300 / 伊 1000〜1492 に対し
 *   Cliopatria は仏と帝国の混在で 1000〜1492）。どれへ合流させてもレイヤー ID が
 *   実態を偽る。
 *
 * PICKING_PRIORITY 上の位置は powers の直上（既存 3 系統の下）。Cliopatria は
 * 「OHM に該当リレーションが無い領邦だけ」を収録する補完データで、同じ領邦が
 * 両方に出ることはない（TASK-110 のデータ設計）。さらに
 * scripts/build-fief-flat.ts が幾何的に排他化するため、同一ピクセルを 2 枚が
 * 覆うことは通常ない。それでも最下段に置くのは、境界不一致による微小重なりが
 * 残った場合に「頂点密度が 4〜7 倍高い OHM 側が拾える」方が望ましいから
 * （Cliopatria は 2014 年の手描き地図を自動抽出した 0.07 度平滑化データで、
 * 論文自身が境界を概略と明記している）。既存 3 系統の相対順は動かさない。
 */
export const CLIOPATRIA_FIEF_LAYER_ID = "cliopatria-fiefs";

/**
 * ブリテン諸島の政体オーバーレイのレイヤー ID（#172）。出典は
 * OpenHistoricalMap（CC0、生成は scripts/build-britain-fiefs.ts →
 * scripts/build-fief-flat.ts。TASK-151）。
 *
 * なぜ既存レイヤーへ合流させず独立レイヤーにするのか（ITALY_FIEF_LAYER_ID /
 * CLIOPATRIA_FIEF_LAYER_ID の判断をそのまま踏襲する）:
 * - 年集合が既存のどの系統とも食い違う（仏 1000〜1300 / 伊・HRE 領邦
 *   1000〜1492 に対しブリテンは 1000〜1700 で、唯一近世まで続く）。どれへ
 *   合流させてもレイヤー ID が実態を偽る。
 * - hre-powers への合流は帰属の記述が壊れる。ウェールズ・アイルランドの
 *   諸王国は帝国と無関係の独立主権政体で、SUBJECTO=Holy Roman Empire 前提の
 *   レイヤーに混ぜられない。
 * - 独立レイヤーの追加コストは PICKING_PRIORITY / UNDER_WATER_LAYER_IDS /
 *   POWER_HIGHLIGHT_LAYER_IDS への各 1 行で、整合はいずれも既存の汎用テストが
 *   そのまま検証する。
 *
 * PICKING_PRIORITY 上の位置は powers の直上（既存 4 系統の下）。ブリテン諸島は
 * 大陸のオーバーレイと地理的に重ならないため相対順は表示・picking のどちらにも
 * 影響しないが、「後から追加した層は最も影響の小さい最下段へ積む」既定
 * （TASK-96 / TASK-110 と同じ判断）に従う。
 */
export const BRITAIN_FIEF_LAYER_ID = "britain-fiefs";

/**
 * 主権政体オーバーレイのレイヤー ID（#189）。出典は OpenHistoricalMap
 * （CC0、生成は scripts/build-sovereign-fiefs.ts → scripts/build-fief-flat.ts）。
 *
 * なぜ既存レイヤーへ合流させず独立レイヤーにするのか（BRITAIN_FIEF_LAYER_ID の
 * 判断をそのまま踏襲する）:
 * - 年集合が既存のどの系統とも食い違う（1200〜1900 の 14 年で、唯一 1815 以降
 *   まで続く）。どれへ合流させてもレイヤー ID が実態を偽る。
 * - hre-powers への合流は帰属の記述が壊れる。ハンガリー王国・クリミア・ハン国
 *   などは帝国と無関係の主権政体で、SUBJECTO=Holy Roman Empire 前提の
 *   レイヤーに混ぜられない。
 * - 独立レイヤーの追加コストは PICKING_PRIORITY / UNDER_WATER_LAYER_IDS /
 *   POWER_HIGHLIGHT_LAYER_IDS への各 1 行で、整合はいずれも既存の汎用テストが
 *   そのまま検証する。
 *
 * PICKING_PRIORITY 上の位置は **政治ポリゴン 7 層の最上段**（#191 で
 * powers の直上から引き上げた）。#189/#190 の時点では「既存オーバーレイと
 * 地理的にほぼ重ならないため相対順は影響しない」として最下段（powers の直上）
 * に置いていたが、#191 で微小国家（サンマリノ 7〜61 km²・モナコ 18 km²・
 * リヒテンシュタイン 157 km²・アンドラ 465 km²）を収録したことで前提が崩れた:
 *
 * - クリックの解決は直下 pick ではなく **半径 PICKING_RADIUS_PX（6px）の
 *   近傍再ピック → PICKING_PRIORITY で 1 件選ぶ**（resolveClickPick）。
 *   ポリゴンが数十 px しかない微小国家では、カーソルが中に入っていても
 *   6px 先の隣接オーバーレイが候補に入り、優先順が上ならそちらが勝つ。
 * - 実測（2026-08・ヘッドレス CDP、zoom 7）: 1300 / 1500 年のサンマリノは
 *   ホバーでは `sovereign-fiefs` / サンマリノを拾うのに、クリックでは
 *   `italy-fiefs` のリミニ領主領（サンマリノを取り囲む諸侯領）が勝ち、
 *   情報パネルにサンマリノを出せなかった。
 *
 * これは TASK-71 が france-fiefs を powers の上へ置いた理由（内側に完全に
 * 含まれる小さい区画は、下に置くと常に外側の大きい区画に負ける）と同型で、
 * 「より小さく、より個別性の高い政体を優先する」という同じ原則の適用になる。
 * flat 化（scripts/build-fief-flat.ts）は重なりを常に主権政体側から差し引く
 * ため、両者が同一ピクセルを塗ることは無く、この引き上げで表示は変わらない
 * （変わるのは近傍再ピックの綱引きだけ）。
 */
export const SOVEREIGN_FIEF_LAYER_ID = "sovereign-fiefs";

/** 主要都市マーカー（ScatterplotLayer）のレイヤー ID（TASK-27） */
export const CITY_LAYER_ID = "cities";

/**
 * 都市マーカーの透明ヒット層（ScatterplotLayer）のレイヤー ID（TASK-82）。
 * cities と同一データを完全透明・大半径（cities.ts CITY_HIT_RADIUS_PX）で
 * 描画する判定専用レイヤー。rivers-hit（TASK-43）と同型の仕組みで、
 * 「ホバーは直下 pick のみ・クリックだけ近傍再ピック」という非対称
 * （TASK-36 の設計判断）を、ホバー側にコストを足さずに解消する。
 *
 * PICKING_PRIORITY 上は cities（可視ドット）と rivers（可視ライン）には
 * 劣後させ、rivers-hit よりは優先させる:
 * - 可視の河川ライン直上は従来どおり河川（decision-7 / TASK-49 維持）
 * - 都市ドット直上は都市（ドット層が上なので隣接都市の判定円に負けない）
 * - 河川の判定帯（rivers-hit、±7px）と都市の判定円が重なる領域は都市。
 *   河畔都市（パリ・ルーアン等）でも「中心から一定距離以内は必ず都市」
 *   （AC #1）を成立させるため。可視ラインは rivers が最優先のままなので、
 *   見えている川をクリックできなくなる領域は生じない。
 */
export const CITY_HIT_LAYER_ID = "cities-hit";

/** 主要河川ライン（GeoJsonLayer）のレイヤー ID（TASK-24） */
export const RIVERS_LAYER_ID = "rivers";

/**
 * picking の許容半径（px）（TASK-36、TASK-51 で main.ts から移設）。
 * deck.gl Deck の pickingRadius（ホバー）・pickMultipleObjects の radius
 * （クリック時の近傍再ピック、main.ts resolveClickInfo）両方に使う値。
 * 「カーソル直下に何も無い場合」の近傍探索半径で、細い河川ライン（通常
 * 3px）でもカーソルが多少ずれた位置のクリック/ホバーを拾えるようにする
 * （TASK-24 AC #2）。
 *
 * rivers.ts の RIVER_HIT_LINE_WIDTH_PX（透明ヒットライン層の幅）とは別の
 * 実効判定幅の構成要素で、河川クリックの実効許容範囲は
 * 「ヒットライン半幅（RIVER_HIT_LINE_WIDTH_PX / 2）+ この半径」の合成になる。
 * 導出値は rivers.ts の RIVER_CLICK_TOLERANCE_PX を参照（TASK-51）。
 */
export const PICKING_RADIUS_PX = 6;

/**
 * 河川の透明ヒットライン層（GeoJsonLayer）のレイヤー ID（TASK-43）。
 * rivers と同一データを完全透明・太幅（RIVER_HIT_LINE_WIDTH_PX）で描画し、
 * 判定専用レイヤーとして重ねる。deck.gl の picking はカーソル直下オブジェクト
 * 優先で、全面を覆う powers ポリゴンの手前では rivers の実効判定幅が描画
 * ライン幅（3px）の半分程度しかなく、特にホバーが pickingRadius（直下に
 * 何も無い場合のみ効く）では補えない（TASK-36 で実測）。この層を重ねることで、
 * ホバー/クリックとも直下 pick だけで太幅分の判定幅を得る。
 *
 * PICKING_PRIORITY 上は cities より劣後させる（TASK-49）。rivers-hit は
 * 幅 14px（±7px）と太く、河畔都市（ズーム 4〜7 のパリ等）のマーカーを帯の
 * 内側に含んでしまい、cities より優先だと都市の picking を構造的に遮蔽して
 * クリック/ホバー不能にするバグがあった（TASK-49 で確認）。rivers-hit は
 * あくまで「可視の河川ライン・都市ドットのどちらの上でもない場所」を河川と
 * みなすための補助層であり、都市ドットには勝たない設計とする。
 */
export const RIVERS_HIT_LAYER_ID = "rivers-hit";

/**
 * picking の優先順（先頭が最優先）: 河川 > 都市 > 都市ヒット層 > 河川ヒット層 >
 * 主権政体（#191 で引き上げ）> HRE 領邦 > 仏諸侯領 > 伊諸侯領 >
 * Cliopatria 領邦 > 勢力（AC #4、TASK-49 で
 * rivers-hit を cities より劣後させ都市 picking の遮蔽を解消、TASK-71 で
 * france-fiefs を powers の上に追加、TASK-82 で cities-hit を cities と
 * rivers-hit の間に追加、TASK-96 で italy-fiefs を powers の直上に追加、
 * TASK-110 で cliopatria-fiefs を powers の直上に追加）。
 * pickable なレイヤーだけを含む（ラベル系レイヤーは
 * pickable: false のため picking に関与せず、このリストにも含めない）。
 *
 * TASK-71: france-fiefs は powers（ベースの France ポリゴン）の上に置く。
 * 諸侯領は France ポリゴンの内側に完全に含まれるため、下に置くと常に
 * powers が勝って諸侯領をホバー/クリックできない。hre-powers との相対順は
 * 現状意味を持たない（同時表示年が無い）が、後から追加された層を上へ
 * 積む既定として hre-powers を上位に保つ。
 *
 * rivers-hit を cities の下・hre-powers/powers の上に置くことで:
 * - 可視の河川ライン（3px）直上は常に河川が最優先（従来どおり、decision-7 維持）
 * - 都市ドット直上は都市が rivers-hit の判定帯より優先（TASK-49 で解消したバグ）
 * - 帯内でラインにも都市にも乗っていない位置は rivers-hit = 河川として扱われ、
 *   TASK-43 が意図した判定幅拡大は維持される
 */
/**
 * TASK-100: 山岳 3 層（山峰マーカー peaks / 山峰判定円 peaks-hit / 山脈判定円
 * mountains-hit）を追加した。位置決めの原則は 2 つで、どちらも既存の並びから
 * 導いたもの:
 *
 * 1. **可視の記号は透明の判定層より上**。rivers（可視ライン）・cities（可視
 *    ドット）が cities-hit / rivers-hit より上にあるのと同じ理由で、可視記号
 *    peaks（▲）は透明層 3 種より上に置く。「見えている記号の直上をクリック
 *    したら必ずその記号」が保証される（TASK-49 / TASK-82 の設計を踏襲）。
 *    可視記号どうしの順は 河川 > 都市 > 山峰。地形の注記（山岳）は年代ごとに
 *    変わる主題（都市・河川）に譲るという TASK-97 / TASK-99 のラベル優先度の
 *    方針を picking にもそのまま持ち込む。
 * 2. **透明の判定層は「主題としての重み」の順**。cities-hit > peaks-hit >
 *    mountains-hit > rivers-hit。rivers-hit を最下段に据え置くのは TASK-49 の
 *    経緯そのもので、幅 14px の帯が点状の対象（都市ドット、いまは山峰・
 *    山脈のアンカーも）を飲み込み、構造的に picking 不能にするため。
 *
 * **山岳 3 層はいずれも政治ポリゴン 4 層より上**に置く（AC #1/#2）。陸上は
 * ほぼ全面が powers に覆われているので、下に置くことは「一度も拾えない」と
 * 同義になる。それでも AC #3（勢力・都市・河川の picking を妨げない）が
 * 成立するのは、山岳側の判定範囲が**面ではなく点まわりの固定 px 円**に
 * 限定されているから（mountains.ts MOUNTAIN_HIT_LAYER_ID の設計判断。
 * 山脈ポリゴンをそのまま pickable にしていたら、勢力のクリックを広範囲で
 * 奪って AC #3 を壊していた）。実際に勢力から奪う面積は、山脈が半径
 * MOUNTAIN_HIT_RADIUS_PX の円 17 個、山峰が半径 PEAK_HIT_RADIUS_PX の円で
 * 現在のズーム段に出ている件数分だけになる。
 */
export const PICKING_PRIORITY: readonly string[] = [
  RIVERS_LAYER_ID,
  CITY_LAYER_ID,
  PEAK_LAYER_ID,
  CITY_HIT_LAYER_ID,
  PEAK_HIT_LAYER_ID,
  MOUNTAIN_HIT_LAYER_ID,
  RIVERS_HIT_LAYER_ID,
  // #191: 主権政体は微小国家を含むため政治ポリゴンの最上段へ引き上げた
  // （根拠は SOVEREIGN_FIEF_LAYER_ID のコメント）
  SOVEREIGN_FIEF_LAYER_ID,
  HRE_LAYER_ID,
  FRANCE_FIEF_LAYER_ID,
  ITALY_FIEF_LAYER_ID,
  CLIOPATRIA_FIEF_LAYER_ID,
  BRITAIN_FIEF_LAYER_ID,
  POWER_LAYER_ID,
];

/**
 * 政治ポリゴン 7 層（面で領域を主張する pickable レイヤー）の集合（#216）。
 * PICKING_PRIORITY の政治セグメント（sovereign-fiefs 〜 powers）と一致する
 * （一致は picking_test.ts が固定する。POWER_HIGHLIGHT_LAYER_IDS
 * （power_highlight.ts）と同じ「集合を定数で持ち、テストで優先リストと
 * 突き合わせる」流儀）。resolveClickPick のカーソル内包判定で
 * 「カーソルが面の内側にあるか」を問う対象を定める。河川・都市・山岳は
 * 点/線まわりの判定層で「カーソルを面として含む」概念が無いため対象外。
 */
export const POLITICAL_PICK_LAYER_IDS: readonly string[] = [
  SOVEREIGN_FIEF_LAYER_ID,
  HRE_LAYER_ID,
  FRANCE_FIEF_LAYER_ID,
  ITALY_FIEF_LAYER_ID,
  CLIOPATRIA_FIEF_LAYER_ID,
  BRITAIN_FIEF_LAYER_ID,
  POWER_LAYER_ID,
];

/**
 * 領邦・諸侯領オーバーレイの pickable レイヤー集合（#349 / #293 分割 4/5）。
 * {@linkcode POLITICAL_PICK_LAYER_IDS} から powers（base 勢力）を除いたもの。
 *
 * 詳細表示 focus（#293 の `detailFocusKey`）で絞り込まれるのはこの 6 系統だけで、
 * powers は「focus 外の国が返るべき受け皿」なので決して降格されない。
 * POLITICAL_PICK_LAYER_IDS から導出するのは、政治層を足したときに両者が
 * 食い違わないようにするため（一致は picking_test.ts が固定する）。
 */
export const FIEF_PICK_LAYER_IDS: readonly string[] = POLITICAL_PICK_LAYER_IDS
  .filter((id) => id !== POWER_LAYER_ID);

/**
 * layerId が河川系（rivers 本体 / rivers-hit 判定専用層）のいずれかかを
 * 判定する（TASK-43）。main.ts のホバー/クリック処理は河川名の取得元を
 * layerId === RIVERS_LAYER_ID で判定していたが、rivers-hit 追加後は
 * このヘルパーで両方をまとめて扱う。
 */
export function isRiversPickLayerId(id: string | undefined): boolean {
  return id === RIVERS_LAYER_ID || id === RIVERS_HIT_LAYER_ID;
}

/**
 * layerId が都市系（cities 可視ドット / cities-hit 判定専用層）かを判定する
 * （TASK-82）。両層は同一データ（CityMarkerDatum）を持つため、ツールチップ/
 * パネルの表示（main.ts pickedLabel）はどちらの pick でも同じ経路で扱える。
 */
export function isCityPickLayerId(id: string | undefined): boolean {
  return id === CITY_LAYER_ID || id === CITY_HIT_LAYER_ID;
}

/**
 * layerId が山峰系（peaks 可視マーカー / peaks-hit 判定専用層）かを判定する
 * （TASK-100）。両層は同一データ（PeakMarkerDatum）を持つため、
 * ツールチップ/パネルの表示はどちらの pick でも同じ経路で扱える
 * （isCityPickLayerId と同型）。
 */
export function isPeakPickLayerId(id: string | undefined): boolean {
  return id === PEAK_LAYER_ID || id === PEAK_HIT_LAYER_ID;
}

/**
 * layerId が山脈系かを判定する（TASK-100）。山脈は可視の記号を持たず
 * 判定専用層（mountains-hit）1 枚だけなので候補は 1 つだが、河川・都市・
 * 山峰と同じ形のヘルパーを置いて main.ts 側の分岐を揃える。
 */
export function isMountainPickLayerId(id: string | undefined): boolean {
  return id === MOUNTAIN_HIT_LAYER_ID;
}

/**
 * クリック時の「カーソル直下に何も無い場合の近傍再ピック」
 * （main.ts resolveClickInfo の pickMultipleObjects、半径 PICKING_RADIUS_PX）
 * の候補として採用してよいレイヤーか（TASK-82）。
 *
 * cities-hit だけを対象外にする。理由: cities-hit は「ホバーでもクリックでも
 * 直下 pick で拾える」ことを目的とした層なので、そこにさらに再ピック半径が
 * 合成されると、クリックだけ CITY_HIT_RADIUS_PX + PICKING_RADIUS_PX まで
 * 広がってホバーとの非対称（TASK-82 が解消すべき当の問題）が再発する。
 * 除外することで都市の実効判定範囲はホバー・クリックとも
 * cities.ts CITY_PICK_TOLERANCE_PX（= CITY_HIT_RADIUS_PX）で一致する。
 *
 * rivers-hit を除外しないのは、河川が「細いライン + 全面を覆う powers」という
 * 構造上、合成された余裕（rivers.ts RIVER_CLICK_TOLERANCE_PX）を意図して
 * 残している既存設計（TASK-51）だから。
 *
 * TASK-100: 山峰・山脈の判定円（peaks-hit / mountains-hit）も同じ理由で除外
 * する。どちらも「ホバーでもクリックでも直下 pick だけで拾える」ことを目的に
 * 置いた層なので、再ピック半径が合成されるとクリックだけ
 * PEAK_HIT_RADIUS_PX / MOUNTAIN_HIT_RADIUS_PX + PICKING_RADIUS_PX まで広がり、
 * ホバーとの非対称が生まれる。とくに山脈は判定円が 18px と大きく、合成すると
 * 24px になって勢力から奪う面積が 1.8 倍になる（AC #3 のコストが膨らむ）。
 */
export function isNearCursorRepickable(id: string | undefined): boolean {
  return id !== CITY_HIT_LAYER_ID && id !== PEAK_HIT_LAYER_ID &&
    id !== MOUNTAIN_HIT_LAYER_ID;
}

/**
 * picking 優先順から描画レイヤー順（配列順 = 下→上）を導出する。
 * deck.gl の picking は最前面（配列の最後）が勝つため、描画順は優先順の
 * 逆順になる。入力配列は変更しない。
 */
export function renderOrderFromPickingPriority(
  priority: readonly string[],
): string[] {
  return [...priority].reverse();
}

/**
 * 複数の picking 候補から PICKING_PRIORITY の最優先 1 件を選ぶ。
 * - 候補ゼロなら null
 * - 優先リスト外の layerId は最後（優先リスト内のどの候補よりも劣後）
 * - 同順位は先勝ち（入力順で安定）
 */
export function selectPreferredPick<T extends { layerId: string }>(
  picks: readonly T[],
): T | null {
  let best: T | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const candidate of picks) {
    const index = PICKING_PRIORITY.indexOf(candidate.layerId);
    // 優先リスト外はどのリスト内候補よりも後ろの順位として扱う
    const rank = index === -1 ? PICKING_PRIORITY.length : index;
    if (rank < bestRank) {
      best = candidate;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * クリック時の半径内 picking 候補（deck.gl pickMultipleObjects 相当。カーソル
 * 直下に何もなくても近傍の pickable オブジェクトを距離順に複数返す）から、
 * PICKING_PRIORITY の最優先候補を選ぶ（TASK-36）。
 *
 * 背景: Deck レベル onClick はカーソル直下ピクセルの最前面 1 件しか返さない。
 * powers（GeoJsonLayer）が全面を覆うため、河川ライン（描画幅 2px）の外側では
 * 常に距離 0 の powers が勝ち、pickingRadius は「直下に何も無い場合」の近傍
 * 探索にしか効かない。pickMultipleObjects で半径内の候補を集め、
 * selectPreferredPick で優先順に選び直すことでこれを解消する。
 *
 * - 候補ゼロなら null
 * - layer が pickable な候補が 1 件も無ければ先頭候補（layer: null の info。
 *   何も無い場所のクリック）をそのまま返す
 * - rivers が候補に無ければ既存挙動（先頭 = カーソル直下の最前面）と同じ結果
 *   になる（render 順が PICKING_PRIORITY の逆順であるため、pickMultipleObjects
 *   の先頭候補は非 rivers 候補の中でも既に最優先の層である）
 */
/**
 * クリックの直下 pick をそのまま確定してよいレイヤーか（TASK-49）。
 * rivers/rivers-hit に加え cities も確定扱いにする: 都市ドットの直下ヒットを
 * 近傍河川の radius 再ピック（PICKING_PRIORITY で rivers > cities）が奪うと、
 * 河畔都市がクリック不能になるため。radius 再ピックは「直下が powers/HRE/空白
 * だった場合の近傍探索」に限定する。
 *
 * TASK-100: 山峰・山脈も同じ理由で確定扱いにする。アルプス周辺はローヌ川・
 * ライン川・ドナウ川・ポー川が massif を貫くので、直下で山峰・山脈を拾えて
 * いるのに近傍の河川（PICKING_PRIORITY 上位）へ奪われる状況が起きやすい。
 */
export function isDirectPickFinal(id: string | undefined): boolean {
  return isRiversPickLayerId(id) || isCityPickLayerId(id) ||
    isPeakPickLayerId(id) || isMountainPickLayerId(id);
}

/**
 * 政治ポリゴン候補がカーソル座標（lng/lat）を実際に含むかを判定する（#216）。
 * 3 値を返す:
 * - true: 含む（降格されず、含まない政治候補を降格させる根拠になる）
 * - false: 含まない（含む候補が 1 つでもあれば候補から除外される）
 * - null: 判定対象外（政治ポリゴン以外 / feature なし / Polygon 系でない
 *   ジオメトリ）。「含まない」扱いにはせず安全側に倒す = 降格されない
 */
function politicalCursorContainment(
  candidate: { layer: { id: string }; object?: unknown },
  cursor: readonly number[],
): boolean | null {
  if (!POLITICAL_PICK_LAYER_IDS.includes(candidate.layer.id)) return null;
  const geometry = (candidate.object as Feature | null | undefined)?.geometry;
  if (
    geometry === undefined || geometry === null ||
    (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")
  ) {
    return null;
  }
  return booleanPointInPolygon(
    [cursor[0], cursor[1]],
    geometry as Polygon | MultiPolygon,
  );
}

/**
 * カーソルを含む政治ポリゴン候補が 1 つ以上あるとき、含まない政治ポリゴン
 * 候補を候補集合から除外する（#216）。1 つも含まない（海上クリック等）・
 * 判定不能のみなら降格せず、入力をそのまま返す。
 */
function demotePoliticalPicksOutsideCursor<
  T extends { layer: { id: string }; object?: unknown },
>(pickable: readonly T[], cursor: readonly number[]): readonly T[] {
  const containment = pickable.map((candidate) =>
    politicalCursorContainment(candidate, cursor)
  );
  if (!containment.includes(true)) return pickable;
  return pickable.filter((_, index) => containment[index] !== false);
}

/**
 * 詳細表示 focus（#293 の `detailFocusKey`）を picking へ適用するための引数
 * （#349 / #293 分割 4/5）。
 *
 * - `key`: focus の宗主キー。**`null` は「focus 有効だが中央が海上・base 勢力外」**
 *   = 詳細表示を行わない状態で、領邦オーバーレイは 1 枚も表示されない
 *   （#293 AC6）。このとき picking も全領邦を降格し、全域が上位勢力単位になる。
 * - `suzerainKeyOf`: 領邦候補の宗主キーを解決するコールバック。実体は
 *   suzerain_extent.ts の `suzerainExtentKey`（宣言宗主 SUBJECTO と base の
 *   包含の両方を扱う）だが、suzerain_extent.ts が picking.ts を import して
 *   いるため逆向きの依存を作らないよう注入で受ける。
 *
 * `resolveClickPick` の第 3 引数そのものを省略・`null` にした場合は
 * **focus 機能がオフ**（既存呼び出しと完全に同一の挙動）になる。「focus 機能が
 * オフ」と「focus が解決できなかった」を区別するのは、後者では領邦が表示されず
 * picking も上位勢力単位になるべきだから（#349 AC4 / AC6）。
 */
export interface PickDetailFocus {
  readonly key: string | null;
  readonly suzerainKeyOf: (
    layerId: string,
    object: unknown,
  ) => string | null;
}

/**
 * 詳細表示 focus の外にある領邦オーバーレイ候補を候補集合から除外する
 * （#349。{@linkcode demotePoliticalPicksOutsideCursor} と同型の「降格」）。
 *
 * 残すのは「focus と同じ宗主キーへ解決される領邦」だけ。宗主キーが解決でき
 * ない封土（上流が SUBJECTO を持たず base にも包含されないもの。伊のピオン
 * ビーノ領主領など）も降格する: 表示側（#293 分割 3/5）は宗主キーで分類して
 * focus グループを選ぶため、キーの無い封土はどの focus でも描かれない。
 * 残すと「見えないのに pickable」な面になり、#293 AC5 が壊れる。
 *
 * focus がオフ（引数なし・null）なら入力をそのまま返す = 既存挙動。
 */
function demotePoliticalPicksOutsideFocus<
  T extends { layer: { id: string }; object?: unknown },
>(
  pickable: readonly T[],
  focus: PickDetailFocus | null | undefined,
): readonly T[] {
  if (focus === null || focus === undefined) return pickable;
  const { key, suzerainKeyOf } = focus;
  return pickable.filter((candidate) => {
    if (!FIEF_PICK_LAYER_IDS.includes(candidate.layer.id)) return true;
    // key === null（詳細表示なし）ならどの領邦も残らない。宗主キーが null の
    // 封土を「key === null と一致」で残さないよう、先に key を見る
    if (key === null) return false;
    return suzerainKeyOf(candidate.layer.id, candidate.object) === key;
  });
}

export function resolveClickPick<
  T extends { layer: { id: string } | null; object?: unknown },
>(
  picks: readonly T[],
  cursor?: readonly number[] | null,
  focus?: PickDetailFocus | null,
): T | null {
  // TASK-82: cities-hit は近傍再ピックの候補にしない（isNearCursorRepickable）。
  // 直下 pick が cities-hit なら isDirectPickFinal でここへ来ないため、ここに
  // 現れる cities-hit は「カーソルから半径 PICKING_RADIUS_PX 以内にあるが
  // 判定円の外」= ホバーでは都市を拾えない位置の候補で、採用するとクリック
  // だけ範囲が広がる。
  const considered = picks.filter((candidate) =>
    isNearCursorRepickable(candidate.layer?.id)
  );
  if (considered.length === 0) return null;
  const pickable = considered.filter(
    (candidate): candidate is T & { layer: { id: string } } =>
      candidate.layer !== null,
  );
  if (pickable.length === 0) return considered[0];
  // #216: 近傍再ピックは半径 PICKING_RADIUS_PX 内の候補を全て集めるため、
  // カーソルが実際には外側にある隣の政治ポリゴンも候補に入る。ホバー
  // （直下 pick）はカーソルを含む面しか拾わないので、優先順だけで選ぶと
  // 「ホバーは小所領・クリックは隣の大国」の乖離が生まれる（#191 が微小国家
  // について解消した乖離の、対象が入れ替わった再発）。カーソルを含む政治
  // ポリゴン候補があれば、含まない政治ポリゴン候補を降格（除外）してから
  // 優先順で選ぶ。非政治候補（河川・都市・山岳）は点/線まわりの判定層なので
  // 対象外（rivers.ts RIVER_CLICK_TOLERANCE_PX の合成契約は不変）。
  const narrowed = cursor === undefined || cursor === null || cursor.length < 2
    ? pickable
    : demotePoliticalPicksOutsideCursor(pickable, cursor);
  // #349: focus 外の領邦オーバーレイは表示されない（#293 分割 3/5 が data を
  // 空 FC にする）ため、picking 候補としても降格する。両者は独立に正しく、
  // 「不可視の領邦が picking を奪う」状態をどちらか一方だけでも防ぐ。
  // 全候補が降格されて空になった場合は下の selectPreferredPick が null を返し、
  // 従来どおり considered[0]（直下 pick 相当）へフォールバックする。
  const focused = demotePoliticalPicksOutsideFocus(narrowed, focus);
  const withLayerId = focused.map((info) => ({
    layerId: info.layer.id,
    info,
  }));
  const best = selectPreferredPick(withLayerId);
  return best === null ? considered[0] : best.info;
}

/**
 * 描画レイヤー配列（下→上）の並びが PICKING_PRIORITY と整合するか検証する。
 * 「整合する」とは、配列中の pickable レイヤー（PICKING_PRIORITY に含まれる
 * ID）を出現順に抜き出したとき、優先順の逆順（優先が高いものほど上に描画）に
 * 並んでいて重複が無いこと。優先リスト外の ID（ラベル系など）は無視し、
 * 一部の pickable レイヤーが無い構成でも残りの相対順だけで判定する。
 */
export function layerOrderMatchesPickingPriority(
  layerIds: readonly string[],
): boolean {
  const actual = layerIds.filter((id) => PICKING_PRIORITY.includes(id));
  const expected = renderOrderFromPickingPriority(PICKING_PRIORITY)
    .filter((id) => actual.includes(id));
  if (actual.length !== expected.length) return false;
  return actual.every((id, i) => id === expected[i]);
}
