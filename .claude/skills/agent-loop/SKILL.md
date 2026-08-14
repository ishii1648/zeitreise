---
name: agent-loop
description: GitHub Issue の次タスクを決定的に選択し、claim タグで着手を宣言して実装から finalization までを人の介入なしで繰り返すローカル自律ループ。ユーザーが /agent-loop を実行したとき、または自律タスクループの開始・再開を指示したときに使う。
---

# agent-loop — 自律タスクループ（ローカル実行）

ローカルの Claude Code セッション自身が外側ループの実行主体となり、以下を
繰り返す。GitHub Actions からセッションを起動する方式は用いない。CI や PR の
ステータスはこのセッションが Monitor ツールや PR activity
購読（MCP）で監視する。

タスクの単一ストアは GitHub Issue である（`docs/adr/0031`。`backlog` CLI は
使わない）。状態の扱いは次の 2 層で固定する:

- **着手の権威 = claim タグ**: origin の `refs/tags/claim/issue-<N>`。タグ ref
  への push は既存タグがあるとサーバ側で拒否されるため、push
  の成否がそのままアトミックな二重着手ガード（compare-and-swap）になる。
- **`status:in-progress` ラベル = advisory 表示**: 人間向けの見た目であり
  権威ではない。ラベルと claim の不一致は `deno task loop-doctor` が検出・
  修復する。

## 調査フェーズの subagent 委譲（結論のみ受け取る）

実装（手順 2）に加え、使い捨ての重い調査フェーズ — 手順 3 の CI red 原因
調査・手順 4 の動作確認・手順 7 の bug intake の重複確認と本文起草 — は
**読み取り・調査のみの subagent に委譲し、mainagent は結論のみを受け取る**
（#231）。生ログや走査結果を親のコンテキストに入れると、用が済んだ後も
以降の全ターンで再課金される（実測では 1 タスクの永続残骸 R ≒ 40.9K tok、
tool_result の支配項は Bash 出力。
`docs/research/2026-08-11-agent-loop-context-boundary.md`）。

- これらの subagent はリポジトリのファイルを編集しないため
  `isolation: "worktree"` は**付けない**（付けるのは実装 subagent だけ。
  起票草案などの一時ファイル作成は repo 外なので読み取り専用扱いのまま）。
- **返却インターフェースが要**: 親は返ってきた要約だけで後続（bug intake・
  後始末・次の集合判定）を進める。各手順に定める**返却項目**を subagent への
  指示に必ず含める。返却が不足していたら親が生ログを読み直すのではなく、
  同じ subagent に追加で問い合わせる（SendMessage）。親が調べ直したら
  削ったトークンを取り戻してしまう。
- **外向き操作（`gh issue create` / push / マージ）と、
  `docs/development-style.md` 4.4.1 章のエスカレーション上限のカウンタ追跡
  （CI red 連続回数・実装 subagent 試行回数・経過時間・停滞検出）は引き続き
  mainagent が担う**。subagent はカウンタを持たず、事実（何回目の red に
  相当する失敗か・失敗内容が前回と同一か等）を返すだけにする。

## ループ手順

1. **着手可能なタスク集合の判定**
   - まず origin の claim 一覧を確認する:
     `git ls-remote origin 'refs/tags/claim/issue-*'`。claim された open Issue
     が 「進行中タスク」であり、あればそれを現在タスク（複数あれば現在の集合）
     として再開する（ブランチ・PR の状態を調べ、中断地点から続きを行う）。
     再開時、実装プランのコメントに並列化判定が記録されていなければ追記して
     から続行する。進行中タスクが残っている間は新たな集合判定を開始しない
     （イテレーション境界の明確化）。他セッションが claim
     しているタスクには触らない。
   - なければ `deno task next-tasks` で着手可能なタスク集合（area が互いに素な
     タスク群。`docs/development-style.md` 4.2 章）を判定する。ID は Issue 番号
     由来の `#N` 形式で返る。集合が空なら着手可能なタスクがないためループを
     終了し、最終レポートを出力する。
   - 集合が複数タスクの場合: 各タスクについて claim push と実装プランの記録
     （手順 2）を行い、個別ブランチ `issue-<N>-slug` を**いずれも main から
     分岐**して作成し、実装 subagent を worktree isolation
     で並列起動する。タスクごとに個別 PR を作成する（1 タスク = 1 PR）。
     並列実行中も 1 タスク = 1 PR・bug intake・エスカレーション基準（手順
     6）は不変。
   - 対象タスクのブランチ `issue-<N>-*` が既に origin に存在する場合は状態を
     調査し、再開できるなら再開、判断が必要なら手順 6 のエスカレーションに従う。
