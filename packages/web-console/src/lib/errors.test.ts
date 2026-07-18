import { describe, expect, it } from "vitest";

import { ConsoleApiError } from "../api/client.js";
import { errorDocsUrl, errorSummary } from "./errors.js";

describe("errorSummary (DP-9)", () => {
  it("appends the machine code and request id to an API error", () => {
    const error = new ConsoleApiError("Session not found.", {
      status: 404,
      code: "not_found",
      requestId: "req_01TEST",
    });
    expect(errorSummary(error)).toBe(
      "Session not found. (not_found · req_01TEST)",
    );
  });

  it("falls back to the bare message when the envelope carried no facts", () => {
    expect(errorSummary(new ConsoleApiError("request failed"))).toBe(
      "request failed",
    );
  });

  it("renders plain Errors and non-Errors", () => {
    expect(errorSummary(new Error("boom"))).toBe("boom");
    expect(errorSummary("boom")).toBe("boom");
  });

  it("errorDocsUrl points at the api-reference error-envelope section", () => {
    expect(errorDocsUrl()).toBe(
      "https://github.com/msdavid/pi-backend/blob/main/docs/api-reference.md#error-envelope",
    );
  });
});
