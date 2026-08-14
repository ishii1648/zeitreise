/**
 * デバイスエミュレーション下でのラベル描画検査（Issue #320）。
 *
 * ## 何を検査するのか
 *
 * `Emulation.setDeviceMetricsOverride`（`--device=mobile` 等）だけを掛けた
 * ヘッドレス Chrome では、deck.gl の TextLayer によるラベル（勢力名・都市名・
 * 河川名・山岳名）が**一切描画されない**。ポリゴン・河川ライン・都市マーカーは
 * 正常に描画されるため、スクリーンショットは「ラベルだけ無い絵」になり、
 * ラベルの回帰が見逃される（Issue #320 の実害）。
 *
 * ## 原因（実測）
 *
 * 本番 https://zeitreises.com/ を 390x844 / DPR 3 のエミュレーションで開いて
 * 各 canvas の実サイズを測ると:
 *
 * | 条件 | window.devicePixelRatio | maplibre canvas | deck overlaid canvas | ラベル |
 * | --- | --- | --- | --- | --- |
 * | エミュレーションのみ DPR 1 | 1 | 390x844 | 390x844 | 出る |
 * | エミュレーションのみ DPR 2 | 2 | 780x1688 | 390x844 | 出ない |
 * | エミュレーションのみ DPR 3 | 3 | 1170x2532 | 390x844 | 出ない |
 * | `--force-device-scale-factor=3` + DPR 3 | 3 | 1170x2532 | 1170x2532 | 出る |
 *
 * つまり `Emulation.setDeviceMetricsOverride` は `window.devicePixelRatio` と
 * MapLibre 側の canvas は DPR 倍に拡げるが、deck.gl（luma.gl）の overlaid
 * canvas のドローイングバッファは CSS ピクセルのまま据え置かれる。この
 * 「JS から見える DPR」と「deck の実バッファ解像度」の不一致がラベルを
 * 全滅させる（ラベル 5 層は CollisionFilterExtension の同一衝突空間に載って
 * おり、衝突マップの解像度前提が崩れると全ラベルが不可視と判定される。
 * 同種の全滅は layer_stack.ts の OVERLAID_LAYER_IDS でも記録がある）。
 * ブラウザ側の実スケールを合わせる `--force-device-scale-factor=<DPR>` を
 * 付けると不一致が消え、ラベルが正常に描画される。
 *
 * ## この検査の役割
 *
 * `__getPowerLabelDebug` 等のデバッグフックは**データ段のラベル件数**しか
 * 返さないため、ラベル全滅時も件数は変わらない（実測: 壊れている DPR 3 でも
 * `visible.base` は 55 のまま）。したがってフックの件数だけでは Issue #320 を
 * 検出できない。そこで本モジュールは
 *
 * 1. 4 種のラベルがデータ段で 1 件以上あること（フック）
 * 2. deck の overlaid canvas が `devicePixelRatio` 倍の解像度を持つこと
 *    （= ラベルが実際に描画される前提が成立していること）
 *
 * の両方を検査する。2 が現行ハーネスの欠陥をそのまま突く条件で、
 * `--force-device-scale-factor` を付けない限り red になる。
 *
 * リモート CDP モード（`CDP_BROKER`）では Chrome の起動引数をこちら側から
 * 付けられないため、broker 側の Chrome にも同等のスケール設定が要る。
 * その場合も本検査が red で知らせる（沈黙して見逃すことはない）。
 */

/** deck.gl の overlaid オーバーレイが作る canvas の id（@deck.gl/core 既定）。 */
export const DECK_LABEL_CANVAS_ID = "deckgl-overlay";

/** ラベル canvas の実サイズ（CSS ピクセルとドローイングバッファ）。 */
export interface DeckCanvasSize {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly bufferWidth: number;
  readonly bufferHeight: number;
}

/** 4 種のラベルのデータ段の件数（デバッグフック由来）。 */
export interface LabelCounts {
  /** 勢力名ラベル（`__getPowerLabelDebug().visible` の合計） */
  readonly power: number;
  /** 都市名ラベル（`__getCityDebug().visibleCities`） */
  readonly city: number;
  /** 河川名ラベル（`__getRiverLabelDebug().visibleLabels.length`） */
  readonly river: number;
  /** 山岳名ラベル（`__getMountainLabelDebug().visibleLabels.length`） */
  readonly mountain: number;
}

