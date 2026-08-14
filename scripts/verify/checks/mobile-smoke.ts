/**
 * モバイル条件のスモークチェック（TASK-131、deno task verify:smoke:mobile で使用）。
 *
 * CDP エミュレーション（幅 390 / 高さ 844 / DPR 3 / mobile / タッチ有効。
 * cdp.ts の MOBILE_PRESET）で以下を無人確認する:
 *   1. エミュレーションの反映（innerWidth / devicePixelRatio / maxTouchPoints）
 *   2. 地図描画（canvas がビューポート相当のサイズで存在）とアプリ起動
 *   3. 年代切替（__setYear → 反映を waitForYearReflected。Issue #282 の
 *      45s 予算 + エラートースト早期 fail を標準スモークと共有する）
 *   3b. ラベル描画の検査（Issue #320）。勢力名・都市名・河川名・山岳名の
 *      4 種がデータ段に存在し、deck のラベル canvas が devicePixelRatio 倍の
 *      解像度を持つ（= エミュレーション下でも TextLayer が描画される）ことを
 *      検査する。スクリーンショットにラベルが写ることの前提条件にあたる。
 *      プローブは瞬間値なので、評価前に deck オーバーレイの生成・リサイズと
 *      ラベル系デバッグフックの設置完了を待つ（Issue #384。待てなければ
 *      「待機タイムアウト」として明示的に失敗する）
 *   4. タップ相当入力（Input.dispatchTouchEvent）でポリゴン picking →
 *      情報パネル表示。Issue #253: タップ後はカーソル追従ツールチップが
 *      残らないこと・選択強調（selectedRiverName）が入ることも検査する
 *   5. 主要 UI（タイムライン・情報パネル・アトリビューション）の重なり計測。
 *      TASK-132 で小画面レイアウトを調整したため、重なりが 1 件でもあれば
 *      失敗にする（TASK-131 時点は報告のみだった）
 *   5b. Safe Area inset エミュレーション（Issue #256）。app.css の
 *      --safe-area-* 変数を縦持ちノッチ相当（bottom 34px）で上書きし、
 *      下端 UI がホームインジケーター帯へ入らない・重ならないことを検査する
 *   6. タップ当たり判定の計測（TASK-132 AC #4）。主要タップ対象の実寸が
 *      44px 未満なら失敗にする
 *   6b. 展開したアトリビューション本文の計測（Issue #254 / #328）。右下の
 *      ⓘ を開き、本文リンクの実寸と本文の横スクロールを計測する。390x844 で
 *      計測後、320x568（SMALL_MOBILE_PRESET）へ切り替えて同じ計測を繰り返し、
 *      44px 未満の要素・計測ゼロ（空振り）・横スクロールを失敗にする
 *   6c. アトリビューションの内容と開閉の検査（#328）。初期表示が折りたたみ
 *      （ⓘ 1 個）であること、1 タップで必要な出典・ライセンスへ到達できること、
 *      境界精度の免責・制限一覧が含まれないことを検査する
 *   7. スクリーンショット保存（.outputs/claude/task131/ ・
 *      .outputs/claude/issue254/ ・.outputs/claude/issue256/。目視確認用）
 *
 * 使い方:
 *   deno task build && deno task serve --port 8131 &
 *   deno task verify:smoke:mobile http://localhost:8131/
 *   （直接起動する場合は
 *    `deno run -A scripts/verify/cdp.ts --device=mobile http://localhost:8131/ \
 *       scripts/verify/checks/mobile-smoke.ts`）
 */
import type { CdpApi } from "../cdp.ts";
// cdp.ts からではなく emulation.ts から import する（cdp.ts の CLI は
// top-level await 中にこのモジュールを dynamic import するため、cdp.ts への
// value import は循環参照でデッドロックする）。
import { MOBILE_PRESET, SMALL_MOBILE_PRESET } from "../emulation.ts";
import {
  findLabelRenderProblems,
  LABEL_RENDER_PROBE_EXPR,
  type LabelRenderProbe,
  waitForDeckOverlayReady,
} from "../label_render.ts";
import {
  buildClearSafeAreaInsetsExpr,
  buildSetSafeAreaInsetsExpr,
  findSafeAreaViolations,
  PORTRAIT_NOTCH_INSETS,
} from "./safe-area.ts";
// 年代反映待ちは標準スモークと同じ実装を使う（Issue #282 で 15s → 45s +
// エラートーストによる早期 fail に見直した共通ロジック。Issue #384 で
// モバイル条件にも適用した）。smoke.ts は cdp.ts を type import しか
// しないため循環参照にならない。
import { waitForYearReflected } from "./smoke.ts";

/** スクリーンショット出力先ディレクトリ（gitignore 済みの .outputs/ 配下） */
export const SCREENSHOT_DIR = ".outputs/claude/task131";
/** 初期表示（年代切替後）のスクリーンショット */
export const MOBILE_SCREENSHOT_PATH = `${SCREENSHOT_DIR}/mobile-smoke.png`;
/** タップで情報パネルを開いた状態のスクリーンショット */
export const MOBILE_TAP_SCREENSHOT_PATH = `${SCREENSHOT_DIR}/mobile-tap.png`;
/** Safe Area inset 検証のスクリーンショット出力先（Issue #256） */
export const SAFE_AREA_SCREENSHOT_DIR = ".outputs/claude/issue256";
/** 縦持ち bottom inset 注入時のスクリーンショット（Issue #256 AC3） */
export const MOBILE_INSET_SCREENSHOT_PATH =
  `${SAFE_AREA_SCREENSHOT_DIR}/mobile-bottom-inset.png`;
