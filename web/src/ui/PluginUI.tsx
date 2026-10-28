import { useCallback, useEffect, useRef, useState } from "react";
import { session } from "../session";
import { toast, useStore, type PluginSlot } from "../store";
import { t } from "../i18n";
import { Modal } from "./Modal";
import { request } from "../net/http";
import { PluginViewFrame } from "./PluginViewFrame";
import type { Anchor, SpriteSpec, UINode } from "../plugins/commands";

// What plugins show, drawn by Home Quarters: buttons at anchors, boxes on the map, one modal. Plugin code
// never runs here; it sent a tree (src/plugins/commands.ts) and gets callback ids back on clicks, with
// the new value for a colour or number field.
// Labels and texts come from the plugin as plain text (they do not go through the dictionary).

const run = (plugin: string, callback: string | undefined, value?: string | number) => session.plugins?.event(plugin, callback, value);

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
            return (
              <button key={i} className={"btn" + (n.primary ? " primary" : "") + (n.pressed ? " on" : "") + (n.sprite ? " with-sprite" : "")} aria-pressed={n.pressed} disabled={n.disabled} onClick={() => run(plugin, n.click)}>
                {n.sprite && <SpriteView spec={n.sprite} base={base} plugin={plugin} />}
                {n.label}
              </button>
            );
          case "sprite":
            return <SpriteView key={i} spec={n.sprite} base={base} alt={n.alt} plugin={plugin} />;
          case "copy":
            return <CopyField key={i} label={n.label} value={n.value} />;
          case "image":
            return <img key={i} src={base + n.src} alt={n.alt} className="plugin-image" />;
          case "row":
            return <div key={i} className="plugin-row"><Nodes nodes={n.children} plugin={plugin} base={base} /></div>;
          case "appToken":
            return <AppTokenField key={i} plugin={plugin} />;
          case "color":
            // keyed by place, not value: the plugin redrawing its modal must not close an open picker
            return <ColorField key={i} label={n.label} hideLabel={n.hideLabel} value={n.value} onCommit={(v) => run(plugin, n.change, v)} />;
          case "field":
            return <TextField key={i} node={n} onCommit={(v) => run(plugin, n.change, v)} />;
          case "number":
            return <NumberField key={i + ":" + n.value} node={n} onCommit={(v) => run(plugin, n.change, v)} />;
          case "view":
            // keyed by plugin and view, not place: redrawing the modal keeps the iframe and its state
            return <PluginViewFrame key={"view:" + plugin + "/" + n.view} plugin={plugin} node={n} />;
        }
        return null;
      })}
    </>
  );
}

/** A colour picker. The plugin hears the colour once it is chosen (the native change event), not every
 * shade the pointer crosses while dragging, so a picker cannot flood the plugin's server. */
const COLOR_EVERY = 250; // ms: a colour being chosen reaches the plugin at most 4 times a second

function ColorField({ label, hideLabel, value, onCommit }: { label: string; hideLabel?: boolean; value: string; onCommit: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  const sent = useRef(value);
  // the plugin's new value, unless the person is choosing one right now
  useEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el) el.value = value;
    sent.current = value;
  }, [value]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let last = 0, timer = 0;
    const send = () => {
      timer = 0;
      last = performance.now();
      const v = el.value.toLowerCase();
      if (v === sent.current) return;
      sent.current = v;
      commit.current(v);
    };
    // while choosing (input), at most every COLOR_EVERY ms and always the last colour; once chosen (change), at once
    const input = () => {
      if (timer) return;
      const wait = Math.max(0, COLOR_EVERY - (performance.now() - last));
      timer = window.setTimeout(send, wait);
    };
    const change = () => {
      if (timer) window.clearTimeout(timer);
      send();
    };
    el.addEventListener("input", input);
    el.addEventListener("change", change);
    return () => {
      if (timer) window.clearTimeout(timer);
      el.removeEventListener("input", input);
      el.removeEventListener("change", change);
    };
  }, []);
  return (
    <label className="plugin-field">
      <span className={hideLabel ? "sr-only" : undefined}>{label}</span>
      <input ref={ref} type="color" defaultValue={value} />
    </label>
  );
}

