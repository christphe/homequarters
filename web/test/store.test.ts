// The page's store (store.ts): what it reads back from browser storage at start, and how a change is saved
// and announced. Run: node --test web/test
import "./tsResolve.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

/** Browser storage as the page sees it, in memory. */
class MemoryStorage {
  m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
}
const storage = new MemoryStorage();
storage.setItem("hq.settings", JSON.stringify({ sounds: false, maxVideos: 3 }));
storage.setItem("hq.prefs", "{"); // broken
storage.setItem("tilework.avatar", JSON.stringify({ sk: 3, hs: 2, hc: 0, sh: 1, pa: 0 })); // saved under the project's old name
storage.setItem("hq.consent", "1");
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });

const store = await import("../src/store.ts");

test("saved settings come back over the defaults; a value that cannot be read gives the defaults", () => {
  const s = store.getState();
  assert.equal(s.settings.sounds, false);
  assert.equal(s.settings.maxVideos, 3);
  assert.equal(s.settings.minimap, true, "a setting never saved keeps its default");
  assert.equal(s.settings.noiseEngine, "gtcrn");
  assert.deepEqual(s.prefs, { micOn: true, camOn: false, micId: "", camId: "", spkId: "" }, "broken JSON: the defaults");
  assert.equal(s.consent, true);
});

test("what an older version saved under its old name is read under the new one", () => {
  assert.deepEqual(store.getState().myAvatar, { sk: 3, hs: 2, hc: 0, sh: 1, pa: 0 });
  assert.equal(storage.getItem("tilework.avatar"), null, "the old key is gone");
});

test("saving a setting keeps the others, writes storage and tells every subscriber, until they unsubscribe", () => {
  let calls = 0;
  const off = store.subscribe(() => calls++);
  const before = store.getState();
  store.saveSettings({ eco: true });
  assert.equal(calls, 1);
  assert.notEqual(store.getState(), before, "a new state object: React sees the change");
  assert.equal(store.getState().settings.eco, true);
  assert.equal(store.getState().settings.sounds, false);
  const saved = JSON.parse(storage.getItem("hq.settings")!);
  assert.equal(saved.eco, true);
  assert.equal(saved.sounds, false);
  store.savePrefs({ micOn: false });
  assert.equal(JSON.parse(storage.getItem("hq.prefs")!).micOn, false);
  assert.equal(calls, 2);
  off();
  store.setState({ unread: 3 });
  assert.equal(calls, 2);
  assert.equal(store.getState().unread, 3);
  assert.equal(before.settings.eco, false, "an earlier state is never changed in place");
});
