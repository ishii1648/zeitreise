import type { CdpApi } from "../cdp.ts";
import { waitForYearReflected } from "./smoke.ts";

const YEARS = [1400, 1492, 1500, 1530, 1600, 1650, 1700, 1715, 1783, 1800];

export async function run(api: CdpApi): Promise<void> {
  await api.waitForAppReady();
  const origin = await api.evaluate<string>("location.origin");
  const results: Array<Record<string, unknown>> = [];
  for (const zoom of [4, 5, 6]) {
    await api.navigate(`${origin}/?year=1400&zoom=${zoom}&center=27,47`);
    await api.waitForAppReady();
    for (const year of YEARS) {
      await api.evaluate(`window.__setYear(${year})`);
      await waitForYearReflected(api, year);
      const debug = await api.evaluate<Record<string, unknown>>(
        "window.__getCliopatriaFiefDebug()",
      );
      const labels = [
        ...((debug.hreLabels as string[]) ?? []),
        ...((debug.fiefLabels as string[]) ?? []),
      ];
      if (
        debug.overlay !== true || Number(debug.featureCount) < 1 ||
        !labels.includes("モルダヴィア公国")
      ) {
        throw new Error(
          `${year}/z${zoom}: Moldavia missing: ${JSON.stringify(debug)}`,
        );
      }
      results.push({ year, zoom, featureCount: debug.featureCount });
    }
  }
  await api.evaluate("window.__setYear(1815)");
  await waitForYearReflected(api, 1815);
  const cli1815 = await api.evaluate<Record<string, unknown>>(
    "window.__getCliopatriaFiefDebug()",
  );
  const sovereign1815 = await api.evaluate<Record<string, unknown>>(
    "window.__getSovereignFiefDebug()",
  );
  if (
    cli1815.overlay !== false || Number(cli1815.featureCount) !== 0 ||
    !((sovereign1815.labels as string[]) ?? []).includes("モルダヴィア公国")
  ) {
    throw new Error(
      `1815 source priority failed: ${
        JSON.stringify({ cli1815, sovereign1815 })
      }`,
    );
  }
  const toastVisible = await api.evaluate<boolean>(`(() => {
    const el = document.querySelector('.error-toast');
    return !!el && getComputedStyle(el).display !== 'none' && el.offsetParent !== null;
  })()`);
  if (toastVisible) throw new Error("error toast visible");
  await api.screenshot("scripts/verify/checks/.moldavia-screenshot.png");
  console.log(
    JSON.stringify({ checks: results.length, cli1815, sovereign1815 }, null, 2),
  );
  console.log("[RESULT] PASS");
}
