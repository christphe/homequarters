import { useEffect, useRef, useState } from "react";
import { session } from "../session";
import { cloneMap, computeSolid, propSize, PROP_TYPES, toWire } from "../game/mapModel";
import { eraseAt, isPluginProp } from "../game/props";
import type { MapData, PluginObjectSpec } from "../net/protocol";
import { toast, useStore } from "../store";
import { t } from "../i18n";
import { request } from "../net/http";

type Tool = "wall" | "prop" | "erase" | "room" | "unroom" | "desk" | "content";
const INTERACTIVE = ["note", "embed", "image", "portal", "whiteboard", "spotlight"];

export function MapEditor({ onClose }: { onClose: () => void }) {
  const roster = useStore((s) => s.roster);
  const pluginObjects = useStore((s) => s.pluginObjects);
  const [tool, setTool] = useState<Tool>("wall");
  const [propType, setPropType] = useState("plant");
  const [assignTo, setAssignTo] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [ready, setReady] = useState(false);
  const [content, setContent] = useState<{ index: number; label: string; data: string; toX: number; toY: number } | null>(null);
  const [portalX, setPortalX] = useState(9);
  const [portalY, setPortalY] = useState(7);
  const [pending, setPending] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [roomName, setRoomName] = useState("");
  const [access, setAccess] = useState("open");
  const draft = useRef<MapData | null>(null);
  const original = useRef<MapData | null>(null);
  const drag = useRef<{ x: number; y: number; paint?: boolean } | null>(null);
  const layer = useRef<HTMLDivElement>(null);

  /** The running plugin's object chosen, or undefined (a built-in kind, or its plugin stopped meanwhile). */
  const chosenSpec = isPluginProp(propType) ? pluginObjects.specs.find((o) => o.plugin + "/" + o.kind === propType) : undefined;

  useEffect(() => {
    session.view?.setEditing(true); // objects of plugins not running show as placeholders
    return () => session.view?.setEditing(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const m = session.view?.currentMap();
    if (m) {
      original.current = cloneMap(m);
      void request<MapData>("GET", "/api/admin/map").then((r) => {
        if (cancelled) return;
        if (!r.ok) return toast(t("editor.loadError"));
        draft.current = { ...cloneMap(m), ...r.json, tile: 16, solid: m.solid };
        setReady(true);
      });
    }
    return () => {
      cancelled = true;
      session.view?.setHover(null);
      if (original.current) session.view?.previewMap(original.current); // discard unsaved edits
    };
  }, []);

  const apply = () => {
    const d = draft.current!;
    d.solid = computeSolid(d);
    session.view?.previewMap(d);
    setDirty(true);
  };

  const pickContent = (index: number) => {
    const p = draft.current?.props[index];
    if (!p || !INTERACTIVE.includes(p.t)) { setContent(null); return; }
    setContent({ index, label: p.label ?? "", data: p.data ?? "", toX: p.to?.x ?? 9, toY: p.to?.y ?? 7 });
  };

  const tileAt = (e: React.PointerEvent) => session.view!.screenToTile(e.clientX, e.clientY);

  const down = (e: React.PointerEvent) => {
    const d = draft.current;
    if (!d || !session.view) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const [x, y] = tileAt(e);
    if (x < 0 || y < 0 || x >= d.w || y >= d.h) return;
    if (tool === "wall") {
      const on = d.walls[y][x] !== "#";
      drag.current = { x, y, paint: on };
      setWall(x, y, on);
    } else if (tool === "prop") {
      if (isPluginProp(propType) && !chosenSpec) return; // its plugin stopped meanwhile
      if (!d.props.some((p) => p.t === propType && p.x === x && p.y === y)) {
        // a plugin object's size is written in the map, from its manifest
        const size = chosenSpec ? { w: chosenSpec.size[0], h: chosenSpec.size[1] } : {};
        d.props.push({ t: propType, x, y, ...size, ...(propType === "portal" ? { to: { x: portalX, y: portalY } } : {}) });
        apply();
      }
    } else if (tool === "erase") {
      if (eraseAt(d.props, x, y)) apply(); // a desk's pcs go before it
    } else if (tool === "room") {
      drag.current = { x, y };
      setPending({ x, y, w: 1, h: 1 });
    } else if (tool === "unroom") {
      const i = d.areas.findIndex((a) => a.kind === "room" && !a.auto && x >= a.x && x < a.x + a.w && y >= a.y && y < a.y + a.h);
      if (i >= 0) {
        d.areas.splice(i, 1);
        apply();
      }
    } else if (tool === "content") {
      const index = d.props.findIndex((p) => {
        const [w, h] = propSize(p);
        return ["note", "embed", "image", "portal", "whiteboard", "spotlight"].includes(p.t) && x >= p.x && x < p.x + w && y >= p.y && y < p.y + h;
      });
      if (index >= 0) pickContent(index);
    } else if (tool === "desk") {
      const p = d.props.find((q) => {
        if (q.t !== "desk") return false;
        const [w, h] = propSize(q);
        return x >= q.x && x < q.x + w && y >= q.y && y < q.y + h;
      });
      // elsewhere inside a private office: assign it (or free it with Nobody). Only the owner's id is
      // stored; the office and the desk show their owner's current name (game/places.ts).
      const office = p ? undefined : d.areas.find((a) => a.kind === "room" && a.access.mode === "office" && x >= a.x && x < a.x + a.w && y >= a.y && y < a.y + a.h);
      if (office) {
        if (assignTo) freePlaces(d, assignTo); // one desk or office per person: the previous one is freed
        office.access = { mode: "office", users: assignTo ? [assignTo] : [] };
        apply();
        return;
      }
      if (p && assignTo) {
        freePlaces(d, assignTo); // one desk or office per person: the previous one is freed
        p.assign = assignTo;
        apply();
      } else if (p?.assign) { // Nobody frees the desk (and the server drops its room)
        delete p.assign;
        apply();
      }
    }
  };

  const setWall = (x: number, y: number, on: boolean) => {
    const d = draft.current!;
    const row = d.walls[y];
    if (on === (row[x] === "#")) return;
    d.walls[y] = row.slice(0, x) + (on ? "#" : ".") + row.slice(x + 1);
    apply();
  };

  const move = (e: React.PointerEvent) => {
    const d = draft.current;
    if (!d || !session.view) return;
    const [x, y] = tileAt(e);
    if (tool === "prop") {
      const [w, h] = chosenSpec ? chosenSpec.size : propSize({ t: propType, x, y });
      session.view.setHover({ x, y, w, h });
    } else if (tool === "room" && drag.current) {
      const x0 = Math.min(drag.current.x, x), y0 = Math.min(drag.current.y, y);
      const r = { x: x0, y: y0, w: Math.abs(x - drag.current.x) + 1, h: Math.abs(y - drag.current.y) + 1 };
      setPending(r);
      session.view.setHover(r);
    } else {
      session.view.setHover({ x, y, w: 1, h: 1 });
    }
    if (tool === "wall" && drag.current?.paint !== undefined && x >= 0 && y >= 0 && x < d.w && y < d.h) setWall(x, y, drag.current.paint);
  };

  const up = () => {
    if (tool === "wall") drag.current = null;
    if (tool === "room") drag.current = null;
  };

  const createRoom = () => {
    const d = draft.current;
    if (!d || !pending || !roomName.trim()) return;
    const base = roomName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "room";
    let id = base, n = 2;
    while (d.areas.some((a) => a.id === id)) id = `${base}-${n++}`;
    d.areas.push({ id, name: roomName.trim().slice(0, 60), kind: "room", ...pending, floor: "carpet_teal", access: { mode: access }, capacity: 20 });
    setPending(null);
    setRoomName("");
    session.view?.setHover(null);
    apply();
  };

  const save = async () => {
    const d = draft.current!;
    const r = await request("PUT", "/api/map", toWire(d));
    if (!r.ok) {
      toast(r.status ? `${t("editor.saveError")}: ${r.json.error ?? r.status}` : t("editor.saveError"));
      return;
    }
    original.current = cloneMap(d); // now the saved version
    setDirty(false);
    toast(t("editor.saved"));
  };

  return (
    <>
      <div className="editor-layer" ref={layer} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={() => session.view?.setHover(null)} />
      <aside className="editor" aria-label={t("editor.title")}>
        <h3>{t("editor.title")}</h3>
        <div className="chips">
          {(["wall", "prop", "erase", "room", "unroom", "desk", "content"] as Tool[]).map((k) => (
            <button key={k} className={"chip" + (tool === k ? " on" : "")} onClick={() => { setTool(k); setPending(null); }}>{t(`editor.tool.${k}` as never)}</button>
          ))}
        </div>
        {tool === "prop" && (
          <label className="field"><span>{t("editor.object")}</span>
            <select value={propType} onChange={(e) => setPropType(e.target.value)}>
              <optgroup label={t("editor.group.builtin")}>
                {PROP_TYPES.map((p) => <option key={p.t} value={p.t}>{p.label}</option>)}
              </optgroup>
              {Object.entries(pluginObjects.titles).map(([plugin, title]) => (
                <optgroup key={plugin} label={t("editor.group.plugin", { title })}>
                  {pluginObjects.specs.filter((o) => o.plugin === plugin).map((o) => <option key={o.kind} value={plugin + "/" + o.kind}>{o.label}</option>)}
                </optgroup>
              ))}
            </select>
            {chosenSpec && <ObjectIcon spec={chosenSpec} />}
          </label>
        )}
        {tool === "prop" && propType === "portal" && <>
          <label className="field"><span>{t("editor.portalX")}</span><input type="number" value={portalX} min={0} max={(draft.current?.w ?? 60) - 1} onChange={(e) => setPortalX(Number(e.target.value))} /></label>
          <label className="field"><span>{t("editor.portalY")}</span><input type="number" value={portalY} min={0} max={(draft.current?.h ?? 36) - 1} onChange={(e) => setPortalY(Number(e.target.value))} /></label>
        </>}
        {tool === "content" && <div className="field">
          <span>{t("editor.contentHint")}</span>
          {ready && <select aria-label={t("editor.objectPick")} value={content?.index ?? -1} onChange={(e) => pickContent(Number(e.target.value))}>
            <option value={-1}>—</option>
            {draft.current!.props.map((p, i) => INTERACTIVE.includes(p.t) ? <option key={i} value={i}>{(p.label || t(("prop." + p.t) as never)) + " (" + p.x + ", " + p.y + ")"}</option> : null)}
          </select>}
          {content && <>
            <label className="field"><span>{t("editor.objectLabel")}</span><input maxLength={40} value={content.label} onChange={(e) => setContent({ ...content, label: e.target.value })} /></label>
            {["note", "embed", "image"].includes(draft.current!.props[content.index].t) && <label className="field"><span>{t("editor.objectData")}</span><textarea maxLength={draft.current!.props[content.index].t === "note" ? 500 : 300} value={content.data} onChange={(e) => setContent({ ...content, data: e.target.value })} /></label>}
            {draft.current!.props[content.index].t === "portal" && <>
              <label className="field"><span>{t("editor.portalX")}</span><input type="number" value={content.toX} onChange={(e) => setContent({ ...content, toX: Number(e.target.value) })} /></label>
              <label className="field"><span>{t("editor.portalY")}</span><input type="number" value={content.toY} onChange={(e) => setContent({ ...content, toY: Number(e.target.value) })} /></label>
            </>}
            <button className="btn" onClick={() => {
              const p = draft.current!.props[content.index]; p.label = content.label;
              if (["note", "embed", "image"].includes(p.t)) p.data = content.data;
              if (p.t === "portal") p.to = { x: content.toX, y: content.toY };
              apply();
            }}>{t("editor.applyContent")}</button>
          </>}
        </div>}
        {tool === "desk" && (
          <label className="field"><span>{t("editor.assign")}</span>
            <small className="muted">{t("editor.assignHint")}</small>
            <select value={assignTo} onChange={(e) => setAssignTo(Number(e.target.value))}>
              <option value={0}>{t("editor.nobody")}</option>
              {[...roster.values()].map((p) => <option key={p.id} value={p.id}>{p.n}</option>)}
            </select>
          </label>
        )}
        {tool === "room" && (
          <div className="field">
            <span>{t("editor.roomHint")}</span>
            {pending && (
              <>
                <input placeholder={t("editor.roomName")} maxLength={60} value={roomName} onChange={(e) => setRoomName(e.target.value)} />
                <select value={access} onChange={(e) => setAccess(e.target.value)} aria-label={t("editor.access")}>
                  <option value="open">{t("editor.access.open")}</option>
                  <option value="members">{t("editor.access.members")}</option>
                  <option value="admins">{t("editor.access.admins")}</option>
                </select>
                <button className="btn" onClick={createRoom} disabled={!roomName.trim()}>{t("editor.createRoom")}</button>
              </>
            )}
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>{t("editor.close")}</button>
          <button className="primary" onClick={save} disabled={!dirty || !ready}>{t("editor.save")}</button>
        </div>
      </aside>
    </>
  );
}

/** A plugin object's picture (its frame) beside the object list, enlarged by a whole factor to about 48 px. */
function ObjectIcon({ spec }: { spec: PluginObjectSpec }) {
  if (!spec.sprite) return null; // the plugin draws it on the map: no picture to show
  const url = `/plugins/${spec.plugin}/assets/${spec.sprite}`;
  if (!spec.frame) return <img className="editor-object-icon" src={url} alt="" />;
  const [x, y, w, h] = spec.frame;
  const zoom = Math.max(1, Math.floor(48 / Math.max(w, h)));
  return <span className="editor-object-icon" aria-hidden="true" style={{ width: w, height: h, zoom, backgroundImage: `url("${url}")`, backgroundPosition: `${-x}px ${-y}px` }} />;
}

/** Frees whatever desk or private office a person had in the draft (the server allows one per person). */
function freePlaces(d: MapData, uid: number) {
  for (const p of d.props) {
    if (p.t === "desk" && p.assign === uid) delete p.assign;
  }
  for (const a of d.areas) {
    if (a.kind === "room" && a.access.mode === "office" && a.access.users?.includes(uid)) {
      a.access = { mode: "office", users: a.access.users.filter((u) => u !== uid) };
    }
  }
}
