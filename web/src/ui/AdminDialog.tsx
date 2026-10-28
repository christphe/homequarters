import { useCallback, useEffect, useState } from "react";
import { toast, useStore } from "../store";
import { hasKey, t, type Key } from "../i18n";
import { Modal } from "./Modal";
import { request as api } from "../net/http";
import { GearIcon, InfoIcon } from "./Icons";

type Tab = "members" | "invites" | "activity" | "announce" | "office" | "plugins";
interface PluginRow { name: string; title: string; version: string; description: string; state: "disabled" | "running" | "crashed" | "broken"; error: string; source: "bundled" | "installed"; refused: boolean; settings?: PluginSetting[]; longDescription?: string; externalHosts?: string[] }
interface PluginSetting { key: string; label: string; min: number; max: number; value: number; help?: string }
interface Member { id: number; name: string; role: "admin" | "member"; joinedAt: number; email?: string }
interface InviteRow { id: number; role: string; maxUses: number; uses: number; expiresAt: number; createdAt: number; createdBy: string; status: string }
interface AuditRow { id: number; actor: string; action: string; target: string; detail: string; at: number }

const when = (sec: number) => new Date(sec * 1000).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });

export function AdminDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("members");
  return (
    <Modal title={t("admin.title")} onClose={onClose} wide>
      <div className="chips" role="tablist" aria-label={t("admin.title")}>
        {(["members", "invites", "activity", "announce", "office", "plugins"] as Tab[]).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={"chip" + (tab === k ? " on" : "")} onClick={() => setTab(k)}>{t(("admin.tab." + k) as Key)}</button>
        ))}
      </div>
      {tab === "members" && <Members />}
      {tab === "invites" && <Invites />}
      {tab === "activity" && <Activity />}
      {tab === "announce" && <Announce />}
      {tab === "office" && <><OfficeName /><Layouts /></>}
      {tab === "plugins" && <Plugins />}
      <div className="modal-actions"><button className="primary" onClick={onClose}>{t("settings.close")}</button></div>
    </Modal>
  );
}

/** A one-line banner for everybody online now. Not stored; the activity log records that it was sent. */
function Announce() {
  const [text, setText] = useState("");
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await api("POST", "/api/admin/announce", { text: text.trim() });
    if (r.ok) { setText(""); toast(t("announce.sent")); } else toast(r.status === 429 ? t("announce.wait") : r.json.error ?? t("admin.error"));
  };
  return (
    <form className="field" onSubmit={send}>
      <label htmlFor="announce-text">{t("announce.label")}</label>
      <textarea id="announce-text" value={text} maxLength={280} rows={3} onChange={(e) => setText(e.target.value)} placeholder={t("announce.placeholder")} />
      <small className="muted">{t("announce.hint")}</small>
      <button className="btn" type="submit" disabled={!text.trim()}>{t("announce.send")}</button>
    </form>
  );
}

/** The office name everybody sees at the top of the screen and in the browser tab. Stored, audited, pushed live. */
function OfficeName() {
  const current = useStore((s) => s.office);
  const [name, setName] = useState(current);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await api<{ name: string }>("PATCH", "/api/admin/office", { name: name.trim() });
    if (r.ok) { setName(r.json.name ?? name.trim()); toast(t("office.renamed")); } else toast(t(r.status === 429 ? "office.wait" : r.status === 400 ? "office.invalid" : "admin.error"));
  };
  return (
    <form className="field" onSubmit={save}>
      <label htmlFor="office-name">{t("office.nameLabel")}</label>
      <input id="office-name" value={name} onChange={(e) => setName(e.target.value)} />
      <small className="muted">{t("office.nameHint")}</small>
      <button className="btn" type="submit" disabled={!name.trim() || [...name.trim()].length > 40 || name.trim() === current}>{t("office.save")}</button>
    </form>
  );
}

interface TemplateRow { id: string; name: string; w: number; h: number; current: boolean; summary: { desks: number; rooms: number; corners: number; offices: number }; carry: { kept: number; lost: number } }

