/**
 * 沿岸補完の MapLibre 同期（Issue #305 / #312。approximate_border_sync.ts と
 * 同型）。
 *
 * 沿岸補完の帯（coastal_fill.ts）は MapLibre の fill レイヤー 1 枚で描く
 * スタイル側の状態なので、スタイルが変わるたびに「存在するか」を確認して
 * 追いつかせる。挿入位置は内水面（water-inland）の直下で固定
 * （coastalFillBeforeId）。概略境界と違い deck レイヤーとの相対順には
 * 関与しない（帯は政治ポリゴンより常に下 = 内水面より下）。
 *
 * #330: それでも renderLayers への逆参照（requestRender）は持つ。帯の幾何は
 * 勢力圏の外枠（hre-extent）の union 入力でもあり（extentBands）、年代
 * GeoJSON より後から届くため、確定した時点で外枠を組み直させる必要がある。
 * 呼ぶのは幾何が新しくなったときだけなので、renderLayers → apply → sync の
 * 往復は 1 回で収束する。
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
 *
 * #326: defer はブロックの発生を**遅らせるだけ**で、初訪問の年ごとに
 * 0.46〜0.72 秒メインスレッドが止まる事実は変わらなかった（本番実測
 * 664/713/859ms）。そこで帯の幾何はビルド時に作って配信し
 * （scripts/build-coastal-fill.ts → `/data/coastal_fill_<year>.geojson`）、
 * ランタイムは deps.loadBands で取得して色を載せるだけにする（実測 1ms 未満）。
 * defer 経路は「事前生成データが取れない・年代 GeoJSON と対応しない」ときの
 * 縮退経路として残す。
 */
