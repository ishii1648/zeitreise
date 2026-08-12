/**
 * ローディング/エラー UI の DOM 非依存な状態機械（純粋ロジック）。
 * 参照仕様: docs/app-spec.md §5.4
 *
 * 年代 GeoJSON の取得は複数年代が並行しうる（スライダーの高速操作）。
 * ここでは「進行中の年代集合」と「失敗した年代集合」だけを保持し、
 * - スピナー表示 = 進行中が 1 つ以上
 * - エラートースト表示 = 失敗した年代が 1 つ以上（＝再試行対象がある）
 * を導出する。DOM や fetch には一切依存しないので単体テストしやすい。
 *
 * 状態遷移はすべて新しい state を返す純粋関数にして、UI 側は「最新 state を
 * 受け取って描画するだけ」に保つ（元の state は破壊しない）。
 */

/** ローディング/エラーの状態。loading と failed は互いに素に保たれる */
export interface LoadingState {
  /** 取得が進行中の年代 */
  readonly loading: ReadonlySet<number>;
  /** 取得に失敗し再試行できる年代 */
  readonly failed: ReadonlySet<number>;
  /**
   * deck.gl チャンク（#247 で分割した src/deck_app.ts）のロードに失敗したか
   * （#319）。年代に紐づかない単発の致命的失敗なので、年代集合とは別に持つ。
   * 同一文書では自力復帰できない（失敗した動的 import は module map に記録
   * され再フェッチされない）ため、再試行ではなく再読み込みへ誘導する。
   */
  readonly chunkFailed: boolean;
}

/** 空の初期状態を作る */
export function createLoadingState(): LoadingState {
  return { loading: new Set(), failed: new Set(), chunkFailed: false };
}

/** loading から year を除いた新しい Set を作る（変更が無ければ同一参照でも良いが常に複製） */
function withoutFrom(set: ReadonlySet<number>, year: number): Set<number> {
  const next = new Set(set);
  next.delete(year);
  return next;
}

/** set に year を足した新しい Set を作る */
function withFrom(set: ReadonlySet<number>, year: number): Set<number> {
  const next = new Set(set);
  next.add(year);
  return next;
}

/**
 * year の取得を開始する（＝進行中に載せる）。
 * 再試行の起点でもあるため、失敗集合からは取り除く（再試行中はエラーを消す）。
 */
export function startLoading(state: LoadingState, year: number): LoadingState {
  return {
    loading: withFrom(state.loading, year),
    failed: withoutFrom(state.failed, year),
    chunkFailed: state.chunkFailed,
  };
}

/** year の取得が成功した（進行中・失敗の両方から取り除く） */
export function succeedLoading(
  state: LoadingState,
  year: number,
): LoadingState {
  return {
    loading: withoutFrom(state.loading, year),
    failed: withoutFrom(state.failed, year),
    chunkFailed: state.chunkFailed,
  };
}

/** year の取得が失敗した（進行中から外し、再試行対象＝失敗集合に載せる） */
export function failLoading(state: LoadingState, year: number): LoadingState {
  return {
    loading: withoutFrom(state.loading, year),
    failed: withFrom(state.failed, year),
    chunkFailed: state.chunkFailed,
  };
}

/**
 * deck.gl チャンクのロードが失敗した（#319）。年代に紐づかないので進行中・
 * 失敗年代の集合には触れず、致命フラグだけを立てる（冪等）。
 */
export function failChunkLoad(state: LoadingState): LoadingState {
  return { loading: state.loading, failed: state.failed, chunkFailed: true };
}

/**
 * エラー表示を明示的に閉じる（失敗集合をクリアする）。
 * 進行中のロードには手を触れない（＝スピナー状態は維持）。再試行はしない。
 */
export function clearErrors(state: LoadingState): LoadingState {
  return { loading: state.loading, failed: new Set(), chunkFailed: false };
}

/** スピナーを表示すべきか（進行中の年代が 1 つ以上） */
export function isSpinnerVisible(state: LoadingState): boolean {
  return state.loading.size > 0;
}

/**
 * エラートーストを表示すべきか（失敗した年代が 1 つ以上、または deck.gl
 * チャンクのロードに失敗した。#319）
 */
export function hasError(state: LoadingState): boolean {
  return state.failed.size > 0 || state.chunkFailed;
}

/**
 * deck.gl チャンクのロード失敗を告知すべきか（#319）。年代データの失敗より
 * 重い（オーバーレイが一切出ない）ので、トーストの文言はこちらを優先する。
 */
export function hasChunkError(state: LoadingState): boolean {
  return state.chunkFailed;
}

/** 再試行対象の年代を昇順で返す（純粋・毎回新しい配列） */
export function failedYears(state: LoadingState): number[] {
  return [...state.failed].sort((a, b) => a - b);
}
