import { assert, assertEquals } from "@std/assert";
import {
  auditExtentMembership,
  FAIL_OUTSIDE_KM2,
  FAIL_OUTSIDE_RATIO,
  WARN_OUTSIDE_KM2,
} from "./audit-extent-membership.ts";

Deno.test({
  name:
    "外枠所属 audit は全 19 年代・6 系統・823 feature-year を検査して gate を通る",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const report = await auditExtentMembership();
    assertEquals(report.summary.featureYears, 823);
    assertEquals(report.summary.failures, 0);
    assertEquals(report.summary.unresolved, 0);
    assertEquals(report.thresholds, {
      warningOutsideKm2: WARN_OUTSIDE_KM2,
      failureOutsideKm2: FAIL_OUTSIDE_KM2,
      failureOutsideRatio: FAIL_OUTSIDE_RATIO,
    });

    const saxony1000 = report.rows.find((row) =>
      row.year === 1000 && row.layer === "hre" &&
      row.name === "Duchy of Saxony"
    );
    assert(saxony1000 !== undefined);
    assert(saxony1000.outsideAreaKm2 > 6_000);
    assert(saxony1000.outsideRatio > 0.06);
    assertEquals(saxony1000.classification, "source-difference");
    assertEquals(saxony1000.registeredException, true);

    for (const name of ["Republic of Pisa", "Republic of Genoa"] as const) {
      const rows = report.rows.filter((row) => row.name === name);
      assert(rows.length > 0);
      assert(rows.every((row) => row.extentRole === "self"));
    }
    const moscow = report.rows.find((row) =>
      row.year === 1400 && row.name === "Grand Duchy of Moscow"
    );
    assertEquals(moscow?.extentRole, "self");
    assertEquals(moscow?.extentKey, "Grand Duchy of Moscow");
  },
});
