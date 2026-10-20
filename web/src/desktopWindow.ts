// The desktop app (desktop/) tells the page when its window is hidden to the tray or shown again, with a
// `hq-desktop` window event ("hidden" or "shown"). A hidden window is easy to forget with a microphone
// open, so hiding stops every capture and sets the person busy; showing the window does not turn any
// capture back on.

export const DESKTOP_EVENT = "hq-desktop";

/** The status to set when the window is hidden, and whether showing it again should undo that. */
export function onWindowHidden(status: string): { status: "busy" | null; restore: boolean } {
  if (status === "available" || status === "away") return { status: "busy", restore: true };
  return { status: null, restore: false };
}

/** The status to set when the window is shown again. */
export function onWindowShown(status: string, restore: boolean): "available" | null {
  return restore && status === "busy" ? "available" : null;
}
