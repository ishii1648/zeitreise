/** Issue #423: クリック説明パネル撤去の構造テスト。 */
import { assertFalse } from "@std/assert";

const html = Deno.readTextFileSync("index.html");
const css = Deno.readTextFileSync("app.css");
const main = Deno.readTextFileSync("src/main.ts");
const handlers = Deno.readTextFileSync("src/pick_handlers.ts");
const dataLoading = Deno.readTextFileSync("src/data_loading.ts");
const build = Deno.readTextFileSync("scripts/build.ts");

Deno.test("説明パネルの DOM とスタイルが存在しない", () => {
  assertFalse(html.includes("info-panel"));
  assertFalse(css.includes(".info-panel"));
});

Deno.test("クリックハンドラに説明パネル表示の配線が存在しない", () => {
  assertFalse(handlers.includes("showInfoPanel"));
  assertFalse(handlers.includes("panelContent"));
  assertFalse(main.includes("showInfoPanel"));
  assertFalse(main.includes("setupInfoUI"));
});

Deno.test("勢力説明データを起動時に取得・保持しない", () => {
  assertFalse(dataLoading.includes("loadPowerDescriptions"));
  assertFalse(dataLoading.includes("powerDescriptions:"));
  assertFalse(main.includes("powerDescriptions"));
  assertFalse(build.includes('from: "data/power-descriptions.json"'));
});
