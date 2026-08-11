import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import area from "@turf/area";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { featureCollection } from "@turf/helpers";
import intersect from "@turf/intersect";
import type { Feature, FeatureCollection, Polygon, Position } from "geojson";
import {
  classifyOverlap,
  CONTAINMENT_COVERAGE_THRESHOLD,
  FIEF_FLAT_YEARS,
  flatPathFor,
  HRE_FIEF_FLAT_YEARS,
  hreFlatPathFor,
  hreRawPathFor,
  ITALY_FIEF_FLAT_YEARS,
  italyFlatPathFor,
  italyRawPathFor,
  MIN_OVERLAP_AREA_M2,
  overlapsOf,
  rawPathFor,
  resolveOverlaps,
  SLIVER_AREA_LIMIT_M2,
  subtractOverlay,
} from "./build-fief-flat.ts";
import { FRANCE_FIEF_YEARS } from "./build-france-fiefs.ts";
import { HRE_FIEF_YEARS } from "./build-hre-fiefs.ts";
import { ITALY_FIEF_YEARS } from "./build-italy-fiefs.ts";

/** 経度・緯度の矩形ポリゴン feature を作る（反時計回り） */
function rect(
  name: string,
  west: number,
  south: number,
  east: number,
  north: number,
): Feature<Polygon> {
  const ring: Position[] = [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
  return {
    type: "Feature",
    properties: { NAME: name },
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}

/** feature 群から FeatureCollection を作る */
function fcOf(...features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

/** NAME で feature を引く */
function byName(fc: FeatureCollection, name: string): Feature {
  const found = fc.features.find((f) => f.properties?.NAME === name);
  assert(found !== undefined, `${name} が出力に無い`);
  return found;
}

Deno.test("classifyOverlap は被覆率で内包とスリバーを判定する（TASK-79）", () => {
  const smaller = 1_000e6; // 1,000 km²
  // 実測（1000〜1300 の全 fief）: 内包は Alençon×Normandy の 1.0000 のみで、
  // 次に大きいのは Bar×Champagne の 0.0541。閾値 0.9 はこの空隙の中にある。
  assertEquals(classifyOverlap(smaller, smaller), "containment");
  assertEquals(
    classifyOverlap(smaller * CONTAINMENT_COVERAGE_THRESHOLD, smaller),
    "containment",
  );
  assertEquals(
    classifyOverlap(smaller * (CONTAINMENT_COVERAGE_THRESHOLD - 0.01), smaller),
    "sliver",
  );
  assertEquals(classifyOverlap(smaller * 0.0541, smaller), "sliver");
  // 実測ノイズ未満（MIN_OVERLAP_AREA_M2 未満）は処理対象にしない
  assertEquals(classifyOverlap(MIN_OVERLAP_AREA_M2 - 1, smaller), "none");
  assertEquals(classifyOverlap(0, smaller), "none");
  // 面積 0 の feature（不正ジオメトリ）でも例外にせず none
  assertEquals(classifyOverlap(0, 0), "none");
});

Deno.test("overlapsOf は重なりを検出し、内包は大きい側・スリバーは小さい側を削り手に選ぶ（TASK-79）", () => {
  const parent = rect("Parent", 0, 45, 2, 47);
  const child = rect("Child", 0.5, 45.5, 1, 46);
  const neighbour = rect("Neighbour", 1.99, 45, 3, 46);
  const far = rect("Far", 10, 45, 11, 46);
  const pairs = overlapsOf(fcOf(parent, child, neighbour, far).features);

  const containment = pairs.find((p) => p.kind === "containment");
  assert(containment !== undefined, "内包が検出されない");
  assertEquals(containment.cutName, "Parent");
  assertEquals(containment.keepName, "Child");

  const sliver = pairs.find((p) => p.kind === "sliver");
  assert(sliver !== undefined, "スリバーが検出されない");
  // Parent(2°×2°) と Neighbour(1.01°×1°) では Neighbour が小さい側
  assertEquals(sliver.cutName, "Neighbour");
  assertEquals(sliver.keepName, "Parent");

  // 重ならない Far は 1 件も出ない
  assertEquals(pairs.filter((p) => p.cutName === "Far").length, 0);
  assertEquals(pairs.length, 2);
});

Deno.test("resolveOverlaps は内包する親から子を差し引き、子のジオメトリは変更しない（TASK-79 AC #1）", () => {
  const parent = rect("Parent", 0, 45, 2, 47);
  const child = rect("Child", 0.5, 45.5, 1, 46);
  const input = fcOf(parent, child);
  const { fc, resolutions } = resolveOverlaps(input);

  assertEquals(resolutions.length, 1);
  assertEquals(resolutions[0].kind, "containment");
  assertEquals(resolutions[0].cutName, "Parent");
  assertEquals(resolutions[0].keptName, "Child");

  // 子は入力と完全同一（輪郭・ラベル・picking の維持）
  assertEquals(
    JSON.stringify(byName(fc, "Child").geometry),
    JSON.stringify(child.geometry),
  );
  // 親は子の分だけ面積が減る（= 二重塗りの解消）
  const parentAfter = byName(fc, "Parent");
  assertAlmostEquals(
    area(parentAfter),
    area(parent) - area(child),
    area(parent) * 1e-6,
  );
  // 親と子はもう重ならない
  const rest = intersect(
    // deno-lint-ignore no-explicit-any
    featureCollection([parentAfter as any, child as any]),
  );
  assert(
    rest === null || area(rest) < MIN_OVERLAP_AREA_M2,
    "内包解消後も重なりが残っている",
  );
});

Deno.test("resolveOverlaps は子の picking を維持し、親は子の内側で当たらなくなる（TASK-79）", () => {
  const parent = rect("Parent", 0, 45, 2, 47);
  const child = rect("Child", 0.5, 45.5, 1, 46);
  const { fc } = resolveOverlaps(fcOf(parent, child));
  const inside: Position = [0.75, 45.75];
  // deno-lint-ignore no-explicit-any
  assert(booleanPointInPolygon(inside, byName(fc, "Child") as any));
  // deno-lint-ignore no-explicit-any
  assert(!booleanPointInPolygon(inside, byName(fc, "Parent") as any));
  // 親の外側（子ではない領域）は従来どおり親が当たる
  // deno-lint-ignore no-explicit-any
  assert(booleanPointInPolygon([1.5, 46.5], byName(fc, "Parent") as any));
});

Deno.test("resolveOverlaps はスリバーを面積の小さい側から削る（TASK-79 AC #2）", () => {
  const big = rect("Big", 0, 45, 2, 47);
  const small = rect("Small", 1.9, 45.5, 2.5, 46);
  const { fc, resolutions } = resolveOverlaps(fcOf(big, small));

  assertEquals(resolutions.length, 1);
  assertEquals(resolutions[0].kind, "sliver");
  assertEquals(resolutions[0].cutName, "Small");
  assertEquals(resolutions[0].keptName, "Big");
  // 大きい側は無変更
  assertEquals(
    JSON.stringify(byName(fc, "Big").geometry),
    JSON.stringify(big.geometry),
  );
  // 小さい側は重なり分だけ減る
  assert(area(byName(fc, "Small")) < area(small));
  const rest = intersect(
    // deno-lint-ignore no-explicit-any
    featureCollection([byName(fc, "Big") as any, byName(fc, "Small") as any]),
  );
  assert(
    rest === null || area(rest) < MIN_OVERLAP_AREA_M2,
    "スリバー解消後も重なりが残っている",
  );
});

Deno.test("resolveOverlaps は重なりが無ければ入力をそのまま返す（TASK-79）", () => {
  const input = fcOf(rect("A", 0, 45, 1, 46), rect("B", 2, 45, 3, 46));
  const { fc, resolutions } = resolveOverlaps(input);
  assertEquals(resolutions.length, 0);
  assertEquals(JSON.stringify(fc.features), JSON.stringify(input.features));
});

Deno.test("resolveOverlaps は feature の並び・properties・非ポリゴンを保持し決定的（TASK-79）", () => {
  const point: Feature = {
    type: "Feature",
    properties: { NAME: "Point" },
    geometry: { type: "Point", coordinates: [0.75, 45.75] },
  };
  const input = fcOf(
    rect("Parent", 0, 45, 2, 47),
    point,
    rect("Child", 0.5, 45.5, 1, 46),
  );
  const first = resolveOverlaps(input);
  const second = resolveOverlaps(input);
  assertEquals(
    first.fc.features.map((f) => f.properties?.NAME),
    ["Parent", "Point", "Child"],
  );
  assertEquals(
    JSON.stringify(first.fc.features[1]),
    JSON.stringify(point),
  );
  assertEquals(JSON.stringify(first.fc), JSON.stringify(second.fc));
  assertEquals(
    JSON.stringify(first.resolutions),
    JSON.stringify(second.resolutions),
  );
});

Deno.test("SLIVER_AREA_LIMIT_M2 を超える非内包の重なりは警告する（TASK-79）", () => {
  // 実測のスリバー最大は 332 km²。これを大きく超える非内包の重なりは
  // 「データ誤り由来の微小重なり」ではないため、黙って削らず警告を残す。
  const a = rect("A", 0, 45, 2, 47);
  const b = rect("B", 1, 45, 3, 47);
  const warnings: string[] = [];
  const { resolutions } = resolveOverlaps(fcOf(a, b), (m) => warnings.push(m));
  assertEquals(resolutions.length, 1);
  assertEquals(resolutions[0].kind, "sliver");
  assert(area(a) * 0.5 > SLIVER_AREA_LIMIT_M2);
  assertEquals(warnings.length, 1);
  assert(warnings[0].includes("A"), warnings[0]);
});

Deno.test("FIEF_FLAT_YEARS は build-france-fiefs の対象年と一致する（TASK-79）", () => {
  assertEquals([...FIEF_FLAT_YEARS], [...FRANCE_FIEF_YEARS]);
});

Deno.test("パス関数は data/ 配下の入出力を指す（TASK-79）", () => {
  assertEquals(rawPathFor(1200), "data/france_fiefs_1200.geojson");
  assertEquals(flatPathFor(1200), "data/france_fiefs_flat_1200.geojson");
});

Deno.test("生成済みの france_fiefs_flat_<year> は raw と同じ feature 構成で重なりが解消されている（TASK-79 AC #1/#2）", async () => {
  for (const year of FIEF_FLAT_YEARS) {
    const raw = JSON.parse(
      await Deno.readTextFile(rawPathFor(year)),
    ) as FeatureCollection;
    const flat = JSON.parse(
      await Deno.readTextFile(flatPathFor(year)),
    ) as FeatureCollection;
    assertEquals(
      flat.features.map((f) => f.properties?.NAME),
      raw.features.map((f) => f.properties?.NAME),
      `${year}: feature の並び・件数が raw と異なる`,
    );
    for (const [i, f] of flat.features.entries()) {
      assertEquals(
        f.properties,
        raw.features[i].properties,
        `${year}: properties が raw と異なる`,
      );
    }
    // 残存する重なりは座標丸め（COORD_PRECISION=3、約 100m）由来のみ
    const fs = flat.features;
    for (let i = 0; i < fs.length; i++) {
      for (let j = i + 1; j < fs.length; j++) {
        // deno-lint-ignore no-explicit-any
        const ov = intersect(featureCollection([fs[i] as any, fs[j] as any]));
        const overlap = ov === null ? 0 : area(ov);
        assert(
          overlap < 1e6,
          `${year}: ${fs[i].properties?.NAME} × ${
            fs[j].properties?.NAME
          } の重なりが ${(overlap / 1e6).toFixed(3)} km² 残っている`,
        );
      }
    }
  }
});

// ---- TASK-86: HRE 領邦（OHM 由来・1000〜1492）の重なり解消 ----

Deno.test('overlapsOf の policy "keep-smaller" はスリバーでも大きい側を削り手にする（TASK-86）', () => {
  const parent = rect("Parent", 0, 45, 2, 47);
  const child = rect("Child", 0.5, 45.5, 1, 46);
  const neighbour = rect("Neighbour", 1.99, 45, 3, 46);
  const pairs = overlapsOf(
    fcOf(parent, child, neighbour).features,
    () => {},
    "keep-smaller",
  );

  // 内包は既定方針と同じ（親を削る）
  const containment = pairs.find((p) => p.kind === "containment");
  assert(containment !== undefined);
  assertEquals(containment.cutName, "Parent");
  assertEquals(containment.keepName, "Child");

  // スリバーは既定方針と逆で、小さい側（Neighbour）ではなく大きい側を削る
  const sliver = pairs.find((p) => p.kind === "sliver");
  assert(sliver !== undefined);
  assertEquals(sliver.cutName, "Parent");
  assertEquals(sliver.keepName, "Neighbour");
});

Deno.test('resolveOverlaps の policy "keep-smaller" は小さい側のジオメトリを丸ごと残す（TASK-86 AC #4）', () => {
  // HRE の実データ相当: 帝国修道院領（小）が部族大公領（大）に 45/55 で
  // またがる（Imperial Abbey of Werden × Lower Lotharingia / Saxony）。
  // 既定方針（スリバーは小さい側を削る）だと修道院領がほぼ消えてしまう。
  const west = rect("West", 0, 45, 2, 47);
  const east = rect("East", 2, 45, 4, 47);
  const abbey = rect("Abbey", 1.5, 45.5, 2.5, 46);
  const { fc, resolutions } = resolveOverlaps(
    fcOf(west, east, abbey),
    () => {},
    "keep-smaller",
  );

  // 修道院領は入力と完全同一（形・面積を失わない）
  assertEquals(byName(fc, "Abbey").geometry, abbey.geometry);
  assertAlmostEquals(
    area(byName(fc, "Abbey")),
    area(abbey),
    area(abbey) * 1e-6,
  );
  // 削られたのは両側の大公領
  assertEquals(
    resolutions.map((r) => r.cutName).sort(),
    ["East", "West"],
  );
  // 大公領の内側に修道院領の穴が空き、二重塗りが消える
  const inAbbey: Position = [1.75, 45.75];
  assert(
    !booleanPointInPolygon(inAbbey, byName(fc, "West") as Feature<Polygon>),
  );
});

Deno.test("subtractOverlay は別レイヤーで描かれる領域を差し引く（TASK-86 AC #4: 仏諸侯領との二重塗り解消）", () => {
  // 実データ: 1100 年の County of Bar（仏諸侯領レイヤー）は
  // Duchy of Upper Lotharingia（HRE 領邦レイヤー）にほぼ内包される。
  const duchy = rect("Duchy of Upper Lotharingia", 0, 45, 2, 47);
  const bar = rect("County of Bar", 0.5, 45.5, 1, 46);
  const outside = rect("Duchy of Bohemia", 10, 45, 11, 46);
  const { fc, removals } = subtractOverlay(
    fcOf(duchy, outside),
    fcOf(bar).features,
    () => {},
  );

  assertEquals(removals.length, 1);
  assertEquals(removals[0].cutName, "Duchy of Upper Lotharingia");
  assertEquals(removals[0].externalName, "County of Bar");
  // 重ならない feature は同一参照のまま
  assertEquals(byName(fc, "Duchy of Bohemia").geometry, outside.geometry);
  // 公領には Bar の穴が空く
  assert(
    !booleanPointInPolygon(
      [0.75, 45.75] as Position,
      byName(fc, "Duchy of Upper Lotharingia") as Feature<Polygon>,
    ),
  );
  // 並び・properties は保持
  assertEquals(fc.features.map((f) => f.properties?.NAME), [
    "Duchy of Upper Lotharingia",
    "Duchy of Bohemia",
  ]);
});

Deno.test("subtractOverlay は重なりが無ければ入力をそのまま返す（TASK-86）", () => {
  const a = rect("A", 0, 45, 1, 46);
  const b = rect("B", 10, 45, 11, 46);
  const input = fcOf(a);
  const { fc, removals } = subtractOverlay(input, fcOf(b).features, () => {});
  assertEquals(removals, []);
  assertEquals(fc.features[0].geometry, a.geometry);
});

Deno.test("HRE_FIEF_FLAT_YEARS は build-hre-fiefs の対象年と一致する（TASK-86）", () => {
  assertEquals([...HRE_FIEF_FLAT_YEARS], [...HRE_FIEF_YEARS]);
});

Deno.test("HRE 領邦のパス関数は data/ 配下の入出力を指す（TASK-86）", () => {
  assertEquals(hreRawPathFor(1300), "data/hre_fiefs_1300.geojson");
  assertEquals(hreFlatPathFor(1300), "data/hre_fiefs_flat_1300.geojson");
});

Deno.test("生成済みの hre_fiefs_flat_<year> は raw と同じ feature 構成で領邦同士の重なりが解消されている（TASK-86 AC #4）", async () => {
  for (const year of HRE_FIEF_FLAT_YEARS) {
    const raw = JSON.parse(
      await Deno.readTextFile(hreRawPathFor(year)),
    ) as FeatureCollection;
    const flat = JSON.parse(
      await Deno.readTextFile(hreFlatPathFor(year)),
    ) as FeatureCollection;
    assertEquals(
      flat.features.map((f) => f.properties?.NAME),
      raw.features.map((f) => f.properties?.NAME),
      `${year}: feature の並び・件数が raw と異なる`,
    );
    for (const [i, f] of flat.features.entries()) {
      assertEquals(
        f.properties,
        raw.features[i].properties,
        `${year}: properties が raw と異なる`,
      );
    }
    const fs = flat.features;
    for (let i = 0; i < fs.length; i++) {
      for (let j = i + 1; j < fs.length; j++) {
        // deno-lint-ignore no-explicit-any
        const ov = intersect(featureCollection([fs[i] as any, fs[j] as any]));
        const overlap = ov === null ? 0 : area(ov);
        assert(
          overlap < 1e6,
          `${year}: ${fs[i].properties?.NAME} × ${
            fs[j].properties?.NAME
          } の重なりが ${(overlap / 1e6).toFixed(3)} km² 残っている`,
        );
      }
    }
  }
});

Deno.test("hre_fiefs_flat と france_fiefs_flat は同時表示年（1000〜1300）で重ならない（TASK-86 AC #4）", async () => {
  for (const year of HRE_FIEF_FLAT_YEARS) {
    if (!FIEF_FLAT_YEARS.includes(year)) continue;
    const hre = JSON.parse(
      await Deno.readTextFile(hreFlatPathFor(year)),
    ) as FeatureCollection;
    const fr = JSON.parse(
      await Deno.readTextFile(flatPathFor(year)),
    ) as FeatureCollection;
    for (const h of hre.features) {
      for (const f of fr.features) {
        // deno-lint-ignore no-explicit-any
        const ov = intersect(featureCollection([h as any, f as any]));
        const overlap = ov === null ? 0 : area(ov);
        assert(
          overlap < 1e6,
          `${year}: ${h.properties?.NAME} × ${f.properties?.NAME} の重なりが ${
            (overlap / 1e6).toFixed(3)
          } km² 残っている`,
        );
      }
    }
  }
});

// ---- 中世イタリア諸侯領（TASK-96）----

Deno.test("ITALY_FIEF_FLAT_YEARS は build-italy-fiefs の対象年と一致する（TASK-96）", () => {
  assertEquals([...ITALY_FIEF_FLAT_YEARS], [...ITALY_FIEF_YEARS]);
});

Deno.test("イタリア諸侯領のパス関数は data/ 配下の入出力を指す（TASK-96）", () => {
  assertEquals(italyRawPathFor(1200), "data/italy_fiefs_1200.geojson");
  assertEquals(italyFlatPathFor(1200), "data/italy_fiefs_flat_1200.geojson");
});

Deno.test("生成済みの italy_fiefs_flat_<year> は raw と同じ feature 構成で諸侯領同士の重なりが解消されている（TASK-96 AC #5）", async () => {
  for (const year of ITALY_FIEF_FLAT_YEARS) {
    const raw = JSON.parse(
      await Deno.readTextFile(italyRawPathFor(year)),
    ) as FeatureCollection;
    const flat = JSON.parse(
      await Deno.readTextFile(italyFlatPathFor(year)),
    ) as FeatureCollection;
    assertEquals(
      flat.features.map((f) => f.properties?.NAME),
      raw.features.map((f) => f.properties?.NAME),
      `${year}: feature の並び・件数が raw と異なる`,
    );
    for (const [i, f] of flat.features.entries()) {
      assertEquals(
        f.properties,
        raw.features[i].properties,
        `${year}: properties が raw と異なる`,
      );
    }
    const fs = flat.features;
    for (let i = 0; i < fs.length; i++) {
      for (let j = i + 1; j < fs.length; j++) {
        // deno-lint-ignore no-explicit-any
        const ov = intersect(featureCollection([fs[i] as any, fs[j] as any]));
        const overlap = ov === null ? 0 : area(ov);
        assert(
          overlap < 1e6,
          `${year}: ${fs[i].properties?.NAME} × ${
            fs[j].properties?.NAME
          } の重なりが ${(overlap / 1e6).toFixed(3)} km² 残っている`,
        );
      }
    }
  }
});

Deno.test('イタリア諸侯領は "keep-smaller" で削るため、内包される小領邦が形を丸ごと保つ（TASK-96 AC #5）', async () => {
  // 1400 年の County of Santa Fiora（186 km²）は Republic of Siena に 99.7%
  // 内包され、County of Sovana（299 km²）も 99.8% 内包される。小さい側の形が
  // 残らないと、地図から消えてしまう。
  const flat = JSON.parse(
    await Deno.readTextFile(italyFlatPathFor(1400)),
  ) as FeatureCollection;
  const raw = JSON.parse(
    await Deno.readTextFile(italyRawPathFor(1400)),
  ) as FeatureCollection;
  const areaOf = (fc: FeatureCollection, name: string) =>
    area(fc.features.find((f) => f.properties?.NAME === name)! as Feature);

  // 相手より常に小さい側は形が丸ごと残る（座標は COORD_PRECISION へ丸め直される
  // ため完全一致では比較せず、相対誤差 1% で「丸めだけ」を確かめる）。
  // COORD_PRECISION = 3（グリッド ≒ 100 m）の丸めは 186 km² 規模の伯領で
  // 0.2〜0.3% 程度の面積変動を生む（実測）。削られていれば 99% 超を失うので、
  // この許容幅でも十分に区別できる。
  for (const name of ["County of Santa Fiora", "County of Pitigliano"]) {
    assertAlmostEquals(
      areaOf(flat, name),
      areaOf(raw, name),
      areaOf(raw, name) * 1e-2,
      `${name} のジオメトリが削られている`,
    );
  }
  // 削られるのは常に大きい側。シエナ共和国は内包する 2 伯領の分
  // （185 + 298 km²）を失い、ソヴァーナ伯領も自分より小さいピティリアーノ
  // 伯領との重なり分だけを失う。
  assert(areaOf(flat, "Republic of Siena") < areaOf(raw, "Republic of Siena"));
  assert(areaOf(flat, "County of Sovana") < areaOf(raw, "County of Sovana"));
});

// ---- 借用面の flat 化（#215）----
//
// 借用ジオメトリ（#202 / #209）はこれまで差引パイプラインを一切通らず、借用面が
// 覆った既存所領がピック不能・系統をまたぐ領域が二重塗りになっていた。
// 借用元ファイル（borrowed_<lineage>_<year>.geojson）は座標無改変のまま、
// 下流の flat 化（borrowed_<lineage>_flat_<year>.geojson）でホスト系統 flat を
// 差し引く。テスト内の固定座標は現行データからの実測（intersection の内部点）。

/** 借用 flat の生成物パス（build-fief-flat.ts の borrowedFlatPathFor と同値） */
function borrowedFlatPath(lineage: "hre" | "italy", year: number): string {
  return `data/borrowed_${lineage}_flat_${year}.geojson`;
}

/** 借用 flat とその同年ホスト系統 flat・sovereign flat の組（#215 AC3 の検査対象） */
const BORROWED_FLAT_PAIRS: ReadonlyArray<{
  borrowed: string;
  others: string[];
}> = [
  {
    borrowed: borrowedFlatPath("hre", 1492),
    others: [hreFlatPathFor(1492), "data/sovereign_fiefs_flat_1492.geojson"],
  },
  {
    borrowed: borrowedFlatPath("italy", 1492),
    others: [italyFlatPathFor(1492), "data/sovereign_fiefs_flat_1492.geojson"],
  },
  {
    borrowed: borrowedFlatPath("hre", 1715),
    others: [hreFlatPathFor(1715), "data/sovereign_fiefs_flat_1715.geojson"],
  },
];

Deno.test("1492 年のシャウンベルク伯領の内部点は借用 flat オーストリア大公領に含まれない（#215 AC1）", async () => {
  const hre = JSON.parse(
    await Deno.readTextFile(hreFlatPathFor(1492)),
  ) as FeatureCollection;
  const borrowed = JSON.parse(
    await Deno.readTextFile(borrowedFlatPath("hre", 1492)),
  ) as FeatureCollection;
  const schaunberg = byName(hre, "County of Schaunberg");
  const austria = byName(borrowed, "Archduchy of Austria");
  // 実測: 借用元の大公領はシャウンベルク伯領（2,266 km²）の 99.7% を覆っていた。
  // 固定点はその重なりの内部点（Eferding 近郊）。
  const inside: Position = [13.361, 47.996];
  // deno-lint-ignore no-explicit-any
  assert(booleanPointInPolygon(inside, schaunberg as any));
  assert(
    // deno-lint-ignore no-explicit-any
    !booleanPointInPolygon(inside, austria as any),
    "借用 flat 大公領がシャウンベルク伯領を覆ったまま（ピック不能が残る）",
  );
});

Deno.test("1492 年の借用 flat ミラノ公国の内部点を sovereign flat のどの feature も含まない（#215 AC2）", async () => {
  const borrowed = JSON.parse(
    await Deno.readTextFile(borrowedFlatPath("italy", 1492)),
  ) as FeatureCollection;
  const sovereign = JSON.parse(
    await Deno.readTextFile("data/sovereign_fiefs_flat_1492.geojson"),
  ) as FeatureCollection;
  const milan = byName(borrowed, "Duchy of Milan");
  // 実測: sovereign flat の Savoy は借用ミラノ公国域 887.87 km² を保持していた。
  // 固定点はその重なりの内部点（Vercelli 近郊）。
  const inside: Position = [8.017, 45.381];
  // deno-lint-ignore no-explicit-any
  assert(booleanPointInPolygon(inside, milan as any));
  for (const f of sovereign.features) {
    assert(
      // deno-lint-ignore no-explicit-any
      !booleanPointInPolygon(inside, f as any),
      `${f.properties?.NAME} が借用ミラノ公国域を保持したまま（二重塗り・誤ピックが残る）`,
    );
  }
});

Deno.test("借用 flat は同年のホスト系統 flat・sovereign flat と重ならない（#215 AC3）", async () => {
  for (const { borrowed, others } of BORROWED_FLAT_PAIRS) {
    const borrowedFc = JSON.parse(
      await Deno.readTextFile(borrowed),
    ) as FeatureCollection;
    for (const path of others) {
      const other = JSON.parse(
        await Deno.readTextFile(path),
      ) as FeatureCollection;
      for (const b of borrowedFc.features) {
        for (const o of other.features) {
          // deno-lint-ignore no-explicit-any
          const ov = intersect(featureCollection([b as any, o as any]));
          const overlap = ov === null ? 0 : area(ov);
          assert(
            overlap < 1e6,
            `${borrowed} ${b.properties?.NAME} × ${path} ${o.properties?.NAME} の重なりが ${
              (overlap / 1e6).toFixed(3)
            } km² 残っている`,
          );
        }
      }
    }
  }
});

Deno.test("italy_fiefs_flat は同時表示年で hre_fiefs_flat / france_fiefs_flat と重ならない（TASK-96 AC #5）", async () => {
  for (const year of ITALY_FIEF_FLAT_YEARS) {
    const italy = JSON.parse(
      await Deno.readTextFile(italyFlatPathFor(year)),
    ) as FeatureCollection;
    const others: FeatureCollection[] = [];
    if (HRE_FIEF_FLAT_YEARS.includes(year)) {
      others.push(
        JSON.parse(
          await Deno.readTextFile(hreFlatPathFor(year)),
        ) as FeatureCollection,
      );
    }
    if (FIEF_FLAT_YEARS.includes(year)) {
      others.push(
        JSON.parse(
          await Deno.readTextFile(flatPathFor(year)),
        ) as FeatureCollection,
      );
    }
    for (const other of others) {
      for (const i of italy.features) {
        for (const o of other.features) {
          // deno-lint-ignore no-explicit-any
          const ov = intersect(featureCollection([i as any, o as any]));
          const overlap = ov === null ? 0 : area(ov);
          assert(
            overlap < 1e6,
            `${year}: ${i.properties?.NAME} × ${o.properties?.NAME} の重なりが ${
              (overlap / 1e6).toFixed(3)
            } km² 残っている`,
          );
        }
      }
    }
  }
});
