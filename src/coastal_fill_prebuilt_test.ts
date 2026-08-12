/**
 * 事前生成した沿岸補完の帯（Issue #326）の回帰検査。
 *
 * #312 で帯を polyclip 差分にした結果、**初訪問の年ごとにメインスレッドが
 * 0.46〜0.72 秒止まる**（本番実測 664/713/859ms）。#326 はこの生成をビルド時
 * （scripts/build-coastal-fill.ts）へ移し、ランタイムは配信された幾何に色を
 * 載せるだけにする。ここでは
 * - 初訪問の年で**ランタイムが実際に払うコスト**（JSON パース + 色付け）が
 *   1 年ごとに {@linkcode FIRST_VISIT_BUDGET_MS} 未満であること（AC1 / AC2）
 * - 事前生成データが年代 GeoJSON・帯幅と対応していること（陳腐化の検出）
 * - 事前生成の帯が実行時生成と**同一の面**であること（AC5 の前提）
 * を機械的に固定する。
 *
 * 1 番目の検査は #326 以前だと必ず red になる: 当時の唯一の経路
 * buildCoastalFillData は 1 年あたり 460〜720ms かかっていた（同 CPU での実測）。
 */
import { assert, assertEquals } from "@std/assert";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import {
  buildCoastalFillBands,
  COASTAL_FILL_BAND_KM,
  coastalFillDataFromBands,
  coastalFillDataUrlFor,
} from "./coastal_fill.ts";
import { EMPTY_SUZERAIN_OVERRIDES } from "./suzerain_extent.ts";
import { SNAPSHOT_YEARS } from "./config.ts";
import {
  coastalFillOutputPathFor,
  coastalFillSourcePathFor,
  readCoastalFillMeta,
  roundBandCoordinates,
} from "../scripts/build-coastal-fill.ts";
import { contentHashHex } from "../scripts/asset_hashing.ts";

/**
 * 初訪問の年 1 回あたりに許すメインスレッドの帯確定コスト（ms）。
 *
 * #326 AC2 の「年切替直後 3 秒間の最長ブロックが 100ms 未満」に合わせる。
 * 実測の内訳は JSON パース 2〜4ms + 色付け 1ms 未満で、1 桁の余裕がある
 * （#312 の実行時生成は 460〜720ms でこの予算を大きく超える）。
 */
const FIRST_VISIT_BUDGET_MS = 100;

function readJson(path: string): Promise<string> {
  return Deno.readTextFile(path);
}

Deno.test("全 SNAPSHOT_YEARS に事前生成の帯があり、年代 GeoJSON と帯幅に対応している（#326 AC1）", async () => {
  const missing: string[] = [];
  const stale: string[] = [];
  for (const year of SNAPSHOT_YEARS) {
    const path = coastalFillOutputPathFor(year);
    let raw: unknown;
    try {
      raw = JSON.parse(await readJson(path));
    } catch {
      missing.push(path);
      continue;
    }
    const meta = readCoastalFillMeta(raw);
    if (meta === null) {
      stale.push(`${path}: 指紋（sourcePath / sourceHash / bandKm）が無い`);
      continue;
    }
    const sourcePath = coastalFillSourcePathFor(year);
    const sourceHash = await contentHashHex(await Deno.readFile(sourcePath));
    if (meta.sourcePath !== sourcePath) {
      stale.push(`${path}: sourcePath=${meta.sourcePath} ≠ ${sourcePath}`);
    }
    if (meta.sourceHash !== sourceHash) {
      stale.push(
        `${path}: 入力が更新されている（deno task build-coastal-fill）`,
      );
    }
    if (meta.bandKm !== COASTAL_FILL_BAND_KM) {
      stale.push(
        `${path}: bandKm=${meta.bandKm} ≠ ${COASTAL_FILL_BAND_KM}` +
          `（deno task build-coastal-fill で再生成が必要）`,
      );
    }
  }
  assertEquals(missing, [], "事前生成の帯が無い年がある");
  assertEquals(stale, [], "事前生成の帯が入力・生成条件と対応していない");
});

