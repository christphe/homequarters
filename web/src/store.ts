import { useSyncExternalStore } from "react";
import type { AvatarSpec, ObjectReply, Person, Prop, Role, Status } from "./net/protocol";

export interface ChatMsg {
  id: number;
  sc: "o" | "g" | "d";
  from: number;
  to?: number;
  text: string;
  ts: number;
  n?: string; // sender name, for history entries whose author is offline
}

export type ConvState = "connecting" | "live" | "reconnecting" | "failed";
export interface Conv {
  kind: "p" | "r";
  name: string;
  members: number[];
  state: ConvState;
}

export type NoiseEngine = "rnnoise" | "speex" | "gtcrn";

export interface Settings {
  eco: boolean;
  maxVideos: number;
  audioOnly: boolean;
  debug: boolean;
  sounds: boolean;
  notify: boolean;
  minimap: boolean;
  /** Go away when the computer itself is idle or locked (Idle Detection), not just this tab. */
  osIdle: boolean;
  /** Noise suppression on the microphone, with `noiseEngine` (loaded only when on). */
  denoise: boolean;
  noiseEngine: NoiseEngine;
}

export interface MediaPrefs {
  micOn: boolean;
  camOn: boolean;
  micId: string;
  camId: string;
  spkId: string;
}

export interface State {
  phase: "boot" | "join" | "play";
  conn: "connecting" | "open" | "reconnecting" | "replaced";
  meId: number;
  role: Role;
  status: Status;
  office: string;
  mediaAvailable: boolean;
  consent: boolean;
  roster: Map<number, Person>;
  conv: Conv | null;
  chat: ChatMsg[];
  unread: number;
  settings: Settings;
  prefs: MediaPrefs;
  mic: boolean;
  cam: boolean;
  sharing: boolean;
  deviceError: string;
  currentArea: string;
  /** The area I stand in (a desk room included), -1 outside any. */
  areaIndex: number;
  toast: string;
  myAvatar: AvatarSpec;
  /** One-off message shown on the join screen (for example after being removed). */
  notice: string;
  /** Set when this server is a public demo: content resets periodically. */
  demo: { resetHours: number; nextReset: number } | null;
  /** Sign-in: the providers offered (empty: none, the cookie is the account), and which step the
   *  join screen is on - a new identity picking its name, or a member from before sign-in linking one. */
  auth: { providers: string[]; signup: { email: string } | null; link: { name: string } | null };
  nearby: Prop | null;
  object: ObjectReply | null;
  following: { id: number; name: string } | null;
  leadRequest: { id: number; name: string } | null;
  locked: number[];
  /** Rooms the server keeps me out of right now (locked and not let in, or somebody else's office). */
  denied: number[];
  /** The server runs a newer deploy than this page: reload (see UpdateBanner). */
  outdated: boolean;
  knock: { id: number; name: string; area: string } | null;
  boardKey: string;
  /** The local player runs (Shift held, or "always run" on). */
  running: boolean;
  /** Somebody waved at me (shown until dismissed). */
  wave: { id: number; name: string } | null;
  /** Visible people per map area (index), for the minimap. */
  areaCounts: number[];
  /** The latest administrator announcement, until dismissed. */
  announcement: { name: string; text: string } | null;
  spotlight: { id: number; name: string; me: boolean; state: ConvState } | null;
}

const load = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? { ...d, ...JSON.parse(v) } : d;
  } catch {
    return d;
  }
};

const initial: State = {
  phase: "boot",
  conn: "connecting",
  meId: 0,
  role: "member",
  status: "available",
  office: "",
  mediaAvailable: false,
  consent: localStorage.getItem("tilework.consent") === "1",
  roster: new Map(),
  conv: null,
  chat: [],
  unread: 0,
  settings: load<Settings>("tilework.settings", { eco: false, maxVideos: 6, audioOnly: false, debug: false, sounds: true, notify: false, minimap: true, osIdle: false, denoise: false, noiseEngine: "gtcrn" }),
  prefs: load<MediaPrefs>("tilework.prefs", { micOn: true, camOn: false, micId: "", camId: "", spkId: "" }),
  mic: false,
  cam: false,
  sharing: false,
  deviceError: "",
  currentArea: "",
  areaIndex: -1,
  toast: "",
  myAvatar: load<AvatarSpec>("tilework.avatar", { sk: 1, hs: 0, hc: 1, sh: 4, pa: 1 }),
  notice: "",
  demo: null,
  auth: { providers: [], signup: null, link: null },
  nearby: null,
  object: null,
  following: null,
  leadRequest: null,
  locked: [],
  denied: [],
  outdated: false,
  knock: null,
  boardKey: "",
  running: false,
  wave: null,
  areaCounts: [],
  announcement: null,
  spotlight: null,
};

let state = initial;
const subs = new Set<() => void>();

export const getState = () => state;
export function setState(p: Partial<State>) {
  state = { ...state, ...p };
  subs.forEach((f) => f());
}
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => sel(state),
  );
}

export function saveSettings(s: Partial<Settings>) {
  const settings = { ...state.settings, ...s };
  localStorage.setItem("tilework.settings", JSON.stringify(settings));
  setState({ settings });
}
export function savePrefs(p: Partial<MediaPrefs>) {
  const prefs = { ...state.prefs, ...p };
  localStorage.setItem("tilework.prefs", JSON.stringify(prefs));
  setState({ prefs });
}
export function saveAvatar(a: AvatarSpec) {
  localStorage.setItem("tilework.avatar", JSON.stringify(a));
  setState({ myAvatar: a });
}

let toastTimer = 0;
export function toast(msg: string, ms = 4000) {
  setState({ toast: msg });
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => setState({ toast: "" }), ms);
}
