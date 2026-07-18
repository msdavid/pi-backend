import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One-click copy with transient feedback: `copy(text)` writes to the
 * clipboard and flips `copied` to true for `resetMs`. Used by CopyableId and
 * EmptyState's CLI-command slot (DP-5).
 */
export function useCopy(resetMs = 1500): {
  copied: boolean;
  copy: (text: string) => Promise<void>;
} {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Clipboard unavailable (permissions, insecure context) — show no
        // feedback rather than a false "Copied".
        return;
      }
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), resetMs);
    },
    [resetMs],
  );

  return { copied, copy };
}
