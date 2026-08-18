"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { TrendingDown, TrendingUp, ArrowRightLeft } from "lucide-react";
import { AmountKeypad } from "./AmountKeypad";
import { CategoryPicker, type Category } from "./CategoryPicker";
import { createTransaction, createTransfer } from "@/server/actions/transactions";

type Wallet = { id: string; name: string; currency_code: string };
type Kind = "expense" | "income" | "transfer";

const KIND_META = [
  { value: "expense", label: "Expense", Icon: TrendingDown },
  { value: "income", label: "Income", Icon: TrendingUp },
  { value: "transfer", label: "Transfer", Icon: ArrowRightLeft },
] as const satisfies readonly { value: Kind; label: string; Icon: typeof TrendingDown }[];

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

const CHIP_BORDER =
  `rounded-full border px-3 py-1 text-sm ${FOCUS_RING}`;

/**
 * Task 19's add-transaction screen — spec §5.1's "amount-first" flow (the
 * amount opens focused/zeroed above a keypad) plus §5.3's inline
 * category-creation case (create a missing category without losing the
 * amount already typed). Client Component; the route (page.tsx) stays a
 * Server Component that only fetches wallets/categories, per
 * node_modules/next/dist/docs/01-app/01-getting-started/
 * 05-server-and-client-components.md's composition pattern (a Server
 * Component passing serializable data as props to a Client Component leaf).
 *
 * ## Why this form does NOT need onboarding-form.tsx's hidden-input /
 * ref-correction pattern
 *
 * onboarding-form.tsx hit a real bug: React DOM's `<form action={fn}>`
 * handling performs a native-style reset of uncontrolled DOM properties
 * (`checked`, `<select>.value`) on every dispatch, which desyncs those
 * properties from React's own tracked state without going through React's
 * property setter (traced to `startHostTransition` -> `requestFormReset$1`
 * -> `HTMLFormElement.prototype.reset()` in
 * node_modules/react-dom/cjs/react-dom-client.development.js). Reading that
 * source (search `startHostTransition(` in that file) shows the reset is
 * gated on `"function" === typeof action`, where `action` is read from the
 * `<form>` element's own `action` prop (`extractEvents$1`,
 * `coerceFormActionProp`) — it is specific to `<form action={fn}>`, not to
 * "any form with a transition in flight."
 *
 * `createTransaction`/`createTransfer` take a typed object, not `FormData`
 * — they cannot be bound as a form's `action` in the first place. This
 * form's `<form>` below therefore has NO `action` prop at all; submission
 * goes through a plain `onSubmit` handler that reads amount/kind/wallet/
 * category/date straight from this component's own `useState` and calls
 * the Server Functions directly inside `startTransition` (via
 * `useTransition`). Since the DOM form's `action` prop is never set, the
 * `"function" === typeof action` gate above is always false and
 * `requestFormReset$1` is never reached — confirmed by reading
 * `extractEvents$1`'s two branches, both of which require a non-null
 * function-typed `action` before touching form-reset machinery. Every
 * visible control here is consequently a completely ordinary React
 * controlled input (`value=`/`checked=`, no hidden mirror fields needed):
 * there is no native reset event for them to desync from. This was
 * additionally verified live — see this task's report for the archived-
 * category rejection test, which confirms every control still reflects
 * exactly what the user chose after a rejected submit.
 */
