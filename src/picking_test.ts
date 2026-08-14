import { assert, assertEquals } from "@std/assert";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type {
  Feature,
  FeatureCollection,
  MultiPolygon,
  Polygon,
} from "geojson";
import { labelAnchorFor } from "./labels.ts";
import {
  BRITAIN_FIEF_LAYER_ID,
  CITY_HIT_LAYER_ID,
  CITY_LAYER_ID,
  CLIOPATRIA_FIEF_LAYER_ID,
  FIEF_PICK_LAYER_IDS,
  FRANCE_FIEF_LAYER_ID,
  HRE_LAYER_ID,
  isCityPickLayerId,
  isDirectPickFinal,
  isMountainPickLayerId,
  isNearCursorRepickable,
  isPeakPickLayerId,
  isRiversPickLayerId,
  ITALY_FIEF_LAYER_ID,
  layerOrderMatchesPickingPriority,
  MOUNTAIN_HIT_LAYER_ID,
  PEAK_HIT_LAYER_ID,
  PEAK_LAYER_ID,
  PICKING_PRIORITY,
  POLITICAL_PICK_LAYER_IDS,
  POWER_LAYER_ID,
  renderOrderFromPickingPriority,
  resolveClickPick,
  RIVERS_HIT_LAYER_ID,
  RIVERS_LAYER_ID,
  selectPreferredPick,
  SOVEREIGN_FIEF_LAYER_ID,
} from "./picking.ts";

// ---- PICKING_PRIORITY ----

Deno.test("PICKING_PRIORITY: 可視記号（河川 > 都市 > 山峰）> 透明判定層（都市 > 山峰 > 山脈 > 河川）> 領邦 6 系統 > 勢力 の順で並ぶ（TASK-49, TASK-71, TASK-82, TASK-96, TASK-100, TASK-110, #172, #189）", () => {
  assertEquals(
    [...PICKING_PRIORITY],
    [
      RIVERS_LAYER_ID,
      CITY_LAYER_ID,
      PEAK_LAYER_ID,
      CITY_HIT_LAYER_ID,
      PEAK_HIT_LAYER_ID,
      MOUNTAIN_HIT_LAYER_ID,
      RIVERS_HIT_LAYER_ID,
      SOVEREIGN_FIEF_LAYER_ID,
      HRE_LAYER_ID,
      FRANCE_FIEF_LAYER_ID,
      ITALY_FIEF_LAYER_ID,
      CLIOPATRIA_FIEF_LAYER_ID,
      BRITAIN_FIEF_LAYER_ID,
      POWER_LAYER_ID,
    ],
  );
});

Deno.test("PICKING_PRIORITY: sovereign-fiefs は政治ポリゴン 7 層の最上段（微小国家が近傍再ピックで隣の大きい区画に負けない）（#191）", () => {
  // #189/#190 では最下段（powers の直上）に置いていたが、#191 で微小国家
  // （サンマリノ 7〜61 km² など）を収録したため引き上げた。クリックの解決は
  // 半径 PICKING_RADIUS_PX の近傍再ピック → PICKING_PRIORITY で 1 件選ぶ
  // 経路（resolveClickPick）なので、最下段のままだとカーソルが微小国家の
  // 内側にあっても 6px 先の隣接オーバーレイが勝つ（実測: zoom 7 の
  // 1300 / 1500 年でサンマリノがリミニ領主領に負けた）。
  const sovereignIndex = PICKING_PRIORITY.indexOf(SOVEREIGN_FIEF_LAYER_ID);
  assert(sovereignIndex !== -1);
  for (
    const existing of [
      HRE_LAYER_ID,
      FRANCE_FIEF_LAYER_ID,
      ITALY_FIEF_LAYER_ID,
      CLIOPATRIA_FIEF_LAYER_ID,
      BRITAIN_FIEF_LAYER_ID,
      POWER_LAYER_ID,
    ]
  ) {
    assert(
      sovereignIndex < PICKING_PRIORITY.indexOf(existing),
      `sovereign-fiefs は ${existing} より優先されなければならない`,
    );
  }
});

Deno.test("PICKING_PRIORITY: britain-fiefs は powers より優先される（オーバーレイがベースの上）（#172）", () => {
  const britainIndex = PICKING_PRIORITY.indexOf(BRITAIN_FIEF_LAYER_ID);
  const powerIndex = PICKING_PRIORITY.indexOf(POWER_LAYER_ID);
  assert(britainIndex !== -1);
  assert(britainIndex < powerIndex);
});

Deno.test("PICKING_PRIORITY: britain-fiefs は既存の領邦 4 系統に劣後する（既存の相対順を動かさない）（#172）", () => {
  // ブリテン諸島は他のオーバーレイと地理的に重ならないため相対順は表示に
  // 影響しないが、後から追加した層を最下段（powers の直上）へ置く既定
  // （TASK-96 / TASK-110 と同じ判断）を保つ。#191 で sovereign-fiefs だけは
  // 微小国家を含むため最上段へ引き上げたが、ブリテンとの相対順は変わらない
  const britainIndex = PICKING_PRIORITY.indexOf(BRITAIN_FIEF_LAYER_ID);
  for (
    const existing of [
      HRE_LAYER_ID,
      FRANCE_FIEF_LAYER_ID,
      ITALY_FIEF_LAYER_ID,
      CLIOPATRIA_FIEF_LAYER_ID,
    ]
  ) {
    assert(
      PICKING_PRIORITY.indexOf(existing) < britainIndex,
      `${existing} は britain-fiefs より優先されなければならない`,
    );
  }
});

// ---- 山岳（TASK-100）----

Deno.test("PICKING_PRIORITY: 山岳 3 層はすべて政治ポリゴン 7 層より上（勢力の上に載る）（TASK-100 AC #1/#2、TASK-110 で Cliopatria・#172 でブリテン・#189 で主権政体を追加）", () => {
  const political = [
    HRE_LAYER_ID,
    FRANCE_FIEF_LAYER_ID,
    ITALY_FIEF_LAYER_ID,
    CLIOPATRIA_FIEF_LAYER_ID,
    BRITAIN_FIEF_LAYER_ID,
    SOVEREIGN_FIEF_LAYER_ID,
    POWER_LAYER_ID,
  ];
  for (
    const terrain of [PEAK_LAYER_ID, PEAK_HIT_LAYER_ID, MOUNTAIN_HIT_LAYER_ID]
  ) {
    const index = PICKING_PRIORITY.indexOf(terrain);
    assert(index !== -1, `${terrain} が PICKING_PRIORITY に無い`);
    for (const id of political) {
      assert(
        index < PICKING_PRIORITY.indexOf(id),
        `${terrain} が ${id} より下にあると picking されない`,
      );
    }
  }
});

Deno.test("PICKING_PRIORITY: 山脈の判定層は面ではなくアンカー円なので、勢力より上でも既存 3 主題（河川・都市・山峰）には劣後する（TASK-100 AC #3）", () => {
  const mountain = PICKING_PRIORITY.indexOf(MOUNTAIN_HIT_LAYER_ID);
  assert(PICKING_PRIORITY.indexOf(RIVERS_LAYER_ID) < mountain);
  assert(PICKING_PRIORITY.indexOf(CITY_LAYER_ID) < mountain);
  assert(PICKING_PRIORITY.indexOf(CITY_HIT_LAYER_ID) < mountain);
  assert(PICKING_PRIORITY.indexOf(PEAK_LAYER_ID) < mountain);
  assert(PICKING_PRIORITY.indexOf(PEAK_HIT_LAYER_ID) < mountain);
});

