"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, CreditCard, Landmark } from "lucide-react";
import { slotVar } from "@/lib/palette";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

/** The popover's width — Tailwind's `w-72`, kept in sync by hand. */
const POPOVER_WIDTH_PX = 288;

export type PickerWallet = {
  id: string;
  name: string;
  currency_code: string;
  kind: "card" | "bank";
  color_slot: number;
};

/**
 * The two groups the list is split into, in display order. "Wallets" is
 * the card kind and "Accounts" the bank kind — the requester's own
 * vocabulary for the two — and each group carries a fixed colour that is
 * NOT any wallet's own slot colour, so the group rule and a member's icon
 * never read as the same thing. Amber for wallets, blue for accounts,
 * both already in the palette so they follow the theme.
 */
const GROUPS: { kind: PickerWallet["kind"]; heading: string; color: string; Icon: typeof Landmark }[] = [
  { kind: "card", heading: "Wallets", color: "var(--cat-2)", Icon: CreditCard },
  { kind: "bank", heading: "Accounts", color: "var(--cat-15)", Icon: Landmark },
];

/**
 * Picks a wallet for the transaction form: a closed chip showing the
 * current choice, opening into a searchable list grouped under Wallets
 * and Accounts. Replaces the native `<select>` the form used before,
 * which cannot be searched and cannot carry group colour.
 *
 * Same list-of-`aria-pressed`-buttons shape as CategoryPicker, so the two
 * pickers on the form behave alike. Nothing here is submitted: the form
 * carries `wallet_id` in a hidden input bound to its own state, and this
 * component only reports a chosen id through `onChange`.
 */
export function WalletPicker({
  label,
  wallets,
  value,
  onChange,
  exclude,
}: {
  /** "Wallet", "From" or "To" — the visible caption, and the first half of
   *  the chip's accessible name ("Wallet Everyday"). */
  label: string;
  wallets: PickerWallet[];
  value: string;
  onChange: (id: string) => void;
  /** A wallet to leave out — the transfer's other leg. */
  exclude?: string;
}) {
  const [open, setOpen] = useState(false);
  // Anchor the popover to the chip's RIGHT edge when hanging it from the
  // left would run past the viewport — the "To" chip on a transfer sits
  // in the right half of a phone screen, and a left-anchored list there
  // overflowed and scrolled the whole page sideways. Decided at open time
  // from a measurement, in the click handler rather than an effect.
  const [alignRight, setAlignRight] = useState(false);
  const [query, setQuery] = useState("");
  const chipRef = useRef<HTMLButtonElement>(null);
  const labelId = useId();
  const chipId = useId();
  const searchId = useId();
  const listId = useId();

  const selected = wallets.find((w) => w.id === value);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return wallets.filter(
      (w) =>
        w.id !== exclude &&
        (!q || w.name.toLowerCase().includes(q) || w.currency_code.toLowerCase().includes(q)),
    );
  }, [wallets, exclude, query]);

  function choose(id: string) {
    onChange(id);
    setQuery("");
    setOpen(false);
  }

  function close() {
    setQuery("");
    setOpen(false);
    chipRef.current?.focus();
  }

  // A pointer-down anywhere outside the picker closes it — the list is a
  // popover, and a popover that only closes on Escape or on a choice
  // would sit over the keypad until one of those happened.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setQuery("");
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <div className="flex items-center gap-1 text-sm">
        <span id={labelId} style={{ color: "var(--ink-2)" }}>
          {label}
        </span>
        <button
          ref={chipRef}
          id={chipId}
          type="button"
          aria-labelledby={`${labelId} ${chipId}`}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={() => {
            if (open) {
              close();
              return;
            }
            const rect = rootRef.current?.getBoundingClientRect();
            setAlignRight(rect !== undefined && rect.left + POPOVER_WIDTH_PX > window.innerWidth - 16);
            setOpen(true);
          }}
          className={`flex items-center gap-1 rounded-full border px-3 py-1 text-sm ${FOCUS_RING}`}
          style={{ borderColor: "var(--ink-2)", color: "var(--ink)", background: "var(--surface)" }}
        >
          {selected && (
            <WalletGlyph wallet={selected} />
          )}
          <span>{selected?.name ?? "Choose a wallet"}</span>
          <ChevronDown aria-hidden size={14} />
        </button>
      </div>

      {open && (
        // A popover under the chip, not an inline block: the chip sits in
        // a row with the category and date chips, and growing that row's
        // cell squeezed the list to the cell's width and reflowed the
        // form. `max-w` keeps it inside a phone's viewport; the form's
        // side padding is what the 2rem allows for.
        <div
          id={listId}
          className={`absolute top-full z-20 mt-1 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-md border p-2 shadow-lg ${alignRight ? "right-0" : "left-0"}`}
          style={{ borderColor: "var(--grid)", background: "var(--surface)" }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
        >
          <label htmlFor={searchId} className="sr-only">
            Search wallets
          </label>
          <input
            id={searchId}
            type="search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search wallets"
            autoComplete="off"
            className={`rounded-md border px-3 py-2 text-sm ${FOCUS_RING}`}
            style={{ borderColor: "var(--ink-2)", background: "var(--surface)", color: "var(--ink)" }}
          />
          {visible.length === 0 && (
            <p className="px-2 py-1 text-sm" style={{ color: "var(--ink-2)" }}>
              No wallets match.
            </p>
          )}
          {GROUPS.map((group) => {
            const members = visible.filter((w) => w.kind === group.kind);
            if (members.length === 0) return null;
            const headingId = `${listId}-${group.kind}`;
            return (
              // The group's colour is carried by the heading text AND a
              // left rule, never by colour alone: the heading names the
              // group in words, and the icon shape (card vs building)
              // repeats the distinction on every row.
              <section
                key={group.kind}
                className="pl-2"
                style={{ borderLeft: `3px solid ${group.color}` }}
              >
                <h3
                  id={headingId}
                  className="px-2 pb-1 text-xs font-medium uppercase tracking-wide"
                  style={{ color: group.color }}
                >
                  {group.heading}
                </h3>
                <ul aria-labelledby={headingId} className="flex flex-col">
                  {members.map((w) => (
                    <li key={w.id}>
                      <button
                        type="button"
                        onClick={() => choose(w.id)}
                        aria-pressed={w.id === value}
                        className={`flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm ${w.id === value ? "font-medium" : ""} ${FOCUS_RING}`}
                        style={{
                          // Same selection treatment as CategoryPicker's
                          // rows, for the contrast reasons documented
                          // there: constant background, a var(--cat-1)
                          // left border plus weight for the selected row.
                          background: "transparent",
                          color: "var(--ink)",
                          borderLeft: `3px solid ${w.id === value ? "var(--cat-1)" : "transparent"}`,
                        }}
                      >
                        <WalletGlyph wallet={w} />
                        <span className="flex-1">{w.name}</span>
                        {/* A real space, so the accessible name reads
                            "OCBC360 SGD" rather than the two run together;
                            a flex container drops the whitespace node
                            visually, so layout is unaffected. */}{" "}
                        <span className="text-xs" style={{ color: "var(--ink-2)" }}>
                          {w.currency_code}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The wallet's kind as a shape, in the wallet's own slot colour. */
function WalletGlyph({ wallet }: { wallet: PickerWallet }) {
  const Icon = wallet.kind === "card" ? CreditCard : Landmark;
  return <Icon aria-hidden size={16} className="shrink-0" style={{ color: slotVar(wallet.color_slot) }} />;
}
