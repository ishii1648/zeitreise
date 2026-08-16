/** 起動に必要な HTTP 取得を有限時間で成功または失敗へ収束させる。 */

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface FetchRetryPolicy {
  /** 1 回の試行に与える時間。 */
  readonly timeoutMs: number;
  /** 初回を含む最大試行回数。 */
  readonly maxAttempts: number;
  /** 再試行前の待機時間。 */
  readonly retryDelayMs: number;
}

/**
 * 初期表示の必須リソース用予算。通常時は待機を増やさず、保留時だけ
 * 10 秒 × 2 試行 + 250ms で必ず終端へ移る。
 */
export const STARTUP_FETCH_POLICY: FetchRetryPolicy = {
  timeoutMs: 10_000,
  maxAttempts: 2,
  retryDelayMs: 250,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutError(url: string, timeoutMs: number): Error {
  return new Error(`${url} の取得が ${timeoutMs}ms でタイムアウトしました`);
}

/**
 * fetch を timeout と限定回数 retry で包む。HTTP 408/429/5xx とネットワーク例外、
 * 応答保留を再試行し、それ以外の HTTP 応答は呼び出し側へそのまま返す。
 */
export async function fetchWithRetry(
  url: string,
  fetchFn: FetchLike = fetch,
  policy: FetchRetryPolicy = STARTUP_FETCH_POLICY,
): Promise<Response> {
  if (policy.maxAttempts < 1) {
    throw new Error("maxAttempts は 1 以上が必要です");
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(timeoutError(url, policy.timeoutMs));
        }, policy.timeoutMs);
      });
      const response = await Promise.race([
        fetchFn(url, { signal: controller.signal }),
        timeout,
      ]);
      if (
        response.status !== 408 && response.status !== 429 &&
        response.status < 500
      ) {
        return response;
      }
      lastError = new Error(`status ${response.status}`);
    } catch (error) {
      lastError = error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (attempt < policy.maxAttempts && policy.retryDelayMs > 0) {
      await delay(policy.retryDelayMs);
    }
  }
  throw lastError;
}
