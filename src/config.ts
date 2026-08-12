/**
 * アプリ全体で共有する純粋データ定数。
 * 値の出典: docs/app-spec.md §5.2（地図インタラクション）・§2.1（年代スナップショット）
 */

/** 地図の初期中心座標 [経度, 緯度] */
export const INITIAL_CENTER: readonly [number, number] = [15, 50];

/** 地図の初期ズームレベル */
export const INITIAL_ZOOM = 4;

/**
 * 地図の最小ズームレベル。
 * TASK-22 でヨーロッパ全域がちょうど一望できる z4 に引き上げた（z3 では
 * ヨーロッパが画面の一部にしか映らないほど引けてしまう）。なお MAP_MAX_BOUNDS
 * 併用時、MapLibre は bounds 全体が収まるよう viewport 幅に応じて実効最小
 * ズームをさらに制限するため、広い画面ではこの値より寄った表示が下限になる。
 */
export const MIN_ZOOM = 4;

/** 地図の最大ズームレベル */
export const MAX_ZOOM = 8;

/**
 * 地図のパン・ズームを制限するヨーロッパ域の境界 [[西, 南], [東, 北]]。
 * MapLibre の LngLatBoundsLike 互換タプルで、Map の `maxBounds` にそのまま渡す。
 * データパイプライン側 scripts/build-data.ts の EUROPE_BBOX ([-25, 34, 60, 72])
 * と同値（src → scripts の import は行わない規約のため値を重複定義し、
 * 同値性は config_test.ts で担保する）。
 */
export const MAP_MAX_BOUNDS: [[number, number], [number, number]] = [
  [-25, 34],
  [60, 72],
];

/** タイムラインスライダーの初期年代 */
export const INITIAL_YEAR = 1000;

/**
 * ベースマップの PMTiles URL（同一オリジン配信の相対パス）。
 * 開発時は `deno task extract-pmtiles` で data/europe.pmtiles を生成すると、
 * scripts/build.ts が dist/europe.pmtiles にコピーして同一オリジンで配信する
 * （CORS 制約なし）。本番は Cloudflare R2 の絶対 URL に差し替える（TASK-10）。
 * 差し替えはこの定数 1 箇所で完結させること。
 */
export const BASEMAP_PMTILES_URL = "/europe.pmtiles";

/** MapLibre スタイル内でベースマップのベクタソースに付ける ID */
export const BASEMAP_SOURCE_ID = "basemap";

/**
 * 地形 DEM（terrarium エンコーディング・zoom 0〜8・EUROPE_BBOX 域）の
 * PMTiles URL（同一オリジン配信の相対パス）。TASK-34 の hillshade 表現に使う。
 * DEM アーカイブは任意生成: `deno task extract-dem` 等で data/europe-dem.pmtiles
 * を生成した場合のみ dist 直下へコピーされ配信される。存在しない環境では
 * 取得エラーになるが、hillshade なしの従来表示で継続する（フォールバックは
 * 発動しない。src/fallback.ts 参照）。
 */
export const DEM_PMTILES_URL = "/europe-dem.pmtiles";

/** MapLibre スタイル内で DEM（raster-dem）ソースに付ける ID */
export const DEM_SOURCE_ID = "dem";

/**
 * PMTiles 取得失敗時のフォールバック先スタイル URL（OpenFreeMap Liberty）。
 * API キー不要・無料。docs/map-rendering-research.md §2 参照。
 */
export const FALLBACK_STYLE_URL =
  "https://tiles.openfreemap.org/styles/liberty";

/**
 * 神聖ローマ帝国の主要領邦オーバーレイ（hre_<year>.geojson）が存在する年代（昇順）。
 * 出典の ETH Zürich Roller データセット（doi:10.3929/ethz-b-000472583）が
 * カバーするのは 1500 前後〜1650 のスナップショットのみ。
 *
 * 1700 はデータ範囲外だが 1650 境界の外挿として配信する（TASK-68）:
 * ベースマップがドイツ諸邦を個別収録する 1715 より前の 1700 では、オーバーレイが
 * 無いと 1650→1700 でブランデンブルク等が「消えた」ように見える。Roller の行は
 * end 欠損 = 無期限扱いが多く、Bayern / ザクセン系は HRE_RANGE_OVERRIDES で
 * 1806 まで延長済みのため、buildYearCollection(raw, 1700) は 1650 と同一の
 * 14 領邦を返す（境界形状は 1650 年時点の近似。既存 override と同じ「領域継続性が
 * ある場合の近似延長」ポリシーの範囲内）。1715 以降はベースマップ自体が諸邦を
 * 個別収録するため、二重表示を避けるべく含めない。
 * 他の年代にはファイル自体が無い。
 */
