// Once a conversation ends, the microphone and camera can be turned off for the next one (two settings).
// A grace keeps a short break (somebody steps away and back, a dropped call) from counting as an end.

/** How long after a conversation ends the turn-off waits; a new conversation before then cancels it. */
export const AUTO_OFF_GRACE_MS = 15_000;

/** A pending turn-off: `at` is when it applies (null while a call runs); `mic`/`cam` are still to turn off. */
export interface Pending {
  at: number | null;
  mic: boolean;
  cam: boolean;
}

export interface AutoOffDeps {
  now(): number;
  load(): Pending | null;
  save(p: Pending | null): void;
  /** Applies the turn-off to the devices still pending (the settings decide which actually turn off). */
  turnOff(mic: boolean, cam: boolean): void;
  setTimer(fn: () => void, ms: number): number;
  clearTimer(id: number): void;
}

/** In a call: a conversation (proximity or room), or my own spotlight; watching someone else's is not. */
export const inCall = (s: { conv: unknown; spotlight: { me: boolean } | null }) => !!s.conv || !!s.spotlight?.me;

/**
 * The pending state lives in this page and is mirrored to storage, so a page closed during a call or
 * during the grace still turns them off when it opens again. A call running when the page goes away ends
 * then (`hidden` stamps the deadline); a call record without a deadline (the page crashed) is overdue.
 */
export class AutoOff {
  grace = AUTO_OFF_GRACE_MS;
  private calling = false;
  private timer = 0;
  private pending: Pending | null = null;
  private d: AutoOffDeps;

  constructor(deps: AutoOffDeps) {
    this.d = deps;
  }

  /** At start, before any call: picks up a turn-off left pending by a closed page. */
  resume() {
    const p = this.d.load();
    if (p) this.schedule(p.at ?? this.d.now(), p);
  }

  /** Called on every state change; only a change between in a call and not counts. */
  update(calling: boolean) {
    if (calling === this.calling) return;
    this.calling = calling;
    this.stop();
    if (calling) this.set({ at: null, mic: true, cam: true });
    else this.schedule(this.d.now() + this.grace, { at: null, mic: true, cam: true });
  }

  /** The page is going away: a running call ends now, as far as the next start is concerned. */
  hidden() {
    if (this.calling && this.pending) this.d.save({ ...this.pending, at: this.d.now() + this.grace });
  }

  /** The person turned this device on or off on the bar between calls: their choice wins. */
  chose(kind: "mic" | "cam") {
    if (this.calling || !this.pending) return;
    const next = { ...this.pending, [kind]: false };
    if (next.mic || next.cam) return this.set(next);
    this.stop();
    this.set(null);
  }

  private set(p: Pending | null) {
    this.pending = p;
    this.d.save(p);
  }

  private schedule(at: number, p: Pending) {
    this.set({ ...p, at });
    this.timer = this.d.setTimer(() => this.fire(), Math.max(0, at - this.d.now()));
  }

  private stop() {
    if (this.timer) this.d.clearTimer(this.timer);
    this.timer = 0;
  }

  private fire() {
    this.timer = 0;
    const p = this.pending;
    this.set(null);
    if (p && (p.mic || p.cam)) this.d.turnOff(p.mic, p.cam);
  }
}
