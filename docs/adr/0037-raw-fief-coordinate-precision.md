---
status: accepted
date: '2026-08-13'
---

# decision-37: raw 領邦データは上流精度（5 桁）で保持し、丸めは配信される派生側で一度だけ行う

## Context

TASK-130（c023691）は配信データのサイズ削減のため `COORD_PRECISION` を 5 → 3 桁へ
下げた。このとき OHM 由来の raw 領邦データ（`data/<source>_fiefs_<year>.geojson`）は
再生成されておらず、Implementation Notes に判断として記録されている。

> OHM 生データ（`*_fiefs_<year>`）はライブ Overpass 由来の drift 回避のため
> 意図的に再生成せず（非配信・派生側で 3 桁に再丸め）

しかしこの判断は**コード側に反映されなかった**。raw 生成スクリプトは配信側と同じ
`COORD_PRECISION` を参照し続けたため、コミット済み raw（5 桁）と生成側が適用する
精度（3 桁）が食い違ったままになった。実測（2026-08-13）では
`cliopatria` / `france` / `hre` / `italy` の raw 26 ファイルが 5 桁、`britain` /
`sovereign`（TASK-130 より後に新設）と base 系が 3 桁である。

実務上の帰結として、入力が 1 バイトも変わっていなくても
`deno task build-cliopatria-fiefs` を流すと全 7 年・全 feature に差分が出る。#321
（PR #329）は「1 feature の除去以外に差分を出さない」ことを AC で要求していたため、
パイプラインを使わず使い捨てスクリプトで raw を外科的にパッチする回避を強いられた。
`build-cliopatria-fiefs` の入力はコミット SHA（`CLIOPATRIA_SOURCE_COMMIT`）と
アーカイブの SHA-256 でピン留めされており上流 drift が起きないので、**再生成で
一致させられるのに精度だけが理由で成立していない**状態だった。

## Decision

**raw 領邦データは上流から取り込んだ精度（小数 5 桁 ≒ 1 m）で保持し、座標の丸めは
配信される派生側で一度だけ行う。** TASK-130 が言葉で記録した設計をコードの構造に
落とす。

- `scripts/build-data.ts` に `RAW_FIEF_COORD_PRECISION = 5` を置き、raw 領邦を
  出す 6 本（`build-cliopatria-fiefs` / `build-france-fiefs` / `build-hre-fiefs` /
  `build-italy-fiefs` / `build-britain-fiefs` / `build-sovereign-fiefs`）は
  この定数で丸める。`COORD_PRECISION = 3` は**配信物専用**として据え置き、
  `build-fief-flat` / `build-fief-dedupe` / base 系は一切変えない
  （TASK-130 のサイズ削減と表示品質はそのまま維持される）。
- 根拠: raw は `dist` に含まれない中間生成物で、アプリが読むのは必ず 3 桁へ
  丸め直された派生側である。したがって raw の桁数は転送量に効かない。逆に raw を
  3 桁へ落とすと、派生側の union・difference を粗いグリッド上で解くことになり、
  TASK-130 が実際に踏んだ「fief-dedupe の穴と外周の半グリッドずれ」「線状スライバの
  復活」と同種のリスクを raw 側へ持ち込む。得るものが無く失うものがある。
- 検出: `scripts/raw-fief-precision_test.ts` が (a) コミット済み raw 全ファイルの
  小数桁数が `RAW_FIEF_COORD_PRECISION` に収まること、(b) ピン留め入力の
  cliopatria がその桁数をそのまま保持していること（粗すぎる方向も検出）、
  (c) 各 raw 生成スクリプトが raw 用定数を参照していること、(d) raw の精度が配信側
  より細かいことを固定する。
- OHM 由来 raw（`france` / `hre` / `italy` / `britain` / `sovereign`）は Overpass
  API の直叩きで入力をピン留めできないため、**完全一致の再生成テストは置かない**。
  担保するのは精度方針との整合までとし、上記テストが機械的に検出する。
  `britain` / `sovereign` の 3 桁は方針より粗いだけで不変条件（≤ 5 桁）を満たし、
  次に正当な理由で再生成したときに 5 桁へ揃う。

却下案:

- **raw を 3 桁で一度だけ全再生成して以降一致させる** — cliopatria は 7 ファイルの
  全頂点が動き（実測 −15% のサイズ変化）、下流の flat / dedupe まで再生成が波及して
  表示品質の目視確認が要る。OHM 由来 3 本はそもそも再生成すると drift するため
  「一度だけ全再生成」自体が成立せず、外科的な再丸めで代用しても下流に差分が波及
  する。TASK-130 の記録した判断とも逆行する。
- **各ソースが現に持っている桁数をソースごとの定数として固定する** —
  c023691 の取りこぼしという偶然を設計として凍結することになり、方針として
  説明できない。

## Consequences

- `deno task build-cliopatria-fiefs`（`CLIOPATRIA_ARCHIVE` にピン留め済み
  アーカイブを渡せばネットワーク不要）→ `deno task build-attribution` を流すと、
  コミット済みの `data/cliopatria_fiefs_<year>.geojson` とバイト単位で一致する。
  以後、cliopatria のデータ変更は「意図した feature / 年代の差分だけ」を PR に
  載せられ、#321 のような使い捨てスクリプトによる外科的パッチは不要になる。
- 本 ADR の適用でコミット済みデータは 1 バイトも変わらない（raw・flat・dedupe とも
  再生成でゼロ差分を実測）。したがって表示への影響も無い。
- OHM 由来 5 系統は、次に再生成したとき raw の座標が 5 桁になりファイルサイズが
  増える（配信されないため転送量には影響しない）。その差分は drift と同時に出る
  ため、再生成する PR では従来どおり drift の内訳を確認すること。
- `docs/development-style.md` の「生成物の外科的パッチ原則」は引き続き有効だが、
  raw 領邦データについては「精度が理由の全面差分」が解消されたため、外科的パッチの
  典型例からは外れる。
