/**
 * deck.gl レイヤーと MapLibre スタイルの重ね順の構成（TASK-77）。
 * DOM / deck.gl / MapLibre に依存しない純粋ロジックのみを置く。
 *
 * 扱う関心は 2 つで、どちらも「政治ポリゴンをベースマップの水面より下へ回す」
 * ことから派生する:
 *   1. どの deck レイヤーに beforeId（水面レイヤー）を付けるか（underWaterBeforeId）
 *   2. どの deck レイヤーを interleaved ではなく overlaid オーバーレイに載せるか
 *      （OVERLAID_LAYER_IDS / overlaySplitIsValid）
 *
 * 背景（1: 海へのはみ出し）:
 * ベースマップ（Protomaps / OSM の現代海岸線・メートル級）と政治ポリゴン
 * （historical-basemaps 等・セグメント中央値で数〜十数 km）は別々の海岸線を
 * 持つため、勢力・諸侯領の塗りが海岸線を越えて海へはみ出す（1200 年の
 * ブルターニュ半島先端・ジロンド北岸などで顕著。西欧域で計 ≈ 2.5 万 km2）。
 * データ側で海岸線を一致させるのは解像度差が大きく現実的でないため、描画順で
 * 隠す: interleaved レンダリング（MapboxOverlay の interleaved: true）では
 * レイヤー prop beforeId で MapLibre スタイルの任意レイヤーの直下へ deck
 * レイヤーを差し込めるので、塗りを不透明な水面ポリゴン（basemap.ts の
 * WATER_LAYER_ID、fill-color #c7d2d0）の下へ回し、海上のはみ出しを覆わせる。
 *
 * 注意（AC #4）: @deck.gl/mapbox の resolveLayerGroups は
 * `map.addLayer(group, beforeId)` を呼ぶだけで beforeId の実在を検証しない。
 * MapLibre は存在しない beforeId に対して例外ではなく error イベントを発火し
 * レイヤーを追加しないため、そのままでは対象ポリゴンが「無言で描画されない」。
 * よって beforeId は必ず現在のスタイルのレイヤー id 列と突き合わせ、無ければ
 * undefined（= 従来どおり最前面グループ）へフォールバックする。
 */

import {
  COASTAL_FILL_LAYER_ID,
  COASTLINE_LAYER_ID,
  WATER_INLAND_LAYER_ID,
  WATER_LAYER_ID,
} from "./basemap.ts";
import {
  BRITAIN_FIEF_LAYER_ID,
  CLIOPATRIA_FIEF_LAYER_ID,
  FRANCE_FIEF_LAYER_ID,
  HRE_LAYER_ID,
  ITALY_FIEF_LAYER_ID,
  POWER_LAYER_ID,
  SOVEREIGN_FIEF_LAYER_ID,
} from "./picking.ts";
import { APPROXIMATE_BORDER_LAYER_IDS } from "./approximate_borders.ts";

/**
 * 水面より下へ差し込む対象とする MapLibre スタイル側のレイヤー ID。
 * ベースマップスタイルの water（basemap.ts）と同一。
 */
export const WATER_STYLE_LAYER_ID = WATER_LAYER_ID;

