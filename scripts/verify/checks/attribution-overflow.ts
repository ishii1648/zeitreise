/**
 * 展開したアトリビューションのはみ出し回帰チェック（TASK-117 → #328）。
 *
 * 右下のアトリビューション（`.maplibregl-ctrl-attrib`）を展開したとき、
 * **本文がビューポートから出ない**ことと、**収まらない場合は本文
 * （`.maplibregl-ctrl-attrib-inner`）がスクロールコンテナになって全内容へ
 * 到達できる**ことを実ブラウザのレイアウトで確認する（#328 AC11）。
 *
 * 元は TASK-117 の bug（左上ポップオーバーに max-height / overflow-y が無く、
 * 中身が増えるほど伸びて画面外へ出る）の回帰チェックだった。#328 で
 * ポップオーバーごと撤去し、同じ検査を統合アトリビューションへ移した。
 * この種の不具合は CSS のレイアウト結果でしか検出できないため、deno test の
 * ユニットテストではなく実ブラウザ計測を回帰検出の主体に置く（判定ロジックと
 * 計測式は下の純粋関数／式文字列として切り出し、attribution-overflow_test.ts が
 * deno test で検証する）。
 *
 * 使い方:
 *   deno task build && deno task serve --port 8041
 *   deno run -A scripts/verify/cdp.ts http://localhost:8041/ \
 *     scripts/verify/checks/attribution-overflow.ts
 */
import type { CdpApi } from "../cdp.ts";

/** 展開したアトリビューションのスクリーンショット出力先 */
export const ATTRIBUTION_SCREENSHOT =
  "scripts/verify/checks/.attribution-expanded.png";

/**
 * 計測に使う年代。表示内容は年代に依存しない（統合アトリビューションは
 * 固定文言）が、TASK-117 の実測条件（1400 年）と揃えておく。
 */
export const PROBE_YEAR = 1400;

/** ブラウザ内で計測したパネルのレイアウト値 */
export interface PanelProbe {
  /** カードの viewport 基準の上端 y。負なら画面上端より上へはみ出している */
  readonly top: number;
  /** カードの viewport 基準の下端 y */
  readonly bottom: number;
  /** window.innerHeight */
  readonly viewportHeight: number;
  /** スクロールコンテナ（本文、無ければカード自身）の可視領域の高さ */
  readonly clientHeight: number;
  /** 内容全体の高さ。clientHeight を超えるならスクロールが必要 */
  readonly scrollHeight: number;
  /** getComputedStyle(スクロールコンテナ).overflowY */
  readonly overflowY: string;
  /** getComputedStyle(スクロールコンテナ).maxHeight */
  readonly maxHeight: string;
  /** 走査した項目数（項目セレクタを渡さなかった場合は 0） */
  readonly itemCount: number;
  /** 先頭までスクロールしたとき先頭項目がカードの可視領域に収まるか */
  readonly firstItemReachable: boolean | null;
  /** 末尾までスクロールしたとき末尾項目がカードの可視領域に収まるか */
  readonly lastItemReachable: boolean | null;
  /** カード内に打った検査点の数 */
  readonly sampledPoints: number;
  /** そのうち他の UI に覆われていた点の数（0 でなければ本文が読めない） */
  readonly occludedPoints: number;
}

/** レイアウト計測のピクセル許容誤差（サブピクセル丸め対策） */
export const TOLERANCE_PX = 1;

/**
 * ブラウザ内でポップオーバーのレイアウトを計測する評価式を組み立てる。
 *
 * 項目セレクタを渡した場合は「先頭までスクロール→先頭項目が可視領域に収まるか」
 * 「末尾までスクロール→末尾項目が収まるか」も測る（スクロールで全項目に到達
 * できるかの判定材料。TASK-117 AC #1 / #328 AC11）。計測後は scrollTop を 0 に
 * 戻すので、続けて撮るスクリーンショットは常に先頭表示になる。
 *
 * @param cardSelector 計測対象のカード（例: ".maplibregl-ctrl-attrib"）
 * @param itemSelector カード内の項目（例: "a"）。不要なら null
 */
