import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  allowsLogicalAssetFallback,
  ASSET_MANIFEST_URL,
  createAssetFetcher,
  loadAssetManifest,
  parseAssetManifest,
  resolveAssetUrl,
} from "./asset_manifest.ts";

// console.warn の呼び出しを捕捉するヘルパ（data_loading_test.ts と同じ方式）
function captureWarn(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  return {
    warnings,
    restore: () => {
      console.warn = original;
    },
  };
}

Deno.test("parseAssetManifest は文字列→文字列のオブジェクトを受理する", () => {
  const manifest = parseAssetManifest({
    "/app.js": "/app.0123456789.js",
    "/data/colors.json": "/data/colors.abcdef0123.json",
  });
  assert(manifest !== null);
  assertEquals(manifest["/app.js"], "/app.0123456789.js");
});

Deno.test("createAssetFetcher は manifest 保留を有限時間・限定回数で reject する", async () => {
  let calls = 0;
  const fetchAsset = createAssetFetcher({
    hostname: "zeitreises.com",
    fetchFn: () => {
      calls++;
      return new Promise<Response>(() => {});
    },
    retryPolicy: { timeoutMs: 10, maxAttempts: 2, retryDelayMs: 0 },
  });
  await assertRejects(
    () => fetchAsset("/data/colors.json"),
    Error,
    "タイムアウト",
  );
  assertEquals(calls, 2);
});

Deno.test("createAssetFetcher は colors の一過性 503 を再試行してハッシュ付き URL から復帰する", async () => {
  const urls: string[] = [];
  let colorsCalls = 0;
  const fetchAsset = createAssetFetcher({
    hostname: "zeitreises.com",
    fetchFn: (url) => {
      urls.push(url);
      if (url === "/manifest.json") {
        return Promise.resolve(
          new Response(JSON.stringify({
            "/data/colors.json": "/data/colors.abcdef.json",
          })),
        );
      }
      colorsCalls++;
      return Promise.resolve(
        colorsCalls === 1
          ? new Response("busy", { status: 503 })
          : new Response("{}", { status: 200 }),
      );
    },
    retryPolicy: { timeoutMs: 20, maxAttempts: 2, retryDelayMs: 0 },
  });
  assertEquals((await fetchAsset("/data/colors.json")).status, 200);
  assertEquals(urls, [
    "/manifest.json",
    "/data/colors.abcdef.json",
    "/data/colors.abcdef.json",
  ]);
});

Deno.test("createAssetFetcher は本番 manifest の欠落を論理パス 404 へ進めない", async () => {
  const urls: string[] = [];
  const fetchAsset = createAssetFetcher({
    hostname: "zeitreises.com",
    fetchFn: (url) => {
      urls.push(url);
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
    retryPolicy: { timeoutMs: 20, maxAttempts: 1, retryDelayMs: 0 },
  });
  await assertRejects(
    () => fetchAsset("/data/colors.json"),
    Error,
    "manifest に必須アセットがありません",
  );
  assertEquals(urls, ["/manifest.json"]);
});

Deno.test("parseAssetManifest はオブジェクトでない入力を null にする", () => {
  assertEquals(parseAssetManifest(null), null);
  assertEquals(parseAssetManifest("x"), null);
  assertEquals(parseAssetManifest(42), null);
  assertEquals(parseAssetManifest(["/app.js"]), null);
});

Deno.test("parseAssetManifest は文字列でない値のエントリだけを捨てる", () => {
  const manifest = parseAssetManifest({
    "/app.js": "/app.0123456789.js",
    "/broken": 42,
  });
  assert(manifest !== null);
  assertEquals(Object.keys(manifest), ["/app.js"]);
});

Deno.test("resolveAssetUrl は manifest にある論理パスをハッシュ付きパスへ解決する", () => {
  const manifest = { "/data/colors.json": "/data/colors.abcdef0123.json" };
  assertEquals(
    resolveAssetUrl(manifest, "/data/colors.json"),
    "/data/colors.abcdef0123.json",
  );
});

Deno.test("resolveAssetUrl は manifest に無いパス・manifest が null のとき論理パスをそのまま返す", () => {
  assertEquals(resolveAssetUrl({}, "/data/colors.json"), "/data/colors.json");
  assertEquals(
    resolveAssetUrl(null, "/data/colors.json"),
    "/data/colors.json",
  );
});

Deno.test("論理パスへの縮退はローカル開発ホストだけに限定する", () => {
  assertEquals(allowsLogicalAssetFallback("localhost"), true);
  assertEquals(allowsLogicalAssetFallback("127.0.0.1"), true);
  assertEquals(allowsLogicalAssetFallback("zeitreises.com"), false);
  assertEquals(allowsLogicalAssetFallback("preview.pages.dev"), false);
});

Deno.test("loadAssetManifest は /manifest.json を fetch して manifest を返す", async () => {
  const requested: string[] = [];
  const manifest = await loadAssetManifest((url) => {
    requested.push(url);
    return Promise.resolve(
      new Response(JSON.stringify({ "/app.js": "/app.0123456789.js" }), {
        status: 200,
      }),
    );
  });
  assertEquals(requested, [ASSET_MANIFEST_URL]);
  assert(manifest !== null);
  assertEquals(manifest["/app.js"], "/app.0123456789.js");
});

Deno.test("loadAssetManifest は 404（dev サーバの生配信等）で warn + null を返す", async () => {
  const capture = captureWarn();
  try {
    const manifest = await loadAssetManifest(() =>
      Promise.resolve(new Response("not found", { status: 404 }))
    );
    assertEquals(manifest, null);
    assertEquals(capture.warnings.length, 1);
    assert(
      capture.warnings[0].includes(
        "manifest.json の取得に失敗しました。論理パスへフォールバックして継続します",
      ),
      capture.warnings[0],
    );
    assert(capture.warnings[0].includes("status 404"));
  } finally {
    capture.restore();
  }
});

Deno.test("loadAssetManifest はネットワーク例外・非 JSON・不正形でも warn + null で継続する", async () => {
  const cases: Array<() => Promise<Response>> = [
    () => Promise.reject(new Error("network down")),
    () => Promise.resolve(new Response("<html>", { status: 200 })),
    () => Promise.resolve(new Response('"string"', { status: 200 })),
  ];
  for (const fetchFn of cases) {
    const capture = captureWarn();
    try {
      const manifest = await loadAssetManifest(fetchFn);
      assertEquals(manifest, null);
      assertEquals(capture.warnings.length, 1);
    } finally {
      capture.restore();
    }
  }
});

Deno.test("loadAssetManifest は本番モードで失敗を論理パスへ縮退させない", async () => {
  await assertRejects(
    () =>
      loadAssetManifest(
        () => Promise.reject(new Error("network down")),
        { fallbackToLogicalPaths: false },
      ),
    Error,
    "network down",
  );
});

Deno.test("ローカル実行も 404 以外の manifest 保留・障害は起動エラーへ伝える", async () => {
  await assertRejects(
    () =>
      loadAssetManifest(
        () => Promise.reject(new Error("timeout")),
        { fallbackToLogicalPaths: true, fallbackOnlyOnNotFound: true },
      ),
    Error,
    "timeout",
  );
  const manifest = await loadAssetManifest(
    () => Promise.resolve(new Response("missing", { status: 404 })),
    { fallbackToLogicalPaths: true, fallbackOnlyOnNotFound: true },
  );
  assertEquals(manifest, null);
});