/**
 * 水面より下へ回す deck レイヤーの ID（政治ポリゴンの塗り 7 枚）。
 * 相対順（powers → britain-fiefs → cliopatria-fiefs → italy-fiefs →
 * france-fiefs → hre-powers → sovereign-fiefs。#191 で sovereign-fiefs を
 * 最上段へ引き上げた）は同一 beforeId のグループ内で deck レイヤー配列順が
 * 保たれるため、この定数の並び自体には意味が無い（順は
 * renderOrderFromPickingPriority が決める）。
 *
 * TASK-78 の base 境界線オーバーレイ（deck の base-outlines）は TASK-80 で
 * MapLibre の line レイヤー（approximate_borders.ts）へ移したため、ここには
 * 含まれない。deck 側に境界線の層は無く、この 4 枚は全て塗り
 * （powers は stroked: false、諸侯領・HRE 領邦は自前の stroke）。
 *
 * TASK-96: 伊諸侯領も他の政治ポリゴンと同じくベースマップの水面より下へ回す。
 * ジェノヴァ共和国・ピサ共和国は海岸線に沿った細長い領域で、base ポリゴンと
 * 同じくリグーリア海・ティレニア海へはみ出すため、外すと海上に塗りが露出する。
 *
 * TASK-110: Cliopatria 由来の領邦も同じ扱いにする。むしろ既存 3 系統より
 * 必要性が高い: Cliopatria は 0.07 度に平滑化された概略ジオメトリなので
 * 海岸線の一致度が OHM 由来より低く（アキテーヌ公領・ガスコーニュ公領は
 * ビスケー湾側、ブランデンブルクはバルト海側）、水面より上に置くと海への
 * はみ出しがそのまま露出する。
 *
 * #172: ブリテン諸島の政体も同じ扱いにする。アイリッシュ海・大西洋岸の
 * 海岸線はベースマップと OHM 由来ポリゴンで解像度が異なり、base と同じく
 * 海へはみ出すため、水面より上に置くと海上に塗りが露出する。
 *
 * #189: 主権政体オーバーレイも同じ扱いにする。バルト海（フィンランド）・
 * 黒海（クリミア）・アドリア海（ラグーザ・モンテネグロ）・エーゲ海（クレタ・
 * イオニア諸島）の海岸線が同様に海へはみ出す。
 *
 * hre-extent（帝国範囲の強調輪郭）は含めない: 常時表示ではなくトグルで出す
 * 強調記号であり、水面より下だと海側の輪郭が切れて「どこからどこまでが帝国か」の
 * 表現が壊れるため、従来どおり水面より上に残す。
 */
export const UNDER_WATER_LAYER_IDS: readonly string[] = [
  POWER_LAYER_ID,
  SOVEREIGN_FIEF_LAYER_ID,
  BRITAIN_FIEF_LAYER_ID,
  CLIOPATRIA_FIEF_LAYER_ID,
  ITALY_FIEF_LAYER_ID,
  FRANCE_FIEF_LAYER_ID,
  HRE_LAYER_ID,
];

/**
 * deck レイヤーに与える beforeId を返す純粋関数。
 * - 対象外のレイヤー（河川・都市・ラベル等）は undefined（従来の描画順）
 * - 対象でも、渡されたスタイルに水面レイヤーが無ければ undefined
 *   （フォールバックスタイルやスタイル未読込でも例外を投げない。AC #4）
 *
 * TASK-80: スタイルに概略境界レイヤー（approximate_borders.ts）があれば、水面
 * ではなくその最下段の直下を指す。狙いは「塗り（deck）→ 概略境界（MapLibre）
 * → 海洋の水面」の順を作ること。
 *
 * なぜ deck 側の beforeId で解決するのか: 逆方向（概略境界を addLayer 後に
 * moveLayer で塗りの上へ引き上げる）を実装して実測したところ、@deck.gl/mapbox が
 * styledata を購読してレイヤーグループを再挿入するため、moveLayer → styledata →
 * deck の再挿入 → 順序が再び崩れる、の無限ループになった（ヘッドレス確認で
 * moveLayer 213 回・順序は最後に deck が勝った状態のまま）。deck が自分で
 * 「概略境界の直下」へ入るようにすれば、何度再挿入されても同じ位置に落ち着く。
 *
 * UNDER_WATER_LAYER_IDS の全枚が同じ値を返すことが必須（別グループへ分かれると
 * 相対順が崩れる）。
 *
 * @param layerId deck レイヤーの ID
 * @param styleLayerIds 現在の MapLibre スタイルのレイヤー ID 列
 */
export function underWaterBeforeId(
  layerId: string,
  styleLayerIds: readonly string[],
): string | undefined {
  if (!UNDER_WATER_LAYER_IDS.includes(layerId)) return undefined;
  const lowestBorderLayer = APPROXIMATE_BORDER_LAYER_IDS.find((id) =>
    styleLayerIds.includes(id)
  );
  if (lowestBorderLayer !== undefined) return lowestBorderLayer;
  return styleLayerIds.includes(WATER_STYLE_LAYER_ID)
    ? WATER_STYLE_LAYER_ID
    : undefined;
}

