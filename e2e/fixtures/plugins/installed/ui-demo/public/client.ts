// Test plugin of the browser suite: one button at every anchor, a box on the map that says what was
// clicked last, and a modal with a copyable text and Home Quarters' app token widget.
let last = "nothing yet";
let state = "";

function box(): void {
  hq.ui.slot("box", "screen", {
    corner: "top-left", dx: 12, dy: 130,
    content: [hq.ui.text("Last click: " + last), hq.ui.text(state ? "State: " + state : "No state", { muted: true })],
  });
}

function clicked(where: string): void {
  last = where;
  box();
}

hq.onLoad(() => {
  hq.ui.slot("side", "sidebar", { onClick: () => hq.ui.modal({ title: "UI demo", size: "medium", onClose: () => clicked("modal closed") }, [
    hq.ui.text("A copyable text and your app token for this plugin."),
    hq.ui.copy({ label: "Copy me", value: "copied-value-42" }),
    hq.ui.image({ src: "icon.png", alt: "demo icon" }),
    hq.ui.appToken(),
    hq.ui.button({ label: "Inside the modal", onClick: () => clicked("modal button") }),
  ]) });
  hq.ui.slot("top", "topbar", { label: "Demo top", onClick: () => clicked("topbar") });
  hq.ui.slot("tr", "topright", { label: "Demo corner", icon: "icon.png", onClick: () => clicked("topright") });
  hq.ui.slot("bottom", "bottombar", { label: "Demo bottom", icon: "icon.png", onClick: () => clicked("bottombar") });
  hq.ui.slot("map", "minimap", { label: "Demo map", onClick: () => clicked("minimap") });
  box();
});

hq.onMessage((m: { t?: string; body?: unknown }) => {
  if (m.t === "state" && typeof m.body === "string") {
    state = m.body.slice(0, 80);
    box();
  }
});
