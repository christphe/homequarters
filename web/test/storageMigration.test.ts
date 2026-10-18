// Browser storage moved from tilework.* to hq.* with the rename: an upgraded browser keeps its
// preferences, avatar and consent. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateStorage, type KeyValueStorage } from "../src/storageMigration.ts";

class MemoryStorage implements KeyValueStorage {
  m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
}

const legacy = {
  "tilework.settings": JSON.stringify({ eco: true, maxVideos: 4 }),
  "tilework.prefs": JSON.stringify({ micOn: false, camOn: true }),
  "tilework.avatar": JSON.stringify({ sk: 3, hs: 2, hc: 1, sh: 0, pa: 2 }),
  "tilework.consent": "1",
  "tilework.name": "Ada",
  "tilework.zoom": "3",
  "tilework.note": "back at 2",
};

test("every tilework.* key moves to hq.* with its value", () => {
  const s = new MemoryStorage();
  for (const [k, v] of Object.entries(legacy)) s.setItem(k, v);
  s.setItem("unrelated", "kept");
  migrateStorage(s);
  for (const [k, v] of Object.entries(legacy)) {
    assert.equal(s.getItem("hq." + k.slice("tilework.".length)), v, k);
    assert.equal(s.getItem(k), null, k + " is removed once copied");
  }
  assert.equal(s.getItem("unrelated"), "kept");
});

test("a value already saved under hq.* wins over a stale legacy one", () => {
  const s = new MemoryStorage();
  s.setItem("tilework.name", "Old");
  s.setItem("hq.name", "New");
  migrateStorage(s);
  assert.equal(s.getItem("hq.name"), "New");
  assert.equal(s.getItem("tilework.name"), null);
});

test("running it again changes nothing", () => {
  const s = new MemoryStorage();
  s.setItem("tilework.consent", "1");
  migrateStorage(s);
  migrateStorage(s);
  assert.deepEqual([...s.m.entries()], [["hq.consent", "1"]]);
});

test("a storage that throws (private window, blocked site data) does not break start-up", () => {
  const broken: KeyValueStorage = {
    get length(): number { throw new Error("SecurityError"); },
    key() { throw new Error("SecurityError"); },
    getItem() { throw new Error("SecurityError"); },
    setItem() { throw new Error("SecurityError"); },
    removeItem() { throw new Error("SecurityError"); },
  };
  assert.doesNotThrow(() => migrateStorage(broken));
});