/**
 * ベースマップ側の水面 3 層（内水面 → 海洋 → 海岸線）が想定の重ね順かを検証する
 * 純粋関数（TASK-84）。政治ポリゴンは beforeId = 海洋 water の直下に入るため、
 * この順序がそのまま「内水面 → 政治ポリゴン → 海洋 → 海岸線」を意味する:
 * - 内水面が海洋より上だと、湖・川が政治ポリゴンの塗りを虫食い状に抜く
 * - 海岸線が海洋より下だと、海岸線が海に覆われて沿岸の線が消える（TASK-84 の退行）
 *
 * #305: 沿岸補完（coastal-fill、coastal_fill_sync.ts）があれば、内水面・海洋の
 * どちらよりも下であることも要求する:
 * - 内水面より上だと、帯が湖・内水面を塗ってしまう（AC4）
 * - 海洋より上だと、帯が現代海岸線を越えて海上に浮く（AC3 の退行）
 *
 * 対象レイヤーを持たないスタイル（OpenFreeMap へのフォールバック、スタイル
 * 未読込）では順序を要求しない: その場合 underWaterBeforeId も beforeId を
 * 付けず従来の描画順になるため、不整合ではない（沿岸補完もそのスタイルには
 * 追加されない）。
 *
 * @param styleLayerIds 現在の MapLibre スタイルのレイヤー ID 列
 */
export function waterStackIsValid(styleLayerIds: readonly string[]): boolean {
  const idx = (id: string) => styleLayerIds.indexOf(id);
  const inland = idx(WATER_INLAND_LAYER_ID);
  const marine = idx(WATER_STYLE_LAYER_ID);
  const coastline = idx(COASTLINE_LAYER_ID);
  const coastalFill = idx(COASTAL_FILL_LAYER_ID);
  if (inland >= 0 && marine >= 0 && inland > marine) return false;
  if (coastline >= 0 && marine >= 0 && coastline < marine) return false;
  if (coastalFill >= 0 && inland >= 0 && coastalFill > inland) return false;
  if (coastalFill >= 0 && marine >= 0 && coastalFill > marine) return false;
  return true;
}

/**
 * 概略境界（MapLibre line レイヤー、approximate_borders.ts）を挿入する
 * beforeId を返す純粋関数（TASK-80）。
 *
 * 海洋の水面（WATER_STYLE_LAYER_ID）の直下へ入れる。狙いは 2 つで、
 * - 政治ポリゴンの塗り（beforeId が同じ = 水面直下のグループ）より「後から」
 *   この位置へ入れることで塗りの上に線が来る（低 alpha の概略線が半透明の
 *   塗り越しに沈まない。従来 deck の stroke は塗りの上だった）
 * - 海洋の水面より下なので、政治ポリゴンが海へはみ出した区間の線は海に覆われる
 *   （海上に誤った境界線が出ない = TASK-84 の趣旨を維持）
 *
 * 水面レイヤーを持たないスタイル（OpenFreeMap へのフォールバック、スタイル
 * 未読込）では undefined を返し、呼び出し側は beforeId なし（最前面）で
 * 追加する。線が海に覆われなくなるだけで例外は起きない。
 */
export function approximateBorderBeforeId(
  styleLayerIds: readonly string[],
): string | undefined {
  return styleLayerIds.includes(WATER_STYLE_LAYER_ID)
    ? WATER_STYLE_LAYER_ID
    : undefined;
}

/**
 * @deck.gl/mapbox が MapLibre スタイルへ挿入する「レイヤーグループ」の ID の
 * 接頭辞（@deck.gl/mapbox 9.3.7 dist/resolve-layer-groups.js）。
 *
 * 重要: deck の interleaved レイヤーは 1 枚ずつ MapLibre のレイヤーになるのでは
 * なく、beforeId ごとに 1 枚の custom レイヤーへまとめられる。ID は
 * `deck-layer-group-before:<beforeId>` /  `deck-layer-group-slot:<slot>` /
 * `deck-layer-group-last` の 3 形。つまりスタイル上に "powers" という ID は
 * 存在せず、政治ポリゴンの塗りとの前後関係はこのグループ ID で判定する
 * （ヘッドレス確認で実際の getLayersOrder() が
 * […, water-inland, deck-layer-group-before:water, water, coastline,
 * deck-layer-group-last] であることを実測）。
 */
export const DECK_LAYER_GROUP_ID_PREFIX = "deck-layer-group-";

