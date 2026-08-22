import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WalletList } from "./WalletList";
import type { WalletWithBalance } from "./wallet-rows";
import { archiveWallet } from "@/server/actions/wallets";

/**
 * Same reasoning as src/components/TransactionList.test.tsx: this action
 * module carries a file-level `"use server"` and transitively reaches
 * `next/headers`/`server-only`, which `npm test` (run with no `.env.local`)
 * must never load. `vi.mock` intercepts the import before the real module
 * executes.
 */
vi.mock("@/server/actions/wallets", () => ({
  archiveWallet: vi.fn(),
}));

/** The signed-in user for every render below, unless a case deliberately
 *  lists a wallet somebody else owns. */
const ME = "11111111-1111-4111-8111-111111111111";
const PARTNER = "22222222-2222-4222-8222-222222222222";

const wallet = (id: string, over: Partial<WalletWithBalance> = {}): WalletWithBalance => ({
  id,
  name: `Wallet ${id}`,
  kind: "bank",
  currency_code: "USD",
  color_slot: 1,
  icon: "landmark",
  owner_id: ME,
  balanceMinor: 0,
  ...over,
});

beforeEach(() => {
  vi.mocked(archiveWallet).mockReset();
  vi.mocked(archiveWallet).mockResolvedValue({});
});

