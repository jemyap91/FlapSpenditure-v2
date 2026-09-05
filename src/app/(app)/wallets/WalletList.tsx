"use client";

import { useId, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Landmark, CreditCard, Settings, User, GripVertical } from "lucide-react";
import type { WalletSort } from "@/lib/validation/wallet-group";
import {
  createWalletGroup,
  renameWalletGroup,
  deleteWalletGroup,
  setWalletGroup,
  setWalletOrder,
  setWalletSort,
} from "@/server/actions/wallet-groups";
import { archiveWallet, type WalletState } from "@/server/actions/wallets";
import { formatAmountInput, formatMoney, minorUnitFor } from "@/lib/money";
import { slotVar } from "@/lib/palette";
import { Modal } from "@/components/Modal";
import { WalletForm } from "@/components/WalletForm";
import type {
  WalletWithBalance,
  WalletSection,
  WalletGroup,
} from "./wallet-rows";

/** How far a finger must travel left before it counts as a swipe rather
 *  than a tap that wandered. */
const SWIPE_MIN_PX = 60;

/**
 * The row's trailing controls sit in one fixed-width column so the wallet
 * NAME gets every remaining pixel, and gets the same number of them on every
 * row.
 *
 * Two separate problems, and the second is the one that made names hard to
 * read on a phone. The cluster was wide — three targets 8px apart — and it
 * was VARIABLE: the drag handle renders only under "My order", so a name
 * could start at one x on one screen and another elsewhere, and each row
 * truncated at a different point.
 *
 * 44px tall is kept; only the width narrows. A 36×44 target satisfies WCAG
 * 2.2 §2.5.8 (Target Size Minimum) with room to spare — that criterion asks
 * for 24×24, not 44×44. 44 is §2.5.5 (AAA) and the Apple/Material figure,
 * which the height still meets in the axis a thumb travelling down a list
 * actually needs. The row itself is the large target for tapping the wallet;
 * these are the precise ones beside it.
 *
 * (An earlier comment here claimed 44px was "the size WCAG 2.5.8 asks for".
 * That was wrong about which criterion — 2.5.8 is 24×24 — and is corrected
 * rather than repeated.)
 */