/**
 * 政治ポリゴンの塗り（powers / france-fiefs / hre-powers）が入っている deck の
 * レイヤーグループ ID を返す純粋関数（TASK-80）。スタイルにそのグループがまだ
 * 無ければ undefined（deck 未登録・スタイル差し替え直後）。
 *
 * 探し方: beforeId 付きのグループ（`…-before:*`）は水面下へ回した政治ポリゴン
 * 専用で、UNDER_WATER_LAYER_IDS の全枚が同じ beforeId を共有するため最大 1 つ。
 * 「今あるべき beforeId」から ID を組み立てるのではなく実在するものを探すのが
 * 重要で、そうしないと beforeId が古い（概略境界が追加される前に作られた
 * deck レイヤーが water を指したまま）状態を検出できない。beforeId 付きの
 * グループが無い場合は最前面グループ（`…-last`）に全 deck レイヤーが入っている
 * （water を持たないフォールバックスタイル）。
 */
export function politicalFillGroupId(
  styleLayerIds: readonly string[],
): string | undefined {
  const withBeforeId = styleLayerIds.find((id) =>
    id.startsWith(`${DECK_LAYER_GROUP_ID_PREFIX}before:`)
  );
  if (withBeforeId !== undefined) return withBeforeId;
  const lastGroup = `${DECK_LAYER_GROUP_ID_PREFIX}last`;
  return styleLayerIds.includes(lastGroup) ? lastGroup : undefined;
}

/**
 * 概略境界レイヤーが「政治ポリゴンの塗りより上・海洋の水面より下」に居るかを
 * 検証する純粋関数（TASK-80）。
 *
 * 正しい順序は deck 側の beforeId（underWaterBeforeId が概略境界の最下段を指す）
 * で作るが、deck レイヤーは構築時の props を持ち回るため、概略境界がまだ無い
 * 時点で作られた deck レイヤーは beforeId = water のままになり、塗りが概略境界の
 * 上に来る。main.ts はこの関数で毎回位置を確認し、崩れていれば renderLayers() で
 * deck レイヤーを作り直して beforeId を再計算させる（概略境界を moveLayer で
 * 引き上げる方向は deck の再挿入と無限に競合するため採らない）。
 *
 * #228: 概略境界レイヤーどうしの相対順（casing → normal → long → very-long =
 * APPROXIMATE_BORDER_LAYER_IDS の並び）も検証する。casing はインク線（tier 群）
 * の下に敷くクリーム色の下地なので、tier より上に来るとクリーム帯が境界線を
 * 覆って洗い流してしまう。
 *
 * 判定しないケース（true を返す）:
 * - 概略境界レイヤーがまだ無い（起動直後・スタイル差し替え直後）
 * - 海洋の水面が無い（フォールバックスタイル）→ 塗りとの前後だけを見る
 * - deck のグループがまだ無い（deck 未登録）→ 水面との前後だけを見る
 */
export function approximateBorderStackIsValid(
  styleLayerIds: readonly string[],
): boolean {
  const marine = styleLayerIds.indexOf(WATER_STYLE_LAYER_ID);
  const groupId = politicalFillGroupId(styleLayerIds);
  const fill = groupId === undefined ? -1 : styleLayerIds.indexOf(groupId);
  const present = APPROXIMATE_BORDER_LAYER_IDS
    .map((id) => styleLayerIds.indexOf(id))
    .filter((idx) => idx >= 0);
  // 存在するレイヤーが APPROXIMATE_BORDER_LAYER_IDS の並び（下から順）を
  // 保っていること（一部だけ存在する追加途中は、その範囲の順だけを見る）
  for (let i = 1; i < present.length; i++) {
    if (present[i] < present[i - 1]) return false;
  }
  return present.every((idx) => {
    if (marine >= 0 && idx > marine) return false;
    return !(fill >= 0 && idx < fill);
  });
}

/**
 * 勢力名ラベル（TextLayer）のレイヤー ID（TASK-20）。
 * powers / hre-powers の上に重ね、年代切替では data のみ差し替える。
 */
export const LABEL_LAYER_ID = "power-labels";

/** 河川名ラベル（TextLayer）のレイヤー ID（TASK-24） */
export const RIVER_LABEL_LAYER_ID = "river-labels";

/** 都市名ラベル（TextLayer）のレイヤー ID（TASK-27） */
export const CITY_LABEL_LAYER_ID = "city-labels";

/** 山脈名ラベル（TextLayer）のレイヤー ID（TASK-97） */
export const MOUNTAIN_LABEL_LAYER_ID = "mountain-labels";

