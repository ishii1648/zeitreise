import maplibregl from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
import { PMTiles, Protocol } from "pmtiles";
import type { FeatureCollection } from "geojson";
import {
  addDeferredHillshade,
  buildBasemapStyle,
  shouldEnableHillshade,
} from "./basemap.ts";
import {
  type AssetManifest,
  loadAssetManifest,
  resolveAssetUrl,
} from "./asset_manifest.ts";
import { createApproximateBorderSync } from "./approximate_border_sync.ts";
import { createCoastalFillSync } from "./coastal_fill_sync.ts";
import { coastalFillDataUrlFor } from "./coastal_fill.ts";
import {
  type BasemapErrorEvent,
  createFallbackState,
  decideFallback,
} from "./fallback.ts";
import {
  createBaseFillLoader,
  createBaseOutlineLoader,
  createBorrowedHreLoader,
  createBorrowedItalyFiefLoader,
  createBritainFiefOverlayLoader,
  createCliopatriaFiefOverlayLoader,
  createCombinedYearLoader,
  createFranceFiefOverlayLoader,
  createHreOverlayLoader,
  createHreRealmLoader,
  createItalyFiefOverlayLoader,
  createSovereignFiefOverlayLoader,
  createYearDataLoader,
  createYearSwitcher,
  EMPTY_FEATURE_COLLECTION,
  type SuzerainKeyOf,
  withBorrowedGeometry,
  withPrimedYear,
  type YearDataLoader,
} from "./powers.ts";
import {
  EMPTY_FIEF_DEDUPE_TABLE,
  type FiefDedupeTable,
} from "./fief_dedupe.ts";
import { startStartupDataLoad } from "./data_loading.ts";
import {
  createDetailFocusTracker,
  detailFocusAppliesAt,
  detailFocusKeyForZoom,
  EMPTY_SUZERAIN_OVERRIDES,
  resolveSuzerainKey,
  type SuzerainOverrides,
  withSuzerainOverrides,
} from "./suzerain_extent.ts";
import type { CitiesData } from "./cities.ts";
import {
  EMPTY_POWER_DESCRIPTIONS,
  type PowerDescriptionTable,
} from "./power_descriptions.ts";
import {
  clearErrors,
  createLoadingState,
  failChunkLoad,
  failedYears,
  failLoading,
  hasChunkError,
  type LoadingState,
  startLoading,
  succeedLoading,
} from "./loading_state.ts";
import {
  BASE_OUTLINE_YEARS,
  BASEMAP_SOURCE_ID,
  BORROWED_HRE_OVERLAY_YEARS,
  BORROWED_ITALY_FIEF_OVERLAY_YEARS,
  BRITAIN_FIEF_OVERLAY_YEARS,
  CLIOPATRIA_FIEF_OVERLAY_YEARS,
  FALLBACK_STYLE_URL,
  FRANCE_FIEF_OVERLAY_YEARS,
  HRE_ALL_OVERLAY_YEARS,
  HRE_FIEF_OVERLAY_YEARS,
  HRE_REALM_YEARS,
  INITIAL_CENTER,
  INITIAL_YEAR,
  INITIAL_ZOOM,
  ITALY_FIEF_OVERLAY_YEARS,
  MAP_MAX_BOUNDS,
  MAX_ZOOM,
  MIN_ZOOM,
  SNAPSHOT_YEARS,
  SOVEREIGN_FIEF_OVERLAY_YEARS,
} from "./config.ts";
import {
  resolveBasemapPmtilesUrl,
  resolveDemPmtilesUrl,
} from "./pmtiles_url.ts";
import {
  type AppState,
  createReplaceStateUpdater,
  decodeState,
} from "./url_state.ts";
import {
  createPowerHighlightStore,
  HIGHLIGHT_FILL_TRANSITION_MS,
  YEAR_FILL_TRANSITION_MS,
} from "./power_highlight.ts";
import { collectionMetadata, createPickHandlers } from "./pick_handlers.ts";
import { installDebugHooks } from "./debug_hooks.ts";
import { watchDeckChunkLoad } from "./deck_chunk.ts";
// #247: deck.gl 系（@deck.gl/* を値 import する feature_layers.ts /
// political_layers.ts を含む）は動的 import（deckAppModulePromise）で後続
// チャンクへ分割する。main.ts からは型 import（コンパイル時に消える）だけを
// 許し、値 import を足すと分割が無効になるので注意（src/deck_app.ts 冒頭を参照）。
import type { FeatureLayerContext } from "./feature_layers.ts";
import type { PoliticalLayerContext } from "./political_layers.ts";
import type { DeckApp, DeckView } from "./deck_app.ts";
import {
  ATTRIBUTION_TOGGLE_LABEL,
  collapseAttributionControl,
  MAP_CUSTOM_ATTRIBUTION,
} from "./map_attribution.ts";
import { setupInfoUI } from "./ui/info_panel.ts";
import { setupLoadingUI } from "./ui/loading.ts";
import { setupTimeline } from "./ui/timeline.ts";

const mapContainer = document.getElementById("map");
if (!mapContainer) {
  throw new Error("#map 要素が見つかりません");
}

/**
 * deck.gl チャンク（src/deck_app.ts）のロード（#247）。初期チャンクの評価
 * 開始と同時に取得を始め、MapLibre のスタイル読み込み・PMTiles 取得と並行で
 * ダウンロードさせる（map.on("load") の時点では取得が進んでいる/完了している
 * ことを狙う）。オーバーレイの組み立て（createDeckApp）は main.ts 側の状態が
 * 出揃った後の deckAppPromise で行う。
 */
const deckAppModulePromise = import("./deck_app.ts");

// AC #2/#3: 起動時に URL クエリから表示状態を復元する（パース不能値はパラメータ
// 単位でデフォルトへフォールバック、範囲外の zoom / center はヨーロッパ域
// MAP_MAX_BOUNDS・MIN_ZOOM〜MAX_ZOOM 内へクランプ）。地図の初期 center/zoom と
// 初期年代はこの値を使う（TASK-22: 範囲外 URL でも表示が制限範囲内に収まる）。
const initialState = decodeState(
  globalThis.location.search,
  { year: INITIAL_YEAR, zoom: INITIAL_ZOOM, center: [...INITIAL_CENTER] },
  {
    years: SNAPSHOT_YEARS,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    minLon: MAP_MAX_BOUNDS[0][0],
    minLat: MAP_MAX_BOUNDS[0][1],
    maxLon: MAP_MAX_BOUNDS[1][0],
    maxLat: MAP_MAX_BOUNDS[1][1],
  },
);
const initialYear = initialState.year;

// TASK-127: PMTiles の配信元を実行時に解決する。本番/プレビュー
// （zeitreises.com / *.pages.dev）は R2 カスタムドメイン、ローカル開発は
// 従来どおり同一オリジンの /europe.pmtiles（判定は src/pmtiles_url.ts）。
const basemapPmtilesUrl = resolveBasemapPmtilesUrl(
  globalThis.location.hostname,
);
const demPmtilesUrl = resolveDemPmtilesUrl(globalThis.location.hostname);

// TASK-133: モバイル小画面（タッチ端末かつビューポート短辺 < 768px。判定基準の
// 根拠は basemap.ts の shouldEnableHillshade）では DEM hillshade を無効にして
// GPU メモリ・帯域の消費を抑える。判定は起動時に 1 度だけ行う（スタイルの
// 組み立てと PMTiles アーカイブ登録の入力になるため。短辺基準は画面回転で
// 不変なので、回転で判定が陳腐化することはない）。
const hillshadeEnabled = shouldEnableHillshade({
  viewportWidthPx: globalThis.innerWidth,
  viewportHeightPx: globalThis.innerHeight,
  maxTouchPoints: globalThis.navigator?.maxTouchPoints ?? 0,
});

// PMTiles プロトコルを MapLibre に登録（1 回だけ）
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

// アーカイブを登録しておくと pmtiles:// の解決とヘッダ取得を共有できる
const archive = new PMTiles(basemapPmtilesUrl);
protocol.add(archive);

// TASK-34 → #248: 地形 DEM（hillshade 用）の PMTiles アーカイブ登録・ヘッダ
// 取得は起動時には行わず、insertHillshadeAfterLoad（map load 後）へ遅延した。
// europe-dem.pmtiles（ヘッダ + タイル約 29 リクエスト）を初期ロードの
// critical path から外すため。
// TASK-133: モバイル小画面（hillshadeEnabled = false）では遅延追加もしない
// ため、DEM PMTiles へのリクエストは一切発生しない（AC #5 は不変）。