export function panelProbeExpr(
  cardSelector: string,
  itemSelector: string | null,
): string {
  const items = itemSelector === null
    ? "[]"
    : `Array.from(card.querySelectorAll(${JSON.stringify(itemSelector)}))`;
  return `(() => {
  const card = document.querySelector(${JSON.stringify(cardSelector)});
  if (!card) return null;
  // #328: アトリビューションはスクロールコンテナが本文
  // （.maplibregl-ctrl-attrib-inner）。存在すれば本文側をスクロール・寸法の
  // 計測対象にする（無いカードは従来どおりカード自身）。
  const scroller =
    (card.querySelector && card.querySelector(".maplibregl-ctrl-attrib-inner")) ||
    card;
  const style = window.getComputedStyle(scroller);
  // 「読める」= カードの可視領域かつビューポート内に項目が収まっていること。
  // カードが画面外へはみ出している場合、カード基準だけでは収まって見えても
  // 実際には読めないため、ビューポートとの交差で判定する（TASK-117）。
  const inside = (el) => {
    const cr = card.getBoundingClientRect();
    const ir = el.getBoundingClientRect();
    const visibleTop = Math.max(cr.top, 0);
    const visibleBottom = Math.min(cr.bottom, window.innerHeight);
    return ir.top >= visibleTop - ${TOLERANCE_PX} &&
      ir.bottom <= visibleBottom + ${TOLERANCE_PX};
  };
  const items = ${items};
  let firstItemReachable = null;
  let lastItemReachable = null;
  if (items.length > 0) {
    scroller.scrollTop = 0;
    firstItemReachable = inside(items[0]);
    scroller.scrollTop = scroller.scrollHeight;
    lastItemReachable = inside(items[items.length - 1]);
    scroller.scrollTop = 0;
  }
  // 覆い被さり検査: カード内に等間隔の検査点を打ち、その位置で最前面にある要素が
  // カード自身（の子孫）かを見る。タイムライン等の別 UI が前面にあると本文は
  // 読めないため、上端が画面内に収まっていても NG とする（TASK-117 AC #1）。
  const rect0 = card.getBoundingClientRect();
  const xs = [0.15, 0.5, 0.85].map((r) => rect0.left + rect0.width * r);
  const ys = [0.1, 0.3, 0.5, 0.7, 0.9].map((r) => rect0.top + rect0.height * r);
  let sampledPoints = 0;
  let occludedPoints = 0;
  for (const x of xs) {
    for (const y of ys) {
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
        continue;
      }
      sampledPoints += 1;
      const topmost = document.elementFromPoint(x, y);
      if (topmost !== card && !card.contains(topmost)) occludedPoints += 1;
    }
  }
  const rect = card.getBoundingClientRect();
  return {
    top: rect.top,
    bottom: rect.bottom,
    viewportHeight: window.innerHeight,
    clientHeight: scroller.clientHeight,
    scrollHeight: scroller.scrollHeight,
    overflowY: style.overflowY,
    maxHeight: style.maxHeight,
    itemCount: items.length,
    firstItemReachable,
    lastItemReachable,
    sampledPoints,
    occludedPoints,
  };
})()`;
}

/**
 * 計測値からポップオーバーが「全内容を読める状態か」を判定する純粋関数。
 *
 * 判定条件（TASK-117 AC #1 / #328 AC11）:
 * - 上端・下端がビューポート内に収まっている（はみ出した分は body が縦スクロール
 *   しないため到達不能になる）
 * - 内容が収まらない場合は本文がスクロールコンテナである
 * - 先頭項目・末尾項目のどちらにもスクロールで到達できる
 * - 本文が他の UI（タイムライン等）に覆われていない
 */
