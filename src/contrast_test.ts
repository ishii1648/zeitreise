import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  ciede2000,
  compositeOver,
  contrastRatio,
  deltaE2000,
  type Lab,
  relativeLuminance,
  type Rgb,
  rgbToLab,
  srgbToXyz,
  xyzToLab,
} from "./contrast.ts";

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

Deno.test("relativeLuminance: 白は 1、黒は 0", () => {
  assertAlmostEquals(relativeLuminance(WHITE), 1, 1e-9);
  assertAlmostEquals(relativeLuminance(BLACK), 0, 1e-9);
});

Deno.test("contrastRatio: 白黒は 21:1、同色は 1:1、順序に依存しない", () => {
  assertAlmostEquals(contrastRatio(WHITE, BLACK), 21, 1e-6);
  assertAlmostEquals(contrastRatio(BLACK, WHITE), 21, 1e-6);
  assertAlmostEquals(contrastRatio(WHITE, WHITE), 1, 1e-9);
});

Deno.test("contrastRatio: WCAG の既知の値と一致する（#767676 on white は 4.54）", () => {
  assertAlmostEquals(contrastRatio([118, 118, 118], WHITE), 4.54, 0.01);
});

Deno.test("compositeOver: alpha 255 は前景そのもの、0 は背景そのもの", () => {
  assertEquals(compositeOver([10, 20, 30, 255], WHITE), [10, 20, 30]);
  assertEquals(compositeOver([10, 20, 30, 0], WHITE), [255, 255, 255]);
});

Deno.test("compositeOver: alpha 中間は線形補間になる", () => {
  const mid = compositeOver([0, 0, 0, 128], WHITE);
  const expected = 255 * (1 - 128 / 255);
  for (const ch of mid) assertAlmostEquals(ch, expected, 1e-9);
});

Deno.test("compositeOver: 半透明を重ねるほど前景色へ近づく", () => {
  const bg: Rgb = [240, 230, 205];
  const light = compositeOver([46, 110, 102, 64], bg);
  const heavy = compositeOver([46, 110, 102, 214], bg);
  assert(relativeLuminance(heavy) < relativeLuminance(light));
  assert(relativeLuminance(light) < relativeLuminance(bg));
});

// ---- 知覚色差 CIEDE2000（Issue #385）----
//
// 変換の各段（sRGB → XYZ → Lab → ΔE00）を個別に既知の参照値で固定する。
// 段ごとに検査するのは、合成結果だけを見ると行列・白色点・非線形項の
// どこがずれたのか切り分けられないため。

Deno.test("srgbToXyz: sRGB 原色・白の XYZ（D65）が IEC 61966-2-1 の値と一致する", () => {
  // 白は D65 白色点そのもの
  const white = srgbToXyz([255, 255, 255]);
  assertAlmostEquals(white[0], 0.95047, 1e-4);
  assertAlmostEquals(white[1], 1.0, 1e-6);
  assertAlmostEquals(white[2], 1.08883, 1e-4);
  // 黒は原点
  assertEquals(srgbToXyz([0, 0, 0]), [0, 0, 0]);
  // 赤原色は変換行列の第 1 列
  const red = srgbToXyz([255, 0, 0]);
  assertAlmostEquals(red[0], 0.4124564, 1e-6);
  assertAlmostEquals(red[1], 0.2126729, 1e-6);
  assertAlmostEquals(red[2], 0.0193339, 1e-6);
  // Y は WCAG の相対輝度とほぼ一致する（同じ逆ガンマ・同じ意味の係数）。
  // 完全一致しないのは WCAG が係数を 4 桁（0.2126 / 0.7152 / 0.0722）に
  // 丸めているため。判定に効かない差なので係数はそれぞれの規格の値を使う。
  assertAlmostEquals(
    srgbToXyz([46, 110, 102])[1],
    relativeLuminance([46, 110, 102]),
    1e-4,
  );
});

Deno.test("xyzToLab: 白は L*=100、白色点以下では線形分岐に入る", () => {
  const white = xyzToLab([0.95047, 1.0, 1.08883]);
  assertAlmostEquals(white[0], 100, 1e-9);
  assertAlmostEquals(white[1], 0, 1e-9);
  assertAlmostEquals(white[2], 0, 1e-9);
  // 黒（線形分岐 t <= (6/29)^3）
  const black = xyzToLab([0, 0, 0]);
  assertAlmostEquals(black[0], 0, 1e-9);
  assertAlmostEquals(black[1], 0, 1e-9);
  assertAlmostEquals(black[2], 0, 1e-9);
  // Y/Yn = (6/29)^3 ちょうどで L* = 8（分岐点の連続性）
  const epsilon = (6 / 29) ** 3;
  assertAlmostEquals(xyzToLab([0, epsilon, 0])[0], 8, 1e-9);
});

