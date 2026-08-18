import { assert, assertEquals } from "@std/assert";
import {
  approximateBorderBeforeId,
  approximateBorderStackIsValid,
  CITY_LABEL_LAYER_ID,
  DECK_LAYER_GROUP_ID_PREFIX,
  LABEL_LAYER_ID,
  MARINE_LABEL_LAYER_ID,
  MOUNTAIN_LABEL_LAYER_ID,
  OVERLAID_LAYER_IDS,
  overlaySplitIsValid,
  OVERVIEW_LABEL_CALLOUT_LAYER_ID,
  PEAK_LABEL_LAYER_ID,
  politicalFillGroupId,
  RIVER_LABEL_LAYER_ID,
  suzerainExtentBeforeId,
  TOP_LABEL_LAYER_ID,
  UNDER_WATER_LAYER_IDS,
  underWaterBeforeId,
  WATER_STYLE_LAYER_ID,
  waterStackIsValid,
} from "./layer_stack.ts";
import {
  APPROXIMATE_BORDER_CASING_LAYER_IDS,
  APPROXIMATE_BORDER_LAYER_IDS,
  approximateBorderLayerId,
} from "./approximate_borders.ts";
import { PEAK_LAYER_ID } from "./peaks.ts";
import {
  buildBasemapStyle,
  COASTAL_FILL_LAYER_ID,
  COASTLINE_LAYER_ID,
  WATER_INLAND_LAYER_ID,
  WATER_LAYER_ID,
} from "./basemap.ts";
import { BASEMAP_PMTILES_URL } from "./config.ts";
import {
  BRITAIN_FIEF_LAYER_ID,
  CITY_HIT_LAYER_ID,
  CITY_LAYER_ID,
  CLIOPATRIA_FIEF_LAYER_ID,
  FRANCE_FIEF_LAYER_ID,
  HRE_LAYER_ID,
  ITALY_FIEF_LAYER_ID,
  layerOrderMatchesPickingPriority,
  MOUNTAIN_HIT_LAYER_ID,
  PEAK_HIT_LAYER_ID,
  PICKING_PRIORITY,
  POWER_LAYER_ID,
  RIVERS_HIT_LAYER_ID,
  RIVERS_LAYER_ID,
  SOVEREIGN_FIEF_LAYER_ID,
} from "./picking.ts";
import {
  HRE_BOUNDARY_LABEL_LAYER_ID,
  HRE_BOUNDARY_MARKER_LAYER_ID,
} from "./hre_major_polities.ts";

/** ベースマップ（Protomaps 羊皮紙スタイル）の実レイヤー id 列 */
const realStyleLayerIds = buildBasemapStyle(BASEMAP_PMTILES_URL).layers.map(
  (l) => l.id,
);

// --- TASK-77: 勢力・諸侯領ポリゴンを水面より下に差し込む ---
// ベースマップ（現代海岸線）と政治ポリゴン（粗い海岸線）の解像度差で塗りが
// 海へはみ出す。deck.gl の beforeId で水面ポリゴンより下に差し込み、はみ出しを
// 水面に覆わせて隠す。

Deno.test("WATER_STYLE_LAYER_ID はベースマップスタイルに実在する水面レイヤー id", () => {
  // ハードコードした id がスタイルから消えたらここで落ちる（TASK-77 AC #1）
  assertEquals(WATER_STYLE_LAYER_ID, WATER_LAYER_ID);
  assert(
    realStyleLayerIds.includes(WATER_STYLE_LAYER_ID),
    `水面レイヤー ${WATER_STYLE_LAYER_ID} が実スタイルに無い: ${
      realStyleLayerIds.join(", ")
    }`,
  );
});

Deno.test("水面より下へ回すのは政治ポリゴン 7 枚のみ（TASK-80 で base 境界線は deck から外れた、TASK-96 で伊諸侯領・TASK-110 で Cliopatria 領邦・#172 でブリテン諸島・#189 で主権政体を追加）", () => {
  // TASK-78 の base-outlines（deck の GeoJsonLayer）は TASK-80 で MapLibre の
  // line レイヤー（approximate-borders-*）へ移した。deck 側に線の層は無い。
  assertEquals(
    [...UNDER_WATER_LAYER_IDS].sort(),
    [
      BRITAIN_FIEF_LAYER_ID,
      CLIOPATRIA_FIEF_LAYER_ID,
      FRANCE_FIEF_LAYER_ID,
      HRE_LAYER_ID,
      ITALY_FIEF_LAYER_ID,
      POWER_LAYER_ID,
      SOVEREIGN_FIEF_LAYER_ID,
    ].sort(),
  );
});

