import { useEffect, useId, useRef } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { createPortal } from "react-dom";

import styles from "./dialog.module.css";

/**
 * Elements the trap cycles through. Kept deliberately simple — dialog content
 * in this console is forms and buttons, not arbitrary widgets.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), ' +
  'select:not([disabled]), textarea:not([disabled]), ' +
  '[tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  open: boolean;
  /** Called on Escape, backdrop click, or the close button. */
  onClose: () => void;
  /** Dialog title; also the accessible name. */
  title: string;
  children: ReactNode;
}

/**
 * Modal dialog, focus-trapped (DP-13): focus moves inside on open, Tab
 * cycles within the panel, Escape and backdrop click close, and focus
 * returns to the opener on close. Rendered in a portal so page stacking
 * contexts cannot clip it.
 */
export function Dialog({ open, onClose, title, children }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Initial focus on open; restore the opener's focus on close/unmount.
  useEffect(() => {
    if (!open) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();
    return () => previous?.focus();
  }, [open]);

  if (!open) return null;

  function trapKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;

    const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function onBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) onClose();
  }

  return createPortal(
    <div className={styles.backdrop} onMouseDown={onBackdropMouseDown}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={styles.panel}
        onKeyDown={trapKeyDown}
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}