// sheets loaded for plugin UI, by URL: a modal redrawn on every change does not fetch them again
const sheets = new Map<string, Promise<HTMLImageElement | ImageBitmap>>();
function sheet(src: string): Promise<HTMLImageElement | ImageBitmap> {
  let p: Promise<HTMLImageElement | ImageBitmap> | undefined = sheets.get(src);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
    sheets.set(src, p);
  }
  return p;
}

/** One cell of a plugin's sheet, scaled with crisp pixels; a tint multiplies its colours, as on the map. */
function SpriteView({ spec, base, alt, plugin }: { spec: SpriteSpec; base: string; alt?: string; plugin: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [x, y, w, h] = spec.frame;
  useEffect(() => {
    let live = true;
    // a sheet the plugin loaded (maybe from image data) may still be decoding: wait for it a little
    const loaded = (key: string) => new Promise<ImageBitmap>((resolve, reject) => {
      let tries = 0;
      const look = () => {
        const b = session.plugins?.sheetImage(plugin, key);
        if (b) resolve(b);
        else if (++tries > 50 || !live) reject(new Error("no such sheet"));
        else window.setTimeout(look, 100);
      };
      look();
    });
    (spec.sheet ? loaded(spec.sheet) : sheet(base + spec.src)).then((img) => {
      const c = ref.current;
      if (!live || !c) return;
      const ctx = c.getContext("2d")!;
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
      if (spec.tint) {
        ctx.globalCompositeOperation = "multiply";
        ctx.fillStyle = spec.tint;
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = "destination-in"; // keep the sprite's own shape
        ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
      }
    }, () => {});
    return () => { live = false; };
  }, [base, plugin, spec.src, spec.sheet, spec.tint, x, y, w, h]);
  return <canvas ref={ref} width={w} height={h} className="pixel plugin-sprite" role={alt ? "img" : undefined} aria-label={alt} aria-hidden={alt ? undefined : true}
    style={{ width: w * spec.scale, height: h * spec.scale }} />;
}

/** One line of text, sent when it is committed (Enter, leaving the field) and only if it changed. */
function TextField({ node, onCommit }: { node: Extract<UINode, { type: "field" }>; onCommit: (v: string) => void }) {
  const [text, setText] = useState(node.value);
  const sent = useRef(node.value);
  const ref = useRef<HTMLInputElement>(null);
  // the plugin's new value, unless the person is typing in the field
  useEffect(() => {
    sent.current = node.value;
    if (document.activeElement !== ref.current) setText(node.value);
  }, [node.value]);
  const commit = () => {
    if (text === sent.current) return;
    sent.current = text;
    onCommit(text);
  };
  return (
    <label className="plugin-field">
      <span className={node.hideLabel ? "sr-only" : undefined}>{node.label}</span>
      <input ref={ref} type="text" value={text} maxLength={node.maxLength} placeholder={node.placeholder}
        onChange={(e) => setText(e.currentTarget.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); }} />
    </label>
  );
}

/** A whole number between min and max, sent when it is committed (Enter, leaving the field). */
function NumberField({ node, onCommit }: { node: Extract<UINode, { type: "number" }>; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(node.value));
  const sent = useRef(node.value);
  const commit = () => {
    const v = Math.round(Number(text));
    if (text.trim() === "" || !Number.isFinite(v)) return setText(String(node.value));
    const c = Math.min(node.max, Math.max(node.min, v));
    setText(String(c));
    if (c === sent.current) return;
    sent.current = c;
    onCommit(c);
  };
  return (
    <label className="plugin-field">
      <span>{node.label}</span>
      <input type="number" inputMode="numeric" min={node.min} max={node.max} step={1} value={text}
        onChange={(e) => setText(e.currentTarget.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); }} />
    </label>
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
    const r = await request<{ exists: boolean; createdAt: number }>("GET", path);
    if (r.ok) setInfo(r.json);
  }, [path]);
  useEffect(() => { void load(); }, [load]);
  const create = async () => {
    const r = await request<{ token: string }>("POST", path);
    if (!r.ok) return toast(t("plugins.token.error"));
    setFresh(r.json.token);
    void load();
  };
  const revoke = async () => {
    const r = await request("DELETE", path);
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
