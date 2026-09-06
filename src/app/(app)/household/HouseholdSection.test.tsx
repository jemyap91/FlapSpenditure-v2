// src/app/(app)/household/HouseholdSection.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HouseholdSection } from "./HouseholdSection";
import { leaveHousehold, removeHouseholdMember } from "@/server/actions/household";

vi.mock("@/server/actions/household", () => ({
  leaveHousehold: vi.fn(),
  removeHouseholdMember: vi.fn(),
  revokeHouseholdInvite: vi.fn(),
  inviteToHousehold: vi.fn(),
  setWalletSharing: vi.fn(),
}));

const space = { id: "s1", name: "alice household" };
const members = [
  { user_id: "u-alice", display_name: "alice", role: "owner" as const },
  { user_id: "u-bob", display_name: "bob", role: "member" as const },
];
const wallets = [
  { id: "w1", name: "Everyday", owner_id: "u-alice", shared_with_household: true, archived_at: null },
  { id: "w2", name: "Bob private", owner_id: "u-bob", shared_with_household: false, archived_at: null },
];
const access = [
  { wallet_id: "w1", user_id: "u-alice", via: "owner" as const },
  { wallet_id: "w1", user_id: "u-bob", via: "household" as const },
  { wallet_id: "w2", user_id: "u-bob", via: "owner" as const },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(leaveHousehold).mockResolvedValue({ notice: "You left the household." });
  vi.mocked(removeHouseholdMember).mockResolvedValue({ notice: "Removed from the household." });
});

describe("HouseholdSection as the owner", () => {
  const props = { space, currentUserId: "u-alice", members, wallets, access, pendingInvites: [{ id: "i1", invited_email: "pat@x.io" }], single: true };

  it("offers invite, revoke and remove, but never remove on themselves", () => {
    render(<HouseholdSection {...props} />);
    expect(screen.getByLabelText("Invite by email")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke invitation to pat@x.io" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove bob from the household" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove alice from the household" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Leave household" })).not.toBeInTheDocument();

    // A list named "members" must contain only members — the pending
    // invitee lives in its own list right after it.
    expect(
      within(screen.getByRole("list", { name: "alice household members" })).getAllByRole("listitem"),
    ).toHaveLength(2);
    const invitations = within(screen.getByRole("list", { name: "alice household invitations" }));
    expect(invitations.getAllByRole("listitem")).toHaveLength(1);
    expect(invitations.getByText("pat@x.io")).toBeInTheDocument();
  });

  it("asks before removing, and says what goes with them", async () => {
    const user = userEvent.setup();
    render(<HouseholdSection {...props} />);
    await user.click(screen.getByRole("button", { name: "Remove bob from the household" }));
    const dialog = screen.getByRole("dialog", { name: "Remove bob?" });
    // "a household of their own", not "a new household": leave_space reuses
    // the household they already own from signup (spec §11, departure 3).
    expect(dialog).toHaveTextContent("Wallets bob owns go with them into a household of their own");
    expect(removeHouseholdMember).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(removeHouseholdMember).toHaveBeenCalledWith("s1", "u-bob");
    expect(await screen.findByText("Removed from the household.")).toBeInTheDocument();
  });

  it("renders the sharing grid with editable rows only for wallets the viewer owns", () => {
    render(<HouseholdSection {...props} />);
    const grid = screen.getByRole("table", { name: "Who can see which wallet" });
    expect(within(grid).getByRole("switch", { name: "Share Everyday with the whole household" })).toBeChecked();
    expect(within(grid).queryByRole("switch", { name: "Share Bob private with the whole household" })).not.toBeInTheDocument();
    expect(within(grid).getByText("bob · via household")).toBeInTheDocument();
  });

  /**
   * The confirm panel is a dialog, so it must behave like one for a
   * keyboard: focus moves into it on open, Escape dismisses it, and the
   * control that opened it gets focus back. Before this, focus stayed on
   * the Remove button behind a panel the user could neither reach nor
   * dismiss without a mouse.
   */
  it("focuses the confirm button on open, closes on Escape without acting, and restores focus", async () => {
    const user = userEvent.setup();
    render(<HouseholdSection {...props} />);
    const opener = screen.getByRole("button", { name: "Remove bob from the household" });

    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Remove bob?" });
    expect(within(dialog).getByRole("button", { name: "Remove" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(removeHouseholdMember).not.toHaveBeenCalled();
    expect(opener).toHaveFocus();
  });

  it("returns focus to the opener when the confirm is cancelled", async () => {
    const user = userEvent.setup();
    render(<HouseholdSection {...props} />);
    const opener = screen.getByRole("button", { name: "Remove bob from the household" });

    await user.click(opener);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(removeHouseholdMember).not.toHaveBeenCalled();
    expect(opener).toHaveFocus();
  });

  /**
   * WalletSharingRow copies `householdShared` and the direct-share set into
   * local state on mount, so an unsaved edit survives an unrelated
   * re-render. That made it deaf to NEW server data: after a successful
   * save elsewhere, a revalidation re-renders this section with different
   * sharing and the row went on showing the copy it made at mount. The row
   * is keyed on the sharing it is handed, so new data remounts it.
   *
   * This is the discriminating half: the switch and the per-person checkbox
   * are the two controls fed from local state, so only they can go stale.
   */
  it("follows new sharing state on rerender instead of the copy made at mount", () => {
    const { rerender } = render(<HouseholdSection {...props} />);
    expect(screen.getByRole("switch", { name: "Share Everyday with the whole household" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Share Everyday directly with bob" })).not.toBeChecked();

    rerender(
      <HouseholdSection
        {...props}
        wallets={wallets.map((w) => (w.id === "w1" ? { ...w, shared_with_household: false } : w))}
        access={access.map((a) =>
          a.wallet_id === "w1" && a.user_id === "u-bob" ? { ...a, via: "direct" as const } : a,
        )}
      />,
    );

    expect(screen.getByRole("switch", { name: "Share Everyday with the whole household" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Share Everyday directly with bob" })).toBeChecked();
  });

  it("stops offering a removed member's checkbox when the section rerenders without them", () => {
    const { rerender } = render(<HouseholdSection {...props} />);
    expect(screen.getByRole("checkbox", { name: "Share Everyday directly with bob" })).toBeInTheDocument();

    rerender(
      <HouseholdSection
        {...props}
        members={members.filter((m) => m.user_id !== "u-bob")}
        wallets={wallets.filter((w) => w.owner_id !== "u-bob")}
        access={access.filter((a) => a.user_id !== "u-bob")}
      />,
    );

    expect(screen.queryByRole("checkbox", { name: "Share Everyday directly with bob" })).not.toBeInTheDocument();
    expect(screen.queryByText("bob · via household")).not.toBeInTheDocument();
  });
});

describe("HouseholdSection as a member", () => {
  const props = { space, currentUserId: "u-bob", members, wallets, access, pendingInvites: [], single: true };

  it("offers Leave with a confirm, and no owner controls", async () => {
    const user = userEvent.setup();
    render(<HouseholdSection {...props} />);
    expect(screen.queryByLabelText("Invite by email")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove .* from the household/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Leave household" }));
    const dialog = screen.getByRole("dialog", { name: "Leave alice household?" });
    expect(dialog).toHaveTextContent("Wallets you own go with you into a household of your own");
    await user.click(within(dialog).getByRole("button", { name: "Leave" }));
    expect(leaveHousehold).toHaveBeenCalledWith("s1");
  });
});
