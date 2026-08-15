import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import type { FeatureCollection } from "geojson";
import {
  assignableSlots,
  assignColor,
  assignColorHsl,
  buildColorMap,
  buildColorMapAdditive,
  compositeKey,
  deriveSubjectColor,
  deriveSubjectColorHsl,
  EARTH_DELTA_E_MIN,
  entryForKey,
  fillDeltaEFromEarth,
  fnv1a,
  hslToHex,
  INDEPENDENT_SUBJECT_SUZERAINS,
  LIGHTNESSES,
  loadYearCollections,
  PALETTE_SIZE,
  paletteHslForIndex,
  probeAssignSlots,
  remapLowContrastColors,
  SATURATIONS,
  shiftLightnessForSubject,
  SUBJECT_KEY_SEP,
  SUBJECT_LIGHTNESS_SHIFT,
  type YearCollection,
} from "./build-colors.ts";
import { PARCHMENT_FLAVOR_OVERRIDES } from "../src/parchment_palette.ts";
import colorsJson from "../data/colors.json" with { type: "json" };

/** テスト用に単一 feature（ジオメトリは最小の正方形）を組み立てる */
function feature(properties: Record<string, unknown>) {
  return {
    type: "Feature" as const,
    properties,
    geometry: {
      type: "Polygon" as const,
      coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
    },
  };
}

function collection(
  features: Array<ReturnType<typeof feature>>,
): FeatureCollection {
  return { type: "FeatureCollection", features };
}

/** 2 つの hex 色の単純な RGB ユークリッド距離（0〜441.67） */
function rgbDistance(a: string, b: string): number {
  const parse = (hex: string) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const [r1, g1, b1] = parse(a);
  const [r2, g2, b2] = parse(b);
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

/** hex → HSL（h: 0..360, s/l: 0..1）。色相・明度の比較用 */
function hslFromHex(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h, s, l };
}

Deno.test("fnv1a は決定的で、同一文字列に同一ハッシュを返す", () => {
  assertEquals(fnv1a("France"), fnv1a("France"));
  assertEquals(fnv1a("Holy Roman Empire"), fnv1a("Holy Roman Empire"));
  // 異なる文字列は（実質的に）異なるハッシュ
  assert(fnv1a("France") !== fnv1a("England"));
  // 既知のアンカー値（FNV-1a 32bit offset basis, 空文字列）
  assertEquals(fnv1a(""), 2166136261);
  // 非負整数を返す
  assert(Number.isInteger(fnv1a("x")) && fnv1a("x") >= 0);
});

