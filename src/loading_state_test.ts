import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  clearErrors,
  createLoadingState,
  failChunkLoad,
  failedYears,
  failLoading,
  hasChunkError,
  hasError,
  isSpinnerVisible,
  type LoadingState,
  startLoading,
  succeedLoading,
} from "./loading_state.ts";

/** 空の初期状態 */
Deno.test("createLoadingState は空でスピナー非表示・エラー無し", () => {
  const s = createLoadingState();
  assertFalse(isSpinnerVisible(s));
  assertFalse(hasError(s));
  assertEquals(failedYears(s), []);
});

Deno.test("startLoading で進行中になりスピナーが表示される", () => {
  const s = startLoading(createLoadingState(), 1200);
  assert(isSpinnerVisible(s));
  assertFalse(hasError(s));
});

Deno.test("succeedLoading で進行中が解消しスピナーが消える", () => {
  let s = startLoading(createLoadingState(), 1200);
  s = succeedLoading(s, 1200);
  assertFalse(isSpinnerVisible(s));
  assertFalse(hasError(s));
});

Deno.test("複数年代の並行ロードは 1 つでも進行中ならスピナー表示", () => {
  let s = createLoadingState();
  s = startLoading(s, 1200);
  s = startLoading(s, 1300);
  assert(isSpinnerVisible(s));
  s = succeedLoading(s, 1200);
  // まだ 1300 が進行中
  assert(isSpinnerVisible(s));
  s = succeedLoading(s, 1300);
  assertFalse(isSpinnerVisible(s));
});

Deno.test("failLoading で進行中から外れエラー扱いになり再試行対象に載る", () => {
  let s = startLoading(createLoadingState(), 1200);
  s = failLoading(s, 1200);
  // 失敗した年代は進行中ではない（スピナーは他に進行中が無ければ消える）
  assertFalse(isSpinnerVisible(s));
  assert(hasError(s));
  assertEquals(failedYears(s), [1200]);
});

Deno.test("失敗した年代を startLoading（再試行）すると失敗集合から外れる", () => {
  let s = startLoading(createLoadingState(), 1200);
  s = failLoading(s, 1200);
  assert(hasError(s));
  // 再試行開始
  s = startLoading(s, 1200);
  assert(isSpinnerVisible(s));
  // 再試行中はエラー表示を消す（失敗集合から外す）
  assertFalse(hasError(s));
  assertEquals(failedYears(s), []);
});

Deno.test("再試行が成功すると通常状態へ復帰する", () => {
  let s = startLoading(createLoadingState(), 1200);
  s = failLoading(s, 1200);
  s = startLoading(s, 1200);
  s = succeedLoading(s, 1200);
  assertFalse(isSpinnerVisible(s));
  assertFalse(hasError(s));
  assertEquals(failedYears(s), []);
});

Deno.test("複数年代が失敗すると全て再試行対象になり昇順で返す", () => {
  let s = createLoadingState();
  s = startLoading(s, 1300);
  s = startLoading(s, 1200);
  s = failLoading(s, 1300);
  s = failLoading(s, 1200);
  assert(hasError(s));
  assertEquals(failedYears(s), [1200, 1300]);
});

Deno.test("同一年代の重複 startLoading は冪等（スピナーは 1 回の succeed で消える）", () => {
  let s = createLoadingState();
  s = startLoading(s, 1200);
  s = startLoading(s, 1200);
  s = succeedLoading(s, 1200);
  assertFalse(isSpinnerVisible(s));
});

Deno.test("clearErrors は失敗集合を消すが進行中は保持する", () => {
  let s = createLoadingState();
  s = startLoading(s, 1300); // 進行中
  s = startLoading(s, 1200);
  s = failLoading(s, 1200); // 1200 失敗、1300 進行中
  assert(hasError(s));
  assert(isSpinnerVisible(s));
  const cleared = clearErrors(s);
  assertFalse(hasError(cleared));
  assertEquals(failedYears(cleared), []);
  // 進行中の 1300 は維持され、スピナーは出たまま
  assert(isSpinnerVisible(cleared));
  // 元 state は不変
  assert(hasError(s));
});

// ---- deck.gl チャンクのロード失敗（#319）----

Deno.test("failChunkLoad はチャンク失敗を載せてエラー表示条件を満たす（#319）", () => {
  const s = failChunkLoad(createLoadingState());
  assert(hasChunkError(s));
  assert(hasError(s));
  // 年代の失敗ではないので再試行対象の年代は増えない
  assertEquals(failedYears(s), []);
});

Deno.test("failChunkLoad は進行中のロードに手を触れない（#319）", () => {
  const s = failChunkLoad(startLoading(createLoadingState(), 1200));
  assert(isSpinnerVisible(s));
  assert(hasChunkError(s));
});

Deno.test("failChunkLoad は冪等で元の state を破壊しない（#319）", () => {
  const base = createLoadingState();
  const once = failChunkLoad(base);
  const twice = failChunkLoad(once);
  assertFalse(hasChunkError(base));
  assert(hasChunkError(twice));
  assertEquals(failedYears(twice), []);
});

Deno.test("clearErrors はチャンク失敗も消す（#319）", () => {
  let s = failChunkLoad(createLoadingState());
  s = failLoading(s, 1200);
  assert(hasError(s));
  const cleared = clearErrors(s);
  assertFalse(hasChunkError(cleared));
  assertFalse(hasError(cleared));
  assertEquals(failedYears(cleared), []);
});

Deno.test("年代の失敗だけではチャンク失敗にならない（#319）", () => {
  const s = failLoading(startLoading(createLoadingState(), 1200), 1200);
  assert(hasError(s));
  assertFalse(hasChunkError(s));
});

Deno.test("startLoading/failLoading は元の state を破壊しない（純粋）", () => {
  const base: LoadingState = createLoadingState();
  const started = startLoading(base, 1200);
  // base は不変
  assertFalse(isSpinnerVisible(base));
  assert(isSpinnerVisible(started));
  const failed = failLoading(started, 1200);
  // started は不変
  assert(isSpinnerVisible(started));
  assertFalse(isSpinnerVisible(failed));
});
