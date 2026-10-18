// Test plugin (e2e): gives the member whose page asks a guest pet of hq-pets by metadata only. hq-pets
// stores the metadata and, on every page, asks this plugin's browser code to draw the sheet.
export async function onMessage(_p: HQ.Player, m: unknown): Promise<void> {
  const shade = typeof m === "object" && m !== null ? (m as { shade?: unknown }).shade : undefined;
  if (typeof shade !== "number" || !Number.isInteger(shade) || shade < 0 || shade > 3) return;
  await hq.plugins.call("hq-pets", "setPet", { id: "drawn", metadata: { shade }, name: "Drawn" });
}
