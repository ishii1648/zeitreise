/**
 * 概略境界の MapLibre 同期（TASK-150 / Issue #168。main.ts から抽出）。
 *
 * base 勢力の境界線（概略境界、TASK-80）は deck.gl ではなく MapLibre の
 * line レイヤー 5 枚（外周 casing 2 段 + uncertainty tier 3 段。#228/#309）で描く
 * （blur・低 alpha の帯は deck では描けない。詳細は approximate_borders.ts）。スタイル側の状態なので、スタイルが変わるたびに
 * 「存在するか・重ね順が正しいか」を確認して追いつかせる必要があり、その
 * 同期本体（旧 syncApproximateBorders）・描画データのメモ化・再入ガード・
 * styledata 購読の組み立てを {@linkcode createApproximateBorderSync}
 * ファクトリに閉じ込める。
 *
 * decision-29 / docs/main-ts-inventory.md §2 U7 の方針:
 * - **直近に反映した描画データ（approximateBorderData）と再入ガードだけは、
 *   このファクトリの closure が所有する**。書き込み経路が apply / sync の
 *   2 本に閉じているため、同期の収束性・メモ化の参照同値を同じモジュールで
 *   直接ユニットテストできる。デバッグフック（__getApproximateBorderDebug の
 *   getApproximateBorderData）へは返り値ハンドルの読み取り用 getter
 *   {@linkcode ApproximateBorderSyncHandle.data} で提供する。
 * - それ以外の状態（currentView・MapLibre Map・スタイルのレイヤー ID 列）の
 *   所有は従来どおり main.ts に残し、getter・コールバックで注入される
 *   （{@linkcode ApproximateBorderSyncDeps}）。renderLayers への逆参照は
 *   requestRender コールバックで受ける（循環 import 回避）。
 */
import type {
  GeoJSONSource,
  GeoJSONSourceSpecification,
  LayerSpecification,
} from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import {
  APPROXIMATE_BORDER_SOURCE_ID,
  approximateBorderLayerSpecs,
  approximateBorderSourceSpec,
  buildApproximateBorderData,
  EMPTY_APPROXIMATE_BORDER_DATA,
} from "./approximate_borders.ts";
import {
  approximateBorderBeforeId,
  approximateBorderStackIsValid,
} from "./layer_stack.ts";
import { memoizeLatest } from "./memo.ts";

/** main.ts から注入される依存（使う操作だけ構造的に受ける。TASK-150） */
export interface ApproximateBorderSyncDeps {
  /**
   * 現在の MapLibre スタイルのレイヤー ID 列（main.ts currentStyleLayerIds）。
   * map 依存のため main からゲッターで受ける。スタイル未読込・差し替え中は
   * 空配列が返り、sync は何もしない（次の styledata で追いつく）。
   */
  getStyleLayerIds: () => string[];
  /** maplibre Map.getSource（存在すれば GeoJSONSource として setData する） */
  getSource: (id: string) => unknown;
  /** maplibre Map.addSource */
  addSource: (id: string, spec: GeoJSONSourceSpecification) => void;
  /** maplibre Map.getLayer（存在確認にのみ使う） */
  getLayer: (id: string) => unknown;
  /** maplibre Map.addLayer */
  addLayer: (spec: LayerSpecification, beforeId?: string) => void;
  /**
   * map.on("styledata", ...) の購読。ファクトリが生成時に 1 度だけ呼び、
   * 同期本体（sync）を購読させる（購読の組み立てもこのモジュールの責務）。
   */
  onStyleData: (listener: () => void) => void;
  /**
   * 年代データが確定しているか（main.ts currentView !== null）。未確定の間は
   * deck レイヤーが無いため、スタックが崩れていても requestRender しない。
   */
  hasCurrentView: () => boolean;
  /**
   * deck レイヤーの作り直し（main.ts renderLayers）。塗りが概略境界の上に
   * 来ている（approximateBorderStackIsValid が false）ときだけ呼ばれる。
   */
  requestRender: () => void;
  /** 同期失敗の警告（console.warn）。概略境界は地図全体を落とす理由にならない */
  warn: (message: string) => void;
}

/** createApproximateBorderSync が返すハンドル */
export interface ApproximateBorderSyncHandle {
  /**
   * 概略境界（MapLibre の line レイヤー 5 枚 = casing 2 段 + tier 3 段）を
   * スタイルへ反映する（旧 main.ts syncApproximateBorders。TASK-80 / #228）。
   *
   * 位置は海洋の水面（water）の直下。政治ポリゴンの塗りとの前後は deck 側の
   * beforeId が決める（underWaterBeforeId が概略境界の最下段を指すため、deck は
   * 自分のグループを概略境界の直下へ入れ直す）。deck レイヤーは構築時の props を
   * 持ち回るので、概略境界がまだ無い時点で作られた deck レイヤーは beforeId が
   * water のまま = 塗りが線の上に来る。その場合だけ requestRender で deck
   * レイヤーを作り直させる（順序が既に正しければ何もしないため、styledata の
   * 再発火は数回で収束する）。
   *
   * スタイル未読込・差し替え中は何もしない（styledata / renderLayers から
   * 何度でも呼ばれるので、次の機会に追いつく）。例外は握りつぶす: 概略境界が
   * 描けないことは地図全体を落とす理由にならない。
   */
  sync(): void;
  /**
   * 描画データをメモ化付きで確定し、スタイルへ同期する（renderLayers の
   * 末尾から呼ばれる。deck のレイヤー反映後に同期することで、deck がグループを
   * 追加し直した場合でも概略境界が塗りの上に来る位置へ引き上げられる）。
   */
  apply(base: FeatureCollection, outlines: FeatureCollection): void;
  /**
   * 直近に反映した描画データ（デバッグフック getApproximateBorderData 用）。
   * apply 前は EMPTY_APPROXIMATE_BORDER_DATA（同一参照）。
   */
  data(): FeatureCollection;
}

