/**
 * データの既知の制限（表示できない情報）一覧（TASK-46）。DOM 非依存の純粋ロジック。
 *
 * データは /data/known-limitations.json（コードと分離して管理し、今後の制限事項
 * 追加はデータ編集のみで可能にする。AC #3）で、
 * `{ "limitations": [{ id, years?: { from, to }, text, summary? }] }` の形を持つ。
 * summary は #175 で追加した「既定表示用の短い要約」（text は展開時の詳細）。
 * fetch 由来で信頼できないため、ここでは「壊れたデータを安全に受け流す」
 * パース/バリデーションと、任意機能として「年代該当判定」だけを提供する
 * （footer.ts と同じ構成方針）。
 *
 * バリデーション方針: 壊れたデータで画面を壊さないことを最優先し、
 * - トップレベルが不正形（オブジェクトでない・limitations が非配列）なら
 *   空配列を返し console.warn する（known-limitations は「1 件も無ければ
 *   何も表示しない」が自然な扱いのため、null ではなく呼び出し側の分岐を
 *   減らす空配列で統一する）
 * - 個々のエントリは 1 件単位で検証し、不正な要素だけを除外して残りは
 *   表示する（「部分的に壊れていても使える分は使う」方針）
 */

/** known-limitations.json の URL（build 後の dist でも同じ相対パスで配信される） */
export const KNOWN_LIMITATIONS_DATA_URL = "/data/known-limitations.json";

/** 制限事項が該当する年代範囲（両端含む） */
export interface KnownLimitationYears {
  readonly from: number;
  readonly to: number;
}

/** 1 件の既知の制限事項（検証済み） */
export interface KnownLimitation {
  /** 一覧内で一意な識別子（今のところ表示には使わないが将来のキー用に保持） */
  readonly id: string;
  /** 該当する年代範囲。省略時は常時該当（例: 全年代で共通の制限） */
  readonly years?: KnownLimitationYears;
  /** 制限事項の詳細説明文（#175 以降は項目の「詳細」展開時に表示） */
  readonly text: string;
  /**
   * 既定表示用の短い要約（2 文程度・全角 120 字以内。#175）。省略時は
   * knownLimitationSummary が text 冒頭から代替を導出する（縮退）。
   */
  readonly summary?: string;
}

/** 非空文字列かどうか */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * years フィールドの妥当性を検証する。有効なら KnownLimitationYears を、
 * 無効なら undefined を返す。呼び出し側は undefined を「検証失敗」として
 * エントリごと除外する（years 自体は任意項目だが、指定されていて壊れている
 * 場合は不正なエントリとして扱う）。
 */
function parseYears(value: unknown): KnownLimitationYears | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { from, to } = value as { from?: unknown; to?: unknown };
  if (typeof from !== "number" || typeof to !== "number") return undefined;
  if (from > to) return undefined;
  return { from, to };
}

/**
 * 1 件のエントリを検証し、有効なら KnownLimitation を、無効なら null を返す。
 */
function parseLimitation(raw: unknown): KnownLimitation | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const { id, text, years, summary } = raw as {
    id?: unknown;
    text?: unknown;
    years?: unknown;
    summary?: unknown;
  };
  if (!isNonEmptyString(id) || !isNonEmptyString(text)) return null;

  // summary は任意項目だが、指定されていて壊れている（非文字列・空文字）
  // 場合は years と同じ規律で不正なエントリとして除外する（#175）
  if (summary !== undefined && !isNonEmptyString(summary)) return null;

  const base = summary === undefined ? { id, text } : { id, text, summary };
  if (years === undefined) return base;

  const parsedYears = parseYears(years);
  if (parsedYears === undefined) return null;
  return { ...base, years: parsedYears };
}

/**
 * fetch した JSON を KnownLimitation[] として受け入れる（AC #3）。
 * トップレベルが不正形のときは空配列 + console.warn。個々のエントリが
 * 不正なときはそのエントリだけ除外し console.warn（一覧全体は破棄しない）。
 */
