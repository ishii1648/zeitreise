import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStrictEquals,
} from "@std/assert";
import type { Feature, FeatureCollection, Position } from "geojson";
import {
  ACTIVE_RIVER_LABEL_COLOR,
  buildLabelData,
  buildTopPoliticalLabelData,
  characterSetFrom,
  CITY_LABEL_COLOR,
  CITY_LABEL_SIZE_PX,
  COLLISION_SIZE_SCALE,
  FIEF_LABEL_COLOR,
  FIEF_LABEL_MIN_ZOOM,
  fiefLabelsVisibleAt,
  filterPoliticalLabelsByGroup,
  filterPowerLabelsByFocus,
  filterPowerLabelsByZoom,
  HRE_SUZERAIN_NAME,
  isHreSuzerainFeature,
  LABEL_COLLISION_BACKGROUND_COLOR,
  LABEL_COLLISION_FADE_CUTOFF,
  LABEL_COLLISION_INJECT_HOOK,
  LABEL_FONT_FAMILY,
  LABEL_FONT_SETTINGS,
  LABEL_OUTLINE_COLOR,
  LABEL_OUTLINE_WIDTH,
  LABEL_SDF_RADIUS,
  labelAnchorFor,
  labelCollisionBackgroundProps,
  labelCollisionCutoffInject,
  labelPriorityFor,
  labelTextFor,
  labelTextStyleProps,
  MAX_LABEL_PRIORITY,
  MIN_LABEL_COLLISION_FADE_CUTOFF,
  MIN_LABEL_PRIORITY,
  MOUNTAIN_LABEL_COLOR,
  OVERVIEW_POWER_LABEL_SIZE_PX,
  partitionFiefsBySuzerain,
  politicalDetailVisibleAt,
  POWER_LABEL_SIZE_PX,
  RIVER_LABEL_COLOR,
  RIVER_LABEL_SIZE_PX,
} from "./labels.ts";
import type { LabelDatum } from "./labels.ts";
import {
  ACTIVE_POLITICAL_LABEL_COLOR,
  labelHaloWidthPx,
  MID_LEVEL_MIN_AREA_PRIORITY,
  POLITICAL_DETAIL_MIN_ZOOM,
  POLITICAL_LABEL_COLOR,
  POLITICAL_LABEL_FONT_SETTINGS,
  POLITICAL_LABEL_HALO_COLOR,
  POLITICAL_LABEL_PLATE_BORDER_COLOR,
  POLITICAL_LABEL_PLATE_BORDER_WIDTH_PX,
  POLITICAL_LABEL_PLATE_COLOR,
  POLITICAL_LABEL_STYLES,
  politicalDisplayLevel,
  politicalLabelGroupOf,
  politicalLabelRenderSpecTable,
  politicalLabelStyleFor,
  politicalLabelTier,
  politicalOverlayTier,
  powerLabelSizePx,
  SDF_ATLAS_FONT_SIZE_PX,
  SDF_GLYPH_EDGE_VALUE,
  SUB_POWER_LABEL_SIZE_PX,
  tieredLabelPriority,
  TOP_POWER_LABEL_SIZE_PX,
} from "./labels.ts";
import { MAX_ZOOM, MIN_ZOOM } from "./config.ts";
import { colorKeyFor } from "./powers.ts";

/** テスト用の Feature を組み立てる */
function feature(
  geometry: Feature["geometry"] | null,
  properties: Feature["properties"] = { NAME: "Testland" },
): Feature {
  return {
    type: "Feature",
    properties,
    geometry: geometry as Feature["geometry"],
  };
}

/** 正方形の外環リング（反時計回り・閉環） */
function squareRing(x: number, y: number, size: number): Position[] {
  return [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
    [x, y],
  ];
}

/**
 * ray casting による点のポリゴン内判定（外環のみ・テスト検証用）。
 * 境界上の点は扱わない前提（テストデータは内部に十分な余白を持たせる）。
 */
function pointInRing(point: [number, number], ring: Position[]): boolean {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = (yi > py) !== (yj > py) &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// ---- labelTextFor ----

Deno.test("labelTextFor は NAME をそのまま返す", () => {
  assertEquals(labelTextFor({ NAME: "France" }), "France");
});

Deno.test("labelTextFor は属領（SUBJECTO≠NAME）でも NAME のみを返す", () => {
  // 宗主国込みの表記（"NAME — SUBJECTO 領"）はツールチップの displayLabel に
  // 委ね、地図上の常時ラベルは NAME のみとする方針（info.ts と矛盾しない）
  assertEquals(
    labelTextFor({ NAME: "Granada", SUBJECTO: "Castille" }),
    "Granada",
  );
});

// TASK-23: 日本語表記マップ（ja）の適用
Deno.test("labelTextFor は ja マップで NAME を日本語化する", () => {
  assertEquals(
    labelTextFor({ NAME: "France" }, { France: "フランス王国" }),
    "フランス王国",
  );
});

Deno.test("labelTextFor は ja に無い NAME を英語のままフォールバックする", () => {
  assertEquals(
    labelTextFor({ NAME: "Wales" }, { France: "フランス王国" }),
    "Wales",
  );
});

Deno.test("labelTextFor は ja を省略すると従来どおり NAME を返す", () => {
  assertEquals(labelTextFor({ NAME: "France" }), "France");
});

Deno.test("labelTextFor は NAME が null・空文字・欠落なら null を返す", () => {
  assertEquals(labelTextFor({ NAME: null }), null);
  assertEquals(labelTextFor({ NAME: "" }), null);
  assertEquals(labelTextFor({}), null);
  assertEquals(labelTextFor(null), null);
});

// ---- labelAnchorFor ----

Deno.test("labelAnchorFor は正方形 Polygon の中心付近を返す", () => {
  const f = feature({
    type: "Polygon",
    coordinates: [squareRing(0, 0, 10)],
  });
  const anchor = labelAnchorFor(f);
  assert(anchor !== null);
  const [x, y] = anchor;
  assert(Math.abs(x - 5) < 1, `x=${x} は中心 5 付近のはず`);
  assert(Math.abs(y - 5) < 1, `y=${y} は中心 5 付近のはず`);
});

Deno.test("labelAnchorFor は MultiPolygon で最大ポリゴン（本体）にアンカーを置く", () => {
  // 大きい本体（0..10）と遠く離れた小さい離島（100..101）
  const f = feature({
    type: "MultiPolygon",
    coordinates: [
      [squareRing(100, 100, 1)],
      [squareRing(0, 0, 10)],
    ],
  });
  const anchor = labelAnchorFor(f);
  assert(anchor !== null);
  assert(
    pointInRing(anchor, squareRing(0, 0, 10)),
    `anchor=${JSON.stringify(anchor)} は本体側に乗るはず`,
  );
});

Deno.test("labelAnchorFor は凹形状（L字）でもポリゴン内部にアンカーを置く", () => {
  // L 字型: bbox 中心 (5,5) は内部に含まれない
  const ring: Position[] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [8, 10],
    [8, 2],
    [0, 2],
    [0, 0],
  ];
  const f = feature({ type: "Polygon", coordinates: [ring] });
  const anchor = labelAnchorFor(f);
  assert(anchor !== null);
  assert(
    pointInRing(anchor, ring),
    `anchor=${JSON.stringify(anchor)} はポリゴン内部のはず`,
  );
});

Deno.test("labelAnchorFor は Polygon/MultiPolygon 以外・空ジオメトリで null を返す", () => {
  assertEquals(
    labelAnchorFor(feature({ type: "Point", coordinates: [0, 0] })),
    null,
  );
  assertEquals(
    labelAnchorFor(feature({ type: "MultiPolygon", coordinates: [] })),
    null,
  );
  assertEquals(labelAnchorFor(feature(null)), null);
});

// ---- labelPriorityFor ----

Deno.test("labelPriorityFor は面積が大きいほど高い優先度を返す", () => {
  const small = feature({
    type: "Polygon",
    coordinates: [squareRing(0, 0, 0.5)],
  });
  const large = feature({
    type: "Polygon",
    coordinates: [squareRing(0, 0, 10)],
  });
  assert(labelPriorityFor(large) > labelPriorityFor(small));
});

Deno.test("labelPriorityFor は MultiPolygon の最大ポリゴン面積で決まる", () => {
  // 本体 10x10 + 離島 1x1 と、本体 10x10 のみは同じ優先度になる
  const withIsland = feature({
    type: "MultiPolygon",
    coordinates: [[squareRing(100, 100, 1)], [squareRing(0, 0, 10)]],
  });
  const bodyOnly = feature({
    type: "Polygon",
    coordinates: [squareRing(0, 0, 10)],
  });
  assertEquals(labelPriorityFor(withIsland), labelPriorityFor(bodyOnly));
});

Deno.test("labelPriorityFor は常に -1000..1000 の範囲に収まる", () => {
  // CollisionFilterExtension の getCollisionPriority の許容レンジ
  const cases = [
    feature({ type: "Polygon", coordinates: [squareRing(0, 0, 1e-8)] }),
    feature({ type: "Polygon", coordinates: [squareRing(0, 0, 360)] }),
    feature({ type: "Point", coordinates: [0, 0] }),
    feature(null),
  ];
  for (const f of cases) {
    const p = labelPriorityFor(f);
    assert(
      p >= MIN_LABEL_PRIORITY && p <= MAX_LABEL_PRIORITY,
      `priority=${p} はレンジ外`,
    );
  }
});

// ---- buildLabelData ----

Deno.test("buildLabelData は NAME 欠落・非ポリゴン feature を除外する", () => {
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      feature({ type: "Polygon", coordinates: [squareRing(0, 0, 10)] }, {
        NAME: "France",
      }),
      // NAME null → 除外
      feature({ type: "Polygon", coordinates: [squareRing(20, 0, 10)] }, {
        NAME: null,
      }),
      // 非ポリゴン → 除外
      feature({ type: "Point", coordinates: [0, 0] }, { NAME: "PointLand" }),
    ],
  };
  const data = buildLabelData(fc);
  assertEquals(data.length, 1);
  assertEquals(data[0].text, "France");
  assert(pointInRing(data[0].position, squareRing(0, 0, 10)));
  // #267 AC6: priority は面積単独ではなく階層帯込み（kind 省略 = top）
  assertEquals(
    data[0].priority,
    tieredLabelPriority("top", labelPriorityFor(fc.features[0])),
  );
});