/**
 * 概略境界の同期ハンドルを生成し、styledata 購読を組み立てる（TASK-150）。
 *
 * main.ts はこれを起動時に 1 度だけ呼ぶ。styledata で拾うのは
 * (1) 起動時のスタイル読み込み、(2) OpenFreeMap へのフォールバック
 * （setStyle で source ごと消える）、(3) deck.gl が interleaved のレイヤー
 * グループを追加し直したとき（概略境界が塗りの下へ潜る）。
 * sync 自身の addSource / addLayer も styledata を再発火させるが、
 * 「すでに正しい」状態では何も変更しないため数回で収束する（概略境界を
 * 無条件に moveLayer で引き上げる実装にすると、deck.gl が styledata で
 * レイヤーグループを再挿入するのと無限に競合する。詳細は layer_stack.ts の
 * underWaterBeforeId）。
 */
export function createApproximateBorderSync(
  deps: ApproximateBorderSyncDeps,
): ApproximateBorderSyncHandle {
  /**
   * base 勢力の境界線（概略境界）の描画データをメモ化する（TASK-80）。
   *
   * 入力は「諸侯領オーバーレイ対象年（1000〜1300）なら TASK-78 の派生 base 輪郭
   * （outlines。諸侯領 union の外側だけに切り出した LineString 群）、それ以外の年
   * なら base 勢力ポリゴンの環」。前者を優先することで TASK-78 の二重輪郭解消
   * （諸侯領の内側を走る base 境界線を描かない）はそのまま維持される。
   *
   * #357: どちらの入力形でも `base`（元の勢力ポリゴン）を第 2 引数で必ず渡す。
   * 沿岸かどうかは「他 feature と共有されない外環セグメントか」で決まるため、
   * 諸侯領 union で切り出し済みの outlines だけでは判定できない。
   *
   * memoizeLatest で包む理由は buildLabelData と同じ: applyRiverHover /
   * applyExtentKey / ズーム段の変化は currentView を差し替えずに renderLayers()
   * を呼ぶため、同じ参照が渡り続けてセグメント分割（1 年あたり 5〜7 千セグメント）
   * と沿岸判定（合わせて実測 28〜44ms／年）を再計算しない。年代切替でだけ参照が
   * 変わって再計算される。
   */
  const memoizedApproximateBorderData = memoizeLatest(
    (base: FeatureCollection, outlines: FeatureCollection) =>
      buildApproximateBorderData(
        outlines.features.length > 0 ? outlines : base,
        base,
      ),
  );

  /**
   * 直近に反映した概略境界の描画データ（TASK-80）。スタイル差し替え
   * （OpenFreeMap へのフォールバック）で source ごと消えた後の再登録や、
   * styledata 経由の位置再調整で「今描くべきデータ」を参照するために持つ。
   */
  let approximateBorderData: FeatureCollection = EMPTY_APPROXIMATE_BORDER_DATA;

  /** 再入ガード: requestRender → renderLayers → sync の再入を止める */
  let syncing = false;

  function sync(): void {
    if (syncing) return;
    syncing = true;
    try {
      const styleLayerIds = deps.getStyleLayerIds();
      if (styleLayerIds.length === 0) return;
      const source = deps.getSource(APPROXIMATE_BORDER_SOURCE_ID);
      if (source === undefined) {
        deps.addSource(
          APPROXIMATE_BORDER_SOURCE_ID,
          approximateBorderSourceSpec(
            approximateBorderData,
          ) as GeoJSONSourceSpecification,
        );
      } else {
        (source as GeoJSONSource).setData(approximateBorderData);
      }
      const beforeId = approximateBorderBeforeId(styleLayerIds);
      for (const spec of approximateBorderLayerSpecs()) {
        if (deps.getLayer(spec.id) === undefined) {
          deps.addLayer(spec as unknown as LayerSpecification, beforeId);
        }
      }
      // 追加後の実際の順序を見て、塗りが線の上に来ていたら deck レイヤーを
      // 作り直す（buildPowerLayer が beforeId を概略境界の直下へ再計算する）
      if (
        deps.hasCurrentView() &&
        !approximateBorderStackIsValid(deps.getStyleLayerIds())
      ) {
        deps.requestRender();
      }
    } catch (error) {
      deps.warn(`概略境界レイヤーの反映に失敗しました: ${String(error)}`);
    } finally {
      syncing = false;
    }
  }

  function apply(base: FeatureCollection, outlines: FeatureCollection): void {
    approximateBorderData = memoizedApproximateBorderData(base, outlines);
    sync();
  }

  deps.onStyleData(sync);

  return { sync, apply, data: () => approximateBorderData };
}
