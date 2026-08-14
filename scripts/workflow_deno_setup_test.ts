import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  checkDenoSetupResilience,
  extractJobSteps,
  findUnpinnedActionUses,
  matchesOutcomeFailure,
} from "./workflow_deno_setup.ts";

// #367: Deploy workflow の `Setup Deno` が Deno バイナリ取得（GitHub release
// アセット CDN）の `socket hang up` / 503 で失敗し、deploy ジョブの後続 step が
// 全て skip されてマージ済みの変更が本番へ反映されない事象が高頻度で再発した。
// 対策（1 回目の失敗を許容し、その失敗時にのみ再試行 step を走らせる）が
// build / deploy 両ジョブに入っていることをここで固定する。
//
// scripts/fmt_ci_test.ts と同様、実 workflow を読む検証は読み取り権限がある
// 場合に限って行う（deno.json の test タスクは .github/workflows を許可済み。
// 権限が無い環境では ignore でスキップする）。

const DEPLOY_WORKFLOW = ".github/workflows/deploy.yml";

const GOOD_JOB = `
name: X
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0

      - name: Setup Deno
        id: setup_deno
        continue-on-error: true
        uses: denoland/setup-deno@22d081ff2d3a40755e97629de92e3bcbfa7cf2ed # v2.0.5
        with:
          deno-version: "2.7.14"

      - name: Setup Deno (retry)
        if: steps.setup_deno.outcome == 'failure'
        uses: denoland/setup-deno@22d081ff2d3a40755e97629de92e3bcbfa7cf2ed # v2.0.5
        with:
          deno-version: "2.7.14"

      - name: deno task build
        run: deno task build
`;

/** GOOD_JOB を 1 箇所だけ書き換えて壊れた workflow を作る。 */
function mutate(from: string, to: string): string {
  const replaced = GOOD_JOB.replace(from, to);
  assertEquals(replaced === GOOD_JOB, false, `置換対象が見つからない: ${from}`);
  return replaced;
}

function problemsOf(yamlText: string): string[] {
  return checkDenoSetupResilience(
    extractJobSteps(yamlText, "deploy"),
    "deploy",
  );
}

Deno.test("checkDenoSetupResilience: 本体 + 再試行が揃っていれば問題なし", () => {
  assertEquals(problemsOf(GOOD_JOB), []);
});

Deno.test("checkDenoSetupResilience: 再試行 step が無ければ検出する", () => {
  const yamlText = GOOD_JOB.replace(
    `      - name: Setup Deno (retry)
        if: steps.setup_deno.outcome == 'failure'
        uses: denoland/setup-deno@22d081ff2d3a40755e97629de92e3bcbfa7cf2ed # v2.0.5
        with:
          deno-version: "2.7.14"
`,
    "",
  );
  const problems = problemsOf(yamlText);
  assertEquals(problems.length, 1);
  assertStringIncludes(problems[0], "2 個であるべき");
});

Deno.test("checkDenoSetupResilience: continue-on-error が無ければ検出する", () => {
  const problems = problemsOf(
    mutate("        continue-on-error: true\n", ""),
  );
  assertEquals(problems.length, 1);
  assertStringIncludes(problems[0], "continue-on-error: true がありません");
});

Deno.test("checkDenoSetupResilience: 再試行の if が失敗時限定でなければ検出する", () => {
  const problems = problemsOf(
    mutate(
      "        if: steps.setup_deno.outcome == 'failure'",
      "        if: always()",
    ),
  );
  assertEquals(problems.length, 1);
  assertStringIncludes(problems[0], "outcome == 'failure' になっていません");
});

Deno.test("checkDenoSetupResilience: 再試行が参照する id が別 step なら検出する", () => {
  const problems = problemsOf(
    mutate(
      "        if: steps.setup_deno.outcome == 'failure'",
      "        if: steps.other_step.outcome == 'failure'",
    ),
  );
  assertEquals(problems.length, 1);
  assertStringIncludes(problems[0], "steps.setup_deno.outcome");
});

Deno.test("checkDenoSetupResilience: 本体に id が無ければ検出する", () => {
  const problems = problemsOf(mutate("        id: setup_deno\n", ""));
  // id が無いと再試行の if も検証できないため 2 件出る
  assertEquals(problems.length, 2);
  assertStringIncludes(problems[0], "id がありません");
});