/** アトリビューションを展開した状態のスクリーンショット（#328） */
export const ATTRIBUTION_SCREENSHOT_PATH =
  `${SCREENSHOT_DIR}/mobile-attribution.png`;

// ---- 重なり計測の純ロジック（mobile-smoke_test.ts でユニットテストする） ----

/** getBoundingClientRect 相当の矩形（viewport 基準）。 */
export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** セレクタと、その要素の viewport 基準矩形。 */
export interface UiRect {
  readonly selector: string;
  readonly rect: Rect;
}

/** 重なりと見なす交差面積の下限（px^2）。角が触れる程度の微小交差を除外する。 */
export const OVERLAP_MIN_AREA_PX = 4;

/** 2 矩形の交差面積を返す（交差しなければ 0）。 */
export function rectOverlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (width <= 0 || height <= 0) return 0;
  return width * height;
}

/**
 * 可視 UI 要素の矩形群から、交差面積が閾値以上のペアを列挙する純粋関数。
 * モバイル幅で UI 同士が重なって操作不能になる箇所を検出する
 * （TASK-132 でレイアウトを調整済みのため、検出 = 回帰として失敗にする）。
 */
export function findOverlaps(
  rects: readonly UiRect[],
  minAreaPx: number = OVERLAP_MIN_AREA_PX,
): Array<{ a: string; b: string; area: number }> {
  const overlaps: Array<{ a: string; b: string; area: number }> = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const area = rectOverlapArea(rects[i].rect, rects[j].rect);
      if (area >= minAreaPx) {
        overlaps.push({
          a: rects[i].selector,
          b: rects[j].selector,
          area,
        });
      }
    }
  }
  return overlaps;
}

/**
 * モバイル幅で地図面を占有・相互干渉しうる主要 UI のセレクタ。
 * 非表示（hidden・display:none 等）の要素は計測時に除外する。
 */
export const UI_OVERLAP_SELECTORS: readonly string[] = [
  ".timeline",
  ".info-panel",
  // #328: 常設の補助 UI は右下のコンパクトなアトリビューション「ⓘ」だけに
  // なった（左上の独自ⓘ・⚠は撤去）。起動直後に折りたたまれる（AC1）ので、
  // ここで測るのは 44px の ⓘ とタイムライン・情報パネルの分離。
  ".maplibregl-ctrl-attrib",
];

// ---- タップ当たり判定の計測（TASK-132 AC #4） ----

/**
 * タップ当たり判定の下限（px）。iOS HIG / WCAG 2.5.5 相当の 44px。
 * app.css の小画面ブレークポイントはこの値を満たすようトグル・ボタン類を
 * 44px 以上にしている。
 */
export const MIN_TAP_TARGET_PX = 44;

/**
 * タップ当たり判定を検査する主要タップ対象。`.info-panel-close` は情報パネルが
 * 開いた状態（タップ picking 後）でのみ可視になるため、計測は picking 確認の
 * 後に行う。非表示の要素は buildUiRectsExpr が除外する。
 */
export const TAP_TARGET_SELECTORS: readonly string[] = [
  "#timeline-prev",
  "#timeline-next",
  ".timeline-slider",
  // #328: 撤去した左上トグル（.footer-toggle / .known-limitations-toggle）の
  // 代わりに、統合したアトリビューションの「ⓘ」を検査する
  ".maplibregl-ctrl-attrib-button",
  ".info-panel-close",
];

/**
 * 可視タップ対象の矩形群から、幅または高さが下限未満のものを寸法付きで
 * 列挙する純粋関数（mobile-smoke_test.ts でユニットテストする）。
 */
export function findSmallTapTargets(
  rects: readonly UiRect[],
  minPx: number = MIN_TAP_TARGET_PX,
): Array<{ selector: string; width: number; height: number }> {
  const small: Array<{ selector: string; width: number; height: number }> = [];
  for (const { selector, rect } of rects) {
    const width = rect.right - rect.left;
    const height = rect.bottom - rect.top;
    if (width < minPx || height < minPx) {
      small.push({ selector, width, height });
    }
  }
  return small;
}

// ---- 補助パネル内のタップ対象の計測（Issue #254） ----

/** 補助パネルのスクリーンショット出力先（gitignore 済みの .outputs/ 配下） */
export const AUX_PANEL_SCREENSHOT_DIR = ".outputs/claude/issue254";

/**
 * 展開したパネル内で 44px 相当のタップ領域を要求するセレクタ
 * （Issue #254 AC1-AC3 / #328）。常設のトグル（TAP_TARGET_SELECTORS）と違い、
 * 展開しないと DOM に現れない・複数マッチする要素なので、buildAllUiRectsExpr で
 * 全マッチを計測し、findMissingTapTargets で「1 件も計測できなかった空振り」を
 * 失敗にする。
 *
 * #328: 左上の ⓘ/⚠ パネル（出典・制限一覧）を撤去したため、対象は統合した
 * アトリビューション本文のリンクだけになった。情報パネルに残る唯一のタップ
 * 対象は閉じるボタンで、それは常設側の TAP_TARGET_SELECTORS が検査している。
 */
