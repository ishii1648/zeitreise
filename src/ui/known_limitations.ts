/**
 * データの既知の制限一覧 UI の配線（TASK-46/52。TASK-146 で main.ts から抽出。
 * #175 で年代連動の出し分け + 要約/詳細の分離へ再設計）。
 *
 * 折りたたみは attribution フッターと同一の操作性（トグル click /
 * コンテナ外 click / Escape）なので、reducer（footer.ts）ごと共通配線
 * wireCollapsiblePanel（collapsible.ts、TASK-53）を再利用する。
 * ここでは一覧の描画とハンドル（reveal / reflectYear）の提供だけを行う。
 *
 * decision-29 の方針どおり module-scope の可変状態は持たない。従来の
 * 「revealKnownLimitations / reflectYearToKnownLimitations フックへ実体を
 * 差し込む」パターンをハンドル返却へ置き換えた（limitations / currentYear /
 * expandedIds / showAll は setup クロージャ内の状態）。DOM 要素欠如時は
 * warn を出して no-op ハンドルへ縮退する（契約維持）。
 *
 * #175（TASK-52 からの方針転換）: 1 項目 400〜1000 字の調査由来長文を全件
 * 常時表示すると実質読めないため、表示中の年代に該当する項目だけを短い要約
 * （summary。欠落時は text 冒頭で縮退）で並べる。text 全文は項目ごとの
 * 「詳細」で展開でき、情報は削らない。非該当項目へは一覧末尾の
 * 「他の年代の制限も表示」トグルで到達できる（淡色 + 年代範囲ラベルで区別）。
 */
import {
  formatKnownLimitationYears,
  type KnownLimitation,
  knownLimitationSummary,
  visibleKnownLimitationEntries,
} from "../known_limitations.ts";
import {
  type CollapsibleContent,
  type CollapsibleEventSource,
  type CollapsibleHeading,
  type CollapsibleToggle,
  wireCollapsiblePanel,
} from "../collapsible.ts";
import type { UiDocument } from "./dom.ts";

/** コンテナ root の最小形（HTMLElement が満たす。root 内判定に使う） */
interface ContainerElement {
  contains(target: Node | null): boolean;
}

/** トグルボタンの最小形（HTMLButtonElement が満たす。表示切替も行う） */
interface ToggleElement {
  hidden: boolean;
  setAttribute(name: string, value: string): void;
  addEventListener(type: "click", listener: () => void): void;
  /** 折りたたみ時のフォーカス戻し先（#284 AC17） */
  focus(): void;
}

/** 一覧 ul の最小形 */
interface ListElement {
  replaceChildren(...nodes: unknown[]): void;
}

/** 一覧項目 li / 要約 p / ラベル span の最小形（createElement の返り値を絞り込む） */
interface ListItemElement {
  className: string;
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  append(...items: unknown[]): void;
}

/**
 * 項目内ボタン（詳細トグル / show-all）の最小形（HTMLButtonElement が満たす）。
 * click listener はイベントを受け取り伝播を止める: click で一覧を再描画
 * （replaceChildren）するため、ボタンは document へバブルする前に DOM から
 * 外れ、wireCollapsiblePanel のコンテナ外クリック判定（container.contains）が
 * detached なターゲットを「外側」と誤判定してパネルごと閉じてしまう（実測）。
 * stopPropagation は fake DOM のイベントに無い場合があるため任意呼び出しにする。
 */
interface ItemButtonElement {
  className: string;
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  addEventListener(
    type: "click",
    listener: (event: { stopPropagation?: () => void }) => void,
  ): void;
}

/**
 * setupKnownLimitationsUI が返すハンドル。
 * - reveal: loadKnownLimitations 成功時にトグルボタンを表示し一覧を描画する
 *   （未生成時はトグルごと非表示で従来表示を維持する方針）
 * - reflectYear: 年代切替の確定（applyFn。最新要求のみ到達）に追従して
 *   表示中の年代に該当する項目の絞り込みを更新する（reflectYearToTimeline と
 *   同じタイミング保証。TASK-52 / #175）
 */
export interface KnownLimitationsUiHandle {
  reveal(limitations: KnownLimitation[]): void;
  reflectYear(year: number): void;
}

/** setupKnownLimitationsUI へ main.ts から注入する依存 */
export interface KnownLimitationsUiDeps {
  doc: UiDocument & CollapsibleEventSource;
}

/** 要素欠如時の縮退用 no-op ハンドル */
const NOOP_KNOWN_LIMITATIONS_UI: KnownLimitationsUiHandle = {
  reveal: () => {},
  reflectYear: () => {},
};

