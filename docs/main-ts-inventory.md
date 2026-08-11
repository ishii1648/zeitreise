# src/main.ts 責務インベントリと分割方針（TASK-116）

> 注: 本書は 2026-07-30 時点の main.ts に対する分析の記録（スナップショット）
> である。文中の年代解説パネル（notes 系: `setupNotesUI` / `loadNotes` /
> `src/ui/notes.ts` 等）への言及は当時の構成で、この機能は Issue #284 で
> 全面廃止・削除済み。現行の構成は `docs/app-spec.md` §5.4 を参照。

`src/main.ts` の全行を通読して責務を棚卸しし、抽出候補のモジュール単位と
分割後も main.ts に残す配線責務を定めたもの。実測は 2026-07-30 時点の **3,569
行**（起票時の 2,737 行から TASK-99/100/108〜110/120/122/123/136 等で 約 830
行増加。肥大は現在進行形である）。`src/` の次点は `powers.ts` の 583
行で、main.ts はその約 6 倍。main.ts には対応する `main_test.ts` が無く、
DOM・MapLibre・deck.gl の副作用と絡んだロジックは現状ユニットテスト不能。

本タスクの目的は**並列度ではなく保守性**（テスト容易性・可読性）である。
分割しても「新レイヤーを足せば必ず配線に触る」構造は変わらないため、
`area:src-main` の衝突ルール（`docs/development-style.md` 4.2 章)は維持する。

## 1. 責務分類（実測の行範囲つき）

行範囲は 2026-07-30 時点の実測。合計約 3,520 行 + 区切り空行 ≒ 3,569 行。

| #  | 責務                                                                     | 行範囲                             | 概算行数 | 分類                   |
| -- | ------------------------------------------------------------------------ | ---------------------------------- | -------: | ---------------------- |
| 1  | import 群（`src/` 25 モジュール + 外部 5 パッケージ）                    | 1〜262                             |      262 | 配線                   |
| 2  | 起動配線: URL 状態復元・PMTiles 登録・MapLibre Map 生成                  | 264〜337                           |       74 | 起動配線               |
| 3  | ベースマップフォールバック（handleBasemapError・error 購読）             | 339〜371                           |       33 | 起動配線               |
| 4  | 概略境界の styledata 購読                                                | 373〜383                           |       11 | MapLibre 統合          |
| 5  | 見た目の定数（勢力圏外枠 HRE_EXTENT_\*・諸侯領境界線 FIEF_\*）           | 398〜426, 701〜717                 |       46 | レイヤー構築           |
| 6  | モジュール状態: データストア・ローダ合成・選択/ホバー状態・currentView   | 428〜641                           |      210 | 状態管理               |
| 7  | deck.gl オーバーレイ 2 枚の生成（interleaved / overlaid）                | 643〜699                           |       57 | 起動配線               |
| 8  | currentStyleLayerIds（MapLibre スタイル順の取得）                        | 719〜743                           |       25 | MapLibre 統合          |
| 9  | 政治ポリゴン builder（buildPowerLayer）                                  | 745〜814                           |       70 | レイヤー構築（政治）   |
| 10 | picking → 表示ラベル・出典 metadata の解決（pickedLabel/pickedMetadata） | 816〜921                           |      106 | picking                |
| 11 | picking イベント処理・選択/ホバー状態の適用（handlePickHover/Click 等）  | 923〜1187                          |      265 | picking                |
| 12 | ラベル共通 base props（labelLayerBaseProps）                             | 1239〜1270                         |       32 | レイヤー構築（ラベル） |
| 13 | 河川レイヤー builder 群（表示・ヒット・ラベル + メモ化）                 | 1189〜1237, 1272〜1382, 1685〜1704 |      180 | レイヤー構築（河川）   |
| 14 | 山脈レイヤー builder 群（ラベル・ヒット・強調輪郭 + メモ化）             | 1384〜1513                         |      130 | レイヤー構築（山岳）   |
| 15 | 山峰レイヤー builder 群（マーカー・ヒット・ラベル + メモ化）             | 1515〜1683                         |      169 | レイヤー構築（山岳）   |
| 16 | 都市レイヤー builder 群（マーカー・ヒット・ラベル + メモ化）             | 1706〜1861                         |      156 | レイヤー構築（都市）   |
| 17 | 勢力圏の外枠 builder（buildSuzerainExtentLayer）                         | 1863〜1890                         |       28 | レイヤー構築（政治）   |
| 18 | 概略境界の MapLibre 同期（syncApproximateBorders + メモ化）              | 1892〜1975                         |       84 | MapLibre 統合          |
| 19 | renderLayers（全レイヤー統合・描画順導出・整合検証）                     | 1977〜2148                         |      172 | 配線（中核）           |
| 20 | 勢力ラベル builder 群（memoizedPowerLabelData・buildLabelLayer）         | 2150〜2292                         |      143 | レイヤー構築（政治）   |
| 21 | 情報パネル・ツールチップ DOM（setupInfoUI・sourceLineNodes）             | 2294〜2393                         |      100 | DOM UI                 |
| 22 | attribution フッター配線（setupFooter）                                  | 2395〜2426                         |       32 | DOM UI                 |
| 23 | 既知の制限一覧 UI（setupKnownLimitationsUI）                             | 2428〜2519                         |       92 | DOM UI                 |
| 24 | 年代解説パネル UI（setupNotesUI）                                        | 2542〜2642                         |      101 | DOM UI                 |
| 25 | 年代切替配線: yearSwitcher・URL 同期・ズーム段監視                       | 2644〜2720                         |       77 | 状態管理・配線         |
| 26 | ローディング/エラー UI・switchYear（公開 API）                           | 2722〜2813                         |       92 | DOM UI + 配線          |
| 27 | タイムライン UI（setupTimeline）                                         | 2815〜2919                         |      105 | DOM UI                 |
| 28 | データローダ（load\* 10 関数。fetch + 縮退契約）                         | 2521〜2540, 2921〜3089             |      189 | データ取得             |
| 29 | 起動シーケンス（initPowerLayer・map.on("load")）                         | 3091〜3130                         |       40 | 起動配線               |
| 30 | デバッグフック（`__setYear` / `__get*Debug` / `__probePick` 等 15 件）   | 3132〜3569                         |      438 | デバッグ               |