/** ブラウザ内で採取するラベル描画の計測値。 */
export interface LabelRenderProbe {
  readonly devicePixelRatio: number;
  readonly deckCanvas: DeckCanvasSize | null;
  readonly labelCounts: LabelCounts;
}

/**
 * ドローイングバッファと `CSS サイズ × DPR` のズレをどこまで許容するか（px）。
 * ブラウザは CSS サイズの端数を丸めてバッファ幅を決めるため、1px の差は
 * 正常とみなす。
 */
export const DEVICE_PIXEL_TOLERANCE_PX = 1;

/** ラベル描画計測を採取するブラウザ内評価式（`api.evaluate` に渡す）。 */
export const LABEL_RENDER_PROBE_EXPR = `(() => {
  const g = globalThis;
  const canvas = document.getElementById(${
  JSON.stringify(DECK_LABEL_CANVAS_ID)
});
  const rect = canvas ? canvas.getBoundingClientRect() : null;
  const power = g.__getPowerLabelDebug ? g.__getPowerLabelDebug().visible : {};
  return {
    devicePixelRatio: window.devicePixelRatio,
    deckCanvas: canvas && rect
      ? {
        cssWidth: rect.width,
        cssHeight: rect.height,
        bufferWidth: canvas.width,
        bufferHeight: canvas.height,
      }
      : null,
    labelCounts: {
      power: Object.values(power).reduce((a, b) => a + b, 0),
      city: g.__getCityDebug ? g.__getCityDebug().visibleCities : 0,
      river: g.__getRiverLabelDebug
        ? g.__getRiverLabelDebug().visibleLabels.length
        : 0,
      mountain: g.__getMountainLabelDebug
        ? g.__getMountainLabelDebug().visibleLabels.length
        : 0,
    },
  };
})()`;

// ---- ラベル描画プローブの前提待ち（deck オーバーレイ初期化。Issue #384） ----
//
// LABEL_RENDER_PROBE_EXPR は「その瞬間の」計測値を返すだけなので、deck の
// オーバーレイ生成・リサイズが終わる前に評価すると、同じ 1 つの原因
// （初期化が終わっていない）が観測時点によって別々の失敗に化ける:
//   - deck_app-*.js チャンク未評価: canvas 未生成 + デバッグフック未定義
//     （→「#deckgl-overlay が見つからない」「ラベルがデータ段で 0 件」）
//   - canvas 生成直後: HTMLCanvasElement の既定サイズ 300x150 のまま
//     （→「ドローイングバッファが 300x150 で DPR 相当と一致しない」）
// どちらも #320 のラベル全滅とは無関係な偽陽性なので、プローブ評価の前に
// 初期化完了を明示的に待ち、待てなかった場合は「待機タイムアウト」として
// 失敗させる（Issue #384 AC4）。

/** ラベル件数の採取に使うデバッグフック名（定義済みであることを待つ対象）。 */
export const LABEL_DEBUG_HOOK_NAMES: readonly string[] = [
  "__getPowerLabelDebug",
  "__getCityDebug",
  "__getRiverLabelDebug",
  "__getMountainLabelDebug",
];

/**
 * deck オーバーレイ初期化待ちの既定タイムアウト（ms）。この待ちに入る時点で
 * appReady（cdp.ts の APP_READY_TIMEOUT_MS）と年代反映（smoke.ts の
 * YEAR_REFLECT_TIMEOUT_MS = 45s）は成立済みで、残るのは deck チャンクの評価と
 * canvas のリサイズだけなので、30s あれば十分な予算になる（実測では
 * 年代反映後 1s 未満で成立する）。超過は待機タイムアウトとして失敗させる。
 */
export const DECK_OVERLAY_READY_TIMEOUT_MS = 30_000;

/** 待機タイムアウトのエラーメッセージ先頭（検査ログの grep 用）。 */
export const LABEL_RENDER_WAIT_TIMEOUT_PREFIX =
  "[LABEL-RENDER-WAIT] 待機タイムアウト";

