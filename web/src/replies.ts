// What the server's replies to a walk-to and a wave, and its notices of a layout switch and a forced door, tell
// the player (session.ts shows them as toasts).
// Pure so it can be tested without a browser.
import { t } from "./i18n";
import type { WaveResult } from "./net/protocol";

/** A walk-to reply: the door it will stop at (the person is behind a closed one), no way there, or nothing. */
export function goToast(m: { ok: boolean; near?: boolean }): string | null {
  if (!m.ok) return t("go.unreachable");
  return m.near ? t("go.door") : null;
}

/** A wave reply ("ok", "wait": the busy or away cooldown, "offline"), naming the person waved at. */
export function waveToast(st: WaveResult["st"], name: string): string {
  return t(`wave.${st}`, { name });
}

/** The office switched to another layout: the server says so just before everybody reconnects into it. */
export function layoutToast(layout: string): string {
  return t("layout.moved", { name: layout });
}

/** An administrator forced the door of the room I am in: who, and which room. */
export function forcedToast(name: string, area: string): string {
  return t("door.forced", { name, area });
}
