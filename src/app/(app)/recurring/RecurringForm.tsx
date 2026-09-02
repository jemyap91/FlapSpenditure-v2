"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";
import type { RecurringState } from "@/server/actions/recurring";
import { RECUR_INTERVALS } from "@/lib/validation/recurring";
import type { RecurInterval } from "@/lib/recurrence";
import { clampAmountInput, minorUnitFor } from "@/lib/money";
import { CategoryPicker, type Category } from "@/components/CategoryPicker";

const KINDS = [
  { value: "expense", label: "Expense", Icon: TrendingDown },
  { value: "income", label: "Income", Icon: TrendingUp },
] as const satisfies readonly { value: "expense" | "income"; label: string; Icon: typeof TrendingDown }[];

const INTERVAL_LABELS: Record<RecurInterval, string> = {
  weekly: "Weekly",
  fortnightly: "Fortnightly",
  monthly: "Monthly",
  yearly: "Yearly",
};

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

/**
 * The recurring-rule create/edit form, shared by /recurring's "Add a
 * recurring rule" section and its per-rule Edit dialog (RecurringList.tsx)
 * — the same Server-Action-driven split, and for the same reason,
 * src/components/WalletForm.tsx already established for wallets. Read that
 * component's long comment before changing anything here: `kind` and
 * `interval_unit` are native `<input type="radio">`/`<select>` controls,
 * which is exactly the shape that comment documents a real, reproduced bug
 * for — after a failed `useActionState` submission, the native element's
 * own `checked`/`value` PROPERTY silently reverts toward its default,
 * independently of this component's own React state. Submission is
 * therefore routed through hidden inputs tied to `kind`/`interval_unit`/
 * `wallet_id` state, never through `name` on the visible controls, and a
 * ref-based `useEffect` (identical technique, same file to compare against)
 * forcibly re-applies the visible controls' properties after every action
 * response so the DISPLAY doesn't lie either.
 *
 * `currency_code` is never offered as its own control, on either path. A
 * rule's currency must equal its wallet's — supabase/migrations/
 * 0015_recurring.sql's composite FKs (`wallets_id_currency` +
 * `transactions_currency_matches_wallet`) enforce that for the eventual
 * transaction, and `createRule`/`updateRule`'s own `checkWalletCurrency`
 * refuse a mismatch at save time with a readable message — so the simplest
 * form that cannot ever PRODUCE that mismatch derives currency from
 * whichever wallet is currently selected. Same choice WalletForm's own doc
 * comment made for `icon` (derived from `kind`, "no card wallet with a bank
 * icon mismatch") — one fewer control is one fewer way to disagree with
 * itself.
 *
 * EDIT MODE is this same component with `defaults` supplied and
 * `lockWallet` set. The wallet control is not rendered at all, mirroring
 * WalletForm's `lockCurrency`: 0015's own column-scoped UPDATE grant
 * (`grant update (name, kind, amount_minor, currency_code, category_id,
 * interval_unit, anchor_on, ends_on, archived_at, updated_at) ...`) omits
 * `wallet_id` on purpose — moving a rule between wallets is not a feature
 * this migration builds, so offering a control that can never succeed would
 * be worse than not offering one. The hidden `wallet_id`/`currency_code`
 * inputs still submit the rule's own values regardless: `recurringInput`
 * requires both to parse (it is shared with `createRule`, which needs
 * them), even though `updateRule` discards `wallet_id` and only re-derives
 * `currency_code`'s validity from the rule's own (unchangeable) wallet.
 */
