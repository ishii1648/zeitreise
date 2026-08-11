import maplibregl from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
import { PMTiles, Protocol } from "pmtiles";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Layer } from "@deck.gl/core";
import type { Feature, FeatureCollection } from "geojson";
import { buildBasemapStyle, shouldEnableHillshade } from "./basemap.ts";
import {
  type AssetManifest,
  loadAssetManifest,
  resolveAssetUrl,
} from "./asset_manifest.ts";
import { overlaySplitIsValid, waterStackIsValid } from "./layer_stack.ts";
import { createApproximateBorderSync } from "./approximate_border_sync.ts";
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
  createItalyFiefOverlayLoader,
  createSovereignFiefOverlayLoader,
  createYearDataLoader,
  createYearSwitcher,
  EMPTY_FEATURE_COLLECTION,
  LINE_COLOR,
  LINE_WIDTH_PX,
  powerFillDataForMode,
  withBorrowedGeometry,
  type YearDataLoader,
} from "./powers.ts";
import {
  EMPTY_FIEF_DEDUPE_TABLE,
  type FiefDedupeTable,
} from "./fief_dedupe.ts";
import {
  loadCities,
  loadColors,
  loadFiefDedupe,
  loadKnownLimitations,
  loadMountains,
  loadNameJa,
  loadNotes,
  loadOverrides,
  loadPeaks,
  loadRivers,
} from "./data_loading.ts";
import { isHreSuzerainFeature, politicalDetailVisibleAt } from "./labels.ts";
import {
  EMPTY_SUZERAIN_OVERRIDES,
  type SuzerainOverrides,
  withSuzerainOverrides,
} from "./suzerain_extent.ts";
import type { CitiesData } from "./cities.ts";
import {
  clearErrors,
  createLoadingState,
  failedYears,
  failLoading,
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
import type { NotesData } from "./notes.ts";
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
  PEAK_LAYER_ID,
  PICKING_PRIORITY,
  PICKING_RADIUS_PX,
  POWER_LAYER_ID,
  renderOrderFromPickingPriority,
  RIVERS_HIT_LAYER_ID,
  RIVERS_LAYER_ID,
  SOVEREIGN_FIEF_LAYER_ID,
} from "./picking.ts";
import {
  createPowerHighlightStore,
  HIGHLIGHT_FILL_TRANSITION_MS,
  YEAR_FILL_TRANSITION_MS,
} from "./power_highlight.ts";
import { collectionMetadata, createPickHandlers } from "./pick_handlers.ts";
import { installDebugHooks } from "./debug_hooks.ts";
import {
  createFeatureLayerBuilders,
  type FeatureLayerContext,
} from "./feature_layers.ts";
import {
  createPoliticalLayerBuilders,
  FIEF_LINE_COLOR,
  FIEF_LINE_WIDTH_PX,
  type PoliticalLayerContext,
} from "./political_layers.ts";
import { setupInfoUI } from "./ui/info_panel.ts";
import { setupFooter } from "./ui/footer.ts";
import { setupKnownLimitationsUI } from "./ui/known_limitations.ts";
import { setupNotesUI } from "./ui/notes.ts";
import { setupLoadingUI } from "./ui/loading.ts";
import { setupTimeline } from "./ui/timeline.ts";

const mapContainer = document.getElementById("map");
if (!mapContainer) {
  throw new Error("#map 要素が見つかりません");
}

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

// TASK-34: 地形 DEM（hillshade 用）の PMTiles アーカイブも登録する。
// DEM は任意生成のため存在しない環境があり、その場合ヘッダ取得が失敗するが、
// 握りつぶして hillshade なしの従来表示で継続する（basemap と違いフォール
// バックはしない。dem ソースのタイル取得エラーも fallback.ts の判定が
// sourceId で除外する）。
// TASK-133: hillshade 無効時はアーカイブ登録・ヘッダ取得ごと行わない。
// スタイル側にも DEM ソースが無い（buildBasemapStyle）ため、DEM PMTiles への
// リクエストは一切発生しない（AC #5）。
if (hillshadeEnabled) {
  const demArchive = new PMTiles(demPmtilesUrl);
  protocol.add(demArchive);
  demArchive.getHeader().catch((error: unknown) => {
    console.warn(
      `DEM PMTiles が利用できないため hillshade なしで継続します: ${
        String(error)
      }`,
    );
  });
}

