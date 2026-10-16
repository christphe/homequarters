import { useEffect, useRef, type ReactNode } from "react";

// Open dialogs, innermost last: only that one answers Escape and keeps Tab inside (a dialog opened from
// another one, like Appearance from Settings, closes on its own).
const open: object[] = [];

const FOCUSABLE = "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])";

export function Modal({ title, onClose, children, wide, huge }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; huge?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const me = {};
    open.push(me);
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const k = (e: KeyboardEvent) => {
      if (open[open.length - 1] !== me) return;
      if (e.key === "Escape") return close.current();
      if (e.key !== "Tab" || !ref.current) return;
      // keep keyboard focus inside the dialog
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !ref.current.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !ref.current.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", k);
    return () => {
      window.removeEventListener("keydown", k);
      open.splice(open.indexOf(me), 1);
      prev?.focus?.();
    };
  }, []); // typing or changing tools must not reset focus in an already-open dialog
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={"modal" + (wide ? " wide" : "") + (huge ? " huge" : "")} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}
