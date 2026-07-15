import type {
  SecretBinding,
  SecretStore,
  SessionContext,
} from "@pi-managed/backend";

/**
 * In-memory fake `SecretStore` (spec §12, §25.1, §25.4). Returns scripted opaque
 * `SecretBinding` refs — **never raw secret values** (§25.5). The fake holds only refs.
 */
export class FakeSecretStore implements SecretStore {
  /** Scripted bindings per session id. */
  private scripted = new Map<string, SecretBinding[]>();
  /** Recorded revalidation calls for assertions. */
  readonly revalidations: SessionContext[] = [];

  /** Script the bindings to return for a session (refs only, never values). */
  scriptForSession(sessionId: string, bindings: SecretBinding[]): void {
    this.scripted.set(sessionId, [...bindings]);
  }

  async resolveBindingsForSession(
    ctx: SessionContext,
  ): Promise<SecretBinding[]> {
    return [...(this.scripted.get(ctx.sessionId) ?? [])];
  }

  async revalidate(ctx: SessionContext): Promise<void> {
    this.revalidations.push(ctx);
  }
}
