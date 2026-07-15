/**
 * WP-1.11c — Map client spend caps to the server-side session `budget` field.
 *
 * Spec §24.6: client caps (spendCapPerSession, spendCapPerDay) are UX; the
 * real protection is the hard `budget` field enforced by the backend
 * regardless of client policy. A compromised or buggy client cannot bypass it.
 */

import type { PiManagedSettings } from "../config.js";
import type { Budget } from "@pi-managed/contracts";

/** Convert client spend caps → a server-side SessionCreate.budget. */
export function capsToBudget(settings: PiManagedSettings): Budget | undefined {
  const maxUsd = settings.spendCapPerSession;
  // spendCapPerDay has no direct server field; it's a client-side guard tracked
  // locally (the gating hook could enforce it). Only per-session maps to budget.
  if (maxUsd === undefined) return undefined;
  return { maxUsd };
}