const ROW_CONTROL = "h-11 w-9";
const ROW_GRIP = "h-11 w-7";

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
  sections,
  groups,
  sort,
  currentUserId,
  memberSections,
  editActions,
}: {
  /**
   * The list already arranged into the viewer's own sections by
   * `arrangeWallets` (./wallet-rows.ts), rather than a flat array this
   * component sorts itself. The arranging is pure and unit-tested there;
   * doing it here would put every ordering rule inside a component that
   * needs a DOM to test.
   */
  sections: WalletSection[];
  /** The viewer's own groups, for the "move to group" control. Passed
   *  separately from `sections` because a group with no wallets in it still
   *  has to be offered as a destination. */
  groups: WalletGroup[];
  sort: WalletSort;
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
  const [dialog, setDialog] = useState<{
    walletId: string;
    view: "members" | "edit" | "archive";
  } | null>(null);
  const [query, setQuery] = useState("");
  /** Where the current touch began, per row. A ref, not state: this changes
   *  on every touchmove and nothing on screen depends on it, so re-rendering
   *  the whole list mid-gesture would be pure cost. */
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  /** Which group's rename/delete dialog is open. */
  const [groupDialog, setGroupDialog] = useState<WalletGroup | null>(null);
  const [groupName, setGroupName] = useState("");
  const [newGroup, setNewGroup] = useState("");
  /** Arrangement writes share one pending flag. Unlike archiving — where
   *  each row needs its own, so one archive does not disable every other
   *  row's control — reordering and regrouping both rewrite the same list,
   *  and letting a second land while the first is in flight would race two
   *  orderings against each other. */
  const [arranging, startArrange] = useTransition();

  /** Optimistic, and deliberately so: the server action revalidates, but a
   *  move that only appeared after a round trip would feel broken on a
   *  phone. The list re-renders from the server's answer when it arrives. */
  // Explicit ids for the two <select>s below, so each is labelled with
  // htmlFor rather than by a wrapping <label>. A wrapping label's accessible
  // name is its whole text content, option text included, so the Order
  // control was named "OrderMy orderName (A-Z)Date" -- and any
  // getByLabel("Name") on this page (every e2e helper that adds a wallet)
  // matched it as well as the real Name field. Same defect the hint under
  // the Group select already documents from the other side.
  const orderSelectId = useId();
  const groupSelectId = useId();
  const [orderOverride, setOrderOverride] = useState<Record<string, string[]>>({});

  /** The row elements, so a drag can ask where each one currently sits.
   *  A ref rather than state: measuring during a pointermove must not
   *  schedule a render of its own. */
  const rowEls = useRef(new Map<string, HTMLLIElement>());
  /** The drag in flight: which section, and which position the dragged
   *  wallet currently occupies (it moves as you cross other rows, so this
   *  is not the index the drag started at). */
  const drag = useRef<{ key: string; index: number; pointerId: number } | null>(null);
  /** Mirrors `drag` for rendering only. A ref cannot re-render, and the
   *  dragged row needs to look picked up. */
  const [draggingId, setDraggingId] = useState<string | null>(null);

  // Flattened once for the guards that reason about the whole list — the
  // last-wallet check, whether a search box is worth showing, and the empty
  // state. Those questions are about the set of wallets, not its
  // arrangement, so they are unchanged by grouping.
  const wallets = useMemo(() => sections.flatMap((s) => s.wallets), [sections]);

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

  /**
   * Where a swipe and the edit dialog's Archive both land. The last-wallet
   * refusal is stated rather than silently ignored: the old UI could
   * DISABLE a button, but a gesture has no disabled state, so a swipe that
   * quietly did nothing would read as a broken swipe.
   */
  function requestArchive(w: WalletWithBalance) {
    if (w.owner_id !== currentUserId) return;
    if (isLastWallet) {
      setError("You need at least one wallet. Add another before archiving this one.");
      return;
    }
    setError(null);
    setDialog({ walletId: w.id, view: "archive" });
  }

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

  const sectionKey = (sec: WalletSection) => sec.group?.id ?? "\u0000ungrouped";

  /** A section's wallets in display order, honouring an optimistic move that
   *  the server has not confirmed yet. An override naming an id no longer in
   *  the section (a wallet archived in another tab) is skipped rather than
   *  rendered as a hole, and any wallet the override does not mention is
   *  appended — so a stale override can reorder the list but never lose a
   *  row from it. */
  function orderedWallets(sec: WalletSection): WalletWithBalance[] {
    const ids = orderOverride[sectionKey(sec)];
    if (!ids) return sec.wallets;
    const byId = new Map(sec.wallets.map((w) => [w.id, w]));
    const out = ids.map((id) => byId.get(id)).filter((w): w is WalletWithBalance => Boolean(w));
    const seen = new Set(out.map((w) => w.id));
    return [...out, ...sec.wallets.filter((w) => !seen.has(w.id))];
  }

  /**
   * Moves one wallet up or down within its own section.
   *
   * Up/down controls rather than drag-and-drop: a drag needs a pointer that
   * can hover, competes with the swipe-to-archive gesture already bound to
   * these rows, and is close to untestable without a real browser — which
   * this plan has none of. Two buttons work with touch, mouse, keyboard and
   * a screen reader, and each press is a discrete, assertable event.
   *
   * The payload is the WHOLE list, every section flattened in display order,
   * not just the two rows that swapped: `sort_order` is one integer per
   * wallet across the user's whole list, so renumbering only a pair would
   * leave it inconsistent with every wallet the move stepped over.
   */
  /** Applies a new within-section order optimistically and persists it.
   *  Shared by the keyboard path and the drag path so the two cannot drift:
   *  a drag that saved differently from an arrow press would be a bug nobody
   *  would find until their order silently reverted. */
  function commitOrder(sec: WalletSection, next: WalletWithBalance[]) {
    const key = sectionKey(sec);
    setOrderOverride((prev) => ({ ...prev, [key]: next.map((w) => w.id) }));

    const flat = sections.flatMap((other) =>
      sectionKey(other) === key ? next.map((w) => w.id) : orderedWallets(other).map((w) => w.id),
    );
    startArrange(async () => {
      const res = await setWalletOrder({ wallet_ids: flat });
      if ("error" in res) {
        setError(res.error);
        // Rolled back, so the list never shows an order the server refused.
        setOrderOverride((prev) => {
          const copy = { ...prev };
          delete copy[key];
          return copy;
        });
      }
    });
  }

  /** One step up or down — the keyboard half of the handle. */
  function move(sec: WalletSection, index: number, delta: -1 | 1) {
    const current = orderedWallets(sec);
    const target = index + delta;
    if (target < 0 || target >= current.length) return;
    const next = [...current];
    [next[index], next[target]] = [next[target]!, next[index]!];
    commitOrder(sec, next);
  }

  /**
   * Pointer-drag reordering, from the handle only.
   *
   * Pointer Events rather than HTML5 drag-and-drop: `draggable` + `dragover`
   * does not fire on touch at all, so it would have shipped a reorder that
   * works on a desktop and silently does nothing on the phone this app is
   * mostly used on. One pointer code path covers mouse, touch and stylus.
   *
   * Bound to a HANDLE, never the whole row, because the row already carries
   * swipe-left-to-archive on touch. A full-row drag would race that gesture,
   * and the failure mode is "I tried to reorder and archived my wallet".
   * `touch-action: none` on the handle stops the browser claiming the
   * gesture as a scroll before the first pointermove arrives.
   *
   * Rows swap live as the pointer crosses their midpoints, so the list you
   * see while dragging is the list you get. Nothing is persisted until
   * pointerup: a drag across five rows is one write, not five.
   */
  function onHandlePointerDown(sec: WalletSection, index: number, walletId: string) {
    return (e: React.PointerEvent<HTMLButtonElement>) => {
      // Primary button / single touch only. A right-click drag or a second
      // finger mid-drag would otherwise start a second, competing move.
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      drag.current = { key: sectionKey(sec), index, pointerId: e.pointerId };
      setDraggingId(walletId);
    };
  }

  function onHandlePointerMove(sec: WalletSection) {
    return (e: React.PointerEvent<HTMLButtonElement>) => {
      const d = drag.current;
      if (!d || d.pointerId !== e.pointerId || d.key !== sectionKey(sec)) return;

      const current = orderedWallets(sec);
      const y = e.clientY;

      // Which row is the pointer over now? Measured every move rather than
      // cached: the rows physically move as they swap, so a cached geometry
      // would be describing a layout that no longer exists after the first
      // swap.
      let target = d.index;
      for (let i = 0; i < current.length; i++) {
        const el = rowEls.current.get(current[i]!.id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        // jsdom reports every rect as zero, so this loop finds nothing and
        // the drag is inert there — which is why the keyboard path below is
        // what the tests actually exercise.
        if (r.height === 0) continue;
        if (y >= r.top && y <= r.bottom) {
          target = i;
          break;
        }
      }
      if (target === d.index) return;

      const next = [...current];
      const [moved] = next.splice(d.index, 1);
      next.splice(target, 0, moved!);
      d.index = target;
      // Local only. Persisting here would issue a write per row crossed.
      setOrderOverride((prev) => ({ ...prev, [d.key]: next.map((w) => w.id) }));
    };
  }

  function onHandlePointerUp(sec: WalletSection) {
    return (e: React.PointerEvent<HTMLButtonElement>) => {
      const d = drag.current;
      drag.current = null;
      setDraggingId(null);
      if (!d || d.pointerId !== e.pointerId) return;
      // `orderedWallets` already reflects every swap the drag made, so this
      // persists exactly what the user is looking at.
      commitOrder(sec, orderedWallets(sec));
    };
  }

  /** Which group a wallet is currently filed under, read back out of the
   *  arranged sections rather than tracked separately — `sections` is the
   *  single source of that fact, and a second copy would be one more thing
   *  to keep in step. */
  function groupOf(walletId: string): string | null {
    for (const sec of sections) {
      if (sec.group && sec.wallets.some((w) => w.id === walletId)) return sec.group.id;
    }
    return null;
  }

  function assignGroup(walletId: string, groupId: string | null) {
    startArrange(async () => {
      const res = await setWalletGroup({ wallet_id: walletId, group_id: groupId });
      if ("error" in res) setError(res.error);
      else setDialog(null);
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

      {/* Sorting and grouping controls. Rendered above the search box
          because they change what the list IS, while search only narrows
          what is already there. */}
      <div className="mb-2 flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={orderSelectId} className="text-xs" style={{ color: "var(--ink-2)" }}>
            Order
          </label>
          <select
            id={orderSelectId}
            value={sort}
            onChange={(e) => {
              const next = e.target.value as WalletSort;
              startArrange(async () => {
                const res = await setWalletSort(next);
                if ("error" in res) setError(res.error);
              });
            }}
            className={`rounded-md border px-2 py-1 text-sm ${FOCUS_RING}`}
            style={{ borderColor: "var(--ink-2)", background: "var(--surface)", color: "var(--ink)" }}
          >
            <option value="manual">My order</option>
            <option value="name">Name (A-Z)</option>
            <option value="created">Date added</option>
          </select>
        </div>

        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const name = newGroup.trim();
            if (!name) {
              setError("Name is required");
              return;
            }
            setError("");
            startArrange(async () => {
              const res = await createWalletGroup({ name });
              if ("error" in res) setError(res.error);
              else setNewGroup("");
            });
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="text-xs" style={{ color: "var(--ink-2)" }}>
              New group
            </span>
            <input
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
              maxLength={40}
              placeholder="Savings"
              autoComplete="off"
              className={`rounded-md border px-2 py-1 text-sm ${FOCUS_RING}`}
              style={{ borderColor: "var(--ink-2)", background: "var(--surface)", color: "var(--ink)" }}
            />
          </label>
          <button
            type="submit"
            disabled={arranging}
            className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-60 ${FOCUS_RING}`}
            style={{ background: "var(--cat-1)", color: "var(--surface)" }}
          >
            Add group
          </button>
        </form>
      </div>

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

      {sections.map((section) => {
        const inOrder = orderedWallets(section);
        const rows = q ? inOrder.filter((w) => w.name.toLowerCase().includes(q)) : inOrder;
        // A section with nothing matching the search is hidden entirely
        // rather than rendered as an empty heading — during a search the
        // headings are noise, and an "Everyday (empty)" line would read as
        // "your Everyday group is empty" rather than "nothing here matches".
        if (q && rows.length === 0) return null;
        return (
          <div key={section.group?.id ?? "\u0000ungrouped"} className="mb-2">
            {/* The ungrouped section is only labelled when there is
                something to distinguish it FROM. With no groups at all it is
                the whole list, and a lone "Ungrouped" heading over
                everything says nothing. */}
            {(section.group || sections.length > 1) && (
              <div className="mb-1 flex items-center gap-2 px-1">
                <h3
                  className="text-xs font-medium uppercase tracking-wide"
                  style={{ color: "var(--muted)" }}
                >
                  {section.group?.name ?? "Ungrouped"}
                </h3>
                {section.group && (
                  <button
                    type="button"
                    onClick={() => setGroupDialog(section.group!)}
                    aria-label={`Rename or delete ${section.group.name}`}
                    className={`rounded-sm p-1 ${FOCUS_RING}`}
                    style={{ color: "var(--ink-2)" }}
                  >
                    <Settings size={13} aria-hidden />
                  </button>
                )}
              </div>
            )}
            {rows.length === 0 && (
              <p className="px-1 pb-2 text-sm" style={{ color: "var(--ink-2)" }}>
                Nothing here yet.
              </p>
            )}
      <ul className="flex flex-col">
        {rows.map((w, rowIndex) => {
          const Icon = WALLET_ICON_COMPONENTS[w.icon as keyof typeof WALLET_ICON_COMPONENTS] ??
            (w.kind === "card" ? CreditCard : Landmark);
          // The confirmation dialog closes as soon as Archive is pressed,
          // so without this the row would sit unchanged while the request
          // is in flight and the press would read as having done nothing.
          const archiving = pendingId === w.id;
          return (
            <li
              key={w.id}
              ref={(el) => {
                // Kept in a Map rather than an array so a row's geometry is
                // still findable after a swap has reordered the list.
                if (el) rowEls.current.set(w.id, el);
                else rowEls.current.delete(w.id);
              }}
              aria-label={w.name}
              /* Swipe-left to archive, touch only. A mouse drag is
                 deliberately not wired: it fights text selection and
                 misfires, and desktop/keyboard reach the same action
                 through the edit dialog instead.

                 The vertical check is what stops this stealing scrolls —
                 a finger travelling mostly down the page is scrolling a
                 list, not swiping a row, and on a phone almost every
                 horizontal movement carries some vertical drift. */
              onTouchStart={(e) => {
                const t = e.touches[0]!;
                touchStart.current = { x: t.clientX, y: t.clientY };
              }}
              onTouchEnd={(e) => {
                const from = touchStart.current;
                touchStart.current = null;
                if (!from) return;
                const t = e.changedTouches[0]!;
                const dx = t.clientX - from.x;
                const dy = t.clientY - from.y;
                if (dx > -SWIPE_MIN_PX) return;
                if (Math.abs(dy) > Math.abs(dx)) return;
                requestArchive(w);
              }}
              className="mb-2 flex items-center gap-2 rounded-lg border px-3 py-2 transition-opacity"
              style={{
                borderColor: "var(--grid)",
                opacity: archiving ? 0.5 : 1,
                // The row being dragged is lifted off the list. Without a
                // visible "picked up" state the rows shuffling underneath
                // read as the list glitching rather than as a drag.
                boxShadow: draggingId === w.id ? "0 2px 8px rgb(0 0 0 / 0.25)" : undefined,
                background: draggingId === w.id ? "var(--grid)" : undefined,
              }}
              aria-busy={archiving || undefined}
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
              {/* Icons, not text links. Two words per row ("Edit",
                  "Members", and formerly "Archive") were eating the width a
                  wallet name needs on a phone, truncating the one thing
                  that identifies the row. The accessible names are
                  unchanged and still name the wallet, so nothing a screen
                  reader or a test relies on moved.

                  h-11 w-11 is a 44px target — the size WCAG 2.5.8 and both
                  platform guidelines ask for, and a real improvement on the
                  ~16px text links these replace. */}
              <div className="flex shrink-0 items-center gap-0.5">
              {/* Reordering is offered only under "My order". Under name or
                  date the position is derived, so a move would either be
                  ignored or silently switch the whole list back to manual —
                  both worse than not offering the control. Hidden rather
                  than disabled, following this codebase's rule about
                  controls that cannot succeed.

                  ONE control, working two ways. Dragging alone would fail
                  WCAG 2.2 §2.5.7 (Dragging Movements), which requires a
                  single-pointer alternative to every drag — and would leave
                  keyboard and screen-reader users with no way to reorder at
                  all. A keyboard-operable handle satisfies that without the
                  pair of arrow buttons this replaced, which is what made the
                  row cluttered.

                  `aria-label` carries the position because a screen reader
                  otherwise announces an identical "Reorder" on every row
                  with nothing to say where it is or whether it moved. */}
              {sort === "manual" && !q && rows.length > 1 && (
                <button
                  type="button"
                  aria-label={`Reorder ${w.name}, ${rowIndex + 1} of ${rows.length}. Use arrow keys to move, or drag.`}
                  disabled={arranging}
                  onPointerDown={onHandlePointerDown(section, rowIndex, w.id)}
                  onPointerMove={onHandlePointerMove(section)}
                  onPointerUp={onHandlePointerUp(section)}
                  onPointerCancel={onHandlePointerUp(section)}
                  onKeyDown={(e) => {
                    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                    // Or the page scrolls under the row being moved.
                    e.preventDefault();
                    move(section, rowIndex, e.key === "ArrowUp" ? -1 : 1);
                  }}
                  className={`grid ${ROW_GRIP} shrink-0 cursor-grab place-items-center rounded-md disabled:opacity-30 ${FOCUS_RING}`}
                  style={{
                    color: "var(--ink-2)",
                    // Stops the browser treating the first finger movement
                    // as a scroll, which would swallow the drag entirely.
                    touchAction: "none",
                  }}
                >
                  <GripVertical size={16} aria-hidden />
                </button>
              )}

              {/* A reserved slot when this row has no edit action but others
                  do. Without it one wallet missing a control shifts its
                  neighbours' names sideways, and a list of truncated names
                  that all break at different points is markedly harder to
                  scan than one that breaks at the same place. Nothing is
                  reserved when the page passes no editActions at all. */}
              {editActions && !editActions[w.id] && (
                <span aria-hidden className={`block ${ROW_CONTROL}`} />
              )}
              {editActions?.[w.id] && (
                <button
                  type="button"
                  aria-label={`Edit ${w.name}`}
                  onClick={() => setDialog({ walletId: w.id, view: "edit" })}
                  className={`grid ${ROW_CONTROL} shrink-0 place-items-center rounded-md ${FOCUS_RING}`}
                  style={{ color: "var(--ink-2)" }}
                >
                  <Settings size={18} aria-hidden />
                </button>
              )}

              {memberSections && !memberSections[w.id] && (
                <span aria-hidden className={`block ${ROW_CONTROL}`} />
              )}
              {memberSections?.[w.id] && (
                <button
                  type="button"
                  aria-label={`Members of ${w.name}`}
                  onClick={() => setDialog({ walletId: w.id, view: "members" })}
                  className={`grid ${ROW_CONTROL} shrink-0 place-items-center rounded-md ${FOCUS_RING}`}
                  style={{ color: "var(--ink-2)" }}
                >
                  <User size={18} aria-hidden />
                </button>
              )}
              </div>
            </li>
          );
        })}
      </ul>
          </div>
        );
      })}

      {/* Rename or delete a group. Separate from the wallet dialog because
          it acts on the group, not on any wallet in it — and because
          deleting one must be able to say what happens to the wallets,
          which is the question a user actually has at that moment. */}
      {groupDialog && (
        <Modal
          open
          title={`Edit ${groupDialog.name}`}
          onClose={() => {
            setGroupDialog(null);
            setGroupName("");
          }}
        >
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const name = (groupName || groupDialog.name).trim();
              if (!name) {
                setError("Name is required");
                return;
              }
              setError("");
              startArrange(async () => {
                const res = await renameWalletGroup({ id: groupDialog.id, name });
                if ("error" in res) setError(res.error);
                else {
                  setGroupDialog(null);
                  setGroupName("");
                }
              });
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="text-xs" style={{ color: "var(--ink-2)" }}>
                Name
              </span>
              <input
                value={groupName || groupDialog.name}
                onChange={(e) => setGroupName(e.target.value)}
                maxLength={40}
                autoComplete="off"
                className={`rounded-md border px-3 py-2 text-sm ${FOCUS_RING}`}
                style={{
                  borderColor: "var(--ink-2)",
                  background: "var(--surface)",
                  color: "var(--ink)",
                }}
              />
            </label>
            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={arranging}
                className={`rounded-md px-3 py-2 text-sm font-medium disabled:opacity-60 ${FOCUS_RING}`}
                style={{ background: "var(--cat-1)", color: "var(--surface)" }}
              >
                Save
              </button>
              <button
                type="button"
                disabled={arranging}
                onClick={() => {
                  startArrange(async () => {
                    const res = await deleteWalletGroup(groupDialog.id);
                    if ("error" in res) setError(res.error);
                    else {
                      setGroupDialog(null);
                      setGroupName("");
                    }
                  });
                }}
                className={`rounded-md px-3 py-2 text-sm ${FOCUS_RING}`}
                style={{ color: "var(--neg)" }}
              >
                Delete group
              </button>
            </div>
            {/* Stated because it is the question a delete control raises, and
                the answer is not obvious: wallet_prefs.group_id is
                `on delete set null (group_id)`, so the wallets survive and
                keep their order -- they simply return to Ungrouped. */}
            <p className="text-xs" style={{ color: "var(--ink-2)" }}>
              Deleting a group keeps its wallets. They move back to Ungrouped.
            </p>
          </form>
        </Modal>
      )}

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
            dialog!.view === "edit"
              ? `Edit ${dialogWallet.name}`
              : dialog!.view === "archive"
                ? `Archive ${dialogWallet.name}?`
                : `Members of ${dialogWallet.name}`
          }
          onClose={() => setDialog(null)}
        >
          {dialog!.view === "archive" ? (
            <div className="flex flex-col gap-4">
              <p className="text-sm" style={{ color: "var(--ink)" }}>
                {dialogWallet.name} will be hidden from your wallets.{" "}
                {/* Stated because it is the question a confirmation dialog
                    actually has to answer. `archived_at` is a soft flag and
                    nothing cascades, so the history genuinely survives —
                    saying so is what keeps this from reading as a delete. */}
                <strong style={{ color: "var(--ink)" }}>Its transactions are kept</strong> and stay
                in your reports.
              </p>
              {dialogWallet.balanceMinor !== null && (
                <p className="text-sm" style={{ color: "var(--ink-2)" }}>
                  Balance: {formatMoney(dialogWallet.balanceMinor, dialogWallet.currency_code)}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDialog(null)}
                  className={`rounded-md border px-4 py-2 text-sm ${FOCUS_RING}`}
                  style={{ borderColor: "var(--ink-2)", color: "var(--ink)" }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={pendingId === dialogWallet.id}
                  onClick={() => {
                    const id = dialogWallet.id;
                    setDialog(null);
                    archive(id);
                  }}
                  className={`rounded-md px-4 py-2 text-sm font-medium disabled:opacity-60 ${FOCUS_RING}`}
                  style={{ background: "var(--neg)", color: "var(--surface)" }}
                >
                  Archive
                </button>
              </div>
            </div>
          ) : dialog!.view === "edit" && editActions?.[dialogWallet.id] ? (
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
          ) : null}

          {/* Archive's keyboard and desktop route. The swipe gesture is a
              shortcut, not the only way in: a gesture cannot be performed
              with a keyboard or a mouse, and hiding a function entirely
              behind one would put it out of reach for anyone not on a
              touchscreen. Both paths open the same confirmation. */}
          {/* Group assignment sits with the wallet's other settings, but
              OUTSIDE WalletForm: it is per-user state about a shared object
              (0019_wallet_groups.sql), written through its own action, and
              folding it into the wallet's own form would imply it travels
              with the wallet to every member. Available to any member, not
              just the owner — arranging your own screen is not an ownership
              decision, which is exactly why Archive below is gated and this
              is not. */}
          {dialog!.view === "edit" && (
            <div className="mt-4 flex flex-col gap-1">
              <label htmlFor={groupSelectId} className="text-sm" style={{ color: "var(--ink-2)" }}>
                Group
              </label>
              <select
                id={groupSelectId}
                value={groupOf(dialogWallet.id) ?? ""}
                disabled={arranging}
                onChange={(e) => assignGroup(dialogWallet.id, e.target.value || null)}
                className={`rounded-md border px-3 py-2 text-sm ${FOCUS_RING}`}
                style={{
                  borderColor: "var(--ink-2)",
                  background: "var(--surface)",
                  color: "var(--ink)",
                }}
              >
                <option value="">No group</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {dialog!.view === "edit" && (
            /* Outside the label, deliberately. A wrapping label's accessible
               name is its whole text content, so keeping this hint inside
               made the select's name "GroupOnly you see this grouping." --
               matching neither what a user reads nor what a test asks for.
               The label is now htmlFor-bound for the same reason. */
            <p className="mt-1 text-xs" style={{ color: "var(--ink-2)" }}>
              Only you see this grouping.
            </p>
          )}

          {dialog!.view === "edit" && dialogWallet.owner_id === currentUserId && (
            <div className="mt-4 border-t pt-4" style={{ borderColor: "var(--grid)" }}>
              <button
                type="button"
                onClick={() => requestArchive(dialogWallet)}
                className={`rounded-sm text-sm underline ${FOCUS_RING}`}
                style={{ color: "var(--neg)" }}
              >
                Archive this wallet
              </button>
            </div>
          )}

          {dialog!.view === "members" && (
            memberSections?.[dialogWallet.id]
          )}
        </Modal>
      )}
    </div>
  );
}
