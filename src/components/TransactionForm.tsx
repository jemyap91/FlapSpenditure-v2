"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { TrendingDown, TrendingUp, ArrowRightLeft } from "lucide-react";
import { AmountKeypad } from "./AmountKeypad";
import { CategoryPicker, type Category } from "./CategoryPicker";
import {
  createTransaction,
  createTransfer,
  updateTransaction,
  updateTransfer,
} from "@/server/actions/transactions";
import { appendDigit, clampAmountInput, minorUnitFor, parseAmountInput } from "@/lib/money";
import { parseOrigin } from "@/lib/origin";
import { todayLocalDate } from "@/lib/today";

type Wallet = { id: string; name: string; currency_code: string };
type Kind = "expense" | "income" | "transfer";

/**
 * Task 6 (editable-transactions plan): what edit mode seeds a non-transfer
 * row from. `updateTransaction` (src/server/actions/transactions.ts)
 * refuses a transfer's id outright and `transactionEditInput`
 * (src/lib/validation/transaction.ts) has no `wallet_id`/`kind` fields at
 * all — neither is editable, so neither is carried here either. `walletId`
 * IS carried, but only to resolve this row's fixed wallet/currency for
 * display and to filter `categories` down to the right wallet+kind — it is
 * never sent back to `updateTransaction`, which derives the real one from
 * the database row itself.
 */
export type EditTransactionSeed = {
  kind: "expense" | "income";
  id: string;
  walletId: string;
  /** Keypad-format string (see AmountKeypad's own doc comment) — the same
   *  representation `formatAmountInput` (src/lib/money.ts) produces, not
   *  minor units. */
  amount: string;
  categoryId: string | null;
  occurredOn: string;
  note: string;
  merchant: string;
};

/**
 * What edit mode seeds a transfer from. Two wallets and two amounts —
 * `amountOut`/`amountIn`, mirroring `transferEditInput` and
 * `update_transfer_pair` exactly (see that schema's own doc comment): a
 * cross-currency transfer's two legs are genuinely different amounts in
 * different currencies, and a same-currency one must additionally balance.
 * `fromWalletId`/`toWalletId` are, like `walletId` above, for display and
 * currency lookup only — `updateTransfer` never receives them.
 */
export type EditTransferSeed = {
  kind: "transfer";
  transferId: string;
  fromWalletId: string;
  toWalletId: string;
  amountOut: string;
  amountIn: string;
  occurredOn: string;
  note: string;
  merchant: string;
};

