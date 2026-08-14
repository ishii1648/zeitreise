import { assert, assertEquals } from "@std/assert";
import type { Feature, FeatureCollection } from "geojson";
import knownLimitations from "../data/known-limitations.json" with {
  type: "json",
};
import {
  isKnownLimitationActiveForYear,
  parseKnownLimitations,
} from "./known_limitations.ts";
import {
  FRANCE_FIEF_OVERLAY_YEARS,
  HRE_FIEF_OVERLAY_YEARS,
  ITALY_FIEF_OVERLAY_YEARS,
  SNAPSHOT_YEARS,
} from "../src/config.ts";
import {
  SOVEREIGN_FIEF_ALLOWLIST,
  sovereignFiefIdsForYear,
} from "./build-sovereign-fiefs.ts";

// data/known-limitations.json（TASK-46: データの既知の制限一覧）の静的検証。
// CI の `deno test` は権限なしで実行されるためファイルを実行時に読まず、
// static import（name-ja_test.ts と同方式）で内容を検証する。例外は #377 の
// 突き合わせ検査で、文言と配信 GeoJSON がずれたら落ちるよう
// data/europe_1200.geojson だけを実行時に読む（CI・deno task test とも
// `--allow-read=data` を与えている）。

Deno.test("known-limitations.json は全エントリがパーサの検証を通る", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  assertEquals(parsed.length, knownLimitations.limitations.length);
  assert(parsed.length > 0);
});

// #175: パネルは既定で要約（summary）だけを表示する。全エントリに要約が
// 執筆済みで、AC #3 の「2 文程度・全角 120 字以内」を満たすことをデータ側で
// 保証する（欠落時は text 冒頭で縮退表示されるが、それはあくまで壊れた
// データへの防御であり、リポジトリ内のデータは常に要約を持つ）。
Deno.test("全エントリが要約（summary）を持ち 2 文以内・全角 120 字以内である（#175 AC #3）", () => {
  for (const entry of knownLimitations.limitations) {
    const { summary } = entry as { id: string; summary?: unknown };
    assert(
      typeof summary === "string" && summary.length > 0,
      `${entry.id} に summary が無い`,
    );
    const chars = [...summary].length;
    assert(
      chars <= 120,
      `${entry.id} の summary が ${chars} 字で 120 字を超えている`,
    );
    const sentences = (summary.match(/。/g) ?? []).length;
    assert(
      sentences >= 1 && sentences <= 2,
      `${entry.id} の summary が 2 文以内でない（句点 ${sentences} 個）`,
    );
  }
});

Deno.test("id は一覧内で一意である", () => {
  const ids = knownLimitations.limitations.map((entry) => entry.id);
  assertEquals(new Set(ids).size, ids.length);
});

Deno.test("1700 年の HRE 領邦境界外挿の制限注記が存在する（TASK-68）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "hre-boundaries-1700-extrapolated");
  assert(entry !== undefined, "hre-boundaries-1700-extrapolated が無い");
  // 1650 年時点の境界の外挿である旨をユーザに説明していること
  assert(
    entry.text.includes("1650"),
    "text が 1650 年時点の近似に言及していない",
  );
  assert(entry.text.includes("1700"), "text が 1700 年に言及していない");
});

Deno.test("中世フランス諸侯領の欠落が明記されている（TASK-71 AC #3）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "france-fiefs-missing-territories");
  assert(entry !== undefined, "france-fiefs-missing-territories が無い");
  // AC #3: Comté de Toulouse・王領（domaine royal）・Provence（1487 年以降のみ）
  for (const keyword of ["Toulouse", "domaine royal", "Provence", "1487"]) {
    assert(
      entry.text.includes(keyword),
      `text が ${keyword} に言及していない`,
    );
  }
  // TASK-87 AC#5: 許可リスト拡張後の実態（21 領邦・空白は元データ側の欠落）
  for (const keyword of ["21", "OpenHistoricalMap"]) {
    assert(
      entry.text.includes(keyword),
      `text が拡張後の実態（${keyword}）を反映していない`,
    );
  }
  assert(
    !entry.text.includes("14の"),
    "text が拡張前の 14 領邦のままになっている",
  );
});

// TASK-88 / decision-18: OHM に無い諸侯領（トゥールーズ・王領など）を現代の県
// （département）ポリゴンの union で自作する案を実測のうえ却下した。ユーザから
// 見れば「空白が埋まらない」ことに変わりはないので、なぜ埋めないのか（= 出典を
// たどれない形状は混ぜない）と、その判断の根拠になった実測値を同じエントリに
// 集約して説明する。新規 id を作らないのは、空白の理由と埋めない理由が同じ
// 制限の表裏であり、分けると年代フィルタも同一のまま 2 件が並んで冗長になるため。
Deno.test("県ポリゴン合成による諸侯領の自作を見送った旨と実測値が明記されている（TASK-88 AC #5）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "france-fiefs-missing-territories");
  assert(entry !== undefined, "france-fiefs-missing-territories が無い");
  // 検討して採らなかったこと（= 単なる未実装ではない）が読み取れること
  for (const keyword of ["県", "1790", "合成"]) {
    assert(
      entry.text.includes(keyword),
      `text が県ポリゴン合成の検討（${keyword}）に言及していない`,
    );
  }
  // 却下の根拠になった実測値（TASK-88 フェーズ 1）。
  // 一致度 IoU: 核心 6 県 28.5% 〜 12 県 41.6%
  // 1200 年の空白（208,326 km²）の充填率: 12.7% 〜 27.7%
  for (const keyword of ["28.5", "41.6", "12.7", "27.7"]) {
    assert(
      entry.text.includes(keyword),
      `text が実測値 ${keyword} に言及していない`,
    );
  }
  // 方針（出典をたどれない形状は史実データに混ぜない）に言及していること
  assert(
    /出典/.test(entry.text),
    "text が出典をたどれない形状を混ぜない方針に言及していない",
  );
});

