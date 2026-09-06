# パブリックドメイン歴史アトラスの境界ソース適合性調査（Issue #457）

- 調査日: 2026-08-21
- 契機: Issue #457（既存4出典で埋まらない歴史的境界の新ソース調査）
- 対象: Droysen 1886、Putzger 旧版、Shepherd 1911、および比較対象の OHM /
  Cliopatria
- 結論の反映先: `docs/adr/0047-public-domain-historical-atlas-boundaries.md`

## 1. 目的と調査範囲

ADR-0043 の3段階フォールバックは政体の存在を境界未収録マーカーで示せるが、
面は補えない。本調査では `data/hre-major-polities.json` のマーカー約25件と
`docs/data-inventory/missing-powers-ledger.md` の未解決約121行を母集団とし、
既存4出典（historical-basemaps / OpenHistoricalMap (OHM) / ETH Zürich Roller /
Cliopatria）の追加探索で解決できるか、著作権が消滅した歴史アトラスをトレース元に
できるかを確認した。数値は上記調査日時点のスナップショットであり、生成データや
コードの変更は本 Issue の範囲外とする。

## 2. OHM Overpass の全件確認

### 方法と再現手順

OHM Overpass API に対し、帝国を含む bbox（南緯/西経/北緯/東経 =
`45,5.5,55,19`）内の行政境界 relation を取得した。取得結果から `name` /
`name:en` を正規化し、対象名と別称のパターンに一致した222
relationを、開始・終了日と geometry/outer way
の有無を含めて全件確認した。再実行時は応答を保存し、取得日時と
endpointを併記して、次のクエリと同じ母集団を使う。

```overpass
[out:json][timeout:900];
rel["boundary"="administrative"](45,5.5,55,19);
out tags geom;
```

名前候補には少なくとも
`Trier|Kurtrier|Mainz|Kurmainz|Cologne|Köln|Koeln|Kurköln|Kurkoeln|Palatinate|Pfalz|Württemberg|Wurttemberg|Wirtemberg|Hesse|Hessen|Bavaria|Bayern|Saxony|Sachsen|Austria|Österreich|Oesterreich|Brandenburg`
を含める。名前一致だけを採用判定にせず、各 relation
の有効期間と面の実在を確認する。

### 実測結果

| 対象             | OHMで確認できた期間・結果 |
| ---------------- | ------------------------- |
| Trier / Kurtrier | 0件                       |
| Mainz            | 1573〜1797のみ            |
| Cologne          | 1449〜1797のみ            |
| Palatinate       | 1569年以降の分家のみ      |
| Württemberg      | 1871年以降のみ            |
| Hesse            | 1640年以降のみ            |
| Bavaria          | 1100〜1505が空白          |
| Saxony           | 1180〜1356が空白          |

一方、Duchy of Austria 1254〜1453（relation 2852946 / 2852945）と Brandenburg
admin level 3 の1400〜1515系列には追加可能な面があり、既に既存経路で追加済みで
ある。したがって、上表の欠落を OHM
の名前探索の深掘りだけで埋めることはできない。

## 3. Cliopatria 上流全走査

### 固定入力と再現手順

上流は `Seshat-Global-History-Databank/cliopatria` の commit
`ad28a691b7c07c1fca89d0e0636d324667d2a258`（v0.2.0）へ固定した。
`cliopatria.geojson.zip` は44,231,317 byte、SHA-256
`d01ae3a20d358cc5d54f69d9d725d390767d9c8759ac89ad6f90c58d106f3370`、格納された
`cliopatria_polities_only.geojson` は165,608,072 byte、13,765 featureである。

再現には `deno task build-cliopatria-fiefs` と同じ固定URL、ハッシュ検証、および
`scripts/build-cliopatria-fiefs.ts`
の定数を使う。採用許可リストへ絞る前の全13,765 featureについて
`Name`、`FromYear`、`ToYear`、`SeshatID`、geometryのbboxを列挙し、
対象名・別称を全年代で検索する。候補は `FromYear <= snapshot <= ToYear`
を確認し、
名前一致後にbboxと既知の同地域面との重なりを必ず検査する。アーカイブ更新時は
commitとSHA-256を同時に更新し、同じ走査をやり直す。

### 実測結果と誤配置の罠

- 帝国内部は1000〜1200を一枚岩としており、Mainz / Cologne / Palatinate /
  Württemberg / Hesse はどの年代にも存在しない。
