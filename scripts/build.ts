/**
 * dist/ ビルドスクリプト。
 * - src/main.ts を deno bundle（--code-splitting）でブラウザ向けにバンドルし、
 *   エントリと後続チャンク（deck.gl 系。#247）をコンテンツハッシュ付き名
 *   （dist/app.<hash>.js / dist/<chunk>.<hash>.js）で配置する（#246）
 * - data/* も同様にハッシュ付き名で dist/data/ へ配置し、論理パス →
 *   ハッシュ付きパスの対応表を dist/manifest.json に生成する
 * - index.html（app.js 参照をハッシュ付き名へ書き換え）/ app.css を dist/ に
 *   コピーする
 */

import {
  buildAssetManifestJson,
  contentHashHex,
  hashedAssetPath,
  IMMUTABLE_CACHE_CONTROL,
  insertModulePreloads,
  isHashedAssetPath,
  rewriteIndexHtml,
} from "./asset_hashing.ts";
import {
  BORROWED_HRE_OVERLAY_YEARS,
  BORROWED_ITALY_FIEF_OVERLAY_YEARS,
  FALLBACK_STYLE_URL,
  SNAPSHOT_YEARS,
} from "../src/config.ts";
import { TILES_ORIGIN } from "../src/pmtiles_url.ts";
import { HRE_OVERLAY_YEARS } from "./build-hre.ts";
import { FRANCE_FIEF_YEARS } from "./build-france-fiefs.ts";
import { HRE_FIEF_YEARS } from "./build-hre-fiefs.ts";
import { ITALY_FIEF_YEARS } from "./build-italy-fiefs.ts";
import { CLIOPATRIA_FIEF_YEARS } from "./build-cliopatria-fiefs.ts";
import { BRITAIN_FIEF_YEARS } from "./build-britain-fiefs.ts";
import { SOVEREIGN_FIEF_YEARS } from "./build-sovereign-fiefs.ts";

const ENTRY = "src/main.ts";
const DIST_DIR = "dist";
/**
 * `deno bundle --outdir` がエントリ（src/main.ts）を書き出すファイル名（#247。
 * エントリの basename に従う）。
 */
const ENTRY_EMITTED_NAME = "main.js";
/**
 * エントリの論理名（manifest キー `/app.js`・index.html の参照名）。#246 の
 * ハッシュ付き配信（`app.<hash>.js`）とリライト（rewriteIndexHtml）はこの
 * 論理名を前提にする。
 */
const ENTRY_LOGICAL_NAME = "app.js";

/** dist/ にそのままコピーする静的ファイルの一覧を返す（純粋関数） */
export function getStaticCopyTargets(
  distDir: string,
): Array<{ from: string; to: string }> {
  return [
    { from: "index.html", to: `${distDir}/index.html` },
    // #270: 404.html があると Cloudflare Pages は SPA フォールバック（未知
    // パスへ index.html を 200 で返す挙動）をやめ、未知パスに 404 を返す。
    // /data/* の _headers（immutable）はリクエストパスで付くため、フォール
    // バックの HTML が .json URL に immutable 付き 200 として返り、エッジ
    // （Cache Rule）やブラウザに最長 1 年固定されるキャッシュ汚染経路を
    // 閉じる（docs/app-spec.md §3.4）。アプリは `/` 以外のルートを持たない
    // （状態は URL クエリのみ）ため SPA フォールバックに依存しない
    { from: "404.html", to: `${distDir}/404.html` },
    { from: "app.css", to: `${distDir}/app.css` },
    { from: "vendor/maplibre-gl.css", to: `${distDir}/vendor/maplibre-gl.css` },
    // #300: favicon。SVG（index.html の <link rel="icon">）が第一候補。
    // link を見ずに /favicon.ico を直接リクエストするクライアント
    // （ブックマーク・クローラ・SVG favicon 非対応ブラウザ）向けに、実体の
    // ico（32x32 BMP 入り ICO）も配信する。404.html の配置（#270）で Pages の
    // SPA フォールバックが無効なため、実ファイルを置かないと 404 になる。
    // どちらも CSP（buildHeadersContent）の default-src/img-src 'self' の
    // 範囲内で、_headers の追加変更は不要
    { from: "favicon.svg", to: `${distDir}/favicon.svg` },
    { from: "favicon.ico", to: `${distDir}/favicon.ico` },
  ];
}

/**
 * 存在する場合のみ dist/ にコピーする任意ファイルの一覧を返す（純粋関数）。
 * data/europe.pmtiles は `deno task extract-pmtiles`、data/europe-dem.pmtiles は
 * `deno task extract-dem` で生成される成果物で、CI 等の未生成環境では
 * スキップしてビルドは成功させる（警告表示のみ）。
 */
export function getOptionalCopyTargets(
  distDir: string,
): Array<{ from: string; to: string }> {
  return [
    { from: "data/europe.pmtiles", to: `${distDir}/europe.pmtiles` },
    // TASK-34: 地形（起伏・陰影）用 DEM タイル（deno task extract-dem で生成）
    { from: "data/europe-dem.pmtiles", to: `${distDir}/europe-dem.pmtiles` },
  ];
}

