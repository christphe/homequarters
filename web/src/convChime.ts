// Which cue a change of conversation deserves, so an open microphone never comes as a surprise:
// "in" when a conversation opens for me or somebody joins it, "out" when I leave or somebody leaves.

export function convChange(prev: readonly number[] | null, next: readonly number[] | null, me: number): "in" | "out" | null {
  if (!prev) return next ? "in" : null;
  if (!next) return "out";
  const before = new Set(prev.filter((id) => id !== me));
  const after = new Set(next.filter((id) => id !== me));
  for (const id of after) if (!before.has(id)) return "in";
  for (const id of before) if (!after.has(id)) return "out";
  return null;
}