const map = new maplibregl.Map({
  container: mapContainer,
  style: buildBasemapStyle(
    basemapPmtilesUrl,
    demPmtilesUrl,
    hillshadeEnabled,
  ) as StyleSpecification,
  center: initialState.center,
  zoom: initialState.zoom,
  minZoom: MIN_ZOOM,
  maxZoom: MAX_ZOOM,
  // TASK-22: パン・ズームアウトをヨーロッパ域内に制限する（圏外へは出られない）
  maxBounds: MAP_MAX_BOUNDS,
});

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
const withOverrides = (loader: YearDataLoader) =>
  withSuzerainOverrides(loader, () => overrides);

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

const dataLoader = createCombinedYearLoader(
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
);

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

/**
 * 主要山峰 GeoJSON（TASK-99。山脈と同じく年代非依存なので起動時に 1 度ロード）。
 * 失敗・未生成時は空のまま山峰なしで継続する（河川・山脈と同じ縮退方針）。
 */
let peaksData: FeatureCollection = EMPTY_FEATURE_COLLECTION;

/**
 * 主要都市データ（TASK-27。起動時に 1 度ロード）。
 * 取得失敗・未生成時は空のまま都市なしで継続する（colors.json 等と同様）。
 */
let citiesData: CitiesData = { years: {} };

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

/** 直近に反映された年代のデータ。選択変更時のレイヤー再構築で使う */
let currentView:
  | {
    year: number;
    base: FeatureCollection;
    hre: FeatureCollection;
    fiefs: FeatureCollection;
    /** TASK-78: 諸侯領の内側を除いた base 輪郭（空なら powers の stroke で描く） */
    outlines: FeatureCollection;
    /**
     * TASK-92: 諸侯領 union を差し引いた派生 base（空なら base をそのまま塗る）。
     * 使うのは powers レイヤーの塗りだけで、ラベル・帝国範囲強調・picking の
     * 入力は base のまま。
     */
    baseFill: FeatureCollection;
    /** TASK-96: 中世イタリア諸侯領（非対象年・取得失敗時は空 FC） */
    italyFiefs: FeatureCollection;
    /**
     * TASK-110: Cliopatria 由来の領邦（非対象年・取得失敗・未生成時は空 FC）
     */
    cliopatriaFiefs: FeatureCollection;
    /**
     * #172: ブリテン諸島の政体（非対象年・取得失敗・未生成時は空 FC）
     */
    britainFiefs: FeatureCollection;
    /**
     * #189: 主権政体オーバーレイ（非対象年・取得失敗・未生成時は空 FC）
     */
    sovereignFiefs: FeatureCollection;
  }
  | null = null;

// ---- picking イベント処理（TASK-149: src/pick_handlers.ts へ抽出）----

// picking 結果の解決（pickedLabel / pickedMetadata / resolveClickInfo）と
// Deck レベルのホバー/クリック処理（handlePickHover / handlePickClick）、
// および選択/ホバー状態 7 変数の所有は createPickHandlers に閉じ込めた。
// main.ts 所有のデータストア・currentView は getter で、表示先（infoUi）・
// 再構築（renderLayers）・強調ストア（powerHighlight）・近傍再ピック
// （overlay.pickMultipleObjects）はコールバックで注入する。infoUi と overlay は
// この時点では未初期化だが、closure が呼ばれるのは map load 後の picking
// イベント発生時なので安全に遅延参照できる。
const pickHandlers = createPickHandlers({
  getNameJa: () => nameJa,
  getOverrides: () => overrides,
  getCurrentView: () => currentView,
  // #228: powers の picking 出典解決が表示モード（politicalDetailVisibleAt）を
  // 塗りと共有するための現在ズーム段
  getZoomStep: () => zoomStep,
  getRiversData: () => riversData,
  getMountainsData: () => mountainsData,
  getPeaksData: () => peaksData,
  getCitiesData: () => citiesData,
  showTooltip: (label, x, y) => infoUi.showTooltip(label, x, y),
  hideTooltip: () => infoUi.hideTooltip(),
  showInfoPanel: (label, sources) => infoUi.showInfoPanel(label, sources),
  requestRender: () => renderLayers(),
  powerHighlight,
  pickMultipleObjects: (opts) => overlay.pickMultipleObjects(opts),
});