Deno.test("PICKING_PRIORITY: 可視記号（山峰 ▲）は透明判定層（都市・山峰・山脈・河川）より優先される（TASK-100 AC #3）", () => {
  const peak = PICKING_PRIORITY.indexOf(PEAK_LAYER_ID);
  for (
    const hit of [
      CITY_HIT_LAYER_ID,
      PEAK_HIT_LAYER_ID,
      MOUNTAIN_HIT_LAYER_ID,
      RIVERS_HIT_LAYER_ID,
    ]
  ) {
    assert(peak < PICKING_PRIORITY.indexOf(hit), `${hit} より上であること`);
  }
});

Deno.test("PICKING_PRIORITY: 山峰・山脈の判定層は rivers-hit（透明帯）より優先される（河川の判定帯に構造的に遮蔽されない）（TASK-100 AC #3）", () => {
  const riversHit = PICKING_PRIORITY.indexOf(RIVERS_HIT_LAYER_ID);
  assert(PICKING_PRIORITY.indexOf(PEAK_HIT_LAYER_ID) < riversHit);
  assert(PICKING_PRIORITY.indexOf(MOUNTAIN_HIT_LAYER_ID) < riversHit);
});

Deno.test("PICKING_PRIORITY: 山岳の追加で既存 4 主題の相対順（河川 > 都市 > 都市ヒット > 河川ヒット > 領邦 > 勢力）は変わらない（TASK-100 AC #3）", () => {
  const existing = [
    RIVERS_LAYER_ID,
    CITY_LAYER_ID,
    CITY_HIT_LAYER_ID,
    RIVERS_HIT_LAYER_ID,
    HRE_LAYER_ID,
    FRANCE_FIEF_LAYER_ID,
    ITALY_FIEF_LAYER_ID,
    POWER_LAYER_ID,
  ];
  const actual = PICKING_PRIORITY.filter((id) => existing.includes(id));
  assertEquals([...actual], existing);
});

Deno.test("isMountainPickLayerId / isPeakPickLayerId: それぞれの層だけで true（TASK-100）", () => {
  assert(isMountainPickLayerId(MOUNTAIN_HIT_LAYER_ID));
  assert(!isMountainPickLayerId(PEAK_LAYER_ID));
  assert(!isMountainPickLayerId(POWER_LAYER_ID));
  assert(!isMountainPickLayerId(undefined));
  assert(isPeakPickLayerId(PEAK_LAYER_ID));
  assert(isPeakPickLayerId(PEAK_HIT_LAYER_ID));
  assert(!isPeakPickLayerId(MOUNTAIN_HIT_LAYER_ID));
  assert(!isPeakPickLayerId(CITY_LAYER_ID));
  assert(!isPeakPickLayerId(undefined));
});

Deno.test("isNearCursorRepickable: 透明判定層 3 種（都市・山峰・山脈）はクリックの近傍再ピック対象外（ホバーと実効範囲を一致させる）（TASK-100 AC #3）", () => {
  assert(!isNearCursorRepickable(PEAK_HIT_LAYER_ID));
  assert(!isNearCursorRepickable(MOUNTAIN_HIT_LAYER_ID));
  assert(isNearCursorRepickable(PEAK_LAYER_ID));
});

Deno.test("isDirectPickFinal: 山峰・山脈の直下ヒットは近傍河川の再ピックに奪われない（TASK-100 AC #1/#2）", () => {
  assert(isDirectPickFinal(PEAK_LAYER_ID));
  assert(isDirectPickFinal(PEAK_HIT_LAYER_ID));
  assert(isDirectPickFinal(MOUNTAIN_HIT_LAYER_ID));
});

Deno.test("resolveClickPick: 山峰は勢力より優先、河川ライン・都市ドットには劣後する（TASK-100 AC #3）", () => {
  const power = pickInfo(POWER_LAYER_ID, "神聖ローマ帝国");
  const peak = pickInfo(PEAK_LAYER_ID, "モンブラン");
  const city = pickInfo(CITY_LAYER_ID, "ジュネーヴ");
  const river = pickInfo(RIVERS_LAYER_ID, "ローヌ川");
  assertEquals(resolveClickPick([power, peak]), peak);
  assertEquals(resolveClickPick([peak, city]), city);
  assertEquals(resolveClickPick([peak, river]), river);
});

Deno.test("resolveClickPick: 山脈の判定円は近傍再ピック候補から除外される（クリックだけ範囲が広がらない）（TASK-100 AC #3）", () => {
  const power = pickInfo(POWER_LAYER_ID, "スイス盟約者団");
  const mountain = pickInfo(MOUNTAIN_HIT_LAYER_ID, "アルプス山脈");
  assertEquals(resolveClickPick([power, mountain]), power);
  assertEquals(resolveClickPick([mountain]), null);
});

Deno.test("layerOrderMatchesPickingPriority: 山岳 3 層を含む実際の描画順が整合する（TASK-100 AC #6）", () => {
  assert(
    layerOrderMatchesPickingPriority([
      POWER_LAYER_ID,
      ITALY_FIEF_LAYER_ID,
      FRANCE_FIEF_LAYER_ID,
      HRE_LAYER_ID,
      // hre-extent / mountain-outline（pickable: false）は優先リスト外なので無視される
      "hre-extent",
      "mountain-outline",
      RIVERS_HIT_LAYER_ID,
      MOUNTAIN_HIT_LAYER_ID,
      PEAK_HIT_LAYER_ID,
      CITY_HIT_LAYER_ID,
      PEAK_LAYER_ID,
      CITY_LAYER_ID,
      RIVERS_LAYER_ID,
      "mountain-labels",
      "peak-labels",
    ]),
  );
  // 山脈の判定円を勢力より下に描くと整合しない（勢力に覆われて拾えない）
  assert(
    !layerOrderMatchesPickingPriority([
      MOUNTAIN_HIT_LAYER_ID,
      POWER_LAYER_ID,
      RIVERS_LAYER_ID,
    ]),
  );
  // 山峰マーカーを都市ドットの上に描くと整合しない（可視記号の相対順が反転）
  assert(
    !layerOrderMatchesPickingPriority([
      POWER_LAYER_ID,
      CITY_LAYER_ID,
      PEAK_LAYER_ID,
      RIVERS_LAYER_ID,
    ]),
  );
});

Deno.test("PICKING_PRIORITY: italy-fiefs は powers より優先される（オーバーレイがベースの上）（TASK-96 AC #3）", () => {
  const italyIndex = PICKING_PRIORITY.indexOf(ITALY_FIEF_LAYER_ID);
  const powerIndex = PICKING_PRIORITY.indexOf(POWER_LAYER_ID);
  assert(italyIndex !== -1);
  assert(italyIndex < powerIndex);
});

