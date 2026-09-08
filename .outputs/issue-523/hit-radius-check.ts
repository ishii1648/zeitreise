import { assert, assertEquals } from "@std/assert";
import type { CdpApi } from "../../scripts/verify/cdp.ts";
export async function run(api: CdpApi) {
  await api.navigate("http://localhost:8523/?year=1200&zoom=6&center=7.5,50.5");
  await api.waitForAppReady();
  await api.waitFor("window.__getYear() === 1200");
  await new Promise((r) => setTimeout(r, 2500));
  const probes = await api.evaluate<any[]>(`window.__getCityScreenPositions()
    .filter(p => p.x > 120 && p.x < innerWidth-20 && p.y > 40 && p.y < innerHeight-100)
    .map(p => ({name:p.name, center:window.__probePick(p.x,p.y), edge:window.__probePick(p.x+8,p.y)}))`);
  const hits = probes.filter(p => p.center.hoverLayer === "cities" && p.edge.hoverLayer === "cities-hit" && p.edge.hoverLabel === p.center.hoverLabel);
  assert(hits.length > 0);
  for (const hit of hits) {
    assertEquals(hit.edge.clickLayer, "cities-hit");
    assertEquals(hit.edge.clickLabel, hit.center.hoverLabel);
  }
  console.log("Visible city hit radius at +8px:", hits.map(p => p.name));
}
