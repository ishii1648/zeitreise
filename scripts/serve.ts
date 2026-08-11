/**
 * dist/ をローカル配信する dev サーバ（`deno task serve`）。
 *
 * `jsr:@std/http/file-server` を直接起動していた頃は、ポートが埋まっていると
 * AddrInUse のスタックトレースだけを吐いて死んでいた（TASK-89）。占有していたのは
 * 大抵「後始末されずに残った別セッションの dev サーバ」であり、原因も対処も
 * 出力から読み取れなかった。
 *
 * 方針:
 * - 既定ポートは {@linkcode DEFAULT_PORT}。ポート番号の定義元はここ 1 箇所とし、
 *   検証ハーネス（scripts/verify/cdp.ts）もこの定数を参照する。
 * - ポートが占有されている場合は、既定では**黙って別ポートへ逃げない**。占有
 *   プロセス（PID・コマンド）と対処（再利用 / kill / --port / --auto-port）を
 *   示して exit 1 する。残存 dev サーバが増殖すると、旧ビルドを配信したまま
 *   実機スモークを誤判定させる事故につながるため（docs/agent-loop-recovery.md）。
 * - フォールバックが欲しい場合は `--auto-port` を明示する。起動ポートは
 *   どちらの経路でも標準出力に URL 付きで出す。
 *
 * 使い方:
 *   deno task serve                 # 既定ポートで起動（占有時は説明して終了）
 *   deno task serve --port 8011     # ポート指定
 *   deno task serve --auto-port     # 占有時は空きポートへフォールバック
 */

import { serveDir } from "@std/http/file-server";
import { IMMUTABLE_CACHE_CONTROL, isHashedAssetPath } from "./asset_hashing.ts";

/** dev サーバの既定ポート。ポート番号の単一定義元（TASK-89）。 */
export const DEFAULT_PORT = 8000;

/** 配信するディレクトリの既定値。 */
export const DEFAULT_ROOT = "dist";

/**
 * リクエストパスに応じた Cache-Control 値を返す（純粋関数。#246）。
 * 本番（Cloudflare Pages の `_headers`。scripts/build.ts buildHeadersContent）
 * と同じ方針をローカルでも再現する（docs/app-spec.md §3.4 は dev / 本番共通）:
 * - ハッシュ付きアセット（app.<hash>.js / data/*.<hash>.json|geojson）は
 *   immutable — 内容が変わればファイル名が変わるため再検証が不要
 * - それ以外（index.html / manifest.json / pmtiles 等）は no-cache —
 *   「キャッシュ禁止」ではなく「使用前に必ず再検証」で、部分キャッシュによる
 *   新旧データの不整合を防ぐ
 */
export function cacheControlFor(pathname: string): string {
  return isHashedAssetPath(pathname) ? IMMUTABLE_CACHE_CONTROL : "no-cache";
}

/**
 * 応答の Cache-Control をリクエストパスに応じて設定するミドルウェア（#246）。
 * serveDir の headers オプションは全応答一律のため、パスごとの出し分けは
 * この層で行う。304 等の body 無し応答でもヘッダだけ差し替えて返す。
 */
export function withCacheControl(
  handler: (req: Request) => Response | Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const res = await handler(req);
    const headers = new Headers(res.headers);
    headers.set("Cache-Control", cacheControlFor(new URL(req.url).pathname));
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };
}

export const USAGE = [
  "Usage: deno task serve [--port <n>] [--auto-port] [--root <dir>]",
  `  --port <n>    待ち受けポート（既定: ${DEFAULT_PORT}）`,
  "  --auto-port   ポートが使用中なら空きポートへフォールバックする",
  `  --root <dir>  配信ディレクトリ（既定: ${DEFAULT_ROOT}）`,
].join("\n");

export interface ServeConfig {
  port: number;
  autoPort: boolean;
  root: string;
  help: boolean;
}

/** ポートを占有しているプロセス。 */
export interface Occupant {
  pid: number;
  command: string;
}

/** Deno.serve の最小サブセット（テストで差し替えるための注入点）。 */
export interface ServerHandle {
  finished: Promise<void>;
  shutdown(): Promise<void>;
}

export type ServeFn = (
  options: {
    port: number;
    onListen?: (addr: { port: number; hostname: string }) => void;
  },
  handler: (req: Request) => Response | Promise<Response>,
) => ServerHandle;

