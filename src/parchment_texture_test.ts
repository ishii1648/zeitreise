import { assert, assertEquals, assertMatch } from "@std/assert";

const css = Deno.readTextFileSync("app.css");

function ruleFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s").exec(css);
  assert(match !== null, `${selector} の CSS 規則が必要`);
  return match[1];
}

Deno.test("地図全面の羊皮紙オーバーレイは操作を奪わず、ラベル・コントロールより下に置く", () => {
  const rule = ruleFor("#map::after");
  assertMatch(rule, /pointer-events:\s*none/);
  assertMatch(rule, /z-index:\s*1/);
  assertMatch(rule, /mix-blend-mode:\s*multiply/);
  assertMatch(rule, /url\(["']assets\/parchment-texture\.webp["']\)/);
  assertMatch(rule, /radial-gradient\(/);
  assertMatch(rule, /background-repeat:\s*no-repeat,\s*repeat/);
});

Deno.test("羊皮紙 WebP は512px正方形かつ小容量で、外部取得を必要としない", async () => {
  const bytes = await Deno.readFile("src/assets/parchment-texture.webp");
  assertEquals(new TextDecoder().decode(bytes.slice(0, 4)), "RIFF");
  assertEquals(new TextDecoder().decode(bytes.slice(8, 12)), "WEBP");
  assert(
    bytes.byteLength <= 80 * 1024,
    `WebP が大きすぎる: ${bytes.byteLength}`,
  );

  // cwebp の lossy VP8 bitstream: frame header の 0x9d012a に続く幅・高さ。
  assertEquals(new TextDecoder().decode(bytes.slice(12, 16)), "VP8 ");
  assertEquals([...bytes.slice(23, 26)], [0x9d, 0x01, 0x2a]);
  const width = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
  const height = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
  assertEquals([width, height], [512, 512]);
});