Deno.test("県ポリゴン合成の見送りは新規 id を作らず既存 1 件に集約されている（TASK-88 AC #5）", () => {
  const ids = knownLimitations.limitations.map((entry) => entry.id);
  const added = ids.filter((id) =>
    /synth|departement|department|fief-synthesis/i.test(id)
  );
  assertEquals(
    added,
    [],
    `合成見送り用の新規 id が追加されている: ${added.join(", ")}`,
  );
});

Deno.test("フランス諸侯領の制限注記は諸侯領オーバーレイの対象年でのみ active（TASK-71 AC #3）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "france-fiefs-missing-territories");
  assert(entry !== undefined);
  for (const year of SNAPSHOT_YEARS) {
    assertEquals(
      isKnownLimitationActiveForYear(entry, year),
      FRANCE_FIEF_OVERLAY_YEARS.includes(year),
      `${year} 年の active 判定が期待と異なる`,
    );
  }
});

Deno.test("Flanders の 1237 年以前の欠落が 1237 年より前の対象年でのみ active（TASK-71 AC #3）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "france-fiefs-flanders-pre-1237");
  assert(entry !== undefined, "france-fiefs-flanders-pre-1237 が無い");
  assert(entry.text.includes("1237"), "text が 1237 年に言及していない");
  for (const year of SNAPSHOT_YEARS) {
    assertEquals(
      isKnownLimitationActiveForYear(entry, year),
      FRANCE_FIEF_OVERLAY_YEARS.includes(year) && year < 1237,
      `${year} 年の active 判定が期待と異なる`,
    );
  }
});

Deno.test("Aquitaine / Gascony の 1214 年以降の欠落が 1214 年以降の対象年でのみ active（TASK-71 AC #3）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) =>
    l.id === "france-fiefs-aquitaine-gascony-post-1214"
  );
  assert(
    entry !== undefined,
    "france-fiefs-aquitaine-gascony-post-1214 が無い",
  );
  assert(entry.text.includes("1214"), "text が 1214 年に言及していない");
  for (const year of SNAPSHOT_YEARS) {
    assertEquals(
      isKnownLimitationActiveForYear(entry, year),
      FRANCE_FIEF_OVERLAY_YEARS.includes(year) && year > 1214,
      `${year} 年の active 判定が期待と異なる`,
    );
  }
});

// TASK-75 / TASK-76 / TASK-83: 河川ラインが実際の河口まで描かれない。原因は
// 採用ソース（Natural Earth 50m rivers_lake_centerlines @ RIVERS_SOURCE_COMMIT）
// が幅の広い河口部・潟・入り江を河川センターラインではなく海として扱っており、
// その区間のラインが元データに存在しないこと。TASK-76 の横断検査
// （docs/data-inventory/rivers-continuity-audit.md §3.2）で、これはエルベ固有の
// 欠落ではなく Natural Earth 全体の一貫した仕様であり、ロワール・オーデル・
// テージョ・ドニプロ等にも同様に当てはまることが判明した。より詳細な 10m 版・
// ne_10m_rivers_europe でも同区間は収録されていないため補完可能な代替ソースが
// 無い。ユーザには描画不具合ではなくソース仕様の制約として明示する。
Deno.test("河口手前で河川が途切れる制約が NE 全体の仕様として明記されている（TASK-83）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "rivers-elbe-estuary-missing");
  assert(entry !== undefined, "rivers-elbe-estuary-missing が無い");
  // 途切れる位置を、ユーザが自分で地図と突き合わせられる形で説明していること。
  // 代表例は 3 河川（エルベ 9.78E / ロワール 1.74W / オーデル 14.58E）。
  for (
    const keyword of [
      "エルベ",
      "9.78",
      "ロワール",
      "1.74",
      "オーデル",
      "14.58",
      "Natural Earth",
    ]
  ) {
    assert(
      entry.text.includes(keyword),
      `text が ${keyword} に言及していない`,
    );
  }
  // エルベ限定ではなくソース全体の仕様であることが読み取れること
  assert(
    /河口部|潟/.test(entry.text) && entry.text.includes("海"),
    "text が「河口部・潟を海として扱う」仕様に言及していない",
  );
  assert(
    !/エルベ川?(の(ライン|線))?は北海の河口/.test(entry.text),
    "text がエルベ限定の記述のままになっている",
  );
  // 10m 版でも補完できないこと（代替ソース調査済みであること）に言及していること
  assert(
    entry.text.includes("10m"),
    "text が 10m 版の検証結果に言及していない",
  );
});

Deno.test("河口未到達の制約は河川オーバーレイと同じく年代非依存で常時 active（TASK-75）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "rivers-elbe-estuary-missing");
  assert(entry !== undefined);
  // 河川オーバーレイ（data/rivers.geojson）は年代非依存で全年代に同じラインを
  // 描くため、years は付けず常時該当とする
  assertEquals(entry.years, undefined);
  for (const year of SNAPSHOT_YEARS) {
    assertEquals(
      isKnownLimitationActiveForYear(entry, year),
      true,
      `${year} 年で active になっていない`,
    );
  }
});

// TASK-80: 元データ（aourednik/historical-basemaps）は全 feature の
// BORDERPRECISION が 1 = approximate（2 = moderately precise / 3 = 国際法で確定）
// で、提供者自身が「この年代の全境界は概略」と宣言している。アプリ側は描画で
// にじみ・低 alpha にして精密線に見せない対策を入れたが、「どこまで信じて
// よいデータなのか」はテキストでも明示する必要がある。
Deno.test("全境界が概略（BORDERPRECISION=1）である旨が明記されている（TASK-80 AC #7）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "borders-are-approximate");
  assert(entry !== undefined, "borders-are-approximate が無い");
  // 序数の意味（1 = 概略）と、数百 km の直線で近似される実例に言及していること
  for (
    const keyword of [
      "BORDERPRECISION",
      "概略",
      "277",
      "206",
      "1200",
      "historical-basemaps",
    ]
  ) {
    assert(
      entry.text.includes(keyword),
      `text が ${keyword} に言及していない`,
    );
  }
  assert(
    /直線/.test(entry.text),
    "text が直線での近似に言及していない",
  );
});

