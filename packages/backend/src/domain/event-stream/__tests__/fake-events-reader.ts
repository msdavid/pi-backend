/**
 * In-memory {@link EventsReader} — the `session_events` projection (R4.1) as a test double.
 *
 * Legitimate as a *collaborator* fake: the projection's real Postgres behavior is the
 * subject of `session-manager/__tests__/session-events-store.test.ts` (real container), and
 * the read path end-to-end is the subject of `read-path.integration.test.ts` (real pool +
 * a spy sandbox provider). Here it stands in only so the replay/stream units can be driven
 * without a database.
 */

import type { EntryRange, SessionEntry } from "../../ports.js";
import type { EventsReader } from "../replay.js";

/** A projection reader over a seeded, positionally-ordered entry list. */
export class FakeEventsReader implements EventsReader {
  constructor(private entries: SessionEntry[] = []) {}

  seed(entries: SessionEntry[]): void {
    this.entries = [...entries];
  }

  async readEvents(
    _tenantId: string,
    _sessionId: string,
    range?: EntryRange,
  ): Promise<SessionEntry[]> {
    let slice = this.entries.filter(
      (e) =>
        (range?.start === undefined || e.position >= range.start) &&
        (range?.end === undefined || e.position < range.end),
    );
    if (range?.limit !== undefined) slice = slice.slice(0, range.limit);
    return slice.map((e) => ({ ...e }));
  }

  async readEventsHead(_sessionId: string): Promise<number> {
    return this.entries.length === 0
      ? 0
      : this.entries[this.entries.length - 1].position + 1;
  }
}
