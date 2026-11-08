// Writes many keys as it stops: they are queued for the database after the stop has answered.
export function unload(): void {
  for (let i = 0; i < 600; i++) hq.kv.set("k" + i, "from unload");
}
