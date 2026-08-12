# ヨーロッパ国境変遷マップ Web アプリ 仕様書（MVP）

> 中世（西暦1000年頃）〜近代（1914年）のヨーロッパにおける国境・勢力圏の変遷を、タイムラインスライダーでグラフィカルに追える
> Web アプリの仕様。 技術選定の背景は
> [`./map-rendering-research.md`](./map-rendering-research.md) を参照。

## 1. 目的・スコープ

### 1.1 目的

歴史的な国境・勢力圏の変化を年代スナップショットとして地図上に可視化し、時代を切り替えながら「ヨーロッパの形の変遷」を直感的に追えるようにする。

### 1.2 対象

| 項目       | 内容                                                   |
| ---------- | ------------------------------------------------------ |
| 対象期間   | 西暦 1000 年 〜 1914 年                                |
| 対象地域   | ヨーロッパ（概ね北緯 34〜72°、西経 25°〜東経 60°）     |
| 対象ユーザ | 歴史に関心のある一般ユーザ（ログイン・個人データなし） |

### 1.3 MVP スコープ

- 年代スナップショットごとの勢力圏ポリゴン表示（塗り分け）
- タイムラインスライダーによる年代切替
- ポリゴンのホバー/クリックで勢力名表示
- URL による表示状態の共有

### 1.4 非スコープ（将来拡張）

- 戦場マーカー・進軍ルート・補給線などの戦史レイヤー（`map-rendering-research.md`
  §4 のレイヤー構成をそのまま適用可能な設計とする）
- 年代間の補間アニメーション・自動再生
- 検索・多言語対応・モバイル最適化以上の UI

## 2. データソース

### 2.1 歴史的国境ポリゴン

