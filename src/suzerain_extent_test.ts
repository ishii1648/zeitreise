import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import type { Feature, FeatureCollection, Position } from "geojson";
import {
  applySuzerainOverrides,
  buildSuzerainExtent,
  createDetailFocusTracker,
  createSuzerainExtentCache,
  detailFocusAppliesAt,
  detailFocusKeyAt,
  detailFocusKeyForZoom,
  EMPTY_SUZERAIN_OVERRIDES,
  extractSuzerainMembers,
  parseSuzerainOverrides,
  resolveSuzerainKey,
  type SuzerainExtentBands,
  suzerainExtentKey,
  type SuzerainOverrides,
  UNRESOLVED_DETAIL_FOCUS_KEY,
  withSuzerainOverrides,
} from "./suzerain_extent.ts";
import { coastalBandsForSuzerain } from "./coastal_fill.ts";
import {
  createBorrowedHreLoader,
  createHreOverlayLoader,
  withBorrowedGeometry,
  YEAR_CACHE_MAX_YEARS,
  type YearDataLoader,
} from "./powers.ts";
import {
  BRITAIN_FIEF_LAYER_ID,
  CITY_LAYER_ID,
  CLIOPATRIA_FIEF_LAYER_ID,
  FRANCE_FIEF_LAYER_ID,
  HRE_LAYER_ID,
  ITALY_FIEF_LAYER_ID,
  POWER_LAYER_ID,
  RIVERS_LAYER_ID,
  SOVEREIGN_FIEF_LAYER_ID,
} from "./picking.ts";

const HRE = "Holy Roman Empire";

/** テスト用の overrides を組み立てる */
function overrides(
  renames: Record<string, string> = {},
  suzerains: Record<string, string> = {},
): SuzerainOverrides {
  return { renames, suzerains };
}

