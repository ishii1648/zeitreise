import {
  assertEquals,
  assertMatch,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  cacheControlFor,
  chooseEncoding,
  DEFAULT_PORT,
  DEFAULT_ROOT,
  formatPortInUseMessage,
  parseAcceptEncoding,
  parseLsofPids,
  parsePsOutput,
  parseServeArgs,
  PortInUseError,
  type ServeFn,
  type ServerHandle,
  startServer,
  withCacheControl,
  withCompression,
} from "./serve.ts";

// ---- parseServeArgs ----

Deno.test("parseServeArgs: 引数なしなら既定ポート・既定ルート・フォールバック無効", () => {
  assertEquals(parseServeArgs([]), {
    port: DEFAULT_PORT,
    autoPort: false,
    root: DEFAULT_ROOT,
    help: false,
  });
});

Deno.test("parseServeArgs: --port <n> でポートを上書きできる", () => {
  assertEquals(parseServeArgs(["--port", "8011"]).port, 8011);
});

Deno.test("parseServeArgs: --port=<n> 形式も受け付ける", () => {
  assertEquals(parseServeArgs(["--port=8011"]).port, 8011);
});

Deno.test("parseServeArgs: --auto-port で空きポートへのフォールバックを有効化する", () => {
  assertEquals(parseServeArgs(["--auto-port"]).autoPort, true);
});

Deno.test("parseServeArgs: --root で配信ディレクトリを上書きできる", () => {
  assertEquals(parseServeArgs(["--root", "public"]).root, "public");
});

Deno.test("parseServeArgs: --help は help フラグを立てる", () => {
  assertEquals(parseServeArgs(["--help"]).help, true);
});

Deno.test("parseServeArgs: 数値でない --port は usage 付きで例外を投げる", () => {
  assertThrows(() => parseServeArgs(["--port", "abc"]), Error, "Usage:");
});

Deno.test("parseServeArgs: 範囲外の --port は usage 付きで例外を投げる", () => {
  assertThrows(() => parseServeArgs(["--port", "70000"]), Error, "Usage:");
});

Deno.test("parseServeArgs: 未知のオプションは usage 付きで例外を投げる", () => {
  assertThrows(() => parseServeArgs(["--nope"]), Error, "Usage:");
});

// ---- 占有プロセス特定のパース ----

Deno.test("parseLsofPids: lsof -t の出力を PID 配列にする", () => {
  assertEquals(parseLsofPids("90136\n90137\n"), [90136, 90137]);
});

Deno.test("parseLsofPids: 空出力・非数値行は無視する", () => {
  assertEquals(parseLsofPids("\n  \nnot-a-pid\n42\n"), [42]);
});

Deno.test("parseLsofPids: 同一 PID の重複を除去する", () => {
  assertEquals(parseLsofPids("90136\n90136\n"), [90136]);
});

Deno.test("parsePsOutput: ps の pid/command 行を占有プロセス情報にする", () => {
  assertEquals(
    parsePsOutput("  90136 deno run --allow-net scripts/serve.ts\n"),
    [{ pid: 90136, command: "deno run --allow-net scripts/serve.ts" }],
  );
});

Deno.test("parsePsOutput: ヘッダ的な非数値行は無視する", () => {
  assertEquals(parsePsOutput("PID COMMAND\n42 deno\n"), [
    { pid: 42, command: "deno" },
  ]);
});

// ---- formatPortInUseMessage ----

