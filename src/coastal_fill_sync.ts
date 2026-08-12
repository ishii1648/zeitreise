/**
 * 沿岸補完の MapLibre 同期（Issue #305 / #312。approximate_border_sync.ts と
 * 同型）。
 *
 * 沿岸補完の帯（coastal_fill.ts）は MapLibre の fill レイヤー 1 枚で描く
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
 *
 * #312: 帯のジオメトリ生成（ポリゴン差分）は 1 年あたり 0.5 秒級の CPU を
 * 使うため、apply では即時に走らせず deps.defer（既定 setTimeout 0）へ
 * 逃がす。年切替の描画（塗り・境界・ラベル）は従来どおりの速さで終わり、
 * 帯だけが 1 タスク遅れて追いつく。強調 feature-state とスタイルへの
 * 再登録は apply の中で即時に行う。
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
import { createYearCache, YEAR_CACHE_MAX_YEARS } from "./powers.ts";

/**
 * 帯 FeatureCollection を保持する年代数（#312）。
 *
 * 年代 GeoJSON のローダ自身が LRU 4 年（powers.ts YEAR_CACHE_MAX_YEARS）で、
 * そこから追い出された年は再 fetch で別インスタンスになり参照同値が崩れる =
 * どのみち作り直しになる。よってここを 4 年より大きくしても当たらないので、
 * 同じ値に揃える。
 *
 * メモリ試算: 帯 1 年分の JSON 表現は実測 310〜445 KB（全 19 年代の平均
 * ≈ 370 KB）。パース済みオブジェクトは概ねその 2〜3 倍を見込むので、
 * 4 年で **約 3〜4 MB**。年代 GeoJSON 本体（1 年 9 本 × 4 年）と同じ桁の
 * 中では小さく、既存の LRU 方針の範囲に収まる。
 */
export const COASTAL_FILL_CACHE_MAX_YEARS = YEAR_CACHE_MAX_YEARS;

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
  /**
   * 帯ジオメトリの生成を「年切替の描画が終わった後」へ回すためのスケジューラ
   * （#312。既定は setTimeout 0）。
   *
   * 帯はポリゴン差分で作るため 1 年あたり 0.5 秒級の CPU を使う（#305 の
   * line-offset は数 ms だった）。renderLayers の中で同期に回すと年切替が
   * 実測 90ms → 620ms に伸びるので、塗り・ラベルの描画を先に通し、帯の計算は
   * その直後の空きタスクで行う。テストからは同期実行の関数を注入して
   * 決定的に検証する。
   */
  defer?: (task: () => void) => void;
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
    year: number,
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

  /**
   * 年代ごとの帯 FeatureCollection の LRU（#312）。
   *
   * memoizeLatest は「直前の 1 組」しか覚えないため、1900 → 1914 → 1900 と
   * 年を行き来すると戻りで毎回 0.5 秒級の再計算が走る。帯の生成は
   * ポリゴン差分（polyclip）で重いので、年代キーで保持して往復をヒットさせる。
   *
   * キーは年だけでは足りない。同じ年でも、ローダの LRU
   * （powers.ts YEAR_CACHE_MAX_YEARS = 4）から追い出されて再 fetch された
   * 年代 GeoJSON は**別インスタンス**になり、colors / overrides も
   * 起動直後に差し替わりうる。よって保持した入力 3 つの**参照同値**が
   * 崩れていたらヒットさせず作り直す（既存の memoizeLatest と同じ契約）。
   * 逆に、ローダが同じ年を保持している間は同一インスタンスが返る契約
   * （suzerain_extent.ts withSuzerainOverrides）なので、往復は必ずヒットする。
   */
  const yearCache = createYearCache<{
    base: FeatureCollection;
    colors: Record<string, string>;
    overrides: SuzerainOverrides;
    data: FeatureCollection;
  }>(COASTAL_FILL_CACHE_MAX_YEARS);

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

  /** 次に帯を作り直す入力（最後の apply が勝つ。年を素早く送っても 1 回で済む） */
  let pending:
    | {
      base: FeatureCollection;
      year: number;
      colors: Record<string, string>;
      overrides: SuzerainOverrides;
    }
    | null = null;
  /** defer 済みのタスクが未実行かどうか（多重予約を防ぐ） */
  let scheduled = false;
  /**
   * 既定のスケジューラ: 次のフレームを描いた「後」の空きタスクで走らせる。
   * requestAnimationFrame のコールバックは描画の直前に呼ばれるので、その中で
   * setTimeout を張ると「塗り・ラベルが画面に出てから帯を作る」順になる。
   */
  const defer = deps.defer ?? ((task: () => void) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => setTimeout(task, 0));
    } else {
      setTimeout(task, 0);
    }
  });

  /**
   * 年代 LRU から帯を取り出す。入力 3 つの参照が保持時と同じでなければ
   * ヒットさせない（年代 GeoJSON の再 fetch・colors / overrides の差し替えで
   * 古い帯を出さないため）。
   */
  function cachedDataFor(
    base: FeatureCollection,
    year: number,
    colors: Record<string, string>,
    overrides: SuzerainOverrides,
  ): FeatureCollection | undefined {
    const entry = yearCache.get(year);
    if (entry === undefined) return undefined;
    if (
      entry.base !== base || entry.colors !== colors ||
      entry.overrides !== overrides
    ) return undefined;
    return entry.data;
  }

  function buildPending(): void {
    scheduled = false;
    if (pending === null) return;
    const { base, year, colors, overrides } = pending;
    pending = null;
    try {
      const data = memoizedCoastalFillData(base, colors, overrides);
      yearCache.set(year, { base, colors, overrides, data });
      coastalFillData = data;
    } catch (error) {
      deps.warn(`沿岸補完の帯の生成に失敗しました: ${String(error)}`);
      return;
    }
    sync();
  }

  function apply(
    base: FeatureCollection,
    year: number,
    colors: Record<string, string>,
    overrides: SuzerainOverrides,
    selectedPowerKey: string | null,
    hoveredPowerKey: string | null,
  ): void {
    desiredActiveKeys = [
      ...new Set(
        [selectedPowerKey, hoveredPowerKey].filter(
          (key): key is string => key !== null,
        ),
      ),
    ];
    // 保持済みの年ならその場で差し替える（再計算なし = 年の往復が 0ms）。
    // defer の予約も取り消す必要はない: pending を消せば空振りして終わる。
    const cached = cachedDataFor(base, year, colors, overrides);
    if (cached !== undefined) {
      coastalFillData = cached;
      pending = null;
      sync();
      return;
    }
    pending = { base, year, colors, overrides };
    if (!scheduled) {
      scheduled = true;
      defer(buildPending);
    }
    // 強調（feature-state）とスタイルへの再登録は即時に反映する。帯の
    // ジオメトリだけが 1 タスク遅れて追いつく
    sync();
  }

  deps.onStyleData(sync);

  return { sync, apply, data: () => coastalFillData };
}
