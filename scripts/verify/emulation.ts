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

/** `--device=<name>` で指定できるプリセットの一覧。 */
export const DEVICE_PRESETS: Record<string, EmulationConfig> = {
  mobile: MOBILE_PRESET,
  landscape: LANDSCAPE_PRESET,
  "mobile-small": SMALL_MOBILE_PRESET,
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
