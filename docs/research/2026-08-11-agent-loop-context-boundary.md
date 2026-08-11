# agent-loop のコンテキスト境界方式の調査（#232）

- 日付: 2026-08-11
- 起票: Issue #232（方式 (a) イテレーション境界での投棄 vs (b) 1 タスク = 1
  subagent の決定）
- 手法: 実際の agent-loop セッション（本日、9 タスク完了・2h39m）上での
  実地実験と transcript 実測

## 結論（AC4）

**方式 (a) の選択肢 3「外部からの再投入」を採用することを推奨する。**
実現に必要なプリミティブは Phase 1 のホスト環境（Mac mini + herdr）に
すべて実在し、本セッション自身への注入で動作を実測済み。方式 (b) は
ネスト自体は可能だが、孫 subagent の完了通知が中間層に届かない制約が
「実装 subagent 並列 + mainagent レビュー」の成立を妨げるため推奨しない。

## AC1: 外部再投入の可否 — **可**（実測）

Phase 1 の実行環境（`docs/development-style.md` 4.5 章の pod 前提は
k8s-lab 再構成で乖離しており、実態は Mac mini ホスト直 + herdr。#226）で
以下を実測した。

- `herdr agent list` が実行中の claude セッションを
  `agent_session.value = <session id>` / `agent_status`（working / idle 等）
  付きで列挙する。本セッション自身が観測対象として見えた。
- `herdr agent prompt <TARGET> <TEXT>` で外部からプロンプトを投入できる。
  本セッション（working 状態）へマーカーを注入したところ、実行中ターンの
  途中にユーザーメッセージとして到達した。
- `herdr agent wait <TARGET> --until idle --timeout <ms>` で状態待ちができる。
- headless 起動（`claude -p "..."`）も動作する（haiku で往復 3.0 秒）。

これらを組み合わせた supervisor は次の形で組める:

```
while true; do
  herdr agent wait <pane> --until idle          # イテレーション完了を待つ
  herdr agent prompt <pane> "/clear"            # コンテキストを捨てる
  herdr agent prompt <pane> "/agent-loop"       # ループを再投入する
done
```

運用上の制約（実測から判明）:

- working 中の注入はターン途中に割り込むため、**注入は必ず idle を待って
  から行う**。
- `/clear` がスラッシュコマンドとして解釈されるかは本セッションでは
  検証できない（自セッションのコンテキストを破壊するため）。**ダミー
  セッションでの検証を後続タスクの最初の手順とする**。解釈されない場合の
  代替は「セッションを終了させて headless / 新規セッションを起動する」
  方式で、こちらも `claude -p` の動作確認済み。

## AC2: subagent ネストの可否 — **可（ただし通知に重大な制約）**（実測）

subagent から Agent tool でさらに subagent を起動する実験の結果:

- **name 付き（teammate）のネストは不可**: 「Teammates cannot spawn other
  teammates — the team roster is flat」で拒否される。
- **無名 subagent のネストは可**: `isolation: "worktree"` も受理され、孫は
  専用 worktree（`.claude/worktrees/agent-*`、git-dir ≠ git-common-dir）で
  実行された。完了後の worktree 自動削除も正常。
- **孫の完了通知が中間層（子）に届かない**: 孫は約 30 秒で正常完了して
  いたが、子への自動完了通知は約 12 分待っても届かず、SendMessage の返信も
  数ターン遅れで到着した。確実な結果回収は孫の transcript ファイルの直接
  読取のみだった。

含意: 方式 (b) で「タスク実行者 = subagent」がさらに実装 subagent を並列
起動する構成は、技術的には組めるが**完了検知をファイルポーリングで自作する
必要があり**、沈黙 = 未完了と誤認するリスクが常在する。SKILL.md 手順 2 の
並列実装 + レビュー分離をこの上に載せるのは運用リスクが大きい。

## AC3: T・R の実測（試算パラメータの検証）

