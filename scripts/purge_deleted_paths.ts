/**
 * デプロイで削除されたファイルのエッジキャッシュパージ用の純ロジック
 * （Issue #298）。
 *
 * 背景: dist のハッシュ付きアセットは `Cache-Control: public,
 * max-age=31536000, immutable` + Cloudflare Cache Rule（#246 / #270）で
 * エッジ長期キャッシュされるため、デプロイでファイルを削除・置換しても
 * 旧コピーが素の URL で最長 1 年配信され続ける。対策として
 * `.github/workflows/deploy.yml` は前回デプロイの dist ファイル一覧
 * （マニフェスト）を R2 に保存し、今回の dist との差分から削除された
 * 配信パスを検出して Cloudflare の URL 単位パージ
 * （`POST /zones/{zone_id}/purge_cache`）を実行する（docs/app-spec.md §3.4）。
 *
 * このモジュールはその「削除検出 → パージ URL 生成 → リクエストボディ分割」
 * を担う。ネットワークにも環境にも触れない純関数群 + マニフェストファイルを
 * 読んでリクエストボディを標準出力へ書く CLI で構成する。
 *
 * CLI（deploy.yml から呼ぶ）:
 * ```
 * deno run --allow-read scripts/purge_deleted_paths.ts \
 *   --previous <前回マニフェスト> --current <今回マニフェスト> \
 *   [--extra <明示パージリスト>] --base https://zeitreises.com
 * ```
 * stdout: purge_cache へ渡す JSON ボディを 1 行 1 リクエストで出力する。
 * stderr: 検出結果のログ。
 */

/**
 * Cloudflare の URL 単位パージが 1 リクエストで受け付ける URL 数の上限。
 * https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-single-file/
 */
export const MAX_URLS_PER_PURGE = 30;

/**
 * Cloudflare Pages が設定として消費し、URL として配信しないファイル。
 * パージ対象から除外する。
 */
const PAGES_INTERNAL_FILES: ReadonlySet<string> = new Set([
  "_headers",
  "_redirects",
  "_routes.json",
  "_worker.js",
]);

/**
 * マニフェスト本文（1 行 1 配信パス）をパースする。
 * 空行と `#` 始まりのコメント行を無視し、重複を除いてソートして返す。
 */
export function parseManifest(text: string): string[] {
  const paths = new Set<string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    paths.add(line);
  }
  return [...paths].sort();
}

/**
 * 前回デプロイに存在し、今回のデプロイに存在しない配信パスを
 * ソートして返す。
 */
export function detectDeletedPaths(
  previous: readonly string[],
  current: readonly string[],
): string[] {
  const currentSet = new Set(current);
  return [...new Set(previous)].filter((path) => !currentSet.has(path)).sort();
}

/**
 * 配信パス（dist 相対）をパージ対象の絶対 URL 群へ変換する。
 *
 * - Pages 内部ファイル（`_headers` 等）は配信されないため除外する
 * - パスセグメントは URL エンコードする
 * - Pages の pretty URL に対応する: `index.html` はディレクトリ URL、
 *   その他の `.html` は拡張子なし URL も併せてパージする
 * - 重複は除く（入力順を保つ）
 */
export function toPurgeUrls(
  paths: readonly string[],
  baseUrl: string,
): string[] {
  const base = baseUrl.replace(/\/+$/, "");
  const urls = new Set<string>();
  for (const path of paths) {
    if (PAGES_INTERNAL_FILES.has(path)) continue;
    for (const variant of pathVariants(path)) {
      const encoded = variant.split("/").map(encodeURIComponent).join("/");
      urls.add(`${base}/${encoded}`);
    }
  }
  return [...urls];
}

/** Pages が同一ファイルを配信し得るパスのバリエーションを列挙する */
function pathVariants(path: string): string[] {
  const variants = [path];
  if (path === "index.html" || path.endsWith("/index.html")) {
    // `docs/index.html` → `docs/`（ルートの `index.html` → ``）
    variants.push(path.slice(0, -"index.html".length));
  } else if (path.endsWith(".html")) {
    variants.push(path.slice(0, -".html".length));
  }
  return variants;
}

/**
 * パージ対象 URL 群を purge_cache API のリクエストボディ（JSON 文字列）へ
 * 変換する。上限（{@link MAX_URLS_PER_PURGE}）ごとに分割し、1 要素 1
 * リクエストで返す。URL が無ければ空配列。
 */
export function buildPurgeBodies(urls: readonly string[]): string[] {
  const bodies: string[] = [];
  for (let i = 0; i < urls.length; i += MAX_URLS_PER_PURGE) {
    bodies.push(
      JSON.stringify({ files: urls.slice(i, i + MAX_URLS_PER_PURGE) }),
    );
  }
  return bodies;
}

/** CLI 引数（`--name value` 形式）を取り出す。無ければ undefined */
function argValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

if (import.meta.main) {
  const previousPath = argValue(Deno.args, "previous");
  const currentPath = argValue(Deno.args, "current");
  const extraPath = argValue(Deno.args, "extra");
  const base = argValue(Deno.args, "base");
  if (!previousPath || !currentPath || !base) {
    console.error(
      "usage: purge_deleted_paths.ts --previous <file> --current <file> " +
        "[--extra <file>] --base <origin>",
    );
    Deno.exit(2);
  }

  const previous = parseManifest(await Deno.readTextFile(previousPath));
  const current = parseManifest(await Deno.readTextFile(currentPath));
  const extra = extraPath
    ? parseManifest(await Deno.readTextFile(extraPath))
    : [];

  const deleted = detectDeletedPaths(previous, current);
  const urls = toPurgeUrls([...deleted, ...extra], base);
  console.error(
    `削除検出: ${deleted.length} 件 / 明示パージ: ${extra.length} 件 / ` +
      `パージ URL: ${urls.length} 件`,
  );
  for (const url of urls) console.error(`  ${url}`);
  for (const body of buildPurgeBodies(urls)) console.log(body);
}