分類別に集計すると次のとおり。**レイヤー構築（約 950 行）とデバッグフック （438
行）と DOM UI（約 520 行）で全体の過半**を占め、配線そのもの
（renderLayers・起動・年代切替）は約 700 行にとどまる。

| 分類                                  | 概算行数 | 割合 |
| ------------------------------------- | -------: | ---: |
| レイヤー構築（builder + メモ化）      |      954 |  27% |
| デバッグフック                        |      438 |  12% |
| DOM UI（パネル 6 種の配線）           |      522 |  15% |
| picking・イベント処理                 |      371 |  10% |
| import 群                             |      262 |   7% |
| 状態管理・年代切替・データ取得        |      476 |  13% |
| 起動配線・MapLibre 統合・renderLayers |      496 |  14% |

## 2. 抽出候補のモジュール単位

方針: **状態の所有は main.ts に残し、抽出モジュールは「純関数 + 依存注入
ファクトリ」で受ける**。既存の `src/` 25 モジュールが確立した形
（純粋関数を切り出し、main が配線する）の延長で、抽出単位ごとに独立の PR
にできる。行数は「移動する行 + 新設する注入インターフェース」の概算。

| 単位 | 新モジュール案                                                                                                                                          | 含める関数                                                                                                                                                                                                                                                                                                                                                                                                                                     | 概算行数 | 依存（import する / される）                                                                                                                                                          | 抽出時の懸念                                                                                                                                                                                                                                                                                                                                                                                                                            | area ラベル案                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| U1   | `src/debug_hooks.ts`                                                                                                                                    | `__setYear` / `__getYear` / `__getCityDebug` / `__getMountainLabelDebug` / `__getPeakDebug` / `__getPowerLabelDebug` / `__getRiverLabelDebug` / `__getFranceFiefDebug` / `__getHreFiefDebug` / `__getItalyFiefDebug` / `__getCliopatriaFiefDebug` / `__getApproximateBorderDebug` / `__probePick` / `__getPowerHighlightDebug` / `__getCityScreenPositions` の 15 件を `installDebugHooks(deps)` ファクトリへ                                  |     ~470 | import: picking / labels / powers / cities / peaks / mountains / rivers / suzerain_extent / power_highlight / approximate_borders。される: main のみ                                  | 読むモジュール状態が最多（currentView・zoomStep・各データストア・overlay・map・メモ化関数群）で、deps オブジェクトのゲッター注入が要る。フック名と返り値の形は `scripts/verify/` ヘッドレス検証の契約なので**変えない**。読み取り専用なので退行リスクは最小                                                                                                                                                                             | `area:src-main` + `area:src-debug`               |
| U2   | `src/data_loading.ts`                                                                                                                                   | `loadColors` / `loadOverrides` / `loadNameJa` / `loadFiefDedupe` / `loadRivers` / `loadMountains` / `loadPeaks` / `loadCities` / `loadNotes` / `loadKnownLimitations` の 10 件。共通形（fetch → parse → 失敗時 warn + フォールバック値）を汎用 `fetchJson` に集約                                                                                                                                                                              |     ~200 | import: fief_dedupe / notes / known_limitations / rivers / mountains / peaks / cities / suzerain_extent の URL とパーサ。される: main のみ                                            | 現状は**モジュール変数へ直接代入する副作用型**。返り値型へ変え、代入は main に残す。loadNotes / loadKnownLimitations は成功時に reveal フックを呼ぶため、成功時コールバック（または返り値の null 判定）を main 側に残す。warn 文言と縮退契約（失敗しても続行）は 1 字も変えない                                                                                                                                                         | `area:src-main` + `area:src-data-loading`        |
| U3   | `src/ui/` 配下 6 ファイル（`info_panel_dom.ts` / `footer_dom.ts` / `known_limitations_dom.ts` / `notes_dom.ts` / `loading_dom.ts` / `timeline_dom.ts`） | `setupInfoUI` + `sourceLineNodes` + `INFO_PANEL_SOURCE_CLASS`、`setupFooter`、`setupKnownLimitationsUI`、`setupNotesUI`、`setupLoadingUI`、`setupTimeline`                                                                                                                                                                                                                                                                                     |     ~560 | import: info / footer / collapsible / known_limitations / notes / loading_state / timeline / config。される: main のみ                                                                | 「モジュールスコープの `let` フックへ実体を差し込む」パターン（showTooltip / reflectYearTo\* / renderLoadingUI / reveal\*）を「setup がハンドルオブジェクトを返す」形へ置換する必要。setupTimeline / setupLoadingUI は `switchYear` へのコールバック注入（循環 import 回避）。DOM 要素欠如時の warn + スキップ契約は維持                                                                                                                | `area:src-main` + `area:src-ui-panels`           |
| U4   | `src/feature_layers.ts`                                                                                                                                 | `labelLayerBaseProps`、河川（`riversLayerBaseProps` / `buildRiversLineLayer` / `buildRiversHitLayer` / `buildRiverLabelLayer` + メモ化 3 件）、山脈（`buildMountainLabelLayer` / `buildMountainHitLayer` / `buildMountainOutlineLayer` + メモ化 2 件）、山峰（`buildPeakMarkerLayer` / `buildPeakHitLayer` / `buildPeakLabelLayer` + メモ化 4 件）、都市（`buildCityMarkerLayer` / `buildCityHitLayer` / `buildCityLabelLayer` + メモ化 3 件） |     ~700 | import: rivers / mountains / peaks / cities / labels / label_collision / picking / memo。される: main・U1（メモ化関数をデバッグフックが読む）                                         | builder が読むモジュール状態（riversData 等 4 データストア・nameJa・zoomStep・selected\*/hovered\* 6 変数）を**引数の context オブジェクトで受ける純関数化**が必要。`memoizeLatest` のキャッシュは新モジュールのモジュールレベルに置いてよいが、**参照同値キーの契約（TASK-50/136: hover 連続移動で再計算しない）を退行させない**ことを AC で担保する                                                                                   | `area:src-main` + `area:src-layer-builders`      |
| U5   | `src/political_layers.ts`                                                                                                                               | `buildPowerLayer`、`buildSuzerainExtentLayer`、`buildLabelLayer` + `memoizedPowerLabelData` / `memoizedVisiblePowerLabels`、定数 `HRE_EXTENT_*` / `FIEF_LINE_*`                                                                                                                                                                                                                                                                                |     ~430 | import: powers / labels / label_collision / power_highlight / suzerain_extent / fief_dedupe / layer_stack / memo。される: main・U1                                                    | colors / overrides / nameJa / fiefDedupe / powerHighlight ストア / fillTransitionMs / extentKey / suzerainExtent キャッシュへの依存を context 注入。`fillTransitionMs` の一時差し替え（renderWithFillTransition）と powerHighlight ストアの所有は main に残す。beforeId 計算（underWaterBeforeId）は map 依存なので `styleLayerIds` を引数で渡す                                                                                        | `area:src-main` + `area:src-layer-builders`      |
| U6   | `src/pick_handlers.ts`                                                                                                                                  | `pickedLabel` / `collectionMetadata` / `pickedMetadata`、`handlePickHover` / `handlePickClick` / `resolveClickInfo` / `CLICK_PICK_DEPTH`、`mountainNameFromPick` / `peakNameFromPick` / `extentKeyFromPick`（+メモ化） / `powerHighlightKeyFromPick`、`applyExtentKey` / `applyRiverSelection` / `applyRiverHover` / `applyTerrainHover` / `applyTerrainSelection`                                                                             |     ~490 | import: picking / info / rivers / mountains / peaks / cities / suzerain_extent / power_highlight / powers / memo。される: main（overlay 生成時の onHover/onClick）・U1（__probePick） | 選択/ホバー状態 7 変数 + extentKey の**所有権**が論点。推奨は `createPickHandlers(deps)` ファクトリが状態ごと閉じ込め、main には overlay 生成時に onHover/onClick を渡す配線だけ残す形。renderLayers・showTooltip / showInfoPanel はコールバック注入。デバッグフックが状態を読むため、ハンドルに読み取り用 getter を生やす。U4/U5 の builder も selected\*/hovered\* を読むので、**状態の受け渡し設計を U4〜U6 で一貫させる**必要がある | `area:src-main` + `area:src-picking`             |
| U7   | `src/approximate_border_sync.ts`                                                                                                                        | `syncApproximateBorders` + 再入ガード、`memoizedApproximateBorderData`、`approximateBorderData` 変数、styledata 購読の組み立て                                                                                                                                                                                                                                                                                                                 |     ~130 | import: approximate_borders / layer_stack / memo / maplibre 型。される: main                                                                                                          | map への副作用（addSource / addLayer）を持つ数少ない単位。再入ガードと「styledata 再発火は数回で収束する」不変条件をコメントごと移す。renderLayers への逆参照はコールバック注入。`currentStyleLayerIds` は map 依存のため main からゲッターで渡す                                                                                                                                                                                       | `area:src-main` + `area:src-approximate-borders` |