const map = new maplibregl.Map({
  container: mapContainer,
  // #248: 起動時は常に hillshade 無効のスタイルで構築する（デスクトップでも）。
  // スタイルに DEM ソースが無ければ MapLibre が europe-dem.pmtiles への
  // リクエスト（ヘッダ・タイル）を発行する経路が存在しないため、load
  // イベント（#249 以降は起動データの取得開始ではなく、待ち合わせ・初回
  // 描画のトリガ）が DEM 取得を待つことは構造的にない。hillshade は初回描画後（map.on("load") のハンドラ内、起動データ
  // 取得の開始より後）に insertHillshadeAfterLoad が同一の定義・挿入位置で
  // 追加し、最終的な見た目は従来と一致する（src/basemap_test.ts が検証）。
  style: buildBasemapStyle(
    basemapPmtilesUrl,
    demPmtilesUrl,
    false,
  ) as StyleSpecification,
  center: initialState.center,
  zoom: initialState.zoom,
  minZoom: MIN_ZOOM,
  maxZoom: MAX_ZOOM,
  // TASK-22: パン・ズームアウトをヨーロッパ域内に制限する（圏外へは出られない）
  maxBounds: MAP_MAX_BOUNDS,
  // #328: 出典・ライセンス表示は右下のコンパクトなアトリビューション「ⓘ」
  // 1 個へ統合する。OSM / Protomaps / Terrain Tiles はスタイルの source
  // 定義から MapLibre が従来どおり自動収集し（フォールバックスタイルでも
  // そのスタイルの source attribution が収集される。AC12）、歴史データの
  // 出典・ライセンス・変更表示は customAttribution で同じⓘへ足す。
  // 重複は「統合 attribution が source attribution を部分文字列として含む」
  // 関係で MapLibre 側の重複除去に畳ませる（src/map_attribution.ts）。
  attributionControl: {
    compact: true,
    customAttribution: MAP_CUSTOM_ATTRIBUTION,
  },
  // AC10: ⓘ の aria-label / title を日本語にする（既定は "Toggle attribution"）
  locale: {
    "AttributionControl.ToggleAttribution": ATTRIBUTION_TOGGLE_LABEL,
  },
});

// #328 AC1: MapLibre は compact 指定でも初期状態を展開（open +
// maplibregl-compact-show）にし、最初の地図ドラッグまで開いたままにする。
// 統合 attribution は本文が長く、そのままでは初期表示で地図の下端を広く
// 覆うため、コントロール生成直後（Map コンストラクタが addControl 済み）に
// 畳んで常設 UI を「ⓘ 1 個」にする。
if (!collapseAttributionControl(document)) {
  console.warn("アトリビューションコントロールが見つかりませんでした");
}

// TASK-22: コンストラクタの maxBounds は初期カメラに制約を適用しないことがあり、
// 境界ちょうどへクランプされた center（範囲外 URL 由来）だとビューポート下半分が
// 圏外を映したまま初期表示される。setMaxBounds を明示的に呼ぶと現在のカメラへ
// 即時に制約が適用され、初期表示から表示範囲が bounds 内に収まる。
map.setMaxBounds(MAP_MAX_BOUNDS);

let fallbackState = createFallbackState();

/** フォールバック判定を通し、必要なら OpenFreeMap スタイルへ一度だけ切り替える */
function handleBasemapError(event: BasemapErrorEvent, context: string): void {
  const decision = decideFallback(fallbackState, event, BASEMAP_SOURCE_ID);
  fallbackState = decision.state;
  if (decision.fallback) {
    console.warn(
      `ベースマップの取得に失敗（${context}）: ${
        event.error?.message ?? "unknown"
      }。OpenFreeMap にフォールバックします`,
    );
    map.setStyle(FALLBACK_STYLE_URL);
    // TASK-77: 新スタイルの水面レイヤー有無で beforeId が変わるため、読み込み
    // 完了後に一度だけレイヤーを組み直す（水面が無いスタイルでも beforeId なし
    // の従来描画順で描かれるようにする）。styledata の常時購読はレイヤー追加で
    // 自身が再発火するため、フォールバック時の once に限定する。
    map.once("styledata", () => renderLayers());
  }
}

// AC #3: PMTiles メタデータ（ヘッダ）取得失敗の検知
archive.getHeader().catch((error: unknown) => {
  handleBasemapError(
    { error: { message: `pmtiles: ${String(error)}` } },
    "メタデータ取得",
  );
});

// AC #3: タイル取得失敗の検知（MapLibre の error イベント経由）
map.on("error", (event) => {
  handleBasemapError(event as unknown as BasemapErrorEvent, "タイル取得");
});

// TASK-80: 概略境界（MapLibre の line レイヤー）はスタイル側の状態なので、
// スタイルが変わるたびに「存在するか・重ね順が正しいか」を確認して追いつかせる。
// 同期本体・描画データのメモ化・再入ガード・styledata 購読の組み立ては
// src/approximate_border_sync.ts へ抽出した（TASK-150）。状態の所有のうち
// 「直近に反映した描画データ」だけはファクトリの closure が持ち（decision-29 の
// U7 で許された例外）、map への操作・スタイルのレイヤー ID 列・currentView・
// renderLayers への逆参照はここから getter / コールバックで注入する。
// currentView / renderLayers はこの時点では未確定・未定義だが、closure が
// 呼ばれるのはスタイルイベント・年代切替時なので安全に遅延参照できる。
const approximateBorderSync = createApproximateBorderSync({
  getStyleLayerIds: currentStyleLayerIds,
  getSource: (id) => map.getSource(id),
  addSource: (id, spec) => map.addSource(id, spec),
  getLayer: (id) => map.getLayer(id),
  addLayer: (spec, beforeId) => map.addLayer(spec, beforeId),
  onStyleData: (listener) => map.on("styledata", listener),
  hasCurrentView: () => currentView !== null,
  requestRender: () => renderLayers(),
  warn: (message) => console.warn(message),
});

// #305: 沿岸補完（政治ポリゴンの塗りを現代海岸線まで届かせる帯）も MapLibre の
// line レイヤー = スタイル側の状態なので、概略境界と同じくスタイルの変化へ
// styledata 購読で追いつかせる。挿入位置は内水面の直下（coastal_fill.ts の
// coastalFillBeforeId）で deck レイヤーの相対順に関与しないため、requestRender
// の逆参照は持たない。
const coastalFillSync = createCoastalFillSync({
  getStyleLayerIds: currentStyleLayerIds,
  // #326: 帯のジオメトリはビルド時に作って配信する（deno task
  // build-coastal-fill）。coastalFillBandLoader はこの時点では未定義だが、
  // closure が呼ばれるのは renderLayers（年代切替）時なので安全に遅延参照
  // できる。取得失敗時は coastal_fill_sync が warn を出して実行時生成へ縮退する
  loadBands: (year) => coastalFillBandLoader.load(year),
  getSource: (id) => map.getSource(id),
  addSource: (id, spec) => map.addSource(id, spec),
  getLayer: (id) => map.getLayer(id),
  addLayer: (spec, beforeId) => map.addLayer(spec, beforeId),
  setFeatureState: (target, state) => map.setFeatureState(target, state),
  removeFeatureState: (target) => map.removeFeatureState(target),
  onStyleData: (listener) => map.on("styledata", listener),
  // #330: 帯の幾何は勢力圏の外枠（hre-extent）の union 入力でもある。年代
  // GeoJSON より後から届くので、確定した時点で外枠を作り直させる
  requestRender: () => renderLayers(),
  warn: (message) => console.warn(message),
});

// ---- 勢力圏ポリゴンレイヤー（TASK-5, docs/app-spec.md §3.3, §4.3）----

// pickable なレイヤーの ID（powers / hre-powers / cities / cities-hit /
// rivers / rivers-hit）は
// picking.ts に集約した（TASK-29）。picking の優先順位（PICKING_PRIORITY）と
// 描画順の対応を 1 箇所で管理するため。各レイヤーとも年代切替・選択変更で
// 同一 ID を保ち、data 差し替えのみで deck.gl の差分更新に任せる方針は不変。

// ラベル 3 層（power-labels / river-labels / city-labels）の ID は TASK-77 で
// layer_stack.ts へ移した。beforeId によるレイヤーグループ分割と衝突フィルタの
// 両立のため、この 3 層だけを overlaid オーバーレイに載せる分配ルールと同じ
// 場所で管理する。

// 勢力圏の外枠（hre-extent）のレイヤー ID・見た目定数（HRE_EXTENT_*）は
// 政治レイヤー builder 群とともに src/political_layers.ts へ移した（TASK-148）。

/** colors.json（NAME / "NAME|SUBJECTO" → HEX のフラットマップ） */
let colors: Record<string, string> = {};

/**
 * name-overrides.json の内容（renames = SUBJECTO 生値 → 正規化名、
 * suzerains = 宗主補正）。ラベル整形と勢力圏の外枠（TASK-94）で使う。
 */
let overrides: SuzerainOverrides = EMPTY_SUZERAIN_OVERRIDES;