Deno.test("初訪問の年でランタイムが払う帯のコストは 1 年 100ms 未満（#326 AC1 / AC2）", async () => {
  const colors = JSON.parse(
    await readJson("data/colors.json"),
  ) as Record<string, string>;
  const over: string[] = [];
  let worst = 0;
  for (const year of SNAPSHOT_YEARS) {
    const base = JSON.parse(
      await readJson(coastalFillSourcePathFor(year)),
    ) as FeatureCollection;
    // 配信ファイルのテキストから測る（ランタイムが払うのは fetch 後の
    // JSON.parse + 色付けだけで、polyclip 差分はビルド時に済んでいる）
    const text = await readJson(coastalFillOutputPathFor(year));
    const started = performance.now();
    const bands = JSON.parse(text) as FeatureCollection;
    const data = coastalFillDataFromBands(
      base,
      bands,
      colors,
      EMPTY_SUZERAIN_OVERRIDES,
    );
    const elapsed = performance.now() - started;
    worst = Math.max(worst, elapsed);
    assert(data !== null, `${year} の帯が base と対応していない`);
    assert(data!.features.length > 0, `${year} の帯が空`);
    if (elapsed >= FIRST_VISIT_BUDGET_MS) {
      over.push(`${year}: ${elapsed.toFixed(0)}ms`);
    }
  }
  assertEquals(
    over,
    [],
    `初訪問の年の帯確定が ${FIRST_VISIT_BUDGET_MS}ms 以上かかっている` +
      `（最長 ${worst.toFixed(0)}ms）`,
  );
});

Deno.test("配信 URL は事前生成ファイルと同じ年代別の名前を指す（#326）", () => {
  assertEquals(coastalFillDataUrlFor(1900), "/data/coastal_fill_1900.geojson");
  assertEquals(
    `/${coastalFillOutputPathFor(1900)}`,
    coastalFillDataUrlFor(1900),
  );
});

/**
 * 事前生成が実行時生成と同じ面を表すことを、代表年（1900）で確認する
 * （AC5 の前提。座標の丸め ≤ 56m 以外に差が無いこと）。
 *
 * 全 19 年でやると polyclip 差分に 11 秒かかるため、#312 の被覆率検査
 * （coastal_fill_band_test.ts）と同じ 1900 年を代表に据える。
 */
Deno.test("事前生成の帯は実行時生成と同一の面を表す（#326 AC5）", async () => {
  const year = 1900;
  const base = JSON.parse(
    await readJson(coastalFillSourcePathFor(year)),
  ) as FeatureCollection;
  const expected = roundBandCoordinates(buildCoastalFillBands(base));
  const actual = JSON.parse(
    await readJson(coastalFillOutputPathFor(year)),
  ) as FeatureCollection<MultiPolygon>;
  assertEquals(
    actual.features.length,
    expected.features.length,
    "帯の feature 数が実行時生成と違う",
  );
  assertEquals(
    JSON.stringify(actual.features),
    JSON.stringify(expected.features),
    "事前生成の帯が実行時生成と一致しない（deno task build-coastal-fill）",
  );
});

/**
 * #312 が固定した「政治ポリゴンの内側を帯が覆わない」不変条件を、**配信する
 * 事前生成データそのもの**に対しても確認する（AC5。coastal_fill_band_test.ts は
 * 実行時生成に対する検査で、丸め後の配信データは覆っていない）。
 */
Deno.test("事前生成の帯は政治ポリゴンの内側を覆わない（丸め後の配信データ・#326 AC5）", async () => {
  const year = 1900;
  const base = JSON.parse(
    await readJson(coastalFillSourcePathFor(year)),
  ) as FeatureCollection;
  const bands = JSON.parse(
    await readJson(coastalFillOutputPathFor(year)),
  ) as FeatureCollection<MultiPolygon>;
  const land = base.features.filter(
    (feature): feature is typeof feature & {
      geometry: Polygon | MultiPolygon;
    } =>
      feature.geometry !== null &&
      (feature.geometry.type === "Polygon" ||
        feature.geometry.type === "MultiPolygon"),
  );
  // #312 AC6 の代表地点（レマン湖・ボーデン湖・テムズ河口）
  const probes: { point: [number, number]; label: string }[] = [
    { point: [6.30, 46.35], label: "レマン湖南岸（仏側）" },
    { point: [6.45, 46.52], label: "レマン湖北岸（スイス側）" },
    { point: [9.30, 47.60], label: "ボーデン湖南岸" },
    { point: [9.40, 47.68], label: "ボーデン湖北岸" },
    { point: [0.60, 51.45], label: "テムズ河口北岸" },
    { point: [0.60, 51.40], label: "テムズ河口南岸" },
  ];
  for (const { point, label } of probes) {
    if (!land.some((feature) => booleanPointInPolygon(point, feature))) {
      continue;
    }
    assertEquals(
      bands.features.some((band) => booleanPointInPolygon(point, band)),
      false,
      `${label} が事前生成の帯に二重塗りされている`,
    );
  }
});
