import { assertStringIncludes } from "@std/assert";
import { STARTUP_FAULT_SCRIPT } from "./startup-faults.ts";

Deno.test("startup fault injection は任意データ・manifest・colors の3経路を持つ", () => {
  assertStringIncludes(STARTUP_FAULT_SCRIPT, 'fault === "cities-pending"');
  assertStringIncludes(STARTUP_FAULT_SCRIPT, 'fault === "manifest-pending"');
  assertStringIncludes(STARTUP_FAULT_SCRIPT, 'fault === "colors-once"');
  assertStringIncludes(STARTUP_FAULT_SCRIPT, "colorsFailures++ === 0");
});
