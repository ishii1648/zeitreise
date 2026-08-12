/**
 * loading.ts（src/ui/）のユニットテスト（TASK-146）。
 *
 * 検証する契約:
 * - setupLoadingUI がハンドル（render）を返し、要素欠如時は warn（文言固定）
 *   を出して no-op ハンドルへ縮退すること
 * - 表示可否が loading_state の状態機械から導出されること（スピナー =
 *   進行中あり、トースト = 失敗年代あり。文言は「N・M 年の…」形式で固定）
 * - 再試行 / 閉じるはコールバック注入（状態の所有と switchYear は main.ts
 *   側に残る）で、click がそのまま委譲されること
 */
import { assert, assertEquals, assertFalse } from "@std/assert";
import { setupLoadingUI } from "./loading.ts";
import {
  createLoadingState,
  failChunkLoad,
  failLoading,
  startLoading,
} from "../loading_state.ts";
import { captureWarns, FakeDocument } from "./fake_dom.ts";

function setup(initialState = createLoadingState()) {
  const doc = new FakeDocument();
  const spinner = doc.addElement("loading-spinner");
  const toast = doc.addElement("error-toast");
  const toastMessage = doc.addElement("error-toast-message");
  const retryBtn = doc.addElement("error-toast-retry");
  const closeBtn = doc.addElement("error-toast-close");
  const retries: number[] = [];
  const closes: number[] = [];
  const handle = setupLoadingUI({
    doc,
    initialState,
    onRetry: () => retries.push(1),
    onClose: () => closes.push(1),
  });
  return {
    doc,
    spinner,
    toast,
    toastMessage,
    retryBtn,
    closeBtn,
    retries,
    closes,
    handle,
  };
}

Deno.test("要素欠如時は warn を出して no-op ハンドルを返す（文言固定）", () => {
  const doc = new FakeDocument();
  const { value: handle, warns } = captureWarns(() =>
    setupLoadingUI({
      doc,
      initialState: createLoadingState(),
      onRetry: () => {},
      onClose: () => {},
    })
  );
  assertEquals(warns, [
    "ローディング/エラー UI 要素が見つからないため配線をスキップします",
  ]);
  handle.render(createLoadingState());
});

Deno.test("配線直後に初期状態を描画する（進行なし = スピナーもトーストも隠す）", () => {
  const { spinner, toast } = setup();
  assert(spinner.hidden);
  assert(toast.hidden);
});

Deno.test("進行中のロードがある間だけスピナーを表示する", () => {
  const { spinner, handle } = setup();
  const state = startLoading(createLoadingState(), 1200);
  handle.render(state);
  assertFalse(spinner.hidden);
  handle.render(createLoadingState());
  assert(spinner.hidden);
});

Deno.test("失敗年代があればトーストを表示する（文言は「N・M 年の…」で固定）", () => {
  const { toast, toastMessage, handle } = setup();
  const state = failLoading(
    failLoading(createLoadingState(), 1000),
    1100,
  );
  handle.render(state);
  assertFalse(toast.hidden);
  assertEquals(
    toastMessage.textContent,
    "1000・1100 年の地図データ取得に失敗しました",
  );
});

Deno.test("失敗が解消したらトーストを隠す", () => {
  const { toast, handle } = setup();
  handle.render(failLoading(createLoadingState(), 1000));
  assertFalse(toast.hidden);
  handle.render(createLoadingState());
  assert(toast.hidden);
});

// ---- deck.gl チャンクのロード失敗（#319）----

Deno.test("チャンク失敗は再読み込みを促すトーストを出す（#319）", () => {
  const { toast, toastMessage, retryBtn, handle } = setup();
  handle.render(failChunkLoad(createLoadingState()));
  assertFalse(toast.hidden);
  assertEquals(
    toastMessage.textContent,
    "地図オーバーレイの読み込みに失敗しました。ページを再読み込みしてください",
  );
  // 年代の再取得ではなく再読み込みなので、ボタンの文言も差し替える
  assertEquals(retryBtn.textContent, "再読み込み");
  // ヘッドレス検証（scripts/verify/cdp.ts）が種別で分岐できるよう属性で公開する
  assertEquals(toast.attributes.get("data-error-kind"), "chunk");
});

Deno.test("チャンク失敗は年代の失敗より優先して告知する（#319）", () => {
  const { toastMessage, handle } = setup();
  handle.render(failChunkLoad(failLoading(createLoadingState(), 1000)));
  assertEquals(
    toastMessage.textContent,
    "地図オーバーレイの読み込みに失敗しました。ページを再読み込みしてください",
  );
});

Deno.test("年代の失敗トーストは従来どおり種別 data を持たない（#319）", () => {
  const { toast, retryBtn, handle } = setup();
  handle.render(failLoading(createLoadingState(), 1000));
  assertEquals(toast.attributes.get("data-error-kind"), "data");
  assertEquals(retryBtn.textContent, "再試行");
});

Deno.test("チャンク失敗が解消したらトーストとボタン文言が戻る（#319）", () => {
  const { toast, retryBtn, handle } = setup();
  handle.render(failChunkLoad(createLoadingState()));
  assertEquals(retryBtn.textContent, "再読み込み");
  handle.render(createLoadingState());
  assert(toast.hidden);
  assertEquals(retryBtn.textContent, "再試行");
});

Deno.test("再試行 / 閉じるの click は注入コールバックへ委譲する", () => {
  const { retryBtn, closeBtn, retries, closes } = setup();
  retryBtn.click();
  assertEquals(retries.length, 1);
  assertEquals(closes.length, 0);
  closeBtn.click();
  assertEquals(closes.length, 1);
});
