import { assertEquals, assertRejects } from "@std/assert";
import { fetchWithRetry } from "./fetch_retry.ts";

const NO_DELAY = { timeoutMs: 20, maxAttempts: 2, retryDelayMs: 0 };

Deno.test("fetchWithRetry は一過性の 503 を限定回数内で再試行する", async () => {
  let calls = 0;
  const response = await fetchWithRetry(
    "/data/colors.json",
    () => {
      calls++;
      return Promise.resolve(
        calls === 1
          ? new Response("busy", { status: 503 })
          : new Response("{}", { status: 200 }),
      );
    },
    NO_DELAY,
  );
  assertEquals(response.status, 200);
  assertEquals(calls, 2);
});

Deno.test("fetchWithRetry は未解決 fetch も有限時間で失敗へ収束する", async () => {
  let calls = 0;
  const started = performance.now();
  await assertRejects(
    () =>
      fetchWithRetry(
        "/manifest.json",
        () => {
          calls++;
          return new Promise<Response>(() => {});
        },
        NO_DELAY,
      ),
    Error,
    "タイムアウト",
  );
  assertEquals(calls, 2);
  if (performance.now() - started > 500) {
    throw new Error("未解決 fetch の待機予算を超えました");
  }
});

Deno.test("fetchWithRetry は 404 を再試行せず呼び出し側へ返す", async () => {
  let calls = 0;
  const response = await fetchWithRetry(
    "/missing.json",
    () => {
      calls++;
      return Promise.resolve(new Response("missing", { status: 404 }));
    },
    NO_DELAY,
  );
  assertEquals(response.status, 404);
  assertEquals(calls, 1);
});
