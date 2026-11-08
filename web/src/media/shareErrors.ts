// What the person is told when a screen share cannot start (it used to fail silently). Pure: the media
// manager and the media bar ask here, web/test/shareErrors.test.ts checks every case.
import { t, type Key } from "../i18n";

/** Why the Share screen button cannot start a share (a key of the i18n dictionary), or null when it can. */
export function shareRefusal(s: { canShare: boolean; live: boolean }): Key | null {
  if (!s.canShare) return "share.unsupported";
  if (!s.live) return "share.needCall";
  return null;
}

/** Why a screen share did not start, or "" when the person simply closed the picker. */
export function describeShareError(e: unknown): string {
  const { name = "", message = "" } = (e ?? {}) as { name?: string; message?: string };
  if (name === "NotAllowedError") {
    if (/system/i.test(message)) return t("share.systemDenied");
    if (/policy/i.test(message)) return t("share.blocked");
    return ""; // the person closed the picker
  }
  if (name === "SecurityError") return t("share.blocked");
  if (name === "NotSupportedError") return t("share.unsupported");
  return t("share.couldNotStart");
}

/** Every message about screen sharing, so a new attempt clears them and leaves device problems on screen. */
export const SHARE_MESSAGES = ["share.unsupported", "share.systemDenied", "share.blocked", "share.couldNotStart", "share.needCall"] as const;
