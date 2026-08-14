"use client";

import { useTransition } from "react";
import { Monitor, Sun, Moon } from "lucide-react";
import { setTheme } from "@/server/actions/profile";
import type { ThemePref } from "@/lib/supabase/current-user";

const OPTIONS = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
] as const;

/**
 * A tri-state (system/light/dark) control, not a binary switch, because
 * 'system' is a real, distinct third option that follows OS preference —
 * see src/app/(app)/layout.tsx and src/app/layout.tsx for how the chosen
 * value reaches the document without a flash.
 *
 * `aria-disabled` + an early return, not `disabled`, while a transition is
 * pending: `disabled` removes the button from the tab order and, if it was
 * focused, drops focus to `<body>` — a keyboard user mid-toggle would lose
 * their place. `aria-disabled` keeps the button focusable and announced as
 * disabled without moving focus; the early return in the handler makes a
 * click genuinely inert while pending.
 */
export function ThemeToggle({ current }: { current: ThemePref }) {
  const [pending, start] = useTransition();

  return (
    <div
      role="group"
      aria-label="Theme"
      className="flex gap-1 rounded-md p-1"
      style={{ background: "var(--grid)" }}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const selected = current === value;
        return (
          <button
            key={value}
            type="button"
            aria-disabled={pending}
            aria-pressed={selected}
            title={label}
            onClick={() => {
              if (pending) return;
              start(() => {
                // Fire-and-forget from a click handler, but not unguarded:
                // an unhandled rejection here would otherwise surface only as
                // a console warning with no user-visible feedback. There's no
                // toast/error-surface component in this codebase yet, so this
                // swallows the failure rather than fabricating one; the UI's
                // theme prop simply won't update (see setTheme's revalidatePath),
                // making a failed persist visible as "the click did nothing"
                // rather than a crash.
                void setTheme(value).catch(() => {});
              });
            }}
            className="grid flex-1 place-items-center rounded p-1.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]"
            style={{
              background: selected ? "var(--surface)" : "transparent",
              color: "var(--ink)",
              // Background-only selected state measured 1.29:1 (light) /
              // 1.24:1 (dark) against the unselected buttons — identical
              // icon colour, under WCAG 1.4.11's 3:1 floor for UI component
              // state. A var(--cat-1) inset ring is the second
              // differentiator: it measures 5.60:1 (light) / 5.20:1 (dark)
              // against var(--surface), clearing 3:1 with margin in both
              // themes (see task-14-report.md for the full computation).
              boxShadow: selected ? "inset 0 0 0 2px var(--cat-1)" : "none",
            }}
          >
            <Icon size={16} aria-hidden />
            <span className="sr-only">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
