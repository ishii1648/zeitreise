import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  buildBundleArgs,
  buildHeadersContent,
  findNodeImports,
  getDataCopyTargets,
  getOptionalCopyTargets,
  getStaticCopyTargets,
  manifestKeyFor,
  neutralizeNodeImports,
  productionDataCopyTargets,
} from "./build.ts";
import { FALLBACK_STYLE_URL } from "../src/config.ts";
import { TILES_ORIGIN } from "../src/pmtiles_url.ts";

Deno.test("getStaticCopyTargets は index.html / app.css / vendor CSS を dist/ にコピーする対象を返す", () => {
  const targets = getStaticCopyTargets("dist");
  assertEquals(targets, [
    { from: "index.html", to: "dist/index.html" },
    { from: "app.css", to: "dist/app.css" },
    { from: "vendor/maplibre-gl.css", to: "dist/vendor/maplibre-gl.css" },
  ]);
});

Deno.test("getStaticCopyTargets は distDir を反映する", () => {
  const targets = getStaticCopyTargets("out");
  assertEquals(targets, [
    { from: "index.html", to: "out/index.html" },
    { from: "app.css", to: "out/app.css" },
    { from: "vendor/maplibre-gl.css", to: "out/vendor/maplibre-gl.css" },
  ]);
});

Deno.test("getOptionalCopyTargets は data/ の pmtiles（ベースマップ・DEM）を dist/ にコピーする対象を返す", () => {
  const targets = getOptionalCopyTargets("dist");
  assertEquals(targets, [
    { from: "data/europe.pmtiles", to: "dist/europe.pmtiles" },
    // TASK-34: 地形（起伏・陰影）用 DEM タイル（deno task extract-dem で生成）
    { from: "data/europe-dem.pmtiles", to: "dist/europe-dem.pmtiles" },
  ]);
});

Deno.test("getOptionalCopyTargets は distDir を反映する", () => {
  const targets = getOptionalCopyTargets("out");
  assertEquals(targets, [
    { from: "data/europe.pmtiles", to: "out/europe.pmtiles" },
    { from: "data/europe-dem.pmtiles", to: "out/europe-dem.pmtiles" },
  ]);
});

Deno.test("getDataCopyTargets は index.json / colors.json と各年代 GeoJSON を dist/data/ にコピーする対象を返す", () => {
  const targets = getDataCopyTargets("dist", [1000, 1100], [1500, 1530], [
    1200,
  ]);
  assertEquals(targets, [
    { from: "data/index.json", to: "dist/data/index.json" },
    { from: "data/colors.json", to: "dist/data/colors.json" },
    {
      from: "data/name-overrides.json",
      to: "dist/data/name-overrides.json",
    },
    // TASK-23: 勢力名の日本語表記マップ（英語 NAME → 日本語名）
    { from: "data/name-ja.json", to: "dist/data/name-ja.json" },
    // TASK-21: 主要河川オーバーレイ用の GeoJSON（deno task build-rivers で生成）
    { from: "data/rivers.geojson", to: "dist/data/rivers.geojson" },
    // TASK-97: 主要山脈ポリゴン（deno task build-mountains で生成、年代非依存）
    { from: "data/mountains.geojson", to: "dist/data/mountains.geojson" },
    // TASK-99: 主要山峰マーカー（deno task build-peaks で生成、年代非依存）
    { from: "data/peaks.geojson", to: "dist/data/peaks.geojson" },
    // TASK-27: 各年代の主要都市マーカー（deno task build-cities で生成）
    { from: "data/cities.json", to: "dist/data/cities.json" },
    // TASK-33: 年代ごとの歴史解説パネル用テキスト
    { from: "data/notes.json", to: "dist/data/notes.json" },
    // TASK-46: データの既知の制限（表示できない情報）一覧
    {
      from: "data/known-limitations.json",
      to: "dist/data/known-limitations.json",
    },
    { from: "data/europe_1000.geojson", to: "dist/data/europe_1000.geojson" },
    { from: "data/europe_1100.geojson", to: "dist/data/europe_1100.geojson" },
    // TASK-19: HRE 主要領邦オーバーレイ用の GeoJSON（deno task build-hre で生成）
    { from: "data/hre_1500.geojson", to: "dist/data/hre_1500.geojson" },
    { from: "data/hre_1530.geojson", to: "dist/data/hre_1530.geojson" },
    // TASK-71: 中世フランス諸侯領オーバーレイ（deno task build-france-fiefs で生成）
    {
      from: "data/france_fiefs_flat_1200.geojson",
      to: "dist/data/france_fiefs_flat_1200.geojson",
    },
    // TASK-78: 諸侯領との二重輪郭・二重ラベルを解消する派生データ
    // （deno task build-fief-dedupe で生成）
    { from: "data/fief-dedupe.json", to: "dist/data/fief-dedupe.json" },
    {
      from: "data/base_outline_1200.geojson",
      to: "dist/data/base_outline_1200.geojson",
    },
    // TASK-92: 諸侯領の下地になる base 塗りを差し引いた派生 base
    {
      from: "data/europe_flat_1200.geojson",
      to: "dist/data/europe_flat_1200.geojson",
    },
  ]);
});

