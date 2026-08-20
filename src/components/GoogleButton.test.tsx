import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GoogleButton } from "./GoogleButton";

/**
 * `@/lib/supabase/client` reaches `@/lib/supabase/env`, which throws on
 * import when the Supabase env vars are absent — and `npm test` runs with
 * no `.env.local`. Same reasoning as TransactionList.test.tsx: `vi.mock`
 * intercepts before the real module ever evaluates.
 */
const { signInWithOAuth } = vi.hoisted(() => ({ signInWithOAuth: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({
  createBrowserClient: () => ({ auth: { signInWithOAuth } }),
}));

beforeEach(() => {
  signInWithOAuth.mockReset();
  signInWithOAuth.mockResolvedValue({ error: null });
});

describe("GoogleButton", () => {
  it("renders a real button, not a link", () => {
    render(<GoogleButton />);
    // It triggers a JS redirect rather than navigating to an href, so a
    // <button> is the honest element — a link would promise a URL the
    // markup does not actually have.
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
  });

  it("asks Supabase for Google, returning to this app's own callback route", async () => {
    const user = userEvent.setup();
    render(<GoogleButton />);
    await user.click(screen.getByRole("button", { name: /continue with google/i }));

    expect(signInWithOAuth).toHaveBeenCalledExactlyOnceWith({
      provider: "google",
      // Derived from the live origin, never hardcoded: the same build runs
      // on localhost and on the deployed domain, and a fixed value would
      // send one of them to the other.
      options: { redirectTo: "http://localhost:3000/auth/callback" },
    });
  });

  it("surfaces a provider error instead of leaving the user on a dead button", async () => {
    signInWithOAuth.mockResolvedValue({ error: { message: "Unsupported provider" } });
    const user = userEvent.setup();
    render(<GoogleButton />);
    await user.click(screen.getByRole("button", { name: /continue with google/i }));

    // This is the failure mode when the provider has not been enabled in
    // the Supabase dashboard yet, so it must say something rather than
    // silently do nothing.
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not start google sign-in/i);
  });

  it("disables itself once clicked, so a second click cannot start a second flow", async () => {
    const user = userEvent.setup();
    render(<GoogleButton />);
    const button = screen.getByRole("button", { name: /continue with google/i });
    await user.click(button);
    expect(button).toBeDisabled();
  });

  it("re-enables after a failure so the user can retry", async () => {
    signInWithOAuth.mockResolvedValue({ error: { message: "boom" } });
    const user = userEvent.setup();
    render(<GoogleButton />);
    const button = screen.getByRole("button", { name: /continue with google/i });
    await user.click(button);
    // A successful call navigates away, so staying disabled is right there;
    // a failed one leaves the user on this page and must not strand them.
    expect(button).toBeEnabled();
  });
});