import type {
  GeoJSONSource,
  GeoJSONSourceSpecification,
  LayerSpecification,
} from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import {
  buildCoastalFillBands,
  COASTAL_FILL_SOURCE_ID,
  coastalBandsForSuzerain,
  coastalFillBeforeId,
  coastalFillDataFromBands,
  coastalFillLayerSpec,
  coastalFillSourceSpec,
  EMPTY_COASTAL_FILL_DATA,
} from "./coastal_fill.ts";
import { COASTAL_FILL_LAYER_ID } from "./basemap.ts";
import type {
  SuzerainExtentBands,
  SuzerainOverrides,
} from "./suzerain_extent.ts";
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
  /**
   * 事前生成した帯の幾何（`/data/coastal_fill_<year>.geojson`）を取得する
   * （#326。省略時は従来どおり毎回 defer 経由で実行時生成する）。
   *
   * 生成は `deno task build-coastal-fill` がビルド時に行い、ランタイムは
   * 色を載せるだけ（実測 1ms 未満）になる。取得失敗・base との添字不一致
   * （配信データと年代 GeoJSON の組の食い違い）のときは warn を出して
   * 実行時生成へ縮退する（データ系ローダと同じ「warn + フォールバックで
   * 継続」の契約）。
   */
  loadBands?: (year: number) => Promise<FeatureCollection>;
  /**
   * deck レイヤーの作り直し（main.ts renderLayers）。帯の幾何が**新しく
   * 確定したとき**だけ呼ぶ（#330）。
   *
   * 帯は年代 GeoJSON より後から届くため、届いた時点では勢力圏の外枠
   * （political_layers.ts buildSuzerainExtentLayer）が帯抜きの形で組まれて
   * いる。ここで作り直しを促すことで、外枠がその年の帯を取り込んだ形へ
   * 追いつく。既に反映済みの帯（LRU ヒット）では呼ばないので、
   * renderLayers → apply → sync の往復は 1 回で収束する。
   */
  requestRender?: () => void;
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
  /**
   * 反映済みの帯の**幾何**と、それが対応する base（#330）。勢力圏の外枠が
   * union の入力に使う（political_layers.ts PoliticalLayerContext.coastalBands）。
   *
   * null を返すのは
   * - まだ帯を確定していない（取得中・実行時生成の defer 待ち）
   * - 帯を出せないスタイル（水面レイヤーが無いフォールバック。sync が
   *   source ごと追加しないので、画面にも帯は無い）
   * のいずれか。どちらも「帯が描かれていない」状態なので、外枠も従来どおり
   * 元ポリゴンだけで組むのが正しい。
   */
  extentBands(): SuzerainExtentBands | null;
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
  const memoizedCoastalFillBands = memoizeLatest(buildCoastalFillBands);

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
    /** #330: 色を載せる前の幾何（勢力圏の外枠の union 入力になる） */
    bands: FeatureCollection;
  }>(COASTAL_FILL_CACHE_MAX_YEARS);

  /** 直近に反映した描画データ（スタイル差し替え後の再登録用） */
  let coastalFillData: FeatureCollection = EMPTY_COASTAL_FILL_DATA;

  /**
   * 直近に反映した帯の幾何と、その元になった base（#330）。extentBands() が
   * 勢力圏の外枠へ渡す。描画データ（coastalFillData）と違い色を持たないので、
   * 事前生成データ・実行時生成のどちらの経路でも同じ形になる。
   */
  let appliedBands:
    | { base: FeatureCollection; bands: FeatureCollection }
    | null = null;

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
  function cachedEntryFor(
    base: FeatureCollection,
    year: number,
    colors: Record<string, string>,
    overrides: SuzerainOverrides,
  ): { data: FeatureCollection; bands: FeatureCollection } | undefined {
    const entry = yearCache.get(year);
    if (entry === undefined) return undefined;
    if (
      entry.base !== base || entry.colors !== colors ||
      entry.overrides !== overrides
    ) return undefined;
    return entry;
  }

  /**
   * 確定した帯（幾何 + 色付き描画データ）を反映し、スタイルへ同期する。
   * 幾何が新しくなったときだけ requestRender を呼び、勢力圏の外枠へ
   * 追いつかせる（#330）。
   */
  function commit(
    base: FeatureCollection,
    year: number,
    colors: Record<string, string>,
    overrides: SuzerainOverrides,
    bands: FeatureCollection,
    data: FeatureCollection,
  ): void {
    const changed = appliedBands === null || appliedBands.base !== base ||
      appliedBands.bands !== bands;
    yearCache.set(year, { base, colors, overrides, data, bands });
    coastalFillData = data;
    appliedBands = { base, bands };
    sync();
    if (changed) deps.requestRender?.();
  }

  function buildPending(): void {
    scheduled = false;
    if (pending === null) return;
    const { base, year, colors, overrides } = pending;
    pending = null;
    let built: { bands: FeatureCollection; data: FeatureCollection };
    try {
      const bands = memoizedCoastalFillBands(base);
      const data = coastalFillDataFromBands(base, bands, colors, overrides);
      // 幾何が自前（buildCoastalFillBands）なので添字の不一致は起こり得ない
      if (data === null) throw new Error("帯の添字が base と対応していません");
      built = { bands, data };
    } catch (error) {
      deps.warn(`沿岸補完の帯の生成に失敗しました: ${String(error)}`);
      return;
    }
    commit(base, year, colors, overrides, built.bands, built.data);
  }

  /** 実行時生成（重い）を描画後の空きタスクへ予約する（#312 の従来経路） */
  function scheduleBuild(): void {
    if (scheduled) return;
    scheduled = true;
    defer(buildPending);
  }

  /**
   * 進行中の要求の世代番号（#326）。事前生成データの取得は非同期なので、
   * 解決までに年が進んでいたら（= 番号が変わっていたら）結果を捨てる。
   * 最後の apply が勝つ点は defer 経路（pending）と同じ。
   */
  let requestGeneration = 0;

  /**
   * 事前生成した帯を取得して色を載せる（#326）。取得失敗・添字不一致は
   * warn を出して実行時生成へ縮退する。
   */
  function requestPrebuilt(
    loadBands: (year: number) => Promise<FeatureCollection>,
    base: FeatureCollection,
    year: number,
    colors: Record<string, string>,
    overrides: SuzerainOverrides,
  ): void {
    const generation = ++requestGeneration;
    loadBands(year).then((bands) => {
      if (generation !== requestGeneration) return;
      const data = coastalFillDataFromBands(base, bands, colors, overrides);
      if (data === null) {
        throw new Error(
          `事前生成の帯が年代 GeoJSON と対応していません（year=${year}）`,
        );
      }
      pending = null;
      commit(base, year, colors, overrides, bands, data);
    }).catch((error: unknown) => {
      if (generation !== requestGeneration) return;
      deps.warn(
        `事前生成の沿岸補完データを使えないため実行時に生成します: ${
          String(error)
        }`,
      );
      scheduleBuild();
    });
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
    const cached = cachedEntryFor(base, year, colors, overrides);
    if (cached !== undefined) {
      coastalFillData = cached.data;
      appliedBands = { base, bands: cached.bands };
      pending = null;
      // 事前生成データの取得が飛んでいたら、その結果で上書きされないよう
      // 世代を進めて無効化する
      requestGeneration++;
      sync();
      return;
    }
    pending = { base, year, colors, overrides };
    if (deps.loadBands === undefined) {
      scheduleBuild();
    } else {
      // #326: 事前生成の帯（幾何）を取りに行く。取得できれば色を載せるだけで
      // 済み、メインスレッドを止めない。失敗時のみ実行時生成へ縮退する
      requestPrebuilt(deps.loadBands, base, year, colors, overrides);
    }
    // 強調（feature-state）とスタイルへの再登録は即時に反映する。帯の
    // ジオメトリだけが遅れて追いつく
    sync();
  }

  /**
   * 勢力圏の外枠へ渡す帯（#330）。帯を描けないスタイル（水面レイヤーが無い
   * フォールバック）では sync が source ごと追加しない = 画面に帯が無いため、
   * 外枠にも合流させない（外枠だけが 30km 外へ広がる状態を作らない。AC6）。
   */
  function extentBands(): SuzerainExtentBands | null {
    if (appliedBands === null) return null;
    // スタイル未読込（空配列）も含めて「いま帯を挿せない」なら合流させない
    if (coastalFillBeforeId(deps.getStyleLayerIds()) === null) return null;
    return {
      base: appliedBands.base,
      bands: appliedBands.bands,
      select: coastalBandsForSuzerain,
    };
  }

  deps.onStyleData(sync);

  return { sync, apply, data: () => coastalFillData, extentBands };
}
