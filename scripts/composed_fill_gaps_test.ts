/**
 * 「画面に実際に出る塗り」＝ base 塗り（`europe_flat_<year>`）＋ 各系統の
 * オーバーレイ flat ＋ 沿岸補完 に、未塗装の筋が残らないことを実データで
 * 固定する（#390）。
 *
 * ## なぜ「合成」で測るのか
 *
 * base 塗りとオーバーレイは別のファイル・別のレイヤーだが、画面では隙間なく
 * continuous な 1 枚の塗りに見えなければならない。どちらか片方だけを検査しても
 * 「両者の境界に幅 100 m の筋が残る」症状は見えない。したがって描画に使われる
 * ファイルを全て合成し、`unpaintedGapsIn` で矩形を走査する。
 *
 * ## 未塗装が生じる経路は 2 つしか無い（#390 の実測）
 *
 * `europe_flat` は `base − union(オーバーレイ)` なので、単に境界を共有する
 * だけの箇所ではズレは生じない。穴の縁を作るのは差し引きそのものであり、
 * 誰も塗らない面が生まれる経路は次の 2 つに限られる。
 *
 * - **(a) 引く形と描く形が違う**: `fiefsPathsFor` が union に渡すファイルと、
 *   ランタイムが描くファイルが食い違うと、差し引かれたのに誰も描かない面が
 *   そのまま穴になる。
 * - **(b) 引いた残片が捨てられる**: 差し引きの残りが細片になると
 *   `cleanFeatureCollection` の閾値（1 km² / 平均幅 111 m）に掛かって消え、
 *   その分が穴になる。
 *
 * このファイルは (a)(b) を「機構として」検査する（AC3）。(a) は
 * `fiefsPathsFor` とランタイムの配信 URL の突き合わせで純粋関数として、
 * (b) は「base が塗る面を派生が失っていないか」の走査で実データとして押さえる。
 * 個々の箇所の網羅走査はしない。
 *
 * ## 残ってよい未塗装の尺度
 *
 * 座標は COORD_PRECISION = 3（緯度方向で 10^-3 度 ≒ 111 m）のグリッドに丸める。
 * 差し引きが作る交点はグリッド上に無いので、丸めが最大で半目盛り（≒ 56 m）
 * 動かす。オーバーレイの辺に載っていた交点がこれで辺から外れると、そこに幅
 * 数十 m の筋が開く。**この規模の残りは丸めの帰結であって、機構の欠陥ではない**
 * （消すには COORD_PRECISION を上げるしかなく、それは #390 の範囲外）。
 * したがって閾値はこのスケールを基準に置く（HALF_GRID_M）。
 */
import { assert, assertEquals } from "@std/assert";
import type { FeatureCollection } from "geojson";
import {
  BORROWED_HRE_OVERLAY_YEARS,
  BORROWED_ITALY_FIEF_OVERLAY_YEARS,
  BRITAIN_FIEF_OVERLAY_YEARS,
  CLIOPATRIA_FIEF_OVERLAY_YEARS,
  FRANCE_FIEF_OVERLAY_YEARS,
  HRE_FIEF_OVERLAY_YEARS,
  ITALY_FIEF_OVERLAY_YEARS,
  SOVEREIGN_FIEF_OVERLAY_YEARS,
} from "../src/config.ts";
import {
  baseFillDataUrlFor,
  borrowedHreDataUrlFor,
  borrowedItalyFiefDataUrlFor,
  britainFiefDataUrlFor,
  cliopatriaFiefDataUrlFor,
  franceFiefDataUrlFor,
  hreDataUrlFor,
  italyFiefDataUrlFor,
  sovereignFiefDataUrlFor,
} from "../src/powers.ts";
import { FIEF_DEDUPE_YEARS, fiefsPathsFor } from "./build-fief-dedupe.ts";
import {
  type Box,
  NO_TILING_DEG,
  type UnpaintedGap,
  unpaintedGapsIn,
} from "./unpainted_gaps.ts";

