"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Landmark, CreditCard } from "lucide-react";
import { archiveWallet, type WalletState } from "@/server/actions/wallets";
import { formatAmountInput, formatMoney, minorUnitFor } from "@/lib/money";
import { slotVar } from "@/lib/palette";
import { Modal } from "@/components/Modal";
import { WalletForm } from "@/components/WalletForm";
import type { WalletWithBalance } from "./wallet-rows";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

/**
 * Wallet icons are a closed two-value set (`WALLET_ICONS` in
 * src/lib/validation/wallet.ts), unlike categories' open icon list — so
 * this is a plain lookup with a `kind`-derived fallback rather than
 * src/lib/category-icons.ts's registry.
 */
const WALLET_ICON_COMPONENTS = {
  landmark: Landmark,
  "credit-card": CreditCard,
} as const;

/**
 * The list half of /wallets: current balances, plus per-row Archive.
 *
 * A Client Component only because Archive is interactive — the wallet data
 * itself is fetched in page.tsx (a Server Component) and passed down, the
 * same split src/app/(app)/categories/page.tsx + CategorySection.tsx use.
 *
 * `currentUserId` is a display decision only, not the enforcement
 * boundary — the same split MembersSection.tsx documents for its own
 * `isOwner` prop. `wallets_write` RLS and `archiveWallet`'s own
 * `.eq("owner_id", user.id)` are what actually stop a non-owner; this
 * component's job is not to OFFER a control that can never succeed. Before
 * this prop existed, /wallets (which lists shared wallets since Task 8)
 * rendered Archive on every row, and archiving somebody else's wallet ran
 * an UPDATE that matched zero rows — not an error in Postgres, not an
 * error from PostgREST — so the UI reported success and nothing happened.
 *
 * There is no Undo here, deliberately, unlike TransactionList's delete.
 * Archiving is already reversible in principle (`archived_at` is a soft
 * flag) but nothing in this app un-archives yet, so offering "Undo" would
 * promise a path that doesn't exist. Blocking the one irreversible-feeling
 * case instead — archiving your last wallet — is what the guard below does.
 */