Deno.test("全境界が概略である制約は年代非依存で常時 active（TASK-80 AC #7）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "borders-are-approximate");
  assert(entry !== undefined);
  // BORDERPRECISION=1 は全年代・全 feature に付いているため years は付けない
  assertEquals(entry.years, undefined);
  for (const year of SNAPSHOT_YEARS) {
    assertEquals(
      isKnownLimitationActiveForYear(entry, year),
      true,
      `${year} 年で active になっていない`,
    );
  }
});

Deno.test("1700 年の制限注記は年代連動で 1700 のみ active になる（TASK-68）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "hre-boundaries-1700-extrapolated");
  assert(entry !== undefined);
  assertEquals(entry.years, { from: 1700, to: 1700 });
  for (const year of SNAPSHOT_YEARS) {
    assertEquals(
      isKnownLimitationActiveForYear(entry, year),
      year === 1700,
      `${year} 年の active 判定が期待と異なる`,
    );
  }
});

Deno.test("900 年専用だった HRE 領邦の制限は削除されている（TASK-119）", () => {
  // TASK-86 で years が {from: 900, to: 900} に縮小されていた
  // hre-territories-pre-1500 は、900 年のスナップショット廃止（TASK-119）で
  // 対象年が存在しなくなったため項目ごと削除した。
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "hre-territories-pre-1500");
  assertEquals(entry, undefined);
});

Deno.test("中世 HRE 領邦の表示対象年は全て SNAPSHOT_YEARS に含まれる（制限注記と実装の整合）", () => {
  for (const year of HRE_FIEF_OVERLAY_YEARS) {
    assert(
      SNAPSHOT_YEARS.includes(year),
      `${year} は SNAPSHOT_YEARS に含まれない`,
    );
  }
});

Deno.test("中世イタリア諸侯領の欠落が明記されている（TASK-96 AC #7）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "italy-fiefs-missing-territories");
  assert(entry !== undefined, "italy-fiefs-missing-territories が無い");
  // 収録できなかった主要勢力と、その理由（OHM 側の欠落）に言及していること
  for (
    const keyword of [
      "ミラノ",
      "ヴェネツィア",
      "ボローニャ",
      "ウルビーノ",
      "OpenHistoricalMap",
    ]
  ) {
    assert(entry.text.includes(keyword), `text が ${keyword} に言及していない`);
  }
  // 収録件数が薄い年代（1000 年は 3 件）を明示していること
  assert(
    entry.text.includes("1000年"),
    "text が 1000 年の収録状況に触れていない",
  );
});

Deno.test("イタリア諸侯領の制限注記はオーバーレイの対象年でのみ active（TASK-96 AC #7）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "italy-fiefs-missing-territories");
  assert(entry !== undefined);
  for (const year of SNAPSHOT_YEARS) {
    assertEquals(
      isKnownLimitationActiveForYear(entry, year),
      ITALY_FIEF_OVERLAY_YEARS.includes(year),
      `${year} 年の active 判定が期待と異なる`,
    );
  }
});

// TASK-103 の横断監査（docs/data-inventory/base-attribution-audit.md §6）で
// 「上流データの粒度・構造に由来し propertyFixes では直しきれない」と整理された
// 4 項目。propertyFixes（TASK-104 / TASK-106 / TASK-107）で是正できるのは
// properties の値だけで、年代ごとに独立した地図として作られていることに由来する
// 表記・形状のずれは残るため、ユーザに読める形で明示する（TASK-105）。
Deno.test("年代ごとの名称・宗主表記のぶれが明記されている（TASK-105 AC #1）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "base-attribution-snapshot-drift");
  assert(entry !== undefined, "base-attribution-snapshot-drift が無い");
  // 原因（上流が年代ごとに独立した地図）と、ユーザが突き合わせられる実例
  for (
    const keyword of [
      "historical-basemaps",
      "Kingdom of France",
      "Kingdom of Hungary",
      "Raška",
      "Sámi",
      "TASK-103",
    ]
  ) {
    assert(entry.text.includes(keyword), `text が ${keyword} に言及していない`);
  }
  // 表示名は対訳表が吸収するが配色は年代で変わる、という帰結に触れていること
  assert(/色/.test(entry.text), "text が配色への影響に言及していない");
});

Deno.test("名称・宗主表記のぶれは全年代に該当し常時 active（TASK-105 AC #1）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "base-attribution-snapshot-drift");
  assert(entry !== undefined);
  // 年代ごとに独立した地図という上流の作りは全年代に共通なので years は付けない
  assertEquals(entry.years, undefined);
  for (const year of SNAPSHOT_YEARS) {
    assertEquals(
      isKnownLimitationActiveForYear(entry, year),
      true,
      `${year} 年で active になっていない`,
    );
  }
});

Deno.test("名目上の宗主権の扱いが年代で揺れることが明記されている（TASK-105 AC #1）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "base-nominal-suzerainty");
  assert(entry !== undefined, "base-nominal-suzerainty が無い");
  // 揺れの実例（アルジェ・チュニス摂政領: 1800 のみオスマン従属）と、
  // 明白な誤りだけを是正する方針に触れていること
  for (
    const keyword of [
      "アルジェ",
      "チュニス",
      "オスマン",
      "1800",
      "1815",
      "同君連合",
      "TASK-103",
    ]
  ) {
    assert(entry.text.includes(keyword), `text が ${keyword} に言及していない`);
  }
  assert(/名目/.test(entry.text), "text が名目上の宗主権に言及していない");
});