export const HRE_OVERLAY_YEARS: readonly number[] = [
  1500,
  1530,
  1600,
  1650,
  1700,
];

/**
 * 中世フランスの諸侯領オーバーレイ（france_fiefs_<year>.geojson）が存在する
 * 年代（昇順、TASK-70/71）。出典は OpenHistoricalMap（CC0）。
 *
 * scripts/build-france-fiefs.ts の FRANCE_FIEF_YEARS と同値（src → scripts の
 * import は行わない規約のため値を重複定義し、同値性は build-france-fiefs_test.ts
 * で担保する）。
 *
 * 1400 以降は百年戦争期に多くの伯領が消滅して王領へ併合され、OHM 側の収録も
 * admin_level 2（主権国家）へ移るため対象外。1400 以降はベースマップ
 * （europe_<year>）の France ポリゴンが実態に一致するので、オーバーレイを
 * 重ねると同じ領域が二重に表示されるだけになる（AC #4）。
 *
 * HRE_OVERLAY_YEARS（1500〜1700）とは互いに素だが、TASK-86 で追加した
 * HRE_FIEF_OVERLAY_YEARS（1000〜1492）・TASK-96 で追加した
 * ITALY_FIEF_OVERLAY_YEARS（1000〜1492）とは 1000〜1300 が重なり、3 系統の
 * オーバーレイ（france-fiefs / hre-powers / italy-fiefs）が同時に表示される。
 * 描画順・picking 順は PICKING_PRIORITY で一意に決まり、領域の重なり（1100 年の
 * County of Bar ⊂ Duchy of Upper Lotharingia、1400 年の March of Montferrat ⊂
 * Duchy of Milan）は scripts/build-fief-flat.ts が HRE 側から差し引いて
 * 二重塗りを防ぐ（TASK-71 / TASK-86 / TASK-96）。
 */
export const FRANCE_FIEF_OVERLAY_YEARS: readonly number[] = [
  1000,
  1100,
  1200,
  1279,
  1300,
];

/**
 * OHM 由来の神聖ローマ帝国領邦オーバーレイ（hre_fiefs_flat_<year>.geojson）が
 * 存在する年代（昇順、TASK-85/86、#187）。出典は OpenHistoricalMap（CC0）。
 *
 * scripts/build-hre-fiefs.ts の HRE_FIEF_YEARS と同値（src → scripts の import は
 * 行わない規約のため値を重複定義し、同値性は build-hre-fiefs_test.ts で担保する）。
 *
 * 最古年は SNAPSHOT_YEARS と同じ 1000。1500〜1700 は Roller 由来の
 * HRE_OVERLAY_YEARS が受け持ち、両者は互いに素。1492↔1500・1700↔1715 の切替では
 * 同じ hre-powers レイヤー・同じラベル色・同じ帝国範囲強調のままデータ出典だけが
 * 替わる（TASK-86 AC #5）。
 *
 * #187: Roller が 1700 年で打ち切られた後の近世 3 年代（1715 / 1783 / 1800）を
 * OHM から補い、1715 年でバイエルン選帝侯領等が一斉に消える退行と、1783 / 1800 年
 * の教会諸侯領（1803 年の帝国代表者会議主要決議までは存続）の Prussia / Bavaria
 * への誤帰属を解消する。1806 年の帝国解体後（1815〜）は対象外。
 */
export const HRE_FIEF_OVERLAY_YEARS: readonly number[] = [
  1000,
  1100,
  1200,
  1279,
  1300,
  1400,
  1492,
  1715,
  1783,
  1800,
];

