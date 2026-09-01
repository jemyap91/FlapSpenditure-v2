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
    expect(rows[0]!.blockedReason).toMatch(/category/i);
    expect(rows[0]!.blockedReason).toMatch(/archived/i);
  });

  it("marks a rule whose category kind no longer matches the rule's kind as blocked", () => {
    const input = {
      rules: [rule({ kind: "expense", categoryKind: "income" })],
      skips: [],
      recorded: [],
    };
    const { rows } = buildDueRows(input, "2026-09-01");
    expect(rows[0]!.blockedReason).toMatch(/category/i);
  });

  it("marks a paused rule as blocked", () => {
    // A rule can be paused AFTER an occurrence became due but before it was
    // recorded or skipped — the occurrence must not silently vanish.
    const input = {
      rules: [rule({ archivedAt: "2026-08-20T00:00:00Z" })],
      skips: [],
      recorded: [],
    };
    const { rows } = buildDueRows(input, "2026-09-01");
    expect(rows[0]!.blockedReason).toMatch(/paused/i);
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
});