export interface ServeDeps {
  serve?: ServeFn;
  findOccupants?: (port: number) => Promise<Occupant[]>;
  log?: (message: string) => void;
}

/** ポート占有により起動できなかったことを表す。message はそのまま利用者に出す。 */
export class PortInUseError extends Error {
  readonly port: number;
  readonly occupants: Occupant[];

  constructor(port: number, occupants: Occupant[]) {
    super(formatPortInUseMessage(port, occupants));
    this.name = "PortInUseError";
    this.port = port;
    this.occupants = occupants;
  }
}

// ---- 純ロジック ----

/** CLI 引数を解釈する。不正な入力は usage を含む例外を投げる。 */
export function parseServeArgs(args: string[]): ServeConfig {
  const config: ServeConfig = {
    port: DEFAULT_PORT,
    autoPort: false,
    root: DEFAULT_ROOT,
    help: false,
  };

  const fail = (reason: string): never => {
    throw new Error(`${reason}\n${USAGE}`);
  };

  const readValue = (i: number, inline: string | undefined, name: string) => {
    if (inline !== undefined) return { value: inline, next: i };
    const value = args[i + 1];
    if (value === undefined) fail(`${name} には値が必要です。`);
    return { value: value!, next: i + 1 };
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    const inline = arg.startsWith("--") && eq > 0
      ? arg.slice(eq + 1)
      : undefined;

    switch (name) {
      case "--help":
      case "-h":
        config.help = true;
        break;
      case "--auto-port":
        config.autoPort = true;
        break;
      case "--port": {
        const { value, next } = readValue(i, inline, "--port");
        const port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          fail(`--port には 0〜65535 の整数を指定してください: ${value}`);
        }
        config.port = port;
        i = next;
        break;
      }
      case "--root": {
        const { value, next } = readValue(i, inline, "--root");
        config.root = value;
        i = next;
        break;
      }
      default:
        fail(`不明なオプション: ${arg}`);
    }
  }

  return config;
}

/** `lsof -t` の出力（PID が 1 行 1 件）を重複なしの PID 配列にする。 */
export function parseLsofPids(output: string): number[] {
  const pids: number[] = [];
  for (const line of output.split("\n")) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

/** `ps -o pid=,command=` の出力を占有プロセス情報にする。 */
export function parsePsOutput(output: string): Occupant[] {
  const occupants: Occupant[] = [];
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    occupants.push({ pid: Number(match[1]), command: match[2].trim() });
  }
  return occupants;
}

/** ポート占有時に出す説明メッセージ（原因 + 対処）を組み立てる。 */
export function formatPortInUseMessage(
  port: number,
  occupants: Occupant[],
): string {
  const lines = [
    `dev サーバを起動できません: ポート ${port} は既に使用中です。`,
    "",
  ];

  if (occupants.length > 0) {
    lines.push("占有プロセス:");
    for (const o of occupants) {
      lines.push(`  PID ${o.pid}  ${o.command}`);
    }
  } else {
    lines.push(
      "占有プロセス: 特定できませんでした（lsof が無い / 実行権限が無い場合があります）",
    );
  }

  lines.push(
    "",
    "対処:",
    `  1. 既に同じ dist を配信中なら、そのまま http://localhost:${port}/ を使う`,
    `  2. 占有を確認する:  lsof -nP -iTCP:${port} -sTCP:LISTEN`,
  );
  if (occupants.length > 0) {
    lines.push(
      `  3. 停止する:        kill ${occupants.map((o) => o.pid).join(" ")}`,
    );
  } else {
    lines.push("  3. 停止する:        kill <PID>");
  }
  lines.push(
    `  4. 別ポートで起動:  deno task serve --port ${port + 1}`,
    "  5. 空きポートへ自動フォールバック:  deno task serve --auto-port",
  );

  return lines.join("\n");
}

