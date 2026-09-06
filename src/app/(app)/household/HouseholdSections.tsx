"use client";

import { useState } from "react";
import { HouseholdSection, type HouseholdSectionProps } from "./HouseholdSection";

/**
 * Wraps every household section in ONE client boundary that outlives any
 * single one of them. Leaving a household is the one action on this page
 * where the section reporting success is also the section that disappears
 * on the very next render (its space is gone from the server's payload) —
 * a notice held in that section's own state would never get painted. This
 * component sits one level up, outside any single space's `key`, so React
 * keeps its state across that swap even while a child section unmounts.
 * See `HouseholdSection`'s own doc comment on `onLeft`.
 */
export function HouseholdSections({ sections }: { sections: HouseholdSectionProps[] }) {
  const [leftNotice, setLeftNotice] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-8">
      {leftNotice && (
        <p role="status" className="text-sm" style={{ color: "var(--ink-2)" }}>
          {leftNotice}
        </p>
      )}
      {sections.map((s) => (
        <HouseholdSection key={s.space.id} {...s} onLeft={setLeftNotice} />
      ))}
    </div>
  );
}
