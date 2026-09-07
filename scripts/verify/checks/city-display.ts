import { assert, assertEquals } from "@std/assert";
import type { CdpApi } from "../cdp.ts";

type Probe = {
  name: string;
  x: number;
  y: number;
  hoverLayer: string | null;
  hoverLabel: string | null;
  clickLayer: string | null;
};

export async function run(api: CdpApi): Promise<void> {
  const dir = ".outputs/issue-518";
  await Deno.mkdir(dir, { recursive: true });
  const scenes = [
    { year: 1200, zoom: 4, center: "7.5,50.5", width: 1200, height: 800 },
    { year: 1200, zoom: 6, center: "7.5,50.5", width: 1200, height: 800 },
    { year: 1200, zoom: 8, center: "7.5,50.5", width: 1200, height: 800 },
    { year: 1500, zoom: 6, center: "10,45", width: 1200, height: 800 },
    { year: 1500, zoom: 6, center: "10,45", width: 390, height: 844 },
  ];
  const results = [];
  for (const scene of scenes) {
    await api.setEmulation({
      ...scene,
      deviceScaleFactor: 1,
      mobile: false,
      touch: false,
    });
    await api.navigate(
      `http://localhost:8000/?year=${scene.year}&zoom=${scene.zoom}&center=${scene.center}`,
    );
    await api.waitForAppReady();
    await api.waitFor(`window.__getYear() === ${scene.year}`);
    await new Promise((r) => setTimeout(r, 2500));
    const probes = await api.evaluate<Probe[]>(
      `window.__getCityScreenPositions()
      .filter(p => p.x > 120 && p.x < innerWidth - 20 && p.y > 40 && p.y < innerHeight - 100)
      .map(p => ({...p, ...window.__probePick(p.x, p.y)}))`,
    );
    const visible = probes.filter((p) => p.hoverLayer === "cities");
    assert(visible.length > 0, `都市が選択できない: ${JSON.stringify(scene)}`);
    for (const p of visible) assertEquals(p.clickLayer, "cities");
    if (scene.year === 1200 && scene.zoom === 6) {
      assert(
        probes.some((p) =>
          p.hoverLayer !== "cities" && p.hoverLayer !== "cities-hit"
        ),
      );
    }
    const name = `${scene.year}-z${scene.zoom}-${scene.width}`;
    await api.screenshot(`${dir}/after-${name}.png`);
    const target = visible.sort((a, b) =>
      Math.hypot(a.x - scene.width / 2, a.y - scene.height / 2) -
      Math.hypot(b.x - scene.width / 2, b.y - scene.height / 2)
    )[0];
    await api.hover(target.x, target.y);
    assertEquals(
      await api.evaluate('document.getElementById("info-tooltip").textContent'),
      target.hoverLabel,
    );
    await api.click(target.x, target.y);
    await api.hover(scene.width - 5, 5);
    await new Promise((r) =>
      setTimeout(r, 300)
    );
    await api.screenshot(`${dir}/selected-${name}.png`);
    await api.click(target.x, target.y);
    await api.hover(scene.width - 5, 5);
    await new Promise((r) => setTimeout(r, 300));
    await api.screenshot(`${dir}/cleared-${name}.png`);
    await api.evaluate('document.querySelector(".maplibregl-canvas").focus()');
    await api.keys("ArrowRight");
    await new Promise((r) => setTimeout(r, 500));
    const panned = await api.evaluate<{ name: string; x: number }[]>(
      "window.__getCityScreenPositions()",
    );
    assert(
      Math.abs(panned.find((p) => p.name === target.name)!.x - target.x) > 10,
    );
    if (scene.zoom < 8) {
      await api.evaluate(
        `document.querySelector('.maplibregl-canvas').dispatchEvent(new KeyboardEvent('keydown', {key: '=', keyCode: 187, bubbles: true}))`,
      );
      await api.waitFor(`window.__getCityDebug().zoomStep > ${scene.zoom}`);
      await api.screenshot(`${dir}/zoomed-${name}.png`);
    }
    await api.evaluate(
      `window.__setYear(${scene.year === 1200 ? 1500 : 1200})`,
    );
    await api.waitFor(
      `window.__getYear() === ${scene.year === 1200 ? 1500 : 1200}`,
    );
    await new Promise((r) => setTimeout(r, 500));
    await api.screenshot(`${dir}/year-changed-${name}.png`);
    results.push({
      scene,
      visible: visible.length,
      candidates: probes.length,
      probes,
    });
  }
  await Deno.writeTextFile(
    `${dir}/browser-results.json`,
    JSON.stringify(results, null, 2),
  );
  console.log(
    results.map(({ scene, visible, candidates }) => ({
      scene,
      visible,
      candidates,
    })),
  );
}
