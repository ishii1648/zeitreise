/**
 * ラベル判読性のコントラスト基準（TASK-93、#267 で政治ラベルを明色文字 +
 * 濃焦茶 halo へ変更）。
 *
 * #267 以降、政治勢力ラベルの判読は「文字色 vs 濃焦茶 halo」のコントラスト
 * だけで担保する（案A。文字が載る面の明暗に依存しない）。そのため政治
 * ラベルの基準は文字 vs halo、halo 自体の視認は halo vs 背景（アクティブ塗り
 * 合成色・羊皮紙下地）で測る。色を切り替えない注記（都市名・河川名）は
 * 従来どおりアクティブ塗りの合成背景（compositeOver）に対して測る。
 */

import { assert, assertEquals } from "@std/assert";
import { compositeOver, contrastRatio, type Rgb } from "./contrast.ts";
import {
  ACTIVE_POLITICAL_LABEL_COLOR,
  ACTIVE_RIVER_LABEL_COLOR,
  ACTIVE_TOP_POLITICAL_LABEL_COLOR,
  buildLabelData,
  CITY_LABEL_COLOR,
  LABEL_OUTLINE_COLOR,
  MIN_ACTIVE_LABEL_CONTRAST,
  MIN_HALO_LABEL_CONTRAST,
  MIN_HIGHLIGHT_VISIBILITY_CONTRAST,
  MIN_SECONDARY_LABEL_CONTRAST,
  POLITICAL_LABEL_COLOR,
  POLITICAL_LABEL_HALO_COLOR,
  politicalLabelColor,
  RIVER_LABEL_COLOR,
  TOP_POLITICAL_LABEL_COLOR,
  TOP_POLITICAL_LABEL_HALO_COLOR,
} from "./labels.ts";
import {
  ACTIVE_FILL_COLOR,
  createPowerHighlightStore,
  powerLabelColor,
} from "./power_highlight.ts";
import { memoizeLatest } from "./memo.ts";
import type { FeatureCollection } from "geojson";
import { PARCHMENT_FLAVOR_OVERRIDES } from "./basemap.ts";
import { hexToRgb } from "./powers.ts";

/** 地図の下地（羊皮紙の陸地色）。basemap.ts の定義から引く（値の二重管理を避ける） */
const EARTH: Rgb = hexToRgb(PARCHMENT_FLAVOR_OVERRIDES.earth)!;

/** アクティブ塗りを下地に合成した、強調中のラベルの実背景色 */
const ACTIVE_BG: Rgb = compositeOver(ACTIVE_FILL_COLOR, EARTH);

/** RGB から 3 チャンネルだけ取り出す（LabelColor は RGBA） */
function rgb(color: readonly number[]): Rgb {
  return [color[0], color[1], color[2]];
}

// ---- #267 AC5: 政治ラベル = 明色文字 + 濃焦茶 halo の判読基準 ----

Deno.test("政治ラベルの通常文字色は濃焦茶 halo と十分なコントラストを保つ（#267 AC5）", () => {
  const ratio = contrastRatio(
    rgb(POLITICAL_LABEL_COLOR),
    rgb(POLITICAL_LABEL_HALO_COLOR),
  );
  assert(
    ratio >= MIN_HALO_LABEL_CONTRAST,
    `halo とのコントラストが不足: ${ratio.toFixed(2)}:1`,
  );
});

Deno.test("強調中の政治ラベルも halo に対して基準コントラストを満たす（#267 AC5）", () => {
  const ratio = contrastRatio(
    rgb(ACTIVE_POLITICAL_LABEL_COLOR),
    rgb(POLITICAL_LABEL_HALO_COLOR),
  );
  // 強調中こそ読ませたい場面なので、通常表示の halo 基準（7:1）と
  // 強調基準（4.5:1）の両方を要求する
  assert(ratio >= MIN_HALO_LABEL_CONTRAST, `${ratio.toFixed(2)}:1`);
  assert(ratio >= MIN_ACTIVE_LABEL_CONTRAST, `${ratio.toFixed(2)}:1`);
  // 強調（純白）は通常（クリーム）以上のコントラスト = 強調で読みやすさが
  // 落ちない
  assert(
    ratio >= contrastRatio(
      rgb(POLITICAL_LABEL_COLOR),
      rgb(POLITICAL_LABEL_HALO_COLOR),
    ),
  );
});

