/**
 * dist/ ビルドスクリプト。
 * - src/main.ts を deno bundle でブラウザ向けにバンドルし dist/app.js を生成
 * - index.html / app.css を dist/ にコピー
 */

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
const BUNDLE_OUT = `${DIST_DIR}/app.js`;

/** dist/ にそのままコピーする静的ファイルの一覧を返す（純粋関数） */
export function getStaticCopyTargets(
  distDir: string,
): Array<{ from: string; to: string }> {
  return [
    { from: "index.html", to: `${distDir}/index.html` },
    { from: "app.css", to: `${distDir}/app.css` },
    { from: "vendor/maplibre-gl.css", to: `${distDir}/vendor/maplibre-gl.css` },
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
    // TASK-33: 年代ごとの歴史解説パネル用テキスト
    { from: "data/notes.json", to: `${distDir}/data/notes.json` },
    // TASK-46: データの既知の制限（表示できない情報）一覧
    {
      from: "data/known-limitations.json",
      to: `${distDir}/data/known-limitations.json`,
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
 * Cloudflare Pages の `_headers` ファイル内容を返す（純粋関数。TASK-127）。
 *
 * - Cache-Control: no-cache — 全アセットをエッジ/ブラウザで再検証（304）運用に
 *   する（docs/app-spec.md §3.4。部分キャッシュ不整合による表示破壊の防止）
 * - Content-Security-Policy（docs/app-spec.md §6）:
 *   - connect-src はアプリが実際に fetch する外部オリジンのみ:
 *     R2 タイル配信（TILES_ORIGIN）と PMTiles 失敗時フォールバックの
 *     OpenFreeMap（FALLBACK_STYLE_URL のオリジン。style JSON / TileJSON /
 *     タイル / glyphs / sprite すべて同一オリジンで配信されることを確認済み）
 *   - script-src 'self'（インラインスクリプトなし）
 *   - worker-src 'self' blob: — MapLibre/deck.gl が blob URL から Worker を
 *     生成する。child-src は worker-src 未対応の旧 Safari 向けフォールバック
 *   - img-src に data: blob: — MapLibre の画像リソース（フォールバック
 *     スタイルの sprite 等）が blob/data URL 経由で読み込まれるため
 *   - style-src に 'unsafe-inline' — MapLibre/deck.gl はランタイムで
 *     インラインスタイルを操作する。script-src が 'self' で固定されている限り
 *     XSS 面での後退は小さく、本番のみで発生する描画破壊（ローカル開発では
 *     CSP が適用されず再現不能）を避ける方を優先する
 */
export function buildHeadersContent(): string {
  const fallbackOrigin = new URL(FALLBACK_STYLE_URL).origin;
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    `connect-src 'self' ${TILES_ORIGIN} ${fallbackOrigin}`,
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  return [
    "/*",
    "  Cache-Control: no-cache",
    `  Content-Security-Policy: ${csp}`,
    "  X-Content-Type-Options: nosniff",
    "",
  ].join("\n");
}

/** `deno bundle` に渡す引数一覧を返す（純粋関数） */
export function buildBundleArgs(entry: string, outFile: string): string[] {
  return ["bundle", "--platform", "browser", entry, "-o", outFile];
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

async function bundle(entry: string, outFile: string): Promise<void> {
  const args = buildBundleArgs(entry, outFile);
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

async function copyStaticFiles(distDir: string): Promise<void> {
  for (const { from, to } of getStaticCopyTargets(distDir)) {
    // dist/vendor/ など、コピー先の親ディレクトリを先に作成する
    const parentDir = to.slice(0, to.lastIndexOf("/"));
    await Deno.mkdir(parentDir, { recursive: true });
    await Deno.copyFile(from, to);
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

async function copyDataFiles(distDir: string): Promise<void> {
  await Deno.mkdir(`${distDir}/data`, { recursive: true });
  for (const { from, to } of productionDataCopyTargets(distDir)) {
    await Deno.copyFile(from, to);
  }
}

/**
 * バンドル出力の `node:` 静的 import を中和し、残存が無いことを保証する。
 * 残っているとブラウザで module graph 全体の評価が失敗する（白画面）ため、
 * 中和後も 1 つでも残ればビルドを fail させ「ビルド成功 = ブラウザで動く」を担保する。
 */
async function stripNodeImports(outFile: string): Promise<void> {
  const original = await Deno.readTextFile(outFile);
  const before = findNodeImports(original);
  if (before.length === 0) return;

  const neutralized = neutralizeNodeImports(original);
  const remaining = findNodeImports(neutralized);
  if (remaining.length > 0) {
    throw new Error(
      `${outFile} に中和しきれない node: 静的 import が残りました: ` +
        `${
          remaining.join(", ")
        }。neutralizeNodeImports が未対応の import 形の` +
        `可能性があります（ブラウザ実行時の白画面を防ぐため対応が必要）`,
    );
  }
  await Deno.writeTextFile(outFile, neutralized);
  console.log(`node: 静的 import を中和しました: ${before.join(", ")}`);
}

async function main(): Promise<void> {
  await Deno.mkdir(DIST_DIR, { recursive: true });
  await bundle(ENTRY, BUNDLE_OUT);
  await stripNodeImports(BUNDLE_OUT);
  // TASK-127: Cloudflare Pages のヘッダ定義（CSP・Cache-Control）を生成する
  await Deno.writeTextFile(`${DIST_DIR}/_headers`, buildHeadersContent());
  await copyStaticFiles(DIST_DIR);
  await copyDataFiles(DIST_DIR);
  await copyOptionalFiles(DIST_DIR);
  console.log(`ビルド完了: ${DIST_DIR}/`);
}

if (import.meta.main) {
  await main();
}
