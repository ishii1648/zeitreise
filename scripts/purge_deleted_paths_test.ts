/**
 * デプロイで削除されたファイルのエッジキャッシュパージ（Issue #298）の
 * 純ロジックのテスト。
 *
 * `.github/workflows/deploy.yml` は前回デプロイの dist ファイル一覧
 * （マニフェスト）を R2 に保存し、今回の dist との差分から「削除された
 * 配信パス」を検出して Cloudflare の URL 単位パージを実行する。その
 * 削除検出・パージ URL 生成・リクエストボディ分割を
 * `scripts/purge_deleted_paths.ts` に切り出し、ここで固定する。
 */
import { assertEquals } from "@std/assert";
import {
  buildPurgeBodies,
  detectDeletedPaths,
  parseManifest,
  toPurgeUrls,
} from "./purge_deleted_paths.ts";

const BASE = "https://zeitreises.com";

Deno.test("parseManifest: 1 行 1 パスを読み、空行・コメント・重複を除いてソートする", () => {
  const text = [
    "data/colors.abc123.json",
    "",
    "# コメント行は無視する",
    "  app.def456.js  ",
    "index.html",
    "app.def456.js",
  ].join("\n");
  assertEquals(parseManifest(text), [
    "app.def456.js",
    "data/colors.abc123.json",
    "index.html",
  ]);
});

Deno.test("parseManifest: 空文字列は空配列になる", () => {
  assertEquals(parseManifest(""), []);
});

Deno.test("detectDeletedPaths: 前回に在って今回無いパスだけをソートして返す", () => {
  const previous = [
    "app.old111.js",
    "data/colors.old222.json",
    "data/kept.333.json",
    "index.html",
  ];
  const current = [
    "app.new444.js",
    "data/colors.new555.json",
    "data/kept.333.json",
    "index.html",
  ];
  assertEquals(detectDeletedPaths(previous, current), [
    "app.old111.js",
    "data/colors.old222.json",
  ]);
});

Deno.test("detectDeletedPaths: 追加のみ・変化なしでは空になる", () => {
  assertEquals(detectDeletedPaths([], ["a.js"]), []);
  assertEquals(detectDeletedPaths(["a.js"], ["a.js", "b.js"]), []);
});

Deno.test("toPurgeUrls: 配信パスを base 直結の絶対 URL にする", () => {
  assertEquals(toPurgeUrls(["data/old.abc.json"], BASE), [
    "https://zeitreises.com/data/old.abc.json",
  ]);
});

Deno.test("toPurgeUrls: base の末尾スラッシュは重複させない", () => {
  assertEquals(toPurgeUrls(["a.js"], "https://zeitreises.com/"), [
    "https://zeitreises.com/a.js",
  ]);
});

Deno.test("toPurgeUrls: Pages 内部ファイル（_headers 等）は配信されないので除外する", () => {
  assertEquals(
    toPurgeUrls(
      ["_headers", "_redirects", "_routes.json", "_worker.js", "a.js"],
      BASE,
    ),
    ["https://zeitreises.com/a.js"],
  );
});

Deno.test("toPurgeUrls: パスセグメントを URL エンコードする", () => {
  assertEquals(toPurgeUrls(["data/a b#c.json"], BASE), [
    "https://zeitreises.com/data/a%20b%23c.json",
  ]);
});

Deno.test("toPurgeUrls: index.html はディレクトリ URL（Pages の正規 URL）も併せてパージする", () => {
  assertEquals(toPurgeUrls(["docs/index.html"], BASE), [
    "https://zeitreises.com/docs/index.html",
    "https://zeitreises.com/docs/",
  ]);
  assertEquals(toPurgeUrls(["index.html"], BASE), [
    "https://zeitreises.com/index.html",
    "https://zeitreises.com/",
  ]);
});

Deno.test("toPurgeUrls: .html は拡張子なしの pretty URL も併せてパージする", () => {
  assertEquals(toPurgeUrls(["about.html"], BASE), [
    "https://zeitreises.com/about.html",
    "https://zeitreises.com/about",
  ]);
});

Deno.test("toPurgeUrls: 重複 URL は 1 件にまとめる", () => {
  assertEquals(toPurgeUrls(["a.js", "a.js"], BASE), [
    "https://zeitreises.com/a.js",
  ]);
});

Deno.test("buildPurgeBodies: purge_cache の 30 URL/リクエスト上限で分割した JSON ボディを返す", () => {
  const urls = Array.from({ length: 61 }, (_, i) => `${BASE}/f${i}.js`);
  const bodies = buildPurgeBodies(urls);
  assertEquals(bodies.length, 3);
  const parsed = bodies.map((b) => JSON.parse(b) as { files: string[] });
  assertEquals(parsed[0].files.length, 30);
  assertEquals(parsed[1].files.length, 30);
  assertEquals(parsed[2].files.length, 1);
  assertEquals(parsed.flatMap((p) => p.files), urls);
});

Deno.test("buildPurgeBodies: URL が無ければ空配列（リクエスト不要）", () => {
  assertEquals(buildPurgeBodies([]), []);
});