// AC #1: MapboxOverlay（interleaved）で deck.gl を MapLibre に統合する。
// overlay と GeoJsonLayer はここで 1 度だけ生成し、年代切替では data を差し替えるのみ。
//
// TASK-24: ホバー/クリックは per-layer コールバックではなく Deck レベルの
// onHover/onClick に集約する。deck.gl は「前回ホバーしていたレイヤーの leave」
// と「新しくホバーしたレイヤーの enter」を別々の per-layer コールバックで
// 呼ぶため、rivers（上）と powers（下）へ分けて書くとツールチップの
// 表示/非表示が発火順に依存してしまう。Deck レベルの onHover/onClick は
// 最前面の picking 結果 1 件（何も無ければ layer: null）で 1 回だけ呼ばれる
// （@deck.gl/core deck.js の _applyHoverCallbacks / _dispatchPickingEvent で
// 確認）ので、順序レースなしに河川と勢力の表示を出し分けられる。
// pickingRadius で細い河川ラインもクリック/ホバーしやすくする。
//
// TASK-36: 上記の pickingRadius は「カーソル直下に何も無い場合」の近傍探索
// にしか効かない。本アプリは全面を powers（GeoJsonLayer）が覆うため、河川
// ライン（描画幅 2px）の外側では常に距離 0 の powers が picking に勝ち、
// カーソルが河川の中心線から数 px ずれるだけで河川を拾えなくなる（実測:
// |d|≤2px 命中 / |d|≥4px ミス）。これを解消するため、クリック時のみ
// handlePickClick 内で overlay.pickMultipleObjects により半径内の複数候補を
// 取得し、picking.ts の resolveClickPick（PICKING_PRIORITY 準拠）で選び直す。
// ホバー（handlePickHover）の picking 方式自体は変更しない: pickMultipleObjects
// は mousemove 毎に呼ぶには高コストなため、ホバーは従来どおり Deck onHover の
// 単一結果に委ねる（河川優先の picking 補正はクリックに限定する設計判断）。
// TASK-42: 単一結果が rivers であればその河川名を hoveredRiverName とし、
// 中間強調（riverLineColor/riverLineWidth の hovered 引数）に反映する。
//
// TASK-82: 上の「ホバーは直下 pick のみ」という設計は維持したまま、都市の
// ホバー判定範囲だけを cities-hit（透明・半径 CITY_HIT_RADIUS_PX の
// ScatterplotLayer）で広げる。ホバー経路に pickMultipleObjects を足さずに
// 判定範囲を広げられるため TASK-36 のコスト設計と両立し、クリック側の実効
// 範囲（cities.ts CITY_PICK_TOLERANCE_PX）とも一致する。
const overlay = new MapboxOverlay({
  interleaved: true,
  layers: [],
  pickingRadius: PICKING_RADIUS_PX,
  onHover: pickHandlers.handlePickHover,
  onClick: pickHandlers.handlePickClick,
});

/**
 * ラベル専用のオーバーレイ（TASK-77）。地図 canvas の上に重ねる deck 専用
 * canvas（overlaid モード）で、コンテナは pointer-events: none のため地図の
 * ドラッグ・ズーム操作を妨げない。
 *
 * interleaved にしない理由: 勢力ポリゴンを水面より下へ回す beforeId により
 * interleaved のレイヤーグループが 2 つに分かれると、先に描画されるグループの
 * パスが CollisionFilterExtension の衝突マップをラベル抜きで描き直し、ラベルが
 * 全滅する（詳細と検証結果は layer_stack.ts の OVERLAID_LAYER_IDS）。
 *
 * picking・イベント処理はこのオーバーレイに一切持たせない（ラベル 3 層は
 * pickable: false で PICKING_PRIORITY にも含まれないため、ホバー/クリックの
 * 挙動は overlay 側だけで従来どおり完結する）。
 */
const labelOverlay = new MapboxOverlay({
  interleaved: false,
  layers: [],
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

// ---- 地物レイヤー builder 群（TASK-147: src/feature_layers.ts へ抽出）----

// 河川（表示/ヒット/ラベル）・山脈（ラベル/ヒット/強調輪郭）・山峰（マーカー/
// ヒット/ラベル）・都市（マーカー/ヒット/ラベル）の 12 builder と、その
// メモ化・ラベル共通 base props（labelLayerBaseProps）は src/feature_layers.ts
// へ移した。ファクトリは起動時に 1 度だけ呼び、メモ化キャッシュ（TASK-50/136 の
// 参照同値契約の実体）を builder とデバッグフック（installDebugHooks への注入）で
// 共有する。状態の所有は従来どおり main.ts に残し（decision-29）、builder へは
// renderLayers が featureLayerContext で現在値のスナップショットを渡す。
const featureLayers = createFeatureLayerBuilders();

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

// ---- 政治レイヤー builder 群（TASK-148: src/political_layers.ts へ抽出）----

// 政治ポリゴン（buildPowerLayer）・勢力圏の外枠（buildSuzerainExtentLayer）・
// 勢力名ラベル（buildLabelLayer）の 3 builder と、そのメモ化・見た目定数
// （HRE_EXTENT_* / FIEF_LINE_*）・外枠 union キャッシュ（suzerain_extent.ts）は
// src/political_layers.ts へ移した。ファクトリは起動時に 1 度だけ呼び、メモ化
// キャッシュ（TASK-50/136 の参照同値契約の実体）を builder とデバッグフック
// （installDebugHooks への注入）で共有する。状態の所有（powerHighlight ストア・
// fillTransitionMs の一時差し替え・extentKey）は従来どおり main.ts に残し
// （decision-29）、builder へは renderLayers が politicalLayerContext で
// 現在値のスナップショットを渡す。
const politicalLayers = createPoliticalLayerBuilders();

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
  };
}