export type EditSeed = EditTransactionSeed | EditTransferSeed;

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
 *
 * ## EDIT MODE (Task 6, editable-transactions plan)
 *
 * `mode="edit"` plus an `edit` seed (`EditSeed` above) is this same
 * component's edit path, the shape `WalletForm.tsx`'s own doc comment
 * anticipates ("defaults + a lock prop"). Because a transaction's wallet
 * and kind are BOTH fixed for its whole life — `updateTransaction` refuses
 * a transfer id outright, and neither `transactionEditInput` nor
 * `transferEditInput` even has a `wallet_id`/`kind` field to carry one — the
 * wallet-picking `<select>`, the "To" `<select>`, and the kind radiogroup
 * are not rendered AT ALL in edit mode, replaced by stated text. This
 * mirrors `WalletForm`'s own `lockCurrency` rule exactly (that component's
 * doc comment): "a control that can never succeed is absent, not
 * disabled," the same rule `TransactionList.tsx`'s `RowIcon` and
 * `WalletList.tsx`'s per-owner Archive already follow.
 *
 * Which server action gets called is dispatched on `edit.kind`:
 * `updateTransaction` for an expense/income row, `updateTransfer` for a
 * transfer — mirroring exactly how `updateTransaction` itself refuses a
 * transfer id rather than silently mishandling it. Both return
 * `MutationResult = { ok: true } | { error: string }` and never throw
 * (`transactions.ts`'s own file doc comment on why: an uncaught throw
 * inside a Server Function is masked to an opaque digest in production).
 *
 * A transfer's amount is TWO fields (`amountOut`/`amountIn`), not one,
 * whenever its two legs' currencies differ — `crossCurrency` below already
 * governs exactly this for the CREATE path (a cross-currency transfer
 * legitimately sends and receives different amounts), so edit mode reuses
 * that identical boolean rather than inventing a second one. When the legs
 * share a currency, only the source `AmountKeypad` renders and its single
 * value is sent as BOTH `amount_out` and `amount_in` on submit — the same
 * "one number typed twice" convenience `createTransfer`'s own `amount_in`
 * omission already gives the create path, preserved here for a same-
 * currency edit rather than forcing a second, redundant field.
 *
 * ## Why this does NOT need `WalletForm`'s hidden-input workaround
 *
 * `WalletForm`'s own doc comment on its hidden `kind`/`currency_code`
 * inputs is real: read before adding any `<select>`/radio here, per this
 * task's brief. But the bug it works around is specific to `<form
 * action={fn}>` (traced in that comment to `requestFormReset$1`, gated on
 * `"function" === typeof action` read off the `<form>` element's own
 * `action` prop) — and this component's doc comment ABOVE this one already
 * establishes that this `<form>` has no `action` prop at all in either mode:
 * submission is a plain `onSubmit` handler calling `updateTransaction`/
 * `updateTransfer` directly inside `useTransition`, exactly like the create
 * path already does for `createTransaction`/`createTransfer` (neither takes
 * `FormData`, so neither could be bound as `<form action>` in the first
 * place). Every visible control in edit mode is consequently an ordinary
 * controlled React input with no native form-reset event to desync from —
 * confirmed by this file's own pre-existing reasoning, not a new claim. And
 * concretely, edit mode adds no NEW `<select>`/radio at all: the two
 * controls `WalletForm`'s bug actually hit (a `<select>`, a radio group) are
 * exactly the ones edit mode REMOVES (wallet, kind), replaced by inert
 * stated text with no live DOM property for a reset to desync in the first
 * place. The brief's instruction to route this form's controls through
 * hidden inputs the way `WalletForm` does does not apply here — this is
 * this task's own found defect in its brief (see this task's report).
 */
export function TransactionForm(
  props:
    | {
        mode?: "create";
        wallets: Wallet[];
        categories: Category[];
        defaultWalletId: string;
        /**
         * The `?from` search param, threaded down unmodified from the page —
         * an origin IDENTIFIER (e.g. `wallet:<uuid>`), NOT a path or URL, and
         * untrusted (it comes straight off the query string). `parseOrigin`
         * (`@/lib/origin`) is the only thing allowed to turn it into a
         * navigation target; see the redirect below.
         */
        from?: string | null;
      }
    | {
        mode: "edit";
        wallets: Wallet[];
        categories: Category[];
        /** The row (or transfer pair) being edited. See `EditSeed` above. */
        edit: EditSeed;
      },
) {
  const router = useRouter();
  const { wallets, categories } = props;
  const edit = props.mode === "edit" ? props.edit : undefined;
  // Only meaningful in create mode — see the props union above. Read only
  // from branches already known (by that same union) to be in create mode.
  const defaultWalletId = props.mode === "edit" ? undefined : props.defaultWalletId;
  const from = props.mode === "edit" ? undefined : props.from;

  // Kind is fixed for the life of an edited row (see the component doc
  // comment above) — `createKind` is the CREATE path's own selectable
  // state, and `kind` is what every other line in this component reads,
  // resolving to the immutable `edit.kind` whenever one was supplied.
  const [createKind, setCreateKind] = useState<Kind>("expense");
  const kind: Kind = edit ? edit.kind : createKind;
  const [amount, setAmount] = useState(() => {
    if (!edit) return "0";
    return edit.kind === "transfer" ? edit.amountOut : edit.amount;
  });
  const [walletId, setWalletId] = useState(() => {
    if (!edit) return defaultWalletId!;
    return edit.kind === "transfer" ? edit.fromWalletId : edit.walletId;
  });
  const [toWalletId, setToWalletId] = useState(() => {
    if (!edit) return wallets.find((w) => w.id !== defaultWalletId)?.id ?? "";
    return edit.kind === "transfer" ? edit.toWalletId : "";
  });
  const [amountIn, setAmountIn] = useState(() => (edit?.kind === "transfer" ? edit.amountIn : "0"));
  const [category, setCategory] = useState<Category | null>(() =>
    edit && edit.kind !== "transfer" ? (categories.find((c) => c.id === edit.categoryId) ?? null) : null,
  );
  const [date, setDate] = useState(() => (edit ? edit.occurredOn : todayLocalDate()));
  /** The transactions table's own `note` column — what a user types to name
   *  a transaction, typically a merchant. Optional on both the expense and
   *  the transfer path; the actions coerce "" to null on write. */
  const [note, setNote] = useState(() => (edit ? edit.note : ""));
  /** The transactions table's own `merchant` column (Task 1 of this plan) —
   *  editable, but not creatable: `transactionInput`/`transferInput` (the
   *  CREATE schemas) have no `merchant` field at all, only their `...Edit`
   *  counterparts do, so this control renders only in edit mode (below). */
  const [merchant, setMerchant] = useState(() => (edit ? edit.merchant : ""));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const errorId = useId();
  const amountLabelId = useId();
  const destLabelId = useId();
  const errorRef = useRef<HTMLParagraphElement>(null);
  const amountGroupRef = useRef<HTMLDivElement>(null);

  // Same technique as login-form.tsx / onboarding-form.tsx: a
  // conditionally-mounted role="alert" doesn't announce reliably across
  // screen-reader/browser pairs, but mounting an always-present node and
  // moving focus to it does. This paragraph is rendered unconditionally
  // below; only its text and focus change.
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  // Spec §5.1: "the screen opens with the amount focused and zeroed" — a
  // keyboard user must be able to type digits the instant the page loads,
  // without tabbing past the kind radiogroup first. AmountKeypad's own
  // <output> can never be a focus target (it's non-editable by design —
  // see this task's report for why that's the right call for the "OS
  // keyboard never appears" requirement), so the focus target is this
  // wrapping group div instead: tabIndex={-1} makes it programmatically
  // focusable without adding a new stop to the NORMAL Tab order (the
  // keypad's own buttons are already independently tabbable). Empty deps:
  // this must fire once on mount only, not every time `kind` or anything
  // else changes later — re-focusing here after the user has deliberately
  // moved focus elsewhere (e.g. into the category search box) would be a
  // regression, not a fix.
  useEffect(() => {
    amountGroupRef.current?.focus();
  }, []);

  // Invariant: page.tsx only renders this component when `wallets.length
  // >= 1` (it redirects to /onboarding otherwise), and `walletId` only ever
  // holds a value drawn from `wallets` (the initial prop, or a later
  // selection restricted to that same list by the <select> below) — so
  // this lookup cannot actually miss. The fallback to `wallets[0]` is a
  // type-safety net, not a reachable branch.
  const wallet = wallets.find((w) => w.id === walletId) ?? wallets[0]!;
  const toWallet = wallets.find((w) => w.id === toWalletId);
  // Categories belong to a wallet (0008), and the wallet chip can change
  // after mount — so filter on every render rather than snapshotting.
  const walletCategories = categories.filter((c) => c.wallet_id === walletId);
  const canTransfer = wallets.length >= 2;
  const crossCurrency =
    kind === "transfer" && !!toWallet && toWallet.currency_code !== wallet.currency_code;
  const visibleKinds = canTransfer ? KIND_META : KIND_META.filter((k) => k.value !== "transfer");

  // Physical-keyboard digit entry for the primary amount, routed through
  // the exact same pure functions (appendDigit/parseAmountInput from
  // src/lib/money.ts) AmountKeypad's own press()/backspace() use internally
  // — not a reimplementation of the precision/overflow rules, just a
  // second caller of the single source of truth for them. This exists
  // because AmountKeypad exposes no imperative API for a physical
  // keydown (it is a "use client" leaf with `value`/`onChange` only, and
  // per this task's brief it is not to be modified without a real defect
  // — there isn't one here, the gap is that nothing outside it drives
  // keyboard input into it), and the effect above needs a real handler to
  // focus onto for "type immediately on load" to mean anything.
  function handleAmountKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const minorUnit = minorUnitFor(wallet.currency_code);
    if (e.key === "Backspace") {
      e.preventDefault();
      setError(null);
      setAmount((prev) => {
        const current = prev === "" ? "0" : prev;
        return current.length <= 1 ? "0" : current.slice(0, -1);
      });
      return;
    }
    if (e.key === "." || /^\d$/.test(e.key)) {
      e.preventDefault();
      setError(null);
      setAmount((prev) => {
        const current = prev === "" ? "0" : prev;
        const candidate = appendDigit(current, e.key, minorUnit);
        if (candidate === current) return current;
        try {
          parseAmountInput(candidate, minorUnit);
        } catch {
          return current;
        }
        return candidate;
      });
    }
  }

  function handleKindChange(next: Kind) {
    setCreateKind(next);
    // A transfer has no category; switching between expense/income also
    // clears it, since the two kinds draw from disjoint category lists
    // (CategoryPicker filters by `kind`) and a stale selection from the
    // other kind would silently fail the server's kind-match check.
    setCategory(null);
    setError(null);
  }

  function handleWalletChange(next: string) {
    const nextWallet = wallets.find((w) => w.id === next);
    setWalletId(next);
    setError(null);
    // A category belongs to the wallet it was created in (0008), and the
    // composite FK `transactions_category_same_wallet` means a transaction
    // can never reference a category from a different wallet — the
    // database would reject it. Clearing here is what stops the user from
    // ever getting that far: a category chosen under the OLD wallet must
    // not silently carry over to the new one.
    setCategory(null);
    // The wallet just changed currency (possibly to a different
    // `minorUnit`) — an amount already typed under the OLD currency's
    // precision can be over-precise for the new one (e.g. "1.505" typed
    // against KWD's 3 decimals is invalid for USD's 2). Clamp it, the same
    // truncate-not-reject rule parseAmountInput itself already applies to
    // an over-precise fraction, so the displayed preview and the state
    // driving submission never disagree after a currency change.
    if (nextWallet) {
      setAmount((prev) => clampAmountInput(prev, minorUnitFor(nextWallet.currency_code)));
    }
    // The destination <select> below already excludes whatever wallet is
    // currently selected as the source, so a user can never pick the same
    // wallet on both sides *through that control*. But changing the SOURCE
    // to match the CURRENT destination needs its own fixup, or "from" and
    // "to" would silently end up equal until the user happens to touch the
    // destination select too.
    if (next === toWalletId) {
      const fallback = wallets.find((w) => w.id !== next);
      setToWalletId(fallback?.id ?? "");
      if (fallback) {
        setAmountIn((prev) => clampAmountInput(prev, minorUnitFor(fallback.currency_code)));
      }
    }
  }

  function handleToWalletChange(next: string) {
    const nextWallet = wallets.find((w) => w.id === next);
    setToWalletId(next);
    setError(null);
    // Same reasoning as handleWalletChange above, for the destination leg
    // of a cross-currency transfer: the destination amount already typed
    // may be over-precise for the newly-selected destination currency.
    if (nextWallet) {
      setAmountIn((prev) => clampAmountInput(prev, minorUnitFor(nextWallet.currency_code)));
    }
  }

  function handleDateChange(next: string) {
    setDate(next);
    setError(null);
  }

  function handleCategoryChange(next: Category) {
    setCategory(next);
    setError(null);
  }

  function handleAmountChange(next: string) {
    setAmount(next);
    setError(null);
  }

  function handleAmountInChange(next: string) {
    setAmountIn(next);
    setError(null);
  }

  function handleMerchantChange(next: string) {
    setMerchant(next);
    setError(null);
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

    // Dispatch on `edit.kind`, not on the generic `kind` alone — mirroring
    // `updateTransaction`'s own refusal of a transfer id (transactions.ts)
    // rather than risking this component silently calling the wrong action.
    // `updateTransaction`/`updateTransfer` both return `MutationResult =
    // { ok: true } | { error: string }` and never throw.
    if (edit) {
      start(async () => {
        const res =
          edit.kind === "transfer"
            ? await updateTransfer({
                transfer_id: edit.transferId,
                amount_out: amount,
                // Same-currency: one field feeds both legs, since they must
                // balance anyway — see the component doc comment above.
                amount_in: crossCurrency ? amountIn : amount,
                occurred_on: date,
                note,
                merchant,
              })
            : await updateTransaction({
                id: edit.id,
                amount,
                // `category` seeds from `edit.categoryId` and CategoryPicker
                // can change or clear it — `category_id` is nullable on
                // `transactionEditInput` (clearing a category is a
                // legitimate edit, unlike creation's required category), so
                // `null` here is a real, intentional value, not a bug.
                category_id: category?.id ?? null,
                occurred_on: date,
                note,
                merchant,
              });

        if ("error" in res) {
          setError(res.error);
          return;
        }

        // No `from`/`parseOrigin` return trip in edit mode (unlike the
        // create path below) — out of this task's scope, see this task's
        // report. `/transactions` is always a safe landing spot: it is the
        // same fallback destination `parseOrigin` itself resolves to for
        // every input it doesn't recognise.
        router.push("/transactions");
      });
      return;
    }

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
              note,
            })
          : await createTransaction({
              wallet_id: walletId,
              kind,
              amount,
              // Non-null: the early return above guarantees `category` is
              // set whenever `kind !== "transfer"` reaches this branch.
              category_id: category!.id,
              occurred_on: date,
              note,
            });

      if ("error" in res) {
        setError(res.error);
        return;
      }

      // Task 4 (wallet-detail plan): this used to be a hardcoded
      // router.push("/transactions") — /transactions (Task 20) is this
      // app's ledger review screen, and navigating there gave the user
      // real, immediate confirmation their save worked. Now that a wallet's
      // own detail screen can also launch this form (its FAB), the user
      // should land back where they came from instead of always being
      // dumped on the global list.
      //
      // `parseOrigin` (@/lib/origin) is the ONLY thing that may turn `from`
      // into a navigation target — it validates the shape, matches a known
      // origin kind, and BUILDS the path itself; it never returns its
      // input. `from` is user-supplied (a query param), so passing it to
      // router.push directly, or reimplementing this parsing here, would
      // reopen the exact open-redirect this function exists to close.
      // Absent or unrecognised `from` (including no `from` at all, or an
      // attacker-supplied absolute URL) falls back to "/transactions" —
      // the same destination this always used, unchanged.
      router.push(parseOrigin(from));
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      onKeyDown={handleFormKeyDown}
      noValidate
      // No min-h-dvh here: the (app) shell (src/app/(app)/layout.tsx) is
      // already min-h-dvh, and its <main> carries pb-20 on mobile
      // specifically to clear the fixed TabBar — stacking a SECOND
      // min-h-dvh inside that padded area made this form's own content
      // (including mt-auto's Save button) render dvh + 80px tall, pushing
      // Save under the TabBar at initial paint (confirmed: needed ~80px of
      // scroll to reach it). That directly broke spec §5.1's "Save is
      // always reachable." This form's height now comes from its own
      // content, which is what mt-auto needs to push Save down when there
      // IS extra room, without ever double-counting the shell's own.
      className="mx-auto flex max-w-md flex-col gap-4 p-4"
    >
      {/* Kind is fixed for the life of an existing row (component doc
          comment above) — absent in edit mode, not a disabled radiogroup a
          click could never change. */}
      {edit ? (
        <p className="text-sm" style={{ color: "var(--ink-2)" }}>
          {edit.kind === "transfer" ? "Transfer" : edit.kind === "expense" ? "Expense" : "Income"} — the
          type of a transaction can’t be changed once it’s saved.
        </p>
      ) : (
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
      )}

      {/* A transfer edit updates both legs together, atomically, via the
          `update_transfer_pair` RPC (`updateTransfer`'s own doc comment) —
          stated up front so a user editing one leg's amount/date/note isn't
          surprised the OTHER leg (a different wallet's ledger) changes too. */}
      {edit?.kind === "transfer" && (
        <p className="text-sm" style={{ color: "var(--ink-2)" }}>
          Editing both legs of this transfer — the source and destination wallets are updated together.
        </p>
      )}

      <div>
        <p id={amountLabelId} className="mb-1 text-sm" style={{ color: "var(--ink-2)" }}>
          {kind === "transfer"
            ? // A same-currency EDIT renders only this one field (see the
              // component doc comment: it feeds both legs on submit), so
              // "You send" — worded for the two-field cross-currency case —
              // would misdescribe it as one-directional. Create mode's
              // wording is untouched: `edit` is undefined there, so this
              // falls through to the original text exactly as before.
              edit && !crossCurrency
              ? `Amount (${wallet.currency_code})`
              : `You send (${wallet.currency_code})`
            : "Amount"}
        </p>
        {/* AmountKeypad's own <output> already carries aria-label="Amount"
            and aria-live="polite" internally (it is not modified here — see
            this task's report for why touching it wasn't warranted). This
            wrapping group gives a second, distinguishing accessible name
            for when the destination keypad below is also on screen, since
            two AmountKeypad instances would otherwise both announce
            "Amount" with no way to tell them apart from context alone.

            tabIndex={-1} + the mount-effect above make this the initial
            focus target (spec §5.1: "opens with the amount focused") —
            programmatically focusable without adding a manual Tab stop,
            since the keypad's own buttons are already tabbable on their
            own. onKeyDown routes a physical digit/./Backspace press into
            the same money.ts functions AmountKeypad itself uses. */}
        <div
          ref={amountGroupRef}
          role="group"
          aria-labelledby={amountLabelId}
          tabIndex={-1}
          onKeyDown={handleAmountKeyDown}
        >
          <AmountKeypad value={amount} onChange={handleAmountChange} currencyCode={wallet.currency_code} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* A transfer has no category, so the chip is REMOVED, not
            disabled — a greyed-out control invites a click that can never
            succeed (spec §5.1). */}
        {kind !== "transfer" && (
          <span className={CHIP_BORDER} style={{ borderColor: "var(--ink-2)", color: "var(--ink)" }}>
            {category?.name ?? "Choose category"}
          </span>
        )}
        {edit ? (
          // Wallet(s) are fixed for the life of a row — stated as text, not
          // a `<select>` a click could never actually change (component doc
          // comment above). No `<label>`: there is no control to label.
          <p className="text-sm" style={{ color: "var(--ink-2)" }}>
            {edit.kind === "transfer" ? (
              <>
                From <span style={{ color: "var(--ink)" }}>{wallet.name}</span> to{" "}
                <span style={{ color: "var(--ink)" }}>{toWallet?.name}</span>
              </>
            ) : (
              <>
                Wallet: <span style={{ color: "var(--ink)" }}>{wallet.name}</span>
              </>
            )}
          </p>
        ) : (
          <>
            <label className="flex items-center gap-1 text-sm" style={{ color: "var(--ink-2)" }}>
              {/* VISIBLE for a transfer. These were sr-only, so a screen
                  reader announced "From wallet"/"To wallet" while a sighted
                  user saw two identical dropdowns side by side with nothing
                  to tell them apart — and on a transfer, choosing them the
                  wrong way round sends money in the wrong direction. Left
                  sr-only for a non-transfer, where there is only one select
                  and no ambiguity to resolve. */}
              <span className={kind === "transfer" ? "text-sm" : "sr-only"} style={{ color: "var(--ink-2)" }}>
                {kind === "transfer" ? "From" : "Wallet"}
              </span>
              <select
                value={walletId}
                onChange={(e) => handleWalletChange(e.target.value)}
                aria-describedby={errorId}
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
                <span className="text-sm" style={{ color: "var(--ink-2)" }}>
                  To
                </span>
                <select
                  value={toWalletId}
                  onChange={(e) => handleToWalletChange(e.target.value)}
                  aria-describedby={errorId}
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
          </>
        )}
        <label className="flex items-center gap-1 text-sm" style={{ color: "var(--ink-2)" }}>
          <span className="sr-only">Date</span>
          <input
            type="date"
            value={date}
            onChange={(e) => handleDateChange(e.target.value)}
            aria-describedby={errorId}
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
            <AmountKeypad value={amountIn} onChange={handleAmountInChange} currencyCode={toWallet.currency_code} />
          </div>
        </div>
      )}

      {kind !== "transfer" && (
        <CategoryPicker
          categories={walletCategories}
          kind={kind}
          value={category?.id ?? null}
          onChange={handleCategoryChange}
          walletId={walletId}
        />
      )}

      {/* Deliberately BELOW the keypad and the category picker, not beside
          the amount. This is the one control on this screen that raises the
          OS keyboard — the whole reason AmountKeypad exists is that the
          amount must not (spec §5.1: standing at a till). Putting it last
          keeps the amount-first flow intact and makes the keyboard strictly
          opt-in: it appears only once the user taps this field.

          `maxLength` matches the column's own CHECK (`length(note) <= 280`)
          and the zod schema's `.max(280)`, so the limit is enforced at the
          input, at the schema and in Postgres rather than only at the last
          of the three. */}
      <label className="flex flex-col gap-1">
        <span className="text-sm" style={{ color: "var(--ink-2)" }}>
          Note
        </span>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={280}
          placeholder="Merchant or description"
          autoComplete="off"
          aria-describedby={errorId}
          className={`rounded-md border px-3 py-2 ${FOCUS_RING}`}
          style={{ borderColor: "var(--ink-2)", background: "var(--surface)", color: "var(--ink)" }}
        />
      </label>

      {/* Edit-only (component doc comment above): `transactionInput`/
          `transferInput` (the CREATE schemas) have no `merchant` field at
          all — only their `...Edit` counterparts do — so there is nothing
          for this control to submit in create mode, and it does not render
          there. `maxLength` matches `editableText(120, ...)`
          (src/lib/validation/transaction.ts) and the column's own
          `length(merchant) <= 120` CHECK, the same three-layer-match
          discipline the Note field's own comment states for its 280. */}
      {edit && (
        <label className="flex flex-col gap-1">
          <span className="text-sm" style={{ color: "var(--ink-2)" }}>
            Merchant
          </span>
          <input
            value={merchant}
            onChange={(e) => handleMerchantChange(e.target.value)}
            maxLength={120}
            placeholder="Who the money went to or came from"
            autoComplete="off"
            aria-describedby={errorId}
            className={`rounded-md border px-3 py-2 ${FOCUS_RING}`}
            style={{ borderColor: "var(--ink-2)", background: "var(--surface)", color: "var(--ink)" }}
          />
        </label>
      )}

      {/* Always mounted, not conditionally rendered — see the useEffect
          above for why. Empty when there's nothing to say. */}
      <p ref={errorRef} id={errorId} role="alert" tabIndex={-1} style={{ color: "var(--neg)" }}>
        {error}
      </p>

      {/*
        `sticky`, not just `mt-auto` — dropping min-h-dvh (see the <form>'s
        own className comment above) fixed the DOUBLE min-height bug, but
        measured directly (390x844 viewport, this task's real content: kind
        chips + AmountKeypad + wallet/date chips + CategoryPicker's full
        category list): the genuine, un-doubled content is ~1088px tall —
        still taller than an 844px phone screen on its own, entirely from
        AmountKeypad and CategoryPicker's own sizing (neither modified here,
        per this task's scope). `mt-auto` alone only pushes Save to the
        bottom of a container that's SHORTER than the viewport; it does
        nothing once content overflows, which is exactly the case that
        matters here. `sticky` keeps Save pinned `bottom-20` (80px, the
        exact height TabBar reserves via `<main>`'s own `pb-20` in
        src/app/(app)/layout.tsx — so Save sits flush above TabBar, never
        under or over it) above the viewport bottom regardless of how tall
        the category list grows, on this wallet or a future one with many
        more categories. `md:bottom-0`: no TabBar exists at that
        breakpoint, matching `pb-20 md:pb-0`'s own breakpoint exactly.
      */}
      <button
        type="submit"
        disabled={pending}
        className={`sticky bottom-20 mt-auto rounded-lg py-4 text-lg font-medium disabled:opacity-60 md:bottom-0 ${FOCUS_RING}`}
        style={{ background: "var(--cat-1)", color: "var(--surface)" }}
      >
        {pending ? "Saving…" : edit ? "Save changes" : "Save"}
      </button>
    </form>
  );
}
