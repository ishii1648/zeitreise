import { assert, assertEquals } from "@std/assert";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import { MAX_ZOOM, MIN_ZOOM } from "./config.ts";
import {
  filterVisibleMountainLabels,
  isMountainActive,
  MOUNTAIN_HIGHLIGHT_COLOR,
  MOUNTAIN_HIT_FILL_COLOR,
  MOUNTAIN_HIT_LAYER_ID,
  MOUNTAIN_HIT_RADIUS_PX,
  MOUNTAIN_LABEL_PRIORITY_MAX,
  MOUNTAIN_LABEL_PRIORITY_MIN,
  mountainDisplayName,
  mountainHitData,
  mountainLabelAnchors,
  mountainLabelMinZoom,
  mountainLabelPriority,
  mountainOutlineColor,
  mountainOutlineWidth,
  mountainPickLabel,
  MOUNTAINS_DATA_URL,
  toggleMountainSelection,
} from "./mountains.ts";
import { CITY_HIT_RADIUS_PX, CITY_LABEL_PRIORITY_MIN } from "./cities.ts";
import { MOUNTAIN_LABEL_COLOR, MOUNTAIN_LABEL_SIZE_PX } from "./labels.ts";
import { RIVER_SELECTED_LINE_COLOR } from "./rivers.ts";
import { ACTIVE_FILL_COLOR } from "./power_highlight.ts";

/** テスト用に矩形 Polygon の Feature を組み立てる */
function boxFeature(
  properties: Record<string, unknown>,
  [west, south, east, north]: [number, number, number, number],
): Feature<Polygon> {
  return {
    type: "Feature",
    properties,
    geometry: {
      type: "Polygon",
      coordinates: [[
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ]],
    },
  };
}

