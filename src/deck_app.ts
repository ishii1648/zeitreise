/**
 * deck.gl オーバーレイ一式の組み立て（#247）。
 *
 * 初期ロードの critical path から deck.gl（@deck.gl/core / layers / mapbox /
 * extensions）を外すための動的 import 境界。main.ts は本モジュールを
 * `import("./deck_app.ts")` で遅延ロードし、ビルド（scripts/build.ts の
 * `deno bundle --code-splitting`）はここを境に後続チャンクを分割する。
 * 初期チャンクは MapLibre + ブート + manifest 解決に絞られ、PMTiles の取得が
 * deck.gl のダウンロード完了を待たずに始まる。
 *
 * このモジュールが deck.gl を **値 import** する全モジュール
 * （@deck.gl/mapbox・feature_layers.ts・political_layers.ts →
 * label_collision.ts）の唯一の静的な入口になる。main.ts 側は型 import
 * （erase される）だけを許し、値 import を足すと分割が無効になるので注意。
 *
 * decision-29 の方針どおり module-scope の可変状態は持たない。状態の所有は
 * 従来どおり main.ts に残り、ここへは deps の getter / コールバックで注入される
 * （renderLayers が読む currentView・zoomStep・context 組み立てなど）。
 */

import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Layer, PickingInfo } from "@deck.gl/core";
import type { Feature, FeatureCollection } from "geojson";
import {
  createFeatureLayerBuilders,
  type FeatureLayerContext,
} from "./feature_layers.ts";
import {
  createPoliticalLayerBuilders,
  FIEF_BORDER_INK,
  HRE_BORDER_INK,
  internalBorderLineColor,
  internalBorderLineWidth,
  type PoliticalLayerContext,
} from "./political_layers.ts";
import {
  LINE_COLOR,
  LINE_WIDTH_PX,
  powerFillDataForMode,
  type YearLayerData,
} from "./powers.ts";
import {
  isHreSuzerainFeature,
  politicalDetailVisibleAt,
  politicalDisplayLevel,
} from "./labels.ts";
import { overlaySplitIsValid, waterStackIsValid } from "./layer_stack.ts";
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

/** 直近に反映された年代のデータ（main.ts の currentView の型。#247）。 */
export type DeckView = { year: number } & YearLayerData;

/** main.ts が所有する状態・処理の注入点（#247）。 */
export interface DeckAppDeps {
  /** 直近に反映された年代のデータ（未確定なら null = 描画しない） */
  getCurrentView(): DeckView | null;
  /** 地物レイヤー builder へ渡す状態スナップショット（main.ts 所有） */
  featureLayerContext(year: number): FeatureLayerContext;
  /** 政治レイヤー builder へ渡す状態スナップショット（main.ts 所有） */
  politicalLayerContext(year: number): PoliticalLayerContext;
  /** 現在の整数ズーム段（表示モード判定 politicalDetailVisibleAt の入力） */
  getZoomStep(): number;
  /** 現在の MapLibre スタイルのレイヤー ID 列（waterStackIsValid の入力） */
  currentStyleLayerIds(): string[];
  /** 概略境界（MapLibre 側の line レイヤー）の同期（TASK-80/150） */
  applyApproximateBorders(
    base: FeatureCollection,
    outlines: FeatureCollection,
  ): void;
  /**
   * Deck レベルのホバー処理（pick_handlers.ts。TASK-24/149）。
   * 第 2 引数はタッチ判定用のポインタイベント（#253。pointerType を
   * pick_handlers.suppressHoverTooltip が参照する）で、必ず透過させる。
   */
  onHover(info: PickingInfo, event?: { pointerType?: string }): void;
  /** Deck レベルのクリック処理（pick_handlers.ts。TASK-24/149） */
  onClick(info: PickingInfo): void;
}

/** createDeckApp が返す deck.gl 側のハンドル一式（#247）。 */
export interface DeckApp {
  /** interleaved オーバーレイ（picking・政治/地物レイヤーの実体） */
  overlay: MapboxOverlay;
  /** ラベル専用の overlaid オーバーレイ（TASK-77） */
  labelOverlay: MapboxOverlay;
  /** 現在の状態から全レイヤーを組み立てて overlay へ反映する */
  renderLayers(): void;
  /** 地物レイヤー builder + メモ化（デバッグフックとキャッシュ共有） */
  featureLayers: ReturnType<typeof createFeatureLayerBuilders>;
  /** 政治レイヤー builder + メモ化（デバッグフックとキャッシュ共有） */
  politicalLayers: ReturnType<typeof createPoliticalLayerBuilders>;
}