2. **標準タスクフローの実行**（CLAUDE.md / docs/development-style.md に従う。
   集合内の各タスクにそれぞれ適用する）
   - **着手宣言 = claim push（権威）**:
     `git push origin main:refs/tags/claim/issue-<N>`。
     - 成功したらこのセッションが着手権を持つ。続けて advisory 表示として
       `gh issue edit <N> --add-label status:in-progress` を行う（ラベル付与の
       失敗は着手を無効にしない。loop-doctor が後で整合させる）。
     - **拒否された（タグが既に存在する）ら他セッションが着手済み**。その Issue
       はスキップして集合の残りを続行する。claim タグへの force push は
       いかなる場合も行わない。
   - 実装プラン（**並列化判定**を必須項目として含む）は Issue
     コメントに投稿する（`gh issue comment <N> --body-file <path>`）。Issue
     本文の read-modify-write は finalization の AC チェック 1 回だけに限る
     （本文編集の競合窓を最小化するため。Implementation Plan / Notes / Final
     Summary はすべてコメント）。
   - 並列化判定: タスクを独立サブ作業（互いにファイル競合・実行順依存がなく、
     独立にテスト可能な単位。例: 独立モジュール群、データ変換とテスト
     フィクスチャ、実装とドキュメント）に分割できるか列挙する。
   - 独立サブ作業が 2 つ以上あれば subagent を並列起動（worktree isolation）し、
     subagent ごとの担当範囲・成果物の分担表をプランに書く。
   - 並列化しない場合は「並列化判定: 見送り（理由: …）」を明記する。判定の
     無記載はプラン不備としてレビューで差し戻す。
   - ブランチ `issue-<N>-slug` を main から作成し、テスト先行（red 確認 →
     green）で実装する。default branch（main）上では作業しない。実装は subagent
     に委譲し、mainagent がレビューで収束させる。並列化判定で並列可と
     した場合は分担表に従い subagent を並列に複数起動し、worktree isolation で
     衝突を避ける（成果物の conflict は PR で解消する）。
   - **subagent の成果の取り込みと worktree の復元**: subagent には「commit /
     push はしない。ファイル変更のみ行い報告する」と指示しているため、成果は
     mainagent が worktree からパッチとして取り出してタスクブランチへ適用する。
     取り出したら**その場で worktree を元の状態へ戻す**（`<wt>` = subagent の
     worktree パス。`git worktree list` で確認できる）:
     1. `git -C <wt> add -A`（untracked も差分に含める）
     2. `git -C <wt> diff --binary --cached > <patch>` でパッチ化し、タスク
        ブランチ側で `git apply <patch>` して内容をレビューする
     3. **`git -C <wt> reset --hard HEAD && git -C <wt> clean -fd`**（`-x` は
        付けない。ignored ファイルが残っていても `git worktree remove` は通る）
   - この復元を省くと subagent worktree は未コミットの変更を抱えたまま残り、
     手順 5 の `git worktree remove` が dirty 拒否で一切進まなくなる （TASK-118
     の実測: 8 件すべて拒否・`worktree-agent-*` が 9 本残存）。 復元は「常態の
     dirty」を消すためのものであり、取り出し済みのパッチの
     複製を捨てるだけなので失われる成果は無い。
   - ループ内のローカルテスト検証（red 確認・green 確認とも）は素の
     `deno test` ではなく **`deno task test:quiet`** を使う（dot reporter +
     `NO_COLOR=1`。green 時出力は約 4KB で通常 reporter の 136 分の 1。#230）。
     失敗時も ERRORS 節に失敗テスト名・ファイル:行・アサーション差分・
     スタックが出るため、通常 reporter での再実行は不要である。CI
     （`.github/workflows/ci.yml`）は人が読む場なので reporter を変えない。
   - `deno task fmt:ci --check` / `deno lint` / `deno task test:quiet` /
     `deno task build` を全て green にしてから PR を作成する。fmt は素の
     `deno fmt` ではなく **`deno task fmt:ci`**（CI ピン留め版 deno を
     ダウンロード・キャッシュして実行する scripts/fmt_ci.ts）を使う。
     ローカル deno と CI ピン留め版とで fmt 正準形が異なり（index.html /
     app.css / md。#262）、素の fmt では green でも CI red になりうる。CI の
     バージョンを更新して揃える案は、全ファイル再整形の大差分とローカル
     更新のたびの再ドリフトを伴うため見送った（#262 AC2）。**PR 本文に `Closes #<N>` を必ず含める**
     （タイトルにも Issue 番号を明記する）。マージ時の自動クローズが Done
     遷移の実体なので、`Closes #<N>` の欠落は「マージしても Issue が open の
     まま残る」不整合に直結する（loop-doctor の検出対象）。