/**
 * ラベル描画プローブを評価してよい状態かを判定するブラウザ内評価式を
 * 組み立てる純粋関数（`api.waitFor` に渡す）。条件は
 *
 * 1. `#deckgl-overlay` が存在し、ドローイングバッファが
 *    `innerWidth/innerHeight × devicePixelRatio` 以上（= 既定サイズ 300x150 の
 *    ままでも、リサイズ途中でもない）
 * 2. ラベル件数を返すデバッグフックが 4 種とも定義済み（= 遅延ロードした
 *    deck チャンクの評価が完了している）
 *
 * バッファが期待値**未満**でないことだけを見る（過大は #320 の検査
 * {@linkcode findLabelRenderProblems} が判定する領域なので、ここで待ち続けない）。
 */
export function buildDeckOverlayReadyExpr(
  tolerancePx: number = DEVICE_PIXEL_TOLERANCE_PX,
): string {
  return `(() => {
  const g = globalThis;
  const canvas = document.getElementById(${
    JSON.stringify(DECK_LABEL_CANVAS_ID)
  });
  if (!canvas) return false;
  const dpr = window.devicePixelRatio;
  const expectedW = Math.round(window.innerWidth * dpr);
  const expectedH = Math.round(window.innerHeight * dpr);
  if (canvas.width + ${tolerancePx} < expectedW) return false;
  if (canvas.height + ${tolerancePx} < expectedH) return false;
  return ${
    JSON.stringify(LABEL_DEBUG_HOOK_NAMES)
  }.every((name) => typeof g[name] === "function");
})()`;
}

/** 待機タイムアウト時に採取する、待機条件の各要素の最終観測値。 */
export interface DeckOverlayReadyDiagnostics {
  /** `#deckgl-overlay` が存在するか */
  readonly deckCanvasPresent: boolean;
  /** ドローイングバッファ幅（canvas が無ければ null） */
  readonly bufferWidth: number | null;
  /** ドローイングバッファ高（canvas が無ければ null） */
  readonly bufferHeight: number | null;
  /** 期待するバッファ幅（innerWidth × DPR） */
  readonly expectedBufferWidth: number;
  /** 期待するバッファ高（innerHeight × DPR） */
  readonly expectedBufferHeight: number;
  readonly devicePixelRatio: number;
  /** 未定義だったラベル系デバッグフック名 */
  readonly missingHooks: readonly string[];
}

/** {@linkcode DeckOverlayReadyDiagnostics} を採取するブラウザ内評価式。 */
export const DECK_OVERLAY_READY_DIAG_EXPR = `(() => {
  const g = globalThis;
  const canvas = document.getElementById(${
  JSON.stringify(DECK_LABEL_CANVAS_ID)
});
  const dpr = window.devicePixelRatio;
  return {
    deckCanvasPresent: canvas !== null,
    bufferWidth: canvas ? canvas.width : null,
    bufferHeight: canvas ? canvas.height : null,
    expectedBufferWidth: Math.round(window.innerWidth * dpr),
    expectedBufferHeight: Math.round(window.innerHeight * dpr),
    devicePixelRatio: dpr,
    missingHooks: ${
  JSON.stringify(LABEL_DEBUG_HOOK_NAMES)
}.filter((name) => typeof g[name] !== "function"),
  };
})()`;

/** 最終観測値を 1 行のテキストに整形する（エラーメッセージ用）。 */
export function formatDeckOverlayReadyDiagnostics(
  diag: DeckOverlayReadyDiagnostics,
): string {
  const buffer = diag.deckCanvasPresent
    ? `${diag.bufferWidth}x${diag.bufferHeight}`
    : "なし";
  const missing = diag.missingHooks.length === 0
    ? "なし"
    : diag.missingHooks.join(", ");
  return `#${DECK_LABEL_CANVAS_ID} present=${diag.deckCanvasPresent}, ` +
    `buffer=${buffer}, ` +
    `expected>=${diag.expectedBufferWidth}x${diag.expectedBufferHeight} ` +
    `(devicePixelRatio=${diag.devicePixelRatio}), ` +
    `未定義のデバッグフック=${missing}`;
}

