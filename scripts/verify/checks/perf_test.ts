import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { SNAPSHOT_YEARS } from "../../../src/config.ts";
import {
  averageYearSwitch,
  isAppReady,
  READY_EXPR,
  resolveOutPath,
  summarizeResources,
  yearsToCycle,
} from "./perf.ts";

// ---- summarizeResources ----

Deno.test("summarizeResources: transferSize/encodedBodySize/decodedBodySize を合算する", () => {
  assertEquals(
    summarizeResources([
      { transferSize: 100, encodedBodySize: 80, decodedBodySize: 200 },
      { transferSize: 50, encodedBodySize: 40, decodedBodySize: 90 },
    ]),
    {
      count: 2,
      transferBytes: 150,
      encodedBodyBytes: 120,
      decodedBodyBytes: 290,
    },
  );
});

Deno.test("summarizeResources: 欠損フィールドは 0 として扱う", () => {
  assertEquals(summarizeResources([{}]), {
    count: 1,
    transferBytes: 0,
    encodedBodyBytes: 0,
    decodedBodyBytes: 0,
  });
});

Deno.test("summarizeResources: 空配列なら全て 0", () => {
  assertEquals(summarizeResources([]), {
    count: 0,
    transferBytes: 0,
    encodedBodyBytes: 0,
    decodedBodyBytes: 0,
  });
});

// ---- isAppReady / READY_EXPR（#244）----

Deno.test("isAppReady: HTML 初期状態（バンドル未実行・spinner は初期 hidden）では偽", () => {
  // index.html の #loading-spinner は初期状態から hidden 属性付きなので、
  // spinner だけでは「ロード開始前」と「ロード完了後」を区別できない。
  assertEquals(
    isAppReady({ politicalBaseLabelCount: null, spinnerHidden: true }),
    false,
  );
});

Deno.test("isAppReady: バンドル実行直後（フックあり・政治レイヤー未ロード）では偽", () => {
  // installDebugHooks はバンドル実行時に無条件で走るため、フックの存在
  // （= __getPowerLabelDebug が返る）だけでは初期表示の完了を意味しない。
  // currentView 未確定のときは base ラベル総数が 0 で返る。
  assertEquals(
    isAppReady({ politicalBaseLabelCount: 0, spinnerHidden: true }),
    false,
  );
});

Deno.test("isAppReady: 年代データ取得中（spinner 表示中）は偽", () => {
  assertEquals(
    isAppReady({ politicalBaseLabelCount: 42, spinnerHidden: false }),
    false,
  );
});

Deno.test("isAppReady: 政治レイヤー描画後（base ラベルが 1 件以上）に真", () => {
  assertEquals(
    isAppReady({ politicalBaseLabelCount: 42, spinnerHidden: true }),
    true,
  );
});

Deno.test("isAppReady: spinner 要素が無くても政治レイヤー描画済みなら真（要素消失で永久待機しない）", () => {
  assertEquals(
    isAppReady({ politicalBaseLabelCount: 1, spinnerHidden: null }),
    true,
  );
});

Deno.test("READY_EXPR: 政治レイヤーのフックを判定材料にし、Resource Timing 件数には依存しない", () => {
  // 旧判定の「リソース 6 件以上」はバンドル + CSS + PMTiles ヘッダで即座に
  // 満たされ偽陽性の原因だったため、判定材料から除かれていることを固定する。
  assertStringIncludes(READY_EXPR, "__getPowerLabelDebug");
  assertStringIncludes(READY_EXPR, "loading-spinner");
  assertEquals(READY_EXPR.includes("resource"), false);
});

Deno.test("READY_EXPR: 直列化された isAppReady がそのまま実行可能な JS で、テスト済みの純ロジックと同挙動", () => {
  // READY_EXPR はブラウザ内で `(isAppReady の直列化)(probe 式)` として評価
  // される。直列化（Function.prototype.toString）が型注釈等の混入なしに
  // 実行可能で、上のユニットテストと同じ関数が動くことを確認する。
  const serialized = String(isAppReady);
  assertEquals(READY_EXPR.startsWith(`(${serialized})(`), true);
  const fn = new Function(`return (${serialized});`)() as typeof isAppReady;
  assertEquals(
    fn({ politicalBaseLabelCount: null, spinnerHidden: true }),
    false,
  );
  assertEquals(fn({ politicalBaseLabelCount: 0, spinnerHidden: true }), false);
  assertEquals(fn({ politicalBaseLabelCount: 9, spinnerHidden: false }), false);
  assertEquals(fn({ politicalBaseLabelCount: 9, spinnerHidden: true }), true);
});

// ---- yearsToCycle ----

Deno.test("yearsToCycle: 初期年代を除いた全スナップショット年代を順に返す", () => {
  assertEquals(yearsToCycle([900, 1000, 1100], 1000), [900, 1100]);
});

Deno.test("yearsToCycle: SNAPSHOT_YEARS 全年代から初期年代だけが除かれる", () => {
  const years = yearsToCycle(SNAPSHOT_YEARS, 1000);
  assertEquals(years.length, SNAPSHOT_YEARS.length - 1);
  assertEquals(years.includes(1000), false);
});

// ---- averageYearSwitch ----

Deno.test("averageYearSwitch: 所要時間と転送量の平均を返す", () => {
  assertEquals(
    averageYearSwitch([
      { durationMs: 100, transferBytes: 1000, decodedBodyBytes: 3000 },
      { durationMs: 300, transferBytes: 2000, decodedBodyBytes: 5000 },
    ]),
    { durationMs: 200, transferBytes: 1500, decodedBodyBytes: 4000 },
  );
});

Deno.test("averageYearSwitch: 空配列なら null", () => {
  assertEquals(averageYearSwitch([]), null);
});

// ---- resolveOutPath ----

Deno.test("resolveOutPath: 既定は gitignore 済みの .perf-*.json パターンに一致するパス", () => {
  const path = resolveOutPath(
    () => undefined,
    new Date("2026-07-29T12:34:56Z"),
  );
  assertMatch(path, /^scripts\/verify\/checks\/\.perf-[0-9TZ-]+\.json$/);
  assertEquals(path, "scripts/verify/checks/.perf-20260729T123456Z.json");
});

Deno.test("resolveOutPath: 環境変数 PERF_OUT で出力先を上書きできる", () => {
  const path = resolveOutPath(
    (key: string) =>
      key === "PERF_OUT"
        ? "scripts/verify/checks/.perf-before.json"
        : undefined,
    new Date(),
  );
  assertEquals(path, "scripts/verify/checks/.perf-before.json");
});