3. **CI 監視とマージ**
   - PR activity 購読（subscribe_pr_activity 等の MCP）が使える場合は購読する。
   - CI の完了は Monitor ツール（例: PR の check-runs をポーリングし、 success /
     failure / cancelled など終端ステータスを検知したら通知する
     スクリプト）で監視する。フォアグラウンドの sleep 待ちはしない。
   - 複数 PR を並列に進めている場合も Monitor スクリプトは**単一**にまとめ、
     全対象 PR の check-runs と mergeability（`mergeable` /
     `mergeStateStatus`）を対象にして、どれかの PR が終端ステータスに
     なるたび通知させる。ready（CI green かつ mergeable）になった PR から順に
     finalization → マージする。ある PR のマージにより他 PR が `BEHIND` /
     `CONFLICTING` になったら、後述の既存手順（main をタスクブランチに取り込み →
     再 push → CI green 再確認）で解消してから次の PR をマージする。
   - 監視は check-runs だけでなく
     mergeability（`gh pr view --json
     mergeable,mergeStateStatus`）も必ず対象にする。conflict
     中の PR は pull_request の CI 自体が走らず check-runs
     監視は沈黙し続けるため、 check-runs のみの監視は「conflict
     の検知漏れ」を起こす（禁止）。
   - `CONFLICTING` / `DIRTY` を検知したら、main をタスクブランチに取り込んで
     conflict を解消し（双方の変更意図を統合する。自分側を機械的に優先しない）、
     全チェック green を確認して再 push し、CI green を再確認する。
   - conflict でも CI red でもなくマージ自体がブロックされた場合 （`mergeable`
     が `false`、または `mergeStateStatus` が `BLOCKED` / `BEHIND`
     等）は、原因を分析して**自動修正の可否を切り分ける**。
     `gh pr view <PR> --json mergeable,mergeStateStatus` と、必要に応じて
     `gh api repos/:owner/:repo/branches/main/protection`
     でブランチ保護要件を確認する。
     - **自動修正可**: ループ内の操作で解消できるブロック。例）`BEHIND` （head
       branch が base に未追従・strict protection）は main を取り込んで 再 push
       し CI green を再確認すれば解消する（TASK-2 のマージで実際に
       発生し、この手順で解消した実績がある）。リポジトリ設定で auto-merge が
       無効（`enablePullRequestAutoMerge` エラー）な場合も「修正不可」では
       なく、CI green 確認後に**手動マージ**で代替する。
     - **自動修正不可**: ループ内の操作では解消できないブロック。例）branch
       protection の必須レビュー承認を満たす承認者がループ内に存在しない、
       恒常的に満たせない必須 status check、リポジトリのマージ権限が無い等。
       この場合は手順 6 のエスカレーションに従いループを停止する。
   - **CI red なら原因調査を読み取り専用 subagent に委譲する**（「調査
     フェーズの subagent 委譲」節）。`gh run view --log-failed` 等の生ログ
     （数十 KB）は subagent 側で読み、親のコンテキストに入れない。subagent
     には対象 PR / run の特定情報と、2 回目以降の red では前回 red の要約
     （原因種別・失敗テスト名）を渡し、次の**返却項目**を指定する:
     1. 原因種別（テスト失敗 / lint / fmt / build / flaky・インフラ起因）
     2. 該当ファイル:行（失敗テスト名・アサーション差分など、修正着手に
        足る最小情報）
     3. 前回 red との同一性（同一失敗の反復か・失敗内容が変化したか。
        事実のみ返し、上限判定はしない）
     4. 推奨修正（どのファイルをどう直すか）
   - 親は返却された結論を基に修正して（必要なら実装 subagent へ委譲し）再
     push し、green になるまでこのループを回す。CI red 連続回数・停滞検出
     （`docs/development-style.md` 4.4.1 章の上限）のカウント・照合は
     subagent ではなく親が行う（手順 6）。
   - CI green になったら**マージ前に finalization を完了する**:
     1. **AC チェック**（Issue 本文の read-modify-write は**この 1 回のみ**）:
        `gh issue view <N> --json body -q .body` で本文を取得し、各 AC の
        checkbox を検証結果に基づき `- [x]` に更新した本文ファイルを作って
        `gh issue edit <N> --body-file <path>` で書き戻す。検証エビデンスは
        本文に書かず、次の Implementation Notes コメントに書く。
     2. **Implementation Notes / Final Summary をコメント投稿**:
        `gh issue comment <N> --body-file <path>`（実装内容・AC ごとの検証
        エビデンス・残課題）。
     3. **decision 記録の判定**: このタスクで下した判断に**タスク横断で影響
        するもの**（データソース採用・ライセンス方針・アーキテクチャ/方式
        選択・規約変更等）があれば `docs/adr/00NN-<slug>.md` を連番で直接
        作成し、`docs/adr/README.md` の一覧に行を足す（記録基準・棲み分け・
        書式は `docs/development-style.md` 2.1 章）。タスク限りの実装意図は
        Implementation Notes とコンテキストコミットに留め、ADR 化しない。
   - finalization を終えてからマージする。**Issue のクローズは PR 本文の
     `Closes #<N>` による自動クローズに任せ、明示的な `gh issue close` は
     しない**（マージとクローズの間に異常終了の窓を作らないため）。マージ後に
     Issue が open のまま残っていれば `Closes` の記述漏れ等の不整合であり、
     loop-doctor（手順 5）が `open-but-pr-merged` として検出する。検出したら
     原因（記述漏れ）を確認したうえで Issue をクローズし、以後の PR 作成時の
     `Closes #<N>` 必須を徹底する。