/** {@linkcode waitForDeckOverlayReady} が必要とする CdpApi の部分集合。 */
export interface DeckOverlayWaitApi {
  waitFor(expr: string, timeoutMs?: number): Promise<void>;
  evaluate<T = unknown>(expr: string): Promise<T>;
}

/**
 * ラベル描画プローブ（{@linkcode LABEL_RENDER_PROBE_EXPR}）を評価する前に、
 * deck オーバーレイの生成・リサイズとデバッグフックの設置が完了するのを待つ
 * （Issue #384）。待てなかった場合は
 * {@linkcode LABEL_RENDER_WAIT_TIMEOUT_PREFIX} で始まる明示的な「待機
 * タイムアウト」として失敗し、最終観測値を併記する（ラベル 0 件・canvas
 * 300x150 のような紛らわしい失敗内容に化けさせない）。
 *
 * waitFor のタイムアウト以外のエラー（接続断など）はそのまま伝播させる。
 */
export async function waitForDeckOverlayReady(
  api: DeckOverlayWaitApi,
  timeoutMs: number = DECK_OVERLAY_READY_TIMEOUT_MS,
): Promise<void> {
  try {
    await api.waitFor(buildDeckOverlayReadyExpr(), timeoutMs);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith("waitFor timed out")) {
      throw e;
    }
    let diagText: string;
    try {
      diagText = formatDeckOverlayReadyDiagnostics(
        await api.evaluate<DeckOverlayReadyDiagnostics>(
          DECK_OVERLAY_READY_DIAG_EXPR,
        ),
      );
    } catch (diagError) {
      diagText = `diagnostics unavailable: ${
        diagError instanceof Error ? diagError.message : String(diagError)
      }`;
    }
    throw new Error(
      `${LABEL_RENDER_WAIT_TIMEOUT_PREFIX}: deck オーバーレイの初期化が ` +
        `${timeoutMs}ms 以内に完了しませんでした（Issue #384。ラベル描画の` +
        `検査に入る前の前提待ちであり、ラベル件数や canvas 解像度の判定結果` +
        `ではない）[${diagText}]`,
    );
  }
}

/** ラベル種別と表示名（メッセージ用）。 */
const LABEL_KINDS: readonly (readonly [keyof LabelCounts, string])[] = [
  ["power", "勢力名"],
  ["city", "都市名"],
  ["river", "河川名"],
  ["mountain", "山岳名"],
];

/**
 * 計測値からラベル描画の問題を列挙する純粋関数。空配列なら
 * 「エミュレーション下でもラベルが描画されている」と判定してよい。
 */
export function findLabelRenderProblems(
  probe: LabelRenderProbe,
): string[] {
  const problems: string[] = [];
  const { deckCanvas, devicePixelRatio: dpr } = probe;
  if (deckCanvas === null) {
    problems.push(
      `ラベル用の deck canvas (#${DECK_LABEL_CANVAS_ID}) が見つからない`,
    );
  } else {
    const expectedW = Math.round(deckCanvas.cssWidth * dpr);
    const expectedH = Math.round(deckCanvas.cssHeight * dpr);
    if (
      Math.abs(deckCanvas.bufferWidth - expectedW) >
        DEVICE_PIXEL_TOLERANCE_PX ||
      Math.abs(deckCanvas.bufferHeight - expectedH) >
        DEVICE_PIXEL_TOLERANCE_PX
    ) {
      problems.push(
        `ラベル canvas (#${DECK_LABEL_CANVAS_ID}) のドローイングバッファが ` +
          `${deckCanvas.bufferWidth}x${deckCanvas.bufferHeight} で、` +
          `devicePixelRatio ${dpr} 相当の ${expectedW}x${expectedH} と一致しない` +
          "（Issue #320: この不一致下では TextLayer のラベルが 1 つも描画されない。" +
          "Chrome 起動引数 --force-device-scale-factor を DPR に合わせること）",
      );
    }
  }
  for (const [kind, name] of LABEL_KINDS) {
    if (probe.labelCounts[kind] <= 0) {
      problems.push(`${name}ラベルがデータ段で 0 件（${kind}）`);
    }
  }
  return problems;
}