export const AUX_PANEL_TAP_TARGET_SELECTORS: readonly string[] = [
  ".maplibregl-ctrl-attrib-inner a",
];

/**
 * ブラウザ内で可視 UI 要素の矩形を **全マッチについて** 収集する評価式を
 * 組み立てる（buildUiRectsExpr の querySelectorAll 版。Issue #254）。
 * 同一セレクタの複数マッチを区別できるよう、selector には `[index]` を付ける
 * （例: ".maplibregl-ctrl-attrib-inner a[3]"）。
 */
export function buildAllUiRectsExpr(selectors: readonly string[]): string {
  return `(() => {
  const selectors = ${JSON.stringify(selectors)};
  const rects = [];
  for (const selector of selectors) {
    const els = document.querySelectorAll(selector);
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const style = window.getComputedStyle(el);
      if (
        el.hidden || style.display === "none" || style.visibility === "hidden"
      ) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      rects.push({
        selector: selector + "[" + i + "]",
        rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      });
    }
  }
  return rects;
})()`;
}

/**
 * 要求セレクタのうち 1 件も計測されなかったものを列挙する純粋関数
 * （Issue #254）。パネルが開かなかった・要素が描画されなかった等の理由で
 * 計測対象が 0 件のまま findSmallTapTargets が空配列を返す「空振り合格」を
 * 失敗として検出する。buildAllUiRectsExpr が付ける `[index]` を剥がして
 * 照合する。
 */
export function findMissingTapTargets(
  rects: readonly UiRect[],
  selectors: readonly string[],
): string[] {
  return selectors.filter((selector) =>
    !rects.some((r) =>
      r.selector === selector || r.selector.startsWith(`${selector}[`)
    )
  );
}

/** パネルの横方向スクロール計測（scrollWidth / clientWidth）。 */
export interface PanelScrollProbe {
  readonly selector: string;
  readonly scrollWidth: number;
  readonly clientWidth: number;
}

/** 横スクロール判定のピクセル許容誤差（サブピクセル丸め対策） */
export const HSCROLL_TOLERANCE_PX = 1;

/**
 * scrollWidth が clientWidth を許容誤差超で上回るパネルを列挙する純粋関数
 * （Issue #254 AC4）。タップ領域の拡張（padding + 負 margin）が右方向の
 * scrollable overflow を生むとパネルが横スクロールしてしまうため、
 * 展開中の各パネルで検査する。要素が見つからなかった計測（null）は無視する。
 */
export function findHorizontalOverflow(
  probes: readonly (PanelScrollProbe | null)[],
  tolerancePx: number = HSCROLL_TOLERANCE_PX,
): PanelScrollProbe[] {
  return probes.filter((p): p is PanelScrollProbe =>
    p !== null && p.scrollWidth > p.clientWidth + tolerancePx
  );
}

/** パネル 1 枚の scrollWidth / clientWidth を測る評価式を組み立てる。
 * #328: アトリビューションはスクロールコンテナが本文
 * （.maplibregl-ctrl-attrib-inner）なので、存在すれば本文側を測る
 * （情報パネルは従来どおりカード自身）。 */
