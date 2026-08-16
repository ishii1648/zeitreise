import {
  assert,
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import { WebMercatorViewport } from "@deck.gl/core";
import type { FeatureCollection } from "geojson";
import {
  COLLISION_ID_SLOT_STRIDE,
  collisionIdColor,
  collisionIdFromColor,
  createCollisionIdAccessor,
  LABEL_COLLISION_SLOTS,
  logicalLabelKey,
  MAX_COLLISION_ID,
} from "./collision_id.ts";
import { filterPoliticalLabelsByGroup, type LabelDatum } from "./labels.ts";
import {
  createFeatureLayerBuilders,
  type FeatureLayerContext,
} from "./feature_layers.ts";
import {
  createPoliticalLayerBuilders,
  type PoliticalLayerContext,
} from "./political_layers.ts";
import { type FiefDedupeTable, parseFiefDedupeTable } from "./fief_dedupe.ts";
import {
  EMPTY_SUZERAIN_OVERRIDES,
  parseSuzerainOverrides,
} from "./suzerain_extent.ts";
import type { CollisionIdColor } from "./collision_id.ts";
import { allCityPositions } from "./cities.ts";
import { riverLabelAnchors, type RiverLabelDatum } from "./rivers.ts";
import { SNAPSHOT_YEARS } from "./config.ts";

const EMPTY_FC: FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

function label(
  text: string,
  position: [number, number],
  priority = 0,
): LabelDatum {
  return { text, position, priority };
}

Deno.test("collision ID は順序不変で、7 レイヤースロットを横断して一意", () => {
  const source = [
    label("gamma", [3, 3]),
    label("alpha", [1, 1]),
    label("beta", [2, 2]),
  ];
  const forward = createCollisionIdAccessor(
    LABEL_COLLISION_SLOTS.river,
    source,
  );
  const reverse = createCollisionIdAccessor(
    LABEL_COLLISION_SLOTS.river,
    source.toReversed(),
  );
  for (const datum of source) {
    assertEquals(forward(datum), reverse(datum));
  }

  const ids = Object.values(LABEL_COLLISION_SLOTS).map((slot) =>
    collisionIdFromColor(
      createCollisionIdAccessor(slot, [source[0]])(source[0]),
    )
  );
  assertEquals(new Set(ids).size, ids.length);
});

Deno.test("collision ID は 24-bit 範囲を検証し、capacity 超過と論理キー重複を拒否", () => {
  assertEquals(collisionIdFromColor(collisionIdColor(1)), 1);
  assertEquals(
    collisionIdFromColor(collisionIdColor(MAX_COLLISION_ID)),
    MAX_COLLISION_ID,
  );
  assertThrows(() => collisionIdColor(0), RangeError);
  assertThrows(() => collisionIdColor(MAX_COLLISION_ID + 1), RangeError);

  // length を先に検証する契約なので、巨大配列を実際に確保せず上限を確認できる。
  const oversized = {
    length: COLLISION_ID_SLOT_STRIDE,
  } as unknown as readonly LabelDatum[];
  assertThrows(
    () => createCollisionIdAccessor(LABEL_COLLISION_SLOTS.marine, oversized),
    RangeError,
    "capacity exceeded",
  );
  const duplicate = label("same", [1, 1]);
  assertThrows(
    () =>
      createCollisionIdAccessor(LABEL_COLLISION_SLOTS.city, [
        duplicate,
        { ...duplicate },
      ]),
    Error,
    "duplicate logical label collision key",
  );
});

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await Deno.readTextFile(path));
}

async function readFeatureCollection(path: string): Promise<FeatureCollection> {
  try {
    return await readJson(path) as FeatureCollection;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return EMPTY_FC;
    throw error;
  }
}

function collisionIdOf(
  layer: { props: unknown },
  datum: LabelDatum,
): CollisionIdColor {
  const accessor = (layer.props as {
    getCollisionId: (d: LabelDatum) => CollisionIdColor;
  }).getCollisionId;
  return accessor(datum);
}

function rectsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return Math.abs(a.x - b.x) < (a.width + b.width) / 2 &&
    Math.abs(a.y - b.y) < (a.height + b.height) / 2;
}

/**
 * Issue #437 の固定再現。標準 extension は各 TextLayer の index 17 を同じ RGB
 * [18,0,0] にするため両方を「勝者」と誤認する。専用 ID では top / river の
 * slot が異なり、priority 757 の HRE だけが collision map と一致する。
 */
