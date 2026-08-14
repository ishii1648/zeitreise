// #367: GitHub Actions の `Setup Deno`（denoland/setup-deno）が Deno バイナリ
// 取得（GitHub release アセット CDN）で `socket hang up` / HTTP 503 を返して
// 失敗する事象が高頻度で再発する。action 内蔵のリトライも同じエラーで尽きると
// step が error になり、deploy ジョブでは後続 step（dist の取得・R2 同期・
// Pages デプロイ・キャッシュパージ）が全て skip され、main にマージ済みの
// 変更が本番へ反映されない。
//
// 対策は「1 回目の失敗をジョブの失敗にせず（continue-on-error）、その失敗時
// にだけ同一 pin で再試行する step を直後に置く」構成である。再試行 step 自体
// には continue-on-error を付けない（2 回目も失敗したらジョブは失敗すべき）。
//
// このモジュールは workflow YAML を読んでその構成が保たれていることを機械的に
// 検証する純ロジックを提供する（テストは scripts/workflow_deno_setup_test.ts）。

import { parse } from "@std/yaml";

/** setup-deno action のリポジトリ（`owner/repo`。ref は含まない）。 */
export const SETUP_DENO_ACTION = "denoland/setup-deno";

/** YAML のマッピング 1 個ぶん。 */
export type YamlRecord = Record<string, unknown>;

function asRecord(value: unknown): YamlRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as YamlRecord
    : null;
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

/** workflow YAML から指定 job の steps を配列で取り出す。 */
export function extractJobSteps(
  yamlText: string,
  jobId: string,
): YamlRecord[] {
  const doc = asRecord(parse(yamlText));
  if (!doc) throw new Error("workflow YAML がマッピングとして読めません");
  const jobs = asRecord(doc.jobs);
  if (!jobs) throw new Error("workflow に jobs がありません");
  const job = asRecord(jobs[jobId]);
  if (!job) throw new Error(`workflow に job "${jobId}" がありません`);
  const steps = job.steps;
  if (!Array.isArray(steps)) {
    throw new Error(`job "${jobId}" に steps がありません`);
  }
  return steps.map((step, index) => {
    const record = asRecord(step);
    if (!record) {
      throw new Error(
        `job "${jobId}" の step[${index}] がマッピングではありません`,
      );
    }
    return record;
  });
}

function usesOf(step: YamlRecord): string {
  return asString(step.uses);
}

function isSetupDeno(step: YamlRecord): boolean {
  return usesOf(step).startsWith(`${SETUP_DENO_ACTION}@`);
}

function denoVersionOf(step: YamlRecord): string {
  return asString(asRecord(step.with)?.["deno-version"]);
}

function labelOf(step: YamlRecord, index: number): string {
  const name = asString(step.name);
  return name ? `"${name}"(step[${index}])` : `step[${index}]`;
}

/**
 * `if:` の式が「指定 step の outcome が failure のときだけ真」になっているか。
 * `${{ ... }}` で包まれていても包まれていなくても受け付ける（GitHub Actions は
 * `if:` の中では両方を同じに扱う）。
 */