/**
 * name-ja.json（英語 NAME → 日本語名のフラットマップ）。ツールチップ・パネル・
 * 地図上ラベルの表示だけを日本語化する（TASK-23）。未登録名は英語のまま。
 */
let nameJa: Record<string, string> = {};

/**
 * power-descriptions.json（年代 × 補正後の内部名 → 一文要約）。クリック情報
 * パネルの説明欄だけが読む（Issue #283）。取得失敗・未登録は空の表のままで、
 * パネルは名称（+ 年代）へ縮退する。
 */
let powerDescriptions: PowerDescriptionTable = EMPTY_POWER_DESCRIPTIONS;

// 年代 GeoJSON のローダ（fetch は本番のもの）。base（europe_*）・HRE 領邦
// オーバーレイ・中世フランス諸侯領オーバーレイ（france_fiefs_*、1000〜1300。
// TASK-71）を複合ローダで束ね、並行ロードして全て揃ってから反映する。
// オーバーレイの取得失敗は powers.ts 側で warn + 空扱いになり、base の表示・
// ローディング/エラー UI（failLoading）は base 失敗時のみ動く。非対象年の
// オーバーレイは fetch されず空 FC になるため、ベースマップの勢力ポリゴンと
// 二重表示になることはない。
// TASK-86: HRE 領邦は 1000〜1492（OHM 由来 hre_fiefs_flat_*）と 1500〜1700
// （Roller 由来 hre_*）の 2 系統を 1 本のローダ・1 枚のレイヤー（hre-powers）で
// 扱う。年代→ファイルの解決だけ hreDataUrlFor に閉じ込めてあるため、以降の
// 色・ラベル・帝国範囲強調・picking は年代分岐なしで一貫する。
// TASK-78/86: base 境界線オーバーレイ（base_outline_*）も同じ複合ローダに載せる。
// オーバーレイのある全年（BASE_OUTLINE_YEARS = 1000〜1492）の派生データで、
// 揃ってから同時に反映しないと「輪郭層がまだ来ていない」1 フレームが出るため。
// TASK-94: 取得した全レイヤーへ宗主補正（name-overrides.json suzerains）を
// 一度だけ適用する。SUBJECTO を補正後の宗主名へ書き換えることで、外枠
// （suzerain_extent.ts）だけでなく色キー（powers.ts colorKeyFor）・表示ラベル
// （info.ts displayLabel）も同じ封建関係を反映する。補正が 1 件も効かない年は
// 入力インスタンスがそのまま返り、deck.gl の差分更新は従来どおり効く。
// #249: getter はモジュール変数ではなく開始済みの取得 Promise
// （startupData.overrides）を返す。前倒しした年代 geojson が
// name-overrides.json より先に解決しても、補正の適用（とキャッシュ）は
// overrides の解決を待ってから行われるため、初回描画から補正済みになる
// （withSuzerainOverrides 側の #249 契約）。loadOverrides は失敗時も
// EMPTY_SUZERAIN_OVERRIDES へ解決し reject しない（縮退契約）。
const withOverrides = (loader: YearDataLoader) =>
  withSuzerainOverrides(loader, () => startupData.overrides);

/**
 * アセット manifest（論理パス → ハッシュ付き配信パス。#246）のロード Promise。
 * 最初の fetchAsset 呼び出しが 1 回だけロードを開始し、以後の全 fetch が同じ
 * 結果を待つ（decision-29: 状態の所有は main.ts）。initPowerLayer の完了を
 * 待たずに __setYear 等でデータ fetch が走っても、manifest 未解決のまま論理
 * パスへ fetch してしまうレースが起きない。取得失敗・生配信（manifest 無し）
 * のときは null に解決され、論理パスへフォールバックして従来どおり動く。
 */
let assetManifestPromise: Promise<AssetManifest | null> | null = null;

/**
 * manifest 経由でデータ URL を解決してから fetch する共通の注入点（#246）。
 * 年代 GeoJSON ローダ群と data_loading.ts の静的データローダ群はすべて
 * この関数を使うため、app.js（index.html がビルド時に書き換え）と data/*
 * は常に同一ビルド（同一 manifest）の組で読まれる（TASK-35 の整合性要件）。
 */
const fetchAsset = async (url: string): Promise<Response> => {
  assetManifestPromise ??= loadAssetManifest();
  return await fetch(resolveAssetUrl(await assetManifestPromise, url));
};

// #249 AC1: 起動データ（年代非依存の静的 9 件）の取得はモジュール評価の
// この時点で開始する。map の load イベント・deck.gl チャンクのロードを
// 待たない（取得開始の前倒しのみで、描画前の待ち合わせは initPowerLayer の
// Promise.all が従来どおり行う）。各 Promise は失敗時 warn + フォールバック
// 値へ解決し reject しない（data_loading.ts の縮退契約）ため、initPowerLayer
// が await するまで保持しても unhandled rejection にならない。
const startupData = startStartupDataLoad(fetchAsset);

/**
 * 沿岸補完の帯（事前生成した幾何）の年代別ローダ（#326）。
 *
 * 他の年代データと同じ createYearDataLoader（LRU 上限 YEAR_CACHE_MAX_YEARS 年 +
 * 同一年の inflight 共有 + manifest 経由の URL 解決）に載せる。combinedYearLoader
 * には**含めない**: 帯は年代切替の描画に必要な 9 本と違って「描画の後から
 * 追いつけばよい」ものであり、束ねると年送りがこの取得を待つことになる
 * （#312 が defer で確保した「年送り操作は止まらない」性質を保つ）。
 * 年ごとに遅延取得するので、転送量が増えるのは実際に表示した年の分だけ
 * （1 年あたり実測 184〜256KB / gzip 約 70KB）。
 */
const coastalFillBandLoader = createYearDataLoader(
  fetchAsset,
  coastalFillDataUrlFor,
);

const combinedYearLoader = createCombinedYearLoader(
  withOverrides(createYearDataLoader(fetchAsset)),
  // #202 / ADR-0033: 1492 年のオーストリア大公領はどの上流にも面が無いため、
  // 隣接年（1500）の Roller 由来の面を借用ファイルから足す。レイヤーは
  // hre-powers のまま 1 枚で、出典・ライセンスだけが feature ごとに解決される
  // （pick_handlers.ts featureAttribution）。借用の無い年は fetch されない。
  withOverrides(withBorrowedGeometry(
    createHreOverlayLoader(
      fetchAsset,
      HRE_ALL_OVERLAY_YEARS,
      console.warn,
      HRE_FIEF_OVERLAY_YEARS,
    ),
    createBorrowedHreLoader(fetchAsset, BORROWED_HRE_OVERLAY_YEARS),
  )),
  withOverrides(
    createFranceFiefOverlayLoader(
      fetchAsset,
      FRANCE_FIEF_OVERLAY_YEARS,
    ),
  ),
  withOverrides(
    createBaseOutlineLoader(fetchAsset, BASE_OUTLINE_YEARS),
  ),
  // TASK-92: 諸侯領の下地になる base 塗りを差し引いた派生 base。輪郭
  // （base_outline_*）と同じ union から作られるので、年集合も同一。
  withOverrides(createBaseFillLoader(fetchAsset, BASE_OUTLINE_YEARS)),
  // TASK-96: イタリア諸侯領（italy_fiefs_flat_*、1000〜1500。#188）。仏諸侯領・
  // HRE 領邦と同じ機構に載せ、非対象年は fetch せず空 FC になる。
  // #202: 1492 年のミラノ公国は OHM の 1447〜1500 が空白なので、隣接年（1500）の
  // rel 2800654 を借用ファイルから足す（HRE 側と同じ機構・同じ縮退契約）。
  withOverrides(
    withBorrowedGeometry(
      createItalyFiefOverlayLoader(
        fetchAsset,
        ITALY_FIEF_OVERLAY_YEARS,
      ),
      createBorrowedItalyFiefLoader(
        fetchAsset,
        BORROWED_ITALY_FIEF_OVERLAY_YEARS,
      ),
    ),
  ),
  // TASK-110: Cliopatria 由来の領邦（cliopatria_fiefs_flat_*、1000〜1492）。
  // OHM に該当リレーションが無い領邦だけを収録する補完データで、既存 3 系統と
  // 同じ機構に載せる。ファイル未生成・取得失敗は warn + 空 FC に落ちるため、
  // データ側の生成前でもアプリは従来どおり動く（縮退契約）。
  withOverrides(
    createCliopatriaFiefOverlayLoader(
      fetchAsset,
      CLIOPATRIA_FIEF_OVERLAY_YEARS,
    ),
  ),
  // #172: ブリテン諸島の政体（britain_fiefs_flat_*、1000〜1700）。base が
  // 一括りに塗るウェールズ・アイルランドの政体を識別可能にする補完で、既存
  // 4 系統と同じ機構に載せる。非対象年（1715 以降）は fetch せず空 FC になり、
  // base の United Kingdom / Kingdom of Ireland と二重表示にならない。
  withOverrides(
    createBritainFiefOverlayLoader(
      fetchAsset,
      BRITAIN_FIEF_OVERLAY_YEARS,
    ),
  ),
  // #189: 主権政体オーバーレイ（sovereign_fiefs_flat_*、1200〜1900）。base の
  // 一枚岩塗り（オスマン・ハプスブルク・ロシア）に隠れた主権政体を識別可能に
  // する補完で、既存 5 系統と同じ機構に載せる。非対象年（1914 等）は fetch
  // せず空 FC になり、base が個別収録する後継国家と二重表示にならない。
  withOverrides(
    createSovereignFiefOverlayLoader(
      fetchAsset,
      SOVEREIGN_FIEF_OVERLAY_YEARS,
    ),
  ),
  // #332: 帝国全域ジオメトリ（hre_realm_*、1715〜1800）。政治レイヤーとしては
  // 描画も picking もせず、勢力圏の外枠（hre-extent）の union 入力にだけ入る。
  // base と同じ複合ローダで束ねるのは、外枠が常に「表示中の年の帝国」を囲む
  // 必要があるため（遅れて届く経路にすると年代切替直後に前年の帝国が出る）。
  // 非対象年は fetch されず空 FC で、外枠は従来どおり base だけで決まる。
  withOverrides(createHreRealmLoader(fetchAsset, HRE_REALM_YEARS)),
);