export function RecurringForm({
  action: submitAction,
  submitLabel,
  pendingLabel,
  wallets,
  categories,
  defaultWalletId,
  defaults,
  lockWallet = false,
  onSuccess,
}: {
  action: (prev: RecurringState, formData: FormData) => Promise<RecurringState>;
  submitLabel: string;
  pendingLabel: string;
  wallets: { id: string; name: string; currency_code: string }[];
  categories: Category[];
  /** Which wallet the select starts on when creating. Still required in
   *  edit mode (used for the locked wallet's display line) even though no
   *  control renders. */
  defaultWalletId: string;
  /** The rule being edited. Absent when creating. */
  defaults?: {
    wallet_id: string;
    name: string;
    kind: "expense" | "income";
    amount: string;
    category_id: string;
    interval_unit: RecurInterval;
    anchor_on: string;
    ends_on: string;
  };
  /** Hides the wallet control. Set when editing — see the doc above. */
  lockWallet?: boolean;
  /**
   * Called once after a submission that returned no error — used by
   * RecurringList to close its edit dialog. Same detection technique as
   * WalletForm's identical prop: `state` alone can't tell a fresh success
   * from the initial `{}`, so the FALLING edge of `pending` is what's
   * watched instead.
   */
  onSuccess?: () => void;
}) {
  const [state, action, pending] = useActionState<RecurringState, FormData>(submitAction, {});
  const [walletId, setWalletId] = useState(defaults?.wallet_id ?? defaultWalletId);
  const [kind, setKind] = useState<"expense" | "income">(defaults?.kind ?? "expense");
  const [intervalUnit, setIntervalUnit] = useState<RecurInterval>(defaults?.interval_unit ?? "monthly");
  const [categoryId, setCategoryId] = useState<string | null>(defaults?.category_id ?? null);
  // Controlled (not the plain `defaultValue` text fields below use) purely
  // so switching wallets can re-clamp it — see `handleWalletChange`. Routed
  // through the same hidden-input pattern as `kind`/`interval_unit`/
  // `wallet_id` (no `name` on the visible control) for uniformity with the
  // rest of this file, even though a plain text input's `value` isn't known
  // to suffer the native-reset bug those exist for.
  const [amount, setAmount] = useState(defaults?.amount ?? "0");

  const errorId = useId();
  const errorRef = useRef<HTMLParagraphElement>(null);
  const walletSelectRef = useRef<HTMLSelectElement>(null);
  const intervalSelectRef = useRef<HTMLSelectElement>(null);
  const expenseRadioRef = useRef<HTMLInputElement>(null);
  const incomeRadioRef = useRef<HTMLInputElement>(null);
  const amountInputRef = useRef<HTMLInputElement>(null);

  // Same technique as WalletForm/login/signup: move focus to the
  // always-mounted alert node whenever an error (re)appears.
  useEffect(() => {
    if (state.error) errorRef.current?.focus();
  }, [state.error]);

  // Fires on the FALLING edge of `pending` (a submission that just finished
  // with no error left behind) — watching `state` instead would fire on
  // mount, since a successful result and the initial state are both `{}`.
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending && !state.error) onSuccess?.();
    wasPending.current = pending;
  }, [pending, state, onSuccess]);

  // Forcibly re-applies wallet/interval/kind to the native select/radio DOM
  // nodes after every action response — see this component's own doc
  // comment, and WalletForm.tsx's identical effect, for why an imperative,
  // post-paint correction (not controlled props alone, not a key-forced
  // remount) is what actually wins the race against React DOM's own
  // form-reset behaviour. Purely a display correction: the hidden inputs
  // below never read these native elements' own properties.
  useEffect(() => {
    if (walletSelectRef.current) walletSelectRef.current.value = walletId;
    if (intervalSelectRef.current) intervalSelectRef.current.value = intervalUnit;
    if (expenseRadioRef.current) expenseRadioRef.current.checked = kind === "expense";
    if (incomeRadioRef.current) incomeRadioRef.current.checked = kind === "income";
    if (amountInputRef.current) amountInputRef.current.value = amount;
  }, [state, walletId, kind, intervalUnit, amount]);

  const wallet = wallets.find((w) => w.id === walletId) ?? wallets[0];
  const currencyCode = wallet?.currency_code ?? "USD";
  const minorUnit = minorUnitFor(currencyCode);
  // Categories belong to a wallet (0008) — filtered fresh on every render
  // since the wallet select can change after mount, matching
  // TransactionForm's identical `walletCategories`.
  const walletCategories = categories.filter((c) => c.wallet_id === walletId);

  function handleKindChange(next: "expense" | "income") {
    setKind(next);
    // Expense/income draw from disjoint category lists (CategoryPicker
    // filters by `kind`) — matching TransactionForm's identical
    // handleKindChange, a stale selection from the other kind would
    // otherwise silently fail the server's own kind-match check
    // (`checkCategory` in src/server/actions/recurring.ts) instead of
    // being caught here.
    setCategoryId(null);
  }

  function handleWalletChange(next: string) {
    const nextWallet = wallets.find((w) => w.id === next);
    setWalletId(next);
    // A category belongs to a wallet, and 0015's
    // `recurring_rules_category_same_wallet` composite FK refuses a
    // cross-wallet pairing outright — matching TransactionForm's identical
    // handleWalletChange, clearing here is what stops the user from ever
    // reaching that refusal in the first place.
    setCategoryId(null);
    // Fix round 1 (task-5-fix-1, Important): the wallet just changed
    // currency, possibly to a SMALLER `minorUnit` — an amount already typed
    // under the OLD currency's precision can be over-precise for the new
    // one (e.g. "45.999" typed against KWD's 3 decimals is invalid for
    // USD's 2). Without this, the field silently kept showing the
    // now-invalid value and the eventual "USD allows up to 2 decimal
    // places" rejection had nothing on screen connecting it back to the
    // wallet switch that caused it. `clampAmountInput` (src/lib/money.ts)
    // truncates rather than rejects, matching TransactionForm's identical
    // `handleWalletChange` — the one other place in this codebase a
    // wallet switch can invalidate an already-typed amount.
    if (nextWallet) {
      setAmount((prev) => clampAmountInput(prev, minorUnitFor(nextWallet.currency_code)));
    }
  }

  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="wallet_id" value={walletId} />
      <input type="hidden" name="currency_code" value={currencyCode} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="interval_unit" value={intervalUnit} />
      <input type="hidden" name="category_id" value={categoryId ?? ""} />
      <input type="hidden" name="amount" value={amount} />

      <label className="flex flex-col gap-1">
        <span className="text-sm" style={{ color: "var(--ink-2)" }}>
          Name
        </span>
        <input
          name="name"
          required
          maxLength={60}
          defaultValue={defaults?.name}
          placeholder="Rent"
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
                ref={value === "expense" ? expenseRadioRef : incomeRadioRef}
                type="radio"
                // No `name` — see the component doc comment: submission
                // goes through the hidden `kind` input above, never this
                // native radio's own `checked` property.
                value={value}
                checked={selected}
                onChange={() => handleKindChange(value)}
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

      {lockWallet ? (
        /* No control at all, and no <label> either — same shape as
           WalletForm's locked currency line. The value is still stated,
           and the reason with it, so its absence reads as deliberate. */
        <p className="text-sm" style={{ color: "var(--ink-2)" }}>
          Wallet: <span style={{ color: "var(--ink)" }}>{wallet?.name ?? ""}</span> ({currencyCode}) —
          fixed once a rule exists; the database does not allow moving one between wallets.
        </p>
      ) : (
        <label className="flex flex-col gap-1">
          <span className="text-sm" style={{ color: "var(--ink-2)" }}>
            Wallet
          </span>
          <select
            ref={walletSelectRef}
            // No `name` — see the component doc comment: submission goes
            // through the hidden `wallet_id` input above.
            value={walletId}
            onChange={(e) => handleWalletChange(e.target.value)}
            aria-describedby={errorId}
            aria-invalid={state.field === "wallet_id" ? true : undefined}
            className={`rounded-md border px-3 py-2 ${FOCUS_RING}`}
            style={{ borderColor: "var(--ink-2)" }}
          >
            {wallets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.currency_code})
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-sm" style={{ color: "var(--ink-2)" }}>
          Amount ({currencyCode})
        </span>
        <input
          ref={amountInputRef}
          // No `name` — submission goes through the hidden `amount` input
          // above (see the state declaration's own comment for why).
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          aria-describedby={errorId}
          aria-invalid={state.field === "amount" ? true : undefined}
          className={`rounded-md border px-3 py-2 ${FOCUS_RING}`}
          style={{ borderColor: "var(--ink-2)" }}
        />
        <span className="text-xs" style={{ color: "var(--ink-2)" }}>
          {minorUnit === 0
            ? `${currencyCode} has no decimal places — enter a whole number.`
            : `${currencyCode} allows up to ${minorUnit} decimal place${minorUnit === 1 ? "" : "s"}.`}{" "}
          Always a positive amount — expense or income is set by Type above.
        </span>
      </label>

      <div>
        <p className="mb-1 text-sm" style={{ color: "var(--ink-2)" }}>
          Category
        </p>
        {/* CategoryPicker renders plain `<button type="button">`s, not a
            native radio/select — nothing here has a `checked`/`value`
            PROPERTY for React DOM's own form-reset behaviour to desync, so
            (unlike `kind`/`interval_unit`/`wallet_id` above) this needs no
            ref-based correction effect. The hidden `category_id` input
            above still carries the value: CategoryPicker itself submits
            nothing on its own. */}
        <CategoryPicker
          categories={walletCategories}
          kind={kind}
          value={categoryId}
          onChange={(c) => setCategoryId(c.id)}
          walletId={walletId}
        />
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-sm" style={{ color: "var(--ink-2)" }}>
          Repeats
        </span>
        <select
          ref={intervalSelectRef}
          // No `name` — see the component doc comment: submission goes
          // through the hidden `interval_unit` input above.
          value={intervalUnit}
          onChange={(e) => setIntervalUnit(e.target.value as RecurInterval)}
          aria-describedby={errorId}
          aria-invalid={state.field === "interval_unit" ? true : undefined}
          className={`rounded-md border px-3 py-2 ${FOCUS_RING}`}
          style={{ borderColor: "var(--ink-2)" }}
        >
          {RECUR_INTERVALS.map((i) => (
            <option key={i} value={i}>
              {INTERVAL_LABELS[i]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm" style={{ color: "var(--ink-2)" }}>
          Starts on
        </span>
        <input
          type="date"
          name="anchor_on"
          required
          defaultValue={defaults?.anchor_on}
          aria-describedby={errorId}
          aria-invalid={state.field === "anchor_on" ? true : undefined}
          className={`rounded-md border px-3 py-2 ${FOCUS_RING}`}
          style={{ borderColor: "var(--ink-2)" }}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm" style={{ color: "var(--ink-2)" }}>
          Ends on (optional)
        </span>
        {/* Plain named, uncontrolled input — text/date controls have no
            `checked`/`value` PROPERTY reset bug (WalletForm's own `name`
            and `starting_balance` fields are identically plain), so no
            hidden-input routing is needed here. An empty value posts "",
            which `recurringInput` treats as "no end date", not invalid —
            never omit this field entirely. */}
        <input
          type="date"
          name="ends_on"
          defaultValue={defaults?.ends_on ?? ""}
          aria-describedby={errorId}
          aria-invalid={state.field === "ends_on" ? true : undefined}
          className={`rounded-md border px-3 py-2 ${FOCUS_RING}`}
          style={{ borderColor: "var(--ink-2)" }}
        />
      </label>

      {/* Always mounted, not conditionally rendered — see the useEffect
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