/**
 * HRE 領邦オーバーレイ（hre-powers レイヤー）が存在する全年代（昇順、TASK-86）。
 * OHM 由来（HRE_FIEF_OVERLAY_YEARS = 中世 1000〜1492 + 近世 1715〜1800、#187）と
 * Roller 由来（HRE_OVERLAY_YEARS = 1500〜1700）の和。両者は互いに素だが #187 で
 * OHM 側が Roller の後の年代も持つようになったため、単純連結では昇順にならず
 * ソートして束ねる。ランタイムはこの 1 本の年集合でオーバーレイの有無を判定し、
 * どのファイルを引くかは powers.ts hreDataUrlFor が HRE_FIEF_OVERLAY_YEARS で
 * 切り分ける。
 */
export const HRE_ALL_OVERLAY_YEARS: readonly number[] = [
  ...new Set([...HRE_FIEF_OVERLAY_YEARS, ...HRE_OVERLAY_YEARS]),
].sort((a, b) => a - b);

/**
 * 神聖ローマ帝国の**帝国全域**ジオメトリ（hre_realm_<year>.geojson）が存在する
 * 年代（昇順、#332）。出典は OpenHistoricalMap の帝国行政境界（admin_level=2 /
 * empire=hre、CC0）。
 *
 * scripts/build-hre-realm.ts の HRE_REALM_YEARS と同値（src → scripts の import
 * は行わない規約のため値を重複定義し、同値性は build-hre-realm_test.ts で
 * 担保する）。
 *
 * このデータは**描画も picking もしない**。勢力圏の外枠（suzerain_extent.ts）の
 * union 入力にだけ入る。1700 年までは base の `Holy Roman Empire` ポリゴンが
 * 帝国全域を塗るので不要で、1715 年から base が帝国を残余領域しか塗らなく
 * なる（1783 / 1800 は HRE キーへ解決する feature が 0 件になる）ため、
 * 外枠の入力を出典付きで補う。1806 年の帝国解体後（1815〜）は帝国そのものが
 * 存在しないので対象にしない = 外枠も出ない。
 */
export const HRE_REALM_YEARS: readonly number[] = [1715, 1783, 1800];

/**
 * イタリア諸侯領オーバーレイ（italy_fiefs_flat_<year>.geojson）が存在する
 * 年代（昇順、TASK-95/96、#188）。出典は OpenHistoricalMap（CC0）。
 *
 * scripts/build-italy-fiefs.ts の ITALY_FIEF_YEARS と同値（src → scripts の
 * import は行わない規約のため値を重複定義し、同値性は build-italy-fiefs_test.ts
 * で担保する）。
 *
 * 最古年は SNAPSHOT_YEARS と同じ 1000。1000 は 3 件
 * （トスカーナ辺境伯領・スポレート公国・モンフェッラート辺境伯領）と少ないが、
 * 前 2 者だけで中部イタリアの大半を覆うため面として成立する。
 *
 * #188: 1500 年を含む。base（europe_<year>）が北・中部イタリアの諸邦
 * （ヴェネツィアを除く）を主権国家として個別収録するのは 1530 年からで、
 * 1500 年だけは Holy Roman Empire 一括塗りへ退行する（Roller 由来 hre_1500 も
 * 独領邦 13 件のみでイタリアを持たない）ため、1492 年と同じ系統の
 * オーバーレイで埋める。1530 以降を持たないのは base の個別収録との
 * 二重表示にしかならないため（仏諸侯領が 1400 以降を落とした理由と同じ）。
 *
 * HRE_FIEF_OVERLAY_YEARS とは 1000〜1492 が重なり、FRANCE_FIEF_OVERLAY_YEARS
 * （1000〜1300）とは 1000〜1300 が重なるので、最大 3 系統のオーバーレイが
 * 同時に表示される。描画順・picking 順は PICKING_PRIORITY で一意に決まり、
 * 領域の重なり（1400 年の March of Montferrat × Duchy of Milan 等）は
 * scripts/build-fief-flat.ts が HRE 側から差し引いて二重塗りを防ぐ（TASK-96）。
 */
export const ITALY_FIEF_OVERLAY_YEARS: readonly number[] = [
  1000,
  1100,
  1200,
  1279,
  1300,
  1400,
  1492,
  1500,
];