Deno.test("buildLabelData は空 FeatureCollection で空配列を返す", () => {
  assertEquals(
    buildLabelData({ type: "FeatureCollection", features: [] }),
    [],
  );
});

Deno.test("#341: 後期 HRE は帝国外残余を top に保ち、帝国全域ラベルを 1 件だけ作る", () => {
  const base: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      feature(
        { type: "Polygon", coordinates: [squareRing(-2, 0, 6)] },
        { NAME: "Austria" },
      ),
      feature(
        { type: "Polygon", coordinates: [squareRing(10, 0, 2)] },
        { NAME: "France" },
      ),
    ],
  };
  const realm: FeatureCollection = {
    type: "FeatureCollection",
    features: [feature(
      { type: "Polygon", coordinates: [squareRing(0, 0, 2)] },
      {
        NAME: HRE_SUZERAIN_NAME,
        SUBJECTO: HRE_SUZERAIN_NAME,
        PARTOF: HRE_SUZERAIN_NAME,
      },
    )],
  };
  const data = buildTopPoliticalLabelData(base, realm, {
    [HRE_SUZERAIN_NAME]: "神聖ローマ帝国",
  });

  assertEquals(data.map((d) => d.text).sort(), [
    "Austria",
    "France",
    "神聖ローマ帝国",
  ]);
  assertEquals(data.filter((d) => d.text === "神聖ローマ帝国").length, 1);
  const austria = data.find((d) => d.text === "Austria");
  assert(austria !== undefined);
  assertEquals(pointInRing(austria.position, squareRing(0, 0, 2)), false);
});

Deno.test("#341: hreRealm が空の年代は base ラベル規則を変更しない", () => {
  const base: FeatureCollection = {
    type: "FeatureCollection",
    features: [feature(
      { type: "Polygon", coordinates: [squareRing(0, 0, 2)] },
      { NAME: "France" },
    )],
  };
  assertEquals(
    buildTopPoliticalLabelData(base, {
      type: "FeatureCollection",
      features: [],
    }),
    buildLabelData(base, {}, "base"),
  );
});

Deno.test("#341: 1715 / 1783 / 1800 実データは z4→z5→z7 で HRE の情報階層を増やす", async () => {
  for (const year of [1715, 1783, 1800]) {
    const [base, realm, hre] = await Promise.all(
      [
        `data/europe_${year}.geojson`,
        `data/hre_realm_${year}.geojson`,
        `data/hre_fiefs_flat_${year}.geojson`,
      ].map(async (path) =>
        JSON.parse(await Deno.readTextFile(path)) as FeatureCollection
      ),
    );
    const top = buildTopPoliticalLabelData(base, realm);
    const all = [...top, ...buildLabelData(hre, {}, "hre")];
    const z4 = filterPowerLabelsByZoom(all, 4);
    const z5 = filterPowerLabelsByZoom(all, 5);
    const z7 = filterPowerLabelsByZoom(all, 7);

    assertEquals(
      z4.filter((d) => d.text === HRE_SUZERAIN_NAME).length,
      1,
      `${year}: z4 の HRE 上位政治圏ラベル`,
    );
    assertEquals(z4.some((d) => d.kind === "hre"), false);
    assert(z5.some((d) => d.kind === "hre"), `${year}: z5 の主要構成国`);
    assert(
      z5.filter((d) => d.kind === "hre").length <
        z7.filter((d) => d.kind === "hre").length,
      `${year}: z7 は z5 より多くの個別領邦を候補にする`,
    );
    assertEquals(z7.filter((d) => d.text === HRE_SUZERAIN_NAME).length, 1);
  }
});

Deno.test("#341 AC1: 修正前の base-only z4 は後期 HRE 名の有無が年代で不一致", async () => {
  const counts: number[] = [];
  for (const year of [1715, 1783, 1800]) {
    const base = JSON.parse(
      await Deno.readTextFile(`data/europe_${year}.geojson`),
    ) as FeatureCollection;
    counts.push(
      filterPowerLabelsByZoom(buildLabelData(base, {}, "base"), 4).filter(
        (d) => d.text === HRE_SUZERAIN_NAME,
      ).length,
    );
  }
  assertEquals(counts, [1, 0, 0]);
});

Deno.test("#341 AC7: 1815 実データは HRE 上位政治圏ラベルを合成しない", async () => {
  const base = JSON.parse(
    await Deno.readTextFile("data/europe_1815.geojson"),
  ) as FeatureCollection;
  const data = buildTopPoliticalLabelData(base, {
    type: "FeatureCollection",
    features: [],
  });
  assertEquals(data.some((d) => d.text === HRE_SUZERAIN_NAME), false);
});

// TASK-23: 日本語表記マップ（ja）の適用
Deno.test("buildLabelData は ja マップを適用した text を返す（未登録は英語のまま）", () => {
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      feature({ type: "Polygon", coordinates: [squareRing(0, 0, 10)] }, {
        NAME: "France",
      }),
      feature({ type: "Polygon", coordinates: [squareRing(20, 0, 10)] }, {
        NAME: "Wales",
      }),
    ],
  };
  const data = buildLabelData(fc, { France: "フランス王国" });
  assertEquals(data.map((d) => d.text), ["フランス王国", "Wales"]);
});

// TASK-30: ラベル由来種別（kind）の付与
Deno.test("buildLabelData は kind を渡すと全 datum に付与する", () => {
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      feature({ type: "Polygon", coordinates: [squareRing(0, 0, 10)] }, {
        NAME: "Bavaria",
      }),
      feature({ type: "Polygon", coordinates: [squareRing(20, 0, 10)] }, {
        NAME: "Saxony",
      }),
    ],
  };
  const data = buildLabelData(fc, {}, "hre");
  assertEquals(data.map((d) => d.kind), ["hre", "hre"]);
});

Deno.test("buildLabelData は kind 省略時に kind キーを持たない（後方互換）", () => {
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      feature({ type: "Polygon", coordinates: [squareRing(0, 0, 10)] }, {
        NAME: "France",
      }),
    ],
  };
  const data = buildLabelData(fc);
  assertEquals("kind" in data[0], false);
});

// TASK-93: 強調キー（key）の付与。強調中のラベル色切替の判定単位で、
// powers.ts colorKeyFor（= 塗りの色分け・power_highlight の適用単位）と同一。
Deno.test("buildLabelData は colorKeyFor と同一の強調キーを付与する（TASK-93）", () => {
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      feature({ type: "Polygon", coordinates: [squareRing(0, 0, 10)] }, {
        NAME: "France",
      }),
      feature({ type: "Polygon", coordinates: [squareRing(20, 0, 10)] }, {
        NAME: "Bavaria",
        SUBJECTO: "Holy Roman Empire",
      }),
    ],
  };
  const data = buildLabelData(fc, {}, "base");
  assertEquals(data.map((d) => d.key), [
    colorKeyFor({ NAME: "France" }) ?? undefined,
    colorKeyFor({ NAME: "Bavaria", SUBJECTO: "Holy Roman Empire" }) ??
      undefined,
  ]);
});

Deno.test("buildLabelData は飛び地（同一 NAME の別 feature）へ同じ強調キーを付与する", () => {
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      feature({ type: "Polygon", coordinates: [squareRing(0, 0, 10)] }, {
        NAME: "Denmark",
      }),
      feature({ type: "Polygon", coordinates: [squareRing(30, 0, 8)] }, {
        NAME: "Denmark",
      }),
    ],
  };
  const data = buildLabelData(fc, {}, "base");
  assertEquals(data[0].key, data[1].key);
});

// ---- FIEF_LABEL_COLOR（#267 以降は境界インクの色相定義） ----

Deno.test("FIEF_LABEL_COLOR（諸侯領の記号色）は他の記号色と異なる（TASK-71 AC #1）", () => {
  // #267 でラベル文字色としては使わなくなったが、諸侯領境界インク
  // （political_layers.ts FIEF_BORDER_INK）の色相定義として、都市・河川の
  // 注記色と識別できることは引き続き固定する
  for (const other of [CITY_LABEL_COLOR, RIVER_LABEL_COLOR]) {
    assert(
      JSON.stringify(FIEF_LABEL_COLOR) !== JSON.stringify(other),
      `FIEF_LABEL_COLOR が ${JSON.stringify(other)} と同じ`,
    );
  }
});

Deno.test("buildLabelData は kind=fief を全 datum に付与する（TASK-71）", () => {
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      feature({ type: "Polygon", coordinates: [squareRing(0, 0, 10)] }, {
        NAME: "Duchy of Normandy",
      }),
    ],
  };
  const data = buildLabelData(
    fc,
    { "Duchy of Normandy": "ノルマンディー公領" },
    "fief",
  );
  assertEquals(data.map((d) => d.kind), ["fief"]);
  assertEquals(data.map((d) => d.text), ["ノルマンディー公領"]);
});

// ---- characterSetFrom ----

Deno.test("characterSetFrom は全ラベルの文字を重複なく集める（非 ASCII 含む）", () => {
  const chars = characterSetFrom(["Württemberg", "Wales"]);
  // 重複なし
  assertEquals(new Set(chars).size, chars.length);
  // 非 ASCII の ü が含まれる（TextLayer の characterSet 用）
  assert(chars.includes("ü"));
  assert(chars.includes("W"));
  // "W" は両方に現れるが 1 回だけ
  assertEquals(chars.filter((c) => c === "W").length, 1);
});

Deno.test("characterSetFrom は空入力で空配列を返す", () => {
  assertEquals(characterSetFrom([]), []);
});

// ---- TASK-38: ラベル共通フォント設定・アウトライン・サイズ ----

