# Codex repository rules

## GitHub Issue admission

- `codex-issue-loop` is the only autonomous Issue executor for this repository.
- Create an unevaluated Issue without a status label. Complete the body,
  Acceptance Criteria, type labels such as `bug`, and relevant `area:*` labels
  before admitting it to the queue.
- Add `codex-loop:ready` only when the Issue can start immediately: every
  `LOOP-META depends-on` Issue is closed or has `codex-loop:done`, and no user
  decision, time gate, or external prerequisite remains. The loop does not parse
  `LOOP-META` itself.
- Use `blocked` for unmet prerequisites and `needs-human` for a required human
  decision or action; they may coexist. Never combine either with ready. To keep
  an Issue outside automation, omit ready and preserve the reason in its body.
  Do not use `triage` or `do-not-automate`.
- Save intake questions with `agent-loop issue ask` and answers with
  `agent-loop answer`. Re-evaluate the body and Acceptance Criteria before
  admitting an answered Issue; an answer alone does not make it ready.
- Never manually change `codex-loop:running`, `codex-loop:failed`, or
  `codex-loop:done`; those labels are owned by the supervisor. The supervisor
  also owns `needs-human` for managed Issues.
- Do not add the legacy `task` or `status:in-progress` labels to new Issues.
- When an Issue is closed or receives `codex-loop:done`, re-evaluate open
  `blocked` Issues that depend on it and promote only those whose complete
  prerequisite set is satisfied.
- After creating or editing an Issue, read it back with `gh issue view` and
  verify the expected admission state: ready only when immediately actionable,
  no ready while blocked or needing human input, and no status label for
  unevaluated work.

## 資料調査と実装着手の判断

- 公開資料の検索・取得・原文確認・代替資料の探索・採否判断はエージェントの担当範囲とする。資料不足だけを理由にユーザーへ資料提供を求めず、許可された利用可能な手段で調査を進める。
- 起票・実装着手・再開前には、最新のdefault
  branch上の関連記録、関連する終了済みIssue、過去の利用者回答を確認する。古いチェックアウトや先行Issueのclosed/doneだけを根拠に、資料確保や実装可能性を判断しない。撤回済みの前提を再利用しない。
- 調査着手と実装着手を区別する。入力が未確認なら探索・採否確認を作業範囲として明示し、資料取得・内容・対象への適合性・利用条件を確認できた範囲だけ実装へ進む。先行調査の完了を、実装用入力の確保や実装完了と同一視しない。
- 「未調査」「取得手段・権限の障害」「調査済みだが採用条件を満たさない」「利用者の判断が必要」を区別する。未調査の有望な候補があれば調査を続ける。取得障害は資料の不存在・内容不足と読み替えず、許可された別の取得手段や所蔵先を確認し、設定や権限を無断で変更して回避しない。
- 候補資料、確認内容、不採用理由、未調査の候補、再検討に必要な新証拠を既存の調査記録または作業報告に残す。新証拠や状況変化なしに、同じ不採用候補の再調査・同じ取得失敗・回答済みの質問を繰り返さない。
- ユーザーへの質問は、その回答で進行可能になる仕様・精度・費用の判断、権限、私有情報など、ユーザーにしか解決できない事項に限定する。質問前に独立して進められる調査を行い、実施済みの探索、不足している具体的根拠、継続できない理由、回答が何を解決するかを示す。単に「追加資料を指定するか、保留するか」と探索責任を返さない。
- 探索しても採用条件を満たせない場合は、調査範囲と未達条件、再開に必要な新証拠を明示して未完了として報告する。資料が世界中に存在しないと断定せず、際限なく同じ探索を続けない。根拠を創作したり、受入条件を無断で緩和したり、調査完了へ置き換えて実装完了扱いにしない。agent-loopでは正式な状態報告・回答手順に従う。
