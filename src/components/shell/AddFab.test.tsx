import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AddFab } from "./AddFab";

const { usePathname } = vi.hoisted(() => ({ usePathname: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname }));

function at(path: string) {
  usePathname.mockReturnValue(path);
  return render(<AddFab />);
}

/**
 * The global add-transaction button, replacing the mobile tab bar's "Add"
 * entry (2026-08-29). Its whole substance is WHERE it appears: a second
 * bottom-right button on a screen that already has one is not a cosmetic
 * problem, it is two overlapping tap targets.
 */
describe("AddFab", () => {
  it("offers a named link to the add-transaction screen", () => {
    at("/");

    const link = screen.getByRole("link", { name: "Add a transaction" });
    expect(link).toHaveAttribute("href", "/transactions/new");
  });

  it("appears on the main list screens", () => {
    for (const path of ["/", "/transactions", "/wallets", "/budgets", "/categories"]) {
      const { unmount } = at(path);
      expect(screen.getByRole("link", { name: "Add a transaction" })).toBeInTheDocument();
      unmount();
    }
  });

  /**
   * A wallet's own detail page already renders WalletFab in this exact
   * corner, and that one is strictly better there: it preselects the wallet
   * and returns the user to it after saving. Two fixed buttons at
   * `bottom-24 right-6` would sit on top of each other, with only DOM order
   * deciding which one the tap actually reached.
   */
  it("stays out of the way on a wallet's own page, which has its own button", () => {
    at("/wallets/8f2b1c4e-0000-4000-8000-000000000000");

    expect(screen.queryByRole("link", { name: "Add a transaction" })).not.toBeInTheDocument();
  });

  /** Pointless where it leads: the form is already on screen. */
  it("does not render on the add-transaction screen itself", () => {
    at("/transactions/new");

    expect(screen.queryByRole("link", { name: "Add a transaction" })).not.toBeInTheDocument();
  });

  /**
   * `/wallets` must KEEP the button while `/wallets/<id>` loses it — a
   * naive `startsWith("/wallets")` would take it off both. This is the same
   * prefix-collision the nav's own isActive() exists for.
   */
  it("distinguishes the wallets list from a single wallet", () => {
    const { unmount } = at("/wallets");
    expect(screen.getByRole("link", { name: "Add a transaction" })).toBeInTheDocument();
    unmount();

    at("/wallets/abc");
    expect(screen.queryByRole("link", { name: "Add a transaction" })).not.toBeInTheDocument();
  });

  /**
   * Caught by axe in e2e before this test existed: rendered in the layout
   * as a bare <a>, it was a sibling of <main> and <nav> and so belonged to
   * no landmark — invisible to anyone navigating by region.
   */
  it("lives inside a named landmark", () => {
    at("/");

    const nav = screen.getByRole("navigation", { name: "Quick actions" });
    expect(nav).toContainElement(screen.getByRole("link", { name: "Add a transaction" }));
  });

  it("is hidden from desktop, where the sidebar still carries Add", () => {
    at("/");

    // The sidebar's Add entry was added deliberately (see Sidebar.tsx's own
    // comment: without it /transactions/new was unreachable on desktop
    // except by typing the URL), so this button is a mobile affordance
    // only and must not duplicate it.
    expect(screen.getByRole("link", { name: "Add a transaction" }).className).toContain("md:hidden");
  });
});