Deno.test("hslToHex は代表的な HSL を正しい HEX に変換する", () => {
  assertEquals(hslToHex(0, 1, 0.5), "#ff0000");
  assertEquals(hslToHex(120, 1, 0.5), "#00ff00");
  assertEquals(hslToHex(240, 1, 0.5), "#0000ff");
  assertEquals(hslToHex(0, 0, 0), "#000000");
  assertEquals(hslToHex(0, 0, 1), "#ffffff");
  assertEquals(hslToHex(0, 0, 0.5), "#808080");
  // 常に #rrggbb 形式
  assert(/^#[0-9a-f]{6}$/.test(hslToHex(200, 0.6, 0.5)));
});

Deno.test("パレットは 288 色（>= 想定ユニーク NAME 数 272）を持ち、各エントリが一意", () => {
  assertEquals(PALETTE_SIZE, 24 * SATURATIONS.length * LIGHTNESSES.length);
  assert(
    PALETTE_SIZE >= 272,
    `パレット色数 ${PALETTE_SIZE} は 272 以上であること`,
  );

  const seen = new Set<string>();
  for (let i = 0; i < PALETTE_SIZE; i++) {
    const { h, s, l } = paletteHslForIndex(i);
    seen.add(`${h.toFixed(3)}|${s}|${l}`);
  }
  assertEquals(
    seen.size,
    PALETTE_SIZE,
    "パレットの (h,s,l) は全て一意であること",
  );
});

Deno.test("彩度・明度段は褪せた顔料トーン（羊皮紙 UI と同系統・TASK-74）", () => {
  assertEquals(SATURATIONS, [0.2, 0.3, 0.4]);
  // #385 でも変更していない。EARTH_DELTA_E_MIN = 10 ならこの明度段のままで
  // 割当候補が 193/288 残り、同年最大キー数 152 を上回って割当が成立するため
  // （据え置くとパレット格子が不変になり、既存色のパレット逆引きが保たれる）。
  assertEquals(LIGHTNESSES, [0.52, 0.62, 0.72, 0.82]);
});

Deno.test("全パレット色が褪せた顔料の彩度・明度レンジに収まる（TASK-74）", () => {
  for (let i = 0; i < PALETTE_SIZE; i++) {
    const { s, l } = paletteHslForIndex(i);
    assert(s <= 0.4, `index ${i} の彩度 ${s} が高すぎる（褪せトーンでない）`);
    assert(s >= 0.15, `index ${i} の彩度 ${s} が低すぎる（灰色に潰れる）`);
    assert(l >= 0.5 && l <= 0.85, `index ${i} の明度 ${l} がレンジ外`);
  }
});

// ---- #385 AC1 / AC3: 羊皮紙下地に対するコントラスト制約 ----
//
// 「彩度・明度が褪せトーンのレンジに入っている」ことは、下地と判別できることを
// **担保しない**（同じ低彩度でも色相が羊皮紙の黄土帯なら埋もれる）。判別性は
// 実表示色（塗りを FILL_ALPHA で earth に合成した色）と素の earth の ΔE00 で
// 直接測り、閾値未満のスロットを割当候補から機械的に除外することで担保する。

Deno.test("割当候補スロットは全て羊皮紙下地と判別できる（#385 AC1 / AC3）", () => {
  const offenders: string[] = [];
  for (const slot of assignableSlots()) {
    const hsl = paletteHslForIndex(slot);
    const baseHex = hslToHex(hsl.h, hsl.s, hsl.l);
    const sub = shiftLightnessForSubject(hsl);
    const subHex = hslToHex(sub.h, sub.s, sub.l);
    const dBase = fillDeltaEFromEarth(baseHex);
    const dSub = fillDeltaEFromEarth(subHex);
    if (dBase < EARTH_DELTA_E_MIN || dSub < EARTH_DELTA_E_MIN) {
      offenders.push(
        `slot ${slot} ${baseHex} (base ΔE00 ${dBase.toFixed(2)} / ` +
          `subject ${subHex} ΔE00 ${dSub.toFixed(2)})`,
      );
    }
  }
  assertEquals(
    offenders.length,
    0,
    `羊皮紙下地（earth ${PARCHMENT_FLAVOR_OVERRIDES.earth}）と ΔE00 < ` +
      `${EARTH_DELTA_E_MIN} で判別できない割当候補が ${offenders.length} 件:\n` +
      offenders.slice(0, 12).join("\n"),
  );
});

Deno.test("割当候補スロット数が同年最大キー数を上回る（割当不能にならない）", () => {
  const candidates = assignableSlots();
  // 1300 年が実測最大（152 キー）。ADR-0032 で色の一意性は「同年内」に緩和されて
  // いるので、候補数がこれを上回れば同年非衝突の割当は原理的に成立する。
  assert(
    candidates.length > 152,
    `割当候補 ${candidates.length} 件は同年最大キー数 152 を上回らない`,
  );
  // 候補は昇順・重複なし・全て有効スロット
  for (let i = 1; i < candidates.length; i++) {
    assert(candidates[i] > candidates[i - 1], "候補は昇順で重複しない");
  }
  assert(candidates.every((s) => s >= 0 && s < PALETTE_SIZE));
  // 閾値のせいで全滅していない（フィルタが効いてはいるが枯渇していない）
  assert(
    candidates.length < PALETTE_SIZE,
    "制約が 1 スロットも落としていない（フィルタが機能していない）",
  );
});

Deno.test("probeAssignSlots は割当候補スロットしか返さない（#385 AC3）", () => {
  const candidates = new Set(assignableSlots());
  const names = Array.from({ length: 120 }, (_, i) => `Power ${i}`);
  for (const slot of probeAssignSlots(names).values()) {
    assert(candidates.has(slot), `slot ${slot} は割当候補ではない`);
  }
});

Deno.test("buildColorMap の出力色は全て羊皮紙下地と判別できる（#385 AC3）", () => {
  const fc = collection(
    Array.from({ length: 80 }, (_, i) => feature({ NAME: `Power ${i}` }))
      .concat(
        Array.from(
          { length: 40 },
          (_, i) => feature({ NAME: `Vassal ${i}`, SUBJECTO: `Power ${i}` }),
        ),
      ),
  );
  const map = buildColorMap([fc], { renames: {} });
  assert(Object.keys(map).length === 120);
  for (const [key, hex] of Object.entries(map)) {
    const d = fillDeltaEFromEarth(hex);
    assert(
      d >= EARTH_DELTA_E_MIN,
      `${key} (${hex}) の ΔE00 ${d.toFixed(2)} が ${EARTH_DELTA_E_MIN} 未満`,
    );
  }
});

Deno.test("属領は全パレット色で識別可能な明度差を保つ（明度レンジ上げの副作用検証）", () => {
  for (let i = 0; i < PALETTE_SIZE; i++) {
    const base = paletteHslForIndex(i);
    const sub = shiftLightnessForSubject(base);
    assertEquals(sub.h, base.h);
    assertEquals(sub.s, base.s);
    assert(
      Math.abs(sub.l - base.l) >= 0.15,
      `index ${i} の宗主国-属領 明度差 ${
        Math.abs(sub.l - base.l)
      } が小さすぎる`,
    );
    assert(
      sub.l >= 0 && sub.l <= 1,
      `index ${i} の属領明度 ${sub.l} が [0,1] 外`,
    );
    assertNotEquals(
      hslToHex(sub.h, sub.s, sub.l),
      hslToHex(base.h, base.s, base.l),
      `index ${i} の宗主国と属領が同色`,
    );
  }
});

Deno.test("連続インデックスは色相が大きく離れる（隣接色衝突の緩和）", () => {
  // 黄金角配置により、隣接インデックスの色相差は最低でも 60 度以上離れる
  for (let i = 0; i < 24 - 1; i++) {
    const a = paletteHslForIndex(i).h;
    const b = paletteHslForIndex(i + 1).h;
    const diff = Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
    assert(diff >= 60, `index ${i}->${i + 1} の色相差 ${diff} が小さすぎる`);
  }
});

Deno.test("assignColor は決定的（同一 NAME は常に同色）", () => {
  assertEquals(assignColor("France"), assignColor("France"));
  assertEquals(assignColor("Byzantium"), assignColor("Byzantium"));
  assert(/^#[0-9a-f]{6}$/.test(assignColor("France")));
});

Deno.test("probeAssignSlots は決定的で、名前数 <= 割当候補数なら全スロット相異なる", () => {
  // #385: 上限は PALETTE_SIZE ではなく「羊皮紙下地と判別できる割当候補の数」。
  const candidates = assignableSlots();
  const names: string[] = [];
  for (let i = 0; i < candidates.length; i++) names.push(`n-${i}`);
  const a = probeAssignSlots(names);
  const b = probeAssignSlots([...names].reverse());
  // 入力順に依存しない（決定的）
  for (const n of names) assertEquals(a.get(n), b.get(n));
  // 全スロットが相異なる（衝突は線形プロービングで解消）
  assertEquals(new Set([...a.values()]).size, names.length);
  // スロットは候補集合の中（= 範囲内かつ判別可能）
  for (const s of a.values()) assert(candidates.includes(s));
  // 起点は fnv1a の自然位置（衝突が無ければそのまま）
  assert(
    [...a.values()].some((s, i) =>
      s === candidates[fnv1a(`n-${i}`) % candidates.length]
    ),
  );
});

Deno.test("shiftLightnessForSubject は色相・彩度を保ち明度だけをずらす", () => {
  const base = { h: 137.5, s: 0.6, l: 0.4 };
  const sub = shiftLightnessForSubject(base);
  assertEquals(sub.h, base.h);
  assertEquals(sub.s, base.s);
  assertAlmostEquals(sub.l, base.l + SUBJECT_LIGHTNESS_SHIFT, 1e-9);
  // 明るめのベースは暗くなる（[0,1] に収める）
  const bright = shiftLightnessForSubject({ h: 0, s: 0.5, l: 0.82 });
  assertAlmostEquals(bright.l, 0.82 - SUBJECT_LIGHTNESS_SHIFT, 1e-9);
  assert(bright.l >= 0 && bright.l <= 1);
});

Deno.test("deriveSubjectColorHsl は宗主国と同色相・別明度（式の単体確認）", () => {
  const suzerain = assignColorHsl("Castile");
  const derived = deriveSubjectColorHsl("Castile");
  assertAlmostEquals(derived.h, suzerain.h, 1e-9);
  assert(
    Math.abs(derived.l - suzerain.l) >= 0.1,
    `明度差 ${Math.abs(derived.l - suzerain.l)} が小さすぎる`,
  );
  assert(derived.l >= 0 && derived.l <= 1);
  assert(deriveSubjectColor("Castile") !== assignColor("Castile"));
});

Deno.test("compositeKey は属領のみ NAME|SUBJECTO、それ以外は NAME を返す", () => {
  assertEquals(compositeKey("France", null), "France");
  assertEquals(compositeKey("Cyprus", "Cyprus"), "Cyprus");
  assertEquals(compositeKey("France", ""), "France");
  assertEquals(compositeKey("Naples", "Aragon"), "Naples|Aragon");
});

Deno.test("buildColorMap: 独立勢力は NAME キーのみで、互いに相異なる色になる", () => {
  const fc = collection([
    feature({ NAME: "France", SUBJECTO: null }),
    feature({ NAME: "Cyprus", SUBJECTO: "Cyprus" }), // SUBJECTO==NAME は属領扱いしない
  ]);
  const map = buildColorMap([fc], { renames: {} });
  assert(/^#[0-9a-f]{6}$/.test(map["France"]));
  assert("Cyprus" in map && !("Cyprus|Cyprus" in map));
  // 独立勢力同士はプロービングで相異なる色になる
  assert(map["France"] !== map["Cyprus"]);
});

Deno.test("buildColorMap: 属領は複合キーで、宗主国色相から派生する", () => {
  const fc = collection([
    feature({ NAME: "Naples", SUBJECTO: "Aragon" }),
  ]);
  const map = buildColorMap([fc], { renames: {} });
  assertEquals(map["Naples|Aragon"], deriveSubjectColor("Aragon"));
  // 独立勢力としての Naples キーは（この年代のこの feature では）作られない
  assert(!("Naples" in map));
});

Deno.test("buildColorMap: 属領はプロービング後の宗主国と同色相・別明度になる", () => {
  // 独立勢力 Aragon が存在するとき、属領 Naples|Aragon は Aragon の
  // 「実表示色（プロービング後）」の色相を保ち、明度だけずれる。
  const fc = collection([
    feature({ NAME: "Aragon", SUBJECTO: null }),
    feature({ NAME: "Naples", SUBJECTO: "Aragon" }),
  ]);
  const map = buildColorMap([fc], { renames: {} });
  const su = hslFromHex(map["Aragon"]);
  const sub = hslFromHex(map["Naples|Aragon"]);
  // 同色相（hex 量子化の丸め誤差のみ許容）
  const hueDiff = Math.min(
    Math.abs(su.h - sub.h),
    360 - Math.abs(su.h - sub.h),
  );
  assert(hueDiff <= 3, `色相差 ${hueDiff.toFixed(2)} が大きすぎる`);
  // 明度は明確に異なる
  assert(
    Math.abs(su.l - sub.l) >= 0.1,
    `明度差 ${Math.abs(su.l - sub.l).toFixed(3)} が小さすぎる`,
  );
  assert(map["Naples|Aragon"] !== map["Aragon"]);
});

Deno.test("buildColorMap: SUBJECTO は renames で正規化してから宗主国色を引く", () => {
  // 生 SUBJECTO は "Castille"、renames で "Castile" に正規化して色相を引く
  const fc = collection([
    feature({ NAME: "Granada", SUBJECTO: "Castille" }),
  ]);
  const map = buildColorMap([fc], { renames: { "Castille": "Castile" } });
  // キーは生の SUBJECTO（クライアントが持つ値）で作られる
  assertEquals(map["Granada|Castille"], deriveSubjectColor("Castile"));
  // 正規化後の "Castile" の色相に寄っていること
  const suzerain = assignColorHsl("Castile");
  const hex = map["Granada|Castille"];
  // deriveSubjectColor("Castile") と一致 = 同色相
  assertEquals(hex, deriveSubjectColor("Castile"));
  assertAlmostEquals(deriveSubjectColorHsl("Castile").h, suzerain.h, 1e-9);
});

Deno.test("buildColorMap: 正規化後に SUBJECTO==NAME となる自己参照は属領扱いしない", () => {
  // NAME="Castile"（補正済み）に対し生 SUBJECTO は補正前綴り "Castille"。
  // renames で正規化すると宗主国==自分自身 → 明度をずらさずベース色にする。
  // ただしクライアントは生 SUBJECTO から複合キーを引くため、キー自体は残す。
  const fc = collection([
    feature({ NAME: "Castile", SUBJECTO: "Castille" }),
  ]);
  const map = buildColorMap([fc], { renames: { "Castille": "Castile" } });
  assertEquals(map["Castile|Castille"], assignColor("Castile"));
  // 派生（明度違い）ではないこと
  assert(map["Castile|Castille"] !== deriveSubjectColor("Castile"));
});

Deno.test("buildColorMap: NAME が null の feature は載せない", () => {
  const fc = collection([
    feature({ NAME: null, SUBJECTO: "France" }),
    feature({ NAME: "France", SUBJECTO: null }),
  ]);
  const map = buildColorMap([fc], { renames: {} });
  assertEquals(Object.keys(map).length, 1);
  assert("France" in map);
});

Deno.test("buildColorMap: 全年代で同一勢力が同色（複数コレクションで安定）", () => {
  const fc1 = collection([feature({ NAME: "France", SUBJECTO: null })]);
  const fc2 = collection([feature({ NAME: "France", SUBJECTO: null })]);
  const map = buildColorMap([fc1, fc2], { renames: {} });
  assertEquals(map["France"], assignColor("France"));
});

Deno.test("buildColorMap: 上位勢力群の色は十分に分散する（AC#3 パレット緩和）", () => {
  const majors = [
    "France",
    "Holy Roman Empire",
    "Ottoman Empire",
    "England",
    "Castile",
    "Aragon",
    "Poland-Lithuania",
    "Kingdom of Hungary",
    "Papal States",
    "Venice",
  ];
  const fc = collection(
    majors.map((n) => feature({ NAME: n, SUBJECTO: null })),
  );
  const map = buildColorMap([fc], { renames: {} });
  const colors = majors.map((n) => map[n]);
  // 全て相異なる色（プロービングで衝突解消済み）
  assertEquals(new Set(colors).size, majors.length);
  // 隣接し得る主要勢力ペアの平均色差が閾値以上（色相差で判別できること）。
  // TASK-74 で褪せた顔料トーン（低彩度）へ移行したため、RGB 距離の絶対値は
  // 構造的に縮む（旧パレット avg 138 → 新パレット avg 80）。色相分散は黄金角で
  // 維持されているため、閾値は 70 とする。
  let total = 0;
  let count = 0;
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      total += rgbDistance(colors[i], colors[j]);
      count++;
    }
  }
  const avg = total / count;
  assert(avg >= 70, `主要勢力ペアの平均色差 ${avg.toFixed(1)} が小さすぎる`);
});

Deno.test("buildColorMap: 独立勢力は互いに完全に相異なる色になる（名前数 <= 割当候補数）", () => {
  // #385: 上限は PALETTE_SIZE ではなく割当候補数（羊皮紙下地と判別できるスロット）。
  const names: string[] = [];
  for (let i = 0; i < assignableSlots().length; i++) names.push(`faction-${i}`);
  const fc = collection(names.map((n) => feature({ NAME: n, SUBJECTO: null })));
  const map = buildColorMap([fc], { renames: {} });
  const colors = names.map((n) => map[n]);
  // distinct 比率 100%（ハッシュ衝突による同色が起きない）
  assertEquals(new Set(colors).size, names.length);
});

Deno.test("INDEPENDENT_SUBJECT_SUZERAINS: HRE 領邦を独立色にする既定集合を固定する", () => {
  assertEquals([...INDEPENDENT_SUBJECT_SUZERAINS], ["Holy Roman Empire"]);
});

Deno.test("buildColorMap: independentSubjectSuzerains の属領は NAME ベースの独立色になる", () => {
  const fc = collection([
    feature({ NAME: "Austria", SUBJECTO: "Holy Roman Empire" }),
    feature({ NAME: "Bavaria", SUBJECTO: "Holy Roman Empire" }),
  ]);
  const map = buildColorMap(
    [fc],
    { renames: {} },
    new Set(["Holy Roman Empire"]),
  );
  // キーは従来どおり複合キーのまま
  assert("Austria|Holy Roman Empire" in map);
  assert("Bavaria|Holy Roman Empire" in map);
  // 宗主国色の明度シフトではなく、互いに相異なる独立プロービング色になる
  assert(
    map["Austria|Holy Roman Empire"] !== map["Bavaria|Holy Roman Empire"],
  );
  assert(
    map["Austria|Holy Roman Empire"] !==
      deriveSubjectColor("Holy Roman Empire"),
  );
  // 同じ NAME 集合を独立勢力として割り当てた場合と同色（NAME ベースのプロービング）
  const independent = buildColorMap(
    [collection([
      feature({ NAME: "Austria", SUBJECTO: null }),
      feature({ NAME: "Bavaria", SUBJECTO: null }),
    ])],
    { renames: {} },
  );
  assertEquals(map["Austria|Holy Roman Empire"], independent["Austria"]);
  assertEquals(map["Bavaria|Holy Roman Empire"], independent["Bavaria"]);
});

Deno.test("buildColorMap: independentSubjectSuzerains は renames 正規化後の宗主国名で判定する", () => {
  const fc = collection([
    feature({ NAME: "Austria", SUBJECTO: "H.R.E." }),
  ]);
  const map = buildColorMap(
    [fc],
    { renames: { "H.R.E.": "Holy Roman Empire" } },
    new Set(["Holy Roman Empire"]),
  );
  assertEquals(map["Austria|H.R.E."], assignColor("Austria"));
});

Deno.test("buildColorMap: 集合外の宗主国の属領は従来どおり明度シフト派生色のまま", () => {
  const fc = collection([
    feature({ NAME: "Naples", SUBJECTO: "Aragon" }),
  ]);
  const map = buildColorMap(
    [fc],
    { renames: {} },
    new Set(["Holy Roman Empire"]),
  );
  assertEquals(map["Naples|Aragon"], deriveSubjectColor("Aragon"));
});

Deno.test("buildColorMap: 第 3 引数省略時は従来挙動（全属領が派生色）", () => {
  const fc = collection([
    feature({ NAME: "Bohemia", SUBJECTO: "Holy Roman Empire" }),
  ]);
  const map = buildColorMap([fc], { renames: {} });
  assertEquals(
    map["Bohemia|Holy Roman Empire"],
    deriveSubjectColor("Holy Roman Empire"),
  );
});

Deno.test("buildColorMap: suzerains の宗主補正で独立勢力が属領キーになる（TASK-94）", () => {
  // base では独立勢力（SUBJECTO==NAME）の Britany を France の封土として扱う。
  // ランタイムは applySuzerainOverrides で SUBJECTO を補正後の宗主名へ書き換える
  // ため、色キーも補正後の "NAME|宗主" にする（両者が食い違うと色が引けない）。
  const fc = collection([
    feature({ NAME: "France", SUBJECTO: null }),
    feature({ NAME: "Britany", SUBJECTO: "Britany" }),
  ]);
  const map = buildColorMap([fc], {
    renames: {},
    suzerains: { "Britany": "France" },
  });
  assertEquals(map["Britany|France"], deriveSubjectColor("France"));
  assert(!("Britany" in map));
});

Deno.test("buildColorMap: suzerains は生の SUBJECTO より優先する（TASK-94）", () => {
  const fc = collection([
    feature({ NAME: "Britany", SUBJECTO: "Angevin Empire" }),
  ]);
  const map = buildColorMap([fc], {
    renames: {},
    suzerains: { "Britany": "France" },
  });
  assertEquals(map["Britany|France"], deriveSubjectColor("France"));
  assert(!("Britany|Angevin Empire" in map));
});

Deno.test("buildColorMap: suzerains の宗主名も renames で正規化する（TASK-94）", () => {
  const fc = collection([
    feature({ NAME: "Granada", SUBJECTO: "Granada" }),
  ]);
  const map = buildColorMap([fc], {
    renames: { "Castille": "Castile" },
    suzerains: { "Granada": "Castille" },
  });
  assertEquals(map["Granada|Castile"], deriveSubjectColor("Castile"));
});

Deno.test("buildColorMap: suzerains 省略時は従来どおり SUBJECTO だけで判定する", () => {
  const fc = collection([
    feature({ NAME: "Britany", SUBJECTO: "Britany" }),
  ]);
  const map = buildColorMap([fc], { renames: {} });
  assertEquals(map["Britany"], assignColor("Britany"));
});

Deno.test("生成済み colors.json は宗主補正後のキーを持つ（TASK-94 AC #10）", () => {
  // data/name-overrides.json の suzerains（Britany → France）を反映した
  // colors.json が生成されていること。補正前のキーは残らない。
  const colors = colorsJson as Record<string, string>;
  assert("Britany|France" in colors);
  assert(!("Britany" in colors));
});

Deno.test("buildColorMap: feature の順序に依存せず同一結果を返す（決定性）", () => {
  const names: string[] = [];
  for (let i = 0; i < 60; i++) names.push(`p-${i}`);
  const fc1 = collection(
    names.map((n) => feature({ NAME: n, SUBJECTO: null })),
  );
  const fc2 = collection(
    [...names].reverse().map((n) => feature({ NAME: n, SUBJECTO: null })),
  );
  assertEquals(
    buildColorMap([fc1], { renames: {} }),
    buildColorMap([fc2], {
      renames: {},
    }),
  );
});

// ---------------------------------------------------------------------------
// 差分追加モード（Issue #193）: data/colors.json をスナップショット正とし、
// 既存キーの色は変えず、新キーのみ fnv1a 自然スロット + 線形プロービング
// （同年非衝突制約）で追加する。#172 の追加限定方式の正式化。
// ---------------------------------------------------------------------------

/** パレットのスロット番号から HEX を得る（テスト用ヘルパ） */
function paletteHexAt(slot: number): string {
  const { h, s, l } = paletteHslForIndex(slot);
  return hslToHex(h, s, l);
}

/**
 * 割当候補列（assignableSlots）上で自然位置から offset だけ進んだスロット（#385）。
 * プロービングは候補列の上を回るので、テストの期待値も候補列で数える。
 */
function candidateSlotAfter(name: string, offset: number): number {
  const candidates = assignableSlots();
  const natural = fnv1a(name) % candidates.length;
  return candidates[(natural + offset) % candidates.length];
}

/** year 1 件ぶんの YearCollection を組み立てる */
function yearCollection(
  year: number,
  features: Array<ReturnType<typeof feature>>,
): YearCollection {
  return { year, collection: collection(features) };
}

Deno.test("buildColorMapAdditive: 既存キーの色をバイト単位で変えない（スナップショット正）", () => {
  // スナップショットの色は「現行 build ならこうはならない」恣意的な値でも保持される
  const snapshot = {
    "France": "#123456",
    "Naples|Aragon": "#abcdef",
  };
  const ycs = [
    yearCollection(1000, [
      feature({ NAME: "France", SUBJECTO: null }),
      feature({ NAME: "Naples", SUBJECTO: "Aragon" }),
      feature({ NAME: "Newland", SUBJECTO: null }),
    ]),
  ];
  const map = buildColorMapAdditive(snapshot, ycs, { renames: {} });
  assertEquals(map["France"], "#123456");
  assertEquals(map["Naples|Aragon"], "#abcdef");
  // 新キーは追加される
  assert("Newland" in map);
});

Deno.test("buildColorMapAdditive: 新キーは同年衝突がなければ fnv1a 自然スロットの色になる", () => {
  const ycs = [
    yearCollection(1000, [feature({ NAME: "Newland", SUBJECTO: null })]),
  ];
  const map = buildColorMapAdditive({}, ycs, { renames: {} });
  assertEquals(map["Newland"], assignColor("Newland"));
});

Deno.test("buildColorMapAdditive: 同年に同色の既存キーがあれば次スロットへプロービングする", () => {
  const natural = candidateSlotAfter("Newland", 0);
  const snapshot = { "Oldland": paletteHexAt(natural) };
  const ycs = [
    yearCollection(1000, [
      feature({ NAME: "Oldland", SUBJECTO: null }),
      feature({ NAME: "Newland", SUBJECTO: null }),
    ]),
  ];
  const map = buildColorMapAdditive(snapshot, ycs, { renames: {} });
  assertEquals(map["Oldland"], paletteHexAt(natural));
  assertEquals(map["Newland"], paletteHexAt(candidateSlotAfter("Newland", 1)));
});

Deno.test("buildColorMapAdditive: 別年の同色キーはブロックしない（パレット再利用・#172 実測と同型）", () => {
  const natural = candidateSlotAfter("Newland", 0);
  const snapshot = { "Oldland": paletteHexAt(natural) };
  const ycs = [
    yearCollection(1000, [feature({ NAME: "Oldland", SUBJECTO: null })]),
    yearCollection(1100, [feature({ NAME: "Newland", SUBJECTO: null })]),
  ];
  const map = buildColorMapAdditive(snapshot, ycs, { renames: {} });
  // 年代が交差しないので自然スロットの色をそのまま再利用できる
  assertEquals(map["Newland"], paletteHexAt(natural));
  assertEquals(map["Newland"], map["Oldland"]);
});

Deno.test("buildColorMapAdditive: 新キー同士も同年では相異なる色になる", () => {
  // Newland と自然スロットが衝突する別名を決定的に探す
  const candidates = assignableSlots();
  const naturalIdx = fnv1a("Newland") % candidates.length;
  const natural = candidates[naturalIdx];
  let other = "";
  for (let i = 0; i < 100000; i++) {
    const cand = `cand-${i}`;
    if (cand !== "Newland" && fnv1a(cand) % candidates.length === naturalIdx) {
      other = cand;
      break;
    }
  }
  assert(other !== "", "自然スロットが衝突する名前が見つからない");
  const ycs = [
    yearCollection(1000, [
      feature({ NAME: "Newland", SUBJECTO: null }),
      feature({ NAME: other, SUBJECTO: null }),
    ]),
  ];
  const map = buildColorMapAdditive({}, ycs, { renames: {} });
  assert(map["Newland"] !== map[other]);
  // ソート順で先の名前が自然スロットを取り、後の名前が +1 になる
  const first = [other, "Newland"].sort()[0];
  assertEquals(map[first], paletteHexAt(natural));
});

Deno.test("buildColorMapAdditive: 新しい属領キーはスナップショットの宗主色をパレット逆引きして明度シフトする", () => {
  // 宗主のスナップショット色は自然スロットではなく任意のパレットスロット
  // （プロービング後の実表示色）でも、その色から派生する
  const suzerainSlot = 5;
  const snapshot = { "Aragon": paletteHexAt(suzerainSlot) };
  const ycs = [
    yearCollection(1000, [
      feature({ NAME: "Aragon", SUBJECTO: null }),
      feature({ NAME: "Naples", SUBJECTO: "Aragon" }),
    ]),
  ];
  const map = buildColorMapAdditive(snapshot, ycs, { renames: {} });
  const shifted = shiftLightnessForSubject(paletteHslForIndex(suzerainSlot));
  assertEquals(
    map["Naples|Aragon"],
    hslToHex(shifted.h, shifted.s, shifted.l),
  );
});

Deno.test("buildColorMapAdditive: 現行データに無いキー（900 年由来等）は既定で保持する", () => {
  const snapshot = { "Carolingian Empire": "#111111", "France": "#222222" };
  const ycs = [
    yearCollection(1000, [feature({ NAME: "France", SUBJECTO: null })]),
  ];
  const map = buildColorMapAdditive(snapshot, ycs, { renames: {} });
  assertEquals(map["Carolingian Empire"], "#111111");
  assertEquals(map["France"], "#222222");
});

Deno.test("buildColorMapAdditive: prune オプションで現行データに無いキーだけを取り除く", () => {
  const snapshot = { "Carolingian Empire": "#111111", "France": "#222222" };
  const ycs = [
    yearCollection(1000, [feature({ NAME: "France", SUBJECTO: null })]),
  ];
  const map = buildColorMapAdditive(snapshot, ycs, { renames: {} }, new Set(), {
    prune: true,
  });
  assert(!("Carolingian Empire" in map));
  assertEquals(map["France"], "#222222");
});

Deno.test("buildColorMapAdditive: feature / 年の入力順に依存せず同一結果を返す（決定性）", () => {
  const snapshot = { "France": "#123456" };
  const a = [
    yearCollection(1000, [
      feature({ NAME: "France", SUBJECTO: null }),
      feature({ NAME: "Newland", SUBJECTO: null }),
      feature({ NAME: "Otherland", SUBJECTO: null }),
    ]),
    yearCollection(1100, [feature({ NAME: "Thirdland", SUBJECTO: null })]),
  ];
  const b = [
    yearCollection(1100, [feature({ NAME: "Thirdland", SUBJECTO: null })]),
    yearCollection(1000, [
      feature({ NAME: "Otherland", SUBJECTO: null }),
      feature({ NAME: "Newland", SUBJECTO: null }),
      feature({ NAME: "France", SUBJECTO: null }),
    ]),
  ];
  assertEquals(
    buildColorMapAdditive(snapshot, a, { renames: {} }),
    buildColorMapAdditive(snapshot, b, { renames: {} }),
  );
});

Deno.test("buildColorMapAdditive: 実データに対して colors.json を一切変えない（ドリフト検出・#193 AC3）", async () => {
  // 現行の全年代データ + colors.json スナップショットで差分追加を実行しても、
  // 新キーが無い限り出力はスナップショットとバイト単位で一致する。
  // これが崩れたら「build-colors の出力と colors.json が乖離した」ことを意味する。
  // #385: 一回限りの remap（--remap-low-contrast）後のスナップショットに対しても
  // 通常実行が diff ゼロであること = remap が加算モードと整合していること。
  const ycs = await loadYearCollections();
  const overridesRaw = JSON.parse(
    await Deno.readTextFile("data/name-overrides.json"),
  );
  const snapshot = colorsJson as Record<string, string>;
  const map = buildColorMapAdditive(
    snapshot,
    ycs,
    {
      renames: overridesRaw.renames ?? {},
      suzerains: overridesRaw.suzerains ?? {},
    },
    INDEPENDENT_SUBJECT_SUZERAINS,
  );
  assertEquals(map, snapshot);
  // 直列化（キーのソート）まで含めてファイルと一致する = 実行しても diff ゼロ
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(map).sort()) sorted[key] = map[key];
  assertEquals(
    `${JSON.stringify(sorted, null, 2)}\n`,
    await Deno.readTextFile("data/colors.json"),
  );
});

