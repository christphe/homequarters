import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { session } from "../session";
import { setState, useStore } from "../store";
import { t, type Key } from "../i18n";
import { EMOTES } from "../game/emotes";
import { Modal } from "./Modal";
import { isOwnedOffice, type Prop } from "../net/protocol";
import { claimableDesk } from "../game/home";
import { combo } from "../keys";

/** Low-rate UI state only: avatar reactions themselves are drawn by Pixi, not React. */
export function SocialControls() {
  const nearby = useStore((s) => s.nearby);
  const following = useStore((s) => s.following);
  const request = useStore((s) => s.leadRequest);
  const knock = useStore((s) => s.knock);
  const locked = useStore((s) => s.locked);
  const denied = useStore((s) => s.denied);
  const here = useStore((s) => s.areaIndex);
  const running = useStore((s) => s.running);
  const wave = useStore((s) => s.wave);
  const handUp = useStore((s) => s.roster.get(s.meId)?.h === 1);
  // Phones: the reactions collapse into one button so they never cover the map or the chat panel.
  const [compact, setCompact] = useState(() => window.matchMedia?.("(max-width: 700px)").matches ?? false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.("(max-width: 700px)");
    const on = () => setCompact(mq.matches);
    mq?.addEventListener("change", on);
    return () => mq?.removeEventListener("change", on);
  }, []);
  // Wide screens: the reactions sit on the top bar's row, centred (OfficeScreen leaves a slot for
  // them); from 1320px they clear an admin's buttons on the right. The other controls (Lock desk,
  // knock, wave...) stay where they were.
  const [wide, setWide] = useState(() => window.matchMedia?.("(min-width: 1320px)").matches ?? false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSlot(document.getElementById("topbar-reactions"));
    const mq = window.matchMedia?.("(min-width: 1320px)");
    const on = () => setWide(mq.matches);
    mq?.addEventListener("change", on);
    return () => mq?.removeEventListener("change", on);
  }, []);
  const barUp = wide && !compact && !!slot;
  const done = () => { if (compact) setOpen(false); };
  useEffect(() => {
    if (!wave) return;
    const timer = window.setTimeout(() => setState({ wave: null }), 20000);
    return () => clearTimeout(timer);
  }, [wave]);
  const [knockArea, setKnockArea] = useState<{ index: number; name: string } | null>(null);
  const meId = useStore((s) => s.meId);
  const role = useStore((s) => s.role);
  useEffect(() => {
    const update = () => {
      const map = session.view?.currentMap(), p = session.view?.position();
      if (!map || !p) return;
      const target = map.areas.map((a, index) => ({ ...a, index })).find((a) => {
        // only a door the server keeps me out of: not one I locked myself, was let in, or own
        if (!denied.includes(a.index) || a.index === here) return false;
        return Math.hypot(Math.max(a.x * 16 - p.x, 0, p.x - (a.x + a.w) * 16), Math.max(a.y * 16 - p.y, 0, p.y - (a.y + a.h) * 16)) <= 40;
      });
      setKnockArea((old) => old?.index === target?.index ? old : target ? { index: target.index, name: target.name } : null);
    };
    update();
    const timer = window.setInterval(update, 300);
    return () => clearInterval(timer);
  }, [denied, here]);
  // a free desk I stand next to, while I have no place of my own
  const [desk, setDesk] = useState<Prop | null>(null);
  const [confirmDesk, setConfirmDesk] = useState<Prop | null>(null);
  const [claiming, setClaiming] = useState(false);
  useEffect(() => {
    const update = () => {
      const map = session.view?.currentMap(), p = session.view?.position();
      const next = map && p ? claimableDesk(map, meId, p.x, p.y) : null;
      setDesk((old) => (old?.x === next?.x && old?.y === next?.y ? old : next));
    };
    update();
    const timer = window.setInterval(update, 300);
    return () => clearInterval(timer);
  }, [meId]);
  const claim = async (d: Prop) => {
    setClaiming(true);
    if (await session.claimDesk(d)) setDesk(null); // do not wait for the next poll to hide it
    setClaiming(false);
    setConfirmDesk(null);
  };
  const map = session.view?.currentMap();
  const room = map && here >= 0 && map.areas[here]?.kind === "room" ? map.areas[here] : null;
  const roomIndex = room ? here : -1;
  // an assigned office is always closed to strangers: there is nothing to lock or unlock; a desk is
  // locked by its owner (or an admin)
  const lockable = !!room && !isOwnedOffice(room) && (!room.auto || role === "admin" || !!room.access.users?.includes(meId));
  // my own desk: its room is the desk and the rows in front of it, starting at the desk's tile
  const myDesk = room?.auto && room.access.users?.includes(meId) ? map?.props.find((p) => p.t === "desk" && p.x === room.x && p.y === room.y) ?? null : null;
  const [confirmRelease, setConfirmRelease] = useState<Prop | null>(null);
  const release = async (d: Prop) => {
    setClaiming(true);
    await session.releaseDesk(d);
    setClaiming(false);
    setConfirmRelease(null);
  };
  const lockKey = (on: boolean): Key => (room?.auto ? (on ? "door.unlockDesk" : "door.lockDesk") : on ? "door.unlock" : "door.lock");
  const reactions = (
    <div className="reaction-row">
      {EMOTES.map((emoji, i) => <button key={i} className="chip" aria-label={t(`emote.${i + 1}` as Key)} title={`${i + 1} · ${t(`emote.${i + 1}` as Key)}`} onClick={() => { session.emote(i + 1); done(); }}>{emoji}</button>)}
      <button className={"chip run-toggle" + (running ? " on" : "")} aria-pressed={running} aria-label={t("run.toggle")} title={t("run.hint", { shift: combo(["shift"]) })} onClick={() => { session.toggleRun(); done(); }}>🏃</button>
      <button className="chip" aria-label={t("dance.action")} title={t("dance.action")} onClick={() => { session.emote(8); done(); }}>💃</button>
      <button className={"chip" + (handUp ? " on" : "")} aria-pressed={handUp} aria-label={handUp ? t("hand.lower") : t("hand.raise")} title={handUp ? t("hand.lower") : t("hand.raise")} onClick={() => { session.toggleHand(); done(); }}>✋</button>
    </div>
  );
  return (
    <>
      {barUp && createPortal(reactions, slot!)}
      <div className={"social-controls" + (compact && open ? " open" : "") + (barUp ? " bar-up" : "")} role="region" aria-label={t("emote.title")}>
        {compact && <button className="chip reaction-toggle" aria-expanded={open} aria-label={t("emote.title")} title={t("emote.title")} onClick={() => setOpen(!open)}>😀</button>}
        {(!compact || open) && !barUp && reactions}
        {wave && (
          <div className="wave-card" role="alert">
            <span>{t("wave.incoming", { name: wave.name })}</span>
            <div className="modal-actions">
              <button className="btn" onClick={() => { session.wave(wave.id); setState({ wave: null }); }}>{t("wave.back")}</button>
              <button className="primary" onClick={() => { session.goToPerson(wave.id); setState({ wave: null }); }}>{t("wave.walk")}</button>
              <button className="btn" aria-label={t("wave.dismiss")} title={t("wave.dismiss")} onClick={() => setState({ wave: null })}>×</button>
            </div>
          </div>
        )}
        {nearby && <button className="btn interaction-hint" onClick={() => session.view?.interact()}>{t("object.use", { name: nearby.label || t(`object.${nearby.t}` as Key) })}</button>}
        {following && <div className="follow-hint"><span>{t("follow.active", { name: following.name })}</span> <button className="btn" onClick={() => session.follow(0)}>{t("follow.stop")}</button></div>}
        {(lockable || myDesk) && <div className="room-actions">
          {lockable && <button className="btn" onClick={() => session.lock(!locked.includes(roomIndex))}>{t(lockKey(locked.includes(roomIndex)))}</button>}
          {myDesk && <button className="btn" onClick={() => setConfirmRelease(myDesk)}>{t("desk.release")}</button>}
        </div>}
        {desk && <button className="btn" onClick={() => setConfirmDesk(desk)}>{t("desk.claim")}</button>}
        {knockArea && <button className="btn" onClick={() => session.knock(knockArea.index)}>{t("door.knock", { area: knockArea.name })}</button>}
        {knockArea && role === "admin" && <button className="btn" onClick={() => session.force(knockArea.index)}>{t("door.force")}</button>}
      </div>
      {request && <Modal title={t("follow.lead")} onClose={() => setState({ leadRequest: null })}>
        <p>{t("follow.request", { name: request.name })}</p>
        <div className="modal-actions"><button className="btn" onClick={() => setState({ leadRequest: null })}>{t("follow.decline")}</button><button className="primary" onClick={() => { session.follow(request.id); setState({ leadRequest: null }); }}>{t("follow.accept")}</button></div>
      </Modal>}
      {confirmDesk && <Modal title={t("desk.claimTitle", { name: confirmDesk.label || t("desk.name") })} onClose={() => setConfirmDesk(null)}>
        <p>{t("desk.claimBody")}</p>
        <div className="modal-actions"><button className="btn" onClick={() => setConfirmDesk(null)}>{t("desk.claimCancel")}</button><button className="primary" disabled={claiming} onClick={() => void claim(confirmDesk)}>{t("desk.claimConfirm")}</button></div>
      </Modal>}
      {confirmRelease && <Modal title={t("desk.releaseTitle", { name: confirmRelease.label || t("desk.name") })} onClose={() => setConfirmRelease(null)}>
        <p>{t("desk.releaseBody")}</p>
        <div className="modal-actions"><button className="btn" onClick={() => setConfirmRelease(null)}>{t("desk.releaseCancel")}</button><button className="primary" disabled={claiming} onClick={() => void release(confirmRelease)}>{t("desk.releaseConfirm")}</button></div>
      </Modal>}
      {knock && <Modal title={t("door.knock", { area: knock.area })} onClose={() => session.answerKnock(knock.id, false)}>
        <p>{t("door.request", { name: knock.name, area: knock.area })}</p>
        <div className="modal-actions"><button className="btn" onClick={() => session.answerKnock(knock.id, false)}>{t("door.deny")}</button><button className="primary" onClick={() => session.answerKnock(knock.id, true)}>{t("door.allow")}</button></div>
      </Modal>}
    </>
  );
}
