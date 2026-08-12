/**
 * 統合アトリビューション（Issue #328）のユニットテスト。
 *
 * 検証対象は 3 層:
 * 1. 表示内容（MAP_CUSTOM_ATTRIBUTION）: 帰属表示が必要な出典・ライセンス・
 *    変更表示が全て含まれ、除去対象（境界精度の免責・既知の制限）が
 *    含まれないこと（AC5/AC6）
 * 2. 重複回避の契約: MapLibre が自動収集する source attribution
 *    （BASEMAP_SOURCE_ATTRIBUTION / DEM_SOURCE_ATTRIBUTION）を部分文字列として
 *    含み、AttributionControl の重複除去で 1 項目に畳まれること（AC4）
 * 3. DOM 操作（collapseAttributionControl）と app.css の構造（AC1/AC9/AC11）
 */
import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  ATTRIBUTION_CONTROL_SELECTOR,
  ATTRIBUTION_TOGGLE_LABEL,
  BASEMAP_SOURCE_ATTRIBUTION,
  collapseAttributionControl,
  DEM_SOURCE_ATTRIBUTION,
  MAP_CUSTOM_ATTRIBUTION,
} from "./map_attribution.ts";
import { buildBasemapStyle } from "./basemap.ts";
import { BASEMAP_SOURCE_ID, DEM_SOURCE_ID } from "./config.ts";

// ---- 表示内容（AC5: 歴史データの出典・ライセンス・変更表示） ----

Deno.test("MAP_CUSTOM_ATTRIBUTION: 帰属表示が必要な出典とライセンスを全て含む（AC5）", () => {
  for (
    const token of [
      // タイル・地形（source attribution 由来。下の重複回避テストも参照）
      "Protomaps",
      "OpenStreetMap",
      "ODbL",
      "Terrain Tiles",
      // 歴史データ
      "historical-basemaps",
      "GPL-3.0",
      "ETH Zürich",
      "CC BY-NC-SA 4.0",
      "Cliopatria",
      "CC BY 4.0",
      "Reba",
    ]
  ) {
    assert(
      MAP_CUSTOM_ATTRIBUTION.includes(token),
      `統合 attribution に「${token}」が無い`,
    );
  }
});

Deno.test("MAP_CUSTOM_ATTRIBUTION: 派生データへの変更表示を含む（AC5。ODbL / CC BY の要件）", () => {
  assertMatch(MAP_CUSTOM_ATTRIBUTION, /切り出し|簡略化/);
  assert(MAP_CUSTOM_ATTRIBUTION.includes("変更"));
});

Deno.test("MAP_CUSTOM_ATTRIBUTION: 境界精度の免責と既知の制限を含まない（AC6）", () => {
  for (
    const token of [
      "概略",
      "厳密ではありません",
      "既知の制限",
      "known-limitations",
      "work in progress",
    ]
  ) {
    assertEquals(
      MAP_CUSTOM_ATTRIBUTION.includes(token),
      false,
      `統合 attribution に除去対象の「${token}」が残っている`,
    );
  }
});

Deno.test("MAP_CUSTOM_ATTRIBUTION: 全リンクが別タブで開き rel を持つ", () => {
  const links = MAP_CUSTOM_ATTRIBUTION.match(/<a /g) ?? [];
  assert(links.length >= 5, `リンク数が少なすぎる: ${links.length}`);
  assertEquals(
    (MAP_CUSTOM_ATTRIBUTION.match(/target="_blank"/g) ?? []).length,
    links.length,
  );
  assertEquals(
    (MAP_CUSTOM_ATTRIBUTION.match(/rel="noopener noreferrer"/g) ?? []).length,
    links.length,
  );
});

// ---- 重複回避（AC4: source attribution の自動収集を維持しつつ 1 項目に畳む） ----

Deno.test("MAP_CUSTOM_ATTRIBUTION: source attribution を部分文字列として含む（重複除去の契約。AC4）", () => {
  // maplibre-gl 4.7.1 の AttributionControl._updateAttributions は、
  // 「より長い別項目に含まれる項目」を落とす。統合 attribution が source
  // attribution を丸ごと含んでいれば、自動収集された項目は畳まれて 1 項目に
  // なり、同じ出典が二重に並ばない。
  assert(
    MAP_CUSTOM_ATTRIBUTION.includes(BASEMAP_SOURCE_ATTRIBUTION),
    "ベースマップの source attribution が統合 attribution に含まれていない",
  );
  assert(
    MAP_CUSTOM_ATTRIBUTION.includes(DEM_SOURCE_ATTRIBUTION),
    "DEM の source attribution が統合 attribution に含まれていない",
  );
});

Deno.test("スタイルの source attribution は map_attribution.ts の定数を唯一の定義元とする（AC4）", () => {
  const style = buildBasemapStyle("/europe.pmtiles", "/europe-dem.pmtiles");
  assertEquals(
    style.sources[BASEMAP_SOURCE_ID].attribution,
    BASEMAP_SOURCE_ATTRIBUTION,
  );
  assertEquals(
    style.sources[DEM_SOURCE_ID].attribution,
    DEM_SOURCE_ATTRIBUTION,
  );
});

