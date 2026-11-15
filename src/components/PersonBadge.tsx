import type { Person } from "@/lib/people";

/**
 * A round initials badge in a person's colour. Decorative by default
 * (`aria-hidden`): every place that shows one also names the person or the
 * wallet in text. Pass `label` where the badge is the only thing saying who.
 */
export function PersonBadge({ person, size = 22, label }: { person: Person; size?: number; label?: string }) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className="inline-grid shrink-0 place-items-center rounded-full font-extrabold"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(8, Math.round(size * (person.initials.length > 1 ? 0.32 : 0.45))),
        background: person.color,
        color: "var(--on-bright)",
      }}
    >
      {person.initials}
    </span>
  );
}
