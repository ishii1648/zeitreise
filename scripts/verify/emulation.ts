/**
 * デバイスエミュレーションの純ロジック（TASK-131）。
 *
 * cdp.ts から分離している理由: checkScript（checks/mobile-smoke.ts 等）が
 * プリセットを value import すると、cdp.ts（CLI として top-level await 中）→
 * dynamic import → checkScript → cdp.ts の循環参照でモジュール評価が
 * デッドロックする（"Top-level await promise never resolved"）。checkScript は
 * このモジュールから import し、cdp.ts は再 export して従来の import 経路も
 * 維持する。
 */

/**
 * CDP Emulation ドメインに渡す画面・端末条件。指定すると
 * `Emulation.setDeviceMetricsOverride`（ビューポート・DPR・mobile レイアウト）と
 * `Emulation.setTouchEmulationEnabled`（タッチ入力）を launch 時に適用する。
 */
export interface EmulationConfig {
  /** ビューポート幅（CSS px） */
  width: number;
  /** ビューポート高さ（CSS px） */
  height: number;
  /** devicePixelRatio に反映される倍率 */
  deviceScaleFactor: number;
  /** モバイルレイアウト（ビューポートメタタグ・スクロールバー等）を有効にする */
  mobile: boolean;
  /** タッチ入力エミュレーション（navigator.maxTouchPoints > 0）を有効にする */
  touch: boolean;
}

/**
 * 代表的なモバイル条件のプリセット。幅 390 / 高さ 844 は iPhone 12〜14 系の
 * 論理解像度（Issue #253 の再現条件。横持ちの LANDSCAPE_PRESET と同一端末の
 * 縦持ち）、DPR 3 は同系の実ピクセル比。
 */
export const MOBILE_PRESET: EmulationConfig = {
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  mobile: true,
  touch: true,
};

/**
 * スマートフォン横持ち条件のプリセット（Issue #252）。幅 844 / 高さ 390 は
 * iPhone 12〜14 系の横持ち論理解像度。縦持ちの MOBILE_PRESET と同じく
 * DPR 3・mobile・touch を有効にする。
 */
export const LANDSCAPE_PRESET: EmulationConfig = {
  width: 844,
  height: 390,
  deviceScaleFactor: 3,
  mobile: true,
  touch: true,
};

/**
 * 小型スマートフォン縦持ち条件のプリセット（Issue #254 AC2）。幅 320 /
 * 高さ 568 は iPhone SE 初代・iPhone 5s の論理解像度で、サポート対象の
 * 最小級ビューポート。DPR 2 は同系の実ピクセル比。mobile-smoke が
 * 390x844 の計測後に `setEmulation` でこの条件へ切り替え、補助パネル内の
 * タップ領域を最小幅でも実測する。
 */
export const SMALL_MOBILE_PRESET: EmulationConfig = {
  width: 320,
  height: 568,
  deviceScaleFactor: 2,
  mobile: true,
  touch: true,
};

/**
 * デスクトップ高精細（Retina）条件のプリセット（Issue #322）。幅 1600 /
 * 高さ 900 はデスクトップ既定（`buildWindowSizeArg` の DEFAULT_WINDOW_SIZE）と
 * 同じで、違いは DPR 2 のみ。
 *
 * ラベル halo のような「線の太さ」の検証は DPR 1 と DPR 2 で見え方が変わる
 * （DPR 2 では 1 CSS px の halo が 2 デバイス px に描かれ、アンチエイリアス
 * の効き方も変わる）。#322 の受け入れ条件が DPR 1 / DPR 2 の両方を要求する
 * ため、モバイル以外に「デスクトップのまま DPR だけ 2」の条件を用意する。
 * `--device` 指定なので `--force-device-scale-factor=2` が付き（Issue #320）、
 * deck.gl の overlaid canvas も 2 倍解像度になってラベルが描画される。
 */
export const DESKTOP_HIDPI_PRESET: EmulationConfig = {
  width: 1600,
  height: 900,
  deviceScaleFactor: 2,
  mobile: false,
  touch: false,
};

