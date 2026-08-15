import { assert, assertEquals, assertMatch, assertThrows } from "@std/assert";
import {
  areaLabelColor,
  buildGhArgs,
  buildLabelDefs,
  extractAreaLabels,
  FIXED_LABELS,
  formatGhCommand,
} from "./setup-issue-labels.ts";

// 4.2 章の構造を模した最小フィクスチャ。
// - 具体ラベル行（`area:docs` 等）は抽出される
// - ワイルドカード行（`area:scripts-*`）・プレースホルダ行（`area:src-<module>`）は
//   ラベルとして実在しないため抽出されない
// - 表以外の本文に現れる `area:scripts`（「粗いラベルは使わない」の言及）は
//   抽出されない
const FIXTURE = `
## 4. ループエンジニアリング

### 4.2 area ラベル規約とタスク間並列実行

| area                | 対応パスの目安 |
| ------------------- | -------------- |
| \`area:docs\`         | \`docs/\`       |
| \`area:workflow\`     | \`.claude/\`    |
| \`area:scripts-*\`    | \`scripts/\` 配下 |
| \`area:src-main\`     | UI 統合部（例: \`area:src-labels\` と衝突） |
| \`area:src-<module>\` | 独立モジュール（例: \`area:src-powers\`） |

**\`scripts/\` の細分化**:

| area                | 対応パスの目安 |
| ------------------- | -------------- |
| \`area:scripts-loop\` | \`scripts/next_task.ts\` |
| \`area:scripts-loop\` | 重複行はまとめる |

- **粗い \`area:scripts\` / \`area:data\` は使わない。**

### 4.2.1 bug 起票のバッチ化

| area           | 対応パスの目安 |
| -------------- | -------------- |
| \`area:ignored\` | 4.2 章の外にある表は抽出対象外 |
`;

Deno.test("extractAreaLabels は 4.2 章の表の先頭列から具体ラベルのみ抽出する", () => {
  assertEquals(extractAreaLabels(FIXTURE), [
    "area:docs",
    "area:workflow",
    "area:src-main",
    "area:scripts-loop",
  ]);
});

Deno.test("extractAreaLabels は 4.2 章が見つからなければ throw する", () => {
  assertThrows(
    () => extractAreaLabels("# 無関係な文書\n"),
    Error,
    "4.2",
  );
});

Deno.test("extractAreaLabels は実ドキュメントの 4.2 章と同期している", async () => {
  const markdown = await Deno.readTextFile(
    new URL("../docs/development-style.md", import.meta.url),
  );
  // development-style.md 4.2 章の領域一覧（固定領域のみ。`area:src-<module>` は
  // タスク側で都度定義される開放集合のため、同期スクリプトの対象外）。
  // 4.2 章の表を変更したらこのリストも更新すること（同期テスト）。
  assertEquals(extractAreaLabels(markdown), [
    "area:docs",
    "area:workflow",
    "area:src-main",
    "area:scripts-base",
    "area:scripts-fiefs",
    "area:scripts-features",
    "area:scripts-meta",
    "area:scripts-build",
    "area:scripts-loop",
    "area:scripts-verify",
    "area:data-base",
    "area:data-fiefs",
    "area:data-features",
    "area:data-meta",
  ]);
});

Deno.test("FIXED_LABELS は codex-issue-loop 用ラベルを定義し legacy label と bug を含まない", () => {
  assertEquals(FIXED_LABELS.map((l) => l.name), [
    "codex-loop:ready",
    "codex-loop:running",
    "codex-loop:needs-input",
    "codex-loop:failed",
    "codex-loop:done",
    "blocked",
    "needs-human",
    "triage",
    "do-not-automate",
  ]);
  assert(!FIXED_LABELS.some((l) => l.name === "task"));
  assert(!FIXED_LABELS.some((l) => l.name === "status:in-progress"));
  // `bug` は GitHub 既定ラベルを流用するため作成対象に含めない（TASK-138）
  assert(!FIXED_LABELS.some((l) => l.name === "bug"));
});

Deno.test("areaLabelColor は領域グループごとに色を割り当てる", () => {
  assertEquals(areaLabelColor("area:docs"), areaLabelColor("area:docs"));
  // グループ内は同色、グループ間は異色
  assertEquals(
    areaLabelColor("area:scripts-base"),
    areaLabelColor("area:scripts-loop"),
  );
  assertEquals(
    areaLabelColor("area:data-base"),
    areaLabelColor("area:data-meta"),
  );
  assert(
    areaLabelColor("area:scripts-base") !== areaLabelColor("area:data-base"),
  );
  assert(areaLabelColor("area:docs") !== areaLabelColor("area:workflow"));
});

Deno.test("buildLabelDefs は固定ラベル + 4.2 章の area ラベルを重複なく返す", () => {
  const defs = buildLabelDefs(FIXTURE);
  assertEquals(defs.map((l) => l.name), [
    "codex-loop:ready",
    "codex-loop:running",
    "codex-loop:needs-input",
    "codex-loop:failed",
    "codex-loop:done",
    "blocked",
    "needs-human",
    "triage",
    "do-not-automate",
    "area:docs",
    "area:workflow",
    "area:src-main",
    "area:scripts-loop",
  ]);
  const names = defs.map((l) => l.name);
  assertEquals(names.length, new Set(names).size);
  for (const def of defs) {
    assertMatch(def.color, /^[0-9A-F]{6}$/);
    assert(def.description.length > 0, `${def.name} の説明が空`);
    assert(def.description.length <= 100, `${def.name} の説明が 100 字超`);
  }
});

Deno.test("buildGhArgs は gh label create --force（upsert）の argv を組み立てる", () => {
  assertEquals(
    buildGhArgs({
      name: "codex-loop:ready",
      color: "0E8A16",
      description: "Ready for codex-issue-loop",
    }),
    [
      "label",
      "create",
      "codex-loop:ready",
      "--color",
      "0E8A16",
      "--description",
      "Ready for codex-issue-loop",
      "--force",
    ],
  );
});

Deno.test("formatGhCommand は空白・非 ASCII を含む引数をクォートする", () => {
  assertEquals(
    formatGhCommand([
      "label",
      "create",
      "codex-loop:ready",
      "--description",
      "Ready for codex-issue-loop",
    ]),
    'gh label create codex-loop:ready --description "Ready for codex-issue-loop"',
  );
});
