import { WorldView } from "./game/WorldView";
import { cachedLooks } from "./game/avatars";
import { autoStatus, osIdleGranted, watchOsIdle } from "./osIdle";
import { setKeyLayout } from "./keys";
import { homeTile } from "./game/home";
import { Socket, type ConnState } from "./net/socket";
import type { BoardCommand, Person, Prop, ServerMsg, Status } from "./net/protocol";
import { boardModel } from "./game/boardModel";
import { media, spotlightMedia } from "./media/MediaManager";
import { getState, setState, toast, type ChatMsg } from "./store";
import { t } from "./i18n";
import { chime, chimeLog, desktopNotify } from "./notify";
import { convChange } from "./convChime";
import { isOutdated, pageVersion } from "./version";

const AWAY_AFTER_MS = 5 * 60 * 1000;

/** Glue between the socket, the Pixi world, the media manager and the React store. */
class Session {
  view: WorldView | null = null;
  socket: Socket | null = null;
  private stopped = true;
  private chatId = 0;
  private idleTimer = 0;
  private lastActivity = Date.now();
  private autoAway = false;
  /** Set while the computer's own idle state is watched (settings, Idle Detection); then it decides. */
  private stopOsIdle: (() => void) | null = null;
  private machineIdle = false;
  /** The hand state last asked for while the server has not confirmed it yet (null: follow the server). */
  private handWanted: boolean | null = null;
  private handAskedAt = 0;
  private cleanup: (() => void)[] = [];

  async start(host: HTMLElement) {
    this.stopped = false;
    const view = new WorldView({
      sendInput: (seq, dx, dy, run) => this.socket?.send(run ? { t: "in", s: seq, x: dx, y: dy, b: true } : { t: "in", s: seq, x: dx, y: dy }),
      onGoto: (x, y) => this.socket?.send({ t: "go", x, y }),
      onRun: (running) => setState({ running }),
      onArea: (name, index) => setState({ currentArea: name, areaIndex: index }),
      onResume: () => this.socket?.send({ t: "sync" }),
      onEmote: (kind) => this.emote(kind),
      onHand: () => this.toggleHand(),
      onInteract: (prop) => { view.setDirection(0, 0); this.socket?.send({ t: "use", x: prop.x, y: prop.y }); },
      onNearby: (nearby) => setState({ nearby }),
      onView: (cells) => this.socket?.send({ t: "view", n: cells }),
      onHome: () => this.goHome(),
      onBusy: () => this.toggleBusy(),
    });
    await view.init(host, getState().settings.eco);
    if (this.stopped) {
      view.destroy();
      return;
    }
    this.view = view;
    media.onSpeaking = (ids) => view.setSpeaking(ids);
    media.onSharing = (ids) => view.setSharing(ids);
    media.onNeedToken = () => this.socket?.send({ t: "tok" });
    media.onProblem = (kind, code) => this.socket?.send({ t: "diag", v: kind, n: code });
    spotlightMedia.onNeedToken = () => this.socket?.send({ t: "tok" });
    this.socket = new Socket((m) => this.onMessage(m), (s) => this.onConn(s), () => void this.onEvicted());
    this.socket.connect();

    const act = () => {
      this.lastActivity = Date.now();
      if (!this.stopOsIdle) this.applyAutoStatus(false);
    };
    for (const ev of ["keydown", "pointerdown", "pointermove"]) window.addEventListener(ev, act, { passive: true });
    this.cleanup.push(() => ["keydown", "pointerdown", "pointermove"].forEach((ev) => window.removeEventListener(ev, act)));
    this.idleTimer = window.setInterval(() => {
      const st = getState();
      // Being in a conversation, or watching a spotlight, is presence. Only the
      // keyboard and the pointer count as activity, so somebody listening to a
      // presentation looks idle for the whole presentation - and going away is
      // not a dimmed dot: the server calls leaveGroup, which drops them out of
      // the call mid-sentence. Keeping the clock fresh here also means they are
      // not flipped away the instant a long call ends.
      if (st.conv || st.spotlight) this.lastActivity = Date.now();
      // with the computer's idle state watched, it decides (working in another app is not being away)
      this.applyAutoStatus(this.stopOsIdle ? this.machineIdle : Date.now() - this.lastActivity > AWAY_AFTER_MS);
    }, 15000);
    if (getState().settings.osIdle) void osIdleGranted().then((ok) => ok && this.setOsIdle(true));
    (window as unknown as { __hq: unknown }).__hq = { view, keys: { setKeyLayout }, media, spotlightMedia, boardModel, cachedLooks, chimes: chimeLog, get state() { return getState(); }, session: this };
  }

