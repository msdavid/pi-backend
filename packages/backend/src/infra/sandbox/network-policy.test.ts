/**
 * Network-policy compiler unit tests (WP-1.3, §6.2, §10.5, Appendix A.1 #3).
 *
 * Pure-JS: no KVM or msb runtime required — `compileNetworkPolicy` returns plain
 * SDK `NetworkPolicy` value objects.
 */

import { describe, expect, it } from "vitest";
import { NetworkPolicy } from "microsandbox";
import { compileNetworkPolicy, unrestrictedIsPublicOnly } from "./network-policy.js";

describe("compileNetworkPolicy", () => {
  describe("unrestricted", () => {
    it("compiles to the publicOnly() preset (NOT allowAll)", () => {
      const np = compileNetworkPolicy({ mode: "unrestricted" });
      const preset = NetworkPolicy.publicOnly();
      expect(np).toEqual(preset);
    });

    it("is distinct from allowAll()", () => {
      const np = compileNetworkPolicy({ mode: "unrestricted" });
      const allowAll = NetworkPolicy.allowAll();
      expect(np).not.toEqual(allowAll);
    });

    it("denies egress to private/loopback/metadata/host by default", () => {
      const np = compileNetworkPolicy({ mode: "unrestricted" });
      // publicOnly() default-egress is deny with an explicit public-allow rule;
      // allowAll() would default-allow everything.
      expect(np.defaultEgress).toBe("deny");
      const hasPublicAllow = np.rules.some(
        (r) =>
          r.action === "allow" &&
          r.direction === "egress" &&
          r.destination.kind === "group" &&
          r.destination.group === "public",
      );
      expect(hasPublicAllow).toBe(true);
    });

    it("unrestrictedIsPublicOnly() helper holds", () => {
      expect(unrestrictedIsPublicOnly()).toBe(true);
    });
  });

  describe("limited", () => {
    it("is default-deny on egress", () => {
      const np = compileNetworkPolicy({
        mode: "limited",
        allowedHosts: ["api.example.com"],
      });
      expect(np.defaultEgress).toBe("deny");
    });

    it("is default-deny on ingress", () => {
      const np = compileNetworkPolicy({
        mode: "limited",
        allowedHosts: ["api.example.com"],
      });
      expect(np.defaultIngress).toBe("deny");
    });

    it("adds one egress-allow rule per allowedHost", () => {
      const hosts = ["api.openai.com", "files.example.com", "registry.acme.io"];
      const np = compileNetworkPolicy({ mode: "limited", allowedHosts: hosts });
      const allowRules = np.rules.filter((r) => r.action === "allow");
      expect(allowRules).toHaveLength(hosts.length);
      for (const r of allowRules) {
        expect(r.direction).toBe("egress");
        expect(r.destination.kind).toBe("domain");
        expect(hosts).toContain(r.destination.domain);
      }
    });

    it("denies a host not in allowedHosts", () => {
      const np = compileNetworkPolicy({
        mode: "limited",
        allowedHosts: ["api.openai.com"],
      });
      const allowed = np.rules.filter(
        (r) =>
          r.action === "allow" &&
          r.destination.kind === "domain" &&
          r.destination.domain === "evil.example.com",
      );
      expect(allowed).toHaveLength(0);
    });

    it("produces no allow rules when allowedHosts is empty", () => {
      const np = compileNetworkPolicy({ mode: "limited", allowedHosts: [] });
      expect(np.rules).toEqual([]);
      expect(np.defaultEgress).toBe("deny");
    });
  });

  it("unrestricted and limited with the same hosts differ", () => {
    const unrestricted = compileNetworkPolicy({ mode: "unrestricted" });
    const limited = compileNetworkPolicy({
      mode: "limited",
      allowedHosts: ["api.example.com"],
    });
    expect(unrestricted).not.toEqual(limited);
  });
});
