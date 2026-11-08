// @vitest-environment jsdom
// The store moves an upgraded browser's Tilework keys to hq.* as it loads (web/src/store.ts), before anything reads
// them: the join screen's name, the avatar, settings and consent. The migration's own rules are storageMigration.test.ts.
// Its own file: it loads a fresh store module, which no other test of the file may share.
import { expect, it, vi } from "vitest";

it("loading the store moves the Tilework keys to hq.*, so the saved name, look and settings are read", async () => {
  localStorage.clear();
  localStorage.setItem("tilework.name", "Legacy");
  localStorage.setItem("tilework.avatar", JSON.stringify({ sk: 3, hs: 2, hc: 1, sh: 0, pa: 2 }));
  localStorage.setItem("tilework.settings", JSON.stringify({ minimap: false }));
  vi.resetModules();
  const { getState } = await import("../src/store");
  expect(localStorage.getItem("hq.name")).toBe("Legacy");
  expect(Object.keys(localStorage).filter((k) => k.startsWith("tilework."))).toEqual([]);
  expect(getState().myAvatar.sk).toBe(3);
  expect(getState().settings.minimap).toBe(false);
  localStorage.clear();
});
