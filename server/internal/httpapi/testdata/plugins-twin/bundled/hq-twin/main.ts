export function load(): void {
  hq.route("GET", "/who", () => ({ body: "bundled" }));
}