Deno.test("名目上の宗主権の制限は全年代に該当し常時 active（TASK-105 AC #1）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "base-nominal-suzerainty");
  assert(entry !== undefined);
  // 名目的な従属関係の描き分けは特定年代に限らないため years は付けない
  assertEquals(entry.years, undefined);
  for (const year of SNAPSHOT_YEARS) {
    assertEquals(
      isKnownLimitationActiveForYear(entry, year),
      true,
      `${year} 年で active になっていない`,
    );
  }
});

Deno.test("消滅済み勢力名・過大な範囲の勢力名が明記されている（TASK-105 AC #1）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "base-extinct-or-overbroad-powers");
  assert(entry !== undefined, "base-extinct-or-overbroad-powers が無い");
  // 1400 Seljuk Caliphate（1308 年滅亡）・1279/1300 Ryazan（約 131 万 km²）
  for (
    const keyword of [
      "セルジューク",
      "1308",
      "リャザン",
      "131万",
      "TASK-103",
    ]
  ) {
    assert(entry.text.includes(keyword), `text が ${keyword} に言及していない`);
  }
  // 形状を分割・削除できない（= 名称や宗主の是正までしかできない）こと
  assert(
    /分割/.test(entry.text) && /出典/.test(entry.text),
    "text が形状を触らない方針に言及していない",
  );
  // TASK-106: 名称は上書き済みで、残る限界は「形状が実体と一致しない」ことだと
  // 読めること。上書き先の表示名（画面に出る日本語）を挙げて突き合わせられる
  // ようにする。
  for (
    const keyword of [
      "アナトリア諸侯国",
      "その他のルーシ諸公国",
      "TASK-106",
    ]
  ) {
    assert(entry.text.includes(keyword), `text が ${keyword} に言及していない`);
  }
});

Deno.test("消滅済み・過大な勢力名の制限は 1279〜1400 でのみ active（TASK-105 AC #1）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "base-extinct-or-overbroad-powers");
  assert(entry !== undefined);
  assertEquals(entry.years, { from: 1279, to: 1400 });
  for (const year of SNAPSHOT_YEARS) {
    assertEquals(
      isKnownLimitationActiveForYear(entry, year),
      year >= 1279 && year <= 1400,
      `${year} 年の active 判定が期待と異なる`,
    );
  }
});

Deno.test("年代をまたぐポリゴンの使い回しが明記されている（TASK-105 AC #1）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "base-shape-reuse");
  assert(entry !== undefined, "base-shape-reuse が無い");
  // 1279 Serbia / 1300 Raška / 1400 Bosnia は座標が完全一致（実測）。
  // 位置ずれの例として 1783・1800 の Mecklenburg-Strelitz も挙げる。
  for (
    const keyword of [
      "セルビア",
      "ラシュカ",
      "ボスニア",
      "1400",
      "メクレンブルク",
      "1783",
      "TASK-103",
    ]
  ) {
    assert(entry.text.includes(keyword), `text が ${keyword} に言及していない`);
  }
  assert(
    /同じ形|完全に一致/.test(entry.text),
    "text が形状の使い回しに言及していない",
  );
});

Deno.test("ポリゴン使い回しの制限は 1300〜1400 でのみ active（TASK-105 AC #1）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "base-shape-reuse");
  assert(entry !== undefined);
  // 同一形状が別勢力名で描かれる実害が出るのは Raška(1300) → Bosnia(1400)。
  // 1783・1800 のメクレンブルクも同種だが、years は連続範囲 1 つしか表せず
  // 1492〜1715 に誤った該当バッジが出るため、本文で補って years は広げない。
  assertEquals(entry.years, { from: 1300, to: 1400 });
  for (const year of SNAPSHOT_YEARS) {
    assertEquals(
      isKnownLimitationActiveForYear(entry, year),
      year >= 1300 && year <= 1400,
      `${year} 年の active 判定が期待と異なる`,
    );
  }
});

Deno.test("コルシカ島の帰属が諸侯領オーバーレイ側へ移ることが明記されている（TASK-96）", () => {
  // base の「コルシカ」は 1100 年以降ピサ／ジェノヴァ共和国のポリゴンに
  // 99.8% 覆われ、fief-dedupe の被覆率でラベルが抑制される。島名のラベルが
  // 消えることは表示側の不具合ではないので、その旨を残す。
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "italy-fiefs-missing-territories");
  assert(entry !== undefined);
  assert(entry.text.includes("コルシカ"), "text がコルシカ島に触れていない");
});

// ---- ブリテン諸島の政体オーバーレイ（#172）----

Deno.test("イングランド・アイルランド一括り収録の制限がオーバーレイの実態に合わせて更新されている（#172 AC #6）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "england-ireland-wales-1530-1700");
  assert(entry !== undefined, "england-ireland-wales-1530-1700 が無い");
  // base の一括り収録は変わらないが、OHM 由来のオーバーレイがアイルランドの
  // 政体を識別可能に描くようになったことを反映する
  for (
    const keyword of [
      "OpenHistoricalMap",
      "アイルランド王国",
      "アイルランド・カトリック同盟",
    ]
  ) {
    assert(entry.text.includes(keyword), `text が ${keyword} に言及していない`);
  }
  // TASK-39 時点の「分離して表示できません」という断定は実態に合わなくなった
  assert(
    !entry.text.includes("分離して表示できません"),
    "text がオーバーレイ追加前の記述のまま",
  );
  assertEquals(entry.years, { from: 1530, to: 1700 });
});