/** テスト用の Feature を組み立てる（既定は単位正方形） */
function feature(
  properties: Feature["properties"],
  ring: Position[] = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]],
): Feature {
  return {
    type: "Feature",
    properties,
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}

/** 矩形リング（左下 x,y から幅 w 高さ h） */
function box(x: number, y: number, w = 1, h = 1): Position[] {
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
}

function collection(features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

// ---- parseSuzerainOverrides ----

Deno.test("parseSuzerainOverrides は renames と suzerains を読む", () => {
  const parsed = parseSuzerainOverrides({
    renames: { Castilla: "Castile" },
    suzerains: { Britany: "France" },
  });
  assertEquals(parsed.renames, { Castilla: "Castile" });
  assertEquals(parsed.suzerains, { Britany: "France" });
});

Deno.test("parseSuzerainOverrides は欠落・不正な入力で空マップを返す", () => {
  assertEquals(parseSuzerainOverrides(null), EMPTY_SUZERAIN_OVERRIDES);
  assertEquals(parseSuzerainOverrides({}), EMPTY_SUZERAIN_OVERRIDES);
  assertEquals(
    parseSuzerainOverrides({ renames: "x", suzerains: 1 }),
    EMPTY_SUZERAIN_OVERRIDES,
  );
});

// ---- resolveSuzerainKey ----

Deno.test("resolveSuzerainKey は SUBJECTO を宗主キーとして返す", () => {
  assertEquals(
    resolveSuzerainKey(
      { NAME: "Kingdom of France", SUBJECTO: "France" },
      EMPTY_SUZERAIN_OVERRIDES,
    ),
    "France",
  );
});

Deno.test("resolveSuzerainKey は独立勢力（SUBJECTO が自己参照）で NAME を返す", () => {
  assertEquals(
    resolveSuzerainKey(
      { NAME: "Denmark", SUBJECTO: "Denmark" },
      EMPTY_SUZERAIN_OVERRIDES,
    ),
    "Denmark",
  );
});

Deno.test("resolveSuzerainKey は SUBJECTO を renames で正規化する", () => {
  // europe_1200 の Castile は SUBJECTO が綴りゆれ "Castilla"。正規化すると
  // NAME と一致するため独立勢力として扱われる
  assertEquals(
    resolveSuzerainKey(
      { NAME: "Castile", SUBJECTO: "Castilla" },
      overrides({ Castilla: "Castile" }),
    ),
    "Castile",
  );
});

Deno.test("resolveSuzerainKey は SUBJECTO 欠落時に NAME へフォールバックする", () => {
  // 仏諸侯領オーバーレイ（france_fiefs_flat_*）は SUBJECTO を持たない
  assertEquals(
    resolveSuzerainKey({ NAME: "Normandy" }, EMPTY_SUZERAIN_OVERRIDES),
    "Normandy",
  );
});

Deno.test("resolveSuzerainKey は宗主補正テーブルを SUBJECTO より優先する", () => {
  // base は Britany を独立勢力として持つが、史実ではフランス王の封土
  assertEquals(
    resolveSuzerainKey(
      { NAME: "Britany", SUBJECTO: "Britany" },
      overrides({}, { Britany: "France" }),
    ),
    "France",
  );
});

Deno.test("resolveSuzerainKey は補正適用後も冪等（SUBJECTO 書き換え済みでも同じ）", () => {
  assertEquals(
    resolveSuzerainKey(
      { NAME: "Britany", SUBJECTO: "France" },
      overrides({}, { Britany: "France" }),
    ),
    "France",
  );
});

Deno.test("resolveSuzerainKey は NAME を持たない feature で null", () => {
  assertEquals(resolveSuzerainKey(null, EMPTY_SUZERAIN_OVERRIDES), null);
  assertEquals(resolveSuzerainKey({}, EMPTY_SUZERAIN_OVERRIDES), null);
  assertEquals(
    resolveSuzerainKey({ NAME: "" }, EMPTY_SUZERAIN_OVERRIDES),
    null,
  );
});

// ---- suzerainExtentKey ----

/** base 側の feature を使わない経路のための空 base */
const NO_BASE: FeatureCollection = { type: "FeatureCollection", features: [] };

Deno.test("suzerainExtentKey は powers レイヤーで宗主キーを返す", () => {
  assertEquals(
    suzerainExtentKey(
      POWER_LAYER_ID,
      feature({ NAME: "Comté de Toulouse", SUBJECTO: "France" }),
      NO_BASE,
      EMPTY_SUZERAIN_OVERRIDES,
    ),
    "France",
  );
});

Deno.test("suzerainExtentKey は HRE 本体・従属勢力で Holy Roman Empire を返す", () => {
  assertEquals(
    suzerainExtentKey(
      POWER_LAYER_ID,
      feature({ NAME: HRE, SUBJECTO: HRE }),
      NO_BASE,
      EMPTY_SUZERAIN_OVERRIDES,
    ),
    HRE,
  );
  assertEquals(
    suzerainExtentKey(
      POWER_LAYER_ID,
      feature({ NAME: "Duchy of Swabia", SUBJECTO: HRE }),
      NO_BASE,
      EMPTY_SUZERAIN_OVERRIDES,
    ),
    HRE,
  );
});

Deno.test("suzerainExtentKey は hre-powers レイヤーの領邦で宗主キーを返す", () => {
  // 領邦オーバーレイは全 feature が SUBJECTO=Holy Roman Empire
  assertEquals(
    suzerainExtentKey(
      HRE_LAYER_ID,
      feature({ NAME: "Bavaria", SUBJECTO: HRE }),
      NO_BASE,
      EMPTY_SUZERAIN_OVERRIDES,
    ),
    HRE,
  );
});

Deno.test("suzerainExtentKey は単独勢力で自分自身のキーを返す", () => {
  assertEquals(
    suzerainExtentKey(
      POWER_LAYER_ID,
      feature({ NAME: "Denmark", SUBJECTO: "Denmark" }),
      NO_BASE,
      EMPTY_SUZERAIN_OVERRIDES,
    ),
    "Denmark",
  );
});

Deno.test("suzerainExtentKey は都市・河川・picking なしで null", () => {
  assertEquals(
    suzerainExtentKey(
      CITY_LAYER_ID,
      undefined,
      NO_BASE,
      EMPTY_SUZERAIN_OVERRIDES,
    ),
    null,
  );
  assertEquals(
    suzerainExtentKey(
      RIVERS_LAYER_ID,
      feature({ NAME: "Rhine" }),
      NO_BASE,
      EMPTY_SUZERAIN_OVERRIDES,
    ),
    null,
  );
  assertEquals(
    suzerainExtentKey(undefined, undefined, NO_BASE, EMPTY_SUZERAIN_OVERRIDES),
    null,
  );
});

// ---- 諸侯領オーバーレイの外枠（TASK-120） ----
//
// 仏諸侯領（france-fiefs）と Cliopatria 由来の領邦（cliopatria-fiefs）は
// SUBJECTO を持たないため、宗主キーは「その封土が base のどの勢力の内側に
// あるか」で解決する。以下は synthetic な base（フランス王国の内側に封土、
// 外側に独立公国）でその規則を固定する。

/** base: フランス王国（0,0-4,4）／独立公国（5,0-7,2）／帝国（8,0-12,4） */
const FIEF_BASE = collection([
  feature({ NAME: "Kingdom of France", SUBJECTO: "France" }, box(0, 0, 4, 4)),
  feature(
    { NAME: "Duchy of Normandy", SUBJECTO: "Duchy of Normandy" },
    box(5, 0, 2, 2),
  ),
  feature({ NAME: HRE, SUBJECTO: HRE }, box(8, 0, 4, 4)),
]);

Deno.test("suzerainExtentKey は france-fiefs の封土を包含する base 勢力の宗主キーへ解決する", () => {
  assertEquals(
    suzerainExtentKey(
      FRANCE_FIEF_LAYER_ID,
      feature({ NAME: "County of Anjou" }, box(1, 1)),
      FIEF_BASE,
      EMPTY_SUZERAIN_OVERRIDES,
    ),
    "France",
  );
});

Deno.test("suzerainExtentKey は cliopatria-fiefs の仏封土も同じ規則で解決する", () => {
  assertEquals(
    suzerainExtentKey(
      CLIOPATRIA_FIEF_LAYER_ID,
      feature({ NAME: "Royal Domain of France" }, box(2, 2)),
      FIEF_BASE,
      EMPTY_SUZERAIN_OVERRIDES,
    ),
    "France",
  );
});

Deno.test("suzerainExtentKey は britain-fiefs の政体も包含する base 勢力の宗主キーへ解決する（#172）", () => {
  // TASK-151 の生成物は SUBJECTO を持たない（仏諸侯領と同型）ため、宗主キーは
  // 「その政体のラベル地点を base のどの勢力が塗っているか」で決まる。実データ
  // では 1000〜1200 のウェールズ・アイルランド諸王国が base の Celtic kingdoms
  // へ、1600〜1700 のアイルランド王国が England and Ireland へ解決する
  // （伊諸侯領のコルシカと同じ「base の塗りが答えになる」規則。TASK-121）。
  assertEquals(
    suzerainExtentKey(
      BRITAIN_FIEF_LAYER_ID,
      feature({ NAME: "Kingdom of Gwynedd" }, box(1, 1)),
      FIEF_BASE,
      EMPTY_SUZERAIN_OVERRIDES,
    ),
    "France",
  );
  // base のどの勢力にも包含されない（海側へはみ出す等）場合は外枠なし
  assertEquals(
    suzerainExtentKey(
      BRITAIN_FIEF_LAYER_ID,
      feature({ NAME: "Sodor" }, box(20, 20)),
      FIEF_BASE,
      EMPTY_SUZERAIN_OVERRIDES,
    ),
    null,
  );
});

Deno.test("suzerainExtentKey は sovereign-fiefs の政体も包含する base 勢力の宗主キーへ解決する（#189）", () => {
  // #189 の生成物は SUBJECTO を持たない（仏諸侯領と同型）ため、宗主キーは
  // 「その政体のラベル地点を base のどの勢力が塗っているか」で決まる。実データ
  // では 1650 年のクリミア・ハン国が base の Ottoman Empire へ、1815 年の
  // フィンランド大公国が Russian Empire へ解決する（TASK-121 と同じ規則）。
  assertEquals(
    suzerainExtentKey(
      SOVEREIGN_FIEF_LAYER_ID,
      feature({ NAME: "Crimean Khanate" }, box(1, 1)),
      FIEF_BASE,
      EMPTY_SUZERAIN_OVERRIDES,
    ),
    "France",
  );
  // base のどの勢力にも包含されない場合は外枠なし
  assertEquals(
    suzerainExtentKey(
      SOVEREIGN_FIEF_LAYER_ID,
      feature({ NAME: "Grand Duchy of Finland" }, box(20, 20)),
      FIEF_BASE,
      EMPTY_SUZERAIN_OVERRIDES,
    ),
    null,
  );
});

Deno.test("suzerainExtentKey は SUBJECTO を持つ領邦では宣言された宗主を優先する", () => {
  // Cliopatria 由来の HRE 領邦（1279 以降）は SUBJECTO を持つ。
  // 幾何を見るまでもなく帝国キーへ解決する（従来の hre-powers と同じ規則）。
  assertEquals(
    suzerainExtentKey(
      CLIOPATRIA_FIEF_LAYER_ID,
      feature({ NAME: "Duchy of Bavaria", SUBJECTO: HRE }, box(9, 1)),
      FIEF_BASE,
      EMPTY_SUZERAIN_OVERRIDES,
    ),
    HRE,
  );
});

Deno.test("suzerainExtentKey は独立勢力の内側の封土でその勢力自身のキーを返す", () => {
  // 包含する base が独立公国なら、封土側をホバーしても公国自身が囲まれる。
  assertEquals(
    suzerainExtentKey(
      FRANCE_FIEF_LAYER_ID,
      feature({ NAME: "Duchy of Normandy" }, box(5.5, 0.5)),
      FIEF_BASE,
      EMPTY_SUZERAIN_OVERRIDES,
    ),
    "Duchy of Normandy",
  );
});

Deno.test("suzerainExtentKey は宗主補正を包含判定より優先する", () => {
  assertEquals(
    suzerainExtentKey(
      FRANCE_FIEF_LAYER_ID,
      feature({ NAME: "Duchy of Brittany" }, box(9, 1)),
      FIEF_BASE,
      overrides({}, { "Duchy of Brittany": "France" }),
    ),
    "France",
  );
});

// ---- 伊諸侯領の外枠（TASK-121） ----
//
// 伊諸侯領（italy-fiefs）も SUBJECTO / PARTOF を 1 件も持たないため、仏諸侯領・
// Cliopatria 領邦とまったく同じ包含の規則に載せる（decision-27）。帝国イタリア
// 側・教皇領側・事実上独立の都市共和国という帰属の混在は、実装者が史実判断を
// 下すのではなく「base がその土地をどう塗っているか」がそのまま答えになる。

/** base: 帝国（0,0-6,6）／教皇領（6,0-9,3）／独立の島（20,20-22,22） */
const ITALY_BASE = collection([
  feature({ NAME: HRE, SUBJECTO: HRE }, box(0, 0, 6, 6)),
  feature({ NAME: "Papal States", SUBJECTO: "Papal States" }, box(6, 0, 3, 3)),
  feature({ NAME: "Corsica", SUBJECTO: "Corsica" }, box(20, 20, 2, 2)),
]);

Deno.test("suzerainExtentKey は italy-fiefs の帝国イタリア側の封土を帝国へ解決する", () => {
  assertEquals(
    suzerainExtentKey(
      ITALY_FIEF_LAYER_ID,
      feature({ NAME: "March of Montferrat" }, box(1, 1)),
      ITALY_BASE,
      EMPTY_SUZERAIN_OVERRIDES,
    ),
    HRE,
  );
});

Deno.test("suzerainExtentKey は italy-fiefs の教皇領側の封土を教皇領へ解決する", () => {
  assertEquals(
    suzerainExtentKey(
      ITALY_FIEF_LAYER_ID,
      feature({ NAME: "Republic of Ancona" }, box(7, 1)),
      ITALY_BASE,
      EMPTY_SUZERAIN_OVERRIDES,
    ),
    "Papal States",
  );
});

Deno.test("suzerainExtentKey は italy-fiefs の封土がラベル位置の base 勢力へ解決する", () => {
  // 都市共和国は「実質独立だが名目上は帝国」という両義の存在で、どちらへ寄せる
  // かは実装者の史実解釈になる。包含の規則はその判断を base に委ねる（base が
  // 帝国色で塗る土地にラベルが立つなら帝国の外枠が出る）。ここでは規則が
  // ラベルのアンカーだけを見ることを、独立の島に載る封土で固定する
  // （実データではピサ／ジェノヴァのコルシカがこの形になる）。
  assertEquals(
    suzerainExtentKey(
      ITALY_FIEF_LAYER_ID,
      feature({ NAME: "Republic of Genoa" }, box(20.5, 20.5, 0.5, 0.5)),
      ITALY_BASE,
      EMPTY_SUZERAIN_OVERRIDES,
    ),
    "Corsica",
  );
});

Deno.test("suzerainExtentKey はどの base 勢力にも含まれない封土で null", () => {
  assertEquals(
    suzerainExtentKey(
      FRANCE_FIEF_LAYER_ID,
      feature({ NAME: "County of Nowhere" }, box(20, 20)),
      FIEF_BASE,
      EMPTY_SUZERAIN_OVERRIDES,
    ),
    null,
  );
});

// ---- 地図中央の詳細表示 focus（#345 / #293 分割 1/5） ----
//
// 中央が属する上位勢力（宗主キー）を base の包含から決める。本タスクでは
// 解決と保持だけを作り、描画・picking・塗りへは渡さない。

/** focus 判定用 base: フランス王国（0,0-4,4）／帝国（4,0-8,4）／点 feature */
const FOCUS_BASE = collection([
  feature({ NAME: "Kingdom of France", SUBJECTO: "France" }, box(0, 0, 4, 4)),
  feature({ NAME: HRE, SUBJECTO: HRE }, box(4, 0, 4, 4)),
  {
    type: "Feature",
    properties: { NAME: "Point power", SUBJECTO: "Point power" },
    geometry: { type: "Point", coordinates: [2, 2] },
  } as Feature,
]);

Deno.test("detailFocusKeyAt は中央を含む base 勢力の宗主キーを返す", () => {
  assertEquals(
    detailFocusKeyAt([2, 2], FOCUS_BASE, EMPTY_SUZERAIN_OVERRIDES, null),
    "France",
  );
  assertEquals(
    detailFocusKeyAt([6, 2], FOCUS_BASE, EMPTY_SUZERAIN_OVERRIDES, null),
    HRE,
  );
});

Deno.test("detailFocusKeyAt は従属勢力の上でも宗主キー（上位勢力）を返す", () => {
  const base = collection([
    feature({ NAME: "Duchy of Bavaria", SUBJECTO: HRE }, box(0, 0, 2, 2)),
  ]);
  assertEquals(
    detailFocusKeyAt([1, 1], base, EMPTY_SUZERAIN_OVERRIDES, null),
    HRE,
  );
});

Deno.test("detailFocusKeyAt は宗主補正を宗主キー解決へ効かせる", () => {
  const base = collection([
    feature({ NAME: "Britany", SUBJECTO: "Britany" }, box(0, 0, 2, 2)),
  ]);
  assertEquals(
    detailFocusKeyAt(
      [1, 1],
      base,
      overrides({}, { Britany: "France" }),
      null,
    ),
    "France",
  );
});

Deno.test("detailFocusKeyAt は海上（base 勢力の外）で null を返す", () => {
  assertEquals(
    detailFocusKeyAt([20, 20], FOCUS_BASE, EMPTY_SUZERAIN_OVERRIDES, null),
    null,
  );
  // 直前の focus があっても、外れた時点で focus 無しに落ちる
  assertEquals(
    detailFocusKeyAt([20, 20], FOCUS_BASE, EMPTY_SUZERAIN_OVERRIDES, "France"),
    null,
  );
});

Deno.test("detailFocusKeyAt は複数候補（境界上）で現在の focus を優先する", () => {
  // x=4 はフランス王国と帝国の共有辺。どちらのポリゴンも点を含むと判定されるため
  // 候補が 2 件になる。パン停止のたびに交互へ振れないよう現 focus を優先する
  assertEquals(
    detailFocusKeyAt([4, 2], FOCUS_BASE, EMPTY_SUZERAIN_OVERRIDES, HRE),
    HRE,
  );
  assertEquals(
    detailFocusKeyAt([4, 2], FOCUS_BASE, EMPTY_SUZERAIN_OVERRIDES, "France"),
    "France",
  );
});

Deno.test("detailFocusKeyAt は複数候補でも現 focus が候補外なら決定的に先頭を返す", () => {
  assertEquals(
    detailFocusKeyAt([4, 2], FOCUS_BASE, EMPTY_SUZERAIN_OVERRIDES, "Denmark"),
    "France",
  );
  assertEquals(
    detailFocusKeyAt([4, 2], FOCUS_BASE, EMPTY_SUZERAIN_OVERRIDES, null),
    "France",
  );
});

/** map.on の購読先を記録する最小の疑似 Map（maplibre 非依存） */
function fakeMap() {
  const listeners = new Map<string, (() => void)[]>();
  return {
    subscribedTypes: () => [...listeners.keys()],
    on(type: string, listener: () => void) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    emit(type: string) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
  };
}

Deno.test("createDetailFocusTracker は解決前 null で、refresh で中央から focus を決める", () => {
  const map = fakeMap();
  const tracker = createDetailFocusTracker({
    getCenter: () => [2, 2],
    getBase: () => FOCUS_BASE,
    getOverrides: () => EMPTY_SUZERAIN_OVERRIDES,
    onMoveEnd: (listener) => map.on("moveend", listener),
  });
  assertEquals(tracker.key(), null);
  assertEquals(tracker.center(), null);
  tracker.refresh();
  assertEquals(tracker.key(), "France");
  assertEquals(tracker.center(), [2, 2]);
});

Deno.test("createDetailFocusTracker は moveend でだけ再解決し、move / zoom の連続発火では再計算しない", () => {
  const map = fakeMap();
  let center: Position = [2, 2];
  let resolves = 0;
  const tracker = createDetailFocusTracker({
    getCenter: () => {
      resolves++;
      return center;
    },
    getBase: () => FOCUS_BASE,
    getOverrides: () => EMPTY_SUZERAIN_OVERRIDES,
    onMoveEnd: (listener) => map.on("moveend", listener),
  });
  // 購読するのは moveend だけ（move / zoom の高頻度発火は拾わない）
  assertEquals(map.subscribedTypes(), ["moveend"]);

  map.emit("moveend");
  assertEquals(resolves, 1);
  assertEquals(tracker.key(), "France");

  // パン中（move）・ズーム中（zoom）に中央が帝国側へ動いても再計算しない
  center = [6, 2];
  for (let i = 0; i < 5; i++) map.emit("move");
  for (let i = 0; i < 5; i++) map.emit("zoom");
  assertEquals(resolves, 1);
  assertEquals(tracker.key(), "France");
  assertEquals(tracker.center(), [2, 2]);

  // パン停止（moveend）で 1 度だけ再解決する
  map.emit("moveend");
  assertEquals(resolves, 2);
  assertEquals(tracker.key(), HRE);
  assertEquals(tracker.center(), [6, 2]);
});

Deno.test("createDetailFocusTracker は年代変更（base 差し替え）で同じ中央から再解決する", () => {
  const map = fakeMap();
  let base = FOCUS_BASE;
  const tracker = createDetailFocusTracker({
    getCenter: () => [2, 2],
    getBase: () => base,
    getOverrides: () => EMPTY_SUZERAIN_OVERRIDES,
    onMoveEnd: (listener) => map.on("moveend", listener),
  });
  map.emit("moveend");
  assertEquals(tracker.key(), "France");
  // 年代切替: 同じ土地を別の勢力が塗る新年代の base へ差し替える
  base = collection([
    feature(
      { NAME: "French Empire", SUBJECTO: "French Empire" },
      box(0, 0, 4, 4),
    ),
  ]);
  tracker.refresh();
  assertEquals(tracker.key(), "French Empire");
});

Deno.test("createDetailFocusTracker は年代データ未確定（base なし）で focus を持たない", () => {
  const map = fakeMap();
  let base: FeatureCollection | null = null;
  const tracker = createDetailFocusTracker({
    getCenter: () => [2, 2],
    getBase: () => base,
    getOverrides: () => EMPTY_SUZERAIN_OVERRIDES,
    onMoveEnd: (listener) => map.on("moveend", listener),
  });
  map.emit("moveend");
  assertEquals(tracker.key(), null);
  base = FOCUS_BASE;
  map.emit("moveend");
  assertEquals(tracker.key(), "France");
});

Deno.test("createDetailFocusTracker は境界上のパン停止で現在の focus を保つ", () => {
  const map = fakeMap();
  let center: Position = [6, 2];
  const tracker = createDetailFocusTracker({
    getCenter: () => center,
    getBase: () => FOCUS_BASE,
    getOverrides: () => EMPTY_SUZERAIN_OVERRIDES,
    onMoveEnd: (listener) => map.on("moveend", listener),
  });
  map.emit("moveend");
  assertEquals(tracker.key(), HRE);
  // 共有辺の真上で止まっても、直前の focus が候補にあるならそのまま
  center = [4, 2];
  map.emit("moveend");
  assertEquals(tracker.key(), HRE);
});

// ---- #350: 描画へ渡す focus（ズームゲート + 解決不能の表現） ----

Deno.test("detailFocusKeyForZoom は z4（概観表示）で focus を無効化する（#350 AC8）", () => {
  assertEquals(detailFocusAppliesAt(4), false);
  assertEquals(detailFocusKeyForZoom("France", 4), null);
  assertEquals(detailFocusKeyForZoom(null, 4), null);
  // 小数ズームでも整数段で判定する（politicalDetailVisibleAt と同じ規則）
  assertEquals(detailFocusKeyForZoom("France", 4.9), null);
});

Deno.test("detailFocusKeyForZoom は z5 以上で focus をそのまま渡す（#350 AC1）", () => {
  assertEquals(detailFocusAppliesAt(5), true);
  assertEquals(detailFocusKeyForZoom("France", 5), "France");
  assertEquals(detailFocusKeyForZoom("France", 8), "France");
});

Deno.test("detailFocusKeyForZoom は z5 以上の解決不能を専用キーへ落とす（#350 AC5）", () => {
  // 中央が海上 = 詳細表示を行わない。null をそのまま渡すと「focus 機能オフ」
  // （= 全領邦を描く）と区別できないため、どの宗主にも一致しない専用キーにする
  assertEquals(detailFocusKeyForZoom(null, 5), UNRESOLVED_DETAIL_FOCUS_KEY);
  assertEquals(detailFocusKeyForZoom(null, 7), UNRESOLVED_DETAIL_FOCUS_KEY);
});

Deno.test("UNRESOLVED_DETAIL_FOCUS_KEY はどの feature の宗主キーにもならない（#350 AC5）", () => {
  for (const f of FOCUS_BASE.features) {
    assert(
      resolveSuzerainKey(f.properties, EMPTY_SUZERAIN_OVERRIDES) !==
        UNRESOLVED_DETAIL_FOCUS_KEY,
    );
  }
  // 実在の NAME / SUBJECTO に現れ得ない制御文字を含む
  assert(UNRESOLVED_DETAIL_FOCUS_KEY.includes("\u0000"));
});

Deno.test("createDetailFocusTracker の refresh は focus が変わったときだけ true を返す（#350 AC7）", () => {
  const map = fakeMap();
  let center: Position = [2, 2];
  const tracker = createDetailFocusTracker({
    getCenter: () => center,
    getBase: () => FOCUS_BASE,
    getOverrides: () => EMPTY_SUZERAIN_OVERRIDES,
    onMoveEnd: (listener) => map.on("moveend", listener),
  });
  // null → "France"
  assertEquals(tracker.refresh(), true);
  // 同じ中央・同じ base では変化なし
  assertEquals(tracker.refresh(), false);
  center = [6, 2];
  assertEquals(tracker.refresh(), true);
  assertEquals(tracker.key(), HRE);
});

Deno.test("createDetailFocusTracker は moveend で focus が変わったときだけ onChange を呼ぶ（#350 AC6）", () => {
  const map = fakeMap();
  let center: Position = [2, 2];
  const changes: (string | null)[] = [];
  const tracker = createDetailFocusTracker({
    getCenter: () => center,
    getBase: () => FOCUS_BASE,
    getOverrides: () => EMPTY_SUZERAIN_OVERRIDES,
    onMoveEnd: (listener) => map.on("moveend", listener),
    onChange: (key) => changes.push(key),
  });
  map.emit("moveend");
  assertEquals(changes, ["France"]);
  // 同じ上位勢力の中でパンしても通知しない（再描画を誘発しない）
  center = [3, 3];
  map.emit("moveend");
  assertEquals(changes, ["France"]);
  // 別の上位勢力へ移ったときだけ通知する
  center = [6, 2];
  map.emit("moveend");
  assertEquals(changes, ["France", HRE]);
  // 海上へ出れば null で通知する
  center = [20, 20];
  map.emit("moveend");
  assertEquals(changes, ["France", HRE, null]);
  assertEquals(tracker.key(), null);
});

Deno.test("createDetailFocusTracker の refresh（年代変更）は onChange を呼ばない（#350: 二重再描画の回避）", () => {
  const map = fakeMap();
  const changes: (string | null)[] = [];
  const tracker = createDetailFocusTracker({
    getCenter: () => [2, 2],
    getBase: () => FOCUS_BASE,
    getOverrides: () => EMPTY_SUZERAIN_OVERRIDES,
    onMoveEnd: (listener) => map.on("moveend", listener),
    onChange: (key) => changes.push(key),
  });
  // 年代切替は applyFn が直後に renderLayers() を呼ぶため、通知は要らない
  assertEquals(tracker.refresh(), true);
  assertEquals(changes, []);
});

// ---- extractSuzerainMembers ----

const FRANCE = feature(
  { NAME: "Kingdom of France", SUBJECTO: "France" },
  box(0, 0),
);
const TOULOUSE = feature(
  { NAME: "Comté de Toulouse", SUBJECTO: "France" },
  box(1, 0),
);
const BRITANY = feature({ NAME: "Britany", SUBJECTO: "Britany" }, box(2, 0));
const ANGEVIN = feature(
  { NAME: "Angevin Empire", SUBJECTO: "Angevin Empire" },
  box(5, 5),
);
const DENMARK = feature({ NAME: "Denmark", SUBJECTO: "Denmark" }, box(9, 9));
const BASE = collection([FRANCE, TOULOUSE, BRITANY, ANGEVIN, DENMARK]);

Deno.test("extractSuzerainMembers は宗主に属する全 feature を返す", () => {
  const members = extractSuzerainMembers(
    BASE,
    "France",
    EMPTY_SUZERAIN_OVERRIDES,
  );
  assertEquals(members.map((f) => f.properties?.NAME), [
    "Kingdom of France",
    "Comté de Toulouse",
  ]);
});

Deno.test("extractSuzerainMembers は宗主補正された封臣も含める", () => {
  const members = extractSuzerainMembers(
    BASE,
    "France",
    overrides({}, { Britany: "France" }),
  );
  assertEquals(members.map((f) => f.properties?.NAME), [
    "Kingdom of France",
    "Comté de Toulouse",
    "Britany",
  ]);
});

Deno.test("extractSuzerainMembers は単独勢力で自分自身だけを返す（非波及）", () => {
  const members = extractSuzerainMembers(
    BASE,
    "Denmark",
    overrides({}, { Britany: "France" }),
  );
  assertEquals(members.map((f) => f.properties?.NAME), ["Denmark"]);
});

Deno.test("extractSuzerainMembers はアンジュー帝国をフランスへ含めない", () => {
  const france = extractSuzerainMembers(
    BASE,
    "France",
    overrides({}, { Britany: "France" }),
  );
  assert(!france.some((f) => f.properties?.NAME === "Angevin Empire"));
  const angevin = extractSuzerainMembers(
    BASE,
    "Angevin Empire",
    EMPTY_SUZERAIN_OVERRIDES,
  );
  assertEquals(angevin.map((f) => f.properties?.NAME), ["Angevin Empire"]);
});

Deno.test("extractSuzerainMembers は key が null・該当なしで空配列", () => {
  assertEquals(
    extractSuzerainMembers(BASE, null, EMPTY_SUZERAIN_OVERRIDES),
    [],
  );
  assertEquals(
    extractSuzerainMembers(BASE, "Aragón", EMPTY_SUZERAIN_OVERRIDES),
    [],
  );
});

// ---- buildSuzerainExtent ----

Deno.test("buildSuzerainExtent は隣接する構成 feature を 1 つの外縁へ融合する", () => {
  // 辺を共有する 2 枚（0..1 と 1..2）の union は 0..2 の 1 ポリゴンになり、
  // 内部の境界線（x=1）は外縁に残らない
  const extent = buildSuzerainExtent(BASE, "France", EMPTY_SUZERAIN_OVERRIDES);
  assertEquals(extent.features.length, 1);
  const geom = extent.features[0].geometry;
  assert(geom.type === "Polygon");
  const xs = geom.coordinates[0].map(([x]) => x);
  assertEquals(Math.min(...xs), 0);
  assertEquals(Math.max(...xs), 2);
});

Deno.test("buildSuzerainExtent は飛び地（非隣接）を MultiPolygon として保つ", () => {
  const detached = collection([
    feature({ NAME: "A", SUBJECTO: "S" }, box(0, 0)),
    feature({ NAME: "B", SUBJECTO: "S" }, box(10, 10)),
  ]);
  const extent = buildSuzerainExtent(detached, "S", EMPTY_SUZERAIN_OVERRIDES);
  assertEquals(extent.features.length, 1);
  assertEquals(extent.features[0].geometry.type, "MultiPolygon");
});

Deno.test("buildSuzerainExtent は宗主補正された封臣を外枠に含める", () => {
  // Britany（2..3）を含めると外縁は 0..3 まで伸びる
  const extent = buildSuzerainExtent(
    BASE,
    "France",
    overrides({}, { Britany: "France" }),
  );
  const geom = extent.features[0].geometry;
  assert(geom.type === "Polygon");
  const xs = geom.coordinates[0].map(([x]) => x);
  assertEquals(Math.max(...xs), 3);
});

Deno.test("buildSuzerainExtent は key が null で空 FeatureCollection", () => {
  const extent = buildSuzerainExtent(BASE, null, EMPTY_SUZERAIN_OVERRIDES);
  assertEquals(extent.features, []);
});

Deno.test("buildSuzerainExtent は宗主キーを外枠 feature の properties に残す", () => {
  const extent = buildSuzerainExtent(BASE, "France", EMPTY_SUZERAIN_OVERRIDES);
  assertEquals(extent.features[0].properties?.NAME, "France");
});

Deno.test("buildSuzerainExtent は単独勢力でそのポリゴンをそのまま外枠にする", () => {
  // union は 2 件未満を受け付けない。最も多いこのケースで例外・警告を出さない
  const extent = buildSuzerainExtent(BASE, "Denmark", EMPTY_SUZERAIN_OVERRIDES);
  assertEquals(extent.features.length, 1);
  assertStrictEquals(extent.features[0], DENMARK);
});

// ---- #330: 沿岸補完の帯を外枠へ合流させる ----
// 画面上のアクティブ表示領域は「元ポリゴン + 沿岸補完の帯（海面マスク後）」
// なので、外枠の入力が元ポリゴンだけだと現代海岸線より内側の区間で臙脂線が
// 領域の内部に取り残される。帯を union の入力に足して、外枠を「実際に塗られる
// 面」の外縁に一致させる。

/** 帯 1 件（base の featureIndex 由来）を作る */
function band(baseIndex: number, ring: Position[]): Feature {
  return {
    type: "Feature",
    properties: { baseIndex },
    geometry: { type: "MultiPolygon", coordinates: [[ring]] },
  };
}

/**
 * テスト用の帯入力。select は coastal_fill.ts coastalBandsForSuzerain と同じ
 * 契約（宗主キーに属する base feature 由来の帯だけを返す）。
 */
function bandsInput(
  base: FeatureCollection,
  bands: FeatureCollection,
): SuzerainExtentBands {
  return { base, bands, select: coastalBandsForSuzerain };
}

Deno.test("buildSuzerainExtent は宗主に属する沿岸補完の帯を外枠へ合流させる（#330）", () => {
  // Denmark（9..10）の海側へ 1 度ぶん張り出した帯。外枠は 11 まで伸びる
  const bands = collection([band(4, box(10, 9))]);
  const extent = buildSuzerainExtent(
    BASE,
    "Denmark",
    EMPTY_SUZERAIN_OVERRIDES,
    bandsInput(BASE, bands),
  );
  assertEquals(extent.features.length, 1);
  const geom = extent.features[0].geometry;
  assert(geom.type === "Polygon");
  const xs = geom.coordinates[0].map(([x]) => x);
  assertEquals(Math.max(...xs), 11);
});

Deno.test("buildSuzerainExtent は他の宗主の帯を外枠へ含めない（#330）", () => {
  // Angevin Empire（添字 3）の帯は Denmark の外枠に入らない
  const bands = collection([band(3, box(6, 5))]);
  const extent = buildSuzerainExtent(
    BASE,
    "Denmark",
    EMPTY_SUZERAIN_OVERRIDES,
    bandsInput(BASE, bands),
  );
  assertStrictEquals(extent.features[0], DENMARK);
});

Deno.test("buildSuzerainExtent は base が対応しない帯を無視する（年代切替の途中）（#330）", () => {
  // 帯は前の年代の base から作られたもの。添字の意味が違うので使わない
  const stale = collection([DENMARK]);
  const bands = collection([band(0, box(10, 9))]);
  const extent = buildSuzerainExtent(
    BASE,
    "Denmark",
    EMPTY_SUZERAIN_OVERRIDES,
    bandsInput(stale, bands),
  );
  assertStrictEquals(extent.features[0], DENMARK);
});

Deno.test("buildSuzerainExtent は帯との継ぎ目の糸くず環を落とす（#330 AC4）", () => {
  // 帯の内側の辺が元ポリゴンの辺から 1e-6 度（≈ 0.1m）だけ内側にある状況を
  // 作る（配信データの座標丸め + polyclip の交点で実際に起きる）。union は
  // その隙間を内環として残すが、3px の線で描くと元の海岸線がそのまま見える
  const eps = 0.000001;
  const sliverBand = collection([{
    type: "Feature",
    properties: { baseIndex: 4 },
    geometry: {
      type: "MultiPolygon",
      coordinates: [[[
        [10 - eps, 9],
        [11, 9],
        [11, 10],
        [10 - eps, 10],
        [10 - eps, 9],
      ]]],
    },
  }]);
  const extent = buildSuzerainExtent(
    BASE,
    "Denmark",
    EMPTY_SUZERAIN_OVERRIDES,
    bandsInput(BASE, sliverBand),
  );
  const geometry = extent.features[0].geometry;
  assert(geometry.type === "Polygon");
  assertEquals(geometry.coordinates.length, 1, "糸くずの内環が残っている");
  // 実在の未着色域（100m 級以上）は残す
  const withHole = buildSuzerainExtent(
    collection([
      feature({ NAME: "R", SUBJECTO: "R" }, box(0, 0, 4, 4)),
      feature({ NAME: "R2", SUBJECTO: "R" }, [
        [4, 0],
        [8, 0],
        [8, 4],
        [4, 4],
        [4, 3],
        [7, 3],
        [7, 1],
        [4, 1],
        [4, 0],
      ]),
    ]),
    "R",
    EMPTY_SUZERAIN_OVERRIDES,
  );
  assertEquals(withHole.features[0].geometry.type, "Polygon");
  assertEquals(
    (withHole.features[0].geometry as { coordinates: unknown[] }).coordinates
      .length,
    2,
  );
});

Deno.test("coastalBandsForSuzerain は宗主キーに属する base 由来の帯だけを返す（#330）", () => {
  const bands = collection([
    band(0, box(-1, 0)), // Kingdom of France（France）
    band(2, box(3, 0)), // Britany（独立）
    band(4, box(10, 9)), // Denmark
  ]);
  assertEquals(
    coastalBandsForSuzerain(bands, BASE, "France", EMPTY_SUZERAIN_OVERRIDES)
      .length,
    1,
  );
  // 宗主補正が効けば Britany の帯も France の側に入る
  assertEquals(
    coastalBandsForSuzerain(
      bands,
      BASE,
      "France",
      overrides({}, { Britany: "France" }),
    ).length,
    2,
  );
  // 添字が範囲外・非整数の帯は無視する（配信データと base の食い違い）
  assertEquals(
    coastalBandsForSuzerain(
      collection([band(99, box(0, 0)), band(0.5, box(0, 0))]),
      BASE,
      "France",
      EMPTY_SUZERAIN_OVERRIDES,
    ),
    [],
  );
});

// ---- createSuzerainExtentCache ----

Deno.test("createSuzerainExtentCache は同じ入力で同一インスタンスを返す", () => {
  const cache = createSuzerainExtentCache();
  const a = cache(BASE, "France", EMPTY_SUZERAIN_OVERRIDES);
  const b = cache(BASE, "France", EMPTY_SUZERAIN_OVERRIDES);
  assertStrictEquals(a, b);
});

Deno.test("createSuzerainExtentCache はキーを跨いでも再計算結果を保持する", () => {
  const cache = createSuzerainExtentCache();
  const france = cache(BASE, "France", EMPTY_SUZERAIN_OVERRIDES);
  cache(BASE, "Denmark", EMPTY_SUZERAIN_OVERRIDES);
  assertStrictEquals(cache(BASE, "France", EMPTY_SUZERAIN_OVERRIDES), france);
});

Deno.test("createSuzerainExtentCache は base が変わればキャッシュを捨てる", () => {
  const cache = createSuzerainExtentCache();
  const first = cache(BASE, "Denmark", EMPTY_SUZERAIN_OVERRIDES);
  const other = collection([DENMARK]);
  const second = cache(other, "Denmark", EMPTY_SUZERAIN_OVERRIDES);
  assert(first !== second);
});

Deno.test("createSuzerainExtentCache は帯が届いたらキャッシュを捨てる（#330）", () => {
  // 帯は年代 GeoJSON より後から非同期で届く。届く前に計算した外枠
  // （元ポリゴンだけ）を握り続けると、表示領域との乖離が残ったままになる
  const cache = createSuzerainExtentCache();
  const before = cache(BASE, "Denmark", EMPTY_SUZERAIN_OVERRIDES);
  const bands = collection([band(4, box(10, 9))]);
  const after = cache(
    BASE,
    "Denmark",
    EMPTY_SUZERAIN_OVERRIDES,
    bandsInput(BASE, bands),
  );
  assert(before !== after);
  // 同じ帯（FeatureCollection の参照同値）ならキャッシュに載る。renderLayers の
  // たびに入力オブジェクトを組み直してもホバー往復で union を再計算しない
  assertStrictEquals(
    cache(BASE, "Denmark", EMPTY_SUZERAIN_OVERRIDES, bandsInput(BASE, bands)),
    cache(BASE, "Denmark", EMPTY_SUZERAIN_OVERRIDES, bandsInput(BASE, bands)),
  );
});

// ---- applySuzerainOverrides ----

Deno.test("applySuzerainOverrides は補正対象の SUBJECTO を書き換える", () => {
  const applied = applySuzerainOverrides(
    BASE,
    overrides({}, { Britany: "France" }),
  );
  const britany = applied.features.find((f) =>
    f.properties?.NAME === "Britany"
  );
  assertEquals(britany?.properties?.SUBJECTO, "France");
});

Deno.test("applySuzerainOverrides は無関係な feature の properties を変えない", () => {
  const applied = applySuzerainOverrides(
    BASE,
    overrides({}, { Britany: "France" }),
  );
  const denmark = applied.features.find((f) =>
    f.properties?.NAME === "Denmark"
  );
  assertStrictEquals(denmark, DENMARK);
});

Deno.test("applySuzerainOverrides は補正が効かないとき同一インスタンスを返す", () => {
  // deck.gl の差分更新（data 参照同値）を壊さないための参照安定性
  assertStrictEquals(
    applySuzerainOverrides(BASE, EMPTY_SUZERAIN_OVERRIDES),
    BASE,
  );
  assertStrictEquals(
    applySuzerainOverrides(
      BASE,
      overrides({}, { Aquitaine: "Angevin Empire" }),
    ),
    BASE,
  );
});

// ---- 配信データに対する回帰（TASK-120） ----
//
// 純粋関数の単体テストだけでは「実データでどの勢力に解決されるか」は固定
// できない（封土の位置と base のポリゴンの両方に依存するため）。ここでは
// data/ の生成物を直接読み、bug の再現ケース（仏封土をホバーしても
// フランス王国の外枠が出ない）が解消していることを年代ごとに固定する。

/** data/name-overrides.json から実際の宗主補正を読む */
async function realOverrides(): Promise<SuzerainOverrides> {
  return parseSuzerainOverrides(
    JSON.parse(await Deno.readTextFile("data/name-overrides.json")),
  );
}

async function readCollection(path: string): Promise<FeatureCollection> {
  return JSON.parse(await Deno.readTextFile(path)) as FeatureCollection;
}

/** 指定レイヤーの封土 NAME を picking したときの宗主キーを返す */
function keyOfFief(
  layerId: string,
  fiefs: FeatureCollection,
  base: FeatureCollection,
  name: string,
  ov: SuzerainOverrides,
): string | null {
  const f = fiefs.features.find((x) => x.properties?.NAME === name);
  assert(f !== undefined, `${name} が見つからない`);
  return suzerainExtentKey(layerId, f, base, ov);
}

Deno.test("実データ: 仏諸侯領（france-fiefs）の封土がフランス王国の宗主キーへ解決する", async () => {
  const ov = await realOverrides();
  // 1200 年は base が当該領域をアンジュー帝国として塗る（decision-19 で
  // 複合勢力のまま扱うと決めた勢力）ため、フランス王国内に残る封土で見る。
  const cases: [number, string][] = [
    [1000, "County of Anjou"],
    [1100, "County of Anjou"],
    [1200, "County of Champagne"],
    [1279, "County of Anjou"],
    [1300, "County of Anjou"],
  ];
  for (const [year, name] of cases) {
    const base = await readCollection(`data/europe_${year}.geojson`);
    const fiefs = await readCollection(
      `data/france_fiefs_flat_${year}.geojson`,
    );
    const key = keyOfFief(FRANCE_FIEF_LAYER_ID, fiefs, base, name, ov);
    assertEquals(key, "France", `${year} ${name}`);
    // 解決したキーで base から外枠が組み立つ（空でない）ことまで確認する
    const members = extractSuzerainMembers(base, key, ov).map((f) =>
      String(f.properties?.NAME)
    );
    assert(
      members.some((n) => n === "France" || n === "Kingdom of France"),
      `${year} の外枠にフランス王国本体が含まれない: ${members.join(", ")}`,
    );
  }
});

Deno.test("実データ: Cliopatria 由来の仏封土もフランス王国の宗主キーへ解決する", async () => {
  const ov = await realOverrides();
  const cases: [number, string][] = [
    [1000, "Royal Domain of France"],
    [1000, "County of Blôis"],
    [1100, "Royal Domain of France"],
    [1200, "Royal Domain of France"],
    // 1300 年の County of Blôis は上流の面が粗すぎて除外した（#321）
    [1279, "County of Blôis"],
    [1300, "County of Auvergne"],
  ];
  for (const [year, name] of cases) {
    const base = await readCollection(`data/europe_${year}.geojson`);
    const fiefs = await readCollection(
      `data/cliopatria_fiefs_flat_${year}.geojson`,
    );
    assertEquals(
      keyOfFief(CLIOPATRIA_FIEF_LAYER_ID, fiefs, base, name, ov),
      "France",
      `${year} ${name}`,
    );
  }
});

Deno.test("実データ: Cliopatria 由来の HRE 領邦は帝国の宗主キーへ解決する", async () => {
  const ov = await realOverrides();
  for (const year of [1279, 1300, 1400, 1492]) {
    const base = await readCollection(`data/europe_${year}.geojson`);
    const fiefs = await readCollection(
      `data/cliopatria_fiefs_flat_${year}.geojson`,
    );
    assertEquals(
      keyOfFief(CLIOPATRIA_FIEF_LAYER_ID, fiefs, base, "Duchy of Bavaria", ov),
      HRE,
      `${year} Duchy of Bavaria`,
    );
  }
});

Deno.test("実データ: 1000/1100 年のノルマンディーは France の名目枠へ解決する", async () => {
  const ov = await realOverrides();
  // #369: 低ズームの base はフランス王国の名目枠、詳細は公国オーバーレイ。
  for (const year of [1000, 1100]) {
    const base = await readCollection(`data/europe_${year}.geojson`);
    const fiefs = await readCollection(
      `data/france_fiefs_flat_${year}.geojson`,
    );
    assertEquals(
      keyOfFief(FRANCE_FIEF_LAYER_ID, fiefs, base, "Duchy of Normandy", ov),
      "France",
      `${year} Duchy of Normandy`,
    );
  }
  // decision-19: アンジュー帝国は独立の複合勢力のまま扱う。1200 年に
  // その内側へ落ちる封土はフランス王国ではなくアンジュー帝国が囲まれる。
  const base = await readCollection("data/europe_1200.geojson");
  const fiefs = await readCollection("data/france_fiefs_flat_1200.geojson");
  assertEquals(
    keyOfFief(FRANCE_FIEF_LAYER_ID, fiefs, base, "County of Anjou", ov),
    "Angevin Empire",
  );
});

// ---- 配信データに対する回帰（伊諸侯領・TASK-121） ----
//
// 伊諸侯領は帝国イタリア側・教皇領側・事実上独立の都市共和国が同じレイヤーに
// 並ぶ。包含の規則（decision-27）に載せたときに実際にどの宗主へ解決するかを
// 全 7 年代・全 feature で固定する。件数の内訳がずれたら base の帰属か
// オーバーレイの収録が変わったということなので、テストが気付く。

const ITALY_YEARS = [1000, 1100, 1200, 1279, 1300, 1400, 1492] as const;

/** 外枠を出さない（どの base 勢力にもラベル位置が含まれない）ことを表すキー */
const NO_SUZERAIN = "(none)";

Deno.test("実データ: 伊諸侯領の宗主キーの内訳が全 7 年代で固定されている", async () => {
  const ov = await realOverrides();
  const expected: Record<number, Record<string, number>> = {
    // 1000 年は 3 件すべてが帝国領内（教皇領は base 側にトスカーナ・スポレート
    // を持たない）
    1000: { [HRE]: 3 },
    1100: { [HRE]: 4, "Papal States": 2, Corsica: 1 },
    1200: { [HRE]: 7, "Papal States": 2, Corsica: 1 },
    1279: { [HRE]: 10, "Papal States": 1, Corsica: 1 },
    // 1300 の Papal States 2 件は Republic of Ancona と Lordship of Rimini。
    // リミニは TASK-124 で base の帝国塗りを是正した（1278 年にルドルフ 1 世が
    // ロマーニャの帝国権を教皇へ譲渡済みのため）
    1300: { [HRE]: 11, "Papal States": 2, Corsica: 1 },
    1400: { [HRE]: 13, "Papal States": 1, Corsica: 1, [NO_SUZERAIN]: 1 },
    1492: { [HRE]: 16, "Papal States": 3, [NO_SUZERAIN]: 1 },
  };
  for (const year of ITALY_YEARS) {
    const base = await readCollection(`data/europe_${year}.geojson`);
    const fiefs = await readCollection(`data/italy_fiefs_flat_${year}.geojson`);
    const counts: Record<string, number> = {};
    for (const f of fiefs.features) {
      const key = suzerainExtentKey(ITALY_FIEF_LAYER_ID, f, base, ov) ??
        NO_SUZERAIN;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    assertEquals(counts, expected[year], `${year}`);
  }
});

Deno.test("実データ: 帝国イタリアの諸侯領は神聖ローマ帝国の宗主キーへ解決する", async () => {
  const ov = await realOverrides();
  // モンフェッラート辺境伯領は全 7 年代に存在する帝国イタリアの代表例
  for (const year of ITALY_YEARS) {
    const base = await readCollection(`data/europe_${year}.geojson`);
    const fiefs = await readCollection(`data/italy_fiefs_flat_${year}.geojson`);
    const key = keyOfFief(
      ITALY_FIEF_LAYER_ID,
      fiefs,
      base,
      "March of Montferrat",
      ov,
    );
    assertEquals(key, HRE, `${year} March of Montferrat`);
    // 解決したキーで base から外枠が組み立つ（空でない）ことまで確認する
    assert(
      extractSuzerainMembers(base, key, ov).length > 0,
      `${year} の外枠が空`,
    );
  }
});

Deno.test("実データ: 教皇領側の諸侯領は教皇領の宗主キーへ解決する", async () => {
  const ov = await realOverrides();
  const cases: [number, string][] = [
    [1100, "Duchy of Spoleto"],
    [1200, "Duchy of Spoleto"],
    [1100, "Republic of Ancona"],
    [1279, "Republic of Ancona"],
    [1400, "Republic of Ancona"],
    [1492, "Duchy of Ferrara"],
    [1492, "Lordship of Rimini"],
  ];
  for (const [year, name] of cases) {
    const base = await readCollection(`data/europe_${year}.geojson`);
    const fiefs = await readCollection(`data/italy_fiefs_flat_${year}.geojson`);
    assertEquals(
      keyOfFief(ITALY_FIEF_LAYER_ID, fiefs, base, name, ov),
      "Papal States",
      `${year} ${name}`,
    );
  }
});

Deno.test("実データ: 都市共和国は base が帝国色で塗る土地の帝国キーへ解決する", async () => {
  const ov = await realOverrides();
  // フィレンツェ・シエナ・ルッカのコムーネは実質独立だが名目上はイタリア王国＝
  // 帝国の内側で、base もその土地を帝国として塗る。どちらへ寄せるかを実装者が
  // 判断せず base の帰属をそのまま読む、というのが decision-27 の要点。
  const cases: [number, string][] = [
    [1200, "Republic of Florence"],
    [1300, "Republic of Florence"],
    [1400, "Republic of Florence"],
    [1200, "Republic of Siena"],
    [1492, "Republic of Siena"],
    [1200, "Republic of Lucca"],
    [1492, "Republic of Lucca"],
  ];
  for (const [year, name] of cases) {
    const base = await readCollection(`data/europe_${year}.geojson`);
    const fiefs = await readCollection(`data/italy_fiefs_flat_${year}.geojson`);
    assertEquals(
      keyOfFief(ITALY_FIEF_LAYER_ID, fiefs, base, name, ov),
      HRE,
      `${year} ${name}`,
    );
  }
});

Deno.test("実データ: 海洋共和国はコルシカ島のラベル位置に従って解決する（既知の制限）", async () => {
  const ov = await realOverrides();
  // ピサ（1100〜1279）とジェノヴァ（1300〜1400）はコルシカ島を含むポリゴンを
  // 持ち、島の方が本土側より大きいためラベルのアンカーが島に立つ（README §3.8
  // の「ピサ・ジェノヴァのコルシカ支配が表現される」）。base はその島を独立の
  // 勢力 Corsica として塗るので、外枠は島だけを囲む。宗主補正で帝国へ寄せる
  // のは「名目上の帝国従属」という解釈を実装者が入れることになり decision-19 に
  // 反するため採らない。docs/data-inventory/README.md §3.8 に既知の制限として
  // 記載している。
  const cases: [number, string][] = [
    [1100, "Republic of Pisa"],
    [1200, "Republic of Pisa"],
    [1279, "Republic of Pisa"],
    [1300, "Republic of Genoa"],
    [1400, "Republic of Genoa"],
  ];
  for (const [year, name] of cases) {
    const base = await readCollection(`data/europe_${year}.geojson`);
    const fiefs = await readCollection(`data/italy_fiefs_flat_${year}.geojson`);
    assertEquals(
      keyOfFief(ITALY_FIEF_LAYER_ID, fiefs, base, name, ov),
      "Corsica",
      `${year} ${name}`,
    );
  }
  // 本土だけに戻った年代では帝国キーへ解決する（1300 年のピサ＝メロリアの海戦で
  // コルシカを失った後、1492 年のジェノヴァ＝base が Corsica を持たない）
  const mainlandOnly: [number, string][] = [
    [1300, "Republic of Pisa"],
    [1492, "Republic of Genoa"],
  ];
  for (const [year, name] of mainlandOnly) {
    const base = await readCollection(`data/europe_${year}.geojson`);
    const fiefs = await readCollection(`data/italy_fiefs_flat_${year}.geojson`);
    assertEquals(
      keyOfFief(ITALY_FIEF_LAYER_ID, fiefs, base, name, ov),
      HRE,
      `${year} ${name}`,
    );
  }
});

Deno.test("実データ: base のどの勢力にも載らない伊諸侯領は外枠を出さない", async () => {
  const ov = await realOverrides();
  // ピオンビーノ領主領はティレニア海沿岸の小領で、ラベルのアンカーが base の
  // どのポリゴンにも含まれない（海側へ出る）。従来どおり外枠なしに落ちる。
  for (const year of [1400, 1492]) {
    const base = await readCollection(`data/europe_${year}.geojson`);
    const fiefs = await readCollection(`data/italy_fiefs_flat_${year}.geojson`);
    assertEquals(
      keyOfFief(ITALY_FIEF_LAYER_ID, fiefs, base, "Lordship of Piombino", ov),
      null,
      `${year} Lordship of Piombino`,
    );
  }
});

// ---- withSuzerainOverrides のキャッシュ上限（LRU 退避、TASK-129） ----

/**
 * テスト用: 年ごとの load 回数を数える内側ローダ。
 * has は実ローダ（createYearDataLoader / createOverlayLoader）と同じ
 * 「取得済みで fetch なしに解決できる年は true」の契約に合わせる
 * （withSuzerainOverrides が保持可否の判定に使う。#217）。
 */
function countingInnerLoader(): {
  loader: YearDataLoader;
  calls: number[];
} {
  const calls: number[] = [];
  const loaded = new Set<number>();
  const loader: YearDataLoader = {
    has: (year) => loaded.has(year),
    load(year) {
      calls.push(year);
      loaded.add(year);
      const fc: FeatureCollection = {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { NAME: `Y${year}`, SUBJECTO: null },
            geometry: { type: "Point", coordinates: [0, 0] },
          },
        ],
      };
      return Promise.resolve(fc);
    },
  };
  return { loader, calls };
}

Deno.test("withSuzerainOverrides のキャッシュも上限超過で最古の年代を解放する（TASK-129）", async () => {
  const { loader: inner, calls } = countingInnerLoader();
  const wrapped = withSuzerainOverrides(inner, () => EMPTY_SUZERAIN_OVERRIDES);
  const years = Array.from(
    { length: YEAR_CACHE_MAX_YEARS + 1 },
    (_, i) => 1000 + i,
  );
  for (const y of years) await wrapped.load(y);
  // 最古の years[0] は解放済み → 内側ローダへ再度取りに行く
  await wrapped.load(years[0]);
  assertEquals(calls.filter((y) => y === years[0]).length, 2);
});

Deno.test("withSuzerainOverrides は保持中の年代では同一インスタンスを返し続ける（TASK-129）", async () => {
  const { loader: inner } = countingInnerLoader();
  const wrapped = withSuzerainOverrides(inner, () => EMPTY_SUZERAIN_OVERRIDES);
  const first = await wrapped.load(1200);
  const second = await wrapped.load(1200);
  assertStrictEquals(second, first);
});

// ---- withSuzerainOverrides と縮退結果の再試行（#217） ----

Deno.test("withSuzerainOverrides は内側がキャッシュしなかった縮退結果を保持しない（#217）", async () => {
  // 内側ローダの has は「fetch なしで解決できる」契約。取得失敗で縮退した年は
  // 内側がキャッシュしない（has false のまま）ので、外側も保持せず毎回内側へ
  // 取りに行く。成功してキャッシュ済みになった年から保持を始める。
  const calls: number[] = [];
  const loaded = new Set<number>();
  let degraded = true;
  const empty: FeatureCollection = { type: "FeatureCollection", features: [] };
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { NAME: "A", SUBJECTO: null },
        geometry: { type: "Point", coordinates: [0, 0] },
      },
    ],
  };
  const inner: YearDataLoader = {
    has: (year) => loaded.has(year),
    load(year) {
      calls.push(year);
      if (degraded) return Promise.resolve(empty);
      loaded.add(year);
      return Promise.resolve(fc);
    },
  };
  const wrapped = withSuzerainOverrides(inner, () => EMPTY_SUZERAIN_OVERRIDES);
  await wrapped.load(1492);
  await wrapped.load(1492);
  // 縮退中は保持されず、再 load のたびに内側へ委譲される（= 再試行できる）
  assertEquals(calls.length, 2);
  degraded = false;
  const recovered = await wrapped.load(1492);
  assertEquals(calls.length, 3);
  // 成功後は従来どおり保持され、同一インスタンスを返し続ける
  const again = await wrapped.load(1492);
  assertEquals(calls.length, 3);
  assertStrictEquals(again, recovered);
});

