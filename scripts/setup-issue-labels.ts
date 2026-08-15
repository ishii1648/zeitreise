/**
 * GitHub Issue タスク管理用のラベルをリポジトリへ同期する（TASK-138）。
 *
 * - 固定ラベル: codex-issue-loopのadmission/state/exclude label。
 *   `running` / `needs-input` / `failed` / `done` はsupervisorだけが操作する。
 * - area ラベル: docs/development-style.md 4.2 章の表から機械的に抽出する。
 *   ワイルドカード行（`area:scripts-*`）とプレースホルダ行（`area:src-<module>`）は
 *   固定領域ではないため対象外。`area:src-<module>` の個別ラベルはタスク起票時に
 *   都度作成する。
 * - `bug` は GitHub 既定ラベルを流用するため作成しない。
 *
 * `gh label create --force` は「なければ作成、あれば色・説明を更新」の upsert として
 * 動作するため、何度実行しても冪等。
 *
 * 使い方:
 *   deno task setup-issue-labels            # gh を実行してラベルを同期
 *   deno task setup-issue-labels --dry-run  # 実行せずコマンドを表示
 */

export interface LabelDef {
  name: string;
  color: string; // 6 桁 hex（# なし）
  description: string;
}

/** area 以外の固定ラベル。`bug` は GitHub 既定ラベルを流用するため含めない。 */
export const FIXED_LABELS: LabelDef[] = [
  {
    name: "codex-loop:ready",
    color: "0E8A16",
    description: "Ready for codex-issue-loop",
  },
  {
    name: "codex-loop:running",
    color: "1D76DB",
    description: "Being processed by codex-issue-loop",
  },
  {
    name: "codex-loop:needs-input",
    color: "FBCA04",
    description: "Waiting for user input in codex-issue-loop",
  },
  {
    name: "codex-loop:failed",
    color: "D73A4A",
    description: "codex-issue-loop processing failed",
  },
  {
    name: "codex-loop:done",
    color: "5319E7",
    description: "Completed by codex-issue-loop",
  },
  {
    name: "blocked",
    color: "B60205",
    description: "Blocked from automated processing",
  },
  {
    name: "needs-human",
    color: "D93F0B",
    description: "人の判断・操作が必要（自動実行の対象外）",
  },
  {
    name: "triage",
    color: "D4C5F9",
    description:
      "未整形の雑起票（自動実行の対象外。intake後にadmission labelへ置換）",
  },
  {
    name: "do-not-automate",
    color: "BFD4F2",
    description: "自動実行を恒久的に禁止するIssue",
  },
];

/**
 * development-style.md の 4.2 章にある表の先頭列から具体的な area ラベルを
 * 抽出する（純粋関数）。
 *
 * - 対象範囲は「### 4.2 」見出しから次の見出し（### 4.2.1 等）まで
 * - 表の先頭セルが `` `area:...` `` の行のみ対象（本文中の言及は拾わない）
 * - `*` / `<` を含む名前はワイルドカード・プレースホルダなので除外
 * - 出現順を保ち、重複は除去する
 */
export function extractAreaLabels(markdown: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^### 4\.2 /.test(line));
  if (start === -1) {
    throw new Error("development-style.md に 4.2 章の見出しが見つからない");
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{2,3} /.test(lines[i])) {
      end = i;
      break;
    }
  }
  const labels: string[] = [];
  for (const line of lines.slice(start, end)) {
    const match = line.match(/^\|\s*`(area:[^`]+)`\s*\|/);
    if (!match) continue;
    const name = match[1];
    if (name.includes("*") || name.includes("<")) continue;
    if (!labels.includes(name)) labels.push(name);
  }
  return labels;
}

/** area ラベルの色を領域グループ（docs / workflow / scripts / data / src）で割り当てる。 */
export function areaLabelColor(name: string): string {
  const area = name.slice("area:".length);
  if (area === "docs") return "0075CA";
  if (area === "workflow") return "5319E7";
  if (area.startsWith("scripts-")) return "0E8A16";
  if (area.startsWith("data-")) return "D93F0B";
  if (area.startsWith("src")) return "006B75";
  return "BFD4F2";
}

/** 固定ラベル + 4.2 章から抽出した area ラベルの定義一覧を組み立てる（純粋関数）。 */
export function buildLabelDefs(markdown: string): LabelDef[] {
  const areaDefs = extractAreaLabels(markdown).map((name) => ({
    name,
    color: areaLabelColor(name),
    description: "変更ファイル領域（docs/development-style.md 4.2 章）",
  }));
  return [...FIXED_LABELS, ...areaDefs];
}

/** 1 ラベル分の gh 引数を組み立てる（純粋関数）。--force で upsert（冪等）。 */
export function buildGhArgs(label: LabelDef): string[] {
  return [
    "label",
    "create",
    label.name,
    "--color",
    label.color,
    "--description",
    label.description,
    "--force",
  ];
}

/** dry-run 表示用。空白や非 ASCII を含む引数のみダブルクォートする（純粋関数）。 */
export function formatGhCommand(args: string[]): string {
  return ["gh", ...args]
    .map((arg) => /^[A-Za-z0-9_:./=-]+$/.test(arg) ? arg : `"${arg}"`)
    .join(" ");
}

if (import.meta.main) {
  const dryRun = Deno.args.includes("--dry-run");
  const markdown = await Deno.readTextFile(
    new URL("../docs/development-style.md", import.meta.url),
  );
  const labels = buildLabelDefs(markdown);
  let failed = 0;
  for (const label of labels) {
    const args = buildGhArgs(label);
    if (dryRun) {
      console.log(formatGhCommand(args));
      continue;
    }
    const { code, stderr } = await new Deno.Command("gh", { args }).output();
    if (code === 0) {
      console.log(`synced: ${label.name}`);
    } else {
      failed++;
      console.error(
        `failed: ${label.name}\n${new TextDecoder().decode(stderr).trim()}`,
      );
    }
  }
  if (failed > 0) {
    console.error(`${failed} 件のラベル同期に失敗`);
    Deno.exit(1);
  }
}
