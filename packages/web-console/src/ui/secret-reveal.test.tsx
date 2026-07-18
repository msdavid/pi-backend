import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SecretReveal } from "./secret-reveal.js";
import { axe } from "./test-utils.js";

const SECRET = "pmb_live_TESTREVEALNOTASECRET";

describe("SecretReveal — checkbox gate (default)", () => {
  it("renders the standard warning, the secret, and gates Done on the acknowledgement", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<SecretReveal label="API key" secret={SECRET} onConfirm={onConfirm} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/exactly once/);
    expect(screen.getByText(SECRET)).toBeInTheDocument();

    const done = screen.getByRole("button", { name: "Done" });
    expect(done).toBeDisabled();
    await user.click(done);
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("checkbox", { name: /I have stored this API key/ }),
    );
    expect(done).toBeEnabled();
    await user.click(done);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("Copy writes the secret to the clipboard and flips to Copied", async () => {
    const user = userEvent.setup();
    render(<SecretReveal label="API key" secret={SECRET} onConfirm={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await window.navigator.clipboard.readText()).toBe(SECRET);
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("custom copy label, confirm text/label, warning slot and locked reason", async () => {
    const user = userEvent.setup();
    render(
      <SecretReveal
        label="admin API key"
        secret={SECRET}
        copyLabel="Copy admin API key"
        warning={null}
        confirmText="I copied the key and stored it somewhere safe."
        confirmLabel="Continue to the console"
        lockedReason="Confirm you stored the key to continue — it cannot be shown again."
        onConfirm={() => {}}
      />,
    );
    // `warning={null}`: the caller's surrounding copy carries the warning.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy admin API key" }),
    ).toBeInTheDocument();

    const proceed = screen.getByRole("button", {
      name: "Continue to the console",
    });
    expect(proceed).toBeDisabled();
    // §6.1: the locked reason is visible AND the button's description.
    expect(proceed).toHaveAccessibleDescription(
      "Confirm you stored the key to continue — it cannot be shown again.",
    );
    await user.click(
      screen.getByRole("checkbox", {
        name: /I copied the key and stored it somewhere safe/,
      }),
    );
    expect(proceed).toBeEnabled();
    // Unlocked: the reason disappears.
    expect(
      screen.queryByText(/Confirm you stored the key to continue/),
    ).not.toBeInTheDocument();
  });

  it("confirmPending keeps proceed disabled even when acknowledged", async () => {
    const user = userEvent.setup();
    render(
      <SecretReveal
        label="API key"
        secret={SECRET}
        confirmPending
        onConfirm={() => {}}
      />,
    );
    await user.click(
      screen.getByRole("checkbox", { name: /I have stored this API key/ }),
    );
    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
  });
});

describe("SecretReveal — copy gate", () => {
  it("proceed unlocks on Copy (no checkbox) and does not re-lock when the Copied feedback resets", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <SecretReveal
        label="worker key"
        secret={SECRET}
        confirmVia="copy"
        confirmLabel="I've stored the key"
        lockedReason="copy the key first — it will not be shown again"
        onConfirm={onConfirm}
      />,
    );
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    const proceed = screen.getByRole("button", { name: "I've stored the key" });
    expect(proceed).toBeDisabled();
    expect(proceed).toHaveAccessibleDescription(
      "copy the key first — it will not be shown again",
    );

    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await window.navigator.clipboard.readText()).toBe(SECRET);
    expect(proceed).toBeEnabled();
    await user.click(proceed);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("accessibility", () => {
  it("is axe-clean in both gate modes", async () => {
    const checkbox = render(
      <SecretReveal
        label="API key"
        secret={SECRET}
        note="Use it as the Authorization bearer."
        lockedReason="confirm you stored it first"
        onConfirm={() => {}}
      />,
    );
    expect(await axe(checkbox.container)).toHaveNoViolations();
    checkbox.unmount();

    const copyGate = render(
      <SecretReveal
        label="worker key"
        secret={SECRET}
        confirmVia="copy"
        lockedReason="copy the key first"
        onConfirm={() => {}}
      />,
    );
    expect(await axe(copyGate.container)).toHaveNoViolations();
  });
});
