/**
 * 地図の出典・ライセンス表示（Issue #328「案A: 統合アトリビューション」）。
 * DOM 非依存の文字列定数と、最小インターフェースで受ける DOM 操作だけを持つ。
 *
 * ## 方針
 * 常設 UI をタイムスライダーと右下のコンパクトなアトリビューション「ⓘ」1 個に
 * 統合する。左上に独自のⓘ（出典・免責）／⚠（既知の制限）を置いていた従来
 * （TASK-26 / TASK-46 / #284）を廃し、帰属表示が必要な情報は全て MapLibre の
 * `AttributionControl` へ寄せる。
 *
 * ## source attribution との重なり（AC4）
 * OpenStreetMap / Protomaps / Terrain Tiles の attribution は、従来どおり
 * スタイルの source 定義から MapLibre が自動収集する（basemap.ts が
 * {@linkcode BASEMAP_SOURCE_ATTRIBUTION} / {@linkcode DEM_SOURCE_ATTRIBUTION}
 * をそのまま source の `attribution` に載せる）。統合 attribution
 * （{@linkcode MAP_CUSTOM_ATTRIBUTION}）は **その文字列を部分文字列として含む**
 * ため、maplibre-gl 4.7.1 の `AttributionControl._updateAttributions`
 * （「より長い別項目に含まれる項目」を落とす重複除去）で自動収集分が畳まれ、
 * 同じ出典が二重に並ばない。ライセンス名（ODbL）や Terrain Tiles の各ソース
 * ライセンスへの導線といった、source attribution に載せきれない情報は
 * こちら側で補う。
 *
 * この「含む」関係は src/map_attribution_test.ts が固定しているため、片方だけ
 * 文言を変えると（重複表示になる前に）テストが落ちる。
 *
 * ## 表示しないもの（AC6）
 * 境界精度の免責（元データが work in progress である旨の注記）と、データが
 * 表現できない事項の一覧（TASK-46）はユーザー向け表示から除去した。データ側の
 * 記録（`data/known-limitations.json` と静的検証）は開発者向けに維持する。
 *
 * ## CC0 / パブリックドメインの扱い
 * OpenHistoricalMap（CC0-1.0）・Natural Earth（Public Domain）・
 * Buringh 2021（CC0-1.0）は帰属表示が法的に不要なため、常設・展開のどちらにも
 * 載せない（Issue #328「CC0 / パブリックドメインの情報は、法的に不要なら
 * 常設・展開項目から省略してよい」）。データ側の出典 metadata
 * （`scripts/build-attribution.ts`）と docs には従来どおり記録が残る。
 */

