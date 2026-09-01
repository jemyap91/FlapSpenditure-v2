"use client";

import { useState, useTransition } from "react";
import { Pause, Settings } from "lucide-react";
import { archiveRule, type RecurringState } from "@/server/actions/recurring";
import { formatMoney, formatAmountInput, minorUnitFor } from "@/lib/money";
import { slotVar } from "@/lib/palette";
import { CATEGORY_ICON_COMPONENTS } from "@/lib/category-icons";
import type { CategoryIcon } from "@/lib/validation/category";
import type { RecurInterval } from "@/lib/recurrence";
import { Modal } from "@/components/Modal";
import type { Category } from "@/components/CategoryPicker";
import { RecurringForm } from "./RecurringForm";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

/** One row of `recurring_rules`, already joined with the wallet/category
 *  names page.tsx needs a Server Component read to resolve — this
 *  component never queries. Snake_case throughout, matching every other
 *  row type in this codebase (WalletList's `WalletWithBalance`,
 *  TransactionList's `Row`) rather than re-casing to camelCase for its own
 *  sake. */
export type RecurringRuleRow = {
  id: string;
  wallet_id: string;
  wallet_name: string;
  name: string;
  kind: "expense" | "income";
  amount_minor: number;
  currency_code: string;
  category_id: string;
  category_name: string | null;
  category_icon: string | null;
  color_slot: number | null;
  interval_unit: RecurInterval;
  anchor_on: string;
  ends_on: string | null;
};

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** Reads a `YYYY-MM-DD` string's digits directly — never through
 *  `new Date(...)`. src/lib/month-range.ts documents a shipped Critical
 *  bug from mixing a local `Date` with a UTC read (or vice versa); the
 *  fields here come straight off the string itself, so there is no
 *  direction of conversion left to mismatch. */
function parseIso(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}

/**
 * "1 Jul" or "1 Jul 2026" — exported (fix round 1, I2) so `DueList.tsx` can
 * consolidate on this ONE date formatter rather than keep a second,
 * differently-abbreviated one of its own (`DueList`'s previous "1 July" vs
 * this file's "1 Jul") purely because both files needed "a short date".
 */
export function shortDate(iso: string, withYear: boolean): string {
  const { y, m, d } = parseIso(iso);
  return withYear ? `${d} ${MONTH_ABBR[m - 1]} ${y}` : `${d} ${MONTH_ABBR[m - 1]}`;
}

/**
 * Turns a rule's schedule into words, never codes — the whole point of this
 * screen (spec 2026-09-01-recurring-entries-design) is that a user reads
 * "monthly on the 1st", not `interval_unit: "monthly", anchor_on:
 * "2026-09-01"`. Exported and pure — no rendering — so it can be unit
 * tested on its own (see this file's own test suite), per the brief's own
 * instruction not to bury this logic inside JSX where only a full render
 * could exercise it.
 *
 * The anchor date is shown WITHOUT a year ("monthly on the 1st", "every 2
 * weeks from 3 Sep") — a schedule is read repeatedly, long after the year
 * it started in stops being the interesting fact about it. `ends_on`, by
 * contrast, is usually still in the future when read, so its year is
 * exactly the fact worth stating ("until 1 Jan 2027").
 */
export function describeSchedule(rule: {
  interval_unit: RecurInterval;
  anchor_on: string;
  ends_on: string | null;
}): string {
  const { d } = parseIso(rule.anchor_on);
  let base: string;
  switch (rule.interval_unit) {
    case "weekly":
      base = `every week from ${shortDate(rule.anchor_on, false)}`;
      break;
    case "fortnightly":
      base = `every 2 weeks from ${shortDate(rule.anchor_on, false)}`;
      break;
    case "monthly":
      base = `monthly on the ${ordinal(d)}`;
      break;
    case "yearly":
      base = `yearly on ${shortDate(rule.anchor_on, false)}`;
      break;
  }
  return rule.ends_on ? `${base} — until ${shortDate(rule.ends_on, true)}` : base;
}