Deno.test("buildColorMapAdditive: 同年で全候補が衝突したら縮退せず例外で落ちる（#385）", () => {
  // 候補スロットが絞られた以上、「同年に同色を出す」縮退は許容できない。
  // ある年で全候補色が既に使われている状態を作り、新キーの追加が失敗することを固定する。
  const candidates = assignableSlots();
  const snapshot: Record<string, string> = {};
  const features = [];
  for (let i = 0; i < candidates.length; i++) {
    const name = `Old-${i}`;
    snapshot[name] = paletteHexAt(candidates[i]);
    features.push(feature({ NAME: name, SUBJECTO: null }));
  }
  features.push(feature({ NAME: "Newland", SUBJECTO: null }));
  const ycs = [yearCollection(1000, features)];
  assertThrows(
    () => buildColorMapAdditive(snapshot, ycs, { renames: {} }),
    Error,
    "Newland: 同年非衝突を満たす割当候補が枯渇した",
  );
});

// ---- #385 AC3 / AC4: 低コントラストキーの一回限りの remap ----

Deno.test("entryForKey は entryForFeature（buildColorMap 経由）と同じ割当情報を復元する", () => {
  // remap は「キー文字列から baseName / subject を復元する」ため、feature から
  // 作る経路と結論が一致していないと親子関係の再導出がずれる。
  const overrides = { renames: { "HRE": "Holy Roman Empire" }, suzerains: {} };
  const cases: Array<[string, string, boolean]> = [
    // [key, 期待 baseName, 期待 subject]
    ["France", "France", false],
    ["Burgundy|France", "France", true],
    // renames で正規化してから宗主色を引く
    ["Duchy of Austria|HRE", "Duchy of Austria", false],
    // INDEPENDENT_SUBJECT_SUZERAINS 配下は NAME ベースの独立色
    ["Duchy of Austria|Holy Roman Empire", "Duchy of Austria", false],
    // 自己参照は属領扱いしない
    ["France|France", "France", false],
  ];
  for (const [key, baseName, subject] of cases) {
    const entry = entryForKey(key, overrides, INDEPENDENT_SUBJECT_SUZERAINS);
    assertEquals(entry.key, key);
    assertEquals(entry.baseName, baseName, `${key} の baseName`);
    assertEquals(entry.subject, subject, `${key} の subject`);
  }
});

