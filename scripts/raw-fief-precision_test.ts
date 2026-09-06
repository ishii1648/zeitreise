/**
 * raw 領邦データ（data/<source>_fiefs_<year>.geojson）の座標精度が、raw 生成側が
 * 適用する丸め精度と食い違っていないことを検証する回帰テスト（#334）。
 *
 * ## なぜ要るのか
 * raw 領邦データは配信されない中間生成物で、配信されるのは派生側
 * （*_fiefs_flat_<year>.geojson / fief-dedupe の出力）である。TASK-130 で配信物の
 * 座標を 3 桁（COORD_PRECISION）へ落としたとき、raw は「ライブ Overpass 由来の
 * drift 回避のため意図的に再生成しない」と判断されたが、その判断が**コード側に
 * 反映されていなかった**ため、raw 生成スクリプトだけが 3 桁を適用し、コミット済み
 * raw（5 桁）と食い違ったままになった。結果、入力が変わっていなくても
 * `deno task build-cliopatria-fiefs` を流すと全年・全 feature に差分が出る。
 *
 * このテストは「コミット済み raw の精度 ≤ raw 生成側が適用する精度」を全 raw
 * 領邦ファイルで固定し、精度方針（ADR-0037）からの逸脱を検出する。
 */

import { assert, assertEquals } from "@std/assert";
import type { FeatureCollection, Position } from "geojson";
import { COORD_PRECISION, RAW_FIEF_COORD_PRECISION } from "./build-data.ts";

/** raw 領邦データを出す生成スクリプト（ソース名 → スクリプトのパス） */
const RAW_FIEF_BUILDERS: Readonly<Record<string, string>> = {
  britain: "scripts/build-britain-fiefs.ts",
  cliopatria: "scripts/build-cliopatria-fiefs.ts",
  france: "scripts/build-france-fiefs.ts",
  hre: "scripts/build-hre-fiefs.ts",
  italy: "scripts/build-italy-fiefs.ts",
  sovereign: "scripts/build-sovereign-fiefs.ts",
};

/** data/<source>_fiefs_<year>.geojson（flat 派生は含めない） */
const RAW_FIEF_FILE = new RegExp(
  `^(${Object.keys(RAW_FIEF_BUILDERS).join("|")})_fiefs_(\\d{3,4})\\.geojson$`,
);

interface RawFiefFile {
  source: string;
  year: number;
  path: string;
}

/** コミット済みの raw 領邦ファイルを列挙する（ソース名・年の昇順） */
function rawFiefFiles(): RawFiefFile[] {
  const files: RawFiefFile[] = [];
  for (const entry of Deno.readDirSync("data")) {
    const matched = RAW_FIEF_FILE.exec(entry.name);
    if (matched === null) continue;
    files.push({
      source: matched[1],
      year: Number(matched[2]),
      path: `data/${entry.name}`,
    });
  }
  return files.sort((a, b) =>
    a.source === b.source ? a.year - b.year : a.source < b.source ? -1 : 1
  );
}

/**
 * JSON へ書き出したときの小数桁数。座標は JSON.stringify がそのまま出すので、
 * 数値の既定の文字列化（最短往復表現）の桁数がファイル上の桁数と一致する。
 */
