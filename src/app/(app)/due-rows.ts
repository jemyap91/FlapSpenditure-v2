import { dueOccurrences, type RecurInterval } from "@/lib/recurrence";

/**
 * One recurring rule plus every fact `buildDueRows` needs to (a) compute
 * its due occurrences and (b) decide whether recording one would actually
 * succeed — without querying anything itself. This is the model for
 * `due-rows.ts` `wallet-rows.ts` already is: extracted into its own module
 * specifically so it is unit-testable without a Supabase stack (see that
 * file's own doc comment).
 *
 * camelCase, unlike every OTHER row type in this codebase (`WalletRow`,
 * `RecurringRuleRow` are snake_case, matching their source columns
 * directly). Deliberate here: this type is also the shape `RecurrenceRule`
 * expects (`src/lib/recurrence.ts`: `anchorOn`/`intervalUnit`/`endsOn`,
 * already camelCase — the database columns are snake_case, and page.tsx
 * maps at that boundary, per this task's brief), and re-casing only THIS
 * type back to snake_case would buy nothing while still needing a second
 * mapping step to call `dueOccurrences` at all.
 */
export type DueRuleInput = {
  id: string;
  name: string;
  /** The rule's own kind — "expense" | "income" (`recurring_rules.kind` is
   *  DB-typed as the full transfer-inclusive enum, but 0015's own
   *  `rule_kind_not_transfer` CHECK guarantees this value is never
   *  "transfer" — same fact `src/server/actions/recurring.ts`'s
   *  `recordOccurrence` re-establishes via `nonTransferKind`). Compared
   *  against `categoryKind` below to catch a category whose kind has
   *  drifted since the rule was created or last edited. */
  kind: "expense" | "income";
  /** Signed, matching `recurring_rules.amount_minor` and every other
   *  amount this codebase carries through a row type (`RecurringRuleRow`'s
   *  identical field) — negative for an expense, positive for income. */
  amountMinor: number;
  currencyCode: string;
  anchorOn: string;
  intervalUnit: RecurInterval;
  endsOn: string | null;
  /** The rule's own `archived_at` — a paused rule (spec §5's "pause"), not
   *  a deleted one. `recordOccurrence` refuses a paused rule outright
   *  ("This rule has been paused."); a due occurrence that became due
   *  before the pause must still be SHOWN, with that reason, rather than
   *  silently vanishing the moment the rule is paused. */
  archivedAt: string | null;
  walletId: string;
  walletName: string;
  walletCurrencyCode: string;
  walletArchivedAt: string | null;
  categoryKind: "expense" | "income";
  categoryArchivedAt: string | null;
};

/** One `(rule_id, occurrence_on)` pair that is already handled — either a
 *  `recurring_skips` row or a recorded (non-deleted) transaction's
 *  `(recurring_id, occurred_on)`. The two sources are handed over
 *  separately (see `buildDueRows`'s `input` parameter) because page.tsx
 *  reads them from two different tables, but they mean the same thing
 *  here: "do not offer this occurrence again." */
export type HandledOccurrence = { ruleId: string; occurrenceOn: string };

/** One due occurrence, ready to render. */
export type DueRow = {
  ruleId: string;
  ruleName: string;
  occurrenceOn: string;
  amountMinor: number;
  currencyCode: string;
  walletName: string;
  /** Null when Record/Skip would both succeed as far as this function can
   *  tell. Non-null states the reason `recordOccurrence` would refuse this
   *  occurrence — see `blockedReasonFor` — so `DueList` can render that
   *  reason INSTEAD of a Record button that is guaranteed to fail on
   *  press, rather than duplicating `recordOccurrence`'s own re-validation
   *  here (this function has no database access and cannot check anything
   *  `recordOccurrence` doesn't already own: schema drift between build
   *  time and record time is out of scope for both). */
  blockedReason: string | null;
};

