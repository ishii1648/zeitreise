#!/usr/bin/env bash
set -euo pipefail

readonly MODEL="gpt-5.6-sol"

usage() {
  cat <<'EOF'
Usage:
  run-codex-worker.sh \
    --worktree ABSOLUTE_PATH \
    --prompt-file ABSOLUTE_PATH \
    --result-file ABSOLUTE_PATH \
    [--dry-run]
EOF
}

fail() {
  printf 'run-codex-worker: %s\n' "$1" >&2
  exit 2
}

worktree=""
prompt_file=""
result_file=""
dry_run=false

while (($# > 0)); do
  case "$1" in
    --worktree)
      (($# >= 2)) || fail "--worktree requires a value"
      worktree="$2"
      shift 2
      ;;
    --prompt-file)
      (($# >= 2)) || fail "--prompt-file requires a value"
      prompt_file="$2"
      shift 2
      ;;
    --result-file)
      (($# >= 2)) || fail "--result-file requires a value"
      result_file="$2"
      shift 2
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[[ -n "$worktree" ]] || fail "--worktree is required"
[[ -n "$prompt_file" ]] || fail "--prompt-file is required"
[[ -n "$result_file" ]] || fail "--result-file is required"
[[ "$worktree" == /* ]] || fail "--worktree must be an absolute path"
[[ "$prompt_file" == /* ]] || fail "--prompt-file must be an absolute path"
[[ "$result_file" == /* ]] || fail "--result-file must be an absolute path"
[[ -d "$worktree" ]] || fail "worktree does not exist: $worktree"
[[ -s "$prompt_file" ]] || fail "prompt file is missing or empty: $prompt_file"

worktree="$(cd "$worktree" && pwd -P)"
readonly worktree

git_dir="$(git -C "$worktree" rev-parse --path-format=absolute --git-dir 2>/dev/null)" ||
  fail "not a git worktree: $worktree"
git_common_dir="$(git -C "$worktree" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" ||
  fail "cannot resolve git common dir: $worktree"
[[ "$git_dir" != "$git_common_dir" ]] ||
  fail "primary worktree is forbidden; use a linked implementation worktree"

branch="$(git -C "$worktree" symbolic-ref --quiet --short HEAD 2>/dev/null)" ||
  fail "detached HEAD is forbidden"
[[ "$branch" == worktree-agent-* ]] ||
  fail "worker branch must match worktree-agent-*: $branch"

result_parent="$(dirname "$result_file")"
[[ -d "$result_parent" ]] || fail "result directory does not exist: $result_parent"
result_parent="$(cd "$result_parent" && pwd -P)"
readonly result_parent
[[ -w "$result_parent" ]] || fail "result directory is not writable: $result_parent"
result_file="$result_parent/$(basename "$result_file")"
readonly result_file

case "$result_file" in
  "$worktree" | "$worktree"/*)
    fail "result file must be outside the worker worktree"
    ;;
esac

command -v codex >/dev/null 2>&1 || fail "codex CLI is not available"

readonly log_file="${result_file}.log"
[[ ! -e "$result_file" ]] || fail "result file already exists: $result_file"
[[ ! -e "$log_file" ]] || fail "log file already exists: $log_file"
command=(
  codex exec
  --model "$MODEL"
  --cd "$worktree"
  --sandbox workspace-write
  --ephemeral
  --output-last-message "$result_file"
  -
)

if [[ "$dry_run" == true ]]; then
  printf 'prompt-file=%q\n' "$prompt_file"
  printf 'log-file=%q\n' "$log_file"
  printf 'command='
  printf '%q ' "${command[@]}"
  printf '\n'
  exit 0
fi

locked=false
unlock_worktree() {
  if [[ "$locked" == true ]]; then
    git -C "$worktree" worktree unlock "$worktree" >/dev/null 2>&1 || true
  fi
}
trap unlock_worktree EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

git -C "$worktree" worktree lock \
  --reason "codex-worker:${branch}" \
  "$worktree" || fail "cannot lock worker worktree: $worktree"
locked=true

if "${command[@]}" <"$prompt_file" >"$log_file" 2>&1; then
  [[ -s "$result_file" ]] || fail "Codex completed without a final result: $result_file"
  printf 'Codex worker completed: %s\n' "$result_file"
  exit 0
else
  status=$?
fi

printf 'run-codex-worker: Codex exited with status %d; log tail follows\n' "$status" >&2
tail -n 80 "$log_file" >&2 || true
exit "$status"
