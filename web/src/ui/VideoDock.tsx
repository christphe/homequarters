import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { media, spotlightMedia, type MediaManager, type Tile } from "../media/MediaManager";
import { useStore } from "../store";
import { session } from "../session";
import { t } from "../i18n";
import type { MuteKind } from "../net/protocol";
import { MicOffIcon } from "./Icons";

function Video({ el, mirror }: { el: HTMLVideoElement | null; mirror?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    if (el) {
      host.replaceChildren(el);
      void el.play().catch(() => {});
    } else host.replaceChildren();
  }, [el]);
  return <div ref={ref} className={"vid" + (mirror ? " mirror" : "")} />;
}

/** What can be turned off on a remote tile right now (only what is on). */
const offItems = (tile: Tile): MuteKind[] => tile.local ? [] : [tile.mic && "mic", tile.cam && "cam", !!tile.screen && "scr"].filter((k): k is MuteKind => !!k);

/**
 * The menu to turn off somebody's microphone, camera or screen share (never on). Opened from the tile's
 * "⋯" button or by a right click; arrows move, Escape and Tab close it. It lives in the page (or the
 * full-screen element), not in the tile, so the tile's rounded clip never cuts it.
 */
function TileMenu({ tile, name, at, anchor, onClose }: { tile: Tile; name: string; at: { x: number; y: number }; anchor: RefObject<HTMLButtonElement | null>; onClose: (refocus: boolean) => void }) {
  const ref = useRef<HTMLUListElement>(null);
  const items = offItems(tile);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);
  useEffect(() => {
    // a press on the "⋯" button is left to its own click, which closes the menu
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) onClose(false); };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [onClose, anchor]);
  const keys = (e: ReactKeyboardEvent) => {
    const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(true); }
    else if (e.key === "Tab") { e.preventDefault(); onClose(true); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      btns[(i + (e.key === "ArrowDown" ? 1 : btns.length - 1)) % btns.length]?.focus();
    }
  };
  const x = Math.max(4, Math.min(at.x, window.innerWidth - 210));
  const y = Math.max(4, Math.min(at.y, window.innerHeight - 40 * items.length - 44));
  return createPortal(
    <ul ref={ref} className="menu tile-menu" role="menu" aria-label={t("tileMenu.label", { name })} style={{ left: x, top: y }} onKeyDown={keys}>
      <li role="presentation" className="tile-menu-who" aria-hidden="true">{name}</li>
      {items.map((k) => (
        <li key={k} role="none">
          <button role="menuitem" onClick={() => { session.mute(Number(tile.identity), k); onClose(true); }}>{t(`tileMenu.${k}`)}</button>
        </li>
      ))}
    </ul>,
    document.fullscreenElement ?? document.body,
  );
}

export function TileView({ tile, big, mgr = media }: { tile: Tile; big?: boolean; mgr?: MediaManager }) {
  const roster = useStore((s) => s.roster);
  const p = roster.get(Number(tile.identity));
  const name = p?.n ?? tile.name;
  const nextVol = tile.vol >= 1 ? 0.5 : tile.vol > 0 ? 0 : 1;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const more = useRef<HTMLButtonElement>(null);
  const canTurnOff = offItems(tile).length > 0;
  const close = useRef((refocus: boolean) => { setMenu(null); if (refocus) more.current?.focus(); }).current;
  useEffect(() => { if (!canTurnOff) setMenu(null); }, [canTurnOff]); // everything went off meanwhile
  return (
    <div className={"tile" + (tile.speaking ? " speaking" : "") + (big ? " big" : "")}
      onContextMenu={canTurnOff ? (e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); } : undefined}>
      {big ? <Video el={tile.screen} /> : tile.cam ? <Video el={tile.video} mirror={tile.local} /> : <div className="avatar-fallback">{(p?.n ?? tile.name).slice(0, 1).toUpperCase()}</div>}
      <span className="tag">
        {tile.local ? t("media.you") : p?.n ?? tile.name}
        {!tile.mic && !big && <MicOffIcon />}
      </span>
      {!tile.local && !big && (
        <button className="vol" onClick={() => mgr.setVolume(tile.identity, nextVol)} aria-label={t("media.volumeOf", { name, level: Math.round(tile.vol * 100) })} title={t("media.volumeOf", { name, level: Math.round(tile.vol * 100) })}>
          {tile.vol >= 1 ? "🔊" : tile.vol > 0 ? "🔉" : "🔇"}
        </button>
      )}
      {canTurnOff && (
        <button ref={more} className="tile-more" aria-haspopup="menu" aria-expanded={!!menu} aria-label={t("tileMenu.open", { name })} title={t("tileMenu.open", { name })}
          onClick={() => {
            if (menu) return setMenu(null);
            const r = more.current!.getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom + 4 });
          }}>⋯</button>
      )}
      {menu && canTurnOff && <TileMenu tile={tile} name={name} at={menu} anchor={more} onClose={close} />}
    </div>
  );
}