Deno.test("PICKING_PRIORITY: 3 系統のオーバーレイ（HRE 領邦・仏諸侯領・伊諸侯領）は既存の相対順を保ったまま powers の上に並ぶ（TASK-96）", () => {
  const overlays = [HRE_LAYER_ID, FRANCE_FIEF_LAYER_ID, ITALY_FIEF_LAYER_ID];
  const indices = overlays.map((id) => PICKING_PRIORITY.indexOf(id));
  // 既存 2 層の相対順（hre-powers > france-fiefs）は TASK-71 のまま変えない
  assert(indices[0] < indices[1]);
  // 追加した伊諸侯領は既存 2 層の下・powers の上（既存の順序に影響しない位置）
  assert(indices[1] < indices[2]);
  assert(indices[2] < PICKING_PRIORITY.indexOf(POWER_LAYER_ID));
});

Deno.test("renderOrderFromPickingPriority: italy-fiefs は powers の上・france-fiefs の下に描画される（TASK-96）", () => {
  const order = renderOrderFromPickingPriority(PICKING_PRIORITY);
  assert(order.indexOf(POWER_LAYER_ID) < order.indexOf(ITALY_FIEF_LAYER_ID));
  assert(
    order.indexOf(ITALY_FIEF_LAYER_ID) < order.indexOf(FRANCE_FIEF_LAYER_ID),
  );
});

Deno.test("layerOrderMatchesPickingPriority: 3 系統のオーバーレイを含む実際の描画順が整合する（TASK-96 AC #6）", () => {
  assert(
    layerOrderMatchesPickingPriority([
      POWER_LAYER_ID,
      ITALY_FIEF_LAYER_ID,
      FRANCE_FIEF_LAYER_ID,
      HRE_LAYER_ID,
      // hre-extent（pickable: false）は優先リスト外なので無視される
      "hre-extent",
      RIVERS_HIT_LAYER_ID,
      CITY_HIT_LAYER_ID,
      CITY_LAYER_ID,
      RIVERS_LAYER_ID,
      "power-labels",
    ]),
  );
  // 伊諸侯領を仏諸侯領の上へ入れ替えると不整合として検出される
  assert(
    !layerOrderMatchesPickingPriority([
      POWER_LAYER_ID,
      FRANCE_FIEF_LAYER_ID,
      ITALY_FIEF_LAYER_ID,
      HRE_LAYER_ID,
    ]),
  );
});

// ---- Cliopatria 由来の領邦（TASK-110）----

Deno.test("PICKING_PRIORITY: cliopatria-fiefs は powers より優先される（オーバーレイがベースの上）（TASK-110 AC #3/#4）", () => {
  const cliopatriaIndex = PICKING_PRIORITY.indexOf(CLIOPATRIA_FIEF_LAYER_ID);
  const powerIndex = PICKING_PRIORITY.indexOf(POWER_LAYER_ID);
  assert(cliopatriaIndex !== -1);
  assert(cliopatriaIndex < powerIndex);
});

Deno.test("PICKING_PRIORITY: cliopatria-fiefs は OHM 由来 3 系統すべてに劣後する（重なりが残っても OHM 側が拾える）（TASK-110 AC #4）", () => {
  const cliopatriaIndex = PICKING_PRIORITY.indexOf(CLIOPATRIA_FIEF_LAYER_ID);
  for (
    const ohm of [HRE_LAYER_ID, FRANCE_FIEF_LAYER_ID, ITALY_FIEF_LAYER_ID]
  ) {
    assert(
      PICKING_PRIORITY.indexOf(ohm) < cliopatriaIndex,
      `${ohm} は cliopatria-fiefs より優先されなければならない`,
    );
  }
});

Deno.test("PICKING_PRIORITY: 既存 3 系統の相対順は TASK-110 で変わらない", () => {
  const overlays = [HRE_LAYER_ID, FRANCE_FIEF_LAYER_ID, ITALY_FIEF_LAYER_ID];
  const indices = overlays.map((id) => PICKING_PRIORITY.indexOf(id));
  assert(indices[0] < indices[1]);
  assert(indices[1] < indices[2]);
});

Deno.test("renderOrderFromPickingPriority: cliopatria-fiefs は powers の上・italy-fiefs の下に描画される（TASK-110）", () => {
  const order = renderOrderFromPickingPriority(PICKING_PRIORITY);
  assert(
    order.indexOf(POWER_LAYER_ID) < order.indexOf(CLIOPATRIA_FIEF_LAYER_ID),
  );
  assert(
    order.indexOf(CLIOPATRIA_FIEF_LAYER_ID) <
      order.indexOf(ITALY_FIEF_LAYER_ID),
  );
});

Deno.test("layerOrderMatchesPickingPriority: 4 系統のオーバーレイを含む実際の描画順が整合する（TASK-110）", () => {
  assert(
    layerOrderMatchesPickingPriority([
      POWER_LAYER_ID,
      CLIOPATRIA_FIEF_LAYER_ID,
      ITALY_FIEF_LAYER_ID,
      FRANCE_FIEF_LAYER_ID,
      HRE_LAYER_ID,
      "hre-extent",
      RIVERS_HIT_LAYER_ID,
      CITY_HIT_LAYER_ID,
      CITY_LAYER_ID,
      RIVERS_LAYER_ID,
      "power-labels",
    ]),
  );
  // Cliopatria を OHM 由来の層より上へ入れ替えると不整合として検出される
  assert(
    !layerOrderMatchesPickingPriority([
      POWER_LAYER_ID,
      ITALY_FIEF_LAYER_ID,
      CLIOPATRIA_FIEF_LAYER_ID,
      FRANCE_FIEF_LAYER_ID,
      HRE_LAYER_ID,
    ]),
  );
});

Deno.test("PICKING_PRIORITY: cities-hit は可視の河川ライン（rivers）と都市ドット（cities）には劣後する（TASK-82 AC #3）", () => {
  const hit = PICKING_PRIORITY.indexOf(CITY_HIT_LAYER_ID);
  assert(hit !== -1);
  assert(PICKING_PRIORITY.indexOf(RIVERS_LAYER_ID) < hit);
  assert(PICKING_PRIORITY.indexOf(CITY_LAYER_ID) < hit);
});

Deno.test("PICKING_PRIORITY: cities-hit は rivers-hit より優先される（都市の判定円が河川の判定帯に遮蔽されない）（TASK-82 AC #1）", () => {
  assert(
    PICKING_PRIORITY.indexOf(CITY_HIT_LAYER_ID) <
      PICKING_PRIORITY.indexOf(RIVERS_HIT_LAYER_ID),
  );
});

Deno.test("PICKING_PRIORITY: france-fiefs は powers より優先される（オーバーレイがベースの上）（TASK-71）", () => {
  const fiefIndex = PICKING_PRIORITY.indexOf(FRANCE_FIEF_LAYER_ID);
  const powerIndex = PICKING_PRIORITY.indexOf(POWER_LAYER_ID);
  assert(fiefIndex !== -1);
  assert(powerIndex !== -1);
  assert(fiefIndex < powerIndex);
});

