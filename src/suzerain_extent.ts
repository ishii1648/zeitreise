/**
 * 宗主-封臣関係を持つ勢力の「勢力圏の外枠」を扱う DOM/deck.gl 非依存な純粋
 * ロジック（TASK-94。TASK-30 の HRE 専用実装 hre_extent.ts を一般化したもの）。
 *
 * - 宗主キーの解決（resolveSuzerainKey / suzerainExtentKey）
 * - 宗主に属する全 feature の抽出と union（extractSuzerainMembers /
 *   buildSuzerainExtent）
 * - 宗主補正の適用（applySuzerainOverrides / withSuzerainOverrides）
 *
 * ## 外枠の定義
 * 「宗主キーごとに、その宗主に属する全 feature（本体 + 従属）の union の外縁」。
 * HRE も同じ規則に載る（NAME=Holy Roman Empire の本体に加え、SUBJECTO=Holy
 * Roman Empire の従属勢力も囲まれる。TASK-30 では本体だけだったが、「一体性を
 * 示す」という表現の目的からは従属勢力を含む方が正しい）。
 *
 * データ源は base（europe_*）に一本化する。領邦オーバーレイ（hre_fiefs_flat_* /
 * france_fiefs_flat_*）は base の内側を細分するだけで勢力圏の外縁を広げないため、
 * オーバーレイの有無に依らず同じ外枠が得られる。
 *
 * ## 諸侯領オーバーレイの宗主キー（TASK-120・TASK-121）
 * 仏諸侯領（france-fiefs）・伊諸侯領（italy-fiefs）と Cliopatria 由来の領邦
 * （cliopatria-fiefs）の一部は上流が SUBJECTO を持たないため、宣言された宗主
 * から外枠を引けない。これらは「その封土が base のどの勢力の内側にあるか」
 * （containingSuzerainKey）で宗主キーを決める。根拠は上のデータ源の一本化と
 * 同じで、諸侯領は base の内側を細分したものだから、包含する base 勢力こそが
 * その封土を含む勢力圏になる。
 *
 * 伊諸侯領は帝国イタリア側の領邦・教皇領側・事実上独立の都市共和国が同じ
 * レイヤーに並ぶが、この規則ならどれに寄せるかを実装者が史実解釈で決めずに
 * 済む（base がその土地をどう塗っているかがそのまま答えになる）。実測では
 * モンフェッラート辺境伯領などが帝国、スポレート公領・アンコーナ共和国・
 * フェラーラ公領が教皇領へ解決する。都市共和国（フィレンツェ・シエナ・
 * ルッカ）は base が帝国色で塗るため帝国の外枠が出る。ピサ・ジェノヴァは
 * コルシカ島を含むポリゴンでラベルが島に立つため base の Corsica へ解決する
 * （docs/data-inventory/README.md §3.8 の既知の制限）。
 *
 * name-overrides.json の `suzerains` に封土名を足す案（decision-19/20 の字義）は
 * 採らない。`suzerains` は SUBJECTO の書き換えとして色キー（colorKeyFor =
 * "NAME|SUBJECTO"）にも効くため、仏封土 33 件を足すと全封土の色キーが
 * "NAME|France" になり、build-colors.ts の属領規則（宗主国色の明度シフト）で
 * 33 件が単一色へ潰れる（実測: colors.json の "|France" キー 39 件がユニーク色
 * 1 件、無関係な 118 キーも決定的プロービングの玉突きで変色）。諸侯ごとに
 * 異なる色を与える TASK-71 / decision-5 の設計と正面から衝突するため、宗主
 * 関係を外枠の解決だけに効かせるこの経路を採る。詳細は docs/app-spec.md §5.2。
 *
 * ## 宗主補正（suzerains）
 * base の SUBJECTO は史実の封建関係を必ずしも反映しない（例: ブルターニュ公は
 * フランス王の封臣だが base では SUBJECTO=Britany の独立勢力）。name-overrides.json
 * の `suzerains`（NAME → 宗主 NAME）でこれを補正する。補正は SUBJECTO の
 * 書き換えとして適用するため、外枠だけでなく色キー（powers.ts colorKeyFor =
 * "NAME|SUBJECTO"）・情報パネルの表示（info.ts displayLabel）も一貫して従属関係を
 * 反映する。歴史的に宗主関係が明白でデータが欠くものに限り最小限に留める。
 */

