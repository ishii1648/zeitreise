import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  ASSET_HASH_LENGTH,
  buildAssetManifestJson,
  contentHashHex,
  hashedAssetPath,
  IMMUTABLE_CACHE_CONTROL,
  insertModulePreloads,
  isHashedAssetPath,
  rewriteIndexHtml,
} from "./asset_hashing.ts";

Deno.test("contentHashHex は内容の SHA-256 先頭 10 桁（hex）を返す", async () => {
  const hash = await contentHashHex(new TextEncoder().encode("hello"));
  // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
  assertEquals(hash, "2cf24dba5f");
  assertEquals(hash.length, ASSET_HASH_LENGTH);
});

Deno.test("contentHashHex は内容が同じなら同じ、違えば異なるハッシュを返す", async () => {
  const a1 = await contentHashHex(new TextEncoder().encode("abc"));
  const a2 = await contentHashHex(new TextEncoder().encode("abc"));
  const b = await contentHashHex(new TextEncoder().encode("abd"));
  assertEquals(a1, a2);
  assert(a1 !== b);
});

Deno.test("hashedAssetPath は最後の拡張子の直前にハッシュを挿入する", () => {
  assertEquals(
    hashedAssetPath("dist/app.js", "0123456789"),
    "dist/app.0123456789.js",
  );
  assertEquals(
    hashedAssetPath("dist/data/colors.json", "abcdef0123"),
    "dist/data/colors.abcdef0123.json",
  );
  assertEquals(
    hashedAssetPath("/data/europe_1000.geojson", "abcdef0123"),
    "/data/europe_1000.abcdef0123.geojson",
  );
});

Deno.test("hashedAssetPath は拡張子のないパス・不正なハッシュを拒否する", () => {
  assertThrows(() => hashedAssetPath("dist/noext", "0123456789"));
  // ディレクトリ名にだけ "." があるケースも拡張子なしとして拒否する
  assertThrows(() => hashedAssetPath("dist/v1.0/noext", "0123456789"));
  assertThrows(() => hashedAssetPath("dist/app.js", "short"));
  assertThrows(() => hashedAssetPath("dist/app.js", "UPPERCASE0"));
});

Deno.test("isHashedAssetPath はハッシュ付き配信パスだけを真とする", () => {
  assert(isHashedAssetPath("/app.0123456789.js"));
  assert(isHashedAssetPath("/data/colors.abcdef0123.json"));
  assert(isHashedAssetPath("/data/europe_1000.abcdef0123.geojson"));
  // 論理パス（ハッシュなし）は偽
  assert(!isHashedAssetPath("/app.js"));
  assert(!isHashedAssetPath("/data/colors.json"));
  // manifest / index.html / pmtiles は偽（no-cache のまま）
  assert(!isHashedAssetPath("/manifest.json"));
  assert(!isHashedAssetPath("/index.html"));
  assert(!isHashedAssetPath("/europe.pmtiles"));
  // 桁数・文字種が違うものは偽
  assert(!isHashedAssetPath("/app.012345678.js"));
  assert(!isHashedAssetPath("/app.ABCDEF0123.js"));
});

Deno.test("hashedAssetPath の出力は isHashedAssetPath が認識する（往復整合）", async () => {
  const hash = await contentHashHex(new TextEncoder().encode("x"));
  assert(isHashedAssetPath(hashedAssetPath("/data/cities.json", hash)));
});

Deno.test("buildAssetManifestJson はキー昇順・末尾改行の決定的な JSON を返す", () => {
  const json = buildAssetManifestJson({
    "/data/colors.json": "/data/colors.abcdef0123.json",
    "/app.js": "/app.0123456789.js",
  });
  assert(json.endsWith("\n"));
  const parsed = JSON.parse(json) as Record<string, string>;
  assertEquals(Object.keys(parsed), ["/app.js", "/data/colors.json"]);
  assertEquals(parsed["/app.js"], "/app.0123456789.js");
  // 入力順に依らず同一出力（決定性）
  assertEquals(
    json,
    buildAssetManifestJson({
      "/app.js": "/app.0123456789.js",
      "/data/colors.json": "/data/colors.abcdef0123.json",
    }),
  );
});

Deno.test('rewriteIndexHtml は <script src="app.js"> をハッシュ付き名へ書き換える', () => {
  const html = '<html><body><script type="module" src="app.js"></script>' +
    "</body></html>";
  const rewritten = rewriteIndexHtml(html, {
    "/app.js": "/app.0123456789.js",
  });
  assert(rewritten.includes('src="app.0123456789.js"'));
  assert(!rewritten.includes('src="app.js"'));
});

Deno.test("rewriteIndexHtml は参照が見つからない・manifest に /app.js が無い場合に失敗する", () => {
  assertThrows(() =>
    rewriteIndexHtml("<html></html>", { "/app.js": "/app.0123456789.js" })
  );
  assertThrows(() => rewriteIndexHtml('<script src="app.js"></script>', {}));
});

Deno.test("IMMUTABLE_CACHE_CONTROL は 1 年 + immutable", () => {
  assertEquals(IMMUTABLE_CACHE_CONTROL, "public, max-age=31536000, immutable");
});

Deno.test("insertModulePreloads は module script の直前に modulepreload を挿入する（#247）", () => {
  const html = "<head>\n" +
    '    <script type="module" src="app.0123456789.js"></script>\n' +
    "</head>";
  const out = insertModulePreloads(html, [
    "chunk-A.abcdef0123.js",
    "chunk-B.0123456789.js",
  ]);
  const posA = out.indexOf(
    '<link rel="modulepreload" href="chunk-A.abcdef0123.js" />',
  );
  const posB = out.indexOf(
    '<link rel="modulepreload" href="chunk-B.0123456789.js" />',
  );
  const posScript = out.indexOf('<script type="module"');
  assert(posA >= 0 && posB >= 0, "両チャンクの modulepreload があること");
  // 入力順のまま、script タグより前に挿入される
  assert(posA < posB && posB < posScript);
  // 既存の script タグは変更されない
  assert(out.includes('<script type="module" src="app.0123456789.js">'));
});

Deno.test("insertModulePreloads は挿入対象が無ければ HTML を変更しない（#247）", () => {
  const html = '<script type="module" src="app.0123456789.js"></script>';
  assertEquals(insertModulePreloads(html, []), html);
});

Deno.test("insertModulePreloads は module script が見つからなければ失敗する（#247）", () => {
  assertThrows(() => insertModulePreloads("<html></html>", ["chunk.abc.js"]));
});
