import { describe, expect, it } from "vitest";
import { buildDueRows, type DueRuleInput, type HandledOccurrence } from "./due-rows";

/**
 * A fully valid, fully due rule: monthly, anchored so it has exactly one
 * occurrence outstanding on the fixture `today` ("2026-09-01") unless a
 * test overrides `anchorOn`/`intervalUnit` to produce more. Every "blocked"
 * field starts in its non-blocking state so each blocked-reason test only
 * has to override the ONE field it's about — same one-defect-at-a-time
 * fixture shape RecurringList.test.tsx's own `rule()` factory uses.
 */
function rule(overrides: Partial<DueRuleInput> = {}): DueRuleInput {
  return {
    id: "rule-1",
    name: "Rent",
    kind: "expense",
    amountMinor: -150000,
    currencyCode: "SGD",
    anchorOn: "2026-09-01",
    intervalUnit: "monthly",
    endsOn: null,
    archivedAt: null,
    walletName: "Everyday",
    walletCurrencyCode: "SGD",
    walletArchivedAt: null,
    categoryKind: "expense",
    categoryArchivedAt: null,
    ...overrides,
  };
}

const handled = (ruleId: string, occurrenceOn: string): HandledOccurrence => ({ ruleId, occurrenceOn });

describe("buildDueRows", () => {
  it("returns one row per due occurrence, oldest first", () => {
    // Oldest first: the backlog reads as a queue to work through, and the
    // oldest is the one most at risk of being forgotten.
    const input = {
      rules: [rule({ anchorOn: "2026-01-01" })],
      skips: [],
      recorded: [
        handled("rule-1", "2026-01-01"),
        handled("rule-1", "2026-02-01"),
        handled("rule-1", "2026-03-01"),
        handled("rule-1", "2026-04-01"),
        handled("rule-1", "2026-05-01"),
        handled("rule-1", "2026-06-01"),
      ],
    };
    const { rows } = buildDueRows(input, "2026-09-01");
    expect(rows.map((r) => r.occurrenceOn)).toEqual(["2026-07-01", "2026-08-01", "2026-09-01"]);
  });

  it("sorts rows from different rules together by date, not grouped by rule", () => {
    const ruleA = rule({ id: "a", name: "Rent", anchorOn: "2026-09-01" });
    const ruleB = rule({ id: "b", name: "Gym", anchorOn: "2026-07-15" });
    const input = { rules: [ruleA, ruleB], skips: [], recorded: [] };
    const { rows } = buildDueRows(input, "2026-09-01");
    expect(rows.map((r) => [r.ruleId, r.occurrenceOn])).toEqual([
      ["b", "2026-07-15"],
      ["b", "2026-08-15"],
      ["a", "2026-09-01"],
    ]);
  });

  it("omits occurrences already recorded or skipped", () => {
    const input = {
      rules: [rule({ anchorOn: "2026-07-01" })],
      skips: [handled("rule-1", "2026-08-01")],
      recorded: [handled("rule-1", "2026-07-01")],
    };
    const { rows } = buildDueRows(input, "2026-09-01");
    expect(rows.map((r) => r.occurrenceOn)).toEqual(["2026-09-01"]);
  });

  it("marks a rule whose wallet is archived as blocked, rather than hiding it", () => {
    // Hiding it would leave the user wondering where their rule went;
    // recordOccurrence would refuse anyway, so the reason is stated up front.
    const input = {
      rules: [rule({ walletArchivedAt: "2026-08-15T00:00:00Z" })],
      skips: [],
      recorded: [],
    };
    const { rows } = buildDueRows(input, "2026-09-01");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.blockedReason).toMatch(/archived/i);
  });

  it("marks a rule whose currency no longer matches its wallet's as blocked", () => {
    const input = {
      rules: [rule({ currencyCode: "USD", walletCurrencyCode: "SGD" })],
      skips: [],
      recorded: [],
    };
    const { rows } = buildDueRows(input, "2026-09-01");
    expect(rows[0]!.blockedReason).toMatch(/currency/i);
  });

  it("marks a rule whose category has been archived as blocked", () => {
    const input = {
      rules: [rule({ categoryArchivedAt: "2026-08-01T00:00:00Z" })],
      skips: [],
      recorded: [],
    };
    const { rows } = buildDueRows(input, "2026-09-01");
    // The exact wording, not just `/category/i` — that pattern also matches
    // the KIND-MISMATCH message below, so a mutation that swapped the two
    // (telling a user to un-archive a category that isn't archived) would
    // have passed silently under the looser assertion (fix round 2, small).
    expect(rows[0]!.blockedReason).toBe("This rule's category has been archived.");
  });

  it("marks a rule whose category kind no longer matches the rule's kind as blocked", () => {
    const input = {
      rules: [rule({ kind: "expense", categoryKind: "income" })],
      skips: [],
      recorded: [],
    };
    const { rows } = buildDueRows(input, "2026-09-01");
    // Exact wording (see the archived-category test's identical note): this
    // message must be distinguishable from "has been archived" specifically
    // because both would satisfy a bare `/category/i` match.
    expect(rows[0]!.blockedReason).toBe("This rule's category doesn't match this rule's type.");
  });

  it("marks a paused rule as blocked", () => {
    // A rule can be paused AFTER an occurrence became due but before it was
    // recorded or skipped — the occurrence must not silently vanish. The
    // rule's anchor (1 Aug) is BEFORE the pause (20 Aug), so that one
    // occurrence is still generated (fix round 2, I1: `dueOccurrences` now
    // stops MINTING new ones after the pause, but a pre-pause occurrence is
    // unaffected) and must render blocked, not hidden.
    const input = {
      rules: [rule({ anchorOn: "2026-08-01", archivedAt: "2026-08-20T00:00:00Z" })],
      skips: [],
      recorded: [],
    };
    const { rows } = buildDueRows(input, "2026-09-01");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrenceOn).toBe("2026-08-01");
    expect(rows[0]!.blockedReason).toMatch(/paused/i);
  });

  /**
   * Fix round 2, I1 — the live defect the whole-branch review proved:
   * before `archivedAt` was wired into `dueOccurrences`, pausing a rule
   * mid-schedule did not stop it minting a NEW occurrence every period
   * after the pause, each rendered as a permanently-blocked row nobody
   * could ever clear (spec §6: there is no un-archive action). Anchored 1
   * January, paused 15 February, read on 5 June: only 1 January and 1
   * February (the one due before the pause) may appear — 1 March through 1
   * June must not.
   */
  it("stops generating new rows for a rule after it was paused, rather than minting one every period forever", () => {
    const input = {
      rules: [rule({ anchorOn: "2026-01-01", archivedAt: "2026-02-15T00:00:00Z" })],
      skips: [],
      recorded: [],
    };
    const { rows } = buildDueRows(input, "2026-06-05");
    expect(rows.map((r) => r.occurrenceOn)).toEqual(["2026-01-01", "2026-02-01"]);
  });

  it("leaves blockedReason null for a fully valid, unblocked rule", () => {
    const input = { rules: [rule()], skips: [], recorded: [] };
    const { rows } = buildDueRows(input, "2026-09-01");
    expect(rows[0]!.blockedReason).toBeNull();
  });

  it("carries the rule's amount, currency and wallet name onto each row", () => {
    const input = {
      rules: [rule({ amountMinor: -150000, currencyCode: "SGD", walletName: "Everyday", name: "Rent" })],
      skips: [],
      recorded: [],
    };
    const { rows } = buildDueRows(input, "2026-09-01");
    expect(rows[0]).toMatchObject({
      ruleId: "rule-1",
      ruleName: "Rent",
      amountMinor: -150000,
      currencyCode: "SGD",
      walletName: "Everyday",
    });
  });

  it("reports when the backstop withheld older occurrences", () => {
    const input = {
      rules: [rule({ anchorOn: "2000-01-03", intervalUnit: "weekly" })],
      skips: [],
      recorded: [],
    };
    const { olderDropped } = buildDueRows(input, "2026-09-01");
    expect(olderDropped).toBe(true);
  });

  it("does not report the backstop when nothing was withheld", () => {
    const input = { rules: [rule()], skips: [], recorded: [] };
    const { olderDropped } = buildDueRows(input, "2026-09-01");
    expect(olderDropped).toBe(false);
  });

  it("returns no rows and no drop when there are no rules at all", () => {
    const { rows, olderDropped } = buildDueRows({ rules: [], skips: [], recorded: [] }, "2026-09-01");
    expect(rows).toEqual([]);
    expect(olderDropped).toBe(false);
  });

  it("keeps a different rule's identical-date occurrence due when only one rule's is recorded (fix round 1, I6)", () => {
    // Rent and Salary, both on the 1st, is the commonest possible pairing of
    // two rules sharing a due date. The handled set MUST be scoped per rule
    // id: keying it by a shared/constant key instead — recording Rent's 1
    // September would then also mark Salary's 1 September handled — is a
    // mutation every other test in this file passes under, because every
    // other test uses either one rule, or two rules with empty skips/
    // recorded. This is the one test that actually discriminates: it fails
    // under that mutation and passes under the correct per-rule keying.
    const rent = rule({ id: "rent", name: "Rent", kind: "expense", categoryKind: "expense", anchorOn: "2026-09-01" });
    const salary = rule({
      id: "salary",
      name: "Salary",
      kind: "income",
      categoryKind: "income",
      anchorOn: "2026-09-01",
    });
    const input = {
      rules: [rent, salary],
      skips: [],
      // Only Rent's 1 September occurrence is recorded.
      recorded: [handled("rent", "2026-09-01")],
    };
    const { rows } = buildDueRows(input, "2026-09-01");
    // Salary's identical-date occurrence must still be due.
    expect(rows.map((r) => [r.ruleId, r.occurrenceOn])).toEqual([["salary", "2026-09-01"]]);
  });

  /**
   * Task 7, Step 2 (unit half) — spec §1.2, the reason
   * `recurring_occurrence_on` exists as a column at all.
   *
   * A recorded occurrence carries TWO dates: `recurring_occurrence_on`
   * (which occurrence it satisfies — 1 September's rent) and `occurred_on`
   * (when the money actually moved — the 3rd, after the user corrected it).
   * The handled set must be keyed on the first. Keyed on the second, a
   * date correction un-records the occurrence: 1 September comes back as
   * due and the app asks the user to pay rent they already paid.
   *
   * Both halves are asserted deliberately, because the first alone would
   * be vacuous — `buildDueRows` is handed an already-mapped
   * `HandledOccurrence[]` and cannot see either column name, so the ONLY
   * thing that makes the first assertion mean anything is the second one
   * proving the two dates produce genuinely different answers. The choice
   * between them is made in `page.tsx`'s `.select(...)`/map (covered, with
   * a real mutation, by `page.test.tsx`'s "still treats an occurrence as
   * handled after its actual paid date is edited away" test); what is
   * proven HERE is that the choice is load-bearing rather than cosmetic.
   */
  it("treats an occurrence handled by its SCHEDULED date as handled, and would re-offer it if keyed on the ACTUAL date", () => {
    // The recorded transaction, as it sits in the database after the user
    // corrected the paid date from the 1st to the 3rd.
    const recordedTransaction = {
      recurring_id: "rule-1",
      recurring_occurrence_on: "2026-09-01", // its identity — never edited
      occurred_on: "2026-09-03", // the actual date money moved — edited
    };
    const rules = [rule({ anchorOn: "2026-09-01" })];

    // Keyed on the scheduled date, the way page.tsx keys it: nothing is due.
    const handledCorrectly = buildDueRows(
      {
        rules,
        skips: [],
        recorded: [handled(recordedTransaction.recurring_id, recordedTransaction.recurring_occurrence_on)],
      },
      "2026-09-01",
    );
    expect(handledCorrectly.rows).toEqual([]);

    // Keyed on the actual date instead — the pre-0016 behaviour — 1
    // September is offered for recording a second time. This is the
    // counterfactual that makes the assertion above discriminate at all.
    const handledByActualDate = buildDueRows(
      { rules, skips: [], recorded: [handled(recordedTransaction.recurring_id, recordedTransaction.occurred_on)] },
      "2026-09-01",
    );
    expect(handledByActualDate.rows.map((r) => r.occurrenceOn)).toEqual(["2026-09-01"]);
  });
});