4. **マージ後の動作確認**
   - **動作確認の実行と問題の洗い出しは読み取り専用 subagent に委譲する**
     （「調査フェーズの subagent 委譲」節）。`deno task verify:smoke` の
     生出力や確認の試行錯誤を親のコンテキストに残さない。subagent には
     集合内の各タスクの変更点（Issue 番号・PR の要約）と、以下の実行標準
     （ヘッドレス CDP・フォールバック連鎖・注意点）を渡し、次の**返却
     項目**を指定する:
     1. 問題一覧（0 件なら「なし」と明言。各件: 再現手順・期待挙動・実際の
        挙動・発見契機（どのタスクの確認で見つかったか）。手順 7 の bug
        intake フォーマットに揃え、親が加工せず起票草案に回せる粒度にする）
     2. green 確認の要約（build / スモークの成否と、対象タスクの変更点ごとに
        何をどう確認して問題なしと判断したかを数行で）
   - 親は返却された問題一覧をそのまま保持して手順 5 へ進む（1 件ずつ調べ
     直さない）。以下の実行標準は subagent が従う内容である。
   - マージ直後、次イテレーションに進む前に `deno task build` と dev
     サーバ起動で当該タスクの変更点を実際に動かして確認する。**標準は ヘッドレス
     Chrome + CDP ハーネス（`scripts/verify/`）**による無人スモーク
     チェックとする（例: `deno task verify:smoke <dev サーバ URL>`。標準スモーク
     `scripts/verify/checks/smoke.ts` はタスク定義に含まれる）。claude-in-chrome
     拡張（可視ウィンドウ必須・ツール呼び出し毎に人間の承認確認 = HITL
     が発生する）は、ユーザーの実体感確認が必要な場合の最終手段に限定する。
     ヘッドレス実行では以下に注意する: `document.visibilityState`
     に依存する分岐は可視性に依存しないロジックへ倒すこと（ヘッドレスでも
     "visible" とは限らない）／実 GPU 描画のため `--disable-gpu`
     は付けないこと／`window.__getYear()` はアプリ初期化完了前のレースがあるため
     `waitFor` で目的の値になるまで明示的に待つこと。ヘッドレスでも確認できない
     UI（ユーザー体感が本質的に問われる場合）に限り claude-in-chrome
     へフォールバックする。
   - **Chrome を起動できない環境**（バイナリ欠如・サンドボックス等で ヘッドレス
     CDP も claude-in-chrome も使えない場合）は、ビルド成果物・
     データ出力のスモークチェック（生成物の存在・件数・スキーマ等の機械的な
     確認）で代替する。検証経路が無いことを理由にループを停止したり HITL に
     落としたりしない（TASK-64）。
   - 目視確認 AC を持つタスクは、手順 3 の finalization で AC
     をチェックする前（マージ前）に dev サーバ等で確認を済ませておく。
     このフェーズではマージ後の main 上での再確認・回帰確認を行う。
   - **Deploy workflow（本番反映）の成否も必ず確認する**（#367）。main への
     マージは Deploy workflow を起動するが、これが失敗すると main の内容が
     本番へ反映されないまま次イテレーションに進んでしまう。マージ後に
     `gh run list --workflow=deploy.yml --branch=main --limit=1` で当該
     コミットの run を特定し、`gh run watch <run-id>` / `gh run view <run-id>`
     で結論まで確認する。失敗していた場合の扱いは次のとおり:
     - **一過性の外部要因**（`Setup Deno` の CDN 障害、Cloudflare API の
       一時エラー等）は `gh run rerun <run-id> --failed` で再実行し、green を
       確認する。
     - **再実行しても解消しない**場合は、その場で hotfix せず label `bug` 付き
       Issue として起票し（手順 7 の bug intake フォーマット）、次
       イテレーションで最優先修正する。本番未反映の事実を起票本文に明記する。
   - **問題を見つけてもその場で 1 件ずつ起票しない**。subagent は確認を最後
     までやり切って問題を出し切り、親は返却された一覧を保持したまま手順 5 へ
     進む。起票は手順 7 で 手順 1
     に戻る直前にまとめて行う（後述の「bug intake」節）。集合が複数
     タスクの場合は集合内の全タスクぶんの問題を 1 つの一覧に集約する。
