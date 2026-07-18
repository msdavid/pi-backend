// @vitest-environment node
/**
 * DP-5 taught-command contract test (phase-3 review F4): the empty states
 * teach curl commands; this suite runs a representative one VERBATIM (the
 * agents create command — it carries all three hard-required headers:
 * bearer, `Idempotency-Key`, JSON content type) against the REAL in-process
 * backend, so a taught command that would fail for a user fails here first.
 *
 * The command string is extracted from the feature source (not duplicated),
 * so editing the taught snippet re-verifies it. Requires `curl` + `uuidgen`
 * on the host (present on CI images; skipped otherwise, like the container
 * gate). Run with `PI_REQUIRE_INTEGRATION=containers` in CI.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  requireContainers,
  startTestBackend,
  type TestBackend,
} from "./harness.js";

const exec = promisify(execFile);

const RUNTIME = requireContainers("web-console curl-snippets contract suite");

/** The taught command, verbatim from the agents empty state (DP-5). */
function agentsCreateCommand(): string {
  const source = readFileSync(
    new URL("../../features/agents/agents.lazy.tsx", import.meta.url),
    "utf8",
  );
  const match = source.match(/const CREATE_CLI = `(.+)`;/);
  if (!match) throw new Error("agents.lazy.tsx: CREATE_CLI not found");
  return match[1]!;
}

describe.skipIf(!RUNTIME)("DP-5 taught curl commands ↔ real backend", () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await startTestBackend();
  }, 120_000);

  afterAll(async () => {
    if (backend) await backend.stop();
  }, 120_000);

  it("the agents empty-state command works as taught (bearer + Idempotency-Key + JSON)", async () => {
    const command = agentsCreateCommand();
    // Only appended flags — the taught part runs untouched: silence the
    // progress meter and print the status code after the body.
    const { stdout } = await exec(
      "bash",
      ["-c", `${command} -s -w '\\n%{http_code}'`],
      {
        env: {
          ...process.env,
          PI_URL: backend.baseUrl,
          PI_KEY: backend.adminKey,
        },
      },
    );
    const lines = stdout.trim().split("\n");
    expect(lines.at(-1)).toBe("201");
    const agent = JSON.parse(lines.slice(0, -1).join("\n")) as {
      name?: string;
      status?: string;
    };
    expect(agent.name).toBe("reviewer");
    expect(agent.status).toBe("active");
  });
});
