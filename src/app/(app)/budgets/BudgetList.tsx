"use client";

import { useId, useState, useTransition, useActionState } from "react";
import { setBudget, removeBudget, type BudgetState } from "@/server/actions/budgets";
import { formatMoney } from "@/lib/money";
import { budgetProgress, scopeLabel, type BudgetStatusRow } from "@/lib/budget-status";
import { MONTH_ABBREV } from "@/lib/month-names";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

/**
 * `Aug` for a budget set in the current calendar year, `Aug 2025` for one set
 * in an earlier year — `currentPeriodStart` (this month's own "YYYY-MM-01")
 * is what "current year" means here, not the viewer's clock. Ported
 * byte-for-byte from the previous single-wallet screen (commit d8968fe) —
 * fix round C1 restored this after it was dropped in the initial wallet-set
 * rewrite, on the mistaken belief that carry-forward "doesn't map onto
 * wallet sets". It does: `eff` (0013_wallet_set_budgets.sql) still carries
 * forward the most recent row at or before the queried month, now keyed on
 * (wallet set, category) instead of (wallet, category) — that changes WHICH
 * row is carried, never whether hard-deleting it (removeBudget has no
 * soft-delete and no undo) retroactively un-budgets every earlier month it
 * was still in force for. Still pure string slicing, never `new Date(...)`,
 * for the same timezone reason month-range.ts's own doc comment gives.
 */
function monthAbbrev(periodStart: string, currentPeriodStart: string): string {
  const month = Number(periodStart.slice(5, 7));
  const abbrev = MONTH_ABBREV[month - 1] ?? periodStart;
  const year = periodStart.slice(0, 4);
  const currentYear = currentPeriodStart.slice(0, 4);
  return year === currentYear ? abbrev : `${abbrev} ${year}`;
}

/** Stand-in for the category half of the pinned heading format
 * (`<category label> · <scope label>`) on the overall-cap row, whose own
 * `category_label` is NULL (controller addendum §1). Matches the language
 * of the pinned "Remove overall budget" control rather than reusing
 * "All spending" (the OLD single-wallet screen's wording) — "wallets" is
 * the vocabulary this whole redesign uses for a wallet set, and mixing in a
 * different noun for the same concept would read as two different features. */
const OVERALL_LABEL = "Overall budget";

