import { describe, it, expect } from "vitest";
import { inviteInput } from "@/lib/validation/invite";

describe("inviteInput", () => {
  it("accepts a plain address", () => {
    expect(inviteInput.safeParse({ email: "sam@example.com" }).success).toBe(true);
  });

  it("lower-cases and trims, so matching the invitee is case-insensitive", () => {
    const parsed = inviteInput.parse({ email: "  Sam@Example.COM " });
    expect(parsed.email).toBe("sam@example.com");
  });

  it("rejects a non-address rather than storing it", () => {
    expect(inviteInput.safeParse({ email: "sam" }).success).toBe(false);
  });
});
