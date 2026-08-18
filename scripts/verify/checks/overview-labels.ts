/**
 * Issue #442: z4 国名ラベルの全19年代実ブラウザ監査。
 *
 * viewport 1600x900 / center 15,50 / zoom 4 を固定し、各年代の実
 * deck.gl canvas をスクリーンショットに残す。manifest には描画層の
 * getPosition へ実際に渡す候補名と画面座標を併記する。これにより、
 * 件数や近似衝突シミュレーターだけでなく、19 枚を候補一覧と人が
 * 目視照合できる。
 *
 * 実行:
 *   deno task build
 *   deno task serve
 *   deno task verify:overview-labels http://localhost:8000/
 */

import { SNAPSHOT_YEARS } from "../../../src/config.ts";
import type { CdpApi } from "../cdp.ts";
import { waitForYearReflected } from "./smoke.ts";

export const OVERVIEW_AUDIT_VIEWPORT = {
  width: 1600,
  height: 900,
  center: [15, 50] as const,
  zoom: 4,
};

export const OVERVIEW_AUDIT_DIR = "scripts/verify/checks/.overview-label-audit";

export interface OverviewAuditLabel {
  text: string;
  position: [number, number];
  screen: { x: number; y: number };
  moved: boolean;
  calloutAnchor: [number, number] | null;
}

export interface OverviewAuditProbe {
  zoomStep: number;
  politicalLevel: "overview" | "mid" | "detail";
  overviewLabels: OverviewAuditLabel[];
}

export function findOverviewAuditProblems(
  probe: OverviewAuditProbe,
  viewport = OVERVIEW_AUDIT_VIEWPORT,
): string[] {
  const problems: string[] = [];
  if (probe.zoomStep !== viewport.zoom || probe.politicalLevel !== "overview") {
    problems.push(
      `overview 条件不一致: zoom=${probe.zoomStep}, level=${probe.politicalLevel}`,
    );
  }
  const names = new Set<string>();
  for (const label of probe.overviewLabels) {
    if (names.has(label.text)) problems.push(`同名候補: ${label.text}`);
    names.add(label.text);
    if (label.moved && label.calloutAnchor === null) {
      problems.push(`callout 元アンカー欠落: ${label.text}`);
    }
    // 地図範囲外を説明対象とする候補も一覧には含まれるため、screen 座標は
    // manifest へ記録するだけにする。移動の妥当性・文字切れ・画面外配置は
    // 近似値で合否を決めず、19 枚のスクリーンショットで目視確認する。
  }
  if (probe.overviewLabels.length === 0) problems.push("候補が 0 件");
  return problems;
}

export async function run(api: CdpApi): Promise<void> {
  await Deno.mkdir(OVERVIEW_AUDIT_DIR, { recursive: true });
  // broker の既定ウィンドウはホストの作業領域に依存する。現在の DPR を
  // 保ったまま CSS viewport だけを固定し、local / broker の双方で Issue の
  // 1600x900 条件を再現する。
  const deviceScaleFactor = await api.evaluate<number>(
    "window.devicePixelRatio || 1",
  );
  await api.setEmulation({
    width: OVERVIEW_AUDIT_VIEWPORT.width,
    height: OVERVIEW_AUDIT_VIEWPORT.height,
    deviceScaleFactor,
    mobile: false,
    touch: false,
  });
  const origin = await api.evaluate<string>("location.origin");
  const { center, zoom, width, height } = OVERVIEW_AUDIT_VIEWPORT;
  await api.navigate(
    `${origin}/?year=${SNAPSHOT_YEARS[0]}&zoom=${zoom}&center=${center[0]},${
      center[1]
    }`,
  );
  await api.waitForAppReady();
  await api.waitFor(
    "typeof window.__getPowerLabelDebug === 'function' && " +
      "window.__getPowerLabelDebug().overviewLabels.length > 0",
    45_000,
  );

  const actualViewport = await api.evaluate<{ width: number; height: number }>(
    "({ width: window.innerWidth, height: window.innerHeight })",
  );
  const globalProblems: string[] = [];
  if (actualViewport.width !== width || actualViewport.height !== height) {
    globalProblems.push(
      `viewport 不一致: ${actualViewport.width}x${actualViewport.height} ` +
        `(期待 ${width}x${height})`,
    );
  }

  const years: Record<string, unknown> = {};
  for (const year of SNAPSHOT_YEARS) {
    await api.evaluate(`window.__setYear(${year})`);
    await waitForYearReflected(api, year);
    await api.waitFor(
      `window.__getPowerLabelDebug().overviewLabels.length > 0`,
      45_000,
    );
    // CollisionFilterEffect は前フレームの FBO を読む。2 フレーム後を撮る。
    await api.evaluate(
      "new Promise((resolve) => requestAnimationFrame(() => " +
        "requestAnimationFrame(resolve)))",
    );
    const probe = await api.evaluate<OverviewAuditProbe>(
      "window.__getPowerLabelDebug()",
    );
    const problems = findOverviewAuditProblems(probe);
    const screenshot = `${OVERVIEW_AUDIT_DIR}/${year}-z4.png`;
    await api.screenshot(screenshot);
    years[String(year)] = {
      candidateCount: probe.overviewLabels.length,
      candidates: probe.overviewLabels,
      problems,
      screenshot,
      visualCheck: "pending-human-review",
    };
    globalProblems.push(...problems.map((problem) => `${year}: ${problem}`));
  }

  const manifest = {
    conditions: { width, height, center, zoom, language: "ja" },
    years,
    problems: globalProblems,
    visualChecklist: [
      "候補一覧の全国名が表示され判読できる",
      "国名同士の重なりがない",
      "文字切れや不適切な画面外配置がない",
      "ラベルが説明対象領域から離れすぎていない",
    ],
  };
  const manifestPath = `${OVERVIEW_AUDIT_DIR}/manifest.json`;
  await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ manifestPath, ...manifest }, null, 2));
  if (globalProblems.length > 0) {
    throw new Error(
      `overview label audit failed: ${globalProblems.join("; ")}`,
    );
  }
}