  private applyAutoStatus(inactive: boolean) {
    const st = getState();
    const next = autoStatus({ status: st.status, autoAway: this.autoAway, inCall: !!(st.conv || st.spotlight), inactive });
    if (!next) return;
    this.autoAway = next === "away";
    this.setStatus(next);
  }

  /** Follows the computer's idle state (true) or only this tab's activity (false). */
  setOsIdle(on: boolean) {
    this.stopOsIdle?.();
    this.stopOsIdle = null;
    this.machineIdle = false;
    if (!on) return;
    this.stopOsIdle = watchOsIdle(AWAY_AFTER_MS, (idle) => {
      this.machineIdle = idle;
      this.applyAutoStatus(idle);
    });
  }

  stop() {
    this.stopped = true;
    clearInterval(this.idleTimer);
    this.stopOsIdle?.();
    this.cleanup.forEach((f) => f());
    this.cleanup = [];
    this.socket?.close();
    this.socket = null;
    void media.leave();
    void spotlightMedia.leave();
    this.view?.destroy();
    this.view = null;
    boardModel.apply({ t: "wb", op: "closed" });
    setState({ conv: null, spotlight: null, roster: new Map(), object: null, nearby: null, following: null, leadRequest: null, boardKey: "", knock: null, wave: null, areaCounts: [] });
  }

  /** An admin removed us or changed our role. A role change keeps the session (reconnect); removal ends it. */
  private async onEvicted() {
    if (this.stopped) return;
    setState({ conn: "reconnecting" });
    const me = (await fetch("/api/me").then((r) => r.json()).catch(() => ({ authenticated: true }))) as { authenticated?: boolean };
    if (this.stopped) return;
    if (me.authenticated) {
      this.socket?.connect();
    } else {
      setState({ phase: "join", notice: t("removed.notice") });
    }
  }

  private onConn(s: ConnState) {
    setState({ conn: s });
  }