Deno.test("借用ファイルの取得失敗は withSuzerainOverrides 越しでも再試行される（#217 AC2）", async () => {
  // main.ts の合成（withOverrides(withBorrowedGeometry(...))）と同じ構成。
  // 借用取得の失敗年を外側の LRU が保持すると、evict されるまで再試行が
  // 潰れたままになる（#217 欠陥 2）。
  let borrowedFails = true;
  const fetchCalls: string[] = [];
  const fetchFn = (url: string) => {
    fetchCalls.push(url);
    if (url.includes("borrowed")) {
      return Promise.resolve(
        borrowedFails
          ? { ok: false, status: 404, json: () => Promise.resolve({}) }
          : {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve(
                {
                  type: "FeatureCollection",
                  features: [
                    {
                      type: "Feature",
                      properties: { NAME: "Archduchy of Austria" },
                      geometry: { type: "Point", coordinates: [0, 0] },
                    },
                  ],
                } as FeatureCollection,
              ),
          },
      );
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(
          {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                properties: { NAME: "County of Schaunberg", SUBJECTO: null },
                geometry: { type: "Point", coordinates: [0, 0] },
              },
            ],
          } as FeatureCollection,
        ),
    });
  };
  const wrapped = withSuzerainOverrides(
    withBorrowedGeometry(
      createHreOverlayLoader(fetchFn, [1492], () => {}, [1492]),
      createBorrowedHreLoader(fetchFn, [1492], () => {}),
    ),
    () => EMPTY_SUZERAIN_OVERRIDES,
  );
  const degraded = await wrapped.load(1492);
  assertEquals(
    degraded.features.map((feature) => feature.properties?.NAME),
    ["County of Schaunberg"],
  );
  // 次の年代切替（再 load）で借用 fetch が再試行され、復旧が反映される
  borrowedFails = false;
  const recovered = await wrapped.load(1492);
  assertEquals(
    recovered.features.map((feature) => feature.properties?.NAME),
    ["County of Schaunberg", "Archduchy of Austria"],
  );
  assertEquals(
    fetchCalls.filter((url) => url.includes("borrowed")).length,
    2,
  );
});

// ---- withSuzerainOverrides の非同期 getOverrides（#249） ----

Deno.test("withSuzerainOverrides は getOverrides が Promise を返しても解決を待って適用する（#249）", async () => {
  // 年代 geojson の取得前倒し（#249）で起きるタイミング: geojson は解決済み
  // だが name-overrides.json はまだ取得中。適用は overrides の解決を待って
  // から行われ、前倒しでも補正済みの結果がキャッシュされる。
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { NAME: "Duchy of Normandy", SUBJECTO: "England" },
        geometry: { type: "Point", coordinates: [0, 0] },
      },
    ],
  };
  const inner: YearDataLoader = {
    has: () => true,
    load: () => Promise.resolve(fc),
  };
  const wrapped = withSuzerainOverrides(
    inner,
    () => Promise.resolve(overrides({}, { "Duchy of Normandy": "France" })),
  );
  const applied = await wrapped.load(1200);
  assertEquals(applied.features[0].properties?.SUBJECTO, "France");
  // キャッシュも補正済みの同一インスタンス
  assertStrictEquals(await wrapped.load(1200), applied);
});
