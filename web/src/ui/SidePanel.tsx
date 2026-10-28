import { useEffect, useMemo, useRef, useState } from "react";
import { session } from "../session";
import { getState, setState, useStore } from "../store";
import { t, type Key } from "../i18n";
import { AvatarCanvas } from "./AvatarEditor";
import { ChatIcon, PinIcon, PuzzleIcon, SendIcon, UsersIcon } from "./Icons";
import { statusColor } from "./StatusMenu";
import { PluginSlots } from "./PluginUI";

type Scope = { sc: "o" | "g" } | { sc: "d"; peer: number };

export function SidePanel() {
  // phones start with the map visible; the panel opens from its tab
  const [tab, setTab] = useState<"people" | "chat" | "plugins" | "">(() => (window.matchMedia?.("(max-width: 700px)").matches ? "" : "people"));
  const [scope, setScope] = useState<Scope>({ sc: "o" });
  const unread = useStore((s) => s.unread);
  const hasPlugins = useStore((s) => s.pluginUI.slots.some((x) => x.anchor === "sidebar"));
  useEffect(() => {
    if (tab === "plugins" && !hasPlugins) setTab("people");
  }, [tab, hasPlugins]);
  useEffect(() => {
    if (tab === "chat") setState({ unread: 0 });
  }, [tab, unread]);
  return (
    <aside className={"side" + (tab ? " open" : "")}>
      <nav className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "people"} className={tab === "people" ? "on" : ""} onClick={() => setTab(tab === "people" ? "" : "people")} title={t("roster.title")}>
          <UsersIcon />
        </button>
        <button role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "on" : ""} onClick={() => setTab(tab === "chat" ? "" : "chat")} title={t("chat.title")}>
          <ChatIcon />
          {unread > 0 && tab !== "chat" && <b className="badge">{unread > 9 ? "9+" : unread}</b>}
        </button>
        {hasPlugins && (
          <button role="tab" aria-selected={tab === "plugins"} className={tab === "plugins" ? "on" : ""} onClick={() => setTab(tab === "plugins" ? "" : "plugins")} title={t("plugins.title")} aria-label={t("plugins.title")}>
            <PuzzleIcon />
          </button>
        )}
      </nav>
      {tab === "people" && <People onDm={(peer) => { setScope({ sc: "d", peer }); setTab("chat"); }} />}
      {tab === "chat" && <Chat scope={scope} setScope={setScope} />}
      {tab === "plugins" && hasPlugins && <Plugins />}
    </aside>
  );
}

