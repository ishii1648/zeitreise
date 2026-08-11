/**
 * src/ui/*_test.ts 専用の最小 DOM fake（TASK-146）。
 *
 * collapsible_test.ts の fake と同じ方針で、各 UI 配線モジュールが要求する
 * 最小インターフェース（src/ui/dom.ts）を構造的に満たすオブジェクトを
 * 提供する。実 DOM は使わない（Deno のユニットテストで動かすため）。
 * テスト補助専用であり、本番コードからは import しない。
 */

/**
 * 要素の fake。各 UI モジュールが cast で絞り込む最小メンバー
 * （textContent / hidden / style / 属性 / 子ノード / イベント購読）を
 * 1 クラスに集約する。使わないメンバーがあっても構造的部分型なので無害。
 */
export class FakeElement {
  /** createElement に渡されたタグ名（検証用） */
  readonly tag: string;
  textContent: string | null = "";
  hidden = false;
  className = "";
  // input[type=range] / option / button 用
  value = "";
  min = "";
  max = "";
  step = "";
  label = "";
  disabled = false;
  // a 要素用
  href = "";
  target = "";
  rel = "";
  style: { left: string; top: string } = { left: "", top: "" };
  /** getBoundingClientRect が返す実測サイズの fake */
  rect = { width: 0, height: 0 };
  /** replaceChildren / appendChild / append で入った子ノード */
  children: unknown[] = [];
  /** setAttribute で入った属性（aria-expanded 等） */
  attributes = new Map<string, string>();
  /** classList.toggle の結果（クラス名集合） */
  classes = new Set<string>();
  /** contains(target) が true を返す target 集合 */
  containsTargets = new Set<unknown>();
  #listeners = new Map<string, Array<(event: unknown) => void>>();

  readonly classList = {
    toggle: (name: string, force?: boolean): boolean => {
      const on = force ?? !this.classes.has(name);
      if (on) this.classes.add(name);
      else this.classes.delete(name);
      return on;
    },
  };

  constructor(tag = "div") {
    this.tag = tag;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  /** focus() の呼び出し回数（フォーカス管理の検証用。#284 AC17） */
  focusCount = 0;

  focus(): void {
    this.focusCount++;
  }

  getBoundingClientRect(): { width: number; height: number } {
    return this.rect;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener);
    this.#listeners.set(type, list);
  }

  /** 登録済みリスナーへイベントを配送する */
  dispatch(type: string, event: unknown = { target: this }): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  /** click イベントを模倣する */
  click(): void {
    this.dispatch("click", { target: this });
  }

  replaceChildren(...nodes: unknown[]): void {
    this.children = nodes;
  }

  appendChild(node: unknown): void {
    this.children.push(node);
  }

  append(...items: unknown[]): void {
    this.children.push(...items);
  }

  contains(target: unknown): boolean {
    return this.containsTargets.has(target);
  }
}

/** dispatchKeydown が返すイベント記録（preventDefault の呼び出し有無を持つ） */
export interface FakeKeydownEvent {
  key: string;
  target: unknown;
  prevented: boolean;
  preventDefault(): void;
}

/**
 * document の fake。id → FakeElement の登録表と createElement の記録、
 * document 宛の click / keydown 購読・配送を提供する。
 */
export class FakeDocument {
  readonly elements = new Map<string, FakeElement>();
  /** createElement で生成した要素（生成順） */
  readonly created: FakeElement[] = [];
  #listeners = new Map<string, Array<(event: unknown) => void>>();

  /** id 付き要素を登録して返す */
  addElement(id: string): FakeElement {
    const el = new FakeElement();
    this.elements.set(id, el);
    return el;
  }

  getElementById(id: string): unknown {
    return this.elements.get(id) ?? null;
  }

  createElement(tag: string): unknown {
    const el = new FakeElement(tag);
    this.created.push(el);
    return el;
  }

  addEventListener(
    type: "click",
    listener: (event: { target: unknown }) => void,
  ): void;
  addEventListener(
    type: "keydown",
    listener: (event: {
      key: string;
      target: unknown;
      preventDefault(): void;
    }) => void,
  ): void;
  addEventListener(
    type: "click" | "keydown",
    listener:
      | ((event: { target: unknown }) => void)
      | ((event: {
        key: string;
        target: unknown;
        preventDefault(): void;
      }) => void),
  ): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener as (event: unknown) => void);
    this.#listeners.set(type, list);
  }

  /** document への click を模倣する */
  dispatchClick(target: unknown): void {
    for (const listener of this.#listeners.get("click") ?? []) {
      listener({ target });
    }
  }

  /** document への keydown を模倣する。preventDefault の呼び出し有無を返す */
  dispatchKeydown(key: string, target: unknown = null): FakeKeydownEvent {
    const event: FakeKeydownEvent = {
      key,
      target,
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };
    for (const listener of this.#listeners.get("keydown") ?? []) {
      listener(event);
    }
    return event;
  }
}

/** console.warn をフックして呼び出し文言を収集しつつ fn を実行する */
export function captureWarns<T>(fn: () => T): { value: T; warns: string[] } {
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
  try {
    const value = fn();
    return { value, warns };
  } finally {
    console.warn = original;
  }
}
