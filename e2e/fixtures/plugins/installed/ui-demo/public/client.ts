// Test plugin of the browser suite: one button at every anchor, a box on the map that says what was
// clicked last, a modal with a copyable text and Home Quarters' app token widget, a modal with the
// plugin's view (views/echo.ts), and a map object it draws itself (the orb: no sprite in plugin.json,
// "dynamic": true), pulsing from onObjectUpdate.
let last = "nothing yet";
let state = "";
let viewSays = "nothing";
let fromView = 0; // flood messages received from the view
let echoOpen = false, dirty = false;
// the page's port, taken as the SDK takes it: what plugin code can do past the SDK, which the page must still check
let rawPort: MessagePort | null = null;
window.addEventListener("message", (ev) => {
  if (ev.data === "hq-port" && ev.ports[0]) rawPort = ev.ports[0];
});

function echo(): void {
  echoOpen = true;
  hq.ui.modal({ title: "Echo", size: "medium", onClose: () => { echoOpen = false; clicked("echo closed"); } }, [
    hq.ui.text("View: " + viewSays),
    hq.ui.text("From the view: " + fromView),
    hq.ui.view({ view: "echo", label: "Echo view", height: "small", onMessage: heard }),
    hq.ui.button({ label: "Flood the view", onClick: () => { for (let i = 0; i < 100; i++) hq.ui.post({ t: "flood" }); } }),
    // a post past the SDK's own check: a Map and an ArrayBuffer serialize to {} but would clone whole
    hq.ui.button({ label: "Raw post", onClick: () => rawPort?.postMessage({ t: "cmds", c: [{ op: "post", d: { t: "raw", big: new Map([["a", "x".repeat(100000)]]), buf: new ArrayBuffer(1 << 20) } }] }) }),
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

// ---- the orb: drawn in code, spawned per placed object, animated by onObjectUpdate
const CELL = 16;
async function orbSheet(): Promise<Blob> {
  const c = new OffscreenCanvas(CELL * 2, CELL);
  const g = c.getContext("2d")!;
  [["#3f8fd6", "#bfe6ff"], ["#2a5f9e", "#7fc4f0"]].forEach(([rim, core], col) => {
    g.fillStyle = "#1a1526";
    g.fillRect(col * CELL + 3, 5, 10, 10);
    g.fillStyle = rim;
    g.fillRect(col * CELL + 4, 6, 8, 8);
    g.fillStyle = core;
    g.fillRect(col * CELL + 6, 8, 4, 4);
  });
  return c.convertToBlob({ type: "image/png" });
}
// what the suite reads in this iframe: every init and destroy, and the updates per object
const seen = { init: [] as HQ.PlacedObject[], destroy: [] as HQ.PlacedObject[], updates: {} as Record<string, number> };
(window as unknown as { __objs: typeof seen }).__objs = seen;
const orbId = (o: HQ.PlacedObject) => `orb@${o.x},${o.y}`;
const phase: Record<string, number> = {};
// the sheet is image data made asynchronously: an orb initialised before it is ready is spawned once it is
const live = new Set<string>();
const sheetReady = orbSheet().then((image) => {
  hq.loadSprite("orb", image, { frameW: CELL, frameH: CELL, anims: { a: { row: 0, frames: [0], fps: 0 }, b: { row: 0, frames: [1], fps: 0 } } });
});
hq.onObjectInit((o) => {
  seen.init.push(o);
  const id = orbId(o);
  live.add(id);
  void sheetReady.then(() => {
    if (!live.has(id)) return; // destroyed meanwhile
    // anchored at the bottom centre of its cell: the middle of the object's footprint, at its bottom edge
    hq.spawn(id, "orb", { x: o.px + o.w * 8, y: o.py + o.h * 16, anim: "a" });
    hq.setLabel(id, "Orb");
  });
});
hq.onObjectDestroy((o) => {
  seen.destroy.push(o);
  live.delete(orbId(o));
  hq.remove(orbId(o));
});
hq.onObjectUpdate((dt, o) => {
  const id = orbId(o);
  seen.updates[id] = (seen.updates[id] ?? 0) + 1;
  if (!live.has(id)) return;
  const before = Math.floor((phase[id] ?? 0) / 0.5) % 2;
  phase[id] = (phase[id] ?? 0) + dt;
  const now = Math.floor(phase[id] / 0.5) % 2;
  if (now !== before) hq.setAnim(id, now ? "b" : "a"); // pulses twice a second
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