export function SpotlightDock() {
  const tiles = useSyncExternalStore(spotlightMedia.subscribe, spotlightMedia.getTiles);
  const spot = useStore((s) => s.spotlight);
  const consent = useStore((s) => s.consent);
  if (!spot) return null;
  return <section className="spotlight-dock" aria-label={t("spot.title")}>
    <p role="status">{spot.me ? t("spot.onAir") : t("spot.speaker", { name: spot.name })}</p>
    {!consent && <p>{t("spot.listen")}</p>}
    {tiles.filter((tile) => Number(tile.identity) === spot.id).map((tile) => <div key={tile.identity}>
      <TileView tile={tile} mgr={spotlightMedia} />
      {tile.screen && <ShareView tile={tile} />}
    </div>)}
  </section>;
}

/** A shared screen with view controls: expand over the map, full screen, picture-in-picture. */
function ShareView({ tile }: { tile: Tile }) {
  const [focus, setFocus] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const roster = useStore((s) => s.roster);
  const name = tile.local ? t("media.you") : roster.get(Number(tile.identity))?.n ?? tile.name;
  useEffect(() => {
    if (!focus) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setFocus(false); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [focus]);
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void box.current?.requestFullscreen?.().catch(() => {});
  };
  const pip = () => void tile.screen?.requestPictureInPicture?.().catch(() => {});
  return (
    <div ref={box} className={"share" + (focus ? " focus" : "")} role="group" aria-label={t("media.sharing", { name })}>
      <TileView tile={tile} big />
      <div className="share-tools">
        <button className="chip" onClick={() => setFocus(!focus)} aria-pressed={focus} aria-label={focus ? t("share.shrink") : t("share.expand")} title={focus ? t("share.shrink") : t("share.expand")}>{focus ? "⤡" : "⤢"}</button>
        <button className="chip" onClick={fullscreen} aria-label={t("share.fullscreen")} title={t("share.fullscreen")}>⛶</button>
        {document.pictureInPictureEnabled && <button className="chip" onClick={pip} aria-label={t("share.pip")} title={t("share.pip")}>⧉</button>}
      </div>
    </div>
  );
}

export function VideoDock() {
  const tiles = useSyncExternalStore(media.subscribe, media.getTiles);
  const conv = useStore((s) => s.conv);
  const eco = useStore((s) => s.settings.eco);
  if (!conv || tiles.length === 0) return null;
  const shares = tiles.filter((x) => x.screen);
  return (
    <section className={"dock" + (eco ? " eco" : "")} aria-label={t("chat.conversation")}>
      {shares.map((s) => (
        <ShareView key={"s" + s.identity} tile={s} />
      ))}
      <div className="grid">
        {tiles.map((x) => (
          <TileView key={x.identity} tile={x} />
        ))}
      </div>
    </section>
  );
}
