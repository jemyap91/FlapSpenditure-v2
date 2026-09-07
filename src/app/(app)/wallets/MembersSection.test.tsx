// src/app/(app)/wallets/MembersSection.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MembersSection, type Member } from "./MembersSection";
import { revokeInvite } from "@/server/actions/invites";
import { setWalletSharing } from "@/server/actions/household";

vi.mock("@/server/actions/invites", () => ({
  inviteToWallet: vi.fn(),
  revokeInvite: vi.fn(),
}));

vi.mock("@/server/actions/household", () => ({
  setWalletSharing: vi.fn(),
}));

const members: Member[] = [
  { user_id: "u1", display_name: "Alex", role: "owner" },
  { user_id: "u2", display_name: "Sam", role: "member" },
];

const householdMembers = [
  { user_id: "u2", display_name: "Sam", via: "household" as const },
  { user_id: "u3", display_name: "Jamie", via: null },
];

const baseProps = {
  walletId: "w1",
  walletName: "Everyday",
  members,
  pendingInvites: [],
  householdShared: false,
  householdMembers,
};

beforeEach(() => {
  vi.mocked(setWalletSharing).mockReset();
  vi.mocked(setWalletSharing).mockResolvedValue({ notice: "Sharing updated." });
});

describe("MembersSection", () => {
  it("marks who owns the wallet", () => {
    render(<MembersSection {...baseProps} isOwner />);
    expect(screen.getByText("Alex")).toBeInTheDocument();
    expect(screen.getByText("Owner")).toBeInTheDocument();
  });

  it("offers the owner the household switch and one checkbox per household member", () => {
    render(<MembersSection {...baseProps} isOwner />);
    expect(
      screen.getByRole("switch", { name: "Share Everyday with the whole household" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Share Everyday directly with Sam" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Share Everyday directly with Jamie" }),
    ).toBeInTheDocument();
    // The old per-person Remove control is gone — sharing is managed
    // through the switch and checkboxes above, not a destructive button.
    expect(screen.queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();
  });

  it("shows a non-owner the read-only sentence instead of any control", () => {
    render(<MembersSection {...baseProps} isOwner={false} />);
    expect(
      screen.getByText("Only the wallet's owner can change this.", { exact: false }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();
  });

  it("saves sharing through the same control as /household", async () => {
    const user = userEvent.setup();
    render(<MembersSection {...baseProps} isOwner />);
    await user.click(screen.getByRole("switch", { name: "Share Everyday with the whole household" }));
    await user.click(screen.getByRole("button", { name: "Save sharing for Everyday" }));
    expect(setWalletSharing).toHaveBeenCalledExactlyOnceWith("w1", true, []);
  });
});

describe("MembersSection — pending invitees", () => {
  const invites = [{ id: "inv-1", invited_email: "sam@example.com" }];

  beforeEach(() => {
    vi.mocked(revokeInvite).mockReset();
    vi.mocked(revokeInvite).mockResolvedValue({});
  });

  it("shows who has been invited but has not answered", () => {
    render(<MembersSection {...baseProps} pendingInvites={invites} isOwner />);
    expect(screen.getByText("sam@example.com")).toBeInTheDocument();
    // Stated in words, not conveyed by styling alone — the state has to
    // survive being read aloud.
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("lets the owner withdraw a specific invitation", async () => {
    const user = userEvent.setup();
    render(<MembersSection {...baseProps} pendingInvites={invites} isOwner />);
    await user.click(screen.getByRole("button", { name: "Revoke invitation to sam@example.com" }));
    expect(revokeInvite).toHaveBeenCalledExactlyOnceWith("w1", "inv-1");
  });

  it("offers no Revoke control to a non-owner", () => {
    render(<MembersSection {...baseProps} pendingInvites={invites} isOwner={false} />);
    // Absent, not disabled — members_write is owner-only, so a control here
    // could never succeed.
    expect(screen.queryByRole("button", { name: /^Revoke/ })).not.toBeInTheDocument();
    // But they still see that an invitation is outstanding.
    expect(screen.getByText("sam@example.com")).toBeInTheDocument();
  });

  it("surfaces a failed revoke instead of appearing to have worked", async () => {
    vi.mocked(revokeInvite).mockResolvedValue({ error: "That invitation is no longer pending." });
    const user = userEvent.setup();
    render(<MembersSection {...baseProps} pendingInvites={invites} isOwner />);
    await user.click(screen.getByRole("button", { name: "Revoke invitation to sam@example.com" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer pending");
  });

  it("renders nothing extra when there are no outstanding invitations", () => {
    render(<MembersSection {...baseProps} pendingInvites={[]} isOwner />);
    expect(screen.queryByText("Pending")).not.toBeInTheDocument();
  });
});

describe("MembersSection — invite form", () => {
  it("offers the invite form to the owner", () => {
    render(<MembersSection {...baseProps} isOwner />);
    expect(screen.getByLabelText("Invite by email")).toBeInTheDocument();
  });

  it("hides the invite form from a non-owner", () => {
    render(<MembersSection {...baseProps} isOwner={false} />);
    expect(screen.queryByLabelText("Invite by email")).not.toBeInTheDocument();
  });
});
