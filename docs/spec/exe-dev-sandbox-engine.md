# exe.dev Sandbox Engine — Feasibility Note (deferred)

> **Status: investigated, NOT being implemented.** This note records the July 2026
> feasibility investigation of [exe.dev](https://exe.dev) as (a) a hosting target for
> the backend and (b) a second `SandboxProvider` engine alongside microsandbox. We are
> deliberately not building it now. If we pick this up later, start with the
> [verification spike](#7-verification-spike-run-this-first) — every exe.dev fact below
> is **as of 2026-07** and the platform is young enough that all of it must be
> re-verified before design work.
>
> **Scope.** Complements [`multi-host-design.md`](multi-host-design.md): that note
> scales the *self-hosted* sandbox plane across our own KVM hosts; this note evaluates
> outsourcing the sandbox plane entirely. The seam both rely on is the same:
> `SandboxProvider` (`packages/backend/src/domain/ports.ts`) + the plugin registry
> (`docs/plugins.md`) + the conformance kit (`runSandboxProviderConformance`).

## 1. What exe.dev is (as of 2026-07)

Bold Software, Inc. (David Crawshaw's company). A subscription service: real KVM VMs
(Cloud Hypervisor on rented bare metal) booted **from an OCI container image** (default
`exeuntu`, open-source Dockerfile) — hence ~2 s provisioning. Relevant properties:

- **No public IP per VM.** exe.dev terminates TLS and reverse-proxies
  `https://<vm>.exe.xyz/` to one port (3000–9999 reachable by authorized users; exactly
  one port may be public). SSH via `ssh <vm>.exe.xyz`.
- **The management API is SSH** (`ssh exe.dev new|ls|rm|cp|resize|tag|stat … --json`)
  plus an HTTPS wrapper (`POST https://exe.dev/exec` — 30 s timeout, 64 KB body,
  per-key rate limits; **not suitable** for our exec path, use raw SSH).
- **Persistent disks**, "serverful" philosophy; idle/stopped VMs cost disk-only.
- **Integrations**: secrets held server-side, injected at the network edge
  (`*.int.exe.xyz` hostnames) — a VM can *use* a secret but never read it. Includes
  GitHub proxy, header-injecting HTTP proxy, and **GCP/AWS Workload Identity
  Federation** (keyless cloud credentials — relevant for the GCS object store).
- **Custom domains** with automatic certs; `X-ExeDev-UserID`/`-Email` identity headers;
  per-VM metrics via `stat` (CPU/mem/disk/IO, 24 h–30 d ranges); VM tags; `cp` clones a
  VM.
- **Pricing (2026-07):** Personal $20/mo = 2 vCPU + 8 GB RAM *pooled across all VMs*,
  ≤50 VMs, 100 GB pooled disk, 200 GB egress (overage $0.08/GB-mo disk, $0.05/GB
  transfer). Team $25/user/mo. Usage-based: $0.05/core-hr, $0.016/GiB-hr active RAM,
  disk-rate when idle. Negotiated fully-usage "Cloud Pool" for scale. Regions include
  Tokyo and Singapore; an account is pinned to one region.
- **Maturity flags:** launched ~late 2025; no published SLA; no SOC 2 claim found; no
  documented disk redundancy/snapshot/backup guarantees; one security bulletin
  (2026-02: shared VMs exposed all HTTP ports to share recipients; fixed).
  Sub-processors: AWS, GCP, Latitude.sh, NetActuate, ClickHouse.

## 2. Why we care

The sandbox plane is our heaviest ops surface. exe.dev would remove, for operators who
opt in:

- the **KVM host requirement** and its tail: nested-virt-capable hardware (on GCP that
  excludes E2/AMD/Arm entirely), the `~/.microsandbox` kernel bootstrap, the
  silently-skippable native package, the self-hosted KVM CI runner;
- for multi-host growth, the entire `SANDBOX_MODE=multi` fleet burden (enrolling hosts,
  per-host mTLS material, host agents, placement capacity management) — sandbox
  capacity becomes a plan parameter on exe.dev's side while the control plane stays a
  single modest VM (~5 MiB control-plane cost per session, `docs/capacity.md`);
- if also hosting the control plane there: TLS fronting and cert management (the
  backend already assumes an external TLS proxy — `docs/operations.md`).

## 3. Scenarios evaluated

| | Scenario | Verdict (2026-07) |
| --- | --- | --- |
| A | Host the **control plane** on an exe.dev VM | Viable for solo/team. TLS/ingress absorbed; Postgres + filesystem object store on the VM disk works but exe.dev documents **no disk durability/backup guarantees** — the three-artifact backup discipline (`docs/operations.md`) becomes more critical, not less. GCS via their GCP-WIF integration is the keyless alternative. `/dev/kvm` inside exe.dev guests is **presumed absent** (fixed kernel, no nested-virt docs) → microsandbox almost certainly cannot run there; A only makes sense paired with B. |
| B | **Replace microsandbox** with exe.dev VMs (`ExeDevSandboxProvider`) | Implementable against the port; the conformance kit defines "done". Two contract guarantees cannot be honored (see §5) — "complete replacement" therefore means a documented security downgrade. Acceptable for solo/team trusted-ish workloads; **not** for the SaaS shape today. |
| C | **Dual engine, operator-selectable** (recommended) | microsandbox stays the default full-fidelity engine; exe.dev is the "I don't run KVM infrastructure" option with fail-closed capability limits. Additive: a new provider package + `registerSandboxProvider` + a config extension (e.g. `SANDBOX_RUNTIME=microsandbox | exedev | disabled`). Zero core changes. The self-hosted worker channel already proves the codebase tolerates providers with different capability envelopes (optional `metrics`). |

## 4. Port-contract mapping (`SandboxProvider` → exe.dev)

| Port method | exe.dev primitive | Fit |
| --- | --- | --- |
| `provision(spec)` | `ssh exe.dev new --name --image <OCI ref> --cpu --memory --disk --env --tag t<tenant>,s<session>` | Good. ~2 s; OCI images native; tags = labels; "detached" is inherent (VMs outlive the backend by construction). |
| `exec` / `execStream` | `ssh <vm>.exe.xyz -- <cmd>` | Works; SSH streams naturally. cwd/env/timeout/rlimit via a small in-guest wrapper (`timeout`, `prlimit`). Latency is the cost (§6). |
| `stop` (checkpoint) | **No `stop` CLI command exists.** VMs auto-idle ("stopped VMs cost disk-only") | Gap to verify. Idle-checkpoint may become a near-no-op economically, but the contract's "processes NOT preserved" semantics diverge. |
| `start` | `restart`, or implicit on next connection | Verify. |
| `snapshot` (fs-only, stopped) | `cp` (clone a VM) | Semantically OK; economically clunky — each snapshot is a whole VM against the VM cap and pooled disk. |
| `destroy` | `rm` + detach/delete per-VM integrations | Good. |
| `reattachByLabels` | `ls --json` filtered by tags | Good (verify tags appear in `ls --json`). |
| `status` | `ls --json` → `status` | Partial. `running` is reported; whether `stopped`/`crashed` are distinguishable is unverified — crash-recovery polling (`crash-recovery.ts`, 10 s) depends on it. |
| `metrics?` | `stat --json` | Close match to `SandboxMetrics` (CPU/mem/disk/IO); net counters unverified. |
| `registerSecretBinding` | Integrations (edge-injected secrets) | Partial — see §5. `mcp_oauth`/`static_bearer` unaffected (injected by the backend MCP proxy, not the provider). |

## 5. Hard gaps — these are §25.5/§10.5 contract guarantees, not nice-to-haves

1. **`NetworkPolicy { mode: "limited" }` cannot be enforced.** We compile it to
   default-deny + `allowHost()` in microsandbox; exe.dev exposes **no egress controls**.
   Even `unrestricted` is weaker than microsandbox's `publicOnly()` (which still denies
   private/loopback/metadata/host). **Fail-closed rule if built:** the exe.dev engine
   MUST refuse to wake an environment whose compiled policy is `limited`, with a
   distinct error code — never silently degrade.
2. **`$MSB_` egress secret substitution does not exist.** microsandbox substitutes the
   real value into TLS-intercepted traffic toward `allowedHosts`; the guest only ever
   holds a placeholder. exe.dev's equivalent (edge injection) requires traffic to be
   *redirected* at `*.int.exe.xyz` integration hostnames — different guest-visible
   URLs, different semantics. **Fail-closed rule if built:** reject
   `environment_variable`/`git_token` bindings the engine cannot honor; `egress`-mode
   repo clones either map to the exe.dev GitHub integration (design decision — changes
   what lands in `.git/config`) or are refused in favor of `staged` mode.
3. **One exe.dev account holds every tenant's sandboxes.** The current architecture
   keeps tenant isolation at the VM boundary *and* the account boundary; on exe.dev the
   latter collapses. Fine for solo/team; disqualifying for the SaaS shape without a
   per-tenant-account design (unexplored).

## 6. Latency & capacity model

- microsandbox exec = in-process NAPI call to a local microVM (sub-ms overhead).
  exe.dev exec = SSH round-trip to their region per **tool call** (`bash`/`read`/
  `write`/`edit`/`find`/`ls` all route through `provider.exec`). Expect tens of ms with
  SSH ControlMaster multiplexing from a same-region host; measure before committing.
  There is **no private network between exe.dev VMs** (their FAQ suggests Tailscale),
  so co-hosting the control plane there does not shortcut this. Escape hatch if SSH
  overhead bites: a persistent in-guest agent behind their HTTPS proxy using VM bearer
  tokens (`docs/https-tokens-for-vms`).
- Provisioning is **not** on the per-message hot path (`runtime.ts`
  `ensureSandboxRunning`): first wake pays `provision`; a running session pays nothing;
  a checkpointed session pays `start`. exe.dev's ~2 s `new` is compatible with that
  cost model.
- One VM per active session. Personal-plan caps (50 VMs, pooled 2 vCPU/8 GB) suit
  many-idle-few-active workloads well — idle VMs cost disk-only, which matches our
  idle-checkpoint + reaper behavior. SaaS scale needs their negotiated Cloud Pool.

## 7. Verification spike (run this FIRST)

Half a day with a paid account, **before any design work**. Findings go in this file.

1. `ssh exe.dev new` → `ls -la /dev/kvm` in the guest (settles Scenario A's
   microsandbox question definitively).
2. Measure `new` latency and per-exec SSH latency from SGP/TYO, with and without
   ControlMaster; measure `execStream` chunk latency for a long-running command.
3. Establish stop/start semantics: is there an explicit stop? does in-guest
   `shutdown` allow a later restart? what does `ls --json` report for stopped and for
   crashed VMs? do tags appear in `ls --json`?
4. Confirm the **public** HTTPS proxy passes through non-exe `Authorization: Bearer`
   headers untouched (our API clients use them; exe.dev's proxy also accepts
   deprecated bearer tokens in `Authorization` — collision behavior is unverified),
   and that it holds long-lived SSE streams (`GET /v1/sessions/:id/stream`).
5. Test `cp`-as-snapshot cost/latency, and the GitHub integration as a `git_token`
   substitute (what exactly lands in `.git/config`; does push work).
6. Check `stat --json` field coverage against `SandboxMetrics` (net counters).
7. Re-confirm pricing/caps — the 2026-07 numbers in §1 will be stale.

## 8. Implementation sketch (if we proceed)

Additive only — the plugin seam means zero core changes:

1. New package (e.g. `packages/exedev-provider`): `ExeDevSandboxProvider implements
   SandboxProvider`, talking raw SSH (never `POST /exec`), one dedicated SSH key for
   the backend, tags `t<tenant>`/`s<session>` for `reattachByLabels`. Rough size
   judged against `MicrosandboxProvider`: ~1–2 K LOC + tests.
2. Fail-closed capability envelope per §5: refuse `limited` network policy; refuse
   unsupported secret-binding categories; document the envelope in `docs/plugins.md`.
3. Registration + selection: `registerSandboxProvider` at composition, and extend
   `SANDBOX_RUNTIME` (currently `disabled | enabled`) to name an engine —
   `microsandbox` (default, alias of today's `enabled`) `| exedev | disabled`.
   Backward-compatible parsing in `infra/config/index.ts`.
4. Conformance: `runSandboxProviderConformance` against a real account (skip-with-
   warning when no credentials, same pattern as the `@kvm` gate); plus engine-specific
   tests for the fail-closed refusals.
5. Docs to update in the same change: `docs/deploy.md` (env table, a "no-KVM path"
   section), `docs/operations.md` (engine-specific runbook entries),
   `docs/architecture.md` §4.4, `docs/plugins.md`, `README.md` prerequisites.

## 9. Sources (all as of 2026-07)

- exe.dev docs (all pages have `.md` alternates; index: <https://exe.dev/llms.txt>):
  what-is-exe, proxy, sharing, customization, cnames, login-with-exe, https-api,
  https-tokens-for-vms, integrations, integrations-gcp-wif, regions, billing/*,
  faq/how-exedev-works, faq/cross-vm-networking, serverful, lockin, sub-processors,
  CLI reference (`new`, `resize`, `stat`, …).
- <https://exe.dev/pricing>, <https://exe.dev/usage-pricing>, <https://exe.dev/sandbox>
- Launch post: <https://blog.exe.dev/meet-exe.dev>
- Independent review: <https://lalitm.com/trying-sprites-exedev-shellbox/>
- HN pricing thread: <https://news.ycombinator.com/item?id=47878211>