export function judgePanelLayout(
  probe: PanelProbe | null,
): { ok: boolean; reasons: string[] } {
  if (probe === null) {
    return {
      ok: false,
      reasons: ["カードが見つからない（未展開または未配線）"],
    };
  }
  const reasons: string[] = [];
  if (probe.top < -TOLERANCE_PX) {
    reasons.push(
      `上端がビューポート外（top=${probe.top}）。上へはみ出した分は到達できない`,
    );
  }
  if (probe.bottom > probe.viewportHeight + TOLERANCE_PX) {
    reasons.push(
      `下端がビューポート外（bottom=${probe.bottom} > ${probe.viewportHeight}）`,
    );
  }
  const overflows = probe.scrollHeight > probe.clientHeight + TOLERANCE_PX;
  const scrollable = probe.overflowY === "auto" || probe.overflowY === "scroll";
  if (overflows && !scrollable) {
    reasons.push(
      `内容が収まらない（scrollHeight=${probe.scrollHeight} > clientHeight=` +
        `${probe.clientHeight}）のに overflow-y=${probe.overflowY} でスクロールできない`,
    );
  }
  if (probe.firstItemReachable === false) {
    reasons.push("先頭項目がスクロールしても可視領域に収まらない");
  }
  if (probe.lastItemReachable === false) {
    reasons.push("末尾項目がスクロールしても可視領域に収まらない");
  }
  if (probe.occludedPoints > 0) {
    reasons.push(
      `本文が他の UI に覆われている（検査点 ${probe.sampledPoints} 点中 ` +
        `${probe.occludedPoints} 点が前面を別要素に取られている）`,
    );
  }
  return { ok: reasons.length === 0, reasons };
}

/** アトリビューションの ⓘ を click する評価式（`<summary>` の標準開閉） */
const CLICK_ATTRIBUTION_TOGGLE_EXPR =
  "document.querySelector('.maplibregl-ctrl-attrib-button').click()";

/** 展開済みかどうかの判定式 */
const ATTRIBUTION_EXPANDED_EXPR =
  "document.querySelector('.maplibregl-ctrl-attrib')" +
  ".classList.contains('maplibregl-compact-show')";

export async function run(api: CdpApi): Promise<void> {
  const results: Record<string, unknown> = {};

  await api.waitForAppReady();
  await api.waitFor("window.__getYear && window.__getYear() === 1000", 15000);
  await api.evaluate(`window.__setYear(${PROBE_YEAR})`);
  await api.waitFor(`window.__getYear() === ${PROBE_YEAR}`, 15000);

  // #328 AC1: 起動直後は折りたたみ（ⓘ 1 個）であること
  const collapsed = await api.evaluate<boolean>(ATTRIBUTION_EXPANDED_EXPR);
  results.expandedOnLoad = collapsed;

  // 1 タップで展開し、本文のレイアウトを計測する
  await api.evaluate(CLICK_ATTRIBUTION_TOGGLE_EXPR);
  await api.waitFor(ATTRIBUTION_EXPANDED_EXPR, 10000);
  const attribution = await api.evaluate<PanelProbe | null>(
    panelProbeExpr(".maplibregl-ctrl-attrib", "a"),
  );
  results.attribution = attribution;
  const attributionJudge = judgePanelLayout(attribution);
  results.attributionJudge = attributionJudge;
  await api.screenshot(ATTRIBUTION_SCREENSHOT);
  results.attributionScreenshot = ATTRIBUTION_SCREENSHOT;

  const overallOk = attributionJudge.ok && collapsed === false;
  results.overallOk = overallOk;

  console.log(JSON.stringify(results, null, 2));
  console.log(overallOk ? "\n[RESULT] PASS" : "\n[RESULT] FAIL");
  if (!overallOk) {
    throw new Error("attribution-overflow check failed: see JSON output above");
  }
}