// #249 AC2: 初期年代の geojson 9 件の取得も、静的データ 9 件の完了・map の
// load イベントを待たずにここ（モジュール評価時）で開始する。前倒しした
// Promise は withPrimedYear が reject させず Result に包んで保持し、最初の
// load(initialYear)（initPowerLayer → switchYear → yearSwitcher 経由）が
// 消費して、失敗は従来どおり switchYear のエラー経路（failLoading +
// console.error + トースト再試行）で処理される。
const dataLoader = withPrimedYear(combinedYearLoader, initialYear);

/**
 * 諸侯領による base 勢力の被覆率表（/data/fief-dedupe.json、TASK-78）。
 * 取得失敗・未生成時は空表のままで、ラベル抑制が起きず従来表示になる。
 */
let fiefDedupe: FiefDedupeTable = EMPTY_FIEF_DEDUPE_TABLE;

/** 主要河川 GeoJSON（起動時に 1 度ロード。失敗時は空のまま河川なしで継続） */
let riversData: FeatureCollection = EMPTY_FEATURE_COLLECTION;

/**
 * 主要山脈 GeoJSON（TASK-97。年代非依存なので起動時に 1 度ロード）。
 * 失敗・未生成時は空のまま山脈ラベルなしで継続する（河川と同じ縮退方針）。
 */
let mountainsData: FeatureCollection = EMPTY_FEATURE_COLLECTION;

/** Natural Earth 海域ラベルアンカー（年代非依存・取得失敗時は空）。 */
let marineData: FeatureCollection = EMPTY_FEATURE_COLLECTION;

/**
 * 主要山峰 GeoJSON（TASK-99。山脈と同じく年代非依存なので起動時に 1 度ロード）。
 * 失敗・未生成時は空のまま山峰なしで継続する（河川・山脈と同じ縮退方針）。
 */
let peaksData: FeatureCollection = EMPTY_FEATURE_COLLECTION;

/**
 * 主要都市データ（TASK-27。起動時に 1 度ロード）。
 * 取得失敗・未生成時は空のまま都市なしで継続する（colors.json 等と同様）。
 */
let citiesData: CitiesData = { cities: [], years: {} };

/**
 * ズーム別の表示制御に使う現在の整数ズーム段（TASK-66 AC #2、TASK-97）。
 * renderLayers はズーム変化では呼ばれないため、map の zoom イベントで
 * この値を監視し「整数段が変わった時のみ」レイヤーを再構築する
 * （applyRiverHover と同じ変化検知パターン。小数ズームの連続変化
 * = 毎フレームの再構築を避ける。TASK-50 の無駄な再構築回避方針）。
 * 表示件数の段階は都市が cities.ts の visibleCityRankLimit、山脈名が
 * mountains.ts の mountainLabelMinZoom、山峰が peaks.ts の peakMinZoom で
 * 決める（同じ整数段を共有する）。
 */
let zoomStep = Math.floor(initialState.zoom);

// 選択/ホバー状態 7 変数（selectedRiverName / hoveredRiverName /
// selectedMountainName / hoveredMountainName / selectedPeakName /
// hoveredPeakName / extentKey）は picking イベント処理とともに
// src/pick_handlers.ts の createPickHandlers（closure 所有）へ移した
// （TASK-149）。renderLayers の context 組み立てとデバッグフックは
// pickHandlers の読み取り用 getter で参照する。

/**
 * 政治ポリゴン（powers / hre-powers / france-fiefs）のアクティブ強調状態
 * （TASK-90）。ホバー/クリックした勢力・領邦の塗りをアクティブ色
 * （power_highlight.ts ACTIVE_FILL_COLOR）へ変え、飛び地を含む同一勢力キーの
 * 全ポリゴンを同時に光らせて国土の広がりを示す。
 *
 * onChange は「値が変わったときだけ」呼ばれる（変化検知はストア側。TASK-50 の
 * 規律を維持し、mousemove ごとの全レイヤー再構築を避ける）。再構築時の塗りの
 * 遷移は年代フェード（400ms）ではなく強調用の短い遷移を使う。
 */
const powerHighlight = createPowerHighlightStore(() => {
  // 年代切替による解除は直後の renderLayers() にまとめる（下の applyFn 参照）
  if (suppressPowerHighlightRender) return;
  renderWithFillTransition(HIGHLIGHT_FILL_TRANSITION_MS);
});

/**
 * 年代切替の適用中だけ true。powerHighlight.clear() による再構築を抑止し、
 * 直後に呼ばれる renderLayers()（年代フェード付き）に 1 本化する。
 */
let suppressPowerHighlightRender = false;

/**
 * 次の renderLayers() で使う政治ポリゴンの getFillColor 遷移時間（ms）。
 * 既定は年代切替のフェード（400ms、docs/app-spec.md §5.1）。強調の変化だけは
 * renderWithFillTransition が一時的に短い値へ差し替える（TASK-90）。
 */
let fillTransitionMs: number = YEAR_FILL_TRANSITION_MS;

/** 塗りの遷移時間を一時的に差し替えてレイヤーを再構築する（TASK-90） */
function renderWithFillTransition(durationMs: number): void {
  const previous = fillTransitionMs;
  fillTransitionMs = durationMs;
  try {
    renderLayers();
  } finally {
    fillTransitionMs = previous;
  }
}

/**
 * 直近に反映された年代のデータ。選択変更時のレイヤー再構築で使う（各フィールドの
 * 意味は powers.ts YearLayerData を参照。#247 で deck_app.ts と型を共有）。
 */
let currentView: DeckView | null = null;

/**
 * 地図中央が属する上位勢力（詳細表示 focus。#345 / #293 分割 1/5）。
 *
 * 状態（focus キーと解決に使った中央座標）の所有は suzerain_extent.ts の
 * ファクトリ closure に置く（approximate_border_sync.ts / pick_handlers.ts と
 * 同じ decision-29 の例外。更新契機そのものをユニットテストできる）。main.ts は
 * 現在の中央・base・宗主補正を getter で渡し、購読先として moveend を与える
 * だけにする。
 *
 * 更新契機は **moveend（下の URL 同期と同じ確定イベント）と年代変更
 * （yearSwitcher の applyFn からの refresh）だけ**。連続発火する move / zoom は
 * 購読しない。
 *
 * #350: 解決結果は {@linkcode activeDetailFocusKey} を通して塗り・概略境界・
 * レイヤー/ラベル・picking の 4 経路へ配る。パン停止で中央が別の上位勢力へ
 * 移ったときの再描画は、tracker の onChange（変化したときだけ発火）から行う。
 */
const detailFocus = createDetailFocusTracker({
  getCenter: () => {
    const c = map.getCenter();
    return [c.lng, c.lat];
  },
  getBase: () => currentView?.base ?? null,
  getOverrides: () => overrides,
  onMoveEnd: (listener) => {
    map.on("moveend", listener);
  },
  // #293 AC6: パン停止で focus が変わったら詳細表示を追従させる。概観表示
  // （z4）では focus をどこにも渡していないため再描画しない（AC8）。
  onChange: () => {
    if (!detailFocusAppliesAt(zoomStep)) return;
    renderLayers();
  },
});

