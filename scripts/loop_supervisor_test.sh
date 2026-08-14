#!/usr/bin/env bash
# loop_supervisor_test.sh — loop_supervisor.sh の境界判定の振る舞いテスト（Issue #374）
#
# herdr / git をスタブに差し替えて loop_supervisor.sh を実行し、
# 「claim タグが残っている間は /clear を注入しない」ことを検証する。
#
# deno test では書けない: CI の `deno test` は --allow-run を与えていない
# （.github/workflows/ci.yml）。同じ制約は scripts/deno-config-exclude_test.ts に
# も記録がある。そのため CI では本スクリプトを独立したステップで実行する。

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SUPERVISOR="$SCRIPT_DIR/loop_supervisor.sh"
failures=0

# スタブ環境を作る。
#   $1: claim タグを返す回数（この回数を超えたら空を返す = 境界に到達）
setup_stubs() {
  local claim_rounds="$1"
  WORK=$(mktemp -d)
  mkdir -p "$WORK/bin"
  LOG="$WORK/herdr.log"
  : > "$LOG"
  printf '0\n' > "$WORK/git-calls"

  cat > "$WORK/bin/herdr" << STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$LOG"
exit 0
STUB

  cat > "$WORK/bin/git" << STUB
#!/usr/bin/env bash
# ls-remote 以外は素通しさせない（テストが意図しない git 呼び出しに気づけるように）
case "\$*" in
  *ls-remote*)
    n=\$(cat "$WORK/git-calls")
    printf '%s\n' "\$((n + 1))" > "$WORK/git-calls"
    if [ "\$n" -lt "$claim_rounds" ]; then
      printf '%s\trefs/tags/claim/issue-999\n' 0000000000000000000000000000000000000000
    fi
    exit 0
    ;;
esac
printf 'unexpected git invocation: %s\n' "\$*" >&2
exit 1
STUB

  chmod +x "$WORK/bin/herdr" "$WORK/bin/git"
}

teardown_stubs() {
  [ -n "${WORK:-}" ] && rm -rf "$WORK"
}

run_supervisor() {
  PATH="$WORK/bin:$PATH" bash "$SUPERVISOR" w1:p1 \
    --cycles 1 --min-interval 0 --clear-delay 0 --boundary-poll 0 \
    > "$WORK/stdout" 2>&1
}

# 最初に /clear が注入されるまでに観測された `agent wait` の回数を数える。
waits_before_clear() {
  awk '
    /^agent wait / { waits++ }
    /^agent prompt .* \/clear$/ { print waits; found = 1; exit }
    END { if (!found) print -1 }
  ' "$LOG"
}

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf 'ok   - %s\n' "$label"
  else
    printf 'FAIL - %s (expected %s, got %s)\n' "$label" "$expected" "$actual"
    printf '      herdr log:\n'
    sed 's/^/        /' "$LOG"
    failures=$((failures + 1))
  fi
}

# AC1/AC2: claim タグが残っている間は /clear を注入せず待ちに戻る。
# 2 回は claim あり → 3 回目の wait のあとで初めて /clear が飛ぶ。
setup_stubs 2
run_supervisor
check "claim タグが残っている間は /clear を注入しない" 3 "$(waits_before_clear)"
teardown_stubs

# AC3: claim タグが空なら従来どおり最初の idle で /clear → 再投入。
setup_stubs 0
run_supervisor
check "claim タグが空なら最初の idle で /clear を注入する" 1 "$(waits_before_clear)"
check "再投入プロンプトが送られる" 1 \
  "$(grep -c -- '^agent prompt w1:p1 /agent-loop --wait' "$LOG")"
teardown_stubs

if [ "$failures" -gt 0 ]; then
  printf '\n%d test(s) failed\n' "$failures"
  exit 1
fi
printf '\nall tests passed\n'