Deno.test("renderOrderFromPickingPriority: france-fiefs は powers の上・cities の下に描画される（TASK-71）", () => {
  const order = renderOrderFromPickingPriority(PICKING_PRIORITY);
  assert(order.indexOf(POWER_LAYER_ID) < order.indexOf(FRANCE_FIEF_LAYER_ID));
  assert(order.indexOf(FRANCE_FIEF_LAYER_ID) < order.indexOf(CITY_LAYER_ID));
});

Deno.test("isDirectPickFinal: france-fiefs は直下 pick 確定にしない（河川の近傍再ピックを妨げない）（TASK-71）", () => {
  assert(!isDirectPickFinal(FRANCE_FIEF_LAYER_ID));
});

Deno.test("PICKING_PRIORITY: rivers-hit は rivers より劣後する（rivers より後）（TASK-49）", () => {
  const hitIndex = PICKING_PRIORITY.indexOf(RIVERS_HIT_LAYER_ID);
  const riverIndex = PICKING_PRIORITY.indexOf(RIVERS_LAYER_ID);
  assert(hitIndex !== -1);
  assert(riverIndex !== -1);
  assert(riverIndex < hitIndex);
});

Deno.test("PICKING_PRIORITY: cities は rivers-hit より優先される（河畔都市マーカーの picking 遮蔽を防ぐ）（TASK-49）", () => {
  const cityIndex = PICKING_PRIORITY.indexOf(CITY_LAYER_ID);
  const hitIndex = PICKING_PRIORITY.indexOf(RIVERS_HIT_LAYER_ID);
  assert(cityIndex !== -1);
  assert(hitIndex !== -1);
  assert(cityIndex < hitIndex);
});

// ---- isRiversPickLayerId ----

Deno.test("isRiversPickLayerId: rivers / rivers-hit の両方で true（TASK-43）", () => {
  assert(isRiversPickLayerId(RIVERS_LAYER_ID));
  assert(isRiversPickLayerId(RIVERS_HIT_LAYER_ID));
});

Deno.test("isRiversPickLayerId: rivers 系以外は false（TASK-43）", () => {
  assert(!isRiversPickLayerId(POWER_LAYER_ID));
  assert(!isRiversPickLayerId(CITY_LAYER_ID));
  assert(!isRiversPickLayerId(HRE_LAYER_ID));
  assert(!isRiversPickLayerId(undefined));
});

// ---- isCityPickLayerId / isNearCursorRepickable（TASK-82）----

Deno.test("isCityPickLayerId: cities / cities-hit の両方で true（TASK-82）", () => {
  assert(isCityPickLayerId(CITY_LAYER_ID));
  assert(isCityPickLayerId(CITY_HIT_LAYER_ID));
});

Deno.test("isCityPickLayerId: 都市系以外は false（TASK-82）", () => {
  assert(!isCityPickLayerId(RIVERS_LAYER_ID));
  assert(!isCityPickLayerId(RIVERS_HIT_LAYER_ID));
  assert(!isCityPickLayerId(POWER_LAYER_ID));
  assert(!isCityPickLayerId(undefined));
});

Deno.test("isNearCursorRepickable: cities-hit だけがクリックの近傍再ピック対象外（ホバーと実効判定範囲を一致させる）（TASK-82 AC #2）", () => {
  assert(!isNearCursorRepickable(CITY_HIT_LAYER_ID));
  assert(isNearCursorRepickable(CITY_LAYER_ID));
  assert(isNearCursorRepickable(RIVERS_LAYER_ID));
  assert(isNearCursorRepickable(RIVERS_HIT_LAYER_ID));
  assert(isNearCursorRepickable(POWER_LAYER_ID));
  assert(isNearCursorRepickable(undefined));
});

// ---- selectPreferredPick ----

/** テスト用の picking 候補を組み立てる */
function pick(
  layerId: string,
  label: string,
): { layerId: string; label: string } {
  return { layerId, label };
}

Deno.test("selectPreferredPick: 河川と勢力が重なる場合は河川を選ぶ（AC #2）", () => {
  const rhine = pick(RIVERS_LAYER_ID, "ライン川");
  const france = pick(POWER_LAYER_ID, "フランス王国");
  assertEquals(selectPreferredPick([france, rhine]), rhine);
  assertEquals(selectPreferredPick([rhine, france]), rhine);
});

Deno.test("selectPreferredPick: 河川 > 都市 > HRE > 勢力 の全順位で最優先を選ぶ", () => {
  const river = pick(RIVERS_LAYER_ID, "ドナウ川");
  const city = pick(CITY_LAYER_ID, "ウィーン");
  const hre = pick(HRE_LAYER_ID, "オーストリア大公国");
  const power = pick(POWER_LAYER_ID, "神聖ローマ帝国");
  assertEquals(selectPreferredPick([power, hre, city, river]), river);
  assertEquals(selectPreferredPick([power, hre, city]), city);
  assertEquals(selectPreferredPick([power, hre]), hre);
  assertEquals(selectPreferredPick([power]), power);
});

Deno.test("selectPreferredPick: 候補ゼロなら null を返す", () => {
  assertEquals(selectPreferredPick([]), null);
});

Deno.test("selectPreferredPick: 優先リスト外のレイヤーは最後に回される", () => {
  const unknown = pick("power-labels", "ラベル");
  const power = pick(POWER_LAYER_ID, "フランス王国");
  assertEquals(selectPreferredPick([unknown, power]), power);
  // 優先リスト外しか無ければそれを返す（候補があるのに null にはしない）
  assertEquals(selectPreferredPick([unknown]), unknown);
});

Deno.test("selectPreferredPick: 同順位の候補は先勝ち（安定）", () => {
  const first = pick(RIVERS_LAYER_ID, "ライン川");
  const second = pick(RIVERS_LAYER_ID, "ドナウ川");
  assertEquals(selectPreferredPick([first, second]), first);
});

// ---- resolveClickPick ----

/**
 * テスト用の pickMultipleObjects 相当の候補（PickingInfo の layer / object
 * 部分のみ模す）。object は #216 のカーソル内包判定が読む GeoJSON Feature で、
 * 従来のテスト（内包判定に関与しない候補）は省略してよい。
 */
function pickInfo(
  layerId: string | null,
  label: string,
  object?: unknown,
): { layer: { id: string } | null; label: string; object?: unknown } {
  return { layer: layerId === null ? null : { id: layerId }, label, object };
}

Deno.test("resolveClickPick: 候補ゼロなら null を返す（TASK-36）", () => {
  assertEquals(resolveClickPick([]), null);
});

Deno.test("resolveClickPick: rivers が候補に含まれれば先頭でなくても rivers を選ぶ（TASK-36 AC）", () => {
  const power = pickInfo(POWER_LAYER_ID, "フランス王国");
  const river = pickInfo(RIVERS_LAYER_ID, "ライン川");
  // pickMultipleObjects はカーソル直下（powers）を先頭で返す想定
  assertEquals(resolveClickPick([power, river]), river);
});

Deno.test("resolveClickPick: rivers-hit の候補も rivers 同様に最優先で選ばれる（TASK-43）", () => {
  const power = pickInfo(POWER_LAYER_ID, "フランス王国");
  const hit = pickInfo(RIVERS_HIT_LAYER_ID, "ライン川");
  assertEquals(resolveClickPick([power, hit]), hit);
  assertEquals(resolveClickPick([hit, power]), hit);
});

