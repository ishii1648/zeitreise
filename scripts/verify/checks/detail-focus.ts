/**
 * 詳細表示 focus のヘッドレス検証（#350 / #293 分割 5/5。
 * `deno task verify:detail-focus` で使用）。
 *
 * 「同一画面に複数国が入っていても、領邦の塗り・内部境界・領邦名が出る上位勢力は
 * 最大 1 件」（#293 AC1）はピクセルからは数えられない。代わりに、塗り・
 * オーバーレイ 6 系統・ラベルが**同じ focus で揃っている**ことをデバッグフック
 * `__getDetailFocusRenderDebug`（src/debug_hooks.ts）の feature 集合で確認する。
 *
 * 検査する条件（AC 対応）:
 * - AC1: 領邦が描かれる上位勢力（`suzerainKeysDrawn`）は最大 1 件で、focus と一致
 * - AC2: 合成後の塗りが「focus 外 base ∪ focus 内 flat」と一致する
 *   （`featureCount === baseOutsideCount + detailInsideCount`）
 * - AC5: 中央が海上なら領邦は 1 枚も描かれず、塗りは全て素の base
 * - AC8: 概観（z4）では focus 機構が適用されない
 *
 * 対象は 1000 / 1300 / 1492 年 × z5 / z6（+ 回帰確認の z4）で、PC 相当と
 * モバイル相当の両方（`--device=mobile`）で回す。各条件でスクリーンショットも
 * 保存し、AC9 の目視確認の材料にする。
 *
 * 使い方:
 *   deno task build && deno task serve --port 8350 &
 *   deno task verify:detail-focus http://localhost:8350/
 *   deno run -A scripts/verify/cdp.ts --device=mobile http://localhost:8350/ \
 *     scripts/verify/checks/detail-focus.ts
 */
import type { CdpApi } from "../cdp.ts";

/** スクリーンショット出力先（gitignore 済みの .outputs/ 配下） */
export const SCREENSHOT_DIR = ".outputs/claude/issue350";

/**
 * 詳細表示 focus で絞り込まれる領邦・諸侯領オーバーレイ 6 系統
 * （src/political_layers.ts `FOCUS_FILTERED_LAYER_IDS` と同じ並び）。
 */
export const DETAIL_FOCUS_LAYER_IDS: readonly string[] = [
  "hre-powers",
  "france-fiefs",
  "italy-fiefs",
  "cliopatria-fiefs",
  "britain-fiefs",
  "sovereign-fiefs",
];

/** `__getDetailFocusRenderDebug()` の返り値（src/debug_hooks.ts の契約） */
export interface DetailFocusProbe {
  /** 描画へ渡っている focus（z4 と海上は null。区別は focusActive） */
  key: string | null;
  /** focus 機構が適用されるズーム段か（z5 以上） */
  focusActive: boolean;
  zoomStep: number;
  /** focus 絞り込み後に描かれる領邦の件数（レイヤー ID → 件数） */
  byLayer: Record<string, number>;
  /** 実際に領邦が描かれる上位勢力の宗主キー */
  suzerainKeysDrawn: string[];
  /** 合成後の powers 塗りの内訳 */
  powerFill: {
    featureCount: number;
    baseOutsideCount: number;
    detailInsideCount: number;
  };
  /** focus 絞り込み後に残る領邦ラベル */
  focusedLabelTexts: string[];
}

/** 描画中の領邦の総数 */
function drawnFiefCount(probe: DetailFocusProbe): number {
  return Object.values(probe.byLayer).reduce((sum, n) => sum + n, 0);
}

/**
 * probe から違反を列挙する純粋関数（#350）。空配列なら合格。
 *
 * `label` は「1492 年 / z6 / mobile」のような条件名で、違反メッセージの
 * 先頭に付けて、どの条件で壊れたかを JSON を追わずに読めるようにする。
 */