// 概略境界の同期本体（旧 syncApproximateBorders）・メモ化
// （memoizedApproximateBorderData）・再入ガードは src/approximate_border_sync.ts
// へ移した（TASK-150）。ファクトリ生成（approximateBorderSync）は styledata
// 購読の組み立てと同じ場所（上の map 配線部）で行う。

/**
 * 現在の年代データ + 河川 + 都市 + ラベルの全レイヤーを組み立てて overlay へ
 * 反映する。描画順（配列順 = 下から上）: powers → france-fiefs → hre-powers →
 * hre-extent → rivers-hit → cities-hit → cities → rivers → power-labels →
 * river-labels → city-labels。
 * TASK-71: france-fiefs は powers の直上（ベースの France ポリゴンの上）に置く。
 * 塗りは共通の FILL_ALPHA（半透明）なので下の勢力塗りが透け、諸侯領の欠落部
 * （南仏・パリ周辺など）はベースの France 塗りがそのまま見える。
 * rivers-hit（TASK-43）は rivers と同一データの透明太幅ヒットライン層で、
 * picking 専用に重ねる（見た目には影響しない）。cities の下に描画すること
 * （TASK-49）で、河畔都市マーカーの picking を rivers-hit が遮蔽しないように
 * する。cities-hit（TASK-82）は cities と同一データの透明・大半径ヒット層で、
 * cities の直下・rivers-hit の上に置く。可視ドット（cities）を上に保つことで
 * 密集地域でも「ドット直上は必ずその都市」が成立し、rivers-hit より上に置く
 * ことで河畔都市でも中心から CITY_PICK_TOLERANCE_PX 以内が都市になる。
 *
 * TASK-77: 上の描画順は deck レイヤー同士の相対順で、MapLibre スタイルとの
 * 前後関係は各レイヤーの beforeId で決まる。powers / france-fiefs / hre-powers
 * の 3 枚だけがベースマップの水面ポリゴンより下（buildPowerLayer で
 * underWaterBeforeId を付与）、残り（hre-extent・rivers-hit・cities-hit・
 * cities・rivers）は従来どおり水面より上に描かれる。beforeId は MapLibre 側の
 * 挿入位置のみを変え、
 * deck レイヤー配列の順序 = picking 優先順（PICKING_PRIORITY）には影響しない
 * （@deck.gl/mapbox は beforeId ごとにグループを作り、同一グループ内では配列順で
 * 描画する）。
 *
 * TASK-77: ラベル 3 層だけは overlaid の labelOverlay（別 canvas）へ分ける。
 * interleaved のグループ分割が CollisionFilterExtension の衝突マップを壊し
 * ラベルが全滅するため（理由と検証は layer_stack.ts の OVERLAID_LAYER_IDS）。
 * 分配の不変条件は overlaySplitIsValid で毎回検証する。ラベルは元々
 * pickable: false・最前面のため、見た目・picking・イベント処理は変わらない。
 *
 * TASK-29: pickable レイヤーの並びは picking.ts の PICKING_PRIORITY
 * （河川 > 都市 > 河川ヒット層 > HRE 領邦 > 勢力。先頭が最優先。TASK-49 で
 * cities を rivers-hit より優先に変更）から導出する。deck.gl の picking は
 * 最前面（配列の最後）が勝つため、描画順 = 優先順の逆順にすることで
 * 「河川と勢力が重なる位置では河川名を優先」（AC #2）と「都市ドット直上では
 * 都市を優先」（TASK-49）がレイヤー順だけで担保される。ラベル系
 * （pickable: false）は picking に関与しないためその上へ後置し、
 * layerOrderMatchesPickingPriority で全体の整合を検証する。年代切替と河川
 * 選択の変更はどちらもこの関数経由で反映し、レイヤー id を保つことで
 * deck.gl の差分更新に任せる。
 */
