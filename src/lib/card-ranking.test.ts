import { describe, it, expect } from "vitest";
import { cardStatus, cardToWatch, daysLeftInCycle, rankCards, type RankableCard } from "./card-ranking";

const card = (over: Partial<RankableCard> & { walletId: string }): RankableCard => ({
  bonusChannel: null,
  capMinor: 80000,
  spentMinor: 0,
  remainingMinor: 80000,
  to: "2026-11-23",
  ...over,
});

const TODAY = "2026-11-18";

describe("daysLeftInCycle", () => {
  it("counts today, and stops at zero once the cycle has ended", () => {
    expect(daysLeftInCycle("2026-11-23", TODAY)).toBe(6);
    expect(daysLeftInCycle(TODAY, TODAY)).toBe(1);
    expect(daysLeftInCycle("2026-11-10", TODAY)).toBe(0);
  });
});

describe("cardStatus", () => {
  it("chases a min spend until it is reached", () => {
    expect(cardStatus(card({ walletId: "a", remainingMinor: 25980 }))).toBe("chase");
    expect(cardStatus(card({ walletId: "a", remainingMinor: 0 }))).toBe("done");
  });

  it("calls a bonus card with under 15% of its cap left one to avoid", () => {
    const bonus = { walletId: "b", bonusChannel: "online", capMinor: 100000 };
    expect(cardStatus(card({ ...bonus, remainingMinor: 69000 }))).toBe("room");
    expect(cardStatus(card({ ...bonus, remainingMinor: 8750 }))).toBe("avoid");
    expect(cardStatus(card({ ...bonus, remainingMinor: 0 }))).toBe("avoid");
  });
});

describe("rankCards", () => {
  it("puts min spends to chase first, then bonus room, then done, then avoid", () => {
    const ranked = rankCards(
      [
        card({ walletId: "avoid", bonusChannel: "online", capMinor: 100000, remainingMinor: 8750 }),
        card({ walletId: "done", remainingMinor: 0 }),
        card({ walletId: "room", bonusChannel: "online", capMinor: 100000, remainingMinor: 69000 }),
        card({ walletId: "chase", remainingMinor: 25980 }),
      ],
      TODAY,
    );
    expect(ranked.map((r) => r.card.walletId)).toEqual(["chase", "room", "done", "avoid"]);
  });

  it("orders min spends by what is still needed per day", () => {
    const ranked = rankCards(
      [
        // 300 over 30 days = 10/day
        card({ walletId: "relaxed", remainingMinor: 30000, to: "2026-12-17" }),
        // 260 over 6 days ≈ 43/day
        card({ walletId: "urgent", remainingMinor: 26000 }),
      ],
      TODAY,
    );
    expect(ranked.map((r) => r.card.walletId)).toEqual(["urgent", "relaxed"]);
  });

  it("orders bonus room by most room left", () => {
    const ranked = rankCards(
      [
        card({ walletId: "less", bonusChannel: "online", capMinor: 100000, remainingMinor: 40000 }),
        card({ walletId: "more", bonusChannel: "in_store", capMinor: 100000, remainingMinor: 90000 }),
      ],
      TODAY,
    );
    expect(ranked.map((r) => r.card.walletId)).toEqual(["more", "less"]);
  });
});

describe("cardToWatch", () => {
  it("picks the most urgent min spend", () => {
    expect(cardToWatch([card({ walletId: "a", remainingMinor: 1000 }), card({ walletId: "b" })], TODAY)?.card.walletId).toBe("b");
  });

  it("falls back to a bonus card close to its cap", () => {
    const near = card({ walletId: "near", bonusChannel: "online", capMinor: 100000, remainingMinor: 8750 });
    expect(cardToWatch([near, card({ walletId: "done", remainingMinor: 0 })], TODAY)?.card.walletId).toBe("near");
  });

  it("is null when nothing needs attention", () => {
    expect(cardToWatch([card({ walletId: "done", remainingMinor: 0 })], TODAY)).toBeNull();
    expect(cardToWatch([], TODAY)).toBeNull();
  });
});
