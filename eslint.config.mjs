// ESLint flat config (eslint 9+). Minimal rule set per WP-0.1.
import path from "node:path";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/**
 * R1.3 — "No fake may stand in for the thing under test."
 *
 * Fakes are legitimate for COLLABORATORS, never for the SUBJECT. A test that stubs the
 * transport and then asserts the request its own client produced proves nothing and
 * *enshrines* the bug — that is literally how the SSE 404 (R3.1) shipped: the client
 * streamed `…/events/stream`, the backend served `…/stream`, and the client test stayed
 * green because it asserted against its own stub.
 *
 * This local rule makes plan rule §0.2 enforceable rather than aspirational. It is
 * deliberately narrow (low false-positive) and flags three shapes inside test files:
 *
 *   1. Replacing the global transport: `globalThis.fetch = …`, `vi.stubGlobal("fetch", …)`,
 *      `vi.spyOn(globalThis, "fetch")`.
 *   2. `vi.mock()` of the *module under test* — subject inferred from the test filename
 *      (`foo.test.ts` → any specifier whose basename is `foo`). Mocking a *collaborator*
 *      module is untouched.
 *   3. (Opt-in per config block, via `bannedTransportProps`.) Injecting a fake transport
 *      into the subject — e.g. `fetchImpl:` in the client↔server seam tests, where the
 *      seam itself is the subject and both sides must therefore be real (R3.2).
 *
 * Escape hatch: a `// seam-ok: <reason>` comment on the offending line, on the line
 * directly above it, or in the file's top-of-file comment block. The reason is mandatory —
 * it is what a reviewer reads to decide whether the fake really is standing in for a
 * collaborator. See CONVENTIONS.md, "Fakes at the seam under test (R1.3)".
 */

const SEAM_OK = /seam-ok:\s*\S/;
const GLOBAL_OBJECTS = ["globalThis", "global", "window"];

/** `globalThis.fetch` / `global.fetch` / `window.fetch` as a member expression. */
function isGlobalFetchMember(node) {
  return (
    node?.type === "MemberExpression" &&
    node.object?.type === "Identifier" &&
    GLOBAL_OBJECTS.includes(node.object.name) &&
    node.property?.type === "Identifier" &&
    node.property.name === "fetch"
  );
}

/** `vi.foo(...)` / `vitest.foo(...)` → "foo", else null. */
function viCallName(node) {
  const c = node.callee;
  if (
    c?.type === "MemberExpression" &&
    c.object?.type === "Identifier" &&
    ["vi", "vitest"].includes(c.object.name) &&
    c.property?.type === "Identifier"
  ) {
    return c.property.name;
  }
  return null;
}

function literalString(node) {
  return node?.type === "Literal" && typeof node.value === "string" ? node.value : null;
}

/** "../api-client.js" → "api-client". */
function moduleBaseName(spec) {
  return path.basename(spec).replace(/\.(m|c)?[jt]sx?$/, "");
}

/** "src/api-client.test.ts" → "api-client" (the subject the test names itself after). */
function subjectOf(filename) {
  const m = path.basename(filename).match(/^(.*?)\.(test|spec)\.(m|c)?[jt]sx?$/);
  return m ? m[1] : null;
}

const noFakeAtSeam = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid faking the boundary a test names as its subject (remediation plan R1.3).",
    },
    schema: [
      {
        type: "object",
        properties: {
          bannedTransportProps: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      globalFetch:
        "Do not replace the global `fetch` in a test ({{how}}). A test that stubs the transport and then asserts the request its own code produced proves nothing — it enshrines the bug (this is how the SSE 404 shipped). Drive the real boundary (in-process Fastify app, or a real local server); if `fetch` is genuinely a collaborator here and not the subject, justify it with `// seam-ok: <reason>`.",
      subjectMock:
        '{{fn}}("{{spec}}") mocks the module this test is named after — the subject may not be its own fake. Exercise the real module; if this specifier is a collaborator that merely shares its name, annotate with `// seam-ok: <reason>`.',
      transportProp:
        "`{{prop}}` injects a fake transport into a seam/contract test, whose entire purpose is that both sides of the boundary are real (R3.2). Run it against the real in-process backend, or annotate with `// seam-ok: <reason>`.",
    },
  },
  create(context) {
    const bannedTransportProps = new Set(context.options[0]?.bannedTransportProps ?? []);
    const src = context.sourceCode ?? context.getSourceCode();
    const subject = subjectOf(context.filename ?? context.getFilename());

    // File-scoped opt-out: a `seam-ok:` comment in the top-of-file comment block, i.e.
    // anywhere before the first statement.
    const firstStatementLine = src.ast.body[0]?.loc.start.line ?? Infinity;
    const comments = src.getAllComments();
    const fileScoped = comments.some(
      (c) => c.loc.end.line < firstStatementLine && SEAM_OK.test(c.value),
    );

    /** A `seam-ok:` comment on the node's line or the line directly above it. */
    function annotated(node) {
      if (fileScoped) return true;
      const { line } = node.loc.start;
      return comments.some(
        (c) =>
          SEAM_OK.test(c.value) &&
          (c.loc.end.line === line || c.loc.end.line === line - 1),
      );
    }

    function report(node, messageId, data) {
      if (annotated(node)) return;
      context.report({ node, messageId, data });
    }

    return {
      AssignmentExpression(node) {
        if (isGlobalFetchMember(node.left)) {
          report(node, "globalFetch", { how: "assignment to globalThis.fetch" });
        }
      },
      CallExpression(node) {
        const fn = viCallName(node);
        if (!fn) return;

        if (fn === "stubGlobal" && literalString(node.arguments[0]) === "fetch") {
          report(node, "globalFetch", { how: 'vi.stubGlobal("fetch", …)' });
          return;
        }
        if (
          fn === "spyOn" &&
          node.arguments[0]?.type === "Identifier" &&
          GLOBAL_OBJECTS.includes(node.arguments[0].name) &&
          literalString(node.arguments[1]) === "fetch"
        ) {
          report(node, "globalFetch", { how: 'vi.spyOn(globalThis, "fetch")' });
          return;
        }
        if ((fn === "mock" || fn === "doMock") && subject) {
          const spec = literalString(node.arguments[0]);
          if (spec && moduleBaseName(spec) === subject) {
            report(node, "subjectMock", { fn: `vi.${fn}`, spec });
          }
        }
      },
      Property(node) {
        if (bannedTransportProps.size === 0) return;
        const name =
          node.key?.type === "Identifier" ? node.key.name : literalString(node.key);
        if (name && bannedTransportProps.has(name)) {
          report(node, "transportProp", { prop: name });
        }
      },
    };
  },
};

const seamPlugin = { rules: { "no-fake-at-seam": noFakeAtSeam } };

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.tsbuildinfo",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "prefer-const": "error",
    },
  },
  // R1.3 — no fake may stand in for the thing under test. Every test file.
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"],
    plugins: { seam: seamPlugin },
    rules: { "seam/no-fake-at-seam": "error" },
  },
  // Seam/contract tests: the boundary IS the subject, so a faked transport is never
  // legitimate here — these run against the real in-process backend (R3.2).
  {
    files: [
      "packages/client-extension/src/api-client.test.ts",
      "packages/client-extension/src/**/*contract*.test.ts",
      "packages/client-extension/src/**/*conformance*.test.ts",
    ],
    plugins: { seam: seamPlugin },
    rules: {
      "seam/no-fake-at-seam": ["error", { bannedTransportProps: ["fetchImpl"] }],
    },
  },
  prettier,
);