Deno.test("checkDenoSetupResilience: 再試行にも continue-on-error が付いていれば検出する", () => {
  const problems = problemsOf(
    mutate(
      "        if: steps.setup_deno.outcome == 'failure'",
      "        if: steps.setup_deno.outcome == 'failure'\n        continue-on-error: true",
    ),
  );
  assertEquals(problems.length, 1);
  assertStringIncludes(problems[0], "2 回目も失敗したのにジョブが成功します");
});

Deno.test("checkDenoSetupResilience: 再試行が直後に無ければ検出する", () => {
  const problems = problemsOf(
    mutate(
      "      - name: Setup Deno (retry)",
      "      - name: 割り込み\n        run: echo hi\n\n      - name: Setup Deno (retry)",
    ),
  );
  assertEquals(problems.length, 1);
  assertStringIncludes(problems[0], "1 個目の直後にありません");
});

Deno.test("checkDenoSetupResilience: 本体と再試行の pin がずれていれば検出する", () => {
  const yamlText = GOOD_JOB.replace(
    `        uses: denoland/setup-deno@22d081ff2d3a40755e97629de92e3bcbfa7cf2ed # v2.0.5
        with:
          deno-version: "2.7.14"

      - name: deno task build`,
    `        uses: denoland/setup-deno@0000000000000000000000000000000000000000 # v2.0.4
        with:
          deno-version: "2.8.0"

      - name: deno task build`,
  );
  const problems = problemsOf(yamlText);
  assertEquals(problems.length, 2);
  assertStringIncludes(problems[0], "uses が一致しません");
  assertStringIncludes(problems[1], "deno-version が一致しません");
});

Deno.test("matchesOutcomeFailure: ${{ }} 包みと引用符の揺れを許容する", () => {
  assertEquals(
    matchesOutcomeFailure(
      "steps.setup_deno.outcome == 'failure'",
      "setup_deno",
    ),
    true,
  );
  assertEquals(
    matchesOutcomeFailure(
      "${{ steps.setup_deno.outcome == 'failure' }}",
      "setup_deno",
    ),
    true,
  );
  assertEquals(
    matchesOutcomeFailure(
      'steps.setup_deno.outcome == "failure"',
      "setup_deno",
    ),
    true,
  );
  // conclusion は continue-on-error 下では success になるため不可
  assertEquals(
    matchesOutcomeFailure(
      "steps.setup_deno.conclusion == 'failure'",
      "setup_deno",
    ),
    false,
  );
  assertEquals(matchesOutcomeFailure("", "setup_deno"), false);
});

Deno.test("extractJobSteps: 存在しない job は明確なエラー", () => {
  assertThrows(
    () => extractJobSteps(GOOD_JOB, "nope"),
    Error,
    'job "nope"',
  );
});

Deno.test("findUnpinnedActionUses: SHA ピン + バージョンコメントを要求する", () => {
  assertEquals(findUnpinnedActionUses(GOOD_JOB), []);
  const problems = findUnpinnedActionUses(
    "      - uses: actions/checkout@v4\n",
  );
  assertEquals(problems.length, 2);
  assertStringIncludes(problems[0], "フルコミット SHA");
  assertStringIncludes(problems[1], "バージョンコメント");
  assertEquals(
    findUnpinnedActionUses(
      "      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262\n",
    ).length,
    1,
  );
});

const canReadDeployWorkflow =
  Deno.permissions.querySync({ name: "read", path: DEPLOY_WORKFLOW }).state ===
    "granted";

for (const jobId of ["build", "deploy"]) {
  Deno.test({
    name:
      `実 deploy.yml: job "${jobId}" の Setup Deno に CDN 障害耐性がある（読み取り権限がある場合のみ）`,
    ignore: !canReadDeployWorkflow,
    fn: () => {
      const text = Deno.readTextFileSync(DEPLOY_WORKFLOW);
      assertEquals(
        checkDenoSetupResilience(extractJobSteps(text, jobId), jobId),
        [],
      );
    },
  });
}

Deno.test({
  name:
    "実 deploy.yml: 全 action 参照がフルコミット SHA + バージョンコメント（読み取り権限がある場合のみ）",
  ignore: !canReadDeployWorkflow,
  fn: () => {
    assertEquals(
      findUnpinnedActionUses(Deno.readTextFileSync(DEPLOY_WORKFLOW)),
      [],
    );
  },
});