- 唯一の同年面候補は Duchy of Bohemia `[1000..1002]` であり、別 Issue
  の対象とする。
- 上流の `Electorate of Trier` `[1333..1618]` は名前こそ一致するが、bboxは lon
  7.0〜13.0でフランケン地方にある。Roller 1500 の Trier 面（lon 6.2〜8.3） との
  IoU は **0.005** だった。これはトリーアとして採用できず、**名前照合だけで
  採ると完全に誤った位置へ描画する**。今後も候補ごとの位置・重なり検査を省略して
  はならない。

## 4. PDアトラス図版の目視確認

| 図版                                                          | 図版の描写年 | 対応snapshot | 目視結果                                                                                               |
| ------------------------------------------------------------- | -----------: | -----------: | ------------------------------------------------------------------------------------------------------ |
| Droysen 1886 plates 22/23 `Deutschland um das Jahr 1000`      |       約1000 |  1000 / 1100 | 部族大公領のみ。教会領の面はない                                                                       |
| Droysen 1886 plates 26/27 `Mitteleuropa zur Zeit der Staufer` |       未確定 |         1200 | 領邦名・面は視認できるが、従来の「約1195」は裏付け未確認。1200年への採用は保留（下記追調査参照）       |
| Droysen 1886 plates 30/31 `Deutschland im XIV. Jahrhundert`   |         1378 |         1400 | `Kurmainz`、`Kurkoeln`、`Kurtrier`、`Pfalz`、`Wirtemberg`、`Hessen` のマーカー6政体を視認（22年差）    |
| Droysen 1886 plates 34/35 `Deutschland im XV. Jahrhundert`    |     1477想定 |         1492 | 分割期のHesseと伯領のWürttembergを視認（15年差）。採用前に図版描写年を版の凡例・索引で確定する必要あり |
| Droysen 1886 plates 46/47 `Deutschland im XVIII. Jahrhundert` |         1786 |         1783 | 図版自体にフリードリヒ大王没時（1786年）と明記（3年差）                                                |

plates 26/27
の面密度だけでは1200年の帝国空白81.3%を補えるとは判断できない。他方、plates
22/23 に教会領面がないことは単なるデータ欠落ではない。1100年の三大司教領、
1000/1100年のリエージュとトリーアのように領域を面的に確定できない対象は、面を
創作せずマーカーまたは上位勢力に呑まれた表示を維持する。1492年のウェールズも
同じ扱いが妥当である。

Putzger旧版とShepherd 1911は欠落年代・地域を補う比較候補として確認したが、後続の
トレースでは版・plate・描写年を特定して目視確認した図版だけを入力にする。図版名や
年代を推測した一括採用はしない。

## 5. カバレッジ集計

未解決約121行を各snapshotと政体の組で照合した結果、描写年が一致する、または
年代解釈を要しない確実カバーは約88行（73%）だった。図版年との差について政体別の
同一性・領域連続性を検証できる条件付き候補まで含めると約116行（96%）となる。
史料上面を確定できない構造的不可能は5行とした。ただしStaufer図版の1195年という
前提は未確認であり、1200年の採用数や1279年との年差にはこの集計を使えない。この集計は採用可能性の監査であり、条件付き行を
検証なしで面へ昇格させる許可リストではない。

## 6. 権利と結論

Droysen（1908年没）、Andree（1912年没）の旧版、およびShepherd 1911刊の原図は
著作権が消滅している。一方、Wikimedia Commons上のStaufer図版・um-1000図版の
ベクター化SVGは、ベクター化者による **CC BY-SA 4.0** の成果物であり、原図がPD
でもSVGの条件は消えない。

よって新ソースは採用可能だが、既存のGPL / CC BY-NC-SA / CC0 / CC BYという
レイヤー単位のライセンス分離を保つため、PDスキャンから自前でトレースし、成果物を
CC0で提供する経路を標準とする。CommonsのCC BY-SA SVGを入力にする場合は別レイヤー
に分離してBY-SAの帰属・継承条件を適用する。具体的な採用・表示契約はADR-0047に
定める。

## 7. 1200年向け代替史料の追調査（Issue #459、2026-09-06）

年代を推定して採用せず、根拠未確認の領域は保留とする利用者判断に従う。
今回の調査では採用条件を満たした領域は0件。候補が存在しないと断定するものではない。

