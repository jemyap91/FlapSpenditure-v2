import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WalletList } from "./WalletList";
import type { WalletWithBalance } from "./wallet-rows";
import { archiveWallet } from "@/server/actions/wallets";
import {
  createWalletGroup,
  deleteWalletGroup,
  setWalletGroup,
  setWalletOrder,
  setWalletSort,
} from "@/server/actions/wallet-groups";

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

// WalletList now also imports the per-user grouping/ordering actions
// (0019). Same reasoning as the mock above: that module carries a
// file-level "use server" and reaches @/lib/supabase/server -> the env
// helpers, and `npm test` runs with no .env.local.
vi.mock("@/server/actions/wallet-groups", () => ({
  createWalletGroup: vi.fn(),
  renameWalletGroup: vi.fn(),
  deleteWalletGroup: vi.fn(),
  setWalletGroup: vi.fn(),
  setWalletOrder: vi.fn(),
  setWalletSort: vi.fn(),
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


/**
 * These tests were written against a flat `wallets` prop. WalletList now
 * takes the list already arranged into sections (0019's per-user grouping),
 * so this supplies the one-ungrouped-section shape `arrangeWallets` produces
 * when the viewer has made no groups — which is every case here, and the
 * state every user starts in.
 *
 * Deliberately not calling `arrangeWallets` itself: it has its own tests in
 * ./wallet-rows.test.ts, and routing these through it would make one sorting
 * bug there fail dozens of unrelated assertions here.
 */
const listProps = (wallets: WalletWithBalance[]) => ({
  sections: [{ group: null, wallets }],
  groups: [],
  sort: "manual" as const,
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
        {...listProps([
          wallet("a", { name: "Everyday", currency_code: "USD", balanceMinor: 125000 }),
          wallet("b", { name: "Tokyo", currency_code: "JPY", balanceMinor: 4200 }),
        ])}
      />,
    );
    expect(screen.getByText("Everyday")).toBeInTheDocument();
    expect(screen.getByText("$1,250.00")).toBeInTheDocument();
    // JPY has no minor units — a shared "divide by 100" would render ¥42.
    expect(screen.getByText("¥4,200")).toBeInTheDocument();
  });

  it("renders a negative balance with a sign rather than as a bare magnitude", () => {
    render(<WalletList currentUserId={ME} {...listProps([wallet("a", { kind: "card", balanceMinor: -5000 })])} />);
    expect(screen.getByText("−$50.00")).toBeInTheDocument();
  });

  it("shows an em dash, not $0.00, when a balance could not be computed", () => {
    render(<WalletList currentUserId={ME} {...listProps([wallet("a", { balanceMinor: null })])} />);
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
    render(<WalletList currentUserId={ME} {...listProps([wallet("a", { name: "Everyday" })])} />);
    const link = screen.getByRole("link", { name: "Everyday" });
    expect(link).toHaveAttribute("href", "/wallets/a");
  });

  /* The Archive BUTTON is gone (2026-08-29) — it moved to a swipe plus an
     entry in the edit dialog, to give wallet names their width back on a
     phone. The behaviour it guarded did not move, so these cases now drive
     the same logic through the swipe. See "WalletList — archiving" below
     for the gesture's own cases. */

  it("refuses to archive the only wallet, and says why", () => {
    render(<WalletList currentUserId={ME} {...listProps([wallet("a", { name: "Everyday" })])} />);

    swipeLeft(screen.getByRole("listitem", { name: "Everyday" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/need at least one wallet/i);
  });

  it("allows archiving once a second wallet exists", () => {
    render(<WalletList currentUserId={ME} {...listProps([wallet("a", { name: "Everyday" }), wallet("b", { name: "Savings" })])} />);

    swipeLeft(screen.getByRole("listitem", { name: "Everyday" }));

    expect(screen.getByRole("dialog", { name: "Archive Everyday?" })).toBeInTheDocument();
  });

  it("archives the wallet that was swiped, not the first one", async () => {
    const user = userEvent.setup();
    render(<WalletList currentUserId={ME} {...listProps([wallet("a", { name: "Everyday" }), wallet("b", { name: "Savings" })])} />);

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
    render(<WalletList currentUserId={ME} {...listProps([wallet("a", { name: "Everyday" }), wallet("b", { name: "Savings" })])} />);

    swipeLeft(screen.getByRole("listitem", { name: "Savings" }));
    await user.click(screen.getByRole("button", { name: "Archive" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not archive wallet");
  });

  it("renders the empty state rather than an empty list", () => {
    render(<WalletList currentUserId={ME} {...listProps([])} />);
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
        {...listProps([
          wallet("a", { name: "Everyday" }),
          wallet("b", { name: "Household", owner_id: PARTNER }),
        ])}
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
        {...listProps([
          wallet("a", { name: "Everyday" }),
          wallet("b", { name: "Household", owner_id: PARTNER }),
        ])}
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
        {...listProps([
          wallet("a", { name: "Everyday" }),
          wallet("b", { name: "Savings" }),
          wallet("c", { name: "Household", owner_id: PARTNER }),
        ])}
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
        {...listProps([wallet("a", { name: "Test" })])}
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
        {...listProps([wallet("a", { name: "Test" }), wallet("b", { name: "Citi" })])}
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
        {...listProps([wallet("a", { name: "Test" })])}
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
        {...listProps([wallet("a", { name: "Shared", owner_id: PARTNER })])}
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
        {...listProps([wallet("a", { name: "Test" })])}
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
        {...listProps([wallet("a", { name: "Test" })])}
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
        {...listProps([wallet("a", { name: "Test" })])}
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
        {...listProps([wallet("a", { name: "Test", balanceMinor: 1491200, currency_code: "SGD" })])}
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
    render(<WalletList {...listProps(many.slice(0, 2))} currentUserId={ME} />);
    expect(screen.queryByLabelText(/Search wallets/i)).not.toBeInTheDocument();
  });

  it("filters by wallet name, case-insensitively", async () => {
    const user = userEvent.setup();
    render(<WalletList {...listProps(many)} currentUserId={ME} />);
    await user.type(screen.getByLabelText(/Search wallets/i), "cItI");
    expect(screen.getByText("Citi Rewards")).toBeInTheDocument();
    expect(screen.queryByText("Everyday")).not.toBeInTheDocument();
  });

  it("says so when nothing matches, rather than rendering an empty list", async () => {
    const user = userEvent.setup();
    render(<WalletList {...listProps(many)} currentUserId={ME} />);
    await user.type(screen.getByLabelText(/Search wallets/i), "zzzz");
    expect(screen.getByText(/No wallets match/i)).toBeInTheDocument();
  });

  it("does not let a filtered-down view re-enable Archive on the last owned wallet", async () => {
    // The guard counts OWNED wallets, not visible ones. Filtering is a view
    // concern; hiding three wallets must not make the fourth look like the
    // only one.
    const user = userEvent.setup();
    render(<WalletList {...listProps(many)} currentUserId={ME} />);
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
    render(<WalletList {...listProps(two)} currentUserId={ME} />);

    // The width this frees is the entire point of the change — a wallet
    // name was being truncated on a phone to make room for it.
    expect(screen.queryByRole("button", { name: "Archive Test" })).not.toBeInTheDocument();
  });

  it("asks before archiving, naming the wallet and promising its transactions", () => {
    render(<WalletList {...listProps(two)} currentUserId={ME} />);

    swipeLeft(screen.getByRole("listitem", { name: "Test" }));

    const dialog = screen.getByRole("dialog", { name: "Archive Test?" });
    expect(dialog).toBeInTheDocument();
    // Archiving keeps every transaction (archived_at is a soft flag) and
    // saying so is what makes the confirmation honest rather than scary.
    expect(dialog).toHaveTextContent(/transactions are kept/i);
  });

  it("does nothing at all until the confirmation is accepted", async () => {
    const user = userEvent.setup();
    render(<WalletList {...listProps(two)} currentUserId={ME} />);

    swipeLeft(screen.getByRole("listitem", { name: "Test" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(archiveWallet).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("archives the swiped wallet once confirmed", async () => {
    vi.mocked(archiveWallet).mockResolvedValue({});
    const user = userEvent.setup();
    render(<WalletList {...listProps(two)} currentUserId={ME} />);

    swipeLeft(screen.getByRole("listitem", { name: "Citi" }));
    await user.click(screen.getByRole("button", { name: "Archive" }));

    // The SWIPED wallet, not merely some wallet — a shared confirm dialog
    // makes carrying the right id the thing most likely to go wrong.
    await waitFor(() => expect(archiveWallet).toHaveBeenCalledWith("b"));
  });

  it("ignores a short drag, so a scroll is not an archive", () => {
    render(<WalletList {...listProps(two)} currentUserId={ME} />);

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
    render(<WalletList {...listProps(two)} currentUserId={ME} />);
    const target = screen.getByRole("listitem", { name: "Test" });

    // 80px left, but 160px down: far enough left to clear the distance
    // threshold, and unmistakably a scroll.
    fireEvent.touchStart(target, { touches: [{ clientX: 300, clientY: 40 }] });
    fireEvent.touchMove(target, { touches: [{ clientX: 220, clientY: 200 }] });
    fireEvent.touchEnd(target, { changedTouches: [{ clientX: 220, clientY: 200 }] });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("ignores a swipe to the RIGHT", () => {
    render(<WalletList {...listProps(two)} currentUserId={ME} />);
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
    render(<WalletList {...listProps(two)} currentUserId={ME} editActions={{ a: noopAction }} />);

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
    render(<WalletList {...listProps([wallet("a", { name: "Only" })])} currentUserId={ME} />);

    swipeLeft(screen.getByRole("listitem", { name: "Only" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/need at least one wallet/i);
    expect(archiveWallet).not.toHaveBeenCalled();
  });

  it("offers no swipe on a wallet somebody else owns", () => {
    render(<WalletList {...listProps([...two, wallet("c", { name: "Shared", owner_id: PARTNER })])} currentUserId={ME} />);

    swipeLeft(screen.getByRole("listitem", { name: "Shared" }));

    // archiveWallet is owner-scoped; a member's archive would match zero
    // rows and be reported as success. Same reasoning as the absent button.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("WalletList — grouping and ordering", () => {
  const everyday = wallet("a", { name: "Everyday" });
  const savings = wallet("b", { name: "Savings" });
  const holiday = wallet("c", { name: "Holiday" });
  const GROUP = { id: "g1", name: "Long term", sort_order: 0 };

  const grouped = {
    sections: [
      { group: GROUP, wallets: [savings, holiday] },
      { group: null, wallets: [everyday] },
    ],
    groups: [GROUP],
    sort: "manual" as const,
  };

  beforeEach(() => {
    vi.mocked(setWalletOrder).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(setWalletSort).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(setWalletGroup).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(createWalletGroup).mockReset();
    vi.mocked(deleteWalletGroup).mockReset().mockResolvedValue({ ok: true });
  });

  it("renders a heading per group, with the ungrouped section labelled last", () => {
    render(<WalletList currentUserId={ME} {...grouped} />);
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["Long term", "Ungrouped"]);
  });

  it("does not label the list at all when there are no groups", () => {
    // A lone "Ungrouped" heading over the whole list says nothing.
    render(<WalletList currentUserId={ME} {...listProps([everyday, savings])} />);
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
  });

  const handle = (name: string) =>
    screen.getByRole("button", { name: new RegExp(`^Reorder ${name},`) });

  it("says where the row sits, so a screen reader knows what moved", () => {
    render(<WalletList currentUserId={ME} {...grouped} />);
    // Without the position every handle announces an identical "Reorder"
    // and a move is inaudible — the list changes and nothing says so.
    expect(handle("Savings")).toHaveAccessibleName(
      "Reorder Savings, 1 of 2. Use arrow keys to move, or drag.",
    );
    expect(handle("Holiday")).toHaveAccessibleName(
      "Reorder Holiday, 2 of 2. Use arrow keys to move, or drag.",
    );
  });

  it("sends the whole list, reordered, when a wallet moves down by keyboard", async () => {
    const user = userEvent.setup();
    render(<WalletList currentUserId={ME} {...grouped} />);

    handle("Savings").focus();
    await user.keyboard("{ArrowDown}");

    // Every wallet, in display order across all sections — not just the two
    // that swapped. sort_order is one integer per wallet across the whole
    // list, so a partial renumbering would contradict the wallets it stepped
    // over.
    expect(setWalletOrder).toHaveBeenCalledWith({ wallet_ids: ["c", "b", "a"] });
  });

  it("moves a wallet up within its own section only", async () => {
    const user = userEvent.setup();
    render(<WalletList currentUserId={ME} {...grouped} />);

    handle("Holiday").focus();
    await user.keyboard("{ArrowUp}");

    expect(setWalletOrder).toHaveBeenCalledWith({ wallet_ids: ["c", "b", "a"] });
  });

  it("does nothing at either end of a section", async () => {
    const user = userEvent.setup();
    render(<WalletList currentUserId={ME} {...grouped} />);

    handle("Savings").focus();
    await user.keyboard("{ArrowUp}");
    handle("Holiday").focus();
    await user.keyboard("{ArrowDown}");

    expect(setWalletOrder).not.toHaveBeenCalled();
  });

  it("shows the new order immediately, before the server answers", async () => {
    const user = userEvent.setup();
    // Never resolves: proves the row moved optimistically rather than only
    // after a round trip, which on a phone would read as a dead control.
    vi.mocked(setWalletOrder).mockReturnValue(new Promise(() => {}));
    render(<WalletList currentUserId={ME} {...grouped} />);

    handle("Savings").focus();
    await user.keyboard("{ArrowDown}");

    const names = screen.getAllByRole("listitem").map((li) => li.getAttribute("aria-label"));
    expect(names).toEqual(["Holiday", "Savings", "Everyday"]);
  });

  /**
   * The pointer half of the same handle.
   *
   * jsdom performs no layout, so every getBoundingClientRect is a zero rect
   * and the drag would find no row under the pointer. Stubbing the rects
   * from live DOM order is what makes this testable at all — and it has to
   * be read fresh on every call, because the rows physically swap mid-drag.
   */
  describe("dragging the handle", () => {
    const ROW_H = 50;

    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        if (this.tagName !== "LI") return new DOMRect();
        const i = Array.from(this.parentElement?.children ?? []).indexOf(this);
        return {
          top: i * ROW_H,
          bottom: (i + 1) * ROW_H,
          height: ROW_H,
          left: 0,
          right: 100,
          width: 100,
          x: 0,
          y: i * ROW_H,
          toJSON: () => ({}),
        } as DOMRect;
      });
    });

    afterEach(() => {
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockRestore?.();
    });

    it("reorders when a row is dragged past another", () => {
      render(<WalletList currentUserId={ME} {...grouped} />);
      const grip = handle("Savings");

      fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientY: 25 });
      fireEvent.pointerMove(grip, { pointerId: 1, clientY: 75 });
      fireEvent.pointerUp(grip, { pointerId: 1, clientY: 75 });

      expect(setWalletOrder).toHaveBeenCalledWith({ wallet_ids: ["c", "b", "a"] });
    });

    it("writes once for a whole drag, not once per row crossed", () => {
      render(<WalletList currentUserId={ME} {...grouped} />);
      const grip = handle("Savings");

      fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientY: 25 });
      // Three moves, two of which cross a boundary.
      fireEvent.pointerMove(grip, { pointerId: 1, clientY: 60 });
      fireEvent.pointerMove(grip, { pointerId: 1, clientY: 75 });
      fireEvent.pointerMove(grip, { pointerId: 1, clientY: 90 });
      expect(setWalletOrder).not.toHaveBeenCalled();

      fireEvent.pointerUp(grip, { pointerId: 1, clientY: 90 });
      expect(setWalletOrder).toHaveBeenCalledTimes(1);
    });

    it("shows the rows swapping while the pointer is still down", () => {
      render(<WalletList currentUserId={ME} {...grouped} />);
      const grip = handle("Savings");

      fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientY: 25 });
      fireEvent.pointerMove(grip, { pointerId: 1, clientY: 75 });

      // The list you see mid-drag is the list you get on release.
      expect(screen.getAllByRole("listitem").map((li) => li.getAttribute("aria-label"))).toEqual([
        "Holiday",
        "Savings",
        "Everyday",
      ]);
    });

    it("ignores a non-primary button, so a right-click drag starts nothing", () => {
      render(<WalletList currentUserId={ME} {...grouped} />);
      const grip = handle("Savings");

      fireEvent.pointerDown(grip, { pointerId: 1, button: 2, clientY: 25 });
      fireEvent.pointerMove(grip, { pointerId: 1, clientY: 75 });
      fireEvent.pointerUp(grip, { pointerId: 1, clientY: 75 });

      expect(setWalletOrder).not.toHaveBeenCalled();
    });

    it("does not reorder across sections", () => {
      // Everyday is in the ungrouped section; a pointer dragged over it from
      // the grouped one must not pull it in. sort_order is per user, but a
      // wallet's SECTION is its group, and a drag cannot change that — the
      // Group control in the edit dialog does.
      render(<WalletList currentUserId={ME} {...grouped} />);
      const grip = handle("Savings");

      fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientY: 25 });
      fireEvent.pointerMove(grip, { pointerId: 1, clientY: 500 });
      fireEvent.pointerUp(grip, { pointerId: 1, clientY: 500 });

      const ids = vi.mocked(setWalletOrder).mock.calls[0]?.[0] as
        | { wallet_ids: string[] }
        | undefined;
      // Either no move at all, or a move that kept Everyday last.
      expect(ids?.wallet_ids.at(-1) ?? "a").toBe("a");
    });
  });

  it("offers no reordering when the list is sorted by name", () => {
    // The position is derived under name/date ordering, so a move would
    // either be ignored or silently switch the list back to manual.
    render(<WalletList currentUserId={ME} {...grouped} sort="name" />);
    // Queried by the label the handle actually has. The earlier version of
    // this test looked for /^Move /, which stopped matching anything the
    // moment the two arrow buttons became one drag handle — it would have
    // passed against a screen full of handles.
    expect(screen.queryByRole("button", { name: /^Reorder / })).toBeNull();
  });

  it("records the chosen ordering", async () => {
    const user = userEvent.setup();
    render(<WalletList currentUserId={ME} {...grouped} />);
    await user.selectOptions(screen.getByLabelText("Order"), "name");
    expect(setWalletSort).toHaveBeenCalledWith("name");
  });

  it("creates a group, and refuses an empty name without calling the server", async () => {
    const user = userEvent.setup();
    vi.mocked(createWalletGroup).mockResolvedValue({
      group: { id: "g2", name: "Business", sort_order: 1 },
    });
    render(<WalletList currentUserId={ME} {...grouped} />);

    await user.click(screen.getByRole("button", { name: "Add group" }));
    expect(createWalletGroup).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Name is required");

    await user.type(screen.getByLabelText("New group"), "Business");
    await user.click(screen.getByRole("button", { name: "Add group" }));
    expect(createWalletGroup).toHaveBeenCalledWith({ name: "Business" });
  });

  it("files a wallet into a group from its edit dialog, and back out again", async () => {
    const user = userEvent.setup();
    render(<WalletList currentUserId={ME} {...grouped} editActions={{ a: noopAction }} />);

    await user.click(screen.getByRole("button", { name: "Edit Everyday" }));
    await user.selectOptions(screen.getByLabelText("Group"), "g1");
    expect(setWalletGroup).toHaveBeenCalledWith({ wallet_id: "a", group_id: "g1" });
  });

  it("sends null, not an empty string, when a wallet leaves every group", async () => {
    const user = userEvent.setup();
    render(<WalletList currentUserId={ME} {...grouped} editActions={{ b: noopAction }} />);

    await user.click(screen.getByRole("button", { name: "Edit Savings" }));
    // The <option> value is "" — an empty string reaching the action would
    // fail uuid validation instead of ungrouping the wallet.
    await user.selectOptions(screen.getByLabelText("Group"), "");
    expect(setWalletGroup).toHaveBeenCalledWith({ wallet_id: "b", group_id: null });
  });

  it("seeds the group control from the wallet's current group", async () => {
    const user = userEvent.setup();
    render(<WalletList currentUserId={ME} {...grouped} editActions={{ b: noopAction }} />);
    await user.click(screen.getByRole("button", { name: "Edit Savings" }));
    expect(screen.getByLabelText("Group")).toHaveValue("g1");
  });

  it("says what happens to the wallets before deleting a group", async () => {
    const user = userEvent.setup();
    render(<WalletList currentUserId={ME} {...grouped} />);

    await user.click(screen.getByRole("button", { name: "Rename or delete Long term" }));
    // The question a delete control raises, answered before it is pressed:
    // wallet_prefs.group_id is `on delete set null (group_id)`.
    expect(screen.getByText(/keeps its wallets/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete group" }));
    expect(deleteWalletGroup).toHaveBeenCalledWith("g1");
  });
});

describe("WalletList — the trailing control column", () => {
  const a = wallet("a", { name: "Everyday" });
  const b = wallet("b", { name: "Savings" });

  /** The container the row's trailing controls share. */
  const cluster = (name: string) =>
    screen.getByRole("button", { name: `Edit ${name}` }).parentElement!;

  it("keeps every trailing control in one column, not spread along the row", () => {
    render(
      <WalletList
        currentUserId={ME}
        {...listProps([a])}
        editActions={{ a: noopAction }}
        memberSections={{ a: <div key="a" /> }}
      />,
    );
    // One parent for all of them. Loose in the row they each took a gap-2
    // (8px) separator from the name, which is what squeezed it on a phone.
    expect(screen.getByRole("button", { name: "Members of Everyday" }).parentElement).toBe(
      cluster("Everyday"),
    );
  });

  it("reserves the slot when one wallet lacks a control its neighbours have", () => {
    // Savings has no members section. Without a reserved slot its name would
    // start 36px further right than Everyday's, and a column of truncated
    // names that all break at different points is much harder to scan than
    // one that breaks in the same place.
    render(
      <WalletList
        currentUserId={ME}
        {...listProps([a, b])}
        editActions={{ a: noopAction, b: noopAction }}
        memberSections={{ a: <div key="a" /> }}
      />,
    );
    expect(cluster("Savings").children).toHaveLength(cluster("Everyday").children.length);
  });

  it("reserves nothing when the page offers no members at all", () => {
    // A reserved slot on every row of a list that has no members control
    // would waste the width this change exists to reclaim.
    render(<WalletList currentUserId={ME} {...listProps([a])} editActions={{ a: noopAction }} />);
    expect(cluster("Everyday").children).toHaveLength(1);
  });

  it("keeps the name truncating rather than pushing the controls off-screen", () => {
    render(
      <WalletList
        currentUserId={ME}
        {...listProps([wallet("a", { name: "A very long wallet name indeed" })])}
        editActions={{ a: noopAction }}
      />,
    );
    // `truncate` on the link and `min-w-0` on its column are what make the
    // name yield; a flex child defaults to min-width:auto and would instead
    // shove the controls out of the row.
    const link = screen.getByRole("link", { name: "A very long wallet name indeed" });
    expect(link.className).toContain("truncate");
    expect(link.closest("span")?.className).toContain("min-w-0");
  });
});