export type BudgetWallet = { id: string; name: string; currency_code: string; space_id: string };
export type BudgetCategoryOption = { id: string; label: string };

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
  // Sorted too, now that B2's own e2e fixture proves two overall caps (over
  // DIFFERENT wallet sets) are a real, on-screen case, not a one-of-one
  // corner. `category_label` is null for every overall-cap row (it has no
  // category), so the field `categoryBudgets`/`uncovered` sort by below is
  // useless here — sorted by each row's own joined wallet names instead,
  // the only per-row text that actually differs between two overall caps.
  // Same underlying reason as the other two: `get_budget_status` has no
  // ORDER BY, so leaving this unsorted renders in whatever order Postgres
  // heap scan happens to return.
  const overall = rows
    .filter((r) => r.budget_id !== null && r.category_id === null)
    .sort((a, b) => (a.wallet_names ?? []).join(", ").localeCompare((b.wallet_names ?? []).join(", ")));
  const categoryBudgets = rows
    .filter((r) => r.budget_id !== null && r.category_id !== null)
    .sort((a, b) => (a.category_label ?? "").localeCompare(b.category_label ?? ""));
  // Sorted for the same reason `categoryBudgets` is above: `get_budget_status`
  // has no ORDER BY, so an unsorted `uncovered` renders in Postgres heap
  // order — the exact thing this function's own doc comment says it exists
  // to prevent, and a Minor fix-round finding caught it being skipped here.
  const uncovered = rows
    .filter((r) => r.budget_id === null)
    .sort((a, b) => (a.category_label ?? "").localeCompare(b.category_label ?? ""));
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
  /** Every ACTIVE wallet the caller belongs to, across every currency — not
   *  just the primary one. This is now the ONLY source `scopeLabel`'s
   *  per-row wallet count is derived from (see `walletCountByCurrency`
   *  below) — a single flat `totalInCurrency` number was a fix-round I3
   *  finding: it counted only PRIMARY-currency wallets, but a budget row can
   *  legitimately carry a DIFFERENT currency (a shared wallet whose set
   *  spans another member's own currency), and comparing that row's
   *  `wallet_count` against the wrong currency's total produced a false
   *  "All wallets" for a set that did not actually cover everyone. Indexing
   *  by `row.currency_code` instead removes that whole class of mismatch.
   *  Also backs the new-budget picker's options (filtered to
   *  `primaryCurrency`) and each existing row's "doesn't cover ..."
   *  disclosure. */
  wallets = [],
  /** The household's primary currency (`profile.base_currency`). Which of
   *  `wallets` the new-budget picker offers and defaults to, and which
   *  currency counts as "this budget's own currency" for the per-row
   *  disclosure. */
  primaryCurrency,
  /** The household's expense categories available to budget against —
   *  not only categories with spending this
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
   *  supabase/migrations), so two wallets sharing a name would resolve to
   *  the wrong id silently. A real id, fetched once in page.tsx, has no such
   *  failure mode. Name-based matching is still used for the cosmetic
   *  "doesn't cover ..." disclosure below, where a wrong guess is only ever
   *  a wrong sentence, never a wrong wallet on a save.
   *
   *  Also the source of `walletCountMismatch` below: `budget_wallets` (this
   *  map's source) has no archived-wallet filter, while `get_budget_status`'s
   *  own `wallet_count` counts only ACTIVE wallets (its `scope` CTE inner-
   *  joins `mine`). The two disagree exactly when a budget's set includes a
   *  since-archived wallet — a fix-round I5 finding. */
  walletIdsByBudget = {},
  /** This month's own `period_start` (`monthRange().from`) — page.tsx
   *  computes it once and passes the same string down, rather than this
   *  component calling `monthRange()` itself a second time and risking it
   *  disagreeing with the value the page already queried `get_budget_status`
   *  with. Optional: this file's own component tests never pass it, and
   *  with no reference to compare against there is nothing honest to
   *  disclose, so every row renders as if it were the current month's own —
   *  never a FALSE "set in the past" claim, only a possibly missing true
   *  one. Restored in fix round C1 after being dropped: see `monthAbbrev`'s
   *  own doc comment for why dropping it was a real regression, not a
   *  simplification. */
  currentPeriodStart,
}: {
  rows: BudgetStatusRow[];
  wallets?: BudgetWallet[];
  primaryCurrency?: string;
  categories?: BudgetCategoryOption[];
  walletIdsByBudget?: Record<string, string[]>;
  currentPeriodStart?: string;
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

  // Active wallet count PER CURRENCY, not just the primary one — see this
  // prop's own doc comment above (fix round I3) for why a single flat
  // number was wrong.
  const walletCountByCurrency = new Map<string, number>();
  for (const w of wallets) {
    walletCountByCurrency.set(w.currency_code, (walletCountByCurrency.get(w.currency_code) ?? 0) + 1);
  }

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
          totalInCurrency={walletCountByCurrency.get(row.currency_code) ?? 0}
          primaryWallets={primaryWallets}
          walletIds={walletIdsByBudget[row.budget_id!] ?? []}
          currentPeriodStart={currentPeriodStart}
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
          Wallets in {otherCurrencyCodes.join(", ")} aren&rsquo;t covered by any budget here.
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
  currentPeriodStart,
}: {
  row: BudgetStatusRow;
  totalInCurrency: number;
  primaryWallets: BudgetWallet[];
  walletIds: string[];
  currentPeriodStart?: string;
}) {
  const isOverall = row.category_id === null;
  const categoryLabel = row.category_label ?? OVERALL_LABEL;
  const scope = scopeLabel(row.wallet_names, row.wallet_count, totalInCurrency);
  const progress = budgetProgress(row);
  const headingId = useId();
  const amountStatusId = useId();

  const [formState, formAction, saving] = useActionState<BudgetState, FormData>(
    setBudget.bind(null, row.category_id),
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

  // N2 (whole-branch review): scoped with `· ${scope}`, same as the two
  // live regions below (`Error for ${categoryLabel} · ${scope}`, `Status
  // for ${categoryLabel} · ${scope}`) — a category can carry two budgets at
  // once, over different wallet sets (e.g. "Groceries · All wallets" and
  // "Groceries · Savings"), and this button is a DESTRUCTIVE, undoable
  // control (`removeBudget` hard-deletes, no soft-delete, no undo). Before
  // this fix both rows' Remove buttons shared the exact same accessible
  // name, indistinguishable to a screen-reader user with more than one open
  // — this branch's own e2e suite hits this collision directly (see
  // budgetRow's doc comment in e2e/budgets.spec.ts).
  //
  // The overall cap gets the SAME treatment, not just the category branch:
  // a caller can carry more than one overall cap at once (a different
  // wallet set each, category_id still null for both) — B2's own e2e fix
  // puts exactly such a pair on screen together — and their Remove buttons
  // were just as indistinguishable to a screen-reader user as the category
  // case above before this fix.
  const removeLabel = isOverall
    ? `Remove overall budget · ${scope}`
    : `Remove budget for ${categoryLabel} · ${scope}`;

  // Fix round C1: a budget set in an EARLIER month and never touched since
  // is still that earlier month's own row (carry-forward: "the effective
  // budget for a month is the most recent row at or before it", now keyed on
  // wallet SET + category). Clicking Remove here hard-deletes that row,
  // retroactively un-budgeting every month it was carried forward into —
  // with no undo (`removeBudget` is a plain `delete from budgets`). The
  // `aria-label` above stays the pinned, byte-identical string either way;
  // only the VISIBLE button text gains the qualifier, so a sighted user sees
  // it without changing what a screen-reader user is told the control is
  // named. See `monthAbbrev`'s own doc comment for the full history —
  // dropped in the initial wallet-set rewrite on a mistaken "doesn't map
  // onto sets" premise, restored here.
  const isPastBudget =
    row.budget_period_start !== null &&
    currentPeriodStart !== undefined &&
    row.budget_period_start !== currentPeriodStart;
  const removeButtonText = removing
    ? "Removing…"
    : isPastBudget
      ? `Remove (set ${monthAbbrev(row.budget_period_start!, currentPeriodStart!)})`
      : "Remove";

  // Names present in `primaryWallets` (this budget's own currency, since the
  // picker never offers any other) that this row's own `wallet_names` does
  // NOT list. Cosmetic only — see `walletIdsByBudget`'s doc comment above
  // for why a wrong guess here is acceptable where it would not be for
  // resubmission.
  const covered = new Set(row.wallet_names ?? []);
  const uncoveredNames = primaryWallets
    .filter((w) => w.currency_code === row.currency_code && !covered.has(w.name))
    .map((w) => w.name);

  // Fix round I5: `walletIds` (this row's REAL wallet ids, via a direct
  // `budget_wallets` read — see `walletIdsByBudget`'s doc comment on
  // `BudgetList`) carries every wallet in the set, archived or not.
  // `row.wallet_count` (from `get_budget_status`'s `scope` CTE, which inner-
  // joins `mine` — active wallets only) does not. The two disagree exactly
  // when this budget's set includes a since-archived wallet, and resubmitting
  // that full set through `set_budget` would hit its own archived-wallet
  // refusal, surfacing only the generic "Could not save that budget." Caught
  // and disclosed here instead, with Save disabled, rather than left to fail
  // opaquely.
  const walletCountMismatch = row.wallet_count !== null && walletIds.length !== row.wallet_count;

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
          {removeButtonText}
        </button>
      </div>

      {uncoveredNames.length > 0 && (
        <p className="text-xs" style={{ color: "var(--ink-2)" }}>
          Doesn&rsquo;t cover {uncoveredNames.join(", ")}.
        </p>
      )}

      {walletCountMismatch && (
        <p className="text-xs" style={{ color: "var(--neg)" }}>
          Covers an archived wallet, so its amount can&rsquo;t be edited here.
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
          reliably announced. Per-row aria-label, derived from `categoryLabel`
          AND `scope` (fix round I2 — `categoryLabel` alone collides for two
          budgets over the SAME category with different scopes, which this
          file's own test suite renders and asserts distinct rows for): this
          page renders one of these per row, so an ambiguously-named
          role="alert" would make every such pair's live regions
          indistinguishable, both to getByRole("alert") and to a screen-reader
          user with more than one open. */}
      <p role="alert" aria-label={`Error for ${categoryLabel} · ${scope}`} className="text-sm" style={{ color: "var(--neg)" }}>
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
          disabled={saving || walletCountMismatch}
          className={`shrink-0 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-60 ${FOCUS_RING}`}
          style={{ background: "var(--cat-1)", color: "var(--surface)" }}
        >
          {saving ? "Saving…" : "Save budget"}
        </button>
      </form>
      {/* role="status", not role="alert": this row already has ONE
          always-mounted role="alert" above (the Remove error) — a second
          simultaneous role="alert" node makes getByRole("alert") ambiguous.
          Per-row aria-label, `categoryLabel` + `scope` for the same
          same-category-different-scope collision reason the alert above has
          (fix round I2). Doubles as the save NOTICE on success so a save is
          announced rather than silent.

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
        aria-label={`Status for ${categoryLabel} · ${scope}`}
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
            // `uncovered` (0023_budget_category_id.sql) groups by category
            // id AND currency — the same category can have uncovered
            // spending in two different currencies at once, which a
            // category-only key would collide on (fix round Minor).
            key={`${row.category_id ?? row.category_label ?? "uncategorised"}-${row.currency_code}`}
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
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const amountStatusId = useId();
  const headingId = useId(); // fix round Minor: was a hardcoded id; every other heading in this file uses useId().

  // Controlled wallet selection (Task 5, controller addendum): seeded with
  // every primaryWallets id, preserving today's all-checked default exactly.
  // A `defaultChecked` uncontrolled input can't support a select-all toggle,
  // which must both SET every box and KNOW whether all are currently
  // checked to choose its own label.
  const [selectedWalletIds, setSelectedWalletIds] = useState<Set<string>>(
    () => new Set(primaryWallets.map((w) => w.id)),
  );
  const allWalletsSelected =
    primaryWallets.length > 0 && primaryWallets.every((w) => selectedWalletIds.has(w.id));

  const [formState, formAction, saving] = useActionState<BudgetState, FormData>(
    setBudget.bind(null, categoryId),
    {},
  );

  return (
    <section aria-labelledby={headingId}>
      <h2
        id={headingId}
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
            value={categoryId ?? ""}
            onChange={(e) => setCategoryId(e.target.value === "" ? null : e.target.value)}
            className={`rounded-md border px-3 py-2 text-sm ${FOCUS_RING}`}
            style={{ borderColor: "var(--ink-2)", background: "var(--surface)", color: "var(--ink)" }}
          >
            <option value="">{OVERALL_LABEL} (all spending)</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="relative">
          <legend className="text-xs" style={{ color: "var(--ink-2)" }}>
            Wallets this budget covers
          </legend>
          {/* Absolutely positioned against the fieldset rather than a sibling
              of the legend in normal flow: `legend` must stay the fieldset's
              only direct-child legend for its accessible name to resolve
              (browsers only look at direct children per the HTML-AAM
              fieldset/legend algorithm), which rules out wrapping legend and
              button together in a flex row. Rendered only when there is
              something to select — an empty `primaryWallets` would make
              `.every()` vacuously true and mislabel this "Clear all" against
              nothing (controller addendum). */}
          {primaryWallets.length > 0 && (
            <button
              type="button"
              onClick={() =>
                setSelectedWalletIds(
                  allWalletsSelected ? new Set() : new Set(primaryWallets.map((w) => w.id)),
                )
              }
              className={`absolute right-0 top-0 text-xs underline ${FOCUS_RING}`}
              style={{ color: "var(--cat-1)" }}
            >
              {allWalletsSelected ? "Clear all" : "Select all"}
            </button>
          )}
          <div className="mt-1 flex flex-col gap-1">
            {primaryWallets.map((w) => (
              <label key={w.id} className="flex items-center gap-2 text-sm" style={{ color: "var(--ink)" }}>
                {/* Defaults to every primary-currency wallet checked — the
                    picker's own default (controller addendum §4) — and a
                    caller can uncheck down to a subset. Submitting zero is
                    refused server-side (budgetInput's `.min(1)`), so no
                    client-side guard is duplicated here. Controlled (not
                    `defaultChecked`) so the Select all / Clear all toggle
                    above can both set every box and know whether all are
                    checked. */}
                <input
                  type="checkbox"
                  name="walletIds"
                  value={w.id}
                  checked={selectedWalletIds.has(w.id)}
                  onChange={(e) =>
                    setSelectedWalletIds((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) {
                        next.add(w.id);
                      } else {
                        next.delete(w.id);
                      }
                      return next;
                    })
                  }
                />
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