Deno.test("remapLowContrastColors: 閾値以上のキーは 1 バイトも変えない（#385 AC4）", () => {
  // "Visible" は閾値以上なので据え置き、"Buried" は下地に埋もれているので再割当て。
  const visible = "#4a6ea6";
  assert(fillDeltaEFromEarth(visible) >= EARTH_DELTA_E_MIN);
  const buried = "#f0e6cd"; // 陸地色そのもの = ΔE00 0
  assert(fillDeltaEFromEarth(buried) < EARTH_DELTA_E_MIN);
  const snapshot = { "Visible": visible, "Buried": buried };
  const ycs = [
    yearCollection(1000, [
      feature({ NAME: "Visible", SUBJECTO: null }),
      feature({ NAME: "Buried", SUBJECTO: null }),
    ]),
  ];
  const map = remapLowContrastColors(snapshot, ycs, { renames: {} });
  assertEquals(Object.keys(map).sort(), ["Buried", "Visible"]);
  assertEquals(map["Visible"], visible, "対象外キーは据え置き");
  assertNotEquals(map["Buried"], buried, "違反キーは再割当てされる");
  assert(fillDeltaEFromEarth(map["Buried"]) >= EARTH_DELTA_E_MIN);
  // 同年に同時表示されるので据え置き色とも衝突しない
  assertNotEquals(map["Buried"], visible);
});