対象: 本日の agent-loop セッション transcript（8.73 MB / 254 リクエスト、
9 タスク完了時点）。集計の詳細と注意点は下記「計測方法」。

| 指標 | Issue の試算 | 実測 | 比 |
|---|---|---|---|
| T（mainagent ターン/タスク） | 40 | **25.3** | 0.63 |
| R（永続残骸/タスク） | 30K tok | **40.9K tok** | 1.36 |

- コンテキストは 47.2K → 455.5K tok へ**単調増加**（compaction 発生なし）。
  タスクあたりの増分は並列立ち上げ期 32.9K、その後 49.6K / 29.4K / 15.2K /
  10.0K / 4.8K と分散が大きい。
- **R の最大内訳は mainagent 自身の thinking（約 15K tok/タスク、3 割強）**。
  次いで tool_result（7.2K、うち Bash が支配的）、tool_use 入力（6.7K）、
  subagent 最終報告（3.0K、最大 1 件 12.5K 文字）。
- subagent 側は 19 本・594 ターン・peak context 総和 1.89M tok。**作業
  ターンの約 7 割が親のコンテキスト外**で起きており、委譲による圧縮は既に
  機能している。残る支配項はイテレーションをまたぐ N² の蓄積で、これは
  (a) だけが消せる。
- 実測値での再試算（B=47K・T=25.3・R=40.9K・N=10）: 現状 約 64M に対し
  (a) 約 17M（約 3.7 分の 1）。試算の順序関係（(a) の優位）は実測でも維持
  され、(b) の追加利得が 1 割強に留まる関係も変わらない。

### 計測方法の注意点

- ターン = distinct requestId（assistant 行は content block 単位に分割される
  ため行数では数えない）。タスク数 = マージ済み PR 数（9）。
- JSONL のバイト数はコストの代理にならない（PNG 5 枚 = 2.96MB だが実コスト
  約 9K tok。逆に thinking はほぼ 0 バイトだが最大の残骸）。
- usage 全ゼロの中断ターン 1 件を除外して成長曲線を算出。
- thinking の内訳値のみ「出力トークン − 可視コンテンツ換算」による推定。
  R の総量 40.9K は usage 実測。
- 中間集計 TSV は再生成可能な中間生成物としてセッション scratchpad に
  置いた（コミットしない。再現はこのレポート記載の方法で transcript から
  集計し直す）。

## 推奨の根拠まとめ

1. (a) は支配項（N² 蓄積）を消す唯一の方式で、実測パラメータでも約 3.7 倍の
   削減。必要なプリミティブ（herdr agent wait / prompt、headless CLI）は
   すべて実在・動作確認済み。agent-loop は永続状態を全て外部化済み
   （claim タグ / Issue コメント / git）でコールドスタート設計が完成している。
2. (b) はネスト可否こそ「可」だが、孫の完了通知が届かない制約により
   実装並列 + レビュー分離の現行プロトコルを自作ポーリングで置き換える
   必要があり、リスクに対して追加利得（(a) 比 1 割強）が見合わない。
   CLAUDE.md の役割分担（実装 = subagent / レビュー = mainagent）との
   衝突・エスカレーション上限カウンタの可視性低下という Issue 記載の
   懸念も実験で否定できなかった。
3. 副次的知見: R の 3 割は thinking であり、テスト出力削減（#230 で実施済み）
   だけでは減らない。境界での全量投棄（a）が効く構造になっている。

## 後続作業（AC6 で起票）

1. supervisor 実装タスク: ダミーセッションでの `/clear` 注入検証 →
   ホスト側 supervisor スクリプト（herdr wait/prompt のループ）→ SKILL.md
   手順 7 に「イテレーション終端でのハンドオフ（進行中 claim なしを確認して
   idle になる）」を追記 → development-style 4.3 章の「同一セッションが継続」
   の改訂（ADR 化を含む）。