function renderLayers(): void {
  if (currentView === null) return;
  const { year, base, hre, fiefs, outlines, baseFill, italyFiefs } =
    currentView;
  const { cliopatriaFiefs, britainFiefs, sovereignFiefs } = currentView;
  // TASK-80: base の境界線は全年代とも MapLibre の概略境界レイヤー
  // （approximate-borders-*、syncApproximateBorders）が描くため、powers の
  // stroke は常に止める（TASK-78 は諸侯領オーバーレイ対象年だけ止めていた）。
  // 描画データの入力は「対象年 = 切り出し済みの base 輪郭（outlines）、
  // それ以外 = base ポリゴンの環」で、TASK-78 の二重輪郭解消は維持される。
  const ctx = featureLayerContext(year);
  const pctx = politicalLayerContext(year);
  // #228 AC1: 政治領域の表示モード。詳細（z5 以上）= 領邦オーバーレイを表示、
  // 概観（z4）= 上位勢力単位の連続した塗りだけを表示。塗りデータの選択・
  // 領邦レイヤーの visible・ラベルサイズ・picking の出典解決
  // （pick_handlers.ts）がすべてこの同じ判定（politicalDetailVisibleAt）を共有する。
  const politicalDetail = politicalDetailVisibleAt(zoomStep);
  const buildPickableLayer: Record<string, () => Layer> = {
    [POWER_LAYER_ID]: () =>
      politicalLayers.buildPowerLayer(
        pctx,
        POWER_LAYER_ID,
        // TASK-92: 諸侯領オーバーレイ対象年は諸侯領 union を差し引いた派生 base を
        // 塗る。諸侯領の下に base の半透明が重なって出る「境界線を伴わない濃淡」を
        // 消すのが目的で、非対象年・取得失敗時は base に縮退する。
        // #228 AC2: 概観（z4）では領邦オーバーレイを隠すため、差し引きの穴が
        // 透明に抜けないよう常に素の base を塗る（powerFillDataForMode）。
        powerFillDataForMode(base, baseFill, politicalDetail),
        LINE_COLOR,
        LINE_WIDTH_PX,
        false,
      ),
    // #228 AC2/AC6: 領邦・諸侯領オーバーレイ 6 枚は概観（z4）で visible: false。
    // layers 配列からは抜かず（PICKING_PRIORITY・順序検証・差分更新を保つ）、
    // deck.gl が描画・picking の両パスから外すため、z4 のホバー/クリックは
    // 下の powers（base）に落ちて上位勢力が返る。
    [HRE_LAYER_ID]: () =>
      politicalLayers.buildPowerLayer(
        pctx,
        HRE_LAYER_ID,
        hre,
        LINE_COLOR,
        LINE_WIDTH_PX,
        true,
        politicalDetail,
      ),
    // TASK-71: 中世フランス諸侯領。base の France ポリゴンの上に重ね、
    // 藍紫の境界線で区画を示す（非対象年は空 FC なので実質非表示）
    [FRANCE_FIEF_LAYER_ID]: () =>
      politicalLayers.buildPowerLayer(
        pctx,
        FRANCE_FIEF_LAYER_ID,
        fiefs,
        FIEF_LINE_COLOR,
        FIEF_LINE_WIDTH_PX,
        true,
        politicalDetail,
      ),
    // TASK-96: 中世イタリア諸侯領。仏諸侯領と同じ藍紫の境界線・同じ塗り規則で
    // 「諸侯領の区画」という記号を共有する（帝国系の臙脂とは色相で区別する）。
    // 非対象年は空 FC なので実質非表示。
    [ITALY_FIEF_LAYER_ID]: () =>
      politicalLayers.buildPowerLayer(
        pctx,
        ITALY_FIEF_LAYER_ID,
        italyFiefs,
        FIEF_LINE_COLOR,
        FIEF_LINE_WIDTH_PX,
        true,
        politicalDetail,
      ),
    // TASK-110: Cliopatria 由来の領邦。OHM に該当リレーションが無い領邦だけを
    // 収録した補完データで、既存 3 系統と同じ buildPowerLayer に載せる
    // （非対象年・未生成時は空 FC なので実質非表示）。境界線色だけは feature 単位で
    // 決める: このレイヤーは仏諸侯領と帝国領邦を同居させるため、レイヤー一律に
    // すると凡例（藍紫 = 諸侯領の区画 / 白 = 帝国領邦・base と同じ線）が破れる。
    [CLIOPATRIA_FIEF_LAYER_ID]: () =>
      politicalLayers.buildPowerLayer(
        pctx,
        CLIOPATRIA_FIEF_LAYER_ID,
        cliopatriaFiefs,
        (f: Feature) =>
          isHreSuzerainFeature(f.properties) ? LINE_COLOR : FIEF_LINE_COLOR,
        FIEF_LINE_WIDTH_PX,
        true,
        politicalDetail,
      ),
    // #172: ブリテン諸島の政体。base が一括りに塗るウェールズ・アイルランドの
    // 政体を、仏・伊諸侯領と同じ藍紫の境界線・同じ塗り規則で「オーバーレイ
    // 由来の区画」として重ねる。非対象年（1715 以降）は空 FC なので実質非表示。
    [BRITAIN_FIEF_LAYER_ID]: () =>
      politicalLayers.buildPowerLayer(
        pctx,
        BRITAIN_FIEF_LAYER_ID,
        britainFiefs,
        FIEF_LINE_COLOR,
        FIEF_LINE_WIDTH_PX,
        true,
        politicalDetail,
      ),
    // #189: 主権政体オーバーレイ。base の一枚岩塗りに隠れた主権政体を、
    // 既存の諸侯領と同じ藍紫の境界線・同じ塗り規則で「オーバーレイ由来の
    // 区画」として重ねる。非対象年は空 FC なので実質非表示。
    [SOVEREIGN_FIEF_LAYER_ID]: () =>
      politicalLayers.buildPowerLayer(
        pctx,
        SOVEREIGN_FIEF_LAYER_ID,
        sovereignFiefs,
        FIEF_LINE_COLOR,
        FIEF_LINE_WIDTH_PX,
        true,
        politicalDetail,
      ),
    [CITY_LAYER_ID]: () => featureLayers.buildCityMarkerLayer(ctx),
    [CITY_HIT_LAYER_ID]: () => featureLayers.buildCityHitLayer(ctx),
    [RIVERS_LAYER_ID]: () => featureLayers.buildRiversLineLayer(ctx),
    [RIVERS_HIT_LAYER_ID]: () => featureLayers.buildRiversHitLayer(ctx),
    // TASK-100: 山岳 3 層。いずれも年代に依存しない（AC #5）
    [PEAK_LAYER_ID]: () => featureLayers.buildPeakMarkerLayer(ctx),
    [PEAK_HIT_LAYER_ID]: () => featureLayers.buildPeakHitLayer(ctx),
    [MOUNTAIN_HIT_LAYER_ID]: () => featureLayers.buildMountainHitLayer(ctx),
  };
  const layers: Layer[] = [];
  // picking 優先順（PICKING_PRIORITY）の逆順 = 下→上の描画順で並べる
  for (const id of renderOrderFromPickingPriority(PICKING_PRIORITY)) {
    const build = buildPickableLayer[id];
    if (build === undefined) {
      throw new Error(`PICKING_PRIORITY のレイヤー ${id} に builder が無い`);
    }
    layers.push(build());
    // TASK-30 / TASK-94: 勢力圏の外枠は powers/hre-powers の上・cities の下に
    // 挿入する（領邦の塗りの上に輪郭が乗り、都市マーカー・河川は隠さない）。
    // pickable: false のため PICKING_PRIORITY 外の ID で、整合検証では
    // 無視される（layerOrderMatchesPickingPriority の既存仕様）。
    if (id === HRE_LAYER_ID) {
      layers.push(politicalLayers.buildSuzerainExtentLayer(pctx, base));
      // TASK-100: 山脈の強調輪郭は勢力圏の外枠と同じ層（政治ポリゴンの上・
      // 都市ドット/河川ラインの下）に置く。輪郭どうしが同じ階層に並ぶことで
      // 「臙脂の外縁 = 帝国範囲 / オリーブの外縁 = 山脈の範囲」が同じ土俵で
      // 読み比べられる。pickable: false のため PICKING_PRIORITY 外の ID で、
      // 整合検証では無視される（勢力圏の外枠と同じ扱い）。
      // 山峰マーカー（peaks）は TASK-100 で pickable になったため
      // PICKING_PRIORITY 由来のループ本体が積む（ここでは積まない）。
      layers.push(featureLayers.buildMountainOutlineLayer(ctx));
    }
  }
  // TASK-77: ラベル層は overlaid オーバーレイ（別 canvas）へ載せる。
  // 順序は描画順（山脈名 → 山峰名 → 勢力名 → 河川名 → 都市名）で、TASK-97 の
  // 山脈名・TASK-99 の山峰名は地形の注記なので最下段に置く（表示の取捨は
  // 配列順ではなく priority が決める）。
  const labelLayers: Layer[] = [
    featureLayers.buildMountainLabelLayer(ctx),
    featureLayers.buildPeakLabelLayer(ctx),
    politicalLayers.buildLabelLayer(
      pctx,
      base,
      hre,
      fiefs,
      italyFiefs,
      cliopatriaFiefs,
      britainFiefs,
      sovereignFiefs,
    ),
    featureLayers.buildRiverLabelLayer(ctx),
    featureLayers.buildCityLabelLayer(ctx),
  ];
  if (!layerOrderMatchesPickingPriority(layers.map((l) => l.id))) {
    throw new Error("レイヤー順が PICKING_PRIORITY と整合していない");
  }
  if (
    !overlaySplitIsValid(
      layers.map((l) => l.id),
      labelLayers.map((l) => l.id),
    )
  ) {
    throw new Error("interleaved / overlaid のレイヤー分配が不正");
  }
  // TASK-84: 政治ポリゴンの挿入位置（beforeId = 海洋 water）が「内水面より上・
  // 海洋と海岸線より下」であることを、実際のスタイル順に対して毎回確認する。
  // ベースマップ側のレイヤー順を変えて沿岸の線や塗りが壊れたらここで気付ける
  // （対象レイヤーを持たないフォールバックスタイルでは常に true）。
  if (!waterStackIsValid(currentStyleLayerIds())) {
    throw new Error("ベースマップの水面・海岸線の重ね順が不正");
  }
  overlay.setProps({ layers });
  labelOverlay.setProps({ layers: labelLayers });
  // TASK-80: base の境界線（概略境界）は MapLibre 側の line レイヤー。deck の
  // レイヤー反映後に同期することで、deck がグループを追加し直した場合でも
  // 概略境界が塗りの上に来る位置へ引き上げられる（メモ化 + 同期の実体は
  // approximate_border_sync.ts。TASK-150）。
  approximateBorderSync.apply(base, outlines);
}

