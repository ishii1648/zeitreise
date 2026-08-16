/**
 * 地物レイヤー builder 群（TASK-147。main.ts から抽出）。
 *
 * 河川（表示ライン・透明ヒットライン・河川名ラベル）・山脈（名前ラベル・
 * 判定円・強調輪郭）・山峰（▲ マーカー・判定円・名前ラベル）・都市
 * （ドット・判定円・名前ラベル）の 12 builder と、それらが共有する
 * ラベル共通 base props（{@linkcode labelLayerBaseProps}）・メモ化を持つ。
 *
 * decision-29 / docs/main-ts-inventory.md §2 U4 の方針:
 * - **状態の所有は main.ts に残す**。builder は main が renderLayers ごとに
 *   組み立てる {@linkcode FeatureLayerContext}（データ参照・ズーム段・
 *   hover/selection のスナップショット）だけを読む純関数で、このモジュールは
 *   module-scope の可変状態を持たない。
 * - `memoizeLatest` のキャッシュ（TASK-50/136 の参照同値契約の実体）は
 *   {@linkcode createFeatureLayerBuilders} ファクトリの closure に置く。
 *   main.ts はファクトリを 1 度だけ呼び、返り値のメモ化インスタンスを
 *   そのまま debug_hooks.ts へ注入することで「builder とデバッグフックが
 *   同一キャッシュを共有する」（フックの呼び出しが polylabel 再計算や
 *   フォントアトラス再生成を誘発しない）を維持する。
 * - メモ化の同値判定は参照同値（memo.ts）。context のプロパティに main の
 *   モジュール状態（switchYear 成功時のみ差し替わる参照・変化検知済みの
 *   hover/selection）が入る前提はそのままなので、hover 連続移動の
 *   renderLayers では同じ参照が deck.gl へ渡り続け、属性再計算が走らない
 *   （AC #4。TASK-50/136/143 の契約）。
 */
import { GeoJsonLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import type { Color } from "@deck.gl/core";
import type { Feature, FeatureCollection } from "geojson";
import {
  characterSetFrom,
  CITY_LABEL_COLOR,
  CITY_LABEL_SIZE_PX,
  COLLISION_SIZE_SCALE,
  labelCollisionBackgroundProps,
  type LabelDatum,
  labelTextStyleProps,
  MOUNTAIN_LABEL_COLOR,
  MOUNTAIN_LABEL_SIZE_PX,
  RIVER_LABEL_SIZE_PX,
} from "./labels.ts";
import {
  filterVisibleMarineLabels,
  MARINE_LABEL_COLOR,
  MARINE_LABEL_SIZE_PX,
  marineLabelData,
  type MarineLabelDatum,
} from "./marine.ts";
import {
  type CollisionTextExtensionProps,
  labelCollisionExtensions,
} from "./label_collision.ts";
import {
  createCollisionIdAccessor,
  LABEL_COLLISION_SLOTS,
  type LabelCollisionSlot,
} from "./collision_id.ts";
import { memoizeLatest } from "./memo.ts";
import {
  CITY_LABEL_LAYER_ID,
  MARINE_LABEL_LAYER_ID,
  MOUNTAIN_LABEL_LAYER_ID,
  PEAK_LABEL_LAYER_ID,
  RIVER_LABEL_LAYER_ID,
} from "./layer_stack.ts";
import {
  CITY_HIT_LAYER_ID,
  CITY_LAYER_ID,
  MOUNTAIN_HIT_LAYER_ID,
  PEAK_HIT_LAYER_ID,
  PEAK_LAYER_ID,
  RIVERS_HIT_LAYER_ID,
  RIVERS_LAYER_ID,
} from "./picking.ts";
import {
  filterVisibleRiverLabels,
  RIVER_HIT_LINE_COLOR,
  RIVER_HIT_LINE_WIDTH_PX,
  riverLabelAnchors,
  riverLabelColor,
  type RiverLabelDatum,
  riverLineColor,
  riverLineWidth,
  riverNameFor,
} from "./rivers.ts";
import {
  filterVisibleMountainLabels,
  MOUNTAIN_HIT_FILL_COLOR,
  MOUNTAIN_HIT_RADIUS_PX,
  MOUNTAIN_OUTLINE_LAYER_ID,
  mountainHitData,
  mountainLabelAnchors,
  type MountainLabelDatum,
  mountainOutlineColor,
  mountainOutlineWidth,
} from "./mountains.ts";
import {
  buildPeakLabelData,
  buildPeakMarkerData,
  filterVisiblePeaks,
  PEAK_HIT_FILL_COLOR,
  PEAK_HIT_RADIUS_PX,
  PEAK_LABEL_PIXEL_OFFSET,
  PEAK_MARKER_CHARACTER_SET,
  PEAK_MARKER_GLYPH,
  peakEntries,
  type PeakEntry,
  type PeakLabelDatum,
  peakLabelText,
  peakLabelTexts,
  peakMarkerColor,
  type PeakMarkerDatum,
  peakMarkerSize,
} from "./peaks.ts";
import {
  allCityPositions,
  buildCityLabelData,
  buildCityMarkerData,
  type CitiesData,
  CITY_HIT_FILL_COLOR,
  CITY_HIT_RADIUS_PX,
  CITY_MARKER_RADIUS_PX,
  cityEntriesForYear,
  type CityEntry,
  type CityMarkerDatum,
  filterCitiesByZoom,
} from "./cities.ts";

/**
 * builder が読む main.ts 所有の状態のスナップショット。main.ts が
 * renderLayers のたびに現在値から組み立てて渡す（getter ではなく値で受ける
 * ことで、builder は入力が固定された純関数になる）。
 *
 * メモ化（参照同値）の前提: riversData / mountainsData / peaksData /
 * citiesData / nameJa は起動時ロードで 1 度だけ差し替わる参照、year は
 * switchYear 成功時のみ変わる値、zoomStep は整数段の変化時のみ変わる値、
 * hover/selection は変化検知（applyRiverHover 等）を通った値。この前提が
 * TASK-50/136 の「hover 連続移動で再計算しない」を成立させる。
 */
export interface FeatureLayerContext {
  /** 現在の反映済み年代（都市レイヤーのデータ選択・updateTriggers に使う） */
  year: number;
  riversData: FeatureCollection;
  marineData: FeatureCollection;
  mountainsData: FeatureCollection;
  peaksData: FeatureCollection;
  citiesData: CitiesData;
  /** name-ja.json（英語 NAME → 日本語名）。未登録名は英語のまま */
  nameJa: Record<string, string>;
  /** ズーム別表示制御に使う現在の整数ズーム段（TASK-66/97/99） */
  zoomStep: number;
  selectedRiverName: string | null;
  hoveredRiverName: string | null;
  selectedMountainName: string | null;
  hoveredMountainName: string | null;
  selectedPeakName: string | null;
  hoveredPeakName: string | null;
}

/**
 * labels.ts の描画スタイル props（deck.gl 非依存で number[] を返す）を
 * deck.gl の Color 型へ適合させる薄いアダプタ（TASK-147）。値は一切変えない
 * （型注釈のみ。labels.ts 側へ deck.gl の型を持ち込まないための境界）。
 */
function textStyleProps() {
  const style = labelTextStyleProps();
  return { ...style, outlineColor: style.outlineColor as unknown as Color };
}

/**
 * 国名（勢力）・都市名・河川名のラベル TextLayer で共通の base props
 * （TASK-65、TASK-72 で改訂）。フォント・halo（SDF アウトライン）・衝突制御を
 * 1 箇所に集約し、builder 間での値ドリフト（TASK-54 の中間版/最終版の混在で
 * 実際に発生）を防ぐ。
 * - 描画スタイル（labels.ts labelTextStyleProps）: フォント + クリーム halo。
 *   TASK-54 の半透明背景パネルは TASK-72 で撤去した（背景の白枠が地図の
 *   情報を隠すため）。可読性は halo（LABEL_OUTLINE_WIDTH / _COLOR）に一本化。
 * - 衝突制御: 全層とも CollisionFilterExtension の同一衝突空間に参加させ、
 *   判定時はラベルを COLLISION_SIZE_SCALE 倍サイズとして扱う（実表示より
 *   広い余白を確保し、初期ズーム z4 や密集地帯での判読不能な重なりを防ぐ。
 *   TASK-54 で 2 → 2.6、TASK-72 で背景パネル padding の喪失を補って 2.8）。
 *   表示優先は各層のデータが持つ priority に従う。
 * - TASK-108: 衝突判定の結果（collision_fade）は 0/1 ではなく連続値なので、
 *   負けかけたラベルが半透明のまま描かれ続ける。labelCollisionExtensions が
 *   返す 2 つ目の extension でそれを二値化し、「読める」か「出ない」かの
 *   二択に倒す（順序に意味があるため必ずこの関数から組み立てる）。
 *   ここが唯一の extensions 指定箇所で、4 つの TextLayer builder（河川名・
 *   山脈名・都市名・勢力名（HRE 領邦名/仏諸侯領名を含む））が全て spread する。
 * 層固有の props（id・data・getText/getPosition・サイズ・文字色・
 * characterSet・getPixelOffset・updateTriggers・pickable 等）は各 builder に
 * 残す。
 */
export function labelLayerBaseProps<DataT extends LabelDatum>(
  collisionSlot: LabelCollisionSlot,
  collisionSource: readonly DataT[],
) {
  const collisionBackground = labelCollisionBackgroundProps();
  return {
    sizeUnits: "pixels" as const,
    ...textStyleProps(),
    // TASK-143: 自己衝突対策。衝突 FBO の実体になる不可視背景クアッドを
    // 全ラベル層に敷く（TASK-136 の河川層での対処の一般化）。これが無いと
    // FBO にはグリフ字形しか描かれず、アンカー画素（= 衝突判定のサンプル点）
    // がグリフの空白に落ちるラベル（「ライン川」「ローマ」「ボヘミア王国」等）
    // が自分自身の可視判定に失敗して永遠に表示されない。
    // labelTextStyleProps の background: false（TASK-72 の「見える背景パネルを
    // 持たない」契約）をこちらが上書きするため、スプレッド順は必ず後にする。
    // 詳細は labels.ts LABEL_COLLISION_BACKGROUND_COLOR を参照
    ...collisionBackground,
    getBackgroundColor: collisionBackground
      .getBackgroundColor as unknown as Color,
    extensions: labelCollisionExtensions(),
    getCollisionId: createCollisionIdAccessor(
      collisionSlot,
      collisionSource,
    ),
    collisionTestProps: { sizeScale: COLLISION_SIZE_SCALE },
    getCollisionPriority: (d: LabelDatum) => d.priority,
  };
}

/**
 * rivers（表示ライン）と rivers-hit（透明ヒットライン）で共通の GeoJsonLayer
 * base props（TASK-53）。両層は同一データをライン描画する層で、picking 可否や
 * ラインの丸め方も揃える。data は context の riversData（main.ts が所有し
 * 起動時ロードで 1 度だけ差し替わる参照）を毎回受け取る（挙動不変）。
 */
function riversLayerBaseProps(riversData: FeatureCollection) {
  return {
    data: riversData,
    pickable: true,
    stroked: false,
    filled: false,
    lineWidthUnits: "pixels",
    lineCapRounded: true,
    lineJointRounded: true,
  } as const;
}

/**
 * 地物レイヤーの builder 群とメモ化インスタンスを生成する（TASK-147）。
 *
 * main.ts はこれを起動時に 1 度だけ呼ぶ。返り値の builder は
 * {@linkcode FeatureLayerContext} を受ける純関数で、メモ化キャッシュ
 * （closure 内）だけがファクトリ呼び出し間で持続する。メモ化インスタンス
 * （memoized*）も返すのは、debug_hooks.ts へ**同一インスタンス**を注入する
 * ため（デバッグフックの呼び出しがフォントアトラス再生成や polylabel
 * 再計算を誘発しない。TASK-50/136 の参照同値契約）。
 */
export function createFeatureLayerBuilders() {
  const memoizedMarineLabelData = memoizeLatest((fc: FeatureCollection) => {
    const data = marineLabelData(fc);
    return { data, characterSet: characterSetFrom(data.map((d) => d.text)) };
  });
  const memoizedVisibleMarineLabels = memoizeLatest(
    (labels: readonly MarineLabelDatum[], zoom: number) =>
      filterVisibleMarineLabels(labels, zoom),
  );

  function buildMarineLabelLayer(ctx: FeatureLayerContext): TextLayer<
    MarineLabelDatum,
    CollisionTextExtensionProps<MarineLabelDatum>
  > {
    const { data: labels, characterSet } = memoizedMarineLabelData(
      ctx.marineData,
    );
    return new TextLayer<
      MarineLabelDatum,
      CollisionTextExtensionProps<MarineLabelDatum>
    >({
      ...labelLayerBaseProps(LABEL_COLLISION_SLOTS.marine, labels),
      id: MARINE_LABEL_LAYER_ID,
      data: memoizedVisibleMarineLabels(labels, ctx.zoomStep),
      pickable: false,
      getText: (d) => d.text,
      getPosition: (d) => d.position,
      getSize: MARINE_LABEL_SIZE_PX,
      getColor: MARINE_LABEL_COLOR,
      characterSet,
    });
  }

  // ---- 河川（TASK-24/42/43/50/53/69/123/136）----

  /**
   * 全年代の都市座標 union をメモ化する（TASK-136）。citiesData の参照は
   * 起動時ロード後に不変なので、実質 1 回（初期値 { years: {} } → ロード完了で
   * もう 1 回）だけ計算される。河川ラベルのアンカー回避（riverLabelAnchors の
   * avoidPoints）に渡す。
   */
  const memoizedCityAvoidPoints = memoizeLatest(allCityPositions);

  /**
   * 河川名ラベルのデータ + characterSet をメモ化する（TASK-50 / TASK-136）。
   * riversData・nameJa・都市座標 union（memoizedCityAvoidPoints の安定参照）は
   * 起動時に一度ロードされたあと year に関わらず不変なため、hover/selection
   * だけを変える renderLayers 呼び出しでは引数の参照が前回と同じになり、
   * riverLabelAnchors と characterSetFrom の再計算をスキップできる
   * （citiesData のロード完了時に 1 度だけ再計算される）。
   */
  const memoizedRiverLabelData = memoizeLatest(
    (
      fc: FeatureCollection,
      ja: Record<string, string>,
      avoidPoints: readonly [number, number][],
    ) => {
      const data = riverLabelAnchors(fc, ja, avoidPoints);
      return { data, characterSet: characterSetFrom(data.map((d) => d.text)) };
    },
  );

  /**
   * 現在のズーム段とホバー/選択状態で表示する河川ラベルに絞る（TASK-123）。
   * memoizedRiverLabelData の安定参照 + hovered/selected + zoomStep をキーに
   * するので、いずれも変わらない renderLayers 呼び出しでは同じ配列参照が
   * deck.gl へ渡り、属性再計算が走らない（memoizedVisiblePowerLabels と同型）。
   */
  const memoizedVisibleRiverLabels = memoizeLatest(
    (
      anchors: readonly RiverLabelDatum[],
      hovered: string | null,
      selected: string | null,
      zoomStep: number,
    ) => filterVisibleRiverLabels(anchors, hovered, selected, zoomStep),
  );

  /**
   * 主要河川ラインの GeoJsonLayer を生成する（TASK-24）。
   * 色・幅は rivers.ts の純粋関数で決め、選択中の河川全体（同名 feature）を
   * 太く濃色で強調する。TASK-42: ホバー中（未選択）の河川は中間強調にする
   * （選択 > ホバー > 通常の優先度は rivers.ts 側で解決）。選択・ホバーの
   * いずれも updateTriggers で再評価させる。
   */
  function buildRiversLineLayer(ctx: FeatureLayerContext): GeoJsonLayer {
    const { selectedRiverName, hoveredRiverName } = ctx;
    return new GeoJsonLayer({
      ...riversLayerBaseProps(ctx.riversData),
      id: RIVERS_LAYER_ID,
      getLineColor: (f: Feature) =>
        riverLineColor(
          riverNameFor(f.properties),
          selectedRiverName,
          hoveredRiverName,
        ),
      getLineWidth: (f: Feature) =>
        riverLineWidth(
          riverNameFor(f.properties),
          selectedRiverName,
          hoveredRiverName,
        ),
      lineWidthMinPixels: 1,
      updateTriggers: {
        getLineColor: [selectedRiverName, hoveredRiverName],
        getLineWidth: [selectedRiverName, hoveredRiverName],
      },
    });
  }

  /**
   * 河川の透明ヒットライン層（GeoJsonLayer）を生成する（TASK-43）。
   * rivers と同一データ（riversData）を完全透明・RIVER_HIT_LINE_WIDTH_PX（14px）
   * で描画する判定専用レイヤー。PICKING_PRIORITY 上は cities より劣後（TASK-49）
   * のため renderLayers では rivers・cities の下に描画され、見た目には影響しない
   * （完全透明）まま「河川ライン・都市ドットのどちらの上でもない帯内」だけを
   * 河川として判定する。見た目（色・線幅の選択/ホバー/通常 3 状態）には一切
   * 関与しないため、getLineColor/getLineWidth は固定値のままで良く、
   * selectedRiverName / hoveredRiverName への依存も無い（updateTriggers 不要）。
   * data（riversData）自体は起動時に 1 度だけロードされ年代に依存しないため、
   * rivers 層と同様に data の updateTriggers も不要。
   */
  function buildRiversHitLayer(ctx: FeatureLayerContext): GeoJsonLayer {
    return new GeoJsonLayer({
      ...riversLayerBaseProps(ctx.riversData),
      id: RIVERS_HIT_LAYER_ID,
      getLineColor: RIVER_HIT_LINE_COLOR,
      getLineWidth: RIVER_HIT_LINE_WIDTH_PX,
    });
  }

  /**
   * 河川名ラベルの TextLayer を生成する（TASK-24 AC #1、TASK-69、TASK-123）。
   * アンカーは最長 LineString の中点（rivers.ts riverLabelAnchors）。勢力ラベル
   * より小さめの青灰系文字 + クリーム halo で「水系の注記」に見えるようにし、
   * CollisionFilterExtension（勢力ラベルと同一衝突空間）でライン長由来の
   * priority により長い川を優先表示する。pickable: false でライン・ポリゴンの
   * picking を妨げない。
   *
   * TASK-69 で常時表示をやめホバー/選択時のみにしたが、TASK-122 で低ズームの
   * 諸侯領ラベルが消え密度問題が解消したため、TASK-123 でズーム段による
   * 常時表示（riverLabelMinPriority による priority 上位の段階出し）を戻した。
   * ホバー中・クリック選択中の河川はしきい値未満でも必ず表示され、文字色だけ
   * 強調色（ACTIVE_RIVER_LABEL_COLOR）へ切り替わる。表示対象の決定は純粋関数
   * filterVisibleRiverLabels に委ね、ここでは hovered/selected/zoomStep を
   * 渡すだけにする。アンカー生成（memoizedRiverLabelData）は年代・ズーム・
   * hover/selection 非依存のまま全河川分を 1 度だけ行い、hover 連続移動で
   * 再計算が走らないようにする（TASK-50 非退行）。characterSet も全河川分の
   * メモ化結果（同一参照）を渡し続け、表示対象が変わってもフォントアトラスの
   * 再生成が起きないようにする。
   */
  function buildRiverLabelLayer(ctx: FeatureLayerContext): TextLayer<
    RiverLabelDatum,
    CollisionTextExtensionProps<RiverLabelDatum>
  > {
    const { selectedRiverName, hoveredRiverName } = ctx;
    const { data: anchors, characterSet } = memoizedRiverLabelData(
      ctx.riversData,
      ctx.nameJa,
      memoizedCityAvoidPoints(ctx.citiesData),
    );
    const data = memoizedVisibleRiverLabels(
      anchors,
      hoveredRiverName,
      selectedRiverName,
      ctx.zoomStep,
    );
    return new TextLayer<
      RiverLabelDatum,
      CollisionTextExtensionProps<RiverLabelDatum>
    >({
      // フォント・クリーム halo（TASK-72: ライン/ワール/レク川合流部の密集や
      // HRE 外縁の赤境界線との重なり対策。背景パネルは撤去済み）・衝突制御・
      // 自己衝突対策の不可視背景クアッド（TASK-136 でこの層に導入 → TASK-143 で
      // 全ラベル層へ一般化して base props に移設）は共通 base props
      ...labelLayerBaseProps(LABEL_COLLISION_SLOTS.river, anchors),
      id: RIVER_LABEL_LAYER_ID,
      data,
      pickable: false,
      getText: (d) => d.text,
      getPosition: (d) => d.position,
      // 勢力ラベル（POWER_LABEL_SIZE_PX）より控えめなサイズ + クリーム halo。
      // 常時表示は暗青灰（RIVER_LABEL_COLOR）、ホバー/選択中は濃い水色
      // （ACTIVE_RIVER_LABEL_COLOR）で強調する（TASK-123）
      getSize: RIVER_LABEL_SIZE_PX,
      getColor: (d) =>
        riverLabelColor(d.name, selectedRiverName, hoveredRiverName),
      // 日本語名（ライン川 等）のグリフもラベル文字列から自動生成する
      characterSet,
      // hovered/selected は getColor の入力なので trigger に足す（data 参照も
      // 同時に変わるが、契約として明示する）。zoomStep の変化は data 参照の
      // 変化として伝わる
      updateTriggers: { getColor: [hoveredRiverName, selectedRiverName] },
    });
  }

  // ---- 山脈（TASK-97/100）----

  /**
   * 山脈名ラベルのデータ + characterSet をメモ化する（TASK-97）。
   * mountainsData・nameJa は起動時に一度ロードされたあと年代・ズーム・
   * hover/selection に関わらず不変なので、polylabel によるアンカー生成は
   * 起動後 1 度だけ走り、以降は同じ参照が返る（TASK-50 のメモ化方針）。
   */
  const memoizedMountainLabelData = memoizeLatest(
    (fc: FeatureCollection, ja: Record<string, string>) => {
      const data = mountainLabelAnchors(fc, ja);
      return { data, characterSet: characterSetFrom(data.map((d) => d.text)) };
    },
  );

  /**
   * 山脈の判定円層に渡すデータをメモ化する（TASK-100）。入力の anchors は
   * memoizedMountainLabelData の安定参照なので、ズーム段が変わらない限り
   * 同じ配列参照が deck.gl へ渡り、hover/selection だけの renderLayers 呼び出しでは
   * ScatterplotLayer の属性再計算が走らない（TASK-50 の方針）。
   */
  const memoizedMountainHitData = memoizeLatest(
    (anchors: readonly MountainLabelDatum[], step: number) =>
      mountainHitData(anchors, step),
  );

  /**
   * 山脈名ラベルの TextLayer を生成する（TASK-97 AC #1/#2/#3/#4）。
   *
   * 常時表示（河川名のようなホバー限定ではない）にするのは、山脈が年代に依らない
   * 地形で「今どこを見ているか」の手掛かりとして常に有効だから。年代切替では
   * データも表示条件も一切変わらない（AC #4）。表示するのは現在の整数ズーム段
   * （zoomStep）で NE の MIN_LABEL 由来のしきい値を満たすものだけ（AC #2）。
   *
   * 衝突制御は勢力名・都市名・河川名と同一空間で、priority は都市帯より下の
   * 固定帯（mountains.ts）。密集地帯では山脈名が先に間引かれ、勢力名・都市名の
   * 可読性を損なわない（AC #3）。pickable: false でポリゴン・マーカーの picking を
   * 妨げない（ホバー/クリック対象化は TASK-100）。
   */
  function buildMountainLabelLayer(ctx: FeatureLayerContext): TextLayer<
    MountainLabelDatum,
    CollisionTextExtensionProps<MountainLabelDatum>
  > {
    const { data: anchors, characterSet } = memoizedMountainLabelData(
      ctx.mountainsData,
      ctx.nameJa,
    );
    const data = filterVisibleMountainLabels(anchors, ctx.zoomStep);
    return new TextLayer<
      MountainLabelDatum,
      CollisionTextExtensionProps<MountainLabelDatum>
    >({
      // フォント・クリーム halo（陰影の濃い山体の上でも輪郭が効く）・衝突制御は
      // 共通 base props
      ...labelLayerBaseProps(LABEL_COLLISION_SLOTS.mountain, anchors),
      id: MOUNTAIN_LABEL_LAYER_ID,
      data,
      pickable: false,
      getText: (d) => d.text,
      getPosition: (d) => d.position,
      getSize: MOUNTAIN_LABEL_SIZE_PX,
      getColor: MOUNTAIN_LABEL_COLOR,
      // 日本語名（アルプス山脈 等）のグリフはラベル文字列から自動生成する。
      // 表示対象が変わってもフォントアトラスを作り直さないよう、characterSet は
      // 常に全山脈分（メモ化された同一参照）を渡す（河川ラベルと同じ扱い）
      characterSet,
      updateTriggers: { getText: [ctx.zoomStep], getPosition: [ctx.zoomStep] },
    });
  }

  /**
   * 山脈の透明ヒット層（ScatterplotLayer）を生成する（TASK-100 AC #1）。
   * 山脈名ラベルと同じアンカー（labels.ts labelAnchorFor = 山体内部で最も境界から
   * 遠い点）へ、完全透明・MOUNTAIN_HIT_RADIUS_PX の円を置く判定専用レイヤー。
   * 「面をそのまま pickable にしない」理由と半径の根拠は mountains.ts の
   * MOUNTAIN_HIT_LAYER_ID / MOUNTAIN_HIT_RADIUS_PX を参照。
   *
   * data はズーム段でのみ変わり、年代・hover/selection には依存しない
   * （山脈は年代非依存の地形。AC #5）。したがって updateTriggers はズーム段だけ。
   */
  function buildMountainHitLayer(
    ctx: FeatureLayerContext,
  ): ScatterplotLayer<MountainLabelDatum> {
    const { data: anchors } = memoizedMountainLabelData(
      ctx.mountainsData,
      ctx.nameJa,
    );
    return new ScatterplotLayer<MountainLabelDatum>({
      id: MOUNTAIN_HIT_LAYER_ID,
      data: memoizedMountainHitData(anchors, ctx.zoomStep),
      pickable: true,
      getPosition: (d) => d.position,
      radiusUnits: "pixels",
      getRadius: MOUNTAIN_HIT_RADIUS_PX,
      getFillColor: MOUNTAIN_HIT_FILL_COLOR,
      stroked: false,
      updateTriggers: { getPosition: [ctx.zoomStep] },
    });
  }

  /**
   * 山脈の強調輪郭（GeoJsonLayer）を生成する（TASK-100 AC #4）。
   * ホバー/選択中の山脈だけをオリーブの線で囲い、それ以外は完全透明・線幅 0 で
   * 描く（判定は mountains.ts の mountainOutlineColor / mountainOutlineWidth）。
   *
   * 塗り（filled: false）を持たないので、勢力・領邦のアクティブ塗り
   * （power_highlight.ts）と面の表現がぶつからない。pickable: false なので
   * PICKING_PRIORITY 外で、レイヤー順の整合検証では無視される（勢力圏の外枠
   * hre-extent と同じ扱い）。data は年代非依存の mountainsData そのもの。
   */
  function buildMountainOutlineLayer(ctx: FeatureLayerContext): GeoJsonLayer {
    const { selectedMountainName, hoveredMountainName } = ctx;
    return new GeoJsonLayer({
      id: MOUNTAIN_OUTLINE_LAYER_ID,
      data: ctx.mountainsData,
      pickable: false,
      filled: false,
      stroked: true,
      lineWidthUnits: "pixels",
      lineJointRounded: true,
      getLineColor: (f: Feature) =>
        mountainOutlineColor(
          f.properties,
          selectedMountainName,
          hoveredMountainName,
        ),
      getLineWidth: (f: Feature) =>
        mountainOutlineWidth(
          f.properties,
          selectedMountainName,
          hoveredMountainName,
        ),
      updateTriggers: {
        getLineColor: [selectedMountainName, hoveredMountainName],
        getLineWidth: [selectedMountainName, hoveredMountainName],
      },
    });
  }

  // ---- 山峰（TASK-99/100）----

  /**
   * ズームフィルタ済みの表示山峰をメモ化する（TASK-99）。peaksData は起動時に
   * 一度ロードされたあと年代・hover/selection に関わらず不変なので、
   * peakEntries（検証付き変換）は起動後 1 度だけ走る。ズーム段が変わったときだけ
   * filterVisiblePeaks が新しい配列を返し、下流（マーカー/ラベル）のメモ化キーに
   * なる（cities.ts の memoizedVisibleCityEntries と同型）。
   */
  const memoizedPeakEntries = memoizeLatest(
    (fc: FeatureCollection) => peakEntries(fc),
  );
  const memoizedVisiblePeaks = memoizeLatest(
    (entries: readonly PeakEntry[], zoomStep: number) =>
      filterVisiblePeaks(entries, zoomStep),
  );

  /** 山峰マーカーデータをメモ化する（入力は memoizedVisiblePeaks の安定参照） */
  const memoizedPeakMarkerData = memoizeLatest(
    (entries: readonly PeakEntry[]) => buildPeakMarkerData(entries),
  );

  /**
   * 山峰名ラベルのデータをメモ化する（TASK-99）。入力はズームフィルタ済みの
   * 安定参照なので、hover/selection だけの renderLayers 呼び出しでは同じ配列
   * 参照が deck.gl へ渡り続ける（TASK-50 の方針）。
   */
  const memoizedPeakLabelData = memoizeLatest(
    (entries: readonly PeakEntry[], ja: Record<string, string>) =>
      buildPeakLabelData(entries, ja),
  );

  /** collision ID はズームフィルタ前の全山峰から作り、候補増減でも再割当しない。 */
  const memoizedPeakCollisionData = memoizeLatest(
    (entries: readonly PeakEntry[], ja: Record<string, string>) =>
      buildPeakLabelData(entries, ja),
  );

  /**
   * 山峰名ラベルの characterSet をメモ化する（TASK-99）。「現在のズームで表示中の
   * 山峰」ではなく**全山峰**の名称のみ版・標高併記版の両方から作る
   * （peakLabelTexts）。ズーム段が変わって表示件数やテキストの内容（標高の併記）が
   * 変わってもフォントアトラスを作り直さないための契約で、河川・山脈ラベルと
   * 同じ扱い。
   */
  const memoizedPeakCharacterSet = memoizeLatest(
    (entries: readonly PeakEntry[], ja: Record<string, string>) =>
      characterSetFrom(peakLabelTexts(buildPeakLabelData(entries, ja))),
  );

  /**
   * 主要山峰マーカーの層を生成する（TASK-99 AC #1/#2/#4/#5）。
   *
   * 都市マーカー（ScatterplotLayer の丸ドット）と違い TextLayer に ▲ のグリフを
   * 描かせる。形で都市と区別するための選択で、根拠は peaks.ts の
   * PEAK_MARKER_GLYPH に詳述（deck.gl の ScatterplotLayer は丸しか描けず、
   * PolygonLayer は固定 px の記号を作れず、IconLayer は画像デコードの失敗経路と
   * バンドル増を伴う）。
   *
   * CollisionFilterExtension は**付けない**（labelLayerBaseProps を spread しない
   * のはそのため）。間引きの対象はラベルだけにして、ラベルが競り負けても記号は
   * 残るようにする。表示する山峰はラベル層と同じ filterVisiblePeaks の結果なので、
   * 記号と名前の出し入れは必ず一致する。
   *
   * 年代には一切依存しない（AC #5）。レイヤー順は都市ドットの直下・都市の透明
   * 判定円の直上（renderLayers。PICKING_PRIORITY から導出）で、主題（都市ドット・
   * 河川ライン）を地形の記号が覆わない。
   *
   * TASK-100: pickable: true にし、ホバー/クリックで「名称 標高m」を出す。
   * 可視記号を pickable にしておくことで、隣接する都市の透明判定円
   * （cities-hit、9px）が重なっても「見えている ▲ の直上は必ずその山峰」が
   * レイヤー順だけで保証される（都市ドットと rivers-hit の関係と同じ。TASK-49）。
   * 記号の色とサイズは強調状態で変わる（peaks.ts peakMarkerColor / peakMarkerSize）。
   */
  function buildPeakMarkerLayer(
    ctx: FeatureLayerContext,
  ): TextLayer<PeakMarkerDatum> {
    const { selectedPeakName, hoveredPeakName } = ctx;
    const entries = memoizedVisiblePeaks(
      memoizedPeakEntries(ctx.peaksData),
      ctx.zoomStep,
    );
    return new TextLayer<PeakMarkerDatum>({
      id: PEAK_LAYER_ID,
      data: memoizedPeakMarkerData(entries),
      pickable: true,
      sizeUnits: "pixels",
      // フォント + クリーム halo（陰影・半透明塗りの上でも記号の輪郭が立つ）。
      // 衝突制御は含まない（labelLayerBaseProps ではなく描画スタイルのみ）
      ...textStyleProps(),
      getText: () => PEAK_MARKER_GLYPH,
      getPosition: (d) => d.position,
      getSize: (d) => peakMarkerSize(d, selectedPeakName, hoveredPeakName),
      getColor: (d) => peakMarkerColor(d, selectedPeakName, hoveredPeakName),
      characterSet: [...PEAK_MARKER_CHARACTER_SET],
      updateTriggers: {
        getPosition: [ctx.zoomStep],
        getSize: [selectedPeakName, hoveredPeakName],
        getColor: [selectedPeakName, hoveredPeakName],
      },
    });
  }

  /**
   * 山峰マーカーの透明ヒット層（ScatterplotLayer）を生成する（TASK-100 AC #2）。
   * cities-hit（TASK-82）と同型で、可視記号（▲）と同一データ
   * （memoizedPeakMarkerData の安定参照）を完全透明・PEAK_HIT_RADIUS_PX の円で
   * マーカーの直下に重ねる。
   *
   * これにより、ホバーでもクリックでも「カーソル直下 pick」だけで山峰を拾える
   * （ホバー側に pickMultipleObjects を足さない = TASK-36 のコスト設計を維持）。
   * ▲ のグリフは picking が不透明ピクセルにしか当たらず三角形の上端は 1〜2px しか
   * 幅が無いため、記号だけを pickable にすると狙って外す位置が構造的に残る
   * （根拠は peaks.ts PEAK_HIT_LAYER_ID）。
   */
  function buildPeakHitLayer(
    ctx: FeatureLayerContext,
  ): ScatterplotLayer<PeakMarkerDatum> {
    const entries = memoizedVisiblePeaks(
      memoizedPeakEntries(ctx.peaksData),
      ctx.zoomStep,
    );
    return new ScatterplotLayer<PeakMarkerDatum>({
      id: PEAK_HIT_LAYER_ID,
      data: memoizedPeakMarkerData(entries),
      pickable: true,
      getPosition: (d) => d.position,
      radiusUnits: "pixels",
      getRadius: PEAK_HIT_RADIUS_PX,
      getFillColor: PEAK_HIT_FILL_COLOR,
      stroked: false,
      updateTriggers: { getPosition: [ctx.zoomStep] },
    });
  }

  /**
   * 山峰名ラベルの TextLayer を生成する（TASK-99 AC #1/#3/#4/#5）。
   *
   * 衝突制御は勢力名・都市名・河川名・山脈名と同一空間で、priority は山脈帯の
   * 下半分（peaks.ts の帯設計）。密集地帯では山峰名が山脈名より先に間引かれ、
   * 勢力名・都市名の可読性を損なわない（AC #3）。重なりの解消に
   * COLLISION_SIZE_SCALE を触らないのは decision-21 のとおりで、密度の調整は
   * priority とズーム出し分け（peakMinZoom）だけで行う。
   *
   * 標高の併記は高ズーム（peaks.ts PEAK_ELEVATION_LABEL_MIN_ZOOM）でだけ行う。
   * 併記するとラベル幅が約 2.2 倍になり、同じ場所の勢力名・都市名を巻き込んで
   * 潰すため（根拠は同定数のコメント）。pickable: false（TASK-100 の範囲外）。
   */
  function buildPeakLabelLayer(ctx: FeatureLayerContext): TextLayer<
    PeakLabelDatum,
    CollisionTextExtensionProps<PeakLabelDatum>
  > {
    const { zoomStep } = ctx;
    const allEntries = memoizedPeakEntries(ctx.peaksData);
    const data = memoizedPeakLabelData(
      memoizedVisiblePeaks(allEntries, zoomStep),
      ctx.nameJa,
    );
    return new TextLayer<
      PeakLabelDatum,
      CollisionTextExtensionProps<PeakLabelDatum>
    >({
      // フォント・クリーム halo・衝突制御は共通 base props
      ...labelLayerBaseProps(
        LABEL_COLLISION_SLOTS.peak,
        memoizedPeakCollisionData(allEntries, ctx.nameJa),
      ),
      id: PEAK_LABEL_LAYER_ID,
      data,
      pickable: false,
      getText: (d) => peakLabelText(d, zoomStep),
      getPosition: (d) => d.position,
      // サイズ・文字色は山脈名ラベルと同一（12px の苔緑）。山峰は「山脈の中の
      // 1 点」で同じ地形の注記なので、新しい色を足して記号性を薄めるより、
      // 「緑 = 地形」（TASK-97）をそのまま共有する方が読み手の負荷が小さい。
      // 都市（濃茶）・勢力（濃グレー/臙脂/藍紫）・河川（水色）との区別は従来どおり
      getSize: MOUNTAIN_LABEL_SIZE_PX,
      getColor: MOUNTAIN_LABEL_COLOR,
      // マーカー（▲）を覆わないよう少し上へずらす（都市ラベルと同じ向き）
      getPixelOffset: [...PEAK_LABEL_PIXEL_OFFSET],
      // 日本語名（モンブラン 等）と標高併記（4807m）のグリフを両方含む
      characterSet: memoizedPeakCharacterSet(allEntries, ctx.nameJa),
      // ズーム段が変わると表示対象と標高併記の有無が変わる
      updateTriggers: { getText: [zoomStep], getPosition: [zoomStep] },
    });
  }

  // ---- 都市（TASK-27/49/66/82）----

  /**
   * ズームフィルタ済みの表示都市エントリをメモ化する（TASK-66 AC #2/#3）。
   * 年内の人口降順ランクが visibleCityRankLimit(zoomStep) 内の都市だけを返す。
   * キーは citiesData・year・zoomStep（整数ズーム段）で、hover/selection
   * だけの renderLayers 呼び出しでは同じ参照が返りフィルタ再計算をスキップする
   * （TASK-50 方針）。返り値の配列参照が安定するため、下流の
   * memoizedCityMarkerData / memoizedCityLabelData のメモ化キーとしても機能する。
   */
  const memoizedVisibleCityEntries = memoizeLatest(
    (data: CitiesData, year: number, zoomStep: number) =>
      filterCitiesByZoom(cityEntriesForYear(data, year), zoomStep),
  );

  /**
   * 都市マーカーデータをメモ化する（TASK-66）。entries は
   * memoizedVisibleCityEntries が返す安定参照なので、年・ズーム段が変わらない
   * 限り deck.gl へ渡す data の参照も安定し、hover/selection の再構築で
   * ScatterplotLayer の属性再計算が走らない。
   */
  const memoizedCityMarkerData = memoizeLatest(
    (entries: readonly CityEntry[]) => buildCityMarkerData(entries),
  );

  /**
   * 都市名ラベルのデータ + characterSet をメモ化する（TASK-50）。
   * TASK-66: 入力はズームフィルタ済みエントリ（memoizedVisibleCityEntries の
   * 安定参照）に変更した。entries・nameJa の参照が変わらない限り
   * buildCityLabelData・characterSetFrom の再計算を hover/selection の
   * renderLayers ではスキップする。year またはズーム段が変わると
   * memoizedVisibleCityEntries が新しい参照を返すため正しく再計算される。
   * #223: 時代別都市名（区間該当年のみ歴史名）のため year も引数に取る。
   * entries の参照は year 変化で必ず変わるため実質的なキー追加ではないが、
   * 出力が year に依存する事実をメモ化キーにも明示する。
   */
  const memoizedCityLabelData = memoizeLatest(
    (
      entries: readonly CityEntry[],
      ja: Record<string, string>,
      year: number,
    ) => {
      const labelData = buildCityLabelData(entries, ja, year);
      return {
        data: labelData,
        characterSet: characterSetFrom(labelData.map((d) => d.text)),
      };
    },
  );

  /** collision ID は同一年のズームフィルタ前候補から作る。 */
  const memoizedCityCollisionData = memoizeLatest(
    (
      cities: CitiesData,
      ja: Record<string, string>,
      year: number,
    ) => buildCityLabelData(cityEntriesForYear(cities, year), ja, year),
  );

  /**
   * 主要都市マーカーの ScatterplotLayer を生成する（TASK-27 AC #1/#3/#6）。
   * 小さな濃色ドット + 白縁で、勢力の半透明塗りの上でも視認できるようにする。
   * レイヤー順は rivers-hit の上・rivers の下（renderLayers）に置き、picking の
   * 優先順位を 河川 > 都市 > 河川ヒット層 > HRE 領邦 > 勢力 にする（TASK-49）。
   * cities を rivers-hit より優先することで、河畔都市（河川の判定帯 ±7px 内の
   * マーカー）の picking が rivers-hit に遮蔽されないようにする。年代切替では
   * 同一 ID のまま cityEntriesForYear で該当年のデータへ差し替えるだけにする。
   * TASK-66: data はズームフィルタ済み（人口上位ランクのみ）のエントリに
   * 差し替え、整数ズーム段（zoomStep）の変化でも再評価する。
   */
  function buildCityMarkerLayer(
    ctx: FeatureLayerContext,
  ): ScatterplotLayer<CityMarkerDatum> {
    const entries = memoizedVisibleCityEntries(
      ctx.citiesData,
      ctx.year,
      ctx.zoomStep,
    );
    return new ScatterplotLayer<CityMarkerDatum>({
      id: CITY_LAYER_ID,
      data: memoizedCityMarkerData(entries),
      pickable: true,
      getPosition: (d) => d.position,
      // 3px の固定ドット。国土に対する「点」の記号で、ズームに追従させない
      radiusUnits: "pixels",
      getRadius: CITY_MARKER_RADIUS_PX,
      // ラベルと同系の濃茶 fill + 白 stroke（塗りの上でも沈まない）
      getFillColor: [90, 46, 16, 255],
      stroked: true,
      lineWidthUnits: "pixels",
      getLineWidth: 1,
      getLineColor: [255, 255, 255, 230],
      updateTriggers: { getPosition: [ctx.year, ctx.zoomStep] },
    });
  }

  /**
   * 都市マーカーの透明ヒット層（ScatterplotLayer）を生成する（TASK-82）。
   * cities と同一データ（memoizedCityMarkerData の安定参照）を完全透明・
   * CITY_HIT_RADIUS_PX（9px）で描画する判定専用レイヤーで、rivers-hit
   * （TASK-43）と同型の仕組み。
   *
   * これにより、ホバーでもクリックでも「カーソル直下 pick」だけで
   * CITY_PICK_TOLERANCE_PX（cities.ts）の判定範囲が得られる。ホバー側に
   * pickMultipleObjects を足さない（TASK-36 のコスト設計を維持）まま、
   * 従来「クリックは近傍再ピックで ~9px / ホバーはドットの 3px のみ」だった
   * 非対称を解消する（AC #1/#2）。
   *
   * レイヤー順は cities の直下・rivers-hit の上（PICKING_PRIORITY 由来）。
   * 可視ドット（cities）を上に置くことで、判定円同士が重なる密集地域でも
   * 「ドット直上は必ずその都市」が保証される（AC #6）。
   * stroked: false・完全透明なので見た目には一切影響しない。
   */
  function buildCityHitLayer(
    ctx: FeatureLayerContext,
  ): ScatterplotLayer<CityMarkerDatum> {
    const entries = memoizedVisibleCityEntries(
      ctx.citiesData,
      ctx.year,
      ctx.zoomStep,
    );
    return new ScatterplotLayer<CityMarkerDatum>({
      id: CITY_HIT_LAYER_ID,
      data: memoizedCityMarkerData(entries),
      pickable: true,
      getPosition: (d) => d.position,
      radiusUnits: "pixels",
      getRadius: CITY_HIT_RADIUS_PX,
      getFillColor: CITY_HIT_FILL_COLOR,
      stroked: false,
      updateTriggers: { getPosition: [ctx.year, ctx.zoomStep] },
    });
  }

  /**
   * 都市名ラベルの TextLayer を生成する（TASK-27 AC #2/#4）。
   * 文字色は濃茶（#793E16）。国名ラベルの濃グレー [40,40,40]・河川ラベルの
   * 水色と明確に異なり、白 halo 付きで一見して都市と区別できる。サイズは
   * 河川ラベルと同じ CITY_LABEL_SIZE_PX（国名 POWER_LABEL_SIZE_PX より控えめ）で、
   * マーカーの右上へ
   * ピクセルオフセットしてドットとラベルが重ならないようにする。
   * CollisionFilterExtension は国名・河川ラベルと同一衝突空間
   * （collisionTestProps.sizeScale: 2）に参加させ、人口由来の都市固定バンド
   * priority（cities.ts）で大国ラベルに譲りつつ小勢力ラベルとは競らせる。
   * pickable: false でマーカー・ポリゴンの picking を妨げない。
   *
   * TASK-82: 判定範囲を広げるにあたりラベル自体のクリック対象化も検討したが、
   * 採用しない。ラベルは衝突フィルタで間引かれ（同じ都市でもズーム・年代で
   * 出たり消えたりする）、かつマーカーからピクセルオフセットして描かれるため、
   * 当たり判定にすると「表示されている年だけ広く拾える」「ドットから離れた
   * 文字の上でも拾える」と判定範囲が状態依存で不安定になる。判定の基準は
   * マーカー中心からの距離（cities.ts CITY_PICK_TOLERANCE_PX）1 本に保つ。
   */
  function buildCityLabelLayer(
    ctx: FeatureLayerContext,
  ): TextLayer<LabelDatum, CollisionTextExtensionProps<LabelDatum>> {
    const { year, zoomStep } = ctx;
    const { data, characterSet } = memoizedCityLabelData(
      memoizedVisibleCityEntries(ctx.citiesData, year, zoomStep),
      ctx.nameJa,
      year,
    );
    return new TextLayer<LabelDatum, CollisionTextExtensionProps<LabelDatum>>(
      {
        // フォント・クリーム halo（TASK-72: ケルン大司教領周辺など都市名の
        // 密集箇所対策。国名・河川ラベルと共通）・衝突制御は共通 base props
        ...labelLayerBaseProps(
          LABEL_COLLISION_SLOTS.city,
          memoizedCityCollisionData(ctx.citiesData, ctx.nameJa, year),
        ),
        id: CITY_LABEL_LAYER_ID,
        data,
        pickable: false,
        getText: (d) => d.text,
        getPosition: (d) => d.position,
        getSize: CITY_LABEL_SIZE_PX,
        getColor: CITY_LABEL_COLOR,
        // マーカー（3px + 白縁）を覆わないよう少し上へずらす（オフセットのみ。
        // getTextAnchor: "start" / getAlignmentBaseline: "bottom" は
        // CollisionFilterExtension の衝突判定パスと相性が悪く、指定すると
        // ラベルが全滅することを目視で確認したため既定（中央揃え）のまま使う）
        getPixelOffset: [0, -10],
        // 日本語都市名（パリ 等）のグリフもラベル文字列から自動生成する
        characterSet,
        // TASK-66: ズーム段の変化でも accessor を再評価させる（data 参照も
        // memoizedVisibleCityEntries 経由で変わるが、意図を明示して二重に守る）
        updateTriggers: {
          getText: [year, zoomStep],
          getPosition: [year, zoomStep],
        },
      },
    );
  }

  return {
    buildMarineLabelLayer,
    // builder（renderLayers から context 付きで呼ばれる）
    buildRiversLineLayer,
    buildRiversHitLayer,
    buildRiverLabelLayer,
    buildMountainLabelLayer,
    buildMountainHitLayer,
    buildMountainOutlineLayer,
    buildPeakMarkerLayer,
    buildPeakHitLayer,
    buildPeakLabelLayer,
    buildCityMarkerLayer,
    buildCityHitLayer,
    buildCityLabelLayer,
    // メモ化インスタンス（debug_hooks.ts へ同一インスタンスを注入するため公開。
    // builder とキャッシュを共有し、フックの呼び出しが再計算を誘発しない）
    memoizedCityAvoidPoints,
    memoizedRiverLabelData,
    memoizedVisibleRiverLabels,
    memoizedMountainLabelData,
    memoizedMountainHitData,
    memoizedPeakEntries,
    memoizedVisiblePeaks,
    memoizedPeakMarkerData,
    memoizedPeakLabelData,
    memoizedPeakCharacterSet,
    memoizedVisibleCityEntries,
    memoizedCityMarkerData,
    memoizedCityLabelData,
  };
}

/** createFeatureLayerBuilders の返り値型（main.ts の配線・テストで使う） */
export type FeatureLayerBuilders = ReturnType<
  typeof createFeatureLayerBuilders
>;