// TASK-38 以前の各ラベルサイズ（px）。新サイズはこれ以上でなければならない。
const PRE_TASK_38_POWER_LABEL_SIZE_PX = 13;
const PRE_TASK_38_RIVER_LABEL_SIZE_PX = 11;
const PRE_TASK_38_CITY_LABEL_SIZE_PX = 11;
// 過度な画面占有・衝突増を避けるための上限（AC #2）
const MAX_REASONABLE_LABEL_SIZE_PX = 20;

Deno.test("LABEL_FONT_SETTINGS は sdf を有効にする（アウトライン描画の前提）", () => {
  assertEquals(LABEL_FONT_SETTINGS.sdf, true);
});

Deno.test("LABEL_OUTLINE_COLOR は白系（十分な RGB 輝度）で十分不透明", () => {
  const [r, g, b, a] = LABEL_OUTLINE_COLOR;
  assert(
    r >= 200 && g >= 200 && b >= 200,
    `outline=${LABEL_OUTLINE_COLOR} は白系のはず`,
  );
  assert(a >= 200, `outline alpha=${a} は十分不透明のはず`);
});

// ---- TASK-72: 背景パネル撤去 + halo の実効化 ----
// outlineWidth は「px」ではなく fontSettings.radius 比で正規化される
// （deck.gl text-layer.js: outlineWidth / (fontSettings.radius || 12)）。
// 旧値 2（radius 12 比で 0.167）では halo がほぼ描かれていなかった。

Deno.test("LABEL_OUTLINE_WIDTH は radius 比で halo が実際に見える太さ（旧値 2 より大）", () => {
  const PRE_TASK_72_OUTLINE_WIDTH = 2;
  assert(
    LABEL_OUTLINE_WIDTH > PRE_TASK_72_OUTLINE_WIDTH,
    `outlineWidth=${LABEL_OUTLINE_WIDTH} は旧値 ${PRE_TASK_72_OUTLINE_WIDTH} 超のはず`,
  );
  // 太すぎると日本語ラベルが文字ごとの白ベタ矩形になる（実測で 9 は破綻）
  assert(
    LABEL_OUTLINE_WIDTH <= 6,
    `outlineWidth=${LABEL_OUTLINE_WIDTH} は上限 6 以内のはず`,
  );
  // radius を超えると outlineBuffer が smoothing で頭打ちになり意味を失う
  assert(
    LABEL_OUTLINE_WIDTH < LABEL_SDF_RADIUS,
    `outlineWidth=${LABEL_OUTLINE_WIDTH} は radius=${LABEL_SDF_RADIUS} 未満のはず`,
  );
});

Deno.test("LABEL_FONT_SETTINGS は halo 分のグリフ余白（buffer）と radius を明示する", () => {
  assertEquals(LABEL_FONT_SETTINGS.radius, LABEL_SDF_RADIUS);
  // buffer は atlas 上のグリフ余白 = halo 幅の上限。deck.gl 既定の 4 では
  // 太い halo が atlas の外で切れる
  assert(
    LABEL_FONT_SETTINGS.buffer >= LABEL_OUTLINE_WIDTH,
    `buffer=${LABEL_FONT_SETTINGS.buffer} は outlineWidth=${LABEL_OUTLINE_WIDTH} 以上のはず`,
  );
  // smoothing を上げると halo の縁がぼやけて実効的な太さが落ちる
  assert(
    LABEL_FONT_SETTINGS.smoothing <= 0.1,
    `smoothing=${LABEL_FONT_SETTINGS.smoothing} は 0.1 以下のはず`,
  );
});

Deno.test("labelTextStyleProps は背景パネルを描かない（background: false・パネル props 無し）", () => {
  const props = labelTextStyleProps();
  assertEquals(props.background, false);
  const keys = Object.keys(props);
  assert(
    !keys.includes("getBackgroundColor") && !keys.includes("backgroundPadding"),
    `背景パネル props が残っている: ${keys.join(", ")}`,
  );
});

// ---- TASK-143: 自己衝突対策の不可視背景クアッドを全ラベル層へ一般化 ----
// CollisionFilterExtension の可視判定はアンカー画素の 5x5 サンプルを見るが、
// 背景の無い TextLayer は衝突 FBO にグリフ形状しか残らず、アンカーがグリフの
// 空白（「ー」の上下・「イ|ン」の文字間・「・」の周囲）に落ちるラベルは自分の
// 可視判定に永遠に失敗する（TASK-136 のライン川、TASK-143 実機監査のローマ・
// ボローニャ・ボヘミア王国など計 11 件）。河川層だけだった TASK-136 の対処を
// 衝突参加の全ラベル層に広げる。

Deno.test("LABEL_COLLISION_BACKGROUND_COLOR: alpha 1 の不可視背景（0 だと衝突 FBO に描かれない）", () => {
  // alpha 0 は SDF/picking 系 shader の alpha==0 discard で衝突 FBO に載らず、
  // 対策として機能しない。1（1/255）は目視では識別不能な下限値
  assertEquals(LABEL_COLLISION_BACKGROUND_COLOR, [0, 0, 0, 1]);
});

Deno.test("labelCollisionBackgroundProps は不可視背景クアッドを敷く（TASK-143）", () => {
  const a = labelCollisionBackgroundProps();
  const b = labelCollisionBackgroundProps();
  assertEquals(a.background, true);
  assertEquals(a.getBackgroundColor, [...LABEL_COLLISION_BACKGROUND_COLOR]);
  // deck.gl にモジュール定数の参照をそのまま渡さない（破壊的変更の防止）
  assert(a.getBackgroundColor !== b.getBackgroundColor);
  assert(
    (a.getBackgroundColor as unknown) !==
      (LABEL_COLLISION_BACKGROUND_COLOR as unknown),
  );
});

Deno.test("labelTextStyleProps は halo 設定を共通で持ち、配列を呼び出しごとに複製する", () => {
  const a = labelTextStyleProps();
  const b = labelTextStyleProps();
  assertEquals(a.outlineWidth, LABEL_OUTLINE_WIDTH);
  assertEquals(a.outlineColor, [...LABEL_OUTLINE_COLOR]);
  assertEquals(a.fontFamily, LABEL_FONT_FAMILY);
  // deck.gl にモジュール定数の参照をそのまま渡さない（破壊的変更の防止）
  assert(a.outlineColor !== b.outlineColor);
  assert((a.outlineColor as number[]) !== (LABEL_OUTLINE_COLOR as unknown));
});

Deno.test("LABEL_FONT_FAMILY は sans-serif フォールバックを含む文字列", () => {
  assert(LABEL_FONT_FAMILY.includes("sans-serif"));
});

Deno.test("国名・河川名・都市名ラベルのサイズは従来値以上・上限内", () => {
  for (
    const [size, pre] of [
      [POWER_LABEL_SIZE_PX, PRE_TASK_38_POWER_LABEL_SIZE_PX],
      [RIVER_LABEL_SIZE_PX, PRE_TASK_38_RIVER_LABEL_SIZE_PX],
      [CITY_LABEL_SIZE_PX, PRE_TASK_38_CITY_LABEL_SIZE_PX],
    ] as const
  ) {
    assert(size >= pre, `size=${size} は従来値 ${pre} 以上のはず`);
    assert(
      size <= MAX_REASONABLE_LABEL_SIZE_PX,
      `size=${size} は上限 ${MAX_REASONABLE_LABEL_SIZE_PX} 以内のはず`,
    );
  }
});

Deno.test("注記ラベルの色分け定数は変更されていない（TASK-38、#267 で政治ラベルのみ明色化）", () => {
  // 都市 = 茶系は不変。国名・領邦の暗色文字（旧 BASE/HRE_LABEL_COLOR）は
  // #267 で明色 + 濃焦茶 halo（POLITICAL_LABEL_COLOR）へ置き換えられた
  assertEquals(CITY_LABEL_COLOR, [121, 62, 22, 255]);
  assertEquals(POLITICAL_LABEL_COLOR, [248, 242, 226, 255]);
  assertEquals(POLITICAL_LABEL_HALO_COLOR, [58, 39, 18, 255]);
});

Deno.test("TASK-123: 河川名の常時表示色は暗青灰、強調色は従来の濃い水色", () => {
  // 常時表示（通常）色はライン色 #94a8b0 と同系の暗青灰（羊皮紙上で騒がない）
  assertEquals(RIVER_LABEL_COLOR, [42, 72, 92, 255]);
  // ホバー/選択中は TASK-24 以来の濃い水色 #0277bd（TASK-69 時代の表示色）を維持
  assertEquals(ACTIVE_RIVER_LABEL_COLOR, [2, 119, 189, 255]);
});

Deno.test("TASK-123: 河川名の常時表示色は他の全ラベル種別と識別できる（AC #6）", () => {
  // 山脈の苔緑・諸侯領の藍紫（境界インク）・都市の茶・政治勢力の明色
  // （#267）のいずれとも異なる値で、青が最大チャンネル（水系 = 青系の
  // 記号性を保つ）
  for (
    const other of [
      POLITICAL_LABEL_COLOR,
      FIEF_LABEL_COLOR,
      CITY_LABEL_COLOR,
      MOUNTAIN_LABEL_COLOR,
    ]
  ) {
    assert(
      JSON.stringify(RIVER_LABEL_COLOR) !== JSON.stringify(other),
      `RIVER_LABEL_COLOR が ${JSON.stringify(other)} と同じ`,
    );
  }
  assert(
    RIVER_LABEL_COLOR[2] > RIVER_LABEL_COLOR[0] &&
      RIVER_LABEL_COLOR[2] > RIVER_LABEL_COLOR[1],
  );
});

// TASK-23: 日本語ラベルのグリフ生成（characterSet が日本語文字を含む）
Deno.test("characterSetFrom は日本語ラベルの文字も重複なく集める", () => {
  const chars = characterSetFrom(["フランス王国", "神聖ローマ帝国", "Wales"]);
  assertEquals(new Set(chars).size, chars.length);
  assert(chars.includes("フ"));
  assert(chars.includes("帝"));
  assert(chars.includes("W"));
  // "国" は両方の日本語ラベルに現れるが 1 回だけ
  assertEquals(chars.filter((c) => c === "国").length, 1);
});

