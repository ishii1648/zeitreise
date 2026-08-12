/**
 * deck_chunk.ts のユニットテスト（#319）。
 *
 * 検証する契約:
 * - DI したローダ（＝動的 import の代役）が reject したら onFailure が
 *   ちょうど 1 回呼ばれること（＝ユーザー告知の起点が必ず発火する）
 * - 成功時は onFailure が呼ばれないこと（通常経路の不変。AC3）
 * - 告知が loading_state → src/ui/loading.ts のトーストまで届くこと
 *   （修正前は「通知も復帰も起きない」ので red になる。AC1/AC2）
 */
import { assert, assertEquals, assertFalse } from "@std/assert";
import { watchDeckChunkLoad } from "./deck_chunk.ts";
import {
  createLoadingState,
  failChunkLoad,
  type LoadingState,
} from "./loading_state.ts";
import { setupLoadingUI } from "./ui/loading.ts";
import { FakeDocument } from "./ui/fake_dom.ts";

Deno.test("ローダが reject したら onFailure を 1 回呼ぶ（#319 AC1）", async () => {
  const errors: unknown[] = [];
  await watchDeckChunkLoad({
    load: () => Promise.reject(new Error("chunk 404")),
    onFailure: (error) => errors.push(error),
  });
  assertEquals(errors.length, 1);
  assertEquals(String(errors[0]), "Error: chunk 404");
});

Deno.test("ローダが resolve したら onFailure を呼ばない（#319 AC3）", async () => {
  let called = 0;
  await watchDeckChunkLoad({
    load: () => Promise.resolve({ ok: true }),
    onFailure: () => called++,
  });
  assertEquals(called, 0);
});

Deno.test("チャンク取得失敗はユーザー向けトーストまで届く（#319 AC2）", async () => {
  const doc = new FakeDocument();
  const spinner = doc.addElement("loading-spinner");
  const toast = doc.addElement("error-toast");
  const toastMessage = doc.addElement("error-toast-message");
  doc.addElement("error-toast-retry");
  doc.addElement("error-toast-close");

  // main.ts と同じ形の配線（状態の所有は呼び出し側、UI は render で追従）
  let state: LoadingState = createLoadingState();
  const ui = setupLoadingUI({
    doc,
    initialState: state,
    onRetry: () => {},
    onClose: () => {},
  });
  // 失敗前はトーストが出ていない（＝修正前の「無告知」状態と同じ）
  assert(toast.hidden);

  await watchDeckChunkLoad({
    load: () =>
      Promise.reject(
        new TypeError("Failed to fetch dynamically imported module"),
      ),
    onFailure: () => {
      state = failChunkLoad(state);
      ui.render(state);
    },
  });

  assertFalse(toast.hidden);
  assertEquals(
    toastMessage.textContent,
    "地図オーバーレイの読み込みに失敗しました。ページを再読み込みしてください",
  );
  // オーバーレイが来ないままなのでスピナーは出さない（従来どおり）
  assert(spinner.hidden);
});