Deno.test("#437: 1100年 489x433 z4.5 でライン川はHREへ譲り、DPRと配列順に依存しない", async () => {
  const [
    rivers,
    cities,
    base,
    hre,
    france,
    italy,
    cliopatria,
    britain,
    sovereign,
    hreRealm,
    nameJa,
    rawDedupe,
    rawOverrides,
  ] = await Promise.all([
    readFeatureCollection("data/rivers.geojson"),
    readJson("data/cities.json"),
    readFeatureCollection("data/europe_1100.geojson"),
    readFeatureCollection("data/hre_fiefs_flat_1100.geojson"),
    readFeatureCollection("data/france_fiefs_flat_1100.geojson"),
    readFeatureCollection("data/italy_fiefs_flat_1100.geojson"),
    readFeatureCollection("data/cliopatria_fiefs_flat_1100.geojson"),
    readFeatureCollection("data/britain_fiefs_flat_1100.geojson"),
    readFeatureCollection("data/sovereign_fiefs_flat_1100.geojson"),
    readFeatureCollection("data/hre_realm_1100.geojson"),
    readJson("data/name-ja.json"),
    readJson("data/fief-dedupe.json"),
    readJson("data/name-overrides.json"),
  ]);

  const featureContext: FeatureLayerContext = {
    year: 1100,
    riversData: rivers,
    marineData: EMPTY_FC,
    mountainsData: EMPTY_FC,
    peaksData: EMPTY_FC,
    citiesData: cities as FeatureLayerContext["citiesData"],
    nameJa: nameJa as Record<string, string>,
    zoomStep: 4,
    selectedRiverName: null,
    hoveredRiverName: null,
    selectedMountainName: null,
    hoveredMountainName: null,
    selectedPeakName: null,
    hoveredPeakName: null,
  };
  const riverLayer = createFeatureLayerBuilders().buildRiverLabelLayer(
    featureContext,
  );
  const riverData = riverLayer.props.data as RiverLabelDatum[];
  const rhineIndex = riverData.findIndex((d) => d.text === "ライン川");
  const rhine = riverData[rhineIndex];

  const politicalContext: PoliticalLayerContext = {
    year: 1100,
    colors: {},
    nameJa: nameJa as Record<string, string>,
    overrides: parseSuzerainOverrides(rawOverrides),
    fiefDedupe: parseFiefDedupeTable(rawDedupe) as FiefDedupeTable,
    zoomStep: 4,
    extentKey: null,
    selectedPowerKey: null,
    hoveredPowerKey: null,
    fillTransitionMs: 0,
    styleLayerIds: [],
    coastalBands: null,
    detailFocusKey: null,
    base,
    hre,
    fiefs: france,
    italyFiefs: italy,
    cliopatriaFiefs: cliopatria,
    britainFiefs: britain,
    sovereignFiefs: sovereign,
  };
  const politicalBuilders = createPoliticalLayerBuilders();
  const topLayer = politicalBuilders.buildLabelLayer(
    politicalContext,
    base,
    hre,
    france,
    italy,
    cliopatria,
    britain,
    sovereign,
    "top",
    hreRealm,
  );
  const topData = topLayer.props.data as LabelDatum[];
  const hreIndex = topData.findIndex((d) => d.text === "神聖ローマ帝国");
  const empire = topData[hreIndex];

  assertEquals(rhineIndex, 17, "production filter 後のライン川 index");
  assertEquals(hreIndex, 17, "production 宗主集約後のHRE index");
  assertEquals(rhine.priority, 75);
  assertEquals(empire.priority, 757);

  // 修正前の deck.gl picking color はどちらも local index + 1。
  const aliasedPickingColor = collisionIdColor(18);
  assertEquals(aliasedPickingColor, collisionIdColor(rhineIndex + 1));
  assertEquals(aliasedPickingColor, collisionIdColor(hreIndex + 1));

  const rhineId = collisionIdOf(riverLayer, rhine);
  const empireId = collisionIdOf(topLayer, empire);
  assertNotEquals(rhineId, empireId);

  const viewport = new WebMercatorViewport({
    width: 489,
    height: 433,
    longitude: 7.5,
    latitude: 50.5,
    zoom: 4.5,
  });
  const [empireX, empireY] = viewport.project(empire.position);
  const [rhineX, rhineY] = viewport.project(rhine.position);
  for (const dpr of [1, 2]) {
    const empireRect = {
      x: empireX * dpr,
      y: empireY * dpr,
      width: Array.from(empire.text).length * 18 * dpr,
      height: 18 * dpr,
    };
    const rhineRect = {
      x: rhineX * dpr,
      y: rhineY * dpr,
      width: Array.from(rhine.text).length * 12 * dpr,
      height: 12 * dpr,
    };
    assert(rectsOverlap(empireRect, rhineRect), `DPR ${dpr}: 再現矩形`);
    assertEquals(empireId, collisionIdOf(topLayer, empire));
    assertNotEquals(rhineId, empireId);
  }

  // winner の FBO 色と一致するのは HRE だけ。修正前は両方一致していた。
  const candidates = [
    { text: empire.text, oldId: 18, id: collisionIdFromColor(empireId) },
    { text: rhine.text, oldId: 18, id: collisionIdFromColor(rhineId) },
  ];
  assertEquals(
    candidates.filter((candidate) => candidate.oldId === 18).map((d) => d.text),
    ["神聖ローマ帝国", "ライン川"],
    "修正前は alias により低 priority 側まで勝者と一致する",
  );
  const winnerId = collisionIdFromColor(empireId);
  assertEquals(
    candidates.filter((candidate) => candidate.id === winnerId).map((d) =>
      d.text
    ),
    ["神聖ローマ帝国"],
  );

  // registry は reverse 後も同一 ID を返す。
  const reversedRiverIds = createCollisionIdAccessor(
    LABEL_COLLISION_SLOTS.river,
    riverLabelAnchors(
      rivers,
      nameJa as Record<string, string>,
      allCityPositions(cities as FeatureLayerContext["citiesData"]),
    ).toReversed(),
  );
  const reversedTopIds = createCollisionIdAccessor(
    LABEL_COLLISION_SLOTS.politicalTop,
    filterPoliticalLabelsByGroup(
      politicalBuilders.memoizedPowerLabelData(
        1100,
        base,
        hre,
        france,
        italy,
        cliopatria,
        britain,
        sovereign,
        nameJa as Record<string, string>,
        politicalContext.fiefDedupe,
        hreRealm,
      ).data,
      "top",
    ).toReversed(),
  );
  assertEquals(reversedRiverIds(rhine), rhineId);
  assertEquals(reversedTopIds(empire), empireId);
});

