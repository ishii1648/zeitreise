#!/usr/bin/env bash
# loop_supervisor.sh — agent-loop の外部再投入 supervisor（Issue #258 / ADR-0036）
#
# herdr 配下で動く agent-loop セッションをホスト側から監視し、
#   1. `herdr agent wait <target> --until idle --until done` でターン終了を待ち、
#      claim タグが空であることを確認してイテレーション境界と判定する
#   2. `herdr agent prompt <target> "/clear"` でコンテキストを投棄する
#   3. `herdr agent prompt <target> "/agent-loop" --wait --until idle
#      --until done` でループを再投入し、イテレーション完了まで待つ
# を繰り返す。イテレーションをまたぐ N² のコンテキスト蓄積を境界で全量
# 投棄するための仕組みで、セッション側の終端動作（supervisor モード）は
# .claude/skills/agent-loop/SKILL.md の「supervisor モード」節を参照。
#
# 前提:
#   - herdr CLI が使えるホスト上で実行する（herdr の導入・常駐はホスト管轄
#     = dotfiles / k8s-lab。本スクリプトは agent-loop の運用手順の一部なので
#     リポジトリ側に置く。docs/development-style.md 4.5 章のスコープ分担）。
#   - 対象セッションは ZEITREISE_LOOP_SUPERVISOR=1 付きで起動されていること
#     （SKILL.md の supervisor モード検出）。
#   - 対象セッションへプロンプトを投入するのは本スクリプトだけであること
#     （人が並行して介入すると idle 検知と注入が競合する）。
#
# 使い方（例）:
#   scripts/loop_supervisor.sh w5:p1
#   scripts/loop_supervisor.sh loop --cycles 2 --prompt "1+1 を計算して"
#
# 引数:
#   <target>            herdr agent の対象（pane id または agent 名）
#   --prompt TEXT       再投入するプロンプト（既定: /agent-loop）
#   --cycles N          N サイクル完了で停止（既定: 0 = 無限。Ctrl-C で停止）
#   --min-interval SEC  サイクルの最短間隔（既定: 300）。全タスク完了後の
#                       空イテレーション（next-tasks 空 → 即 idle）が
#                       busy loop 化して課金し続けるのを防ぐ
#   --clear-delay SEC   /clear 注入後、再投入までの待機（既定: 5）
#   --boundary-poll SEC 境界と判定できなかった場合の再確認間隔（既定: 30）
#   --no-boundary-check claim タグによる境界の裏取りを無効にする（--prompt で
#                       ループ以外を回すスモークテスト用。常用しない）
#
# 実測済みの注意点（AC1 の実験。docs/adr/0036 参照）:
#   - /clear はローカル実行でモデルターンを起こさないため --wait を付けない
#     （付けると状態遷移が観測されず agent_prompt_stalled になる）。
#   - 投入直後 5 秒以内に working へ遷移しない場合も agent_prompt_stalled に
#     なる。起動直後のセッションでは投入自体が取りこぼされるレースを実測
#     したため、再投入はリトライする。
#   - ターンを終えて入力待ちに戻ったセッションの settled 状態は idle では
#     なく **done** と報告される（実測）。境界待ちと完了待ちはどちらも
#     `--until idle --until done` で待つ。**blocked（許可待ち等の HITL）は
#     意図的に含めない**: blocked のセッションに /clear を注入すると保留中の
#     状態を破壊するため、supervisor は blocked では待ち続ける（人が解消
#     するまで再投入しない）。
#   - **idle/done だけでは境界と判定できない**（Issue #374 で実測）。ループは
#     CI 監視に Monitor ツールを使い、Monitor を張るたびにターンを終えて idle に
#     なるため、イテレーション途中の idle が普通に観測される。上の「settled は
#     done」はダミーセッションでの実測で、Monitor を使う実ループには当てはまら
#     ない。そこで /clear 注入前に、SKILL.md の境界定義「進行中 claim ゼロ」を
#     `git ls-remote --tags origin 'refs/tags/claim/*'` で裏取りする。取得に
#     失敗した場合も境界とはみなさない（/clear を注入しない側に倒す）。

set -u

MAX_PROMPT_ATTEMPTS=3

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

usage() {
  # 先頭のコメントブロックをそのまま usage として出す（行番号を固定すると
  # ヘッダを増やすたびに切れるため、最初の非コメント行までを読む）
  awk 'NR > 1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"
  exit "${1:-0}"
}

TARGET=""
PROMPT="/agent-loop"
CYCLES=0
MIN_INTERVAL=300
CLEAR_DELAY=5
BOUNDARY_POLL=30
BOUNDARY_CHECK=1
CLAIM_REMOTE=origin
REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help) usage 0 ;;
    --prompt)
      [ $# -ge 2 ] || die "--prompt requires a value"
      PROMPT="$2"
      shift 2
      ;;
    --cycles)
      [ $# -ge 2 ] || die "--cycles requires a value"
      CYCLES="$2"
      shift 2
      ;;
    --min-interval)
      [ $# -ge 2 ] || die "--min-interval requires a value"
      MIN_INTERVAL="$2"
      shift 2
      ;;
    --clear-delay)
      [ $# -ge 2 ] || die "--clear-delay requires a value"
      CLEAR_DELAY="$2"
      shift 2
      ;;
    --boundary-poll)
      [ $# -ge 2 ] || die "--boundary-poll requires a value"
      BOUNDARY_POLL="$2"
      shift 2
      ;;
    --no-boundary-check)
      BOUNDARY_CHECK=0
      shift
      ;;
    -*) die "unknown option: $1" ;;
    *)
      [ -z "$TARGET" ] || die "unexpected argument: $1 (target already set: $TARGET)"
      TARGET="$1"
      shift
      ;;
  esac