Deno.test("getDataCopyTargets は fiefYears 省略時に fief-dedupe と base_outline を含めない（TASK-78 AC #3）", () => {
  const targets = getDataCopyTargets("dist", [1000], [1500]);
  assertEquals(
    targets.filter((t) =>
      t.from.includes("fief-dedupe") || t.from.includes("base_outline")
    ),
    [],
  );
});

Deno.test("getDataCopyTargets は distDir を反映する", () => {
  const targets = getDataCopyTargets("out", [1492], [1650], [1279]);
  assertEquals(targets, [
    { from: "data/index.json", to: "out/data/index.json" },
    { from: "data/colors.json", to: "out/data/colors.json" },
    { from: "data/name-overrides.json", to: "out/data/name-overrides.json" },
    { from: "data/name-ja.json", to: "out/data/name-ja.json" },
    { from: "data/rivers.geojson", to: "out/data/rivers.geojson" },
    { from: "data/mountains.geojson", to: "out/data/mountains.geojson" },
    { from: "data/peaks.geojson", to: "out/data/peaks.geojson" },
    { from: "data/cities.json", to: "out/data/cities.json" },
    { from: "data/notes.json", to: "out/data/notes.json" },
    {
      from: "data/known-limitations.json",
      to: "out/data/known-limitations.json",
    },
    { from: "data/europe_1492.geojson", to: "out/data/europe_1492.geojson" },
    { from: "data/hre_1650.geojson", to: "out/data/hre_1650.geojson" },
    {
      from: "data/france_fiefs_flat_1279.geojson",
      to: "out/data/france_fiefs_flat_1279.geojson",
    },
    { from: "data/fief-dedupe.json", to: "out/data/fief-dedupe.json" },
    {
      from: "data/base_outline_1279.geojson",
      to: "out/data/base_outline_1279.geojson",
    },
    // TASK-92: 諸侯領の下地になる base 塗りを差し引いた派生 base
    {
      from: "data/europe_flat_1279.geojson",
      to: "out/data/europe_flat_1279.geojson",
    },
  ]);
});

Deno.test("getDataCopyTargets は fiefYears 省略時に france_fiefs を含めない（後方互換）", () => {
  const targets = getDataCopyTargets("dist", [1000], [1500]);
  assertEquals(
    targets.filter((t) => t.from.includes("france_fiefs")),
    [],
  );
});

Deno.test("getDataCopyTargets は hreFiefYears の hre_fiefs_flat をコピー対象に含める（TASK-86 AC #1）", () => {
  const targets = getDataCopyTargets("dist", [1400], [1500], [], [1400, 1492]);
  assertEquals(
    targets.filter((t) => t.from.includes("hre_fiefs_flat")),
    [
      {
        from: "data/hre_fiefs_flat_1400.geojson",
        to: "dist/data/hre_fiefs_flat_1400.geojson",
      },
      {
        from: "data/hre_fiefs_flat_1492.geojson",
        to: "dist/data/hre_fiefs_flat_1492.geojson",
      },
    ],
  );
  // OHM 由来の生データ（hre_fiefs_<year>）は派生データの入力なので dist に含めない
  assertEquals(
    targets.filter((t) => /hre_fiefs_\d/.test(t.from)),
    [],
  );
});