Deno.test("主権政体の塗りも他の政治ポリゴンと同じ beforeId を得る（#189）", () => {
  // バルト海・黒海・アドリア海・エーゲ海の海岸線が base と同じく海へはみ出す
  // ため、水面の下へ回さないと海上に塗りが露出する（他の政治ポリゴンと同じ理由）
  const ids = [WATER_INLAND_LAYER_ID, WATER_LAYER_ID];
  const expected = underWaterBeforeId(POWER_LAYER_ID, ids);
  assertEquals(underWaterBeforeId(SOVEREIGN_FIEF_LAYER_ID, ids), expected);
  assertEquals(expected, WATER_LAYER_ID);
});

Deno.test("伊諸侯領の塗りも他の政治ポリゴンと同じ beforeId を得る（グループが分かれず相対順が保たれる。TASK-96）", () => {
  // 政治ポリゴンは全て同一 beforeId でなければならない（別グループへ分かれると
  // deck レイヤー配列順による相対順が崩れる）
  const ids = [WATER_INLAND_LAYER_ID, WATER_LAYER_ID];
  const expected = underWaterBeforeId(POWER_LAYER_ID, ids);
  assertEquals(underWaterBeforeId(ITALY_FIEF_LAYER_ID, ids), expected);
  assertEquals(expected, WATER_LAYER_ID);
});

Deno.test("Cliopatria 領邦の塗りも他の政治ポリゴンと同じ beforeId を得る（TASK-110 AC #4）", () => {
  const ids = [WATER_INLAND_LAYER_ID, WATER_LAYER_ID];
  const expected = underWaterBeforeId(POWER_LAYER_ID, ids);
  assertEquals(underWaterBeforeId(CLIOPATRIA_FIEF_LAYER_ID, ids), expected);
  assertEquals(expected, WATER_LAYER_ID);
});

Deno.test("ブリテン諸島の政体の塗りも他の政治ポリゴンと同じ beforeId を得る（#172）", () => {
  // アイリッシュ海・大西洋岸で base と同じく海へはみ出すため、水面の下へ
  // 回さないと海上に塗りが露出する（他の政治ポリゴンと同じ理由）
  const ids = [WATER_INLAND_LAYER_ID, WATER_LAYER_ID];
  const expected = underWaterBeforeId(POWER_LAYER_ID, ids);
  assertEquals(underWaterBeforeId(BRITAIN_FIEF_LAYER_ID, ids), expected);
  assertEquals(expected, WATER_LAYER_ID);
});

// --- TASK-80: 概略境界（MapLibre line レイヤー）の挿入位置 ---
// 境界線は「政治ポリゴンの塗りより上・海洋の水面より下」に入らなければならない。
// - 塗りより下だと半透明の塗り（powers.ts FILL_ALPHA）越しになり、低 alpha の
//   概略線が見えなくなる（従来 deck の stroke は塗りの上に描かれていた）
// - 海洋より上だと、政治ポリゴンが海へはみ出した区間の線が海の上に露出し、
//   「海の上を走る誤った境界線」になる（TASK-84 で解決した問題の再発）

Deno.test("概略境界レイヤーは海洋 water の直下に挿入する（TASK-80）", () => {
  assertEquals(
    approximateBorderBeforeId(realStyleLayerIds),
    WATER_STYLE_LAYER_ID,
  );
});

Deno.test("水面レイヤーが無いスタイルでは beforeId なしへフォールバックする（TASK-80）", () => {
  assertEquals(
    approximateBorderBeforeId(
      realStyleLayerIds.filter((id) => id !== WATER_STYLE_LAYER_ID),
    ),
    undefined,
  );
  assertEquals(approximateBorderBeforeId([]), undefined);
});

/** 政治ポリゴンの塗りが入る deck のレイヤーグループ ID（概略境界が有るとき） */
const DECK_FILL_GROUP = `${DECK_LAYER_GROUP_ID_PREFIX}before:${
  APPROXIMATE_BORDER_LAYER_IDS[0]
}`;
/** 概略境界が追加される前に作られた deck レイヤーのグループ（beforeId = water） */
const DECK_STALE_FILL_GROUP =
  `${DECK_LAYER_GROUP_ID_PREFIX}before:${WATER_LAYER_ID}`;