/**
 * 勢力圏レイヤーが参照する data/ 一式を dist/data/ にコピーする対象を返す（純粋関数）。
 * index.json・colors.json と各年代の GeoJSON。europe.pmtiles は別枠（dist 直下・任意）。
 * hreYears には HRE 主要領邦オーバーレイ（deno task build-hre で生成）の年代を、
 * fiefYears には中世フランス諸侯領オーバーレイ（deno task build-france-fiefs で
 * 生成、TASK-71）の年代を、hreFiefYears には中世 HRE 領邦オーバーレイ
 * （deno task build-hre-fiefs で生成、TASK-85/86）の年代を、italyFiefYears には
 * 中世イタリア諸侯領オーバーレイ（deno task build-italy-fiefs で生成、
 * TASK-95/96）の年代を渡す。
 * fiefYears / hreFiefYears / italyFiefYears は省略可（省略時はコピー対象なし）。
 */
export function getDataCopyTargets(
  distDir: string,
  years: readonly number[],
  hreYears: readonly number[],
  fiefYears: readonly number[] = [],
  hreFiefYears: readonly number[] = [],
  italyFiefYears: readonly number[] = [],
  cliopatriaFiefYears: readonly number[] = [],
  britainFiefYears: readonly number[] = [],
  sovereignFiefYears: readonly number[] = [],
  borrowedHreYears: readonly number[] = [],
  borrowedItalyFiefYears: readonly number[] = [],
): Array<{ from: string; to: string }> {
  const targets: Array<{ from: string; to: string }> = [
    { from: "data/index.json", to: `${distDir}/data/index.json` },
    { from: "data/colors.json", to: `${distDir}/data/colors.json` },
    // TASK-7: ホバー/クリックのラベル整形が SUBJECTO 正規化に使う renames マップ
    {
      from: "data/name-overrides.json",
      to: `${distDir}/data/name-overrides.json`,
    },
    // TASK-23: 勢力名の日本語表記マップ（英語 NAME → 日本語名）
    { from: "data/name-ja.json", to: `${distDir}/data/name-ja.json` },
    // TASK-21: 主要河川オーバーレイ用の GeoJSON（deno task build-rivers で生成）
    { from: "data/rivers.geojson", to: `${distDir}/data/rivers.geojson` },
    // TASK-97: 主要山脈ポリゴン（deno task build-mountains で生成）。河川と同じく
    // 年代非依存の 1 ファイルで、山脈名ラベルのアンカー元になる
    { from: "data/mountains.geojson", to: `${distDir}/data/mountains.geojson` },
    // TASK-99: 主要山峰の標高付きマーカー（deno task build-peaks で生成）。
    // 山脈と同じく年代非依存の 1 ファイル
    { from: "data/peaks.geojson", to: `${distDir}/data/peaks.geojson` },
    // TASK-27: 各年代の主要都市マーカー（deno task build-cities で生成）
    { from: "data/cities.json", to: `${distDir}/data/cities.json` },
    // #283: 年代別の勢力説明（クリック情報パネルの一文要約。年代非依存の
    // 1 ファイルで、年代 × 補正後の内部名で引く）
    {
      from: "data/power-descriptions.json",
      to: `${distDir}/data/power-descriptions.json`,
    },
  ];
  for (const year of years) {
    targets.push({
      from: `data/europe_${year}.geojson`,
      to: `${distDir}/data/europe_${year}.geojson`,
    });
  }
  // TASK-19: HRE 主要領邦オーバーレイ用の GeoJSON（deno task build-hre で生成）
  for (const year of hreYears) {
    targets.push({
      from: `data/hre_${year}.geojson`,
      to: `${distDir}/data/hre_${year}.geojson`,
    });
  }
  // TASK-71: 中世フランス諸侯領オーバーレイ（deno task build-france-fiefs で生成）。
  // TASK-79: 配信するのは諸侯領同士の重なりを排他化した派生データ
  // （france_fiefs_flat_<year>、deno task build-fief-flat で生成）で、
  // ランタイムの参照先（powers.ts franceFiefDataUrlFor）と一致させる。
  // OHM 由来の生データ（france_fiefs_<year>）は派生データの入力なので dist には含めない。
  for (const year of fiefYears) {
    targets.push({
      from: `data/france_fiefs_flat_${year}.geojson`,
      to: `${distDir}/data/france_fiefs_flat_${year}.geojson`,
    });
  }
  // TASK-86: 中世 HRE 領邦オーバーレイ（deno task build-hre-fiefs で生成）。
  // 仏諸侯領と同じく、配信するのは領邦同士の重なりを排他化した派生データ
  // （hre_fiefs_flat_<year>、deno task build-fief-flat で生成）で、ランタイムの
  // 参照先（powers.ts hreDataUrlFor）と一致させる。OHM 由来の生データ
  // （hre_fiefs_<year>）は派生データの入力なので dist には含めない。
  for (const year of hreFiefYears) {
    targets.push({
      from: `data/hre_fiefs_flat_${year}.geojson`,
      to: `${distDir}/data/hre_fiefs_flat_${year}.geojson`,
    });
  }
  // TASK-96: 中世イタリア諸侯領オーバーレイ（deno task build-italy-fiefs で生成）。
  // 他の 2 系統と同じく、配信するのは重なりを排他化した派生データ
  // （italy_fiefs_flat_<year>）で、ランタイムの参照先（powers.ts
  // italyFiefDataUrlFor）と一致させる。
  for (const year of italyFiefYears) {
    targets.push({
      from: `data/italy_fiefs_flat_${year}.geojson`,
      to: `${distDir}/data/italy_fiefs_flat_${year}.geojson`,
    });
  }
  // TASK-110: Cliopatria 由来の諸侯領・領邦オーバーレイ
  // （deno task build-cliopatria-fiefs で生成）。他の 3 系統と同じく、配信するのは
  // 重なりを排他化した派生データ（cliopatria_fiefs_flat_<year>）で、ランタイムの
  // 参照先（powers.ts cliopatriaFiefDataUrlFor）と一致させる。
  for (const year of cliopatriaFiefYears) {
    targets.push({
      from: `data/cliopatria_fiefs_flat_${year}.geojson`,
      to: `${distDir}/data/cliopatria_fiefs_flat_${year}.geojson`,
    });
  }
  // #172: ブリテン諸島の政体オーバーレイ（deno task build-britain-fiefs で
  // 生成、TASK-151）。他の系統と同じく、配信するのは重なりを排他化した派生
  // データ（britain_fiefs_flat_<year>）で、ランタイムの参照先（powers.ts
  // britainFiefDataUrlFor）と一致させる。
  for (const year of britainFiefYears) {
    targets.push({
      from: `data/britain_fiefs_flat_${year}.geojson`,
      to: `${distDir}/data/britain_fiefs_flat_${year}.geojson`,
    });
  }
  // #189: 主権政体オーバーレイ（deno task build-sovereign-fiefs で生成）。
  // 他の系統と同じく、配信するのは重なりを排他化した派生データ
  // （sovereign_fiefs_flat_<year>）で、ランタイムの参照先（powers.ts
  // sovereignFiefDataUrlFor）と一致させる。
  for (const year of sovereignFiefYears) {
    targets.push({
      from: `data/sovereign_fiefs_flat_${year}.geojson`,
      to: `${distDir}/data/sovereign_fiefs_flat_${year}.geojson`,
    });
  }
  // #202 / ADR-0033: 隣接年から流用した面（deno task build-borrowed-fiefs で
  // 生成）。既存オーバーレイと出典・ライセンスが違うためファイルを分けたまま
  // 配信し、ランタイム（powers.ts withBorrowedGeometry）が hre-powers /
  // italy-fiefs レイヤーへマージする。#215: 配信するのはホスト系統 flat を
  // 差し引いた flat 版（deno task build-fief-flat で生成）。借用元
  // （borrowed_<lineage>_<year>.geojson）は座標無改変のまま残る中間生成物で、
  // 配信対象には含めない。
  for (const year of borrowedHreYears) {
    targets.push({
      from: `data/borrowed_hre_flat_${year}.geojson`,
      to: `${distDir}/data/borrowed_hre_flat_${year}.geojson`,
    });
  }
  for (const year of borrowedItalyFiefYears) {
    targets.push({
      from: `data/borrowed_italy_flat_${year}.geojson`,
      to: `${distDir}/data/borrowed_italy_flat_${year}.geojson`,
    });
  }
  // TASK-78/86/96/110、#172: オーバーレイとの二重輪郭・二重ラベルを解消する
  // 派生データ（deno task build-fief-dedupe で生成）。オーバーレイがある年に
  // しか存在しないため、いずれの年集合も空なら 1 件も含めない（対象外年の
  // 描画は従来のまま）。#172 のブリテンにより近世（1500〜1700）も対象になる。
  const outlineYears = [
    ...new Set([
      ...fiefYears,
      ...hreFiefYears,
      ...italyFiefYears,
      ...cliopatriaFiefYears,
      ...britainFiefYears,
      ...sovereignFiefYears,
    ]),
  ].sort((a, b) => a - b);
  if (outlineYears.length > 0) {
    targets.push({
      from: "data/fief-dedupe.json",
      to: `${distDir}/data/fief-dedupe.json`,
    });
    for (const year of outlineYears) {
      targets.push({
        from: `data/base_outline_${year}.geojson`,
        to: `${distDir}/data/base_outline_${year}.geojson`,
      });
      // TASK-92: 諸侯領の下地になる base 塗りを差し引いた派生 base。
      // powers レイヤーはオーバーレイ対象年に限りこちらを塗りに使う
      // （ラベル・帝国範囲強調・picking は従来の europe_<year> のまま）。
      targets.push({
        from: `data/europe_flat_${year}.geojson`,
        to: `${distDir}/data/europe_flat_${year}.geojson`,
      });
    }
  }
  return targets;
}