/**
 * The list half of /recurring: every active rule, in words, with per-row
 * Edit and Pause — the same Server Component (page.tsx) + Client Component
 * split, and the same per-row-action-named-after-its-row reasoning,
 * WalletList.tsx already established (its own doc comment: several rows
 * render the same verb and are otherwise indistinguishable by accessible
 * name).
 *
 * Unlike WalletList's Archive, Pause has no ownership gate: `recurring_
 * rules` carries no per-user ownership column at all (only `wallet_id`,
 * shared by every member, and a nullable `created_by`) — 0015's own
 * `recurring_rules_member` policy is `for all using (is_wallet_member(...))
 * with check (is_wallet_member(...))`, deliberately member-writable like
 * `categories_member`/`transactions_member`/`budgets_member` ("Members are
 * equal on ledger content; owner-only is reserved for membership and for
 * archiving a WALLET" — 0015's own comment). So every rule this component
 * is handed is one any viewer may edit or pause; there is no per-row
 * capability to withhold.
 *
 * `wallets`/`categories`/`editActions` are all optional, unlike WalletList's
 * required `wallets`: they exist only to feed the Edit dialog's
 * `RecurringForm`, and a caller that only wants the read-only list (this
 * file's own tests) has no need to supply them — Edit simply doesn't render
 * for a rule with no bound action.
 *
 * Pause goes through a confirmation dialog, unlike a plain click-to-archive:
 * there is no "resume" action in this task (`src/server/actions/
 * recurring.ts` has no such export), so pausing is, in the UI's own terms,
 * one-way — the same irreversible-from-here shape WalletList's Archive
 * confirms before acting on, for the identical reason.
 */