Deno.test("formatPortInUseMessage: 占有 PID と停止コマンド・回避策を含む", () => {
  const msg = formatPortInUseMessage(8000, [
    { pid: 90136, command: "deno run --allow-net scripts/serve.ts" },
  ]);
  assertMatch(msg, /8000/);
  assertMatch(msg, /90136/);
  assertMatch(msg, /kill 90136/);
  assertMatch(msg, /lsof -nP -iTCP:8000 -sTCP:LISTEN/);
  assertMatch(msg, /--auto-port/);
  assertMatch(msg, /--port/);
  // 既存サーバの再利用という選択肢も提示する
  assertMatch(msg, /http:\/\/localhost:8000\//);
});

Deno.test("formatPortInUseMessage: 占有プロセスを特定できない場合も確認手順を出す", () => {
  const msg = formatPortInUseMessage(8000, []);
  assertMatch(msg, /特定できません/);
  assertMatch(msg, /lsof -nP -iTCP:8000 -sTCP:LISTEN/);
});

Deno.test("formatPortInUseMessage: スタックトレース調の文言を含まない", () => {
  const msg = formatPortInUseMessage(8000, [{ pid: 1, command: "deno" }]);
  assertEquals(msg.includes("AddrInUse"), false);
  assertEquals(msg.includes("    at "), false);
});

// ---- startServer（serve を注入して検証） ----

const stubHandle: ServerHandle = {
  finished: Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

function fakeServe(
  opts: { failOnPorts?: number[]; assignedPort?: number } = {},
): { serve: ServeFn; calls: number[] } {
  const calls: number[] = [];
  const serve: ServeFn = (options) => {
    calls.push(options.port);
    if (opts.failOnPorts?.includes(options.port)) {
      throw new Deno.errors.AddrInUse("Address already in use (os error 48)");
    }
    const bound = options.port === 0
      ? opts.assignedPort ?? 54321
      : options.port;
    options.onListen?.({ port: bound, hostname: "0.0.0.0" });
    return stubHandle;
  };
  return { serve, calls };
}

Deno.test("startServer: 空きポートなら起動し、起動 URL を標準出力に出す", async () => {
  const logs: string[] = [];
  const { serve, calls } = fakeServe();
  await startServer(
    { port: DEFAULT_PORT, autoPort: false, root: DEFAULT_ROOT, help: false },
    {
      serve,
      findOccupants: () => Promise.resolve([]),
      log: (m) => logs.push(m),
    },
  );
  assertEquals(calls, [DEFAULT_PORT]);
  assertMatch(logs.join("\n"), /http:\/\/localhost:8000\//);
});

Deno.test("startServer: ポート占有かつ既定（--auto-port なし）なら PortInUseError を投げる", async () => {
  const logs: string[] = [];
  const { serve, calls } = fakeServe({ failOnPorts: [DEFAULT_PORT] });
  const err = await assertRejects(
    () =>
      startServer(
        {
          port: DEFAULT_PORT,
          autoPort: false,
          root: DEFAULT_ROOT,
          help: false,
        },
        {
          serve,
          findOccupants: () =>
            Promise.resolve([{ pid: 90136, command: "deno run file-server" }]),
          log: (m) => logs.push(m),
        },
      ),
    PortInUseError,
  );
  assertMatch(err.message, /90136/);
  assertMatch(err.message, /kill 90136/);
  // 勝手に別ポートへ逃げない（起動試行は 1 回だけ）
  assertEquals(calls, [DEFAULT_PORT]);
});

Deno.test("startServer: --auto-port ならポート占有時に空きポートへフォールバックし、実ポートを出力する", async () => {
  const logs: string[] = [];
  const { serve, calls } = fakeServe({
    failOnPorts: [DEFAULT_PORT],
    assignedPort: 49152,
  });
  await startServer(
    { port: DEFAULT_PORT, autoPort: true, root: DEFAULT_ROOT, help: false },
    {
      serve,
      findOccupants: () => Promise.resolve([]),
      log: (m) => logs.push(m),
    },
  );
  assertEquals(calls, [DEFAULT_PORT, 0]);
  const out = logs.join("\n");
  assertMatch(out, /8000/); // 占有していた旨
  assertMatch(out, /http:\/\/localhost:49152\//);
});

Deno.test("startServer: AddrInUse 以外のエラーはそのまま伝播する", async () => {
  const serve: ServeFn = () => {
    throw new Deno.errors.PermissionDenied("nope");
  };
  await assertRejects(
    () =>
      startServer(
        {
          port: DEFAULT_PORT,
          autoPort: true,
          root: DEFAULT_ROOT,
          help: false,
        },
        { serve, findOccupants: () => Promise.resolve([]), log: () => {} },
      ),
    Deno.errors.PermissionDenied,
  );
});

// ---- 実ポートを塞いだ再現テスト（net 権限があるときのみ実行） ----

const netGranted = Deno.permissions.querySync({ name: "net" }).state ===
  "granted";

Deno.test({
  name: "再現: 実際にポートを塞いだ状態で起動すると PortInUseError になる",
  ignore: !netGranted,
  async fn() {
    const blocker = Deno.listen({ port: 0, hostname: "0.0.0.0" });
    const port = (blocker.addr as Deno.NetAddr).port;
    try {
      await assertRejects(
        () =>
          startServer(
            { port, autoPort: false, root: DEFAULT_ROOT, help: false },
            { log: () => {} },
          ),
        PortInUseError,
        String(port),
      );
    } finally {
      blocker.close();
    }
  },
});

Deno.test({
  name: "再現: --auto-port なら塞がれたポートでも別ポートで実際に起動する",
  ignore: !netGranted,
  async fn() {
    const blocker = Deno.listen({ port: 0, hostname: "0.0.0.0" });
    const port = (blocker.addr as Deno.NetAddr).port;
    const logs: string[] = [];
    try {
      const server = await startServer(
        { port, autoPort: true, root: DEFAULT_ROOT, help: false },
        { log: (m) => logs.push(m) },
      );
      const bound = logs.join("\n").match(/http:\/\/localhost:(\d+)\//)?.[1];
      assertEquals(typeof bound, "string");
      assertEquals(bound === String(port), false);
      await server.shutdown();
    } finally {
      blocker.close();
    }
  },
});

// ---- TASK-128: 圧縮配信 ----

// Chrome が実際に送る Accept-Encoding ヘッダ
const CHROME_ACCEPT_ENCODING = "gzip, deflate, br, zstd";

// ---- parseAcceptEncoding ----

Deno.test("parseAcceptEncoding: null（ヘッダ無し）なら空配列", () => {
  assertEquals(parseAcceptEncoding(null), []);
});

Deno.test("parseAcceptEncoding: Chrome の実ヘッダを名前の配列にする", () => {
  assertEquals(parseAcceptEncoding(CHROME_ACCEPT_ENCODING), [
    "gzip",
    "deflate",
    "br",
    "zstd",
  ]);
});

Deno.test("parseAcceptEncoding: q=0 の符号化方式は除外する", () => {
  assertEquals(parseAcceptEncoding("gzip;q=0, br"), ["br"]);
});

Deno.test("parseAcceptEncoding: q 値付き（q>0）は含める", () => {
  assertEquals(parseAcceptEncoding("gzip;q=0.5, identity;q=1.0"), [
    "gzip",
    "identity",
  ]);
});

Deno.test("parseAcceptEncoding: 大文字・余分な空白を正規化する", () => {
  assertEquals(parseAcceptEncoding("  GZip ,  BR "), ["gzip", "br"]);
});

// ---- chooseEncoding ----

Deno.test("chooseEncoding: テキスト系拡張子（.html/.css/.js/.json/.geojson）は gzip", () => {
  for (
    const path of [
      "/index.html",
      "/app.css",
      "/app.js",
      "/data/index.json",
      "/data/base_outline_1000.geojson",
    ]
  ) {
    assertEquals(
      chooseEncoding({
        pathname: path,
        contentType: null,
        acceptEncoding: CHROME_ACCEPT_ENCODING,
      }),
      "gzip",
      path,
    );
  }
});

Deno.test("chooseEncoding: 圧縮済みバイナリ（.pmtiles/.png/.jpg/.woff2）は無圧縮", () => {
  for (
    const path of [
      "/europe.pmtiles",
      "/europe-dem.pmtiles",
      "/icon.png",
      "/photo.jpg",
      "/font.woff2",
    ]
  ) {
    assertEquals(
      chooseEncoding({
        pathname: path,
        contentType: "application/octet-stream",
        acceptEncoding: CHROME_ACCEPT_ENCODING,
      }),
      "identity",
      path,
    );
  }
});

Deno.test("chooseEncoding: 拡張子なしパス（/）でも Content-Type がテキスト系なら gzip", () => {
  assertEquals(
    chooseEncoding({
      pathname: "/",
      contentType: "text/html; charset=UTF-8",
      acceptEncoding: CHROME_ACCEPT_ENCODING,
    }),
    "gzip",
  );
});

Deno.test("chooseEncoding: Content-Type が application/geo+json なら gzip", () => {
  assertEquals(
    chooseEncoding({
      pathname: "/data/rivers",
      contentType: "application/geo+json",
      acceptEncoding: CHROME_ACCEPT_ENCODING,
    }),
    "gzip",
  );
});

Deno.test("chooseEncoding: Accept-Encoding が無い場合は無圧縮", () => {
  assertEquals(
    chooseEncoding({
      pathname: "/app.js",
      contentType: "text/javascript",
      acceptEncoding: null,
    }),
    "identity",
  );
});

Deno.test("chooseEncoding: Accept-Encoding に gzip が含まれない場合は無圧縮", () => {
  assertEquals(
    chooseEncoding({
      pathname: "/app.js",
      contentType: "text/javascript",
      acceptEncoding: "br, zstd",
    }),
    "identity",
  );
});

Deno.test("chooseEncoding: Accept-Encoding のワイルドカード * は gzip を許可する", () => {
  assertEquals(
    chooseEncoding({
      pathname: "/app.js",
      contentType: "text/javascript",
      acceptEncoding: "*",
    }),
    "gzip",
  );
});

// ---- withCompression ----

async function gunzip(body: ReadableStream<Uint8Array>): Promise<string> {
  const decompressed = body.pipeThrough(
    new DecompressionStream("gzip") as unknown as ReadableWritablePair<
      Uint8Array<ArrayBuffer>,
      Uint8Array<ArrayBufferLike>
    >,
  );
  return await new Response(decompressed).text();
}

function requestFor(path: string, acceptEncoding?: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: acceptEncoding ? { "Accept-Encoding": acceptEncoding } : {},
  });
}

Deno.test("withCompression: テキスト応答は gzip され、往復で内容が一致する", async () => {
  const original = JSON.stringify({ hello: "world".repeat(100) });
  const handler = withCompression(() =>
    new Response(original, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
  const res = await handler(
    requestFor("/data/index.json", CHROME_ACCEPT_ENCODING),
  );
  assertEquals(res.headers.get("Content-Encoding"), "gzip");
  assertEquals(res.headers.get("Content-Length"), null);
  assertMatch(res.headers.get("Vary") ?? "", /Accept-Encoding/);
  assertEquals(await gunzip(res.body!), original);
});

Deno.test("withCompression: pmtiles（圧縮済みバイナリ）は素通しする", async () => {
  const handler = withCompression(() =>
    new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    })
  );
  const res = await handler(
    requestFor("/europe.pmtiles", CHROME_ACCEPT_ENCODING),
  );
  assertEquals(res.headers.get("Content-Encoding"), null);
  assertEquals(
    new Uint8Array(await res.arrayBuffer()),
    new Uint8Array([1, 2, 3]),
  );
});

Deno.test("withCompression: 206 Partial Content（Range 応答）は圧縮しない", async () => {
  const handler = withCompression(() =>
    new Response("chunk", {
      status: 206,
      headers: { "Content-Type": "text/html" },
    })
  );
  const res = await handler(requestFor("/index.html", CHROME_ACCEPT_ENCODING));
  assertEquals(res.headers.get("Content-Encoding"), null);
  assertEquals(await res.text(), "chunk");
});

Deno.test("withCompression: 304 Not Modified（body 無し）は素通しする", async () => {
  const handler = withCompression(() =>
    new Response(null, {
      status: 304,
      headers: { "Content-Type": "text/html" },
    })
  );
  const res = await handler(requestFor("/index.html", CHROME_ACCEPT_ENCODING));
  assertEquals(res.status, 304);
  assertEquals(res.headers.get("Content-Encoding"), null);
});

Deno.test("withCompression: Accept-Encoding 無しのリクエストには圧縮しない", async () => {
  const handler = withCompression(() =>
    new Response("plain", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })
  );
  const res = await handler(requestFor("/index.html"));
  assertEquals(res.headers.get("Content-Encoding"), null);
  assertEquals(await res.text(), "plain");
});

Deno.test("withCompression: 既に Content-Encoding が付いた応答は二重圧縮しない", async () => {
  const handler = withCompression(() =>
    new Response(new Uint8Array([31, 139]), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      },
    })
  );
  const res = await handler(
    requestFor("/data/index.json", CHROME_ACCEPT_ENCODING),
  );
  assertEquals(res.headers.get("Content-Encoding"), "gzip");
  assertEquals(
    new Uint8Array(await res.arrayBuffer()),
    new Uint8Array([31, 139]),
  );
});