export function matchesOutcomeFailure(
  condition: string,
  stepId: string,
): boolean {
  if (!stepId) return false;
  let body = condition.trim();
  if (body.startsWith("${{") && body.endsWith("}}")) {
    body = body.slice(3, -2).trim();
  }
  const escapedId = stepId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^steps\\.${escapedId}\\.outcome\\s*==\\s*(['"])failure\\1$`,
  );
  return pattern.test(body);
}

/**
 * 指定 job の `Setup Deno` に CDN 障害への耐性（1 回目の失敗許容 + その失敗時
 * にのみ走る再試行）が入っているかを検査し、問題を人間が読める文言で返す。
 * 問題が無ければ空配列。
 */
export function checkDenoSetupResilience(
  steps: YamlRecord[],
  jobId: string,
): string[] {
  const problems: string[] = [];
  const indices = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => isSetupDeno(step))
    .map(({ index }) => index);

  if (indices.length !== 2) {
    problems.push(
      `job "${jobId}": ${SETUP_DENO_ACTION} の step は「本体 + 再試行」の 2 個であるべきですが ${indices.length} 個です`,
    );
    return problems;
  }

  const [primaryIndex, retryIndex] = indices;
  const primary = steps[primaryIndex];
  const retry = steps[retryIndex];

  const primaryId = asString(primary.id);
  if (!primaryId) {
    problems.push(
      `job "${jobId}": 1 個目の Setup Deno ${
        labelOf(primary, primaryIndex)
      } に id がありません（再試行の if から outcome を参照できません）`,
    );
  }
  if (primary["continue-on-error"] !== true) {
    problems.push(
      `job "${jobId}": 1 個目の Setup Deno ${
        labelOf(primary, primaryIndex)
      } に continue-on-error: true がありません（1 回目の失敗でジョブが落ちます）`,
    );
  }

  if (retryIndex !== primaryIndex + 1) {
    problems.push(
      `job "${jobId}": 再試行の Setup Deno ${
        labelOf(retry, retryIndex)
      } が 1 個目の直後にありません（間に別の step があると Deno 無しで実行されます）`,
    );
  }

  const retryIf = asString(retry.if);
  if (!matchesOutcomeFailure(retryIf, primaryId)) {
    problems.push(
      `job "${jobId}": 再試行の Setup Deno ${
        labelOf(retry, retryIndex)
      } の if が steps.${
        primaryId || "<1 個目の id>"
      }.outcome == 'failure' になっていません（実際: ${
        JSON.stringify(retryIf)
      }）`,
    );
  }
  if (retry["continue-on-error"] === true) {
    problems.push(
      `job "${jobId}": 再試行の Setup Deno ${
        labelOf(retry, retryIndex)
      } に continue-on-error: true があります（2 回目も失敗したのにジョブが成功します）`,
    );
  }

  if (usesOf(primary) !== usesOf(retry)) {
    problems.push(
      `job "${jobId}": 本体と再試行の uses が一致しません（${
        usesOf(primary)
      } / ${usesOf(retry)}）`,
    );
  }

  const primaryVersion = denoVersionOf(primary);
  const retryVersion = denoVersionOf(retry);
  if (!primaryVersion) {
    problems.push(
      `job "${jobId}": 1 個目の Setup Deno に deno-version のピン留めがありません`,
    );
  }
  if (primaryVersion !== retryVersion) {
    problems.push(
      `job "${jobId}": 本体と再試行の deno-version が一致しません（${
        primaryVersion || "(なし)"
      } / ${retryVersion || "(なし)"}）`,
    );
  }

  return problems;
}

/**
 * workflow 内の外部 action 参照がフルコミット SHA でピン留めされ、かつ
 * バージョンコメント（`# v4.4.0` 等）を伴っているかを検査する
 * （`docs/development-style.md` 7 章）。問題を人間が読める文言で返す。
 *
 * コメントは YAML パース後には残らないため、生テキストを走査する。
 */
export function findUnpinnedActionUses(yamlText: string): string[] {
  const problems: string[] = [];
  const lines = yamlText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*(?:-\s+)?uses:\s*(.*)$/);
    if (!match) continue;
    const rest = match[1];
    const hash = rest.indexOf("#");
    const ref = (hash >= 0 ? rest.slice(0, hash) : rest).trim();
    const comment = hash >= 0 ? rest.slice(hash + 1).trim() : "";
    if (!ref) continue;
    if (!/@[0-9a-f]{40}$/.test(ref)) {
      problems.push(
        `L${i + 1}: uses: ${ref} がフルコミット SHA でピン留めされていません`,
      );
    }
    if (!/^v\d/.test(comment)) {
      problems.push(
        `L${
          i + 1
        }: uses: ${ref} にバージョンコメント（# vX.Y.Z）がありません（実際: ${
          comment || "(なし)"
        }）`,
      );
    }
  }
  return problems;
}