Deno.test("remapLowContrastColors: 宗主が動くと属領も新しい宗主色から再導出する（#385）", () => {
  const snapshot = {
    "Suzerain": "#f0e6cd", // 埋もれている
    "Vassal|Suzerain": "#d8cfb4", // 旧宗主色からの明度シフト（これも埋もれている）
  };
  const ycs = [
    yearCollection(1000, [
      feature({ NAME: "Suzerain", SUBJECTO: null }),
      feature({ NAME: "Vassal", SUBJECTO: "Suzerain" }),
    ]),
  ];
  const map = remapLowContrastColors(snapshot, ycs, { renames: {} });
  const base = hslFromHex(map["Suzerain"]);
  const sub = hslFromHex(map["Vassal|Suzerain"]);
  // 同色相ファミリー（色相・彩度が一致し明度だけずれる）を保つ。
  // 許容 3°: HEX 8bit 量子化の丸めで低彩度色の色相は数度ぶれる。
  assertAlmostEquals(base.h, sub.h, 3.0);
  assertAlmostEquals(base.s, sub.s, 0.02);
  assertAlmostEquals(
    Math.abs(base.l - sub.l),
    SUBJECT_LIGHTNESS_SHIFT,
    0.01,
  );
  for (const hex of Object.values(map)) {
    assert(fillDeltaEFromEarth(hex) >= EARTH_DELTA_E_MIN);
  }
});