Deno.test("1283〜1707 のウェールズの欠落が年代連動で明示されている（#172 AC #6）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "britain-fiefs-wales-missing");
  assert(entry !== undefined, "britain-fiefs-wales-missing が無い");
  // 欠落が上流（OHM / Cliopatria）由来であることと、1284 年ルデュラン法令・
  // 1536 年併合法により史実とおおむね整合することの両方を明示する
  for (
    const keyword of ["OpenHistoricalMap", "Cliopatria", "1284", "1536"]
  ) {
    assert(entry.text.includes(keyword), `text が ${keyword} に言及していない`);
  }
  // ウェールズ諸王国が表示されるのは 1279 まで。欠落が生じるのは 1300 以降
  assertEquals(entry.years, { from: 1300, to: 1700 });
  for (const year of SNAPSHOT_YEARS) {
    assertEquals(
      isKnownLimitationActiveForYear(entry, year),
      year >= 1300 && year <= 1700,
      `${year} 年の active 判定が期待と異なる`,
    );
  }
});

Deno.test("アイルランドの Munster / Connacht / Ulster 欠落が年代連動で明示されている（#172 AC #6）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "britain-fiefs-ireland-partial");
  assert(entry !== undefined, "britain-fiefs-ireland-partial が無い");
  for (
    const keyword of [
      "マンスター",
      "コナハト",
      "アルスター",
      "OpenHistoricalMap",
    ]
  ) {
    assert(entry.text.includes(keyword), `text が ${keyword} に言及していない`);
  }
  // 部分的な描画になるのは中世（1000〜1300）。1600 以降はアイルランド王国の
  // 単一政体が島全体を覆うため部分欠落ではなくなる
  assertEquals(entry.years, { from: 1000, to: 1300 });
});

// ---- 主権政体オーバーレイ（#189）----

Deno.test("主権政体オーバーレイで埋められない政体が年代連動で明示されている（#189 AC9）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) =>
    l.id === "sovereign-fiefs-missing-territories"
  );
  assert(entry !== undefined, "sovereign-fiefs-missing-territories が無い");
  // 埋められない政体（実測でリレーション不在・面が組めない）を明示する:
  // 1530〜1715 年のハンガリー王国（境界 way の無いリレーション）、
  // 1600〜1650 年のトランシルヴァニア公国、1492〜1800 年のモルダヴィア公国、
  // 1400〜1650 年のラグーザ共和国、1400 年のセルビア、1783 年のモンテネグロ
  for (
    const keyword of [
      "ハンガリー王国",
      "トランシルヴァニア",
      "モルダヴィア",
      "ラグーザ",
      "モンテネグロ",
      "OpenHistoricalMap",
    ]
  ) {
    assert(entry.text.includes(keyword), `text が ${keyword} に言及していない`);
  }
  assertEquals(entry.years, { from: 1400, to: 1815 });
  for (const year of SNAPSHOT_YEARS) {
    assertEquals(
      isKnownLimitationActiveForYear(entry, year),
      year >= 1400 && year <= 1815,
      `${year} 年の active 判定が期待と異なる`,
    );
  }
});

// ---- 主権政体オーバーレイ・西欧/イタリア/地中海（#190）----

Deno.test("西欧・イタリア・地中海で埋められない政体が年代連動で明示されている（#190 AC7）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) =>
    l.id === "sovereign-fiefs-western-missing-territories"
  );
  assert(
    entry !== undefined,
    "sovereign-fiefs-western-missing-territories が無い",
  );
  // 埋められない対象（実測でリレーション不在・面が組めない）を明示する:
  // 1650/1700 年のスペイン領ネーデルラント（境界 way の無いリレーション）、
  // 1492 年のミラノ公国（OHM に 1447〜1500 年の区画が無い）、
  // 1279/1300 年のナポリ（OHM の収録は 1302 年開始）、南イタリア諸侯領
  for (
    const keyword of [
      "スペイン領ネーデルラント",
      "ルクセンブルク",
      "ミラノ公国",
      "ナポリ王国",
      "南イタリア諸侯領",
      "OpenHistoricalMap",
    ]
  ) {
    assert(entry.text.includes(keyword), `text が ${keyword} に言及していない`);
  }
  assertEquals(entry.years, { from: 1000, to: 1700 });
  for (const year of SNAPSHOT_YEARS) {
    assertEquals(
      isKnownLimitationActiveForYear(entry, year),
      year >= 1000 && year <= 1700,
      `${year} 年の active 判定が期待と異なる`,
    );
  }
});

// ---- 微小国家の欠落主張の年代限定（#191 / #219）----
//
// #191 の allowlist（scripts/build-sovereign-fiefs.ts）は微小国家 4 政体を
// サンマリノ 1000〜・アンドラ 1279〜・リヒテンシュタイン 1783〜・モナコ 1815〜
// で表示する（サンマリノの 1815 年は base 側が担う）。したがって全政体が揃う
// 1815 年以降にはジオメトリの欠落が存在せず、欠落を主張する既知の制限を
// 1880 / 1900 / 1914 で表示してはならない（表示すると存在しない欠落を主張する
// 嘘になる）。サイズ・視認性の注意だけは全期間に該当する。

/** #191 の微小国家 4 政体 */
const MICROSTATE_NAMES = [
  "San Marino",
  "Andorra",
  "Liechtenstein",
  "Monaco",
] as const;

/** allowlist が定める、その政体がオーバーレイに最初に現れる年 */
function microstateFirstOverlayYear(name: string): number {
  const year = SNAPSHOT_YEARS.find((candidate) =>
    sovereignFiefIdsForYear(candidate).some((id) =>
      SOVEREIGN_FIEF_ALLOWLIST[id].name === name
    )
  );
  assert(year !== undefined, `${name} が allowlist のどの年にも現れない`);
  return year;
}

