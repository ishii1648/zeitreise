/**
 * known_limitations.ts（src/ui/）のユニットテスト（TASK-146 / #175）。
 *
 * 検証する契約:
 * - setupKnownLimitationsUI がハンドル（reveal / reflectYear）を返し、
 *   要素欠如時は warn（文言固定）を出して no-op ハンドルへ縮退すること
 * - reveal はロード成功（1 件以上）のときだけトグルを表示すること（TASK-46）
 * - reflectYear で表示中の年代に該当する項目だけが要約で描画されること
 *   （#175。TASK-52 の「全件表示 + 強調」からの方針転換）
 * - 各項目の「詳細」で text 全文を展開/格納でき、展開状態が年代切替を
 *   またいで維持されること
 * - 非該当項目へは「他の年代の制限も表示」トグルで到達できること
 * - 折りたたみが wireCollapsiblePanel（TASK-53）へ配線されていること
 */
import { assert, assertEquals, assertFalse } from "@std/assert";
import { setupKnownLimitationsUI } from "./known_limitations.ts";
import type { KnownLimitation } from "../known_limitations.ts";
import { captureWarns, FakeDocument, FakeElement } from "./fake_dom.ts";

const LIMITATIONS: KnownLimitation[] = [
  {
    id: "always",
    text: "全年代で共通の制限。調査由来の詳細な長文。",
    summary: "全年代の要約。",
  },
  // summary 欠落 → text 先頭 1 文で縮退表示されることを見る
  {
    id: "medieval",
    years: { from: 1000, to: 1300 },
    text: "中世のみの制限。中世の詳細。",
  },
  {
    id: "early-modern",
    years: { from: 1530, to: 1700 },
    text: "近世のみの制限。近世の詳細。",
    summary: "近世の要約。",
  },
];

function setup() {
  const doc = new FakeDocument();
  const container = doc.addElement("known-limitations");
  const toggle = doc.addElement("known-limitations-toggle");
  toggle.hidden = true;
  const content = doc.addElement("known-limitations-content");
  const heading = doc.addElement("known-limitations-heading");
  const closeButton = doc.addElement("known-limitations-close");
  const list = doc.addElement("known-limitations-list");
  const handle = setupKnownLimitationsUI({ doc });
  return {
    doc,
    container,
    toggle,
    content,
    heading,
    closeButton,
    list,
    handle,
  };
}

/** li 内から className 一致の子要素を探す */
function childByClass(li: FakeElement, className: string): FakeElement | null {
  for (const child of li.children) {
    if (child instanceof FakeElement && child.className === className) {
      return child;
    }
  }
  return null;
}

/** 一覧から制限項目の li（show-all 行を除く）を取り出す */
function itemLis(list: FakeElement): FakeElement[] {
  return (list.children as FakeElement[]).filter((li) =>
    li.className.includes("known-limitations-item")
  );
}

/** 一覧から「他の年代の制限も表示」行を取り出す（無ければ null） */
function showAllLi(list: FakeElement): FakeElement | null {
  return (list.children as FakeElement[]).find((li) =>
    li.className === "known-limitations-show-all"
  ) ?? null;
}

Deno.test("要素欠如時は warn を出して no-op ハンドルを返す（文言固定）", () => {
  const doc = new FakeDocument();
  const { value: handle, warns } = captureWarns(() =>
    setupKnownLimitationsUI({ doc })
  );
  assertEquals(warns, [
    "既知の制限 UI 要素が見つからないため配線をスキップします",
  ]);
  handle.reveal(LIMITATIONS);
  handle.reflectYear(1000);
});

Deno.test("reveal は空配列ではトグルを表示しない（縮退時は従来表示のまま）", () => {
  const { toggle, handle } = setup();
  handle.reveal([]);
  assert(toggle.hidden);
});

Deno.test("reveal はトグルを表示する（年未確定の間は一覧を描かない）", () => {
  const { toggle, list, handle } = setup();
  handle.reveal(LIMITATIONS);
  assertFalse(toggle.hidden);
  assertEquals(list.children.length, 0);
});