/** 最前面グループ（beforeId なし = 河川・都市など、またはフォールバックスタイル） */
const DECK_LAST_GROUP = `${DECK_LAYER_GROUP_ID_PREFIX}last`;

Deno.test("underWaterBeforeId は概略境界があればその最下段を指す（TASK-80）", () => {
  // 塗り → 概略境界 → 海洋 の順を作るのは deck 側の beforeId。3 枚が同じ値を
  // 返すことが必須（別グループへ分かれると相対順が壊れる）。
  const ids = [
    WATER_INLAND_LAYER_ID,
    ...APPROXIMATE_BORDER_LAYER_IDS,
    WATER_LAYER_ID,
  ];
  for (const id of UNDER_WATER_LAYER_IDS) {
    assertEquals(underWaterBeforeId(id, ids), APPROXIMATE_BORDER_LAYER_IDS[0]);
  }
  // 概略境界がまだ無ければ従来どおり水面の直下
  assertEquals(
    underWaterBeforeId(POWER_LAYER_ID, [WATER_LAYER_ID]),
    WATER_LAYER_ID,
  );
});

Deno.test("politicalFillGroupId は実在する deck のレイヤーグループ ID を返す（TASK-80）", () => {
  // deck.gl は interleaved レイヤーを 1 枚ずつではなく beforeId ごとの
  // グループ（custom レイヤー）としてスタイルへ入れる。塗りとの前後関係は
  // "powers" ではなくこのグループ ID で判定しなければならない。
  assertEquals(
    politicalFillGroupId([
      ...APPROXIMATE_BORDER_LAYER_IDS,
      DECK_FILL_GROUP,
      WATER_LAYER_ID,
      DECK_LAST_GROUP,
    ]),
    DECK_FILL_GROUP,
  );
  // beforeId が古い（water を指したまま）グループも塗りのグループとして拾う。
  // 「今あるべき ID」を組み立てて探すと、まさに直したい状態を見落とす。
  assertEquals(
    politicalFillGroupId([
      DECK_STALE_FILL_GROUP,
      ...APPROXIMATE_BORDER_LAYER_IDS,
      WATER_LAYER_ID,
    ]),
    DECK_STALE_FILL_GROUP,
  );
  // beforeId 付きグループが無い（water を持たないフォールバックスタイル）
  assertEquals(politicalFillGroupId([DECK_LAST_GROUP]), DECK_LAST_GROUP);
  // グループがまだ無い（deck 未登録）
  assertEquals(politicalFillGroupId([WATER_LAYER_ID]), undefined);
  assertEquals(politicalFillGroupId([]), undefined);
});

Deno.test("politicalFillGroupId は外枠のグループ（before:water）ではなく塗りのグループを返す（#330）", () => {
  // #330 で勢力圏の外枠が beforeId = water を持つようになり、beforeId 付きの
  // グループが 2 つ並ぶ。塗りのグループは概略境界の直下 = 常により下にあるため、
  // 最初に見つかるものが塗りのグループになる（approximateBorderStackIsValid が
  // 「概略境界は塗りより上」を検査する対象を取り違えない）
  const withExtentGroup = [
    WATER_INLAND_LAYER_ID,
    DECK_FILL_GROUP,
    ...APPROXIMATE_BORDER_LAYER_IDS,
    DECK_STALE_FILL_GROUP, // = 外枠のグループ（before:water）
    WATER_LAYER_ID,
    COASTLINE_LAYER_ID,
    DECK_LAST_GROUP,
  ];
  assertEquals(politicalFillGroupId(withExtentGroup), DECK_FILL_GROUP);
  assert(approximateBorderStackIsValid(withExtentGroup));
});

