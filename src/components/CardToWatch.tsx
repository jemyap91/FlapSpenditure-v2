import Link from "next/link";
import { formatMoney } from "@/lib/money";
import type { RankedCard } from "@/lib/card-ranking";
import type { Person } from "@/lib/people";
import type { CardTrackerRow } from "@/server/card-tracker";
import { PersonBadge } from "./PersonBadge";

const LINK_CLASS =
  "rounded-sm text-xs font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]";

export const daysText = (days: number) =>
  days === 0 ? "cycle ended" : days === 1 ? "last day" : `${days} days left`;

/**
 * Home's single card alert (Cherry Cola: "only one card alert here; the
 * rest live in Cards"). Chosen by `cardToWatch`: the most urgent min spend,
 * or failing that a bonus card about to hit its cap. Renders nothing when
 * no card needs attention.
 */
export function CardToWatch({ watch, person }: { watch: RankedCard<CardTrackerRow> | null; person: Person | null }) {
  if (!watch) return null;
  const { card, status, daysLeft } = watch;
  const remaining = formatMoney(card.remainingMinor, card.currency);
  const line =
    status === "chase"
      ? `${remaining} to min spend · ${daysText(daysLeft)}`
      : `${remaining} left before bonus cap · ${daysText(daysLeft)}`;
  const fraction = card.capMinor > 0 ? Math.min(card.spentMinor / card.capMinor, 1) : 0;

  return (
    <section aria-labelledby="watch-heading" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 id="watch-heading" className="font-display text-base font-bold" style={{ color: "var(--ink)" }}>
          Card to watch
        </h2>
        <Link href="/cards" className={LINK_CLASS} style={{ color: "var(--ink-2)" }}>
          Cards tab
        </Link>
      </div>
      <div className="flex flex-col gap-2 rounded-3xl p-4" style={{ background: "var(--surface)" }}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-extrabold" style={{ color: "var(--ink)" }}>
            {card.walletName}
          </h3>
          {person && <PersonBadge person={person} label={person.name} />}
        </div>
        <p className="text-xs font-semibold" style={{ color: status === "avoid" ? "var(--neg)" : "var(--ink-2)" }}>
          {line}
        </p>
        <div aria-hidden className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--grid)" }}>
          <div
            className="h-full rounded-full"
            style={{
              width: `${fraction * 100}%`,
              background: status === "avoid" ? "var(--cherry)" : (person?.color ?? "var(--accent)"),
            }}
          />
        </div>
      </div>
    </section>
  );
}
