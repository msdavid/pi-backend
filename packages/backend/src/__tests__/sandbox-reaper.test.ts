/**
 * Sandbox reaper (ROB-3).
 *
 * `startSandboxReaper` destroys detached VMs left behind by terminal/archived sessions and
 * clears their handles. This exercises `reapOnce()` against a stub pool + fake provider (no
 * Postgres): every reapable row is destroyed + cleared, and one failed destroy does not
 * abort the pass (the row is simply retried next interval).
 */

import { describe, it, expect } from "vitest";
import pino from "pino";
import { startSandboxReaper } from "../app.js";
import type { Pool } from "../infra/db/pool.js";
import type { SandboxHandle, SandboxProvider } from "../domain/ports.js";

const silentLogger = pino({ level: "silent" });

interface ReapRow {
  id: string;
  tenant_id: string;
  sandbox_handle: string;
}

/** Minimal pool stub: serves the reaper SELECT once, records handle-clearing UPDATEs. */
class StubPool {
  cleared: string[] = [];
  constructor(private rows: ReapRow[]) {}
  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    if (/UPDATE sessions SET sandbox_handle = NULL/i.test(sql)) {
      this.cleared.push(String(params?.[0]));
      // Clearing consumes the row so a re-list would not return it again.
      this.rows = this.rows.filter((r) => r.id !== String(params?.[0]));
      return { rows: [], rowCount: 1 };
    }
    return { rows: this.rows, rowCount: this.rows.length };
  }
}

/** Fake provider whose `destroy` records the VM name (and can be made to fail for one). */
class FakeProvider {
  destroyed: string[] = [];
  failOn: string | undefined;
  async destroy(handle: SandboxHandle): Promise<void> {
    if (handle.name === this.failOn) throw new Error("boom");
    this.destroyed.push(handle.name);
  }
}

describe("startSandboxReaper (ROB-3)", () => {
  it("destroys orphaned sandboxes and clears their handles", async () => {
    const pool = new StubPool([
      { id: "sess_1", tenant_id: "tnt_a", sandbox_handle: "vm-1" },
      { id: "sess_2", tenant_id: "tnt_b", sandbox_handle: "vm-2" },
    ]);
    const provider = new FakeProvider();
    const reaper = startSandboxReaper({
      pool: pool as unknown as Pool,
      sandboxProvider: provider as unknown as SandboxProvider,
      logger: silentLogger,
      intervalMs: 60_000,
    });

    const destroyed = await reaper.reapOnce();
    reaper.stop();

    expect(destroyed).toBe(2);
    expect(provider.destroyed.sort()).toEqual(["vm-1", "vm-2"]);
    expect(pool.cleared.sort()).toEqual(["sess_1", "sess_2"]);
  });

  it("is non-fatal per item: a failed destroy does not abort the pass", async () => {
    const pool = new StubPool([
      { id: "sess_bad", tenant_id: "tnt_a", sandbox_handle: "vm-bad" },
      { id: "sess_ok", tenant_id: "tnt_b", sandbox_handle: "vm-ok" },
    ]);
    const provider = new FakeProvider();
    provider.failOn = "vm-bad";
    const reaper = startSandboxReaper({
      pool: pool as unknown as Pool,
      sandboxProvider: provider as unknown as SandboxProvider,
      logger: silentLogger,
      intervalMs: 60_000,
    });

    const destroyed = await reaper.reapOnce();
    reaper.stop();

    expect(destroyed).toBe(1);
    expect(provider.destroyed).toEqual(["vm-ok"]);
    // The failed VM's handle is NOT cleared → it will be retried on the next pass.
    expect(pool.cleared).toEqual(["sess_ok"]);
  });
});