import union from "@turf/union";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { featureCollection } from "@turf/helpers";
import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  MultiPolygon,
  Polygon,
} from "geojson";
import {
  BRITAIN_FIEF_LAYER_ID,
  CLIOPATRIA_FIEF_LAYER_ID,
  FRANCE_FIEF_LAYER_ID,
  HRE_LAYER_ID,
  ITALY_FIEF_LAYER_ID,
  POWER_LAYER_ID,
  SOVEREIGN_FIEF_LAYER_ID,
} from "./picking.ts";
import { labelAnchorFor } from "./labels.ts";
import { createYearCache, type YearDataLoader } from "./powers.ts";

/**
 * 宗主キーの解決に使う name-overrides.json の内容。
 * - renames: SUBJECTO の表記ゆれ正規化（info.ts displayLabel と同じ規約）
 * - suzerains: base が欠く封建関係の補正（NAME → 宗主 NAME）
 */
export interface SuzerainOverrides {
  renames: Record<string, string>;
  suzerains: Record<string, string>;
}

/** 補正なし（取得失敗時のフォールバック。base の SUBJECTO をそのまま使う） */
export const EMPTY_SUZERAIN_OVERRIDES: SuzerainOverrides = {
  renames: {},
  suzerains: {},
};

/**
 * 宣言された宗主プロパティ（SUBJECTO）から外枠を引くレイヤー。
 * base（powers）と HRE 領邦オーバーレイ（hre-powers）はどちらも全 feature が
 * SUBJECTO を持つため、幾何を見ずに宗主キーへ解決できる。
 */
const EXTENT_SOURCE_LAYER_IDS: readonly string[] = [
  POWER_LAYER_ID,
  HRE_LAYER_ID,
];

/**
 * 包含する base 勢力から外枠を引く諸侯領オーバーレイのレイヤー
 * （TASK-120・伊諸侯領は TASK-121・ブリテン諸島は #172）。
 *
 * ブリテン諸島の政体（britain-fiefs）は SUBJECTO を持たないため、伊諸侯領と
 * 同じく「その政体のラベル地点を base のどの勢力が塗っているか」で宗主キーを
 * 決める。実データでは 1000〜1200 のウェールズ・アイルランド諸王国が base の
 * Celtic kingdoms、1279〜1300 が English territory、1600〜1700 のアイルランド
 * 王国が England and Ireland へ解決する。「base の塗りがそのまま答えになる」
 * 規則（TASK-121）により、独立か従属かの史実解釈を実装者が持ち込まずに済む。
 *
 * #189 の主権政体（sovereign-fiefs）も同じ扱い。SUBJECTO を持たないため
 * base の塗りで宗主キーが決まる。実データでは 1650 年のクリミア・ハン国が
 * base の Ottoman Empire（名目宗主）、1815 年のフィンランド大公国が
 * Russian Empire へ解決し、「オスマン宗主下」「ロシア帝国内」という帰属が
 * 外枠として読める。base に包含されない場合（差し引き済みの土地）は外枠なし。
 */
const FIEF_EXTENT_SOURCE_LAYER_IDS: readonly string[] = [
  FRANCE_FIEF_LAYER_ID,
  CLIOPATRIA_FIEF_LAYER_ID,
  ITALY_FIEF_LAYER_ID,
  BRITAIN_FIEF_LAYER_ID,
  SOVEREIGN_FIEF_LAYER_ID,
];

/** properties から文字列プロパティを取り出す。空文字・非文字列は null */
function stringProp(props: GeoJsonProperties, key: string): string | null {
  const v = props?.[key];
  return typeof v === "string" && v !== "" ? v : null;
}

