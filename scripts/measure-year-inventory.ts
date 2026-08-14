/**
 * 年代別データインベントリ（`docs/data-inventory/year-<year>.md`）の実測値を
 * `data/` のコミット済みファイルから再生成する集計スクリプト（Issue #379）。
 *
 * ## なぜ必要か
 * 台帳（`docs/data-inventory/`）は「データの性質・欠落・監査結果の正」だが、
 * 集計に使っていた生成スクリプトは `.outputs/claude/data-inventory/_gen/` に
 * 置かれていて git 管理外だったため失われている（README.md §10）。値の出所を
 * 再現できないと台帳が現物からドリフトしても検出できないので、`scripts/` 配下に
 * 再実行可能な形で置き直す（プロジェクト CLAUDE.md「調査ドキュメントの出力先」）。
 *
 * ## 使い方
 * ```sh
 * deno task measure-year-inventory 1200
 * ```
 * 標準出力に TSV を節ごとに吐く（`# ` で始まる行が節の見出し）。ネットワーク・
 * 書き込みは行わず、入力は `data/` のコミット済みファイルのみなので出力は決定的。
 *
 * ## 面積の定義（台帳の「欧州域内」との差）
 * ここが出す面積は feature のジオメトリをそのまま `@turf/area`（球面近似
 * R=6,371,008.8 m）に掛けた **raw** の値で、`europe_<year>.geojson` が
 * 元から掛けられている欧州 bbox（西経 25°〜東経 60°・北緯 34°〜72°）より内側の
 * 絞り込みは行わない。台帳 README.md §2.1 の地理的ヨーロッパ境界（ウラル川・
 * 大コーカサス分水嶺・ボスポラス・地中海）でクリップする処理は元の生成
 * スクリプトとともに失われており、境界線の実体（近似折れ線の座標列）は
 * 散文からは復元できない。したがって:
 * - 欧州域内に全域が収まる勢力（台帳の「欧州比率」100%）は raw = 欧州域内。
 * - 域内外にまたがる勢力（同 100% 未満）は raw のみ再現でき、欧州域内の値は
 *   再現できない。台帳側にその旨を注記する。
 */

import area from "@turf/area";
import type {
  Feature,
  FeatureCollection,
  Geometry,
  MultiPolygon,
  Polygon,
} from "geojson";

const DATA_DIR = "data";

/** 領邦・諸侯領オーバーレイの系統（`<lineage>_fiefs_<year>.geojson`） */
export const FIEF_LINEAGES: readonly string[] = [
  "hre",
  "cliopatria",
  "italy",
  "britain",
  "sovereign",
  "france",
];

/** 勢力 1 件（同一 NAME の feature をまとめたもの） */
export interface PowerRow {
  readonly name: string;
  readonly abbrevn: string | null;
  readonly subjecto: string | null;
  /** SUBJECTO が NAME と異なる（属領・従属）か */
  readonly subordinate: boolean;
  readonly nameJa: string | null;
  readonly color: string | null;
  readonly borderPrecision: number | null;
  /** raw 面積 km²（四捨五入） */
  readonly areaKm2: number;
  /** 同一 NAME の feature 数（台帳の「ポリゴン数」列） */
  readonly features: number;
}

/** 無名ポリゴン（NAME = null）1 件 */
export interface UnnamedRow {
  readonly areaKm2: number;
  /** [west, south, east, north] */
  readonly bbox: readonly [number, number, number, number];
}

/** 領邦・諸侯領 1 件 */
export interface FiefRow {
  readonly name: string;
  readonly nameJa: string | null;
  readonly adminLevel: number | null;
  readonly ohmRelationId: number | null;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly subjecto: string | null;
  readonly areaKm2: number;
}

/** km² に丸める（`@turf/area` は m² を返す） */
function toKm2(m2: number): number {
  return Math.round(m2 / 1_000_000);
}

/** ポリゴン／マルチポリゴンの外接矩形を求める */
export function bboxOf(
  geometry: Geometry,
): [number, number, number, number] {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  const rings = geometry.type === "MultiPolygon"
    ? (geometry as MultiPolygon).coordinates.flat()
    : geometry.type === "Polygon"
    ? (geometry as Polygon).coordinates
    : [];
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < west) west = x;
      if (x > east) east = x;
      if (y < south) south = y;
      if (y > north) north = y;
    }
  }
  return [west, south, east, north];
}

/** 色の参照キー。属領は "NAME|SUBJECTO"（scripts/build-colors.ts と同じ規則） */
export function colorKeyOf(name: string, subjecto: string | null): string {
  return subjecto !== null && subjecto !== name ? `${name}|${subjecto}` : name;
}

