import { assertRejects } from "@std/assert";
import { verifySourceBytes } from "./verify-droysen-staufer-source.ts";

Deno.test("Droysen source verification rejects empty and substituted scans", async () => {
  for (
    const bytes of [new Uint8Array(), new TextEncoder().encode("not the scan")]
  ) {
    await assertRejects(
      () => verifySourceBytes(bytes),
      Error,
      "Droysen scan SHA-256 mismatch",
    );
  }
});