function collection(features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

Deno.test("MOUNTAINS_DATA_URL は build.ts のコピー先と一致する", () => {
  assertEquals(MOUNTAINS_DATA_URL, "/data/mountains.geojson");
});

Deno.test("mountainLabelMinZoom は NE の MIN_LABEL をアプリのズーム段へ写す（AC #2）", () => {
  // 小数の MIN_LABEL は切り上げ（その段でラベルが確実に読める側へ倒す）
  assertEquals(mountainLabelMinZoom(5.3), 6);
  assertEquals(mountainLabelMinZoom(3.5), 4);
  assertEquals(mountainLabelMinZoom(4), 4);
  assertEquals(mountainLabelMinZoom(6), 6);
  // アプリのズーム範囲（MIN_ZOOM..MAX_ZOOM）へクランプする
  assertEquals(mountainLabelMinZoom(2), MIN_ZOOM);
  assertEquals(mountainLabelMinZoom(0), MIN_ZOOM);
  assertEquals(mountainLabelMinZoom(12), MAX_ZOOM);
  // 欠損・非数値は最も保守的（最大ズームでのみ表示）に倒す
  assertEquals(mountainLabelMinZoom(null), MAX_ZOOM);
  assertEquals(mountainLabelMinZoom("4"), MAX_ZOOM);
});

Deno.test("mountainLabelPriority は SCALERANK が小さい（主要な）山脈ほど高い", () => {
  assertEquals(mountainLabelPriority(1), MOUNTAIN_LABEL_PRIORITY_MAX);
  assert(mountainLabelPriority(1) > mountainLabelPriority(3));
  assert(mountainLabelPriority(3) > mountainLabelPriority(4));
  assertEquals(mountainLabelPriority(99), MOUNTAIN_LABEL_PRIORITY_MIN);
  assertEquals(mountainLabelPriority(null), MOUNTAIN_LABEL_PRIORITY_MIN);
});

Deno.test("山脈ラベルの優先度帯は都市ラベル帯より下・小領邦の面積由来 priority より上（AC #1/#3）", () => {
  // 都市名・大国名には譲る
  assert(MOUNTAIN_LABEL_PRIORITY_MAX < CITY_LABEL_PRIORITY_MIN);
  // 公領・伯領規模（面積 6 deg² = 100*log10(6) ≒ 78）の勢力名には勝つ。
  // ここを下回ると密集地帯で山脈名が 1 つも残らない（実機で確認済み）
  assert(MOUNTAIN_LABEL_PRIORITY_MIN > 100 * Math.log10(6));
});

Deno.test("mountainLabelAnchors はポリゴン内部にアンカーを置き、日本語名を引く", () => {
  const fc = collection([
    boxFeature({ name: "ALPS", scalerank: 1, min_label: 2 }, [4, 44, 16, 48]),
  ]);

  const [datum] = mountainLabelAnchors(fc, { ALPS: "アルプス山脈" });

  assertEquals(datum.name, "ALPS");
  assertEquals(datum.text, "アルプス山脈");
  assert(datum.position[0] > 4 && datum.position[0] < 16);
  assert(datum.position[1] > 44 && datum.position[1] < 48);
  assertEquals(datum.minZoom, MIN_ZOOM);
  assertEquals(datum.priority, MOUNTAIN_LABEL_PRIORITY_MAX);
});

Deno.test("mountainLabelAnchors は日本語名が無ければ元名のまま返す", () => {
  const fc = collection([
    boxFeature({ name: "S. Nevada", scalerank: 4, min_label: 5.3 }, [
      -4,
      36,
      -2,
      37,
    ]),
  ]);

  assertEquals(mountainLabelAnchors(fc).map((d) => d.text), ["S. Nevada"]);
});

Deno.test("mountainLabelAnchors は name 欠損・ポリゴンでない feature を除外する", () => {
  const fc = collection([
    boxFeature({ scalerank: 1, min_label: 2 }, [0, 40, 1, 41]),
    {
      type: "Feature",
      properties: { name: "line", scalerank: 1, min_label: 2 },
      geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
    },
    boxFeature({ name: "ok", scalerank: 1, min_label: 2 }, [0, 40, 1, 41]),
  ]);

  assertEquals(mountainLabelAnchors(fc).map((d) => d.name), ["ok"]);
});

Deno.test("mountainLabelAnchors は MultiPolygon で最大のポリゴンにアンカーを置く", () => {
  const fc = collection([{
    type: "Feature",
    properties: { name: "Dinaric Alps", scalerank: 4, min_label: 5.3 },
    geometry: {
      type: "MultiPolygon",
      coordinates: [
        // 小さな島（0.01 deg²）
        [[[30, 60], [30.1, 60], [30.1, 60.1], [30, 60.1], [30, 60]]],
        // 本体（4 deg²）
        [[[14, 43], [16, 43], [16, 45], [14, 45], [14, 43]]],
      ],
    },
  }]);

  const [datum] = mountainLabelAnchors(fc);

  assert(datum.position[0] > 14 && datum.position[0] < 16);
  assert(datum.position[1] > 43 && datum.position[1] < 45);
});

Deno.test("filterVisibleMountainLabels はズーム段が minZoom 以上のラベルだけ返す（AC #2）", () => {
  const fc = collection([
    boxFeature({ name: "ALPS", scalerank: 1, min_label: 2 }, [4, 44, 16, 48]),
    boxFeature({ name: "Balkan Mts.", scalerank: 4, min_label: 5.3 }, [
      22,
      42,
      28,
      43,
    ]),
    boxFeature({ name: "Sierra Morena", scalerank: 4, min_label: 6 }, [
      -7,
      38,
      -3,
      39,
    ]),
  ]);
  const anchors = mountainLabelAnchors(fc);

  assertEquals(filterVisibleMountainLabels(anchors, 4).map((d) => d.name), [
    "ALPS",
  ]);
  assertEquals(filterVisibleMountainLabels(anchors, 5.9).map((d) => d.name), [
    "ALPS",
  ]);
  assertEquals(filterVisibleMountainLabels(anchors, 6).map((d) => d.name), [
    "ALPS",
    "Balkan Mts.",
    "Sierra Morena",
  ]);
  // 非有限ズーム（防御）は最遠段として扱う
  assertEquals(filterVisibleMountainLabels(anchors, NaN).map((d) => d.name), [
    "ALPS",
  ]);
});

Deno.test("filterVisibleMountainLabels は入力配列を破壊せず、datum の参照をそのまま返す（メモ化の契約）", () => {
  const fc = collection([
    boxFeature({ name: "ALPS", scalerank: 1, min_label: 2 }, [4, 44, 16, 48]),
  ]);
  const anchors = mountainLabelAnchors(fc);

  const visible = filterVisibleMountainLabels(anchors, 8);

  assertEquals(anchors.length, 1);
  assert(visible[0] === anchors[0]);
});

// ---- ホバー/クリック対象化（TASK-100）----

Deno.test("MOUNTAIN_HIT_LAYER_ID: 判定専用層の ID は cities-hit / rivers-hit と同じ命名（TASK-100）", () => {
  assertEquals(MOUNTAIN_HIT_LAYER_ID, "mountains-hit");
});

Deno.test("MOUNTAIN_HIT_RADIUS_PX: 都市の判定円より広い（山脈は常時可視の点記号を持たないため）（TASK-100 AC #1）", () => {
  assert(MOUNTAIN_HIT_RADIUS_PX > CITY_HIT_RADIUS_PX);
  // ラベル（MOUNTAIN_LABEL_SIZE_PX）の高さ全体を余裕をもって覆う
  assert(MOUNTAIN_HIT_RADIUS_PX >= MOUNTAIN_LABEL_SIZE_PX);
  // 判定専用層なので見た目には出さない（完全透明）
  assertEquals([...MOUNTAIN_HIT_FILL_COLOR], [0, 0, 0, 0]);
});

Deno.test("mountainDisplayName: name-ja.json を引き、未登録は英語のまま（TASK-100 AC #1）", () => {
  const ja = { ALPS: "アルプス山脈" };
  assertEquals(mountainDisplayName("ALPS", ja), "アルプス山脈");
  assertEquals(mountainDisplayName("PYRENEES", ja), "PYRENEES");
  assertEquals(mountainDisplayName("ALPS"), "ALPS");
});

Deno.test("mountainPickLabel: 情報パネルに出すのは山脈名のみ（標高等を足さない）（TASK-100 AC #1/#6）", () => {
  const ja = { ALPS: "アルプス山脈" };
  assertEquals(mountainPickLabel({ name: "ALPS" }, ja), "アルプス山脈");
  assertEquals(mountainPickLabel({ name: "Balkan Mts." }, ja), "Balkan Mts.");
});

Deno.test("mountainPickLabel: 年代に依存しない（年代引数を取らず、同じ入力なら常に同じ表示）（TASK-100 AC #5）", () => {
  const ja = { ALPS: "アルプス山脈" };
  // 山脈は年代非依存の地形なので、ラベル整形は (datum, ja) だけの純粋関数。
  // 引数に年が無いこと自体が「年代切替で内容が変わらない」ことの担保になる
  assertEquals(mountainPickLabel.length, 2);
  const first = mountainPickLabel({ name: "ALPS" }, ja);
  assertEquals(mountainPickLabel({ name: "ALPS" }, ja), first);
});

Deno.test("mountainHitData: 表示中の山脈ラベルと同じアンカー・同じズーム条件で作られる（TASK-100 AC #1）", () => {
  const fc = collection([
    boxFeature({ name: "ALPS", scalerank: 1, min_label: 2 }, [4, 44, 16, 48]),
    boxFeature({ name: "Sierra Morena", scalerank: 4, min_label: 6 }, [
      -7,
      37,
      -3,
      39,
    ]),
  ]);
  const anchors = mountainLabelAnchors(fc);

  // ズーム段ごとの取捨はラベルと完全に一致する（見えていない山脈は拾えない）
  assertEquals(mountainHitData(anchors, 4).map((d) => d.name), ["ALPS"]);
  assertEquals(mountainHitData(anchors, 6).map((d) => d.name), [
    "ALPS",
    "Sierra Morena",
  ]);
  // datum の参照はそのまま（main.ts 側のメモ化を壊さない）
  assert(mountainHitData(anchors, 8)[0] === anchors[0]);
});

Deno.test("toggleMountainSelection: 同一で解除・別で移動・対象外クリックで解除（河川/勢力と同一規則）（TASK-100 AC #4）", () => {
  assertEquals(toggleMountainSelection(null, "ALPS"), "ALPS");
  assertEquals(toggleMountainSelection("ALPS", "ALPS"), null);
  assertEquals(toggleMountainSelection("ALPS", "PYRENEES"), "PYRENEES");
  assertEquals(toggleMountainSelection("ALPS", null), null);
  assertEquals(toggleMountainSelection(null, null), null);
});

Deno.test("isMountainActive: 選択中またはホバー中で true（キー null は決してアクティブにしない）（TASK-100 AC #4）", () => {
  assert(isMountainActive("ALPS", "ALPS", null));
  assert(isMountainActive("ALPS", null, "ALPS"));
  assert(!isMountainActive("ALPS", "PYRENEES", "URAL MOUNTAINS"));
  assert(!isMountainActive(null, null, null));
});

Deno.test("mountainOutlineColor / mountainOutlineWidth: 強調時だけ輪郭が出る（通常は完全透明・幅 0）（TASK-100 AC #4）", () => {
  const props = { name: "ALPS" };
  // 通常表示は完全透明（勢力の塗りの上に余計な線を足さない）
  assertEquals(mountainOutlineColor(props, null, null)[3], 0);
  assertEquals(mountainOutlineWidth(props, null, null), 0);
  // ホバー・選択のいずれでも同じ色（河川と同じ「色は 2 値・幅で段階を付ける」設計）
  assertEquals(
    [...mountainOutlineColor(props, null, "ALPS")],
    [...MOUNTAIN_HIGHLIGHT_COLOR],
  );
  assertEquals(
    [...mountainOutlineColor(props, "ALPS", null)],
    [...MOUNTAIN_HIGHLIGHT_COLOR],
  );
  // 選択はホバーより太い（選択 > ホバー > 通常）
  assert(
    mountainOutlineWidth(props, "ALPS", null) >
      mountainOutlineWidth(props, null, "ALPS"),
  );
  assert(mountainOutlineWidth(props, null, "ALPS") > 0);
  // name を持たない feature は決して強調されない
  assertEquals(mountainOutlineColor({ name: null }, null, null)[3], 0);
});

/** [r,g,b] の色相（度）。彩度 0（無彩色）は 0 を返す（power_highlight_test.ts と同一） */
function hueDeg([r, g, b]: readonly number[]): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  const h = max === r
    ? ((g - b) / d) % 6
    : max === g
    ? (b - r) / d + 2
    : (r - g) / d + 4;
  return ((h * 60) % 360 + 360) % 360;
}

