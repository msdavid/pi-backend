import { describe, it, expect } from "vitest";
import { loadConfig, ConfigSchema } from "./index.js";

describe("ConfigSchema defaults", () => {
  it("applies all defaults for an empty object", () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.port).toBe(3000);
    expect(cfg.logLevel).toBe("info");
    expect(cfg.dbUrl).toBeUndefined();
    expect(cfg.objectStoreRoot).toBe("./data/objectstore");
    expect(cfg.sandboxRuntime).toBe("disabled");
  });
});

describe("loadConfig precedence", () => {
  it("uses defaults when no env or file provided", () => {
    const cfg = loadConfig({ env: {} });
    expect(cfg.port).toBe(3000);
    expect(cfg.logLevel).toBe("info");
    expect(cfg.objectStoreRoot).toBe("./data/objectstore");
    expect(cfg.sandboxRuntime).toBe("disabled");
  });

  it("file overrides defaults", () => {
    const cfg = loadConfig({
      env: {},
      file: { port: 4000, logLevel: "debug", objectStoreRoot: "/data/oss" },
    });
    expect(cfg.port).toBe(4000);
    expect(cfg.logLevel).toBe("debug");
    expect(cfg.objectStoreRoot).toBe("/data/oss");
  });

  it("env overrides file", () => {
    const cfg = loadConfig({
      env: { PORT: "5000", LOG_LEVEL: "warn" },
      file: { port: 4000, logLevel: "debug" },
    });
    expect(cfg.port).toBe(5000);
    expect(cfg.logLevel).toBe("warn");
  });

  it("env overrides defaults when no file", () => {
    const cfg = loadConfig({
      env: { DB_URL: "postgres://u:p@localhost:5432/db", SANDBOX_RUNTIME: "enabled" },
    });
    expect(cfg.dbUrl).toBe("postgres://u:p@localhost:5432/db");
    expect(cfg.sandboxRuntime).toBe("enabled");
  });

  it("file fields not present in env keep file value", () => {
    const cfg = loadConfig({
      env: { PORT: "9000" },
      file: { objectStoreRoot: "/from/file", logLevel: "error" },
    });
    expect(cfg.port).toBe(9000); // env wins
    expect(cfg.objectStoreRoot).toBe("/from/file"); // file retained
    expect(cfg.logLevel).toBe("error"); // file retained
  });

  it("CONSOLE_MODE passes through from env and defaults to unset (derived downstream)", () => {
    expect(loadConfig({ env: {} }).consoleMode).toBeUndefined();
    expect(loadConfig({ env: { CONSOLE_MODE: "team" } }).consoleMode).toBe("team");
    expect(loadConfig({ env: {}, file: { consoleMode: "saas" } }).consoleMode).toBe("saas");
  });

  it("CONSOLE_SESSION_TTL passes through from env as seconds and defaults to unset", () => {
    expect(loadConfig({ env: {} }).consoleSessionTtl).toBeUndefined();
    expect(loadConfig({ env: { CONSOLE_SESSION_TTL: "3600" } }).consoleSessionTtl).toBe(3600);
    expect(loadConfig({ env: {}, file: { consoleSessionTtl: 60 } }).consoleSessionTtl).toBe(60);
  });

  it("OTEL fields pass through from env", () => {
    const cfg = loadConfig({
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
        OTEL_SERVICE_NAME: "backend-test",
      },
    });
    expect(cfg.otelExporterOtlpEndpoint).toBe("http://localhost:4318");
    expect(cfg.otelServiceName).toBe("backend-test");
  });
});

describe("loadConfig fatal errors", () => {
  // Capture exit + stderr to assert fatal handling without killing the test run.
  function withFatalCaptured<T>(fn: () => T): T {
    const exit = process.exit;
    const err = console.error;
    let exitCode: number | undefined;
    let errOut = "";
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never;
    console.error = ((...args: unknown[]) => {
      errOut += args.join(" ") + "\n";
    }) as never;
    try {
      return fn();
    } finally {
      process.exit = exit;
      console.error = err;
      void exitCode;
      void errOut;
    }
  }

  it("exits with code 1 on an invalid port", () => {
    expect(() =>
      withFatalCaptured(() => loadConfig({ env: { PORT: "not-a-number" } })),
    ).toThrow(/__exit_1__/);
  });

  it("exits with code 1 on an unknown log level", () => {
    expect(() =>
      withFatalCaptured(() => loadConfig({ env: { LOG_LEVEL: "verbose" } })),
    ).toThrow(/__exit_1__/);
  });

  it("exits with code 1 on an unknown sandbox runtime", () => {
    expect(() =>
      withFatalCaptured(() => loadConfig({ env: { SANDBOX_RUNTIME: "maybe" } })),
    ).toThrow(/__exit_1__/);
  });

  it("exits with code 1 on an unknown console mode", () => {
    expect(() =>
      withFatalCaptured(() => loadConfig({ env: { CONSOLE_MODE: "enterprise" } })),
    ).toThrow(/__exit_1__/);
  });

  it("exits with code 1 on a non-numeric CONSOLE_SESSION_TTL (NaN is rejected, not silent)", () => {
    expect(() =>
      withFatalCaptured(() => loadConfig({ env: { CONSOLE_SESSION_TTL: "abc" } })),
    ).toThrow(/__exit_1__/);
  });

  it("exits with code 1 on a non-positive CONSOLE_SESSION_TTL", () => {
    expect(() =>
      withFatalCaptured(() => loadConfig({ env: { CONSOLE_SESSION_TTL: "0" } })),
    ).toThrow(/__exit_1__/);
  });
});
