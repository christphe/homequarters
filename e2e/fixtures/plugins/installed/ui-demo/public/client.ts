// Test plugin of the browser suite: one button at every anchor, a box on the map that says what was
// clicked last, a modal with a copyable text and Home Quarters' app token widget, and a modal with the
// plugin's view (views/echo.ts).
let last = "nothing yet";
let state = "";
let viewSays = "nothing";
let fromView = 0; // flood messages received from the view
let echoOpen = false, dirty = false;

function echo(): void {
  echoOpen = true;
  hq.ui.modal({ title: "Echo", size: "medium", onClose: () => { echoOpen = false; clicked("echo closed"); } }, [
    hq.ui.text("View: " + viewSays),
    hq.ui.text("From the view: " + fromView),
    hq.ui.view({ view: "echo", label: "Echo view", height: "small", onMessage: heard }),
    hq.ui.button({ label: "Flood the view", onClick: () => { for (let i = 0; i < 100; i++) hq.ui.post({ t: "flood" }); } }),
  ]);
}

// a message of the view: redraw the modal at most on each update (10 a second), never per message
function heard(m: { t?: string; n?: number; reachedPage?: boolean }): void {
  if (m.t === "hello") viewSays = "hello, page " + (m.reachedPage ? "reached" : "blocked");
  else if (m.t === "ping") {
    viewSays = "ping " + m.n;
    hq.ui.post({ t: "pong", n: m.n });
  } else if (m.t === "flood") fromView++;
  dirty = true;
}

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
    hq.ui.button({ label: "Echo view", onClick: echo }),
    hq.ui.button({ label: "Missing view", onClick: () => hq.ui.modal({ title: "Missing", size: "small" }, [
      hq.ui.text("No view here"),
      hq.ui.view({ view: "nope", label: "Missing view" }),
    ]) }),
  ]) });
  hq.ui.slot("top", "topbar", { label: "Demo top", onClick: () => clicked("topbar") });
  hq.ui.slot("tr", "topright", { label: "Demo corner", icon: "icon.png", onClick: () => clicked("topright") });
  hq.ui.slot("bottom", "bottombar", { label: "Demo bottom", icon: "icon.png", onClick: () => clicked("bottombar") });
  hq.ui.slot("map", "minimap", { label: "Demo map", onClick: () => clicked("minimap") });
  box();
});

hq.onUpdate(() => {
  if (dirty && echoOpen) echo();
  dirty = false;
});

hq.onMessage((m: { t?: string; body?: unknown }) => {
  if (m.t === "state" && typeof m.body === "string") {
    state = m.body.slice(0, 80);
    box();
  }
});
