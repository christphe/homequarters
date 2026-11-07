export function load(): void {
  hq.route("GET", "/boom", () => {
    throw new Error("boom");
  });
}