/**
 * Cliopatria 由来の領邦オーバーレイ（cliopatria_fiefs_flat_<year>.geojson）が
 * 存在する年代（昇順、TASK-110）。出典は Cliopatria / Seshat Global History
 * Databank（CC BY 4.0、doi:10.5281/zenodo.14714684）。
 *
 * scripts/build-cliopatria-fiefs.ts の CLIOPATRIA_FIEF_YEARS と同値（src →
 * scripts の import は行わない規約のため値を重複定義し、同値性は同スクリプトの
 * テストで担保する）。既存の FRANCE_FIEF_OVERLAY_YEARS 等と同じ扱い。
 *
 * このレイヤーは既存 3 系統（OHM 由来）の置き換えではなく**欠落の補完**で、
 * 収録するのは「OHM に該当リレーションが無いことを実測した領邦」だけ。
 * 内訳は 1000/1100/1200 が仏のみ（王領・トゥールーズ伯領・アキテーヌ公領ほか）、
 * 1279/1300 が仏 + 帝国、1400/1492 が帝国のみ（バイエルン公領・ブランデン
 * ブルク・ボヘミア王国・ザクセン選帝侯領）。同じ領邦が OHM 側と両方に出る
 * ことはないため、二重塗り・重複ラベルは構造的に生じない。
 *
 * 最古年は SNAPSHOT_YEARS と同じ 1000。1500 以降を持たないのは既存 3 系統と
 * 同じ理由（base（europe_<year>）が主権国家を個別収録するため、
 * オーバーレイは二重表示にしかならない）。1200 は仏のみ: Cliopatria は
 * 1200 年の帝国を Holy Roman Empire 一枚岩でモデル化しており内部領邦が
 * 0 件のため（この空白は data/known-limitations.json に残る）。
 */
export const CLIOPATRIA_FIEF_OVERLAY_YEARS: readonly number[] = [
  1000,
  1100,
  1200,
  1279,
  1300,
  1400,
  1492,
];

/**
 * ブリテン諸島の政体オーバーレイ（britain_fiefs_flat_<year>.geojson）が存在する
 * 年代（昇順、TASK-151 / #172）。出典は OpenHistoricalMap（CC0）。
 *
 * scripts/build-britain-fiefs.ts の BRITAIN_FIEF_YEARS と同値（src → scripts の
 * import は行わない規約のため値を重複定義し、同値性は build-britain-fiefs_test.ts
 * で担保する）。
 *
 * 収録するのは base（europe_<year>）に無い政体だけ:
 * 1000〜1279 はウェールズ諸王国（グウィネズ・ポウィス・デヘイバース等）と
 * アイルランド諸王国（ダブリン・レンスター・ミース）、1300〜1530 は残存する
 * アイルランド東部の政体とマン島、1600〜1700 はアイルランドの政体
 * （アイルランド王国・アイルランド・カトリック同盟）。いずれも当時の独立
 * 主権政体（または係争地）で、仏諸侯領のような「王国内部の諸侯領」とは
 * 意味論が異なるが、SUBJECTO を持たない properties（NAME 単独の色キー・
 * 宗主表示なし）がそのまま「独立勢力として振る舞う」表現になるため、既存の
 * オーバーレイ機構（TASK-71/86/96/110）にそのまま載せる。
 *
 * 既存 4 系統と違い**近世（1500〜1700）も対象**に含む。base がイングランドと
 * アイルランドを単一勢力（England and Ireland）で塗り続けるため、二重表示では
 * なく「base が描き分けない政体を識別可能にする」補完になる（1600/1650/1700 の
 * アイルランド）。1715 以降は base が United Kingdom と Kingdom of Ireland を
 * 分けて収録するため含めない。ウェールズは 1283 年のエドワード 1 世による征服
 * 以降、上流に独立実体が存在しない（data/known-limitations.json に明示）。
 */
export const BRITAIN_FIEF_OVERLAY_YEARS: readonly number[] = [
  1000,
  1100,
  1200,
  1279,
  1300,
  1400,
  1492,
  1500,
  1530,
  1600,
  1650,
  1700,
];

