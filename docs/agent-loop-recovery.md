# agent-loop の単一セッションガードと暴走ジョブ復旧手順

2026-07-24〜25 に発生した「対話セッションを kill してもループが継続する」
インシデントの記録と、再発時の検知・停止・復旧の標準手順（TASK-59・ADR-0012）。

## 0. 前提環境と手順の読み方

本手順は現行の **Phase 1**（Mac mini のホスト直・端末多重化は **herdr**・実装と
intake が単一 claude セッション）を前提とする（`docs/development-style.md` 4.5
章）。Phase 3 で実装セッションが pod へ戻ると多重化まわりの前提が変わる
ため、2〜4 章の各手順には次の分類を付けてある。

- **[非依存]** 端末多重化ツールに依存しない手順。見るのは claude の daemon /
  ジョブ state と git の remote だけなので、Phase が変わってもそのまま使える。
  **暴走ジョブの停止に必須なのはこちら**である。
- **[herdr]** 現行の多重化ツール固有の手順。対話セッション側の実行体を数え・
  止めるために使う。Phase 3 で差し替えるのはここだけでよい（4.5 章「Phase 3
  （pod 移行）で戻る構成」）。

先に押さえておくべき herdr の性質（実測。herdr 0.8.0）:

- **クライアントを落としてもホスト側の `herdr server` は生き残る**
  （`herdr session list` が `status: running` を維持する。4.5 章）。attach を
  切ることはセッションの停止ではない。
- **`herdr server` 自身が PPID 1 で常駐する。** したがって「PPID 1 だから
  多重化ツールの外にいる」という判定は成立しない。pane の中の claude は
  `herdr server` → pane の shell → `claude` という子孫関係にあり、実行体が
  どちらに属するかは 3.3 の帰属判定で決める。

## 1. 事象の概要（何が起きたか）

- `/agent-loop` を実行する Claude Code セッションが複数並走し、同一 worktree
  に対して HEAD の checkout・ブランチの reset・重複 finalization・ PR
  マージが交互に行われた。
- 対話プロセス（terminal 上の `claude`）を 3 回 kill してもループが継続した。
  正体は **daemon（PPID 1）にホストされたヘッドレスセッションジョブ**
  （`~/.claude/jobs/<id>/state.json`）で、`selfWake: true` + `session_cron`
  により自己起床し、ターン毎に短命プロセスを生成・消滅するため `ps`
  の点検では捕捉できなかった。
- ジョブは `cwd` が特定 worktree に固定されており、その worktree で `git commit`
  / `git push` / PR 作成・マージまで自律実行していた。

（2026-07 当時の記録は、この daemon を「PPID 1 なので端末多重化ツールの外に
いる」と説明していた。多重化ツールが herdr になった現在この判定条件は成立
しないため、0 章・3.3・4.1 の内容で置き換えてある。当時の原文は git 履歴と
`docs/archive/backlog-tasks/` の TASK-59 を参照。）

## 2. ループ開始・再開前の単一セッション事前チェック（必須）

`/agent-loop` の開始・再開時は、着手前に以下を確認する。痕跡があれば
ループを開始せず、ユーザーに他実行体の停止を確認する。

**[非依存]** 1〜4 はリポジトリと remote の状態だけを見るため、多重化ツールや
Phase に関係なく実行する。

1. **origin の直近 push**:
   `git for-each-ref --sort=-committerdate refs/remotes/origin | head`
   で数分以内の push がないか。
2. **直近 PR の mergedAt**: `gh pr list --state merged --limit 3` で
   数分以内のマージがないか（人間の操作速度でないマージは他ループの兆候）。
3. **reflog の異常**: `git reflog -10` に身に覚えのない checkout / merge / reset
   / commit が現れていないか。作業中も定期的に確認する。
4. **残存 file-server**: ポート 8009/8011/8012 等に古い dev サーバが
   残っていないか（`lsof -nP -iTCP:<port> -sTCP:LISTEN`）。残存サーバは
   他セッション稼働のシグナルであると同時に、**旧ビルドの配信によって
   実機スモークの誤判定を起こす**。スモーク前に配信中ビルドの検証
   （変更に含まれる DOM 要素の存在確認等）を必ず入れる。

**[herdr]** 5 は現行構成での追加確認。Phase 3 では pod 側の同等手段
（`kubectl exec` 等）に読み替える。

5. **他の対話セッション**: `herdr agent list` で claude の agent が複数
   走っていないか（JSON の各要素の `cwd` / `agent_status` / `pane_id` を見る）。
   このリポジトリの worktree を `cwd` に持つ agent が自分以外にあれば、
   ループを開始せず先に確認する。`herdr session list` で見覚えのないセッション
   が `status: running` で残っていないかもあわせて見る（クライアントを落として
   もセッションは残るため。0 章）。

## 3. 暴走実行体の検知

対話プロセスを止めてもリポジトリへの操作が続く場合は、daemon ホストの
ヘッドレスジョブを疑う。

### 3.1 daemon ジョブの検知 [非依存]

```
# ジョブ state の確認: state: "working" / selfWake: true /
# inFlight.kinds に session_cron があれば自己起床ループ
cat ~/.claude/jobs/*/state.json

# daemon がジョブを再 claim した記録（起動直後の行に注目）
tail -30 ~/.claude/daemon.log   # 例: "bg claimed-spare <id> (slash)"
```

state.json の `cwd` フィールドで、どの worktree に対して操作しているかを
特定できる。`children` には作成した PR の一覧が残る。daemon は OS 起動時では
なく claude CLI 起動時にオンデマンドで立つため、daemon が一度も動いていない
ホストでは `~/.claude/jobs/` と `~/.claude/daemon.log` 自体が存在しない
（存在しない ＝ 暴走ジョブなし）。

