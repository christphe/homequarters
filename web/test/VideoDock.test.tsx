// @vitest-environment jsdom
// Component test of VideoDock (web/src/ui/VideoDock.tsx) with the media managers faked: the dock shows the tiles of
// the conversation's room, and a tile's volume button steps through 100 %, 50 % and muted for me. That LiveKit plays
// the person at that volume stays in the browser suite (e2e/scenarios/proximity.ts, per-person volume).
import { person, renderUI, roster } from "./support"; // first: canvas before PixiJS
import { mockMedia, tile } from "./support/media";
import { act, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Conv } from "../src/store";
import { VideoDock } from "../src/ui/VideoDock";

vi.mock("../src/session", async () => (await import("./support/session")).sessionModule());
vi.mock("../src/media/MediaManager", async (original) => (await import("./support/media")).mediaModule(await original<typeof import("../src/media/MediaManager")>()));

const conv: Conv = { kind: "p", name: "p-1", members: [1, 2], state: "live" };
const me = tile({ identity: "1", name: "Me", local: true });

it("shows nothing out of a conversation, and a tile per person in one", () => {
  const { media } = mockMedia();
  media.tiles = [me, tile()];
  const { unmount } = renderUI(<VideoDock />);
  expect(document.querySelector(".dock")).toBeNull();
  unmount();
  renderUI(<VideoDock />, { conv, roster: roster(person(2, "Bruno")) });
  expect(document.querySelectorAll(".dock .tile")).toHaveLength(2);
});

it("a remote tile's volume button steps 100 % -> 50 % -> muted -> 100 %; my own tile has none", async () => {
  const { media } = mockMedia();
  media.tiles = [me, tile()];
  const { user } = renderUI(<VideoDock />, { conv, roster: roster(person(2, "Bruno")) });
  expect(screen.getAllByRole("button", { name: /^Volume of/ })).toHaveLength(1);
  for (const [from, to] of [[1, 0.5], [0.5, 0], [0, 1]] as const) {
    const button = screen.getByRole("button", { name: `Volume of Bruno for you: ${from * 100}% (click to change)` });
    await user.click(button);
    expect(media.setVolume).toHaveBeenLastCalledWith("2", to);
    act(() => media.setTiles([me, tile({ vol: to })])); // as the manager does once LiveKit took the volume
  }
  expect(media.setVolume).toHaveBeenCalledTimes(3);
});