// 勢力名ラベル builder（buildLabelLayer + memoizedPowerLabelData /
// memoizedVisiblePowerLabels）は src/political_layers.ts へ移した（TASK-148）。

// ホバー/クリック情報 UI（TASK-7/109/111）と attribution フッター（TASK-26）の
// DOM 配線は src/ui/ へ抽出した（TASK-146）。buildPowerLayer は年代切替のたびに
// 再生成されるため、レイヤー側は常にこのハンドルを参照し、DOM 配線は 1 度だけ行う。
const infoUi = setupInfoUI({
  doc: document,
  viewportSize: () => ({
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
  }),
});

setupFooter({ doc: document });

// ---- データの既知の制限一覧（TASK-46）----

// 一覧の描画・折りたたみ（wireCollapsiblePanel）・年代追従（TASK-52）の配線は
// src/ui/known_limitations.ts へ抽出した（TASK-146）。reveal は
// loadKnownLimitations 成功時に、reflectYear は年代切替の確定（applyFn。
// 最新要求のみ到達）から呼ぶ。
const knownLimitationsUi = setupKnownLimitationsUI({ doc: document });

// ---- 年代ごとの歴史解説パネル（TASK-33）----

/**
 * 解説データ（/data/notes.json）。取得失敗・未生成時は null のままで、
 * トグルボタンごと非表示にして従来表示を維持する（colors.json 等と同様）。
 */
