// When a desktop notification may fire: the person opted in, the system allows it, and the page is in the
// background. In the background means hidden (minimised, in the tray, another tab) or visible without the
// focus (another app in front, the window behind another one), as chat apps do: a visible window you are
// not looking at needs the cue as much as a minimised one.

export interface NotifyContext {
  enabled: boolean;
  /** Notification.permission, or undefined when the API is missing. */
  permission: NotificationPermission | undefined;
  hidden: boolean;
  focused: boolean;
}

export function mayNotify(c: NotifyContext): boolean {
  return c.enabled && c.permission === "granted" && (c.hidden || !c.focused);
}