/**
 * base feature の宗主キー解決（#350）。塗りの focus 合成（powers.ts
 * `composeDetailFocus`）と概略境界の合成が使う。
 *
 * **単一の closure を使い回す**のが要点で、この関数参照が合成結果のメモ化
 * （political_layers.ts `powerFillData` / approximate_border_sync.ts
 * `memoizedApproximateBorderData`）のキーに入る。renderLayers のたびに作り直すと
 * 必ずキャッシュミスになり、ホバーごとに塗り・境界が再計算・再アップロードされる。
 * `overrides` は呼び出しのたびに読むので、name-overrides.json が遅れて届いても
 * 最新の補正が効く。
 */
const suzerainKeyOf: SuzerainKeyOf = (props) =>
  resolveSuzerainKey(props, overrides);

/**
 * 描画・picking へ実際に渡す詳細表示 focus（#350）。
 *
 * ズームゲート（z4 は null = 機能オフ）と「中央が海上」の縮退
 * （UNRESOLVED_DETAIL_FOCUS_KEY）は suzerain_extent.ts の純粋関数
 * {@linkcode detailFocusKeyForZoom} に閉じ込め、**4 経路すべてがこの 1 関数の
 * 結果を共有する**。塗り・概略境界・レイヤー/ラベル・picking のどれか 1 つでも
 * 別の判定を持つと、部分適用の中間状態（透明な穴・二重塗り・不可視領邦の
 * picking）が生まれるため。
 */
function activeDetailFocusKey(): string | null {
  return detailFocusKeyForZoom(detailFocus.key(), zoomStep);
}

// ---- picking イベント処理（TASK-149: src/pick_handlers.ts へ抽出）----

// picking 結果の解決（pickedLabel / pickedMetadata / resolveClickInfo）と
// Deck レベルのホバー/クリック処理（handlePickHover / handlePickClick）、
// および選択/ホバー状態 7 変数の所有は createPickHandlers に閉じ込めた。
// main.ts 所有のデータストア・currentView は getter で、表示先（infoUi）・
// 再構築（renderLayers）・強調ストア（powerHighlight）・近傍再ピック
// （overlay.pickMultipleObjects）はコールバックで注入する。infoUi と deckApp は
// この時点では未初期化だが、closure が呼ばれるのは map load 後（deck チャンク
// ロード済み・オーバーレイ統合済み）の picking イベント発生時なので安全に
// 遅延参照できる（#247: 未ロード時は空の picking 結果に縮退する）。
const pickHandlers = createPickHandlers({
  getNameJa: () => nameJa,
  getOverrides: () => overrides,
  // #283: クリック情報パネルの一文要約を「表示年 × 補正後の内部名」で引く
  getPowerDescriptions: () => powerDescriptions,
  getCurrentView: () => currentView,
  // #228: powers の picking 出典解決が表示モード（politicalDetailVisibleAt）を
  // 塗りと共有するための現在ズーム段
  getZoomStep: () => zoomStep,
  // #223: 都市 pick ラベルの時代別都市名解決に使う現在の表示年。yearSwitcher は
  // この時点では未初期化（後方で const 定義）だが、closure が呼ばれるのは
  // map load 後の picking イベント発生時なので安全に遅延参照できる
  getYear: () => yearSwitcher.currentYear() ?? initialYear,
  getRiversData: () => riversData,
  getMountainsData: () => mountainsData,
  getPeaksData: () => peaksData,
  getCitiesData: () => citiesData,
  showTooltip: (label, x, y) => infoUi.showTooltip(label, x, y),
  hideTooltip: () => infoUi.hideTooltip(),
  showInfoPanel: (content) => infoUi.showInfoPanel(content),
  requestRender: () => renderLayers(),
  powerHighlight,
  pickMultipleObjects: (opts) =>
    deckApp === null ? [] : deckApp.overlay.pickMultipleObjects(opts),
  // Issue #253: タッチ主体（pointer: coarse）ならカーソル追従ツールチップを
  // 抑止する（判定は pick_handlers.ts suppressHoverTooltip）。matchMedia は
  // 都度評価し、タブレット + マウス接続のような入力構成の変化にも追従させる
  isCoarsePointer: () => matchMedia("(pointer: coarse)").matches,
  // #350 AC4: 塗り・レイヤーへ配るのと同じ focus を picking へも渡す。focus 外の
  // 領邦は表示されないので候補からも降格し、不可視の面が picking を奪わない。
  getDetailFocusKey: activeDetailFocusKey,
});

/**
 * deck.gl 側のハンドル一式（オーバーレイ 2 枚・renderLayers・builder 群）。
 * #247: 実体は後続チャンク（src/deck_app.ts）にあり、ロード完了
 * （deckAppPromise）まで null。null の間の renderLayers は no-op で、初期
 * 描画は map.on("load") が deckAppPromise を await してから始まるため、実際の
 * 描画要求が deck 未ロードで失われることはない。
 */
let deckApp: DeckApp | null = null;

/**
 * deck.gl オーバーレイの組み立て（#247）。overlay の生成・picking 配線・
 * レイヤー組み立て（旧 main.ts の renderLayers 本体）は src/deck_app.ts へ
 * 移した。状態の所有は従来どおり main.ts に残し（decision-29）、getter と
 * コールバックで注入する。featureLayerContext / politicalLayerContext /
 * currentStyleLayerIds は関数宣言（hoisting）、pickHandlers /
 * approximateBorderSync は const だが、参照されるのはモジュール評価完了後
 * （Promise 解決後）なので安全。
 */
const deckAppPromise: Promise<DeckApp> = deckAppModulePromise.then((m) => {
  const app = m.createDeckApp({
    getCurrentView: () => currentView,
    featureLayerContext,
    politicalLayerContext,
    getZoomStep: () => zoomStep,
    currentStyleLayerIds,
    // #350: 概略境界にも同じ focus を渡す。focus 外は領邦オーバーレイを描かない
    // ため、諸侯領 union で切り出した outlines のままだと上位勢力の輪郭が領邦の
    // 縁で途切れる（focus 外だけ素の base ポリゴンの環から引き直す）。
    applyApproximateBorders: (base, outlines) =>
      approximateBorderSync.apply(
        base,
        outlines,
        activeDetailFocusKey(),
        suzerainKeyOf,
      ),
    // #305: 帯の色（colors / overrides）と強調キー（powerHighlight）は main.ts
    // 所有の状態なので、ここで現在値のスナップショットを補って渡す
    applyCoastalFill: (base, year) =>
      coastalFillSync.apply(
        base,
        year,
        colors,
        overrides,
        powerHighlight.selected(),
        powerHighlight.hovered(),
      ),
    onHover: pickHandlers.handlePickHover,
    onClick: pickHandlers.handlePickClick,
  });
  deckApp = app;
  return app;
});

// 諸侯領境界線の見た目定数（FIEF_LINE_*）は src/political_layers.ts へ移した
// （TASK-148）。renderLayers の呼び出し引数として import して使う。

/**
 * 現在の MapLibre スタイルのレイヤー ID 列を返す（TASK-77）。
 *
 * beforeId は実在するレイヤー ID でなければならない（存在しない ID を渡すと
 * MapLibre は例外ではなく error イベントを出してレイヤー追加を諦め、対象の
 * deck レイヤーが無言で描画されなくなる。詳細は layer_stack.ts）。判定は
 * 「起動時にビルドしたスタイル」ではなく常に現在のスタイルに対して行い、
 * OpenFreeMap へのフォールバック後（handleBasemapError）でも実態に追従させる。
 * スタイル未読込・差し替え中は空配列を返し、beforeId なしの従来描画順にする。
 *
 * TASK-80: getStyle().layers ではなく getLayersOrder() を使う。getStyle() は
 * スタイル仕様として直列化できるレイヤーだけを返すため、deck.gl（interleaved）が
 * 追加する custom レイヤー（powers / france-fiefs / hre-powers …）が現れず、
 * 「概略境界が政治ポリゴンの塗りより上に居るか」を判定できない
 * （ヘッドレス確認で powers が getStyle().layers に出ないことを実測）。
 * getLayersOrder() は custom を含む実際の描画順を返す（maplibre-gl 4.7.1）。
 */
function currentStyleLayerIds(): string[] {
  try {
    return map.getLayersOrder?.() ??
      map.getStyle()?.layers?.map((layer) => layer.id) ?? [];
  } catch {
    return [];
  }
}

// 政治ポリゴン builder（buildPowerLayer）は src/political_layers.ts へ移した
// （TASK-148）。renderLayers が politicalLayerContext 経由で呼ぶ。

// ---- レイヤー builder 群（TASK-147/148、#247: 生成は src/deck_app.ts）----

// 地物 12 builder（feature_layers.ts）と政治 3 builder（political_layers.ts）の
// ファクトリ呼び出しは createDeckApp（後続チャンク）へ移した。メモ化キャッシュ
// （TASK-50/136 の参照同値契約の実体）は builder とデバッグフック
// （installDebugHooks への注入）で従来どおり共有する（deckApp.featureLayers /
// deckApp.politicalLayers）。状態の所有は従来どおり main.ts に残し
// （decision-29）、builder へは renderLayers が featureLayerContext /
// politicalLayerContext で現在値のスナップショットを渡す。

