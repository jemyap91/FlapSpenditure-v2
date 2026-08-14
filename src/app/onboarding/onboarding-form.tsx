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
 * The interactive part of /onboarding — split out of page.tsx (a Server
 * Component) so the render-time auth/wallet-count gate there can run before
 * any client JS ships, per the same Server-Component-wraps-Client-Component
 * shape src/app/(auth)/login/page.tsx + login-form.tsx already use.
 *
 * Only wallet *creation* lives here. color_slot is fixed to 1 (no color
 * picker in this task's scope) and `icon` is derived from the chosen kind
 * rather than offered as its own control, so there is no "card wallet with
 * a bank icon" mismatch. A wallets-management screen (edit/archive, color
 * and icon choice) is future work — src/server/actions/wallets.ts already
 * exports updateWallet/archiveWallet for it.
 */
export function OnboardingForm() {
  const [state, action, pending] = useActionState<WalletState, FormData>(createWallet, {});
  const [kind, setKind] = useState<WalletInput["kind"]>("bank");
  const [currencyCode, setCurrencyCode] = useState<WalletInput["currency_code"]>("USD");
  const errorId = useId();
  const hintId = useId();
  const errorRef = useRef<HTMLParagraphElement>(null);

  // Derived fresh on every render from the action's returned state — not
  // `useState`/`useEffect` (this project's eslint config forbids both
  // set-state-in-effect and ref reads during render; see react-hooks/
  // set-state-in-effect and react-hooks/refs). Used as part of the `key` on
  // the native radio inputs and the currency `<select>` so each one gets a
  // *fresh* DOM node on the render right after a failed submission, instead
  // of patching the existing node. The hidden `kind`/`currency_code` inputs
  // above already guarantee correct *submission* regardless of this, but the
  // native `<select>`'s own visible box is what a sighted user actually
  // reads as "the currently chosen currency" — left unkeyed, it visibly
  // drifted to showing "USD" after a failed submit even while this
  // component's own `currencyCode` state (and everything bound to it: the
  // hint text below, the hidden input) correctly still read "KWD". A fresh
  // DOM node, created directly from `currencyCode`/`kind` at mount, cannot
  // inherit that drift — there's nothing prior for it to drift from.
  //
  // Content-based (error + field), not a counter: a resubmission of
  // identical invalid data producing the identical error is the one case
  // this doesn't force a remount for, which is fine — there is nothing new
  // to correct in that case since the previous remount already applied.
  const formResetKey = `${state.error ?? ""}|${state.field ?? ""}`;

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
    (minorUnit === 0
      ? `${currencyCode} has no decimal places — enter a whole number.`
      : `${currencyCode} allows up to ${minorUnit} decimal place${minorUnit === 1 ? "" : "s"}.`) +
    // parseAmountInput (src/lib/money.ts) never accepts a leading "-" — the
    // sign comes from transaction kind in Task 18's keypad, not free text —
    // so a card wallet cannot start with the negative balance a credit card
    // normally carries. Stating that here, rather than silently accepting
    // "-500" as if it meant debt and storing +500, is the honest option
    // until a product decision widens this.
    " Only zero or positive amounts are accepted.";

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
        {/* `kind` and `currency_code` are submitted via these hidden inputs,
            not by giving `name="kind"`/`name="currency_code"` to the visible
            radio/select below. Root-caused via reproduction: after a failed
            submission re-renders this route (Server Component -> Client
            Component boundary, per node_modules/next/dist/docs/01-app/02-guides/
            server-actions.md's "seeded navigation" response model), the
            native `<input type="radio">`'s `checked` PROPERTY and the native
            `<select>`'s `.value` PROPERTY silently revert to their defaults
            (bank/USD) — but this component's own `kind`/`currencyCode`
            state does NOT (confirmed live: the `icon` hidden input above,
            already bound to `kind`, kept reading "credit-card" — i.e. still
            "card" — even while the native radio's `checked` read `false` for
            "card" and `true` for "bank"). If `name` lived on the native
            elements, a resubmit after fixing e.g. a precision error would
            silently submit "bank"/"USD" instead of the user's actual "card"/
            "KWD" choice — a silent wrong-wallet bug, not just a display
            glitch. Routing submission through hidden inputs tied directly to
            `kind`/`currencyCode` (proven reliable) instead removes the
            native elements' live DOM properties from the trust chain
            entirely; they remain purely presentational + input capture. */}
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="currency_code" value={currencyCode} />

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
            aria-invalid={state.field === "name" ? true : undefined}
            className={`rounded-md border px-3 py-2 ${FOCUS_RING}`}
            style={{ borderColor: "var(--ink-2)" }}
          />
        </label>

        <fieldset className="flex gap-2" aria-describedby={errorId}>
          <legend className="mb-1 text-sm" style={{ color: "var(--ink-2)" }}>
            Type
          </legend>
          {KINDS.map(({ value, label, Icon }) => {
            const selected = kind === value;
            return (
              <label key={value} className="flex-1 cursor-pointer">
                <input
                  key={`${value}-${formResetKey}`}
                  type="radio"
                  // No `name`: this native radio drives only the visible
                  // selected-state styling and accessible checked state,
                  // never submission — see the hidden `kind` input above.
                  // `key` includes formResetKey so a failed submission gets
                  // a fresh node (see formResetKey's doc comment) rather
                  // than patching one whose `checked` property may have
                  // drifted from `selected`.
                  value={value}
                  checked={selected}
                  onChange={() => setKind(value)}
                  className="peer sr-only"
                />
                <div
                  className={`flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-center ${FOCUS_RING} peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--cat-1)]`}
                  style={{
                    borderColor: selected ? "var(--cat-1)" : "var(--ink-2)",
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
            key={formResetKey}
            // No `name`: drives only the visible control and its onChange —
            // never submission. See the hidden `currency_code` input above.
            // `key` forces a fresh node after a failed submission — see
            // formResetKey's doc comment. Uncontrolled (`defaultValue`, not
            // `value`) because a *controlled* `<select>` here kept showing
            // "USD" post-remount even with the fresh key — Chromium's
            // autofill/form-value-restoration for `<select>` elements
            // reasserts itself against a JS-set `value` in a way it does not
            // for the radio inputs above. `defaultValue` on a freshly-keyed
            // node plus the `onChange` below (still updating `currencyCode`
            // for the hint text and hidden input) reproducibly held.
            defaultValue={currencyCode}
            onChange={(e) => setCurrencyCode(e.target.value as WalletInput["currency_code"])}
            aria-describedby={errorId}
            aria-invalid={state.field === "currency_code" ? true : undefined}
            className={`rounded-md border px-3 py-2 ${FOCUS_RING}`}
            style={{ borderColor: "var(--ink-2)" }}
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
            aria-invalid={state.field === "starting_balance" ? true : undefined}
            className={`rounded-md border px-3 py-2 ${FOCUS_RING}`}
            style={{ borderColor: "var(--ink-2)" }}
          />
          <span id={hintId} className="text-xs" style={{ color: "var(--ink-2)" }}>
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