/** unknown が「文字列だけを値に持つ辞書」ならそれを返す。それ以外は空辞書 */
function stringMap(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** name-overrides.json の JSON を SuzerainOverrides へ解釈する（純粋関数） */
export function parseSuzerainOverrides(data: unknown): SuzerainOverrides {
  if (data === null || typeof data !== "object") {
    return EMPTY_SUZERAIN_OVERRIDES;
  }
  const obj = data as Record<string, unknown>;
  return {
    renames: stringMap(obj.renames),
    suzerains: stringMap(obj.suzerains),
  };
}

/**
 * feature の宗主キーを解決する（純粋関数）。
 * 優先順は 宗主補正テーブル（NAME 起点）> SUBJECTO（renames 正規化）> NAME。
 * 独立勢力は SUBJECTO が自己参照なので自分自身のキーになり、外枠は自分だけを
 * 囲む（無関係な勢力へ波及しない）。NAME を持たない feature は null。
 *
 * 補正は SUBJECTO の書き換えとしても適用される（applySuzerainOverrides）ため、
 * 書き換え前後のどちらの properties を渡しても同じキーになる（冪等）。
 */
export function resolveSuzerainKey(
  props: GeoJsonProperties,
  overrides: SuzerainOverrides,
): string | null {
  const name = stringProp(props, "NAME");
  if (name === null) return null;
  const override = overrides.suzerains[name];
  if (override !== undefined) return overrides.renames[override] ?? override;
  const subjecto = stringProp(props, "SUBJECTO");
  if (subjecto === null) return name;
  return overrides.renames[subjecto] ?? subjecto;
}

/**
 * 諸侯領オーバーレイの feature の宗主キーを、base の包含関係から解決する
 * （純粋関数、TASK-120）。
 *
 * 優先順は 宗主補正テーブル > SUBJECTO > 包含する base 勢力の宗主キー。
 * 前 2 段は resolveSuzerainKey と同じで、上流や補正が宗主を宣言していれば
 * それに従う（Cliopatria 由来の HRE 領邦は SUBJECTO を持つのでここで決まる）。
 * 宣言が無いときだけ幾何に落ちる。
 *
 * 包含の判定にはラベルのアンカー（最大ポリゴンの pole of inaccessibility、
 * labels.ts labelAnchorFor）を使う。境界をまたぐ封土でも「その封土の名前が
 * 描かれている点を含む勢力」という一意で目視可能な規則になり、面積按分の
 * ような閾値を持ち込まずに済む。実データ（1000〜1492 の仏諸侯領・Cliopatria
 * 領邦 全 128 feature）では包含する base 勢力が常にちょうど 1 つに定まる。
 *
 * base 側に一致が無い（海側にはみ出した封土など）場合は null = 外枠なしで、
 * 従来どおりの挙動に落ちる（伊諸侯領のピオンビーノ領主領 1400 / 1492 が該当）。
 *
 * 「宗主候補の版図が封土より小さいなら包含とは言えない」という面積のガードは
 * 採らない。ピサ・ジェノヴァのコルシカを外枠なしに落とせる代わりに、base の
 * ブルターニュ公領・ノルマンディー公領のポリゴンがオーバーレイ側より小さい
 * ために仏封土 7 件（1000〜1300 の Duchy of Brittany / Duchy of Normandy）が
 * 外枠を失い、TASK-120 で直した挙動を壊すため（実測）。
 */
export function containingSuzerainKey(
  fief: Feature,
  base: FeatureCollection,
  overrides: SuzerainOverrides,
): string | null {
  const name = stringProp(fief.properties, "NAME");
  if (name !== null) {
    const override = overrides.suzerains[name];
    if (override !== undefined) return overrides.renames[override] ?? override;
  }
  if (stringProp(fief.properties, "SUBJECTO") !== null) {
    return resolveSuzerainKey(fief.properties, overrides);
  }
  const anchor = labelAnchorFor(fief);
  if (anchor === null) return null;
  for (const f of polygonsOnly(base.features)) {
    if (booleanPointInPolygon(anchor, f.geometry)) {
      return resolveSuzerainKey(f.properties, overrides);
    }
  }
  return null;
}

/**
 * picking 結果から「表示すべき外枠の宗主キー」を解決する（純粋関数）。
 * 対象外レイヤー（都市・河川・山脈・picking なし）は null = 外枠を出さない。
 * レイヤー ID を先に判定するため、GeoJSON Feature でない picking 結果
 * （都市マーカー）でも安全に null を返す。
 *
 * 諸侯領オーバーレイ（TASK-120）だけは properties ではなくジオメトリまで要る
 * ため、picking 結果の feature と base の両方を受け取る。
 */
export function suzerainExtentKey(
  pickedLayerId: string | undefined,
  picked: Feature | undefined,
  base: FeatureCollection,
  overrides: SuzerainOverrides,
): string | null {
  if (pickedLayerId === undefined) return null;
  if (FIEF_EXTENT_SOURCE_LAYER_IDS.includes(pickedLayerId)) {
    if (picked === undefined) return null;
    return containingSuzerainKey(picked, base, overrides);
  }
  if (!EXTENT_SOURCE_LAYER_IDS.includes(pickedLayerId)) return null;
  return resolveSuzerainKey(picked?.properties ?? null, overrides);
}

/**
 * base から宗主キーに属する feature（本体 + 従属）を抽出する（純粋関数）。
 * key が null・該当なしなら空配列。
 */
export function extractSuzerainMembers(
  fc: FeatureCollection,
  key: string | null,
  overrides: SuzerainOverrides,
): Feature[] {
  if (key === null) return [];
  return fc.features.filter((f) =>
    resolveSuzerainKey(f.properties, overrides) === key
  );
}

/** Polygon / MultiPolygon の feature だけに絞る（union の入力条件） */
function polygonsOnly(
  features: Feature[],
): Feature<Polygon | MultiPolygon>[] {
  return features.filter((f): f is Feature<Polygon | MultiPolygon> =>
    f.geometry !== null &&
    (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")
  );
}

/**
 * 宗主キーの外枠（構成 feature の union）を FeatureCollection で返す
 * （純粋関数）。
 *
 * union で融合することで、宗主本体と従属勢力の間に走る内部境界が外縁線として
 * 描かれず、「どこからどこまでが 1 つの勢力圏か」だけが読める。飛び地
 * （アンジュー帝国の英本土と大陸領など）は MultiPolygon として保たれる。
 *
 * union が失敗した場合（base ポリゴンの自己交差など）は構成 feature をそのまま
 * 返す。外枠が内部境界込みになるだけで、範囲の情報は失われない。
 */
export function buildSuzerainExtent(
  fc: FeatureCollection,
  key: string | null,
  overrides: SuzerainOverrides,
): FeatureCollection {
  const members = polygonsOnly(extractSuzerainMembers(fc, key, overrides));
  // 構成 feature が 1 枚（宗主-封臣関係を持たない単独勢力）なら融合する相手が
  // 無く、そのポリゴンの外縁がそのまま外枠になる（turf union は 2 件未満を
  // 受け付けないため、最も多いこのケースを先に返す）
  if (members.length <= 1) {
    return { type: "FeatureCollection", features: members };
  }
  const properties = { NAME: key };
  try {
    const merged = union(featureCollection(members), { properties });
    if (merged !== null) {
      return { type: "FeatureCollection", features: [merged] };
    }
  } catch (error) {
    console.warn(
      `勢力圏の外枠の union に失敗しました。構成ポリゴンをそのまま描画します (${key}): ${
        String(error)
      }`,
    );
  }
  return { type: "FeatureCollection", features: members };
}

/** buildSuzerainExtent をメモ化した関数の型 */
export type SuzerainExtentCache = (
  fc: FeatureCollection,
  key: string | null,
  overrides: SuzerainOverrides,
) => FeatureCollection;

/**
 * buildSuzerainExtent の結果を宗主キー単位でメモ化する（TASK-94）。
 *
 * union は毎フレーム計算してよい重さではない。ビルド時に全宗主の union を
 * 派生データとして持つ案（年代 × 宗主ぶんのファイル）と比較して、実行時
 * オンデマンド + メモ化を採る:
 * - 外枠が要るのはホバー/クリックした 1 宗主だけで、1 年代あたり実際に計算
 *   されるのは高々数キー。base の feature 数は年代あたり 100 未満で、
 *   構成 feature も数枚のため 1 回の union は軽い。
 * - 宗主補正（name-overrides.json）を唯一の真実に保てる。派生データにすると
 *   補正の変更がビルド生成物の再生成とセットになり、data/ に年代 × 宗主の
 *   ファイルが増え、取得経路（ローダ・失敗時フォールバック）も増える。
 *
 * base の参照が変わったら（年代切替）キャッシュを丸ごと捨てる。同じ宗主を
 * 再びホバーしたときは同一インスタンスを返すため、deck.gl の data 差分更新も
 * 無駄打ちしない。
 */
export function createSuzerainExtentCache(): SuzerainExtentCache {
  let lastFc: FeatureCollection | null = null;
  let lastOverrides: SuzerainOverrides | null = null;
  const cache = new Map<string, FeatureCollection>();
  const empty: FeatureCollection = { type: "FeatureCollection", features: [] };

  return (fc, key, overrides) => {
    if (fc !== lastFc || overrides !== lastOverrides) {
      cache.clear();
      lastFc = fc;
      lastOverrides = overrides;
    }
    if (key === null) return empty;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const built = buildSuzerainExtent(fc, key, overrides);
    cache.set(key, built);
    return built;
  };
}

/**
 * 宗主補正を FeatureCollection の SUBJECTO へ適用する（純粋関数）。
 *
 * 外枠の判定は resolveSuzerainKey だけで足りるが、色キー（powers.ts
 * colorKeyFor）と表示ラベル（info.ts displayLabel）は properties の SUBJECTO を
 * 直接読む。補正した勢力の色・ラベルが「独立勢力のまま」では外枠と食い違うため、
 * 取得直後のデータへ一度だけ適用して以降の全経路を揃える
 * （colors.json も scripts/build-colors.ts で同じ補正を適用して生成する）。
 *
 * 補正が 1 件も効かない場合は入力インスタンスをそのまま返す（deck.gl の
 * data 参照同値による差分更新・memoizeLatest を壊さないため）。
 */
export function applySuzerainOverrides(
  fc: FeatureCollection,
  overrides: SuzerainOverrides,
): FeatureCollection {
  let changed = false;
  const features = fc.features.map((f) => {
    const name = stringProp(f.properties, "NAME");
    if (name === null) return f;
    const suzerain = overrides.suzerains[name];
    if (suzerain === undefined) return f;
    const normalized = overrides.renames[suzerain] ?? suzerain;
    if (stringProp(f.properties, "SUBJECTO") === normalized) return f;
    changed = true;
    return { ...f, properties: { ...f.properties, SUBJECTO: normalized } };
  });
  return changed ? { ...fc, features } : fc;
}

/**
 * 年代データローダに宗主補正を挟む（TASK-94）。
 * 変換結果は年ごとに保持し、保持中の年に対しては常に同一インスタンスを返す
 * （ローダ本体のキャッシュと同じ参照安定性を保つ）。
 *
 * TASK-129: この保持もローダ本体と同じ LRU（上限 YEAR_CACHE_MAX_YEARS 年）に
 * 載せる。ここが無制限の Map のままだと、内側ローダのキャッシュを退避しても
 * 補正後の FeatureCollection が全年代分残り続け、上限の意味がなくなるため。
 * 解放された年の再ロードは内側ローダ（再 fetch）へ戻る。
 *
 * #217: 保持するのは load 後に内側ローダが「キャッシュ済み（has = fetch なしで
 * 解決できる）」と申告する年だけ。オーバーレイの取得失敗はキャッシュされず空 FC
 * などへ縮退する契約（powers.ts createOverlayLoader / withBorrowedGeometry）で、
 * その縮退結果をここで保持すると LRU から追い出されるまで再試行が潰れるため、
 * 保持せず次の load を内側へ委譲する。縮退中の年は同一インスタンス保証も
 * かからないが、成功してキャッシュ済みになった時点から従来どおり保持する。
 */
export function withSuzerainOverrides(
  loader: YearDataLoader,
  getOverrides: () => SuzerainOverrides,
): YearDataLoader {
  const cache = createYearCache<FeatureCollection>();
  return {
    has: (year) => loader.has(year),
    async load(year) {
      const cached = cache.get(year);
      if (cached !== undefined) return cached;
      const applied = applySuzerainOverrides(
        await loader.load(year),
        getOverrides(),
      );
      if (loader.has(year)) cache.set(year, applied);
      return applied;
    },
  };
}
