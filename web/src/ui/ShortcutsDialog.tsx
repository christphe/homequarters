import { t, type Key } from "../i18n";
import { keyLabel, moveLabels, useKeyLayout } from "../keys";
import { isMac } from "../game/home";
import { Modal } from "./Modal";

// Letter shortcuts are physical keys (KeyboardEvent.code): the labels are what this keyboard
// prints there. Digits stay 1-7 whatever the layout types on that row. An empty list means the
// row's action is described by `note` instead of keys.
const rows = (): [string[], Key, Key?][] => [
  [[moveLabels().join(" "), "↑ ← ↓ →"], "keys.move"],
  [["Shift", keyLabel("KeyR")], "keys.run"],
  [[], "keys.goto", "keys.dblclick"],
  [[], "keys.zoom", "keys.wheel"],
  [[], "keys.pan", "keys.drag"],
  [[(isMac() ? "⌘ " : "Ctrl ") + keyLabel("KeyD")], "keys.home"],
  [[keyLabel("KeyX")], "keys.interact"],
  [["1-7"], "keys.emotes"],
  [[keyLabel("KeyZ")], "keys.dance"],
  [[keyLabel("KeyH")], "keys.hand"],
  [[keyLabel("KeyM")], "keys.minimap"],
  [["Esc"], "keys.close"],
  [["?"], "keys.help"],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  useKeyLayout();
  return (
    <Modal title={t("keys.title")} onClose={onClose}>
      <table className="keys">
        <caption className="sr-only">{t("keys.title")}</caption>
        <tbody>
          {rows().map(([ks, label, note]) => (
            <tr key={label}>
              <th scope="row">{ks.length ? ks.map((k, i) => <span key={k}>{i > 0 && " / "}<kbd>{k}</kbd></span>) : t(note!)}</th>
              <td>{t(label)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="modal-actions"><button className="primary" onClick={onClose}>{t("settings.close")}</button></div>
    </Modal>
  );
}
