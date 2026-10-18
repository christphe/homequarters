import { useCallback, useEffect, useState } from "react";
import { session } from "../session";
import { toast, useStore, type PluginSlot } from "../store";
import { t } from "../i18n";
import { Modal } from "./Modal";
import type { Anchor, UINode } from "../plugins/commands";

// What plugins show, drawn by Home Quarters: buttons at anchors, boxes on the map, one modal. Plugin code
// never runs here; it sent a tree (src/plugins/commands.ts) and gets callback ids back on clicks.
// Labels and texts come from the plugin as plain text (they do not go through the dictionary).

const run = (plugin: string, callback: string | undefined) => session.plugins?.event(plugin, callback);

/** The plugins' buttons at one anchor. */
export function PluginSlots({ anchor, className = "btn" }: { anchor: Exclude<Anchor, "screen">; className?: string }) {
  const all = useStore((s) => s.pluginUI.slots); // select the array, filter outside: a new array per call would loop
  const slots = all.filter((s) => s.anchor === anchor);
  if (slots.length === 0) return null;
  return (
    <>
      {slots.map((s) => (
        <SlotButton key={s.plugin + "/" + s.id} slot={s} className={className} />
      ))}
    </>
  );
}

function SlotButton({ slot, className }: { slot: PluginSlot; className: string }) {
  const label = slot.label ?? slot.title;
  return (
    <button className={className + " plugin-slot" + (slot.pressed ? " on" : "")} data-plugin={slot.plugin} data-slot={slot.id}
      aria-label={slot.icon ? label : undefined} title={label} aria-pressed={slot.pressed}
      onClick={() => run(slot.plugin, slot.click)}>
      {slot.icon ? <img src={slot.base + slot.icon} alt="" className="plugin-icon" /> : label}
    </button>
  );
}

/** Boxes plugins put on the map (the screen anchor). */
export function PluginScreens() {
  const all = useStore((s) => s.pluginUI.slots);
  const slots = all.filter((s) => s.anchor === "screen");
  return (
    <>
      {slots.map((s) => {
        const [v, h] = (s.corner ?? "top-left").split("-");
        return (
          <section key={s.plugin + "/" + s.id} className={"plugin-screen " + (s.corner ?? "top-left")} data-plugin={s.plugin} data-slot={s.id}
            aria-label={s.title} style={{ [v]: s.dy ?? 0, [h]: s.dx ?? 0 }}>
            <Nodes nodes={s.content ?? []} plugin={s.plugin} base={s.base} />
          </section>
        );
      })}
    </>
  );
}

/** The open plugin modal, if any. */
export function PluginModalView() {
  const m = useStore((s) => s.pluginUI.modal);
  if (!m) return null;
  const close = () => session.plugins?.closeModal();
  return (
    <Modal key={m.plugin} title={m.title} onClose={close} className={"plugin-modal size-" + m.size + " place-" + m.place}>
      <div className="plugin-body" data-plugin={m.plugin}>
        <Nodes nodes={m.content} plugin={m.plugin} base={m.base} />
      </div>
      <div className="modal-actions"><button className="primary" onClick={close}>{t("settings.close")}</button></div>
    </Modal>
  );
}

function Nodes({ nodes, plugin, base }: { nodes: UINode[]; plugin: string; base: string }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.type) {
          case "text":
            return <p key={i} className={n.muted ? "muted" : undefined}>{n.text}</p>;
          case "button":
            return <button key={i} className={"btn" + (n.primary ? " primary" : "") + (n.pressed ? " on" : "")} aria-pressed={n.pressed} onClick={() => run(plugin, n.click)}>{n.label}</button>;
          case "copy":
            return <CopyField key={i} label={n.label} value={n.value} />;
          case "image":
            return <img key={i} src={base + n.src} alt={n.alt} className="plugin-image" />;
          case "row":
            return <div key={i} className="plugin-row"><Nodes nodes={n.children} plugin={plugin} base={base} /></div>;
          case "appToken":
            return <AppTokenField key={i} plugin={plugin} />;
        }
        return null;
      })}
    </>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast(t("plugins.copied"));
    } catch {
      toast(t("plugins.copyFailed"));
    }
  };
  return (
    <label className="copy-field">
      <span>{label}</span>
      <span className="copy-row">
        <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="btn" onClick={() => void copy()}>{t("plugins.copy")}</button>
      </span>
    </label>
  );
}

/** Home Quarters' widget for a member's app token for one plugin: the secret never reaches the plugin. */
function AppTokenField({ plugin }: { plugin: string }) {
  const [info, setInfo] = useState<{ exists: boolean; createdAt: number } | null>(null);
  const [fresh, setFresh] = useState("");
  const path = "/api/plugins/" + encodeURIComponent(plugin) + "/token";
  const load = useCallback(async () => {
    const r = await fetch(path);
    if (r.ok) setInfo(await r.json());
  }, [path]);
  useEffect(() => { void load(); }, [load]);
  const create = async () => {
    const r = await fetch(path, { method: "POST" });
    if (!r.ok) return toast(t("plugins.token.error"));
    setFresh(((await r.json()) as { token: string }).token);
    void load();
  };
  const revoke = async () => {
    const r = await fetch(path, { method: "DELETE" });
    if (!r.ok) return toast(t("plugins.token.error"));
    setFresh("");
    toast(t("plugins.token.revoked"));
    void load();
  };
  if (!info) return <p className="muted" role="status">{t("admin.loading")}</p>;
  return (
    <div className="app-token">
      {fresh ? (
        <>
          <CopyField label={t("plugins.token.label")} value={fresh} />
          <p className="muted">{t("plugins.token.once")}</p>
        </>
      ) : (
        <p className="muted">{info.exists ? t("plugins.token.created", { date: new Date(info.createdAt * 1000).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" }) }) : t("plugins.token.none")}</p>
      )}
      <div className="plugin-row">
        <button className="btn primary" onClick={() => void create()}>{info.exists ? t("plugins.token.replace") : t("plugins.token.create")}</button>
        {info.exists && <button className="btn danger" onClick={() => void revoke()}>{t("plugins.token.revoke")}</button>}
      </div>
    </div>
  );
}
