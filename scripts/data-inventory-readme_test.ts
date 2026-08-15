import { assertEquals, assertMatch } from "@std/assert";
const README = await Deno.readTextFile("docs/data-inventory/README.md");
const series = [
  ["europe", 19],
  ["hre_fiefs", 10],
  ["italy_fiefs", 8],
  ["base_outline", 19],
  ["europe_flat", 19],
  ["hre_fiefs_flat", 10],
  ["italy_fiefs_flat", 8],
] as const;
Deno.test("#356: データソース一覧の件数は data/ の現物と一致する", async () => {
  for (const [name, documented] of series) {
    let actual = 0;
    for await (const entry of Deno.readDir("data")) {
      if (
        entry.isFile &&
        new RegExp(`^${name}_[0-9]+\\.geojson$`).test(entry.name)
      ) actual++;
    }
    assertEquals(actual, documented, name);
    assertMatch(
      README,
      new RegExp(`data/${name}_<year>\\.geojson[^\\n]*× ${actual}`),
    );
  }
});
Deno.test("#321 / #356: 1300年表は現物の非複合体9件と一致する", async () => {
  const data = JSON.parse(
    await Deno.readTextFile("data/cliopatria_fiefs_1300.geojson"),
  );
  const names = data.features.filter((
    f: { properties?: Record<string, unknown> },
  ) => f.properties?.CLIOPATRIA_COMPOSITE === undefined).map((
    f: { properties: { NAME: string } },
  ) => f.properties.NAME);
  assertEquals(names.length, 9);
  const row = README.split("\n").find((line) =>
    /^\| 1300 \|\s+9 \|/.test(line)
  );
  assertEquals(row !== undefined, true);
  const ja = JSON.parse(await Deno.readTextFile("data/name-ja.json"));
  for (const name of names) assertEquals(row!.includes(ja[name]), true, name);
  assertEquals(row!.includes("ブロワ伯領"), false);
});
