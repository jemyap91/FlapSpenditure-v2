"use client";

import { useId, useState, useTransition, useActionState } from "react";
import { setBudget, removeBudget, type BudgetState } from "@/server/actions/budgets";
import { formatMoney } from "@/lib/money";
import { budgetProgress, scopeLabel, type BudgetStatusRow } from "@/lib/budget-status";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

/** Stand-in for the category half of the pinned heading format
 * (`<category label> · <scope label>`) on the overall-cap row, whose own
 * `category_label` is NULL (controller addendum §1). Matches the language
 * of the pinned "Remove overall budget" control rather than reusing
 * "All spending" (the OLD single-wallet screen's wording) — "accounts" is
 * the vocabulary this whole redesign uses for a wallet set, and mixing in a
 * different noun for the same concept would read as two different features. */
const OVERALL_LABEL = "Overall budget";

export type BudgetWallet = { id: string; name: string; currency_code: string };
export type BudgetCategoryOption = { key: string; label: string };

/**
 * Rows split into the three groups spec §5 (as carried into this task's
 * brief) orders the screen by: the wallet set's overall cap(s) first, then
 * each budgeted category alphabetically by its label, then every category
 * with spending no visible budget covers. `get_budget_status` has no
 * `ORDER BY` (0013's own comment on the predecessor of this function), so
 * relying on whatever order Postgres hands back is heap order — this
 * enforces the order in TypeScript rather than leaving it to chance.
 */
function groupRows(rows: readonly BudgetStatusRow[]): {
  overall: BudgetStatusRow[];
  categoryBudgets: BudgetStatusRow[];
  uncovered: BudgetStatusRow[];
} {
  const overall = rows.filter((r) => r.budget_id !== null && r.category_key === null);
  const categoryBudgets = rows
    .filter((r) => r.budget_id !== null && r.category_key !== null)
    .sort((a, b) => (a.category_label ?? "").localeCompare(b.category_label ?? ""));
  const uncovered = rows.filter((r) => r.budget_id === null);
  return { overall, categoryBudgets, uncovered };
}

/**
 * The /budgets screen's interactive body. A Client Component (page.tsx does
 * the Server Component data-fetching and hands everything below down),
 * matching the split CategorySection.tsx and MembersSection.tsx both use.
 *
 * Grouped by BUDGET, not by wallet (the previous branch's model) — a budget
 * now covers a SET of wallets, so "one section per wallet" no longer
 * expresses the data. See `groupRows` for the order and `BudgetRow` for one
 * budget's own rendering.
 */
