import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
// Both are "use server" modules that reach the Supabase env helpers.
vi.mock("@/server/actions/auth", () => ({ signOut: vi.fn() }));
vi.mock("@/server/actions/profile", () => ({ setTheme: vi.fn() }));

import { ProfileMenu } from "./ProfileMenu";

describe("ProfileMenu", () => {
  it("is the page's banner landmark, so nothing on the page sits outside one (axe 'region')", () => {
    render(<ProfileMenu theme="system" />);
    expect(screen.getByRole("banner")).toContainElement(screen.getByRole("button", { name: "Profile and settings" }));
  });

  it("opens the settings that left the tab bar", async () => {
    render(<ProfileMenu theme="system" />);
    expect(screen.queryByRole("link", { name: "Budgets" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Profile and settings" }));
    for (const name of ["Budgets", "Categories", "Recurring", "Household", "Connect Claude"]) {
      expect(screen.getByRole("link", { name })).toBeInTheDocument();
    }
  });
});
