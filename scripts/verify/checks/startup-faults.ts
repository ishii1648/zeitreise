/**
 * #428 のモバイル fault-injection 検証。
 * optional 保留時の政治描画、manifest 保留の有限エラー、colors 一過性失敗からの
 * 自動復帰を、アプリより先に fetch を差し替えて無人確認する。
 */
import type { CdpApi } from "../cdp.ts";

export const STARTUP_FAULT_SCRIPT = `(() => {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  let colorsFailures = 0;
  globalThis.fetch = (input, init) => {
    const raw = typeof input === "string" ? input : input.url;
    const url = new URL(raw, location.href);
    const fault = new URL(location.href).searchParams.get("__startup_fault");
    if (fault === "cities-pending" && /\\/data\\/cities(?:\\.|\\.json)/.test(url.pathname)) {
      return new Promise(() => {});
    }
    if (fault === "manifest-pending" && url.pathname === "/manifest.json") {
      return new Promise(() => {});
    }
    if (
      fault === "colors-once" &&
      /\\/data\\/colors(?:\\.|\\.json)/.test(url.pathname) &&
      colorsFailures++ === 0
    ) {
      return Promise.resolve(new Response("temporary", { status: 503 }));
    }
    return nativeFetch(input, init);
  };
})();`;

const POLITICS_READY = `(() => {
  const spinner = document.querySelector('.loading-spinner');
  const debug = globalThis.__getPowerLabelDebug?.();
  return spinner?.hidden === true && (debug?.total?.base ?? 0) > 0;
})()`;

const STARTUP_ERROR = `(() => {
  const spinner = document.querySelector('.loading-spinner');
  const toast = document.querySelector('.error-toast');
  return spinner?.hidden === true && toast?.hidden === false &&
    toast?.getAttribute('data-error-kind') === 'startup';
})()`;

export async function run(api: CdpApi): Promise<void> {
  await api.addScriptOnNewDocument(STARTUP_FAULT_SCRIPT);
  const origin = await api.evaluate<string>("location.origin");
  const results: Record<string, unknown> = {};

  const optionalStarted = performance.now();
  await api.navigate(`${origin}/?__startup_fault=cities-pending`);
  await api.waitFor(POLITICS_READY, 15_000);
  results.optionalPending = {
    politicsReady: true,
    elapsedMs: Math.round(performance.now() - optionalStarted),
    cities: await api.evaluate<number>(
      "globalThis.__getCityDebug?.().totalCities ?? -1",
    ),
  };

  const manifestStarted = performance.now();
  await api.navigate(`${origin}/?__startup_fault=manifest-pending`);
  await api.waitFor(STARTUP_ERROR, 25_000);
  results.manifestPending = {
    startupError: true,
    elapsedMs: Math.round(performance.now() - manifestStarted),
  };

  const colorsStarted = performance.now();
  await api.navigate(`${origin}/?__startup_fault=colors-once`);
  await api.waitFor(POLITICS_READY, 15_000);
  results.colorsTransient = {
    recovered: true,
    elapsedMs: Math.round(performance.now() - colorsStarted),
  };

  console.log(JSON.stringify(results, null, 2));
  console.log("\n[RESULT] PASS");
}