// ---- cacheControlFor / withCacheControl（#246） ----

Deno.test("cacheControlFor: ハッシュ付きアセットは immutable、それ以外は no-cache（#246）", () => {
  assertEquals(
    cacheControlFor("/app.0123456789.js"),
    "public, max-age=31536000, immutable",
  );
  assertEquals(
    cacheControlFor("/data/europe_1000.abcdef0123.geojson"),
    "public, max-age=31536000, immutable",
  );
  // 論理パス・manifest・index.html・pmtiles は従来どおり再検証運用
  assertEquals(cacheControlFor("/"), "no-cache");
  assertEquals(cacheControlFor("/index.html"), "no-cache");
  assertEquals(cacheControlFor("/manifest.json"), "no-cache");
  assertEquals(cacheControlFor("/app.js"), "no-cache");
  assertEquals(cacheControlFor("/data/colors.json"), "no-cache");
  assertEquals(cacheControlFor("/europe.pmtiles"), "no-cache");
});

Deno.test("withCacheControl: 応答の Cache-Control をリクエストパスに応じて設定する（#246）", async () => {
  const handler = withCacheControl(() =>
    Promise.resolve(new Response("body", { status: 200 }))
  );
  const immutable = await handler(
    new Request("http://localhost:8000/data/colors.abcdef0123.json"),
  );
  assertEquals(
    immutable.headers.get("Cache-Control"),
    "public, max-age=31536000, immutable",
  );
  await immutable.body?.cancel();
  const noCache = await handler(
    new Request("http://localhost:8000/index.html"),
  );
  assertEquals(noCache.headers.get("Cache-Control"), "no-cache");
  await noCache.body?.cancel();
});

Deno.test("withCacheControl: body の無い 304 応答でも壊れない（#246）", async () => {
  const handler = withCacheControl(() =>
    Promise.resolve(new Response(null, { status: 304 }))
  );
  const res = await handler(new Request("http://localhost:8000/index.html"));
  assertEquals(res.status, 304);
  assertEquals(res.headers.get("Cache-Control"), "no-cache");
});