// ---- TASK-54 / TASK-72: 密集地域向けの衝突間引き強化 ----
// TASK-54 の背景パネル（案A）は TASK-72 で撤去し、halo の実効化に置き換えた。
// 案B（衝突判定領域の拡大）は残し、パネル分の余白喪失を補って引き上げる。

Deno.test("TASK-72: ラベル背景パネル定数は撤去されている", async () => {
  const labels = await import("./labels.ts");
  const exported = Object.keys(labels);
  assert(
    !exported.includes("LABEL_BACKGROUND_COLOR") &&
      !exported.includes("LABEL_BACKGROUND_PADDING"),
    `背景パネル定数が残っている: ${exported.join(", ")}`,
  );
});

Deno.test("COLLISION_SIZE_SCALE は TASK-54 値 2.6 以上・上限 4 以内", () => {
  // TASK-54 の値。背景パネル（padding [3,2]px）撤去で衝突箱が縮む分を
  // 補うため、これ以上に保つ（AC #4: z4 の重なりを撤去前より悪化させない）
  const TASK_54_COLLISION_SIZE_SCALE = 2.6;
  assert(
    COLLISION_SIZE_SCALE >= TASK_54_COLLISION_SIZE_SCALE,
    `sizeScale=${COLLISION_SIZE_SCALE} は TASK-54 値 ${TASK_54_COLLISION_SIZE_SCALE} 以上のはず`,
  );
  // 上げすぎるとズーム 5〜6 の全体観でラベルが消えすぎて情報量が落ちる
  assert(
    COLLISION_SIZE_SCALE <= 4,
    `sizeScale=${COLLISION_SIZE_SCALE} は上限 4 以内のはず`,
  );
});

// ---- TASK-108: 衝突フェードの二値化（半透明ゴーストの除去） ----
// CollisionFilterExtension は衝突判定を 0/1 ではなく pow(一致数/25, 2.2) の
// 連続値（collision_fade）で返し、color.a に乗算する。負けかけたラベルは
// 中途半端な alpha で描かれ続け、しかも SDF の halo は outlineColor の alpha を
// そのまま使う（vColor.a に依存しない）ため「文字が薄れて白い輪郭だけ残る」。
// 対策は色ではなく **ジオメトリの破棄** で行う（inject 先は
// DECKGL_FILTER_GL_POSITION）。

Deno.test("TASK-108: cutoff inject は GL_POSITION フックだけを対象にする", () => {
  const inject = labelCollisionCutoffInject();
  assertEquals(Object.keys(inject), [LABEL_COLLISION_INJECT_HOOK]);
  assertEquals(LABEL_COLLISION_INJECT_HOOK, "vs:DECKGL_FILTER_GL_POSITION");
  // 色フックには触らない（halo の alpha は outlineColor 由来で vColor.a に
  // 依存しないため、color.a を 0 にしてもゴーストの輪郭は消えない）
  assert(!("vs:DECKGL_FILTER_COLOR" in inject));
});

Deno.test("TASK-108: cutoff inject は fade を破棄/完全表示の二択へ倒す", () => {
  const glsl = labelCollisionCutoffInject()[LABEL_COLLISION_INJECT_HOOK];
  // collision モジュールが collision_fade を計算し終えた後に効く前提
  assert(glsl.includes("collision.enabled"), glsl);
  assert(
    glsl.includes(`collision_fade < ${LABEL_COLLISION_FADE_CUTOFF}`),
    glsl,
  );
  // 負けた側はクリップ空間の外へ飛ばして完全に消す（halo ごと消える）
  assert(glsl.includes("position = vec4(0.0, 0.0, 2.0, 1.0);"), glsl);
  // 勝った側は fade を 1.0 に戻し、後段の color.a *= collision_fade を無効化する
  assert(glsl.includes("collision_fade = 1.0;"), glsl);
  assert(glsl.includes("collision_fade = 0.0;"), glsl);
});

Deno.test("TASK-108: cutoff は GLSL float リテラルとして埋め込まれる", () => {
  // "1" のような int リテラルは float との比較でコンパイルエラーになる
  const glsl = labelCollisionCutoffInject(1)[LABEL_COLLISION_INJECT_HOOK];
  const m = glsl.match(/collision_fade < ([0-9.]+)/);
  assert(m !== null, glsl);
  assert(m[1].includes("."), `float リテラルでない: ${m[1]}`);
  assertEquals(Number(m[1]), 1);
});

Deno.test("TASK-108: cutoff は (0, 1] にクランプされる", () => {
  const cutoffOf = (v: number): number => {
    const glsl = labelCollisionCutoffInject(v)[LABEL_COLLISION_INJECT_HOOK];
    return Number(glsl.match(/collision_fade < ([0-9.]+)/)![1]);
  };
  // 0 以下は deck.gl 自身の discard 閾値まで（完全に無効化はさせない）
  assertEquals(cutoffOf(0), MIN_LABEL_COLLISION_FADE_CUTOFF);
  assertEquals(cutoffOf(-1), MIN_LABEL_COLLISION_FADE_CUTOFF);
  // 1 超は 1（fade=1.0 の完全勝利以外を全部消す上限）
  assertEquals(cutoffOf(2), 1);
  // 非有限値は既定値へフォールバック
  assertEquals(cutoffOf(NaN), LABEL_COLLISION_FADE_CUTOFF);
});

Deno.test("TASK-108: 既定 cutoff は中間フェードの帯を潰しつつ消しすぎない", () => {
  assert(
    LABEL_COLLISION_FADE_CUTOFF > MIN_LABEL_COLLISION_FADE_CUTOFF,
    "既定値が deck.gl の discard 閾値と同じでは二値化にならない",
  );
  assert(
    LABEL_COLLISION_FADE_CUTOFF <= 1,
    "既定値は 1 以下（fade=1.0 の完全勝利は必ず残す）",
  );
  // AC #4: fade は pow(一致率, 2.2) なので、cutoff=0.5 は一致率 約 0.73 に相当。
  // 一致率 0.5（アンカー近傍の半分を奪われた状態）で消えると中小勢力ラベルが
  // 消えすぎるため、生の一致率換算で 0.5 を下回らせない。
  const matchRatio = LABEL_COLLISION_FADE_CUTOFF ** (1 / 2.2);
  assert(
    matchRatio >= 0.5,
    `一致率換算 ${matchRatio.toFixed(3)} が緩すぎる（中途半端な描画が残る）`,
  );
  assert(
    matchRatio <= 0.95,
    `一致率換算 ${matchRatio.toFixed(3)} が厳しすぎる（ラベルが消えすぎる）`,
  );
});

// ---- 出典混在レイヤーの kind 判定（TASK-110）----

Deno.test("isHreSuzerainFeature: SUBJECTO / PARTOF が神聖ローマ帝国の feature だけ true（TASK-110）", () => {
  assert(
    isHreSuzerainFeature({
      NAME: "Duchy of Bavaria",
      SUBJECTO: HRE_SUZERAIN_NAME,
    }),
  );
  // SUBJECTO が無くても PARTOF で判定できる（既存 hre_fiefs は両方を持つ）
  assert(
    isHreSuzerainFeature({
      NAME: "Kingdom of Bohemia",
      PARTOF: HRE_SUZERAIN_NAME,
    }),
  );
  // 仏諸侯領は宗主が帝国ではない（SUBJECTO 無し・または仏王）
  assert(!isHreSuzerainFeature({ NAME: "County of Toulouse" }));
  assert(
    !isHreSuzerainFeature({
      NAME: "Duchy of Aquitaine",
      SUBJECTO: "Kingdom of France",
    }),
  );
  assert(!isHreSuzerainFeature(null));
});

Deno.test("partitionFiefsBySuzerain: 出典混在レイヤーを帝国領邦（臙脂）と諸侯領（藍紫）へ分ける（TASK-110）", () => {
  const square = { type: "Polygon", coordinates: [squareRing(0, 0, 1)] };
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      feature(square as Feature["geometry"], {
        NAME: "Duchy of Bavaria",
        SUBJECTO: HRE_SUZERAIN_NAME,
      }),
      feature(square as Feature["geometry"], { NAME: "County of Toulouse" }),
      feature(square as Feature["geometry"], {
        NAME: "Margraviate of Brandenburg",
        PARTOF: HRE_SUZERAIN_NAME,
      }),
    ],
  };
  const { hre, fief } = partitionFiefsBySuzerain(fc);
  assertEquals(
    hre.features.map((f) => f.properties?.NAME),
    ["Duchy of Bavaria", "Margraviate of Brandenburg"],
  );
  assertEquals(
    fief.features.map((f) => f.properties?.NAME),
    ["County of Toulouse"],
  );
  // #267: kind 別の文字色は廃止されたが、kind はズーム段の出し分け
  // （filterPowerLabelsByZoom の overview 判定）の入力として残る
});

Deno.test("partitionFiefsBySuzerain: 空 FeatureCollection では両側とも空（未生成時の縮退。TASK-110）", () => {
  const { hre, fief } = partitionFiefsBySuzerain({
    type: "FeatureCollection",
    features: [],
  });
  assertEquals(hre.features, []);
  assertEquals(fief.features, []);
});

// ---- ズーム段によるラベル絞り込み（TASK-122） ----

Deno.test("FIEF_LABEL_MIN_ZOOM は MIN_ZOOM より上・MAX_ZOOM 以下（実際に出し分けが起きる段）", () => {
  assert(FIEF_LABEL_MIN_ZOOM > MIN_ZOOM);
  assert(FIEF_LABEL_MIN_ZOOM <= MAX_ZOOM);
});

Deno.test("fiefLabelsVisibleAt はしきい値の 1 段下で false・しきい値ちょうどで true", () => {
  assertEquals(fiefLabelsVisibleAt(FIEF_LABEL_MIN_ZOOM - 1), false);
  assertEquals(fiefLabelsVisibleAt(FIEF_LABEL_MIN_ZOOM), true);
});

