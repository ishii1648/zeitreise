/**
 * 沿岸補完の MapLibre 同期（Issue #305。approximate_border_sync.ts と同型）。
 *
 * 沿岸補完の帯（coastal_fill.ts）は MapLibre の line レイヤー 1 枚で描く
 * スタイル側の状態なので、スタイルが変わるたびに「存在するか」を確認して
 * 追いつかせる。挿入位置は内水面（water-inland）の直下で固定
 * （coastalFillBeforeId）。概略境界と違い deck レイヤーとの相対順には
 * 関与しない（帯は政治ポリゴンより常に下 = 内水面より下）ため、
 * requestRender の逆参照は持たない。
 *
 * decision-29 / TASK-150 の方針を踏襲する:
 * - 直近に反映した描画データ・強調キーの適用状態だけをファクトリの closure が
 *   所有する（書き込み経路が apply / sync に閉じ、収束性とメモ化を直接
 *   ユニットテストできる）
 * - map への操作・スタイルのレイヤー ID 列・colors / overrides / 強調キーの
 *   所有は main.ts に残し、getter / 引数で注入される
 *
 * 強調（ホバー/クリック）は feature-state で塗り（deck 側の
 * ACTIVE_FILL_COLOR）と同時に切り替える。picking はあくまで deck 側の元
 * ポリゴンで行われ、この帯は判定に一切関与しない（AC5）。
 */
import type {
  GeoJSONSource,
  GeoJSONSourceSpecification,
  LayerSpecification,
} from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import {
  buildCoastalFillData,
  COASTAL_FILL_SOURCE_ID,
  coastalFillBeforeId,
  coastalFillLayerSpec,
  coastalFillSourceSpec,
  EMPTY_COASTAL_FILL_DATA,
} from "./coastal_fill.ts";
import { COASTAL_FILL_LAYER_ID } from "./basemap.ts";
import type { SuzerainOverrides } from "./suzerain_extent.ts";
import { memoizeLatest } from "./memo.ts";

/** feature-state の対象指定（maplibre Map.setFeatureState の最小型） */
export interface CoastalFillFeatureStateTarget {
  source: string;
  id: string;
}

/** main.ts から注入される依存（使う操作だけ構造的に受ける） */
export interface CoastalFillSyncDeps {
  /** 現在の MapLibre スタイルのレイヤー ID 列（main.ts currentStyleLayerIds） */
  getStyleLayerIds: () => string[];
  /** maplibre Map.getSource（存在すれば GeoJSONSource として setData する） */
  getSource: (id: string) => unknown;
  /** maplibre Map.addSource */
  addSource: (id: string, spec: GeoJSONSourceSpecification) => void;
  /** maplibre Map.getLayer（存在確認にのみ使う） */
  getLayer: (id: string) => unknown;
  /** maplibre Map.addLayer */
  addLayer: (spec: LayerSpecification, beforeId?: string) => void;
  /** maplibre Map.setFeatureState（強調キーの点灯） */
  setFeatureState: (
    target: CoastalFillFeatureStateTarget,
    state: { active: boolean },
  ) => void;
  /** maplibre Map.removeFeatureState（強調キーの消灯） */
  removeFeatureState: (target: CoastalFillFeatureStateTarget) => void;
  /** map.on("styledata", ...) の購読（ファクトリが生成時に 1 度だけ呼ぶ） */
  onStyleData: (listener: () => void) => void;
  /** 同期失敗の警告。沿岸補完は地図全体を落とす理由にならない */
  warn: (message: string) => void;
}

