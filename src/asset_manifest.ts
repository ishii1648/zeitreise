/**
 * アセット manifest（論理パス → コンテンツハッシュ付きパス）の解決レイヤー
 * （#246）。
 *
 * ビルド（scripts/build.ts）は `app.js` と `data/*` を内容ハッシュ付き
 * ファイル名で dist へ書き出し、対応表を `manifest.json`（唯一 no-cache で
 * 配信される JSON）として生成する。ランタイムは起動時に manifest を 1 回
 * fetch し、以後のデータ URL（`/data/...`）をハッシュ付きパスへ解決してから
 * fetch する。ハッシュ付きアセットは `Cache-Control: immutable` で配信される
 * ため、2 回目以降のロードはオリジンへの再検証なしにキャッシュから満たされる。
 *
 * **縮退契約**: manifest が無い（dev サーバで dist でなく生ファイルを配信して
 * いるケース）・取得失敗・不正形のときは console.warn を出して null を返し、
 * 呼び出し側は {@linkcode resolveAssetUrl} により素の論理パスへフォールバック
 * して従来どおり動く（data_loading.ts と同じ「warn + フォールバックで継続」
 * 方針）。
 *
 * decision-29 の方針どおり、このモジュールは module-scope の可変状態を
 * 持たない。manifest の所有（モジュール変数への代入）は main.ts 側が行う。
 */

/** fetch の注入型（テストでは URL → Response のスタブを渡す）。 */
export type FetchLike = (url: string) => Promise<Response>;

/** 論理パス（`/data/colors.json` 等）→ ハッシュ付き配信パスの対応表。 */
export type AssetManifest = Readonly<Record<string, string>>;

/** manifest.json の配信パス（ビルドが dist 直下に生成する）。 */
export const ASSET_MANIFEST_URL = "/manifest.json";

/**
 * manifest.json のパース結果を検証する（純粋関数）。オブジェクトでない入力は
 * null（= manifest なし扱い）、値が文字列でないエントリはそのエントリだけ
 * 捨てる（残りの解決は生かす）。
 */
export function parseAssetManifest(raw: unknown): AssetManifest | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const manifest: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") manifest[key] = value;
  }
  return manifest;
}

/**
 * 論理パスをハッシュ付き配信パスへ解決する（純粋関数）。manifest が null
 * （未取得・取得失敗）またはエントリが無いパスは論理パスをそのまま返す
 * （フォールバック）。
 */
export function resolveAssetUrl(
  manifest: AssetManifest | null,
  url: string,
): string {
  if (manifest === null) return url;
  return manifest[url] ?? url;
}

/**
 * manifest.json を取得する。失敗・不正形のときは warn + null を返し、
 * 呼び出し側は論理パスのまま継続する（縮退契約）。
 */
export async function loadAssetManifest(
  fetchFn: FetchLike = fetch,
): Promise<AssetManifest | null> {
  try {
    const res = await fetchFn(ASSET_MANIFEST_URL);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const manifest = parseAssetManifest(await res.json());
    if (manifest === null) throw new Error("manifest がオブジェクトでない");
    return manifest;
  } catch (error) {
    console.warn(
      `manifest.json の取得に失敗しました。論理パスへフォールバックして継続します: ${
        String(error)
      }`,
    );
    return null;
  }
}
