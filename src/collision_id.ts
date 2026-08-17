import type { LabelDatum } from "./labels.ts";

/** WebGL picking color が表現できる collision ID の上限。0 は無効色なので使わない。 */
export const MAX_COLLISION_ID = 0xff_ffff;

/**
 * 8 種のラベル層に 21-bit ずつ予約する。スロットが異なれば下位 ID が同じでも
 * RGB は一致せず、同一 collisionGroup のレイヤー間 alias は構造的に起きない。
 */
export const COLLISION_ID_SLOT_STRIDE = 0x20_0000;

export const LABEL_COLLISION_SLOTS = {
  politicalTop: 0,
  politicalLower: 1,
  river: 2,
  city: 3,
  mountain: 4,
  peak: 5,
  marine: 6,
  hreBoundaryUnavailable: 7,
} as const;

export type LabelCollisionSlot =
  typeof LABEL_COLLISION_SLOTS[keyof typeof LABEL_COLLISION_SLOTS];

export type CollisionIdColor = readonly [number, number, number];

/** 24-bit 整数 ID を collision FBO に書き込む RGB picking color へ変換する。 */
export function collisionIdColor(id: number): CollisionIdColor {
  if (!Number.isSafeInteger(id) || id < 1 || id > MAX_COLLISION_ID) {
    throw new RangeError(`collision ID out of 24-bit range: ${id}`);
  }
  return [id & 0xff, (id >> 8) & 0xff, (id >> 16) & 0xff];
}

/** テスト・診断用の逆変換。 */
export function collisionIdFromColor(color: CollisionIdColor): number {
  return color[0] | (color[1] << 8) | (color[2] << 16);
}

/**
 * 表示順や翻訳表に依存しない論理ラベルキー。
 *
 * 政治ラベルの飛び地は同じ key/text でも別アンカーを持つため position を含める。
 * 河川・山岳・山峰・海域は元の英語名を name に持つので、表示テキストが変わっても
 * 同一性を維持できる。都市は LabelDatum のみなので text + position で識別する。
 */
export function logicalLabelKey(datum: LabelDatum): string {
  const extended = datum as LabelDatum & { name?: unknown };
  return JSON.stringify([
    typeof extended.name === "string" ? extended.name : null,
    datum.key ?? null,
    datum.kind ?? null,
    datum.tier ?? null,
    datum.text,
    datum.position[0],
    datum.position[1],
  ]);
}

export type CollisionIdAccessor<DataT> = (datum: DataT) => CollisionIdColor;

/**
 * 1 レイヤースロット分の collision ID registry を作る。
 *
 * キーをソートしてから連番を付けるため、入力配列を reverse / reorder しても同じ
 * 論理ラベルは同じ ID になる。予約件数を超えた場合や論理キーが重複した場合は
 * 初期化時に明示的に失敗し、24-bit wrap / alias を黙って発生させない。
 */
export function createCollisionIdAccessor<DataT extends LabelDatum>(
  slot: LabelCollisionSlot,
  source: readonly DataT[],
  keyOf: (datum: DataT) => string = logicalLabelKey,
): CollisionIdAccessor<DataT> {
  if (!Number.isSafeInteger(slot) || slot < 0) {
    throw new RangeError(`invalid collision ID slot: ${slot}`);
  }
  const slotStart = slot * COLLISION_ID_SLOT_STRIDE;
  const slotEnd = slotStart + COLLISION_ID_SLOT_STRIDE - 1;
  if (slotEnd > MAX_COLLISION_ID) {
    throw new RangeError(`collision ID slot exceeds 24-bit range: ${slot}`);
  }
  if (source.length >= COLLISION_ID_SLOT_STRIDE) {
    throw new RangeError(
      `collision ID slot ${slot} capacity exceeded: ${source.length}`,
    );
  }

  const keys = source.map(keyOf).sort();
  for (let i = 1; i < keys.length; i++) {
    if (keys[i] === keys[i - 1]) {
      throw new Error(`duplicate logical label collision key: ${keys[i]}`);
    }
  }

  const colors = new Map<string, CollisionIdColor>();
  for (let i = 0; i < keys.length; i++) {
    colors.set(keys[i], collisionIdColor(slotStart + i + 1));
  }

  return (datum: DataT): CollisionIdColor => {
    const key = keyOf(datum);
    const color = colors.get(key);
    if (color === undefined) {
      throw new Error(`unregistered logical label collision key: ${key}`);
    }
    return color;
  };
}