Deno.test("微小国家の欠落主張は全政体が揃う 1815 年以降に表示されない（#219 AC3）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "sovereign-fiefs-microstates");
  assert(entry !== undefined, "sovereign-fiefs-microstates が無い");
  // 最も遅い表示開始年（モナコの 1815）以降は 4 政体すべてが描画されるため、
  // ジオメトリの欠落を主張してはならない（1880 / 1900 / 1914 を含む）
  const latestStart = Math.max(
    ...MICROSTATE_NAMES.map(microstateFirstOverlayYear),
  );
  assertEquals(latestStart, 1815);
  for (const year of SNAPSHOT_YEARS) {
    assertEquals(
      isKnownLimitationActiveForYear(entry, year),
      year < latestStart,
      `${year} 年の active 判定が期待と異なる`,
    );
  }
});

Deno.test("微小国家の years と summary は allowlist の表示開始年と一致する（#219 AC4）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "sovereign-fiefs-microstates");
  assert(entry !== undefined, "sovereign-fiefs-microstates が無い");
  // allowlist から導出した表示開始年（変わったらこの期待値ごと見直す）
  const starts = Object.fromEntries(
    MICROSTATE_NAMES.map((name) => [name, microstateFirstOverlayYear(name)]),
  );
  assertEquals(starts, {
    "San Marino": 1000,
    "Andorra": 1279,
    "Liechtenstein": 1783,
    "Monaco": 1815,
  });
  // years: 最初のスナップショット年 〜 全政体が揃う直前のスナップショット年
  const latestStart = Math.max(...Object.values(starts));
  const lastGapYear = SNAPSHOT_YEARS.filter((year) => year < latestStart).at(
    -1,
  );
  assertEquals(entry.years, { from: SNAPSHOT_YEARS[0], to: lastGapYear });
  // summary: base に無い 3 政体の表示開始年が allowlist の実際と一致して読める
  assert(entry.summary !== undefined, "summary が無い");
  for (
    const [name, label] of [
      ["Andorra", "アンドラ"],
      ["Liechtenstein", "リヒテンシュタイン"],
      ["Monaco", "モナコ"],
    ] as const
  ) {
    assert(
      entry.summary.includes(`${label}は${starts[name]}年`),
      `summary が ${label} の表示開始年 ${starts[name]} を示していない`,
    );
  }
  // text 側も表示開始年と食い違わない（旧記述 1278 / 1719 だけで語らない）
  for (const name of ["Andorra", "Liechtenstein", "Monaco"]) {
    assert(
      entry.text.includes(String(starts[name])),
      `text が ${name} の表示開始年 ${starts[name]} に言及していない`,
    );
  }
});

Deno.test("微小国家のサイズ・視認性の注意は分割され全期間に残る（#219 AC3）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) =>
    l.id === "sovereign-fiefs-microstates-visibility"
  );
  assert(entry !== undefined, "sovereign-fiefs-microstates-visibility が無い");
  // 微小国家はサンマリノが全 19 年代に表示されるため、注意も全年代で該当する
  for (const year of SNAPSHOT_YEARS) {
    assertEquals(
      isKnownLimitationActiveForYear(entry, year),
      true,
      `${year} 年で active になっていない`,
    );
  }
  // モナコの塗りが縮尺によらずほとんど見えない旨（元エントリから引き継ぐ）
  for (const keyword of ["モナコ", "2km²", "ラベル"]) {
    assert(entry.text.includes(keyword), `text が ${keyword} に言及していない`);
  }
  // 欠落の主張はこちらのエントリに持ち込まない（分割の趣旨）
  assert(
    !entry.text.includes("表示できません"),
    "視認性の注意にジオメトリ欠落の主張が混入している",
  );
});

// ---- 1815 年以降の UK 構成国を表示しない判断（#174 / ADR-0034）----
//
// OHM には 1815 年以降の UK 構成国（admin_level=4 の Scotland / England and
// Wales / Ireland）が存在するが、本アプリの「勢力」は主権政体とその従属関係を
// 指し、1801 年合同法以降の構成国は一主権国家の内部行政区分で層が違うため
// 採用しないと決めた（ADR-0034）。ユーザから見れば「ブリテン諸島が一括りで
// 区別できない」ことに変わりはないので、なぜ分けないのかを読める形で残す。

Deno.test("1815 年以降の UK 構成国を表示しない理由が明記されている（#174 AC4）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) =>
    l.id === "uk-constituent-countries-1815-1914"
  );
  assert(entry !== undefined, "uk-constituent-countries-1815-1914 が無い");
  // 理由 (1): 1801 年合同法以降の構成国は一主権国家の内部行政区分である
  for (const keyword of ["1801", "行政区分", "主権"]) {
    assert(entry.text.includes(keyword), `text が ${keyword} に言及していない`);
  }
  // 理由 (2): UK だけ第 1 級行政区分を出すと他の多民族国家と整合が崩れる
  for (const keyword of ["オーストリア", "ロシア帝国", "プロイセン"]) {
    assert(entry.text.includes(keyword), `text が ${keyword} に言及していない`);
  }
  // 理由 (3): 単一の主権国家であることは史実として正しく欠落ではない
  assert(
    /史実/.test(entry.text) && /欠落/.test(entry.text),
    "text が「単一ポリゴンは欠落ではない」旨に言及していない",
  );
  // 常に一括りではないこと（#151 / #172 の成果。1707 年合同法より前は個別表示）
  for (const keyword of ["1707", "スコットランド"]) {
    assert(entry.text.includes(keyword), `text が ${keyword} に言及していない`);
  }
  // 傍証 1: ウェールズ単独は分離できない（OHM は 1707〜1967 を England and
  // Wales という単一法域として持ち、1536 年併合法以降の史実と整合する）
  for (
    const keyword of ["England and Wales", "1536", "1967", "OpenHistoricalMap"]
  ) {
    assert(entry.text.includes(keyword), `text が ${keyword} に言及していない`);
  }
  // 傍証 2: Scotland リレーションの bbox 北端 59.46 度はシェトランドを含まない
  for (const keyword of ["59.46", "シェトランド"]) {
    assert(entry.text.includes(keyword), `text が ${keyword} に言及していない`);
  }
});