function People({ onDm }: { onDm: (id: number) => void }) {
  const roster = useStore((s) => s.roster);
  const me = useStore((s) => s.meId);
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const rank: Record<string, number> = { available: 0, busy: 1, away: 2, invisible: 3, offline: 4 };
    return [...roster.values()]
      .filter((p) => p.n.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : 0) || rank[a.s] - rank[b.s] || a.n.localeCompare(b.n));
  }, [roster, q, me]);
  return (
    <section className="panel" aria-label={t("roster.title")}>
      <h2>{t("roster.title")} <small>{[...roster.values()].filter((p) => p.s !== "offline").length}</small></h2>
      <input className="search" placeholder="🔍" value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("roster.title")} />
      <ul className="people" tabIndex={0} aria-label={t("roster.title")}>
        {list.map((p) => (
          <li key={p.id}>
            <AvatarCanvas av={p.av} size={2} />
            <div className="who">
              <span className="nm">{p.n}{p.id === me && <em> ({t("hud.you")})</em>}{p.h === 1 && <span role="img" aria-label={t("hand.raised")}> ✋</span>}</span>
              <span className="st"><i className="dot" style={{ background: statusColor[p.s] }} />{t(("status." + p.s) as Key)}{p.r === "admin" ? " · " + t("people.adminTag") : ""}</span>
              {p.m && <span className="note">{p.m}</span>}
            </div>
            {p.id !== me && p.s !== "offline" && (
              <div className="acts">
                <button title={t("go.action")} aria-label={`${t("go.action")} ${p.n}`} onClick={() => session.goToPerson(p.id)}>🏃</button>
                <button title={t("wave.action")} aria-label={`${t("wave.action")} ${p.n}`} onClick={() => session.wave(p.id)}>👋</button>
                <button title={t("roster.dm")} aria-label={`${t("roster.dm")} ${p.n}`} onClick={() => onDm(p.id)}><ChatIcon /></button>
                <MoreActions id={p.id} name={p.n} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The less frequent actions on a person, behind one button. The menu is fixed-positioned under the
 * button so the scrolling list never clips it; it closes on Escape, a click elsewhere, a scroll or
 * a resize, and after an action.
 */
function MoreActions({ id, name }: { id: number; name: string }) {
  const [at, setAt] = useState<React.CSSProperties | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const menuId = "more-" + id;
  useEffect(() => {
    if (!at) return;
    menu.current?.querySelector("button")?.focus({ preventScroll: true }); // scrolling the list would close the menu
    const away = (e: Event) => {
      if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setAt(null);
    };
    const close = () => setAt(null);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [at]);
  const open = () => {
    const r = btn.current!.getBoundingClientRect();
    const right = window.innerWidth - r.right;
    // under the button, or above it when the screen ends first (three items, about 130 px)
    setAt(r.bottom + 4 + 130 > window.innerHeight ? { top: "auto", bottom: window.innerHeight - r.top + 4, right } : { top: r.bottom + 4, right });
  };
  const run = (f: () => void) => () => { setAt(null); f(); };
  const items: [Key, () => void, React.ReactNode][] = [
    ["follow.action", () => session.follow(id), "↗"],
    ["follow.lead", () => session.lead(id), "→"],
    ["roster.locate", () => session.locate(id), <PinIcon key="pin" />],
  ];
  return (
    <>
      <button ref={btn} title={t("roster.more")} aria-label={t("roster.moreFor", { name })} aria-haspopup="true" aria-expanded={!!at} aria-controls={at ? menuId : undefined} onClick={() => (at ? setAt(null) : open())}>⋯</button>
      {at && (
        <ul ref={menu} id={menuId} className="menu more-menu" style={{ position: "fixed", ...at }} onKeyDown={(e) => { if (e.key === "Escape") { setAt(null); btn.current?.focus({ preventScroll: true }); } }}>
          {items.map(([label, f, icon]) => (
            <li key={label}>
              <button aria-label={`${t(label)} ${name}`} onClick={run(f)}><span className="ico" aria-hidden="true">{icon}</span>{t(label)}</button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Chat({ scope, setScope }: { scope: Scope; setScope: (s: Scope) => void }) {
  const chat = useStore((s) => s.chat);
  const roster = useStore((s) => s.roster);
  const me = useStore((s) => s.meId);
  const conv = useStore((s) => s.conv);
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const peer = scope.sc === "d" ? scope.peer : 0;
  const msgs = chat.filter((m) => {
    if (scope.sc === "o") return m.sc === "o";
    if (scope.sc === "g") return m.sc === "g";
    return m.sc === "d" && (m.from === peer || m.to === peer);
  });
  // Braces: Chrome 154+ returns a Promise from scrollIntoView, and an effect must return a cleanup or nothing.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [msgs.length, scope]);
  const name = (id: number) => roster.get(id)?.n ?? "?";
  const send = (e: React.FormEvent) => {
    e.preventDefault();
    const v = text.trim();
    if (!v) return;
    session.chat(scope.sc, v, scope.sc === "d" ? scope.peer : undefined);
    setText("");
  };
  const dmPeers = [...new Set(getState().chat.filter((m) => m.sc === "d").map((m) => (m.from === me ? m.to! : m.from)))];
  return (
    <section className="panel chat" aria-label={t("chat.title")}>
      <div className="chips">
        <button className={"chip" + (scope.sc === "o" ? " on" : "")} onClick={() => setScope({ sc: "o" })}>{t("chat.office")}</button>
        <button className={"chip" + (scope.sc === "g" ? " on" : "")} onClick={() => setScope({ sc: "g" })}>{t("chat.conversation")}</button>
        {dmPeers.map((id) => (
          <button key={id} className={"chip" + (scope.sc === "d" && scope.peer === id ? " on" : "")} onClick={() => setScope({ sc: "d", peer: id })}>{name(id)}</button>
        ))}
        {scope.sc === "d" && !dmPeers.includes(scope.peer) && <button className="chip on">{name(scope.peer)}</button>}
      </div>
      <div className="msgs" role="log" tabIndex={0} aria-label={t("chat.title")} aria-live="polite">
        {scope.sc === "g" && !conv && <p className="muted">{t("chat.noConv")}</p>}
        {msgs.map((m) => (
          <div key={m.id} className={"msg" + (m.from === me ? " mine" : "")}>
            <b>{m.from === me ? t("media.you") : roster.get(m.from)?.n ?? m.n ?? "?"}</b>
            <span>{m.text}</span>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={send}>
        {/* conversation chat needs a conversation: say so instead of silently dropping the message */}
        <input value={text} maxLength={500} disabled={scope.sc === "g" && !conv} onChange={(e) => setText(e.target.value)} placeholder={scope.sc === "g" && !conv ? t("chat.noConv") : scope.sc === "d" ? t("chat.dmWith", { name: name(scope.peer) }) : t("chat.placeholder")} aria-label={t("chat.placeholder")} />
        <button aria-label={t("chat.send")} disabled={scope.sc === "g" && !conv}><SendIcon /></button>
      </form>
    </section>
  );
}

/** Each running plugin's entry (the sidebar anchor): a button, usually opening the plugin's modal. */
function Plugins() {
  return (
    <section className="panel plugins-panel" aria-label={t("plugins.title")}>
      <h2>{t("plugins.title")}</h2>
      <div className="plugin-buttons"><PluginSlots anchor="sidebar" /></div>
    </section>
  );
}
