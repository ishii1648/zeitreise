/**
 * CI ピン留め版 deno による fmt ラッパー（#262）。
 *
 * ローカルの deno（homebrew 最新、例: 2.9.5）と CI がピン留めする deno
 * （.github/workflows/ci.yml の deno-version）とで `deno fmt` の正準形が
 * 異なる（md の表の列幅・日本語文の折返し、index.html / app.css の整形）。
 * ローカルで整形済みでも CI の `deno fmt --check` が red になるため、
 * **CI と同一バージョンのバイナリをローカルで実行する**のが本スクリプト。
 *
 * 方式の決定（#262 AC2）: もう一方の案「CI の deno バージョンを最新へ更新して
 * 正準形差を解消する」は、全ファイル再整形の大差分を伴い、ローカル deno が
 * 更新されるたびに同じドリフトが再発する（ピン留めの意図＝正準形の再現性を
 * 崩す）ため見送った。ピン留めバージョンの正は ci.yml のみとし、本スクリプトは
 * ci.yml から**機械的に抽出**する（ci.yml 側の更新にスクリプト修正は不要）。
 *
 * 動作:
 *   1. ci.yml から `deno-version: "x.y.z"` を抽出（抽出関数は純粋関数。
 *      scripts/fmt_ci_test.ts でテスト）
 *   2. GitHub Releases から該当バージョン・現プラットフォームのリリース zip を
 *      `.outputs/claude/deno-pinned/<version>/` にキャッシュ
 *      （存在すれば再ダウンロードしない）
 *   3. 固定パス `.outputs/claude/deno-pinned/bin/deno` へ展開して実行する。
 *      固定パスなのは deno.json の `--allow-run` 許可リストを静的に書くため
 *      （バージョン入りパスは許可リストに書けない）。また Deno は
 *      --allow-run に列挙したパスへの in-process 書き込みを拒否するため、
 *      展開はサブプロセスの unzip に行わせる（zip をキャッシュとして残すのは
 *      バージョン切替時にここから再展開するため）
 *   4. 引数をそのまま `<pinned-deno> fmt` へ渡して実行し、終了コードを透過
 *
 * 使い方:
 *   deno task fmt:ci --check          # CI と同一判定の fmt チェック
 *   deno task fmt:ci <paths...>       # CI 正準形で整形
 */

const CI_YAML_PATH = ".github/workflows/ci.yml";
const CACHE_ROOT = ".outputs/claude/deno-pinned";
/** deno.json の --allow-run が静的に参照する固定パス（zip の展開先） */
const STABLE_BIN = `${CACHE_ROOT}/bin/deno`;
const STABLE_BIN_VERSION_MARKER = `${CACHE_ROOT}/bin/VERSION`;

/**
 * ci.yml のテキストからピン留め deno バージョン（完全な x.y.z）を抽出する。
 *
 * 抽出できない・範囲指定（"2.x" 等）・相異なる複数指定の場合は、黙って
 * フォールバックせず明確なエラーを投げる（fmt:ci の判定が CI と一致する
 * 保証が崩れるため）。
 */
export function extractPinnedDenoVersion(ciYaml: string): string {
  const matches = [
    ...ciYaml.matchAll(/^\s*deno-version:\s*"?([^"\s]+)"?\s*$/gm),
  ]
    .map((m) => m[1]);
  if (matches.length === 0) {
    throw new Error(
      `${CI_YAML_PATH} に deno-version 指定が見つからない（ピン留めバージョンを抽出できない）`,
    );
  }
  for (const v of matches) {
    if (!/^\d+\.\d+\.\d+$/.test(v)) {
      throw new Error(
        `deno-version "${v}" は完全な x.y.z のピン留めではない（範囲指定ではバイナリを一意に決定できない）`,
      );
    }
  }
  const distinct = [...new Set(matches)];
  if (distinct.length > 1) {
    throw new Error(
      `deno-version が複数の異なる値で指定されている: ${distinct.join(", ")}`,
    );
  }
  return distinct[0];
}

/** GitHub Releases にバイナリが存在する既知ターゲット（windows は対象外） */
const KNOWN_TARGETS = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-gnu",
];

/** 現プラットフォームのリリースアセット名（deno-<target>.zip）を返す */
export function releaseAssetName(target: string): string {
  if (!KNOWN_TARGETS.includes(target)) {
    throw new Error(
      `未対応のターゲット "${target}"（対応: ${KNOWN_TARGETS.join(", ")}）`,
    );
  }
  return `deno-${target}.zip`;
}

/** GitHub Releases のダウンロード URL を組み立てる */
export function releaseAssetUrl(version: string, target: string): string {
  return `https://github.com/denoland/deno/releases/download/v${version}/${
    releaseAssetName(target)
  }`;
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** キャッシュに無ければリリース zip をダウンロードし、zip のパスを返す */
async function ensurePinnedZip(version: string): Promise<string> {
  const dir = `${CACHE_ROOT}/${version}`;
  const zipPath = `${dir}/${releaseAssetName(Deno.build.target)}`;
  if (exists(zipPath)) return zipPath;

  const url = releaseAssetUrl(version, Deno.build.target);
  console.error(
    `fmt:ci: deno ${version} (${Deno.build.target}) をダウンロード中: ${url}`,
  );
  await Deno.mkdir(dir, { recursive: true });
  const res = await fetch(url);
  if (!res.ok || res.body === null) {
    throw new Error(`ダウンロード失敗: ${url} (HTTP ${res.status})`);
  }
  // 中断で壊れた zip をキャッシュ扱いしないよう、一時名に書いてから rename
  const tmpPath = `${zipPath}.tmp`;
  const file = await Deno.open(tmpPath, {
    write: true,
    create: true,
    truncate: true,
  });
  await res.body.pipeTo(file.writable);
  await Deno.rename(tmpPath, zipPath);
  return zipPath;
}

/**
 * --allow-run が静的に指す固定パス `bin/deno` へ zip から展開する。
 * バージョン更新時は VERSION マーカーの不一致で展開し直す。Deno は
 * --allow-run に列挙したパスへの in-process 書き込みを拒否する（許可済み
 * 実行ファイルの改竄防止）ため、書き込みは unzip サブプロセスが行う。
 */
async function ensureStableBin(
  version: string,
  zipPath: string,
): Promise<string> {
  const current = exists(STABLE_BIN_VERSION_MARKER)
    ? (await Deno.readTextFile(STABLE_BIN_VERSION_MARKER)).trim()
    : null;
  if (current === version && exists(STABLE_BIN)) return STABLE_BIN;

  await Deno.mkdir(`${CACHE_ROOT}/bin`, { recursive: true });
  const unzip = await new Deno.Command("unzip", {
    args: ["-o", "-q", zipPath, "deno", "-d", `${CACHE_ROOT}/bin`],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!unzip.success || !exists(STABLE_BIN)) {
    throw new Error(`unzip 失敗: ${zipPath} -> ${STABLE_BIN}`);
  }
  await Deno.writeTextFile(STABLE_BIN_VERSION_MARKER, `${version}\n`);
  return STABLE_BIN;
}

async function main(): Promise<never> {
  const ciYaml = await Deno.readTextFile(CI_YAML_PATH);
  const version = extractPinnedDenoVersion(ciYaml);
  const zipPath = await ensurePinnedZip(version);
  const stableBin = await ensureStableBin(version, zipPath);

  const { code } = await new Deno.Command(stableBin, {
    args: ["fmt", ...Deno.args],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  Deno.exit(code);
}

if (import.meta.main) {
  await main();
}