export function RecurringList({
  rules,
  wallets = [],
  categories = [],
  editActions,
}: {
  rules: RecurringRuleRow[];
  wallets?: { id: string; name: string; currency_code: string }[];
  categories?: Category[];
  editActions?: Record<string, (prev: RecurringState, formData: FormData) => Promise<RecurringState>>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, start] = useTransition();
  /** Which rule's dialog is open, and which view — a single value, not a
   *  per-rule map, matching WalletList's identical reasoning: only one
   *  dialog can ever be open, and a map would let two "open" at once with
   *  only z-order deciding which the user could reach. */
  const [dialog, setDialog] = useState<{ ruleId: string; view: "edit" | "pause" } | null>(null);

  const dialogRule = dialog ? rules.find((r) => r.id === dialog.ruleId) : undefined;

  function requestPause(rule: RecurringRuleRow) {
    setError(null);
    setDialog({ ruleId: rule.id, view: "pause" });
  }

  function pause(id: string) {
    setError(null);
    setPendingId(id);
    start(async () => {
      // `archiveRule` RETURNS its error rather than throwing — same
      // reasoning as WalletList's `archive`: a thrown message reaches the
      // browser as an opaque digest in production.
      const res = await archiveRule(id);
      if (res.error) setError(res.error);
      setPendingId(null);
    });
  }

  if (!rules.length) {
    return (
      <p className="py-8 text-sm" style={{ color: "var(--ink-2)" }}>
        Nothing recurring yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Always mounted, not conditionally rendered — see WalletList.tsx's
          identical paragraph for why a role="alert" that appears and gets
          its text in the same instant is not reliably announced. */}
      <p role="alert" className="text-sm" style={{ color: "var(--neg)" }}>
        {error}
      </p>

      <ul className="flex flex-col">
        {rules.map((rule) => {
          const Icon = rule.category_icon
            ? (CATEGORY_ICON_COMPONENTS[rule.category_icon as CategoryIcon] ?? CATEGORY_ICON_COMPONENTS.circle)
            : CATEGORY_ICON_COMPONENTS.circle;
          // The confirmation dialog closes as soon as Pause is confirmed,
          // so without this the row would sit unchanged while the request
          // is in flight — same reasoning as WalletList's `archiving`.
          const pausing = pendingId === rule.id;
          return (
            <li
              key={rule.id}
              aria-label={rule.name}
              className="mb-2 flex items-center gap-2 rounded-lg border px-3 py-2 transition-opacity"
              style={{ borderColor: "var(--grid)", opacity: pausing ? 0.5 : 1 }}
              aria-busy={pausing || undefined}
            >
              {/* Colour is never the only cue (spec §6.1/§6.3) — the icon
                  shape and the name beside it are what actually identify
                  the row, matching WalletList's identical reasoning. */}
              <Icon
                aria-hidden
                size={18}
                style={{ color: rule.color_slot !== null ? slotVar(rule.color_slot) : "var(--ink-2)" }}
                className="shrink-0"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate" style={{ color: "var(--ink)" }}>
                  {rule.name}
                </span>
                {/* Fix round 1 (task-5-fix-1, Minor): `category_name` was
                    fetched and plumbed all the way down to this row without
                    ever being rendered — a user could not tell which
                    category a rule posts to without opening Edit. This is
                    the natural place for it: the same subtitle line
                    `describeSchedule`/`wallet_name` already occupy, joined
                    with the same separator, and only present when there is
                    something to say (`.filter(Boolean)` drops a missing
                    category or wallet name rather than leaving a stray
                    " · " where they'd have been). */}
                <span className="block text-xs" style={{ color: "var(--ink-2)" }}>
                  {[rule.category_name, describeSchedule(rule), rule.wallet_name || null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span
                className="shrink-0 tabular-nums"
                style={{ color: rule.kind === "expense" ? "var(--neg)" : "var(--ink)" }}
              >
                {formatMoney(rule.amount_minor, rule.currency_code, { signed: true })}
              </span>

              {/* Icon buttons, named after the rule, not the verb —
                  WalletList's identical Edit control documents why: several
                  rows render the same verb and are otherwise
                  indistinguishable by accessible name. */}
              {editActions?.[rule.id] && (
                <button
                  type="button"
                  aria-label={`Edit ${rule.name}`}
                  onClick={() => setDialog({ ruleId: rule.id, view: "edit" })}
                  className={`grid h-11 w-11 shrink-0 place-items-center rounded-md ${FOCUS_RING}`}
                  style={{ color: "var(--ink-2)" }}
                >
                  <Settings size={18} aria-hidden />
                </button>
              )}

              <button
                type="button"
                aria-label={`Pause ${rule.name}`}
                onClick={() => requestPause(rule)}
                className={`grid h-11 w-11 shrink-0 place-items-center rounded-md ${FOCUS_RING}`}
                style={{ color: "var(--ink-2)" }}
              >
                <Pause size={18} aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>

      {/* ONE dialog for the whole list — WalletList's identical reasoning:
          rendering a Modal per row would mount a focus trap and a keydown
          handler per rule when only one can ever be open. */}
      {dialogRule && (
        <Modal
          open
          title={dialog!.view === "edit" ? `Edit ${dialogRule.name}` : `Pause ${dialogRule.name}?`}
          onClose={() => setDialog(null)}
        >
          {dialog!.view === "pause" ? (
            <div className="flex flex-col gap-4">
              <p className="text-sm" style={{ color: "var(--ink)" }}>
                {dialogRule.name} will stop appearing here, and no further occurrences will be
                generated.{" "}
                <strong style={{ color: "var(--ink)" }}>Its recorded transactions are kept</strong> and stay
                in your reports. There is no way to resume a paused rule yet.
              </p>
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
                  disabled={pendingId === dialogRule.id}
                  onClick={() => {
                    const id = dialogRule.id;
                    setDialog(null);
                    pause(id);
                  }}
                  className={`rounded-md px-4 py-2 text-sm font-medium disabled:opacity-60 ${FOCUS_RING}`}
                  style={{ background: "var(--neg)", color: "var(--surface)" }}
                >
                  Pause
                </button>
              </div>
            </div>
          ) : dialog!.view === "edit" && editActions?.[dialogRule.id] ? (
            <>
              <RecurringForm
                action={editActions[dialogRule.id]!}
                submitLabel="Save changes"
                pendingLabel="Saving…"
                wallets={wallets}
                categories={categories}
                defaultWalletId={dialogRule.wallet_id}
                defaults={{
                  wallet_id: dialogRule.wallet_id,
                  name: dialogRule.name,
                  kind: dialogRule.kind,
                  amount: formatAmountInput(
                    Math.abs(dialogRule.amount_minor),
                    minorUnitFor(dialogRule.currency_code),
                  ),
                  category_id: dialogRule.category_id,
                  interval_unit: dialogRule.interval_unit,
                  anchor_on: dialogRule.anchor_on,
                  ends_on: dialogRule.ends_on ?? "",
                }}
                lockWallet
                onSuccess={() => setDialog(null)}
              />
              {/* Pause's keyboard/desktop route from inside the edit
                  dialog too — WalletList's identical bottom-of-dialog
                  Archive link, for the identical reason: both paths open
                  the same confirmation. */}
              <div className="mt-4 border-t pt-4" style={{ borderColor: "var(--grid)" }}>
                <button
                  type="button"
                  onClick={() => requestPause(dialogRule)}
                  className={`rounded-sm text-sm underline ${FOCUS_RING}`}
                  style={{ color: "var(--neg)" }}
                >
                  Pause this rule
                </button>
              </div>
            </>
          ) : null}
        </Modal>
      )}
    </div>
  );
}
