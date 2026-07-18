/**
 * A session id rendered per console-spec §7.6: a thin per-family name over
 * the shared parameterized `LinkedId` (../linked-id.tsx), kept because
 * session ids render across many features (home, sessions, jobs, files).
 */
import { LinkedId } from "../linked-id.js";

export function SessionId({
  id,
  maxLength,
}: {
  id: string;
  maxLength?: number;
}) {
  return (
    <LinkedId
      id={id}
      maxLength={maxLength}
      to="/sessions/$sessionId"
      params={{ sessionId: id }}
    />
  );
}
