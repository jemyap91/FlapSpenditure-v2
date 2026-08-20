// src/app/(app)/wallets/MembersSection.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MembersSection, type Member } from "./MembersSection";
import { removeMember } from "@/server/actions/invites";

vi.mock("@/server/actions/invites", () => ({
  removeMember: vi.fn(),
  inviteToWallet: vi.fn(),
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
  it("marks who owns the account", () => {
    render(<MembersSection walletId="w1" members={members} isOwner />);
    expect(screen.getByText("Alex")).toBeInTheDocument();
    expect(screen.getByText("Owner")).toBeInTheDocument();
  });

  it("offers Remove to the owner, but never for the owner's own row", () => {
    render(<MembersSection walletId="w1" members={members} isOwner />);
    expect(screen.getByRole("button", { name: "Remove Sam" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Alex" })).not.toBeInTheDocument();
  });

  it("hides Remove entirely from a non-owner", () => {
    render(<MembersSection walletId="w1" members={members} isOwner={false} />);
    expect(screen.queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();
  });

  it("removes the person whose button was pressed", async () => {
    const user = userEvent.setup();
    render(<MembersSection walletId="w1" members={members} isOwner />);
    await user.click(screen.getByRole("button", { name: "Remove Sam" }));
    expect(removeMember).toHaveBeenCalledExactlyOnceWith("w1", "u2");
  });

  it("surfaces a failure rather than appearing to succeed", async () => {
    vi.mocked(removeMember).mockResolvedValue({ error: "Only the account owner can do that." });
    const user = userEvent.setup();
    render(<MembersSection walletId="w1" members={members} isOwner />);
    await user.click(screen.getByRole("button", { name: "Remove Sam" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only the account owner can do that.");
  });
});