function decimalDigits(value: number): number {
  const text = String(value);
  assert(
    !text.includes("e") && !text.includes("E"),
    `座標が指数表記になっています: ${text}`,
  );
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

/** FeatureCollection の全座標を列挙する（Polygon / MultiPolygon のみ） */
function* positions(fc: FeatureCollection): Generator<Position> {
  for (const feature of fc.features) {
    const geometry = feature.geometry;
    if (geometry === null) continue;
    if (geometry.type === "Polygon") {
      for (const ring of geometry.coordinates) yield* ring;
    } else if (geometry.type === "MultiPolygon") {
      for (const polygon of geometry.coordinates) {
        for (const ring of polygon) yield* ring;
      }
    }
  }
}

/** ファイル内の座標の最大小数桁数 */
function maxDecimalDigits(path: string): number {
  const fc = JSON.parse(Deno.readTextFileSync(path)) as FeatureCollection;
  // 1000年ボヘミアは上流座標を無改変で保持し、専用の指紋テストで検証する。
  if (path === "data/cliopatria_fiefs_1000.geojson") {
    fc.features = fc.features.filter((f) =>
      f.properties?.NAME !== "Duchy of Bohemia"
    );
  }
  let max = 0;
  for (const position of positions(fc)) {
    for (const value of position) max = Math.max(max, decimalDigits(value));
  }
  return max;
}

Deno.test("raw 領邦ファイルの列挙が空でない（テストが素通りしない）", () => {
  const files = rawFiefFiles();
  assert(files.length > 0, "data/ に raw 領邦ファイルが見つかりません");
  const sources = new Set(files.map((f) => f.source));
  assertEquals(
    [...sources].sort(),
    Object.keys(RAW_FIEF_BUILDERS).sort(),
    "raw 領邦データを出す全ソースが走査対象に入っていること",
  );
});

Deno.test("コミット済み raw 領邦データの座標は raw 生成側が適用する精度に収まる", () => {
  const violations: string[] = [];
  for (const file of rawFiefFiles()) {
    const digits = maxDecimalDigits(file.path);
    if (digits > RAW_FIEF_COORD_PRECISION) {
      violations.push(`${file.path}: 最大 ${digits} 桁`);
    }
  }
  assertEquals(
    violations,
    [],
    `raw 生成側が適用する精度は ${RAW_FIEF_COORD_PRECISION} 桁だが、` +
      `コミット済みファイルはそれより細かい桁を持つ（再生成すると全面差分になる）`,
  );
});

Deno.test("ピン留め入力の cliopatria raw は raw 生成側の精度をそのまま保持する", () => {
  // cliopatria だけは入力がコミット SHA + SHA-256 でピン留めされており、
  // 上流 drift が無い = 再生成でコミット済みと一致させられる唯一の系列。
  // 「粗すぎない」ことまで固定して、精度方針からの逸脱を両方向で検出する。
  const files = rawFiefFiles().filter((f) => f.source === "cliopatria");
  assert(files.length > 0, "cliopatria の raw が見つかりません");
  const digits = Math.max(...files.map((f) => maxDecimalDigits(f.path)));
  assertEquals(
    digits,
    RAW_FIEF_COORD_PRECISION,
    "cliopatria raw の座標精度は raw 生成側が truncate に渡す精度と一致すること",
  );
});

Deno.test("raw 領邦の生成スクリプトは raw 用の精度定数を使う", () => {
  // 配信側の COORD_PRECISION を raw の丸めに使い回すと（c023691 の状態）、
  // 入力不変でも全年・全 feature に差分が出る。定数の取り違えを機械的に弾く。
  const missing: string[] = [];
  for (const [source, path] of Object.entries(RAW_FIEF_BUILDERS)) {
    const text = Deno.readTextFileSync(path);
    if (!text.includes("RAW_FIEF_COORD_PRECISION")) missing.push(source);
  }
  assertEquals(
    missing,
    [],
    "raw 領邦の生成スクリプトは RAW_FIEF_COORD_PRECISION を参照すること",
  );
});

Deno.test("raw の精度は配信側の精度より細かい（配信側は TASK-130 の 3 桁のまま）", () => {
  // ADR-0037 の二段構え: raw は上流精度で保持し、丸めは配信される派生側で
  // 一度だけ行う。raw を配信側と同じかそれより粗くすると、派生の union /
  // difference が粗いグリッド上で解かれ、TASK-130 が踏んだ穴のずれ・
  // 線状スライバの再発リスクを raw 側へ持ち込むことになる。
  assert(
    RAW_FIEF_COORD_PRECISION > COORD_PRECISION,
    `raw の精度 ${RAW_FIEF_COORD_PRECISION} は配信側の精度 ` +
      `${COORD_PRECISION} より細かいこと`,
  );
});