  private onMessage(m: ServerMsg) {
    const view = this.view;
    if (!view) return;
    switch (m.t) {
      case "hello": {
        this.handWanted = null; // a new connection starts from what the server knows
        const roster = new Map<number, Person>(m.roster.map((p) => [p.id, p]));
        // The server replays the persisted office chat on every connect; other scopes are kept as they are.
        const history: ChatMsg[] = (m.chat ?? []).map((c) => ({ id: ++this.chatId, sc: "o", from: c.f, text: c.x, ts: c.ts, n: c.n }));
        setState({ chat: [...history, ...getState().chat.filter((c) => c.sc !== "o")] });
        setState({ meId: m.you, role: m.role, status: m.status, office: m.office, mediaAvailable: m.cfg.media, roster, phase: "play", locked: m.cfg.lk ?? [], denied: m.cfg.deny ?? [], outdated: isOutdated(pageVersion(), m.cfg.ver) });
        view.setMap(m.map, m.cfg.deny);
        view.clearRemote();
        view.setMe(m.you, m.cfg.x, m.cfg.y, m.cfg.speed, m.cfg.run ?? 2);
        if (m.cfg.cell && m.cfg.aoi) view.setInterest(m.cfg.cell, m.cfg.aoi, m.cfg.aoiMax ?? m.cfg.aoi);
        view.setPeople(roster);
        const s = getState();
        if (s.consent) this.socket?.send({ t: "consent", b: true });
        if (s.status !== "available") this.socket?.send({ t: "st", v: s.status });
        const note = localStorage.getItem("hq.note");
        if (note) this.socket?.send({ t: "note", text: note }); // the note lives in memory on the server
        break;
      }
      case "w":
        view.applyWorld(m);
        break;
      case "a":
        view.applyAck(m);
        break;
      case "p": {
        const roster = new Map(getState().roster);
        m.a?.forEach((p) => roster.set(p.id, p));
        m.d?.forEach((id) => roster.delete(id));
        setState({ roster });
        view.setPeople(roster);
        const me = roster.get(getState().meId);
        if (me && this.handWanted !== null && !!me.h === this.handWanted) this.handWanted = null; // confirmed
        if (me && me.s !== "offline" && me.s !== getState().status) setState({ status: me.s as Status });
        break;
      }
      case "c": {
        const msg: ChatMsg = { id: ++this.chatId, sc: m.sc, from: m.f, to: m.to, text: m.x, ts: m.ts };
        const s = getState();
        setState({ chat: [...s.chat.slice(-299), msg], unread: m.f === s.meId ? s.unread : s.unread + 1 });
        if (m.sc === "d" && m.f !== s.meId) {
          chime("dm");
          desktopNotify(t("notify.dm", { name: s.roster.get(m.f)?.n ?? "?" }), t("notify.open"));
        }
        break;
      }
      case "conv":
        this.onConv(m);
        break;
      case "map":
        view.setMap(m.map, m.deny);
        setState({ denied: m.deny ?? [] });
        if (m.x !== undefined && m.y !== undefined) view.teleport(m.x, m.y);
        break;
      case "loc":
        if (m.ok && m.x !== undefined && m.y !== undefined) {
          view.showLocation(m.x, m.y);
          if (m.a) toast(m.a);
        }
        break;
      case "e": view.showEmote(m.id, m.v); break;
      case "obj": setState({ object: m }); break;
      case "fol":
        view.setGuided(m.id !== 0);
        setState({ following: m.id ? { id: m.id, name: m.n } : null });
        break;
      case "self": view.applySelf(m); break;
      case "go":
        if (m.ok) {
          view.setGuided(true);
          if (m.near) toast(t("go.door"));
        }
        else { view.clearDest(); toast(t("go.unreachable")); }
        break;
      case "wv":
        setState({ wave: { id: m.from, name: m.n } });
        chime("wave");
        desktopNotify(t("wave.incoming", { name: m.n }), t("notify.open"));
        break;
      case "wvr": {
        const name = getState().roster.get(m.id)?.n ?? "?";
        toast(t(`wave.${m.st}`, { name }));
        break;
      }
      case "ac": setState({ areaCounts: m.c }); break;
      case "ann":
        setState({ announcement: { name: m.n, text: m.x } });
        chime("wave");
        desktopNotify(t("announce.title", { name: m.n }), t("notify.open"));
        break;
      case "office": setState({ office: m.n }); break;
      case "lreq": setState({ leadRequest: { id: m.from, name: m.n } }); break;
      case "deny": view.setDeny(m.d); setState({ locked: m.lk, denied: m.d }); break;
      case "knk":
        if (m.done) { if (getState().knock?.id === m.id) setState({ knock: null }); }
        else setState({ knock: { id: m.id, name: m.n ?? "", area: m.a ?? "" } });
        if (!m.done) { chime("knock"); desktopNotify(t("door.knock", { area: m.a ?? "" }), t("notify.open")); }
        break;
      case "knr": toast(t(`door.${m.st}`, { area: m.a })); break;
      case "frc": toast(t("door.forced", { name: m.n, area: m.a })); break;
      case "wb":
        boardModel.apply(m);
        if (m.op === "state") { view.setDirection(0, 0); setState({ boardKey: m.bk }); }
        if (m.op === "closed") setState({ boardKey: "" });
        break;
      case "spot":
        if (m.op === "off") { void spotlightMedia.leave(); setState({ spotlight: null }); }
        else {
          setState({ spotlight: { id: m.sid, name: m.n, me: m.me, state: "connecting" } });
          if (m.tok && m.url && m.room) {
            void spotlightMedia.join({ url: m.url, token: m.tok, room: m.room }, m.me).catch(() => toast(t("spot.error")));
          } else { void spotlightMedia.leave(); }
        }
        break;
    }
  }

  private onConv(m: Extract<ServerMsg, { t: "conv" }>) {
    const view = this.view!;
    const prev = getState().conv?.members ?? null;
    const cue = m.op === "join" ? "in" : convChange(prev, m.op === "leave" ? null : m.m, getState().meId);
    if (cue) chime(cue === "in" ? "convIn" : "convOut");
    if (m.op === "join") {
      setState({ conv: { kind: m.k, name: m.name, members: m.m, state: "connecting" } });
      view.setInConversation(new Set(m.m));
      if (m.tok && m.url) {
        media.join({ url: m.url, token: m.tok, room: m.room }).catch(() => {
          media.onProblem("media-join", 0);
          const c = getState().conv;
          if (c) setState({ conv: { ...c, state: "failed" } });
          toast(t("media.failed"));
        });
      } else {
        const c = getState().conv;
        if (c) setState({ conv: { ...c, state: "failed" } });
      }
    } else if (m.op === "m") {
      const c = getState().conv;
      if (c) setState({ conv: { ...c, members: m.m } });
      view.setInConversation(new Set(m.m));
    } else if (m.op === "leave") {
      void media.leave();
      setState({ conv: null });
      view.setInConversation(new Set());
    }
  }