5. **マージ後の後始末（refs の掃除と整合性診断）**
   - **1 タスクのマージが完了するたびに**（動作確認の直後、次イテレーションに
     進む前に）`deno task cleanup-branches --apply` を実行する。1 タスク = 1
     ブランチ + subagent の worktree isolation 用ブランチ + claim タグを
     作り続けるため、後始末をしないと refs が単調増加し、ブランチ・worktree の
     状態把握や不整合調査のノイズになる（`docs/development-style.md` 4.3.3
     章）。
   - このコマンドは以下を 1 回で行う（実装は `scripts/cleanup_branches.ts`）:
     - `git fetch --prune`（GitHub の `deleteBranchOnMerge` は 2026-07-27 に
       有効化済みなので、origin 側の実体は既に消えている。残るのは リモート追跡
       ref の掃除）
     - subagent の worktree 削除（`git worktree remove` → `git worktree prune`）
     - マージ済みタスクブランチの削除（`git branch -d`）
     - **クローズ済み Issue の claim
       タグ削除**（`git push origin --delete
       refs/tags/claim/issue-<N>`。gh
       でクローズ済みと確認できた Issue の claim だけが対象で、open な Issue の
       claim（着手中の権威）と Issue 一覧に 現れない番号の claim
       は絶対に消さない）
   - **他セッションのブランチ・worktree を消さないための多重防御**（ブランチ
     削除に `-D` は使わない。git が拒否したものはスキップして skipped に
     記録される）:
     - 削除対象は loop が生成した名前のみ（ブランチ `task-<N>-*` / `issue-<N>-*`
       / `worktree-agent-*`、worktree は `.claude/worktrees/` 配下）。人手の
       `feat/*`・`docs/*` ブランチやセッション
       worktree（`<repo>@feat-*`）は対象外。
     - origin/main にマージ済みのブランチのみ削除する。
     - どこかの worktree にチェックアウト中のブランチは削除しない。
     - `locked` な worktree（実行中の subagent が保持）・自分自身の worktree は
       削除しない。
     - tip が origin/main と同一のブランチは削除しない（着手直後でまだ
       コミットが無い in-flight のタスクブランチが「マージ済み」に見えるため）。
     - open な Issue の claim タグに対応する `issue-<N>-*` ブランチと、それを
       チェックアウト中の worktree は、マージ済み判定に関わらず削除しない
       （#236。上の tip 防御は別タスクのマージで main が前進すると破れるため）。
       claim が取得できない場合（`--no-fetch` / gh 失敗）は issue ブランチ
       全体を保護する。 **並列イテレーションの途中で実行してよいのは、この claim
       保護と下の mtime 猶予が効くことを前提とする**。
   - **`--force` は取りこぼしの回収にだけ使う**（TASK-118）。手順 2 の復元を
     済ませていれば `--force` なしで消える。復元し忘れ・異常終了で dirty な
     まま残ったものを回収するため、通常の `git worktree remove` が拒否された
     場合に限り、次を**すべて**満たす worktree だけ `--force` で再試行する
     （`canForceRemoveWorktree`）:
     - `.claude/worktrees/` 配下である
     - `locked` でない（実行中の subagent が保持していない）
     - 自分自身の worktree でない
     - チェックアウト中のブランチが `worktree-agent-*` である
     - gitdir 実体（HEAD / index）の mtime が 30 分以上前である（resume 後の
       subagent は `locked` を失っていることがあるため、直近に使われた worktree
       は「実行中の可能性あり」として `--force` を見送る。#236）
   - ＝ loop が生成した使い捨ての足場だけが対象で、成果はパッチとして取り出し
     済みなので失われるものは無い。agent worktree でも detached や `issue-N-*` /
     `task-N-*` がチェックアウトされている場合は `--force` の
     対象外とし、従来どおり git の拒否を尊重して skipped に残す。
   - 出力は JSON 1 行で `refsBefore` / `refsAfter` と、`--force` で回収した
     worktree の一覧 `forced`、削除した claim タグの Issue 番号 `claimTags` を
     含む。**`refsAfter` がイテレーションをまたいで単調増加していないこと**を
     確認する。増えている場合は `skipped` の理由を読み、loop の想定外に
     ブランチが残っていないかを調べる。`forced` が毎回出る場合は手順 2 の
     worktree 復元が漏れているサインなので、そちらを直す。
   - 何が消えるか先に確かめたいときは `--apply` を外して dry-run
     （`deno task cleanup-branches`）で計画だけを出力する。ネットワークを
     使いたくない場合は `--no-fetch` を付ける（claim
     タグ掃除もスキップされる）。
   - 続けて **`deno task loop-doctor`** を実行し、Issue ベース運用の不整合
     （open なのに `Closes` 指定 PR がマージ済み / closed なのに AC 未チェック /
     claim タグ残存 / advisory ラベルと claim の不一致）を検査する。修復可能な
     もの（claim タグ削除・ラベルの整合）は `deno task loop-doctor --apply` で
     修復する。修復不可の findings（AC チェック漏れ・`Closes` 記述漏れ等）は
     原因を調べて解消し、判断が必要なら手順 6 に従う。