補足:

- U1〜U7 の合計は約 2,980 行。注入インターフェースの新設で 300〜400 行が main
  側に戻るため、完了後の main.ts は **1,000〜1,200 行程度** （import
  縮小分を含む）に落ち着く見込み。
- **どの単位も main.ts を書き換えるため、後続タスクは全て `area:src-main`
  を持ち直列実行になる**（`deno task next-tasks` の衝突判定どおり）。 第 2
  ラベル（`area:src-debug` 等）は分割完了後の保守タスクが main に
  触れない場合に備えた予約で、当面の並列度には寄与しない（本タスクの
  前提どおり並列度改善は目的ではない）。
- U4 と U5 は `labelLayerBaseProps` と「builder が状態を context で受ける」
  設計を共有するため、U4 → U5 の順序依存がある。それ以外の単位間に
  ハード依存は無く、リスクの小さい順（U1 → U2 → U3 → …）に進める。

## 3. 分割後も main.ts に残す配線責務（AC #2）

main.ts は「**アプリの組み立て図**」に徹する。以下は抽出**しない**:

1. **起動配線**: `#map` の取得、URL クエリからの初期状態復元
   （decodeState）、PMTiles プロトコル/アーカイブ登録、`maplibregl.Map` の
   生成と maxBounds、フォールバック判定の購読（handleBasemapError）。