let notesData: NotesData | null = null;

// 解説パネルの DOM 配線は src/ui/notes.ts へ抽出した（TASK-146）。notesData の
// 所有はここに残し getter で注入する。reflectYear は applyFn（最新要求のみ）
// から、revealToggle は loadNotes 成功時に呼ぶ。
const notesUi = setupNotesUI({ doc: document, getNotesData: () => notesData });

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
    };
    renderLayers();
    // AC #2/#3: 実際に反映された年で UI を確定させる（最新要求のみ到達する）
    timelineUi.reflectYear(year);
    // TASK-33 AC #1: 解説パネルも確定年に追従させる
    notesUi.reflectYear(year);
    // TASK-52: 既知の制限一覧も確定年に追従させ、該当項目の強調を更新する
    knownLimitationsUi.reflectYear(year);
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
  onRetry: () => {
    for (const year of failedYears(loadingState)) {
      void switchYear(year);
    }
  },
  // ユーザーが明示的に閉じたら失敗集合をクリアする（再試行はしない）
  onClose: () => {
    updateLoadingState(clearErrors(loadingState));
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
    // TASK-33: notes.json も初期描画前に揃え、初回の年確定（applyFn →
    // notesUi.reflectYear）の時点で解説を描画できるようにする。
    // TASK-46: known-limitations.json も同様に揃え、初回描画前にトグルを出す。
    // TASK-145: ローダ本体は src/data_loading.ts（返り値型 + fetch 注入）へ
    // 抽出した。モジュール変数への代入（状態の所有）と成功時フックの発火は
    // decision-29 の方針どおりここに残す。
    // #246: データ URL の解決は fetchAsset（manifest 経由）に集約されている。
    // manifest のロードは最初の fetch が 1 回だけ開始する（assetManifestPromise）。
    const [
      loadedColors,
      loadedOverrides,
      loadedNameJa,
      loadedRivers,
      // TASK-97: mountains.geojson も初期描画前に揃え、初回から山脈名を重ねる
      loadedMountains,
      // TASK-99: peaks.geojson も同様に揃え、初回から山峰マーカーを重ねる
      loadedPeaks,
      loadedCities,
      loadedNotes,
      loadedLimitations,
      // TASK-78: 初期年（1000）が諸侯領オーバーレイ対象年なので、初期描画前に
      // 被覆率表を揃えて 1 フレーム目から二重ラベルを出さないようにする
      loadedFiefDedupe,
    ] = await Promise.all([
      loadColors(fetchAsset),
      loadOverrides(fetchAsset),
      loadNameJa(fetchAsset),
      loadRivers(fetchAsset),
      loadMountains(fetchAsset),
      loadPeaks(fetchAsset),
      loadCities(fetchAsset),
      loadNotes(fetchAsset),
      loadKnownLimitations(fetchAsset),
      loadFiefDedupe(fetchAsset),
    ]);
    colors = loadedColors;
    overrides = loadedOverrides;
    nameJa = loadedNameJa;
    riversData = loadedRivers;
    mountainsData = loadedMountains;
    peaksData = loadedPeaks;
    citiesData = loadedCities;
    // notes は取得成功時（null でない）だけ反映し、トグルボタンを表示する
    if (loadedNotes !== null) {
      notesData = loadedNotes;
      notesUi.revealToggle();
    }
    // known-limitations は 1 件以上のときだけトグルを表示する（0 件 = 縮退）
    if (loadedLimitations.length > 0) {
      knownLimitationsUi.reveal(loadedLimitations);
    }
    fiefDedupe = loadedFiefDedupe;
    await switchYear(initialYear);
  } catch (error) {
    console.error(`勢力圏レイヤーの初期化に失敗しました: ${String(error)}`);
  }
}