6. **例外時のみエスカレーション**
   - 以下のいずれかに限り、`needs-human` ラベル付き Issue（**原因・検討した
     選択肢・推奨対応**を記載。`task` ラベルは付けず選定候補に入れない）を
     起票してループを停止する。それ以外で人の指示を待たない。
     - AC が曖昧・CI が恒常 red・仕様判断が必要な場合。
     - 手順 3 で **自動修正不可** と切り分けたマージブロック（必須レビュー
       承認者の不在、恒常的に満たせない必須 status check、マージ権限不足
       等）。auto-merge 無効のようにループ内で代替手段（手動マージ）が
       あるものは「修正不可」ではないため、ここには含めない。
   - 加えて、実装難航の兆候を定量的に検知するため、`docs/development-style.md`
     4.4.1 章の**エスカレーション上限（設定値）**（CI red 連続回数・実装
     subagent 試行回数・タスク着手からの経過時間・停滞検出）のいずれか一つでも
     超過した場合は、上記の定性基準に該当するかを問わず**強制的に**
     `needs-human` issue を起票してループを停止する。値・除外条件（ブロック
     中の待機時間の扱い等）・判定手順は同章の表と手順に従う。上限値を
     変更する場合は同章の表のみを更新し、本 SKILL.md の記述は変更不要である。
7. **次イテレーション**
   - 集合内の全タスクのマージ（finalization 含む）と後始末（手順 5）が
     完了したら、**手順 1 に戻る前に**、手順 4 の動作確認で見つけた問題を
     **全件まとめて起票する**（1 件 = 1 Issue、label `task` + `bug` +
     `area:*`。フォーマットは「bug intake」節）。問題が 0 件なら委譲も
     起票も不要。
   - **重複確認と本文起草は読み取り専用 subagent に委譲する**（「調査
     フェーズの subagent 委譲」節）。`gh issue list --state all` の走査結果や
     本文の推敲過程を親のコンテキストに残さない。subagent には手順 4 の
     問題一覧を渡し、`task-intake` スキル
     （`.claude/skills/task-intake/SKILL.md`）の手順 1（重複確認）と記述規約
     （LOOP-META・Description・AC・area ラベル）に従わせ、次の**返却項目**を
     指定する:
     1. 問題ごとの重複判定（重複する既存 Issue 番号、または「なし」。部分
        重複の場合は既存 Issue の拡張か差分のみの新規起票かの判断と根拠）
     2. 起票する各件の草案ファイルパス（1 件 = 1 ファイル、repo 外の一時
        ディレクトリに置く）と、title・label 一覧（`task` + `bug` +
        `area:*`）
   - **起票の実行（`gh issue create --body-file <草案>`）は mainagent が
     行う**（外向き操作は親に残す）。親は草案の title・AC・label を確認して
     から起票し、起票後確認（task-intake 手順 6）も親が行う。
   - 起票を終えた時点が**イテレーション境界**（進行中 claim ゼロ + 起票
     完了）である。ここで supervisor モードかどうかで分岐する（判定・詳細は
     後述「supervisor モード」節）:
     - **supervisor モード**（環境変数 `ZEITREISE_LOOP_SUPERVISOR=1`）では、
       **手順 1 の集合判定へ進まず、短い境界レポート（このイテレーションで
       処理したタスク・マージした PR・起票した Issue）だけを出力してターンを
       終え、idle になる**。外部の supervisor（`scripts/loop_supervisor.sh`）
       が idle を検知して `/clear` でコンテキストを投棄し、`/agent-loop` を
       再投入する。自セッションの進行中 claim が残っている場合はまだ境界では
       ないため、supervisor モードでもターンを終えずに継続する。
     - **supervisor 不在（環境変数なし）**では従来どおり同一セッションで
       手順 1 に戻って次の集合判定を行う（後方互換）。
   - いずれの場合も、claim された進行中タスクが残っている間は集合判定を
     開始しないガードはそのまま適用する（起票はイテレーションの終わり、
     判定はその後、という順序）。

## bug intake（動作確認・ユーザー報告・`/code-review` からの起票）

