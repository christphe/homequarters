import { useStore } from "../store";
import { t } from "../i18n";
import { Modal } from "./Modal";

const stay = () => {}; // not dismissable: the only way on is the new version

// A newer deploy is running: this page's code is stale, so the only choice is to reload.
export function UpdateBanner() {
  const outdated = useStore((s) => s.outdated);
  if (!outdated) return null;
  return (
    <Modal title={t("update.title")} onClose={stay}>
      <p>{t("update.text")}</p>
      <div className="modal-actions">
        <button className="primary" onClick={() => location.reload()}>{t("update.now")}</button>
      </div>
    </Modal>
  );
}
