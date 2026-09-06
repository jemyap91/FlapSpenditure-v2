"use client";

import { useActionState } from "react";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

type InviteState = { error?: string; notice?: string };

/**
 * The "invite someone by email" form, lifted out of MembersSection so
 * /household's owner invite can reuse the exact same markup and accessible
 * names — only the bound action (and its target: a wallet or a household)
 * differs between callers.
 */
export function InviteByEmailForm({
  action,
  label = "Invite by email",
}: {
  action: (prev: InviteState, formData: FormData) => Promise<InviteState>;
  label?: string;
}) {
  const [state, formAction] = useActionState<InviteState, FormData>(action, {});

  return (
    <>
      <form action={formAction} className="flex items-end gap-2">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            {label}
          </span>
          <input
            type="email"
            name="email"
            required
            placeholder="name@example.com"
            autoComplete="off"
            className={`rounded-md border px-3 py-2 text-sm ${FOCUS_RING}`}
            style={{ borderColor: "var(--ink-2)" }}
          />
        </label>
        <button
          type="submit"
          className={`shrink-0 rounded-md px-3 py-2 text-sm font-medium ${FOCUS_RING}`}
          style={{ background: "var(--cat-1)", color: "var(--surface)" }}
        >
          Send invitation
        </button>
      </form>

      {/* Always mounted, not conditionally rendered — same reasoning as the
          error paragraph this form used to sit next to in MembersSection:
          a role="status" node that appears and gets its text in the same
          instant is not reliably announced. */}
      <p role="status" className="text-sm" style={{ color: state.error ? "var(--neg)" : "var(--ink-2)" }}>
        {state.error ?? state.notice}
      </p>
    </>
  );
}