/** 空文字・undefined を null に潰す */
function nullable(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/**
 * `europe_<year>.geojson` を NAME 単位に集計する。
 * 独立／属領の判定は台帳と同じく `SUBJECTO` と `NAME` の一致で行う
 * （README.md §10 の注記どおり、元データの表記ゆれはそのまま反映される）。
 */
export function aggregatePowers(
  fc: FeatureCollection,
  nameJa: Record<string, string>,
  colors: Record<string, string>,
): PowerRow[] {
  const acc = new Map<string, {
    abbrevn: string | null;
    subjecto: string | null;
    borderPrecision: number | null;
    areaM2: number;
    features: number;
  }>();
  for (const feature of fc.features) {
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const name = nullable(props.NAME);
    if (name === null) continue;
    const entry = acc.get(name) ?? {
      abbrevn: nullable(props.ABBREVN),
      subjecto: nullable(props.SUBJECTO),
      borderPrecision: numeric(props.BORDERPRECISION),
      areaM2: 0,
      features: 0,
    };
    entry.areaM2 += area(feature as Feature);
    entry.features += 1;
    acc.set(name, entry);
  }
  const rows: PowerRow[] = [];
  for (const [name, entry] of acc) {
    const subordinate = entry.subjecto !== null && entry.subjecto !== name;
    rows.push({
      name,
      abbrevn: entry.abbrevn,
      subjecto: entry.subjecto,
      subordinate,
      nameJa: nameJa[name] ?? null,
      color: colors[colorKeyOf(name, entry.subjecto)] ?? null,
      borderPrecision: entry.borderPrecision,
      areaKm2: toKm2(entry.areaM2),
      features: entry.features,
    });
  }
  rows.sort((a, b) => b.areaKm2 - a.areaKm2 || a.name.localeCompare(b.name));
  return rows;
}

/** `europe_<year>.geojson` の NAME = null の feature を面積降順で返す */
export function aggregateUnnamed(fc: FeatureCollection): UnnamedRow[] {
  const rows: UnnamedRow[] = [];
  for (const feature of fc.features) {
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    if (nullable(props.NAME) !== null) continue;
    rows.push({
      areaKm2: toKm2(area(feature as Feature)),
      bbox: bboxOf(feature.geometry),
    });
  }
  rows.sort((a, b) => b.areaKm2 - a.areaKm2);
  return rows;
}

/** 領邦・諸侯領オーバーレイを面積降順で返す */
export function aggregateFiefs(
  fc: FeatureCollection,
  nameJa: Record<string, string>,
): FiefRow[] {
  const rows: FiefRow[] = fc.features.map((feature) => {
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const name = nullable(props.NAME) ?? "(null)";
    return {
      name,
      nameJa: nameJa[name] ?? null,
      adminLevel: numeric(props.ADMIN_LEVEL),
      ohmRelationId: numeric(props.OHM_RELATION_ID),
      startDate: nullable(props.START_DATE),
      endDate: nullable(props.END_DATE),
      subjecto: nullable(props.SUBJECTO),
      areaKm2: toKm2(area(feature as Feature)),
    };
  });
  rows.sort((a, b) => b.areaKm2 - a.areaKm2 || a.name.localeCompare(b.name));
  return rows;
}

/** TSV の 1 行にする（null は空欄） */
function tsv(cells: readonly (string | number | null)[]): string {
  return cells.map((cell) => cell === null ? "" : String(cell)).join("\t");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await Deno.readTextFile(path)) as T;
}

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  try {
    return await readJson<T>(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

/** 集計結果を標準出力へ TSV で書き出す */
export async function report(year: number): Promise<void> {
  const fc = await readJson<FeatureCollection>(
    `${DATA_DIR}/europe_${year}.geojson`,
  );
  const nameJa = await readJson<Record<string, string>>(
    `${DATA_DIR}/name-ja.json`,
  );
  const colors = await readJson<Record<string, string>>(
    `${DATA_DIR}/colors.json`,
  );

  const powers = aggregatePowers(fc, nameJa, colors);
  const independent = powers.filter((row) => !row.subordinate);
  const subordinate = powers.filter((row) => row.subordinate);
  const unnamed = aggregateUnnamed(fc);
  const unnamedTotal = unnamed.reduce((sum, row) => sum + row.areaKm2, 0);

  const lines: string[] = [];
  lines.push(`# summary year=${year}`);
  lines.push(tsv(["powers_named", powers.length]));
  lines.push(tsv(["powers_independent", independent.length]));
  lines.push(tsv(["powers_subordinate", subordinate.length]));
  lines.push(tsv(["unnamed_features", unnamed.length]));
  lines.push(tsv(["unnamed_area_km2", unnamedTotal]));

  lines.push("");
  lines.push("# powers\tkind\tNAME\tja\tABBREVN\tSUBJECTO\tarea_km2\tfeatures");
  lines.push("#       \t\t\t\t\t\t\tBORDERPRECISION\tcolor");
  for (const row of powers) {
    lines.push(tsv([
      row.subordinate ? "subordinate" : "independent",
      row.name,
      row.nameJa,
      row.abbrevn,
      row.subjecto,
      row.areaKm2,
      row.features,
      row.borderPrecision,
      row.color,
    ]));
  }

  lines.push("");
  lines.push("# unnamed\tarea_km2\twest\tsouth\teast\tnorth");
  for (const row of unnamed) {
    lines.push(tsv([
      row.areaKm2,
      ...row.bbox.map((value) => value.toFixed(2)),
    ]));
  }

  for (const lineage of FIEF_LINEAGES) {
    const path = `${DATA_DIR}/${lineage}_fiefs_${year}.geojson`;
    const fiefFc = await readJsonIfExists<FeatureCollection>(path);
    lines.push("");
    if (fiefFc === null) {
      lines.push(`# fiefs ${lineage}\t(no file: ${path})`);
      continue;
    }
    const rows = aggregateFiefs(fiefFc, nameJa);
    lines.push(`# fiefs ${lineage}\tcount=${rows.length}\tfile=${path}`);
    lines.push(
      "# \tNAME\tja\tADMIN_LEVEL\tOHM_RELATION_ID\tSTART_DATE\tEND_DATE\tSUBJECTO\tarea_km2",
    );
    for (const row of rows) {
      lines.push(tsv([
        row.name,
        row.nameJa,
        row.adminLevel,
        row.ohmRelationId,
        row.startDate,
        row.endDate,
        row.subjecto,
        row.areaKm2,
      ]));
    }
  }

  console.log(lines.join("\n"));
}

if (import.meta.main) {
  const year = Number(Deno.args[0]);
  if (!Number.isInteger(year)) {
    console.error(
      "usage: deno task measure-year-inventory <year>  (例: 1200)",
    );
    Deno.exit(1);
  }
  await report(year);
}
