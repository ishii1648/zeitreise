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
  const dir = ".outputs/issue-521";
  const origin = await api.evaluate<string>("location.origin");
  await api.addScriptOnNewDocument(`
    window.__shaderErrors = [];
    const compile = WebGL2RenderingContext.prototype.compileShader;
    WebGL2RenderingContext.prototype.compileShader = function(shader) {
      compile.call(this, shader);
      if (!this.getShaderParameter(shader, this.COMPILE_STATUS)) {
        window.__shaderErrors.push(this.getShaderInfoLog(shader));
      }
    };
  `);
  await Deno.mkdir(dir, { recursive: true });
  const scenes = [
    { year: 1200, zoom: 4, center: "7.5,50.5", width: 1200, height: 800 },
    { year: 1200, zoom: 6, center: "7.5,50.5", width: 1200, height: 800 },
    { year: 1000, zoom: 6.65, center: "7.5,50.5", width: 1200, height: 800 },
    { year: 1000, zoom: 6.85, center: "7.5,50.5", width: 1200, height: 800 },
    { year: 1000, zoom: 7, center: "7.5,50.5", width: 1200, height: 800 },
    { year: 1200, zoom: 7, center: "12.08,55.65", width: 1200, height: 800 },
    { year: 1200, zoom: 8, center: "7.5,50.5", width: 1200, height: 800 },
    { year: 1500, zoom: 6, center: "10,45", width: 1200, height: 800 },
    { year: 1500, zoom: 7, center: "10,45", width: 390, height: 844 },
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
      `${origin}/?year=${scene.year}&zoom=${scene.zoom}&center=${scene.center}`,
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
    assertEquals(await api.evaluate("window.__shaderErrors"), []);
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
    await api.evaluate(
      `document.querySelector('.maplibregl-canvas-container').dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', keyCode: 39}))`,
    );
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
      await api.waitFor(
        `window.__getCityDebug().zoomStep === ${Math.round(scene.zoom) + 1}`,
      );
      await new Promise((r) => setTimeout(r, 500));
      await api.screenshot(`${dir}/zoomed-${name}.png`);
      for (
        let step = Math.round(scene.zoom) + 1;
        step > Math.floor(scene.zoom);
        step--
      ) {
        await api.evaluate(
          `document.querySelector('.maplibregl-canvas').dispatchEvent(new KeyboardEvent('keydown', {key: '-', keyCode: 189, bubbles: true}))`,
        );
        await new Promise((r) => setTimeout(r, 500));
      }
      await api.waitFor(
        `window.__getCityDebug().zoomStep === ${Math.floor(scene.zoom)}`,
      );
      await new Promise((r) => setTimeout(r, 500));
      await api.screenshot(`${dir}/zoomed-out-${name}.png`);
    }
    await api.evaluate(
      `window.__setYear(${scene.year === 1200 ? 1500 : 1200})`,
    );
    await api.waitFor(
      `window.__getYear() === ${scene.year === 1200 ? 1500 : 1200}`,
    );
    await new Promise((r) => setTimeout(r, 500));
    await api.screenshot(`${dir}/year-changed-${name}.png`);
    assertEquals(await api.evaluate("window.__shaderErrors"), []);
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