Deno.test("fiefLabelsVisibleAt は整数ズーム段で判定する（小数は切り捨て）", () => {
  assertEquals(fiefLabelsVisibleAt(FIEF_LABEL_MIN_ZOOM - 0.01), false);
  assertEquals(fiefLabelsVisibleAt(FIEF_LABEL_MIN_ZOOM + 0.99), true);
  assertEquals(fiefLabelsVisibleAt(MIN_ZOOM), false);
  assertEquals(fiefLabelsVisibleAt(MAX_ZOOM), true);
});

Deno.test("fiefLabelsVisibleAt は非有限値を最遠段（MIN_ZOOM）として扱う", () => {
  assertEquals(fiefLabelsVisibleAt(Number.NaN), false);
});

// ---- 政治領域の表示レベル判定（#228 AC1） ----

Deno.test("politicalDetailVisibleAt はしきい値の 1 段下で概観・しきい値ちょうどで詳細（#228 AC1）", () => {
  assertEquals(politicalDetailVisibleAt(FIEF_LABEL_MIN_ZOOM - 1), false);
  assertEquals(politicalDetailVisibleAt(FIEF_LABEL_MIN_ZOOM), true);
});

Deno.test("politicalDetailVisibleAt は整数ズーム段で判定する（小数は切り捨て）", () => {
  assertEquals(politicalDetailVisibleAt(FIEF_LABEL_MIN_ZOOM - 0.01), false);
  assertEquals(politicalDetailVisibleAt(FIEF_LABEL_MIN_ZOOM + 0.99), true);
  assertEquals(politicalDetailVisibleAt(MIN_ZOOM), false);
  assertEquals(politicalDetailVisibleAt(MAX_ZOOM), true);
});

Deno.test("politicalDetailVisibleAt は非有限値を最遠段（MIN_ZOOM = 概観）として扱う", () => {
  assertEquals(politicalDetailVisibleAt(Number.NaN), false);
});

Deno.test("politicalDetailVisibleAt は fiefLabelsVisibleAt と全ズーム段で一致する（判定の共有。#228 AC1）", () => {
  // 塗り・境界・ラベル・picking が同じしきい値で切り替わることの根拠。
  // ラベル側の既存判定（fiefLabelsVisibleAt）とズレたら概観なのに領邦塗りが
  // 残る等の不統一（本タスクの動機そのもの）が再発する。
  for (let z = MIN_ZOOM; z <= MAX_ZOOM; z += 0.5) {
    assertEquals(politicalDetailVisibleAt(z), fiefLabelsVisibleAt(z));
  }
});

Deno.test("OVERVIEW_POWER_LABEL_SIZE_PX は詳細表示の勢力名（POWER_LABEL_SIZE_PX）より一段大きい（#228 AC3）", () => {
  assert(OVERVIEW_POWER_LABEL_SIZE_PX > POWER_LABEL_SIZE_PX);
});

/** 絞り込みテスト用のラベル datum 群（base 2 件・うち 1 件は TASK-78 抑制対象） */
function zoomFilterFixture(): LabelDatum[] {
  return [
    { text: "フランス王国", position: [2, 47], priority: 300, kind: "base" },
    // TASK-78 で諸侯領にほぼ完全内包され抑制される base 勢力（1000〜1300 の Britany）
    {
      text: "ブルターニュ",
      position: [-3, 48],
      priority: 100,
      kind: "base",
      suppressed: true,
    },
    {
      text: "ブルターニュ公領",
      position: [-3, 48],
      priority: 100,
      kind: "fief",
    },
    { text: "バイエルン公領", position: [11, 48], priority: 120, kind: "hre" },
  ];
}

Deno.test("filterPowerLabelsByZoom: しきい値未満では hre/fief の datum を除く（TASK-122 AC #1）", () => {
  const out = filterPowerLabelsByZoom(
    zoomFilterFixture(),
    FIEF_LABEL_MIN_ZOOM - 1,
  );
  assertEquals(out.every((d) => d.kind !== "hre" && d.kind !== "fief"), true);
});

Deno.test("filterPowerLabelsByZoom: しきい値未満では TASK-78 の base 抑制を解除する（AC #4）", () => {
  const out = filterPowerLabelsByZoom(
    zoomFilterFixture(),
    FIEF_LABEL_MIN_ZOOM - 1,
  );
  assertEquals(out.map((d) => d.text), ["フランス王国", "ブルターニュ"]);
});

Deno.test("filterPowerLabelsByZoom: しきい値以上では諸侯領を出し base 抑制を効かせる（AC #2）", () => {
  const out = filterPowerLabelsByZoom(zoomFilterFixture(), FIEF_LABEL_MIN_ZOOM);
  assertEquals(out.map((d) => d.text), [
    "フランス王国",
    "ブルターニュ公領",
    "バイエルン公領",
  ]);
});

Deno.test("filterPowerLabelsByZoom: どのズーム段でもラベルが 0 件になる土地が無い（AC #4）", () => {
  const fixture = zoomFilterFixture();
  for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
    const texts = filterPowerLabelsByZoom(fixture, z).map((d) => d.text);
    // ブルターニュの土地には常にちょうど 1 つのラベルが載る（base か諸侯領のどちらか）
    const breton = texts.filter(
      (t) => t === "ブルターニュ" || t === "ブルターニュ公領",
    ).length;
    assertEquals(breton, 1, `zoom ${z} でブルターニュのラベルが ${breton} 件`);
  }
});

// ---- #348: detailFocusKey による勢力ラベルの絞り込み（AC3/AC6/AC7）----

/**
 * focus 絞り込み用の datum 群。
 *
 * - France 圏: フランス王国（base）・ブルターニュ（base、諸侯領に覆われ抑制）・
 *   ブルターニュ公領（fief）
 * - Papal States 圏: 教皇領（base、伊諸侯領に覆われ抑制）・トスカーナ辺境伯領（fief）
 * - Holy Roman Empire 圏: バイエルン公領（hre）
 */
function focusFilterFixture(): LabelDatum[] {
  return [
    {
      text: "フランス王国",
      position: [2, 47],
      priority: 300,
      kind: "base",
      key: "France",
    },
    {
      text: "教皇領",
      position: [12, 42],
      priority: 280,
      kind: "base",
      key: "Papal States",
      suppressed: true,
    },
    {
      text: "ブルターニュ",
      position: [-3, 48],
      priority: 100,
      kind: "base",
      key: "Britany",
      suppressed: true,
    },
    {
      text: "ブルターニュ公領",
      position: [-3, 48],
      priority: 100,
      kind: "fief",
      key: "Duchy of Brittany",
    },
    {
      text: "トスカーナ辺境伯領",
      position: [11, 43],
      priority: 90,
      kind: "fief",
      key: "Tuscany",
    },
    {
      text: "バイエルン公領",
      position: [11, 48],
      priority: 120,
      kind: "hre",
      key: "Bavaria|Holy Roman Empire",
    },
  ];
}

/** fixture の LabelDatum.key（colorKeyFor 相当）→ 宗主キーの対応 */
const FOCUS_FIXTURE_SUZERAINS: Record<string, string> = {
  "France": "France",
  "Papal States": "Papal States",
  "Britany": "France",
  "Duchy of Brittany": "France",
  "Tuscany": "Papal States",
  "Bavaria|Holy Roman Empire": "Holy Roman Empire",
};

function focusFixtureSuzerainOf(d: LabelDatum): string | null {
  if (d.key === undefined) return null;
  return FOCUS_FIXTURE_SUZERAINS[d.key] ?? null;
}

Deno.test("filterPowerLabelsByFocus: focus 外の領邦・帝国領邦ラベルを落とす（#348 AC3）", () => {
  const out = filterPowerLabelsByFocus(
    focusFilterFixture(),
    "France",
    focusFixtureSuzerainOf,
  );
  const overlay = out.filter((d) => d.kind === "hre" || d.kind === "fief");
  assertEquals(overlay.map((d) => d.text), ["ブルターニュ公領"]);
});

Deno.test("filterPowerLabelsByFocus: focus 外の上位勢力名は抑制を解除して残す（#348 AC3）", () => {
  const out = filterPowerLabelsByFocus(
    focusFilterFixture(),
    "France",
    focusFixtureSuzerainOf,
  );
  const papal = out.find((d) => d.text === "教皇領");
  assert(papal !== undefined);
  // 同じ土地の伊諸侯領ラベル（トスカーナ）が focus 外で落ちる以上、base 側の
  // 抑制を解除しないとその土地のラベルが 1 つも無くなる
  assertEquals(papal.suppressed, false);
  // focus 内（France 圏）の抑制はそのまま = 諸侯領ラベルに譲る
  const brittany = out.find((d) => d.text === "ブルターニュ");
  assert(brittany !== undefined);
  assertEquals(brittany.suppressed, true);
});

Deno.test("filterPowerLabelsByFocus: focus が null なら入力を同一参照で返す（#348 AC6）", () => {
  const data = focusFilterFixture();
  assertStrictEquals(
    filterPowerLabelsByFocus(data, null, focusFixtureSuzerainOf),
    data,
  );
});

Deno.test("filterPowerLabelsByFocus: 宗主が解決できない領邦ラベルは focus 外として落とす", () => {
  const data: LabelDatum[] = [
    { text: "海上の封土", position: [0, 0], priority: 0, kind: "fief" },
  ];
  assertEquals(
    filterPowerLabelsByFocus(data, "France", focusFixtureSuzerainOf).length,
    0,
  );
});

