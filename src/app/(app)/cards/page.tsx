import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUserProfile } from "@/lib/supabase/current-user";
import { CardTracker } from "@/components/CardTracker";
import { PersonBadge } from "@/components/PersonBadge";
import { CHANNEL_LABELS, type Channel } from "@/lib/channels";
import { rankCards, type RankedCard } from "@/lib/card-ranking";
import { formatMoney } from "@/lib/money";
import { personForWallet, type Person } from "@/lib/people";
import { todayLocalDate } from "@/lib/today";
import { loadCardTracker, type CardTrackerRow } from "@/server/card-tracker";
import { loadPeople } from "@/server/people";
import { daysText } from "@/components/CardToWatch";

const LINK_CLASS =
  "rounded-sm text-xs font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]";

/** The last four digits in a card's name ("Yuu Card AMEX 0812 (C)" → "0812"). */
function lastFour(name: string): string | null {
  const all = name.match(/\d{4}/g);
  return all ? all[all.length - 1]! : null;
}

/** The card's name without its digits or "(C)"-style owner tag, for the card art. */
function shortName(name: string): string {
  return name.replace(/\(\w\)/g, "").replace(/\d{4}/g, "").replace(/\s+/g, " ").trim();
}

/**
 * /cards — the Cherry Cola glow-up's new tab: which card to use next,
 * across both of you.
 *
 *  - One answer up top: the highest-ranked card that still wants spend.
 *  - Every card with terms, ranked (`rankCards`), with cycle progress and
 *    an "Avoid" flag for one near its cap.
 *  - Cards with no terms yet, with a way to set them.
 *
 * Everything is measured over today's cycle, the same as Home's card to
 * watch. Reads are RLS-scoped, so each person sees the cards they belong to.
 */
export default async function CardsPage() {
  const supabase = await createClient();
  const profile = await getCurrentUserProfile();
  // (app)/layout.tsx redirects to /login first; defence in depth only.
  if (!profile) throw new Error("Not signed in");
  const today = todayLocalDate();

  const [{ data: wallets, error: walletsError }, tracker, people] = await Promise.all([
    supabase
      .from("wallets")
      .select("id, name, kind, owner_id, shared_with_household")
      .is("archived_at", null)
      .eq("kind", "card")
      .order("name"),
    loadCardTracker(supabase, { on: today, today }),
    loadPeople(supabase, profile.id),
  ]);
  // A failed read is not "no cards".
  if (walletsError) throw new Error("Failed to load cards");

  const byId = new Map((wallets ?? []).map((w) => [w.id, w]));
  const personOf = (walletId: string): Person | null => {
    const w = byId.get(walletId);
    return w ? personForWallet(w, people) : null;
  };

  const ranked = rankCards(tracker, today);
  const useNext = ranked.find((r) => r.status === "chase" || r.status === "room") ?? null;
  const tracked = new Set(tracker.map((r) => r.walletId));
  const untracked = (wallets ?? []).filter((w) => !tracked.has(w.id));

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-7 px-4 py-4 md:p-8">
      <h1 className="text-[26px] font-extrabold" style={{ color: "var(--ink)" }}>
        Cards
      </h1>

      <UseNextHero next={useNext} person={useNext ? personOf(useNext.card.walletId) : null} />

      <CardTracker
        rows={ranked.map((r) => r.card)}
        today={today}
        people={Object.fromEntries(
          tracker.flatMap((r) => {
            const p = personOf(r.walletId);
            return p ? [[r.walletId, p]] : [];
          }),
        )}
      />

      {untracked.length > 0 && (
        <section aria-labelledby="other-cards-heading" className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <h2 id="other-cards-heading" className="font-display text-base font-bold" style={{ color: "var(--ink)" }}>
              Other cards
            </h2>
            <Link href="/wallets" className={LINK_CLASS} style={{ color: "var(--link)" }}>
              Set terms in Wallets
            </Link>
          </div>
          <ul className="flex flex-col rounded-3xl px-4" style={{ background: "var(--surface)" }}>
            {untracked.map((w) => {
              const person = personForWallet(w, people);
              return (
                <li
                  key={w.id}
                  className="flex items-center justify-between gap-2 py-3 [&+&]:border-t"
                  style={{ borderColor: "var(--grid)" }}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span aria-hidden className="h-3.5 w-5 shrink-0 rounded-[4px]" style={{ background: person.color }} />
                    <span className="truncate text-sm font-bold" style={{ color: "var(--ink)" }}>
                      {w.name}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-xs font-semibold" style={{ color: "var(--ink-2)" }}>
                    No bonus terms
                    <PersonBadge person={person} label={person.name} />
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {tracker.length === 0 && untracked.length === 0 && (
        <p className="text-sm" style={{ color: "var(--ink-2)" }}>
          No cards yet. Add a card wallet in{" "}
          <Link href="/wallets" className="underline" style={{ color: "var(--link)" }}>
            Wallets
          </Link>
          .
        </p>
      )}
    </div>
  );
}

/**
 * The screen's one oxblood block: the card to reach for next, drawn as card
 * art in its owner's colour, with why in one sentence.
 */
function UseNextHero({ next, person }: { next: RankedCard<CardTrackerRow> | null; person: Person | null }) {
  return (
    <section
      aria-labelledby="use-next-heading"
      className="relative overflow-hidden rounded-[28px] p-5"
      style={{ background: "var(--hero)", color: "var(--on-hero)" }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute -bottom-20 -right-12 h-48 w-48 rounded-full"
        style={{ background: "var(--hero-deep)" }}
      />
      <h2
        id="use-next-heading"
        className="relative text-[11px] font-extrabold uppercase tracking-[0.12em]"
        style={{ color: "var(--on-hero-2)" }}
      >
        Use next for everyday spend
      </h2>
      {next ? (
        <>
          <div
            className="relative mt-3 flex flex-col gap-5 rounded-2xl p-4"
            style={{ background: person?.color ?? "var(--candy)", color: "var(--on-bright)", boxShadow: "var(--shadow-float)" }}
          >
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-extrabold">{shortName(next.card.walletName)}</p>
              {person && <PersonBadge person={{ ...person, color: "var(--hero)" }} label={person.name} />}
            </div>
            <div className="flex items-end justify-between text-xs font-extrabold">
              <span aria-hidden className="tracking-widest">
                {lastFour(next.card.walletName) ? `•••• ${lastFour(next.card.walletName)}` : ""}
              </span>
              <span>
                {Math.min(100, Math.round((next.card.spentMinor / next.card.capMinor) * 100))}%
              </span>
            </div>
          </div>
          <p className="relative mt-3 text-sm font-semibold" style={{ color: "var(--on-hero)" }}>
            {next.status === "chase" ? (
              <>
                <span className="font-extrabold" style={{ color: "var(--butter)" }}>
                  {formatMoney(next.card.remainingMinor, next.card.currency)} short
                </span>{" "}
                of its {formatMoney(next.card.capMinor, next.card.currency)} min spend, {daysText(next.daysLeft)} in the cycle.
              </>
            ) : (
              <>
                <span className="font-extrabold" style={{ color: "var(--butter)" }}>
                  {formatMoney(next.card.remainingMinor, next.card.currency)} of bonus room
                </span>{" "}
                left on {CHANNEL_LABELS[next.card.bonusChannel as Channel].toLowerCase()} spend, {daysText(next.daysLeft)} in the cycle.
              </>
            )}
          </p>
        </>
      ) : (
        <p className="relative mt-3 text-sm font-semibold">
          Every card has reached its target or cap this cycle. Use whichever you like.
        </p>
      )}
    </section>
  );
}