/**
 * 主権政体オーバーレイ（sovereign_fiefs_flat_<year>.geojson）が存在する年代
 * （昇順、#189）。出典は OpenHistoricalMap（CC0）。
 *
 * scripts/build-sovereign-fiefs.ts の SOVEREIGN_FIEF_YEARS と同値（src →
 * scripts の import は行わない規約のため値を重複定義し、同値性は
 * build-sovereign-fiefs_test.ts で担保する）。
 *
 * base が近世以降のオスマン領・ハプスブルク領を一枚岩で塗るために現れない
 * 主権政体（オスマン宗主下のワラキア公国・クリミア・ハン国・ラグーザ共和国、
 * ハプスブルク統治下のハンガリー王国（1783〜1815）・トランシルヴァニア、
 * ロシア帝国内のフィンランド大公国など）と、特定年だけの退行（1200 年の
 * セルビア・1400 年のモスクワ大公国）・誤帰属（1880 年のクレタ = Bulgaria
 * 塗り）を補完する。オスマン期（1530〜1715 年）のハンガリー王国は OHM の
 * リレーションが label ノードのみで面を組めず補完できない
 * （data/known-limitations.json に明示）。
 * 収録するのは「その年の base に無い政体」だけで、base が同じ政体を個別収録
 * する年は生成段階（excludedYears）で除外済み。二重塗り・重複ラベルは
 * 構造的に生じない。
 *
 * 既存 5 系統と違い **1815〜1900 年も対象**に含む（フィンランド大公国・
 * 東ルメリ自治州・クレタ）。これにより BASE_OUTLINE_YEARS（派生データの
 * 年集合）が 1815 / 1880 / 1900 へ広がった。
 *
 * #190: 西欧・イタリア・地中海（1000 年の教皇領・1000〜1100 年の
 * バルセロナ伯領・1279〜1400 年のアテネ公国 / アカイア公国・1400〜1500 年の
 * ナポリ王国 / サヴォイア・1783 年のジェノヴァ共和国と 1800 年のリグリア
 * 共和国・1400〜1783 年のヨハネ騎士団）を足し、1000 / 1100 / 1279 / 1300 が
 * 対象年に加わった。この 4 年は既存 5 系統のオーバーレイが揃っているため
 * BASE_OUTLINE_YEARS は変わらなかった。
 *
 * #191: 微小国家（サンマリノ・アンドラ・モナコ・リヒテンシュタイン）を足し、
 * **1914 年も対象年になった**（この 4 政体は 1914 年の base に 1 件も無く、
 * サンマリノに至っては 1815 年以外の全年代で base から欠落している）。
 * これにより SNAPSHOT_YEARS と同じ全 19 年になり、BASE_OUTLINE_YEARS も
 * 全 19 年へ広がる（base_outline_1914 / europe_flat_1914 が新規に生成される）。
 */
export const SOVEREIGN_FIEF_OVERLAY_YEARS: readonly number[] = [
  1000,
  1100,
  1200,
  1279,
  1300,
  1400,
  1492,
  1500,
  1530,
  1600,
  1650,
  1700,
  1715,
  1783,
  1800,
  1815,
  1880,
  1900,
  1914,
];

/**
 * 隣接年から流用した面（borrowed_hre_<year>.geojson）を持つ年代（昇順、#202 /
 * ADR-0033）。出典は借用元と同じ Roller / ETH Zürich（CC BY-NC-SA 4.0）。
 *
 * scripts/build-borrowed-fiefs.ts の BORROWED_FEATURES（lineage="hre"）と同値
 * （src → scripts の import は行わない規約のため値を重複定義し、同値性は
 * build-borrowed-fiefs_test.ts で担保する）。
 *
 * 1492 年はオーストリア大公領がどの上流にも面を持たない（OHM は 1453 年で
 * リレーションが切れ、Roller は 1500 年から）。ADR-0033 の 4 条件を満たすため、
 * data/hre_1500.geojson の Archduchy of Austria を座標を変えずに複製して
 * hre-powers レイヤーへ足す。上流が埋まればこの年は一覧から落とす。
 *
 * #209: 1715 年のザクセン選帝侯領も同様（OHM は 1485〜1780 が空白、Roller 由来の
 * hre_<year> は 1700 年で打ち切り）。data/hre_1700.geojson の
 * Electorate of Saxony を複製する。1715 年の hre-powers は OHM 由来の
 * hre_fiefs_flat_1715 なので、この年だけ Roller 由来の面が 1 件混ざるが、
 * 出典・ライセンスは feature ごとに解決される（pick_handlers.ts
 * featureAttribution）ため表示は正しいまま。
 */
