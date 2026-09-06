export const SOURCE = {
  title: "Mitteleuropa zur Zeit der Staufer, plates 26/27",
  publicationYear: 1886,
  url:
    "https://upload.wikimedia.org/wikipedia/commons/8/85/Professor_G._Droysens_Allgemeiner_historischer_Handatlas_1886_%28134037781%29.jpg",
  license: "Public Domain",
  sha256: "10eb1e6020614cf4abc3f028467e82f947468010adc0008224e04cc21b004f18",
} as const;

export async function verifySourceBytes(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const actual = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (actual !== SOURCE.sha256) {
    throw new Error(`Droysen scan SHA-256 mismatch: ${actual}`);
  }
}

if (import.meta.main) {
  const path = Deno.args[0];
  if (!path) {
    throw new Error(
      "Usage: deno run --allow-read scripts/verify-droysen-staufer-source.ts <pinned-scan.jpg>",
    );
  }
  await verifySourceBytes(await Deno.readFile(path));
  console.log(
    "Pinned scan SHA-256 verified; source dating and boundary admission remain unverified.",
  );
}
