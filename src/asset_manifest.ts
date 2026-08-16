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
 * **縮退契約**: 生ファイルを配信するローカル開発だけは manifest 不在時に
 * null を返し、論理パスへフォールバックできる。本番はコンテンツハッシュ付き
 * ファイルしか配信しないため、呼び出し側が fallbackToLogicalPaths=false を渡し、
 * 取得失敗を復帰可能な起動エラーへ遷移させる。
 *
 * decision-29 の方針どおり、このモジュールは module-scope の可変状態を
 * 持たない。manifest の共有状態は createAssetFetcher が返す closure に閉じる。
 */
import {
  type FetchLike as RetryingFetchLike,
  type FetchRetryPolicy,
  fetchWithRetry,
  STARTUP_FETCH_POLICY,
} from "./fetch_retry.ts";

/** fetch の注入型（テストでは URL → Response のスタブを渡す）。 */
export type FetchLike = (url: string) => Promise<Response>;

export interface LoadAssetManifestOptions {
  /** ローカル生配信用。false のとき取得失敗を reject して呼び出し側へ伝える。 */
  readonly fallbackToLogicalPaths?: boolean;
  /** true のとき、生配信を示す 404 だけを論理パスへ縮退させる。 */
  readonly fallbackOnlyOnNotFound?: boolean;
}

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

/** manifest 無しの論理パス配信を許可するローカル開発ホストか。 */
export function allowsLogicalAssetFallback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" ||
    hostname === "[::1]";
}

export interface AssetFetcherOptions {
  readonly hostname: string;
  readonly fetchFn?: RetryingFetchLike;
  readonly retryPolicy?: FetchRetryPolicy;
}

/**
 * manifest の共有、環境別 fallback、各 asset の timeout/retry を一体化した fetch。
 * closure ごとに manifest は 1 回だけ取得し、本番の欠落エントリは論理パスへ
 * リクエストせず reject する。
 */
export function createAssetFetcher(
  options: AssetFetcherOptions,
): (url: string) => Promise<Response> {
  const fetchFn = options.fetchFn ?? fetch;
  const retryPolicy = options.retryPolicy ?? STARTUP_FETCH_POLICY;
  let manifestPromise: Promise<AssetManifest | null> | null = null;

  return async (url: string): Promise<Response> => {
    manifestPromise ??= loadAssetManifest(
      (manifestUrl) => fetchWithRetry(manifestUrl, fetchFn, retryPolicy),
      {
        fallbackToLogicalPaths: allowsLogicalAssetFallback(options.hostname),
        fallbackOnlyOnNotFound: true,
      },
    );
    const manifest = await manifestPromise;
    const resolvedUrl = resolveAssetUrl(manifest, url);
    if (manifest !== null && resolvedUrl === url) {
      throw new Error(`manifest に必須アセットがありません: ${url}`);
    }
    return await fetchWithRetry(resolvedUrl, fetchFn, retryPolicy);
  };
}

/**
 * manifest.json を取得する。options で許可されたローカル生配信だけは
 * warn + null、それ以外は reject して起動エラー UI へ伝える。
 */
export async function loadAssetManifest(
  fetchFn: FetchLike = fetch,
  options: LoadAssetManifestOptions = {},
): Promise<AssetManifest | null> {
  try {
    const res = await fetchFn(ASSET_MANIFEST_URL);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const manifest = parseAssetManifest(await res.json());
    if (manifest === null) throw new Error("manifest がオブジェクトでない");
    return manifest;
  } catch (error) {
    if (
      options.fallbackToLogicalPaths === false ||
      (options.fallbackOnlyOnNotFound === true &&
        !String(error).includes("status 404"))
    ) {
      throw error;
    }
    console.warn(
      `manifest.json の取得に失敗しました。論理パスへフォールバックして継続します: ${
        String(error)
      }`,
    );
    return null;
  }
}
