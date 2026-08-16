import { assert, assertEquals } from "@std/assert";
import {
  BURINGH_MIN_POPULATION,
  MAX_CITIES_PER_YEAR,
  MIN_CITIES_PER_YEAR,
} from "./build-cities.ts";

const ADR_PATH = "docs/adr/0043-buringh-2021-primary-urban-population.md";

function parseImplementationValues(markdown: string): Record<string, number> {
  const values: Record<string, number> = {};
  for (const line of markdown.split("\n")) {
    const match = line.match(/^\| `([A-Z_]+)` \| ([\d,]+) \|/);
    if (match !== null) values[match[1]] = Number(match[2].replaceAll(",", ""));
  }
  return values;
}

Deno.test("#353: ADR-0043 の実装値の写しが build-cities.ts と一致する", async () => {
  const markdown = await Deno.readTextFile(ADR_PATH);
  assert(
    markdown.includes("正はコード側（`scripts/build-cities.ts`）"),
    "ADR-0043 にコード側が正である旨が無い",
  );
  assertEquals(parseImplementationValues(markdown), {
    BURINGH_MIN_POPULATION,
    MIN_CITIES_PER_YEAR,
    MAX_CITIES_PER_YEAR,
  });
});

Deno.test("#353: ADR-0004 と ADR-0043 が相互参照されている", async () => {
  const [oldAdr, newAdr] = await Promise.all([
    Deno.readTextFile("docs/adr/0004-reba-2016-historical-urban-population.md"),
    Deno.readTextFile(ADR_PATH),
  ]);
  assert(oldAdr.includes("ADR-0043"), "ADR-0004 に ADR-0043 への参照が無い");
  assert(newAdr.includes("ADR-0004"), "ADR-0043 に ADR-0004 への参照が無い");
});
