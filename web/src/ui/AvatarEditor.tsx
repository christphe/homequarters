import { useEffect, useMemo, useRef } from "react";
import type { AvatarSpec } from "../net/protocol";
import { CELL_H, CELL_W, drawAvatarPreview, normaliseSpec } from "../game/avatars";
import { BEARD_IDS, HAIR_STYLE_IDS, HAT_IDS } from "../game/art/characters";
import { HAIR, HAT_COLORS, PANTS, SHIRT, SKIN } from "../game/palette";
import { drawPetPreview, PET_H, PET_KINDS, PET_W } from "../game/pets";
import { t, type Key } from "../i18n";

export function AvatarCanvas({ av, dir = 0, size = 3 }: { av: AvatarSpec; dir?: number; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) drawAvatarPreview(ref.current, av, dir);
  }, [av, dir]);
  return <canvas ref={ref} className="pixel" style={{ width: CELL_W * size, height: CELL_H * size }} />;
}

export function PetCanvas({ kind, dir = 0, size = 3 }: { kind: number; dir?: number; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) drawPetPreview(ref.current, kind, dir);
  }, [kind, dir]);
  return <canvas ref={ref} className="pixel" aria-hidden="true" style={{ width: PET_W * size, height: PET_H * size }} />;
}

function Swatches({ label, colors, value, onPick }: { label: string; colors: string[]; value: number; onPick: (i: number) => void }) {
  return (
    <div className="ae-row">
      <span className="ae-label">{label}</span>
      <div className="swatches" role="radiogroup" aria-label={label}>
        {colors.map((c, i) => (
          <button key={c} type="button" role="radio" aria-checked={value === i} aria-label={label + " " + (i + 1)} title={label + " " + (i + 1)} className={"sw" + (value === i ? " on" : "")} style={{ background: c }} onClick={() => onPick(i)} />
        ))}
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

export function AvatarEditor({ value: raw, onChange }: { value: AvatarSpec; onChange: (a: AvatarSpec) => void }) {
  const value = useMemo(() => normaliseSpec(raw), [raw]);
  const set = (p: Partial<AvatarSpec>) => onChange({ ...value, ...p });
  return (
    <div className="avatar-editor">
      <div className="ae-preview">
        <AvatarCanvas av={value} dir={0} size={5} />
        {!!value.pt && <PetCanvas kind={value.pt} dir={0} size={4} />}
      </div>
      <div className="ae-controls">
        <Swatches label={t("avatar.skin")} colors={SKIN} value={value.sk} onPick={(i) => set({ sk: i })} />
        <Chips id="ae-hair" label={t("avatar.hair")} ids={HAIR_STYLE_IDS} prefix="hair" value={value.hs} onPick={(i) => set({ hs: i })} />
        <Swatches label={t("avatar.hairColor")} colors={HAIR} value={value.hc} onPick={(i) => set({ hc: i })} />
        <Chips id="ae-beard" label={t("avatar.beard")} ids={BEARD_IDS} prefix="beard" value={value.bd ?? 0} onPick={(i) => set({ bd: i })} />
        <Chips id="ae-hat" label={t("avatar.hat")} ids={HAT_IDS} prefix="hat" value={value.ht ?? 0} onPick={(i) => set({ ht: i })} />
        {!!value.ht && <Swatches label={t("avatar.hatColor")} colors={HAT_COLORS} value={value.hk ?? 0} onPick={(i) => set({ hk: i })} />}
        <Swatches label={t("avatar.shirt")} colors={SHIRT} value={value.sh} onPick={(i) => set({ sh: i })} />
        <Swatches label={t("avatar.pants")} colors={PANTS} value={value.pa} onPick={(i) => set({ pa: i })} />
        <div className="ae-row">
          <span className="ae-label" id="ae-pet">{t("avatar.pet")}</span>
          <div className="chips pets" role="radiogroup" aria-labelledby="ae-pet">
            {PET_KINDS.map((n, i) => (
              <button key={n} type="button" role="radio" aria-checked={(value.pt ?? 0) === i} className={"chip pet-chip" + ((value.pt ?? 0) === i ? " on" : "")} title={t(`pet.${n}` as Key)} onClick={() => set({ pt: i })}>
                {i > 0 && <PetCanvas kind={i} size={2} />}
                <span>{t(`pet.${n}` as Key)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