### 3.2 対話セッション側の実行体の棚卸し [herdr]

```
# herdr 配下で動いている agent（pane_id / cwd / agent_status が出る）
herdr agent list

# その pane の実プロセス（shell_pid と前景プロセスの pid / cmdline / cwd）
herdr pane process-info --pane <pane_id>
```

`herdr agent list` に出るのは **人が起動した対話セッション**であり、
ヘッドレスジョブはここには現れない。

### 3.3 実行体の帰属判定（暴走ジョブか、herdr セッション配下か）[herdr]

`ps` に現れた claude プロセスがどちらの実行体かは、**pane に帰属するか**で
判定する。PPID が 1 かどうかでは判定しない（`herdr server` 自身が PPID 1 の
ため。0 章）。

```
ps -axo pid,ppid,command | grep -E "claude|bg-pty-host|bg-spare" | grep -v grep
```

1. 3.2 で得た各 pane の `shell_pid` を控える。
2. 対象プロセスの親を `ps -o pid,ppid,command -p <pid>` でたどる。いずれかの
   `shell_pid`（さらにその親は `herdr server`）に到達すれば **herdr セッション
   配下の対話セッション**。どの pane の `shell_pid` にも到達せず PPID 1 へ
   抜けるなら **daemon ホストのヘッドレスジョブ**である。

停止の入口はこの判定で分かれる。前者は 4.1、後者は 4.2 で止める。

ただし**判定の権威は `ps` のスナップショットではなく 3.1 のジョブ state**で
ある。ヘッドレスジョブはターン毎に短命プロセスを作って消えるため、`ps` に
何も出ていないことは「止まっている」ことを意味しない。

## 4. 停止手順と静穏確認

### 4.1 herdr セッション配下の実行体を止める [herdr]

3.3 で pane に帰属すると判定した実行体（＝人が起動した対話セッション）は herdr
側で止める。

- 個別に終わらせる: `herdr agent attach <pane_id>` で入り、claude を通常どおり
  終了させる。
- セッションごと畳む: `herdr session stop <name>`（名前は `herdr session list`
  で引く）。**attach を切るだけでは止まらない**（0 章）。

**この操作は暴走ジョブの停止の必要条件でも十分条件でもない。** daemon は
起動元から切り離されて PPID 1 で常駐し、pane のプロセスグループに属さない。
そのため pane や herdr セッションを畳んでもヘッドレスジョブは走り続ける
（＝十分条件でない）。逆に、暴走ジョブを止めるだけなら herdr セッションを
畳む必要はなく 4.2 だけで足りる（＝必要条件でもない）。多重化側の操作は
「並走している対話セッション・残った空 shell の掃除」として意味を持つ。

`scripts/loop_supervisor.sh` を動かしている場合は、**supervisor を先に止める**
（実行中のシェルで Ctrl-C）。supervisor は対象 pane へ `/clear` と `/agent-loop`
を再投入し続けるため、セッションを先に止めても再投入とレース
する（ADR-0036・`docs/development-style.md` 4.3 章）。

### 4.2 daemon ジョブを止める（暴走ジョブの停止本体）[非依存]

1. **daemon 本体と bg ホスト群を kill する**:
   `ps -axo pid,command | grep -E "claude daemon|bg-pty-host|bg-spare"` で PID
   を特定し kill する。**bg-pty-host は SIGTERM を無視することが
   あるため、残った場合は SIGKILL（`kill -9`）を使う。**
2. **ジョブ state を無効化する**: daemon は claude CLI の起動時に
   `~/.claude/jobs/` の既存ジョブを再 claim するため、プロセスを殺した
   だけでは次の CLI 起動で復活する。該当ディレクトリをリネームして
   無効化する（削除せず可逆にする）:
   `mv ~/.claude/jobs/<id> ~/.claude/jobs/<id>.disabled`

### 4.3 静穏確認

**[非依存]**

1. `git ls-remote origin | sort` のスナップショットを取り、数分後に diff して
   **リモート ref が一切動いていないこと**を確認してから安全宣言する。
2. `~/.claude/jobs/` に新規ディレクトリが増えていないこと・daemon プロセスが
   再出現していないことを確認する。

**[herdr]**

3. `herdr agent list` に見覚えのない agent（特に `cwd` がこのリポジトリの
   worktree を指すもの）が増えていないこと、`herdr session list` に
   `status: running` の想定外セッションが無いことを確認する。

## 5. 経路の切り分け（調査済み）

- **launchd**: claude 関連の常駐エントリは存在しない（`launchctl list`）。
  daemon は OS 起動時ではなく claude CLI 起動時にオンデマンドで立つ。
- **crontab**: OS の crontab にはループ関連エントリはない。自己起床は ジョブ
  state 内の `session_cron` で完結している。
- **端末多重化（herdr）**: 暴走ジョブの停止という意味では**必要条件でも十分
  条件でもない**（4.1）。一方で、並走している対話セッションの検知（2 章 5・
  3.2）と掃除には必要であり、「無関係」ではない。

なお、`claude --resume` で該当会話を手動再開すればループは再始動しうる。
無効化したジョブ state を元に戻した場合も同様（自動では起きない）。

## 6. subagent の git 操作制約（再発防止）

worktree isolation で起動した実装 subagent が、シェルの cwd リセットに
よって**親リポジトリのチェックアウト中ブランチへ誤コミット・誤 push する**
事故が実際に発生した（TASK-54 で中間版が push され、レビュー済み最終版と
競合した）。subagent への指示には以下を必ず含める:

- git 操作・ファイル編集は**自分の worktree 内のみ**。`git -C` で他パスを
  指定しない。
- **push は禁止**（push とマージは mainagent が行う）。
- コミット前に `pwd` と `git branch --show-current` を確認する。