/**
 * Same four checks `recordOccurrence` re-validates server-side (see that
 * function's own doc comment in src/server/actions/recurring.ts, and the
 * task-6 brief's own summary of them) — re-derived here from data
 * `buildDueRows` was already handed, not by calling that function, so a
 * blocked row can state ITS reason before Record is ever pressed. Checked
 * in the same order `recordOccurrence` itself checks them (paused rule,
 * then wallet, then currency, then category), so a rule blocked for more
 * than one reason at once is never given a Record button, but the exact
 * wording here does not need to match `recordOccurrence`'s error strings
 * verbatim — those are what a FAILED submit reports; this is what stops
 * the submit from being offered at all.
 */
function blockedReasonFor(rule: DueRuleInput): string | null {
  if (rule.archivedAt) return "This rule has been paused.";
  if (rule.walletArchivedAt) return "This wallet has been archived.";
  if (rule.walletCurrencyCode !== rule.currencyCode) {
    return `This rule's currency (${rule.currencyCode}) doesn't match the wallet's currency (${rule.walletCurrencyCode}).`;
  }
  if (rule.categoryArchivedAt) return "This rule's category has been archived.";
  if (rule.categoryKind !== rule.kind) return "This rule's category doesn't match this rule's type.";
  return null;
}

/**
 * Rules + skips + already-recorded `(rule, date)` pairs + `today` in,
 * `DueRow[]` out. Pure and database-free, per this task's brief, for the
 * same reason `wallet-rows.ts`'s `mergeWalletBalances` is: page.tsx does
 * every read, this does every decision, and the seam between them is a
 * plain object rather than a Supabase client.
 *
 * `skips` and `recorded` are merged into one "handled" set PER RULE before
 * `dueOccurrences` ever runs, matching that function's own doc comment
 * ("Due = generated minus handled... so Record and Skip work in any
 * order"): a rule's own occurrences never need to know which of the two
 * tables produced a given date, only that it is spoken for.
 *
 * Rows from every rule are merged into ONE list and sorted by date, not
 * grouped by rule — a queue to work through reads oldest-first regardless
 * of which rule an item belongs to; the OLDEST overall is the one most at
 * risk of being forgotten, not the oldest within whichever rule happens to
 * be listed first. `Array.prototype.sort` is stable (ECMA-262 since
 * ES2019), so two rows sharing a date keep the order their rules were
 * given in rather than swapping unpredictably.
 *
 * `olderDropped` is true if it is true for ANY rule: this function has no
 * per-rule surface to report it on (see `DueRow`, which carries no such
 * field), and the SAME silent-truncation risk `occurrencesFor`'s own doc
 * comment describes applies here — a caller checking only the aggregate
 * flag must not be told "you're caught up" while one rule's older backlog
 * was actually withheld.
 */
export function buildDueRows(
  input: {
    rules: readonly DueRuleInput[];
    skips: readonly HandledOccurrence[];
    recorded: readonly HandledOccurrence[];
  },
  today: string,
): { rows: DueRow[]; olderDropped: boolean } {
  const handledByRule = new Map<string, Set<string>>();
  for (const h of [...input.skips, ...input.recorded]) {
    const set = handledByRule.get(h.ruleId) ?? new Set<string>();
    set.add(h.occurrenceOn);
    handledByRule.set(h.ruleId, set);
  }

  const rows: DueRow[] = [];
  let olderDropped = false;

  for (const rule of input.rules) {
    const handled = handledByRule.get(rule.id) ?? new Set<string>();
    const occurrences = dueOccurrences(
      { anchorOn: rule.anchorOn, intervalUnit: rule.intervalUnit, endsOn: rule.endsOn },
      today,
      handled,
    );
    if (occurrences.olderDropped) olderDropped = true;

    const blockedReason = blockedReasonFor(rule);
    for (const occurrenceOn of occurrences.dates) {
      rows.push({
        ruleId: rule.id,
        ruleName: rule.name,
        occurrenceOn,
        amountMinor: rule.amountMinor,
        currencyCode: rule.currencyCode,
        walletName: rule.walletName,
        blockedReason,
      });
    }
  }

  rows.sort((a, b) => (a.occurrenceOn < b.occurrenceOn ? -1 : a.occurrenceOn > b.occurrenceOn ? 1 : 0));

  return { rows, olderDropped };
}
