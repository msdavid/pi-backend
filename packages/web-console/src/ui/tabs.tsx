import { useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { cx } from "./cx.js";
import styles from "./tabs.module.css";

export interface TabItem {
  id: string;
  label: string;
  content: ReactNode;
}

export interface TabsProps {
  tabs: TabItem[];
  /** Accessible name for the tablist (e.g. "Session detail"). */
  label: string;
  /** Initially selected tab; defaults to the first. */
  defaultTabId?: string;
  onTabChange?: (id: string) => void;
}

/**
 * WAI-ARIA tabs pattern with roving tabindex and automatic activation:
 * Arrow keys move focus AND selection; Home/End jump to the ends (DP-13).
 * Only the active panel's content is rendered (DP-2, one list many lenses —
 * DP-4's session Trace/Tree/Usage tabs sit on this component).
 */
export function Tabs({ tabs, label, defaultTabId, onTabChange }: TabsProps) {
  const uid = useId();
  const [selectedId, setSelectedId] = useState(
    () => defaultTabId ?? tabs[0]?.id,
  );
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectedIndex = Math.max(
    0,
    tabs.findIndex((t) => t.id === selectedId),
  );
  const selected = tabs[selectedIndex];

  function select(index: number) {
    const tab = tabs[index];
    if (!tab || tab.id === selectedId) return;
    setSelectedId(tab.id);
    onTabChange?.(tab.id);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = (selectedIndex + 1) % tabs.length;
        break;
      case "ArrowLeft":
        next = (selectedIndex - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    select(next);
    tabRefs.current[next]?.focus();
  }

  if (tabs.length === 0) return null;

  return (
    <div className={styles.tabs}>
      <div
        role="tablist"
        aria-label={label}
        className={styles.tablist}
        onKeyDown={onKeyDown}
      >
        {tabs.map((tab, index) => {
          const isSelected = tab.id === selected?.id;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              type="button"
              role="tab"
              id={`${uid}-tab-${tab.id}`}
              aria-selected={isSelected}
              aria-controls={`${uid}-panel-${tab.id}`}
              tabIndex={isSelected ? 0 : -1}
              className={cx(styles.tab, isSelected && styles.selected)}
              onClick={() => select(index)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {selected ? (
        <div
          role="tabpanel"
          id={`${uid}-panel-${selected.id}`}
          aria-labelledby={`${uid}-tab-${selected.id}`}
          tabIndex={0}
          className={styles.panel}
        >
          {selected.content}
        </div>
      ) : null}
    </div>
  );
}