Deno.test("approximateBorderStackIsValid は 塗り → 概略境界 → 海洋 の順を要求する（TASK-80）", () => {
  // 実測した実際のレイヤー順（ヘッドレス確認）に概略境界を入れた形
  const valid = [
    "background",
    "earth",
    "landcover",
    "hillshade",
    WATER_INLAND_LAYER_ID,
    DECK_FILL_GROUP,
    ...APPROXIMATE_BORDER_LAYER_IDS,
    WATER_LAYER_ID,
    COASTLINE_LAYER_ID,
    DECK_LAST_GROUP,
  ];
  assert(approximateBorderStackIsValid(valid));
  // 概略境界が海洋より上 = 海上のはみ出した線が露出する（TASK-84 の退行）
  assert(
    !approximateBorderStackIsValid([
      DECK_FILL_GROUP,
      WATER_LAYER_ID,
      ...APPROXIMATE_BORDER_LAYER_IDS,
      COASTLINE_LAYER_ID,
    ]),
  );
  // 概略境界が塗りのグループより下 = 半透明の塗り越しになって線が沈む。
  // deck レイヤーの beforeId が古い（water を指したまま）と必ずこうなり、
  // main.ts が renderLayers() で deck レイヤーを作り直して修復する。
  assert(
    !approximateBorderStackIsValid([
      WATER_INLAND_LAYER_ID,
      ...APPROXIMATE_BORDER_LAYER_IDS,
      DECK_STALE_FILL_GROUP,
      WATER_LAYER_ID,
    ]),
  );
  // 1 枚でも順序を外していれば不正（3 段のうち 1 枚だけ取り残されたケース）
  assert(
    !approximateBorderStackIsValid([
      DECK_FILL_GROUP,
      approximateBorderLayerId("normal"),
      approximateBorderLayerId("long"),
      WATER_LAYER_ID,
      approximateBorderLayerId("very-long"),
    ]),
  );
});

// --- #228 / #309: 上位勢力外周の casing（approximate-borders-casing-<tier>）の
// 挿入位置 ---
// casing はインク線（tier 群）の下に敷く下地なので、tier 群より上に来ると
// クリーム色の帯が境界線を洗い流してしまう。#309 で casing は uncertainty tier
// ごとの 2 枚（normal / long。very-long には敷かない）になった。

Deno.test("APPROXIMATE_BORDER_LAYER_IDS の最下段は casing 群（deck の塗りは casing の直下へ入る）（#228/#309）", () => {
  assertEquals(
    APPROXIMATE_BORDER_LAYER_IDS.slice(
      0,
      APPROXIMATE_BORDER_CASING_LAYER_IDS.length,
    ),
    [...APPROXIMATE_BORDER_CASING_LAYER_IDS],
  );
  // underWaterBeforeId は最下段 = casing を指す（塗り → casing → tier 群 → 海洋）
  const ids = [
    WATER_INLAND_LAYER_ID,
    ...APPROXIMATE_BORDER_LAYER_IDS,
    WATER_LAYER_ID,
  ];
  for (const id of UNDER_WATER_LAYER_IDS) {
    assertEquals(
      underWaterBeforeId(id, ids),
      APPROXIMATE_BORDER_CASING_LAYER_IDS[0],
    );
  }
});

Deno.test("approximateBorderStackIsValid は casing 群 → tier 群 の順を要求する（#228/#309）", () => {
  // 正順: 塗り → casing(normal, long) → normal → long → very-long → 海洋
  assert(
    approximateBorderStackIsValid([
      DECK_FILL_GROUP,
      ...APPROXIMATE_BORDER_LAYER_IDS,
      WATER_LAYER_ID,
    ]),
  );
  // casing が tier 群の上 = クリーム帯が境界線を覆う
  assert(
    !approximateBorderStackIsValid([
      DECK_FILL_GROUP,
      approximateBorderLayerId("normal"),
      approximateBorderLayerId("long"),
      approximateBorderLayerId("very-long"),
      ...APPROXIMATE_BORDER_CASING_LAYER_IDS,
      WATER_LAYER_ID,
    ]),
  );
  // casing が 1 段だけ食い込んでいても不正
  assert(
    !approximateBorderStackIsValid([
      DECK_FILL_GROUP,
      APPROXIMATE_BORDER_CASING_LAYER_IDS[0],
      approximateBorderLayerId("normal"),
      APPROXIMATE_BORDER_CASING_LAYER_IDS[1],
      approximateBorderLayerId("long"),
      approximateBorderLayerId("very-long"),
      WATER_LAYER_ID,
    ]),
  );
  // casing がまだ無い（旧スタイル・追加途中）なら tier 群だけで判定し拒否しない
  assert(
    approximateBorderStackIsValid([
      DECK_FILL_GROUP,
      approximateBorderLayerId("normal"),
      approximateBorderLayerId("long"),
      approximateBorderLayerId("very-long"),
      WATER_LAYER_ID,
    ]),
  );
});