Deno.test("空データでも全ラベル builder が専用 collision ID accessor を配線する", () => {
  const ctx: FeatureLayerContext = {
    year: 1100,
    riversData: EMPTY_FC,
    marineData: EMPTY_FC,
    mountainsData: EMPTY_FC,
    peaksData: EMPTY_FC,
    citiesData: { cities: [], years: {} },
    nameJa: {},
    zoomStep: 4,
    selectedRiverName: null,
    hoveredRiverName: null,
    selectedMountainName: null,
    hoveredMountainName: null,
    selectedPeakName: null,
    hoveredPeakName: null,
  };
  const featureBuilders = createFeatureLayerBuilders();
  for (
    const layer of [
      featureBuilders.buildMarineLabelLayer(ctx),
      featureBuilders.buildRiverLabelLayer(ctx),
      featureBuilders.buildCityLabelLayer(ctx),
      featureBuilders.buildMountainLabelLayer(ctx),
      featureBuilders.buildPeakLabelLayer(ctx),
    ]
  ) {
    assertEquals(
      typeof (layer.props as { getCollisionId?: unknown }).getCollisionId,
      "function",
    );
  }

  const politicalBuilders = createPoliticalLayerBuilders();
  const politicalContext: PoliticalLayerContext = {
    year: 1100,
    colors: {},
    nameJa: {},
    overrides: EMPTY_SUZERAIN_OVERRIDES,
    fiefDedupe: { years: {} },
    zoomStep: 4,
    extentKey: null,
    selectedPowerKey: null,
    hoveredPowerKey: null,
    fillTransitionMs: 0,
    styleLayerIds: [],
    coastalBands: null,
  };
  for (
    const layer of politicalBuilders.buildLabelLayers(
      politicalContext,
      EMPTY_FC,
      EMPTY_FC,
      EMPTY_FC,
      EMPTY_FC,
      EMPTY_FC,
      EMPTY_FC,
      EMPTY_FC,
    )
  ) {
    assertEquals(
      typeof (layer.props as { getCollisionId?: unknown }).getCollisionId,
      "function",
    );
  }
});

