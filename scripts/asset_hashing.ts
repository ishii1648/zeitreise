/**
 * コンテンツハッシュ付きアセット名のユーティリティ（#246）。
 *
 * `app.js` と `data/*`（json / geojson）を内容ハッシュ付きファイル名
 * （`app.<hash>.js` 等）で配信し、`Cache-Control: public, max-age=31536000,
 * immutable` によって 2 回目以降のオリジン再検証を不要にするための共有部品。
 * ビルド（scripts/build.ts。ハッシュ付与・manifest.json 生成・_headers 生成・
 * index.html 書き換え）と dev サーバ（scripts/serve.ts。ハッシュ付きパスへの
 * immutable ヘッダ付与）の両方から参照されるため、依存を持たない純関数だけを
 * ここに置く。
 *
 * ハッシュは SHA-256 の先頭 {@linkcode ASSET_HASH_LENGTH} 桁（hex）。内容が
 * 変わらない限りファイル名も変わらないため、再ビルドしても差分のないアセットは
 * ブラウザ/エッジのキャッシュがそのまま効き続ける。
 */

/** ファイル名に埋め込むコンテンツハッシュの桁数（SHA-256 hex の先頭）。 */
export const ASSET_HASH_LENGTH = 10;

/** ハッシュ付きアセットに付与する Cache-Control 値（1 年 + immutable）。 */
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * ハッシュ付き配信パスの判定（純粋関数）。`name.<hash 10 桁 hex>.<ext>` の形
 * （ext はハッシュ付与対象の js / json / geojson）だけを真とする。
 * manifest.json や index.html、pmtiles は該当せず no-cache のままになる。
 */
const HASHED_ASSET_PATH_RE = new RegExp(
  `\\.[0-9a-f]{${ASSET_HASH_LENGTH}}\\.(?:js|json|geojson)$`,
);

/** pathname がハッシュ付きアセット（immutable 配信対象）かを返す（純粋関数）。 */
export function isHashedAssetPath(pathname: string): boolean {
  return HASHED_ASSET_PATH_RE.test(pathname);
}

/** 内容の SHA-256 先頭 {@linkcode ASSET_HASH_LENGTH} 桁を hex で返す。 */
export async function contentHashHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, ASSET_HASH_LENGTH);
}

/**
 * パスの最後の拡張子の直前にハッシュを挿入する（純粋関数）。
 * `dist/app.js` + `0123456789` → `dist/app.0123456789.js`。
 * 拡張子のないパス・{@linkcode ASSET_HASH_LENGTH} 桁 hex でないハッシュは
 * 事故（ハッシュなしファイルの immutable 配信等）につながるため例外にする。
 */
export function hashedAssetPath(path: string, hash: string): string {
  if (!new RegExp(`^[0-9a-f]{${ASSET_HASH_LENGTH}}$`).test(hash)) {
    throw new Error(
      `ハッシュは ${ASSET_HASH_LENGTH} 桁の hex である必要があります: ${hash}`,
    );
  }
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  if (dot <= slash + 1) {
    throw new Error(`拡張子のないパスにはハッシュを挿入できません: ${path}`);
  }
  return `${path.slice(0, dot)}.${hash}${path.slice(dot)}`;
}

/**
 * manifest.json の内容（論理パス → ハッシュ付きパス）を決定的な JSON 文字列に
 * する（純粋関数）。キー昇順・2 スペースインデント・末尾改行で、入力の順序に
 * よらず同一内容なら同一バイト列になる。
 */
export function buildAssetManifestJson(
  manifest: Record<string, string>,
): string {
  const sorted = Object.fromEntries(
    Object.entries(manifest).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
  );
  return JSON.stringify(sorted, null, 2) + "\n";
}

/**
 * index.html の `<script src="app.js">` 参照を manifest のハッシュ付き名へ
 * 書き換える（純粋関数）。index.html 自体は no-cache 配信なので、毎デプロイで
 * 「そのビルドの app.js」を指す = app.js と data/* が同一ビルドの組でのみ
 * 読まれる（#246 AC2 / TASK-35 の整合性要件）。
 * 参照が見つからない・manifest に `/app.js` が無い場合は、旧参照のまま配信して
 * 白画面になる事故を防ぐためビルドを失敗させる。
 */
export function rewriteIndexHtml(
  html: string,
  manifest: Record<string, string>,
): string {
  const hashed = manifest["/app.js"];
  if (hashed === undefined) {
    throw new Error("manifest に /app.js のエントリがありません");
  }
  const needle = 'src="app.js"';
  if (!html.includes(needle)) {
    throw new Error('index.html に src="app.js" の参照が見つかりません');
  }
  return html.replace(needle, `src="${hashed.replace(/^\//, "")}"`);
}

/**
 * index.html の module script（app.<hash>.js）の直前に、エントリが静的 import
 * するチャンク群の `<link rel="modulepreload">` を挿入する（純粋関数。#247）。
 *
 * code splitting 後のエントリは分割チャンクを相対 import で参照するが、
 * ブラウザがその参照を発見できるのはエントリのダウンロード完了後で、直列の
 * ラウンドトリップが 1 段増える。modulepreload を index.html に書いておくと
 * エントリと静的チャンクの取得が並行になり、分割で評価開始が遅れる回帰を防ぐ。
 * 動的 import の先（deck.gl チャンク）は対象にしない: 高優先の preload は
 * PMTiles・GeoJSON の取得と帯域を奪い合い、#247 の目的（PMTiles の前倒し）に
 * 反する（取得自体はエントリ評価直後の import() が開始する）。
 *
 * hashedNames が空なら HTML をそのまま返す。module script が見つからない場合は
 * ビルドの配線ミスなので失敗させる。
 */
export function insertModulePreloads(
  html: string,
  hashedNames: readonly string[],
): string {
  if (hashedNames.length === 0) return html;
  const needle = '<script type="module"';
  const at = html.indexOf(needle);
  if (at < 0) {
    throw new Error(
      'index.html に <script type="module"> が見つかりません',
    );
  }
  const links = hashedNames
    .map((name) => `<link rel="modulepreload" href="${name}" />`)
    .join("\n    ");
  return `${html.slice(0, at)}${links}\n    ${html.slice(at)}`;
}