Deno.test("UK 構成国を表示しない制限は 1815〜1914 でのみ active（#174 AC4）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) =>
    l.id === "uk-constituent-countries-1815-1914"
  );
  assert(entry !== undefined);
  // base が United Kingdom of Great Britain and Ireland を単一 feature として
  // 持つのは 1815 以降（1715 / 1783 / 1800 は UK と Kingdom of Ireland が別）
  assertEquals(entry.years, { from: 1815, to: 1914 });
  for (const year of SNAPSHOT_YEARS) {
    assertEquals(
      isKnownLimitationActiveForYear(entry, year),
      year >= 1815 && year <= 1914,
      `${year} 年の active 判定が期待と異なる`,
    );
  }
});

Deno.test("UK 構成国の項目は 1530〜1700 の一括り収録の項目と年代が重ならない（#174 AC4）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const legacy = parsed.find((l) => l.id === "england-ireland-wales-1530-1700");
  const entry = parsed.find((l) =>
    l.id === "uk-constituent-countries-1815-1914"
  );
  assert(legacy !== undefined, "既存の 1530〜1700 の項目が削除されている");
  assert(entry !== undefined);
  assert(legacy.years !== undefined && entry.years !== undefined);
  // 同時に active にならない（パネルに同種の説明が 2 件並ばない）
  assert(
    entry.years.from > legacy.years.to,
    "1530〜1700 の項目と年代範囲が重なっている",
  );
  for (const year of SNAPSHOT_YEARS) {
    assert(
      !(isKnownLimitationActiveForYear(entry, year) &&
        isKnownLimitationActiveForYear(legacy, year)),
      `${year} 年で両方の項目が active になっている`,
    );
  }
});

Deno.test("1200 年のボヘミアの制限が借用近似の実態と一致する（#346）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "base-poland-paint-bohemia-1200");
  assert(entry !== undefined, "base-poland-paint-bohemia-1200 が無い");
  // 年代連動: 1200 年だけで表示される
  assertEquals(entry.years?.from, 1200);
  assertEquals(entry.years?.to, 1200);
  for (const year of SNAPSHOT_YEARS) {
    assertEquals(
      isKnownLimitationActiveForYear(entry, year),
      year === 1200,
      `${year} 年の active 判定が期待と異なる`,
    );
  }
  // #346 で「ポーランド塗りのまま」から「1202–1215 年区画の 2 年外挿」へ
  // 変わったので、UI から借用元（区間・データセット・SeshatID・ライセンス）が
  // 追えること（ADR-0033 の追跡可能性 / ADR-0039）
  for (
    const keyword of [
      "1202",
      "1215",
      "Cliopatria",
      "cz_bohemian_k_1",
      "CC BY 4.0",
      "モラヴィア",
    ]
  ) {
    assert(
      entry.text.includes(keyword),
      `text が ${keyword} に言及していない`,
    );
  }
  for (const stale of ["ポーランド塗りのまま", "該当区画が無いため"]) {
    assert(
      !entry.text.includes(stale) && !(entry.summary ?? "").includes(stale),
      `修正前の記述「${stale}」が残っている`,
    );
  }
});

// ---------------------------------------------------------------------------
// #377: 1200 年の西ボヘミアが素の神聖ローマ帝国として表示される事実の開示
// ---------------------------------------------------------------------------

/**
 * 借用区画（Cliopatria cz_bohemian_k_1）が含まない西ボヘミアの都市。
 * #377 の再現手順で「ボヘミア王国」ではなく素の「神聖ローマ帝国」を返す地点。
 */
const WEST_BOHEMIA_CITIES: readonly {
  readonly label: string;
  readonly point: readonly [number, number];
}[] = [
  { label: "プルゼニ", point: [13.38, 49.75] },
  { label: "カルロヴィ・ヴァリ", point: [12.87, 50.23] },
  { label: "ヘプ", point: [12.37, 50.08] },
];

/** 対照: 借用区画に含まれる（切り出し自体は効いている）プラハ */
const PRAGUE: readonly [number, number] = [14.42, 50.09];

/** 点がポリゴン/マルチポリゴンの内側か（テスト専用の素朴な ray casting 判定） */
function containsPoint(
  geometry: Feature["geometry"],
  point: readonly [number, number],
): boolean {
  const parts = geometry.type === "Polygon"
    ? [geometry.coordinates]
    : geometry.type === "MultiPolygon"
    ? geometry.coordinates
    : [];
  let inside = false;
  for (const part of parts) {
    let hit = false;
    for (const [ringIndex, ring] of part.entries()) {
      let crossings = false;
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        if (
          (y1 > point[1]) !== (y2 > point[1]) &&
          point[0] < (x2 - x1) * (point[1] - y1) / (y2 - y1) + x1
        ) {
          crossings = !crossings;
        }
      }
      if (ringIndex === 0) hit = crossings;
      else if (crossings) hit = false;
    }
    if (hit) inside = !inside;
  }
  return inside;
}

Deno.test("#377: 1200 年のボヘミアの制限が西ボヘミアの帝国吸収を開示している", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "base-poland-paint-bohemia-1200");
  assert(entry !== undefined, "base-poland-paint-bohemia-1200 が無い");
  const full = `${entry.summary ?? ""}\n${entry.text}`;
  // 借用区画が含まない範囲を利用者が地点で特定できること
  for (const { label } of WEST_BOHEMIA_CITIES) {
    assert(full.includes(label), `${label} に言及していない`);
  }
  // 「借用区画が西ボヘミアを含まない」ことと、その結果その一帯が
  // 「ボヘミア王国」ではなく素の「神聖ローマ帝国」になることの両方が読めること
  assert(
    entry.text.includes("西ボヘミア"),
    "text が西ボヘミアに言及していない",
  );
  assert(
    entry.text.includes("素の「神聖ローマ帝国」"),
    "text から素の神聖ローマ帝国として表示されることが読み取れない",
  );
  assert(
    /cz_bohemian_k_1[\s\S]*西ボヘミア[\s\S]*含みません/.test(entry.text),
    "借用区画 cz_bohemian_k_1 が西ボヘミアを含まない旨が読み取れない",
  );
  // 既定表示の要約だけを見たユーザーもこの欠落に辿り着けること
  assert(
    (entry.summary ?? "").includes("西ボヘミア"),
    "summary が西ボヘミアに言及していない",
  );
});