Deno.test("#434: top の通常・強調は濃色文字 + 明色 halo で判読できる", () => {
  const normal = contrastRatio(
    rgb(TOP_POLITICAL_LABEL_COLOR),
    rgb(TOP_POLITICAL_LABEL_HALO_COLOR),
  );
  const active = contrastRatio(
    rgb(ACTIVE_TOP_POLITICAL_LABEL_COLOR),
    rgb(TOP_POLITICAL_LABEL_HALO_COLOR),
  );
  assert(normal >= MIN_HALO_LABEL_CONTRAST, `${normal.toFixed(2)}:1`);
  assert(active >= MIN_HALO_LABEL_CONTRAST, `${active.toFixed(2)}:1`);
  const stateDifference = contrastRatio(
    rgb(TOP_POLITICAL_LABEL_COLOR),
    rgb(ACTIVE_TOP_POLITICAL_LABEL_COLOR),
  );
  assert(
    stateDifference >= 1.5,
    `通常と強調の明度差が不足: ${stateDifference.toFixed(2)}:1`,
  );
});

Deno.test("#434 AC1: top の旧「金茶文字 + 濃焦茶 halo」配色を検出する", () => {
  assertEquals(TOP_POLITICAL_LABEL_COLOR, [43, 33, 24, 255]);
  assertEquals(TOP_POLITICAL_LABEL_HALO_COLOR, [255, 248, 232, 255]);
});

Deno.test("濃焦茶 halo は羊皮紙下地・アクティブ塗りのどちらの上でも識別できる（#267 AC5）", () => {
  // 判読の担保が halo に一本化されたため、halo 自体が背景（明るい下地・
  // 強調中の緑青塗り）から浮き出て見えることが前提条件になる
  for (
    const [label, bg] of [
      ["羊皮紙下地", EARTH],
      ["アクティブ塗り合成色", ACTIVE_BG],
    ] as const
  ) {
    const ratio = contrastRatio(rgb(POLITICAL_LABEL_HALO_COLOR), bg);
    assert(
      ratio >= MIN_SECONDARY_LABEL_CONTRAST,
      `${label} 上で halo が沈む: ${ratio.toFixed(2)}:1`,
    );
  }
});

Deno.test("政治ラベルの文字色はクリーム halo（注記用）とは十分に近く、取り違えない構成である", () => {
  // 明色文字（クリーム #f8f2e2）は共通クリーム halo（#f4ecd7）と近い明度帯に
  // ある = 旧構成（暗色文字 + クリーム halo）のままだったら halo に文字が
  // 同化して読めない。#267 の構成では halo 側を濃焦茶に反転しているため
  // 成立する、という前提を固定する（halo を共通クリームへ戻す退行の検知）。
  const vsCream = contrastRatio(
    rgb(POLITICAL_LABEL_COLOR),
    rgb(LABEL_OUTLINE_COLOR),
  );
  assert(
    vsCream < MIN_HALO_LABEL_CONTRAST,
    `明色文字がクリーム halo とも両立してしまっている: ${vsCream.toFixed(2)}:1`,
  );
});

// ---- 対象外ラベル（都市名・河川名）の扱い（従来どおり）----

Deno.test("都市名ラベルは色を切り替えないが副基準（大きめ文字相当）は満たす", () => {
  const ratio = contrastRatio(rgb(CITY_LABEL_COLOR), ACTIVE_BG);
  assert(
    ratio >= MIN_SECONDARY_LABEL_CONTRAST,
    `都市名のコントラストが副基準未満: ${ratio.toFixed(2)}:1`,
  );
});

Deno.test("TASK-123: 河川名の常時表示色はクリーム halo と十分なコントラストを保つ", () => {
  // 注記（河川・都市・山岳）は従来どおり暗色文字 + クリーム halo の構成。
  // 常時表示の判読基準（7:1）を維持する。
  const ratio = contrastRatio(rgb(RIVER_LABEL_COLOR), rgb(LABEL_OUTLINE_COLOR));
  assert(
    ratio >= MIN_HALO_LABEL_CONTRAST,
    `halo とのコントラストが不足: ${ratio.toFixed(2)}:1`,
  );
});

Deno.test("河川名の強調色はアクティブ塗り上で修正前（TASK-93 以前の塗り）より悪化しない", () => {
  // TASK-93 修正前のアクティブ塗り（回帰の before 値として固定）
  const LEGACY_ACTIVE_FILL = [46, 110, 102, 214] as const;
  const legacyBg = compositeOver(LEGACY_ACTIVE_FILL, EARTH);
  const before = contrastRatio(rgb(ACTIVE_RIVER_LABEL_COLOR), legacyBg);
  const after = contrastRatio(rgb(ACTIVE_RIVER_LABEL_COLOR), ACTIVE_BG);
  assert(after > before, `河川名が悪化した: ${before} -> ${after}`);
});