Deno.test("getDataCopyTargets は britainFiefYears の britain_fiefs_flat をコピー対象に含める（#172）", () => {
  const targets = getDataCopyTargets(
    "dist",
    [1600],
    [1600],
    [],
    [],
    [],
    [],
    [1600, 1700],
  );
  assertEquals(
    targets.filter((t) => t.from.includes("britain_fiefs_flat")),
    [
      {
        from: "data/britain_fiefs_flat_1600.geojson",
        to: "dist/data/britain_fiefs_flat_1600.geojson",
      },
      {
        from: "data/britain_fiefs_flat_1700.geojson",
        to: "dist/data/britain_fiefs_flat_1700.geojson",
      },
    ],
  );
  // OHM 由来の生データ（britain_fiefs_<year>）は派生データの入力なので
  // dist に含めない
  assertEquals(
    targets.filter((t) => /britain_fiefs_\d/.test(t.from)),
    [],
  );
  // #172: 近世（1600〜1700）もブリテンのオーバーレイがあるため、二重塗り・
  // 二重輪郭を解消する派生データ（fief-dedupe / base_outline / europe_flat）が
  // ブリテンの年集合からも導出される
  assertEquals(
    targets.filter((t) => t.from.includes("fief-dedupe")).length,
    1,
  );
  assertEquals(
    targets.filter((t) =>
      t.from.includes("base_outline") || t.from.includes("europe_flat")
    ),
    [
      {
        from: "data/base_outline_1600.geojson",
        to: "dist/data/base_outline_1600.geojson",
      },
      {
        from: "data/europe_flat_1600.geojson",
        to: "dist/data/europe_flat_1600.geojson",
      },
      {
        from: "data/base_outline_1700.geojson",
        to: "dist/data/base_outline_1700.geojson",
      },
      {
        from: "data/europe_flat_1700.geojson",
        to: "dist/data/europe_flat_1700.geojson",
      },
    ],
  );
});

Deno.test("getDataCopyTargets は sovereignFiefYears の sovereign_fiefs_flat をコピー対象に含める（#189）", () => {
  const targets = getDataCopyTargets(
    "dist",
    [1815],
    [1815],
    [],
    [],
    [],
    [],
    [],
    [1815, 1880],
  );
  assertEquals(
    targets.filter((t) => t.from.includes("sovereign_fiefs_flat")),
    [
      {
        from: "data/sovereign_fiefs_flat_1815.geojson",
        to: "dist/data/sovereign_fiefs_flat_1815.geojson",
      },
      {
        from: "data/sovereign_fiefs_flat_1880.geojson",
        to: "dist/data/sovereign_fiefs_flat_1880.geojson",
      },
    ],
  );
  // OHM 由来の生データ（sovereign_fiefs_<year>）は派生データの入力なので
  // dist に含めない
  assertEquals(
    targets.filter((t) => /sovereign_fiefs_\d/.test(t.from)),
    [],
  );
  // #189: 1815 / 1880 / 1900 にも主権政体オーバーレイがあるため、二重塗り・
  // 二重輪郭を解消する派生データ（base_outline / europe_flat）が主権政体の
  // 年集合からも導出される
  assertEquals(
    targets.filter((t) =>
      t.from.includes("base_outline") || t.from.includes("europe_flat")
    ),
    [
      {
        from: "data/base_outline_1815.geojson",
        to: "dist/data/base_outline_1815.geojson",
      },
      {
        from: "data/europe_flat_1815.geojson",
        to: "dist/data/europe_flat_1815.geojson",
      },
      {
        from: "data/base_outline_1880.geojson",
        to: "dist/data/base_outline_1880.geojson",
      },
      {
        from: "data/europe_flat_1880.geojson",
        to: "dist/data/europe_flat_1880.geojson",
      },
    ],
  );
});

Deno.test("getDataCopyTargets は base_outline を仏諸侯領年と HRE 領邦年の和集合で出す（TASK-86 AC #3）", () => {
  const targets = getDataCopyTargets(
    "dist",
    [1300],
    [1500],
    [1300],
    [1300, 1492],
  );
  assertEquals(
    targets.filter((t) => t.from.includes("base_outline")).map((t) => t.from),
    ["data/base_outline_1300.geojson", "data/base_outline_1492.geojson"],
  );
  assertEquals(
    targets.filter((t) => t.from.includes("fief-dedupe")).length,
    1,
  );
});