// ---- 圧縮配信（TASK-128） ----
//
// 本番の Cloudflare はテキスト系アセットへ自動で圧縮（brotli/gzip）を適用する
// 一方、serveDir は無圧縮で配信するため、ローカルの体感と本番の実効転送量が
// 乖離していた。dev サーバでも Accept-Encoding に応じて圧縮して配信する。
//
// 方式は gzip（Web 標準 CompressionStream）を採用する:
// - Deno の CompressionStream は gzip/deflate のみ対応で、brotli には
//   node:zlib のストリーム接続が別途必要になる。
// - ブラウザの Accept-Encoding には常に gzip が含まれる（Chrome は
//   "gzip, deflate, br, zstd"）ため、gzip はすべてのブラウザと交渉可能。
// - 本タスクの目的は「本番（圧縮あり）に近い転送量でローカル計測する」ことで、
//   テキスト系アセットに対する gzip の圧縮率は brotli と 1 割前後の差に収まり
//   比較基盤としては十分。判定ロジック（chooseEncoding）は encoding を返す
//   設計にしてあり、brotli が必要になれば追加できる。

/** dev サーバが応答に適用する符号化方式。 */
export type ContentEncoding = "gzip" | "identity";

/**
 * 圧縮対象とみなす拡張子。テキスト系アセットのみで、pmtiles・png 等の
 * 圧縮済みバイナリは含めない（二重圧縮の禁止: AC#2）。
 */
export const COMPRESSIBLE_EXTENSIONS: readonly string[] = [
  ".html",
  ".css",
  ".js",
  ".mjs",
  ".json",
  ".geojson",
  ".svg",
  ".txt",
  ".xml",
  ".map",
];

/**
 * 圧縮対象とみなす Content-Type。拡張子を持たないパス（`/` → index.html 等）
 * でも serveDir が付けた Content-Type から圧縮可否を判定できるようにする。
 */
const COMPRESSIBLE_CONTENT_TYPE_RE =
  /^(text\/|application\/(json|geo\+json|javascript|xml)|image\/svg\+xml)/;

/**
 * Accept-Encoding ヘッダを受理可能な符号化方式名の配列にする（純粋関数）。
 * `gzip;q=0` のような明示的拒否（q=0）は除外し、名前は小文字に正規化する。
 */
export function parseAcceptEncoding(header: string | null): string[] {
  if (!header) return [];
  const names: string[] = [];
  for (const part of header.split(",")) {
    const [rawName, ...params] = part.split(";");
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    const q = params
      .map((p) => p.trim().toLowerCase())
      .find((p) => p.startsWith("q="))
      ?.slice(2);
    if (q !== undefined && Number(q) === 0) continue;
    names.push(name);
  }
  return names;
}

/**
 * リクエストパス・応答 Content-Type・Accept-Encoding から適用する符号化方式を
 * 決める純粋関数（AC#7）。テキスト系アセット（拡張子または Content-Type で
 * 判定）かつクライアントが gzip（または *）を受理する場合のみ "gzip" を返し、
 * pmtiles 等の圧縮済みバイナリはパスも Content-Type も該当しないため
 * "identity"（無圧縮）になる。
 */
export function chooseEncoding(input: {
  pathname: string;
  contentType: string | null;
  acceptEncoding: string | null;
}): ContentEncoding {
  const accepted = parseAcceptEncoding(input.acceptEncoding);
  if (!accepted.includes("gzip") && !accepted.includes("*")) return "identity";

  const pathname = input.pathname.toLowerCase();
  const byExtension = COMPRESSIBLE_EXTENSIONS.some((ext) =>
    pathname.endsWith(ext)
  );
  const byContentType = input.contentType !== null &&
    COMPRESSIBLE_CONTENT_TYPE_RE.test(input.contentType.toLowerCase());
  return byExtension || byContentType ? "gzip" : "identity";
}

/**
 * ハンドラの応答を Accept-Encoding に応じて gzip 圧縮するミドルウェア。
 * 以下は素通しする:
 * - chooseEncoding が identity と判定した応答（圧縮済みバイナリ等）
 * - 200 以外（206 Partial Content を圧縮すると Range のバイト位置が壊れる。
 *   304 等の body 無し応答も対象外）
 * - 既に Content-Encoding が付いた応答（二重圧縮の禁止）
 */
