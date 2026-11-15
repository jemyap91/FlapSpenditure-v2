/**
 * Who a wallet belongs to, and that person's colour (Cherry Cola: colour
 * means WHO or STATUS, nothing else). Pure.
 *
 * Household members are coloured in a fixed order: alphabetical by display
 * name, then by id. That keeps the colours the same whoever is looking (a
 * viewer-relative "you are pink" would swap them between two phones). The
 * first two get candy and cobalt; anyone after shares a neutral. A wallet
 * shared with the household is "Shared", in butter, whoever owns it.
 */
export type Person = {
  /** Owner's user id, or "shared". */
  key: string;
  name: string;
  /** One or two letters for the round badge. */
  initials: string;
  /** Full-strength colour for badges and small marks. */
  color: string;
  /** Tint for areas. */
  tint: string;
};

export type Member = { user_id: string; display_name: string };

const SLOTS = [
  { color: "var(--candy)", tint: "var(--candy-tint)" },
  { color: "var(--cobalt)", tint: "var(--cobalt-tint)" },
];
const OTHER = { color: "var(--muted)", tint: "var(--grid)" };

export const SHARED: Person = {
  key: "shared",
  name: "Shared",
  initials: "C+J",
  color: "var(--butter)",
  tint: "var(--butter-tint)",
};

const initialOf = (name: string) => (name.trim()[0] ?? "?").toUpperCase();

/** Every distinct household member, coloured. */
export function peopleFor(members: readonly Member[]): Map<string, Person> {
  const unique = new Map<string, Member>();
  for (const m of members) if (!unique.has(m.user_id)) unique.set(m.user_id, m);
  const ordered = [...unique.values()].sort(
    (a, b) => a.display_name.localeCompare(b.display_name) || a.user_id.localeCompare(b.user_id),
  );
  const people = new Map<string, Person>();
  ordered.forEach((m, i) => {
    const slot = SLOTS[i] ?? OTHER;
    people.set(m.user_id, {
      key: m.user_id,
      name: m.display_name,
      initials: initialOf(m.display_name),
      ...slot,
    });
  });
  return people;
}

/**
 * The "Shared" badge's initials, from the first two people ("C+J"), so it
 * reads right for any couple rather than hard-coding one.
 */
export function sharedFor(people: Map<string, Person>): Person {
  const firstTwo = [...people.values()].slice(0, 2).map((p) => p.initials);
  return { ...SHARED, initials: firstTwo.length === 2 ? firstTwo.join("+") : "All" };
}

/** A wallet's person: Shared when shared with the household, else its owner. */
export function personForWallet(
  wallet: { owner_id: string; shared_with_household: boolean },
  people: Map<string, Person>,
): Person {
  if (wallet.shared_with_household) return sharedFor(people);
  return (
    people.get(wallet.owner_id) ?? {
      key: wallet.owner_id,
      name: "Someone else",
      initials: "?",
      ...OTHER,
    }
  );
}
