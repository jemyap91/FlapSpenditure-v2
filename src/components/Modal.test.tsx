import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Modal } from "./Modal";

/**
 * The native <dialog> element would supply focus trapping, Escape and a
 * backdrop for free — but jsdom 30 does not implement `showModal`, so every
 * test here would be exercising a polyfill rather than the behaviour that
 * ships. Hence an explicit implementation, and hence these tests: they run
 * the same code the browser runs.
 */
function Harness({ onClose = vi.fn() }: { onClose?: () => void }) {
  return (
    <Modal open title="Edit wallet" onClose={onClose}>
      <button type="button">First</button>
      <button type="button">Second</button>
    </Modal>
  );
}

describe("Modal", () => {
  it("renders nothing at all when closed", () => {
    render(
      <Modal open={false} title="Edit wallet" onClose={vi.fn()}>
        <button type="button">First</button>
      </Modal>,
    );

    // Not merely hidden: a display:none subtree still exposes its form
    // controls to some tooling, and a form nobody can see must not be
    // submittable. Same reasoning WalletList already applies to the
    // collapsed members panel.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "First" })).not.toBeInTheDocument();
  });

  it("exposes itself as a modal dialog named by its own title", () => {
    render(<Harness />);

    const dialog = screen.getByRole("dialog", { name: "Edit wallet" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Harness onClose={onClose} />);

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the backdrop is clicked, but not when the panel is", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Harness onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "First" }));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("modal-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the dialog on open", () => {
    render(<Harness />);

    // Focus must leave the trigger, or a screen reader user is still
    // "standing" outside the thing that just appeared.
    expect(screen.getByRole("dialog")).toHaveFocus();
  });

  /**
   * The assertion that makes this a modal rather than a floating div. Tab
   * from the last focusable element must return to the first, not escape
   * into the page behind — which is still rendered and still full of
   * controls the user cannot see.
   */
  it("keeps Tab inside the dialog", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Outside</button>
        <Harness />
      </>,
    );

    // The dialog's own Close button is the FIRST tabbable — it precedes
    // the children in DOM order — so the cycle is Close, First, Second,
    // Close. Asserting the whole cycle rather than just "not Outside"
    // pins the wrap-around itself.
    const close = screen.getByRole("button", { name: "Close" });
    const first = screen.getByRole("button", { name: "First" });
    const second = screen.getByRole("button", { name: "Second" });

    await user.tab();
    expect(close).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();
    await user.tab();
    expect(second).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();

    expect(screen.getByRole("button", { name: "Outside" })).not.toHaveFocus();
  });

  it("returns focus to whatever was focused before it opened", async () => {
    const user = userEvent.setup();
    function Toggle() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <Modal open={open} title="Edit wallet" onClose={() => setOpen(false)}>
            <button type="button">First</button>
          </Modal>
        </>
      );
    }
    render(<Toggle />);

    const trigger = screen.getByRole("button", { name: "Open" });
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toHaveFocus();

    await user.keyboard("{Escape}");

    expect(trigger).toHaveFocus();
  });
});