Deno.test("filterPowerLabelsByFocus → filterPowerLabelsByZoom で二重ラベルが出ない（#348 AC3）", () => {
  for (const focus of ["France", "Papal States", "Holy Roman Empire"]) {
    for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
      const texts = filterPowerLabelsByZoom(
        filterPowerLabelsByFocus(
          focusFilterFixture(),
          focus,
          focusFixtureSuzerainOf,
        ),
        z,
      ).map((d) => d.text);
      // ブルターニュの土地・教皇領の土地には常にちょうど 1 つのラベルが載る
      const breton = texts.filter((t) =>
        t === "ブルターニュ" || t === "ブルターニュ公領"
      ).length;
      assertEquals(breton, 1, `focus=${focus} zoom=${z} breton=${breton}`);
      const papal = texts.filter((t) =>
        t === "教皇領" || t === "トスカーナ辺境伯領"
      ).length;
      assertEquals(papal, 1, `focus=${focus} zoom=${z} papal=${papal}`);
    }
  }
});

Deno.test("filterPowerLabelsByZoom: kind 省略の datum は base 扱いで常に残す", () => {
  const data: LabelDatum[] = [{ text: "無印", position: [0, 0], priority: 0 }];
  assertEquals(filterPowerLabelsByZoom(data, MIN_ZOOM).length, 1);
  assertEquals(filterPowerLabelsByZoom(data, MAX_ZOOM).length, 1);
});

Deno.test("filterPowerLabelsByZoom: 入力配列を破壊せず datum の参照をそのまま返す（メモ化の契約）", () => {
  const data = zoomFilterFixture();
  const before = [...data];
  const out = filterPowerLabelsByZoom(data, MAX_ZOOM);
  assertEquals(data, before);
  assertStrictEquals(out[0], data[0]);
});

Deno.test("buildLabelData: suppressedNames の NAME には suppressed=true を付ける（datum は落とさない）", () => {
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      feature({ type: "Polygon", coordinates: [squareRing(0, 0, 4)] }, {
        NAME: "Britany",
      }),
      feature({ type: "Polygon", coordinates: [squareRing(10, 0, 4)] }, {
        NAME: "France",
      }),
    ],
  };
  const data = buildLabelData(fc, {}, "base", new Set(["Britany"]));
  // characterSet を絞り込み前の全テキストから作れるよう、datum 自体は残す
  assertEquals(data.map((d) => d.text), ["Britany", "France"]);
  assertEquals(data[0].suppressed, true);
  // 抑制対象でない datum は suppressed キー自体を持たない（従来と完全互換）
  assertEquals("suppressed" in data[1], false);
});

Deno.test("buildLabelData: suppressedNames 省略時は suppressed を一切付けない", () => {
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      feature({ type: "Polygon", coordinates: [squareRing(0, 0, 4)] }, {
        NAME: "Britany",
      }),
    ],
  };
  assertEquals("suppressed" in buildLabelData(fc, {}, "base")[0], false);
});

Deno.test("characterSet は絞り込み前の全 datum から作れば全ズーム段の和集合になる（AC #7）", () => {
  const all = zoomFilterFixture();
  const full = new Set(characterSetFrom(all.map((d) => d.text)));
  for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
    for (
      const ch of characterSetFrom(
        filterPowerLabelsByZoom(all, z).map((d) => d.text),
      )
    ) {
      assert(full.has(ch), `zoom ${z} の文字 ${ch} が全体集合に無い`);
    }
  }
});

// ---- #267: 3 段階の政治表示レベル（AC1） ----

Deno.test("politicalDisplayLevel: z4 = overview / z5〜6 = mid / z7〜8 = detail（#267 AC1）", () => {
  assertEquals(politicalDisplayLevel(FIEF_LABEL_MIN_ZOOM - 1), "overview");
  assertEquals(politicalDisplayLevel(FIEF_LABEL_MIN_ZOOM), "mid");
  assertEquals(politicalDisplayLevel(POLITICAL_DETAIL_MIN_ZOOM - 1), "mid");
  assertEquals(politicalDisplayLevel(POLITICAL_DETAIL_MIN_ZOOM), "detail");
  assertEquals(politicalDisplayLevel(MAX_ZOOM), "detail");
});

Deno.test("politicalDisplayLevel は整数ズーム段で判定し、非有限値は最遠段（overview）", () => {
  assertEquals(politicalDisplayLevel(4.99), "overview");
  assertEquals(politicalDisplayLevel(6.99), "mid");
  assertEquals(politicalDisplayLevel(7.01), "detail");
  assertEquals(politicalDisplayLevel(Number.NaN), "overview");
  assertEquals(politicalDisplayLevel(Number.POSITIVE_INFINITY), "overview");
});

Deno.test("POLITICAL_DETAIL_MIN_ZOOM は mid の段が実在する位置にある（AC1）", () => {
  // z5〜6 が mid になるためには detail のしきい値が fief しきい値より上で、
  // かつアプリがズームできる範囲（MAX_ZOOM）以内でなければならない
  assert(POLITICAL_DETAIL_MIN_ZOOM > FIEF_LABEL_MIN_ZOOM);
  assert(POLITICAL_DETAIL_MIN_ZOOM <= MAX_ZOOM);
});

Deno.test("politicalDetailVisibleAt は politicalDisplayLevel の overview 判定と一致する（判定の共有。#267 AC1）", () => {
  for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
    assertEquals(
      politicalDetailVisibleAt(z),
      politicalDisplayLevel(z) !== "overview",
      `zoom ${z} で判定が食い違う`,
    );
  }
});

// ---- #267: 境界・ラベル階層の構造分類（AC2） ----

Deno.test("politicalOverlayTier: SUBJECTO と PARTOF が別勢力なら下位（sub）（#267 AC2）", () => {
  // 直接の主君（SUBJECTO）が自身も上位勢力（PARTOF）の構成勢力である =
  // 2 段以上深い構造が宣言されている場合だけ下位に分類する
  assertEquals(
    politicalOverlayTier({
      NAME: "County of Tyrol",
      SUBJECTO: "Duchy of Bavaria",
      PARTOF: HRE_SUZERAIN_NAME,
    }),
    "sub",
  );
});

Deno.test("politicalOverlayTier: SUBJECTO = PARTOF は主要構成勢力（constituent）", () => {
  assertEquals(
    politicalOverlayTier({
      NAME: "Bavaria",
      SUBJECTO: HRE_SUZERAIN_NAME,
      PARTOF: HRE_SUZERAIN_NAME,
    }),
    "constituent",
  );
});

Deno.test("politicalOverlayTier: 構造が取得できない場合は constituent へフォールバック（AC2）", () => {
  // 仏諸侯領・伊諸侯領・ブリテン諸島の政体は SUBJECTO / PARTOF を持たない
  assertEquals(
    politicalOverlayTier({ NAME: "Duchy of Normandy" }),
    "constituent",
  );
  // 自己参照（SUBJECTO = NAME）は独立宣言であり深い構造ではない
  assertEquals(
    politicalOverlayTier({
      NAME: "Bohemia",
      SUBJECTO: "Bohemia",
      PARTOF: HRE_SUZERAIN_NAME,
    }),
    "constituent",
  );
  assertEquals(politicalOverlayTier(null), "constituent");
});

Deno.test("politicalLabelTier: kind=base は top、オーバーレイは構造分類に従う", () => {
  assertEquals(politicalLabelTier(undefined, { NAME: "France" }), "top");
  assertEquals(politicalLabelTier("base", { NAME: "France" }), "top");
  assertEquals(
    politicalLabelTier("hre", {
      NAME: "Bavaria",
      SUBJECTO: HRE_SUZERAIN_NAME,
      PARTOF: HRE_SUZERAIN_NAME,
    }),
    "constituent",
  );
  assertEquals(
    politicalLabelTier("fief", {
      NAME: "X",
      SUBJECTO: "Duchy of Bavaria",
      PARTOF: HRE_SUZERAIN_NAME,
    }),
    "sub",
  );
});

// ---- #267: ラベル優先度 = 表示階層 > 面積（AC6） ----

Deno.test("tieredLabelPriority: 表示階層の帯が面積より優先する（#267 AC6）", () => {
  // 最小面積の top が最大面積の constituent より必ず高い
  assert(
    tieredLabelPriority("top", MIN_LABEL_PRIORITY) >
      tieredLabelPriority("constituent", MAX_LABEL_PRIORITY),
  );
  // 最小面積の constituent が最大面積の sub より必ず高い
  assert(
    tieredLabelPriority("constituent", MIN_LABEL_PRIORITY) >
      tieredLabelPriority("sub", MAX_LABEL_PRIORITY),
  );
});

Deno.test("tieredLabelPriority: 同一階層内では面積の単調順を保つ", () => {
  for (const tier of ["top", "constituent", "sub"] as const) {
    assert(
      tieredLabelPriority(tier, 100) > tieredLabelPriority(tier, -100),
      `${tier} の面積順が壊れている`,
    );
  }
});

Deno.test("tieredLabelPriority: 結果は常に MIN..MAX_LABEL_PRIORITY に収まる", () => {
  for (const tier of ["top", "constituent", "sub"] as const) {
    for (const area of [MIN_LABEL_PRIORITY, 0, MAX_LABEL_PRIORITY]) {
      const p = tieredLabelPriority(tier, area);
      assert(
        p >= MIN_LABEL_PRIORITY && p <= MAX_LABEL_PRIORITY,
        `${tier}/${area} => ${p}`,
      );
    }
  }
});

Deno.test("buildLabelData は tier と階層込みの priority を付与する（#267 AC6）", () => {
  const baseFc: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      // 小さな独立勢力（top）
      feature({ type: "Polygon", coordinates: [squareRing(0, 0, 1)] }, {
        NAME: "Corsica",
      }),
    ],
  };
  const fiefFc: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      // それより広い諸侯領（constituent）
      feature({ type: "Polygon", coordinates: [squareRing(10, 0, 8)] }, {
        NAME: "Duchy of Aquitaine",
      }),
    ],
  };
  const base = buildLabelData(baseFc, {}, "base");
  const fief = buildLabelData(fiefFc, {}, "fief");
  assertEquals(base[0].tier, "top");
  assertEquals(fief[0].tier, "constituent");
  // 表示階層 > 面積: 面積で劣る top が constituent より高優先
  assert(base[0].priority > fief[0].priority);
  assertEquals(
    base[0].priority,
    tieredLabelPriority("top", labelPriorityFor(baseFc.features[0])),
  );
});

