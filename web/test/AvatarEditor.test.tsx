// @vitest-environment jsdom
// Component test of the avatar editor (web/src/ui/AvatarEditor.tsx), the join screen's and the appearance dialog's:
// hair styles, beards and hats as radio groups, hat colours only once a hat is on, a colour from a palette or any
// colour through the browser's picker, and the preview redrawn. What the server keeps of a look is
// TestNormalizeAvatarDropsUnknownFields (server/internal/httpapi/avatar_test.go), how others draw it avatarLook.test.ts
// and lookCache.test.ts; the appearance dialog saving it with the profile is SettingsDialog.test.tsx. The browser keeps
// the profile save through the real settings and appearance dialogs reaching another person: e2e/scenarios/social.ts.
import { canvasCalls, LOOK, renderUI } from "./support"; // first: canvas before PixiJS
import { fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import type { AvatarSpec } from "../src/net/protocol";
import { AvatarEditor } from "../src/ui/AvatarEditor";

/** The editor holding its value as the join screen does; `changes` sees every look it reports. */
function Editor({ changes }: { changes: (a: AvatarSpec) => void }) {
  const [av, setAv] = useState<AvatarSpec>(LOOK);
  return <AvatarEditor value={av} onChange={(a) => { changes(a); setAv(a); }} />;
}
const show = () => {
  const changes = vi.fn<(a: AvatarSpec) => void>();
  return { ...renderUI(<Editor changes={changes} />), changes, last: () => changes.mock.lastCall?.[0] };
};
const group = (name: string) => screen.getByRole("radiogroup", { name });
const checked = (name: string) => within(group(name)).getAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.getAttribute("aria-label") ?? r.textContent);

it("offers hair styles, beards and hats, each a radio group with one choice", async () => {
  const { user, last } = show();
  await user.click(within(group("Hair")).getByRole("radio", { name: "Afro" }));
  await user.click(within(group("Beard")).getByRole("radio", { name: "Full beard" }));
  await user.click(within(group("Hat")).getByRole("radio", { name: "Tricorne" }));
  expect(last()).toMatchObject({ hs: 7, bd: 4, ht: 7 });
  expect([checked("Hair"), checked("Beard"), checked("Hat")]).toEqual([["Afro"], ["Full beard"], ["Tricorne"]]);
});

it("hat colours appear once a hat is chosen, and go with it", async () => {
  const { user, last } = show();
  expect(screen.queryByRole("radiogroup", { name: "Hat colour" })).toBeNull();
  await user.click(within(group("Hat")).getByRole("radio", { name: "Tricorne" }));
  await user.click(within(group("Hat colour")).getByRole("radio", { name: "Hat colour 3" }));
  expect(last()).toMatchObject({ ht: 7, hk: 2 });
  expect(checked("Hat colour")).toEqual(["Hat colour 3"]);
  const none = within(group("Hat")).getAllByRole("radio")[0]!;
  await user.click(none);
  expect(screen.queryByRole("radiogroup", { name: "Hat colour" })).toBeNull();
});

it("a shirt takes a palette colour or any colour from the picker", async () => {
  const { user, last } = show();
  await user.click(within(group("Shirt")).getByRole("radio", { name: "Shirt 2" }));
  expect(last()?.sh).toBe(1);
  fireEvent.change(screen.getByLabelText("Shirt: custom colour"), { target: { value: "#12AB9F" } });
  expect(last()?.sh).toBe("#12ab9f");
  expect(checked("Shirt")).toEqual([]); // no palette swatch claims a custom colour
});

it("the preview is drawn again when the look changes", async () => {
  const { user, container } = show();
  const canvas = container.querySelector("canvas")!;
  const before = canvasCalls(canvas).length;
  expect(before).toBeGreaterThan(0);
  await user.click(within(group("Hair")).getByRole("radio", { name: "Afro" }));
  expect(canvasCalls(canvas).length).toBeGreaterThan(before);
});
