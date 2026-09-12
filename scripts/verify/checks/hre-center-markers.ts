import { assert, assertStringIncludes } from "@std/assert";
import type { CdpApi } from "../cdp.ts";

export async function run(api: CdpApi): Promise<void> {
  const origin = await api.evaluate<string>("location.origin");
  const output = ".outputs/issue-530";
  await Deno.mkdir(output, { recursive: true });
  for (const mobile of [false, true]) {
    const width = mobile ? 390 : 1440;
    const height = mobile ? 844 : 900;
    const device = mobile ? "mobile" : "desktop";
    await api.setEmulation({
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
      touch: mobile,
    });
    for (const year of [1200, 1783]) {
      for (const zoom of [4, 6]) {
        await api.navigate(`${origin}/?year=${year}&zoom=${zoom}&center=9,50`);
        await api.waitForAppReady();
        await api.waitFor(`window.__getYear() === ${year}`);
        await new Promise((resolve) => setTimeout(resolve, 2500));
        assert(
          await api.evaluate(
            `!document.getElementById('boundary-legend').hidden`,
          ),
        );
        assert(
          await api.evaluate(`(() => {
          const legend = document.getElementById('boundary-legend');
          const a = legend.getBoundingClientRect();
          const b = document.getElementById('timeline').getBoundingClientRect();
          return getComputedStyle(legend).pointerEvents === 'none' &&
            (a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
        })()`),
        );
        await api.screenshot(`${output}/after-${device}-${year}-z${zoom}.png`);
      }
      await api.navigate(`${origin}/?year=${year}&zoom=6&center=8.72,49.42`);
      await api.waitForAppReady();
      await api.waitFor(`window.__getYear() === ${year}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const x = width / 2;
      const y = height / 2 - 17;
      if (!mobile) {
        await api.hover(x, y);
        await api.waitFor(`!document.getElementById('info-tooltip').hidden`);
        const text = await api.evaluate<string>(
          `document.getElementById('info-tooltip').textContent`,
        );
        for (
          const field of [
            "称号:",
            "存続期間:",
            "宗主勢力:",
            "中心都市: Heidelberg",
            "境界未収録:",
            "既知の制限:",
            "出典:",
          ]
        ) {
          assertStringIncludes(text, field);
        }
      }
      if (mobile) await api.tap(x, y);
      else await api.click(x, y);
      await api.waitFor(
        `!document.getElementById('info-tooltip').hidden && document.getElementById('info-tooltip').textContent.includes('中心都市: Heidelberg')`,
      );
      await api.screenshot(`${output}/details-${device}-${year}.png`);
      await api.evaluate("window.__setYear(1000)");
      await api.waitFor(
        `window.__getYear() === 1000 && document.getElementById('boundary-legend').hidden`,
      );
      await api.evaluate(`window.__setYear(${year})`);
      await api.waitFor(
        `window.__getYear() === ${year} && !document.getElementById('boundary-legend').hidden`,
      );

      await api.navigate(`${origin}/?year=${year}&zoom=8&center=6.63,49.75`);
      await api.waitForAppReady();
      await api.waitFor(`window.__getYear() === ${year}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (!mobile) {
        await api.hover(x, height / 2);
        await api.waitFor(
          `!document.getElementById('info-tooltip').hidden && document.getElementById('info-tooltip').textContent.includes('トリーア 人口')`,
        );
      }
      if (mobile) await api.tap(x, height / 2);
      else await api.click(x, height / 2);
      assert(
        await api.evaluate(
          `!document.getElementById('info-tooltip').textContent.includes('境界未収録:') || document.getElementById('info-tooltip').hidden`,
        ),
      );
      console.log(
        `${device} ${year}: flag hover/click, city picking, legend and year transitions passed`,
      );
    }
  }
  await api.navigate(`${origin}/?year=1200&zoom=6&center=-5,40`);
  await api.waitForAppReady();
  await api.waitFor(
    `window.__getYear() === 1200 && document.getElementById('boundary-legend').hidden`,
  );
}