2. **オーバーレイの生成**: `MapboxOverlay` 2 枚（interleaved / overlaid）の
   インスタンス化と `map.addControl`。onHover / onClick には U6 のハンドラを
   渡す。
3. **モジュール状態の所有**: colors / overrides / nameJa / fiefDedupe /
   riversData / mountainsData / peaksData / citiesData / currentView / zoomStep
   / fillTransitionMs、および複合ローダ（createCombinedYearLoader）
   の合成。抽出モジュールへはゲッター・context 引数で渡す
   （選択/ホバー状態だけは U6 のファクトリへ移す選択肢を許す）。
4. **renderLayers**: 各 builder を呼び出して描画順
   （renderOrderFromPickingPriority）に並べ、整合検証
   （layerOrderMatchesPickingPriority / overlaySplitIsValid /
   waterStackIsValid）を通して 2 枚のオーバーレイへ setProps する中核。 builder
   の中身は U4/U5 へ出すが、**呼び出しと順序の決定は main に残す**
   （新レイヤー追加が必ず main に触るのはこのため。既知のトレードオフ）。
5. **年代切替と URL 同期**: yearSwitcher の applyFn（currentView 差し替え →
   renderLayers → 各 UI への反映フック呼び出し）、switchYear（公開 API・
   ローディング状態通知）、moveend / zoom の購読、 createReplaceStateUpdater
   の配線。