Deno.test("resolveClickPick: rivers-hit と rivers が同時に候補でも river 系が勝つ（勢力より優先）（TASK-43）", () => {
  const power = pickInfo(POWER_LAYER_ID, "フランス王国");
  const hit = pickInfo(RIVERS_HIT_LAYER_ID, "ライン川");
  const river = pickInfo(RIVERS_LAYER_ID, "ライン川");
  const best = resolveClickPick([power, hit, river]);
  assert(best === hit || best === river);
});

Deno.test("resolveClickPick: rivers-hit と cities が同時に候補なら cities を選ぶ（河畔都市マーカーの picking 遮蔽を解消）（TASK-49）", () => {
  const hit = pickInfo(RIVERS_HIT_LAYER_ID, "セーヌ川");
  const city = pickInfo(CITY_LAYER_ID, "パリ");
  assertEquals(resolveClickPick([hit, city]), city);
  assertEquals(resolveClickPick([city, hit]), city);
});

Deno.test("resolveClickPick: rivers と cities が同時に候補なら従来どおり rivers を選ぶ（decision-7 維持）（TASK-49）", () => {
  const river = pickInfo(RIVERS_LAYER_ID, "セーヌ川");
  const city = pickInfo(CITY_LAYER_ID, "パリ");
  assertEquals(resolveClickPick([river, city]), river);
  assertEquals(resolveClickPick([city, river]), river);
});

Deno.test("resolveClickPick: rivers が候補に無ければ既存挙動（PICKING_PRIORITY の最優先）を返す", () => {
  const power = pickInfo(POWER_LAYER_ID, "フランス王国");
  const hre = pickInfo(HRE_LAYER_ID, "オーストリア大公国");
  // hre が power より高優先のため、入力順によらず hre を返す
  assertEquals(resolveClickPick([power, hre]), hre);
  assertEquals(resolveClickPick([hre, power]), hre);
});

Deno.test("resolveClickPick: rivers も混在候補も無い単一候補ならそれを返す（先頭 = 直下の最前面）", () => {
  const power = pickInfo(POWER_LAYER_ID, "フランス王国");
  assertEquals(resolveClickPick([power]), power);
});

Deno.test("resolveClickPick: 都市 > HRE > 勢力 の優先順も rivers 同様に成立する", () => {
  const power = pickInfo(POWER_LAYER_ID, "神聖ローマ帝国");
  const city = pickInfo(CITY_LAYER_ID, "ウィーン");
  assertEquals(resolveClickPick([power, city]), city);
});

Deno.test("resolveClickPick: cities-hit は近傍再ピックの候補から除外され、他候補が選ばれる（TASK-82 AC #2）", () => {
  const cityHit = pickInfo(CITY_HIT_LAYER_ID, "パリ");
  const power = pickInfo(POWER_LAYER_ID, "フランス王国");
  // 直下が powers で、半径 6px 内にだけ都市の判定円がある状況。ホバーでは
  // 都市を拾えない位置なので、クリックでも拾わない（範囲を一致させる）
  assertEquals(resolveClickPick([power, cityHit]), power);
  assertEquals(resolveClickPick([cityHit, power]), power);
});

Deno.test("resolveClickPick: 候補が cities-hit だけなら null（直下 pick の結果へフォールバック）（TASK-82 AC #2）", () => {
  const cityHit = pickInfo(CITY_HIT_LAYER_ID, "パリ");
  assertEquals(resolveClickPick([cityHit]), null);
});

Deno.test("resolveClickPick: cities-hit を除外しても cities（ドット）は従来どおり選ばれる（TASK-82）", () => {
  const cityHit = pickInfo(CITY_HIT_LAYER_ID, "ルーアン");
  const city = pickInfo(CITY_LAYER_ID, "パリ");
  const power = pickInfo(POWER_LAYER_ID, "フランス王国");
  assertEquals(resolveClickPick([power, cityHit, city]), city);
});

Deno.test("isDirectPickFinal: rivers/rivers-hit/cities/cities-hit の直下ヒットは radius 再ピックで上書きしない（TASK-49, TASK-82）", () => {
  assert(isDirectPickFinal(RIVERS_LAYER_ID));
  assert(isDirectPickFinal(RIVERS_HIT_LAYER_ID));
  // 都市ドットの直下ヒットを近傍河川の radius 再ピックで奪ってはいけない
  assert(isDirectPickFinal(CITY_LAYER_ID));
  // 都市の判定円（cities-hit）も同様。ここを確定にしないと、直下で都市を
  // 拾えているのに近傍再ピックの rivers（PICKING_PRIORITY 上位）に奪われる
  assert(isDirectPickFinal(CITY_HIT_LAYER_ID));
  assert(!isDirectPickFinal(POWER_LAYER_ID));
  assert(!isDirectPickFinal(HRE_LAYER_ID));
  assert(!isDirectPickFinal(undefined));
});

Deno.test("resolveClickPick: layer が null（何も無い場所）のみなら先頭候補をそのまま返す", () => {
  const blank = pickInfo(null, "");
  assertEquals(resolveClickPick([blank]), blank);
});

// ---- resolveClickPick のカーソル内包判定（#216）----

Deno.test("POLITICAL_PICK_LAYER_IDS: PICKING_PRIORITY の政治セグメント（sovereign-fiefs〜powers）と一致する（#216）", () => {
  assertEquals(
    [...POLITICAL_PICK_LAYER_IDS],
    PICKING_PRIORITY.slice(PICKING_PRIORITY.indexOf(SOVEREIGN_FIEF_LAYER_ID)),
  );
});

/** 2°×2° の矩形 Feature（pick_handlers_test.ts polygonFeature と同じ要領） */
function squareFeature(origin: [number, number]): Feature {
  const [x, y] = origin;
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [[[x, y], [x + 2, y], [x + 2, y + 2], [x, y + 2], [x, y]]],
    },
  };
}

/** カーソル（lng/lat）。CONTAINING の内側・ADJACENT の外側にある */
const CURSOR: readonly number[] = [1, 46];
/** カーソルを含む矩形（x: 0..2, y: 45..47） */
const CONTAINING: [number, number] = [0, 45];
/** カーソルを含まない隣接矩形（x: 2..4, y: 45..47） */
const ADJACENT: [number, number] = [2, 45];

Deno.test("resolveClickPick: カーソルを含む政治ポリゴンは、含まない政治ポリゴンが優先上位でも奪われない（全順序対の性質）（#216 AC3）", () => {
  // レイヤー個別の列挙ではなく、政治ポリゴン集合の全順序対 (A, B) について
  // 「A はカーソルを含み B は含まない → A が選ばれる」を検証する。ホバーは
  // 直下 pick（= カーソルを含む面しか拾わない）なので、この性質がクリック側で
  // 成立すればホバー/クリックの解決 feature は一致する。
  for (const a of POLITICAL_PICK_LAYER_IDS) {
    for (const b of POLITICAL_PICK_LAYER_IDS) {
      if (a === b) continue;
      const inside = pickInfo(a, `${a}:inside`, squareFeature(CONTAINING));
      const outside = pickInfo(b, `${b}:outside`, squareFeature(ADJACENT));
      assertEquals(
        resolveClickPick([outside, inside], CURSOR),
        inside,
        `カーソルを含まない ${b} が、含む ${a} に勝ってはならない`,
      );
      assertEquals(
        resolveClickPick([inside, outside], CURSOR),
        inside,
        `入力順によらずカーソルを含む ${a} が選ばれること（vs ${b}）`,
      );
    }
  }
});

