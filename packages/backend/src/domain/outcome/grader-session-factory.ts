/**
 * Production {@link GraderSessionFactory} (§16.1, R6.3).
 *
 * Materializes the grader's own tool-less `AgentSession`, reusing the GRADED session's
 * model + tenant-owned provider key (resolved host-side from the vault, §4.2 / R2.7) so a
 * grade never falls back to a host `process.env` key. The grader executes nothing — it
 * reads the rubric + outputs from its prompt and emits a verdict — so the session is built
 * with no tools at all (see `createGraderSession`); the §10.2 host-execution lockout holds
 * by construction.
 *
 * This is the wiring the pre-R8 tree lacked: `createManagedApp` only built the loop when a
 * grader was injected (tests), so `POST /v1/sessions/:id/outcomes` persisted the row but
 * the produce→grade→feedback loop never ran in production. The composition root now
 * constructs this factory by default.
 */

import { createGraderSession } from "../session-manager/materialize.js";
import type {
  AgentSessionLike,
  SessionStore,
} from "../session-manager/types.js";
import type { ProviderKeyResolver } from "../ports.js";
import type { GraderSessionContext, GraderSessionFactory } from "./grader.js";

export interface PiGraderSessionFactoryDeps {
  /** Loads the graded session's record (model + vault refs). */
  sessions: SessionStore;
  /** Resolves the graded session's provider key host-side (absent ⇒ use material keys). */
  providerKeyResolver?: ProviderKeyResolver;
}

export class PiGraderSessionFactory implements GraderSessionFactory {
  constructor(private readonly deps: PiGraderSessionFactoryDeps) {}

  async create(
    systemPromptOverride: string,
    ctx: GraderSessionContext,
  ): Promise<AgentSessionLike> {
    const record = await this.deps.sessions.get(ctx.sessionId);
    if (!record) {
      throw new Error(
        `PiGraderSessionFactory: graded session not found: ${ctx.sessionId}`,
      );
    }
    const model = record.material.agentConfig.model;
    const providerKeys = this.deps.providerKeyResolver
      ? await this.deps.providerKeyResolver.resolveProviderKeys({
          tenantId: record.tenantId,
          sessionId: record.sessionId,
          vaultIds: record.vaultIds,
        })
      : record.material.providerKeys;
    return createGraderSession({
      model,
      providerKeys,
      systemPrompt: systemPromptOverride,
    });
  }
}
