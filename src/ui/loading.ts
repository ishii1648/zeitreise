/**
 * スピナーとエラートースト（TASK-9, docs/app-spec.md §5.4）の DOM 配線
 * （TASK-146 で main.ts から抽出）。
 *
 * 表示可否は loading_state の状態機械から導出し、このモジュールは描画に
 * 徹する。
 * - スピナー: 進行中のロードが 1 つ以上ある間だけ表示（キャッシュヒットでは
 *   出ない）
 * - トースト: 失敗した年代があれば表示し、「再試行」で失敗年代を再取得、
 *   「閉じる」で消す
 * - トースト（#319）: deck.gl チャンクのロードに失敗した場合は、年代データの
 *   失敗より優先して「再読み込みを促す」文言を出す。同一文書では復帰できない
 *   （失敗した動的 import は再フェッチされない）ため、ボタンの実体も年代の
 *   再取得ではなくページの再読み込みになる（動作の注入は main.ts の onRetry）。
 *   失敗の種別は `data-error-kind` 属性で公開し、ヘッドレス検証
 *   （scripts/verify/cdp.ts）が「再 navigate で復帰し得る停止」と「アプリの
 *   確定失敗」を区別できるようにする。
 *
 * decision-29 の方針どおり module-scope の可変状態は持たない。ロード状態
 * （loadingState）の所有と遷移は main.ts に残し、再試行 / 閉じるの動作は
 * コールバック注入（onRetry / onClose。switchYear への循環 import 回避）、
 * 反映は返却ハンドルの render(state) で受ける。従来の「renderLoadingUI
 * フックへ実体を差し込む」パターンの置き換え。DOM 要素欠如時は warn を
 * 出して no-op ハンドルへ縮退する（契約維持）。
 */
import {
  failedYears,
  hasChunkError,
  hasError,
  hasStartupError,
  isSpinnerVisible,
  type LoadingState,
} from "../loading_state.ts";
import type { UiDocument } from "./dom.ts";

/** スピナー要素の最小形（HTMLElement が満たす） */
interface HidableElement {
  hidden: boolean;
}

/**
 * トースト要素の最小形。#319: ヘッドレス検証（scripts/verify/cdp.ts）が
 * 失敗の種別で分岐できるよう `data-error-kind` を属性で公開する。
 */
interface ToastElement extends HidableElement {
  setAttribute(name: string, value: string): void;
}

/** トースト本文の最小形 */
interface MessageElement {
  textContent: string | null;
}

/** 再試行 / 閉じるボタンの最小形（HTMLButtonElement が満たす） */
interface ButtonElement {
  /** #319: 失敗の種別で文言を「再試行」/「再読み込み」に切り替える */
  textContent: string | null;
  addEventListener(type: "click", listener: () => void): void;
}

/**
 * deck.gl チャンクのロード失敗（#319）の文言。年代データの失敗と違い同一文書
 * では復帰できない（失敗した動的 import は再フェッチされない）ので、再試行では
 * なくページの再読み込みへ誘導する。
 */
const CHUNK_ERROR_MESSAGE =
  "地図オーバーレイの読み込みに失敗しました。ページを再読み込みしてください";

const STARTUP_ERROR_MESSAGE =
  "地図の色データを読み込めませんでした。ページを再読み込みしてください";

/** 再試行ボタンの文言（index.html の初期値と揃える） */
const RETRY_LABEL = "再試行";

/** チャンク失敗時の再試行ボタン文言（実体はページの再読み込み。#319） */
const RELOAD_LABEL = "再読み込み";

/** setupLoadingUI が返すハンドル。main.ts が最新のロード状態を反映する */
export interface LoadingUiHandle {
  render(state: LoadingState): void;
}

/** setupLoadingUI へ main.ts から注入する依存 */
export interface LoadingUiDeps {
  doc: UiDocument;
  /** 配線直後に描画する初期状態（main.ts 所有の loadingState） */
  initialState: LoadingState;
  /**
   * AC #3: 失敗した年代を再取得する（main.ts は failedYears を switchYear
   * へ流す）。成功すれば hasError が false になりトーストが消える。
   */
  onRetry(): void;
  /** ユーザーが明示的に閉じたら失敗集合をクリアする（再試行はしない） */
  onClose(): void;
}

/** 要素欠如時の縮退用 no-op ハンドル */
const NOOP_LOADING_UI: LoadingUiHandle = {
  render: () => {},
};

/** スピナーとエラートーストの DOM を配線し、描画ハンドルを返す */
export function setupLoadingUI(deps: LoadingUiDeps): LoadingUiHandle {
  const { doc } = deps;
  const spinner = doc.getElementById(
    "loading-spinner",
  ) as HidableElement | null;
  const toast = doc.getElementById("error-toast") as ToastElement | null;
  const toastMessage = doc.getElementById(
    "error-toast-message",
  ) as MessageElement | null;
  const retryBtn = doc.getElementById(
    "error-toast-retry",
  ) as ButtonElement | null;
  const closeBtn = doc.getElementById(
    "error-toast-close",
  ) as ButtonElement | null;
  if (!spinner || !toast || !toastMessage || !retryBtn || !closeBtn) {
    console.warn(
      "ローディング/エラー UI 要素が見つからないため配線をスキップします",
    );
    return NOOP_LOADING_UI;
  }

  const render = (state: LoadingState): void => {
    spinner.hidden = !isSpinnerVisible(state);
    if (!hasError(state)) {
      toast.hidden = true;
      toast.setAttribute("data-error-kind", "none");
      retryBtn.textContent = RETRY_LABEL;
      return;
    }
    // #319: deck.gl チャンクの失敗はオーバーレイが一切出ない致命的な縮退で、
    // 同一文書では復帰できない。年代データの失敗より優先して告知する。
    if (hasChunkError(state)) {
      toastMessage.textContent = CHUNK_ERROR_MESSAGE;
      toast.setAttribute("data-error-kind", "chunk");
      retryBtn.textContent = RELOAD_LABEL;
    } else if (hasStartupError(state)) {
      toastMessage.textContent = STARTUP_ERROR_MESSAGE;
      toast.setAttribute("data-error-kind", "startup");
      retryBtn.textContent = RELOAD_LABEL;
    } else {
      const years = failedYears(state);
      toastMessage.textContent = `${
        years.join("・")
      } 年の地図データ取得に失敗しました`;
      toast.setAttribute("data-error-kind", "data");
      retryBtn.textContent = RETRY_LABEL;
    }
    toast.hidden = false;
  };

  retryBtn.addEventListener("click", deps.onRetry);
  closeBtn.addEventListener("click", deps.onClose);

  render(deps.initialState);

  return { render };
}
