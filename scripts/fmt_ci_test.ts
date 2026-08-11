import { assertEquals, assertThrows } from "@std/assert";
import {
  extractPinnedDenoVersion,
  releaseAssetName,
  releaseAssetUrl,
} from "./fmt_ci.ts";

// #262: ローカル deno（homebrew 最新）と CI ピン留め deno とで `deno fmt` の
// 正準形が異なり、md / html / css の変更が CI red を踏む。fmt:ci タスクは
// ci.yml のピン留めバージョンを機械的に抽出して同一バイナリをローカルで
// 実行する。抽出関数を純粋関数として切り出し、ci.yml のバージョン更新時に
// スクリプト側の追従（ハードコード修正）が不要であることをここで固定する。
//
// CI の `deno test` は --allow-read=data,docs のみのため、実 ci.yml を読む
// 検証はローカル実行時（.github の読み取り権限がある場合）に限って行う。

const CI_YAML_SNIPPET = `
      - name: Setup Deno
        if: steps.check_deno_config.outputs.exists == 'true'
        uses: denoland/setup-deno@22d081ff2d3a40755e97629de92e3bcbfa7cf2ed # v2.0.5
        with:
          # fmt の正準形が deno バージョン間で異なるためピン留め
          deno-version: "2.7.14"
`;

Deno.test("extractPinnedDenoVersion: ci.yml 形式（引用符付き）から抽出する", () => {
  assertEquals(extractPinnedDenoVersion(CI_YAML_SNIPPET), "2.7.14");
});

Deno.test("extractPinnedDenoVersion: 引用符なしでも抽出する", () => {
  assertEquals(
    extractPinnedDenoVersion("        with:\n          deno-version: 2.8.1\n"),
    "2.8.1",
  );
});

Deno.test("extractPinnedDenoVersion: 同一バージョンの重複指定は許容する", () => {
  assertEquals(
    extractPinnedDenoVersion(
      'deno-version: "2.7.14"\nfoo: bar\ndeno-version: "2.7.14"\n',
    ),
    "2.7.14",
  );
});

Deno.test("extractPinnedDenoVersion: 指定が無ければ明確なエラー", () => {
  assertThrows(
    () => extractPinnedDenoVersion("steps:\n  - run: deno fmt --check\n"),
    Error,
    "deno-version",
  );
});

Deno.test("extractPinnedDenoVersion: 完全な x.y.z ピン留め以外（範囲指定等）はエラー", () => {
  // setup-deno は "2.x" や "~2.7" も受けるが、その場合バイナリを一意に
  // 決定できず fmt:ci の再現性が壊れるため、明確に失敗させる。
  assertThrows(
    () => extractPinnedDenoVersion('deno-version: "2.x"\n'),
    Error,
    "deno-version",
  );
});

Deno.test("extractPinnedDenoVersion: 異なるバージョンが複数あればエラー", () => {
  assertThrows(
    () =>
      extractPinnedDenoVersion(
        'deno-version: "2.7.14"\ndeno-version: "2.8.0"\n',
      ),
    Error,
    "複数",
  );
});

Deno.test("releaseAssetName: 既知ターゲットは deno-<target>.zip", () => {
  assertEquals(
    releaseAssetName("aarch64-apple-darwin"),
    "deno-aarch64-apple-darwin.zip",
  );
  assertEquals(
    releaseAssetName("x86_64-unknown-linux-gnu"),
    "deno-x86_64-unknown-linux-gnu.zip",
  );
});

Deno.test("releaseAssetName: 未知ターゲットはエラー", () => {
  assertThrows(() => releaseAssetName("wasm32-unknown-unknown"), Error);
});

Deno.test("releaseAssetUrl: GitHub Releases の URL を組み立てる", () => {
  assertEquals(
    releaseAssetUrl("2.7.14", "aarch64-apple-darwin"),
    "https://github.com/denoland/deno/releases/download/v2.7.14/deno-aarch64-apple-darwin.zip",
  );
});

Deno.test({
  name: "extractPinnedDenoVersion: 実 ci.yml から抽出できる（ローカルのみ）",
  ignore:
    Deno.permissions.querySync({ name: "read", path: ".github" }).state !==
      "granted",
  fn: () => {
    const text = Deno.readTextFileSync(".github/workflows/ci.yml");
    const version = extractPinnedDenoVersion(text);
    // 値そのものは ci.yml が正（ハードコードしない）。形式だけ検証する。
    assertEquals(/^\d+\.\d+\.\d+$/.test(version), true);
  },
});