6. **起動シーケンス**: initPowerLayer（U2 のローダ群を Promise.all で並行
   実行し、返り値を状態へ代入 → 初期年の switchYear）、`map.on("load")`。
7. **各 setup / install 呼び出し**: U1（installDebugHooks）・U3（setup\* が
   返すハンドルの受領）・U7（同期の組み立て）を起動時に 1 度ずつ呼ぶ。

## 4. 分割方針（decision 記録の素材）

### Context

- src/main.ts は実測 3,569 行（起票時 2,737 行から増加中）で、`src/` 次点の
  powers.ts（583 行）の約 6 倍。25 モジュール分割済みでもなお統合層が肥大。
- main.ts には対応するテストが無く、レイヤー builder・picking ハンドラ・ DOM
  配線・デバッグフックがモジュール変数を直接読む構造のため、
  切り出さない限りユニットテストを書けない。
- 並列度の改善は主目的にしない（反実仮想シミュレーションで効果が小さい
  ことが判明済み。タスク本文と decision の前提）。

### Decision

- **状態の所有は main.ts に残し、抽出モジュールは「純関数 + 依存注入
  ファクトリ」で受ける**方式を採る（§2 の U1〜U7）。
- 抽出は 7 つの後続タスクに分け、リスクの小さい順（読み取り専用の デバッグフック
  → 副作用の単純なデータローダ → DOM 配線 → レイヤー builder → picking →
  MapLibre 同期）に 1 タスク = 1 PR で進める （TASK-103 → 104〜107
  と同じ段階方式）。
- renderLayers・yearSwitcher・起動シーケンスは main.ts に残す（§3）。

### 検討して却下した代替案

- **AppState ストアモジュールの導入**（状態を丸ごと別モジュールへ）: 全
  builder・全ハンドラの書き換えが 1 PR に集中しレビュー不能になる。
  状態の読み書き経路が一斉に変わるため挙動退行の切り分けも難しい。
- **レイヤーごとの自己完結コンポーネント化**（各レイヤーが自分の状態と builder
  を持つ）: renderLayers の一括整合検証（描画順 = picking 優先順、 overlaid
  分配、水面スタック）と衝突する。検証はレイヤー横断の不変条件
  なので、中央の配線層を残す方が仕組みとして単純。
- **分割しない**: 増加傾向（半年で +30%）を踏まえると、統合層の可読性と
  テスト不能領域が広がり続ける。

### Consequences

- main.ts は 1,000〜1,200 行程度の「組み立て図」になり、抽出後の各 モジュールは
  `deno test` で直接テストできる。
- 後続 7 タスクは全て `area:src-main` を持ち直列実行になる（実行中は他の UI
  タスクと衝突する）。分割完了後も「新レイヤー追加は main の配線に
  触る」構造は変わらない（並列度非改善の前提を維持）。
- デバッグフックの名前と形（ヘッドレス検証の契約）、データ取得の縮退契約
  （失敗時 warn + フォールバック値で続行）、メモ化の参照同値契約
  （TASK-50/136）は分割後も不変条件として各タスクの AC で担保する。

## 5. 後続タスクの実施順序

依存は「U5 が U4 に依存」のみ。ただし全タスクが `area:src-main` を持つため
実行は常に直列で、ordinal は下表の順に振る。

| 順序 | 対象単位 | 内容                                                   | 依存             |
| ---- | -------- | ------------------------------------------------------ | ---------------- |
| 1    | U1       | デバッグフック 15 件を `src/debug_hooks.ts` へ         | なし             |
| 2    | U2       | データローダ 10 件を `src/data_loading.ts` へ          | なし             |
| 3    | U3       | DOM パネル配線 6 件を `src/ui/` へ                     | なし             |
| 4    | U4       | 地物レイヤー builder 群を `src/feature_layers.ts` へ   | なし             |
| 5    | U5       | 政治レイヤー builder 群を `src/political_layers.ts` へ | U4               |
| 6    | U6       | picking イベント処理を `src/pick_handlers.ts` へ       | なし（順序のみ） |
| 7    | U7       | 概略境界同期を `src/approximate_border_sync.ts` へ     | なし（順序のみ） |

各タスク共通の AC 案: (1) 対象関数が main.ts から消え新モジュールへ移って
いる、(2) 挙動不変（`deno task test` green + ヘッドレス動作確認）、 (3)
対象単位の純関数・ファクトリにユニットテストが付いている、 (4)
縮退契約・フック名・メモ化参照同値などの不変条件が退行していない。
