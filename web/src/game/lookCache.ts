// Reference-counted cache of avatar looks. A person holds one look at a time; a look is built once and
// shared by everybody wearing it, and destroyed when its last holder changes look or leaves. Pure logic,
// no PixiJS: avatars.ts supplies how to build and destroy a value. Leaving the screen is not leaving:
// holders are released on a look change or a disconnect only.

export class LookCache<T> {
  private readonly entries = new Map<string, { value: T; refs: number }>();
  private readonly held = new Map<number, string>();

  private readonly destroy: (value: T) => void;

  constructor(destroy: (value: T) => void) {
    this.destroy = destroy;
  }

  /** The value for `key` (built on first use), held by `holder`; the holder's previous look is released. */
  acquire(holder: number, key: string, build: () => T): T {
    const prev = this.held.get(holder);
    let e = this.entries.get(key);
    if (prev !== key) {
      if (!e) this.entries.set(key, (e = { value: build(), refs: 0 }));
      e.refs++;
      this.held.set(holder, key);
      if (prev !== undefined) this.drop(prev);
    }
    return e!.value;
  }

  /** The holder left: its look is destroyed if nobody else wears it. */
  release(holder: number) {
    const prev = this.held.get(holder);
    if (prev === undefined) return;
    this.held.delete(holder);
    this.drop(prev);
  }

  has(holder: number) {
    return this.held.has(holder);
  }

  get size() {
    return this.entries.size;
  }

  private drop(key: string) {
    const e = this.entries.get(key);
    if (!e || --e.refs > 0) return;
    this.entries.delete(key);
    this.destroy(e.value);
  }
}
