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
