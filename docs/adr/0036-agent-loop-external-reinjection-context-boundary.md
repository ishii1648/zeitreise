---
status: accepted
date: '2026-08-12'
---

# decision-36: agent-loop のコンテキスト境界は supervisor の外部再投入（idle 検知 → /clear → /agent-loop）で設ける

## Context

agent-loop はマージ後も同一セッションが次タスクを継続するため、
イテレーションをまたいでコンテキストが単調増加する。実測
（`docs/research/2026-08-11-agent-loop-context-boundary.md`。Issue #232）では
1 タスクあたりの永続残骸 R ≒ 40.9K tok、9 タスクで 47K → 455K tok に達し、
蓄積は残タスク数 N に対して N² で課金される。残骸の最大内訳は mainagent
自身の thinking（約 3 割）で、テスト出力削減（#230）や調査 subagent 委譲
（#231）では消えない。同調査は方式 (a)「イテレーション境界での投棄」が
支配項を消す唯一の方式であり（実測パラメータで約 3.7 分の 1）、方式 (b)
「1 タスク = 1 subagent」は孫 subagent の完了通知が届かない制約により
現行の実装並列 + mainagent レビューを危険にすると結論した。

実装（Issue #258）に先立ちダミー claude セッションで実測した結果:

- `herdr agent prompt <target> "/clear"` は**スラッシュコマンドとして解釈
  され、コンテキストを実際に投棄する**（注入前に覚えさせた合言葉が注入後に
  想起不能になることを確認）。よって「セッション終了 → 新規起動」方式は
  不要。
- ターン終了後のセッションの settled 状態は `idle` ではなく **`done`** と
  報告されるため、境界待ちは `--until idle --until done` で行う。

  > **追記（2026-08-15、Issue #374）**: この実測はダミー claude セッションで
  > 取ったもので、**実ループには当てはまらない**。ループは CI・mergeability の
  > 監視に Monitor ツールを使い、Monitor を張るたびにターンを終えて `idle` に
  > なるため、**イテレーション途中の `idle`／`done` が普通に観測される**
  > （実測 2 回。claim タグ 4 本・PR 未マージ・subagent 走行中の状態で `idle`
  > が返った）。したがって herdr の状態だけでは境界を判定できず、そのまま
  > `/clear` を注入するとイテレーション途中のコンテキストを破壊する。
  > `scripts/loop_supervisor.sh` は `/clear` 注入前に、下記 Decision の境界定義
  > 「進行中 claim ゼロ」を `git ls-remote --tags origin 'refs/tags/claim/*'`
  > で裏取りするようになった（取得失敗時も境界とみなさない）。
- `/clear` はモデルターンを起こさないため `--wait` を付けると
  `agent_prompt_stalled` になる（付けない）。また起動直後のセッションでは
  投入自体が取りこぼされるレースを観測した（再投入はリトライで吸収する）。

## Decision

**イテレーション境界（進行中 claim ゼロ + bug intake 完了）でセッションの
コンテキストを全量投棄し、ホスト側 supervisor が `/agent-loop` を再投入する
方式（調査レポートの方式 (a) 選択肢 3「外部からの再投入」）を採用する。**

- **投棄の手段は `/clear` 注入**（実測で解釈・投棄を確認済み）。セッション
  再起動方式は採らない。
- **supervisor は `scripts/loop_supervisor.sh` としてリポジトリ側に置く**。
  `herdr agent wait --until idle --until done` → `/clear` 注入 →
  `/agent-loop` 再投入（完了待ち付き）のループで、blocked（HITL）では
  投棄しない。4.5 章のスコープ分担では、ホスト管轄（dotfiles / k8s-lab）は
  ホスト構築（herdr の導入・常駐等）であり、supervisor は agent-loop の
  イテレーション境界の意味論（何を・いつ投入するか）を実装する開発フロー
  側の道具なので、SKILL.md と同一リポジトリで共進化させる。
- **supervisor の有無は環境変数 `ZEITREISE_LOOP_SUPERVISOR=1` で宣言する**
  （セッション起動時に設定。herdr 配下かの自動検出は「herdr 配下だが
  supervisor なし」と区別できないため使わない）。セット時のみ、セッションは
  イテレーション境界で次の集合判定へ進まずターンを終えて idle になる。
  未セット時は従来どおり同一セッションで継続する（後方互換）。
- 前提はループの**コールドスタート設計**: 永続状態（claim タグ・Issue
  本文/コメント・git・PR）はすべて外部化済みで、再投入された `/agent-loop`
  は手順 1 から完全に再開できる。

却下案:

- **方式 (b)（1 タスク = 1 subagent）**: 孫 subagent の完了通知が中間層に
  届かず、完了検知の自作ポーリングが必要。追加利得も (a) 比 1 割強に
  留まる（調査レポート AC2）。
- **セッション終了 → 新規起動 + プロンプト投入**: `/clear` が解釈されない
  場合のフォールバックとして温存するが、`/clear` の動作を実測済みのため
  採らない（ペイン・権限承認状態を作り直すコストが余分）。
- **supervisor のホスト側（dotfiles / k8s-lab）配置**: 投入するプロンプトと
  境界の定義は SKILL.md の手順と密結合であり、別リポジトリに置くと
  ドリフトする。

## Consequences

- イテレーションをまたぐ N² のコンテキスト蓄積が消え、実測パラメータでは
  累計課金が約 3.7 分の 1 になる見込み（B=47K・T=25.3・R=40.9K・N=10 の
  再試算）。
- herdr 配下の運用では supervisor モードが標準になる。起動手順・終端動作・
  フェイルセーフ（supervisor 不在時は境界で idle のまま停止、環境変数なしの
  セッションへの supervisor 併用は禁止）は
  `.claude/skills/agent-loop/SKILL.md` の「supervisor モード」節が正。
- supervisor は停止条件を判定しないため、全タスク完了後は空サイクル
  （next-tasks 空 → 即 idle）が続く。busy loop 化は `--min-interval`
  （既定 300 秒）で抑え、停止は運用者が行う。escalation 後の空回りは
  セッション側の open `needs-human` チェックで防ぐ。
- 関連: Issue #232（調査）・Issue #258（実装）・ADR-0010（エスカレーション
  上限）・ADR-0012（単一セッションガード）。
