"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { Landmark, CreditCard } from "lucide-react";
import { createWallet, type WalletState } from "@/server/actions/wallets";
import { CURRENCY_CODES, type WalletInput } from "@/lib/validation/wallet";
import { minorUnitFor } from "@/lib/money";

const KINDS = [
  { value: "bank", label: "Bank", Icon: Landmark, icon: "landmark" },
  { value: "card", label: "Card", Icon: CreditCard, icon: "credit-card" },
] as const satisfies readonly {
  value: WalletInput["kind"];
  label: string;
  Icon: typeof Landmark;
  icon: WalletInput["icon"];
}[];

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

/**
 * A brand-new signup lands here — see (app)/layout.tsx's wallet-count gate
 * and src/server/actions/auth.ts's signUp, which redirects straight to
 * /onboarding. This route is deliberately a sibling of the `(app)` route
 * group, not nested inside it: (app)/layout.tsx redirects any wallet-less
 * user to /onboarding, so if this page rendered under that layout the
 * redirect would loop forever (see the layout's doc comment).
 *
 * Only wallet *creation* lives here. color_slot is fixed to 1 (no color
 * picker in this task's scope) and `icon` is derived from the chosen kind
 * rather than offered as its own control, so there is no "card wallet with
 * a bank icon" mismatch. A wallets-management screen (edit/archive, color
 * and icon choice) is future work — src/server/actions/wallets.ts already
 * exports updateWallet/archiveWallet for it.
 */
export default function OnboardingPage() {
  const [state, action, pending] = useActionState<WalletState, FormData>(createWallet, {});
  const [kind, setKind] = useState<WalletInput["kind"]>("bank");
  const [currencyCode, setCurrencyCode] = useState<WalletInput["currency_code"]>("USD");
  const errorId = useId();
  const hintId = useId();
  const errorRef = useRef<HTMLParagraphElement>(null);

  // Same technique as (auth)/login and (auth)/signup: move focus to the
  // always-mounted alert node whenever an error (re)appears, since a
  // conditionally-mounted role="alert" doesn't announce reliably across
  // screen-reader/browser pairs but mount + focus does.
  useEffect(() => {
    if (state.error) errorRef.current?.focus();
  }, [state.error]);

  const selectedIcon = KINDS.find((k) => k.value === kind)!.icon;
  const minorUnit = minorUnitFor(currencyCode);
  const balanceHint =
    minorUnit === 0
      ? `${currencyCode} has no decimal places — enter a whole number.`
      : `${currencyCode} uses ${minorUnit} decimal place${minorUnit === 1 ? "" : "s"}.`;

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-3xl font-semibold">Add your first account</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--ink-2)" }}>
          A card or bank account to track. You can add more later.
        </p>
      </div>
      <form action={action} className="flex flex-col gap-4" noValidate>
        <input type="hidden" name="color_slot" value="1" />
        <input type="hidden" name="icon" value={selectedIcon} />

        <label className="flex flex-col gap-1">
          <span className="text-sm" style={{ color: "var(--ink-2)" }}>
            Name
          </span>
          <input
            name="name"
            required
            maxLength={60}
            placeholder="Everyday account"
            autoComplete="off"
            aria-describedby={errorId}
            className={`rounded-md border px-3 py-2 ${FOCUS_RING}`}
            style={{ borderColor: "var(--grid)" }}
          />
        </label>

        <fieldset className="flex gap-2">
          <legend className="mb-1 text-sm" style={{ color: "var(--ink-2)" }}>
            Type
          </legend>
          {KINDS.map(({ value, label, Icon }) => {
            const selected = kind === value;
            return (
              <label key={value} className="flex-1 cursor-pointer">
                <input
                  type="radio"
                  name="kind"
                  value={value}
                  checked={selected}
                  onChange={() => setKind(value)}
                  className="peer sr-only"
                />
                <div
                  className={`flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-center ${FOCUS_RING} peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--cat-1)]`}
                  style={{
                    borderColor: selected ? "var(--cat-1)" : "var(--grid)",
                    background: selected ? "var(--grid)" : "transparent",
                    fontWeight: selected ? 600 : 400,
                  }}
                >
                  <Icon size={16} aria-hidden />
                  {label}
                </div>
              </label>
            );
          })}
        </fieldset>

        <label className="flex flex-col gap-1">
          <span className="text-sm" style={{ color: "var(--ink-2)" }}>
            Currency
          </span>
          <select
            name="currency_code"
            value={currencyCode}
            onChange={(e) => setCurrencyCode(e.target.value as WalletInput["currency_code"])}
            aria-describedby={errorId}
            className={`rounded-md border px-3 py-2 ${FOCUS_RING}`}
            style={{ borderColor: "var(--grid)" }}
          >
            {CURRENCY_CODES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm" style={{ color: "var(--ink-2)" }}>
            Starting balance
          </span>
          <input
            name="starting_balance"
            inputMode="decimal"
            defaultValue="0"
            aria-describedby={`${hintId} ${errorId}`}
            className={`rounded-md border px-3 py-2 ${FOCUS_RING}`}
            style={{ borderColor: "var(--grid)" }}
          />
          <span id={hintId} className="text-xs" style={{ color: "var(--muted)" }}>
            {balanceHint}
          </span>
        </label>

        {/* Always mounted (not conditionally rendered) — see the useEffect
            above for why. Empty when there's nothing to say. */}
        <p ref={errorRef} id={errorId} role="alert" tabIndex={-1} style={{ color: "var(--neg)" }}>
          {state.error}
        </p>

        <button
          type="submit"
          disabled={pending}
          className={`rounded-md px-4 py-2 font-medium disabled:opacity-60 ${FOCUS_RING}`}
          style={{ background: "var(--cat-1)", color: "var(--surface)" }}
        >
          {pending ? "Creating…" : "Create account"}
        </button>
      </form>
    </main>
  );
}
