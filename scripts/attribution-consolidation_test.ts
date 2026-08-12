/**
 * 補助 UI の統合（Issue #328）の完全性を検証する回帰テスト。
 *
 * 案A（統合アトリビューション）では、常設 UI をタイムスライダーと右下の
 * コンパクトなアトリビューション「ⓘ」1 個だけにした。左上の独自ⓘ（出典・
 * 免責）と⚠（既知の制限）は DOM・CSS・配線・状態遷移ごと撤去し、クライアント
 * は `known-limitations.json` を取得も描画もしない（AC2/AC6/AC7）。
 *
 * 一方 **`data/known-limitations.json` とその検証経路は開発者向け記録として
 * 維持する**（AC8）。#284 の「解説」機能（データごと削除）とは扱いが異なる
 * ので、削除の巻き添えにしないことをこのテストで固定する。
 *
 * 禁止トークンはこのファイル自身が誤検出されないよう文字列連結で組み立てる
 * （走査対象はクライアント = src / index.html / app.css だけなので、
 * scripts 配下にある本ファイルは元々走査されない）。
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";

/**
 * クライアント（src / index.html / app.css）に残ってはならないトークン。
 * 撤去した DOM の id・class、配線の関数名、制限一覧 JSON の取得経路、
 * ユーザー向けに出さなくなった文言を対象にする。
 *
 * 「既知の制限」という語そのものは禁止しない: データ側の記録（AC8）を指す
 * コメントは各所に残っており、それは撤去対象ではない。禁止するのは
 * **UI・取得経路の実体を指す識別子**と、表示しないと決めた文言に限る。
 */
const FORBIDDEN_TOKENS: readonly string[] = [
  // 左上の独自ⓘ（attribution フッター。TASK-26 / #284）
  "app-" + "footer",
  "footer-" + "toggle",
  "footer-" + "content",
  "footer-" + "body",
  "setup" + "Footer",
  // ⓘ/⚠ 共通の折りたたみ意匠・配線（TASK-53）
  "corner-toggle-btn",
  "popover-card",
  "popover-body",
  "wire" + "CollapsiblePanel",
  // 制限一覧 UI（TASK-46 / #175）の DOM id・class 群
  "known-" + "limitations-",
  // クライアントからの取得経路（fetch URL とローダ・パーサの参照）
  '"/data/known-' + 'limitations.json"',
  "KNOWN_LIMITATIONS_DATA_URL",
  "load" + "KnownLimitations",
  "parse" + "KnownLimitations",
  "setup" + "KnownLimitationsUI",
  "./known_" + "limitations.ts",
  // 表示しないと決めた文言（境界精度の免責）
  "概略であり" + "厳密ではありません",
];

/** #328 で削除されたクライアント側ファイル（存在してはならない） */
const DELETED_PATHS: readonly string[] = [
  "src/" + "footer.ts",
  "src/" + "footer_test.ts",
  "src/ui/" + "footer.ts",
  "src/ui/" + "footer_test.ts",
  "src/ui/known_" + "limitations.ts",
  "src/ui/known_" + "limitations_test.ts",
  "src/known_" + "limitations.ts",
  "src/known_" + "limitations_test.ts",
  "src/collapsible.ts",
  "src/collapsible_test.ts",
];

/**
 * AC8: 開発者向け記録として維持するパス。データ本体と、その静的検証
 * （パーサ + 内容テスト）が消えていないことを固定する。
 */
const RETAINED_PATHS: readonly string[] = [
  "data/known-limitations.json",
  "scripts/known_limitations.ts",
  "scripts/known-limitations-json_test.ts",
];

/** 走査対象（クライアントの実体のみ） */
const SCAN_ROOTS: readonly string[] = ["src"];
const SCAN_FILES: readonly string[] = ["index.html", "app.css"];

/** dir 配下の .ts ファイルを再帰的に列挙する */
async function collectTsFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      files.push(...await collectTsFiles(path));
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

Deno.test("撤去した補助 UI への参照が src / index.html / app.css に残っていない（AC2/AC6/AC7）", async () => {
  const files = [...SCAN_FILES];
  for (const root of SCAN_ROOTS) {
    files.push(...await collectTsFiles(root));
  }
  const offenders: string[] = [];
  for (const file of files.sort()) {
    const text = await Deno.readTextFile(file);
    for (const token of FORBIDDEN_TOKENS) {
      if (text.includes(token)) offenders.push(`${file}: "${token}"`);
    }
  }
  assertEquals(offenders, []);
});

Deno.test("撤去した補助 UI の実装・テストファイルが削除されている（AC13）", async () => {
  const remaining: string[] = [];
  for (const path of DELETED_PATHS) {
    try {
      await Deno.stat(path);
      remaining.push(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  assertEquals(remaining, []);
});

Deno.test("既知の制限のデータと検証経路は開発者向け記録として維持されている（AC8）", async () => {
  for (const path of RETAINED_PATHS) {
    const stat = await Deno.stat(path);
    assert(stat.isFile, `${path} が通常ファイルではない`);
  }
});

Deno.test("index.html の常設 UI はタイムスライダーだけになっている（AC1/AC2）", async () => {
  const html = await Deno.readTextFile("index.html");
  // 地図・タイムライン・（操作時のみ現れる）情報パネル / トースト /
  // スピナー以外の常設 UI 要素を持たない
  assert(html.includes('id="timeline"'), "タイムラインが無い");
  assertEquals(html.includes("<footer"), false, "独自フッターが残っている");
  assertEquals(html.includes("<aside"), false, "独自 aside が残っている");
});