export function findDetailFocusViolations(
  probe: DetailFocusProbe,
  label: string,
): string[] {
  const violations: string[] = [];
  const at = (message: string) => violations.push(`${label}: ${message}`);
  const fiefs = drawnFiefCount(probe);

  // AC8: 概観（z4）は focus 機構の対象外。z5 以上では必ず適用される
  if (probe.zoomStep < 5) {
    if (probe.focusActive) {
      at(`概観段（z${probe.zoomStep}）で focus が適用されている`);
    }
    if (fiefs > 0) {
      at(`概観段（z${probe.zoomStep}）で領邦が ${fiefs} 件描かれている`);
    }
  } else if (!probe.focusActive) {
    at(`詳細段（z${probe.zoomStep}）で focus が適用されていない`);
  }

  // AC1: 領邦が描かれる上位勢力は最大 1 件で、それは focus 自身
  if (probe.suzerainKeysDrawn.length > 1) {
    at(
      `領邦が ${probe.suzerainKeysDrawn.length} 件の上位勢力へまたがっている` +
        `（${probe.suzerainKeysDrawn.join(" / ")}）`,
    );
  } else if (
    probe.suzerainKeysDrawn.length === 1 &&
    probe.key !== null &&
    probe.suzerainKeysDrawn[0] !== probe.key
  ) {
    at(
      `focus（${probe.key}）以外の上位勢力の領邦が描かれている` +
        `（${probe.suzerainKeysDrawn[0]}）`,
    );
  }

  // AC5: 中央が海上・base 勢力外（focus 適用中で key が無い）なら詳細表示なし
  if (probe.focusActive && probe.key === null) {
    if (fiefs > 0) {
      at(`中央が海上なのに領邦が ${fiefs} 件描かれている`);
    }
    if (probe.powerFill.detailInsideCount > 0) {
      at(
        "中央が海上なのに派生 base（領邦差し引き済み）を塗っている" +
          `（${probe.powerFill.detailInsideCount} 件。透明な穴になる）`,
      );
    }
  }

  // AC2: 合成後の塗り = focus 外 base ∪ focus 内 flat
  const expected = probe.powerFill.baseOutsideCount +
    probe.powerFill.detailInsideCount;
  if (probe.powerFill.featureCount !== expected) {
    at(
      `合成後の塗りの feature 数が内訳と一致しない` +
        `（${probe.powerFill.featureCount} ≠ ${probe.powerFill.baseOutsideCount}` +
        ` + ${probe.powerFill.detailInsideCount}）`,
    );
  }

  return violations;
}

/** ブラウザ内で `__getDetailFocusRenderDebug()` を読む評価式 */
export const DETAIL_FOCUS_PROBE_EXPR =
  "window.__getDetailFocusRenderDebug ? window.__getDetailFocusRenderDebug() : null";

/** 検査する年代（#350 AC9 の目視確認と同じ 3 年代） */
export const CHECK_YEARS: readonly number[] = [1000, 1300, 1492];

/** 検査するズーム段（z4 は AC8 の回帰確認） */
export const CHECK_ZOOMS: readonly number[] = [4, 5, 6];

/**
 * 中央に据える地点（フランス王国の内陸）。z5 でも周辺国が同時に画面へ入る
 * ため、「複数国が見えていても詳細表示は 1 か国」を検査できる。
 */
const FRANCE_POINT: readonly [number, number] = [2.5, 47.5];

/** 中央が海上になる地点（地中海。AC5 の縮退経路） */
const SEA_POINT: readonly [number, number] = [5.5, 42.0];

/**
 * AC6 のパン検査の 1 回あたりの移動量（px）。z5 なら約 6.6°/回で、フランス
 * 中央（2.5°E）から帝国域へは 1 回で届く。
 */
const PAN_STEP_PX = 300;

/**
 * パンの上限回数。1 回で届くので 8 回あれば十分で、これを超えても focus が
 * 変わらなければ「moveend の再解決・再描画が効いていない」と言える。
 */
const PAN_STEPS_MAX = 8;

/**
 * 地図を左へ `dx` px ドラッグする（= 中央が東へ動く）ブラウザ内評価式。
 *
 * 矢印キー（`api.keys("ArrowRight")`）を使わないのは、本アプリのタイムライン UI
 * も左右キーで年代を送るため、1 回のキーで「パン」と「年代切替」が同時に起きて
 * AC6 の観測（年代を固定したまま中央だけ動かす）にならないため（実測）。
 * MapLibre の DragPanHandler は `isTrusted` を見ないので、合成 MouseEvent の
 * mousedown → mousemove × N → mouseup で実際のドラッグと同じ `moveend` が出る。
 */
export function buildMapDragExpr(dx: number): string {
  return `(() => {
  const canvas = document.querySelector('.maplibregl-canvas');
  if (!canvas) return false;
  const rect = canvas.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const fire = (type, cx, cy, buttons) => {
    const init = {
      bubbles: true, cancelable: true, view: window,
      clientX: cx, clientY: cy, button: 0, buttons,
    };
    canvas.dispatchEvent(new MouseEvent(type, init));
    document.dispatchEvent(new MouseEvent(type, init));
  };
  fire('mousedown', x, y, 1);
  for (let i = 1; i <= 8; i++) fire('mousemove', x - (${dx} * i) / 8, y, 1);
  fire('mouseup', x - ${dx}, y, 0);
  return true;
})()`;
}