Deno.test("approximateBorderStackIsValid はレイヤー未追加・フォールバックスタイルを拒否しない（TASK-80）", () => {
  // スタイル未読込・差し替え直後（概略境界レイヤーがまだ無い）
  assert(approximateBorderStackIsValid([]));
  assert(approximateBorderStackIsValid([DECK_FILL_GROUP, WATER_LAYER_ID]));
  // deck 未登録（グループが無い）なら水面との前後だけを見る
  assert(
    approximateBorderStackIsValid([
      ...APPROXIMATE_BORDER_LAYER_IDS,
      WATER_LAYER_ID,
    ]),
  );
  // water を持たないフォールバックスタイルでも「塗りより上」だけは要求する
  // （main.ts は renderLayers() で deck レイヤーを作り直して修復する）
  assert(
    approximateBorderStackIsValid([
      DECK_LAST_GROUP,
      ...APPROXIMATE_BORDER_LAYER_IDS,
    ]),
  );
  assert(
    !approximateBorderStackIsValid([
      ...APPROXIMATE_BORDER_LAYER_IDS,
      DECK_LAST_GROUP,
    ]),
  );
});

Deno.test("概略境界レイヤーは deck 側の picking / 分配に一切関与しない（AC #6）", () => {
  for (const id of APPROXIMATE_BORDER_LAYER_IDS) {
    assert(!PICKING_PRIORITY.includes(id));
    assert(!UNDER_WATER_LAYER_IDS.includes(id));
    assert(!OVERLAID_LAYER_IDS.includes(id));
  }
  // deck のレイヤー列（概略境界は含まない）は従来どおり picking 順と整合する
  assert(
    layerOrderMatchesPickingPriority([
      POWER_LAYER_ID,
      FRANCE_FIEF_LAYER_ID,
      HRE_LAYER_ID,
      RIVERS_HIT_LAYER_ID,
      CITY_LAYER_ID,
      RIVERS_LAYER_ID,
    ]),
  );
  assert(
    overlaySplitIsValid(
      [POWER_LAYER_ID, FRANCE_FIEF_LAYER_ID],
      [...OVERLAID_LAYER_IDS],
    ),
  );
});

Deno.test("実スタイル（buildBasemapStyle）は概略境界レイヤーを含まない（実行時に追加する）", () => {
  // ベースマップスタイルに焼き込むと deck の挿入位置（beforeId = water）より
  // 下に来てしまう。main.ts が deck の登録後に addLayer / moveLayer で
  // 水面の直下へ入れるため、スタイル定義側には存在しない。
  for (const id of APPROXIMATE_BORDER_LAYER_IDS) {
    assert(!realStyleLayerIds.includes(id));
  }
});

Deno.test("3 ポリゴンレイヤーには水面レイヤー id が beforeId として付与される", () => {
  for (const id of [POWER_LAYER_ID, FRANCE_FIEF_LAYER_ID, HRE_LAYER_ID]) {
    assertEquals(
      underWaterBeforeId(id, realStyleLayerIds),
      WATER_STYLE_LAYER_ID,
      `${id} は水面より下に描画されるはず`,
    );
  }
});

Deno.test("河川・河川ヒット層・都市・都市ヒット層・ラベル系レイヤーには beforeId を付与しない（水面より上を維持, AC #2）", () => {
  const aboveWater = [
    RIVERS_LAYER_ID,
    RIVERS_HIT_LAYER_ID,
    CITY_LAYER_ID,
    CITY_HIT_LAYER_ID,
    ...OVERLAID_LAYER_IDS,
  ];
  for (const id of aboveWater) {
    assertEquals(
      underWaterBeforeId(id, realStyleLayerIds),
      undefined,
      `${id} は従来どおり水面より上に描画されるはず`,
    );
  }
});

// --- #330: 勢力圏の外枠（hre-extent）を海洋より下へ回す（原因 1）---
// 政治ポリゴンは海洋 water より下でマスクされるのに、外枠だけが水面より上に
// 残っていたため、歴史ポリゴンが現代海岸線より海側へ出る区間で臙脂の線だけが
// 海上に浮いていた。外枠も海洋の直下へ入れて同じマスクに掛ける。

Deno.test("勢力圏の外枠は海洋 water の直下へ差し込む（#330 原因 1）", () => {
  assertEquals(
    suzerainExtentBeforeId(realStyleLayerIds),
    WATER_STYLE_LAYER_ID,
    "外枠が海洋より上に残ると、海へはみ出した区間の臙脂線が海上に浮く",
  );
});

