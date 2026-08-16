# Architecture Decision Records (ADR)

タスク横断で影響する設計判断を Architecture Decision Record として記録する。
運用ルール（記録する判断・しない判断の基準、記録タイミング）は
`docs/development-style.md` 2.1 章を参照。

## 採番規約

- 本ディレクトリは backlog CLI 管理だった decisions（`backlog/decisions/`
  の decision-1〜30）の後継である。移設の経緯は
  [0031](0031-migrate-task-management-to-github-issues.md) を参照。
- ADR 番号は decision-N の N をそのまま保持する（例: decision-20 →
  `0020-property-fixes-for-upstream-attribution.md`）。既存ドキュメント・
  タスク・コミットからの `decision-N` 文字列参照は移設後も番号で引ける。
- 新規 ADR は既存の最大番号の次から連番で採番し、`docs/adr/00NN-<slug>.md`
  （slug は英語ケバブケース）として直接作成する。backlog CLI は使わない。
- frontmatter は `status`（accepted / superseded 等）と `date` のみ。
  タイトルは本文 H1 に `# decision-N: <タイトル>` の形式で書く。
- 本文は `## Context` / `## Decision` / `## Consequences`
  を基本構成とする（必要に応じて「検討した代替案」等の節を追加してよい）。

## 一覧