Deno.test("remapLowContrastColors: 入力順に依存せず同一結果（決定性）", () => {
  const snapshot = { "A": "#f0e6cd", "B": "#eee4cb", "C": "#4a6ea6" };
  const fa = [feature({ NAME: "A" }), feature({ NAME: "B" })];
  const fb = [feature({ NAME: "B" }), feature({ NAME: "A" })];
  const a = remapLowContrastColors(
    snapshot,
    [yearCollection(1000, fa), yearCollection(1100, [feature({ NAME: "C" })])],
    { renames: {} },
  );
  const b = remapLowContrastColors(
    snapshot,
    [yearCollection(1100, [feature({ NAME: "C" })]), yearCollection(1000, fb)],
    { renames: {} },
  );
  assertEquals(a, b);
});

Deno.test("生成済み colors.json の全色が羊皮紙下地と判別できる（#385 AC3 / AC4）", () => {
  // remap 済みスナップショットに違反キーが 1 件も残っていないことを実データで固定する。
  // パレット側の制約（割当候補フィルタ）とは独立に、成果物そのものを検査する。
  const colors = colorsJson as Record<string, string>;
  const offenders = Object.entries(colors)
    .map(([key, hex]) => [key, hex, fillDeltaEFromEarth(hex)] as const)
    .filter(([, , d]) => d < EARTH_DELTA_E_MIN)
    .sort((a, b) => a[2] - b[2]);
  assertEquals(
    offenders.length,
    0,
    `ΔE00 < ${EARTH_DELTA_E_MIN} のキーが ${offenders.length} 件:\n` +
      offenders.slice(0, 12).map(([k, hex, d]) =>
        `  ${d.toFixed(2)} ${hex} ${k}`
      ).join("\n"),
  );
  // 起票時の最悪例（オスマン帝国）が確実に是正されていること
  const ottoman = colors["Ottoman Empire"];
  assert(ottoman !== undefined, "Ottoman Empire が colors.json に無い");
  assert(
    fillDeltaEFromEarth(ottoman) >= EARTH_DELTA_E_MIN,
    `Ottoman Empire (${ottoman}) の ΔE00 が閾値未満`,
  );
});

