/** Scope semantics mirror the backend scope middleware (`admin` = wildcard). */
import { describe, expect, it } from "vitest";

import { canWrite, isAdmin, isReadOnly } from "./scopes.js";

describe("scopes", () => {
  it("read-only keys can only browse", () => {
    expect(isReadOnly(["read"])).toBe(true);
    expect(canWrite(["read"])).toBe(false);
    expect(isAdmin(["read"])).toBe(false);
  });

  it("write grants mutation but not admin", () => {
    expect(isReadOnly(["read", "write"])).toBe(false);
    expect(canWrite(["read", "write"])).toBe(true);
    expect(isAdmin(["read", "write"])).toBe(false);
  });

  it("admin is the wildcard: it implies write", () => {
    expect(canWrite(["admin"])).toBe(true);
    expect(isAdmin(["admin"])).toBe(true);
    expect(isReadOnly(["admin"])).toBe(false);
  });

  it("a worker-scoped key holds none of read/write/admin", () => {
    expect(isReadOnly(["self_hosted_worker:env_x"])).toBe(true);
    expect(isAdmin(["self_hosted_worker:env_x"])).toBe(false);
  });
});