/**
 * Cloudflare Pages の `_headers` ファイル内容を返す（純粋関数。TASK-127 /
 * #246）。
 *
 * - Cache-Control（docs/app-spec.md §3.4）:
 *   - 既定（`/*`）: no-cache — index.html / manifest.json / pmtiles 等は
 *     エッジ/ブラウザで再検証（304）運用にする（部分キャッシュ不整合による
 *     表示破壊の防止）
 *   - ハッシュ付きアセット（`/data/*` と `app.<hash>.js` + 分割チャンク。
 *     #247）: `public, max-age=31536000, immutable` — 内容が変わればファイル名が
 *     変わるため再検証が不要になり、2 回目以降のロードはキャッシュから
 *     満たされる（#246）。Pages は複数ルールにマッチするとヘッダを結合するため、
 *     `! Cache-Control` で `/*` の no-cache を detach してから immutable を付ける
 *   - hashedJsPaths の各要素はハッシュ付き配信パス（`/app.<hash>.js` 等）で
 *     あることを検証する。素の `/app.js` を誤って immutable にすると
 *     再デプロイが永久に反映されない事故になるため、ビルドを失敗させる
 * - Content-Security-Policy（docs/app-spec.md §6）:
 *   - connect-src はアプリが実際に fetch する外部オリジンのみ:
 *     R2 タイル配信（TILES_ORIGIN）と PMTiles 失敗時フォールバックの
 *     OpenFreeMap（FALLBACK_STYLE_URL のオリジン。style JSON / TileJSON /
 *     タイル / glyphs / sprite すべて同一オリジンで配信されることを確認済み）、
 *     および Cloudflare Web Analytics の計測送信先 cloudflareinsights.com
 *     （#299。下記参照）
 *   - script-src 'self' + static.cloudflareinsights.com（#299）:
 *     インラインスクリプトは無し。Cloudflare Web Analytics を利用する方針
 *     （配信時に Cloudflare が beacon.min.js の <script> を自動挿入する）の
 *     ため、beacon の配信元だけを追加で許可する。beacon は計測データを
 *     cloudflareinsights.com へ送信するため connect-src にも追加する —
 *     Cloudflare 公式 CSP リファレンス
 *     （developers.cloudflare.com/fundamentals/reference/policies-compliances/
 *     content-security-policies/）が Web Analytics 用に
 *     `script-src static.cloudflareinsights.com` と
 *     `connect-src cloudflareinsights.com` の両方を要求している。'self' は
 *     クロスオリジンの送信先を覆わないので connect-src 側の追加も必須
 *   - worker-src 'self' blob: — MapLibre/deck.gl が blob URL から Worker を
 *     生成する。child-src は worker-src 未対応の旧 Safari 向けフォールバック
 *   - img-src に data: blob: — MapLibre の画像リソース（フォールバック
 *     スタイルの sprite 等）が blob/data URL 経由で読み込まれるため
 *   - style-src に 'unsafe-inline' — MapLibre/deck.gl はランタイムで
 *     インラインスタイルを操作する。script-src が 'self' で固定されている限り
 *     XSS 面での後退は小さく、本番のみで発生する描画破壊（ローカル開発では
 *     CSP が適用されず再現不能）を避ける方を優先する
 */
