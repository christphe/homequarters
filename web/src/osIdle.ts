// The computer's own idle state through the Idle Detection API (Chromium browsers): away when nobody
// has touched the machine for a while or its screen is locked, not merely this tab. Opt-in from the
// settings; the browser asks for the permission on that click. Only the resulting status reaches the
// server, never the idle state itself.

interface IdleDetectorLike extends EventTarget {
  userState: "active" | "idle" | null;
  screenState: "locked" | "unlocked" | null;
  start(o: { threshold: number; signal: AbortSignal }): Promise<void>;
}
interface IdleDetectorClass {
  new (): IdleDetectorLike;
  requestPermission(): Promise<"granted" | "denied">;
}

const detectorClass = () => (globalThis as unknown as { IdleDetector?: IdleDetectorClass }).IdleDetector;

export const osIdleSupported = () => !!detectorClass();

/** Asks for the permission; call it from a click. */
export async function askOsIdle(): Promise<boolean> {
  try {
    return (await detectorClass()?.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

/** Whether the permission was already given (then watching needs no click). */
export async function osIdleGranted(): Promise<boolean> {
  try {
    return (await navigator.permissions.query({ name: "idle-detection" as PermissionName })).state === "granted";
  } catch {
    return false;
  }
}

/** Watches the machine; `onChange(true)` when it is idle for `thresholdMs` (at least 60 s) or locked. */
export function watchOsIdle(thresholdMs: number, onChange: (idle: boolean) => void): () => void {
  const D = detectorClass();
  const ctl = new AbortController();
  if (D) {
    const det = new D();
    det.addEventListener("change", () => onChange(det.userState === "idle" || det.screenState === "locked"));
    det.start({ threshold: Math.max(60_000, thresholdMs), signal: ctl.signal }).catch(() => onChange(false));
  }
  return () => ctl.abort();
}

/**
 * The automatic status, from what is known about the person: "away" after inactivity unless they are
 * in a call or watching a spotlight (that is presence, and going away would drop them from it), back
 * to "available" when they return - but only from an away this rule set, never one they chose.
 */
export function autoStatus(o: { status: string; autoAway: boolean; inCall: boolean; inactive: boolean }): "away" | "available" | null {
  if (o.inactive) return !o.inCall && o.status === "available" ? "away" : null;
  return o.autoAway && o.status === "away" ? "available" : null;
}