// ---- トグルのラベル（AC10: 適切な aria-label） ----

Deno.test("ATTRIBUTION_TOGGLE_LABEL: 日本語の用途が分かるラベルである（AC10）", () => {
  assert(ATTRIBUTION_TOGGLE_LABEL.length > 0);
  assert(ATTRIBUTION_TOGGLE_LABEL.includes("出典"));
});

// ---- collapseAttributionControl（AC1: 初期表示は折りたたみ） ----

/** classList / removeAttribute だけを持つ最小の fake 要素 */
function fakeControl(classNames: string[], open: boolean) {
  const classes = new Set(classNames);
  const attributes = new Map<string, string>(open ? [["open", ""]] : []);
  return {
    classList: {
      remove: (...tokens: string[]) => {
        for (const token of tokens) classes.delete(token);
      },
      contains: (token: string) => classes.has(token),
    },
    removeAttribute: (name: string) => {
      attributes.delete(name);
    },
    classes,
    attributes,
  };
}

Deno.test("collapseAttributionControl: compact-show と open を外して折りたたむ（AC1）", () => {
  const control = fakeControl(
    [
      "maplibregl-ctrl",
      "maplibregl-ctrl-attrib",
      "maplibregl-compact",
      "maplibregl-compact-show",
    ],
    true,
  );
  const found = collapseAttributionControl({
    querySelector: (selector: string) =>
      selector === ATTRIBUTION_CONTROL_SELECTOR ? control : null,
  });
  assertEquals(found, true);
  assertEquals(control.classes.has("maplibregl-compact-show"), false);
  // コンパクト表示そのもの（ⓘ ボタン）は残す
  assertEquals(control.classes.has("maplibregl-compact"), true);
  // <details> の open を残すと視覚的には畳まれているのに支援技術へ
  // 「展開済み」と伝わるため、必ず外す（AC10）
  assertEquals(control.attributes.has("open"), false);
});

Deno.test("collapseAttributionControl: すでに折りたたみ済みでも安全（冪等）", () => {
  const control = fakeControl(
    ["maplibregl-ctrl-attrib", "maplibregl-compact"],
    false,
  );
  assertEquals(
    collapseAttributionControl({ querySelector: () => control }),
    true,
  );
  assertEquals(control.classes.has("maplibregl-compact-show"), false);
});

Deno.test("collapseAttributionControl: 要素が無ければ false を返す（例外にしない）", () => {
  assertEquals(
    collapseAttributionControl({ querySelector: () => null }),
    false,
  );
});

// ---- app.css の構造（AC9/AC11） ----

const css = Deno.readTextFileSync("app.css");

/** 小画面ブレークポイントの @media ブロック本体を取り出す（brace 対応）。 */
function smallScreenMediaBlock(source: string): string {
  const start = source.indexOf("@media (max-width: 480px)");
  assert(start >= 0, "小画面ブレークポイントの @media が見つからない");
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error("@media ブロックが閉じていない");
}

Deno.test("app.css: 展開したアトリビューション本文は内部スクロールする（AC11）", () => {
  const rule = css.match(
    /\.maplibregl-ctrl-attrib-inner\s*\{([^}]*)\}/,
  );
  assert(rule !== null, ".maplibregl-ctrl-attrib-inner の規則が無い");
  assert(rule[1].includes("overflow-y: auto"), "内部スクロールの指定が無い");
  assert(rule[1].includes("max-height"), "高さ上限の指定が無い");
  assert(
    rule[1].includes("overscroll-behavior: contain"),
    "スクロール伝播の抑止が無い",
  );
});

Deno.test("app.css: 展開したアトリビューションの幅上限が viewport 内に収まる（AC11）", () => {
  const rule = css.match(
    /\.maplibregl-ctrl-attrib\.maplibregl-compact-show\s*\{([^}]*)\}/,
  );
  assert(
    rule !== null,
    ".maplibregl-ctrl-attrib.maplibregl-compact-show の規則が無い",
  );
  assert(rule[1].includes("max-width"), "幅上限の指定が無い");
});

Deno.test("app.css: 小画面のアトリビューション トグルは 44px のタップ領域を持つ（AC9）", () => {
  const media = smallScreenMediaBlock(css);
  const rule = media.match(/\.maplibregl-ctrl-attrib-button\s*\{([^}]*)\}/);
  assert(
    rule !== null,
    "小画面の .maplibregl-ctrl-attrib-button 規則が無い",
  );
  assertMatch(rule[1], /width:\s*44px/);
  assertMatch(rule[1], /height:\s*44px/);
});

Deno.test("app.css: 小画面のアトリビューション本文リンクも 44px 相当のタップ領域を持つ（AC9）", () => {
  const media = smallScreenMediaBlock(css);
  assert(
    media.includes(".maplibregl-ctrl-attrib-inner a"),
    "本文リンクのタップ領域拡張が無い",
  );
});
