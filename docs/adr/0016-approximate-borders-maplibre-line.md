---
status: accepted
date: '2026-07-26 12:48'
---

# decision-16: base 境界は概略境界として MapLibre line レイヤーで不確かさを表現する

## Context

base 境界（aourednik/historical-basemaps）は全 feature が BORDERPRECISION=1（approximate）で、提供者自身が全境界を概略と宣言している。従来の 1px のくっきり線は精密測量の誤ったメッセージを与え、数百 km の直線近似（1200 年の仏↔アンジュー 277 km 等）が特に不自然に見えていた（TASK-80）。粗さは元データ由来であり simplify 起因ではないことは検証済み。

## Decision

base 境界線は deck ではなく MapLibre の line レイヤーで描き、にじみ（line-blur）+ 低 alpha の「概略境界」として表現する。セグメント長の 3 段化（50 km ≈ p90 / 100 km ≈ p95）で長い区間ほど不確かさを強調する。表現定数は src/approximate_borders.ts の TIER_STYLES に一元化し、閾値・段判定は単体テストで固定する。重ね順は「政治ポリゴンの塗り → 概略境界 → 海洋 water → coastline」とし（decision-15 の改訂 2）、海側の線は海洋に覆わせて TASK-84 の趣旨（海上に誤った線を出さない）を維持する。normal 段の下限は alpha 0.62 / blur 0.6px（1815 年密集域の判読性を実測で担保）。

### 改訂 1（#357, 2026-08-13）

概略境界として描くのは**内陸の政治境界だけ**にし、元の base で沿岸と判定できる外周セグメントは線の入力から除く。沿岸補完（#305/#312/#326）が政治塗りを現代海岸線まで延長したため、歴史ポリゴンの沿岸外周を線として描くと、補完前の海岸線が同色領域の内部に「国境線」のように残るようになった（1200 年フローニンゲン周辺 `[5.39,53.139]`〜`[7.969,53.638]` で報告）。海岸の輪郭はベースマップ自身の `coastline` に一本化する（#330 で勢力圏の外枠について下した判断と同じ）。

沿岸判定は沿岸補完と同一のロジック（`src/coastal_segments.ts`。「他 feature と共有されない外環セグメント」から T 字接合と穴を除く）を共有し、二重実装を作らない。判定の基準は派生済みの `base_outline_<year>` ではなく元の `base` とし、`buildApproximateBorderData(source, base)` の第 2 引数で渡す。`base_outline` は諸侯領 union の境界で lineSplit されているため、照合は頂点列の完全一致だけでなく「両端が同じ沿岸セグメントから 0.001° 以内」の近傍一致も見る（座標丸め 3 桁で切断点が最大 7.1e-4 度ずれるため）。段（tier）の判定は除去**前**の座標列全体で行い、内陸区間の直線 run 検出（#309）が沿岸の除去で短く切れないようにする。

## Consequences

- 全年代の base 境界が「概略」という正しいメッセージを持つ。known-limitations にも明記済み。
- 塗りの色境界の直線性は残る。対処は sketchy rendering（決定的な微小変位）を次段階の候補として送った（TASK-80 notes）。
- deck の base-outlines レイヤーは撤去。base 境界の見た目を変える場合は approximate_borders.ts のみ変更すればよい。moveLayer による重ね順操作は @deck.gl/mapbox の styledata 再挿入と競合するため禁止。
- 改訂 1 以降、地図上の概略境界は内陸だけになり、海岸線は `coastline` の 1 本に定まる。沿岸判定を変えると帯（沿岸補完）と線（概略境界）の両方が同時に動くため、`coastal_segments.ts` の閾値変更は両者への影響を見る。
- 関連タスク: TASK-80, TASK-84, #305, #312, #326, #330, #357 / 関連 decision: decision-15
