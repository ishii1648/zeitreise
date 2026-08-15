/**
 * 配色のコントラスト評価に使う色計算（TASK-93）。DOM・deck.gl 非依存の純粋関数。
 *
 * ラベルの判読性は「文字色」と「その文字が載る面の色」の相対輝度比で決まる。
 * 地図の面は半透明の塗り（勢力塗り・アクティブ塗り）が羊皮紙の下地に重なった
 * 合成結果なので、compositeOver で合成してから contrastRatio を取る。
 *
 * 計算式は WCAG 2.1 の relative luminance / contrast ratio に従う。
 *
 * Issue #385 で「面の色どうしが判別できるか」を測る知覚色差（CIEDE2000）を
 * 追加した。輝度比（contrastRatio）は文字と背景の判読性の指標であって、
 * 同程度の明るさで色相だけが違う 2 面の判別には使えない（比が 1 に近くても
 * 人には別色に見える／その逆もある）ため、別の尺度が要る。
 */

/** 不透明色の [r,g,b]（各 0..255） */
export type Rgb = readonly [number, number, number];

/** 半透明色の [r,g,b,a]（各 0..255） */
export type Rgba = readonly [number, number, number, number];

/** sRGB の 1 チャンネル（0..255）を線形 RGB（0..1）へ（WCAG 2.1） */
export function srgbChannelToLinear(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** 相対輝度（0..1）。WCAG 2.1 の定義 */
export function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb;
  return 0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b);
}

/**
 * 2 色のコントラスト比（1..21）。順序に依存しない（明るい方が分子）。
 * WCAG の基準値: 通常テキスト 4.5:1 / 大きめテキスト 3:1。
 */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 半透明色 fg を不透明な背景 bg の上に載せた合成色（source-over、非乗算）。
 * 端数は丸めない（丸め位置の違いで基準判定が揺れないようにするため）。
 */
export function compositeOver(fg: Rgba, bg: Rgb): Rgb {
  const alpha = fg[3] / 255;
  return [
    fg[0] * alpha + bg[0] * (1 - alpha),
    fg[1] * alpha + bg[1] * (1 - alpha),
    fg[2] * alpha + bg[2] * (1 - alpha),
  ];
}

// ---- 知覚色差（CIEDE2000）。Issue #385 ----

/** CIE XYZ（D65・Y を 0..1 に正規化） */
export type Xyz = readonly [number, number, number];

/** CIE L*a*b*（L: 0..100、a/b はおよそ -128..127） */
export type Lab = readonly [number, number, number];

/**
 * D65 標準光源の白色点（2°観測者）。CIE 15:2004 の丸め値。
 * Y = 1 に正規化しているため XYZ の Y は相対輝度と一致する。
 */
const D65_WHITE: Xyz = [0.95047, 1.0, 1.08883];

/**
 * sRGB（0..255）→ CIE XYZ（D65）。IEC 61966-2-1 の変換行列。
 * 逆ガンマは srgbChannelToLinear（WCAG と同一の式）を共有する。
 */
export function srgbToXyz(rgb: Rgb): Xyz {
  const r = srgbChannelToLinear(rgb[0]);
  const g = srgbChannelToLinear(rgb[1]);
  const b = srgbChannelToLinear(rgb[2]);
  return [
    0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    0.2126729 * r + 0.7151522 * g + 0.0721750 * b,
    0.0193339 * r + 0.1191920 * g + 0.9503041 * b,
  ];
}

/** Lab 変換の非線形関数 f(t)（CIE 15:2004） */
function labF(t: number): number {
  // (6/29)^3。これ以下は立方根の傾きが発散するので線形に接続する
  const epsilon = 216 / 24389;
  // (29/3)^3
  const kappa = 24389 / 27;
  return t > epsilon ? Math.cbrt(t) : (kappa * t + 16) / 116;
}