// ---- #267: 段別のラベルサイズ（AC5/AC6） ----

Deno.test("powerLabelSizePx: 階層とレベルでサイズ差が付く（#267 AC6）", () => {
  // 概観（z4）の top は最大（#228 の 18px を維持）
  assertEquals(
    powerLabelSizePx("top", "overview"),
    OVERVIEW_POWER_LABEL_SIZE_PX,
  );
  // 中間・詳細でも top > constituent > sub の視覚差を保つ
  for (const level of ["mid", "detail"] as const) {
    assertEquals(powerLabelSizePx("top", level), TOP_POWER_LABEL_SIZE_PX);
    assertEquals(powerLabelSizePx("constituent", level), POWER_LABEL_SIZE_PX);
    assertEquals(powerLabelSizePx("sub", level), SUB_POWER_LABEL_SIZE_PX);
    assert(
      powerLabelSizePx("top", level) > powerLabelSizePx("constituent", level),
    );
    assert(
      powerLabelSizePx("constituent", level) > powerLabelSizePx("sub", level),
    );
  }
  // 上位勢力名は詳細表示でも通常の構成勢力より大きい（AC9: 埋没しない）
  assert(TOP_POWER_LABEL_SIZE_PX > POWER_LABEL_SIZE_PX);
  assert(OVERVIEW_POWER_LABEL_SIZE_PX >= TOP_POWER_LABEL_SIZE_PX);
});

// ---- #267: 明色ラベル + 濃焦茶 halo（AC5） ----

Deno.test("政治ラベルは明色文字 + 濃い焦茶 halo（#267 AC5）", () => {
  // 文字色はクリーム〜白寄りの明色
  const [r, g, b, a] = POLITICAL_LABEL_COLOR;
  assert(r >= 200 && g >= 200 && b >= 200, "文字色が明色でない");
  assertEquals(a, 255);
  // halo は濃い焦茶（暖色系の暗いインク。R > G > B で真黒ではない）
  const [hr, hg, hb, ha] = POLITICAL_LABEL_HALO_COLOR;
  assert(hr < 100 && hg < 100 && hb < 100, "halo が暗色でない");
  assert(hr > hg && hg > hb, "halo が焦茶（暖色系）でない");
  assertEquals(ha, 255);
  // 強調時はさらに明るい（白寄り）方向で、暗転しない
  const active = ACTIVE_POLITICAL_LABEL_COLOR;
  assert(active[0] >= r && active[1] >= g && active[2] >= b);
});

// ---- #267: レベル別のラベル絞り込み（AC7/AC8/AC9） ----

/** 面積 priority がしきい値より上/下の constituent datum を作る */
function fiefDatumWithArea(name: string, size: number): LabelDatum {
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      feature({ type: "Polygon", coordinates: [squareRing(0, 0, size)] }, {
        NAME: name,
      }),
    ],
  };
  return buildLabelData(fc, {}, "fief")[0];
}

Deno.test("filterPowerLabelsByZoom: mid（z5〜6）は top + 大きめ constituent だけを出す（#267 AC8）", () => {
  const top: LabelDatum = {
    text: "フランス",
    position: [0, 0],
    priority: tieredLabelPriority("top", -300),
    kind: "base",
    tier: "top",
  };
  // 面積 priority がしきい値以上/未満の諸侯領
  const large = fiefDatumWithArea("Duchy of Aquitaine", 4); // area 16 => +120
  const small = fiefDatumWithArea("County of Foix", 0.3); // area 0.09 => -105
  const sub: LabelDatum = {
    text: "下位領",
    position: [1, 1],
    priority: tieredLabelPriority("sub", 100),
    kind: "hre",
    tier: "sub",
  };
  const mid = filterPowerLabelsByZoom(
    [top, large, small, sub],
    FIEF_LABEL_MIN_ZOOM,
  );
  assertEquals(mid.map((d) => d.text), ["フランス", large.text]);
  // 詳細（z7〜8）では小さい諸侯領も下位領も出す（AC9）
  const detail = filterPowerLabelsByZoom(
    [top, large, small, sub],
    POLITICAL_DETAIL_MIN_ZOOM,
  );
  assertEquals(detail.length, 4);
});

Deno.test("filterPowerLabelsByZoom: どのレベルでも top ラベルは残る（AC11: 全消失しない）", () => {
  const top: LabelDatum = {
    text: "フランス",
    position: [0, 0],
    priority: tieredLabelPriority("top", -1000),
    kind: "base",
    tier: "top",
  };
  for (const z of [MIN_ZOOM, FIEF_LABEL_MIN_ZOOM, POLITICAL_DETAIL_MIN_ZOOM]) {
    assert(
      filterPowerLabelsByZoom([top], z).includes(top),
      `zoom ${z} で top ラベルが消えた`,
    );
  }
});

Deno.test("MID_LEVEL_MIN_AREA_PRIORITY は実データの constituent 帯の内側にある", () => {
  // しきい値が高すぎる（> 全諸侯領の最大面積 priority ≈ 108）と mid で
  // constituent が全滅し、低すぎる（< 最小 ≈ -311）と密度抑制にならない
  assert(MID_LEVEL_MIN_AREA_PRIORITY > -311);
  assert(MID_LEVEL_MIN_AREA_PRIORITY < 108);
});

// ---- #308: 勢力ラベル専用 halo 幅（実効幅を CSS px で固定する） ----
// deck.gl の halo は「outlineWidth px」ではない。text-layer.js が
// outlineWidth / fontSettings.radius に正規化し、multi-icon-layer.js が
// outlineBuffer = max(smoothing, 0.75 * (1 - 正規化値)) を SDF の
// しきい値にする。SDF アトラスは fontSize 64 / cutoff 0.25 なので、
// 実効 halo は 0.75 * outlineWidth アトラス px = その fontSize/64 倍の CSS px。
// props の色とコントラストだけを見るテストでは、この太さの退行を防げない。

Deno.test("#308: labelHaloWidthPx は deck.gl の SDF 正規化を再現する", () => {
  // 定数は deck.gl の DEFAULT_FONT_SETTINGS / DEFAULT_BUFFER と同値
  assertEquals(SDF_ATLAS_FONT_SIZE_PX, 64);
  assertEquals(SDF_GLYPH_EDGE_VALUE, 0.75);
  // outlineWidth 0 なら halo 無し
  assertEquals(labelHaloWidthPx(0, 14), 0);
  // 実効幅 = 0.75 * outlineWidth * fontSize / 64（smoothing で頭打ちする前）
  assertEquals(
    labelHaloWidthPx(4, 64),
    3,
  );
  // fontSize に比例する
  assertEquals(labelHaloWidthPx(4, 32), 1.5);
  // smoothing 上限（outlineBuffer >= smoothing）で頭打ちになる
  const capped = labelHaloWidthPx(LABEL_SDF_RADIUS * 2, 64);
  assertEquals(
    capped,
    (SDF_GLYPH_EDGE_VALUE - LABEL_FONT_SETTINGS.smoothing) * LABEL_SDF_RADIUS,
  );
});

Deno.test("#308: 旧共通幅（5）は勢力ラベルで約 1 CSS px しかなく外枠に見えない", () => {
  // Issue #308 の真因。共通値 5 のままでは 14px ラベルで 0.82 CSS px
  const legacy = labelHaloWidthPx(5, POWER_LABEL_SIZE_PX);
  assert(
    legacy < 1.0,
    `旧幅の実効値 ${legacy} CSS px は 1 px 未満のはず（真因の固定）`,
  );
});

// ---- #333: 参考画像（案A）を規範にした固定標本 ----
//
// #267 / #308 / #322 の合格基準は「参考画像を表示階層の参考に弱める」
// 「1.2px 以上」「#308 の 1.3 倍・1.6〜2.6px」と、いずれも**参考画像との一致で
// はなかった**。ここで固定するのは docs/images/issue333-label-reference/ の
// 参考画像から実測した目標値そのもの（測定手順と生データは
// docs/research/issue-333-label-reference-targets.md）。

Deno.test("#333: 政治ラベルの実寸一覧（固定標本）が参考画像の目標値と一致する", () => {
  // 参考画像の実測から導いた 4 種の実寸。数値を動かすときは必ず参考画像との
  // 再比較（docs/images/issue333-label-reference/cmp-*.jpg）を伴うこと。
  assertEquals(politicalLabelRenderSpecTable(), [
    {
      tier: "top",
      level: "overview",
      group: "top",
      fontSizePx: 18,
      haloPx: 1.27,
      plateHeightPx: 28,
      platePaddingXPx: 5,
      plateBorderRadiusPx: 5,
      plateAlpha: 56,
    },
    {
      tier: "top",
      level: "detail",
      group: "top",
      fontSizePx: 16,
      haloPx: 1.13,
      plateHeightPx: 26,
      platePaddingXPx: 5,
      plateBorderRadiusPx: 5,
      plateAlpha: 56,
    },
    {
      tier: "constituent",
      level: "detail",
      group: "lower",
      fontSizePx: 14,
      haloPx: 1.15,
      plateHeightPx: 22,
      platePaddingXPx: 4,
      plateBorderRadiusPx: 4,
      plateAlpha: 56,
    },
    {
      tier: "sub",
      level: "detail",
      group: "lower",
      fontSizePx: 12,
      haloPx: 0.98,
      plateHeightPx: 20,
      platePaddingXPx: 4,
      plateBorderRadiusPx: 4,
      plateAlpha: 56,
    },
  ]);
});

