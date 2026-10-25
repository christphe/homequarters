// The Cards window's button labels. A label over 40 characters stops the plugin on that page, so every label
// that carries a name (a member's, up to 24 characters, or a pile's) shortens the name to fit. Pure.

export const LABEL_MAX = 40;

/** prefix + name + suffix, the name cut with an ellipsis so the whole fits LABEL_MAX characters. */
export function fit(prefix: string, name: string, suffix = ""): string {
  const room = LABEL_MAX - [...prefix].length - [...suffix].length;
  const c = [...name];
  return prefix + (c.length > room ? c.slice(0, Math.max(1, room - 1)).join("") + "…" : name) + suffix;
}

export const labels = {
  seat: (i: number, name: string, away: boolean) => fit(`Seat ${i + 1}: `, name, away ? " (away)" : ""),
  freeSeat: (i: number) => `Seat ${i + 1}`,
  offer: (name: string) => fit("Offer my hand to ", name),
  withdraw: (name: string) => fit("Withdraw the offer to ", name),
  shuffle: (pile: string) => fit("Shuffle ", pile),
  deal: (n: number) => `Deal ${n} each`,
};
