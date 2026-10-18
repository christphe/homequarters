import { useState } from "react";
import { activeMedia, media, spotlightMedia } from "../media/MediaManager";
import { session } from "../session";
import { saveAvatar, saveSettings, toast, useStore } from "../store";
import type { AvatarSpec } from "../net/protocol";
import { AvatarCanvas, PetCanvas } from "./AvatarEditor";
import { AppearanceDialog } from "./AppearanceDialog";
import { NoiseDialog } from "./NoiseDialog";
import { MediaDialog } from "./MediaDialog";
import { GearIcon } from "./Icons";
import { askNotifyPermission } from "../notify";
import { askOsIdle, IDLE_SETTINGS_URL, osIdleSupported } from "../osIdle";
import { t } from "../i18n";
import { Modal } from "./Modal";

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const s = useStore((x) => x.settings);
  const meId = useStore((x) => x.meId);
  const signsIn = useStore((x) => x.auth.providers.length > 0);
  const myName = useStore((x) => x.roster.get(x.meId)?.n ?? "");
  const myAvatar = useStore((x) => x.myAvatar);
  const [name, setName] = useState(myName);
  const [avatar, setAvatar] = useState<AvatarSpec>(useStore((x) => x.roster.get(x.meId)?.av) ?? myAvatar);
  const [deviceLink, setDeviceLink] = useState("");
  const [dressing, setDressing] = useState(false);
  const [idleBlocked, setIdleBlocked] = useState(false);
  const [noiseOpen, setNoiseOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const makeDeviceLink = async () => {
    const r = await fetch("/api/account-link", { method: "POST" });
    if (!r.ok) return toast(t("settings.deviceError"));
    const { url } = (await r.json()) as { url: string };
    setDeviceLink(location.origin + url);
  };
  const saveProfile = async (look = avatar) => {
    const n = name.trim() || myName;
    const r = await fetch("/api/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n, avatar: look }) });
    if (!r.ok) return toast(t("settings.profileError"));
    setAvatar(look);
    saveAvatar(look);
    localStorage.setItem("hq.name", n);
    toast(t("settings.profileSaved"));
  };
  // the session ends on the server; the reload stops the call and capture and shows the sign-in screen
  const signOut = async () => {
    const r = await fetch("/api/signout", { method: "POST" }).catch(() => null);
    if (r?.ok) location.reload();
    else toast(t("settings.signOutFailed"));
  };
  return (
    <Modal title={t("settings.title")} onClose={onClose}>
      {meId > 0 && (
        <div className="field">
          <span>{t("settings.profile")}</span>
          <div className="profile-row">
            <div className="ae-preview profile-look">
              <AvatarCanvas av={avatar} dir={0} size={3} />
              {!!avatar.pt && <PetCanvas kind={avatar.pt} dir={0} size={2} />}
            </div>
            <div className="profile-fields">
              <input maxLength={24} value={name} onChange={(e) => setName(e.target.value)} aria-label={t("join.name")} />
              <div className="profile-buttons">
                <button className="btn" onClick={() => setDressing(true)}>{t("appearance.change")}</button>
                <button className="btn" onClick={() => void saveProfile()} disabled={!name.trim()}>{t("settings.saveProfile")}</button>
              </div>
            </div>
          </div>
          {dressing && <AppearanceDialog value={avatar} onClose={() => setDressing(false)} onSave={async (look) => { await saveProfile(look); setDressing(false); }} />}
        </div>
      )}
      {meId > 0 && !signsIn && (
        <div className="field">
          <span>{t("settings.device")}</span>
          {deviceLink ? (
            <>
              <input readOnly value={deviceLink} onFocus={(e) => e.currentTarget.select()} aria-label={t("settings.device")} />
              <small className="muted">{t("settings.deviceHint")} {t("settings.deviceReplaced")}</small>
            </>
          ) : (
            <button className="btn" onClick={makeDeviceLink}>{t("settings.deviceNew")}</button>
          )}
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={s.eco} onChange={(e) => { saveSettings({ eco: e.target.checked, maxVideos: e.target.checked ? Math.min(s.maxVideos, 3) : s.maxVideos }); session.setEco(e.target.checked); media.applySubscriptions(); }} />
        <span>{t("settings.eco")}<small className="muted"> — {t("settings.ecoHint")}</small></span>
      </label>
      <button className="btn" onClick={() => setDevicesOpen(true)}>{t("media.devices")}</button>
      {devicesOpen && <MediaDialog mode="devices" onClose={() => setDevicesOpen(false)} />}
      <div className="check-row">
        <label className="check">
          <input type="checkbox" checked={s.denoise} onChange={(e) => { saveSettings({ denoise: e.target.checked }); void media.applyNoiseSuppression(); void spotlightMedia.applyNoiseSuppression(); }} />
          <span>{t("settings.denoise")}<small className="muted"> — {t("settings.denoiseHint")}</small></span>
        </label>
        <button className="round ghost" disabled={!s.denoise} aria-label={t("noise.title")} title={t("noise.title")} onClick={() => setNoiseOpen(true)}><GearIcon /></button>
      </div>
      {noiseOpen && <NoiseDialog onClose={() => setNoiseOpen(false)} />}
      <label className="check">
        <input type="checkbox" checked={s.audioOnly} onChange={(e) => { saveSettings({ audioOnly: e.target.checked }); if (e.target.checked) void activeMedia().setCam(false); media.applySubscriptions(); spotlightMedia.applySubscriptions(); }} />
        <span>{t("media.audioOnly")}</span>
      </label>
      <label className="field">
        <span>{t("settings.videoLimit")}: {s.maxVideos}</span>
        <input type="range" min={1} max={12} value={s.maxVideos} onChange={(e) => { saveSettings({ maxVideos: Number(e.target.value) }); media.applySubscriptions(); }} />
      </label>
      <label className="check">
        <input type="checkbox" checked={s.debug} onChange={(e) => saveSettings({ debug: e.target.checked })} />
        <span>{t("settings.debug")}</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={s.minimap} onChange={(e) => saveSettings({ minimap: e.target.checked })} />
        <span>{t("settings.minimap")}</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={s.sounds} onChange={(e) => saveSettings({ sounds: e.target.checked })} />
        <span>{t("settings.sounds")}</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={s.notify} onChange={async (e) => {
          const on = e.target.checked;
          if (on && !(await askNotifyPermission())) return toast(t("settings.notifyDenied"));
          saveSettings({ notify: on });
        }} />
        <span>{t("settings.notify")}</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={s.osIdle} disabled={!osIdleSupported()} onChange={async (e) => {
          const on = e.target.checked;
          if (on && (await askOsIdle()) !== "granted") return setIdleBlocked(true);
          setIdleBlocked(false);
          saveSettings({ osIdle: on });
          session.setOsIdle(on);
        }} />
        <span>{t("settings.osIdle")}<small className="muted"> — {osIdleSupported() ? t("settings.osIdleHint") : t("settings.osIdleUnsupported")}</small></span>
      </label>
      {idleBlocked && (
        <div className="setting-note" role="alert">
          <p>{t("settings.osIdleDenied")}</p>
          <div className="setting-url">
            <input readOnly value={IDLE_SETTINGS_URL} aria-label={t("settings.osIdleUrl")} onFocus={(e) => e.currentTarget.select()} />
            <button className="btn" onClick={() => void navigator.clipboard?.writeText(IDLE_SETTINGS_URL).then(() => toast(t("settings.copied")), () => {})}>{t("settings.copy")}</button>
          </div>
        </div>
      )}
      <div className="modal-actions">
        {/* only with a sign-in provider: without one the cookie is the account, and signing out would lose it */}
        {meId > 0 && signsIn && <button className="btn" onClick={() => void signOut()}>{t("settings.signOut")}</button>}
        <button className="primary" onClick={onClose}>{t("settings.close")}</button>
      </div>
    </Modal>
  );
}