Deno.test("#333: 濃色外縁は参考画像と同じ「絶対幅ほぼ一定」の帯に収まる", () => {
  // 参考画像の外縁は 20px の字で 1.3 px、15.3px の字で 1.2 px。フォント
  // サイズが 1.5 倍違っても絶対幅はほぼ変わらない。#322（14px で 1.97 CSS px
  // = 0.14 em）はこの帯の外にあり、12px ラベルのカウンター潰れ上限に張り付いて
  // いた。地色からの分離は下支えプレートが担うので外縁を太らせる必要は無い。
  for (const spec of politicalLabelRenderSpecTable()) {
    assert(
      spec.haloPx >= 0.9 && spec.haloPx <= 1.5,
      `${spec.tier}/${spec.fontSizePx}px の外縁 ${spec.haloPx} CSS px は 0.9〜1.5 のはず`,
    );
  }
  const widths = politicalLabelRenderSpecTable().map((s) => s.haloPx);
  assert(
    Math.max(...widths) / Math.min(...widths) < 1.4,
    `最大 ${Math.max(...widths)} / 最小 ${
      Math.min(...widths)
    } の比は 1.4 未満のはず`,
  );
});

Deno.test("#333 AC3: top と lower は独立した外縁・余白・角丸を持つ", () => {
  const top = politicalLabelStyleFor("top");
  const lower = politicalLabelStyleFor("lower");
  // 12px ラベルの制約（カウンター潰れ）が top を縛らない構造であること。
  // 同じ値なら「独立して調整できる」が成立していない。
  assertNotEquals(top.outlineWidth, lower.outlineWidth);
  assertNotEquals(top.platePadding, lower.platePadding);
  assertNotEquals(top.plateBorderRadiusPx, lower.plateBorderRadiusPx);
  // 参考画像では外縁の絶対幅が一定なので、小さい字の側（lower）の方が
  // フォントサイズ比では太い = outlineWidth も大きくなる
  assert(
    lower.outlineWidth > top.outlineWidth,
    "参考画像の外縁は絶対幅一定 = 小さい字の側の係数が大きいはず",
  );
  // グループ振り分けは tier から一意（top だけが専用スタイル）
  assertEquals(politicalLabelGroupOf("top"), "top");
  assertEquals(politicalLabelGroupOf("constituent"), "lower");
  assertEquals(politicalLabelGroupOf("sub"), "lower");
});

Deno.test("#333: 下支えプレートは濃色・低 alpha・クリーム 1px 縁（参考画像の実測）", () => {
  // 塗り: ink #3a2712 を alpha 56/255 ≈ 0.22 で敷く。参考画像の実測は
  // HRE（苔緑の領土）0.219/0.206/0.242、ポーランド（淡橙の領土）
  // 0.192/0.200/0.244 で、地色によらず同じ = 一定 alpha の濃色オーバーレイ。
  assertEquals(POLITICAL_LABEL_PLATE_COLOR, [58, 39, 18, 56]);
  assertEquals(
    [
      POLITICAL_LABEL_PLATE_COLOR[0],
      POLITICAL_LABEL_PLATE_COLOR[1],
      POLITICAL_LABEL_PLATE_COLOR[2],
    ],
    [
      POLITICAL_LABEL_HALO_COLOR[0],
      POLITICAL_LABEL_HALO_COLOR[1],
      POLITICAL_LABEL_HALO_COLOR[2],
    ],
    "プレートの色相は濃色外縁と同じインク（古地図の一貫した語彙）",
  );
  // TASK-72 が撤去したのは「クリームを alpha 200 で敷いた明色パネル」。
  // 明暗が逆で濃度も 1/3 以下であることを固定し、白枠の再来を防ぐ。
  const TASK_72_PANEL_ALPHA = 200;
  assert(POLITICAL_LABEL_PLATE_COLOR[3] < TASK_72_PANEL_ALPHA / 3);
  const plateLum = POLITICAL_LABEL_PLATE_COLOR.slice(0, 3)
    .reduce((a, b) => a + b, 0) / 3;
  const textLum = POLITICAL_LABEL_COLOR.slice(0, 3).reduce((a, b) => a + b, 0) /
    3;
  assert(plateLum < textLum, "プレートは文字より暗いはず（明暗の反転を防ぐ）");
  // 縁: クリーム #f4ecd7 を alpha 128 で 1px。参考画像では外周 2px に
  // 合計 0.55 px·α 相当の明色帯があり、1px × alpha 0.50 とほぼ一致する。
  assertEquals(POLITICAL_LABEL_PLATE_BORDER_COLOR, [244, 236, 215, 128]);
  assertEquals(
    POLITICAL_LABEL_PLATE_BORDER_COLOR.slice(0, 3),
    LABEL_OUTLINE_COLOR.slice(0, 3),
    "プレートの縁は共通クリーム halo と同じ色相",
  );
  assertEquals(POLITICAL_LABEL_PLATE_BORDER_WIDTH_PX, 1);
});

Deno.test("#333: プレートの高さ・余白・角丸はフォントサイズ比で参考画像と揃う", () => {
  // 参考画像: プレート高 = フォントの 1.60 倍、左右余白 0.275 em、
  // 角丸 0.28 em（「神聖ローマ帝国」= 約 20px、プレート 151x32px、角丸 5〜6px）。
  for (const spec of politicalLabelRenderSpecTable()) {
    const heightRatio = spec.plateHeightPx / spec.fontSizePx;
    assert(
      heightRatio >= 1.5 && heightRatio <= 1.72,
      `${spec.tier}/${spec.fontSizePx}px のプレート高比 ${heightRatio} は 1.50〜1.72 のはず`,
    );
    const padRatio = spec.platePaddingXPx / spec.fontSizePx;
    assert(
      padRatio >= 0.25 && padRatio <= 0.36,
      `${spec.tier}/${spec.fontSizePx}px の左右余白比 ${padRatio} は 0.25〜0.36 のはず`,
    );
    const radiusRatio = spec.plateBorderRadiusPx / spec.fontSizePx;
    assert(
      radiusRatio >= 0.25 && radiusRatio <= 0.36,
      `${spec.tier}/${spec.fontSizePx}px の角丸比 ${radiusRatio} は 0.25〜0.36 のはず`,
    );
  }
});

Deno.test("#333: filterPoliticalLabelsByGroup は網羅的かつ排他的に振り分ける", () => {
  const data: LabelDatum[] = [
    { text: "フランス王国", position: [0, 0], priority: 700, tier: "top" },
    {
      text: "ノルマンディー公領",
      position: [1, 1],
      priority: 0,
      tier: "constituent",
    },
    { text: "小領", position: [2, 2], priority: -700, tier: "sub" },
    // tier 未付与（後方互換フォールバック: kind から解決 → base = top）
    { text: "旧形式", position: [3, 3], priority: 0, kind: "base" },
  ];
  const top = filterPoliticalLabelsByGroup(data, "top");
  const lower = filterPoliticalLabelsByGroup(data, "lower");
  assertEquals(top.map((d) => d.text), ["フランス王国", "旧形式"]);
  assertEquals(lower.map((d) => d.text), ["ノルマンディー公領", "小領"]);
  assertEquals(top.length + lower.length, data.length);
  // 元配列を壊さない（メモ化の前提）
  assertEquals(data.length, 4);
});

Deno.test("#322: 勢力ラベル専用 fontSettings は halo をアトラスに収め頭打ちも避ける", () => {
  const { buffer, radius, smoothing } = POLITICAL_LABEL_FONT_SETTINGS;
  // #333: 幅は階層別になったので、最も太い側で判定する
  const widest = Math.max(
    POLITICAL_LABEL_STYLES.top.outlineWidth,
    POLITICAL_LABEL_STYLES.lower.outlineWidth,
  );
  // アトラス上の halo 幅 + アンチエイリアスの外側の裾（gamma = smoothing）が
  // buffer 内に収まる（超えるとグリフ端で halo がクリップする）
  const atlasHaloPx = SDF_GLYPH_EDGE_VALUE * widest;
  const featherPx = smoothing * radius;
  assert(
    atlasHaloPx + featherPx <= buffer,
    `halo ${atlasHaloPx} + 裾 ${featherPx} は buffer=${buffer} 以内のはず`,
  );
  // outlineBuffer が smoothing 下限に張り付かない（張り付くと幅が効かない）
  const outlineBuffer = SDF_GLYPH_EDGE_VALUE * (1 - widest / radius);
  assert(
    outlineBuffer > smoothing * 2,
    `outlineBuffer=${outlineBuffer} は smoothing=${smoothing} から十分離れるはず`,
  );
  // 文字自体のアンチエイリアス幅（atlas px）は共通設定と同じ = 字面が変わらない
  assertEquals(
    smoothing * radius,
    LABEL_FONT_SETTINGS.smoothing * LABEL_FONT_SETTINGS.radius,
  );
  // 専用設定はフォントアトラスのキャッシュキー（fontFamily/weight/fontSize/
  // buffer/radius/cutoff）で共通設定と別物になる = 専用アトラスになる。
  // #333 で層が 2 枚になっても両層はこの同一設定を共有するのでアトラスは
  // 増えない（キーに outlineWidth は入らない）。
  const key = (fs: { buffer: number; radius: number }) =>
    `${fs.buffer}/${fs.radius}`;
  assertNotEquals(
    key(POLITICAL_LABEL_FONT_SETTINGS),
    key(LABEL_FONT_SETTINGS),
    "専用 fontSettings は buffer か radius が共通設定と異なるはず",
  );
  assertEquals(POLITICAL_LABEL_FONT_SETTINGS.sdf, true);
});

Deno.test("#308: 共通 halo 設定（注記ラベル用）は変更されない", () => {
  // 都市・河川・山岳のクリーム halo は #308 の対象外（AC: 見た目を変えない）
  assertEquals(LABEL_OUTLINE_WIDTH, 5);
  assertEquals(labelTextStyleProps().outlineWidth, LABEL_OUTLINE_WIDTH);
  assertEquals(labelTextStyleProps().outlineColor, [...LABEL_OUTLINE_COLOR]);
  // fontSettings も不変 = フォントアトラス（キーは fontFamily/weight/fontSize/
  // buffer/radius/cutoff）は全ラベル層で共有され続け、再生成されない
  assertEquals(LABEL_FONT_SETTINGS, {
    sdf: true,
    smoothing: 0.1,
    buffer: 8,
    radius: 12,
  });
});