export async function run(api: CdpApi): Promise<void> {
  const results: Record<string, unknown> = {};
  await Deno.mkdir(SCREENSHOT_DIR, { recursive: true });

  const origin = await api.evaluate<string>("location.origin");
  // スクリーンショット名とラベルにビューポートを含める（AC9 は PC 相当と
  // モバイル相当の両方で確認するため、--device 違いの実行が上書きし合わない）
  const viewport = await api.evaluate<{ width: number; height: number }>(
    "({ width: window.innerWidth, height: window.innerHeight })",
  );
  results.viewport = viewport;
  const device = `${viewport.width}x${viewport.height}`;
  const probes: Record<string, DetailFocusProbe> = {};
  const violations: string[] = [];
  const screenshots: string[] = [];

  const inspect = async (
    name: string,
    year: number,
    zoom: number,
    center: readonly [number, number],
  ): Promise<void> => {
    const label = `${device}/${name}`;
    await api.navigate(
      `${origin}/?year=${year}&zoom=${zoom}&center=${center[0]},${center[1]}`,
    );
    await api.waitForAppReady();
    // __getYear はフック設置と年代反映のレースがあるため、目的の年まで明示的に
    // 待つ（フックの存在確認込み）
    await api.waitFor(
      `window.__getYear && window.__getYear() === ${year}`,
      45_000,
    );
    // `__getYear()` は年未確定でも初期年（1000）へフォールバックする契約なので、
    // 初期年の検査では上の待機が「データ未ロード」で即座に通ってしまう。
    // 年代 GeoJSON が currentView へ反映された（塗る feature がある）ことまで
    // 待って、空の probe を検査してしまわないようにする。
    await api.waitFor(
      "typeof window.__getDetailFocusRenderDebug === 'function' && " +
        "window.__getDetailFocusRenderDebug().powerFill.featureCount > 0",
      45_000,
    );
    const probe = await api.evaluate<DetailFocusProbe | null>(
      DETAIL_FOCUS_PROBE_EXPR,
    );
    if (probe === null) {
      violations.push(`${label}: __getDetailFocusRenderDebug が未設置`);
      return;
    }
    probes[label] = probe;
    violations.push(...findDetailFocusViolations(probe, label));
    const path = `${SCREENSHOT_DIR}/${device}-${name}.png`;
    await api.screenshot(path);
    screenshots.push(path);
  };

  for (const year of CHECK_YEARS) {
    for (const zoom of CHECK_ZOOMS) {
      await inspect(`${year}-z${zoom}`, year, zoom, FRANCE_POINT);
    }
    // AC5: 中央が海上（z5）。領邦を 1 枚も描かず、塗りは素の base
    await inspect(`${year}-z5-sea`, year, 5, SEA_POINT);
  }

  // AC6: パン停止（moveend）で中央が別の上位勢力へ移ると focus が切り替わる。
  // 年代は固定したまま中央だけ東へ動かし、focus が変わるまで繰り返す。
  await inspect("pan-before", 1300, 5, FRANCE_POINT);
  const focusBefore = await api.evaluate<string | null>(
    "window.__getDetailFocusDebug().key",
  );
  let panned = 0;
  for (; panned < PAN_STEPS_MAX; panned++) {
    await api.evaluate(buildMapDragExpr(PAN_STEP_PX));
    await new Promise((r) => setTimeout(r, 600));
    const now = await api.evaluate<string | null>(
      "window.__getDetailFocusDebug().key",
    );
    if (now !== focusBefore) break;
  }
  const panProbe = await api.evaluate<DetailFocusProbe>(
    DETAIL_FOCUS_PROBE_EXPR,
  );
  probes[`${device}/pan-after`] = panProbe;
  results.pan = { focusBefore, focusAfter: panProbe.key, steps: panned };
  if (panProbe.key === focusBefore) {
    violations.push(
      `${device}/pan-after: ${PAN_STEPS_MAX} 回パンしても focus が` +
        `${String(focusBefore)} のまま切り替わらない`,
    );
  }
  violations.push(
    ...findDetailFocusViolations(panProbe, `${device}/pan-after`),
  );
  const panShot = `${SCREENSHOT_DIR}/${device}-pan-after.png`;
  await api.screenshot(panShot);
  screenshots.push(panShot);

  // AC7: 年代変更後、同じ中央座標に対して新年代の base から focus が再解決される
  await api.evaluate("window.__setYear(1000)");
  await api.waitFor("window.__getYear() === 1000", 45_000);
  await new Promise((r) => setTimeout(r, 500));
  const yearProbe = await api.evaluate<DetailFocusProbe>(
    DETAIL_FOCUS_PROBE_EXPR,
  );
  probes[`${device}/year-switch`] = yearProbe;
  violations.push(
    ...findDetailFocusViolations(yearProbe, `${device}/year-switch`),
  );
  const yearShot = `${SCREENSHOT_DIR}/${device}-year-switch.png`;
  await api.screenshot(yearShot);
  screenshots.push(yearShot);

  results.probes = probes;
  results.violations = violations;
  results.screenshots = screenshots;
  const overallOk = violations.length === 0;
  results.overallOk = overallOk;

  console.log(JSON.stringify(results, null, 2));
  if (violations.length > 0) {
    console.log(
      `\n[DETAIL-FOCUS] 詳細表示 focus の違反を ${violations.length} 件検出` +
        `（#350）:\n  ${violations.join("\n  ")}`,
    );
  }
  console.log(overallOk ? "\n[RESULT] PASS" : "\n[RESULT] FAIL");
  if (!overallOk) {
    throw new Error("detail-focus check failed: see JSON output above");
  }
}
