// What the server's replies to a walk-to and a wave tell the player (session.ts shows them as toasts).
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
