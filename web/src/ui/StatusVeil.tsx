import { session } from "../session";
import { useStore } from "../store";
import { t } from "../i18n";
import { combo, keyLabel, useKeyLayout } from "../keys";

/** Away or busy greys the map out under a big button that makes you available again. The map
 * keeps working underneath (moving, double-click); only the button takes clicks. */
export function StatusVeil() {
  useKeyLayout();
  const status = useStore((s) => s.status);
  if (status !== "away" && status !== "busy") return null;
  const title = t(status === "away" ? "veil.away" : "veil.busy");
  return (
    <section className="status-veil" data-status={status} aria-label={title}>
      <div className="veil-card">
        <button className="veil-button" onClick={() => session.backToAvailable()}>{title}</button>
        <p className="veil-hint">{t("veil.hint", { key: combo(["mod"], keyLabel("KeyU")) })}</p>
      </div>
    </section>
  );
}