Deno.test("remapLowContrastColors: 実データに対して冪等（再実行しても 1 バイトも動かない・#385 AC4）", async () => {
  // remap 済み colors.json にもう一度 remap を掛けても違反キーが無いので何も動かない。
  // = 是正パスが「一回限り」で完了していることの機械的な確認。
  const ycs = await loadYearCollections();
  const overridesRaw = JSON.parse(
    await Deno.readTextFile("data/name-overrides.json"),
  );
  const snapshot = colorsJson as Record<string, string>;
  const map = remapLowContrastColors(
    snapshot,
    ycs,
    {
      renames: overridesRaw.renames ?? {},
      suzerains: overridesRaw.suzerains ?? {},
    },
    INDEPENDENT_SUBJECT_SUZERAINS,
  );
  assertEquals(map, snapshot);
});

Deno.test("生成済み colors.json は属領キーを宗主と同色相ファミリーに保つ（remap 後・#385）", () => {
  // remap はベース勢力名単位で動くため、宗主が動いた属領も新しい宗主色から
  // 再導出されていなければならない。実データで親子関係を固定する。
  const colors = colorsJson as Record<string, string>;
  let checked = 0;
  for (const [key, hex] of Object.entries(colors)) {
    const sep = key.indexOf(SUBJECT_KEY_SEP);
    if (sep < 0) continue;
    const suzerain = key.slice(sep + SUBJECT_KEY_SEP.length);
    // HRE 配下は独立色（TASK-19）なので対象外
    if (INDEPENDENT_SUBJECT_SUZERAINS.has(suzerain)) continue;
    const suzerainHex = colors[suzerain];
    if (suzerainHex === undefined) continue;
    const base = hslFromHex(suzerainHex);
    const sub = hslFromHex(hex);
    // 許容 3°: HEX 8bit 量子化の丸めで低彩度色の色相は数度ぶれる
    // （既存の「属領はプロービング後の宗主国と同色相」テストと同じ許容幅）
    assertAlmostEquals(base.h, sub.h, 3.0, `${key} の色相が宗主とずれている`);
    assertAlmostEquals(
      Math.abs(base.l - sub.l),
      SUBJECT_LIGHTNESS_SHIFT,
      0.01,
      `${key} の明度差が SUBJECT_LIGHTNESS_SHIFT でない`,
    );
    checked++;
  }
  assert(checked > 50, `検査対象の属領キーが少なすぎる（${checked} 件）`);
});

