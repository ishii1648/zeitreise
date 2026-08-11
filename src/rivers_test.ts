import { assert, assertEquals } from "@std/assert";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { Rgba } from "./powers.ts";
import { memoizeLatest } from "./memo.ts";
import { PICKING_RADIUS_PX } from "./picking.ts";
import {
  ACTIVE_RIVER_LABEL_COLOR,
  MIN_LABEL_PRIORITY,
  RIVER_LABEL_COLOR,
} from "./labels.ts";
import {
  filterVisibleRiverLabels,
  RIVER_CLICK_TOLERANCE_PX,
  RIVER_HIT_LINE_COLOR,
  RIVER_HIT_LINE_WIDTH_PX,
  RIVER_HOVERED_LINE_COLOR,
  RIVER_HOVERED_LINE_WIDTH_PX,
  RIVER_LABEL_CITY_CLEARANCE_DEG,
  RIVER_LINE_COLOR,
  RIVER_LINE_WIDTH_PX,
  RIVER_SELECTED_LINE_COLOR,
  RIVER_SELECTED_LINE_WIDTH_PX,
  riverLabelAnchors,
  riverLabelColor,
  type RiverLabelDatum,
  riverLabelMinPriority,
  riverLineColor,
  riverLineWidth,
  riverNameFor,
  RIVERS_DATA_URL,
  selectRiverLabelAnchor,
  toggleRiverSelection,
} from "./rivers.ts";
import { allCityPositions, type CitiesData } from "./cities.ts";

// ---- 透明ヒットライン層（TASK-43）----

Deno.test("RIVER_HIT_LINE_WIDTH_PX: 12px 以上（ホバー/クリックの実効判定幅を広げる）", () => {
  assert(RIVER_HIT_LINE_WIDTH_PX >= 12);
});

Deno.test("RIVER_HIT_LINE_COLOR: 完全透明（alpha 0）", () => {
  assertEquals(RIVER_HIT_LINE_COLOR[3], 0);
});

// ---- 河川クリックの実効許容範囲（TASK-51）----

Deno.test("RIVER_CLICK_TOLERANCE_PX: ヒットライン半幅 + PICKING_RADIUS_PX の合成で 13px", () => {
  assertEquals(RIVER_CLICK_TOLERANCE_PX, 13);
});

Deno.test("RIVER_CLICK_TOLERANCE_PX: RIVER_HIT_LINE_WIDTH_PX / 2 + PICKING_RADIUS_PX から導出される（片方の定数変更で追従する構造）", () => {
  assertEquals(
    RIVER_CLICK_TOLERANCE_PX,
    RIVER_HIT_LINE_WIDTH_PX / 2 + PICKING_RADIUS_PX,
  );
});

/** テスト用の河川 feature を組み立てる */
function riverFeature(
  name: unknown,
  geometry: Geometry,
): Feature {
  return {
    type: "Feature",
    properties: name === undefined ? {} : { name, scalerank: 3 },
    geometry,
  } as Feature;
}