/**
 * deck.gl オーバーレイ 2 枚とレイヤー組み立て（renderLayers）を生成する。
 * 起動時に 1 度だけ呼ぶ（overlay と builder のメモ化キャッシュを 1 組に保つ）。
 */
export function createDeckApp(deps: DeckAppDeps): DeckApp {
  // AC #1: MapboxOverlay（interleaved）で deck.gl を MapLibre に統合する。
  // overlay と GeoJsonLayer はここで 1 度だけ生成し、年代切替では data を
  // 差し替えるのみ。
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
    onHover: (info, event) => deps.onHover(info, event),
    onClick: (info) => deps.onClick(info),
  });

  // ラベル専用のオーバーレイ（TASK-77）。地図 canvas の上に重ねる deck 専用
  // canvas（overlaid モード）で、コンテナは pointer-events: none のため地図の
  // ドラッグ・ズーム操作を妨げない。
  //
  // interleaved にしない理由: 勢力ポリゴンを水面より下へ回す beforeId により
  // interleaved のレイヤーグループが 2 つに分かれると、先に描画されるグループの
  // パスが CollisionFilterExtension の衝突マップをラベル抜きで描き直し、ラベルが
  // 全滅する（詳細と検証結果は layer_stack.ts の OVERLAID_LAYER_IDS）。
  //
  // picking・イベント処理はこのオーバーレイに一切持たせない（ラベル 3 層は
  // pickable: false で PICKING_PRIORITY にも含まれないため、ホバー/クリックの
  // 挙動は overlay 側だけで従来どおり完結する）。
  const labelOverlay = new MapboxOverlay({
    interleaved: false,
    layers: [],
  });

  // 地物レイヤー builder 群（TASK-147）と政治レイヤー builder 群（TASK-148）。
  // ファクトリは 1 度だけ呼び、メモ化キャッシュ（TASK-50/136 の参照同値契約の
  // 実体）を builder とデバッグフック（installDebugHooks への注入）で共有する。
  const featureLayers = createFeatureLayerBuilders();
  const politicalLayers = createPoliticalLayerBuilders();

  /**
   * 現在の年代データ + 河川 + 都市 + ラベルの全レイヤーを組み立てて overlay へ
   * 反映する。描画順（配列順 = 下から上）: powers → france-fiefs → hre-powers →
   * hre-extent → rivers-hit → cities-hit → cities → rivers → power-labels →
   * river-labels → city-labels。
   * TASK-71: france-fiefs は powers の直上（ベースの France ポリゴンの上）に
   * 置く。塗りは共通の FILL_ALPHA（半透明）なので下の勢力塗りが透け、諸侯領の
   * 欠落部（南仏・パリ周辺など）はベースの France 塗りがそのまま見える。
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
   * 挿入位置のみを変え、deck レイヤー配列の順序 = picking 優先順
   * （PICKING_PRIORITY）には影響しない（@deck.gl/mapbox は beforeId ごとに
   * グループを作り、同一グループ内では配列順で描画する）。
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
    const currentView = deps.getCurrentView();
    if (currentView === null) return;
    const { year, base, hre, fiefs, outlines, baseFill, italyFiefs } =
      currentView;
    const { cliopatriaFiefs, britainFiefs, sovereignFiefs } = currentView;
    // TASK-80: base の境界線は全年代とも MapLibre の概略境界レイヤー
    // （approximate-borders-*、syncApproximateBorders）が描くため、powers の
    // stroke は常に止める（TASK-78 は諸侯領オーバーレイ対象年だけ止めていた）。
    // 描画データの入力は「対象年 = 切り出し済みの base 輪郭（outlines）、
    // それ以外 = base ポリゴンの環」で、TASK-78 の二重輪郭解消は維持される。
    const ctx = deps.featureLayerContext(year);
    const pctx = deps.politicalLayerContext(year);
    // #228 AC1: 政治領域の表示モード。詳細（z5 以上）= 領邦オーバーレイを表示、
    // 概観（z4）= 上位勢力単位の連続した塗りだけを表示。塗りデータの選択・
    // 領邦レイヤーの visible・ラベルサイズ・picking の出典解決
    // （pick_handlers.ts）がすべてこの同じ判定（politicalDetailVisibleAt）を
    // 共有する。
    const politicalDetail = politicalDetailVisibleAt(deps.getZoomStep());
    // #267 AC1: 3 段階の表示レベル（z4 / z5〜6 / z7〜8）。内部境界の線幅・
    // alpha（internalBorderLine*）が mid / detail で変わる。判定は塗り・
    // ラベル・picking と同じ politicalDisplayLevel を共有する。
    const level = politicalDisplayLevel(deps.getZoomStep());
    // #267 AC2/AC4: 内部境界のアクセサ。インク（色相 = 記号）はレイヤー系統で
    // 選び、太さ・alpha は feature の構造分類（politicalOverlayTier）×
    // 表示レベルで決まる。どの組み合わせでも上位勢力外周（概略境界の
    // インク + casing）より細く低 alpha（political_layers.ts の
    // INTERNAL_BORDER_STYLES とそのテストで固定）。
    const fiefLineColor = (f: Feature) =>
      internalBorderLineColor(FIEF_BORDER_INK, f.properties, level);
    const hreLineColor = (f: Feature) =>
      internalBorderLineColor(HRE_BORDER_INK, f.properties, level);
    const internalLineWidth = (f: Feature) =>
      internalBorderLineWidth(f.properties, level);
    const buildPickableLayer: Record<string, () => Layer> = {
      [POWER_LAYER_ID]: () =>
        politicalLayers.buildPowerLayer(
          pctx,
          POWER_LAYER_ID,
          // TASK-92: 諸侯領オーバーレイ対象年は諸侯領 union を差し引いた派生
          // base を塗る。諸侯領の下に base の半透明が重なって出る「境界線を
          // 伴わない濃淡」を消すのが目的で、非対象年・取得失敗時は base に
          // 縮退する。
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
      // #267 AC3/AC4: 領邦・諸侯領の内部境界は、上位勢力外周（MapLibre の
      // 概略境界インク + クリーム casing）より常に細く低 alpha の
      // 階層別スタイル（internalBorderLine*）で描く。
      [HRE_LAYER_ID]: () =>
        politicalLayers.buildPowerLayer(
          pctx,
          HRE_LAYER_ID,
          hre,
          hreLineColor,
          internalLineWidth,
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
          fiefLineColor,
          internalLineWidth,
          true,
          politicalDetail,
        ),
      // TASK-96: 中世イタリア諸侯領。仏諸侯領と同じ藍紫の境界線・同じ塗り規則で
      // 「諸侯領の区画」という記号を共有する（帝国系の焦茶とは色相で区別する）。
      // 非対象年は空 FC なので実質非表示。
      [ITALY_FIEF_LAYER_ID]: () =>
        politicalLayers.buildPowerLayer(
          pctx,
          ITALY_FIEF_LAYER_ID,
          italyFiefs,
          fiefLineColor,
          internalLineWidth,
          true,
          politicalDetail,
        ),
      // TASK-110: Cliopatria 由来の領邦。OHM に該当リレーションが無い領邦だけを
      // 収録した補完データで、既存 3 系統と同じ buildPowerLayer に載せる
      // （非対象年・未生成時は空 FC なので実質非表示）。境界線色だけは feature
      // 単位で決める: このレイヤーは仏諸侯領と帝国領邦を同居させるため、
      // レイヤー一律にすると凡例（藍紫 = 諸侯領の区画 / 焦茶 = 帝国領邦・base と
      // 同じ線）が破れる。
      [CLIOPATRIA_FIEF_LAYER_ID]: () =>
        politicalLayers.buildPowerLayer(
          pctx,
          CLIOPATRIA_FIEF_LAYER_ID,
          cliopatriaFiefs,
          (f: Feature) =>
            isHreSuzerainFeature(f.properties)
              ? hreLineColor(f)
              : fiefLineColor(f),
          internalLineWidth,
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
          fiefLineColor,
          internalLineWidth,
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
          fiefLineColor,
          internalLineWidth,
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
    // TASK-84: 政治ポリゴンの挿入位置（beforeId = 海洋 water）が「内水面より
    // 上・海洋と海岸線より下」であることを、実際のスタイル順に対して毎回確認
    // する。ベースマップ側のレイヤー順を変えて沿岸の線や塗りが壊れたらここで
    // 気付ける（対象レイヤーを持たないフォールバックスタイルでは常に true）。
    if (!waterStackIsValid(deps.currentStyleLayerIds())) {
      throw new Error("ベースマップの水面・海岸線の重ね順が不正");
    }
    overlay.setProps({ layers });
    labelOverlay.setProps({ layers: labelLayers });
    // TASK-80: base の境界線（概略境界）は MapLibre 側の line レイヤー。deck の
    // レイヤー反映後に同期することで、deck がグループを追加し直した場合でも
    // 概略境界が塗りの上に来る位置へ引き上げられる（メモ化 + 同期の実体は
    // approximate_border_sync.ts。TASK-150）。
    deps.applyApproximateBorders(base, outlines);
  }

  return {
    overlay,
    labelOverlay,
    renderLayers,
    featureLayers,
    politicalLayers,
  };
}
