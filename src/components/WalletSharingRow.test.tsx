// src/components/WalletSharingRow.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WalletSharingRow } from "./WalletSharingRow";
import { setWalletSharing } from "@/server/actions/household";

vi.mock("@/server/actions/household", () => ({ setWalletSharing: vi.fn() }));

const members = [
  { user_id: "u-bob", display_name: "bob", via: "household" as const },
  { user_id: "u-cat", display_name: "cat", via: "direct" as const },
  { user_id: "u-dan", display_name: "dan", via: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(setWalletSharing).mockResolvedValue({ notice: "Sharing updated." });
});

describe("WalletSharingRow", () => {
  it("shows each member's access and the household switch state", () => {
    render(<WalletSharingRow walletId="w1" walletName="Everyday" householdShared members={members} canEdit />);
    expect(screen.getByRole("switch", { name: "Share Everyday with the whole household" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Share Everyday directly with bob" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Share Everyday directly with cat" })).toBeChecked();
    expect(screen.getByText("bob · via household")).toBeInTheDocument();
    expect(screen.getByText("cat · direct")).toBeInTheDocument();
    expect(screen.getByText("dan · no access")).toBeInTheDocument();
  });

  it("submits the whole row: switch off, direct list as checked", async () => {
    const user = userEvent.setup();
    render(<WalletSharingRow walletId="w1" walletName="Everyday" householdShared members={members} canEdit />);
    await user.click(screen.getByRole("switch", { name: "Share Everyday with the whole household" }));
    await user.click(screen.getByRole("checkbox", { name: "Share Everyday directly with dan" }));
    await user.click(screen.getByRole("button", { name: "Save sharing for Everyday" }));
    expect(setWalletSharing).toHaveBeenCalledWith("w1", false, ["u-cat", "u-dan"]);
    expect(await screen.findByText("Sharing updated.")).toBeInTheDocument();
  });

  /**
   * A save revalidates, so the row is re-rendered with the sharing it just
   * wrote. It must follow that new data (the controls are local copies made
   * at mount) AND keep the notice it just set — the notice exists precisely
   * because the props changed, so anything that discards state on new props
   * (a `key` in the parent, say) wipes the message the save produced. Both
   * halves are asserted here because each one is a way to get this wrong.
   */
  it("follows new props after a save and keeps its own notice", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <WalletSharingRow walletId="w1" walletName="Everyday" householdShared members={members} canEdit />,
    );
    await user.click(screen.getByRole("switch", { name: "Share Everyday with the whole household" }));
    await user.click(screen.getByRole("button", { name: "Save sharing for Everyday" }));
    expect(await screen.findByText("Sharing updated.")).toBeInTheDocument();

    // What the server now reports: unshared, and bob's household row gone.
    rerender(
      <WalletSharingRow
        walletId="w1"
        walletName="Everyday"
        householdShared={false}
        members={members.map((m) => (m.user_id === "u-bob" ? { ...m, via: null } : m))}
        canEdit
      />,
    );

    expect(screen.getByRole("switch", { name: "Share Everyday with the whole household" })).not.toBeChecked();
    expect(screen.getByText("bob · no access")).toBeInTheDocument();
    expect(screen.getByText("Sharing updated.")).toBeInTheDocument();
  });

  it("is read-only when the viewer does not own the wallet", () => {
    render(<WalletSharingRow walletId="w1" walletName="Everyday" householdShared={false} members={members} canEdit={false} />);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save sharing/ })).not.toBeInTheDocument();
    expect(screen.getByText("Only the wallet's owner can change this.")).toBeInTheDocument();
  });

  it("surfaces an action error in the status line", async () => {
    vi.mocked(setWalletSharing).mockResolvedValue({ error: "Could not update sharing. Please try again." });
    const user = userEvent.setup();
    render(<WalletSharingRow walletId="w1" walletName="Everyday" householdShared={false} members={members} canEdit />);
    await user.click(screen.getByRole("button", { name: "Save sharing for Everyday" }));
    expect(await screen.findByText("Could not update sharing. Please try again.")).toBeInTheDocument();
  });
});