function fc(features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

// ---- toggleRiverSelection ----

Deno.test("toggleRiverSelection: 未選択から河川クリックで選択される", () => {
  assertEquals(toggleRiverSelection(null, "Rhine"), "Rhine");
});

Deno.test("toggleRiverSelection: 選択中の河川を再クリックで解除される", () => {
  assertEquals(toggleRiverSelection("Rhine", "Rhine"), null);
});

Deno.test("toggleRiverSelection: 別の河川クリックで選択が切り替わる", () => {
  assertEquals(toggleRiverSelection("Rhine", "Danube"), "Danube");
});

Deno.test("toggleRiverSelection: 河川以外（clickedName null）のクリックで解除される", () => {
  assertEquals(toggleRiverSelection("Rhine", null), null);
  assertEquals(toggleRiverSelection(null, null), null);
});

// ---- riverLineColor / riverLineWidth ----

Deno.test("riverLineColor: 未選択時は通常色を返す", () => {
  assertEquals(riverLineColor("Rhine", null), RIVER_LINE_COLOR);
});

Deno.test("riverLineColor: 選択中の河川は強調色を返す", () => {
  assertEquals(riverLineColor("Rhine", "Rhine"), RIVER_SELECTED_LINE_COLOR);
});

Deno.test("riverLineColor: 選択中でも他の河川は通常色のまま", () => {
  assertEquals(riverLineColor("Danube", "Rhine"), RIVER_LINE_COLOR);
});

Deno.test("riverLineColor: name null は選択状態に関わらず通常色", () => {
  assertEquals(riverLineColor(null, null), RIVER_LINE_COLOR);
  assertEquals(riverLineColor(null, "Rhine"), RIVER_LINE_COLOR);
});

Deno.test("riverLineWidth: 未選択時は通常幅、選択中は太くなる", () => {
  assertEquals(riverLineWidth("Rhine", null), RIVER_LINE_WIDTH_PX);
  assertEquals(riverLineWidth("Rhine", "Rhine"), RIVER_SELECTED_LINE_WIDTH_PX);
  assert(
    RIVER_SELECTED_LINE_WIDTH_PX > RIVER_LINE_WIDTH_PX,
    "強調幅は通常幅より太いこと",
  );
});

Deno.test("riverLineWidth: 選択中でも他の河川は通常幅のまま", () => {
  assertEquals(riverLineWidth("Danube", "Rhine"), RIVER_LINE_WIDTH_PX);
  assertEquals(riverLineWidth(null, "Rhine"), RIVER_LINE_WIDTH_PX);
});

// ---- riverLineColor / riverLineWidth: hovered（TASK-42） ----

Deno.test("riverLineColor: ホバー中（未選択）は中間強調色を返す", () => {
  assertEquals(
    riverLineColor("Rhine", null, "Rhine"),
    RIVER_HOVERED_LINE_COLOR,
  );
});

Deno.test("riverLineColor: 選択中の河川にホバーしても選択強調を維持する（AC #3）", () => {
  assertEquals(
    riverLineColor("Rhine", "Rhine", "Rhine"),
    RIVER_SELECTED_LINE_COLOR,
  );
});

Deno.test("riverLineColor: ホバー中でも他の河川は通常色のまま", () => {
  assertEquals(riverLineColor("Danube", null, "Rhine"), RIVER_LINE_COLOR);
});

Deno.test("riverLineColor: hovered が null なら通常色（回帰）", () => {
  assertEquals(riverLineColor("Rhine", null, null), RIVER_LINE_COLOR);
});

Deno.test("riverLineColor: 強調色（ホバー / 選択）は通常色と異なる", () => {
  // 参照比較ではなく値比較で「強調されているか」を担保する（TASK-73 / TASK-91）
  const key = (c: readonly number[]) => c.join(",");
  assert(
    key(RIVER_HOVERED_LINE_COLOR) !== key(RIVER_LINE_COLOR) &&
      key(RIVER_SELECTED_LINE_COLOR) !== key(RIVER_LINE_COLOR),
  );
});

Deno.test("riverLineColor: 選択時の色はホバー時と同一（TASK-91）", () => {
  // クリック（選択）で色相が変わらないこと。段階差は線幅のみが担う。
  assertEquals(RIVER_SELECTED_LINE_COLOR, RIVER_HOVERED_LINE_COLOR);
  assertEquals(
    riverLineColor("Rhine", "Rhine"),
    riverLineColor("Rhine", null, "Rhine"),
  );
});

Deno.test("riverLineWidth: ホバー中（未選択）は中間幅を返す", () => {
  assertEquals(
    riverLineWidth("Rhine", null, "Rhine"),
    RIVER_HOVERED_LINE_WIDTH_PX,
  );
});

Deno.test("riverLineWidth: 選択中の河川にホバーしても選択幅を維持する（AC #3）", () => {
  assertEquals(
    riverLineWidth("Rhine", "Rhine", "Rhine"),
    RIVER_SELECTED_LINE_WIDTH_PX,
  );
});

Deno.test("riverLineWidth: ホバー中でも他の河川は通常幅のまま", () => {
  assertEquals(riverLineWidth("Danube", null, "Rhine"), RIVER_LINE_WIDTH_PX);
});

Deno.test("riverLineWidth: hovered が null なら通常幅（回帰）", () => {
  assertEquals(riverLineWidth("Rhine", null, null), RIVER_LINE_WIDTH_PX);
});

Deno.test("riverLineWidth: 中間幅は通常幅より太く選択幅より細い", () => {
  assert(
    RIVER_HOVERED_LINE_WIDTH_PX > RIVER_LINE_WIDTH_PX &&
      RIVER_HOVERED_LINE_WIDTH_PX < RIVER_SELECTED_LINE_WIDTH_PX,
  );
});

// ---- riverNameFor ----

Deno.test("riverNameFor: name 文字列を返し、欠落・空・非文字列は null", () => {
  assertEquals(riverNameFor({ name: "Elbe" }), "Elbe");
  assertEquals(riverNameFor({}), null);
  assertEquals(riverNameFor({ name: "" }), null);
  assertEquals(riverNameFor({ name: 42 }), null);
  assertEquals(riverNameFor(null), null);
});

// ---- riverLabelAnchors ----

Deno.test("riverLabelAnchors: LineString の中点座標をアンカーにする", () => {
  const data = riverLabelAnchors(fc([
    riverFeature("Rhine", {
      type: "LineString",
      coordinates: [[0, 0], [10, 0]],
    }),
  ]));
  assertEquals(data.length, 1);
  assertEquals(data[0].text, "Rhine");
  assertEquals(data[0].position, [5, 0]);
});

Deno.test("riverLabelAnchors: 中点は頂点間を線形補間する（頂点に丸めない）", () => {
  // 全長 10 の折れ線。中点（距離 5）は 2 頂点目 [4,0] を越えた [5,0]
  const data = riverLabelAnchors(fc([
    riverFeature("Rhine", {
      type: "LineString",
      coordinates: [[0, 0], [4, 0], [10, 0]],
    }),
  ]));
  assertEquals(data[0].position, [5, 0]);
});

Deno.test("riverLabelAnchors: MultiLineString は最長パートの中点を使う", () => {
  const data = riverLabelAnchors(fc([
    riverFeature("Danube", {
      type: "MultiLineString",
      coordinates: [
        [[0, 0], [1, 0]], // 長さ 1
        [[0, 10], [10, 10]], // 長さ 10（最長）
      ],
    }),
  ]));
  assertEquals(data.length, 1);
  assertEquals(data[0].position, [5, 10]);
});

Deno.test("riverLabelAnchors: name の無い feature はラベルを出さない", () => {
  const line: Geometry = { type: "LineString", coordinates: [[0, 0], [1, 0]] };
  const data = riverLabelAnchors(fc([
    riverFeature(undefined, line),
    riverFeature(null, line),
    riverFeature("", line),
    riverFeature("Elbe", line),
  ]));
  assertEquals(data.map((d) => d.text), ["Elbe"]);
});

Deno.test("riverLabelAnchors: LineString/MultiLineString 以外は除外する", () => {
  const data = riverLabelAnchors(fc([
    riverFeature("NotALine", {
      type: "Point",
      coordinates: [0, 0],
    }),
  ]));
  assertEquals(data, []);
});

Deno.test("riverLabelAnchors: priority はライン長に対して単調（長い川を優先）", () => {
  const data = riverLabelAnchors(fc([
    riverFeature("Short", {
      type: "LineString",
      coordinates: [[0, 0], [1, 0]],
    }),
    riverFeature("Long", {
      type: "LineString",
      coordinates: [[0, 0], [10, 0]],
    }),
    riverFeature("Longest", {
      type: "MultiLineString",
      // 合計長 30（10 + 20）。パート分割されても合計長で評価する
      coordinates: [[[0, 0], [10, 0]], [[0, 1], [20, 1]]],
    }),
  ]));
  const byName = new Map(data.map((d) => [d.text, d.priority]));
  assert(byName.get("Long")! > byName.get("Short")!);
  assert(byName.get("Longest")! > byName.get("Long")!);
});

Deno.test("riverLabelAnchors: ja マップで日本語表記になり、未登録は英語のまま", () => {
  const data = riverLabelAnchors(
    fc([
      riverFeature("Rhine", {
        type: "LineString",
        coordinates: [[0, 0], [10, 0]],
      }),
      riverFeature("Oder", {
        type: "LineString",
        coordinates: [[0, 1], [10, 1]],
      }),
    ]),
    { Rhine: "ライン川" },
  );
  assertEquals(data.map((d) => d.text), ["ライン川", "Oder"]);
});

Deno.test("riverLabelAnchors: 突合キーとして元の英語名（name）を保持する（TASK-69）", () => {
  const data = riverLabelAnchors(
    fc([
      riverFeature("Rhine", {
        type: "LineString",
        coordinates: [[0, 0], [10, 0]],
      }),
    ]),
    { Rhine: "ライン川" },
  );
  assertEquals(data[0].name, "Rhine");
  assertEquals(data[0].text, "ライン川");
});

// ---- 都市アンカー回避（TASK-136）----

Deno.test("selectRiverLabelAnchor: 回避点が無ければ中点を返す", () => {
  assertEquals(selectRiverLabelAnchor([[0, 0], [10, 0]], []), [5, 0]);
});

Deno.test("selectRiverLabelAnchor: 中点がクリアランス以上離れていれば中点を維持する（境界含む）", () => {
  // 中点 [5,0] から距離ちょうど RIVER_LABEL_CITY_CLEARANCE_DEG の都市 →
  // 「以上」で中点維持（既に表示できている河川を動かさない側へ倒す）
  const atThreshold: [number, number] = [5, RIVER_LABEL_CITY_CLEARANCE_DEG];
  assertEquals(
    selectRiverLabelAnchor([[0, 0], [10, 0]], [atThreshold]),
    [5, 0],
  );
  // 十分遠い都市でも当然そのまま
  assertEquals(
    selectRiverLabelAnchor([[0, 0], [10, 0]], [[5, 3]]),
    [5, 0],
  );
});

Deno.test("selectRiverLabelAnchor: 中点直上に都市があれば最寄り都市から最も遠い候補点へ動かす", () => {
  // 都市が [5,0]（中点直上）と [10,0]（終端）にある。ライン上の候補点
  // （0.1..0.9 の等分点）のうち最寄り都市距離が最大なのは [1,0]（距離 4）
  const anchor = selectRiverLabelAnchor([[0, 0], [10, 0]], [[5, 0], [10, 0]]);
  assertEquals(anchor, [1, 0]);
});

Deno.test("selectRiverLabelAnchor: 最大クリアランスが同値なら中点に近い側 → 小さい弧長位置の順で決定的に選ぶ", () => {
  // 都市が中点 [5,0] のみ → 候補 [1,0]（frac 0.1）と [9,0]（frac 0.9）が
  // 距離 4 で同率・|frac-0.5| も同じ。弧長位置が小さい [1,0] を選ぶ
  assertEquals(selectRiverLabelAnchor([[0, 0], [10, 0]], [[5, 0]]), [1, 0]);
});

Deno.test("selectRiverLabelAnchor: 決定的（同一入力 → 同一出力）", () => {
  const coords: [number, number][] = [[0, 0], [4, 0], [10, 0]];
  const avoid: [number, number][] = [[5, 0.01], [8, 0.2]];
  assertEquals(
    selectRiverLabelAnchor(coords, avoid),
    selectRiverLabelAnchor(coords, avoid),
  );
});

Deno.test("riverLabelAnchors: avoidPoints 省略・空は従来どおり中点（後方互換）", () => {
  const collection = fc([
    riverFeature("Rhine", {
      type: "LineString",
      coordinates: [[0, 0], [10, 0]],
    }),
  ]);
  assertEquals(riverLabelAnchors(collection)[0].position, [5, 0]);
  assertEquals(riverLabelAnchors(collection, {}, [])[0].position, [5, 0]);
});

Deno.test("riverLabelAnchors: 中点近傍に都市がある feature だけアンカーが動き、離れた feature は動かない", () => {
  const collection = fc([
    riverFeature("Rhine", {
      type: "LineString",
      coordinates: [[0, 0], [10, 0]],
    }),
    riverFeature("Danube", {
      type: "LineString",
      coordinates: [[0, 10], [10, 10]],
    }),
  ]);
  const avoid: [number, number][] = [[5, 0.01]]; // Rhine の中点直上のみ
  const data = riverLabelAnchors(collection, {}, avoid);
  const byName = new Map(data.map((d) => [d.name, d]));
  assert(
    byName.get("Rhine")!.position[0] !== 5,
    "都市直上の Rhine アンカーは動くはず",
  );
  assertEquals(byName.get("Danube")!.position, [5, 10]);
});

Deno.test("riverLabelAnchors: アンカー回避は priority を変えない", () => {
  const collection = fc([
    riverFeature("Rhine", {
      type: "LineString",
      coordinates: [[0, 0], [10, 0]],
    }),
  ]);
  assertEquals(
    riverLabelAnchors(collection, {}, [[5, 0.01]])[0].priority,
    riverLabelAnchors(collection)[0].priority,
  );
});

Deno.test("riverLabelAnchors: 実データでライン川のアンカーが都市から離れ、既表示河川のアンカーは動かない（TASK-136 AC #1/#2）", async () => {
  const rivers = JSON.parse(
    await Deno.readTextFile("data/rivers.geojson"),
  ) as FeatureCollection;
  const cities = JSON.parse(
    await Deno.readTextFile("data/cities.json"),
  ) as CitiesData;
  const avoid = allCityPositions(cities);
  const before = filterVisibleRiverLabels(
    riverLabelAnchors(rivers),
    null,
    null,
    6,
  );
  const after = filterVisibleRiverLabels(
    riverLabelAnchors(rivers, {}, avoid),
    null,
    null,
    6,
  );
  const clearance = (p: readonly number[]) =>
    Math.min(...avoid.map((c) => Math.hypot(c[0] - p[0], c[1] - p[1])));
  const beforeByName = new Map(before.map((d) => [d.name, d]));
  const afterByName = new Map(after.map((d) => [d.name, d]));
  // 都市直上アンカーの回避対象（実データの固定）。#222 の Buringh 併合で
  // 回避対象の都市が約 2,300 件に増え、対象は 2 河川（Rhine / Po）から
  // 6 河川に増えた（移動後クリアランスの実測は 0.131〜0.390°）。
  const avoidedRivers = [
    "Rhine",
    "Nederrijn",
    "Po",
    "Seine",
    "Garonne",
    "Loire",
  ];
  for (const name of avoidedRivers) {
    assert(
      clearance(beforeByName.get(name)!.position) <
        RIVER_LABEL_CITY_CLEARANCE_DEG,
      `前提: 旧 ${name} アンカーは都市直上（クリアランス未満）`,
    );
    const moved = afterByName.get(name)!;
    // #222 の Buringh 併合で回避対象の都市が約 2,300 件（全年代の和集合）に
    // 増え、ライン川沿いで 0.2° 以上空く場所は無くなった。契約はしきい値
    // （RIVER_LABEL_CITY_CLEARANCE_DEG）以上への移動なので、それで検証する。
    assert(
      clearance(moved.position) >= RIVER_LABEL_CITY_CLEARANCE_DEG,
      `新 ${name} アンカーはしきい値以上のクリアランスを持つはず: ${
        clearance(moved.position)
      }`,
    );
  }
  // 既に表示できている河川（クリアランス >= しきい値）は 1 本も動かない
  for (const [name, b] of beforeByName) {
    if (avoidedRivers.includes(name)) continue;
    if (clearance(b.position) >= RIVER_LABEL_CITY_CLEARANCE_DEG) {
      assertEquals(
        afterByName.get(name)!.position,
        b.position,
        `${name} のアンカーが動いた`,
      );
    }
  }
  // 実データでは上記 2 河川以外の表示アンカーは全てしきい値以上（= 動くのは
  // ライン川とポー川だけ）であることも固定する
  for (const [name, b] of beforeByName) {
    if (avoidedRivers.includes(name)) continue;
    assert(
      clearance(b.position) >= RIVER_LABEL_CITY_CLEARANCE_DEG,
      `${name} が回避対象に入った（しきい値の再検討が必要）`,
    );
  }
});

Deno.test("riverLabelAnchors: 回避点込みでもホバー連続移動でアンカー生成は 1 度きり（TASK-50 / TASK-136 AC #4）", () => {
  const collection = fc([
    riverFeature("Rhine", {
      type: "LineString",
      coordinates: [[0, 0], [10, 0]],
    }),
  ]);
  const ja = { Rhine: "ライン川" };
  const avoid: [number, number][] = [[5, 0.01]];
  let calls = 0;
  const memoized = memoizeLatest(
    (f: FeatureCollection, j: typeof ja, a: [number, number][]) => {
      calls++;
      return riverLabelAnchors(f, j, a);
    },
  );
  for (const hovered of ["Rhine", null, "Rhine", null]) {
    filterVisibleRiverLabels(memoized(collection, ja, avoid), hovered, null, 4);
  }
  assertEquals(calls, 1);
});

// 自己衝突対策の不可視背景（TASK-136 の RIVER_LABEL_COLLISION_BACKGROUND_COLOR）
// は TASK-143 で全ラベル層へ一般化され labels.ts へ移した。値の固定は
// labels_test.ts（LABEL_COLLISION_BACKGROUND_COLOR / labelCollisionBackgroundProps）
// が担う。

// ---- filterVisibleRiverLabels（TASK-69）----

/** テスト用のアンカー（表示テキストは日本語、突合キーは英語名） */
function anchor(
  name: string,
  priority = 0,
  position: [number, number] = [0, 0],
): RiverLabelDatum {
  return { name, text: `${name}川`, position, priority };
}

Deno.test("filterVisibleRiverLabels: ホバーも選択も無ければしきい値未満は 1 つも表示しない", () => {
  // anchor() の priority 既定値 0 は z4 のしきい値（70）未満
  const anchors = [anchor("Rhine"), anchor("Danube")];
  assertEquals(filterVisibleRiverLabels(anchors, null, null, 4), []);
});

Deno.test("filterVisibleRiverLabels: ホバー中の河川だけを表示する", () => {
  const anchors = [anchor("Rhine"), anchor("Danube")];
  assertEquals(
    filterVisibleRiverLabels(anchors, "Danube", null, 4).map((d) => d.name),
    ["Danube"],
  );
});

Deno.test("filterVisibleRiverLabels: 選択中の河川だけを表示する（ホバーなしでも残る）", () => {
  const anchors = [anchor("Rhine"), anchor("Danube")];
  assertEquals(
    filterVisibleRiverLabels(anchors, null, "Rhine", 4).map((d) => d.name),
    ["Rhine"],
  );
});

Deno.test("filterVisibleRiverLabels: 選択中に別の河川をホバーすると両方表示する", () => {
  const anchors = [anchor("Rhine"), anchor("Danube"), anchor("Elbe")];
  assertEquals(
    filterVisibleRiverLabels(anchors, "Elbe", "Rhine", 4).map((d) => d.name),
    ["Rhine", "Elbe"],
  );
});

Deno.test("filterVisibleRiverLabels: 選択中の河川をホバーしてもラベルは 1 つ", () => {
  const anchors = [anchor("Rhine"), anchor("Danube")];
  assertEquals(
    filterVisibleRiverLabels(anchors, "Rhine", "Rhine", 4).map((d) => d.name),
    ["Rhine"],
  );
});

Deno.test("filterVisibleRiverLabels: 同名の feature が複数あってもラベルは 1 つ（最長 = 最高 priority を採用）", () => {
  const anchors = [
    anchor("Rhine", 10, [1, 1]),
    anchor("Rhine", 30, [2, 2]),
    anchor("Rhine", 20, [3, 3]),
  ];
  const visible = filterVisibleRiverLabels(anchors, "Rhine", null, 4);
  assertEquals(visible.length, 1);
  assertEquals(visible[0].position, [2, 2]);
});

Deno.test("filterVisibleRiverLabels: 未知の名前は無視する（該当なしなら空）", () => {
  const anchors = [anchor("Rhine")];
  assertEquals(filterVisibleRiverLabels(anchors, "Nile", "Amazon", 4), []);
});

Deno.test("filterVisibleRiverLabels: 入力配列を破壊せず、同一 datum 参照をそのまま返す（アンカー再計算なし）", () => {
  const anchors = [anchor("Rhine"), anchor("Danube")];
  const snapshot = [...anchors];
  const visible = filterVisibleRiverLabels(anchors, "Rhine", null, 4);
  assertEquals(anchors, snapshot);
  assert(visible[0] === anchors[0]);
});

Deno.test("filterVisibleRiverLabels: ホバー連続移動でもアンカー生成は 1 度きり（TASK-50 非退行）", () => {
  const collection = fc([
    riverFeature("Rhine", {
      type: "LineString",
      coordinates: [[0, 0], [10, 0]],
    }),
    riverFeature("Danube", {
      type: "LineString",
      coordinates: [[0, 1], [10, 1]],
    }),
  ]);
  const ja = { Rhine: "ライン川" };
  let calls = 0;
  // main.ts の memoizedRiverLabelData と同じ構造（引数は起動時ロード済みの
  // riversData / nameJa 参照で、hover/selection には依存しない）
  const memoized = memoizeLatest((f: FeatureCollection, j: typeof ja) => {
    calls++;
    return riverLabelAnchors(f, j);
  });
  const hovers = ["Rhine", "Danube", null, "Rhine", "Danube", null];
  for (const hovered of hovers) {
    filterVisibleRiverLabels(memoized(collection, ja), hovered, "Danube", 4);
  }
  assertEquals(calls, 1);
});

// ---- ズーム段による常時表示の出し分け（TASK-123）----

Deno.test("riverLabelMinPriority: z4 以下は大河のみ（しきい値 70）", () => {
  assertEquals(riverLabelMinPriority(4), 70);
  // MIN_ZOOM=4 だが maxBounds クランプ等の防御込みで下も同じ
  assertEquals(riverLabelMinPriority(3), 70);
  assertEquals(riverLabelMinPriority(0), 70);
});

Deno.test("riverLabelMinPriority: 小数ズームは整数段へ切り捨てて判定する", () => {
  assertEquals(riverLabelMinPriority(4.99), 70);
  assertEquals(riverLabelMinPriority(5.0), riverLabelMinPriority(5.9));
});

Deno.test("riverLabelMinPriority: z5 は中規模の河川まで解禁（しきい値 30）", () => {
  assertEquals(riverLabelMinPriority(5), 30);
});

Deno.test("riverLabelMinPriority: z6 以上は全河川（priority 下限まで解禁）", () => {
  assertEquals(riverLabelMinPriority(6), MIN_LABEL_PRIORITY);
  assertEquals(riverLabelMinPriority(8), MIN_LABEL_PRIORITY);
});

Deno.test("riverLabelMinPriority: ズームに対して単調非増加（ズームインで減ることはあっても増えない）", () => {
  let prev = riverLabelMinPriority(0);
  for (let z = 1; z <= 12; z++) {
    const threshold = riverLabelMinPriority(z);
    assert(threshold <= prev, `z=${z} でしきい値が増えた`);
    prev = threshold;
  }
});

Deno.test("riverLabelMinPriority: 非有限ズーム（NaN 等）は最も保守的な z4 しきい値へフォールバック", () => {
  assertEquals(riverLabelMinPriority(Number.NaN), 70);
  assertEquals(riverLabelMinPriority(Number.NEGATIVE_INFINITY), 70);
});

Deno.test("filterVisibleRiverLabels: ホバー/選択なしでも priority がしきい値以上なら常時表示（TASK-123）", () => {
  const anchors = [anchor("Danube", 125), anchor("Lek", 11)];
  assertEquals(
    filterVisibleRiverLabels(anchors, null, null, 4).map((d) => d.name),
    ["Danube"],
  );
});

Deno.test("filterVisibleRiverLabels: しきい値ちょうどは表示・1 未満は非表示（境界）", () => {
  const anchors = [anchor("AtThreshold", 70), anchor("BelowThreshold", 69)];
  assertEquals(
    filterVisibleRiverLabels(anchors, null, null, 4).map((d) => d.name),
    ["AtThreshold"],
  );
});

Deno.test("filterVisibleRiverLabels: ズーム段が上がると表示が段階的に増える", () => {
  const anchors = [
    anchor("Danube", 125),
    anchor("Svir", 34),
    anchor("Nederrijn", -13),
  ];
  assertEquals(
    filterVisibleRiverLabels(anchors, null, null, 4).map((d) => d.name),
    ["Danube"],
  );
  assertEquals(
    filterVisibleRiverLabels(anchors, null, null, 5).map((d) => d.name),
    ["Danube", "Svir"],
  );
  assertEquals(
    filterVisibleRiverLabels(anchors, null, null, 6).map((d) => d.name),
    ["Danube", "Svir", "Nederrijn"],
  );
});

Deno.test("filterVisibleRiverLabels: ホバー中はしきい値未満でも必ず表示する（AC #3 非退行）", () => {
  const anchors = [anchor("Danube", 125), anchor("Lek", 11)];
  assertEquals(
    filterVisibleRiverLabels(anchors, "Lek", null, 4).map((d) => d.name),
    ["Danube", "Lek"],
  );
});

Deno.test("filterVisibleRiverLabels: 選択中はしきい値未満でも必ず表示する（AC #3 非退行）", () => {
  const anchors = [anchor("Danube", 125), anchor("Waal", 2)];
  assertEquals(
    filterVisibleRiverLabels(anchors, null, "Waal", 4).map((d) => d.name),
    ["Danube", "Waal"],
  );
});

Deno.test("filterVisibleRiverLabels: 常時表示でも同名 feature のラベルは 1 つ（最高 priority を採用）", () => {
  const anchors = [
    anchor("Rhine", 75, [1, 1]),
    anchor("Rhine", 74, [2, 2]),
    anchor("Danube", 125, [3, 3]),
  ];
  const visible = filterVisibleRiverLabels(anchors, null, null, 4);
  assertEquals(visible.map((d) => d.name), ["Rhine", "Danube"]);
  assertEquals(visible[0].position, [1, 1]);
});

Deno.test("filterVisibleRiverLabels: 実データの z4 でライン川・ドナウ川・ロワール川が常時表示される（AC #1）", async () => {
  const fc = JSON.parse(
    await Deno.readTextFile("data/rivers.geojson"),
  ) as FeatureCollection;
  const anchors = riverLabelAnchors(fc);
  const at = (zoom: number) =>
    filterVisibleRiverLabels(anchors, null, null, zoom).map((d) => d.name);
  const z4 = at(4);
  for (const name of ["Rhine", "Danube", "Loire"]) {
    assert(z4.includes(name), `z4 に ${name} が無い: ${z4.join(", ")}`);
  }
  // 段階的に増える（AC #2）: z4 ⊂ z5 ⊂ z6、z6 は同名集約後の全河川
  const z5 = at(5);
  const z6 = at(6);
  assert(z4.length < z5.length && z5.length < z6.length);
  assert(z4.every((name) => z5.includes(name)));
  assert(z5.every((name) => z6.includes(name)));
  assertEquals(z6.length, new Set(anchors.map((a) => a.name)).size);
});

Deno.test("riverLabelColor: 選択 > ホバー > 通常の優先度で強調色を返す（TASK-123）", () => {
  // ライン（riverLineColor）と同じ英語名突合。選択中・ホバー中は強調色、
  // それ以外の常時表示ラベルは通常色
  assertEquals(riverLabelColor("Rhine", "Rhine", null), [
    ...ACTIVE_RIVER_LABEL_COLOR,
  ]);
  assertEquals(riverLabelColor("Rhine", null, "Rhine"), [
    ...ACTIVE_RIVER_LABEL_COLOR,
  ]);
  assertEquals(riverLabelColor("Rhine", null, null), [...RIVER_LABEL_COLOR]);
  assertEquals(riverLabelColor("Rhine", "Danube", "Elbe"), [
    ...RIVER_LABEL_COLOR,
  ]);
});

// ---- 定数（basemap.ts からの移設契約） ----

Deno.test("RIVERS_DATA_URL は scripts 側の生成物パスと一致する", () => {
  assertEquals(RIVERS_DATA_URL, "/data/rivers.geojson");
});

// --- TASK-44: ベースマップ川ライン除外に伴う視認性の底上げ ---

Deno.test("RIVER_LINE_WIDTH_PX は 3 以上（唯一の川表示としての視認性, TASK-44）", () => {
  assert(RIVER_LINE_WIDTH_PX >= 3);
});

// ---- TASK-73: 羊皮紙/古地図トーンへの配色統一 ----
// ベースマップ（basemap.ts PARCHMENT_FLAVOR_OVERRIDES）が羊皮紙トーンになった
// ため、light flavor の water（#80deea）由来だった水色系の 3 状態を、青灰 +
// 朱（--wax）の古地図配色へ置き換える。3 状態の識別（TASK-42 AC）は退行させない。

/** HSV 相当の彩度（0..1）。0 に近いほど無彩色 */
function saturation([r, g, b]: Rgba): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

/** sRGB の相対輝度（0..255 の近似。3 状態の明度差の比較に使う） */
function luminance([r, g, b]: Rgba): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

Deno.test("RIVER_LINE_COLOR は青灰系（低彩度・寒色寄り）で不透明", () => {
  assertEquals(RIVER_LINE_COLOR, [148, 168, 176, 255]);
  assert(
    saturation(RIVER_LINE_COLOR) < 0.3,
    `通常色 ${RIVER_LINE_COLOR} は低彩度（シアンではない）はず`,
  );
  assert(
    RIVER_LINE_COLOR[2] > RIVER_LINE_COLOR[0],
    "青が赤より強い（寒色寄り）",
  );
  assertEquals(RIVER_LINE_COLOR[3], 255);
});

Deno.test("RIVER_HOVERED_LINE_COLOR は通常色と同系の青灰で、より暗い中間強調", () => {
  assertEquals(RIVER_HOVERED_LINE_COLOR, [74, 106, 122, 255]);
  assert(
    RIVER_HOVERED_LINE_COLOR[2] > RIVER_HOVERED_LINE_COLOR[0],
    "ホバー色も寒色寄り（通常色と同系）",
  );
  assert(
    luminance(RIVER_HOVERED_LINE_COLOR) < luminance(RIVER_LINE_COLOR),
    "ホバー色は通常色より暗く、下地の羊皮紙上で明確に強調される",
  );
  assertEquals(RIVER_HOVERED_LINE_COLOR[3], 255);
});

Deno.test("RIVER_SELECTED_LINE_COLOR はホバー色と同一の濃い青灰（TASK-91）", () => {
  // #4a6a7a。クリックによる色相変化は廃止し、選択の区別は線幅が担う
  assertEquals(RIVER_SELECTED_LINE_COLOR, [74, 106, 122, 255]);
  assert(
    RIVER_SELECTED_LINE_COLOR[2] > RIVER_SELECTED_LINE_COLOR[0],
    "選択色も寒色寄り（通常/ホバーと同系の青灰）",
  );
  assert(
    luminance(RIVER_SELECTED_LINE_COLOR) < luminance(RIVER_LINE_COLOR),
    "選択色は通常色より暗く、下地の羊皮紙上で明確に強調される",
  );
  assertEquals(RIVER_SELECTED_LINE_COLOR[3], 255);
});

Deno.test("河川 3 状態はいずれも羊皮紙下地（#f0e6cd 相当）より十分暗く視認できる", () => {
  // 下地 earth #f0e6cd の近似輝度
  const earthLuminance = luminance([240, 230, 205, 255]);
  for (
    const color of [
      RIVER_LINE_COLOR,
      RIVER_HOVERED_LINE_COLOR,
      RIVER_SELECTED_LINE_COLOR,
    ]
  ) {
    assert(
      earthLuminance - luminance(color) > 60,
      `${color} は羊皮紙下地に対して十分な明度差を持つはず`,
    );
  }
});
