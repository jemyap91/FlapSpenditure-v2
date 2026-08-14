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
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          disabled={pending}
          aria-pressed={current === value}
          title={label}
          onClick={() =>
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
            })
          }
          className="grid flex-1 place-items-center rounded p-1.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]"
          style={{
            background: current === value ? "var(--surface)" : "transparent",
            color: "var(--ink)",
          }}
        >
          <Icon size={16} aria-hidden />
          <span className="sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}