| 史料                                                                                                                                                                                                       | 確認できた年代・内容                                                                                                                                      | 1200年への判定                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [Droysen 1886 plates 26/27 原スキャン](https://commons.wikimedia.org/wiki/File:Professor_G._Droysens_Allgemeiner_historischer_Handatlas_1886_(134037781).jpg)                                              | Commonsの描写期間は1194–1254。「1195年の一時点」の裏付けはない                                                                                            | 描写年未確定のため保留。期間の中に1200年があるだけでは採用しない                          |
| [Shepherd 1911 pp.70–71](https://maps.lib.utexas.edu/maps/historical/history_shepherd_1911.html) / [PDスキャン](https://commons.wikimedia.org/wiki/File:Europe_and_the_Mediterranean_Lands_about_1190.jpg) | 主図の表題は約1190年。実画像で帝国内の対象8領邦の独立した閉境界は判読できない。ドイツの詳細挿図は別年の約1176年で、色は家門の所領・封土・宗主権を区別する | 主図から8領邦をトレースしない。1176年挿図を1190年扱いせず、24年差だけで連続性を認定しない |
| [Shepherd 1911 p.72（図書館索引）](https://maps.lib.utexas.edu/maps/historical/history_shepherd_1911.html)                                                                                                 | 表題は1138–1254。索引から1200年の単年境界とは確認できない                                                                                                 | 原画像の年代別境界の検証未了につき保留                                                    |
| [Putzger 1905 第29版 plate 17](https://maproom.org/00/01/present.php?m=0035)                                                                                                                               | ブラウザで原図を確認。表題は「Mittel- und Westeuropa zur Zeit der Staufer」で単年の指定ではない                                                           | 領邦ごとの描写年・連続性を確定できず保留。後年版や現代版で代替しない                      |

| 対象領域                 | 採用に不足する根拠                                             | 表示                     |
| ------------------------ | -------------------------------------------------------------- | ------------------------ |
| バイエルン               | 閉境界の描写年と1200年までの連続性。1176年挿図は1180年再編以前 | 境界未収録マーカーを維持 |
| アスカーニエン家ザクセン | 1180年再編後の残部の年代付き境界。1176年の部族大公領は代用不可 | 境界未収録マーカーを維持 |
| オーストリア             | 対象公領の年代付き閉境界と領域連続性                           | 境界未収録マーカーを維持 |
| ブランデンブルク         | 家門所領・宗主権と区別した辺境伯領の年代付き閉境界と連続性     | 境界未収録マーカーを維持 |
| ライン宮中伯             | 年代付き閉境界と領域連続性                                     | 境界未収録マーカーを維持 |
| トリーア                 | 年代付き閉境界と領域連続性                                     | 境界未収録マーカーを維持 |
| ブラバント               | 年代付き閉境界と領域連続性                                     | 未収録のまま保留         |
| リエージュ               | 年代付き閉境界と領域連続性                                     | 未収録のまま保留         |

固定済みDroysen原画像は175,525,998 bytes、SHA-256
`10eb1e6020614cf4abc3f028467e82f947468010adc0008224e04cc21b004f18`。
`deno run --allow-read scripts/verify-droysen-staufer-source.ts <scan.jpg>`
で同一性だけを検証できる。ハッシュ一致は年代や境界の正しさを保証しない。
未検証の座標・較正点・「最大残差3.60km」は撤回し、生成器とその面を取り除いた。
採用面が無いため較正誤差は未測定であり、0kmとして扱わない。
再開には原図の年代根拠、政体別連続性、原寸画像上の境界転写と測定済みグリッド較正が必要。

目視確認したShepherd pp.70–71の取得画像（2026-09-06）は1,075,029 bytes、SHA-256
`d35c64b1ea8f6d94dc9c7cc25eaa6b306ba3e80f2d78e08b065e8be5e3cf7859`。
取得元は[Commonsの原寸JPEG](https://upload.wikimedia.org/wikipedia/commons/f/f4/Europe_and_the_Mediterranean_Lands_about_1190.jpg)。
調査用の確認であり、配布境界の入力には採用していない。

保留状態への復元後、実ブラウザで1200年のz4・z5・z6を確認した。
不正確な8面は表示されず、z6で対象6領邦の境界未収録マーカーを確認できる。
これは保留表示の検証であり、元のAC1（面への昇格）・AC3（実測較正）・AC6
（新規面の隣接境界検証）を満たしたという意味ではない。
