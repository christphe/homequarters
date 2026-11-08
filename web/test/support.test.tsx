// @vitest-environment jsdom
// The component-test helpers of web/test/support, checked through the web/src modules that use what they fake.
// Several tests come in pairs: the first changes something, the second checks it did not leak.
import { canvasCalls, fakeDevice, offlineFetch, person, renderUI, roster, stubFetch, stubIdleDetector, stubKeyboardLayout, stubMediaDevices } from "./support";
import { mockMedia, tile } from "./support/media";
import { mockSession } from "./support/session";
import { describe, expect, it } from "vitest";
import { request } from "../src/net/http";
import { askOsIdle, watchOsIdle } from "../src/osIdle";
import { keyLabel, loadKeyLayout } from "../src/keys";
import { getState, setState, toast } from "../src/store";

describe("renderUI and the store", () => {
  it("starts in the office as Me (id 1), plus the patch", () => {
    renderUI(<p>hi</p>, { roster: roster(person(2, "Bruno")) });
    const s = getState();
    expect([s.phase, s.conn, s.meId, [...s.roster.values()].map((p) => p.n)]).toEqual(["play", "open", 1, ["Me", "Bruno"]]);
    toast("left over");
    setState({ conv: { kind: "p", name: "p", members: [1, 2], state: "live" } });
    localStorage.setItem("hq.name", "x");
  });
  it("the next test starts from the known state again, storage empty", () => {
    const s = getState();
    expect([s.toast, s.conv, s.roster.size, localStorage.length]).toEqual(["", null, 1, 0]);
  });
});

describe("the session and media fakes", () => {
  it("record calls", () => {
    mockSession().wave(3);
    mockMedia().media.setTiles([tile()]);
    expect(mockSession().wave).toHaveBeenCalledWith(3);
    expect(mockMedia().media.getTiles()).toHaveLength(1);
  });
  it("are reset before the next test", () => {
    expect(mockSession().wave).not.toHaveBeenCalled();
    expect(mockMedia().media.getTiles()).toEqual([]);
    expect(mockSession().view?.currentMap()).toBeNull();
  });
  it("activeMedia's choice follows the spotlight", () => {
    const m = mockMedia();
    expect(m.active()).toBe(m.media);
    setState({ spotlight: { id: 1, name: "Me", me: true, state: "live" } });
    expect(m.active()).toBe(m.spotlightMedia);
  });
});

describe("fetch", () => {
  it("stubFetch answers exact and prefix routes and keeps the requests", async () => {
    const net = stubFetch({ "PUT /api/profile": { status: 204 }, "GET /api/admin/*": (r) => ({ json: { path: r.path } }) });
    expect((await request("PUT", "/api/profile", { name: "A" })).status).toBe(204);
    expect((await request<{ path: string }>("GET", "/api/admin/members?x=1")).json.path).toBe("/api/admin/members");
    expect(net.requests.map((r) => [r.method, r.path, r.query, r.body])).toEqual([["PUT", "/api/profile", "", { name: "A" }], ["GET", "/api/admin/members", "?x=1", undefined]]);
  });
  it("stubFetch records a request no route answers (and would fail the test)", async () => {
    const net = stubFetch({});
    expect((await request("POST", "/api/nope")).status).toBe(404);
    expect(net.unmatched).toEqual(["POST /api/nope"]);
    net.unmatched.length = 0; // this test expects it
  });
  it("offlineFetch fails as the network does: request() answers status 0", async () => {
    offlineFetch();
    expect(await request("GET", "/api/me")).toEqual({ ok: false, status: 0, json: {} });
    await expect(fetch("/x")).rejects.toBeInstanceOf(TypeError);
  });
});

describe("jsdom gaps", () => {
  it("a canvas has a 2D context that records calls, and no WebGL", () => {
    const c = document.createElement("canvas");
    const g = c.getContext("2d")!;
    g.fillRect(0, 0, 1, 1);
    expect(g.getImageData(0, 0, 2, 3).data).toHaveLength(24);
    expect(canvasCalls(c)).toEqual(["fillRect", "getImageData"]);
    expect(c.getContext("webgl")).toBeNull();
  });
  it("media elements play and pause", async () => {
    const a = document.createElement("audio");
    await a.play();
    expect(a.paused).toBe(false);
    a.pause();
    expect(a.paused).toBe(true);
  });
});

describe("navigator stubs", () => {
  it("stubMediaDevices lists devices and answers getUserMedia on the asked device", async () => {
    const md = stubMediaDevices([fakeDevice("audioinput", "mic-1"), fakeDevice("audiooutput", "spk-1")], { display: false });
    expect((await navigator.mediaDevices.enumerateDevices()).map((d) => d.deviceId)).toEqual(["mic-1", "spk-1"]);
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: "mic-1" } } });
    const [track] = stream.getAudioTracks();
    expect(track?.getSettings().deviceId).toBe("mic-1");
    track?.stop();
    expect(track?.readyState).toBe("ended");
    expect(md.getUserMedia).toHaveBeenCalledTimes(1);
    expect("getDisplayMedia" in navigator.mediaDevices).toBe(false);
  });
  it("are undone after the test", () => {
    expect(navigator.mediaDevices).toBeUndefined();
    expect("IdleDetector" in globalThis).toBe(false);
  });
  it("stubIdleDetector grants, starts and reports idle or locked through osIdle", async () => {
    const idle = stubIdleDetector("granted");
    expect(await askOsIdle()).toBe("granted");
    const seen: boolean[] = [];
    const stop = watchOsIdle(1000, (b) => seen.push(b));
    await Promise.resolve();
    expect(idle.started[0]?.threshold).toBe(60_000);
    idle.set("idle");
    idle.set("active", "locked");
    idle.set("active");
    stop();
    idle.set("idle"); // stopped: not heard
    expect(seen).toEqual([true, true, false]);
  });
  it("stubIdleDetector can refuse", async () => {
    stubIdleDetector("denied");
    expect(await askOsIdle()).toBe("denied");
  });
  it("stubKeyboardLayout gives keys.ts the layout (AZERTY)", async () => {
    stubKeyboardLayout({ KeyW: "z", KeyQ: "a" });
    await loadKeyLayout();
    expect([keyLabel("KeyW"), keyLabel("KeyQ")]).toEqual(["Z", "A"]);
  });
});