export function withCompression(
  handler: (req: Request) => Response | Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const res = await handler(req);
    const encoding = chooseEncoding({
      pathname: new URL(req.url).pathname,
      contentType: res.headers.get("Content-Type"),
      acceptEncoding: req.headers.get("Accept-Encoding"),
    });
    if (
      encoding === "identity" ||
      res.status !== 200 ||
      res.body === null ||
      res.headers.get("Content-Encoding") !== null
    ) {
      return res;
    }

    const headers = new Headers(res.headers);
    // 圧縮後の長さは事前に分からないため Content-Length は落とす
    // （chunked 転送になる）。
    headers.delete("Content-Length");
    headers.set("Content-Encoding", encoding);
    headers.append("Vary", "Accept-Encoding");
    const compressed = res.body.pipeThrough(
      new CompressionStream(encoding) as unknown as ReadableWritablePair<
        Uint8Array<ArrayBuffer>,
        Uint8Array<ArrayBufferLike>
      >,
    );
    return new Response(compressed, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };
}

// ---- 副作用あり（プロセス調査・起動） ----

async function runCommand(cmd: string, args: string[]): Promise<string | null> {
  try {
    const output = await new Deno.Command(cmd, {
      args,
      stdout: "piped",
      stderr: "null",
    }).output();
    return new TextDecoder().decode(output.stdout);
  } catch {
    // lsof/ps が無い、または --allow-run が与えられていない環境では諦める
    return null;
  }
}

/** lsof + ps でポートを占有しているプロセスを調べる。失敗時は空配列を返す。 */
export async function findOccupants(port: number): Promise<Occupant[]> {
  const lsof = await runCommand("lsof", [
    "-nP",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-t",
  ]);
  if (lsof === null) return [];
  const pids = parseLsofPids(lsof);
  if (pids.length === 0) return [];

  const ps = await runCommand("ps", [
    "-o",
    "pid=,command=",
    ...pids.flatMap((pid) => ["-p", String(pid)]),
  ]);
  if (ps === null) return pids.map((pid) => ({ pid, command: "(不明)" }));
  const occupants = parsePsOutput(ps);
  return occupants.length > 0
    ? occupants
    : pids.map((pid) => ({ pid, command: "(不明)" }));
}

/**
 * dist を配信するサーバを起動する。ポート占有時は、`autoPort` が真なら
 * 空きポート（port 0 の OS 割り当て）へフォールバックし、偽なら
 * {@linkcode PortInUseError} を投げる。起動ポートは log に URL 付きで出す。
 */
export async function startServer(
  config: ServeConfig,
  deps: ServeDeps = {},
): Promise<ServerHandle> {
  const serve = deps.serve ??
    ((options, handler) => Deno.serve(options, handler));
  const lookup = deps.findOccupants ?? findOccupants;
  const log = deps.log ?? ((m: string) => console.log(m));

  // TASK-128: 本番（Cloudflare の自動圧縮）に近い転送量で配信・計測できるよう、
  // テキスト系アセットは Accept-Encoding に応じて gzip 圧縮する。
  // #246: Cache-Control は本番 _headers と同じ方針でパスごとに出し分ける
  // （ハッシュ付きアセットは immutable、それ以外は no-cache）。
  const handler = withCompression(
    withCacheControl((req: Request) =>
      serveDir(req, {
        fsRoot: config.root,
        quiet: true,
      })
    ),
  );

  const onListen = (addr: { port: number }) => {
    log(`dev サーバを起動しました: http://localhost:${addr.port}/`);
    log(`  配信ディレクトリ: ${config.root}`);
    log(
      `  停止: Ctrl-C  /  他セッションからは lsof -nP -iTCP:${addr.port} -sTCP:LISTEN で PID を特定して kill`,
    );
  };

  try {
    return serve({ port: config.port, onListen }, handler);
  } catch (error) {
    if (!(error instanceof Deno.errors.AddrInUse)) throw error;
    if (!config.autoPort) {
      throw new PortInUseError(config.port, await lookup(config.port));
    }
    log(
      `ポート ${config.port} は使用中のため、空きポートへフォールバックします（--auto-port）。`,
    );
    return serve({ port: 0, onListen }, handler);
  }
}

// ---- CLI エントリポイント ----

if (import.meta.main) {
  let config: ServeConfig;
  try {
    config = parseServeArgs(Deno.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }

  if (config.help) {
    console.log(USAGE);
    Deno.exit(0);
  }

  try {
    await startServer(config);
  } catch (error) {
    if (error instanceof PortInUseError) {
      console.error(error.message);
      Deno.exit(1);
    }
    throw error;
  }
}