Deno.test("resolveClickPick: カーソルを含む候補が複数あれば従来どおり優先順で選ぶ（微小国家: sovereign-fiefs が最上位のまま勝つ）（#216 / #191 回帰）", () => {
  const sanMarino = pickInfo(
    SOVEREIGN_FIEF_LAYER_ID,
    "San Marino",
    squareFeature(CONTAINING),
  );
  const rimini = pickInfo(
    ITALY_FIEF_LAYER_ID,
    "Lordship of Rimini",
    squareFeature(CONTAINING),
  );
  assertEquals(resolveClickPick([rimini, sanMarino], CURSOR), sanMarino);
  assertEquals(resolveClickPick([sanMarino, rimini], CURSOR), sanMarino);
});

Deno.test("resolveClickPick: どの政治候補もカーソルを含まなければ降格せず従来どおり優先順で選ぶ（海上クリック等）（#216）", () => {
  const offshoreCursor: readonly number[] = [10, 46];
  const sovereign = pickInfo(
    SOVEREIGN_FIEF_LAYER_ID,
    "Savoy",
    squareFeature(CONTAINING),
  );
  const italy = pickInfo(
    ITALY_FIEF_LAYER_ID,
    "Marquisate of Saluzzo",
    squareFeature(ADJACENT),
  );
  assertEquals(resolveClickPick([italy, sovereign], offshoreCursor), sovereign);
});

Deno.test("resolveClickPick: 非政治候補（河川）は内包判定の対象外で、従来どおり政治候補より優先される（RIVER_CLICK_TOLERANCE_PX の契約不変）（#216）", () => {
  const italy = pickInfo(
    ITALY_FIEF_LAYER_ID,
    "Marquisate of Saluzzo",
    squareFeature(CONTAINING),
  );
  // 河川候補は feature を持たなくても降格されない（線であり面の内包を問わない）
  const riverHit = pickInfo(RIVERS_HIT_LAYER_ID, "ポー川");
  assertEquals(resolveClickPick([italy, riverHit], CURSOR), riverHit);
  const river = pickInfo(RIVERS_LAYER_ID, "ポー川");
  assertEquals(resolveClickPick([italy, river], CURSOR), river);
});

Deno.test("resolveClickPick: feature が無い・Polygon 系でない政治候補は「含まない」扱いにせず降格対象外（安全側）（#216）", () => {
  const italy = pickInfo(
    ITALY_FIEF_LAYER_ID,
    "Marquisate of Saluzzo",
    squareFeature(CONTAINING),
  );
  // feature（object）を持たない候補は判定不能 → 従来どおり優先順で競う
  const noFeature = pickInfo(SOVEREIGN_FIEF_LAYER_ID, "Savoy");
  assertEquals(resolveClickPick([noFeature, italy], CURSOR), noFeature);
  // ジオメトリが Polygon/MultiPolygon でない候補も同様
  const pointGeometry = pickInfo(SOVEREIGN_FIEF_LAYER_ID, "Savoy", {
    type: "Feature",
    properties: {},
    geometry: { type: "Point", coordinates: [10, 50] },
  });
  assertEquals(resolveClickPick([pointGeometry, italy], CURSOR), pointGeometry);
});

Deno.test("resolveClickPick: カーソル省略（従来シグネチャ）は内包判定を行わず優先順で選ぶ（#216）", () => {
  const sovereign = pickInfo(
    SOVEREIGN_FIEF_LAYER_ID,
    "Savoy",
    squareFeature(ADJACENT),
  );
  const italy = pickInfo(
    ITALY_FIEF_LAYER_ID,
    "Marquisate of Saluzzo",
    squareFeature(CONTAINING),
  );
  assertEquals(resolveClickPick([italy, sovereign]), sovereign);
});

// ---- #216 AC1: 実データ回帰（1500 年、Savoy に隣接する伊小所領）----

/** 出荷済みの 1500 年データ（approximate_borders_test.ts と同じ読み込み方） */
const italyFiefs1500 = JSON.parse(
  Deno.readTextFileSync(
    new URL("../data/italy_fiefs_flat_1500.geojson", import.meta.url),
  ),
) as FeatureCollection;
const sovereignFiefs1500 = JSON.parse(
  Deno.readTextFileSync(
    new URL("../data/sovereign_fiefs_flat_1500.geojson", import.meta.url),
  ),
) as FeatureCollection;

function featureNamed(collection: FeatureCollection, name: string): Feature {
  const feature = collection.features.find((f) => f.properties?.NAME === name);
  assert(feature !== undefined, `feature が見つからない: ${name}`);
  return feature;
}

Deno.test("resolveClickPick: 1500 年の Saluzzo / Asti / Montferrat 内部のカーソルは、近傍候補に Savoy（sovereign-fiefs）がいても小所領を返す（#216 AC1）", () => {
  // Issue #216 の実測: Savoy 境界から 6px 以内が各小所領面積の 19〜69% を占め、
  // ホバーは小所領・クリックは Savoy に乖離していた。小所領の内部点をカーソル
  // とし、近傍再ピック候補に Savoy が混ざってもホバーと同じ小所領へ解決する
  // ことを出荷データで固定する。
  const savoy = featureNamed(sovereignFiefs1500, "Savoy");
  for (
    const name of [
      "Marquisate of Saluzzo",
      "County of Asti",
      "March of Montferrat",
    ]
  ) {
    const fief = featureNamed(italyFiefs1500, name);
    const cursor = labelAnchorFor(fief);
    assert(cursor !== null, `${name} の内部点が取れない`);
    // 前提の自己検証: カーソルは小所領の内側・Savoy の外側にある
    // （flat 化が重なりを排他化しているので必ず成立するはず）
    assert(
      booleanPointInPolygon(cursor, fief.geometry as Polygon | MultiPolygon),
      `${name} の内部点が自身に含まれない`,
    );
    assert(
      !booleanPointInPolygon(cursor, savoy.geometry as Polygon | MultiPolygon),
      `${name} の内部点が Savoy に含まれている（前提不成立）`,
    );
    const fiefPick = pickInfo(ITALY_FIEF_LAYER_ID, name, fief);
    const savoyPick = pickInfo(SOVEREIGN_FIEF_LAYER_ID, "Savoy", savoy);
    // pickMultipleObjects の候補順（距離順）によらず小所領が選ばれること
    assertEquals(
      resolveClickPick([savoyPick, fiefPick], cursor),
      fiefPick,
      `${name} のクリックが Savoy に奪われている`,
    );
    assertEquals(
      resolveClickPick([fiefPick, savoyPick], cursor),
      fiefPick,
      `${name} のクリックが Savoy に奪われている（順序逆）`,
    );
  }
});

// ---- resolveClickPick の詳細表示 focus 降格（#349 / #293 分割 4/5）----

