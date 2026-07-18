import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Button } from "./button.js";
import { ToastProvider, useToast } from "./toast.js";
import type { ToastOptions } from "./toast.js";
import { axe } from "./test-utils.js";

function Trigger(props: ToastOptions) {
  const { toast } = useToast();
  return <Button onClick={() => toast(props)}>Notify</Button>;
}

function renderWithProvider(options: ToastOptions) {
  return render(
    <ToastProvider>
      <Trigger {...options} />
    </ToastProvider>,
  );
}

describe("ToastProvider / useToast", () => {
  it("throws when useToast is used outside the provider", () => {
    // Silence React's error boundary noise for the expected throw.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Trigger message="x" />)).toThrow(
      /within a <ToastProvider>/,
    );
    spy.mockRestore();
  });

  it("shows an info toast as a polite status and dismisses on click", async () => {
    const user = userEvent.setup();
    renderWithProvider({ message: "Key created." });

    await user.click(screen.getByRole("button", { name: "Notify" }));
    expect(screen.getByRole("status")).toHaveTextContent("Key created.");

    await user.click(
      screen.getByRole("button", { name: "Dismiss notification" }),
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows danger toasts as alerts that never auto-dismiss", async () => {
    const user = userEvent.setup();
    renderWithProvider({ message: "Archive failed.", tone: "danger" });

    await user.click(screen.getByRole("button", { name: "Notify" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Archive failed.");
  });

  describe("auto-dismiss", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("removes info toasts after their duration", async () => {
      renderWithProvider({ message: "Saved.", durationMs: 1000 });

      // fireEvent, not user-event: the subject here is the timer behavior,
      // and user-event's own delays fight the fake clock.
      fireEvent.click(screen.getByRole("button", { name: "Notify" }));
      expect(screen.getByRole("status")).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });
      expect(screen.queryByRole("status")).toBeNull();
    });
  });

  it("has no axe violations with toasts shown", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProvider({ message: "Key created." });
    await user.click(screen.getByRole("button", { name: "Notify" }));
    expect(await axe(container)).toHaveNoViolations();
  });
});
