import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import { cx } from "./cx.js";
import styles from "./toast.module.css";

export type ToastTone = "info" | "success" | "danger";

export interface ToastOptions {
  message: string;
  tone?: ToastTone;
  /** Auto-dismiss delay; `Infinity` keeps the toast until dismissed. */
  durationMs?: number;
}

interface ToastItem extends Required<ToastOptions> {
  id: number;
}

interface ToastContextValue {
  toast: (options: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** Imperative toast trigger; must be used under a <ToastProvider>. */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a <ToastProvider>");
  }
  return ctx;
}

/**
 * Transient notifications. Info/success announce politely (role=status);
 * danger interrupts (role=alert) and never auto-dismisses — errors carry
 * data the user may need to act on (DP-9; the API-error rendering built on
 * this adds code + request id, never a bare toast).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
    };
  }, []);

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    (options: ToastOptions) => {
      const tone = options.tone ?? "info";
      const item: ToastItem = {
        tone,
        durationMs:
          options.durationMs ?? (tone === "danger" ? Infinity : 5000),
        message: options.message,
        id: nextId.current++,
      };
      setItems((prev) => [...prev, item]);
      if (Number.isFinite(item.durationMs)) {
        timers.current.set(
          item.id,
          setTimeout(() => dismiss(item.id), item.durationMs),
        );
      }
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className={styles.viewport} role="region" aria-label="Notifications">
        {items.map((item) => (
          <div
            key={item.id}
            role={item.tone === "danger" ? "alert" : "status"}
            className={cx(styles.toast, styles[item.tone])}
          >
            <span className={styles.message}>{item.message}</span>
            <button
              type="button"
              className={styles.dismiss}
              aria-label="Dismiss notification"
              onClick={() => dismiss(item.id)}
            >
              <CloseIcon />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* Inline SVG icon only — no asset requests, ever (console-spec §3.4). */
function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="M4 4l8 8M12 4l-8 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}
