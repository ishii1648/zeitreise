/**
 * data/known-limitations.json（データが表現できない事項の一覧。TASK-46）の
 * スキーマとパーサ。純粋ロジックで、実行時の取得・描画は行わない。
 *
 * #328 でユーザー向け表示（左上の⚠パネル）とクライアントからの取得は撤去した
 * が、**データ本体と静的検証は開発者向け記録として維持する**（AC8）。この
 * モジュールはその検証（scripts/known-limitations-json_test.ts）が使う唯一の
 * 消費者で、クライアント（src/）からは参照されない。
 *
 * データ形式は
 * `{ "limitations": [{ id, years?: { from, to }, text, summary? }] }`。
 * summary は #175 で追加した短い要約（text は詳細）。
 *
 * バリデーション方針: 壊れたデータを安全に受け流すことを最優先し、
 * - トップレベルが不正形（オブジェクトでない・limitations が非配列）なら
 *   空配列を返し console.warn する（known-limitations は「1 件も無ければ
 *   何も表示しない」が自然な扱いのため、null ではなく呼び出し側の分岐を
 *   減らす空配列で統一する）
 * - 個々のエントリは 1 件単位で検証し、不正な要素だけを除外して残りは
 *   表示する（「部分的に壊れていても使える分は使う」方針）
 */

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
  /** 制限事項の詳細説明文 */
  readonly text: string;
  /** 短い要約（2 文程度・全角 120 字以内。#175） */
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
