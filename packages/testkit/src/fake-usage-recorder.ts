import type {
  Budget,
  BudgetCheck,
  TokenCounts,
  Usage,
  UsageRecorder,
} from "@pi-managed/backend";
import type { SessionId, TenantId } from "@pi-managed/backend";

/**
 * In-memory fake `UsageRecorder` (spec §9.7, §6.3) with a scriptable per-model price
 * table. Records token counts exactly as reported; USD derived from the price table.
 */
export interface PriceEntry {
  /** USD per 1M input tokens. */
  inputPerMillion: number;
  /** USD per 1M output tokens. */
  outputPerMillion: number;
  /** USD per 1M cache-creation tokens. */
  cacheCreationPerMillion?: number;
  /** USD per 1M cache-read tokens. */
  cacheReadPerMillion?: number;
}

export class FakeUsageRecorder implements UsageRecorder {
  private records = new Map<SessionId, TokenCounts[]>();
  /** Scriptable price table: model id → price entry. */
  readonly priceTable = new Map<string, PriceEntry>();
  /** Fallback price used when a model is absent from the table (§9.7). */
  fallbackPrice: PriceEntry = {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheCreationPerMillion: 3.75,
    cacheReadPerMillion: 0.3,
  };
  /** Script a budget breach for the next `checkBudget` call. */
  private breached: SessionId | null = null;

  /** Set the price for a model. */
  setPrice(model: string, price: PriceEntry): void {
    this.priceTable.set(model, price);
  }

  /** Force the next `checkBudget` for `sessionId` to report exceeded. */
  setBudgetBreached(sessionId: SessionId): void {
    this.breached = sessionId;
  }

  async record(
    sessionId: SessionId,
    _model: string,
    tokens: TokenCounts,
  ): Promise<void> {
    const list = this.records.get(sessionId) ?? [];
    list.push(tokens);
    this.records.set(sessionId, list);
  }

  usdCost(model: string, tokens: TokenCounts): number {
    const p = this.priceTable.get(model) ?? this.fallbackPrice;
    const per = (n: number, rate?: number) =>
      rate !== undefined ? (n / 1_000_000) * rate : 0;
    return (
      per(tokens.inputTokens, p.inputPerMillion) +
      per(tokens.outputTokens, p.outputPerMillion) +
      per(tokens.cacheCreationInputTokens, p.cacheCreationPerMillion) +
      per(tokens.cacheReadInputTokens, p.cacheReadPerMillion)
    );
  }

  async cumulativeForSession(sessionId: SessionId): Promise<Usage> {
    const list = this.records.get(sessionId) ?? [];
    const usage = sumTokens(list);
    const usd = this.tallyUsd(sessionId, list, undefined);
    return { ...usage, usd };
  }

  async checkBudget(
    sessionId: SessionId,
    _budget: Budget,
  ): Promise<BudgetCheck> {
    if (this.breached === sessionId) {
      this.breached = null;
      return { exceeded: true, reason: "budget_exhausted" };
    }
    return { exceeded: false };
  }

  async rollupForTenant(
    _tenantId: TenantId,
    _range?: { from?: Date; to?: Date },
  ): Promise<Usage> {
    // The fake does not attribute to tenants; it rolls up all recorded usage.
    const all: TokenCounts[] = [];
    for (const list of this.records.values()) all.push(...list);
    const usage = sumTokens(all);
    return { ...usage, usd: 0 };
  }

  private tallyUsd(
    _sessionId: SessionId,
    list: TokenCounts[],
    model: string | undefined,
  ): number {
    if (list.length === 0) return 0;
    if (model) {
      return list.reduce((acc, t) => acc + this.usdCost(model, t), 0);
    }
    // Without per-record model attribution, fall back to the fallback price.
    return list.reduce((acc, t) => acc + this.usdCost("__fallback__", t), 0);
  }
}

function sumTokens(list: TokenCounts[]): Omit<Usage, "usd"> {
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0,
  };
  for (const t of list) {
    usage.inputTokens += t.inputTokens;
    usage.outputTokens += t.outputTokens;
    usage.cacheCreationInputTokens += t.cacheCreationInputTokens;
    usage.cacheReadInputTokens += t.cacheReadInputTokens;
  }
  usage.totalTokens =
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens;
  return usage;
}