/**
 * 山峰名ラベル（TextLayer）のレイヤー ID（TASK-99）。山峰マーカー（peaks、
 * peaks.ts PEAK_LAYER_ID）は記号なので interleaved 側に残し、名前のラベルだけを
 * ここへ載せる（衝突空間はラベル 5 層で共有する）。
 */
export const PEAK_LABEL_LAYER_ID = "peak-labels";

/**
 * interleaved ではなく overlaid オーバーレイ（deck 専用 canvas）に載せる
 * レイヤーの ID（TASK-77）。
 *
 * なぜ分けるのか: beforeId を使うと interleaved のレイヤーグループが 2 つに
 * 分かれる（水面より下のグループ / 従来の最前面グループ）。@deck.gl/mapbox は
 * グループごとに `deck._drawLayers` を呼び、そのグループのレイヤーだけを通す
 * layerFilter を渡す。CollisionFilterExtension の CollisionFilterEffect は
 * preRender でこの layerFilter を衝突マップ（collision FBO）の描画にも適用する
 * ため、先に描画される「水面より下」グループのパスで衝突マップがラベル抜きで
 * 描き直され、空のマップができる。さらに同エフェクトは「レイヤーもビューポートも
 * 変わっていなければ再描画しない」ため、後続のラベル側グループのパスでは
 * 描き直されない。結果、衝突判定で全ラベルが不可視と判定され 1 つも表示され
 * なくなる（@deck.gl/extensions 9.3.7 collision-filter-effect.js の
 * preRender / _render で確認。ヘッドレス実機でもラベル全滅を再現し、
 * collisionEnabled: false にすると復活することで原因を特定した）。
 *
 * TASK-97: 山脈名ラベル（mountain-labels）も同じ理由で overlaid 側に載せる。
 * 並びの先頭（= 最初に描く）に置くのは、地形の注記が政治・都市の注記より
 * 下の階層だという意味づけを配列順にも残すため。表示の取捨は配列順ではなく
 * CollisionFilterExtension の priority（mountains.ts の帯設計）が決めるので、
 * 位置を変えても見た目は変わらない。
 *
 * TASK-99: 山峰名ラベル（peak-labels）も同様に overlaid 側へ。勢力名・都市名と
 * 同一の衝突空間に入れることが AC #3（山峰ラベルが他のラベルと重なって
 * 読めなくならない）の前提なので、ここに載せる以外の選択肢は無い。並びは
 * 山脈名の直後（地形の注記どうしを隣接させる）。
 *
 * ラベル 4 層は pickable: false で picking に一切関与せず（PICKING_PRIORITY に
 * 含まれない）、描画順も常に最前面のため、overlaid オーバーレイ（地図 canvas の
 * 上に重ねる deck 専用 canvas。コンテナは pointer-events: none なので地図操作を
 * 妨げない）へ移しても見た目・操作は変わらない。移すことで衝突判定が
 * interleaved のグループ分割から完全に切り離され、水面オクルージョンと衝突
 * フィルタが両立する。3 層は同一 deck インスタンスにまとめて残すため、共有
 * 衝突空間（labels.ts の COLLISION_SIZE_SCALE と priority による間引き）も
 * 従来どおり効く。
 */
export const OVERLAID_LAYER_IDS: readonly string[] = [
  MOUNTAIN_LABEL_LAYER_ID,
  PEAK_LABEL_LAYER_ID,
  LABEL_LAYER_ID,
  RIVER_LABEL_LAYER_ID,
  CITY_LABEL_LAYER_ID,
];

/**
 * interleaved / overlaid 2 つのオーバーレイへのレイヤー分配が正しいかを
 * 検証する純粋関数（main.ts の renderLayers が毎回この不変条件を確認する。
 * layerOrderMatchesPickingPriority と同じ「壊れたら即座に気付く」ための検査）。
 *
 * 正しい分配とは:
 * - overlaid 側が OVERLAID_LAYER_IDS と完全一致（順序込み。過不足・混入なし）
 * - interleaved 側に overlaid 対象のレイヤーが残っていない
 */
export function overlaySplitIsValid(
  interleavedIds: readonly string[],
  overlaidIds: readonly string[],
): boolean {
  if (overlaidIds.length !== OVERLAID_LAYER_IDS.length) return false;
  if (!overlaidIds.every((id, i) => id === OVERLAID_LAYER_IDS[i])) return false;
  return !interleavedIds.some((id) => OVERLAID_LAYER_IDS.includes(id));
}