Deno.test("getDataCopyTargets は hreFiefYears のみでも fief-dedupe / base_outline を出す（TASK-86）", () => {
  const targets = getDataCopyTargets("dist", [1492], [1500], [], [1492]);
  assertEquals(
    targets.filter((t) =>
      t.from.includes("fief-dedupe") || t.from.includes("base_outline")
    ).map((t) => t.from),
    ["data/fief-dedupe.json", "data/base_outline_1492.geojson"],
  );
});

Deno.test("findNodeImports は node: の静的 import specifier を重複なく列挙する", () => {
  const code = [
    `import * as WorkerThreads from "node:worker_threads";`,
    `import ChildProcess from "node:child_process";`,
    `import * as stream from "node:stream";`,
    `import * as WorkerThreads2 from "node:worker_threads";`,
    `import { GeoJsonLayer } from "@deck.gl/layers";`,
  ].join("\n");
  assertEquals(findNodeImports(code), [
    "node:child_process",
    "node:stream",
    "node:worker_threads",
  ]);
});

Deno.test("findNodeImports は re-export（export ... from）の node: も検出する", () => {
  const code =
    `export * from "node:stream";\nexport { x } from 'node:child_process';`;
  assertEquals(findNodeImports(code), [
    "node:child_process",
    "node:stream",
  ]);
});

Deno.test("findNodeImports は node: 静的 import が無ければ空配列を返す", () => {
  const code = [
    `import { MapboxOverlay } from "@deck.gl/mapbox";`,
    `const s = "node:stream is just a string literal, not an import";`,
  ].join("\n");
  assertEquals(findNodeImports(code), []);
});

Deno.test("neutralizeNodeImports は namespace import を空オブジェクト束縛に置換する", () => {
  const out = neutralizeNodeImports(
    `import * as WorkerThreads from "node:worker_threads";`,
  );
  assertEquals(findNodeImports(out), []);
  // 束縛名は残す（WorkerThreads.parentPort 等の参照が undefined になるだけで落ちない）
  assert(out.includes("const WorkerThreads = {}"));
});

Deno.test("neutralizeNodeImports は default import を空オブジェクト束縛に置換する", () => {
  const out = neutralizeNodeImports(
    `import ChildProcess from "node:child_process";`,
  );
  assertEquals(findNodeImports(out), []);
  assert(out.includes("const ChildProcess = {}"));
});

Deno.test("neutralizeNodeImports は named import を分割束縛に置換する", () => {
  const out = neutralizeNodeImports(
    `import { Readable, Writable as W } from "node:stream";`,
  );
  assertEquals(findNodeImports(out), []);
  assert(out.includes("Readable"));
  assert(out.includes("Writable: W") || out.includes("Writable:W"));
});

Deno.test("neutralizeNodeImports は副作用 import を除去する", () => {
  const out = neutralizeNodeImports(`import "node:worker_threads";\nfoo();`);
  assertEquals(findNodeImports(out), []);
  assert(out.includes("foo();"));
});

Deno.test("neutralizeNodeImports は node: 以外の import を保持する", () => {
  const code =
    `import { GeoJsonLayer } from "@deck.gl/layers";\nimport * as s from "node:stream";\n`;
  const out = neutralizeNodeImports(code);
  assertEquals(findNodeImports(out), []);
  assert(out.includes(`import { GeoJsonLayer } from "@deck.gl/layers";`));
});

Deno.test("neutralizeNodeImports は import より前で参照される束縛でも TDZ にならない（先頭で宣言）", () => {
  // import は巻き上げられるため、元コードは import 文より前で束縛を参照できる。
  // 在 place の const 置換だと TDZ で ReferenceError になるので、スタブは先頭へ宣言する。
  const code = [
    `__reExport(exports, worker_threads_star);`,
    `import * as worker_threads_star from "node:worker_threads";`,
  ].join("\n");
  const out = neutralizeNodeImports(code);
  assertEquals(findNodeImports(out), []);
  const declIdx = out.indexOf("const worker_threads_star = {}");
  const useIdx = out.indexOf("__reExport(exports, worker_threads_star)");
  assert(declIdx >= 0 && useIdx >= 0 && declIdx < useIdx);
});