export function BudgetList({
  rows,
  /** Count of the caller's ACTIVE wallets in the primary currency —
   *  `scopeLabel` needs this to decide whether a wallet set truly covers
   *  every wallet in its currency ("All accounts") or merely used to.
   *  page.tsx computes this from a real wallets read; it must never be
   *  derived from `rows`, which describes only BUDGETED wallets (controller
   *  addendum §3). Defaults to 0 so a caller supplying only `rows` (as most
   *  of this file's own tests do) still renders every other scope branch
   *  correctly — 0 can only ever equal a real wallet count when the row's
   *  own `wallet_count` is also falsy, which `scopeLabel` already treats as
   *  "no scope" before comparing counts at all. */
  totalInCurrency = 0,
  /** Every ACTIVE wallet the caller belongs to, across every currency — not
   *  just the primary one. Used for two purposes, both cosmetic text, never
   *  for resubmission (see `walletIdsByBudget` below for why that needs a
   *  different, id-accurate source): the new-budget picker's options
   *  (filtered to `primaryCurrency`), and each existing row's "doesn't cover
   *  ..." disclosure. */
  wallets = [],
  /** The household's primary currency (`profile.base_currency`). Which of
   *  `wallets` the new-budget picker offers and defaults to, and which
   *  currency counts as "this budget's own currency" for the per-row
   *  disclosure. */
  primaryCurrency,
  /** Distinct expense category names available to budget against, across
   *  the primary-currency wallets — not only categories with spending this
   *  month, which would leave a wallet with no spending yet offering no
   *  control at all (controller addendum §4). */
  categories = [],
  /** budget_id -> the exact wallet ids that budget covers, resolved by
   *  page.tsx from a direct `budget_wallets` read (RLS already scopes it to
   *  the caller's own membership, same as every other read in this app).
   *
   *  This exists because `get_budget_status`'s own row carries
   *  `wallet_names` — display strings — and never wallet ids (controller
   *  addendum §1's row shape has no such column at all). `set_budget`'s
   *  read-modify-write match is keyed on the wallet id SET, not on names
   *  (0013_wallet_set_budgets.sql's `v_key`, built from `unnest(p_wallet_ids)`)
   *  — resubmitting an existing row's amount without its OWN wallet ids
   *  would either fail validation (empty set) or, worse, silently create a
   *  SECOND budget over whatever set happened to be resubmitted instead of
   *  updating the one being edited. Matching wallet_names back to ids by
   *  NAME was considered and rejected: wallet names have no uniqueness
   *  constraint (checked: no `unique` index on `wallets.name` anywhere in
   *  supabase/migrations), so two accounts sharing a name would resolve to
   *  the wrong id silently. A real id, fetched once in page.tsx, has no such
   *  failure mode. Name-based matching is still used for the cosmetic
   *  "doesn't cover ..." disclosure below, where a wrong guess is only ever
   *  a wrong sentence, never a wrong wallet on a save. */
  walletIdsByBudget = {},
}: {
  rows: BudgetStatusRow[];
  totalInCurrency?: number;
  wallets?: BudgetWallet[];
  primaryCurrency?: string;
  categories?: BudgetCategoryOption[];
  walletIdsByBudget?: Record<string, string[]>;
}) {
  const { overall, categoryBudgets, uncovered } = groupRows(rows);
  const primaryWallets = primaryCurrency
    ? wallets.filter((w) => w.currency_code === primaryCurrency)
    : wallets;
  const otherCurrencyCodes = Array.from(
    new Set(
      wallets
        .filter((w) => primaryCurrency !== undefined && w.currency_code !== primaryCurrency)
        .map((w) => w.currency_code),
    ),
  );

  const hasAnyRows = overall.length + categoryBudgets.length + uncovered.length > 0;

  return (
    <div className="flex flex-col gap-8">
      {!hasAnyRows && (
        <p className="text-sm" style={{ color: "var(--ink-2)" }}>
          No spending or budgets recorded this month.
        </p>
      )}

      {[...overall, ...categoryBudgets].map((row) => (
        <BudgetRow
          key={row.budget_id!}
          row={row}
          totalInCurrency={totalInCurrency}
          primaryWallets={primaryWallets}
          walletIds={walletIdsByBudget[row.budget_id!] ?? []}
        />
      ))}

      {uncovered.length > 0 && <UncoveredSection rows={uncovered} />}

      {/* Currency-wide, not per-row: a budget's own currency is fixed by
          its wallet set, so a wallet in a DIFFERENT currency can never be
          "not covered by this budget" in the per-row sense above — it is
          excluded from EVERY budget this screen can create, since the
          picker below only ever offers `primaryCurrency` wallets. Stated
          once, in text, rather than silently omitted (controller addendum
          §3's "say so in text" applied to the currency axis, not just the
          wallet-within-currency axis the per-row disclosure covers). */}
      {otherCurrencyCodes.length > 0 && (
        <p className="text-sm" style={{ color: "var(--ink-2)" }}>
          Accounts in {otherCurrencyCodes.join(", ")} aren&rsquo;t covered by any budget here.
        </p>
      )}

      <AddBudgetForm primaryWallets={primaryWallets} categories={categories} />
    </div>
  );
}

