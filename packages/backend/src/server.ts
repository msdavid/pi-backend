/**
 * Fastify app factory + composition root (WP-P0.1).
 *
 * `createApp` wires health routes, structured request logging with per-request
 * correlation (requestId → child logger), and a global error handler that maps
 * thrown errors to the `@pi-managed/contracts` {@link ErrorEnvelope} shape.
 * `startServer` binds the configured port.
 *
 * This module is intentionally thin: subsystems (sessions, agents, …) register
 * their own route plugins against the returned Fastify instance in later WPs.
 */

import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { Config } from "./infra/config/index.js";
import {
  healthRoutes,
  DEFAULT_READINESS_CHECKS,
  type ReadinessCheck,
} from "./api/health.js";
import { type Pool, type TenantCtx } from "./infra/db/pool.js";
import { dbReadinessCheck } from "./infra/db/readiness.js";
import {
  type ErrorEnvelope,
  type ErrorCode,
} from "@pi-managed/contracts";
// R7.2: the one error base lives in the domain, not here. The HTTP layer only
// RENDERS it (status + envelope); it does not define it.
import { ApiError } from "./domain/errors.js";
import type { ObjectStore, SandboxProvider, SessionRuntime } from "./domain/ports.js";
import { createObjectStoreReadinessCheck } from "./infra/objectstore/readiness.js";
import type { SessionSandboxResolver } from "./domain/file/index.js";
// WP-P0.5 cross-cutting HTTP middleware (idempotency, rate limiting).
import { idempotencyMiddleware } from "./api/middleware/idempotency.js";
import { rateLimitMiddleware, createBucketStore } from "./api/middleware/rate-limit.js";
// WP-4.4 quota enforcement (per-tenant resource limits, §27.3).
import { quotaMiddleware } from "./api/middleware/quota.js";
// WP-P0.4 bearer auth + tenant/api-key routes.
import { createAuthHandler } from "./api/middleware/auth.js";
import { tenantRoutes } from "./api/tenant.js";
// WP-5.2: public tenant-onboarding sign-up route (§29.6). Registered before the
// bearer-auth hook and added to PUBLIC_PATHS so self-service sign-up works
// without credentials; gated by `config.onboardingEnabled`.
import { onboardingRoutes } from "./api/onboarding.js";
// WP-C5.1: commercialization (saas) — tenant billing surface + the machine
// credit-surface the billing adapter calls (console spec §11).
import { billingRoutes } from "./api/billing.js";
import { billingInternalRoutes } from "./api/billing-internal.js";
import type { EmailSender } from "./domain/ports.js";
import { NOOP_EMAIL_SENDER } from "./domain/email/index.js";
// WP-1.1 Agents API (CRUD + versioning + archive).
import { agentRoutes } from "./api/agents.js";
// WP-1.2 Environment routes (CRUD + archive + work-stats + work-stop).
import { environmentRoutes } from "./api/environments.js";
// WP-4.1 Self-hosted work queue routes (worker-key issuance, claim, post-result).
import { selfHostedRoutes } from "./domain/self-hosted/index.js";
// WP-1.6 Sessions API (the central resource: CRUD + fork + entries/tree/messages/usage).
import { sessionRoutes } from "./api/sessions.js";
// WP-1.7 Events API + SSE streaming (send / history / stream).
import { eventRoutes } from "./api/events.js";
import type { EventsReader } from "./domain/event-stream/index.js";
// WP-4.5 read-only web console (spec §26.6) — serves the built SPA at /console.
// WP-C1.1 (console spec §3): the hook also answers GET /console/config and
// stamps the console security headers.
import { createConsoleServeHook, resolveConsoleConfig } from "./api/console.js";
// WP-C1.2 (console spec §4): console sessions — key⇄cookie exchange + CSRF.
import {
  consoleSessionRoutes,
  resolveConsoleSessionTtlSeconds,
} from "./api/console-session.js";
// WP-1.9 vault + credential routes.
import { vaultRoutes } from "./api/vaults.js";
// WP-2.2 Memory store routes (stores + memories + versions + redact).
import { memoryRoutes } from "./api/memory-stores.js";
// WP-1.12 Files API (upload/list/get/download/delete + session-outputs slice).
import { fileRoutes } from "./api/files.js";
import { skillRoutes } from "./api/skills.js";
// WP-2.1 Scheduled Jobs API (crons) + scheduler tick loop.
import { jobRoutes } from "./api/jobs.js";
// WP-2.5 Webhooks API + dispatcher retry loop (§23).
import { webhookRoutes } from "./api/webhooks.js";
import { sessionOutcomeRoutes } from "./api/sessions-outcomes.js";
import {
  startDispatcherLoop,
  type DispatcherOptions,
} from "./domain/webhook/index.js";
import {
  startSchedulerLoop,
  type SchedulerLoopOptions,
} from "./domain/scheduler/index.js";
import { getDefaultVaultCrypto } from "./domain/vault/crypto.js";