function panelScrollProbeExpr(selector: string): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  const scroller = el.querySelector(".maplibregl-ctrl-attrib-inner") ?? el;
  return {
    selector: ${JSON.stringify(selector)},
    scrollWidth: scroller.scrollWidth,
    clientWidth: scroller.clientWidth,
  };
})()`;
}

// ---- アトリビューションの検査（#328） ----

/** 展開前後のアトリビューションの状態（ブラウザから収集した実測値） */
export interface AttributionState {
  /** コントロールが `maplibregl-compact`（= ⓘ 1 個の折りたたみ形）か */
  readonly compact: boolean;
  /** 本文が可視か（maplibregl-compact-show） */
  readonly expanded: boolean;
  /** `<details open>`（支援技術へ伝わる展開状態） */
  readonly detailsOpen: boolean;
  /** ⓘ ボタンの aria-label */
  readonly toggleAriaLabel: string | null;
  /** 本文のテキスト（リンク文字列を含む） */
  readonly text: string;
  /** 本文中のリンク href 一覧 */
  readonly hrefs: readonly string[];
}

/** ブラウザ内でアトリビューションの状態を収集する評価式 */
export const ATTRIBUTION_STATE_EXPR = `(() => {
  const el = document.querySelector('.maplibregl-ctrl-attrib');
  if (!el) return null;
  const button = el.querySelector('.maplibregl-ctrl-attrib-button');
  const inner = el.querySelector('.maplibregl-ctrl-attrib-inner');
  return {
    compact: el.classList.contains('maplibregl-compact'),
    expanded: el.classList.contains('maplibregl-compact-show'),
    detailsOpen: el.hasAttribute('open'),
    toggleAriaLabel: button ? button.getAttribute('aria-label') : null,
    text: inner ? inner.textContent : '',
    hrefs: inner
      ? Array.from(inner.querySelectorAll('a')).map((a) => a.getAttribute('href'))
      : [],
  };
})()`;

/**
 * 展開したアトリビューションに必ず現れる出典・ライセンス（AC3/AC4/AC5）。
 * source attribution 由来（OSM / Protomaps / Terrain Tiles）と歴史データ由来を
 * まとめて要求することで、「自動収集の維持」と「統合表示」の両方を検査する。
 */
export const REQUIRED_ATTRIBUTION_TOKENS: readonly string[] = [
  "OpenStreetMap",
  "Protomaps",
  "ODbL",
  "Terrain Tiles",
  "historical-basemaps",
  "GPL-3.0",
  "ETH Zürich",
  "CC BY-NC-SA 4.0",
  "Cliopatria",
  "CC BY 4.0",
  // 変更表示（ODbL / CC BY の要件）
  "変更",
];

/** 展開したアトリビューションに現れてはならない文言（AC6） */
export const FORBIDDEN_ATTRIBUTION_TOKENS: readonly string[] = [
  "概略",
  "既知の制限",
];

/**
 * アトリビューションの状態から問題点を列挙する純粋関数（#328。
 * mobile-smoke_test.ts でユニットテストする）。問題なしは空配列。
 *
 * @param initial 初期表示（操作前）の状態。折りたたみ済みであること（AC1）
 * @param expanded ⓘ を 1 回操作した後の状態。必要な出典へ到達できること（AC3）
 */
export function findAttributionProblems(
  initial: AttributionState | null,
  expanded: AttributionState | null,
): string[] {
  const problems: string[] = [];
  if (initial === null || expanded === null) {
    return ["アトリビューションコントロールが見つからない"];
  }
  if (!initial.compact) {
    problems.push("初期表示がコンパクト（ⓘ 1 個）になっていない（AC1）");
  }
  if (initial.expanded || initial.detailsOpen) {
    problems.push("初期表示でアトリビューションが展開されている（AC1）");
  }
  if (!expanded.expanded || !expanded.detailsOpen) {
    problems.push("1 回の操作で展開されない（AC3/AC10）");
  }
  if (
    expanded.toggleAriaLabel === null || expanded.toggleAriaLabel.length === 0
  ) {
    problems.push("ⓘ に aria-label が無い（AC10）");
  }
  for (const token of REQUIRED_ATTRIBUTION_TOKENS) {
    if (!expanded.text.includes(token)) {
      problems.push(`展開した attribution に「${token}」が無い（AC3-AC5）`);
    }
  }
  for (const token of FORBIDDEN_ATTRIBUTION_TOKENS) {
    if (expanded.text.includes(token)) {
      problems.push(
        `展開した attribution に除去対象の「${token}」がある（AC6）`,
      );
    }
  }
  if (expanded.hrefs.length === 0) {
    problems.push("展開した attribution に出典リンクが 1 件も無い（AC3）");
  }
  return problems;
}

// ---- タップ後の表示検査（Issue #253 AC4） ----

/** タップ picking 後の表示状態（ブラウザから収集した実測値）。 */
export interface TapDisplayState {
  /** 情報パネルのラベル文字列（要素なしは null） */
  readonly infoPanelLabel: string | null;
  /** カーソル追従ツールチップ（#info-tooltip）が可視かどうか */
  readonly tooltipVisible: boolean;
  /** 選択強調中の河川名（__getRiverLabelDebug().selected） */
  readonly selectedRiverName: string | null;
}

/** タップ後の表示の期待値。 */
export interface TapDisplayExpectation {
  /** 情報パネルに出るべきラベル */
  readonly infoPanelLabel: string;
  /** 選択強調されるべき河川名（英語の元名） */
  readonly selectedRiverName: string;
}

/**
 * タップ後の表示状態の問題点を列挙する純粋関数（Issue #253 AC4。
 * mobile-smoke_test.ts でユニットテストする）。問題なしは空配列。
 *
 * ホバーを持たないタッチ操作では、選択結果は情報パネル + 選択強調だけに
 * 出るのが正しく、カーソル追従ツールチップが残っていたら二重表示の回帰
 * （Issue #253）として検出する。
 */
export function findTapDisplayProblems(
  state: TapDisplayState,
  expected: TapDisplayExpectation,
): string[] {
  const problems: string[] = [];
  if (state.infoPanelLabel !== expected.infoPanelLabel) {
    problems.push(
      `情報パネルのラベルが「${expected.infoPanelLabel}」ではない: ` +
        JSON.stringify(state.infoPanelLabel),
    );
  }
  if (state.tooltipVisible) {
    problems.push(
      "タップ後にカーソル追従ツールチップが表示されている" +
        "（Issue #253: タッチでは情報パネルだけに出す）",
    );
  }
  if (state.selectedRiverName !== expected.selectedRiverName) {
    problems.push(
      `選択強調中の河川が「${expected.selectedRiverName}」ではない: ` +
        JSON.stringify(state.selectedRiverName),
    );
  }
  return problems;
}

/** ブラウザ内で可視 UI 要素の矩形を収集する評価式を組み立てる。 */
export function buildUiRectsExpr(selectors: readonly string[]): string {
  return `(() => {
  const selectors = ${JSON.stringify(selectors)};
  const rects = [];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const style = window.getComputedStyle(el);
    if (
      el.hidden || style.display === "none" || style.visibility === "hidden"
    ) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    rects.push({
      selector,
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    });
  }
  return rects;
})()`;
}

// smoke.ts と同じライン川（Rhein）上の一点。URL の zoom/center クエリで
// この座標を画面中央に据え、canvas 中央へのタップで picking を検証する。
const RHEIN_POINT: [number, number] = [9.12754, 47.67068];
const TAP_ZOOM = 7;

// 出典 metadata を持つ領邦ポリゴン上の一点（Issue #254 AC3）。カスティーリャ
// 内陸（サラマンカ県東部）で、rivers.geojson の最寄り河川（Tajo）から 81km・
// cities.json の最寄り都市（Bejar）から 47km 離れており、zoom 7 の画面中央
// タップが河川・都市に奪われず必ずポリゴン picking になる。ポリティ・領邦の
// データセット（historical-basemaps / OHM 系）はいずれも metadata に
// sourceUrl を持つため、情報パネルに出典リンクが必ず 1 件以上現れる。
const CASTILE_POINT: [number, number] = [-5.3, 40.6];

const CANVAS_CENTER_EXPR =
  "(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()";

/**
 * アトリビューションの ⓘ を click する評価式。MapLibre のトグルは
 * `<summary>` なので、click でブラウザ標準の disclosure 開閉が走る。
 */
const CLICK_ATTRIBUTION_TOGGLE_EXPR =
  "document.querySelector('.maplibregl-ctrl-attrib-button').click()";

/** 折りたたみ中のときだけ ⓘ を click して開く評価式（冪等） */
const ENSURE_ATTRIBUTION_OPEN_EXPR = `(() => {
  const el = document.querySelector('.maplibregl-ctrl-attrib');
  if (!el.classList.contains('maplibregl-compact-show')) {
    el.querySelector('.maplibregl-ctrl-attrib-button').click();
  }
})()`;

/** 1 つのビューポート条件での補助パネル計測の結果（Issue #254） */
interface AuxPanelMeasurement {
  rects: UiRect[];
  smallTapTargets: Array<{ selector: string; width: number; height: number }>;
  missingTapTargets: string[];
  scrollProbes: Array<PanelScrollProbe | null>;
  horizontalOverflow: PanelScrollProbe[];
  screenshots: string[];
}

/**
 * 展開したアトリビューション本文のインタラクティブ要素の実寸を計測する
 * （Issue #254 / #328）。前提: 情報パネルが開いている（横スクロールの計測に
 * 使う）こと。終了時はアトリビューションを畳んだ状態へ戻すので、ビューポートを
 * 切り替えて再計測しても同じ手順が成立する（冪等）。
 */
async function measureAuxPanels(
  api: CdpApi,
  tag: string,
): Promise<AuxPanelMeasurement> {
  const rects: UiRect[] = [];
  const scrollProbes: Array<PanelScrollProbe | null> = [];
  const screenshots: string[] = [];

  // 情報パネル（勢力タップ済みで開いたまま維持されている）。#283 以降は
  // 出典リンクを持たないため矩形の計測対象は無く、横スクロール（AC4 の
  // 「一文要約がパネル外へあふれない」）だけを見る
  scrollProbes.push(
    await api.evaluate<PanelScrollProbe | null>(
      panelScrollProbeExpr("#info-panel"),
    ),
  );

  // 右下のアトリビューションを展開し、本文リンクの実寸と横スクロールを測る
  await api.evaluate(ENSURE_ATTRIBUTION_OPEN_EXPR);
  await api.waitFor(
    "document.querySelector('.maplibregl-ctrl-attrib')" +
      ".classList.contains('maplibregl-compact-show') && " +
      "document.querySelectorAll('.maplibregl-ctrl-attrib-inner a').length > 0",
    15000,
  );
  rects.push(
    ...await api.evaluate<UiRect[]>(
      buildAllUiRectsExpr([".maplibregl-ctrl-attrib-inner a"]),
    ),
  );
  scrollProbes.push(
    await api.evaluate<PanelScrollProbe | null>(
      panelScrollProbeExpr(".maplibregl-ctrl-attrib"),
    ),
  );
  const attributionShot =
    `${AUX_PANEL_SCREENSHOT_DIR}/aux-attribution-${tag}.png`;
  await api.screenshot(attributionShot);
  screenshots.push(attributionShot);

  // 畳んで再計測に備える（情報パネルは開いたまま）
  await api.evaluate(CLICK_ATTRIBUTION_TOGGLE_EXPR);
  await api.waitFor(
    "!document.querySelector('.maplibregl-ctrl-attrib')" +
      ".classList.contains('maplibregl-compact-show')",
    10000,
  );

  return {
    rects,
    smallTapTargets: findSmallTapTargets(rects),
    missingTapTargets: findMissingTapTargets(
      rects,
      AUX_PANEL_TAP_TARGET_SELECTORS,
    ),
    scrollProbes,
    horizontalOverflow: findHorizontalOverflow(scrollProbes),
    screenshots,
  };
}

export async function run(api: CdpApi): Promise<void> {
  const results: Record<string, unknown> = {};
  await Deno.mkdir(SCREENSHOT_DIR, { recursive: true });
  await Deno.mkdir(AUX_PANEL_SCREENSHOT_DIR, { recursive: true });
  await Deno.mkdir(SAFE_AREA_SCREENSHOT_DIR, { recursive: true });

  // 1. エミュレーションの反映確認
  await api.waitForAppReady();
  const viewport = await api.evaluate<{
    innerWidth: number;
    innerHeight: number;
    devicePixelRatio: number;
    maxTouchPoints: number;
  }>(
    `({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      maxTouchPoints: navigator.maxTouchPoints,
    })`,
  );
  results.viewport = viewport;
  const emulationOk = viewport.innerWidth === MOBILE_PRESET.width &&
    viewport.devicePixelRatio === MOBILE_PRESET.deviceScaleFactor &&
    viewport.maxTouchPoints > 0;
  results.emulationOk = emulationOk;

  // 2. 地図描画（canvas がビューポート幅相当で存在）
  await waitForYearReflected(api, 1000);
  const canvas = await api.evaluate<
    { width: number; height: number } | null
  >(
    `(() => {
      const c = document.querySelector('canvas');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { width: r.width, height: r.height };
    })()`,
  );
  results.canvas = canvas;
  const canvasOk = canvas !== null && canvas.width > 0 && canvas.height > 0;
  results.canvasOk = canvasOk;

  // 3. 年代切替
  await api.evaluate("window.__setYear(1500)");
  await waitForYearReflected(api, 1500);
  const yearAfterSwitch = await api.evaluate<number>("window.__getYear()");
  results.yearAfterSwitch = yearAfterSwitch;
  await api.screenshot(MOBILE_SCREENSHOT_PATH);
  results.screenshot = MOBILE_SCREENSHOT_PATH;

  // 3b. ラベル描画の検査（Issue #320）。初期表示（年代 1500・既定ズーム）で
  // 勢力名・都市名・河川名・山岳名の 4 種がデータ段に存在し、かつ deck の
  // ラベル canvas が devicePixelRatio 倍の解像度を持つことを確認する。
  // 後者はエミュレーション下で TextLayer が全滅する条件そのもので、
  // MOBILE_SCREENSHOT_PATH のスクリーンショットにラベルが写ることの前提。
  // プローブは瞬間値なので、先に deck オーバーレイの生成・リサイズと
  // デバッグフックの設置が終わるのを待つ（Issue #384。待てなければ
  // 「待機タイムアウト」として明示的に失敗する）。
  await waitForDeckOverlayReady(api);
  const labelRenderProbe = await api.evaluate<LabelRenderProbe>(
    LABEL_RENDER_PROBE_EXPR,
  );
  results.labelRenderProbe = labelRenderProbe;
  const labelRenderProblems = findLabelRenderProblems(labelRenderProbe);
  results.labelRenderProblems = labelRenderProblems;
  const labelRenderOk = labelRenderProblems.length === 0;
  results.labelRenderOk = labelRenderOk;

  // 4. タップで picking → 情報パネル表示
  // ライン川を画面中央に据えた URL へ再 navigate し、canvas 中央をタップする。
  const origin = await api.evaluate<string>("location.origin");
  await api.navigate(
    `${origin}/?year=1500&zoom=${TAP_ZOOM}&center=${RHEIN_POINT[0]},${
      RHEIN_POINT[1]
    }`,
  );
  await api.waitForAppReady();
  await waitForYearReflected(api, 1500);
  const center = await api.evaluate<[number, number]>(CANVAS_CENTER_EXPR);
  results.tapPoint = center;
  await api.tap(Math.round(center[0]), Math.round(center[1]));
  await new Promise((r) => setTimeout(r, 800));
  const infoPanelLabel = await api.evaluate<string | null>(
    "document.querySelector('.info-panel-label')?.textContent ?? null",
  );
  results.infoPanelLabel = infoPanelLabel;
  await api.screenshot(MOBILE_TAP_SCREENSHOT_PATH);
  results.tapScreenshot = MOBILE_TAP_SCREENSHOT_PATH;

  // 4b. タップ後の表示検査（Issue #253 AC4）。情報パネルのラベルに加えて、
  // カーソル追従ツールチップが残っていないこと（AC2 の回帰検出）と、
  // タップ対象（ライン川）の選択強調が入っていることを検査する。
  const tooltipVisible = await api.evaluate<boolean>(
    `(() => {
      const el = document.getElementById('info-tooltip');
      if (!el) return false;
      const style = window.getComputedStyle(el);
      return !el.hidden && style.display !== 'none' &&
        style.visibility !== 'hidden';
    })()`,
  );
  const selectedRiverName = await api.evaluate<string | null>(
    "window.__getRiverLabelDebug().selected",
  );
  const tapDisplay: TapDisplayState = {
    infoPanelLabel,
    tooltipVisible,
    selectedRiverName,
  };
  results.tapDisplay = tapDisplay;
  const tapDisplayProblems = findTapDisplayProblems(tapDisplay, {
    infoPanelLabel: "ライン川",
    selectedRiverName: "Rhine",
  });
  results.tapDisplayProblems = tapDisplayProblems;
  const tapDisplayOk = tapDisplayProblems.length === 0;
  results.tapDisplayOk = tapDisplayOk;

  // 5. UI の重なり計測（TASK-132 で調整済みのため、重なり検出 = 失敗）。
  // 情報パネルが開いた状態（前段の picking 後）で測ることで
  // 「常時 UI + 情報パネル」の共存レイアウトを検証する。
  const uiRects = await api.evaluate<UiRect[]>(
    buildUiRectsExpr(UI_OVERLAP_SELECTORS),
  );
  results.uiRects = uiRects;
  const overlaps = findOverlaps(uiRects);
  results.overlaps = overlaps;
  const overlapsOk = overlaps.length === 0;
  results.overlapsOk = overlapsOk;

  // 5b. Safe Area inset エミュレーション（Issue #256）。app.css の
  // --safe-area-* 変数を縦持ちノッチ相当（bottom 34px）で上書きし、下端 UI
  // （タイムラインバー・attribution）がホームインジケーター帯へ入らない・
  // UI 同士が重ならないことを検査する。変数が消費されていなければ UI は
  // 動かず inset 帯に残るので、注入が効いていることの検査も兼ねる。
  // 検査後は上書きを解除して後続の検査を inset 0 に戻す。
  await api.evaluate(buildSetSafeAreaInsetsExpr(PORTRAIT_NOTCH_INSETS));
  await new Promise((r) => setTimeout(r, 300));
  const safeAreaRects = await api.evaluate<UiRect[]>(
    buildUiRectsExpr(UI_OVERLAP_SELECTORS),
  );
  results.safeAreaRects = safeAreaRects;
  const safeAreaViolations = findSafeAreaViolations(
    safeAreaRects,
    { width: viewport.innerWidth, height: viewport.innerHeight },
    PORTRAIT_NOTCH_INSETS,
  );
  results.safeAreaViolations = safeAreaViolations;
  const safeAreaOverlaps = findOverlaps(safeAreaRects);
  results.safeAreaOverlaps = safeAreaOverlaps;
  const safeAreaOk = safeAreaViolations.length === 0 &&
    safeAreaOverlaps.length === 0;
  results.safeAreaOk = safeAreaOk;
  await api.screenshot(MOBILE_INSET_SCREENSHOT_PATH);
  results.safeAreaScreenshot = MOBILE_INSET_SCREENSHOT_PATH;
  await api.evaluate(buildClearSafeAreaInsetsExpr());

  // 6. タップ当たり判定の計測（TASK-132 AC #4。44px 未満の対象があれば失敗）
  const tapTargetRects = await api.evaluate<UiRect[]>(
    buildUiRectsExpr(TAP_TARGET_SELECTORS),
  );
  results.tapTargetRects = tapTargetRects;
  const smallTapTargets = findSmallTapTargets(tapTargetRects);
  results.smallTapTargets = smallTapTargets;
  const tapTargetsOk = smallTapTargets.length === 0;
  results.tapTargetsOk = tapTargetsOk;

  // 6b. 展開したアトリビューション本文のタップ対象計測（Issue #254 / #328）。
  // 情報パネルの一文要約（#283）は勢力ポリゴンのタップでのみ現れるため、
  // 河川（ライン川）ではなく領邦ポリゴン上の一点へ navigate し直してタップする。
  await api.navigate(
    `${origin}/?year=1500&zoom=${TAP_ZOOM}&center=${CASTILE_POINT[0]},${
      CASTILE_POINT[1]
    }`,
  );
  await api.waitForAppReady();
  await waitForYearReflected(api, 1500);
  const polityCenter = await api.evaluate<[number, number]>(CANVAS_CENTER_EXPR);
  results.polityTapPoint = polityCenter;
  await api.tap(Math.round(polityCenter[0]), Math.round(polityCenter[1]));
  // #283: 情報パネルが開き、名称 + 年代 + 一文要約が入ったことを待つ
  // （1500 年のカスティーリャは power-descriptions.json に登録済み）
  await api.waitFor(
    "!document.getElementById('info-panel').hidden && " +
      "!document.getElementById('info-panel-description').hidden",
    15000,
  );

  // 6c. アトリビューションの内容と開閉（#328 AC1/AC3/AC4/AC5/AC6/AC10）。
  // 初期表示（この navigate 後は未操作）が折りたたみであることを測ってから、
  // ⓘ を 1 回 click して必要な出典・ライセンスへ到達できることを測る。
  const attributionInitial = await api.evaluate<AttributionState | null>(
    ATTRIBUTION_STATE_EXPR,
  );
  await api.evaluate(CLICK_ATTRIBUTION_TOGGLE_EXPR);
  await api.waitFor(
    "document.querySelector('.maplibregl-ctrl-attrib')" +
      ".classList.contains('maplibregl-compact-show')",
    10000,
  );
  const attributionExpanded = await api.evaluate<AttributionState | null>(
    ATTRIBUTION_STATE_EXPR,
  );
  results.attributionInitial = attributionInitial;
  results.attributionExpanded = attributionExpanded;
  const attributionProblems = findAttributionProblems(
    attributionInitial,
    attributionExpanded,
  );
  results.attributionProblems = attributionProblems;
  const attributionOk = attributionProblems.length === 0;
  results.attributionOk = attributionOk;
  await api.screenshot(ATTRIBUTION_SCREENSHOT_PATH);
  results.attributionScreenshot = ATTRIBUTION_SCREENSHOT_PATH;
  // 展開したまま次の計測（measureAuxPanels は冪等に開閉する）へ渡す
  const auxPanels390 = await measureAuxPanels(api, "390x844");
  results.auxPanels390 = auxPanels390;
  // 320x568（iPhone SE 初代相当）へ切り替えて同じ計測を行う（AC2）
  await api.setEmulation(SMALL_MOBILE_PRESET);
  await api.waitFor(
    `window.innerWidth === ${SMALL_MOBILE_PRESET.width}`,
    10000,
  );
  const auxPanels320 = await measureAuxPanels(api, "320x568");
  results.auxPanels320 = auxPanels320;
  const auxPanelsOk = [auxPanels390, auxPanels320].every((m) =>
    m.smallTapTargets.length === 0 && m.missingTapTargets.length === 0 &&
    m.horizontalOverflow.length === 0
  );
  results.auxPanelsOk = auxPanelsOk;

  // 7. エラートースト非表示の確認
  const errorToast = await api.evaluate<
    { present: boolean; visible: boolean; text: string | null }
  >(
    `(() => {
      const el = document.querySelector('.error-toast');
      if (!el) return { present: false, visible: false, text: null };
      const style = window.getComputedStyle(el);
      const visible = style.display !== 'none' &&
        style.visibility !== 'hidden' && el.offsetParent !== null;
      return { present: true, visible, text: el.textContent };
    })()`,
  );
  results.errorToast = errorToast;
  const errorToastOk = !errorToast.present || !errorToast.visible;
  results.errorToastOk = errorToastOk;

  const overallOk = Boolean(
    emulationOk &&
      canvasOk &&
      yearAfterSwitch === 1500 &&
      labelRenderOk &&
      tapDisplayOk &&
      overlapsOk &&
      safeAreaOk &&
      tapTargetsOk &&
      attributionOk &&
      auxPanelsOk &&
      errorToastOk,
  );
  results.overallOk = overallOk;

  console.log(JSON.stringify(results, null, 2));
  if (labelRenderProblems.length > 0) {
    console.log(
      `\n[LABEL-RENDER] エミュレーション下のラベル描画に問題を ` +
        `${labelRenderProblems.length} 件検出（Issue #320）:\n  ` +
        labelRenderProblems.join("\n  "),
    );
  }
  if (tapDisplayProblems.length > 0) {
    console.log(
      `\n[TAP-DISPLAY] タップ後の表示に問題を ${tapDisplayProblems.length} 件検出` +
        "（Issue #253 AC4。上の tapDisplayProblems を参照）",
    );
  }
  if (overlaps.length > 0) {
    console.log(
      `\n[OVERLAP] モバイル幅で UI の重なりを ${overlaps.length} 件検出` +
        "（AC #3 の回帰。上の overlaps を参照）",
    );
  }
  if (!safeAreaOk) {
    console.log(
      "\n[SAFE-AREA] 縦持ち bottom inset 注入時の違反を検出" +
        `（Issue #256。violations: ${safeAreaViolations.length} / ` +
        `overlaps: ${safeAreaOverlaps.length}）`,
    );
  }
  if (attributionProblems.length > 0) {
    console.log(
      `\n[ATTRIBUTION] アトリビューションの問題を ` +
        `${attributionProblems.length} 件検出（#328）:\n  ` +
        attributionProblems.join("\n  "),
    );
  }
  if (smallTapTargets.length > 0) {
    console.log(
      `\n[TAP-TARGET] ${MIN_TAP_TARGET_PX}px 未満のタップ対象を ` +
        `${smallTapTargets.length} 件検出（AC #4 の回帰。上の smallTapTargets を参照）`,
    );
  }
  for (
    const [tag, m] of [
      ["390x844", auxPanels390],
      ["320x568", auxPanels320],
    ] as const
  ) {
    if (m.smallTapTargets.length > 0) {
      console.log(
        `\n[AUX-TAP-TARGET ${tag}] 補助パネル内で ${MIN_TAP_TARGET_PX}px 未満の` +
          `タップ対象を ${m.smallTapTargets.length} 件検出` +
          `（Issue #254。上の auxPanels${tag.slice(0, 3)} を参照）`,
      );
    }
    if (m.missingTapTargets.length > 0) {
      console.log(
        `\n[AUX-TAP-TARGET ${tag}] 計測できなかったセレクタ: ` +
          m.missingTapTargets.join(", "),
      );
    }
    if (m.horizontalOverflow.length > 0) {
      console.log(
        `\n[AUX-HSCROLL ${tag}] パネルの横スクロールを検出: ` +
          m.horizontalOverflow.map((p) => p.selector).join(", "),
      );
    }
  }
  console.log(overallOk ? "\n[RESULT] PASS" : "\n[RESULT] FAIL");
  if (!overallOk) {
    throw new Error("mobile smoke check failed: see JSON output above");
  }
}