[aourednik/historical-basemaps](https://github.com/aourednik/historical-basemaps)（GeoJSON）を採用する。

- **年代カバレッジ**: 対象期間内に 19 スナップショットが存在する。

  `1000, 1100, 1200, 1279, 1300, 1400, 1492, 1500, 1530, 1600, 1650, 1700, 1715, 1783, 1800, 1815, 1880, 1900, 1914`

  間隔は不均一（中世は約100年おき、近世以降は密）。スライダーはこの実在年のみを目盛りとする（§5.1）。

- **属性構造**（`world_<year>.geojson` の各 feature）:

  | プロパティ        | 意味                                | アプリでの用途                         |
  | ----------------- | ----------------------------------- | -------------------------------------- |
  | `NAME`            | 国・勢力の表示名（null の場合あり） | ツールチップ表示・色割当キー           |
  | `SUBJECTO`        | 宗主国・上位勢力（null 多数）       | 色系統の決定（§4.3）                   |
  | `BORDERPRECISION` | 境界精度 1（概略）〜3（確定）       | 免責表示の根拠。MVP では描画には未使用 |
  | `PARTOF`          | 文化圏など上位グルーピング          | MVP では未使用                         |

- **サイズ**: 世界全体で 1 スナップショットあたり約 1〜1.5
  MB。ヨーロッパ切り出し + simplify で軽量化する（§4）。

- **ライセンス:
  GPL-3.0**。商用利用可だがコピーレフトであり、**切り出し・簡略化した派生
  GeoJSON も GPL-3.0 で公開する義務がある**。リポジトリに LICENSE
  と出典を明記する。

- **選定理由**: 無料で GIS
  データ（GeoJSON）として再利用できる実質唯一の選択肢。Euratlas は有償、GeaCron
  は閲覧専用でデータ抽出不可、mapchart.net
  は画像出力ツールでベクタデータを提供しない。

- **免責**: 元データは "work in progress"
  と明記されており、境界の学術的精度には限界がある。この限界は
  `docs/data-inventory/` と `data/known-limitations.json`
  に開発者向けの記録として残し、**ユーザー向け UI には表示しない**（Issue
  #328。境界の粗さは概略境界の描き分け（TASK-80）で視覚的に伝える）。データ出典・
  ライセンスは右下のアトリビューション（ⓘ）に表示する（§5.4）。

### 2.2 ベースマップ

Protomaps 配布の既成 PMTiles を使用する（`map-rendering-research.md` §2 参照）。

- ベースマップが表示するのは**地形・海岸線のみ**。現代の国境・都市名・道路等のレイヤーはスタイル定義で非表示にする（歴史地図の上に現代の情報が透けるのを防ぐ）。河川はベースマップでは描画せず、データオーバーレイ（deck.gl
  の主要河川レイヤー）へ一本化する（ベースマップの川ラインは picking
  対象の河川データと経路が乖離し、クリックできないデコイになるため。TASK-44）
- 山岳は地形陰影（hillshade、TASK-34）で表現し、山脈名は河川と同じくデータ
  オーバーレイ（Natural Earth 由来の `data/mountains.geojson`
  から作る常時表示のラベル層、TASK-97）で補う。年代に依らない地形なので
  年代スナップショットとは独立の 1 ファイルにし、表示するズーム段は Natural
  Earth の `MIN_LABEL` から決める
- 山脈（面）に加えて主要な**山峰（点）**を `data/peaks.geojson`（Natural Earth
  10m の標高点、TASK-99）から描く。山脈名が「どのあたりが山地か」を示すのに
  対し、山峰は「どこが頂か」を示す。年代非依存の 1 ファイルという扱いは
  河川・山脈と同じ。マーカーは都市（半径 3px の赤い丸ドット）と取り違えないよう
  **`▲` グリフ**（`src/peaks.ts` の `PEAK_MARKER_GLYPH`、深緑 + クリーム halo）
  で描く。`ScatterplotLayer` は円しか描けず、`IconLayer` は新しいレイヤー
  クラスと画像バイトをバンドルに足すため、既に 4 層が使っている `TextLayer` に
  記号を描かせる方が安い。マーカー層は衝突フィルタに参加させない（名前が
  衝突で間引かれても頂の位置は残す。都市ドットと同じ扱い）
- 山峰の表示件数は `SCALERANK` 由来のズーム段（`peakMinZoom`）で絞る。実測で
  z4=2 件（モンブラン・エルブルス）・z6=22 件・z8=26 件。標高の併記
  （`モンブラン 4807m`）は **z7
  以上**に限る（`PEAK_ELEVATION_LABEL_MIN_ZOOM`）。 標高を足すとラベル幅が約 2.2
  倍になり、衝突ボックス（2.8 倍）と掛け合わさって
  周囲の勢力名・都市名を落としてしまうため、広域では名称のみにする
- 陰影の強さ（`HILLSHADE_LAYER` の paint、TASK-98）は「勢力ポリゴン（alpha
  128）の塗り越しでアルプス・ピレネー・カルパティアの骨格が読める」ことを
  基準に決める。`hillshade-exaggeration` はズーム補間
  （`HILLSHADE_EXAGGERATION_STOPS`: z4 で 1.0 → z11 で 0.55）とし、広域は
  強く・拡大側は DEM の粒状ノイズが目立つので弱める。影・ハイライト・
  アクセントはいずれも半透明を保ち（不透明にすると勢力色が黒潰れする）、
  ラベル判読はクリーム halo（TASK-72）が局所背景を作るので陰影の強さに
  依存しない
- 配信: Cloudflare R2 に PMTiles を配置し HTTP Range Request
  で取得。フォールバックとして OpenFreeMap を設定
- MVP ではヨーロッパ域のみを抽出した PMTiles
  を生成してサイズを削減してもよい（`pmtiles extract`）

## 3. アーキテクチャ

### 3.1 全体構成 — 完全静的配信

バックエンド API は持たない。全アセットを静的ホスティング（Cloudflare Pages +
R2）に配置する。

```
[静的ホスティング (Cloudflare Pages)]
 ├─ index.html / app.js / app.css     ← ビルド成果物
 ├─ data/
 │   ├─ index.json                    ← スナップショット年の一覧・メタ情報
 │   └─ europe_<year>.geojson × 20    ← 派生データ（GPL-3.0 で公開）
 └─ [Cloudflare R2]
     └─ europe.pmtiles                ← ベースマップタイル
```

- 年代切替はクライアント側で該当 GeoJSON を fetch して deck.gl
  レイヤーを差し替えるのみ。サーバー処理なし
- Deno は**ビルドツール（データパイプライン §4・バンドル）としてのみ**使用する

### 3.2 フロントエンド技術スタック

サプライチェーンリスクを抑えるため、依存を最小限に絞る。

| ライブラリ                               | 役割                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `maplibre-gl` ^4.x                       | ベースマップ描画                                                         |
| `@deck.gl/core` / `@deck.gl/layers` ^9.x | 勢力圏ポリゴン描画（`GeoJsonLayer`）、MapLibre への `MapboxOverlay` 統合 |
| `pmtiles` ^3.x                           | PMTiles プロトコル登録                                                   |
| `@protomaps/basemaps` ^5.x               | ベースマップスタイル定義（不要レイヤーを除外してカスタム）               |

フレームワーク（React 等）は MVP では導入しない。UI
はスライダーとツールチップのみであり、素の TypeScript + DOM
で十分。依存追加は攻撃対象面の拡大と天秤にかける。

### 3.3 描画構成

`map-rendering-research.md` §3 のコードパターンを踏襲する。

- MapLibre 初期化時に PMTiles プロトコルを登録し、Protomaps
  スタイルから地形・水域レイヤーのみ採用
- 勢力圏は `MapboxOverlay`（interleaved）上の `GeoJsonLayer` 1 枚で描画:
  - `getFillColor`: 勢力名から安定色を引く（§4.3）、opacity 0.5 程度
  - `getLineColor`:
    インク（焦茶）系の境界線（TASK-73。羊皮紙トーンのベースマップに合わせ、旧・白系から変更）
  - `pickable: true` でホバー/クリックを有効化
- 年代切替時は `GeoJsonLayer` の `data`
  を差し替えるだけ（ベースマップは不変。`map-rendering-research.md` §4
  の「ベースマップとデータレイヤーの分離」原則）
- 重ね順（TASK-77。判定ロジックと根拠は `src/layer_stack.ts`）:
  - 勢力・諸侯領・HRE 領邦の塗り 3 層はレイヤー prop `beforeId`
    でベースマップの水面ポリゴン（`water`）の下へ差し込む。ベースマップ（OSM
    の現代海岸線）と政治ポリゴン（粗い海岸線）の解像度差による海への塗りの
    はみ出しを、水面に覆わせて隠すため。スタイルに `water`
    が無い場合（フォールバックスタイル等）は `beforeId`
    なしの従来描画順にフォールバックする
  - ベースマップの水面は kind で 2 層に分ける（TASK-84）。内水面（湖・川・運河
    など。`water-inland`）は政治ポリゴンより**下**、海洋（`water`。ocean/sea/bay
    や未知の kind を含む）は**上**。内水面まで上に置くと政治ポリゴンの塗りが
    虫食い状に抜けるため（判定は `src/basemap.ts` の `INLAND_WATER_KINDS`。
    取りこぼしは安全側＝海洋扱いに倒す）
  - 陸の輪郭（海岸線 `coastline`）はベースマップ自身の陸ポリゴン（`earth`）の縁
    として海洋の**上**に描く（TASK-84）。政治ポリゴンの輪郭線は総延長の 2〜3
    割が 海側へはみ出し（浮き幅は中央値 1〜6 km、最大 26
    km）水面より上に戻せない
    ため、沿岸の線はベースマップ側で担う。水面と同じタイルから引くので線の位置と
    塗りが切れる位置が定義上一致する。#357 以降は概略境界の**入力そのもの**から
    沿岸セグメントを除く（`src/coastal_segments.ts` の判定を沿岸補完と共有）。
    沿岸補完（#305/#312/#326）が塗りを現代海岸線まで延ばした結果、歴史ポリゴンの
    沿岸外周を線として描くと補完前の海岸線が同色領域の内部に残るため （ADR-0016
    改訂 1）
  - 上記 3 層の相対順（内水面 → 政治ポリゴン → 海洋 → 海岸線）は
    `layer_stack.ts` の `waterStackIsValid` が描画ごとに検証する
  - ラベル 5 層（山脈名・山峰名・勢力名・河川名・都市名）だけは interleaved
    ではなく overlaid の別オーバーレイに載せる。`beforeId` で interleaved
    のレイヤーグループが分かれると `CollisionFilterExtension`
    の衝突マップが先行グループのパスで壊れ、ラベルが全滅するため。ラベルは
    `pickable: false` かつ常に最前面なので、picking・見た目への影響はない
  - 河川・河川ヒット層・都市マーカー・都市ヒット層は従来どおり水面より上
    （interleaved 側）
  - 勢力圏の外枠（`hre-extent`）だけは専用の `beforeId`（海洋 `water` の直下。
    `layer_stack.ts` の `suzerainExtentBeforeId`）を持つ別グループにする
    （#330）。塗りと同じく海洋にマスクされるので海へはみ出した臙脂線が海上に
    残らず、かつ概略境界より**上**なので内陸国境ではクリーム色の casing に
    洗い流されない（順は 塗り → 概略境界 → 外枠 → 海洋 → 海岸線）。`water` の
    無いフォールバックスタイルでは `beforeId` なしの従来描画順へ縮退する
  - **衝突フェードの二値化（TASK-108）**: `CollisionFilterExtension`
    は衝突判定を 0/1 ではなく
    `pow(アンカー近傍 5x5 px の一致率, 2.2)`（`collision_fade`）の
    連続値で返し、色の alpha に乗算する。ちらつき低減を狙った deck.gl 側の設計
    だが、優先度の高いラベルの衝突ボックスがアンカー近傍を部分的に覆っている
    **静止状態**では、負けた側が中途半端な alpha で描かれ続ける。さらに
    TextLayer の SDF は halo の alpha を `outlineColor`（不透明なクリーム）から
    取り `vColor.a` に依存しないため、「文字だけ薄れて白っぽい輪郭が残る」
    判読不能なゴーストになる。`src/label_collision.ts` の
    `LabelCollisionCutoffExtension` を `CollisionFilterExtension` の**後ろ**に
    置いてこれを二値化し、`LABEL_COLLISION_FADE_CUTOFF`（0.5 = 生の一致率 約
    0.73）未満はジオメトリごとクリップ空間の外へ飛ばして halo ごと消し、 以上は
    `collision_fade` を 1.0 に戻して本来の不透明度で描く。ラベルは
    「読める」か「出ない」かの二択になる。衝突マップの描画パス
    （`collision.enabled == false`）には介入しないので、どのラベルが勝つかの
    判定・層をまたいだ表示優先・`COLLISION_SIZE_SCALE` は従来のまま

### 3.4 配信キャッシュ制御

`app.js` と `data/*.geojson` / `colors.json` / `name-ja.json`
は整合が取れていることを前提とするため、一部のファイルだけ古いキャッシュが使われる「部分キャッシュ」は表示破壊につながる（実例:
dev サーバが `Cache-Control` を返さずブラウザのヒューリスティックキャッシュ（
`Last-Modified` からの経過時間の約 10%）が効き、再生成後も `hre_<year>.geojson`
だけ旧版が配信されて `colors.json` と不整合になった）。

**基本方針（dev / 本番共通、#246）**: `app.js` と `data/*`（json / geojson）は
ビルド時にコンテンツハッシュ付きファイル名（`app.<hash>.js` /
`data/<name>.<hash>.json` 等。SHA-256 先頭 10
桁）で配置し、`Cache-Control:
public, max-age=31536000, immutable`
で配信する。それ以外（`index.html` / `manifest.json` 等）は従来どおり
`Cache-Control: no-cache`（ETag / `Last-Modified` による再検証運用）とする。
PMTiles（R2 配信）は例外で、ハッシュ改名なしの長期キャッシュとする（#245。
後述の R2 項を参照）。

- ハッシュ付きアセットは内容が変わればファイル名が変わるため、同一 URL の
  内容は不変 = 再検証リクエスト自体が不要になり、2 回目以降のロードは
  ブラウザ/エッジのキャッシュから満たされる
- 参照の解決: ビルド（`scripts/build.ts`）が論理パス → ハッシュ付きパスの
  対応表を `dist/manifest.json`（唯一 no-cache の JSON）に生成する。
  `index.html` の `app.js` 参照はビルド時に書き換え、ランタイムのデータ URL
  （`/data/...`）は起動時に manifest を 1 回 fetch して解決する
  （`src/asset_manifest.ts` + `src/main.ts` の `fetchAsset`）。manifest が
  無い・取得に失敗した場合は素の論理パスへフォールバックし、dist でなく
  生ファイルを配信する環境でも従来どおり動く
- dev サーバ: `deno task serve`（`scripts/serve.ts` が `@std/http` の `serveDir`
  で `dist/` を配信）が本番と同じ方針で Cache-Control を出し分ける
  （ハッシュ付きパスは immutable、それ以外は no-cache）。既定ポートは
  `scripts/serve.ts` の `DEFAULT_PORT`（単一定義元。検証ハーネス
  `scripts/verify/cdp.ts` の `DEFAULT_APP_URL` もこれを参照する）。ポートが
  使用中の場合は占有プロセスと対処を表示して終了し、`--auto-port` を明示した
  ときだけ空きポートへフォールバックする（後始末手順は README 参照, TASK-89）
- 本番（Cloudflare Pages）: `scripts/build.ts` の `buildHeadersContent` が
  生成する `_headers` で、`/*` に no-cache、`/data/*` とハッシュ付き
  `app.<hash>.js` に immutable を設定する（Pages は複数ルールのヘッダを
  結合するため `! Cache-Control` で detach してから付け直す）
- R2（PMTiles、#245）: `europe.pmtiles` / `europe-dem.pmtiles` は不変に近い
  運用（差し替えは workflow_dispatch の `refresh_tiles` のみ）で、`app.js` /
  `data/*` との相互整合の制約も無い（basemap / DEM は年代データと独立）ため、
  ハッシュ改名なしの長期キャッシュ例外とする。背景の実測（#245 起票時）:
  旧状態はオブジェクトに `Cache-Control` なし（basemap）/ `no-cache`（DEM） かつ
  `cf-cache-status: DYNAMIC` で、初期ロードの Range リクエスト 42 件が すべて R2
  オリジンに到達し、waterfall の約 930ms を占めていた。
  - **オブジェクトメタデータ**: R2 オブジェクトに
    `Cache-Control: public,
    max-age=31536000, immutable` を付与する。実装は
    `.github/workflows/deploy.yml` の「Sync PMTiles to R2」ステップ
    （`aws s3 cp --cache-control`）。アップロードがスキップされるデプロイ
    でも、既存オブジェクトの `Cache-Control` が方針と異なれば同一バケット内
    CopyObject（`aws s3api copy-object --metadata-directive REPLACE`）で
    メタデータのみ冪等に書き換える。sha256 サイドカー
    （`<name>.pmtiles.sha256`）は deploy workflow 自身が差分検出に読むため
    `no-cache` のまま（拡張子が `.pmtiles` でないので下記 Cache Rule にも
    かからない）
  - **Cache Rule（一度きりの手動設定・必須）**: Cloudflare は既定では
    ファイル拡張子ベースでしかエッジキャッシュせず、`.pmtiles` は既定
    リスト外のため、オブジェクトに `Cache-Control` を付けるだけでは
    エッジに載らない（`cf-cache-status: DYNAMIC` のまま）。ゾーン zeitreises.com
    に次の Cache Rule を 1 つ作成する:
    - 式:
      `(http.host eq "tiles.zeitreises.com" and ends_with(http.request.uri.path, ".pmtiles"))`
    - Cache eligibility: Eligible for cache
    - Edge TTL: 「Use cache-control header if present, bypass cache if not」
      （オリジン = R2 オブジェクトの `Cache-Control` を尊重）
    - 任意: Smart Tiered Cache を有効化すると R2 近傍の上位 DC 1 箇所に
      オリジン取得が集約される（R2 docs の推奨）
  - **Range とエッジキャッシュ**: Cloudflare はレスポンスが cacheable なら Range
    リクエストをエッジで処理する（初回はオリジンからファイル全体を
    取得してキャッシュし、以降はどの byte range でも 206 をエッジから返す）。
    条件は (a) 上記 Cache Rule で cache-eligible であること、(b) キャッシュ
    可能サイズ上限（Free/Pro/Business プランは 512 MB）以内であること。
    `europe-dem.pmtiles`（約 305 MiB）は上限内だが、将来 512 MB を超えると
    警告なくキャッシュされなくなる点に注意
  - **差し替え運用**: 同名アップロード + Cloudflare の URL 単位パージ
    （`POST /zones/{zone_id}/purge_cache`）を deploy workflow が自動実行する
    （アップロードまたはメタデータ書き換えが起きたデプロイのみ）。
    ファイル名バージョニング（`europe.<ver>.pmtiles`）は、URL が
    `src/pmtiles_url.ts` にビルド時定数で埋まっており `refresh_tiles`
    （workflow_dispatch）のたびにコミットが必要になる・旧版オブジェクトが
    バケットに蓄積するため不採用。パージ失敗時は `refresh_tiles` 指定の
    デプロイなら workflow を fail させ（古いタイルが最長 1 年配信され続ける
    ため）、それ以外（初回アップロード等、パージ対象が元々キャッシュされて
    いないケース）は warning で続行する。残余リスク: パージ直後に、旧版の
    ディレクトリを読み込み済みのクライアントが新オブジェクトへ Range を
    発行するとオフセット不整合になり得るが、旧 no-cache 運用でも同じ条件で
    起こるもので、pmtiles クライアントは ETag 変化を検出して再初期化する
    ため許容する
  - **必要なトークン権限（手動設定）**: パージのため GitHub Secrets の
    `CLOUDFLARE_API_TOKEN` に、既存の R2 / Pages 権限に加えてゾーン
    zeitreises.com の `Zone.Zone:Read`（ゾーン ID の解決用）と
    `Zone.Cache Purge:Purge` を付与する（Cloudflare ダッシュボード → My Profile
    → API Tokens → 該当トークンの Edit で Zone 権限を追加）。
    新規シークレットは追加しない。権限が無い間も通常デプロイは動く （warning
    のみ）が、`refresh_tiles` は fail する
- **エッジキャッシュ（`data/*` の json / geojson、#270）**: Cloudflare は
  既定ではファイル拡張子ベースでしかエッジキャッシュせず（上記 .pmtiles と
  同根）、`.json` / `.geojson` は既定リスト外のため、`_headers` で immutable
  を付けても `data/*` はエッジに載らない。本番実測（2026-08-12、各 URL に 3
  連続リクエスト）: 既定リスト内の `.js` である `app.<hash>.js` は
  `cf-cache-status: MISS → HIT → HIT` になる一方、同一の
  `Cache-Control: public,
  max-age=31536000, immutable` を返す
  `data/colors.<hash>.json` / `data/base_outline_<year>.<hash>.geojson` は 3
  回とも `DYNAMIC` のままだった。ヘッダ・配信元（Pages）・パス階層は同一で
  拡張子だけが異なるため、拡張子起因と確定。
  - **404.html（SPA フォールバック無効化・ビルド同梱・#270）**: 従来 Pages は
    未知パスへ index.html を 200 で返し（SPA フォールバック）、`/data/*` の
    `_headers` ルールは**リクエストパス**で付くため、存在しない `/data/*.json`
    に「immutable 付き 200 の HTML」が返っていた（実測で 確認）。下記 Cache Rule
    導入後はこれがエッジに最長 1 年固定され得る （デプロイ切替の瞬間に新ハッシュ
    URL へ旧デプロイが応答するレース等） ため、`404.html` を dist
    に同梱（`scripts/build.ts`
    getStaticCopyTargets）してフォールバックを無効化し、未知パスは 404 に
    する。アプリは `/` 以外のルートを持たず（表示状態は URL クエリのみ、
    §5.3）、SPA フォールバックへの依存はない
  - **Cache Rule（一度きりの手動設定・必須）**: ゾーン zeitreises.com に 次の
    Cache Rule を 1 つ作成する（.pmtiles 用とは別ルール。作成は上記 404.html
    を含むビルドのデプロイ後に行う）:
    - 式:
      `(http.host eq "zeitreises.com" and starts_with(http.request.uri.path, "/data/") and (ends_with(http.request.uri.path, ".json") or ends_with(http.request.uri.path, ".geojson")))`
    - Cache eligibility: Eligible for cache
    - Edge TTL: 「Use cache-control header if present, bypass cache if not」
      （オリジン = `_headers` の Cache-Control を尊重。immutable を運ぶのは
      ハッシュ付きアセットの応答だけなので、長期キャッシュされるのは 「内容 =
      URL」のファイルに限られる）
    - Status code TTL: 範囲 400–599 に「No store」（API 値 -1）を追加する。
      `_headers` はステータスを区別できず 404 応答にも immutable が付くため、
      これが無いとデプロイ切替レースで新ハッシュ URL に 404 が最長 1 年
      固定され得る（404.html とセットで汚染経路を閉じる）
  - **#246 の整合性（AC2/AC3）への影響**: 退行なし。index.html / manifest.json
    は `/data/` 外で Cache Rule の対象にならず no-cache
    （`DYNAMIC`）のまま。エッジに長期保存されるのは「ハッシュ付き URL への
    200」だけで、内容 = URL（コンテンツアドレス）だからどの時点の
    キャッシュでも常に正しく、デプロイのアトミック切替（no-cache の index.html /
    manifest が常に同一ビルドの組を指す）は不変
  - **素の論理パス（`/data/colors.json` 等）の注意**: #246 以降 dist には
    ハッシュ付きファイルしか無く、素パスは manifest 取得失敗時の
    フォールバック専用（本番では非サポート）。実測では素パスに Cloudflare
    内部レイヤー（ゾーンキャッシュ外。`cf-cache-status: DYNAMIC` のまま）が
    旧デプロイ時代の JSON を返し続ける現象を確認した（例: `/data/cities.json` が
    #221 マージ時点の内容。素パスを配信していた #246
    直前のデプロイの名残とみられる）。Cache Rule 導入後はこの応答 （200 +
    immutable）が素パス URL にもエッジ固定され得るが、正常 クライアントは
    manifest 経由のハッシュ付き URL しか参照しないため 実害はない
  - 期待効果と確認手順: 初期ロードの `data/*`（json 10 件 + geojson 約 10 件）が
    2 回目以降は別クライアントでもエッジ HIT になり、オリジン到達が index.html +
    manifest.json の 2 件に収束する。ルール作成後、manifest
    記載のハッシュ付きパスに `curl -sI` を 2 回実行して
    `cf-cache-status: MISS → HIT` を確認する

**削除・置換されたファイルのエッジ残留対策（#298）**: 上記の immutable + Cache
Rule 運用の帰結として、デプロイで dist から削除・置換（旧ハッシュの `data/*` /
`app.<hash>.js` 等）されたファイルは、オリジンが 404 を返す
ようになってもエッジの旧コピーが素の URL で最長 1 年配信され続ける（#284 で
廃止した「解説」データの JSON が `cf-cache-status: HIT` + 旧本文 200 のまま
残留する形で顕在化。#298）。対策として deploy workflow が削除ファイルの URL
単位パージを自動実行する。

- **仕組み**（`.github/workflows/deploy.yml` の「Purge deleted files from edge
  cache」ステップ。Pages デプロイの**後**に実行し、パージ後の再取得が
  必ず新デプロイの 404 で満たされるようにする）:
  1. 今回の dist の全ファイル一覧（マニフェスト）を `find dist` で生成する
  2. 前回デプロイのマニフェストを R2（`zeitreise-tiles` バケットの
     `deploy/dist-manifest.txt`、`no-cache`）から取得する。Pages 自体は
     過去デプロイのファイル一覧を提供しないため、workflow が自前で保存・
     比較する方式を採る
  3. 「前回に在って今回無い配信パス」= 削除されたパスを検出し、
     `https://zeitreises.com/<path>` を `purge_cache` API でパージする。
     削除検出・URL 生成（`_headers` 等の Pages 内部ファイル除外、 `index.html` /
     `.html` の pretty URL 変種を含む）・30 URL/リクエスト 上限での分割は
     `scripts/purge_deleted_paths.ts`（純関数 + CLI、 テストあり）が担う
  4. パージ成功後に今回のマニフェストを R2 へ保存する（途中失敗時は前回分が
     残り、次回デプロイが削除検出をやり直す）
- **明示パージリスト（`.github/purge-paths.txt`）**: マニフェスト差分は
  この仕組みの導入前に削除されたファイルを拾えないため、既知の残留パスを
  列挙して毎デプロイ無条件にパージする（冪等。素の URL で 404 を実測できたら
  行を削除してよい）。手動でパージしたい URL が出た場合の運用手段でもある
- **失敗時の方針**: PMTiles の初回アップロード時と異なり、このステップの
  パージ失敗は常に workflow を fail させる。対象 URL は「削除済みなのに
  エッジに残留し得る」ものだけで、パージに失敗すると旧本文の配信が最長 1 年
  続くため。マニフェスト未保存（初回）は差分検出をスキップして明示パージ分
  のみ処理する
- **必要なトークン権限**: PMTiles のパージ（#245）と同一
  （`CLOUDFLARE_API_TOKEN` にゾーン zeitreises.com の `Zone.Zone:Read` +
  `Zone.Cache Purge:Purge`。R2 の読み書きは既存の R2 権限で賄う。新規
  シークレットなし）
- **残余リスク**: URL 単位パージは既定のキャッシュキー（クエリ文字列を含む）
  に対して素の URL のみを無効化するため、クエリ付きでキャッシュされた変種は
  残り得る（アプリはクエリ付きで static アセットを参照しないため許容）。
  また同一パスの内容置換（ハッシュ改名なし）は削除として検出されないが、
  ハッシュ付き運用（#246）では発生せず、非ハッシュの `index.html` /
  `manifest.json` は no-cache のため対象外

**URL 単位パージが届かない Pages 側中間キャッシュ層（#304）**: #298 のマージ後
動作確認で、URL 単位パージ後もエッジの背後の中間層が削除済みファイルの旧 200
を再供給し、immutable 配信によりエッジへ再固定される現象を確認した。対象は #246
のハッシュ化前に配信していた旧論理パス群（`data/` 直下の `cities.json` /
`colors.json` / `name-ja.json` / `rivers.geojson` / `known-limitations.json`
と、 #284 で廃止した「解説」データの JSON。全リストは
`.github/purge-paths.txt`）。

- **観測（2026-08-12 実測）**: パージ済みの「解説」データ JSON は素の URL で
  `cf-cache-status: MISS` なのに `age: 95433`（約 26.5 時間 ≒ #246 デプロイ
  時点）+ 旧 etag + 旧本文 21,250 bytes の 200 が返り、直後からエッジ HIT に
  再固定される。オリジン直（`zeitreise-aop.pages.dev`）とキャッシュバスター
  付き（`?cb=...` → 404 BYPASS）は 404 で、オリジンは stale ではない。
  未パージの他 5 パスはエッジ HIT + 旧本文のまま。MISS はオリジン取得を
  意味するが `Age` はキャッシュ滞留時間を示すヘッダなので、「MISS + Age」は
  ゾーンキャッシュの再取得先（= オリジン側）に別のキャッシュがいる証拠になる
- **原因の同定**: 中間層はゾーンの Tiered Cache / Cache Reserve ではなく、
  **Cloudflare Pages 組み込みの配信キャッシュ層**（顧客ゾーンの `purge_cache`
  API の対象外）。根拠は公式ドキュメント
  （<https://developers.cloudflare.com/pages/configuration/serving-pages/>）:
  - 「static assets that you upload as part of your Pages project are
    automatically served from Tiered Cache. You do not need to separately enable
    Tiered Cache for the custom domain」— Pages はゾーン設定と無関係に 独自の
    Tiered Cache 経由で配信する
  - 「We will insert assets into the cache on a per-data center basis. Assets
    have a time-to-live (TTL) of one week but can also disappear at any time. If
    you do a new deploy, the assets could exist in that data center up to one
    week」（Asset retention）— 削除済みアセットもデプロイ後最長 1 週間
    データセンターに残る
  - 消去法: 単一ファイルパージは公式仕様上ゾーンの全データセンター（tier を
    含む）から即時削除する。Cache Reserve も「Cache Reserve will be instantly
    purged along with edge cache when you send a purge by URL request」
    （<https://developers.cloudflare.com/cache/advanced-configuration/cache-reserve/>）
    のため、仮に有効でも URL パージで消えるはずで残存層たり得ない。さらに Cache
    Rule 導入前の実測（上記「素の論理パスの注意」）では
    `cf-cache-status: DYNAMIC`（ゾーンキャッシュ完全不関与）のまま旧 JSON が
    返っており、供給源がゾーンキャッシュの外にあることが確定している
- **対応（#304）**: Pages 側中間層を顧客が直接パージする手段は無い（公式の
  案内はゾーンの Purge Everything だが、これはゾーンキャッシュ起因の stale
  向けで、本件の層に効く保証は無い）。中間層はデプロイ後最長 1 週間で自然
  失効するため、**旧論理パス群 6 件を `.github/purge-paths.txt` に全列挙し、
  毎デプロイの URL 単位パージでエッジ側の再固定を剥がし続ける**。中間層の
  失効（#246 デプロイ = 2026-08-11 の約 1 週間後）以降のデプロイで、パージ →
  再取得がオリジンの 404 で満たされ、素の URL は 404 へ収束する（404 は Status
  code TTL「No store」により再固定されない）。各行は素の URL で 404 を
  実測できたら削除してよい（テスト `scripts/purge_deleted_paths_test.ts` が 6
  件の列挙を固定している）
- **将来の削除への影響（追加機構を設けない判断）**: 今後デプロイで削除される
  ファイルも同様に中間層へ最長 1 週間残るが、(a) `/data/*` のハッシュ付き
  パスは内容 = URL のため旧コピーの再固定が起きても常に正しい内容であり無害、
  (b) 非 immutable パス（`/*` の no-cache）はエッジ再固定が起きず中間層の
  失効とともに自己解消する。恒常的に害が残るのは「immutable 配信される
  非ハッシュパス」だが、#246 以降の dist には存在しないため、削除パスを一定
  期間パージし続ける追加機構は導入しない

**no-cache 全面適用（TASK-35 / TASK-127）からの移行理由（#246 の実測）**:
旧方針は全アセット `no-cache` の再検証（304）運用だったが、本番
（zeitreises.com）の実測で以下が確認された。

- `app.js` は `cf-cache-status: REVALIDATED`（5 回連続、一度も HIT しない）で、
  エッジが毎回オリジンへ問い合わせていた
- `data/*.json` / `*.geojson` は `no-cache` + `cf-cache-status: DYNAMIC` で、
  静的 JSON 10 件 + 年代 geojson 9 件 = 19 リクエストがすべてオリジンに到達
  していた
- 初期ロードで `app.js`（brotli 後 828KB / 非圧縮 4.07MB）の取得に 614〜1397ms
  かかり、エッジの温まり具合で 2 倍以上ぶれていた

移行後のローカル実測（dev サーバ + ヘッドレス CDP、#246）では、2 回目ロードの
`app.js` + `data/*` 20 リクエストが「全件オリジンへの条件付き再検証」から
「全件キャッシュ充足（ネットワーク要求 0 件）」になり、オリジンへ到達するのは
`index.html` と `manifest.json` の 2 件だけになった（コールドロードの転送量は
manifest.json の 1 リクエスト分 +2.7KB でほぼ不変）。エッジ再検証の解消幅の
本番確認（#270 実測）: `app.<hash>.js` は `cf-cache-status: MISS → HIT` を
確認済み。`data/*` は拡張子の既定リスト外でエッジに載らず、上記 Cache Rule
（#270）の作成が必要。

**整合性の考察（部分キャッシュ不整合への対処）**: 旧 no-cache 方針は TASK-35
の部分キャッシュ不整合（再生成後に `hre_<year>.geojson` だけ旧版が残り表示が
破壊される）への意図的な対処だった。コンテンツハッシュ方式はこの整合性要件を
弱めるのではなく強める: no-cache の `index.html` が毎デプロイでそのビルドの
`app.js` を指し、データ URL は同じビルドが生成した manifest 経由でのみ解決
されるため、`app.js` と `data/*` は常に同一ビルドの組で読まれ、デプロイ単位で
アトミックに切り替わる。再生成・再デプロイ後も通常リロードだけで新しい組に
なる（強制リロード不要）。残余リスクは「リロードを跨ぐ長期セッション中に
デプロイが行われ、年代切替で fetch した geojson だけ新版になる」ケースに
限られる（旧方針と同じ。頻度・影響とも小さいため対策しない）。旧ビルドの
ハッシュ付きファイルはデプロイ直後の in-flight リクエストのためにしばらく
残っていても害がない（Pages はデプロイ単位で全置換するため実際には残らない。
その瞬間に読み込み中だったページはリロードで復帰する）。

## 4. データパイプライン

Deno
スクリプト（`scripts/build-data.ts`）で以下を実行し、成果物をリポジトリにコミットする（ビルド時に毎回元リポジトリへアクセスしない）。

```
① 取得    historical-basemaps から world_<year>.geojson × 20 を取得（コミットハッシュ固定）
② クリップ ヨーロッパ bbox（N34–72°, W25°–E60°）で切り出し（@turf/bbox-clip）
③ 簡略化  @turf/simplify で座標を間引き（目標: 1ファイル 300 KB 以下、ズーム6相当で破綻しない精度）
④ 正規化  NAME の表記ゆれ・null を補正するマッピングテーブル（data/name-overrides.json）を適用
⑤ 封土切出 上流が王国領・帝国領に一括で含めている封土を独立 feature にする（§4.4）
⑥ 異常是正 上流 properties の異常を data/name-overrides.json の propertyFixes で上書き（§4.5。切り出した封土 feature にも届くよう切り出しの後段に置く）
⑦ 空値正規化 空の SUBJECTO / PARTOF を NAME（＝独立勢力）に寄せる（§4.5）
⑧ 出力    data/europe_<year>.geojson と data/index.json（年一覧・feature数・色割当）を生成
```

### 4.1 出典固定

取得元はコミットハッシュでピン留めし、スクリプト内に記録する。元データが更新されても意図しないタイミングで境界が変わらないようにする。

### 4.2 index.json

```json
{
  "years": [1000, 1100, ..., 1914],
  "source": {
    "repo": "aourednik/historical-basemaps",
    "commit": "<pinned-sha>",
    "license": "GPL-3.0"
  }
}
```

### 4.3 色割当

- `NAME`
  をキーに決定的なハッシュでカラーパレットから色を割り当て、**同一勢力は全年代で同色**にする
- `SUBJECTO` が設定されている
  feature（属領・植民地）は宗主国の色相に寄せた明度違いにする
- 割当結果はビルド時に `data/colors.json`
  として静的生成し、クライアントでは参照のみ（実行時のハッシュ計算・色衝突の揺れを避ける）
- 隣接勢力の色衝突はパレット設計（十分な色数・彩度差）で緩和し、MVP
  では厳密な四色問題的解決はしない

### 4.4 封土の切り出し（TASK-101 / TASK-124）

上流（historical-basemaps）は封土を上位勢力の 1 つのポリゴンにまとめて塗ることが
あり、(a) 王の実効支配が及んでいない半独立の封土が王国領として（TASK-101）、 (b)
フランス王の封土や教皇領に帰属すべき地域が帝国領として（TASK-124）
塗られてしまう。`scripts/build-data.ts` の `BASE_FIEF_SPLITS`
に列挙した組み合わせについて、諸侯領 オーバーレイの同名区画との交差を base
から切り出して独立 feature に立てる。

- 切り出す形は「オーバーレイの区画 ∩ 切り出し元の勢力」に限る。base
  の面の内訳が入れ替わるだけなので、他勢力の領域は一切変わらない。形の出所も OHM
  のままで、出典を持たない座標は合成しない（decision-18）。
- 切り出しは簡略化（③）の前に行い、王国側の残余と封土が同じ座標列から同じ
  トレランスで簡略化されるようにする。
- **切り出しで分断された残余は隣接勢力へ付け替える**（`mergeSeveredRemainders`。
  Issue #342）。上流が封土の区画より広く塗っていると、封土を引いた残りが複数の
  連結成分に割れる。最大成分以外は封土を跨がないと本体へ行けない位置にあり、
  切り出しの根拠（「その区画は元勢力の領域ではない」）がそのまま及ぶ塗り過ぎの
  続きなので元勢力には残さない。base 勢力は隙間なく塗り分けられているため単に
  落とすと概観表示（`politicalDetail=false`）で穴が見えるので、**境界を最も長く
  共有する隣接 feature へ併合する**。判定は「切り出し前の元勢力のどのポリゴン
  由来か」でまとめてから行うため、元から別ポリゴンだった飛び地は必ず残る。
  併合先の候補から外すのは分断元自身と同じ年に立てる封土 feature の 2 つだけで
  （封土は「区画 ∩ 元勢力」のままでないと被覆率 ≒1.0 の前提が崩れる）、年代・
  勢力名の例外リストは持たない。同じ年の後続の切り出しが分断された成分の中の
  区画を使うことがある（1279 / 1300 の `Counts of Saint-Pol` は
  `County of Artois` の切り出しで分断される成分の中にある）ため、付け替えは
  その年の切り出しを全て終えてから行う。
- 切り出した feature の `SUBJECTO` は既定で `NAME`
  自身（＝独立勢力）。名目だけの 宗主関係は `suzerains` に載せない（§5
  の宗主補正と同じく「歴史的に宗主関係が
  明白でデータが欠いているもの」に限る、decision-19）。上流が誤って帝国側に
  塗った王の封土（TASK-124）は半独立の封土ではないため、正しい宗主 （`France` /
  `Papal States`）を宣言し、後段の `propertyFixes`（§4.5）が `PARTOF`
  を含む帰属を年号付きの根拠 note とともに確定させる。
- 派生データは自動的に追随する。封土はオーバーレイ union に完全に覆われるので、
  被覆率 ≒1.0 で base
  ラベルが抑制され（`fief-dedupe.json`）、`europe_flat_<year>` と
  `base_outline_<year>` からは塗り・輪郭ごと落ちる。色キーは独立（自己参照）なら
  オーバーレイと同じ `NAME` 単独キーで `colors.json` に新しいキーは増えず、
  宗主付き（TASK-124）は複合キー `NAME|SUBJECTO` が追加される（宗主スロット
  由来の派生色なのでプロービングには影響せず、既存の色は変わらない）。

| 年          | 切り出し元          | 封土                                                              | `SUBJECTO`                  |
| ----------- | ------------------- | ----------------------------------------------------------------- | --------------------------- |
| 1000 / 1100 | `Kingdom of France` | `Duchy of Normandy`                                               | `Duchy of Normandy`（独立） |
| 1279 / 1300 | `Holy Roman Empire` | `County of Artois` / `Counts of Saint-Pol` / `County of Flanders` | `France`                    |
| 1300        | `Holy Roman Empire` | `Lordship of Rimini`                                              | `Papal States`              |
| 1100        | `Poland`            | `Duchy of Bohemia`                                                | `Holy Roman Empire`         |
| 1200        | `Poland`            | `Moravia`                                                         | `Holy Roman Empire`         |

ノルマンディーを独立扱いにする根拠は 911
年のサン・クレール・シュール・エプト条約
以降カペー朝の実効支配が及ばなかったこと、および 1100
年が英諾分離期（ノルマンディー 公ロベール 2 世 ≠ イングランド王ヘンリー 1
世、1087〜1106）で England
配下に付け替えるのも不正確なこと。公はフランス王へ臣従礼を行う立場ではあったが名目に
留まるため、`suzerains` による宗主補正（`Britany` → `France`）とは扱いを分ける。

TASK-124 の 4 封土の根拠（詳細は `data/name-overrides.json` の各エントリの
note）: アルトワは 1180 年の持参領編入・1237 年のアパナージュ授与以降フランス
王家の所領、サンポルはアルトワ・ピカルディ境界の仏封土（帝国側へ移るのは 1493
年）、フランドル伯領本体は 843 年ヴェルダン条約以来の仏封土（スヘルデ川以東の
帝国フランドルはポリゴン 1 枚では分割できず、known-limitations に明記して France
側に含める）、リミニは 1278 年にルドルフ 1 世がロマーニャの帝国権を教皇へ
譲渡済み。リミニ以外のロマーニャ一帯は切り出しに使える出典付きの区画が無く、
帝国塗りのまま known-limitations（`base-imperial-paint-flanders-romagna`）に
記録する。

### 4.5 上流 properties の異常是正（TASK-102 / TASK-104）

上流の properties には、文字化け・列ずれと思われる異常値・年代間で揺れる
`SUBJECTO`・史実と食い違う宗主が混ざる。生成物を直接直すと再生成で失われるため、
`data/name-overrides.json` の `propertyFixes`（`renames` / `suzerains` と同じ
ファイル）に年代付きで宣言し、`scripts/build-data.ts` の `applyPropertyFixes`
が当てる。対象 feature はリネーム適用後の `NAME` で指定する（切り出し（§4.4）の
後段で当てるため、TASK-124 が切り出した封土 feature も対象にできる）。機構は
TASK-102 で導入し、TASK-104 で史実の宗主是正（下表の 4 行目）まで対象を広げた。
エントリは計 36（TASK-102 の 3 + TASK-104 の 15 + TASK-106 の 2 + TASK-107 の
12 + TASK-124 の 4）。

| 年代               | NAME                          | 上書き                             | 根拠                                                                                                                                                                                                                                                                                                          |
| ------------------ | ----------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1100               | `Aragón`                      | `PARTOF`                           | 置換文字（U+FFFD）への文字化け。同 feature の `NAME` / `ABBREVN` / `SUBJECTO` は正しい綴り                                                                                                                                                                                                                    |
| 1783               | `Lombardy`                    | `SUBJECTO` / `BORDERPRECISION`     | `SUBJECTO="3"` / `BORDERPRECISION=0` の列ずれ。1650〜1800 の他年代は `SUBJECTO=Lombardy` / `BORDERPRECISION=3`。この行は列ずれの是正に留め、1714 年以降のオーストリア領ロンバルディアという史実の付け替えは行っていない                                                                                       |
| 1300 / 1400        | `English territory`           | `SUBJECTO` / `PARTOF`              | 大陸に残るイングランド王の所領。1279 は `England` 配下なのに 1300 / 1400 は自己参照で、`colorKeyFor` のキーが年代で揺れて配色が変わっていた                                                                                                                                                                   |
| 1000〜1914         | 確度 A の 14 件               | `SUBJECTO` / `PARTOF`              | TASK-103 の横断監査で「明確な誤り」と判定した宗主（TASK-104）。年号付きの根拠は `docs/data-inventory/base-attribution-audit.md` §2 の A-1〜A-4・A-6〜A-15 と、各エントリの `note` を参照                                                                                                                      |
| 1279 / 1300 / 1400 | `Ryazan` / `Seljuk Caliphate` | **`NAME`** / `SUBJECTO` / `PARTOF` | 実体と食い違う勢力名の上書き（TASK-106、decision-23）。1400 `Seljuk Caliphate` → `Anatolian beyliks`（1308 年に滅亡した勢力名が残っていた）、1279 / 1300 `Ryazan` → `Other Rus Principalities`（オカ川中流域の一公国の名で約 131 万 km² が塗られていた）。上書き先はいずれも上流自身が別年代で使っている NAME |

TASK-104 の 14 件（`propertyFixes` エントリは 15。A-4 が Blue / White Horde の 2
エントリに分かれるため）は `Burgandy` 1100 / 1200（1032 年に帝国の構成王国）・
`Bulgar Khanate` 1100（1018 年に東ローマ併合）・`Novgorod` 1279 / 1400 と
`Blue Horde` / `White Horde` 1400（1260〜64 年に分裂した `Mongol Empire`
が宗主として残っている）・`Iceland` 1900 / 1914 と `Greenland` 1900（デンマーク
領）・`Algeria` 1900（1848 年にフランス本国へ編入）・`Naples` / `Sardinia` /
`Sicily` 1700（1713 年ユトレヒト条約後の帰属が混入）・`Mecklenburg-Strelitz`
1800（英国への従属は無い）・`Suomi` 1000（`SUBJECTO="Suom"` の切り詰め）・
`Sardinia` 1530 / 1600（1479 年以降スペイン王領）。

`propertyFixes` と `suzerains` の棲み分けは「上流の値をどう扱うか」で決まる
（TASK-103 の監査 §7）。**上流が持っている値が誤っている**（文字化け・列ずれ・
史実と食い違う宗主）場合はビルド時の `propertyFixes` で正す。**上流がその関係
そのものを欠いている**場合、つまりデータに無い封建関係を足す場合はランタイム側の
`suzerains`（decision-19、`Britany` → `France`）が担当する。前者は元データの誤り
の訂正、後者は元データへの追加なので、後者だけが decision-19 の「歴史的に明白な
関係に限る」判断を要する。

空の `SUBJECTO` / `PARTOF`（上流は独立勢力をこれと自己参照の 2
通りで持っている）は、切り出しの後に `normalizeSubjectProps` が `NAME`
で埋めて自己参照側へ揃える。空も自己参照も色キー・宗主キー・表示ラベルは
同じ結果になるので表示は変わらず、「空か自己参照か」で分岐する読み手を無くすための
正規化である。

`NAME` が空の feature（各年代 16〜40 件・描画面積の 0.1〜3.8%）は、`NAME` /
`ABBREVN` / `SUBJECTO` / `PARTOF`
のいずれも空＝上流がどの勢力にも帰属させていない土地なので、名称を与えず隣接勢力にも
帰属させず、無名・中立色（`DEFAULT_FILL_COLOR`）で描く。島の地理名を勢力名として
入れると凡例・ラベル上で国家に見え、面積閾値で隣国へ吸収させると出典の無い帰属を
作ることになるため。欠落の記録は `data/known-limitations.json` の
`base-unattributed-areas`（#328 以降は開発者向け記録で、UI には出さない）、
退行検出は `scripts/base-properties_test.ts`。

## 5. UI/UX 仕様

### 5.1 タイムラインスライダー

- デスクトップ（幅 481px 以上かつタッチ横持ち条件外）は画面左端の垂直中央帯に
  縦向きで固定配置（上=古い / 下=新しい。TASK-25）。**目盛りはデータが実在する
  20 年代のみ**の離散スライダー（間の年は選択不可）
- スマートフォン（幅 480px 以下、またはタッチ主体で高さ 480px 以下の横持ち。
  `app.css` の小画面ブレークポイント）は、年号・前後ボタン・横スライダーを 1
  段に収めた横バーを **Safe Area 直上の画面最下部**に固定配置する（#284 の
  案C。左=古い / 右=新しい。`env(safe-area-inset-bottom)` でホーム
  インジケーターを避ける）。前後ボタン・スライダーのタップ領域は 44px 以上
- 操作: ドラッグ / 目盛りクリック / 前後ボタン / キーボード `←` `→`
- 現在年を大きく表示（例: `1492`）。年代切替時は GeoJSON を
  fetch（取得済みはメモリキャッシュ）してレイヤー差し替え
- 切替時にポリゴンをフェード（deck.gl の
  `transitions`）させ、変化を視覚的に追いやすくする

### 5.2 地図インタラクション

- ホバー: 勢力名（`NAME`、`SUBJECTO` があれば「NAME — SUBJECTO
  領」）をツールチップ表示
- クリック: 同情報をパネル表示（モバイルではホバー代替）
- **選択中の勢力の年代別説明（Issue #283、案A）**: パネルの 1 行目は「日本語名 +
  現在の年代（弱い文字）」、区切り線の下にその勢力・年代に対応した**一文要約**を
  出す。説明は表示コードへ直書きせず、`data/power-descriptions.json`（年代 ×
  補正後の内部名 = 英語 `NAME`）で管理し、`src/power_descriptions.ts` の
  `powerDescriptionFor`（純粋関数）が引く。キーを日本語の表示名にしないのは
  `data/name-ja.json` の訳語を変えただけで紐付けが壊れるため。解決順は
  ラベル整形（`displayLabel`）と同じ「`NAME` → `name-overrides.json` の
  `renames` で正規化 → 表を引く」で、日本語表記は表示だけに使う
  - **年代を変えると説明も切り替わる**。同じ勢力でも年代ごとに別のエントリを
    持てる（`years` 配列で複数年へ同じ文を割り当てることもできる）
  - **未登録の対象は名称（+ 年代）だけへ安全に縮退する**。空の区切り線も、別の
    年代の説明も出さない（区切り線は説明欄自身の `border-top` なので、説明欄を
    畳めば線ごと消える）。収録は主要勢力から段階的に行っており、カバレッジと
    執筆方針は `docs/data-inventory/power-descriptions.md` が正
  - **年代別説明を持つのは政治勢力レイヤーだけ**（base 勢力 + 領邦・主権政体
    オーバーレイ）。河川・都市・山脈・山峰は名称（+ 標高 /
    人口）だけの従来表示の
    ままで、**年代も出さない**（年代を添えると「年代で内容が変わる」という誤った
    含意が生まれる。山岳・河川は年代非依存の地形、都市の人口は既にラベル側で
    年代を反映している）
  - 説明文は**定説として確立した範囲の一般的な characterization
    に限る**。具体的な 年号・数値・人名の逸話は書かない。根拠の所在は
    `docs/data-inventory/power-descriptions.md` §6
- **出典・ライセンス・境界・コミットはパネルに出さない（Issue #283 AC5）**。
  TASK-109 でパネルへ出していた 4 行は、アトリビューション（ⓘ）へ役割を
  寄せた。パネルは「選択対象を理解するための小さな面」に徹し、出典の全文
  照会は右下の ⓘ から辿る（#328）
  - **データ側の出典 metadata は従来どおり維持する**。各 FeatureCollection の
    `metadata`（`scripts/build-attribution.ts` が生成）・ビルド時の出典情報・
    リポジトリ内の帰属記録（`docs/data-inventory/`）はいずれも削除していない。
    `src/pick_handlers.ts` の `pickedMetadata` も feature
    単位の出典解決経路として 残してある（借用面の出典解決 = ADR-0033 を含む）
- **都市の第 2 のデータソース（#222）**: 都市は Buringh (2021)「European urban
  population, 700–2000」（DOI `10.17026/dans-xzy-u62q`、CC0-1.0）を主ソース、
  従来の Reba et al.（Chandler 系列、CC BY 4.0）を Buringh に無い都市
  （ニシャプール・カイラワーン等、主に欧州外縁）の補完とするハイブリッド。
  名寄せは正式名 → 別名列 → 座標 15km の 3 段で、同一都市が両ソースから
  二重表示されることはない。`data/cities.json` は正規化形式（都市配列 + 年別の
  `[index, population(, natureOfEstimate)]` セル + `sources` 配列）
- **諸侯領の第 2 の出典（TASK-110、decision-26）**: OHM 由来の諸侯領には年代・
  地域による大きな欠落があり（1000 / 1100 年のフランスはアキテーヌ公領も
  トゥールーズ伯領も王領も無く王国一枚岩、1200〜1492 年の帝国はバイエルン公領が
  一度も出ない）、`data/cliopatria_fiefs_flat_<year>.geojson`（Cliopatria / CC
  BY 4.0）で埋める。**用途は「OHM の欠落を埋める補完」に限定**し、OHM が
  同じ領邦を同じ年代で収録している場合は常に OHM を優先する（Cliopatria の
  境界は 0.07 度平滑化で頂点密度が OHM の 1/4〜1/7）。同じ領邦が両方の出典で
  描かれることはない
  - レイヤーは独立させる。1 つの FeatureCollection に 2 出典を混ぜると、
    データセット単位で保持しているトップレベル `metadata` が 2 出典・ 2
    ライセンスを主張することになり、CC BY 4.0 の帰属要件を満たせない
  - Cliopatria
    レイヤーには**仏諸侯領と帝国領邦が同居する**。ラベル色・境界線色は
    出典ではなく系統の記号（臙脂 = 帝国域内の領邦・藍紫 = 諸侯領）なので、
    レイヤー一律ではなく `SUBJECTO ?? PARTOF === "Holy Roman Empire"` で
    **feature ごとに**出し分ける。そうしないと 1400 / 1492 年に Cliopatria
    由来の バイエルンだけ藍紫・隣の OHM
    由来領邦は臙脂という凡例の破れが同一画面に出る
  - 充填後も残る空白（1200 年の帝国中核 507,304 km² = 帝国の 81.3% 等）は
    `data/known-limitations.json` と `docs/data-inventory/README.md` §3.11 に
    実測値つきで記録する
  - パネルは縦に伸びるため `.info-panel` にも `max-height` / `overflow-y: auto`
    / `box-sizing: border-box` を入れてある（TASK-117 と同じ設計）
- **山岳（TASK-100）**: 山脈は**名称のみ**（`アルプス山脈`）、山峰は**名称 +
  標高**（`モンブラン 4807m`）をホバー/クリックで出す。山脈のポリゴンは標高を
  持たず、山脈に単一の標高という概念も無い（それは山峰の属性）ため。地図上の
  山峰ラベルは衝突ボックスを小さく保つため z7 未満で標高を隠すが、ツールチップ
  とパネルは衝突空間の外なので常に標高を出す。山岳は年代非依存の地形なので、
  **年代を切り替えても内容は変わらない**（整形関数が year を引数に取らないこと
  をテストで固定している）
- **都市（Issue #221 / #222）**: **名称 + 人口**（`パリ 人口約200,000人`）を
  ホバー/クリックで出す（`src/cities.ts` の `cityPickLabel`。山峰の
  `peakPickLabel` と同型の純粋関数）。人口不明（`population: null`）は名称のみ。
  人口は上流（Buringh / Chandler）の時点で推定値なので常に「約」を付し、
  桁区切りは ja-JP ロケール。**補間値**（`cities.json` の
  `natureOfEstimate: "imputed"`。スナップショット年に実測記録が無く生成側が
  対数線形補間で埋めた値、および Buringh が「補完」と宣言する値）は末尾に
  **`（補間値）`** を、**代理推定**（`natureOfEstimate: "proxied"`。Buringh が
  人口記録以外の代理指標から推定した値）は末尾に **`（代理推定）`** を付し、
  実測記録由来の人口と区別できるようにする（#221 AC3 / #222）。
  `natureOfEstimate` の欠落・未知語彙はマーカーなし（= フラグの無いデータでも
  従来表示が成立する縮退）。地図上の都市名ラベル（`city-labels`）には人口を
  出さない（衝突ボックスを太らせないため。山峰の標高が z7 未満で隠れるのと
  同じ理由の恒久版で、人口はツールチップ/パネル のみ）
- **山岳の強調（TASK-100）**: オリーブ
  `#5F7A1E`。山脈は**輪郭のみ**（塗らない）、 山峰は記号の色とサイズ（11px →
  15px）を変える。塗りにしないのは、勢力の
  アクティブ塗りと同じ視覚言語になり両方出たときに読み分けられなくなるため。
  「輪郭 対 塗り」は色相だけでなく**記号の種類**で区別する。色相は既存の 4 色
  （HRE 外縁の臙脂 0°・勢力アクティブ塗りの緑青 167°・河川強調の青灰 200°・
  諸侯領境界の藍紫 262°）のいずれからも 60° 以上離れており（オリーブは 78°）、
  この分離は単体テストで固定している
- **アクティブ強調（勢力・領邦ポリゴン。TASK-90。実装は
  `src/power_highlight.ts`）**: ホバー/クリックした勢力・領邦の塗りを
  アクティブ色へ変え、国土（領域）の広がりを面で示す
  - 適用単位は **勢力キー単位**（`colorKeyFor` = `NAME` または
    `NAME|SUBJECTO`）。飛び地・島嶼で複数 feature に分かれる勢力も同時に光る。
    HRE 領邦・仏諸侯領は親勢力とは別キーなので独立に強調される
  - 保持・解除規則は河川の選択トグルと同一（`togglePowerSelection`）: 同一対象の
    再クリックで解除・別対象のクリックで移動・河川/都市/何も無い場所のクリックで
    解除・年代切替で解除。ホバーは選択と独立で、ホバーが外れても選択は残る
    （ホバーの無いタッチ操作でもクリックだけで強調が成立する）
  - 状態変化は「値が変わったときだけ」レイヤーを再構築する
    （`createPowerHighlightStore` の変化検知。`mousemove` ごとの再構築を避ける）
- **勢力圏の外枠（TASK-30 / TASK-94 / TASK-120。実装は
  `src/suzerain_extent.ts`、レイヤー `hre-extent`）**: ホバー/クリックした勢力の
  「宗主キーに属する全 feature（本体 + 従属）の union の外縁」を臙脂の太線 +
  ごく薄い塗りで囲み、宗主と封臣が 1 つの勢力圏であることを示す
  （`pickable: false` で picking には非関与）
  - 宗主キーの解決順は 宗主補正テーブル > `SUBJECTO`（`renames` 正規化）>
    `NAME`。独立勢力は自分自身のキーになるため、外枠は自分だけを囲む
  - 宗主補正テーブル（`data/name-overrides.json` の `suzerains`）は base の
    `SUBJECTO` が史実の封建関係を欠く場合の補正（現在は `Britany` → `France`
    のみ）。取得直後のデータの `SUBJECTO` を書き換える形で適用するため、外枠
    だけでなく色キー（`colorKeyFor`）・表示ラベル（`displayLabel`）・
    `colors.json` の生成も同じ関係を反映する。歴史的に宗主関係が明白で
    データが欠くものに限り最小限に留める
  - 外枠の形（union）の入力は base（`europe_*`）と、その勢力圏に属する
    **沿岸補完の帯**（`coastal_fill_<year>`。#330）。領邦オーバーレイは base
    の内側を細分するだけで勢力圏の外縁を広げないので入力に含めない。
    アンジュー帝国は base のとおり独立勢力として扱い、英本土と大陸領が一体の
    外枠になる（フランス王国の外枠には入らない）
  - 帯を入力に足すのは、画面上でその勢力の面として塗られるのが「元ポリゴン +
    帯（海面・内水面でマスクされた残り）」であり、ホバー/選択では帯も同じ
    アクティブ色へ切り替わるため（#330）。元ポリゴンだけを union すると、
    歴史ポリゴンが現代海岸線より内側にある区間で緑青が臙脂線の外へ広がり、
    赤線が領域の内部に取り残される（実測: 1815 年プロイセンでアクティブ面の
    8.8%・1880 年ドイツで 7.0%）。帯を融合すると元の概略海岸線は内部境界として
    消え、外縁が「実際に塗られる面」の縁と一致する。沿岸で臙脂線を出さない
    区間の海岸表現はベースマップの `coastline` が担う（帯の外縁は海側にあり 海洋
    `water` が覆うため）
  - 帯が未取得の間（年代 GeoJSON より後から届く）と、帯を描かないスタイル
    （水面レイヤーの無いフォールバック）では帯を合流させず、従来どおり元
    ポリゴンだけの外枠になる。帯が確定した時点で `requestRender` により外枠を
    組み直す
  - **picking 側の対象レイヤーは 4 つ**（TASK-120）。`powers`（base）と
    `hre-powers` は全 feature が `SUBJECTO` を持つので上の解決順でそのまま
    決まる。仏諸侯領（`france-fiefs`）と Cliopatria 由来の領邦
    （`cliopatria-fiefs`）は上流が `SUBJECTO` を持たないものが多いため、
    宣言が無いときだけ **「その封土を包含する base 勢力の宗主キー」**
    （`containingSuzerainKey`）へ落とす。包含判定はラベルのアンカー
    （`labelAnchorFor` = 最大ポリゴンの pole of inaccessibility）の
    point-in-polygon で、「封土名が描かれている点を含む勢力が囲まれる」という
    目視できる規則になる。伊諸侯領（`italy-fiefs`）は TASK-121 の対象で当面
    外枠を出さない
  - 諸侯領に宗主を持たせる手段として `suzerains` へ封土名を足す案は採らない。
    `suzerains` は `SUBJECTO` の書き換えとして色キーにも効くため、仏封土 33 件
    を足すと全封土の色キーが `"NAME|France"` になり、属領規則（宗主国色の明度
    シフト、§4.3）で 33 件が単一色へ潰れる（実測: `colors.json` の `"|France"`
    キー 39 件がユニーク色 1 件、無関係な 118 キーも決定的プロービングの
    玉突きで変色）。諸侯ごとに色を分ける TASK-71 / decision-5 の設計と衝突する
  - この規則の帰結として、base 側の帰属がそのまま外枠に出る。1200 年の
    アンジュー帝国領内の封土（Anjou・Maine・Poitou など）はフランス王国では
    なくアンジュー帝国が囲まれ、1000/1100 年のノルマンディー（TASK-101 で 独立
    feature 化）は公国自身が囲まれる。base の帰属が史実とずれている
    ケースはここではなく base 側（切り出し §4.4 と `propertyFixes` §4.5・
    decision-20）で正す問題として切り分ける（1279/1300 年の Artois・
    Saint-Pol・Flanders・リミニが神聖ローマ帝国側に塗られていた件は TASK-124
    がこの経路で是正した）
  - union は選択時オンデマンド計算 + 宗主キー単位のメモ化
    （`createSuzerainExtentCache`）。picking 側の宗主キー解決も `memoizeLatest`
    で 1 スロット覚え、同じ封土上の `mousemove` では 包含判定を再計算しない
- **強調色の使い分け**（`ACTIVE_FILL_COLOR` は TASK-73 / TASK-74
  の褪せ顔料・古地図トーンに揃えた緑青。既存の強調色とは色相が 60
  度以上離れており、同時に出ても読み分けられる。単体テストで固定）:

  | 記号                 | 色                          | 意味                                    |
  | -------------------- | --------------------------- | --------------------------------------- |
  | 塗り（緑青 #68a094） | `ACTIVE_FILL_COLOR`         | いまホバー/選択している勢力・領邦の国土 |
  | 外縁の太線（臙脂）   | `HRE_EXTENT_LINE_COLOR`     | 宗主に属する勢力圏の外枠（TASK-94）     |
  | 細い境界線（藍紫）   | `FIEF_LINE_COLOR`           | 仏諸侯領の区画（TASK-71）               |
  | 河川ライン（赤茶）   | `RIVER_SELECTED_LINE_COLOR` | 選択中の河川（TASK-24 / TASK-42）       |

  塗りの alpha は通常塗り（`FILL_ALPHA` = 128）より高い 214
  にし、勢力ごとの固有色を実質的に覆って「1 つの面」として読めるようにする。
  完全不透明にはせず、下地の陰影・概略境界・領邦境界は残す

#### 強調中のラベル判読性（TASK-93）

アクティブ塗りは半透明なので、その上に載るラベルの実背景は「アクティブ塗り
＋羊皮紙の下地（`earth` #f0e6cd）」の合成色になる。判読性はこの合成色と
文字色のコントラスト比で評価し、色計算は `src/contrast.ts`（WCAG 2.1 の
相対輝度・コントラスト比）、基準値は `src/labels.ts` の定数として持ち、
`src/label_contrast_test.ts` が実際の配色に対して検証する。

| 基準値                              | 値    | 対象                    | 根拠                                                                                                                     |
| ----------------------------------- | ----- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `MIN_ACTIVE_LABEL_CONTRAST`         | 4.5:1 | 強調中の国名・諸侯領名  | WCAG 2.1 AA の通常テキスト基準。ラベルは 14px・weight 600 で「大きめテキスト」（24px 相当）には届かないため 3:1 では緩い |
| `MIN_SECONDARY_LABEL_CONTRAST`      | 3:1   | 強調塗りの上の都市名    | 色を切り替えない副次ラベル。塗り側の明度調整だけで満たせる水準として大きめテキスト相当を下限に置く                       |
| `MIN_HALO_LABEL_CONTRAST`           | 7:1   | 文字色 vs クリーム halo | TASK-72 以降、輪郭による判読の担保は halo。強調時に文字を明色へ振って halo と同化させないための下限                      |
| `MIN_HIGHLIGHT_VISIBILITY_CONTRAST` | 1.8:1 | アクティブ塗り vs 下地  | 塗りを明るくしすぎて強調自体が下地に埋もれるのを防ぐ上限側の歯止め（TASK-90 の目的との両立点）                           |

対処は塗りとラベルの両面で行う。

- **塗り**: `ACTIVE_FILL_COLOR` の明度を上げる（#2e6e66 → #68a094。色相 ≒167° と
  alpha 214 は不変なので TASK-90 の識別性・被覆性は保たれる）。
  これは色を切り替えない都市名・河川名にも効く唯一の手段でもある
- **ラベル**: 強調中の勢力・領邦のラベルだけ、同じ色相のまま暗く沈めた色
  （`ACTIVE_BASE_LABEL_COLOR` / `ACTIVE_HRE_LABEL_COLOR` /
  `ACTIVE_FIEF_LABEL_COLOR`）へ切り替える。色相を変えないので「濃グレー = 独立国
  / 臙脂 = 帝国 / 藍紫 = 諸侯領」（TASK-30 / TASK-71）の読み分けは
  強調中も保たれる。判定単位は塗りと同一の強調キー（`LabelDatum.key` =
  `colorKeyFor`）で、飛び地のラベルも同時に切り替わる。強調キーは
  ラベルデータ生成時に確定し強調状態に依存しないため、ホバーで polylabel の
  メモ化（TASK-50）が無効化されることはない

基準値の判定は「アクティブ塗り + `earth` 単色」を実背景とみなすモデルで行う。
実画面では地形陰影（hillshade）や landcover が下地をさらに暗くするため、実測値は
モデル値より 0.2〜1.2 ほど低く出る（ヘッドレス CDP のスクリーンショットから
ピクセルを実測。国名 6.5:1 / 諸侯領名 6.1:1 / HRE 領邦名 3.9〜4.1:1 / 都市名
3.0:1）。この差は強調の有無に関わらず全ラベルに等しく掛かるもので、同じ地点の
通常表示（国名 8.4:1 / 諸侯領名 7.7:1 / HRE 領邦名 2.9〜3.8:1 / 都市名 4.4:1）
との比較でも強調中の判読性が通常時を下回らないことは保たれる。陰影まで含めて
基準を満たそうとすると塗りを更に明るくするしかなく、上表の 1.8:1 と両立しない。

河川名は対象外とする。水色（`RIVER_LABEL_COLOR`）は緑青の塗りと同じ寒色域で、
基準を満たす合成背景を作ろうとすると塗りが下地に埋もれる（上表の 1.8:1 と
両立しない）。河川名・都市名は強調キーを持たず、強調塗りとの重なりを知るには
ラベルごとの点-ポリゴン判定が要るため、判読はクリーム halo に委ねる。

- picking の優先順位は `src/picking.ts` の `PICKING_PRIORITY`（河川 > 都市 >
  山峰 > 都市ヒット層 > 山峰ヒット層 > 山脈ヒット層 > 河川ヒット層 > HRE 領邦 >
  仏諸侯領 > 伊諸侯領 > 勢力）で一元管理し、deck.gl のレイヤー描画順（配列の
  後ろほど上 = 優先）をこの逆順から導出する。整合は
  `layerOrderMatchesPickingPriority` が `renderLayers` 実行時に毎回検証する
  - 並びは 2 つの原則から決まる。**可視の記号は透明な判定層より上**（TASK-49 で
    `cities` を `rivers-hit` の上に置いたのと同じ規則。山峰の `▲` も可視記号
    なので 4 つの判定層より上）、**判定層どうしは主題としての重み順** （都市 >
    山峰 > 山脈 > 河川。`rivers-hit` が最下位なのは、幅 14px の帯が
    構造的に点状の対象を飲み込むため。TASK-49 の不具合の再発防止）
  - **山岳 3 層はいずれも `powers` より上**（TASK-100）。`powers` より下は
    「決して pickable
    にならない」と同義で（陸地は勢力ポリゴンに覆い尽くされる）、
    山脈・山峰が拾えなくなる。既存の picking を妨げないのは、山岳の当たり領域が
    山体ポリゴンではなく**点のまわりの円**だからである（次項）
- **実効判定範囲（ホバー/クリックの許容ずれ）**: 細いライン・小さなドットは
  中心線/中心点だけでは掴みにくいため、可視レイヤーと同一データを
  「完全透明・太幅（河川）/ 大半径（都市）」で描く**判定専用レイヤー**
  （`rivers-hit` / `cities-hit`）を重ね、カーソル直下 pick
  だけで余裕のある判定範囲を得る。合成値は定数として固定し、単体テストで
  導出関係ごと検証する:

  | 対象 | 可視の大きさ           | 判定層                           | 近傍再ピック     | 実効範囲（定数）                  |
  | ---- | ---------------------- | -------------------------------- | ---------------- | --------------------------------- |
  | 河川 | 線幅 3px（半幅 1.5px） | `rivers-hit` 幅 14px（半幅 7px） | 加算する（+6px） | `RIVER_CLICK_TOLERANCE_PX` = 13px |
  | 都市 | ドット半径 3px         | `cities-hit` 半径 9px            | 加算しない       | `CITY_PICK_TOLERANCE_PX` = 9px    |
  | 山峰 | `▲` 11px               | `peaks-hit` 半径 10px            | 加算しない       | `PEAK_HIT_RADIUS_PX` = 10px       |
  | 山脈 | 可視の点記号なし       | `mountains-hit` 半径 18px        | 加算しない       | `MOUNTAIN_HIT_RADIUS_PX` = 18px   |

  - 山峰は `▲` 自体も pickable だが、判定層が要る。TextLayer の picking は
    不透明なグリフのピクセルにしか当たらず、三角形の頂点は 1〜2px しか幅が
    無いので「記号を狙う」操作が構造的に外れるため
  - **山脈の当たり領域はラベルのアンカー（polylabel）を中心とする円で、山体
    ポリゴンではない**（TASK-100）。ポリゴンを使うと `powers` より上では
    スイス・オーストリア・北イタリア一帯のクリックを奪い、下では決して
    拾えない。どちらかの AC を必ず壊すので、名前が描かれている場所そのものを
    的にして対象を 17 個の円に限った。18px（都市の 9px より大きい）なのは、
    山脈には常時見える点記号が無く狙う目印が無いため。実測で外周 ±16px までが
    山脈、±20px 以上で下の勢力に戻る

  - 近傍再ピック（`PICKING_RADIUS_PX` = 6px の `pickMultipleObjects`）は
    クリック時のみ・カーソル直下が河川系/都市系でない場合のみ行う。ホバーは
    `mousemove` ごとのコストを避けるため直下 pick のみ（TASK-36 の設計判断）
  - 都市はこの再ピックの候補から `cities-hit` を除外する
    （`isNearCursorRepickable`）。除外しないとクリックだけが 15px
    まで広がり、ホバー（9px）との非対称が残るため。結果、都市はホバー・
    クリックとも 9px で一致する（TASK-82）
  - 都市名ラベル（`city-labels`）は `pickable: false`
    のまま。マーカーから独立に動く（衝突フィルタで間引かれ、オフセット配置
    される）ため、ラベルを当たり判定にすると「見えているのに拾えない/
    見えていないのに拾える」が起きる。判定の基準はマーカー中心のみとする
- ズーム範囲: z4〜z8
  に制限（ヨーロッパ域の閲覧に不要な過剰ズームを防ぎ、simplify
  済みデータの粗さを露呈させない。z4 はヨーロッパ全域が一望できる下限で、
  これより外へはズームアウトできない）
- パン範囲: ヨーロッパ域 `[[-25, 34], [60, 72]]`（データパイプラインの
  EUROPE_BBOX と同値）を MapLibre の `maxBounds` に設定し、圏外へは
  パンできない。URL クエリで範囲外の center/zoom を与えた場合も
  この範囲内へクランプして表示する
- 初期表示: ヨーロッパ全域（center ≈ [15, 50], zoom 4）、初期年代は 1000 年

### 5.3 URL 状態共有

`?year=1300&zoom=4.5&center=15.0,50.0` 形式で年代・視点を URL
に反映（`replaceState`）。URL
を開くと同じ表示が再現される（`map-rendering-research.md` §5 の worldmonitor
パターン）。

### 5.4 その他

- **地図上の常設 UI はタイムスライダーと右下のアトリビューション「ⓘ」だけ**
  （Issue #328「案A: 統合アトリビューション」）。左上に置いていた独自の
  ⓘ（出典・免責。TASK-26 / #284）と ⚠（データ制限一覧。TASK-46）は撤去した
  - ⓘ は MapLibre 標準の `AttributionControl`（`compact: true`）で、
    OpenStreetMap / Protomaps / Terrain Tiles の source attribution は従来
    どおり自動収集する。歴史データ（historical-basemaps / ETH Zürich (Roller) /
    Cliopatria / Reba et al.）の出典・ライセンスと、派生データへの変更表示は
    `customAttribution` で同じ ⓘ へ統合する（文言は
    `src/map_attribution.ts`）。CC0 / パブリックドメインのデータセットは
    帰属表示が法的に不要なため載せない
  - 起動直後は折りたたんだ状態にする（MapLibre は `compact` でも初期表示を
    展開にするため、`src/main.ts` が明示的に畳む）。開閉は `<details>` /
    `<summary>` の標準動作なので、キーボード操作と展開状態の通知はブラウザ
    標準の disclosure として機能する。`aria-label` は locale 差し替えで
    日本語にする
  - 展開した本文は高さ・幅に上限を持ち、収まらない分は本文が内部スクロール
    する（スクロール終端で背後の地図へ伝播しない =
    `overscroll-behavior:
    contain`）。スマートフォンでは最下部タイムラインバーの直上にアンカーし、
    ⓘ と本文リンクは 44px 相当のタップ領域を確保する
  - **境界精度の免責とデータ制限一覧はユーザー向けに表示しない**。
    `data/known-limitations.json` は開発者向け記録として維持するが、
    クライアントは取得も描画もしない（配信物にも含めない）
- ローディング中はスピナー表示。GeoJSON fetch 失敗時はエラートーストと再試行
- deck.gl チャンク（#247 で分割した後続チャンク）の取得に失敗した場合も同じ
  トーストで告知する（#319）。この失敗はオーバーレイ（政治境界・都市・河川・
  山岳）が一切出ない縮退で、失敗した動的 import は同一文書では再フェッチ
  されないため、年代データの失敗と違い再試行では復帰しない。よって文言は
  「地図オーバーレイの読み込みに失敗しました。ページを再読み込みしてください」
  とし、ボタンも「再読み込み」（実体は `location.reload()`）にする。両方が
  同時に失敗している場合はチャンク側を優先して表示する。失敗の種別は トーストの
  `data-error-kind` 属性（`chunk` / `data` / `none`）で公開し、
  ヘッドレス検証（`scripts/verify/cdp.ts`）が「再 navigate で復帰し得る停止」
  と「アプリの確定失敗」を区別できるようにする

## 6. セキュリティ・運用

セキュリティ・運用の詳細方針は再検討中。現時点の要点:

- **install script 無効化**（Deno デフォルト / npm `allowScripts`）
- **minimum release age**: Renovate で通常 7 日・patch 3
  日のクールダウン。自動マージ無効
- **lockfile コミット必須**。コア依存（maplibre-gl / deck.gl / pmtiles）の更新は
  diff 目視レビュー
- **CSP**: 完全静的なので厳格に絞れる
  - `connect-src`: 自ドメイン + R2 タイル配信ドメイン +
    フォールバックタイル（OpenFreeMap）+ Web Analytics 計測送信先
    （`cloudflareinsights.com`）のみ
  - `script-src 'self' https://static.cloudflareinsights.com`
    （インラインスクリプトなし + Web Analytics
    beacon）、`worker-src 'self'
    blob:`（MapLibre/deck.gl の Worker 用）
- **Web Analytics**: Cloudflare Web Analytics を使う（#299）。Cloudflare が
  配信時に beacon（`static.cloudflareinsights.com/beacon.min.js`）の `<script>`
  を自動挿入する仕組みをそのまま活かし、CSP は beacon 用の 2
  ホストのみ追加で許可する（`script-src` に配信元
  `static.cloudflareinsights.com`、`connect-src` に計測送信先
  `cloudflareinsights.com`。Cloudflare 公式 CSP リファレンスの要求値）。 根拠:
  無効化はダッシュボード操作が必要で計測も失われるのに対し、許可は
  コード変更のみで完結し、追加する許可先も Cloudflare 管理の 2 ホストに
  限定できる
- **CI**: ビルドステップに本番シークレットを渡さない。デプロイは Cloudflare
  Pages の分離されたステップで実施

## 7. 将来拡張

1. **戦史レイヤー**:
   戦場マーカー（ScatterplotLayer）・進軍ルート（PathLayer）・補給線（ArcLayer）を年代フィルタ付きで追加。`map-rendering-research.md`
   §4
   の推奨アーキテクチャどおり、ベースマップ・国境レイヤーには手を入れずデータレイヤーの追加のみで実現できる
2. **補間アニメーション**: スナップショット間のクロスフェード自動再生
3. **年代の追補**: historical-basemaps
   へのコントリビュート、または独自スナップショットの追加（例: 962
   神聖ローマ帝国成立、1453 コンスタンティノープル陥落）
4. **ズーム適応表示・クラスタリング**: 戦史レイヤー導入時に worldmonitor
   パターン（`map-rendering-research.md` §5）を適用