export function TransactionForm({
  wallets,
  categories,
  defaultWalletId,
}: {
  wallets: Wallet[];
  categories: Category[];
  defaultWalletId: string;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>("expense");
  const [amount, setAmount] = useState("0");
  const [walletId, setWalletId] = useState(defaultWalletId);
  const [toWalletId, setToWalletId] = useState(
    () => wallets.find((w) => w.id !== defaultWalletId)?.id ?? "",
  );
  const [amountIn, setAmountIn] = useState("0");
  const [category, setCategory] = useState<Category | null>(null);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const errorId = useId();
  const amountLabelId = useId();
  const destLabelId = useId();
  const errorRef = useRef<HTMLParagraphElement>(null);

  // Same technique as login-form.tsx / onboarding-form.tsx: a
  // conditionally-mounted role="alert" doesn't announce reliably across
  // screen-reader/browser pairs, but mounting an always-present node and
  // moving focus to it does. This paragraph is rendered unconditionally
  // below; only its text and focus change.
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  // Invariant: page.tsx only renders this component when `wallets.length
  // >= 1` (it redirects to /onboarding otherwise), and `walletId` only ever
  // holds a value drawn from `wallets` (the initial prop, or a later
  // selection restricted to that same list by the <select> below) — so
  // this lookup cannot actually miss. The fallback to `wallets[0]` is a
  // type-safety net, not a reachable branch.
  const wallet = wallets.find((w) => w.id === walletId) ?? wallets[0]!;
  const toWallet = wallets.find((w) => w.id === toWalletId);
  const canTransfer = wallets.length >= 2;
  const crossCurrency =
    kind === "transfer" && !!toWallet && toWallet.currency_code !== wallet.currency_code;
  const visibleKinds = canTransfer ? KIND_META : KIND_META.filter((k) => k.value !== "transfer");

  function handleKindChange(next: Kind) {
    setKind(next);
    // A transfer has no category; switching between expense/income also
    // clears it, since the two kinds draw from disjoint category lists
    // (CategoryPicker filters by `kind`) and a stale selection from the
    // other kind would silently fail the server's kind-match check.
    setCategory(null);
    setError(null);
  }

  function handleWalletChange(next: string) {
    setWalletId(next);
    // The destination <select> below already excludes whatever wallet is
    // currently selected as the source, so a user can never pick the same
    // wallet on both sides *through that control*. But changing the SOURCE
    // to match the CURRENT destination needs its own fixup, or "from" and
    // "to" would silently end up equal until the user happens to touch the
    // destination select too.
    if (next === toWalletId) {
      setToWalletId(wallets.find((w) => w.id !== next)?.id ?? "");
    }
  }

  function handleFormKeyDown(e: React.KeyboardEvent<HTMLFormElement>) {
    // Native browsers implicitly submit the nearest form when Enter is
    // pressed inside most single-line fields (a <select>, the date input,
    // and — since CategoryPicker's search box lives inside this <form> —
    // its category search input too). That would submit this form the
    // instant someone hits Enter while typing a category name, potentially
    // before an amount or category is actually chosen. Only an explicit
    // click/Enter/Space on the Save button (a real <button>) should submit.
    if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
    }
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    // No `action` prop on this <form> (see the component doc comment above
    // for why) — this is a plain, ordinary controlled-form submit handler.
    e.preventDefault();
    setError(null);

    if (kind !== "transfer" && !category) {
      setError("Choose a category");
      return;
    }

    start(async () => {
      const res =
        kind === "transfer"
          ? await createTransfer({
              from_wallet_id: walletId,
              to_wallet_id: toWalletId,
              amount,
              // Only meaningful (and only sent) for a cross-currency
              // transfer — see createTransfer's own doc comment. Sending
              // "0" here for a same-currency transfer would make the
              // server treat the destination as an explicit zero instead
              // of "same as source," so this must be `undefined`, not a
              // stringified zero, whenever `crossCurrency` is false.
              amount_in: crossCurrency ? amountIn : undefined,
              occurred_on: date,
            })
          : await createTransaction({
              wallet_id: walletId,
              kind,
              amount,
              // Non-null: the early return above guarantees `category` is
              // set whenever `kind !== "transfer"` reaches this branch.
              category_id: category!.id,
              occurred_on: date,
            });

      if ("error" in res) {
        setError(res.error);
        return;
      }

      // /transactions (Task 20) does not exist yet, so this cannot land
      // there without 404ing — redirect to "/" instead, the same
      // post-mutation destination src/server/actions/wallets.ts's
      // createWallet already uses for the identical "nothing to send the
      // user to yet" situation.
      router.push("/");
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      onKeyDown={handleFormKeyDown}
      noValidate
      className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 p-4"
    >
      <fieldset className="flex gap-2" aria-describedby={errorId}>
        <legend className="sr-only">Transaction type</legend>
        {visibleKinds.map(({ value, label, Icon }) => {
          const selected = kind === value;
          return (
            <label key={value} className="flex-1 cursor-pointer">
              <input
                type="radio"
                name="txn-kind"
                value={value}
                checked={selected}
                onChange={() => handleKindChange(value)}
                className="peer sr-only"
              />
              <div
                className={`flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-center text-sm ${FOCUS_RING} peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--cat-1)]`}
                style={{
                  // Same accepted mitigation as Sidebar.tsx's active nav
                  // item and onboarding-form.tsx's Type selector: a
                  // var(--grid) background alone measures 1.29:1 (light) /
                  // 1.24:1 (dark) between selected/unselected, well under
                  // WCAG 1.4.11's 3:1 floor for UI-state contrast. The
                  // var(--cat-1) border (4.34:1 light / 4.18:1 dark against
                  // var(--grid) — same token pair, reused from Sidebar's
                  // own measurement) plus the font-weight change are the
                  // real differentiators; the background is a visual bonus,
                  // not what carries the state.
                  borderColor: selected ? "var(--cat-1)" : "var(--ink-2)",
                  background: selected ? "var(--grid)" : "transparent",
                  color: "var(--ink)",
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

      <div>
        <p id={amountLabelId} className="mb-1 text-sm" style={{ color: "var(--ink-2)" }}>
          {kind === "transfer" ? `You send (${wallet.currency_code})` : "Amount"}
        </p>
        {/* AmountKeypad's own <output> already carries aria-label="Amount"
            and aria-live="polite" internally (it is not modified here — see
            this task's report for why touching it wasn't warranted). This
            wrapping group gives a second, distinguishing accessible name
            for when the destination keypad below is also on screen, since
            two AmountKeypad instances would otherwise both announce
            "Amount" with no way to tell them apart from context alone. */}
        <div role="group" aria-labelledby={amountLabelId}>
          <AmountKeypad value={amount} onChange={setAmount} currencyCode={wallet.currency_code} />
        </div>
      </div>

      <div className="flex flex-wrap gap-2" aria-describedby={errorId}>
        {/* A transfer has no category, so the chip is REMOVED, not
            disabled — a greyed-out control invites a click that can never
            succeed (spec §5.1). */}
        {kind !== "transfer" && (
          <span className={CHIP_BORDER} style={{ borderColor: "var(--ink-2)", color: "var(--ink)" }}>
            {category?.name ?? "Choose category"}
          </span>
        )}
        <label className="flex items-center gap-1 text-sm" style={{ color: "var(--ink-2)" }}>
          <span className="sr-only">{kind === "transfer" ? "From account" : "Account"}</span>
          <select
            value={walletId}
            onChange={(e) => handleWalletChange(e.target.value)}
            className={CHIP_BORDER}
            style={{ borderColor: "var(--ink-2)", color: "var(--ink)" }}
          >
            {wallets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        {kind === "transfer" && (
          <label className="flex items-center gap-1 text-sm" style={{ color: "var(--ink-2)" }}>
            <span className="sr-only">To account</span>
            <select
              value={toWalletId}
              onChange={(e) => setToWalletId(e.target.value)}
              className={CHIP_BORDER}
              style={{ borderColor: "var(--ink-2)", color: "var(--ink)" }}
            >
              {wallets
                .filter((w) => w.id !== walletId)
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label className="flex items-center gap-1 text-sm" style={{ color: "var(--ink-2)" }}>
          <span className="sr-only">Date</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={CHIP_BORDER}
            style={{ borderColor: "var(--ink-2)", color: "var(--ink)" }}
          />
        </label>
      </div>

      {crossCurrency && toWallet && (
        <div>
          <p id={destLabelId} className="mb-1 text-sm" style={{ color: "var(--ink-2)" }}>
            {`They receive (${toWallet.currency_code})`}
          </p>
          <div role="group" aria-labelledby={destLabelId}>
            <AmountKeypad value={amountIn} onChange={setAmountIn} currencyCode={toWallet.currency_code} />
          </div>
        </div>
      )}

      {kind !== "transfer" && (
        <CategoryPicker
          categories={categories}
          kind={kind}
          value={category?.id ?? null}
          onChange={setCategory}
        />
      )}

      {/* Always mounted, not conditionally rendered — see the useEffect
          above for why. Empty when there's nothing to say. */}
      <p ref={errorRef} id={errorId} role="alert" tabIndex={-1} style={{ color: "var(--neg)" }}>
        {error}
      </p>

      <button
        type="submit"
        disabled={pending}
        className={`mt-auto rounded-lg py-4 text-lg font-medium disabled:opacity-60 ${FOCUS_RING}`}
        style={{ background: "var(--cat-1)", color: "var(--surface)" }}
      >
        {pending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