/**
 * 地物レイヤー builder へ渡す main.ts 所有状態のスナップショットを組み立てる
 * （TASK-147）。メモ化は context オブジェクトではなく中身の参照（riversData 等）
 * をキーにするため、renderLayers のたびに新しい context を作っても TASK-50/136 の
 * 参照同値契約は崩れない。
 */
function featureLayerContext(year: number): FeatureLayerContext {
  return {
    year,
    riversData,
    marineData,
    mountainsData,
    peaksData,
    citiesData,
    nameJa,
    zoomStep,
    // 選択/ホバー状態は pick_handlers.ts の closure が所有する（TASK-149）。
    // getter で現在値のスナップショットを取り出して値で渡す（変化時は必ず
    // requestRender = renderLayers 経由で呼び直されるため古くならない）。
    selectedRiverName: pickHandlers.selectedRiverName(),
    hoveredRiverName: pickHandlers.hoveredRiverName(),
    selectedMountainName: pickHandlers.selectedMountainName(),
    hoveredMountainName: pickHandlers.hoveredMountainName(),
    selectedPeakName: pickHandlers.selectedPeakName(),
    hoveredPeakName: pickHandlers.hoveredPeakName(),
  };
}

/**
 * 政治レイヤー builder へ渡す main.ts 所有状態のスナップショットを組み立てる
 * （TASK-148）。メモ化は context オブジェクトではなく中身の参照（base 等の
 * 引数と nameJa / fiefDedupe）をキーにするため、renderLayers のたびに新しい
 * context を作っても TASK-50/136 の参照同値契約は崩れない。強調キー
 * （powerHighlight）と fillTransitionMs は値で渡す: 変化時は必ずストアの
 * onChange / renderWithFillTransition 経由で renderLayers が呼び直されるため、
 * スナップショットが古くなることはない。
 */
function politicalLayerContext(year: number): PoliticalLayerContext {
  return {
    year,
    colors,
    nameJa,
    overrides,
    fiefDedupe,
    zoomStep,
    // 外枠の宗主キーも pick_handlers.ts が所有する（TASK-149。上と同じ理由で
    // 値のスナップショットを渡す）
    extentKey: pickHandlers.extentKey(),
    selectedPowerKey: powerHighlight.selected(),
    hoveredPowerKey: powerHighlight.hovered(),
    fillTransitionMs,
    // beforeId（underWaterBeforeId）の入力。スタイル差し替え時は renderLayers が
    // 呼び直されるため、1 回の描画内でのスナップショットで十分
    styleLayerIds: currentStyleLayerIds(),
    // #330: 勢力圏の外枠へ合流させる沿岸補完の帯（幾何）。帯が未取得・帯を
    // 描かないスタイルでは null（従来どおり元ポリゴンだけの外枠）
    coastalBands: coastalFillSync.extentBands(),
    // #350: 詳細表示を中央 1 か国へ絞る focus と、その分類に使う base。
    // 塗り（powerFillData）・オーバーレイ 6 系統・勢力ラベルがこの 1 組を
    // 共有するため、部分適用の中間状態が構造的に生まれない。
    detailFocusKey: activeDetailFocusKey(),
    base: currentView?.base ?? null,
    // #382: focus で描画から外れた諸侯領を powers の塗りへ戻すための入力。
    // currentView のスロットをそのまま渡す（buildPowerLayer / buildLabelLayer
    // へ引数で渡すのと同一参照。合成結果のメモ化キーに入る）。
    hre: currentView?.hre ?? null,
    fiefs: currentView?.fiefs ?? null,
    italyFiefs: currentView?.italyFiefs ?? null,
    cliopatriaFiefs: currentView?.cliopatriaFiefs ?? null,
    britainFiefs: currentView?.britainFiefs ?? null,
    sovereignFiefs: currentView?.sovereignFiefs ?? null,
  };
}

// 概略境界の同期本体（旧 syncApproximateBorders）・メモ化
// （memoizedApproximateBorderData）・再入ガードは src/approximate_border_sync.ts
// へ移した（TASK-150）。ファクトリ生成（approximateBorderSync）は styledata
// 購読の組み立てと同じ場所（上の map 配線部）で行う。

/**
 * 現在の年代データ + 河川 + 都市 + ラベルの全レイヤーを組み立てて overlay へ
 * 反映する。#247: レイヤー組み立ての本体（描画順・picking 優先順・overlaid
 * 分配の不変条件検証を含む）は後続チャンクの src/deck_app.ts renderLayers へ
 * 移した。deck チャンク未ロードの間（deckApp === null）は no-op:
 * この間は currentView も未確定（初期描画は map.on("load") →
 * deckAppPromise 解決後の initPowerLayer 経由）なので、描くべきものはまだ無い。
 */
function renderLayers(): void {
  deckApp?.renderLayers();
}

// 勢力名ラベル builder（buildLabelLayer + memoizedPowerLabelData /
// memoizedVisiblePowerLabels）は src/political_layers.ts へ移した（TASK-148）。

// ホバー/クリック情報 UI（TASK-7/109/111）の DOM 配線は src/ui/ へ抽出した
// （TASK-146）。buildPowerLayer は年代切替のたびに再生成されるため、レイヤー
// 側は常にこのハンドルを参照し、DOM 配線は 1 度だけ行う。
// #328: 出典・免責の独自フッター（TASK-26）とデータ制限一覧（TASK-46）の配線は
// 撤去した（出典・ライセンスの表示は MapLibre のアトリビューションへ統合し、
// 境界精度の免責と制限一覧はユーザー向け表示から除いた）。
const infoUi = setupInfoUI({
  doc: document,
  viewportSize: () => ({
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
  }),
});

// 年代切替の競合ガード（DOM/deck.gl 非依存ロジックは powers.ts に集約）。
// overlay への反映（applyFn）は最新要求のときだけ呼ばれ、遅延解決した古い要求で
// 表示が巻き戻らない。AC #4: GeoJsonLayer の data 差し替えのみ・overlay は再生成しない。
// TASK-19: base と HRE 領邦オーバーレイは複合ローダで両方揃ってから同時に反映する。
// hre-powers を後置して powers の上に描画する（非対象年は空 FC で実質非表示）。
const yearSwitcher = createYearSwitcher(
  dataLoader,
  (year, data) => {
    // TASK-90: 年代が変われば同じ勢力が同じ形で存在するとは限らないため、
    // ポリゴンの強調（選択・ホバー）は年代切替で解除する。ここでの再構築は
    // 抑止し、直後の renderLayers()（年代フェード付き）へまとめる。
    suppressPowerHighlightRender = true;
    powerHighlight.clear();
    suppressPowerHighlightRender = false;
    // TASK-24: レイヤー組み立ては renderLayers に集約（河川選択の変更と共用）
    currentView = {
      year,
      base: data.base,
      hre: data.hre,
      fiefs: data.fiefs,
      outlines: data.outlines,
      baseFill: data.baseFill,
      italyFiefs: data.italyFiefs,
      cliopatriaFiefs: data.cliopatriaFiefs,
      britainFiefs: data.britainFiefs,
      sovereignFiefs: data.sovereignFiefs,
      hreRealm: data.hreRealm,
    };
    // #345 / #350 AC7: 年代が変われば同じ中央座標でも属する上位勢力が変わる。
    // base 差し替え直後・renderLayers の**前**に解決し直すことで、直後の描画が
    // 新年代の focus で行われる（変化通知は使わない。直後の renderLayers()
    // に 1 本化するため）。
    detailFocus.refresh();
    renderLayers();
    // AC #2/#3: 実際に反映された年で UI を確定させる（最新要求のみ到達する）
    timelineUi.reflectYear(year);
    // AC #1: 年代確定のたびに URL を現在の視点込みで同期する
    syncUrlToState();
  },
);

// AC #1: 表示状態を URL クエリへ replaceState で反映する（履歴を汚さない）。
// 同一クエリの重複更新は updater 側で抑止するため、moveend など高頻度でも安全。
const updateUrl = createReplaceStateUpdater((query) => {
  globalThis.history.replaceState(null, "", query);
});

/** 確定年代 + 現在の地図視点から表示状態を組み立てる */
function currentAppState(): AppState {
  const c = map.getCenter();
  return {
    year: yearSwitcher.currentYear() ?? initialYear,
    zoom: map.getZoom(),
    center: [c.lng, c.lat],
  };
}

/** 現在の表示状態を URL クエリへ同期する（変化がなければ何もしない） */
function syncUrlToState(): void {
  updateUrl(currentAppState());
}

// AC #1: パン/ズーム確定（moveend）ごとに URL を更新。move 中の高頻度発火は拾わない。
map.on("moveend", syncUrlToState);