/**
 * その年にランタイムがオーバーレイとして描くファイルのパス（`data/` 相対）。
 *
 * 判定は `src/config.ts` の年集合と `src/powers.ts` の URL 関数だけから作る。
 * 「何が描かれるか」の定義元を本ファイルに複製しないためで、これにより
 * 経路 (a) の検査（`fiefsPathsFor` との突き合わせ）が意味を持つ。
 *
 * HRE は 1500〜1700 が Roller 由来（`hre_<year>`）で、そもそも
 * `HRE_FIEF_OVERLAY_YEARS` に入らないため OHM 年代だけを見る。
 */
function drawnOverlayPathsFor(year: number): string[] {
  const urls: string[] = [];
  if (HRE_FIEF_OVERLAY_YEARS.includes(year)) {
    urls.push(hreDataUrlFor(year, HRE_FIEF_OVERLAY_YEARS));
  }
  if (FRANCE_FIEF_OVERLAY_YEARS.includes(year)) {
    urls.push(franceFiefDataUrlFor(year));
  }
  if (ITALY_FIEF_OVERLAY_YEARS.includes(year)) {
    urls.push(italyFiefDataUrlFor(year));
  }
  if (CLIOPATRIA_FIEF_OVERLAY_YEARS.includes(year)) {
    urls.push(cliopatriaFiefDataUrlFor(year));
  }
  if (BRITAIN_FIEF_OVERLAY_YEARS.includes(year)) {
    urls.push(britainFiefDataUrlFor(year));
  }
  if (SOVEREIGN_FIEF_OVERLAY_YEARS.includes(year)) {
    urls.push(sovereignFiefDataUrlFor(year));
  }
  if (BORROWED_HRE_OVERLAY_YEARS.includes(year)) {
    urls.push(borrowedHreDataUrlFor(year));
  }
  if (BORROWED_ITALY_FIEF_OVERLAY_YEARS.includes(year)) {
    urls.push(borrowedItalyFiefDataUrlFor(year));
  }
  // 配信 URL は先頭が "/"。生成側のパス（"data/...")へ揃える
  return urls.map((url) => url.replace(/^\//, ""));
}

async function readCollection(path: string): Promise<FeatureCollection> {
  return JSON.parse(await Deno.readTextFile(path)) as FeatureCollection;
}

/**
 * その年に画面へ出る塗りを全て読む: base 塗り + オーバーレイ flat + 沿岸補完。
 * 沿岸補完（`coastal_fill_<year>`）は base の海岸線と地形タイルの海岸線の
 * 食い違いを埋める帯で、これも塗りなので合成に入れないと海岸沿いが常に
 * 未塗装として出る。
 */
async function paintedLayersFor(year: number): Promise<FeatureCollection[]> {
  const paths = [
    baseFillDataUrlFor(year).replace(/^\//, ""),
    ...drawnOverlayPathsFor(year),
    `data/coastal_fill_${year}.geojson`,
  ];
  const layers: FeatureCollection[] = [];
  for (const path of paths) {
    try {
      layers.push(await readCollection(path));
    } catch {
      // 沿岸補完など、年によっては存在しない生成物がある
    }
  }
  return layers;
}

/** 未塗装成分の合計面積（km²） */
function totalKm2(gaps: readonly UnpaintedGap[]): number {
  return gaps.reduce((sum, gap) => sum + gap.areaKm2, 0);
}

/** 成分 1 件を報告用の文字列にする */
function describe(gap: UnpaintedGap): string {
  return `${gap.areaKm2.toFixed(4)} km²・平均幅 ${
    gap.meanWidthM.toFixed(0)
  } m @ ${gap.bbox.map((v) => v.toFixed(3)).join(",")}`;
}

/**
 * 座標グリッドの半目盛り（m）。COORD_PRECISION = 3 の丸めが 1 頂点を動かせる
 * 最大距離で、「丸めで説明できる筋」の上限にあたる。
 */
const HALF_GRID_M = 111_320 * 10 ** -3 / 2;

// ---------------------------------------------------------------------------
// AC1 / AC2: 報告された 1 箇所（1200 年モラヴィア北縁）
// ---------------------------------------------------------------------------

/**
 * Issue #390 が報告した未塗装の帯の範囲。起票時の実測は
 * **0.6343 km²・平均幅 102 m の 1 件**で、z8 で境界に沿って地形が線状に
 * 露出していた（`?year=1200&zoom=8&center=17.236,48.868`）。
 */
const REPORTED_BOX: Box = [17.195, 48.861, 17.277, 48.875];

/**
 * この矩形で許す未塗装の合計（km²）。
 *
 * 0 にはできない。この帯を作る base 側の境界には、差し引きが打つ交点が
 * オーバーレイの辺の上に乗っており、それを 0.001 度グリッドへ丸めると辺から
 * 最大 56 m 外れる（実測: 1 頂点が 33 m 南へ動く）。帯の長さは約 6 km なので
 * 丸めだけで 0.1 km² 規模の筋は生じうる。上限は報告値 0.6343 km² の 1/6 に
 * 置き、あわせて「残る筋の平均幅が半グリッド未満」であること
 * （= 丸めで説明できる規模に収まっていること）を要求する。
 * 修正後の実測は 0.0731 km²・平均幅 17 m。
 */
const REPORTED_BOX_LIMIT_KM2 = 0.1;

Deno.test("#390: 1200 年モラヴィア北縁の合成塗りに未塗装の帯が残らない", async () => {
  const layers = await paintedLayersFor(1200);
  const gaps = unpaintedGapsIn(layers, REPORTED_BOX, {
    tileDegrees: NO_TILING_DEG,
  });
  const total = totalKm2(gaps);
  const detail = gaps.map(describe).join(" / ") || "なし";
  assert(
    total <= REPORTED_BOX_LIMIT_KM2,
    `1200 年 ${REPORTED_BOX.join("/")} に未塗装が ${
      total.toFixed(4)
    } km² 残っている（上限 ${REPORTED_BOX_LIMIT_KM2} km²）: ${detail}`,
  );
  const wide = gaps.filter((gap) => gap.meanWidthM >= HALF_GRID_M);
  assertEquals(
    wide.map(describe),
    [],
    "座標丸め（半グリッド 56 m）では説明できない幅の筋が残っている",
  );
});

// ---------------------------------------------------------------------------
// AC3 経路 (a): 引く形と描く形を一致させる
// ---------------------------------------------------------------------------

Deno.test("#390: union から差し引くオーバーレイは全てランタイムが描くファイル（経路 a）", () => {
  const offenders: string[] = [];
  for (const year of FIEF_DEDUPE_YEARS) {
    const drawn = new Set(drawnOverlayPathsFor(year));
    for (const path of fiefsPathsFor(year)) {
      if (!drawn.has(path)) {
        offenders.push(
          `${year}: ${path} は union から差し引かれるがランタイムは描かない`,
        );
      }
    }
  }
  // 描かない形を引くと、その面は誰も塗らない穴になる（#376 の 1200 年
  // Cliopatria が 298 km² の実例）。年ごとの例外扱いではなく、
  // 「引く形は必ず描く形」という機構として固定する
  assertEquals(offenders, []);
});

Deno.test("#390: 差し引きに渡すのは raw ではなく flat（経路 a の具体形）", () => {
  const raw: string[] = [];
  for (const year of FIEF_DEDUPE_YEARS) {
    for (const path of fiefsPathsFor(year)) {
      if (!path.includes("_flat_")) raw.push(`${year}: ${path}`);
    }
  }
  assertEquals(raw, []);
});

// ---------------------------------------------------------------------------
// AC3 経路 (b): 差し引きの残片を捨てない
//
// 「合成塗りが塗らない面」には 2 種類ある。
//
// 1. base（`europe_<year>`）自身が塗っていない面。上流の帰属未詳の空白で、
//    `data/known-limitations.json` が開示しているもの（1200 年のボヘミア／
//    ポーランド間 22.9 km² など）。#390 の対象ではない。
// 2. base は塗っているのに合成塗りが塗らない面。**派生（差し引き → 細片の
//    始末 → clean）が落とした分**で、これが #390 の症状にあたる。
//
// 2 だけを取り出せば「特定の 1 箇所」ではなく機構として検査できる。合成塗りに
// base を 1 枚足して測り直した差が、ちょうど 2 の面積になる。
// ---------------------------------------------------------------------------

const CENTRAL_EUROPE_BOX: Box = [12, 48, 19, 51.5];

/**
 * 中欧の矩形で許す「base は塗るのに合成塗りが塗らない面」（km²・1 年あたり）。
 *
 * 修正前後の実測（12–19 / 48–51.5）:
 *
 * | 年   | 修正前 | 修正後 |
 * | ---: | -----: | -----: |
 * | 1100 |  4.128 |  1.722 |
 * | 1200 |  1.104 |  0.535 |
 * | 1300 | 11.312 |  0.805 |
 * | 1400 | 10.418 |  2.293 |
 * | 1492 |  7.175 |  1.312 |
 * | 1715 |  3.685 |  0.659 |
 * | 1783 |  2.181 |  0.576 |
 * | 1800 |  2.181 |  0.576 |
 *
 * 残るのは座標丸め（半グリッド 56 m）が開ける筋で、修正後の最大は 1400 年の
 * 2.293 km²。上限 3.0 km² はそこに 3 割の余白を置いた値である。
 */
const DERIVATION_LOSS_LIMIT_KM2 = 3.0;

Deno.test("#390: 派生 base は base が塗る面を落とさない（経路 b・全対象年）", async () => {
  const offenders: string[] = [];
  for (const year of FIEF_DEDUPE_YEARS) {
    const layers = await paintedLayersFor(year);
    const base = await readCollection(`data/europe_${year}.geojson`);
    const composed = totalKm2(
      unpaintedGapsIn(layers, CENTRAL_EUROPE_BOX, {
        tileDegrees: NO_TILING_DEG,
      }),
    );
    // base を 1 枚足すと「base も塗っていない面」だけが残る。その差が
    // 「派生が落とした面」にあたる
    const upstream = totalKm2(
      unpaintedGapsIn([...layers, base], CENTRAL_EUROPE_BOX, {
        tileDegrees: NO_TILING_DEG,
      }),
    );
    const lost = composed - upstream;
    if (lost > DERIVATION_LOSS_LIMIT_KM2) {
      offenders.push(
        `${year}: base が塗るのに合成塗りが塗らない面が ${
          lost.toFixed(3)
        } km²（上限 ${DERIVATION_LOSS_LIMIT_KM2} km²）`,
      );
    }
  }
  assertEquals(offenders, []);
});

// ---------------------------------------------------------------------------
// AC4: 広域走査（起票時点から未被覆が増えていない）
// ---------------------------------------------------------------------------

/**
 * 中欧（12–19 / 48–51.5）の走査で許す未被覆の合計（km²）。
 *
 * 値は **#390 起票時点の実測** で、「これ以上増えていない」ことだけを固定する。
 * 修正後の実測は下表に併記する（減った値で固定し直すと、将来の改善余地を
 * 潰したうえに無関係な変更で red になるため上限としては採らない）。
 *
 * | 年   | 上限（起票時） | 修正後の実測 |
 * | ---: | -------------: | -----------: |
 * | 1100 |          4.147 |        1.741 |
 * | 1200 |          1.386 |        0.817 |
 * | 1300 |         11.312 |        0.805 |
 * | 1400 |         10.418 |        2.293 |
 *
 * 修正後の値は上の「派生が落とした面」とほぼ一致する（この矩形では base 自身の
 * 空白が 1300 / 1400 で 0 のため）。1100 / 1200 で差があるのは、base の帰属
 * 未詳の空白をオーバーレイが覆っている分である。
 */
const CENTRAL_EUROPE_LIMIT_KM2: ReadonlyMap<number, number> = new Map([
  [1100, 4.147],
  [1200, 1.386],
  [1300, 11.312],
  [1400, 10.418],
]);

Deno.test("#390: 中欧の合成塗りに残る未被覆が起票時点から増えていない", async () => {
  const offenders: string[] = [];
  for (const [year, limit] of CENTRAL_EUROPE_LIMIT_KM2) {
    const layers = await paintedLayersFor(year);
    const gaps = unpaintedGapsIn(layers, CENTRAL_EUROPE_BOX, {
      tileDegrees: NO_TILING_DEG,
    });
    // 上限は 3 桁で記録した実測値なので、比較も 3 桁に丸めて行う
    // （倍精度の端数だけで red になるのを避ける）
    const total = Number(totalKm2(gaps).toFixed(3));
    if (total > limit) {
      offenders.push(
        `${year}: 未被覆 ${total.toFixed(3)} km² が上限 ${limit} km² を超えた`,
      );
    }
  }
  assertEquals(offenders, []);
});
