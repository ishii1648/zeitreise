#!/usr/bin/env bash
# loop_supervisor.sh — agent-loop の外部再投入 supervisor（Issue #258 / ADR-0036）
#
# herdr 配下で動く agent-loop セッションをホスト側から監視し、
#   1. `herdr agent wait <target> --until idle --until done` で
#      イテレーション境界（ターン終了）を待つ
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
  sed -n '2,47p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

TARGET=""
PROMPT="/agent-loop"
CYCLES=0
MIN_INTERVAL=300
CLEAR_DELAY=5

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
    -*) die "unknown option: $1" ;;
    *)
      [ -z "$TARGET" ] || die "unexpected argument: $1 (target already set: $TARGET)"
      TARGET="$1"
      shift
      ;;
  esac
done

[ -n "$TARGET" ] || usage 1
for n in "$CYCLES" "$MIN_INTERVAL" "$CLEAR_DELAY"; do
  case "$n" in
    '' | *[!0-9]*) die "--cycles / --min-interval / --clear-delay must be non-negative integers" ;;
  esac
done

command -v herdr > /dev/null 2>&1 ||
  die "herdr CLI not found; run on the herdr host (see docs/development-style.md 4.5)"

trap 'log "interrupted; exiting"; exit 130' INT TERM

cycles_label="$CYCLES"
[ "$CYCLES" -gt 0 ] || cycles_label="infinite"
log "supervising target=${TARGET} prompt=${PROMPT} cycles=${cycles_label}"
cycle=0
while :; do
  cycle_start=$(date +%s)

  log "cycle $((cycle + 1)): waiting for idle/done"
  herdr agent wait "$TARGET" --until idle --until done > /dev/null ||
    die "herdr agent wait failed (target gone?)"

  log "cycle $((cycle + 1)): idle detected; injecting /clear"
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