// TASK-66 AC #2: ズーム操作に追従して都市のズーム別表示を更新する。
// zoom イベントはズームアニメーション中に高頻度で発火するため、整数ズーム段
// （zoomStep）が変わった時だけ renderLayers() を呼ぶ（毎フレームの
// レイヤー再構築を避ける）。zoomend ではなく zoom を使うのは、ピンチ/ホイール
// の途中でも段を跨いだ時点で即座に都市が増減し、操作へ滑らかに追従するため。
map.on("zoom", () => {
  const step = Math.floor(map.getZoom());
  if (step === zoomStep) return;
  zoomStep = step;
  // #267 AC11: 整数段の切替でカーソル追従ツールチップを隠す。ホイールズームは
  // mousemove を伴わないため、z5→z4 でホバー中の領邦レイヤーが不可視に
  // なっても onHover が再発火せず、非表示の下位勢力を指す古いツールチップが
  // 残る。段の切替時に消しておけば、次の mousemove で現在の表示レベルの
  // picking 結果から正しく再表示される（強調・外枠の状態は入力に追従して
  // 更新される既存経路のまま触らない）。
  infoUi.hideTooltip();
  renderLayers();
});

// ---- ローディング/エラー UI（TASK-9, docs/app-spec.md §5.4）----

// ロード状態機械（DOM 非依存ロジックは loading_state.ts に集約）。
// switchYear が開始/成功/失敗を通知し、setupLoadingUI が返す描画ハンドルへ反映する。
let loadingState = createLoadingState();

/** ロード状態を更新し、最新状態を UI へ反映する */
function updateLoadingState(next: LoadingState): void {
  loadingState = next;
  loadingUi.render(loadingState);
}

/**
 * 表示年代を切り替える（TASK-6 のスライダー・目視確認から呼ばれる公開 API）。
 * 連続呼び出し時は最後に要求した年代だけが反映される。
 *
 * TASK-9: ロードの開始/成功/失敗を loading_state へ通知してスピナー・トーストを制御する。
 * - キャッシュ済み年代は fetch が発生しないためスピナーを出さない（開始を通知しない）。
 * - 失敗しても reject を握りつぶし（トーストで再試行に誘導するため）、
 *   `void switchYear(...)` 呼び出し側で未処理 rejection を出さない。
 */
export function switchYear(year: number): Promise<void> {
  const cached = dataLoader.has(year);
  if (!cached) updateLoadingState(startLoading(loadingState, year));
  return yearSwitcher.switchTo(year).then(
    () => {
      if (!cached) updateLoadingState(succeedLoading(loadingState, year));
    },
    (error: unknown) => {
      updateLoadingState(failLoading(loadingState, year));
      console.error(
        `年代 ${year} の GeoJSON 取得に失敗しました: ${String(error)}`,
      );
    },
  );
}

// スピナー / エラートースト（app-spec §5.4）の DOM 配線は src/ui/loading.ts へ
// 抽出した（TASK-146）。状態機械（loadingState）の所有と遷移はここに残し、
// 再試行 / 閉じるの動作をコールバックで注入する（switchYear への循環 import 回避）。
const loadingUi = setupLoadingUI({
  doc: document,
  initialState: loadingState,
  // AC #3: 失敗した年代を再取得する。成功すれば hasError が false になり
  // トーストが消える。
  //
  // #319: deck.gl チャンクのロード失敗だけは同一文書で復帰できない（失敗した
  // 動的 import は module map に記録され再フェッチされない。#311 の調査で実測）。
  // 復帰手段は新しい文書を作ることだけなので、この場合は年代の再取得ではなく
  // ページの再読み込みを行う（ボタン文言も「再読み込み」になる）。ユーザーの
  // 明示操作が起点なので、自動リトライのように恒久的な失敗で走り続けることはない。
  onRetry: () => {
    if (hasChunkError(loadingState)) {
      globalThis.location.reload();
      return;
    }
    for (const year of failedYears(loadingState)) {
      void switchYear(year);
    }
  },
  // ユーザーが明示的に閉じたら失敗集合をクリアする（再試行はしない）
  onClose: () => {
    updateLoadingState(clearErrors(loadingState));
  },
});

/**
 * #319: deck.gl チャンク（#247 で分割した src/deck_app.ts）のロード失敗を
 * ユーザーへ告知する。従来は console.error だけで縮退継続していたため、
 * ユーザーには「オーバーレイの無い地図」と「データの無い地図」の区別が
 * つかなかった。ここで loading_state へ載せることで、既存のエラートースト機構
 * （src/ui/loading.ts）が再読み込みを促す表示を出す。
 *
 * 配線は loadingUi の初期化より後（トーストへ render できる状態）で、
 * deckAppPromise の他の consumer（map load / デバッグフック設置）とは独立に
 * 行う。どちらの consumer が先に失敗を観測しても告知は 1 度きりになる
 * （failChunkLoad は冪等）。
 */
void watchDeckChunkLoad({
  load: () => deckAppPromise,
  onFailure: () => {
    updateLoadingState(failChunkLoad(loadingState));
  },
});

// タイムラインスライダー（app-spec §5.1）の DOM 配線は src/ui/timeline.ts へ
// 抽出した（TASK-146）。年代切替の実体（switchYear。キャッシュ + 最新要求
// ガード）はコールバックで注入する（循環 import 回避）。
const timelineUi = setupTimeline({
  doc: document,
  years: SNAPSHOT_YEARS,
  initialYear,
  onRequestYear: (year) => void switchYear(year),
});

/** 初期年代の勢力圏を描画する。例外で地図全体を落とさない */
async function initPowerLayer(): Promise<void> {
  try {
    // TASK-23: name-ja.json のロード完了を待ってから初期描画するため、初期
    // ラベル・ツールチップは最初から日本語で表示される（失敗時のみ英語継続）。
    // TASK-24: rivers.geojson も初期描画前に揃え、初回から河川を重ねる。
    // TASK-27: cities.json も同様に揃え、初回から都市マーカーを重ねる。
    // TASK-145: ローダ本体は src/data_loading.ts（返り値型 + fetch 注入）へ
    // 抽出した。モジュール変数への代入（状態の所有）と成功時フックの発火は
    // decision-29 の方針どおりここに残す。
    // #246: データ URL の解決は fetchAsset（manifest 経由）に集約されている。
    // manifest のロードは最初の fetch が 1 回だけ開始する（assetManifestPromise）。
    // #249: 取得はモジュール評価時に開始済み（startupData）。ここでは開始済み
    // Promise の完了を待ち合わせるだけで、上記の「初期描画前に揃っている」
    // 不変条件（TASK-23/24/27/46/78）は従来どおり維持される。
    const [
      loadedColors,
      loadedOverrides,
      loadedNameJa,
      loadedRivers,
      // TASK-97: mountains.geojson も初期描画前に揃え、初回から山脈名を重ねる
      loadedMountains,
      loadedMarine,
      // TASK-99: peaks.geojson も同様に揃え、初回から山峰マーカーを重ねる
      loadedPeaks,
      loadedCities,
      // #283: 年代別の勢力説明。初期描画前に揃える必要はない（クリック時に
      // 初めて読む）が、他の静的データと同じ 1 回の待ち合わせに含めておく
      loadedPowerDescriptions,
      // TASK-78: 初期年（1000）が諸侯領オーバーレイ対象年なので、初期描画前に
      // 被覆率表を揃えて 1 フレーム目から二重ラベルを出さないようにする
      loadedFiefDedupe,
    ] = await Promise.all([
      startupData.colors,
      startupData.overrides,
      startupData.nameJa,
      startupData.rivers,
      startupData.mountains,
      startupData.marine,
      startupData.peaks,
      startupData.cities,
      startupData.powerDescriptions,
      startupData.fiefDedupe,
    ]);
    colors = loadedColors;
    overrides = loadedOverrides;
    nameJa = loadedNameJa;
    riversData = loadedRivers;
    mountainsData = loadedMountains;
    marineData = loadedMarine;
    peaksData = loadedPeaks;
    citiesData = loadedCities;
    powerDescriptions = loadedPowerDescriptions;
    fiefDedupe = loadedFiefDedupe;
    // #249 AC2: この switchYear がモジュール評価時に前倒し開始した初期年代
    // geojson（withPrimedYear）の結果を消費する。取得は静的データと並行に
    // 進んでいるため、ここでの待ちは通常すでに解決済みか残りわずか。
    await switchYear(initialYear);
  } catch (error) {
    console.error(`勢力圏レイヤーの初期化に失敗しました: ${String(error)}`);
  }
}