/** createCoastalFillSync が返すハンドル */
export interface CoastalFillSyncHandle {
  /**
   * 沿岸補完（source + line レイヤー 1 枚）をスタイルへ反映する。
   * スタイル未読込・水面レイヤーなし（フォールバック）では何もしない。
   * 自身の addSource / addLayer が styledata を再発火させるが、「すでに
   * 正しい」状態では何も追加しないため収束する。
   */
  sync(): void;
  /**
   * 描画データ（メモ化付き）と強調キーを確定し、スタイルへ同期する
   * （renderLayers の末尾から呼ばれる。強調キーの変化も renderLayers 経由で
   * 必ずここを通るため、塗りの強調と同じタイミングで帯も切り替わる）。
   */
  apply(
    base: FeatureCollection,
    colors: Record<string, string>,
    overrides: SuzerainOverrides,
    selectedPowerKey: string | null,
    hoveredPowerKey: string | null,
  ): void;
  /** 直近に反映した描画データ（デバッグ・テスト用の読み取り専用） */
  data(): FeatureCollection;
}

/** 沿岸補完の同期ハンドルを生成し、styledata 購読を組み立てる（#305） */
export function createCoastalFillSync(
  deps: CoastalFillSyncDeps,
): CoastalFillSyncHandle {
  /**
   * 沿岸 run 抽出のメモ化（TASK-50/136 の参照同値契約）。base / colors /
   * overrides は year 切替・起動ロード時にだけ参照が変わり、hover・選択・
   * ズーム段の変化では同じ参照が渡り続けて再計算しない。
   */
  const memoizedCoastalFillData = memoizeLatest(buildCoastalFillData);

  /** 直近に反映した描画データ（スタイル差し替え後の再登録用） */
  let coastalFillData: FeatureCollection = EMPTY_COASTAL_FILL_DATA;

  /** いま点灯させたい強調キー（apply が確定する） */
  let desiredActiveKeys: readonly string[] = [];

  /** 直近に setFeatureState 済みのキー（差分消灯用） */
  let appliedActiveKeys: readonly string[] = [];

  function sync(): void {
    try {
      const styleLayerIds = deps.getStyleLayerIds();
      if (styleLayerIds.length === 0) return;
      const beforeId = coastalFillBeforeId(styleLayerIds);
      // 水面レイヤーが無いスタイル（フォールバック）ではマスクが効かず帯が
      // 海上に浮くため、source ごと追加しない（従来表示に縮退）
      if (beforeId === null) return;
      const source = deps.getSource(COASTAL_FILL_SOURCE_ID);
      if (source === undefined) {
        deps.addSource(
          COASTAL_FILL_SOURCE_ID,
          coastalFillSourceSpec(
            coastalFillData,
          ) as unknown as GeoJSONSourceSpecification,
        );
      } else {
        (source as GeoJSONSource).setData(coastalFillData);
      }
      if (deps.getLayer(COASTAL_FILL_LAYER_ID) === undefined) {
        deps.addLayer(
          coastalFillLayerSpec() as unknown as LayerSpecification,
          beforeId,
        );
      }
      // 強調 feature-state の差分反映。スタイル差し替えで state は消えるため、
      // 現在キーの点灯は毎回行う（冪等）。消灯は前回適用分との差分だけでよい。
      for (const key of appliedActiveKeys) {
        if (!desiredActiveKeys.includes(key)) {
          deps.removeFeatureState({ source: COASTAL_FILL_SOURCE_ID, id: key });
        }
      }
      for (const key of desiredActiveKeys) {
        deps.setFeatureState(
          { source: COASTAL_FILL_SOURCE_ID, id: key },
          { active: true },
        );
      }
      appliedActiveKeys = desiredActiveKeys;
    } catch (error) {
      deps.warn(`沿岸補完レイヤーの反映に失敗しました: ${String(error)}`);
    }
  }

  function apply(
    base: FeatureCollection,
    colors: Record<string, string>,
    overrides: SuzerainOverrides,
    selectedPowerKey: string | null,
    hoveredPowerKey: string | null,
  ): void {
    coastalFillData = memoizedCoastalFillData(base, colors, overrides);
    desiredActiveKeys = [
      ...new Set(
        [selectedPowerKey, hoveredPowerKey].filter(
          (key): key is string => key !== null,
        ),
      ),
    ];
    sync();
  }

  deps.onStyleData(sync);

  return { sync, apply, data: () => coastalFillData };
}
