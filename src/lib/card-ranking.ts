/**
 * Which card to use next, from the card tracker's rows (Cherry Cola's Cards
 * tab and Home's "Card to watch"). Pure: no I/O and no formatting.
 *
 * A card is one of two kinds (see card-tracker.ts):
 *  - min spend (no bonus channel): every expense counts toward a target,
 *    and the bonus only unlocks once it is reached;
 *  - bonus cap (a bonus channel): spend on that channel earns the bonus up
 *    to a max, and nothing past it does.
 *
 * Ranking, most useful first:
 *  1. Min-spend cards still short of their target, the one needing the
 *     most spend per remaining day first: missing it loses the bonus.
 *  2. Bonus cards with room left, most room first.
 *  3. Min-spend cards already reached: nothing to chase.
 *  4. Bonus cards near or past their cap ("avoid"): more spend there earns
 *     nothing extra.
 */
export type RankableCard = {
  walletId: string;
  bonusChannel: string | null;
  capMinor: number;
  spentMinor: number;
  remainingMinor: number;
  to: string;
};

export type CardStatus = "chase" | "room" | "done" | "avoid";

export type RankedCard<T extends RankableCard> = {
  card: T;
  status: CardStatus;
  /** Days left in the cycle, today included. */
  daysLeft: number;
};

/** A bonus card with less than this share of its cap left is "near" it. */
export const NEAR_CAP_SHARE = 0.15;

const dayNumber = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

export function daysLeftInCycle(to: string, today: string): number {
  return Math.max(0, dayNumber(to) - dayNumber(today) + 1);
}

export function cardStatus(card: RankableCard): CardStatus {
  if (card.bonusChannel === null) return card.remainingMinor > 0 ? "chase" : "done";
  return card.remainingMinor > card.capMinor * NEAR_CAP_SHARE ? "room" : "avoid";
}

const ORDER: Record<CardStatus, number> = { chase: 0, room: 1, done: 2, avoid: 3 };

export function rankCards<T extends RankableCard>(cards: readonly T[], today: string): RankedCard<T>[] {
  const ranked = cards.map((card) => ({
    card,
    status: cardStatus(card),
    daysLeft: daysLeftInCycle(card.to, today),
  }));
  // Spend still needed per day; a cycle that has ended needs it all now.
  const perDay = (r: RankedCard<T>) => r.card.remainingMinor / Math.max(1, r.daysLeft);
  return ranked.sort((a, b) => {
    if (a.status !== b.status) return ORDER[a.status] - ORDER[b.status];
    if (a.status === "chase") return perDay(b) - perDay(a);
    if (a.status === "room") return b.card.remainingMinor - a.card.remainingMinor;
    return 0;
  });
}

/**
 * The single card worth a look on Home: the most urgent min-spend card, or
 * failing that a bonus card about to hit its cap. Null when nothing needs
 * attention -- Home then shows no card block at all.
 */
export function cardToWatch<T extends RankableCard>(cards: readonly T[], today: string): RankedCard<T> | null {
  const ranked = rankCards(cards, today);
  return ranked.find((r) => r.status === "chase") ?? ranked.find((r) => r.status === "avoid" && r.card.remainingMinor > 0) ?? null;
}