/** データの既知の制限一覧 UI を配線し、表示ハンドルを返す */
export function setupKnownLimitationsUI(
  deps: KnownLimitationsUiDeps,
): KnownLimitationsUiHandle {
  const { doc } = deps;
  const container = doc.getElementById(
    "known-limitations",
  ) as ContainerElement | null;
  const toggle = doc.getElementById(
    "known-limitations-toggle",
  ) as ToggleElement | null;
  const content = doc.getElementById(
    "known-limitations-content",
  ) as CollapsibleContent | null;
  const heading = doc.getElementById(
    "known-limitations-heading",
  ) as CollapsibleHeading | null;
  const closeButton = doc.getElementById(
    "known-limitations-close",
  ) as CollapsibleToggle | null;
  const list = doc.getElementById(
    "known-limitations-list",
  ) as ListElement | null;
  if (!container || !toggle || !content || !heading || !closeButton || !list) {
    console.warn(
      "既知の制限 UI 要素が見つからないため配線をスキップします",
    );
    return NOOP_KNOWN_LIMITATIONS_UI;
  }

  let limitations: KnownLimitation[] = [];
  let currentYear: number | null = null;
  /** 「詳細」を展開中の項目 id。再描画（年代切替）をまたいで維持する */
  const expandedIds = new Set<string>();
  /** 非該当項目も表示するか（一覧末尾のトグルで切り替える。#175） */
  let showAll = false;

  /** 1 項目の li を組み立てる */
  function renderItem(
    entry: KnownLimitation & { active: boolean },
  ): ListItemElement {
    const li = doc.createElement("li") as ListItemElement;
    li.className = entry.active
      ? "known-limitations-item"
      : "known-limitations-item known-limitations-item--inactive";
    li.setAttribute("data-limitation-id", entry.id);

    // 非該当項目（show-all 時のみ現れる）には年代範囲ラベルを付け、
    // いま見ている年代の制限ではないことを示す
    if (!entry.active) {
      const years = doc.createElement("span") as ListItemElement;
      years.className = "known-limitations-years";
      years.textContent = `〔${formatKnownLimitationYears(entry.years)}〕`;
      li.append(years, " ");
    }

    const summary = doc.createElement("p") as ListItemElement;
    summary.className = "known-limitations-summary";
    summary.textContent = knownLimitationSummary(entry);

    const expanded = expandedIds.has(entry.id);
    const detailToggle = doc.createElement("button") as ItemButtonElement;
    detailToggle.className = "known-limitations-detail-toggle";
    detailToggle.setAttribute("type", "button");
    detailToggle.setAttribute("aria-expanded", String(expanded));
    detailToggle.textContent = expanded ? "詳細を閉じる" : "詳細";
    detailToggle.addEventListener("click", (event) => {
      // 再描画で detached になるボタンのクリックを「コンテナ外」と誤判定
      // させない（ItemButtonElement のコメント参照）
      event.stopPropagation?.();
      if (expandedIds.has(entry.id)) expandedIds.delete(entry.id);
      else expandedIds.add(entry.id);
      renderList();
    });

    li.append(summary, " ", detailToggle);

    // 展開時のみ text 全文（調査由来の詳細。情報は削らない）を描画する
    if (expanded) {
      const detail = doc.createElement("p") as ListItemElement;
      detail.className = "known-limitations-detail";
      detail.textContent = entry.text;
      li.append(detail);
    }
    return li;
  }

  /**
   * 現在の limitations / currentYear / showAll を元に一覧を再描画する。
   * currentYear が未確定（switchYear 未完了）の間はそもそも呼ばれない想定
   * だが、防御的に limitations が空・currentYear が null のときは何もしない。
   */
  function renderList(): void {
    if (limitations.length === 0 || currentYear === null) return;
    const entries = visibleKnownLimitationEntries(
      limitations,
      currentYear,
      showAll,
    );
    const items: unknown[] = entries.map(renderItem);

    // 非該当項目への到達手段（#175）。隠れている項目が無ければ出さない
    const hiddenCount = limitations.length -
      visibleKnownLimitationEntries(limitations, currentYear, false).length;
    if (hiddenCount > 0 || showAll) {
      const row = doc.createElement("li") as ListItemElement;
      row.className = "known-limitations-show-all";
      const button = doc.createElement("button") as ItemButtonElement;
      button.className = "known-limitations-show-all-btn";
      button.setAttribute("type", "button");
      button.textContent = showAll
        ? "この年代に該当する制限だけ表示"
        : `他の年代の制限も表示（${hiddenCount}件）`;
      button.addEventListener("click", (event) => {
        event.stopPropagation?.();
        showAll = !showAll;
        renderList();
      });
      row.append(button);
      items.push(row);
    }

    list!.replaceChildren(...items);
  }

  // 折りたたみの配線（トグル / コンテナ外 click / Escape / 閉じるボタン /
  // 属性同期 / フォーカス管理。#284 AC15/AC17）は attribution と同じ共通配線に
  // 委譲する（TASK-53）。Node の存在確認は footer.ts（src/ui/）と同じく
  // Deno のユニットテスト実行時の防御で、ブラウザでは常に成立し従来と
  // 同一挙動になる。
  wireCollapsiblePanel({
    toggle,
    content,
    heading,
    closeButton,
    returnFocus: () => toggle.focus(),
    containsTarget: (target) =>
      typeof Node !== "undefined" && target instanceof Node &&
      container.contains(target),
    eventSource: doc,
  });

  return {
    // known-limitations.json のロード成功時のみトグルを表示し、一覧を描画する
    // （AC #3: 制限事項の追加はデータ編集のみで可能）
    reveal: (loaded) => {
      if (loaded.length === 0) return;
      limitations = loaded;
      renderList();
      toggle.hidden = false;
    },
    // 年代切替の確定（applyFn。最新要求のみ到達）に追従して該当項目の
    // 絞り込みを更新する。パネルの開閉状態に関わらず内容を最新化しておく
    // ことで、次回展開時は常に現在年代の一覧を表示する。
    reflectYear: (year) => {
      currentYear = year;
      renderList();
    },
  };
}
