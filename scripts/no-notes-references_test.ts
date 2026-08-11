/**
 * 「解説」機能（notes）の削除の完全性を検証する回帰テスト（Issue #284 AC2）。
 *
 * 「解説」トグルと年ごとの解説パネルは #284 で全面廃止された。DOM・CSS・
 * イベント配線・実行時 fetch・生成/検証スクリプト・データ・専用テストの
 * どこにも削除済み機能への参照が残っていないことを、ソース走査で固定する。
 *
 * 禁止トークンはこのファイル自身が誤検出されないよう文字列連結で組み立てる
 * （日本語トークンもこのコメントに現れないよう連結対で保持する）。
 * `notes.txt`（scripts/extract-pmtiles_test.ts の PMTiles 由来アセット名）の
 * ような無関係な "notes" は禁止対象に含めない。
 */
import { assertEquals } from "@std/assert";
import { join } from "@std/path";

/** 削除済みの「解説」機能を指す禁止トークン（連結で自己参照を避ける） */
const FORBIDDEN_TOKENS: readonly string[] = [
  "notes" + ".json",
  "notes" + "-toggle",
  "notes" + "-panel",
  "notes" + "-heading",
  "notes" + "-points",
  "notes" + "-summary",
  ".notes" + " {",
  "setupNotes" + "UI",
  "Notes" + "Data",
  "Notes" + "State",
  "load" + "Notes",
  "notes" + "ForYear",
  "NOTES" + "_DATA_URL",
  "年代" + "解説",
  "歴史" + "解説",
];

/** #284 で削除されたファイル（存在してはならない） */
const DELETED_PATHS: readonly string[] = [
  "src/" + "notes" + ".ts",
  "src/" + "notes" + "_test.ts",
  "src/ui/" + "notes" + ".ts",
  "src/ui/" + "notes" + "_test.ts",
  "scripts/" + "notes" + "-json_test.ts",
  "data/" + "notes" + ".json",
];

/** 走査対象（アプリ実体 + 生成/検証スクリプト + 仕様書） */
const SCAN_ROOTS: readonly string[] = ["src", "scripts"];
const SCAN_FILES: readonly string[] = [
  "index.html",
  "app.css",
  "docs/app-spec.md",
];

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

Deno.test("「解説」機能への参照が src / scripts / index.html / app.css / app-spec に残っていない", async () => {
  const files = [...SCAN_FILES];
  for (const root of SCAN_ROOTS) {
    files.push(...await collectTsFiles(root));
  }
  const offenders: string[] = [];
  for (const file of files.sort()) {
    const text = await Deno.readTextFile(file);
    for (const token of FORBIDDEN_TOKENS) {
      if (text.includes(token)) {
        offenders.push(`${file}: "${token}"`);
      }
    }
  }
  assertEquals(offenders, []);
});

Deno.test("「解説」機能のファイル（実装・テスト・データ）が削除されている", async () => {
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
