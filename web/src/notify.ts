import { getState } from "./store";
import { playCue, type Cue } from "./audioOut";

// Gentle cues for things that need you: a wave, a direct message, a knock, a conversation starting or
// ending around you (so an open microphone is never a surprise). Sounds are synthesised and played by
// audioOut (no audio files to license or download); desktop notifications only fire while the tab is hidden,
// only after the user opted in, and never carry message text (lock screens are public).

/** The last cues asked for, newest last (read by the browser tests; what was heard is audioOut's soundLog). */
export const chimeLog: string[] = [];
const lastAt: Record<string, number> = {};

export function chime(kind: Cue) {
  if (!getState().settings.sounds) return;
  const now = performance.now();
  if (now - (lastAt[kind] ?? -1e9) < 400) return; // one cue for a burst of changes
  lastAt[kind] = now;
  chimeLog.push(kind);
  if (chimeLog.length > 20) chimeLog.shift();
  playCue(kind);
}

export function desktopNotify(title: string, body: string) {
  if (!document.hidden || !getState().settings.notify || !("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body, tag: "homequarters-" + title, silent: true });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}

export async function askNotifyPermission(): Promise<boolean> {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  return (await Notification.requestPermission()) === "granted";
}

