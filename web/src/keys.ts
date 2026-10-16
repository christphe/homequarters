// Shortcuts follow physical key positions (KeyboardEvent.code), not the characters they type, so
// W A S D is Z Q S D on an AZERTY keyboard and the digit row works without Shift. Help text shows
// what is printed on the user's keys when the browser can tell (Keyboard API, Chromium only);
// elsewhere it learns them from the keys the user types, and names keys not typed yet in US QWERTY.
import { useEffect, useState } from "react";

export const MOVE_KEYS: Record<string, "u" | "l" | "d" | "r"> = {
  KeyW: "u", KeyA: "l", KeyS: "d", KeyD: "r",
  ArrowUp: "u", ArrowLeft: "l", ArrowDown: "d", ArrowRight: "r",
};

/** The key's position, or for events without one (some virtual keyboards, remote desktops) the US position of what it typed. */
export function codeOf(e: { code: string; key: string }): string {
  if (e.code) return e.code;
  const k = e.key.length === 1 ? e.key.toUpperCase() : "";
  return /^[A-Z]$/.test(k) ? "Key" + k : /^[0-9]$/.test(k) ? "Digit" + k : e.key;
}

/**
 * 1-9 for the digit row, whatever the layout types there, or for the numeric keypad while Num Lock
 * is on (with it off the keypad types arrows, which move); 0 otherwise.
 */
export function digitOf(code: string, key = ""): number {
  const m = /^(Digit|Numpad)([1-9])$/.exec(code);
  if (!m || (m[1] === "Numpad" && !/^[1-9]$/.test(key))) return 0;
  return Number(m[2]);
}

type LayoutMap = { get(code: string): string | undefined };
let layout: LayoutMap | null = null;
let loading: Promise<void> | null = null;
const typed = new Map<string, string>(); // code -> character, from real key presses

/** Remembers what a plain key press typed, for browsers without the Keyboard API. */
export function learnKey(e: { code: string; key: string; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }) {
  if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.key.length !== 1 || !/^Key[A-Z]$/.test(e.code)) return;
  if (typed.size < 64) typed.set(e.code, e.key);
}

/** Reads the keyboard layout once; resolves when labels from keyLabel() are final. */
export function loadKeyLayout(): Promise<void> {
  const kb = (navigator as Navigator & { keyboard?: { getLayoutMap?: () => Promise<LayoutMap> } }).keyboard;
  loading ??= (kb?.getLayoutMap?.() ?? Promise.resolve(null)).then((m) => { layout = m; }, () => {});
  return loading;
}

/** The label printed on the key at this position, e.g. "Z" for KeyW on AZERTY. */
export function keyLabel(code: string): string {
  const k = layout?.get(code) ?? typed.get(code);
  if (k && k.trim().length === 1) return k.toUpperCase();
  return code.startsWith("Key") ? code.slice(3) : code;
}

/** Test seam: pretend the browser reported this layout. */
export function setKeyLayout(m: LayoutMap | null) {
  layout = m;
  typed.clear();
  loading = Promise.resolve();
}

/** Re-renders once the layout is known, so labels from keyLabel() match the user's keyboard. */
export function useKeyLayout() {
  const [, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void loadKeyLayout().then(() => { if (live) setReady(true); });
    return () => { live = false; };
  }, []);
}

/** "W A S D" as printed on this keyboard, e.g. "Z Q S D" on AZERTY. */
export const moveLabels = () => ["KeyW", "KeyA", "KeyS", "KeyD"].map(keyLabel);

// same test as isMac in game/home.ts: neither module may import the other's values (node --test loads them as is)
const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MAC_SYMBOL = { ctrl: "⌃", alt: "⌥", shift: "⇧", mod: "⌘" } as const;
const PC_NAME = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", mod: "Ctrl" } as const;
type Mod = keyof typeof MAC_SYMBOL;
/** A shortcut as this computer writes it: ⇧⌘D on a Mac (Apple's order, no separator), Ctrl+Shift+D
 * elsewhere. "mod" is Command on a Mac and Ctrl elsewhere. The OS decides, not the keyboard layout. */
export function combo(mods: Mod[], key = "", mac = isMac()): string {
  const order: Mod[] = mac ? ["ctrl", "alt", "shift", "mod"] : ["mod", "ctrl", "alt", "shift"];
  const used = order.filter((m) => mods.includes(m));
  if (mac) return used.map((m) => MAC_SYMBOL[m]).join("") + key;
  const names: string[] = [...new Set(used.map((m) => PC_NAME[m]))];
  return (key ? [...names, key] : names).join("+");
}