Deno.test("勢力圏の外枠の beforeId は政治ポリゴンの塗りより上（概略境界に洗い流されない）（#330）", () => {
  // 塗り 7 枚は概略境界の最下段（casing）を指すため、概略境界 → 外枠 → 海洋の
  // 順になる。外枠まで概略境界の下へ入れると、クリーム色の casing が臙脂の
  // 3px 線を上から覆ってしまう
  // 概略境界は起動後に追加される（buildBasemapStyle には含まれない）
  const ids = [
    WATER_INLAND_LAYER_ID,
    ...APPROXIMATE_BORDER_LAYER_IDS,
    WATER_LAYER_ID,
    COASTLINE_LAYER_ID,
  ];
  const fillBeforeId = underWaterBeforeId(POWER_LAYER_ID, ids);
  const extentBeforeId = suzerainExtentBeforeId(ids);
  assertEquals(fillBeforeId, APPROXIMATE_BORDER_LAYER_IDS[0]);
  assertEquals(extentBeforeId, WATER_LAYER_ID);
  assert(
    ids.indexOf(extentBeforeId as string) >
      ids.indexOf(fillBeforeId as string),
  );
  // 外枠は UNDER_WATER_LAYER_IDS（塗りのグループ）には含めない
  assert(!UNDER_WATER_LAYER_IDS.includes("hre-extent"));
  assertEquals(underWaterBeforeId("hre-extent", realStyleLayerIds), undefined);
});

Deno.test("勢力圏の外枠は water を持たないスタイルでは beforeId なしへ縮退する（#330 AC6）", () => {
  const withoutWater = realStyleLayerIds.filter(
    (id) => id !== WATER_STYLE_LAYER_ID,
  );
  assertEquals(suzerainExtentBeforeId(withoutWater), undefined);
  assertEquals(suzerainExtentBeforeId([]), undefined);
});

Deno.test("水面レイヤー id がスタイルに無い場合は beforeId なしへフォールバックし例外を投げない（AC #4）", () => {
  // フォールバックスタイル（OpenFreeMap 等）に water が無いケースを模す
  const withoutWater = realStyleLayerIds.filter(
    (id) => id !== WATER_STYLE_LAYER_ID,
  );
  for (const id of UNDER_WATER_LAYER_IDS) {
    assertEquals(underWaterBeforeId(id, withoutWater), undefined);
  }
  // スタイル未読込（レイヤー列が空）でも同様に例外を投げない
  for (const id of UNDER_WATER_LAYER_IDS) {
    assertEquals(underWaterBeforeId(id, []), undefined);
  }
});

// --- TASK-77: ラベル層を overlaid オーバーレイへ分ける ---
// beforeId で interleaved のレイヤーグループが 2 つに分かれると、先に描画される
// グループ（水面より下）の描画パスが CollisionFilterExtension の衝突マップを
// 「そのグループだけ」に絞って描き直してしまい、ラベル（TextLayer）が全滅する。
// ラベル 3 層は picking に関与しない（pickable: false）ため、別の overlaid
// オーバーレイ（deck 専用 canvas）へ移して衝突判定を interleaved のグループ
// 分割から切り離す。

Deno.test("overlaid 側にラベル 8 層と z4 callout 線を載せる", () => {
  assertEquals(OVERLAID_LAYER_IDS, [
    MARINE_LABEL_LAYER_ID,
    MOUNTAIN_LABEL_LAYER_ID,
    PEAK_LABEL_LAYER_ID,
    OVERVIEW_LABEL_CALLOUT_LAYER_ID,
    HRE_BOUNDARY_LABEL_LAYER_ID,
    LABEL_LAYER_ID,
    TOP_LABEL_LAYER_ID,
    RIVER_LABEL_LAYER_ID,
    CITY_LABEL_LAYER_ID,
  ]);
  // #333: 政治ラベルは階層別に 2 枚（constituent/sub と top）。どちらも
  // ラベル層なので overlaid 側・interleaved には残さない（衝突空間の共有）。
  assert(!UNDER_WATER_LAYER_IDS.includes(TOP_LABEL_LAYER_ID));
  assertEquals(
    underWaterBeforeId(TOP_LABEL_LAYER_ID, realStyleLayerIds),
    undefined,
  );
});

Deno.test("山峰マーカーは interleaved 側・山峰名ラベルは overlaid 側（TASK-99）", () => {
  // マーカー（記号）は地図に interleave する。TASK-100 でホバー/クリック対象に
  // したため PICKING_PRIORITY に含まれる（可視記号なので都市ドットと同じ扱い）が、
  // 水面より下へは回さない（都市マーカーと同じ扱い）
  assert(!OVERLAID_LAYER_IDS.includes(PEAK_LAYER_ID));
  assert(PICKING_PRIORITY.includes(PEAK_LAYER_ID));
  assert(!UNDER_WATER_LAYER_IDS.includes(PEAK_LAYER_ID));
  assertEquals(underWaterBeforeId(PEAK_LAYER_ID, realStyleLayerIds), undefined);
  // ラベルは勢力名・都市名と同一の衝突空間（overlaid の 1 オーバーレイ）へ
  assert(!PICKING_PRIORITY.includes(PEAK_LABEL_LAYER_ID));
  assertEquals(
    underWaterBeforeId(PEAK_LABEL_LAYER_ID, realStyleLayerIds),
    undefined,
  );
});