/**
 * DEM ソースと hillshade レイヤーの遅延追加（#248）。
 *
 * 起動時のスタイルは常に hillshade 無効（DEM ソースなし）で構築してあるため、
 * europe-dem.pmtiles は初期ロードの critical path に乗らない。map load 後に
 * この関数が DEM PMTiles アーカイブの登録・ヘッダ取得と、DEM ソース +
 * hillshade レイヤーの追加（定義・挿入位置は起動時から有効だった場合と同一。
 * addDeferredHillshade が保証）を行う。
 *
 * 追加しない条件:
 * - hillshadeEnabled = false（モバイル小画面。TASK-133 の挙動を維持し、
 *   DEM へのリクエストは一切発生しない）
 * - OpenFreeMap へフォールバック済み（fallenBack）。従来もフォールバックの
 *   setStyle で hillshade は消えていたため、フォールバックスタイルへ
 *   hillshade を重ねる新挙動を作らない。
 *
 * TASK-34: DEM アーカイブは任意生成のため存在しない環境もある。ヘッダ取得の
 * 失敗は握りつぶして hillshade なしの従来表示で継続する（dem ソースの
 * タイル取得エラーは fallback.ts の判定が sourceId で除外するため、
 * OpenFreeMap へのフォールバックも誤発動しない）。
 */
function insertHillshadeAfterLoad(): void {
  if (!hillshadeEnabled || fallbackState.fallenBack) return;
  const demArchive = new PMTiles(demPmtilesUrl);
  protocol.add(demArchive);
  demArchive.getHeader().catch((error: unknown) => {
    console.warn(
      `DEM PMTiles が利用できないため hillshade なしで継続します: ${
        String(error)
      }`,
    );
  });
  addDeferredHillshade(
    {
      getSource: (id) => map.getSource(id),
      getLayersOrder: () => map.getLayersOrder(),
      addSource: (id, source) => map.addSource(id, source),
      addLayer: (layer, beforeId) =>
        map.addLayer(layer as Parameters<typeof map.addLayer>[0], beforeId),
    },
    demPmtilesUrl,
  );
}

// スタイル読み込み完了後に overlay を統合し、初期年代を描画する。
// #247: deck.gl は後続チャンク（deckAppPromise）にあるため、統合前にロード
// 完了を待つ。チャンクの取得は初期チャンク評価と同時（deckAppModulePromise）に
// 始まっているので、ここでの await は通常すでに解決済みか残りわずかで、
// PMTiles・スタイルの取得とは最初から並行している。ロード失敗（オフライン等）は
// ベースマップ表示だけで継続する（オーバーレイなし）。
map.on("load", () => {
  void (async () => {
    let app: DeckApp;
    try {
      app = await deckAppPromise;
    } catch (error) {
      console.error(
        `deck.gl チャンクのロードに失敗しました（オーバーレイなしで継続）: ${
          String(error)
        }`,
      );
      // #319: ユーザー向けの告知（再読み込みを促すトースト）は
      // watchDeckChunkLoad 側で行う（ここは縮退の継続だけを担う）。
      // #248: オーバーレイなしの縮退でも、ベースマップの hillshade は従来
      // どおり表示する
      insertHillshadeAfterLoad();
      return;
    }
    map.addControl(app.overlay);
    // TASK-77: ラベル専用の overlaid オーバーレイ。interleaved の overlay より
    // 後に追加し、地図 canvas の上（= 全レイヤーの最前面）にラベルを重ねる。
    map.addControl(app.labelOverlay);
    // #248: hillshade の遅延追加は initPowerLayer の完了（= 起動データ取得と
    // 初期年代の政治レイヤー描画）より後に置き、DEM のヘッダ・タイル取得が
    // 初回描画より先行して critical path に戻らないようにする。実測では
    // load ハンドラ内で同期的に追加すると、DEM 取得が manifest 解決待ちの
    // 起動データ取得より先に始まってしまう（initPowerLayer は内部で例外を
    // 握りつぶすため、この then は失敗時も含め必ず実行される）。
    // #249: 起動データ（静的 9 件）と初期年代 geojson の fetch はモジュール
    // 評価時に開始済み（startupData / withPrimedYear）。initPowerLayer は
    // ここでは開始済み Promise の待ち合わせと状態反映・描画だけを行うため、
    // map の load イベントがデータ取得開始のゲートになることはない。
    void initPowerLayer().then(() => insertHillshadeAfterLoad());
  })();
});

// TASK-144: ヘッドレス CDP 検証用のデバッグフック群（__setYear / __get*Debug /
// __probePick の 18 件）は src/debug_hooks.ts へ抽出した。フック名と返り値の
// 形は scripts/verify/ のヘッドレス検証の契約なので変えない。状態の所有は
// main.ts に残し（decision-29）、ここでは getter・関数を注入する配線だけを行う。
// メモ化関数を注入するのは builder と同一キャッシュを共有するため（フックの
// 呼び出しが polylabel 再計算やフォントアトラス再生成を誘発しない。TASK-50/136）。
// #247: メモ化関数と overlay は後続チャンク（deckApp）が所有するため、
// インストールは deckAppPromise の解決後に行う。ヘッドレス検証はフックの出現を
// waitFor でポーリングする契約（scripts/verify/cdp.ts）なので、出現が deck
// チャンクのロード完了後になっても検証は従来どおり通る。
deckAppPromise.then((app) => {
  installDebugHooks({
    switchYear,
    currentYear: () => yearSwitcher.currentYear() ?? INITIAL_YEAR,
    getZoomStep: () => zoomStep,
    getCurrentView: () => currentView,
    getNameJa: () => nameJa,
    getOverrides: () => overrides,
    getFiefDedupe: () => fiefDedupe,
    getCitiesData: () => citiesData,
    getMountainsData: () => mountainsData,
    getPeaksData: () => peaksData,
    getRiversData: () => riversData,
    // TASK-150: 概略境界の描画データは approximate_border_sync.ts の closure が
    // 所有する。読み取り用 getter を渡し、フックが常に現在値を読めるようにする。
    getApproximateBorderData: approximateBorderSync.data,
    // TASK-149: 選択/ホバー状態は pick_handlers.ts の closure が所有する。
    // getter をそのまま渡し、フックが常に現在値を読めるようにする。
    getHoveredRiverName: pickHandlers.hoveredRiverName,
    getSelectedRiverName: pickHandlers.selectedRiverName,
    getExtentKey: pickHandlers.extentKey,
    powerHighlight,
    // #345: 地図中央の詳細表示 focus は suzerain_extent.ts の closure が所有
    // する。ハンドルをそのまま渡し、フックが常に現在値を読めるようにする。
    detailFocus,
    // #350: 描画・picking へ実際に配っている focus（ズームゲート・海上の縮退
    // 適用後）と、その分類に使う分類器。builder と同一のインスタンスを渡す
    // ことで、フックが「実際に描かれているもの」を再計算なしで報告する。
    getDetailFocusKey: activeDetailFocusKey,
    memoizedSuzerainClassifier: app.politicalLayers.memoizedSuzerainClassifier,
    project: (lngLat) => map.project(lngLat),
    getStyleSource: (id) => map.getSource(id),
    currentStyleLayerIds,
    pickObject: (opts) => app.overlay.pickObject(opts),
    // TASK-149: picking 解決は pick_handlers.ts のファクトリが所有する。
    // __probePick が本番のクリック経路（resolveClickInfo）と同じ関数を通る。
    resolveClickInfo: pickHandlers.resolveClickInfo,
    pickedLabel: pickHandlers.pickedLabel,
    collectionMetadata,
    // TASK-147: 地物系のメモ化は feature_layers.ts のファクトリが所有する。
    // builder と同一インスタンスを渡し、キャッシュ共有（TASK-50/136）を保つ。
    memoizedMountainLabelData: app.featureLayers.memoizedMountainLabelData,
    memoizedPeakEntries: app.featureLayers.memoizedPeakEntries,
    memoizedVisiblePeaks: app.featureLayers.memoizedVisiblePeaks,
    memoizedPeakLabelData: app.featureLayers.memoizedPeakLabelData,
    // TASK-148: 政治レイヤーのメモ化は political_layers.ts のファクトリが
    // 所有する。builder と同一インスタンスを渡し、キャッシュ共有
    // （TASK-50/136）を保つ。
    memoizedPowerLabelData: app.politicalLayers.memoizedPowerLabelData,
    memoizedVisiblePowerLabels: app.politicalLayers.memoizedVisiblePowerLabels,
    memoizedCityAvoidPoints: app.featureLayers.memoizedCityAvoidPoints,
    memoizedRiverLabelData: app.featureLayers.memoizedRiverLabelData,
    memoizedVisibleCityEntries: app.featureLayers.memoizedVisibleCityEntries,
  });
}).catch((error: unknown) => {
  // ロード失敗時のログと縮退（オーバーレイなし継続）は map load 側で行う。
  // ここではフック未設置に留める（検証ハーネス側がタイムアウトで検出する）。
  console.warn(
    `デバッグフックを設置できませんでした（deck.gl チャンク未ロード）: ${
      String(error)
    }`,
  );
});