Deno.test("FIEF_PICK_LAYER_IDS: POLITICAL_PICK_LAYER_IDS から powers（base）を除いた領邦 6 系統と一致する（#349 AC5）", () => {
  assertEquals(
    [...FIEF_PICK_LAYER_IDS],
    [
      SOVEREIGN_FIEF_LAYER_ID,
      HRE_LAYER_ID,
      FRANCE_FIEF_LAYER_ID,
      ITALY_FIEF_LAYER_ID,
      CLIOPATRIA_FIEF_LAYER_ID,
      BRITAIN_FIEF_LAYER_ID,
    ],
  );
  // powers（base 勢力）は focus 降格の対象外 = focus 外の国は必ずここへ落ちる
  assert(!FIEF_PICK_LAYER_IDS.includes(POWER_LAYER_ID));
});

/**
 * 宗主キー解決のテストダブル。実体（pick_handlers.ts）は suzerain_extent.ts の
 * suzerainExtentKey（SUBJECTO / base の包含）だが、picking.ts は純粋な降格
 * ロジックだけを持ち解決はコールバックで受ける（suzerain_extent.ts →
 * picking.ts の依存があるため逆向きに import できない）。ここでは feature の
 * properties.SUZERAIN をそのまま宗主キーとみなす。
 */
function suzerainKeyOfFixture(
  _layerId: string,
  object: unknown,
): string | null {
  const key = (object as
    | { properties?: { SUZERAIN?: unknown } | null }
    | null
    | undefined)?.properties?.SUZERAIN;
  return typeof key === "string" ? key : null;
}

/** カーソルを含む矩形 + 宗主キー（未解決は SUZERAIN を持たせない） */
function suzerainPick(
  layerId: string,
  suzerain: string | null,
  origin: [number, number] = CONTAINING,
) {
  const feature = squareFeature(origin);
  feature.properties = suzerain === null ? {} : { SUZERAIN: suzerain };
  return pickInfo(layerId, `${layerId}:${suzerain ?? "unknown"}`, feature);
}

const HRE_KEY = "Holy Roman Empire";

/** focus = フランス（詳細表示の対象が France 1 か国だけの状態） */
const FRANCE_FOCUS = {
  key: "France",
  suzerainKeyOf: suzerainKeyOfFixture,
} as const;

/** focus 有効だが中央が海上・base 勢力外（#293 の「詳細表示を行わない」状態） */
const NO_FOCUS = { key: null, suzerainKeyOf: suzerainKeyOfFixture } as const;

Deno.test("resolveClickPick: focus 外の領邦候補は降格し、base の上位勢力（powers）が返る（#349 AC1 / AC7）", () => {
  // 仏・HRE・伊・ブリテン・主権政体・Cliopatria の 6 系統すべてで成立すること
  const powers = suzerainPick(POWER_LAYER_ID, HRE_KEY);
  for (const layerId of FIEF_PICK_LAYER_IDS) {
    const fief = suzerainPick(layerId, HRE_KEY);
    assertEquals(
      resolveClickPick([fief, powers], CURSOR, FRANCE_FOCUS),
      powers,
      `focus 外の ${layerId} が picking を奪っている`,
    );
    assertEquals(
      resolveClickPick([powers, fief], CURSOR, FRANCE_FOCUS),
      powers,
      `focus 外の ${layerId} が picking を奪っている（順序逆）`,
    );
  }
});

Deno.test("resolveClickPick: focus 内では従来どおり個別領邦が返る（#349 AC2 / AC7）", () => {
  const powers = suzerainPick(POWER_LAYER_ID, "France");
  for (const layerId of FIEF_PICK_LAYER_IDS) {
    const fief = suzerainPick(layerId, "France");
    assertEquals(
      resolveClickPick([powers, fief], CURSOR, FRANCE_FOCUS),
      fief,
      `focus 内の ${layerId} が base に奪われている`,
    );
    assertEquals(
      resolveClickPick([fief, powers], CURSOR, FRANCE_FOCUS),
      fief,
      `focus 内の ${layerId} が base に奪われている（順序逆）`,
    );
  }
});

Deno.test("resolveClickPick: powers（base）は focus 外の宗主でも降格されない（focus 外の国は上位勢力が返る）（#349 AC1）", () => {
  const powers = suzerainPick(POWER_LAYER_ID, HRE_KEY);
  assertEquals(resolveClickPick([powers], CURSOR, FRANCE_FOCUS), powers);
});

Deno.test("resolveClickPick: focus 内でも宗主キーが解決できない領邦は降格される（見えないのに pickable な面を作らない）（#349 AC1）", () => {
  // #348 の絞り込みは宗主キーで分類するため、キーの無い封土（伊のピオンビーノ
  // 領主領など）はどの focus グループにも入らず不可視になる。picking 側も同じ
  // 規則（focus と一致する封土だけ残す）にして表示と食い違わせない。
  const powers = suzerainPick(POWER_LAYER_ID, "France");
  const orphan = suzerainPick(ITALY_FIEF_LAYER_ID, null);
  assertEquals(
    resolveClickPick([orphan, powers], CURSOR, FRANCE_FOCUS),
    powers,
  );
});

Deno.test("resolveClickPick: focus が無い（中央が海上・base 勢力外）なら全領邦が降格し、全域が上位勢力単位で返る（#349 AC4）", () => {
  const powers = suzerainPick(POWER_LAYER_ID, "France");
  for (const layerId of FIEF_PICK_LAYER_IDS) {
    const fief = suzerainPick(layerId, "France");
    assertEquals(
      resolveClickPick([fief, powers], CURSOR, NO_FOCUS),
      powers,
      `focus 無し（詳細表示なし）で ${layerId} が返っている`,
    );
  }
});

Deno.test("resolveClickPick: focus 降格は非政治候補（河川・都市・山岳）に及ばない（既存の合成契約が不変）（#349 AC5）", () => {
  const fief = suzerainPick(HRE_LAYER_ID, HRE_KEY);
  const river = pickInfo(RIVERS_LAYER_ID, "ライン川");
  assertEquals(resolveClickPick([fief, river], CURSOR, FRANCE_FOCUS), river);
  const city = pickInfo(CITY_LAYER_ID, "ウィーン");
  assertEquals(resolveClickPick([fief, city], CURSOR, FRANCE_FOCUS), city);
  const mountain = pickInfo(MOUNTAIN_HIT_LAYER_ID, "アルプス山脈");
  // 山岳の判定円は近傍再ピックの候補外（isNearCursorRepickable）なので、
  // ここでは「focus 降格が山岳を巻き込まない」ことだけを見る
  assertEquals(resolveClickPick([mountain], CURSOR, FRANCE_FOCUS), null);
});

Deno.test("resolveClickPick: focus 降格とカーソル内包降格は併用され、focus 内でもカーソル外の面は選ばれない（#349 / #216 併存）", () => {
  const inside = suzerainPick(ITALY_FIEF_LAYER_ID, "France", CONTAINING);
  const outside = suzerainPick(SOVEREIGN_FIEF_LAYER_ID, "France", ADJACENT);
  assertEquals(
    resolveClickPick([outside, inside], CURSOR, FRANCE_FOCUS),
    inside,
  );
});

