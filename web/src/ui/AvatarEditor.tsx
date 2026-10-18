import { useEffect, useMemo, useRef } from "react";
import type { AvatarSpec, Color } from "../net/protocol";
import { CELL_H, CELL_W, drawAvatarPreview, normaliseSpec } from "../game/avatars";
import { BEARD_IDS, HAIR_STYLE_IDS, HAT_IDS } from "../game/art/characters";
import { colorOf, HAIR, HAT_COLORS, PANTS, SHIRT, SKIN } from "../game/palette";
import { t, type Key } from "../i18n";

export function AvatarCanvas({ av, dir = 0, size = 3 }: { av: AvatarSpec; dir?: number; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) drawAvatarPreview(ref.current, av, dir);
  }, [av, dir]);
  return <canvas ref={ref} className="pixel" style={{ width: CELL_W * size, height: CELL_H * size }} />;
}

// a palette of swatches, then any colour through the browser's own picker
function Swatches({ label, colors, value, onPick }: { label: string; colors: string[]; value: Color; onPick: (c: Color) => void }) {
  const custom = typeof value === "string";
  const shown = colorOf(value, colors);
  return (
    <div className="ae-row">
      <span className="ae-label">{label}</span>
      <div className="swatches" role="radiogroup" aria-label={label}>
        {colors.map((c, i) => (
          <button key={i} type="button" role="radio" aria-checked={value === i} aria-label={label + " " + (i + 1)} title={label + " " + (i + 1)} className={"sw" + (value === i ? " on" : "")} style={{ background: c }} onClick={() => onPick(i)} />
        ))}
        <input
          type="color"
          className={"sw sw-custom" + (custom ? " on" : "")}
          aria-label={t("avatar.customColor", { part: label })}
          title={t("avatar.customColor", { part: label })}
          value={shown}
          style={custom ? { background: shown } : undefined}
          onChange={(ev) => onPick(ev.target.value.toLowerCase())}
        />
      </div>
    </div>
  );
}

function Chips({ id, label, ids, prefix, value, onPick }: { id: string; label: string; ids: readonly string[]; prefix: string; value: number; onPick: (i: number) => void }) {
  return (
    <div className="ae-row">
      <span className="ae-label" id={id}>
        {label}
      </span>
      <div className="chips" role="radiogroup" aria-labelledby={id}>
        {ids.map((n, i) =>
          n ? (
            <button key={n} type="button" role="radio" aria-checked={value === i} className={"chip" + (value === i ? " on" : "")} onClick={() => onPick(i)}>
              {t(`${prefix}.${n}` as Key)}
            </button>
          ) : null,
        )}
      </div>
    </div>
  );
}

/** The join screen's editor: a front preview next to every option. */
export function AvatarEditor({ value: raw, onChange }: { value: AvatarSpec; onChange: (a: AvatarSpec) => void }) {
  const value = useMemo(() => normaliseSpec(raw), [raw]);
  return (
    <div className="avatar-editor">
      <div className="ae-preview">
        <AvatarCanvas av={value} dir={0} size={5} />
      </div>
      <AvatarControls value={value} onChange={onChange} />
    </div>
  );
}

/** Every appearance option: hair, colours, beard, hat, clothes. */
export function AvatarControls({ value: raw, onChange }: { value: AvatarSpec; onChange: (a: AvatarSpec) => void }) {
  const value = useMemo(() => normaliseSpec(raw), [raw]);
  const set = (p: Partial<AvatarSpec>) => onChange({ ...value, ...p });
  return (
    <div className="ae-controls">
      <Swatches label={t("avatar.skin")} colors={SKIN} value={value.sk} onPick={(c) => set({ sk: c })} />
      <Chips id="ae-hair" label={t("avatar.hair")} ids={HAIR_STYLE_IDS} prefix="hair" value={value.hs} onPick={(i) => set({ hs: i })} />
      <Swatches label={t("avatar.hairColor")} colors={HAIR} value={value.hc} onPick={(c) => set({ hc: c })} />
      <Chips id="ae-beard" label={t("avatar.beard")} ids={BEARD_IDS} prefix="beard" value={value.bd ?? 0} onPick={(i) => set({ bd: i })} />
      <Chips id="ae-hat" label={t("avatar.hat")} ids={HAT_IDS} prefix="hat" value={value.ht ?? 0} onPick={(i) => set({ ht: i })} />
      {!!value.ht && <Swatches label={t("avatar.hatColor")} colors={HAT_COLORS} value={value.hk ?? 0} onPick={(c) => set({ hk: c })} />}
      <Swatches label={t("avatar.shirt")} colors={SHIRT} value={value.sh} onPick={(c) => set({ sh: c })} />
      <Swatches label={t("avatar.pants")} colors={PANTS} value={value.pa} onPick={(c) => set({ pa: c })} />
    </div>
  );
}
