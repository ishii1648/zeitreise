/**
 * 年代別の勢力説明（クリック情報パネルの一文要約）（Issue #283）。
 * DOM 非依存の純粋ロジック。
 *
 * データは `/data/power-descriptions.json` で、
 * `{ "descriptions": [{ name, years: number[], text }] }` の形を持つ。
 * 表示コードへ説明文を直書きせず、**年代 × 補正後の内部名（英語 `NAME`）**で
 * 引ける表として管理する（AC7）。キーを日本語の表示名にしないのは、
 * `data/name-ja.json` の訳語を変えただけで紐付けが壊れるのを避けるため。
 *
 * 解決順は既存のラベル整形（`info.ts` displayLabel）と同じ:
 * 1. feature の `NAME`（上流の綴りゆれは `data/name-overrides.json` の
 *    `renames` で正規化。build-colors.ts の色割当と同じ規則）
 * 2. 正規化後の内部名 × 表示年で本表を引く
 * 3. 日本語表記（`name-ja.json`）は**表示だけ**に使い、照合には使わない
 *
 * バリデーション方針は known_limitations.ts と同じで、「壊れたデータで画面を
 * 壊さない」ことを最優先する:
 * - トップレベルが不正形なら空の表を返し console.warn する
 * - 個々のエントリは 1 件単位で検証し、不正な要素だけを除外する
 * - 同一 name × year の重複は先に現れた方を採用して warn する（後勝ちだと
 *   ファイル末尾へ足した追記が既存の記述を黙って上書きするため）
 *
 * 説明が無い対象は `powerDescriptionFor` が null を返し、呼び出し側
 * （`ui/info_panel.ts`）が説明欄ごと畳んで名称だけのパネルへ戻す（AC8）。
 */

/** power-descriptions.json の URL（build 後の dist でも同じ相対パスで配信される） */
export const POWER_DESCRIPTIONS_DATA_URL = "/data/power-descriptions.json";

/**
 * 内部名 → 年代 → 一文要約の 2 段の表（検証済み）。
 * 年代は `data/index.json` のスナップショット年をそのまま整数で持つ。
 */
export type PowerDescriptionTable = ReadonlyMap<
  string,
  ReadonlyMap<number, string>
>;

/** 取得失敗・未生成時のフォールバック（常に null を引く空の表） */
export const EMPTY_POWER_DESCRIPTIONS: PowerDescriptionTable = new Map();

/** 非空文字列かどうか */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** 検証を通った 1 件分のエントリ */
interface ParsedEntry {
  readonly name: string;
  readonly years: readonly number[];
  readonly text: string;
}

/**
 * 1 件のエントリを検証し、有効なら ParsedEntry を、無効なら null を返す。
 * years は「非空の整数配列」だけを認める（年代が 1 つも無いエントリは
 * どの年でも引けず、静かに無視されるより除外して warn する方が気づける）。
 */
function parseEntry(raw: unknown): ParsedEntry | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const { name, years, text } = raw as {
    name?: unknown;
    years?: unknown;
    text?: unknown;
  };
  if (!isNonEmptyString(name) || !isNonEmptyString(text)) return null;
  if (!Array.isArray(years) || years.length === 0) return null;
  if (
    !years.every((year) => typeof year === "number" && Number.isInteger(year))
  ) {
    return null;
  }
  return { name, years: years as number[], text };
}

/**
 * power-descriptions.json を検証して参照表に変換する。
 * 壊れたデータは warn + 除外で受け流し、例外は投げない。
 */
export function parsePowerDescriptions(raw: unknown): PowerDescriptionTable {
  const descriptions = (typeof raw === "object" && raw !== null &&
      !Array.isArray(raw))
    ? (raw as { descriptions?: unknown }).descriptions
    : undefined;
  if (!Array.isArray(descriptions)) {
    console.warn(
      "power-descriptions.json の形式が不正です（descriptions が配列ではありません）。勢力説明なしで継続します。",
    );
    return EMPTY_POWER_DESCRIPTIONS;
  }
  const table = new Map<string, Map<number, string>>();
  descriptions.forEach((raw, index) => {
    const entry = parseEntry(raw);
    if (entry === null) {
      console.warn(
        `power-descriptions.json の descriptions[${index}] が不正な形式のため除外しました。`,
      );
      return;
    }
    const byYear = table.get(entry.name) ?? new Map<number, string>();
    for (const year of entry.years) {
      if (byYear.has(year)) {
        console.warn(
          `power-descriptions.json に ${entry.name} × ${year} の説明が重複しています。先に現れた方を使います。`,
        );
        continue;
      }
      byYear.set(year, entry.text);
    }
    table.set(entry.name, byYear);
  });
  return table;
}

/**
 * 年代 × 内部名で一文要約を引く純粋関数（AC3/AC8）。
 *
 * `name` は feature の `NAME`（生値でよい）。`renames`
 * （name-overrides.json）を渡すと補正後の内部名へ正規化してから照合する。
 * 未登録の勢力・登録の無い年代・名称が無い対象は null を返す。null は
 * 「説明欄を出さない」を意味し、別年代の説明で埋め合わせることはしない。
 */
export function powerDescriptionFor(
  table: PowerDescriptionTable,
  year: number,
  name: string | null | undefined,
  renames: Record<string, string> = {},
): string | null {
  if (!isNonEmptyString(name)) return null;
  const normalized = renames[name] ?? name;
  return table.get(normalized)?.get(year) ?? null;
}