// ---- AC #5: 強調そのものの見え方を壊さない ----

Deno.test("アクティブ塗りは羊皮紙の下地と十分な差を保つ（強調が見えること）", () => {
  const ratio = contrastRatio(ACTIVE_BG, EARTH);
  assert(
    ratio >= MIN_HIGHLIGHT_VISIBILITY_CONTRAST,
    `アクティブ塗りが下地に埋もれる: ${ratio.toFixed(2)}:1`,
  );
});

// ---- 強調状態に応じた色の切替と復帰（TASK-93 の維持、#267 の色） ----

Deno.test("politicalLabelColor: active=true で純白、false/省略で明色クリーム", () => {
  assertEquals(politicalLabelColor(true), ACTIVE_POLITICAL_LABEL_COLOR);
  assertEquals(politicalLabelColor(false), POLITICAL_LABEL_COLOR);
  assertEquals(politicalLabelColor(), POLITICAL_LABEL_COLOR);
});

Deno.test("powerLabelColor: ホバー中の勢力キーを持つラベルだけが強調色になる", () => {
  const france = { kind: "base" as const, key: "France" };
  const normandy = { kind: "fief" as const, key: "Normandy" };
  assertEquals(
    powerLabelColor(france, null, "France"),
    ACTIVE_TOP_POLITICAL_LABEL_COLOR,
  );
  assertEquals(
    powerLabelColor(normandy, null, "France"),
    POLITICAL_LABEL_COLOR,
  );
});

Deno.test("powerLabelColor: クリック選択でも同じ強調色になる（TASK-93 AC #3）", () => {
  const bavaria = { kind: "hre" as const, key: "Bavaria|Holy Roman Empire" };
  assertEquals(
    powerLabelColor(bavaria, "Bavaria|Holy Roman Empire", null),
    ACTIVE_POLITICAL_LABEL_COLOR,
  );
});

Deno.test("powerLabelColor: 強調解除で通常のラベル色へ戻る（TASK-93 AC #4）", () => {
  const france = { kind: "base" as const, key: "France" };
  assertEquals(
    powerLabelColor(france, "France", "France"),
    ACTIVE_TOP_POLITICAL_LABEL_COLOR,
  );
  assertEquals(powerLabelColor(france, null, null), TOP_POLITICAL_LABEL_COLOR);
});

// ---- 強調の変化でラベルデータを作り直さない（TASK-93 AC #6 の維持） ----

Deno.test("強調キーはラベルデータ生成時に確定し、強調状態でメモ化が壊れない", () => {
  // main.ts の memoizedPowerLabelData と同じ構図: buildLabelData の引数に
  // 強調状態は入らないため、ホバーが動いても同じ参照が返り polylabel は
  // 再実行されない。色の切替は accessor（powerLabelColor）側だけで起きる。
  let builds = 0;
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { NAME: "France" },
      geometry: {
        type: "Polygon",
        coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
      },
    }],
  };
  const build = memoizeLatest((fc: FeatureCollection) => {
    builds++;
    return buildLabelData(fc, {}, "base");
  });

  const store = createPowerHighlightStore(() => {
    // renderLayers 相当。強調が変わるたびに呼ばれる
    build(fc);
  });
  const first = build(fc);
  assertEquals(builds, 1);

  store.hover("France");
  store.hover("Normandy");
  store.click("Normandy");
  store.clear();
  assertEquals(builds, 1, "強調の変化でラベルデータを作り直してはいけない");
  assertEquals(build(fc), first);
  // 強調状態に依らず色だけが切り替わること
  assertEquals(
    powerLabelColor(first[0], null, "France"),
    ACTIVE_TOP_POLITICAL_LABEL_COLOR,
  );
  assertEquals(
    powerLabelColor(first[0], null, null),
    TOP_POLITICAL_LABEL_COLOR,
  );
});

Deno.test("powerLabelColor: key を持たないラベル（河川・都市）は常に通常色", () => {
  assertEquals(
    powerLabelColor({ kind: "base" }, "France", "France"),
    TOP_POLITICAL_LABEL_COLOR,
  );
});
