import { assert } from "@std/assert";
import denoJson from "../deno.json" with { type: "json" };

// #229: 並列セッションの worktree が `.claude/worktrees/` 配下に常駐するため、
// deno fmt / lint / test が `.claude/` を走査すると clean な main でも red に
// なる。除外は CLI `--ignore` ではなく deno.json 側に置く（CLI の --ignore は
// fmt.exclude を置き換えてしまうため。Issue #229 確定事項）。
//
// CI の `deno test` は --allow-read=data,docs のみで実行され、--allow-run も
// --allow-write も無いため、CLI を Deno.Command で叩く再現テストは書けない。
// known-limitations-json_test.ts と同方式の static import で設定値そのものを
// 検証し、実ファイルでの再現確認は手動（Issue #229 の再現手順）で行う。

type ToolConfig = { exclude?: string[] } | undefined;

const config = denoJson as {
  exclude?: string[];
  fmt?: ToolConfig;
  lint?: ToolConfig;
  test?: ToolConfig;
};

/** ツール個別の exclude とトップレベル exclude を合算した実効除外リスト */
function effectiveExclude(tool: ToolConfig): string[] {
  return [...(config.exclude ?? []), ...(tool?.exclude ?? [])];
}

function excludesClaudeDir(excludes: string[]): boolean {
  return excludes.some((e) =>
    e === ".claude" || e === ".claude/" || e.startsWith(".claude/")
  );
}

Deno.test("fmt は .claude/ を除外する（#229 AC1）", () => {
  assert(
    excludesClaudeDir(effectiveExclude(config.fmt)),
    "deno.json の fmt 実効 exclude に .claude/ が無い",
  );
});

Deno.test("test は .claude/ を除外する（#229 AC2）", () => {
  assert(
    excludesClaudeDir(effectiveExclude(config.test)),
    "deno.json の test 実効 exclude に .claude/ が無い",
  );
});

Deno.test("lint は .claude/ を除外する（#229 AC3）", () => {
  assert(
    excludesClaudeDir(effectiveExclude(config.lint)),
    "deno.json の lint 実効 exclude に .claude/ が無い",
  );
});

Deno.test("既存の fmt.exclude 一式が維持されている（#229 AC4）", () => {
  const fmtExclude = effectiveExclude(config.fmt);
  for (
    const required of [
      "data/",
      "docs/adr/",
      "docs/archive/",
      "vendor/",
      ".outputs/",
    ]
  ) {
    assert(
      fmtExclude.includes(required),
      `fmt の実効 exclude から ${required} が失われている`,
    );
  }
});