Deno.test("rgbToLab: sRGB 原色の既知 Lab 値と一致する", () => {
  const cases: Array<[Rgb, Lab]> = [
    [[255, 255, 255], [100, 0, 0]],
    [[0, 0, 0], [0, 0, 0]],
    [[255, 0, 0], [53.2408, 80.0925, 67.2032]],
    [[0, 255, 0], [87.7347, -86.1827, 83.1793]],
    [[0, 0, 255], [32.2970, 79.1875, -107.8602]],
    // 50% グレー（sRGB 128）。L* ≈ 53.585
    [[128, 128, 128], [53.5850, 0, 0]],
  ];
  for (const [rgb, expected] of cases) {
    const lab = rgbToLab(rgb);
    for (let i = 0; i < 3; i++) {
      assertAlmostEquals(
        lab[i],
        expected[i],
        0.01,
        `rgb ${rgb} の Lab[${i}]: ${lab[i]} != ${expected[i]}`,
      );
    }
  }
});

Deno.test("ciede2000: Sharma らの検証データセットの参照値と一致する", () => {
  // G. Sharma, W. Wu, E. N. Dalal (2005) "The CIEDE2000 color-difference
  // formula: Implementation notes, supplementary test data, and mathematical
  // observations", Color Research & Application 30(1), Table 1。
  // 実装が落としやすい分岐（色相の折り返し・a*=b*=0・R_T の効く青紫域・
  // 明度差のみ）を含む代表 12 ケースを採る。
  const cases: Array<[Lab, Lab, number]> = [
    [[50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485], 2.0425],
    [[50.0, 3.1571, -77.2803], [50.0, 0.0, -82.7485], 2.8615],
    [[50.0, 2.8361, -74.0200], [50.0, 0.0, -82.7485], 3.4412],
    [[50.0, -1.3802, -84.2814], [50.0, 0.0, -82.7485], 1.0000],
    [[50.0, 0.0, 0.0], [50.0, -1.0, 2.0], 2.3669],
    [[50.0, 2.4900, -0.0010], [50.0, -2.4900, 0.0009], 7.1792],
    [[50.0, 2.4900, -0.0010], [50.0, -2.4900, 0.0011], 7.2195],
    [[50.0, 2.5000, 0.0], [50.0, 0.0, -2.5000], 4.3065],
    [[50.0, 2.5000, 0.0], [73.0, 25.0, -18.0], 27.1492],
    [[50.0, 2.5000, 0.0], [56.0, -27.0, -3.0], 31.9030],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[90.8027, -2.0831, 1.4410], [91.1528, -1.6435, 0.0447], 1.4441],
  ];
  for (const [lab1, lab2, expected] of cases) {
    assertAlmostEquals(
      ciede2000(lab1, lab2),
      expected,
      0.0001,
      `ΔE00(${lab1}, ${lab2}) != ${expected}`,
    );
  }
});

Deno.test("ciede2000: 同色は 0、順序を入れ替えても同じ値（対称性）", () => {
  const a: Lab = [50, 2.5, 0];
  const b: Lab = [73, 25, -18];
  assertAlmostEquals(ciede2000(a, a), 0, 1e-12);
  assertAlmostEquals(ciede2000(a, b), ciede2000(b, a), 1e-12);
});

Deno.test("deltaE2000: sRGB 入力で Lab 経由と一致し、白黒は 100 になる", () => {
  // 白黒は L* が 0 と 100 で彩度差ゼロなので ΔE00 = 100（変換行列の丸め分だけずれる）
  assertAlmostEquals(deltaE2000(WHITE, BLACK), 100, 1e-4);
  assertAlmostEquals(deltaE2000(WHITE, WHITE), 0, 1e-12);
  const a: Rgb = [205, 200, 162];
  const b: Rgb = [240, 230, 205];
  assertAlmostEquals(deltaE2000(a, b), ciede2000(rgbToLab(a), rgbToLab(b)), 0);
});
