import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
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

/** A stand-in for the bound `updateWallet`. WalletList only needs
 *  SOMETHING action-shaped to render the form; what the action does is
 *  wallets.test.ts's subject, not this file's. */
const noopAction = async () => ({});

const wallet = (id: string, over: Partial<WalletWithBalance> = {}): WalletWithBalance => ({
  id,
  name: `Wallet ${id}`,
  kind: "bank",
  currency_code: "USD",
  color_slot: 1,
  icon: "landmark",
  starting_balance_minor: 0,
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

  /**
   * Task 3 of the wallet-detail plan: the wallet's NAME becomes the link
   * into its detail screen (Members and Archive stay put on the card). The
   * link's accessible name is the wallet's name alone — pinned by that
   * plan's controller addendum, since the final task in the plan targets
   * this exact accessible name with a Playwright selector.
   */
  it("links the wallet's name to its detail screen", () => {
    render(<WalletList currentUserId={ME} wallets={[wallet("a", { name: "Everyday" })]} />);
    const link = screen.getByRole("link", { name: "Everyday" });
    expect(link).toHaveAttribute("href", "/wallets/a");
  });

  /* The Archive BUTTON is gone (2026-08-29) — it moved to a swipe plus an
     entry in the edit dialog, to give wallet names their width back on a
     phone. The behaviour it guarded did not move, so these cases now drive
     the same logic through the swipe. See "WalletList — archiving" below
     for the gesture's own cases. */

  it("refuses to archive the only wallet, and says why", () => {
    render(<WalletList currentUserId={ME} wallets={[wallet("a", { name: "Everyday" })]} />);

    swipeLeft(screen.getByRole("listitem", { name: "Everyday" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/need at least one wallet/i);
  });

  it("allows archiving once a second wallet exists", () => {
    render(<WalletList currentUserId={ME} wallets={[wallet("a", { name: "Everyday" }), wallet("b", { name: "Savings" })]} />);

    swipeLeft(screen.getByRole("listitem", { name: "Everyday" }));

    expect(screen.getByRole("dialog", { name: "Archive Everyday?" })).toBeInTheDocument();
  });

  it("archives the wallet that was swiped, not the first one", async () => {
    const user = userEvent.setup();
    render(<WalletList currentUserId={ME} wallets={[wallet("a", { name: "Everyday" }), wallet("b", { name: "Savings" })]} />);

    swipeLeft(screen.getByRole("listitem", { name: "Savings" }));
    await user.click(screen.getByRole("button", { name: "Archive" }));

    expect(archiveWallet).toHaveBeenCalledExactlyOnceWith("b");
  });

  it("surfaces the failure instead of silently leaving the row in place", async () => {
    // `archiveWallet` RETURNS its error rather than throwing. A thrown
    // message would not survive to the user: Next replaces errors
    // forwarded from the server with a generic digest in production
    // (node_modules/next/dist/docs/01-app/03-api-reference/
    // 03-file-conventions/error.md), so "You need at least one wallet"
    // would reach the browser as an opaque identifier.
    vi.mocked(archiveWallet).mockResolvedValue({ error: "Could not archive wallet" });
    const user = userEvent.setup();
    render(<WalletList currentUserId={ME} wallets={[wallet("a", { name: "Everyday" }), wallet("b", { name: "Savings" })]} />);

    swipeLeft(screen.getByRole("listitem", { name: "Savings" }));
    await user.click(screen.getByRole("button", { name: "Archive" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not archive wallet");
  });

  it("renders the empty state rather than an empty list", () => {
    render(<WalletList currentUserId={ME} wallets={[]} />);
    expect(screen.getByText(/no wallets yet/i)).toBeInTheDocument();
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
    // Positive pairing: the gesture still works on the wallet they DO own,
    // so this is an ownership filter, not archiving disappearing. Two
    // wallets exist, so the last-wallet guard is not what decides either.
    swipeLeft(screen.getByRole("listitem", { name: "Household" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
    swipeLeft(screen.getByRole("listitem", { name: "Everyday" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/need at least one wallet/i);
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
    // Two OWNED wallets, so the guard lifts even though one of the three
    // rows belongs to somebody else — the count that matters is ownership,
    // which is what archiveWallet itself counts.
    swipeLeft(screen.getByRole("listitem", { name: "Everyday" }));

    expect(screen.getByRole("dialog", { name: "Archive Everyday?" })).toBeInTheDocument();
    expect(screen.queryByText(/need at least one wallet/i)).not.toBeInTheDocument();
  });
});

describe("WalletList — members and edit dialogs", () => {
  it("shows no members until asked, and no dialog at rest", () => {
    render(
      <WalletList
        wallets={[wallet("a", { name: "Test" })]}
        currentUserId={ME}
        memberSections={{ a: <p>members for Test</p> }}
      />,
    );

    expect(screen.getByRole("button", { name: "Members of Test" })).toBeInTheDocument();
    expect(screen.queryByText("members for Test")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens ONLY that wallet's members, in a dialog named after it", async () => {
    const user = userEvent.setup();
    render(
      <WalletList
        wallets={[wallet("a", { name: "Test" }), wallet("b", { name: "Citi" })]}
        currentUserId={ME}
        memberSections={{ a: <p>members for Test</p>, b: <p>members for Citi</p> }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Members of Test" }));

    // The dialog's own name is the only thing identifying WHICH wallet is
    // being changed once the row is behind a backdrop.
    expect(screen.getByRole("dialog", { name: "Members of Test" })).toBeInTheDocument();
    expect(screen.getByText("members for Test")).toBeInTheDocument();
    expect(screen.queryByText("members for Citi")).not.toBeInTheDocument();
  });

  it("opens the edit form for that wallet", async () => {
    const user = userEvent.setup();
    render(
      <WalletList
        wallets={[wallet("a", { name: "Test" })]}
        currentUserId={ME}
        memberSections={{ a: <p>members for Test</p> }}
        editActions={{ a: noopAction }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit Test" }));

    expect(screen.getByRole("dialog", { name: "Edit Test" })).toBeInTheDocument();
    // The list builds the form itself from the wallet it already holds, so
    // the fields must arrive seeded — an empty form here would mean the
    // dialog opened on the right wallet but forgot which one.
    expect(screen.getByLabelText("Name")).toHaveValue("Test");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
    // The two dialogs share one slot — opening Edit must not also show
    // Members, which a per-view render could easily get wrong.
    expect(screen.queryByText("members for Test")).not.toBeInTheDocument();
  });

  /**
   * `updateWallet` scopes its UPDATE to `owner_id`, so an edit by a member
   * would match zero rows and be reported as success — the identical defect
   * archiveWallet was fixed for. The page withholds the slot; this asserts
   * the list then offers no control, rather than a disabled one.
   */
  it("offers no Edit for a wallet with no edit slot", () => {
    render(
      <WalletList
        wallets={[wallet("a", { name: "Shared", owner_id: PARTNER })]}
        currentUserId={ME}
        memberSections={{ a: <p>members for Shared</p> }}
        editActions={{}}
      />,
    );

    expect(screen.queryByRole("button", { name: "Edit Shared" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Members of Shared" })).toBeInTheDocument();
  });

  /**
   * The reason the page hands over bound ACTIONS rather than rendered
   * forms. A pre-rendered node cannot tell this component that a save
   * succeeded, so the dialog would sit open on top of a change that had
   * already happened — reading as though nothing did.
   */
  it("closes the edit dialog once the save succeeds", async () => {
    const user = userEvent.setup();
    render(
      <WalletList
        wallets={[wallet("a", { name: "Test" })]}
        currentUserId={ME}
        editActions={{ a: noopAction }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit Test" }));
    expect(screen.getByRole("dialog", { name: "Edit Test" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  /** The other half: a REJECTED save must leave the dialog open, or the
   *  user loses both the error message and everything they typed. */
  it("keeps the edit dialog open when the save is refused", async () => {
    const user = userEvent.setup();
    render(
      <WalletList
        wallets={[wallet("a", { name: "Test" })]}
        currentUserId={ME}
        editActions={{ a: async () => ({ error: "Name is required" }) }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit Test" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(screen.getByText("Name is required")).toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "Edit Test" })).toBeInTheDocument();
  });

  it("closes the dialog again", async () => {
    const user = userEvent.setup();
    render(
      <WalletList
        wallets={[wallet("a", { name: "Test" })]}
        currentUserId={ME}
        memberSections={{ a: <p>members for Test</p> }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Members of Test" }));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("members for Test")).not.toBeInTheDocument();
  });

  it("keeps the balance on the row — it is why the page is opened", () => {
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
    expect(screen.queryByLabelText(/Search wallets/i)).not.toBeInTheDocument();
  });

  it("filters by wallet name, case-insensitively", async () => {
    const user = userEvent.setup();
    render(<WalletList wallets={many} currentUserId={ME} />);
    await user.type(screen.getByLabelText(/Search wallets/i), "cItI");
    expect(screen.getByText("Citi Rewards")).toBeInTheDocument();
    expect(screen.queryByText("Everyday")).not.toBeInTheDocument();
  });

  it("says so when nothing matches, rather than rendering an empty list", async () => {
    const user = userEvent.setup();
    render(<WalletList wallets={many} currentUserId={ME} />);
    await user.type(screen.getByLabelText(/Search wallets/i), "zzzz");
    expect(screen.getByText(/No wallets match/i)).toBeInTheDocument();
  });

  it("does not let a filtered-down view re-enable Archive on the last owned wallet", async () => {
    // The guard counts OWNED wallets, not visible ones. Filtering is a view
    // concern; hiding three wallets must not make the fourth look like the
    // only one.
    const user = userEvent.setup();
    render(<WalletList wallets={many} currentUserId={ME} />);
    await user.type(screen.getByLabelText(/Search wallets/i), "Travel");

    swipeLeft(screen.getByRole("listitem", { name: "Travel" }));

    expect(screen.getByRole("dialog", { name: "Archive Travel?" })).toBeInTheDocument();
  });
});


/**
 * Swipe-to-archive and its confirmation (2026-08-29). The Archive text
 * button came off the row to give wallet names their width back on a
 * phone; a swipe replaced it, and Archive also moved into the edit dialog
 * so the function is not reachable ONLY by a gesture — a swipe cannot be
 * performed by keyboard or on a desktop at all.
 */
function swipeLeft(row: HTMLElement, distance = 120) {
  fireEvent.touchStart(row, { touches: [{ clientX: 300, clientY: 40 }] });
  fireEvent.touchMove(row, { touches: [{ clientX: 300 - distance, clientY: 40 }] });
  fireEvent.touchEnd(row, { changedTouches: [{ clientX: 300 - distance, clientY: 40 }] });
}

describe("WalletList — archiving", () => {
  const two = [wallet("a", { name: "Test" }), wallet("b", { name: "Citi" })];

  it("no longer spends row width on an Archive button", () => {
    render(<WalletList wallets={two} currentUserId={ME} />);

    // The width this frees is the entire point of the change — a wallet
    // name was being truncated on a phone to make room for it.
    expect(screen.queryByRole("button", { name: "Archive Test" })).not.toBeInTheDocument();
  });

  it("asks before archiving, naming the wallet and promising its transactions", () => {
    render(<WalletList wallets={two} currentUserId={ME} />);

    swipeLeft(screen.getByRole("listitem", { name: "Test" }));

    const dialog = screen.getByRole("dialog", { name: "Archive Test?" });
    expect(dialog).toBeInTheDocument();
    // Archiving keeps every transaction (archived_at is a soft flag) and
    // saying so is what makes the confirmation honest rather than scary.
    expect(dialog).toHaveTextContent(/transactions are kept/i);
  });

  it("does nothing at all until the confirmation is accepted", async () => {
    const user = userEvent.setup();
    render(<WalletList wallets={two} currentUserId={ME} />);

    swipeLeft(screen.getByRole("listitem", { name: "Test" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(archiveWallet).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("archives the swiped wallet once confirmed", async () => {
    vi.mocked(archiveWallet).mockResolvedValue({});
    const user = userEvent.setup();
    render(<WalletList wallets={two} currentUserId={ME} />);

    swipeLeft(screen.getByRole("listitem", { name: "Citi" }));
    await user.click(screen.getByRole("button", { name: "Archive" }));

    // The SWIPED wallet, not merely some wallet — a shared confirm dialog
    // makes carrying the right id the thing most likely to go wrong.
    await waitFor(() => expect(archiveWallet).toHaveBeenCalledWith("b"));
  });

  it("ignores a short drag, so a scroll is not an archive", () => {
    render(<WalletList wallets={two} currentUserId={ME} />);

    swipeLeft(screen.getByRole("listitem", { name: "Test" }), 20);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  /**
   * The guard that stops a scroll becoming an archive. On a phone almost
   * every vertical drag carries some horizontal drift, so distance alone
   * is not enough to tell "swiping this row" from "scrolling the list" —
   * the finger's DOMINANT axis is. Without this, flicking down a long
   * wallet list would open a confirmation dialog at random.
   */
  it("ignores a mostly-vertical drag, so scrolling is not archiving", () => {
    render(<WalletList wallets={two} currentUserId={ME} />);
    const target = screen.getByRole("listitem", { name: "Test" });

    // 80px left, but 160px down: far enough left to clear the distance
    // threshold, and unmistakably a scroll.
    fireEvent.touchStart(target, { touches: [{ clientX: 300, clientY: 40 }] });
    fireEvent.touchMove(target, { touches: [{ clientX: 220, clientY: 200 }] });
    fireEvent.touchEnd(target, { changedTouches: [{ clientX: 220, clientY: 200 }] });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("ignores a swipe to the RIGHT", () => {
    render(<WalletList wallets={two} currentUserId={ME} />);
    const target = screen.getByRole("listitem", { name: "Test" });

    fireEvent.touchStart(target, { touches: [{ clientX: 100, clientY: 40 }] });
    fireEvent.touchMove(target, { touches: [{ clientX: 260, clientY: 40 }] });
    fireEvent.touchEnd(target, { changedTouches: [{ clientX: 260, clientY: 40 }] });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  /**
   * A gesture is not an affordance: it is invisible, undiscoverable, and
   * impossible to perform with a keyboard or a mouse. Archive therefore
   * also lives in the edit dialog, which is reachable both ways.
   */
  it("also offers Archive inside the edit dialog, for keyboard and desktop", async () => {
    const user = userEvent.setup();
    render(<WalletList wallets={two} currentUserId={ME} editActions={{ a: noopAction }} />);

    await user.click(screen.getByRole("button", { name: "Edit Test" }));
    await user.click(screen.getByRole("button", { name: /Archive this wallet/i }));

    expect(screen.getByRole("dialog", { name: "Archive Test?" })).toBeInTheDocument();
  });

  /**
   * The app needs one active wallet — (app)/layout.tsx sends a user with
   * none to /onboarding. The old UI disabled the button; a gesture cannot
   * be disabled, so the refusal has to be stated after the fact instead of
   * silently doing nothing, which would read as a broken swipe.
   */
  it("refuses to archive a lone wallet, and says why", () => {
    render(<WalletList wallets={[wallet("a", { name: "Only" })]} currentUserId={ME} />);

    swipeLeft(screen.getByRole("listitem", { name: "Only" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/need at least one wallet/i);
    expect(archiveWallet).not.toHaveBeenCalled();
  });

  it("offers no swipe on a wallet somebody else owns", () => {
    render(<WalletList wallets={[...two, wallet("c", { name: "Shared", owner_id: PARTNER })]} currentUserId={ME} />);

    swipeLeft(screen.getByRole("listitem", { name: "Shared" }));

    // archiveWallet is owner-scoped; a member's archive would match zero
    // rows and be reported as success. Same reasoning as the absent button.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
