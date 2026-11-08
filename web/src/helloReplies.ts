import type { Status } from "./net/protocol";

/** What the client tells the server after every hello, from what this browser remembers. */
export function helloReplies(s: { consent: boolean; status: Status }, note: string | null): object[] {
  // Always say it, false too: the server keeps a player's consent when another client of the same
  // account takes over (a second browser, the desktop app), and this one may never have opted in.
  const out: object[] = [{ t: "consent", b: s.consent }];
  if (s.status !== "available") out.push({ t: "st", v: s.status });
  if (note) out.push({ t: "note", text: note }); // the note lives in memory on the server
  return out;
}