**起票はフェーズ単位でバッチ化する**（規約と根拠・限界は
`docs/development-style.md` 2 章・4.2.1 章）。1 件見つけるたびに起票して次へ
進むのではなく、そのフェーズで見つけた問題を出し切ってから**全件をまとめて
起票する**。バッチでも **1 件 = 1 Issue**で起票し、複数の問題を 1 Issue に
まとめない。候補が 1 件しかなければ `next-tasks` の area 判定は原理的に働かない
ため、まとめて起票することが次イテレーションの判定機会そのものを増やす。
起票の実務手順（重複確認 → `gh issue create --body-file` →
起票後確認）は`task-intake` スキルに従う。ループ内では、このうち重複確認と
本文起草を読み取り専用 subagent に委譲し、起票の実行（`gh issue create`）と
起票後確認は mainagent が行う（手順 7・「調査フェーズの subagent 委譲」節）。

- **手順 4（マージ後の動作確認）**: ループ自身が見つけた問題はその場で修正
  せず、起票もその場では行わない。確認を最後までやり切って問題を一覧化し、
  集合内の全タスクのマージと後始末（手順 5）が終わったあと、**手順 1 に戻る
  前に**（手順 7）`task-intake` スキルの手順で全件を label `bug` 付き Issue
  として起票する。1 タスク = 1 PR のガードは維持する。bug 最優先ルール
  （`docs/development-style.md` 4.1 章）により、起票した bug タスクは次
  イテレーションで最優先に選ばれ、複数件あって area が互いに素なら同じ
  イテレーションで並列に処理されうる。
- **ユーザー報告**: ループ実行中にユーザーが動作上の問題を報告した場合も、
  同じフォーマットで起票してループを継続する。1 度の報告に複数の問題が含まれる
  場合は全件を分解し、まとめて起票する。
- **`/code-review` の指摘を受け入れる流れ**: 全タスク完了時の最終レポートを
  受けてユーザーが `/code-review` を実行し、指摘が返ったら、**指摘を 1 件ずつ
  処理せず全件を読み切ってから**、それぞれを同じ bug intake フォーマット （label
  `bug`・再現手順・期待/実際の挙動・発見契機 ＝どの `/code-review`
  指摘か。Acceptance Criteria は「再現テスト（red）→ 修正で green」）で
  起票する。起票後は bug 最優先ルール （`docs/development-style.md` 4.1
  章）で次イテレーションに選ばれるため、 ユーザーが `/agent-loop`
  を再開すればループが指摘を処理する。
- **イテレーション境界との関係**: バッチ起票は「イテレーションの終わりに
  まとめて起票し、そのあとで集合判定する」順序で行う。claim された進行中
  タスクが残っている間は新たな集合判定を開始しない（手順 1・「ガード」節）
  というルールは変更しない。イテレーション途中で見つけた問題を現在の集合へ
  合流させることはしない。
- **バッチ化が効かない場合**: 直前のタスクの直接の帰結として問題が 1 件だけ
  出る場合（例: TASK-112 が入れた後始末が動かず TASK-118 になった）は、
  まとめようにも他に独立した問題が無いため単独起票のままになる。それは想定内
  であり、無理に他フェーズの問題と束ねて起票を遅らせない。
- 起票フォーマット:
  - Description: 再現手順・期待挙動・実際の挙動・発見契機（どのタスクの
    動作確認/どの報告で見つかったか）を記載する。
  - Acceptance Criteria: 「再現テスト（red）が追加されている」「修正により
    green」。自動テストできない描画系の問題に限り「目視確認」を追加する。
  - LOOP-META の depends-on は原則空（`[]`）、ordinal は原則 null（Issue
    番号順）とする（優先順位は label `bug` が担保するため、ordinal
    で優先度を表現しない）。

## supervisor モード（外部再投入によるコンテキスト境界）

イテレーションをまたぐコンテキスト蓄積は N² で効く（実測: 1 タスクあたり
永続残骸 R ≒ 40.9K tok、9 タスクで 47K → 455K tok。
`docs/research/2026-08-11-agent-loop-context-boundary.md`）。herdr 配下で
ループを回す場合は、イテレーション境界でコンテキストを全量投棄する
**supervisor モード**を標準とする（ADR-0036。`docs/development-style.md`
4.3 章）。

- **判定（supervisor の有無）**: セッション起動時に環境変数
  `ZEITREISE_LOOP_SUPERVISOR=1` がセットされていれば supervisor モード。
  `/agent-loop` 開始時に `echo "${ZEITREISE_LOOP_SUPERVISOR:-}"` で 1 回だけ
  確認する。herdr 配下かどうかの自動検出は判定に使わない（herdr 配下でも
  supervisor を起動していない運用と区別できないため、運用者の明示宣言 =
  環境変数を権威とする）。
- **終端動作**: 手順 7 の分岐のとおり、イテレーション境界（進行中 claim
  ゼロ + 起票完了）でターンを終えて idle になる。ループの永続状態はすべて
  外部化済み（claim タグ・Issue 本文/コメント・git・PR）なので、コンテキスト
  を捨てても再投入された `/agent-loop` は手順 1 から完全に再開できる
  （コールドスタート設計）。