Deno.test("reveal 前の reflectYear では一覧を描かない（防御的措置）", () => {
  const { list, handle } = setup();
  handle.reflectYear(1000);
  assertEquals(list.children.length, 0);
});

Deno.test("reflectYear は該当年の項目だけを要約で描画する（#175 AC #1/#3）", () => {
  const { list, handle } = setup();
  handle.reveal(LIMITATIONS);
  handle.reflectYear(1200);
  const items = itemLis(list);
  assertEquals(items.length, 2);
  assertEquals(
    items.map((li) => li.attributes.get("data-limitation-id")),
    ["always", "medieval"],
  );
  // summary があればそれを、無ければ text 先頭 1 文を表示する（縮退）
  const [always, medieval] = items;
  assertEquals(
    childByClass(always, "known-limitations-summary")?.textContent,
    "全年代の要約。",
  );
  assertEquals(
    childByClass(medieval, "known-limitations-summary")?.textContent,
    "中世のみの制限。",
  );
  // 既定では詳細（text 全文）は描画されない
  assertEquals(childByClass(always, "known-limitations-detail"), null);
  assertEquals(childByClass(medieval, "known-limitations-detail"), null);
});

Deno.test("reflectYear は年代切替に追従して表示項目が増減する（#175 AC #5）", () => {
  const { list, handle } = setup();
  handle.reveal(LIMITATIONS);
  handle.reflectYear(1200);
  assertEquals(
    itemLis(list).map((li) => li.attributes.get("data-limitation-id")),
    ["always", "medieval"],
  );
  handle.reflectYear(1600);
  assertEquals(
    itemLis(list).map((li) => li.attributes.get("data-limitation-id")),
    ["always", "early-modern"],
  );
  handle.reflectYear(1400);
  assertEquals(
    itemLis(list).map((li) => li.attributes.get("data-limitation-id")),
    ["always"],
  );
});

Deno.test("「詳細」ボタンで text 全文を展開/格納できる（#175 AC #4）", () => {
  const { list, handle } = setup();
  handle.reveal(LIMITATIONS);
  handle.reflectYear(1200);
  let always = itemLis(list)[0];
  const toggleBtn = childByClass(always, "known-limitations-detail-toggle");
  assert(toggleBtn !== null, "詳細トグルが無い");
  assertEquals(toggleBtn.textContent, "詳細");
  assertEquals(toggleBtn.attributes.get("aria-expanded"), "false");

  toggleBtn.click();
  always = itemLis(list)[0];
  const detail = childByClass(always, "known-limitations-detail");
  assert(detail !== null, "展開後に詳細が描画されていない");
  assertEquals(
    detail.textContent,
    "全年代で共通の制限。調査由来の詳細な長文。",
  );
  const expandedBtn = childByClass(always, "known-limitations-detail-toggle");
  assertEquals(expandedBtn?.textContent, "詳細を閉じる");
  assertEquals(expandedBtn?.attributes.get("aria-expanded"), "true");

  expandedBtn?.click();
  always = itemLis(list)[0];
  assertEquals(childByClass(always, "known-limitations-detail"), null);
});

Deno.test("展開状態は年代切替をまたいで維持される（項目が表示され続ける限り）", () => {
  const { list, handle } = setup();
  handle.reveal(LIMITATIONS);
  handle.reflectYear(1200);
  childByClass(itemLis(list)[0], "known-limitations-detail-toggle")?.click();
  handle.reflectYear(1600);
  const always = itemLis(list)[0];
  assert(
    childByClass(always, "known-limitations-detail") !== null,
    "年代切替で展開状態が失われた",
  );
});

