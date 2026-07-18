import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StatusChip, statusTone } from "./status-chip.js";
import { axe } from "./test-utils.js";

describe("statusTone", () => {
  it("maps every lifecycle vocabulary onto the five tones", () => {
    // sessions (contracts SessionStatus)
    expect(statusTone("running")).toBe("running");
    expect(statusTone("rescheduling")).toBe("running");
    expect(statusTone("idle")).toBe("neutral");
    expect(statusTone("terminated")).toBe("neutral");
    // stop reasons (contracts StopReason)
    expect(statusTone("completed")).toBe("success");
    expect(statusTone("requires_action")).toBe("warning");
    expect(statusTone("budget_exhausted")).toBe("warning");
    expect(statusTone("user_interrupt")).toBe("warning");
    expect(statusTone("error")).toBe("danger");
    // jobs (contracts JobStatus) + resources (ResourceStatus)
    expect(statusTone("active")).toBe("success");
    expect(statusTone("paused")).toBe("warning");
    expect(statusTone("archived")).toBe("neutral");
    // outcomes (contracts OutcomeStatus)
    expect(statusTone("satisfied")).toBe("success");
    expect(statusTone("needs_revision")).toBe("warning");
    expect(statusTone("max_iterations_reached")).toBe("warning");
    expect(statusTone("interrupted")).toBe("warning");
    expect(statusTone("failed")).toBe("danger");
    // credential validity (contracts CredentialValidateResponse)
    expect(statusTone("valid")).toBe("success");
    expect(statusTone("invalid")).toBe("danger");
    expect(statusTone("unknown")).toBe("neutral");
  });

  it("falls back to neutral for statuses it has never seen", () => {
    expect(statusTone("some_future_state")).toBe("neutral");
  });
});

describe("StatusChip", () => {
  it("renders the status token verbatim (CLI vocabulary)", () => {
    render(<StatusChip status="requires_action" />);
    expect(screen.getByText("requires_action")).toBeInTheDocument();
  });

  it("has no axe violations across tones", async () => {
    const { container } = render(
      <div>
        <StatusChip status="running" />
        <StatusChip status="completed" />
        <StatusChip status="requires_action" />
        <StatusChip status="failed" />
        <StatusChip status="archived" />
      </div>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