function BudgetRow({
  row,
  totalInCurrency,
  primaryWallets,
  walletIds,
}: {
  row: BudgetStatusRow;
  totalInCurrency: number;
  primaryWallets: BudgetWallet[];
  walletIds: string[];
}) {
  const isOverall = row.category_key === null;
  const categoryLabel = row.category_label ?? OVERALL_LABEL;
  const scope = scopeLabel(row.wallet_names, row.wallet_count, totalInCurrency);
  const progress = budgetProgress(row);
  const headingId = useId();
  const amountStatusId = useId();

  const [formState, formAction, saving] = useActionState<BudgetState, FormData>(
    setBudget.bind(null, row.category_key),
    {},
  );

  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removing, startRemoving] = useTransition();

  function handleRemove() {
    if (!row.budget_id) return;
    setRemoveError(null);
    startRemoving(async () => {
      const res = await removeBudget(row.budget_id!);
      if (res.error) setRemoveError(res.error);
    });
  }

  const removeLabel = isOverall ? "Remove overall budget" : `Remove budget for ${categoryLabel}`;

  // Names present in `primaryWallets` (this budget's own currency, since the
  // picker never offers any other) that this row's own `wallet_names` does
  // NOT list. Cosmetic only — see `walletIdsByBudget`'s doc comment above
  // for why a wrong guess here is acceptable where it would not be for
  // resubmission.
  const covered = new Set(row.wallet_names ?? []);
  const uncoveredNames = primaryWallets
    .filter((w) => w.currency_code === row.currency_code && !covered.has(w.name))
    .map((w) => w.name);

  // A budget row (as opposed to an uncovered-spending row) always carries a
  // non-null `budget_minor` per the controller addendum's own row-shape
  // contract — this guards that invariant rather than rendering a
  // budget-shaped row with "No budget set", which UncoveredSection already
  // owns.
  if (progress.budgetMinor === null) return null;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2 rounded-lg border p-3" style={{ borderColor: "var(--grid)", background: "var(--surface)" }}>
      <div className="flex items-center justify-between gap-2">
        <h2 id={headingId} className="font-medium" style={{ color: "var(--ink)" }}>
          {categoryLabel} · {scope}
        </h2>
        <button
          type="button"
          aria-label={removeLabel}
          disabled={removing}
          onClick={handleRemove}
          className={`shrink-0 text-xs underline disabled:opacity-60 ${FOCUS_RING}`}
          style={{ color: "var(--ink-2)" }}
        >
          {removing ? "Removing…" : "Remove"}
        </button>
      </div>

      {uncoveredNames.length > 0 && (
        <p className="text-xs" style={{ color: "var(--ink-2)" }}>
          Doesn&rsquo;t cover {uncoveredNames.join(", ")}.
        </p>
      )}

      <p className="text-sm" style={{ color: "var(--ink-2)" }}>
        {formatMoney(progress.spentMinor, row.currency_code)} of{" "}
        {formatMoney(progress.budgetMinor, row.currency_code)} · {progress.percent}%
      </p>
      {/* aria-hidden: the paragraph above (and, when over budget, the
          "Over by" paragraph below) already carries every bit of meaning
          this bar draws — a colour/length-only cue is exactly what the
          controller addendum's accessibility rules forbid as the ONLY way
          to perceive a state. */}
      <div aria-hidden className="h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--grid)" }}>
        <div
          style={{
            width: `${Math.min(progress.percent ?? 0, 100)}%`,
            minWidth: "2px",
            height: "100%",
            background: progress.isOver ? "var(--neg)" : "var(--cat-1)",
          }}
        />
      </div>
      {progress.isOver && (
        <p className="text-sm font-medium" style={{ color: "var(--neg)" }}>
          Over by {formatMoney(progress.spentMinor - progress.budgetMinor, row.currency_code)}
        </p>
      )}

      {/* Always mounted, not conditionally rendered — a role="alert" node
          that appears and gets its text in the same instant is not
          reliably announced. Per-row aria-label (derived from
          `categoryLabel`): this page renders one of these per row, so an
          unlabelled role="alert" would make every row's live region
          indistinguishable from every other's, both to getByRole("alert")
          and to a screen-reader user with more than one open. */}
      <p role="alert" aria-label={`Error for ${categoryLabel}`} className="text-sm" style={{ color: "var(--neg)" }}>
        {removeError}
      </p>

      <form action={formAction} className="flex items-end gap-2">
        {/* This row's OWN wallet set, resubmitted unchanged — never the
            picker's current selection, which belongs only to the
            new-budget form below. See `walletIdsByBudget`'s doc comment on
            `BudgetList` for why this must be the real ids, not names. */}
        {walletIds.map((id) => (
          <input key={id} type="hidden" name="walletIds" value={id} />
        ))}
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            Budget amount
          </span>
          <input
            type="text"
            inputMode="decimal"
            name="amount"
            autoComplete="off"
            placeholder="0.00"
            aria-describedby={formState.error ? amountStatusId : undefined}
            className={`rounded-md border px-3 py-2 text-sm ${FOCUS_RING}`}
            style={{ borderColor: "var(--ink-2)", background: "var(--surface)", color: "var(--ink)" }}
          />
        </label>
        <button
          type="submit"
          disabled={saving}
          className={`shrink-0 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-60 ${FOCUS_RING}`}
          style={{ background: "var(--cat-1)", color: "var(--surface)" }}
        >
          {saving ? "Saving…" : "Save budget"}
        </button>
      </form>
      {/* role="status", not role="alert": this row already has ONE
          always-mounted role="alert" above (the Remove error) — a second
          simultaneous role="alert" node makes getByRole("alert") ambiguous.
          Per-row aria-label for the same reason the alert above has one.
          Doubles as the save NOTICE on success so a save is announced
          rather than silent.

          The MESSAGE TEXT lives in a child <span id={amountStatusId}>, not
          on this <p> itself: an accessible DESCRIPTION is computed by
          running the text-alternative algorithm on the referenced node, and
          aria-label wins over name-from-content there — so the amount
          input's aria-describedby pointing at THIS <p> (if it carried both
          the id AND an aria-label) would resolve to "Status for Groceries",
          never the actual error text. Splitting the two jobs onto two
          nodes — the label for per-row disambiguation on the outer <p>, the
          describable text on an unlabelled inner <span> — means neither can
          spoil the other. */}
      <p
        role="status"
        aria-label={`Status for ${categoryLabel}`}
        className="text-sm"
        style={{ color: formState.error ? "var(--neg)" : "var(--ink-2)" }}
      >
        <span id={amountStatusId}>{formState.error ?? formState.notice}</span>
      </p>
    </section>
  );
}

