/**
 * Issue #256: Safe Area inset 対応の CSS 構造テスト。
 *
 * ヘッドレス検証（scripts/verify/）では env(safe-area-inset-*) が常に 0 の
 * ため、実挙動の網羅はできない。その代わり本テストで app.css の構造を固定する:
 *
 * 1. inset は :root の CSS カスタムプロパティ（--safe-area-bottom/left/right）
 *    として一元定義する。検証ハーネスがこの変数を上書きすることで inset を
 *    エミュレーションできる（AC3 の前提）。
 * 2. env(safe-area-inset-*) の直接参照は変数定義の 3 箇所に限る。消費側が
 *    env() を直接書くと変数上書きによるエミュレーションが効かなくなるため。
 * 3. 小画面ブレークポイント内の下端・左右端 UI（タイムラインバー・
 *    MapLibre attribution）が対応する軸の変数を参照する（AC1/AC2）。#328 で
 *    左上のⓘ⚠トグル行とポップオーバーは撤去し、出典表示は MapLibre の
 *    attribution へ統合した。
 * 4. index.html の viewport が viewport-fit=cover を維持する（#284。これが
 *    無いと iOS で env(safe-area-inset-*) が常に 0 になる）。
 */
import { assert, assertEquals, assertMatch } from "@std/assert";

const css = Deno.readTextFileSync("app.css");

/** 小画面ブレークポイントの @media ブロック本体を取り出す（brace 対応）。 */
function smallScreenMediaBlock(source: string): string {
  const start = source.indexOf("@media (max-width: 480px)");
  assert(start >= 0, "小画面ブレークポイントの @media が見つからない");
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error("@media ブロックが閉じていない");
}

/** ブロック内から `selector { ... }` の宣言部を取り出す（フラット前提）。 */
function ruleBlock(block: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`);
  const m = block.match(re);
  assert(m !== null, `セレクタ ${selector} の規則が見つからない`);
  return m[1];
}

const media = smallScreenMediaBlock(css);

Deno.test(":root が Safe Area inset を CSS 変数として一元定義する", () => {
  assertMatch(
    css,
    /--safe-area-bottom:\s*env\(safe-area-inset-bottom,\s*0px\)/,
  );
  assertMatch(css, /--safe-area-left:\s*env\(safe-area-inset-left,\s*0px\)/);
  assertMatch(css, /--safe-area-right:\s*env\(safe-area-inset-right,\s*0px\)/);
});

Deno.test("env(safe-area-inset-*) の直接参照は変数定義の 3 箇所に限る", () => {
  const refs = css.match(/env\(safe-area-inset-/g) ?? [];
  assertEquals(
    refs.length,
    3,
    "消費側は var(--safe-area-*) を使うこと（変数上書きによる" +
      "エミュレーションが効かなくなる）",
  );
});

Deno.test("小画面のタイムラインバーは bottom/left/right の inset に追従する", () => {
  const rule = ruleBlock(media, ".timeline");
  assert(rule.includes("var(--safe-area-bottom)"), "bottom inset 参照が無い");
  assert(rule.includes("var(--safe-area-left)"), "left inset 参照が無い");
  assert(rule.includes("var(--safe-area-right)"), "right inset 参照が無い");
});

Deno.test("小画面の MapLibre attribution は bottom/right の inset に追従する", () => {
  const rule = ruleBlock(media, ".maplibregl-ctrl-bottom-right");
  assert(rule.includes("var(--safe-area-bottom)"), "bottom inset 参照が無い");
  assert(rule.includes("var(--safe-area-right)"), "right inset 参照が無い");
});

Deno.test("小画面の展開したアトリビューションは高さ上限に bottom inset を織り込む（#328）", () => {
  const rule = ruleBlock(media, ".maplibregl-ctrl-attrib-inner");
  assert(
    rule.includes("var(--safe-area-bottom)"),
    "本文の高さ上限に bottom inset 参照が無い",
  );
});

Deno.test("展開したアトリビューションの幅上限は左右 inset を差し引く（#328）", () => {
  // アンカーは右下なので、幅上限から左右 inset を差し引いておかないと
  // 横持ちノッチ帯へ本文が食い込む（ベース側の規則で一括して効かせる）
  const rule = ruleBlock(
    css,
    ".maplibregl-ctrl-attrib.maplibregl-compact-show",
  );
  assert(
    rule.includes("var(--safe-area-left)") &&
      rule.includes("var(--safe-area-right)"),
    "幅上限に left/right inset 参照が無い",
  );
});

Deno.test("index.html の viewport は viewport-fit=cover を維持する（#284）", () => {
  const html = Deno.readTextFileSync("index.html");
  assert(html.includes("viewport-fit=cover"));
});
