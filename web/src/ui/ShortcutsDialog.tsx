import { t, type Key } from "../i18n";
import { combo, keyLabel, moveLabels, useKeyLayout } from "../keys";
import { Modal } from "./Modal";

// Letter shortcuts are physical keys (KeyboardEvent.code): the labels are what this keyboard
// prints there. Digits stay 1-7 whatever the layout types on that row. An empty list means the
// row's action is described by `note` instead of keys. Groups are small tables in two columns.
const groups = (): [Key, [string[], Key, Key?][]][] => [
  ["keys.group.move", [
    [[moveLabels().join(" "), "↑ ← ↓ →"], "keys.move"],
    [[combo(["shift"]), keyLabel("KeyR")], "keys.run"],
    [[], "keys.goto", "keys.dblclick"],
    [[combo(["mod"], keyLabel("KeyD"))], "keys.home"],
  ]],
  ["keys.group.act", [
    [[keyLabel("KeyX")], "keys.interact"],
    [["1-7"], "keys.emotes"],
    [[keyLabel("KeyZ")], "keys.dance"],
  ]],
  ["keys.group.you", [
    [[combo(["mod"], keyLabel("KeyU"))], "keys.busy"],
    [[keyLabel("KeyH")], "keys.hand"],
  ]],
  ["keys.group.view", [
    [[], "keys.zoom", "keys.wheel"],
    [[], "keys.pan", "keys.drag"],
    [[keyLabel("KeyM")], "keys.minimap"],
    [["?"], "keys.help"],
    [["Esc"], "keys.close"],
  ]],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  useKeyLayout();
  return (
    <Modal title={t("keys.title")} onClose={onClose} wide>
      {/* two columns of small tables, one per group, so the whole list fits without scrolling */}
      <div className="keys-columns">
        {[groups().slice(0, 2), groups().slice(2)].map((column, i) => (
          <div key={i}>
            {column.map(([group, rows]) => (
              <table className="keys" key={group}>
                <caption>{t(group)}</caption>
                <tbody>
                  {rows.map(([ks, label, note]) => (
                    <tr key={label}>
                      <th scope="row">{ks.length ? ks.map((k, j) => <span key={k}>{j > 0 && " / "}<kbd>{k}</kbd></span>) : t(note!, { mod: combo(["mod"]) })}</th>
                      <td>{t(label)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}
          </div>
        ))}
      </div>
      <div className="modal-actions"><button className="primary" onClick={onClose}>{t("settings.close")}</button></div>
    </Modal>
  );
}