export function WalletList({
  wallets,
  currentUserId,
  memberSections,
  editActions,
}: {
  wallets: WalletWithBalance[];
  currentUserId: string;
  /**
   * Per-wallet content rendered INSIDE that wallet's row — the members list
   * and invite form. Keyed by wallet id.
   *
   * These previously lived in a separate block BELOW the whole list, which
   * detached them from their wallets: two wallets produced two identical
   * "MEMBERS" headings in a row with nothing visible tying either to a
   * wallet. Containment is what fixes that — a members list inside its
   * wallet's card cannot be misread as belonging to another.
   *
   * Passed as ReactNode rather than data because the page (a Server
   * Component) owns the queries and MembersSection is its own Client
   * Component; handing over rendered elements keeps this component from
   * needing to know anything about membership.
   */
  memberSections?: Record<string, React.ReactNode>;
  /**
   * Per-wallet bound `updateWallet` actions, keyed by wallet id. Actions
   * rather than rendered forms — unlike `memberSections` above — because
   * this component must know when a save SUCCEEDED in order to close its
   * dialog, and a pre-rendered node cannot tell it. A Server Component
   * cannot hand a Client Component a callback, but it can hand over a
   * server action, so the form is built here instead.
   *
   * Present only for wallets the viewer OWNS — the page filters them —
   * because `updateWallet` scopes its UPDATE to `owner_id` and an edit
   * matching zero rows would be reported as success. A wallet with no
   * action here simply renders no Edit control.
   */
  editActions?: Record<string, (prev: WalletState, formData: FormData) => Promise<WalletState>>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, start] = useTransition();
  /** Which wallet's dialog is open, and which one. A single value rather
   *  than a per-wallet map: only one modal can be open at a time, and a map
   *  would let two dialogs be "open" at once with only z-order deciding
   *  which the user could reach. */
  const [dialog, setDialog] = useState<{ walletId: string; view: "members" | "edit" } | null>(
    null,
  );
  const [query, setQuery] = useState("");

  // The app requires at least one active wallet to function: (app)/layout.tsx
  // redirects a user with zero active wallets to /onboarding. Archiving the
  // last one would therefore teleport the user out of this screen into
  // setup — so it's blocked here rather than allowed and then explained.
  // `archiveWallet` re-checks this server-side (a Server Function is
  // reachable by direct POST, per that module's own doc comment); this is
  // the UI half, not the enforcement.
  //
  // Counted over OWNED wallets, matching what `archiveWallet` itself counts
  // (`.eq("owner_id", user.id)`). Counting readable wallets instead — which
  // now includes shared ones — made the two disagree: a user with one wallet
  // of their own plus one shared wallet got an ENABLED Archive on their last
  // owned wallet, and only learned it was refused after clicking.
  // Counted over EVERY wallet, never the filtered view: search is a view
  // concern, and hiding rows must not make the remaining one look like the
  // only wallet someone owns.
  const ownedCount = wallets.filter((w) => w.owner_id === currentUserId).length;
  const isLastWallet = ownedCount === 1;

  // The search box earns its space only once scanning gets hard. With two
  // or three wallets the list IS the search result.
  const showSearch = wallets.length > 3;
  const q = query.trim().toLowerCase();
  const visible = q ? wallets.filter((w) => w.name.toLowerCase().includes(q)) : wallets;

  /* Resolved from the full list, never from `visible`: typing in the search
     box while a dialog is open must not unmount the dialog and strand the
     user's half-finished edit. */
  const dialogWallet = dialog ? wallets.find((w) => w.id === dialog.walletId) : undefined;

  function archive(id: string) {
    setError(null);
    setPendingId(id);
    start(async () => {
      // `archiveWallet` RETURNS its error rather than throwing — a thrown
      // message would reach the browser as an opaque digest in production
      // (see that action's own doc comment), and the last-wallet refusal
      // is guidance the user has to be able to read.
      const res = await archiveWallet(id);
      if (res.error) setError(res.error);
      setPendingId(null);
    });
  }

  if (!wallets.length) {
    return (
      <p className="py-8 text-sm" style={{ color: "var(--ink-2)" }}>
        No wallets yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Always mounted, not conditionally rendered — the same reasoning
          every other form in this codebase documents: a role="alert" node
          that appears and gets its text in the same instant is not
          reliably announced, while one that is already there and changes
          is. Empty when there's nothing to say. */}
      <p role="alert" className="text-sm" style={{ color: "var(--neg)" }}>
        {error}
      </p>

      {showSearch && (
        <label className="mb-3 flex flex-col gap-1">
          <span className="text-sm" style={{ color: "var(--ink-2)" }}>
            Search wallets
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Wallet name"
            autoComplete="off"
            className={`rounded-md border px-3 py-2 ${FOCUS_RING}`}
            style={{ borderColor: "var(--ink-2)", background: "var(--surface)", color: "var(--ink)" }}
          />
        </label>
      )}

      {showSearch && visible.length === 0 && (
        <p className="py-6 text-sm" style={{ color: "var(--ink-2)" }}>
          No wallets match “{query.trim()}”.
        </p>
      )}

      <ul className="flex flex-col">
        {visible.map((w) => {
          const Icon = WALLET_ICON_COMPONENTS[w.icon as keyof typeof WALLET_ICON_COMPONENTS] ??
            (w.kind === "card" ? CreditCard : Landmark);
          const archiving = pendingId === w.id;
          const isOwner = w.owner_id === currentUserId;
          return (
            <li
              key={w.id}
              className="mb-2 flex items-center gap-3 rounded-lg border px-3 py-2"
              style={{ borderColor: "var(--grid)" }}
            >
              {/* Colour is never the only cue (spec §6.1/§6.3): the slot
                  colour tints the glyph, but the glyph shape and the name
                  beside it are what actually identify the wallet. */}
              <Icon aria-hidden size={18} style={{ color: slotVar(w.color_slot) }} className="shrink-0" />
              <span className="min-w-0 flex-1">
                {/* The wallet's NAME is the link into its detail screen.
                    The accessible name is the wallet's name alone: nothing
                    inside this anchor besides `w.name`'s text node, so no
                    "Card · USD" leaks into what a screen reader announces
                    as the link's name. */}
                <Link
                  href={`/wallets/${w.id}`}
                  className={`block truncate rounded-sm ${FOCUS_RING}`}
                  style={{ color: "var(--ink)" }}
                >
                  {w.name}
                </Link>
                <span className="block text-xs" style={{ color: "var(--ink-2)" }}>
                  {w.kind === "card" ? "Card" : "Bank"} · {w.currency_code}
                </span>
              </span>
              {/* `balanceMinor === null` means the balance was not computed
                  (see mergeWalletBalances) — an em dash states that, where
                  "$0.00" would assert a balance this app never derived.
                  Unsigned `formatMoney` still prefixes a real minus for a
                  negative balance (a card can genuinely be overdrawn) but
                  adds no "+" to a positive one. */}
              <span
                className="shrink-0 tabular-nums"
                style={{
                  color:
                    w.balanceMinor === null
                      ? "var(--ink-2)"
                      : w.balanceMinor < 0
                        ? "var(--neg)"
                        : "var(--ink)",
                }}
              >
                {w.balanceMinor === null ? "—" : formatMoney(w.balanceMinor, w.currency_code)}
              </span>

              {/* Every row action is named after its wallet. Several rows
                  each render an "Edit"/"Members" control, and by visible
                  text alone they are indistinguishable to anyone navigating
                  by accessible name — the same reasoning the old inline
                  Members toggle already documented. */}
              {editActions?.[w.id] && (
                <button
                  type="button"
                  aria-label={`Edit ${w.name}`}
                  onClick={() => setDialog({ walletId: w.id, view: "edit" })}
                  className={`shrink-0 rounded-sm text-xs underline ${FOCUS_RING}`}
                  style={{ color: "var(--ink-2)" }}
                >
                  Edit
                </button>
              )}

              {memberSections?.[w.id] && (
                <button
                  type="button"
                  aria-label={`Members of ${w.name}`}
                  onClick={() => setDialog({ walletId: w.id, view: "members" })}
                  className={`shrink-0 rounded-sm text-xs underline ${FOCUS_RING}`}
                  style={{ color: "var(--ink-2)" }}
                >
                  Members
                </button>
              )}

              {/* Absent for a non-owner, not disabled — the convention this
                  codebase already applies to a control that can never
                  succeed. A disabled Archive would also read as "you could
                  archive this if something changed", which is false. */}
              {isOwner && (
                <button
                  type="button"
                  aria-label={`Archive ${w.name}`}
                  disabled={isLastWallet || archiving}
                  onClick={() => archive(w.id)}
                  className={`shrink-0 rounded-sm text-xs underline disabled:opacity-60 ${FOCUS_RING}`}
                  style={{ color: "var(--ink-2)" }}
                >
                  {archiving ? "Archiving…" : "Archive"}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {isLastWallet && (
        <p className="text-xs" style={{ color: "var(--ink-2)" }}>
          You need at least one wallet, so this one can’t be archived. Add another first.
        </p>
      )}

      {/* ONE dialog for the whole list, not one per row. Rendering a Modal
          inside every <li> would mount a focus trap and a keydown handler
          per wallet — 30 wallets, 30 traps — when only one can ever be
          open. The open row's slot is looked up here instead.

          Named after the wallet, not just "Edit"/"Members": the dialog's
          accessible name is the only thing telling a screen-reader user
          WHICH wallet they are about to change, since the row they clicked
          is now behind a backdrop. */}
      {dialogWallet && (
        <Modal
          open
          title={
            dialog!.view === "edit" ? `Edit ${dialogWallet.name}` : `Members of ${dialogWallet.name}`
          }
          onClose={() => setDialog(null)}
        >
          {dialog!.view === "edit" && editActions?.[dialogWallet.id] ? (
            <WalletForm
              action={editActions[dialogWallet.id]!}
              submitLabel="Save changes"
              pendingLabel="Saving…"
              defaultCurrency={dialogWallet.currency_code}
              defaults={{
                name: dialogWallet.name,
                kind: dialogWallet.kind,
                currency_code: dialogWallet.currency_code,
                starting_balance: formatAmountInput(
                  dialogWallet.starting_balance_minor,
                  minorUnitFor(dialogWallet.currency_code),
                ),
                color_slot: dialogWallet.color_slot,
                icon: dialogWallet.icon,
              }}
              lockCurrency
              onSuccess={() => setDialog(null)}
            />
          ) : (
            memberSections?.[dialogWallet.id]
          )}
        </Modal>
      )}
    </div>
  );
}