Deno.test("#377: 西ボヘミアの 3 都市は 1200 年の base でボヘミア王国ではなく帝国に含まれる", async () => {
  const base = JSON.parse(
    await Deno.readTextFile("data/europe_1200.geojson"),
  ) as FeatureCollection;
  const featuresNamed = (name: string) =>
    base.features.filter((f) => (f.properties ?? {}).NAME === name);
  const bohemia = featuresNamed("Kingdom of Bohemia");
  const hre = featuresNamed("Holy Roman Empire");
  assert(bohemia.length > 0, "Kingdom of Bohemia が 1200 年の base に無い");
  assert(hre.length > 0, "Holy Roman Empire が 1200 年の base に無い");
  for (const { label, point } of WEST_BOHEMIA_CITIES) {
    assert(
      !bohemia.some((f) => containsPoint(f.geometry, point)),
      `${label} がボヘミア王国に含まれている（制限の文言と実データがずれている）`,
    );
    assert(
      hre.some((f) => containsPoint(f.geometry, point)),
      `${label} が神聖ローマ帝国に含まれていない（制限の文言と実データがずれている）`,
    );
  }
  // 切り出し自体は効いている（プラハはボヘミア王国側）
  assert(
    bohemia.some((f) => containsPoint(f.geometry, PRAGUE)),
    "プラハがボヘミア王国に含まれていない",
  );
});

Deno.test("1300 年のブロワ伯領の欠落が 1300 年だけで active（#321）", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "cliopatria-fiefs-blois-1300");
  assert(entry !== undefined, "cliopatria-fiefs-blois-1300 が無い");
  // 年代連動: 1300 年だけで表示される
  assertEquals(entry.years?.from, 1300);
  assertEquals(entry.years?.to, 1300);
  for (const year of SNAPSHOT_YEARS) {
    assertEquals(
      isKnownLimitationActiveForYear(entry, year),
      year === 1300,
      `${year} 年の active 判定が期待と異なる`,
    );
  }
  // 何が欠けるのか・なぜ欠けるのかが読み取れること
  for (
    const keyword of [
      "ブロワ",
      "1300",
      "Cliopatria",
      "1279",
      "頂点",
      "3,658",
    ]
  ) {
    assert(
      entry.text.includes(keyword),
      `text が ${keyword} に言及していない`,
    );
  }
});

// ---------------------------------------------------------------------------
// #352 / ADR-0040: ポーランドの外周置換の開示
// ---------------------------------------------------------------------------

Deno.test("#352: ポーランド外周の置換が出典・期間・ピン留めごと開示されている", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) =>
    l.id === "base-poland-outline-replaced-cliopatria"
  );
  assert(entry !== undefined, "base-poland-outline-replaced-cliopatria が無い");
  assertEquals(entry.years?.from, 1000);
  assertEquals(entry.years?.to, 1400);
  for (
    const keyword of [
      "Cliopatria",
      "CC BY 4.0",
      "ad28a691b7c07c1fca89d0e0636d324667d2a258",
      "d01ae3a20d358cc5d54f69d9d725d390767d9c8759ac89ad6f90c58d106f3370",
      "pl_piast_dyn_1",
      "pl_piast_dyn_2",
      "pl_jagiellonian_dyn",
      "(Kingdom of Poland)",
      "(Duchies of Poland)",
      "(Polish-Lithuania Kingdom)",
      // 置換前後の最長線分（AC の数値がユーザーから追えること）
      "841.7km",
      "195.4km",
      "74.4km",
    ]
  ) {
    assert(entry.text.includes(keyword), `text が ${keyword} に言及していない`);
  }
});

Deno.test("#352: 置換で生じた差分の帰属先と未詳の扱いが開示されている", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) =>
    l.id === "base-poland-outline-difference-reassigned"
  );
  assert(
    entry !== undefined,
    "base-poland-outline-difference-reassigned が無い",
  );
  for (
    const keyword of [
      // 帰属先（機械的に決めたものであることを含めて開示する）
      "境界を最も長く共有",
      "キエフ・ルーシ",
      "ドイツ騎士団領",
      "神聖ローマ帝国",
      // 例外（クラクフを含む小ポーランドはポーランドに残す）
      "クラクフ",
      // 未詳のまま残す断片
      "空白",
    ]
  ) {
    assert(entry.text.includes(keyword), `text が ${keyword} に言及していない`);
  }
});

Deno.test("#352: Cliopatria 原典に残る長い直線が制約として開示されている", () => {
  const parsed = parseKnownLimitations(knownLimitations);
  const entry = parsed.find((l) => l.id === "cliopatria-poland-long-segments");
  assert(entry !== undefined, "cliopatria-poland-long-segments が無い");
  assertEquals(entry.years?.from, 1279);
  assertEquals(entry.years?.to, 1400);
  for (
    const keyword of ["110.7km", "195.4km", "Cliopatria", "0.07度"]
  ) {
    assert(entry.text.includes(keyword), `text が ${keyword} に言及していない`);
  }
  // 補間で滑らかにしていないことが読み取れること（AC）
  assert(
    entry.text.includes("スプライン") && entry.text.includes("揺らぎ"),
    "人工的な補間をしていないことが text から読み取れない",
  );
});