export function parseKnownLimitations(json: unknown): KnownLimitation[] {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    console.warn(
      "known-limitations.json の形式が不正です（オブジェクトではありません）。制限事項なしで継続します。",
    );
    return [];
  }
  const { limitations } = json as { limitations?: unknown };
  if (!Array.isArray(limitations)) {
    console.warn(
      "known-limitations.json の limitations が配列ではありません。制限事項なしで継続します。",
    );
    return [];
  }

  const result: KnownLimitation[] = [];
  limitations.forEach((raw, index) => {
    const parsed = parseLimitation(raw);
    if (parsed === null) {
      console.warn(
        `known-limitations.json の limitations[${index}] が不正な形式のため除外しました。`,
      );
      return;
    }
    result.push(parsed);
  });
  return result;
}

/**
 * 指定した年に制限事項が該当するか判定する。years 省略時は常時該当。
 * from/to は両端含む（inclusive）。
 */
export function isKnownLimitationActiveForYear(
  limitation: KnownLimitation,
  year: number,
): boolean {
  if (limitation.years === undefined) return true;
  return year >= limitation.years.from && year <= limitation.years.to;
}

/** UI 描画用に年代該当フラグを付与した制限事項（TASK-52） */
export interface KnownLimitationEntry extends KnownLimitation {
  /** isKnownLimitationActiveForYear(this, year) の結果。この年代に該当するか */
  readonly active: boolean;
}

/**
 * 全件を保持したまま各項目に isKnownLimitationActiveForYear の判定結果を
 * 付与する（TASK-52）。UI 側はこれを使って「全件表示 + 該当年代を視覚強調」
 * できる（絞り込み・除外はしない。既存の全件表示という挙動は変えない方針）。
 * 順序は入力の limitations と同一のまま維持する。
 */
export function knownLimitationEntries(
  limitations: readonly KnownLimitation[],
  year: number,
): KnownLimitationEntry[] {
  return limitations.map((limitation) => ({
    ...limitation,
    active: isKnownLimitationActiveForYear(limitation, year),
  }));
}

/**
 * 一覧に既定表示する項目を返す（#175）。TASK-52 の「全件表示 + 該当強調」
 * では 1 項目 400〜1000 字の長文が全年代分並んで実質読めなかったため、
 * 表示中の年代に該当する項目だけへ絞り込む方針へ転換した。非該当項目には
 * showAll=true（UI の「他の年代の制限も表示」トグル）で到達できる。
 * 順序は入力の limitations と同一のまま維持する。
 */
export function visibleKnownLimitationEntries(
  limitations: readonly KnownLimitation[],
  year: number,
  showAll: boolean,
): KnownLimitationEntry[] {
  const entries = knownLimitationEntries(limitations, year);
  return showAll ? entries : entries.filter((entry) => entry.active);
}

/** 要約の上限文字数（AC #3: 2 文程度・全角 120 字以内。#175） */
export const KNOWN_LIMITATION_SUMMARY_MAX_CHARS = 120;

/**
 * 項目の既定表示に使う要約を返す（#175）。summary があればそのまま、
 * 欠落時は text の先頭 1 文（句点まで）で代替する縮退を行う。代替文が
 * 上限を超える場合は上限 - 1 文字 + 「…」に切り詰める（サロゲートペアを
 * 壊さないようコードポイント単位で数える）。
 */
export function knownLimitationSummary(limitation: KnownLimitation): string {
  if (limitation.summary !== undefined) return limitation.summary;
  const periodIndex = limitation.text.indexOf("。");
  const sentence = periodIndex >= 0
    ? limitation.text.slice(0, periodIndex + 1)
    : limitation.text;
  const chars = [...sentence];
  if (chars.length <= KNOWN_LIMITATION_SUMMARY_MAX_CHARS) return sentence;
  return chars.slice(0, KNOWN_LIMITATION_SUMMARY_MAX_CHARS - 1).join("") + "…";
}

/**
 * 年代範囲の表示ラベルを組み立てる（#175。「他の年代の制限も表示」時に
 * 非該当項目がいつの制限かを示す）。years 省略時は常時該当なので「全年代」。
 */
export function formatKnownLimitationYears(
  years: KnownLimitationYears | undefined,
): string {
  if (years === undefined) return "全年代";
  if (years.from === years.to) return `${years.from}年`;
  return `${years.from}〜${years.to}年`;
}