export function buildHeadersContent(
  hashedJsPaths: readonly string[],
): string {
  for (const path of hashedJsPaths) {
    if (!path.startsWith("/") || !isHashedAssetPath(path)) {
      throw new Error(
        `hashedJsPaths はハッシュ付きの URL パス（/app.<hash>.js 等）である` +
          `必要があります: ${path}`,
      );
    }
  }
  const fallbackOrigin = new URL(FALLBACK_STYLE_URL).origin;
  const csp = [
    "default-src 'self'",
    // #299: Cloudflare Web Analytics beacon（自動挿入）の配信元を許可
    "script-src 'self' https://static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    // #299: beacon の計測送信先（Cloudflare 公式 CSP リファレンスの要求値）
    `connect-src 'self' ${TILES_ORIGIN} ${fallbackOrigin} https://cloudflareinsights.com`,
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  const lines = [
    "/*",
    "  Cache-Control: no-cache",
    `  Content-Security-Policy: ${csp}`,
    "  X-Content-Type-Options: nosniff",
    "/data/*",
    "  ! Cache-Control",
    `  Cache-Control: ${IMMUTABLE_CACHE_CONTROL}`,
  ];
  // #247: エントリ（app.<hash>.js）に加え、code splitting で生まれた後続
  // チャンクも同じハッシュ付き + immutable 配信に載せる
  for (const path of hashedJsPaths) {
    lines.push(
      path,
      "  ! Cache-Control",
      `  Cache-Control: ${IMMUTABLE_CACHE_CONTROL}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * dist 配下のファイルパスを manifest のキー（配信 URL パス）にする（純粋関数。
 * #246）。`dist/data/colors.json` → `/data/colors.json`。distDir 配下でない
 * パスはビルドの配線ミスなので例外にする。
 */
export function manifestKeyFor(distDir: string, path: string): string {
  const prefix = `${distDir}/`;
  if (!path.startsWith(prefix)) {
    throw new Error(`${path} は ${distDir}/ 配下のパスではありません`);
  }
  return `/${path.slice(prefix.length)}`;
}

/**
 * `deno bundle` に渡す引数一覧を返す（純粋関数）。
 *
 * #247: `--code-splitting` で動的 import 境界（src/main.ts →
 * src/deck_app.ts）を後続チャンクへ分割する。出力は単一ファイルではなく
 * outDir 配下の複数ファイル（エントリ main.js + `<name>-<esbuild hash>.js`
 * チャンク群）になり、チャンク間はファイル名そのままの相対 import で参照し合う。
 */
export function buildBundleArgs(entry: string, outDir: string): string[] {
  return [
    "bundle",
    "--platform",
    "browser",
    "--code-splitting",
    "--outdir",
    outDir,
    entry,
  ];
}

/** バンドル出力 1 ファイルのハッシュ付き改名結果（#247）。 */
export interface HashedBundleFile {
  /** `deno bundle` が書き出したファイル名（`main.js` / `deck_app-XXXX.js`） */
  emittedName: string;
  /** manifest キーになる論理名（エントリのみ `app.js` に正規化） */
  logicalName: string;
  /** 内容ハッシュ付きの配信ファイル名（`app.<hash>.js` 等） */
  hashedName: string;
  /** 参照書き換え後のコード */
  code: string;
}

/**
 * バンドル出力内のチャンク相互参照（`from "./x.js"` / `import("./x.js")` /
 * 副作用 `import "./x.js"`）を拾う。`.js` で終わる相対 specifier だけを対象に
 * することで、コメントや文字列中の `./foo.ts` 等への誤反応を避ける。
 */
const CHUNK_SPECIFIER_RE =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(["'])\.\/([^"']+\.js)\2/g;

/**
 * code splitting されたバンドル出力一式を内容ハッシュ付き名へ改名する
 * （純粋関数。#246 のハッシュ付き配信を #247 の複数チャンクへ拡張する）。
 *
 * チャンクは互いをファイル名そのままの相対 import で参照するため、単純に
 * 改名すると参照が切れる。依存されている側から順（SCC 条件付きトポロジカル順）
 * に「参照をハッシュ付き名へ書き換え → その内容でハッシュ計算 → 改名」を
 * 適用することで、importer のハッシュに依存先の内容変化が伝播する
 * （依存先だけ変わって importer 名が変わらない = 古い組を参照し続ける事故が
 * 起きない）。エントリ（entryEmittedName）だけは論理名 entryLogicalName
 * （app.js）へ正規化し、rewriteIndexHtml / manifest の従来キーを保つ。
 *
 * - チャンク間の循環参照（esbuild は実際に出力する。deck.gl バンドルの
 *   chunk-*.js ↔ webgl-device-*.js で実測）は、個別の内容ハッシュを一意に
 *   決められないため SCC（強連結成分）単位で処理する: メンバー全体
 *   （エミット名 + 循環内参照をエミット名のまま残した内容、名前順）から
 *   グループハッシュを 1 つ計算し、全メンバーが共有する。メンバーのどれかが
 *   変わればグループ全員（と外側の importer）の名前が変わり、内容 = 名前の
 *   不変条件は個別ハッシュと同様に保たれる。
 * - 出力集合に無い `./*.js` 参照は配線ミス（配信後に 404 で白画面）なので
 *   ビルドを失敗させる
 */
export async function hashBundleFiles(
  files: Readonly<Record<string, string>>,
  entryEmittedName: string,
  entryLogicalName: string,
): Promise<HashedBundleFile[]> {
  const names = Object.keys(files);
  const nameSet = new Set(names);
  const deps = new Map<string, string[]>();
  for (const name of names) {
    const refs = [...files[name].matchAll(CHUNK_SPECIFIER_RE)].map((m) => m[3]);
    for (const ref of refs) {
      if (!nameSet.has(ref)) {
        throw new Error(
          `${name} が参照する ./${ref} がバンドル出力に存在しません` +
            `（チャンク解決の配線ミス。配信すると 404 で白画面になる）`,
        );
      }
    }
    deps.set(name, [...new Set(refs)]);
  }

  const encode = (s: string) => new TextEncoder().encode(s);
  const hashedNames = new Map<string, string>();
  const results = new Map<string, HashedBundleFile>();
  const logicalNameFor = (name: string): string =>
    name === entryEmittedName ? entryLogicalName : name;
  // Tarjan は SCC を「依存されている側が先」の順で列挙するため、処理順は
  // そのまま使える（各 SCC の外側依存は処理済み = ハッシュ付き名が確定済み）
  for (const scc of stronglyConnectedComponents(names, deps)) {
    const inScc = new Set(scc);
    // 外側（処理済み SCC）への参照だけ先にハッシュ付き名へ書き換える。
    // 循環内の相互参照はエミット名のまま残し、グループハッシュの入力にする
    const externalRewritten = new Map<string, string>();
    for (const name of scc) {
      externalRewritten.set(
        name,
        files[name].replace(
          CHUNK_SPECIFIER_RE,
          (whole, lead: string, quote: string, ref: string) =>
            inScc.has(ref)
              ? whole
              : `${lead}${quote}./${hashedNames.get(ref)}${quote}`,
        ),
      );
    }
    const selfLoop = scc.length === 1 &&
      (deps.get(scc[0]) ?? []).includes(scc[0]);
    if (scc.length === 1 && !selfLoop) {
      // 循環なしの通常ケース: 自身の内容ハッシュで改名する
      const name = scc[0];
      const code = externalRewritten.get(name)!;
      const hashedName = hashedAssetPath(
        logicalNameFor(name),
        await contentHashHex(encode(code)),
      );
      hashedNames.set(name, hashedName);
      results.set(name, {
        emittedName: name,
        logicalName: logicalNameFor(name),
        hashedName,
        code,
      });
      continue;
    }
    // 循環グループ: メンバー全体からグループハッシュを 1 つ計算して共有する
    const members = [...scc].sort();
    const groupHash = await contentHashHex(encode(
      members.map((name) => `${name} ${externalRewritten.get(name)}`)
        .join(" "),
    ));
    for (const name of members) {
      hashedNames.set(name, hashedAssetPath(logicalNameFor(name), groupHash));
    }
    for (const name of members) {
      const code = externalRewritten.get(name)!.replace(
        CHUNK_SPECIFIER_RE,
        (whole, lead: string, quote: string, ref: string) =>
          inScc.has(ref)
            ? `${lead}${quote}./${hashedNames.get(ref)}${quote}`
            : whole,
      );
      results.set(name, {
        emittedName: name,
        logicalName: logicalNameFor(name),
        hashedName: hashedNames.get(name)!,
        code,
      });
    }
  }
  return names.map((name) => results.get(name)!);
}

/**
 * バンドル出力内の**静的** import（`from "./x.js"` / 副作用 `import "./x.js"`）
 * だけを拾う。動的 `import("./x.js")` は `import` の直後が `(` で quote に
 * ならないため一致しない。
 */
const STATIC_CHUNK_SPECIFIER_RE =
  /(\bfrom\s*|\bimport\s*)(["'])\.\/([^"']+\.js)\2/g;

/**
 * エントリから静的 import だけで到達できるチャンク（エミット名）を BFS 順で
 * 返す（純粋関数。#247）。index.html へ挿入する modulepreload
 * （asset_hashing.ts insertModulePreloads）の対象で、動的 import の先
 * （deck.gl チャンクとその依存）は含めない: エントリの評価開始前に必要なのは
 * 静的依存だけで、動的側まで preload すると PMTiles・GeoJSON の取得と帯域を
 * 奪い合う。
 */
export function staticEntryChunkDeps(
  files: Readonly<Record<string, string>>,
  entryEmittedName: string,
): string[] {
  const seen = new Set<string>([entryEmittedName]);
  const queue = [entryEmittedName];
  const deps: string[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    const code = files[name] ?? "";
    for (const m of code.matchAll(STATIC_CHUNK_SPECIFIER_RE)) {
      const ref = m[3];
      if (seen.has(ref)) continue;
      seen.add(ref);
      deps.push(ref);
      queue.push(ref);
    }
  }
  return deps;
}

/**
 * 有向グラフ（node → 依存先）の強連結成分を Tarjan 法で列挙する（純粋関数。
 * #247）。返り順は「依存されている側の成分が先」（逆トポロジカル順）で、
 * hashBundleFiles はこの順に各成分を処理することで、成分の外側依存が常に
 * 改名済みであることを保証する。
 */
function stronglyConnectedComponents(
  nodes: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  const strongconnect = (v: string): void => {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }
    if (lowlink.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  };
  for (const v of nodes) {
    if (!indices.has(v)) strongconnect(v);
  }
  return sccs;
}

/**
 * バンドル出力コードに残っている `node:` 静的 import/re-export の specifier を
 * 重複なく昇順で返す（純粋関数）。
 *
 * ブラウザは `node:` specifier を解決できず、1 つでも残るとモジュールグラフ全体の
 * 評価が失敗して白画面になる（deck.gl → @loaders.gl の worker/child_process 由来）。
 * ビルド時にこれを検出してビルドを fail させ、「ビルド成功 = ブラウザで動く」を担保する。
 *
 * `import x from "node:.."` / `import * as x from "node:.."` / `import { y } from "node:.."`
 * / `export * from "node:.."` / `export { y } from "node:.."` / `import "node:.."` を拾う。
 * 文字列リテラル中の "node:" は `from`/`import` を伴わないため誤検出しない。
 */
export function findNodeImports(code: string): string[] {
  const re = /(?:\bfrom|\bimport)\s*["'](node:[^"']+)["']/g;
  const found = new Set<string>();
  for (const m of code.matchAll(re)) {
    found.add(m[1]);
  }
  return [...found].sort();
}

/** import 節（import と from の間）をトップレベルのカンマで分割する（波括弧内は保持） */
function splitImportClause(clause: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of clause) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s !== "");
}

/** `{ a, b as c }` を分割束縛 `{ a, b: c }` に変換する */
function braceToDestructure(brace: string): string {
  const inner = brace.slice(1, -1);
  const mapped = inner
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((p) => {
      const m = /^(\S+)\s+as\s+(\S+)$/.exec(p);
      return m ? `${m[1]}: ${m[2]}` : p;
    })
    .join(", ");
  return `{ ${mapped} }`;
}

/** import 節を、同名の束縛を空オブジェクトで用意するスタブ文へ変換する */
function clauseToStub(clause: string): string {
  const stmts: string[] = [];
  for (const seg of splitImportClause(clause)) {
    const ns = /^\*\s+as\s+(.+)$/.exec(seg);
    if (ns) {
      stmts.push(`const ${ns[1].trim()} = {};`);
    } else if (seg.startsWith("{")) {
      stmts.push(`const ${braceToDestructure(seg)} = {};`);
    } else {
      stmts.push(`const ${seg} = {};`);
    }
  }
  return stmts.join(" ");
}

/**
 * バンドル出力中の `node:` 静的 import を、ブラウザで安全な空スタブ束縛に置換する（純粋関数）。
 *
 * deck.gl → @loaders.gl（worker-utils / loader-utils）が `node:worker_threads` などを
 * 静的 import するが、これらはブラウザ実行パスでは isBrowser 分岐で踏まれない。
 * import 文を残すとブラウザが specifier を解決できずモジュールグラフ全体の評価が失敗するため、
 * import を除去しつつ束縛名だけ `const X = {};` として残し、参照は undefined になるようにする。
 *
 * npm パッケージ内部の `node:` import は deno の import map で差し替えられないため、
 * バンドル後のこの後処理で対応する（deno.json のマップは npm 依存に届かない）。
 *
 * ES の import は巻き上げられるため、束縛は import 文より前の位置からも参照され得る
 * （実際に @loaders.gl は `__reExport(..., worker_threads_star)` を import 行の前で呼ぶ）。
 * 在 place で const に置換すると TDZ で ReferenceError になるため、スタブ束縛は
 * 元の import 文を除去したうえでファイル先頭にまとめて宣言し、巻き上げ相当を再現する。
 */
export function neutralizeNodeImports(code: string): string {
  const stubs: string[] = [];
  // import <clause> from "node:..."; → 束縛スタブを収集し、その場は除去する
  const withClause = /import\s+([^;"']*?)\s+from\s*["']node:[^"']+["']\s*;?/g;
  let out = code.replace(withClause, (_m, clause: string) => {
    stubs.push(clauseToStub(clause));
    return "";
  });
  // 副作用 import "node:...";（束縛なし）は丸ごと除去する
  const sideEffect = /import\s*["']node:[^"']+["']\s*;?/g;
  out = out.replace(sideEffect, "");
  if (stubs.length === 0) return out;
  return `${stubs.join("\n")}\n${out}`;
}

async function bundle(entry: string, outDir: string): Promise<void> {
  const args = buildBundleArgs(entry, outDir);
  const command = new Deno.Command(Deno.execPath(), {
    args,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { success, code } = await command.output();
  if (!success) {
    throw new Error(
      `deno ${args.join(" ")} が失敗しました (exit code ${code})`,
    );
  }
}

/**
 * 静的ファイルを dist/ へコピーする。index.html だけは app.js 参照を manifest
 * のハッシュ付き名へ書き換え（#246。index.html は no-cache 配信なので、毎
 * デプロイでそのビルドの app.js を指す）、エントリの静的チャンク依存の
 * modulepreload を挿入して書き出す（#247）。
 */
async function copyStaticFiles(
  distDir: string,
  manifest: Record<string, string>,
  preloadHashedNames: readonly string[],
): Promise<void> {
  for (const { from, to } of getStaticCopyTargets(distDir)) {
    // dist/vendor/ など、コピー先の親ディレクトリを先に作成する
    const parentDir = to.slice(0, to.lastIndexOf("/"));
    await Deno.mkdir(parentDir, { recursive: true });
    if (from === "index.html") {
      await Deno.writeTextFile(
        to,
        insertModulePreloads(
          rewriteIndexHtml(await Deno.readTextFile(from), manifest),
          preloadHashedNames,
        ),
      );
    } else {
      await Deno.copyFile(from, to);
    }
  }
}

async function copyOptionalFiles(distDir: string): Promise<void> {
  for (const { from, to } of getOptionalCopyTargets(distDir)) {
    try {
      await Deno.copyFile(from, to);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
      const task = from.includes("europe-dem")
        ? "extract-dem"
        : "extract-pmtiles";
      console.warn(
        `警告: ${from} が見つからないためコピーをスキップします` +
          `（表示には \`deno task ${task}\` での生成が必要）`,
      );
    }
  }
}

/**
 * 本番ビルド（copyDataFiles）が実際に使う data/ コピー対象一覧を返す（純粋関数・
 * #218 AC3）。
 *
 * getDataCopyTargets の年集合引数（特に末尾の省略可能な borrowedHreYears /
 * borrowedItalyFiefYears）は copyDataFiles だけが渡しており、呼び出し側で引数を
 * 落としても reorder しても型は通ってビルドが成功してしまう。本番の引数構成を
 * この関数に固定してテスト（scripts/build_test.ts）で検査することで、
 * dist/data/ から借用 flat 等が黙って抜ける退行を CI で検出する。
 */
export function productionDataCopyTargets(
  distDir: string,
): Array<{ from: string; to: string }> {
  return getDataCopyTargets(
    distDir,
    SNAPSHOT_YEARS,
    HRE_OVERLAY_YEARS,
    FRANCE_FIEF_YEARS,
    HRE_FIEF_YEARS,
    ITALY_FIEF_YEARS,
    CLIOPATRIA_FIEF_YEARS,
    BRITAIN_FIEF_YEARS,
    SOVEREIGN_FIEF_YEARS,
    BORROWED_HRE_OVERLAY_YEARS,
    BORROWED_ITALY_FIEF_OVERLAY_YEARS,
  );
}

/**
 * data/* を内容ハッシュ付き名で dist/data/ へ書き出し、論理パス → ハッシュ
 * 付きパスの対応を manifest に積む（#246）。旧ビルドのハッシュ付きファイルが
 * dist に残ると古い組を配信し続ける事故につながるため、dist/data は毎回
 * 作り直す。
 */
async function copyDataFiles(
  distDir: string,
  manifest: Record<string, string>,
): Promise<void> {
  try {
    await Deno.remove(`${distDir}/data`, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await Deno.mkdir(`${distDir}/data`, { recursive: true });
  for (const { from, to } of productionDataCopyTargets(distDir)) {
    const bytes = await Deno.readFile(from);
    const hashedTo = hashedAssetPath(to, await contentHashHex(bytes));
    await Deno.writeFile(hashedTo, bytes);
    manifest[manifestKeyFor(distDir, to)] = manifestKeyFor(distDir, hashedTo);
  }
}

/**
 * バンドル出力 1 ファイルの `node:` 静的 import を中和し、残存が無いことを
 * 保証する。残っているとブラウザで module graph 全体の評価が失敗する（白画面）
 * ため、中和後も 1 つでも残ればビルドを fail させ「ビルド成功 = ブラウザで
 * 動く」を担保する。#247: 分割後は deck.gl を含むチャンク側に現れるため、
 * 出力の全ファイルへ適用する。
 */
function neutralizedBundleCode(code: string, label: string): string {
  const before = findNodeImports(code);
  if (before.length === 0) return code;

  const neutralized = neutralizeNodeImports(code);
  const remaining = findNodeImports(neutralized);
  if (remaining.length > 0) {
    throw new Error(
      `${label} に中和しきれない node: 静的 import が残りました: ` +
        `${
          remaining.join(", ")
        }。neutralizeNodeImports が未対応の import 形の` +
        `可能性があります（ブラウザ実行時の白画面を防ぐため対応が必要）`,
    );
  }
  console.log(
    `node: 静的 import を中和しました（${label}）: ${before.join(", ")}`,
  );
  return neutralized;
}

/**
 * 旧ビルドのハッシュ付き JS（app.<hash>.js と分割チャンク。#246/#247）を
 * dist 直下から取り除く。残すと index.html が指さない孤児ファイルが蓄積し、
 * デプロイ物が肥大する。app.css はハッシュ付きパターンに一致しないため対象外。
 */
async function removeStaleHashedJs(distDir: string): Promise<void> {
  for await (const entry of Deno.readDir(distDir)) {
    if (
      entry.isFile && entry.name.endsWith(".js") &&
      isHashedAssetPath(`/${entry.name}`)
    ) {
      await Deno.remove(`${distDir}/${entry.name}`);
    }
  }
}

async function main(): Promise<void> {
  await Deno.mkdir(DIST_DIR, { recursive: true });
  // #247: code splitting で複数ファイルになるため、一時ディレクトリへ出力して
  // から node: import の中和とハッシュ付き改名を適用し、dist へ配置する
  const bundleDir = await Deno.makeTempDir({ prefix: "zeitreise-bundle-" });
  const files: Record<string, string> = {};
  try {
    await bundle(ENTRY, bundleDir);
    for await (const entry of Deno.readDir(bundleDir)) {
      if (!entry.isFile || !entry.name.endsWith(".js")) continue;
      files[entry.name] = neutralizedBundleCode(
        await Deno.readTextFile(`${bundleDir}/${entry.name}`),
        entry.name,
      );
    }
  } finally {
    await Deno.remove(bundleDir, { recursive: true });
  }
  if (files[ENTRY_EMITTED_NAME] === undefined) {
    throw new Error(
      `バンドル出力にエントリ ${ENTRY_EMITTED_NAME} がありません: ` +
        Object.keys(files).join(", "),
    );
  }
  const hashed = await hashBundleFiles(
    files,
    ENTRY_EMITTED_NAME,
    ENTRY_LOGICAL_NAME,
  );
  // #246: 論理パス → ハッシュ付きパスの対応表。JS 一式 / data/* の書き出しで
  // 埋め、manifest.json（唯一 no-cache の JSON）として dist へ生成する。
  const manifest: Record<string, string> = {};
  await removeStaleHashedJs(DIST_DIR);
  for (const file of hashed) {
    await Deno.writeTextFile(`${DIST_DIR}/${file.hashedName}`, file.code);
    manifest[`/${file.logicalName}`] = `/${file.hashedName}`;
  }
  await copyDataFiles(DIST_DIR, manifest);
  // #247: エントリの静的チャンク依存（ハッシュ付き名）を index.html の
  // modulepreload に載せ、エントリと並行して取得させる
  const hashedNameByEmitted = new Map(
    hashed.map((file) => [file.emittedName, file.hashedName]),
  );
  const preloadHashedNames = staticEntryChunkDeps(files, ENTRY_EMITTED_NAME)
    .map((name) => hashedNameByEmitted.get(name)!);
  // index.html の app.js 参照書き換えがあるため manifest を埋めた後にコピーする
  await copyStaticFiles(DIST_DIR, manifest, preloadHashedNames);
  await copyOptionalFiles(DIST_DIR);
  await Deno.writeTextFile(
    `${DIST_DIR}/manifest.json`,
    buildAssetManifestJson(manifest),
  );
  // TASK-127 / #246 / #247: Cloudflare Pages のヘッダ定義（CSP・Cache-Control）。
  // ハッシュ付きパス（/data/* と app.<hash>.js + 分割チャンク）は immutable、
  // それ以外は no-cache で配信する
  await Deno.writeTextFile(
    `${DIST_DIR}/_headers`,
    buildHeadersContent(
      hashed.map((file) => `/${file.hashedName}`).toSorted(),
    ),
  );
  console.log(`ビルド完了: ${DIST_DIR}/`);
}

if (import.meta.main) {
  await main();
}
