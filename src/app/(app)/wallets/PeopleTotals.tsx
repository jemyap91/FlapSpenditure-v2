import { PersonBadge } from "@/components/PersonBadge";
import type { Person } from "@/lib/people";

export type PersonTotal = { person: Person; totalMinor: number; accounts: number };

/** "SGD 19.4K": the tiles only need the size of the number. */
function compactMoney(minor: number, currency: string, minorUnit: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(minor / 10 ** minorUnit);
}

/**
 * Pure: per person (and Shared), the sum of their bank accounts in one
 * currency. Cards are left out (their progress lives on Cards, and a card's
 * balance is what is owed, not what is held), as are wallets in another
 * currency and ones with no computed balance.
 */
export function totalsByPerson(
  wallets: readonly { id: string; kind: string; currency_code: string; balanceMinor: number | null }[],
  personOf: Record<string, Person>,
  currency: string,
): PersonTotal[] {
  const totals = new Map<string, PersonTotal>();
  for (const w of wallets) {
    const person = personOf[w.id];
    if (!person || w.kind !== "bank" || w.currency_code !== currency || w.balanceMinor === null) continue;
    const t = totals.get(person.key) ?? { person, totalMinor: 0, accounts: 0 };
    t.totalMinor += w.balanceMinor;
    t.accounts += 1;
    totals.set(person.key, t);
  }
  // People in their colour order, Shared last.
  return [...totals.values()].sort((a, b) => Number(a.person.key === "shared") - Number(b.person.key === "shared"));
}

/**
 * The tiles across the top of Wallets: what each of you holds, and what is
 * shared, each in its person's tint. Hidden for a household of one, where
 * a single tile would only repeat the list.
 */
export function PeopleTotals({
  totals,
  currency,
  minorUnit,
}: {
  totals: PersonTotal[];
  currency: string;
  minorUnit: number;
}) {
  if (totals.length < 2) return null;
  return (
    <ul aria-label={`Balances by person, ${currency} accounts`} className="mb-6 grid grid-cols-3 gap-2">
      {totals.map(({ person, totalMinor, accounts }) => (
        <li key={person.key} className="flex flex-col gap-1.5 rounded-2xl p-3" style={{ background: person.tint }}>
          <span className="flex items-center gap-1.5">
            <PersonBadge person={person} size={18} />
            <span className="truncate text-[11px] font-extrabold uppercase tracking-wider" style={{ color: "var(--ink)" }}>
              {person.name}
            </span>
          </span>
          <span className="font-display text-base font-extrabold" style={{ color: "var(--ink)" }}>
            {compactMoney(totalMinor, currency, minorUnit)}
          </span>
          <span className="sr-only">
            across {accounts} {accounts === 1 ? "account" : "accounts"}
          </span>
        </li>
      ))}
    </ul>
  );
}
