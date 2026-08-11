import { assert, assertEquals } from "@std/assert";
import {
  ASSET_MANIFEST_URL,
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