Deno.test("非該当項目へ「他の年代の制限も表示」で到達できる（#175 到達手段）", () => {
  const { list, handle } = setup();
  handle.reveal(LIMITATIONS);
  handle.reflectYear(1200);
  const row = showAllLi(list);
  assert(row !== null, "show-all 行が無い");
  const btn = childByClass(row, "known-limitations-show-all-btn");
  assert(btn !== null, "show-all ボタンが無い");
  assertEquals(btn.textContent, "他の年代の制限も表示（1件）");

  btn.click();
  const items = itemLis(list);
  assertEquals(
    items.map((li) => li.attributes.get("data-limitation-id")),
    ["always", "medieval", "early-modern"],
  );
  // 非該当項目は淡色クラス + 年代範囲ラベルで区別される
  const earlyModern = items[2];
  assert(
    earlyModern.className.includes("known-limitations-item--inactive"),
    "非該当項目に inactive クラスが無い",
  );
  assertEquals(
    childByClass(earlyModern, "known-limitations-years")?.textContent,
    "〔1530〜1700年〕",
  );
  // 該当項目にはラベルを付けない
  assertEquals(childByClass(items[0], "known-limitations-years"), null);

  // 戻すボタンで該当のみ表示へ復帰する
  const backBtn = childByClass(
    showAllLi(list)!,
    "known-limitations-show-all-btn",
  );
  assertEquals(backBtn?.textContent, "この年代に該当する制限だけ表示");
  backBtn?.click();
  assertEquals(itemLis(list).length, 2);
});

Deno.test("全件が該当する年代では show-all 行を出さない", () => {
  const { list, handle } = setup();
  handle.reveal([LIMITATIONS[0]]);
  handle.reflectYear(1200);
  assertEquals(itemLis(list).length, 1);
  assertEquals(showAllLi(list), null);
});

Deno.test("パネル内ボタンの click は伝播を止める（再描画でパネルが閉じない回帰）", () => {
  // 「詳細」/「他の年代の制限も表示」は click で一覧を再描画（replaceChildren）
  // するため、クリックされたボタンは document へバブルする前に DOM から外れる。
  // wireCollapsiblePanel のコンテナ外クリック判定（container.contains）が
  // detached なターゲットを「外側」と誤判定してパネルごと閉じてしまうので、
  // ボタン側で伝播を止めることを契約にする（実ブラウザで実測した回帰。#175）。
  const { list, handle } = setup();
  handle.reveal(LIMITATIONS);
  handle.reflectYear(1200);
  const detailBtn = childByClass(
    itemLis(list)[0],
    "known-limitations-detail-toggle",
  );
  assert(detailBtn !== null);
  let detailStopped = 0;
  detailBtn.dispatch("click", {
    target: detailBtn,
    stopPropagation: () => {
      detailStopped += 1;
    },
  });
  assertEquals(detailStopped, 1);

  const showAllBtn = childByClass(
    showAllLi(list)!,
    "known-limitations-show-all-btn",
  );
  assert(showAllBtn !== null);
  let showAllStopped = 0;
  showAllBtn.dispatch("click", {
    target: showAllBtn,
    stopPropagation: () => {
      showAllStopped += 1;
    },
  });
  assertEquals(showAllStopped, 1);
});

Deno.test("折りたたみが配線されている（トグル click で展開）", () => {
  const { toggle, content } = setup();
  assertEquals(toggle.attributes.get("aria-expanded"), "false");
  assert(content.hidden);
  toggle.click();
  assertEquals(toggle.attributes.get("aria-expanded"), "true");
  assertFalse(content.hidden);
});

// ---- #284 AC15/AC17: 見出し・閉じるボタン・フォーカス管理 ----

Deno.test("展開直後に見出しへフォーカスが移る（#284 AC17）", () => {
  const { toggle, heading } = setup();
  toggle.click();
  assertEquals(heading.focusCount, 1);
});

Deno.test("閉じるボタン click で折りたたみ、トグルへフォーカスが戻る（#284 AC15/AC17）", () => {
  const { toggle, content, closeButton } = setup();
  toggle.click();
  closeButton.click();
  assert(content.hidden);
  assertEquals(toggle.focusCount, 1);
});

Deno.test("Escape で閉じたときもトグルへフォーカスが戻る（#284 AC17）", () => {
  const { doc, toggle } = setup();
  toggle.click();
  doc.dispatchKeydown("Escape");
  assertEquals(toggle.focusCount, 1);
});