Deno.test("resolveClickPick: 候補が focus 外の領邦だけなら降格結果が空になり、先頭候補へフォールバックする（#349）", () => {
  // powers が候補に無い状況（focus 外の面が海側へはみ出している等）。降格で
  // 候補が消えても null を返さず、従来どおり直下 pick 相当（先頭）へ倒す
  const fief = suzerainPick(BRITAIN_FIEF_LAYER_ID, HRE_KEY);
  assertEquals(resolveClickPick([fief], CURSOR, FRANCE_FOCUS), fief);
});

// AC6: focus を渡さない既存呼び出しの回帰（#293 分割 4/5 では main.ts が
// focus を注入しないため、この経路が本番の挙動そのものになる）

Deno.test("resolveClickPick: focus 引数を渡さない / null / undefined は既存実装と同一結果（#349 AC6）", () => {
  // 政治 7 層の全順序対 × カーソル内包の有無で、3 つの呼び出し形が一致すること
  for (const a of POLITICAL_PICK_LAYER_IDS) {
    for (const b of POLITICAL_PICK_LAYER_IDS) {
      if (a === b) continue;
      for (const origin of [CONTAINING, ADJACENT] as const) {
        const first = suzerainPick(a, HRE_KEY, origin);
        const second = suzerainPick(b, "France", CONTAINING);
        const picks = [first, second];
        const baseline = resolveClickPick(picks, CURSOR);
        assertEquals(
          resolveClickPick(picks, CURSOR, null),
          baseline,
          `focus=null が既存挙動と食い違う（${a} vs ${b}）`,
        );
        assertEquals(
          resolveClickPick(picks, CURSOR, undefined),
          baseline,
          `focus=undefined が既存挙動と食い違う（${a} vs ${b}）`,
        );
      }
    }
  }
  // カーソルも省略した最古のシグネチャでも同じ
  const fief = suzerainPick(HRE_LAYER_ID, HRE_KEY);
  const powers = suzerainPick(POWER_LAYER_ID, "France");
  assertEquals(
    resolveClickPick([powers, fief], undefined, null),
    resolveClickPick([powers, fief]),
  );
});

// ---- renderOrderFromPickingPriority ----

Deno.test("renderOrderFromPickingPriority: 描画順（下→上）は優先順の逆順になる", () => {
  assertEquals(
    renderOrderFromPickingPriority(PICKING_PRIORITY),
    [
      POWER_LAYER_ID,
      BRITAIN_FIEF_LAYER_ID,
      CLIOPATRIA_FIEF_LAYER_ID,
      ITALY_FIEF_LAYER_ID,
      FRANCE_FIEF_LAYER_ID,
      HRE_LAYER_ID,
      // #191: 主権政体は微小国家を含むため政治ポリゴンの最上段
      SOVEREIGN_FIEF_LAYER_ID,
      RIVERS_HIT_LAYER_ID,
      MOUNTAIN_HIT_LAYER_ID,
      PEAK_HIT_LAYER_ID,
      CITY_HIT_LAYER_ID,
      PEAK_LAYER_ID,
      CITY_LAYER_ID,
      RIVERS_LAYER_ID,
    ],
  );
});

Deno.test("renderOrderFromPickingPriority: 入力配列を破壊しない", () => {
  const priority = [RIVERS_LAYER_ID, POWER_LAYER_ID] as const;
  const before = [...priority];
  renderOrderFromPickingPriority(priority);
  assertEquals([...priority], before);
});

// ---- layerOrderMatchesPickingPriority ----

Deno.test("layerOrderMatchesPickingPriority: 優先逆順（下→上）の並びは整合する", () => {
  assert(
    layerOrderMatchesPickingPriority([
      POWER_LAYER_ID,
      HRE_LAYER_ID,
      CITY_LAYER_ID,
      RIVERS_LAYER_ID,
    ]),
  );
});

Deno.test("layerOrderMatchesPickingPriority: ラベル等の優先外レイヤーが混ざっても整合する", () => {
  assert(
    layerOrderMatchesPickingPriority([
      POWER_LAYER_ID,
      HRE_LAYER_ID,
      CITY_LAYER_ID,
      RIVERS_LAYER_ID,
      "power-labels",
      "river-labels",
      "city-labels",
    ]),
  );
});

Deno.test("layerOrderMatchesPickingPriority: rivers が cities より下だと整合しない", () => {
  assert(
    !layerOrderMatchesPickingPriority([
      POWER_LAYER_ID,
      HRE_LAYER_ID,
      RIVERS_LAYER_ID,
      CITY_LAYER_ID,
    ]),
  );
});

Deno.test("layerOrderMatchesPickingPriority: pickable レイヤーの重複は整合しない", () => {
  assert(
    !layerOrderMatchesPickingPriority([
      POWER_LAYER_ID,
      RIVERS_LAYER_ID,
      RIVERS_LAYER_ID,
    ]),
  );
});

Deno.test("layerOrderMatchesPickingPriority: 一部レイヤーが無くても残りの相対順で判定する", () => {
  // cities が無い構成でも rivers が powers より上なら整合
  assert(layerOrderMatchesPickingPriority([POWER_LAYER_ID, RIVERS_LAYER_ID]));
  assert(!layerOrderMatchesPickingPriority([RIVERS_LAYER_ID, POWER_LAYER_ID]));
});

Deno.test("layerOrderMatchesPickingPriority: cities-hit は rivers-hit の上・cities の下でないと整合しない（TASK-82 AC #5）", () => {
  assert(
    layerOrderMatchesPickingPriority([
      POWER_LAYER_ID,
      HRE_LAYER_ID,
      RIVERS_HIT_LAYER_ID,
      CITY_HIT_LAYER_ID,
      CITY_LAYER_ID,
      RIVERS_LAYER_ID,
    ]),
  );
  // cities より上（= cities より優先）に置くと不整合
  assert(
    !layerOrderMatchesPickingPriority([
      POWER_LAYER_ID,
      HRE_LAYER_ID,
      RIVERS_HIT_LAYER_ID,
      CITY_LAYER_ID,
      CITY_HIT_LAYER_ID,
      RIVERS_LAYER_ID,
    ]),
  );
  // rivers-hit より下（= rivers-hit に遮蔽される）に置くと不整合
  assert(
    !layerOrderMatchesPickingPriority([
      POWER_LAYER_ID,
      HRE_LAYER_ID,
      CITY_HIT_LAYER_ID,
      RIVERS_HIT_LAYER_ID,
      CITY_LAYER_ID,
      RIVERS_LAYER_ID,
    ]),
  );
});

Deno.test("layerOrderMatchesPickingPriority: rivers-hit は cities より下・rivers より下でないと整合しない（TASK-49）", () => {
  assert(
    layerOrderMatchesPickingPriority([
      POWER_LAYER_ID,
      HRE_LAYER_ID,
      RIVERS_HIT_LAYER_ID,
      CITY_LAYER_ID,
      RIVERS_LAYER_ID,
    ]),
  );
  assert(
    !layerOrderMatchesPickingPriority([
      POWER_LAYER_ID,
      HRE_LAYER_ID,
      CITY_LAYER_ID,
      RIVERS_LAYER_ID,
      RIVERS_HIT_LAYER_ID,
    ]),
  );
});
