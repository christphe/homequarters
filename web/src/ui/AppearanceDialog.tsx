import { useState } from "react";
import type { AvatarSpec } from "../net/protocol";
import { t } from "../i18n";
import { AvatarCanvas, AvatarControls, PetCanvas } from "./AvatarEditor";
import { Modal } from "./Modal";

// the front large, then the side and the back at half size underneath
const VIEWS = [
  { dir: 0, size: 6, pet: 3, cls: "front" },
  { dir: 2, size: 3, pet: 2, cls: "" },
  { dir: 3, size: 3, pet: 2, cls: "" },
] as const;

// Almost full screen: the avatar from the front, the side and the back, next to every option. Changes
// stay a draft until Save.
export function AppearanceDialog({ value, onSave, onClose }: { value: AvatarSpec; onSave: (a: AvatarSpec) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(value);
  return (
    <Modal title={t("appearance.title")} onClose={onClose} huge>
      <div className="appearance">
        <div className="appearance-views">
          {VIEWS.map((v) => (
            <div key={v.dir} className={"ae-preview appearance-view " + v.cls}>
              <AvatarCanvas av={draft} dir={v.dir} size={v.size} />
              {!!draft.pt && <PetCanvas kind={draft.pt} dir={v.dir} size={v.pet} />}
            </div>
          ))}
        </div>
        <div className="appearance-options">
          <AvatarControls value={draft} onChange={setDraft} />
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>{t("appearance.cancel")}</button>
        <button className="primary" onClick={() => onSave(draft)}>{t("appearance.save")}</button>
      </div>
    </Modal>
  );
}
