// hq-cards's table log: everything a seated player does at a table, shown to everybody who has it open, as at
// a real table where looking through the discard pile is seen by all. An entry names a card only when it
// ended face up (seen by everybody); a card one player saw alone is never named. Bounded in bytes: the
// oldest entries go first. Types and pure functions only.
import { utf8Bytes } from "./games.ts";

export type Verb =
  | "chose" | "took" | "placed" | "gave" | "took back" | "flipped" | "offered" | "withdrew" | "picked" | "dealt" | "shuffled"
  | "gathered" | "counted" | "created" | "removed" | "looked" | "reordered" | "drew";
const VERBS: readonly string[] = [
  "chose", "took", "placed", "gave", "took back", "flipped", "offered", "withdrew", "picked", "dealt", "shuffled",
  "gathered", "counted", "created", "removed", "looked", "reordered", "drew",
];

/** s: the seat that acted; c: a card, named because it ended face up; p: a pile's name; to: another seat; n: a number; text: a count or a game's title. */
export interface LogEntry { s: number; v: Verb; c?: number; p?: string; to?: number; n?: number; text?: string }

export const LOG_MAX = 2000; // UTF-8 bytes of JSON for the whole log, so it travels in one message

export function append(log: LogEntry[], e: LogEntry): LogEntry[] {
  const out = [...log, e];
  let size = utf8Bytes(JSON.stringify(out));
  while (out.length > 1 && size > LOG_MAX) size -= utf8Bytes(JSON.stringify(out.shift())) + 1;
  return out;
}

const isEntry = (e: unknown): e is LogEntry =>
  typeof e === "object" && e !== null && Number.isInteger((e as LogEntry).s) && VERBS.includes((e as LogEntry).v);

export function parseLog(s: string | null): LogEntry[] {
  if (!s) return [];
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v.filter(isEntry) : [];
  } catch {
    return [];
  }
}

export function sentence(e: LogEntry, seat: (s: number) => string, card: (c: number) => string): string {
  const who = seat(e.s);
  const it = e.c !== undefined ? "the " + card(e.c) : "a card";
  switch (e.v) {
    case "chose": return `${who} chose ${e.text ?? "a game"}`;
    case "took": return `${who} took seat ${e.s + 1}`;
    case "placed": return `${who} put ${it} on ${e.p ?? "the table"}`;
    case "gave": return `${who} gave a card to ${seat(e.to ?? 0)}`;
    case "took back": return `${who} took a card back`;
    case "flipped": return e.c !== undefined ? `${who} turned ${it} face up` : `${who} turned a card face down`;
    case "offered": return `${who} offered their hand to ${seat(e.to ?? 0)}`;
    case "withdrew": return `${who} withdrew the offer`;
    case "picked": return `${who} drew a card from ${seat(e.to ?? 0)}'s hand`;
    case "dealt": return e.n ? `${who} dealt ${e.n} cards each` : `${who} dealt all the cards`;
    case "shuffled": return `${who} shuffled ${e.p}`;
    case "gathered": return `${who} gathered all the cards`;
    case "counted": return `${who} counted: ${e.text}`;
    case "created": return `${who} created the pile ${e.p}`;
    case "removed": return `${who} removed the pile ${e.p}`;
    case "looked": return `${who} looked at ${e.p}`;
    case "reordered": return `${who} reordered ${e.p}`;
    case "drew": return `${who} drew a card from ${e.p}`;
  }
}