  // ---- user actions ----
  setStatus(s: Status) {
    setState({ status: s });
    this.socket?.send({ t: "st", v: s });
  }
  /** Ctrl+U: busy, or back to available from busy or away. A manual choice ends the automatic away. */
  toggleBusy() {
    const s = getState().status;
    if (s === "busy" || s === "away") this.backToAvailable();
    else { this.autoAway = false; this.setStatus("busy"); }
  }
  /** The big button on the status veil, and Ctrl+U from busy or away. */
  backToAvailable() {
    this.autoAway = false;
    this.lastActivity = Date.now();
    this.setStatus("available");
  }
  setConsent(b: boolean) {
    setState({ consent: b });
    localStorage.setItem("hq.consent", b ? "1" : "0");
    this.socket?.send({ t: "consent", b });
  }
  chat(scope: "o" | "g" | "d", text: string, to?: number) {
    this.socket?.send({ t: "chat", sc: scope, text, id: to });
  }
  locate(id: number) {
    this.socket?.send({ t: "loc", id });
  }
  emote(kind: number) { this.socket?.send({ t: "emo", n: kind }); }
  follow(id: number) { this.socket?.send({ t: "fol", id }); }
  /** Run next to another person (server-side path finding). */
  goToPerson(id: number) { this.socket?.send({ t: "go", id }); }
  /** Runs to my assigned desk, or into my private office; says so when I have neither. */
  goHome() {
    const map = this.view?.currentMap();
    const tile = map && homeTile(map, getState().meId);
    if (tile) this.view!.goTo(tile.x, tile.y);
    else toast(t("home.none"));
  }
  /** Takes the free desk I stand next to; the server checks everything and sends everybody the new map. */
  async claimDesk(desk: Prop): Promise<boolean> {
    const r = await fetch("/api/desk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ x: desk.x, y: desk.y }) }).catch(() => null);
    if (r?.ok) return true; // the button changes and the desk gets its mat: no toast needed
    const reason = ((await r?.json().catch(() => null)) as { error?: string } | null)?.error;
    toast(t(reason === "far" || reason === "taken" || reason === "has_place" || reason === "room" ? `desk.err.${reason}` : "desk.err.other"));
    return false;
  }
  /** Frees my own desk (I stand in its room); the server checks it and sends everybody the new map. */
  async releaseDesk(desk: Prop): Promise<boolean> {
    const r = await fetch("/api/desk/release", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ x: desk.x, y: desk.y }) }).catch(() => null);
    if (!r?.ok) toast(t("desk.err.release"));
    return !!r?.ok;
  }
  wave(id: number) { this.socket?.send({ t: "wave", id }); }
  hand(up: boolean) { this.handWanted = up; this.handAskedAt = Date.now(); this.socket?.send({ t: "hand", b: up }); }
  /** H key and the hand button: invert what was last asked for, so quick presses do not repeat a raise. */
  toggleHand() {
    const s = getState();
    // a request the server never confirmed (dropped by the rate limit) stops counting after a second
    const pending = Date.now() - this.handAskedAt < 1000 ? this.handWanted : null;
    this.hand(!(pending ?? !!s.roster.get(s.meId)?.h));
  }
  note(text: string) {
    if (text) localStorage.setItem("hq.note", text);
    else localStorage.removeItem("hq.note");
    this.socket?.send({ t: "note", text });
  }
  toggleRun() { this.view?.toggleRun(); }
  lead(id: number) { this.socket?.send({ t: "lead", id }); }
  lock(on: boolean) { this.socket?.send({ t: "lock", b: on }); }
  knock(area: number) { this.socket?.send({ t: "knock", n: area }); }
  /** Administrators: walk through a closed door on purpose (logged, the people inside are told). */
  force(area: number) { this.socket?.send({ t: "force", n: area }); }
  answerKnock(id: number, allow: boolean) { this.socket?.send({ t: "kans", id, b: allow }); setState({ knock: null }); }
  board(m: BoardCommand) { this.socket?.send({ t: "wb", ...m }); }
  setEco(eco: boolean) {
    this.view?.setEco(eco);
  }
}

export const session = new Session();