describe("WalletList", () => {
  it("shows each wallet's name and its balance in that wallet's own currency", () => {
    render(
      <WalletList
        currentUserId={ME}
        wallets={[
          wallet("a", { name: "Everyday", currency_code: "USD", balanceMinor: 125000 }),
          wallet("b", { name: "Tokyo", currency_code: "JPY", balanceMinor: 4200 }),
        ]}
      />,
    );
    expect(screen.getByText("Everyday")).toBeInTheDocument();
    expect(screen.getByText("$1,250.00")).toBeInTheDocument();
    // JPY has no minor units — a shared "divide by 100" would render ¥42.
    expect(screen.getByText("¥4,200")).toBeInTheDocument();
  });

  it("renders a negative balance with a sign rather than as a bare magnitude", () => {
    render(<WalletList currentUserId={ME} wallets={[wallet("a", { kind: "card", balanceMinor: -5000 })]} />);
    expect(screen.getByText("−$50.00")).toBeInTheDocument();
  });

  it("shows an em dash, not $0.00, when a balance could not be computed", () => {
    render(<WalletList currentUserId={ME} wallets={[wallet("a", { balanceMinor: null })]} />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("disables Archive on the only wallet and says why", () => {
    render(<WalletList currentUserId={ME} wallets={[wallet("a", { name: "Everyday" })]} />);
    expect(screen.getByRole("button", { name: /Archive Everyday/ })).toBeDisabled();
    expect(screen.getByText(/need at least one account/i)).toBeInTheDocument();
  });

  it("enables Archive once a second wallet exists", () => {
    render(<WalletList currentUserId={ME} wallets={[wallet("a", { name: "Everyday" }), wallet("b", { name: "Savings" })]} />);
    expect(screen.getByRole("button", { name: /Archive Everyday/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Archive Savings/ })).toBeEnabled();
    expect(screen.queryByText(/need at least one account/i)).not.toBeInTheDocument();
  });

  it("archives the wallet whose button was pressed, not the first one", async () => {
    const user = userEvent.setup();
    render(<WalletList currentUserId={ME} wallets={[wallet("a", { name: "Everyday" }), wallet("b", { name: "Savings" })]} />);
    await user.click(screen.getByRole("button", { name: /Archive Savings/ }));
    expect(archiveWallet).toHaveBeenCalledExactlyOnceWith("b");
  });

  it("surfaces the failure instead of silently leaving the row in place", async () => {
    // `archiveWallet` RETURNS its error rather than throwing. A thrown
    // message would not survive to the user: Next replaces errors
    // forwarded from the server with a generic digest in production
    // (node_modules/next/dist/docs/01-app/03-api-reference/
    // 03-file-conventions/error.md), so "You need at least one account"
    // would reach the browser as an opaque identifier.
    vi.mocked(archiveWallet).mockResolvedValue({ error: "Could not archive wallet" });
    const user = userEvent.setup();
    render(<WalletList currentUserId={ME} wallets={[wallet("a", { name: "Everyday" }), wallet("b", { name: "Savings" })]} />);
    await user.click(screen.getByRole("button", { name: /Archive Savings/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not archive wallet");
  });

  it("renders the empty state rather than an empty list", () => {
    render(<WalletList currentUserId={ME} wallets={[]} />);
    expect(screen.getByText(/no accounts yet/i)).toBeInTheDocument();
  });

  /**
   * /wallets lists SHARED wallets too (spec §4), and `archiveWallet` is
   * scoped `.eq("owner_id", user.id)` by design (spec §5: "a member cannot
   * archive a wallet they were invited to"). Offering the control anyway
   * produced the worst possible outcome: the UPDATE matched zero rows,
   * PostgREST reported no error, and the UI said it had worked.
   *
   * Absent, not disabled — the convention this codebase already applies to
   * a control that can never succeed (TransactionForm removes the category
   * chip on a transfer rather than greying it out; MembersSection renders
   * no Remove for a non-owner at all).
   */
  it("does not render Archive for a wallet the signed-in user does not own", () => {
    render(
      <WalletList
        currentUserId={ME}
        wallets={[
          wallet("a", { name: "Everyday" }),
          wallet("b", { name: "Household", owner_id: PARTNER }),
        ]}
      />,
    );
    // Positive pairing: the control still exists for the wallet they DO
    // own, so this is an ownership filter, not Archive disappearing.
    expect(screen.getByRole("button", { name: /Archive Everyday/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Archive Household/ })).not.toBeInTheDocument();
  });

  /**
   * `isLastWallet` counted READABLE wallets while `archiveWallet` counts
   * OWNED ones, so a user with one wallet of their own plus one shared
   * wallet was offered an enabled Archive on their last owned wallet — and
   * only found out it was refused after clicking.
   */
  it("disables Archive on the user's only OWNED wallet even when a shared wallet is listed too", () => {
    render(
      <WalletList
        currentUserId={ME}
        wallets={[
          wallet("a", { name: "Everyday" }),
          wallet("b", { name: "Household", owner_id: PARTNER }),
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: /Archive Everyday/ })).toBeDisabled();
    expect(screen.getByText(/need at least one account/i)).toBeInTheDocument();
  });

  it("enables Archive once the user owns a second wallet, shared wallets aside", () => {
    render(
      <WalletList
        currentUserId={ME}
        wallets={[
          wallet("a", { name: "Everyday" }),
          wallet("b", { name: "Savings" }),
          wallet("c", { name: "Household", owner_id: PARTNER }),
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: /Archive Everyday/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Archive Savings/ })).toBeEnabled();
    expect(screen.queryByText(/need at least one account/i)).not.toBeInTheDocument();
  });
});

describe("WalletList — collapsible members", () => {
  it("hides each wallet's members behind a closed disclosure by default", () => {
    render(
      <WalletList
        wallets={[wallet("a", { name: "Test" })]}
        currentUserId={ME}
        memberSections={{ a: <p>members for Test</p> }}
      />,
    );
    const toggle = screen.getByRole("button", { name: "Members of Test" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("members for Test")).not.toBeInTheDocument();
  });

  it("reveals that wallet's members when its own disclosure is opened", async () => {
    const user = userEvent.setup();
    render(
      <WalletList
        wallets={[wallet("a", { name: "Test" }), wallet("b", { name: "Citi" })]}
        currentUserId={ME}
        memberSections={{ a: <p>members for Test</p>, b: <p>members for Citi</p> }}
      />,
    );
    // Opening one card must not open the other — state is per wallet, not
    // a single shared boolean.
    await user.click(screen.getByRole("button", { name: "Members of Test" }));
    expect(screen.getByText("members for Test")).toBeInTheDocument();
    expect(screen.queryByText("members for Citi")).not.toBeInTheDocument();
  });

  it("keeps the balance visible while collapsed — it is why the page is opened", () => {
    render(
      <WalletList
        wallets={[wallet("a", { name: "Test", balanceMinor: 1491200, currency_code: "SGD" })]}
        currentUserId={ME}
        memberSections={{ a: <p>hidden</p> }}
      />,
    );
    expect(screen.getByText("SGD 14,912.00")).toBeInTheDocument();
  });
});

describe("WalletList — search", () => {
  const many = [
    wallet("a", { name: "Everyday" }),
    wallet("b", { name: "Citi Rewards" }),
    wallet("c", { name: "Travel" }),
    wallet("d", { name: "Savings" }),
  ];

  it("stays out of the way until there are enough wallets to need it", () => {
    render(<WalletList wallets={many.slice(0, 2)} currentUserId={ME} />);
    expect(screen.queryByLabelText(/Search accounts/i)).not.toBeInTheDocument();
  });

  it("filters by wallet name, case-insensitively", async () => {
    const user = userEvent.setup();
    render(<WalletList wallets={many} currentUserId={ME} />);
    await user.type(screen.getByLabelText(/Search accounts/i), "cItI");
    expect(screen.getByText("Citi Rewards")).toBeInTheDocument();
    expect(screen.queryByText("Everyday")).not.toBeInTheDocument();
  });

  it("says so when nothing matches, rather than rendering an empty list", async () => {
    const user = userEvent.setup();
    render(<WalletList wallets={many} currentUserId={ME} />);
    await user.type(screen.getByLabelText(/Search accounts/i), "zzzz");
    expect(screen.getByText(/No accounts match/i)).toBeInTheDocument();
  });

  it("does not let a filtered-down view re-enable Archive on the last owned wallet", async () => {
    // The guard counts OWNED wallets, not visible ones. Filtering is a view
    // concern; hiding three wallets must not make the fourth look like the
    // only one.
    const user = userEvent.setup();
    render(<WalletList wallets={many} currentUserId={ME} />);
    await user.type(screen.getByLabelText(/Search accounts/i), "Travel");
    expect(screen.getByRole("button", { name: "Archive Travel" })).toBeEnabled();
  });
});