Deno.test("生成済み colors.json は中世 HRE 領邦（TASK-85 由来）に相異なる色を割り当てている（TASK-86 AC #1）", () => {
  // HRE 配下は INDEPENDENT_SUBJECT_SUZERAINS により NAME ベースの独立色になる。
  // 宗主国色の明度シフトだと領邦が全て同色になってしまうため（TASK-19 の方針）、
  // 中世領邦でも同じ扱いになっていることを実データで固定する。
  const colors = colorsJson as Record<string, string>;
  const names = [
    "Duchy of Austria",
    "Electorate of Cologne",
    "Prince-Bishopric of Würzburg",
    "Princely Abbey of Fulda",
    "Burgraviate of Nuremberg",
    "March of Meissen",
    "County of Holland",
    "Duchy of Luxembourg",
  ];
  const assigned = new Map<string, string>();
  for (const name of names) {
    const key = compositeKey(name, "Holy Roman Empire");
    const hex = colors[key];
    assert(hex !== undefined, `${key} の色が colors.json に無い`);
    assert(/^#[0-9a-f]{6}$/.test(hex), `${key} の色が HEX でない: ${hex}`);
    assigned.set(name, hex);
  }
  // 決定的プロービングにより互いに同色にならない
  assertEquals(new Set(assigned.values()).size, assigned.size);
});