/** The office templates: switching replaces the whole map; desk assignments carry over by desk number. */
function Layouts() {
  const [rows, setRows] = useState<TemplateRow[] | null>(null);
  const [pick, setPick] = useState<TemplateRow | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    void api<{ templates: TemplateRow[] }>("GET", "/api/admin/templates").then((r) => (r.ok ? setRows(r.json.templates) : toast(t("admin.error"))));
  }, []);
  useEffect(load, [load]);
  const apply = async (row: TemplateRow) => {
    setBusy(true);
    const r = await api<{ carry: { kept: number; lost: number } }>("POST", "/api/admin/map/template", { template: row.id });
    setBusy(false);
    setPick(null);
    if (r.ok) { toast(t("layout.applied", { name: row.name })); load(); } else toast(r.status === 429 ? t("layout.wait") : r.json.error ?? t("admin.error"));
  };
  const parts = (s: TemplateRow["summary"]) => [
    t("layout.desks", { n: s.desks }), t("layout.rooms", { n: s.rooms }),
    ...(s.corners ? [t("layout.corners", { n: s.corners })] : []), ...(s.offices ? [t("layout.offices", { n: s.offices })] : []),
  ].join(" · ");
  return (
    <section className="field" aria-labelledby="layout-title">
      <h3 id="layout-title">{t("layout.title")}</h3>
      <small className="muted">{t("layout.hint")}</small>
      {!rows ? <p className="muted">{t("admin.loading")}</p> : (
        <ul className="layouts">
          {rows.map((row) => (
            <li key={row.id} className={"layout" + (row.current ? " current" : "")}>
              <div>
                <strong>{row.name}</strong>{row.current && <span className="in-use"> · {t("layout.current")}</span>}
                <div className="muted">{parts(row.summary)} · {t("layout.size", { w: row.w, h: row.h })}</div>
              </div>
              {/* applying the layout in use again resets every change made to it */}
              <button className="btn" disabled={busy} aria-label={t(row.current ? "layout.resetOf" : "layout.useOf", { name: row.name })} onClick={() => setPick(row)}>{t(row.current ? "layout.reset" : "layout.use")}</button>
            </li>
          ))}
        </ul>
      )}
      {pick && (
        <Modal title={t(pick.current ? "layout.resetTitle" : "layout.confirmTitle", { name: pick.name })} onClose={() => setPick(null)}>
          <p>{t("layout.confirmBody")}</p>
          <p>{pick.carry.lost ? t("layout.carryLost", { kept: pick.carry.kept, lost: pick.carry.lost }) : pick.carry.kept ? t("layout.carry", { kept: pick.carry.kept }) : t("layout.carryNone")}</p>
          <div className="modal-actions">
            <button className="btn" onClick={() => setPick(null)}>{t("media.cancel")}</button>
            <button className="btn danger" disabled={busy} onClick={() => void apply(pick)}>{t(pick.current ? "layout.resetConfirm" : "layout.confirm", { name: pick.name })}</button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function Members() {
  const [rows, setRows] = useState<Member[] | null>(null);
  const [you, setYou] = useState(0);
  const [confirm, setConfirm] = useState(0);
  const signsIn = useStore((s) => s.auth.providers.length > 0);
  const load = useCallback(async () => {
    const r = await api<{ members: Member[]; you: number }>("GET", "/api/admin/members");
    if (r.ok) { setRows(r.json.members); setYou(r.json.you); } else toast(t("admin.error"));
  }, []);
  useEffect(() => { void load(); }, [load]);
  const setRole = async (m: Member, role: string) => {
    const r = await api("PATCH", "/api/admin/members/" + m.id, { role });
    toast(r.ok ? t("admin.roleChanged", { name: m.name }) : r.json.error ?? t("admin.error"));
    void load();
  };
  const remove = async (m: Member) => {
    setConfirm(0);
    const r = await api("DELETE", "/api/admin/members/" + m.id);
    toast(r.ok ? t("admin.removed", { name: m.name }) : r.json.error ?? t("admin.error"));
    void load();
  };
  if (!rows) return <p className="muted" role="status">{t("admin.loading")}</p>;
  return (
    <table className="admin-table">
      <caption className="sr-only">{t("admin.tab.members")}</caption>
      <thead><tr><th scope="col">{t("admin.name")}</th><th scope="col">{t("admin.role")}</th><th scope="col">{t("admin.joined")}</th><th scope="col"><span className="sr-only">{t("admin.actions")}</span></th></tr></thead>
      <tbody>
        {rows.map((m) => (
          <tr key={m.id}>
            <td>{m.name}{m.id === you && <em> ({t("hud.you")})</em>}{signsIn && <small className="muted member-login">{m.email ? t("admin.linked", { email: m.email }) : t("admin.unlinked")}</small>}</td>
            <td>
              <select value={m.role} aria-label={t("admin.roleOf", { name: m.name })} onChange={(e) => void setRole(m, e.target.value)}>
                <option value="member">{t("admin.role.member")}</option>
                <option value="admin">{t("admin.role.admin")}</option>
              </select>
            </td>
            <td>{when(m.joinedAt)}</td>
            <td>
              {m.id !== you && (confirm === m.id ? (
                <span className="inline">
                  <button className="btn danger" onClick={() => void remove(m)}>{t("admin.confirmRemove")}</button>
                  <button className="btn" onClick={() => setConfirm(0)}>{t("media.cancel")}</button>
                </span>
              ) : (
                <button className="btn" aria-label={t("admin.removeOf", { name: m.name })} onClick={() => setConfirm(m.id)}>{t("admin.remove")}</button>
              ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Invites() {
  const [rows, setRows] = useState<InviteRow[] | null>(null);
  const [role, setRole] = useState("member");
  const [uses, setUses] = useState(10);
  const [hours, setHours] = useState(24);
  const [link, setLink] = useState("");
  const load = useCallback(async () => {
    const r = await api<{ invites: InviteRow[] }>("GET", "/api/admin/invites");
    if (r.ok) setRows(r.json.invites); else toast(t("admin.error"));
  }, []);
  useEffect(() => { void load(); }, [load]);
  const create = async () => {
    const r = await api<{ path: string }>("POST", "/api/invites", { role, maxUses: uses, hours });
    if (!r.ok) return toast(r.json.error ?? t("invite.error"));
    setLink(location.origin + r.json.path);
    void load();
  };
  const revoke = async (i: InviteRow) => {
    const r = await api("DELETE", "/api/admin/invites/" + i.id);
    toast(r.ok ? t("admin.revoked") : r.json.error ?? t("admin.error"));
    void load();
  };
  return (
    <>
      <div className="admin-form">
        <label className="field"><span>{t("admin.role")}</span>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="member">{t("admin.role.member")}</option>
            <option value="admin">{t("admin.role.admin")}</option>
          </select>
        </label>
        <label className="field"><span>{t("admin.maxUses")}</span>
          <input type="number" min={1} max={1000} value={uses} onChange={(e) => setUses(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))} />
        </label>
        <label className="field"><span>{t("admin.hours")}</span>
          <input type="number" min={1} max={2160} value={hours} onChange={(e) => setHours(Math.max(1, Math.min(2160, Number(e.target.value) || 1)))} />
        </label>
        <button className="btn" onClick={() => void create()}>{t("invite.create")}</button>
      </div>
      {link && (
        <div className="composer">
          <input readOnly value={link} aria-label={t("invite.title")} onFocus={(e) => e.currentTarget.select()} />
          <button className="btn" onClick={() => { void navigator.clipboard.writeText(link); toast(t("invite.copied")); }}>{t("invite.copy")}</button>
        </div>
      )}
      <small className="muted">{t("admin.inviteHint")}</small>
      {!rows ? <p className="muted" role="status">{t("admin.loading")}</p> : rows.length === 0 ? <p className="muted">{t("admin.noInvites")}</p> : (
        <table className="admin-table">
          <caption className="sr-only">{t("admin.tab.invites")}</caption>
          <thead><tr><th scope="col">{t("admin.role")}</th><th scope="col">{t("admin.uses")}</th><th scope="col">{t("admin.expires")}</th><th scope="col">{t("admin.status")}</th><th scope="col"><span className="sr-only">{t("admin.actions")}</span></th></tr></thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id}>
                <td>{t(("admin.role." + i.role) as Key)}</td>
                <td>{i.uses}/{i.maxUses}</td>
                <td>{when(i.expiresAt)}</td>
                <td>{t(("admin.invite." + i.status) as Key)}</td>
                <td>{i.status === "active" && <button className="btn" aria-label={t("admin.revokeOf", { date: when(i.createdAt) })} onClick={() => void revoke(i)}>{t("admin.revoke")}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Activity() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  useEffect(() => {
    void api<{ entries: AuditRow[] }>("GET", "/api/admin/audit").then((r) => (r.ok ? setRows(r.json.entries) : toast(t("admin.error"))));
  }, []);
  if (!rows) return <p className="muted" role="status">{t("admin.loading")}</p>;
  if (rows.length === 0) return <p className="muted">{t("admin.noActivity")}</p>;
  return (
    <ul className="audit" tabIndex={0} aria-label={t("admin.tab.activity")}>
      {rows.map((e) => {
        const key = "admin.audit." + e.action;
        const text = hasKey(key) ? t(key, { actor: e.actor, target: e.target, detail: e.detail }) : `${e.actor}: ${e.action}`;
        return <li key={e.id}><time>{when(e.at)}</time> {text}</li>;
      })}
    </ul>
  );
}

export function AdminButton({ onOpen }: { onOpen: () => void }) {
  const role = useStore((s) => s.role);
  if (role !== "admin") return null;
  return <button className="btn" onClick={onOpen}>{t("admin.open")}</button>;
}

/** One setting a plugin declares (plugin.json), for the whole office: checked and stored by the server. */
function PluginSettings({ plugin, onClose, onSaved }: { plugin: PluginRow; onClose: () => void; onSaved: () => void }) {
  const settings = plugin.settings ?? [];
  const [text, setText] = useState<Record<string, string>>(() => Object.fromEntries(settings.map((s) => [s.key, String(s.value)])));
  const [busy, setBusy] = useState(false);
  const changed = settings.filter((s) => text[s.key] !== String(s.value));
  // Save sends each changed setting (the server checks it against the plugin's manifest), then closes
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    for (const s of changed) {
      const r = await api<{ settings: Record<string, number> }>("PUT", "/api/admin/plugins/" + encodeURIComponent(plugin.name) + "/settings", { key: s.key, value: Number(text[s.key]) });
      if (!r.ok) {
        setBusy(false);
        onSaved();
        return toast(t("admin.plugins.settings.failed", { name: s.label, error: r.json.error ?? (r.status ? String(r.status) : t("admin.error")) }));
      }
    }
    setBusy(false);
    toast(t("admin.plugins.settings.saved", { name: plugin.title }));
    onSaved();
    onClose();
  };
  return (
    <Modal title={t("admin.plugins.settingsTitle", { name: plugin.title })} onClose={onClose}>
      <form onSubmit={(e) => void save(e)}>
        {settings.map((s) => {
          const help = "help-" + plugin.name + "-" + s.key;
          return (
            <div className="plugin-setting" key={s.key}>
              <label>
                <span>{s.label}</span>
                <input type="number" inputMode="numeric" min={s.min} max={s.max} step={1} value={text[s.key]} required
                  aria-describedby={s.help ? help : undefined} onChange={(e) => { const v = e.currentTarget.value; setText((x) => ({ ...x, [s.key]: v })); }} />
              </label>
              {s.help && <small className="muted plugin-setting-help" id={help}>{s.help}</small>}
            </div>
          );
        })}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>{t("settings.close")}</button>
          <button className="btn primary" disabled={busy || changed.length === 0}>{t("admin.plugins.settings.save")}</button>
        </div>
      </form>
    </Modal>
  );
}

/** The server's plugins (bundled with Home Quarters or installed by its operator) and a switch for each. */
function Plugins() {
  const [rows, setRows] = useState<PluginRow[] | null>(null);
  const [busy, setBusy] = useState("");
  const [settingsOf, setSettingsOf] = useState(""); // the plugin whose settings modal is open
  const [aboutOf, setAboutOf] = useState(""); // the plugin whose About modal is open
  const load = useCallback(async () => {
    const r = await api<PluginRow[]>("GET", "/api/admin/plugins");
    if (r.ok) setRows(r.json); else toast(t("admin.error"));
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 3000); // a plugin can stop by itself while the tab is open
    return () => window.clearInterval(timer);
  }, [load]);
  const set = async (p: PluginRow, enabled: boolean) => {
    setBusy(p.name);
    const r = await api<{ state: string }>("PUT", "/api/admin/plugins/" + encodeURIComponent(p.name), { enabled });
    setBusy("");
    if (r.ok) toast(t(enabled ? "admin.plugins.enabled" : "admin.plugins.disabled", { name: p.title }));
    else toast(t("admin.plugins.failed", { name: p.title, error: r.json.error ?? (r.status ? String(r.status) : t("admin.error")) }));
    void load();
  };
  if (!rows) return <p className="muted" role="status">{t("admin.loading")}</p>;
  if (rows.length === 0) return <p className="muted">{t("admin.plugins.none")}</p>;
  const open = rows.find((p) => p.name === settingsOf && !p.refused && p.settings?.length);
  const about = rows.find((p) => p.source + "/" + p.name === aboutOf && p.longDescription);
  return (
    <>
    <table className="admin-table plugins-table">
      <caption className="sr-only">{t("admin.tab.plugins")}</caption>
      <thead><tr><th scope="col">{t("admin.plugins.plugin")}</th><th scope="col">{t("admin.plugins.state")}</th><th scope="col"><span className="sr-only">{t("admin.actions")}</span></th></tr></thead>
      <tbody>
        {rows.map((p) => {
          const on = p.state === "running";
          return (
            <tr key={p.source + "/" + p.name} data-plugin={p.name} data-source={p.source}>
              <td>{p.title} <small className="muted">{p.version}</small> <span className={"plugin-source " + p.source}>{t(("admin.plugins.source." + p.source) as Key)}</span>{p.description && <small className="muted plugin-desc">{p.description}</small>}
                {!!p.externalHosts?.length && <small className="muted plugin-desc plugin-hosts">{t("admin.plugins.hosts", { hosts: p.externalHosts.join(", ") })}</small>}</td>
              <td>{t(("admin.plugins.state." + p.state) as Key)}{p.error && <small className="muted plugin-error">{p.error}</small>}</td>
              <td className="nowrap"><span className="plugin-actions">
                {!!p.longDescription && (
                  <button className="btn plugin-gear" aria-label={t("admin.plugins.aboutOf", { name: p.title })} title={t("admin.plugins.aboutOf", { name: p.title })} onClick={() => setAboutOf(p.source + "/" + p.name)}>
                    <InfoIcon />
                  </button>
                )}
                {!p.refused && !!p.settings?.length && (
                  <button className="btn plugin-gear" aria-label={t("admin.plugins.settingsOf", { name: p.title })} title={t("admin.plugins.settingsOf", { name: p.title })} onClick={() => setSettingsOf(p.name)}>
                    <GearIcon />
                  </button>
                )}
                {p.state !== "broken" && (
                  <button className={"btn" + (on ? "" : " primary")} disabled={busy === p.name} aria-label={t(on ? "admin.plugins.disableOf" : "admin.plugins.enableOf", { name: p.title })} onClick={() => void set(p, !on)}>
                    {t(on ? "admin.plugins.disable" : "admin.plugins.enable")}
                  </button>
                )}
              </span></td>
            </tr>
          );
        })}
      </tbody>
    </table>
    {about && (
      <Modal title={about.title} onClose={() => setAboutOf("")}>
        {about.longDescription!.split(/\n\s*\n/).map((para, i) => <p key={i}>{para}</p>)}
        <div className="modal-actions">
          <button className="btn" onClick={() => setAboutOf("")}>{t("settings.close")}</button>
        </div>
      </Modal>
    )}
    {open && <PluginSettings plugin={open} onClose={() => setSettingsOf("")} onSaved={() => void load()} />}
    </>
  );
}