/**
 * Every category with spending no visible budget covers, grouped under one
 * shared heading rather than one h2 per category — the pinned "per-budget
 * heading" format (`<category label> · <scope label>`) belongs to actual
 * BUDGET rows (controller addendum §5's own naming: "per-BUDGET heading").
 * An uncovered row has no scope at all (`scopeLabel` returns "" for a null
 * wallet set), so forcing it through that same format would render a
 * heading ending in a bare " · " for every single one.
 */
function UncoveredSection({ rows }: { rows: BudgetStatusRow[] }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="mb-3 text-lg font-semibold" style={{ color: "var(--ink)" }}>
        Uncovered spending
      </h2>
      <ul className="flex flex-col gap-3">
        {rows.map((row) => (
          <li
            key={row.category_key ?? row.category_label ?? "uncategorised"}
            className="flex flex-col gap-1 rounded-lg border p-3"
            style={{ borderColor: "var(--grid)", background: "var(--surface)" }}
          >
            <span className="font-medium" style={{ color: "var(--ink)" }}>
              {row.category_label}
            </span>
            <p className="text-sm" style={{ color: "var(--ink-2)" }}>
              {formatMoney(row.spent_minor, row.currency_code)} spent · No budget set
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Creates a NEW budget: an overall cap or a category budget, over a chosen
 * wallet set. The only place a Category picker or a wallet PICKER (as
 * opposed to an existing row's hidden, unpicked wallet set) appears on this
 * screen — matches the controller addendum's pinned naming, "Category
 * picker (NEW budget)".
 */
function AddBudgetForm({
  primaryWallets,
  categories,
}: {
  primaryWallets: BudgetWallet[];
  categories: BudgetCategoryOption[];
}) {
  // `null` for the overall cap — an explicit choice, never `""`. The select
  // itself uses value="" for that option (HTML <option> values are always
  // strings), translated back to `null` right here at the one point it
  // matters, so nothing downstream ever sees the empty string the SQL
  // layer explicitly refuses (controller addendum §4).
  const [categoryKey, setCategoryKey] = useState<string | null>(null);
  const amountStatusId = useId();

  const [formState, formAction, saving] = useActionState<BudgetState, FormData>(
    setBudget.bind(null, categoryKey),
    {},
  );

  return (
    <section aria-labelledby="add-budget-heading">
      <h2
        id="add-budget-heading"
        className="mb-3 text-sm font-medium uppercase tracking-wide"
        style={{ color: "var(--ink-2)" }}
      >
        Add a budget
      </h2>
      <form
        action={formAction}
        className="flex flex-col gap-3 rounded-lg border p-3"
        style={{ borderColor: "var(--grid)", background: "var(--surface)" }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            Category
          </span>
          <select
            value={categoryKey ?? ""}
            onChange={(e) => setCategoryKey(e.target.value === "" ? null : e.target.value)}
            className={`rounded-md border px-3 py-2 text-sm ${FOCUS_RING}`}
            style={{ borderColor: "var(--ink-2)", background: "var(--surface)", color: "var(--ink)" }}
          >
            <option value="">{OVERALL_LABEL} (all spending)</option>
            {categories.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <fieldset>
          <legend className="text-xs" style={{ color: "var(--ink-2)" }}>
            Accounts this budget covers
          </legend>
          <div className="mt-1 flex flex-col gap-1">
            {primaryWallets.map((w) => (
              <label key={w.id} className="flex items-center gap-2 text-sm" style={{ color: "var(--ink)" }}>
                {/* Defaults to every primary-currency account checked — the
                    picker's own default (controller addendum §4) — and a
                    caller can uncheck down to a subset. Submitting zero is
                    refused server-side (budgetInput's `.min(1)`), so no
                    client-side guard is duplicated here. */}
                <input type="checkbox" name="walletIds" value={w.id} defaultChecked />
                {w.name}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="flex flex-col gap-1">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            Budget amount
          </span>
          <input
            type="text"
            inputMode="decimal"
            name="amount"
            autoComplete="off"
            placeholder="0.00"
            aria-describedby={formState.error ? amountStatusId : undefined}
            className={`rounded-md border px-3 py-2 text-sm ${FOCUS_RING}`}
            style={{ borderColor: "var(--ink-2)", background: "var(--surface)", color: "var(--ink)" }}
          />
        </label>

        <button
          type="submit"
          disabled={saving}
          className={`w-fit rounded-md px-3 py-2 text-sm font-medium disabled:opacity-60 ${FOCUS_RING}`}
          style={{ background: "var(--cat-1)", color: "var(--surface)" }}
        >
          {saving ? "Saving…" : "Save budget"}
        </button>

        <p
          role="status"
          aria-label="Status for new budget"
          className="text-sm"
          style={{ color: formState.error ? "var(--neg)" : "var(--ink-2)" }}
        >
          <span id={amountStatusId}>{formState.error ?? formState.notice}</span>
        </p>
      </form>
    </section>
  );
}