/** CIE XYZ（D65）→ CIE L*a*b* */
export function xyzToLab(xyz: Xyz): Lab {
  const fx = labF(xyz[0] / D65_WHITE[0]);
  const fy = labF(xyz[1] / D65_WHITE[1]);
  const fz = labF(xyz[2] / D65_WHITE[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** sRGB（0..255、端数可）→ CIE L*a*b*（D65） */
export function rgbToLab(rgb: Rgb): Lab {
  return xyzToLab(srgbToXyz(rgb));
}

const DEG = Math.PI / 180;

/** 度を受け取る cos / sin（CIEDE2000 の式は角度が度で書かれている） */
function cosDeg(deg: number): number {
  return Math.cos(deg * DEG);
}
function sinDeg(deg: number): number {
  return Math.sin(deg * DEG);
}

/** atan2 を [0,360) の度に正規化する。a=b=0 は 0 とする（CIEDE2000 の規約） */
function hueDeg(b: number, a: number): number {
  if (a === 0 && b === 0) return 0;
  const deg = Math.atan2(b, a) / DEG;
  return deg < 0 ? deg + 360 : deg;
}

/**
 * CIEDE2000 色差 ΔE00（Sharma, Wu & Dalal 2005 の定式化。kL=kC=kH=1）。
 *
 * CIE76（Lab のユークリッド距離）ではなく CIEDE2000 を使う理由（#385）:
 * 本アプリの判定対象は羊皮紙の陸地 #f0e6cd とその上に載る低彩度・高明度の
 * 黄土色帯であり、CIE76 が最も知覚と乖離する領域そのもの（低彩度域で距離を
 * 過小評価し、明度差を過大評価する）。CIEDE2000 は彩度・色相・明度それぞれに
 * 補正項（S_L / S_C / S_H）と青紫域の回転項（R_T）を持ち、この帯での順位付けが
 * 目視と一致する。
 */
export function ciede2000(lab1: Lab, lab2: Lab): number {
  const [l1, a1, b1] = lab1;
  const [l2, a2, b2] = lab2;

  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cBar = (c1 + c2) / 2;
  const cBar7 = cBar ** 7;
  // 低彩度域で a* を持ち上げる補正（灰色近傍の色相を安定させる）
  const g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + 25 ** 7)));

  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const h1p = hueDeg(b1, a1p);
  const h2p = hueDeg(b2, a2p);

  const dLp = l2 - l1;
  const dCp = c2p - c1p;

  let dhp = 0;
  if (c1p * c2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * sinDeg(dhp / 2);

  const lBarp = (l1 + l2) / 2;
  const cBarp = (c1p + c2p) / 2;

  let hBarp: number;
  if (c1p * c2p === 0) {
    hBarp = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    hBarp = (h1p + h2p) / 2;
  } else if (h1p + h2p < 360) {
    hBarp = (h1p + h2p + 360) / 2;
  } else {
    hBarp = (h1p + h2p - 360) / 2;
  }

  const t = 1 -
    0.17 * cosDeg(hBarp - 30) +
    0.24 * cosDeg(2 * hBarp) +
    0.32 * cosDeg(3 * hBarp + 6) -
    0.20 * cosDeg(4 * hBarp - 63);

  const dTheta = 30 * Math.exp(-(((hBarp - 275) / 25) ** 2));
  const cBarp7 = cBarp ** 7;
  const rC = 2 * Math.sqrt(cBarp7 / (cBarp7 + 25 ** 7));
  const sL = 1 +
    (0.015 * (lBarp - 50) ** 2) / Math.sqrt(20 + (lBarp - 50) ** 2);
  const sC = 1 + 0.045 * cBarp;
  const sH = 1 + 0.015 * cBarp * t;
  const rT = -sinDeg(2 * dTheta) * rC;

  const termL = dLp / sL;
  const termC = dCp / sC;
  const termH = dHp / sH;
  return Math.sqrt(
    termL ** 2 + termC ** 2 + termH ** 2 + rT * termC * termH,
  );
}

/** sRGB 2 色の CIEDE2000 色差（ΔE00）。sRGB → XYZ(D65) → Lab → ΔE00 */
export function deltaE2000(a: Rgb, b: Rgb): number {
  return ciede2000(rgbToLab(a), rgbToLab(b));
}
