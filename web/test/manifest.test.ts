// The web app manifest that makes the client installable (Chrome/Edge "Install"): the page links it, it names Home
// Quarters as a standalone app from /, and each icon it lists is a PNG of the size it claims, one of them maskable. How
// the server serves it (media type, revalidated, a missing icon a 404) is TestTheManifestIsServedAsAManifestAndRevalidated
// (server/internal/httpapi/static_test.go). The browser keeps Chrome's own verdict, with no service worker in the way of
// deploys: e2e/scenarios/update.ts.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const pub = new URL("../public/", import.meta.url);
type Manifest = { name?: string; display?: string; start_url?: string; scope?: string; icons?: { src: string; sizes: string; type?: string; purpose?: string }[] };
const manifest = JSON.parse(readFileSync(new URL("manifest.webmanifest", pub), "utf8")) as Manifest;

/** A PNG's width and height, from its IHDR chunk (bytes 16-23), or null when the file is not a PNG. */
function pngSize(file: Buffer): string | null {
  if (file.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
  return `${file.readUInt32BE(16)}x${file.readUInt32BE(20)}`;
}

it("the page links the manifest", () => {
  expect(readFileSync(new URL("../index.html", import.meta.url), "utf8")).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
});

it("names Home Quarters as a standalone app from /", () => {
  expect([manifest.name, manifest.display, manifest.start_url, manifest.scope]).toEqual(["Home Quarters", "standalone", "/", "/"]);
});

it("lists 192 and 512 px icons, one of them maskable", () => {
  const icons = (manifest.icons ?? []).map((i) => i.sizes + "/" + (i.purpose ?? "any"));
  expect(icons).toEqual(expect.arrayContaining(["192x192/any", "512x512/any", "512x512/maskable"]));
});

it("every icon it lists is a PNG of the size it claims", () => {
  for (const icon of manifest.icons ?? []) {
    expect(icon.src.startsWith("/")).toBe(true);
    expect({ src: icon.src, size: pngSize(readFileSync(new URL(icon.src.slice(1), pub))) }).toEqual({ src: icon.src, size: icon.sizes });
  }
});
