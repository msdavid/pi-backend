/**
 * Worker overrides for the R7.1 pool test (`SESSION_WORKER_OVERRIDES_MODULE`).
 *
 * A session worker is a real Node child process running the COMPILED backend
 * (`dist/domain/session-worker/worker-entry.js`), so it cannot receive objects from the
 * test process and cannot load TypeScript. This module — plain ESM, imported by the child —
 * supplies the two collaborators the in-process composition root would otherwise take as
 * constructor args:
 *
 *  - a **cross-process** fake `SandboxProvider` whose state lives in a JSON file
 *    (`PI_TEST_SANDBOX_STATE`), so a sandbox provisioned by worker A is still discoverable
 *    (status `running`) by worker B after A is killed — that is what makes the re-attach
 *    assertion real rather than a re-provision in disguise. It records, per sandbox, the
 *    PID that provisioned it and how many times it was provisioned.
 *  - a fake `AgentSessionFactory` (no model, no API key): `prompt()` resolves immediately,
 *    so the runtime's turn driver settles and emits its real `session.*` events.
 *
 * Everything else in the worker is production code: the real `ManagedSessionRuntime`, the
 * real `DbSessionStore`, the real `SessionEventsStore` projection, the real pg pool. The
 * pool, the IPC, the sharding and the crash/respawn path — the subjects of the test — are
 * never faked.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

const statePath = () => {
  const p = process.env.PI_TEST_SANDBOX_STATE;
  if (!p) throw new Error("worker-overrides: PI_TEST_SANDBOX_STATE is not set");
  return p;
};

function readState() {
  const p = statePath();
  if (!existsSync(p)) return { sandboxes: {} };
  const raw = readFileSync(p, "utf8").trim();
  if (raw === "") return { sandboxes: {} };
  return JSON.parse(raw);
}

function writeState(state) {
  const p = statePath();
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, p); // atomic within the same directory
}

/** A `SandboxProvider` whose sandbox registry survives the death of the process. */
class FileBackedSandboxProvider {
  async provision(spec) {
    const state = readState();
    const prev = state.sandboxes[spec.name];
    state.sandboxes[spec.name] = {
      name: spec.name,
      labels: spec.labels,
      status: "running",
      provisions: (prev?.provisions ?? 0) + 1,
      provisionedByPid: process.pid,
    };
    writeState(state);
    // id === name (mirrors the real MicrosandboxProvider), so a handle reconstructed from
    // the persisted name re-attaches to the same VM.
    return { id: spec.name, name: spec.name, labels: spec.labels };
  }

  async status(handle) {
    const sb = readState().sandboxes[handle.name];
    return sb ? sb.status : "crashed";
  }

  async start(handle) {
    const state = readState();
    const sb = state.sandboxes[handle.name];
    if (sb) {
      sb.status = "running";
      writeState(state);
    }
  }

  async stop(handle) {
    const state = readState();
    const sb = state.sandboxes[handle.name];
    if (sb) {
      sb.status = "stopped";
      writeState(state);
    }
  }

  async destroy(handle) {
    const state = readState();
    delete state.sandboxes[handle.name];
    writeState(state);
  }

  async exec() {
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  async *execStream() {
    // no chunks
  }

  async snapshot(handle) {
    return `snap_${handle.name}`;
  }

  async reattachByLabels(labels) {
    const state = readState();
    return Object.values(state.sandboxes)
      .filter(
        (sb) =>
          sb.labels?.tenant === labels.tenant &&
          (labels.session === undefined || sb.labels?.session === labels.session),
      )
      .map((sb) => ({ id: sb.name, name: sb.name, labels: sb.labels }));
  }

  async registerSecretBinding() {
    // Refs only (§25.5) — nothing to materialize in the fake.
  }
}

/** An `AgentSessionLike` with no model: prompts resolve, no Pi events are emitted. */
class FakeAgentSession {
  constructor(sessionFile) {
    this.sessionId = `fake_${process.pid}`;
    this.sessionFile = sessionFile;
    this.isStreaming = false;
    this.listeners = [];
  }
  async prompt() {}
  async steer() {}
  async followUp() {}
  subscribe(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
  async abort() {}
  dispose() {}
  getEntries() {
    return [];
  }
}

export function createSessionWorkerOverrides() {
  return {
    sandboxProvider: new FileBackedSandboxProvider(),
    factory: {
      async create(options) {
        return new FakeAgentSession(options.localJsonlPath);
      },
    },
  };
}