Deno.test("山脈名ラベルは picking に関与せず、水面より上に描かれる（TASK-97）", () => {
  assert(!PICKING_PRIORITY.includes(MOUNTAIN_LABEL_LAYER_ID));
  assert(!UNDER_WATER_LAYER_IDS.includes(MOUNTAIN_LABEL_LAYER_ID));
  assertEquals(
    underWaterBeforeId(MOUNTAIN_LABEL_LAYER_ID, realStyleLayerIds),
    undefined,
  );
});

Deno.test("overlaid 側のレイヤーは picking 優先順に含まれない（picking は interleaved 側のみ, AC #3）", () => {
  for (const id of OVERLAID_LAYER_IDS) {
    assert(
      !PICKING_PRIORITY.includes(id),
      `${id} が PICKING_PRIORITY に含まれると picking 優先順が変わる`,
    );
  }
});

Deno.test("overlaySplitIsValid は正しい分配を受理する", () => {
  assert(overlaySplitIsValid(
    [
      POWER_LAYER_ID,
      FRANCE_FIEF_LAYER_ID,
      HRE_LAYER_ID,
      "hre-extent",
      RIVERS_HIT_LAYER_ID,
      CITY_HIT_LAYER_ID,
      CITY_LAYER_ID,
      RIVERS_LAYER_ID,
    ],
    [...OVERLAID_LAYER_IDS],
  ));
});

// --- TASK-82: 都市の透明判定層（cities-hit）の分配 ---

Deno.test("cities-hit は水面より下へ回さない（判定専用だが cities と同じ水面上グループ）（TASK-82）", () => {
  assert(!UNDER_WATER_LAYER_IDS.includes(CITY_HIT_LAYER_ID));
  assertEquals(
    underWaterBeforeId(CITY_HIT_LAYER_ID, realStyleLayerIds),
    undefined,
  );
});

Deno.test("cities-hit は overlaid 側に載せない（picking は interleaved 側のみ）（TASK-82）", () => {
  assert(!OVERLAID_LAYER_IDS.includes(CITY_HIT_LAYER_ID));
  assert(PICKING_PRIORITY.includes(CITY_HIT_LAYER_ID));
});

Deno.test("overlaySplitIsValid はラベル層が interleaved 側に混ざった分配を拒否する", () => {
  assert(
    !overlaySplitIsValid(
      [POWER_LAYER_ID, RIVERS_LAYER_ID, LABEL_LAYER_ID],
      [MOUNTAIN_LABEL_LAYER_ID, RIVER_LABEL_LAYER_ID, CITY_LABEL_LAYER_ID],
    ),
  );
});

Deno.test("overlaySplitIsValid はラベル層の欠落・余分なレイヤーを拒否する", () => {
  // ラベル層が足りない
  assert(
    !overlaySplitIsValid(
      [POWER_LAYER_ID, RIVERS_LAYER_ID],
      [MOUNTAIN_LABEL_LAYER_ID, LABEL_LAYER_ID, RIVER_LABEL_LAYER_ID],
    ),
  );
  // overlaid 側に picking 対象（河川）が混ざる = picking が壊れる
  assert(
    !overlaySplitIsValid(
      [POWER_LAYER_ID],
      [...OVERLAID_LAYER_IDS, RIVERS_LAYER_ID],
    ),
  );
});

Deno.test("beforeId の付与は picking 優先順（PICKING_PRIORITY）に影響しない（AC #3）", () => {
  // beforeId は MapLibre 側の描画位置だけを決める。picking は deck.gl の
  // レイヤー配列順で決まるため、優先順のリスト自体は従来と同一であること
  // （順序を変える変更が入ったらここで気付ける）。
  assertEquals(PICKING_PRIORITY, [
    RIVERS_LAYER_ID,
    CITY_LAYER_ID,
    PEAK_LAYER_ID,
    CITY_HIT_LAYER_ID,
    PEAK_HIT_LAYER_ID,
    MOUNTAIN_HIT_LAYER_ID,
    RIVERS_HIT_LAYER_ID,
    HRE_BOUNDARY_MARKER_LAYER_ID,
    // #191: 主権政体は微小国家を含むため政治ポリゴンの最上段へ引き上げた
    SOVEREIGN_FIEF_LAYER_ID,
    HRE_LAYER_ID,
    FRANCE_FIEF_LAYER_ID,
    ITALY_FIEF_LAYER_ID,
    CLIOPATRIA_FIEF_LAYER_ID,
    BRITAIN_FIEF_LAYER_ID,
    POWER_LAYER_ID,
  ]);
});