| 番号 | タイトル | status |
| --- | --- | --- |
| [0001](0001-historical-basemaps-pinned-commit.md) | 勢力圏データソースに aourednik/historical-basemaps をコミット固定で採用 | accepted |
| [0002](0002-hre-roller-nc-data-file-separation.md) | HRE 領邦データ（ETH Zürich Roller・CC BY-NC-SA）は GPL 派生データとファイル分離 | accepted |
| [0003](0003-natural-earth-rivers-pinned-mirror.md) | 河川データに Natural Earth 50m rivers をコミット固定ミラーから採用 | accepted |
| [0004](0004-reba-2016-historical-urban-population.md) | 都市データに Reba et al. 2016 Historical Urban Population（CC BY 4.0）を採用 | superseded |
| [0005](0005-deterministic-color-probing.md) | 色割当は決定的プロービングで生成し HRE 領邦は独立色化する（[0032](0032-colors-snapshot-additive.md) で一部追補） | accepted |
| [0006](0006-japanese-labels-via-name-ja-json.md) | 日本語表記はデータを英語のまま維持し表示層で name-ja.json を適用する | accepted |
| [0007](0007-deck-level-event-aggregation.md) | ホバー・クリックは deck.gl レイヤー順（河川 > 都市 > 国名）と Deck レベルイベント集約で扱う | accepted |
| [0008](0008-parallel-tasks-by-area-labels.md) | タスク間並列は area ラベルと next-tasks による決定的集合判定で行う | accepted |
| [0009](0009-river-rendering-deck-overlay-only.md) | ベースマップの水系ライン描画を廃止し河川表示を deck オーバーレイへ一本化 | accepted |
| [0010](0010-agent-loop-quantitative-escalation.md) | agent-loop の実装難航は定量上限（CI red 3 連続・subagent 5 試行・24 時間・停滞検出）で強制エスカレーションする | accepted |
| [0011](0011-headless-cdp-verification-standard.md) | 動作確認はヘッドレス Chrome + CDP を標準とし claude-in-chrome は最終手段とする | accepted |
| [0012](0012-agent-loop-single-session-precheck.md) | agent-loop は開始前の単一セッション事前チェックを必須とし、暴走時は daemon ジョブの無効化で停止する | accepted |
| [0013](0013-ohm-french-principalities.md) | 中世フランス諸侯領データに OpenHistoricalMap（CC0・Overpass API）を採用し欠落は明示する | accepted |
| [0014](0014-no-unsourced-coordinate-synthesis.md) | 出典を持たない座標合成は行わず、ソース欠落は既知の制限として明示する（エルベ河口） | accepted |
| [0015](0015-layer-stack-centralized-ordering.md) | deck レイヤーの重ね順は layer_stack.ts で一元管理し、政治ポリゴンは水面下・ラベルは overlaid 分離とする | accepted |
| [0016](0016-approximate-borders-maplibre-line.md) | base 境界は概略境界として MapLibre line レイヤーで不確かさを表現する | accepted |
| [0017](0017-medieval-hre-ohm-adoption.md) | 中世 HRE・イタリア領邦は OHM（CC0）を採用し、1500〜1700 の HRE は Roller を維持する | accepted |
| [0018](0018-no-modern-department-polygon-synthesis.md) | 現代県ポリゴン合成による中世諸侯領の自作は行わない（出典なきジオメトリ生成の禁止を維持） | accepted |
| [0019](0019-suzerain-outline-subjecto-union.md) | 宗主-封臣の外枠は SUBJECTO 由来の宗主キー union とし、宗主補正は歴史的に明白な関係に限る | accepted |
| [0020](0020-property-fixes-for-upstream-attribution.md) | 上流データの帰属の誤りは propertyFixes で正し、suzerains は上流に無い関係の追加に限る | accepted |
| [0021](0021-binary-label-collision-fade.md) | ラベルの衝突フェードは二値化し、重なりの解消に COLLISION_SIZE_SCALE を使わない | accepted |
| [0022](0022-areal-features-anchor-circle-picking.md) | 面の地物は勢力より上で pickable にし、当たり領域をアンカー円に絞る | accepted |
| [0023](0023-name-overrides-upstream-vocabulary.md) | 消滅済み・過大な勢力の NAME は上流の語彙へ propertyFixes で上書きし、形状の限界は known-limitations で補う | accepted |
| [0024](0024-worktree-cleanup-restore-first.md) | subagent worktree の後始末は復元を通常経路とし、--force は loop の使い捨て足場に限定して許す | accepted |
| [0025](0025-confidence-b-dangling-suzerain-criterion.md) | 確度 B の帰属は「宙に浮いた宗主」を判定基準にして propertyFixes で正規化する | accepted |
| [0026](0026-cliopatria-second-territory-source.md) | Cliopatria（CC BY 4.0）を OHM の欠落を埋める第 2 の領邦データとして採用する | accepted |
| [0027](0027-principality-suzerain-by-base-containment.md) | 諸侯領の宗主は base の包含で決め、suzerains は色に効くため使わない | accepted |
| [0028](0028-base-fief-splits-for-buried-fiefs.md) | 帝国塗りに埋もれた封土の是正は BASE_FIEF_SPLITS の切り出しと propertyFixes を併用する | accepted |
| [0029](0029-main-ts-incremental-factory-extraction.md) | main.ts の分割は状態所有を残した純関数 + 依存注入ファクトリ抽出で段階実施する | accepted |
| [0030](0030-invisible-background-quads-self-collision.md) | 衝突参加の全ラベル層に不可視背景クアッドを敷き自己衝突を構造的に防ぐ | accepted |
| [0031](0031-migrate-task-management-to-github-issues.md) | タスク管理を backlog.md から GitHub Issue へ移行する | accepted |
| [0032](./0032-colors-snapshot-additive.md) | colors.json をスナップショット正とし build-colors を差分追加モードにする | accepted |
| [0033](./0033-borrowed-adjacent-year-geometry.md) | 上流に面が無い年へ隣接年の出典付きジオメトリを流用する条件（ADR-0014 / ADR-0018 の限定的な例外） | accepted |
| [0034](./0034-no-uk-constituent-countries.md) | 1815 年以降の UK 構成国は表示しない（内部行政区分は「勢力」として扱わない） | accepted |
| [0035](./0035-borrowed-geometry-flat-display.md) | 借用ジオメトリの表示は差引済み flat 派生物とする（ADR-0033 の追補） | accepted |
| [0036](./0036-agent-loop-external-reinjection-context-boundary.md) | agent-loop のコンテキスト境界は supervisor の外部再投入（idle 検知 → /clear → /agent-loop）で設ける | accepted |
| [0037](./0037-raw-fief-coordinate-precision.md) | raw 領邦データは上流精度（5 桁）で保持し、丸めは配信される派生側で一度だけ行う | accepted |
| [0038](./0038-political-label-dark-plate.md) | TASK-72 が禁じたのは「明るい不透明パネル」であり、政治ラベルは濃色・半透明・文字列単位のプレートで地色から分離する | accepted |
| [0039](./0039-cliopatria-borrowed-upstream-interval.md) | 上流データセットの隣接区間からの年借用を認め、CC BY 4.0 の面を BASE_FIEF_SPLITS の入力に使う（ADR-0033 の追補） | accepted |
| [0040](./0040-cliopatria-composite-parent-base-outline.md) | Cliopatria の括弧付き複合体を base 主権の外周置換に限って採る（ADR-0026 の適用範囲の拡張） | accepted |
| [0041](./0041-palette-earth-contrast-constraint.md) | パレットに羊皮紙下地とのコントラスト制約を課し、埋もれたキーだけを一回限り remap する（ADR-0032 の限定的な例外） | accepted |
| [0042](./0042-subtract-what-you-draw.md) | 差し引く geometry は描画する geometry と同一にし、塗り専用生成物は細片を捨てない | accepted |
| [0043](./0043-buringh-2021-primary-urban-population.md) | 都市データは Buringh 2021 を主ソースとし Chandler / Reba を補完に用いる | accepted |
| [0044](./0044-post-roller-hre-ohm-adoption.md) | Roller 終了後の近世 HRE 領邦データに OHM（CC0）を採用する | accepted |
| [0045](./0045-atlas-first-base-attribution.md) | base 帰属と低ズーム国名は歴史図譜の慣行を第一則として判定する | accepted |