export const BORROWED_HRE_OVERLAY_YEARS: readonly number[] = [1492, 1715];

/**
 * 隣接年から流用した面（borrowed_italy_<year>.geojson）を持つ年代（昇順、#202 /
 * ADR-0033）。出典は借用元と同じ OpenHistoricalMap（CC0）。
 *
 * scripts/build-borrowed-fiefs.ts の BORROWED_FEATURES（lineage="italy"）と同値。
 * 1492 年のミラノ公国は OHM の 1447〜1500 が空白なので、1500 年の rel 2800654
 * （data/italy_fiefs_1500.geojson）を複製して italy-fiefs レイヤーへ足す。
 */
export const BORROWED_ITALY_FIEF_OVERLAY_YEARS: readonly number[] = [1492];

/**
 * base 境界線オーバーレイ（base_outline_<year>.geojson）が存在する年代
 * （昇順、TASK-78/86/96、#172、#189、#191）。諸侯領・領邦・主権政体オーバーレイの
 * いずれかがある年、すなわち FRANCE_FIEF_OVERLAY_YEARS ∪
 * HRE_FIEF_OVERLAY_YEARS ∪ ITALY_FIEF_OVERLAY_YEARS ∪
 * BRITAIN_FIEF_OVERLAY_YEARS ∪ SOVEREIGN_FIEF_OVERLAY_YEARS。
 * #172 でブリテン諸島（1000〜1700）が加わり、近世（1500〜1700）にも派生データ
 * （base_outline_* / europe_flat_*）が生成されるようになった。#189 の
 * 主権政体オーバーレイで 1815 / 1880 / 1900 が、#191 の微小国家
 * （サンマリノ・アンドラ・モナコ・リヒテンシュタイン）で 1914 年が加わり、
 * 全 19 年（= SNAPSHOT_YEARS）が派生データを持つ。
 *
 * この派生データは「base ポリゴンの環のうちオーバーレイ union の外側だけ」を
 * 持つため、オーバーレイがある年は base の輪郭がオーバーレイの内側を走らなくなる
 * （= 二重輪郭が消える）。scripts/build-fief-dedupe.ts の FIEF_DEDUPE_YEARS と
 * 同じ年集合で、fief-dedupe.json（ラベル抑制の被覆率表）も同じ年を持つ。
 *
 * TASK-110: CLIOPATRIA_FIEF_OVERLAY_YEARS はここへ加えない。年集合としては
 * 既に完全な部分集合（1000〜1492）なので union に足しても値が変わらず、
 * 「どの年に派生データがあるか」の意味は不変だから。一方で **union の中身**
 * （何を差し引くか）には Cliopatria も入る必要があり、それは
 * scripts/build-fief-dedupe.ts の入力に Cliopatria を足して
 * base_outline_<year> / europe_flat_<year> を再生成することで満たす
 * （データ側の担当）。部分集合であることは config_test.ts で固定する。
 */
export const BASE_OUTLINE_YEARS: readonly number[] = [
  ...new Set([
    ...FRANCE_FIEF_OVERLAY_YEARS,
    ...HRE_FIEF_OVERLAY_YEARS,
    ...ITALY_FIEF_OVERLAY_YEARS,
    ...BRITAIN_FIEF_OVERLAY_YEARS,
    ...SOVEREIGN_FIEF_OVERLAY_YEARS,
  ]),
].sort((a, b) => a - b);

/**
 * 歴史的国境ポリゴンが存在する年代スナップショット一覧（昇順）。
 * TASK-119: 900 年は諸侯領オーバーレイ 4 系統すべてが成立せず情報量が他年代と
 * 揃わないため廃止し、タイムラインの最古年を 1000 にした。
 */
export const SNAPSHOT_YEARS: readonly number[] = [
  1000,
  1100,
  1200,
  1279,
  1300,
  1400,
  1492,
  1500,
  1530,
  1600,
  1650,
  1700,
  1715,
  1783,
  1800,
  1815,
  1880,
  1900,
  1914,
];