/** `--device=<name>` で指定できるプリセットの一覧。 */
export const DEVICE_PRESETS: Record<string, EmulationConfig> = {
  mobile: MOBILE_PRESET,
  landscape: LANDSCAPE_PRESET,
  "mobile-small": SMALL_MOBILE_PRESET,
  "desktop-hidpi": DESKTOP_HIDPI_PRESET,
};

/** プリセット名から EmulationConfig を解決する。未知の名前は例外を投げる。 */
export function resolveDevicePreset(name: string): EmulationConfig {
  const preset = DEVICE_PRESETS[name];
  if (!preset) {
    throw new Error(
      `unknown device preset "${name}" (available: ${
        Object.keys(DEVICE_PRESETS).join(", ")
      })`,
    );
  }
  return preset;
}

/** デスクトップ既定のウィンドウサイズ（従来の --window-size=1600,900）。 */
const DEFAULT_WINDOW_SIZE = { width: 1600, height: 900 } as const;

/**
 * Chrome 起動引数の --window-size を組み立てる。エミュレーション未指定なら
 * デスクトップ既定（1600x900）のまま変えない（AC #2）。
 */
export function buildWindowSizeArg(emulation?: EmulationConfig): string {
  const { width, height } = emulation ?? DEFAULT_WINDOW_SIZE;
  return `--window-size=${width},${height}`;
}

/**
 * エミュレーション指定時に付ける Chrome 起動引数（Issue #320）。
 *
 * `Emulation.setDeviceMetricsOverride` は `window.devicePixelRatio` と
 * MapLibre 側 canvas は DPR 倍に拡げるが、deck.gl（luma.gl）の overlaid
 * canvas のドローイングバッファは CSS ピクセルのまま据え置かれる。この
 * 不一致下では TextLayer のラベルが 1 つも描画されず、モバイル条件の
 * スクリーンショットがラベル回帰を検出できなくなる（実測と表は
 * label_render.ts の冒頭を参照）。ブラウザ側の実スケールを同じ倍率へ
 * 揃えると不一致が消えてラベルが描画されるため、`--device` 指定時のみ
 * `--force-device-scale-factor=<deviceScaleFactor>` を付ける。
 *
 * エミュレーション未指定（デスクトップ既定）では何も足さない — 従来の
 * `verify:smoke` / `verify:perf` の条件を一切変えないため。
 *
 * 注意: この引数は起動時に固定されるため、実行中に
 * {@linkcode CdpApi.setEmulation} で別 DPR のプリセットへ切り替えた区間では
 * 再び不一致になる（mobile-smoke の 320x568 区間）。その区間の検査は
 * DOM 実測（タップ領域・横スクロール）だけでラベル描画には依存しない。
 */
export function buildDeviceScaleFactorArgs(
  emulation?: EmulationConfig,
): string[] {
  if (!emulation) return [];
  return [`--force-device-scale-factor=${emulation.deviceScaleFactor}`];
}

/** `Emulation.setDeviceMetricsOverride` のパラメータを組み立てる。 */
export function buildDeviceMetricsParams(
  config: EmulationConfig,
): {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
} {
  return {
    width: config.width,
    height: config.height,
    deviceScaleFactor: config.deviceScaleFactor,
    mobile: config.mobile,
  };
}

/** `Emulation.setTouchEmulationEnabled` のパラメータを組み立てる。 */
export function buildTouchEmulationParams(
  config: EmulationConfig,
): { enabled: boolean; maxTouchPoints: number } {
  return { enabled: config.touch, maxTouchPoints: 5 };
}

/** タップ 1 回分の `Input.dispatchTouchEvent` イベント列を組み立てる。 */
export function buildTapEvents(
  x: number,
  y: number,
): Array<{ type: string; touchPoints: Array<{ x: number; y: number }> }> {
  return [
    { type: "touchStart", touchPoints: [{ x, y }] },
    { type: "touchEnd", touchPoints: [] },
  ];
}