- **escalation 後の空回り防止**: supervisor モードでは `/agent-loop` 開始時
  （手順 1 の前）に open な `needs-human` Issue を確認し
  （`gh issue list --label needs-human --state open`）、あればループを
  開始せず即座にターンを終える。supervisor は停止条件を知らずに再投入を
  続けるため、このチェックがないと escalation → 再投入 → 同じ上限超過 →
  再 escalation の空回りになる。
- **supervisor 側の実行**: ホスト（herdr が動く側）で
  `scripts/loop_supervisor.sh <target>` を実行する。`<target>` は
  `herdr agent list` で確認できる pane id（例: `w5:p1`）または agent 名。
  スクリプトは「境界待ち → `/clear` 注入 → `/agent-loop` 再投入 →
  イテレーション完了待ち」を繰り返す。blocked（許可待ち等の HITL）では
  投棄せず待ち続ける。
- **境界の判定は herdr の状態だけでは足りない**（Issue #374）。ループは CI 監視に
  Monitor ツールを使い、Monitor を張るたびにターンを終えて `idle` になるため、
  **イテレーション途中でも `idle`／`done` が観測される**。supervisor は `/clear`
  注入前に、上の境界定義「進行中 claim ゼロ」を
  `git ls-remote --tags origin 'refs/tags/claim/*'` が空かどうかで裏取りする
  （`--boundary-poll` 秒ごとに再確認。取得に失敗した場合も境界とみなさない）。
  この裏取りが無いと、イテレーション途中で `/clear` が飛んで進行中の作業が
  失われる。オプション（`--cycles` / `--min-interval` /
  `--clear-delay` / `--prompt`）はスクリプトの `--help` を参照。
- **起動手順の例**（ホスト側）:
  1. `herdr tab create --cwd <repo> --env ZEITREISE_LOOP_SUPERVISOR=1`
  2. `herdr agent start loop --kind claude --pane <pane_id>`
  3. `herdr agent prompt <pane_id> "/agent-loop"`（初回投入）
  4. 別シェルで `scripts/loop_supervisor.sh <pane_id>`
- **フェイルセーフ**: 環境変数がセットされているのに supervisor が動いて
  いない場合、セッションは境界で idle のまま停止する（暴走しない）。後から
  supervisor を起動すれば次の検知で再開する。逆に、環境変数なしのセッション
  に supervisor を併用してはならない（セッションは境界でターンを終えず
  継続するため、supervisor がイテレーション途中の入力待ちを境界と誤認して
  `/clear` を注入し、進行中のコンテキストを破壊しうる）。
- **全タスク完了時**: 再投入された `/agent-loop` は空集合を検知して最終
  レポートを出し、すぐ idle に戻る。supervisor は停止条件を自動判定しない
  （空サイクルの busy loop 化は `--min-interval` が防ぐ）。全タスク完了を
  確認したら運用者が supervisor を Ctrl-C で止める。

## 最終レポート（全タスク完了時）

全タスク完了（`deno task next-tasks` が空集合 + claim
された進行中タスクなし）で停止する 際は、 最終レポートに以下を含める:

- 完了報告: このループで処理したタスクとマージした PR の要約。
- **ユーザーへ `/code-review` の実行を促す文言**。何がレビュー対象になるか
  ＝「このループで main にマージされた一連の変更」であることを明記する。
  ループは PR 単位でマージを重ねるため、横断的な設計・品質の観点は個々の PR
  レビューでは拾いにくい。全タスク完了時にユーザーが `/code-review` を
  実行して一連の変更をまとめて点検することを推奨する。

`/code-review` はループ内で自律実行しない。`/code-review` スキルは
`disable-model-invocation` のためエージェントから自律起動できず、
ループに挟むと実行のたびに人の操作を要する HITL となる。したがって PR
作成前などループ内での自律実行はせず、全タスク完了時にユーザーへ実行を
促す方式を採る。`/code-review` の指摘は上記「bug intake」でループに還流する。

## 停止条件

- `deno task next-tasks` の出力が空集合で claim された進行中タスクもない
  （全タスク完了）。停止時は上記「最終レポート」を出力する。
- `needs-human` エスカレーションを起票した。
- ユーザーが明示的に停止を指示した。

## ガード

- ループは同時に 1
  セッションのみ実行する（複数セッションでの並行実行はしない）。セッション間の
  二重着手はこのガードに加えて claim タグ CAS（手順
  2）がサーバ側で機械的に防ぐ。
- 1 イテレーション = 1 タスク集合（各タスクは個別 PR）。集合は
  `deno task next-tasks` の判定結果に限り、複数タスクを 1 つの PR に
  まとめない。claim された進行中タスクが残っている間は新たな集合判定を
  開始しない。