Deno.test("neutralizeNodeImports は複数行に散在する node: import を全て処理する", () => {
  const code = [
    `import * as WorkerThreads from "node:worker_threads";`,
    `import * as worker_threads_star from "node:worker_threads";`,
    `import ChildProcess from "node:child_process";`,
    `import * as stream from "node:stream";`,
    `const x = 1;`,
  ].join("\n");
  const out = neutralizeNodeImports(code);
  assertEquals(findNodeImports(out), []);
  assert(out.includes("const x = 1;"));
});

Deno.test("buildBundleArgs は src/main.ts を dist/app.js にバンドルするコマンド引数を返す", () => {
  const args = buildBundleArgs("src/main.ts", "dist/app.js");
  assertEquals(args, [
    "bundle",
    "--platform",
    "browser",
    "src/main.ts",
    "-o",
    "dist/app.js",
  ]);
});

Deno.test("getDataCopyTargets は europe_flat をオーバーレイ年の和集合で出す（TASK-92）", () => {
  const targets = getDataCopyTargets(
    "dist",
    [1300, 1492],
    [1500],
    [1300],
    [1300, 1492],
  );
  assertEquals(
    targets.filter((t) => t.from.includes("europe_flat")),
    [
      {
        from: "data/europe_flat_1300.geojson",
        to: "dist/data/europe_flat_1300.geojson",
      },
      {
        from: "data/europe_flat_1492.geojson",
        to: "dist/data/europe_flat_1492.geojson",
      },
    ],
  );
});

Deno.test("getDataCopyTargets は fiefYears 省略時に europe_flat を含めない（TASK-92）", () => {
  const targets = getDataCopyTargets("dist", [1000], [1500]);
  assertEquals(targets.filter((t) => t.from.includes("europe_flat")), []);
});

Deno.test("getDataCopyTargets は italyFiefYears の italy_fiefs_flat をコピー対象に含める（TASK-96 AC #1）", () => {
  const targets = getDataCopyTargets(
    "dist",
    [1200],
    [1500],
    [],
    [],
    [1200, 1492],
  );
  assertEquals(
    targets.filter((t) => t.from.includes("italy_fiefs_flat")),
    [
      {
        from: "data/italy_fiefs_flat_1200.geojson",
        to: "dist/data/italy_fiefs_flat_1200.geojson",
      },
      {
        from: "data/italy_fiefs_flat_1492.geojson",
        to: "dist/data/italy_fiefs_flat_1492.geojson",
      },
    ],
  );
  // OHM 由来の生データ（italy_fiefs_<year>）は派生データの入力なので dist に含めない
  assertEquals(
    targets.filter((t) => /italy_fiefs_\d/.test(t.from)),
    [],
  );
});

Deno.test("getDataCopyTargets は italyFiefYears 省略時に italy_fiefs を含めない（後方互換。TASK-96）", () => {
  const targets = getDataCopyTargets("dist", [1000], [1500]);
  assertEquals(targets.filter((t) => t.from.includes("italy_fiefs")), []);
});

Deno.test("getDataCopyTargets は base_outline / europe_flat を 3 系統の年集合の和で出す（TASK-96 AC #5）", () => {
  const targets = getDataCopyTargets(
    "dist",
    [1300],
    [1500],
    [1300],
    [1400],
    [1492],
  );
  assertEquals(
    targets.filter((t) => t.from.includes("base_outline")).map((t) => t.from),
    [
      "data/base_outline_1300.geojson",
      "data/base_outline_1400.geojson",
      "data/base_outline_1492.geojson",
    ],
  );
  assertEquals(
    targets.filter((t) => t.from.includes("europe_flat")).map((t) => t.from),
    [
      "data/europe_flat_1300.geojson",
      "data/europe_flat_1400.geojson",
      "data/europe_flat_1492.geojson",
    ],
  );
});

// --- TASK-127: Cloudflare Pages 用 _headers（CSP・Cache-Control）---
// _headers は buildHeadersContent(HASHED_APP_JS) を単一の情報源として dist/ 直下に生成する。
// connect-src の許可オリジンはアプリが実際に接続する外部先（R2 タイル配信の
// TILES_ORIGIN と OpenFreeMap フォールバックの FALLBACK_STYLE_URL のオリジン）
// だけに絞り、定数から導出することでドリフトを防ぐ。

