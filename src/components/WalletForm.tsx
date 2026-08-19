"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { Landmark, CreditCard } from "lucide-react";
import type { WalletState } from "@/server/actions/wallets";
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
 * The wallet create/edit form, shared by /onboarding (first wallet) and
 * /wallets (every one after that). Extracted from onboarding-form.tsx
 * rather than copied: the hidden-input machinery below works around a
 * native form-reset behaviour that took several attempts to pin down (see
 * the comments on the hidden inputs and the ref-based effect), and two
 * copies of that would drift the moment either screen changed.
 *
 * The caller supplies the Server Action and the surrounding layout —
 * /onboarding centres this in a full-height <main> with a heading,
 * /wallets renders it below the wallet list — so this component renders
 * only the <form> itself and takes no view on its own placement.
 *
 * Only wallet *creation* is bound today. color_slot is fixed to 1 (no
 * colour picker in scope) and `icon` is derived from the chosen kind
 * rather than offered as its own control, so there is no "card wallet with
 * a bank icon" mismatch. Editing is future work — updateWallet already
 * exists in src/server/actions/wallets.ts for it.
 */
export function WalletForm({
  action: submitAction,
  submitLabel,
  pendingLabel,
}: {
  action: (prev: WalletState, formData: FormData) => Promise<WalletState>;
  submitLabel: string;
  pendingLabel: string;
}) {

  const [state, action, pending] = useActionState<WalletState, FormData>(submitAction, {});
  const [kind, setKind] = useState<WalletInput["kind"]>("bank");
  const [currencyCode, setCurrencyCode] = useState<WalletInput["currency_code"]>("USD");
  const errorId = useId();
  const hintId = useId();
  const errorRef = useRef<HTMLParagraphElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const bankRadioRef = useRef<HTMLInputElement>(null);
  const cardRadioRef = useRef<HTMLInputElement>(null);

  // Same technique as (auth)/login and (auth)/signup: move focus to the
  // always-mounted alert node whenever an error (re)appears, since a
  // conditionally-mounted role="alert" doesn't announce reliably across
  // screen-reader/browser pairs but mount + focus does.
  useEffect(() => {
    if (state.error) errorRef.current?.focus();
  }, [state.error]);

  // Forcibly re-applies `kind`/`currencyCode` to the native radio/select
  // DOM nodes after every action response. This is a correction, not a
  // belt-and-suspenders extra: it is the only approach out of several tried
  // that actually closes the bug (see the hidden-input comment below for
  // what the bug is). React's normal controlled-prop reconciliation
  // (`checked={...}`, `value={...}`) and a `key`-forced remount were BOTH
  // tried first and both proved insufficient for the `<select>` specifically
  // — confirmed by trapping `HTMLSelectElement.prototype`'s `value` setter:
  // after a failed submission, the setter is never called again at all, yet
  // the select's live value still changes (to the first `<option>`, i.e. the
  // browser's own default-if-nothing-selected behavior). Something outside
  // React's own property-setter path is what changes it, so nothing that
  // only asks React to re-render can reliably win — an imperative,
  // post-paint correction is required. `useEffect` (not the render body,
  // which this project's eslint config forbids mutating DOM nodes from
  // anyway) runs after the browser has committed and painted, i.e. after
  // whatever causes the drift has already had its chance to run, so setting
  // the properties here is what actually wins the race.
  //
  // Purely a display correction: submission was never at risk from this —
  // the hidden `kind`/`currency_code` inputs below never depend on these
  // native elements' own properties.
  useEffect(() => {
    if (selectRef.current) selectRef.current.value = currencyCode;
    if (bankRadioRef.current) bankRadioRef.current.checked = kind === "bank";
    if (cardRadioRef.current) cardRadioRef.current.checked = kind === "card";
    // Re-run whenever the action produces a new result (covers the failed-
    // submission case this exists for) or the user changes their selection
    // interactively (harmless — re-asserting the value already showing is a
    // no-op write).
  }, [state, kind, currencyCode]);

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
    <form action={action} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="color_slot" value="1" />
      <input type="hidden" name="icon" value={selectedIcon} />
      {/* `kind` and `currency_code` are submitted via these hidden inputs,
          not by giving `name="kind"`/`name="currency_code"` to the visible
          radio/select below.

          What's known, from direct reproduction (fill the form, submit an
          invalid amount, inspect the DOM): after a failed submission, the
          native `<input type="radio">`'s `checked` PROPERTY and the native
          `<select>`'s `.value` PROPERTY silently revert toward their
          defaults (bank/USD) — but this component's own `kind`/
          `currencyCode` state does NOT (confirmed live: the `icon` hidden
          input below, already bound to `kind`, kept reading "credit-card"
          — i.e. still "card" — even while the native radio's `checked`
          read `false` for "card" and `true` for "bank"). If `name` lived
          on the native elements, a resubmit after fixing e.g. a precision
          error would silently submit "bank"/"USD" instead of the user's
          actual "card"/"KWD" choice — a silent wrong-wallet bug, not just
          a display glitch.

          What's NOT known: the exact mechanism. An earlier version of this
          comment asserted it was Next's Server-Component-triggered
          "seeded navigation" re-render (server-actions.md) — that's wrong
          and was retracted: `createWallet`'s failure branches only
          `return`, calling none of `revalidatePath`/`redirect`/
          `updateTag`/cookie mutation, so per that same doc no re-rendered
          RSC payload is produced for those branches. The best-supported
          hypothesis instead is React 19's own `<form action>` performing a
          native-style reset after each dispatch, colliding with React
          DOM's controlled-input bailout for `checked`/`<select>` (skip the
          DOM write if the value looks unchanged from what React last set)
          — but this was not traced in React's source, so treat it as a
          hypothesis, not fact.

          The fix does not depend on diagnosing the mechanism: routing
          submission through hidden inputs tied directly to
          `kind`/`currencyCode` (proven reliable by the icon-field evidence
          above) removes the native elements' live DOM properties from the
          trust chain entirely for *submission*; they remain purely
          presentational + input capture. See the ref-based `useEffect`
          above for how the *visible* controls are kept honest too — plain
          controlled props (`checked=`/`value=`) and a `key`-forced remount
          were both tried and neither was sufficient on their own. */}
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
                ref={value === "bank" ? bankRadioRef : cardRadioRef}
                type="radio"
                // No `name`: this native radio drives only the visible
                // selected-state styling and accessible checked state,
                // never submission — see the hidden `kind` input above.
                // Controlled (`checked=`, not `defaultChecked=`) for the
                // normal interactive case; the `useEffect` above is what
                // actually corrects it after a failed submission — see
                // that effect's comment.
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
          ref={selectRef}
          // No `name`: drives only the visible control and its onChange —
          // never submission. See the hidden `currency_code` input above.
          // Controlled (`value=`, not `defaultValue=`) for the normal
          // interactive case; the `useEffect` above is what actually
          // corrects it after a failed submission — see that effect's
          // comment for why (a `key`-forced remount was tried first and
          // was not sufficient: instrumenting `HTMLSelectElement.
          // prototype`'s `value` setter showed it is never called again
          // after a failed submission, yet the select's live value still
          // changes — something outside React's own property-write path
          // is responsible, so only a later, imperative, post-paint write
          // reliably wins).
          value={currencyCode}
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
        {pending ? pendingLabel : submitLabel}
      </button>
    </form>
  );
}