Deno.test("全19年代 z4〜z8 の全ラベル層で ID は一意かつズームフィルタに対して安定", async () => {
  const [
    rivers,
    marine,
    mountains,
    peaks,
    cities,
    nameJa,
    rawDedupe,
    rawOverrides,
  ] = await Promise.all([
    readFeatureCollection("data/rivers.geojson"),
    readFeatureCollection("data/marine-labels.geojson"),
    readFeatureCollection("data/mountains.geojson"),
    readFeatureCollection("data/peaks.geojson"),
    readJson("data/cities.json"),
    readJson("data/name-ja.json"),
    readJson("data/fief-dedupe.json"),
    readJson("data/name-overrides.json"),
  ]);
  const ja = nameJa as Record<string, string>;
  const dedupe = parseFiefDedupeTable(rawDedupe);
  const overrides = parseSuzerainOverrides(rawOverrides);
  const featureBuilders = createFeatureLayerBuilders();
  const politicalBuilders = createPoliticalLayerBuilders();

  for (const year of SNAPSHOT_YEARS) {
    const [
      base,
      hreFlat,
      hreRaw,
      france,
      italy,
      cliopatria,
      britain,
      sovereign,
      hreRealm,
    ] = await Promise.all([
      readFeatureCollection(`data/europe_${year}.geojson`),
      readFeatureCollection(`data/hre_fiefs_flat_${year}.geojson`),
      readFeatureCollection(`data/hre_${year}.geojson`),
      readFeatureCollection(`data/france_fiefs_flat_${year}.geojson`),
      readFeatureCollection(`data/italy_fiefs_flat_${year}.geojson`),
      readFeatureCollection(`data/cliopatria_fiefs_flat_${year}.geojson`),
      readFeatureCollection(`data/britain_fiefs_flat_${year}.geojson`),
      readFeatureCollection(`data/sovereign_fiefs_flat_${year}.geojson`),
      readFeatureCollection(`data/hre_realm_${year}.geojson`),
    ]);
    const hre = hreFlat.features.length > 0 ? hreFlat : hreRaw;
    const stableIds = new Map<string, number>();

    for (const zoomStep of [4, 5, 6, 7, 8]) {
      const featureContext: FeatureLayerContext = {
        year,
        riversData: rivers,
        marineData: marine,
        mountainsData: mountains,
        peaksData: peaks,
        citiesData: cities as FeatureLayerContext["citiesData"],
        nameJa: ja,
        zoomStep,
        selectedRiverName: null,
        hoveredRiverName: null,
        selectedMountainName: null,
        hoveredMountainName: null,
        selectedPeakName: null,
        hoveredPeakName: null,
      };
      const politicalContext: PoliticalLayerContext = {
        year,
        colors: {},
        nameJa: ja,
        overrides,
        fiefDedupe: dedupe,
        zoomStep,
        extentKey: null,
        selectedPowerKey: null,
        hoveredPowerKey: null,
        fillTransitionMs: 0,
        styleLayerIds: [],
        coastalBands: null,
        detailFocusKey: null,
        base,
        hre,
        fiefs: france,
        italyFiefs: italy,
        cliopatriaFiefs: cliopatria,
        britainFiefs: britain,
        sovereignFiefs: sovereign,
      };
      const layers = [
        featureBuilders.buildMarineLabelLayer(featureContext),
        featureBuilders.buildMountainLabelLayer(featureContext),
        featureBuilders.buildPeakLabelLayer(featureContext),
        ...politicalBuilders.buildLabelLayers(
          politicalContext,
          base,
          hre,
          france,
          italy,
          cliopatria,
          britain,
          sovereign,
          hreRealm,
        ),
        featureBuilders.buildRiverLabelLayer(featureContext),
        featureBuilders.buildCityLabelLayer(featureContext),
      ];
      const viewportIds = new Set<number>();
      for (const layer of layers) {
        const data = layer.props.data as LabelDatum[];
        for (const datum of data) {
          const id = collisionIdFromColor(collisionIdOf(layer, datum));
          assert(
            !viewportIds.has(id),
            `${year} z${zoomStep}: collision ID ${id} が重複`,
          );
          viewportIds.add(id);
          assert(id >= 1 && id <= MAX_COLLISION_ID);

          const logicalKey = `${layer.id}:${logicalLabelKey(datum)}`;
          const previous = stableIds.get(logicalKey);
          if (previous === undefined) stableIds.set(logicalKey, id);
          else {
            assertEquals(
              id,
              previous,
              `${year}: ${logicalKey} の ID が zoom filter で変化`,
            );
          }
        }
      }
    }
  }
});