// --- TASK-84: 水面分割後の重ね順の不変条件 ---
// 政治ポリゴンは「内水面より上・海洋より下・海岸線より下」に入らなければならない。
// beforeId は海洋側（water）を指し続ける（water-inland を指すと海上のはみ出しが
// 露出する = TASK-77 の退行、coastline を指すと内水面が塗りを抜く = TASK-84 の退行）。

Deno.test("underWaterBeforeId は海洋側の water を返す（water-inland は指さない）", () => {
  const ids = [
    "background",
    "earth",
    WATER_INLAND_LAYER_ID,
    WATER_LAYER_ID,
    COASTLINE_LAYER_ID,
  ];
  for (const layerId of UNDER_WATER_LAYER_IDS) {
    assertEquals(underWaterBeforeId(layerId, ids), WATER_LAYER_ID);
  }
  assertEquals(WATER_STYLE_LAYER_ID, WATER_LAYER_ID);
});

Deno.test("waterStackIsValid は 内水面 → 海洋 → 海岸線 の順を要求する", () => {
  assert(
    waterStackIsValid([
      "earth",
      WATER_INLAND_LAYER_ID,
      WATER_LAYER_ID,
      COASTLINE_LAYER_ID,
    ]),
  );
  // 内水面が海洋より上 = 内水面が政治ポリゴンの塗りを抜く
  assert(
    !waterStackIsValid([
      WATER_LAYER_ID,
      WATER_INLAND_LAYER_ID,
      COASTLINE_LAYER_ID,
    ]),
  );
  // 海岸線が海洋より下 = 海岸線が海に覆われて消える
  assert(
    !waterStackIsValid([
      WATER_INLAND_LAYER_ID,
      COASTLINE_LAYER_ID,
      WATER_LAYER_ID,
    ]),
  );
});

Deno.test("waterStackIsValid は沿岸補完が内水面・海洋より下であることを要求する（#305）", () => {
  // 正しい順: 沿岸補完 → 内水面 → 海洋 → 海岸線
  assert(
    waterStackIsValid([
      "earth",
      COASTAL_FILL_LAYER_ID,
      WATER_INLAND_LAYER_ID,
      WATER_LAYER_ID,
      COASTLINE_LAYER_ID,
    ]),
  );
  // 沿岸補完が内水面より上 = 帯が湖・内水面を塗ってしまう（AC4）
  assert(
    !waterStackIsValid([
      WATER_INLAND_LAYER_ID,
      COASTAL_FILL_LAYER_ID,
      WATER_LAYER_ID,
      COASTLINE_LAYER_ID,
    ]),
  );
  // 沿岸補完が海洋より上 = 帯が海上に浮く（AC3 の退行）
  assert(
    !waterStackIsValid([
      WATER_INLAND_LAYER_ID,
      WATER_LAYER_ID,
      COASTAL_FILL_LAYER_ID,
      COASTLINE_LAYER_ID,
    ]),
  );
  // 沿岸補完が無いスタイル（従来・フォールバック）は従来どおり
  assert(
    waterStackIsValid([
      WATER_INLAND_LAYER_ID,
      WATER_LAYER_ID,
      COASTLINE_LAYER_ID,
    ]),
  );
});

Deno.test("waterStackIsValid は該当レイヤーを持たないスタイル（フォールバック）を拒否しない", () => {
  // OpenFreeMap 等のフォールバックスタイルには water-inland / coastline が無い。
  // その場合 beforeId 自体が付かない（従来描画順）ので、不整合とはしない。
  assert(waterStackIsValid([]));
  assert(waterStackIsValid(["background", "water", "roads"]));
  assert(waterStackIsValid(["background", "landuse"]));
});

Deno.test("実スタイル（buildBasemapStyle）は waterStackIsValid を満たす", () => {
  const ids = buildBasemapStyle(BASEMAP_PMTILES_URL).layers.map((l) => l.id);
  assert(waterStackIsValid(ids));
});
