// Browser APIs jsdom does not have, as fakes a test controls: media devices (enumerateDevices, getUserMedia,
// getDisplayMedia), Idle Detection and the keyboard layout map. Each stub is undone after the test.
import { vi, type Mock } from "vitest";
import { onCleanup } from "./cleanup";

/** Defines `obj[key]` for the test and puts back what was there (or nothing) after it. */
function define(obj: object, key: string, value: unknown): void {
  const before = Object.getOwnPropertyDescriptor(obj, key);
  Object.defineProperty(obj, key, { value, configurable: true, writable: true });
  onCleanup(() => {
    if (before) Object.defineProperty(obj, key, before);
    else delete (obj as Record<string, unknown>)[key];
  });
}

// ---- media devices

/** A device as enumerateDevices lists it. */
export const fakeDevice = (kind: MediaDeviceKind, deviceId: string, label = deviceId, groupId = ""): MediaDeviceInfo =>
  ({ kind, deviceId, label, groupId, toJSON() { return { kind, deviceId, label, groupId }; } });

export type FakeTrack = MediaStreamTrack & { stop: Mock<() => void> };

/** A track that is live until stopped (stop is a spy); getSettings tells its device. */
export function fakeTrack(kind: "audio" | "video", deviceId = "default", label = kind + " " + deviceId): FakeTrack {
  const events = new EventTarget();
  const track = {
    kind, id: Math.random().toString(36).slice(2), label, enabled: true, muted: false, readyState: "live" as MediaStreamTrackState, contentHint: "",
    getSettings: () => ({ deviceId }), getConstraints: () => ({}), getCapabilities: () => ({}), applyConstraints: async () => {},
    clone: () => fakeTrack(kind, deviceId, label),
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
    onended: null, onmute: null, onunmute: null,
    stop: vi.fn(() => { track.readyState = "ended"; }),
  };
  return track;
}

/** A stream of the given tracks, with the getters components use. */
export function fakeStream(...tracks: MediaStreamTrack[]): MediaStream {
  const list = [...tracks];
  return {
    id: Math.random().toString(36).slice(2), active: true,
    getTracks: () => [...list], getAudioTracks: () => list.filter((t) => t.kind === "audio"), getVideoTracks: () => list.filter((t) => t.kind === "video"),
    addTrack: (t: MediaStreamTrack) => void list.push(t), removeTrack: (t: MediaStreamTrack) => void list.splice(list.indexOf(t), 1),
    addEventListener() {}, removeEventListener() {},
  } as unknown as MediaStream;
}

const deviceOf = (c: boolean | MediaTrackConstraints | undefined) => {
  const id = typeof c === "object" ? c.deviceId : undefined;
  const v = typeof id === "object" && id !== null && !Array.isArray(id) ? id.exact ?? id.ideal : id;
  return typeof v === "string" ? v : Array.isArray(v) ? String(v[0]) : "default";
};

export interface MediaDevicesFake {
  devices: MediaDeviceInfo[];
  enumerateDevices: Mock<() => Promise<MediaDeviceInfo[]>>;
  getUserMedia: Mock<(c?: MediaStreamConstraints) => Promise<MediaStream>>;
  getDisplayMedia: Mock<(c?: DisplayMediaStreamOptions) => Promise<MediaStream>>;
  /** Tells listeners of "devicechange", after the test changed `devices`. */
  change(): void;
}

/**
 * navigator.mediaDevices with `devices`: enumerateDevices lists them; getUserMedia answers a stream with one fake
 * track per kind asked for (on the asked device); getDisplayMedia a stream with one video track. Make a spy reject
 * to test errors (`getUserMedia.mockRejectedValueOnce(new DOMException("", "NotAllowedError"))`). With
 * `{ display: false }` there is no getDisplayMedia (a phone).
 */
export function stubMediaDevices(devices: MediaDeviceInfo[] = [], o: { display?: boolean } = {}): MediaDevicesFake {
  const events = new EventTarget();
  const fake: MediaDevicesFake = {
    devices,
    enumerateDevices: vi.fn(async () => [...fake.devices]),
    getUserMedia: vi.fn(async (c?: MediaStreamConstraints) => {
      const tracks: MediaStreamTrack[] = [];
      if (c?.audio) tracks.push(fakeTrack("audio", deviceOf(c.audio)));
      if (c?.video) tracks.push(fakeTrack("video", deviceOf(c.video)));
      return fakeStream(...tracks);
    }),
    getDisplayMedia: vi.fn(async () => fakeStream(fakeTrack("video", "screen"))),
    change: () => void events.dispatchEvent(new Event("devicechange")),
  };
  const md: Record<string, unknown> = {
    enumerateDevices: fake.enumerateDevices, getUserMedia: fake.getUserMedia,
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), ondevicechange: null,
    getSupportedConstraints: () => ({ deviceId: true, echoCancellation: true, noiseSuppression: true, autoGainControl: true }),
  };
  if (o.display !== false) md.getDisplayMedia = fake.getDisplayMedia;
  define(navigator, "mediaDevices", md);
  return fake;
}

// ---- Idle Detection

export interface IdleDetectorFake {
  /** What requestPermission answers. */
  permission: "granted" | "denied";
  requestPermission: Mock<() => Promise<"granted" | "denied">>;
  /** The detectors started so far, with what they were started with. */
  started: { threshold: number; signal: AbortSignal }[];
  /** Sets the state of every running detector and fires their "change". */
  set(user: "active" | "idle", screen?: "locked" | "unlocked"): void;
}

/** globalThis.IdleDetector (Chrome's Idle Detection API), answering `permission`. */
export function stubIdleDetector(permission: "granted" | "denied" = "granted"): IdleDetectorFake {
  const running = new Set<EventTarget & { userState: string | null; screenState: string | null }>();
  const fake: IdleDetectorFake = {
    permission,
    requestPermission: vi.fn(async () => fake.permission),
    started: [],
    set(user, screen = "unlocked") {
      for (const d of running) { d.userState = user; d.screenState = screen; d.dispatchEvent(new Event("change")); }
    },
  };
  class IdleDetector extends EventTarget {
    static requestPermission = () => fake.requestPermission();
    userState: string | null = null;
    screenState: string | null = null;
    async start(o: { threshold: number; signal: AbortSignal }) {
      if (fake.permission !== "granted") throw new DOMException("Idle detection permission denied", "NotAllowedError");
      fake.started.push(o);
      this.userState = "active";
      this.screenState = "unlocked";
      running.add(this);
      o.signal.addEventListener("abort", () => running.delete(this));
    }
  }
  define(globalThis, "IdleDetector", IdleDetector);
  return fake;
}

// ---- keyboard layout

/**
 * navigator.keyboard.getLayoutMap answering `layout` (code -> key, e.g. { KeyQ: "a", KeyW: "z" } for AZERTY).
 * web/src/keys.ts asks once per page and keeps the answer: a test of a different layout needs a fresh module
 * (vi.resetModules) or a test file of its own.
 */
export function stubKeyboardLayout(layout: Record<string, string>): Mock<() => Promise<Map<string, string>>> {
  const getLayoutMap = vi.fn(async () => new Map(Object.entries(layout)));
  define(navigator, "keyboard", { getLayoutMap, lock: async () => {}, unlock() {} });
  return getLayoutMap;
}