// スタイル読み込み完了後に overlay を統合し、初期年代を描画する。
map.on("load", () => {
  map.addControl(overlay);
  // TASK-77: ラベル専用の overlaid オーバーレイ。interleaved の overlay より
  // 後に追加し、地図 canvas の上（= 全レイヤーの最前面）にラベルを重ねる。
  map.addControl(labelOverlay);
  void initPowerLayer();
});

// TASK-144: ヘッドレス CDP 検証用のデバッグフック群（__setYear / __get*Debug /
// __probePick の 17 件）は src/debug_hooks.ts へ抽出した。フック名と返り値の
// 形は scripts/verify/ のヘッドレス検証の契約なので変えない。状態の所有は
// main.ts に残し（decision-29）、ここでは getter・関数を注入する配線だけを行う。
// メモ化関数を注入するのは builder と同一キャッシュを共有するため（フックの
// 呼び出しが polylabel 再計算やフォントアトラス再生成を誘発しない。TASK-50/136）。
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
  project: (lngLat) => map.project(lngLat),
  getStyleSource: (id) => map.getSource(id),
  currentStyleLayerIds,
  pickObject: (opts) => overlay.pickObject(opts),
  // TASK-149: picking 解決は pick_handlers.ts のファクトリが所有する。
  // __probePick が本番のクリック経路（resolveClickInfo）と同じ関数を通る。
  resolveClickInfo: pickHandlers.resolveClickInfo,
  pickedLabel: pickHandlers.pickedLabel,
  collectionMetadata,
  // TASK-147: 地物系のメモ化は feature_layers.ts のファクトリが所有する。
  // builder と同一インスタンスを渡し、キャッシュ共有（TASK-50/136）を保つ。
  memoizedMountainLabelData: featureLayers.memoizedMountainLabelData,
  memoizedPeakEntries: featureLayers.memoizedPeakEntries,
  memoizedVisiblePeaks: featureLayers.memoizedVisiblePeaks,
  memoizedPeakLabelData: featureLayers.memoizedPeakLabelData,
  // TASK-148: 政治レイヤーのメモ化は political_layers.ts のファクトリが所有する。
  // builder と同一インスタンスを渡し、キャッシュ共有（TASK-50/136）を保つ。
  memoizedPowerLabelData: politicalLayers.memoizedPowerLabelData,
  memoizedVisiblePowerLabels: politicalLayers.memoizedVisiblePowerLabels,
  memoizedCityAvoidPoints: featureLayers.memoizedCityAvoidPoints,
  memoizedRiverLabelData: featureLayers.memoizedRiverLabelData,
  memoizedVisibleCityEntries: featureLayers.memoizedVisibleCityEntries,
});