Deno.test("getDataCopyTargets は借用年の borrowed_*_flat をコピー対象に含める（#215）", () => {
  // 配信・表示するのは差引済みの flat 版（scripts/build-fief-flat.ts が生成）。
  // 借用元（borrowed_<lineage>_<year>.geojson）は座標無改変の中間生成物で、
  // 配信対象には含めない。
  const targets = getDataCopyTargets(
    "dist",
    [1492],
    [],
    [],
    [],
    [],
    [],
    [],
    [],
    [1492, 1715],
    [1492],
  );
  assertEquals(
    targets.filter((t) => t.from.includes("borrowed")),
    [
      {
        from: "data/borrowed_hre_flat_1492.geojson",
        to: "dist/data/borrowed_hre_flat_1492.geojson",
      },
      {
        from: "data/borrowed_hre_flat_1715.geojson",
        to: "dist/data/borrowed_hre_flat_1715.geojson",
      },
      {
        from: "data/borrowed_italy_flat_1492.geojson",
        to: "dist/data/borrowed_italy_flat_1492.geojson",
      },
    ],
  );
});

Deno.test("productionDataCopyTargets は借用 flat（hre 1492/1715・italy 1492）を配信対象に含める（#218 AC3）", () => {
  // getDataCopyTargets の借用 2 引数（borrowedHreYears / borrowedItalyFiefYears）
  // は末尾の省略可能引数で、copyDataFiles だけが渡していた。呼び出し側が引数を
  // 落としても reorder しても型は通り、dist/data/ から借用 flat が抜けたことに
  // CI が気付けない（#218 の穴 (3)）。本番の引数構成を productionDataCopyTargets
  // として切り出し、その結果を検査することで、欠落・入れ替えのいずれも red に
  // する（hre は 1492+1715 の 2 年、italy は 1492 の 1 年なので、2 引数を
  // 入れ替えると borrowed_hre_flat_1715 が落ちて検出できる）。
  const from = productionDataCopyTargets("dist").map((t) => t.from);
  for (
    const file of [
      "data/borrowed_hre_flat_1492.geojson",
      "data/borrowed_hre_flat_1715.geojson",
      "data/borrowed_italy_flat_1492.geojson",
    ]
  ) {
    assert(from.includes(file), `${file} が配信対象に無い`);
  }
  // 入れ替え検出の裏面: italy の年集合に無い 1715 の flat が混入していないこと
  assert(
    !from.includes("data/borrowed_italy_flat_1715.geojson"),
    "borrowed_italy_flat_1715 は許可リストに無い（引数の入れ替えの疑い）",
  );
  // 借用元（borrowed_<lineage>_<year>）は座標無改変の中間生成物で配信しない
  assertEquals(from.filter((f) => /borrowed_[a-z]+_\d/.test(f)), []);
});

/** テスト用のハッシュ付き app.js 配信パス（#246）。 */
const HASHED_APP_JS = "/app.0123456789.js";

Deno.test("buildHeadersContent は /* ルールで始まる Pages の _headers 形式を返す", () => {
  const lines = buildHeadersContent(HASHED_APP_JS).split("\n");
  assertEquals(lines[0], "/*");
  // ヘッダ行は 2 スペースのインデント、ルール行（パス）はインデントなし
  // （Pages の _headers 仕様）
  const ruleLines = lines.filter((l) => l !== "" && !l.startsWith("  "));
  assertEquals(ruleLines, ["/*", "/data/*", HASHED_APP_JS]);
  assert(
    lines.slice(1).every((l) =>
      l === "" || l.startsWith("  ") || l === "/data/*" || l === HASHED_APP_JS
    ),
  );
});

Deno.test("buildHeadersContent の既定は Cache-Control: no-cache（index.html / manifest.json / pmtiles 等。#246）", () => {
  const content = buildHeadersContent(HASHED_APP_JS);
  const lines = content.split("\n");
  // /* ルール（既定）に no-cache があること
  const defaultRule = lines.slice(0, lines.indexOf("/data/*"));
  assert(defaultRule.includes("  Cache-Control: no-cache"));
});