done

[ -n "$TARGET" ] || usage 1
for n in "$CYCLES" "$MIN_INTERVAL" "$CLEAR_DELAY" "$BOUNDARY_POLL"; do
  case "$n" in
    '' | *[!0-9]*)
      die "--cycles / --min-interval / --clear-delay / --boundary-poll must be non-negative integers"
      ;;
  esac
done

command -v herdr > /dev/null 2>&1 ||
  die "herdr CLI not found; run on the herdr host (see docs/development-style.md 4.5)"

if [ "$BOUNDARY_CHECK" -eq 1 ]; then
  command -v git > /dev/null 2>&1 ||
    die "git not found; required for the boundary check (pass --no-boundary-check to skip)"
fi

# 進行中の claim タグの本数を返す。取得に失敗したら "error" を返す（境界と
# みなさない = /clear を注入しない側に倒す）。
claim_count() {
  local out status
  out=$(git -C "$REPO" ls-remote --tags "$CLAIM_REMOTE" 'refs/tags/claim/*' 2>/dev/null)
  status=$?
  if [ "$status" -ne 0 ]; then
    printf 'error\n'
    return 0
  fi
  printf '%s\n' "$out" | grep -c 'refs/tags/claim/'
}

# イテレーション境界まで待つ。herdr の idle/done だけでは足りない: ループは CI 監視に
# Monitor ツールを使い、Monitor を張るたびにターンを終えて idle になるため、
# イテレーション途中でも idle が観測される（Issue #374 で実測。ADR-0036 の
# 「settled は done」という実測はダミーセッションで取ったもので実ループには
# 当てはまらない）。SKILL.md の境界定義「進行中 claim ゼロ」を外部状態で裏取りする。
wait_for_boundary() {
  local label="$1" claims
  while :; do
    herdr agent wait "$TARGET" --until idle --until done > /dev/null ||
      die "herdr agent wait failed (target gone?)"
    [ "$BOUNDARY_CHECK" -eq 1 ] || return 0
    claims=$(claim_count)
    case "$claims" in
      0) return 0 ;;
      error)
        log "${label}: claim タグを取得できない（remote=${CLAIM_REMOTE}）。境界と判定せず ${BOUNDARY_POLL}s 後に再確認する"
        ;;
      *)
        log "${label}: claim タグが ${claims} 本残っている（Monitor 由来の idle とみなす）。${BOUNDARY_POLL}s 後に再確認する"
        ;;
    esac
    sleep "$BOUNDARY_POLL"
  done
}

trap 'log "interrupted; exiting"; exit 130' INT TERM

cycles_label="$CYCLES"
[ "$CYCLES" -gt 0 ] || cycles_label="infinite"
log "supervising target=${TARGET} prompt=${PROMPT} cycles=${cycles_label}"
cycle=0
while :; do
  cycle_start=$(date +%s)

  log "cycle $((cycle + 1)): waiting for iteration boundary (idle/done + claim ゼロ)"
  wait_for_boundary "cycle $((cycle + 1))"

  log "cycle $((cycle + 1)): boundary detected; injecting /clear"
  # /clear はモデルターンを起こさないため --wait なし。stalled 相当の
  # 失敗は無視してよい（実際の投棄は次の再投入前の画面で確認できる）。
  herdr agent prompt "$TARGET" "/clear" > /dev/null 2>&1 || true
  sleep "$CLEAR_DELAY"

  log "cycle $((cycle + 1)): reinjecting prompt and waiting for completion"
  attempt=1
  until herdr agent prompt "$TARGET" "$PROMPT" --wait --until idle --until done > /dev/null; do
    if [ "$attempt" -ge "$MAX_PROMPT_ATTEMPTS" ]; then
      die "prompt injection failed ${MAX_PROMPT_ATTEMPTS} times; giving up"
    fi
    attempt=$((attempt + 1))
    log "prompt injection stalled; retrying (${attempt}/${MAX_PROMPT_ATTEMPTS})"
    sleep 5
  done

  cycle=$((cycle + 1))
  log "cycle ${cycle}: iteration completed (idle again)"

  if [ "$CYCLES" -gt 0 ] && [ "$cycle" -ge "$CYCLES" ]; then
    log "reached --cycles ${CYCLES}; exiting"
    break
  fi

  elapsed=$(($(date +%s) - cycle_start))
  if [ "$elapsed" -lt "$MIN_INTERVAL" ]; then
    rest=$((MIN_INTERVAL - elapsed))
    log "cycle took ${elapsed}s (< min-interval ${MIN_INTERVAL}s); sleeping ${rest}s"
    sleep "$rest"
  fi
done
