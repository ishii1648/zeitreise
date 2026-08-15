# Codex repository rules

## GitHub Issue admission

- `codex-issue-loop` is the only autonomous Issue executor for this repository.
- Create or formalize an Issue under `triage` first. Complete the body,
  Acceptance Criteria, type labels such as `bug`, and relevant `area:*` labels
  before admitting it to the queue.
- Add `codex-loop:ready` only when the Issue can start immediately: every
  `LOOP-META depends-on` Issue is closed or has `codex-loop:done`, and no user
  decision, time gate, or external prerequisite remains. The loop does not parse
  `LOOP-META` itself.
- When the Issue is not ready, remove `triage` after formalization and use
  `blocked`, `needs-human`, or `do-not-automate` as appropriate. Never combine
  any of these labels with `codex-loop:ready`.
- Never manually change `codex-loop:running`, `codex-loop:needs-input`,
  `codex-loop:failed`, or `codex-loop:done`; those labels are owned by the
  supervisor.
- Do not add the legacy `task` or `status:in-progress` labels to new Issues.
- When an Issue is closed or receives `codex-loop:done`, re-evaluate open
  `blocked` Issues that depend on it and promote only those whose complete
  prerequisite set is satisfied.
- After creating or editing an Issue, read it back with `gh issue view` and
  verify that exactly one admission state is present before reporting success.
