import { t, type Key } from "../i18n";
import { letterLabel, moveLabels, useKeyLayout } from "../keys";
import { Modal } from "./Modal";

// Movement keys are positions, named as this keyboard prints them; letter shortcuts are letters
// (keys.ts). Digits stay 1-7 whatever the layout types on that row. An empty list means the
// row's action is described by `note` instead of keys.
const rows = (): [string[], Key, Key?][] => [
  [[moveLabels().join(" "), "↑ ← ↓ →"], "keys.move"],
  [["Shift", letterLabel("r")], "keys.run"],
  [[], "keys.goto", "keys.dblclick"],
  [[], "keys.zoom", "keys.wheel"],
  [[letterLabel("x")], "keys.interact"],
  [["1-7"], "keys.emotes"],
  [[letterLabel("z")], "keys.dance"],
  [[letterLabel("h")], "keys.hand"],
  [[letterLabel("m")], "keys.minimap"],
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