/** 出典リンクの共通形（別タブで開き、opener を渡さない） */
function link(href: string, text: string): string {
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

/**
 * ベースマップ（Protomaps 配布の OSM 由来ベクタタイル）の source attribution。
 * basemap.ts の vector ソース定義がそのまま使う（唯一の定義元）。
 */
export const BASEMAP_SOURCE_ATTRIBUTION = `${
  link("https://protomaps.com", "Protomaps")
} © ${link("https://openstreetmap.org/copyright", "OpenStreetMap")}`;

/**
 * 地形 DEM（AWS Terrain Tiles / terrarium）の source attribution。
 * basemap.ts の raster-dem ソース定義がそのまま使う（唯一の定義元）。
 * hillshade を持たない条件（モバイル小画面。TASK-133）では DEM ソース自体が
 * 存在せず自動収集されないが、統合 attribution 側に同じ文字列が載るため
 * 表示は失われない。
 */
export const DEM_SOURCE_ATTRIBUTION = `${
  link("https://registry.opendata.aws/terrain-tiles/", "Terrain Tiles")
} (Mapzen)`;

/** Terrain Tiles の原典ごとのライセンス一覧（Mapzen/joerd のドキュメント） */
const TERRAIN_TILES_SOURCES_URL =
  "https://github.com/tilezen/joerd/blob/master/docs/attribution.md";

/**
 * MapLibre `AttributionControl` の `customAttribution` に渡す統合 attribution。
 * 自動収集される source attribution と合わせて 1 つの「ⓘ」に集約される。
 */
export const MAP_CUSTOM_ATTRIBUTION = [
  // タイル（OSM 由来）。ODbL はライセンス名の明示が必要なのでここで補う
  `地図: © ${BASEMAP_SOURCE_ATTRIBUTION} contributors（ODbL）`,
  // 地形。原典ごとにライセンスが異なるため一覧への導線を添える
  `地形: ${DEM_SOURCE_ATTRIBUTION}・AWS（${
    link(TERRAIN_TILES_SOURCES_URL, "各ソースのライセンス")
  }）`,
  `境界: ${
    link(
      "https://github.com/aourednik/historical-basemaps",
      "historical-basemaps",
    )
  }（GPL-3.0）`,
  `帝国領邦: ${
    link("https://doi.org/10.3929/ethz-b-000472583", "ETH Zürich (Roller)")
  }（CC BY-NC-SA 4.0）`,
  `領邦補完: ${
    link(
      "https://doi.org/10.5281/zenodo.14714684",
      "Cliopatria (Seshat Global History Databank)",
    )
  }（CC BY 4.0）`,
  `都市人口: ${
    link(
      "https://github.com/fasiha/Historical-Urban-Population-Growth-Data",
      "Historical Urban Population",
    )
  } — Reba, Reitsma & Seto (2016)（CC BY 4.0）`,
  `海域名: ${
    link(
      "https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-physical-labels/",
      "Natural Earth",
    )
  }（Public Domain）`,
  // ODbL / CC BY が求める変更表示（派生データに加えた加工の開示）
  "派生データには切り出し・簡略化・名称補正等の変更を加えています",
].join(" / ");

/**
 * 「ⓘ」ボタンの `aria-label` / `title`（AC10）。MapLibre の locale
 * （`AttributionControl.ToggleAttribution`）を差し替えて日本語にする。
 * 既定は英語の "Toggle attribution" で、`lang="ja"` の本アプリでは
 * 読み上げが噛み合わない。
 */
export const ATTRIBUTION_TOGGLE_LABEL = "データ出典・ライセンス";

/** MapLibre が生成する attribution コントロール（`<details>`）のセレクタ */
export const ATTRIBUTION_CONTROL_SELECTOR = ".maplibregl-ctrl-attrib";

/** {@linkcode collapseAttributionControl} が触る要素の最小形 */
export interface AttributionControlElement {
  classList: { remove(...tokens: string[]): void };
  removeAttribute(name: string): void;
}

/** 要素を引ける最小形（`document` / 地図コンテナが満たす） */
export interface AttributionControlRoot {
  querySelector(selector: string): AttributionControlElement | null;
}

/**
 * アトリビューションを折りたたんだ状態にする（AC1）。
 *
 * maplibre-gl 4.7.1 は `compact: true` でも初期状態を「展開（open +
 * `maplibregl-compact-show`）」にし、最初の地図ドラッグまで開いたままにする。
 * 統合 attribution は本文が長いため、初期表示の常設 UI を「ⓘ 1 個」にする
 * には起動直後に畳む必要がある。`open` 属性も一緒に外すのは、`<details>` の
 * 展開状態が支援技術へ伝わる経路（AC10）を見た目と一致させるため。
 *
 * 一度 `maplibregl-compact` が付いた後の `_updateCompact`（resize /
 * attribution 更新 / スタイル差し替え時）は「compact クラスが無いときだけ
 * 展開状態を付ける」実装なので、この折りたたみが後から巻き戻ることはない。
 *
 * @returns コントロールが見つかって折りたためたか
 */
export function collapseAttributionControl(
  root: AttributionControlRoot,
): boolean {
  const control = root.querySelector(ATTRIBUTION_CONTROL_SELECTOR);
  if (control === null) return false;
  control.classList.remove("maplibregl-compact-show");
  control.removeAttribute("open");
  return true;
}
