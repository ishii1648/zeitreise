import { assertStringIncludes } from "@std/assert";
import {
  HRE_FIEF_OVERLAY_YEARS,
  HRE_OVERLAY_YEARS,
  ITALY_FIEF_OVERLAY_YEARS,
  SNAPSHOT_YEARS,
} from "../../src/config.ts";

async function readAdr(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(name, import.meta.url));
}

function yearsText(years: readonly number[]): string {
  return years.join(" / ");
}

Deno.test("ADR-0001 の年代写しは SNAPSHOT_YEARS と一致する", async () => {
  const adr = await readAdr("0001-historical-basemaps-pinned-commit.md");
  assertStringIncludes(adr, `19 年代（${yearsText(SNAPSHOT_YEARS)}）`);
  assertStringIncludes(adr, "年集合の正は `SNAPSHOT_YEARS`");
  assertStringIncludes(adr, "TASK-119 で 900 年スナップショットを廃止");
});

Deno.test("ADR-0002 の年代写しは HRE_OVERLAY_YEARS と一致する", async () => {
  const adr = await readAdr("0002-hre-roller-nc-data-file-separation.md");
  assertStringIncludes(adr, `5 年代（${yearsText(HRE_OVERLAY_YEARS)}）`);
  assertStringIncludes(adr, "年集合の正は `HRE_OVERLAY_YEARS`");
  assertStringIncludes(adr, "`data/hre_1700.geojson` も Roller");
});

Deno.test("ADR-0017 の HRE 年代写しはコードと一致する", async () => {
  const adr = await readAdr("0017-medieval-hre-ohm-adoption.md");
  assertStringIncludes(
    adr,
    `10 年代（${yearsText(HRE_FIEF_OVERLAY_YEARS)}）`,
  );
  assertStringIncludes(adr, "年集合の正は `HRE_FIEF_OVERLAY_YEARS`");
  assertStringIncludes(adr, "追補 ADR-0044");
});

Deno.test("ADR-0017 の Italy 年代写しはコードと一致する", async () => {
  const adr = await readAdr("0017-medieval-hre-ohm-adoption.md");
  assertStringIncludes(
    adr,
    `8 年代（${yearsText(ITALY_FIEF_OVERLAY_YEARS)}）`,
  );
  assertStringIncludes(adr, "年集合の正は `ITALY_FIEF_OVERLAY_YEARS`");
  assertStringIncludes(adr, "#188 で追加した 1500 年");
});