/** 円環上の色相差（0..180 度） */
function hueDistance(a: readonly number[], b: readonly number[]): number {
  const diff = Math.abs(hueDeg(a) - hueDeg(b)) % 360;
  return diff > 180 ? 360 - diff : diff;
}

Deno.test("MOUNTAIN_HIGHLIGHT_COLOR: 既存 4 種の強調色と色相が 60 度以上離れている（TASK-100 AC #4）", () => {
  const others: Record<string, readonly number[]> = {
    // 河川の選択/ホバー強調（rivers.ts）
    "河川強調": RIVER_SELECTED_LINE_COLOR,
    // 勢力・領邦のアクティブ塗り（power_highlight.ts）
    "勢力アクティブ塗り": ACTIVE_FILL_COLOR,
    // HRE 帝国範囲の外縁（main.ts HRE_EXTENT_LINE_COLOR）。定数は DOM 依存の
    // main.ts にあるためリテラルで固定する（power_highlight_test.ts と同じ扱い）
    "HRE 外縁の臙脂": [140, 30, 30],
    // 諸侯領内部境界のインク（political_layers.ts FIEF_BORDER_INK）
    "諸侯領境界の藍紫": [74, 42, 130],
  };
  for (const [label, other] of Object.entries(others)) {
    const distance = hueDistance(MOUNTAIN_HIGHLIGHT_COLOR, other);
    assert(distance >= 60, `${label} と色相が近すぎる: ${distance} 度`);
  }
});

Deno.test("MOUNTAIN_HIGHLIGHT_COLOR: 山脈名ラベルの苔緑（通常時の地形色）とも読み分けられる（TASK-100 AC #4）", () => {
  // 同じ「地形」系統だが、強調は通常時と一目で区別できる必要がある
  assert(hueDistance(MOUNTAIN_HIGHLIGHT_COLOR, MOUNTAIN_LABEL_COLOR) >= 30);
});
