// src/app/(app)/wallets/MembersSection.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MembersSection, type Member } from "./MembersSection";
import { removeMember, revokeInvite } from "@/server/actions/invites";

vi.mock("@/server/actions/invites", () => ({
  removeMember: vi.fn(),
  inviteToWallet: vi.fn(),
  revokeInvite: vi.fn(),
}));

const members: Member[] = [
  { user_id: "u1", display_name: "Alex", role: "owner" },
  { user_id: "u2", display_name: "Sam", role: "member" },
];

beforeEach(() => {
  vi.mocked(removeMember).mockReset();
  vi.mocked(removeMember).mockResolvedValue({});
});

describe("MembersSection", () => {
  it("marks who owns the wallet", () => {
    render(<MembersSection walletId="w1" members={members} pendingInvites={[]} isOwner />);
    expect(screen.getByText("Alex")).toBeInTheDocument();
    expect(screen.getByText("Owner")).toBeInTheDocument();
  });

  it("offers Remove to the owner, but never for the owner's own row", () => {
    render(<MembersSection walletId="w1" members={members} pendingInvites={[]} isOwner />);
    expect(screen.getByRole("button", { name: "Remove Sam" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Alex" })).not.toBeInTheDocument();
  });

  it("hides Remove entirely from a non-owner", () => {
    render(<MembersSection walletId="w1" members={members} pendingInvites={[]} isOwner={false} />);
    expect(screen.queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();
  });

  it("removes the person whose button was pressed", async () => {
    const user = userEvent.setup();
    render(<MembersSection walletId="w1" members={members} pendingInvites={[]} isOwner />);
    await user.click(screen.getByRole("button", { name: "Remove Sam" }));
    expect(removeMember).toHaveBeenCalledExactlyOnceWith("w1", "u2");
  });

  it("surfaces a failure rather than appearing to succeed", async () => {
    vi.mocked(removeMember).mockResolvedValue({ error: "Only the wallet owner can do that." });
    const user = userEvent.setup();
    render(<MembersSection walletId="w1" members={members} pendingInvites={[]} isOwner />);
    await user.click(screen.getByRole("button", { name: "Remove Sam" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only the wallet owner can do that.");
  });
});

describe("MembersSection — pending invitees", () => {
  const invites = [{ id: "inv-1", invited_email: "sam@example.com" }];

  beforeEach(() => {
    vi.mocked(revokeInvite).mockReset();
    vi.mocked(revokeInvite).mockResolvedValue({});
  });

  it("shows who has been invited but has not answered", () => {
    render(<MembersSection walletId="w1" members={members} pendingInvites={invites} isOwner />);
    expect(screen.getByText("sam@example.com")).toBeInTheDocument();
    // Stated in words, not conveyed by styling alone — the state has to
    // survive being read aloud.
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("lets the owner withdraw a specific invitation", async () => {
    const user = userEvent.setup();
    render(<MembersSection walletId="w1" members={members} pendingInvites={invites} isOwner />);
    await user.click(screen.getByRole("button", { name: "Revoke invitation to sam@example.com" }));
    expect(revokeInvite).toHaveBeenCalledExactlyOnceWith("w1", "inv-1");
  });

  it("offers no Revoke control to a non-owner", () => {
    render(
      <MembersSection walletId="w1" members={members} pendingInvites={invites} isOwner={false} />,
    );
    // Absent, not disabled — members_write is owner-only, so a control here
    // could never succeed.
    expect(screen.queryByRole("button", { name: /^Revoke/ })).not.toBeInTheDocument();
    // But they still see that an invitation is outstanding.
    expect(screen.getByText("sam@example.com")).toBeInTheDocument();
  });

  it("surfaces a failed revoke instead of appearing to have worked", async () => {
    vi.mocked(revokeInvite).mockResolvedValue({ error: "That invitation is no longer pending." });
    const user = userEvent.setup();
    render(<MembersSection walletId="w1" members={members} pendingInvites={invites} isOwner />);
    await user.click(screen.getByRole("button", { name: "Revoke invitation to sam@example.com" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer pending");
  });

  it("renders nothing extra when there are no outstanding invitations", () => {
    render(<MembersSection walletId="w1" members={members} pendingInvites={[]} isOwner />);
    expect(screen.queryByText("Pending")).not.toBeInTheDocument();
  });
});