// ---------------------------------------------------------------------------
// Error mapping (the ONE HTTP edge — R7.2)
// ---------------------------------------------------------------------------
//
// `ApiError` is declared in `domain/errors.ts` (no HTTP dependency) and thrown by
// domain services, route handlers and middleware alike. This module is the only
// place that turns one into a status + `ErrorEnvelope`. Domain code never imports
// this module — that inverted dependency was a real import cycle (and forced a
// dynamic `import("../../server.js")` in `domain/vault/validate.ts`).

/** Map an HTTP status code to a coarse error `type` (contracts ErrorType). */
function errorTypeFor(status: number): string {
  if (status >= 500) return "server_error";
  if (status >= 400 && status < 500) {
    if (status === 401 || status === 403) return "authentication_error";
    return "request_error";
  }
  return "server_error";
}

/** Build the wire {@link ErrorEnvelope} for a request. */
function envelope(
  requestId: string,
  statusCode: number,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ErrorEnvelope {
  return {
    error: {
      type: errorTypeFor(statusCode),
      code,
      message,
      ...(details ? { details } : {}),
      requestId,
    },
  };
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

export interface CreateAppOptions {
  config: Config;
  logger: Logger;
  /**
   * Readiness probes. Defaults to {@link DEFAULT_READINESS_CHECKS} (all-down in
   * P0.1). Later WPs pass real probes for db/objectStore/sandbox.
   */
  readinessChecks?: ReadinessCheck[];
  /**
   * Optional Postgres pool (WP-P0.2). When provided, the default `db` readiness
   * check is replaced with a real `SELECT 1` probe against this pool; `/readyz`
   * then reflects actual DB reachability. The caller owns the pool's lifecycle
   * (`closePool(pool)` on shutdown).
   */
  pool?: Pool;
  /**
   * Optional object store (WP-P0.3). When provided, the default `objectStore`
   * readiness check is replaced with a real probe (`probe()` on the concrete impl);
   * `/readyz` then reflects actual object-store reachability.
   */
  objectStore?: ObjectStore;
  /**
   * WP-1.7: resolve the live {@link SessionRuntime} for a session id — the ADVANCE path
   * (it may wake the session and provision its sandbox). Required to mount the Events API
   * (`POST/GET /v1/sessions/:id/events`, `GET /stream`). The runtime registry itself is
   * owned by the session manager; the server only threads the resolver through. When
   * omitted, the Events routes are not mounted.
   */
  resolveRuntime?: (sessionId: string) => Promise<SessionRuntime>;
  /**
   * R4.4: the ALREADY-ACTIVE runtime for a session, or `undefined` — must NEVER wake one.
   * The Events API attaches the live SSE tail only through this seam, so streaming a
   * completed/archived session provisions no sandbox. Omitted ⇒ streams are history-only.
   */
  getActiveRuntime?: (sessionId: string) => SessionRuntime | undefined;
  /**
   * R4.4: the `session_events` projection reader (R4.1) that serves history + replay.
   * The composition root passes the `SessionManager` (pool-backed). Omitted ⇒ the Events
   * API builds a pool-backed reader itself.
   */
  sessionEvents?: EventsReader;
  /**
   * WP-1.3: the sandbox provider. When supplied, the `sandbox` readiness check
   * reports `up` and the session-outputs routes (§16.6, §24.8) are mounted.
   */
  sandboxProvider?: SandboxProvider;
  /**
   * WP-1.12: resolves the sandbox handle for a session (for outputs reads).
   * Required with {@link sandboxProvider} to mount the outputs routes.
   */
  sandboxResolver?: SessionSandboxResolver;
  /**
   * WP-2.4 (§12.5): optional re-resolution loop deps. When provided, `createApp`
   * starts a periodic loop that calls `SecretStore.revalidate` for the running
   * sessions returned by `sessionContextsProvider`, propagating vault
   * rotation/archival/deletion and refreshing expired mcp_oauth tokens WITHOUT
   * a restart. The loop is stopped on `app.close()`. Minimal wiring; the
   * composition root (`app.ts`) owns the real provider (outside this WP's paths).
   */
  revalidation?: {
    secretStore: import("./domain/ports.js").SecretStore;
    sessionContextsProvider: import("./domain/vault/revalidate.js").SessionContextsProvider;
    intervalMs: number;
  };
  /**
   * WP-2.1: scheduled-jobs scheduler. When provided, the Jobs API routes are
   * mounted and the cron tick loop is started (every 60s + ≤10s jitter, §17.8).
   * Omit in tests (drive `CronScheduler.tick()` directly with a `FakeClock`).
   */
  scheduler?: SchedulerLoopOptions;
  /**
   * WP-2.5 (§23): webhook dispatcher retry loop. The Webhooks API routes are
   * mounted whenever a pool is present; the background retry loop is started
   * ONLY when this option is supplied (opt-in, like `scheduler`) so `createApp`
   * stays safe for tests. The composition root opts in for production.
   */
  webhookDispatcher?: Omit<DispatcherOptions, "pool">;
  /**
   * WP-3.2 (§16): runs the produce→grade→feedback loop for a freshly-defined
   * outcome. Wired by the composition root when a session runtime + grader are
   * available; omitted in tests so the outcomes route only persists the outcome.
   */
  outcomeRunner?: (tenantCtx: TenantCtx, sessionId: string, outcomeId: string) => Promise<void>;
  /**
   * WP-4.5 (§26.6): override the web-console asset root served at `/console`.
   * Defaults to `packages/web-console/dist`. The console is a read-only static
   * SPA; its assets bypass bearer auth (loaded before a key is entered) while
   * every `/v1/*` call the SPA makes still requires a Bearer key.
   */
  consoleDistPath?: string;
  /**
   * WP-C5.1 (console spec §11.1): the email seam for the trial verification
   * message. Defaults to the no-op recorder (delivers nothing; dev/test read the
   * token off it). A production saas deployment injects a real sender.
   */
  emailSender?: EmailSender;
}

/**
 * Build the Fastify application. Does not bind a port (use {@link startServer}).
 * Pure enough for tests: route handlers use `app.inject` without binding.
 */
export async function createApp(opts: CreateAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // we drive logging via the pino instance passed in.
    genReqId: () => randomUUID(),
  });

  // --- Correlated request logging ------------------------------------------
  // Attach a per-request child logger carrying requestId; log start/finish.
  app.addHook("onRequest", async (req: FastifyRequest) => {
    const requestId = req.id;
    (req as unknown as { log: Logger }).log = opts.logger.child({ requestId });
    opts.logger.debug({ requestId, method: req.method, url: req.url }, "request start");
  });
  app.addHook("onResponse", async (req: FastifyRequest, reply: FastifyReply) => {
    opts.logger.info(
      { requestId: req.id, method: req.method, url: req.url, statusCode: reply.statusCode },
      "request end",
    );
  });

  // --- Security response headers (SEC-12) ----------------------------------
  // Minimal, dependency-free hardening applied to every response (API + the /console SPA).
  // The CSP is scoped for the read-only static console: same-origin scripts, same-origin
  // styles plus inline (the SPA's bundled critical CSS), data: images, no plugins, no
  // framing. It is NOT a CORS policy — cross-origin API access is unchanged.
  const CSP =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; " +
    "base-uri 'none'; frame-ancestors 'none'";
  app.addHook("onSend", async (_req, reply, payload) => {
    // WP-C1.1 (console spec §3.4): the /console* serve hook sets its own,
    // stricter CSP before sending — defer to a CSP that is already present so
    // this API-wide default never clobbers it.
    if (!reply.getHeader("Content-Security-Policy")) {
      reply.header("Content-Security-Policy", CSP);
    }
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    return payload;
  });

  // --- Global error handler → ErrorEnvelope --------------------------------
  app.setErrorHandler(
    (err: unknown, req: FastifyRequest, reply: FastifyReply) => {
      const requestId = req.id;
      if (err instanceof ApiError) {
        opts.logger.warn(
          { requestId, code: err.code, statusCode: err.statusCode, err: err.message },
          "api error",
        );
        return reply
          .status(err.statusCode)
          .send(envelope(requestId, err.statusCode, err.code, err.message, err.details));
      }
      const message = err instanceof Error ? err.message : "internal error";
      opts.logger.error(
        { requestId, err: message, stack: err instanceof Error ? err.stack : undefined },
        "unhandled error",
      );
      return reply
        .status(500)
        .send(envelope(requestId, 500, "internal_error", "internal error"));
    },
  );

  // --- 404 handler → ErrorEnvelope -----------------------------------------
  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    return reply
      .status(404)
      .send(envelope(req.id, 404, "not_found", `route not found: ${req.method} ${req.url}`));
  });

  // --- Routes ---------------------------------------------------------------
  const baseChecks = opts.readinessChecks ?? DEFAULT_READINESS_CHECKS;
  // Wire a real DB probe when a pool is supplied (WP-P0.2); otherwise keep the
  // P0.1 "db pool not wired" stub.
  let readinessChecks = opts.pool
    ? baseChecks.map((c) => (c.name === "db" ? dbReadinessCheck(opts.pool!) : c))
    : baseChecks;
  // Wire a real object-store probe when a store is supplied (WP-P0.3).
  if (opts.objectStore) {
    const objCheck = createObjectStoreReadinessCheck(opts.objectStore);
    readinessChecks = readinessChecks.map((c) =>
      c.name === "objectStore" ? objCheck : c,
    );
  }
  // Wire the sandbox readiness check when a provider is supplied (WP-1.3). The
  // provider is the microsandbox NAPI SDK; a deep probe would provision a throwaway
  // VM (too expensive for readyz), so this reports `up` once the provider is wired.
  if (opts.sandboxProvider) {
    readinessChecks = readinessChecks.map((c) =>
      c.name === "sandbox"
        ? {
            name: "sandbox",
            check: async () => ({
              status: "up",
              detail: "microsandbox provider wired",
            }),
          }
        : c,
    );
  }
  await app.register(healthRoutes, {
    readinessChecks,
  });

  // --- WP-4.5: read-only web console (spec §26.6) -------------------------
  // Root-level onRequest hook registered BEFORE bearer auth. Calling
  // reply.send() inside an onRequest hook short-circuits the request, so
  // /console* (static SPA assets) load without a Bearer key while every /v1/*
  // route remains authenticated. No-op for non-console paths. The hook is
  // registered unconditionally (cheap); if dist is absent it returns 404.
  // WP-C1.1 (console spec §3.2): the hook also serves the public
  // GET /console/config from the values resolved off the service config.
  app.addHook(
    "onRequest",
    createConsoleServeHook({
      ...(opts.consoleDistPath ? { distPath: opts.consoleDistPath } : {}),
      config: resolveConsoleConfig(opts.config),
    }),
  );

  // --- WP-C1.2: console sessions (cookie auth + CSRF, console spec §4) -----
  // POST/GET/DELETE /console/session. The serve hook above stamps the §3.4
  // security headers and passes /console/session through; the path is on the
  // auth PUBLIC_PATHS allowlist (POST is the login; GET/DELETE self-
  // authenticate via the cookie). Mounted only with a pool (sessions live in
  // the console_sessions table).
  if (opts.pool) {
    await app.register(consoleSessionRoutes, {
      pool: opts.pool,
      ttlSeconds: resolveConsoleSessionTtlSeconds(opts.config),
    });
  }

  // --- WP-5.2: public onboarding sign-up route (§29.6) ------------------------
  // Registered BEFORE the bearer-auth hook (and on the PUBLIC_PATHS allowlist)
  // so self-service sign-up needs no credentials. Gated by `onboardingEnabled`
  // so self-hosted deployments can disable open tenant creation. Mounted only
  // when a pool is present (sign-up writes a tenant + api key).
  const emailSender = opts.emailSender ?? NOOP_EMAIL_SENDER;
  if (opts.pool) {
    await app.register(onboardingRoutes, {
      pool: opts.pool,
      enabled: opts.config.onboardingEnabled,
      // WP-C5.1: a fresh saas sign-up also provisions the $5 trial (pending grant
      // + verification email). Off for solo/team (`billingEnabled=false`).
      billingEnabled: opts.config.billingEnabled,
      emailSender,
    });
    // WP-C5.1 (console spec §11.7): the MACHINE credit-surface the billing
    // adapter calls. Registered before the tenant bearer-auth hook and on
    // PUBLIC_PATHS; it does its own constant-time machine-bearer auth (NOT a
    // tenant key), fail-closed on an unset `BILLING_PROVISION_TOKEN`.
    await app.register(billingInternalRoutes, {
      pool: opts.pool,
      ...(opts.config.billingProvisionToken
        ? { provisionToken: opts.config.billingProvisionToken }
        : {}),
    });
  }

  // --- WP-P0.4: bearer auth + tenant/api-key routes -----------------------
  // Wired only when a DB pool is available (auth resolves a key → TenantCtx via
  // the pool). The auth hook is root-level/global so every /v1/* route is
  // protected; /healthz and /readyz are on the PUBLIC_PATHS allowlist and stay
  // unauthenticated. Registered before P0.5's preHandler middleware so
  // `request.tenantCtx` is set before idempotency/rate-limiting run.
  if (opts.pool) {
    // WP-C1.2: the auth hook also accepts the console-session cookie when no
    // bearer header is present (console spec §4.3); it needs the sliding TTL
    // to re-extend sessions on use (§4.6).
    app.addHook(
      "onRequest",
      createAuthHandler(opts.pool, {
        consoleSessionTtlSeconds: resolveConsoleSessionTtlSeconds(opts.config),
      }),
    );
    await app.register(tenantRoutes, { pool: opts.pool });
    // --- WP-1.1: Agents API (CRUD + versioning + archive). ---
    // Registered after auth so `request.tenantCtx` is set; idempotency /
    // rate-limit hooks (P0.5, registered below) apply to these routes too.
    await app.register(agentRoutes, { pool: opts.pool });
  }

  // --- WP-P0.5 cross-cutting middleware ------------------------------------
  // (Kept in a distinct block so P0.4's parallel server.ts edits merge cleanly.)
  // Attached directly to the app instance (not an encapsulated plugin) so the
  // hooks apply to every route. Both no-op gracefully without a tenant ctx.
  // ROB-8: honor `RATE_LIMIT_STORE`. `memory` (default) → a per-process store; `postgres` →
  // the shared `rate_limit_buckets` table so the ceiling is GLOBAL across replicas (the
  // `PostgresBucketStore` was previously built-but-dead — the middleware always fell back to
  // in-memory). The store owns a reaper timer, so it is closed on app teardown.
  const rateLimitStore = createBucketStore({
    store: opts.config.rateLimitStore,
    ...(opts.pool ? { pool: opts.pool } : {}),
  });
  rateLimitMiddleware(app, {
    rpm: opts.config.rateLimitRpm,
    anonRpm: opts.config.rateLimitAnonRpm,
    trustedProxies: opts.config.trustedProxies,
    store: rateLimitStore,
  });
  app.addHook("onClose", async () => {
    await rateLimitStore.close();
  });
  if (opts.pool) {
    idempotencyMiddleware(app, opts.pool);
    // --- WP-4.4: per-tenant quota enforcement (§27.3) ---
    // Registered alongside the P0.5 cross-cutting middleware; no-ops without a
    // tenant ctx and only acts on resource-creating POSTs.
    quotaMiddleware(app, { pool: opts.pool });
  }

  // --- WP-1.2: Environment routes (CRUD + archive + work-stats stub) -------
  // (Distinct block; WP-1.1's parallel server.ts edits register agent routes
  // elsewhere — keep these disjoint.)
  if (opts.pool) {
    await app.register(environmentRoutes, { pool: opts.pool });
    // WP-4.1: self-hosted work-queue routes (worker-key issuance, claim,
    // post-result). work-stats + work-stop live on environmentRoutes above.
    await app.register(selfHostedRoutes, { pool: opts.pool });
  }

  // --- WP-1.6: Sessions API (central resource: CRUD + fork + reads) ------
  // (Distinct block; object store wired for JSONL reads. The sandbox provider is
  // optional and mounts only `GET /v1/sessions/:id/metrics` — the per-session VM
  // sample, §26.4.)
  if (opts.pool) {
    await app.register(sessionRoutes, {
      pool: opts.pool,
      billingEnabled: opts.config.billingEnabled,
      ...(opts.objectStore ? { objectStore: opts.objectStore } : {}),
      ...(opts.sandboxProvider ? { sandboxProvider: opts.sandboxProvider } : {}),
    });
  }

  // --- WP-1.7: Events API + SSE streaming (send / history / stream) -------
  // (Distinct block so parallel server.ts edits merge cleanly. Mounted only
  // when a runtime resolver is supplied; the session manager owns runtimes.)
  if (opts.pool && opts.resolveRuntime) {
    await app.register(eventRoutes, {
      pool: opts.pool,
      billingEnabled: opts.config.billingEnabled,
      resolveRuntime: opts.resolveRuntime,
      ...(opts.getActiveRuntime ? { getActiveRuntime: opts.getActiveRuntime } : {}),
      ...(opts.sessionEvents ? { events: opts.sessionEvents } : {}),
      logger: opts.logger,
    });
  }

  // --- WP-1.9: vault + credential routes -----------------------------------
  // (Distinct block so parallel server.ts edits merge cleanly.)
  if (opts.pool) {
    await app.register(vaultRoutes, {
      pool: opts.pool,
      crypto: getDefaultVaultCrypto(),
    });
  }

  // --- WP-2.2: Memory store routes (stores + memories + versions + redact) ---
  // (Distinct block so parallel server.ts edits merge cleanly. Requires both a
  // pool and an object store — memory content lives in the object store, §28.)
  if (opts.pool && opts.objectStore) {
    await app.register(memoryRoutes, {
      pool: opts.pool,
      objectStore: opts.objectStore,
    });
  }

  // --- WP-1.12: Files API (upload/list/get/download/delete + outputs slice) ---
  // (Distinct block so parallel server.ts edits merge cleanly. Requires both a
  // pool and an object store; outputs routes are registered only when a sandbox
  // provider + resolver are supplied — they are not wired in the default app.)
  if (opts.pool && opts.objectStore) {
    await app.register(fileRoutes, {
      pool: opts.pool,
      objectStore: opts.objectStore,
      ...(opts.sandboxProvider
        ? { sandboxProvider: opts.sandboxProvider }
        : {}),
      ...(opts.sandboxResolver
        ? { sandboxResolver: opts.sandboxResolver }
        : {}),
    });
    // WP-3.5: skills routes (multipart upload; own content-type parser in an
    // encapsulated plugin so it doesn't conflict with fileRoutes').
    await app.register(skillRoutes, {
      pool: opts.pool,
      objectStore: opts.objectStore,
    });
  }

  // --- WP-2.4 (§12.5): start the vault re-resolution loop (if wired) --------
  // (Distinct block. Propagates rotation/archival/deletion + refreshes expired
  // mcp_oauth tokens for running sessions without a restart. The loop handle is
  // stopped on app close.)
  let revalidationHandle: import("./domain/vault/revalidate.js").RevalidationLoopHandle | undefined;
  if (opts.revalidation) {
    const { startRevalidationLoop } = await import("./domain/vault/revalidate.js");
    revalidationHandle = startRevalidationLoop({
      secretStore: opts.revalidation.secretStore,
      sessionContextsProvider: opts.revalidation.sessionContextsProvider,
      intervalMs: opts.revalidation.intervalMs,
      logger: opts.logger,
    });
    app.addHook("onClose", async () => {
      revalidationHandle?.stop();
    });
  }

  // --- WP-2.1: Scheduled Jobs API + cron tick loop (§17) -------------------
  // (Distinct block so parallel server.ts edits merge cleanly. Mounted when a
  // pool is present. The tick loop is started only when an explicit `scheduler`
  // option is supplied (opt-in) so `createApp` stays safe for tests — no
  // background timers. The composition root opts in for production.)
  if (opts.pool) {
    await app.register(jobRoutes, { pool: opts.pool });
    if (opts.scheduler) {
      const schedulerHandle = startSchedulerLoop({
        ...opts.scheduler,
        pool: opts.pool,
      });
      app.addHook("onClose", async () => schedulerHandle.stop());
    }
  }

  // --- WP-2.5: Webhooks API + dispatcher retry loop (§23) -----------------
  // (Distinct block so parallel server.ts edits merge cleanly. Routes mounted
  // when a pool is present. The retry loop is started ONLY when an explicit
  // `webhookDispatcher` option is supplied (opt-in, mirrors `scheduler`) — tests
  // drive `WebhookDispatcher.tick()` directly. The composition root opts in.)
  if (opts.pool) {
    await app.register(webhookRoutes, { pool: opts.pool });
    if (opts.webhookDispatcher) {
      const dispatcherHandle = startDispatcherLoop({
        ...opts.webhookDispatcher,
        pool: opts.pool,
      });
      app.addHook("onClose", async () => dispatcherHandle.stop());
    }
  }

  // --- WP-3.2: Session Outcomes API (§16) ---------------------------------
  // (Distinct block so parallel server.ts edits merge cleanly. Routes mounted
  // when a pool is present. The iteration-loop runner is wired by the composition
  // root via `opts.outcomeRunner`; omitted in tests so the route only persists the
  // outcome. Deliverables are served through the Files API, §16.6.)
  if (opts.pool) {
    await app.register(sessionOutcomeRoutes, {
      pool: opts.pool,
      ...(opts.outcomeRunner ? { runOutcomeLoop: opts.outcomeRunner } : {}),
    });
  }

  // --- WP-C5.1: tenant billing surface (console spec §11.8) ---------------
  // (Distinct block; registered after auth so `request.tenantCtx` is set. Reads
  // balance/lifecycle/ledger and resends the verification email — all-tenant,
  // never calls a payment engine. All-modes safe: a tenant not enrolled in the
  // ledger simply 404s on GET /v1/tenant/billing, which the console reads as
  // "no billing".)
  if (opts.pool) {
    // The link-out proxy (checkout/portal/auto-charge) forwards to the billing
    // adapter over the machine channel — present only when BOTH the adapter URL and
    // the shared machine secret are configured; otherwise the four routes 404 as the
    // no-adapter state (§11.8). The Stripe SDK never enters the backend.
    const adapter =
      opts.config.billingAdapterUrl && opts.config.billingProvisionToken
        ? {
            baseUrl: opts.config.billingAdapterUrl,
            provisionToken: opts.config.billingProvisionToken,
          }
        : undefined;
    await app.register(billingRoutes, {
      pool: opts.pool,
      emailSender,
      ...(adapter ? { adapter } : {}),
    });
  }

  return app;
}

/**
 * Bind the HTTP server to `config.port` and resolve when listening. The caller
 * owns graceful shutdown (`app.close()`).
 */
export async function startServer(
  app: FastifyInstance,
  config: Config,
): Promise<{ url: string }> {
  await app.listen({ port: config.port, host: "0.0.0.0" });
  return { url: `http://0.0.0.0:${config.port}` };
}
