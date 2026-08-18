"use client";

import { Delete } from "lucide-react";
import { appendDigit, minorUnitFor, formatMoney, parseAmountInput } from "@/lib/money";

const DIGIT_KEYS_1_TO_9 = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

/**
 * A custom on-screen keypad for entering a money amount, for Task 19's
 * add-transaction screen. Deliberately NOT an `<input type="number">` (or
 * any native text input holding the amount) — that would raise the OS
 * keyboard, shifting the layout (spec §5.1's realistic case is standing at
 * a till), and it would also reintroduce the native-form-reset hazard Task
 * 15 hit: React DOM resets native `value`/`checked` on every `<form
 * action>` dispatch without going through React's tracked setter, which
 * desyncs an uncontrolled input from state. This component holds no native
 * input state at all — `value` lives entirely in the parent (Task 19's
 * form), and every key is a `<button type="button">` whose click handler
 * calls `onChange` with a plain string. There is nothing for a form reset
 * to desync.
 *
 * Purely presentational: `value` in, `onChange` out. No Supabase, no
 * Server Action, so a unit test can import this file without `.env.local`.
 *
 * `value` is the amount typed so far, in `appendDigit`'s string format
 * (digits with at most one '.'), NOT minor units — the same representation
 * `parseAmountInput` consumes. The parent owns the state and is expected to
 * initialize it to `"0"`; this component also tolerates `""` (see
 * `currentOrZero` below) so an accidental empty initial value can't reach
 * `appendDigit` and produce a bare `"."` (see the note on that below).
 */
export function AmountKeypad({
  value,
  onChange,
  currencyCode,
}: {
  value: string;
  onChange: (next: string) => void;
  currencyCode: string;
}) {
  const minorUnit = minorUnitFor(currencyCode);
  const zeroDecimal = minorUnit === 0;
  const preview = formatMoney(safeParse(value, minorUnit), currencyCode);

  // appendDigit's '.' branch does `current + "."` with no floor: if `current`
  // were ever "", that literally *is* the bare "." that money.ts's own
  // comment calls unreachable "via appendDigit" — a claim scoped to
  // appendDigit itself, not to every caller. It only holds here because we
  // never feed appendDigit an empty string. The parent is expected to seed
  // `value` with "0", but normalizing defensively at this single call site
  // means a stray "" prop can't produce it either, and it costs nothing.
  const currentOrZero = value === "" ? "0" : value;

  function press(digit: string) {
    const candidate = appendDigit(currentOrZero, digit, minorUnit);
    if (candidate === currentOrZero) {
      // No-op presses still notify the parent (e.g. a decimal point on a
      // zero-decimal currency, or a digit past the currency's precision) —
      // callers that only re-render on a changed value are unaffected, and
      // callers that treat every onChange as "user touched the keypad" get
      // an accurate signal either way.
      onChange(currentOrZero);
      return;
    }
    // appendDigit has no upper bound on length, but real money is a bigint
    // over Number-safe minor units end to end (see money.ts). Rather than
    // hand-roll a digit-count ceiling here — which would be a second,
    // divergent notion of "too big" — reuse parseAmountInput, the same
    // parser the rest of the app trusts, as the gate: if the candidate
    // can't survive a round trip, the keystroke is rejected and the
    // amount holds at the last value that could.
    try {
      parseAmountInput(candidate, minorUnit);
    } catch {
      onChange(currentOrZero);
      return;
    }
    onChange(candidate);
  }

  function backspace() {
    onChange(currentOrZero.length <= 1 ? "0" : currentOrZero.slice(0, -1));
  }

  return (
    <div className="flex flex-col gap-4">
      {/*
        aria-live="polite" announces the full formatted amount ("$12.50")
        on every change, not a stream of individual digit presses — the
        content is always the complete currency string, so what gets
        queued and read out is meaningful on its own even if several
        keystrokes land before the screen reader catches up.
      */}
      <output
        aria-live="polite"
        aria-label="Amount"
        className="block py-6 text-center text-5xl font-semibold tabular-nums"
        style={{ color: "var(--ink)" }}
      >
        {preview}
      </output>
      <div className="grid grid-cols-3 gap-2">
        {DIGIT_KEYS_1_TO_9.map((k) => (
          <NumKey key={k} label={k} onPress={() => press(k)} />
        ))}
        {/*
          The decimal point is meaningless once a currency has no minor
          units (JPY, KRW, VND: minorUnit 0 — appendDigit's own '.' branch
          already refuses to add a dot in that case). Rather than removing
          the key — which would shove "0" sideways and make the grid's
          digit layout inconsistent between currencies — it stays in
          place, marked aria-disabled so assistive tech announces it as
          non-operative, but still clickable: a click is a true no-op
          (appendDigit returns the value unchanged) rather than something
          that needs to be blocked, so there's nothing for a native
          `disabled` attribute to protect and no reason to pull it out of
          the tab order.
        */}
        <NumKey
          label="."
          onPress={() => press(".")}
          disabled={zeroDecimal}
        />
        <NumKey label="0" onPress={() => press("0")} />
        <button
          type="button"
          onClick={backspace}
          aria-label="Delete"
          className={`min-h-12 rounded-lg py-4 text-2xl ${FOCUS_RING}`}
          style={{ background: "var(--surface)", color: "var(--ink)" }}
        >
          <Delete size={22} aria-hidden className="mx-auto" />
        </button>
      </div>
    </div>
  );
}

function NumKey({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      aria-disabled={disabled || undefined}
      className={`min-h-12 rounded-lg py-4 text-2xl ${FOCUS_RING}`}
      style={{
        background: "var(--surface)",
        color: disabled ? "var(--ink-2)" : "var(--ink)",
      }}
    >
      {label}
    </button>
  );
}

function safeParse(v: string, minorUnit: number): number {
  try {
    return parseAmountInput(v, minorUnit);
  } catch {
    return 0;
  }
}
