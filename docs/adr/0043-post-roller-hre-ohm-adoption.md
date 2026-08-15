---
status: accepted
date: '2026-08-16'
---

# decision-43: Roller 終了後の近世 HRE 領邦データに OHM（CC0）を採用する

## Context

decision-17 は中世 HRE 領邦に OHM を採用する一方、1500〜1700 は ETH Zürich Roller を維持すると決めた。Roller 系列は 1700 年で終わるため、1715 年にはバイエルン選帝侯領などが一斉に消え、1783 / 1800 年には存続中の教会諸侯領が Prussia / Bavaria へ誤帰属する問題が残った（#187）。

この問題は既存 OHM 系列の対象リストを機械的に延ばすだけではなく、Roller 終了後をどの出典で補うかという新たなデータソース採否を含む。そのため `docs/development-style.md` 2.1 章に従い、decision-17 の元の Decision を書き換えず本 ADR で追補する。

## Decision

Roller 終了後かつ HRE 解体前のスナップショットである 1715 / 1783 / 1800 の HRE 領邦は OpenHistoricalMap（CC0 1.0）を出典とし、decision-17 と同じ `data/hre_fiefs_<year>.geojson` 系列として独立生成する。中世とは別の近世許可リストを使い、中世 7 年代の生成物を変えない。1500〜1700 は引き続き Roller 由来の `data/hre_<year>.geojson` を使い、1815 年以降は HRE 解体後なので対象外とする。

現在の OHM 由来 HRE 全対象は `src/config.ts` の `HRE_FIEF_OVERLAY_YEARS` が正であり、生成スクリプトでは `HRE_FIEF_MEDIEVAL_YEARS` と `HRE_FIEF_EARLY_MODERN_YEARS` に分ける。具体的な現在値の写しは decision-17 に置き、コードとの一致をテストする。

## Consequences

- 1700 と 1715 の間で Roller から OHM へ出典が切り替わるが、同じ HRE 領邦レイヤーとして表示する。
- 1715 / 1783 / 1800 の領邦消失・誤帰属を、出典付きの OHM ジオメトリで補える。
- decision-17 の「1500〜1700 の Roller を維持する」という決定とは両立し、本 ADR が Roller 終了後だけを追補する。
- 関連 Issue: #187, #354 / 追補元: decision-17
