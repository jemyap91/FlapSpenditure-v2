import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PeopleTotals, totalsByPerson } from "./PeopleTotals";
import { peopleFor, SHARED } from "@/lib/people";

const people = peopleFor([
  { user_id: "u-c", display_name: "Cheryl" },
  { user_id: "u-j", display_name: "Jeremy" },
]);
const cheryl = people.get("u-c")!;
const jeremy = people.get("u-j")!;

const wallet = (id: string, over: Partial<{ kind: string; currency_code: string; balanceMinor: number | null }> = {}) => ({
  id,
  kind: "bank",
  currency_code: "SGD",
  balanceMinor: 100000,
  ...over,
});

describe("totalsByPerson", () => {
  it("sums each person's bank accounts in the currency, Shared last", () => {
    const totals = totalsByPerson(
      [
        wallet("shared", { balanceMinor: 824015 }),
        wallet("c1", { balanceMinor: 1430260 }),
        wallet("c2", { balanceMinor: 311892 }),
        wallet("j1", { balanceMinor: 2241000 }),
      ],
      { shared: SHARED, c1: cheryl, c2: cheryl, j1: jeremy },
      "SGD",
    );
    expect(totals.map((t) => [t.person.name, t.totalMinor, t.accounts])).toEqual([
      ["Cheryl", 1742152, 2],
      ["Jeremy", 2241000, 1],
      ["Shared", 824015, 1],
    ]);
  });

  it("leaves out cards, other currencies and balances not computed", () => {
    const totals = totalsByPerson(
      [
        wallet("c1"),
        wallet("card", { kind: "card", balanceMinor: -50000 }),
        wallet("usd", { currency_code: "USD" }),
        wallet("unknown", { balanceMinor: null }),
      ],
      { c1: cheryl, card: cheryl, usd: cheryl, unknown: cheryl },
      "SGD",
    );
    expect(totals).toEqual([{ person: cheryl, totalMinor: 100000, accounts: 1 }]);
  });
});

describe("PeopleTotals", () => {
  it("shows a tile per person with a compact total", () => {
    render(
      <PeopleTotals
        currency="SGD"
        minorUnit={2}
        totals={[
          { person: cheryl, totalMinor: 1940000, accounts: 4 },
          { person: jeremy, totalMinor: 2240000, accounts: 2 },
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: "Balances by person, SGD accounts" });
    expect(list).toHaveTextContent("Cheryl");
    expect(list).toHaveTextContent("SGD 19.4K");
    expect(list).toHaveTextContent("across 4 accounts");
  });

  it("is hidden for a household of one", () => {
    const { container } = render(
      <PeopleTotals currency="SGD" minorUnit={2} totals={[{ person: cheryl, totalMinor: 1, accounts: 1 }]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
