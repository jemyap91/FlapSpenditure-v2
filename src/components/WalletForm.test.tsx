import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WalletForm } from "./WalletForm";
import type { WalletState } from "@/server/actions/wallets";

/**
 * Covers WalletForm's EDIT mode, added 2026-08-28. Creation was already
 * exercised end-to-end by e2e/ledger.spec.ts; what is new here is that the
 * same component now seeds itself from an existing wallet and locks the
 * currency, and both of those are invisible to an e2e test that only ever
 * creates.
 *
 * Assertions are on the FormData the action receives, not on the visible
 * controls. WalletForm deliberately submits `kind`/`currency_code` through
 * hidden inputs because the native radio/select revert after a failed
 * submission (see that component's long comment) — so a test that read the
 * visible controls would be reading exactly the values the component does
 * not trust.
 */
const DEFAULTS = {
  name: "Citi Rewards",
  kind: "card",
  currency_code: "SGD",
  starting_balance: "620.00",
  color_slot: 2,
  icon: "credit-card",
} as const;

function renderEdit(action: (prev: WalletState, fd: FormData) => Promise<WalletState>) {
  return render(
    <WalletForm
      action={action}
      submitLabel="Save changes"
      pendingLabel="Saving…"
      defaultCurrency="SGD"
      defaults={DEFAULTS}
      lockCurrency
    />,
  );
}

describe("WalletForm in edit mode", () => {
  it("seeds every field from the wallet being edited", async () => {
    const seen: FormData[] = [];
    const action = vi.fn(async (_p: WalletState, fd: FormData) => {
      seen.push(fd);
      return {};
    });
    const user = userEvent.setup();
    renderEdit(action);

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const fd = seen[0]!;
    expect(fd.get("name")).toBe("Citi Rewards");
    expect(fd.get("kind")).toBe("card");
    expect(fd.get("currency_code")).toBe("SGD");
    expect(fd.get("starting_balance")).toBe("620.00");
    // Preserved, not reset to the creation default of 1 — editing a wallet
    // must not silently repaint it.
    expect(fd.get("color_slot")).toBe("2");
  });

  it("submits an edited opening balance", async () => {
    const seen: FormData[] = [];
    const action = vi.fn(async (_p: WalletState, fd: FormData) => {
      seen.push(fd);
      return {};
    });
    const user = userEvent.setup();
    renderEdit(action);

    const balance = screen.getByLabelText(/Starting balance/i);
    await user.clear(balance);
    await user.type(balance, "700.00");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(seen[0]!.get("starting_balance")).toBe("700.00");
  });

  /**
   * The currency lock. It is a product rule with a data-integrity reason:
   * a wallet's stored minor units are meaningless under a different
   * currency. The visible control must be gone — not merely disabled,
   * which would read as "changeable if something else changed" — while the
   * hidden input still carries the value, because walletInput needs it to
   * pick the minor unit when validating the balance.
   */
  it("offers no currency control, but still submits the wallet's currency", async () => {
    const seen: FormData[] = [];
    const action = vi.fn(async (_p: WalletState, fd: FormData) => {
      seen.push(fd);
      return {};
    });
    const user = userEvent.setup();
    renderEdit(action);

    expect(screen.queryByRole("combobox", { name: /Currency/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(seen[0]!.get("currency_code")).toBe("SGD");
  });

  it("says why the balance is a starting figure rather than the current one", () => {
    renderEdit(vi.fn(async () => ({})));

    // The one thing a user could reasonably misread: they typed a number
    // and the balance moved, but it is the OPENING figure they set, with
    // transactions still applied on top.
    expect(screen.getByText(/transactions are still added on top/i)).toBeInTheDocument();
  });

  it("still offers the currency select when creating", () => {
    render(
      <WalletForm
        action={vi.fn(async () => ({}))}
        submitLabel="Add wallet"
        pendingLabel="Adding…"
        defaultCurrency="SGD"
      />,
    );

    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.queryByText(/transactions are still added on top/i)).not.toBeInTheDocument();
  });
});