Deno.test("buildHeadersContent はハッシュ付きパス（/data/* と app.<hash>.js）を immutable 配信にする（#246 AC1）", () => {
  const content = buildHeadersContent(HASHED_APP_JS);
  const lines = content.split("\n");
  for (const rule of ["/data/*", HASHED_APP_JS]) {
    const start = lines.indexOf(rule);
    assert(start >= 0, `${rule} ルールがあること`);
    const body = lines.slice(start + 1, start + 3);
    // Pages は複数ルールのヘッダを結合するため、/* の no-cache を detach して
    // から immutable を付ける（結合で "no-cache, public, ..." になる事故防止）
    assertEquals(body, [
      "  ! Cache-Control",
      "  Cache-Control: public, max-age=31536000, immutable",
    ]);
  }
});

Deno.test("buildHeadersContent はハッシュ付きでない app.js パスを拒否する（論理パスを immutable にしない。#246）", () => {
  assertThrows(() => buildHeadersContent("/app.js"));
  assertThrows(() => buildHeadersContent("app.0123456789.js"));
});

Deno.test("manifestKeyFor は dist からの相対パスを URL パス（/ 始まり）にする（#246）", () => {
  assertEquals(manifestKeyFor("dist", "dist/app.js"), "/app.js");
  assertEquals(
    manifestKeyFor("dist", "dist/data/colors.json"),
    "/data/colors.json",
  );
  assertThrows(() => manifestKeyFor("dist", "out/data/colors.json"));
});

Deno.test("manifest は本番の全 data コピー対象を論理パスで網羅できる（#246 AC2）", () => {
  // productionDataCopyTargets の to（dist/data/...）から manifest のキーを導出
  // できること = ビルドが書く manifest がランタイムの全 /data/ 参照を覆うこと。
  const keys = productionDataCopyTargets("dist").map((t) =>
    manifestKeyFor("dist", t.to)
  );
  assert(keys.length > 0);
  assert(keys.every((k) => k.startsWith("/data/")));
  // 代表例: 静的 JSON と年代 geojson の双方が含まれる
  assert(keys.includes("/data/colors.json"));
  assert(keys.includes("/data/europe_1000.geojson"));
});

Deno.test("buildHeadersContent の CSP: connect-src は self + R2 タイル + OpenFreeMap のみ（AC #3）", () => {
  const content = buildHeadersContent(HASHED_APP_JS);
  const csp = content
    .split("\n")
    .find((l) => l.includes("Content-Security-Policy:"));
  assert(csp !== undefined, "Content-Security-Policy ヘッダがあること");
  const connectSrc = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("connect-src"));
  assert(connectSrc !== undefined, "connect-src ディレクティブがあること");
  const sources = connectSrc.split(/\s+/).slice(1);
  assertEquals(sources, [
    "'self'",
    TILES_ORIGIN,
    new URL(FALLBACK_STYLE_URL).origin,
  ]);
});

Deno.test("buildHeadersContent の CSP: script-src 'self' / worker-src 'self' blob:（AC #3）", () => {
  const content = buildHeadersContent(HASHED_APP_JS);
  const csp = content
    .split("\n")
    .find((l) => l.includes("Content-Security-Policy:"))!;
  const directives = csp
    .slice(csp.indexOf("Content-Security-Policy:"))
    .replace("Content-Security-Policy:", "")
    .split(";")
    .map((d) => d.trim());
  assert(directives.includes("script-src 'self'"), "script-src 'self'");
  assert(
    directives.includes("worker-src 'self' blob:"),
    "worker-src 'self' blob:（MapLibre/deck.gl の blob Worker 用）",
  );
  // worker-src 未対応の旧 Safari 向けフォールバック
  assert(
    directives.includes("child-src 'self' blob:"),
    "child-src 'self' blob:",
  );
});

Deno.test("buildHeadersContent の CSP: 外部オリジンは connect-src の 2 つ以外に現れない", () => {
  const csp = buildHeadersContent(HASHED_APP_JS)
    .split("\n")
    .find((l) => l.includes("Content-Security-Policy:"))!;
  const externals = csp.match(/https?:\/\/[^\s;]+/g) ?? [];
  assertEquals(
    [...new Set(externals)].sort(),
    [TILES_ORIGIN, new URL(FALLBACK_STYLE_URL).origin].sort(),
  );
});
