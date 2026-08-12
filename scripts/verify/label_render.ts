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
